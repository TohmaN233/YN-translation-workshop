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

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-sparse-review-repair-"));
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
await new PiSessionRepository(outputDir).create("sparse-review-repair");

const models = createModels();
const translationProvider = fauxProvider({ provider: "sparse-review-translation", tokensPerSecond: 1_000_000 });
const reviewProvider = fauxProvider({ provider: "sparse-review-reader", tokensPerSecond: 1_000_000 });
models.setProvider(translationProvider.provider);
models.setProvider(reviewProvider.provider);
translationProvider.setResponses([
  fauxAssistantMessage([
    fauxToolCall("readAssignedSource", { fromLine: 10, toLine: 10 }, { id: "read-10" }),
    fauxToolCall("readAssignedSource", { fromLine: 90, toLine: 90 }, { id: "read-90" })
  ], { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    // Sparse repair ownership comes from entries, not a model-supplied broad envelope.
    fromLine: 1,
    toLine: 100,
    entries: [
      { line: 10, translation: "第十行修复译文。" },
      { line: 90, translation: "第九十行修复译文。" }
    ]
  }, { id: "repair-sparse" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Two rejected rows repaired."))
]);
reviewProvider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-1-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", {
    failures: [
      { line: 10, code: "meaning", note: "first exact rejected row" },
      { line: 90, code: "meaning", note: "second exact rejected row" }
    ]
  }, { id: "review-1-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Rejected two rows.")),
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "review-2-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "review-2-submit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Sparse repair accepted."))
]);

let modelSelectionCount = 0;
let reviewAttempt = 0;
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
      sessionId: "sparse-review-repair",
      prompt: "Reuse the accepted candidate and repair only review failures.",
      providerId: translationProvider.provider.id,
      modelId: translationProvider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 100, label: "accepted chunk" }],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async (review) => {
      reviewAttempt += 1;
      const stagedLines = (await readFile(review.candidatePath, "utf8")).split("\n");
      assert.equal(
        await readFile(candidatePath, "utf8"),
        candidateLines.join("\n"),
        "the canonical candidate must remain unchanged until review acceptance"
      );
      if (reviewAttempt === 2) {
        assert.equal(stagedLines[9], "第十行修复译文。");
        assert.equal(stagedLines[89], "第九十行修复译文。");
      }
      return ({
      task: {
        auditId: `review-${review.fromLine}-${review.toLine}-${Date.now()}`,
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 2,
        sampledLineCount: 0
      },
      read: async (task) => ({
        ...task,
        windows: [{
          fromLine: 10,
          toLine: 90,
          rows: [10, 90].map((line) => ({
            line,
            source: sourceLines[line - 1],
            translation: candidateLines[line - 1],
            selected: true,
            signals: ["semantic-risk"]
          }))
        }]
      }),
      submit: async (_task, failures) => {
        assert.equal(
          await readFile(candidatePath, "utf8"),
          candidateLines.join("\n"),
          "review submission must not expose unaccepted staging text"
        );
        return failures.length === 0
          ? { accepted: true }
          : {
              accepted: false,
              feedback: failures.map((failure) => ({
                line: failure.line,
                reason: `${failure.code}: ${failure.note}`
              }))
            };
      }
    });
    }
  });
  await supervisor.waitForAll();

  const batch = supervisor.list().find((entry) => entry.kind === "translation");
  assert.equal(batch?.status, "completed", batch?.error);
  const finalLines = (await readFile(candidatePath, "utf8")).split("\n");
  assert.equal(finalLines[9], "第十行修复译文。");
  assert.equal(finalLines[89], "第九十行修复译文。");
  assert.equal(finalLines[8], candidateLines[8], "accepted neighbors must not be rewritten");
  assert.equal(finalLines[90], candidateLines[90], "accepted neighbors must not be rewritten");

  const childId = batch.subagents[0].id;
  const childMetadata = (await new PiSessionRepository(outputDir).listChildMetadata())
    .find((entry) => entry.id === childId);
  assert.ok(childMetadata);
  const childContext = await (await new PiSessionRepository(outputDir).openChild(childId)).buildContext();
  const repairPrompt = childContext.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text))
    .find((text) => text.includes("first exact rejected row"));
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /readAssignedSource.*rejected rows/i);
  assert.match(repairPrompt, /do not read the entire owned chunk/i);
  const failedTools = childContext.messages.filter((message) => message.role === "toolResult" && message.isError);
  assert.deepEqual(failedTools, [], "the Host must accept exact review-repair rows on the first attempt");
  assert.equal(
    childContext.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text))
      .some((text) => text.includes("Complete only these missing native tools now")),
    false,
    "a sparse review repair must not fall back to rereading or rewriting the complete accepted chunk"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok review rejection repairs only exact rows without rereading or rewriting the accepted chunk");
