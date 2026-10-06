import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { registerAgentArtifactIpc } from "../src/main/ipc/agentArtifactHandlers.ts";
import { registerAgentAssetIpc } from "../src/main/ipc/agentAssetHandlers.ts";
import { readProjectState, patchProjectState } from "../src/main/projectState.ts";
import { renderLineReviewHtml, LINE_REVIEW_PROTOCOL_MARKER, PROMPT_SETTINGS_VERSION } from "../src/shared/core/html.ts";
import { upgradeLegacyLineReviewHtmlContent } from "../src/shared/core/legacyHtml.ts";
import { mergeProjectGlossaryEntries, importProjectFormalAssets } from "../src/main/agent/projectAssets.ts";
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
  registerAgentAssetIpc();
  ipcMain.handle("project:load", () => readProjectState(project!));
  ipcMain.handle("project:readState", () => readProjectState(project!));
  ipcMain.handle("project:save", (_event, _dir, state) => patchProjectState(project!, state));
  ipcMain.handle("project:patch", async (_event, args) => {
    await patchProjectState(args.outputDir, args.patch);
    return readProjectState(args.outputDir);
  });
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
  const oldPromptSettings = current.replace(`name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`, 'name="translation-workshop-prompt-settings" content="42"');
  const upgradedPrompts = upgradeLegacyLineReviewHtmlContent(oldPromptSettings);
  assert.ok(upgradedPrompts.includes(`name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`));
  assert.ok(upgradedPrompts.includes("recordTranslationPreservedTerms"), "current-line-marker legacy page receives new terminology prompt instructions");
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
  await mergeProjectGlossaryEntries({ outputDir: project, entries: [{ source: "マユラ", target: "マユラ", status: "confirmed" }] });
  await writeFile(sourcePath, "ソロモン：マユラがここで待っている。\n");
  await writeFile(candidatePath, "ソロモン：マユラ在这里等待。\n");
  const glossaryValidation = await invoke("validateAgentArtifact", args);
  assert.equal(glossaryValidation.ok, true);
  assert.ok(!glossaryValidation.warnings.some((finding: any) => finding.code === "likely_untranslated"));
  assert.equal((await invoke("buildAgentImportPlan", args)).ok, true, "formal source=target terms reach actual import IPC");
  await writeFile(sourcePath, "ソロモン：マユラ\n");
  await writeFile(candidatePath, "ソロモン：マユラ\n");
  assert.equal((await invoke("buildAgentImportPlan", args)).ok, true, "glossary-only prose is a legitimate translation");
  await writeFile(sourcePath, "ソロモン：マユラがここで待っている。\n");
  await writeFile(candidatePath, "ソロモン：マユラがここで待っている。\n");
  assert.equal((await invoke("buildAgentImportPlan", args)).ok, false, "matching names never exempt copied dialogue");
  await importProjectFormalAssets({ outputDir: project, characters: [{ name: "遥娜", target: "遥娜", aliases: ["小遥"] }] });
  await writeFile(sourcePath, "小遥は笑った。\n");
  await writeFile(candidatePath, "她笑了。\n");
  const aliasValidation = await invoke("validateAgentArtifact", args);
  assert.ok(!aliasValidation.warnings.some((finding: any) => finding.code === "character_name_missing"), "actual IPC must not require canonical name for a bible alias");
  await writeFile(sourcePath, "遥娜は笑った。\n");
  const canonicalNameValidation = await invoke("validateAgentArtifact", args);
  assert.ok(canonicalNameValidation.warnings.some((finding: any) => finding.code === "character_name_missing"), "canonical name warning remains available");
  await importProjectFormalAssets({ outputDir: project, glossary: [{ source: "小遥", target: "小遥" }] });
  await writeFile(sourcePath, "小遥は笑った。\n");
  const formalAliasValidation = await invoke("validateAgentArtifact", args);
  assert.ok(formalAliasValidation.warnings.some((finding: any) => finding.code === "glossary_missing"), "explicit formal glossary terms still warn");
  const pageText = await window.webContents.executeJavaScript("document.body.innerText");
  assert.ok(!pageText.includes("Project settings load failed"), "real asset IPC completes legacy page hydration");
  assert.ok(!pageText.includes("Project settings save failed"), "real project IPC completes legacy page persistence");
  await window.webContents.executeJavaScript("document.querySelector('#promptCustomPreserveRules').scrollIntoView({block:'center'})");
  const screenshot = await window.webContents.capturePage();
  await writeFile(path.join(process.env.YN_RECOVERY_VERIFY_DIR!, "preservation-html.png"), screenshot.toPNG());
  assert.equal(window.isVisible(), false);
  // Run the actual Service + Supervisor + native Pi recovery scenarios in the
  // Electron main process too; faux providers require no external API calls.
  await import(process.env.YN_RECOVERY_VERIFY_TEST!);
  await import(process.env.YN_RECOVERY_VERIFY_TERMS_TEST!);
  console.log(JSON.stringify({ preservationRecoveryElectron: true, actualArtifactIPC: true, alignedGlossaryIPC: true, userPreservedTermsNative: true, legacyUpgrade: true,
    lineMarker: LINE_REVIEW_PROTOCOL_MARKER, promptSettings: PROMPT_SETTINGS_VERSION, windowVisible: false }));
}
void app.whenReady().then(verify).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  window?.close();
  if (project) await rm(project, { recursive: true, force: true });
  app.quit();
});
