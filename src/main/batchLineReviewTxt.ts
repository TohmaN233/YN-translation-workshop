import { readFile } from "node:fs/promises";
import path from "node:path";

import { splitTextLines } from "../shared/validation/translationValidator.ts";
import { resolveTranslationCandidatePath } from "./agent/writeTranslationChunk.ts";
import { resolveBatchReviewChildForUpgrade } from "./batchReviewUpgradePaths.ts";

interface BatchIndexFile {
  sourceName: string;
  sourcePath: string;
  outputPath: string;
  translationPath?: string;
  translationName?: string;
  translationLineCount?: number;
  sourceLineCount?: number;
  status?: "matched" | "missing-translation" | "line-count-mismatch";
}

interface BatchIndexData {
  files: BatchIndexFile[];
  folderAgentRoute?: { outputDir?: string };
}

export interface BatchLineReviewChild {
  documentId: string;
  sourcePath: string;
  translationPath?: string;
  childPath: string;
  outputPath: string;
  sourceLineCount?: number;
  outputDir?: string;
}

export interface BatchLineReviewBindingUpdate {
  documentId: string;
  translationPath: string;
  translationLineCount: number;
}

export interface BatchLineReviewCurrentBinding extends BatchLineReviewChild {
  translationPath: string;
  translationBinding: "explicit" | "canonical-default";
}

interface LineReviewRow {
  line: number;
  source: string;
  translation: string;
}

interface LineReviewData {
  rows: LineReviewRow[];
  workflow?: {
    initialTranslationLines?: unknown;
    paths?: {
      sourcePath?: unknown;
      translationPath?: unknown;
      editableTranslationPath?: unknown;
      outputDir?: unknown;
    };
  };
}

interface LineReviewState {
  edits?: Record<string, unknown>;
  translationPath?: unknown;
}

export interface BatchLineReviewTxtWrite {
  childPath: string;
  sourcePath: string;
  targetPath: string;
  outputDir: string;
  text: string;
  lineCount: number;
}

function parseJsonScript<T>(html: string, id: string): T {
  const expression = new RegExp(`<script id=["']${id}["'] type=["']application/json["']>([\\s\\S]*?)<\\/script>`, "i");
  const match = html.match(expression);
  if (!match) throw new Error(`Required ${id} payload is missing.`);
  try {
    return JSON.parse(match[1]) as T;
  } catch (error) {
    throw new Error(`Required ${id} payload is invalid JSON.`, { cause: error });
  }
}

function normalizeBatchData(value: BatchIndexData): BatchIndexData {
  if (!value || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("Batch review has no child files to write.");
  }
  for (const file of value.files) {
    if (!file || typeof file.sourceName !== "string" || typeof file.sourcePath !== "string"
      || typeof file.outputPath !== "string") {
      throw new Error("Batch review contains an invalid child file entry.");
    }
  }
  return value;
}

function normalizeLineReviewData(value: LineReviewData, childPath: string): LineReviewData {
  if (!value || !Array.isArray(value.rows) || value.rows.length === 0) {
    throw new Error(`Line-review child has no rows: ${childPath}`);
  }
  value.rows = value.rows.map((row, index) => {
    const line = Number(row?.line);
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`Line-review child has an invalid row at index ${index}: ${childPath}`);
    }
    return {
      line,
      source: String(row?.source ?? ""),
      translation: String(row?.translation ?? "")
    };
  });
  return value;
}

function workspaceDirFromHtmlPath(filePath: string): string {
  const parts = path.resolve(filePath).split(path.sep);
  const index = parts.map((part) => part.toLowerCase()).lastIndexOf(".translation-workshop");
  if (index < 1) return "";
  return parts.slice(0, index + 1).join(path.sep);
}

export function lineReviewSidecarStatePath(lineReviewPath: string, outputDir?: string): string {
  const resolvedOutputDir = typeof outputDir === "string" && path.isAbsolute(outputDir)
    ? path.resolve(outputDir)
    : "";
  const workspaceDir = workspaceDirFromHtmlPath(lineReviewPath) || (resolvedOutputDir
    ? path.basename(resolvedOutputDir).toLowerCase() === ".translation-workshop"
      ? resolvedOutputDir
      : path.join(resolvedOutputDir, ".translation-workshop")
    : "");
  return workspaceDir ? path.join(
    workspaceDir,
    "state",
    `line-${path.basename(lineReviewPath)}.json`
  ) : "";
}

export async function resolveLineReviewSidecarStatePath(lineReviewPath: string): Promise<string> {
  const directPath = lineReviewSidecarStatePath(lineReviewPath);
  if (directPath) return directPath;
  const review = normalizeLineReviewData(
    parseJsonScript<LineReviewData>(await readFile(lineReviewPath, "utf8"), "reviewData"),
    lineReviewPath
  );
  return lineReviewSidecarStatePath(
    lineReviewPath,
    typeof review.workflow?.paths?.outputDir === "string" ? review.workflow.paths.outputDir : undefined
  );
}

async function readLineReviewState(lineReviewPath: string, outputDir: string): Promise<LineReviewState> {
  const statePath = lineReviewSidecarStatePath(lineReviewPath, outputDir);
  if (!statePath) throw new Error(`Line-review HTML is outside a project workspace: ${lineReviewPath}`);
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Line-review state is not an object: ${lineReviewPath}`);
    }
    return parsed as LineReviewState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function batchLineReviewOwnsChild(batchIndexPath: string, childPath: string): Promise<boolean> {
  return (await readBatchLineReviewChildren(batchIndexPath))
    .some((item) => samePath(item.childPath, childPath));
}

export async function readBatchLineReviewChildren(batchIndexPath: string): Promise<BatchLineReviewChild[]> {
  if (!path.isAbsolute(batchIndexPath) || path.extname(batchIndexPath).toLowerCase() !== ".html") {
    throw new Error("An absolute batch review HTML path is required.");
  }
  const batch = normalizeBatchData(
    parseJsonScript<BatchIndexData>(await readFile(batchIndexPath, "utf8"), "batchData")
  );
  const outputDir = typeof batch.folderAgentRoute?.outputDir === "string"
    && path.isAbsolute(batch.folderAgentRoute.outputDir)
    ? path.resolve(batch.folderAgentRoute.outputDir)
    : undefined;
  return Promise.all(batch.files.map(async (file) => ({
    documentId: file.sourceName,
    sourcePath: path.resolve(file.sourcePath),
    ...(typeof file.translationPath === "string" && file.translationPath.trim()
      ? { translationPath: path.resolve(file.translationPath) }
      : {}),
    childPath: await resolveBatchReviewChildForUpgrade(batchIndexPath, file.outputPath),
    outputPath: file.outputPath,
    ...(Number.isInteger(Number(file.sourceLineCount)) && Number(file.sourceLineCount) > 0
      ? { sourceLineCount: Number(file.sourceLineCount) }
      : {}),
    ...(outputDir ? { outputDir } : {})
  })));
}

export async function canonicalBatchLineReviewIndexPath(candidatePath: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidatePath) || path.extname(candidatePath).toLowerCase() !== ".html") {
    return undefined;
  }
  const batchChildren = async (indexPath: string): Promise<BatchLineReviewChild[] | undefined> => {
    let html: string;
    try {
      html = await readFile(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!/<script\s+id=["']batchData["']\s+type=["']application\/json["']>/i.test(html)) {
      return undefined;
    }
    return readBatchLineReviewChildren(indexPath);
  };
  const resolvedCandidate = path.resolve(candidatePath);
  if (await batchChildren(resolvedCandidate)) return resolvedCandidate;
  const siblingIndex = `${path.dirname(resolvedCandidate)}.html`;
  const siblings = await batchChildren(siblingIndex);
  return siblings?.some((child) => samePath(child.childPath, resolvedCandidate))
    ? siblingIndex
    : undefined;
}

export function bindBatchLineReviewTranslations(
  html: string,
  updates: BatchLineReviewBindingUpdate[]
): string {
  const expression = /<script id=["']batchData["'] type=["']application\/json["']>([\s\S]*?)<\/script>/i;
  const match = html.match(expression);
  if (!match) throw new Error("Required batchData payload is missing.");
  const batch = normalizeBatchData(JSON.parse(match[1]) as BatchIndexData);
  const updateByDocument = new Map(updates.map((update) => [
    update.documentId.trim().replace(/\\/g, "/").toLowerCase(),
    update
  ]));
  for (const file of batch.files) {
    const update = updateByDocument.get(file.sourceName.trim().replace(/\\/g, "/").toLowerCase());
    if (!update) continue;
    file.translationPath = path.resolve(update.translationPath);
    file.translationName = path.basename(update.translationPath);
    file.translationLineCount = update.translationLineCount;
    file.status = Number(file.sourceLineCount) === update.translationLineCount
      ? "matched"
      : "line-count-mismatch";
  }
  const payload = JSON.stringify(batch)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return html.replace(expression, (script) => script.replace(match[1], payload));
}

function absoluteTxtPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value) || !/\.txt$/i.test(value)) {
    return undefined;
  }
  return path.resolve(value);
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function outputDirFor(batch: BatchIndexData, review: LineReviewData): string {
  const candidate = [review.workflow?.paths?.outputDir, batch.folderAgentRoute?.outputDir]
    .find((value): value is string => typeof value === "string" && path.isAbsolute(value));
  if (!candidate) throw new Error("Batch review is missing its absolute project output directory.");
  return path.resolve(candidate);
}

function explicitTargetPathsFor(
  file: BatchIndexFile,
  review: LineReviewData,
  state: LineReviewState
): string[] {
  const sourcePath = path.resolve(file.sourcePath);
  const boundTargets = [
    state.translationPath,
    review.workflow?.paths?.editableTranslationPath,
    review.workflow?.paths?.translationPath,
    file.translationPath
  ]
    .map(absoluteTxtPath)
    .filter((candidate): candidate is string => Boolean(candidate && !samePath(candidate, sourcePath)));
  const distinctTargets = [...new Map(boundTargets.map((candidate) => [
    process.platform === "win32" ? candidate.toLowerCase() : candidate,
    candidate
  ])).values()];
  if (distinctTargets.length > 1) {
    throw new Error(
      `Batch review has divergent translation bindings for ${file.sourceName}: ${distinctTargets.join(", ")}.`
    );
  }
  return distinctTargets;
}

function targetPathFor(
  batch: BatchIndexData,
  file: BatchIndexFile,
  review: LineReviewData,
  state: LineReviewState
): string {
  const distinctTargets = explicitTargetPathsFor(file, review, state);
  if (distinctTargets[0]) return distinctTargets[0];
  const outputDir = outputDirFor(batch, review);
  const sourcePath = path.resolve(file.sourcePath);
  return resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: file.sourceName
  });
}

export async function readBatchLineReviewCurrentBindings(
  batchIndexPath: string
): Promise<BatchLineReviewCurrentBinding[]> {
  if (!path.isAbsolute(batchIndexPath) || path.extname(batchIndexPath).toLowerCase() !== ".html") {
    throw new Error("An absolute batch review HTML path is required.");
  }
  const batch = normalizeBatchData(
    parseJsonScript<BatchIndexData>(await readFile(batchIndexPath, "utf8"), "batchData")
  );
  return Promise.all(batch.files.map(async (file) => {
    const childPath = await resolveBatchReviewChildForUpgrade(batchIndexPath, file.outputPath);
    const review = normalizeLineReviewData(
      parseJsonScript<LineReviewData>(await readFile(childPath, "utf8"), "reviewData"),
      childPath
    );
    const outputDir = outputDirFor(batch, review);
    const state = await readLineReviewState(childPath, outputDir);
    const explicitTargets = explicitTargetPathsFor(file, review, state);
    return {
      documentId: file.sourceName,
      sourcePath: path.resolve(file.sourcePath),
      translationPath: targetPathFor(batch, file, review, state),
      translationBinding: explicitTargets.length > 0 ? "explicit" : "canonical-default",
      childPath,
      outputPath: file.outputPath,
      ...(Number.isInteger(Number(file.sourceLineCount)) && Number(file.sourceLineCount) > 0
        ? { sourceLineCount: Number(file.sourceLineCount) }
        : {}),
      outputDir
    };
  }));
}

async function existingTargetLines(targetPath: string): Promise<string[] | undefined> {
  try {
    return splitTextLines(await readFile(targetPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function embeddedTranslationLines(review: LineReviewData): string[] {
  const initial = review.workflow?.initialTranslationLines;
  if (Array.isArray(initial)) return initial.map((line) => String(line ?? ""));
  return review.rows.map((row) => row.translation);
}

export async function prepareBatchLineReviewTxtWrites(batchIndexPath: string): Promise<BatchLineReviewTxtWrite[]> {
  if (!path.isAbsolute(batchIndexPath) || path.extname(batchIndexPath).toLowerCase() !== ".html") {
    throw new Error("An absolute batch review HTML path is required.");
  }
  const batch = normalizeBatchData(parseJsonScript<BatchIndexData>(await readFile(batchIndexPath, "utf8"), "batchData"));
  const plans: BatchLineReviewTxtWrite[] = [];
  const seenTargets = new Set<string>();

  for (const file of batch.files) {
    const childPath = await resolveBatchReviewChildForUpgrade(batchIndexPath, file.outputPath);
    const review = normalizeLineReviewData(
      parseJsonScript<LineReviewData>(await readFile(childPath, "utf8"), "reviewData"),
      childPath
    );
    const outputDir = outputDirFor(batch, review);
    const state = await readLineReviewState(childPath, outputDir);
    const targetPath = targetPathFor(batch, file, review, state);
    if (samePath(targetPath, file.sourcePath)) {
      throw new Error(`Batch TXT write cannot overwrite a source file: ${file.sourcePath}`);
    }
    const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
    if (seenTargets.has(comparableTarget)) {
      throw new Error(`Batch TXT write resolves more than one child to ${targetPath}.`);
    }
    seenTargets.add(comparableTarget);

    const existingLines = await existingTargetLines(targetPath);
    const embeddedLines = embeddedTranslationLines(review);
    const edits = state.edits && typeof state.edits === "object" && !Array.isArray(state.edits)
      ? state.edits
      : {};
    const completeSidecar = review.rows.every((row) => Object.prototype.hasOwnProperty.call(edits, String(row.line)));
    if (!existingLines && !embeddedLines.some((line) => line.trim() !== "") && !completeSidecar) {
      throw new Error(`Batch review has no current translation artifact for ${file.sourceName}: ${targetPath}`);
    }
    const baseline = existingLines ?? embeddedLines;
    if (baseline.length !== review.rows.length) {
      throw new Error(
        `Batch review translation line count changed for ${file.sourceName}: expected ${review.rows.length}, got ${baseline.length}.`
      );
    }
    const lines = review.rows.map((row, index) => (
      Object.prototype.hasOwnProperty.call(edits, String(row.line))
        ? String(edits[String(row.line)] ?? "")
        : String(baseline[index] ?? row.translation ?? "")
    ));
    plans.push({
      childPath,
      sourcePath: path.resolve(file.sourcePath),
      targetPath,
      outputDir,
      text: lines.join("\n"),
      lineCount: lines.length
    });
  }
  return plans;
}
