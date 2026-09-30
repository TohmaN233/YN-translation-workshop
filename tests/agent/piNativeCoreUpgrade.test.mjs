import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiSessionAgentRuntime } from "../../src/main/agent/piNative/sessionAgentRuntime.ts";
import { appendSessionMessage, readSessionContext, readSessionEntries } from "../../src/main/agent/piNative/sessionAccess.ts";

const tool = (name) => ({ name, label: name, description: name, parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });

async function fixture() {
  const session = await new MemorySessionRepo().create({ id: "native-core-upgrade" }, BACKGROUND_CONTEXT);
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(provider.provider);
  const contexts = [];
  provider.setResponses(Array.from({ length: 12 }, () => (context) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage("done");
  }));
  const runtime = new PiSessionAgentRuntime({ session, sessionId: session.metadata.id, models,
    model: provider.getModel(), thinkingLevel: "off", systemPrompt: "assignment alpha",
    tools: [tool("alphaTool")] });
  return { session, provider, contexts, runtime };
}

test("native transcript restores prompt/tools and both reset/reconfigure orders discard old assignments", async () => {
  const { session, contexts, runtime } = await fixture();
  try {
    await runtime.prompt("alpha user sentinel");
    assert.equal(getCurrentSystemPrompt(contexts[0].messages), "assignment alpha");
    assert.deepEqual(getCurrentTools(contexts[0].messages).map((entry) => entry.name), ["alphaTool"]);
    runtime.resetContext();
    runtime.reconfigure({ systemPrompt: "assignment beta", tools: [tool("betaTool")] });
    await runtime.prompt("beta user sentinel");
    assert.equal(getCurrentSystemPrompt(contexts[1].messages), "assignment beta");
    assert.deepEqual(getCurrentTools(contexts[1].messages).map((entry) => entry.name), ["betaTool"]);
    assert.doesNotMatch(JSON.stringify(contexts[1]), /assignment alpha|alphaTool|alpha user sentinel/);
    runtime.reconfigure({ systemPrompt: "assignment gamma", tools: [tool("gammaTool")] });
    runtime.resetContext();
    await runtime.prompt("gamma user sentinel");
    assert.equal(getCurrentSystemPrompt(contexts[2].messages), "assignment gamma");
    assert.deepEqual(getCurrentTools(contexts[2].messages).map((entry) => entry.name), ["gammaTool"]);
    assert.doesNotMatch(JSON.stringify(contexts[2]), /assignment beta|betaTool|beta user sentinel/);
    // Reset affects active context, never removes the durable audit history.
    const persisted = await readSessionContext(session);
    assert.match(JSON.stringify(persisted), /alpha user sentinel/);
    assert.match(JSON.stringify(persisted), /beta user sentinel/);
    assert.equal(getCurrentSystemPrompt(persisted.messages), "assignment gamma");
  } finally { runtime.dispose(); await session.close(BACKGROUND_CONTEXT); }
});

test("idle reconfiguration replaces the named prompt and native tool replay without discarding conversation", async () => {
  const { session, contexts, runtime } = await fixture();
  try {
    await runtime.prompt("retained conversation");
    runtime.reconfigure({ systemPrompt: "new instructions", tools: [tool("newTool")] });
    await runtime.prompt("next question");
    assert.equal(getCurrentSystemPrompt(contexts[1].messages), "new instructions");
    assert.deepEqual(getCurrentTools(contexts[1].messages).map((entry) => entry.name), ["newTool"]);
    assert.match(JSON.stringify(contexts[1]), /retained conversation/);
    const stored = await readSessionContext(session);
    assert.equal(getCurrentSystemPrompt(stored.messages), "new instructions");
    assert.deepEqual(getCurrentTools(stored.messages).map((entry) => entry.name), ["newTool"]);
  } finally { runtime.dispose(); await session.close(BACKGROUND_CONTEXT); }
});

test("Stop aborts native compaction and preserves original history without a partial summary", async () => {
  const { session, provider, runtime } = await fixture();
  try {
    for (let index = 0; index < 14; index++) {
      await appendSessionMessage(session, { role: "user", content: "seed".repeat(2_000), timestamp: index });
      await appendSessionMessage(session, fauxAssistantMessage("reply".repeat(2_000)));
    }
    let started;
    const generationStarted = new Promise((resolve) => { started = resolve; });
    provider.setResponses([async (_context, options) => {
      started();
      await new Promise((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
    }]);
    const task = runtime.compact();
    // Install rejection handling before Stop so cancellation cannot be unhandled.
    const rejected = assert.rejects(task, /abort|cancel/i);
    await generationStarted;
    await runtime.abort();
    await rejected;
    assert.equal((await readSessionEntries(session)).filter((entry) => entry.type === "compaction").length, 0);
    assert.equal((await readSessionContext(session)).messages.filter((message) => message.role === "user").length, 14);
  } finally { runtime.dispose(); await session.close(BACKGROUND_CONTEXT); }
});
