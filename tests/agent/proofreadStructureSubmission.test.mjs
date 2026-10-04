import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeProofreadFindings } from "../../src/main/agent/writeProofreadFindings.ts";
import { createPiProofreadSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { validateProofreadReplacement } from "../../src/shared/validation/proofreadReplacement.ts";
import { buildProofreadPrompt } from "../../src/shared/core/prompts.ts";
import { buildYnSystemPrompt } from "../../src/main/agent/piNative/systemPrompt.ts";
import { PROOFREAD_STRUCTURE_INSTRUCTIONS } from "../../src/shared/agent/proofreadInstructions.ts";

async function fixture(source, translation, customPreserveRules = []) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-proofread-structure-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "AI_translation", "source_translated.txt");
  await mkdir(path.dirname(translationPath), { recursive: true });
  await writeFile(sourcePath, source + "\n");
  await writeFile(translationPath, translation + "\n");
  const args = { outputDir, sourcePaths: [sourcePath], translationPath, documentId: "source.txt", kind: "findings_json", customPreserveRules };
  const finding = (line, fix) => ({ id: `M1-${line}`, severity: "M1", type: "accuracy", sourceLine: line, translationLine: line, suggestedFix: fix, rationale: "Correct the wording." });
  return { args, sourcePath, translationPath, finding, close: () => rm(outputDir, { recursive: true, force: true }) };
}

for (const [name, source, current, unsafe, safe, rules, code] of [
  ["placeholder", "こんにちは {name}", "你好 {name}", "您好", "您好 {name}", [], "placeholder_mismatch"],
  ["restoration of already damaged structure", "こんにちは {name}", "你好", "您好", "您好 {name}", [], "placeholder_mismatch"],
  ["markup", "<color=red>こんにちは</color>", "<color=red>你好</color>", "<color=blue>您好</color>", "<color=red>您好</color>", [], "tag_mismatch"],
  ["custom /n control", "こんにちは/nさようなら", "你好/n再见", "您好再会", "您好/n再会", [{ pattern: "/n", flags: "u" }], "custom_preserve_mismatch"],
  ["trailing physical newline", "こんにちは", "你好", "您好\n", "您好", [], "line_count_mismatch"],
  ["selected short escape with Latin prose", "\\nHello", "\\n你好", "\\n您好", "\\n您好", [{ pattern: "\\\\n", flags: "u" }], null]
]) {
  test(`findings submission validates ${name} against canonical source`, async () => {
    const fx = await fixture(source, current, rules);
    try {
      const valid = await writeProofreadFindings({ ...fx.args, content: JSON.stringify([fx.finding(1, safe)]) });
      assert.equal(valid.ok, true, valid.error);
      if (!code) return;
      const before = await readFile(valid.path, "utf8");
      const invalid = await writeProofreadFindings({ ...fx.args, content: JSON.stringify([fx.finding(1, unsafe)]) });
      assert.equal(invalid.ok, false, `unsafe ${name} was persisted`);
      assert.match(invalid.error, new RegExp(code));
      assert.equal(await readFile(valid.path, "utf8"), before);
    } finally { await fx.close(); }
  });
}

test("child keeps safe suggestions and only rewrites structurally rejected lines", async () => {
  const fx = await fixture("こんにちは {name}\nさようなら/n", "你好 {name}\n再见/n", [{ pattern: "/n", flags: "u" }]);
  const progress = { referenceRead: false, findingsWritten: false, findingsCount: 0 };
  const tools = createPiProofreadSubagentTools({
    request: { outputDir: fx.args.outputDir, sourcePath: fx.sourcePath, translationPath: fx.translationPath, prompt: "Proofread.", style: "novel", languagePair: "ja->zh-CN", customPreserveRules: fx.args.customPreserveRules, glossaryCandidates: false },
    task: { fromLine: 1, toLine: 2, mode: "split" }, publishCustomMessage: async () => {}
  }, "structure_child", progress);
  try {
    await tools.find(t => t.name === "readAssignedProofreadContext").execute("read", {});
    const writer = tools.find(t => t.name === "writeAssignedFindings");
    const partial = await writer.execute("mixed", { findings: [fx.finding(1, "您好 {name}"), fx.finding(2, "再会")] });
    assert.equal(partial.details.acceptedCount, 1);
    assert.equal(partial.details.rejectedCount, 1);
    assert.equal(partial.details.rejectedFindings[0].sourceLine, 2);
    assert.match(partial.details.rejectedFindings[0].reason, /custom_preserve_mismatch/);
    assert.equal(progress.findingsWritten, false);
    assert.equal(JSON.parse(await readFile(progress.reportPath, "utf8")).findings.length, 1);
    const repaired = await writer.execute("repair", { findings: [fx.finding(2, "再会/n")] });
    assert.equal(progress.findingsWritten, true);
    assert.equal(repaired.details.findingsWritten, 2);
  } finally { await fx.close(); }
});

test("local scope rejection preserves its atomic range replacement and checks ownership first", async () => {
  const fx = await fixture("こんにちは {name}\nさようなら/n\nまた/n", "你好 {name}\n再见/n\n再见/n", [{ pattern: "/n", flags: "u" }]);
  const request = { outputDir: fx.args.outputDir, sourcePath: fx.sourcePath, translationPath: fx.translationPath,
    sessionId: "local_structure", prompt: "Review lines 1-2.", workflowIntent: "proofread",
    subagentEnabled: false, languagePair: "ja->zh-CN", customPreserveRules: fx.args.customPreserveRules };
  const publishCustomMessage = async () => {};
  const tools = createYnDomainTools({ request, publishCustomMessage, subagents: new YnSubagentSupervisor({ publishCustomMessage }) });
  const execute = (name, args = {}) => tools.find(t => t.name === name).execute("test", args);
  try {
    const seeded = await writeProofreadFindings({ ...fx.args, content: JSON.stringify([fx.finding(1, "您好 {name}")]) });
    assert.equal(seeded.ok, true, seeded.error);
    const before = await readFile(seeded.path, "utf8");
    const scope = await execute("inspectProofreadRange", { fromLine: 1, toLine: 2 });
    const scopeId = scope.details.scopeId;
    assert.ok(scopeId);
    await assert.rejects(execute("writeProofreadFindings", { scopeId, findings: [fx.finding(3, "再会")] }), /outside proofread range/);
    const rejected = await execute("writeProofreadFindings", { scopeId, findings: [fx.finding(1, "您好 {name}"), fx.finding(2, "再会")] });
    assert.equal(rejected.details.ok, false);
    assert.match(rejected.details.nextAction, /complete findings list/);
    assert.equal(await readFile(seeded.path, "utf8"), before);
    const repaired = await execute("writeProofreadFindings", { scopeId, findings: [fx.finding(1, "您好 {name}"), fx.finding(2, "再会/n")] });
    assert.equal(repaired.details.ok, true);
    assert.equal(JSON.parse(await readFile(repaired.details.path, "utf8")).findings.length, 2);
  } finally { await fx.close(); }
});

test("only structural invariants gate suggestions, including counts and physical newlines", () => {
  assert.deepEqual(validateProofreadReplacement("こんにちは", "こんにちは"), [], "semantic untranslated checks must remain outside this gate");
  assert.deepEqual(validateProofreadReplacement("{name} こんにちは", "{name} 您好"), []);
  assert.equal(validateProofreadReplacement("{name} こんにちは", "{name}{name} 您好")[0].code, "placeholder_mismatch");
  assert.equal(validateProofreadReplacement("こんにちは", "您好\r再见")[0].code, "line_count_mismatch");
});

test("generated and native parent proofreading prompts share structural requirements and actual project rules", () => {
  const customPreserveRules = [{ label: "literal /n", pattern: "/n", flags: "u" }];
  const generated = buildProofreadPrompt({ sourcePath: "source.txt", translationPath: "target.txt", advanced: { customPreserveRules } });
  for (const prompt of [generated, ...[true, false].map(fullWorkflow => buildYnSystemPrompt({
    outputDir: ".", sourcePath: "source.txt", prompt: generated, workflowIntent: "proofread", customPreserveRules
  }, { fullWorkflow }))]) {
    assert.ok(prompt.includes(PROOFREAD_STRUCTURE_INSTRUCTIONS));
    assert.ok(prompt.includes("literal /n: //n/u"));
  }
});

test("parent submissions use project rules, keep valid findings, and retry only unsafe replacements", async () => {
  const fx = await fixture("こんにちは {name}\nさようなら/n", "你好 {name}\n再见/n", [{ pattern: "/n", flags: "u" }]);
  const request = { outputDir: fx.args.outputDir, sourcePath: fx.sourcePath, translationPath: fx.translationPath,
    sessionId: "structure_parent", prompt: "Proofread the bound translation.", workflowIntent: "proofread",
    subagentEnabled: false, providerId: "test", modelId: "test", languagePair: "ja->zh-CN", customPreserveRules: fx.args.customPreserveRules };
  const publishCustomMessage = async () => {};
  const domainRun = createYnDomainRunContract({ workflowIntent: "proofread", subagentEnabled: false });
  const tools = createYnDomainTools({ request, domainRun, publishCustomMessage, subagents: new YnSubagentSupervisor({ publishCustomMessage }) });
  const execute = (name, args = {}) => tools.find(t => t.name === name).execute("test", args);
  try {
    await execute("inspectTranslationContext");
    await execute("readSourceLines", { fromLine: 1, toLine: 2 });
    await execute("readTranslationLines", { fromLine: 1, toLine: 2 });
    await execute("recordProofreadParentReview", { fromLine: 1, toLine: 2 });
    const rejected = await execute("writeProofreadFindings", { findings: [fx.finding(1, "您好")] });
    assert.equal(rejected.details.ok, false);
    assert.match(rejected.details.rejectedFindings[0].reason, /placeholder_mismatch/);
    const partial = await execute("writeProofreadFindings", { findings: [fx.finding(1, "您好 {name}"), fx.finding(2, "再会")] });
    assert.equal(partial.details.acceptedCount, 1);
    assert.equal(partial.details.rejectedCount, 1);
    assert.match(partial.details.rejectedFindings[0].reason, /custom_preserve_mismatch/);
    const repaired = await execute("writeProofreadFindings", { findings: [fx.finding(2, "再会/n")] });
    assert.equal(repaired.details.rejectedCount, 0);
    const report = JSON.parse(await readFile(repaired.details.path, "utf8"));
    assert.deepEqual(report.findings.map(f => f.sourceLine).sort(), [1, 2]);
  } finally { await fx.close(); }
});
