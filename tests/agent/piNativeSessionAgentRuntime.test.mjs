import { strict as assert } from "node:assert";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core/node";

const { PiSessionAgentRuntime } = await import("../../src/main/agent/piNative/sessionAgentRuntime.ts");

const provider = fauxProvider({ tokensPerSecond: 1000 });
let completionSeenByModel = false;
provider.setResponses([
  fauxAssistantMessage(fauxText("Parent acknowledged the user.")),
  async (context) => {
    completionSeenByModel = context.messages.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "text" && block.text.includes("Both child runtimes completed"))
    ));
    return fauxAssistantMessage(fauxText("Children finished; I will merge and validate now."));
  }
]);
const models = createModels();
models.setProvider(provider.provider);
const session = await new InMemorySessionRepo().create({ id: "pi_agent_runtime" });
const runtime = new PiSessionAgentRuntime({
  session,
  sessionId: "pi_agent_runtime",
  models,
  model: provider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Use the native Pi Agent message contract.",
  tools: []
});
const eventTypes = [];
const unsubscribe = runtime.subscribe((event) => eventTypes.push(event.type));
try {
  await runtime.prompt("Start two children.");
  await runtime.prompt({
    role: "custom",
    customType: "subagent-completion",
    content: "Both child runtimes completed successfully.",
    display: false,
    details: { batchId: "batch_1", triggerTurn: true },
    timestamp: Date.now()
  });

  const messages = (await session.buildContext()).messages;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "custom", "assistant"]);
  assert.equal(messages[2].display, false);
  assert.equal(completionSeenByModel, true, "native Pi custom completion message was dropped before the provider request");
  assert.equal(
    messages.some((message) => message.role === "user" && (
      typeof message.content === "string"
        ? message.content.length === 0
        : message.content.every((block) => block.type !== "text" || block.text.length === 0)
    )),
    false,
    "custom wake-up must not persist a fake empty user message"
  );
  assert.ok(eventTypes.includes("message_update"));
  assert.equal(eventTypes.filter((type) => type === "settled").length, 2);
} finally {
  unsubscribe();
  runtime.dispose();
}

console.log("ok Pi session runtime starts an idle parent turn from a native custom message without a fake user message");

const concurrentSession = await new InMemorySessionRepo().create({ id: "pi_agent_runtime_concurrent_writes" });
const concurrentRuntime = new PiSessionAgentRuntime({
  session: concurrentSession,
  sessionId: "pi_agent_runtime_concurrent_writes",
  models,
  model: provider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Serialize every native Pi session mutation.",
  tools: []
});
try {
  await Promise.all([
    concurrentRuntime.appendMessage({
      role: "custom",
      customType: "subagent.translation",
      content: "first terminal child card",
      display: true,
      timestamp: 1
    }),
    concurrentRuntime.appendMessage({
      role: "custom",
      customType: "subagent.translation",
      content: "second terminal child card",
      display: true,
      timestamp: 2
    })
  ]);
  const persisted = (await concurrentSession.buildContext()).messages;
  assert.deepEqual(
    persisted.map((message) => typeof message.content === "string" ? message.content : ""),
    ["first terminal child card", "second terminal child card"],
    "concurrent external Pi messages forked the JSONL branch and one became unreachable"
  );
} finally {
  concurrentRuntime.dispose();
}

console.log("ok Pi session runtime serializes concurrent external session writes into one reachable branch");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const providerEntered = deferred();
const releaseProvider = deferred();
const slowProvider = fauxProvider({ provider: "serialized-session-provider", tokensPerSecond: 1000 });
slowProvider.setResponses([
  async () => {
    providerEntered.resolve();
    await releaseProvider.promise;
    return fauxAssistantMessage(fauxText("parent turn completed"));
  }
]);
const slowModels = createModels();
slowModels.setProvider(slowProvider.provider);
const activeSession = await new InMemorySessionRepo().create({ id: "pi_agent_runtime_active_write" });
const activeRuntime = new PiSessionAgentRuntime({
  session: activeSession,
  sessionId: "pi_agent_runtime_active_write",
  models: slowModels,
  model: slowProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Queue external session messages until the native Pi turn boundary.",
  tools: []
});
try {
  const parentTurn = activeRuntime.prompt("run the parent turn");
  await providerEntered.promise;
  let externalPersisted = false;
  const externalWrite = activeRuntime.appendMessage({
    role: "custom",
    customType: "subagent.translation",
    content: "terminal child transcript",
    display: true,
    timestamp: 3
  }).then(() => { externalPersisted = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(externalPersisted, false, "external message bypassed the active Pi turn write queue");
  releaseProvider.resolve();
  await Promise.all([parentTurn, externalWrite]);
  assert.deepEqual(
    (await activeSession.buildContext()).messages.map((message) => message.role),
    ["user", "assistant", "custom"],
    "parent messages and terminal child transcript did not share one linear Pi branch"
  );
} finally {
  releaseProvider.resolve();
  activeRuntime.dispose();
}

console.log("ok external child messages wait for the active Pi turn boundary and remain reachable");

const terminalPollEntered = deferred();
const releaseTerminalPoll = deferred();
const terminalProvider = fauxProvider({ provider: "terminal-steer-provider", tokensPerSecond: 1000 });
terminalProvider.setResponses([
  fauxAssistantMessage(fauxText("initial child reply")),
  fauxAssistantMessage(fauxText("late guidance consumed"))
]);
const terminalModels = createModels();
terminalModels.setProvider(terminalProvider.provider);
const terminalSession = await new InMemorySessionRepo().create({ id: "pi_agent_runtime_terminal_steer" });
const terminalRuntime = new PiSessionAgentRuntime({
  session: terminalSession,
  sessionId: "pi_agent_runtime_terminal_steer",
  models: terminalModels,
  model: terminalProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Consume supervised child Steer through Pi's native queue.",
  tools: []
});
let holdFirstAgentEnd = true;
const unsubscribeTerminal = terminalRuntime.subscribe(async (event) => {
  if (event.type !== "agent_end" || !holdFirstAgentEnd) return;
  holdFirstAgentEnd = false;
  terminalPollEntered.resolve();
  await releaseTerminalPoll.promise;
});
try {
  const turn = terminalRuntime.prompt("initial child task");
  await terminalPollEntered.promise;
  const steering = terminalRuntime.steerAndWaitForConsumption("late terminal guidance");
  releaseTerminalPoll.resolve();
  await Promise.all([turn, steering]);
  const persisted = (await terminalSession.buildContext()).messages;
  assert.deepEqual(
    persisted.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
    "Steer queued after Pi's final poll was accepted but never consumed"
  );
  assert.equal(
    persisted.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "text" && block.text === "late terminal guidance")
    )),
    true
  );
} finally {
  releaseTerminalPoll.resolve();
  unsubscribeTerminal();
  terminalRuntime.dispose();
}

console.log("ok supervised terminal-boundary Steer is consumed through a native Pi continuation");

const terminalFollowUpEntered = deferred();
const releaseTerminalFollowUp = deferred();
let completionReachedProvider = false;
const terminalFollowUpProvider = fauxProvider({ provider: "terminal-follow-up-provider", tokensPerSecond: 1000 });
terminalFollowUpProvider.setResponses([
  fauxAssistantMessage(fauxText("parent reached its final queue poll")),
  async (context) => {
    completionReachedProvider = context.messages.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "text" && block.text.includes("failed sibling batch"))
    ));
    return fauxAssistantMessage(fauxText("parent consumed child completion"));
  }
]);
const terminalFollowUpModels = createModels();
terminalFollowUpModels.setProvider(terminalFollowUpProvider.provider);
const terminalFollowUpSession = await new InMemorySessionRepo().create({ id: "pi_agent_runtime_terminal_follow_up" });
const terminalFollowUpRuntime = new PiSessionAgentRuntime({
  session: terminalFollowUpSession,
  sessionId: "pi_agent_runtime_terminal_follow_up",
  models: terminalFollowUpModels,
  model: terminalFollowUpProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Consume child completion through Pi's native Follow-up queue.",
  tools: []
});
let holdFollowUpAgentEnd = true;
const unsubscribeTerminalFollowUp = terminalFollowUpRuntime.subscribe(async (event) => {
  if (event.type !== "agent_end" || !holdFollowUpAgentEnd) return;
  holdFollowUpAgentEnd = false;
  terminalFollowUpEntered.resolve();
  await releaseTerminalFollowUp.promise;
});
try {
  const turn = terminalFollowUpRuntime.prompt("run the parent until its final queue poll");
  await terminalFollowUpEntered.promise;
  const completion = terminalFollowUpRuntime.followUpMessageAndWaitForConsumption({
    role: "custom",
    customType: "subagent-completion",
    content: "failed sibling batch settled; repair it now",
    display: false,
    timestamp: Date.now()
  });
  releaseTerminalFollowUp.resolve();
  await Promise.all([turn, completion]);
  assert.equal(completionReachedProvider, true, "child completion queued at Pi's final poll never reached the parent provider");
  assert.deepEqual(
    (await terminalFollowUpSession.buildContext()).messages.map((message) => message.role),
    ["user", "assistant", "custom", "assistant"],
    "terminal child completion was accepted without being consumed and persisted"
  );
} finally {
  releaseTerminalFollowUp.resolve();
  unsubscribeTerminalFollowUp();
  terminalFollowUpRuntime.dispose();
}

console.log("ok terminal-boundary child completion is consumed through a native Pi Follow-up continuation");
