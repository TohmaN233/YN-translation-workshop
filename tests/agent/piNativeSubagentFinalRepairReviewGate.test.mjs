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

function translatedLine(line) {
  const high = String.fromCharCode(0x4e00 + Math.floor(line / 64));
  const low = String.fromCharCode(0x4e00 + (line % 64));
  return `这是关于主题${high}${low}的彼此独立且语义完整的中文译文内容。`;
}

function wireBlocks(fromLine, toLine, translationFor) {
  const lines = Array.from({ length: toLine - fromLine + 1 }, (_, index) => ({
    line: fromLine + index,
    translation: translationFor(fromLine + index)
  }));
  const blocks = [];
  for (let index = 0; index < lines.length; index += 16) {
    blocks.push({
      id: Math.floor(index / 16).toString(36),
      lines: lines.slice(index, index + 16).map((entry, relativeIndex) => (
        `${relativeIndex.toString(36)}${entry.translation}`
      ))
    });
  }
  return blocks;
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-final-repair-review-gate-"));
const sourcePath = path.join(outputDir, "source.txt");
const canonicalCandidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
const sourceLines = Array.from({ length: 1026 }, (_, index) => (
  `Source sentence ${index + 1} carries a different complete meaning across the chunk boundary.`
));
sourceLines[1022] = "The ancient keeper opens the northern archive after the final bell has sounded.";
sourceLines[1023] = "A young navigator records every unfamiliar constellation before sunrise.";
sourceLines[1024] = "The council postpones its winter decision until all witnesses return safely.";
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
await new PiSessionRepository(outputDir).create("final-repair-review-gate");

const models = createModels();
const provider = fauxProvider({ provider: "final-repair-child", tokensPerSecond: 1_000_000 });
models.setProvider(provider.provider);
const repeatedBoundaryTranslation = "边界之夜已然降临";
provider.setResponses([
  ...Array.from({ length: 4 }, (_, page) => {
    const fromLine = page * 256 + 1;
    const toLine = fromLine + 255;
    return [
      fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `chunk-1-page-${page + 1}-read` }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
        blocks: wireBlocks(fromLine, toLine, (line) => line >= 1023 ? repeatedBoundaryTranslation : translatedLine(line))
      }, { id: `chunk-1-page-${page + 1}-write` }), { stopReason: "toolUse" })
    ];
  }).flat(),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "chunk-1-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "chunk-2-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: wireBlocks(1025, 1025, () => repeatedBoundaryTranslation)
  }, { id: "chunk-2-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "chunk-2-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {
    fromLine: 1023,
    toLine: 1025
  }, { id: "file-repair-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [
      { line: 1023, translation: translatedLine(1023) },
      { line: 1024, translation: translatedLine(1024) },
      { line: 1025, translation: "初次修复仍有语义错误。" }
    ]
  }, { id: "file-repair-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "file-repair-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {
    fromLine: 1025,
    toLine: 1025
  }, { id: "review-repair-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1025, translation: translatedLine(1025) }]
  }, { id: "review-repair-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "next-assignment-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: wireBlocks(1026, 1026, translatedLine)
  }, { id: "next-assignment-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "next-assignment-validate" }), { stopReason: "toolUse" })
]);

const reviews = [];
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
      sessionId: "final-repair-review-gate",
      prompt: "Translate queued source ranges.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [
      { documentId: "source.txt", fromLine: 1, toLine: 1025, label: "cross-boundary" },
      { documentId: "source.txt", fromLine: 1026, toLine: 1026, label: "next-assignment" }
    ],
    maxWorkers: 1,
    onChunkReadyForReview: async (review) => {
      assert.notEqual(
        path.resolve(review.candidatePath),
        path.resolve(canonicalCandidatePath),
        "review must inspect the worker staging artifact before canonical promotion"
      );
      reviews.push({
        fromLine: review.fromLine,
        toLine: review.toLine,
        requiredLines: review.requiredLines ?? []
      });
      if (reviews.length === 3) {
        const stagingLines = (await readFile(review.candidatePath, "utf8")).trimEnd().split("\n");
        const canonicalLines = (await readFile(canonicalCandidatePath, "utf8")).trimEnd().split("\n");
        assert.equal(stagingLines[1022], translatedLine(1023));
        assert.equal(stagingLines[1023], translatedLine(1024));
        assert.equal(
          canonicalLines[1022],
          repeatedBoundaryTranslation,
          "the final repair reached canonical storage before review accepted it"
        );
        canonicalLines[999] = "用户并行保留的译文内容。";
        await writeFile(canonicalCandidatePath, `${canonicalLines.join("\n")}\n`, "utf8");
      }
      if (reviews.length === 4) {
        return {
          accepted: false,
          feedback: [{ line: 1025, reason: "The repaired row still does not preserve the source meaning." }]
        };
      }
      return { accepted: true };
    }
  });
  await supervisor.waitForAll();

  const batch = supervisor.list().find((entry) => entry.kind === "translation");
  assert.ok(batch);
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(batch.subagents[0]?.completedAssignments, 2);
  assert.equal(batch.subagents[0]?.assignmentCount, 2, "a review rejection must not retry the outer assignment");
  assert.deepEqual(
    reviews.map(({ fromLine, toLine }) => [fromLine, toLine]),
    [
      [1, 1024],
      [1025, 1025],
      [1, 1024],
      [1025, 1025],
      [1025, 1025],
      [1026, 1026]
    ],
    "the next assignment must remain queued until the whole-assignment repair is re-reviewed and accepted"
  );
  assert.deepEqual(reviews[2].requiredLines, [1023, 1024], JSON.stringify(reviews));
  assert.deepEqual(reviews[3].requiredLines, [1025]);
  assert.deepEqual(reviews[4].requiredLines, [1025]);
  const candidateLines = (await readFile(canonicalCandidatePath, "utf8")).trimEnd().split("\n");
  assert.equal(candidateLines.length, 1026);
  assert.equal(
    candidateLines[999],
    "用户并行保留的译文内容。",
    "sparse final repair overwrote an unrelated canonical line from stale staging"
  );
  assert.equal(candidateLines[1024], translatedLine(1025));
  assert.equal(candidateLines[1025], translatedLine(1026));
  const childMetadata = await new PiSessionRepository(outputDir).listChildMetadata();
  assert.equal(childMetadata.length, 1, "the same persistent Pi translator must repair and continue the queue");
  const childContext = await (await new PiSessionRepository(outputDir).openChild(childMetadata[0].id)).buildContext();
  const prompts = childContext.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text));
  assert.ok(
    prompts.some((prompt) => prompt.includes("L1025") && prompt.includes("does not preserve")),
    "the review rejection must return to the same translator with its exact line and reason"
  );
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok whole-assignment repairs return through mechanical validation and review before queue advance");
