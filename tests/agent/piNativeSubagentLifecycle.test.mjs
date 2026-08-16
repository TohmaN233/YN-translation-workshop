import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  validateToolCall
} from "@earendil-works/pi-ai";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import * as subagentRunner from "../../src/main/agent/piNative/subagentRunner.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function translationEntries(lines, fromLine = 1) {
  return {
    entries: lines.map((translation, index) => ({
      line: fromLine + index,
      translation
    }))
  };
}

function registerAlwaysAcceptingReviewer(models, providerId = `translation-review-${Math.random().toString(36).slice(2)}`) {
  const reviewer = fauxProvider({ provider: providerId, tokensPerSecond: 10_000 });
  models.setProvider(reviewer.provider);
  reviewer.setResponses(Array.from({ length: 128 }, (_, index) => [
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, {
      id: `review-${index + 1}-read`
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, {
      id: `review-${index + 1}-submit`
    }), { stopReason: "toolUse" })
  ]).flat());
  return reviewer;
}

async function fixture(createSubagentModelSelection, publishCustomMessage = async () => {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-lifecycle-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo\n", "utf8");
  const reviewModels = createModels();
  const reviewer = registerAlwaysAcceptingReviewer(reviewModels);
  const request = {
    outputDir,
    sourcePath,
    sessionId: "pi_lifecycle",
    prompt: "translate with two subagents",
    providerId: "parent",
    modelId: "parent",
    languagePair: "en->zh-CN",
    subagentEnabled: true,
    subagentCount: 2,
    subagentProviderId: reviewer.provider.id,
    subagentModelId: reviewer.getModel().id,
    reviewSubagentCount: 2
  };
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage,
    createModelSelection: async (selection) => selection.providerId === reviewer.provider.id
      ? {
          models: reviewModels,
          model: reviewer.getModel(),
          providerId: reviewer.provider.id,
          modelId: reviewer.getModel().id
        }
      : createSubagentModelSelection(selection),
    notifyParent: async () => {}
  });
  const tools = createYnDomainTools({
    request,
    publishCustomMessage,
    createSubagentModelSelection,
    subagents
  });
  const tool = tools.find((entry) => entry.name === "runTranslationSubagents");
  assert.ok(tool, "missing runTranslationSubagents tool");
  return {
    outputDir,
    tool,
    subagents,
    async close() {
      await rm(outputDir, { recursive: true, force: true });
    }
  };
}

await test("general Pi children receive the current approved project style guide", async () => {
  const provider = fauxProvider({ provider: "general-child-style", tokensPerSecond: 10_000 });
  let modelContext;
  provider.setResponses([
    async (context) => {
      modelContext = context;
      return fauxAssistantMessage(fauxText("The project style guide is available."));
    }
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-general-style-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "style_guide.md"),
      "# Style Guide\nPreserve restrained narration and precise technical terminology.\n",
      "utf8"
    );
    await subagentRunner.runPiGeneralSubagent({
      request: {
        outputDir,
        sessionId: "pi_general_style",
        prompt: "Inspect the current project style.",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "Eng->zh-CN"
      },
      task: {
        mode: "investigate",
        prompt: "Report the approved project style guide.",
        label: "Style guide inspection"
      },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.ok(modelContext, "the general child provider did not receive a model context");
    assert.match(modelContext.systemPrompt, /Approved style guide/);
    assert.match(modelContext.systemPrompt, /Preserve restrained narration and precise technical terminology/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("parent AbortSignal cancels every concurrently running background child runtime", async () => {
  const models = createModels();
  const providers = new Map();
  const started = new Set();
  const observedSignals = new Map();
  const releases = new Map();
  const allStarted = deferred();

  for (const providerId of ["child-a", "child-b"]) {
    const faux = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
    models.setProvider(faux.provider);
    providers.set(providerId, faux);
    faux.setResponses([
      async (_context, options) => {
        observedSignals.set(providerId, options?.signal);
        started.add(providerId);
        if (started.size === 2) allStarted.resolve();
        await new Promise((resolve) => {
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            resolve();
          };
          releases.set(providerId, release);
          options?.signal?.addEventListener("abort", release, { once: true });
          if (options?.signal?.aborted) release();
        });
        return fauxAssistantMessage(fauxText(`${providerId} stopped`));
      }
    ]);
  }

  const fx = await fixture(async ({ providerId }) => {
    const faux = providers.get(providerId);
    assert.ok(faux, `unexpected provider ${providerId}`);
    return {
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    };
  });
  const controller = new AbortController();
  try {
    const spawnResult = await fx.tool.execute("call_abort_all", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: "child-a" },
        { fromLine: 2, toLine: 2, providerId: "child-b" }
      ]
    }, controller.signal);
    assert.equal(spawnResult.details.status, "running");
    await Promise.race([
      allStarted.promise,
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error(`Both child providers did not start: ${JSON.stringify(fx.subagents.list())}`));
      }, 1_000))
    ]);
    controller.abort(new Error("parent stopped"));
    await fx.subagents.waitForAll();
    assert.equal(observedSignals.size, 2);
    for (const signal of observedSignals.values()) assert.equal(signal?.aborted, true);
    const batch = fx.subagents.list().find((entry) => entry.kind === "translation");
    assert.ok(batch);
    assert.ok(batch.subagents.every((child) => child.status === "stopped" || child.status === "failed"));
  } finally {
    for (const release of releases.values()) release();
    await fx.subagents.waitForAll();
    await fx.close();
  }
});

await test("one background child failure does not abort an independent healthy sibling", async () => {
  const models = createModels();
  const failing = fauxProvider({ provider: "child-fails", tokensPerSecond: 1000 });
  const sibling = fauxProvider({ provider: "child-sibling", tokensPerSecond: 1000 });
  models.setProvider(failing.provider);
  models.setProvider(sibling.provider);

  const siblingStarted = deferred();
  let siblingSignal;
  sibling.setResponses([
    async (_context, options) => {
      siblingSignal = options?.signal;
      siblingStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "sibling-read" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["二"], 2), { id: "sibling-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "sibling-validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Healthy sibling completed."))
  ]);
  failing.setResponses([
    async () => {
      await siblingStarted.promise;
      throw new Error("forced child failure");
    }
  ]);

  const providers = new Map([
    [failing.provider.id, failing],
    [sibling.provider.id, sibling]
  ]);
  const terminalCards = [];
  const fx = await fixture(async ({ providerId }) => {
    const faux = providers.get(providerId);
    assert.ok(faux, `unexpected provider ${providerId}`);
    return {
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    };
  }, async (message) => {
    if (message.details?.closed) terminalCards.push(message);
  });

  try {
    const started = await fx.tool.execute("call_sibling_failure", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: failing.provider.id, label: "Failure" },
        { fromLine: 2, toLine: 2, providerId: sibling.provider.id, label: "Sibling" }
      ]
    });
    assert.equal(started.details.status, "running");
    await fx.subagents.waitForAll();
    assert.equal(siblingSignal?.aborted, false, "an unrelated child failure aborted the healthy sibling harness");
    const batch = fx.subagents.list().find((entry) => entry.kind === "translation");
    assert.ok(batch);
    assert.equal(batch.status, "failed");
    assert.deepEqual(
      batch.subagents.map((child) => child.status).sort(),
      ["completed", "failed"],
      "the failed batch did not preserve the healthy sibling's completed work"
    );
    assert.ok(terminalCards.some((message) => message.details?.label === "Sibling" && message.details?.status === "completed"));
    const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    assert.equal(await readFile(candidatePath, "utf8"), "\n二\n");
  } finally {
    await fx.close();
  }
});

await test("Stop after child settlement cancels the pending parent completion notification", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-terminal-stop-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo", "utf8");
  const models = createModels();
  const providers = new Map();
  const onSettledEntered = deferred();
  const releaseOnSettled = deferred();
  const parentNotifications = [];

  for (const [index, providerId] of ["terminal-a", "terminal-b"].entries()) {
    const provider = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
    models.setProvider(provider.provider);
    providers.set(providerId, provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `${providerId}-read` }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: index + 1, translation: index === 0 ? "一" : "二" }]
      }, { id: `${providerId}-write` }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: `${providerId}-validate` }), { stopReason: "toolUse" })
    ]);
  }

  const supervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    notifyParent: async (message) => { parentNotifications.push(message); },
    createModelSelection: async ({ providerId }) => {
      const provider = providers.get(providerId);
      assert.ok(provider, `unexpected provider ${providerId}`);
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    }
  });

  try {
    supervisor.startTranslationBatch({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_terminal_stop",
        prompt: "translate two lines",
        providerId: "terminal-a",
        modelId: providers.get("terminal-a").getModel().id,
        languagePair: "en->zh-CN"
      },
      tasks: [
        { fromLine: 1, toLine: 1, providerId: "terminal-a" },
        { fromLine: 2, toLine: 2, providerId: "terminal-b" }
      ],
      onChunkReadyForReview: async () => ({ accepted: true }),
      onSettled: async () => {
        onSettledEntered.resolve();
        await releaseOnSettled.promise;
      }
    });

    await onSettledEntered.promise;
    assert.equal(supervisor.abortAll(), 0, "terminal children were incorrectly counted as running");
    releaseOnSettled.resolve();
    await supervisor.waitForAll();
    assert.equal(parentNotifications.length, 0, "Stop allowed a settled child batch to wake the parent");
  } finally {
    releaseOnSettled.resolve();
    supervisor.abortAll();
    await supervisor.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("overlapping child write scopes cannot start before the current scopes settle", async () => {
  const models = createModels();
  const provider = fauxProvider({ provider: "single-active-batch", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  const response = async (_context, options) => {
    await new Promise((resolve) => {
      options?.signal?.addEventListener("abort", resolve, { once: true });
      if (options?.signal?.aborted) resolve();
    });
    return fauxAssistantMessage(fauxText("stopped"));
  };
  provider.setResponses(Array.from({ length: 4 }, () => response));
  const fx = await fixture(async () => ({
    models,
    model: provider.getModel(),
    providerId: provider.provider.id,
    modelId: provider.getModel().id
  }));
  try {
    await fx.tool.execute("call_first_batch", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: provider.provider.id, modelId: provider.getModel().id },
        { fromLine: 2, toLine: 2, providerId: provider.provider.id, modelId: provider.getModel().id }
      ]
    });
    await assert.rejects(() => fx.tool.execute("call_overlapping_batch", {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: provider.provider.id, modelId: provider.getModel().id },
        { fromLine: 2, toLine: 2, providerId: provider.provider.id, modelId: provider.getModel().id }
      ]
    }), /write scope.*overlaps active batch/i);
  } finally {
    fx.subagents.abortAll();
    await fx.subagents.waitForAll();
    await fx.close();
  }
});

await test("translation child cannot complete by omitting a nonempty assigned source line", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-omission-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: "child-omission", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "omission-read-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["二"], 2), { id: "omission-write-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "omission-validate-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("The empty line is complete.")),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["二"], 2), { id: "omission-write-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "omission-validate-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("The omitted line is still complete.")),
    fauxAssistantMessage(fauxText("No correction is needed.")),
    fauxAssistantMessage(fauxText("I will not change the omitted line.")),
    fauxAssistantMessage(fauxText("The assignment remains complete."))
  ]);

  try {
    await assert.rejects(() => subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_child_omission",
        prompt: "translate the assigned line",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 1, toLine: 2 },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    }), /host-validation progress|host-contract progress/i);
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "\n二\n",
      "an omitted keyed line may remain explicitly empty but must never be filled with copied source text"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation child preserves project-rule warnings for the read-only semantic review stage", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-project-rules-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const workspace = path.join(outputDir, ".translation-workshop");
  await writeFile(sourcePath, "勇者\n", "utf8");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "glossary.json"), JSON.stringify({
    entries: [{ source: "勇者", target: "勇者大人" }]
  }), "utf8");
  await writeFile(path.join(workspace, "character_bible.json"), JSON.stringify({
    characters: [{
      name: "勇者",
      target: "勇者大人",
      requiredTerms: ["吾"],
      forbiddenTerms: ["机器翻译腔"]
    }]
  }), "utf8");
  await writeFile(path.join(workspace, "style_guide.md"), "forbidden: 硬直译\n", "utf8");
  const invalidLines = ["勇士机器翻译腔硬直译"];
  const models = createModels();
  const provider = fauxProvider({ provider: "child-project-rules", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "project-read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(invalidLines), { id: "project-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "project-validate" }), { stopReason: "toolUse" })
  ]);

  try {
    const result = await subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_child_project_rules",
        prompt: "translate the assigned line",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "ja->zh-CN"
      },
      task: { fromLine: 1, toLine: 1 },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.equal(result.validation.ok, true, "project-rule warnings must not fail structural artifact validation");
    const warningCodes = new Set(result.validation.warnings.map((finding) => finding.code));
    for (const code of [
      "glossary_missing",
      "character_name_missing",
      "character_voice_required_missing",
      "character_voice_forbidden_term",
      "style_forbidden_term"
    ]) {
      assert.equal(warningCodes.has(code), true, `${code} must remain observable for semantic review`);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("quality warnings retain the translated candidate without entering the mandatory repair loop", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-quality-retention-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const workspace = path.join(outputDir, ".translation-workshop");
  await writeFile(sourcePath, "勇者\n", "utf8");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "glossary.json"), JSON.stringify({
    entries: [{ source: "勇者", target: "勇者大人" }]
  }), "utf8");
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = subagentRunner.createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_quality_retention",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "ja->zh-CN"
    },
    task: { fromLine: 1, toLine: 1 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "repairAssignedTranslation");
  assert.ok(read);
  assert.ok(write);

  try {
    await read.execute("quality-retention-read", {});
    const result = await write.execute(
      "quality-retention-write",
      translationEntries(["英雄"])
    );

    assert.equal(result.details.accepted, true);
    assert.deepEqual(result.details.requiredBatchLines, []);
    assert.equal(Object.hasOwn(result.details, "requiredLineContext"), false);
    assert.deepEqual(result.details.repairIssues, []);
    assert.equal(result.details.validation.warningCount, 1);
    assert.equal(progress.translationWritten, true);
    assert.equal(progress.requiredBatchLines, undefined);
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "英雄\n",
      "a structurally valid translated line must not roll back to the Japanese source because of a quality warning"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("bounded local repair reads source on demand without injecting the full workflow or unrelated quality debt", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-bounded-repair-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const workspace = path.join(outputDir, ".translation-workshop");
  await writeFile(sourcePath, "Naomi entered.\n", "utf8");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "glossary.json"), JSON.stringify({
    entries: [{ source: "Naomi", target: "直美" }]
  }), "utf8");
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const context = {
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_bounded_repair",
      prompt: "只修正这一行的语气，不处理术语表。",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1, instruction: "只修正这一行的语气。" },
    executionMode: "bounded_repair",
    publishCustomMessage: async () => {}
  };
  const runtimeSpec = subagentRunner.createPiTranslationRuntimeSpec(context, progress);
  const tools = runtimeSpec.tools("bounded-repair-test");
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "repairAssignedTranslation");
  const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
  assert.ok(read);
  assert.ok(write);
  assert.ok(validate);

  try {
    const readResult = await read.execute("bounded-read", {});
    assert.equal(Object.hasOwn(readResult.details, "translationReference"), false,
      "local repair should use on-demand project reads instead of receiving the complete child workflow and every project asset");
    const result = await write.execute("bounded-write", translationEntries(["她走进来了。"]));
    assert.equal(result.details.accepted, true);
    assert.deepEqual(result.details.requiredBatchLines, []);
    assert.deepEqual(result.details.repairIssues, []);
    assert.equal(result.details.validation.warningCount, 1,
      "non-blocking warnings may remain observable as a count without becoming repair prompt content");
    assert.ok(JSON.stringify(result).length < 4_000,
      `bounded repair tool results must stay compact, received ${JSON.stringify(result).length} chars`);
    assert.equal(Object.hasOwn(validate.parameters.properties, "alignmentChecks"), false,
      "bounded repair must not require one prose alignment verdict per line");
    assert.ok(Object.hasOwn(validate.parameters.properties, "misalignedLines"),
      "bounded repair must report only remaining bad line numbers");
    assert.match(runtimeSpec.taskPrompt, /misalignedLines containing only absolute lines that still fail/i);
    assert.match(runtimeSpec.taskPrompt, /do not emit pass reasons/i);
    assert.doesNotMatch(runtimeSpec.taskPrompt, /one semantic alignment check per assigned line/i);
    const validation = await validate.execute("bounded-validate", {
      misalignedLines: []
    });
    assert.equal(validation.details.validation.accepted, true);
    assert.equal(validation.details.validation.qualityWarningCount, 1);
    assert.equal(validation.details.validation.qualityDebtCount, 0);
    assert.deepEqual(validation.details.validation.qualityDebtLineRanges, []);
    assert.deepEqual(validation.details.validation.findingSamples, []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("full translation children receive the built-in contract once and read project assets on demand", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-compact-reference-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const workspace = path.join(outputDir, ".translation-workshop");
  const generatedWorkspace = path.join(outputDir, "AI_translation", "_workspace");
  const reuseBackups = path.join(workspace, "translation-reuse-backups");
  await writeFile(sourcePath, "Alice, a traveler, met 虹宮 and arrived.\n", "utf8");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "glossary.json"), JSON.stringify({
    entries: [
      { source: "traveler", target: "旅人" },
      { source: "虹宮トーヤ", target: "虹宫斗也" },
      { source: "UNRELATED_TERM", target: "REFERENCE_SENTINEL" }
    ]
  }), "utf8");
  await mkdir(generatedWorkspace, { recursive: true });
  await writeFile(
    path.join(generatedWorkspace, "character_bible.md"),
    "# Character Bible\n\n## Alice / 爱丽丝\n- Gender/pronouns: female; she; confirmed\n- Terms of address: Alice\n- Voice: concise\n",
    "utf8"
  );
  await writeFile(path.join(generatedWorkspace, "glossary_candidates.json"), JSON.stringify({
    entries: [
      { source: "traveler", target: "游客" },
      { source: "arrived", target: "抵达" }
    ]
  }), "utf8");
  await mkdir(reuseBackups, { recursive: true });
  await writeFile(path.join(reuseBackups, "prior.txt"), "Alice previously arrived.\n", "utf8");
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = subagentRunner.createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_compact_reference",
      prompt: "translate the assigned line",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1 },
    executionMode: "full_workflow",
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const readProjectFile = tools.find((tool) => tool.name === "readProjectFile");
  const searchProjectText = tools.find((tool) => tool.name === "searchProjectText");
  const write = tools.find((tool) => tool.name === "writeAssignedTranslation");
  const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
  assert.ok(read);
  assert.ok(readProjectFile);
  assert.ok(searchProjectText);
  assert.ok(write);
  assert.ok(validate);

  try {
    const readResult = await read.execute("compact-reference-read", {});
    assert.match(readResult.details.translationReference, /Built-in translate-text child workflow/);
    assert.doesNotMatch(JSON.stringify(readResult.details), /REFERENCE_SENTINEL/,
      "project asset bodies must not be duplicated into every child assignment result");
    assert.equal(readResult.details.projectReferences.approvedGlossary.available, true);
    assert.deepEqual(readResult.details.projectReferences.directMatches.approvedGlossary, [
      { source: "traveler", target: "旅人" },
      { source: "虹宮トーヤ", target: "虹宫斗也" }
    ]);
    assert.deepEqual(readResult.details.projectReferences.directMatches.glossaryCandidates, [
      { source: "arrived", target: "抵达" }
    ], "a stale candidate with the same source must never compete with the formal glossary");
    assert.equal(readResult.details.projectReferences.directMatches.characterBible[0].name, "Alice / 爱丽丝");
    assert.deepEqual(readResult.details.projectReferences.directMatches.glossaryCandidates, [
      { source: "arrived", target: "抵达" }
    ]);
    await assert.rejects(
      readProjectFile.execute("bulk-glossary-read", {
        path: ".translation-workshop/glossary.json",
        maxChars: 32_000
      }),
      /Whole-file reads are disabled for the indexed approved glossary/i
    );
    const searchedGlossary = await searchProjectText.execute("exact-glossary-search", {
      path: ".translation-workshop/glossary.json",
      query: "虹宮"
    });
    assert.equal(searchedGlossary.details.matches.length, 1);
    assert.match(searchedGlossary.details.matches[0].text, /虹宮トーヤ/);
    assert.match(searchedGlossary.details.matches[0].text, /虹宫斗也/,
      "indexed lookup must return the complete structured entry, not only the matching JSON source line");
    const priorTranslation = await readProjectFile.execute("prior-translation-read", {
      path: ".translation-workshop/translation-reuse-backups/prior.txt"
    });
    assert.match(priorTranslation.details.content, /previously arrived/,
      "prior translations remain readable on demand");
    assert.equal(Object.hasOwn(validate.parameters.properties, "alignmentChecks"), false,
      "full workflow translation leaves semantic alignment to the separate review pool");
    assert.equal(validate.hostControl, "return_after_tool_batch");
    assert.deepEqual(
      validate.parameters.properties.glossaryCandidates.items.properties.category.anyOf.map((entry) => entry.const),
      ["proper_noun", "character", "organization", "place", "title", "setting_term"]
    );
    assert.deepEqual(readResult.details.sourceBlocks[0].absoluteLines, [1],
      "compact block ids must expose their exact absolute discovery-evidence line mapping");

    await write.execute("compact-reference-write", translationEntries(["爱丽丝，一位旅人，抵达了。"]));
    assert.equal(progress.translationValidated, false,
      "a successful write must not impersonate the mandatory discovery/validation submission");
    const invalidOptionalDiscoveryArgs = {
      glossaryCandidates: [{
        source: "Alice",
        target: "爱丽丝",
        category: "character",
        evidenceLine: 1,
        rationale: "the translated evidence line establishes this rendering",
        aliases: ["Alice"]
      }, {
        source: "missing-term",
        target: "无效候选",
        category: "proper_noun",
        evidenceLine: 1,
        rationale: "an optional discovery without source evidence must not reject a valid translation"
      }]
    };
    const schemaValidatedArgs = validateToolCall([validate], {
      id: "compact-reference-validate",
      name: "validateAssignedTranslation",
      arguments: invalidOptionalDiscoveryArgs
    });
    const validation = await validate.execute("compact-reference-validate", schemaValidatedArgs);
    assert.equal(validation.details.validation.accepted, true);
    assert.deepEqual(validation.details.discoveries, { glossaryCandidates: [{
      source: "Alice",
      target: "爱丽丝",
      category: "character",
      evidenceLine: 1,
      rationale: "the translated evidence line establishes this rendering"
    }], characterFacts: [] });
    assert.equal(validation.details.rejectedDiscoveries.length, 2);
    assert.ok(validation.details.rejectedDiscoveries.some((entry) => /aliases without translated-line evidence/i.test(entry.reason)));
    assert.ok(validation.details.rejectedDiscoveries.some((entry) => /not present on evidence line/i.test(entry.reason)));
    assert.equal(validation.terminate, true,
      "successful artifact validation must end the Pi tool turn even when an optional discovery is rejected");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation children use the selected external glossary without bulk-reading it", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-selected-glossary-project-"));
  const referenceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-selected-glossary-reference-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const selectedPath = path.join(referenceDir, "selected-glossary.json");
  try {
    await writeFile(sourcePath, "Alice met 虹宮. TARGET_ALIAS_ONLY appeared.\n", "utf8");
    await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
    await writeFile(path.join(outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
      entries: [{ source: "Alice", target: "错误旧译" }]
    }), "utf8");
    await writeFile(selectedPath, JSON.stringify({ entries: [
      { source: "Alice", target: "爱丽丝", aliases: ["艾丽丝"], status: "confirmed" },
      { source: "虹宮トーヤ", target: "虹宫斗也", aliases: ["虹宮"], status: "confirmed" },
      { source: "NotInSource", target: "规范译名", aliases: ["TARGET_ALIAS_ONLY"], status: "confirmed" }
    ] }), "utf8");
    const progress = {
      sourceRead: false,
      translationWritten: false,
      translationValidated: false
    };
    const tools = subagentRunner.createPiTranslationSubagentTools({
      request: {
        outputDir,
        sourcePath,
        glossaryPath: selectedPath,
        sessionId: "pi_selected_external_glossary",
        prompt: "translate the assigned line",
        providerId: "test",
        modelId: "test",
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 1, toLine: 1 },
      executionMode: "full_workflow",
      publishCustomMessage: async () => {}
    }, progress);
    const read = tools.find((tool) => tool.name === "readAssignedSource");
    const readProjectFile = tools.find((tool) => tool.name === "readProjectFile");
    const searchProjectText = tools.find((tool) => tool.name === "searchProjectText");
    assert.ok(read);
    assert.ok(readProjectFile);
    assert.ok(searchProjectText);

    const readResult = await read.execute("selected-glossary-read", {});
    assert.equal(readResult.details.projectReferences.approvedGlossary.path, selectedPath);
    assert.equal(readResult.details.projectReferences.approvedGlossary.outsideProject, true);
    assert.deepEqual(readResult.details.projectReferences.directMatches.approvedGlossary, [
      { source: "Alice", target: "爱丽丝", aliases: ["艾丽丝"], status: "confirmed" },
      { source: "虹宮トーヤ", target: "虹宫斗也", aliases: ["虹宮"], status: "confirmed" }
    ], "target-language alternatives must not independently match source text");
    assert.doesNotMatch(JSON.stringify(readResult.details), /错误旧译/);
    const searched = await searchProjectText.execute("selected-glossary-search", {
      path: selectedPath,
      query: "虹宮"
    });
    assert.equal(searched.details.matches.length, 1);
    assert.match(searched.details.matches[0].text, /虹宮トーヤ/);
    assert.match(searched.details.matches[0].text, /虹宫斗也/);
    await assert.rejects(
      readProjectFile.execute("selected-glossary-bulk-read", { path: selectedPath }),
      /Whole-file reads are disabled for the indexed approved glossary/i
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(referenceDir, { recursive: true, force: true });
  }
});

await test("disabled glossary candidates stay readable but are absent from the child submission schema", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-candidates-off-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const workspace = path.join(outputDir, ".translation-workshop");
  const generatedWorkspace = path.join(outputDir, "AI_translation", "_workspace");
  await writeFile(sourcePath, "Alice arrived.\n", "utf8");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "glossary.json"), JSON.stringify({
    entries: [{ source: "Alice", target: "爱丽丝" }]
  }), "utf8");
  await mkdir(generatedWorkspace, { recursive: true });
  await writeFile(path.join(generatedWorkspace, "glossary_candidates.json"), JSON.stringify({
    entries: [{ source: "arrived", target: "抵达" }]
  }), "utf8");
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const context = {
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_candidates_off",
      prompt: "translate the assigned line",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN",
      glossaryCandidates: false,
      characterBible: true
    },
    task: { fromLine: 1, toLine: 1 },
    executionMode: "full_workflow",
    publishCustomMessage: async () => {}
  };
  const tools = subagentRunner.createPiTranslationSubagentTools(context, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const searchProjectText = tools.find((tool) => tool.name === "searchProjectText");
  const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
  assert.ok(read);
  assert.ok(searchProjectText);
  assert.ok(validate);

  try {
    const readResult = await read.execute("candidates-off-read", {});
    assert.equal(readResult.details.projectReferences.glossaryCandidates.available, true);
    assert.deepEqual(readResult.details.projectReferences.directMatches.glossaryCandidates, [
      { source: "arrived", target: "抵达" }
    ], "existing candidates remain read-only consistency references while collection is disabled");
    assert.deepEqual(readResult.details.projectReferences.directMatches.approvedGlossary, [
      { source: "Alice", target: "爱丽丝" }
    ], "the formal glossary must remain active when candidate collection is disabled");
    assert.match(readResult.details.translationReference, /New glossary-candidate collection is disabled/i);
    assert.equal(Object.hasOwn(validate.parameters.properties, "glossaryCandidates"), false);
    assert.equal(Object.hasOwn(validate.parameters.properties, "characterFacts"), true);
    const runtimeSpec = subagentRunner.createPiTranslationRuntimeSpec(context, progress);
    assert.match(runtimeSpec.taskPrompt, /New glossary-candidate collection is disabled/i);
    assert.doesNotMatch(runtimeSpec.taskPrompt, /include evidence-backed glossary candidates/i);
    const candidateSearch = await searchProjectText.execute("candidates-off-search", {
      path: "AI_translation/_workspace/glossary_candidates.json",
      query: "arrived"
    });
    assert.equal(candidateSearch.details.matches.length, 1);
    assert.match(candidateSearch.details.matches[0].text, /抵达/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation child cannot complete from a pre-existing valid shard without its own native tool sequence", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-existing-shard-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidateDir = path.join(outputDir, "AI_translation");
  await writeFile(sourcePath, "one\n", "utf8");
  await mkdir(candidateDir, { recursive: true });
  await writeFile(path.join(candidateDir, "source_translated.txt"), "一\n", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: "child-existing-shard", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxText("The existing shard is already valid.")),
    fauxAssistantMessage(fauxText("No native tools are needed.")),
    fauxAssistantMessage(fauxText("I will still not call the native tools.")),
    fauxAssistantMessage(fauxText("The existing artifact is enough."))
  ]);

  try {
    await assert.rejects(() => subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_child_existing_shard",
        prompt: "translate the assigned line",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 1, toLine: 1 },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    }), /native tool|host-contract progress/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a translation child repairs every rejected line in one host-required batch", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-progressive-repair-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "いち\nに\nさん\n", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: "progressive-repair", tokensPerSecond: 1000 });
  let repairPrompt = "";
  let initialRepairResult;
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: translationEntries(["いち", "に", "さん"]).entries
    }, { id: "write-initial" }), { stopReason: "toolUse" }),
    async (context) => {
      const latestRepairResult = [...context.messages].reverse().find((message) => (
        message.role === "toolResult" && message.toolName === "repairAssignedTranslation"
      ));
      const resultText = Array.isArray(latestRepairResult?.content)
        ? latestRepairResult.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        : "";
      initialRepairResult = JSON.parse(resultText);
      const latestUser = [...context.messages].reverse().find((message) => message.role === "user");
      repairPrompt = typeof latestUser?.content === "string"
        ? latestUser.content
        : (latestUser?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [
          { line: 1, translation: "一" },
          { line: 2, translation: "二" },
          { line: 3, translation: "三" }
        ]
      }, { id: "write-repair-batch" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {
      glossaryCandidates: [],
      characterFacts: []
    }, { id: "write-repair-validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("All assigned lines pass child validation; the review-worker safety check remains."))
  ]);
  const cards = [];
  try {
    const result = await subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_progressive_repair",
        prompt: "translate the assigned range",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "ja->zh-CN"
      },
      task: { fromLine: 1, toLine: 3 },
      publishCustomMessage: async (message) => cards.push(message),
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.equal(result.validation.ok, true);
    assert.equal(result.validation.warnings.filter((finding) => finding.code === "likely_untranslated").length, 0);
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "一\n二\n三\n"
    );
    assert.equal(cards.at(-1)?.details?.status, "completed");
    assert.deepEqual(
      initialRepairResult.repairIssues.map((issue) => ({ code: issue.code, line: issue.absoluteLine })),
      [
        { code: "likely_untranslated", line: 1 },
        { code: "likely_untranslated", line: 2 },
        { code: "likely_untranslated", line: 3 }
      ],
      "the repair result must report why the submitted values were rejected, not secondary blank-candidate line counts"
    );
    assert.match(repairPrompt, /immediately preceding native tool result/i);
    assert.doesNotMatch(repairPrompt, /"sourceLineCount"|"candidateLineCount"|"issues"/i);
    assert.match(cards.at(-1)?.details?.resultSummary || "", /child-validated candidate L1-L3.*review-worker safety check required/i);
    assert.match(result.resultSummary || "", /child-validated candidate L1-L3.*review-worker safety check required/i);
    assert.match(result.reply, /review-worker safety check required/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("successful translation validation is terminal and does not buy a prose-only provider turn", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-empty-child-reply-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\n", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: "empty-child-reply", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "empty-read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["一"]), { id: "empty-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "empty-validate" }), { stopReason: "toolUse" }),
    () => {
      throw new Error("redundant final provider continuation must not run");
    }
  ]);
  const cards = [];
  try {
    const result = await subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_empty_child_reply",
        prompt: "translate the assigned range",
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
    assert.match(result.reply, /Child-validated candidate L1-L1/i);
    assert.equal(Object.hasOwn(cards.at(-1)?.details || {}, "reply"), false);
    assert.match(result.resultSummary, /child-validated candidate.*review-worker safety check required/i);
    assert.equal(Object.hasOwn(cards.at(-1)?.details || {}, "transcript"), false);
    const child = await new PiSessionRepository(outputDir).openChild(cards.at(-1)?.details?.subagentId);
    const transcript = (await child.buildContext()).messages;
    assert.equal(transcript.at(-1)?.role, "toolResult");
    assert.equal(transcript.at(-1)?.toolName, "validateAssignedTranslation");
    assert.equal(transcript.some((message) => (
      message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "text" && /child-side validation has succeeded.*review worker safety check/i.test(block.text))
    )), false, "the host must not request a redundant natural-language completion after terminal validation");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("queued post-validation writes never execute after the terminal artifact tool", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-final-reply-mutation-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\n", "utf8");
  const models = createModels();
  const provider = fauxProvider({ provider: "final-reply-mutation", tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "mutation-read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["一"]), { id: "mutation-write-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "mutation-validate-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["二"]), { id: "mutation-write-2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("I changed the shard while supplying the final reply."))
  ]);

  try {
    const result = await subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_final_reply_mutation",
        prompt: "translate the assigned range",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 1, toLine: 1 },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.equal(result.validation.ok, true);
    assert.match(result.reply, /Child-validated candidate L1-L1/i);
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "一\n",
      "the terminal validation boundary must prevent a prose-only continuation from mutating the artifact"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("child write and validation tools reject aborted work before touching the artifact", async () => {
  assert.equal(
    typeof subagentRunner.createPiTranslationSubagentTools,
    "function",
    "subagent tool lifecycle must be exposed as one native Pi tool factory"
  );
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-tool-abort-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\n", "utf8");
  const contextController = new AbortController();
  contextController.abort(new Error("parent stopped"));
  const context = {
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_tool_abort",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1 },
    publishCustomMessage: async () => {},
    signal: contextController.signal
  };
  try {
    const tools = subagentRunner.createPiTranslationSubagentTools(context);
    const write = tools.find((tool) => tool.name === "repairAssignedTranslation");
    const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
    assert.ok(write);
    assert.ok(validate);
    await assert.rejects(
      () => write.execute("call_aborted_write", translationEntries(["一"]), new AbortController().signal),
      /abort|stopp/i
    );
    const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
    await assert.rejects(() => readFile(candidatePath, "utf8"), (error) => error?.code === "ENOENT");

    const toolController = new AbortController();
    toolController.abort(new Error("tool stopped"));
    const activeContextTools = subagentRunner.createPiTranslationSubagentTools({
      ...context,
      signal: new AbortController().signal
    });
    const activeValidate = activeContextTools.find((tool) => tool.name === "validateAssignedTranslation");
    await assert.rejects(
      () => activeValidate.execute("call_aborted_validation", {}, toolController.signal),
      /abort|stopp/i
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("child runtime toolsets cannot spawn nested subagents", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-no-nested-child-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "translation.txt");
  await writeFile(sourcePath, "one\n", "utf8");
  await writeFile(translationPath, "一\n", "utf8");
  const context = {
    request: {
      outputDir,
      sourcePath,
      translationPath,
      sessionId: "pi_no_nested_child",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1 },
    publishCustomMessage: async () => {}
  };
  try {
    const translationTools = subagentRunner.createPiTranslationSubagentTools(context);
    const proofreadTools = subagentRunner.createPiProofreadSubagentTools(context, "child", {
      sourceRead: false,
      translationRead: false,
      findingsWritten: false,
      findingsCount: 0
    });
    for (const tools of [translationTools, proofreadTools]) {
      const names = tools.map((tool) => tool.name);
      assert.equal(names.some((name) => /subagent|spawn|delegate/i.test(name)), false);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation and proofread children may read any project file while writes remain host constrained", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-read-scope-"));
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-external-reference-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "translation.txt");
  const contextPath = path.join(outputDir, "references", "world.md");
  const externalPath = path.join(externalDir, "outside-lore.md");
  await mkdir(path.dirname(contextPath), { recursive: true });
  await writeFile(sourcePath, "one\ntwo\nthree\n", "utf8");
  await writeFile(translationPath, "一\n二\n三\n", "utf8");
  await writeFile(contextPath, "shared context outside the delegated line range\n", "utf8");
  await writeFile(externalPath, "user-provided external lore: Aurora Bridge\n", "utf8");
  const context = {
    request: {
      outputDir,
      sourcePath,
      translationPath,
      sessionId: "pi_child_read_scope",
      prompt: "inspect and repair line 2",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 2, toLine: 2 },
    publishCustomMessage: async () => {}
  };
  try {
    const translationTools = subagentRunner.createPiTranslationSubagentTools(context);
    const proofreadTools = subagentRunner.createPiProofreadSubagentTools(context, "child", {
      referenceRead: false,
      findingsWritten: false,
      findingsCount: 0
    });
    for (const tools of [translationTools, proofreadTools]) {
      const names = tools.map((tool) => tool.name);
      assert.ok(names.includes("listProjectDir"));
      assert.ok(names.includes("searchProjectText"));
      assert.ok(names.includes("readProjectFile"));
      assert.equal(names.includes("writeProjectFile"), false);
      const read = tools.find((tool) => tool.name === "readProjectFile");
      const result = await read.execute("read_shared_context", { path: "references/world.md" });
      assert.match(result.details.content, /shared context outside the delegated line range/);
      const external = await read.execute("read_external_reference", { path: externalPath });
      assert.equal(external.details.outsideProject, true);
      assert.match(external.details.content, /Aurora Bridge/);
      const list = tools.find((tool) => tool.name === "listProjectDir");
      const externalList = await list.execute("list_external_reference", { path: externalDir });
      assert.equal(externalList.details.outsideProject, true);
      assert.ok(externalList.details.entries.some((entry) => entry.name === "outside-lore.md"));
      const search = tools.find((tool) => tool.name === "searchProjectText");
      const externalSearch = await search.execute("search_external_reference", {
        path: externalDir,
        query: "Aurora Bridge"
      });
      assert.equal(externalSearch.details.matches[0].path, externalPath);
    }
    assert.equal(await readFile(sourcePath, "utf8"), "one\ntwo\nthree\n");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

await test("translation child tools write only the generated candidate when translationPath is bound", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-translation-bound-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "bound-review-translation.txt");
  await writeFile(sourcePath, "hello\n", "utf8");
  await writeFile(translationPath, "DO NOT MODIFY\n", "utf8");
  try {
    const tools = subagentRunner.createPiTranslationSubagentTools({
      request: {
        outputDir,
        sourcePath,
        translationPath,
        sessionId: "pi_translation_bound",
        prompt: "translate",
        providerId: "test",
        modelId: "test",
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 1, toLine: 1 },
      publishCustomMessage: async () => {}
    });
    const read = tools.find((tool) => tool.name === "readAssignedSource");
    const write = tools.find((tool) => tool.name === "repairAssignedTranslation");
    assert.ok(read);
    await read.execute("read_candidate_source", {});
    await write.execute("write_candidate_only", translationEntries(["你好"]));
    assert.equal(await readFile(translationPath, "utf8"), "DO NOT MODIFY\n");
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "你好\n"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder translation queues all documents through the configured number of native Pi workers", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-workers-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const documentCount = 16;
  const workerCount = 5;
  for (let index = 0; index < documentCount; index += 1) {
    await writeFile(
      path.join(sourceRoot, `${String(index + 1).padStart(2, "0")}.txt`),
      `line ${index + 1}a\nline ${index + 1}b\n`,
      "utf8"
    );
  }

  const enteredWorkers = deferred();
  const releaseWorkers = deferred();
  let entered = 0;
  const provider = fauxProvider({ provider: "folder-worker-queue", tokensPerSecond: 10_000 });
  provider.setResponses(Array.from({ length: documentCount }, (_, index) => async () => {
    entered += 1;
    if (entered === workerCount) enteredWorkers.resolve();
    await releaseWorkers.promise;
    throw new Error(`worker probe ${index + 1} released`);
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  let selectionCount = 0;
  const createSubagentModelSelection = async () => {
    selectionCount += 1;
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  };
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: createSubagentModelSelection
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_worker_queue",
      prompt: "translate folder with five workers",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: workerCount,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);

  try {
    const result = await run.execute("folder_worker_queue", {});
    assert.equal(result.details.subagents.length, workerCount,
      "the tool result must expose five logical workers, not one child per file");
    assert.equal(result.details.assignmentCount, documentCount);
    await Promise.race([
      enteredWorkers.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `only ${entered}/${workerCount} configured workers entered`
      )), 2_000))
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(entered, workerCount,
      "the sixth document must remain queued until one of the five workers becomes available");
    assert.equal(selectionCount, workerCount,
      "the host must construct five persistent Pi workers, not one runtime per queued file");
  } finally {
    releaseWorkers.resolve();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a terminology claim gate pauses every worker and drains priority repairs before the original queue", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-terminology-gate-"));
  const gate = deferred();
  const firstRelease = deferred();
  const secondRelease = deferred();
  const repairRelease = deferred();
  const quiescent = deferred();
  const thirdStarted = deferred();
  const started = [];
  let blocked = false;
  let gateNotificationCount = 0;
  const supervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    notifyParent: async () => {}
  });
  const task = (id, line, reviewFeedback) => ({
    id,
    documentId: "source.txt",
    fromLine: line,
    toLine: line,
    label: id,
    ...(reviewFeedback ? { reviewFeedback, terminologyRepair: true } : {})
  });
  const tasks = [task("first", 1), task("second", 2), task("third", 3)];
  const batch = supervisor.startBatch({
    kind: "translation",
    request: {
      outputDir,
      sourcePath: path.join(outputDir, "source.txt"),
      sessionId: "terminology_gate",
      prompt: "test",
      providerId: "test",
      modelId: "test"
    },
    tasks,
    additionalWriteScopes: [{ documentId: "source.txt", fromLine: 4, toLine: 4 }],
    maxWorkers: 2,
    label: (entry) => entry.label,
    range: (entry) => entry,
    documentId: (entry) => entry.documentId,
    writeScope: (entry) => entry,
    claimGate: {
      isBlocked: () => blocked,
      wait: () => gate.promise,
      notificationKey: () => blocked ? "conflict-1" : undefined,
      onQuiescent: () => {
        gateNotificationCount += 1;
        quiescent.resolve();
      }
    },
    async run(entry) {
      started.push(entry.id);
      if (entry.id === "first") await firstRelease.promise;
      if (entry.id === "second") await secondRelease.promise;
      if (entry.id === "repair") await repairRelease.promise;
      if (entry.id === "third") thirdStarted.resolve();
      return { id: entry.id };
    },
    onTaskCompleted(_result, entry) {
      if (entry.id === "first") blocked = true;
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(new Set(started), new Set(["first", "second"]));
    firstRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(blocked, true);
    secondRelease.resolve();
    await quiescent.promise;
    assert.equal(gateNotificationCount, 1);
    assert.equal(started.includes("third"), false, "original debt escaped while the terminology gate was closed");

    const repair = task("repair", 4, [{ line: 4, reason: "terminology: use canonical target" }]);
    assert.equal(supervisor.translationPriorityBatchOwner(repair), batch.id,
      "a cold-recovery conflict scope was not owned by the current gated batch");
    assert.equal(supervisor.enqueueTranslationPriorityTasks(batch.id, [repair]), 1);
    blocked = false;
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(started.includes("repair"), true);
    assert.equal(started.includes("third"), false,
      "an idle worker skipped the active priority-repair barrier and claimed original debt");
    repairRelease.resolve();
    await thirdStarted.promise;
    await supervisor.waitForAll();
    assert.ok(started.indexOf("repair") < started.indexOf("third"));
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    repairRelease.resolve();
    gate.resolve();
    supervisor.abortAll();
    await supervisor.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("persisted terminology repairs start as a priority wave before staged original assignments", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-persisted-terminology-priority-"));
  const priorityRelease = deferred();
  const normalStarted = deferred();
  const started = [];
  let normalCount = 0;
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
  const priority = {
    id: "priority",
    documentId: "a.txt",
    fromLine: 1,
    toLine: 1,
    label: "priority",
    terminologyRepair: true,
    reviewFeedback: [{ line: 1, reason: "terminology: use canonical target" }],
    scheduleStage: 0
  };
  const normalTasks = [
    { id: "normal-a", documentId: "b.txt", fromLine: 1, toLine: 1, label: "normal-a", scheduleStage: 0 },
    { id: "normal-b", documentId: "b.txt", fromLine: 2, toLine: 2, label: "normal-b", scheduleStage: 0 }
  ];
  supervisor.startBatch({
    kind: "translation",
    request: {
      outputDir,
      sourcePath: path.join(outputDir, "source"),
      sessionId: "persisted_terminology_priority",
      prompt: "test",
      providerId: "test",
      modelId: "test"
    },
    tasks: [priority, ...normalTasks],
    initialPriorityTasks: [priority],
    maxWorkers: 2,
    taskStage: (task) => task.scheduleStage,
    label: (task) => task.label,
    range: (task) => task,
    documentId: (task) => task.documentId,
    writeScope: (task) => task,
    async run(task) {
      started.push(task.id);
      if (task.id === "priority") await priorityRelease.promise;
      else {
        normalCount += 1;
        if (normalCount === 2) normalStarted.resolve();
      }
      return { id: task.id };
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started, ["priority"], "an original assignment escaped the restored priority wave");
    priorityRelease.resolve();
    await normalStarted.promise;
    await supervisor.waitForAll();
    assert.ok(started.indexOf("priority") < started.indexOf("normal-a"));
    assert.ok(started.indexOf("priority") < started.indexOf("normal-b"));
  } finally {
    priorityRelease.resolve();
    supervisor.abortAll();
    await supervisor.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("one large folder file is split across the configured persistent worker pool", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-large-file-pool-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "script.txt"),
    `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
    "utf8"
  );
  const allWorkersEntered = deferred();
  const releaseWorkers = deferred();
  let entered = 0;
  const provider = fauxProvider({ provider: "folder-large-file-pool", tokensPerSecond: 10_000 });
  provider.setResponses(Array.from({ length: 20 }, () => async () => {
    entered += 1;
    if (entered === 5) allWorkersEntered.resolve();
    await releaseWorkers.promise;
    throw new Error("large-file pool probe released");
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  let selectionCount = 0;
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => {
      selectionCount += 1;
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    }
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_large_file_pool",
      prompt: "translate one large file with five workers",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 5,
      translationSplitSize: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);
  try {
    const result = await run.execute("folder_large_file_pool", {});
    assert.equal(result.details.assignmentCount, 10);
    assert.equal(result.details.subagents.length, 5);
    await Promise.race([
      allWorkersEntered.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`only ${entered}/5 workers entered the large file`)), 2_000))
    ]);
    assert.equal(selectionCount, 5);
  } finally {
    releaseWorkers.resolve();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder batches reduce an up-to worker ceiling when ready assignments are fewer", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-idle-workers-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "a.txt"), "a\n", "utf8");
  await writeFile(path.join(sourceRoot, "b.txt"), "b\n", "utf8");
  const release = deferred();
  const provider = fauxProvider({ provider: "folder-idle-workers", tokensPerSecond: 10_000 });
  provider.setResponses(Array.from({ length: 10 }, () => async () => {
    await release.promise;
    throw new Error("idle worker count probe");
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  let selectionCount = 0;
  const allWorkersCreated = deferred();
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => {
      selectionCount += 1;
      if (selectionCount === 2) allWorkersCreated.resolve();
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    }
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_idle_workers",
      prompt: "translate two files with five persistent workers",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 5,
      translationSplitSize: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);
  try {
    const started = await run.execute("folder_idle_workers", {});
    await Promise.race([
      allWorkersCreated.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("two useful workers were not created")), 1_000))
    ]);
    assert.equal(started.details.subagents.length, 2);
    assert.equal(selectionCount, 2);
  } finally {
    release.resolve();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a folder worker that exhausts one assignment never claims the next ready work unit", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-balanced-queue-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const documents = [
    ["01.txt", 10],
    ["02.txt", 9],
    ["03.txt", 8],
    ["04.txt", 4],
    ["05.txt", 3],
    ["06.txt", 2]
  ];
  for (const [name, lineCount] of documents) {
    await writeFile(
      path.join(sourceRoot, name),
      `${Array.from({ length: lineCount }, (_, index) => `${name}-${index + 1}`).join("\n")}\n`,
      "utf8"
    );
  }

  const releaseSecond = deferred();
  const seen = [];
  const provider = fauxProvider({ provider: "folder-balanced-queue", tokensPerSecond: 10_000 });
  provider.setResponses(Array.from({ length: 20 }, () => async (context) => {
    const text = context.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => typeof message.content === "string"
        ? [message.content]
        : message.content.filter((block) => block.type === "text").map((block) => block.text))
      .join("\n");
    const document = [...text.matchAll(/source file (0\d\.txt)/g)].at(-1)?.[1] ?? "unknown";
    seen.push(document);
    if (document === "02.txt") await releaseSecond.promise;
    throw new Error(`balanced queue probe ${document}`);
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    })
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_balanced_queue",
      prompt: "translate folder with workload-balanced persistent workers",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 2,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);

  try {
    await run.execute("folder_balanced_queue", {});
    await Promise.race([
      new Promise((resolve) => {
        const poll = () => seen.filter((document) => document === "01.txt").length >= 2
          ? resolve()
          : setTimeout(poll, 10);
        poll();
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `the first worker did not exhaust its bounded retry path; started ${seen.join(", ")}`
      )), 1_000))
    ]);
    assert.deepEqual(new Set(seen.slice(0, 2)), new Set(["01.txt", "02.txt"]));
    assert.equal(seen.some((document) => !["01.txt", "02.txt"].includes(document)), false,
      `an exhausted worker claimed later queue debt before explicit continuation; started ${seen.join(", ")}`);
  } finally {
    releaseSecond.resolve();
    await subagents.waitForAll();
    assert.equal(seen.some((document) => !["01.txt", "02.txt"].includes(document)), false,
      `a failed batch continued draining shared assignments; started ${seen.join(", ")}`);
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a permanent priority-stage failure never opens later folder stages", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-stage-barrier-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "tips.txt"), "tip a\ntip b\n", "utf8");
  await writeFile(path.join(sourceRoot, "script.txt"), "script a\nscript b\n", "utf8");
  await writeFile(path.join(sourceRoot, "epilogue.txt"), "end a\nend b\n", "utf8");
  const releasePriority = deferred();
  const releaseParallel = deferred();
  const scriptStarted = deferred();
  const epilogueStarted = deferred();
  const seen = [];
  const provider = fauxProvider({ provider: "folder-stage-barrier", tokensPerSecond: 10_000 });
  provider.setResponses(Array.from({ length: 10 }, () => async (context) => {
    const serialized = JSON.stringify(context.messages);
    const document = serialized.includes("tips.txt")
      ? "tips.txt"
      : serialized.includes("script.txt")
        ? "script.txt"
        : serialized.includes("epilogue.txt") ? "epilogue.txt" : "unknown";
    seen.push(document);
    if (document === "tips.txt") await releasePriority.promise;
    if (document === "script.txt") {
      scriptStarted.resolve();
      await releaseParallel.promise;
    }
    if (document === "epilogue.txt") epilogueStarted.resolve();
    throw new Error(`stage barrier probe ${document}`);
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    })
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_stage_barrier",
      prompt: "translate priority file before the parallel group",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 2,
      translationSplitSize: 2,
      folderTranslationOrder: '"tips.txt"\n{\n"script.txt"\n}\n"epilogue.txt"',
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);
  try {
    await run.execute("folder_stage_barrier", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(new Set(seen), new Set(["tips.txt"]), `later stage started early: ${seen.join(", ")}`);
    releasePriority.resolve();
    await subagents.waitForAll();
    assert.deepEqual(new Set(seen), new Set(["tips.txt"]),
      `later stages started after a permanent priority failure: ${seen.join(", ")}`);
  } finally {
    releasePriority.resolve();
    releaseParallel.resolve();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("Stop wakes idle persistent workers waiting behind a folder stage barrier", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-stage-stop-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "tips.txt"), "tip a\ntip b\n", "utf8");
  await writeFile(path.join(sourceRoot, "script.txt"), "script a\nscript b\n", "utf8");
  const priorityStarted = deferred();
  const provider = fauxProvider({ provider: "folder-stage-stop", tokensPerSecond: 10_000 });
  provider.setResponses(Array.from({ length: 10 }, () => async (_context, options) => {
    priorityStarted.resolve();
    await new Promise((resolve) => {
      options?.signal?.addEventListener("abort", resolve, { once: true });
      if (options?.signal?.aborted) resolve();
    });
    return fauxAssistantMessage(fauxText("stopped"));
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    })
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_stage_stop",
      prompt: "translate priority file before the parallel group",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 2,
      translationSplitSize: 2,
      folderTranslationOrder: '"tips.txt"\n{\n"script.txt"\n}',
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);
  try {
    await run.execute("folder_stage_stop", {});
    await priorityStarted.promise;
    assert.equal(subagents.abortAll(), 2);
    await Promise.race([
      subagents.waitForAll(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stage waiters did not stop")), 1_000))
    ]);
    const batch = subagents.list().find((entry) => entry.kind === "translation");
    assert.ok(batch);
    assert.ok(batch.subagents.every((child) => child.status === "stopped"));
  } finally {
    subagents.abortAll();
    await subagents.waitForAll();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("later folder stages receive discoveries completed by an earlier stage", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-stage-discoveries-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  const discoveryTerms = Array.from({ length: 64 }, (_, index) => `NamedTerm${String(index).padStart(2, "0")}`);
  await writeFile(path.join(sourceRoot, "tips.txt"), `${discoveryTerms.join(" ")}\n`, "utf8");
  await writeFile(path.join(sourceRoot, "script.txt"), "Continue NamedTerm00\n", "utf8");
  let laterContext = "";
  const discoveryCandidates = discoveryTerms.map((source, index) => ({
    source,
    target: `专名${String(index).padStart(2, "0")}`,
    category: "proper_noun",
    evidenceLine: 1,
    rationale: `Priority-file evidence ${index}: ${"context".repeat(80)}`
  }));
  const provider = fauxProvider({ provider: "folder-stage-discoveries", tokensPerSecond: 10_000 });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "discover_read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
      blocks: [{ id: "0", lines: [`0${discoveryCandidates.map((candidate) => candidate.target).join(" ")}`] }]
    }, { id: "discover_write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {
      glossaryCandidates: discoveryCandidates,
      characterFacts: []
    }, { id: "discover_validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "discover_review_read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "discover_review_submit" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "later_read" }), { stopReason: "toolUse" }),
    async (context) => {
      laterContext = JSON.stringify(context.messages.slice(-2));
      throw new Error("later-stage context captured");
    },
    async () => { throw new Error("later-stage retry probe"); },
    async () => { throw new Error("later-stage retry probe"); }
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    }),
    notifyParent: async () => {}
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_stage_discoveries",
      prompt: "translate tips before script",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 1,
      subagentProviderId: provider.provider.id,
      subagentModelId: provider.getModel().id,
      reviewSubagentCount: 1,
      translationSplitSize: 2,
      folderTranslationOrder: '"tips.txt"\n{\n"script.txt"\n}',
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);
  try {
    await run.execute("folder_stage_discoveries", {});
    await subagents.waitForAll();
    assert.match(laterContext, /Earlier completed folder-stage discoveries/);
    assert.match(laterContext, /NamedTerm00/);
    assert.match(laterContext, /专名00/);
    assert.match(laterContext, new RegExp(discoveryTerms.at(-1)));
    assert.doesNotMatch(laterContext, /NamedTerm01/);
    assert.match(laterContext, /omittedDiscoveryCount.*52/);
    assert.ok(laterContext.length < 9_000, `prior discovery context must remain bounded, received ${laterContext.length} chars`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a persistent folder worker retries an early assignment before later queue progress", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-folder-worker-failure-"));
  const sourceRoot = path.join(outputDir, "source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "01.txt"), "alpha\nbeta\n", "utf8");
  await writeFile(path.join(sourceRoot, "02.txt"), "gamma\ndelta\n", "utf8");
  const provider = fauxProvider({ provider: "folder-worker-failure", tokensPerSecond: 10_000 });
  let secondAssignmentContext = "";
  let retryAssignmentContext = "";
  provider.setResponses([
    async () => { throw new Error("first assignment failed"); },
    async (context) => {
      retryAssignmentContext = JSON.stringify(context.messages);
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "retry-read" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["阿尔法", "贝塔"]), { id: "retry-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "retry-validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("retried assignment completed")),
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "retry-review-read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "retry-review-submit" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("retried assignment review accepted")),
    async (context) => {
      secondAssignmentContext = JSON.stringify(context.messages);
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "second-read" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", translationEntries(["伽马", "德尔塔"]), { id: "second-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "second-validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("second assignment completed")),
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id: "second-review-read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id: "second-review-submit" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("second assignment review accepted"))
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  let selectionCount = 0;
  const published = [];
  const subagents = new YnSubagentSupervisor({
    publishCustomMessage: async (message) => { published.push(message); },
    createModelSelection: async () => {
      selectionCount += 1;
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    },
    notifyParent: async () => {}
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath: sourceRoot,
      sourceSelection: { kind: "folder", path: sourceRoot },
      sessionId: "pi_folder_worker_failure",
      prompt: "translate both files with one persistent worker",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      subagentEnabled: true,
      subagentCount: 1,
      subagentProviderId: provider.provider.id,
      subagentModelId: provider.getModel().id,
      reviewSubagentCount: 1,
      languagePair: "en->zh-CN"
    },
    publishCustomMessage: async (message) => { published.push(message); },
    subagents
  });
  const run = tools.find((tool) => tool.name === "runTranslationSubagents");
  assert.ok(run);

  try {
    await run.execute("folder_worker_failure", {});
    await subagents.waitForAll();
    assert.equal(selectionCount, 2, "two queued files must reuse one translation Pi runtime plus one review Pi runtime");
    assert.match(retryAssignmentContext, /01\.txt/);
    assert.doesNotMatch(retryAssignmentContext, /02\.txt|gamma|delta/);
    assert.doesNotMatch(
      secondAssignmentContext,
      /01\.txt|alpha|beta/,
      "a persistent worker must reset native Pi model context after the retried file succeeds"
    );
    assert.match(secondAssignmentContext, /02\.txt/);
    const batch = subagents.list().find((entry) => entry.kind === "translation");
    assert.ok(batch);
    assert.equal(batch.subagents.length, 1);
    assert.equal(batch.subagents[0].status, "completed");
    assert.equal(batch.subagents[0].assignmentCount, 3);
    assert.equal(batch.subagents[0].completedAssignments, 2);
    const reviewBatch = subagents.list().find((entry) => entry.kind === "translation-review");
    assert.ok(reviewBatch);
    assert.equal(reviewBatch.subagents.length, 1);
    assert.equal(reviewBatch.subagents[0].status, "completed");
    assert.equal(reviewBatch.subagents[0].assignmentCount, 2);
    assert.equal(reviewBatch.subagents[0].completedAssignments, 2);
    const reviewCards = published.filter((message) => message.role === "custom"
      && message.customType === "subagent.translation-review"
      && message.details?.subagentId === reviewBatch.subagents[0].id);
    const reviewTerminal = reviewCards.at(-1);
    assert.equal(reviewTerminal?.details?.status, "completed");
    assert.equal(reviewTerminal?.details?.documentId, "02.txt");
    assert.deepEqual(reviewTerminal?.details?.range, { fromLine: 1, toLine: 2 });
    assert.equal(reviewTerminal?.details?.startedAt, reviewCards[0]?.details?.startedAt);
    assert.ok(reviewTerminal?.details?.finishedAt >= reviewTerminal?.details?.startedAt);
    const cards = published.filter((message) => message.role === "custom"
      && message.details?.subagentId === batch.subagents[0].id);
    const terminal = cards.at(-1);
    assert.equal(terminal?.details?.status, "completed");
    assert.deepEqual(terminal?.details?.documentIds, ["01.txt", "02.txt"]);
    assert.deepEqual(terminal?.details?.failedDocumentIds, []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation child tools process an assignment through validated line chunks", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-chunked-translation-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\ntwo\nthree\nfour\n", "utf8");
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = subagentRunner.createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_chunked_translation",
      prompt: "translate in chunks",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 4 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "repairAssignedTranslation");
  const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
  assert.ok(read);
  assert.ok(write);
  assert.ok(validate);

  try {
    const first = await read.execute("chunk_read_1", { fromLine: 1, toLine: 2 });
    assert.deepEqual(first.details.sourceBlocks, [{
      id: "0",
      absoluteLines: [1, 2],
      lines: ["0one", "1two"]
    }]);
    await write.execute("chunk_write_1", { fromLine: 1, toLine: 2, ...translationEntries(["一", "二"]) });
    await assert.rejects(
      () => validate.execute("chunk_validate_incomplete", {}),
      /remaining|incomplete|not fully|未完成/i
    );

    const second = await read.execute("chunk_read_2", { fromLine: 3, toLine: 4 });
    assert.deepEqual(second.details.sourceBlocks, [{
      id: "0",
      absoluteLines: [3, 4],
      lines: ["0three", "1four"]
    }]);
    await write.execute("chunk_write_2", { fromLine: 3, toLine: 4, ...translationEntries(["三", "四"], 3) });
    const validated = await validate.execute("chunk_validate_complete", {
      glossaryCandidates: [{
        source: "one",
        target: "一",
        category: "proper_noun",
        evidenceLine: 1,
        rationale: "Recurring named entity"
      }],
      characterFacts: [{
        sourceName: "two",
        targetName: "二",
        evidenceLine: 2,
        evidence: "The source names the speaker but provides no gender evidence.",
        gender: "unknown",
        confidence: "unknown"
      }]
    });
    assert.equal(validated.details.fromLine, 1);
    assert.equal(validated.details.toLine, 4);
    assert.equal(progress.sourceRead, true);
    assert.equal(progress.translationWritten, true);
    assert.equal(progress.translationValidated, true);
    assert.deepEqual(validated.details.discoveries, progress.discoveries);
    assert.equal(validated.details.discoveries.glossaryCandidates[0].source, "one");
    assert.equal(validated.details.discoveries.characterFacts[0].gender, "unknown");
    assert.equal(
      await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"),
      "一\n二\n三\n四\n"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("bounded translation validation requires a lightweight line-failure report", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-shifted-bounded-repair-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, [
    "John opened the old wooden door.",
    "Mary closed the tall glass window.",
    "The teacher read the important letter."
  ].join("\n") + "\n", "utf8");
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = subagentRunner.createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_shifted_bounded_repair",
      prompt: "repair the shifted translation",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 3 },
    executionMode: "bounded_repair",
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "repairAssignedTranslation");
  const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
  assert.ok(read);
  assert.ok(write);
  assert.ok(validate);

  try {
    await read.execute("shifted_read", {});
    await write.execute("shifted_write", {
      entries: [
        "1:玛丽关上了高大的玻璃窗。",
        "2:老师读了那封重要的信。",
        "3:约翰打开了那扇旧木门。"
      ]
    });
    await assert.rejects(
      () => validate.execute("shifted_validate", {}),
      /misalignedLines/i,
      "bounded repair must explicitly submit its lightweight alignment result"
    );
    await assert.rejects(
      () => validate.execute("shifted_validate_reported", { misalignedLines: [1, 2, 3] }),
      /still fails at L1, L2, L3/i,
      "reported same-count shifted rows must return to exact repair debt"
    );
    assert.deepEqual([...progress.requiredBatchLines], [1, 2, 3]);
    assert.equal(progress.translationValidated, false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation discovery merge deduplicates exact child proposals without hiding conflicts", () => {
  const first = {
    glossaryCandidates: [{
      source: "ゼノン",
      target: "杰农",
      category: "proper_noun",
      evidenceLine: 10,
      rationale: "Named character"
    }],
    characterFacts: [{
      sourceName: "ゼノン",
      targetName: "杰农",
      evidenceLine: 10,
      evidence: "No gender marker in this passage.",
      gender: "unknown",
      confidence: "unknown"
    }]
  };
  const merged = subagentRunner.mergeTranslationDiscoveries([
    first,
    first,
    {
      glossaryCandidates: [{ ...first.glossaryCandidates[0], target: "泽农" }],
      characterFacts: []
    }
  ]);
  assert.equal(merged.glossaryCandidates.length, 2, "conflicting targets must remain visible to the parent");
  assert.equal(merged.characterFacts.length, 1, "exact character facts should be deduplicated");
});

await test("large translation assignments page model reads and reject empty artifact writes", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-large-translation-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: subagentRunner.MAX_ASSIGNED_TRANSLATION_CHUNK_LINES + 1 }, (_, index) => `line ${index + 1}`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`, "utf8");
  const tools = subagentRunner.createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_large_translation",
      prompt: "translate safely",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: sourceLines.length },
    publishCustomMessage: async () => {}
  });
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "writeAssignedTranslation");
  assert.ok(read);
  assert.ok(write);

  try {
    const firstPage = await read.execute("large_first_page", {});
    assert.equal(firstPage.details.fromLine, 1);
    assert.equal(firstPage.details.toLine, subagentRunner.MAX_TRANSLATION_MODEL_PAGE_LINES);
    assert.equal(firstPage.details.hasMore, true);
    assert.equal(firstPage.details.nextFromLine, subagentRunner.MAX_TRANSLATION_MODEL_PAGE_LINES + 1);
    const partial = await write.execute("large_empty_write", {
      blocks: []
    });
    assert.equal(partial.details.missingLines.length, subagentRunner.MAX_TRANSLATION_MODEL_PAGE_LINES);
    const partialText = await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8");
    assert.equal(partialText.includes("line 1"), false, "empty writes must not materialize copied source placeholders");
    const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
    assert.ok(validate);
    await assert.rejects(
      () => validate.execute("large_incomplete_validate", {}),
      /assigned translation is incomplete/i
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation children execute the host-owned Pi prompt and receive validated workflow assets", async () => {
  const provider = fauxProvider({ provider: "child-contract", tokensPerSecond: 10_000 });
  let firstContext;
  let postReadContext;
  provider.setResponses([
    async (context) => {
      firstContext = context;
      return fauxAssistantMessage(
        fauxToolCall("readAssignedSource", {}, { id: "contract-read" }),
        { stopReason: "toolUse" }
      );
    },
    async (context) => {
      postReadContext = context;
      return fauxAssistantMessage(
        fauxToolCall("repairAssignedTranslation", translationEntries(["用語"]), { id: "contract-write" }),
        { stopReason: "toolUse" }
      );
    },
    fauxAssistantMessage(
      fauxToolCall("validateAssignedTranslation", {}, { id: "contract-validate" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("Host-owned contract completed."))
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-contract-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "one\n", "utf8");

  try {
    const workspace = path.join(outputDir, "AI_translation", "_workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "glossary_candidates.json"), JSON.stringify({
      entries: [{ source: "one", target: "用語" }]
    }), "utf8");
    await writeFile(
      path.join(workspace, "character_bible.md"),
      "# Character Bible\n\n## Alice / 爱丽丝\n- Gender/pronouns: female; she/her; confirmed\n- Terms of address: Alice\n- Voice/register: Alice: calm and formal voice.\n",
      "utf8"
    );
    const projectWorkspace = path.join(outputDir, ".translation-workshop");
    await mkdir(projectWorkspace, { recursive: true });
    await writeFile(path.join(projectWorkspace, "glossary.json"), JSON.stringify({
      entries: [{ source: "ProjectTerm", target: "项目术语" }]
    }), "utf8");
    await writeFile(path.join(projectWorkspace, "style_guide.md"), "# Style\nforbidden: 硬直译\n", "utf8");

    await subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_child_contract",
        prompt: "translate the assigned range",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->ja",
        style: "literary mystery",
        workDescription: "Preserve the narrator's restrained voice."
      },
      task: {
        fromLine: 1,
        toLine: 1,
        taskPrompt: "Use readProjectFile, then readSourceLines and writeTranslationChunk."
      },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });

    assert.ok(firstContext, "the child provider did not receive a model context");
    const userPrompt = firstContext.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => typeof message.content === "string"
        ? [message.content]
        : message.content.filter((block) => block.type === "text").map((block) => block.text))
      .join("\n");
    assert.match(userPrompt, /readAssignedSource/);
    assert.match(userPrompt, /writeAssignedTranslation/);
    assert.match(userPrompt, /language pair en->ja/);
    assert.match(userPrompt, /Project style: literary mystery/);
    assert.match(userPrompt, /Work description: Preserve the narrator's restrained voice\./);
    assert.doesNotMatch(userPrompt, /Simplified Chinese/);
    assert.match(userPrompt, /Every non-empty output line must be the actual translation of its matching source line/);
    assert.match(userPrompt, /Never write progress narration.*generic placeholder prose/s);
    assert.ok(userPrompt.length < 2_800, `translation child prompt is still bloated (${userPrompt.length} chars)`);
    assert.doesNotMatch(userPrompt, /readProjectFile|readSourceLines|writeTranslationChunk/);
    assert.doesNotMatch(firstContext.systemPrompt, /Current workflow glossary candidates|用語|Alice: calm/);
    const postReadMessages = JSON.stringify(postReadContext?.messages ?? []);
    assert.match(postReadMessages, /Built-in translate-text child workflow/);
    assert.match(postReadMessages, /Translation Child Contract/);
    assert.doesNotMatch(postReadMessages, /Host Tool Sequence|Self-check Before Every Write|Non-Translate Patterns/);
    assert.match(postReadMessages, /projectReferences/);
    assert.match(postReadMessages, /glossary_candidates\.json/);
    assert.match(postReadMessages, /character_bible\.md/);
    assert.match(postReadMessages, /style_guide\.md/);
    assert.match(postReadMessages, /glossary\.json/);
    assert.match(postReadMessages, /directMatches/);
    assert.match(postReadMessages, /"source":\s*"one"/,
      "assigned-source glossary candidates should arrive without a separate project-file read");
    assert.match(postReadMessages, /用語/);
    assert.doesNotMatch(postReadMessages, /ProjectTerm|Alice: calm and formal voice|forbidden: 硬直译/,
      "unmatched project asset bodies must stay out of the assignment context");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("proofreading children receive one aligned host context with the complete built-in workflow", async () => {
  const provider = fauxProvider({ provider: "proofread-child-contract", tokensPerSecond: 10_000 });
  let firstContext;
  let postReadContext;
  provider.setResponses([
    async (context) => {
      firstContext = context;
      return fauxAssistantMessage(
        fauxToolCall("readAssignedProofreadContext", {}, { id: "proofread-contract-read" }),
        { stopReason: "toolUse" }
      );
    },
    async (context) => {
      postReadContext = context;
      return fauxAssistantMessage(
        fauxToolCall("writeAssignedFindings", { findings: [{
          id: "H1-001",
          type: "mistranslation",
          sourceLine: 2,
          suggestedFix: "一",
          rationale: "The current translation does not preserve the source meaning."
        }] }, { id: "proofread-contract-write" }),
        { stopReason: "toolUse" }
      );
    },
    fauxAssistantMessage(fauxText("The assigned range is clean."))
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-child-contract-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "translation.txt");
  await writeFile(sourcePath, "before\none\nafter\n", "utf8");
  await writeFile(translationPath, "前文\n术语目标\n后文\n", "utf8");

  try {
    const workspace = path.join(outputDir, "AI_translation", "_workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "glossary_candidates.json"), JSON.stringify({
      entries: [{ source: "one", target: "术语目标" }]
    }), "utf8");
    await writeFile(
      path.join(workspace, "character_bible.md"),
      "# Character Bible\n\n## Alice / 爱丽丝\n- Gender/pronouns: female; she/her; confirmed\n- Terms of address: Alice\n- Voice/register: Alice: calm and formal voice.\n",
      "utf8"
    );

    await subagentRunner.runPiProofreadSubagent({
      request: {
        outputDir,
        sourcePath,
        translationPath,
        sessionId: "pi_proofread_child_contract",
        prompt: "proofread the assigned range",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->zh-CN"
      },
      task: { fromLine: 2, toLine: 2 },
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });

    assert.ok(firstContext, "the proofreading child provider did not receive a model context");
    const userPrompt = firstContext.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => typeof message.content === "string"
        ? [message.content]
        : message.content.filter((block) => block.type === "text").map((block) => block.text))
      .join("\n");
    assert.match(userPrompt, /readAssignedProofreadContext/);
    assert.match(userPrompt, /writeAssignedFindings/);
    assert.doesNotMatch(userPrompt, /readAssignedSource|readAssignedTranslation|readProjectFile/);
    assert.doesNotMatch(firstContext.systemPrompt, /Current workflow glossary candidates|术语目标|Alice: calm/);
    const postReadMessages = JSON.stringify(postReadContext?.messages ?? []);
    assert.match(postReadMessages, /Built-in proofread-translation child workflow/);
    assert.match(postReadMessages, /Proofread Child Task Contract/);
    assert.match(postReadMessages, /H1-001/);
    assert.doesNotMatch(postReadMessages, /Reviewer Priorities|Severity Codes|Non-Negotiable Fix Contract/);
    assert.ok(postReadMessages.length < 10_000, `proofread child context is still bloated (${postReadMessages.length} chars)`);
    assert.match(postReadMessages, /projectReferences/);
    assert.match(postReadMessages, /directMatches/);
    assert.match(postReadMessages, /glossaryCandidates/);
    assert.match(postReadMessages, /术语目标/);
    assert.doesNotMatch(postReadMessages, /Alice: calm and formal voice/,
      "an unmatched character-bible body was injected into the assignment context");
    assert.match(postReadMessages, /contextBefore/);
    assert.match(postReadMessages, /contextAfter/);
    assert.match(postReadMessages, /\\?"line\\?":\s*1/);
    assert.match(postReadMessages, /\\?"line\\?":\s*3/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("bounded repair keeps the same writable child alive and coaches it with the exact host rejection", async () => {
  const provider = fauxProvider({ provider: "bounded-repair-coaching", tokensPerSecond: 10_000 });
  const initialPrompts = [];
  const coachingPrompts = [];
  provider.setResponses([
    async (context) => {
      const latestUser = [...context.messages].reverse().find((message) => message.role === "user");
      const userText = typeof latestUser?.content === "string"
        ? latestUser.content
        : (latestUser?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      initialPrompts.push(userText);
      return fauxAssistantMessage(
        fauxToolCall("readAssignedSource", {}, { id: "repair-read" }),
        { stopReason: "toolUse" }
      );
    },
    fauxAssistantMessage(fauxToolCall(
      "repairAssignedTranslation",
      translationEntries(["错误范围"], 2),
      { id: "repair-invalid-write" }
    ), { stopReason: "toolUse" }),
    fauxAssistantMessage(
      fauxToolCall("readProjectFile", { path: "source.txt" }, { id: "repair-followup-read" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("宿主拒绝了第一次写入。")),
    async (context) => {
      const latestUser = [...context.messages].reverse().find((message) => message.role === "user");
      const userText = typeof latestUser?.content === "string"
        ? latestUser.content
        : (latestUser?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      coachingPrompts.push(userText);
      return fauxAssistantMessage(fauxToolCall(
        "repairAssignedTranslation",
        translationEntries(["正确译文"], 1),
        { id: "repair-corrected-write" }
      ), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(
      fauxToolCall("validateAssignedTranslation", {
        misalignedLines: []
      }, { id: "repair-validate" }),
      { stopReason: "toolUse" }
    )
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-bounded-repair-coaching-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "source line\n", "utf8");
  await mkdir(path.join(outputDir, "AI_translation"), { recursive: true });
  await writeFile(
    path.join(outputDir, "AI_translation", "source_translated.txt"),
    "旧译文\n",
    "utf8"
  );
  try {
    const result = await subagentRunner.runPiTranslationSubagent({
      request: {
        outputDir,
        sourcePath,
        sessionId: "pi_bounded_repair_coaching",
        prompt: "repair one translated line",
        providerId: provider.provider.id,
        modelId: provider.getModel().id,
        languagePair: "en->zh-CN"
      },
      task: {
        documentId: "source.txt",
        fromLine: 1,
        toLine: 1,
        instruction: "修复已经定位的第 1 行。"
      },
      executionMode: "bounded_repair",
      publishCustomMessage: async () => {},
      createModelSelection: async () => ({
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      })
    });
    assert.equal(result.fromLine, 1);
    assert.equal(result.toLine, 1);
    assert.match(initialPrompts.at(0) ?? "", /FIRST TOOL: call readAssignedSource/i);
    assert.match(initialPrompts.at(0) ?? "", /canonical projectReferences paths/i);
    assert.match(initialPrompts.at(0) ?? "", /available:false means the asset does not exist and must not be probed/i);
    assert.match(
      coachingPrompts.at(-1) ?? "",
      /Latest host tool rejection: Validation failed[\s\S]*entries\.0\.line: must be <= 1/i
    );
    assert.match(coachingPrompts.at(-1) ?? "", /still write-capable/i);
    const translated = await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8");
    assert.equal(translated.trim(), "正确译文");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
