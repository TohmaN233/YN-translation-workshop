import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendYnSessionHostState,
  createProofreadHostState,
  loadYnSessionHostState,
  YN_RUNTIME_CONTRACT_VERSION
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { createTranslationChunkReviewAudit } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-host-state-delta-"));

try {
  const repository = new PiSessionRepository(workspaceDir);
  const session = await repository.create("host-state-delta-owner");
  const metadata = await session.getMetadata();
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
    (await session.getBranch()).filter((entry) => entry.type === "custom" && entry.customType === "yn.host-state.v2").length,
    1,
    "persisting an unchanged Host state must not append an empty delta"
  );
  for (let index = 0; index < 64; index += 1) {
    const check = scope.checks[index % scope.checks.length];
    check.reason = `accepted mutation ${index + 1}`;
    await appendYnSessionHostState(session, state);
  }

  const fileInfo = await stat(metadata.path);
  const entries = (await readFile(metadata.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const hostEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === "yn.host-state.v2");
  assert.equal(hostEntries.length, 65);
  assert.equal(hostEntries.filter((entry) => entry.data?.mode === "checkpoint").length, 1);
  assert.equal(hostEntries.filter((entry) => entry.data?.mode === "delta").length, 64);
  assert.ok(
    fileInfo.size < fullSnapshotBytes * 16,
    `incremental Host persistence must remain bounded; JSONL=${fileInfo.size}, full=${fullSnapshotBytes}`
  );

  const reopened = await repository.open(metadata.id);
  const restored = await loadYnSessionHostState(reopened, metadata.id);
  assert.equal(
    restored?.translationAlignment.ranges["chapter.txt"][0].checks[63 % scope.checks.length].reason,
    "accepted mutation 64"
  );
  assert.deepEqual((await reopened.buildContext()).messages, []);

  console.log("ok Pi Host state uses bounded checkpoint-plus-delta persistence and reloads exactly");

  const legacySession = await repository.create("host-state-contract-migration-owner");
  const legacyMetadata = await legacySession.getMetadata();
  const legacyScope = structuredClone(scope);
  legacyScope.checks.forEach((check, index) => {
    check.verdict = index === 0 ? "misaligned" : "aligned";
    check.reason = index === 0 ? "known alignment debt" : "legacy selected-only acceptance";
  });
  await legacySession.appendCustomEntry("yn.host-state.v1", {
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
  const migratedBranch = await legacySession.getBranch();
  const migratedHostEntries = migratedBranch.filter((entry) => (
    entry.type === "custom" && entry.customType === "yn.host-state.v2"
  ));
  assert.equal(migratedHostEntries.length, 1);
  assert.equal(migratedHostEntries[0].data?.mode, "checkpoint");
  assert.equal(migratedHostEntries[0].data?.runtimeContractVersion, YN_RUNTIME_CONTRACT_VERSION);

  const beforeSecondLoad = (await legacySession.getBranch()).length;
  await loadYnSessionHostState(legacySession, legacyMetadata.id);
  assert.equal(
    (await legacySession.getBranch()).length,
    beforeSecondLoad,
    "current Host behavior contract must not rewrite a session again on every cold load"
  );

  await legacySession.appendCustomEntry("yn.host-state.v1", {
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
