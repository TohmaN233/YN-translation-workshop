import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-interrupted-review-resume-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt"
});
await mkdir(path.dirname(candidatePath), { recursive: true });
await writeFile(sourcePath, "Open the gate.\nSave now.", "utf8");
await writeFile(candidatePath, "打开大门。\n现在保存。", "utf8");
await new PiSessionRepository(outputDir).create("interrupted-review-resume");

const models = createModels();
const translator = fauxProvider({ provider: "resume-translator", tokensPerSecond: 1_000_000 });
const reviewer = fauxProvider({ provider: "resume-reviewer", tokensPerSecond: 1_000_000 });
models.setProvider(translator.provider);
models.setProvider(reviewer.provider);
translator.setResponses([]);
reviewer.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Interrupted review accepted."))
]);

let modelSelectionCount = 0;
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  createModelSelection: async () => {
    const selected = modelSelectionCount++ === 0 ? translator : reviewer;
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
      sessionId: "interrupted-review-resume",
      prompt: "Resume the interrupted review without rewriting accepted text.",
      providerId: translator.provider.id,
      modelId: translator.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{
      documentId: "source.txt",
      fromLine: 1,
      toLine: 2,
      label: "resume interrupted review"
    }],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async (review) => ({
      task: {
        auditId: "interrupted-review-audit",
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 1,
        sampledLineCount: 1
      },
      read: async (task) => ({
        ...task,
        windows: [{
          fromLine: 1,
          toLine: 2,
          rows: [
            { line: 1, source: "Open the gate.", translation: "打开大门。", selected: true, signals: ["target_language"] },
            { line: 2, source: "Save now.", translation: "现在保存。", selected: true, signals: ["deterministic_unflagged_sample"] }
          ]
        }]
      }),
      submit: async () => ({ accepted: true })
    })
  });
  await supervisor.waitForAll();

  const batch = supervisor.list().find((entry) => entry.kind === "translation");
  assert.equal(batch?.status, "completed", batch?.error);
  const childId = batch.subagents[0].id;
  const childContext = await (await new PiSessionRepository(outputDir).openChild(childId)).buildContext();
  assert.equal(
    childContext.messages.some((message) => message.role === "user"),
    false,
    "a structurally accepted interrupted scope must resume at review without another translation-model turn"
  );
  const reviewBatch = supervisor.list().find((entry) => entry.kind === "translation-review");
  assert.equal(reviewBatch?.status, "completed", reviewBatch?.error);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok interrupted review resumes in the review pool without retranslating accepted candidate text");
