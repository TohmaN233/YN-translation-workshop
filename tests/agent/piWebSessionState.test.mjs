import { strict as assert } from "node:assert";
import { build } from "esbuild";

const bundled = await build({
  stdin: {
    contents: 'export { appendPiSessionMessage, convergePiTerminalState, createSynchronizedSessionState, mergePiRunState, nativeRunStateClaimsPrompt, reduceNativePiEvent, resolveConfiguredModelSelection, shouldApplyPiSessionState } from "./src/renderer/agent/piweb/useAgentSession.ts";',
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});
const reducerModule = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const {
  appendPiSessionMessage,
  convergePiTerminalState,
  createSynchronizedSessionState,
  mergePiRunState,
  nativeRunStateClaimsPrompt,
  reduceNativePiEvent,
  resolveConfiguredModelSelection,
  shouldApplyPiSessionState
} = reducerModule;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function state(overrides = {}) {
  return {
    sessionId: "pi_test",
    sessions: [],
    messages: [],
    streamingMessage: null,
    agentRunning: true,
    phase: { kind: "waiting_model" },
    phaseText: "thinking",
    providerId: "openai-chatgpt",
    modelId: "gpt-test",
    modelList: [],
    modelNames: {},
    thinkingLevel: "auto",
    queuedSteer: [],
    queuedFollowUp: [],
    queuedNextTurn: [],
    isCompacting: false,
    compactResult: null,
    compactError: null,
    contextUsage: null,
    lastSequence: 0,
    ...overrides
  };
}

function runState(overrides = {}) {
  return {
    sessionId: "pi_test",
    sequence: 0,
    running: false,
    phase: "idle",
    streamingMessage: null,
    model: null,
    thinkingLevel: "off",
    queuedSteer: [],
    queuedFollowUp: [],
    queuedNextTurn: [],
    subagentMessages: [],
    compacting: false,
    ...overrides
  };
}

await test("idle create-session snapshot cannot erase an optimistic first send", () => {
  const optimistic = state({ messages: [{ role: "user", content: "你好", timestamp: 1 }] });
  const merged = mergePiRunState(optimistic, runState(), true);
  assert.equal(merged.agentRunning, true);
  assert.deepEqual(merged.phase, { kind: "waiting_model" });
  assert.equal(merged.phaseText, "thinking");
  assert.equal(merged.messages[0].content, "你好");
});

await test("provider selection and bootstrap share one synchronous renderer state", () => {
  const store = createSynchronizedSessionState(state({
    sessionId: "",
    providerId: "",
    modelId: "",
    modelList: [],
    modelNames: {}
  }));
  const selected = store.update((current) => ({
    ...current,
    providerId: "openai-chatgpt",
    modelId: "gpt-5.5",
    modelList: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai-chatgpt" }]
  }));
  const bootstrapped = store.update((current) => ({
    ...current,
    sessionId: "pi_fresh",
    sessions: [{ id: "pi_fresh" }]
  }));
  assert.equal(selected.providerId, "openai-chatgpt");
  assert.equal(bootstrapped.providerId, "openai-chatgpt");
  assert.equal(store.current.providerId, "openai-chatgpt");
  assert.equal(store.current.modelId, "gpt-5.5");
  assert.equal(store.current, bootstrapped);
});

await test("an unconfigured active provider cannot enter the chat model selector", () => {
  const selection = resolveConfiguredModelSelection(
    {
      activeProviderId: "anthropic-claude",
      providers: {
        "anthropic-claude": { model: "claude-sonnet" },
        "custom-api": { model: "opencode-main" }
      }
    },
    [
      { provider: "custom-api", id: "opencode-main", name: "opencode-main" },
      { provider: "custom-api", id: "opencode-fast", name: "opencode-fast" }
    ]
  );
  assert.deepEqual(selection, { provider: "custom-api", modelId: "opencode-main" });
});

await test("inactive background runtime state cannot steal explicit session selection", () => {
  assert.equal(shouldApplyPiSessionState("selected-b", "background-a", false), false);
  assert.equal(shouldApplyPiSessionState("selected-b", "background-a", true), true);
  assert.equal(shouldApplyPiSessionState("selected-b", "selected-b", false), true);
});

await test("native running state takes ownership after prompt acceptance", () => {
  const merged = mergePiRunState(state(), runState({ sequence: 1, running: true, phase: "turn" }), true);
  assert.equal(merged.agentRunning, true);
  assert.deepEqual(merged.phase, { kind: "waiting_model" });
  assert.equal(merged.lastSequence, 1);
});

await test("native queue_update keeps the exact queued Steer text visible", () => {
  const steer = { role: "user", content: "优先采用现有术语表", timestamp: 42 };
  const next = reduceNativePiEvent(state(), {
    workspaceDir: "C:/project",
    sessionId: "pi_test",
    sequence: 1,
    timestamp: 43,
    event: {
      type: "queue_update",
      steer: [steer],
      followUp: [],
      nextTurn: []
    }
  });
  assert.deepEqual(next.queuedSteer, [steer]);
  assert.deepEqual(next.queuedFollowUp, []);
});

await test("run-state reconnect restores exact queued Pi messages instead of counts", () => {
  const followUp = { role: "user", content: "完成后汇总发现", timestamp: 44 };
  const merged = mergePiRunState(state(), runState({
    sequence: 5,
    running: true,
    phase: "turn",
    queuedFollowUp: [followUp]
  }));
  assert.deepEqual(merged.queuedSteer, []);
  assert.deepEqual(merged.queuedFollowUp, [followUp]);
});

await test("run-state reconnect restores the latest lightweight native child card", () => {
  const persisted = {
    role: "custom",
    customType: "subagent.translation",
    content: "shard-1",
    timestamp: 10,
    details: { subagentId: "child-1", status: "running", activity: "starting" }
  };
  const live = {
    role: "custom",
    customType: "subagent.translation",
    content: "working",
    timestamp: 11,
    details: {
      subagentId: "child-1",
      status: "running",
      activity: "chunk 1/3"
    }
  };
  const merged = mergePiRunState(
    state({ messages: [persisted] }),
    runState({ sequence: 7, subagentMessages: [live] })
  );
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messages[0].timestamp, 11);
  assert.equal(merged.messages[0].details.activity, "chunk 1/3");
  assert.equal(Object.hasOwn(merged.messages[0].details, "transcript"), false);
});

await test("native Pi compaction state and token result survive reconnect", () => {
  const result = {
    reason: "manual",
    summary: "memory summary",
    firstKeptEntryId: "entry-3",
    tokensBefore: 42_000,
    estimatedTokensAfter: 18_000,
    timestamp: 123
  };
  const merged = mergePiRunState(state(), runState({
    phase: "compaction",
    compacting: true,
    contextUsage: { tokens: 42_000, contextWindow: 128_000, percent: 32.8125 },
    lastCompaction: result
  }));
  assert.equal(merged.isCompacting, true);
  assert.equal(merged.phaseText, "compacting");
  assert.deepEqual(merged.compactResult, result);
  assert.deepEqual(merged.contextUsage, { tokens: 42_000, contextWindow: 128_000, percent: 32.8125 });
});

await test("native auto-compaction failure terminates an optimistic prompt instead of leaving Stop visible", () => {
  const failedCompaction = runState({
    sequence: 3,
    running: false,
    phase: "idle",
    compacting: false,
    compactionError: "native compaction failed",
    error: "native compaction failed"
  });
  assert.equal(nativeRunStateClaimsPrompt(failedCompaction), true);
  assert.equal(nativeRunStateClaimsPrompt(runState()), false);
  const merged = mergePiRunState(state(), failedCompaction, true);
  assert.equal(merged.agentRunning, false);
  assert.equal(merged.isCompacting, false);
  assert.equal(merged.streamingMessage, null);
  assert.equal(merged.phase, null);
  assert.equal(merged.phaseText, "native compaction failed");
  assert.equal(merged.compactError, "native compaction failed");
});

await test("terminal transcript convergence preserves accepted native Pi queue messages", () => {
  const followUp = { role: "user", content: "失败后继续处理", timestamp: 45 };
  const current = state({ lastSequence: 4, queuedFollowUp: [followUp] });
  const converged = convergePiTerminalState(
    current,
    [{ role: "user", content: "first turn", timestamp: 1 }],
    runState({ sequence: 5, error: "provider failed", queuedFollowUp: [followUp] }),
    5,
    "provider failed"
  );
  assert.equal(converged.agentRunning, false);
  assert.equal(converged.phaseText, "provider failed");
  assert.deepEqual(converged.queuedFollowUp, [followUp]);
  assert.equal(converged.messages[0].content, "first turn");
});

await test("an old equal-sequence terminal reload cannot erase a newer optimistic turn", () => {
  const current = state({
    lastSequence: 5,
    messages: [
      { role: "user", content: "old turn", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: 2 },
      { role: "user", content: "new optimistic turn", timestamp: 3 }
    ],
    agentRunning: true,
    phase: { kind: "waiting_model" },
    phaseText: "thinking"
  });
  const converged = convergePiTerminalState(
    current,
    [
      { role: "user", content: "old turn", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: 2 }
    ],
    runState({ sequence: 5, running: false }),
    5,
    undefined,
    true
  );
  assert.equal(converged.agentRunning, true);
  assert.equal(converged.phaseText, "thinking");
  assert.equal(converged.messages.at(-1).content, "new optimistic turn");
});

await test("two subagents with the same timestamp remain separate cards", () => {
  const first = { role: "custom", customType: "subagent", content: "", timestamp: 10, details: { subagentId: "a", status: "running" } };
  const second = { role: "custom", customType: "subagent", content: "", timestamp: 10, details: { subagentId: "b", status: "running" } };
  const messages = appendPiSessionMessage(appendPiSessionMessage([], first), second);
  assert.equal(messages.length, 2);
});

await test("a completed subagent replaces its own running card", () => {
  const running = { role: "custom", customType: "subagent", content: "", timestamp: 10, details: { subagentId: "a", status: "running" } };
  const completed = { role: "custom", customType: "subagent", content: "done", timestamp: 11, details: { subagentId: "a", status: "closed" } };
  const messages = appendPiSessionMessage(appendPiSessionMessage([], running), completed);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].details.status, "closed");
});

await test("same-timestamp assistant messages with different content are not collapsed", () => {
  const first = { role: "assistant", content: [{ type: "text", text: "one" }], timestamp: 20 };
  const second = { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 20 };
  const messages = appendPiSessionMessage(appendPiSessionMessage([], first), second);
  assert.equal(messages.length, 2);
});

await test("native Pi image messages replace their optimistic source-form message exactly once", () => {
  const data = Buffer.from("image-fixture").toString("base64");
  const optimistic = {
    role: "user",
    content: [
      { type: "text", text: "看看这张图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data } }
    ],
    timestamp: 20
  };
  const native = {
    role: "user",
    content: [
      { type: "text", text: "看看这张图" },
      { type: "image", mimeType: "image/png", data }
    ],
    timestamp: 21
  };
  const messages = appendPiSessionMessage([optimistic], native);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].timestamp, 21);
});

await test("a native provider timeout immediately terminates running UI state with a visible error phase", () => {
  const errorMessage = "Pi provider stream inactivity timeout after 60000ms. The request was aborted and may be retried.";
  const reduced = reduceNativePiEvent(state(), {
    workspaceDir: "G:/project",
    sessionId: "pi_test",
    sequence: 1,
    timestamp: 2,
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Planning" }],
        provider: "test",
        model: "test-model",
        stopReason: "error",
        errorMessage,
        timestamp: 2
      }
    }
  });
  assert.equal(reduced.agentRunning, false);
  assert.equal(reduced.streamingMessage, null);
  assert.equal(reduced.phase, null);
  assert.equal(reduced.phaseText, errorMessage);
  assert.equal(reduced.messages.at(-1).errorMessage, errorMessage);
});

await test("Pi native auto-retry restores running UI state and exposes the source pi-web retry banner contract", () => {
  const errorMessage = "fetch failed";
  const failed = reduceNativePiEvent(state(), {
    workspaceDir: "G:/project",
    sessionId: "pi_test",
    sequence: 1,
    timestamp: 2,
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        provider: "openai-chatgpt",
        model: "gpt-5.6-terra",
        stopReason: "error",
        errorMessage,
        timestamp: 2
      }
    }
  });
  const retrying = reduceNativePiEvent(failed, {
    workspaceDir: "G:/project",
    sessionId: "pi_test",
    sequence: 2,
    timestamp: 3,
    event: {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage
    }
  });
  assert.equal(retrying.agentRunning, true);
  assert.deepEqual(retrying.retryInfo, { attempt: 1, maxAttempts: 3, errorMessage });
  assert.deepEqual(retrying.phase, { kind: "waiting_model" });

  const recovered = reduceNativePiEvent(retrying, {
    workspaceDir: "G:/project",
    sessionId: "pi_test",
    sequence: 3,
    timestamp: 4,
    event: { type: "auto_retry_end", success: true, attempt: 1 }
  });
  assert.equal(recovered.agentRunning, true);
  assert.equal(recovered.retryInfo, null);
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
