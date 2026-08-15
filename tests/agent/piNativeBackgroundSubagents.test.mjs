import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText
} from "@earendil-works/pi-ai";

import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main() {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-background-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo\n", "utf8");

  const models = createModels();
  const childrenStarted = deferred();
  const releaseChildren = deferred();
  let startedCount = 0;
  const providers = new Map();
  for (const providerId of ["child-a", "child-b"]) {
    const provider = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
    models.setProvider(provider.provider);
    providers.set(providerId, provider);
    provider.setResponses([
      async () => {
        startedCount += 1;
        if (startedCount === 2) childrenStarted.resolve();
        await releaseChildren.promise;
        return fauxAssistantMessage(fauxText("Done."));
      }
    ]);
  }

  let running;
  let subagents;
  try {
    const createSubagentModelSelection = async ({ providerId }) => {
      const provider = providers.get(providerId);
      assert.ok(provider, `unexpected provider ${providerId}`);
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    };
    subagents = new YnSubagentSupervisor({
      publishCustomMessage: async () => {},
      createModelSelection: createSubagentModelSelection
    });
    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_background",
        prompt: "translate with two background subagents",
        providerId: "parent",
        modelId: "parent",
        languagePair: "en->zh-CN"
      },
      publishCustomMessage: async () => {},
      createSubagentModelSelection,
      subagents
    });
    const tool = tools.find((entry) => entry.name === "runTranslationSubagents");
    assert.ok(tool, "missing runTranslationSubagents tool");

    running = tool.execute("spawn_background_children", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: "child-a", label: "shard-1" },
        { fromLine: 2, toLine: 2, providerId: "child-b", label: "shard-2" }
      ]
    });
    await childrenStarted.promise;

    const outcome = await Promise.race([
      running.then(
        (result) => ({ kind: "resolved", result }),
        (error) => ({ kind: "rejected", error })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 80))
    ]);

    assert.notEqual(
      outcome.kind,
      "timeout",
      "runTranslationSubagents blocked the parent Pi tool until its child runtimes completed"
    );
    assert.equal(outcome.kind, "resolved");
    assert.equal(outcome.result.details?.status, "running");
    assert.equal(outcome.result.details?.subagents?.length, 2);
  } finally {
    releaseChildren.resolve();
    if (running) await running.catch(() => {});
    if (subagents) await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
}

await main();
console.log("ok runTranslationSubagents returns after two native Pi child runtimes start");

async function childTranscriptStaysInChildJsonl() {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-transcript-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo\n", "utf8");
  const models = createModels();
  const providers = new Map();
  const cards = [];
  const parentNotifications = [];
  for (const [index, providerId] of ["transcript-a", "transcript-b"].entries()) {
    const provider = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
    models.setProvider(provider.provider);
    providers.set(providerId, provider);
    provider.setResponses([
      fauxAssistantMessage({
        type: "toolCall",
        id: `${providerId}-read`,
        name: "readAssignedSource",
        arguments: {}
      }, { stopReason: "toolUse" }),
      fauxAssistantMessage({
        type: "toolCall",
        id: `${providerId}-write`,
        name: "repairAssignedTranslation",
        arguments: {
          entries: [{ line: index + 1, translation: index === 0 ? "一" : "二" }]
        }
      }, { stopReason: "toolUse" }),
      fauxAssistantMessage({
        type: "toolCall",
        id: `${providerId}-validate`,
        name: "validateAssignedTranslation",
        arguments: {}
      }, { stopReason: "toolUse" })
    ]);
  }
  const reviewer = fauxProvider({ provider: "transcript-review", tokensPerSecond: 1000 });
  models.setProvider(reviewer.provider);
  providers.set(reviewer.provider.id, reviewer);
  const bothReviewSubmissionsReady = deferred();
  let reviewSubmissionsReady = 0;
  const reviewResponse = async (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    if (toolResults === 0) {
      return fauxAssistantMessage({
        type: "toolCall",
        id: `review-read-${Math.random()}`,
        name: "readAssignedTranslationReview",
        arguments: {}
      }, { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      reviewSubmissionsReady += 1;
      if (reviewSubmissionsReady === 2) bothReviewSubmissionsReady.resolve();
      await bothReviewSubmissionsReady.promise;
      return fauxAssistantMessage({
        type: "toolCall",
        id: `review-submit-${Math.random()}`,
        name: "submitTranslationReview",
        arguments: { failures: [] }
      }, { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Review accepted."));
  };
  reviewer.setResponses(Array.from({ length: 12 }, () => reviewResponse));
  const createSubagentModelSelection = async ({ providerId }) => {
    const provider = providers.get(providerId);
    assert.ok(provider);
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  };
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async (message) => cards.push(message),
    notifyParent: async (message) => {
      parentNotifications.push(message);
    },
    createModelSelection: createSubagentModelSelection
  });
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  domainRun.recordInspection({
    sourceLineCount: 2,
    documents: [{ id: "source.txt", sourceLineCount: 2 }],
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  try {
    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_child_transcript",
        prompt: "Workflow: yn-translation-v1.",
        providerId: "parent",
        modelId: "parent",
        languagePair: "en->zh-CN",
        workflowIntent: "translation",
        subagentEnabled: true,
        subagentCount: 2,
        subagentProviderId: "transcript-review",
        subagentModelId: reviewer.getModel().id,
        reviewSubagentCount: 2
      },
      publishCustomMessage: async (message) => cards.push(message),
      createSubagentModelSelection,
      subagents,
      domainRun
    });
    const tool = tools.find((entry) => entry.name === "runTranslationSubagents");
    await tool.execute("spawn_transcript_children", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: "transcript-a", label: "shard-1" },
        { fromLine: 2, toLine: 2, providerId: "transcript-b", label: "shard-2" }
      ]
    });
    await subagents.waitForAll();
    const validate = tools.find((entry) => entry.name === "validateTranslationArtifact");
    await validate.execute("validate_parallel_reviews", {});
    const terminalCards = cards.filter((card) => (
      card.customType === "subagent.translation" && card.details?.status === "completed"
    ));
    assert.equal(terminalCards.length, 2);
    const repository = new PiSessionRepository(outputDir);
    for (const card of terminalCards) {
      assert.equal(
        Object.hasOwn(card.details, "transcript"),
        false,
        "the parent card duplicated the complete child transcript"
      );
      assert.ok(JSON.stringify(card).length < 4096, "the parent card exceeded the lightweight card budget");
      const child = await repository.openChild(card.details.subagentId);
      const transcript = (await child.buildContext()).messages;
      assert.ok(transcript.some((message) => message.role === "toolResult"));
      assert.ok(transcript.some((message) => (
        message.role === "assistant"
        && message.content.some((block) => block.type === "toolCall")
      )));
    }
    const reviewCards = cards.filter((card) => (
      card.customType === "subagent.translation-review" && card.details?.status === "completed"
    ));
    const completionNotifications = parentNotifications.filter((message) => (
      message.customType === "subagent-completion"
    ));
    assert.equal(reviewCards.length, 2);
    assert.equal(reviewCards.reduce((sum, card) => sum + card.details.completedAssignments, 0), 2);
    assert.equal(completionNotifications.length, 1);
    assert.equal(completionNotifications[0].role, "custom");
    assert.equal(completionNotifications[0].display, false);
    assert.equal(completionNotifications[0].details.triggerTurn, true);
  } finally {
    subagents.abortAll();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
}

await childTranscriptStaysInChildJsonl();
console.log("ok completed child cards stay lightweight while child Pi JSONL retains the transcript");

async function failedRepairBatchInvalidatesPriorValidation() {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-failed-repair-revision-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
  await writeFile(sourcePath, "one\ntwo\n", "utf8");
  const contract = createYnDomainRunContract({ workflowIntent: "translation" });
  contract.recordInspection({
    sourceLineCount: 2,
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  contract.recordSubagentBatchStarted("translation", "prior-valid-batch", { taskCount: 2, workerCount: 2 });
  contract.recordTranslationArtifactMutation();
  contract.recordSubagentBatch("translation", "prior-valid-batch", 2);
  contract.recordFinalValidation("translation");
  assert.deepEqual(contract.incompleteReasons(), []);

  const models = createModels();
  const providers = new Map();
  const successful = fauxProvider({ provider: "repair-write", tokensPerSecond: 1000 });
  successful.setResponses([
    fauxAssistantMessage({ type: "toolCall", id: "repair-read", name: "readAssignedSource", arguments: {} }, { stopReason: "toolUse" }),
    fauxAssistantMessage({ type: "toolCall", id: "repair-write", name: "repairAssignedTranslation", arguments: { entries: [{ line: 1, translation: "一" }] } }, { stopReason: "toolUse" }),
    fauxAssistantMessage({ type: "toolCall", id: "repair-validate", name: "validateAssignedTranslation", arguments: {} }, { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("repair shard wrote successfully"))
  ]);
  const failing = fauxProvider({ provider: "repair-fail", tokensPerSecond: 1000 });
  failing.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "forced sibling failure after first shard write" });
    }
  ]);
  for (const provider of [successful, failing]) {
    models.setProvider(provider.provider);
    providers.set(provider.provider.id, provider);
  }
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async ({ providerId }) => {
      const provider = providers.get(providerId);
      assert.ok(provider);
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    }
  });
  try {
    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_failed_repair_revision",
        prompt: "repair the existing translation with two background children",
        providerId: "parent",
        modelId: "parent",
        languagePair: "en->zh-CN"
      },
      publishCustomMessage: async () => {},
      subagents,
      domainRun: contract
    });
    const tool = tools.find((entry) => entry.name === "runTranslationSubagents");
    await tool.execute("failed_repair_batch", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: "repair-write", label: "repair-write" },
        { fromLine: 2, toLine: 2, providerId: "repair-fail", label: "repair-fail" }
      ]
    });
    await subagents.waitForAll();
    await assert.rejects(readFile(candidatePath, "utf8"), /ENOENT/);
    assert.notEqual(subagents.list()[0]?.status, "completed");
    assert.ok(
      contract.incompleteReasons().some((reason) => /whole-artifact validation/i.test(reason)),
      "a failed repair batch reused validation from bytes that existed before its partial write"
    );
    assert.ok(
      contract.incompleteReasons().some((reason) => /translation subagents/i.test(reason)),
      "a failed replacement batch reused the prior successful child-batch completion"
    );
  } finally {
    subagents.abortAll();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
}

await failedRepairBatchInvalidatesPriorValidation();
console.log("ok a failed repair batch invalidates validation without committing staged child output");

async function runningChildPublishesNativeTranscriptProgress() {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-live-transcript-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo\n", "utf8");
  const models = createModels();
  const providers = new Map();
  const cards = [];
  const releaseChildren = deferred();
  for (const providerId of ["live-a", "live-b"]) {
    const provider = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
    models.setProvider(provider.provider);
    providers.set(providerId, provider);
    provider.setResponses([
      fauxAssistantMessage({
        type: "toolCall",
        id: `${providerId}-read`,
        name: "readAssignedSource",
        arguments: {}
      }, { stopReason: "toolUse" }),
      async () => {
        await releaseChildren.promise;
        return fauxAssistantMessage(fauxText("Stopped after progress was observed."));
      }
    ]);
  }
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async (message) => cards.push(message),
    createModelSelection: async ({ providerId }) => {
      const provider = providers.get(providerId);
      assert.ok(provider);
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    }
  });
  try {
    subagents.startTranslationBatch({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_child_live_transcript",
        prompt: "translate with observable child progress",
        providerId: "parent",
        modelId: "parent",
        languagePair: "en->zh-CN"
      },
      tasks: [
        { fromLine: 1, toLine: 1, providerId: "live-a", label: "shard-1" },
        { fromLine: 2, toLine: 2, providerId: "live-b", label: "shard-2" }
      ],
      onChunkReadyForReview: async () => ({ accepted: true })
    });
    const startedAt = Date.now();
    let inspections = [];
    while (Date.now() - startedAt < 1000) {
      const children = subagents.list()[0]?.subagents ?? [];
      inspections = await Promise.all(children.map((child) => subagents.inspectTranscript(child.id)));
      if (inspections.length === 2 && inspections.every((entry) => (
        entry.some((message) => message.role === "toolResult")
      ))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(inspections.length, 2);
    assert.ok(
      inspections.every((entry) => entry.some((message) => message.role === "toolResult")),
      "child Pi JSONL did not expose running tool progress on demand"
    );
    const latestCards = new Map();
    for (const card of cards.filter((entry) => entry.details?.status === "running")) {
      latestCards.set(card.details.subagentId, card);
    }
    assert.equal(latestCards.size, 2);
    for (const card of latestCards.values()) {
      assert.equal(Object.hasOwn(card.details, "transcript"), false);
      assert.ok(JSON.stringify(card).length < 4096);
    }
  } finally {
    subagents.abortAll();
    releaseChildren.resolve();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
}

await runningChildPublishesNativeTranscriptProgress();
console.log("ok running child cards stay lightweight while child Pi JSONL exposes live progress on demand");
