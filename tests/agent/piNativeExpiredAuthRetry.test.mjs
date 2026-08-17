import { strict as assert } from "node:assert";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core/node";

const { PiSessionAgentRuntime } = await import("../../src/main/agent/piNative/sessionAgentRuntime.ts");

async function runExpiredAuth(options = {}) {
  const provider = fauxProvider({ provider: options.providerId ?? "expired-auth", tokensPerSecond: 10_000 });
  let providerCalls = 0;
  provider.setResponses([
    async () => {
      providerCalls += 1;
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: '403 "The OAuth2 access token could not be validated."'
      });
    },
    async () => {
      providerCalls += 1;
      return fauxAssistantMessage(fauxText("continued after refresh"));
    }
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const session = await new InMemorySessionRepo().create({ id: options.sessionId ?? "expired-auth" });
  let refreshCalls = 0;
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: options.sessionId ?? "expired-auth",
    models,
    model: provider.getModel(),
    thinkingLevel: "off",
    systemPrompt: "test",
    tools: [],
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    ...(options.refresh ? {
      refreshExpiredProviderAuth: async (model) => {
        refreshCalls += 1;
        return model;
      }
    } : {})
  });
  try {
    await runtime.prompt("continue the workflow");
    const messages = (await session.buildContext()).messages;
    const last = messages.at(-1);
    return {
      providerCalls,
      refreshCalls,
      lastStopReason: last?.stopReason,
      lastText: Array.isArray(last?.content)
        ? last.content.filter((block) => block.type === "text").map((block) => block.text).join("")
        : ""
    };
  } finally {
    runtime.dispose();
  }
}

{
  const result = await runExpiredAuth({ sessionId: "expired-auth-no-refresh" });
  assert.equal(result.refreshCalls, 0);
  assert.equal(result.providerCalls, 1, "worker-style runtime must not retry 403 on the same session");
  assert.equal(result.lastStopReason, "error");
}

{
  const result = await runExpiredAuth({
    sessionId: "expired-auth-parent-refresh",
    providerId: "expired-auth-parent",
    refresh: true
  });
  assert.equal(result.refreshCalls, 1, "parent 403 must refresh before retrying");
  assert.equal(result.providerCalls, 2, "parent 403 must retry the same runtime after refresh");
  assert.equal(result.lastText, "continued after refresh");
}

console.log("ok expired OAuth retries only after a successful parent token refresh");
