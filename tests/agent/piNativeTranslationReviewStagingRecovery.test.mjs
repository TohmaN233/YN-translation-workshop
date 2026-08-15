import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { prepareTranslationStagingCandidate } from "../../src/main/agent/writeTranslationChunk.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-review-staging-recovery-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "A complete source sentence.\n", "utf8");
await new PiSessionRepository(outputDir).create("review-staging-recovery");

const models = createModels();
const provider = fauxProvider({ provider: "review-staging-recovery", tokensPerSecond: 100_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: [{ id: "0", lines: ["0这是完整的中文译文。"] }]
  }, { id: "write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "validate" }), { stopReason: "toolUse" })
]);

let stagedPath;
let reviewStarted;
const reviewReady = new Promise((resolve) => { reviewStarted = resolve; });
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
      sessionId: "review-staging-recovery",
      prompt: "Translate the assigned line.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    maxWorkers: 1,
    onChunkReadyForReview: async (review) => {
      stagedPath = review.candidatePath;
      reviewStarted();
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(review.signal?.reason ?? new Error("Review stopped."));
        if (review.signal?.aborted) rejectAbort();
        else review.signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }
  });
  await reviewReady;
  supervisor.abortAll();
  await supervisor.waitForAll();

  assert.ok(stagedPath);
  assert.equal(await readFile(stagedPath, "utf8"), "这是完整的中文译文。\n");
  const resumed = await prepareTranslationStagingCandidate({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt",
    sessionId: "review-staging-recovery",
    subagentId: "replacement-worker",
    assignmentId: "source.txt:L1-L1",
    resumeStagingPath: stagedPath
  });
  assert.equal(resumed, stagedPath, "cold recovery must reuse the persisted review staging artifact");
console.log("ok an interrupted reviewer keeps its hash-current staging artifact for exact cold repair");
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

async function filesBelow(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  await visit(root);
  return files;
}

const preReviewOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-pre-review-staging-stop-"));
const preReviewSourcePath = path.join(preReviewOutputDir, "source.txt");
await writeFile(preReviewSourcePath, "A second complete source sentence.\n", "utf8");
await new PiSessionRepository(preReviewOutputDir).create("pre-review-staging-stop");

const preReviewModels = createModels();
const preReviewProvider = fauxProvider({ provider: "pre-review-staging-stop", tokensPerSecond: 100_000 });
preReviewModels.setProvider(preReviewProvider.provider);
let releaseFinalResponse;
let finalResponseStarted;
const finalResponseReady = new Promise((resolve) => { finalResponseStarted = resolve; });
const finalResponseGate = new Promise((resolve) => { releaseFinalResponse = resolve; });
preReviewProvider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "pre-review-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
    blocks: [{ id: "0", lines: ["0这是第二句完整译文。"] }]
  }, { id: "pre-review-write" }), { stopReason: "toolUse" }),
  async () => {
    finalResponseStarted();
    await finalResponseGate;
    return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
      id: "pre-review-validate"
    }), { stopReason: "toolUse" });
  }
]);

let checkpoint;
let unexpectedReview = false;
const preReviewSupervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  createModelSelection: async () => ({
    models: preReviewModels,
    model: preReviewProvider.getModel(),
    providerId: preReviewProvider.provider.id,
    modelId: preReviewProvider.getModel().id
  })
});

try {
  preReviewSupervisor.startTranslationBatch({
    request: {
      outputDir: preReviewOutputDir,
      sourcePath: preReviewSourcePath,
      sessionId: "pre-review-staging-stop",
      prompt: "Translate the assigned line.",
      providerId: preReviewProvider.provider.id,
      modelId: preReviewProvider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    maxWorkers: 1,
    onStagingCandidateCheckpoint: async (value) => { checkpoint = value; },
    onChunkReadyForReview: async () => {
      unexpectedReview = true;
      return { accepted: true };
    }
  });
  await finalResponseReady;
  const stagingRoot = path.join(
    preReviewOutputDir,
    ".translation-workshop",
    "agent",
    "translation-staging"
  );
  const [stagedPath] = (await filesBelow(stagingRoot)).filter((file) => file.endsWith(".txt"));
  assert.ok(stagedPath, "the accepted child write must exist in staging before reviewer handoff");
  assert.equal(await readFile(stagedPath, "utf8"), "这是第二句完整译文。\n");

  preReviewSupervisor.abortAll();
  releaseFinalResponse();
  await preReviewSupervisor.waitForAll();

  assert.equal(unexpectedReview, false, "the stop must land before reviewer handoff");
  assert.equal(checkpoint?.candidatePath, stagedPath,
    "a successful staging write must checkpoint its recovery path before another provider turn");
  assert.equal(checkpoint?.accepted, true);
  assert.equal(await readFile(stagedPath, "utf8"), "这是第二句完整译文。\n",
    "Stop must not delete an accepted staging write that has not reached the reviewer yet");
  console.log("ok Stop preserves and checkpoints a successful staging write before reviewer handoff");
} finally {
  preReviewSupervisor.abortAll();
  releaseFinalResponse();
  await preReviewSupervisor.waitForAll();
  await rm(preReviewOutputDir, { recursive: true, force: true });
}
