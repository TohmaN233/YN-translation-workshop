import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";

import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { PiSessionAgentRuntime } from "../../src/main/agent/piNative/sessionAgentRuntime.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

async function seedLongConversation(repository, sessionId, turns = 14) {
  const session = await repository.open(sessionId);
  for (let turn = 0; turn < turns; turn += 1) {
    await session.appendMessage(userMessage(`user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-compaction-"));
const faux = fauxProvider({
  provider: "faux-compaction",
  models: [{ id: "compact-model", reasoning: false, contextWindow: 64_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
faux.setResponses([
  fauxAssistantMessage(fauxText([
    "## Goal",
    "Continue the YN translation conversation after compacting older turns.",
    "## Constraints",
    "Preserve the recent translation context."
  ].join("\n")))
]);
const models = createModels();
models.setProvider(faux.provider);
const service = new PiNativeSessionService({
  createModelSelection: async () => ({
    models,
    model: faux.getModel(),
    providerId: faux.provider.id,
    modelId: faux.getModel().id
  })
});

try {
  const created = await service.createSession(workspaceDir);
  const repository = new PiSessionRepository(workspaceDir);
  await seedLongConversation(repository, created.id);
  const selected = await service.createSession(workspaceDir);
  await service.selectSession(workspaceDir, selected.id);

  const states = [];
  const unsubscribe = service.subscribeState((_workspace, state) => states.push(state));
  const result = await service.compact({
    outputDir: workspaceDir,
    sessionId: created.id,
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
    thinkingLevel: "off",
    customInstructions: "Retain translation decisions and unresolved questions."
  });
  unsubscribe();

  assert.equal(result.reason, "manual");
  assert.match(result.summary, /YN translation conversation/);
  assert.ok(result.tokensBefore > result.estimatedTokensAfter);
  assert.ok(states.some((state) => state.phase === "compaction" && state.compacting === true));
  assert.equal(states.at(-1)?.phase, "idle");
  assert.equal(states.at(-1)?.compacting, false);
  assert.equal(
    (await service.bootstrap(workspaceDir)).activeSessionId,
    selected.id,
    "compacting an inactive session must not take persisted selection ownership"
  );

  const reopened = await repository.open(created.id);
  const entries = await reopened.getEntries();
  const compactions = entries.filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1, "manual compression must persist one native Pi compaction entry");
  assert.equal(compactions[0].summary, result.summary);

  const context = await reopened.buildContext();
  assert.equal(context.messages[0]?.role, "compactionSummary");
  assert.equal(context.messages[0]?.summary, result.summary);
  assert.ok(context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("user-13")));

  const displayMessages = await service.loadMessages(workspaceDir, created.id);
  assert.equal(displayMessages[0]?.role, "user");
  assert.match(JSON.stringify(displayMessages[0]?.content), /conversation history.*compacted/i);

  console.log("ok native Pi manual compaction persists JSONL memory and rebuilds context");
} finally {
  await service.disposeWorkspace(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

const automaticWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-auto-compaction-"));
const automaticFaux = fauxProvider({
  provider: "faux-auto-compaction",
  models: [{ id: "auto-compact-model", reasoning: false, contextWindow: 48_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
automaticFaux.setResponses([
  fauxAssistantMessage(fauxText("## Goal\nPreserve prior translation decisions for the next turn.")),
  fauxAssistantMessage(fauxText("The new turn ran after native Pi compacted the older context."))
]);
const automaticModels = createModels();
automaticModels.setProvider(automaticFaux.provider);
const automaticService = new PiNativeSessionService({
  createModelSelection: async () => ({
    models: automaticModels,
    model: automaticFaux.getModel(),
    providerId: automaticFaux.provider.id,
    modelId: automaticFaux.getModel().id
  })
});

try {
  const created = await automaticService.createSession(automaticWorkspace);
  const repository = new PiSessionRepository(automaticWorkspace);
  await seedLongConversation(repository, created.id);
  const settled = new Promise((resolve) => {
    const unsubscribe = automaticService.subscribeEvents((entry) => {
      if (entry.event.type !== "settled") return;
      unsubscribe();
      resolve();
    });
  });
  const states = [];
  const unsubscribeState = automaticService.subscribeState((_workspace, state) => states.push(state));

  const acceptedAt = Date.now();
  const accepted = await automaticService.prompt({
    outputDir: automaticWorkspace,
    sessionId: created.id,
    prompt: "Continue with the next translation decision.",
    providerId: automaticFaux.provider.id,
    modelId: automaticFaux.getModel().id,
    thinkingLevel: "off"
  });
  assert.equal(accepted.accepted, true);
  assert.ok(Date.now() - acceptedAt < 250, "automatic compaction must not delay prompt acknowledgement");
  await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for post-compaction turn")), 5_000))
  ]);
  unsubscribeState();

  const reopened = await repository.open(created.id);
  assert.equal((await reopened.getEntries()).filter((entry) => entry.type === "compaction").length, 1);
  const runState = await automaticService.getRunState(automaticWorkspace, created.id);
  assert.equal(runState.lastCompaction?.reason, "threshold");
  assert.ok(runState.contextUsage?.tokens < runState.contextUsage?.contextWindow);
  assert.ok(states.some((state) => state.phase === "compaction" && state.compacting));
  assert.ok(states.length >= 4, "automatic compaction should publish each native lifecycle transition");
  for (let index = 1; index < states.length; index += 1) {
    assert.ok(
      states[index].sequence > states[index - 1].sequence,
      `native state sequence must increase strictly (${states[index - 1].sequence} -> ${states[index].sequence})`
    );
  }
  const messages = await automaticService.loadMessages(automaticWorkspace, created.id);
  assert.ok(messages.some((message) => (
    message.role === "assistant"
    && message.content.some((block) => block.type === "text" && block.text.includes("new turn ran"))
  )));

  console.log("ok native Pi threshold compaction runs before the next accepted turn");
} finally {
  await automaticService.disposeWorkspace(automaticWorkspace);
  await rm(automaticWorkspace, { recursive: true, force: true });
}

const childThresholdWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-threshold-compaction-"));
const childThresholdFaux = fauxProvider({
  provider: "faux-child-threshold-compaction",
  models: [{ id: "child-threshold-model", reasoning: false, contextWindow: 64_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
childThresholdFaux.setResponses([
  fauxAssistantMessage(fauxText("## Goal\nPreserve the child assignment context before accepting more work.")),
  fauxAssistantMessage(fauxText("The child assignment ran from the compacted Pi context."))
]);
const childThresholdModels = createModels();
childThresholdModels.setProvider(childThresholdFaux.provider);

try {
  const repository = new PiSessionRepository(childThresholdWorkspace);
  const session = await repository.create();
  const metadata = await session.getMetadata();
  for (let turn = 0; turn < 22; turn += 1) {
    await session.appendMessage(userMessage(`user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: metadata.id,
    models: childThresholdModels,
    model: childThresholdFaux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "Continue a persistent Pi child assignment without exceeding its context budget.",
    tools: []
  });

  await runtime.prompt("Continue this child assignment.");

  const entries = await session.getEntries();
  assert.equal(
    entries.filter((entry) => entry.type === "compaction").length,
    1,
    "every Pi runtime, including a child runtime, must threshold-compact before a new prompt"
  );
  assert.equal(childThresholdFaux.state.callCount, 2, "the first provider call must be native Pi compaction, then the child turn");
  assert.ok(entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "assistant"
    && entry.message.content.some((block) => block.type === "text" && block.text.includes("compacted Pi context"))
  )));
  runtime.dispose();

  console.log("ok child Pi runtime threshold-compacts before a new assignment prompt");
} finally {
  await rm(childThresholdWorkspace, { recursive: true, force: true });
}

const resetChildWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-reset-child-compaction-"));
const resetChildFaux = fauxProvider({
  provider: "faux-reset-child-compaction",
  models: [{ id: "reset-child-model", reasoning: false, contextWindow: 64_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
resetChildFaux.setResponses([
  fauxAssistantMessage(fauxText("The fresh child assignment did not inherit discarded assignment history."))
]);
const resetChildModels = createModels();
resetChildModels.setProvider(resetChildFaux.provider);

try {
  const repository = new PiSessionRepository(resetChildWorkspace);
  const session = await repository.create();
  const metadata = await session.getMetadata();
  for (let turn = 0; turn < 22; turn += 1) {
    await session.appendMessage(userMessage(`discarded-user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`discarded-assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: metadata.id,
    models: resetChildModels,
    model: resetChildFaux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "Start each persistent worker assignment from a fresh active context.",
    tools: []
  });
  await runtime.initialize();
  runtime.resetContext();

  await runtime.prompt("Run the next independent child assignment.");

  const entries = await session.getEntries();
  assert.equal(
    entries.filter((entry) => entry.type === "compaction").length,
    0,
    "a reset child must not compact persisted history that is absent from its active model context"
  );
  assert.equal(
    resetChildFaux.state.callCount,
    1,
    "the fresh assignment must be the only provider call after an explicit context reset"
  );
  runtime.dispose();

  console.log("ok reset child ignores discarded JSONL history during threshold checks");
} finally {
  await rm(resetChildWorkspace, { recursive: true, force: true });
}

const resetChildActiveWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-reset-child-active-compaction-"));
const resetChildActiveFaux = fauxProvider({
  provider: "faux-reset-child-active-compaction",
  models: [{ id: "reset-child-active-model", reasoning: false, contextWindow: 24_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
resetChildActiveFaux.setResponses([
  fauxAssistantMessage(fauxText("The first fresh child turn is complete.")),
  fauxAssistantMessage(fauxText(`The second fresh child turn reached its active-context threshold. ${"a".repeat(40_000)}`)),
  fauxAssistantMessage(fauxText("## Goal\nKeep only the current post-reset child assignment."))
]);
const resetChildActiveModels = createModels();
resetChildActiveModels.setProvider(resetChildActiveFaux.provider);

try {
  const repository = new PiSessionRepository(resetChildActiveWorkspace);
  const session = await repository.create();
  const metadata = await session.getMetadata();
  for (let turn = 0; turn < 22; turn += 1) {
    await session.appendMessage(userMessage(`discarded-user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`discarded-assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
  const discardedEntryIds = new Set((await session.getEntries()).map((entry) => entry.id));
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: metadata.id,
    models: resetChildActiveModels,
    model: resetChildActiveFaux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "Compact only the current persistent-worker assignment.",
    tools: []
  });
  await runtime.initialize();
  runtime.resetContext();

  await runtime.prompt("Run fresh child turn one.");
  await runtime.prompt("Run fresh child turn two.");

  const activeEntries = await session.getEntries();
  const compaction = activeEntries.find((entry) => entry.type === "compaction");
  assert.ok(compaction, "an oversized active post-reset assignment must still receive native Pi compaction");
  assert.equal(
    discardedEntryIds.has(compaction.firstKeptEntryId),
    false,
    "post-reset compaction must keep an entry from the active assignment rather than discarded history"
  );
  assert.ok(
    compaction.tokensBefore < 20_000,
    `post-reset compaction must exclude discarded history, received ${compaction.tokensBefore} estimated tokens`
  );
  runtime.dispose();

  console.log("ok reset child compacts only its active post-reset assignment branch");
} finally {
  await rm(resetChildActiveWorkspace, { recursive: true, force: true });
}

const deferredParentWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-deferred-parent-compaction-"));
const deferredParentFaux = fauxProvider({
  provider: "faux-deferred-parent-compaction",
  models: [{ id: "deferred-parent-model", reasoning: false, contextWindow: 64_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
deferredParentFaux.setResponses([
  fauxAssistantMessage(fauxText("The parent remains interactive while its child is running.")),
  fauxAssistantMessage(fauxText("## Goal\nCompact the parent after its active child settles.")),
  fauxAssistantMessage(fauxText("The parent continued from its compacted context."))
]);
const deferredParentModels = createModels();
deferredParentModels.setProvider(deferredParentFaux.provider);

try {
  const repository = new PiSessionRepository(deferredParentWorkspace);
  const session = await repository.create();
  const metadata = await session.getMetadata();
  for (let turn = 0; turn < 22; turn += 1) {
    await session.appendMessage(userMessage(`user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
  let childRunning = true;
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: metadata.id,
    models: deferredParentModels,
    model: deferredParentFaux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "Keep the parent responsive while child work remains active.",
    tools: [],
    deferThresholdCompaction: () => childRunning
  });

  await runtime.prompt("Report the live child state.");
  assert.equal(
    (await session.getEntries()).filter((entry) => entry.type === "compaction").length,
    0,
    "parent threshold compaction must be deferred while a child runtime is active"
  );

  childRunning = false;
  await runtime.prompt("Continue after the child settles.");
  assert.equal(
    (await session.getEntries()).filter((entry) => entry.type === "compaction").length,
    1,
    "deferred parent threshold compaction must run on the next prompt after children settle"
  );
  assert.equal(deferredParentFaux.state.callCount, 3);
  runtime.dispose();

  console.log("ok parent Pi threshold compaction defers only while child runtimes are active");
} finally {
  await rm(deferredParentWorkspace, { recursive: true, force: true });
}

const overflowWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-overflow-compaction-"));
const overflowFaux = fauxProvider({
  provider: "faux-overflow-compaction",
  models: [{ id: "overflow-compact-model", reasoning: false, contextWindow: 48_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
overflowFaux.setResponses([
  fauxAssistantMessage([], {
    stopReason: "error",
    errorMessage: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again."
  }),
  fauxAssistantMessage(fauxText("## Goal\nRecover the interrupted translation turn after compacting context.")),
  fauxAssistantMessage(fauxText("The interrupted turn resumed automatically after native Pi overflow compaction."))
]);
const overflowModels = createModels();
overflowModels.setProvider(overflowFaux.provider);
const overflowService = new PiNativeSessionService({
  createModelSelection: async () => ({
    models: overflowModels,
    model: overflowFaux.getModel(),
    providerId: overflowFaux.provider.id,
    modelId: overflowFaux.getModel().id
  })
});

try {
  const created = await overflowService.createSession(overflowWorkspace);
  const repository = new PiSessionRepository(overflowWorkspace);
  await seedLongConversation(repository, created.id, 8);
  const states = [];
  const unsubscribeState = overflowService.subscribeState((_workspace, state) => states.push(state));
  const settled = new Promise((resolve) => {
    const unsubscribe = overflowService.subscribeEvents((entry) => {
      if (entry.event.type !== "settled") return;
      unsubscribe();
      resolve();
    });
  });

  await overflowService.prompt({
    outputDir: overflowWorkspace,
    sessionId: created.id,
    prompt: "Continue the interrupted translation turn.",
    providerId: overflowFaux.provider.id,
    modelId: overflowFaux.getModel().id,
    thinkingLevel: "off"
  });
  await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for overflow recovery")), 5_000))
  ]);
  unsubscribeState();

  const reopened = await repository.open(created.id);
  assert.equal(
    (await reopened.getEntries()).filter((entry) => entry.type === "compaction").length,
    1,
    "context overflow must persist one native Pi compaction entry in the same run"
  );
  const runState = await overflowService.getRunState(overflowWorkspace, created.id);
  assert.equal(runState.error, undefined, "a recovered overflow must not remain as the terminal session error");
  assert.equal(runState.lastCompaction?.reason, "overflow");
  assert.ok(states.some((state) => state.phase === "compaction" && state.compacting));
  const messages = await overflowService.loadMessages(overflowWorkspace, created.id);
  assert.ok(messages.some((message) => (
    message.role === "assistant"
    && message.content.some((block) => block.type === "text" && block.text.includes("resumed automatically"))
  )));

  console.log("ok native Pi context overflow compacts and resumes inside the same turn");
} finally {
  await overflowService.disposeWorkspace(overflowWorkspace);
  await rm(overflowWorkspace, { recursive: true, force: true });
}

const successfulOverflowWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-successful-overflow-compaction-"));
const successfulOverflowFaux = fauxProvider({
  provider: "faux-successful-overflow-compaction",
  models: [{ id: "successful-overflow-model", reasoning: false, contextWindow: 24_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
successfulOverflowFaux.setResponses([
  {
    ...fauxAssistantMessage(fauxText("The requested translation answer completed before automatic compaction.")),
    usage: {
      input: 25_000,
      output: 32,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25_032,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  },
  fauxAssistantMessage(fauxText("## Goal\nPreserve the completed answer while compacting an oversized successful turn."))
]);
const successfulOverflowModels = createModels();
successfulOverflowModels.setProvider(successfulOverflowFaux.provider);

try {
  const repository = new PiSessionRepository(successfulOverflowWorkspace);
  const session = await repository.create();
  const metadata = await session.getMetadata();
  for (let turn = 0; turn < 2; turn += 1) {
    await session.appendMessage(userMessage(`user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: metadata.id,
    models: successfulOverflowModels,
    model: successfulOverflowFaux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "Complete the request, then preserve the result.",
    tools: []
  });

  await runtime.prompt("Return the completed translation answer.");

  const entries = await session.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(successfulOverflowFaux.state.callCount, 2, "a successful overflow compacts but must not call Agent.continue()");
  assert.ok(entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "assistant"
    && entry.message.content.some((block) => block.type === "text" && block.text.includes("completed before automatic compaction"))
  )), "the successful assistant answer must remain persisted");
  runtime.dispose();

  console.log("ok successful oversized Pi response compacts without retrying from an assistant tail");
} finally {
  await rm(successfulOverflowWorkspace, { recursive: true, force: true });
}

const lengthOverflowWorkspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-length-overflow-compaction-"));
const lengthOverflowFaux = fauxProvider({
  provider: "faux-length-overflow-compaction",
  models: [{ id: "length-overflow-model", reasoning: false, contextWindow: 48_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
lengthOverflowFaux.setResponses([
  {
    ...fauxAssistantMessage([], {
      stopReason: "length",
      errorMessage: "maximum context length exceeded"
    }),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  },
  fauxAssistantMessage(fauxText("## Goal\nRecover a zero-output length overflow in the same Pi turn.")),
  fauxAssistantMessage(fauxText("The length-overflow turn resumed after native Pi compaction."))
]);
const lengthOverflowModels = createModels();
lengthOverflowModels.setProvider(lengthOverflowFaux.provider);

try {
  const repository = new PiSessionRepository(lengthOverflowWorkspace);
  const session = await repository.create();
  const metadata = await session.getMetadata();
  for (let turn = 0; turn < 4; turn += 1) {
    await session.appendMessage(userMessage(`user-${turn}: ${"u".repeat(5_000)}`));
    await session.appendMessage(fauxAssistantMessage(fauxText(`assistant-${turn}: ${"a".repeat(5_000)}`)));
  }
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: metadata.id,
    models: lengthOverflowModels,
    model: lengthOverflowFaux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "Recover context overflow with native Pi compaction.",
    tools: []
  });
  await runtime.prompt(`Continue after a zero-output length overflow. ${"p".repeat(160_000)}`);

  const entries = await session.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
  assert.ok(
    lengthOverflowFaux.state.callCount >= 3 && lengthOverflowFaux.state.callCount <= 4,
    "length overflow must compact and retry exactly once; an oversized recovered turn may trigger one final threshold check"
  );
  assert.ok(entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "assistant"
    && entry.message.content.some((block) => block.type === "text" && block.text.includes("length-overflow turn resumed"))
  )));
  runtime.dispose();

  console.log("ok native Pi zero-output length overflow removes the assistant tail before retry");
} finally {
  await rm(lengthOverflowWorkspace, { recursive: true, force: true });
}
