import { strict as assert } from "node:assert";
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

import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-restarted-review-repair-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt"
});
const sourceLines = Array.from({ length: 100 }, (_, index) => `Distinct English source sentence ${index + 1}.`);
const candidateLines = Array.from({ length: 100 }, (_, index) => `这是第${index + 1}行的有效中文译文。`);
await mkdir(path.dirname(candidatePath), { recursive: true });
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
await writeFile(candidatePath, candidateLines.join("\n"), "utf8");
await new PiSessionRepository(outputDir).create("restarted-review-repair");

const models = createModels();
const translationProvider = fauxProvider({ provider: "restart-review-translation", tokensPerSecond: 1_000_000 });
const reviewProvider = fauxProvider({ provider: "restart-review-reader", tokensPerSecond: 1_000_000 });
models.setProvider(translationProvider.provider);
models.setProvider(reviewProvider.provider);
translationProvider.setResponses([
  fauxAssistantMessage([
    fauxToolCall("readAssignedSource", { fromLine: 10, toLine: 10 }, { id: "read-10" }),
    fauxToolCall("readAssignedSource", { fromLine: 90, toLine: 90 }, { id: "read-90" })
  ], { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    fromLine: 10,
    toLine: 10,
    entries: [{ line: 10, translation: "第十行重启修复译文。" }]
  }, { id: "repair-10" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    fromLine: 90,
    toLine: 90,
    entries: [{ line: 90, translation: "第九十行重启修复译文。" }]
  }, { id: "repair-90" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Persisted review debt repaired."))
]);
reviewProvider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Restarted sparse repair accepted."))
]);

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
      sessionId: "restarted-review-repair",
      prompt: "Resume the persisted review rejection only.",
      providerId: translationProvider.provider.id,
      modelId: translationProvider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{
      documentId: "source.txt",
      fromLine: 1,
      toLine: 100,
      label: "persisted rejected chunk",
      reviewFeedback: [
        { line: 10, reason: "Meaning remains wrong." },
        { line: 90, reason: "Pronoun remains wrong." }
      ]
    }],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async (review) => ({
      task: {
        auditId: `restart-review-${review.fromLine}-${review.toLine}`,
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 2,
        sampledLineCount: 0
      },
      read: async (task) => ({
        ...task,
        windows: [10, 90].map((line) => ({
          fromLine: line,
          toLine: line,
          rows: [{
            line,
            source: sourceLines[line - 1],
            translation: line === 10 ? "第十行重启修复译文。" : "第九十行重启修复译文。",
            selected: true,
            signals: ["review_repair_target"]
          }]
        }))
      }),
      submit: async () => ({ accepted: true })
    })
  });
  await supervisor.waitForAll();

  const batch = supervisor.list().find((entry) => entry.kind === "translation");
  assert.equal(batch?.status, "completed", batch?.error);
  const finalLines = (await readFile(candidatePath, "utf8")).split("\n");
  assert.equal(finalLines[9], "第十行重启修复译文。");
  assert.equal(finalLines[89], "第九十行重启修复译文。");
  assert.equal(finalLines[8], candidateLines[8]);
  assert.equal(finalLines[90], candidateLines[90]);

  const childId = batch.subagents[0].id;
  const childContext = await (await new PiSessionRepository(outputDir).openChild(childId)).buildContext();
  const userPrompts = childContext.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text));
  assert.equal(userPrompts.some((text) => text.includes("Meaning remains wrong.")), true);
  assert.equal(userPrompts.some((text) => text.includes("Translate source.txt")), false);
  assert.deepEqual(
    childContext.messages.filter((message) => message.role === "toolResult" && message.isError),
    [],
    "persisted review debt must be accepted on the first native tool attempt"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok restarted review debt repairs only persisted rejected rows");
