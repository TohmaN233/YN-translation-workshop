import { app, BrowserWindow, dialog } from "electron";
import { mkdir, mkdtemp, writeFile, readFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { renderLineReviewHtml, renderProposalReviewHtml, renderBatchLineReviewIndexHtml } from "../src/shared/core/html.ts";
import { PiSessionRepository } from "../src/main/agent/piNative/sessionRepository.ts";
import { piNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), "yn-portability-electron-"));
const original = path.join(temp, "original"), copied = path.join(temp, "copied");
const htmlDir = path.join(original, ".translation-workshop", "html");
const sourcePath = path.join(original, "source.txt");
const linePath = path.join(htmlDir, "line.html");
const proposalPath = path.join(htmlDir, "proposal.html"), batchPath = path.join(htmlDir, "batch.html");
await mkdir(htmlDir, { recursive: true });
await writeFile(sourcePath, "Hello {name}");
await writeFile(path.join(original, ".translation-workshop", "project.json"), JSON.stringify({ outputDir: original, sourcePath, sourceKind: "file", lineReviewPath: linePath }));
const repo = new PiSessionRepository(original);
await repo.create("portable-parent");
await repo.createChild("portable-child", "portable-parent");
await repo.writeActiveSessionId("portable-parent");
await repo.close();
await writeFile(linePath, renderLineReviewHtml({ title: "copy line", sourceText: "Hello {name}", translationText: "你好 {name}", lineReviewPath: linePath,
  workflow: { outputDir: original, sourcePath, advanced: { glossaryCandidates: false, characterBible: false } } }));
await writeFile(proposalPath, renderProposalReviewHtml({ title: "copy proposal", proposals: [], outputDir: original, lineReviewPath: linePath }));
await writeFile(batchPath, renderBatchLineReviewIndexHtml({ title: "copy batch", files: [{ sourceName: "source.txt", sourcePath, outputPath: "line.html", status: "matched", sourceLineCount: 1 }],
  workflow: { outputDir: original, sourcePath, sourceKind: "folder" } }));
await cp(original, copied, { recursive: true });
app.setAppPath(root);
app.setPath("userData", path.join(temp, "userData"));
app.disableHardwareAcceleration();
const suspensions: string[] = [];
const suspend = piNativeSessionService.suspendWorkspace.bind(piNativeSessionService);
piNativeSessionService.suspendWorkspace = async outputDir => { suspensions.push(outputDir); await suspend(outputDir); };
const errors: string[] = [];
(dialog as any).showMessageBox = async (_window: unknown, options: any) => { errors.push(options.detail); return { response: 0 }; };
await import("../src/main/main.ts");
const fake = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } });
const models = createModels(); models.setProvider(fake.provider);
(piNativeSessionService as any).options.createModelSelection = async () => ({ models, model: fake.getModel(), providerId: fake.provider.id, modelId: fake.getModel().id });
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
async function waitFor(read: () => any, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  const main = await waitFor(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes("renderer/index.html") && !win.webContents.isLoading()), "main renderer");
  async function open(file: string) {
    console.log("[portability] opening", path.basename(file));
    const result = await main.webContents.executeJavaScript(`window.workshop.openPath(${JSON.stringify(file.replace(original, copied))})`);
    assert(result === "", `Opening HTML failed: ${result}`);
    const viewer = await waitFor(() => BrowserWindow.getAllWindows().find(win => win !== main && win.webContents.getURL().startsWith("data:")), "viewer");
    const view = await waitFor(() => viewer.getBrowserViews().find((view: any) => view.getBounds().width && !view.webContents.isLoading()), "active view");
    await waitFor(() => view.webContents.executeJavaScript('typeof window.flushTranslationWorkshopLineReviewState === "function" || Boolean(document.getElementById("proposalData") || document.getElementById("batchData"))').catch(() => false), "ready HTML");
    return { viewer, view };
  }
  const loaded = await main.webContents.executeJavaScript(`window.workshop.loadProject(${JSON.stringify(copied)})`);
  assert(loaded.sourcePath === sourcePath.replace(original, copied), "Project read stale source while original still exists");
  const bootstrap = await main.webContents.executeJavaScript(`window.workshop.agentSession.loadBootstrap(${JSON.stringify({ outputDir: copied })})`);
  assert(bootstrap.sessions.some((session: any) => session.id === "portable-parent"), "IPC bootstrap lost native parent history");
  // Native history is additionally checked through the same repository used by IPC.
  const movedRepo = new PiSessionRepository(copied);
  assert((await movedRepo.listMetadata()).length === 1, "Moved history disappeared");
  assert((await movedRepo.openChildForParent("portable-child", "portable-parent")).metadata.id === "portable-child", "Owned child disappeared");
  await movedRepo.close();
  let { viewer, view } = await open(linePath);
  fake.setResponses([fauxAssistantMessage(fauxText("Long running native Pi response for close cancellation acceptance."))]);
  await piNativeSessionService.prompt({ outputDir: copied, sessionId: "portable-parent", prompt: "Ordinary test conversation.", providerId: fake.provider.id, modelId: fake.getModel().id });
  await waitFor(() => piNativeSessionService.hasActiveWork(copied), "native running session");
  await view.webContents.executeJavaScript(`(() => { const el = document.querySelector(".target"); el.textContent = "修改 {name}"; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await viewer.webContents.executeJavaScript('document.querySelector(".tab-close").click(); document.querySelector(".tab-close")?.click();');
  await waitFor(() => viewer.isDestroyed(), "line tab closure");
  assert(!piNativeSessionService.hasActiveWork(copied), "HTML close failed to cancel the real active Pi runtime");
  const stateDir = path.join(copied, ".translation-workshop", "state");
  const state = JSON.parse(await readFile(path.join(stateDir, "line-line.html.json"), "utf8"));
  assert(state.edits[1] === "修改 {name}", "Closing lost queued line edit");
  ({ viewer, view } = await open(batchPath));
  await waitFor(() => view.webContents.executeJavaScript('Boolean(document.getElementById("fileFrame")?.contentWindow?.flushTranslationWorkshopLineReviewState)').catch(() => false), "batch child");
  await open(proposalPath);
  viewer.close(); viewer.close();
  await waitFor(() => viewer.isDestroyed(), "native multi-tab closure");
  ({ viewer, view } = await open(linePath));
  await view.webContents.executeJavaScript('void (window.flushTranslationWorkshopLineReviewState = async () => { throw new Error("fixture-save-error"); })');
  const before = suspensions.length;
  viewer.close();
  await waitFor(() => errors.some(error => error.includes("fixture-save-error")), "visible save failure");
  assert(!viewer.isDestroyed() && suspensions.length > before, "Save error blocked Stop or lost edits");
  await viewer.webContents.executeJavaScript('document.querySelector(".tab-close").click();');
  await waitFor(() => viewer.webContents.executeJavaScript('!document.getElementById("closeError").hidden'), "tab close save failure");
  const errorBounds = await viewer.webContents.executeJavaScript('(() => { const el = document.getElementById("closeError"); const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, text: el.textContent }; })()');
  assert(errorBounds.text.includes("fixture-save-error") && errorBounds.top >= 0 && errorBounds.bottom <= view.getBounds().y, "Tab close error is obscured by the native BrowserView");
  const screenshotDir = path.join(root, "artifacts", "verification");
  await mkdir(screenshotDir, { recursive: true });
  await viewer.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(path.join(screenshotDir, "project-close-save-error.png"), (await viewer.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  await view.webContents.executeJavaScript('void (window.flushTranslationWorkshopLineReviewState = async () => {})');
  viewer.close();
  await waitFor(() => viewer.isDestroyed(), "closure after save failure resolved");
  ({ viewer, view } = await open(linePath));
  await view.webContents.executeJavaScript('void (window.flushTranslationWorkshopLineReviewState = () => new Promise(resolve => { window.releaseFixtureSave = resolve; }))');
  const beforePending = suspensions.length;
  viewer.close();
  await waitFor(() => suspensions.length > beforePending, "Stop while save pending");
  await view.webContents.executeJavaScript('void window.releaseFixtureSave()');
  await waitFor(() => viewer.isDestroyed(), "closure when pending write settles");
  assert(suspensions.every(value => value === copied), `Close used wrong runtime directory: ${JSON.stringify(suspensions)}`);
  await rm(original, { recursive: true });
  ({ viewer } = await open(linePath)); viewer.close();
  await waitFor(() => viewer.isDestroyed(), "closure without original project");
  if (process.env.YN_HTML_CLOSE_FIXTURE) {
    const fixtureRoot = path.join(temp, "large-pages");
    const fixtureHtmlDir = path.join(fixtureRoot, ".translation-workshop", "html");
    await mkdir(fixtureHtmlDir, { recursive: true });
    const inputs = JSON.parse(process.env.YN_HTML_CLOSE_FIXTURE) as string[];
    for (const input of inputs) {
      const copiedHtml = path.join(fixtureHtmlDir, path.basename(input));
      await cp(input, copiedHtml);
      const opened = await open(copiedHtml);
      viewer = opened.viewer;
      opened.view.webContents.setBackgroundThrottling(true);
      viewer.webContents.setBackgroundThrottling(true);
      viewer.on("close", () => console.log("[native-close] close event", inputs.length));
      const evaluate = opened.view.webContents.executeJavaScript.bind(opened.view.webContents);
      opened.view.webContents.executeJavaScript = (async (code: string, ...args: any[]) => {
        console.log("[native-close] evaluation requested", code.includes("flushTranslationWorkshop"));
        const value = await evaluate(code, ...args);
        console.log("[native-close] evaluation settled", code.includes("flushTranslationWorkshop"));
        return value;
      }) as typeof evaluate;
    }
    const started = Date.now();
    const handle = viewer.getNativeWindowHandle().readBigUInt64LE().toString();
    const command = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class YnNativeCloseFixture { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam); }'; if (-not [YnNativeCloseFixture]::PostMessage([IntPtr]::new(${handle}), 0x112, [IntPtr]::new(0xF060), [IntPtr]::Zero)) { exit 1 }`;
    await new Promise<void>((resolve, reject) => {
      const sender = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: "ignore" });
      sender.on("error", reject);
      sender.on("close", code => code === 0 ? resolve() : reject(new Error(`Fixture native close message failed: ${code}`)));
    });
    await waitFor(() => viewer.isDestroyed(), "native close with real large inactive/active pages and production throttling");
    console.log(JSON.stringify({ realHtmlNativeClose: true, elapsedMs: Date.now() - started }));
  }
  assert(BrowserWindow.getAllWindows().every(win => !win.isVisible()), "Verifier opened a visible window");
  console.log(JSON.stringify({ ok: true, portableHtml: true, queuedEditPreserved: true, nativeTabAndWindowClose: true, stopIndependentOfSave: true, activeNativeRuntimeStopped: true, errorsVisible: true, nativeHistoriesRetained: true }));
}
void app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  await rm(temp, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
});
