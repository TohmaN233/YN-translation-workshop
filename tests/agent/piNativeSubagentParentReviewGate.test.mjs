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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-parent-review-gate-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "First meaning.\nSecond meaning.", "utf8");
await new PiSessionRepository(outputDir).create("parent-review-gate");

const models = createModels();
const translationProvider = fauxProvider({ provider: "translation-child", tokensPerSecond: 1_000_000 });
const reviewProvider = fauxProvider({ provider: "translation-review-child", tokensPerSecond: 1_000_000 });
models.setProvider(translationProvider.provider);
models.setProvider(reviewProvider.provider);
translationProvider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "first-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: [{ id: "0", lines: ["0错误但结构合法的译文。"] }]
  }, { id: "first-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "first-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "repair-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "第一句含义。" }]
  }, { id: "repair-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "second-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: [{ id: "0", lines: ["0第二句含义。"] }]
  }, { id: "second-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "second-validate" }), { stopReason: "toolUse" })
]);
reviewProvider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-first-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", {
    failures: [{ line: 1, code: "meaning", note: "does not preserve the first source sentence" }]
  }, { id: "review-first-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-repair-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-repair-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-second-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-second-submit" }), { stopReason: "toolUse" })
]);

const reviews = [];
let modelSelectionCount = 0;
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  createModelSelection: async () => {
    const selected = modelSelectionCount++ === 0 ? translationProvider : reviewProvider;
    return {
      models,
      model: selected.getModel(),
      providerId: selected.provider.id,
      modelId: selected.getModel().id
    };
  }
});

try {
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "parent-review-gate",
      prompt: "Translate two queued rows.",
      providerId: translationProvider.provider.id,
      modelId: translationProvider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [
      { documentId: "source.txt", fromLine: 1, toLine: 1, label: "first" },
      { documentId: "source.txt", fromLine: 2, toLine: 2, label: "second" }
    ],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async (review) => ({
      task: {
        auditId: `audit-${reviews.length + 1}`,
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
            source: task.fromLine === 1 ? "First meaning." : "Second meaning.",
            translation: task.fromLine === 1 ? "0错误但结构合法的译文。" : "第二句含义。",
            selected: true,
            signals: ["semantic-risk"]
          }]
        }]
      }),
      submit: async (task, failures) => {
        reviews.push({ review, task, failures });
        return failures.length === 0
          ? { accepted: true }
          : {
              accepted: false,
              feedback: failures.map((failure) => ({
                line: failure.line,
                reason: `${failure.code}: ${failure.note ?? "repair this line"}`
              }))
            };
      }
    })
  });
  await supervisor.waitForAll();

  const batch = supervisor.list().find((entry) => entry.kind === "translation");
  assert.ok(batch);
  assert.equal(batch.status, "completed", batch.error);
  assert.deepEqual(
    reviews.map(({ review }) => [review.subagentId, review.fromLine, review.toLine]),
    [
      [batch.subagents[0].id, 1, 1],
      [batch.subagents[0].id, 1, 1],
      [batch.subagents[0].id, 2, 2]
    ],
    "a rejected chunk must return to the same persistent Pi child before that child claims the next assignment"
  );
  assert.deepEqual(
    (await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8")).trimEnd().split("\n"),
    ["第一句含义。", "第二句含义。"]
  );
  const childMetadata = await new PiSessionRepository(outputDir).listChildMetadata();
  assert.equal(childMetadata.length, 2, "one persistent translator and one persistent reviewer should own all assignments");
  const translationMetadata = childMetadata.find((entry) => entry.id === batch.subagents[0].id);
  assert.ok(translationMetadata);
  const childContext = await (await new PiSessionRepository(outputDir).openChild(translationMetadata.id)).buildContext();
  const prompts = childContext.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text));
  assert.ok(
    prompts.some((prompt) => prompt.includes("L1") && prompt.includes("does not preserve")),
    "the same child must receive the review worker's exact rejected line and reason"
  );
  const reviewBatch = supervisor.list().find((entry) => entry.kind === "translation-review");
  assert.equal(reviewBatch?.status, "completed");
  assert.equal(reviewBatch?.subagents.length, 1);
  assert.equal(reviewBatch?.subagents[0].completedAssignments, 3);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok review worker rejects back to the same translation child before queue advance");
