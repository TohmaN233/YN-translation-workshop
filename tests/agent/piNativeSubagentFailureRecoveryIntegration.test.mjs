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

import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function text(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolCalls(messages, name) {
  return messages.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall" && block.name === name)
      : []
  ));
}

async function waitUntil(predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-recovery-"));
const sourcePath = path.join(workspaceDir, "source.txt");
await writeFile(sourcePath, "one\ntwo", "utf8");

const releaseFirstBatch = deferred();
const firstHealthyStarted = deferred();
const firstFailureTriggered = deferred();
const releaseRetryBatch = deferred();
const models = createModels();
const providers = new Map();

const parent = fauxProvider({ provider: "recovery-parent", tokensPerSecond: 1000 });
models.setProvider(parent.provider);
providers.set(parent.provider.id, parent);
parent.setResponses([
  fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "inspect-context" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {}, { id: "spawn-first-batch" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The first native Pi batch is running in the background.")),
  fauxAssistantMessage(fauxText("One child failed after the healthy sibling completed. The workflow is paused until the user explicitly continues it.")),
  fauxAssistantMessage(fauxToolCall("resumeYnWorkflow", {}, {
    id: "resume-after-explicit-user-continuation"
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {}, { id: "spawn-repair-batch" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The failed range is being repaired by a new native Pi batch.")),
  fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, {
    id: "validate-recovered-artifact"
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The failed child was recovered and the final host validation passed."))
]);

const reviewer = fauxProvider({ provider: "recovery-review", tokensPerSecond: 1000 });
models.setProvider(reviewer.provider);
providers.set(reviewer.provider.id, reviewer);
reviewer.setResponses([1, 2, 3].flatMap((index) => [
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, {
    id: `recovery-review-${index}-read`
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, {
    id: `recovery-review-${index}-submit`
  }), { stopReason: "toolUse" })
]));

const firstHealthy = fauxProvider({ provider: "first-healthy", tokensPerSecond: 1000 });
models.setProvider(firstHealthy.provider);
providers.set(firstHealthy.provider.id, firstHealthy);
firstHealthy.setResponses([
  async () => {
    firstHealthyStarted.resolve();
    await releaseFirstBatch.promise;
    await firstFailureTriggered.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, {
      id: "first-healthy-read"
    }), { stopReason: "toolUse" });
  },
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "一" }]
  }, { id: "first-healthy-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
    id: "first-healthy-validate"
  }), { stopReason: "toolUse" })
]);

const firstFailing = fauxProvider({ provider: "first-failing", tokensPerSecond: 1000 });
models.setProvider(firstFailing.provider);
providers.set(firstFailing.provider.id, firstFailing);
firstFailing.setResponses([
  async () => {
    await releaseFirstBatch.promise;
    await firstHealthyStarted.promise;
    firstFailureTriggered.resolve();
    throw new Error("forced first-batch child failure");
  }
]);

for (const providerId of ["retry-a"]) {
  const child = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(child.provider);
  providers.set(providerId, child);
  child.setResponses([
    async () => {
      await releaseRetryBatch.promise;
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, {
        id: `${providerId}-read`
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: [{ line: 2, translation: "二" }]
    }, { id: `${providerId}-write` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
      id: `${providerId}-validate`
    }), { stopReason: "toolUse" })
  ]);
}

let translationSelectionCount = 0;
const translationProviders = [
  "first-healthy",
  "first-failing",
  reviewer.provider.id,
  "retry-a",
  reviewer.provider.id
];
const service = new PiNativeSessionService({
  createModelSelection: async ({ providerId }) => {
    const provider = providerId === "translation-test-lane"
      ? providers.get(translationProviders[translationSelectionCount++])
      : providers.get(providerId || parent.provider.id);
    assert.ok(provider, `unknown test provider ${providerId}`);
    return {
      models,
      model: provider.getModel(),
      providerId: providerId === "translation-test-lane" ? providerId : provider.provider.id,
      modelId: provider.getModel().id
    };
  },
  createTools: createYnDomainTools,
  buildSystemPrompt: () => "Use native Pi child runtimes. Repair a failed child batch, then validate the complete artifact.",
  enforceDomainCompletion: true
});

let settledCount = 0;
const settledWaiters = [];
const unsubscribe = service.subscribeEvents((entry) => {
  if (entry.event.type !== "settled") return;
  settledCount += 1;
  for (const waiter of [...settledWaiters]) {
    if (settledCount >= waiter.count) waiter.resolve();
  }
});

const waitForSettled = (count) => {
  if (settledCount >= count) return Promise.resolve();
  const pending = deferred();
  settledWaiters.push({ count, resolve: pending.resolve });
  return Promise.race([
    pending.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for parent settled ${count}`)), 5000))
  ]);
};

try {
  const session = await service.createSession(workspaceDir);
  await service.prompt({
    outputDir: workspaceDir,
    sessionId: session.id,
    prompt: "Workflow: yn-translation-v1.\nTranslate both lines. Recover automatically if exactly one child fails.",
    workflowIntent: "translation",
    languagePair: "en->zh-CN",
    providerId: parent.provider.id,
    modelId: parent.getModel().id,
    subagentProviderId: "translation-test-lane",
    subagentModelId: firstHealthy.getModel().id,
    subagentCount: 2,
    translationSplitSize: 1,
    reviewSubagentCount: 1,
    sourcePath
  });

  await waitForSettled(1);
  await waitUntil(async () => {
    const state = await service.getRunState(workspaceDir, session.id);
    return state.subagentMessages.filter((message) => message.details?.status === "running").length === 2;
  }, "the first two child runtimes");

  releaseFirstBatch.resolve();
  await waitUntil(async () => {
    const state = await service.getRunState(workspaceDir, session.id);
    return state.subagentMessages.filter((message) => (
      message.customType === "subagent.translation" && message.details?.closed
    )).length === 2;
  }, "the failed assignment to enter an explicit-continuation pause");
  await waitForSettled(2);
  assert.equal((await service.getRunState(workspaceDir, session.id)).running, false,
    "the parent did not finish reporting the recovery pause");

  let messages = await service.loadMessages(workspaceDir, session.id);
  assert.equal(toolCalls(messages, "runTranslationSubagents").length, 1,
    "an exhausted assignment must not launch a hidden replacement batch");
  assert.equal(toolCalls(messages, "validateTranslationArtifact").length, 0);
  const firstState = await service.getRunState(workspaceDir, session.id);
  const firstTerminal = firstState.subagentMessages.filter((message) => (
    message.customType === "subagent.translation" && message.details?.closed
  ));
  assert.deepEqual(
    firstTerminal.map((message) => message.details.status).sort(),
    ["completed", "failed"],
    "the failed first batch did not retain the healthy child's completed terminal state"
  );

  await service.prompt({
    outputDir: workspaceDir,
    sessionId: session.id,
    prompt: "Continue the retained failed assignment now.",
    workflowIntent: "translation",
    languagePair: "en->zh-CN",
    providerId: parent.provider.id,
    modelId: parent.getModel().id,
    subagentProviderId: "translation-test-lane",
    subagentModelId: firstHealthy.getModel().id,
    subagentCount: 2,
    translationSplitSize: 1,
    reviewSubagentCount: 1,
    sourcePath
  });
  await waitUntil(async () => {
    const state = await service.getRunState(workspaceDir, session.id);
    return state.subagentMessages.filter((message) => (
      message.customType === "subagent.translation" && message.details?.status === "running"
    )).length === 1;
  }, "the single outstanding resumed child runtime");

  releaseRetryBatch.resolve();
  await waitUntil(async () => {
    const currentMessages = await service.loadMessages(workspaceDir, session.id);
    const currentState = await service.getRunState(workspaceDir, session.id);
    return toolCalls(currentMessages, "validateTranslationArtifact").length === 1
      && currentState.running === false;
  }, "the repaired batch to pass final validation and return the parent to idle");

  messages = await service.loadMessages(workspaceDir, session.id);
  assert.equal(toolCalls(messages, "runTranslationSubagents").length, 2);
  assert.equal(toolCalls(messages, "validateTranslationArtifact").length, 1);
  assert.ok(messages.some((message) => (
    message.role === "toolResult"
    && message.toolCallId === "validate-recovered-artifact"
    && message.isError === false
  )), JSON.stringify(messages.filter((message) => message.role === "toolResult"), null, 2));
  const failedNoticeIndex = messages.findIndex((message) => (
    message.role === "custom"
    && message.customType === "subagent-completion"
    && message.details?.status === "failed"
  ));
  const retryIndex = messages.findIndex((message) => (
    message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "toolCall" && block.id === "spawn-repair-batch")
  ));
  const completedNoticeIndex = messages.findIndex((message) => (
    message.role === "custom"
    && message.customType === "subagent-completion"
    && message.details?.status === "completed"
  ));
  const validationIndex = messages.findIndex((message) => (
    message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "toolCall" && block.id === "validate-recovered-artifact")
  ));
  assert.ok(failedNoticeIndex >= 0);
  assert.ok(retryIndex > failedNoticeIndex);
  assert.ok(completedNoticeIndex > retryIndex);
  assert.ok(validationIndex > completedNoticeIndex);
  assert.ok(messages.some((message) => (
    message.role === "assistant"
    && /failed child was recovered/.test(text(message))
  )));
  assert.equal(await readFile(path.join(workspaceDir, "AI_translation", "source_translated.txt"), "utf8"), "一\n二\n");

  const finalState = await service.getRunState(workspaceDir, session.id);
  assert.equal(finalState.running, false);
  assert.equal(finalState.phase, "idle");
  assert.equal(finalState.error, undefined);
} finally {
  releaseFirstBatch.resolve();
  firstFailureTriggered.resolve();
  releaseRetryBatch.resolve();
  unsubscribe();
  await service.disposeWorkspace(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("ok one failed child preserves its healthy sibling, reports the pause, and resumes only after explicit continuation");
