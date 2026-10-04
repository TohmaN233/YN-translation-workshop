import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTranslationValidation } from "../../src/main/agent/piNative/translationValidationService.ts";
import { validateTranslationCandidate } from "../../src/shared/validation/translationValidator.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-validation-worker-"));
try {
  const args = {
    sourceText: "Ａｌｉｃｅ「I shall help {name}.」\nBob「Hello %s <WAIT>」\n\n",
    candidateText: "爱丽丝「她会帮忙。」\n鲍勃「你好 %s」\n\n",
    validationOptions: { languagePair: "en->zh-CN", lineOffset: 500,
      glossaryEntries: [{ source: "help", target: "帮助" }],
      characterEntries: [{ name: "Alice", target: "爱丽丝", aliases: ["Ａｌｉｃｅ", " "], gender: "female", genderConfidence: "confirmed" },
        { name: "Bob", target: "鲍勃" }],
      customPreserveRules: [{ label: "prefix", pattern: "^Ａｌｉｃｅ", flags: "u" }] },
    diagnostics: { outputDir, documentId: "source.txt", phase: "test", fromLine: 501, toLine: 503 }
  };
  assert.deepEqual(await runTranslationValidation(args),
    validateTranslationCandidate(args.sourceText, args.candidateText, args.validationOptions));
  const result = await runTranslationValidation(args);
  assert.equal(result.sourceLineCount, 3, "trailing blank physical rows must survive range validation");
  assert.ok(result.blocking.some(finding => finding.line === 501 && finding.code === "placeholder_mismatch"));
  assert.ok(result.blocking.some(finding => finding.line === 502 && finding.code === "tag_mismatch"));
  assert.match(result.blocking[0].detail, /501/);
  const repeated = validateTranslationCandidate("A very long unique source sentence.\nAnother rather long unique source sentence.\nThird sufficiently long source sentence.\n",
    "短句\n短句\n短句\n", { languagePair: "en->zh-CN", lineOffset: 99 });
  assert.deepEqual(repeated.blocking.filter(f => f.code === "repeated_short_candidate").map(f => f.line), [100, 101, 102]);
  const controller = new AbortController();
  await assert.rejects(runTranslationValidation({ ...args,
    sourceText: "Alice says something.\n".repeat(20000), candidateText: "爱丽丝说了些什么。\n".repeat(20000),
    signal: controller.signal, onProgress: () => controller.abort(new Error("test Stop")) }), /test Stop/);
  const subsequent = await runTranslationValidation(args);
  assert.deepEqual(subsequent, result, "a cancelled worker must not contaminate the next validation");
  await assert.rejects(runTranslationValidation({ ...args, validationOptions: { lineOffset: -1 } }), /lineOffset/);
  const journal = (await readFile(path.join(outputDir, ".translation-workshop", "agent", "validation", "events.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  assert.ok(journal.some(event => event.event === "cancelled"));
  assert.ok(journal.some(event => event.event === "failed"));
  assert.ok(journal.some(event => event.event === "completed" && event.sourceLineCount === 3));
  assert.equal(journal.some(event => event.sourceText || event.candidateText), false, "diagnostics must not persist file contents");
  console.log("ok worker parity, absolute lines, blank rows, Stop, explicit errors and durable diagnostics");
} finally { await rm(outputDir, { recursive: true, force: true }); }
