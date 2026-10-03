import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { loadYnSessionHostState, appendYnSessionHostState } from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { patchProjectState } from "../../src/main/projectState.ts";
import { YN_DEFAULT_SPLIT_SIZE, YN_WORKFLOW_SUBAGENT_COUNT } from "../../src/shared/agent/piSessionContract.ts";
import { parsePiSessionPromptRequest } from "../../src/main/ipc/agentSessionRequest.ts";
import { createBuiltinTaskPreparationHost } from "../../src/main/builtinTaskPreparationHost.ts";
import { readProjectAssets } from "../../src/main/agent/projectAssets.ts";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function waitFor(check) {
  const limit = Date.now() + 8000;
  while (!await check()) { if (Date.now() > limit) throw new Error("Timed out waiting for native task state"); await new Promise(r => setTimeout(r, 10)); }
}
async function setup(responses, extraTools = () => []) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-task-preparation-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "Hello.", "utf8");
  const provider = fauxProvider({ tokensPerSecond: 1000000, tokenSize: { min: 100000, max: 100000 } });
  provider.setResponses(responses);
  const models = createModels(); models.setProvider(provider.provider);
  const seenRequests = [];
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }),
    createTools: context => { seenRequests.push(context.request); return extraTools(context); },
    buildSystemPrompt: () => "Execute the selected task.", enforceDomainCompletion: true
  });
  const session = await service.createSession(outputDir);
  const base = { outputDir, sessionId: session.id, sourcePath, providerId: provider.provider.id, modelId: provider.getModel().id, languagePair: "en->zh-CN", subagentEnabled: false };
  return { outputDir, sourcePath, provider, service, session, base, seenRequests,
    async close() { await service.disposeWorkspace(outputDir); await rm(outputDir, { recursive: true, force: true }); } };
}
function host(base, overrides = {}) {
  return { inspectSettings: async () => ({ configured: true }), updateSettings: async () => ({}), inspectSources: async () => ({ examples: [] }), importAssets: async () => ({ status: "draft" }),
    readAssetDraft: async () => ({}), deleteAssetDraftEntries: async () => ({}), checkAssetDraft: async () => ({}), commitAssets: async () => ({ status: "committed" }),
    prepareWorkflow: async context => ({ ...base, workflowIntent: context.intent, prompt: `Workflow: yn-${context.intent}-v1.\nExecute the complete task.` }),
    finishWorkflow: async () => {}, ...overrides };
}
const completeTranslation = context => [{ name: "completeTestTranslation", label: "Complete test translation", description: "Provide complete native domain evidence.", parameters: Type.Object({}), async execute() {
  context.domainRun.recordInspection({ sourceLineCount: 1, glossaryCandidateExists: true, characterBibleExists: true });
  context.domainRun.recordTranslationWrite("translation"); context.domainRun.recordTranslationValidation("translation", 0);
  return { content: [{ type: "text", text: "accepted" }], details: {} };
} }];

assert.equal(YN_DEFAULT_SPLIT_SIZE, 500);
assert.equal(YN_WORKFLOW_SUBAGENT_COUNT, 3);
assert.throws(() => parsePiSessionPromptRequest({ outputDir: "x", sessionId: "s", prompt: "p", providerId: "p", modelId: "m", taskPreparation: { intent: "translation", autoApplyProofreadSuggestions: true } }), /Only proofreading/);

// Saved homepage forms represent an unselected source as an empty string.
// This must remain valid for materials preparation and ordinary conversation.
{
  const env = await setup([fauxAssistantMessage(fauxText("Materials ready."))]);
  env.service.configureTaskPreparationHost(host(env.base));
  try {
    await patchProjectState(env.outputDir, { sourcePath: "", sourceKind: "file", translationPath: "" });
    await env.service.prompt({ ...env.base, sourcePath: undefined, prompt: "Organize references", taskPreparation: { intent: "assets" } });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.ok((await env.service.loadMessages(env.outputDir, env.session.id)).some(message => message.role === "assistant"));
    await patchProjectState(env.outputDir, { sourcePath: 123 });
    await assert.rejects(env.service.prompt({ ...env.base, prompt: "Organize references", taskPreparation: { intent: "assets" } }), /sourcePath: expected a string/);
    await patchProjectState(env.outputDir, { sourcePath: "", sourceKind: "invalid" });
    await assert.rejects(env.service.prompt({ ...env.base, prompt: "Organize references", taskPreparation: { intent: "assets" } }), /sourceKind: expected file or folder/);
  } finally { await env.close(); }
}
console.log("ok materials preparation accepts a saved empty source selection");

// Native preparation is still incomplete after drafting. Cold follow-up keeps
// the same draft ownership and only the explicit checked commit completes it.
{
  const env = await setup([
    fauxAssistantMessage(fauxToolCall("importTaskAssets", { glossary: [{ source: "ウォードバイパー", target: "守卫葺蛇" }], characters: [{ name: "Alice", target: "爱丽丝", gender: "male" }] }, { id: "draft" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Draft retained."))
  ]);
  env.service.configureTaskPreparationHost(createBuiltinTaskPreparationHost({}));
  const detail = context => {
    const last = context.messages.filter(message => message.role === "toolResult").at(-1);
    assert.equal(last.isError, false);
    return JSON.parse(last.content.find(block => block.type === "text").text);
  };
  try {
    await env.service.prompt({ ...env.base, prompt: "Organize references", taskPreparation: { intent: "assets" } });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.equal((await readProjectAssets(env)).available.glossary, false);
    const repo = new PiSessionRepository(env.outputDir); const native = await repo.open(env.session.id);
    const initial = await loadYnSessionHostState(native, env.session.id);
    assert.equal(initial.taskPreparation.completed, undefined);
    const preparationId = initial.taskPreparation.id;
    await repo.closeSession(env.session.id);
    await env.service.disposeWorkspace(env.outputDir);
    env.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("importTaskAssets", { glossary: [{ source: "ウォードバイパー", target: "守卫蝰蛇" }], characters: [{ name: "Alice", gender: "female" }] }, { id: "correct-draft" }), { stopReason: "toolUse" }),
      context => { assert.equal(detail(context).status, "draft"); return fauxAssistantMessage(fauxToolCall("readTaskAssetDraft", { kind: "glossary" }, { id: "read-glossary" }), { stopReason: "toolUse" }); },
      context => { assert.equal(detail(context).entries[0].target, "守卫蝰蛇"); return fauxAssistantMessage(fauxToolCall("readTaskAssetDraft", { kind: "characters" }, { id: "read-characters" }), { stopReason: "toolUse" }); },
      context => { const result = detail(context); assert.equal(result.entries[0].gender, "female"); return fauxAssistantMessage(fauxToolCall("checkTaskAssetDraft", { expectedRevision: result.revision, reviewSummary: "Corrected the mistyped name and verified Alice's gender against reference." }, { id: "check" }), { stopReason: "toolUse" }); },
      context => { const result = detail(context); assert.equal(result.status, "checked"); return fauxAssistantMessage(fauxToolCall("commitTaskAssets", { expectedRevision: result.revision }, { id: "commit" }), { stopReason: "toolUse" }); },
      context => { assert.equal(detail(context).status, "committed"); return fauxAssistantMessage(fauxText("Reference preparation committed.")); }
    ]);
    await env.service.prompt({ ...env.base, prompt: "Continue and correct the draft before committing." });
    await waitFor(async () => (await env.service.loadMessages(env.outputDir, env.session.id)).some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Reference preparation committed.")));
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    const assets = await readProjectAssets(env);
    assert.equal(assets.glossary.entries[0].target, "守卫蝰蛇"); assert.equal(assets.characterBible.characters[0].gender, "female");
    const reopened = await repo.open(env.session.id); const final = await loadYnSessionHostState(reopened, env.session.id);
    assert.equal(final.taskPreparation.id, preparationId); assert.equal(final.taskPreparation.completed, true);
    await repo.closeSession(env.session.id);
  } finally { await env.close(); }
}
console.log("ok draft corrections survive cold native continuation and only checked atomic commit completes materials preparation");

// A conversational answer is idle, never complete. The typed intent/HTML consent
// survives closing and reopening the native session without a second runtime.
{
  const env = await setup([fauxAssistantMessage(fauxText("References can be inspected now."))]);
  let finished = 0;
  env.service.configureTaskPreparationHost(host(env.base, { finishWorkflow: async () => { finished++; } }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare proofreading", taskPreparation: { intent: "proofread", autoApplyProofreadSuggestions: true } });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    await env.service.disposeWorkspace(env.outputDir);
    const repo = new PiSessionRepository(env.outputDir); const native = await repo.open(env.session.id);
    const state = await loadYnSessionHostState(native, env.session.id);
    assert.equal(state.taskPreparation.intent, "proofread"); assert.equal(state.taskPreparation.autoApplyProofreadSuggestions, true);
    assert.equal(state.taskPreparation.started, undefined); assert.equal(finished, 0);
    await repo.closeSession(env.session.id);
  } finally { await env.close(); }
}
console.log("ok task intent and HTML consent persist without treating idle as completion");

// Mixed native tool batches must stop before any following side effect, with no
// extra preparation provider round. The workflow rebinds to saved fresh settings.
{
  let providerCalls = 0; let forbidden = 0; let finished = 0; let imports = 0;
  const env = await setup([
    () => { providerCalls++; return fauxAssistantMessage([fauxToolCall("inspectTaskSettings", {}, { id: "inspect" }), fauxToolCall("startPreparedWorkflow", {}, { id: "start" }), fauxToolCall("forbiddenAfterStart", {}, { id: "after" })], { stopReason: "toolUse" }); },
    () => { providerCalls++; return fauxAssistantMessage(fauxToolCall("completeTestTranslation", {}, { id: "complete" }), { stopReason: "toolUse" }); },
    () => { providerCalls++; return fauxAssistantMessage(fauxText("Translation complete.")); },
    fauxAssistantMessage(fauxText("Ready for a new request."))
  ], context => [...completeTranslation(context), { name: "forbiddenAfterStart", label: "Forbidden", description: "Must not execute after handoff", parameters: Type.Object({}), async execute() { forbidden++; return { content: [{ type: "text", text: "bad" }] }; } }]);
  env.service.configureTaskPreparationHost(host(env.base, {
    inspectSettings: async () => { await patchProjectState(env.outputDir, { style: "fresh saved style", splitSize: 47 }); return {}; },
    prepareWorkflow: async context => { imports++; return { ...env.base, style: "stale", workflowIntent: context.intent, prompt: "Workflow: yn-translation-v1.\nTranslate." }; },
    finishWorkflow: async (context, input) => { assert.equal(context.sessionId, env.session.id); assert.equal(input.autoApplyProofreadSuggestions, false); finished++; }
  }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare translation", taskPreparation: { intent: "translation" } });
    await waitFor(() => finished === 1);
    assert.equal(forbidden, 0); assert.equal(providerCalls, 3); assert.equal(imports, 1);
    assert.equal(env.seenRequests.at(-1).style, "fresh saved style"); assert.equal(env.seenRequests.at(-1).translationSplitSize, 47);
    assert.equal(env.seenRequests.at(-1).sessionId, env.session.id);
    const native = await new PiSessionRepository(env.outputDir).open(env.session.id);
    const state = await loadYnSessionHostState(native, env.session.id);
    assert.equal(state.taskPreparation.completed, true); assert.equal(state.taskPreparation.pendingRequest, undefined);
    await env.service.prompt({ ...env.base, prompt: "Thanks" });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.equal(finished, 1);
  } finally { await env.close(); }
}
console.log("ok preparation starts once, stops mixed tool batch, refreshes settings and finishes only completed domain");

{
  const entered = deferred(); const release = deferred(); let finished = 0;
  const env = await setup([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "stop" }), { stopReason: "toolUse" })]);
  env.service.configureTaskPreparationHost(host(env.base, {
    prepareWorkflow: async context => { entered.resolve(); await release.promise; return { ...env.base, workflowIntent: context.intent, prompt: "Workflow: yn-translation-v1.\nTranslate." }; },
    finishWorkflow: async () => { finished++; }
  }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare translation", taskPreparation: { intent: "translation" } });
    await entered.promise;
    const stopping = env.service.abort(env.outputDir, env.session.id); release.resolve(); await stopping;
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.equal(env.seenRequests.length, 1); assert.equal(finished, 0);
    const native = await new PiSessionRepository(env.outputDir).open(env.session.id);
    const state = await loadYnSessionHostState(native, env.session.id);
    assert.equal(state.taskPreparation.stopped, true); assert.equal(state.taskPreparation.pendingRequest, undefined);
  } finally { await env.close(); }
}
console.log("ok Stop during preparation prevents workflow handoff");

{
  const target = await mkdtemp(path.join(os.tmpdir(), "yn-prepared-new-project-"));
  const targetSource = path.join(target, "new.txt"); await writeFile(targetSource, "New project.");
  let finished = 0; let targetSession = "";
  const env = await setup([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "cross-project" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxToolCall("completeTestTranslation", {}, { id: "new-complete" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("New project complete."))], completeTranslation);
  env.service.configureTaskPreparationHost(host(env.base, {
    prepareWorkflow: async () => ({ ...env.base, outputDir: target, sourcePath: targetSource, workflowIntent: "translation", prompt: "Workflow: yn-translation-v1.\nTranslate new project." }),
    finishWorkflow: async context => { targetSession = context.sessionId; assert.equal(context.outputDir, target); finished++; }
  }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Move preparation to new project", taskPreparation: { intent: "translation" } });
    await waitFor(() => finished === 1);
    assert.notEqual(targetSession, env.session.id);
    const targetBootstrap = await env.service.bootstrap(target); assert.equal(targetBootstrap.activeSessionId, targetSession);
    const messages = await env.service.loadMessages(target, targetSession);
    assert.equal(messages.filter(message => message.role === "user").length, 1, "Previous project transcript must not be transplanted");
    assert.ok(messages.some(message => message.role === "user" && JSON.stringify(message).includes("Preparation handoff")));
  } finally { await env.service.disposeWorkspace(target); await env.close(); await rm(target, { recursive: true, force: true }); }
}
console.log("ok cross-project handoff creates/selects fresh native session with brief and no transplanted transcript");

{
  let attempts = 0;
  const entered = deferred(); const release = deferred();
  const env = await setup([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "retry-start" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeTestTranslation", {}, { id: "retry-complete" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Translation done.")), fauxAssistantMessage(fauxText("Retry the final report."))], completeTranslation);
  env.service.configureTaskPreparationHost(host(env.base, { finishWorkflow: async (_context, _input, signal) => {
    attempts++;
    if (attempts === 1) { entered.resolve(); await release.promise; signal.throwIfAborted(); throw new Error("Fixture report could not open"); }
  } }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare translation", taskPreparation: { intent: "translation" } });
    await entered.promise;
    await assert.rejects(env.service.prompt({ ...env.base, prompt: "overlapping prompt" }), /already running/);
    release.resolve();
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.match((await env.service.getRunState(env.outputDir, env.session.id)).error, /Fixture report/);
    const native = await new PiSessionRepository(env.outputDir).open(env.session.id);
    assert.notEqual((await loadYnSessionHostState(native, env.session.id)).taskPreparation.completed, true);
    await env.service.prompt({ ...env.base, prompt: "Retry opening the final report" });
    await waitFor(async () => attempts === 2 && !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    const retriedNative = await new PiSessionRepository(env.outputDir).open(env.session.id);
    assert.equal((await loadYnSessionHostState(retriedNative, env.session.id)).taskPreparation.completed, true);
    assert.equal(env.seenRequests.length, 3, "Retry must reuse native completion evidence without rerunning preparation or translation");
  } finally { release.resolve(); await env.close(); }
}
console.log("ok failed finish remains incomplete and owned until same-session retry succeeds");

{
  const entered = deferred(); const release = deferred(); let applied = 0;
  const env = await setup([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "finish-stop-start" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeTestTranslation", {}, { id: "finish-stop-complete" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Done."))], completeTranslation);
  env.service.configureTaskPreparationHost(host(env.base, { finishWorkflow: async (_context, _input, signal) => {
    entered.resolve(); await release.promise; signal.throwIfAborted(); applied++;
  } }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare translation", taskPreparation: { intent: "translation" } });
    await entered.promise;
    await env.service.abort(env.outputDir, env.session.id); release.resolve();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(applied, 0);
    const native = await new PiSessionRepository(env.outputDir).open(env.session.id);
    assert.notEqual((await loadYnSessionHostState(native, env.session.id)).taskPreparation.completed, true);
  } finally { release.resolve(); await env.close(); }
}
console.log("ok Stop aborts completion signal before HTML application");

{
  let revalidations = 0;
  const env = await setup([fauxAssistantMessage(fauxText("Preparation paused."))]);
  env.service.configureTaskPreparationHost(host(env.base));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare translation", taskPreparation: { intent: "translation" } });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    await env.service.disposeWorkspace(env.outputDir);
    const repo = new PiSessionRepository(env.outputDir); const native = await repo.open(env.session.id);
    const state = await loadYnSessionHostState(native, env.session.id);
    state.taskPreparation.stopped = false;
    state.taskPreparation.pendingRequest = { ...env.base, workflowIntent: "translation", prompt: "Workflow: yn-translation-v1.\nStale prepared source." };
    await appendYnSessionHostState(native, state); await repo.closeSession(env.session.id);
    env.provider.setResponses([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "cold-revalidate" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Source evidence needs another trial."))]);
    env.service.configureTaskPreparationHost(host(env.base, { prepareWorkflow: async () => { revalidations++; throw new Error("Sources changed after the preservation preview"); } }));
    await env.service.prompt({ ...env.base, prompt: "Continue preparation using the current files" });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.equal(revalidations, 1, "Cold prepared requests must pass fresh Host validation");
    assert.equal(env.seenRequests.length, 2, "Failed revalidation must not launch the old pending request");
    const current = await new PiSessionRepository(env.outputDir).open(env.session.id);
    assert.equal((await loadYnSessionHostState(current, env.session.id)).taskPreparation.pendingRequest, undefined);
  } finally { await env.close(); }
}
console.log("ok cold pending preparation revalidates and failed fresh validation cannot launch stale request");

{
  let finishes = 0; const kinds = [];
  const env = await setup([fauxAssistantMessage(fauxToolCall("startPreparedWorkflow", {}, { id: "other-start" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("completeTestTranslation", {}, { id: "other-complete" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Done.")),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "Fixture new proofread boundary" })], context => { kinds.push(context.domainRun?.kind); return completeTranslation(context); });
  env.service.configureTaskPreparationHost(host(env.base, { finishWorkflow: async () => { finishes++; throw new Error("Fixture final report failed"); } }));
  try {
    await env.service.prompt({ ...env.base, prompt: "Prepare translation", taskPreparation: { intent: "translation" } });
    await waitFor(async () => finishes === 1 && !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    await env.service.prompt({ ...env.base, workflowIntent: "proofread", prompt: "Workflow: yn-proofread-v1.\nStart a different explicit workflow." });
    await waitFor(async () => !(await env.service.getRunState(env.outputDir, env.session.id)).running);
    assert.equal(kinds.at(-1), "proofread", "An explicit other marker must activate its own native contract");
    assert.equal(finishes, 1, "Another workflow must not retry an unrelated completion callback");
    const native = await new PiSessionRepository(env.outputDir).open(env.session.id);
    assert.equal((await loadYnSessionHostState(native, env.session.id)).taskPreparation, undefined, "Old preparation consent must not enter the new workflow");
  } finally { await env.close(); }
}
console.log("ok explicit other workflow detaches failed finish preparation and activates correct contract");
