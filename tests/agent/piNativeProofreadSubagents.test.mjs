import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import {
  createProofreadHostState,
  proofreadDocumentHostState
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import {
  createPiProofreadSubagentTools,
  runPiProofreadSubagent
} from "../../src/main/agent/piNative/subagentRunner.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { writeProofreadFindings } from "../../src/main/agent/writeProofreadFindings.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
    if (error instanceof AggregateError) {
      for (const cause of error.errors) {
        console.log(`  caused by: ${cause && cause.stack ? cause.stack : cause}`);
      }
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assignmentToolResultCount(messages) {
  const assignmentStart = messages.findLastIndex((message) => message.role === "user");
  return messages
    .slice(assignmentStart + 1)
    .filter((message) => message.role === "toolResult")
    .length;
}

function resultPayload(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return JSON.parse(text);
}

async function fixture(extraContext = {}) {
  const {
    sourceText = "こんにちは\nさようなら\n猫\n犬\n",
    translationText = "你好\n再见\n猫\n狗\n",
    proofreadSplitSize,
    ...domainContext
  } = extraContext;
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-subagent-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, sourceText, "utf8");
  await mkdir(path.join(outputDir, "AI_translation"), { recursive: true });
  await writeFile(
    path.join(outputDir, "AI_translation", "source_translated.txt"),
    translationText,
    "utf8"
  );
  const request = {
    outputDir,
    sourcePath,
    sessionId: "pi_proofread_subagents",
    prompt: "proofread with two subagents",
    workflowIntent: "proofread",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    proofreadMode: "split",
    subagentEnabled: true,
    subagentCount: 2,
    proofreadSplitSize: proofreadSplitSize ?? 2
  };
  const publishCustomMessage = domainContext.publishCustomMessage ?? (async () => {});
  const subagents = domainContext.subagents ?? new YnSubagentSupervisor({
    publishCustomMessage,
    createModelSelection: domainContext.createSubagentModelSelection
  });
  const domainRun = domainContext.domainRun ?? createYnDomainRunContract({
    workflowIntent: "proofread",
    proofreadMode: request.proofreadMode,
    subagentEnabled: request.subagentEnabled,
    subagentCount: request.subagentCount
  });
  const tools = createYnDomainTools({ request, publishCustomMessage, subagents, ...domainContext, domainRun });
  if (domainContext.skipProofreadPrescan !== true) {
    const inspect = tools.find((entry) => entry.name === "inspectTranslationContext");
    await inspect.execute("fixture_proofread_prescan", {});
  }
  return {
    outputDir,
    request,
    tools,
    subagents,
    domainRun,
    tool(name) {
      const value = tools.find((entry) => entry.name === name);
      assert.ok(value, `missing tool ${name}`);
      return value;
    },
    async close() {
      if (typeof subagents.dispose === "function") await subagents.dispose();
      await rm(outputDir, { recursive: true, force: true });
    }
  };
}

await test("proofread workers cannot start before the Host completes a hash-bound deterministic prescan", async () => {
  let starts = 0;
  let plannedTasks = [];
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch({ tasks, maxWorkers }) {
      starts += 1;
      plannedTasks = tasks;
      assert.equal(maxWorkers, 1);
      return { id: "batch_prescan_contract", status: "running", subagents: [] };
    }
  };
  const fx = await fixture({ subagents, skipProofreadPrescan: true });
  try {
    await assert.rejects(
      () => fx.tool("runProofreadSubagents").execute("run_without_prescan", {}),
      /deterministic prescan|inspectTranslationContext.*proofread/i
    );
    assert.equal(starts, 0, "a child batch started before deterministic preprocessing completed");

    const inspected = await fx.tool("inspectTranslationContext").execute("proofread_prescan", {});
    assert.equal(inspected.details.proofreadPrescan.completed, true);
    assert.equal(inspected.details.proofreadPrescan.totalLines, 4);
    assert.equal(inspected.details.proofreadPrescan.countsByCode.H4, 0);
    assert.equal(inspected.details.proofreadPrescan.recommendedWorkerCount, 1);

    await writeFile(
      path.join(fx.outputDir, "AI_translation", "source_translated.txt"),
      "你好\n再见\n猫\nTranslation: placeholder.\n",
      "utf8"
    );
    await assert.rejects(
      () => fx.tool("runProofreadSubagents").execute("run_stale_prescan", {}),
      /changed after the deterministic prescan|run inspectTranslationContext/i
    );
    assert.equal(starts, 0, "a child batch started from a stale deterministic scan");

    await mkdir(path.join(fx.outputDir, ".translation-workshop"), { recursive: true });
    await writeFile(
      path.join(fx.outputDir, ".translation-workshop", "style_guide.md"),
      "# Style Guide\n\nForbidden terms: forbidden-after-scan\n",
      "utf8"
    );
    const rescanned = await fx.tool("inspectTranslationContext").execute("proofread_rescan", {});
    assert.ok(rescanned.details.proofreadPrescan.countsByCode.H7 > 0);
    await writeFile(
      path.join(fx.outputDir, ".translation-workshop", "style_guide.md"),
      "# Style Guide\n\nForbidden terms: changed-again\n",
      "utf8"
    );
    await assert.rejects(
      () => fx.tool("runProofreadSubagents").execute("run_stale_asset_prescan", {}),
      /assets changed|deterministic prescan|run inspectTranslationContext/i
    );
    await fx.tool("inspectTranslationContext").execute("proofread_asset_rescan", {});
    const started = await fx.tool("runProofreadSubagents").execute("run_after_prescan", {});
    assert.equal(started.details.status, "running");
    assert.equal(starts, 1);
    assert.equal(plannedTasks.length, 2);
    assert.ok(plannedTasks[1].deterministicSignals.some((signal) => signal.code === "H7" && signal.line === 4));
  } finally {
    await fx.close();
  }
});

await test("split proofreading resumes only hash-current unfinished ranges and checkpoints each accepted assignment", async () => {
  const proofreadState = createProofreadHostState();
  let batchOptions;
  let persistCalls = 0;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(options) {
      batchOptions = options;
      return { id: options.batchId, status: "running", subagents: [{ id: "proof-worker" }] };
    }
  };
  const fx = await fixture({
    sourceText: "one\ntwo\nthree\nfour\nfive\nsix\n",
    translationText: "一\n二\n三\n四\n五\n六\n",
    proofreadSplitSize: 2,
    proofreadState,
    subagents,
    persistHostState: async () => { persistCalls += 1; }
  });
  try {
    const document = proofreadDocumentHostState(proofreadState, "source.txt");
    document.completedSplitScopes = [{
      inputHash: document.prescan.inputHash,
      translationPath: document.prescan.translationPath,
      fromLine: 1,
      toLine: 2
    }, {
      inputHash: "stale-input-hash",
      translationPath: document.prescan.translationPath,
      fromLine: 5,
      toLine: 6
    }];

    const started = await fx.tool("runProofreadSubagents").execute("resume_split_ranges", { workerCount: 1 });
    assert.equal(started.details.assignmentCount, 2);
    assert.deepEqual(batchOptions.tasks.map((task) => [task.fromLine, task.toLine]), [[3, 4], [5, 6]]);

    await batchOptions.onTaskCompleted({
      findingsWritten: 0,
      glossaryCandidates: [{
        source: "three",
        target: "三",
        category: "setting_term",
        evidenceLine: 3,
        rationale: "Pending cross-assignment evidence sentinel."
      }]
    }, batchOptions.tasks[0]);
    assert.ok(document.completedSplitScopes.some((scope) => (
      scope.inputHash === document.prescan.inputHash
      && scope.fromLine === 1
      && scope.toLine === 4
    )));
    assert.ok(persistCalls > 0, "accepted proofreading scope was not durably checkpointed");
    const pending = batchOptions.pendingGlossaryCandidatesForTask(batchOptions.tasks[1]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].source, "three");
    const pendingTools = createPiProofreadSubagentTools({
      request: fx.request,
      task: batchOptions.tasks[0],
      pendingProofreadGlossaryCandidates: pending,
      publishCustomMessage: async () => {}
    }, "pending_candidate_reader", {
      referenceRead: false,
      findingsWritten: false,
      findingsCount: 0
    });
    const pendingContext = await pendingTools
      .find((tool) => tool.name === "readAssignedProofreadContext")
      .execute("read_pending_candidate", {});
    assert.equal(pendingContext.details.pendingProofreadGlossaryCandidates.length, 1);
    assert.equal(pendingContext.details.pendingProofreadGlossaryCandidates[0].canonical, false);
  } finally {
    await fx.close();
  }
});

await test("fully checkpointed split scopes reconcile completion without launching empty workers", async () => {
  const proofreadState = createProofreadHostState();
  let starts = 0;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch() {
      starts += 1;
      throw new Error("no worker should start for fully accepted scopes");
    }
  };
  const fx = await fixture({ proofreadState, subagents });
  try {
    const document = proofreadDocumentHostState(proofreadState, "source.txt");
    document.completedSplitScopes = [{
      inputHash: document.prescan.inputHash,
      translationPath: document.prescan.translationPath,
      fromLine: 1,
      toLine: 4
    }];
    const report = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [path.join(fx.outputDir, "source.txt")],
      documentId: "source.txt",
      translationPath: path.join(fx.outputDir, "AI_translation", "source_translated.txt"),
      kind: "findings_json",
      mode: "split",
      content: "[]"
    });
    assert.equal(report.ok, true, report.error);
    fx.domainRun.recordProofreadArtifactMutation("source.txt");

    const resumed = await fx.tool("runProofreadSubagents").execute("reconcile_complete_scopes", { workerCount: 1 });
    assert.equal(resumed.details.status, "already_complete");
    assert.equal(resumed.details.assignmentCount, 0);
    assert.equal(starts, 0);
    assert.equal(
      fx.domainRun.snapshot().documents[0].completedSubagentBatch?.kind,
      "proofread"
    );
  } finally {
    await fx.close();
  }
});

await test("split proofreading queues more Host assignments than persistent Pi workers", async () => {
  const faux = fauxProvider({ provider: "proofread-persistent-workers", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const response = (context) => {
    const toolResults = assignmentToolResultCount(context.messages);
    if (toolResults === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Assigned proofreading block completed."));
  };
  faux.setResponses(Array.from({ length: 24 }, () => response));
  const cards = [];
  const sourceText = Array.from({ length: 10 }, (_, index) => `source-${index + 1}`).join("\n") + "\n";
  const translationText = Array.from({ length: 10 }, (_, index) => `译文-${index + 1}`).join("\n") + "\n";
  const fx = await fixture({
    sourceText,
    translationText,
    proofreadSplitSize: 2,
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    const started = await fx.tool("runProofreadSubagents").execute("queue_proofread_blocks", {
      workerCount: 2,
      workers: [{ label: "Proof worker A" }, { label: "Proof worker B" }]
    });
    assert.equal(started.details.subagents.length, 2, "assignment count leaked into live child count");
    await fx.subagents.waitForAll();
    const [batch] = fx.subagents.list();
    const failedChild = batch.subagents.find((child) => child.status === "failed");
    const failedInspection = failedChild ? await fx.subagents.inspect(failedChild.id) : undefined;
    assert.equal(batch.status, "completed", JSON.stringify({ batch, failedInspection }, null, 2));
    assert.equal(batch.subagents.length, 2);
    assert.equal(batch.subagents.reduce((sum, child) => sum + child.completedAssignments, 0), 5);
    assert.ok(batch.subagents.some((child) => child.completedAssignments >= 3));
    assert.equal(new Set(cards.map((card) => card.details?.subagentId).filter(Boolean)).size, 2);
    const report = JSON.parse(await readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"));
    assert.deepEqual(report.findings, []);
  } finally {
    await fx.close();
  }
});

await test("folder proofreading runs every file through real persistent workers without directory reads or retries", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-folder-real-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const faux = fauxProvider({ provider: "proofread-folder-real", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let providerCalls = 0;
  const response = (context) => {
    providerCalls += 1;
    const toolResults = assignmentToolResultCount(context.messages);
    if (toolResults === 0) {
      const prompt = JSON.stringify(context.messages.findLast((message) => message.role === "user"));
      assert.match(prompt, /suggestedFix.*exact.*leading control prefix/i);
      assert.match(prompt, /both.*source.*current.*(?:have|contain).*no.*prefix.*do not.*(?:invent|diagnose)/i);
      assert.match(prompt, /suggestedFix.*(?:must change|no-op|identical)/i);
      assert.match(prompt, /readAssignedProofreadContext.*complete owned rows.*do not.*listProjectDir/i);
      return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Folder proofreading assignment completed."));
  };
  faux.setResponses(Array.from({ length: 12 }, () => response));
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    proofreadMode: "split",
    subagentEnabled: true,
    subagentCount: 1
  });
  const proofreadState = createProofreadHostState();
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(translationRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "a.txt"), "one\ntwo\n", "utf8");
    await writeFile(path.join(sourceRoot, "b.txt"), "three\nfour\n", "utf8");
    await writeFile(path.join(translationRoot, "a_translated.txt"), "一\n二\n", "utf8");
    await writeFile(path.join(translationRoot, "b_translated.txt"), "三\n四\n", "utf8");
    const request = {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      translationPath: outputDir,
      folderTranslationOrder: '{\n"a.txt"\n"b.txt"\n}',
      sessionId: "pi_proofread_folder_real",
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
      languagePair: "en->zh-CN",
      proofreadMode: "split",
      proofreadSplitSize: 2,
      subagentEnabled: true,
      subagentCount: 1
    };
    const tools = createYnDomainTools({
      request,
      publishCustomMessage: async () => {},
      subagents,
      domainRun,
      proofreadState
    });
    const tool = (name) => tools.find((entry) => entry.name === name);
    await tool("inspectTranslationContext").execute("inspect_folder", {});
    const started = await tool("runProofreadSubagents").execute("run_folder", { workerCount: 1 });
    assert.equal(started.details.documentCount, 2);
    assert.equal(started.details.assignmentCount, 2);
    await subagents.waitForAll();
    const [batch] = subagents.list();
    assert.equal(batch.status, "completed", JSON.stringify(batch, null, 2));
    assert.equal(batch.subagents[0].completedAssignments, 2);
    assert.equal(providerCalls, 4, "folder proofreading retried an assignment or made an extra provider turn");
    proofreadDocumentHostState(proofreadState, "a.txt").completedSplitScopes = [];
    proofreadDocumentHostState(proofreadState, "b.txt").completedSplitScopes = [];
    const coldStyleResume = await tool("runProofreadSubagents").execute("resume_completed_folder", { workerCount: 1 });
    assert.equal(coldStyleResume.details.status, "already_complete");
    assert.equal(coldStyleResume.details.assignmentCount, 0);
    assert.equal(providerCalls, 4, "completed legacy folder evidence was re-sent to the model");
    const finalized = await tool("finalizeProofreadReport").execute("finalize_folder", {});
    assert.equal(finalized.details.documentCount, 2);
    assert.deepEqual(domainRun.incompleteReasons(), []);
    const report = JSON.parse(await readFile(path.join(outputDir, "report", "folder.proofread.json"), "utf8"));
    assert.equal(report.schemaVersion, "2.0");
    assert.deepEqual(report.findings, []);
  } finally {
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("proofread assignments share compact exact-search evidence across persistent context resets", async () => {
  const fx = await fixture({
    sourceText: "界放\n界放\n",
    translationText: "界放\n界放\n"
  });
  const proofreadSearchCache = new Map();
  const progress = () => ({
    referenceRead: false,
    findingsWritten: false,
    findingsCount: 0
  });
  try {
    const firstTools = createPiProofreadSubagentTools({
      request: fx.request,
      task: { fromLine: 1, toLine: 1, mode: "split" },
      proofreadSearchCache,
      publishCustomMessage: async () => {}
    }, "proofread_search_first", progress());
    const firstSearch = firstTools.find((tool) => tool.name === "searchProjectText");
    const first = await firstSearch.execute("search_first", { query: "界放", path: ".", maxResults: 50 });
    assert.equal(first.details.cacheHit, false);
    assert.ok(first.details.matches.length <= 8, "proofread search returned an unbounded broad result");

    const secondTools = createPiProofreadSubagentTools({
      request: fx.request,
      task: { fromLine: 2, toLine: 2, mode: "split" },
      proofreadSearchCache,
      publishCustomMessage: async () => {}
    }, "proofread_search_second", progress());
    const secondRead = secondTools.find((tool) => tool.name === "readAssignedProofreadContext");
    const assigned = await secondRead.execute("read_second", {});
    assert.equal(assigned.details.priorExactSearches.length, 1);
    assert.equal(assigned.details.priorExactSearches[0].query, "界放");
    assert.ok(assigned.details.priorExactSearches[0].matches.length <= 3);

    const secondSearch = secondTools.find((tool) => tool.name === "searchProjectText");
    const cached = await secondSearch.execute("search_cached", { query: "界放", path: ".", maxResults: 50 });
    assert.equal(cached.details.cacheHit, true);
    assert.ok(cached.details.matches.length <= 3);
  } finally {
    await fx.close();
  }
});

await test("exact proofread workers stay honest when assignments are fewer and preserve custom labels", async () => {
  const faux = fauxProvider({ provider: "proofread-exact-idle-workers", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const response = (context) => {
    const toolResults = assignmentToolResultCount(context.messages);
    if (toolResults === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Exact worker assignment completed."));
  };
  faux.setResponses(Array.from({ length: 12 }, () => response));
  const cards = [];
  const completions = [];
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async (message) => cards.push(message),
    notifyParent: async (message) => completions.push(message),
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  const fx = await fixture({
    sourceText: "hello\ngoodbye\n",
    translationText: "你好\n再见\n",
    proofreadSplitSize: 1_000,
    subagents
  });
  const workerLabels = Array.from({ length: 5 }, (_, index) => `Reviewer ${index + 1}`);
  try {
    subagents.startProofreadBatch({
      request: fx.request,
      tasks: [
        { documentId: "source.txt", fromLine: 1, toLine: 1, mode: "split" },
        { documentId: "source.txt", fromLine: 2, toLine: 2, mode: "split" }
      ],
      maxWorkers: 5,
      taskStage: () => 0,
      workers: workerLabels.map((label) => ({ label }))
    });
    await subagents.waitForAll();
    const [batch] = subagents.list();
    assert.equal(batch.status, "completed");
    assert.deepEqual(batch.subagents.map((worker) => worker.label), workerLabels);
    assert.equal(batch.subagents.filter((worker) => worker.assignmentCount === 0).length, 3);
    assert.ok(batch.subagents
      .filter((worker) => worker.assignmentCount === 0)
      .every((worker) => worker.fromLine === undefined && worker.toLine === undefined));
    const queuedCards = cards.filter((card) => card.details?.activity === "queued");
    assert.equal(queuedCards.length, 5);
    assert.ok(queuedCards.every((card) => card.details?.fromLine === undefined && card.details?.toLine === undefined));
    assert.deepEqual(completions[0].details.subagents.map((worker) => worker.label), workerLabels);
  } finally {
    await fx.close();
  }
});

await test("a persistent proofread worker retries its failed block before claiming the next block", async () => {
  const faux = fauxProvider({ provider: "proofread-assignment-retry", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let failedFirstBlock = false;
  const response = (context) => {
    if (!failedFirstBlock && context.systemPrompt.includes("L1-L2")) {
      failedFirstBlock = true;
      throw new Error("retry this proofread block");
    }
    const toolResults = assignmentToolResultCount(context.messages);
    if (toolResults === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Proofread block completed after retry."));
  };
  faux.setResponses(Array.from({ length: 20 }, () => response));
  const cards = [];
  const fx = await fixture({
    sourceText: "a\nb\nc\nd\ne\nf\n",
    translationText: "甲\n乙\n丙\n丁\n戊\n己\n",
    proofreadSplitSize: 2,
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    await fx.tool("runProofreadSubagents").execute("retry_proofread_block", { workerCount: 1 });
    await fx.subagents.waitForAll();
    const [batch] = fx.subagents.list();
    assert.equal(batch.status, "completed");
    assert.equal(batch.subagents[0].assignmentCount, 4);
    assert.equal(batch.subagents[0].completedAssignments, 3);
    const runningRanges = cards
      .filter((card) => card.details?.status === "running" && card.details?.activity?.startsWith("proofreading"))
      .map((card) => [card.details.fromLine, card.details.toLine]);
    assert.deepEqual(runningRanges, [[1, 2], [1, 2], [3, 4], [5, 6]]);
  } finally {
    await fx.close();
  }
});

await test("proofread contract no-progress fails one assignment without burning a whole-assignment retry", async () => {
  const faux = fauxProvider({ provider: "proofread-contract-no-progress", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let providerCalls = 0;
  const noProgress = () => {
    providerCalls += 1;
    return fauxAssistantMessage(fauxText("I am done without using the required Host tools."));
  };
  faux.setResponses(Array.from({ length: 8 }, () => noProgress));
  const fx = await fixture({
    sourceText: "one\ntwo\n",
    translationText: "一\n二\n",
    proofreadSplitSize: 2,
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    await fx.tool("runProofreadSubagents").execute("proofread_no_progress", { workerCount: 1 });
    await fx.subagents.waitForAll();
    const [batch] = fx.subagents.list();
    assert.equal(batch.status, "failed");
    assert.equal(batch.subagents[0].assignmentCount, 1);
    assert.equal(providerCalls, 2, "a deterministic contract failure retried the complete assignment");
  } finally {
    await fx.close();
  }
});

await test("two native Pi proofread children merge strict findings and expose only two structured cards", async () => {
  const faux = fauxProvider({ provider: "proofread-children", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const response = (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    const firstRange = context.systemPrompt.includes("L1-L2");
    if (toolResults === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", {
        findings: [firstRange ? {
          id: "M1-001",
          type: "tone",
          sourceLine: 1,
          suggestedFix: "您好",
          rationale: "Use the intended polite register."
        } : {
          id: "M1-002",
          type: "accuracy",
          sourceLine: 4,
          suggestedFix: "犬",
          rationale: "Keep the established terminology."
        }]
      }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText(firstRange ? "first proofread shard complete" : "second proofread shard complete"));
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));

  const cards = [];
  const domainCalls = {
    sourceReads: 0,
    translationReads: 0,
    artifactResets: 0,
    artifactMutations: 0,
    subagentsCompleted: []
  };
  const fx = await fixture({
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    domainRun: {
      kind: "proofread",
      assertCanStartSubagentBatch() {},
      activate: (kind) => { assert.equal(kind, "proofread"); },
      recordInspection() {},
      recordSourceRead: () => { domainCalls.sourceReads += 1; },
      recordTranslationRead: () => { domainCalls.translationReads += 1; },
      recordProofreadPrescan() {},
      assertProofreadPrescanReady() {},
      recordProofreadArtifactReset: () => { domainCalls.artifactResets += 1; },
      recordProofreadArtifactMutation: () => { domainCalls.artifactMutations += 1; },
      recordSubagentBatchFailure: () => assert.fail("successful proofread batch reported failure"),
      recordSubagentBatchStarted: (kind, batchId) => {
        assert.equal(kind, "proofread");
        assert.match(batchId, /^batch_/);
      },
      recordSubagentBatch: (kind, batchId, count) => {
        assert.equal(kind, "proofread");
        assert.match(batchId, /^batch_/);
        domainCalls.subagentsCompleted.push(count);
      }
    }
  });

  try {
    const result = await fx.tool("runProofreadSubagents").execute("call_proofread_children", {
      workers: [
        { label: "Proof A" },
        { label: "Proof B" }
      ]
    });
    assert.equal(result.details.status, "running");
    assert.equal(result.details.subagents.length, 2);
    await fx.subagents.waitForAll();
    const settledBatch = fx.subagents.list()[0];
    const failedChild = settledBatch.subagents.find((child) => child.status === "failed");
    const failedInspection = failedChild ? await fx.subagents.inspect(failedChild.id) : undefined;
    assert.equal(settledBatch.status, "completed", JSON.stringify({ settledBatch, failedInspection }, null, 2));

    const report = JSON.parse(await readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"));
    assert.equal(report.findings.length, 2);
    assert.deepEqual(report.findings.map((finding) => finding.sourceLine).sort((a, b) => a - b), [1, 4]);
    assert.equal(new Set(report.findings.map((finding) => finding.agentId)).size, 2);

    assert.equal(cards.every((card) => card.role === "custom"), true);
    assert.equal(cards.every((card) => card.customType === "subagent.proofread"), true);
    assert.equal(cards.every((card) => card.details?.collapsed === true), true);
    assert.doesNotMatch(JSON.stringify(cards), /message_start|message_end|toolcall_start|host_tool|eventRef/i);
    assert.equal(cards.every((card) => !Object.hasOwn(card.details, "transcript")), true);
    const ids = new Set(cards.map((card) => card.details.subagentId));
    assert.equal(ids.size, 2);
    for (const id of ids) {
      const lifecycle = cards.filter((card) => card.details.subagentId === id);
      assert.equal(lifecycle[0].details.status, "running");
      assert.equal(lifecycle.at(-1).details.status, "completed");
      const transcript = await fx.subagents.inspectTranscript(id);
      assert.ok(
        transcript.some((message) => message.role === "toolResult"),
        "proofread child Pi JSONL did not retain native tool progress"
      );
    }

    assert.equal(domainCalls.sourceReads, 1);
    assert.equal(domainCalls.translationReads, 1);
    assert.equal(
      domainCalls.artifactResets,
      0,
      "split workers replace validated ranges atomically instead of clearing the report before they run"
    );
    assert.equal(domainCalls.artifactMutations, 2);
    assert.deepEqual(domainCalls.subagentsCompleted, [2]);
  } finally {
    await fx.close();
  }
});

await test("two proofread children may persist empty findings as a successful full-range artifact", async () => {
  const faux = fauxProvider({ provider: "proofread-empty", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const response = (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("no findings"));
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));
  const fx = await fixture({
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    const result = await fx.tool("runProofreadSubagents").execute("call_empty_findings", {
      workers: [
        {},
        {}
      ]
    });
    assert.equal(result.details.status, "running");
    await fx.subagents.waitForAll();
    assert.equal(fx.subagents.list()[0].status, "completed");
    const report = JSON.parse(await readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"));
    assert.deepEqual(report.findings, []);
  } finally {
    await fx.close();
  }
});

await test("a proofread child may complete progressively across more than two host repair turns", async () => {
  const provider = fauxProvider({ provider: "proofread-progressive", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxText("I have not completed the artifact tools yet.")),
    fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}, { id: "progress-read-context" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("The aligned source, translation, and workflow context are now loaded.")),
    fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }, { id: "progress-write-findings" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("The empty findings artifact is now complete."))
  ]);
  const cards = [];
  const fx = await fixture();
  try {
    const result = await runPiProofreadSubagent({
      request: fx.request,
      task: { fromLine: 1, toLine: 2 },
      publishCustomMessage: async (message) => cards.push(message),
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.equal(result.findingsWritten, 0);
    assert.ok(result.reportPath);
    const report = JSON.parse(await readFile(result.reportPath, "utf8"));
    assert.deepEqual(report.findings, []);
    assert.equal(cards.at(-1)?.details?.status, "completed");
    assert.match(cards.at(-1)?.details?.resultSummary || "", /0 findings/i);
    assert.match(result.resultSummary || "", /0 findings/i);
    assert.match(result.reply, /Proofread L1-L2 completed with 0 findings/);
  } finally {
    await fx.close();
  }
});

await test("proofread children can consume complete project references beyond the inline limit", async () => {
  const fx = await fixture();
  const styleGuide = `# Style Guide\n\n${"voice-context-".repeat(3_000)}`;
  const workspacePath = path.join(fx.outputDir, ".translation-workshop", "style_guide.md");
  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await writeFile(workspacePath, styleGuide, "utf8");
    const progress = { referenceRead: false, findingsWritten: false, findingsCount: 0 };
    const tools = createPiProofreadSubagentTools({
      request: fx.request,
      task: { fromLine: 1, toLine: 2, mode: "split", label: "full-reference" },
      publishCustomMessage: async () => {}
    }, "proofread-reference-child", progress);
    const context = await tools.find((tool) => tool.name === "readAssignedProofreadContext").execute("read-context", {});
    const manifest = context.details.references.find((entry) => entry.id === "approved-style-guide");
    assert.equal(manifest.complete, false);
    assert.equal(manifest.length, styleGuide.length);
    const reader = tools.find((tool) => tool.name === "readProofreadReference");
    let offset = 0;
    let reconstructed = "";
    while (offset < manifest.length) {
      const chunk = await reader.execute("read-reference", { id: manifest.id, offset, maxChars: 10_000 });
      reconstructed += chunk.details.content;
      offset = chunk.details.nextOffset;
    }
    assert.equal(reconstructed, styleGuide);
    assert.equal(progress.referenceOffsets.get(manifest.id).offset, styleGuide.length);
  } finally {
    await fx.close();
  }
});

await test("the child reader paginates an explicitly oversized assignment without skipping rows", async () => {
  const fx = await fixture();
  try {
    const progress = { referenceRead: false, findingsWritten: false, findingsCount: 0 };
    const tools = createPiProofreadSubagentTools({
      request: fx.request,
      task: { fromLine: 1, toLine: 4, checkpointSize: 2, mode: "split", label: "checkpointed" },
      publishCustomMessage: async () => {}
    }, "proofread-checkpoint-child", progress);
    const reader = tools.find((tool) => tool.name === "readAssignedProofreadContext");
    const first = await reader.execute("checkpoint-1", {});
    assert.deepEqual(first.details.assignedLines.map((row) => row.line), [1, 2]);
    assert.equal(first.details.assignmentComplete, false);
    assert.equal(first.details.nextFromLine, 3);
    const second = await reader.execute("checkpoint-2", {});
    assert.deepEqual(second.details.assignedLines.map((row) => row.line), [3, 4]);
    assert.equal(second.details.assignmentComplete, true);
    assert.equal(progress.referenceRead, true);
  } finally {
    await fx.close();
  }
});

await test("a native proofread child can advance one large-reference chunk per Pi follow-up", async () => {
  const fx = await fixture();
  const styleGuide = `# Style Guide\n\n${"long-voice-context-".repeat(2_500)}`;
  const workspacePath = path.join(fx.outputDir, ".translation-workshop", "style_guide.md");
  const provider = fauxProvider({ provider: "proofread-progressive-reference", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(provider.provider);
  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await writeFile(workspacePath, styleGuide, "utf8");
    const responses = [
      fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Context loaded; continuing the large reference next turn."))
    ];
    for (let offset = 0; offset < styleGuide.length; offset += 10_000) {
      responses.push(
        fauxAssistantMessage(fauxToolCall("readProofreadReference", {
          id: "approved-style-guide",
          offset,
          maxChars: 10_000
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxText(`Reference checkpoint ${offset} complete.`))
      );
    }
    responses.push(
      fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Progressive reference proofreading completed."))
    );
    provider.setResponses(responses);
    const result = await runPiProofreadSubagent({
      request: fx.request,
      task: { fromLine: 1, toLine: 2, mode: "split", label: "progressive-reference" },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.equal(result.findingsWritten, 0);
    assert.match(result.reply, /completed/i);
  } finally {
    await fx.close();
  }
});

await test("parent abort cancels every proofread child before any delayed findings write", async () => {
  const models = createModels();
  const providers = new Map();
  const started = new Set();
  const signals = new Map();
  const releases = new Map();
  const allWaitingToWrite = deferred();

  for (const providerId of ["proofread-abort-a", "proofread-abort-b"]) {
    const faux = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
    models.setProvider(faux.provider);
    providers.set(providerId, faux);
    const response = (context, options) => {
      const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
      if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
      return new Promise((resolve) => {
        signals.set(providerId, options?.signal);
        started.add(providerId);
        if (started.size === 2) allWaitingToWrite.resolve();
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          setTimeout(() => {
            const firstRange = context.systemPrompt.includes("L1-L2");
            resolve(fauxAssistantMessage(fauxToolCall("writeAssignedFindings", {
              findings: [firstRange ? {
                id: "M1-101",
                type: "tone",
                sourceLine: 1,
                suggestedFix: "您好",
                rationale: "late write sentinel"
              } : {
                id: "M1-102",
                type: "accuracy",
                sourceLine: 4,
                suggestedFix: "犬",
                rationale: "late write sentinel"
              }]
            }), { stopReason: "toolUse" }));
          }, 25);
        };
        releases.set(providerId, release);
        options?.signal?.addEventListener("abort", release, { once: true });
        if (options?.signal?.aborted) release();
      });
    };
    faux.setResponses([response, response, response]);
  }

  const fx = await fixture({
    createSubagentModelSelection: async ({ providerId }) => {
      const faux = providers.get(providerId);
      assert.ok(faux, `unexpected provider ${providerId}`);
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    }
  });
  const controller = new AbortController();
  let running;
  try {
    running = fx.tool("runProofreadSubagents").execute("call_abort_proofread", {
      workers: [
        { providerId: "proofread-abort-a" },
        { providerId: "proofread-abort-b" }
      ]
    }, controller.signal);
    await allWaitingToWrite.promise;
    controller.abort(new Error("parent stopped proofreading"));
    const outcome = await running;
    assert.equal(outcome.details.status, "running");
    await fx.subagents.waitForAll();
    assert.equal(signals.size, 2);
    for (const signal of signals.values()) assert.equal(signal?.aborted, true);
    const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
    await assert.rejects(() => readFile(reportPath, "utf8"), (error) => error?.code === "ENOENT");
    await new Promise((resolve) => setTimeout(resolve, 75));
    await assert.rejects(() => readFile(reportPath, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    for (const release of releases.values()) release();
    if (running) await running.catch(() => {});
    await fx.close();
  }
});

await test("split proofread start failure restores the previous report transaction", async () => {
  const startError = new Error("synthetic proofread supervisor start failure");
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch() {
      throw startError;
    }
  };
  const fx = await fixture({ subagents });
  const reportDir = path.join(fx.outputDir, "report");
  const reportPath = path.join(reportDir, "source.proofread.json");
  const summaryPath = path.join(reportDir, "source_proofread_summary.md");
  const healthyReport = `${JSON.stringify({
    documentId: "source.txt",
    findings: [{
      id: "H1-001",
      severity: "H1",
      type: "accuracy",
      sourceLine: 1,
      translationLine: 1,
      sourceText: "こんにちは",
      currentTranslation: "你好",
      suggestedFix: "您好",
      rationale: "Healthy persisted finding from the previous completed batch."
    }]
  }, null, 2)}\n`;
  const healthySummary = "# Retired proofread summary\n\nMust not be restored.\n";
  try {
    await mkdir(reportDir, { recursive: true });
    await writeFile(reportPath, healthyReport, "utf8");
    await writeFile(summaryPath, healthySummary, "utf8");

    await assert.rejects(
      () => fx.tool("runProofreadSubagents").execute("split_start_failure", {}),
      (error) => error === startError
    );
    assert.equal(
      await readFile(reportPath, "utf8"),
      healthyReport,
      "a failed supervisor start destroyed the previous healthy findings"
    );
    assert.equal(
      await readFile(summaryPath, "utf8"),
      healthySummary,
      "a failed supervisor start must not mutate any pre-existing legacy artifact"
    );
  } finally {
    await fx.close();
  }
});

await test("one proofread child failure preserves an independent healthy sibling and its findings", async () => {
  const models = createModels();
  const failing = fauxProvider({ provider: "proofread-fails", tokensPerSecond: 1000 });
  const sibling = fauxProvider({ provider: "proofread-sibling", tokensPerSecond: 1000 });
  models.setProvider(failing.provider);
  models.setProvider(sibling.provider);
  const siblingWaiting = deferred();
  let siblingSignal;
  let siblingFinished = false;

  const failingResponse = async (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    await siblingWaiting.promise;
    throw new Error("proofread child failed");
  };
  const siblingResponse = (context, options) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    siblingSignal = options?.signal;
    if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    if (toolResults === 1) {
      const contextResult = context.messages.findLast((message) => (
        message.role === "toolResult" && message.toolName === "readAssignedProofreadContext"
      ));
      assert.ok(contextResult, "healthy sibling did not receive its Host-owned assignment");
      const assignedLine = resultPayload(contextResult).assignedLines[0].line;
      siblingWaiting.resolve();
      return new Promise((resolve) => setTimeout(() => {
        siblingFinished = true;
        resolve(fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [{
          id: "M1-STALE",
          type: "stale-partial",
          sourceLine: assignedLine,
          suggestedFix: "犬",
          rationale: "This accepted result belongs to the independent healthy sibling."
        }] }), {
          stopReason: "toolUse"
        }));
      }, 30));
    }
    return fauxAssistantMessage(fauxText("Healthy proofread sibling completed."));
  };
  failing.setResponses([failingResponse, failingResponse, failingResponse]);
  sibling.setResponses([siblingResponse, siblingResponse, siblingResponse, siblingResponse]);
  const repair = fauxProvider({ provider: "proofread-replacement", tokensPerSecond: 1000 });
  models.setProvider(repair.provider);
  const repairResponse = (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}), { stopReason: "toolUse" });
    if (toolResults === 1) {
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Replacement proofread child completed."));
  };
  repair.setResponses(Array.from({ length: 8 }, () => repairResponse));
  const providers = new Map([
    [failing.provider.id, failing],
    [sibling.provider.id, sibling],
    [repair.provider.id, repair]
  ]);
  let siblingCardClosed = false;
  const fx = await fixture({
    publishCustomMessage: async (message) => {
      if (message.details?.label === "Sibling" && message.details?.closed) siblingCardClosed = true;
    },
    createSubagentModelSelection: async ({ providerId }) => {
      const faux = providers.get(providerId);
      assert.ok(faux, `unexpected provider ${providerId}`);
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    }
  });
  try {
    const started = await fx.tool("runProofreadSubagents").execute("call_proofread_failure", {
      workers: [
        { providerId: failing.provider.id, label: "Failure" },
        { providerId: sibling.provider.id, label: "Sibling" }
      ]
    });
    assert.equal(started.details.status, "running");
    await fx.subagents.waitForAll();
    assert.equal(siblingSignal?.aborted, false, "an unrelated proofread child failure aborted the healthy sibling harness");
    assert.equal(siblingFinished, true, "batch settled before the healthy sibling completed");
    assert.equal(siblingCardClosed, true, "batch settled before sibling terminal card update");
    const [batch] = fx.subagents.list();
    assert.equal(batch.status, "failed");
    assert.deepEqual(
      batch.subagents.map((child) => child.status).sort(),
      ["completed", "failed"],
      "the failed proofread batch did not preserve the healthy sibling's completed work"
    );
    const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
    const partialReport = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(partialReport.findings.length, 1);

    assert.equal(fx.domainRun.awaitingUserInput, true);
    fx.domainRun.resumeAfterExplicitContinuation(fx.domainRun.recoveryPauseId);

    const replacement = await fx.tool("runProofreadSubagents").execute("call_proofread_replacement", {
      workers: [
        { providerId: repair.provider.id, label: "Repair A" }
      ]
    });
    assert.equal(replacement.details.status, "running");
    await fx.subagents.waitForAll();
    const finalReport = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(finalReport.findings.length, 1);
    assert.equal(
      finalReport.findings[0].rationale,
      "This accepted result belongs to the independent healthy sibling.",
      "retrying the failed range discarded an already accepted sibling assignment"
    );
  } finally {
    await fx.close();
  }
});

await test("generic project writes cannot overwrite the canonical proofreading report", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => fx.tool("writeProjectFile").execute("overwrite_report", {
      path: "report/source.proofread.json",
      content: "{}"
    }), /writeProofreadFindings|restricted|report/i);
  } finally {
    await fx.close();
  }
});

await test("assigned findings hydrate exact source and translation rows on the host", async () => {
  const fx = await fixture();
  const progress = {
    referenceRead: false,
    findingsWritten: false,
    findingsCount: 0
  };
  const tools = createPiProofreadSubagentTools({
    request: fx.request,
    task: { fromLine: 1, toLine: 2 },
    publishCustomMessage: async () => {}
  }, "proofread_validation", progress);
  const readContext = tools.find((tool) => tool.name === "readAssignedProofreadContext");
  const writeFindings = tools.find((tool) => tool.name === "writeAssignedFindings");
  try {
    const schema = JSON.stringify(writeFindings.parameters);
    assert.doesNotMatch(schema, /sourceText|currentTranslation|translationLine|severity/);
    await readContext.execute("read_context", {});
    await writeFindings.execute("write_canonical", {
      findings: [{
        id: "M1-900",
        type: "accuracy",
        sourceLine: 1,
        suggestedFix: "您好",
        rationale: "Host-owned exact-row sentinel"
      }]
    });
    const report = JSON.parse(await readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"));
    assert.equal(report.findings[0].severity, "M1");
    assert.equal(report.findings[0].sourceLine, 1);
    assert.equal(report.findings[0].translationLine, 1);
    assert.equal(report.findings[0].sourceText, "こんにちは");
    assert.equal(report.findings[0].currentTranslation, "你好");
    assert.equal(progress.findingsWritten, true);
    await assert.rejects(() => writeFindings.execute("write_duplicate", {
      findings: [{
        id: "L3-901",
        type: "wording",
        sourceLine: 2,
        suggestedFix: "再会",
        rationale: "A second successful child write must not fragment the batch artifact."
      }]
    }), /already written/i);
  } finally {
    await fx.close();
  }
});

await test("a repeated split assignment replaces only its own report range", async () => {
  const fx = await fixture();
  const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
  const progress = {
    referenceRead: false,
    findingsWritten: false,
    findingsCount: 0
  };
  const tools = createPiProofreadSubagentTools({
    request: fx.request,
    task: { fromLine: 1, toLine: 2, mode: "split" },
    publishCustomMessage: async () => {}
  }, "proofread_range_replacement", progress);
  const readContext = tools.find((tool) => tool.name === "readAssignedProofreadContext");
  const writeFindings = tools.find((tool) => tool.name === "writeAssignedFindings");
  try {
    const seeded = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [path.join(fx.outputDir, "source.txt")],
      documentId: "source.txt",
      translationPath: path.join(fx.outputDir, "AI_translation", "source_translated.txt"),
      kind: "findings_json",
      mode: "split",
      content: JSON.stringify([
        {
          id: "M1-OLD-RANGE",
          severity: "M1",
          type: "accuracy",
          sourceLine: 1,
          translationLine: 1,
          sourceText: "こんにちは",
          currentTranslation: "你好",
          suggestedFix: "您好",
          rationale: "Stale finding owned by the repeated assignment."
        },
        {
          id: "M1-OTHER-RANGE",
          severity: "M1",
          type: "accuracy",
          sourceLine: 3,
          translationLine: 3,
          sourceText: "猫",
          currentTranslation: "猫",
          suggestedFix: "猫咪",
          rationale: "Finding owned by another completed assignment."
        }
      ])
    });
    assert.equal(seeded.ok, true);

    await readContext.execute("read_replacement_context", {});
    await writeFindings.execute("replace_owned_range", { findings: [] });

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.findings.map((finding) => finding.id), ["M1-OTHER-RANGE"]);
  } finally {
    await fx.close();
  }
});

await test("proofread children report missing proper nouns as structured parent-owned glossary candidates", async () => {
  const fx = await fixture();
  const progress = {
    referenceRead: false,
    findingsWritten: false,
    findingsCount: 0
  };
  const tools = createPiProofreadSubagentTools({
    request: fx.request,
    task: { fromLine: 1, toLine: 2 },
    publishCustomMessage: async () => {}
  }, "proofread_glossary_discovery", progress);
  const readContext = tools.find((tool) => tool.name === "readAssignedProofreadContext");
  const writeFindings = tools.find((tool) => tool.name === "writeAssignedFindings");
  try {
    const schema = JSON.stringify(writeFindings.parameters);
    for (const category of ["proper_noun", "character", "organization", "place", "title", "setting_term"]) {
      assert.match(schema, new RegExp(category));
    }
    await readContext.execute("read_context", {});
    await assert.rejects(() => writeFindings.execute("reject_target_without_evidence", {
      findings: [],
      glossaryCandidates: [{
        source: "こんにちは",
        target: "您好",
        category: "setting_term",
        evidenceLine: 1,
        rationale: "The target must occur in the current translated evidence row."
      }]
    }), /target.*translated evidence/i);
    await assert.rejects(() => writeFindings.execute("reject_bad_category", {
      findings: [],
      glossaryCandidates: [{
        source: "こんにちは",
        target: "你好",
        category: "活动名称",
        evidenceLine: 1,
        rationale: "Unsupported free-form category must not be silently discarded."
      }]
    }), /unsupported category/i);
    assert.equal(progress.findingsWritten, false);
    await writeFindings.execute("write_discovery", {
      findings: [],
      glossaryCandidates: [{
        source: "こんにちは",
        target: "你好",
        category: "setting_term",
        evidenceLine: 1,
        rationale: "Stable project-specific greeting label."
      }]
    });
    assert.deepEqual(progress.glossaryCandidates, [{
      source: "こんにちは",
      target: "你好",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "Stable project-specific greeting label."
    }]);
  } finally {
    await fx.close();
  }
});

await test("proofread child guidance names only the native Pi child artifact tools", async () => {
  const guidance = await readFile(
    path.resolve("translation-protocol/proofread-child.md"),
    "utf8"
  );
  assert.match(guidance, /readAssignedProofreadContext/);
  assert.match(guidance, /writeAssignedFindings/);
  assert.doesNotMatch(guidance, /Call `completeTask`/);
  assert.doesNotMatch(guidance, /writeProofreadFindings\(\{kind:"findings_json"\}\)/);
});

await test("proofread children bind request.translationPath without modifying the generated candidate", async () => {
  const fx = await fixture();
  const translationPath = path.join(fx.outputDir, "approved-translation.txt");
  await writeFile(translationPath, "您好\n再会\n猫咪\n犬\n", "utf8");
  fx.request.translationPath = translationPath;
  const progress = {
    referenceRead: false,
    findingsWritten: false,
    findingsCount: 0
  };
  const tools = createPiProofreadSubagentTools({
    request: fx.request,
    task: { fromLine: 1, toLine: 2 },
    publishCustomMessage: async () => {}
  }, "proofread_bound_translation", progress);
  const readContext = tools.find((tool) => tool.name === "readAssignedProofreadContext");
  const writeFindings = tools.find((tool) => tool.name === "writeAssignedFindings");
  try {
    const context = await readContext.execute("read_bound_context", {});
    assert.deepEqual(context.details.assignedLines.map((row) => row.translation), ["您好", "再会"]);
    await writeFindings.execute("write_bound_findings", {
      findings: [{
        id: "M1-901",
        type: "tone",
        sourceLine: 1,
        suggestedFix: "您好！",
        rationale: "Validate against the explicitly bound translation."
      }]
    });
    const report = JSON.parse(await readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"));
    assert.equal(report.translationPath, translationPath);
    assert.equal(report.findings[0].currentTranslation, "您好");
    assert.equal(
      await readFile(path.join(fx.outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "你好\n再见\n猫\n狗\n"
    );
  } finally {
    await fx.close();
  }
});

await test("proofread child rejects a directory candidate before the first provider call", async () => {
  const faux = fauxProvider({ provider: "proofread-directory-preflight", tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let providerCalls = 0;
  faux.setResponses([() => {
    providerCalls += 1;
    return fauxAssistantMessage(fauxText("This response must never be requested."));
  }]);
  const fx = await fixture();
  try {
    await assert.rejects(
      runPiProofreadSubagent({
        request: { ...fx.request, translationPath: fx.outputDir },
        task: { documentId: "source.txt", fromLine: 1, toLine: 2, mode: "split" },
        publishCustomMessage: async () => {},
        createModelSelection: async () => ({
          models,
          model: faux.getModel(),
          providerId: faux.provider.id,
          modelId: faux.getModel().id
        })
      }),
      /requires file-bound paths/i
    );
    assert.equal(providerCalls, 0);
  } finally {
    await fx.close();
  }
});

await test("proofread delegation rejects model-supplied line ranges instead of accepting ownership", async () => {
  const fx = await fixture();
  try {
    const schema = JSON.stringify(fx.tool("runProofreadSubagents").parameters);
    assert.doesNotMatch(schema, /fromLine|toLine/);
    assert.match(schema, /workers/);
  } finally {
    await fx.close();
  }
});

await test("proofread delegation accepts any useful 1..N count but rejects mismatched override records", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => fx.tool("runProofreadSubagents").execute("call_gap", {
      workerCount: 2,
      workers: [{}]
    }), /requires exactly 2 worker override records/i);
  } finally {
    await fx.close();
  }
});

await test("a successful findings write terminates the assignment without a token-wasting final model turn", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-final-reply-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "AI_translation", "source_translated.txt");
  await writeFile(sourcePath, "hello\n", "utf8");
  await mkdir(path.dirname(translationPath), { recursive: true });
  await writeFile(translationPath, "你好\n", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: "proofread-final-reply", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  let providerCalls = 0;
  provider.setResponses([
    () => {
      providerCalls += 1;
      return fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}, { id: "proofread-read-context" }), { stopReason: "toolUse" });
    },
    () => {
      providerCalls += 1;
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }, { id: "proofread-write" }), { stopReason: "toolUse" });
    }
  ]);
  const cards = [];
  try {
    const result = await runPiProofreadSubagent({
      request: {
        outputDir,
        sourcePath,
        translationPath,
        sessionId: "pi_proofread_final_reply",
        prompt: "proofread the assigned range",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 1, toLine: 1 },
      publishCustomMessage: async (message) => cards.push(message),
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.match(result.reply, /0 findings/);
    assert.equal(providerCalls, 2);
    assert.equal(Object.hasOwn(cards.at(-1)?.details || {}, "reply"), false);
    assert.equal(Object.hasOwn(cards.at(-1)?.details || {}, "transcript"), false);
    const child = await new PiSessionRepository(outputDir).openChild(cards.at(-1)?.details?.subagentId);
    const transcript = (await child.buildContext()).messages;
    assert.ok(transcript.some((message) => (
      message.role === "assistant"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "toolCall" && block.name === "writeAssignedFindings")
    )));
    assert.equal(transcript.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "text" && /host findings contract has succeeded/i.test(block.text))
    )), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
