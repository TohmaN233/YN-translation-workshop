import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeProofreadFindingRecord } from "../../shared/core/reviewReport.ts";
import { splitTextLines } from "../../shared/validation/translationValidator.ts";
import { resolveProjectPath } from "./projectPathGuard.ts";
import { resolveTranslationCandidatePath } from "./writeTranslationChunk.ts";

export type ProofreadReportKind = "findings_json";

export interface ProofreadReportScope {
  kind: "folder";
  sourcePath: string;
}

export interface WriteProofreadFindingsArgs {
  outputDir: string;
  sourcePaths: string[];
  translationPath?: string;
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
  kind: ProofreadReportKind;
  content: string;
  /** Subagent chunk label e.g. "Chunk 001" for split mode headings */
  chunkLabel?: string;
  mode?: "split" | "montecarlo" | "agent";
  /** Replace this document's findings only after the incoming artifact validates. */
  replaceDocument?: boolean;
  /** Host-owned lines excluded from every persisted finding artifact. */
  excludedLines?: number[];
  /**
   * Replace every existing finding that touches this aligned range.
   * Only the Host may derive this from a current hash-bound proofread scope.
   */
  replaceRange?: { fromLine: number; toLine: number };
  /** Host-owned ids to remove from the current artifact before merging incoming findings. */
  dropFindingIds?: string[];
  /** Host-owned deterministic risks for the exact lines covered by this write. */
  mechanicalScan?: {
    scopeLines: number[];
    signals: Array<{ line: number; code: string; evidence: string }>;
  };
}

export interface WriteProofreadFindingsResult {
  ok: boolean;
  path?: string;
  relativePath?: string;
  kind: ProofreadReportKind;
  appended: boolean;
  created: boolean;
  incomingFindingCount?: number;
  newFindingCount?: number;
  duplicateFindingCount?: number;
  replacedFindingCount?: number;
  totalFindingCount?: number;
  error?: string;
}

export interface ProofreadFindingsSnapshot {
  filePath: string;
  content?: string;
  reportScope?: ProofreadReportScope;
  documentId?: string;
  documentFindings?: FolderProofreadFinding[];
  fileExisted?: boolean;
}

interface ProofreadFinding {
  id: string;
  severity: string;
  type: string;
  sourceLine: number;
  translationLine: number;
  sourceText: string;
  currentTranslation: string;
  suggestedFix: string;
  rationale: string;
  agentId?: string;
  needsVerification?: boolean;
}

interface FolderProofreadFinding extends ProofreadFinding {
  documentId: string;
  sourcePath: string;
  translationPath: string;
}

interface ProofreadFindingsDocument {
  schemaVersion: "1.0";
  documentId: string;
  sourcePath: string;
  translationPath: string;
  generatedAt: string;
  mode?: "montecarlo" | "split";
  findings: ProofreadFinding[];
}

interface FolderProofreadFindingsDocument {
  schemaVersion: "2.0";
  scope: ProofreadReportScope;
  generatedAt: string;
  mode?: "montecarlo" | "split";
  findings: FolderProofreadFinding[];
}

type PersistedProofreadFindingsDocument = ProofreadFindingsDocument | FolderProofreadFindingsDocument;

const findingsWriteLocks = new Map<string, Promise<void>>();

async function withFindingsWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = findingsWriteLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  findingsWriteLocks.set(filePath, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (findingsWriteLocks.get(filePath) === tail) findingsWriteLocks.delete(filePath);
  }
}

async function atomicWriteTextFile(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sourceBasename(sourcePaths: string[], documentId: string): string {
  const sourcePath = sourcePaths[0];
  return path.basename(sourcePath ?? documentId).replace(/\.[^.]+$/, "");
}

export function resolveProofreadReportDir(args: {
  outputDir: string;
  proofreadOutputDir?: string;
}): string {
  const custom = args.proofreadOutputDir?.trim();
  if (custom) {
    return resolveProjectPath(args.outputDir, custom);
  }
  return resolveProjectPath(args.outputDir, "report");
}

export function resolveProofreadReportPath(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
  kind: ProofreadReportKind;
}): string {
  const base = args.reportScope?.kind === "folder"
    ? "folder"
    : sourceBasename(args.sourcePaths, args.documentId);
  return path.join(resolveProofreadReportDir(args), `${base}.proofread.json`);
}

function legacyProofreadSummaryPath(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
}): string {
  const base = args.reportScope?.kind === "folder"
    ? "folder"
    : sourceBasename(args.sourcePaths, args.documentId);
  return path.join(resolveProofreadReportDir(args), `${base}_proofread_summary.md`);
}

export async function removeLegacyProofreadSummary(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
}): Promise<string> {
  const filePath = legacyProofreadSummaryPath(args);
  resolveProjectPath(args.outputDir, filePath);
  await rm(filePath, { force: true });
  return filePath;
}

export async function resetProofreadFindings(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
}): Promise<string> {
  const filePath = resolveProofreadReportPath({ ...args, kind: "findings_json" });
  resolveProjectPath(args.outputDir, filePath);
  await withFindingsWriteLock(filePath, async () => {
    // The findings JSON is the only current proofreading artifact. Remove the
    // retired companion from older runs while resetting either report scope.
    await removeLegacyProofreadSummary(args);
    if (args.reportScope?.kind === "folder") {
      const existing = await readExistingFindings(filePath);
      if (existing && existing.schemaVersion !== "2.0") {
        throw new Error(`Folder proofread findings file does not match schemaVersion 2.0: ${filePath}.`);
      }
      if (existing) {
        const findings = normalizeFolderFindings(
          existing.findings.filter((finding) => finding.documentId !== args.documentId)
        );
        await atomicWriteTextFile(filePath, `${JSON.stringify({
          ...existing,
          generatedAt: new Date().toISOString(),
          findings
        }, null, 2)}\n`);
      }
      return;
    }
    await rm(filePath, { force: true });
  });
  return filePath;
}

export async function snapshotProofreadFindings(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
}): Promise<ProofreadFindingsSnapshot> {
  const filePath = resolveProofreadReportPath({ ...args, kind: "findings_json" });
  resolveProjectPath(args.outputDir, filePath);
  return withFindingsWriteLock(filePath, async () => {
    try {
      const content = await readFile(filePath, "utf8");
      if (args.reportScope?.kind === "folder") {
        const existing = parseExistingFindings(content, filePath);
        if (existing.schemaVersion !== "2.0") {
          throw new Error(`Folder proofread findings file does not match schemaVersion 2.0: ${filePath}.`);
        }
        return {
          filePath,
          reportScope: args.reportScope,
          documentId: args.documentId,
          documentFindings: existing.findings.filter((finding) => finding.documentId === args.documentId),
          fileExisted: true
        };
      }
      return { filePath, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return args.reportScope?.kind === "folder"
          ? {
              filePath,
              reportScope: args.reportScope,
              documentId: args.documentId,
              documentFindings: [],
              fileExisted: false
            }
          : { filePath };
      }
      throw error;
    }
  });
}

export async function restoreProofreadFindings(snapshot: ProofreadFindingsSnapshot): Promise<void> {
  await withFindingsWriteLock(snapshot.filePath, async () => {
    if (snapshot.reportScope?.kind === "folder" && snapshot.documentId) {
      const current = await readExistingFindings(snapshot.filePath);
      if (current && current.schemaVersion !== "2.0") {
        throw new Error(`Folder proofread findings file does not match schemaVersion 2.0: ${snapshot.filePath}.`);
      }
      const retained = current?.findings.filter((finding) => finding.documentId !== snapshot.documentId) ?? [];
      const findings = normalizeFolderFindings([
        ...retained,
        ...(snapshot.documentFindings ?? [])
      ]);
      if (findings.length === 0 && snapshot.fileExisted === false) {
        await rm(snapshot.filePath, { force: true });
        return;
      }
      await mkdir(path.dirname(snapshot.filePath), { recursive: true });
      const document: FolderProofreadFindingsDocument = {
        schemaVersion: "2.0",
        scope: snapshot.reportScope,
        generatedAt: new Date().toISOString(),
        ...(current?.schemaVersion === "2.0" && current.mode ? { mode: current.mode } : {}),
        findings
      };
      await atomicWriteTextFile(snapshot.filePath, `${JSON.stringify(document, null, 2)}\n`);
      return;
    }
    if (snapshot.content === undefined) {
      await rm(snapshot.filePath, { force: true });
      return;
    }
    await mkdir(path.dirname(snapshot.filePath), { recursive: true });
    await atomicWriteTextFile(snapshot.filePath, snapshot.content);
  });
}

function parseJsonPayload(content: string): unknown {
  const text = content.trim();
  const json = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text;
  return JSON.parse(json);
}

function rawFindingRecords(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as { findings?: unknown; proposals?: unknown; issues?: unknown };
  if (Array.isArray(record.findings)) return record.findings;
  if (Array.isArray(record.proposals)) return record.proposals;
  if (Array.isArray(record.issues)) return record.issues;
  return [parsed];
}

function exactRecordString(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    if (record[name] !== undefined) {
      return typeof record[name] === "string" ? record[name] : undefined;
    }
  }
  return undefined;
}

function parseFindingsContent(content: string, chunkLabel?: string): ProofreadFinding[] {
  return rawFindingRecords(parseJsonPayload(content))
    .map((raw, index) => {
      const finding = normalizeProofreadFindingRecord(raw, index, chunkLabel);
      if (!finding || !raw || typeof raw !== "object") {
        throw new Error(`Incoming proofread finding ${index + 1} is invalid.`);
      }
      const record = raw as Record<string, unknown>;
      const exactCurrentTranslation = exactRecordString(record, [
        "currentTranslation",
        "current",
        "currentText",
        "translation",
        "targetText"
      ]);
      const exactSourceText = exactRecordString(record, ["sourceText", "source", "src", "original"]);
      const sourceLine = finding.sourceLine ?? 0;
      const normalized: ProofreadFinding = {
        id: finding.id,
        severity: finding.severity,
        type: finding.type,
        sourceLine,
        translationLine: finding.translationLine ?? sourceLine,
        sourceText: exactSourceText ?? finding.sourceText ?? "",
        currentTranslation: exactCurrentTranslation ?? finding.currentTranslation ?? "",
        suggestedFix: finding.suggestedFix,
        rationale: finding.rationale
      };
      if (finding.agentId) normalized.agentId = finding.agentId;
      if (finding.needsVerification === true) normalized.needsVerification = true;
      if (!(
        normalized.id && normalized.severity && normalized.type
        && normalized.suggestedFix && normalized.rationale
        && normalized.sourceLine > 0 && normalized.translationLine > 0
      )) {
        throw new Error(`Incoming proofread finding ${index + 1} is invalid.`);
      }
      return normalized;
    });
}

function idPrefix(finding: ProofreadFinding): string {
  return finding.id.match(/^([HML]\d?)-/i)?.[1]?.toUpperCase()
    ?? finding.severity.match(/^([HML]\d?)/i)?.[1]?.toUpperCase()
    ?? "M1";
}

function renumberDuplicateFindings<T extends ProofreadFinding>(findings: T[]): T[] {
  const maxByPrefix = new Map<string, number>();
  for (const finding of findings) {
    const match = finding.id.match(/^([HML]\d?)-(\d{3,})$/i);
    if (!match) continue;
    const prefix = match[1].toUpperCase();
    const value = Number.parseInt(match[2], 10);
    maxByPrefix.set(prefix, Math.max(maxByPrefix.get(prefix) ?? 0, value));
  }
  const seen = new Set<string>();
  return findings.map((finding) => {
    const normalized = finding.id.toUpperCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      return normalized === finding.id ? finding : { ...finding, id: normalized };
    }
    const prefix = idPrefix(finding);
    let next = (maxByPrefix.get(prefix) ?? 0) + 1;
    let id = `${prefix}-${String(next).padStart(3, "0")}`;
    while (seen.has(id)) {
      next += 1;
      id = `${prefix}-${String(next).padStart(3, "0")}`;
    }
    maxByPrefix.set(prefix, next);
    seen.add(id);
    return { ...finding, id };
  });
}

function normalizeFolderFindings(findings: FolderProofreadFinding[]): FolderProofreadFinding[] {
  const ordered = [...findings].sort((left, right) => (
    normalizedDocumentId(left.documentId).localeCompare(normalizedDocumentId(right.documentId))
    || left.sourceLine - right.sourceLine
    || left.translationLine - right.translationLine
    || left.severity.localeCompare(right.severity)
    || left.id.localeCompare(right.id)
    || left.sourcePath.localeCompare(right.sourcePath)
  ));
  return renumberDuplicateFindings(ordered);
}

function normalizedDocumentId(documentId: string): string {
  return documentId.replace(/\\/g, "/").toLowerCase();
}

function findingIdentity(finding: ProofreadFinding): string {
  return `${finding.sourceLine}:${idPrefix(finding)}`;
}

function findingSemanticValue(finding: ProofreadFinding): string {
  return JSON.stringify({
    severity: finding.severity,
    type: finding.type,
    sourceLine: finding.sourceLine,
    translationLine: finding.translationLine,
    sourceText: finding.sourceText,
    currentTranslation: finding.currentTranslation,
    suggestedFix: finding.suggestedFix,
    rationale: finding.rationale,
    needsVerification: finding.needsVerification === true
  });
}

function isHostMechanicalFinding(finding: ProofreadFinding): boolean {
  return finding.type.trim().toLowerCase() === "mechanical_scan"
    || finding.severity.trim().toUpperCase() === "M0"
    || /^M0(?:-|$)/i.test(finding.id.trim());
}

function normalizeReplacementRange(
  range: WriteProofreadFindingsArgs["replaceRange"]
): { fromLine: number; toLine: number } | undefined {
  if (!range) return undefined;
  if (
    !Number.isInteger(range.fromLine)
    || !Number.isInteger(range.toLine)
    || range.fromLine < 1
    || range.toLine < range.fromLine
  ) {
    throw new Error("replaceRange must contain positive fromLine/toLine values in ascending order.");
  }
  return range;
}

function findingTouchesRange(
  finding: ProofreadFinding,
  range: { fromLine: number; toLine: number }
): boolean {
  return (finding.sourceLine >= range.fromLine && finding.sourceLine <= range.toLine)
    || (finding.translationLine >= range.fromLine && finding.translationLine <= range.toLine);
}

function assertFindingsInsideReplacementRange(
  findings: ProofreadFinding[],
  range: { fromLine: number; toLine: number }
): void {
  for (const finding of findings) {
    if (
      finding.sourceLine < range.fromLine || finding.sourceLine > range.toLine
      || finding.translationLine < range.fromLine || finding.translationLine > range.toLine
    ) {
      throw new Error(
        `Finding ${finding.id} line ${finding.sourceLine}/${finding.translationLine} is outside replacement range ${range.fromLine}-${range.toLine}.`
      );
    }
  }
}

function normalizeMechanicalScan(
  scan: WriteProofreadFindingsArgs["mechanicalScan"],
  sourceLines: string[],
  translationLines: string[]
): { scopeLines: Set<number>; signalsByLine: Map<number, Array<{ code: string; evidence: string }>> } | undefined {
  if (!scan) return undefined;
  const scopeLines = new Set<number>();
  scan.scopeLines.forEach((line, index) => {
    if (!Number.isInteger(line) || line < 1 || line > sourceLines.length || line > translationLines.length) {
      throw new Error(`mechanicalScan.scopeLines[${index}] must bind an existing aligned line.`);
    }
    scopeLines.add(line);
  });
  const signalsByLine = new Map<number, Array<{ code: string; evidence: string }>>();
  scan.signals.forEach((signal, index) => {
    const code = String(signal.code ?? "").trim();
    const evidence = String(signal.evidence ?? "").trim();
    if (!Number.isInteger(signal.line) || !scopeLines.has(signal.line) || !code || !evidence) {
      throw new Error(`mechanicalScan.signals[${index}] must contain a scoped line, code, and evidence.`);
    }
    const entries = signalsByLine.get(signal.line) ?? [];
    if (!entries.some((entry) => entry.code === code && entry.evidence === evidence)) {
      entries.push({ code, evidence });
    }
    signalsByLine.set(signal.line, entries);
  });
  return { scopeLines, signalsByLine };
}

function mergeFindingsByIssue(args: {
  existing: ProofreadFinding[];
  incoming: ProofreadFinding[];
  excludedLines: Set<number>;
}): {
  findings: ProofreadFinding[];
  newFindingCount: number;
  duplicateFindingCount: number;
  existingChanged: boolean;
} {
  const findings: ProofreadFinding[] = [];
  const byIdentity = new Map<string, ProofreadFinding>();
  let newFindingCount = 0;
  let duplicateFindingCount = 0;
  let existingChanged = false;
  const add = (finding: ProofreadFinding, incoming: boolean) => {
    if (args.excludedLines.has(finding.sourceLine) || args.excludedLines.has(finding.translationLine)) {
      if (!incoming) existingChanged = true;
      return;
    }
    const identity = findingIdentity(finding);
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, finding);
      findings.push(finding);
      if (incoming) newFindingCount += 1;
      return;
    }
    if (findingSemanticValue(previous) !== findingSemanticValue(finding)) {
      throw new Error(
        `Conflicting proofread findings target the same line and issue code ${identity}; the parent Agent must resolve them before merge.`
      );
    }
    duplicateFindingCount += 1;
    if (!incoming) existingChanged = true;
  };
  args.existing.forEach((finding) => add(finding, false));
  args.incoming.forEach((finding) => add(finding, true));
  return { findings, newFindingCount, duplicateFindingCount, existingChanged };
}

async function readBoundSourceLines(args: WriteProofreadFindingsArgs): Promise<string[]> {
  const sourcePath = args.sourcePaths[0];
  if (!sourcePath) {
    throw new Error("A bound source file is required for proofreading findings.");
  }
  try {
    return splitTextLines(await readFile(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read bound source file ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readBoundTranslationLines(args: WriteProofreadFindingsArgs): Promise<string[]> {
  const translationPath = args.translationPath?.trim()
    ? path.resolve(args.translationPath)
    : resolveTranslationCandidatePath({
        outputDir: args.outputDir,
        sourcePaths: args.sourcePaths,
        documentId: args.documentId
      });
  try {
    return splitTextLines(await readFile(translationPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read bound translation file ${translationPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function bindFindingAlignedTexts(
  findings: ProofreadFinding[],
  sourceLines: string[],
  translationLines: string[]
): ProofreadFinding[] {
  return findings.map((finding) => {
    if (finding.sourceLine > sourceLines.length) {
      throw new Error(
        `Finding ${finding.id} sourceLine ${finding.sourceLine} is out of bounds for ${sourceLines.length} source lines.`
      );
    }
    if (finding.translationLine > translationLines.length) {
      throw new Error(
        `Finding ${finding.id} translationLine ${finding.translationLine} is out of bounds for ${translationLines.length} translation lines.`
      );
    }
    if (finding.sourceLine !== finding.translationLine) {
      throw new Error(
        `Finding ${finding.id} must bind sourceLine and translationLine to the same aligned line.`
      );
    }
    return {
      ...finding,
      sourceText: sourceLines[finding.sourceLine - 1] ?? "",
      currentTranslation: translationLines[finding.translationLine - 1] ?? ""
    };
  });
}

function refreshMergedFindings(
  findings: ProofreadFinding[],
  incoming: ProofreadFinding[],
  sourceLines: string[],
  translationLines: string[]
): ProofreadFinding[] {
  const incomingIdentities = new Set(incoming.map(findingIdentity));
  return bindFindingAlignedTexts(findings, sourceLines, translationLines).filter((finding) => (
    incomingIdentities.has(findingIdentity(finding))
    || proofreadSuggestedFixChangesTranslation(finding)
  ));
}

function assertSourceBindings(findings: ProofreadFinding[], sourceLines: string[]): void {
  for (const finding of findings) {
    if (finding.sourceLine > sourceLines.length) {
      throw new Error(
        `Finding ${finding.id} sourceLine ${finding.sourceLine} is out of bounds for ${sourceLines.length} source lines.`
      );
    }
    if (finding.sourceText !== sourceLines[finding.sourceLine - 1]) {
      throw new Error(`Finding ${finding.id} sourceText does not exactly match bound source line ${finding.sourceLine}.`);
    }
  }
}

function assertTranslationBindings(findings: ProofreadFinding[], translationLines: string[]): void {
  for (const finding of findings) {
    if (finding.sourceLine !== finding.translationLine) {
      throw new Error(
        `Finding ${finding.id} must bind sourceLine and translationLine to the same aligned line.`
      );
    }
    if (finding.translationLine > translationLines.length) {
      throw new Error(
        `Finding ${finding.id} translationLine ${finding.translationLine} is out of bounds for ${translationLines.length} translation lines.`
      );
    }
    if (finding.currentTranslation !== translationLines[finding.translationLine - 1]) {
      throw new Error(
        `Finding ${finding.id} currentTranslation does not exactly match bound translation line ${finding.translationLine}.`
      );
    }
  }
}

function leadingControlPrefix(text: string): string {
  return text.match(/^(?:\[[^\]\r\n]+\])+/u)?.[0] ?? "";
}

export function proofreadSuggestedFixPreservesControlPrefix(args: {
  sourceText: string;
  currentTranslation: string;
  suggestedFix: string;
}): boolean {
  const sourcePrefix = leadingControlPrefix(args.sourceText);
  const currentPrefix = leadingControlPrefix(args.currentTranslation);
  const requiredPrefix = sourcePrefix || currentPrefix;
  return leadingControlPrefix(args.suggestedFix) === requiredPrefix;
}

export function proofreadSuggestedFixChangesTranslation(args: {
  currentTranslation: string;
  suggestedFix: string;
}): boolean {
  return args.suggestedFix !== args.currentTranslation;
}

function assertSuggestedFixControlPrefixes(findings: ProofreadFinding[]): void {
  for (const finding of findings) {
    if (proofreadSuggestedFixPreservesControlPrefix(finding)) continue;
    const requiredPrefix = leadingControlPrefix(finding.sourceText)
      || leadingControlPrefix(finding.currentTranslation);
    throw new Error(
      `Finding ${finding.id} suggestedFix must preserve the exact leading control prefix ${requiredPrefix || "(none)"} on aligned line ${finding.sourceLine}.`
    );
  }
}

function assertSuggestedFixChangesTranslation(findings: ProofreadFinding[]): void {
  for (const finding of findings) {
    if (proofreadSuggestedFixChangesTranslation(finding)) continue;
    throw new Error(
      `Finding ${finding.id} suggestedFix must change the currentTranslation; identical text is a no-op on aligned line ${finding.sourceLine}.`
    );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertExistingFinding(
  value: unknown,
  index: number,
  filePath: string
): asserts value is ProofreadFinding {
  if (!value || typeof value !== "object") {
    throw new Error(`Existing proofread findings file finding ${index + 1} is invalid: ${filePath}.`);
  }
  const finding = value as Partial<ProofreadFinding>;
  const valid = isNonEmptyString(finding.id)
    && isNonEmptyString(finding.severity)
    && isNonEmptyString(finding.type)
    && Number.isInteger(finding.sourceLine)
    && Number(finding.sourceLine) > 0
    && Number.isInteger(finding.translationLine)
    && Number(finding.translationLine) > 0
    && typeof finding.sourceText === "string"
    && typeof finding.currentTranslation === "string"
    && isNonEmptyString(finding.suggestedFix)
    && isNonEmptyString(finding.rationale)
    && (finding.agentId === undefined || typeof finding.agentId === "string")
    && (finding.needsVerification === undefined || typeof finding.needsVerification === "boolean");
  if (!valid) {
    throw new Error(`Existing proofread findings file finding ${index + 1} is invalid: ${filePath}.`);
  }
}

function parseExistingFindings(content: string, filePath: string): PersistedProofreadFindingsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Existing proofread findings file contains invalid JSON: ${filePath}. ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Existing proofread findings file does not contain an object: ${filePath}.`);
  }
  const document = parsed as Record<string, unknown>;
  if (!Array.isArray(document.findings)) {
    throw new Error(`Existing proofread findings file has no findings array: ${filePath}.`);
  }
  if (document.schemaVersion === "1.0") {
    if (
      !isNonEmptyString(document.documentId)
      || !isNonEmptyString(document.sourcePath)
      || !isNonEmptyString(document.translationPath)
      || !isNonEmptyString(document.generatedAt)
    ) {
      throw new Error(`Existing proofread findings file metadata is invalid: ${filePath}.`);
    }
    document.findings.forEach((finding, index) => assertExistingFinding(finding, index, filePath));
    return document as unknown as ProofreadFindingsDocument;
  }
  if (document.schemaVersion === "2.0") {
    const scope = document.scope as Partial<ProofreadReportScope> | undefined;
    if (
      scope?.kind !== "folder"
      || !isNonEmptyString(scope.sourcePath)
      || !isNonEmptyString(document.generatedAt)
    ) {
      throw new Error(`Existing folder proofread findings metadata is invalid: ${filePath}.`);
    }
    document.findings.forEach((finding, index) => {
      assertExistingFinding(finding, index, filePath);
      const folderFinding = finding as Partial<FolderProofreadFinding>;
      if (
        !isNonEmptyString(folderFinding.documentId)
        || !isNonEmptyString(folderFinding.sourcePath)
        || !isNonEmptyString(folderFinding.translationPath)
      ) {
        throw new Error(`Existing folder proofread finding ${index + 1} metadata is invalid: ${filePath}.`);
      }
    });
    return document as unknown as FolderProofreadFindingsDocument;
  }
  throw new Error(`Existing proofread findings file has an unsupported schemaVersion: ${filePath}.`);
}

async function readExistingFindings(filePath: string): Promise<PersistedProofreadFindingsDocument | undefined> {
  try {
    return parseExistingFindings(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.includes(filePath)) throw error;
    throw new Error(
      `Unable to read existing proofread findings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function writeFindingsJson(filePath: string, args: WriteProofreadFindingsArgs): Promise<{
  created: boolean;
  appended: boolean;
  incomingFindingCount: number;
  newFindingCount: number;
  duplicateFindingCount: number;
  replacedFindingCount: number;
  totalFindingCount: number;
}> {
  const incoming = parseFindingsContent(String(args.content ?? "[]"), args.chunkLabel);
  if (incoming.some(isHostMechanicalFinding)) {
    throw new Error("Incoming model findings cannot define Host-owned mechanical scan entries.");
  }
  const dropFindingIds = [...new Set((args.dropFindingIds ?? []).map((id, index) => {
    const value = id.trim();
    if (!value) throw new Error(`dropFindingIds[${index}] must be a non-empty finding id.`);
    return value;
  }))];
  const replaceRange = normalizeReplacementRange(args.replaceRange);
  if (args.replaceDocument && replaceRange) {
    throw new Error("replaceDocument and replaceRange cannot be used together.");
  }
  if (replaceRange) assertFindingsInsideReplacementRange(incoming, replaceRange);
  const excludedLines = new Set((args.excludedLines ?? []).map((line, index) => {
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`excludedLines[${index}] must be a positive integer.`);
    }
    return line;
  }));
  return withFindingsWriteLock(filePath, async () => {
    const sourceLines = await readBoundSourceLines(args);
    const translationLines = await readBoundTranslationLines(args);
    const existing = await readExistingFindings(filePath);
    const base = sourceBasename(args.sourcePaths, args.documentId);
    const sourcePath = path.resolve(args.sourcePaths[0]);
    const translationPath = args.translationPath?.trim()
      ? path.resolve(args.translationPath)
      : resolveTranslationCandidatePath({
          outputDir: args.outputDir,
          sourcePaths: args.sourcePaths,
          documentId: args.documentId
        });
    const pathKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const folderScope = args.reportScope?.kind === "folder"
      ? { kind: "folder" as const, sourcePath: path.resolve(args.reportScope.sourcePath) }
      : undefined;
    if (folderScope && existing?.schemaVersion === "1.0") {
      throw new Error(`Folder proofread findings file does not match schemaVersion 2.0: ${filePath}.`);
    }
    if (!folderScope && existing?.schemaVersion === "2.0") {
      throw new Error(`Single-file proofread findings file does not match schemaVersion 1.0: ${filePath}.`);
    }
    if (folderScope && existing?.schemaVersion === "2.0") {
      if (pathKey(path.resolve(existing.scope.sourcePath)) !== pathKey(folderScope.sourcePath)) {
        throw new Error(`Existing folder proofread report is bound to a different source folder: ${filePath}.`);
      }
      const existingDocumentFindings = existing.findings.filter(
        (finding) => finding.documentId === args.documentId
      );
      for (const finding of existingDocumentFindings) {
        if (
          pathKey(path.resolve(finding.sourcePath)) !== pathKey(sourcePath)
          || pathKey(path.resolve(finding.translationPath)) !== pathKey(translationPath)
        ) {
          throw new Error(
            `Existing proofread report is bound to different source or translation path metadata: ${filePath}.`
          );
        }
      }
    }
    if (!folderScope && existing?.schemaVersion === "1.0") {
      const boundSourcePath = path.resolve(args.outputDir, existing.sourcePath);
      const boundTranslationPath = path.resolve(args.outputDir, existing.translationPath);
      if (
        existing.documentId !== base
        || pathKey(boundSourcePath) !== pathKey(sourcePath)
        || pathKey(boundTranslationPath) !== pathKey(translationPath)
      ) {
        throw new Error(
          `Existing proofread report is bound to different source or translation path metadata: ${filePath}.`
        );
      }
    }
    incoming.splice(0, incoming.length, ...bindFindingAlignedTexts(incoming, sourceLines, translationLines));
    assertSourceBindings(incoming, sourceLines);
    assertTranslationBindings(incoming, translationLines);
    const mechanicalScan = normalizeMechanicalScan(args.mechanicalScan, sourceLines, translationLines);
    assertSuggestedFixControlPrefixes(incoming);
    assertSuggestedFixChangesTranslation(incoming);
    const existingFindings: ProofreadFinding[] = folderScope
      ? existing?.schemaVersion === "2.0"
        ? existing.findings.filter((finding) => finding.documentId === args.documentId)
        : []
      : existing?.schemaVersion === "1.0"
        ? existing.findings
        : [];
    if (dropFindingIds.length > 0) {
      const knownIds = new Set(existingFindings.map((finding) => finding.id));
      for (const id of dropFindingIds) {
        if (!knownIds.has(id)) {
          throw new Error(`dropFindingIds names unknown finding ${id}.`);
        }
      }
    }
    if (args.replaceDocument && incoming.length === 0 && dropFindingIds.length === 0 && existingFindings.length > 0) {
      throw new Error(
        `Refusing to replace ${existingFindings.length} existing proofread finding(s) with an empty list. `
          + "After Host-planned children write findings, call finalizeProofreadReport. "
          + "Use dropFindingIds to remove specific false positives."
      );
    }
    const rangeRetainedExisting = (args.replaceDocument
      ? []
      : replaceRange
        ? existingFindings.filter((finding) => !findingTouchesRange(finding, replaceRange))
        : existingFindings
    ).filter((finding) => !dropFindingIds.includes(finding.id));
    const retainedExisting = mechanicalScan
      ? rangeRetainedExisting.filter((finding) => (
          !isHostMechanicalFinding(finding) || !mechanicalScan.scopeLines.has(finding.sourceLine)
        ))
      : rangeRetainedExisting;
    const replacedFindingCount = existingFindings.length - retainedExisting.length;
    const merged = mergeFindingsByIssue({
      existing: retainedExisting,
      incoming,
      excludedLines
    });
    const findings = refreshMergedFindings(merged.findings, incoming, sourceLines, translationLines);
    assertSourceBindings(findings, sourceLines);
    assertTranslationBindings(findings, translationLines);
    const appended = Boolean(args.replaceDocument)
      || !existing
      || merged.newFindingCount > 0
      || merged.existingChanged
      || replacedFindingCount > 0
      || JSON.stringify(findings) !== JSON.stringify(merged.findings);
    if (appended) {
      const document: PersistedProofreadFindingsDocument = folderScope
        ? {
            schemaVersion: "2.0",
            scope: folderScope,
            generatedAt: new Date().toISOString(),
            mode: args.mode === "montecarlo" ? "montecarlo" : "split",
            findings: normalizeFolderFindings([
              ...(existing?.schemaVersion === "2.0"
                ? existing.findings.filter((finding) => finding.documentId !== args.documentId)
                : []),
              ...findings.map((finding) => ({
                ...finding,
                documentId: args.documentId,
                sourcePath,
                translationPath
              }))
            ])
          }
        : {
            schemaVersion: "1.0",
            documentId: base,
            sourcePath,
            translationPath,
            generatedAt: new Date().toISOString(),
            mode: args.mode === "montecarlo" ? "montecarlo" : "split",
            findings: renumberDuplicateFindings(findings)
          };
      await atomicWriteTextFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
    }
    return {
      created: !existing,
      appended,
      incomingFindingCount: incoming.length,
      newFindingCount: merged.newFindingCount,
      duplicateFindingCount: merged.duplicateFindingCount,
      replacedFindingCount,
      totalFindingCount: findings.length
    };
  });
}

export async function summarizeProofreadFindingsArtifact(args: {
  outputDir: string;
  sourcePaths: string[];
  documentId: string;
  proofreadOutputDir?: string;
  reportScope?: ProofreadReportScope;
}): Promise<{ path: string; exists: boolean; findingCount: number }> {
  const filePath = resolveProofreadReportPath({ ...args, kind: "findings_json" });
  resolveProjectPath(args.outputDir, filePath);
  const existing = await readExistingFindings(filePath);
  if (!existing) return { path: filePath, exists: false, findingCount: 0 };
  const findings = args.reportScope?.kind === "folder" && existing.schemaVersion === "2.0"
    ? existing.findings.filter((finding) => finding.documentId === args.documentId)
    : existing.findings;
  return { path: filePath, exists: true, findingCount: findings.length };
}

export async function writeProofreadFindings(args: WriteProofreadFindingsArgs): Promise<WriteProofreadFindingsResult> {
  const content = String(args.content ?? "").trim();
  const dropFindingIds = args.dropFindingIds ?? [];
  if (!content && dropFindingIds.length === 0) {
    return {
      ok: false,
      kind: args.kind,
      appended: false,
      created: false,
      error: "Content is empty."
    };
  }

  let filePath: string;
  try {
    filePath = resolveProofreadReportPath(args);
    resolveProjectPath(args.outputDir, filePath);
  } catch (error) {
    return {
      ok: false,
      kind: args.kind,
      appended: false,
      created: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  let created = false;
  let appended = true;
  let findingCounts: Pick<WriteProofreadFindingsResult,
    "incomingFindingCount" | "newFindingCount" | "duplicateFindingCount" | "replacedFindingCount" | "totalFindingCount"> = {};
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const result = await writeFindingsJson(filePath, args);
    created = result.created;
    appended = result.appended;
    findingCounts = result;
  } catch (error) {
    return {
      ok: false,
      kind: args.kind,
      appended: false,
      created: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  let relativePath = filePath;
  try {
    relativePath = path.relative(args.outputDir, filePath).replace(/\\/g, "/");
  } catch {
    // keep absolute
  }

  return {
    ok: true,
    path: filePath,
    relativePath,
    kind: args.kind,
    appended,
    created,
    ...findingCounts
  };
}
