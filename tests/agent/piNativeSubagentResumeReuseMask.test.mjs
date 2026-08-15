import assert from "node:assert/strict";
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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-reuse-mask-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
await mkdir(path.dirname(candidatePath), { recursive: true });
await writeFile(sourcePath, "one\ntwo\nthree\n", "utf8");
await writeFile(candidatePath, "一\n\n三\n", "utf8");
await new PiSessionRepository(outputDir).create("parent-reuse-mask");

const models = createModels();
const provider = fauxProvider({ provider: "reuse-mask-child", tokensPerSecond: 10_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "read-missing" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 2, translation: "二" }]
  }, { id: "repair-missing" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "validate-mask" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Missing line translated."))
]);

const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
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
      sourceDocumentId: "source.txt",
      sessionId: "parent-reuse-mask",
      prompt: "Translate only rejected reuse lines.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 3 }],
    onChunkReadyForReview: async () => ({ accepted: true }),
    maxWorkers: 1
  });
  await supervisor.waitForAll();
  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(await readFile(candidatePath, "utf8"), "一\n二\n三\n");
  const repository = new PiSessionRepository(outputDir);
  const [child] = await repository.listChildMetadata();
  const context = await (await repository.openChild(child.id)).buildContext();
  const firstPrompt = context.messages.find((message) => message.role === "user")
    .content.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(firstPrompt, /required.*line/i);
  assert.match(firstPrompt, /\b2\b/);
  assert.doesNotMatch(firstPrompt, /translate.*L1-L3.*according to/i);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok applied reuse mask preserves accepted lines and repairs only blanked lines");
