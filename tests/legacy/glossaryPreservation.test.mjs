import assert from "node:assert/strict";
import vm from "node:vm";
import { renderLineReviewHtml, LINE_REVIEW_PROTOCOL_MARKER } from "../../src/shared/core/html.ts";
import { needsLegacyLineReviewUpgrade, upgradeLegacyLineReviewHtmlContent } from "../../src/shared/core/legacyHtml.ts";

const prefix = { pattern: "^[^：:\\r\\n]+[：:]", flags: "u" };
const term = { entry: { source: "マユラ", target: "真由良" }, index: 0, target: "真由良", candidates: ["マユラ", "玛由良"] };
const html = renderLineReviewHtml({ title: "Preserved glossary", sourceText: "マユラ：マユラ来了", translationText: "マユラ：マユラ来了" });
function functionSource(page, name, next) {
  return page.slice(page.indexOf("function " + name + "("), page.indexOf("function " + next + "("));
}
function harness(page, rules, texts, manual = []) {
  const rows = texts.map((text, index) => ({ line: index + 1, source: text, translation: text }));
  const state = { edits: {}, status: Object.fromEntries(manual.map(line => [line, "manual"])) };
  let saved, status;
  const context = vm.createContext({ data: { rows, labels: {} }, state,
    readPromptCustomPreserveRules: () => rules,
    rowValue: row => state.edits[row.line] ?? row.translation,
    pageRows: () => rows.slice(0, 1), save: lines => { saved = [...lines]; }, render: () => {}, setAiStatus: text => { status = text; }
  });
  vm.runInContext(functionSource(page, "replaceByLongestGlossaryItems", "countLongestGlossaryMatches") + functionSource(page, "applyGlossaryItems", "applyGlossaryReplacements"), context);
  return { context, state, apply: (scope, items = [term]) => context.applyGlossaryItems(scope, items), saved: () => saved, status: () => status };
}

for (const page of [html, upgradeLegacyLineReviewHtmlContent(html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v45"))]) {
  const fx = harness(page, [prefix], ["マユラ：マユラ来了", "玛由良：玛由良来了", "正文マユラ", "マユラ：マユラ来了"], [4]);
  fx.apply("all");
  assert.equal(fx.state.edits[1], "マユラ：真由良来了", "glossary application must preserve the prefix while replacing the body");
  assert.equal(fx.state.edits[2], "玛由良：真由良来了", "old target aliases in protected prefixes stay verbatim");
  assert.equal(fx.state.edits[3], "正文真由良");
  assert.equal(fx.state.edits[4], undefined, "manual rows retain existing behavior");
  assert.deepEqual(fx.saved(), [1, 2, 3]);
  const current = harness(page, [prefix], ["マユラ：マユラ来了", "正文マユラ"]);
  current.apply("page");
  assert.equal(current.state.edits[1], "マユラ：真由良来了");
  assert.equal(current.state.edits[2], undefined);
  const interior = harness(page, [{ pattern: "\\[マユラ\\]", flags: "u" }, { pattern: "マユラ(?=\\])", flags: "u" }], ["[マユラ] マユラ [マユラ]"]);
  interior.apply("all");
  assert.equal(interior.state.edits[1], "[マユラ] 真由良 [マユラ]", "all interior and overlapping rule matches must be protected");
  const crossing = harness(page, [{ pattern: "B", flags: "u" }], ["ABC A"]);
  crossing.apply("all", [{ target: "long", candidates: ["ABC"] }, { target: "short", candidates: ["A"] }]);
  assert.equal(crossing.state.edits[1], "shortBC short", "a longest glossary match crossing a protected span must be skipped; safe shorter matches remain available");
  const withoutRules = harness(page, [], ["マユラ：マユラ来了"]);
  withoutRules.apply("all");
  assert.equal(withoutRules.state.edits[1], "真由良：真由良来了");
  const invalid = harness(page, [{ pattern: "[", flags: "u" }], ["マユラ来了", "マユラ来了"]);
  assert.throws(() => invalid.apply("all"), /regular expression/i);
  assert.deepEqual(invalid.state.edits, {}, "invalid rules must fail before any row changes");
  assert.equal(invalid.saved(), undefined);
  const flags = harness(page, [{ pattern: "abc", flags: "iu" }], ["ABC xyz"]);
  flags.apply("all", [{ target: "changed", candidates: ["ABC", "xyz"] }]);
  assert.equal(flags.state.edits[1], "ABC changed");

  const edited = harness(page, [prefix], ["玛由良：玛由良来了"]);
  const context = edited.context;
  Object.assign(context, {
    glossaryEntries: [{ source: "マユラ", target: "玛由良" }],
    glossaryTarget: () => context.glossaryEntries[0].target,
    glossaryAliases: () => context.glossaryEntries[0].aliases ?? [],
    uniqueGlossaryTerms: values => [...new Set(values.filter(Boolean))],
    workflow: { paths: { outputDir: "G:/fixture" } },
    writeBridge: () => ({ updateProjectGlossaryEntry: async args => ({ paths: { glossary: "glossary.json" }, glossary: { entries: [args.entry] } }) }),
    boundGlossaryPath: () => "glossary.json", adoptBoundGlossaryPath: async () => {},
    syncGlossaryFromText: text => { context.glossaryEntries = JSON.parse(text).entries; return true; },
    confirm: () => true
  });
  vm.runInContext(functionSource(page, "replacementCandidatesForEntry", "glossaryReplacementItems")
    + page.slice(page.indexOf("async function applyEditedGlossaryTerm("), page.indexOf("function cleanGlossaryTerm(")), context);
  await context.applyEditedGlossaryTerm({ dataset: { glossaryIndex: "0", currentTarget: "玛由良" }, value: "真由良" });
  assert.equal(context.glossaryEntries[0].target, "真由良", "formal term update still commits");
  assert.equal(edited.state.edits[1], "玛由良：真由良来了", "edited-term overwrite shares protected replacement behavior");
}
assert.equal(needsLegacyLineReviewUpgrade(html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v45")), true);
console.log("ok actual generated and upgraded glossary application preserves regex spans for page, bulk, aliases and overlaps");
