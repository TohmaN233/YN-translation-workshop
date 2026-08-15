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
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return typeof message?.content === "string" ? message.content : "";
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-parent-child-interaction-"));
const sourcePath = path.join(workspaceDir, "source.txt");
await writeFile(sourcePath, "one\ntwo", "utf8");
const releaseChildren = deferred();
const models = createModels();
const providers = new Map();

const parent = fauxProvider({ provider: "parent", tokensPerSecond: 1000 });
models.setProvider(parent.provider);
providers.set(parent.provider.id, parent);
parent.setResponses([
  fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {
    tasks: [
      { fromLine: 1, toLine: 1, providerId: "child-a", label: "shard-1" },
      { fromLine: 2, toLine: 2, providerId: "child-b", label: "shard-2" }
    ]
  }, { id: "spawn-children" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Children started in the background; I remain available.")),
  fauxAssistantMessage(fauxText("Both children are still running, and I can answer you now.")),
  fauxAssistantMessage(fauxText("The completion notification arrived; I am resuming merge and validation."))
]);

const reviewer = fauxProvider({ provider: "review", tokensPerSecond: 1000 });
models.setProvider(reviewer.provider);
providers.set(reviewer.provider.id, reviewer);
reviewer.setResponses([1, 2].flatMap((index) => [
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, {
    id: `review-${index}-read`
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, {
    id: `review-${index}-submit`
  }), { stopReason: "toolUse" })
]));

for (const [index, providerId] of ["child-a", "child-b"].entries()) {
  const child = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(child.provider);
  providers.set(providerId, child);
  child.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `${providerId}-read` }), { stopReason: "toolUse" }),
    async () => {
      await releaseChildren.promise;
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: index + 1, translation: index === 0 ? "一" : "二" }]
      }, { id: `${providerId}-write` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: `${providerId}-validate` }), { stopReason: "toolUse" })
  ]);
}

const service = new PiNativeSessionService({
  createModelSelection: async ({ providerId }) => {
    const provider = providers.get(providerId || "parent");
    assert.ok(provider, `unknown test provider ${providerId}`);
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  },
  createTools: createYnDomainTools,
  buildSystemPrompt: () => "Use YN native tools and remain responsive while child runtimes run.",
  enforceDomainCompletion: false
});
let settledCount = 0;
const settledWaiters = [];
const stateUpdates = [];
const unsubscribe = service.subscribeEvents((entry) => {
  if (entry.event.type !== "settled") return;
  settledCount += 1;
  for (const waiter of [...settledWaiters]) {
    if (settledCount >= waiter.count) waiter.resolve();
  }
});
const unsubscribeState = service.subscribeState((_workspaceDir, state, selectionChange) => {
  stateUpdates.push({ sessionId: state.sessionId, selectionChange });
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
const waitUntil = async (predicate, label) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

try {
  const session = await service.createSession(workspaceDir);
  await service.prompt({
    outputDir: workspaceDir,
    sessionId: session.id,
    prompt: "Translate both lines with two child runtimes.",
    providerId: "parent",
    modelId: parent.getModel().id,
    languagePair: "en->zh-CN",
    subagentProviderId: "review",
    subagentModelId: reviewer.getModel().id,
    reviewSubagentCount: 1,
    sourcePath
  });
  await waitForSettled(1);
  await waitUntil(async () => (
    (await service.loadMessages(workspaceDir, session.id))
      .filter((message) => message.role === "custom" && message.details?.status === "running").length === 2
  ), "two running child cards");
  await waitUntil(async () => {
    const children = await new PiSessionRepository(workspaceDir).listChildMetadata();
    if (children.length !== 2) return false;
    const transcripts = await Promise.all(children.map(async (child) => (
      await (await new PiSessionRepository(workspaceDir).openChild(child.id)).buildContext()
    ).messages));
    return transcripts.every((transcript) => transcript.some((message) => message.role === "toolResult"));
  }, "two live child Pi JSONL tool results");
  let messages = await service.loadMessages(workspaceDir, session.id);
  assert.equal(messages.filter((message) => message.role === "custom" && message.details?.status === "running").length, 2);
  const rawContext = await (await new PiSessionRepository(workspaceDir).open(session.id)).buildContext();
  assert.equal(
    rawContext.messages.filter((message) => message.role === "custom" && message.details?.subagentId).length,
    2,
    "live child progress snapshots must remain transient instead of growing the parent Pi JSONL context"
  );
  for (const card of rawContext.messages.filter((message) => message.role === "custom" && message.details?.subagentId)) {
    assert.equal(Object.hasOwn(card.details, "transcript"), false);
    assert.ok(JSON.stringify(card).length < 4096, "persisted parent card exceeded the lightweight card budget");
  }

  await service.prompt({
    outputDir: workspaceDir,
    sessionId: session.id,
    prompt: "Can you answer while the children are running?",
    providerId: "parent",
    modelId: parent.getModel().id,
    languagePair: "en->zh-CN",
    subagentProviderId: "review",
    subagentModelId: reviewer.getModel().id,
    reviewSubagentCount: 1,
    sourcePath
  });
  await waitForSettled(2);
  messages = await service.loadMessages(workspaceDir, session.id);
  assert.ok(messages.some((message) => message.role === "assistant" && /I can answer you now/.test(messageText(message))));

  const selectedOtherSession = await service.createSession(workspaceDir);
  const selectedOtherAt = stateUpdates.length;
  releaseChildren.resolve();
  try {
    await waitUntil(async () => {
      const current = await service.loadMessages(workspaceDir, session.id);
      const terminalCount = current.filter((message) => (
        message.role === "custom"
        && message.customType === "subagent.translation"
        && message.details?.status === "completed"
      )).length;
      return terminalCount === 2 && current.some((message) => (
        message.role === "assistant"
        && /completion notification arrived/.test(messageText(message))
      ));
    }, "both reviewed child cards and the resumed parent completion turn");
  } catch (error) {
    const current = await service.loadMessages(workspaceDir, session.id);
    const runState = await service.getRunState(workspaceDir, session.id);
    const trace = current.map((message) => ({
      role: message.role,
      customType: message.customType,
      status: message.details?.status,
      text: messageText(message),
      tools: Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
        : []
    }));
    throw new Error(`${error.message}\nRun state: ${JSON.stringify(runState, null, 2)}\n${JSON.stringify(trace, null, 2)}`);
  }
  messages = await service.loadMessages(workspaceDir, session.id);
  const terminalChildCards = messages.filter((message) => (
    message.role === "custom"
    && message.customType === "subagent.translation"
    && message.details?.status === "completed"
  ));
  assert.equal(terminalChildCards.length, 2, "parent Pi JSONL reload must retain both terminal child cards");
  for (const card of terminalChildCards) {
    assert.equal(Object.hasOwn(card.details, "transcript"), false);
    const transcript = await service.loadSubagentMessages(workspaceDir, session.id, card.details.subagentId);
    assert.ok(
      transcript.some((message) => message.role === "toolResult"),
      "terminal child JSONL lost paired tool results"
    );
    assert.ok(
      transcript.some((message) => (
        message.role === "assistant"
        && Array.isArray(message.content)
        && message.content.some((block) => block.type === "toolCall")
      )),
      "terminal child Reply collapsed to summary text instead of retaining tool calls"
    );
    assert.equal(Object.hasOwn(card.details, "reply"), false);
    assert.equal(
      transcript.at(-1)?.toolName,
      "validateAssignedTranslation",
      "terminal child validation must not trigger a redundant full-context confirmation request"
    );
  }
  const completionMessage = messages.find((message) => (
    message.role === "custom"
    && message.customType === "subagent-completion"
    && message.display === false
  ));
  assert.ok(completionMessage);
  assert.match(messageText(completionMessage), /background wait is over/i);
  assert.match(messageText(completionMessage), /do not keep waiting or repeat/i);
  assert.ok(messages.some((message) => message.role === "assistant" && /completion notification arrived/.test(messageText(message))));
  assert.equal(messages.some((message) => message.role === "user" && messageText(message) === ""), false);
  assert.equal(await readFile(path.join(workspaceDir, "AI_translation", "source_translated.txt"), "utf8"), "一\n二\n");
  assert.equal((await service.bootstrap(workspaceDir)).activeSessionId, selectedOtherSession.id);
  const inactiveCompletionStates = stateUpdates
    .slice(selectedOtherAt)
    .filter((update) => update.sessionId === session.id);
  assert.ok(inactiveCompletionStates.length > 0, "the old parent never emitted its background completion state");
  assert.ok(
    inactiveCompletionStates.every((update) => update.selectionChange === false),
    "an inactive background parent advertised its runtime completion as an explicit selection change"
  );
} finally {
  releaseChildren.resolve();
  unsubscribe();
  unsubscribeState();
  await service.disposeWorkspace(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("ok parent Pi Agent remains interactive during child runs and auto-resumes from a hidden completion message");
