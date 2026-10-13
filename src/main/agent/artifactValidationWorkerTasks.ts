import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { validateTranslationCandidate, splitTextLines } from "../../shared/validation/translationValidator.ts";
import { normalizeCustomPreserveRules } from "../../shared/validation/customPreserveRules.ts";
import { readProjectState } from "../projectState.ts";
import { readPdfProtectedLines, readPdfPreservedSpans } from "../pdfDocuments.ts";
import { rememberTranslationSegments } from "./translationMemory.ts";
import { buildRepairPrompt } from "./importCandidate.ts";
import {parseTranslationResidueApprovals} from './translationResidueApproval.ts';
import path from 'node:path';
import type { ArtifactWorkerRequest, ArtifactWorkerResult } from "./artifactValidationService.ts";

export async function executeArtifactOperation(input: ArtifactWorkerRequest, progress: (phase: string, completedLines: number, totalLines: number) => void, checkCancelled: () => void, confirmMemoryCommit: () => Promise<void>): Promise<ArtifactWorkerResult> {
  checkCancelled();
  const { args } = input;
  progress("reading", 0, 0);
  const paths = [args.sourcePath, args.candidatePath];
  const signatures = async () => Promise.all(paths.map(async file => { const s = await stat(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }));
  const before = await signatures();
  const [source, candidate, project, pdfProtectedLines] = await Promise.all([
    readFile(args.sourcePath), readFile(args.candidatePath),
    readProjectState(args.projectDir), readPdfProtectedLines(args.sourcePath, args.projectDir)
  ]);
  const pdfPreservedSpans = await readPdfPreservedSpans(args.sourcePath,args.projectDir);
  checkCancelled();
  const validationOptions = { ...input.assets, locale: args.locale === "en-US" ? "en-US" as const : "zh-CN" as const,
    sourceBinding:args.sourcePath,translationResidueApprovals:parseTranslationResidueApprovals(project.translationResidueApprovals)
      .filter(entry=>path.resolve(entry.sourcePath)===path.resolve(args.sourcePath)).map(entry=>({...entry,sourcePath:args.sourcePath})),
    languagePair: args.languagePair, customPreserveRules: normalizeCustomPreserveRules(args.customPreserveRules ?? project.customPreserveRules), pdfProtectedLines, pdfPreservedSpans };
  const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  // Separate digests keep file boundaries unambiguous even for control/NUL
  // characters in game scripts; a delimiter alone cannot prove identity.
  const fingerprint = hash(JSON.stringify(["artifact-v1", hash(source), hash(candidate), hash(JSON.stringify(validationOptions))]));
  const sourceText = source.toString("utf8"), candidateText = candidate.toString("utf8");
  const cacheHit = input.cached?.fingerprint === fingerprint;
  let lastAt = 0;
  const validation = cacheHit ? input.cached!.validation : validateTranslationCandidate(sourceText, candidateText, validationOptions, (done, total) => {
    checkCancelled();
    const now = Date.now(); if (done !== total && now - lastAt < 250) return; lastAt = now; progress("validation", done, total);
  });
  checkCancelled();
  if (JSON.stringify(before) !== JSON.stringify(await signatures())) throw new Error("Source or candidate changed during validation; refresh before importing.");
  const result: ArtifactWorkerResult = { fingerprint, validation, cacheHit, validationBytes: Buffer.byteLength(JSON.stringify(validation)) };
  if (input.operation === "repair") result.prompt = buildRepairPrompt(sourceText, candidateText, validation, validationOptions.locale);
  if (input.operation === "import") {
    if (validation.ok) {
      progress("memory", 0, validation.sourceLineCount);
      const memory = await rememberTranslationSegments({ outputDir: args.projectDir, sourceText, targetText: candidateText,
        sourcePath: args.sourcePath, targetPath: args.candidatePath, languagePair: args.languagePair, checkCancelled,
        beforeCommit: async () => {
          if (JSON.stringify(before) !== JSON.stringify(await signatures())) throw new Error("Source or candidate changed during import; refresh before importing.");
          progress("memory-precommit", validation.sourceLineCount, validation.sourceLineCount);
          await confirmMemoryCommit();
          if (JSON.stringify(before) !== JSON.stringify(await signatures())) throw new Error("Source or candidate changed during import; refresh before importing.");
        } });
      if (memory.error) result.memoryWarning = memory.error;
      result.memoryCommitted = memory.available;
      const lines = splitTextLines(candidateText);
      if (input.compact) result.lines = lines;
      else result.plan = { ok: true, validation, lineCount: lines.length,
        edits: Object.fromEntries(lines.map((text, index) => [index + 1, text])), status: Object.fromEntries(lines.map((_, index) => [index + 1, "machine" as const])) };
    } else result.plan = { ok: false, validation, lineCount: validation.sourceLineCount, edits: {}, status: {} };
  }
  checkCancelled();
  return result;
}
