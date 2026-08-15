import { strict as assert } from "node:assert";

import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const tasks = ["A", "B", "C"].map((documentId) => ({ documentId, fromLine: 1, toLine: 1 }));
const callsByWorker = new Map();
let failedAOnce = false;
let releaseB;
const cStarted = new Promise((resolve) => {
  releaseB = resolve;
});

const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {}
});

supervisor.startBatch({
  kind: "translation",
  request: {
    outputDir: process.cwd(),
    sourcePath: "unused.txt",
    sessionId: "retry-owner",
    prompt: "retry-owner",
    providerId: "faux",
    modelId: "faux",
    languagePair: "ja->zh-CN"
  },
  tasks,
  maxWorkers: 2,
  maxAssignmentAttempts: 2,
  run: async () => {
    throw new Error("the persistent worker path must own this test");
  },
  async createWorker({ subagentId }) {
    callsByWorker.set(subagentId, []);
    return {
      async run(task) {
        callsByWorker.get(subagentId).push(task.documentId);
        if (task.documentId === "A" && !failedAOnce) {
          failedAOnce = true;
          throw new Error("first A attempt failed");
        }
        if (task.documentId === "B") await cStarted;
        if (task.documentId === "C") releaseB();
        return { documentId: task.documentId };
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
const traces = [...callsByWorker.values()];
const ownerTraces = traces.filter((trace) => trace.includes("A"));

assert.equal(supervisor.list()[0].status, "completed");
assert.equal(ownerTraces.length, 1, "a retried file must not migrate to a different persistent Pi worker/session");
assert.deepEqual(ownerTraces[0].slice(0, 2), ["A", "A"], "the failed file must retry immediately before the worker claims another queued file");

console.log("ok a failed folder assignment retries immediately in its owning persistent Pi worker");
