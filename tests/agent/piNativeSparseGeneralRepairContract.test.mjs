import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPiTranslationSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-sparse-general-repair-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
const sourceLines = Array.from({ length: 500 }, (_, index) => `Source row ${index + 1}.`);
const candidateLines = sourceLines.map((_line, index) => `译文第 ${index + 1} 行。`);
const selectedLines = [5, 250, 500];

try {
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
  await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
  const mutations = [];
  const progress = {
    referenceRead: false,
    sourceRead: false,
    translationWritten: true,
    translationValidated: false,
    requiredBatchLines: new Set(selectedLines),
    writtenLines: new Set(Array.from({ length: 500 }, (_, index) => index + 1))
  };
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_sparse_general_repair",
      prompt: "repair sparse validation debt",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: {
      documentId: "source.txt",
      fromLine: 5,
      toLine: 500,
      selectedLines,
      instruction: "Repair only the three Host-selected rows."
    },
    executionMode: "bounded_repair",
    publishCustomMessage: async () => {},
    onArtifactMutation: async (_documentId, scope) => mutations.push(scope)
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  assert.ok(read);
  assert.ok(repair);

  const assigned = await read.execute("read-selected", {});
  assert.deepEqual(
    assigned.details.sourceBlocks.flatMap((block) => block.absoluteLines),
    selectedLines,
    "the model-visible assigned-source payload must contain only exact writable lines"
  );
  assert.deepEqual(
    assigned.details.currentTranslationEntries.map((entry) => Number(entry.slice(0, entry.indexOf(":")))),
    selectedLines
  );
  assert.ok(JSON.stringify(assigned.details).length < 8_000,
    "three sparse targets must not serialize the 496-line envelope into model context");

  await assert.rejects(
    repair.execute("write-outside-selection", {
      entries: [{ line: 251, translation: "越权修改。" }]
    }),
    /Host-required sparse repair set/i
  );

  await repair.execute("write-selected", {
    entries: [
      { line: 5, translation: "修正后的第 5 行。" },
      { line: 250, translation: "修正后的第 250 行。" },
      { line: 500, translation: "修正后的第 500 行。" }
    ]
  });
  assert.deepEqual(mutations, [{ fromLine: 5, toLine: 500, lines: selectedLines }],
    "the Host mutation boundary must preserve sparse ownership instead of widening it to the envelope");
  const written = (await readFile(candidatePath, "utf8")).split(/\r?\n/u);
  assert.equal(written[4], "修正后的第 5 行。");
  assert.equal(written[249], "修正后的第 250 行。");
  assert.equal(written[499], "修正后的第 500 行。");
  assert.equal(written[250], candidateLines[250], "a neighboring non-target row must remain byte-identical");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
