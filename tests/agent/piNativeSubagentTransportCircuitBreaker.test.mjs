import { strict as assert } from "node:assert";

import { SubagentTransportExhaustedError } from "../../src/main/agent/piNative/assignmentFailure.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const tasks = ["A", "B", "C"].map((documentId) => ({ documentId, fromLine: 1, toLine: 1 }));
const calls = [];
const completionMessages = [];
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  notifyParent: async (message) => completionMessages.push(message)
});

supervisor.startBatch({
  kind: "translation",
  request: {
    outputDir: process.cwd(),
    sourcePath: "unused.txt",
    sessionId: "transport-circuit-breaker",
    prompt: "transport-circuit-breaker",
    providerId: "faux",
    modelId: "faux",
    languagePair: "ja->zh-CN"
  },
  tasks,
  maxWorkers: 1,
  maxAssignmentAttempts: 2,
  run: async () => {
    throw new Error("the persistent worker path must own this test");
  },
  async createWorker() {
    return {
      async run(task) {
        calls.push(task.documentId);
        throw new SubagentTransportExhaustedError("fetch failed");
      },
      async finish() {},
      async dispose() {}
    };
  },
  label: (task) => task.documentId,
  range: (task) => task,
  documentId: (task) => task.documentId
});

await supervisor.waitForAll();
const batch = supervisor.list()[0];

assert.equal(batch.status, "failed");
assert.deepEqual(calls, ["A"], "an exhausted provider transport must not drain later queue assignments");
assert.equal(batch.subagents[0].assignmentCount, 1, "the prompt-level retry budget already exhausted the current assignment");
assert.equal(batch.subagents[0].failureDisposition, "transport_retry_exhausted");
assert.match(
  completionMessages.at(-1).content,
  /Do not automatically start another child batch/i,
  "the hidden parent completion must not turn a provider outage into an automatic batch restart loop"
);

console.log("ok exhausted child transport stops its worker without draining or automatically restarting the queue");
