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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-assignment-retry-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "one\n", "utf8");
await new PiSessionRepository(outputDir).create("parent-assignment-retry");

const models = createModels();
const provider = fauxProvider({ provider: "assignment-retry-child", tokensPerSecond: 10_000 });
models.setProvider(provider.provider);
provider.setResponses([
  async () => { throw new Error("fetch failed"); },
  async () => { throw new Error("fetch failed"); },
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "retry-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "一" }]
  }, { id: "retry-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "retry-validate" }), { stopReason: "toolUse" })
]);

const persistedCards = [];
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => persistedCards.push(message),
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
      sessionId: "parent-assignment-retry",
      prompt: "Translate the file.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    onChunkReadyForReview: async () => ({ accepted: true }),
    maxWorkers: 1
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(batch.subagents[0].status, "completed", batch.subagents[0].error);
  assert.equal(batch.subagents[0].completedAssignments, 1);
  assert.equal(batch.subagents[0].assignmentCount, 1, "provider recovery must stay inside the current assignment turn");
  const childMessages = (await new PiSessionRepository(outputDir)
    .openChild(batch.subagents[0].id)
    .then((session) => session.buildContext())).messages;
  const childUserPrompts = childMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"));
  assert.equal(childUserPrompts.length, 2, "Host validation receives its own bounded prompt");
  assert.equal(
    childUserPrompts.filter((prompt) => /Translate source file source\.txt/i.test(prompt)).length,
    1,
    "native Pi transport retry must not append the complete assignment prompt again"
  );
  assert.equal(await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"), "一\n");
  assert.equal(persistedCards.at(-1).details.status, "completed");
  assert.deepEqual(persistedCards.at(-1).details.failedDocumentIds, []);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok transient provider failure continues the same persistent-worker assignment turn");
