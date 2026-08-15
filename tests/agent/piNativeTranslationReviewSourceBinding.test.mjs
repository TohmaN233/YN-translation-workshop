import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";

import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-review-source-binding-"));
const sourceRoot = path.join(outputDir, "txt");
const firstPath = path.join(sourceRoot, "first.txt");
const secondPath = path.join(sourceRoot, "second.txt");
await mkdir(sourceRoot, { recursive: true });
await writeFile(firstPath, "First source document.\n", "utf8");
await writeFile(secondPath, "Second bound source document.\n", "utf8");
await new PiSessionRepository(outputDir).create("parent-review-source-binding");

const models = createModels();
const provider = fauxProvider({ provider: "review-source-binding", tokensPerSecond: 1_000_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "read-review" }), {
    stopReason: "toolUse"
  }),
  fauxAssistantMessage(fauxToolCall("searchProjectText", {
    query: "Second bound source document",
    path: "second.txt",
    maxResults: 5
  }, { id: "search-bound-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "submit-review" }), {
    stopReason: "toolUse"
  })
]);

const baseRequest = {
  outputDir,
  sourcePath: firstPath,
  sourceSelection: { kind: "folder", path: sourceRoot },
  sessionId: "parent-review-source-binding",
  prompt: "Review the second document.",
  providerId: provider.provider.id,
  modelId: provider.getModel().id,
  languagePair: "en->zh-CN"
};
const boundRequest = {
  ...baseRequest,
  sourcePath: secondPath,
  sourceSelection: { kind: "file", path: secondPath },
  sourceRootSelection: baseRequest.sourceSelection,
  sourceDocumentId: "second.txt"
};
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
  supervisor.startTranslationReviewBatch({
    request: baseRequest,
    tasks: [{
      documentId: "second.txt",
      fromLine: 1,
      toLine: 1,
      label: "Review second.txt L1",
      reviewOnly: true
    }],
    maxWorkers: 1,
    reviewRequestForTask: async (task, subagentId, signal) => ({
      subagentId,
      label: task.label,
      documentId: task.documentId,
      fromLine: task.fromLine,
      toLine: task.toLine,
      validation: {},
      discoveries: { glossaryCandidates: [], characterFacts: [] },
      signal
    }),
    prepareChunkReview: async () => ({
      request: boundRequest,
      task: {
        auditId: "review-second-source",
        documentId: "second.txt",
        fromLine: 1,
        toLine: 1,
        riskLineCount: 0,
        sampledLineCount: 1,
        label: "Review second.txt L1"
      },
      read: async (task) => ({
        auditId: task.auditId,
        documentId: task.documentId,
        fromLine: task.fromLine,
        toLine: task.toLine,
        windows: [{
          fromLine: 1,
          toLine: 1,
          rows: [{
            line: 1,
            source: "Second bound source document.",
            translation: "第二份绑定的原文。",
            selected: true,
            signals: ["deterministic_unflagged_sample"]
          }]
        }]
      }),
      submit: async () => ({ accepted: true })
    })
  });
  await supervisor.waitForAll();

  const reviewBatch = supervisor.list().find((entry) => entry.kind === "translation-review");
  assert.equal(reviewBatch?.status, "completed", reviewBatch?.error);
  assert.equal(reviewBatch?.subagents[0]?.label, "Review second.txt L1");
  const child = await new PiSessionRepository(outputDir).openChild(reviewBatch.subagents[0].id);
  const messages = (await child.buildContext()).messages;
  const searchResult = messages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "search-bound-source"
  ));
  assert.equal(searchResult?.isError, false,
    "a persistent review worker must resolve the current assignment's document id, not the folder's initial file");
  assert.equal(searchResult?.details?.matches?.[0]?.path, "txt/second.txt");
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok persistent translation review workers bind read-only tools to the current document");
