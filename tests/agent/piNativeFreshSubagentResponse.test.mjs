import { MemorySessionRepo, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { appendSessionMessage } from "../helpers/pi-session.mjs";
import { strict as assert } from "node:assert";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { promptSubagentTurn } from "../../src/main/agent/piNative/subagentRunner.ts";

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
