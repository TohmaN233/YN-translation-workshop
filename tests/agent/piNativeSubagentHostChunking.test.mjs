import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";

import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { MAX_ASSIGNED_TRANSLATION_CHUNK_LINES } from "../../src/main/agent/piNative/subagentRunner.ts";

assert.ok(
  MAX_ASSIGNED_TRANSLATION_CHUNK_LINES === 1024,
  "one persistent worker must keep file ownership while each model write amortizes provider setup across a bounded structured Luna response"
);

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-host-chunks-"));
const sourcePath = path.join(outputDir, "source.txt");
const sourceLines = Array.from({ length: MAX_ASSIGNED_TRANSLATION_CHUNK_LINES + 1 }, (_, index) => `The numbered record is ${index + 1}.`);
const firstChunk = Array.from({ length: MAX_ASSIGNED_TRANSLATION_CHUNK_LINES }, (_, index) => `编号为${index + 1}的记录。`);
const secondChunk = [`编号为${MAX_ASSIGNED_TRANSLATION_CHUNK_LINES + 1}的记录。`];
function translationBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 16) {
    blocks.push({
      id: Math.floor(index / 16).toString(36),
      lines: lines.slice(index, index + 16)
        .map((line, lineIndex) => `${lineIndex.toString(36)}${line}`)
    });
  }
  return blocks;
}
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
await new PiSessionRepository(outputDir).create("parent-host-chunks");

const models = createModels();
const provider = fauxProvider({
  provider: "host-chunk-child",
  tokensPerSecond: 1_000_000,
  tokenSize: { min: 250_000, max: 250_000 }
});
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "chunk-1-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: translationBlocks(firstChunk)
  }, { id: "chunk-1-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "chunk-1-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "chunk-2-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: translationBlocks(secondChunk)
  }, { id: "chunk-2-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "chunk-2-validate" }), { stopReason: "toolUse" })
]);

const persistedCards = [];
const liveCards = [];
const chunkReviews = [];
let releaseFirstReview;
const firstReview = new Promise((resolve) => {
  releaseFirstReview = resolve;
});
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => persistedCards.push(message),
  publishLiveCustomMessage: async (message) => liveCards.push(message),
  createModelSelection: async () => ({
    models,
    model: provider.getModel(),
    providerId: provider.provider.id,
    modelId: provider.getModel().id
  })
});

try {
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "parent-host-chunks",
      prompt: "Translate the complete file.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: sourceLines.length, label: "source.txt" }],
    maxWorkers: 1,
    onChunkReadyForReview: async (review) => {
      chunkReviews.push(review);
      if (chunkReviews.length === 1) return firstReview;
      return { accepted: true };
    }
  });
  for (let attempt = 0; attempt < 100 && chunkReviews.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const earlyBatch = supervisor.list()[0];
  const earlyTranscript = earlyBatch?.subagents[0]
    ? await supervisor.inspectTranscript(earlyBatch.subagents[0].id)
    : [];
  const earlyErrors = earlyTranscript.flatMap((message) => message.role === "toolResult"
    ? message.content.map((block) => block.type === "text" ? `${message.toolName}:${block.text.slice(0, 1_000)}` : "")
    : []);
  assert.equal(
    chunkReviews.length,
    1,
    `the first translated chunk must enter review immediately: ${JSON.stringify(supervisor.list())}; pending responses=${provider.getPendingResponseCount()}; tool errors=${JSON.stringify(earlyErrors)}`
  );
  assert.equal(provider.getPendingResponseCount(), 3, "the child must not begin the second chunk before parent acceptance");
  releaseFirstReview({ accepted: true });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(batch.subagents[0].status, "completed", batch.subagents[0].error);
  const translated = (await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"))
    .trimEnd()
    .split("\n");
  assert.deepEqual(translated, [...firstChunk, ...secondChunk]);
  assert.deepEqual(
    chunkReviews.map((review) => [review.fromLine, review.toLine]),
    [[1, MAX_ASSIGNED_TRANSLATION_CHUNK_LINES], [MAX_ASSIGNED_TRANSLATION_CHUNK_LINES + 1, sourceLines.length]],
    "each host-owned chunk must receive its own review-worker gate"
  );
  assert.deepEqual(
    persistedCards.map((message) => message.details.status),
    ["running", "completed"],
    "parent Pi JSONL must persist only the worker's initial and terminal cards"
  );
  assert.deepEqual(
    liveCards.map((message) => message.details.activity),
    [
      "translating source.txt",
      `awaiting review worker for L1-L${MAX_ASSIGNED_TRANSLATION_CHUNK_LINES}`,
      `awaiting review worker for L${MAX_ASSIGNED_TRANSLATION_CHUNK_LINES + 1}-L${sourceLines.length}`,
      "validated 2/2 chunks"
    ],
    "the lightweight child card must expose each parent-review pause without embedding child transcript"
  );
  assert.ok(
    [...persistedCards, ...liveCards].every((message) => (
      !Object.hasOwn(message.details, "transcript")
      && Buffer.byteLength(JSON.stringify(message)) < 16_384
    )),
    "worker progress must stay lightweight and must never embed the child transcript"
  );
  assert.equal(persistedCards.at(-1).details.status, "completed");
  assert.match(persistedCards.at(-1).details.resultSummary, /Review-worker-accepted candidate for source\.txt.*accepted before queue advance/i);
  const repository = new PiSessionRepository(outputDir);
  const [childMetadata] = await repository.listChildMetadata();
  const childContext = await (await repository.openChild(childMetadata.id)).buildContext();
  const userPrompts = childContext.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"));
  const assignmentPrompts = userPrompts.filter((prompt) => /Translate source file source\.txt/i.test(prompt));
  assert.equal(assignmentPrompts.length, 2);
  assert.ok(assignmentPrompts.every((prompt) => /call readAssignedSource/i.test(prompt)));
  assert.ok(assignmentPrompts.every((prompt) => !/Host-provided sourceBlocks/i.test(prompt)));
  assert.ok(assignmentPrompts.every((prompt) => !prompt.includes("Source 1")));
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok one persistent Pi worker processes a large file through host-owned sequential chunks");
