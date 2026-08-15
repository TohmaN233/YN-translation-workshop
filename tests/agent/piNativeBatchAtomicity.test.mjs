import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";

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

async function fixture({ domainRun, subagents, requestPatch = {} }, sourceText = "source one\nsource two\n") {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-batch-atomicity-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, sourceText, "utf8");
  const request = {
    outputDir,
    sourcePath,
    sessionId: "pi_batch_atomicity",
    prompt: "translate",
    providerId: "test",
    modelId: "test",
    languagePair: "en->zh-CN",
    ...requestPatch
  };
  const tools = createYnDomainTools({
    request,
    domainRun,
    subagents,
    publishCustomMessage: async () => {}
  });
  return {
    outputDir,
    sourcePath,
    tool(name) {
      const value = tools.find((entry) => entry.name === name);
      assert.ok(value, `missing tool ${name}`);
      return value;
    },
    async close() {
      await rm(outputDir, { recursive: true, force: true });
    }
  };
}

async function execute(tool, params = {}) {
  return tool.execute(`call_${tool.name}`, params);
}

function runningBatch(id, count = 1) {
  return {
    id,
    status: "running",
    subagents: Array.from({ length: count }, (_, index) => ({
      id: `${id}_child_${index + 1}`,
      label: `${id} child ${index + 1}`,
      status: "running"
    }))
  };
}

await test("runTranslationSubagents rejects an active Host batch before launching another supervisor child", async () => {
  let launches = 0;
  const subagents = {
    hasRunning: () => launches > 0,
    startTranslationBatch() {
      launches += 1;
      return runningBatch(`translation_${launches}`);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.\nTranslate the bound source.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  const params = { tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 2 }] };
  try {
    await execute(fx.tool("runTranslationSubagents"), params);
    await assert.rejects(
      () => execute(fx.tool("runTranslationSubagents"), params),
      /still current|settle/i
    );
    assert.equal(launches, 1, "Host rejection must happen before a second translation child launch");
  } finally {
    await fx.close();
  }
});

await test("runProofreadSubagents rejects an active Host batch before launching another supervisor child", async () => {
  let launches = 0;
  const subagents = {
    hasRunning: () => launches > 0,
    startProofreadBatch() {
      launches += 1;
      return runningBatch(`proofread_${launches}`);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1,
    proofreadMode: "split"
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.\nProofread the bound translation.",
      workflowIntent: "proofread",
      proofreadMode: "split",
      proofreadSplitSize: 1000,
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  try {
    const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "译文一\n译文二\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("runProofreadSubagents"), { workerCount: 1 });
    await assert.rejects(
      () => execute(fx.tool("runProofreadSubagents"), { workerCount: 1 }),
      /still current|settle/i
    );
    assert.equal(launches, 1, "Host rejection must happen before a second proofread child launch");
  } finally {
    await fx.close();
  }
});

await test("runSubagents rejects an active Host batch before launching another supervisor child", async () => {
  let launches = 0;
  const subagents = {
    hasRunning: () => launches > 0,
    startGeneralBatch() {
      launches += 1;
      return runningBatch(`general_${launches}`);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Inspect the first source line.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  const params = {
    tasks: [{
      label: "inspect line one",
      prompt: "Inspect line one without changing files.",
      mode: "investigate",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1
    }]
  };
  try {
    await execute(fx.tool("runSubagents"), params);
    await assert.rejects(
      () => execute(fx.tool("runSubagents"), params),
      /still running|settle/i
    );
    assert.equal(launches, 1, "Host rejection must happen before a second general child launch");
  } finally {
    await fx.close();
  }
});

await test("runSubagents reserves full-workflow general batches before launching children", async () => {
  let launches = 0;
  let reservedBatchId;
  const subagents = {
    startGeneralBatch(options) {
      launches += 1;
      reservedBatchId ??= options.batchId;
      assert.equal(options.batchId, reservedBatchId, "the supervisor must receive the Host-reserved batch id");
      return runningBatch(options.batchId);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.\nInspect the first source line.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  const params = {
    tasks: [{
      label: "inspect line one",
      prompt: "Inspect line one without changing files.",
      mode: "investigate",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1
    }]
  };
  try {
    const first = await execute(fx.tool("runSubagents"), params);
    assert.equal(first.details.batchId, reservedBatchId);
    await assert.rejects(
      () => execute(fx.tool("runSubagents"), params),
      /still running|settle/i
    );
    assert.equal(launches, 1, "a duplicate full-workflow general batch must fail before child launch");
  } finally {
    await fx.close();
  }
});

await test("a failed translation supervisor start rolls back the Host reservation before retry", async () => {
  let launches = 0;
  const subagents = {
    startTranslationBatch() {
      launches += 1;
      if (launches === 1) throw new Error("synthetic translation launch failure");
      return runningBatch("translation_retry");
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  const params = { tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 2 }] };
  try {
    await assert.rejects(() => execute(fx.tool("runTranslationSubagents"), params), /synthetic translation/);
    const retry = await execute(fx.tool("runTranslationSubagents"), params);
    assert.equal(retry.details.batchId, "translation_retry");
    assert.equal(launches, 2);
  } finally {
    await fx.close();
  }
});

await test("a failed proofread supervisor start rolls back the Host reservation before retry", async () => {
  let launches = 0;
  const subagents = {
    startProofreadBatch() {
      launches += 1;
      if (launches === 1) throw new Error("synthetic proofread launch failure");
      return runningBatch("proofread_retry");
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "proofread",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1,
    proofreadMode: "split"
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      proofreadMode: "split",
      proofreadSplitSize: 1000,
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  try {
    const translationPath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "译文一\n译文二\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await assert.rejects(
      () => execute(fx.tool("runProofreadSubagents"), { workerCount: 1 }),
      /synthetic proofread/
    );
    const retry = await execute(fx.tool("runProofreadSubagents"), { workerCount: 1 });
    assert.equal(retry.details.batchId, "proofread_retry");
    assert.equal(launches, 2);
  } finally {
    await fx.close();
  }
});

await test("a failed bounded supervisor start rolls back the local Host reservation before retry", async () => {
  let launches = 0;
  const subagents = {
    startGeneralBatch() {
      launches += 1;
      if (launches === 1) throw new Error("synthetic bounded launch failure");
      return runningBatch("bounded_retry");
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  const params = {
    tasks: [{
      label: "inspect line one",
      prompt: "Inspect line one.",
      mode: "investigate",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1
    }]
  };
  try {
    await assert.rejects(() => execute(fx.tool("runSubagents"), params), /synthetic bounded/);
    const retry = await execute(fx.tool("runSubagents"), params);
    assert.equal(retry.details.batchId, "bounded_retry");
    assert.equal(launches, 2);
  } finally {
    await fx.close();
  }
});

await test("a failed full-workflow general supervisor start rolls back the Host reservation before retry", async () => {
  let launches = 0;
  const subagents = {
    startGeneralBatch(options) {
      launches += 1;
      if (launches === 1) throw new Error("synthetic full-workflow general launch failure");
      return runningBatch(options.batchId);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.\nInspect the first source line.",
      workflowIntent: "translation",
      subagentEnabled: true,
      subagentCount: 1
    }
  });
  const params = {
    tasks: [{
      label: "inspect line one",
      prompt: "Inspect line one without changing files.",
      mode: "investigate",
      documentId: "source.txt",
      fromLine: 1,
      toLine: 1
    }]
  };
  try {
    await assert.rejects(() => execute(fx.tool("runSubagents"), params), /synthetic full-workflow general/);
    const retry = await execute(fx.tool("runSubagents"), params);
    assert.equal(retry.details.batchId.startsWith("batch_"), true);
    assert.equal(launches, 2);
  } finally {
    await fx.close();
  }
});

await test("runTranslationReuseAudit reserves its general batch before launching audit workers", async () => {
  let launches = 0;
  let reservedBatchId;
  const subagents = {
    startGeneralBatch(options) {
      launches += 1;
      reservedBatchId ??= options.batchId;
      assert.equal(options.batchId, reservedBatchId, "reuse audit workers must receive the Host-reserved batch id");
      return runningBatch(options.batchId);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 1
    }
  }, "Open the gate.\nSave now.\n");
  try {
    const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, "Open the gate.\n现在保存。\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("prepareTranslationReuseAudit"));

    const first = await execute(fx.tool("runTranslationReuseAudit"));
    assert.equal(first.details.batchId, reservedBatchId);
    await assert.rejects(
      () => execute(fx.tool("runTranslationReuseAudit")),
      /still running|settle/i
    );
    assert.equal(launches, 1, "a duplicate reuse-audit batch must fail before child launch");
  } finally {
    await fx.close();
  }
});

await test("a failed translation reuse audit supervisor start rolls back the Host reservation before retry", async () => {
  let launches = 0;
  const subagents = {
    startGeneralBatch(options) {
      launches += 1;
      if (launches === 1) throw new Error("synthetic reuse audit launch failure");
      return runningBatch(options.batchId);
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 1
  });
  const fx = await fixture({
    domainRun,
    subagents,
    requestPatch: {
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 1
    }
  }, "Open the gate.\nSave now.\n");
  try {
    const candidatePath = path.join(fx.outputDir, "AI_translation", "source_translated.txt");
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, "Open the gate.\n现在保存。\n", "utf8");
    await execute(fx.tool("inspectTranslationContext"), {});
    await execute(fx.tool("prepareTranslationReuseAudit"));

    await assert.rejects(
      () => execute(fx.tool("runTranslationReuseAudit")),
      /synthetic reuse audit/
    );
    const retry = await execute(fx.tool("runTranslationReuseAudit"));
    assert.equal(retry.details.batchId.startsWith("batch_"), true);
    assert.equal(launches, 2);
  } finally {
    await fx.close();
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
