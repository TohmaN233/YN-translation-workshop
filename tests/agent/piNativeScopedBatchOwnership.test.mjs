import { strict as assert } from "node:assert";

import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const releaseProofread = deferred();
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {}
});
const request = {
  outputDir: process.cwd(),
  sourcePath: "source.txt",
  sessionId: "scoped-batch-ownership",
  prompt: "exercise scoped batch ownership",
  providerId: "faux",
  modelId: "faux",
  languagePair: "en->zh-CN"
};

supervisor.startBatch({
  kind: "proofread",
  request,
  tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 100 }],
  maxWorkers: 1,
  run: async (task) => {
    await releaseProofread.promise;
    return task;
  },
  label: () => "proofread",
  range: (task) => task,
  documentId: (task) => task.documentId
});

assert.doesNotThrow(() => supervisor.startBatch({
  kind: "general",
  request,
  tasks: [{ documentId: "source.txt", fromLine: 10, toLine: 10 }],
  maxWorkers: 1,
  run: async (task) => task,
  label: () => "bounded repair",
  range: (task) => task,
  documentId: (task) => task.documentId,
  writeScope: (task) => task
}), "a read-only proofread batch must not occupy or block an independent bounded repair");

releaseProofread.resolve();
await supervisor.waitForAll();

assert.equal(supervisor.hasRunning(), false);
assert.equal(supervisor.list().filter((batch) => batch.status === "completed").length, 2);

console.log("ok read-only proofread and bounded translation repair use independent scoped ownership");

const releaseWriter = deferred();
const writerSupervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
const startWriter = (fromLine, toLine, run) => writerSupervisor.startBatch({
  kind: "general",
  request,
  tasks: [{ documentId: "source.txt", fromLine, toLine }],
  maxWorkers: 1,
  run,
  label: () => `repair L${fromLine}-L${toLine}`,
  range: (task) => task,
  documentId: (task) => task.documentId,
  writeScope: (task) => task
});

startWriter(20, 30, async (task) => {
  await releaseWriter.promise;
  return task;
});
assert.throws(
  () => startWriter(30, 40, async (task) => task),
  /overlaps active batch.*L20-L30/i,
  "overlapping translation writers must still be rejected with the exact conflicting scope"
);
assert.doesNotThrow(
  () => startWriter(31, 40, async (task) => task),
  "disjoint translation repairs must be allowed to progress independently"
);
releaseWriter.resolve();
await writerSupervisor.waitForAll();

console.log("ok only overlapping translation write scopes conflict");

let modelSelectionCalls = 0;
let settledReview;
const reviewSupervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  createModelSelection: async () => {
    modelSelectionCalls += 1;
    throw new Error("a hash-current review resume must not create a translation model runtime");
  }
});
const resumed = reviewSupervisor.startTranslationReviewBatch({
  request,
  tasks: [{
    documentId: "source.txt",
    fromLine: 41,
    toLine: 50,
    label: "resume review",
    reviewOnly: true
  }],
  maxWorkers: 1,
  reviewRequestForTask: async (task, subagentId, signal) => ({
    subagentId,
    label: task.label,
    documentId: task.documentId,
    fromLine: task.fromLine,
    toLine: task.toLine,
    validation: {},
    discoveries: { glossaryCandidates: [], characterFacts: [] },
    signal
  }),
  prepareChunkReview: async () => ({ decision: { accepted: true } }),
  onSettled: async (outcome) => { settledReview = outcome; }
});
assert.equal(resumed.kind, "translation-review");
await reviewSupervisor.waitForAll();
assert.equal(modelSelectionCalls, 0, "read-only review resume must not invoke a translation worker or model");
assert.deepEqual(settledReview.results, [{ accepted: true }]);
assert.equal(reviewSupervisor.list()[0].status, "completed");

console.log("ok interrupted hash-current review resumes through the read-only review path");
