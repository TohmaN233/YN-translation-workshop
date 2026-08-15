import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import {
  appendYnSessionHostState,
  createProofreadHostState,
  createTranslationAlignmentHostState,
  loadYnSessionHostState,
  YN_HOST_STATE_DELTA_CUSTOM_TYPE
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function tool(tools, name) {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function execute(tools, name, params = {}) {
  return tool(tools, name).execute(`call_${name}`, params);
}

await test("proofread repair lifecycle survives a real Pi JSONL cold restart without translation queue debt", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-workflow-lifecycle-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const documentId = "source.txt";
  const sessionId = "pi_workflow_lifecycle";
  const proofreadState = createProofreadHostState();
  const translationAlignmentState = createTranslationAlignmentHostState();
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const subagents = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });

  try {
    await writeFile(sourcePath, "one\ntwo\nthree\n", "utf8");
    const translationPath = resolveTranslationCandidatePath({
      outputDir,
      sourcePaths: [sourcePath],
      documentId
    });
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n旧译文\n三\n", "utf8");

    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath,
        sourceDocumentId: documentId,
        sessionId,
        prompt: "Workflow: yn-proofread-v1.",
        workflowIntent: "proofread",
        providerId: "test",
        modelId: "test",
        languagePair: "en->zh-CN",
        subagentEnabled: false
      },
      publishCustomMessage: async () => {},
      subagents,
      domainRun,
      proofreadState,
      translationAlignmentState
    });

    await execute(tools, "inspectTranslationContext", {});
    const initialScope = await execute(tools, "inspectProofreadRange", { fromLine: 2, toLine: 2 });
    const initialFinding = await execute(tools, "writeProofreadFindings", {
      scopeId: initialScope.details.scopeId,
      findings: [{
        id: "H1-stale-line-2",
        severity: "H1",
        type: "accuracy",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "two",
        currentTranslation: "旧译文",
        suggestedFix: "两个",
        rationale: "The old translation is inaccurate."
      }]
    });
    assert.equal(initialFinding.details.totalFindingCount, 1);

    const repository = new PiSessionRepository(outputDir);
    const session = await repository.create(sessionId);
    const hostState = () => ({
      schemaVersion: 1,
      ownerSessionId: sessionId,
      domainRun: domainRun.snapshot(),
      proofread: proofreadState,
      translationAlignment: translationAlignmentState
    });
    await appendYnSessionHostState(session, hostState());

    const repaired = await execute(tools, "writeTranslationChunk", {
      documentId,
      fromLine: 2,
      toLine: 2,
      lines: ["两个"]
    });
    assert.equal(repaired.details.result.linesWritten, 1, repaired.details.result.error);
    assert.equal(await readFile(translationPath, "utf8"), "一\n两个\n三\n");
    assert.deepEqual(domainRun.snapshot().documents[0].proofreadDirtyRanges, [{ fromLine: 2, toLine: 2 }]);

    const replacementScope = await execute(tools, "inspectProofreadRange", { fromLine: 2, toLine: 2 });
    const cleared = await execute(tools, "writeProofreadFindings", {
      scopeId: replacementScope.details.scopeId,
      findings: []
    });
    assert.equal(cleared.details.replacedFindingCount, 1);
    assert.equal(cleared.details.totalFindingCount, 0);
    assert.deepEqual(domainRun.snapshot().documents[0].proofreadDirtyRanges, []);

    const alignmentAudit = await execute(tools, "inspectTranslationAlignment");
    assert.equal(alignmentAudit.details.bounded, true);
    assert.deepEqual(alignmentAudit.details.pendingLines, [2]);
    await execute(tools, "readSourceLines", { fromLine: 2, toLine: 2 });
    await execute(tools, "readTranslationLines", { fromLine: 2, toLine: 2 });
    await execute(tools, "recordTranslationAlignmentChecks", {
      auditId: alignmentAudit.details.auditId,
      failures: []
    });
    const validated = await execute(tools, "validateTranslationArtifact");
    assert.equal(validated.details.validation.accepted, true);
    await appendYnSessionHostState(session, hostState());

    const reportPath = path.join(outputDir, "report", "source.proofread.json");
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")).findings, []);

    const metadata = await repository.findMetadata(sessionId);
    assert.ok(metadata?.path, "the lifecycle must be persisted to a real Pi JSONL file");
    const jsonl = await readFile(metadata.path, "utf8");
    assert.match(jsonl, new RegExp(YN_HOST_STATE_DELTA_CUSTOM_TYPE.replaceAll(".", "\\.")));

    const coldRepository = new PiSessionRepository(outputDir);
    const coldSession = await coldRepository.open(sessionId);
    const loaded = await loadYnSessionHostState(coldSession, sessionId);
    assert.ok(loaded?.domainRun, "cold restart must restore the persisted proofread domain run");
    assert.deepEqual(loaded.proofread, proofreadState);
    assert.deepEqual(loaded.translationAlignment, translationAlignmentState);

    const restoredRun = createYnDomainRunContract({
      workflowIntent: "proofread",
      fullWorkflow: true,
      subagentEnabled: false,
      restoreSnapshot: loaded.domainRun
    });
    const restoredSnapshot = restoredRun.snapshot();
    assert.equal(restoredRun.kind, "proofread");
    assert.equal(restoredSnapshot.fullWorkflowActive, true);
    assert.deepEqual(restoredSnapshot.documents[0].proofreadDirtyRanges, []);
    assert.equal(restoredSnapshot.documents[0].activeSubagentBatch, undefined);
    assert.notEqual(restoredSnapshot.documents[0].completedSubagentBatch?.kind, "translation");
    assert.equal(restoredSnapshot.documents[0].bestTranslationValidationDebt, undefined);
    assert.doesNotMatch(
      restoredRun.incompleteReasons().join("\n"),
      /host-accepted translation batch|translation validation debt|complete translation queue/i
    );
    assert.equal(loaded.parkedDomainRuns?.translation, undefined);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")).findings, []);
  } finally {
    await subagents.abortAll("lifecycle test cleanup");
    await rm(outputDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
