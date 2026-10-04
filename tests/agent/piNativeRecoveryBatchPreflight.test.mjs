import { createHash } from "node:crypto";
import { prepareTranslationReuseAudit, applyTranslationReuseAudit, captureTranslationReuseBaselineRollback } from "../../src/main/agent/piNative/translationReuseAudit.ts";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState, createTranslationChunkReviewAudit, translationAlignmentLinesInputHash, translationAlignmentInputHash } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import { prepareTranslationStagingCandidate, writeTranslationLines } from "../../src/main/agent/writeTranslationChunk.ts";
import { splitTextLines } from "../../src/shared/validation/translationValidator.ts";
import { NonRetryableAssignmentError } from "../../src/main/agent/piNative/assignmentFailure.ts";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core/node";
import { PiSessionAgentRuntime } from "../../src/main/agent/piNative/sessionAgentRuntime.ts";
import { appendYnSessionHostState, createProofreadHostState, loadYnSessionHostState } from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { readSessionEntries, appendSessionCustomEntry } from "../../src/main/agent/piNative/sessionAccess.ts";

for (const { reuse, durableFailure, settlementRace } of [{ reuse: false }, { reuse: true }, { reuse: false, durableFailure: true }, { reuse: false, settlementRace: true }]) test(`five real resumed Pi workers reconcile the complete ${reuse ? "applied-reuse" : durableFailure ? "append-then-fail rollback/retry" : settlementRace ? "concurrent settlement rollback" : "ordinary"} recovery batch before runtime and retain concurrent evidence`, async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-global-recovery-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const totalLines = reuse || settlementRace ? 144 : 20_000;
  const sourceLines = Array.from({ length: totalLines }, (_, index) => `Source sentence ${index + 1} has its own complete meaning.`);
  const candidateLines = sourceLines.map((_line, index) => `第${index + 1}行保留本行的完整含义。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
  const canonicalPath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, `${candidateLines.join("\n")}\n`, "utf8");
  if (reuse) {
    await writeFile(canonicalPath, `${candidateLines.map((line, index) => index < 120 ? "" : line).join("\n")}\n`, "utf8");
    const audit = await prepareTranslationReuseAudit({ outputDir, ownerSessionId: "pi_global_recovery", sourcePath, candidatePath: canonicalPath, documentId: "source.txt", languagePair: "en->zh-CN" });
    await applyTranslationReuseAudit({ outputDir, ownerSessionId: "pi_global_recovery", auditId: audit.auditId, decision: "reuse_accepted" });
    // Simulate the interrupted original workers having written their candidates.
    await writeFile(canonicalPath, `${candidateLines.join("\n")}\n`, "utf8");
  }
  const repository = new PiSessionRepository(outputDir);
  const parentSession = await repository.create("pi_global_recovery");
  if (!durableFailure) await repository.close();
  const provider = fauxProvider({ provider: "global-recovery", tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(provider.provider);
  const alignment = createTranslationAlignmentHostState();
  let firstProviderCalls = 0;
  let releaseFirstCalls;
  const firstCallsReady = new Promise((resolve) => { releaseFirstCalls = resolve; });
  const providerSnapshots = [];
  const runtimeLaunchSnapshots = [];
  const response = async (context) => {
    const system = getCurrentSystemPrompt(context.messages);
    const results = context.messages.filter((message) => message.role === "toolResult");
    if (system.includes("translation safety reviewer")) {
      return results.length === 0
        ? fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
    }
    const promptText = context.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    const match = promptText.match(/Owned chunk: L(\d+)-L(\d+)/);
    assert.ok(match, "actual worker prompt must expose its owned chunk");
    const fromLine = Number(match[1]);
    if (results.length === 0) {
      providerSnapshots.push(structuredClone(alignment));
      firstProviderCalls += 1;
      if (firstProviderCalls === 5) releaseFirstCalls();
      await Promise.race([firstCallsReady, new Promise((_, reject) => setTimeout(() => reject(new Error("five recovery workers did not reach provider concurrently")), 4000))]);
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
    }
    if (!results.some((result) => result.toolName === "repairAssignedTranslation")) {
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: fromLine + 2, translation: `修复第${fromLine + 2}行准确保留本行含义。` }]
      }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Repair complete."));
  };
  provider.setResponses(Array.from({ length: 150 }, () => response));
  const supervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => {
      runtimeLaunchSnapshots.push(structuredClone(alignment));
      return { models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id };
    }
  });
  let settlementMutation = false, settlementFaulted = false, enterSettlementPersist, releaseSettlementPersist;
  const settlementPersistEntered = new Promise((resolve) => { enterSettlementPersist = resolve; });
  const settlementPersistRelease = new Promise((resolve) => { releaseSettlementPersist = resolve; });
  if (settlementRace) {
    const start = supervisor.startTranslationBatch.bind(supervisor);
    supervisor.startTranslationBatch = (options) => {
      const settle = options.onSettled;
      options.onSettled = async (outcome) => {
        settlementMutation = true;
        const parentWrite = execute("writeTranslationChunk", { documentId: "source.txt", fromLine: 121, toLine: 121, lines: ["母代理修改第一百二十一行完整含义。"] });
        const failedWrite = parentWrite.then(() => { throw new Error("parent mutation unexpectedly committed"); }, (error) => error);
        await settlementPersistEntered;
        const settled = settle(outcome);
        try {
          await new Promise((resolve) => setTimeout(resolve, 40));
          assert.ok(!domainRun.snapshot().documents.some((document) => document.completedSubagentBatch?.id === outcome.batch.id),
            "Host settlement must wait for the parent mutation rollback, rather than be reverted by it");
        } finally { releaseSettlementPersist(); }
        assert.match((await failedWrite).message, /Host translation write/);
        await settled;
      };
      return start(options);
    };
  }
  const request = {
    outputDir, sourcePath, sessionId: "pi_global_recovery", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation",
    providerId: provider.provider.id, modelId: provider.getModel().id, languagePair: "en->zh-CN", splitSize: 24,
    reuseExistingTranslation: reuse, subagentEnabled: true, subagentCount: 5, reviewSubagentCount: 5, glossaryCandidates: false, characterBible: false
  };
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 5 });
  let suspended = false;
  const persisted = [];
  let injectAppendFailure = false, appendFaulted = false, lastPersisted;
  const persistRecoveryState = async (options = {}) => {
    if (settlementMutation && !settlementFaulted && !options.force) {
      settlementFaulted = true; enterSettlementPersist(); await settlementPersistRelease;
      throw new Error("injected parent persistence failure during child settlement");
    }
    persisted.push(structuredClone(alignment));
    if (durableFailure) {
      const state = { schemaVersion: 1, ownerSessionId: "pi_global_recovery", domainRun: domainRun.snapshot(),
        proofread: createProofreadHostState(), translationAlignment: alignment, workflowSuspended: suspended };
      const serialized = JSON.stringify(state);
      if (options.force || serialized !== lastPersisted) {
        await appendYnSessionHostState(parentSession, state, {
          force: options.force,
          ...(injectAppendFailure && !appendFaulted ? { appendCustomEntry: async (type, entry) => {
            appendFaulted = true;
            await appendSessionCustomEntry(parentSession, type, entry);
            throw new Error("native Host append succeeded before observer failure");
          } } : {})
        });
        lastPersisted = serialized;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  };
  const tools = createYnDomainTools({
    request, domainRun, subagents: supervisor, translationAlignmentState: alignment,
    publishCustomMessage: async () => {}, isWorkflowSuspended: () => suspended,
    async resumeWorkflow() { domainRun.resume(); suspended = false; supervisor.resumeAfterHostFailure(); },
    persistHostState: persistRecoveryState
  });
  const execute = (name, params = {}) => tools.find((tool) => tool.name === name).execute(`call_${name}`, params);
  try {
    await execute("inspectTranslationContext");
    domainRun.recordTranslationArtifactMutation("source.txt");
    const ranges = [];
    for (let fromLine = 1; fromLine <= 144; fromLine += 24) {
      const toLine = fromLine === 121 ? totalLines : fromLine + 23;
      const scope = createTranslationChunkReviewAudit({ documentId: "source.txt", sourceLines: sourceLines.slice(fromLine - 1, toLine), candidateLines: candidateLines.slice(fromLine - 1, toLine),
        candidatePath: canonicalPath, languagePair: request.languagePair, fromLine, toLine, sourceLineCount: totalLines,
        mechanicalSignals: [{ line: fromLine + 1, signals: ["accepted-risk"] }, { line: fromLine + 2, signals: ["semantic_mistranslation"] }] });
      scope.auditId = `alignment-mutation-${scope.auditId}`;
      for (const check of scope.checks) {
        check.verdict = fromLine <= 120 && check.line === fromLine + 2 ? "misaligned" : "aligned";
        if (check.verdict === "misaligned") check.reason = "semantic_mistranslation: restore this row's own complete meaning";
      }
      ranges.push(scope);
    }
    alignment.ranges["source.txt"] = ranges;
    const acceptedScope = structuredClone(ranges.at(-1));
    domainRun.recordSubagentBatchStarted("translation", "old-failed-batch", { taskCount: 5, workerCount: 5, documentIds: ["source.txt"], assignmentCounts: { "source.txt": 5 } });
    domainRun.recordSubagentBatchFailure("translation", "old-failed-batch", ["source.txt"]);
    domainRun.suspend(); suspended = true;
    await execute("resumeYnWorkflow");
    if (durableFailure) {
      await persistRecoveryState();
      const before = structuredClone(alignment);
      const beforeCanonical = await readFile(canonicalPath, "utf8");
      injectAppendFailure = true;
      await assert.rejects(() => execute("runTranslationSubagents"), (error) => error instanceof NonRetryableAssignmentError && error.retryable === false);
      assert.deepEqual(alignment, before);
      assert.equal(await readFile(canonicalPath, "utf8"), beforeCanonical);
      assert.equal(runtimeLaunchSnapshots.length, 0);
      const reopened = await repository.open("pi_global_recovery");
      const restored = await loadYnSessionHostState(reopened, "pi_global_recovery");
      assert.deepEqual(restored.translationAlignment, before, "forced native rollback checkpoint must defeat the stale persistence cursor");
      const entries = await readSessionEntries(reopened);
      assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "yn.host-state.v2").at(-1).data.mode, "checkpoint");
      injectAppendFailure = false;
    }
    const run = await execute("runTranslationSubagents");
    await supervisor.waitForAll();
    assert.equal(runtimeLaunchSnapshots[0].ranges["source.txt"].filter((scope) => scope.candidatePath !== canonicalPath).length, 5,
      "Host must reconcile and bind the complete recovery batch before any child runtime is created");
    assert.equal(firstProviderCalls, 5);
    assert.equal(providerSnapshots[0].ranges["source.txt"].filter((scope) => scope.candidatePath !== canonicalPath).length, 5,
      "Host must bind every recoverable scope before the first provider request");
    const [batch] = supervisor.list();
    assert.equal(batch.status, "completed", batch.error);
    assert.equal(run.details.assignmentCount, 5);
    const finalScopes = alignment.ranges["source.txt"];
    assert.equal(finalScopes.length, 6);
    assert.deepEqual(finalScopes.at(-1), acceptedScope, "unrelated accepted canonical evidence must remain intact");
    assert.ok(finalScopes.every((scope) => scope.candidatePath === canonicalPath && scope.checks.every((check) => check.verdict === "aligned")));
    const finalLines = (await readFile(canonicalPath, "utf8")).split("\n");
    for (const scope of ranges.slice(0, 5)) assert.equal(finalLines[scope.fromLine + 1], `修复第${scope.fromLine + 2}行准确保留本行含义。`);
    assert.ok(persisted.length > 5);
    if (settlementRace) assert.equal(domainRun.snapshot().documents.find((document) => document.id === "source.txt").completedSubagentBatch.id, run.details.batchId);
  } finally {
    await supervisor.waitForAll();
    if (durableFailure) await repository.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function mixedRecoveryFixture({ fault, fakeLaunch = false } = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-mixed-recovery-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 96 }, (_, index) => `Source sentence ${index + 1} has its own complete meaning.`);
  const candidateLines = sourceLines.map((_line, index) => `第${index + 1}行保留本行的完整含义。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
  const canonical = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonical), { recursive: true });
  await writeFile(canonical, `${candidateLines.join("\n")}\n`, "utf8");
  const staging = [];
  for (const fromLine of [1, 49]) {
    staging.push(await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt", sessionId: "mixed-recovery", subagentId: `old-worker-${fromLine}`, assignmentId: `source.txt:L${fromLine}-L${fromLine + 23}` }));
  }
  const acceptedLines = [...candidateLines];
  acceptedLines[0] = "已审阅第一行保留自己的完整含义。";
  await writeFile(staging[0], `${acceptedLines.join("\n")}\n`, "utf8");
  let launches = 0;
  let batch;
  const subagents = fakeLaunch ? {
    hasRunning: () => false,
    hasWriteConflict: () => false,
    startTranslationBatch(options) { launches += 1; batch = options; return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] }; },
    startTranslationReviewBatch(options) { launches += 1; batch = options; return { id: options.batchId, kind: "translation-review", status: "running", startedAt: 1, subagents: [] }; }
  } : new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => { launches += 1; throw new Error("No child runtime should launch on failed recovery preflight."); } });
  const request = { outputDir, sourcePath, sessionId: "mixed-recovery", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", providerId: "test", modelId: "test", languagePair: "en->zh-CN", splitSize: 24, subagentEnabled: true, subagentCount: 5, glossaryCandidates: false, characterBible: false };
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 5 });
  const alignment = createTranslationAlignmentHostState();
  let persistCalls = 0, persistOverride;
  const tools = createYnDomainTools({ request, domainRun, subagents, translationAlignmentState: alignment, publishCustomMessage: async () => {},
    async persistHostState(options) { persistCalls += 1; if (fault === "persist" && persistCalls === 1) throw new Error("injected complete recovery commit failure"); await persistOverride?.(options); } });
  const execute = (name, params = {}) => tools.find((tool) => tool.name === name).execute(`call_${name}`, params);
  // Inspection must succeed before injecting the preflight-specific persistence fault.
  if (fault === "persist") {
    domainRun.recordInspection({ sourceLineCount: 96, documents: [{ id: "source.txt", sourceLineCount: 96 }], glossaryCandidateExists: true, characterBibleExists: true });
  } else await execute("inspectTranslationContext");
  domainRun.recordTranslationArtifactMutation("source.txt");
  for (let fromLine = 1; fromLine <= 96; fromLine += 24) {
    const candidate = fromLine === 1 ? staging[0] : fromLine === 49 ? staging[1] : canonical;
    const scope = createTranslationChunkReviewAudit({ documentId: "source.txt", sourceLines: sourceLines.slice(fromLine - 1, fromLine + 23), candidateLines: (fromLine === 1 ? acceptedLines : candidateLines).slice(fromLine - 1, fromLine + 23), candidatePath: candidate, languagePair: request.languagePair, fromLine, toLine: fromLine + 23, sourceLineCount: 96,
      mechanicalSignals: [{ line: fromLine + 2, signals: ["semantic_mistranslation"] }] });
    for (const check of scope.checks) {
      if (fromLine === 49) continue;
      check.verdict = fromLine === 25 && check.line === fromLine + 2 ? "misaligned" : "aligned";
      if (check.verdict === "misaligned") check.reason = "semantic_mistranslation: restore this row's own complete meaning";
    }
    (alignment.ranges["source.txt"] ??= []).push(scope);
  }
  if (fault === "last-staging") {
    const lines = [...candidateLines]; lines[50] += "变更。";
    await writeFile(staging[1], `${lines.join("\n")}\n`, "utf8");
  } else if (fault === "accepted-canonical") {
    const lines = [...candidateLines]; lines[74] += "变更。";
    await writeFile(canonical, `${lines.join("\n")}\n`, "utf8");
  } else if (fault === "missing-staging") await rm(staging[1]);
  else if (fault === "overlap") alignment.ranges["source.txt"][1].fromLine = 1;
  else if (fault === "canonical-shape-with-only-staging") {
    for (const scope of alignment.ranges["source.txt"].filter((scope) => scope.candidatePath === canonical)) {
      const stage = await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt", sessionId: "mixed-recovery", subagentId: `old-${scope.fromLine}`, assignmentId: `${scope.fromLine}` });
      scope.candidatePath = stage;
    }
    await writeFile(canonical, "only one canonical line\n", "utf8");
  }
  const stagingRoot = path.join(outputDir, ".translation-workshop", "agent", "translation-staging");
  const before = {
    alignment: structuredClone(alignment), domain: domainRun.snapshot(), canonical: await readFile(canonical, "utf8"),
    stagingFiles: (await readdir(stagingRoot, { recursive: true })).filter((entry) => entry.endsWith(".txt")).sort(),
    acceptedStaging: await readFile(staging[0], "utf8")
  };
  return { outputDir, sourcePath, canonical, staging, request, domainRun, alignment, before, tools, execute, subagents,
    launches: () => launches, persistCalls: () => persistCalls, batch: () => batch, setPersistence: (callback) => { persistOverride = callback; },
    async assertUnchanged() {
      assert.deepEqual(alignment, before.alignment);
      assert.deepEqual(domainRun.snapshot(), before.domain);
      assert.equal(await readFile(canonical, "utf8"), before.canonical);
      assert.equal(await readFile(staging[0], "utf8"), before.acceptedStaging);
      assert.deepEqual((await readdir(stagingRoot, { recursive: true })).filter((entry) => entry.endsWith(".txt")).sort(), before.stagingFiles);
      assert.equal(launches, 0);
    },
    async close() { await subagents.waitForAll?.(); await rm(outputDir, { recursive: true, force: true }); }
  };
}

for (const fault of ["last-staging", "accepted-canonical", "missing-staging", "overlap", "persist", "canonical-shape-with-only-staging"]) {
  test(`complete recovery preflight rejects ${fault} before any runtime and rolls back the entire artifact/evidence transaction`, async () => {
    const fx = await mixedRecoveryFixture({ fault });
    try {
      await assert.rejects(() => fx.execute("runTranslationSubagents"), (error) => error instanceof NonRetryableAssignmentError && error.retryable === false);
      await fx.assertUnchanged();
    } finally { await fx.close(); }
  });
}

test("accepted staging is promoted and canonical rejected/pending staging are reconciled together before the review pool launches", async () => {
  const fx = await mixedRecoveryFixture({ fakeLaunch: true });
  try {
    await fx.execute("runTranslationSubagents");
    const scopes = fx.alignment.ranges["source.txt"];
    assert.equal(fx.launches(), 1);
    assert.equal(scopes[0].candidatePath, fx.canonical);
    assert.deepEqual(scopes[0].checks, fx.before.alignment.ranges["source.txt"][0].checks);
    assert.notEqual(scopes[1].candidatePath, fx.canonical);
    assert.deepEqual(scopes[1].checks, fx.before.alignment.ranges["source.txt"][1].checks);
    assert.equal(scopes[2].candidatePath, fx.staging[1]);
    assert.deepEqual(scopes[2].checks, fx.before.alignment.ranges["source.txt"][2].checks);
    assert.deepEqual(scopes[3], fx.before.alignment.ranges["source.txt"][3]);
    assert.equal((await readFile(fx.canonical, "utf8")).split("\n")[0], "已审阅第一行保留自己的完整含义。");
    assert.equal(fx.batch().tasks.length, 1);
    assert.equal(fx.batch().tasks[0].stagingCandidatePath, fx.staging[1]);
  } finally { await fx.close(); }
});

test("native parent Pi cannot repeat a terminal whole-batch recovery preflight failure", async () => {
  const fx = await mixedRecoveryFixture({ fault: "last-staging" });
  const session = await new MemorySessionRepo().create({ id: "preflight-parent" }, BACKGROUND_CONTEXT);
  const provider = fauxProvider({ provider: "preflight-parent", tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(provider.provider);
  let providerCalls = 0;
  provider.setResponses(Array.from({ length: 6 }, () => () => {
    providerCalls += 1;
    return fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {}), { stopReason: "toolUse" });
  }));
  let fatalCalls = 0;
  const runtime = new PiSessionAgentRuntime({ session, sessionId: session.metadata.id, models, model: provider.getModel(), thinkingLevel: "off", systemPrompt: "Resume the Host translation queue.", tools: fx.tools,
    onFatalToolError: () => { fatalCalls += 1; } });
  try {
    await assert.rejects(() => runtime.prompt("Continue the current translation."), /Host recovery preflight failed/);
    assert.equal(providerCalls, 1);
    assert.equal(fatalCalls, 1);
    await fx.assertUnchanged();
    const entries = await readSessionEntries(session);
    const failure = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "runTranslationSubagents");
    assert.equal(failure.message.isError, true);
    assert.equal(failure.message.details.retryable, false);
    assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "yn_host_tool_failure").length, 1);
  } finally { runtime.dispose(); await session.close(BACKGROUND_CONTEXT); await fx.close(); }
});

for (const compensationAppended of [false, true]) test(`failed native recovery commit and ${compensationAppended ? "append-then-fail" : "unwritten"} forced compensation cold-resume hash-current artifacts`, async () => {
  const fx = await mixedRecoveryFixture({ fakeLaunch: true });
  const repository = new PiSessionRepository(fx.outputDir);
  const session = await repository.create("mixed-recovery");
  const state = () => ({ schemaVersion: 1, ownerSessionId: "mixed-recovery", domainRun: fx.domainRun.snapshot(),
    proofread: createProofreadHostState(), translationAlignment: fx.alignment });
  await appendYnSessionHostState(session, state());
  let forced = false;
  fx.setPersistence(async (options) => {
    if (options?.force) {
      forced = true;
      if (compensationAppended) await appendYnSessionHostState(session, state(), { force: true, appendCustomEntry: async (type, entry) => {
        await appendSessionCustomEntry(session, type, entry); throw new Error("forced compensation append succeeded before failure");
      } });
      throw new Error("forced compensation persistence failed");
    }
    await appendYnSessionHostState(session, state(), { appendCustomEntry: async (type, entry) => {
      await appendSessionCustomEntry(session, type, entry);
      throw new Error("native mutation append succeeded before failure");
    } });
  });
  try {
    await assert.rejects(() => fx.execute("runTranslationSubagents"), (error) => error instanceof NonRetryableAssignmentError
      && error.retryable === false && error.cause instanceof AggregateError);
    assert.equal(forced, true);
    assert.equal(fx.launches(), 0);
    assert.deepEqual(fx.alignment, fx.before.alignment);
    assert.equal(splitTextLines(await readFile(fx.canonical, "utf8"))[0], "已审阅第一行保留自己的完整含义。");
    const reopened = await repository.open("mixed-recovery");
    const durable = await loadYnSessionHostState(reopened, "mixed-recovery");
    const staged = durable.translationAlignment.ranges["source.txt"].filter((scope) => scope.candidatePath !== fx.canonical);
    if (!compensationAppended) assert.ok(staged.some((scope) => !fx.staging.includes(scope.candidatePath)), "durable failed entry must reference a newly prepared candidate");
    for (const scope of staged) assert.ok((await readFile(scope.candidatePath, "utf8")).length > 0,
      "failed compensation must preserve files referenced by durable Host state");
    const sourceLines = splitTextLines(await readFile(fx.sourcePath, "utf8"));
    for (const scope of durable.translationAlignment.ranges["source.txt"]) {
      const lines = splitTextLines(await readFile(scope.candidatePath, "utf8"));
      assert.equal(lines.length, sourceLines.length);
      assert.equal((scope.lineHashVersion === 2 ? translationAlignmentLinesInputHash(sourceLines.slice(scope.fromLine - 1, scope.toLine), lines.slice(scope.fromLine - 1, scope.toLine), fx.request.languagePair) : translationAlignmentInputHash(sourceLines.slice(scope.fromLine - 1, scope.toLine).join("\n"), lines.slice(scope.fromLine - 1, scope.toLine).join("\n"), fx.request.languagePair)), scope.inputHash,
        "either durable image must retain hash-current canonical and staging evidence");
    }
    const journalRoot = path.join(fx.outputDir, ".translation-workshop", "agent", "recovery-transactions");
    const journals = (await readdir(journalRoot, { recursive: true })).filter((entry) => entry.endsWith("transaction.json"));
    assert.equal(journals.length, 1);
    const journal = JSON.parse(await readFile(path.join(journalRoot, journals[0]), "utf8"));
    assert.equal(await readFile(journal.canonicalSnapshots[0].backupPath, "utf8"), fx.before.canonical);
    for (const candidate of journal.retainedStagingCandidates) assert.ok((await readFile(candidate, "utf8")).length > 0);
    const provider = fauxProvider({ provider: "double-fault-recovery", tokensPerSecond: 100_000 });
    const models = createModels(); models.setProvider(provider.provider);
    provider.setResponses(Array.from({ length: 40 }, () => (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult");
      if (getCurrentSystemPrompt(context.messages).includes("translation safety reviewer")) return results.length === 0
        ? fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
      if (results.length === 0) return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
      if (!results.some((result) => result.toolName === "repairAssignedTranslation")) return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 27, translation: "修复第二十七行完整含义。" }]
      }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxText("Repair complete."));
    }));
    const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }) });
    const restoredDomain = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 5, restoreSnapshot: durable.domainRun });
    const tools = createYnDomainTools({ request: { ...fx.request, providerId: provider.provider.id, modelId: provider.getModel().id }, domainRun: restoredDomain,
      subagents: supervisor, translationAlignmentState: durable.translationAlignment, publishCustomMessage: async () => {},
      persistHostState: (options) => appendYnSessionHostState(reopened, { ...durable, domainRun: restoredDomain.snapshot() }, options) });
    const run = tools.find((tool) => tool.name === "runTranslationSubagents");
    try {
      await run.execute("cold-resume-pending-review", {}); await supervisor.waitForAll();
      assert.ok(supervisor.list().every((batch) => batch.status === "completed"), "cold pending review must really run after double failure");
      await run.execute("cold-resume-remaining-repair", {}); await supervisor.waitForAll();
      assert.ok(supervisor.list().every((batch) => batch.status === "completed"));
      assert.ok(durable.translationAlignment.ranges["source.txt"].every((scope) => scope.candidatePath === fx.canonical && scope.checks.every((check) => check.verdict === "aligned")));
      assert.equal(splitTextLines(await readFile(fx.canonical, "utf8"))[0], "已审阅第一行保留自己的完整含义。");
      assert.equal(splitTextLines(await readFile(fx.canonical, "utf8"))[26], "修复第二十七行完整含义。");
    } finally { await supervisor.waitForAll(); }

  } finally { await repository.close(); await fx.close(); }
});

test("native takeover append and failed forced compensation retain a cold-recoverable canonical post-image", async () => {
  const fx = await mixedRecoveryFixture({ fakeLaunch: true });
  const repository = new PiSessionRepository(fx.outputDir);
  const session = await repository.create("mixed-recovery");
  let supervisor;
  try {
    fx.alignment.ranges["source.txt"][2].checks.forEach((check) => { check.verdict = "aligned"; });
    await fx.execute("runTranslationSubagents");
    const scope = fx.alignment.ranges["source.txt"][1];
    const sources = splitTextLines(await readFile(fx.sourcePath, "utf8"));
    const candidates = splitTextLines(await readFile(scope.candidatePath, "utf8"));
    candidates[26] = "保留接管的第二十七行候选完整含义。";
    await writeFile(scope.candidatePath, `${candidates.join("\n")}\n`);
    scope.inputHash = translationAlignmentLinesInputHash(sources.slice(24, 48), candidates.slice(24, 48), fx.request.languagePair);
    const before = structuredClone(fx.alignment);
    const beforeCanonical = await readFile(fx.canonical, "utf8");
    const state = () => ({ schemaVersion: 1, ownerSessionId: "mixed-recovery", domainRun: fx.domainRun.snapshot(), proofread: createProofreadHostState(), translationAlignment: fx.alignment });
    await appendYnSessionHostState(session, state());
    fx.setPersistence(async (options) => {
      if (options?.force) throw new Error("takeover forced compensation failed");
      await appendYnSessionHostState(session, state(), { appendCustomEntry: async (type, entry) => {
        await appendSessionCustomEntry(session, type, entry); throw new Error("takeover native append succeeded before failure");
      } });
    });
    await assert.rejects(() => fx.batch().onParentTakeover({ documentId: "source.txt", fromLine: 25, toLine: 48, rejectedLines: [27], feedback: scope.checks.find((check) => check.line === 27).reason,
      stagingCandidatePath: scope.candidatePath, candidateHash: createHash("sha256").update(JSON.stringify({ fromLine: 25, toLine: 48, candidate: candidates.slice(24, 48) })).digest("hex") }), /compensation could not be confirmed/);
    assert.deepEqual(fx.alignment, before);
    assert.notEqual(await readFile(fx.canonical, "utf8"), beforeCanonical);
    const reopened = await repository.open("mixed-recovery");
    const durable = await loadYnSessionHostState(reopened, "mixed-recovery");
    for (const retained of durable.translationAlignment.ranges["source.txt"]) {
      const lines = splitTextLines(await readFile(retained.candidatePath, "utf8"));
      assert.equal(retained.inputHash, translationAlignmentLinesInputHash(sources.slice(retained.fromLine - 1, retained.toLine), lines.slice(retained.fromLine - 1, retained.toLine), fx.request.languagePair));
    }
    const provider = fauxProvider({ provider: "takeover-double-fault", tokensPerSecond: 100_000 });
    const models = createModels(); models.setProvider(provider.provider);
    provider.setResponses(Array.from({ length: 20 }, () => (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult");
      if (getCurrentSystemPrompt(context.messages).includes("translation safety reviewer")) return results.length === 0
        ? fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
      return results.length === 0 ? fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" })
        : results.some((result) => result.toolName === "repairAssignedTranslation") ? fauxAssistantMessage(fauxText("Repair complete."))
          : fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", { entries: [{ line: 27, translation: "修复第二十七行完整含义。" }] }), { stopReason: "toolUse" });
    }));
    supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }) });
    const restored = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 5, restoreSnapshot: durable.domainRun });
    const tools = createYnDomainTools({ request: { ...fx.request, providerId: provider.provider.id, modelId: provider.getModel().id }, domainRun: restored,
      subagents: supervisor, translationAlignmentState: durable.translationAlignment, publishCustomMessage: async () => {}, persistHostState: (options) => appendYnSessionHostState(reopened, { ...durable, domainRun: restored.snapshot() }, options) });
    await tools.find((tool) => tool.name === "runTranslationSubagents").execute("cold-takeover", {}); await supervisor.waitForAll();
    assert.ok(supervisor.list().every((batch) => batch.status === "completed"));
    assert.ok(durable.translationAlignment.ranges["source.txt"].every((retained) => retained.candidatePath === fx.canonical && retained.checks.every((check) => check.verdict === "aligned")));
    assert.equal(splitTextLines(await readFile(fx.canonical, "utf8"))[26], "修复第二十七行完整含义。");
  } finally { await supervisor?.waitForAll(); await repository.close(); await fx.close(); }
});

test("failed takeover rollback serializes with a real healthy Pi promotion and a nonoverlapping parent write", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-recovery-rollback-race-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 72 }, (_, index) => `Source sentence ${index + 1} keeps its complete meaning.`);
  const candidateLines = sourceLines.map((_line, index) => `第${index + 1}行保留本行完整含义。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`);
  const canonical = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonical), { recursive: true });
  await writeFile(canonical, `${candidateLines.join("\n")}\n`);
  const repository = new PiSessionRepository(outputDir); await repository.create("rollback-race"); await repository.close();
  const alignment = createTranslationAlignmentHostState();
  const provider = fauxProvider({ provider: "rollback-race", tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(provider.provider);
  let releaseFailedWorker, enterCommit, failCommit;
  const failedWorkerReady = new Promise((resolve) => { releaseFailedWorker = resolve; });
  const commitEntered = new Promise((resolve) => { enterCommit = resolve; });
  const commitFailure = new Promise((resolve) => { failCommit = resolve; });
  let injected = false, takeoverResult;
  const response = async (context) => {
    const system = getCurrentSystemPrompt(context.messages);
    const results = context.messages.filter((message) => message.role === "toolResult");
    if (system.includes("translation safety reviewer")) return results.length === 0
      ? fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
    const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    const fromLine = Number(prompt.match(/Owned chunk: L(\d+)-L(\d+)/)[1]);
    if (results.length === 0) {
      if (fromLine === 1) await failedWorkerReady;
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
    }
    if (!results.some((result) => result.toolName === "repairAssignedTranslation")) return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: [{ line: fromLine + 2, translation: `修复第${fromLine + 2}行完整含义。` }]
    }), { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxText("Repair complete."));
  };
  provider.setResponses(Array.from({ length: 80 }, () => response));
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }) });
  const start = supervisor.startTranslationBatch.bind(supervisor);
  supervisor.startTranslationBatch = (options) => {
    const prepare = options.prepareChunkReview;
    options.prepareChunkReview = async (review) => {
      const prepared = await prepare(review);
      if (review.fromLine !== 25 || !prepared.submit) return prepared;
      const submit = prepared.submit;
      prepared.submit = async (...args) => {
        const accepted = await submit(...args);
        if (!injected && accepted.accepted) {
          injected = true;
          const failed = alignment.ranges["source.txt"].find((scope) => scope.fromLine === 1);
          takeoverResult = options.onParentTakeover({ documentId: "source.txt", fromLine: 1, toLine: 24, rejectedLines: [3],
            feedback: "semantic_mistranslation: restore this row", stagingCandidatePath: failed.candidatePath,
            candidateHash: createHash("sha256").update(JSON.stringify({ fromLine: 1, toLine: 24, candidate: candidateLines.slice(0, 24) })).digest("hex")
          }).then(() => { throw new Error("injected takeover unexpectedly committed"); }, (error) => error);
        }
        return accepted;
      };
      return prepared;
    };
    return start(options);
  };
  const request = { outputDir, sourcePath, sessionId: "rollback-race", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", providerId: provider.provider.id, modelId: provider.getModel().id,
    languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 2, reviewSubagentCount: 2, splitSize: 24, glossaryCandidates: false, characterBible: false };
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 2 });
  let commitFaulted = false;
  const tools = createYnDomainTools({ request, domainRun, subagents: supervisor, translationAlignmentState: alignment, publishCustomMessage: async () => {},
    async persistHostState() {
      const failed = alignment.ranges["source.txt"]?.find((scope) => scope.fromLine === 1);
      if (injected && !commitFaulted && failed?.candidatePath === canonical && failed.checks.some((check) => check.verdict === "misaligned")) {
        commitFaulted = true; enterCommit(); await commitFailure; throw new Error("injected takeover commit failure");
      }
    }
  });
  const execute = (name, params = {}) => tools.find((tool) => tool.name === name).execute(`call_${name}`, params);
  let parentWrite;
  try {
    await execute("inspectTranslationContext"); domainRun.recordTranslationArtifactMutation("source.txt");
    for (const fromLine of [1, 25, 49]) {
      const scope = createTranslationChunkReviewAudit({ documentId: "source.txt", sourceLines: sourceLines.slice(fromLine - 1, fromLine + 23), candidateLines: candidateLines.slice(fromLine - 1, fromLine + 23),
        candidatePath: canonical, fromLine, toLine: fromLine + 23, sourceLineCount: 72, languagePair: request.languagePair, mechanicalSignals: [{ line: fromLine + 2, signals: ["semantic_mistranslation"] }] });
      for (const check of scope.checks) { check.verdict = fromLine < 49 && check.line === fromLine + 2 ? "misaligned" : "aligned"; if (check.verdict === "misaligned") check.reason = "semantic_mistranslation: restore this row"; }
      (alignment.ranges["source.txt"] ??= []).push(scope);
    }
    await execute("runTranslationSubagents");
    await Promise.race([commitEntered, new Promise((_, reject) => setTimeout(() => reject(new Error("takeover commit gate was never entered")), 5000))]);
    let parentCommitted = false;
    parentWrite = execute("writeTranslationChunk", { documentId: "source.txt", fromLine: 49, toLine: 49, lines: ["母代理修复第四十九行完整含义。"] }).then(() => { parentCommitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(parentCommitted, false, "parent canonical writer must wait for the failed takeover transaction");
    assert.equal((await readFile(canonical, "utf8")).split("\n")[26], candidateLines[26], "healthy child promotion must wait before touching canonical");
    failCommit();
    assert.match((await takeoverResult).message, /injected takeover commit failure/);
    await parentWrite;
    releaseFailedWorker(); await supervisor.waitForAll();
    assert.equal(supervisor.list()[0].status, "completed", supervisor.list()[0].error);
    const final = (await readFile(canonical, "utf8")).split("\n");
    assert.equal(final[26], "修复第27行完整含义。");
    assert.equal(final[48], "母代理修复第四十九行完整含义。");
    assert.ok(alignment.ranges["source.txt"].find((scope) => scope.fromLine === 25).checks.every((check) => check.verdict === "aligned"));
  } finally { failCommit(); releaseFailedWorker(); await parentWrite; await supervisor.waitForAll(); await rm(outputDir, { recursive: true, force: true }); }
});

test("real general translation repair rolls back canonical, review evidence and domain mutation when Host persistence fails", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-general-repair-rollback-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 24 }, (_, index) => `Source sentence ${index + 1} has its own complete meaning.`);
  const candidateLines = sourceLines.map((_line, index) => `第${index + 1}行保留本行完整含义。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`);
  const canonical = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonical), { recursive: true }); await writeFile(canonical, `${candidateLines.join("\n")}\n`);
  const applied = await prepareTranslationReuseAudit({ outputDir, ownerSessionId: "general-rollback", sourcePath, candidatePath: canonical, documentId: "source.txt", languagePair: "en->zh-CN" });
  await applyTranslationReuseAudit({ outputDir, ownerSessionId: "general-rollback", auditId: applied.auditId, decision: "reuse_accepted" });
  const reuseStorePath = path.join(outputDir, ".translation-workshop", "translation-reuse-audits.json");
  const previousReuseStore = await readFile(reuseStorePath, "utf8");
  const repository = new PiSessionRepository(outputDir); await repository.create("general-rollback"); await repository.close();
  const provider = fauxProvider({ provider: "general-rollback", tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(provider.provider);
  let calls = 0;
  provider.setResponses(Array.from({ length: 10 }, () => (context) => {
    calls += 1;
    return context.messages.some((message) => message.role === "toolResult" && message.toolName === "readAssignedSource")
      ? fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", { entries: [{ line: 3, translation: "修复第三行保留完整含义。" }] }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
  }));
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }) });
  const alignment = createTranslationAlignmentHostState();
  const scope = createTranslationChunkReviewAudit({ documentId: "source.txt", sourceLines, candidateLines, candidatePath: canonical, fromLine: 1, toLine: 24, sourceLineCount: 24, languagePair: "en->zh-CN", mechanicalSignals: [{ line: 3, signals: ["accepted-risk"] }] });
  for (const check of scope.checks) check.verdict = "aligned";
  alignment.ranges["source.txt"] = [scope];
  const previousAlignment = structuredClone(alignment);
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: false, subagentEnabled: true, subagentCount: 1 });
  const persisted = [];
  let changedPersists = 0;
  const request = { outputDir, sourcePath, sessionId: "general-rollback", prompt: "Repair only L3.", providerId: provider.provider.id, modelId: provider.getModel().id,
    languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 1, glossaryCandidates: false, characterBible: false };
  const tools = createYnDomainTools({ request, domainRun, subagents: supervisor, translationAlignmentState: alignment, publishCustomMessage: async () => {},
    async persistHostState() {
      if (alignment.ranges["source.txt"]?.some((entry) => entry.auditId.startsWith("alignment-mutation-"))) {
        changedPersists += 1;
        if (changedPersists === 1) throw new Error("injected general repair persistence failure");
      }
      persisted.push(structuredClone(alignment));
    }
  });
  const execute = (name, params = {}) => tools.find((tool) => tool.name === name).execute(`call_${name}`, params);
  try {
    await execute("inspectTranslationContext");
    const artifactBefore = domainRun.snapshot().documents;
    await execute("runSubagents", { tasks: [{ mode: "translation_repair", prompt: "Fix only source.txt L3.", documentId: "source.txt", fromLine: 1, toLine: 24, lines: [3] }] });
    await supervisor.waitForAll();
    assert.equal(supervisor.list()[0].status, "failed");
    assert.match(supervisor.list()[0].error, /Host canonical repair evidence commit failed/);
    assert.equal(calls, 2, "Host commit failure must end the current native child turn");
    assert.equal(await readFile(canonical, "utf8"), `${candidateLines.join("\n")}\n`);
    assert.deepEqual(alignment, previousAlignment);
    assert.equal(await readFile(reuseStorePath, "utf8"), previousReuseStore, "applied baseline hash/timestamp must roll back with canonical");
    assert.deepEqual(persisted.at(-1), previousAlignment, "the durable rollback must replace the intermediate successful persistence");
    assert.deepEqual(domainRun.snapshot().documents, artifactBefore);
  } finally { await supervisor.waitForAll(); await rm(outputDir, { recursive: true, force: true }); }
});

test("applied baseline rollback restores only its captured audit and retains another document's update", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-baseline-rollback-"));
  const documents = [];
  try {
    for (const documentId of ["first.txt", "second.txt"]) {
      const sourcePath = path.join(outputDir, documentId);
      await writeFile(sourcePath, "This sentence has its complete meaning.\n");
      const candidatePath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId });
      await mkdir(path.dirname(candidatePath), { recursive: true }); await writeFile(candidatePath, "原译文保留本行的完整含义。\n");
      const audit = await prepareTranslationReuseAudit({ outputDir, ownerSessionId: "baseline-rollback", documentId, sourcePath, candidatePath, languagePair: "en->zh-CN" });
      await applyTranslationReuseAudit({ outputDir, ownerSessionId: "baseline-rollback", auditId: audit.auditId, decision: "reuse_accepted" });
      documents.push({ documentId, sourcePath, candidatePath, auditId: audit.auditId });
    }
    const storePath = path.join(outputDir, ".translation-workshop", "translation-reuse-audits.json");
    const before = JSON.parse(await readFile(storePath, "utf8"));
    const rollback = await captureTranslationReuseBaselineRollback({ outputDir, ...documents[0] });
    for (const document of documents) await writeTranslationLines({ outputDir, sourcePaths: [document.sourcePath], documentId: document.documentId,
      entries: [{ line: 1, text: `${document.documentId} 修复本行完整含义。` }] });
    const committedOther = JSON.parse(await readFile(storePath, "utf8")).audits.find((audit) => audit.id === documents[1].auditId);
    await rollback();
    const after = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(after.audits.find((audit) => audit.id === documents[0].auditId), before.audits.find((audit) => audit.id === documents[0].auditId));
    assert.deepEqual(after.audits.find((audit) => audit.id === documents[1].auditId), committedOther);
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});

test("actual Pi promotion native append and failed compensation preserve hash-current artifacts for cold Host recovery", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-promotion-double-fault-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const sources = Array.from({ length: 8 }, (_, index) => `Source sentence ${index + 1} has its complete meaning.`);
  await writeFile(sourcePath, `${sources.join("\n")}\n`);
  const canonical = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  const repository = new PiSessionRepository(outputDir); const session = await repository.create("promotion-double-fault");
  const provider = fauxProvider({ provider: "promotion-double-fault", tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(provider.provider);
  let providerCalls = 0;
  provider.setResponses(Array.from({ length: 15 }, () => (context) => {
    providerCalls += 1;
    const results = context.messages.filter((message) => message.role === "toolResult");
    if (getCurrentSystemPrompt(context.messages).includes("translation safety reviewer")) return results.length === 0
      ? fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
    return results.length === 0 ? fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" })
      : results.some((result) => result.toolName === "writeAssignedTranslation") ? fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", { blocks: [{ id: "0", lines: sources.map((_line, index) => `${index.toString(16)}第${index + 1}行保留本行完整含义。`) }] }), { stopReason: "toolUse" });
  }));
  const request = { outputDir, sourcePath, sessionId: "promotion-double-fault", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", providerId: provider.provider.id, modelId: provider.getModel().id,
    languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 1, splitSize: 8, glossaryCandidates: false, characterBible: false };
  const domain = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
  const alignment = createTranslationAlignmentHostState();
  let faulted = false;
  const state = () => ({ schemaVersion: 1, ownerSessionId: request.sessionId, domainRun: domain.snapshot(), proofread: createProofreadHostState(), translationAlignment: alignment });
  const persist = async (options = {}) => {
    if (faulted) throw new Error("promotion compensation persistence unavailable");
    if (alignment.ranges["source.txt"]?.some((scope) => scope.candidatePath === canonical)) {
      faulted = true;
      await appendYnSessionHostState(session, state(), { appendCustomEntry: async (type, entry) => { await appendSessionCustomEntry(session, type, entry); throw new Error("promotion append succeeded before observer failure"); } });
    }
    await appendYnSessionHostState(session, state(), options);
  };
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }),
    onFatalHostFailure: async () => { domain.suspend(); await persist({ force: true }); } });
  const tools = createYnDomainTools({ request, domainRun: domain, subagents: supervisor, translationAlignmentState: alignment, publishCustomMessage: async () => {}, persistHostState: persist });
  try {
    await tools.find((tool) => tool.name === "inspectTranslationContext").execute("inspect", {});
    await tools.find((tool) => tool.name === "runTranslationSubagents").execute("run", {}); await supervisor.waitForAll();
    assert.equal(supervisor.list().find((batch) => batch.kind === "translation").status, "failed");
    assert.equal(providerCalls, 5, JSON.stringify(supervisor.list()));
    const reopened = await repository.open(request.sessionId);
    const durable = await loadYnSessionHostState(reopened, request.sessionId);
    const scope = durable.translationAlignment.ranges["source.txt"][0];
    const lines = splitTextLines(await readFile(scope.candidatePath, "utf8"));
    assert.equal(scope.inputHash, translationAlignmentLinesInputHash(sources, lines, request.languagePair));
    assert.ok(scope.checks.every((check) => check.verdict === "aligned"));
    const restored = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1, restoreSnapshot: durable.domainRun });
    const cold = createYnDomainTools({ request, domainRun: restored, translationAlignmentState: durable.translationAlignment, publishCustomMessage: async () => {},
      subagents: { hasRunning: () => false, hasWriteConflict: () => false, startTranslationBatch() { throw new Error("accepted cold artifacts must not create a worker"); } },
      persistHostState: (options) => appendYnSessionHostState(reopened, { ...durable, domainRun: restored.snapshot() }, options) });
    await cold.find((tool) => tool.name === "runTranslationSubagents").execute("cold", {});
    assert.equal(providerCalls, 5);
  } finally { await supervisor.waitForAll(); await repository.close(); await rm(outputDir, { recursive: true, force: true }); }
});

for (const { appendBeforeFailure, previousRejected } of [{ appendBeforeFailure: false }, { appendBeforeFailure: true }, { appendBeforeFailure: true, previousRejected: true }]) test(`${previousRejected ? "rejected staging repair" : "first real write"} checkpoint ${appendBeforeFailure ? "append-then-fail" : "unwritten failure"} retains pending staging through fatal persistence and real cold review`, async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-first-checkpoint-recovery-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 8 }, (_, index) => `Source sentence ${index + 1} keeps its complete meaning.`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`);
  const repository = new PiSessionRepository(outputDir); const session = await repository.create("first-checkpoint");
  const provider = fauxProvider({ provider: "first-checkpoint", tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(provider.provider);
  let providerCalls = 0;
  provider.setResponses(Array.from({ length: 12 }, () => (context) => {
    providerCalls += 1;
    return context.messages.some((message) => message.role === "toolResult" && message.toolName === "readAssignedSource")
      ? fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", { entries: sourceLines.flatMap((_line, index) => previousRejected && index !== 2 ? [] : [{ line: index + 1, translation: `第${index + 1}行保留本行完整含义。` }]) }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
  }));
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
  const alignment = createTranslationAlignmentHostState();
  let previousScope;
  if (previousRejected) {
    const stage = await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt", sessionId: "first-checkpoint", subagentId: "original-worker", assignmentId: "source.txt:L1-L8" });
    const candidates = sourceLines.map((_line, index) => `第${index + 1}行保留本行完整含义。`);
    candidates[2] = "第三行需要修复自己的含义。";
    await writeFile(stage, `${candidates.join("\n")}\n`);
    previousScope = createTranslationChunkReviewAudit({ documentId: "source.txt", sourceLines, candidateLines: candidates, candidatePath: stage,
      languagePair: "en->zh-CN", fromLine: 1, toLine: 8, sourceLineCount: 8, mechanicalSignals: [{ line: 2, signals: ["accepted-risk"] }, { line: 3, signals: ["semantic_mistranslation"] }] });
    for (const check of previousScope.checks) {
      check.verdict = check.line === 3 ? "misaligned" : "aligned";
      if (check.line === 3) check.reason = "semantic_mistranslation: restore this row's own complete meaning";
    }
    alignment.ranges["source.txt"] = [previousScope];
    previousScope = structuredClone(previousScope);
  }
  let suspended = false, faulted = false;
  const snapshot = () => ({ schemaVersion: 1, ownerSessionId: "first-checkpoint", domainRun: domainRun.snapshot(), workflowSuspended: suspended,
    proofread: createProofreadHostState(), translationAlignment: alignment });
  const persist = async (options = {}) => {
    if (!faulted && !options.force && alignment.ranges["source.txt"]?.length && alignment.ranges["source.txt"][0].inputHash !== previousScope?.inputHash) {
      faulted = true;
      if (!appendBeforeFailure) throw new Error("first checkpoint persistence failed before append");
      await appendYnSessionHostState(session, snapshot(), { appendCustomEntry: async (type, entry) => {
        await appendSessionCustomEntry(session, type, entry); throw new Error("first checkpoint append observer failed");
      } });
    }
    await appendYnSessionHostState(session, snapshot(), { force: true });
  };
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
    createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }),
    onFatalHostFailure: async () => { suspended = true; domainRun.suspend(); await persist({ force: true }); } });
  const request = { outputDir, sourcePath, sessionId: "first-checkpoint", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", providerId: provider.provider.id, modelId: provider.getModel().id,
    languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 1, splitSize: 8, glossaryCandidates: false, characterBible: false };
  const tools = createYnDomainTools({ request, domainRun, subagents: supervisor, translationAlignmentState: alignment,
    publishCustomMessage: async () => {}, persistHostState: persist });
  let coldSupervisor;
  try {
    await tools.find((tool) => tool.name === "inspectTranslationContext").execute("inspect", {});
    await tools.find((tool) => tool.name === "runTranslationSubagents").execute("first-run", {}); await supervisor.waitForAll();
    assert.equal(supervisor.list().find((batch) => batch.kind === "translation").status, "failed");
    assert.equal(providerCalls, 2);
    const root = path.join(outputDir, ".translation-workshop", "agent", "translation-staging");
    const [relativeStage] = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".txt"));
    const stage = path.join(root, relativeStage);
    assert.equal(splitTextLines(await readFile(stage, "utf8")).length, 8);
    const reopened = await repository.open("first-checkpoint");
    const durable = await loadYnSessionHostState(reopened, "first-checkpoint");
    assert.equal(durable.translationAlignment.ranges["source.txt"][0].candidatePath, stage);
    if (previousRejected) {
      const scope = durable.translationAlignment.ranges["source.txt"][0];
      assert.notEqual(scope.inputHash, previousScope.inputHash, "retained repaired bytes require the new verified range hash");
      assert.deepEqual(scope.checks.filter((check) => check.line !== 3), previousScope.checks.filter((check) => check.line !== 3));
      assert.deepEqual(scope.checks.filter((check) => check.verdict === undefined).map((check) => check.line), [3]);
    } else assert.ok(durable.translationAlignment.ranges["source.txt"][0].checks.every((check) => check.verdict === undefined));
    const restored = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1, restoreSnapshot: durable.domainRun });
    let batch, coldSuspended = true;
    const coldProvider = fauxProvider({ provider: "first-checkpoint-cold-review", tokensPerSecond: 100_000 });
    const coldModels = createModels(); coldModels.setProvider(coldProvider.provider);
    let coldProviderCalls = 0;
    coldProvider.setResponses(Array.from({ length: 6 }, () => (context) => {
      coldProviderCalls += 1;
      assert.ok(getCurrentSystemPrompt(context.messages).includes("translation safety reviewer"), "cold recovery must create a read-only reviewer");
      return context.messages.some((message) => message.role === "toolResult")
        ? fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" });
    }));
    coldSupervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
      createModelSelection: async () => ({ models: coldModels, model: coldProvider.getModel(), providerId: coldProvider.provider.id, modelId: coldProvider.getModel().id }) });
    const startReview = coldSupervisor.startTranslationReviewBatch.bind(coldSupervisor);
    coldSupervisor.startTranslationReviewBatch = (options) => { batch = options; return startReview(options); };
    const coldTools = createYnDomainTools({ request: { ...request, providerId: coldProvider.provider.id, modelId: coldProvider.getModel().id }, domainRun: restored,
      translationAlignmentState: durable.translationAlignment, publishCustomMessage: async () => {}, subagents: coldSupervisor,
      isWorkflowSuspended: () => coldSuspended, resumeWorkflow: async () => { coldSuspended = false; restored.resume(); },
      persistHostState: (options) => appendYnSessionHostState(reopened, { ...durable, domainRun: restored.snapshot(), workflowSuspended: coldSuspended }, options) });
    await coldTools.find((tool) => tool.name === "resumeYnWorkflow").execute("resume", { workflow: "translation" });
    await coldTools.find((tool) => tool.name === "runTranslationSubagents").execute("cold-run", {});
    assert.equal(batch.tasks[0].stagingCandidatePath, stage, "the first verified staging write must survive Host checkpoint rollback");
    assert.equal(batch.tasks[0].reviewOnly, true, "already written rows require review rather than another translation call");
    await coldSupervisor.waitForAll();
    assert.equal(coldProviderCalls, 2);
    assert.ok(coldSupervisor.list().every((entry) => entry.status === "completed"));
    await coldTools.find((tool) => tool.name === "runTranslationSubagents").execute("cold-promote-accepted", {});
    await coldSupervisor.waitForAll();
    assert.equal(coldProviderCalls, 2, "accepted staging promotion must be Host-only");
    const finalScope = durable.translationAlignment.ranges["source.txt"][0];
    assert.ok(finalScope.checks.every((check) => check.verdict === "aligned"));
    assert.equal(finalScope.candidatePath, resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" }));
    assert.equal(splitTextLines(await readFile(finalScope.candidatePath, "utf8"))[0], "第1行保留本行完整含义。");
  } finally { await supervisor.waitForAll(); await coldSupervisor?.waitForAll(); await repository.close(); await rm(outputDir, { recursive: true, force: true }); }
});
