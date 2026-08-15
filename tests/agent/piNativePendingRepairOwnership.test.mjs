import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function outputBlocks(lines, translate) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 16) {
    blocks.push({
      id: Math.floor(index / 16).toString(36),
      lines: lines.slice(index, index + 16)
        .map((line, lineIndex) => `${lineIndex.toString(36)}${translate(line)}`)
    });
  }
  return blocks;
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-pending-repair-"));
const sourcePath = path.join(outputDir, "source.txt");
const sourceLines = Array.from({ length: 300 }, (_, index) => (
  index < 272 ? `これは翻訳が必要な日本語の原文です ${index + 1}` : "？？？"
));
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
await new PiSessionRepository(outputDir).create("parent-pending-repair");

const models = createModels();
const provider = fauxProvider({
  provider: "pending-repair-child",
  tokensPerSecond: 1_000_000,
  tokenSize: { min: 100_000, max: 100_000 }
});
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "assignment-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    fromLine: 1,
    toLine: sourceLines.length,
    blocks: outputBlocks(
      Array.from({ length: 16 }, (_, index) => index + 1),
      (line) => `译文 ${line}`
    )
  }, { id: "initial-partial-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: Array.from({ length: 256 }, (_, index) => ({
      line: index + 17,
      translation: `译文 ${index + 17}`
    }))
  }, { id: "bounded-block-repair" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: Array.from({ length: 28 }, (_, index) => ({
      line: index + 273,
      translation: `待确认 ${index + 273}`
    }))
  }, { id: "remaining-block-repair" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
    id: "final-validate"
  }), { stopReason: "toolUse" })
]);

const cards = [];
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => cards.push(message),
  publishLiveCustomMessage: async () => {},
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
      sessionId: "parent-pending-repair",
      prompt: "Translate the file and retain valid partial output.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "ja->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: sourceLines.length }],
    onChunkReadyForReview: async () => ({ accepted: true }),
    maxWorkers: 1
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  const childId = cards.at(-1)?.details?.subagentId;
  assert.ok(childId);
  const child = await new PiSessionRepository(outputDir).openChild(childId);
  const userPrompts = (await child.buildContext()).messages
    .filter((message) => message.role === "user")
    .map((message) => message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"));
  assert.equal(userPrompts.length, 4, "host-required short lines and final validation need bounded Host-owned Pi turns");
  assert.match(userPrompts[1], /repairAssignedTranslation once/);
  assert.match(userPrompts[2], /repairAssignedTranslation once/);
  assert.doesNotMatch(userPrompts[2], /mandatory native tool sequence/i);
  assert.match(userPrompts[3], /mandatory native tool sequence is incomplete/i);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok pending host-required lines remain repair debt even when the ordinary validator has only warnings");
