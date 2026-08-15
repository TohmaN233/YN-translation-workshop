import { strict as assert } from "node:assert";

import { buildAssignedTranslationRepairPlan } from "../../src/main/agent/piNative/subagentRunner.ts";
import { isYnTranslationArtifactAccepted } from "../../src/main/agent/piNative/translationArtifactValidation.ts";
import { validateTranslationCandidate } from "../../src/shared/validation/translationValidator.ts";

const sourceSlice = ["First line", "Second line", "Third line"];
const firstCandidate = ["First line", "Second line", "第三行"];
const secondCandidate = ["第一行", "Second line", "Third line"];

const first = buildAssignedTranslationRepairPlan({
  fromLine: 601,
  sourceSlice,
  requiredLines: [601, 602],
  languagePair: "en->zh-CN",
  validation: validateTranslationCandidate(sourceSlice.join("\n"), firstCandidate.join("\n"), {
    languagePair: "en->zh-CN"
  })
});
const second = buildAssignedTranslationRepairPlan({
  fromLine: 601,
  sourceSlice,
  requiredLines: [602, 603],
  languagePair: "en->zh-CN",
  validation: validateTranslationCandidate(sourceSlice.join("\n"), secondCandidate.join("\n"), {
    languagePair: "en->zh-CN"
  })
});

assert.deepEqual(
  first.issues.map(({ code, line }) => ({ code, line })),
  [
    {
      code: "likely_untranslated",
      line: 601
    },
    {
      code: "likely_untranslated",
      line: 602
    }
  ]
);
assert.equal(second.issues.length, first.issues.length, "fixture must retain equal host-owned repair debt");
assert.notEqual(
  second.fingerprint,
  first.fingerprint,
  "equal warning counts with different repaired lines are real progress"
);
assert.match(first.prompt, /absoluteLine/);
assert.match(first.prompt, /601/);
assert.doesNotMatch(first.prompt, /First line/);
assert.match(first.prompt, /Call repairAssignedTranslation once/i);
assert.doesNotMatch(first.prompt, /"sourceText"/);

const properNounSource = ["タイカ帝国が作ったマスコット『ぴも太』を模した素体を作り出した。"];
const properNounCandidate = ["泰卡帝国制造了一个模仿吉祥物『ぴも太』的素体。"];
const properNounValidation = validateTranslationCandidate(
  properNounSource.join("\n"),
  properNounCandidate.join("\n"),
  { languagePair: "ja->zh-CN" }
);
const properNounPlan = buildAssignedTranslationRepairPlan({
  fromLine: 3312,
  sourceSlice: properNounSource,
  validation: properNounValidation
});
assert.equal(properNounValidation.warnings.length, 0);
assert.equal(properNounPlan.issues.length, 0, "a short preserved proper noun must not create endless host repair debt");

const unresolvedProperNounSource = ["魔導機関アルカディア。起動する。"];
const unresolvedProperNounCandidate = ["启动魔导机关アルカディア。"];
const unresolvedProperNounValidation = validateTranslationCandidate(
  unresolvedProperNounSource.join("\n"),
  unresolvedProperNounCandidate.join("\n"),
  { languagePair: "ja->zh-CN" }
);
const unresolvedProperNounPlan = buildAssignedTranslationRepairPlan({
  fromLine: 88,
  sourceSlice: unresolvedProperNounSource,
  validation: unresolvedProperNounValidation
});
assert.ok(unresolvedProperNounValidation.warnings.some((finding) => finding.code === "likely_untranslated"));
assert.equal(isYnTranslationArtifactAccepted(unresolvedProperNounValidation), false,
  "unresolved source-language residue must return to the same child unless project assets justify it");
assert.equal(unresolvedProperNounPlan.issues.length, 1);
assert.doesNotMatch(unresolvedProperNounPlan.prompt, /アルカディア/,
  "repair prompts must not inject source-derived terms; the child reads them through readAssignedSource");

const largeSource = Array.from({ length: 300 }, (_, index) => `Source ${index + 1}`);
const large = buildAssignedTranslationRepairPlan({
  fromLine: 1,
  sourceSlice: largeSource,
  requiredLines: Array.from({ length: 300 }, (_, index) => index + 1),
  languagePair: "en->ja",
  validation: validateTranslationCandidate(largeSource.join("\n"), largeSource.join("\n"), {
    languagePair: "en->zh-CN"
  })
});
const largeEvidence = JSON.parse(large.prompt.slice(large.prompt.lastIndexOf("\n\n") + 2));
assert.match(large.prompt, /repairAssignedTranslation once/);
assert.match(large.prompt, /target language required by the workflow \(en->ja\)/);
assert.doesNotMatch(large.prompt, /Simplified Chinese/);
assert.equal(largeEvidence.requiredLineCount, 300);
assert.equal(largeEvidence.requiredBatchLines.length, 256);
assert.equal(largeEvidence.remainingRequiredLineCount, 44);
assert.equal(largeEvidence.issues.length, 32);
assert.equal(largeEvidence.omittedIssueCount, 268);
assert.equal(Object.hasOwn(largeEvidence.issues[0], "sourceText"), false);

const sourceOwnershipSentinel = buildAssignedTranslationRepairPlan({
  fromLine: 900,
  sourceSlice: ["SOURCE_ONLY_SENTINEL"],
  requiredLines: [900],
  validation: validateTranslationCandidate("SOURCE_ONLY_SENTINEL", "已经完成的中文候选", {
    languagePair: "en->zh-CN"
  })
});
assert.doesNotMatch(sourceOwnershipSentinel.prompt, /SOURCE_ONLY_SENTINEL/,
  "repair prompts must make the child read source through readAssignedSource instead of injecting source text");

const boundedLocalValidation = validateTranslationCandidate(
  "Naomi entered.\nAkaro followed.",
  "她进来了。\n他跟了上来。",
  {
    languagePair: "en->zh-CN",
    glossaryEntries: [
      { source: "Naomi", target: "直美" },
      { source: "Akaro", target: "赤郎" }
    ]
  }
);
assert.equal(boundedLocalValidation.warnings.length, 2);
const boundedLocalPlan = buildAssignedTranslationRepairPlan({
  fromLine: 105,
  sourceSlice: ["Naomi entered.", "Akaro followed."],
  validation: boundedLocalValidation,
  executionMode: "bounded_repair"
});
assert.equal(boundedLocalPlan.issues.length, 0,
  "a prompt-defined local repair must not turn unrelated whole-range glossary warnings into mandatory repair debt");
assert.ok(boundedLocalPlan.prompt.length < 2_000,
  `bounded local repair evidence must stay compact, received ${boundedLocalPlan.prompt.length} chars`);

console.log("ok translation repair plans use absolute lines and identity-based progress");
