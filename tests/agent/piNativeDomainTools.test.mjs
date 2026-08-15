import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
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
import { buildYnSystemPrompt } from "../../src/main/agent/piNative/systemPrompt.ts";
import {
  createProofreadHostState,
  proofreadDocumentHostState
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import {
  createTranslationAlignmentHostState,
  createTranslationAlignmentRangeAudit,
  createTranslationChunkReviewAudit
} from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { writeProofreadFindings } from "../../src/main/agent/writeProofreadFindings.ts";
import {
  prepareTranslationStagingCandidate,
  resolveTranslationCandidatePath
} from "../../src/main/agent/writeTranslationChunk.ts";

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
  }
}

async function fixture(extraContext = {}, sourceText = "こんにちは {name}\n\nさようなら\n") {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-domain-"));
  const sourcePath = path.join(outputDir, extraContext.sourceRelativePath ?? "source.txt");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, sourceText, "utf8");
  const request = {
    outputDir,
    sourcePath,
    sessionId: "pi_test",
    prompt: "translate",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    ...(extraContext.requestPatch ?? {})
  };
  const publishCustomMessage = extraContext.publishCustomMessage ?? (async () => {});
  const subagents = extraContext.subagents ?? new YnSubagentSupervisor({
    publishCustomMessage,
    createModelSelection: extraContext.createSubagentModelSelection
  });
  const domainRun = extraContext.domainRun ?? (request.workflowIntent
    ? createYnDomainRunContract({
        workflowIntent: request.workflowIntent,
        subagentEnabled: request.subagentEnabled,
        subagentCount: request.subagentCount,
        folderSource: request.sourceSelection?.kind === "folder",
        proofreadMode: request.proofreadMode,
        proofreadMontecarloRoundMin: request.proofreadMontecarloRoundMin,
        proofreadMontecarloRoundMax: request.proofreadMontecarloRoundMax
      })
    : undefined);
  const tools = createYnDomainTools({ request, publishCustomMessage, subagents, ...extraContext, domainRun });
  return {
    outputDir,
    sourcePath,
    request,
    tools,
    subagents,
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

async function execute(tool, params = {}) {
  return tool.execute(`call_${tool.name}`, params);
}

await test("parent line reads page oversized ranges instead of injecting whole files into Pi context", async () => {
  const sourceLines = Array.from({ length: 1_200 }, (_, index) => `source-${index + 1}`);
  const translationLines = Array.from({ length: 1_200 }, (_, index) => `translation-${index + 1}`);
  const fx = await fixture({}, `${sourceLines.join("\n")}\n`);
  try {
    const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, `${translationLines.join("\n")}\n`, "utf8");

    const source = await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 1_200 });
    const translation = await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 1_200 });
    for (const result of [source.details, translation.details]) {
      assert.equal(result.fromLine, 1);
      assert.equal(result.toLine, 512);
      assert.equal(result.requestedToLine, 1_200);
      assert.equal(result.hasMore, true);
      assert.equal(result.nextFromLine, 513);
      assert.equal(result.lines.length, 512);
    }
    assert.equal(source.details.lines.at(-1), "source-512");
    assert.equal(translation.details.lines.at(-1), "translation-512");
  } finally {
    await fx.close();
  }
});

await test("parent translation writes preflight review ownership and roll back canonical bytes on Host failure", async () => {
  const fullDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: false
  });
  fullDomainRun.recordInspection({
    sourceLineCount: 3,
    documents: [{ id: "source.txt", sourceLineCount: 3 }],
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  const alignmentState = createTranslationAlignmentHostState();
  alignmentState.ranges["source.txt"] = [createTranslationChunkReviewAudit({
    documentId: "source.txt",
    sourceLines: ["甲", "乙", "丙"],
    candidateLines: ["A", "B", "C"],
    candidatePath: "placeholder",
    fromLine: 1,
    toLine: 3,
    sourceLineCount: 3
  })];
  const full = await fixture({
    domainRun: fullDomainRun,
    translationAlignmentState: alignmentState,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: false
    }
  }, "甲\n乙\n丙\n");
  const fullCandidate = path.join(full.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(fullCandidate), { recursive: true });
    await writeFile(fullCandidate, "A\nB\nC\n", "utf8");
    const beforeDomain = fullDomainRun.snapshot();
    await assert.rejects(
      execute(full.tool("writeTranslationChunk"), {
        documentId: "source.txt",
        fromLine: 2,
        toLine: 2,
        lines: ["第二行译文"]
      }),
      /review ranges overlap.*L1-L3.*L2-L2/i
    );
    assert.equal(await readFile(fullCandidate, "utf8"), "A\nB\nC\n");
    assert.deepEqual(fullDomainRun.snapshot(), beforeDomain);
  } finally {
    await full.close();
  }

  const boundedDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: false
  });
  boundedDomainRun.recordInspection({
    sourceLineCount: 2,
    documents: [{ id: "source.txt", sourceLineCount: 2 }],
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  const bounded = await fixture({
    domainRun: boundedDomainRun,
    persistHostState: async () => { throw new Error("forced Host persistence failure"); }
  }, "甲\n乙\n");
  const boundedCandidate = path.join(bounded.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(boundedCandidate), { recursive: true });
    await writeFile(boundedCandidate, "A\nB\n", "utf8");
    const beforeDomain = boundedDomainRun.snapshot();
    await assert.rejects(
      execute(bounded.tool("writeTranslationChunk"), {
        documentId: "source.txt",
        fromLine: 2,
        toLine: 2,
        lines: ["第二行译文"]
      }),
      /rollback was incomplete|forced Host persistence failure/i
    );
    assert.equal(await readFile(boundedCandidate, "utf8"), "A\nB\n");
    assert.deepEqual(boundedDomainRun.snapshot(), beforeDomain);
  } finally {
    await bounded.close();
  }
});

await test("translation discoveries are paged from Host state and resolved into canonical workspace assets", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: false
  });
  domainRun.recordInspection({
    sourceLineCount: 1,
    glossaryCandidateExists: true,
    characterBibleExists: true
  });
  domainRun.recordTranslationDiscoveries([
    {
      id: "gate-open-a", kind: "glossary", documentId: "source", fromLine: 1, toLine: 1,
      sourceHash: "s1", candidateHash: "c1", source: "ゲートオープン", target: "Gate Open",
      category: "setting_term", evidenceLine: 1, rationale: "battle call"
    },
    {
      id: "gate-open-b", kind: "glossary", documentId: "source", fromLine: 1, toLine: 1,
      sourceHash: "s1", candidateHash: "c2", source: "ゲートオープン", target: "开门",
      category: "setting_term", evidenceLine: 1, rationale: "battle call"
    },
    {
      id: "character-yuppi", kind: "character", documentId: "source", fromLine: 1, toLine: 1,
      sourceHash: "s1", candidateHash: "c2", sourceName: "ユッピ", targetName: "优优",
      evidenceLine: 1, evidence: "speaker label", gender: "unknown", confidence: "unknown"
    }
  ]);
  const fx = await fixture({ domainRun }, "ゲートオープン！\n");
  const workspace = path.join(fx.outputDir, "AI_translation", "_workspace");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "glossary_candidates.json"), '{"entries":[]}\n', "utf8");
    await writeFile(path.join(workspace, "character_bible.md"), [
      "# Character Bible", "", "## Existing", "- Localized name: Existing",
      "- Gender/pronouns: unknown; unknown; unknown", "- Terms of address: unknown", ""
    ].join("\n"), "utf8");
    const page = await execute(fx.tool("readTranslationDiscoveries"), { limit: 12 });
    assert.equal(page.details.totalGroups, 2);
    assert.equal(page.details.totalRecords, 3);
    const resolved = await execute(fx.tool("resolveTranslationDiscoveries"), {
      glossary: [{
        source: "ゲートオープン", action: "accept", target: "开门",
        rationale: "Use the established Chinese battle call consistently."
      }],
      characters: [{
        sourceName: "ユッピ", action: "reject",
        rationale: "The current evidence is only an unsupported nickname occurrence."
      }]
    });
    assert.equal(resolved.details.remainingRecordCount, 0);
    const glossary = JSON.parse(await readFile(path.join(workspace, "glossary_candidates.json"), "utf8"));
    assert.deepEqual(glossary.entries.map((entry) => [entry.source, entry.target]), [["ゲートオープン", "开门"]]);
    assert.deepEqual(domainRun.resolvedTranslationTerms(), [{
      source: "ゲートオープン",
      target: "开门",
      observedTargets: ["Gate Open", "开门"]
    }]);
    assert.doesNotMatch(domainRun.incompleteReasons().join("\n"), /resolve .* discovery/i);
  } finally {
    await fx.close();
  }
});

await test("accepted translation splits commit provisional terms immediately and pause the live queue on conflicts", async () => {
  let started;
  const notifications = [];
  const priorityRepairs = [];
  const subagents = {
    hasRunning: () => Boolean(started),
    startTranslationBatch(options) {
      started = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    },
    list: () => started
      ? [{ id: started.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] }]
      : [],
    async notifyParent(message) { notifications.push(message); },
    translationPriorityBatchOwner(task) {
      if (!started) return undefined;
      const scopes = [
        ...started.tasks,
        ...(started.priorityWriteScopes ?? [])
      ];
      return scopes.some((scope) => (
        (scope.documentId ?? "source.txt") === (task.documentId ?? "source.txt")
        && scope.fromLine <= task.fromLine
        && scope.toLine >= task.toLine
      )) ? started.batchId : undefined;
    },
    enqueueTranslationPriorityTasks(batchId, tasks) {
      priorityRepairs.push({ batchId, tasks });
      return tasks.length;
    },
    enqueueTranslationPriorityTasksIfActive(batchId, tasks) {
      return this.enqueueTranslationPriorityTasks(batchId, tasks);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 2,
      reviewSubagentCount: 2,
      translationSplitSize: 1
    }
  }, "ゲートオープン A\nゲートオープン B\n次へ\n");
  const candidate = resolveTranslationCandidatePath({
    outputDir: fx.outputDir,
    sourcePaths: [fx.sourcePath],
    documentId: "source.txt"
  });
  const resultFor = (target, evidenceLine) => ({
    discoveries: {
      glossaryCandidates: [{
        source: "ゲートオープン",
        target,
        category: "setting_term",
        evidenceLine,
        rationale: "battle call"
      }],
      characterFacts: []
    }
  });
  try {
    await execute(fx.tool("inspectTranslationContext"));
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1 },
        { fromLine: 2, toLine: 2 },
        { fromLine: 3, toLine: 3 }
      ]
    });
    assert.ok(started);
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "开门 A\n开启战门 B\n下一步\n", "utf8");

    await started.onTaskCompleted(resultFor("开门", 1), started.tasks[0]);
    const candidateAsset = path.join(fx.outputDir, "AI_translation", "_workspace", "glossary_candidates.json");
    let glossary = JSON.parse(await readFile(candidateAsset, "utf8"));
    assert.deepEqual(glossary.entries.map((entry) => [entry.source, entry.target]), [["ゲートオープン", "开门"]]);
    assert.equal(domainRun.pendingTranslationDiscoveries().length, 0);

    await started.onTaskCompleted(resultFor("开启战门", 2), started.tasks[1]);
    glossary = JSON.parse(await readFile(candidateAsset, "utf8"));
    assert.deepEqual(glossary.entries.map((entry) => [entry.source, entry.target]), [["ゲートオープン", "开门"]],
      "a conflicting later split must not overwrite or duplicate the provisional target");
    assert.equal(started.claimGate.isBlocked(), true);
    await started.claimGate.onQuiescent();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].content, /paused at the terminology commit gate/i);
    let gateOpened = false;
    const gateWait = started.claimGate.wait(new AbortController().signal).then(() => { gateOpened = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(gateOpened, false, "the next split must remain behind the conflict gate");

    await execute(fx.tool("resolveTranslationDiscoveries"), {
      glossary: [{
        source: "ゲートオープン",
        action: "accept",
        target: "开门",
        rationale: "Use the first reviewed battle call consistently."
      }]
    });
    await gateWait;
    assert.equal(gateOpened, true);
    assert.equal(priorityRepairs.length, 1);
    assert.deepEqual(priorityRepairs[0].tasks.map((task) => [task.documentId, task.fromLine, task.toLine]), [
      ["source.txt", 2, 2]
    ]);
    assert.match(priorityRepairs[0].tasks[0].reviewFeedback[0].reason, /use 开门/);

    await writeFile(candidate, "开门 A\n开门 B\n下一步\n", "utf8");
    await started.onTaskCompleted(resultFor("开门", 2), priorityRepairs[0].tasks[0]);
    assert.equal(domainRun.pendingTranslationTerminologyDebt().length, 0);
    assert.equal(domainRun.translationDiscoveryObservations().length, 3,
      "observed evidence must survive provisional commit, conflict resolution, and repair");
  } finally {
    await fx.close();
  }
});

await test("disabled glossary candidates cannot create files, gates, hints, or terminology debt", async () => {
  let started;
  const priorityRepairs = [];
  const subagents = {
    hasRunning: () => Boolean(started),
    startTranslationBatch(options) {
      started = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    },
    list: () => started
      ? [{ id: started.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] }]
      : [],
    async notifyParent() {},
    translationPriorityBatchOwner() { return started?.batchId; },
    enqueueTranslationPriorityTasksIfActive(batchId, tasks) {
      priorityRepairs.push({ batchId, tasks });
      return tasks.length;
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const staleGlossaryRecord = {
    id: "disabled-stale-glossary",
    kind: "glossary",
    documentId: "source.txt",
    fromLine: 1,
    toLine: 1,
    sourceHash: "stale-source",
    candidateHash: "stale-candidate",
    source: "ゲートオープン",
    target: "旧门",
    category: "setting_term",
    evidenceLine: 1,
    rationale: "stale candidate state"
  };
  const staleCharacterRecord = {
    id: "enabled-character",
    kind: "character",
    documentId: "source.txt",
    fromLine: 1,
    toLine: 1,
    sourceHash: "stale-source",
    candidateHash: "stale-candidate",
    sourceName: "ユッピ",
    evidenceLine: 1,
    evidence: "speaker evidence",
    gender: "unknown",
    confidence: "unknown"
  };
  domainRun.recordTranslationDiscoveries([staleGlossaryRecord, staleCharacterRecord]);
  domainRun.recordTranslationDiscoveryConflicts([{
    id: "disabled-stale-conflict",
    batchId: "old-batch",
    source: "ゲートオープン",
    observedTargets: ["旧门", "开门"],
    discoveryIds: [staleGlossaryRecord.id],
    documentIds: ["source.txt"],
    affectedRanges: [{
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash: staleGlossaryRecord.sourceHash,
      candidateHash: staleGlossaryRecord.candidateHash
    }],
    status: "conflict"
  }]);
  domainRun.recordTranslationTerminologyDebt([{
    documentId: "source.txt",
    line: 1,
    source: "ゲートオープン",
    expectedTarget: "开门",
    observedTargets: ["旧门"]
  }]);
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      glossaryCandidates: false,
      characterBible: true,
      subagentEnabled: true,
      subagentCount: 2,
      reviewSubagentCount: 2,
      translationSplitSize: 1
    }
  }, "ゲートオープン A\n次へ\n");
  const candidate = resolveTranslationCandidatePath({
    outputDir: fx.outputDir,
    sourcePaths: [fx.sourcePath],
    documentId: "source.txt"
  });
  const result = {
    discoveries: {
      glossaryCandidates: [{
        source: "ゲートオープン",
        target: "开门",
        category: "setting_term",
        evidenceLine: 1,
        rationale: "must be ignored while disabled"
      }],
      characterFacts: [{
        sourceName: "ユッピ",
        evidenceLine: 1,
        evidence: "speaker evidence",
        gender: "unknown",
        confidence: "unknown"
      }]
    }
  };
  try {
    await execute(fx.tool("inspectTranslationContext"));
    assert.equal(
      Object.hasOwn(fx.tool("resolveTranslationDiscoveries").parameters.properties, "glossary"),
      false,
      "the parent resolver schema must not expose terminology decisions while candidates are disabled"
    );
    await assert.rejects(
      execute(fx.tool("writeProjectFile"), {
        path: "AI_translation/_workspace/glossary_candidates.json",
        content: JSON.stringify({ entries: [] })
      }),
      /Glossary-candidate generation is disabled/i
    );
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { documentId: "source.txt", fromLine: 1, toLine: 1 },
        { documentId: "source.txt", fromLine: 2, toLine: 2 }
      ]
    });
    assert.ok(started);
    assert.equal(started.claimGate, undefined, "the candidate conflict gate must not exist while disabled");
    assert.deepEqual(started.priorityTasks, [], "stale candidate debt must not enter the disabled queue");
    assert.deepEqual(domainRun.pendingTranslationDiscoveryConflicts(), []);
    assert.deepEqual(domainRun.pendingTranslationTerminologyDebt(), []);
    assert.deepEqual(
      domainRun.pendingTranslationDiscoveries().map((record) => record.kind),
      ["character"],
      "disabling candidates must clear only glossary state and preserve enabled character facts"
    );

    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "开门 A\n下一步\n", "utf8");
    await started.onTaskCompleted(result, started.tasks[0]);
    await assert.rejects(
      readFile(path.join(fx.outputDir, "AI_translation", "_workspace", "glossary_candidates.json"), "utf8"),
      (error) => error?.code === "ENOENT"
    );
    assert.equal(priorityRepairs.length, 0);
    assert.equal(domainRun.translationDiscoveryObservations().some((record) => (
      record.kind === "glossary" && record.id !== staleGlossaryRecord.id
    )), false);
    const nextRequest = started.requestForTask(started.tasks[1]);
    assert.deepEqual(nextRequest.priorTranslationDiscoveries.glossaryCandidates, []);
    assert.equal(nextRequest.priorTranslationDiscoveries.characterFacts.length, 1);
  } finally {
    await fx.close();
  }
});

await test("disabled glossary candidates do not rebuild old candidate-derived debt during final validation", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: false
  });
  const oldRecord = {
    id: "old-resolved-candidate-term",
    kind: "glossary",
    documentId: "source.txt",
    fromLine: 1,
    toLine: 1,
    sourceHash: "old-source-hash",
    candidateHash: "old-candidate-hash",
    source: "ゲートオープン",
    target: "旧门",
    category: "setting_term",
    evidenceLine: 1,
    rationale: "old enabled run"
  };
  domainRun.recordTranslationDiscoveries([oldRecord]);
  domainRun.resolveTranslationDiscoveries([oldRecord.id], [{
    source: oldRecord.source,
    target: oldRecord.target,
    observedTargets: [oldRecord.target]
  }]);
  const fx = await fixture({
    domainRun,
    requestPatch: {
      workflowIntent: "translation",
      glossaryCandidates: false,
      characterBible: false,
      subagentEnabled: false
    }
  }, "ゲートオープン\n");
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 1,
      lines: ["开门"]
    });
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 1 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 1 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });
    await execute(fx.tool("validateTranslationArtifact"));
    assert.deepEqual(domainRun.pendingTranslationTerminologyDebt(), []);
  } finally {
    await fx.close();
  }
});

await test("concurrent assignment terminology commits serialize candidate, DomainRun, and Host persistence as one transaction", async () => {
  let started;
  let persistenceFailureArmed = false;
  let failedOnce = false;
  let announceFirstPersist;
  let releaseFirstPersist;
  const firstPersistStarted = new Promise((resolve) => { announceFirstPersist = resolve; });
  const firstPersistRelease = new Promise((resolve) => { releaseFirstPersist = resolve; });
  const subagents = {
    hasRunning: () => Boolean(started),
    startTranslationBatch(options) {
      started = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const fx = await fixture({
    subagents,
    domainRun,
    persistHostState: async () => {
      if (!persistenceFailureArmed || failedOnce) return;
      failedOnce = true;
      announceFirstPersist();
      await firstPersistRelease;
      throw new Error("injected Host persistence failure");
    },
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 2,
      reviewSubagentCount: 2,
      translationSplitSize: 1
    }
  }, "術語A\n術語B\n");
  const candidate = resolveTranslationCandidatePath({
    outputDir: fx.outputDir,
    sourcePaths: [fx.sourcePath],
    documentId: "source.txt"
  });
  const resultFor = (source, target, evidenceLine) => ({
    discoveries: {
      glossaryCandidates: [{ source, target, category: "setting_term", evidenceLine, rationale: "term" }],
      characterFacts: []
    }
  });
  try {
    await execute(fx.tool("inspectTranslationContext"));
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: [{ fromLine: 1, toLine: 1 }, { fromLine: 2, toLine: 2 }]
    });
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "译名A\n译名B\n", "utf8");
    persistenceFailureArmed = true;
    const first = started.onTaskCompleted(resultFor("術語A", "译名A", 1), started.tasks[0]);
    await firstPersistStarted;
    const second = started.onTaskCompleted(resultFor("術語B", "译名B", 2), started.tasks[1]);
    releaseFirstPersist();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    assert.equal(firstResult.status, "rejected");
    assert.equal(secondResult.status, "fulfilled");
    const glossary = JSON.parse(await readFile(
      path.join(fx.outputDir, "AI_translation", "_workspace", "glossary_candidates.json"),
      "utf8"
    ));
    assert.deepEqual(glossary.entries.map((entry) => [entry.source, entry.target]), [["術語B", "译名B"]]);
    assert.deepEqual(domainRun.translationDiscoveryObservations().map((entry) => entry.source), ["術語B"]);
  } finally {
    releaseFirstPersist?.();
    await fx.close();
  }
});

await test("restored terminology conflicts route exact repairs to the current gated batch before it reopens", async () => {
  const sliceHash = (lines) => createHash("sha256").update(JSON.stringify(lines)).digest("hex");
  const sourceHash = sliceHash(["ゲートオープン A"]);
  const oldCandidateHash = sliceHash(["旧译 A"]);
  const newCandidateHash = sliceHash(["标准译 A"]);
  const original = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  original.recordInspection({
    sourceLineCount: 3,
    documents: [{ id: "source.txt", sourceLineCount: 3 }],
    glossaryCandidateExists: false,
    characterBibleExists: false
  });
  original.recordTranslationDiscoveries([
    {
      id: "old-observation",
      kind: "glossary",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash,
      candidateHash: oldCandidateHash,
      source: "ゲートオープン",
      target: "旧译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "old"
    },
    {
      id: "new-observation",
      kind: "glossary",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash,
      candidateHash: newCandidateHash,
      source: "ゲートオープン",
      target: "标准译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "new"
    }
  ]);
  original.recordTranslationDiscoveryConflicts([{
    id: "restored-conflict",
    batchId: "old-batch",
    source: "ゲートオープン",
    observedTargets: ["旧译", "标准译"],
    discoveryIds: ["old-observation", "new-observation"],
    documentIds: ["source.txt"],
    affectedRanges: [{
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash,
      candidateHash: oldCandidateHash
    }],
    status: "conflict"
  }]);
  const restored = createYnDomainRunContract({ restoreSnapshot: original.snapshot() });
  let started;
  const enqueued = [];
  const subagents = {
    hasRunning: () => Boolean(started),
    startTranslationBatch(options) {
      started = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    },
    translationPriorityBatchOwner(task) {
      if (!started) return undefined;
      const owned = [...started.tasks, ...(started.priorityWriteScopes ?? [])].some((scope) => (
        (scope.documentId ?? "source.txt") === (task.documentId ?? "source.txt")
        && scope.fromLine <= task.fromLine
        && scope.toLine >= task.toLine
      ));
      return owned ? started.batchId : undefined;
    },
    enqueueTranslationPriorityTasksIfActive(batchId, tasks) {
      enqueued.push({ batchId, tasks });
      return tasks.length;
    }
  };
  const fx = await fixture({
    subagents,
    domainRun: restored,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1,
      reviewSubagentCount: 1,
      translationSplitSize: 1
    }
  }, "ゲートオープン A\n既訳\n次へ\n");
  const candidate = resolveTranslationCandidatePath({
    outputDir: fx.outputDir,
    sourcePaths: [fx.sourcePath],
    documentId: "source.txt"
  });
  try {
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "旧译 A\n既译\n下一步\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"));
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1 },
        { fromLine: 2, toLine: 2 },
        { fromLine: 3, toLine: 3 }
      ]
    });
    await writeFile(candidate, "旧译 A\n既译\n下一步\n", "utf8");
    assert.notEqual(started.batchId, "old-batch");
    assert.deepEqual(started.priorityWriteScopes, [{ documentId: "source.txt", fromLine: 1, toLine: 1 }]);
    await execute(fx.tool("resolveTranslationDiscoveries"), {
      glossary: [{
        source: "ゲートオープン",
        action: "accept",
        target: "标准译",
        rationale: "Resolve the restored conflict before continuing."
      }]
    });
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].batchId, started.batchId, "the repair was routed back to the stale batch id");
    assert.deepEqual(enqueued[0].tasks.map((task) => [task.documentId, task.fromLine, task.toLine]), [
      ["source.txt", 1, 1]
    ]);
    assert.equal(started.claimGate.isBlocked(), false);
  } finally {
    await fx.close();
  }
});

await test("a restored folder conflict can reserve a repair-only document while original work remains in another file", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-restored-term-"));
  const sourceRoot = path.join(outputDir, "source");
  const aPath = path.join(sourceRoot, "a.txt");
  const bPath = path.join(sourceRoot, "b.txt");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(aPath, "ゲートオープン A\n", "utf8");
  await writeFile(bPath, "次へ\n", "utf8");
  const aCandidate = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [aPath, bPath],
    documentId: "a.txt"
  });
  await mkdir(path.dirname(aCandidate), { recursive: true });
  await writeFile(aCandidate, "旧译 A\n", "utf8");
  const sourceHash = createHash("sha256").update(JSON.stringify(["ゲートオープン A"])).digest("hex");
  const candidateHash = createHash("sha256").update(JSON.stringify(["旧译 A"])).digest("hex");
  const original = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  original.recordInspection({
    sourceLineCount: 1,
    documents: [
      { id: "a.txt", sourceLineCount: 1 },
      { id: "b.txt", sourceLineCount: 1 }
    ],
    glossaryCandidateExists: false,
    characterBibleExists: false
  });
  original.recordTranslationDiscoveries([
    {
      id: "folder-old",
      kind: "glossary",
      documentId: "a.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash,
      candidateHash,
      source: "ゲートオープン",
      target: "旧译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "old"
    },
    {
      id: "folder-new",
      kind: "glossary",
      documentId: "a.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash,
      candidateHash: createHash("sha256").update(JSON.stringify(["标准译 A"])).digest("hex"),
      source: "ゲートオープン",
      target: "标准译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "new"
    }
  ]);
  original.recordTranslationDiscoveryConflicts([{
    id: "folder-conflict",
    batchId: "old-folder-batch",
    source: "ゲートオープン",
    observedTargets: ["旧译", "标准译"],
    discoveryIds: ["folder-old", "folder-new"],
    documentIds: ["a.txt"],
    affectedRanges: [{ documentId: "a.txt", fromLine: 1, toLine: 1, sourceHash, candidateHash }],
    status: "conflict"
  }]);
  const domainRun = createYnDomainRunContract({
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2,
    restoreSnapshot: original.snapshot()
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const acceptedA = createTranslationAlignmentRangeAudit({
    documentId: "a.txt",
    sourceText: "ゲートオープン A",
    candidateText: "旧译 A",
    candidatePath: aCandidate,
    languagePair: "ja->zh-CN",
    fromLine: 1,
    toLine: 1,
    sourceLineCount: 1
  });
  acceptedA.checks.forEach((check) => { check.verdict = "aligned"; });
  translationAlignmentState.ranges["a.txt"] = [acceptedA];
  let started;
  const enqueued = [];
  const subagents = {
    hasRunning: () => Boolean(started),
    startTranslationBatch(options) {
      started = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    },
    translationPriorityBatchOwner(task) {
      if (!started) return undefined;
      return [...started.tasks, ...(started.priorityWriteScopes ?? [])].some((scope) => (
        scope.documentId === task.documentId
        && scope.fromLine <= task.fromLine
        && scope.toLine >= task.toLine
      )) ? started.batchId : undefined;
    },
    enqueueTranslationPriorityTasksIfActive(batchId, tasks) {
      enqueued.push({ batchId, tasks });
      return tasks.length;
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "folder_restored_terminology",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 1,
    subagentEnabled: true,
    subagentCount: 2,
    reviewSubagentCount: 2
  };
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"));
    await execute(tool("runTranslationSubagents"));
    assert.deepEqual(started.tasks.map((task) => task.documentId), ["b.txt"]);
    assert.deepEqual(started.priorityWriteScopes, [{ documentId: "a.txt", fromLine: 1, toLine: 1 }]);
    await execute(tool("resolveTranslationDiscoveries"), {
      glossary: [{
        source: "ゲートオープン",
        action: "accept",
        target: "标准译",
        rationale: "Resolve before the remaining folder queue continues."
      }]
    });
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].batchId, started.batchId);
    assert.deepEqual(enqueued[0].tasks.map((task) => [task.documentId, task.fromLine, task.toLine]), [
      ["a.txt", 1, 1]
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("stale restored conflict hashes are invalidated before they can authorize a repair", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  domainRun.recordTranslationDiscoveries([
    {
      id: "stale-old",
      kind: "glossary",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash: "stale-source-hash",
      candidateHash: "stale-candidate-hash",
      source: "ゲートオープン",
      target: "旧译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "stale"
    },
    {
      id: "stale-new",
      kind: "glossary",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash: "stale-source-hash",
      candidateHash: "stale-candidate-hash-2",
      source: "ゲートオープン",
      target: "标准译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "stale"
    }
  ]);
  domainRun.recordTranslationDiscoveryConflicts([{
    id: "stale-conflict",
    batchId: "stale-batch",
    source: "ゲートオープン",
    observedTargets: ["旧译", "标准译"],
    discoveryIds: ["stale-old", "stale-new"],
    documentIds: ["source.txt"],
    affectedRanges: [{
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash: "stale-source-hash",
      candidateHash: "stale-candidate-hash"
    }],
    status: "conflict"
  }]);
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  }, "ゲートオープン A\n");
  const candidate = resolveTranslationCandidatePath({
    outputDir: fx.outputDir,
    sourcePaths: [fx.sourcePath],
    documentId: "source.txt"
  });
  try {
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "外部修改后的译文\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"));
    await assert.rejects(
      execute(fx.tool("resolveTranslationDiscoveries"), {
        glossary: [{
          source: "ゲートオープン",
          action: "accept",
          target: "标准译",
          rationale: "This stale decision must not be applied."
        }]
      }),
      /No pending terminology discovery/i
    );
    assert.equal(domainRun.pendingTranslationDiscoveryConflicts().length, 0);
    assert.equal(domainRun.pendingTranslationDiscoveries().length, 0);
    assert.equal(domainRun.translationDiscoveryObservations().length, 2,
      "stale pending authorization should be removed without erasing audit evidence");
  } finally {
    await fx.close();
  }
});

await test("failed Monte Carlo batches roll back partial findings and retry the same host sample", async () => {
  const batches = [];
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(args) {
      const batch = { id: `batch_${batches.length + 1}`, status: "running", subagents: [] };
      batches.push({ args, batch });
      return batch;
    }
  };
  const domainRun = {
    kind: "proofread",
    activate() {}, assertCanStartSubagentBatch() {}, recordInspection() {},
    recordSourceRead() {}, recordTranslationRead() {}, recordProofreadPrescan() {},
    assertProofreadPrescanReady() {}, invalidateProofreadPrescan() {},
    recordProofreadArtifactReset() {}, recordSubagentBatchStarted() {},
    recordSubagentBatchFailure() {}, recordProofreadArtifactMutation() {},
    recordSubagentBatch() {}, recordProofreadMontecarloRound() {}
  };
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "proofread",
      workflowIntent: "proofread",
      proofreadMode: "montecarlo",
      proofreadMontecarloSize: 3,
      proofreadMontecarloRoundMax: 3,
      subagentEnabled: true,
      subagentCount: 2
    }
  }, "甲\n乙\n丙\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "A\nB\nC\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("runProofreadSubagents"));
    const firstSample = batches[0].args.tasks.map((task) => task.sampledLines);
    const partial = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      documentId: "source.txt",
      translationPath,
      kind: "findings_json",
      mode: "montecarlo",
      content: JSON.stringify([{
        id: "M1-001", severity: "M1", type: "accuracy",
        sourceLine: 1, translationLine: 1, sourceText: "甲", currentTranslation: "A",
        suggestedFix: "甲", rationale: "partial failed-batch sentinel"
      }])
    });
    assert.equal(partial.ok, true);
    await batches[0].args.onSettled({ batch: batches[0].batch, results: [], error: new Error("child failed") });
    await assert.rejects(readFile(reportPath, "utf8"), { code: "ENOENT" });

    await execute(fx.tool("runProofreadSubagents"));
    assert.deepEqual(batches[1].args.tasks.map((task) => task.sampledLines), firstSample);
  } finally {
    await fx.close();
  }
});

await test("proofreading candidates require typed parent decisions before finalization", async () => {
  let batchArgs;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(args) {
      batchArgs = args;
      return {
        id: args.batchId,
        status: "running",
        subagents: [{ id: "child-1", status: "running" }]
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1,
    proofreadMode: "split"
  });
  const proofreadState = createProofreadHostState();
  const fx = await fixture({
    subagents,
    domainRun,
    proofreadState,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      workflowIntent: "proofread",
      proofreadMode: "split",
      subagentEnabled: true,
      subagentCount: 1
    }
  }, "Alpha\nBeta\nGamma\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "阿尔法\n贝塔\n伽马\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("runProofreadSubagents"), { workerCount: 1 });
    await batchArgs.onSettled({
      batch: { id: batchArgs.batchId, status: "completed", subagents: [] },
      results: [{
        subagentId: "child-1",
        label: "L1-L3",
        providerId: "test",
        modelId: "test",
        modelName: "test",
        resultSummary: "done",
        findingsWritten: 0,
        glossaryCandidates: [
          {
            source: "Alpha",
            target: "阿尔法",
            category: "proper_noun",
            evidenceLine: 1,
            rationale: "Named project entity"
          },
          {
            source: "Beta",
            target: "贝塔",
            category: "proper_noun",
            evidenceLine: 2,
            rationale: "Ordinary test label, parent should reject"
          }
        ]
      }]
    });

    const inspected = await execute(fx.tool("inspectTranslationContext"), {});
    const candidates = inspected.details.proofreadGlossaryCandidates;
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every((candidate) => candidate.status === "pending"));
    const alpha = candidates.find((candidate) => candidate.source === "Alpha");
    proofreadDocumentHostState(proofreadState, "source.txt").glossaryCandidates.push({
      ...alpha,
      evidenceLine: 3,
      rationale: "A second document occurrence represented by legacy per-document state."
    });
    const regrouped = await execute(fx.tool("inspectTranslationContext"), {});
    const groupedCandidates = regrouped.details.proofreadGlossaryCandidates;
    assert.equal(groupedCandidates.length, 2);
    const groupedAlpha = groupedCandidates.find((candidate) => candidate.source === "Alpha");
    assert.equal(groupedAlpha.occurrenceCount, 2);
    assert.equal(groupedAlpha.evidenceSamples.length, 2);
    await assert.rejects(
      execute(fx.tool("finalizeProofreadReport"), {}),
      /resolve 2 pending proofreading glossary candidate/i
    );

    const decision = await execute(fx.tool("resolveProofreadGlossaryCandidates"), {
      decisions: [
        { candidateId: candidates[0].id, action: "accept", rationale: "Project proper name" },
        { candidateId: candidates[1].id, action: "reject", rationale: "Not a glossary-worthy term" }
      ]
    });
    assert.equal(decision.details.pending.length, 0);
    assert.equal(decision.details.accepted, 1);
    assert.equal(decision.details.rejected, 1);
    const glossary = JSON.parse(await readFile(
      path.join(fx.outputDir, "AI_translation", "_workspace", "glossary_candidates.json"),
      "utf8"
    ));
    assert.deepEqual(glossary.entries.map((entry) => [entry.source, entry.target]), [["Alpha", "阿尔法"]]);
  } finally {
    await fx.close();
  }
});

await test("project-enabled local repair may launch a bounded translation child batch without magic words", async () => {
  let capturedTasks = [];
  let capturedMaxWorkers = 0;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      capturedTasks = args.tasks;
      capturedMaxWorkers = args.maxWorkers;
      return { id: args.batchId, status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 4
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: { subagentEnabled: true, subagentCount: 4 }
  });
  try {
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      label: `Investigate issue ${index + 1}`,
      prompt: `Investigate bounded issue ${index + 1}.`,
      mode: "investigate"
    }));
    await execute(fx.tool("runSubagents"), { tasks });
    assert.equal(capturedTasks.length, 6, "general delegation must preserve every concrete queued task");
    assert.equal(capturedMaxWorkers, 4, "queued general tasks must not bypass the configured 1..N live-worker ceiling");
  } finally {
    await fx.close();
  }
});

await test("an explicit user delegation can use partial local-repair ranges without activating the full workflow", async () => {
  let capturedTasks = [];
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      capturedTasks = args.tasks;
      return { id: args.batchId, status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: false
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      subagentEnabled: true,
      subagentCount: 2
    }
  }, "一\n二\n三\n四\n");
  try {
    await execute(fx.tool("runSubagents"), {
      tasks: [
        {
          label: "Repair source.txt L2",
          prompt: "Repair only source.txt line 2.",
          mode: "translation_repair",
          documentId: "source.txt",
          fromLine: 2,
          toLine: 2
        },
        {
          label: "Repair source.txt L4",
          prompt: "Repair only source.txt line 4.",
          mode: "translation_repair",
          documentId: "source.txt",
          fromLine: 4,
          toLine: 4
        }
      ]
    });
    assert.deepEqual(capturedTasks.map(({ fromLine, toLine }) => ({ fromLine, toLine })), [
      { fromLine: 2, toLine: 2 },
      { fromLine: 4, toLine: 4 }
    ]);
    assert.equal(domainRun.maximumSubagentsForActiveDocument, 0);
  } finally {
    await fx.close();
  }
});

await test("an explicit user request launches five prompt-defined general Pi children instead of restarting translation", async () => {
  let captured;
  let translationStarts = 0;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return {
        id: "batch_general_user_request",
        status: "running",
        subagents: args.tasks.map((task, index) => ({ id: `child_${index + 1}`, label: task.label }))
      };
    },
    startTranslationBatch() {
      translationStarts += 1;
      throw new Error("the fixed translation workflow must not be used for a general delegation");
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "先定位确切内容，再叫五个 subagents 并行修复。",
      subagentEnabled: true,
      subagentCount: 5
    }
  }, "一\n二\n三\n四\n五\n");
  try {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      label: `精确修复 ${index + 1}`,
      prompt: `检查并修复已经定位的第 ${index + 1} 行；不要重翻其他内容。`,
      mode: "investigate"
    }));
    const result = await execute(fx.tool("runSubagents"), { tasks });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 5);
    assert.deepEqual(captured.tasks.map((task) => task.prompt), tasks.map((task) => task.prompt));
    assert.equal(captured.maxWorkers, 5);
    assert.equal(translationStarts, 0);
  } finally {
    await fx.close();
  }
});

await test("an explicit delegation without a stated count accepts any useful 1..N task batch", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return {
        id: "batch_general_up_to_five",
        status: "running",
        subagents: args.tasks.map((task, index) => ({ id: `up_to_child_${index + 1}`, label: task.label }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "请用子 agents 修复已经定位的两个独立问题。",
      subagentEnabled: true,
      subagentCount: 5
    }
  });
  try {
    const result = await execute(fx.tool("runSubagents"), { tasks: [
      { label: "修复 A", prompt: "修复已定位问题 A。", mode: "investigate" },
      { label: "修复 B", prompt: "修复已定位问题 B。", mode: "investigate" }
    ] });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 2);
    assert.equal(captured.maxWorkers, 2);
  } finally {
    await fx.close();
  }
});

await test("project-enabled subagents can be used for a bounded task without magic words in the current message", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return {
        id: "batch_project_enabled",
        status: "running",
        subagents: args.tasks.map((task, index) => ({ id: `project_child_${index + 1}`, label: task.label }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 2
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "定位两处彼此独立的翻译问题并修正。",
      subagentEnabled: true,
      subagentCount: 2
    }
  });
  try {
    const result = await execute(fx.tool("runSubagents"), { tasks: [
      { label: "定位 A", prompt: "定位第一处问题并返回证据。", mode: "investigate" },
      { label: "定位 B", prompt: "定位第二处问题并返回证据。", mode: "investigate" }
    ] });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 2);
    assert.equal(captured.maxWorkers, 2);
  } finally {
    await fx.close();
  }
});

await test("project-enabled delegation may use fewer useful lanes than its configured maximum", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return {
        id: "batch_project_enabled_one_lane",
        status: "running",
        subagents: args.tasks.map((task, index) => ({ id: `project_child_${index + 1}`, label: task.label }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 4
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "请独立检查这个疑似错译。",
      subagentEnabled: true,
      subagentCount: 4
    }
  });
  try {
    const result = await execute(fx.tool("runSubagents"), { tasks: [
      { label: "定位证据", prompt: "定位疑似错译并返回文件与行号证据。", mode: "investigate" }
    ] });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 1);
    assert.equal(captured.maxWorkers, 1);
  } finally {
    await fx.close();
  }
});

await test("an active proofread child batch does not block a scoped translation repair or replace workflow coverage", async () => {
  let starts = 0;
  let captured;
  const subagents = {
    hasRunning: () => true,
    startGeneralBatch(args) {
      starts += 1;
      captured = args;
      return { id: "batch_full_workflow_local", status: "running", subagents: [{ id: "child_local", label: "局部修复" }] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "继续完成剩余翻译任务。",
      subagentEnabled: true,
      subagentCount: 3
    }
  });
  try {
    const result = await execute(fx.tool("runSubagents"), {
      tasks: [{
        label: "局部修复",
        prompt: "修复已定位的第 1 行；不要重启整批工作流。",
        mode: "translation_repair",
        documentId: "source.txt",
        fromLine: 1,
        toLine: 1
      }]
    });
    assert.equal(result.details.status, "running");
    assert.equal(starts, 1);
    assert.equal(captured.tasks.length, 1);
    assert.match(domainRun.incompleteReasons().join("\n"), /inspect translation context|host-accepted batch/i);
  } finally {
    await fx.close();
  }
});

await test("a prior full-workflow exact worker count does not force a later bounded repair to fill every lane", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return { id: "batch_full_workflow_sparse", status: "running", subagents: [{ id: "child_sparse", label: "单行返修" }] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "修复刚刚定位的第 1 行并继续。",
      subagentEnabled: true,
      subagentCount: 5
    }
  });
  try {
    const result = await execute(fx.tool("runSubagents"), { tasks: [{
      label: "单行返修",
      prompt: "只修复第 1 行。",
      mode: "translation_repair",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1
    }] });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 1);
    assert.equal(captured.maxWorkers, 1);
  } finally {
    await fx.close();
  }
});

await test("a bounded child repair inside a full workflow reopens only its exact changed rows", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return { id: "batch_full_workflow_exact_debt", status: "running", subagents: [] };
    }
  };
  const sourceLines = Array.from({ length: 1_024 }, (_, index) =>
    `Source row ${index + 1} contains a distinct complete sentence for review.`
  );
  const candidateLines = sourceLines.map((_line, index) => `这是第 ${index + 1} 行独立且完整的中文译文。`);
  const translationAlignmentState = createTranslationAlignmentHostState();
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    subagents,
    domainRun,
    translationAlignmentState,
    requestPatch: {
      prompt: "修复已定位的一行并继续原工作流。",
      languagePair: "en->zh-CN",
      subagentEnabled: true,
      subagentCount: 5
    }
  }, `${sourceLines.join("\n")}\n`);
  const resolvedCandidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(resolvedCandidatePath), { recursive: true });
    await writeFile(resolvedCandidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    const accepted = createTranslationChunkReviewAudit({
      documentId: "source.txt",
      sourceText: sourceLines.join("\n"),
      candidateText: candidateLines.join("\n"),
      candidatePath: resolvedCandidatePath,
      languagePair: "en->zh-CN",
      fromLine: 1,
      sourceLineCount: sourceLines.length
    });
    accepted.checks.forEach((check) => { check.verdict = "aligned"; });
    translationAlignmentState.ranges["source.txt"] = [accepted];

    await execute(fx.tool("runSubagents"), { tasks: [{
      label: "L409 定点返修",
      prompt: "只修复第 409 行，并保留上下文与行身份。",
      mode: "translation_repair",
      documentId: "source.txt",
      fromLine: 409,
      toLine: 409
    }] });
    candidateLines[408] = "这是完成定点返修后的第四百零九行译文。";
    await writeFile(resolvedCandidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    await captured.onArtifactMutation("source.txt", { fromLine: 409, toLine: 409 });

    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.deepEqual(audit.details.pendingLines, [409]);
    assert.equal(audit.details.pendingCount, 1);
    assert.ok(
      translationAlignmentState.ranges["source.txt"][0].checks.length < 50,
      "a one-line local repair must not recreate 1,024 rows of semantic review debt"
    );
    await execute(fx.tool("readSourceLines"), { fromLine: 409, toLine: 409 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 409, toLine: 409 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });
    assert.equal(
      translationAlignmentState.ranges["source.txt"][0].checks.filter((check) => !check.verdict).length,
      0,
      "the exact parent review must close the sparse repair without reopening the full workflow"
    );
  } finally {
    await fx.close();
  }
});

await test("an explicit local investigation may use native Pi children without satisfying full-workflow debt", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return { id: "batch_explicit_investigation", status: "running", subagents: [{ id: "child_1", label: "定位" }] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "叫 subagents 定位剩余译文中的错位证据。",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 3
    }
  });
  try {
    const result = await execute(fx.tool("runSubagents"), {
      tasks: [{ label: "定位", prompt: "只读定位错位行并返回证据。", mode: "investigate" }]
    });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 1);
    assert.doesNotMatch(
      domainRun.incompleteReasons().join("\n"),
      /prompt-defined|user-requested delegation|explicitly requested native Pi/i,
      "local child work must not add generic full-workflow completion debt"
    );
  } finally {
    await fx.close();
  }
});

await test("bounded repair may use any independently useful count up to the configured maximum", async () => {
  let captured;
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      captured = args;
      return {
        id: "batch_bounded_five_lanes",
        status: "running",
        subagents: args.tasks.map((task, index) => ({ id: `repair_child_${index + 1}`, label: task.label }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 5
  });
  const sourceText = `${Array.from({ length: 120 }, (_, index) => `Source ${index + 1}`).join("\n")}\n`;
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      subagentEnabled: true,
      subagentCount: 5,
      translationSplitSize: 1000,
      languagePair: "en->zh-CN"
    }
  }, sourceText);
  try {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      label: `repair ${index + 1}`,
      prompt: `Repair bounded range ${index * 24 + 1}-${(index + 1) * 24}.`,
      mode: "translation_repair",
      fromLine: index * 24 + 1,
      toLine: (index + 1) * 24
    }));
    const result = await execute(fx.tool("runSubagents"), { tasks });
    assert.equal(result.details.status, "running");
    assert.equal(captured.tasks.length, 5);
    assert.equal(captured.maxWorkers, 5);
  } finally {
    await fx.close();
  }
});

await test("five prompt-defined general tasks keep full prompts and replies only in child Pi sessions", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 20, max: 40 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const response = (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
    return toolResults === 0
      ? fauxAssistantMessage(fauxToolCall("listProjectDir", { path: "." }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxText("已完成精确定位并向主 Agent 返回证据。"));
  };
  faux.setResponses(Array.from({ length: 10 }, () => response));
  const cards = [];
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "先定位确切内容，再叫五个 subagents 并行修复。",
      subagentEnabled: true,
      subagentCount: 5
    },
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      label: `调查 ${index + 1}`,
      prompt: `独立检查问题区域 ${index + 1}，返回文件与行号证据。`,
      mode: "investigate"
    }));
    const started = await execute(fx.tool("runSubagents"), { tasks });
    assert.equal(started.details.subagents.length, 5);
    await fx.subagents.waitForAll();
    const terminal = cards.filter((card) => card.details.status === "completed");
    assert.equal(terminal.length, 5);
    assert.equal(terminal.every((card) => card.customType === "subagent.general"), true);
    assert.equal(terminal.every((card) => !("prompt" in card.details) && !("reply" in card.details)), true);
    const childTurns = await Promise.all(terminal.map((card) => fx.subagents.inspectTranscript(card.details.subagentId)));
    assert.deepEqual(
      childTurns.map((messages) => messages.find((message) => message.role === "user")?.content?.[0]?.text).sort(),
      tasks.map((task) => task.prompt).sort()
    );
    assert.equal(childTurns.every((messages) => messages.some((message) => (
      message.role === "assistant"
      && message.content.some((block) => block.type === "text" && /返回证据/.test(block.text))
    ))), true);
    await assert.rejects(
      readFile(path.join(fx.outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      { code: "ENOENT" }
    );
  } finally {
    await fx.close();
  }
});

await test("prompt-defined translation repairs preserve exact local objectives and use the validated child writer", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 20, max: 40 } });
  const models = createModels();
  models.setProvider(faux.provider);
  let repairCoachingPrompt = "";
  const response = (context) => {
    const toolResultMessages = context.messages.filter((message) => message.role === "toolResult");
    if (context.systemPrompt.includes("general-purpose native Pi subagent")) {
      return toolResultMessages.length === 0
        ? fauxAssistantMessage(fauxToolCall("listProjectDir", { path: "." }), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxText("已定位第 3 行并返回证据。"));
    }
    if (toolResultMessages.length === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
    }
    const failedRepair = toolResultMessages.find((message) => message.toolName === "repairAssignedTranslation" && message.isError);
    const successfulRepair = toolResultMessages.find((message) => message.toolName === "repairAssignedTranslation" && !message.isError);
    const projectReadAfterFailure = toolResultMessages.find((message) => message.toolName === "readProjectFile");
    const validated = toolResultMessages.find((message) => message.toolName === "validateAssignedTranslation" && !message.isError);
    const latestUser = [...context.messages].reverse().find((message) => message.role === "user");
    const latestUserText = typeof latestUser?.content === "string"
      ? latestUser.content
      : (latestUser?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (!failedRepair && !successfulRepair) {
      const content = toolResultMessages[0].content;
      const payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
      assert.deepEqual(payload.currentTranslationEntries, ["1:旧问候 {name}"]);
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 2, translation: "错误范围" }]
      }), { stopReason: "toolUse" });
    }
    if (failedRepair && !projectReadAfterFailure) {
      return fauxAssistantMessage(
        fauxToolCall("readProjectFile", { path: "source.txt" }),
        { stopReason: "toolUse" }
      );
    }
    if (failedRepair && !successfulRepair && !/Latest host tool rejection:/i.test(latestUserText)) {
      return fauxAssistantMessage(fauxText("第一次受管写入被宿主拒绝。"));
    }
    if (failedRepair && !successfulRepair) {
      repairCoachingPrompt = latestUserText;
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 1, translation: "你好 {name}" }]
      }), { stopReason: "toolUse" });
    }
    if (successfulRepair && !validated) {
      return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {
        misalignedLines: []
      }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("精确修复完成。"));
  };
  faux.setResponses(Array.from({ length: 10 }, () => response));
  const cards = [];
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 2
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "请叫两个 subagents 只修复已经定位的第 1 行和第 3 行。",
      subagentEnabled: true,
      subagentCount: 2
    },
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    const existingCandidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(existingCandidatePath), { recursive: true });
    await writeFile(existingCandidatePath, "旧问候 {name}\n现有第二行\n现有第三行\n现有第四行\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("runSubagents"), { tasks: [
      { label: "修复问候", prompt: "只修复第 1 行问候语。", mode: "translation_repair", fromLine: 1, toLine: 1 },
      { label: "调查告别语", prompt: "只调查第 3 行并返回证据，不要修改。", mode: "investigate", fromLine: 3, toLine: 3 }
    ] });
    await fx.subagents.waitForAll();
    const terminal = cards.filter((card) => card.details.status === "completed");
    assert.equal(
      terminal.length,
      2,
      JSON.stringify(cards.filter((card) => card.details.status === "failed").map((card) => card.details.error))
    );
    const repairCard = terminal.find((card) => card.customType === "subagent.translation");
    const repairTranscript = await fx.subagents.inspectTranscript(repairCard.details.subagentId);
    const repairPrompt = repairTranscript.find((message) => message.role === "user")?.content?.[0]?.text ?? "";
    assert.match(repairPrompt, /^Parent-delegated bounded repair: 只修复第 1 行问候语。/);
    assert.match(repairPrompt, new RegExp(`Source file \\(read-only, UTF-8\\): ${fx.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(repairPrompt, new RegExp(`Current translation candidate \\(UTF-8\\): ${existingCandidatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(repairPrompt, /L1-L1 \(1-based, inclusive\)/);
    assert.match(repairPrompt, /Never write to the source file/i);
    assert.match(
      repairCoachingPrompt,
      /Latest host tool rejection: Validation failed[\s\S]*entries\.0\.line: must be <= 1/i
    );
    assert.match(repairCoachingPrompt, /still write-capable/i);
    const investigationCard = terminal.find((card) => card.customType === "subagent.general");
    const investigationTranscript = await fx.subagents.inspectTranscript(investigationCard.details.subagentId);
    assert.equal(
      investigationTranscript.find((message) => message.role === "user")?.content?.[0]?.text,
      "只调查第 3 行并返回证据，不要修改。"
    );
    const translated = await readFile(path.join(fx.outputDir, "AI_translation", "source_translated.txt"), "utf8");
    assert.equal(translated.split(/\r?\n/u)[0], "你好 {name}");
  } finally {
    await fx.close();
  }
});

await test("a resumed validated repair keeps the parent's exact delegated objective in the child turn", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 20, max: 40 } });
  const models = createModels();
  models.setProvider(faux.provider);
  let firstChildPrompt = "";
  const response = (context) => {
    const toolResults = context.messages.filter((message) => message.role === "toolResult");
    if (!firstChildPrompt) {
      const firstUser = context.messages.find((message) => message.role === "user");
      firstChildPrompt = firstUser?.content?.[0]?.text ?? "";
    }
    if (toolResults.length === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
    }
    if (toolResults.length === 1) {
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: 1, translation: "英雄术语" }]
      }), { stopReason: "toolUse" });
    }
    if (toolResults.length === 2) {
      return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {
        misalignedLines: []
      }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("保留父任务的精确修复已完成。"));
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 1
  });
  const cards = [];
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "叫一个 subagent 修复已经定位的问候语。",
      subagentEnabled: true,
      subagentCount: 1,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  }, "HeroTerm\nsecond\nthird\n");
  const uniqueObjective = "只修复第 1 行丢失的 {name}，不要重翻其他行。";
  try {
    const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.join(fx.outputDir, ".translation-workshop"), { recursive: true });
    await writeFile(path.join(fx.outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
      entries: [{ source: "HeroTerm", target: "英雄术语" }]
    }), "utf8");
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, "英雄\n第二\n第三\n", "utf8");
    await execute(fx.tool("runSubagents"), { tasks: [{
      label: "恢复问候语",
      prompt: uniqueObjective,
      mode: "translation_repair",
      fromLine: 1,
      toLine: 1
    }] });
    await fx.subagents.waitForAll();
    const terminal = cards.filter((card) => card.details?.closed === true);
    assert.equal(terminal.length, 1, JSON.stringify(terminal.map((card) => card.details?.error)));
    assert.equal(terminal[0].details.status, "completed", terminal[0].details.error);
    assert.ok(firstChildPrompt.includes(uniqueObjective), firstChildPrompt);
    assert.match(firstChildPrompt, /host rejected|repair/i);
    assert.equal((await readFile(candidatePath, "utf8")).split(/\r?\n/u)[0], "英雄术语");
  } finally {
    await fx.close();
  }
});

await test("proofreading defaults to a useful worker count instead of filling the configured maximum", async () => {
  let capturedTasks = [];
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(args) {
      capturedTasks = args.tasks;
      return { id: "batch_effective_count", status: "running", subagents: [] };
    }
  };
  const fx = await fixture({
    subagents,
    requestPatch: {
      prompt: "proofread",
      workflowIntent: "proofread",
      subagentEnabled: true,
      subagentCount: 5,
      proofreadMode: "split"
    }
  }, "甲\n乙\n");
  try {
    const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "A\nB\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("runProofreadSubagents"));
    assert.equal(capturedTasks.length, 1);
    assert.deepEqual(capturedTasks.map(({ fromLine, toLine }) => [fromLine, toLine]), [[1, 2]]);
  } finally {
    await fx.close();
  }
});

await test("a bounded re-proofread uses a hash-bound local scope without rerunning the full prescan", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Re-proofread only line 2 after the accepted edit.",
      workflowIntent: "proofread"
    }
  }, "one\ntwo\nthree\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n二\n三\n", "utf8");
    const scoped = await execute(fx.tool("inspectProofreadRange"), { fromLine: 2, toLine: 2 });
    assert.equal(scoped.details.fromLine, 2);
    assert.equal(scoped.details.toLine, 2);
    assert.ok(scoped.details.scopeId);

    const written = await execute(fx.tool("writeProofreadFindings"), {
      scopeId: scoped.details.scopeId,
      findings: [{
        id: "M1-local-2",
        severity: "M1",
        type: "accuracy",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "two",
        currentTranslation: "二",
        suggestedFix: "两个",
        rationale: "The accepted edit needs a bounded semantic re-check."
      }]
    });
    assert.equal(written.details.appended, true);
    const fullWorkflowDocument = domainRun.snapshot().documents.find((document) => document.id === "source.txt");
    assert.ok(fullWorkflowDocument);
    assert.equal(fullWorkflowDocument.proofreadPrescanCompleted, false);
    assert.equal(fullWorkflowDocument.findingsWritten, false);
    assert.equal(fullWorkflowDocument.proofreadArtifactRevision, 0);
    assert.ok(domainRun.incompleteReasons().length > 0,
      "a bounded local finding must not satisfy the full proofreading completion contract");
    await assert.rejects(
      execute(fx.tool("writeProofreadFindings"), {
        scopeId: scoped.details.scopeId,
        findings: [{
          id: "M1-outside-3",
          severity: "M1",
          type: "accuracy",
          sourceLine: 3,
          translationLine: 3,
          sourceText: "three",
          currentTranslation: "三",
          suggestedFix: "三个",
          rationale: "Outside the inspected local scope."
        }]
      }),
      /outside.*proofread range|scope.*line 3/i
    );
  } finally {
    await fx.close();
  }
});

await test("an exact repair during full proofreading preserves the candidate and invalidates only that proofread range", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const proofreadState = createProofreadHostState();
  const fx = await fixture({
    domainRun,
    proofreadState,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      languagePair: "en->zh-CN"
    }
  }, "one\ntwo\nthree\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n旧二\n三\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    const beforeHash = proofreadState.documents["source.txt"].prescan.inputHash;
    proofreadState.documents["source.txt"].sampledLines = [1, 3];
    proofreadState.documents["source.txt"].reportInitialized = true;

    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 2,
      toLine: 2,
      lines: ["两个"]
    });

    assert.equal(domainRun.kind, "proofread");
    assert.equal(await readFile(translationPath, "utf8"), "一\n两个\n三\n");
    assert.equal(domainRun.snapshot().documents[0].proofreadPrescanCompleted, true);
    assert.deepEqual(domainRun.snapshot().documents[0].proofreadDirtyRanges, [{ fromLine: 2, toLine: 2 }]);
    assert.notEqual(proofreadState.documents["source.txt"].prescan.inputHash, beforeHash);
    assert.deepEqual(proofreadState.documents["source.txt"].sampledLines, [1, 3]);
    assert.equal(proofreadState.documents["source.txt"].reportInitialized, true);

    const scoped = await execute(fx.tool("inspectProofreadRange"), { fromLine: 2, toLine: 2 });
    await execute(fx.tool("writeProofreadFindings"), {
      scopeId: scoped.details.scopeId,
      findings: []
    });
    assert.deepEqual(
      domainRun.snapshot().documents[0].proofreadDirtyRanges,
      [],
      "a hash-bound scoped re-review must settle only the repaired range"
    );
    assert.equal(domainRun.snapshot().documents[0].proofreadPrescanCompleted, true);
  } finally {
    await fx.close();
  }
});

await test("a prompt-defined child repair during proofreading refreshes only its exact proofread range", async () => {
  let captured;
  const subagents = {
    hasRunning: () => true,
    startGeneralBatch(args) {
      captured = args;
      return { id: "batch_proofread_exact_repair", status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  const proofreadState = createProofreadHostState();
  const fx = await fixture({
    subagents,
    domainRun,
    proofreadState,
    requestPatch: {
      prompt: "只修复已定位的第 2 行，不要重启完整校对。",
      workflowIntent: "proofread",
      languagePair: "en->zh-CN",
      subagentEnabled: true,
      subagentCount: 3
    }
  }, "one\ntwo\nthree\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n旧二\n三\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    const beforeHash = proofreadState.documents["source.txt"].prescan.inputHash;
    proofreadState.documents["source.txt"].sampledLines = [1, 3];
    proofreadState.documents["source.txt"].reportInitialized = true;

    await execute(fx.tool("runSubagents"), { tasks: [{
      label: "L2 定点返修",
      prompt: "只修复 source.txt 第 2 行并保留行身份。",
      mode: "translation_repair",
      documentId: "source.txt",
      fromLine: 2,
      toLine: 2
    }] });
    await writeFile(translationPath, "一\n两个\n三\n", "utf8");
    await captured.onArtifactMutation("source.txt", { fromLine: 2, toLine: 2 });

    assert.equal(domainRun.kind, "proofread");
    assert.deepEqual(domainRun.snapshot().documents[0].proofreadDirtyRanges, [{ fromLine: 2, toLine: 2 }]);
    assert.notEqual(proofreadState.documents["source.txt"].prescan.inputHash, beforeHash);
    assert.deepEqual(proofreadState.documents["source.txt"].sampledLines, [1, 3]);
    assert.equal(proofreadState.documents["source.txt"].reportInitialized, true);
    assert.doesNotMatch(domainRun.incompleteReasons().join("\n"), /inspect translation context|host-accepted translation batch/i);
  } finally {
    await fx.close();
  }
});

await test("a bounded re-proofread does not return whitelisted deterministic risks", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "Re-proofread the bounded range.",
      workflowIntent: "proofread",
      languagePair: "en->zh-CN",
      auditWhitelistLines: [1]
    }
  }, "First sentence. Second sentence.\nAnother source line.\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "第一句和第二句\n另一行译文。\n", "utf8");
    const scoped = await execute(fx.tool("inspectProofreadRange"), { fromLine: 1, toLine: 2 });
    assert.equal(
      scoped.details.deterministicSignals.some((signal) => signal.line === 1),
      false,
      JSON.stringify(scoped.details.deterministicSignals)
    );
  } finally {
    await fx.close();
  }
});

await test("a bounded re-proofread can clear a stale finding after the translation changed", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "Re-proofread only line 2 after the accepted edit.",
      workflowIntent: "proofread"
    }
  }, "one\ntwo\nthree\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n旧译文\n三\n", "utf8");
    const seeded = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      documentId: "source.txt",
      translationPath,
      kind: "findings_json",
      content: JSON.stringify([{
        id: "H1-504",
        severity: "H1",
        type: "accuracy",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "two",
        currentTranslation: "旧译文",
        suggestedFix: "修订后的译文",
        rationale: "The old translation was inaccurate."
      }])
    });
    assert.equal(seeded.ok, true, seeded.error);

    await writeFile(translationPath, "一\n修订后的译文\n三\n", "utf8");
    const scoped = await execute(fx.tool("inspectProofreadRange"), { fromLine: 2, toLine: 2 });
    const written = await execute(fx.tool("writeProofreadFindings"), {
      scopeId: scoped.details.scopeId,
      findings: []
    });

    assert.equal(written.details.replacedFindingCount, 1);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.findings, []);
  } finally {
    await fx.close();
  }
});

await test("the first full proofread write validates before replacing the existing report", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const proofreadState = createProofreadHostState();
  const fx = await fixture({
    domainRun,
    proofreadState,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      languagePair: "en->zh-CN"
    }
  }, "one\ntwo\nthree\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n二\n三\n", "utf8");
    const seeded = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      translationPath,
      documentId: "source.txt",
      kind: "findings_json",
      mode: "split",
      content: JSON.stringify([{
        id: "M1-old",
        severity: "M1",
        type: "accuracy",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "two",
        currentTranslation: "二",
        suggestedFix: "旧建议",
        rationale: "old report sentinel"
      }])
    });
    assert.equal(seeded.ok, true, seeded.error);
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordProofreadParentReview"), { fromLine: 1, toLine: 3 });
    const reportBefore = await readFile(seeded.path, "utf8");

    await assert.rejects(
      execute(fx.tool("writeProofreadFindings"), {
        findings: [{
          id: "H1-new",
          severity: "H1",
          type: "accuracy",
          sourceLine: 2,
          translationLine: 2,
          sourceText: "two",
          currentTranslation: "错误绑定",
          suggestedFix: "新建议",
          rationale: "invalid incoming replacement"
        }]
      }),
      /currentTranslation.*line 2/i
    );
    assert.equal(await readFile(seeded.path, "utf8"), reportBefore);
    assert.equal(proofreadDocumentHostState(proofreadState, "source.txt").reportInitialized, false);

    await execute(fx.tool("writeProofreadFindings"), {
      findings: [{
        id: "H1-new",
        severity: "H1",
        type: "accuracy",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "two",
        currentTranslation: "二",
        suggestedFix: "新建议",
        rationale: "valid incoming replacement"
      }]
    });
    const report = JSON.parse(await readFile(seeded.path, "utf8"));
    assert.equal(report.findings.some((finding) => finding.suggestedFix === "旧建议"), false);
    assert.equal(report.findings.some((finding) => finding.suggestedFix === "新建议"), true);
    assert.equal(Object.hasOwn(report, "summaryPath"), false);
    assert.equal(proofreadDocumentHostState(proofreadState, "source.txt").reportInitialized, true);
  } finally {
    await fx.close();
  }
});

await test("proofread readiness is checked before JSON finalization or legacy cleanup", async () => {
  const domainRun = {
    kind: "proofread",
    activate() {},
    recordInspection() {},
    recordSourceRead() {},
    recordTranslationRead() {},
    recordProofreadPrescan() {},
    assertProofreadPrescanReady() {},
    assertProofreadReportReady() { throw new Error("proofread convergence incomplete"); },
    recordProofreadReportFinalized() { assert.fail("report finalization must not be recorded"); }
  };
  const fx = await fixture({ domainRun, requestPatch: { prompt: "proofread" } });
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  const summaryPath = path.join(fx.outputDir, "report", "source_proofread_summary.md");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, "legacy summary", "utf8");
    await writeFile(translationPath, "你好 {name}\n\n再见\n", "utf8");
    const findings = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      documentId: "source.txt",
      translationPath,
      kind: "findings_json",
      content: "[]"
    });
    assert.equal(findings.ok, true);
    await execute(fx.tool("inspectTranslationContext"), {});
    await assert.rejects(execute(fx.tool("finalizeProofreadReport")), /convergence incomplete/i);
    assert.equal(await readFile(summaryPath, "utf8"), "legacy summary");
  } finally {
    await fx.close();
  }
});

await test("native YN toolset contains no legacy job or approval protocol", async () => {
  const fx = await fixture();
  try {
    const names = fx.tools.map((tool) => tool.name);
    assert.ok(names.includes("writeTranslationChunk"));
    assert.ok(names.includes("runSubagents"));
    assert.ok(names.includes("runTranslationSubagents"));
    assert.ok(names.includes("inspectSubagents"));
    assert.ok(names.includes("steerSubagent"));
    assert.ok(names.includes("fetchWebReference"));
    for (const forbidden of ["waitForHuman", "requestHumanApproval", "completeTask", "resumeJob", "readSkillReference"]) {
      assert.equal(names.includes(forbidden), false);
    }
  } finally {
    await fx.close();
  }
});

await test("parent Pi tool fetches a web reference through the shared host service", async () => {
  const calls = [];
  const fx = await fixture({
    webReferences: {
      async fetch(args) {
        calls.push(args);
        return {
          requestedUrl: args.url,
          finalUrl: args.url,
          title: "ゼノンザード",
          text: "デジタルカードゲーム",
          fetchedAt: "2026-07-16T00:00:00.000Z",
          contentType: "application/json",
          sourceType: "mediawiki",
          cacheHit: false,
          truncated: false
        };
      }
    }
  });
  try {
    const result = await execute(fx.tool("fetchWebReference"), {
      url: "https://ja.wikipedia.org/wiki/example",
      maxChars: 20_000
    });
    assert.equal(result.details.title, "ゼノンザード");
    assert.equal(result.details.text, "デジタルカードゲーム");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workspaceDir, fx.outputDir);
    assert.equal(calls[0].maxChars, 20_000);
  } finally {
    await fx.close();
  }
});

await test("ordinary Pi chat tools do not resolve or reject a missing source manifest", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-no-source-"));
  const publishCustomMessage = async () => {};
  const subagents = new YnSubagentSupervisor({ publishCustomMessage });
  let unhandled;
  const onUnhandled = (error) => {
    unhandled = error;
  };
  process.once("unhandledRejection", onUnhandled);
  try {
    const tools = createYnDomainTools({
      request: {
        outputDir,
        sessionId: "pi_chat",
        prompt: "hello",
        providerId: "test",
        modelId: "test"
      },
      publishCustomMessage,
      subagents
    });
    const list = tools.find((tool) => tool.name === "listProjectDir");
    assert.ok(list);
    await execute(list, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("parent Pi read-only tools accept user-provided absolute references outside the project", async () => {
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-parent-external-reference-"));
  const externalPath = path.join(externalDir, "reference.md");
  const fx = await fixture();
  try {
    await writeFile(externalPath, "External lore: Aurora Bridge\n", "utf8");

    const read = await execute(fx.tool("readProjectFile"), { path: externalPath });
    assert.equal(read.details.outsideProject, true);
    assert.match(read.details.content, /Aurora Bridge/);

    const listed = await execute(fx.tool("listProjectDir"), { path: externalDir });
    assert.equal(listed.details.outsideProject, true);
    assert.ok(listed.details.entries.some((entry) => entry.name === "reference.md"));

    const searched = await execute(fx.tool("searchProjectText"), {
      path: externalDir,
      query: "Aurora Bridge"
    });
    assert.equal(searched.details.outsideProject, true);
    assert.equal(searched.details.matches.length, 1);
    assert.equal(searched.details.matches[0].path, externalPath);
  } finally {
    await fx.close();
    await rm(externalDir, { recursive: true, force: true });
  }
});

await test("parent Pi search resolves the bound extracted source basename instead of the project root", async () => {
  const fx = await fixture({
    sourceRelativePath: ".translation-workshop/extracted-text/book/source/_.txt"
  }, "「た」\n別の行\n");
  try {
    const searched = await execute(fx.tool("searchProjectText"), {
      path: "_.txt",
      query: "「た」",
      maxResults: 20
    });
    assert.equal(searched.details.path, fx.sourcePath);
    assert.equal(searched.details.matches.length, 1);
    assert.equal(searched.details.matches[0].line, 1);
  } finally {
    await fx.close();
  }
});

await test("parent Pi tools inspect and steer a live child through the session supervisor", async () => {
  const calls = [];
  const published = [];
  let resolveConsumed;
  const consumed = new Promise((resolve) => { resolveConsumed = resolve; });
  const subagents = {
    list: () => [{ id: "batch-1", kind: "translation", status: "running", startedAt: 1, subagents: [] }],
    inspect: async (subagentId) => ({
      id: subagentId,
      batchId: "batch-1",
      kind: "translation",
      label: "shard-1",
      fromLine: 1,
      toLine: 1,
      status: "running",
      startedAt: 1,
      transcript: Array.from({ length: 20_000 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `private child transcript ${index}` }],
        timestamp: index + 2
      })),
      resultSummary: "Working on the assigned range."
    }),
    steer: async (subagentId, message) => {
      calls.push({ subagentId, message });
      return { deliveryId: "delivery-1", status: "queued", consumed };
    }
  };
  const fx = await fixture({
    subagents,
    publishCustomMessage: async (message) => { published.push(message); }
  });
  try {
    const listed = await execute(fx.tool("inspectSubagents"));
    assert.equal(listed.details.batches.length, 1);
    const inspected = await execute(fx.tool("inspectSubagents"), { subagentId: "child-1" });
    assert.equal(inspected.details.subagent.id, "child-1");
    assert.equal(Object.hasOwn(inspected.details.subagent, "transcript"), false);
    assert.equal(inspected.details.subagent.resultSummary, "Working on the assigned range.");
    assert.ok(
      Buffer.byteLength(JSON.stringify(inspected.details)) < 16_384,
      "parent inspection must stay lightweight regardless of child transcript size"
    );
    const steered = await Promise.race([
      execute(fx.tool("steerSubagent"), { subagentId: "child-1", message: "Check the glossary first." }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("steerSubagent blocked on child consumption")), 100))
    ]);
    assert.deepEqual(calls, [{ subagentId: "child-1", message: "Check the glossary first." }]);
    assert.deepEqual(steered.details, {
      status: "queued",
      deliveryId: "delivery-1",
      subagentId: "child-1"
    });
    resolveConsumed();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(published.some((message) => (
      message.role === "custom"
      && message.customType === "subagent.steer_delivery"
      && message.display === false
      && message.details?.status === "consumed"
      && message.details?.deliveryId === "delivery-1"
    )), "child consumption must be recorded asynchronously without blocking the parent tool turn");
  } finally {
    await fx.close();
  }
});

await test("translation chunk write blocks line-count, placeholder, and empty-line violations", async () => {
  const fx = await fixture();
  try {
    const tool = fx.tool("writeTranslationChunk");
    await assert.rejects(() => execute(tool, {
      fromLine: 1,
      toLine: 3,
      lines: ["你好 {name}", "再见"]
    }), /requires exactly 3 lines/);
    await assert.rejects(() => execute(tool, {
      fromLine: 1,
      toLine: 3,
      lines: ["你好", "", "再见"]
    }), /placeholder|占位符/i);
    await assert.rejects(() => execute(tool, {
      fromLine: 1,
      toLine: 3,
      lines: ["你好 {name}", "不应出现在空行", "再见"]
    }), /空行|empty-line/i);
    await assert.rejects(() => execute(tool, {
      fromLine: 1,
      toLine: 3,
      lines: ["中文译文", "", "中文译文"]
    }), /占位|placeholder|generic_translation_placeholder/i);
  } finally {
    await fx.close();
  }
});

await test("bounded parent repair cannot validate shifted same-count lines without an independent range audit", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 2
  });
  const source = [
    "John opened the old wooden door.",
    "Mary closed the tall glass window.",
    "The teacher read the important letter."
  ].join("\n");
  const fx = await fixture({
    domainRun,
    requestPatch: { languagePair: "en->zh-CN" }
  }, `${source}\n`);
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 3,
      lines: [
        "约翰打开旧木门，玛丽关上高大的玻璃窗。",
        "老师读了那封重要的信。",
        "这一幕平静地结束了。"
      ]
    });
    await assert.rejects(
      execute(fx.tool("validateTranslationArtifact")),
      /bounded translation alignment audit is incomplete|pending lines/i
    );

    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.equal(audit.details.bounded, true);
    assert.equal(audit.details.fromLine, 1);
    assert.equal(audit.details.toLine, 3);
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: audit.details.pendingLines.map((line) => ({
        line,
        code: "line_identity",
        note: `Candidate line ${line} does not preserve its own complete source unit.`
      }))
    });
    await assert.rejects(
      execute(fx.tool("validateTranslationArtifact")),
      /bounded translation alignment failed.*1.*2.*3|misaligned lines/i
    );

    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 3,
      lines: [
        "约翰打开了那扇旧木门。",
        "玛丽关上了高大的玻璃窗。",
        "老师读了那封重要的信。"
      ]
    });
    const repaired = await execute(fx.tool("inspectTranslationAlignment"));
    assert.notEqual(repaired.details.auditId, audit.details.auditId);
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: repaired.details.auditId,
      failures: []
    });
    const validated = await execute(fx.tool("validateTranslationArtifact"));
    assert.equal(validated.details.validation.accepted, true);
  } finally {
    await fx.close();
  }
});

await test("parent alignment review submits failures only and Host records silent passes", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: false
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const fx = await fixture({
    domainRun,
    translationAlignmentState,
    requestPatch: { languagePair: "en->zh-CN" }
  }, "First complete source row.\nSecond complete source row.\nThird complete source row.\n");
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 3,
      lines: ["第一行完整译文。", "第二行完整译文。", "第三行完整译文。"]
    });
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    const tool = fx.tool("recordTranslationAlignmentChecks");
    assert.ok(Object.hasOwn(tool.parameters.properties, "failures"));
    assert.equal(Object.hasOwn(tool.parameters.properties, "checks"), false);
    const recorded = await execute(tool, {
      auditId: audit.details.auditId,
      failures: []
    });
    assert.equal(recorded.details.decision, "accepted");
    const scope = translationAlignmentState.ranges["source.txt"][0];
    assert.ok(scope.checks.every((check) => check.verdict === "aligned"));
    assert.ok(scope.checks.every((check) => check.reason === undefined));
  } finally {
    await fx.close();
  }
});

await test("a large bounded mutation creates risk plus sample debt instead of one verdict per changed line", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: false
  });
  const sourceLines = Array.from({ length: 500 }, (_, index) =>
    `Source row ${index + 1} has its own complete meaning.`
  );
  const fx = await fixture({
    domainRun,
    requestPatch: { languagePair: "en->zh-CN" }
  }, `${sourceLines.join("\n")}\n`);
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 500,
      lines: sourceLines.map((_line, index) => `第${index + 1}行具有独立而完整的中文含义。`)
    });
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.ok(audit.details.pendingCount < 100, "the changed range length became semantic review debt");
    assert.ok(audit.details.sampledLineCount <= Math.ceil(Math.sqrt(500)));
  } finally {
    await fx.close();
  }
});

await test("bounded alignment inspection covers only the changed range in a large candidate", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: false
  });
  const sourceLines = Array.from({ length: 1_000 }, (_, index) =>
    `Source sentence ${index + 1} has a unique complete meaning.`
  );
  const fx = await fixture({
    domainRun,
    requestPatch: { languagePair: "en->zh-CN" }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, `${sourceLines.map((_line, index) => `这是第 ${index + 1} 行的完整中文译文。`).join("\n")}\n`, "utf8");
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 700,
      toLine: 702,
      lines: ["这是第七百行的修订译文。", "这是第七百零一行的修订译文。", "这是第七百零二行的修订译文。"]
    });
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.equal(audit.details.fromLine, 700);
    assert.equal(audit.details.toLine, 702);
    assert.ok(audit.details.pendingLines.length > 0);
    assert.ok(audit.details.pendingLines.length <= Math.ceil(Math.sqrt(3)));
    assert.ok(audit.details.pendingLines.every((line) => line >= 700 && line <= 702));
  } finally {
    await fx.close();
  }
});

await test("bounded alignment uses mechanical risks plus a bounded clean sample instead of creating 1024 semantic debts", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 3
  });
  const sourceLines = Array.from({ length: 1_024 }, (_, index) =>
    `Character ${index + 1} carefully records a distinct clue in the investigation log.`
  );
  const candidateLines = Array.from({ length: 1_024 }, (_, index) =>
    `角色${index + 1}认真记录了调查日志中的一条独立线索。`
  );
  const fx = await fixture({
    domainRun,
    requestPatch: { languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 3 }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.equal(audit.details.fromLine, 1);
    assert.equal(audit.details.toLine, 1_024);
    assert.ok(audit.details.pendingCount <= audit.details.riskLineCount + 32);
    assert.ok(audit.details.pendingCount < 1_024, "the range length must never become semantic review debt");
  } finally {
    await fx.close();
  }
});

await test("legacy exhaustive bounded alignment state is migrated to the canonical risk and sample contract", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 3
  });
  const sourceLines = Array.from({ length: 1_024 }, (_, index) =>
    `Character ${index + 1} follows a unique route through the sealed facility.`
  );
  const candidateLines = Array.from({ length: 1_024 }, (_, index) =>
    `角色${index + 1}沿着一条独特路线穿过封闭设施。`
  );
  const translationAlignmentState = createTranslationAlignmentHostState();
  const persistedStates = [];
  const fx = await fixture({
    domainRun,
    translationAlignmentState,
    persistHostState: async () => {
      persistedStates.push(structuredClone(translationAlignmentState));
    },
    requestPatch: { languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 3 }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    translationAlignmentState.ranges["source.txt"] = [createTranslationAlignmentRangeAudit({
      documentId: "source.txt",
      sourceText: sourceLines.join("\n"),
      candidateText: candidateLines.join("\n"),
      candidatePath,
      languagePair: "en->zh-CN",
      fromLine: 1,
      toLine: 1_024,
      sourceLineCount: 1_024
    })];
    const legacy = translationAlignmentState.ranges["source.txt"][0];
    assert.equal(legacy.checks.length, 1_024);
    legacy.checks[776].verdict = "misaligned";
    legacy.checks[776].reason = "The previous semantic review found a shifted meaning.";

    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.match(audit.details.auditId, /^alignment-mutation-/);
    assert.ok(audit.details.pendingCount <= audit.details.riskLineCount + 32);
    assert.ok(audit.details.pendingCount < 1_024);
    const migrated = translationAlignmentState.ranges["source.txt"][0];
    assert.equal(migrated.auditId, audit.details.auditId);
    assert.deepEqual(
      migrated.checks.find((check) => check.line === 777),
      {
        line: 777,
        signals: ["previous_misaligned_verdict"],
        verdict: "misaligned",
        reason: "The previous semantic review found a shifted meaning."
      },
      "a hash-current semantic failure must survive exhaustive-state migration"
    );
    assert.ok(persistedStates.length > 0, "migration must persist before inspectTranslationAlignment returns");
    assert.match(persistedStates.at(-1).ranges["source.txt"][0].auditId, /^alignment-mutation-/);
    assert.equal(
      persistedStates.at(-1).ranges["source.txt"][0].checks.find((check) => check.line === 777)?.verdict,
      "misaligned"
    );
  } finally {
    await fx.close();
  }
});

await test("stale exhaustive alignment verdicts cannot make a changed candidate look complete", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 3
  });
  const sourceLines = Array.from({ length: 128 }, (_, index) =>
    `Character ${index + 1} records a different observation in the field notebook.`
  );
  const originalCandidateLines = Array.from({ length: 128 }, (_, index) =>
    `角色${index + 1}在现场笔记中记录了不同的观察。`
  );
  const translationAlignmentState = createTranslationAlignmentHostState();
  const fx = await fixture({
    domainRun,
    translationAlignmentState,
    requestPatch: { languagePair: "en->zh-CN", subagentEnabled: true, subagentCount: 3 }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, `${originalCandidateLines.join("\n")}\n`, "utf8");
    const legacy = createTranslationAlignmentRangeAudit({
      documentId: "source.txt",
      sourceText: sourceLines.join("\n"),
      candidateText: originalCandidateLines.join("\n"),
      candidatePath,
      languagePair: "en->zh-CN",
      fromLine: 1,
      toLine: 128,
      sourceLineCount: 128
    });
    for (const check of legacy.checks) {
      check.verdict = "aligned";
      check.reason = "stale approval";
    }
    translationAlignmentState.ranges["source.txt"] = [legacy];
    const changedCandidateLines = [...originalCandidateLines];
    changedCandidateLines[63] = "第六十四行已被修改，旧的语义结论不再适用。";
    await writeFile(candidatePath, `${changedCandidateLines.join("\n")}\n`, "utf8");

    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.match(audit.details.auditId, /^alignment-mutation-/);
    assert.ok(audit.details.pendingCount > 0, "a changed candidate must require a fresh bounded review");
    assert.ok(
      translationAlignmentState.ranges["source.txt"][0].checks.every((check) => check.verdict === undefined),
      "hash-stale aligned verdicts must not migrate into the new audit"
    );
  } finally {
    await fx.close();
  }
});

await test("valid aligned chunk persists and passes whole-artifact validation", async () => {
  const fx = await fixture();
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 3,
      lines: ["你好 {name}", "", "再见"]
    });
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });
    await execute(fx.tool("validateTranslationArtifact"));
    const candidate = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    assert.equal(await readFile(candidate, "utf8"), "你好 {name}\n\n再见\n");
  } finally {
    await fx.close();
  }
});

await test("whole-artifact validation cannot fake-pass shifted or merged same-count lines", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const source = [
    "John opened the old wooden door.",
    "Mary closed the tall glass window.",
    "The teacher read the important letter."
  ].join("\n");
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: false,
      languagePair: "en->zh-CN"
    }
  }, `${source}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, [
      "约翰打开旧木门，玛丽关上高大的玻璃窗。",
      "老师认真阅读了那封非常重要的信件。",
      "这一幕就这样平静地结束了。"
    ].join("\n"), "utf8");
    await assert.rejects(
      execute(fx.tool("validateTranslationArtifact")),
      /chunk review|inspectTranslationAlignment/i
    );

    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.equal(audit.details.pendingLines.length, 2);
    assert.ok(
      audit.details.pendingLines.every((line) => line >= 1 && line <= 3),
      "the bounded review must sample distinct rows from the corrupted chunk"
    );
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: audit.details.pendingLines.map((line) => ({
        line,
        code: "line_identity",
        note: line === 1
          ? "Line 1 merges the source meaning from lines 1 and 2."
          : `Selected line ${line} does not preserve its own source row.`
      }))
    });
    await assert.rejects(execute(fx.tool("validateTranslationArtifact")), /misaligned.*1|chunk review rejected/i);

    await writeFile(candidatePath, [
      "约翰打开了那扇旧木门。",
      "玛丽关上了高大的玻璃窗。",
      "老师读了那封重要的信。"
    ].join("\n"), "utf8");
    const repairedAudit = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: repairedAudit.details.auditId,
      failures: []
    });
    const validated = await execute(fx.tool("validateTranslationArtifact"));
    assert.equal(validated.details.validation.ok, true);
  } finally {
    await fx.close();
  }
});

await test("large translation alignment reviews every mechanical risk plus a bounded deterministic clean sample", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const sourceLines = Array.from(
    { length: 240 },
    (_, index) => `Source sentence ${index + 1} carries a unique meaning for this row.`
  );
  const candidateLines = sourceLines.map((_line, index) => `这是第 ${index + 1} 行各自独立的中文译文。`);
  candidateLines[89] = "已完成。";
  [candidateLines[209], candidateLines[210]] = [candidateLines[210], candidateLines[209]];
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: false,
      languagePair: "en->zh-CN"
    }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    assert.equal(audit.details.pendingCount, 19);
    assert.equal(audit.details.riskLineCount, 3);
    assert.equal(audit.details.sampledLineCount, 16);
    assert.equal(audit.details.hasMorePending, false);
    assert.ok(audit.details.pendingLines.includes(90), "the severe compression warning must enter review debt");
    assert.ok(
      [89, 90, 91].every((line) => audit.details.pendingLines.includes(line)),
      "adjacent rows must be reviewed with the compressed row so shifted meaning cannot hide at the boundary"
    );
    assert.ok(audit.details.pendingCount < 50, "a clean 240-line chunk must not trigger a full semantic pass");

    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 240 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 240 });
    const recorded = await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });
    assert.equal(recorded.details.pendingCount, 0);
    await execute(fx.tool("validateTranslationArtifact"));
  } finally {
    await fx.close();
  }
});

await test("final translation validation rejects accepted chunk evidence after that candidate slice changes", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: false,
      languagePair: "en->zh-CN"
    }
  });
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 3,
      lines: ["你好 {name}", "", "再见"]
    });
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });

    await writeFile(candidatePath, "您好 {name}\n\n再见\n", "utf8");
    await assert.rejects(
      execute(fx.tool("validateTranslationArtifact")),
      /changed after review-worker acceptance.*through review again/i
    );
  } finally {
    await fx.close();
  }
});

await test("final translation validation rejects a gap between individually accepted chunk reviews", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: false
  });
  const sourceLines = [
    "First source sentence.",
    "Second source sentence.",
    "Third source sentence.",
    "Fourth source sentence."
  ];
  const candidateLines = ["第一句译文。", "第二句译文。", "第三句译文。", "第四句译文。"];
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: false,
      languagePair: "en->zh-CN"
    }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 2,
      lines: candidateLines.slice(0, 2)
    });
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 4,
      toLine: 4,
      lines: candidateLines.slice(3)
    });
    await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");

    for (let index = 0; index < 2; index += 1) {
      const audit = await execute(fx.tool("inspectTranslationAlignment"));
      await execute(fx.tool("readSourceLines"), {
        fromLine: audit.details.fromLine,
        toLine: audit.details.toLine
      });
      await execute(fx.tool("readTranslationLines"), {
        fromLine: audit.details.fromLine,
        toLine: audit.details.toLine
      });
      await execute(fx.tool("recordTranslationAlignmentChecks"), {
        auditId: audit.details.auditId,
        failures: []
      });
    }

    await assert.rejects(
      execute(fx.tool("validateTranslationArtifact")),
      /coverage.*gap or overlap at line 3/i
    );
  } finally {
    await fx.close();
  }
});

await test("ordinary parent repair keeps unrelated glossary warnings as compact telemetry", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false
  });
  const fx = await fixture({ domainRun }, "Naomi entered.\n");
  try {
    const workspace = path.join(fx.outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "glossary.json"), JSON.stringify({
      entries: [{ source: "Naomi", target: "直美" }]
    }), "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    const result = await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 1,
      lines: ["她走进来了。"]
    });
    assert.equal(result.details.validation.accepted, true,
      "structurally valid local repair must not be rejected by whole-file quality debt");
    assert.equal(result.details.validation.warningCount, 1);
    assert.equal(result.details.validation.qualityWarningCount, 1);
    assert.equal(result.details.validation.qualityDebtCount, 0);
    assert.deepEqual(result.details.validation.qualityDebtLineRanges, []);
    assert.deepEqual(result.details.validation.findingSamples, []);
    assert.equal(Object.hasOwn(result.details.validation, "warnings"), false);
    assert.match(domainRun.incompleteReasons().join("\n"), /whole-artifact validation/i,
      "a structurally accepted local repair must still require parent-owned whole-artifact validation");
    await assert.rejects(
      execute(fx.tool("validateTranslationArtifact")),
      /bounded translation alignment audit is incomplete|pending lines/i
    );
    const audit = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 1 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 1 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });
    const finalValidation = await execute(fx.tool("validateTranslationArtifact"));
    assert.equal(finalValidation.details.validation.accepted, true);
    assert.equal(finalValidation.details.validation.warningCount, 1);
    assert.deepEqual(finalValidation.details.validation.warningLineRanges, ["1"]);
    assert.equal(finalValidation.details.validation.warningSamples[0]?.line, 1);
    assert.equal(finalValidation.details.validation.warningSamples[0]?.code, "glossary_missing");
    assert.equal(finalValidation.details.validation.qualityDebtCount, 0,
      "bounded final validation must report unrelated quality warnings without promoting them to completion debt");
    assert.deepEqual(domainRun.incompleteReasons(), [],
      "successful parent-owned whole-artifact validation must clear the bounded repair debt");
    assert.ok(JSON.stringify(result).length < 4_000,
      `ordinary repair result must stay compact, received ${JSON.stringify(result).length} chars`);
  } finally {
    await fx.close();
  }
});

await test("folder source selection exposes a stable manifest and writes isolated per-file candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-domain-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(path.join(sourceRoot, "chapter"), { recursive: true });
  await writeFile(path.join(sourceRoot, "chapter", "a.txt"), "こんにちは\nさようなら\n", "utf8");
  await writeFile(path.join(sourceRoot, "b.txt"), "ありがとう\n", "utf8");
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder",
    prompt: "translate folder",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    subagentEnabled: false
  };
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", folderSource: true, subagentEnabled: false });
  const publishCustomMessage = async () => {};
  const subagents = new YnSubagentSupervisor({ publishCustomMessage });
  const tools = createYnDomainTools({ request, publishCustomMessage, subagents, domainRun });
  const tool = (name) => {
    const value = tools.find((entry) => entry.name === name);
    assert.ok(value, `missing tool ${name}`);
    return value;
  };
  try {
    const inspection = await execute(tool("inspectTranslationContext"), {});
    assert.deepEqual(
      inspection.details.sourceSelection.documents.map((document) => document.id),
      ["b.txt", "chapter/a.txt"]
    );
    await execute(tool("selectSourceDocument"), { documentId: "b.txt" });
    await execute(tool("writeTranslationChunk"), { fromLine: 1, toLine: 1, lines: ["谢谢"] });
    const bAlignment = await execute(tool("inspectTranslationAlignment"));
    await execute(tool("readSourceLines"), { fromLine: 1, toLine: 1 });
    await execute(tool("readTranslationLines"), { fromLine: 1, toLine: 1 });
    await execute(tool("recordTranslationAlignmentChecks"), {
      auditId: bAlignment.details.auditId,
      failures: []
    });
    assert.equal(await readFile(path.join(outputDir, "AI_translation", "b_translated.txt"), "utf8"), "谢谢\n");

    await execute(tool("selectSourceDocument"), { documentId: "chapter/a.txt" });
    await execute(tool("writeTranslationChunk"), { fromLine: 1, toLine: 2, lines: ["你好", "再见"] });
    const alignment = await execute(tool("inspectTranslationAlignment"));
    await execute(tool("readSourceLines"), { fromLine: 1, toLine: 2 });
    await execute(tool("readTranslationLines"), { fromLine: 1, toLine: 2 });
    await execute(tool("recordTranslationAlignmentChecks"), {
      auditId: alignment.details.auditId,
      failures: []
    });
    await execute(tool("validateTranslationArtifact"));
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "chapter", "a_translated.txt"), "utf8"),
      "你好\n再见\n"
    );
    assert.deepEqual(domainRun.incompleteReasons(), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("full folder reuse preparation cannot be narrowed to the selected document", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-reuse-scope-"));
  const sourceRoot = path.join(outputDir, "source");
  const candidateRoot = path.join(outputDir, "AI_translation");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "a.txt"), "こんにちは\n", "utf8");
  await writeFile(path.join(sourceRoot, "b.txt"), "さようなら\n", "utf8");
  await writeFile(path.join(candidateRoot, "a_translated.txt"), "你好\n", "utf8");
  await writeFile(path.join(candidateRoot, "b_translated.txt"), "再见\n", "utf8");
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_reuse_scope",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    reuseExistingTranslation: true,
    subagentEnabled: false
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    folderSource: true,
    fullWorkflow: true,
    subagentEnabled: false
  });
  const publishCustomMessage = async () => {};
  const subagents = new YnSubagentSupervisor({ publishCustomMessage });
  const tools = createYnDomainTools({ request, publishCustomMessage, subagents, domainRun });
  const tool = (name) => {
    const value = tools.find((entry) => entry.name === name);
    assert.ok(value, `missing tool ${name}`);
    return value;
  };
  try {
    await execute(tool("inspectTranslationContext"), {});
    await execute(tool("selectSourceDocument"), { documentId: "a.txt" });
    assert.doesNotMatch(
      JSON.stringify(tool("prepareTranslationReuseAudit").parameters),
      /documentId/,
      "the model-facing full-folder preparation tool must not advertise a per-document scope"
    );
    const prepared = await execute(tool("prepareTranslationReuseAudit"), { documentId: "a.txt" });
    assert.equal(prepared.details.documentCount, 2,
      "a legacy or cached documentId must not narrow a complete folder workflow");
    assert.equal(prepared.details.sourceLineCount, 2);
    assert.equal(prepared.details.singleAudit, undefined);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder worker ownership blocks only overlapping parent writes", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-repair-owner-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "a.txt"), "こんにちは\nさようなら\n", "utf8");
  let conflict = true;
  const subagents = {
    hasRunning: () => true,
    hasWriteConflict: ({ fromLine, toLine }) => conflict && fromLine <= 1 && toLine >= 1
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    folderSource: true,
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 5
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_parent_repair",
      prompt: "只修正 a.txt 第一行",
      providerId: "test",
      modelId: "test",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5
    },
    publishCustomMessage: async () => {},
    subagents,
    domainRun
  });
  const tool = (name) => {
    const value = tools.find((entry) => entry.name === name);
    assert.ok(value, `missing tool ${name}`);
    return value;
  };
  try {
    await execute(tool("inspectTranslationContext"), {});
    await assert.rejects(
      () => execute(tool("writeTranslationChunk"), { fromLine: 1, toLine: 1, lines: ["你好"] }),
      /overlaps an active child writer/i
    );
    await execute(tool("writeTranslationChunk"), { fromLine: 2, toLine: 2, lines: ["再见"] });
    conflict = false;
    await execute(tool("writeTranslationChunk"), { fromLine: 1, toLine: 1, lines: ["你好"] });
    assert.equal(await readFile(path.join(outputDir, "AI_translation", "a_translated.txt"), "utf8"), "你好\n再见\n");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder proofreading consumes only documents retained by the shared order expression", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-proofread-filter-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "a.txt"), "甲\n乙\n", "utf8");
  await writeFile(path.join(sourceRoot, "b.txt"), "丙\n丁\n", "utf8");
  await mkdir(path.join(outputDir, "AI_translation"), { recursive: true });
  await writeFile(path.join(outputDir, "AI_translation", "a_translated.txt"), "甲\n乙\n", "utf8");
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      folderTranslationOrder: '{\n"a.txt"\n}',
      sessionId: "pi_folder_proofread_filter",
      prompt: "Workflow: yn-proofread-v1.",
      providerId: "test",
      modelId: "test",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 2
    },
    publishCustomMessage: async () => {},
    subagents: { hasRunning: () => false },
    domainRun
  });
  const inspect = tools.find((entry) => entry.name === "inspectTranslationContext");
  assert.ok(inspect);
  try {
    const result = await execute(inspect, {});
    assert.deepEqual(result.details.sourceSelection.documents.map((document) => document.id), ["a.txt"]);
    assert.doesNotMatch(domainRun.incompleteReasons().join("\n"), /b\.txt/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder proofreading enforces strict stages while allowing either file inside one brace group", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: false
  });
  domainRun.recordInspection({
    sourceLineCount: 1,
    glossaryCandidateExists: false,
    characterBibleExists: false,
    documents: [
      { id: "first.txt", sourceLineCount: 1, scheduleStage: 0 },
      { id: "middle-a.txt", sourceLineCount: 1, scheduleStage: 1 },
      { id: "middle-b.txt", sourceLineCount: 1, scheduleStage: 1 },
      { id: "last.txt", sourceLineCount: 1, scheduleStage: 2 }
    ]
  });
  const completeSelected = () => {
    domainRun.recordProofreadPrescan();
    domainRun.recordProofreadParentRead("source", 1, 1);
    domainRun.recordProofreadParentRead("translation", 1, 1);
    domainRun.recordProofreadParentSemanticReview(1, 1);
    domainRun.recordFindingsWrite("proofread");
    domainRun.recordProofreadReportFinalized();
  };

  await assert.rejects(
    async () => domainRun.selectDocument("middle-a.txt"),
    /earlier folder-order stage.*first\.txt/i
  );
  domainRun.selectDocument("first.txt");
  completeSelected();
  domainRun.selectDocument("middle-b.txt");
  await assert.doesNotReject(async () => domainRun.selectDocument("middle-a.txt"));
  await assert.rejects(
    async () => domainRun.selectDocument("last.txt"),
    /middle-a\.txt|middle-b\.txt/i
  );
  completeSelected();
  domainRun.selectDocument("middle-b.txt");
  completeSelected();
  await assert.doesNotReject(async () => domainRun.selectDocument("last.txt"));
});

await test("a rejected folder-stage selection leaves the Host and bound request on the same document", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-select-transaction-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "tips.txt"), "tip one\ntip two\n", "utf8");
  await writeFile(path.join(sourceRoot, "script.txt"), "script one\nscript two\nscript three\n", "utf8");
  await mkdir(path.join(outputDir, "AI_translation"), { recursive: true });
  await writeFile(path.join(outputDir, "AI_translation", "tips_translated.txt"), "提示一\n提示二\n", "utf8");
  await writeFile(path.join(outputDir, "AI_translation", "script_translated.txt"), "脚本一\n脚本二\n脚本三\n", "utf8");
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: false
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      folderTranslationOrder: '{\n"tips.txt"\n}\n"script.txt"',
      sessionId: "pi_folder_select_transaction",
      prompt: "Workflow: yn-proofread-v1.",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN",
      subagentEnabled: false
    },
    publishCustomMessage: async () => {},
    subagents: { hasRunning: () => false },
    domainRun
  });
  const tool = (name) => {
    const value = tools.find((entry) => entry.name === name);
    assert.ok(value, `missing tool ${name}`);
    return value;
  };
  try {
    const first = await execute(tool("inspectTranslationContext"), {});
    assert.equal(first.details.sourceSelection.selectedDocumentId, "tips.txt");
    await assert.rejects(
      execute(tool("selectSourceDocument"), { documentId: "script.txt" }),
      /earlier folder-order stage.*tips\.txt/i
    );
    const afterRejectedSelection = await execute(tool("inspectTranslationContext"), {});
    assert.equal(domainRun.activeDocumentId, "tips.txt");
    assert.equal(afterRejectedSelection.details.sourceSelection.selectedDocumentId, "tips.txt");
    assert.equal(afterRejectedSelection.details.sourceLineCount, 2);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder restart discards legacy child completion records that cannot prove document ownership", async () => {
  const legacyRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 5
  });
  legacyRun.recordInspection({
    sourceLineCount: 611,
    glossaryCandidateExists: false,
    characterBibleExists: false,
    documents: [
      { id: "tips.txt", sourceLineCount: 611, scheduleStage: 0 },
      { id: "script.txt", sourceLineCount: 21_556, scheduleStage: 1 }
    ]
  });
  legacyRun.recordProofreadPrescan();
  legacyRun.recordSubagentBatchStarted("proofread", "legacy-cross-document-batch", {
    taskCount: 44,
    workerCount: 5,
    documentIds: ["tips.txt"]
  });
  legacyRun.recordSubagentBatch("proofread", "legacy-cross-document-batch", 44, ["tips.txt"]);
  const legacySnapshot = legacyRun.snapshot();
  legacySnapshot.schemaVersion = 1;
  for (const document of legacySnapshot.documents) {
    if (document.completedSubagentBatch) {
      delete document.completedSubagentBatch.documentId;
      delete document.completedSubagentBatch.sourceLineCount;
    }
  }

  const restored = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 5,
    restoreSnapshot: legacySnapshot
  });
  const tips = restored.snapshot().documents.find((document) => document.id === "tips.txt");
  assert.ok(tips);
  assert.equal(tips.completedSubagentBatch, undefined);
  assert.match(restored.incompleteReasons().join("\n"), /tips\.txt.*unbound legacy child completion/i);
});

await test("folder restart preserves current child completion records bound to the same document", async () => {
  const completedRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  completedRun.recordInspection({
    sourceLineCount: 611,
    glossaryCandidateExists: false,
    characterBibleExists: false,
    documents: [{ id: "tips.txt", sourceLineCount: 611, scheduleStage: 0 }]
  });
  completedRun.recordProofreadPrescan();
  completedRun.recordSubagentBatchStarted("proofread", "bound-tips-batch", {
    taskCount: 2,
    workerCount: 2,
    documentIds: ["tips.txt"]
  });
  completedRun.recordSubagentBatch("proofread", "bound-tips-batch", 2, ["tips.txt"]);

  const restored = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2,
    restoreSnapshot: completedRun.snapshot()
  });
  const tips = restored.snapshot().documents.find((document) => document.id === "tips.txt");
  assert.equal(tips?.completedSubagentBatch?.id, "bound-tips-batch");
  assert.equal(tips?.completedSubagentBatch?.documentId, "tips.txt");
  assert.equal(tips?.completedSubagentBatch?.sourceLineCount, 611);
  assert.doesNotMatch(restored.incompleteReasons().join("\n"), /tips\.txt.*host-planned batch/i);
});

await test("folder proofreading rejects cross-document Monte Carlo state instead of mixing samples", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-proofread-montecarlo-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "a.txt"), "\u7532\n\u4e59\n", "utf8");
  await mkdir(path.join(outputDir, "AI_translation"), { recursive: true });
  await writeFile(path.join(outputDir, "AI_translation", "a_translated.txt"), "A\nB\n", "utf8");
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      folderTranslationOrder: '{\n"a.txt"\n}',
      sessionId: "pi_folder_proofread_montecarlo",
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      providerId: "test",
      modelId: "test",
      languagePair: "ja->zh-CN",
      proofreadMode: "montecarlo",
      subagentEnabled: true,
      subagentCount: 2
    },
    publishCustomMessage: async () => {},
    subagents: { hasRunning: () => false },
    domainRun: createYnDomainRunContract({
      workflowIntent: "proofread",
      folderSource: true,
      proofreadMode: "montecarlo",
      subagentEnabled: true,
      subagentCount: 2
    })
  });
  const run = tools.find((entry) => entry.name === "runProofreadSubagents");
  const inspect = tools.find((entry) => entry.name === "inspectTranslationContext");
  assert.ok(run);
  assert.ok(inspect);
  try {
    await execute(inspect, {});
    await assert.rejects(() => execute(run), /folder proofreading supports split mode only/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a user-selected Monte Carlo escalation delegates only deterministic HOT-region rows", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-hot-split-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "AI_translation", "source_translated.txt");
  const sourceLines = Array.from({ length: 1_500 }, (_, index) => `source-${index + 1}`);
  const translationLines = Array.from(
    { length: 1_500 },
    (_, index) => index < 30 ? `Translation: placeholder ${index + 1}` : `译文-${index + 1}`
  );
  let started;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(options) {
      started = options;
      return {
        id: "hot-split-batch",
        kind: "proofread",
        status: "running",
        startedAt: 1,
        subagents: options.tasks.map((task, index) => ({
          id: `hot-child-${index}`,
          batchId: "hot-split-batch",
          kind: "proofread",
          label: task.label,
          fromLine: task.fromLine,
          toLine: task.toLine,
          status: "running",
          startedAt: 1
        }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    proofreadMode: "montecarlo",
    proofreadMontecarloRoundMin: 2,
    proofreadMontecarloRoundMax: 2,
    subagentEnabled: true,
    subagentCount: 2
  });
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
    await writeFile(translationPath, `${translationLines.join("\n")}\n`, "utf8");
    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath,
        translationPath,
        sessionId: "pi_proofread_hot_split",
        prompt: "Workflow: yn-proofread-v1.",
        providerId: "test",
        modelId: "test",
        languagePair: "en->zh-CN",
        proofreadMode: "montecarlo",
        proofreadMontecarloRoundMin: 2,
        proofreadMontecarloRoundMax: 2,
        subagentEnabled: true,
        subagentCount: 2
      },
      publishCustomMessage: async () => {},
      subagents,
      domainRun
    });
    await execute(tools.find((entry) => entry.name === "inspectTranslationContext"), {});
    const existingFinding = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourcePath],
      documentId: "source.txt",
      translationPath,
      kind: "findings_json",
      mode: "montecarlo",
      content: JSON.stringify([{
        id: "H7-001",
        severity: "H7",
        type: "ai_contamination",
        sourceLine: 1,
        translationLine: 1,
        sourceText: sourceLines[0],
        currentTranslation: translationLines[0],
        suggestedFix: "译文-1",
        rationale: "Existing Monte Carlo finding that must survive HOT escalation."
      }])
    });
    assert.equal(existingFinding.ok, true);
    domainRun.recordProofreadArtifactReset();
    for (let round = 1; round <= 2; round += 1) {
      domainRun.recordSubagentBatchStarted("proofread", `dirty-${round}`, { taskCount: 2, workerCount: 2 });
      domainRun.recordProofreadArtifactMutation();
      domainRun.recordSubagentBatch("proofread", `dirty-${round}`, 2);
      domainRun.recordProofreadMontecarloRound(1);
    }
    domainRun.resolveProofreadMontecarloLimit("switch_to_split");
    const result = await execute(tools.find((entry) => entry.name === "runProofreadSubagents"), { workerCount: 1 });
    assert.equal(result.details.strategy, "hot_split");
    assert.ok(started);
    const delegated = started.tasks.flatMap((task) => task.reviewLines ?? []);
    assert.equal(delegated.length, 500);
    assert.ok(delegated.every((line) => line >= 1 && line <= 500));
    assert.equal(delegated.some((line) => line > 500), false);
    const preservedReport = JSON.parse(await readFile(existingFinding.path, "utf8"));
    assert.equal(preservedReport.findings.some((finding) => finding.id === "H7-001"), true);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder translation dispatch queues every file including single-line files", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-dispatch-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(path.join(sourceRoot, "chapter"), { recursive: true });
  await writeFile(path.join(sourceRoot, "chapter", "a.txt"), "一\n二\n", "utf8");
  await writeFile(path.join(sourceRoot, "b.txt"), "三\n", "utf8");
  let started;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      started = options;
      return {
        id: "folder-file-batch",
        kind: "translation",
        status: "running",
        startedAt: 1,
        subagents: options.tasks.map((task, index) => ({
          id: `child-${index}`,
          batchId: "folder-file-batch",
          kind: "translation",
          label: task.label,
          documentId: task.documentId,
          fromLine: task.fromLine,
          toLine: task.toLine,
          status: "running",
          startedAt: 1
        }))
      };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_dispatch",
    prompt: "translate folder",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN"
  };
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", folderSource: true });
  const tools = createYnDomainTools({ request, publishCustomMessage: async () => {}, subagents, domainRun });
  const tool = (name) => {
    const value = tools.find((entry) => entry.name === name);
    assert.ok(value, `missing tool ${name}`);
    return value;
  };
  try {
    await execute(tool("inspectTranslationContext"), {});
    await assert.rejects(
      () => execute(tool("runTranslationSubagents"), { tasks: [{ documentId: "b.txt" }] }),
      /host-owned|without tasks/i,
      "an explicit folder task must not smuggle a single-line file into a child runtime"
    );
    const result = await execute(tool("runTranslationSubagents"));
    assert.ok(started, "folder dispatch did not start a native child batch");
    assert.deepEqual(started.tasks.map((task) => ({
      documentId: task.documentId,
      fromLine: task.fromLine,
      toLine: task.toLine,
      label: task.label
    })), [
      { documentId: "chapter/a.txt", fromLine: 1, toLine: 2, label: "chapter/a.txt L1-2" },
      { documentId: "b.txt", fromLine: 1, toLine: 1, label: "b.txt L1-1" }
    ]);
    const bound = started.requestForTask(started.tasks[0]);
    assert.equal(bound.sourcePath, path.join(sourceRoot, "chapter", "a.txt"));
    assert.deepEqual(bound.sourceSelection, { kind: "file", path: path.join(sourceRoot, "chapter", "a.txt") });
    assert.deepEqual(result.details.candidates.map((candidate) => candidate.documentId), ["chapter/a.txt", "b.txt"]);
    assert.match(domainRun.incompleteReasons().join("\n"), /b\.txt.*subagents/i);
    assert.match(domainRun.incompleteReasons().join("\n"), /chapter\/a\.txt.*subagents/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("persisted folder terminology debt is supplied to the supervisor as an initial priority wave", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-term-debt-"));
  const sourceRoot = path.join(outputDir, "source");
  const aPath = path.join(sourceRoot, "a.txt");
  const bPath = path.join(sourceRoot, "b.txt");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(aPath, "用語 A\n", "utf8");
  await writeFile(bPath, "次へ\n", "utf8");
  const aCandidate = resolveTranslationCandidatePath({ outputDir, sourcePaths: [aPath, bPath], documentId: "a.txt" });
  await mkdir(path.dirname(aCandidate), { recursive: true });
  await writeFile(aCandidate, "旧译 A\n", "utf8");
  let started;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      started = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "folder_terminology_debt",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 1,
    subagentEnabled: true,
    subagentCount: 2,
    reviewSubagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"));
    domainRun.recordTranslationArtifactMutation("a.txt");
    const acceptedA = createTranslationAlignmentRangeAudit({
      documentId: "a.txt",
      sourceText: "用語 A",
      candidateText: "旧译 A",
      candidatePath: aCandidate,
      languagePair: "ja->zh-CN",
      fromLine: 1,
      toLine: 1,
      sourceLineCount: 1
    });
    acceptedA.checks.forEach((check) => { check.verdict = "aligned"; });
    translationAlignmentState.ranges["a.txt"] = [acceptedA];
    domainRun.recordTranslationDiscoveries([{
      id: "persisted-term",
      kind: "glossary",
      documentId: "a.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash: "audit",
      candidateHash: "audit",
      source: "用語",
      target: "旧译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "persisted"
    }]);
    domainRun.resolveTranslationDiscoveries(["persisted-term"], [{
      source: "用語",
      target: "标准译",
      observedTargets: ["旧译", "标准译"]
    }]);
    domainRun.recordTranslationTerminologyDebt([{
      documentId: "a.txt",
      line: 1,
      source: "用語",
      expectedTarget: "标准译",
      observedTargets: ["旧译"]
    }]);

    await execute(tool("runTranslationSubagents"));
    assert.ok(started);
    assert.deepEqual(started.priorityTasks.map((task) => [task.documentId, task.fromLine, task.toLine]), [
      ["a.txt", 1, 1]
    ]);
    assert.equal(started.priorityTasks[0].terminologyRepair, true);
    assert.ok(started.tasks.some((task) => task.documentId === "b.txt"), "the original folder queue disappeared");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("persisted single-file terminology debt precedes the remaining queue with two workers", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-single-term-debt-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt"
  });
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, "用語 A\n次へ\n終わり\n", "utf8");
  await writeFile(candidatePath, "旧译 A\n下一步\n结束\n", "utf8");
  const request = {
    outputDir,
    sourcePath,
    sourceDocumentId: "source.txt",
    sessionId: "single_terminology_debt",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    subagentEnabled: true,
    subagentCount: 2,
    reviewSubagentCount: 2
  };
  const originalDomainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const originalTools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents: { hasRunning: () => false },
    domainRun: originalDomainRun
  });
  const originalTool = (name) => originalTools.find((entry) => entry.name === name);
  let started;
  try {
    await execute(originalTool("inspectTranslationContext"));
    originalDomainRun.recordTranslationArtifactMutation("source.txt");
    originalDomainRun.recordTranslationDiscoveries([{
      id: "single-persisted-term",
      kind: "glossary",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1,
      sourceHash: "audit",
      candidateHash: "audit",
      source: "用語",
      target: "旧译",
      category: "setting_term",
      evidenceLine: 1,
      rationale: "persisted"
    }]);
    originalDomainRun.resolveTranslationDiscoveries(["single-persisted-term"], [{
      source: "用語",
      target: "标准译",
      observedTargets: ["旧译", "标准译"]
    }]);
    originalDomainRun.recordTranslationTerminologyDebt([{
      documentId: "source.txt",
      line: 1,
      source: "用語",
      expectedTarget: "标准译",
      observedTargets: ["旧译"]
    }]);
    const restoredDomainRun = createYnDomainRunContract({
      workflowIntent: "translation",
      fullWorkflow: true,
      subagentEnabled: true,
      subagentCount: 2,
      restoreSnapshot: originalDomainRun.snapshot()
    });
    const subagents = {
      hasRunning: () => false,
      startTranslationBatch(options) {
        started = options;
        return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
      }
    };
    const tools = createYnDomainTools({
      request,
      publishCustomMessage: async () => {},
      subagents,
      domainRun: restoredDomainRun
    });
    const tool = (name) => tools.find((entry) => entry.name === name);
    await execute(tool("inspectTranslationContext"));
    await execute(tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1, label: "repair split" },
        { fromLine: 2, toLine: 3, label: "remaining split" }
      ]
    });
    assert.ok(started);
    assert.equal(started.maxWorkers, 2);
    assert.deepEqual(started.priorityTasks.map((task) => [task.fromLine, task.toLine]), [[1, 1]]);
    assert.equal(started.tasks.some((task) => task.fromLine === 2 && task.toLine === 3), true);
    assert.equal(started.priorityTasks[0].terminologyRepair, true);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder translation settlement preserves accepted documents and pauses only failed debt", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-partial-settlement-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "accepted.txt"), "一\n", "utf8");
  await writeFile(path.join(sourceRoot, "failed.txt"), "二\n", "utf8");
  let started;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      started = options;
      return {
        id: options.batchId,
        kind: "translation",
        status: "running",
        startedAt: 1,
        subagents: []
      };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_partial_settlement",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    subagentEnabled: true,
    subagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const tools = createYnDomainTools({ request, publishCustomMessage: async () => {}, subagents, domainRun });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"));
    const run = await execute(tool("runTranslationSubagents"));
    assert.ok(started);
    await started.onSettled({
      batch: { id: run.details.batchId, status: "failed", subagents: [] },
      results: [{ documentId: "accepted.txt" }],
      failures: [{ documentId: "failed.txt", error: "provider retries exhausted" }],
      error: new Error("one assignment failed")
    });

    const snapshot = domainRun.snapshot();
    assert.equal(
      snapshot.documents.find((document) => document.id === "accepted.txt")?.completedSubagentBatch?.count,
      1
    );
    assert.equal(
      snapshot.documents.find((document) => document.id === "failed.txt")?.completedSubagentBatch,
      undefined
    );
    assert.match(
      snapshot.documents.find((document) => document.id === "failed.txt")?.recoveryReason ?? "",
      /provider retries exhausted/
    );
    assert.ok(domainRun.recoveryPauseId);
    assert.equal(domainRun.awaitingUserInput, true);
    assert.equal(domainRun.nextRepairPrompt(), undefined);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder inspection and dispatch keep Pi tool results bounded for large manifests", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-tool-result-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    writeFile(path.join(sourceRoot, `chapter-${String(index + 1).padStart(3, "0")}.txt`), `line ${index + 1}\n`, "utf8")
  ));
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      return {
        id: "bounded-folder-batch",
        kind: "translation",
        status: "running",
        startedAt: 1,
        subagents: options.tasks.slice(0, 3).map((task, index) => ({
          id: `bounded-child-${index}`,
          batchId: "bounded-folder-batch",
          kind: "translation",
          label: task.label,
          documentId: task.documentId,
          fromLine: task.fromLine,
          toLine: task.toLine,
          status: "running",
          startedAt: 1
        }))
      };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_tool_result",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "en->zh-CN",
    subagentEnabled: true,
    subagentCount: 3
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  const tools = createYnDomainTools({ request, publishCustomMessage: async () => {}, subagents, domainRun });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    const inspected = await execute(tool("inspectTranslationContext"));
    assert.equal(inspected.details.sourceSelection.documentCount, 40);
    assert.equal(inspected.details.sourceSelection.documents.length, 12);
    assert.equal(inspected.details.sourceSelection.omittedDocumentCount, 28);
    assert.ok(inspected.content[0].text.length < 12_000, `inspection result is still oversized (${inspected.content[0].text.length} chars)`);

    const dispatched = await execute(tool("runTranslationSubagents"));
    assert.equal(dispatched.details.assignmentCount, 40);
    assert.equal(dispatched.details.assignments.length, 12);
    assert.equal(dispatched.details.candidates.length, 12);
    assert.equal(dispatched.details.omittedAssignmentCount, 28);
    assert.equal(dispatched.details.omittedCandidateCount, 28);
    assert.ok(dispatched.content[0].text.length < 12_000, `dispatch result is still oversized (${dispatched.content[0].text.length} chars)`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder translation resume dispatches only hash-current unresolved ranges", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-resume-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const sourceText = "原文一\n原文二\n原文三\n原文四\n";
  const candidateText = "译文一\n译文二\n译文三\n译文四\n";
  const sourceFile = path.join(sourceRoot, "script.txt");
  await writeFile(sourceFile, sourceText, "utf8");
  const candidate = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourceFile],
    documentId: "script.txt"
  });
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, candidateText, "utf8");
  let started;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      started = options;
      return { id: "resume-batch", kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_resume",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 2,
    subagentEnabled: true,
    subagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"), {});
    domainRun.recordTranslationArtifactMutation("script.txt");
    const accepted = createTranslationAlignmentRangeAudit({
      documentId: "script.txt",
      sourceText: "原文一\n原文二",
      candidateText: "译文一\n译文二",
      candidatePath: candidate,
      languagePair: "ja->zh-CN",
      fromLine: 1,
      toLine: 2,
      sourceLineCount: 4
    });
    accepted.checks.forEach((check) => { check.verdict = "aligned"; });
    translationAlignmentState.ranges["script.txt"] = [accepted];

    await execute(tool("runTranslationSubagents"));
    assert.deepEqual(
      started.tasks.map((task) => [task.documentId, task.fromLine, task.toLine]),
      [["script.txt", 3, 4]],
      "resuming a full workflow must not recreate the accepted first assignment"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("hash-current completed folder evidence cannot be discarded or silently restarted by an empty resume", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-complete-resume-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const sourceText = "原文一\n原文二\n";
  const candidateText = "译文一\n译文二\n";
  const sourceFile = path.join(sourceRoot, "script.txt");
  await writeFile(sourceFile, sourceText, "utf8");
  const candidate = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourceFile],
    documentId: "script.txt"
  });
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, candidateText, "utf8");
  let starts = 0;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch() {
      starts += 1;
      return { id: "must-not-start", kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_complete_resume",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 2,
    subagentEnabled: true,
    subagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const accepted = createTranslationAlignmentRangeAudit({
    documentId: "script.txt",
    sourceText: sourceText.trimEnd(),
    candidateText: candidateText.trimEnd(),
    candidatePath: candidate,
    languagePair: "ja->zh-CN",
    fromLine: 1,
    toLine: 2,
    sourceLineCount: 2
  });
  accepted.checks.forEach((check) => { check.verdict = "aligned"; });
  translationAlignmentState.ranges["script.txt"] = [accepted];
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"), {});
    const resumed = await execute(tool("runTranslationSubagents"));
    assert.equal(resumed.details.status, "no_outstanding_assignments");
    assert.equal(starts, 0);
    assert.equal(await readFile(candidate, "utf8"), candidateText);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder translation resume preserves pending review and rejected-line repair instead of retranslating scopes", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-review-resume-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const sourceLines = ["原文一", "原文二", "原文三", "原文四", "原文五", "原文六", "原文七", "原文八", "原文九", "原文十", "原文十一", "原文十二"];
  const candidateLines = ["译文一", "译文二", "译文三", "译文四", "译文五", "译文六", "译文七", "译文八", "译文九", "译文十", "旧译十一", "译文十二"];
  const sourceFile = path.join(sourceRoot, "script.txt");
  await writeFile(sourceFile, `${sourceLines.join("\n")}\n`, "utf8");
  const candidate = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourceFile],
    documentId: "script.txt"
  });
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, `${candidateLines.join("\n")}\n`, "utf8");
  let startedReview;
  let translationStarts = 0;
  const subagents = {
    hasRunning: () => false,
    startTranslationReviewBatch(options) {
      startedReview = options;
      return { id: "review-resume-batch", kind: "translation-review", status: "running", startedAt: 1, subagents: [] };
    },
    startTranslationBatch() {
      translationStarts += 1;
      return { id: "unexpected-translation-batch", kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_review_resume",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 2,
    subagentEnabled: true,
    subagentCount: 2,
    reviewSubagentCount: 5
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const makeScope = (fromLine, toLine) => createTranslationAlignmentRangeAudit({
    documentId: "script.txt",
    sourceText: sourceLines.slice(fromLine - 1, toLine).join("\n"),
    candidateText: candidateLines.slice(fromLine - 1, toLine).join("\n"),
    candidatePath: candidate,
    languagePair: "ja->zh-CN",
    fromLine,
    toLine,
    sourceLineCount: sourceLines.length
  });
  const accepted = makeScope(1, 2);
  accepted.checks.forEach((check) => { check.verdict = "aligned"; });
  const pending = [makeScope(3, 4), makeScope(5, 6), makeScope(7, 8), makeScope(9, 10)];
  const rejected = makeScope(11, 12);
  rejected.checks.forEach((check) => { check.verdict = "aligned"; });
  rejected.checks[0].verdict = "misaligned";
  rejected.checks[0].reason = "semantic_mistranslation: replace stale line 11 with its current source meaning";
  translationAlignmentState.ranges["script.txt"] = [accepted, ...pending, rejected];
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"), {});
    domainRun.recordTranslationArtifactMutation("script.txt");
    await execute(tool("runTranslationSubagents"));
    assert.equal(translationStarts, 0, "an interrupted read-only review must not pass through a translation worker first");
    assert.equal(startedReview.maxWorkers, 4, "four pending reviews use the independent review ceiling instead of the translation ceiling of two");
    assert.deepEqual(
      startedReview.tasks.map((task) => [task.documentId, task.fromLine, task.toLine]),
      [
        ["script.txt", 3, 4],
        ["script.txt", 5, 6],
        ["script.txt", 7, 8],
        ["script.txt", 9, 10]
      ],
      "only the pending read-only review is resumed; rejected repair debt remains for the next Host turn"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a local explicit repair can select a valid source file omitted from the full-workflow order", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-local-manifest-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "script.txt"), "脚本\n", "utf8");
  await writeFile(path.join(sourceRoot, "tips.txt"), "提示一\n提示二\n", "utf8");
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    folderTranslationOrder: "{script.txt}",
    sessionId: "pi_local_manifest",
    prompt: "定位 tips.txt 的坏行，再叫五个 subagents 并行修复。",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN"
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    folderSource: true,
    fullWorkflow: false
  });
  const subagents = { hasRunning: () => false };
  const tools = createYnDomainTools({ request, publishCustomMessage: async () => {}, subagents, domainRun });
  const tool = (name) => {
    const value = tools.find((entry) => entry.name === name);
    assert.ok(value, `missing tool ${name}`);
    return value;
  };
  try {
    const inspected = await execute(tool("inspectTranslationContext"), {});
    assert.deepEqual(inspected.details.sourceSelection.documents.map((document) => document.id), ["script.txt", "tips.txt"]);
    const selected = await execute(tool("selectSourceDocument"), { documentId: "tips.txt" });
    assert.equal(selected.details.documentId, "tips.txt");
    assert.equal(selected.details.sourceLineCount, 2);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("five exact folder workers may drain more than five host-generated assignments", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-balanced-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const documents = [
    ["01-short.txt", 2],
    ["02-longest.txt", 10],
    ["03-medium.txt", 4],
    ["04-long.txt", 9],
    ["05-small.txt", 3],
    ["06-longer.txt", 8]
  ];
  for (const [name, lineCount] of documents) {
    await writeFile(
      path.join(sourceRoot, name),
      `${Array.from({ length: lineCount }, (_, index) => `${name}-${index + 1}`).join("\n")}\n`,
      "utf8"
    );
  }
  let started;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      started = options;
      return {
        id: "balanced-folder-batch",
        kind: "translation",
        status: "running",
        startedAt: 1,
        subagents: []
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 5
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_balanced",
      prompt: "translate folder",
      providerId: "test",
      modelId: "test",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5
    },
    publishCustomMessage: async () => {},
    subagents,
    domainRun
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);

  try {
    await execute(run);
    assert.deepEqual(
      started.tasks.map((task) => [task.documentId, task.toLine, task.scheduleStage]),
      [
        ["02-longest.txt", 10, 0],
        ["04-long.txt", 9, 0],
        ["06-longer.txt", 8, 0],
        ["03-medium.txt", 4, 0],
        ["05-small.txt", 3, 0],
        ["01-short.txt", 2, 0]
      ]
    );
    assert.equal(started.maxWorkers, 5);
    assert.equal(typeof started.taskStage, "function");
    domainRun.recordTranslationDiscoveries([{
      id: "pending-character",
      kind: "character",
      documentId: "01-short.txt",
      fromLine: 1,
      toLine: 2,
      sourceHash: "source-hash",
      candidateHash: "candidate-hash",
      sourceName: "人物A",
      evidenceLine: 2,
      evidence: "No canon gender marker in the assigned passage.",
      gender: "unknown",
      confidence: "unknown"
    }]);
    const discoveryContext = started.parentCompletionContext({
      batch: { id: "balanced-folder-batch", status: "completed", subagents: [] },
      results: [
        {
          discoveries: {
            glossaryCandidates: [{
              source: "固有名",
              target: "专名",
              category: "proper_noun",
              evidenceLine: 1,
              rationale: "Named entity"
            }],
            characterFacts: [{
              sourceName: "人物A",
              evidenceLine: 2,
              evidence: "No canon gender marker in the assigned passage.",
              gender: "unknown",
              confidence: "unknown"
            }]
          }
        },
        {
          discoveries: {
            glossaryCandidates: [{
              source: "固有名",
              target: "专名",
              category: "proper_noun",
              evidenceLine: 1,
              rationale: "Named entity"
            }],
            characterFacts: []
          }
        }
      ]
    });
    assert.equal(discoveryContext.details.glossaryCount, 0,
      "provisional glossary terms should already be committed before batch completion");
    assert.equal(discoveryContext.details.characterCount, 1);
    assert.match(discoveryContext.content, /reject ordinary dictionary words or everyday phrases/i);
    assert.match(discoveryContext.content, /unknown gender\/pronoun/i);
    assert.match(discoveryContext.content, /search project text/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("source-language residue cannot pass final artifact validation", async () => {
  const fx = await fixture({}, "こんにちは世界\n");
  try {
    const candidateDir = path.join(fx.outputDir, "AI_translation");
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, "source_translated.txt"), "こんにちは世界来了\n", "utf8");
    await assert.rejects(
      () => execute(fx.tool("validateTranslationArtifact")),
      /quality-debt lines 1|likely_untranslated|validation failed/i
    );
  } finally {
    await fx.close();
  }
});

await test("final validation returns bounded repair metadata instead of the full large-file finding payload", async () => {
  const lineCount = 20_000;
  const sourceText = `${Array.from({ length: lineCount }, (_, index) => `Source sentence ${index + 1}.`).join("\n")}\n`;
  const fx = await fixture({
    requestPatch: { languagePair: "en->zh-CN" }
  }, sourceText);
  try {
    const candidateDir = path.join(fx.outputDir, "AI_translation");
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, "source_translated.txt"), sourceText, "utf8");
    await assert.rejects(
      () => execute(fx.tool("validateTranslationArtifact")),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length < 20_000, `validation error must stay bounded, received ${error.message.length} chars`);
        assert.match(error.message, /blocking lines 1-20000/i);
        return true;
      }
    );
  } finally {
    await fx.close();
  }
});

await test("final validation uses the canonical plain forbidden-term style parser", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true
  });
  const fx = await fixture({ domainRun }, "別の行\n");
  try {
    const workspace = path.join(fx.outputDir, ".translation-workshop");
    const candidateDir = path.join(fx.outputDir, "AI_translation");
    await mkdir(workspace, { recursive: true });
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(workspace, "style_guide.md"), "forbidden: 机器翻译腔\n", "utf8");
    await writeFile(path.join(candidateDir, "source_translated.txt"), "机器翻译腔\n", "utf8");
    await assert.rejects(
      () => execute(fx.tool("validateTranslationArtifact")),
      /validation failed|机器翻译腔|style/i
    );
  } finally {
    await fx.close();
  }
});

await test("direct writes cannot bypass the translation artifact contract", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/source_translated.txt",
      content: "bypass"
    }), /restricted/i);
    await execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/character_bible.md",
      content: "# Character Bible\n\n## 勇者 / 勇者\n- Gender/pronouns: male; he/him; inferred\n- Terms of address: 勇者\n"
    });
    assert.match(await readFile(path.join(fx.outputDir, "AI_translation/_workspace/character_bible.md"), "utf8"), /Character Bible/);
  } finally {
    await fx.close();
  }
});

await test("generated workspace assets must satisfy their host schemas before completion", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/glossary_candidates.json",
      content: JSON.stringify([{ source: "勇者", target: "勇者" }])
    }), /expected an object root|entries/i);
    await assert.rejects(() => execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/character_bible.md",
      content: "   \n"
    }), /must not be empty/i);
    await assert.rejects(() => execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/character_bible.md",
      content: "# Character Bible\n\n## 勇者 / 勇者\n- Voice/register: formal\n"
    }), /Gender\/pronouns|Terms of address/i);
    await assert.rejects(() => execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/GLOSSARY_CANDIDATES.JSON",
      content: "{}"
    }), /entries/i);
    await assert.rejects(() => execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/CHARACTER_BIBLE.MD",
      content: "   \n"
    }), /must not be empty/i);
    const canonical = await execute(fx.tool("writeProjectFile"), {
      path: "AI_translation/_workspace/CHARACTER_BIBLE.MD",
      content: "# Character Bible\n\n## 勇者 / 勇者\n- Gender/pronouns: male; he/him; confirmed\n- Terms of address: 勇者\n"
    });
    assert.equal(canonical.details.relativePath, "AI_translation/_workspace/character_bible.md");
  } finally {
    await fx.close();
  }
});

await test("subagent delegation rejects overlapping ownership before any child starts", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 2 },
        { fromLine: 2, toLine: 3 }
      ]
    }), /overlap/i);
  } finally {
    await fx.close();
  }
});

await test("translation delegation accepts any useful 1..N range count while preserving whole-source coverage", async () => {
  let capturedTasks = [];
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(args) {
      capturedTasks = args.tasks;
      return { id: "batch_up_to_five", status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({ subagents, domainRun });
  try {
    await assert.rejects(() => execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1 },
        { fromLine: 3, toLine: 3 }
      ]
    }), /cover every source line/i);
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: [{ fromLine: 1, toLine: 3 }]
    });
    assert.deepEqual(capturedTasks.map(({ fromLine, toLine }) => ({ fromLine, toLine })), [
      { fromLine: 1, toLine: 3 }
    ]);
  } finally {
    await fx.close();
  }
});

await test("translation review pool uses the user's review Agent ceiling instead of the translation default", async () => {
  let batchArgs;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(args) {
      batchArgs = args;
      return { id: "batch_user_review_ceiling", status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 5,
      reviewSubagentCount: 2
    }
  }, "一\n二\n三\n四\n五\n六\n");
  try {
    const started = await execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 2 },
        { fromLine: 3, toLine: 4 },
        { fromLine: 5, toLine: 6 }
      ]
    });
    assert.equal(batchArgs.maxWorkers, 3, "three useful translation workers may run under the five-worker ceiling");
    assert.equal(batchArgs.reviewWorkerCount, 2, "the distinct user review ceiling must be authoritative");
    assert.equal(started.details.reviewWorkerCount, 0,
      "lazy review workers must not be reported as active before a translated chunk reaches the queue");
    assert.equal(started.details.activeReviewWorkerCount, 0);
    assert.equal(started.details.reviewWorkerMaximum, 2);
  } finally {
    await fx.close();
  }
});

await test("single-file translation treats the configured child count as a ceiling", async () => {
  let batchArgs;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(args) {
      batchArgs = args;
      return { id: "batch_single_file_ceiling", status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  const source = Array.from({ length: 8 }, (_, index) => `source ${index + 1}`).join("\n");
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 3
    }
  }, source);
  try {
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: Array.from({ length: 8 }, (_, index) => ({
        fromLine: index + 1,
        toLine: index + 1
      }))
    });
    assert.equal(batchArgs.tasks.length, 8);
    assert.equal(batchArgs.maxWorkers, 3, "task count must not override the configured 1..N worker ceiling");
  } finally {
    await fx.close();
  }
});

await test("translation review context failures become repair debt and expand the next review window", async () => {
  let batchArgs;
  let failPersistence = false;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(args) {
      batchArgs = args;
      return { id: "batch_review_windows", status: "running", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const lineCount = 40;
  const sourceLines = Array.from({ length: lineCount }, (_, index) =>
    `Source sentence ${index + 1} has a distinct complete meaning.`
  );
  const fx = await fixture({
    subagents,
    domainRun,
    translationAlignmentState,
    requestPatch: {
      languagePair: "en->zh-CN",
      subagentEnabled: true,
      subagentCount: 3
    },
    persistHostState: async () => {
      if (failPersistence) throw new Error("injected host-state append failure");
    }
  }, `${sourceLines.join("\n")}\n`);
  const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  try {
    await execute(fx.tool("runTranslationSubagents"), {
      tasks: [{ fromLine: 1, toLine: lineCount }]
    });
    assert.equal(batchArgs.reviewWorkerCount, 1);
    assert.equal(typeof batchArgs.prepareChunkReview, "function");
    await mkdir(path.dirname(candidatePath), { recursive: true });
    const candidateLines = sourceLines.map((_line, index) =>
      `这是第 ${index + 1} 行的独立完整中文译文，准确保留了该原句中每一个不同且具体的含义。`
    );
    candidateLines[4] = "中文译文";
    candidateLines[5] = "中文译文";
    candidateLines[6] = "中文译文";
    await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    const stagingPath = await prepareTranslationStagingCandidate({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      documentId: "source.txt",
      sessionId: "pi_test",
      subagentId: "translator-1",
      assignmentId: "source.txt:L1-L12"
    });
    await batchArgs.onStagingCandidateCheckpoint({
      documentId: "source.txt",
      fromLine: 1,
      toLine: lineCount,
      candidatePath: stagingPath,
      accepted: true,
      requiredLines: [],
      repairIssues: []
    });
    assert.equal(translationAlignmentState.ranges["source.txt"][0].candidatePath, stagingPath,
      "a successful write must persist its staging recovery scope before reviewer handoff");
    assert.ok(translationAlignmentState.ranges["source.txt"][0].checks.some((check) => !check.verdict));
    const prepared = await batchArgs.prepareChunkReview({
      subagentId: "translator-1",
      label: "Translator 1",
      documentId: "source.txt",
      fromLine: 1,
      toLine: lineCount,
      candidatePath: stagingPath,
      validation: { ok: true, accepted: true, blocking: [], warnings: [] },
      discoveries: { glossaryCandidates: [], characterFacts: [] }
    });
    assert.ok(prepared.task);
    const assignment = await prepared.read(prepared.task);
    const selectedLines = assignment.windows.flatMap((window) =>
      window.rows.filter((row) => row.selected).map((row) => row.line)
    );
    assert.ok(selectedLines.includes(5) && selectedLines.includes(6) && selectedLines.includes(7));
    const contextLines = assignment.windows.flatMap((window) =>
      window.rows.filter((row) => !row.selected).map((row) => row.line)
    );
    assert.ok(contextLines.some((line) => line >= 3 && line <= 9), "risk rows must include nearby context");
    assert.ok(
      assignment.windows.every((window, index, windows) => index === 0 || windows[index - 1].toLine + 1 < window.fromLine),
      "overlapping context windows must be merged"
    );
    const initialRiskLineCount = prepared.task.riskLineCount;
    const propagatedLine = contextLines[0];
    await assert.rejects(
      () => prepared.submit(prepared.task, [{
        line: propagatedLine,
        code: "semantic-misalignment"
      }]),
      /actionable repair note/i,
      "a review rejection without a concrete correction instruction must not create repair debt"
    );
    const rejected = await prepared.submit(prepared.task, [{
      line: propagatedLine,
      code: "neighboring_shift",
      note: "the same shifted pattern continues into this context row"
    }, {
      line: propagatedLine,
      code: "semantic-misalignment",
      note: "the candidate carries the neighboring source meaning"
    }, {
      line: propagatedLine,
      code: "MISTRANSLATION",
      note: "the candidate carries the neighboring source meaning"
    }]);
    assert.equal(rejected.accepted, false);
    assert.deepEqual(rejected.feedback.map((feedback) => feedback.line), [propagatedLine]);
    assert.equal(
      rejected.feedback[0].reason,
      "line_identity+semantic_mistranslation: the same shifted pattern continues into this context row | the candidate carries the neighboring source meaning"
    );
    const [rejectedScope] = translationAlignmentState.ranges["source.txt"];
    const propagatedCheck = rejectedScope.checks.find((check) => check.line === propagatedLine);
    assert.equal(propagatedCheck?.verdict, "misaligned");
    assert.ok(propagatedCheck?.signals.includes("review_context_failure"));
    assert.equal(
      rejectedScope.riskLineCount,
      initialRiskLineCount + 1,
      "a failed context row must be promoted from context into Host repair debt"
    );
    assert.equal(
      prepared.task.riskLineCount,
      rejectedScope.riskLineCount,
      "the active reviewer task telemetry must reflect a newly promoted context failure immediately"
    );
    assert.ok(
      rejectedScope.checks
        .filter((check) => check.line !== propagatedLine)
        .every((check) => check.verdict === "aligned" && check.reason === undefined),
      "accepted selected rows must not accumulate per-line pass reasons"
    );

    const malformedLegacyRejection = rejectedScope.checks.find((check) => check.line === propagatedLine);
    malformedLegacyRejection.reason = `Translation review rejected line ${propagatedLine}.`;
    const recoveredLegacyReview = await batchArgs.prepareChunkReview({
      subagentId: "translator-1",
      label: "Translator 1",
      documentId: "source.txt",
      fromLine: 1,
      toLine: lineCount,
      candidatePath: stagingPath,
      validation: { ok: true, accepted: true, blocking: [], warnings: [] },
      discoveries: { glossaryCandidates: [], characterFacts: [] }
    });
    assert.ok(recoveredLegacyReview.task,
      "a legacy rejection without actionable evidence must reopen reviewer work instead of returning a generic repair reason");
    const recoveredLegacyAssignment = await recoveredLegacyReview.read(recoveredLegacyReview.task);
    assert.ok(
      recoveredLegacyAssignment.windows.some((window) => window.rows.some((row) => (
        row.line === propagatedLine && row.selected
      ))),
      "the malformed legacy rejection must become exact pending review debt"
    );
    const restoredActionableRejection = await recoveredLegacyReview.submit(recoveredLegacyReview.task, [{
      line: propagatedLine,
      code: "semantic_misalignment",
      note: "replace the neighboring source meaning with this row's own complete meaning"
    }]);
    assert.equal(restoredActionableRejection.accepted, false);
    assert.match(restoredActionableRejection.feedback[0].reason, /^line_identity:/);
    assert.match(restoredActionableRejection.feedback[0].reason, /replace the neighboring source meaning/i);

    candidateLines[propagatedLine - 1] =
      `这是修复后的第 ${propagatedLine} 行独立完整中文译文，准确保留了该原句中每一个不同且具体的含义。`;
    await writeFile(stagingPath, `${candidateLines.join("\n")}\n`, "utf8");
    await batchArgs.onStagingCandidateCheckpoint({
      documentId: "source.txt",
      fromLine: 1,
      toLine: lineCount,
      candidatePath: stagingPath,
      accepted: true,
      requiredLines: [],
      repairIssues: []
    });
    const checkpointedRepairScope = translationAlignmentState.ranges["source.txt"][0];
    assert.deepEqual(
      checkpointedRepairScope.checks.filter((check) => !check.verdict).map((check) => check.line),
      [propagatedLine],
      "the repair checkpoint must preserve every previously accepted review verdict"
    );
    const preparedRepair = await batchArgs.prepareChunkReview({
      subagentId: "translator-1",
      label: "Translator 1",
      documentId: "source.txt",
      fromLine: 1,
      toLine: lineCount,
      candidatePath: stagingPath,
      validation: { ok: true, accepted: true, blocking: [], warnings: [] },
      discoveries: { glossaryCandidates: [], characterFacts: [] }
    });
    assert.ok(preparedRepair.task);
    assert.deepEqual(
      translationAlignmentState.ranges["source.txt"][0].checks
        .filter((check) => !check.verdict)
        .map((check) => check.line),
      [propagatedLine],
      "preparing the same hash-current staging candidate must be idempotent instead of reopening the full review set"
    );
    const repairAssignment = await preparedRepair.read(preparedRepair.task);
    const repairTarget = repairAssignment.windows
      .flatMap((window) => window.rows)
      .find((row) => row.line === propagatedLine);
    assert.equal(repairTarget?.selected, true);
    assert.ok(repairTarget?.signals.includes("review_repair_target"));
    assert.ok(
      repairAssignment.windows.some((window) => (
        propagatedLine >= window.fromLine
        && propagatedLine <= window.toLine
        && window.fromLine < window.toLine
      )),
      "repair review must shift a neighboring context window around the newly promoted failure"
    );
    assert.deepEqual(await preparedRepair.submit(preparedRepair.task, []), { accepted: true });
    const [acceptedScope] = translationAlignmentState.ranges["source.txt"];
    assert.ok(acceptedScope.checks.every((check) => check.verdict === "aligned"));
    assert.ok(acceptedScope.checks.every((check) => check.reason === undefined));
    await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
    await batchArgs.onArtifactMutation("source.txt", { fromLine: 1, toLine: lineCount });
    const [committedScope] = translationAlignmentState.ranges["source.txt"];
    assert.equal(committedScope.candidatePath, candidatePath);
    assert.ok(committedScope.checks.every((check) => check.verdict === "aligned"));
    assert.ok(
      committedScope.checks.some((check) => check.line !== propagatedLine),
      "repair-only acceptance must retain earlier risk/sample evidence through the real commit path"
    );
    const committedStateSnapshot = JSON.stringify(translationAlignmentState);
    candidateLines[0] = "这是尚未持久化的新候选。";
    await writeFile(stagingPath, `${candidateLines.join("\n")}\n`, "utf8");
    failPersistence = true;
    await assert.rejects(
      () => batchArgs.onStagingCandidateCheckpoint({
        documentId: "source.txt",
        fromLine: 1,
        toLine: lineCount,
        candidatePath: stagingPath,
        accepted: true,
        requiredLines: [],
        repairIssues: []
      }),
      /injected host-state append failure/
    );
    failPersistence = false;
    assert.equal(JSON.stringify(translationAlignmentState), committedStateSnapshot,
      "a failed checkpoint append must roll back only its in-memory review mutation");
  } finally {
    await fx.close();
  }
});

await test("folder cold resume preserves a rejected staging candidate and exact repair debt", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-staging-resume-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const sourceLines = ["原文一", "原文二", "原文三", "原文四"];
  const stagedLines = ["译文一", "译文二", "问题译文", "译文四"];
  const sourceFile = path.join(sourceRoot, "script.txt");
  await writeFile(sourceFile, `${sourceLines.join("\n")}\n`, "utf8");
  const stagingPath = await prepareTranslationStagingCandidate({
    outputDir,
    sourcePaths: [sourceFile],
    documentId: "script.txt",
    sessionId: "pi_folder_staging_resume",
    subagentId: "translator-before-stop",
    assignmentId: "script.txt:L1-L4"
  });
  await writeFile(stagingPath, `${stagedLines.join("\n")}\n`, "utf8");
  let started;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch(options) {
      started = options;
      return { id: "staging-resume-batch", kind: "translation", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_staging_resume",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 4,
    subagentEnabled: true,
    subagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const rejected = createTranslationChunkReviewAudit({
    documentId: "script.txt",
    sourceText: sourceLines.join("\n"),
    candidateText: stagedLines.join("\n"),
    candidatePath: stagingPath,
    languagePair: "ja->zh-CN",
    fromLine: 1,
    toLine: 4,
    sourceLineCount: 4
  });
  rejected.checks.forEach((check) => { check.verdict = "aligned"; });
  rejected.checks[0].verdict = "misaligned";
  rejected.checks[0].reason = "semantic_mistranslation: replace this row with its own complete source meaning";
  if (rejected.checks[1]) delete rejected.checks[1].verdict;
  translationAlignmentState.ranges["script.txt"] = [rejected];
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"), {});
    await execute(tool("runTranslationSubagents"));
    assert.equal(started.tasks.length, 1);
    assert.equal(started.tasks[0].stagingCandidatePath, stagingPath);
    assert.deepEqual(started.tasks[0].reviewFeedback, [{
      line: rejected.checks[0].line,
      reason: "semantic_mistranslation: replace this row with its own complete source meaning"
    }]);
    assert.equal(started.tasks[0].reviewOnly, undefined,
      "exact repair debt must run before still-pending review evidence in the same staging scope");
    assert.equal(
      translationAlignmentState.ranges["script.txt"][0].candidatePath,
      stagingPath,
      "cold planning must not prune hash-current staging evidence"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder cold resume reopens malformed legacy rejection evidence in the review pool", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-malformed-review-resume-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const sourceLines = ["原文一", "原文二", "原文三", "原文四"];
  const candidateLines = ["译文一", "译文二", "问题译文", "译文四"];
  const sourceFile = path.join(sourceRoot, "script.txt");
  await writeFile(sourceFile, `${sourceLines.join("\n")}\n`, "utf8");
  const stagingPath = await prepareTranslationStagingCandidate({
    outputDir,
    sourcePaths: [sourceFile],
    documentId: "script.txt",
    sessionId: "pi_folder_malformed_review_resume",
    subagentId: "translator-before-stop",
    assignmentId: "script.txt:L1-L4"
  });
  await writeFile(stagingPath, `${candidateLines.join("\n")}\n`, "utf8");
  let started;
  let persisted = 0;
  const subagents = {
    hasRunning: () => false,
    startTranslationReviewBatch(options) {
      started = options;
      return { id: "malformed-review-resume", kind: "translation-review", status: "running", startedAt: 1, subagents: [] };
    }
  };
  const request = {
    outputDir,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    sessionId: "pi_folder_malformed_review_resume",
    prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation",
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    translationSplitSize: 4,
    subagentEnabled: true,
    subagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const translationAlignmentState = createTranslationAlignmentHostState();
  const rejected = createTranslationChunkReviewAudit({
    documentId: "script.txt",
    sourceText: sourceLines.join("\n"),
    candidateText: candidateLines.join("\n"),
    candidatePath: stagingPath,
    languagePair: "ja->zh-CN",
    fromLine: 1,
    toLine: 4,
    sourceLineCount: 4
  });
  rejected.checks.forEach((check) => { check.verdict = "aligned"; });
  rejected.checks[0].verdict = "misaligned";
  rejected.checks[0].reason = `Translation review rejected line ${rejected.checks[0].line}.`;
  translationAlignmentState.ranges["script.txt"] = [rejected];
  const tools = createYnDomainTools({
    request,
    publishCustomMessage: async () => {},
    subagents,
    domainRun,
    translationAlignmentState,
    persistHostState: async () => { persisted += 1; }
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await execute(tool("inspectTranslationContext"), {});
    await execute(tool("runTranslationSubagents"));
    assert.equal(started.tasks.length, 1);
    assert.equal(started.tasks[0].reviewOnly, true);
    assert.equal(started.tasks[0].reviewFeedback, undefined);
    assert.equal(rejected.checks[0].verdict, undefined);
    assert.equal(rejected.checks[0].reason, undefined);
    assert.equal(persisted > 0, true, "reopened review debt must be durable before dispatch");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("subagent model overrides cannot mix a task model with the parent provider", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1, modelId: "task-model" },
        { fromLine: 2, toLine: 3 }
      ]
    }), /task model override requires a providerId/i);
  } finally {
    await fx.close();
  }
});

await test("full multi-line workflows reserve chunk alignment verdicts for review Pi workers", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "translate",
    subagentEnabled: true,
    subagentCount: 2
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      subagentEnabled: true,
      subagentCount: 2,
      reviewSubagentCount: 2
    }
  });
  try {
    await execute(fx.tool("inspectTranslationContext"), {});
    assert.equal(domainRun.maximumSubagentsForActiveDocument, 2);
    await assert.rejects(
      () => execute(fx.tool("inspectTranslationAlignment")),
      /owned by the read-only translation-review Pi pool/i
    );
    await assert.rejects(
      () => execute(fx.tool("recordTranslationAlignmentChecks"), {
        auditId: "parent_must_not_own_worker_audit",
        failures: []
      }),
      /owned by the read-only translation-review Pi pool/i
    );
  } finally {
    await fx.close();
  }
});

await test("single-line workflows use parent tools and reject impossible shard delegation", async () => {
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", prompt: "translate" });
  const fx = await fixture({ domainRun }, "こんにちは {name}\n");
  try {
    await execute(fx.tool("inspectTranslationContext"), {});
    assert.equal(domainRun.maximumSubagentsForActiveDocument, 0);
    await assert.rejects(() => execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1 },
        { fromLine: 1, toLine: 1 }
      ]
    }), /single-line|parent/i);
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 1,
      lines: ["你好 {name}"]
    });
    const alignment = await execute(fx.tool("inspectTranslationAlignment"));
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 1 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 1 });
    await execute(fx.tool("recordTranslationAlignmentChecks"), {
      auditId: alignment.details.auditId,
      failures: []
    });
    await execute(fx.tool("validateTranslationArtifact"));
    assert.deepEqual(domainRun.incompleteReasons(), []);
  } finally {
    await fx.close();
  }
});

await test("domain tools cannot satisfy a translation run with proofreading artifacts", async () => {
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", prompt: "translate" });
  const fx = await fixture({ domainRun });
  try {
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("writeTranslationChunk"), {
      fromLine: 1,
      toLine: 3,
      lines: ["你好 {name}", "", "再见"]
    });
    await assert.rejects(() => execute(fx.tool("writeProofreadFindings"), { findings: [] }), /translation.*proofread|proofread.*translation/i);
    await assert.rejects(() => readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"), /ENOENT/);
  } finally {
    await fx.close();
  }
});

await test("the Host typed operation activates workflow intent before inspection", async () => {
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation" });
  const fx = await fixture({
    domainRun,
    requestPatch: { workflowIntent: "translation" }
  });
  try {
    assert.equal(domainRun.kind, "translation");
    await execute(fx.tool("inspectTranslationContext"), {});
    assert.equal(domainRun.kind, "translation");
    assert.match(domainRun.incompleteReasons().join("\n"), /translation subagents/i);
    assert.match(domainRun.incompleteReasons().join("\n"), /whole-artifact validation/i);
  } finally {
    await fx.close();
  }
});

await test("inspect-only tool use does not turn a conceptual question into a workflow", async () => {
  const domainRun = createYnDomainRunContract({ prompt: "请解释如何翻译当前文件" });
  const fx = await fixture({ domainRun });
  try {
    await execute(fx.tool("inspectTranslationContext"), {});
    assert.equal(domainRun.kind, undefined);
    assert.deepEqual(domainRun.incompleteReasons(), []);
  } finally {
    await fx.close();
  }
});

await test("two requested ranges launch two native Pi child runtimes and close the same two cards", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 20, max: 40 } });
  const models = createModels();
  models.setProvider(faux.provider);
  let resolveConcurrentReviews;
  const concurrentReviews = new Promise((resolve) => { resolveConcurrentReviews = resolve; });
  let activeReviewReads = 0;
  let maximumConcurrentReviewReads = 0;
  const response = async (context) => {
    const toolResultMessages = context.messages.filter((message) => message.role === "toolResult");
    const toolResults = toolResultMessages.length;
    if (context.systemPrompt.includes("translation safety reviewer")) {
      if (toolResults === 0) {
        activeReviewReads += 1;
        maximumConcurrentReviewReads = Math.max(maximumConcurrentReviewReads, activeReviewReads);
        if (activeReviewReads === 2) resolveConcurrentReviews();
        await Promise.race([
          concurrentReviews,
          new Promise((_, reject) => setTimeout(() => reject(new Error("review workers did not overlap")), 2_000))
        ]);
        activeReviewReads -= 1;
        return fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" });
      }
      if (toolResults === 1) {
        return fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText("Review accepted."));
    }
    const firstRange = context.systemPrompt.includes("L1-L1");
    if (toolResults === 0) {
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
    }
    if (toolResults === 1) {
      const content = toolResultMessages[0].content;
      const payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
      return fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
        blocks: payload.sourceBlocks.map((block) => ({
          id: block.id,
          lines: block.lines.map((line) => {
            const marker = line.slice(0, 1);
            const source = line.slice(1);
            return `${marker}${source.includes("こんにちは") ? "你好 {name}" : source.includes("さようなら") ? "再见" : source}`;
          })
        }))
      }), { stopReason: "toolUse" });
    }
    if (toolResults === 2) {
      return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText(firstRange ? "第一段完成" : "第二段完成"));
  };
  faux.setResponses(Array.from({ length: 20 }, () => response));
  const cards = [];
  const selectionRequests = [];
  const fx = await fixture({
    requestPatch: {
      subagentProviderId: "lighter-provider",
      subagentModelId: "luna-mini"
    },
    publishCustomMessage: async (message) => cards.push(message),
    createSubagentModelSelection: async (request) => {
      selectionRequests.push(request);
      return {
        models,
        model: faux.getModel(),
        providerId: request.providerId ?? faux.provider.id,
        modelId: request.modelId ?? faux.getModel().id
      };
    }
  });
  try {
    const result = await execute(fx.tool("runTranslationSubagents"), {
      tasks: [
        { fromLine: 1, toLine: 1, label: "A", providerId: "task-provider", modelId: "task-model" },
        { fromLine: 2, toLine: 3, label: "B" }
      ]
    });
    assert.equal(result.details.status, "running");
    assert.equal(result.details.subagents.length, 2);
    await fx.subagents.waitForAll();
    assert.equal(maximumConcurrentReviewReads, 2, "two review workers must inspect ready chunks concurrently");
    const ids = new Set(cards.map((card) => card.details.subagentId));
    assert.equal(ids.size, 4, "two translation workers and two review workers should be persistent");
    const selections = selectionRequests.map(({ providerId, modelId }) => ({ providerId, modelId }));
    assert.ok(selections.some(({ providerId, modelId }) => providerId === "task-provider" && modelId === "task-model"));
    assert.ok(selections.some(({ providerId, modelId }) => providerId === "lighter-provider" && modelId === "luna-mini"));
    assert.equal(
      selections.filter(({ providerId, modelId }) => providerId === "lighter-provider" && modelId === "luna-mini").length,
      3,
      "the configured child model must also run the two review workers"
    );
    const terminalModelSelections = [];
    for (const id of ids) {
      const childCards = cards.filter((card) => card.details.subagentId === id);
      const isReviewer = childCards[0].customType === "subagent.translation-review";
      const statuses = childCards.map((card) => card.details.status);
      assert.equal(statuses[0], "running");
      assert.equal(statuses.at(-1), "completed", childCards.at(-1)?.details?.error);
      assert.equal(childCards.every((card) => !Object.hasOwn(card.details, "transcript")), true);
      const transcript = await fx.subagents.inspectTranscript(id);
      assert.ok(
        transcript.some((message) => message.role === "toolResult"),
        "translation child Pi JSONL did not retain native tool progress"
      );
      assert.ok(childCards.every((card) => card.details.modelName === faux.getModel().name));
      assert.ok(childCards.every((card) => card.details.providerId === childCards[0].details.providerId));
      assert.ok(childCards.every((card) => card.details.modelId === childCards[0].details.modelId));
      if (!isReviewer) terminalModelSelections.push({
          providerId: childCards.at(-1).details.providerId,
          modelId: childCards.at(-1).details.modelId
        });
      assert.match(
        childCards.at(-1).details.resultSummary,
        isReviewer ? /review assignments settled/i : /accepted before queue advance/i,
        "translation workers must close only after a review worker accepts their chunks"
      );
    }
    assert.deepEqual(
      terminalModelSelections.sort((left, right) => left.providerId.localeCompare(right.providerId)),
      [
        { providerId: "lighter-provider", modelId: "luna-mini" },
        { providerId: "task-provider", modelId: "task-model" }
      ]
    );
    assert.equal(await readFile(path.join(fx.outputDir, "AI_translation", "source_translated.txt"), "utf8"), "你好 {name}\n\n再见\n");
  } finally {
    await fx.close();
  }
});

await test("proofreading writes the normalized findings artifact", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "Proofread the bound translation.",
      workflowIntent: "proofread",
      subagentEnabled: false
    }
  });
  try {
    const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "你好 {name}\n\n再见\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordProofreadParentReview"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("writeProofreadFindings"), {
      findings: [{
        id: "M1-001",
        severity: "M1",
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText: "こんにちは {name}",
        currentTranslation: "你好 {name}",
        suggestedFix: "您好 {name}",
        rationale: "Tone consistency"
      }]
    });
    const report = JSON.parse(await readFile(path.join(fx.outputDir, "report", "source.proofread.json"), "utf8"));
    assert.equal(report.schemaVersion, "1.0");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].id, "M1-001");
    report.findings[0].suggestedFix = "[ev99999:9999]您好 {name}";
    await writeFile(
      path.join(fx.outputDir, "report", "source.proofread.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await assert.rejects(
      () => execute(fx.tool("finalizeProofreadReport"), {}),
      /unsafe suggestedFix control prefix/i
    );
    report.findings[0].suggestedFix = "您好 {name}";
    report.findings.push({
      id: "M0-003",
      severity: "M0",
      type: "mechanical_scan",
      sourceLine: 3,
      translationLine: 3,
      sourceText: "さようなら",
      currentTranslation: "再见",
      suggestedFix: "再见",
      rationale: "Legacy mechanical evidence must not become a final finding.",
      agentId: "host-mechanical-scan",
      needsVerification: true
    });
    report.findings.push({
      id: "L3-LEGACY-NOOP",
      severity: "L3",
      type: "wording",
      sourceLine: 3,
      translationLine: 3,
      sourceText: "さようなら",
      currentTranslation: "再见",
      suggestedFix: "再见",
      rationale: "Legacy no-op findings must not survive finalization."
    });
    report.summaryPath = "./source_proofread_summary.md";
    await writeFile(
      path.join(fx.outputDir, "report", "source.proofread.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(fx.outputDir, "report", "source_proofread_summary.md"),
      "retired companion",
      "utf8"
    );
    const finalized = await execute(fx.tool("finalizeProofreadReport"), {});
    assert.equal(finalized.details.ok, true);
    assert.equal(finalized.details.removedNoOpFindingCount, 1);
    assert.equal(finalized.details.path, path.join(fx.outputDir, "report", "source.proofread.json"));
    assert.deepEqual(finalized.details.severityCounts, { M1: 1 });
    const finalizedReport = JSON.parse(await readFile(finalized.details.path, "utf8"));
    assert.equal(Object.hasOwn(finalizedReport, "summaryPath"), false);
    assert.deepEqual(finalizedReport.findings.map((finding) => finding.id), ["M1-001"]);
    await assert.rejects(
      readFile(path.join(fx.outputDir, "report", "source_proofread_summary.md"), "utf8"),
      { code: "ENOENT" }
    );
  } finally {
    await fx.close();
  }
});

await test("parent findings preflight rejects before disk mutation and a duplicate retry commits coverage", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: false,
    proofreadMode: "split"
  });
  const proofreadState = createProofreadHostState();
  const fx = await fixture({
    domainRun,
    proofreadState,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      proofreadMode: "split",
      subagentEnabled: false
    }
  });
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
  const finding = {
    id: "M1-001",
    severity: "M1",
    type: "accuracy",
    sourceLine: 1,
    translationLine: 1,
    sourceText: "こんにちは {name}",
    currentTranslation: "你好 {name}",
    suggestedFix: "您好 {name}",
    rationale: "Tone consistency"
  };
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "你好 {name}\n\n再见\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});

    const seeded = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      documentId: "source.txt",
      translationPath,
      kind: "findings_json",
      content: JSON.stringify([finding]),
      mode: "split"
    });
    assert.equal(seeded.ok, true);
    proofreadDocumentHostState(proofreadState, "source.txt").reportInitialized = true;
    const before = await readFile(reportPath, "utf8");

    await assert.rejects(
      () => execute(fx.tool("writeProofreadFindings"), { findings: [finding] }),
      /semantic coverage|semantic review/i
    );
    assert.equal(await readFile(reportPath, "utf8"), before, "preflight rejection must not mutate the report");
    assert.equal(domainRun.snapshot().documents[0].findingsWritten, false);

    await execute(fx.tool("readSourceLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("readTranslationLines"), { fromLine: 1, toLine: 3 });
    await execute(fx.tool("recordProofreadParentReview"), { fromLine: 1, toLine: 3 });
    const retried = await execute(fx.tool("writeProofreadFindings"), { findings: [finding] });
    assert.equal(retried.details.appended, false, "the seeded finding should be an idempotent duplicate");
    assert.equal(domainRun.snapshot().documents[0].findingsWritten, true);

    const finalized = await execute(fx.tool("finalizeProofreadReport"), { notes: "Parent-reviewed report." });
    assert.equal(finalized.details.ok, true);
  } finally {
    await fx.close();
  }
});

await test("continuing split proofreading preserves hash-current findings before the replacement batch starts", async () => {
  let batchStarted = false;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch({ batchId }) {
      batchStarted = true;
      return {
        id: batchId,
        status: "running",
        subagents: [{ id: "proofread_resume_worker", status: "running" }]
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2,
    proofreadMode: "split"
  });
  const proofreadState = createProofreadHostState();
  const fx = await fixture({
    subagents,
    domainRun,
    proofreadState,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      proofreadMode: "split",
      subagentEnabled: true,
      subagentCount: 2,
      proofreadSplitSize: 2
    }
  }, "one\ntwo\nthree\nfour\n");
  const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
  const reportPath = path.join(fx.outputDir, "report", "source.proofread.json");
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "一\n二\n三\n四\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    const seeded = await writeProofreadFindings({
      outputDir: fx.outputDir,
      sourcePaths: [fx.sourcePath],
      documentId: "source.txt",
      translationPath,
      kind: "findings_json",
      mode: "split",
      content: JSON.stringify([{
        id: "M1-RESUME",
        severity: "M1",
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText: "one",
        currentTranslation: "一",
        suggestedFix: "第一",
        rationale: "Finding written by a completed assignment before interruption."
      }])
    });
    assert.equal(seeded.ok, true);
    proofreadDocumentHostState(proofreadState, "source.txt").reportInitialized = true;
    domainRun.recordProofreadArtifactMutation();
    const before = await readFile(reportPath, "utf8");

    await execute(fx.tool("runProofreadSubagents"), { workerCount: 1 });

    assert.equal(batchStarted, true);
    assert.equal(
      await readFile(reportPath, "utf8"),
      before,
      "continuing a split report cleared completed assignment findings before replacement workers ran"
    );
  } finally {
    await fx.close();
  }
});

await test("a fresh folder split batch preserves the aggregate report until valid range replacements arrive", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-proofread-start-transaction-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const sourceA = path.join(sourceRoot, "a.txt");
  const sourceB = path.join(sourceRoot, "b.txt");
  const translationA = path.join(translationRoot, "a_translated.txt");
  const translationB = path.join(translationRoot, "b_translated.txt");
  const reportScope = { kind: "folder", sourcePath: sourceRoot };
  let started;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(options) {
      started = options;
      return {
        id: options.batchId,
        status: "running",
        subagents: [{ id: "folder-proofread-worker", status: "running" }]
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    fullWorkflow: true,
    proofreadMode: "split",
    subagentEnabled: true,
    subagentCount: 1
  });
  const proofreadState = createProofreadHostState();
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(translationRoot, { recursive: true });
    await writeFile(sourceA, "one\ntwo\n", "utf8");
    await writeFile(sourceB, "three\nfour\n", "utf8");
    await writeFile(translationA, "一\n二\n", "utf8");
    await writeFile(translationB, "三\n四\n", "utf8");
    const seededA = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourceA],
      translationPath: translationA,
      documentId: "a.txt",
      reportScope,
      kind: "findings_json",
      mode: "split",
      content: JSON.stringify([{
        id: "M1-A-OLD",
        severity: "M1",
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText: "one",
        currentTranslation: "一",
        suggestedFix: "第一",
        rationale: "document A sentinel"
      }])
    });
    const seededB = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourceB],
      translationPath: translationB,
      documentId: "b.txt",
      reportScope,
      kind: "findings_json",
      mode: "split",
      content: JSON.stringify([{
        id: "M1-B-OLD",
        severity: "M1",
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText: "three",
        currentTranslation: "三",
        suggestedFix: "第三",
        rationale: "document B sentinel"
      }])
    });
    assert.equal(seededA.ok, true, seededA.error);
    assert.equal(seededB.ok, true, seededB.error);
    const reportBefore = await readFile(seededA.path, "utf8");

    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath: sourceRoot,
        sourceSelection: { kind: "folder", path: sourceRoot },
        folderTranslationOrder: '{\n"a.txt"\n"b.txt"\n}',
        sessionId: "pi_folder_proofread_start_transaction",
        prompt: "Workflow: yn-proofread-v1.",
        workflowIntent: "proofread",
        providerId: "test",
        modelId: "test",
        languagePair: "en->zh-CN",
        proofreadMode: "split",
        proofreadSplitSize: 2,
        subagentEnabled: true,
        subagentCount: 1
      },
      publishCustomMessage: async () => {},
      subagents,
      domainRun,
      proofreadState
    });
    const tool = (name) => {
      const value = tools.find((entry) => entry.name === name);
      assert.ok(value, `missing tool ${name}`);
      return value;
    };
    await execute(tool("inspectTranslationContext"), {});
    const run = await execute(tool("runProofreadSubagents"), { workerCount: 1 });
    assert.ok(started);
    assert.equal(
      await readFile(seededA.path, "utf8"),
      reportBefore,
      "starting a split batch must not delete the selected document before a valid child write"
    );
    assert.equal(proofreadDocumentHostState(proofreadState, "a.txt").reportInitialized, false);

    await started.onSettled({
      batch: { id: run.details.batchId, status: "failed", subagents: [] },
      results: [],
      error: new Error("worker failed before its first valid findings write")
    });
    assert.equal(await readFile(seededA.path, "utf8"), reportBefore);
    const report = JSON.parse(reportBefore);
    assert.deepEqual(report.findings.map((finding) => finding.id).sort(), ["M1-A-OLD", "M1-B-OLD"]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder split proofreading prescans and queues every retained document with file-bound candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-proofread-complete-queue-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const sourceA = path.join(sourceRoot, "a.txt");
  const sourceB = path.join(sourceRoot, "b.txt");
  const translationA = path.join(translationRoot, "a_translated.txt");
  const translationB = path.join(translationRoot, "b_translated.txt");
  let started;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(options) {
      started = options;
      return {
        id: options.batchId,
        status: "running",
        subagents: [{ id: "folder-proofread-worker", status: "running" }]
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    folderSource: true,
    fullWorkflow: true,
    proofreadMode: "split",
    subagentEnabled: true,
    subagentCount: 2
  });
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(translationRoot, { recursive: true });
    await writeFile(sourceA, "one\ntwo\n", "utf8");
    await writeFile(sourceB, "three\n", "utf8");
    await writeFile(translationA, "一\n二\n", "utf8");
    await writeFile(translationB, "三\n", "utf8");

    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath: sourceRoot,
        sourceSelection: { kind: "folder", path: sourceRoot },
        translationPath: outputDir,
        folderTranslationOrder: '"a.txt"\n"b.txt"',
        sessionId: "pi_folder_proofread_complete_queue",
        prompt: "Workflow: yn-proofread-v1.",
        workflowIntent: "proofread",
        providerId: "test",
        modelId: "test",
        languagePair: "en->zh-CN",
        proofreadMode: "split",
        proofreadSplitSize: 2,
        subagentEnabled: true,
        subagentCount: 2
      },
      publishCustomMessage: async () => {},
      subagents,
      domainRun,
      proofreadState: createProofreadHostState()
    });
    const tool = (name) => {
      const value = tools.find((entry) => entry.name === name);
      assert.ok(value, `missing tool ${name}`);
      return value;
    };

    const inspected = await execute(tool("inspectTranslationContext"));
    assert.equal(inspected.details.proofreadPrescan.documentCount, 2);
    assert.equal(inspected.details.proofreadPrescan.totalLines, 3);
    assert.ok(domainRun.snapshot().documents.every((document) => document.proofreadPrescanCompleted));

    const run = await execute(tool("runProofreadSubagents"), { workerCount: 2 });
    assert.equal(run.details.assignmentCount, 2);
    assert.equal(run.details.documentCount, 2);
    assert.ok(started, "the complete folder queue was not started");
    assert.deepEqual(started.tasks.map((task) => task.documentId), ["a.txt", "b.txt"]);
    assert.deepEqual(started.tasks.map((task) => started.taskStage(task)), [0, 1]);

    const requestA = started.requestForTask(started.tasks[0]);
    const requestB = started.requestForTask(started.tasks[1]);
    assert.equal(path.resolve(requestA.sourcePath), path.resolve(sourceA));
    assert.equal(path.resolve(requestB.sourcePath), path.resolve(sourceB));
    assert.equal(path.resolve(requestA.translationPath), path.resolve(translationA));
    assert.equal(path.resolve(requestB.translationPath), path.resolve(translationB));

    for (const [task, bound] of [[started.tasks[0], requestA], [started.tasks[1], requestB]]) {
      const written = await writeProofreadFindings({
        outputDir,
        sourcePaths: [bound.sourcePath],
        translationPath: bound.translationPath,
        documentId: task.documentId,
        reportScope: { kind: "folder", sourcePath: sourceRoot },
        kind: "findings_json",
        mode: "split",
        content: "[]",
        replaceRange: { fromLine: task.fromLine, toLine: task.toLine }
      });
      assert.equal(written.ok, true, written.error);
      await started.onArtifactMutation(task.documentId);
    }

    await started.onSettled({
      batch: { id: run.details.batchId, status: "completed", subagents: [] },
      results: started.tasks.map((task, index) => ({
        subagentId: `child-${index + 1}`,
        label: task.label,
        documentId: task.documentId,
        fromLine: task.fromLine,
        toLine: task.toLine,
        providerId: "test",
        modelId: "test",
        modelName: "test",
        resultSummary: "done",
        findingsWritten: 0,
        glossaryCandidates: []
      })),
      failures: []
    });
    assert.ok(domainRun.snapshot().documents.every((document) => (
      document.completedSubagentBatch?.id === run.details.batchId
    )));
    const finalized = await execute(tool("finalizeProofreadReport"), {});
    assert.equal(finalized.details.documentCount, 2);
    assert.equal(finalized.details.path, path.join(outputDir, "report", "folder.proofread.json"));
    await assert.rejects(
      readFile(path.join(outputDir, "report", "report", "folder.proofread.json"), "utf8"),
      { code: "ENOENT" }
    );
    await assert.rejects(
      readFile(path.join(outputDir, "report", "folder_proofread_summary.md"), "utf8"),
      { code: "ENOENT" }
    );
    assert.ok(domainRun.snapshot().documents.every((document) => document.proofreadReportFinalized));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("fixed system prompt drives semantic intent and mandatory artifact validation without legacy states", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.\nTranslate the bound source.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 5,
      translationSplitSize: 1000
    }
  });
  try {
    const prompt = buildYnSystemPrompt(fx.request);
    for (const required of [
      "Understand the user's intent",
      "instruction to investigate and act",
      "smallest validated correction",
      "Host-provided typed operation scope is authoritative",
      "fetchWebReference",
      "untrusted reference data",
      "inspectTranslationContext",
      "exists/available fields are authoritative",
      "Call runTranslationSubagents only for the complete Host-owned translation queue",
      "Host queue owns assignment, validation, review, retry, and settlement",
      "writeTranslationChunk",
      "validateTranslationArtifact",
      "Before writing the character bible",
      "searchProjectText",
      "Stop searching that character once the evidence establishes the fact",
      "- Gender/pronouns: <gender; pronouns> (confidence: confirmed|inferred|unknown)",
      "- Terms of address:",
      "Children inherit the parent model",
      "Child batches run in the background",
      "Do not poll"
    ]) assert.ok(prompt.includes(required), `missing ${required}`);
    assert.ok(prompt.length < 6_000, `full workflow system prompt is still bloated (${prompt.length} chars)`);
    assert.doesNotMatch(prompt, /mechanically scans every row|deterministic clean-row sample|same paused translation worker/i);
    for (const forbidden of [
      "waitForHuman",
      "requestHumanApproval",
      "completeTask",
      "resumeJob",
      "runProofreadSubagents",
      "writeProofreadFindings",
      "finalizeProofreadReport",
      "five child runtimes",
      "at most five child"
    ]) {
      assert.equal(prompt.includes(forbidden), false);
    }
  } finally {
    await fx.close();
  }
});

await test("proofread system prompt orders Host prescan before semantic child review", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.\nProofread the bound translation.",
      workflowIntent: "proofread",
      subagentEnabled: true,
      subagentCount: 5,
      proofreadMode: "split",
      proofreadSplitSize: 500
    }
  });
  try {
    const prompt = buildYnSystemPrompt(fx.request);
    assert.match(prompt, /inspectTranslationContext before any semantic child delegation/i);
    assert.match(prompt, /exists\/available fields.*authoritative/i);
    assert.match(prompt, /proofreadPrescan\.completed is true/i);
    assert.match(prompt, /useful worker count up to 5/i);
    assert.match(prompt, /Host owns sampling or split assignments, coverage, and replacement batches/i);
    assert.match(prompt, /Children review only/i);
    assert.match(prompt, /writeProofreadFindings.*finalizeProofreadReport/i);
    assert.match(prompt, /inspector and finalizer typed results are authoritative/i);
    assert.match(prompt, /do not reread the Host-owned report JSON, glossary, or candidate files/i);
    assert.doesNotMatch(prompt, /full deterministic H3\/H4\/H7\/H8\/H9|assignments of at most proofreadSplitSize/i);
  } finally {
    await fx.close();
  }
});

await test("a full workflow exact child count stays on specialized Host pools instead of generic delegation", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.\nUse exactly 3 subagents to finish the bound translation.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 3
    }
  });
  try {
    const prompt = buildYnSystemPrompt(fx.request);
    assert.match(prompt, /TRANSLATION WORKFLOW:/);
    assert.match(prompt, /specialized Host-planned|runTranslationSubagents/i);
    assert.doesNotMatch(prompt, /call runSubagents with exactly 3/i);
  } finally {
    await fx.close();
  }
});

await test("a suspended full workflow blocks only full continuation while independent bounded repairs remain available", async () => {
  const startedBatches = [];
  const subagents = {
    hasRunning: () => false,
    startGeneralBatch(args) {
      startedBatches.push(args);
      return {
        id: args.batchId,
        status: "running",
        subagents: args.tasks.map((task, index) => ({ id: `local-${startedBatches.length}-${index + 1}`, label: task.label }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  domainRun.suspend();
  let hostSuspended = true;
  const fx = await fixture({
    subagents,
    domainRun,
    isWorkflowSuspended: () => hostSuspended,
    async resumeWorkflow() {
      domainRun.resume();
      hostSuspended = false;
    },
    requestPatch: {
      prompt: "继续完成剩余翻译任务。",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 2
    }
  }, "原文一\n原文二\n原文三\n");
  try {
    const inspection = await execute(fx.tool("inspectTranslationContext"), {});
    assert.equal(inspection.details.sourceLineCount, 3);
    assert.equal(domainRun.snapshot().inspected, false, "read-only inspection must not mutate a parked Host workflow");
    const suspendedSnapshot = domainRun.snapshot();
    assert.deepEqual(
      domainRun.snapshot(),
      suspendedSnapshot,
      "rejecting full continuation must not mutate Host state"
    );

    const investigation = await execute(fx.tool("runSubagents"), { tasks: [
      { label: "定位一", prompt: "只读定位第 1 行问题。", mode: "investigate", fromLine: 1, toLine: 1 },
      { label: "定位二", prompt: "只读定位第 3 行问题。", mode: "investigate", fromLine: 3, toLine: 3 }
    ] });
    assert.equal(investigation.details.status, "running", "read-only investigation must remain available while suspended");
    assert.equal(startedBatches.length, 1);
    await startedBatches[0].onSettled({
      batch: { id: investigation.details.batchId, status: "completed", subagents: [] },
      results: [{}, {}]
    });

    const repairTasks = [
      { label: "修复一", prompt: "只修复第 1 行。", mode: "translation_repair", fromLine: 1, toLine: 1 },
      { label: "修复二", prompt: "只修复第 3 行。", mode: "translation_repair", fromLine: 3, toLine: 3 }
    ];
    const repair = await execute(fx.tool("runSubagents"), { tasks: repairTasks });
    assert.equal(repair.details.status, "running");
    assert.equal(startedBatches.length, 2, "bounded repair children must not be occupied by the suspended full workflow");
    assert.equal(domainRun.suspended, true, "a separate bounded repair must not silently resume the complete workflow");
    await startedBatches[1].onSettled({
      batch: { id: repair.details.batchId, status: "completed", subagents: [] },
      results: [{}, {}]
    });

    await assert.rejects(
      execute(fx.tool("runTranslationSubagents")),
      /suspended.*resumeYnWorkflow/i,
      "the complete Host queue still requires an explicit resume"
    );

    await execute(fx.tool("resumeYnWorkflow"));
    assert.equal(hostSuspended, false);
    assert.equal(startedBatches.length, 2);
    assert.doesNotMatch(domainRun.incompleteReasons().join("\n"), /prompt-defined|explicitly requested native Pi/i);
    await execute(fx.tool("inspectTranslationContext"), {});
    assert.equal(domainRun.snapshot().inspected, true);
  } finally {
    await fx.close();
  }
});

await test("resumeYnWorkflow is idempotent when the workflow is already active", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 3
  });
  let resumeCalls = 0;
  const fx = await fixture({
    domainRun,
    isWorkflowSuspended: () => false,
    async resumeWorkflow() {
      resumeCalls += 1;
    },
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.\n继续完成翻译。",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 3
    }
  });
  try {
    const tool = fx.tool("resumeYnWorkflow");
    assert.ok(!tool.parameters.required?.includes("reason"), "resume must not require a model-authored justification");
    const result = await execute(tool);
    assert.equal(result.details.resumed, false);
    assert.equal(result.details.status, "already_active");
    assert.equal(resumeCalls, 0, "an idempotent active-workflow resume must not reset Host state");
  } finally {
    await fx.close();
  }
});

await test("an exhausted assignment cannot auto-resume through stale tools but a fresh user turn can resume it", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  }, "原文一\n原文二\n");
  try {
    await execute(fx.tool("inspectTranslationContext"));
    domainRun.recordSubagentBatchStarted("translation", "failed-batch", {
      taskCount: 1,
      workerCount: 1,
      documentIds: ["source.txt"],
      assignmentCounts: { "source.txt": 1 }
    });
    domainRun.recordSubagentBatchFailure("translation", "failed-batch", ["source.txt"]);

    await assert.rejects(
      execute(fx.tool("resumeYnWorkflow")),
      /fresh explicit user prompt|Hidden completion follow-ups/i
    );
    const pauseId = domainRun.recoveryPauseId;
    assert.ok(pauseId);

    const freshTools = createYnDomainTools({
      request: { ...fx.request, prompt: "继续失败后保留的任务。" },
      publishCustomMessage: async () => {},
      subagents: fx.subagents,
      domainRun
    });
    const freshResume = freshTools.find((tool) => tool.name === "resumeYnWorkflow");
    assert.ok(freshResume);
    const result = await execute(freshResume);
    assert.equal(result.details.status, "recovery_resumed");
    assert.equal(result.details.pauseId, pauseId);
    assert.equal(domainRun.recoveryPauseId, undefined);
  } finally {
    await fx.close();
  }
});

await test("resumeYnWorkflow is a harmless no-op when this Pi session has no suspended workflow", async () => {
  let resumeCalls = 0;
  const fx = await fixture({
    isWorkflowSuspended: () => false,
    async resumeWorkflow() {
      resumeCalls += 1;
    },
    requestPatch: {
      prompt: "继续处理当前任务。"
    }
  });
  try {
    const result = await execute(fx.tool("resumeYnWorkflow"));
    assert.equal(result.details.resumed, false);
    assert.equal(result.details.status, "not_suspended");
    assert.equal(resumeCalls, 0, "a no-op resume must not invent a Host workflow");
  } finally {
    await fx.close();
  }
});

await test("resumeYnWorkflow resumes an incomplete bounded Host contract without upgrading it to a full workflow", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 2
  });
  domainRun.suspend();
  let hostSuspended = true;
  const fx = await fixture({
    domainRun,
    isWorkflowSuspended: () => hostSuspended,
    async resumeWorkflow() {
      domainRun.resume();
      hostSuspended = false;
    },
    requestPatch: {
      prompt: "继续完成刚才的定点修复。",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 2
    }
  });
  try {
    const result = await execute(fx.tool("resumeYnWorkflow"));
    assert.equal(result.details.resumed, true);
    assert.equal(result.details.status, "resumed");
    assert.equal(domainRun.fullWorkflow, false);
    assert.equal(domainRun.suspended, false);
    assert.equal(hostSuspended, false);
  } finally {
    await fx.close();
  }
});

await test("the product prompt keeps stopped workflow debt inert until the current user resumes it", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "你好。",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 3
    }
  });
  try {
    const prompt = buildYnSystemPrompt(fx.request, { fullWorkflow: true, workflowSuspended: true });
    assert.match(prompt, /SUSPENDED WORKFLOW/);
    assert.match(prompt, /Call resumeYnWorkflow before using that complete workflow again/i);
    assert.match(prompt, /Greetings.*leave it suspended/i);
  } finally {
    await fx.close();
  }
});

await test("ordinary local repair receives a bounded repair contract instead of both complete workflows", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "只修正 source.txt 第 2 行的称呼。",
      subagentEnabled: true,
      subagentCount: 2
    }
  });
  try {
    const prompt = buildYnSystemPrompt(fx.request);
    assert.match(prompt, /concrete project problem.*instruction to investigate and act/i);
    assert.match(prompt, /smallest validated correction/i);
    assert.doesNotMatch(prompt, /TRANSLATION WORKFLOW \(mandatory when translating\)/);
    assert.doesNotMatch(prompt, /PROOFREAD WORKFLOW \(mandatory when proofreading\)/);
    assert.doesNotMatch(prompt, /Generate AI_translation\/_workspace\/character_bible\.md/);
    assert.ok(prompt.length < 8_000, `local repair system prompt must stay bounded, received ${prompt.length} chars`);
  } finally {
    await fx.close();
  }
});

await test("bounded repair cannot enter the complete translation queue", async () => {
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 3
  });
  const fx = await fixture({
    domainRun,
    requestPatch: {
      prompt: "只修正 source.txt 第 2 行的称呼。",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 3
    }
  });
  try {
    await assert.rejects(
      () => execute(fx.tool("runTranslationSubagents"), {
        tasks: [{ documentId: "source.txt", fromLine: 2, toLine: 2 }]
      }),
      /complete Host-owned translation queue.*runSubagents/i
    );
  } finally {
    await fx.close();
  }
});

await test("explicit delegation prompt keeps free-form Pi children separate from the full translation queue", async () => {
  const fx = await fixture({
    requestPatch: {
      prompt: "先定位坏行，再叫五个 subagents 并行修复。",
      subagentEnabled: true,
      subagentCount: 2
    }
  });
  try {
    const prompt = buildYnSystemPrompt(fx.request);
    assert.match(prompt, /call runSubagents with only the independently useful number of up to 2 concurrent tasks/i);
    assert.match(prompt, /mode=translation_repair.*documentId.*fromLine.*toLine/i);
    assert.match(prompt, /Never use runTranslationSubagents for a bounded repair/i);
    assert.match(prompt, /same child.*exact Host error/i);
    assert.match(prompt, /do not restart a complete workflow/i);
    assert.doesNotMatch(prompt, /authorized|authorization gate|current-user wording|unavailable unless/i);
  } finally {
    await fx.close();
  }
});

await test("proofreading never creates idle workers beyond indivisible assignments", async () => {
  let started;
  const subagents = {
    hasRunning: () => false,
    startProofreadBatch(args) {
      started = args;
      return {
        id: "batch_exact_small_proofread",
        status: "running",
        subagents: Array.from({ length: args.maxWorkers }, (_, index) => ({
          id: `proofread-worker-${index + 1}`,
          label: `review-${index + 1}`,
          status: "running"
        }))
      };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 5
  });
  const fx = await fixture({
    subagents,
    domainRun,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1. Use 5 subagents.",
      proofreadMode: "split",
      proofreadSplitSize: 1_000,
      subagentEnabled: true,
      subagentCount: 5
    }
  }, "hello\ngoodbye");
  try {
    const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "你好\n再见", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    const result = await execute(fx.tool("runProofreadSubagents"));
    assert.equal(started.maxWorkers, 1);
    assert.equal(started.tasks.length, 1, "the two-line file is one indivisible split assignment");
    assert.equal(result.details.workerCount, 1);
    assert.equal(result.details.assignmentCount, 1);
  } finally {
    await fx.close();
  }
});

await test("background child guidance yields the parent turn instead of inducing a polling loop", async () => {
  const fx = await fixture();
  try {
    const description = fx.tool("inspectSubagents").description;
    assert.match(description, /user asks|appears stalled/i);
    assert.doesNotMatch(description, /use this while children run/i);
  } finally {
    await fx.close();
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
