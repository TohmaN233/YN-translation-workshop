import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { registerAgentArtifactIpc } from "../src/main/ipc/agentArtifactHandlers.ts";
import { readProjectState, patchProjectState } from "../src/main/projectState.ts";
import { renderLineReviewHtml, LINE_REVIEW_PROTOCOL_MARKER, PROMPT_SETTINGS_VERSION } from "../src/shared/core/html.ts";
import { upgradeLegacyLineReviewHtmlContent } from "../src/shared/core/legacyHtml.ts";
app.disableHardwareAcceleration();
let window: BrowserWindow | undefined;
let project: string | undefined;
async function verify() {
  project = await mkdtemp(path.join(os.tmpdir(), "yn-electron-preservation-"));
  const sourcePath = path.join(project, "source.txt");
  const candidatePath = path.join(project, "AI_translation", "source_translated.txt");
  const rules = [{ pattern: "^[^：:\\r\\n]+[：:]", flags: "u" }];
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, "ソロモン：ここで待っている。\n");
  await writeFile(candidatePath, "ソロモン：在这里等待。\n");
  await patchProjectState(project, { customPreserveRules: rules, languagePair: "ja->zh-CN" });
  registerAgentArtifactIpc();
  ipcMain.handle("project:load", () => readProjectState(project!));
  ipcMain.handle("project:readState", () => readProjectState(project!));
  ipcMain.handle("project:save", (_event, _dir, state) => patchProjectState(project!, state));
  ipcMain.handle("agent-provider:getConfig", () => ({ providers: {}, activeProviderId: "" }));
  ipcMain.handle("agent-provider:list", () => []);
  ipcMain.handle("html:applyLineReviewState", (_event, args) => args.lineState);
  ipcMain.handle("html:persistState", (_event, args) => args.lineState);
  ipcMain.handle("agent-interface:publish", () => ({ accepted: true }));
  const htmlPath = path.join(project, "review.html");
  const current = renderLineReviewHtml({ title: "Preservation acceptance", locale: "zh-CN",
    sourceText: "ソロモン：ここで待っている。", translationText: "ソロモン：在这里等待。", lineReviewPath: htmlPath,
    workflow: { outputDir: project, sourcePath, translationPath: candidatePath,
      promptDefaults: { customPreserveRules: rules, languagePair: "ja->zh-CN" } } });
  const legacy = current.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v44");
  const upgraded = upgradeLegacyLineReviewHtmlContent(legacy);
  assert.ok(upgraded.includes(LINE_REVIEW_PROTOCOL_MARKER));
  assert.ok(upgraded.includes("customPreserveRules: readPromptCustomPreserveRules()"));
  await writeFile(htmlPath, upgraded);
  window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { offscreen: true, preload: path.join(process.cwd(), "dist/main/preload.cjs"), contextIsolation: true } });
  await window.loadFile(htmlPath);
  const args = { projectDir: project, sourcePath, candidatePath, languagePair: "ja->zh-CN" };
  const invoke = (method: string, params: unknown) => window!.webContents.executeJavaScript(`window.workshop.${method}(${JSON.stringify(params)})`);
  assert.equal((await invoke("validateAgentArtifact", args)).ok, true, "saved rules reach actual validator IPC");
  assert.equal((await invoke("buildAgentImportPlan", args)).ok, true, "saved rules reach actual import IPC");
  await writeFile(sourcePath, "ソロモン：\n");
  await writeFile(candidatePath, "ソロモン：\n");
  assert.equal((await invoke("validateAgentArtifact", args)).ok, true, "a fully protected line may stay identical");
  assert.equal((await invoke("validateAgentArtifact", { ...args, customPreserveRules: [] })).ok, false, "explicit empty rules override saved rules");
  await writeFile(sourcePath, "ソロモン：ここで待っている。\n");
  await writeFile(candidatePath, "ソロモン：ここで待っている。\n");
  assert.equal((await invoke("buildAgentImportPlan", args)).ok, false, "unprotected prose cannot be imported untranslated");
  await writeFile(candidatePath, "モンソロ：在这里等待。\n");
  const mismatch = await invoke("validateAgentArtifact", args);
  assert.ok(mismatch.blocking.some((finding: any) => finding.code === "custom_preserve_mismatch"));
  await window.webContents.executeJavaScript("document.querySelector('#promptCustomPreserveRules').scrollIntoView({block:'center'})");
  const screenshot = await window.webContents.capturePage();
  await writeFile(path.join(process.env.YN_RECOVERY_VERIFY_DIR!, "preservation-html.png"), screenshot.toPNG());
  assert.equal(window.isVisible(), false);
  // Run the actual Service + Supervisor + native Pi recovery scenarios in the
  // Electron main process too; faux providers require no external API calls.
  await import(process.env.YN_RECOVERY_VERIFY_TEST!);
  console.log(JSON.stringify({ preservationRecoveryElectron: true, actualArtifactIPC: true, legacyUpgrade: true,
    lineMarker: LINE_REVIEW_PROTOCOL_MARKER, promptSettings: PROMPT_SETTINGS_VERSION, windowVisible: false }));
}
void app.whenReady().then(verify).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  window?.close();
  if (project) await rm(project, { recursive: true, force: true });
  app.quit();
});
