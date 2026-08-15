import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import { createPiTranslationSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-translation-context-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt"
});

try {
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(
    sourcePath,
    `${Array.from({ length: 12 }, (_, index) => `Source line ${index + 1}.`).join("\n")}\n`,
    "utf8"
  );
  await writeFile(
    candidatePath,
    `${Array.from({ length: 12 }, (_, index) => `已有译文 ${index + 1}。`).join("\n")}\n`,
    "utf8"
  );
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "translation-context-session",
      prompt: "translate sparse debt",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { documentId: "source.txt", fromLine: 6, toLine: 7 },
    publishCustomMessage: async () => {}
  });
  const readAssigned = tools.find((tool) => tool.name === "readAssignedSource");
  const readContext = tools.find((tool) => tool.name === "readTranslationContext");
  assert.ok(readAssigned);
  assert.ok(readContext, "translation workers need a bounded line-numbered context reader");

  const assigned = await readAssigned.execute("read-assigned", {});
  assert.equal(assigned.details.fromLine, 6);
  assert.equal(assigned.details.toLine, 7);
  assert.deepEqual(assigned.details.sourceBlocks, [{
    id: "0",
    absoluteLines: [6, 7],
    lines: ["0Source line 6.", "1Source line 7."]
  }]);

  const context = await readContext.execute("read-context", { fromLine: 3, toLine: 10 });
  assert.deepEqual(context.details.assignment, { fromLine: 6, toLine: 7 });
  assert.equal(context.details.rows.length, 8);
  assert.deepEqual(context.details.rows[0], {
    line: 3,
    source: "Source line 3.",
    translation: "已有译文 3。"
  });
  assert.deepEqual(context.details.rows.at(-1), {
    line: 10,
    source: "Source line 10.",
    translation: "已有译文 10。"
  });
  assert.equal(context.details.writeAllowed, false);
  await assert.rejects(
    readContext.execute("oversized-context", { fromLine: 1, toLine: 12_000 }),
    /outside|at most|range/i
  );
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok sparse translation workers can read bounded numbered context without expanding write ownership");
