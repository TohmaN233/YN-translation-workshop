import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-deferred-sparse-repair-"));
const sourcePath = path.join(outputDir, "source.txt");
const sourceLines = Array.from(
  { length: MAX_ASSIGNED_TRANSLATION_CHUNK_LINES + 1 },
  (_, index) => `Source ${index + 1}${index === 9 || index === MAX_ASSIGNED_TRANSLATION_CHUNK_LINES ? " HeroTerm" : ""}`
);
const firstChunk = sourceLines.slice(0, MAX_ASSIGNED_TRANSLATION_CHUNK_LINES)
  .map((_, index) => `第${index + 1}条内容已完整翻译。`);
const secondChunk = [`第${sourceLines.length}条内容已完整翻译。`];
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
await writeFile(path.join(outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
  entries: [{ source: "HeroTerm", target: "英雄术语" }]
}), "utf8");
await new PiSessionRepository(outputDir).create("parent-deferred-repair");

const models = createModels();
const provider = fauxProvider({
  provider: "deferred-repair-child",
  tokensPerSecond: 1_000_000,
  tokenSize: { min: 250_000, max: 250_000 }
});
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "chunk-1-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: translationBlocks(firstChunk)
  }, { id: "chunk-1-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 10, translation: "第10条英雄术语内容已完整翻译。" }]
  }, { id: "chunk-1-repair" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "chunk-1-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "chunk-2-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: translationBlocks(secondChunk)
  }, { id: "chunk-2-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{
      line: sourceLines.length,
      translation: `第${sourceLines.length}条英雄术语内容已完整翻译。`
    }]
  }, { id: "chunk-2-repair" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "chunk-2-validate" }), { stopReason: "toolUse" })
]);

const persistedCards = [];
const liveCards = [];
const reviewedRanges = [];
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
      sessionId: "parent-deferred-repair",
      prompt: "Translate the complete file and batch sparse repairs.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: sourceLines.length, label: "source.txt" }],
    maxWorkers: 1,
    onChunkReadyForReview: async (review) => {
      reviewedRanges.push([review.fromLine, review.toLine]);
      return { accepted: true };
    }
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  const transcript = await supervisor.inspectTranscript(batch.subagents[0].id);
  const transcriptTools = transcript.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
      : []
  ));
  assert.equal(batch.status, "completed", `${batch.error}\nTools: ${transcriptTools.join(", ")}`);
  const translated = (await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"))
    .trimEnd()
    .split("\n");
  assert.equal(translated[9], "第10条英雄术语内容已完整翻译。");
  assert.equal(translated.at(-1), `第${sourceLines.length}条英雄术语内容已完整翻译。`);
  assert.deepEqual(reviewedRanges, [
    [1, MAX_ASSIGNED_TRANSLATION_CHUNK_LINES],
    [sourceLines.length, sourceLines.length]
  ]);
  assert.equal(Object.hasOwn(persistedCards.at(-1).details, "reply"), false);
  assert.equal(
    transcript.at(-1)?.role,
    "toolResult",
    "successful validation must terminate at the Host tool result without another full-context model request"
  );
  assert.equal(transcript.at(-1)?.toolName, "validateAssignedTranslation");
  assert.deepEqual(
    liveCards.map((message) => message.details.activity),
    [
      "translating source.txt",
      `awaiting review worker for L1-L${MAX_ASSIGNED_TRANSLATION_CHUNK_LINES}`,
      `awaiting review worker for L${sourceLines.length}-L${sourceLines.length}`,
      "validated 2/2 chunks"
    ],
    "the parent receives bounded chunk-review status while sparse repair stays in child Pi JSONL"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok one Pi worker repairs sparse debt and receives parent acceptance before advancing each chunk");
