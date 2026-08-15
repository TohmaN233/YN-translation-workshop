import { strict as assert } from "node:assert";

import {
  createTranslationAlignmentRangeAudit,
  createTranslationChunkReviewAudit,
  createTranslationMutationReviewAudit,
  createTranslationRepairReviewAudit,
  isActionableTranslationAlignmentReason,
  normalizeTranslationAlignmentState,
  replaceTranslationAlignmentRange
} from "../../src/main/agent/piNative/translationAlignmentState.ts";

const range = createTranslationAlignmentRangeAudit({
  documentId: "chapter.txt",
  sourceText: "First source row.\nSecond source row.",
  candidateText: "第一行译文。\n第二行译文。",
  candidatePath: "C:\\project\\AI_translation\\chapter_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 700,
  sourceLineCount: 1_000
});
range.checks[0].verdict = "aligned";
range.checks[0].reason = "Same complete unit.";

const restored = normalizeTranslationAlignmentState({
  schemaVersion: 2,
  documents: {},
  ranges: { "chapter.txt": [range] }
});
assert.equal(restored.schemaVersion, 3);
assert.equal(restored.ranges["chapter.txt"].length, 1);
assert.equal(restored.ranges["chapter.txt"][0].fromLine, 700);
assert.equal(restored.ranges["chapter.txt"][0].toLine, 701);
assert.equal(restored.ranges["chapter.txt"][0].checks[0].line, 700);
assert.equal(restored.ranges["chapter.txt"][0].checks[0].verdict, "aligned");

assert.equal(isActionableTranslationAlignmentReason(undefined), false);
assert.equal(isActionableTranslationAlignmentReason("Translation review rejected line 700."), false);
assert.equal(
  isActionableTranslationAlignmentReason("semantic_shift: translate the matching source meaning on this row"),
  true
);

const migrated = normalizeTranslationAlignmentState({
  schemaVersion: 1,
  documents: {
    "legacy.txt": {
      auditId: "legacy-audit",
      inputHash: "legacy-hash",
      candidatePath: "legacy-candidate.txt",
      sourceLineCount: 1,
      checks: [{ line: 1, signals: [], verdict: "aligned", reason: "Legacy whole-file evidence." }]
    }
  }
});
assert.equal(migrated.schemaVersion, 3);
assert.equal(migrated.documents["legacy.txt"].auditId, "legacy-audit");
assert.deepEqual(migrated.ranges, {});

const sourceLines = Array.from({ length: 1_000 }, (_, index) =>
  `Source row ${index + 1} carries a distinct complete meaning for the translation.`
);
const candidateLines = sourceLines.map((_line, index) => `这是第 ${index + 1} 行各自独立的完整译文。`);
const sampled = createTranslationChunkReviewAudit({
  documentId: "large.txt",
  sourceText: sourceLines.join("\n"),
  candidateText: candidateLines.join("\n"),
  candidatePath: "C:\\project\\AI_translation\\large_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 1,
  sourceLineCount: sourceLines.length,
  mechanicalSignals: [
    { line: 17, signals: ["validation:likely_untranslated"] },
    { line: 731, signals: ["validation:repeated_candidate_run"] }
  ]
});
const sampledAgain = createTranslationChunkReviewAudit({
  documentId: "large.txt",
  sourceText: sourceLines.join("\n"),
  candidateText: candidateLines.join("\n"),
  candidatePath: "C:\\project\\AI_translation\\large_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 1,
  sourceLineCount: sourceLines.length,
  mechanicalSignals: [
    { line: 17, signals: ["validation:likely_untranslated"] },
    { line: 731, signals: ["validation:repeated_candidate_run"] }
  ]
});
assert.equal(sampled.fromLine, 1);
assert.equal(sampled.toLine, 1_000, "selected semantic checks must not shrink the chunk ownership range");
assert.equal(sampled.riskLineCount, 2);
assert.ok(sampled.sampledLineCount > 0 && sampled.sampledLineCount <= 32);
assert.equal(sampled.checks.length, sampled.riskLineCount + sampled.sampledLineCount);
assert.ok(sampled.checks.some((check) => check.line === 17));
assert.ok(sampled.checks.some((check) => check.line === 731));
assert.ok(sampled.checks.length < 50, "a clean 1,000-line chunk must not trigger full-row semantic review");
assert.deepEqual(
  sampled.checks.map((check) => check.line),
  sampledAgain.checks.map((check) => check.line),
  "unflagged sampling must be deterministic for the same hash-bound chunk"
);

const longerSourceLines = Array.from({ length: 1_600 }, (_, index) =>
  `Long source row ${index + 1} carries a distinct complete meaning for the translation.`
);
const longerCandidateLines = longerSourceLines.map(
  (_line, index) => `这是较长分片中第 ${index + 1} 行各自独立的完整译文。`
);
const longerSampled = createTranslationChunkReviewAudit({
  documentId: "longer.txt",
  sourceText: longerSourceLines.join("\n"),
  candidateText: longerCandidateLines.join("\n"),
  candidatePath: "C:\\project\\AI_translation\\longer_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 1,
  sourceLineCount: longerSourceLines.length
});
assert.equal(longerSampled.riskLineCount, 0);
assert.equal(
  longerSampled.sampledLineCount,
  40,
  "clean review sampling must keep scaling with chunk length instead of stopping at 32 rows"
);

const sampledRestored = normalizeTranslationAlignmentState({
  schemaVersion: 3,
  documents: {},
  ranges: { "large.txt": [sampled] }
});
assert.equal(sampledRestored.ranges["large.txt"][0].toLine, 1_000);
assert.equal(sampledRestored.ranges["large.txt"][0].checks.length, sampled.checks.length);
assert.equal(sampledRestored.ranges["large.txt"][0].riskLineCount, 2);

sampled.checks.forEach((check) => {
  check.verdict = check.line === 17 || check.line === 731 ? "misaligned" : "aligned";
    if (check.verdict === "misaligned") {
      check.reason = `semantic_misalignment: repair the source meaning at L${check.line}`;
    }
});
const repairedCandidateLines = [...candidateLines];
repairedCandidateLines[16] = "这是修复后的第十七行译文。";
repairedCandidateLines[730] = "这是修复后的第七百三十一行译文。";
const rescanned = createTranslationChunkReviewAudit({
  documentId: "large.txt",
  sourceText: sourceLines.join("\n"),
  candidateText: repairedCandidateLines.join("\n"),
  candidatePath: "C:\\project\\AI_translation\\large_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 1,
  sourceLineCount: sourceLines.length
});
const repairReview = createTranslationRepairReviewAudit(sampled, rescanned);
assert.deepEqual(
  repairReview.checks.filter((check) => !check.verdict).map((check) => check.line),
  [17, 731],
  "a repaired chunk must re-review the exact previously rejected rows"
);
assert.ok(
  repairReview.checks
    .filter((check) => check.line !== 17 && check.line !== 731)
    .every((check) => check.verdict === "aligned"),
  "repair review must retain previously accepted risk/sample evidence for the final commit"
);
assert.ok(repairReview.sampledLineCount > 0);

const trailingEmpty = createTranslationChunkReviewAudit({
  documentId: "dialogue.txt",
  sourceText: "こんにちは {name}\n",
  candidateText: "你好 {name}\n",
  candidatePath: "C:\\project\\AI_translation\\dialogue_translated.txt",
  languagePair: "ja->zh-CN",
  fromLine: 1,
  toLine: 2,
  sourceLineCount: 4
});
assert.equal(
  trailingEmpty.toLine,
  2,
  "a trailing empty source row belongs to the reviewed chunk even though it needs no semantic sample"
);
assert.deepEqual(trailingEmpty.checks.map((check) => check.line), [1]);

const acceptedLargeScope = structuredClone(sampled);
acceptedLargeScope.checks.forEach((check) => {
  check.verdict = "aligned";
  delete check.reason;
});
const locallyRepairedLines = [...candidateLines];
locallyRepairedLines[408] = "这是定点修复后的第四百零九行译文。";
const sparseRepairReview = createTranslationMutationReviewAudit({
  documentId: "large.txt",
  sourceText: sourceLines.join("\n"),
  candidateText: locallyRepairedLines.join("\n"),
  candidatePath: "C:\\project\\AI_translation\\large_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 1,
  toLine: sourceLines.length,
  sourceLineCount: sourceLines.length,
  mutationFromLine: 409,
  mutationToLine: 409,
  previousScopes: [acceptedLargeScope]
});
assert.equal(sparseRepairReview.fromLine, 1);
assert.equal(sparseRepairReview.toLine, 1_000);
assert.deepEqual(
  sparseRepairReview.checks.filter((check) => !check.verdict).map((check) => check.line),
  [409],
  "a one-line repair inside an accepted 1,000-line scope must reopen only the changed line"
);
assert.ok(
  sparseRepairReview.checks
    .filter((check) => check.line !== 409)
    .every((check) => check.verdict === "aligned"),
  "hash-current review evidence outside the Host-owned mutation range must remain accepted"
);
assert.ok(
  sparseRepairReview.checks.find((check) => check.line === 409)?.signals.includes("deterministic_unflagged_sample"),
  "the exact one-line mutation must enter the canonical deterministic sample"
);
assert.ok(
  sparseRepairReview.checks.length < 50,
  "sparse repair must not turn the owned 1,000-line scope into exhaustive semantic debt"
);

const siblingA = createTranslationAlignmentRangeAudit({
  documentId: "parallel.txt",
  sourceText: "First source row.",
  candidateText: "第一行译文。",
  candidatePath: "C:\\project\\AI_translation\\parallel_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 1,
  toLine: 1,
  sourceLineCount: 2
});
const siblingB = createTranslationAlignmentRangeAudit({
  documentId: "parallel.txt",
  sourceText: "Second source row.",
  candidateText: "第二行译文。",
  candidatePath: "C:\\project\\AI_translation\\parallel_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 2,
  toLine: 2,
  sourceLineCount: 2
});
const parallelState = {
  schemaVersion: 3,
  documents: {},
  ranges: { "parallel.txt": [siblingA, siblingB] }
};
const acceptedA = structuredClone(siblingA);
acceptedA.checks.forEach((check) => { check.verdict = "aligned"; });
replaceTranslationAlignmentRange(parallelState, "parallel.txt", acceptedA, siblingA.auditId);
assert.deepEqual(
  parallelState.ranges["parallel.txt"].map((scope) => [scope.fromLine, scope.toLine]),
  [[1, 1], [2, 2]],
  "committing one review range must preserve a concurrently registered sibling range"
);
assert.throws(
  () => replaceTranslationAlignmentRange(parallelState, "parallel.txt", acceptedA, "stale-audit"),
  /missing or stale/,
  "a stale review commit must fail explicitly instead of overwriting current evidence"
);

const trailingBlankReview = createTranslationChunkReviewAudit({
  documentId: "metadata-tail.txt",
  sourceLines: ["Visible row", "[metadata]"],
  candidateLines: ["可见行", ""],
  candidatePath: "C:\\project\\AI_translation\\metadata-tail_translated.txt",
  languagePair: "en->zh-CN",
  fromLine: 9,
  toLine: 10,
  sourceLineCount: 10
});
assert.equal(trailingBlankReview.fromLine, 9);
assert.equal(trailingBlankReview.toLine, 10);
assert.ok(
  trailingBlankReview.checks.some((check) => check.line === 10),
  "an explicit blank final candidate row must retain its line identity during staging review"
);

console.log("ok translation alignment state persists bounded scopes, deterministic risk sampling, and legacy evidence");
