import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import {
  appendYnSessionHostState,
  createProofreadHostState,
  getYnHostStateLoadDiagnostics,
  loadYnSessionHostState,
  proofreadDocumentHostState
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-proofread-host-state-"));

try {
  const repository = new PiSessionRepository(workspaceDir);
  const session = await repository.create("proofread-owner");
  const metadata = await session.getMetadata();
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    proofreadMode: "montecarlo"
  });
  domainRun.recordInspection({
    sourceLineCount: 12,
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  domainRun.recordProofreadPrescan();
  domainRun.recordProofreadMontecarloRound(2);
  const parkedTranslationRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true
  });
  parkedTranslationRun.recordInspection({
    sourceLineCount: 12,
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  parkedTranslationRun.recordTranslationReuseAuditReady(["parked-translation-debt"]);

  const proofread = createProofreadHostState();
  const document = proofreadDocumentHostState(proofread, "default");
  document.sampledLines = [2, 5, 9];
  document.reportInitialized = true;
  document.completedSplitScopes = [{
    inputHash: "hash-1",
    translationPath: "AI_translation/candidate.txt",
    fromLine: 1,
    toLine: 4
  }];
  document.glossaryCandidates = [{
    id: "proofread-term-1",
    source: "Astra",
    target: "阿斯特拉",
    category: "proper_noun",
    evidenceLine: 5,
    rationale: "Named setting entity",
    status: "pending"
  }];
  document.prescan = {
    inputHash: "hash-1",
    translationPath: "AI_translation/candidate.txt",
    summary: {
      sourceLineCount: 12,
      translationLineCount: 12,
      signalCount: 2,
      severityCounts: { H1: 1, H2: 0, H3: 0, H4: 1, H5: 0, H6: 0, H7: 0, H8: 0, H9: 0 }
    }
  };

  await appendYnSessionHostState(session, {
    schemaVersion: 1,
    ownerSessionId: metadata.id,
    domainRun: domainRun.snapshot(),
    parkedDomainRuns: { translation: parkedTranslationRun.snapshot() },
    proofread
  });

  const reopened = await repository.open(metadata.id);
  const restored = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(restored?.ownerSessionId, metadata.id);
  assert.equal(restored?.domainRun?.proofreadMontecarloRounds, 1);
  assert.equal(restored?.parkedDomainRuns?.translation?.activeKind, "translation");
  assert.deepEqual(
    restored?.parkedDomainRuns?.translation?.pendingTranslationReuseAuditIds,
    ["parked-translation-debt"]
  );
  assert.deepEqual(restored?.proofread.documents.default.sampledLines, [2, 5, 9]);
  assert.equal(restored?.proofread.documents.default.reportInitialized, true);
  assert.deepEqual(restored?.proofread.documents.default.completedSplitScopes, document.completedSplitScopes);
  assert.equal(restored?.proofread.documents.default.glossaryCandidates[0].source, "Astra");

  await appendYnSessionHostState(reopened, {
    schemaVersion: 1,
    ownerSessionId: metadata.id,
    domainRun: domainRun.snapshot(),
    proofread,
    translationAlignment: {
      schemaVersion: 3,
      documents: {},
      ranges: {
        default: [{
          documentId: "default",
          auditId: "review-before-legacy-stop",
          inputHash: "candidate-before-stop",
          candidatePath: "AI_translation/candidate.txt",
          sourceLineCount: 12,
          fromLine: 1,
          toLine: 12,
          riskLineCount: 1,
          sampledLineCount: 1,
          checks: [{ line: 5, signals: ["review_context_failure"], verdict: "misaligned", reason: "Wrong name." }]
        }]
      }
    }
  });
  await appendYnSessionHostState(reopened, {
    schemaVersion: 1,
    ownerSessionId: metadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: { schemaVersion: 3, documents: {}, ranges: {} }
  });
  const migratedLegacyStop = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(migratedLegacyStop?.domainRun, undefined);
  assert.equal(
    migratedLegacyStop?.translationAlignment.ranges.default?.[0]?.checks[0]?.reason,
    "Wrong name.",
    "the old Stop tombstone must not erase hash-bound review debt written immediately before it"
  );
  assert.deepEqual(migratedLegacyStop?.proofread.documents.default.sampledLines, [2, 5, 9]);

  const newerLocalRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false
  });
  const newerLocalSnapshot = newerLocalRun.snapshot();
  const boundedProofread = createProofreadHostState();
  boundedProofread.localScopes["bounded-local-repair"] = {
    id: "bounded-local-repair",
    documentId: "default",
    inputHash: "bounded-local-input",
    translationPath: "AI_translation/candidate.txt",
    fromLine: 5,
    toLine: 5
  };
  await appendYnSessionHostState(reopened, {
    schemaVersion: 1,
    ownerSessionId: metadata.id,
    domainRun: newerLocalSnapshot,
    proofread: boundedProofread,
    translationAlignment: migratedLegacyStop.translationAlignment
  });
  const migratedMixedSession = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(
    migratedMixedSession?.domainRun?.fullWorkflowActive,
    false,
    "an older incomplete full workflow must never replace the newer local typed contract"
  );
  assert.deepEqual(
    migratedMixedSession?.domainRun,
    JSON.parse(JSON.stringify(newerLocalSnapshot)),
    "the loader must preserve the complete newer local contract"
  );
  assert.equal(migratedMixedSession?.workflowSuspended, undefined);
  assert.deepEqual(
    migratedMixedSession?.proofread.localScopes["bounded-local-repair"],
    boundedProofread.localScopes["bounded-local-repair"],
    "the newer bounded scope remains authoritative"
  );
  assert.equal(
    getYnHostStateLoadDiagnostics(reopened)?.skippedStaleWorkflowRevivalCount,
    1,
    "skipping the conflicting legacy full workflow must remain observable"
  );

  const laterIndependentLocalRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: false
  });
  await appendYnSessionHostState(reopened, {
    schemaVersion: 1,
    ownerSessionId: metadata.id,
    domainRun: laterIndependentLocalRun.snapshot(),
    proofread: createProofreadHostState(),
    translationAlignment: migratedLegacyStop.translationAlignment
  });
  const unrelatedLaterRun = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(
    unrelatedLaterRun?.domainRun?.fullWorkflowActive,
    false,
    "migration must inspect only the adjacent legacy Stop sequence and never resurrect an older unrelated workflow"
  );
  assert.equal(unrelatedLaterRun?.workflowSuspended, undefined);

  const largeStaticPayload = "x".repeat(24_000);
  const baseSnapshot = laterIndependentLocalRun.snapshot();
  for (let index = 1; index <= 520; index += 1) {
    await appendYnSessionHostState(reopened, {
      schemaVersion: 1,
      ownerSessionId: metadata.id,
      domainRun: { ...baseSnapshot, progressRevision: index, largeStaticPayload },
      proofread: createProofreadHostState(),
      translationAlignment: migratedLegacyStop.translationAlignment
    });
  }
  const boundedHistory = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(boundedHistory?.domainRun?.progressRevision, 520);
  const loadDiagnostics = getYnHostStateLoadDiagnostics(reopened);
  assert.ok(loadDiagnostics?.reconstructedStateCount >= 520, "the test must reconstruct a long checkpoint/delta chain");
  assert.ok(
    loadDiagnostics.peakRetainedStateCount <= 5,
    `cold loading retained ${loadDiagnostics.peakRetainedStateCount} reconstructed states`
  );

  const context = await reopened.buildContext();
  assert.deepEqual(context.messages, [], "Host custom state must not enter the Pi model transcript");

  await assert.rejects(
    () => loadYnSessionHostState(reopened, "another-session"),
    /belongs to a different Pi session/
  );
  console.log("ok proofreading Host state survives Pi JSONL reopen without polluting buildContext");
} finally {
  await rm(workspaceDir, { recursive: true, force: true });
}
