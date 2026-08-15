import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidateImportPlan, buildRepairPrompt } from "../../src/main/agent/importCandidate.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const examples = path.join(root, "examples", "toy-txt-audit");
const source = readFileSync(path.join(examples, "source.txt"), "utf8");
const translation = readFileSync(path.join(examples, "translation.txt"), "utf8");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

await test("buildCandidateImportPlan produces per-line edits for a valid candidate", () => {
  const plan = buildCandidateImportPlan(source, translation);
  assert.equal(plan.ok, true);
  assert.equal(plan.lineCount, 7);
  assert.equal(Object.keys(plan.edits).length, 7);
  assert.equal(plan.edits[1], "凤凰院凶真是实验室成员233");
  assert.equal(plan.edits[7], "冈部出现了。");
  assert.equal(plan.status[1], "machine");
});

await test("buildCandidateImportPlan refuses a line-count mismatch", () => {
  const candidate = "line1\nline2\nline3";
  const plan = buildCandidateImportPlan(source, candidate);
  assert.equal(plan.ok, false);
  assert.equal(Object.keys(plan.edits).length, 0);
  assert.equal(plan.validation.blocking[0].code, "line_count_mismatch");
});

await test("buildCandidateImportPlan refuses a placeholder mismatch", () => {
  const src = "Hello {player_name}";
  const cand = "你好 玩家";
  const plan = buildCandidateImportPlan(src, cand);
  assert.equal(plan.ok, false);
  assert.ok(plan.validation.blocking.some((f) => f.code === "placeholder_mismatch"));
});

await test("buildRepairPrompt mentions the delta and the target line count", () => {
  const candidate = "a\nb\nc\nd"; // 4 lines vs 7
  const plan = buildCandidateImportPlan(source, candidate, "en-US");
  const prompt = buildRepairPrompt(source, candidate, plan.validation, "en-US");
  assert.match(prompt, /missing 3 line/);
  assert.match(prompt, /exactly 7 lines/);
});

await test("buildRepairPrompt for extra lines mentions extra", () => {
  const candidate = translation + "\nextra1\nextra2";
  const plan = buildCandidateImportPlan(source, candidate, "en-US");
  const prompt = buildRepairPrompt(source, candidate, plan.validation, "en-US");
  assert.match(prompt, /2 extra line/);
});

await test("buildRepairPrompt on a passing candidate says no repair needed", () => {
  const plan = buildCandidateImportPlan(source, translation, "en-US");
  const prompt = buildRepairPrompt(source, translation, plan.validation, "en-US");
  assert.match(prompt, /No repair needed/);
});

await test("buildRepairPrompt mentions placeholders when a placeholder mismatch blocks", () => {
  const src = "Hello {player_name}, %d coins";
  const cand = "你好，100 金币";
  const plan = buildCandidateImportPlan(src, cand, "en-US");
  const prompt = buildRepairPrompt(src, cand, plan.validation, "en-US");
  assert.match(prompt, /placeholder/i);
});

await test("import plan preserves empty lines as empty edits, not dropped", () => {
  const src = "a\n\nb";
  const cand = "甲\n\n乙";
  const plan = buildCandidateImportPlan(src, cand);
  assert.equal(plan.ok, true);
  assert.equal(plan.edits[2], "");
  assert.equal(Object.keys(plan.edits).length, 3);
});

await test("glossary warnings do not block candidate import", () => {
  const plan = buildCandidateImportPlan(
    "王都騎士団が来た。",
    "骑士来了。",
    "zh-CN",
    "ja->zh-CN",
    [{ source: "王都騎士団", target: "王都骑士团" }]
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.edits[1], "骑士来了。");
  assert.ok(plan.validation.warnings.some((f) => f.code === "glossary_missing"));
});

await test("character warnings do not block candidate import", () => {
  const plan = buildCandidateImportPlan(
    "遥娜は笑った。",
    "她笑了。",
    "zh-CN",
    "ja->zh-CN",
    [],
    [{ name: "遥娜" }]
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.edits[1], "她笑了。");
  assert.ok(plan.validation.warnings.some((f) => f.code === "character_name_missing"));
});

await test("style warnings do not block candidate import", () => {
  const plan = buildCandidateImportPlan(
    "彼は笑った。",
    "他露出了机器翻译腔的笑容。",
    "zh-CN",
    "ja->zh-CN",
    [],
    [],
    ["机器翻译腔"]
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.edits[1], "他露出了机器翻译腔的笑容。");
  assert.ok(plan.validation.warnings.some((f) => f.code === "style_forbidden_term"));
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
