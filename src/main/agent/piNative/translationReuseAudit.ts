import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { writeTextFileAtomically } from "../../atomicFile.ts";
import {
  resolveTranslationCandidatePath,
  withTranslationCandidateLock
} from "../writeTranslationChunk.ts";
import {
  createTranslationPreservedPayloadStripper,
  splitTextLines,
  validateTranslationCandidate,
  type ValidationOptions
} from "../../../shared/validation/translationValidator.ts";
import { buildProofreadDeterministicSignals } from "./proofreadPrescan.ts";

const AUDIT_STORE = path.join(".translation-workshop", "translation-reuse-audits.json");
const AUDIT_BACKUPS = path.join(".translation-workshop", "translation-reuse-backups");
const AUDIT_VERDICTS = path.join(".translation-workshop", "translation-reuse-audit-verdicts");
const DETERMINISTIC_RETRANSLATION_CODES = new Set([
  "line_count_mismatch",
  "placeholder_mismatch",
  "tag_mismatch",
  "generic_translation_placeholder",
  "empty_line_displaced"
]);

export type TranslationReuseVerdict = "reuse" | "retranslate";
type PersistedTranslationReuseVerdict = TranslationReuseVerdict | "review";
export type TranslationReuseDecision = "reuse_accepted" | "discard_existing";
type PersistedTranslationReuseDecision = TranslationReuseDecision | "reuse_accepted_and_review";

interface TranslationReuseLineRecord {
  line: number;
  deterministicDisposition: "semantic_review_required" | "must_retranslate" | "automatic_reuse";
  deterministicCodes: string[];
  semanticSignals: string[];
  verdict?: PersistedTranslationReuseVerdict;
  reason?: string;
}

interface TranslationReuseAuditDocument {
  documentId: string;
  sourcePath: string;
  candidatePath: string;
  sourceHash: string;
  candidateHash: string;
  sourceLineCount: number;
  candidateLineCount: number;
  languagePair?: string;
  lines: TranslationReuseLineRecord[];
}

interface TranslationReuseAuditRecord {
  id: string;
  ownerSessionId?: string;
  createdAt: number;
  updatedAt: number;
  status: "auditing" | "awaiting_user_decision" | "applied";
  document: TranslationReuseAuditDocument;
  appliedDecision?: PersistedTranslationReuseDecision;
  backupPath?: string;
  resultCandidateHash?: string;
}

interface TranslationReuseAuditStore {
  version: 1;
  audits: TranslationReuseAuditRecord[];
}

export interface PrepareTranslationReuseAuditInput {
  outputDir: string;
  ownerSessionId?: string;
  sourcePath: string;
  candidatePath: string;
  documentId: string;
  languagePair?: string;
  validationOptions?: ValidationOptions;
}

export interface TranslationReuseAuditEntryInput {
  line: number;
  verdict: TranslationReuseVerdict;
  reason: string;
}

interface PersistedTranslationReuseAuditEntryInput {
  line: number;
  verdict: PersistedTranslationReuseVerdict;
  reason: string;
}

export interface TranslationReuseAuditTaskRange {
  auditId: string;
  documentId: string;
  fromLine: number;
  toLine: number;
  lines: number[];
}

export interface AppliedTranslationReuseTaskRange {
  documentId: string;
  fromLine: number;
  toLine: number;
}

export interface AppliedTranslationReuseAuditEvidence extends ReturnType<typeof summary> {
  sourcePath: string;
  candidatePath: string;
  sourceHash: string;
  resultCandidateHash: string;
  retainedLines: number[];
  retranslationLines: number[];
}

const auditLocks = new Map<string, Promise<void>>();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function appliedReuseBaselineHash(record: TranslationReuseAuditRecord, candidateText: string): string {
  if (!record.appliedDecision) throw new Error("Applied translation reuse decision is missing.");
  const retained = new Set(record.document.lines
    .filter((line) => retainsLine(line, record.appliedDecision!))
    .map((line) => line.line));
  const maskedLines = splitTextLines(candidateText).map((line, index) => (
    retained.has(index + 1) ? line : ""
  ));
  return sha256(`${maskedLines.join("\n")}${/\r?\n$/u.test(candidateText) ? "\n" : ""}`);
}

export async function refreshAppliedReuseBaseline(input: {
  outputDir: string;
  documentId: string;
  candidatePath: string;
}): Promise<boolean> {
  const documentId = input.documentId.trim();
  if (!documentId) return false;
  const candidatePath = path.resolve(input.candidatePath);
  return withAuditLock(input.outputDir, async () => {
    const store = await readStore(input.outputDir);
    const record = store.audits
      .filter((audit) => (
        audit.document.documentId === documentId
        && audit.status === "applied"
        && audit.resultCandidateHash
        && audit.appliedDecision
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!record) return false;
    let auditCandidatePath: string;
    try {
      auditCandidatePath = (await validatedAuditPaths(input.outputDir, record)).candidatePath;
    } catch {
      return false;
    }
    if (path.resolve(auditCandidatePath) !== candidatePath) return false;
    const candidateText = await readFile(candidatePath, "utf8");
    const nextHash = appliedReuseBaselineHash(record, candidateText);
    if (nextHash === record.resultCandidateHash) return false;
    record.resultCandidateHash = nextHash;
    record.updatedAt = Date.now();
    await writeStore(input.outputDir, store);
    return true;
  });
}

function auditStorePath(outputDir: string): string {
  return path.join(path.resolve(outputDir), AUDIT_STORE);
}

function auditVerdictPath(outputDir: string, auditId: string): string {
  return path.join(path.resolve(outputDir), AUDIT_VERDICTS, `${sha256(auditId)}.jsonl`);
}

function isSameOrInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertProjectSourcePath(outputDir: string, sourcePath: string): string {
  const root = path.resolve(outputDir);
  const source = path.resolve(sourcePath);
  if (source === root || !isSameOrInside(root, source)) {
    throw new Error(`Translation reuse source must be a project file: ${source}.`);
  }
  return source;
}

function assertProjectCandidatePath(
  outputDir: string,
  candidatePath: string,
  sourcePath?: string,
  documentId?: string
): string {
  const root = path.resolve(outputDir, "AI_translation");
  const candidate = path.resolve(candidatePath);
  if (candidate === root || !isSameOrInside(root, candidate)) {
    throw new Error(`Translation reuse candidate must be a project translation artifact: ${candidate}.`);
  }
  if (sourcePath && documentId) {
    const expected = path.resolve(resolveTranslationCandidatePath({
      outputDir,
      sourcePaths: [sourcePath],
      documentId
    }));
    if (candidate !== expected) {
      throw new Error(`Translation reuse candidate does not match the canonical artifact for ${documentId}: ${candidate}.`);
    }
  }
  return candidate;
}

async function assertPhysicalSourcePath(outputDir: string, sourcePath: string): Promise<void> {
  const [projectRoot, source] = await Promise.all([
    realpath(path.resolve(outputDir)),
    realpath(sourcePath)
  ]);
  if (source === projectRoot || !isSameOrInside(projectRoot, source)) {
    throw new Error(`Translation reuse source crosses the physical project boundary: ${sourcePath}.`);
  }
}

async function assertPhysicalCandidatePath(outputDir: string, candidatePath: string): Promise<void> {
  const projectPath = path.resolve(outputDir);
  const translationPath = path.resolve(outputDir, "AI_translation");
  const [projectRoot, translationRoot, candidate] = await Promise.all([
    realpath(projectPath),
    realpath(translationPath),
    realpath(candidatePath)
  ]);
  if (translationRoot === projectRoot || !isSameOrInside(projectRoot, translationRoot)) {
    throw new Error(`AI_translation crosses the physical project boundary: ${translationPath}.`);
  }
  if (candidate === translationRoot || !isSameOrInside(translationRoot, candidate)) {
    throw new Error(`Translation reuse candidate crosses the physical project translation artifact boundary: ${candidatePath}.`);
  }
}

async function assertPhysicalProjectDirectory(outputDir: string, directory: string, label: string): Promise<void> {
  const [projectRoot, physicalDirectory] = await Promise.all([
    realpath(path.resolve(outputDir)),
    realpath(directory)
  ]);
  if (physicalDirectory === projectRoot || !isSameOrInside(projectRoot, physicalDirectory)) {
    throw new Error(`${label} crosses the physical project boundary: ${directory}.`);
  }
}

async function ensureHashBoundCandidateBackup(
  outputDir: string,
  candidateText: string,
  expectedHash = sha256(candidateText)
): Promise<string> {
  const actualHash = sha256(candidateText);
  if (actualHash !== expectedHash) {
    throw new Error("Translation reuse candidate hash changed before backup.");
  }
  const backupDir = path.join(path.resolve(outputDir), AUDIT_BACKUPS);
  const backupPath = path.join(backupDir, `${expectedHash}.txt`);
  await mkdir(backupDir, { recursive: true });
  await assertPhysicalProjectDirectory(outputDir, backupDir, "Translation reuse backup directory");
  try {
    const existing = await readFile(backupPath, "utf8");
    if (sha256(existing) !== expectedHash) {
      throw new Error(`Translation reuse backup integrity check failed: ${backupPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeTextFileAtomically(backupPath, candidateText);
    const persisted = await readFile(backupPath, "utf8");
    if (sha256(persisted) !== expectedHash) {
      throw new Error(`Translation reuse backup integrity check failed after write: ${backupPath}`);
    }
  }
  return backupPath;
}

async function validatedAuditPaths(outputDir: string, record: TranslationReuseAuditRecord) {
  const sourcePath = assertProjectSourcePath(outputDir, record.document.sourcePath);
  const candidatePath = assertProjectCandidatePath(
    outputDir,
    record.document.candidatePath,
    sourcePath,
    record.document.documentId
  );
  if (record.backupPath) {
    const backupRoot = path.resolve(outputDir, AUDIT_BACKUPS);
    const backupPath = path.resolve(record.backupPath);
    if (backupPath === backupRoot || !isSameOrInside(backupRoot, backupPath)) {
      throw new Error(`Translation reuse backup must remain inside the audit backup directory: ${backupPath}.`);
    }
  }
  await Promise.all([
    assertPhysicalSourcePath(outputDir, sourcePath),
    assertPhysicalCandidatePath(outputDir, candidatePath)
  ]);
  return { sourcePath, candidatePath };
}

async function readStore(outputDir: string): Promise<TranslationReuseAuditStore> {
  try {
    const parsed = JSON.parse(await readFile(auditStorePath(outputDir), "utf8")) as TranslationReuseAuditStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.audits)) {
      throw new Error("Unsupported translation reuse audit store format.");
    }
    for (const audit of parsed.audits) {
      if (audit.status === "applied") continue;
      const baseSemanticVerdicts = new Map(
        audit.document.lines
          .filter((line) => line.deterministicDisposition === "semantic_review_required" && line.verdict)
          .map((line) => [line.line, { verdict: line.verdict!, reason: line.reason?.trim() ?? "" }] as const)
      );
      try {
        const journal = await readFile(auditVerdictPath(outputDir, audit.id), "utf8");
        const seen = new Set<number>();
        for (const row of journal.split(/\r?\n/u).filter(Boolean)) {
          const entry = JSON.parse(row) as PersistedTranslationReuseAuditEntryInput;
          replayPersistedEntry(audit, entry, seen, baseSemanticVerdicts);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      audit.status = pendingSemanticLines(audit).length === 0 ? "awaiting_user_decision" : "auditing";
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, audits: [] };
    throw error;
  }
}

async function writeStore(outputDir: string, store: TranslationReuseAuditStore): Promise<void> {
  const target = auditStorePath(outputDir);
  await mkdir(path.dirname(target), { recursive: true });
  const persisted: TranslationReuseAuditStore = {
    version: store.version,
    audits: store.audits.map((audit) => ({
      ...audit,
      document: {
        ...audit.document,
        lines: audit.document.lines.map((line) => {
          if (audit.status === "applied" || line.deterministicDisposition !== "semantic_review_required") {
            return line;
          }
          const { verdict: _verdict, reason: _reason, ...deterministicLine } = line;
          return deterministicLine;
        })
      }
    }))
  };
  await writeTextFileAtomically(target, `${JSON.stringify(persisted, null, 2)}\n`);
}

async function withAuditLock<T>(outputDir: string, operation: () => Promise<T>): Promise<T> {
  const key = auditStorePath(outputDir).toLocaleLowerCase();
  const previous = auditLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  auditLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (auditLocks.get(key) === queued) auditLocks.delete(key);
  }
}

function visibleLength(value: string): number {
  return Array.from(value.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "")).length;
}

function repetitionKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function looksLikeOpaqueResourceReference(value: string): boolean {
  return /^[0-9a-f]{16,}\.[a-z][a-z0-9_-]{0,15}$/iu.test(value.trim());
}

function hasMeaningfulLexicalProse(value: string): boolean {
  const lexical = value.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
  return /\p{L}/u.test(lexical) && !/^[っッ]+$/u.test(lexical);
}

type TargetScript = "han" | "japanese" | "hangul" | "latin" | "cyrillic" | "arabic" | "hebrew" | "thai" | "greek" | "devanagari";

function targetScript(languagePair?: string): TargetScript | undefined {
  const target = languagePair?.trim().split(/\s*(?:->|→|=>|>|—)\s*/i)[1]?.trim().toLocaleLowerCase() ?? "";
  const compact = target.replace(/[^a-z]/g, "");
  if (/^(zh|cn|chinese)/u.test(compact)) return "han";
  if (/^(ja|jp|japanese)/u.test(compact)) return "japanese";
  if (/^(ko|kr|korean)/u.test(compact)) return "hangul";
  if (/^(ru|uk|bg|sr|mk|russian|ukrainian|bulgarian|serbian|macedonian)/u.test(compact)) return "cyrillic";
  if (/^(ar|fa|ur|arabic|persian|urdu)/u.test(compact)) return "arabic";
  if (/^(he|iw|hebrew)/u.test(compact)) return "hebrew";
  if (/^(th|thai)/u.test(compact)) return "thai";
  if (/^(el|greek)/u.test(compact)) return "greek";
  if (/^(hi|mr|ne|hindi|marathi|nepali)/u.test(compact)) return "devanagari";
  if (/^(en|de|fr|es|it|pt|nl|pl|cs|sk|hu|ro|tr|vi|id|ms|english|german|french|spanish|italian|portuguese)/u.test(compact)) return "latin";
  return undefined;
}

function hasTargetScriptEvidence(value: string, languagePair?: string): boolean | undefined {
  const script = targetScript(languagePair);
  if (!script) return undefined;
  const prose = value;
  if (!/\p{L}/u.test(prose)) return undefined;
  if (script === "han") return /\p{Script=Han}/u.test(prose);
  if (script === "japanese") return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose);
  if (script === "hangul") return /\p{Script=Hangul}/u.test(prose);
  if (script === "latin") return /\p{Script=Latin}/u.test(prose);
  if (script === "cyrillic") return /\p{Script=Cyrillic}/u.test(prose);
  if (script === "arabic") return /\p{Script=Arabic}/u.test(prose);
  if (script === "hebrew") return /\p{Script=Hebrew}/u.test(prose);
  if (script === "thai") return /\p{Script=Thai}/u.test(prose);
  if (script === "greek") return /\p{Script=Greek}/u.test(prose);
  return /\p{Script=Devanagari}/u.test(prose);
}

function counts(record: TranslationReuseAuditRecord) {
  const result = { reuse: 0, retranslate: 0 };
  for (const line of record.document.lines) {
    if (line.deterministicDisposition === "automatic_reuse") result.reuse += 1;
    else if (line.deterministicDisposition === "must_retranslate") result.retranslate += 1;
    else if (line.verdict === "reuse" || line.verdict === "retranslate") result[line.verdict] += 1;
  }
  return result;
}

function pendingSemanticLines(record: TranslationReuseAuditRecord): number[] {
  return record.document.lines
    .filter((line) => (
      line.deterministicDisposition === "semantic_review_required"
      && (!line.verdict || line.verdict === "review")
    ))
    .map((line) => line.line);
}

function retainsLine(
  line: TranslationReuseLineRecord,
  decision: PersistedTranslationReuseDecision
): boolean {
  if (decision === "discard_existing") return false;
  if (line.deterministicDisposition === "automatic_reuse") return true;
  if (line.verdict === "reuse") return true;
  return decision === "reuse_accepted_and_review" && line.verdict === "review";
}

function summary(record: TranslationReuseAuditRecord) {
  const pending = pendingSemanticLines(record);
  const appliedFullyReused = record.status === "applied" && record.appliedDecision
    ? record.document.lines.every((line) => retainsLine(line, record.appliedDecision!))
    : undefined;
  return {
    auditId: record.id,
    status: record.status,
    documentId: record.document.documentId,
    sourceLineCount: record.document.sourceLineCount,
    candidateLineCount: record.document.candidateLineCount,
    pendingSemanticLineCount: pending.length,
    automaticallyReusableLineCount: record.document.lines.filter((line) => line.deterministicDisposition === "automatic_reuse").length,
    deterministicRetranslationLineCount: record.document.lines.filter((line) => line.deterministicDisposition === "must_retranslate").length,
    readyForUserDecision: record.status === "awaiting_user_decision",
    ...(appliedFullyReused === undefined ? {} : { appliedFullyReused }),
    counts: counts(record)
  };
}

async function assertCurrentHashes(outputDir: string, record: TranslationReuseAuditRecord): Promise<{
  sourceText: string;
  candidateText: string;
}> {
  const { sourcePath, candidatePath } = await validatedAuditPaths(outputDir, record);
  const [sourceText, candidateText] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(candidatePath, "utf8")
  ]);
  if (sha256(sourceText) !== record.document.sourceHash) {
    throw new Error("The source changed after the translation reuse audit was created. Start a new audit.");
  }
  if (sha256(candidateText) !== record.document.candidateHash) {
    throw new Error("The translation candidate changed after the translation reuse audit was created. Start a new audit.");
  }
  return { sourceText, candidateText };
}

function requireAudit(
  store: TranslationReuseAuditStore,
  auditId: string,
  ownerSessionId?: string
): TranslationReuseAuditRecord {
  const record = store.audits.find((audit) => audit.id === auditId);
  if (!record) throw new Error(`Unknown translation reuse audit: ${auditId}.`);
  const normalizedOwnerSessionId = ownerSessionId?.trim();
  if (normalizedOwnerSessionId && record.ownerSessionId !== normalizedOwnerSessionId) {
    throw new Error("Translation reuse audit belongs to a different Pi session.");
  }
  return record;
}

function validateAndApplyEntry(
  record: TranslationReuseAuditRecord,
  entry: TranslationReuseAuditEntryInput,
  seen: Set<number>
): void {
  validateEntryShape(record, entry, false);
  if (seen.has(entry.line)) throw new Error(`Duplicate translation reuse audit line: ${entry.line}.`);
  seen.add(entry.line);
  applyEntry(record, entry);
}

function validateEntryShape(
  record: TranslationReuseAuditRecord,
  entry: PersistedTranslationReuseAuditEntryInput,
  allowLegacyReview: boolean
): void {
  if (!Number.isInteger(entry.line) || entry.line < 1 || entry.line > record.document.sourceLineCount) {
    throw new Error(`Invalid translation reuse audit line: ${entry.line}.`);
  }
  if (!entry.reason || typeof entry.reason !== "string" || !entry.reason.trim()) {
    throw new Error(`Translation reuse audit L${entry.line} requires a concrete reason.`);
  }
  if (
    entry.verdict !== "reuse"
    && entry.verdict !== "retranslate"
    && !(allowLegacyReview && entry.verdict === "review")
  ) {
    throw new Error(`Invalid translation reuse audit verdict for L${entry.line}.`);
  }
}

function applyEntry(
  record: TranslationReuseAuditRecord,
  entry: PersistedTranslationReuseAuditEntryInput
): void {
  const target = record.document.lines[entry.line - 1];
  if (target.deterministicDisposition === "semantic_review_required" && target.verdict) {
    if (target.verdict === "review" && entry.verdict !== "review") {
      target.verdict = entry.verdict;
      target.reason = entry.reason.trim();
      return;
    }
    throw new Error(`Translation reuse audit L${entry.line} already has a semantic verdict.`);
  }
  if (target.deterministicDisposition === "must_retranslate" && entry.verdict !== "retranslate") {
    throw new Error(`Translation reuse audit L${entry.line} must be retranslated because host structural checks failed.`);
  }
  if (target.deterministicDisposition === "automatic_reuse" && entry.verdict !== "reuse") {
    throw new Error(`Translation reuse audit L${entry.line} passed the host quick scan and must remain reusable.`);
  }
  target.verdict = entry.verdict;
  target.reason = entry.reason.trim();
}

function replayPersistedEntry(
  record: TranslationReuseAuditRecord,
  entry: PersistedTranslationReuseAuditEntryInput,
  seen: Set<number>,
  baseSemanticVerdicts: Map<number, { verdict: PersistedTranslationReuseVerdict; reason: string }>
): void {
  validateEntryShape(record, entry, true);
  const target = record.document.lines[entry.line - 1];
  if (seen.has(entry.line)) {
    if (
      target.deterministicDisposition === "semantic_review_required"
      && target.verdict === "review"
      && entry.verdict !== "review"
    ) {
      applyEntry(record, entry);
      return;
    }
    throw new Error(`Duplicate translation reuse audit line: ${entry.line}.`);
  }
  seen.add(entry.line);

  const base = baseSemanticVerdicts.get(entry.line);
  if (base) {
    if (base.verdict === entry.verdict && base.reason === entry.reason.trim()) return;
    if (base.verdict === "review" && entry.verdict !== "review") {
      applyEntry(record, entry);
      return;
    }
    throw new Error(`Translation reuse audit L${entry.line} already has a semantic verdict.`);
  }
  applyEntry(record, entry);
}

async function prepareTranslationReuseAuditInStore(
  input: PrepareTranslationReuseAuditInput,
  store: TranslationReuseAuditStore
) {
    const source = assertProjectSourcePath(input.outputDir, input.sourcePath);
    const candidate = assertProjectCandidatePath(input.outputDir, input.candidatePath, source, input.documentId);
    await Promise.all([
      assertPhysicalSourcePath(input.outputDir, source),
      assertPhysicalCandidatePath(input.outputDir, candidate)
    ]);
    const [sourceText, candidateText] = await Promise.all([
      readFile(source, "utf8"),
      readFile(candidate, "utf8")
    ]);
    const sourceHash = sha256(sourceText);
    const candidateHash = sha256(candidateText);
    const ownerSessionId = input.ownerSessionId?.trim() || undefined;
    const ownerMatches = (audit: TranslationReuseAuditRecord) => (
      ownerSessionId === undefined || audit.ownerSessionId === ownerSessionId
    );
    const existing = store.audits.find((audit) => (
      audit.document.documentId === input.documentId
      && ownerMatches(audit)
      && audit.document.sourceHash === sourceHash
      && audit.status !== "applied"
      && audit.document.candidateHash === candidateHash
    ));
    if (existing) return { value: summary(existing), changed: false };
    const applied = store.audits
      .filter((audit) => (
        audit.document.documentId === input.documentId
        && ownerMatches(audit)
        && audit.document.sourceHash === sourceHash
        && audit.status === "applied"
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (applied) {
      if (!applied.resultCandidateHash || !applied.appliedDecision) {
        throw new Error(`Applied translation reuse evidence is incomplete for ${input.documentId}.`);
      }
      if (splitTextLines(sourceText).length !== splitTextLines(candidateText).length) {
        throw new Error(`The candidate lost line alignment after the translation reuse decision for ${input.documentId}.`);
      }
      const currentBaseline = appliedReuseBaselineHash(applied, candidateText);
      if (currentBaseline !== applied.resultCandidateHash) {
        applied.resultCandidateHash = currentBaseline;
        applied.updatedAt = Date.now();
        return { value: summary(applied), changed: true };
      }
      return { value: summary(applied), changed: false };
    }

    const sourceLines = splitTextLines(sourceText);
    const candidateLines = splitTextLines(candidateText);
    const candidateDistinctSources = new Map<string, Set<string>>();
    for (const [index, candidateLine] of candidateLines.entries()) {
      const candidateKey = repetitionKey(candidateLine);
      const sourceKey = repetitionKey(sourceLines[index] ?? "");
      if (!candidateKey || !sourceKey) continue;
      const sources = candidateDistinctSources.get(candidateKey) ?? new Set<string>();
      sources.add(sourceKey);
      candidateDistinctSources.set(candidateKey, sources);
    }
    const options: ValidationOptions = {
      ...input.validationOptions,
      languagePair: input.languagePair ?? input.validationOptions?.languagePair
    };
    const stripPreservedPayload = createTranslationPreservedPayloadStripper(options);
    const validation = validateTranslationCandidate(sourceText, candidateText, options);
    const globalBlockingFindings = validation.blocking.filter((finding) => !finding.line);
    const findingsByLine = new Map<number, {
      blocking: typeof validation.blocking;
      warnings: typeof validation.warnings;
    }>();
    for (const finding of [...validation.blocking, ...validation.warnings]) {
      if (!finding.line) continue;
      const row = findingsByLine.get(finding.line) ?? { blocking: [], warnings: [] };
      (finding.severity === "blocking" ? row.blocking : row.warnings).push(finding);
      findingsByLine.set(finding.line, row);
    }
    const prescanSignals = sourceLines.length === candidateLines.length
      ? buildProofreadDeterministicSignals({
          sourceText,
          translationText: candidateText,
          validationOptions: options,
          validationResult: validation
        })
      : [];
    const prescanByLine = new Map<number, string[]>();
    for (const signal of prescanSignals) {
      const code = signal.code === "H4"
        ? "likely_untranslated"
        : signal.code === "H7"
          ? "ai_contamination"
          : signal.code === "H9"
            ? "excessive_length_expansion"
            : undefined;
      if (!code) continue;
      const codes = prescanByLine.get(signal.line) ?? [];
      codes.push(code);
      prescanByLine.set(signal.line, codes);
    }
    const lines = sourceLines.map((source, index): TranslationReuseLineRecord => {
      const line = index + 1;
      const translation = candidateLines[index] ?? "";
      if (!source.trim() && !translation.trim()) {
        return {
          line,
          deterministicDisposition: "automatic_reuse",
          deterministicCodes: [],
          semanticSignals: [],
          verdict: "reuse",
          reason: "Aligned empty line."
        };
      }
      const lineFindings = findingsByLine.get(line) ?? { blocking: [], warnings: [] };
      const hardFindings = [
        ...globalBlockingFindings,
        ...lineFindings.blocking,
        ...lineFindings.warnings.filter((finding) => finding.code === "empty_line_displaced")
      ].filter((finding) => DETERMINISTIC_RETRANSLATION_CODES.has(finding.code));
      if (hardFindings.length > 0 || index >= candidateLines.length) {
        return {
          line,
          deterministicDisposition: "must_retranslate",
          deterministicCodes: [...new Set(hardFindings.map((finding) => finding.code))],
          semanticSignals: [],
          verdict: "retranslate",
          reason: hardFindings.map((finding) => finding.detail).join(" ") || "Missing aligned translation line."
        };
      }
      const sourceLength = visibleLength(source);
      const candidateLength = visibleLength(translation);
      const semanticSignals = [...(prescanByLine.get(line) ?? [])];
      for (const finding of [...lineFindings.blocking, ...lineFindings.warnings]) {
        if (finding.code === "likely_untranslated") semanticSignals.push("likely_untranslated");
        else if (finding.code === "glossary_missing") semanticSignals.push("glossary_mismatch");
        else if (finding.code.startsWith("character_")) semanticSignals.push("character_consistency");
        else if (finding.code === "style_forbidden_term") semanticSignals.push("style_guide_violation");
      }
      const sourceProse = stripPreservedPayload(source);
      const candidateProse = stripPreservedPayload(translation);
      const unchangedOpaqueResource = sourceProse.trim() === candidateProse.trim()
        && looksLikeOpaqueResourceReference(sourceProse);
      const sourceHasLexicalProse = !unchangedOpaqueResource && hasMeaningfulLexicalProse(sourceProse);
      const candidateHasLexicalProse = /\p{L}/u.test(candidateProse);
      if (sourceHasLexicalProse && !candidateHasLexicalProse) {
        semanticSignals.push("candidate_prose_missing");
      } else if (sourceHasLexicalProse && hasTargetScriptEvidence(candidateProse, options.languagePair) === false) {
        semanticSignals.push("target_language_not_observed");
      }
      if (
        sourceLength >= 10
        && candidateLength <= 4
        && candidateLength / Math.max(1, sourceLength) <= 0.35
      ) {
        semanticSignals.push("very_short_relative_to_source");
      }
      if (
        sourceLength >= 20
        && candidateLength > 0
        && candidateLength / Math.max(1, sourceLength) <= 0.22
      ) {
        semanticSignals.push("severe_length_compression");
      }
      const distinctSources = candidateDistinctSources.get(repetitionKey(translation))?.size ?? 0;
      if (candidateLength > 0 && distinctSources >= 3) {
        semanticSignals.push("repeated_candidate_for_distinct_sources");
      }
      const uniqueSemanticSignals = [...new Set(semanticSignals)];
      if (uniqueSemanticSignals.length === 0) {
        return {
          line,
          deterministicDisposition: "automatic_reuse",
          deterministicCodes: lineFindings.warnings.map((finding) => finding.code),
          semanticSignals: [],
          verdict: "reuse",
          reason: "Passed the host quick scan for alignment, target script, source residue, length, and repetition."
        };
      }
      return {
        line,
        deterministicDisposition: "semantic_review_required",
        deterministicCodes: lineFindings.warnings.map((finding) => finding.code),
        semanticSignals: uniqueSemanticSignals
      };
    });
    const now = Date.now();
    const record: TranslationReuseAuditRecord = {
      id: randomUUID(),
      ...(ownerSessionId ? { ownerSessionId } : {}),
      createdAt: now,
      updatedAt: now,
      status: lines.every((line) => line.deterministicDisposition !== "semantic_review_required")
        ? "awaiting_user_decision"
        : "auditing",
      document: {
        documentId: input.documentId,
        sourcePath: source,
        candidatePath: candidate,
        sourceHash,
        candidateHash,
        sourceLineCount: sourceLines.length,
        candidateLineCount: candidateLines.length,
        languagePair: input.languagePair,
        lines
      }
    };
    store.audits.push(record);
    return { value: summary(record), changed: true };
}

export async function prepareTranslationReuseAudit(input: PrepareTranslationReuseAuditInput) {
  return withAuditLock(input.outputDir, async () => {
    const store = await readStore(input.outputDir);
    const prepared = await prepareTranslationReuseAuditInStore(input, store);
    if (prepared.changed) await writeStore(input.outputDir, store);
    return prepared.value;
  });
}

export async function prepareTranslationReuseAudits(inputs: PrepareTranslationReuseAuditInput[]) {
  if (inputs.length === 0) return [];
  const outputDir = path.resolve(inputs[0].outputDir);
  if (inputs.some((input) => path.resolve(input.outputDir) !== outputDir)) {
    throw new Error("A translation reuse audit batch must belong to one output directory.");
  }
  return withAuditLock(outputDir, async () => {
    const store = await readStore(outputDir);
    const results = [];
    let changed = false;
    for (const input of inputs) {
      const prepared = await prepareTranslationReuseAuditInStore(input, store);
      results.push(prepared.value);
      changed ||= prepared.changed;
    }
    if (changed) await writeStore(outputDir, store);
    return results;
  });
}

export async function listCurrentPendingTranslationReuseAudits(input: {
  outputDir: string;
  ownerSessionId: string;
  documents: Array<{ documentId: string; sourcePath: string; candidatePath: string }>;
}) {
  const ownerSessionId = input.ownerSessionId.trim();
  if (!ownerSessionId) throw new Error("A Pi session owner is required to list pending translation reuse audits.");
  const store = await readStore(input.outputDir);
  const summaries = [];
  for (const document of input.documents) {
    const sourcePath = assertProjectSourcePath(input.outputDir, document.sourcePath);
    const candidatePath = assertProjectCandidatePath(
      input.outputDir,
      document.candidatePath,
      sourcePath,
      document.documentId
    );
    await Promise.all([
      assertPhysicalSourcePath(input.outputDir, sourcePath),
      assertPhysicalCandidatePath(input.outputDir, candidatePath)
    ]);
    const [sourceText, candidateText] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(candidatePath, "utf8")
    ]);
    const sourceHash = sha256(sourceText);
    const candidateHash = sha256(candidateText);
    const record = store.audits
      .filter((audit) => (
        audit.ownerSessionId === ownerSessionId
        && audit.status !== "applied"
        && audit.document.documentId === document.documentId
        && audit.document.sourceHash === sourceHash
        && audit.document.candidateHash === candidateHash
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (record) summaries.push(summary(record));
  }
  return summaries;
}

export async function readTranslationReuseAuditBatch(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditId: string;
  documentId: string;
  fromLine: number;
  toLine: number;
}) {
  const store = await readStore(input.outputDir);
  const record = requireAudit(store, input.auditId, input.ownerSessionId);
  if (record.document.documentId !== input.documentId) throw new Error("Translation reuse audit document mismatch.");
  if (input.fromLine < 1 || input.toLine < input.fromLine || input.toLine > record.document.sourceLineCount) {
    throw new Error(`Audit range L${input.fromLine}-L${input.toLine} is outside the source document.`);
  }
  const { sourceText, candidateText } = await assertCurrentHashes(input.outputDir, record);
  const sourceLines = splitTextLines(sourceText);
  const candidateLines = splitTextLines(candidateText);
  const contextRow = (line: number) => ({
    line,
    source: sourceLines[line - 1] ?? "",
    translation: candidateLines[line - 1] ?? ""
  });
  return {
    auditId: record.id,
    documentId: record.document.documentId,
    languagePair: record.document.languagePair,
    fromLine: input.fromLine,
    toLine: input.toLine,
    lines: record.document.lines.slice(input.fromLine - 1, input.toLine).map((entry) => ({
      line: entry.line,
      source: sourceLines[entry.line - 1] ?? "",
      translation: candidateLines[entry.line - 1] ?? "",
      deterministicDisposition: entry.deterministicDisposition,
      deterministicCodes: entry.deterministicCodes,
      semanticSignals: entry.semanticSignals ?? [],
      verdict: entry.verdict,
      reason: entry.reason
    })),
    contextBefore: Array.from(
      { length: Math.min(2, input.fromLine - 1) },
      (_, index) => contextRow(input.fromLine - Math.min(2, input.fromLine - 1) + index)
    ),
    contextAfter: Array.from(
      { length: Math.min(2, record.document.sourceLineCount - input.toLine) },
      (_, index) => contextRow(input.toLine + index + 1)
    )
  };
}

export async function readTranslationReuseAuditSelection(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditId: string;
  documentId: string;
  lines: number[];
}) {
  const selectedLines = [...new Set(input.lines)].sort((left, right) => left - right);
  if (selectedLines.length === 0 || selectedLines.length > 80) {
    throw new Error("Read between 1 and 80 selected translation reuse audit lines.");
  }
  const store = await readStore(input.outputDir);
  const record = requireAudit(store, input.auditId, input.ownerSessionId);
  if (record.document.documentId !== input.documentId) throw new Error("Translation reuse audit document mismatch.");
  if (selectedLines.some((line) => !Number.isInteger(line) || line < 1 || line > record.document.sourceLineCount)) {
    throw new Error("A selected translation reuse audit line is outside the source document.");
  }
  const { sourceText, candidateText } = await assertCurrentHashes(input.outputDir, record);
  const sourceLines = splitTextLines(sourceText);
  const candidateLines = splitTextLines(candidateText);
  const row = (line: number) => ({
    line,
    source: sourceLines[line - 1] ?? "",
    translation: candidateLines[line - 1] ?? ""
  });
  const selected = new Set(selectedLines);
  const contextLines = new Set<number>();
  for (const line of selectedLines) {
    for (let contextLine = Math.max(1, line - 2); contextLine <= Math.min(record.document.sourceLineCount, line + 2); contextLine += 1) {
      if (!selected.has(contextLine)) contextLines.add(contextLine);
    }
  }
  return {
    auditId: record.id,
    documentId: record.document.documentId,
    languagePair: record.document.languagePair,
    fromLine: selectedLines[0],
    toLine: selectedLines.at(-1)!,
    selectedLines,
    lines: selectedLines.map((line) => {
      const entry = record.document.lines[line - 1];
      return {
        ...row(line),
        deterministicDisposition: entry.deterministicDisposition,
        deterministicCodes: entry.deterministicCodes,
        semanticSignals: entry.semanticSignals ?? [],
        verdict: entry.verdict,
        reason: entry.reason
      };
    }),
    context: [...contextLines].sort((left, right) => left - right).map(row)
  };
}

export async function getTranslationReuseAuditSummary(
  outputDir: string,
  auditId: string,
  ownerSessionId?: string
) {
  const store = await readStore(outputDir);
  return summary(requireAudit(store, auditId, ownerSessionId));
}

export async function listCurrentTranslationReuseAudits(
  outputDir: string,
  ownerSessionId: string,
  retainedDocumentIds?: ReadonlySet<string>
) {
  const normalizedOwnerSessionId = ownerSessionId.trim();
  if (!normalizedOwnerSessionId) throw new Error("Translation reuse audit owner session is required.");
  const store = await readStore(outputDir);
  const current: ReturnType<typeof summary>[] = [];
  for (const record of store.audits) {
    if (record.ownerSessionId !== normalizedOwnerSessionId) continue;
    if (retainedDocumentIds && !retainedDocumentIds.has(record.document.documentId)) continue;
    if (record.status === "applied") continue;
    let sourceText: string;
    let candidateText: string;
    try {
      const paths = await validatedAuditPaths(outputDir, record);
      [sourceText, candidateText] = await Promise.all([
        readFile(paths.sourcePath, "utf8"),
        readFile(paths.candidatePath, "utf8")
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      sha256(sourceText) !== record.document.sourceHash
      || sha256(candidateText) !== record.document.candidateHash
    ) {
      continue;
    }
    current.push(summary(record));
  }
  return current;
}

export async function listAppliedTranslationReuseAudits(
  outputDir: string,
  ownerSessionId: string
): Promise<AppliedTranslationReuseAuditEvidence[]> {
  const normalizedOwnerSessionId = ownerSessionId.trim();
  if (!normalizedOwnerSessionId) throw new Error("Translation reuse audit owner session is required.");
  const store = await readStore(outputDir);
  const latestByDocument = new Map<string, TranslationReuseAuditRecord>();
  for (const record of store.audits) {
    if (record.ownerSessionId !== normalizedOwnerSessionId || record.status !== "applied") continue;
    const previous = latestByDocument.get(record.document.documentId);
    if (!previous || previous.updatedAt < record.updatedAt) {
      latestByDocument.set(record.document.documentId, record);
    }
  }

  const applied: AppliedTranslationReuseAuditEvidence[] = [];
  for (const record of latestByDocument.values()) {
    let sourceText: string;
    let candidateText: string;
    let sourcePath: string;
    let candidatePath: string;
    try {
      const paths = await validatedAuditPaths(outputDir, record);
      sourcePath = paths.sourcePath;
      candidatePath = paths.candidatePath;
      [sourceText, candidateText] = await Promise.all([
        readFile(sourcePath, "utf8"),
        readFile(candidatePath, "utf8")
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (sha256(sourceText) !== record.document.sourceHash) {
      throw new Error(`The source changed after the translation reuse decision for ${record.document.documentId}.`);
    }
    if (splitTextLines(sourceText).length !== splitTextLines(candidateText).length) {
      throw new Error(`The candidate lost line alignment after the translation reuse decision for ${record.document.documentId}.`);
    }
    if (!record.resultCandidateHash || !record.appliedDecision) continue;
    const listedBaseline = appliedReuseBaselineHash(record, candidateText);
    if (listedBaseline !== record.resultCandidateHash) {
      await refreshAppliedReuseBaseline({
        outputDir,
        documentId: record.document.documentId,
        candidatePath
      });
      record.resultCandidateHash = listedBaseline;
    }
    const retainedLines = record.document.lines
      .filter((line) => retainsLine(line, record.appliedDecision!))
      .map((line) => line.line);
    const retained = new Set(retainedLines);
    applied.push({
      ...summary(record),
      sourcePath,
      candidatePath,
      sourceHash: record.document.sourceHash,
      resultCandidateHash: record.resultCandidateHash,
      retainedLines,
      retranslationLines: record.document.lines
        .map((line) => line.line)
        .filter((line) => !retained.has(line))
    });
  }
  return applied;
}

export async function planTranslationReuseAuditTasks(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditIds: string[];
  maxLinesPerTask: number;
}): Promise<TranslationReuseAuditTaskRange[]> {
  if (!Number.isInteger(input.maxLinesPerTask) || input.maxLinesPerTask < 1) {
    throw new Error(`Invalid translation reuse audit task size: ${input.maxLinesPerTask}.`);
  }
  const store = await readStore(input.outputDir);
  const tasks: TranslationReuseAuditTaskRange[] = [];
  for (const auditId of [...new Set(input.auditIds)]) {
    const record = requireAudit(store, auditId, input.ownerSessionId);
    const pending = pendingSemanticLines(record);
    for (let index = 0; index < pending.length; index += input.maxLinesPerTask) {
      const lines = pending.slice(index, index + input.maxLinesPerTask);
      tasks.push({
        auditId,
        documentId: record.document.documentId,
        fromLine: lines[0],
        toLine: lines.at(-1)!,
        lines
      });
    }
  }
  return tasks;
}

export async function planAppliedTranslationReuseTasks(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditId: string;
  documentId: string;
  maxLinesPerTask: number;
  excludedLines?: readonly number[];
}): Promise<AppliedTranslationReuseTaskRange[]> {
  if (!Number.isInteger(input.maxLinesPerTask) || input.maxLinesPerTask < 1) {
    throw new Error(`Invalid applied translation reuse task size: ${input.maxLinesPerTask}.`);
  }
  const store = await readStore(input.outputDir);
  const record = requireAudit(store, input.auditId, input.ownerSessionId);
  if (record.status !== "applied" || !record.appliedDecision) {
    throw new Error("Apply the translation reuse decision before planning retranslation workers.");
  }
  if (record.document.documentId !== input.documentId) {
    throw new Error("Applied translation reuse audit document mismatch.");
  }
  const { sourcePath, candidatePath } = await validatedAuditPaths(input.outputDir, record);
  const [sourceText, candidateText] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(candidatePath, "utf8")
  ]);
  if (sha256(sourceText) !== record.document.sourceHash) {
    throw new Error("The source changed after the translation reuse decision was applied.");
  }
  const sourceLines = splitTextLines(sourceText);
  const candidateLines = splitTextLines(candidateText);
  if (sourceLines.length !== candidateLines.length) {
    throw new Error(
      `Applied translation reuse candidate lost line alignment: source has ${sourceLines.length} lines and candidate has ${candidateLines.length}.`
    );
  }
  if (!record.resultCandidateHash) {
    throw new Error(`Applied translation reuse evidence is incomplete for ${record.document.documentId}.`);
  }
  const plannedBaseline = appliedReuseBaselineHash(record, candidateText);
  if (plannedBaseline !== record.resultCandidateHash) {
    await refreshAppliedReuseBaseline({
      outputDir: input.outputDir,
      documentId: record.document.documentId,
      candidatePath
    });
    record.resultCandidateHash = plannedBaseline;
  }

  const excluded = new Set((input.excludedLines ?? []).map((line) => {
    if (!Number.isInteger(line) || line < 1 || line > sourceLines.length) {
      throw new Error(`Invalid excluded applied-reuse line: ${line}.`);
    }
    return line;
  }));
  // Candidate text is not completion evidence. A worker may have written a row
  // immediately before Stop, or the user may have edited it after Stop. Only the
  // caller's hash-bound Host review evidence may exclude rejected audit rows.
  const pending = record.document.lines
    .filter((line) => !retainsLine(line, record.appliedDecision!))
    .map((line) => line.line)
    .filter((line) => sourceLines[line - 1]?.trim() && !excluded.has(line));
  const tasks: AppliedTranslationReuseTaskRange[] = [];
  for (let index = 0; index < pending.length;) {
    const fromLine = pending[index];
    let toLine = fromLine;
    let count = 1;
    while (
      index + count < pending.length
      && pending[index + count] === toLine + 1
      && count < input.maxLinesPerTask
    ) {
      toLine = pending[index + count];
      count += 1;
    }
    tasks.push({ documentId: record.document.documentId, fromLine, toLine });
    index += count;
  }
  return tasks;
}

export async function recordTranslationReuseAuditBatch(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditId: string;
  documentId: string;
  entries: TranslationReuseAuditEntryInput[];
}) {
  return withAuditLock(input.outputDir, async () => {
    const store = await readStore(input.outputDir);
    const record = requireAudit(store, input.auditId, input.ownerSessionId);
    if (record.status === "applied") throw new Error("This translation reuse audit has already been applied.");
    if (record.document.documentId !== input.documentId) throw new Error("Translation reuse audit document mismatch.");
    await assertCurrentHashes(input.outputDir, record);
    const seen = new Set<number>();
    for (const entry of input.entries) {
      validateAndApplyEntry(record, entry, seen);
    }
    record.updatedAt = Date.now();
    if (pendingSemanticLines(record).length === 0) record.status = "awaiting_user_decision";
    const journalPath = auditVerdictPath(input.outputDir, record.id);
    await mkdir(path.dirname(journalPath), { recursive: true });
    await appendFile(journalPath, input.entries.map((entry) => `${JSON.stringify({
      line: entry.line,
      verdict: entry.verdict,
      reason: entry.reason.trim()
    })}\n`).join(""), "utf8");
    return summary(record);
  });
}

async function withTranslationCandidateLocks<T>(
  candidatePaths: string[],
  operation: () => Promise<T>
): Promise<T> {
  const paths = [...new Set(candidatePaths.map((candidatePath) => path.resolve(candidatePath)))]
    .sort((left, right) => left.localeCompare(right));
  const acquire = (index: number): Promise<T> => index >= paths.length
    ? operation()
    : withTranslationCandidateLock(paths[index], () => acquire(index + 1));
  return acquire(0);
}

export async function applyTranslationReuseAudits(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditIds: string[];
  decision: TranslationReuseDecision;
}) {
  const auditIds = [...new Set(input.auditIds.map((auditId) => auditId.trim()).filter(Boolean))];
  if (auditIds.length === 0) throw new Error("At least one translation reuse audit is required.");
  return withAuditLock(input.outputDir, async () => {
    const store = await readStore(input.outputDir);
    const records = auditIds.map((auditId) => requireAudit(store, auditId, input.ownerSessionId));
    const notReady = records.find((record) => record.status !== "awaiting_user_decision");
    if (notReady) {
      throw new Error(
        `Complete the semantic translation reuse audit for ${notReady.document.documentId} before applying a user decision.`
      );
    }
    const paths = await Promise.all(records.map((record) => validatedAuditPaths(input.outputDir, record)));
    return withTranslationCandidateLocks(paths.map(({ candidatePath }) => candidatePath), async () => {
      const prepared = [];
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const { candidatePath } = paths[index];
        const { sourceText, candidateText } = await assertCurrentHashes(input.outputDir, record);
        const sourceLines = splitTextLines(sourceText);
        const candidateLines = splitTextLines(candidateText);
        const retainedLines = record.document.lines
          .filter((line) => retainsLine(line, input.decision))
          .map((line) => line.line);
        const retained = new Set(retainedLines);
        const retranslationLines = sourceLines.map((_, lineIndex) => lineIndex + 1)
          .filter((line) => !retained.has(line));
        const nextLines = sourceLines.map((source, lineIndex) => {
          if (!source.trim()) return "";
          return retained.has(lineIndex + 1) ? candidateLines[lineIndex] ?? "" : "";
        });
        const backupPath = await ensureHashBoundCandidateBackup(
          input.outputDir,
          candidateText,
          record.document.candidateHash
        );
        const hadTrailingNewline = /\r?\n$/u.test(candidateText);
        prepared.push({
          record,
          candidatePath,
          candidateText,
          nextText: `${nextLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`,
          backupPath,
          retainedLines,
          retranslationLines
        });
      }

      const written = [];
      try {
        for (const item of prepared) {
          await writeTextFileAtomically(item.candidatePath, item.nextText);
          written.push(item);
        }
        const now = Date.now();
        for (const item of prepared) {
          item.record.status = "applied";
          item.record.updatedAt = now;
          item.record.appliedDecision = input.decision;
          item.record.backupPath = item.backupPath;
          item.record.resultCandidateHash = sha256(item.nextText);
        }
        await writeStore(input.outputDir, store);
      } catch (error) {
        const rollbackFailures = [];
        for (const item of written.reverse()) {
          try {
            await writeTextFileAtomically(item.candidatePath, item.candidateText);
          } catch (rollbackError) {
            rollbackFailures.push(`${item.record.document.documentId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
        if (rollbackFailures.length > 0) {
          throw new Error(
            `Translation reuse batch apply failed and rollback was incomplete: ${rollbackFailures.join("; ")}`,
            { cause: error }
          );
        }
        throw error;
      }

      const documents = prepared.map((item) => ({
        auditId: item.record.id,
        documentId: item.record.document.documentId,
        candidatePath: item.candidatePath,
        backupPath: item.backupPath,
        retainedLineCount: item.retainedLines.length,
        retranslationLineCount: item.retranslationLines.length,
        retainedLines: item.retainedLines,
        retranslationLines: item.retranslationLines,
        fullyReused: item.retranslationLines.length === 0
      }));
      return {
        decision: input.decision,
        documentCount: documents.length,
        retainedLineCount: documents.reduce((total, document) => total + document.retainedLineCount, 0),
        retranslationLineCount: documents.reduce((total, document) => total + document.retranslationLineCount, 0),
        fullyReusedDocumentCount: documents.filter((document) => document.fullyReused).length,
        documents
      };
    });
  });
}

export async function applyTranslationReuseAudit(input: {
  outputDir: string;
  ownerSessionId?: string;
  auditId: string;
  decision: TranslationReuseDecision;
}) {
  const applied = await applyTranslationReuseAudits({
    ...input,
    auditIds: [input.auditId]
  });
  const document = applied.documents[0];
  return {
    auditId: document.auditId,
    decision: input.decision,
    retainedLineCount: document.retainedLineCount,
    retranslationLineCount: document.retranslationLineCount,
    retainedLines: document.retainedLines,
    retranslationLines: document.retranslationLines,
    fullyReused: document.fullyReused,
    documents: [{ documentId: document.documentId, candidatePath: document.candidatePath }],
    backups: [{ documentId: document.documentId, path: document.backupPath }]
  };
}

export async function discardTranslationCandidateForRetranslation(input: {
  outputDir: string;
  sourcePath: string;
  candidatePath: string;
  documentId: string;
}) {
  return withAuditLock(input.outputDir, async () => {
    const sourcePath = assertProjectSourcePath(input.outputDir, input.sourcePath);
    const candidatePath = assertProjectCandidatePath(
      input.outputDir,
      input.candidatePath,
      sourcePath,
      input.documentId
    );
    return withTranslationCandidateLock(candidatePath, async () => {
      let candidateText: string;
      try {
        candidateText = await readFile(candidatePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { discarded: false, documentId: input.documentId, candidatePath };
        }
        throw error;
      }
      if (!splitTextLines(candidateText).some((line) => line.trim())) {
        return { discarded: false, documentId: input.documentId, candidatePath };
      }
      await Promise.all([
        assertPhysicalSourcePath(input.outputDir, sourcePath),
        assertPhysicalCandidatePath(input.outputDir, candidatePath)
      ]);
      const backupPath = await ensureHashBoundCandidateBackup(input.outputDir, candidateText);
      await rm(candidatePath);
      return {
        discarded: true,
        documentId: input.documentId,
        candidatePath,
        backupPath,
        discardedLineCount: splitTextLines(candidateText).length
      };
    });
  });
}
