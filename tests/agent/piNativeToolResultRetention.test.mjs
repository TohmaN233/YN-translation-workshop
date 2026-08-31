import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPiProofreadSubagentTools, createPiTranslationSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

if (!global.gc) {
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", ...process.argv.slice(1)],
    { stdio: "inherit", windowsHide: true });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-result-retention-"));
const request = { outputDir, sourcePath: path.join(outputDir, "source.txt"),
  translationPath: path.join(outputDir, "translation.txt"), sessionId: "retention-parent",
  prompt: "inspect", providerId: "test", modelId: "test", glossaryCandidates: false };
const sourceRow = (i) => `source-${i}: ${"\u539f\u6587".repeat(32)}`;
const targetRow = (i) => `target-${i}: ${"\u8bd1\u6587".repeat(32)}`;
const publishCustomMessage = async () => {};
const iterations = 12;
const failures = [];

async function lane(name, makeCall, verify, maxRetainedMiB = 32) {
  const session = await new PiSessionRepository(outputDir).createChild(name, request.sessionId);
  const call = await makeCall();
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) {
    const result = await call(i);
    await session.appendMessage({ role: "toolResult", toolCallId: `${name}-${i}`, toolName: name,
      ...result, isError: false, timestamp: Date.now() });
  }
  global.gc();
  const retainedMiB = (process.memoryUsage().heapUsed - baseline) / 1024 ** 2;
  // Keep the real Pi history reachable during measurement, as persistent workers do.
  const messages = (await session.buildContext()).messages;
  assert.equal(messages.length, iterations);
  await verify?.(messages);
  console.log(`${name}: ${retainedMiB.toFixed(1)} MiB retained for ${iterations} small results`);
  if (retainedMiB >= maxRetainedMiB) failures.push(`${name}: retained ${retainedMiB.toFixed(1)} MiB of full-file backing strings`);
}

try {
  await writeFile(request.sourcePath, Array.from({ length: 60_000 }, (_, i) => sourceRow(i)).join("\n"));
  await writeFile(request.translationPath, Array.from({ length: 60_000 }, (_, i) => targetRow(i)).join("\n"));
  await lane("proofread-context", async () => async (i) => {
    const progress = { referenceRead: false, findingsWritten: false, findingsCount: 0, glossaryCandidates: [] };
    const tools = createPiProofreadSubagentTools({ request, publishCustomMessage,
      task: { documentId: "source.txt", fromLine: i * 500 + 1, toLine: (i + 1) * 500 } }, "retention-child", progress);
    const result = await tools.find(t => t.name === "readAssignedProofreadContext").execute(`read-${i}`, {});
    assert.equal(result.details.assignedLines.length, 500);
    assert.equal(result.details.assignedLines[0].source, sourceRow(i * 500));
    assert.equal(result.details.assignedLines[0].translation, targetRow(i * 500));
    assert.equal(result.details.totalLines, 60_000);
    assert.equal(result.details.nextFromLine, undefined);
    const written = await tools.find(t => t.name === "writeAssignedFindings").execute(`write-${i}`, {
      findings: [{ id: `L1-${i + 1}`, type: "wording", sourceLine: i * 500 + 1,
        suggestedFix: `fixed-${i}`, rationale: "Fixture correction." }]
    });
    assert.equal(written.details.ok, true);
    assert.equal(written.terminate, true);
    return result;
  }, async () => {
    const report = JSON.parse(await readFile(path.join(outputDir, "report/source.proofread.json"), "utf8"));
    assert.equal(report.findings.length, iterations);
    assert.equal(report.findings[0].sourceText, sourceRow(0));
    assert.equal(report.findings[0].currentTranslation, targetRow(0));
  });
  await lane("translation-context", async () => {
    const tools = createPiTranslationSubagentTools({ request, publishCustomMessage,
      workingCandidatePath: request.translationPath, task: { documentId: "source.txt", fromLine: 1, toLine: 500 } });
    return (i) => tools.find(t => t.name === "readTranslationContext").execute(`read-${i}`, { fromLine: i + 1, toLine: i + 2 });
  }, messages => assert.equal(messages[0].details.rows[0].source, sourceRow(0)));
  await lane("parent-source", async () => {
    const tools = createYnDomainTools({ request, publishCustomMessage });
    return (i) => tools.find(t => t.name === "readSourceLines").execute(`read-${i}`, { fromLine: i + 1, toLine: i + 2 });
  }, messages => assert.equal(messages[0].details.lines[0], sourceRow(0)));
  await lane("parent-file-page", async () => {
    const tools = createYnDomainTools({ request, publishCustomMessage });
    return (i) => tools.find(t => t.name === "readProjectFile").execute(`read-${i}`, { path: request.sourcePath, offsetChars: i * 100, maxChars: 100 });
  });
  await lane("proofread-search-cache", async () => {
    const searchPath = path.join(outputDir, "reference.txt");
    await writeFile(searchPath, Array.from({ length: 8_000 }, (_, i) => sourceRow(i)).join("\n"));
    const cache = new Map();
    const tools = createPiProofreadSubagentTools({ request, publishCustomMessage, proofreadSearchCache: cache,
      task: { documentId: "source.txt", fromLine: 1, toLine: 500 } }, "search-child",
      { referenceRead: false, findingsWritten: false, findingsCount: 0, glossaryCandidates: [] });
    return async (i) => {
      const args = { query: `source-${i}:`, path: searchPath, maxResults: 1 };
      const tool = tools.find(t => t.name === "searchProjectText");
      const fresh = await tool.execute(`search-${i}`, args);
      const cached = await tool.execute(`cached-${i}`, args);
      assert.equal(fresh.details.cacheHit, false);
      assert.equal(cached.details.cacheHit, true);
      assert.equal(fresh.details.matches.length, 1);
      assert.equal(fresh.details.matches[0].text, sourceRow(i));
      assert.deepEqual(cached.details.matches, fresh.details.matches);
      return cached;
    };
  }, undefined, 8);
  assert.deepEqual(failures, [], "Small tool results and cached searches must not retain full input buffers");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
