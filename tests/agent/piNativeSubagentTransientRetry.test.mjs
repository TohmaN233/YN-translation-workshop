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

import { runPiTranslationSubagent } from "../../src/main/agent/piNative/subagentRunner.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

async function runCase(name, responses, options = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), `yn-pi-child-retry-${name}-`));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: `transient-child-${name}`, tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses(responses);
  const cards = [];
  const run = runPiTranslationSubagent({
    request: {
      outputDir,
      sourcePath,
      sessionId: `parent-retry-${name}`,
      prompt: "Translate the source.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1, label: `retry-child-${name}` },
    subagentId: `retry-child-${name}`,
    publishCustomMessage: async (message) => cards.push(message),
    publishLiveCustomMessage: async (message) => {
      cards.push(message);
      options.onLiveCard?.(message);
    },
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    }),
    signal: options.signal,
    providerStreamTimeouts: options.providerStreamTimeouts
  });
  return { outputDir, cards, run };
}

const stalledAbort = new AbortController();
const stalled = await runCase("stalled", [
  (_context, streamOptions) => new Promise((_resolve, reject) => {
    const onAbort = () => reject(new Error("stalled provider observed abort"));
    streamOptions?.signal?.addEventListener("abort", onAbort, { once: true });
    if (streamOptions?.signal?.aborted) onAbort();
  }),
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "stalled-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "一" }]
  }, { id: "stalled-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "stalled-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Recovered after the stalled provider stream."))
], {
  signal: stalledAbort.signal,
  providerStreamTimeouts: { inactivityMs: 30, totalMs: 200 }
});
try {
  const outcome = await Promise.race([
    stalled.run.then((result) => ({ status: "completed", result })),
    new Promise((resolve) => setTimeout(() => resolve({ status: "hung" }), 900))
  ]);
  if (outcome.status === "hung") stalledAbort.abort(new DOMException("stalled retry test cleanup", "AbortError"));
  assert.equal(outcome.status, "completed", "a stalled child provider stream never entered the existing Pi retry path");
  assert.equal(outcome.result.validation.ok, true);
  assert.equal(stalled.cards.at(-1).details.status, "completed");
} finally {
  await Promise.allSettled([stalled.run]);
  await rm(stalled.outputDir, { recursive: true, force: true });
}

let recoveredAttempts = 0;
const recovered = await runCase("recovered", [
  async () => {
    recoveredAttempts += 1;
    throw new Error("fetch failed");
  },
  async () => {
    recoveredAttempts += 1;
    return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "retry-read" }), { stopReason: "toolUse" });
  },
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "一" }]
  }, { id: "retry-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "retry-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Recovered and completed."))
]);
try {
  const result = await recovered.run;
  assert.equal(recoveredAttempts, 2);
  assert.equal(result.validation.ok, true);
  assert.equal(await readFile(path.join(recovered.outputDir, "AI_translation", "source_translated.txt"), "utf8"), "一\n");
  assert.equal(recovered.cards.at(-1).details.status, "completed");
  assert.equal(recovered.cards.some((card) => card.details.status === "failed"), false);
} finally {
  await rm(recovered.outputDir, { recursive: true, force: true });
}

let boundedAttempts = 0;
const bounded = await runCase("bounded", Array.from({ length: 3 }, () => async () => {
  boundedAttempts += 1;
  throw new Error("fetch failed");
}));
try {
  await assert.rejects(bounded.run, /fetch failed/);
  assert.equal(boundedAttempts, 3, "retryable provider failures must stop after two retries");
  const boundedMessages = (await new PiSessionRepository(bounded.outputDir)
    .openChild("retry-child-bounded")
    .then((session) => session.buildContext())).messages;
  assert.equal(
    boundedMessages.filter((message) => message.role === "user").length,
    1,
    "provider retry must continue the same Pi turn instead of duplicating the full assignment prompt"
  );
  assert.equal(bounded.cards.at(-1).details.status, "failed");
} finally {
  await rm(bounded.outputDir, { recursive: true, force: true });
}

let nonRetryableAttempts = 0;
const nonRetryable = await runCase("non-retryable", [async () => {
  nonRetryableAttempts += 1;
  return fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" });
}]);
try {
  await assert.rejects(nonRetryable.run, /insufficient_quota/);
  assert.equal(nonRetryableAttempts, 1, "non-retryable provider failures must fail immediately");
} finally {
  await rm(nonRetryable.outputDir, { recursive: true, force: true });
}

const abortController = new AbortController();
let abortAttempts = 0;
let abortScheduled = false;
const abortable = await runCase("abortable", [async () => {
  abortAttempts += 1;
  throw new Error("fetch failed");
}], {
  signal: abortController.signal,
  onLiveCard(message) {
    if (abortScheduled || message.details?.retryAttempt !== 1) return;
    abortScheduled = true;
    setTimeout(() => abortController.abort(new DOMException("test abort", "AbortError")), 25);
  }
});
const abortStartedAt = Date.now();
try {
  await assert.rejects(abortable.run, /test abort|AbortError|aborted/i);
  assert.equal(abortAttempts, 1, "aborting retry backoff must not start another provider request");
  assert.ok(Date.now() - abortStartedAt < 225, "AbortSignal must interrupt the 250ms retry delay");
} finally {
  await rm(abortable.outputDir, { recursive: true, force: true });
}

console.log("ok Pi child retries are transient-only, bounded, abortable, and resume the same child session");
