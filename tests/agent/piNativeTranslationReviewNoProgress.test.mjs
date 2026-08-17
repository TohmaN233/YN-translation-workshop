import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";
import {
  MAX_ASSIGNED_TRANSLATION_REPAIR_TURNS,
  MAX_TRANSLATION_REVIEW_REPAIR_CYCLES
} from "../../src/main/agent/piNative/subagentRunner.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { ParentTakeoverAssignmentError } from "../../src/main/agent/piNative/assignmentFailure.ts";

function translationTurn(prefix, translatedText, repair = false) {
  const turn = [
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `${prefix}-read` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall(repair ? "repairAssignedTranslation" : "writeAssignedTranslation", repair
      ? { entries: [{ line: 1, translation: translatedText }] }
      : { blocks: [{ id: "0", lines: [`0${translatedText}`] }] }, { id: `${prefix}-write` }), { stopReason: "toolUse" })
  ];
  if (!repair) {
    turn.push(fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
      id: `${prefix}-validate`
    }), { stopReason: "toolUse" }));
  }
  return turn;
}

async function runSupervisorScenario({
  name,
  responses,
  review,
  parentCompletionContext,
  onParentTakeover,
  onSettled,
  sourceText = "first line\n",
  tasks = [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
  languagePair = "en->zh-CN"
}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), `yn-pi-translation-${name}-`));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, sourceText, "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: name, tokensPerSecond: 10_000 });
  models.setProvider(provider.provider);
  provider.setResponses(responses);
  const parentMessages = [];
  const supervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    publishLiveCustomMessage: async () => {},
    notifyParent: async (message) => parentMessages.push(message),
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    })
  });
  const checkpointPaths = [];
  try {
    supervisor.startTranslationBatch({
      request: {
        outputDir,
        sourcePath,
        sessionId: name,
        prompt: "translate the assigned line",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair
      },
      tasks,
      maxWorkers: 1,
      onChunkReadyForReview: review,
      onStagingCandidateCheckpoint: async (checkpoint) => {
        checkpointPaths.push(checkpoint.candidatePath);
      },
      onParentTakeover: onParentTakeover
        ? async (details) => onParentTakeover(details, supervisor)
        : undefined,
      onSettled: onSettled
        ? async (outcome) => onSettled(outcome, supervisor)
        : undefined,
      parentCompletionContext
    });
    await supervisor.waitForAll();
    let retainedStagingText;
    const checkpointPath = checkpointPaths.at(-1);
    if (checkpointPath) {
      try {
        retainedStagingText = await readFile(checkpointPath, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return { batch: supervisor.list()[0], parentMessages, retainedStagingText };
  } finally {
    supervisor.abortAll();
    await supervisor.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
}

let unexpectedMechanicalAssignmentRetryCalls = 0;
const mechanicalNoProgressResponses = [
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, {
    id: "mechanical-read"
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [
      { line: 1, translation: "第一行" },
      { line: 2, translation: "シントー" }
    ]
  }, { id: "mechanical-initial-write" }), { stopReason: "toolUse" }),
  ...Array.from({ length: MAX_ASSIGNED_TRANSLATION_REPAIR_TURNS }, (_, index) => (
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: [{ line: 2, translation: "シントー" }]
    }, { id: `mechanical-invalid-repair-${index + 1}` }), { stopReason: "toolUse" })
  )),
  ...Array.from({ length: 8 }, () => async () => {
    unexpectedMechanicalAssignmentRetryCalls += 1;
    return fauxAssistantMessage(fauxText("The Host incorrectly restarted the complete assignment."));
  })
];
const mechanicalNoProgressRun = await runSupervisorScenario({
  name: "mechanical-no-progress",
  sourceText: "first line\nシントー\n",
  languagePair: "ja->zh-CN",
  tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 2 }],
  responses: mechanicalNoProgressResponses,
  review: async () => {
    throw new Error("mechanically rejected staging must not reach the review worker");
  }
});
const mechanicalNoProgressBatch = mechanicalNoProgressRun.batch;
assert.equal(mechanicalNoProgressBatch.status, "failed");
assert.equal(
  mechanicalNoProgressBatch.subagents[0].assignmentCount,
  1,
  "mechanical repair exhaustion must not restart the complete assignment"
);
assert.equal(unexpectedMechanicalAssignmentRetryCalls, 0);
assert.equal(mechanicalNoProgressBatch.subagents[0].failureDisposition, "parent_takeover_required");
assert.deepEqual(mechanicalNoProgressBatch.subagents[0].parentTakeovers?.[0]?.rejectedLines, [2]);
assert.match(mechanicalNoProgressBatch.subagents[0].parentTakeovers?.[0]?.feedback || "", /likely_untranslated/i);
assert.equal(
  mechanicalNoProgressRun.retainedStagingText,
  "第一行\n\n",
  "the valid part of the hash-current staging candidate must survive parent takeover"
);

let unchangedReviewCalls = 0;
const unchangedRun = await runSupervisorScenario({
  name: "review-no-progress",
  responses: [
    ...translationTurn("initial", "第一句"),
    ...translationTurn("unchanged-repair", "第一句", true)
  ],
  review: async () => {
    unchangedReviewCalls += 1;
    if (unchangedReviewCalls > 2) throw new Error("review loop exceeded the no-progress boundary");
    return {
      accepted: false,
      feedback: [{
        line: 1,
        reason: "semantic_incomplete: translate the omitted meaning from source line 1"
      }]
    };
  }
});
const unchangedBatch = unchangedRun.batch;
assert.equal(unchangedBatch.status, "failed");
assert.match(unchangedBatch.error, /review repair made no candidate progress.*L1/i);
assert.equal(unchangedReviewCalls, 2, "an unchanged rejected candidate must not be submitted a third time");
assert.equal(
  unchangedBatch.subagents[0].assignmentCount,
  1,
  "the supervisor must not restart a non-retryable no-progress assignment"
);
assert.equal(unchangedBatch.subagents[0].failureDisposition, "parent_takeover_required");
assert.equal(unchangedRun.parentMessages.length, 1);
assert.match(unchangedRun.parentMessages[0].content, /exact retained evidence/i);
assert.match(unchangedRun.parentMessages[0].content, /Host could not complete the parent takeover handoff/i);
assert.doesNotMatch(unchangedRun.parentMessages[0].content, /explicit user continuation/i);
assert.equal(
  unchangedRun.parentMessages[0].details?.failureDisposition,
  "parent_takeover_required"
);
assert.deepEqual(unchangedBatch.subagents[0].parentTakeovers?.[0]?.rejectedLines, [1]);
assert.equal(unchangedBatch.subagents[0].parentTakeovers?.[0]?.documentId, "source.txt");

let changedReviewCalls = 0;
const changedRun = await runSupervisorScenario({
  name: "review-changed-cap",
  responses: [
    ...translationTurn("initial", "第一版译文"),
    ...translationTurn("changed-repair-1", "第二版译文", true),
    ...translationTurn("changed-repair-2", "第三版译文", true),
    ...translationTurn("changed-repair-3", "第四版译文", true)
  ],
  review: async () => {
    changedReviewCalls += 1;
    return {
      accepted: false,
      feedback: [{
        line: 1,
        reason: changedReviewCalls === MAX_TRANSLATION_REVIEW_REPAIR_CYCLES + 1
          ? "semantic_final: restore the exact final clause from source line 1"
          : `semantic_attempt_${changedReviewCalls}: repair the source meaning on line 1`
      }]
    };
  },
  parentCompletionContext: () => ({
    content: "Host parent takeover is ready.",
    details: { parentTakeoverReady: true, parentTakeovers: [{ documentId: "source.txt", rejectedLines: [1] }] }
  })
});
const changedBatch = changedRun.batch;
assert.equal(changedBatch.status, "failed");
assert.equal(changedReviewCalls, MAX_TRANSLATION_REVIEW_REPAIR_CYCLES + 1);
assert.match(changedBatch.error, /did not pass after 3 changed candidate attempts/i);
assert.match(changedBatch.error, /L1 semantic_final: restore the exact final clause/i);
assert.equal(
  changedBatch.subagents[0].assignmentCount,
  1,
  "the supervisor must not restart a changed-candidate assignment after its bounded review budget is exhausted"
);
assert.equal(changedBatch.subagents[0].failureDisposition, "parent_takeover_required");
assert.match(changedRun.parentMessages[0].content, /Continue now without asking the user/i);
assert.match(changedRun.parentMessages[0].content, /repair only those rows through writeTranslationChunk/i);
assert.doesNotMatch(changedRun.parentMessages[0].content, /explicit user continuation/i);

const malformedRun = await runSupervisorScenario({
  name: "review-malformed-rejection",
  responses: translationTurn("initial", "第一句"),
  review: async () => ({ accepted: false, feedback: [] })
});
assert.equal(malformedRun.batch.status, "failed");
assert.equal(malformedRun.batch.subagents[0].failureDisposition, undefined);
assert.equal(malformedRun.batch.subagents[0].parentTakeovers, undefined);
assert.doesNotMatch(malformedRun.parentMessages[0].content, /parent Agent now owns the exact rejected lines/i);
assert.match(malformedRun.parentMessages[0].content, /wait for an explicit user continuation/i);

const accumulatedParentMessages = [];
const accumulatedSupervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  notifyParent: async (message) => accumulatedParentMessages.push(message)
});
let accumulatedWorkerGeneration = 0;
const accumulatedWorkerEvents = [];
const accumulatedCompletedLines = [];
accumulatedSupervisor.startBatch({
  kind: "translation",
  request: {
    outputDir: os.tmpdir(),
    sourcePath: path.join(os.tmpdir(), "source.txt"),
    sessionId: "review-parent-takeover-aggregation",
    prompt: "translate assigned ranges",
    providerId: "test",
    modelId: "test",
    languagePair: "en->zh-CN"
  },
  tasks: [
    { documentId: "source.txt", fromLine: 1, toLine: 1 },
    { documentId: "source.txt", fromLine: 2, toLine: 2 }
  ],
  maxWorkers: 1,
  label: (task) => `L${task.fromLine}`,
  range: (task) => task,
  documentId: (task) => task.documentId,
  createWorker: async () => {
    const generation = ++accumulatedWorkerGeneration;
    accumulatedWorkerEvents.push(`create-${generation}`);
    return {
      run: async (task) => {
        if (generation === 1) {
          throw new ParentTakeoverAssignmentError(
            `review rejected L${task.fromLine}`,
            {
              documentId: task.documentId,
              fromLine: task.fromLine,
              toLine: task.toLine,
              rejectedLines: [task.fromLine],
              feedback: `L${task.fromLine} must be repaired by the parent`
            }
          );
        }
        accumulatedCompletedLines.push(task.fromLine);
        return { line: task.fromLine };
      },
      finish: async () => accumulatedWorkerEvents.push(`finish-${generation}`),
      dispose: async () => accumulatedWorkerEvents.push(`dispose-${generation}`)
    };
  },
  run: async () => {
    throw new Error("persistent worker was not used");
  }
});
await accumulatedSupervisor.waitForAll();
const [accumulatedBatch] = accumulatedSupervisor.list();
assert.equal(
  accumulatedBatch.subagents[0].assignmentCount,
  1,
  "a worker whose current assignment exhausted its repair budget must stop before claiming another assignment"
);
assert.equal(
  accumulatedBatch.subagents.length,
  2,
  "the supervisor must replace the exhausted child while reserved assignments remain"
);
assert.equal(accumulatedBatch.subagents[1].assignmentCount, 1);
assert.equal(accumulatedBatch.subagents[1].completedAssignments, 1);
assert.deepEqual(accumulatedCompletedLines, [2]);
assert.ok(
  accumulatedWorkerEvents.indexOf("dispose-1") < accumulatedWorkerEvents.indexOf("create-2"),
  "the exhausted child must be fully disposed before its replacement runtime starts"
);
assert.deepEqual(
  accumulatedBatch.subagents[0].parentTakeovers?.map((entry) => entry.rejectedLines),
  [[1]],
  "the stopped worker must preserve the exact failed assignment identity"
);
assert.deepEqual(
  accumulatedParentMessages[0].details?.parentTakeovers?.map((entry) => entry.rejectedLines),
  [[1]],
  "the hidden parent completion must report only the failed assignment owned by that worker"
);
assert.equal(accumulatedParentMessages[0].details?.triggerTurn, true);

{
  const events = [];
  let conflictDuringTakeover;
  const takeoverRun = await runSupervisorScenario({
    name: "review-takeover-before-settle",
    responses: [
      ...translationTurn("initial", "第一句"),
      ...translationTurn("unchanged-repair", "第一句", true)
    ],
    review: async () => ({
      accepted: false,
      feedback: [{
        line: 1,
        reason: "semantic_incomplete: translate the omitted meaning from source line 1"
      }]
    }),
    onParentTakeover: async () => {
      events.push("takeover");
    },
    onSettled: async (_outcome, supervisor) => {
      events.push("settled");
      conflictDuringTakeover = supervisor.hasWriteConflict({
        documentId: "source.txt",
        fromLine: 1,
        toLine: 1
      });
    }
  });
  assert.deepEqual(events, ["takeover", "settled"]);
  assert.equal(
    conflictDuringTakeover,
    false,
    "the taken-over range must leave the live child write lock before the batch settles"
  );
  assert.equal(takeoverRun.batch.subagents[0].failureDisposition, "parent_takeover_required");
}

console.log("ok translation review no-progress and changed-candidate limits terminate through the supervisor");
