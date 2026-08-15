import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";

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

async function suspendedFixture({
  workflowIntent = "translation",
  sourceText = "こんにちは\nさようなら\nありがとう\n",
  candidateText
} = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-suspended-operation-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, sourceText, "utf8");

  const request = {
    outputDir,
    sourcePath,
    sessionId: `pi_suspended_${workflowIntent}`,
    prompt: workflowIntent === "proofread"
      ? "Workflow: yn-proofread-v1."
      : "Workflow: yn-translation-v1.",
    workflowIntent,
    providerId: "test",
    modelId: "test",
    languagePair: "ja->zh-CN",
    subagentEnabled: true,
    subagentCount: 2,
    reviewSubagentCount: 2
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent,
    fullWorkflow: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  domainRun.suspend();

  let hostSuspended = true;
  let resumeCalls = 0;
  const publishCustomMessage = async () => {};
  const subagents = new YnSubagentSupervisor({ publishCustomMessage });
  const tools = createYnDomainTools({
    request,
    domainRun,
    subagents,
    publishCustomMessage,
    isWorkflowSuspended: () => hostSuspended,
    async resumeWorkflow() {
      resumeCalls += 1;
      domainRun.resume();
      hostSuspended = false;
    }
  });
  const candidatePath = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt"
  });
  if (candidateText !== undefined) {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, candidateText, "utf8");
  }

  return {
    outputDir,
    sourcePath,
    candidatePath,
    request,
    domainRun,
    get resumeCalls() {
      return resumeCalls;
    },
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

await test("suspended full workflow permits inspect-only context without resuming its queue", async () => {
  const fx = await suspendedFixture();
  try {
    const result = await execute(fx.tool("inspectTranslationContext"), {});

    assert.equal(result.details.sourceLineCount, 3);
    assert.equal(fx.domainRun.suspended, true);
    assert.equal(fx.resumeCalls, 0);
  } finally {
    await fx.close();
  }
});

await test("a fresh bounded operation repairs exact rows while the old full workflow remains parked", async () => {
  const fx = await suspendedFixture({ candidateText: "你好\n再会\n谢谢\n" });
  const parkedSnapshot = fx.domainRun.snapshot();
  const localRun = createYnDomainRunContract({
    workflowIntent: "translation",
    fullWorkflow: false,
    subagentEnabled: true,
    subagentCount: 2
  });
  const localSubagents = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
  const localTools = createYnDomainTools({
    request: {
      ...fx.request,
      prompt: "只修复 source.txt 第 2 行。",
      workflowIntent: undefined
    },
    domainRun: localRun,
    subagents: localSubagents,
    publishCustomMessage: async () => {}
  });
  const localTool = (name) => {
    const value = localTools.find((entry) => entry.name === name);
    assert.ok(value, `missing local tool ${name}`);
    return value;
  };
  try {
    const write = await execute(localTool("writeTranslationChunk"), {
      fromLine: 2,
      toLine: 2,
      lines: ["再见"]
    });
    assert.equal(write.details.validation.accepted, true);

    const audit = await execute(localTool("inspectTranslationAlignment"));
    assert.equal(audit.details.bounded, true);
    assert.ok(audit.details.pendingLines.includes(2));
    await execute(localTool("readSourceLines"), {
      fromLine: audit.details.fromLine,
      toLine: audit.details.toLine
    });
    await execute(localTool("readTranslationLines"), {
      fromLine: audit.details.fromLine,
      toLine: audit.details.toLine
    });
    await execute(localTool("recordTranslationAlignmentChecks"), {
      auditId: audit.details.auditId,
      failures: []
    });

    const validation = await execute(localTool("validateTranslationArtifact"));
    assert.equal(validation.details.validation.accepted, true);
    assert.equal(await readFile(fx.candidatePath, "utf8"), "你好\n再见\n谢谢\n");
    assert.equal(fx.domainRun.suspended, true);
    assert.deepEqual(fx.domainRun.snapshot(), parkedSnapshot, "the local operation must not mutate the parked full-workflow contract");
    assert.equal(fx.resumeCalls, 0);
  } finally {
    localSubagents.abortAll();
    await localSubagents.waitForAll();
    await fx.close();
  }
});

await test("suspended full translation and proofread mutations require explicit resume", async () => {
  for (const workflowIntent of ["translation", "proofread"]) {
    const fx = await suspendedFixture({
      workflowIntent,
      candidateText: "你好\n再见\n谢谢\n"
    });
    try {
      const parkedBefore = fx.domainRun.snapshot();
      const readOnlyInspection = await execute(fx.tool("inspectTranslationContext"), {});
      assert.equal(readOnlyInspection.details.sourceLineCount, 3);
      assert.deepEqual(fx.domainRun.snapshot(), parkedBefore, "read-only inspection must not resume or mutate parked workflow state");
      await assert.rejects(
        execute(fx.tool(workflowIntent === "translation" ? "runTranslationSubagents" : "runProofreadSubagents")),
        /suspended.*resumeYnWorkflow/i
      );
      assert.equal(fx.domainRun.suspended, true);
      assert.equal(fx.resumeCalls, 0);

      const resumed = await execute(fx.tool("resumeYnWorkflow"));
      assert.equal(resumed.details.resumed, true);
      assert.equal(fx.domainRun.suspended, false);
      assert.equal(fx.resumeCalls, 1);

      const inspection = await execute(fx.tool("inspectTranslationContext"), {});
      assert.equal(inspection.details.sourceLineCount, 3);
    } finally {
      await fx.close();
    }
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
