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

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-review-settlement-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "one\ntwo", "utf8");
await new PiSessionRepository(outputDir).create("review-settlement-parent");

const provider = fauxProvider({ provider: "translator", tokensPerSecond: 1_000_000 });
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "\u4e00" }, { line: 2, translation: "\u4e8c" }]
  }, { id: "write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Translated."))
]);
const models = createModels();
models.setProvider(provider.provider);
const reviewFailure = new Error("forced review-pool close failure");
const domainRun = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 1
});
domainRun.recordInspection({
  sourceLineCount: 2,
  documents: [{ id: "source.txt", sourceLineCount: 2 }],
  glossaryCandidateExists: true,
  characterBibleExists: true
});

let settledOutcome;
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
supervisor.startTranslationReviewPool = () => ({
  batchId: "review-pool",
  enqueue: async () => ({ accepted: true }),
  close: async () => { throw reviewFailure; },
  abort: () => 0
});

try {
  const batch = supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "review-settlement-parent",
      prompt: "translate",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 2 }],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async () => { throw new Error("the injected review pool owns preparation"); },
    onSettled: async (outcome) => {
      settledOutcome = outcome;
      if (outcome.error !== undefined) {
        domainRun.recordSubagentBatchFailure("translation", outcome.batch.id, ["source.txt"]);
      }
    }
  });
  domainRun.recordSubagentBatchStarted("translation", batch.id, {
    taskCount: 1,
    workerCount: 1,
    documentIds: ["source.txt"]
  });
  await supervisor.waitForAll();

  assert.equal(settledOutcome?.error, reviewFailure, "review settlement failure must reach the Host callback");
  assert.equal(settledOutcome?.batch.status, "failed");
  assert.equal(
    domainRun.snapshot().documents[0].activeSubagentBatch,
    undefined,
    "Host must clear the active translation batch after review-pool settlement fails"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok review-pool settlement failures reach the Host and clear active batch ownership");
