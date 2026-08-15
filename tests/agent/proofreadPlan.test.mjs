import assert from "node:assert/strict";

import {
  classifyProofreadRegions,
  createHotSplitProofreadTasks,
  createMontecarloProofreadTasks,
  createSplitProofreadTasks
} from "../../src/main/agent/piNative/proofreadPlan.ts";

const split = createSplitProofreadTasks({
  totalLines: 10,
  workerCount: 3,
  splitSize: 4,
  signals: [{ line: 10, code: "H4", evidence: "tail" }]
});
assert.deepEqual(split.map((task) => [task.fromLine, task.toLine]), [[1, 4], [5, 8], [9, 10]]);
assert.equal(split[2].deterministicSignals.length, 1);
const checkpointed = createSplitProofreadTasks({
  totalLines: 10,
  workerCount: 2,
  splitSize: 4,
  signals: []
});
assert.deepEqual(checkpointed.map((task) => [task.fromLine, task.toLine]), [[1, 4], [5, 8], [9, 10]]);
assert.deepEqual(checkpointed.map((task) => task.checkpointSize), [4, 4, 2]);
assert.deepEqual(
  createSplitProofreadTasks({
    totalLines: 2_500,
    workerCount: 2,
    splitSize: 500,
    signals: []
  }).map((task) => [task.fromLine, task.toLine]),
  [[1, 500], [501, 1_000], [1_001, 1_500], [1_501, 2_000], [2_001, 2_500]],
  "splitSize caps assignment boundaries without capping the Host task count at workerCount"
);
const hotSplit = createHotSplitProofreadTasks({
  totalLines: 1_500,
  workerCount: 2,
  splitSize: 200,
  signals: [
    ...Array.from({ length: 30 }, (_, index) => ({ line: index + 1, code: "H4", evidence: "hot-a" })),
    ...Array.from({ length: 30 }, (_, index) => ({ line: 1_001 + index, code: "H7", evidence: "hot-b" }))
  ]
});
assert.equal(hotSplit.length, 6);
assert.ok(hotSplit.every((task) => task.mode === "split" && task.reviewLines.length <= 200));
assert.deepEqual(
  hotSplit.flatMap((task) => task.reviewLines).sort((left, right) => left - right),
  [
    ...Array.from({ length: 500 }, (_, index) => index + 1),
    ...Array.from({ length: 500 }, (_, index) => 1_001 + index)
  ],
  "switching Monte Carlo HOT regions to split review must not silently expand to a full-file review"
);

const signals = [
  { line: 5, code: "H3", evidence: "term" },
  { line: 720, code: "H7", evidence: "meta" }
];
const classified = classifyProofreadRegions({
  totalLines: 1_500,
  signals: [
    ...Array.from({ length: 30 }, (_, index) => ({ line: index + 1, code: "H4", evidence: "hot" })),
    ...Array.from({ length: 10 }, (_, index) => ({ line: 501 + index, code: "H4", evidence: "warm" }))
  ]
});
assert.deepEqual(classified.map((region) => region.tier), ["HOT", "WARM", "COLD"]);
const first = createMontecarloProofreadTasks({
  totalLines: 1_500,
  workerCount: 3,
  sampleSize: 120,
  round: 1,
  signals,
  previouslySampled: new Set()
});

assert.equal(first.length, 3);
const firstLines = first.flatMap((task) => task.sampledLines);
assert.equal(new Set(firstLines).size, firstLines.length, "one round must not assign a line twice");
assert.ok(firstLines.includes(5));
assert.ok(firstLines.includes(720));
assert.ok(first.every((task) => task.mode === "montecarlo" && task.round === 1));
assert.ok(first.every((task) => task.sampledLines.length > 0));

const second = createMontecarloProofreadTasks({
  totalLines: 1_500,
  workerCount: 3,
  sampleSize: 120,
  round: 2,
  signals: [],
  previouslySampled: new Set(firstLines)
});
const secondLines = second.flatMap((task) => task.sampledLines);
assert.equal(secondLines.some((line) => firstLines.includes(line)), false, "later rounds must sample new lines");

const saturatedHot = createMontecarloProofreadTasks({
  totalLines: 1_000,
  workerCount: 2,
  sampleSize: 50,
  round: 2,
  signals: Array.from({ length: 30 }, (_, index) => ({ line: index + 1, code: "H4", evidence: "hot" })),
  previouslySampled: new Set(Array.from({ length: 400 }, (_, index) => index + 1))
});
assert.ok(
  saturatedHot.flatMap((task) => task.sampledLines).every((line) => line > 500),
  "a region with at least 80% semantic coverage must release its quota to unsaturated regions"
);

const denseSignals = Array.from({ length: 40 }, (_, index) => ({
  line: index + 1,
  code: "H4",
  evidence: `signal-${index + 1}`
}));
const dense = createMontecarloProofreadTasks({
  totalLines: 100,
  workerCount: 2,
  sampleSize: 10,
  round: 1,
  signals: denseSignals,
  previouslySampled: new Set()
});
const denseLines = new Set(dense.flatMap((task) => task.sampledLines));
assert.ok(denseSignals.every((signal) => denseLines.has(signal.line)), "the host must never truncate deterministic prescan evidence");

const retired = createMontecarloProofreadTasks({
  totalLines: 10,
  workerCount: 5,
  sampleSize: 5,
  round: 3,
  signals: [],
  previouslySampled: new Set([1, 2, 3, 4, 5, 6, 7, 8])
});
assert.deepEqual(
  retired,
  [],
  "a region retires permanently at 80% coverage instead of re-entering to consume its tail"
);

const absoluteColdRate = createMontecarloProofreadTasks({
  totalLines: 10_000,
  workerCount: 5,
  sampleSize: 3_000,
  round: 1,
  signals: [],
  previouslySampled: new Set()
});
assert.equal(
  absoluteColdRate.flatMap((task) => task.sampledLines).length,
  500,
  "COLD sampling is an absolute 5% rate, not a weight that expands to sampleSize"
);

const tiered = createMontecarloProofreadTasks({
  totalLines: 1_500,
  workerCount: 5,
  sampleSize: 1_500,
  round: 1,
  signals: [
    ...Array.from({ length: 30 }, (_, index) => ({ line: index + 1, code: "H4", evidence: "hot" })),
    ...Array.from({ length: 10 }, (_, index) => ({ line: 501 + index, code: "H4", evidence: "warm" }))
  ],
  previouslySampled: new Set()
});
const tieredLines = tiered.flatMap((task) => task.sampledLines);
assert.equal(tieredLines.filter((line) => line <= 500).length, 150);
assert.equal(tieredLines.filter((line) => line > 500 && line <= 1_000).length, 75);
assert.equal(tieredLines.filter((line) => line > 1_000).length, 25);

console.log("ok Monte Carlo proofreading plans host-owned non-overlapping worker samples");
