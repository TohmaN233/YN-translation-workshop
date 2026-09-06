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
    `${Array.from({ length: 600 }, (_, index) => `Source line ${index + 1}.`).join("\n")}\n`,
    "utf8"
  );
  await writeFile(
    candidatePath,
    `${Array.from({ length: 600 }, (_, index) => `已有译文 ${index + 1}。`).join("\n")}\n`,
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
    task: { documentId: "source.txt", fromLine: 60, toLine: 61 },
    publishCustomMessage: async () => {}
  });
  const readAssigned = tools.find((tool) => tool.name === "readAssignedSource");
  const readContext = tools.find((tool) => tool.name === "readTranslationContext");
  assert.ok(readAssigned);
  assert.ok(readContext, "translation workers need a bounded line-numbered context reader");

  const assigned = await readAssigned.execute("read-assigned", {});
  assert.equal(assigned.details.fromLine, 60);
  assert.equal(assigned.details.toLine, 61);
  assert.deepEqual(assigned.details.sourceBlocks, [{
    id: "0",
    absoluteLines: [60, 61],
    lines: ["0Source line 60.", "1Source line 61."]
  }]);

  const context = await readContext.execute("read-context", { fromLine: 57, toLine: 64 });
  assert.deepEqual(context.details.assignment, { fromLine: 60, toLine: 61 });
  assert.equal(context.details.rows.length, 8);
  assert.deepEqual(context.details.rows[0], {
    line: 57,
    source: "Source line 57.",
    translation: "已有译文 57。"
  });
  assert.deepEqual(context.details.rows.at(-1), {
    line: 64,
    source: "Source line 64.",
    translation: "已有译文 64。"
  });
  assert.equal(context.details.writeAllowed, false);
  const pagedContext = await readContext.execute("oversized-context", { fromLine: 1, toLine: 63 });
  assert.equal(pagedContext.details.fromLine, 1);
  assert.equal(pagedContext.details.toLine, 40);
  assert.equal(pagedContext.details.requestedToLine, 63);
  assert.equal(pagedContext.details.hasMore, true);
  assert.equal(pagedContext.details.nextFromLine, 41);
  await readContext.execute("context-budget-b", { fromLine: 65, toLine: 96 });
  const laterContext = await readContext.execute("context-after-80-lines", { fromLine: 101, toLine: 105 });
  assert.deepEqual(laterContext.details.rows.map((row) => row.line), [101, 102, 103, 104, 105],
    "read-only context must remain available after 80 unique lines in a long-lived assignment");

  const largeTools = createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "translation-page-session",
      prompt: "translate a large logical assignment",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { documentId: "source.txt", fromLine: 1, toLine: 600 },
    publishCustomMessage: async () => {}
  });
  const readLargeAssignment = largeTools.find((tool) => tool.name === "readAssignedSource");
  const firstPage = await readLargeAssignment.execute("read-first-model-page", {});
  assert.equal(firstPage.details.fromLine, 1);
  assert.equal(firstPage.details.toLine, 500);
  assert.equal(firstPage.details.hasMore, true);
  assert.equal(firstPage.details.nextFromLine, 501,
    "model-visible source paging must not change the 600-line logical assignment ownership");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok sparse translation workers can read bounded numbered context without expanding write ownership");
