import assert from "node:assert/strict";

import {
  buildProofreadDeterministicSignals,
  summarizeProofreadDeterministicSignals
} from "../../src/main/agent/piNative/proofreadPrescan.ts";

const signals = buildProofreadDeterministicSignals({
  sourceText: [
    "魔王",
    "勇者です",
    "説明",
    "Alice speaks",
    "This is a compact source sentence."
  ].join("\n"),
  translationText: [
    "魔王",
    "勇者です",
    "以下是翻译：说明",
    "她说了禁语",
    "这是一段被无端扩写得非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的译文。"
  ].join("\n"),
  validationOptions: {
    languagePair: "ja->zh-CN",
    glossaryEntries: [{ source: "魔王", target: "魔王大人" }],
    characterEntries: [{
      name: "Alice",
      gender: "male",
      genderConfidence: "confirmed",
      forbiddenTerms: ["禁语"]
    }]
  }
});

const byCode = new Map(signals.map((signal) => [`${signal.code}:${signal.line}`, signal]));
assert.ok(byCode.has("H3:1"), "glossary mismatch must be found by the full deterministic scan");
assert.ok(byCode.has("H4:2"), "source-language residue must be found by the full deterministic scan");
assert.ok(byCode.has("H7:3"), "AI contamination must be found by the full deterministic scan");
assert.ok(byCode.has("H8:4"), "a confirmed character pronoun conflict must be found by the full deterministic scan");
assert.ok(byCode.has("H9:5"), "abnormal expansion must be found by the full deterministic scan");
assert.ok(signals.every((signal) => signal.evidence.trim()), "every deterministic signal needs actionable evidence");

const summary = summarizeProofreadDeterministicSignals({
  signals,
  totalLines: 5,
  maximumWorkers: 5
});
assert.equal(summary.completed, true);
assert.equal(summary.affectedLineCount, 5);
assert.deepEqual(summary.countsByCode, { H3: 2, H4: 1, H7: 1, H8: 1, H9: 1, M0: 3 });
assert.equal(summary.recommendedWorkerCount, 1, "a tiny review must not fill every configured worker slot");
assert.equal(summary.highestRiskRegions[0].tier, "HOT");

console.log("ok proofreading deterministic prescan covers H3/H4/H7/H8/H9");

const boundarySignals = buildProofreadDeterministicSignals({
  sourceText: [
    "He opened the door. The room was empty.",
    "A bell rang."
  ].join("\n"),
  translationText: [
    "他打开了门。",
    "房间空无一人。钟声响起。"
  ].join("\n"),
  validationOptions: { languagePair: "en->zh-CN" }
});
assert.deepEqual(
  boundarySignals
    .filter((signal) => signal.code === "M0")
    .map((signal) => signal.line)
    .filter((line, index, lines) => lines.indexOf(line) === index),
  [1, 2],
  "sentence-boundary compensation across adjacent rows must enter the mechanical scan"
);
assert.ok(
  boundarySignals
    .filter((signal) => signal.code === "M0")
    .some((signal) => /sentence boundary/i.test(signal.evidence)),
  "boundary risks need user-readable evidence"
);

const singleBoundaryLoss = buildProofreadDeterministicSignals({
  sourceText: "First sentence. Second sentence.\nAnother source line.",
  translationText: "第一句和第二句\n另一行译文。",
  validationOptions: { languagePair: "en->zh-CN" }
});
assert.ok(
  singleBoundaryLoss.some((signal) => (
    signal.code === "M0"
    && signal.line === 1
    && /different sentence boundary counts/i.test(signal.evidence)
  )),
  "one missing boundary in a multi-sentence row must enter the mechanical scan"
);

const consecutiveDuplicate = buildProofreadDeterministicSignals({
  sourceText: "The first distinct source sentence.\nThe second distinct source sentence.",
  translationText: "相同的中文译文。\n相同的中文译文。",
  validationOptions: { languagePair: "en->zh-CN" }
});
assert.deepEqual(
  consecutiveDuplicate
    .filter((signal) => signal.code === "M0" && /reuse the same translation/i.test(signal.evidence))
    .map((signal) => signal.line),
  [1, 2],
  "two adjacent distinct source rows reusing one translation must be detected"
);

const pronouns = buildProofreadDeterministicSignals({
  sourceText: ["Alice answered.", "Alice answered.", "Alice and Bob answered."].join("\n"),
  translationText: ["He answered.", "She answered.", "He answered."].join("\n"),
  validationOptions: {
    languagePair: "ja->en",
    characterEntries: [
      { name: "Alice", gender: "female", genderConfidence: "confirmed" },
      { name: "Bob", gender: "male", genderConfidence: "confirmed" }
    ]
  }
});
assert.ok(pronouns.some((signal) => signal.code === "H8" && signal.line === 1));
assert.equal(pronouns.some((signal) => signal.code === "H8" && signal.line === 2), false);
assert.equal(
  pronouns.some((signal) => signal.code === "H8" && signal.line === 3),
  false,
  "ambiguous multi-character lines must not create an automatic H8 verdict"
);
