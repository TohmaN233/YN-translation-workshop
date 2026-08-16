import { createHash } from "node:crypto";

import { splitTextLines } from "../../../shared/validation/translationValidator.ts";

export interface TranslationAlignmentCheckState {
  line: number;
  signals: string[];
  verdict?: "aligned" | "misaligned";
  reason?: string;
  warningVerdicts?: Array<{
    identity: string;
    code: string;
    sourceLineHash: string;
    candidateLineHash: string;
    referenceHash: string;
    verdict?: "aligned" | "misaligned";
    reason?: string;
  }>;
}

export interface TranslationAlignmentDocumentState {
  auditId: string;
  inputHash: string;
  candidatePath: string;
  sourceLineCount: number;
  checks: TranslationAlignmentCheckState[];
  lineHashVersion?: 2;
}

export interface TranslationAlignmentRangeState extends TranslationAlignmentDocumentState {
  documentId: string;
  fromLine: number;
  toLine: number;
  riskLineCount: number;
  sampledLineCount: number;
}

export interface TranslationAlignmentHostState {
  schemaVersion: 3;
  documents: Record<string, TranslationAlignmentDocumentState>;
  ranges: Record<string, TranslationAlignmentRangeState[]>;
}

export function isActionableTranslationAlignmentReason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const reason = value.trim();
  const separator = reason.indexOf(":");
  if (separator <= 0 || separator === reason.length - 1) return false;
  const codes = reason.slice(0, separator).trim();
  const note = reason.slice(separator + 1).trim();
  return /^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/u.test(codes) && note.length > 0;
}

export function createTranslationAlignmentHostState(): TranslationAlignmentHostState {
  return { schemaVersion: 3, documents: {}, ranges: {} };
}

export function replaceTranslationAlignmentRange(
  state: TranslationAlignmentHostState,
  documentId: string,
  replacement: TranslationAlignmentRangeState,
  expectedAuditId: string
): void {
  const current = state.ranges[documentId] ?? [];
  const replaced = current.find((scope) => (
    scope.auditId === expectedAuditId
    && scope.fromLine === replacement.fromLine
    && scope.toLine === replacement.toLine
  ));
  if (!replaced) {
    throw new Error(
      `Translation review evidence ${expectedAuditId} for ${documentId} L${replacement.fromLine}-L${replacement.toLine} is missing or stale.`
    );
  }
  state.ranges[documentId] = [
    ...current.filter((scope) => scope !== replaced),
    replacement
  ].sort((left, right) => left.fromLine - right.fromLine);
}

export function createTranslationRepairReviewAudit(
  previous: TranslationAlignmentRangeState,
  current: TranslationAlignmentRangeState
): TranslationAlignmentRangeState {
  if (
    previous.documentId !== current.documentId
    || previous.fromLine !== current.fromLine
    || previous.toLine !== current.toLine
    || previous.sourceLineCount !== current.sourceLineCount
    || previous.candidatePath !== current.candidatePath
  ) {
    throw new Error("Translation repair review scope does not match the rejected chunk.");
  }
  const rejected = previous.checks.filter((check) => check.verdict === "misaligned");
  if (rejected.length === 0) return current;
  const currentByLine = new Map(current.checks.map((check) => [check.line, check]));
  const rejectedLines = new Set(rejected.map((check) => check.line));
  const checks = previous.checks.map((check) => rejectedLines.has(check.line)
    ? {
        line: check.line,
        signals: [...new Set([
          ...(currentByLine.get(check.line)?.signals ?? []),
          "review_repair_target"
        ])]
      }
    : {
        line: check.line,
        signals: [...check.signals],
        verdict: check.verdict,
        ...(check.reason ? { reason: check.reason } : {})
      });
  const auditId = `alignment-repair-${createHash("sha256")
    .update(current.auditId)
    .update("\0")
    .update(checks.map((check) => check.line).join(","))
    .digest("hex")
    .slice(0, 20)}`;
  return {
    ...current,
    auditId,
    riskLineCount: checks.filter((check) => (
      check.signals.length !== 1 || check.signals[0] !== "deterministic_unflagged_sample"
    )).length,
    sampledLineCount: checks.filter((check) => (
      check.signals.length === 1 && check.signals[0] === "deterministic_unflagged_sample"
    )).length,
    checks
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeTranslationAlignmentState(value: unknown): TranslationAlignmentHostState {
  if (
    !isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    || !isRecord(value.documents)
  ) {
    return createTranslationAlignmentHostState();
  }
  const documents: Record<string, TranslationAlignmentDocumentState> = {};
  for (const [documentId, raw] of Object.entries(value.documents)) {
    if (!documentId.trim() || !isRecord(raw)) continue;
    if (
      typeof raw.auditId !== "string"
      || typeof raw.inputHash !== "string"
      || typeof raw.candidatePath !== "string"
      || !Number.isInteger(raw.sourceLineCount)
      || Number(raw.sourceLineCount) < 1
      || !Array.isArray(raw.checks)
    ) continue;
    const sourceLineCount = Number(raw.sourceLineCount);
    const seenLines = new Set<number>();
    const checks = raw.checks.filter((check): check is TranslationAlignmentCheckState => {
      if (
        !isRecord(check)
        || !Number.isInteger(check.line)
        || Number(check.line) < 1
        || Number(check.line) > sourceLineCount
        || seenLines.has(Number(check.line))
      ) return false;
      if (!Array.isArray(check.signals) || !check.signals.every((signal) => typeof signal === "string")) return false;
      if (check.verdict !== undefined && check.verdict !== "aligned" && check.verdict !== "misaligned") return false;
      seenLines.add(Number(check.line));
      return true;
    }).map((check) => ({
      line: check.line,
      signals: [...new Set(check.signals)],
      ...(check.verdict ? { verdict: check.verdict } : {}),
      ...(typeof check.reason === "string" ? { reason: check.reason } : {}),
      ...(Array.isArray(check.warningVerdicts) ? {
        warningVerdicts: check.warningVerdicts.flatMap((rawVerdict) => {
          if (
            !isRecord(rawVerdict)
            || typeof rawVerdict.identity !== "string"
            || typeof rawVerdict.code !== "string"
            || typeof rawVerdict.sourceLineHash !== "string"
            || typeof rawVerdict.candidateLineHash !== "string"
            || typeof rawVerdict.referenceHash !== "string"
            || (rawVerdict.verdict !== undefined
              && rawVerdict.verdict !== "aligned"
              && rawVerdict.verdict !== "misaligned")
          ) return [];
          return [{
            identity: rawVerdict.identity,
            code: rawVerdict.code,
            sourceLineHash: rawVerdict.sourceLineHash,
            candidateLineHash: rawVerdict.candidateLineHash,
            referenceHash: rawVerdict.referenceHash,
            ...(rawVerdict.verdict ? { verdict: rawVerdict.verdict } : {}),
            ...(typeof rawVerdict.reason === "string" ? { reason: rawVerdict.reason } : {})
          }];
        })
      } : {})
    }));
    documents[documentId] = {
      auditId: raw.auditId,
      inputHash: raw.inputHash,
      candidatePath: raw.candidatePath,
      sourceLineCount,
      checks,
      ...(raw.lineHashVersion === 2 ? { lineHashVersion: 2 as const } : {})
    };
  }
  const ranges: Record<string, TranslationAlignmentRangeState[]> = {};
  if ((value.schemaVersion === 2 || value.schemaVersion === 3) && isRecord(value.ranges)) {
    for (const [documentId, rawRanges] of Object.entries(value.ranges)) {
      if (!documentId.trim() || !Array.isArray(rawRanges)) continue;
      const normalized = rawRanges.flatMap((raw): TranslationAlignmentRangeState[] => {
        if (
          !isRecord(raw)
          || raw.documentId !== documentId
          || typeof raw.auditId !== "string"
          || typeof raw.inputHash !== "string"
          || typeof raw.candidatePath !== "string"
          || !Number.isInteger(raw.sourceLineCount)
          || !Number.isInteger(raw.fromLine)
          || !Number.isInteger(raw.toLine)
          || !Array.isArray(raw.checks)
        ) return [];
        const sourceLineCount = Number(raw.sourceLineCount);
        const fromLine = Number(raw.fromLine);
        const toLine = Number(raw.toLine);
        if (sourceLineCount < 1 || fromLine < 1 || toLine < fromLine || toLine > sourceLineCount) return [];
        const seen = new Set<number>();
        const checks = raw.checks.filter((check): check is TranslationAlignmentCheckState => {
          if (
            !isRecord(check)
            || !Number.isInteger(check.line)
            || Number(check.line) < fromLine
            || Number(check.line) > toLine
            || seen.has(Number(check.line))
            || !Array.isArray(check.signals)
            || !check.signals.every((signal) => typeof signal === "string")
            || (check.verdict !== undefined && check.verdict !== "aligned" && check.verdict !== "misaligned")
          ) return false;
          seen.add(Number(check.line));
          return true;
        }).map((check) => ({
          line: check.line,
          signals: [...new Set(check.signals)],
          ...(check.verdict ? { verdict: check.verdict } : {}),
          ...(typeof check.reason === "string" ? { reason: check.reason } : {})
        }));
        if (value.schemaVersion === 2 && checks.length !== toLine - fromLine + 1) return [];
        if (checks.length === 0) return [];
        const inferredRiskLineCount = checks.filter((check) => check.signals.length > 0).length;
        const riskLineCount = Number.isInteger(raw.riskLineCount)
          && Number(raw.riskLineCount) >= 0
          && Number(raw.riskLineCount) <= checks.length
          ? Number(raw.riskLineCount)
          : inferredRiskLineCount;
        const sampledLineCount = Number.isInteger(raw.sampledLineCount)
          && Number(raw.sampledLineCount) >= 0
          && Number(raw.sampledLineCount) <= checks.length - riskLineCount
          ? Number(raw.sampledLineCount)
          : checks.length - riskLineCount;
        return [{
          documentId,
          auditId: raw.auditId,
          inputHash: raw.inputHash,
          candidatePath: raw.candidatePath,
          sourceLineCount,
          fromLine,
          toLine,
          riskLineCount,
          sampledLineCount,
          checks,
          ...(raw.lineHashVersion === 2 ? { lineHashVersion: 2 as const } : {})
        }];
      });
      if (normalized.length > 0) ranges[documentId] = normalized;
    }
  }
  return { schemaVersion: 3, documents, ranges };
}

export function translationAlignmentInputHash(
  sourceText: string,
  candidateText: string,
  languagePair?: string
): string {
  return createHash("sha256")
    .update(sourceText)
    .update("\0")
    .update(candidateText)
    .update("\0")
    .update(languagePair?.trim() ?? "")
    .digest("hex");
}

export function translationAlignmentLinesInputHash(
  sourceLines: string[],
  candidateLines: string[],
  languagePair?: string
): string {
  return createHash("sha256")
    .update(JSON.stringify(sourceLines))
    .update("\0")
    .update(JSON.stringify(candidateLines))
    .update("\0")
    .update(languagePair?.trim() ?? "")
    .digest("hex");
}

interface TranslationAlignmentContentInput {
  sourceText?: string;
  candidateText?: string;
  sourceLines?: string[];
  candidateLines?: string[];
}

function explicitAlignmentContent(input: TranslationAlignmentContentInput): {
  sourceLines: string[];
  candidateLines: string[];
  explicitLines: boolean;
} {
  const usesExplicitLines = input.sourceLines !== undefined || input.candidateLines !== undefined;
  if (usesExplicitLines) {
    if (!Array.isArray(input.sourceLines) || !Array.isArray(input.candidateLines)) {
      throw new Error("Translation alignment explicit line input requires both sourceLines and candidateLines.");
    }
    const sourceLines = input.sourceLines.map((line) => String(line ?? ""));
    const candidateLines = input.candidateLines.map((line) => String(line ?? ""));
    return { sourceLines, candidateLines, explicitLines: true };
  }
  if (typeof input.sourceText !== "string" || typeof input.candidateText !== "string") {
    throw new Error("Translation alignment text input requires both sourceText and candidateText.");
  }
  return {
    sourceLines: splitTextLines(input.sourceText),
    candidateLines: splitTextLines(input.candidateText),
    explicitLines: false
  };
}

function visibleLength(value: string): number {
  return Array.from(value.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "")).length;
}

function sentenceBoundaryCount(value: string): number {
  const matches = value.normalize("NFKC").match(
    /(?:[。！？!?]+|…+|\.{3,}|\.(?=(?:["'”’」』】）)]*)?(?:\s|$)))/gu
  );
  return matches?.length ?? 0;
}

export function createTranslationAlignmentAudit(input: {
  documentId: string;
  sourceText?: string;
  candidateText?: string;
  sourceLines?: string[];
  candidateLines?: string[];
  candidatePath: string;
  languagePair?: string;
}): TranslationAlignmentDocumentState {
  const content = explicitAlignmentContent(input);
  const { sourceLines, candidateLines } = content;
  if (sourceLines.length !== candidateLines.length) {
    throw new Error(
      `Translation alignment audit requires equal line counts; source has ${sourceLines.length} and candidate has ${candidateLines.length}.`
    );
  }
  const signals = new Map<number, Set<string>>();
  const addSignal = (line: number, signal: string) => {
    if (line < 1 || line > sourceLines.length) return;
    const current = signals.get(line) ?? new Set<string>();
    current.add(signal);
    signals.set(line, current);
  };
  const candidateSources = new Map<string, Set<string>>();
  const sourceBoundaryCounts = sourceLines.map(sentenceBoundaryCount);
  const candidateBoundaryCounts = candidateLines.map(sentenceBoundaryCount);
  const normalizedLanguagePair = input.languagePair?.trim().toLocaleLowerCase() ?? "";
  const japaneseToChinese = /^(?:ja|japanese|日本語)\s*(?:->|→|=>|>|—)/u.test(normalizedLanguagePair)
    && /(?:zh|chinese|中文|汉语|漢語)/u.test(normalizedLanguagePair);
  const ratios = sourceLines.map((source, index) => {
    const sourceLength = visibleLength(source);
    const candidateLength = visibleLength(candidateLines[index] ?? "");
    const candidateKey = candidateLines[index]?.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "") ?? "";
    const sourceKey = source.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
    if (candidateKey && sourceKey) {
      const distinct = candidateSources.get(candidateKey) ?? new Set<string>();
      distinct.add(sourceKey);
      candidateSources.set(candidateKey, distinct);
    }
    const ratio = candidateLength / Math.max(1, sourceLength);
    if (sourceLength >= 12 && ratio <= 0.18) addSignal(index + 1, "severe_length_compression");
    if (sourceLength >= 8 && candidateLength >= 12 && ratio >= 2.5) addSignal(index + 1, "severe_length_expansion");
    const boundaryDifference = Math.abs(sourceBoundaryCounts[index] - candidateBoundaryCounts[index]);
    if (
      boundaryDifference >= (japaneseToChinese ? 2 : 1)
      && Math.max(sourceBoundaryCounts[index], candidateBoundaryCounts[index]) >= 2
    ) {
      addSignal(index + 1, "sentence_boundary_count_mismatch");
    }
    return ratio;
  });
  for (const [index, candidate] of candidateLines.entries()) {
    const key = candidate.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
    if (key && (candidateSources.get(key)?.size ?? 0) >= 3) {
      addSignal(index + 1, "repeated_candidate_for_distinct_sources");
    }
  }
  for (let index = 1; index < ratios.length; index += 1) {
    const previousCandidateKey = candidateLines[index - 1]
      ?.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "") ?? "";
    const currentCandidateKey = candidateLines[index]
      ?.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "") ?? "";
    const previousSourceKey = sourceLines[index - 1]
      ?.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "") ?? "";
    const currentSourceKey = sourceLines[index]
      ?.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "") ?? "";
    if (
      previousCandidateKey
      && previousCandidateKey === currentCandidateKey
      && previousSourceKey
      && currentSourceKey
      && previousSourceKey !== currentSourceKey
    ) {
      addSignal(index, "consecutive_repeated_candidate_for_distinct_sources");
      addSignal(index + 1, "consecutive_repeated_candidate_for_distinct_sources");
    }
    const smaller = Math.min(ratios[index - 1], ratios[index]);
    const larger = Math.max(ratios[index - 1], ratios[index]);
    if (smaller > 0 && larger / smaller >= 4) {
      addSignal(index, "adjacent_length_compensation");
      addSignal(index + 1, "adjacent_length_compensation");
    }
    const previousBoundaryDelta = sourceBoundaryCounts[index - 1] - candidateBoundaryCounts[index - 1];
    const currentBoundaryDelta = sourceBoundaryCounts[index] - candidateBoundaryCounts[index];
    const sourcePairTotal = sourceBoundaryCounts[index - 1] + sourceBoundaryCounts[index];
    const candidatePairTotal = candidateBoundaryCounts[index - 1] + candidateBoundaryCounts[index];
    if (
      sourcePairTotal >= 2
      && sourcePairTotal === candidatePairTotal
      && previousBoundaryDelta !== 0
      && currentBoundaryDelta !== 0
      && Math.sign(previousBoundaryDelta) !== Math.sign(currentBoundaryDelta)
    ) {
      addSignal(index, "adjacent_sentence_boundary_compensation");
      addSignal(index + 1, "adjacent_sentence_boundary_compensation");
    }
  }
  const checks = sourceLines.map((_source, index) => ({
    line: index + 1,
    signals: [...(signals.get(index + 1) ?? new Set<string>())]
  }));
  const inputHash = content.explicitLines
    ? translationAlignmentLinesInputHash(sourceLines, candidateLines, input.languagePair)
    : translationAlignmentInputHash(input.sourceText!, input.candidateText!, input.languagePair);
  return {
    auditId: `alignment-${inputHash.slice(0, 20)}`,
    inputHash,
    candidatePath: input.candidatePath,
    sourceLineCount: sourceLines.length,
    checks,
    ...(content.explicitLines ? { lineHashVersion: 2 as const } : {})
  };
}

export function createTranslationAlignmentRangeAudit(input: {
  documentId: string;
  sourceText?: string;
  candidateText?: string;
  sourceLines?: string[];
  candidateLines?: string[];
  candidatePath: string;
  languagePair?: string;
  fromLine: number;
  toLine?: number;
  sourceLineCount: number;
}): TranslationAlignmentRangeState {
  const created = createTranslationAlignmentAudit(input);
  const checkedLineCount = created.checks.length;
  const toLine = input.toLine ?? input.fromLine + checkedLineCount - 1;
  const ownedLineCount = toLine - input.fromLine + 1;
  if (
    !Number.isInteger(input.fromLine)
    || input.fromLine < 1
    || !Number.isInteger(toLine)
    || toLine < input.fromLine
    || !Number.isInteger(input.sourceLineCount)
    || toLine > input.sourceLineCount
    || checkedLineCount > ownedLineCount
  ) {
    throw new Error(
      `Invalid translation alignment range L${input.fromLine}-L${toLine} for ${input.sourceLineCount} source lines.`
    );
  }
  const auditKey = createHash("sha256")
    .update(input.documentId)
    .update("\0")
    .update(input.candidatePath)
    .update("\0")
    .update(String(input.fromLine))
    .update("\0")
    .update(String(toLine))
    .update("\0")
    .update(created.inputHash)
    .digest("hex");
  return {
    documentId: input.documentId,
    auditId: `alignment-range-${auditKey.slice(0, 20)}`,
    inputHash: created.inputHash,
    candidatePath: input.candidatePath,
    sourceLineCount: input.sourceLineCount,
    fromLine: input.fromLine,
    toLine,
    riskLineCount: created.checks.filter((check) => check.signals.length > 0).length,
    sampledLineCount: created.checks.filter((check) => check.signals.length === 0).length,
    ...(created.lineHashVersion === 2 ? { lineHashVersion: 2 as const } : {}),
    checks: created.checks.map((check) => ({
      ...check,
      line: check.line + input.fromLine - 1
    }))
  };
}

export function createTranslationChunkReviewAudit(input: {
  documentId: string;
  sourceText?: string;
  candidateText?: string;
  sourceLines?: string[];
  candidateLines?: string[];
  candidatePath: string;
  languagePair?: string;
  fromLine: number;
  toLine?: number;
  sourceLineCount: number;
  mechanicalSignals?: Array<{ line: number; signals: string[] }>;
}): TranslationAlignmentRangeState {
  const full = createTranslationAlignmentRangeAudit(input);
  const signalsByLine = new Map(full.checks.map((check) => [check.line, new Set(check.signals)]));
  for (const entry of input.mechanicalSignals ?? []) {
    if (!Number.isInteger(entry.line) || entry.line < full.fromLine || entry.line > full.toLine) continue;
    const signals = signalsByLine.get(entry.line) ?? new Set<string>();
    for (const signal of entry.signals) {
      const normalized = signal.trim();
      if (normalized) signals.add(normalized);
    }
    signalsByLine.set(entry.line, signals);
  }
  const riskLines = full.checks
    .map((check) => check.line)
    .filter((line) => (signalsByLine.get(line)?.size ?? 0) > 0);
  const riskSet = new Set(riskLines);
  const cleanLines = full.checks
    .map((check) => check.line)
    .filter((line) => !riskSet.has(line));
  const requestedSampleCount = Math.max(1, Math.ceil(Math.sqrt(full.toLine - full.fromLine + 1)));
  const sampleLines = cleanLines
    .map((line) => ({
      line,
      rank: createHash("sha256")
        .update(full.auditId)
        .update("\0")
        .update(String(line))
        .digest("hex")
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.line - right.line)
    .slice(0, requestedSampleCount)
    .map((entry) => entry.line);
  const selected = new Set([...riskLines, ...sampleLines]);
  const checks = full.checks
    .filter((check) => selected.has(check.line))
    .map((check) => ({
      line: check.line,
      signals: riskSet.has(check.line)
        ? [...(signalsByLine.get(check.line) ?? new Set<string>())]
        : ["deterministic_unflagged_sample"]
    }));
  const auditKey = createHash("sha256")
    .update(full.auditId)
    .update("\0chunk-review-v1")
    .update("\0")
    .update(checks.map((check) => `${check.line}:${check.signals.join(",")}`).join("\n"))
    .digest("hex");
  return {
    ...full,
    auditId: `alignment-chunk-${auditKey.slice(0, 20)}`,
    riskLineCount: riskLines.length,
    sampledLineCount: sampleLines.length,
    checks
  };
}

export function createTranslationMutationReviewAudit(input: {
  documentId: string;
  sourceText: string;
  candidateText: string;
  candidatePath: string;
  languagePair?: string;
  fromLine: number;
  toLine: number;
  sourceLineCount: number;
  mutationFromLine: number;
  mutationToLine: number;
  previousScopes: TranslationAlignmentRangeState[];
  mechanicalSignals?: Array<{ line: number; signals: string[] }>;
}): TranslationAlignmentRangeState {
  const full = createTranslationAlignmentRangeAudit(input);
  if (
    input.mutationFromLine < full.fromLine
    || input.mutationToLine > full.toLine
    || input.mutationToLine < input.mutationFromLine
  ) {
    throw new Error(
      `Invalid translation mutation L${input.mutationFromLine}-L${input.mutationToLine} `
      + `inside L${full.fromLine}-L${full.toLine}.`
    );
  }

  const previousChecks = new Map<number, TranslationAlignmentCheckState>();
  for (const scope of input.previousScopes) {
    if (
      scope.documentId !== input.documentId
      || scope.candidatePath !== input.candidatePath
      || scope.sourceLineCount !== input.sourceLineCount
      || scope.toLine < full.fromLine
      || scope.fromLine > full.toLine
    ) continue;
    for (const check of scope.checks) {
      if (check.line >= full.fromLine && check.line <= full.toLine) previousChecks.set(check.line, check);
    }
  }

  const sourceLines = splitTextLines(input.sourceText);
  const candidateLines = splitTextLines(input.candidateText);
  const mutationOffset = input.mutationFromLine - full.fromLine;
  const mutationLength = input.mutationToLine - input.mutationFromLine + 1;
  const mutationSignals = (input.mechanicalSignals ?? [])
    .filter((entry) => entry.line >= input.mutationFromLine && entry.line <= input.mutationToLine)
    .map((entry) => ({ line: entry.line, signals: [...entry.signals] }));
  for (const previous of previousChecks.values()) {
    if (
      previous.verdict !== "misaligned"
      || previous.line < input.mutationFromLine
      || previous.line > input.mutationToLine
    ) continue;
    const entry = mutationSignals.find((candidate) => candidate.line === previous.line);
    if (entry) entry.signals.push("previous_misaligned_verdict");
    else mutationSignals.push({ line: previous.line, signals: ["previous_misaligned_verdict"] });
  }
  const mutation = createTranslationChunkReviewAudit({
    documentId: input.documentId,
    sourceLines: sourceLines.slice(mutationOffset, mutationOffset + mutationLength),
    candidateLines: candidateLines.slice(mutationOffset, mutationOffset + mutationLength),
    candidatePath: input.candidatePath,
    languagePair: input.languagePair,
    fromLine: input.mutationFromLine,
    toLine: input.mutationToLine,
    sourceLineCount: input.sourceLineCount,
    mechanicalSignals: mutationSignals
  });
  const checks = [
    ...[...previousChecks.values()]
      .filter((check) => check.line < input.mutationFromLine || check.line > input.mutationToLine)
      .map((check) => ({
        line: check.line,
        signals: [...check.signals],
        ...(check.verdict ? { verdict: check.verdict } : {}),
        ...(check.verdict === "misaligned" && check.reason ? { reason: check.reason } : {})
      })),
    ...mutation.checks
  ].sort((left, right) => left.line - right.line);
  const sampledLineCount = mutation.sampledLineCount;
  const auditKey = createHash("sha256")
    .update(full.auditId)
    .update("\0mutation-review-v1\0")
    .update(`${input.mutationFromLine}:${input.mutationToLine}`)
    .update("\0")
    .update(checks.map((check) => `${check.line}:${check.signals.join(",")}:${check.verdict ?? "pending"}`).join("\n"))
    .digest("hex");
  return {
    ...full,
    auditId: `alignment-mutation-${auditKey.slice(0, 20)}`,
    riskLineCount: mutation.riskLineCount,
    sampledLineCount,
    checks
  };
}
