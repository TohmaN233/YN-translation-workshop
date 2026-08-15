import assert from "node:assert/strict";
import test from "node:test";

import {
  formatFolderTranslationOrder,
  parseFolderTranslationOrder,
  planFolderTranslationTasks,
  subtractCompletedTranslationRanges
} from "../../src/main/agent/piNative/folderTranslationPlan.ts";

const documents = [
  { id: "tips.txt", path: "C:/book/tips.txt", lineCount: 20 },
  { id: "script.txt", path: "C:/book/script.txt", lineCount: 20_000 },
  { id: "ending.txt", path: "C:/book/ending.txt", lineCount: 40 }
];

test("default folder order puts every sorted filename in one parallel group", () => {
  assert.equal(formatFolderTranslationOrder(["tips.txt", "script.txt", "ending.txt"]), [
    "{",
    '"ending.txt"',
    '"script.txt"',
    '"tips.txt"',
    "}"
  ].join("\n"));
  assert.deepEqual([...parseFolderTranslationOrder(undefined, documents.map((document) => document.id))], [
    ["ending.txt", 0],
    ["script.txt", 0],
    ["tips.txt", 0]
  ]);
});

test("files before and after braces become strict ordered stages", () => {
  const stages = parseFolderTranslationOrder([
    '"tips.txt"',
    "{",
    '"script.txt"',
    "}",
    '"ending.txt"'
  ].join("\n"), documents.map((document) => document.id));
  assert.deepEqual([...stages], [["tips.txt", 0], ["script.txt", 1], ["ending.txt", 2]]);
});

test("folder order rejects unknown and duplicate files but treats omissions as explicit skips", () => {
  assert.throws(() => parseFolderTranslationOrder('{\n"unknown.txt"\n}', ["a.txt"]), /unknown file/i);
  assert.throws(() => parseFolderTranslationOrder('{\n"a.txt"\n"a.txt"\n}', ["a.txt"]), /more than once/i);
  assert.deepEqual(
    [...parseFolderTranslationOrder('{\n"a.txt"\n}', ["a.txt", "b.txt"])],
    [["a.txt", 0]]
  );
  assert.throws(() => parseFolderTranslationOrder("{\n}", ["a.txt"]), /at least one file/i);
});

test("omitted folder files never receive translation assignments", () => {
  const tasks = planFolderTranslationTasks({
    documents,
    splitSize: 2_000,
    order: '{\n"tips.txt"\n"ending.txt"\n}'
  });
  assert.deepEqual([...new Set(tasks.map((task) => task.documentId))], ["ending.txt", "tips.txt"]);
  assert.equal(tasks.some((task) => task.documentId === "script.txt"), false);
});

test("large files become line-balanced host tasks at the configured split size", () => {
  const tasks = planFolderTranslationTasks({ documents, splitSize: 2_000 });
  const scriptTasks = tasks.filter((task) => task.documentId === "script.txt");
  assert.equal(scriptTasks.length, 10);
  assert.deepEqual(scriptTasks.map(({ fromLine, toLine }) => [fromLine, toLine]), [
    [1, 2000], [2001, 4000], [4001, 6000], [6001, 8000], [8001, 10000],
    [10001, 12000], [12001, 14000], [14001, 16000], [16001, 18000], [18001, 20000]
  ]);
});

test("single-line folder files remain inside the host-owned ordered queue", () => {
  const tasks = planFolderTranslationTasks({
    documents: [
      { id: "tip.txt", path: "C:/book/tip.txt", lineCount: 1 },
      { id: "script.txt", path: "C:/book/script.txt", lineCount: 3 }
    ],
    splitSize: 2,
    order: '"tip.txt"\n{\n"script.txt"\n}'
  });
  assert.deepEqual(tasks.map((task) => [task.documentId, task.fromLine, task.toLine, task.scheduleStage]), [
    ["tip.txt", 1, 1, 0],
    ["script.txt", 1, 2, 1],
    ["script.txt", 3, 3, 1]
  ]);
});

test("resume removes only accepted ranges and never restarts completed folder work", () => {
  const tasks = planFolderTranslationTasks({
    documents: [{ id: "script.txt", path: "C:/book/script.txt", lineCount: 2_500 }],
    splitSize: 1_000
  });
  const remaining = subtractCompletedTranslationRanges(tasks, new Map([
    ["script.txt", [
      { fromLine: 1, toLine: 1_000 },
      { fromLine: 1_501, toLine: 2_500 }
    ]]
  ]));
  assert.deepEqual(
    remaining.map((task) => [task.documentId, task.fromLine, task.toLine]),
    [["script.txt", 1_001, 1_500]],
    "only the unresolved gap may be dispatched after review evidence is restored"
  );
});
