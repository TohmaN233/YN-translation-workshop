import { strict as assert } from "node:assert";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core/node";

import { compactSubagentCards } from "../../src/main/agent/piNative/sessionService.ts";
import { PiSessionAgentRuntime } from "../../src/main/agent/piNative/sessionAgentRuntime.ts";

const hugeTranscript = [{
  role: "toolResult",
  toolCallId: "child-write",
  toolName: "writeAssignedTranslation",
  content: [{ type: "text", text: "x".repeat(200_000) }],
  timestamp: 1
}];

const messages = compactSubagentCards([
  {
    role: "custom",
    customType: "subagent.translation",
    content: "worker-1",
    details: {
      subagentId: "child-1",
      status: "running",
      prompt: `translate this assignment ${"p".repeat(200_000)}`,
      transcript: hugeTranscript
    },
    timestamp: 1
  },
  {
    role: "custom",
    customType: "subagent.translation",
    content: `worker-1 complete ${"r".repeat(200_000)}`,
    details: {
      subagentId: "child-1",
      status: "completed",
      prompt: `translate this assignment ${"p".repeat(200_000)}`,
      reply: `full child reply ${"r".repeat(200_000)}`,
      resultSummary: "translated requested range",
      transcript: hugeTranscript
    },
    timestamp: 2
  }
]);

assert.equal(messages.length, 1);
assert.equal(messages[0].timestamp, 2);
assert.equal(Object.hasOwn(messages[0].details, "transcript"), false);
assert.equal(Object.hasOwn(messages[0].details, "prompt"), false);
assert.equal(Object.hasOwn(messages[0].details, "reply"), false);
assert.equal(messages[0].content, "translated requested range");
assert.ok(JSON.stringify(messages[0]).length < 4096);

const compactionProvider = fauxProvider({
  provider: "subagent-card-compaction",
  models: [{ id: "subagent-card-model", reasoning: false, contextWindow: 64_000, maxTokens: 4_096 }],
  tokensPerSecond: 10_000
});
compactionProvider.setResponses([
  fauxAssistantMessage(fauxText("## Goal\nRetain the current lightweight child status after compaction."))
]);
const models = createModels();
models.setProvider(compactionProvider.provider);
const session = await new InMemorySessionRepo().create({ id: "subagent_card_compaction" });
for (let turn = 0; turn < 14; turn += 1) {
  await session.appendMessage({ role: "user", content: [{ type: "text", text: `user-${turn}: ${"u".repeat(5_000)}` }], timestamp: turn * 2 + 1 });
  await session.appendMessage(fauxAssistantMessage(fauxText(`assistant-${turn}: ${"a".repeat(5_000)}`)));
}
for (const message of [
  {
    role: "custom",
    customType: "subagent.translation",
    content: "worker running",
    details: { subagentId: "child-after-compact", status: "running", transcript: hugeTranscript },
    timestamp: 100
  },
  {
    role: "custom",
    customType: "subagent.translation",
    content: "worker completed",
    details: {
      subagentId: "child-after-compact",
      status: "completed",
      prompt: `large child prompt ${"p".repeat(200_000)}`,
      reply: `large child reply ${"r".repeat(200_000)}`,
      resultSummary: "worker completed",
      transcript: hugeTranscript
    },
    timestamp: 101
  }
]) {
  await session.appendMessage(message);
}
const runtime = new PiSessionAgentRuntime({
  session,
  sessionId: "subagent_card_compaction",
  models,
  model: compactionProvider.getModel(),
  thinkingLevel: "off",
  systemPrompt: "Keep child cards lightweight.",
  tools: []
});
try {
  await runtime.initialize();
  await runtime.compact();
  const runtimeCards = runtime.getMessages().filter((message) => message.role === "custom" && message.details?.subagentId);
  assert.equal(runtimeCards.length, 1, "compaction must not restore duplicate child cards into parent runtime state");
  assert.equal(runtimeCards[0].details.status, "completed");
  assert.equal(Object.hasOwn(runtimeCards[0].details, "transcript"), false, "compaction must not restore inline child transcripts");
  assert.equal(Object.hasOwn(runtimeCards[0].details, "prompt"), false, "compaction must not restore inline child prompts");
  assert.equal(Object.hasOwn(runtimeCards[0].details, "reply"), false, "compaction must not restore inline child replies");
} finally {
  runtime.dispose();
}

console.log("ok parent transcript projection stays lightweight during initialization and native Pi compaction");
