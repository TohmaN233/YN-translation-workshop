import { readSessionConversation, readSessionEntries, appendSessionCustomEntry } from "../helpers/pi-session.mjs";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  YN_HOST_STATE_DELTA_CUSTOM_TYPE,
  appendYnSessionHostState,
  createProofreadHostState,
  getYnHostStateLoadDiagnostics,
  loadYnSessionHostState,
  YN_RUNTIME_CONTRACT_VERSION
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import {
  applyJsonDelta,
  createJsonDelta,
  hostStateHash,
  validateJsonDeltaOperations
} from "../../src/main/agent/piNative/hostStateDelta.ts";
import { createTranslationChunkReviewAudit } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { getDiskSessionAccess } from "../../src/main/agent/piNative/sessionAccess.ts";

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-host-state-delta-"));

try {
  const arrayBefore = { records: [{ id: "a" }, { id: "b" }] };
  const arrayAfter = { records: [{ id: "a" }, { id: "b" }, { id: "c", payload: "new" }] };
  const appendOperations = createJsonDelta(arrayBefore, arrayAfter);
  assert.deepEqual(appendOperations, [{
    op: "append",
    path: ["records"],
    values: [{ id: "c", payload: "new" }]
  }]);
  assert.deepEqual(applyJsonDelta(arrayBefore, appendOperations, 3), arrayAfter);

  const edited = { records: [{ id: "a", status: "edited" }, { id: "b" }] };
  assert.deepEqual(applyJsonDelta(arrayBefore, createJsonDelta(arrayBefore, edited), 3), edited);
  const removed = { records: [{ id: "b" }] };
  const removalOperations = createJsonDelta(arrayBefore, removed);
  assert.equal(removalOperations[0]?.op, "splice", "array removals use an explicit positional splice");
  assert.deepEqual(applyJsonDelta(arrayBefore, removalOperations, 3), removed);
  const inserted = { records: [{ id: "a" }, { id: "between" }, { id: "b" }] };
  const insertionOperations = createJsonDelta(arrayBefore, inserted);
  assert.deepEqual(insertionOperations, [{
    op: "splice",
    path: ["records"],
    index: 1,
    deleteCount: 0,
    items: [{ id: "between" }]
  }]);
  assert.deepEqual(applyJsonDelta(arrayBefore, insertionOperations, 3), inserted);
  const reordered = { records: [{ id: "b" }, { id: "a" }] };
  assert.deepEqual(applyJsonDelta(arrayBefore, createJsonDelta(arrayBefore, reordered), 3), reordered);

  assert.throws(() => validateJsonDeltaOperations([
    { op: "splice", path: ["records"], index: 0.5, deleteCount: 0, items: [{ id: "x" }] }
  ], 3), /splice operation 0 is invalid/);
  assert.throws(() => validateJsonDeltaOperations([
    { op: "splice", path: ["records"], index: 0, deleteCount: -1, items: [] }
  ], 3), /splice operation 0 is invalid/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "append", path: ["missing"], values: [1] }
  ], 3), /path does not exist/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "append", path: ["records", 8], values: [1] }
  ], 3), /path does not exist/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "append", path: ["records", 0], values: [1] }
  ], 3), /target is not an array/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "splice", path: ["records"], index: 2, deleteCount: 1, items: [] }
  ], 3), /outside its array/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "splice", path: ["records"], index: 3, deleteCount: 0, items: [{ id: "x" }] }
  ], 3), /outside its array/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "set", path: ["records", 2], value: { id: "x" } }
  ], 3), /array index is outside/);
  assert.throws(() => applyJsonDelta(arrayBefore, [
    { op: "append", path: ["records"], values: [1] }
  ], 2), /schema 2.*schema 3 operation/);

  const repository = new PiSessionRepository(workspaceDir);
  const session = await repository.create("host-state-delta-owner");
  const metadata = await Promise.resolve(session.metadata);
  const sourceLines = Array.from({ length: 1_024 }, (_, index) =>
    `Source row ${index + 1} carries a distinct complete sentence.`
  );
  const candidateLines = sourceLines.map((_line, index) => `这是第 ${index + 1} 行独立完整的中文译文。`);
  const scope = createTranslationChunkReviewAudit({
    documentId: "chapter.txt",
    sourceText: sourceLines.join("\n"),
    candidateText: candidateLines.join("\n"),
    candidatePath: path.join(workspaceDir, "AI_translation", "chapter_translated.txt"),
    languagePair: "en->zh-CN",
    fromLine: 1,
    sourceLineCount: sourceLines.length
  });
  scope.checks.forEach((check) => { check.verdict = "aligned"; });
  const state = {
    schemaVersion: 1,
    ownerSessionId: metadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: {
      schemaVersion: 3,
      documents: {},
      ranges: { "chapter.txt": [scope] }
    }
  };
  const fullSnapshotBytes = Buffer.byteLength(JSON.stringify(state));

  await appendYnSessionHostState(session, state);
  await appendYnSessionHostState(session, state);
  assert.equal(
    (await readSessionEntries(session)).filter((entry) => entry.type === "custom" && entry.customType === "yn.host-state.v2").length,
    1,
    "persisting an unchanged Host state must not append an empty delta"
  );
  for (let index = 0; index < 64; index += 1) {
    const check = scope.checks[index % scope.checks.length];
    check.reason = `accepted mutation ${index + 1}`;
    await appendYnSessionHostState(session, state);
  }

  const fileInfo = await stat(metadata.path);
  const entries = await readSessionEntries(session);
  const hostEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === "yn.host-state.v2");
  assert.equal(hostEntries.length, 65);
  assert.ok(hostEntries.every((entry) => entry.data?.schemaVersion === 3));
  assert.equal(hostEntries.filter((entry) => entry.data?.mode === "checkpoint").length, 1);
  assert.equal(hostEntries.filter((entry) => entry.data?.mode === "delta").length, 64);
  assert.ok(
    hostEntries.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry.data)), 0) < fullSnapshotBytes * 16,
    `incremental Host payload must remain bounded inside native v4 transactions; JSONL=${fileInfo.size}, full=${fullSnapshotBytes}`
  );

  const reopened = await repository.open(metadata.id);
  const restored = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(
    restored?.translationAlignment.ranges["chapter.txt"][0].checks[63 % scope.checks.length].reason,
    "accepted mutation 64"
  );
  assert.deepEqual((await readSessionConversation(reopened)).messages, []);

  console.log("ok Pi Host state uses bounded checkpoint-plus-delta persistence and reloads exactly");

  const growthSession = await repository.create("host-state-array-growth-owner");
  const growthMetadata = await Promise.resolve(growthSession.metadata);
  const growthState = {
    schemaVersion: 1,
    ownerSessionId: growthMetadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: { schemaVersion: 3, documents: {}, ranges: {} }
  };
  const growthDocumentId = "growth.txt";
  const growthScopeCount = 128;
  const createGrowthScope = (index) => {
    const sourceLinesForScope = [`Source segment ${index + 1} carries one distinct complete sentence.`];
    const candidateLinesForScope = [`这是第 ${index + 1} 段独立且完整的译文。`];
    const nextScope = createTranslationChunkReviewAudit({
      documentId: growthDocumentId,
      sourceLines: sourceLinesForScope,
      candidateLines: candidateLinesForScope,
      candidatePath: path.join(workspaceDir, "AI_translation", "growth_translated.txt"),
      languagePair: "en->zh-CN",
      fromLine: index + 1,
      sourceLineCount: growthScopeCount + 1
    });
    nextScope.checks.forEach((check) => { check.verdict = "aligned"; });
    return nextScope;
  };
  growthState.translationAlignment.ranges[growthDocumentId] = [createGrowthScope(0)];
  await appendYnSessionHostState(growthSession, growthState);
  for (let index = 1; index <= growthScopeCount; index += 1) {
    const nextScope = createGrowthScope(index);
    growthState.translationAlignment.ranges[growthDocumentId].push(nextScope);
    await appendYnSessionHostState(growthSession, growthState);
  }
  const growthEntries = (await readSessionEntries(growthSession)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  ));
  const growthDeltaEntries = growthEntries.filter((entry) => entry.data?.mode === "delta");
  assert.equal(growthDeltaEntries.length, growthScopeCount);
  assert.ok(growthDeltaEntries.every((entry) => (
    entry.data?.schemaVersion === 3
    && entry.data.operations?.length === 1
    && entry.data.operations[0]?.op === "append"
  )), "growing review-scope arrays must persist only the appended scope");
  const growthFinalBytes = Buffer.byteLength(JSON.stringify(growthState));
  const growthFileBytes = (await stat(growthMetadata.path)).size;
  assert.ok(growthFileBytes > 128 * 1024, "worker replay scheduling should be exercised by a disk-backed session above the threshold");
  assert.ok(
    growthFileBytes < growthFinalBytes * 4,
    `128 appended scopes should stay linear in JSONL bytes: file=${growthFileBytes}, final checkpoint=${growthFinalBytes}`
  );
  const growthReopened = await repository.open(growthMetadata.id);
  const replayProgress = [];
  const growthRestored = await loadYnSessionHostState(growthReopened, growthMetadata.id, {
    onReplayProgress: (processedEntries, totalEntries) => replayProgress.push({ processedEntries, totalEntries })
  });
  assert.equal(growthRestored?.translationAlignment.ranges[growthDocumentId]?.length, growthScopeCount + 1);
  assert.ok(replayProgress.length > 0 && replayProgress.at(-1).processedEntries > 0);
  assert.equal(replayProgress.at(-1).totalEntries, 0, "progress reports zero when a total is unavailable");
  const replayedHash = (await readSessionEntries(growthReopened)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  )).at(-1).data.stateHash;
  growthRestored.workflowSuspended = true;
  await appendYnSessionHostState(growthReopened, growthRestored);
  const postReplayEntries = (await readSessionEntries(growthReopened)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  ));
  assert.equal(postReplayEntries.at(-1)?.data?.mode, "delta", "worker replay must restore the owner persistence cursor");
  assert.equal(postReplayEntries.at(-1)?.data?.baseHash, replayedHash);
  const workerSession = await repository.create("host-state-background-replay-owner");
  const workerMetadata = await Promise.resolve(workerSession.metadata);
  const workerState = {
    schemaVersion: 1,
    ownerSessionId: workerMetadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: { schemaVersion: 3, documents: {}, ranges: {} }
  };
  workerState.proofread.documents["large-state.txt"] = {
    sampledLines: [],
    reportInitialized: false,
    completedSplitScopes: [],
    glossaryCandidates: [{
      id: "large-rationale",
      source: "Long source record",
      target: "长译文记录",
      category: "title",
      evidenceLine: 1,
      rationale: "evidence ".repeat(120_000),
      status: "pending"
    }]
  };
  await appendYnSessionHostState(workerSession, workerState);
  const workerStateHash = (await readSessionEntries(workerSession)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  )).at(-1).data.stateHash;
  assert.ok((await stat(workerMetadata.path)).size > 1024 * 1024);
  await repository.closeSession(workerMetadata.id);
  const coldWorkerSession = await repository.open(workerMetadata.id);
  const workerProgress = [];
  const workerRestored = await loadYnSessionHostState(coldWorkerSession, workerMetadata.id, {
    onReplayProgress: (processedEntries, totalEntries) => workerProgress.push({ processedEntries, totalEntries })
  });
  assert.equal(getYnHostStateLoadDiagnostics(coldWorkerSession)?.replayThread, "worker");
  assert.equal(workerRestored?.proofread.documents["large-state.txt"].glossaryCandidates[0].rationale.length, "evidence ".repeat(120_000).length);
  assert.deepEqual(workerProgress.at(-1), { processedEntries: 1, totalEntries: 0 });
  workerRestored.workflowSuspended = true;
  await appendYnSessionHostState(coldWorkerSession, workerRestored);
  const workerDelta = (await readSessionEntries(coldWorkerSession)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  )).at(-1).data;
  assert.equal(workerDelta.mode, "delta");
  assert.equal(workerDelta.baseHash, workerStateHash, "worker replay must restore the hash-bound append cursor");
  const progressFailure = new Error("replay progress callback failed");
  await repository.closeSession(workerMetadata.id);
  const callbackFailureSession = await repository.open(workerMetadata.id);
  await assert.rejects(
    () => loadYnSessionHostState(callbackFailureSession, workerMetadata.id, {
      onReplayProgress: () => { throw progressFailure; }
    }),
    (error) => error === progressFailure
  );
  assert.equal(
    getYnHostStateLoadDiagnostics(callbackFailureSession),
    undefined,
    "callback failure must not install a partial worker replay result"
  );
  const validWorkerTail = (await readSessionEntries(callbackFailureSession)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  )).at(-1).data;
  await appendSessionCustomEntry(callbackFailureSession, YN_HOST_STATE_DELTA_CUSTOM_TYPE, {
    schemaVersion: 3,
    runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
    ownerSessionId: workerMetadata.id,
    mode: "delta",
    projectPathsVersion: 1,
    baseHash: validWorkerTail.stateHash,
    stateHash: "incorrect-worker-state-hash",
    operations: [{ op: "set", path: ["workflowSuspended"], value: false }]
  });
  await assert.rejects(
    () => loadYnSessionHostState(callbackFailureSession, workerMetadata.id),
    /delta hash does not match its reconstructed state/
  );
  assert.equal(getYnHostStateLoadDiagnostics(callbackFailureSession), undefined);

  const noHostSession = await repository.create("large-session-without-host-state");
  const noHostMetadata = await Promise.resolve(noHostSession.metadata);
  const unrelatedEntryId = await appendSessionCustomEntry(noHostSession, "unrelated.large-payload", { text: "context ".repeat(150_000) });
  assert.ok((await stat(noHostMetadata.path)).size > 1024 * 1024);
  const noHostColdSession = await repository.open(noHostMetadata.id);
  const noHostDisk = getDiskSessionAccess(noHostColdSession);
  assert.ok(noHostDisk);
  let unrelatedPayloadDecodeCount = 0;
  const originalGetEntries = noHostDisk.storage.getEntries.bind(noHostDisk.storage);
  noHostDisk.storage.getEntries = async (ids, context) => {
    if (ids.includes(unrelatedEntryId)) unrelatedPayloadDecodeCount += 1;
    return originalGetEntries(ids, context);
  };
  const originalScanBranch = noHostDisk.storage.scanBranch.bind(noHostDisk.storage);
  noHostDisk.storage.scanBranch = async (query, context) => {
    const entries = await originalScanBranch(query, context);
    if (entries.some((entry) => entry.id === unrelatedEntryId)) unrelatedPayloadDecodeCount += 1;
    return entries;
  };
  assert.equal(await loadYnSessionHostState(noHostColdSession, noHostMetadata.id), undefined);
  assert.equal(unrelatedPayloadDecodeCount, 0, "cold Host replay must not decode unrelated large custom payloads");
  assert.equal(
    getYnHostStateLoadDiagnostics(noHostColdSession)?.replayThread,
    "main",
    "large sessions with no Host-state entries should avoid worker startup and replay work"
  );
  console.log(
    `ok appending ${growthScopeCount + 1} review scopes emits positional array deltas `
    + `with linear JSONL growth (jsonl=${growthFileBytes}B, finalState=${growthFinalBytes}B)`
  );

  const legacySession = await repository.create("host-state-contract-migration-owner");
  const legacyMetadata = await Promise.resolve(legacySession.metadata);
  const legacyScope = structuredClone(scope);
  legacyScope.checks.forEach((check, index) => {
    check.verdict = index === 0 ? "misaligned" : "aligned";
    check.reason = index === 0 ? "known alignment debt" : "legacy selected-only acceptance";
  });
  await appendSessionCustomEntry(legacySession, "yn.host-state.v1", {
    schemaVersion: 1,
    ownerSessionId: legacyMetadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: {
      schemaVersion: 3,
      documents: {},
      ranges: { "chapter.txt": [legacyScope] }
    }
  });

  const migrated = await loadYnSessionHostState(legacySession, legacyMetadata.id);
  const migratedChecks = migrated?.translationAlignment.ranges["chapter.txt"][0].checks ?? [];
  assert.equal(migratedChecks[0]?.verdict, "misaligned");
  assert.equal(migratedChecks[0]?.reason, "known alignment debt");
  assert.ok(
    migratedChecks.slice(1).every((check) => check.verdict === undefined && check.reason === undefined),
    "cold contract migration must retain known failures but make legacy accepted review evidence pending"
  );
  const migratedBranch = await readSessionEntries(legacySession);
  const migratedHostEntries = migratedBranch.filter((entry) => (
    entry.type === "custom" && entry.customType === "yn.host-state.v2"
  ));
  assert.equal(migratedHostEntries.length, 1);
  assert.equal(migratedHostEntries[0].data?.mode, "checkpoint");
  assert.equal(migratedHostEntries[0].data?.runtimeContractVersion, YN_RUNTIME_CONTRACT_VERSION);

  const beforeSecondLoad = (await readSessionEntries(legacySession)).length;
  await loadYnSessionHostState(legacySession, legacyMetadata.id);
  assert.equal(
    (await readSessionEntries(legacySession)).length,
    beforeSecondLoad,
    "current Host behavior contract must not rewrite a session again on every cold load"
  );

  const versionChainSession = await repository.create("host-state-v2-to-v3-owner");
  const versionChainMetadata = await Promise.resolve(versionChainSession.metadata);
  const v2Base = {
    schemaVersion: 1,
    ownerSessionId: versionChainMetadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: { schemaVersion: 3, documents: {}, ranges: {} }
  };
  v2Base.proofread.documents["existing.txt"] = {
    sampledLines: Array.from({ length: 4_096 }, (_value, index) => index + 1),
    reportInitialized: false,
    completedSplitScopes: [],
    glossaryCandidates: []
  };
  const v2After = structuredClone(v2Base);
  v2After.proofread.documents["existing.txt"].sampledLines.push(4_097);
  const v2DeltaOperations = [{
    op: "set",
    path: ["proofread", "documents", "existing.txt", "sampledLines"],
    value: v2After.proofread.documents["existing.txt"].sampledLines
  }];
  const v2BaseHash = hostStateHash(v2Base);
  const v2AfterHash = hostStateHash(v2After);
  await appendSessionCustomEntry(versionChainSession, "yn.host-state.v1", structuredClone(v2Base));
  await appendSessionCustomEntry(versionChainSession, "yn.host-audit.interleaved", { marker: "between legacy and v2 checkpoint" });
  await appendSessionCustomEntry(versionChainSession, YN_HOST_STATE_DELTA_CUSTOM_TYPE, {
    schemaVersion: 2,
    runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
    ownerSessionId: versionChainMetadata.id,
    mode: "checkpoint",
    stateHash: v2BaseHash,
    state: v2Base
  });
  await appendSessionCustomEntry(versionChainSession, "yn.host-audit.interleaved", { marker: "between checkpoint and delta" });
  await appendSessionCustomEntry(versionChainSession, YN_HOST_STATE_DELTA_CUSTOM_TYPE, {
    schemaVersion: 2,
    runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
    ownerSessionId: versionChainMetadata.id,
    mode: "delta",
    baseHash: v2BaseHash,
    stateHash: v2AfterHash,
    operations: v2DeltaOperations
  });
  const v2Loaded = await loadYnSessionHostState(versionChainSession, versionChainMetadata.id);
  assert.deepEqual(v2Loaded, v2After);
  const mixedEntries = await readSessionEntries(versionChainSession);
  assert.ok(
    mixedEntries.findIndex((entry) => entry.type === "custom" && entry.customType === "yn.host-audit.interleaved")
      < mixedEntries.findIndex((entry) => entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE && entry.data?.mode === "checkpoint"),
    "the replay source must preserve Host entry sequence across interleaved custom records"
  );
  v2Loaded.proofread.documents["existing.txt"].glossaryCandidates.push({
    id: "candidate-1",
    source: "Term",
    target: "译名",
    category: "title",
    evidenceLine: 1,
    rationale: "Observed in the migrated session.",
    status: "pending"
  });
  await appendYnSessionHostState(versionChainSession, v2Loaded);
  const versionChainEntries = (await readSessionEntries(versionChainSession)).filter((entry) => (
    entry.type === "custom" && entry.customType === YN_HOST_STATE_DELTA_CUSTOM_TYPE
  ));
  const appendedVersionedEntry = versionChainEntries.at(-1);
  assert.equal(appendedVersionedEntry?.data?.schemaVersion, 3);
  assert.equal(appendedVersionedEntry?.data?.mode, "delta");
  assert.equal(appendedVersionedEntry?.data?.baseHash, v2AfterHash);
  assert.equal(appendedVersionedEntry?.data?.operations[0]?.op, "append");
  assert.equal(appendedVersionedEntry?.data?.stateHash, hostStateHash(v2Loaded));
  const versionChainReopened = await repository.open(versionChainMetadata.id);
  const versionChainRestored = await loadYnSessionHostState(versionChainReopened, versionChainMetadata.id);
  assert.deepEqual(versionChainRestored, v2Loaded);
  await appendSessionCustomEntry(versionChainReopened, "yn.host-audit.interleaved", { marker: "before wrong-owner delta" });
  await appendSessionCustomEntry(versionChainReopened, YN_HOST_STATE_DELTA_CUSTOM_TYPE, {
    schemaVersion: 3,
    runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
    ownerSessionId: "different-owner",
    mode: "delta",
    baseHash: hostStateHash(v2Loaded),
    stateHash: "invalid-owner-state-hash",
    operations: []
  });
  await assert.rejects(
    () => loadYnSessionHostState(versionChainReopened, versionChainMetadata.id),
    /belongs to a different Pi session/,
    "filtered replay must still validate the owner at the exact chain position"
  );
  console.log("ok schema 2 hash chains replay before schema 3 deltas without changing the custom type");

  await appendSessionCustomEntry(legacySession, "yn.host-state.v1", {
    schemaVersion: 1,
    ownerSessionId: legacyMetadata.id,
    proofread: createProofreadHostState(),
    translationAlignment: { schemaVersion: 3, documents: {}, ranges: {} }
  });
  await assert.rejects(
    () => loadYnSessionHostState(legacySession, legacyMetadata.id),
    /runtime contract version moved backwards/,
    "a legacy v1 snapshot appended after a current v2 checkpoint must fail instead of downgrading Host state"
  );
  console.log("ok cold Host load migrates legacy review evidence once and persists the current behavior contract");
} finally {
  await rm(workspaceDir, { recursive: true, force: true });
}
