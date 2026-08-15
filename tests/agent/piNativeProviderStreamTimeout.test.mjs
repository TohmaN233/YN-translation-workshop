import { strict as assert } from "node:assert";

import {
  createModels,
  fauxProvider
} from "@earendil-works/pi-ai";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core/node";

const { PiSessionAgentRuntime } = await import("../../src/main/agent/piNative/sessionAgentRuntime.ts");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const provider = fauxProvider({ provider: "stalled-provider", tokensPerSecond: 1000 });
provider.setResponses([
  (_context, options) => new Promise((_resolve, reject) => {
    const onAbort = () => reject(new Error("stalled provider observed abort"));
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) onAbort();
  })
]);
const models = createModels();
models.setProvider(provider.provider);
const session = await new InMemorySessionRepo().create({ id: "pi_provider_idle_timeout" });
const runtime = new PiSessionAgentRuntime({
  session,
  sessionId: "pi_provider_idle_timeout",
  models,
  model: provider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Exercise the native Pi provider stream boundary.",
  tools: [],
  providerStreamTimeouts: {
    inactivityMs: 30,
    totalMs: 200
  },
  retry: { enabled: false }
});

let turn;
try {
  turn = runtime.prompt("Do not hang forever.");
  const outcome = await Promise.race([
    turn.then(() => "settled"),
    delay(150).then(() => "hung")
  ]);
  if (outcome === "hung") await runtime.abort();
  assert.equal(outcome, "settled", "a provider stream with no events remained running past its inactivity deadline");

  const messages = (await session.buildContext()).messages;
  const assistant = messages.findLast((message) => message.role === "assistant");
  assert.equal(assistant?.stopReason, "error");
  assert.match(assistant?.errorMessage ?? "", /provider stream inactivity timeout/i);
  const timeoutDiagnostic = (await session.getEntries()).find((entry) => (
    entry.type === "custom" && entry.customType === "yn_provider_transport_error"
  ));
  assert.equal(timeoutDiagnostic?.data?.sessionId, "pi_provider_idle_timeout");
  assert.equal(timeoutDiagnostic?.data?.details?.phase, "stream_inactivity_timeout");
} finally {
  if (turn) await Promise.allSettled([turn]);
runtime.dispose();
}

const websocketProvider = fauxProvider({ provider: "websocket-provider", tokensPerSecond: 1000 });
websocketProvider.setResponses([
  {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "websocket-provider",
    model: "faux-model",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "error",
    errorMessage: "WebSocket closed 1006",
    diagnostics: [{
      type: "provider_transport_failure",
      error: { name: "WebSocketCloseError", message: "WebSocket closed 1006", code: 1006 },
      details: { configuredTransport: "auto", phase: "after_message_stream_start", requestBytes: 5600 }
    }],
    timestamp: Date.now()
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "recovered from websocket close" }],
    api: "openai-codex-responses",
    provider: "websocket-provider",
    model: "faux-model",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  }
]);
const websocketModels = createModels();
websocketModels.setProvider(websocketProvider.provider);
const websocketSession = await new InMemorySessionRepo().create({ id: "pi_provider_websocket_retry" });
const websocketRuntime = new PiSessionAgentRuntime({
  session: websocketSession,
  sessionId: "pi_provider_websocket_retry",
  models: websocketModels,
  model: websocketProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Persist provider stream diagnostics before retrying.",
  tools: [],
  providerStreamTimeouts: { inactivityMs: 500 },
  retry: { baseDelayMs: 1 }
});
try {
  await websocketRuntime.prompt("Recover after a websocket stream error.");
  const diagnostics = (await websocketSession.getEntries()).filter((entry) => (
    entry.type === "custom" && entry.customType === "yn_provider_transport_error"
  ));
  assert.equal(diagnostics.length, 1, "one provider failure must create one durable diagnostic");
  assert.equal(diagnostics[0].data?.error?.message, "WebSocket closed 1006");
  assert.equal(diagnostics[0].data?.details?.configuredTransport, "auto");
  assert.equal(diagnostics[0].data?.details?.phase, "after_message_stream_start");
} finally {
  websocketRuntime.dispose();
}

const activeProvider = fauxProvider({ provider: "active-long-provider", tokensPerSecond: 1000 });
activeProvider.setResponses([
  async () => {
    await delay(80);
    return {
      role: "assistant",
      content: [{ type: "text", text: "completed after the former wall-clock deadline" }],
      api: "faux",
      provider: "active-long-provider",
      model: "faux-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    };
  }
]);
const activeModels = createModels();
activeModels.setProvider(activeProvider.provider);
const activeSession = await new InMemorySessionRepo().create({ id: "pi_provider_no_wall_clock_timeout" });
const activeRuntime = new PiSessionAgentRuntime({
  session: activeSession,
  sessionId: "pi_provider_no_wall_clock_timeout",
  models: activeModels,
  model: activeProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "A productive model request must not be killed by a fixed total duration.",
  tools: [],
  providerStreamTimeouts: {
    inactivityMs: 500,
    totalMs: 30
  }
});
try {
  await activeRuntime.prompt("Finish normally even though this turn takes longer than 30ms.");
  const assistant = (await activeSession.buildContext()).messages
    .findLast((message) => message.role === "assistant");
  assert.equal(assistant?.stopReason, "stop");
  assert.match(JSON.stringify(assistant?.content), /former wall-clock deadline/);
} finally {
  activeRuntime.dispose();
}

const transientProvider = fauxProvider({ provider: "transient-provider", tokensPerSecond: 1000 });
transientProvider.setResponses([
  async () => {
    await fetch("http://127.0.0.1:1/provider-diagnostic-test");
  },
  async () => ({
    role: "assistant",
    content: [{ type: "text", text: "recovered without another user message" }],
    api: "faux",
    provider: "transient-provider",
    model: "faux-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  })
]);
const transientModels = createModels();
transientModels.setProvider(transientProvider.provider);
const transientSession = await new InMemorySessionRepo().create({ id: "pi_provider_transient_retry" });
const transientRuntime = new PiSessionAgentRuntime({
  session: transientSession,
  sessionId: "pi_provider_transient_retry",
  models: transientModels,
  model: transientProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Retry Pi-classified transient provider failures in the same turn.",
  tools: [],
  providerStreamTimeouts: { inactivityMs: 500 },
  retry: { baseDelayMs: 1 }
});
try {
  await transientRuntime.prompt("Recover this turn without user intervention.");
  const assistants = (await transientSession.buildContext()).messages
    .filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 2, "the failed provider attempt must remain observable in Pi JSONL");
  assert.equal(assistants[0].errorMessage, "fetch failed");
  assert.equal(assistants[1].stopReason, "stop");
  assert.match(JSON.stringify(assistants[1].content), /recovered without another user message/);
  const diagnostic = (await transientSession.getEntries()).find((entry) => (
    entry.type === "custom" && entry.customType === "yn_provider_transport_error"
  ));
  assert.equal(diagnostic?.data?.sessionId, "pi_provider_transient_retry");
  assert.equal(diagnostic?.data?.error?.message, "fetch failed");
  assert.match(diagnostic?.data?.error?.cause?.message ?? "", /bad port/i);
} finally {
  transientRuntime.dispose();
}

const backoffProvider = fauxProvider({ provider: "backoff-provider", tokensPerSecond: 1000 });
let backoffProviderCalls = 0;
backoffProvider.setResponses([
  async () => {
    backoffProviderCalls += 1;
    throw new Error("fetch failed");
  },
  async () => {
    backoffProviderCalls += 1;
    throw new Error("retry continued after Stop");
  }
]);
const backoffModels = createModels();
backoffModels.setProvider(backoffProvider.provider);
const backoffSession = await new InMemorySessionRepo().create({ id: "pi_provider_abort_retry_backoff" });
const backoffRuntime = new PiSessionAgentRuntime({
  session: backoffSession,
  sessionId: "pi_provider_abort_retry_backoff",
  models: backoffModels,
  model: backoffProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Stop must cancel native Pi retry backoff before another provider request.",
  tools: [],
  providerStreamTimeouts: { inactivityMs: 500 },
  retry: { baseDelayMs: 2_000 }
});
let backoffTurn;
try {
  const retryStarted = new Promise((resolve) => {
    const unsubscribe = backoffRuntime.subscribe((event) => {
      if (event.type !== "auto_retry_start") return;
      unsubscribe();
      resolve(event);
    });
  });
  backoffTurn = backoffRuntime.prompt("Abort during retry backoff.");
  await retryStarted;
  const abortStartedAt = Date.now();
  await backoffRuntime.abort();
  await backoffTurn;
  const abortElapsedMs = Date.now() - abortStartedAt;
  assert.ok(abortElapsedMs < 1_000, `Stop took ${abortElapsedMs}ms to cancel the native Pi retry delay`);
  assert.equal(backoffProviderCalls, 1, "Stop allowed a second provider request after cancelling retry backoff");
} finally {
  if (backoffTurn) await Promise.allSettled([backoffTurn]);
  backoffRuntime.dispose();
}

const stubbornProvider = fauxProvider({ provider: "stubborn-provider", tokensPerSecond: 1000 });
stubbornProvider.setResponses([() => new Promise(() => {})]);
const stubbornModels = createModels();
stubbornModels.setProvider(stubbornProvider.provider);
const stubbornSession = await new InMemorySessionRepo().create({ id: "pi_provider_abort" });
const stubbornRuntime = new PiSessionAgentRuntime({
  session: stubbornSession,
  sessionId: "pi_provider_abort",
  models: stubbornModels,
  model: stubbornProvider.getModel(),
  thinkingLevel: "medium",
  systemPrompt: "Stop must terminate even when a provider ignores AbortSignal.",
  tools: [],
  providerStreamTimeouts: {
    inactivityMs: 10_000,
    totalMs: 20_000
  }
});
let stubbornTurn;
try {
  stubbornTurn = stubbornRuntime.prompt("Wait until stopped.");
  await delay(10);
  const stopped = await Promise.race([
    stubbornRuntime.abort().then(() => "stopped"),
    delay(150).then(() => "hung")
  ]);
  assert.equal(stopped, "stopped", "Stop waited for a provider that ignored its AbortSignal");
  await stubbornTurn;
  const assistant = (await stubbornSession.buildContext()).messages
    .findLast((message) => message.role === "assistant");
  assert.equal(assistant?.stopReason, "aborted");
} finally {
  if (stubbornTurn) await Promise.allSettled([stubbornTurn]);
  stubbornRuntime.dispose();
}

console.log("ok Pi provider streams time out observably and Stop terminates stubborn providers immediately");
