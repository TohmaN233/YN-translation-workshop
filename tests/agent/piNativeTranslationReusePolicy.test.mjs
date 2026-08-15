import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveTranslationCandidatePath,
  withTranslationCandidateLock,
  writeTranslationChunk
} from "../../src/main/agent/writeTranslationChunk.ts";
import { discardTranslationCandidateForRetranslation } from "../../src/main/agent/piNative/translationReuseAudit.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";

async function fixture(reuseExistingTranslation, fullWorkflow = true) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-policy-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt"
  });
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, "Open the gate.\nSave now.\n", "utf8");
  await writeFile(candidatePath, "旧译文一。\n旧译文二。\n", "utf8");
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: false,
    fullWorkflow
  });
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {} });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: `reuse-policy-${reuseExistingTranslation}`,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "en->zh-CN",
      subagentEnabled: false,
      reuseExistingTranslation
    },
    publishCustomMessage: async () => {},
    subagents: supervisor,
    domainRun
  });
  const tool = (name) => {
    const found = tools.find((entry) => entry.name === name);
    assert.ok(found, `missing ${name}`);
    return found;
  };
  await tool("inspectTranslationContext").execute("inspect", {});
  return { outputDir, candidatePath, supervisor, tool };
}

{
  const work = await fixture(true, false);
  try {
    await assert.rejects(
      work.tool("prepareTranslationReuseAudit").execute("prepare-local", {}),
      /requires the exact generated translation workflow contract/i
    );
  } finally {
    work.supervisor.abortAll();
    await work.supervisor.waitForAll();
    await rm(work.outputDir, { recursive: true, force: true });
  }
}

{
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-corrupt-backup-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  const candidateText = "旧译文一。\n旧译文二。\n";
  const hash = createHash("sha256").update(candidateText).digest("hex");
  const backupPath = path.join(outputDir, ".translation-workshop", "translation-reuse-backups", `${hash}.txt`);
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(sourcePath, "Open the gate.\nSave now.\n", "utf8");
  await writeFile(candidatePath, candidateText, "utf8");
  await writeFile(backupPath, "corrupt backup", "utf8");
  try {
    await assert.rejects(
      discardTranslationCandidateForRetranslation({ outputDir, sourcePath, candidatePath, documentId: "source.txt" }),
      /backup.*hash|integrity/i
    );
    assert.equal(await readFile(candidatePath, "utf8"), candidateText);
    assert.equal(await readFile(backupPath, "utf8"), "corrupt backup");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

{
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-concurrent-write-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, "Open the gate.\nSave now.\n", "utf8");
  await writeFile(candidatePath, "旧译文一。\n旧译文二。\n", "utf8");
  let releaseLock;
  const lockHeld = new Promise((resolve) => { releaseLock = resolve; });
  let lockAcquired;
  const acquired = new Promise((resolve) => { lockAcquired = resolve; });
  const blocker = withTranslationCandidateLock(candidatePath, async () => {
    lockAcquired();
    await lockHeld;
  });
  await acquired;
  let cleanupSettled = false;
  const cleanup = discardTranslationCandidateForRetranslation({
    outputDir,
    sourcePath,
    candidatePath,
    documentId: "source.txt"
  }).finally(() => { cleanupSettled = true; });
  const writer = writeTranslationChunk({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt",
    fromLine: 1,
    toLine: 2,
    lines: ["打开大门。", "现在保存。"]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cleanupSettled, false, "candidate cleanup must share the translation writer lock");
  releaseLock();
  try {
    await blocker;
    await cleanup;
    await writer;
    assert.equal(await readFile(candidatePath, "utf8"), "打开大门。\n现在保存。\n");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

{
  const work = await fixture(false);
  try {
    await assert.rejects(
      work.tool("prepareTranslationReuseAudit").execute("prepare-disabled", {}),
      /reuse audit is disabled/i
    );
    await work.tool("writeTranslationChunk").execute("write", {
      fromLine: 1,
      toLine: 1,
      lines: ["打开大门。"]
    });
    assert.equal(await readFile(work.candidatePath, "utf8"), "打开大门。\n\n");
    await work.tool("writeTranslationChunk").execute("write-next", {
      fromLine: 2,
      toLine: 2,
      lines: ["现在保存。"]
    });
    assert.equal(
      await readFile(work.candidatePath, "utf8"),
      "打开大门。\n现在保存。\n",
      "clean retranslation may discard startup work only once and must preserve current-run writes"
    );
    const backups = await readdir(path.join(work.outputDir, ".translation-workshop", "translation-reuse-backups"));
    assert.equal(backups.length, 1);
    assert.equal(
      await readFile(path.join(work.outputDir, ".translation-workshop", "translation-reuse-backups", backups[0]), "utf8"),
      "旧译文一。\n旧译文二。\n"
    );
  } finally {
    work.supervisor.abortAll();
    await work.supervisor.waitForAll();
    await rm(work.outputDir, { recursive: true, force: true });
  }
}

{
  const work = await fixture(true);
  try {
    await assert.rejects(
      work.tool("writeTranslationChunk").execute("write", {
        fromLine: 1,
        toLine: 1,
        lines: ["打开大门。"]
      }),
      /has not been audited/i
    );
    assert.equal(await readFile(work.candidatePath, "utf8"), "旧译文一。\n旧译文二。\n");
  } finally {
    work.supervisor.abortAll();
    await work.supervisor.waitForAll();
    await rm(work.outputDir, { recursive: true, force: true });
  }
}

{
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-worker-policy-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const candidatePath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(sourcePath, "Open the gate.\nSave now.\n", "utf8");
  await writeFile(candidatePath, "旧译文一。\n旧译文二。\n", "utf8");
  let workerStarted = false;
  const subagents = {
    hasRunning: () => false,
    startTranslationBatch: () => {
      workerStarted = true;
      assert.equal(existsSync(candidatePath), false, "workers must not inherit stale candidate lines");
      return { status: "running", id: "direct-retranslation", subagents: [] };
    }
  };
  const domainRun = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 2,
    fullWorkflow: true
  });
  const tools = createYnDomainTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "reuse-worker-policy",
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "en->zh-CN",
      subagentEnabled: true,
      subagentCount: 2,
      reuseExistingTranslation: false
    },
    publishCustomMessage: async () => {},
    subagents,
    domainRun
  });
  const tool = (name) => tools.find((entry) => entry.name === name);
  try {
    await tool("inspectTranslationContext").execute("inspect-worker", {});
    await tool("runTranslationSubagents").execute("start-worker", {
      tasks: [{ fromLine: 1, toLine: 2 }]
    });
    assert.equal(workerStarted, true);
    assert.equal(existsSync(candidatePath), false);
    assert.equal((await readdir(path.join(outputDir, ".translation-workshop", "translation-reuse-backups"))).length, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

console.log("ok translation reuse is an explicit project policy and defaults to safe direct retranslation");
