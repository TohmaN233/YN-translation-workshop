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

function outputBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 16) {
    blocks.push({
      id: Math.floor(index / 16).toString(36),
      lines: lines.slice(index, index + 16)
        .map((line, lineIndex) => `${lineIndex.toString(36)}第${line}行的完整中文翻译内容。`)
    });
  }
  return blocks;
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-host-bounded-repair-"));
const sourcePath = path.join(outputDir, "source.txt");
const sourceLines = Array.from({ length: 300 }, (_, index) => `Source ${index + 1}`);
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
await new PiSessionRepository(outputDir).create("parent-bounded-repair");

const models = createModels();
const provider = fauxProvider({
  provider: "host-bounded-repair-child",
  tokensPerSecond: 1_000_000,
  tokenSize: { min: 100_000, max: 100_000 }
});
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "assignment-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: outputBlocks(Array.from({ length: 16 }, (_, index) => index + 1))
  }, { id: "initial-partial-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: Array.from({ length: 240 }, (_, index) => ({
      line: index + 17,
      translation: `第${index + 17}行的完整中文翻译内容。`
    }))
  }, { id: "first-host-repair" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {
    fromLine: 257,
    toLine: 300
  }, { id: "remaining-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: outputBlocks(Array.from({ length: 44 }, (_, index) => index + 257))
  }, { id: "second-page-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "host-repair-validate" }), { stopReason: "toolUse" })
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
      sessionId: "parent-bounded-repair",
      prompt: "Translate the file and let the host own every repair turn.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: sourceLines.length }],
    onChunkReadyForReview: async () => ({ accepted: true }),
    maxWorkers: 1
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  const diagnosticTranscript = await supervisor.inspectTranscript(batch.subagents[0].id);
  const diagnosticTools = diagnosticTranscript.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
      : []
  ));
  const diagnosticErrors = diagnosticTranscript
    .filter((message) => message.role === "toolResult" && message.isError)
    .map((message) => message.content?.[0]?.text ?? String(message.content));
  assert.equal(batch.status, "completed", `${batch.error}\nTools: ${diagnosticTools.join(", ")}\nErrors: ${diagnosticErrors.join(" | ")}`);
  const childId = cards.at(-1)?.details?.subagentId;
  assert.ok(childId, "the completed worker card must reference its native Pi child session");
  const child = await new PiSessionRepository(outputDir).openChild(childId);
  const messages = (await child.buildContext()).messages;
  const userPrompts = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"));
  assert.equal(
    userPrompts.length,
    4,
    "each incomplete write and final validation must run under a fresh Host-owned prompt"
  );
  assert.match(userPrompts[1], /repairAssignedTranslation once/);
  assert.match(userPrompts[1], /target language required by the workflow \(en->zh-CN\)/i);
  assert.match(userPrompts[2], /unread or unwritten pages/i);
  assert.match(userPrompts[2], /writeAssignedTranslation/);
  assert.match(userPrompts[2], /target language required by the workflow \(en->zh-CN\)/i);
  assert.match(userPrompts[3], /mandatory native tool sequence is incomplete/i);
  assert.match(userPrompts[3], /Call validateAssignedTranslation now/i);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok large repair debt is bounded by fresh host-owned Pi turns");
