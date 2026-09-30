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

async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${expression}`);
}
async function click(selector: string): Promise<void> {
  await win!.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function search(value: string): Promise<void> {
  await win!.webContents.executeJavaScript(`(() => {
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
  await window.webContents.executeJavaScript("window.confirm = () => true; true;");
  return window;
}
async function run(): Promise<void> {
try {
  console.log("[glossary-verify] ready");
  registerAgentAssetIpc();
  ipcMain.handle("agent-interface:publish", () => ({ ok: true }));
  ipcMain.handle("project:readState", () => readProjectState(workspace));
  ipcMain.handle("project:patch", async (_event, args) => {
    await patchProjectState(args.outputDir, args.patch);
    return readProjectState(args.outputDir);
  });
  ipcMain.handle("files:readTextFile", async (_event, args) => ({ path: args.path, text: await readFile(args.path, "utf8") }));
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
    { source: "AI_DROP", target: "候选删除" }
  ] }));
  await writeFile(translationPath, "已有译文");
  const htmlPath = path.join(workspace, "review.html");
  const html = renderLineReviewHtml({
    title: "Glossary management verification", locale: "zh-CN", sourceText: "原文", translationText: "已有译文", lineReviewPath: htmlPath,
    workflow: { outputDir: workspace, sourcePath: path.join(workspace, "source.txt"), translationPath, glossaryPath: formalPath, glossaryEntries: entries }
  });
  const oldHtml = html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v38");
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
  await waitFor(win, "document.querySelectorAll('.glossary-candidate-target').length === 2");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#glossaryList').textContent.includes('候选别名')"), true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#glossaryList img') === null"), true, "candidate metadata must be escaped");
  await search("AI_DROP");
  await waitFor(win, "document.querySelectorAll('.glossary-delete').length === 1");
  await click(".glossary-delete");
  await waitFor(win, "document.querySelector('#glossaryCount').textContent === '0/1'");
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")).entries.map((entry: { source: string }) => entry.source), ["AI_KEEP"]);
  await search("");
  await mkdir(path.join(process.cwd(), "artifacts/verification"), { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  await writeFile(path.join(process.cwd(), "artifacts/verification/glossary-candidates.png"), (await win.webContents.capturePage()).toPNG());
  await click("#importGeneratedGlossary");
  await waitFor(win, "document.querySelector('#viewFormalGlossary').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.glossary-target').length === 3");
  assert.deepEqual((await readProjectAssets({ outputDir: workspace })).glossary.entries.map(entry => entry.source), ["KEEP", "DROP", "AI_KEEP"]);
  await search("DROP");
  await click(".glossary-delete");
  await waitFor(win, "document.querySelector('#glossaryCount').textContent === '0/2'");
  await waitFor(peer, "document.querySelectorAll('.glossary-target').length === 2");
  assert.deepEqual((await readProjectAssets({ outputDir: workspace })).glossary.entries.map(entry => entry.source), ["KEEP", "AI_KEEP"]);
  assert.equal(await readFile(translationPath, "utf8"), "已有译文");
  await search("");
  win.reload();
  await waitFor(win, "document.querySelectorAll('.glossary-target').length === 2");
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#glossaryList').textContent.includes('formal metadata')"), true);
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ glossaryManagement: true, upgradedHtml: true, candidatePreview: true, filteredDelete: true, selectiveImport: true, crossWindowSync: true, reloadPersists: true, existingTranslationUnchanged: true }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  unsubscribe?.();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  app.exit(process.exitCode ?? 0);
}
}
void app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
