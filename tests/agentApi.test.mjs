import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentApi, AgentApiError, assertAgentApiTaskSession, settleAgentApiWorkspace } from "../src/main/agentApi.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-agent-api-"));
const sourcePath = path.join(root, "source.txt");
await writeFile(sourcePath, "Hello {name}\nNext");
const model = { providerId: "fixture", modelId: "fixture-medium", thinkingLevel: "medium" };
const state = { sessionId: "pi_fixture", running: false, phase: "idle", sequence: 42, model: null, thinkingLevel: "medium", compacting: false,
  streamingMessage: { secretTranscript: true }, subagentMessages: [{ giantTranscript: true }] };
let project = {}, starts = [], disposed = [], stops = [], resumes = [];
const deps = {
  version: "2.1.10", cwd: root, readProject: async () => project, model: async () => model,
  start: async (request, options) => { options.signal.throwIfAborted(); starts.push(request); options.onSession("pi_fixture"); return { sessionId: "pi_fixture", outputPath: path.join(request.settings.outputDir, "review.html") }; },
  sessions: async () => [{ id: "pi_fixture" }], state: async () => state, lastReply: () => "Done",
  stop: async (...args) => { stops.push(args); }, resume: async (...args) => { resumes.push(args); },
  dispose: async dir => { disposed.push(dir); }
};
const code = (expected) => error => error instanceof AgentApiError && error.code === expected;
try {
  const api = createAgentApi(deps);
  const description = await api.call("describe");
  assert.equal(description.protocolVersion, 1);
  const plan = await api.call("plan", { task: "translation", settings: { sourcePath } });
  assert.equal(plan.settings.outputDir, path.join(root, "Translation"));
  assert.equal(plan.settings.splitSize, 500);
  assert.equal(plan.settings.subagentCount, 3);
  assert.equal(plan.settings.style, "game");
  assert.equal(plan.confirmationRequired, true);
  assert.equal(starts.length, 0);
  await assert.rejects(stat(plan.settings.outputDir), { code: "ENOENT" });
  await assert.rejects(api.call("start", { planId: plan.planId }), code("confirmation_required"));
  await assert.rejects(api.call("start", { planId: plan.planId, confirmed: true, settings: {} }), code("invalid_request"));
  const results = await Promise.all([api.call("start", { planId: plan.planId, confirmed: true }), api.call("start", { planId: plan.planId, confirmed: true })]);
  assert.deepEqual(results[0], results[1]); assert.equal(starts.length, 1);
  const status = await api.call("status", { outputDir: plan.settings.outputDir, sessionId: "pi_fixture" });
  assert.equal(status.lastReply, "Done"); assert.equal(status.streamingMessage, undefined); assert.equal(status.subagentMessages, undefined);
  await assert.rejects(api.call("status", { outputDir: root, sessionId: "foreign" }), code("session_not_found"));
  await api.call("reply", { outputDir: root, sessionId: "pi_fixture", message: "Use this terminology" });
  assert.equal(resumes.at(-1)[4], "Use this terminology");
  await api.call("stop", { outputDir: plan.settings.outputDir, sessionId: "pi_fixture" });
  assert.equal(stops.length, 1);
  await assert.rejects(api.call("start", { planId: plan.planId, confirmed: true }), code("stopped"));
  await api.close(); assert.ok(disposed.includes(plan.settings.outputDir));

  project = { splitSize: 250, subagentCount: 2, style: "novel", arbitraryHostIdentity: "not public" };
  const api2 = createAgentApi(deps);
  const existing = await api2.call("plan", { task: "translation", settings: { sourcePath, outputDir: root, style: "concise" } });
  assert.equal(existing.settings.splitSize, 250); assert.equal(existing.settings.subagentCount, 2);
  assert.equal(existing.settings.style, "concise"); assert.equal(existing.settings.arbitraryHostIdentity, undefined);
  assert.equal(existing.existingProject, true);
  const folderPath = path.join(root, "inputs"); await mkdir(folderPath); await writeFile(path.join(folderPath, "a.txt"), "Hello");
  project = { sourcePath: folderPath, folderTranslationOrder: "{a.txt}", splitSize: 250 };
  const legacyFolder = await api2.call("plan", { task: "translation", settings: { outputDir: root } });
  assert.equal(legacyFolder.settings.sourceKind, "folder"); assert.equal(legacyFolder.settings.folderTranslationOrder, "{a.txt}");
  project = { ...project, style: "changed by user" };
  await assert.rejects(api2.call("start", { planId: existing.planId, confirmed: true }), code("plan_changed"));
  await assert.rejects(api2.call("plan", { task: "translation", settings: { sourcePath, splitSize: 0 } }), code("invalid_request"));
  await assert.rejects(api2.call("plan", { task: "translation", settings: { sourcePath, folderSourceDocuments: [] } }), code("invalid_request"));
  await assert.rejects(api2.call("plan", { task: "translation", settings: { sourcePath, locale: "bogus" } }), code("invalid_request"));
  await assert.rejects(api2.call("plan", { task: "translation", settings: { sourcePath, subagentEnabled: "false" } }), code("invalid_request"));
  await assert.rejects(api2.call("plan", { task: "proofread", settings: { sourcePath } }), /existing translation/);
  const translationPath = path.join(root, "translated.txt"); await writeFile(translationPath, "你好 {name}\n下一句");
  const proofread = await api2.call("plan", { task: "proofread", settings: { sourcePath, translationPath, locale: "en-US" }, autoApplyProofreadSuggestions: true });
  assert.equal(proofread.autoApplyProofreadSuggestions, true); assert.match(proofread.question, /automatically: yes/);
  const assets = await api2.call("plan", { task: "assets", settings: { outputDir: root, materials: "Alice is a mage" } });
  assert.equal(assets.settings.sourcePath, project.sourcePath ?? "");
  await api2.close();

  // EOF/Stop during creation must prevent a late native owner appearing after
  // dispose. Both idempotent shutdown and native cancellation are awaited.
  let release; const gate = new Promise(resolve => { release = resolve; });
  let observedSignal, disposedAfterStart = false, finished = false;
  const api3 = createAgentApi({ ...deps, readProject: async () => ({}), start: async (_request, options) => {
    observedSignal = options.signal; await gate;
    finished = true; options.signal.throwIfAborted();
    throw new Error("unreachable");
  }, dispose: async () => { disposedAfterStart = finished; } });
  const delayed = await api3.call("plan", { task: "translation", settings: { sourcePath } });
  const start = api3.call("start", { planId: delayed.planId, confirmed: true });
  await new Promise(resolve => setImmediate(resolve));
  const closed = api3.close(); assert.equal(observedSignal.aborted, true); release();
  await assert.rejects(start, { name: "AbortError" }); await closed;
  assert.equal(disposedAfterStart, true); assert.equal(api3.close(), closed);

  let modelReady; const modelGate = new Promise(resolve => { modelReady = resolve; });
  let resumed = false;
  const api4 = createAgentApi({ ...deps, model: async () => { await modelGate; return model; }, resume: async () => { resumed = true; } });
  const lateResume = api4.call("resume", { outputDir: root, sessionId: "pi_fixture" });
  await new Promise(resolve => setImmediate(resolve));
  const shutdown = api4.close(); modelReady();
  await assert.rejects(lateResume, { name: "AbortError" }); await shutdown;
  assert.equal(resumed, false);
  let allowCreate, signalled, entered;
  const initialized = new Promise(resolve => { entered = resolve; });
  const createGate = new Promise(resolve => { allowCreate = resolve; });
  const apiCase = createAgentApi({ ...deps, readProject: async () => ({}), start: async (_request, options) => {
    options.onSession("pi_fixture"); signalled = options.signal; entered();
    await createGate; options.signal.throwIfAborted(); return { sessionId: "pi_fixture" };
  } });
  const casePlan = await apiCase.call("plan", { task: "translation", settings: { sourcePath, outputDir: root } });
  const caseStart = apiCase.call("start", { planId: casePlan.planId, confirmed: true });
  await initialized;
  const caseStop = apiCase.call("stop", { outputDir: root.toUpperCase(), sessionId: "pi_fixture" });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signalled.aborted, true);
  allowCreate(); await assert.rejects(caseStart, { name: "AbortError" }); await caseStop; await apiCase.close();
  let allowFailedStopCreate, failedStopEntered, adapterSettled = false, stopSettled = false;
  const failedStopGate = new Promise(resolve => { allowFailedStopCreate = resolve; });
  const failedStopEntry = new Promise(resolve => { failedStopEntered = resolve; });
  const apiStopFailure = createAgentApi({ ...deps, readProject: async () => ({}), stop: async () => { throw new Error("native Stop failed"); },
    start: async (_request, options) => { options.onSession("pi_fixture"); failedStopEntered(); await failedStopGate;
      adapterSettled = true; options.signal.throwIfAborted(); return { sessionId: "pi_fixture" }; } });
  const failurePlan = await apiStopFailure.call("plan", { task: "translation", settings: { sourcePath, outputDir: root } });
  const failedStopStart = apiStopFailure.call("start", { planId: failurePlan.planId, confirmed: true });
  await failedStopEntry;
  const failedStop = apiStopFailure.call("stop", { planId: failurePlan.planId }).finally(() => { stopSettled = true; });
  void failedStop.catch(() => {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopSettled, false);
  allowFailedStopCreate(); await assert.rejects(failedStopStart, { name: "AbortError" });
  await assert.rejects(failedStop, /native Stop failed/); assert.equal(adapterSettled, true); await apiStopFailure.close();
  const api5 = createAgentApi({ ...deps, lastReply: () => "x".repeat(20000) });
  const bounded = await api5.call("status", { outputDir: root, sessionId: "pi_fixture" });
  assert.equal(bounded.lastReply.length, 16000); assert.equal(bounded.lastReplyTruncated, true);
  await api5.close();
  let saved = 0, drained = false;
  await assert.rejects(settleAgentApiWorkspace({ dispose: async () => { throw new Error("native Stop persistence failed"); },
    flush: [async () => { saved += 1; throw new Error("one tab save failed"); }, async () => { saved += 1; }],
    drain: async () => { drained = true; } }), error => error instanceof AggregateError && error.errors.length === 2 && /native Stop persistence failed/.test(error.message));
  assert.equal(saved, 2); assert.equal(drained, true);
  assertAgentApiTaskSession({ builtinTaskSessionId: "pi_current" }, "pi_current");
  assert.throws(() => assertAgentApiTaskSession({ builtinTaskSessionId: "pi_current" }, "pi_old"), code("session_context_changed"));
  assert.throws(() => assertAgentApiTaskSession({ lineReviewPath: path.join(root, "builtin-pi_current.html") }, "pi_old"), code("session_context_changed"));
  console.log("Agent API: defaults, confirmation, read-only planning, CAS, idempotence, tasks, ownership and cancellation passed.");
} finally { await rm(root, { recursive: true, force: true }); }
