import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PDFDocument, StandardFonts, beginMarkedContent, endMarkedContent } from "pdf-lib";
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import { createYnDomainTools } from "../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState, createTranslationChunkReviewAudit, translationAlignmentLinesInputHash } from "../src/main/agent/piNative/translationAlignmentState.ts";
import { prepareTranslationStagingCandidate, resolveTranslationCandidatePath, writeTranslationLines } from "../src/main/agent/writeTranslationChunk.ts";
import { splitTextLines } from "../src/shared/validation/translationValidator.ts";

const crashRoot = process.env.YN_PDF_CRASH_ROOT;
const root = crashRoot ?? await mkdtemp(path.join(os.tmpdir(), "yn-pdf-protected-recovery-"));
if (crashRoot) await mkdir(root, { recursive: true });
const currentTranslationAlignmentRangeHash = (scope, sources, candidates, pair) => translationAlignmentLinesInputHash(sources.slice(scope.fromLine - 1, scope.toLine), candidates.slice(scope.fromLine - 1, scope.toLine), pair);
try {
  for (const mode of crashRoot ? ["crash"] : ["canonical", "staging", "tamper", "persist"]) {
    const outputDir = path.join(root, mode);
    await mkdir(outputDir);
    const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let line = 1; line <= 25; line++) {
      if (line === 19 || line === 20) page.pushOperators(beginMarkedContent(line === 19 ? "Code" : "Formula"));
      page.drawText(line === 19 ? "const n = 2;" : line === 20 ? "x = y" : `Source sentence ${line} has its own complete meaning.`, { x: 40, y: 760 - line * 24, size: 10, font });
      if (line === 19 || line === 20) page.pushOperators(endMarkedContent());
    }
    const original = path.join(outputDir, "case.pdf");
    await writeFile(original, await pdf.save());
    const { sourcePath } = await preparePdfDocument(original, path.join(outputDir, ".translation-workshop"));
    const sourceLines = splitTextLines(await readFile(sourcePath, "utf8"));
    const canonical = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "case.txt" });
    await mkdir(path.dirname(canonical), { recursive: true });
    const candidates = sourceLines.map((_, index) => `第${index + 1}行保留本行完整含义。`);
    candidates[18] = "";
    candidates[19] = "historically changed formula";
    await writeFile(canonical, candidates.join("\n") + "\n");
    const stage = await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "case.txt", sessionId: "recovery", subagentId: "old", assignmentId: "17-25", deferPdfProtection: true });
    const owned = mode === "staging" ? stage : canonical;
    const alignment = createTranslationAlignmentHostState();
    for (const [fromLine, toLine] of [[1, 16], [17, 25]]) {
      const scope = createTranslationChunkReviewAudit({ documentId: "case.txt", sourceLines: sourceLines.slice(fromLine - 1, toLine), candidateLines: candidates.slice(fromLine - 1, toLine), candidatePath: fromLine === 1 ? canonical : owned, languagePair: "en->zh-CN", fromLine, toLine, sourceLineCount: 25,
        mechanicalSignals: fromLine === 1 ? [] : [19, 20, 21].map(line => ({ line, signals: [line === 21 ? "semantic_mistranslation" : "pdf_protected_mismatch"] })) });
      for (const check of scope.checks) {
        check.verdict = [19, 20, 21].includes(check.line) ? "misaligned" : "aligned";
        if (check.verdict === "misaligned") check.reason = "semantic_mistranslation: restore this row's complete meaning";
      }
      (alignment.ranges["case.txt"] ??= []).push(scope);
    }
    const request = { outputDir, sourcePath, sessionId: "recovery", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", providerId: "test", modelId: "test", languagePair: "en->zh-CN", splitSize: 500, subagentEnabled: true, subagentCount: 3, glossaryCandidates: false, characterBible: false };
    const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 3 });
    domainRun.recordInspection({ sourceLineCount: 25, documents: [{ id: "case.txt", sourceLineCount: 25 }], glossaryCandidateExists: true, characterBibleExists: true });
    domainRun.recordTranslationArtifactMutation("case.txt");
    let batch, launches = 0, persists = 0;
    const subagents = { hasRunning: () => false, hasWriteConflict: () => false,
      startTranslationBatch(options) { batch = options; launches++; return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] }; } };
    const tools = createYnDomainTools({ request, domainRun, subagents, translationAlignmentState: alignment, publishCustomMessage: async () => {},
      persistHostState: async () => { persists++;
        if (mode === "crash" && persists === 1) process.exit(73); // file renamed; checkpoint not appended; no catch/finally
        if (mode === "persist" && persists === 1) throw new Error("injected PDF recovery commit failure"); } });
    if (mode === "tamper") {
      const tampered = [...candidates]; tampered[0] = "external unreviewed prose change";
      await writeFile(canonical, tampered.join("\n") + "\n");
    }
    const before = { alignment: structuredClone(alignment), canonical: await readFile(canonical, "utf8"), stage: await readFile(stage, "utf8") };
    if (mode === "crash") await writeFile(path.join(root, "before-checkpoint.json"), JSON.stringify({ request, alignment: before.alignment, canonical, sourceLines }));
    const run = () => tools.find(tool => tool.name === "runTranslationSubagents").execute("resume", {});
    if (mode === "tamper" || mode === "persist") {
      await assert.rejects(run, /Host recovery preflight failed/);
      assert.equal(launches, 0, "no runtime may start before the entire recovery transaction succeeds");
      assert.deepEqual(alignment, before.alignment);
      assert.equal(await readFile(canonical, "utf8"), before.canonical);
      assert.equal(await readFile(stage, "utf8"), before.stage);
      continue;
    }
    await run();
    assert.equal(launches, 1);
    const scopes = alignment.ranges["case.txt"];
    assert.deepEqual(scopes[0], before.alignment.ranges["case.txt"][0], "other owned range must keep its bytes and complete proof");
    const current = scopes[1], normalized = splitTextLines(await readFile(current.candidatePath, "utf8"));
    assert.equal(normalized[18], sourceLines[18]); assert.equal(normalized[19], sourceLines[19]);
    assert.equal(current.inputHash, currentTranslationAlignmentRangeHash(current, sourceLines, normalized, request.languagePair));
    assert.deepEqual(current.checks.filter(check => ![19, 20].includes(check.line)), before.alignment.ranges["case.txt"][1].checks.filter(check => ![19, 20].includes(check.line)), "unchanged prose retains its accepted/rejected review evidence");
    assert.deepEqual(batch.tasks[0].reviewFeedback.map(item => item.line), [21]);
    // Ordinary sparse writes cannot normalize another retained range behind its evidence.
    await writeTranslationLines({ outputDir, sourcePaths: [sourcePath], documentId: "case.txt", entries: [{ line: 2, text: "只修改第二行的完整含义。" }] });
    if (mode === "staging") assert.equal(splitTextLines(await readFile(canonical, "utf8"))[19], candidates[19]);
    // Rebind a copied canonical range only after its old aggregate proof is verified.
    if (mode === "canonical") {
      alignment.ranges["case.txt"][1] = structuredClone(before.alignment.ranges["case.txt"][1]);
      await writeFile(canonical, before.canonical);
      const copied = await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "case.txt", sessionId: "recovery", subagentId: "new", assignmentId: "17-25", deferPdfProtection: true });
      await batch.onStagingCandidatePrepared({ documentId: "case.txt", fromLine: 17, toLine: 25, candidatePath: copied });
      const rebound = alignment.ranges["case.txt"][1], lines = splitTextLines(await readFile(copied, "utf8"));
      assert.equal(lines[18], sourceLines[18]); assert.equal(lines[19], sourceLines[19]);
      assert.equal(rebound.inputHash, currentTranslationAlignmentRangeHash(rebound, sourceLines, lines, request.languagePair));
      assert.deepEqual(rebound.checks.filter(check => ![19, 20].includes(check.line)), before.alignment.ranges["case.txt"][1].checks.filter(check => ![19, 20].includes(check.line)));
    }
  }
  if (!crashRoot) {
    const childRoot = path.join(root, "crash-fixture");
    const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("tests/pdf-protected-recovery.test.mjs")], {
      windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", YN_PDF_CRASH_ROOT: childRoot }, stdio: ["ignore", "pipe", "pipe"]
    });
    let childLog = "";
    child.stdout.on("data", bytes => { childLog += bytes; }); child.stderr.on("data", bytes => { childLog += bytes; });
    assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 73, childLog);
    const cold = JSON.parse(await readFile(path.join(childRoot, "before-checkpoint.json"), "utf8"));
    const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 3 });
    domainRun.recordInspection({ sourceLineCount: 25, documents: [{ id: "case.txt", sourceLineCount: 25 }], glossaryCandidateExists: true, characterBibleExists: true });
    domainRun.recordTranslationArtifactMutation("case.txt");
    let launches = 0, batch;
    const tools = createYnDomainTools({ request: cold.request, domainRun, translationAlignmentState: cold.alignment, publishCustomMessage: async () => {}, persistHostState: async () => {},
      subagents: { hasRunning: () => false, hasWriteConflict: () => false, startTranslationBatch(options) { launches++; batch = options; return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] }; } } });
    await tools.find(tool => tool.name === "runTranslationSubagents").execute("cold-resume", {});
    assert.equal(launches, 1, "a new Host must accept only the verified write-ahead protection receipt after an abrupt checkpoint interruption");
    assert.deepEqual(batch.tasks[0].reviewFeedback.map(item => item.line), [21]);
    const scope = cold.alignment.ranges["case.txt"][1], lines = splitTextLines(await readFile(scope.candidatePath, "utf8"));
    assert.equal(lines[18], cold.sourceLines[18]); assert.equal(lines[19], cold.sourceLines[19]);
    assert.equal(scope.inputHash, currentTranslationAlignmentRangeHash(scope, cold.sourceLines, lines, cold.request.languagePair));
  }
  console.log("PDF recovery verifies old ownership/hash before transactional protection and proof rebinding; tamper/persistence failures roll back before model calls.");
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  await rm(root, { recursive: true, force: true });
}
