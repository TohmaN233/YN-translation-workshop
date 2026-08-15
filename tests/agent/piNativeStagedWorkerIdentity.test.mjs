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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-staged-worker-identity-"));
const sourceA = path.join(outputDir, "a.txt");
const sourceB = path.join(outputDir, "b.txt");
await writeFile(sourceA, "First source sentence.\n", "utf8");
await writeFile(sourceB, "Second source sentence.\n", "utf8");
await new PiSessionRepository(outputDir).create("staged-worker-identity");

const models = createModels();
const provider = fauxProvider({ provider: "staged-worker-identity", tokensPerSecond: 100_000 });
models.setProvider(provider.provider);
const response = (context) => {
  const toolResults = context.messages.filter((message) => message.role === "toolResult");
  if (toolResults.length === 0) {
    return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
  }
  if (toolResults.length === 1) {
    const content = toolResults[0].content;
    const payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
    return fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
      blocks: payload.sourceBlocks.map((block) => ({
        id: block.id,
        lines: block.lines.map((line) => (
          `${line.slice(0, 1)}${line.includes("First") ? "第一句译文。" : "第二句译文。"}`
        ))
      }))
    }), { stopReason: "toolUse" });
  }
  if (toolResults.length === 2) {
    return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}), { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(fauxText("Assignment complete."));
};
provider.setResponses(Array.from({ length: 20 }, () => response));

let releaseSlowSelection;
let fastSelectionStarted;
const slowSelectionGate = new Promise((resolve) => { releaseSlowSelection = resolve; });
const fastSelectionReady = new Promise((resolve) => { fastSelectionStarted = resolve; });
const cards = [];
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => cards.push(message),
  publishLiveCustomMessage: async (message) => cards.push(message),
  createModelSelection: async (request) => {
    if (request.providerId === "slow-provider") await slowSelectionGate;
    else fastSelectionStarted();
    return {
      models,
      model: provider.getModel(),
      providerId: request.providerId,
      modelId: request.modelId
    };
  }
});

try {
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath: sourceA,
      sessionId: "staged-worker-identity",
      prompt: "Translate the staged folder queue.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [
      {
        documentId: "a.txt",
        fromLine: 1,
        toLine: 1,
        label: "a.txt L1-1",
        providerId: "slow-provider",
        modelId: "slow-model"
      },
      {
        documentId: "b.txt",
        fromLine: 1,
        toLine: 1,
        label: "b.txt L1-1",
        providerId: "fast-provider",
        modelId: "fast-model"
      }
    ],
    maxWorkers: 2,
    taskStage: () => 0,
    requestForTask: (task) => ({
      outputDir,
      sourcePath: task.documentId === "a.txt" ? sourceA : sourceB,
      sessionId: "staged-worker-identity",
      prompt: `Translate ${task.documentId}.`,
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    }),
    onChunkReadyForReview: async () => ({ accepted: true })
  });

  await fastSelectionReady;
  releaseSlowSelection();
  await supervisor.waitForAll();

  const [batch] = supervisor.list();
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(batch.subagents.length, 2);
  assert.deepEqual(
    batch.subagents
      .map((worker) => ({
        label: worker.label,
        documentId: worker.documentId,
        documentIds: worker.documentIds
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId)),
    [
      { label: "a.txt L1-1", documentId: "a.txt", documentIds: ["a.txt"] },
      { label: "b.txt L1-1", documentId: "b.txt", documentIds: ["b.txt"] }
    ],
    "staged workers must be created from the task they actually claimed, not an unrelated seed task"
  );
  assert.equal(await readFile(path.join(outputDir, "AI_translation", "a_translated.txt"), "utf8"), "第一句译文。\n");
  assert.equal(await readFile(path.join(outputDir, "AI_translation", "b_translated.txt"), "utf8"), "第二句译文。\n");
  const terminalCards = cards.filter((card) => card.details?.status === "completed");
  assert.ok(terminalCards.some((card) => card.details?.currentDocumentId === "a.txt"));
  assert.ok(terminalCards.some((card) => card.details?.currentDocumentId === "b.txt"));
  console.log("ok staged persistent workers bind model, label, and document history to the task actually claimed");
} finally {
  releaseSlowSelection();
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}
