import { readSessionConversation, readSessionEntries } from "../helpers/pi-session.mjs";
import { strict as assert } from "node:assert";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/node";

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
const session = await new MemorySessionRepo().create({ id: "pi_agent_runtime" });
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

  const messages = (await readSessionConversation(session)).messages;
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

const concurrentSession = await new MemorySessionRepo().create({ id: "pi_agent_runtime_concurrent_writes" });
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
  const persisted = (await readSessionConversation(concurrentSession)).messages;
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
const activeSession = await new MemorySessionRepo().create({ id: "pi_agent_runtime_active_write" });
const activeRuntime = new PiSessionAgentRuntime({
  session: activeSession,
  sessionId: "pi_agent_runtime_active_write",
  models: slowModels,
  model: slowProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Persist Host status in the native session operation queue.",
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
  assert.equal(externalPersisted, true, "Host status must not wait for its own active tool turn to end");
  releaseProvider.resolve();
  await Promise.all([parentTurn, externalWrite]);
  assert.deepEqual(
    (await readSessionConversation(activeSession)).messages.map((message) => message.role),
    ["user", "custom", "assistant"],
    "parent messages and terminal child transcript did not share one linear Pi branch"
  );
} finally {
  releaseProvider.resolve();
  activeRuntime.dispose();
}

console.log("ok Host child status persists during the active Pi turn and remains on one native branch");

const terminalPollEntered = deferred();
const releaseTerminalPoll = deferred();
const terminalProvider = fauxProvider({ provider: "terminal-steer-provider", tokensPerSecond: 1000 });
terminalProvider.setResponses([
  fauxAssistantMessage(fauxText("initial child reply")),
  fauxAssistantMessage(fauxText("late guidance consumed"))
]);
const terminalModels = createModels();
terminalModels.setProvider(terminalProvider.provider);
const terminalSession = await new MemorySessionRepo().create({ id: "pi_agent_runtime_terminal_steer" });
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
  const persisted = (await readSessionConversation(terminalSession)).messages;
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
const terminalFollowUpSession = await new MemorySessionRepo().create({ id: "pi_agent_runtime_terminal_follow_up" });
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
    (await readSessionConversation(terminalFollowUpSession)).messages.map((message) => message.role),
    ["user", "assistant", "custom", "assistant"],
    "terminal child completion was accepted without being consumed and persisted"
  );
} finally {
  releaseTerminalFollowUp.resolve();
  unsubscribeTerminalFollowUp();
  terminalFollowUpRuntime.dispose();
}

console.log("ok terminal-boundary child completion is consumed through a native Pi Follow-up continuation");

{
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("Accepted carryover reached the next native prompt."))]);
  const models = createModels(); models.setProvider(faux.provider);
  const session = await new MemorySessionRepo().create({ id: "pi_stop_queue_preflight" });
  const runtime = new PiSessionAgentRuntime({ session, sessionId: "pi_stop_queue_preflight", models,
    model: faux.getModel(), thinkingLevel: "medium", systemPrompt: "Preserve accepted native queue inputs.", tools: [] });
  const entered = deferred(); const release = deferred(); let hold = true;
  await runtime.nextTurn("accepted before Stop");
  runtime.subscribe(async event => {
    if (event.type !== "queue_update" || event.nextTurn.length !== 0 || !hold) return;
    hold = false; entered.resolve(); await release.promise;
  });
  try {
    const turn = runtime.prompt("cancel before Agent.prompt");
    const rejection = assert.rejects(turn, error => error.name === "AbortError");
    await entered.promise;
    await runtime.abort();
    assert.equal(faux.state.callCount, 0, "Stop before native Agent acquisition must prevent the provider call");
    release.resolve(); await rejection;
    await runtime.prompt("continue after Stop");
    const messages = (await readSessionConversation(session)).messages;
    assert.equal(messages.filter(message => JSON.stringify(message).includes("accepted before Stop")).length, 1);
    assert.equal(messages.some(message => JSON.stringify(message).includes("cancel before Agent.prompt")), false);
  } finally { release.resolve(); runtime.dispose(); }
}
console.log("ok Stop at native queue-update preflight preserves accepted next-turn input without starting the cancelled prompt");

for (const boundary of ["threshold-read", "compaction-entry-read", "compaction-start-listener", "compaction-commit-queue"]) {
  const faux = fauxProvider({ tokensPerSecond: 1_000_000, tokenSize: { min: 100000, max: 100000 } });
  faux.setResponses([fauxAssistantMessage(fauxText("Summary of the completed conversation."))]);
  const models = createModels(); models.setProvider(faux.provider);
  const session = await new MemorySessionRepo().create({ id: `pi_compaction_stop_${boundary}` });
  const runtime = new PiSessionAgentRuntime({ session, sessionId: session.id, models,
    model: { ...faux.getModel(), contextWindow: 40000 }, thinkingLevel: "medium", systemPrompt: "Native compaction cancellation.", tools: [] });
  for (let index = 0; index < 3; index++) {
    await runtime.appendMessage({ role: "user", content: [{ type: "text", text: "long history ".repeat(20000) }], timestamp: index * 2 });
    await runtime.appendMessage(fauxAssistantMessage(fauxText(`historical answer ${index}`)));
  }
  await runtime.initialize(); await runtime.synchronizeSystemPrompt();
  const entered = deferred(); const release = deferred();
  const originalBranch = session.branch.bind(session); let reads = 0;
  if (boundary.endsWith("read")) session.branch = async (...args) => {
    reads++;
    if (reads === (boundary === "threshold-read" ? 1 : 2)) { entered.resolve(); await release.promise; }
    return originalBranch(...args);
  };
  if (boundary === "compaction-start-listener") runtime.subscribe(async event => {
    if (event.type === "compaction_start") { entered.resolve(); await release.promise; }
  });
  if (boundary === "compaction-commit-queue") {
    const originalOperation = runtime.runSessionOperation.bind(runtime); let operations = 0;
    runtime.runSessionOperation = operation => {
      operations++;
      if (operations === 2) { runtime.sessionOperationTail = release.promise; entered.resolve(); }
      return originalOperation(operation);
    };
  }
  try {
    const turn = boundary === "compaction-commit-queue" ? runtime.compact() : runtime.prompt("Cancelled preflight must not compact");
    const rejected = assert.rejects(turn, error => error.name === "AbortError");
    await entered.promise; await runtime.abort(); release.resolve(); await rejected;
    assert.equal(faux.state.callCount, boundary === "compaction-commit-queue" ? 1 : 0, `Stop at ${boundary} must prevent orphan provider acquisition`);
    assert.equal((await readSessionEntries(session)).filter(entry => entry.type === "compaction").length, 0, `Stop at ${boundary} must prevent a revoked compaction commit`);
  } finally { release.resolve(); runtime.dispose(); }
  console.log(`ok Stop at ${boundary} prevents orphan native compaction acquisition/commit`);
}
