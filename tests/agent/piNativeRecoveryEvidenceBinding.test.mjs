import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import {
  prepareTranslationStagingCandidate,
  resolveTranslationCandidatePath
} from "../../src/main/agent/writeTranslationChunk.ts";

const rejectedLine = 3;
const sourceLines = Array.from({ length: 24 }, (_, index) => `Source sentence ${index + 1} has its own complete meaning.`);
const candidateLines = sourceLines.map((_line, index) => `第${index + 1}行保留本行的完整含义。`);

async function fixture({ takeover = true } = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-recovery-binding-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
  const canonicalPath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, `${candidateLines.join("\n")}\n`, "utf8");
  const request = {
    outputDir, sourcePath, sessionId: "pi_recovery_binding", prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation", providerId: "test", modelId: "test", languagePair: "en->zh-CN",
    subagentEnabled: true, subagentCount: 1, reviewSubagentCount: 1, splitSize: 500
  };
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
  const translationAlignmentState = createTranslationAlignmentHostState();
  let batch;
  let suspended = false;
  let failPersistence = false;
  const subagents = {
    hasRunning: () => false,
    hasWriteConflict: () => false,
    startTranslationBatch(options) {
      batch = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const tools = createYnDomainTools({
    request, domainRun, translationAlignmentState, subagents, publishCustomMessage: async () => {},
    isWorkflowSuspended: () => suspended,
    async resumeWorkflow() { suspended = false; domainRun.resume(); },
    async persistHostState() { if (failPersistence) throw new Error("injected checkpoint persistence failure"); }
  });
  const execute = (name, params = {}) => tools.find((entry) => entry.name === name).execute(`call_${name}`, params);
  const checkpoint = (candidatePath, requiredLines = []) => batch.onStagingCandidateCheckpoint({
    documentId: "source.txt", fromLine: 1, toLine: sourceLines.length,
    candidatePath, accepted: true, requiredLines,
    repairIssues: requiredLines.map((absoluteLine) => ({ absoluteLine, code: "semantic_mistranslation", detail: "restore this row's own complete meaning" }))
  });
  try {
    await execute("inspectTranslationContext");
    const run = await execute("runTranslationSubagents");
    const originalStaging = await prepareTranslationStagingCandidate({
      outputDir, sourcePaths: [sourcePath], documentId: "source.txt", sessionId: request.sessionId,
      subagentId: "exhausted-worker", assignmentId: "source.txt:L1-L24"
    });
    await writeFile(originalStaging, `${candidateLines.join("\n")}\n`, "utf8");
    await checkpoint(originalStaging, [2, rejectedLine]);
    const original = translationAlignmentState.ranges["source.txt"][0];
    for (const check of original.checks) {
      if (check.line !== rejectedLine) {
        check.verdict = "aligned";
        delete check.reason;
      }
    }
    assert.ok(original.sampledLineCount > 0, "the regression must include retained deterministic sample evidence");
    assert.ok(original.checks.some((check) => check.line !== rejectedLine && check.signals.includes("host_repaired_line")),
      "the regression must include previously accepted high-risk evidence");
    if (takeover) {
      const parentTakeover = {
        documentId: "source.txt", fromLine: 1, toLine: sourceLines.length, rejectedLines: [rejectedLine],
        feedback: "semantic_mistranslation: restore this row's own complete meaning", stagingCandidatePath: originalStaging,
        candidateHash: createHash("sha256").update(JSON.stringify({ fromLine: 1, toLine: sourceLines.length, candidate: candidateLines })).digest("hex")
      };
      await batch.onParentTakeover(parentTakeover);
      await batch.onSettled({
        batch: { id: run.details.batchId, status: "failed", subagents: [{ id: "exhausted-worker", failureDisposition: "parent_takeover_required", parentTakeovers: [parentTakeover] }] },
        results: [], failures: [{ documentId: "source.txt", fromLine: 1, toLine: sourceLines.length, error: "review repair exhausted", failureDisposition: "parent_takeover_required" }],
        error: new Error("review repair exhausted")
      });
      assert.equal(translationAlignmentState.ranges["source.txt"][0].candidatePath, canonicalPath);
      assert.match(translationAlignmentState.ranges["source.txt"][0].auditId, /^alignment-mutation-/);
    } else {
      // Model a stopped Host batch, retaining the same hash-current staging review scope.
      domainRun.recordSubagentBatchFailure("translation", run.details.batchId, ["source.txt"]);
      domainRun.resumeAfterExplicitContinuation(domainRun.recoveryPauseId);
    }
    domainRun.suspend();
    suspended = true;
    await execute("resumeYnWorkflow", { workflow: "translation" });
    await execute("runTranslationSubagents");
    assert.equal(batch.tasks.length, 1);
    assert.deepEqual(batch.tasks[0].reviewFeedback.map((entry) => entry.line), [rejectedLine]);
    assert.equal(batch.tasks[0].stagingCandidatePath, takeover ? undefined : originalStaging);
    const stagingPath = takeover ? await prepareTranslationStagingCandidate({
      outputDir, sourcePaths: [sourcePath], documentId: "source.txt", sessionId: request.sessionId,
      subagentId: "resumed-worker", assignmentId: "source.txt:L1-L24"
    }) : originalStaging;
    if (takeover) assert.equal(await readFile(stagingPath, "utf8"), await readFile(canonicalPath, "utf8"));
    return {
      outputDir, sourcePath, canonicalPath, stagingPath, translationAlignmentState, checkpoint,
      batch: () => batch,
      prepare: () => batch.onStagingCandidatePrepared({ documentId: "source.txt", fromLine: 1, toLine: sourceLines.length, candidatePath: stagingPath }),
      failPersistence: (value) => { failPersistence = value; },
      async repair() {
        const lines = [...candidateLines];
        lines[rejectedLine - 1] = "修复后第三行准确保留本行含义。";
        await writeFile(stagingPath, `${lines.join("\n")}\n`, "utf8");
      },
      async close() { await rm(outputDir, { recursive: true, force: true }); }
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

test("parent takeover then resume binds fresh staging to exact rejected evidence and retains accepted risk/sample checks", async () => {
  const fx = await fixture();
  try {
    const previous = structuredClone(fx.translationAlignmentState.ranges["source.txt"][0]);
    await fx.prepare();
    await fx.repair();
    await fx.checkpoint(fx.stagingPath);
    const rebound = fx.translationAlignmentState.ranges["source.txt"][0];
    assert.equal(rebound.candidatePath, fx.stagingPath);
    assert.deepEqual(rebound.checks.filter((check) => !check.verdict).map((check) => check.line), [rejectedLine]);
    assert.deepEqual(rebound.checks.filter((check) => check.line !== rejectedLine), previous.checks.filter((check) => check.line !== rejectedLine));
    const prepared = await fx.batch().prepareChunkReview({
      subagentId: "resumed-worker", label: "Resumed worker", documentId: "source.txt", fromLine: 1, toLine: sourceLines.length,
      candidatePath: fx.stagingPath, validation: { ok: true, accepted: true, blocking: [], warnings: [] }, discoveries: { glossaryCandidates: [], characterFacts: [] }
    });
    const assignment = await prepared.read(prepared.task);
    assert.deepEqual([...new Set(assignment.windows.flatMap((window) => window.rows).filter((row) => row.selected).map((row) => row.line))], [rejectedLine]);
    assert.deepEqual(await prepared.submit(prepared.task, []), { accepted: true });
    assert.ok(fx.translationAlignmentState.ranges["source.txt"][0].checks.every((check) => check.verdict === "aligned"));
  } finally { await fx.close(); }
});

for (const stale of ["source", "canonical", "non-rejected staging row"]) {
  test(`recovery handoff rejects ${stale} changes without changing retained evidence`, async () => {
    const fx = await fixture();
    try {
      const snapshot = structuredClone(fx.translationAlignmentState);
      const changedPath = stale === "source" ? fx.sourcePath : stale === "canonical" ? fx.canonicalPath : fx.stagingPath;
      const lines = (await readFile(changedPath, "utf8")).split("\n");
      lines[0] += stale === "source" ? " Changed source content." : "新增加的内容。";
      await writeFile(changedPath, lines.join("\n"), "utf8");
      await assert.rejects(() => fx.prepare(), /review evidence is stale|prepared staging candidate changed/);
      assert.deepEqual(fx.translationAlignmentState, snapshot);
    } finally { await fx.close(); }
  });
}

test("failed recovery handoff persistence rolls back evidence and preserves the staged artifact for a safe retry", async () => {
  const fx = await fixture();
  try {
    const snapshot = structuredClone(fx.translationAlignmentState);
    const stagingText = await readFile(fx.stagingPath, "utf8");
    const canonicalText = await readFile(fx.canonicalPath, "utf8");
    fx.failPersistence(true);
    await assert.rejects(() => fx.prepare(), /injected checkpoint persistence failure/);
    assert.deepEqual(fx.translationAlignmentState, snapshot);
    assert.equal(await readFile(fx.stagingPath, "utf8"), stagingText);
    assert.equal(await readFile(fx.canonicalPath, "utf8"), canonicalText);
    fx.failPersistence(false);
    await fx.prepare();
    await fx.repair();
    await fx.checkpoint(fx.stagingPath);
    assert.equal(fx.translationAlignmentState.ranges["source.txt"][0].candidatePath, fx.stagingPath);
  } finally { await fx.close(); }
});

test("interrupted same-staging recovery continues its exact repair without reopening accepted checks", async () => {
  const fx = await fixture({ takeover: false });
  try {
    const previous = structuredClone(fx.translationAlignmentState.ranges["source.txt"][0]);
    await fx.prepare();
    await fx.repair();
    await fx.checkpoint(fx.stagingPath);
    const current = fx.translationAlignmentState.ranges["source.txt"][0];
    assert.equal(current.candidatePath, fx.stagingPath);
    assert.deepEqual(current.checks.filter((check) => !check.verdict).map((check) => check.line), [rejectedLine]);
    assert.deepEqual(current.checks.filter((check) => check.line !== rejectedLine), previous.checks.filter((check) => check.line !== rejectedLine));
  } finally { await fx.close(); }
});

test("a suspended recovery pause resumes through the Host transaction and clears the supervisor fatal barrier", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-recovery-barrier-"));
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
  domainRun.recordInspection({ sourceLineCount: 24, documents: [{ id: "source.txt", sourceLineCount: 24 }], glossaryCandidateExists: true, characterBibleExists: true });
  domainRun.recordSubagentBatchStarted("translation", "failed-host-batch", {
    taskCount: 1, workerCount: 1, documentIds: ["source.txt"], assignmentCounts: { "source.txt": 1 }
  });
  domainRun.recordSubagentBatchFailure("translation", "failed-host-batch", ["source.txt"]);
  const pauseId = domainRun.recoveryPauseId;
  assert.ok(pauseId);
  domainRun.suspend();
  let suspended = true;
  let resumeCalls = 0;
  let failResume = true;
  const subagents = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
  const fatalError = new Error("original Host integrity failure");
  await subagents.stopForHostFailure(fatalError);
  const request = { outputDir, sourcePath: path.join(outputDir, "source.txt"), sessionId: "pi_recovery_barrier", prompt: "continue", workflowIntent: "translation", providerId: "test", modelId: "test" };
  const probeBarrier = () => subagents.startGeneralBatch({ request, tasks: [] });
  assert.throws(probeBarrier, (error) => error === fatalError);
  const tools = createYnDomainTools({
    request, domainRun, subagents, publishCustomMessage: async () => {},
    isWorkflowSuspended: () => suspended,
    async resumeWorkflow(kind) {
      resumeCalls += 1;
      assert.equal(kind, "translation");
      assert.equal(domainRun.recoveryPauseId, pauseId, "explicit continuation must follow the Host resume transaction");
      if (failResume) throw new Error("injected Host resume transaction failure");
      domainRun.resume();
      suspended = false;
      subagents.resumeAfterHostFailure();
    }
  });
  const resume = () => tools.find((entry) => entry.name === "resumeYnWorkflow").execute("call_resume", { workflow: "translation" });
  try {
    await assert.rejects(resume, /injected Host resume transaction failure/);
    assert.equal(resumeCalls, 1);
    assert.equal(domainRun.recoveryPauseId, pauseId);
    assert.equal(suspended, true);
    assert.throws(probeBarrier, (error) => error === fatalError);
    failResume = false;
    const result = await resume();
    assert.equal(resumeCalls, 2);
    assert.equal(result.details.status, "recovery_resumed");
    assert.equal(result.details.pauseId, pauseId);
    assert.equal(domainRun.recoveryPauseId, undefined);
    assert.equal(suspended, false);
    // With the fatal barrier cleared, validation reaches the normal empty-batch
    // guard; no child runtime or provider call is created by this probe.
    assert.throws(probeBarrier, /requires at least one assignment/);
  } finally {
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});
