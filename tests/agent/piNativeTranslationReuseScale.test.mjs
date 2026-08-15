import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import {
  applyTranslationReuseAudit,
  planAppliedTranslationReuseTasks,
  prepareTranslationReuseAudit,
  recordTranslationReuseAuditBatch
} from "../../src/main/agent/piNative/translationReuseAudit.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-scale-"));
const sourcePath = path.join(outputDir, "source.txt");
const documentId = "source.txt";
const candidatePath = resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId
});

try {
  const lineCount = 4_286;
  const rejected = new Set([
    2_422,
    2_423,
    2_424,
    ...Array.from({ length: 405 }, (_, index) => 2_454 + index),
    3_250
  ]);
  assert.equal(rejected.size, 409);
  const sourceLines = Array.from({ length: lineCount }, (_, index) => `Unique English source sentence ${index + 1}.`);
  const candidateLines = sourceLines.map((source, index) => (
    rejected.has(index + 1) ? source : `这是第${index + 1}行的有效中文译文。`
  ));
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
  await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");

  const prepared = await prepareTranslationReuseAudit({
    outputDir,
    ownerSessionId: "scale-session",
    sourcePath,
    candidatePath,
    documentId,
    languagePair: "en->zh-CN"
  });
  assert.equal(prepared.pendingSemanticLineCount, 409);
  await recordTranslationReuseAuditBatch({
    outputDir,
    ownerSessionId: "scale-session",
    auditId: prepared.auditId,
    documentId,
    entries: [...rejected].map((line) => ({
      line,
      verdict: "retranslate",
      reason: "Source text remains untranslated."
    }))
  });
  const applied = await applyTranslationReuseAudit({
    outputDir,
    ownerSessionId: "scale-session",
    auditId: prepared.auditId,
    decision: "reuse_accepted"
  });
  assert.equal(applied.retainedLineCount, lineCount - 409);
  assert.equal(applied.retranslationLineCount, 409);

  const tasks = await planAppliedTranslationReuseTasks({
    outputDir,
    ownerSessionId: "scale-session",
    auditId: prepared.auditId,
    documentId,
    maxLinesPerTask: 500
  });
  assert.deepEqual(tasks, [
    { documentId, fromLine: 2_422, toLine: 2_424 },
    { documentId, fromLine: 2_454, toLine: 2_858 },
    { documentId, fromLine: 3_250, toLine: 3_250 }
  ]);
  assert.equal(tasks.reduce((total, task) => total + task.toLine - task.fromLine + 1, 0), 409);

  const resumedLines = (await readFile(candidatePath, "utf8")).trimEnd().split("\n");
  for (let line = 2_422; line <= 2_424; line += 1) resumedLines[line - 1] = `已修复第${line}行。`;
  await writeFile(candidatePath, `${resumedLines.join("\n")}\n`, "utf8");
  assert.deepEqual(
    await planAppliedTranslationReuseTasks({
      outputDir,
      ownerSessionId: "scale-session",
      auditId: prepared.auditId,
      documentId,
      maxLinesPerTask: 500
    }),
    [
      { documentId, fromLine: 2_422, toLine: 2_424 },
      { documentId, fromLine: 2_454, toLine: 2_858 },
      { documentId, fromLine: 3_250, toLine: 3_250 }
    ],
    "non-empty rejected rows remain Host debt until hash-bound review acceptance exists"
  );
  assert.deepEqual(
    await planAppliedTranslationReuseTasks({
      outputDir,
      ownerSessionId: "scale-session",
      auditId: prepared.auditId,
      documentId,
      maxLinesPerTask: 500,
      excludedLines: [2_422, 2_423, 2_424]
    }),
    [
      { documentId, fromLine: 2_454, toLine: 2_858 },
      { documentId, fromLine: 3_250, toLine: 3_250 }
    ],
    "only typed Host evidence may remove already-written rejected rows from the cold-restart queue"
  );
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok 4,286-line reuse audit queues only its 409 rejected lines and resumes sparsely");
