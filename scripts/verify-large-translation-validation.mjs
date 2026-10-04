import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createYnDomainTools } from "../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState, createTranslationChunkReviewAudit } from "../src/main/agent/piNative/translationAlignmentState.ts";
import { resolveTranslationCandidatePath } from "../src/main/agent/writeTranslationChunk.ts";
import { YnSubagentSupervisor } from "../src/main/agent/piNative/subagentSupervisor.ts";
import { PiSessionRepository } from "../src/main/agent/piNative/sessionRepository.ts";
import { runTranslationValidation } from "../src/main/agent/piNative/translationValidationService.ts";
import { createYnTranslationValidationOptions } from "../src/main/agent/piNative/translationValidationContext.ts";
import { extractCodeMarkup, splitTextLines } from "../src/shared/validation/translationValidator.ts";

// Deterministic test text, not a translation. Keep all actual protected tokens and replace prose.
function fixtureTranslation(source) {
  const protectedSpans = [...extractCodeMarkup(source), ...(source.match(/\{[A-Za-z_][A-Za-z0-9_]*\}|%[sd]|%[0-9]+\$[sd]|\$\{[^}]+\}|\$[0-9]+|\\[A-Za-z]+(?:\[[^\]\r\n]*\])?|\\[{}.!|><^\\]|\bID\s*[:=]\s*[A-Za-z0-9_.-]+/gi) ?? [])]
    .sort((a, b) => b.length - a.length);
  const saved = [];
  let text = source;
  for (const span of protectedSpans) {
    if (!text.includes(span)) continue;
    const marker = `YNPROTECTED${saved.length}END`;
    saved.push([marker, span]);
    text = text.split(span).join(marker);
  }
  text = "离线验收" + text.replace(/[\u3040-\u30ff\u3400-\u9fff]/g, char => String.fromCharCode(0x4e00 + char.charCodeAt(0) % 19000));
  for (const [marker, span] of saved) text = text.split(marker).join(span);
  return text;
}

export async function verifyLargeTranslationValidation({ sourcePath = "G:/Baiduyun/tp-megido-main/data/japanese_text_unique.txt",
  projectDir = "G:/Baiduyun/tp-megido-main", observeUi = async () => {}, chunks = 12, recovery = false } = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-large-validation-"));
  let supervisor;
  const records = [];
  let firstRuntimeMemory;
  const peakMemory = { rss: 0, heapUsed: 0 };
  const observeMemory = () => {
    const memory = process.memoryUsage();
    peakMemory.rss = Math.max(peakMemory.rss, memory.rss);
    peakMemory.heapUsed = Math.max(peakMemory.heapUsed, memory.heapUsed);
    return memory;
  };
  let maximumChildCardBytes = 0;
  const trackCard = async message => { maximumChildCardBytes = Math.max(maximumChildCardBytes, Buffer.byteLength(JSON.stringify(message))); };
  let heartbeat, maxMainDelay = 0, previous = performance.now();
  try {
    const sourceText = await readFile(sourcePath, "utf8");
    const sourceLines = splitTextLines(sourceText);
    assert.ok(sourceText.length > 10_000_000 && sourceLines.length > 500000);
    const settings = JSON.parse(await readFile(path.join(projectDir, ".translation-workshop", "project.json"), "utf8"));
    const workspace = path.join(outputDir, "AI_translation", "_workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "character_bible.md"),
      await readFile(path.join(projectDir, "AI_translation", "_workspace", "character_bible.md"), "utf8"));
    const request = { outputDir, sourcePath, sourceDocumentId: path.basename(sourcePath), sessionId: "large-validation",
      prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", languagePair: settings.languagePair,
      glossaryPath: settings.glossaryPath, splitSize: 500, subagentCount: 5, subagentEnabled: true,
      glossaryCandidates: false, characterBible: false, providerId: "offline-validation" };
    const state = createTranslationAlignmentHostState();
    const canonicalPath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: path.basename(sourcePath) });
    let acceptedRecoveryScope;
    let recoveryProviderCalls = 0;
    let recoveryRuntimeLaunches = 0;
    let releaseRecoveryCalls;
    const recoveryCallsReady = new Promise(resolve => { releaseRecoveryCalls = resolve; });
    const recoveryLines = new Set();
    await new PiSessionRepository(outputDir).create(request.sessionId);
    const provider = fauxProvider({ provider: "offline-validation", tokensPerSecond: 100_000_000 });
    const models = createModels(); models.setProvider(provider.provider);
    provider.setResponses(Array.from({ length: chunks * 12 }, () => async context => {
      const last = context.messages.findLast(message => message.role === "toolResult");
      let name, args = {};
      if (last?.isError) throw new Error(`Offline fixture tool failed: ${JSON.stringify(last.content).slice(0, 1000)}`);
      const promptText = context.messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      if (recovery && !last && promptText.includes("Owned chunk:") && recoveryProviderCalls < 5) {
        assert.equal(state.ranges[path.basename(sourcePath)].filter(scope => scope.candidatePath !== canonicalPath).length, 5,
          "all five recovery bindings must exist before any provider request");
        recoveryProviderCalls += 1;
        if (recoveryProviderCalls === 5) releaseRecoveryCalls();
        await Promise.race([recoveryCallsReady, new Promise((_, reject) => setTimeout(() => reject(new Error("five large-file recovery workers did not enter provider concurrently")), 30000))]);
      }
      if (last?.toolName === "readAssignedSource") {
        const details = last.details ?? JSON.parse(last.content[0].text);
        const requiredRepairLines = details.selectedLines ?? details.sourceBlocks.flatMap(block => block.absoluteLines).filter(line => recoveryLines.has(line));
        if (requiredRepairLines.length) {
          name = "repairAssignedTranslation";
          args = { entries: requiredRepairLines.map(line => ({ line, translation: "修复" + fixtureTranslation(sourceLines[line - 1]) })) };
        } else {
          name = "writeAssignedTranslation";
          args = { blocks: details.sourceBlocks.map(block => ({ id: block.id,
            lines: block.lines.map(line => line[0] + fixtureTranslation(line.slice(1))) })) };
        }
      } else if (last?.toolName === "writeAssignedTranslation" || last?.toolName === "repairAssignedTranslation") name = "validateAssignedTranslation";
      else if (last?.toolName === "readAssignedTranslationReview") { name = "submitTranslationReview"; args = { failures: [] }; }
      else {
        const user = context.messages.findLast(message => message.role === "user");
        const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
        name = text.includes("FIRST TOOL: call readAssignedTranslationReview") ? "readAssignedTranslationReview" : "readAssignedSource";
      }
      return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    }));
    supervisor = new YnSubagentSupervisor({ publishCustomMessage: trackCard, publishLiveCustomMessage: trackCard,
      createModelSelection: async () => {
        firstRuntimeMemory ??= observeMemory();
        if (recovery && recoveryRuntimeLaunches < 5) {
          assert.equal(state.ranges[path.basename(sourcePath)].filter(scope => scope.candidatePath !== canonicalPath).length, 5,
            "the Host must finish all recovery bindings before creating the first worker runtime");
          recoveryRuntimeLaunches += 1;
        }
        return { models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id };
      } });
    // Exercise the actual Host hooks and two persistent Pi pools on a bounded portion of the real full-sized file.
    const startBatch = supervisor.startTranslationBatch.bind(supervisor);
    supervisor.startTranslationBatch = options => startBatch({ ...options, tasks: recovery
      ? options.tasks.filter(task => task.fromLine >= 2001 && task.toLine <= (chunks + 4) * 500)
      : options.tasks.slice(4, chunks + 4) });
    const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 5 });
    let suspended = false;
    const tools = createYnDomainTools({ request, subagents: supervisor, publishCustomMessage: trackCard,
      domainRun, isWorkflowSuspended: () => suspended,
      resumeWorkflow: async () => { domainRun.resume(); suspended = false; supervisor.resumeAfterHostFailure(); },
      translationAlignmentState: state, persistHostState: async () => { await new Promise(resolve => setTimeout(resolve, 2)); } });
    const tool = name => tools.find(item => item.name === name);
    await tool("inspectTranslationContext").execute("inspect", {});
    if (recovery) {
      const candidateLines = Array(sourceLines.length).fill("");
      for (let fromLine = 2001; fromLine <= 4501; fromLine += 500) {
        for (let line = fromLine; line < fromLine + 500; line++) candidateLines[line - 1] = fixtureTranslation(sourceLines[line - 1]);
        const repairLine = fromLine + sourceLines.slice(fromLine - 1, fromLine + 499).findIndex(line => line.trim());
        assert.ok(repairLine >= fromLine);
        const scope = createTranslationChunkReviewAudit({ documentId: path.basename(sourcePath), candidatePath: canonicalPath,
          sourceLines: sourceLines.slice(fromLine - 1, fromLine + 499), candidateLines: candidateLines.slice(fromLine - 1, fromLine + 499),
          fromLine, toLine: fromLine + 499, sourceLineCount: sourceLines.length, languagePair: request.languagePair,
          mechanicalSignals: [{ line: repairLine, signals: ["semantic_mistranslation"] }] });
        scope.auditId = `alignment-mutation-${scope.auditId}`;
        for (const check of scope.checks) {
          check.verdict = fromLine > 2001 && check.line === repairLine ? "misaligned" : "aligned";
          if (check.verdict === "misaligned") check.reason = "semantic_mistranslation: restore the row's meaning";
        }
        if (fromLine === 2001) acceptedRecoveryScope = structuredClone(scope);
        else recoveryLines.add(repairLine);
        (state.ranges[path.basename(sourcePath)] ??= []).push(scope);
      }
      await writeFile(canonicalPath, candidateLines.join("\n") + "\n", "utf8");
      domainRun.recordTranslationArtifactMutation(path.basename(sourcePath));
      domainRun.recordSubagentBatchStarted("translation", "large-prior-failed-batch", { taskCount: 5, workerCount: 5,
        documentIds: [path.basename(sourcePath)], assignmentCounts: { [path.basename(sourcePath)]: 5 } });
      domainRun.recordSubagentBatchFailure("translation", "large-prior-failed-batch", [path.basename(sourcePath)]);
      domainRun.suspend(); suspended = true;
      await tool("resumeYnWorkflow").execute("resume", {});
    }
    if (global.gc) global.gc();
    const baseline = process.memoryUsage();
    heartbeat = setInterval(() => { const now = performance.now(); maxMainDelay = Math.max(maxMainDelay, now - previous); previous = now; observeMemory(); }, 10);
    previous = performance.now();
    const started = performance.now();
    await tool("runTranslationSubagents").execute("run", {});
    await supervisor.waitForAll();
    await observeUi();
    const batches = supervisor.list();
    assert.equal(batches.find(b => b.kind === "translation")?.status, "completed", JSON.stringify(batches));
    assert.equal(batches.find(b => b.kind === "translation-review")?.status, "completed", JSON.stringify(batches));
    assert.equal(state.ranges[path.basename(sourcePath)]?.length, chunks);
    assert.ok(state.ranges[path.basename(sourcePath)].every(scope => scope.checks.every(check => check.verdict === "aligned")));
    if (recovery) {
      assert.equal(recoveryRuntimeLaunches, 5);
      assert.equal(recoveryProviderCalls, 5);
      assert.deepEqual(state.ranges[path.basename(sourcePath)].find(scope => scope.fromLine === 2001), acceptedRecoveryScope);
      const finalLines = splitTextLines(await readFile(canonicalPath, "utf8"));
      for (const line of recoveryLines) assert.equal(finalLines[line - 1], "修复" + fixtureTranslation(sourceLines[line - 1]));
    }
    if (global.gc) global.gc();
    const sessionFiles = await readdir(path.join(outputDir, ".translation-workshop", "agent", "pi-sessions"), { recursive: true });
    let parentJsonlBytes = 0;
    for (const file of sessionFiles.filter(file => file.endsWith(".jsonl"))) {
      parentJsonlBytes += (await readFile(path.join(outputDir, ".translation-workshop", "agent", "pi-sessions", file))).byteLength;
    }
    records.push({ phase: "chunks", chunks, workers: 5, recovery, recoveryRuntimeLaunches, recoveryProviderCalls, sourceLines: sourceLines.length,
      elapsedMs: performance.now() - started, maxMainDelay, maximumChildCardBytes, parentJsonlBytes, baseline,
      firstRuntimeMemory, peakMemory: { ...peakMemory }, memory: process.memoryUsage() });
    const candidatePath = path.join(outputDir, "AI_translation", "japanese_text_unique_translated.txt");
    const candidateText = await readFile(candidatePath, "utf8");
    const validationOptions = await createYnTranslationValidationOptions(request);
    const finalStarted = performance.now();
    const validation = await runTranslationValidation({ sourceText, candidateText, validationOptions,
      diagnostics: { outputDir, documentId: path.basename(sourcePath), phase: "whole-file-acceptance" } });
    await observeUi();
    assert.equal(validation.sourceLineCount, sourceLines.length);
    assert.ok(validation.warnings.some(finding => finding.code === "empty_line_displaced" && finding.line === 1), "final validation must still check unprocessed rows");
    records.push({ phase: "final", elapsedMs: performance.now() - finalStarted, maxMainDelay,
      blocking: validation.blocking.length, warnings: validation.warnings.length, memory: process.memoryUsage() });
    const events = (await readFile(path.join(outputDir, ".translation-workshop", "agent", "validation", "events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    const chunkCompletions = events.filter(e => e.event === "completed" && e.phase !== "whole-file-acceptance");
    assert.ok(chunkCompletions.length >= (recovery ? chunks - 6 : chunks) * 3);
    assert.ok(chunkCompletions.every(e => e.sourceLineCount === 500), "no chunk path may validate the full file");
    assert.ok(maxMainDelay < 1000, `main loop blocked ${maxMainDelay} ms`);
    const diagnostics = path.join(process.cwd(), "artifacts", "diagnostics", "large-file-crash-2026-10-03");
    await mkdir(diagnostics, { recursive: true });
    await writeFile(path.join(diagnostics, "large-file-acceptance.json"), JSON.stringify({ records, events }, null, 2));
    console.log(JSON.stringify({ largeFileTranslationAcceptance: true, records }));
    return records;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    supervisor?.abortAll(); await supervisor?.waitForAll();
    if (!path.resolve(outputDir).startsWith(path.join(os.tmpdir(), "yn-large-validation-"))) throw new Error("Unsafe fixture cleanup");
    await rm(outputDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "verify-large-translation-validation.mjs"
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await verifyLargeTranslationValidation();
}
