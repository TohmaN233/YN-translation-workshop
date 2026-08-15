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
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

function tracked(timeline, label, message, inspect) {
  return async (context) => {
    inspect?.(context);
    timeline.push(label);
    return message;
  };
}

function contextText(context) {
  return [context.systemPrompt, ...context.messages.flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text);
  })].join("\n");
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-translation-review-gate-"));
const sourcePath = path.join(outputDir, "source.txt");
const timeline = [];
const translatorSelectionIds = [];
const reviewerSelectionIds = [];
const liveCards = [];

try {
  await writeFile(sourcePath, "first line\nsecond line\n", "utf8");

  const models = createModels();
  const translator = fauxProvider({ provider: "review-gate-translator", tokensPerSecond: 10_000 });
  const reviewer = fauxProvider({ provider: "review-gate-reviewer", tokensPerSecond: 10_000 });
  models.setProvider(translator.provider);
  models.setProvider(reviewer.provider);

  const unreviewedSupervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    publishLiveCustomMessage: async () => {},
    createModelSelection: async () => {
      throw new Error("an unreviewed translation batch must fail before selecting a model");
    }
  });
  assert.throws(
    () => unreviewedSupervisor.startTranslationBatch({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_translation_review_gate_missing",
        prompt: "this batch must not start",
        providerId: translator.provider.id,
        modelId: translator.getModel().id,
        languagePair: "en->zh-CN"
      },
      tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
      maxWorkers: 1
    }),
    /require a read-only review worker gate/i
  );
  assert.deepEqual(unreviewedSupervisor.list(), [], "the rejected batch left an active supervisor entry");

  translator.setResponses([
    tracked(timeline, "translator:L1:read", fauxAssistantMessage(
      fauxToolCall("readAssignedSource", {}, { id: "translator-l1-read" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "translator:L1:write-initial", fauxAssistantMessage(
      fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 1, translation: "第一句" }]
      }, { id: "translator-l1-write" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "translator:L1:validate-initial", fauxAssistantMessage(
      fauxToolCall("validateAssignedTranslation", {}, { id: "translator-l1-validate" }),
      { stopReason: "toolUse" }
    )),
    tracked(
      timeline,
      "translator:L1:repair-read",
      fauxAssistantMessage(
        fauxToolCall("readAssignedSource", { fromLine: 1, toLine: 1 }, { id: "translator-l1-repair-read" }),
        { stopReason: "toolUse" }
      ),
      (context) => assert.match(
        contextText(context),
        /L1: semantic meaning is incomplete/i,
        "the same translator did not receive the review worker's exact rejection"
      )
    ),
    tracked(timeline, "translator:L1:repair-write", fauxAssistantMessage(
      fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 1, translation: "第一行" }]
      }, { id: "translator-l1-repair-write" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "translator:L2:read", fauxAssistantMessage(
      fauxToolCall("readAssignedSource", {}, { id: "translator-l2-read" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "translator:L2:write", fauxAssistantMessage(
      fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 2, translation: "第二行" }]
      }, { id: "translator-l2-write" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "translator:L2:validate", fauxAssistantMessage(
      fauxToolCall("validateAssignedTranslation", {}, { id: "translator-l2-validate" }),
      { stopReason: "toolUse" }
    ))
  ]);

  reviewer.setResponses([
    tracked(timeline, "reviewer:L1:first-read", fauxAssistantMessage(
      fauxToolCall("readAssignedTranslationReview", {}, { id: "reviewer-l1-read-1" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "reviewer:L1:reject", fauxAssistantMessage(
      fauxToolCall("submitTranslationReview", {
        failures: [{ line: 1, code: "semantic_incomplete", note: "semantic meaning is incomplete" }]
      }, { id: "reviewer-l1-reject" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "reviewer:L1:second-read", fauxAssistantMessage(
      fauxToolCall("readAssignedTranslationReview", {}, { id: "reviewer-l1-read-2" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "reviewer:L1:accept", fauxAssistantMessage(
      fauxToolCall("submitTranslationReview", { failures: [] }, { id: "reviewer-l1-accept" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "reviewer:L2:read", fauxAssistantMessage(
      fauxToolCall("readAssignedTranslationReview", {}, { id: "reviewer-l2-read" }),
      { stopReason: "toolUse" }
    )),
    tracked(timeline, "reviewer:L2:accept", fauxAssistantMessage(
      fauxToolCall("submitTranslationReview", { failures: [] }, { id: "reviewer-l2-accept" }),
      { stopReason: "toolUse" }
    ))
  ]);

  const request = {
    outputDir,
    sourcePath,
    sessionId: "pi_translation_review_gate",
    prompt: "translate two queued chunks",
    providerId: translator.provider.id,
    modelId: translator.getModel().id,
    subagentProviderId: reviewer.provider.id,
    subagentModelId: reviewer.getModel().id,
    languagePair: "en->zh-CN"
  };
  const supervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    publishLiveCustomMessage: async (message) => { liveCards.push(message); },
    notifyParent: async () => {},
    createModelSelection: async ({ providerId }) => {
      if (providerId === reviewer.provider.id) {
        reviewerSelectionIds.push(providerId);
        return {
          models,
          model: reviewer.getModel(),
          providerId: reviewer.provider.id,
          modelId: reviewer.getModel().id
        };
      }
      assert.equal(providerId, translator.provider.id);
      translatorSelectionIds.push(providerId);
      return {
        models,
        model: translator.getModel(),
        providerId: translator.provider.id,
        modelId: translator.getModel().id
      };
    }
  });

  supervisor.startTranslationBatch({
    request,
    tasks: [
      { documentId: "source.txt", fromLine: 1, toLine: 1, providerId: translator.provider.id },
      { documentId: "source.txt", fromLine: 2, toLine: 2, providerId: translator.provider.id }
    ],
    maxWorkers: 1,
    reviewWorkerCount: 1,
    prepareChunkReview: async (review) => {
      assert.equal(review.validation.ok, true, "review began before mechanical validation passed");
      timeline.push(`mechanical:L${review.fromLine}`);
      const sourceLines = (await readFile(sourcePath, "utf8")).trimEnd().split("\n");
      const translationLines = (await readFile(review.candidatePath, "utf8")).trimEnd().split("\n");
      const task = {
        auditId: `audit-L${review.fromLine}-${timeline.length}`,
        documentId: review.documentId,
        fromLine: review.fromLine,
        toLine: review.toLine,
        riskLineCount: 1,
        sampledLineCount: 0
      };
      return {
        task,
        read: async () => ({
          auditId: task.auditId,
          documentId: task.documentId,
          fromLine: task.fromLine,
          toLine: task.toLine,
          riskLineCount: task.riskLineCount,
          sampledLineCount: task.sampledLineCount,
          windows: [{
            fromLine: task.fromLine,
            toLine: task.toLine,
            rows: [{
              line: task.fromLine,
              source: sourceLines[task.fromLine - 1],
              translation: translationLines[task.fromLine - 1],
              selected: true,
              signals: ["deterministic_sample"]
            }]
          }]
        }),
        submit: async (_task, failures) => {
          const rejected = failures.length > 0;
          if (rejected) task.riskLineCount += failures.length;
          timeline.push(`decision:L${task.fromLine}:${rejected ? "reject" : "accept"}`);
          return rejected
            ? {
                accepted: false,
                feedback: failures.map((failure) => ({
                  line: failure.line,
                  reason: failure.note || failure.code
                }))
              }
            : { accepted: true };
        }
      };
    }
  });

  await supervisor.waitForAll();

  const translationBatch = supervisor.list().find((batch) => batch.kind === "translation");
  const reviewBatch = supervisor.list().find((batch) => batch.kind === "translation-review");
  assert.ok(translationBatch);
  assert.ok(reviewBatch);
  assert.equal(translationBatch.status, "completed");
  assert.equal(reviewBatch.status, "completed");
  assert.equal(reviewBatch.subagents.length, 1);
  const reviewContext = await (await new PiSessionRepository(outputDir)
    .openChild(reviewBatch.subagents[0].id)).buildContext();
  const reviewRead = reviewContext.messages.find((message) => (
    message.role === "toolResult" && message.toolName === "readAssignedTranslationReview"
  ));
  assert.equal(
    reviewRead?.details?.projectReferences?.approvedGlossary?.path,
    ".translation-workshop/glossary.json",
    "reviewers need the same canonical indexed-reference paths as translators"
  );
  assert.equal(translationBatch.subagents.length, 1);
  assert.equal(translationBatch.subagents[0].assignmentCount, 2);
  assert.equal(translationBatch.subagents[0].completedAssignments, 2);
  assert.equal(translatorSelectionIds.length, 1, "the rejected chunk was handed to a new translator runtime");
  assert.equal(reviewerSelectionIds.length, 1, "the review pool did not retain its reviewer worker");
  assert.ok(
    liveCards.some((message) => (
      message.customType === "subagent.translation-review"
      && message.details?.activity === "repair requested"
      && message.details?.riskLineCount === 2
    )),
    "the reviewer card must publish updated risk telemetry immediately after a context failure is promoted"
  );

  const index = (label) => {
    const value = timeline.indexOf(label);
    assert.notEqual(value, -1, `missing lifecycle event ${label}: ${timeline.join(" -> ")}`);
    return value;
  };
  assert.ok(index("translator:L1:validate-initial") < index("mechanical:L1"));
  assert.ok(index("mechanical:L1") < index("decision:L1:reject"));
  assert.ok(index("decision:L1:reject") < index("translator:L1:repair-read"));
  assert.ok(index("translator:L1:repair-write") < timeline.lastIndexOf("mechanical:L1"));
  assert.ok(timeline.lastIndexOf("mechanical:L1") < index("decision:L1:accept"));
  assert.ok(
    index("decision:L1:accept") < index("translator:L2:read"),
    `assignment 2 started before assignment 1 passed review: ${timeline.join(" -> ")}`
  );
  assert.ok(index("translator:L2:validate") < index("mechanical:L2"));
  assert.ok(index("mechanical:L2") < index("decision:L2:accept"));
  assert.equal(
    await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
    "第一行\n第二行\n"
  );

  console.log("ok translation worker cannot claim the next chunk until mechanical and reviewer gates accept the current chunk");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
