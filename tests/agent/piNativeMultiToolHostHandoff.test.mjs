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

function latestUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-multi-tool-handoff-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, [
  "これは一行目です。",
  "これは二行目です。",
  "これは三行目です。",
  "これは四行目です。"
].join("\n"), "utf8");
await new PiSessionRepository(outputDir).create("parent-multi-tool-handoff");

const models = createModels();
const provider = fauxProvider({
  provider: "multi-tool-host-handoff-child",
  tokensPerSecond: 1_000_000,
  tokenSize: { min: 100_000, max: 100_000 }
});
models.setProvider(provider.provider);
const providerUserPrompts = [];
provider.setResponses([
  async (context) => {
    providerUserPrompts.push(latestUserText(context));
    return fauxAssistantMessage([
      fauxToolCall("readAssignedSource", { fromLine: 1, toLine: 4 }, { id: "batch-read" }),
      fauxToolCall("writeAssignedTranslation", {
        fromLine: 1,
        toLine: 4,
        blocks: [{ id: "0", lines: ["0这是第一行。"] }]
      }, { id: "batch-partial-write" }),
      fauxToolCall("validateAssignedTranslation", {}, { id: "batch-early-validate" })
    ], { stopReason: "toolUse" });
  },
  async (context) => {
    providerUserPrompts.push(latestUserText(context));
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: [
        { line: 2, translation: "这是第二行。" },
        { line: 3, translation: "这是第三行。" },
        { line: 4, translation: "这是第四行。" }
      ]
    }, { id: "host-owned-repair" }), { stopReason: "toolUse" });
  },
  async (context) => {
    providerUserPrompts.push(latestUserText(context));
    return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
      id: "host-owned-validate"
    }), { stopReason: "toolUse" });
  }
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
      sessionId: "parent-multi-tool-handoff",
      prompt: "Translate the complete assigned file.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "ja->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 4 }],
    onChunkReadyForReview: async () => ({ accepted: true }),
    maxWorkers: 1
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(providerUserPrompts.length, 3);
  assert.match(
    providerUserPrompts[1],
    /host rejected only the listed lines[\s\S]*repairAssignedTranslation/i,
    "a mixed tool batch must return control to the host before the next provider call"
  );
  assert.notEqual(
    providerUserPrompts[1],
    providerUserPrompts[0],
    "the provider must not continue the same Pi turn after an incomplete translation write"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok mixed translation tool batches hand control back to the host before repair");
