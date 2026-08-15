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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-review-stop-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "one", "utf8");
await new PiSessionRepository(outputDir).create("review-stop-parent");

const models = createModels();
const translator = fauxProvider({ provider: "translator", tokensPerSecond: 1_000_000 });
const reviewer = fauxProvider({ provider: "reviewer", tokensPerSecond: 1_000_000 });
models.setProvider(translator.provider);
models.setProvider(reviewer.provider);
translator.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "一" }]
  }, { id: "write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Translated."))
]);
const reviewStarted = deferred();
const releaseReview = deferred();
reviewer.setResponses([
  async () => {
    reviewStarted.resolve();
    await releaseReview.promise;
    return fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-read" }), {
      stopReason: "toolUse"
    });
  }
]);

const cards = [];
const providers = new Map([
  [translator.provider.id, translator],
  [reviewer.provider.id, reviewer]
]);
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => cards.push(message),
  publishLiveCustomMessage: async (message) => cards.push(message),
  createModelSelection: async ({ providerId }) => {
    const provider = providers.get(providerId);
    assert.ok(provider, `unexpected provider ${providerId}`);
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  }
});

try {
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "review-stop-parent",
      prompt: "translate",
      providerId: "translator",
      modelId: translator.getModel().id,
      subagentProviderId: "reviewer",
      subagentModelId: reviewer.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1, providerId: "translator" }],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async (review) => ({
      task: {
        auditId: "review-stop-audit",
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 0,
        sampledLineCount: 1
      },
      read: async () => ({
        auditId: "review-stop-audit",
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 0,
        sampledLineCount: 1,
        windows: [{
          fromLine: 1,
          toLine: 1,
          rows: [{ line: 1, source: "one", translation: "一", selected: true, signals: [] }]
        }]
      }),
      submit: async () => ({ accepted: true })
    })
  });
  await Promise.race([
    reviewStarted.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("review worker did not start")), 2_000))
  ]);
  const stopped = supervisor.abortAll();
  releaseReview.resolve();
  await Promise.race([
    supervisor.waitForAll(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Stop deadlocked in review pool")), 2_000))
  ]);
  assert.ok(stopped >= 2, "Stop must include the paused translator and active review worker");
  const reviewBatch = supervisor.list().find((batch) => batch.kind === "translation-review");
  assert.equal(reviewBatch?.status, "stopped");
  assert.equal(reviewBatch?.subagents.length, 1);
  assert.equal(reviewBatch?.subagents[0].status, "stopped");
  assert.ok(cards.some((card) => (
    card.customType === "subagent.translation-review" && card.details?.status === "stopped"
  )));
} finally {
  releaseReview.resolve();
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok Stop aborts the active translation review pool together with its paused translation worker");
