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
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-review-ceiling-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "First source line.\nSecond source line.\n", "utf8");
await new PiSessionRepository(outputDir).create("review-ceiling-parent");

const models = createModels();
const translationProviders = [0, 1].map((index) => fauxProvider({
  provider: `review-ceiling-translation-${index + 1}`,
  tokensPerSecond: 1_000_000
}));
const reviewProvider = fauxProvider({
  provider: "review-ceiling-review",
  tokensPerSecond: 1_000_000
});
for (const provider of [...translationProviders, reviewProvider]) models.setProvider(provider.provider);

translationProviders[0].setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "translation-1-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: [{ id: "0", lines: ["0第一行译文。"] }]
  }, { id: "translation-1-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "translation-1-validate" }), { stopReason: "toolUse" })
]);
translationProviders[1].setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "translation-2-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: [{ id: "0", lines: ["0第二行译文。"] }]
  }, { id: "translation-2-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "translation-2-validate" }), { stopReason: "toolUse" })
]);

const bothReviewWorkersEntered = deferred();
let enteredReviewWorkers = 0;
const enterReviewWorker = (id) => async () => {
  enteredReviewWorkers += 1;
  if (enteredReviewWorkers === 2) bothReviewWorkersEntered.resolve();
  await bothReviewWorkersEntered.promise;
  return fauxAssistantMessage(
    fauxToolCall("readAssignedTranslationReview", {}, { id }),
    { stopReason: "toolUse" }
  );
};
reviewProvider.setResponses([
  enterReviewWorker("review-1-read"),
  enterReviewWorker("review-2-read"),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-1-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-2-submit" }), { stopReason: "toolUse" })
]);

const providers = new Map(
  [...translationProviders, reviewProvider].map((provider) => [provider.provider.id, provider])
);
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  createModelSelection: async ({ providerId }) => {
    const provider = providers.get(providerId);
    assert.ok(provider, `unexpected child provider ${providerId}`);
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
      sessionId: "review-ceiling-parent",
      prompt: "Translate two independent rows.",
      providerId: "parent",
      modelId: "parent",
      subagentProviderId: reviewProvider.provider.id,
      subagentModelId: reviewProvider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [
      {
        documentId: "source.txt",
        fromLine: 1,
        toLine: 1,
        label: "first",
        providerId: translationProviders[0].provider.id,
        modelId: translationProviders[0].getModel().id
      },
      {
        documentId: "source.txt",
        fromLine: 2,
        toLine: 2,
        label: "second",
        providerId: translationProviders[1].provider.id,
        modelId: translationProviders[1].getModel().id
      }
    ],
    maxWorkers: 2,
    reviewWorkerCount: 2,
    prepareChunkReview: async (review) => ({
      task: {
        auditId: `audit-${review.fromLine}`,
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 1,
        sampledLineCount: 0
      },
      read: async (task) => ({
        auditId: task.auditId,
        documentId: task.documentId,
        fromLine: task.fromLine,
        toLine: task.toLine,
        windows: [{
          fromLine: task.fromLine,
          toLine: task.toLine,
          rows: [{
            line: task.fromLine,
            source: task.fromLine === 1 ? "First source line." : "Second source line.",
            translation: task.fromLine === 1 ? "第一行译文。" : "第二行译文。",
            selected: true,
            signals: ["semantic-risk"]
          }]
        }]
      }),
      submit: async (_task, failures) => ({
        accepted: failures.length === 0,
        ...(failures.length > 0 ? {
          feedback: failures.map((failure) => ({
            line: failure.line,
            reason: failure.note ?? failure.code
          }))
        } : {})
      })
    })
  });

  await Promise.race([
    bothReviewWorkersEntered.promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`only ${enteredReviewWorkers}/2 review workers entered`)),
      3_000
    ))
  ]);
  await supervisor.waitForAll();

  const reviewBatch = supervisor.list().find((entry) => entry.kind === "translation-review");
  assert.equal(reviewBatch?.status, "completed", reviewBatch?.error);
  assert.equal(reviewBatch?.subagents.length, 2, "the supervisor must create exactly the requested two review workers");
  assert.deepEqual(
    reviewBatch?.subagents.map((worker) => worker.completedAssignments).sort(),
    [1, 1],
    "both review workers must process a real chunk rather than existing as empty records"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok the configured two-worker review ceiling starts two real Pi review workers");
