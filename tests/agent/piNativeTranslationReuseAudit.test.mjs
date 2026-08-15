import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyTranslationReuseAudit,
  applyTranslationReuseAudits,
  getTranslationReuseAuditSummary,
  listCurrentTranslationReuseAudits,
  planTranslationReuseAuditTasks,
  prepareTranslationReuseAudit,
  prepareTranslationReuseAudits,
  readTranslationReuseAuditBatch,
  readTranslationReuseAuditSelection,
  recordTranslationReuseAuditBatch
} from "../../src/main/agent/piNative/translationReuseAudit.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";

async function fixture(sourceLines, candidateLines) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-audit-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
  await writeFile(candidatePath, candidateLines.join("\n"), "utf8");
  return { outputDir, sourcePath, candidatePath };
}

test("current reuse audits ignore documents removed from the retained folder order", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-retained-documents-"));
  const candidateDir = path.join(outputDir, "AI_translation");
  const oldSourcePath = path.join(outputDir, "old.txt");
  const newSourcePath = path.join(outputDir, "new.txt");
  const oldCandidatePath = path.join(candidateDir, "old_translated.txt");
  const newCandidatePath = path.join(candidateDir, "new_translated.txt");
  await mkdir(candidateDir, { recursive: true });
  await Promise.all([
    writeFile(oldSourcePath, "Old source row.\n", "utf8"),
    writeFile(newSourcePath, "New source row.\n", "utf8"),
    writeFile(oldCandidatePath, "旧文件译文。\n", "utf8"),
    writeFile(newCandidatePath, "新文件译文。\n", "utf8")
  ]);
  try {
    await prepareTranslationReuseAudits([
      {
        outputDir,
        ownerSessionId: "pi-retained-owner",
        documentId: "old.txt",
        sourcePath: oldSourcePath,
        candidatePath: oldCandidatePath,
        languagePair: "en->zh-CN"
      },
      {
        outputDir,
        ownerSessionId: "pi-retained-owner",
        documentId: "new.txt",
        sourcePath: newSourcePath,
        candidatePath: newCandidatePath,
        languagePair: "en->zh-CN"
      }
    ]);
    await rm(oldSourcePath);
    await rm(oldCandidatePath);

    const current = await listCurrentTranslationReuseAudits(
      outputDir,
      "pi-retained-owner",
      new Set(["new.txt"])
    );
    assert.deepEqual(current.map((audit) => audit.documentId), ["new.txt"]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("persisted reuse audits can only be read or mutated by their owning Pi session", async () => {
  const work = await fixture(["Open the gate."], ["打开大门。"]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      ownerSessionId: "pi-owner-a",
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const ownerError = /different Pi session/i;
    await assert.rejects(
      readTranslationReuseAuditBatch({
        outputDir: work.outputDir,
        ownerSessionId: "pi-owner-b",
        auditId: prepared.auditId,
        documentId: "source.txt",
        fromLine: 1,
        toLine: 1
      }),
      ownerError
    );
    await assert.rejects(
      planTranslationReuseAuditTasks({
        outputDir: work.outputDir,
        ownerSessionId: "pi-owner-b",
        auditIds: [prepared.auditId],
        maxLinesPerTask: 80
      }),
      ownerError
    );
    await assert.rejects(
      getTranslationReuseAuditSummary(work.outputDir, prepared.auditId, "pi-owner-b"),
      ownerError
    );
    await assert.rejects(
      recordTranslationReuseAuditBatch({
        outputDir: work.outputDir,
        ownerSessionId: "pi-owner-b",
        auditId: prepared.auditId,
        documentId: "source.txt",
        entries: [{ line: 1, verdict: "reuse", reason: "Attempted foreign-session mutation." }]
      }),
      ownerError
    );
    await assert.rejects(
      applyTranslationReuseAudit({
        outputDir: work.outputDir,
        ownerSessionId: "pi-owner-b",
        auditId: prepared.auditId,
        decision: "discard_existing"
      }),
      ownerError
    );
    assert.equal(await readFile(work.candidatePath, "utf8"), "打开大门。");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("the host quick scan auto-reuses ordinary target-language lines and sends only risky lines to semantic audit", async () => {
  const work = await fixture(
    [
      "Open the gate.",
      "Save your progress.",
      "Exit immediately through the northern passage."
    ],
    ["开门。", "保存你的进度。", "Salir ahora por el pasillo norte."]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(prepared.pendingSemanticLineCount, 2);
    assert.equal(prepared.automaticallyReusableLineCount, 1);

    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 3
    });
    assert.deepEqual(batch.lines.map((line) => line.line), [1, 2, 3]);
    assert.equal(batch.lines[0].deterministicDisposition, "semantic_review_required");
    assert.ok(batch.lines[0].semanticSignals.includes("very_short_relative_to_source"));
    assert.equal(batch.lines[1].deterministicDisposition, "automatic_reuse");
    assert.ok(batch.lines[2].semanticSignals.includes("target_language_not_observed"));
    const recorded = await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "reuse", reason: "Concise but complete translation of the aligned imperative." }]
    });
    assert.equal(recorded.pendingSemanticLineCount, 1, "semantic risk is evidence for AI judgment, not a forced manual bucket");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("the reuse quick scan strips preserved event tags before checking target-language evidence", async () => {
  const work = await fixture(
    [
      "[ev10001:0016] '",
      "[ev10001:0017] ………………",
      "[ev10001:0018] ？",
      "[ev10001:0019] 6f02dde355adb55b72f224248c03245e.bundle",
      "[ev10001:0020] ………………っ"
    ],
    [
      "[ev10001:0016] '",
      "[ev10001:0017] ………………",
      "[ev10001:0018] ？",
      "[ev10001:0019] 6f02dde355adb55b72f224248c03245e.bundle",
      "[ev10001:0020] ………………！"
    ]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "ja->zh-CN"
    });
    assert.equal(prepared.pendingSemanticLineCount, 0);
    assert.equal(prepared.automaticallyReusableLineCount, 5);
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("semantic task planning batches sparse high-risk lines by document instead of creating one task per island", async () => {
  const work = await fixture(
    [
      "Open the gate.",
      "This long instruction must be translated with all of its meaning intact.",
      "Save your progress.",
      "Exit immediately through the northern passage."
    ],
    ["打开大门。", "已翻译", "保存你的进度。", "Salir ahora por el pasillo norte."]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const tasks = await planTranslationReuseAuditTasks({
      outputDir: work.outputDir,
      auditIds: [prepared.auditId],
      maxLinesPerTask: 80
    });
    assert.deepEqual(tasks.map(({ fromLine, toLine, lines }) => ({ fromLine, toLine, lines })), [
      { fromLine: 2, toLine: 4, lines: [2, 4] }
    ]);
    const selection = await readTranslationReuseAuditSelection({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      lines: [2, 4]
    });
    assert.deepEqual(selection.lines.map((line) => line.line), [2, 4]);
    assert.deepEqual(selection.context.map((line) => line.line), [1, 3]);
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("known structural or placeholder failures cannot be promoted by a semantic verdict", async () => {
  const work = await fixture(["Hello"], ["本段译文"]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1
    });
    assert.equal(batch.lines[0].deterministicDisposition, "must_retranslate");
    await assert.rejects(
      recordTranslationReuseAuditBatch({
        outputDir: work.outputDir,
        auditId: prepared.auditId,
        documentId: "source.txt",
        entries: [{ line: 1, verdict: "reuse", reason: "looks fine" }]
      }),
      /must be retranslated/i
    );
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("a file-level alignment failure prevents every apparently valid line from being reused", async () => {
  const work = await fixture(
    ["Open the gate.", "Save your progress."],
    ["打开大门。", "保存你的进度。", "多出的错位行。"]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(prepared.pendingSemanticLineCount, 0);
    assert.equal(prepared.deterministicRetranslationLineCount, 2);
    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 2
    });
    assert.ok(batch.lines.every((line) => line.deterministicDisposition === "must_retranslate"));
    assert.ok(batch.lines.every((line) => line.deterministicCodes.includes("line_count_mismatch")));
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("the fast sieve flags severe compression and one repeated target used for distinct sources", async () => {
  const work = await fixture(
    [
      "This deliberately long source sentence contains several distinct facts that a real translation must preserve.",
      "First short source.",
      "Second unrelated source.",
      "Third different source."
    ],
    ["翻译完成", "已经处理完毕", "已经处理完毕", "已经处理完毕"]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 4
    });
    assert.ok(batch.lines[0].semanticSignals.includes("severe_length_compression"));
    for (const line of batch.lines.slice(1)) {
      assert.ok(line.semanticSignals.includes("repeated_candidate_for_distinct_sources"));
    }
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("the host quick scan reuses the existing source-residue detector for copied and high-overlap lines", async () => {
  const work = await fixture(
    [
      "Open the northern gate before sunset.",
      "Please open the northern gate before sunset now."
    ],
    [
      "Open the northern gate before sunset.",
      "Please open the northern gate 现在。"
    ]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 2
    });
    assert.equal(batch.lines[0].deterministicDisposition, "semantic_review_required");
    assert.ok(batch.lines[0].semanticSignals.includes("likely_untranslated"));
    assert.equal(batch.lines[1].deterministicDisposition, "semantic_review_required");
    assert.ok(batch.lines[1].semanticSignals.includes("likely_untranslated"));
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("punctuation-only output for translatable prose is audited while preservation-only lines are reused", async () => {
  const work = await fixture(["Hello", "..."], ["...", "..."]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(prepared.pendingSemanticLineCount, 1);
    assert.equal(prepared.automaticallyReusableLineCount, 1);
    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 2
    });
    assert.equal(batch.lines[0].deterministicDisposition, "semantic_review_required");
    assert.ok(batch.lines[0].semanticSignals.includes("candidate_prose_missing"));
    assert.equal(batch.lines[1].deterministicDisposition, "automatic_reuse");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("repeated legitimate dialogue for the same repeated source is not treated as a distinct-source placeholder", async () => {
  const work = await fixture(["Go!", "Go!", "Go!"], ["走！", "走！", "走！"]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const batch = await readTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      fromLine: 1,
      toLine: 3
    });
    assert.ok(batch.lines.every((line) => !line.semanticSignals.includes("repeated_candidate_for_distinct_sources")));
    assert.ok(batch.lines.every((line) => !line.semanticSignals.includes("repeated_short_candidate")));
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("user reuse choice preserves AI-accepted work and blanks AI-rejected lines", async () => {
  const work = await fixture(
    [
      "Open the gate.",
      "This named spell carries a complete magical instruction.",
      "Save your progress before entering the dangerous northern passage."
    ],
    ["打开大门。", "已翻译", "现在保存。"]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const recorded = await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [
        { line: 2, verdict: "retranslate", reason: "generic completion label, not a translation" },
        { line: 3, verdict: "retranslate", reason: "The existing target omits the shrine and dangerous passage." }
      ]
    });
    assert.equal(recorded.readyForUserDecision, true);
    assert.deepEqual(recorded.counts, { reuse: 1, retranslate: 2 });

    const applied = await applyTranslationReuseAudit({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      decision: "reuse_accepted"
    });
    assert.deepEqual(applied.retainedLineCount, 1);
    assert.deepEqual(applied.retranslationLineCount, 2);
    assert.equal(await readFile(work.candidatePath, "utf8"), "打开大门。\n\n");
    assert.equal(await readFile(applied.backups[0].path, "utf8"), "打开大门。\n已翻译\n现在保存。");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("discarding existing work also removes lines that passed the host quick scan", async () => {
  const work = await fixture(["Open.", "Save."], ["打开。", "保存。"]) ;
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(prepared.automaticallyReusableLineCount, 2);
    const applied = await applyTranslationReuseAudit({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      decision: "discard_existing"
    });
    assert.equal(applied.retainedLineCount, 0);
    assert.equal(applied.fullyReused, false);
    assert.equal(await readFile(work.candidatePath, "utf8"), "\n");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("an interrupted audit resumes by hash and stale candidate changes are rejected", async () => {
  const work = await fixture(
    [
      "Open the northern gate before sunset and wait for the signal.",
      "Save your progress at the shrine before leaving this dangerous area."
    ],
    ["打开北门", "保存完成"]
  );
  try {
    const first = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: first.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "retranslate", reason: "The existing target omits the signal and time condition." }]
    });
    const resumed = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(resumed.auditId, first.auditId);
    assert.equal(resumed.pendingSemanticLineCount, 1);

    await writeFile(work.candidatePath, "一\n被外部修改", "utf8");
    await assert.rejects(
      readTranslationReuseAuditBatch({
        outputDir: work.outputDir,
        auditId: first.auditId,
        documentId: "source.txt",
        fromLine: 2,
        toLine: 2
      }),
      /candidate changed/i
    );
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("a semantic line can receive exactly one final durable verdict and journal replay rejects duplicates", async () => {
  const work = await fixture(
    ["Open the ancient northern gate before sunset and wait for the signal."],
    ["打开大门"]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "retranslate", reason: "The existing target omits the signal and time condition." }]
    });

    await assert.rejects(
      recordTranslationReuseAuditBatch({
        outputDir: work.outputDir,
        auditId: prepared.auditId,
        documentId: "source.txt",
        entries: [{ line: 1, verdict: "reuse", reason: "A conflicting later verdict." }]
      }),
      /already has a semantic verdict|duplicate translation reuse audit line/i
    );

    const journalDir = path.join(work.outputDir, ".translation-workshop", "translation-reuse-audit-verdicts");
    const [journalName] = await readdir(journalDir);
    await appendFile(path.join(journalDir, journalName), `${JSON.stringify({
      line: 1,
      verdict: "reuse",
      reason: "Tampered duplicate verdict."
    })}\n`, "utf8");
    await assert.rejects(
      getTranslationReuseAuditSummary(work.outputDir, prepared.auditId),
      /duplicate translation reuse audit line/i
    );
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("applying one file audit does not persist and replay another file audit twice", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-multi-audit-"));
  const createDocument = async (documentId, source, candidate) => {
    const sourcePath = path.join(outputDir, documentId);
    const candidatePath = path.join(outputDir, "AI_translation", documentId.replace(/\.txt$/u, "_translated.txt"));
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(sourcePath, source, "utf8");
    await writeFile(candidatePath, candidate, "utf8");
    return { outputDir, sourcePath, candidatePath, documentId, languagePair: "en->zh-CN" };
  };
  try {
    const first = await createDocument(
      "first.txt",
      "Open the ancient northern gate before sunset and wait for the signal.",
      "打开大门"
    );
    const second = await createDocument(
      "second.txt",
      "Save your progress at the shrine before leaving this dangerous area.",
      "保存完成"
    );
    const firstAudit = await prepareTranslationReuseAudit(first);
    const secondAudit = await prepareTranslationReuseAudit(second);
    await recordTranslationReuseAuditBatch({
      outputDir,
      auditId: firstAudit.auditId,
      documentId: first.documentId,
      entries: [{ line: 1, verdict: "retranslate", reason: "Meaning is incomplete." }]
    });
    await recordTranslationReuseAuditBatch({
      outputDir,
      auditId: secondAudit.auditId,
      documentId: second.documentId,
      entries: [{ line: 1, verdict: "retranslate", reason: "Meaning is incomplete." }]
    });

    await applyTranslationReuseAudit({ outputDir, auditId: firstAudit.auditId, decision: "reuse_accepted" });
    const secondSummary = await getTranslationReuseAuditSummary(outputDir, secondAudit.auditId);
    assert.equal(secondSummary.readyForUserDecision, true);
    await applyTranslationReuseAudit({ outputDir, auditId: secondAudit.auditId, decision: "reuse_accepted" });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("folder reuse preparation and the user's one decision are batch operations", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-batch-audit-"));
  const createDocument = async (documentId, source, candidate) => {
    const sourcePath = path.join(outputDir, documentId);
    const candidatePath = path.join(outputDir, "AI_translation", documentId.replace(/\.txt$/u, "_translated.txt"));
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(sourcePath, source, "utf8");
    await writeFile(candidatePath, candidate, "utf8");
    return { outputDir, sourcePath, candidatePath, documentId, languagePair: "en->zh-CN", ownerSessionId: "batch-owner" };
  };
  try {
    const first = await createDocument("first.txt", "Open the ancient gate before sunset.", "打开大门");
    const second = await createDocument("second.txt", "Save your progress before leaving.", "离开前保存进度。");
    const prepared = await prepareTranslationReuseAudits([first, second]);
    assert.equal(prepared.length, 2);
    await recordTranslationReuseAuditBatch({
      outputDir,
      ownerSessionId: "batch-owner",
      auditId: prepared[0].auditId,
      documentId: "first.txt",
      entries: [{ line: 1, verdict: "retranslate", reason: "Most source meaning is omitted." }]
    });
    const applied = await applyTranslationReuseAudits({
      outputDir,
      ownerSessionId: "batch-owner",
      auditIds: prepared.map((audit) => audit.auditId),
      decision: "reuse_accepted"
    });
    assert.equal(applied.documentCount, 2);
    assert.equal(applied.retainedLineCount, 1);
    assert.equal(applied.retranslationLineCount, 1);
    assert.equal(await readFile(first.candidatePath, "utf8"), "");
    assert.equal(await readFile(second.candidatePath, "utf8"), "离开前保存进度。");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("legacy review journals remain pending until AI replaces them with a final binary verdict", async () => {
  const work = await fixture(
    ["Open the ancient northern gate before sunset and wait for the signal."],
    ["打开大门"]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const journalPath = path.join(
      work.outputDir,
      ".translation-workshop",
      "translation-reuse-audit-verdicts",
      `${createHash("sha256").update(prepared.auditId).digest("hex")}.jsonl`
    );
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      line: 1,
      verdict: "review",
      reason: "Legacy uncertain verdict."
    })}\n`, "utf8");

    const pending = await getTranslationReuseAuditSummary(work.outputDir, prepared.auditId);
    assert.equal(pending.readyForUserDecision, false);
    assert.equal(pending.pendingSemanticLineCount, 1);
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "retranslate", reason: "AI determined that most source meaning is missing." }]
    });
    const finalized = await getTranslationReuseAuditSummary(work.outputDir, prepared.auditId);
    assert.equal(finalized.readyForUserDecision, true);
    assert.equal(finalized.pendingSemanticLineCount, 0);
    assert.deepEqual(finalized.counts, { reuse: 0, retranslate: 1 });
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("a store polluted by the former hydrated-journal write is migrated idempotently", async () => {
  const work = await fixture(
    ["Open the ancient northern gate before sunset and wait for the signal."],
    ["打开大门"]
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const entry = { line: 1, verdict: "retranslate", reason: "Meaning is incomplete." };
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [entry]
    });
    const storePath = path.join(work.outputDir, ".translation-workshop", "translation-reuse-audits.json");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    store.audits[0].document.lines[0].verdict = entry.verdict;
    store.audits[0].document.lines[0].reason = entry.reason;
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

    const summary = await getTranslationReuseAuditSummary(work.outputDir, prepared.auditId);
    assert.equal(summary.readyForUserDecision, true);
    assert.deepEqual(summary.counts, { reuse: 0, retranslate: 1 });
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("persisted audit paths are revalidated before apply and cannot escape the project artifact boundary", async () => {
  const work = await fixture(["Open."], ["打开。"]);
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-outside-"));
  const outsidePath = path.join(outsideDir, "outside.txt");
  try {
    await writeFile(outsidePath, "打开。", "utf8");
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "reuse", reason: "Faithful." }]
    });

    const storePath = path.join(work.outputDir, ".translation-workshop", "translation-reuse-audits.json");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    store.audits[0].document.candidatePath = outsidePath;
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

    await assert.rejects(
      applyTranslationReuseAudit({
        outputDir: work.outputDir,
        auditId: prepared.auditId,
        decision: "discard_existing"
      }),
      /project translation artifact/i
    );
    assert.equal(await readFile(outsidePath, "utf8"), "打开。");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("candidate writes cannot escape through an AI_translation directory junction swapped in after audit", async () => {
  const work = await fixture(["Open."], ["打开。"]) ;
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-junction-outside-"));
  const nestedCandidateDir = path.join(work.outputDir, "AI_translation", "nested");
  const nestedCandidatePath = path.join(nestedCandidateDir, "source_translated.txt");
  const outsideCandidatePath = path.join(outsideDir, "source_translated.txt");
  try {
    await mkdir(nestedCandidateDir, { recursive: true });
    await writeFile(nestedCandidatePath, "打开。", "utf8");
    const prepared = await prepareTranslationReuseAudit({
      outputDir: work.outputDir,
      sourcePath: work.sourcePath,
      candidatePath: nestedCandidatePath,
      documentId: "nested/source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "nested/source.txt",
      entries: [{ line: 1, verdict: "reuse", reason: "Faithful and complete." }]
    });

    await rm(nestedCandidateDir, { recursive: true, force: true });
    await writeFile(outsideCandidatePath, "打开。", "utf8");
    await symlink(outsideDir, nestedCandidateDir, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      applyTranslationReuseAudit({
        outputDir: work.outputDir,
        auditId: prepared.auditId,
        decision: "discard_existing"
      }),
      /physical project translation artifact boundary/i
    );
    assert.equal(await readFile(outsideCandidatePath, "utf8"), "打开。");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("semantic verdict batches append bounded journal records instead of rewriting the full audit store", async () => {
  const lineCount = 400;
  const work = await fixture(
    Array.from({ length: lineCount }, (_, index) => `Source sentence ${index + 1} carries unique complete meaning.`),
    Array.from({ length: lineCount }, (_, index) => `第${index + 1}行是完整且独特的译文内容。`)
  );
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    const storePath = path.join(work.outputDir, ".translation-workshop", "translation-reuse-audits.json");
    const initialSize = (await stat(storePath)).size;
    for (let fromLine = 1; fromLine <= lineCount; fromLine += 50) {
      await recordTranslationReuseAuditBatch({
        outputDir: work.outputDir,
        auditId: prepared.auditId,
        documentId: "source.txt",
        entries: Array.from({ length: 50 }, (_, index) => ({
          line: fromLine + index,
          verdict: "reuse",
          reason: "Complete, faithful, and contextually usable."
        }))
      });
    }
    assert.equal((await stat(storePath)).size, initialSize);
    const summary = await getTranslationReuseAuditSummary(work.outputDir, prepared.auditId);
    assert.equal(summary.readyForUserDecision, true);
    assert.deepEqual(summary.counts, { reuse: lineCount, retranslate: 0 });
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("tampered verdict journals and noncanonical in-project candidate paths are rejected", async () => {
  const work = await fixture(["Hello"], ["本段译文"]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "retranslate", reason: "Generic placeholder." }]
    });
    const journalDir = path.join(work.outputDir, ".translation-workshop", "translation-reuse-audit-verdicts");
    const [journalName] = await readdir(journalDir);
    await writeFile(path.join(journalDir, journalName), `${JSON.stringify({
      line: 1,
      verdict: "reuse",
      reason: "tampered"
    })}\n`, "utf8");
    await assert.rejects(
      applyTranslationReuseAudit({ outputDir: work.outputDir, auditId: prepared.auditId, decision: "reuse_accepted" }),
      /must be retranslated/i
    );

    await writeFile(path.join(journalDir, journalName), `${JSON.stringify({
      line: 1,
      verdict: "retranslate",
      reason: "Generic placeholder."
    })}\n`, "utf8");
    const characterBible = path.join(work.outputDir, "AI_translation", "_workspace", "character_bible.md");
    await mkdir(path.dirname(characterBible), { recursive: true });
    await writeFile(characterBible, "本段译文", "utf8");
    const storePath = path.join(work.outputDir, ".translation-workshop", "translation-reuse-audits.json");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    store.audits[0].document.candidatePath = characterBible;
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await assert.rejects(
      applyTranslationReuseAudit({ outputDir: work.outputDir, auditId: prepared.auditId, decision: "discard_existing" }),
      /canonical artifact/i
    );
    assert.equal(await readFile(characterBible, "utf8"), "本段译文");
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("an already-applied all-reuse decision is recoverable after process restart", async () => {
  const work = await fixture(["Open.", "Save."], ["打开。", "保存。"]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [
        { line: 1, verdict: "reuse", reason: "Faithful." },
        { line: 2, verdict: "reuse", reason: "Faithful." }
      ]
    });
    await applyTranslationReuseAudit({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      decision: "reuse_accepted"
    });

    const restored = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(restored.auditId, prepared.auditId);
    assert.equal(restored.status, "applied");
    assert.equal(restored.appliedFullyReused, true);
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("a partially applied audit resumes after rejected rows are written but rejects retained-row mutation", async () => {
  const work = await fixture(["Open.", "Save."], ["Open.", "保存。"]);
  try {
    const prepared = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    await recordTranslationReuseAuditBatch({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      documentId: "source.txt",
      entries: [{ line: 1, verdict: "retranslate", reason: "Source remains untranslated." }]
    });
    await applyTranslationReuseAudit({
      outputDir: work.outputDir,
      auditId: prepared.auditId,
      decision: "reuse_accepted"
    });
    await writeFile(work.candidatePath, "打开。\n保存。", "utf8");

    const restored = await prepareTranslationReuseAudit({
      ...work,
      documentId: "source.txt",
      languagePair: "en->zh-CN"
    });
    assert.equal(restored.auditId, prepared.auditId);
    assert.equal(restored.status, "applied");
    assert.equal(restored.appliedFullyReused, false);

    await writeFile(work.candidatePath, "打开。\n另一个有效但未经审计的译文。", "utf8");
    await assert.rejects(
      prepareTranslationReuseAudit({
        ...work,
        documentId: "source.txt",
        languagePair: "en->zh-CN"
      }),
      /retained translation row changed after the applied reuse decision/i
    );
  } finally {
    await rm(work.outputDir, { recursive: true, force: true });
  }
});

test("the Pi domain contract accepts a typed reuse choice without ambient turn authorization", () => {
  const domain = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 5,
    fullWorkflow: true
  });
  domain.registerSourceManifest([{ id: "source.txt", sourceLineCount: 2 }]);
  domain.recordInspection({
    sourceLineCount: 2,
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  domain.recordTranslationReuseAuditReady(["audit-1"]);
  assert.equal(domain.awaitingUserInput, true);
  assert.match(domain.incompleteReasons().join(" "), /confirm existing translation reuse/i);
  assert.equal(domain.nextRepairPrompt(), undefined);

  domain.recordTranslationReuseDecision("audit-1", "source.txt", true);
  domain.recordTranslationArtifactMutation("source.txt");
  domain.recordFinalValidation("translation", "source.txt");
  assert.equal(domain.awaitingUserInput, false);
  assert.deepEqual(domain.incompleteReasons(), []);
});
