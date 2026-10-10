import { app, BrowserWindow, type WebContents } from "electron";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { piNativeSessionService, type PiNativeSessionServiceOptions } from "../src/main/agent/piNative/sessionService.ts";
import { patchProjectState, readProjectState } from "../src/main/projectState.ts";
import { readProjectAssets } from "../src/main/agent/projectAssets.ts";
import { writeProviderConfig } from "../src/main/agent/providerConfigStore.ts";
import { builtinTaskDefaults } from "../src/shared/builtinTasks.ts";
import { resolveProofreadReportPath } from "../src/main/agent/writeProofreadFindings.ts";
import { resolveTranslationCandidatePath } from "../src/main/agent/writeTranslationChunk.ts";
import { createZipBuffer } from "../src/main/zipWriter.ts";

const root = process.cwd();
const fixture = await mkdtemp(path.join(os.tmpdir(), "yn-electron-builtin-"));
const sourcePath = path.join(fixture, "source.txt");
const original = String.raw`<WAIT>Hello/nworld.\nNext.`;
const initialTranslation = String.raw`<WAIT>你好/n世界。\n下一句。`;
const fixedTranslation = String.raw`<WAIT>你好，/n世界。\n下一句。`;
const screenshotDir = path.join(root, "artifacts", "verification");
await mkdir(screenshotDir, { recursive: true }); await writeFile(sourcePath, original);
app.setAppPath(root); app.disableHardwareAcceleration();
const provider = fauxProvider({ tokensPerSecond: 1_000_000, tokenSize: { min: 100_000, max: 100_000 } });
const models = createModels(); models.setProvider(provider.provider);
const requests: any[] = [];
const rules = [{ label: "WAIT command", pattern: "^<WAIT>", flags: "u" }, { label: "Literal line breaks", pattern: String.raw`/n|\\n`, flags: "u" }];
function referenceResponses(finalText: string) {
  const last = (context: any) => {
    const message = context.messages.filter((message: any) => message.role === "toolResult").at(-1);
    assert(!message.isError, `Reference tool failed: ${JSON.stringify(message.content)}`);
    return JSON.parse(message.content.find((block: any) => block.type === "text").text);
  };
  const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as any, { id: name }), { stopReason: "toolUse" });
  return [
    call("importTaskAssets", { glossary: [{ source: "Alice", target: "wrong" }, { source: "Noise", target: "remove" }], characters: [{ name: "Alice", target: "wrong", voice: "wrong" }] }),
    (context: any) => { assert(last(context).status === "draft", "Initial reference import must remain a draft"); return call("importTaskAssets", { glossary: [{ source: "Alice", target: "爱丽丝" }], characters: [{ name: "Alice", target: "爱丽丝", voice: "calm" }] }); },
    (context: any) => call("deleteTaskAssetDraftEntries", { kind: "glossary", keys: ["Noise"], expectedRevision: last(context).revision }),
    (context: any) => { last(context); return call("readTaskAssetDraft", { kind: "glossary" }); },
    (context: any) => { assert(last(context).entries[0].target === "爱丽丝", "Draft correction must replace the wrong target"); return call("readTaskAssetDraft", { kind: "characters" }); },
    (context: any) => call("checkTaskAssetDraft", { expectedRevision: last(context).revision, reviewSummary: "Reviewed Alice against the supplied reference and removed Noise." }),
    (context: any) => { assert(last(context).status === "checked", "Reference draft must be checked before formal commit"); return call("commitTaskAssets", { expectedRevision: last(context).revision }); },
    (context: any) => { assert(last(context).status === "committed", "Both reference assets must be formally committed"); return fauxAssistantMessage(fauxText(finalText)); }
  ];
}
// Constructor dependency substitution exists only in this verifier. Product Host,
// IPC, navigation, scanner, settings and application paths remain unchanged.
const options = (piNativeSessionService as unknown as { options: PiNativeSessionServiceOptions }).options;
options.createModelSelection = async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id });
options.createTools = context => {
  requests.push(context.request);
  return [{ name: "completeFixtureWorkflow", label: "Complete verifier fixture", description: "Provide native completion evidence for this single-line faux fixture.", parameters: Type.Object({}), async execute() {
    const request = context.request; const domain = context.domainRun!; const documentId = path.basename(request.sourcePath!);
    const documents = request.folderSourceDocuments ?? [{ id: documentId, path: request.sourcePath! }];
    domain.recordInspection({ sourceLineCount: documents.length, glossaryCandidateExists: true, characterBibleExists: true,
      ...(request.sourceSelection?.kind === "folder" ? { documents: documents.map(document => ({ id: document.id, sourceLineCount: 1 })) } : {}) });
    if (request.workflowIntent === "translation") {
      for (const document of documents) {
        if (request.sourceSelection?.kind === "folder") domain.selectDocument(document.id);
        const target = resolveTranslationCandidatePath({ outputDir: request.outputDir, sourcePaths: [document.path], documentId: document.id });
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, initialTranslation);
        domain.recordTranslationWrite("translation"); domain.recordTranslationValidation("translation", 0,
          request.sourceSelection?.kind === "folder" ? document.id : undefined);
      }
    } else {
      const reportPath = resolveProofreadReportPath({ outputDir: request.outputDir, sourcePaths: [request.sourcePath!], documentId, kind: "findings_json" });
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify({ schemaVersion: "1.0", documentId, sourcePath: request.sourcePath,
        translationPath: request.translationPath, generatedAt: new Date().toISOString(), mode: "split", findings: [{ id: "fixture-finding", severity: "major", type: "H3", sourceLine: 1, translationLine: 1,
          sourceText: original, currentTranslation: initialTranslation, suggestedFix: fixedTranslation, rationale: "Translate world explicitly." }] }));
      domain.recordProofreadPrescan(); domain.recordSourceRead(); domain.recordTranslationRead();
      domain.recordProofreadParentRead("source", 1, 1); domain.recordProofreadParentRead("translation", 1, 1); domain.recordProofreadParentSemanticReview(1, 1);
      domain.recordProofreadArtifactMutation(); domain.recordProofreadRangeValidated(domain.activeDocumentId!, 1, 1); domain.recordProofreadReportFinalized();
    }
    assert(domain.incompleteReasons().length === 0, `Fixture evidence incomplete: ${domain.incompleteReasons()}`);
    return { content: [{ type: "text", text: "accepted fixture" }], details: { accepted: true } };
  } }];
};
await import("../src/main/main.ts");

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout; let value: T;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timeout: ${label}; last=${JSON.stringify(value!)}`);
}
async function screenshot(contents: WebContents, name: string): Promise<void> {
  const attach = !contents.debugger.isAttached(); if (attach) contents.debugger.attach("1.3");
  try { const result = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true }) as { data: string };
    await writeFile(path.join(screenshotDir, name), Buffer.from(result.data, "base64")); }
  finally { if (attach && contents.debugger.isAttached()) contents.debugger.detach(); }
}
async function viewFor(file: string) {
  return waitFor(() => BrowserWindow.getAllWindows().flatMap(window => window.getBrowserViews()).find(view => view.webContents.getURL() === new URL(`file:///${file.replace(/\\/g, "/")}`).href), Boolean, `HTML ${file}`);
}
async function terminal(sessionId: string, projectDir = fixture) {
  const state = await waitFor(() => piNativeSessionService.getRunState(projectDir, sessionId), state => !state.running, "native task completion");
  if (state.error) {
    const errors = (await piNativeSessionService.loadMessages(projectDir, sessionId)).filter((message: any) => message.role === "toolResult" && message.isError);
    console.error("[builtin-verifier] native-tool-failures", JSON.stringify(errors.map((message: any) => ({ tool: message.toolName, content: message.content }))));
  }
  assert(!state.error, `Native task failed: ${state.error}`);
}
async function start(main: BrowserWindow, task: string, settings: unknown, autoApply?: boolean) {
  return main.webContents.executeJavaScript(`window.workshop.startBuiltinTask(${JSON.stringify({ task, settings, autoApplyProofreadSuggestions: autoApply })})`) as Promise<{ outputPath: string; sessionId: string }>;
}
async function run() {
  const main = await waitFor(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("renderer/index.html")), Boolean, "actual product renderer");
  await waitFor(() => main!.webContents.executeJavaScript("Boolean(window.workshop?.startBuiltinTask)").catch(() => false), Boolean, "task IPC bridge");
  await waitFor(() => main!.webContents.executeJavaScript("Boolean(document.querySelector('.builtinTaskCards .builtinTaskCard .builtinTaskButton'))").catch(() => false), Boolean, "homepage built-in task actions");
  // A fresh homepage must configure the same global provider without a project or HTML.
  const globalConfig = await main!.webContents.executeJavaScript(`(async () => {
    await window.workshop.getAgentProviderConfig({ outputDir: "" });
    const config = await window.workshop.saveAgentProviderConfig({ outputDir: "", provider: {
      id: "xai-api", type: "openai_compatible", name: "xAI API", baseUrl: "https://api.x.ai/v1",
      piProviderId: "xai", model: "grok-4.6", enabled: true, auth: { kind: "api_key", key: "verifier-fake-key" }
    }});
    const projectConfig = await window.workshop.getAgentProviderConfig({ outputDir: ${JSON.stringify(fixture)} });
    const descriptors = await window.workshop.listAgentProviders({ outputDir: "" });
    const globalRead = await window.workshop.getAgentProviderConfig({ outputDir: "" });
    return { shared: JSON.stringify(globalRead) === JSON.stringify(projectConfig), active: config.activeProviderId,
      configured: descriptors.some(provider => provider.id === "xai-api" && provider.enabled) };
  })()`);
  assert(globalConfig.shared && globalConfig.active === "xai-api" && globalConfig.configured, `Projectless provider settings must share the global store: ${JSON.stringify(globalConfig)}`);
  for (const locale of ["zh-CN", "en-US"] as const) {
    await main!.webContents.executeJavaScript(`(() => { [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(locale === "zh-CN" ? "中文" : "English")}).click(); })()`);
    await waitFor(() => main!.webContents.executeJavaScript("document.documentElement.lang"), value => value === locale, "homepage language");
    await main!.webContents.executeJavaScript("document.querySelector('.homepageProviderButton').click()");
    await waitFor(() => main!.webContents.executeJavaScript("Boolean(document.querySelector('.homepageProviderDialog[open] .ynAgentProviderFields select option'))"), Boolean, "homepage provider model selector");
    await main!.webContents.executeJavaScript("document.querySelector('.homepageProviderDialog .ynAgentProviderActions .primary').click()");
    await waitFor(() => main!.webContents.executeJavaScript("document.querySelector('.homepageProviderDialog .ynAgentProviderFooter')?.textContent"), value => /Saved\.|已保存/.test(value || ""), "homepage provider save");
    const savedHomepageModel = await main!.webContents.executeJavaScript("window.workshop.getAgentProviderConfig({outputDir:''}).then(config => config.providers['xai-api'].model)");
    assert(savedHomepageModel === "grok-4.6", "Opening and saving settings must preserve the selected model");
    await screenshot(main!.webContents, `homepage-provider-${locale === "zh-CN" ? "zh" : "en"}.png`);
    await main!.webContents.executeJavaScript("document.querySelector('.homepageProviderDialog .ynAgentProviderSettingsHeader button').click()");
    await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskCards .builtinTaskCard .builtinTaskButton').click()");
    await waitFor(() => main!.webContents.executeJavaScript("Boolean(document.querySelector('[role=dialog] #builtinTaskDialogTitle'))"), Boolean, "settings dialog");
    const numbers = await main!.webContents.executeJavaScript("[...document.querySelectorAll('[role=dialog] label')].map(label => ({ text:label.textContent, value:label.querySelector('input[type=number]')?.value }))");
    assert(numbers.some((item: any) => /每块行数|Lines per chunk/.test(item.text) && item.value === "500"), "Dialog chunk default must be 500");
    assert(numbers.some((item: any) => /Agent|工作|worker|并发/.test(item.text) && item.value === "3"), "Dialog worker default must be 3");
    assert(!numbers.some((item: any) => /按行分块处理|Process in line chunks/.test(item.text)), "Task dialog must not expose the obsolete split switch");
    await screenshot(main!.webContents, `builtin-settings-${locale === "zh-CN" ? "zh" : "en"}.png`);
    await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskClose').click()");
  }
  await writeProviderConfig(fixture, { activeProviderId: "custom-api", providers: { "custom-api": { id: "custom-api", type: "openai_compatible", name: "Verifier faux only", model: "fixture", models: ["fixture"], baseUrl: "http://127.0.0.1:1/v1", enabled: true } } });
  // Reproduce the prior homepage's optional folder field reaching single-file IPC.
  const settings = { ...builtinTaskDefaults({ outputDir: fixture, sourcePath, languagePair: "en->zh-CN", glossaryCandidates: false, characterBible: false, customPreserveRules: rules }), folderSourceDocuments: [] };
  assert(settings.splitSize === 500 && settings.subagentCount === 3, "New task defaults must be 500/3");
  let releasePreparation!: () => void;
  const preparationReady = new Promise<void>(resolve => { releasePreparation = resolve; });
  provider.setResponses([
    async () => { await preparationReady; return fauxAssistantMessage(fauxToolCall("inspectTaskSettings", {}, { id: "parameters" }), { stopReason: "toolUse" }); },
    context => {
      const message = context.messages.filter(message => message.role === "toolResult").at(-1)!;
      assert(!message.isError, "Shared parameter inspection must succeed");
      const parameters = JSON.parse(message.content.find(block => block.type === "text")!.text);
      assert(parameters.settingsPath === path.join(fixture, ".translation-workshop", "project.json"), "Agent must receive the shared internal parameter path");
      return fauxAssistantMessage(fauxToolCall("updateTaskSettings", { settings: { style: "concise game dialogue" }, reason: "Reference describes game dialogue rather than the previous domain." }, { id: "correct-parameters" }), { stopReason: "toolUse" });
    },
    context => {
      const message = context.messages.filter(message => message.role === "toolResult").at(-1)!;
      assert(!message.isError, "Shared parameter update must succeed");
      return fauxAssistantMessage(fauxToolCall("inspectTaskSources", {}, { id: "scan" }), { stopReason: "toolUse" });
    },
    context => { const results = context.messages.filter(message => message.role === "toolResult"); const report = JSON.parse(results.at(-1)!.content.find(block => block.type === "text")!.text);
      assert(report.candidates.some((candidate: any) => candidate.examples.some((example: any) => example.match === "<WAIT>")), "Real source scanner must return matched code examples");
      assert(report.candidates.some((candidate: any) => candidate.label === "literal newline/tab escape" && candidate.matchCount === 2), "Literal /n and backslash n must be detected");
      assert(report.files[0].samples[0].text === original, "Parameter inspection must receive representative source prose");
      return fauxAssistantMessage(fauxToolCall("inspectTaskSources", { rules }, { id: "trial" }), { stopReason: "toolUse" }); },
    fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", { customPreserveRules: rules }, { id: "launch" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeFixtureWorkflow", {}, { id: "translate" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Fixture translated."))
  ]);
  const translation = await start(main!, "translation", settings);
  const preparationView = await viewFor(translation.outputPath);
  await waitFor(() => preparationView!.webContents.executeJavaScript("Boolean(document.querySelector('.row .target'))").catch(() => false), Boolean, "preparation review row");
  const preparationEdit = "<WAIT>准备阶段编辑。";
  await preparationView!.webContents.executeJavaScript(`(() => { const target = document.querySelector('.row .target'); target.textContent = ${JSON.stringify(preparationEdit)}; target.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const reviewStateDir = path.join(fixture, ".translation-workshop", "state");
  await waitFor(async () => { try { return (await Promise.all((await readdir(reviewStateDir)).filter(file => file.startsWith("line-") && file.endsWith(".json")).map(file => readFile(path.join(reviewStateDir, file), "utf8")))).some(text => text.includes(preparationEdit)); } catch { return false; } }, Boolean, "preparation edit persisted in actual sidecar");
  releasePreparation(); await terminal(translation.sessionId);
  assert((await readProjectState(fixture)).lastLineReviewHtml === translation.outputPath, "Preparation and workflow handoff must reuse one review HTML path");
  await waitFor(() => preparationView!.webContents.executeJavaScript("document.querySelector('.row .target')?.textContent").catch(() => ""), value => value === preparationEdit, "preparation edit retained after workflow handoff reload");
  await preparationView!.webContents.executeJavaScript("(async () => { document.querySelector('.row .target').focus(); document.getElementById('restore').click(); await window.flushTranslationWorkshopLineReviewState(); })()");

  assert(requests.at(-1).prompt.startsWith("Workflow: yn-translation-v1."), "Translation must use full native Workflow marker");
  assert(requests.at(-1).translationSplitSize === 500 && requests.at(-1).subagentCount === 3, "Default settings must reach native full workflow");
  assert((await readProjectState(fixture)).customPreserveRules?.[0].pattern === rules[0].pattern, "Trialed preservation regex must be saved");
  assert(await readFile(sourcePath, "utf8") === original, "Source must remain unchanged");
  const translatedPath = resolveTranslationCandidatePath({ outputDir: fixture, sourcePaths: [sourcePath], documentId: path.basename(sourcePath) });
  const translationView = await viewFor(translation.outputPath);
  await waitFor(() => translationView!.webContents.executeJavaScript("Boolean(window.__ynAgentChatPiWebEmbedded && document.querySelector('#characterBibleToggle'))").catch(() => false), Boolean, "actual embedded Agent and character table");
  const launchedRequest = requests.at(-1);
  const packet = await translationView!.webContents.executeJavaScript("window.translationWorkshopTaskParameters.prepare('translate')");
  assert(packet.metadata.folderSourceDocuments === undefined && launchedRequest.folderSourceDocuments === undefined, "Single-file HTML and native handoff must omit inactive folder metadata");
  assert(packet.prompt === launchedRequest.prompt, "One-click launch must use byte-for-byte the HTML parameter prompt");
  for (const key of Object.keys(packet.metadata)) assert(JSON.stringify(packet.metadata[key]) === JSON.stringify(launchedRequest[key]), `Shared HTML metadata differs: ${key}`);
  assert(packet.settings.style === "concise game dialogue" && launchedRequest.style === packet.settings.style, "Style must be one shared parameter");
  await translationView!.webContents.executeJavaScript("document.getElementById('translatePrompt').click(); document.getElementById('applyPromptSettings').click()");
  await waitFor(() => translationView!.webContents.executeJavaScript("document.getElementById('promptSettingsPanel').hidden && document.getElementById('promptPreview').value"), value => value === launchedRequest.prompt, "manual Generate prompt equals one-click prompt");
  await screenshot(translationView!.webContents, "builtin-translation-agent.png");
  console.log("[builtin-verifier] translation-native-scan-trial-completed");
  let rejected = false; try { await start(main!, "proofread", { ...settings, translationPath: "" }); } catch (error) { rejected = /existing translation/.test(String(error)); }
  assert(rejected, "Missing translation must reject before proofreading starts");
  provider.setResponses([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "proof-start" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeFixtureWorkflow", {}, { id: "proof-finish" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Fixture proofread."))]);
  const proofread = await start(main!, "proofread", { ...settings, translationPath: translatedPath, splitSize: 37 }, true); await terminal(proofread.sessionId);
  assert(requests.at(-1).proofreadSplitSize === 37, "Edited settings must reach native proofreading");
  assert(requests.at(-1).prompt.includes("same structural preservation requirements as translation"), "Built-in proofreading must receive structural preservation instructions");
  assert(requests.at(-1).prompt.includes("required structure, not prose errors"), "Control symbols must not be diagnosed as prose errors");
  assert(requests.at(-1).customPreserveRules?.[0].pattern === rules[0].pattern && requests.at(-1).prompt.includes(rules[0].pattern), "The actual preservation rule must reach proofreading metadata and prompt");
  assert(await readFile(translatedPath, "utf8") === initialTranslation, "Auto-application must never write TXT");
  const state = await readProjectState(fixture); assert(state.lastProposalReviewHtml, "Completion must open final report");
  const stateDir = path.join(fixture, ".translation-workshop", "state");
  const sidecars = await readdir(stateDir);
  const sidecarTexts = await Promise.all(sidecars.filter(file => file.startsWith("line-") && file.endsWith(".json")).map(file => readFile(path.join(stateDir, file), "utf8")));
  assert(sidecarTexts.some(text => Object.values(JSON.parse(text).edits ?? {}).includes(fixedTranslation)), "Auto-application must update HTML review sidecar");
  const reportView = await viewFor(String(state.lastProposalReviewHtml)); await screenshot(reportView!.webContents, "builtin-proofread-report.png");
  console.log("[builtin-verifier] proofread-report-html-only-application-completed");
  provider.setResponses(referenceResponses("Assets imported."));
  const beforeAssets = await readProjectState(fixture);
  const assets = await start(main!, "assets", { ...settings, sourcePath: path.join(fixture, "missing-optional-material-source.txt") }); await terminal(assets.sessionId);
  const afterAssets = await readProjectState(fixture);
  for (const key of ["sourcePath", "translationPath", "translationBindingOrigin", "builtinTaskTranslationPath", "builtinTaskInputSettings", "lastLineReviewHtml", "lastProposalReviewHtml"]) {
    assert(JSON.stringify(afterAssets[key]) === JSON.stringify(beforeAssets[key]), `Assets task must preserve canonical binding ${key}`);
  }
  assert((await readProjectAssets({ outputDir: fixture })).characterBible.characters.some(character => character.name === "Alice"), "Structured native asset import must persist");
  await translationView!.webContents.executeJavaScript("document.getElementById('characterBibleToggle').click()");
  await waitFor(() => translationView!.webContents.executeJavaScript("document.querySelector('#characterBibleRows')?.textContent"), value => String(value).includes("Alice"), "character table load");
  await translationView!.webContents.executeJavaScript("document.querySelector('#characterBibleRows button').click(); document.querySelector('[data-character-field=voice]').value='precise'; document.getElementById('characterBibleSave').click()");
  await waitFor(() => translationView!.webContents.executeJavaScript("document.querySelector('#characterBibleRows')?.textContent"), value => String(value).includes("precise"), "saved character voice renders");
  await screenshot(translationView!.webContents, "builtin-character-table-zh.png");
  const en = await main!.webContents.executeJavaScript(`window.workshop.generateLineReview(${JSON.stringify({ ...settings, translationPath: translatedPath, locale: "en-US", advanced: settings })})`);
  await main!.webContents.executeJavaScript(`window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: en.outputPath, outputDir: fixture })})`);
  const englishView = await viewFor(en.outputPath); await englishView!.webContents.executeJavaScript("document.getElementById('characterBibleToggle').click()");
  await waitFor(() => englishView!.webContents.executeJavaScript("document.querySelector('#characterBibleRows')?.textContent"), value => String(value).includes("precise"), "English character table");
  assert(await englishView!.webContents.executeJavaScript("document.querySelector('#characterBibleTitle').textContent === 'Character bible'"), "English table labels must render");
  await screenshot(englishView!.webContents, "builtin-character-table-en.png");
  // Record real tab disposal. The independent raw Electron baseline in the
  // launcher attributes retained closed listeners to the installed BrowserView API.
  const viewer = BrowserWindow.getAllWindows().find(window => window.getBrowserViews().some(view => view.webContents.id === englishView!.webContents.id))!;
  const resizeListenersBefore = viewer.listenerCount("resize");
  const closedListenersBefore = viewer.listenerCount("closed");
  const unusedKeys = await viewer.webContents.executeJavaScript("[...document.querySelectorAll('#tabs button[data-key]:not(.active)')].map(button => button.dataset.key)");
  for (const key of unusedKeys) await viewer.webContents.executeJavaScript(`window.workshopTabs.close(${JSON.stringify(key)})`);
  assert(viewer.listenerCount("resize") < resizeListenersBefore, "Closing actual HTML tabs must release BrowserView resize listeners");
  console.log(JSON.stringify({ htmlTabDisposal: { resizeBefore: resizeListenersBefore, resizeAfter: viewer.listenerCount("resize"), closedBefore: closedListenersBefore, closedAfter: viewer.listenerCount("closed") } }));
  const bilingualPath = path.join(fixture, "paired.txt");
  const bilingualText = `${initialTranslation}\n${original}`; await writeFile(bilingualPath, bilingualText);
  provider.setResponses([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "bilingual-proof-start" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeFixtureWorkflow", {}, { id: "bilingual-proof-finish" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Bilingual fixture proofread."))]);
  const bilingual = await start(main!, "proofread", { ...settings, sourcePath: bilingualPath, translationPath: bilingualPath, inputMode: "bilingual", sourcePosition: 2, translationPosition: 1 }, true);
  await terminal(bilingual.sessionId);
  assert(requests.at(-1).sourcePath !== bilingualPath && requests.at(-1).translationPath !== bilingualPath, "Bilingual task must bind separate native UTF-8 source/target files");
  assert(await readFile(bilingualPath, "utf8") === bilingualText, "Bilingual source/translation input must remain unchanged after auto-apply");
  assert(await readFile(requests.at(-1).translationPath, "utf8") === initialTranslation, "Bilingual canonical TXT must remain unchanged after auto-apply");
  const folderSource = path.join(fixture, "epub-source");
  const epubPath = path.join(folderSource, "chapter", "物語.epub"); await mkdir(path.dirname(epubPath), { recursive: true });
  const epubBytes = createZipBuffer([
    { path: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
    { path: "META-INF/container.xml", data: Buffer.from('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>') },
    { path: "EPUB/package.opf", data: Buffer.from('<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>') },
    { path: "EPUB/chapter.xhtml", data: Buffer.from(`<html><body><p>${original.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p></body></html>`) }
  ]); await writeFile(epubPath, epubBytes);
  provider.setResponses([fauxAssistantMessage(fauxToolCall("inspectTaskSources", {}, { id: "epub-scan" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspectTaskSources", { rules }, { id: "epub-trial" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", { customPreserveRules: rules }, { id: "epub-start" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeFixtureWorkflow", {}, { id: "epub-translate" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("EPUB folder fixture translated."))]);
  const folder = await start(main!, "translation", { ...settings, sourcePath: folderSource, sourceKind: "folder", inputMode: "separate", fileType: "epub", translationPath: "", subagentEnabled: false });
  await terminal(folder.sessionId);
  const folderRequest = requests.at(-1); const projected = folderRequest.folderSourceDocuments?.[0];
  assert(projected?.id === "chapter/物語.epub" && projected.path.endsWith("物語.txt"), "EPUB folder retains original native document ID and extracted UTF-8 path");
  assert(await readFile(projected.path, "utf8") === original, "EPUB projection must contain source text only");
  assert((await readFile(epubPath)).equals(epubBytes), "Original EPUB bytes must remain unchanged");
  const epubTarget = path.join(fixture, "AI_translation", "chapter", "物語_translated.txt");
  assert(await readFile(epubTarget, "utf8") === initialTranslation, "EPUB folder candidate must use canonical TXT routing");
  const folderView = await viewFor(folder.outputPath);
  // A saved blank project field must not erase the generated folder manifest.
  // Replay that project update through the same settings IPC.
  await main!.webContents.executeJavaScript(`window.workshop.saveProject(${JSON.stringify(fixture)}, {folderTranslationOrder: ""})`);
  const folderParameters = await folderView!.webContents.executeJavaScript("(() => { const child = document.getElementById('fileFrame').contentWindow; child.document.getElementById('translatePrompt').click(); return child.document.getElementById('promptFolderTranslationOrder').value; })()");
  assert(folderParameters === '{\n"chapter/物語.epub"\n}', `Folder order must initialize all manifest filenames inside braces, got: ${JSON.stringify(folderParameters)}`);
  assert(folderRequest.folderTranslationOrder === folderParameters, "Initialized folder order must reach the native prompt metadata");
  assert(await folderView!.webContents.executeJavaScript("!document.getElementById('fileFrame').contentDocument.getElementById('promptSplit')"), "Generated folder HTML must not expose the obsolete split switch");
  const explicitOrder = '"chapter/物語.epub"';
  await main!.webContents.executeJavaScript(`window.workshop.saveProject(${JSON.stringify(fixture)}, {folderTranslationOrder: ${JSON.stringify(explicitOrder)}})`);
  const explicitPacket = await folderView!.webContents.executeJavaScript("document.getElementById('fileFrame').contentWindow.translationWorkshopTaskParameters.prepare('translate')");
  assert(explicitPacket.metadata.folderTranslationOrder === explicitOrder && explicitPacket.prompt.includes(explicitOrder), "Explicit file order must survive synchronization and enter the shared prompt");
  await screenshot(folderView!.webContents, "builtin-folder-epub.png");
  const folderEdit = "<WAIT>文件夹待保存编辑。";
  await waitFor(() => folderView!.webContents.executeJavaScript("Boolean(document.getElementById('fileFrame')?.contentDocument?.querySelector('.row .target'))").catch(() => false), Boolean, "folder iframe actual line editor");
  await folderView!.webContents.executeJavaScript(`(() => { const child = document.getElementById('fileFrame').contentWindow; const originalFlush = child.flushTranslationWorkshopLineReviewState; child.flushTranslationWorkshopLineReviewState = async () => { await new Promise(resolve => setTimeout(resolve, 80)); const target = child.document.querySelector('.row .target'); target.textContent = ${JSON.stringify(folderEdit)}; target.dispatchEvent(new child.Event('input', {bubbles:true})); return originalFlush(); }; })()`);
  const folderWindow = BrowserWindow.getAllWindows().find(window => window.getBrowserViews().some(view => view.webContents.id === folderView!.webContents.id))!;
  await folderWindow.webContents.executeJavaScript("window.workshopTabs.close(document.querySelector('#tabs button[data-key].active').dataset.key)");
  const folderSidecars = await Promise.all((await readdir(stateDir)).filter(file => file.startsWith("line-") && file.endsWith(".json")).map(file => readFile(path.join(stateDir, file), "utf8")));
  assert(folderSidecars.some(text => text.includes(folderEdit)), "Closing folder HTML must await iframe pending editor flush");
  assert(await readFile(epubTarget, "utf8") === initialTranslation, "Folder iframe edit flush must never write canonical TXT");
  const materialsProject = path.join(fixture, "materials-first", "new-project");
  // Reproduce a project selected and autosaved before references are prepared.
  // Previously only the absent-property state was covered, masking this failure.
  await patchProjectState(materialsProject, { sourcePath: "", sourceKind: "file", translationPath: "", locale: "en-US" });
  provider.setResponses(referenceResponses("Reference assets ready before translation."));
  await main!.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('.builtinTaskAssetsProjectInput');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(materialsProject)});
    field.dispatchEvent(new Event('input', {bubbles:true}));
    const materials = document.querySelector('.builtinTaskMaterials textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(materials, 'Alice should be translated as 爱丽丝.');
    materials.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskAssetActions .builtinTaskButton').click()");
  await waitFor(() => main!.webContents.executeJavaScript("document.querySelector('.builtinTaskFeedback')?.textContent"), value => /Reference-material task started/.test(value || ''), "create and bind materials-only project from homepage");
  const materialsSession = (await piNativeSessionService.listSessions(materialsProject))[0];
  await terminal(materialsSession.id, materialsProject);
  const materialsWindow = await waitFor(() => BrowserWindow.getAllWindows().find(window => {
    const url = window.webContents.getURL();
    return url.includes("agent-chat-window") && url.includes(encodeURIComponent(materialsProject));
  }), Boolean, "accepted materials Agent window");
  await waitFor(() => materialsWindow!.webContents.executeJavaScript("document.body.innerText"),
    value => value.includes("Reference assets ready before translation."), "materials completion visible in Agent conversation");
  const earlyAssets = await readProjectAssets({ outputDir: materialsProject });
  assert(earlyAssets.glossary.entries.some(entry => entry.source === "Alice") && earlyAssets.characterBible.characters.some(entry => entry.name === "Alice"), "New project must have both assets before translation");
  const materialsState = await readProjectState(materialsProject);
  assert(!materialsState.translationPath && !materialsState.sourcePath, "Materials preparation must not require or invent translation/source files");
  await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskCards .builtinTaskCard .builtinTaskButton').click()");
  assert(await main!.webContents.executeJavaScript(`document.querySelector('.builtinTaskDialog .builtinTaskPathInput input').value === ${JSON.stringify(materialsProject)}`), "Next translation must reuse the materials project");
  await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskClose').click()");
  await screenshot(main!.webContents, "materials-first-project.png");
  // Let prior legitimate autosaves settle before asserting Clear is read-only.
  await new Promise(resolve => setTimeout(resolve, 750));
  const invalidProject = path.join(fixture, "invalid-materials-project");
  await patchProjectState(invalidProject, { sourcePath: 123, sourceKind: "file" });
  const windowsBeforeFailure = BrowserWindow.getAllWindows().length;
  let rejectedInvalidSource = false;
  try { await start(main!, "assets", builtinTaskDefaults({ outputDir: invalidProject })); }
  catch (error) { rejectedInvalidSource = /sourcePath: expected a string/.test(String(error)); }
  assert(rejectedInvalidSource, "Invalid persisted source types must still be rejected");
  assert(BrowserWindow.getAllWindows().length === windowsBeforeFailure, "Rejected materials initialization must not open a blank Agent window");
  const beforeClear = JSON.stringify(await readProjectState(materialsProject));
  const assetsBeforeClear = await readFile(earlyAssets.paths.characterBible, "utf8");
  const providerBeforeClear = await main!.webContents.executeJavaScript("window.workshop.getAgentProviderConfig({outputDir:''}).then(JSON.stringify)");
  await main!.webContents.executeJavaScript("document.querySelector('.clearHomepage').click()");
  await waitFor(() => main!.webContents.executeJavaScript("document.querySelector('.builtinTaskAssetsProjectInput')?.value"), value => value === '', "homepage reset path");
  assert(await main!.webContents.executeJavaScript("document.documentElement.lang === 'en-US' && document.querySelector('.builtinTaskMaterials textarea').value === ''"), "Clear preserves language and clears materials drafts");
  await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskCards .builtinTaskCard .builtinTaskButton').click()");
  const cleared = await main!.webContents.executeJavaScript("[...document.querySelectorAll('.builtinTaskDialog input')].map(input => ({type:input.type,value:input.value}))");
  assert(await main!.webContents.executeJavaScript("[...document.querySelectorAll('.builtinTaskDialog .builtinTaskPathInput input')].every(input => input.value === '')"), `Clear removes previous task paths: ${JSON.stringify(cleared)}`);
  assert(cleared.some((input: any) => input.type === 'number' && input.value === '500') && cleared.some((input: any) => input.type === 'number' && input.value === '3'), "Clear restores 500/3 defaults");
  await main!.webContents.executeJavaScript("document.querySelector('.builtinTaskClose').click()");
  await new Promise(resolve => setTimeout(resolve, 750));
  assert(JSON.stringify(await readProjectState(materialsProject)) === beforeClear, "Clear must not overwrite the saved project");
  assert(await readFile(earlyAssets.paths.characterBible, "utf8") === assetsBeforeClear, "Clear must not modify assets");
  assert(await main!.webContents.executeJavaScript("window.workshop.getAgentProviderConfig({outputDir:''}).then(JSON.stringify)") === providerBeforeClear, "Clear preserves global model configuration");
  console.log(JSON.stringify({ builtinTaskAcceptance: true, sharedWorkflowPrompt: true, parameterPreflight: true, literalEscapePreservation: true, nativePrescan: true, editedSettings: true, proofreadHtmlOnly: true, missingTranslationRejected: true, structuredAssets: true, characterTableEdit: true, bilingualBinding: true, folderEpubBinding: true, stableReviewPath: true, preparationEditRetained: true, folderIframeFlush: true, screenshotDir }));
}
void app.whenReady().then(async () => {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Built-in task Electron verifier timed out")), 120000); })]); }
  finally { if (timer) clearTimeout(timer); }
}).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(async () => {
  await piNativeSessionService.disposeWorkspace(fixture);
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  if (!path.resolve(fixture).startsWith(`${path.resolve(os.tmpdir())}${path.sep}yn-electron-builtin-`)) throw new Error("Unsafe fixture cleanup");
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); app.exit(process.exitCode ?? 0);
});
