import { app, BrowserWindow, nativeImage, type BrowserView, type WebContents } from "electron";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BATCH_LINE_REVIEW_PROTOCOL_MARKER,
  LINE_REVIEW_PROTOCOL_MARKER,
  PROMPT_SETTINGS_VERSION,
  renderBatchLineReviewIndexHtml,
  renderLineReviewHtml
} from "../src/shared/core/html.ts";

const root = process.cwd();
const workspace = await mkdtemp(path.join(os.tmpdir(), "yn-electron-folder-tabs-"));
const sourceDir = path.join(workspace, "source");
const sourceAPath = path.join(sourceDir, "a.txt");
const sourceBPath = path.join(sourceDir, "b.txt");
const sourceEpubPath = path.join(sourceDir, "book.epub");
const extractedEpubPath = path.join(workspace, ".translation-workshop", "extracted-text", "book", "source.txt");
const translationAPath = path.join(workspace, "a-translated.txt");
const translationBPath = path.join(workspace, "b-translated.txt");
const translationEpubPath = path.join(workspace, "AI_translation", "book_translated.txt");
const childAPath = path.join(workspace, "review-a.html");
const childBPath = path.join(workspace, "review-b.html");
const childEpubPath = path.join(workspace, "review-book.html");
const folderPath = path.join(workspace, "folder-review.html");
const projectStatePath = path.join(workspace, ".translation-workshop", "project.json");
const selectedGlossaryPath = path.join(workspace, "references", "selected-glossary.json");
const folderPromptScreenshotPath = path.join(root, "artifacts", "electron-folder-batch-prompt.png");
const screenshotPath = path.join(root, "artifacts", "electron-folder-native-tabs.png");
const agentScreenshotPath = path.join(root, "artifacts", "electron-folder-native-tab-agent.png");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function mark(stage: string): void {
  console.log(`[folder-tabs] ${stage}`);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
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

async function waitForView(view: BrowserView, expression: string, label: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(
    () => view.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false),
    Boolean,
    label,
    timeoutMs
  );
}

function visibleView(viewerWindow: BrowserWindow): BrowserView | undefined {
  return viewerWindow.getBrowserViews().find((view) => {
    const bounds = view.getBounds();
    return bounds.width > 0 && bounds.height > 0;
  });
}

async function captureRenderedPage(contents: WebContents, label: string): Promise<Buffer> {
  const attachedHere = !contents.debugger.isAttached();
  if (attachedHere) contents.debugger.attach("1.3");
  try {
    await contents.debugger.sendCommand("Page.enable");
    const result = await contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: false,
      captureBeyondViewport: false
    }) as { data?: string };
    const png = Buffer.from(result.data ?? "", "base64");
    const image = nativeImage.createFromBuffer(png);
    assert(!image.isEmpty(), `${label} renderer screenshot was empty`);
    return png;
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

await mkdir(sourceDir, { recursive: true });
await mkdir(path.dirname(extractedEpubPath), { recursive: true });
await mkdir(path.dirname(translationEpubPath), { recursive: true });
await mkdir(path.dirname(selectedGlossaryPath), { recursive: true });
await mkdir(path.dirname(screenshotPath), { recursive: true });
await Promise.all([
  writeFile(sourceAPath, "source a\nsource a2", "utf8"),
  writeFile(sourceBPath, "source b\nsource b2", "utf8"),
  writeFile(sourceEpubPath, "EPUB fixture placeholder", "utf8"),
  writeFile(extractedEpubPath, "book source\nbook source 2", "utf8"),
  writeFile(translationAPath, "translation a\ntranslation a2", "utf8"),
  writeFile(translationBPath, "translation b\ntranslation b2", "utf8"),
  writeFile(translationEpubPath, "book translation\nbook translation 2", "utf8"),
  writeFile(selectedGlossaryPath, JSON.stringify({
    entries: [{ source: "source", target: "原文", status: "confirmed" }]
  }), "utf8")
]);

const legacyChild = (title: string, sourcePath: string, translationPath: string, lineReviewPath: string) => {
  return renderLineReviewHtml({
    title,
    sourceText: title.includes("A") ? "source a\nsource a2" : "source b\nsource b2",
    translationText: title.includes("A") ? "translation a\ntranslation a2" : "translation b\ntranslation b2",
    lineReviewPath,
    workflow: {
      outputDir: workspace,
      sourcePath: sourceDir,
      sourceKind: "file",
      translationPath
    }
  }).replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v0")
    .replace(
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
    );
};

await Promise.all([
  writeFile(childAPath, legacyChild("Folder child A", sourceAPath, translationAPath, childAPath), "utf8"),
  writeFile(childBPath, legacyChild("Folder child B", sourceBPath, translationBPath, childBPath), "utf8"),
  writeFile(childEpubPath, renderLineReviewHtml({
    title: "Folder child EPUB",
    sourceText: "book source\nbook source 2",
    translationText: "",
    lineReviewPath: childEpubPath,
    workflow: {
      outputDir: workspace,
      sourcePath: sourceEpubPath,
      validationSourcePath: extractedEpubPath,
      sourceKind: "file"
    }
  }).replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v0")
    .replace(
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
    ), "utf8")
]);

const legacyFolderHtml = renderBatchLineReviewIndexHtml({
  title: "Native folder tabs",
  files: [
    {
      sourceName: path.basename(sourceAPath),
      sourcePath: sourceAPath,
      outputPath: path.basename(childAPath),
      status: "matched",
      sourceLineCount: 2,
      translationName: path.basename(translationAPath),
      translationPath: translationAPath,
      translationLineCount: 2
    },
    {
      sourceName: path.basename(sourceBPath),
      sourcePath: sourceBPath,
      outputPath: path.basename(childBPath),
      status: "matched",
      sourceLineCount: 2,
      translationName: path.basename(translationBPath),
      translationPath: translationBPath,
      translationLineCount: 2
    },
    {
      sourceName: path.basename(sourceEpubPath),
      sourcePath: sourceEpubPath,
      outputPath: path.basename(childEpubPath),
      status: "missing-translation",
      sourceLineCount: 2
    }
  ],
  workflow: {
    sourcePath: sourceDir,
    sourceKind: "folder",
    outputDir: workspace,
    glossaryPath: selectedGlossaryPath,
    glossaryEntries: [{ source: "source", target: "原文", status: "confirmed" }],
    advanced: { languagePair: "ja->zh-CN" }
  }
})
  .replace(`<meta name="translation-workshop-batch-review" content="${BATCH_LINE_REVIEW_PROTOCOL_MARKER}">`, "")
  .replace("const error = await api.openPath(targetUrl);", 'window.open(file.outputPath, "_blank"); const error = "";');
await writeFile(folderPath, legacyFolderHtml, "utf8");

app.setAppPath(root);
app.setPath("userData", path.join(workspace, "user-data"));
app.disableHardwareAcceleration();
await import("../src/main/main.ts");

async function run(): Promise<void> {
  mark("run-start");
  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("renderer/index.html")),
    (candidate) => Boolean(candidate && !candidate.isDestroyed()),
    "the production renderer window"
  );
  assert(mainWindow, "Production renderer window was not created");
  mark("main-window-ready");
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('typeof window.workshop?.openReviewHtml === "function"').catch(() => false),
    Boolean,
    "the production preload bridge"
  );
  mark("preload-ready");
  await mainWindow.webContents.executeJavaScript(`window.workshop.saveAgentProviderConfig(${JSON.stringify({
    outputDir: workspace,
    activeProviderId: "electron-folder-verifier",
    provider: {
      id: "electron-folder-verifier",
      name: "Electron folder verifier",
      type: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      model: "verifier-model",
      models: ["verifier-model"],
      enabled: true,
      auth: { kind: "api_key", key: "verifier-key" }
    }
  })})`);

  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: folderPath, outputDir: workspace })})`
  );
  const viewerWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
    (candidate) => Boolean(candidate && !candidate.isDestroyed()),
    "the production HTML tab viewer"
  );
  assert(viewerWindow, "Production HTML tab viewer was not created");
  const folderView = await waitFor(
    () => visibleView(viewerWindow),
    (candidate) => Boolean(candidate && !candidate.webContents.isDestroyed()),
    "the active folder BrowserView"
  );
  assert(folderView, "Folder BrowserView was not attached");
  await waitForView(folderView, 'document.querySelector("#fileFrame")?.contentDocument?.readyState === "complete"', "the first folder child");
  mark("folder-child-ready");

  const migratedFolder = await readFile(folderPath, "utf8");
  assert(migratedFolder.includes(BATCH_LINE_REVIEW_PROTOCOL_MARKER), "Markerless folder index was not migrated on disk");
  assert(!migratedFolder.includes("window.open(file.outputPath"), "Migrated folder index retained window.open");
  for (const childPath of [childAPath, childBPath, childEpubPath]) {
    const migratedChild = await readFile(childPath, "utf8");
    assert(migratedChild.includes(LINE_REVIEW_PROTOCOL_MARKER), `Child was not migrated on disk: ${childPath}`);
    assert(
      migratedChild.includes(`name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`),
      `Child prompt-settings protocol was not upgraded on disk: ${childPath}`
    );
  }
  const folderPromptState = await folderView.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector("#fileFrame");
    const childDocument = frame?.contentDocument;
    const dataElement = childDocument?.getElementById("reviewData");
    const reviewData = dataElement ? JSON.parse(dataElement.textContent || "{}") : {};
    const prompt = String(reviewData.workflow?.prompts?.translate || "");
    return {
      prompt,
      hasBatchPromptPanel: Boolean(document.querySelector("#folderTranslatePrompt")),
      childSourceKind: reviewData.workflow?.paths?.sourceKind || "",
      childPromptSourceKind: reviewData.workflow?.paths?.promptSourceKind || ""
    };
  })()`);
  assert(!folderPromptState.hasBatchPromptPanel, "Folder index retained the removed side prompt panel");
  assert(folderPromptState.prompt.includes(`Source folder: ${sourceDir}`), "Folder prompt lost the selected folder path");
  assert(folderPromptState.prompt.includes("File order"), "Folder prompt lost the typed file-order setting");
  assert(folderPromptState.prompt.includes("removed names are skipped"), "Folder prompt lost the typed skip semantics");
  assert(folderPromptState.prompt.includes("Subagents: enabled; maximum=3"), "Folder prompt did not materialize the default worker count");
  assert(!folderPromptState.prompt.includes("Subagents: enabled; maximum=2"), "Folder prompt reintroduced the product fallback as a user setting");
  assert(!folderPromptState.prompt.includes("runTranslationSubagents"), "Generated prompt duplicated host runtime instructions");
  assert(folderPromptState.childSourceKind === "file", "Folder child editing scope was incorrectly changed");
  assert(folderPromptState.childPromptSourceKind === "folder", "Folder child prompt scope was not migrated");
  const batchTxtEdited = await folderView.webContents.executeJavaScript(`(() => {
    const target = document.querySelector("#fileFrame")?.contentDocument?.querySelector('.row[data-line="2"] .target');
    if (!target) return false;
    target.textContent = "batch saved translation a2";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "batch saved translation a2" }));
    return true;
  })()`);
  assert(batchTxtEdited, "Folder child could not record a visible line edit before batch TXT write");
  const childAStatePath = path.join(workspace, ".translation-workshop", "state", `line-${path.basename(childAPath)}.json`);
  const batchTxtClicked = await folderView.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#writeAllTxt");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(batchTxtClicked, "Folder index did not expose the batch TXT button");
  await waitFor(
    () => folderView.webContents.executeJavaScript('document.querySelector("#batchWriteStatus")?.textContent || ""'),
    (status) => status.includes("3") && !status.includes("失败"),
    "the Host-backed batch TXT write to finish visibly"
  );
  assert(
    await readFile(translationAPath, "utf8") === "translation a\nbatch saved translation a2",
    "Batch TXT write did not overlay the persisted child edit onto the bound translation"
  );
  assert(
    await readFile(sourceAPath, "utf8") === "source a\nsource a2",
    "Batch TXT write modified the source file"
  );
  const persistedChildState = JSON.parse(await readFile(childAStatePath, "utf8"));
  assert(
    persistedChildState?.edits?.[2] === "batch saved translation a2",
    "The batch command did not flush the active child state before writing TXT"
  );
  await writeFile(folderPromptScreenshotPath, await captureRenderedPage(folderView.webContents, "Folder batch prompt"));
  mark("batch-write-and-capture-ready");

  const lifecycleInstrumented = await folderView.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector("#fileFrame");
    const child = frame?.contentWindow;
    const host = window.workshopHtml || window.workshop;
    if (!child || !host?.agentSession) return false;
    const counts = window.__ynFolderLifecycle = {
      eventSubscriptions: 0,
      eventUnsubscriptions: 0,
      updateSubscriptions: 0,
      updateUnsubscriptions: 0,
      projectWritesStarted: 0,
      projectWritesCompleted: 0,
      failProjectWrites: false,
      promptRequest: null
    };
    const session = Object.create(host.agentSession);
    Object.defineProperty(session, "onEvent", { value: callback => {
      counts.eventSubscriptions += 1;
      const unsubscribe = host.agentSession.onEvent(callback);
      return () => {
        counts.eventUnsubscriptions += 1;
        unsubscribe();
      };
    }, enumerable: true });
    Object.defineProperty(session, "onSessionUpdate", { value: callback => {
      counts.updateSubscriptions += 1;
      const unsubscribe = host.agentSession.onSessionUpdate(callback);
      return () => {
        counts.updateUnsubscriptions += 1;
        unsubscribe();
      };
    }, enumerable: true });
    Object.defineProperty(session, "sendPrompt", { value: async request => {
      counts.promptRequest = structuredClone(request);
      throw new Error("Electron folder verifier captured the prompt request.");
    }, enumerable: true });
    const wrappedHost = Object.create(host);
    Object.defineProperty(wrappedHost, "agentSession", { value: session, enumerable: true });
    Object.defineProperty(wrappedHost, "updateProjectState", { value: async args => {
      counts.projectWritesStarted += 1;
      if (counts.failProjectWrites) throw new Error("Simulated project settings persistence failure.");
      await new Promise(resolve => setTimeout(resolve, 120));
      const result = await host.updateProjectState(args);
      counts.projectWritesCompleted += 1;
      return result;
    }, enumerable: true });
    Object.defineProperty(child, "workshop", { value: wrappedHost, configurable: true });
    Object.defineProperty(child, "workshopHtml", { value: wrappedHost, configurable: true });
    window.__ynFolderWrappedHost = wrappedHost;
    return true;
  })()`);
  assert(lifecycleInstrumented, "Could not instrument the inherited production AgentSession bridge");
  const missingPersistenceBridgeApplied = await folderView.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector("#fileFrame");
    const child = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const wrappedHost = window.__ynFolderWrappedHost;
    if (!child || !doc || !wrappedHost) return false;
    const noPersistenceHost = Object.create(wrappedHost);
    Object.defineProperty(noPersistenceHost, "updateProjectState", { value: undefined, enumerable: true });
    Object.defineProperty(child, "workshop", { value: noPersistenceHost, configurable: true });
    Object.defineProperty(child, "workshopHtml", { value: noPersistenceHost, configurable: true });
    doc.querySelector("#translatePrompt")?.click();
    doc.querySelector("#applyPromptSettings")?.click();
    return true;
  })()`);
  assert(missingPersistenceBridgeApplied, "Could not exercise the missing project-settings bridge path");
  const missingBridgeState = await waitFor(
    () => folderView.webContents.executeJavaScript(`(() => {
      const doc = document.querySelector("#fileFrame")?.contentDocument;
      return {
        status: doc?.querySelector("#aiStatus")?.textContent || "",
        panelOpen: doc?.querySelector("#promptSettingsPanel")?.hidden === false,
        prompt: doc?.querySelector("#agentChatReactRoot textarea")?.value || ""
      };
    })()`),
    (state) => state.status.includes("Project settings bridge is unavailable."),
    "the missing project-settings bridge to fail visibly"
  );
  assert(missingBridgeState.panelOpen, "Missing persistence bridge closed the settings panel as if generation succeeded");
  assert(missingBridgeState.prompt === "", "Missing persistence bridge still generated a prompt");
  await folderView.webContents.executeJavaScript(`(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    const wrappedHost = window.__ynFolderWrappedHost;
    if (!child || !wrappedHost) return false;
    Object.defineProperty(child, "workshop", { value: wrappedHost, configurable: true });
    Object.defineProperty(child, "workshopHtml", { value: wrappedHost, configurable: true });
    return true;
  })()`);
  const rejectedPersistenceApplied = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    if (!doc || !window.__ynFolderLifecycle) return false;
    window.__ynFolderLifecycle.failProjectWrites = true;
    doc.querySelector("#translatePrompt")?.click();
    doc.querySelector("#applyPromptSettings")?.click();
    return true;
  })()`);
  assert(rejectedPersistenceApplied, "Could not exercise the rejected project-settings write path");
  const rejectedPersistenceState = await waitFor(
    () => folderView.webContents.executeJavaScript(`(() => {
      const doc = document.querySelector("#fileFrame")?.contentDocument;
      return {
        status: doc?.querySelector("#aiStatus")?.textContent || "",
        panelOpen: doc?.querySelector("#promptSettingsPanel")?.hidden === false,
        prompt: doc?.querySelector("#agentChatReactRoot textarea")?.value || ""
      };
    })()`),
    (state) => state.status.includes("Simulated project settings persistence failure."),
    "the rejected project-settings write to fail visibly"
  );
  assert(rejectedPersistenceState.panelOpen, "Rejected persistence write closed the settings panel as if generation succeeded");
  assert(rejectedPersistenceState.prompt === "", "Rejected persistence write still generated a prompt");
  await folderView.webContents.executeJavaScript("window.__ynFolderLifecycle.failProjectWrites = false");
  const promptSettingsOpened = await folderView.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#translatePrompt");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(promptSettingsOpened, "First folder child did not expose translation prompt settings");
  await waitForView(
    folderView,
    'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#promptSettingsPanel")?.hidden === false',
    "the upgraded child prompt-settings panel"
  );
  const promptWritesBeforeTyping = await folderView.webContents.executeJavaScript(
    "window.__ynFolderLifecycle?.projectWritesStarted || 0"
  );
  const promptStyleDraftStarted = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const style = doc?.querySelector("#promptStyle");
    if (!style) return false;
    style.focus();
    style.value = "";
    style.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  assert(promptStyleDraftStarted, "Could not start an in-progress prompt style edit");
  await new Promise((resolve) => setTimeout(resolve, 360));
  const promptStyleDuringTyping = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    return {
      value: doc?.querySelector("#promptStyle")?.value ?? null,
      active: doc?.activeElement?.id || "",
      writes: window.__ynFolderLifecycle?.projectWritesStarted || 0
    };
  })()`);
  assert(promptStyleDuringTyping.value === "", "Prompt style inserted the default 'game' while the user was still typing");
  assert(promptStyleDuringTyping.active === "promptStyle", "Prompt style lost focus during a project-state refresh");
  assert(promptStyleDuringTyping.writes === promptWritesBeforeTyping,
    "Prompt style synchronized before the user left the input field");
  await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const style = doc?.querySelector("#promptStyle");
    style?.blur();
    style?.dispatchEvent(new Event("blur"));
  })()`);
  await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(projectStatePath, "utf8"));
      } catch {
        return null;
      }
    },
    (state) => state?.style === "game",
    "the prompt style to synchronize after leaving the field"
  );
  const promptRegexDraftStarted = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    doc?.querySelector("#addPromptCustomPreserveRule")?.click();
    const pattern = doc?.querySelector("#promptCustomPreserveRules .prompt-preserve-pattern:last-of-type")
      || [...(doc?.querySelectorAll("#promptCustomPreserveRules .prompt-preserve-pattern") || [])].at(-1);
    if (!pattern) return false;
    pattern.value = "[";
    pattern.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  assert(promptRegexDraftStarted, "Could not start an in-progress prompt regex edit");
  const promptWritesBeforeRegexPause = await folderView.webContents.executeJavaScript(
    "window.__ynFolderLifecycle?.projectWritesStarted || 0"
  );
  await new Promise((resolve) => setTimeout(resolve, 360));
  const promptRegexDuringTyping = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const pattern = [...(doc?.querySelectorAll("#promptCustomPreserveRules .prompt-preserve-pattern") || [])].at(-1);
    return {
      value: pattern?.value ?? null,
      active: doc?.activeElement === pattern,
      writes: window.__ynFolderLifecycle?.projectWritesStarted || 0,
      status: doc?.querySelector("#aiStatus")?.textContent || ""
    };
  })()`);
  assert(promptRegexDuringTyping.value === "[", "Prompt regex draft was replaced during typing");
  assert(promptRegexDuringTyping.active === true, "Prompt regex lost focus during a project-state refresh");
  assert(promptRegexDuringTyping.writes === promptWritesBeforeRegexPause,
    "Prompt regex synchronized before the user left the input field");
  assert(!promptRegexDuringTyping.status.includes("Invalid custom preserve rule"),
    "Prompt regex was validated before the user left the input field");
  await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const row = [...(doc?.querySelectorAll("#promptCustomPreserveRules .prompt-preserve-row") || [])].at(-1);
    const pattern = row?.querySelector(".prompt-preserve-pattern");
    const flags = row?.querySelector(".prompt-preserve-flags");
    if (!pattern || !flags) throw new Error("Prompt regex row disappeared before blur persistence");
    pattern.value = "^DIALOGUE:";
    pattern.dispatchEvent(new Event("input", { bubbles: true }));
    pattern.blur();
    pattern.dispatchEvent(new Event("blur"));
  })()`);
  await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(projectStatePath, "utf8"));
      } catch {
        return null;
      }
    },
    (state) => state?.customPreserveRules?.some((rule) => rule.pattern === "^DIALOGUE:"),
    "the prompt regex to synchronize after leaving the field"
  );
  const reuseAuditDefault = await folderView.webContents.executeJavaScript(`(() => {
    const checkbox = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#promptReuseExistingTranslation");
    return checkbox ? { exists: true, checked: checkbox.checked } : { exists: false, checked: null };
  })()`);
  assert(reuseAuditDefault.exists, "Folder prompt settings did not expose the existing-translation audit switch");
  assert(reuseAuditDefault.checked === false, "Existing-translation audit must default to direct retranslation");
  const folderOrderState = await folderView.webContents.executeJavaScript(`(() => {
    const value = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#promptFolderTranslationOrder")?.value || "";
    return { value, hasBraces: value.includes("{") && value.includes("}") };
  })()`);
  assert(folderOrderState.hasBraces, "Folder prompt settings did not expose the host-enforced parallel group");
  assert(folderOrderState.value.includes("a.txt") && folderOrderState.value.includes("b.txt")
    && folderOrderState.value.includes("book.epub"),
    `Folder prompt order did not list every source document: ${folderOrderState.value}`);
  const folderPromptApplied = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const count = doc?.querySelector("#promptSubagentCount");
    const marker = doc?.querySelector(".audit-marker");
    const apply = doc?.querySelector("#applyPromptSettings");
    if (!count || !marker || !apply) return false;
    count.value = "5";
    marker.click();
    apply.click();
    return true;
  })()`);
  assert(folderPromptApplied, "The upgraded child could not apply folder prompt settings");
  await waitForView(
    folderView,
    'window.__ynFolderLifecycle?.projectWritesStarted > 0',
    "the prompt settings persistence write to start"
  );
  const panelWaitedForPersistence = await folderView.webContents.executeJavaScript(
    'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#promptSettingsPanel")?.hidden === false'
  );
  assert(panelWaitedForPersistence, "Prompt generation closed before project settings were durably persisted");
  const appliedState = await waitFor(
    () => folderView.webContents.executeJavaScript(`(() => {
      const doc = document.querySelector("#fileFrame")?.contentDocument;
      return {
        prompt: doc?.querySelector("#agentChatReactRoot textarea")?.value || "",
        preview: doc?.querySelector("#promptPreview")?.value || "",
        status: doc?.querySelector("#aiStatus")?.textContent || "",
        count: doc?.querySelector("#promptSubagentCount")?.value || "",
        order: doc?.querySelector("#promptFolderTranslationOrder")?.value || ""
      };
    })()`),
    (state) => state.prompt.includes("Subagents: enabled; maximum=5")
      && state.prompt.includes("File order (removed names are skipped; braces remove relative ordering only):"),
    "the normal prompt-settings path to insert a five-worker folder prompt"
  );
  assert(await folderView.webContents.executeJavaScript(
    'window.__ynFolderLifecycle?.projectWritesCompleted > 0'
  ), "Folder prompt was generated before its project settings write completed");
  const appliedPrompt = appliedState.prompt;
  assert(appliedPrompt.includes("Existing translation: discard and retranslate"),
    "Default folder prompt did not declare direct retranslation");
  assert(!appliedPrompt.includes("runTranslationSubagents"), "Generated prompt leaked host-owned runtime instructions");
  assert(!/audit whitelist|审计白名单/i.test(appliedPrompt), "Generated prompt leaked Host-owned audit whitelist instructions");
  const promptSubmitted = await folderView.webContents.executeJavaScript(`(() => {
    const root = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot");
    const textarea = root?.querySelector("textarea");
    const send = root?.querySelector('button[aria-label="Send"]');
    if (!textarea || !send || send.disabled || !textarea.value.trim()) return false;
    send.click();
    return true;
  })()`);
  assert(promptSubmitted, "The folder prompt could not be submitted through the Pi-web composer");
  const capturedPromptRequest = await waitFor(
    () => folderView.webContents.executeJavaScript("window.__ynFolderLifecycle?.promptRequest || null"),
    Boolean,
    "the real HTML-to-React-to-AgentSession folder prompt request"
  );
  mark("translation-prompt-ready");
  const workflowMetadata = capturedPromptRequest;
  assert(workflowMetadata.translationSplitSize === 1000,
    `Folder prompt request lost translationSplitSize: ${JSON.stringify(workflowMetadata)}`);
  assert(workflowMetadata.subagentCount === 5,
    `Folder prompt request lost the selected worker count: ${JSON.stringify(workflowMetadata)}`);
  assert(samePath(String(workflowMetadata.glossaryPath ?? ""), selectedGlossaryPath),
    `Folder prompt request lost the selected glossary path: ${JSON.stringify(workflowMetadata)}`);
  assert(workflowMetadata.glossaryCandidates === true,
    `Folder prompt request lost the glossary-candidate choice: ${JSON.stringify(workflowMetadata)}`);
  assert(workflowMetadata.characterBible === true,
    `Folder prompt request lost the character-bible choice: ${JSON.stringify(workflowMetadata)}`);
  assert(workflowMetadata.reuseExistingTranslation === false,
    `Folder prompt request did not preserve the default direct-retranslation policy: ${JSON.stringify(workflowMetadata)}`);
  assert(JSON.stringify(workflowMetadata.auditWhitelistLines) === "[1]",
    `Folder prompt request lost the typed audit whitelist: ${JSON.stringify(workflowMetadata)}`);
  assert(typeof workflowMetadata.folderTranslationOrder === "string"
    && workflowMetadata.folderTranslationOrder.includes("a.txt")
    && workflowMetadata.folderTranslationOrder.includes("b.txt")
    && workflowMetadata.folderTranslationOrder.includes("book.epub")
    && workflowMetadata.folderTranslationOrder.includes("{")
    && workflowMetadata.folderTranslationOrder.includes("}"),
  `Folder prompt request lost the ordered parallel stage: ${JSON.stringify(workflowMetadata)}`);
  const submittedDocuments = Array.isArray(workflowMetadata.folderSourceDocuments)
    ? workflowMetadata.folderSourceDocuments
    : [];
  assert(submittedDocuments.length === 3,
    `Folder prompt request lost the exact source manifest: ${JSON.stringify(workflowMetadata)}`);
  const submittedById = new Map(submittedDocuments.map((document) => [document.id, document.path]));
  assert(samePath(String(submittedById.get("a.txt") ?? ""), sourceAPath),
    `Folder prompt request bound a.txt to the wrong source: ${JSON.stringify(submittedDocuments)}`);
  assert(samePath(String(submittedById.get("b.txt") ?? ""), sourceBPath),
    `Folder prompt request bound b.txt to the wrong source: ${JSON.stringify(submittedDocuments)}`);
  assert(samePath(String(submittedById.get("book.epub") ?? ""), extractedEpubPath),
    `Folder prompt request bound book.epub to the wrong extracted text: ${JSON.stringify(submittedDocuments)}`);
  const proofreadPromptGenerated = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const open = doc?.querySelector("#proofreadPrompt");
    if (!open) return false;
    open.click();
    doc.querySelector("#applyPromptSettings")?.click();
    return true;
  })()`);
  assert(proofreadPromptGenerated, "Folder child did not expose proofreading prompt generation");
  const proofreadPrompt = await waitFor(
    () => folderView.webContents.executeJavaScript(
      'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")?.value || ""'
    ),
    (value) => value.includes("Workflow: yn-proofread-v1.") && value.includes("folder.proofread.json"),
    "the single-artifact folder proofreading prompt"
  );
  mark("proofread-prompt-ready");
  const proofreadReportLine = proofreadPrompt.split("\n").find((line) => line.startsWith("- Report output: ")) ?? "";
  const proofreadReportPath = proofreadReportLine.slice("- Report output: ".length);
  assert(samePath(proofreadReportPath, path.join(workspace, "report", "folder.proofread.json")),
    `Folder proofreading prompt used a non-canonical report path: ${proofreadReportLine}`);
  assert(!/\.md\b|summary|report[\\/]report/i.test(proofreadPrompt),
    `Folder proofreading prompt requested a second artifact or doubled report directory: ${proofreadPrompt}`);
  await waitForView(
    folderView,
    'window.__ynFolderLifecycle?.eventSubscriptions > 0 && window.__ynFolderLifecycle?.updateSubscriptions > 0',
    "native AgentSession subscriptions"
  );

  const reuseAuditEnabled = await folderView.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const open = doc?.querySelector("#translatePrompt");
    if (!open) return false;
    open.click();
    const checkbox = doc.querySelector("#promptReuseExistingTranslation");
    if (!checkbox) return false;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert(reuseAuditEnabled, "Could not enable existing-translation audit through the visible folder setting");
  await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(projectStatePath, "utf8"));
      } catch {
        return null;
      }
    },
    (state) => state?.reuseExistingTranslation === true,
    "the audit switch to persist in project.json"
  );

  await folderView.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#fileSelect");
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitForView(folderView, 'document.querySelector("#fileFrame")?.contentDocument?.title === "Folder child B"', "the second folder child");
  await waitForView(
    folderView,
    'window.__ynFolderLifecycle.eventUnsubscriptions === window.__ynFolderLifecycle.eventSubscriptions && window.__ynFolderLifecycle.updateUnsubscriptions === window.__ynFolderLifecycle.updateSubscriptions',
    "pagehide AgentSession cleanup"
  );

  const secondAgentOpened = await folderView.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#openAgentChat");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(secondAgentOpened, "Second folder child did not expose the Agent control");
  await waitForView(
    folderView,
    'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")',
    "the second child Pi-web composer"
  );

  const topLevelWindowCount = BrowserWindow.getAllWindows().length;
  await folderView.webContents.executeJavaScript('document.querySelector("#openActive").click()');
  await waitFor(
    () => viewerWindow.webContents.executeJavaScript('document.querySelectorAll("#tabs button[data-key]").length').catch(() => 0),
    (count) => count === 2,
    "two production workbench tabs"
  );
  assert(BrowserWindow.getAllWindows().length === topLevelWindowCount, "Open in new tab created another BrowserWindow");
  const childTabView = await waitFor(
    () => visibleView(viewerWindow),
    (candidate) => {
      if (!candidate || candidate.webContents.isDestroyed()) return false;
      const url = candidate.webContents.getURL();
      return url.startsWith("file:") && samePath(fileURLToPath(url), childBPath);
    },
    "the selected child in the active production tab"
  );
  assert(childTabView, "Selected child did not become the active workbench tab");
  mark("standalone-child-ready");

  await waitForView(childTabView, 'document.querySelector("#openAgentChat")', "the child tab Agent control");
  await childTabView.webContents.executeJavaScript('document.querySelector("#openAgentChat").click()');
  await waitForView(childTabView, 'document.querySelector("#agentChatReactRoot textarea")', "the child tab Pi-web composer");
  await writeFile(translationBPath, "synchronized baseline b\ntranslation b2", "utf8");
  const standaloneFileSynchronized = await childTabView.webContents.executeJavaScript(
    'syncFromBoundTranslationFile().then(() => document.querySelector(\'.row[data-line="1"] .target\')?.textContent || "")'
  );
  assert(standaloneFileSynchronized === "synchronized baseline b", "Standalone child could not synchronize its bound translation file");
  await waitFor(
    () => folderView.webContents.executeJavaScript(
      'document.querySelector("#fileFrame")?.contentDocument?.querySelector(\'.row[data-line="1"] .target\')?.textContent || ""'
    ),
    (value) => value === "synchronized baseline b",
    "the folder iframe to refresh synchronized translation-file content"
  );
  const standaloneChildEdited = await childTabView.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('.row[data-line="1"] .target');
    if (!target) return false;
    target.textContent = "standalone live translation b";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "standalone live translation b" }));
    return true;
  })()`);
  assert(standaloneChildEdited, "Standalone child could not record a synchronized line edit");
  await waitFor(
    () => folderView.webContents.executeJavaScript(
      'document.querySelector("#fileFrame")?.contentDocument?.querySelector(\'.row[data-line="1"] .target\')?.textContent || ""'
    ),
    (value) => value === "standalone live translation b",
    "the folder iframe to receive the standalone child edit"
  );
  const rapidManualEditSetup = await childTabView.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('.row[data-line="1"] .target');
    if (!target) return { ok: false, reason: "missing target" };
    target.textContent = "";
    target.dataset.nativeEditorIdentity = "rapid-input-editor";
    target.focus();
    return { ok: true };
  })()`);
  assert(rapidManualEditSetup.ok, `Rapid manual edit setup failed: ${rapidManualEditSetup.reason || "unknown"}`);
  const rapidManualText = "rapid manual translation b";
  for (const character of rapidManualText) {
    childTabView.webContents.sendInputEvent({ type: "char", keyCode: character });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rapidManualEdit = await childTabView.webContents.executeJavaScript(`(async () => {
    const target = document.querySelector('.row[data-line="1"] .target');
    if (!target) return { ok: false, reason: "missing target after native input" };
    const deadline = Date.now() + 5000;
    while (pendingLineMutations.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return {
      ok: true,
      text: target.textContent,
      stateText: state.edits[1],
      focused: document.activeElement === target,
      sameEditor: target.dataset.nativeEditorIdentity === "rapid-input-editor",
      documentRevision: state.documentRevision,
      pending: Array.from(pendingLineMutations.entries()),
      trace: window.__ynLineReviewSyncTrace.slice(-40)
    };
  })()`);
  assert(rapidManualEdit.ok, `Rapid manual edit setup failed: ${rapidManualEdit.reason || "unknown"}`);
  assert(rapidManualEdit.focused, "Canonical synchronization replaced the active translation editor");
  assert(rapidManualEdit.sameEditor, "Canonical synchronization rebuilt the native keyboard editor");
  assert(rapidManualEdit.text === rapidManualText, "Canonical synchronization erased native keyboard input");
  assert(rapidManualEdit.stateText === rapidManualText, `Canonical state rolled back the latest manual input: ${JSON.stringify(rapidManualEdit)}`);
  assert(rapidManualEdit.pending.length === 0, `Acknowledged native input left pending mutations: ${JSON.stringify(rapidManualEdit)}`);
  mark("native-input-ready");
  const imeEdit = await childTabView.webContents.executeJavaScript(`(async () => {
    const target = document.querySelector('.row[data-line="2"] .target');
    if (!target) return { ok: false, reason: "missing IME target" };
    target.focus();
    target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    target.textContent = "中";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "中", isComposing: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    target.textContent = "中文输入完成";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "文输入完成", isComposing: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文输入完成" }));
    const deadline = Date.now() + 5000;
    while (pendingLineMutations.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    target.blur();
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      ok: true,
      text: document.querySelector('.row[data-line="2"] .target')?.textContent,
      stateText: state.edits[2],
      pending: Array.from(pendingLineMutations.entries())
    };
  })()`);
  assert(imeEdit.ok, `IME edit setup failed: ${imeEdit.reason || "unknown"}`);
  assert(imeEdit.text === "中文输入完成" && imeEdit.stateText === "中文输入完成", `IME composition was not preserved after blur: ${JSON.stringify(imeEdit)}`);
  assert(imeEdit.pending.length === 0, `Acknowledged IME input left pending mutations: ${JSON.stringify(imeEdit)}`);
  await waitFor(
    () => folderView.webContents.executeJavaScript(
      'document.querySelector("#fileFrame")?.contentDocument?.querySelector(\'.row[data-line="1"] .target\')?.textContent || ""'
    ),
    (value) => value === rapidManualText,
    "the folder iframe to receive the complete rapid manual edit"
  );
  const selectedSourceOnly = await childTabView.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.row[data-line="1"]');
    const source = row?.querySelector('.source');
    const target = row?.querySelector('.target');
    const composer = document.querySelector('#agentChatReactRoot textarea');
    if (!source?.firstChild || !target?.firstChild || !composer) return { ok: false };
    const range = document.createRange();
    range.setStart(source.firstChild, Math.min(2, source.firstChild.textContent.length));
    range.setEnd(target.firstChild, Math.min(8, target.firstChild.textContent.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const clipped = sourceSelectionText(source);
    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
    const button = document.querySelector('.yn-agent-row-menu button');
    if (!button) return { ok: false };
    button.click();
    return { ok: true, clipped, source: source.textContent, target: target.textContent };
  })()`);
  assert(selectedSourceOnly.ok, "Cross-cell source selection did not expose the Agent action");
  assert(selectedSourceOnly.clipped === selectedSourceOnly.source.slice(2), `Source selection was not clipped to the source cell: ${JSON.stringify(selectedSourceOnly)}`);
  const selectedSourcePrompt = await waitFor(
    () => childTabView.webContents.executeJavaScript('document.querySelector("#agentChatReactRoot textarea")?.value || ""'),
    (value) => value.includes(selectedSourceOnly.clipped),
    "the selected source excerpt to reach the Agent composer"
  );
  assert(!selectedSourcePrompt.includes(selectedSourceOnly.target), "Agent prompt leaked selected translation text");
  const folderTabReactivated = await viewerWindow.webContents.executeJavaScript(`(() => {
    const tab = Array.from(document.querySelectorAll("button[data-key]"))
      .find(button => button.querySelector(".tab-title")?.textContent === "Native folder tabs");
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  assert(folderTabReactivated, "Could not reactivate the folder tab for synchronized batch write");
  await waitFor(() => visibleView(viewerWindow), (candidate) => candidate === folderView, "the folder tab to reactivate");
  const synchronizedBatchWrite = await folderView.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#writeAllTxt");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(synchronizedBatchWrite, "Folder batch write could not start after the standalone edit");
  await waitFor(
    () => readFile(translationBPath, "utf8"),
    (value) => value === "rapid manual translation b\n中文输入完成",
    "the synchronized standalone edit to reach batch TXT output"
  );
  const childBStatePath = path.join(workspace, ".translation-workshop", "state", `line-${path.basename(childBPath)}.json`);
  const synchronizedChildState = JSON.parse(await readFile(childBStatePath, "utf8"));
  assert(synchronizedChildState?.edits?.[1] === "rapid manual translation b",
    "The canonical child sidecar lost the standalone edit during iframe flush");
  assert(synchronizedChildState?.edits?.[2] === "中文输入完成",
    "The canonical child sidecar lost the IME edit after focusout");
  const childTabReactivated = await viewerWindow.webContents.executeJavaScript(`(() => {
    const tab = Array.from(document.querySelectorAll("button[data-key]"))
      .find(button => button.querySelector(".tab-title")?.textContent === "Folder child B");
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  assert(childTabReactivated, "Could not reactivate the synchronized standalone child tab");
  await waitFor(() => visibleView(viewerWindow), (candidate) => candidate === childTabView, "the standalone child tab to reactivate");
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1") {
    viewerWindow.show();
    viewerWindow.focus();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const captureDomState = await childTabView.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#agentChatReactRoot textarea");
    const root = document.querySelector("#agentChatReactRoot");
    const rect = element => element ? element.getBoundingClientRect().toJSON() : null;
    return {
      title: document.title,
      readyState: document.readyState,
      hidden: document.hidden,
      bodyTextLength: document.body?.innerText?.length ?? 0,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      rootRect: rect(root),
      textareaRect: rect(textarea)
    };
  })()`);
  assert(visibleView(viewerWindow) === childTabView, "Selected child BrowserView was detached before capture");
  assert(captureDomState.bodyTextLength > 0, "Selected child rendered no visible text");
  assert(captureDomState.rootRect?.width > 0 && captureDomState.rootRect?.height > 0, "Selected child Agent root has no layout box");
  assert(captureDomState.textareaRect?.width > 0 && captureDomState.textareaRect?.height > 0, "Selected child Agent composer has no layout box");
  const originalViewerBounds = viewerWindow.getBounds();
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS === "1") {
    viewerWindow.setSkipTaskbar(true);
    viewerWindow.setBounds({ x: -32000, y: -32000, width: originalViewerBounds.width, height: originalViewerBounds.height });
    viewerWindow.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The hidden tab shell has no compositor surface. The active BrowserView is
  // the actual product page, so capture that rendered surface once and retain
  // it under both acceptance artifact names.
  const agentViewPng = await captureRenderedPage(childTabView.webContents, "Active child Agent");
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS === "1") {
    viewerWindow.hide();
    viewerWindow.setBounds(originalViewerBounds);
  }
  const tabShellPng = agentViewPng;
  await Promise.all([
    writeFile(screenshotPath, tabShellPng),
    writeFile(agentScreenshotPath, agentViewPng)
  ]);
  mark("standalone-capture-ready");

  const currentChild = await readFile(childAPath, "utf8");
  const currentPromptMarker = `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`;
  const previousPromptMarker = `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`;
  assert(currentChild.includes(LINE_REVIEW_PROTOCOL_MARKER), "Prompt-only fixture did not start with the current line-review protocol");
  assert(currentChild.includes(currentPromptMarker), "Prompt-only fixture did not start with the current prompt protocol");
  const promptOnlyV19Child = currentChild.replace(currentPromptMarker, previousPromptMarker);
  assert(promptOnlyV19Child.includes(LINE_REVIEW_PROTOCOL_MARKER), "Prompt-only fixture changed the line-review protocol");
  assert(promptOnlyV19Child.includes(previousPromptMarker), "Prompt-only fixture did not downgrade exactly the prompt marker");
  await writeFile(childAPath, promptOnlyV19Child, "utf8");

  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: childAPath, outputDir: workspace })})`
  );
  const promptOnlyView = await waitFor(
    () => visibleView(viewerWindow),
    (candidate) => {
      if (!candidate || candidate.webContents.isDestroyed()) return false;
      const url = candidate.webContents.getURL();
      return url.startsWith("file:") && samePath(fileURLToPath(url), childAPath);
    },
    "the prompt-only v19 child in the production tab host"
  );
  assert(promptOnlyView, "Prompt-only v19 child did not open through the normal product path");
  await waitForView(promptOnlyView, 'document.querySelector("#translatePrompt")', "the prompt-only upgraded translation control");
  const promptOnlyUpgraded = await readFile(childAPath, "utf8");
  assert(promptOnlyUpgraded.includes(LINE_REVIEW_PROTOCOL_MARKER), "Prompt-only upgrade changed the current line-review protocol");
  assert(promptOnlyUpgraded.includes(currentPromptMarker), "A pure v19 prompt marker did not upgrade to v20 on disk");
  assert(!promptOnlyUpgraded.includes(previousPromptMarker), "Prompt-only upgrade left the v19 marker on disk");
  const promptOnlySettingsOpened = await promptOnlyView.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#translatePrompt");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(promptOnlySettingsOpened, "Prompt-only upgraded child could not open translation settings");
  await waitForView(promptOnlyView, 'document.querySelector("#promptSettingsPanel")?.hidden === false', "the prompt-only settings panel");
  await waitForView(
    promptOnlyView,
    'document.querySelector("#promptReuseExistingTranslation")?.checked === true',
    "the project-level audit preference after prompt-only HTML upgrade"
  );
  const promptOnlyApplied = await promptOnlyView.webContents.executeJavaScript(`(() => {
    const count = document.querySelector("#promptSubagentCount");
    const apply = document.querySelector("#applyPromptSettings");
    if (!count || !apply) return false;
    count.value = "5";
    apply.click();
    return true;
  })()`);
  assert(promptOnlyApplied, "Prompt-only upgraded child could not apply settings");
  await waitForView(
    promptOnlyView,
    'document.querySelector("#agentChatReactRoot textarea")?.value.includes("Subagents: enabled; maximum=5") && document.querySelector("#agentChatReactRoot textarea")?.value.includes("File order (removed names are skipped; braces remove relative ordering only):") && document.querySelector("#agentChatReactRoot textarea")?.value.includes("Existing translation: audit and reuse")',
    "the prompt-only current-protocol composer insertion"
  );
  mark("prompt-upgrade-ready");

  const lifecycle = await folderView.webContents.executeJavaScript("window.__ynFolderLifecycle");
  console.log(JSON.stringify({
    ok: true,
    productFolderTabs: true,
    markerlessDiskMigration: true,
    promptOnlyV19Upgrade: true,
    reuseAuditVisibleDefaultOff: true,
    reuseAuditProjectPersistence: true,
    folderIframeAgent: true,
    folderOpenInTab: true,
    sameFileImportedTranslationSync: true,
    sameFileLiveSync: true,
    rapidManualEditPreserved: true,
    selectedSourceClipped: true,
    batchTxtWrite: true,
    pagehideCleanup: lifecycle,
    screenshots: [folderPromptScreenshotPath, screenshotPath, agentScreenshotPath]
  }));
}

void app.whenReady().then(run).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
