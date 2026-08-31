import assert from "node:assert/strict";
import { validateTranslationCandidate } from "../../src/shared/validation/translationValidator.ts";

// Reference longest-first indexOf behavior, including duplicate and partially overlapping sources.
const normalize = (value) => value.normalize("NFKC").trim().toLocaleLowerCase();
function referenceSources(source, entries) {
  const covered = [];
  const text = normalize(source);
  return [...entries].sort((a, b) => normalize(b.source).length - normalize(a.source).length).filter((entry) => {
    const term = normalize(entry.source);
    const occurrences = [];
    for (let from = 0; from <= text.length - term.length;) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      occurrences.push({ from: index, to: index + term.length });
      from = index + 1;
    }
    if (!occurrences.some((range) => !covered.some((span) => span.from <= range.from && span.to >= range.to))) return false;
    covered.push(...occurrences);
    return true;
  }).map((entry) => entry.source.trim());
}
const sources = ["abc", "ab", "bc", "b", "ＡＢＣ", "エリザベス", "ベス", "😀", "😀a", "é", "e\u0301", " A "];
let state = 37;
const pick = (length) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % length; };
for (let run = 0; run < 150; run++) {
  const entries = Array.from({ length: 12 }, () => ({ source: sources[pick(sources.length)], target: "不存在的译名" }));
  const source = Array.from({ length: 8 }, () => sources[pick(sources.length)]).join(run % 2 ? "" : " ");
  const expected = referenceSources(source, entries);
  const actual = validateTranslationCandidate(source, "完全无关", { glossaryEntries: entries, detectUntranslated: false })
    .warnings.filter((finding) => finding.code === "glossary_missing").map((finding) => finding.detail.match(/原文出现「(.*?)」/u)?.[1]);
  assert.deepEqual(actual, expected);
}
const entry = { source: "魔術師", target: "魔法师", aliases: ["法师"] };
assert.equal(validateTranslationCandidate("魔術師", "法师", { glossaryEntries: [entry] }).warnings.length, 0);
entry.aliases = ["术士"];
assert.ok(validateTranslationCandidate("魔術師", "法师", { glossaryEntries: [entry] }).warnings.some((v) => v.code === "glossary_missing"),
  "compilation must not retain stale aliases between validations");
console.log("ok compiled glossary matches legacy longest-coverage behavior over Unicode, overlap and duplicate sources");
