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

import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-promotion-rollback-"));
const sourcePath = path.join(outputDir, "source.txt");
const canonicalPath = path.join(outputDir, "AI_translation", "source_translated.txt");
await writeFile(sourcePath, "A complete source sentence.\n", "utf8");
await mkdir(path.dirname(canonicalPath), { recursive: true });
await writeFile(canonicalPath, "保留的旧译文。\n", "utf8");
await new PiSessionRepository(outputDir).create("promotion-rollback");

const models = createModels();
const provider = fauxProvider({ provider: "promotion-rollback", tokensPerSecond: 100_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "新的完整中文译文。" }]
  }, { id: "write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The staged line is ready for review."))
]);

let stagedPath;
let stagedContentAtReview;
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
      sessionId: "promotion-rollback",
      prompt: "Translate the assigned line.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      reviewFeedback: [{ line: 1, reason: "Replace the stale translation before Host commit." }]
    }],
    maxWorkers: 1,
    onChunkReadyForReview: async (review) => {
      stagedPath = review.candidatePath;
      stagedContentAtReview = await readFile(review.candidatePath, "utf8");
      return { accepted: true };
    },
    onArtifactMutation: async () => {
      throw new Error("simulated Host evidence persistence failure");
    }
  });
  await supervisor.waitForAll();

  const [batch] = supervisor.list();
  assert.equal(batch.status, "failed");
  assert.match(batch.error, /evidence persistence failure/i);
  assert.equal(stagedContentAtReview, "新的完整中文译文。\n");
  assert.equal(
    await readFile(canonicalPath, "utf8"),
    "保留的旧译文。\n",
    "a Host commit failure must roll the canonical range back instead of leaving unaccepted text"
  );
  assert.equal(
    await readFile(stagedPath, "utf8"),
    "新的完整中文译文。\n",
    "the accepted staging artifact must remain available for a safe retry"
  );
  console.log("ok a failed Host evidence commit rolls back canonical promotion and retains staging");
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}
