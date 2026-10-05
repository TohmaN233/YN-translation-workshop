import { MemorySessionRepo, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { appendSessionMessage } from "../helpers/pi-session.mjs";
import { strict as assert } from "node:assert";

import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiSessionAgentRuntime } from "../../src/main/agent/piNative/sessionAgentRuntime.ts";
import { readSessionEntries } from "../../src/main/agent/piNative/sessionAccess.ts";

import { promptSubagentTurn } from "../../src/main/agent/piNative/subagentRunner.ts";
import { appendSessionCompaction } from "../../src/main/agent/piNative/sessionAccess.ts";

const previous = fauxAssistantMessage(fauxText("previous turn"));
const fresh = fauxAssistantMessage(fauxText("fresh retry response"));
const session = await new MemorySessionRepo().create({ id: "fresh-response" }, BACKGROUND_CONTEXT);
await appendSessionMessage(session, previous);
let promptCalls = 0;
const retries = [];

const response = await promptSubagentTurn({
  runtime: {
    subscribe() {
      return () => {};
    },
    async prompt() {
      promptCalls += 1;
      if (promptCalls === 2) await appendSessionMessage(session, fresh);
    }
  },
  session,
  prompt: "Repair the host-rejected lines.",
  onRetry(attempt, error) {
    retries.push({ attempt, error });
  }
});

assert.equal(promptCalls, 2, "a turn with no fresh assistant message must retry in the same child session");
assert.deepEqual(response, fresh, "the stale assistant from the preceding turn must never satisfy the new host prompt");
assert.deepEqual(retries, [{
  attempt: 1,
  error: "Pi child turn completed without a fresh assistant message."
}]);

console.log("ok a host prompt requires a fresh Pi assistant response before it can make progress");

for (const retainedFresh of [false, true]) {
  const compactedSession = await new MemorySessionRepo().create({ id: `fresh-compacted-${retainedFresh}` }, BACKGROUND_CONTEXT);
  for (let turn = 0; turn < 5; turn++) await appendSessionMessage(compactedSession, previous);
  let compactedPromptCalls = 0;
  const compactedResponse = await promptSubagentTurn({
    runtime: {
      subscribe() { return () => {}; },
      async prompt() {
        compactedPromptCalls += 1;
        if (retainedFresh) await appendSessionMessage(compactedSession, fresh);
        await appendSessionCompaction(compactedSession, {
          summary: "Native Pi compaction retains the current assignment.",
          tokensBefore: 469_108,
          retainedTail: retainedFresh ? [fresh] : []
        });
        if (!retainedFresh) await appendSessionMessage(compactedSession, fresh);
      }
    },
    session: compactedSession,
    prompt: "Submit the Host-selected review exactly once."
  });
  assert.equal(compactedPromptCalls, 1, "native compaction must not replay an already completed Host prompt");
  assert.deepEqual(compactedResponse, fresh, "freshness must use actual native entries, including an assistant compacted into the tail");
}
console.log("ok native compaction before or after a fresh assistant cannot repeat a completed Host prompt");

const compactedStaleSession = await new MemorySessionRepo().create({ id: "compacted-stale-response" }, BACKGROUND_CONTEXT);
await appendSessionMessage(compactedStaleSession, previous);
let stalePromptCalls = 0;
await promptSubagentTurn({
  runtime: {
    subscribe() { return () => {}; },
    async prompt() {
      stalePromptCalls += 1;
      if (stalePromptCalls === 1) await appendSessionCompaction(compactedStaleSession, {
        summary: "Only older responses survive.", tokensBefore: 469_108, retainedTail: [previous, previous, previous]
      });
      else await appendSessionMessage(compactedStaleSession, fresh);
    }
  },
  session: compactedStaleSession,
  prompt: "A genuinely missing new response still needs its bounded retry."
});
assert.equal(stalePromptCalls, 2, "retained old messages cannot satisfy a new Host prompt even if projected counts grow");
console.log("ok native retained-tail copies cannot masquerade as a fresh assistant response");

const nativeSession = await new MemorySessionRepo().create({ id: "native-post-submit-compaction" }, BACKGROUND_CONTEXT);
for (let turn = 0; turn < 14; turn++) {
  await appendSessionMessage(nativeSession, { role: "user", content: `old-${turn}: ${"u".repeat(5000)}`, timestamp: Date.now() });
  await appendSessionMessage(nativeSession, fauxAssistantMessage(fauxText(`old-${turn}: ${"a".repeat(5000)}`)));
}
const provider = fauxProvider({ provider: "post-submit-compaction", tokenSize: { min: 16_384, max: 16_384 },
  models: [{ id: "post-submit", reasoning: false, contextWindow: 64_000, maxTokens: 4096 }] });
const models = createModels(); models.setProvider(provider.provider);
const nativeCalls = [];
provider.setResponses([
  fauxAssistantMessage([fauxText("Current review reasoning: " + "r".repeat(100_000)), fauxToolCall("submit", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("## Goal\nPreserve the completed review and its submitted rejection result.")),
  fauxAssistantMessage(fauxText("## Turn\nThe safety review submitted ten rejected rows before compaction."))
].map(response => async context => {
  nativeCalls.push({ system: getCurrentSystemPrompt(context.messages), lastUser: JSON.stringify(context.messages.filter(message => message.role === "user").at(-1)?.content).slice(0, 500) });
  return response;
}));
let submissions = 0;
const nativeRuntime = new PiSessionAgentRuntime({ session: nativeSession, sessionId: "native-post-submit-compaction",
  models, model: provider.getModel(), thinkingLevel: "off", systemPrompt: "Submit this translation review once.",
  tools: [{ name: "submit", label: "Submit review", description: "Submit review", parameters: Type.Object({}),
    async execute() { submissions++; return { content: [{ type: "text", text: "accepted=false; 10 rejected lines" }], details: {}, terminate: true }; } }] });
try {
  const result = await promptSubagentTurn({ runtime: nativeRuntime, session: nativeSession, prompt: "Complete the current Host review." });
  assert.equal(result.stopReason, "toolUse");
  assert.equal(submissions, 1, "a successful terminal tool result must not replay when Pi compacts afterwards");
  assert.equal(provider.state.callCount, 3, "only the original review turn and native compaction summaries may call the provider");
  assert.equal(nativeCalls[0].system, "Submit this translation review once.");
  assert.ok(nativeCalls.slice(1).every(call => call.system.includes("context summarization assistant")),
    "the two extra calls must belong to Pi summarization, never another reviewer assignment");
  assert.ok(nativeCalls[2].lastUser.includes("PREFIX of a turn"), "Pi's split-turn prefix summary must account for the third call");
  assert.equal((await readSessionEntries(nativeSession)).filter(entry => entry.type === "compaction").length, 1);
  console.log("ok actual Pi post-submit threshold compaction preserves the fresh terminal assistant and never replays its tool");
} finally { await nativeRuntime.dispose(); }
