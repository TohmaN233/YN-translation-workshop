import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { serializeCharacterBibleMarkdown } from "../../src/main/agent/projectAssets.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-checkpoint-scale-"));
try {
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 20000 }, (_, i) => `キャラ${i % 164}「こんにちは {name}」`);
  const candidateLines = sourceLines.map(() => "");
  for (let i = 500; i < 1000; i++) candidateLines[i] = "角色「你好 {name}」";
  candidateLines[700] = "角色「你好」";
  await writeFile(sourcePath, sourceLines.join("\n") + "\n");
  const workspace = path.join(outputDir, "AI_translation", "_workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "character_bible.md"), serializeCharacterBibleMarkdown(
    Array.from({ length: 164 }, (_, i) => ({ name: `キャラ${i}`, target: `角色${i}` }))));
  let batchOptions;
  const state = createTranslationAlignmentHostState();
  const tools = createYnDomainTools({
    request: { outputDir, sourcePath, sessionId: "scale", prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation", languagePair: "ja->zh-CN", splitSize: 500,
      subagentEnabled: true, subagentCount: 1, glossaryCandidates: false, characterBible: false },
    publishCustomMessage: async () => {},
    subagents: { hasRunning: () => false, startTranslationBatch(options) {
      batchOptions = options;
      return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] };
    } },
    domainRun: createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true,
      subagentEnabled: true, subagentCount: 1 }),
    translationAlignmentState: state,
    persistHostState: async () => {}
  });
  const tool = name => tools.find(t => t.name === name);
  await tool("inspectTranslationContext").execute("inspect", {});
  await tool("runTranslationSubagents").execute("run", {});
  const candidatePath = path.join(outputDir, ".translation-workshop", "agent", "translation-staging", "scale", "chunk.txt");
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(candidatePath, candidateLines.join("\n") + "\n");
  let maxDelay = 0, previous = performance.now();
  const heartbeat = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous); previous = now; }, 10);
  const started = performance.now();
  try {
    await batchOptions.onStagingCandidateCheckpoint({ documentId: "source.txt", fromLine: 501, toLine: 1000,
      candidatePath, terminologyRepairLines: [], accepted: false, requiredLines: [701],
      repairIssues: [{ absoluteLine: 701, code: "placeholder_mismatch", severity: "blocking", detail: "Preserve {name}." }] });
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { clearInterval(heartbeat); }
  assert.ok(maxDelay < 1000, `chunk checkpoint blocked the main event loop for ${maxDelay.toFixed(0)} ms`);
  const scope = state.ranges["source.txt"][0];
  assert.equal(scope.sourceLineCount, 20000);
  assert.ok(scope.checks.every(check => check.line >= 501 && check.line <= 1000));
  const failed = scope.checks.find(check => check.line === 701);
  assert.ok(failed.signals.includes("blocking:placeholder_mismatch"), "chunk-local findings must use absolute source line numbers");
  assert.equal(failed.verdict, "misaligned");
  await assert.rejects(tool("writeTranslationChunk").execute("invalid-parent-write", {
    fromLine: 701, toLine: 701, lines: ["丢失了占位符的译文。"]
  }), /第 701 行占位符不一致/, "parent write failures must also identify absolute rows");
  const journal = (await readFile(path.join(outputDir, ".translation-workshop", "agent", "validation", "events.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  assert.ok(journal.some(event => event.event === "completed" && event.sourceLineCount === 500 && event.candidateLineCount === 500),
    "the actual Host checkpoint must validate 500 rows, not the full staging skeleton");
  assert.equal(await readFile(candidatePath, "utf8"), candidateLines.join("\n") + "\n");
  console.log(JSON.stringify({ checkpointRegression: true, elapsedMs: performance.now() - started, maxDelay }));
} finally { await rm(outputDir, { recursive: true, force: true }); }
