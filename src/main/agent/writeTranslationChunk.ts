import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { splitTextLines } from "../../shared/validation/translationValidator.ts";
import { writeTextFileAtomically } from "../atomicFile.ts";

export interface WriteTranslationChunkArgs {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  fromLine: number;
  toLine: number;
  lines: string[];
  candidatePath?: string;
}

export interface WriteTranslationChunkResult {
  ok: boolean;
  path?: string;
  fromLine: number;
  toLine: number;
  linesWritten: number;
  totalCandidateLines: number;
  sourceLineCount: number;
  created: boolean;
  error?: string;
}

export interface WriteTranslationLinesArgs {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  entries: Array<{ line: number; text: string }>;
  candidatePath?: string;
}

const chunkWriteLocks = new Map<string, Promise<void>>();
const TRANSLATION_STAGING_DIR = path.join(".translation-workshop", "agent", "translation-staging");

export async function withTranslationCandidateLock<T>(candidatePath: string, task: () => Promise<T>): Promise<T> {
  const resolvedPath = path.resolve(candidatePath);
  const lockKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const previous = chunkWriteLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  chunkWriteLocks.set(lockKey, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (chunkWriteLocks.get(lockKey) === tail) {
      chunkWriteLocks.delete(lockKey);
    }
  }
}

export function resolveTranslationCandidatePath(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
}): string {
  const sourcePath = args.sourcePaths[0];
  const rawDocumentId = args.documentId.trim() || path.basename(sourcePath ?? "translation.txt");
  if (path.isAbsolute(rawDocumentId)) {
    throw new Error("Translation documentId must be relative.");
  }
  const normalized = path.normalize(rawDocumentId);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Translation documentId must stay inside the selected source folder.");
  }
  const parsed = path.parse(normalized);
  const candidatePath = path.join(args.outputDir, "AI_translation", parsed.dir, `${parsed.name}_translated.txt`);
  assertCandidatePath(args.outputDir, candidatePath);
  return candidatePath;
}

function assertCandidatePath(outputDir: string, candidatePath: string): void {
  const aiDir = path.resolve(path.join(outputDir, "AI_translation"));
  const resolved = path.resolve(candidatePath);
  if (!resolved.startsWith(`${aiDir}${path.sep}`) && resolved !== aiDir) {
    throw new Error("Candidate path must stay under AI_translation/.");
  }
}

function translationStagingRoot(outputDir: string): string {
  return path.resolve(path.join(outputDir, TRANSLATION_STAGING_DIR));
}

function assertStagingPath(outputDir: string, stagingPath: string): void {
  const stagingRoot = translationStagingRoot(outputDir);
  const resolved = path.resolve(stagingPath);
  if (resolved === stagingRoot || !resolved.startsWith(`${stagingRoot}${path.sep}`)) {
    throw new Error("Translation staging path must stay under the project Agent staging directory.");
  }
}

export function isTranslationStagingCandidatePath(outputDir: string, stagingPath: string): boolean {
  try {
    assertStagingPath(outputDir, stagingPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWriteCandidatePath(args: WriteTranslationChunkArgs): string {
  const canonicalPath = resolveTranslationCandidatePath(args);
  if (!args.candidatePath) return canonicalPath;
  const requestedPath = path.resolve(args.candidatePath);
  if (requestedPath === path.resolve(canonicalPath)) return canonicalPath;
  assertStagingPath(args.outputDir, requestedPath);
  return requestedPath;
}

function safeStagingSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (normalized || "session").slice(0, 48);
}

export async function prepareTranslationStagingCandidate(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  sessionId: string;
  subagentId: string;
  assignmentId: string;
  resumeStagingPath?: string;
}): Promise<string> {
  if (args.resumeStagingPath?.trim()) {
    const resumed = path.resolve(args.resumeStagingPath);
    assertStagingPath(args.outputDir, resumed);
    const [sourceLineCount, resumedLines] = await Promise.all([
      countSourceLines(args.sourcePaths),
      readFile(resumed, "utf8").then(splitTextLines)
    ]);
    if (resumedLines.length !== sourceLineCount) {
      throw new Error(
        `Cannot resume ${args.documentId}: staging candidate has ${resumedLines.length} lines but source has ${sourceLineCount}.`
      );
    }
    return resumed;
  }
  const canonicalPath = resolveTranslationCandidatePath(args);
  const digest = createHash("sha256")
    .update(JSON.stringify([args.sessionId, args.subagentId, args.documentId, args.assignmentId]))
    .digest("hex")
    .slice(0, 20);
  const stagingPath = path.join(
    translationStagingRoot(args.outputDir),
    safeStagingSegment(args.sessionId),
    safeStagingSegment(args.subagentId),
    `${digest}-${path.basename(canonicalPath)}`
  );
  assertStagingPath(args.outputDir, stagingPath);
  const sourceLineCount = await countSourceLines(args.sourcePaths);
  await withTranslationCandidateLock(canonicalPath, async () => {
    let lines: string[];
    try {
      lines = splitTextLines(await readFile(canonicalPath, "utf8"));
      if (lines.length !== sourceLineCount) {
        throw new Error(
          `Cannot stage ${args.documentId}: canonical candidate has ${lines.length} lines but source has ${sourceLineCount}.`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lines = Array.from({ length: sourceLineCount }, () => "");
    }
    await mkdir(path.dirname(stagingPath), { recursive: true });
    await writeTextFileAtomically(stagingPath, `${lines.join("\n")}\n`);
  });
  return stagingPath;
}

export async function promoteTranslationStagingRange(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  stagingPath: string;
  fromLine: number;
  toLine: number;
}): Promise<WriteTranslationChunkResult> {
  assertStagingPath(args.outputDir, args.stagingPath);
  const stagingLines = splitTextLines(await readFile(args.stagingPath, "utf8"));
  const sourceLineCount = await countSourceLines(args.sourcePaths);
  if (stagingLines.length !== sourceLineCount) {
    throw new Error(
      `Cannot promote staged translation: staging has ${stagingLines.length} lines but source has ${sourceLineCount}.`
    );
  }
  const fromLine = Math.max(1, Math.floor(args.fromLine));
  const toLine = Math.max(fromLine, Math.floor(args.toLine));
  return writeTranslationChunk({
    outputDir: args.outputDir,
    sourcePaths: args.sourcePaths,
    documentId: args.documentId,
    fromLine,
    toLine,
    lines: stagingLines.slice(fromLine - 1, toLine)
  });
}

export async function discardTranslationStagingCandidate(args: {
  outputDir: string;
  stagingPath: string;
}): Promise<void> {
  assertStagingPath(args.outputDir, args.stagingPath);
  await rm(args.stagingPath, { force: true });
}

function normalizeLinesArg(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((line) => String(line ?? ""));
  }
  if (typeof value === "string") {
    return splitTextLines(value);
  }
  return [];
}

export async function countSourceLines(sourcePaths: string[]): Promise<number> {
  const sourcePath = sourcePaths[0];
  if (!sourcePath) throw new Error("A readable source path is required before writing a translation chunk.");
  return splitTextLines(await readFile(sourcePath, "utf8")).length;
}

async function refreshCanonicalReuseBaseline(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  candidatePath: string;
}): Promise<void> {
  if (path.resolve(args.candidatePath) !== path.resolve(resolveTranslationCandidatePath(args))) return;
  const { refreshAppliedReuseBaseline } = await import("./piNative/translationReuseAudit.ts");
  await refreshAppliedReuseBaseline(args);
}

export async function writeTranslationChunk(args: WriteTranslationChunkArgs): Promise<WriteTranslationChunkResult> {
  const fromLine = Math.max(1, Math.floor(args.fromLine));
  const toLine = Math.max(fromLine, Math.floor(args.toLine));
  const chunkLines = normalizeLinesArg(args.lines);
  const expectedCount = toLine - fromLine + 1;

  if (chunkLines.length !== expectedCount) {
    return {
      ok: false,
      fromLine,
      toLine,
      linesWritten: 0,
      totalCandidateLines: 0,
      sourceLineCount: 0,
      created: false,
      error: `Line count mismatch: expected ${expectedCount} lines for range ${fromLine}-${toLine}, got ${chunkLines.length}.`
    };
  }

  const sourceLineCount = await countSourceLines(args.sourcePaths);
  if (sourceLineCount > 0 && toLine > sourceLineCount) {
    return {
      ok: false,
      fromLine,
      toLine,
      linesWritten: 0,
      totalCandidateLines: 0,
      sourceLineCount,
      created: false,
      error: `Range ends at line ${toLine} but source has only ${sourceLineCount} lines.`
    };
  }

  const candidatePath = resolveWriteCandidatePath(args);
  if (candidatePath === resolveTranslationCandidatePath(args)) {
    assertCandidatePath(args.outputDir, candidatePath);
  } else {
    assertStagingPath(args.outputDir, candidatePath);
  }
  return withTranslationCandidateLock(candidatePath, async () => {
    await mkdir(path.dirname(candidatePath), { recursive: true });

    let existing: string[] = [];
    let created = false;
    try {
      existing = splitTextLines(await readFile(candidatePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      created = true;
    }

    const targetLength = sourceLineCount > 0 ? sourceLineCount : Math.max(existing.length, toLine);
    const merged = existing.slice(0, targetLength);
    while (merged.length < targetLength) {
      merged.push("");
    }

    for (let index = 0; index < chunkLines.length; index += 1) {
      merged[fromLine - 1 + index] = chunkLines[index];
    }

    await writeTextFileAtomically(candidatePath, `${merged.join("\n")}\n`);
    await refreshCanonicalReuseBaseline({
      outputDir: args.outputDir,
      sourcePaths: args.sourcePaths,
      documentId: args.documentId,
      candidatePath
    });

    return {
      ok: true,
      path: candidatePath,
      fromLine,
      toLine,
      linesWritten: chunkLines.length,
      totalCandidateLines: merged.length,
      sourceLineCount,
      created
    };
  });
}

export async function writeTranslationLines(args: WriteTranslationLinesArgs): Promise<WriteTranslationChunkResult> {
  const entries = args.entries.map((entry) => ({
    line: Math.floor(entry.line),
    text: String(entry.text ?? "")
  })).sort((left, right) => left.line - right.line);
  if (entries.length === 0) {
    throw new Error("A sparse translation write requires at least one exact line.");
  }
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.line) || entry.line < 1) {
      throw new Error(`Invalid sparse translation line: ${entry.line}.`);
    }
    if (seen.has(entry.line)) throw new Error(`Sparse translation line ${entry.line} is duplicated.`);
    seen.add(entry.line);
  }
  const fromLine = entries[0].line;
  const toLine = entries.at(-1)!.line;
  const sourceLineCount = await countSourceLines(args.sourcePaths);
  if (toLine > sourceLineCount) {
    return {
      ok: false,
      fromLine,
      toLine,
      linesWritten: 0,
      totalCandidateLines: 0,
      sourceLineCount,
      created: false,
      error: `Sparse translation line ${toLine} exceeds the ${sourceLineCount}-line source.`
    };
  }

  const candidatePath = resolveWriteCandidatePath({
    ...args,
    fromLine,
    toLine,
    lines: []
  });
  if (candidatePath === resolveTranslationCandidatePath(args)) {
    assertCandidatePath(args.outputDir, candidatePath);
  } else {
    assertStagingPath(args.outputDir, candidatePath);
  }
  return withTranslationCandidateLock(candidatePath, async () => {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    let existing: string[] = [];
    let created = false;
    try {
      existing = splitTextLines(await readFile(candidatePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      created = true;
    }
    const merged = existing.slice(0, sourceLineCount);
    while (merged.length < sourceLineCount) merged.push("");
    for (const entry of entries) merged[entry.line - 1] = entry.text;
    await writeTextFileAtomically(candidatePath, `${merged.join("\n")}\n`);
    await refreshCanonicalReuseBaseline({
      outputDir: args.outputDir,
      sourcePaths: args.sourcePaths,
      documentId: args.documentId,
      candidatePath
    });
    return {
      ok: true,
      path: candidatePath,
      fromLine,
      toLine,
      linesWritten: entries.length,
      totalCandidateLines: merged.length,
      sourceLineCount,
      created
    };
  });
}
