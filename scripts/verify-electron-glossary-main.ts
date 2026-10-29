import { registerReviewHtmlFixtureReadIpc } from "../tests/helpers/review-html-fixture-ipc.ts";
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LINE_REVIEW_PROTOCOL_MARKER, renderLineReviewHtml } from "../src/shared/core/html.ts";
import { needsLegacyLineReviewUpgrade, upgradeLegacyLineReviewHtmlContent } from "../src/shared/core/legacyHtml.ts";
import { registerAgentAssetIpc } from "../src/main/ipc/agentAssetHandlers.ts";
import { patchProjectState, readProjectState } from "../src/main/projectState.ts";
import { readProjectAssets } from "../src/main/agent/projectAssets.ts";
import { subscribeWorkspaceAssetsStatus, workspaceAssetPaths } from "../src/main/agent/workspaceAssets.ts";

console.log("[glossary-verify] initialize");
const workspace = await mkdtemp(path.join(os.tmpdir(), "yn-electron-glossary-"));
app.disableHardwareAcceleration();
app.setPath("userData", path.join(workspace, "user-data"));
let win: BrowserWindow | undefined;
let peer: BrowserWindow | undefined;
let unsubscribe: (() => void) | undefined;
const rendererErrors: string[] = [];
let aiEscapeCandidateUpdateCalls = 0;
function createDeferredCandidateResponseGate() {
  let signalStarted!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>(resolve => { signalStarted = resolve; }),
    signalStarted: () => signalStarted(),
    response: new Promise<void>(resolve => { release = resolve; }),
    release: () => release(),
    used: false
  };
}
const deferredCandidateResponseGates = new Map([
  ["保存中的候选 A", createDeferredCandidateResponseGate()],
  ["保存中的候选 C", createDeferredCandidateResponseGate()]
]);

async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${expression}`);
}
async function click(selector: string): Promise<void> {
  await clickIn(win!, selector);
}
async function clickIn(window: BrowserWindow, selector: string): Promise<void> {
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function search(value: string): Promise<void> {
  await searchIn(win!, value);
}
async function searchIn(window: BrowserWindow, value: string): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#glossarySearch');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}
async function makeWindow(htmlPath: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1150, height: 850, show: false,
    webPreferences: { preload: path.join(process.cwd(), "dist/main/preload.cjs"), contextIsolation: true, nodeIntegration: false, offscreen: true }
  });
  window.webContents.on("console-message", details => {
    if (details.level === "error") rendererErrors.push(details.message);
  });
  await window.loadFile(htmlPath);
  await window.webContents.executeJavaScript("window.translationWorkshopLineReviewReady");
  await window.webContents.executeJavaScript("window.confirm = () => true; true;");
  return window;
}
async function waitForCandidateFile(candidatePath: string, source: string, target: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const parsed = JSON.parse(await readFile(candidatePath, "utf8"));
    if (parsed.entries?.find((entry: { source: string }) => entry.source === source)?.target === target) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for candidate ${source} to become ${target}.`);
}
async function waitForDeferredCandidateUpdate(target: string): Promise<void> {
  const gate = deferredCandidateResponseGates.get(target);
  if (!gate) throw new Error(`No deferred candidate gate was registered for ${target}.`);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      gate.started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for the deferred candidate update IPC call.")), 6000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function waitForCandidateRefresh(window: BrowserWindow, source: string, draft: string, target: string, expectedTarget: string): Promise<void> {
  const deadline = Date.now() + 6000;
  let lastState: { value: string; originalTarget: string; currentTarget: string } | undefined;
  while (Date.now() < deadline) {
    lastState = await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.glossary-entry')]
        .find(item => item.querySelector('.glossary-source')?.value === ${JSON.stringify(source)});
      const input = row?.querySelector('.glossary-candidate-target');
      return input ? {
        value: input.value,
        originalTarget: input.dataset.originalTarget,
        currentTarget: input.dataset.currentTarget
      } : undefined;
    })()`);
    if (lastState?.value === draft && lastState.originalTarget === target
      && lastState.currentTarget === expectedTarget) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for candidate refresh to preserve draft: ${JSON.stringify(lastState)}`);
}
async function run(): Promise<void> {
try {
  console.log("[glossary-verify] ready");
  const originalIpcMainHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (...args: any[]) => any) => {
    const wrappedListener = channel === "agent-assets:updateGeneratedGlossary"
      ? async (event: unknown, args: { source?: string; target?: string }, ...rest: unknown[]) => {
        if (args?.source === "AI_ESCAPE") aiEscapeCandidateUpdateCalls += 1;
        const result = await listener(event, args, ...rest);
        const responseGate = args?.source === "AI_DEFERRED"
          ? deferredCandidateResponseGates.get(String(args.target || ""))
          : undefined;
        if (responseGate && !responseGate.used) {
          responseGate.used = true;
          responseGate.signalStarted();
          await responseGate.response;
        }
        return result;
      }
      : listener;
    return originalIpcMainHandle(channel, wrappedListener);
  }) as typeof ipcMain.handle;
  try {
    registerAgentAssetIpc();
  } finally {
    ipcMain.handle = originalIpcMainHandle as typeof ipcMain.handle;
  }
  ipcMain.handle("agent-interface:publish", () => ({ ok: true }));
  ipcMain.handle("project:readState", () => readProjectState(workspace));
  ipcMain.handle("project:patch", async (_event, args) => {
    await patchProjectState(args.outputDir, args.patch);
    return readProjectState(args.outputDir);
  });
  ipcMain.handle("files:readTextFile", async (_event, args) => ({ path: args.path, text: await readFile(args.path, "utf8") }));
  registerReviewHtmlFixtureReadIpc();
  ipcMain.handle("html:persistState", () => ({ ok: true }));
  unsubscribe = subscribeWorkspaceAssetsStatus((outputDir, status) => {
    for (const contents of webContents.getAllWebContents()) contents.send("agent-assets:workspaceUpdate", { outputDir, status });
  });
  const candidatePath = workspaceAssetPaths(workspace).glossaryCandidates;
  const formalPath = path.join(workspace, ".translation-workshop/glossary.json");
  const translationPath = path.join(workspace, "translation.txt");
  const entries = [
    { source: "KEEP", target: "保留", aliases: ["留下"], info: "formal metadata", status: "confirmed" },
    { source: "DROP", target: "删除" }
  ];
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await mkdir(path.dirname(formalPath), { recursive: true });
  await writeFile(formalPath, JSON.stringify({ entries }));
  await patchProjectState(workspace, { glossaryPath: formalPath });
  await writeFile(candidatePath, JSON.stringify({ entries: [
    { source: "AI_KEEP", target: "候选保留", aliases: ["候选别名"], info: "<img src=x onerror=alert(1)> evidence", status: "pending" },
    { source: "ai_keep", target: "大小写独立候选", aliases: ["小写别名"], info: "case-sensitive metadata", status: "pending" },
    { source: "AI_ESCAPE", target: "待取消", aliases: ["取消别名"], info: "escape metadata", status: "pending" },
    { source: "AI_CONFLICT", target: "并发原候选", aliases: ["并发别名"], info: "concurrency metadata", status: "pending" },
    { source: "AI_DEFERRED", target: "延迟原候选", aliases: ["延迟别名"], info: "deferred metadata", status: "pending" },
    { source: "AI_DROP", target: "候选删除" }
  ] }));
  await writeFile(translationPath, "已有译文");
  const htmlPath = path.join(workspace, "review.html");
  const html = renderLineReviewHtml({
    title: "Glossary management verification", locale: "zh-CN", sourceText: "原文", translationText: "已有译文", lineReviewPath: htmlPath,
    workflow: { outputDir: workspace, sourcePath: path.join(workspace, "source.txt"), translationPath, glossaryPath: formalPath, glossaryEntries: entries }
  });
  const oldHtml = html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v60");
  assert.equal(needsLegacyLineReviewUpgrade(oldHtml), true);
  await writeFile(htmlPath, upgradeLegacyLineReviewHtmlContent(oldHtml));
  console.log("[glossary-verify] load HTML");
  win = await makeWindow(htmlPath);
  console.log("[glossary-verify] first window loaded");
  peer = await makeWindow(htmlPath);
  console.log("[glossary-verify] both windows loaded");
  await click("#glossaryDrawerToggle");
  await waitFor(win, "document.querySelector('#importGeneratedGlossary').hidden === false");
  await click("#viewGlossaryCandidates");
  await waitFor(win, "document.querySelectorAll('.glossary-candidate-target').length === 6");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('.glossary-candidate-target').readOnly"), false, "AI glossary candidate targets must be editable");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('.glossary-source').readOnly"), true, "AI glossary candidate sources must remain read-only");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#glossaryList').textContent.includes('候选别名')"), true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#glossaryList img') === null"), true, "candidate metadata must be escaped");

  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_ESCAPE');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = '未保存的候选';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await waitFor(win, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_ESCAPE')?.querySelector('.glossary-candidate-target')?.value === '待取消'");
  assert.equal(JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "AI_ESCAPE").target, "待取消", "Escape must discard an unsaved candidate target");
  const decomposedTarget = "cafe\u0301";
  const canonicalTarget = decomposedTarget.normalize("NFC");
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_ESCAPE');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = ${JSON.stringify(decomposedTarget)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  })()`);
  await waitForCandidateFile(candidatePath, "AI_ESCAPE", canonicalTarget);
  await waitFor(win, `(() => { const input = [...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_ESCAPE')?.querySelector('.glossary-candidate-target'); return input?.value === ${JSON.stringify(canonicalTarget)} && input.dataset.originalTarget === ${JSON.stringify(canonicalTarget)} && input.dataset.currentTarget === ${JSON.stringify(canonicalTarget)}; })()`);
  assert.equal(aiEscapeCandidateUpdateCalls, 1, "a decomposed candidate target must settle after one canonical save");

  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_KEEP');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = '修订候选译名';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  })()`);
  await waitForCandidateFile(candidatePath, "AI_KEEP", "修订候选译名");
  await waitFor(win, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_KEEP')?.querySelector('.glossary-candidate-target')?.value === '修订候选译名'");
  const savedCandidate = JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "AI_KEEP");
  assert.deepEqual(savedCandidate, {
    source: "AI_KEEP", target: "修订候选译名", aliases: ["候选别名"],
    info: "<img src=x onerror=alert(1)> evidence", status: "pending"
  }, "editing a target must preserve candidate metadata");
  assert.equal(JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "ai_keep").target, "大小写独立候选", "candidate edit state must keep case-distinct sources separate");

  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_DEFERRED');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = '保存中的候选 A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitForDeferredCandidateUpdate("保存中的候选 A");
  await waitForCandidateFile(candidatePath, "AI_DEFERRED", "保存中的候选 A");
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_DEFERRED');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_DEFERRED');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = '候选 B';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_DEFERRED')?.querySelector('.glossary-candidate-target')?.value === '候选 B'");
  assert.equal(JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "AI_DEFERRED").target, "保存中的候选 A", "a replacement draft must stay unsaved while the earlier response is pending");
  deferredCandidateResponseGates.get("保存中的候选 A")!.release();
  await waitFor(win, "(() => { const input = [...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_DEFERRED')?.querySelector('.glossary-candidate-target'); return input?.value === '候选 B' && input.dataset.originalTarget === '保存中的候选 A' && input.dataset.currentTarget === '保存中的候选 A'; })()");
  assert.equal(JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "AI_DEFERRED").target, "保存中的候选 A", "the earlier save response must not commit a replacement draft");
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_DEFERRED');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitForCandidateFile(candidatePath, "AI_DEFERRED", "候选 B");
  await waitFor(win, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_DEFERRED')?.querySelector('.glossary-candidate-target')?.value === '候选 B'");
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_DEFERRED');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = '保存中的候选 C';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitForDeferredCandidateUpdate("保存中的候选 C");
  await waitForCandidateFile(candidatePath, "AI_DEFERRED", "保存中的候选 C");
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_DEFERRED');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  deferredCandidateResponseGates.get("保存中的候选 C")!.release();
  await waitFor(win, "(() => { const input = [...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_DEFERRED')?.querySelector('.glossary-candidate-target'); return input?.value === '保存中的候选 C' && input.dataset.originalTarget === '保存中的候选 C' && input.dataset.currentTarget === '保存中的候选 C'; })()");
  assert.equal(JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "AI_DEFERRED").target, "保存中的候选 C", "an Escape-only response must display the committed target rather than a stale draft");

  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'ai_keep');
    row.querySelector('.glossary-delete').click();
  })()`);
  await waitFor(win, "document.querySelectorAll('.glossary-candidate-target').length === 5");
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")).entries.map((entry: { source: string }) => entry.source), ["AI_KEEP", "AI_ESCAPE", "AI_CONFLICT", "AI_DEFERRED", "AI_DROP"]);

  await clickIn(peer!, "#glossaryDrawerToggle");
  await waitFor(peer!, "document.querySelector('#importGeneratedGlossary').hidden === false");
  await clickIn(peer!, "#viewGlossaryCandidates");
  await waitFor(peer!, "document.querySelectorAll('.glossary-candidate-target').length === 5");
  await waitFor(peer!, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_KEEP')?.querySelector('.glossary-candidate-target')?.value === '修订候选译名'");
  await waitFor(peer!, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_DEFERRED')?.querySelector('.glossary-candidate-target')?.value === '保存中的候选 C'");
  const formalBeforeImport = await readProjectAssets({ outputDir: workspace });
  assert.deepEqual(formalBeforeImport.glossary.entries.map(entry => entry.source), ["KEEP", "DROP"], "candidate edits must not change the formal glossary before import");
  assert.equal(await readFile(translationPath, "utf8"), "已有译文", "candidate edits must not change translations");

  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_CONFLICT');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.value = '主窗口候选';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await peer.webContents.executeJavaScript(`(async () => {
    const bridge = window.workshopHtml || window.parent?.workshopHtml;
    if (!bridge?.updateGeneratedGlossaryCandidate) throw new Error('Candidate update bridge is unavailable.');
    await bridge.updateGeneratedGlossaryCandidate(${JSON.stringify({
      outputDir: workspace, source: "AI_CONFLICT", expectedTarget: "并发原候选", target: "另一窗口候选"
    })});
  })()`);
  await waitForCandidateRefresh(win!, "AI_CONFLICT", "主窗口候选", "另一窗口候选", "并发原候选");
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.glossary-entry')]
      .find(item => item.querySelector('.glossary-source')?.value === 'AI_CONFLICT');
    const input = row.querySelector('.glossary-candidate-target');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor(win, "document.querySelector('#aiStatus').textContent.includes('候选译名已在其他窗口更新')");
  await waitFor(win, "[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_CONFLICT')?.querySelector('.glossary-candidate-target')?.value === '主窗口候选'");
  assert.equal(JSON.parse(await readFile(candidatePath, "utf8")).entries.find((entry: { source: string }) => entry.source === "AI_CONFLICT").target, "另一窗口候选", "a stale edit must not overwrite a concurrent candidate update");

  await search("AI_DROP");
  await waitFor(win, "document.querySelectorAll('.glossary-delete').length === 1");
  await click(".glossary-delete");
  await waitFor(win, "document.querySelector('#glossaryCount').textContent === '0/4'");
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")).entries.map((entry: { source: string }) => entry.source), ["AI_KEEP", "AI_ESCAPE", "AI_CONFLICT", "AI_DEFERRED"]);
  await search("");
  await mkdir(path.join(process.cwd(), "artifacts/verification"), { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  await writeFile(path.join(process.cwd(), "artifacts/verification/glossary-candidates.png"), (await win.webContents.capturePage()).toPNG());
  await click("#importGeneratedGlossary");
  await waitFor(win, "document.querySelector('#viewFormalGlossary').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.glossary-target').length === 6");
  const importedGlossary = (await readProjectAssets({ outputDir: workspace })).glossary.entries;
  assert.deepEqual(importedGlossary.map(entry => entry.source), ["KEEP", "DROP", "AI_KEEP", "AI_ESCAPE", "AI_CONFLICT", "AI_DEFERRED"]);
  assert.deepEqual(importedGlossary.find(entry => entry.source === "AI_KEEP"), {
    source: "AI_KEEP", target: "修订候选译名", aliases: ["候选别名"],
    info: "<img src=x onerror=alert(1)> evidence", status: "pending"
  }, "import must use the edited candidate and its metadata");
  assert.equal(importedGlossary.find(entry => entry.source === "AI_CONFLICT")?.target, "另一窗口候选", "import must use the latest concurrent candidate revision");
  assert.equal(importedGlossary.find(entry => entry.source === "AI_DEFERRED")?.target, "保存中的候选 C", "import must use the explicitly saved target");
  await clickIn(peer!, "#viewFormalGlossary");
  await waitFor(peer!, "document.querySelectorAll('.glossary-target').length === 6");
  await search("DROP");
  await click(".glossary-delete");
  await waitFor(win, "document.querySelector('#glossaryCount').textContent === '0/5'");
  await waitFor(peer, "document.querySelectorAll('.glossary-target').length === 5");
  assert.deepEqual((await readProjectAssets({ outputDir: workspace })).glossary.entries.map(entry => entry.source), ["KEEP", "AI_KEEP", "AI_ESCAPE", "AI_CONFLICT", "AI_DEFERRED"]);
  assert.equal(await readFile(translationPath, "utf8"), "已有译文");
  await search("");
  win.reload();
  await waitFor(win, "document.querySelectorAll('.glossary-target').length === 5");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#glossaryList').textContent.includes('formal metadata')"), true);
  assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('.glossary-entry')].find(row => row.querySelector('.glossary-source')?.value === 'AI_KEEP')?.querySelector('.glossary-target')?.value === '修订候选译名'"), true, "reopened HTML must show the imported candidate revision");
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ glossaryManagement: true, upgradedHtmlFromV60: true, candidatePreview: true, candidateTargetEditable: true, candidateEscapeCancel: true, canonicalTargetNormalization: true, candidateMetadataPreserved: true, candidateCrossWindowSync: true, candidateConflictVisible: true, candidateImportUsesRevision: true, deferredCandidateDraftSurvivesPendingSave: true, deferredEscapeOnlyResetsBaselineDraft: true, filteredDelete: true, selectiveImport: true, crossWindowSync: true, reloadPersists: true, existingTranslationUnchanged: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const gate of deferredCandidateResponseGates.values()) gate.release();
  unsubscribe?.();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  app.quit();
}
}
void app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
