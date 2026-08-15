import { strict as assert } from "node:assert";

import { shouldResetSubagentCodexFallback } from "../../src/main/agent/piNative/subagentRunner.ts";

assert.equal(shouldResetSubagentCodexFallback({
  api: "openai-codex-responses",
  errorMessage: "fetch failed",
  stats: { websocketFallbackActive: true }
}), true, "a failed SSE request must let the bounded final retry return to WebSocket");

assert.equal(shouldResetSubagentCodexFallback({
  api: "openai-codex-responses",
  errorMessage: "WebSocket closed 1006",
  stats: { websocketFallbackActive: true }
}), false, "the first WebSocket failure must still receive its intended SSE fallback attempt");

assert.equal(shouldResetSubagentCodexFallback({
  api: "openai-responses",
  errorMessage: "fetch failed",
  stats: { websocketFallbackActive: true }
}), false, "transport recovery must not mutate another provider's state");

assert.equal(shouldResetSubagentCodexFallback({
  api: "openai-codex-responses",
  errorMessage: "fetch failed"
}), false, "an ordinary fetch failure without a recorded WebSocket fallback must remain untouched");

console.log("ok Codex child retries recover from a failed sticky SSE fallback without bypassing bounded retry");
