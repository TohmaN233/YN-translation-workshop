import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { translationAlignmentInputHash } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-domain-tools-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt"
});
await mkdir(path.dirname(candidatePath), { recursive: true });
await writeFile(sourcePath, "Open the gate.\nSave now.\n", "utf8");
await writeFile(candidatePath, "开门。\n现在保存。\n", "utf8");

const domainRun = createYnDomainRunContract({
  workflowIntent: "translation",
  prompt: "Workflow: yn-translation-v1.",
  subagentEnabled: true,
  subagentCount: 2,
  fullWorkflow: true
});
const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
const tools = createYnDomainTools({
  request: {
    outputDir,
    sourcePath,
    sourceDocumentId: "source.txt",
    sessionId: "reuse-domain-tools",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    reuseExistingTranslation: true,
    subagentEnabled: true,
    subagentCount: 2,
    languagePair: "en->zh-CN"
  },
  publishCustomMessage: async () => {},
  subagents: supervisor,
  domainRun
});
const tool = (name) => {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
};

try {
  assert.doesNotMatch(JSON.stringify(tool("recordTranslationReuseAudit").parameters), /\"review\"/);
  assert.doesNotMatch(JSON.stringify(tool("applyTranslationReuseDecision").parameters), /reuse_accepted_and_review/);
  assert.doesNotMatch(JSON.stringify(tool("applyTranslationReuseDecision").parameters), /auditId/,
    "one folder-level user decision must apply every audit owned by the current run");
  await tool("inspectTranslationContext").execute("inspect", {});
  await assert.rejects(
    tool("runTranslationSubagents").execute("premature-run", {
      tasks: [{ fromLine: 1, toLine: 2 }]
    }),
    /has not been audited/i
  );

  const preparedResult = await tool("prepareTranslationReuseAudit").execute("prepare", {});
  const prepared = preparedResult.details.singleAudit;
  assert.ok(preparedResult.content[0].text.length < 4_000, "prepare result must stay bounded in model context");
  assert.equal(prepared.pendingSemanticLineCount, 1);
  assert.equal(prepared.automaticallyReusableLineCount, 1);
  const batch = await tool("readTranslationReuseAudit").execute("read", {
    auditId: prepared.auditId,
    documentId: "source.txt",
    fromLine: 1,
    toLine: 2
  });
  assert.equal(batch.details.lines.length, 2);
  await tool("recordTranslationReuseAudit").execute("record", {
    auditId: prepared.auditId,
    documentId: "source.txt",
    entries: [
      { line: 1, verdict: "retranslate", reason: "The translation is too compressed to preserve the source meaning." }
    ]
  });
  assert.equal(domainRun.awaitingUserInput, true);
  const parentAuditDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: false,
    subagentCount: 0,
    fullWorkflow: true
  });
  const parentAuditTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools-parent-audit",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: false,
      subagentCount: 0,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: supervisor,
    domainRun: parentAuditDomainRun
  });
  const parentAuditTool = (name) => {
    const found = parentAuditTools.find((entry) => entry.name === name);
    assert.ok(found, `missing parent-audit ${name}`);
    return found;
  };
  await parentAuditTool("inspectTranslationContext").execute("parent-inspect", {});
  const parentPrepared = await parentAuditTool("prepareTranslationReuseAudit").execute("parent-prepare", {});
  const parentRoute = await parentAuditTool("runTranslationReuseAudit").execute("parent-route", {});
  assert.equal(parentRoute.details.status, "parent_audit_required");
  assert.deepEqual(parentRoute.details.assignments, [{
    auditId: parentPrepared.details.singleAudit.auditId,
    documentId: "source.txt",
    fromLine: 1,
    toLine: 1,
    lines: [1]
  }], "a no-child parent audit must receive real bounded IDs instead of inventing them");
  const disabledDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true
  });
  const disabledTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools-disabled",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: false,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: supervisor,
    domainRun: disabledDomainRun
  });
  const disabledApply = disabledTools.find((entry) => entry.name === "applyTranslationReuseDecision");
  assert.ok(disabledApply);
  await assert.rejects(
    disabledApply.execute("disabled-stale-apply", {
      decision: "reuse_accepted"
    }),
    /reuse audit is disabled/i
  );
  assert.equal(await readFile(candidatePath, "utf8"), "开门。\n现在保存。\n");
  const applied = await tool("applyTranslationReuseDecision").execute("apply", {
    decision: "reuse_accepted"
  });
  assert.equal(applied.details.retainedLineCount, 1);
  assert.equal(domainRun.awaitingUserInput, false);
  assert.equal(await readFile(candidatePath, "utf8"), "\n现在保存。\n");

  await writeFile(candidatePath, "打开大门。\n现在保存。\n", "utf8");
  const reuseDebtDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true,
    restoreSnapshot: domainRun.snapshot()
  });
  reuseDebtDomainRun.recordTranslationDiscoveries([{
    id: "reuse-persisted-term",
    kind: "glossary",
    documentId: "source.txt",
    fromLine: 1,
    toLine: 1,
    sourceHash: "audit",
    candidateHash: "audit",
    source: "Open",
    target: "打开",
    category: "setting_term",
    evidenceLine: 1,
    rationale: "persisted"
  }]);
  reuseDebtDomainRun.resolveTranslationDiscoveries(["reuse-persisted-term"], [{
    source: "Open",
    target: "开启",
    observedTargets: ["打开", "开启"]
  }]);
  reuseDebtDomainRun.recordTranslationTerminologyDebt([{
    documentId: "source.txt",
    line: 1,
    source: "Open",
    expectedTarget: "开启",
    observedTargets: ["打开"]
  }]);
  let reuseDebtBatch;
  const reuseDebtTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: {
      hasRunning: () => false,
      startTranslationBatch(options) {
        reuseDebtBatch = options;
        return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
      }
    },
    domainRun: reuseDebtDomainRun
  });
  const reuseDebtTool = (name) => {
    const found = reuseDebtTools.find((entry) => entry.name === name);
    assert.ok(found, `missing reuse-debt ${name}`);
    return found;
  };
  await reuseDebtTool("inspectTranslationContext").execute("inspect-reuse-debt", {});
  await reuseDebtTool("runTranslationSubagents").execute("run-reuse-debt", {});
  assert.ok(reuseDebtBatch);
  assert.deepEqual(
    reuseDebtBatch.priorityTasks.map((task) => [task.documentId, task.fromLine, task.toLine]),
    [["source.txt", 1, 1]],
    "an applied-reuse cold run must inject persisted terminology debt into the real priority queue"
  );
  assert.equal(reuseDebtBatch.priorityTasks[0].terminologyRepair, true);
  assert.equal(reuseDebtBatch.tasks.some((task) => task.fromLine === 1 && task.toLine === 1), true);

  const acceptedSparseAlignment = {
    schemaVersion: 3,
    documents: {},
    ranges: {
      "source.txt": [{
        documentId: "source.txt",
        auditId: "alignment-reused-sparse-accepted",
        inputHash: translationAlignmentInputHash("Open the gate.", "打开大门。", "en->zh-CN"),
        candidatePath,
        sourceLineCount: 2,
        fromLine: 1,
        toLine: 1,
        riskLineCount: 1,
        sampledLineCount: 0,
        checks: [{ line: 1, signals: ["review_repair_target"], verdict: "aligned" }]
      }]
    }
  };
  const validationDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true
  });
  const validationTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: supervisor,
    domainRun: validationDomainRun,
    translationAlignmentState: acceptedSparseAlignment
  });
  const validateArtifact = validationTools.find((entry) => entry.name === "validateTranslationArtifact");
  assert.ok(validateArtifact);
  await validateArtifact.execute("validate-sparse-reuse", {});
  await writeFile(candidatePath, "打开大门。\n用户在停止后改了已保留行。\n", "utf8");
  await assert.rejects(
    validateArtifact.execute("reject-mutated-retained-row", {}),
    /retained translation row changed after the applied reuse decision/i,
    "an accepted rejected-line scope cannot hide a later mutation to an audit-retained row"
  );
  await writeFile(candidatePath, "打开大门。\n现在保存。\n", "utf8");

  const sparseRun = await tool("runTranslationSubagents").execute("run-rejected-lines-only", {});
  assert.equal(sparseRun.details.workerCount, 1);
  assert.equal(sparseRun.details.assignmentCount, 1);
  assert.deepEqual(
    sparseRun.details.assignments,
    [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    "an applied reuse audit must make the Host queue only rejected lines instead of repartitioning the full source"
  );
  supervisor.abortAll();
  await supervisor.waitForAll();

  await writeFile(candidatePath, "已修复。\n现在保存。\n", "utf8");
  const persistedAlignmentState = {
    schemaVersion: 3,
    documents: {},
    ranges: {
      "source.txt": [{
        documentId: "source.txt",
        auditId: "alignment-chunk-persisted-review",
        inputHash: translationAlignmentInputHash(
          "Open the gate.\nSave now.",
          "已修复。\n现在保存。",
          "en->zh-CN"
        ),
        candidatePath,
        sourceLineCount: 2,
        fromLine: 1,
        toLine: 2,
        riskLineCount: 1,
        sampledLineCount: 1,
        checks: [
          { line: 1, signals: ["review_context_failure"], verdict: "misaligned", reason: "Meaning is still wrong." },
          { line: 2, signals: ["deterministic_unflagged_sample"], verdict: "aligned" }
        ]
      }]
    }
  };

  const restartedDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true
  });
  let restartedReviewBatch;
  let restartedPersistCount = 0;
  const restartedSupervisor = {
    hasRunning: () => false,
    startTranslationReviewBatch(options) {
      restartedReviewBatch = options;
      return { id: "reuse-cold-review", kind: "translation-review", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const restartedTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: restartedSupervisor,
    domainRun: restartedDomainRun,
    translationAlignmentState: persistedAlignmentState,
    persistHostState: async () => { restartedPersistCount += 1; }
  });
  const restartedTool = (name) => {
    const found = restartedTools.find((entry) => entry.name === name);
    assert.ok(found, `missing restarted ${name}`);
    return found;
  };
  await restartedTool("inspectTranslationContext").execute("inspect-restart", {});
  const resumedSparseRun = await restartedTool("runTranslationSubagents").execute("resume-rejected-lines-only", {});
  assert.deepEqual(
    resumedSparseRun.details.assignments,
    [{ documentId: "source.txt", fromLine: 1, toLine: 2 }],
    "cold restart must prioritize the persisted review rejection even after the originally rejected reuse row is no longer blank"
  );
  assert.equal(restartedReviewBatch.tasks.length, 1);
  assert.equal(restartedReviewBatch.tasks[0].reviewOnly, true);
  assert.equal(restartedReviewBatch.tasks[0].reviewFeedback, undefined);
  assert.equal(persistedAlignmentState.ranges["source.txt"][0].checks[0].verdict, undefined);
  assert.equal(persistedAlignmentState.ranges["source.txt"][0].checks[0].reason, undefined);
  assert.equal(restartedPersistCount > 0, true, "malformed applied-reuse review debt must be persisted before cold dispatch");

  await writeFile(candidatePath, "用户在停止后改写。\n现在保存。\n", "utf8");
  const staleDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true
  });
  const staleSupervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
  let staleStatePersistCount = 0;
  const staleTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: staleSupervisor,
    domainRun: staleDomainRun,
    translationAlignmentState: persistedAlignmentState,
    persistHostState: async () => { staleStatePersistCount += 1; }
  });
  const staleRunTool = staleTools.find((entry) => entry.name === "runTranslationSubagents");
  assert.ok(staleRunTool);
  const staleRun = await staleRunTool.execute("resume-after-user-edit", {});
  assert.deepEqual(
    staleRun.details.assignments,
    [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    "a candidate edit after Stop must invalidate stale review feedback and return the rejected row to Host review debt"
  );
  assert.equal(persistedAlignmentState.ranges["source.txt"], undefined);
  assert.equal(staleStatePersistCount > 0, true, "stale review evidence must be removed from durable Host state");
  staleSupervisor.abortAll();
  await staleSupervisor.waitForAll();

  await writeFile(candidatePath, "等待审阅。\n现在保存。\n", "utf8");
  const pendingAlignmentState = {
    schemaVersion: 3,
    documents: {},
    ranges: {
      "source.txt": [{
        documentId: "source.txt",
        auditId: "alignment-review-interrupted-before-verdict",
        inputHash: translationAlignmentInputHash(
          "Open the gate.\nSave now.",
          "等待审阅。\n现在保存。",
          "en->zh-CN"
        ),
        candidatePath,
        sourceLineCount: 2,
        fromLine: 1,
        toLine: 2,
        riskLineCount: 1,
        sampledLineCount: 1,
        checks: [
          { line: 1, signals: ["review_context_failure"] },
          { line: 2, signals: ["deterministic_unflagged_sample"] }
        ]
      }]
    }
  };
  const pendingDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true
  });
  const pendingSupervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
  const pendingTools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-domain-tools",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: pendingSupervisor,
    domainRun: pendingDomainRun,
    translationAlignmentState: pendingAlignmentState
  });
  const pendingRunTool = pendingTools.find((entry) => entry.name === "runTranslationSubagents");
  assert.ok(pendingRunTool);
  const pendingRun = await pendingRunTool.execute("resume-interrupted-review", {});
  assert.deepEqual(
    pendingRun.details.assignments,
    [{ documentId: "source.txt", fromLine: 1, toLine: 2 }],
    "Stop during review must resume the interrupted review scope even when every candidate row is non-empty"
  );
  pendingSupervisor.abortAll();
  await pendingSupervisor.waitForAll();
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok full workflow cannot overwrite existing work before semantic audit and user reuse choice");
