import { app, BrowserWindow, dialog, type BrowserView, type OpenDialogOptions } from "electron";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderLineReviewHtml, renderProposalReviewHtml } from "../src/shared/core/html.ts";
import type { ReviewProposal } from "../src/shared/core/reviewReport.ts";

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-project-open-"));
const activeOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-active-project-"));
const workspaceDir = path.join(outputDir, ".translation-workshop");
const htmlDir = path.join(workspaceDir, "html");
const sourcePath = path.join(outputDir, "source.txt");
const lineReviewPath = path.join(htmlDir, "line-review-newest.html");
const oldLineReviewPath = path.join(htmlDir, "line-review-old.html");
const proposalReviewPath = path.join(htmlDir, "proposal-review-newest.html");
const oldProposalReviewPath = path.join(htmlDir, "proposal-review-old.html");
const reportPath = path.join(outputDir, "report.json");
const translationPath = path.join(outputDir, "AI_translation", "source_translated.txt");
const nestedSourceRoot = path.join(outputDir, "nested-source");
const glossaryPath = path.join(workspaceDir, "glossary.json");
const characterBiblePath = path.join(outputDir, "AI_translation", "_workspace", "character_bible.md");
const styleGuidePath = path.join(workspaceDir, "style_guide.md");
const importedGlossaryPath = path.join(outputDir, "import-glossary.json");
const screenshotDir = path.join(root, "artifacts", "verification");
const screenshotPath = path.join(screenshotDir, "project-state-assets.png");
const glossaryReferenceScreenshotPath = path.join(screenshotDir, "project-glossary-reference.png");
const customPreserveRulesScreenshotPath = path.join(screenshotDir, "project-custom-preserve-rules.png");
const activeProjectHtmlDir = path.join(activeOutputDir, ".translation-workshop", "html");
const activeProjectSourcePath = path.join(activeOutputDir, "active-source.txt");
const activeProjectLineReviewPath = path.join(activeProjectHtmlDir, "line-review-active-project.html");
const dialogOptions: OpenDialogOptions[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function activeBrowserView(window: BrowserWindow): BrowserView | undefined {
  return window.getBrowserViews().find((view) => {
    if (view.webContents.isDestroyed()) return false;
    const bounds = view.getBounds();
    return bounds.width > 0 && bounds.height > 0;
  });
}

function browserViewFilePath(view: BrowserView | undefined): string | undefined {
  if (!view || view.webContents.isDestroyed() || view.webContents.isLoadingMainFrame()) return undefined;
  const url = view.webContents.getURL();
  return url.startsWith("file:") ? fileURLToPath(url) : undefined;
}

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

async function executeJavaScript<T>(
  contents: Electron.WebContents,
  script: string,
  label: string,
  timeoutMs = 5_000
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      contents.executeJavaScript(script) as Promise<T>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out evaluating ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function clickOpenProject(mainWindow: BrowserWindow): Promise<void> {
  await mainWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("打开项目") || item.textContent?.includes("Open project")
    );
    if (!button) throw new Error("Open project button not found");
    button.click();
  })()`);
}

async function captureWebContentsPng(contents: Electron.WebContents, targetPath: string): Promise<void> {
  const attachedHere = !contents.debugger.isAttached();
  if (attachedHere) contents.debugger.attach("1.3");
  try {
    await contents.debugger.sendCommand("Page.enable");
    const result = await contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    }) as { data: string };
    await writeFile(targetPath, Buffer.from(result.data, "base64"));
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

await Promise.all([
  mkdir(htmlDir, { recursive: true }),
  mkdir(activeProjectHtmlDir, { recursive: true }),
  mkdir(screenshotDir, { recursive: true }),
  mkdir(path.dirname(characterBiblePath), { recursive: true }),
  mkdir(path.dirname(translationPath), { recursive: true }),
  mkdir(path.join(nestedSourceRoot, "route-a"), { recursive: true }),
  mkdir(path.join(nestedSourceRoot, "route-b", "chapter"), { recursive: true })
]);
await writeFile(sourcePath, "原文一\n原文二", "utf8");
await writeFile(translationPath, "译文一\n译文二", "utf8");
await writeFile(activeProjectSourcePath, "当前项目原文", "utf8");
await Promise.all([
  writeFile(path.join(nestedSourceRoot, "route-a", "scene.txt"), "原文甲\n原文乙", "utf8"),
  writeFile(path.join(nestedSourceRoot, "route-b", "chapter", "scene.txt"), "原文丙\n原文丁", "utf8"),
  writeFile(glossaryPath, JSON.stringify({ entries: [{ source: "Glass", target: "琉璃" }] }, null, 2), "utf8"),
  writeFile(importedGlossaryPath, JSON.stringify({ entries: [{ source: "Archive", target: "档案馆" }] }, null, 2), "utf8"),
  writeFile(characterBiblePath, [
    "# Character Bible",
    "",
    "## Alice",
    "- Localized name: 爱丽丝",
    "- Gender/pronouns: female; she/her; confirmed",
    "- Terms of address: 大小姐",
    "- Voice: calm and precise"
  ].join("\n"), "utf8"),
  writeFile(styleGuidePath, "# Style Guide\n\nUse restrained literary Chinese.", "utf8")
]);
const lineHtml = renderLineReviewHtml({
  title: "latest line review",
  sourceText: "原文一\n原文二",
  translationText: "译文一\n译文二",
  lineReviewPath,
  workflow: { sourcePath, outputDir }
});
const siblingLineHtml = renderLineReviewHtml({
  title: "sibling line review",
  sourceText: "原文一\n原文二",
  translationText: "兄弟译文一\n兄弟译文二",
  lineReviewPath: oldLineReviewPath,
  workflow: { sourcePath, outputDir }
});
const activeProjectLineHtml = renderLineReviewHtml({
  title: "active project line review",
  sourceText: "当前项目原文",
  translationText: "当前项目译文",
  lineReviewPath: activeProjectLineReviewPath,
  workflow: { sourcePath: activeProjectSourcePath, outputDir: activeOutputDir }
});
const proposals: ReviewProposal[] = [{
  id: "H3-001",
  line: 1,
  src: "原文一",
  current: "译文一",
  problemType: "H3",
  problem: "fixture",
  suggestion: "修订一",
  status: "unreviewed"
}];
const proposalHtml = renderProposalReviewHtml({
  title: "latest proposal review",
  proposals,
  outputDir,
  reportPath,
  lineReviewPath
});
await Promise.all([
  writeFile(oldLineReviewPath, siblingLineHtml, "utf8"),
  writeFile(lineReviewPath, lineHtml, "utf8"),
  writeFile(oldProposalReviewPath, proposalHtml, "utf8"),
  writeFile(proposalReviewPath, proposalHtml, "utf8"),
  writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    documentId: "source.txt",
    sourcePath,
    translationPath,
    generatedAt: new Date(0).toISOString(),
    findings: [{
      id: "H3-001",
      severity: "H3",
      type: "terminology",
      sourceLine: 1,
      translationLine: 1,
      sourceText: "原文一",
      currentTranslation: "译文一",
      suggestedFix: "修订一",
      rationale: "fixture"
    }]
  }, null, 2), "utf8"),
  writeFile(activeProjectLineReviewPath, activeProjectLineHtml, "utf8"),
  writeFile(path.join(workspaceDir, "project.json"), JSON.stringify({
    outputDir,
    sourcePath,
    lastHtml: oldProposalReviewPath,
    lastProposalReviewHtml: oldProposalReviewPath,
    lastLineReviewHtml: oldLineReviewPath,
    glossaryPath,
    languagePair: "en->zh-CN",
    style: "literary-noir",
    workDescription: "Project-scoped fixture",
    splitSize: 777,
    subagentCount: 4,
    customPreserveRules: [{ label: "speaker", pattern: "^@[A-Z_]+", flags: "u" }]
  }, null, 2), "utf8")
]);
const base = new Date("2026-07-17T00:00:00Z");
await Promise.all([
  utimes(oldLineReviewPath, base, base),
  utimes(oldProposalReviewPath, base, base),
  utimes(lineReviewPath, new Date(base.getTime() + 2000), new Date(base.getTime() + 2000)),
  utimes(proposalReviewPath, new Date(base.getTime() + 3000), new Date(base.getTime() + 3000))
]);

const mutableDialog = dialog as unknown as {
  showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
};
mutableDialog.showOpenDialog = async (options) => {
  dialogOptions.push(options);
  const isGlossaryPicker = options.filters?.some((filter) => filter.name === "Glossary files") === true;
  return { canceled: false, filePaths: [isGlossaryPicker ? importedGlossaryPath : outputDir] };
};

app.setAppPath(root);
app.disableHardwareAcceleration();
await import("../src/main/main.ts");

async function run(): Promise<void> {
  console.log("[project-open] waiting-for-renderer");
  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("renderer/index.html")),
    Boolean,
    "the product renderer"
  );
  assert(mainWindow, "Product renderer was not created");
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('[...document.querySelectorAll("button")].some((item) => item.textContent?.includes("打开项目") || item.textContent?.includes("Open project"))').catch(() => false),
    Boolean,
    "the open project action"
  );
  const openStartedAt = performance.now();
  await clickOpenProject(mainWindow);

  const viewerWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
    Boolean,
    "the HTML tab viewer"
  );
  assert(viewerWindow, "HTML tab viewer was not created");
  await waitFor(
    () => viewerWindow.webContents.executeJavaScript('document.querySelectorAll("#tabs button[data-key]").length').catch(() => 0),
    (count) => count === 2,
    "both project review tabs"
  );
  const activeView = await waitFor(
    () => activeBrowserView(viewerWindow),
    (view): view is BrowserView => Boolean(
      view
      && path.resolve(browserViewFilePath(view) || "") === path.resolve(lineReviewPath)
      && view.webContents.getTitle() === "latest line review"
    ),
    "the active review tab"
  );
  const firstInteractiveMs = performance.now() - openStartedAt;
  console.log("[project-open] initial-tabs-ready");
  console.log("[project-open] active-view", JSON.stringify({
    url: activeView.webContents.getURL(),
    title: activeView.webContents.getTitle(),
    loading: activeView.webContents.isLoadingMainFrame(),
    crashed: activeView.webContents.isCrashed()
  }));
  assert(path.resolve(fileURLToPath(activeView.webContents.getURL())) === path.resolve(lineReviewPath), "Newest line review was not the active project tab");
  assert(firstInteractiveMs <= 3_000, `Project first interactive review took ${Math.round(firstInteractiveMs)} ms`);

  const restoredPromptSettings = await waitFor(
    () => executeJavaScript<Record<string, unknown>>(activeView.webContents, `({
      languagePair: document.querySelector("#promptLanguagePair")?.value,
      style: document.querySelector("#promptStyle")?.value,
      workDescription: document.querySelector("#promptWorkDescription")?.value,
      splitSize: Number(document.querySelector("#promptSplitSize")?.value),
      subagentCount: Number(document.querySelector("#promptSubagentCount")?.value)
    })`, "restored prompt settings"),
    (value: Record<string, unknown>) => value.languagePair === "en->zh-CN" && value.style === "literary-noir" && value.subagentCount === 4,
    "project-scoped HTML prompt settings"
  );
  assert(restoredPromptSettings.workDescription === "Project-scoped fixture", "HTML did not restore the project work description");
  assert(restoredPromptSettings.splitSize === 777, "HTML did not restore the project split size");

  await mainWindow.webContents.executeJavaScript(`window.workshop.openReviewHtml({
    htmlPath: ${JSON.stringify(oldLineReviewPath)},
    outputDir: ${JSON.stringify(outputDir)},
    activate: false
  })`);
  await waitFor(
    () => viewerWindow.webContents.executeJavaScript('document.querySelectorAll("#tabs button[data-key]").length').catch(() => 0),
    (count) => count === 3,
    "the real sibling line-review tab"
  );

  await mainWindow.webContents.executeJavaScript(`window.workshop.saveProject(${JSON.stringify(outputDir)}, {
    languagePair: "ko->zh-CN",
    style: "visual-novel",
    subagentCount: 6
  })`);
  await waitFor(
    () => activeView.webContents.executeJavaScript(`({
      languagePair: document.querySelector("#promptLanguagePair")?.value,
      style: document.querySelector("#promptStyle")?.value,
      subagentCount: Number(document.querySelector("#promptSubagentCount")?.value)
    })`).catch(() => ({})),
    (value: Record<string, unknown>) => value.languagePair === "ko->zh-CN" && value.style === "visual-novel" && value.subagentCount === 6,
    "live project-state broadcast into the HTML"
  );

  await activeView.webContents.executeJavaScript(`(() => {
    const field = document.querySelector("#promptStyle");
    field.value = "historical-drama";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const persistedState = await waitFor(
    async () => JSON.parse(await readFile(path.join(workspaceDir, "project.json"), "utf8")) as Record<string, unknown>,
    (value) => value.style === "historical-drama",
    "HTML prompt edit persistence"
  );
  assert(persistedState.languagePair === "ko->zh-CN", "A partial HTML edit erased another project parameter");
  assert(persistedState.glossaryPath === glossaryPath, "A project save erased the canonical glossary binding");
  await mainWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("button.linkButton")].find((item) => {
      const text = item.textContent?.trim() || "";
      return text.includes("高级") || text.includes("Advanced");
    });
    if (!button) throw new Error("React advanced project settings button was not rendered");
    if (!document.querySelector(".advanced")) button.click();
  })()`);
  await waitFor(
    () => mainWindow.webContents.executeJavaScript(`(() => {
      const label = [...document.querySelectorAll("label.field")].find((item) => {
        const text = item.querySelector("span")?.textContent?.trim() || "";
        return text === "翻译风格" || text === "Style";
      });
      return label?.querySelector("input")?.value || "";
    })()`).catch(() => ""),
    (value) => value === "historical-drama",
    "live project-state broadcast into the React form"
  );

  const assetsBeforeImport = await mainWindow.webContents.executeJavaScript(`window.workshop.readProjectAssets({ outputDir: ${JSON.stringify(outputDir)} })`) as {
    paths?: { characterBible?: string; decisions?: string };
    glossary?: { entries?: Array<{ source?: string; target?: string }> };
    characterBible?: { source?: string; characters?: Array<Record<string, unknown>> };
    styleGuide?: string;
  };
  assert(assetsBeforeImport.glossary?.entries?.[0]?.target === "琉璃", "Canonical project glossary was not loaded");
  assert(assetsBeforeImport.paths?.characterBible === characterBiblePath, "Project UI did not expose the Pi workflow character-bible path");
  assert(assetsBeforeImport.characterBible?.source?.includes("# Character Bible"), "Character bible was not loaded from Markdown");
  assert(assetsBeforeImport.characterBible?.characters?.[0]?.gender === "female", "Character gender metadata was not parsed from Markdown");
  assert(assetsBeforeImport.styleGuide?.includes("restrained literary Chinese"), "Project style guide was not loaded");
  assert(assetsBeforeImport.paths?.decisions === undefined, "Removed decision ledger leaked through the project-assets contract");
  const projectAssetsText = await mainWindow.webContents.executeJavaScript(`document.body.innerText`);
  assert(!/决策记录|\bDecisions\b/.test(projectAssetsText), "Removed decision ledger is still visible in the project UI");

  const preserveRuleUi = await mainWindow.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector(".customPreserveEditor");
    editor?.scrollIntoView({ block: "center" });
    const rows = [...document.querySelectorAll(".customPreserveRuleRow")];
    return {
      visible: Boolean(editor),
      count: rows.length,
      pattern: rows[0]?.querySelectorAll("input")?.[1]?.value || ""
    };
  })()`);
  assert(preserveRuleUi.visible, "React project asset editor did not render the custom preservation rules entry");
  assert(preserveRuleUi.count === 1 && preserveRuleUi.pattern === "^@[A-Z_]+", "React preservation rules did not hydrate from project state");
  await mainWindow.webContents.executeJavaScript(`(() => {
    const add = document.querySelector(".customPreserveHeader .iconButton");
    if (!add) throw new Error("Custom preservation add button was not rendered");
    add.click();
  })()`);
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('document.querySelectorAll(".customPreserveRuleRow").length').catch(() => 0),
    (count) => count === 2,
    "a new custom preservation rule row"
  );
  await mainWindow.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll(".customPreserveRuleRow")].at(-1);
    const inputs = row?.querySelectorAll("input");
    if (!inputs || inputs.length < 3) throw new Error("Custom preservation rule inputs were not rendered");
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setValue(inputs[0], "dialogue brackets");
    setValue(inputs[1], "^DIALOGUE:");
    setValue(inputs[2], "u");
  })()`);
  await waitFor(
    () => mainWindow.webContents.executeJavaScript(`(() => {
      const inputs = [...document.querySelectorAll(".customPreserveRuleRow")].at(-1)?.querySelectorAll("input");
      return inputs ? [inputs[0].value, inputs[1].value, inputs[2].value] : [];
    })()`).catch(() => []),
    (values) => values[0] === "dialogue brackets" && values[1] === "^DIALOGUE:" && values[2] === "u",
    "custom preservation rule draft to enter React state"
  );
  await mainWindow.webContents.executeJavaScript(`(() => {
    const save = [...document.querySelectorAll(".customPreserveEditor button")].find((button) =>
      /保存保留规则|Save preservation rules/.test(button.textContent || "")
    );
    if (!save) throw new Error("Custom preservation save button was not rendered");
    save.click();
  })()`);
  await waitFor(
    async () => JSON.parse(await readFile(path.join(workspaceDir, "project.json"), "utf8")) as Record<string, unknown>,
    (value) => Array.isArray(value.customPreserveRules) && value.customPreserveRules.length === 2,
    "custom preservation rules to persist from the React project editor"
  );
  await waitFor(
    () => activeView.webContents.executeJavaScript('document.querySelectorAll("#promptCustomPreserveRules .prompt-preserve-row").length').catch(() => 0),
    (count) => count === 2,
    "custom preservation rules to broadcast into the open line-review HTML"
  );
  await captureWebContentsPng(mainWindow.webContents, customPreserveRulesScreenshotPath);
  console.log("[project-open] preservation-rules-ready");

  await mainWindow.webContents.executeJavaScript(`(() => {
    const label = [...document.querySelectorAll("label.field")].find((item) => {
      const text = item.querySelector(":scope > span")?.textContent?.trim() || "";
      return text.startsWith("glossary 文件路径") || text.startsWith("Glossary file path");
    });
    const button = label?.querySelector("button");
    if (!button) throw new Error("React glossary file picker was not rendered");
    button.click();
  })()`);
  await waitFor(
    () => mainWindow.webContents.executeJavaScript(`(() => {
      const label = [...document.querySelectorAll("label.field")].find((item) => {
        const text = item.querySelector(":scope > span")?.textContent?.trim() || "";
        return text.startsWith("glossary 文件路径") || text.startsWith("Glossary file path");
      });
      return label?.querySelector("input")?.value || "";
    })()`).catch(() => ""),
    (value) => path.resolve(String(value)) === path.resolve(importedGlossaryPath),
    "the selected glossary reference path to remain visible"
  );
  const glossaryAfterReferencePick = JSON.parse(await readFile(glossaryPath, "utf8")) as {
    entries?: Array<{ source?: string; target?: string }>;
  };
  assert(
    glossaryAfterReferencePick.entries?.[0]?.source === "Glass",
    "Selecting a glossary reference unexpectedly replaced the canonical project glossary"
  );
  await waitFor(
    async () => JSON.parse(await readFile(path.join(workspaceDir, "project.json"), "utf8")) as Record<string, unknown>,
    (value) => path.resolve(String(value.glossaryPath || "")) === path.resolve(importedGlossaryPath),
    "the selected glossary reference to persist in project state"
  );
  await captureWebContentsPng(mainWindow.webContents, glossaryReferenceScreenshotPath);

  await activeView.webContents.executeJavaScript(`(() => {
    window.__ynVerifierAssetEvents = [];
    window.__ynVerifierAssetUnsubscribe = window.workshopHtml.onProjectAssetsUpdate((payload) => window.__ynVerifierAssetEvents.push(payload));
    document.querySelector("#glossaryDrawerToggle")?.click();
    const button = document.querySelector("#importGlossary");
    if (!button) throw new Error("Glossary import button was not rendered");
    button.click();
  })()`);
  await waitFor(
    () => activeView.webContents.executeJavaScript(`window.__ynVerifierAssetEvents?.length || 0`).catch(() => 0),
    (count) => count > 0,
    "project asset broadcast delivery"
  );
  const importedGlossary = await waitFor(
    async () => JSON.parse(await readFile(glossaryPath, "utf8")) as { entries?: Array<{ source?: string; target?: string }> },
    (value) => value.entries?.some((entry) => entry.source === "Archive" && entry.target === "档案馆") === true,
    "canonical glossary import"
  );
  assert(
    importedGlossary.entries?.some((entry) => entry.source === "Glass" && entry.target === "琉璃") === true
      && importedGlossary.entries?.some((entry) => entry.source === "Archive" && entry.target === "档案馆") === true
      && importedGlossary.entries.length === 2,
    "Canonical glossary import did not consolidate the existing canonical and selected external glossary"
  );
  const projectStateAfterCanonicalImport = JSON.parse(await readFile(path.join(workspaceDir, "project.json"), "utf8")) as Record<string, unknown>;
  assert(
    path.resolve(String(projectStateAfterCanonicalImport.glossaryPath || "")) === path.resolve(glossaryPath),
    "A complete canonical glossary import did not switch the project binding to canonical"
  );
  assert(
    dialogOptions.some((options) => options.filters?.some((filter) => filter.name === "Glossary files")),
    "Glossary import did not use the real file-picker UI path"
  );
  await waitFor(
    () => activeView.webContents.executeJavaScript(`({
        values: [...document.querySelectorAll("#glossaryList input")].map((input) => input.value).join("\\n"),
        status: document.querySelector("#aiStatus")?.textContent || "",
        eventCount: window.__ynVerifierAssetEvents?.length || 0
      })`).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    (value: { values?: string }) => String(value?.values || "").includes("Archive") && String(value?.values || "").includes("档案馆"),
    "live glossary broadcast into the HTML"
  );

  await activeView.webContents.executeJavaScript(`(() => {
    window.confirm = () => false;
    const row = [...document.querySelectorAll("#glossaryList .glossary-entry")].find((item) =>
      item.querySelector(".glossary-source")?.value === "Archive"
    );
    const input = row?.querySelector(".glossary-target");
    if (!input) throw new Error("Editable glossary target was not rendered");
    input.value = "文献馆";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    async () => JSON.parse(await readFile(glossaryPath, "utf8")) as { entries?: Array<{ source?: string; target?: string }> },
    (value) => value.entries?.some((entry) => entry.source === "Archive" && entry.target === "文献馆") === true,
    "HTML glossary edit persistence"
  );
  console.log("[project-open] glossary-live");
  await waitFor(
    () => activeView.webContents.executeJavaScript(`[...document.querySelectorAll("#glossaryList input")].map((input) => input.value).join("\\n")`).catch(() => ""),
    (text) => String(text).includes("文献馆"),
    "live project glossary edit"
  );

  await viewerWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("#tabs button[data-key]")].find((item) => item.title === "sibling line review");
    if (!button) throw new Error("Sibling line-review tab button was not rendered");
    button.click();
  })()`);
  const siblingView = await waitFor(
    () => activeBrowserView(viewerWindow),
    (view): view is BrowserView => Boolean(
      view
      && path.resolve(browserViewFilePath(view) || "") === path.resolve(oldLineReviewPath)
      && view.webContents.getTitle() === "sibling line review"
    ),
    "the active sibling line-review tab"
  );
  await siblingView.webContents.executeJavaScript(`document.querySelector("#glossaryDrawerToggle")?.click()`);
  await waitFor(
    () => siblingView.webContents.executeJavaScript(`({
      style: document.querySelector("#promptStyle")?.value,
      glossary: [...document.querySelectorAll("#glossaryList input")].map((input) => input.value).join("\\n")
    })`).catch(() => ({})),
    (value: Record<string, unknown>) => value.style === "historical-drama" && String(value.glossary).includes("文献馆"),
    "live project settings and assets in the sibling HTML"
  );
  await viewerWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("#tabs button[data-key]")].find((item) => item.title === "latest line review");
    if (!button) throw new Error("Latest line-review tab button was not rendered");
    button.click();
  })()`);
  await waitFor(
    () => activeBrowserView(viewerWindow),
    (view) => view === activeView,
    "return to the latest line-review tab"
  );

  await activeView.webContents.reload();
  await waitFor(
    () => activeView.webContents.executeJavaScript(`(() => {
      const button = document.querySelector("#glossaryDrawerToggle");
      const drawer = document.querySelector("#glossaryTools");
      if (!button || !drawer) return false;
      if (!drawer.classList.contains("open")) button.click();
      return true;
    })()`).catch(() => false),
    Boolean,
    "the reopened glossary drawer"
  );
  await waitFor(
    () => activeView.webContents.executeJavaScript(`({
      style: document.querySelector("#promptStyle")?.value,
      glossary: [...document.querySelectorAll("#glossaryList input")].map((input) => input.value).join("\\n")
    })`).catch(() => ({})),
    (value: Record<string, unknown>) => value.style === "historical-drama" && String(value.glossary).includes("文献馆"),
    "project settings and assets after HTML reopen"
  );
  console.log("[project-open] sibling-and-reload-ready");
  await activeView.webContents.executeJavaScript(`(() => {
    document.querySelector("#translatePrompt")?.click();
    document.querySelector("#glossaryDrawerToggle")?.click();
  })()`);
  await waitFor(
    () => activeView.webContents.executeJavaScript(`({
      promptOpen: document.querySelector("#promptSettingsPanel")?.hidden === false,
      glossaryOpen: document.querySelector("#glossaryTools")?.classList.contains("open") === true
    })`).catch(() => ({})),
    (value: { promptOpen?: boolean; glossaryOpen?: boolean }) => value.promptOpen === true && value.glossaryOpen === true,
    "visible project settings and glossary evidence"
  );
  await captureWebContentsPng(activeView.webContents, screenshotPath);

  await mainWindow.webContents.executeJavaScript(`window.workshop.replaceProjectGlossary({
    outputDir: ${JSON.stringify(outputDir)},
    entries: []
  })`);
  await waitFor(
    () => activeView.webContents.executeJavaScript(`document.querySelectorAll("#glossaryList input").length`).catch(() => -1),
    (count) => count === 0,
    "canonical empty glossary broadcast into the active HTML"
  );
  await waitFor(
    () => siblingView.webContents.executeJavaScript(`document.querySelectorAll("#glossaryList input").length`).catch(() => -1),
    (count) => count === 0,
    "canonical empty glossary broadcast into the sibling HTML"
  );
  await mainWindow.webContents.executeJavaScript(`window.workshop.replaceProjectGlossary({
    outputDir: ${JSON.stringify(outputDir)},
    entries: [{ source: "Archive", target: "文献馆" }]
  })`);
  await waitFor(
    () => activeView.webContents.executeJavaScript(`[...document.querySelectorAll("#glossaryList input")].map((input) => input.value).join("\\n")`).catch(() => ""),
    (text) => String(text).includes("文献馆"),
    "canonical glossary restore after empty state"
  );

  await mainWindow.webContents.executeJavaScript(`window.workshop.openPath(${JSON.stringify(activeProjectLineReviewPath)})`);
  await waitFor(
    () => activeBrowserView(viewerWindow),
    (view): view is BrowserView => Boolean(
      view
      && path.resolve(browserViewFilePath(view) || "") === path.resolve(activeProjectLineReviewPath)
      && view.webContents.getTitle() === "active project line review"
    ),
    "the newly active project review tab"
  );
  await clickOpenProject(mainWindow);
  const secondProjectPicker = await waitFor(
    () => dialogOptions.filter((options) => !options.filters?.some((filter) => filter.name === "Glossary files")),
    (options) => options.length === 2,
    "the second project picker"
  );
  assert(
    path.resolve(secondProjectPicker[1].defaultPath || "") === path.resolve(activeOutputDir),
    "Project picker did not follow the currently active review project"
  );
  console.log("[project-open] active-project-picker-ready");
  await waitFor(
    () => BrowserWindow.getAllWindows().every((window) => window.isDestroyed() || !window.webContents.isLoading()),
    Boolean,
    "the reopened project background tabs to settle"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));

  const nestedResult = await mainWindow.webContents.executeJavaScript(`window.workshop.generateLineReview(${JSON.stringify({
    sourcePath: nestedSourceRoot,
    outputDir,
    fileType: "txt",
    pageSize: 1000,
    locale: "zh-CN",
    inputMode: "separate"
  })})`) as { outputPath: string; fileCount?: number };
  assert(nestedResult.fileCount === 2, `Nested folder review found ${nestedResult.fileCount ?? 0} files instead of 2`);
  const nestedIndex = await readFile(nestedResult.outputPath, "utf8");
  const batchDataMatch = nestedIndex.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/);
  assert(batchDataMatch, "Nested folder review did not contain batchData");
  const nestedBatch = JSON.parse(batchDataMatch[1]) as { files?: Array<{ sourceName?: string; outputPath?: string }> };
  assert(
    nestedBatch.files?.map((file) => file.sourceName).join(",") === "route-a/scene.txt,route-b/chapter/scene.txt",
    `Nested folder review lost relative source paths: ${JSON.stringify(nestedBatch.files)}`
  );
  await Promise.all((nestedBatch.files || []).map(async (file) => {
    assert(file.outputPath, `Nested folder review item has no child HTML: ${JSON.stringify(file)}`);
    const info = await stat(path.resolve(path.dirname(nestedResult.outputPath), file.outputPath));
    assert(info.isFile(), `Nested folder child HTML is not a file: ${file.outputPath}`);
  }));
  console.log("[project-open] nested-folder-ready");
  assert(viewerWindow.getBrowserViews().length === 4, "Project-open verification did not retain all four review tabs");

  console.log(JSON.stringify({
    ok: true,
    latestLineReviewActive: true,
    latestProposalReviewOpened: true,
    projectPickerRestoredFolder: true,
    projectPickerTracksActiveHtml: true,
    nestedFolderReviewGenerated: true,
    projectPromptSettingsRestored: true,
    projectPromptSettingsLive: true,
    projectGlossaryImported: true,
    projectGlossaryImportedViaUi: true,
    projectGlossaryReferenceSelected: true,
    projectGlossaryLive: true,
    projectGlossaryEmptyLive: true,
    siblingHtmlLive: true,
    reactProjectStateLive: true,
    characterBibleMarkdown: true,
    styleGuideLoaded: true,
    customPreserveRulesEditor: true,
    decisionLedgerRemoved: true,
    multiBrowserViewTabs: true,
    screenshotPath,
    glossaryReferenceScreenshotPath,
    customPreserveRulesScreenshotPath,
    tabCount: viewerWindow.getBrowserViews().length,
    firstInteractiveMs: Math.round(firstInteractiveMs)
  }));
}

async function runWithTimeout(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Project-open verifier timed out after 120 seconds.")), 120_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

void app.whenReady().then(runWithTimeout).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  await rm(activeOutputDir, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
