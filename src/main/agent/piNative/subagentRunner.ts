import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentMessage,
  type AgentTool,
  type Session
} from "@earendil-works/pi-agent-core/node";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  type OpenAICodexWebSocketDebugStats
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { Type } from "typebox";

import {
  splitTextLines,
  validateTranslationCandidate,
  type TranslationValidationResult
} from "../../../shared/validation/translationValidator.ts";
import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";
import { resolveThinkingLevelForModel } from "../../../shared/agent/thinkingLevels.ts";
import { readProjectAssets, readWorkflowProjectAssets } from "../projectAssets.ts";
import { listProjectDir, readProjectFile, searchProjectText } from "../projectFileTools.ts";
import { resolveReadablePath } from "../projectPathGuard.ts";
import { readWorkspaceAgentContext } from "../workspaceAssets.ts";
import {
  proofreadSuggestedFixChangesTranslation,
  proofreadSuggestedFixPreservesControlPrefix,
  writeProofreadFindings
} from "../writeProofreadFindings.ts";
import {
  discardTranslationStagingCandidate,
  prepareTranslationStagingCandidate,
  promoteTranslationStagingRange,
  resolveTranslationCandidatePath,
  writeTranslationChunk,
  writeTranslationLines
} from "../writeTranslationChunk.ts";
import { resolveProofreadTranslationPath } from "../translationBindingResolve.ts";
import { createPiModelSelection, type PiModelSelection } from "./providerRegistry.ts";
import {
  NonRetryableAssignmentError,
  ParentTakeoverAssignmentError,
  ProviderAuthExpiredError,
  SubagentTransportExhaustedError,
  isExpiredProviderAuthError
} from "./assignmentFailure.ts";
import {
  PiSessionAgentRuntime,
  type PiProviderStreamTimeouts
} from "./sessionAgentRuntime.ts";
import { PiSessionRepository } from "./sessionRepository.ts";
import {
  compactYnTranslationValidation,
  isYnTranslationArtifactAccepted,
  isYnTranslationChunkWritable,
  ynTranslationStructuralWarnings
} from "./translationArtifactValidation.ts";
import { createYnTranslationValidationOptions } from "./translationValidationContext.ts";
import {
  requestDocumentId,
  resolvePiReadablePath,
  type PiBoundSourceRequest
} from "./sourceManifest.ts";
import { buildCachedWebReferenceContext } from "./webReference.ts";
import {
  readTranslationReuseAuditSelection,
  recordTranslationReuseAuditBatch,
  type TranslationReuseAuditEntryInput
} from "./translationReuseAudit.ts";
import { createTranslationAlignmentAudit } from "./translationAlignmentState.ts";

interface PiSubagentTaskBase {
  documentId?: string;
  label?: string;
  providerId?: string;
  modelId?: string;
}

interface PiSubagentRangeTask extends PiSubagentTaskBase {
  fromLine: number;
  toLine: number;
}

export interface PiTranslationSubagentTask extends PiSubagentRangeTask {
  instruction?: string;
  /** Exact writable rows for a prompt-defined sparse bounded repair. */
  selectedLines?: number[];
  reviewFeedback?: Array<{ line: number; reason: string }>;
  /** Host-injected priority repair that must settle before the original queue resumes. */
  terminologyRepair?: true;
  /** Hash-current Host staging artifact retained across a stopped/restarted review repair. */
  stagingCandidatePath?: string;
  /** Resume the existing hash-current candidate review without invoking a translation writer. */
  reviewOnly?: true;
}

export interface PiTranslationChunkReviewRequest {
  subagentId: string;
  label: string;
  documentId: string;
  fromLine: number;
  toLine: number;
  candidatePath?: string;
  validation: ReturnType<typeof validateTranslationCandidate>;
  discoveries: PiTranslationDiscoveries;
  requiredLines?: number[];
  signal?: AbortSignal;
}

export type PiTranslationChunkReviewDecision =
  | { accepted: true }
  | { accepted: false; feedback: Array<{ line: number; reason: string }> };

export interface PiTranslationReviewTask extends PiSubagentRangeTask {
  auditId: string;
  riskLineCount: number;
  sampledLineCount: number;
}

export interface PiTranslationReviewFailure {
  line: number;
  code: string;
  note: string;
}

export interface PiTranslationReviewAssignment {
  auditId: string;
  documentId: string;
  fromLine: number;
  toLine: number;
  riskLineCount: number;
  sampledLineCount: number;
  windows: Array<{
    fromLine: number;
    toLine: number;
    rows: Array<{
      line: number;
      source: string;
      translation: string;
      selected: boolean;
      signals: string[];
    }>;
  }>;
}

export interface PiGeneralSubagentTask extends PiSubagentTaskBase {
  prompt: string;
  mode: "investigate" | "translation_repair" | "translation_audit";
  auditId?: string;
  fromLine?: number;
  toLine?: number;
  lines?: number[];
}

export interface PiProofreadSubagentTask extends PiSubagentRangeTask {
  mode?: "split" | "montecarlo";
  checkpointSize?: number;
  round?: number;
  sampledLines?: number[];
  reviewLines?: number[];
  deterministicSignals?: Array<{
    line: number;
    code: string;
    evidence: string;
  }>;
}

interface PiSubagentResult {
  subagentId: string;
  label: string;
  documentId?: string;
  fromLine?: number;
  toLine?: number;
  providerId: string;
  modelId: string;
  modelName: string;
  reply?: string;
  resultSummary: string;
}

export interface PiTranslationSubagentResult extends PiSubagentResult {
  validation: ReturnType<typeof validateTranslationCandidate>;
  discoveries: PiTranslationDiscoveries;
}

export interface PiTranslationGlossaryDiscovery {
  source: string;
  target: string;
  category: "proper_noun" | "character" | "organization" | "place" | "title" | "setting_term";
  evidenceLine: number;
  rationale: string;
  aliases?: string[];
}

export interface PiTranslationCharacterDiscovery {
  sourceName: string;
  targetName?: string;
  evidenceLine: number;
  evidence: string;
  gender: "male" | "female" | "nonbinary" | "unknown";
  pronouns?: string[];
  confidence: "confirmed" | "inferred" | "unknown";
}

export interface PiTranslationDiscoveries {
  glossaryCandidates: PiTranslationGlossaryDiscovery[];
  characterFacts: PiTranslationCharacterDiscovery[];
}

const MAX_PRIOR_TRANSLATION_DISCOVERY_HINTS = 12;

export interface PiRejectedTranslationDiscovery {
  kind: "glossary_candidate" | "character_fact";
  index: number;
  reason: string;
}

export interface PiProofreadSubagentResult extends PiSubagentResult {
  findingsWritten: number;
  reportPath?: string;
  glossaryCandidates: PiTranslationGlossaryDiscovery[];
}

export interface PiGeneralSubagentResult extends PiSubagentResult {
  translationAudit?: {
    auditId: string;
    documentId: string;
    entries: TranslationReuseAuditEntryInput[];
  };
}

interface PiSubagentContext<TTask extends PiSubagentTaskBase> {
  request: PiSessionPromptRequest;
  task: TTask;
  subagentId?: string;
  publishCustomMessage: (message: AgentMessage) => Promise<void>;
  publishLiveCustomMessage?: (message: AgentMessage) => Promise<void>;
  createModelSelection?: typeof createPiModelSelection;
  registerControl?: (control: PiSubagentControl) => void;
  onArtifactMutation?: (
    documentId: string | undefined,
    range?: { fromLine: number; toLine: number; lines?: number[] }
  ) => Promise<void> | void;
  signal?: AbortSignal;
  providerStreamTimeouts?: PiProviderStreamTimeouts;
}

export interface PiTranslationSubagentContext extends PiSubagentContext<PiTranslationSubagentTask> {
  executionMode?: "full_workflow" | "bounded_repair" | "chunk_review_repair";
  terminateOnAcceptedWrite?: boolean;
  deferSparseRepair?: boolean;
  workingCandidatePath?: string;
  onChunkReadyForReview?: (
    review: PiTranslationChunkReviewRequest
  ) => Promise<PiTranslationChunkReviewDecision>;
  onStagingCandidateCheckpoint?: (
    checkpoint: PiTranslationStagingCheckpoint
  ) => Promise<void> | void;
}

export interface PiTranslationStagingCheckpoint {
  documentId: string;
  fromLine: number;
  toLine: number;
  candidatePath: string;
  terminologyRepairLines: number[];
  accepted: boolean;
  requiredLines: number[];
  repairIssues: Array<{
    code: string;
    severity: "blocking" | "warning";
    detail: string;
    absoluteLine?: number;
  }>;
}

export interface PiTranslationReviewSubagentContext extends PiSubagentContext<PiTranslationReviewTask> {
  workerProviderId?: string;
  workerModelId?: string;
  readAssignment: (
    task: PiTranslationReviewTask,
    signal?: AbortSignal
  ) => Promise<PiTranslationReviewAssignment>;
  submitAssignment: (
    task: PiTranslationReviewTask,
    failures: PiTranslationReviewFailure[],
    signal?: AbortSignal
  ) => Promise<PiTranslationChunkReviewDecision>;
}

export interface PiProofreadPendingGlossaryCandidate {
  id: string;
  source: string;
  target: string;
  category: string;
  aliases?: string[];
  rationale: string;
  occurrenceCount: number;
}

interface PiProofreadExactSearchResult {
  ok: true;
  path: string;
  relativePath: string;
  outsideProject: boolean;
  query: string;
  matches: Array<{ path: string; line: number; text: string }>;
  indexedReference?: string;
  omittedMatchCount?: number;
}

export interface PiProofreadExactSearchCacheEntry {
  query: string;
  relativePath: string;
  pending?: Promise<PiProofreadExactSearchResult>;
  result?: PiProofreadExactSearchResult;
}

export type PiProofreadExactSearchCache = Map<string, PiProofreadExactSearchCacheEntry>;

export interface PiProofreadSubagentContext extends PiSubagentContext<PiProofreadSubagentTask> {
  proofreadSearchCache?: PiProofreadExactSearchCache;
  pendingProofreadGlossaryCandidates?: PiProofreadPendingGlossaryCandidate[];
}

export interface PiGeneralSubagentContext extends PiSubagentContext<PiGeneralSubagentTask> {}

interface PiProofreadFindingInput {
  id: string;
  type: string;
  sourceLine: number;
  suggestedFix: string;
  rationale: string;
  needsVerification?: boolean;
}

export interface PiProofreadProgress {
  referenceRead: boolean;
  nextAssignedLine?: number;
  nextAssignedIndex?: number;
  referenceOffsets?: Map<string, { offset: number; length: number; required: boolean }>;
  findingsWritten: boolean;
  findingsCount: number;
  reportPath?: string;
  glossaryCandidates?: PiTranslationGlossaryDiscovery[];
  acceptedFindings?: Array<Record<string, unknown>>;
}

export interface PiTranslationProgress {
  referenceRead: boolean;
  sourceRead: boolean;
  translationWritten: boolean;
  translationValidated: boolean;
  readLines?: Set<number>;
  writtenLines?: Set<number>;
  mutatedLines?: Set<number>;
  activeSourcePage?: { fromLine: number; toLine: number };
  requiredBatchLines?: Set<number>;
  requiredBatchIssues?: PiTranslationStagingCheckpoint["repairIssues"];
  discoveries?: PiTranslationDiscoveries;
  translationAlignmentHash?: string;
}

export interface PiSubagentControl {
  inspect: () => Promise<AgentMessage[]>;
  steer: (text: string) => Promise<{ consumed: Promise<void> }>;
  followUp: (text: string) => Promise<void>;
  abort: () => Promise<void>;
}

function throwIfAborted(...signals: Array<AbortSignal | undefined>): void {
  const aborted = signals.find((signal) => signal?.aborted);
  if (!aborted) return;
  const reason = aborted.reason instanceof Error ? ` ${aborted.reason.message}` : "";
  throw new DOMException(`Pi subagent was aborted.${reason}`, "AbortError");
}

const EMPTY_TRANSLATION_DISCOVERIES: PiTranslationDiscoveries = {
  glossaryCandidates: [],
  characterFacts: []
};

function cleanDiscoveryText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function normalizeTranslationDiscoveries(
  input: Partial<PiTranslationDiscoveries> | undefined,
  task: PiSubagentRangeTask,
  sourceLines: string[],
  candidateLines: string[]
): { discoveries: PiTranslationDiscoveries; rejectedDiscoveries: PiRejectedTranslationDiscovery[] } {
  const glossaryCandidates: PiTranslationGlossaryDiscovery[] = [];
  const characterFacts: PiTranslationCharacterDiscovery[] = [];
  const rejectedDiscoveries: PiRejectedTranslationDiscovery[] = [];
  for (const [index, candidate] of (input?.glossaryCandidates ?? []).entries()) {
    try {
      const source = cleanDiscoveryText(candidate.source, "Glossary discovery source");
      const target = cleanDiscoveryText(candidate.target, `Glossary discovery target for ${source}`);
      const evidenceLine = Number(candidate.evidenceLine);
      if (!Number.isInteger(evidenceLine) || evidenceLine < task.fromLine || evidenceLine > task.toLine) {
        throw new Error(`Glossary discovery ${source} evidenceLine must stay inside L${task.fromLine}-L${task.toLine}.`);
      }
      if (!(sourceLines[evidenceLine - 1] ?? "").includes(source)) {
        throw new Error(`Glossary discovery ${source} is not present on evidence line L${evidenceLine}.`);
      }
      const candidateEvidence = candidateLines[evidenceLine - 1] ?? "";
      if (!candidateEvidence.includes(target)) {
        throw new Error(`Glossary discovery target ${target} is not present in the translated evidence line L${evidenceLine}.`);
      }
      if (!["proper_noun", "character", "organization", "place", "title", "setting_term"].includes(candidate.category)) {
        throw new Error(`Glossary discovery ${source} has an unsupported category.`);
      }
      const proposedAliases = [...new Set((candidate.aliases ?? []).map((alias) => String(alias).trim()).filter(Boolean))];
      const aliases = proposedAliases.filter((alias) => candidateEvidence.includes(alias));
      const unsupportedAliases = proposedAliases.filter((alias) => !candidateEvidence.includes(alias));
      if (unsupportedAliases.length > 0) {
        rejectedDiscoveries.push({
          kind: "glossary_candidate",
          index,
          reason: `Glossary discovery ${source} omitted aliases without translated-line evidence: ${unsupportedAliases.join(", ")}. aliases accepts target-language renderings only.`
        });
      }
      glossaryCandidates.push({
        source,
        target,
        category: candidate.category,
        evidenceLine,
        rationale: cleanDiscoveryText(candidate.rationale, `Glossary discovery rationale for ${source}`),
        ...(aliases.length > 0 ? { aliases } : {})
      });
    } catch (error) {
      rejectedDiscoveries.push({
        kind: "glossary_candidate",
        index,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  for (const [index, fact] of (input?.characterFacts ?? []).entries()) {
    try {
      const sourceName = cleanDiscoveryText(fact.sourceName, "Character discovery sourceName");
      const evidenceLine = Number(fact.evidenceLine);
      if (!Number.isInteger(evidenceLine) || evidenceLine < task.fromLine || evidenceLine > task.toLine) {
        throw new Error(`Character discovery ${sourceName} evidenceLine must stay inside L${task.fromLine}-L${task.toLine}.`);
      }
      if (!(sourceLines[evidenceLine - 1] ?? "").includes(sourceName)) {
        throw new Error(`Character discovery ${sourceName} is not present on evidence line L${evidenceLine}.`);
      }
      if (!["male", "female", "nonbinary", "unknown"].includes(fact.gender)) {
        throw new Error(`Character discovery ${sourceName} has an unsupported gender.`);
      }
      if (!["confirmed", "inferred", "unknown"].includes(fact.confidence)) {
        throw new Error(`Character discovery ${sourceName} has an unsupported confidence.`);
      }
      const targetName = String(fact.targetName ?? "").trim();
      const pronouns = [...new Set((fact.pronouns ?? []).map((pronoun) => String(pronoun).trim()).filter(Boolean))];
      characterFacts.push({
        sourceName,
        ...(targetName ? { targetName } : {}),
        evidenceLine,
        evidence: cleanDiscoveryText(fact.evidence, `Character discovery evidence for ${sourceName}`),
        gender: fact.gender,
        ...(pronouns.length > 0 ? { pronouns } : {}),
        confidence: fact.confidence
      });
    } catch (error) {
      rejectedDiscoveries.push({
        kind: "character_fact",
        index,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    discoveries: mergeTranslationDiscoveries([{ glossaryCandidates, characterFacts }]),
    rejectedDiscoveries
  };
}

export function mergeTranslationDiscoveries(
  inputs: Array<Partial<PiTranslationDiscoveries> | undefined>
): PiTranslationDiscoveries {
  const glossaryCandidates: PiTranslationGlossaryDiscovery[] = [];
  const glossaryKeys = new Set<string>();
  const characterFacts: PiTranslationCharacterDiscovery[] = [];
  const characterKeys = new Set<string>();
  for (const input of inputs) {
    for (const candidate of input?.glossaryCandidates ?? []) {
      const key = `${candidate.source.toLocaleLowerCase()}\u0000${candidate.target.toLocaleLowerCase()}`;
      if (glossaryKeys.has(key)) continue;
      glossaryKeys.add(key);
      glossaryCandidates.push(candidate);
    }
    for (const fact of input?.characterFacts ?? []) {
      const key = [
        fact.sourceName.toLocaleLowerCase(),
        fact.targetName?.toLocaleLowerCase() ?? "",
        fact.gender,
        fact.pronouns?.join("/").toLocaleLowerCase() ?? "",
        fact.confidence
      ].join("\u0000");
      if (characterKeys.has(key)) continue;
      characterKeys.add(key);
      characterFacts.push(fact);
    }
  }
  return { glossaryCandidates, characterFacts };
}

function sourcePath(request: PiBoundSourceRequest): string {
  const value = request.sourcePath?.trim();
  if (!value) throw new Error("The translation session has no sourcePath.");
  return path.resolve(value);
}

function documentId(request: PiBoundSourceRequest): string {
  return requestDocumentId(request);
}

function assignmentDescription(task: PiSubagentRangeTask): string {
  return task.documentId
    ? `source file ${task.documentId}`
    : `source lines ${task.fromLine}-${task.toLine}`;
}

function candidatePath(request: PiSessionPromptRequest): string {
  return resolveTranslationCandidatePath({
    outputDir: request.outputDir,
    sourcePaths: [sourcePath(request)],
    documentId: documentId(request)
  });
}

function translationWorkingCandidatePath(context: PiTranslationSubagentContext): string {
  return context.workingCandidatePath?.trim() || candidatePath(context.request);
}

function proofreadTranslationPath(request: PiSessionPromptRequest): string {
  return resolveProofreadTranslationPath({
    request,
    folderSource: request.sourceSelection?.kind === "folder",
    documentId: documentId(request)
  });
}

async function assertProofreadAssignmentFiles(request: PiSessionPromptRequest): Promise<void> {
  const source = sourcePath(request);
  const translation = proofreadTranslationPath(request);
  const [sourceInfo, translationInfo] = await Promise.all([
    stat(source),
    stat(translation)
  ]).catch((error) => {
    throw new NonRetryableAssignmentError(
      `Proofreading assignment preflight could not read its bound source/candidate: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (!sourceInfo.isFile() || !translationInfo.isFile()) {
    throw new NonRetryableAssignmentError(
      `Proofreading assignment requires file-bound paths; source=${source}, translation=${translation}.`
    );
  }
}

function proofreadReportScope(
  request: PiBoundSourceRequest
): Parameters<typeof writeProofreadFindings>[0]["reportScope"] {
  const selection = request.sourceRootSelection ?? request.sourceSelection;
  return selection?.kind === "folder"
    ? { kind: "folder", sourcePath: path.resolve(selection.path) }
    : undefined;
}

function textResult(value: unknown, details: unknown = value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    // Pi retains history after context reset; detach line slices from full-file backing strings.
    details: structuredClone(details)
  };
}

function proofreadSearchCacheKey(
  context: Pick<PiSubagentContext<PiSubagentTaskBase>, "request">,
  query: string,
  relativePath: string
): string {
  const project = path.resolve(context.request.outputDir);
  const normalizedPath = relativePath.trim() || ".";
  const normalizedQuery = query.trim().normalize("NFKC").toLowerCase();
  return [project, normalizedPath, normalizedQuery]
    .map((value) => process.platform === "win32" ? value.toLowerCase() : value)
    .join("\0");
}

function compactProofreadSearchResult(
  result: PiProofreadExactSearchResult,
  cacheHit: boolean,
  matchLimit: number
): PiProofreadExactSearchResult & {
  cacheHit: boolean;
  matchCount: number;
  omittedMatchCount: number;
} {
  const matches = result.matches.slice(0, matchLimit);
  const omittedMatchCount = (result.omittedMatchCount ?? 0) + result.matches.length - matches.length;
  return {
    ...result,
    matches,
    cacheHit,
    matchCount: result.matches.length + (result.omittedMatchCount ?? 0),
    omittedMatchCount
  };
}

function priorProofreadExactSearches(
  cache: PiProofreadExactSearchCache | undefined,
  assignedText: string
) {
  if (!cache) return [];
  const normalizedText = assignedText.normalize("NFKC").toLowerCase();
  return [...cache.values()]
    .filter((entry): entry is PiProofreadExactSearchCacheEntry & { result: PiProofreadExactSearchResult } => (
      Boolean(entry.result)
      && normalizedText.includes(entry.query.normalize("NFKC").toLowerCase())
    ))
    .slice(0, 8)
    .map((entry) => compactProofreadSearchResult(entry.result, true, 3));
}

function createPiSubagentReadOnlyProjectTools(
  context: Pick<PiSubagentContext<PiSubagentTaskBase>, "request" | "signal">,
  options: {
    indexedReferenceReads?: "search-only";
    proofreadSearchCache?: PiProofreadExactSearchCache;
    searchResultLimit?: number;
    boundProofreadContext?: boolean;
    boundTranslationContext?: boolean;
    maxProjectFileReadChars?: number;
  } = {}
): AgentTool[] {
  const maxProjectFileReadChars = Math.max(1, Math.min(32_000, options.maxProjectFileReadChars ?? 32_000));
  const indexedReferenceEntries: Array<[string, string]> = [
    [
      path.resolve(context.request.outputDir, ".translation-workshop", "glossary.json"),
      "approved glossary"
    ],
    [
      path.resolve(context.request.outputDir, "AI_translation", "_workspace", "character_bible.md"),
      "character bible"
    ],
    [
      path.resolve(context.request.outputDir, "AI_translation", "_workspace", "glossary_candidates.json"),
      "glossary candidates"
    ]
  ];
  if (context.request.glossaryPath?.trim()) {
    indexedReferenceEntries.push([path.resolve(context.request.glossaryPath), "approved glossary"]);
  }
  const indexedReferencePaths = new Map(indexedReferenceEntries.map(([filePath, label]) => [
    process.platform === "win32" ? filePath.toLowerCase() : filePath,
    label
  ]));
  const indexedReferenceLabel = (inputPath: string): string | undefined => {
    if (options.indexedReferenceReads !== "search-only") return undefined;
    const readablePath = resolvePiReadablePath(context.request, inputPath) ?? inputPath;
    const resolved = path.isAbsolute(readablePath)
      ? path.resolve(readablePath)
      : path.resolve(context.request.outputDir, readablePath);
    return indexedReferencePaths.get(process.platform === "win32" ? resolved.toLowerCase() : resolved);
  };
  return [
    {
      name: "listProjectDir",
      label: "List directory",
      description: options.boundProofreadContext
        ? "List a directory only when an exact additional reference cannot be named. readAssignedProofreadContext already supplies the complete owned rows and boundary context; do not list the project, source, raw assets, or neighboring files to rediscover that context. This tool never writes."
        : "List any directory needed for the task. Relative paths use the current YN project; absolute paths may point to user-provided external references. Omit path, pass a blank path, or use '.' for the project root. Reading is not limited by the delegated document or line range and this tool never writes.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        const input = params as { path?: string; maxEntries?: number };
        const result = await listProjectDir({
          outputDir: context.request.outputDir,
          relativePath: input.path,
          maxEntries: input.maxEntries
        });
        if (!result.ok) throw new Error(result.error);
        return textResult(result);
      }
    },
    {
      name: "searchProjectText",
      label: "Search project text",
      description: "Search UTF-8 files and return bounded, match-centered file/line evidence. For the canonical glossary, character bible, and glossary-candidate paths, one source/name lookup returns complete matching structured records, including their target forms and aliases; do not repeat the query against parent folders or translated spellings. A bound source document id or source filename resolves to the actual Host-bound file, including extracted EPUB text. Other relative paths use the current project; absolute paths may point to user-provided external references. Omit path, pass a blank path, or use '.' for the project root. Recursive project search excludes Pi transcripts and generated historical review HTML; pass the exact HTML path only when it is genuinely required. This tool never writes.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String()),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        const input = params as { query: string; path?: string; maxResults?: number };
        const indexedLabel = input.path ? indexedReferenceLabel(input.path) : undefined;
        const maxResults = Math.min(
          input.maxResults ?? 25,
          options.searchResultLimit ?? 50
        );
        const performSearch = async (): Promise<PiProofreadExactSearchResult> => {
          if (indexedLabel) {
            return searchIndexedProjectReference(
              context.request,
              indexedLabel,
              input.query,
              maxResults
            );
          }
          const result = await searchProjectText({
            outputDir: context.request.outputDir,
            relativePath: resolvePiReadablePath(context.request, input.path),
            query: input.query,
            maxResults
          });
          if (!result.ok) throw new Error(result.error);
          return result;
        };
        const cache = options.proofreadSearchCache;
        if (!cache) return textResult(await performSearch());
        const relativePath = input.path?.trim() || ".";
        const key = proofreadSearchCacheKey(context, input.query, relativePath);
        const existing = cache.get(key);
        if (existing) {
          const cached = existing.result ?? (existing.pending ? await existing.pending : undefined);
          if (!cached) throw new Error(`Proofreading exact-search cache entry ${key} is incomplete.`);
          return textResult(compactProofreadSearchResult(cached, true, 3));
        }
        const entry: PiProofreadExactSearchCacheEntry = {
          query: input.query.trim(),
          relativePath,
          // Cache only the matches, without retaining the searched file behind their string slices.
          pending: performSearch().then((result) => structuredClone(result))
        };
        cache.set(key, entry);
        try {
          const result = await entry.pending!;
          entry.result = result;
          delete entry.pending;
          return textResult(compactProofreadSearchResult(result, false, maxResults));
        } catch (error) {
          if (cache.get(key) === entry) cache.delete(key);
          throw error;
        }
      }
    },
    {
      name: "readProjectFile",
      label: "Read file",
      description: options.indexedReferenceReads === "search-only"
        ? `${options.boundProofreadContext
          ? "readAssignedProofreadContext already supplies the complete bound source/current translation and exact boundary rows; do not reread them, raw assets, or neighboring files. "
          : options.boundTranslationContext
            ? "For the bound source document, readAssignedSource supplies owned rows and readTranslationContext supplies line-aware surrounding context; do not use readProjectFile because its page starts at a character offset unrelated to the assignment. "
            : ""}Read one bounded UTF-8 page only when the task needs that exact additional file, including style references, prior translations, and user-provided external references. A bound source document id or source filename resolves to the actual Host-bound file. The approved glossary, character bible, and glossary-candidate files are indexed references: assigned context already returns direct matches, and any additional lookup must use searchProjectText with one exact term instead of bulk-reading those files. Continue a genuinely needed long non-index file with offsetChars. This tool never writes.`
        : "Read one bounded UTF-8 page only when the task needs that exact file, including source context, translation candidates, canonical glossary/character assets, and user-provided external references. A bound source document id or source filename resolves to the actual Host-bound file. Do not bulk-read generated historical review HTML or reread every available project asset for each assignment. Continue a genuinely needed long file with offsetChars. This tool never writes.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: maxProjectFileReadChars }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        const input = params as { path: string; offsetChars?: number; maxChars?: number };
        const requestedChars = input.maxChars ?? Math.min(16_000, maxProjectFileReadChars);
        const indexedLabel = indexedReferenceLabel(input.path);
        if (indexedLabel) {
          throw new Error(
            `Whole-file reads are disabled for the indexed ${indexedLabel}. `
            + "readAssignedSource returns direct assigned-source matches; use searchProjectText with this exact path and one source term only when an additional lookup is needed."
          );
        }
        const result = await readProjectFile({
          outputDir: context.request.outputDir,
          relativePath: resolvePiReadablePath(context.request, input.path),
          offsetChars: input.offsetChars,
          maxChars: requestedChars
        });
        if (!result.ok) throw new Error(result.error);
        return textResult(result);
      }
    }
  ];
}

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function compactErrorCause(error: unknown): string {
  const details: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      const code = typeof (current as Error & { code?: unknown }).code === "string"
        ? (current as Error & { code: string }).code.trim()
        : "";
      const message = current.message.trim();
      const detail = [code, message].filter(Boolean).join(": ");
      if (detail && !details.includes(detail)) details.push(detail.slice(0, 500));
      current = current.cause;
      continue;
    }
    const detail = String(current).trim();
    if (detail && !details.includes(detail)) details.push(detail.slice(0, 500));
    break;
  }
  return details.join("; ") || "unknown persistence failure";
}

async function latestFailedToolFeedback(session: Session): Promise<string | undefined> {
  const messages = (await session.buildContext()).messages;
  const laterSuccessfulTools = new Set<string>();
  for (const message of [...messages].reverse()) {
    if (message.role !== "toolResult") continue;
    if (!message.isError) {
      laterSuccessfulTools.add(message.toolName);
      continue;
    }
    if (laterSuccessfulTools.has(message.toolName)) continue;
    const feedback = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (feedback) return feedback.slice(0, 2_000);
  }
  return undefined;
}

async function latestToolResultHasRepairEvidence(session: Session): Promise<boolean> {
  const messages = (await session.buildContext()).messages;
  for (const message of [...messages].reverse()) {
    if (message.role !== "toolResult") continue;
    if (message.toolName !== "writeAssignedTranslation" && message.toolName !== "repairAssignedTranslation") {
      continue;
    }
    const feedback = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return feedback.includes("repairIssues") && feedback.includes("requiredBatchLines");
  }
  return false;
}

function assertRuntimeResponse(message: { stopReason?: string; errorMessage?: string }): void {
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
  throw new Error(message.errorMessage || `Pi subagent stopped with ${message.stopReason}.`);
}

type PiAssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

async function latestAssistantMessage(session: Session): Promise<PiAssistantMessage> {
  const messages = (await session.buildContext()).messages;
  const assistant = [...messages].reverse().find((message): message is PiAssistantMessage => message.role === "assistant");
  if (!assistant) throw new Error("Pi subagent completed a turn without an assistant message.");
  return assistant;
}

async function assistantMessageCount(session: Session): Promise<number> {
  return (await session.buildContext()).messages.filter((message) => message.role === "assistant").length;
}

// Pi continues the same native turn so retries do not append the complete assignment prompt again.
const CHILD_RUNTIME_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 500 } as const;
const NO_FRESH_ASSISTANT_RETRY_DELAYS_MS = [250] as const;

export function shouldResetSubagentCodexFallback(args: {
  api: string;
  errorMessage: string;
  stats?: Pick<OpenAICodexWebSocketDebugStats, "websocketFallbackActive">;
}): boolean {
  return args.api === "openai-codex-responses"
    && args.stats?.websocketFallbackActive === true
    && /\bfetch failed\b/iu.test(args.errorMessage);
}

async function recoverSubagentCodexTransport(
  runtime: PiSessionAgentRuntime,
  errorMessage: string
): Promise<void> {
  const model = runtime.getModel();
  if (model.api !== "openai-codex-responses") return;
  const sessionId = runtime.getSessionId();
  const stats = getOpenAICodexWebSocketDebugStats(sessionId);
  if (!shouldResetSubagentCodexFallback({ api: model.api, errorMessage, stats })) return;
  const diagnostic = {
    timestamp: Date.now(),
    sessionId,
    provider: model.provider,
    model: model.id,
    error: errorMessage,
    websocket: stats
  };
  await runtime.appendCustomEntry("yn_provider_transport_reset", diagnostic);
  console.warn("[pi-subagent-transport-reset]", JSON.stringify(diagnostic));
  closeOpenAICodexWebSocketSessions(sessionId);
  resetOpenAICodexWebSocketDebugStats(sessionId);
}

async function waitForSubagentRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Pi subagent retry was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function promptSubagentTurn(args: {
  runtime: PiSessionAgentRuntime;
  session: Session;
  prompt: string;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: string) => Promise<void> | void;
}): Promise<PiAssistantMessage> {
  const unsubscribe = args.runtime.subscribe(async (event) => {
    if (event.type !== "auto_retry_start") return;
    await recoverSubagentCodexTransport(args.runtime, event.errorMessage);
    console.warn("[pi-subagent-retry]", JSON.stringify({
      retryAttempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      error: event.errorMessage
    }));
    await args.onRetry?.(event.attempt, event.errorMessage);
  });
  try {
    for (let noFreshAttempt = 0; ; noFreshAttempt += 1) {
      throwIfAborted(args.signal);
      const assistantCountBeforePrompt = await assistantMessageCount(args.session);
      await args.runtime.prompt(args.prompt);
      const assistantCountAfterPrompt = await assistantMessageCount(args.session);
      if (assistantCountAfterPrompt <= assistantCountBeforePrompt) {
        const error = "Pi child turn completed without a fresh assistant message.";
        if (noFreshAttempt >= NO_FRESH_ASSISTANT_RETRY_DELAYS_MS.length) throw new Error(error);
        const retryAttempt = noFreshAttempt + 1;
        console.warn("[pi-subagent-retry]", JSON.stringify({ retryAttempt, error }));
        await args.onRetry?.(retryAttempt, error);
        await waitForSubagentRetry(NO_FRESH_ASSISTANT_RETRY_DELAYS_MS[noFreshAttempt], args.signal);
        continue;
      }
      const response = await latestAssistantMessage(args.session);
      throwIfAborted(args.signal);
      if (response.stopReason !== "error" && response.stopReason !== "aborted") return response;
      if (response.stopReason === "error" && isExpiredProviderAuthError(response.errorMessage)) {
        throw new ProviderAuthExpiredError(
          response.errorMessage || "Provider OAuth access token is no longer valid."
        );
      }
      if (response.stopReason === "error" && isRetryableAssistantError(response)) {
        throw new SubagentTransportExhaustedError(
          response.errorMessage || "Pi child provider transport retry budget was exhausted."
        );
      }
      assertRuntimeResponse(response);
      return response;
    }
  } finally {
    unsubscribe();
  }
}

async function requireNativeFinalReply(args: {
  runtime: PiSessionAgentRuntime;
  session: Session;
  response: PiAssistantMessage;
  signal?: AbortSignal;
  completionPrompt: string;
  onRetry?: (attempt: number, error: string) => Promise<void> | void;
}): Promise<{ response: PiAssistantMessage; reply: string }> {
  let response = args.response;
  let reply = assistantText(response);
  if (reply) return { response, reply };

  response = await promptSubagentTurn({
    runtime: args.runtime,
    session: args.session,
    prompt: args.completionPrompt,
    signal: args.signal,
    onRetry: args.onRetry
  });
  reply = assistantText(response);
  if (!reply) {
    throw new Error("Pi subagent completed its host artifact contract but produced no final assistant reply.");
  }
  return { response, reply };
}

function customPreserveRuleContext(request: PiSessionPromptRequest): string {
  const rules = request.customPreserveRules ?? [];
  if (rules.length === 0) return "";
  return [
    "## Custom verbatim preservation rules",
    "Every source-line regex match must remain byte-for-byte identical on the same candidate line. The Host rejects any changed, missing, duplicated, or moved match.",
    ...rules.map((rule, index) => `- ${rule.label || `Rule ${index + 1}`}: /${rule.pattern}/${rule.flags}`)
  ].join("\n");
}

async function boundedPriorDiscoveryContext(
  request: PiSessionPromptRequest,
  task: PiSubagentRangeTask
): Promise<string> {
  const prior = (request as PiBoundSourceRequest).priorTranslationDiscoveries as PiTranslationDiscoveries | undefined;
  if (!prior || (prior.glossaryCandidates.length === 0 && prior.characterFacts.length === 0)) return "";

  const sourceLines = splitTextLines(await readFile(sourcePath(request), "utf8"));
  const assignedSource = sourceLines.slice(task.fromLine - 1, task.toLine).join("\n");
  const entries = [
    ...prior.glossaryCandidates.map((value) => ({
      kind: "glossary" as const,
      key: `glossary:${value.source}\u0000${value.target}`,
      relevant: assignedSource.includes(value.source),
      value
    })),
    ...prior.characterFacts.map((value) => ({
      kind: "character" as const,
      key: `character:${value.sourceName}\u0000${value.targetName ?? ""}`,
      relevant: assignedSource.includes(value.sourceName),
      value
    }))
  ];
  const selected: typeof entries = [];
  const selectedKeys = new Set<string>();
  const retain = (entry: (typeof entries)[number]): void => {
    if (selected.length >= MAX_PRIOR_TRANSLATION_DISCOVERY_HINTS || selectedKeys.has(entry.key)) return;
    selectedKeys.add(entry.key);
    selected.push(entry);
  };
  entries.filter((entry) => entry.relevant).forEach(retain);
  [...entries].reverse().forEach(retain);

  const glossaryCandidates = selected.flatMap((entry) => entry.kind === "glossary" ? [{
    source: entry.value.source,
    target: entry.value.target,
    category: entry.value.category,
    ...(entry.value.aliases?.length ? { aliases: entry.value.aliases } : {})
  }] : []);
  const characterFacts = selected.flatMap((entry) => entry.kind === "character" ? [{
    sourceName: entry.value.sourceName,
    ...(entry.value.targetName ? { targetName: entry.value.targetName } : {}),
    gender: entry.value.gender,
    ...(entry.value.pronouns?.length ? { pronouns: entry.value.pronouns } : {}),
    confidence: entry.value.confidence
  }] : []);
  return [
    "## Earlier completed folder-stage discoveries",
    "These are bounded, unapproved consistency hints from earlier ordered work. Relevant terms are retained first; recent hints fill the remaining slots. Report conflicts and let the parent perform the final merge and approval.",
    JSON.stringify({
      glossaryCandidates,
      characterFacts,
      omittedDiscoveryCount: Math.max(0, entries.length - selected.length)
    })
  ].join("\n");
}

async function optionalContext(
  request: PiSessionPromptRequest,
  task: PiSubagentRangeTask
): Promise<string> {
  const sections: string[] = [];
  if (request.style?.trim()) sections.push(`## Project style\n${request.style.trim()}`);
  if (request.workDescription?.trim()) sections.push(`## Work description\n${request.workDescription.trim()}`);
  const customPreserveContext = customPreserveRuleContext(request);
  if (customPreserveContext) sections.push(customPreserveContext);
  const priorDiscoveryContext = await boundedPriorDiscoveryContext(request, task);
  if (priorDiscoveryContext) sections.push(priorDiscoveryContext);
  return sections.join("\n\n");
}

async function readPackagedProtocolReference(relativePath: string, label: string): Promise<string> {
  return (await readPackagedProtocolReferenceDocument(relativePath, label)).content;
}

async function readPackagedProtocolReferenceDocument(
  relativePath: string,
  label: string
): Promise<{ path: string; content: string }> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.join(process.cwd(), relativePath),
    ...(resourcesPath ? [
      path.join(resourcesPath, "app.asar.unpacked", relativePath),
      path.join(resourcesPath, "app.asar", relativePath)
    ] : [])
  ];
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      if (!content.trim()) throw new Error(`${label} is empty at ${candidate}.`);
      return { path: candidate, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`${label} was not found. Checked: ${candidates.join(", ")}`);
}

async function readTranslationSubagentGuidance(): Promise<string> {
  return readPackagedProtocolReference(
    path.join("translation-protocol", "translation-child.md"),
    "Translation subagent guidance"
  );
}

async function readProofreadSubagentGuidanceDocument(): Promise<{ path: string; content: string }> {
  return readPackagedProtocolReferenceDocument(
    path.join("translation-protocol", "proofread-child.md"),
    "Proofreading child task contract"
  );
}

async function translationReferenceContext(
  request: PiSessionPromptRequest,
  executionMode: PiTranslationSubagentContext["executionMode"],
  task: PiSubagentRangeTask
): Promise<string> {
  if (executionMode === "bounded_repair" || executionMode === "chunk_review_repair") return "";
  const [guidance, projectContext] = await Promise.all([
    readTranslationSubagentGuidance(),
    optionalContext(request, task)
  ]);
  const assetSwitches = [
    request.glossaryCandidates === false
      ? "New glossary-candidate collection is disabled for this assignment. Existing candidate entries remain read-only translation references; do not construct or report new candidate discoveries."
      : "Glossary-candidate collection is enabled for this assignment.",
    request.characterBible === false
      ? "New character-fact collection is disabled for this assignment. Existing character-bible entries remain read-only translation references; do not construct or report new character facts."
      : "Character-fact collection is enabled for this assignment."
  ].join(" ");
  return [
    `## Built-in translate-text child workflow\n${guidance}`,
    `## Host asset switches\n${assetSwitches}`,
    projectContext
  ].filter(Boolean).join("\n\n");
}

const MAX_DIRECT_REFERENCE_MATCHES = 64;
const MAX_DIRECT_REFERENCE_MATCH_CHARS = 16_000;

function referenceLookupTerms(entry: Record<string, unknown>, keys: string[]): string[] {
  const terms: string[] = [];
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string") {
      terms.push(...(key === "name" ? value.split(/\s*\/\s*/u) : [value]));
    } else if (Array.isArray(value)) {
      terms.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function referenceMentionForms(term: string): string[] {
  const normalized = term.trim();
  if (!normalized) return [];
  const forms = [normalized];
  const scriptRuns = normalized.match(
    /[\p{Script=Han}々〆ヵヶ]+|[\p{Script=Katakana}ー]+|[\p{Script=Hiragana}ー]+|[A-Za-z0-9]+/gu
  ) ?? [];
  if (scriptRuns.length > 1) {
    forms.push(...scriptRuns.filter((run) => Array.from(run).length >= 2));
  }
  return [...new Set(forms)];
}

function indexedReferenceLookupTerms(entry: Record<string, unknown>, kind: string): string[] {
  return kind === "character bible"
    ? referenceLookupTerms(entry, ["name", "target", "localizedName", "translation", "aliases"])
    : referenceLookupTerms(entry, ["source", "target", "aliases"]);
}

async function searchIndexedProjectReference(
  request: PiSessionPromptRequest,
  kind: string,
  queryValue: string,
  maxResultsValue?: number
) {
  const query = queryValue.trim();
  if (!query) throw new Error("query is required.");
  const [assets, workspaceAssets] = await Promise.all([
    readWorkflowProjectAssets({ outputDir: request.outputDir, glossaryPath: request.glossaryPath }),
    readWorkspaceAgentContext(request.outputDir)
  ]);
  const source = kind === "approved glossary"
    ? { path: assets.paths.glossary, entries: assets.glossary.entries }
    : kind === "character bible"
      ? { path: assets.paths.characterBible, entries: assets.characterBible.characters }
      : {
          path: workspaceAssets.paths.glossaryCandidates,
          entries: (workspaceAssets.glossaryCandidates ?? []).map((entry) => ({ ...entry }))
        };
  const normalizedQuery = query.normalize("NFKC").toLowerCase();
  const maxResults = Math.min(50, Math.max(1, maxResultsValue ?? 25));
  const ranked = source.entries.flatMap((entry, index) => {
    const ranks = indexedReferenceLookupTerms(entry, kind).flatMap((term) => {
      const normalizedTerm = term.normalize("NFKC").toLowerCase();
      if (normalizedTerm === normalizedQuery) return [0];
      if (normalizedTerm.startsWith(normalizedQuery)) return [1];
      if (normalizedTerm.includes(normalizedQuery)) return [2];
      if (Array.from(normalizedTerm).length >= 2 && normalizedQuery.includes(normalizedTerm)) return [3];
      return [];
    });
    return ranks.length > 0 ? [{ entry, index, rank: Math.min(...ranks) }] : [];
  }).sort((left, right) => left.rank - right.rank || left.index - right.index);
  const readable = resolveReadablePath(request.outputDir, source.path);
  return {
    ok: true as const,
    path: source.path,
    relativePath: readable.relativePath,
    outsideProject: readable.outsideProject,
    query,
    indexedReference: kind,
    matches: ranked.slice(0, maxResults).map(({ entry, index }) => ({
      path: readable.relativePath,
      line: index + 1,
      text: JSON.stringify(entry)
    })),
    omittedMatchCount: Math.max(0, ranked.length - maxResults)
  };
}

function directReferenceMatches(
  entries: Record<string, unknown>[],
  sourceText: string,
  lookupKeys: string[],
  budget: { remainingEntries: number; remainingChars: number },
  excludedKeys = new Set<string>()
): { entries: Record<string, unknown>[]; omitted: number } {
  const matched = entries.flatMap((entry, entryIndex) => {
    const key = `${String(entry.source ?? entry.name ?? "").trim()}\0${String(entry.target ?? "").trim()}`;
    if (excludedKeys.has(key)) return [];
    const positions = referenceLookupTerms(entry, lookupKeys)
      .flatMap(referenceMentionForms)
      .map((term) => sourceText.indexOf(term))
      .filter((index) => index >= 0);
    return positions.length > 0
      ? [{ entry, entryIndex, sourceIndex: Math.min(...positions) }]
      : [];
  }).sort((left, right) => left.sourceIndex - right.sourceIndex || left.entryIndex - right.entryIndex);
  const selected: Record<string, unknown>[] = [];
  for (const { entry } of matched) {
    const entryChars = JSON.stringify(entry).length;
    if (budget.remainingEntries < 1 || entryChars > budget.remainingChars) continue;
    selected.push(entry);
    budget.remainingEntries -= 1;
    budget.remainingChars -= entryChars;
  }
  return { entries: selected, omitted: matched.length - selected.length };
}

async function translationProjectReferences(request: PiSessionPromptRequest, sourceText: string) {
  const [assets, workspaceAssets] = await Promise.all([
    readWorkflowProjectAssets({ outputDir: request.outputDir, glossaryPath: request.glossaryPath }),
    readWorkspaceAgentContext(request.outputDir)
  ]);
  const reference = (absolutePath: string, available: boolean) => {
    const readable = resolveReadablePath(request.outputDir, absolutePath);
    return {
      path: readable.relativePath,
      available,
      ...(readable.outsideProject ? { outsideProject: true } : {})
    };
  };
  const directMatchBudget = {
    remainingEntries: MAX_DIRECT_REFERENCE_MATCHES,
    remainingChars: MAX_DIRECT_REFERENCE_MATCH_CHARS
  };
  const approvedGlossary = directReferenceMatches(
    assets.glossary.entries,
    sourceText,
    ["source"],
    directMatchBudget
  );
  const approvedGlossarySources = new Set(approvedGlossary.entries.map((entry) => (
    String(entry.source ?? "").trim().normalize("NFC")
  )).filter(Boolean));
  const characterBible = directReferenceMatches(
    assets.characterBible.characters,
    sourceText,
    ["name", "aliases"],
    directMatchBudget
  );
  const glossaryCandidates = directReferenceMatches(
    (workspaceAssets.glossaryCandidates ?? [])
      .filter((entry) => !approvedGlossarySources.has(entry.source.trim().normalize("NFC")))
      .map((entry) => ({ ...entry })),
    sourceText,
    ["source"],
    directMatchBudget
  );
  const directMatches = {
    approvedGlossary: approvedGlossary.entries,
    characterBible: characterBible.entries,
    glossaryCandidates: glossaryCandidates.entries,
    omitted: {
      approvedGlossary: approvedGlossary.omitted,
      characterBible: characterBible.omitted,
      glossaryCandidates: glossaryCandidates.omitted
    }
  };
  const hasDirectMatches = directMatches.approvedGlossary.length > 0
    || directMatches.characterBible.length > 0
    || directMatches.glossaryCandidates.length > 0
    || Object.values(directMatches.omitted).some((count) => count > 0);
  return {
    approvedGlossary: reference(assets.paths.glossary, assets.available.glossary),
    characterBible: reference(assets.paths.characterBible, assets.available.characterBible),
    styleGuide: reference(assets.paths.styleGuide, assets.available.styleGuide),
    glossaryCandidates: reference(
      workspaceAssets.paths.glossaryCandidates,
      workspaceAssets.glossaryCandidates !== undefined
    ),
    ...(hasDirectMatches ? { directMatches } : {})
  };
}

interface ProofreadReferenceDocument {
  id: string;
  label: string;
  content: string;
  required: boolean;
  sourcePath: string;
  sha256: string;
}

interface ProofreadReferenceBundle {
  workflow: { content: string; sourcePath: string; sha256: string };
  references: ProofreadReferenceDocument[];
  signature: string;
}

interface ProofreadWorkerReferenceCache {
  signature?: string;
  workflowSha256?: string;
  referenceSha256: Map<string, string>;
  bundle?: ProofreadReferenceBundle;
  projectKey?: string;
  watchedFingerprints?: Map<string, string>;
}

interface ProofreadAssignmentReferenceContext {
  bundle: ProofreadReferenceBundle;
  cache: ProofreadWorkerReferenceCache;
  status: "loaded" | "reused" | "refreshed";
}

function contentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function proofreadReferenceDocument(
  id: string,
  label: string,
  content: string,
  sourcePath: string,
  required = true
): ProofreadReferenceDocument | undefined {
  return content.trim()
    ? { id, label, content, required, sourcePath, sha256: contentSha256(content) }
    : undefined;
}

async function fileFingerprint(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function fingerprints(paths: string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(async (filePath) => [
    filePath,
    await fileFingerprint(filePath)
  ] as const)));
}

async function fingerprintsMatch(previous: Map<string, string> | undefined): Promise<boolean> {
  if (!previous) return false;
  const current = await fingerprints([...previous.keys()]);
  return [...previous].every(([filePath, fingerprint]) => current.get(filePath) === fingerprint);
}

async function loadFixedProofreadReferences(request: PiSessionPromptRequest): Promise<{
  workflow: ProofreadReferenceBundle["workflow"];
  references: ProofreadReferenceDocument[];
  watchedFingerprints: Map<string, string>;
}> {
  const [workflow, assets] = await Promise.all([
    readProofreadSubagentGuidanceDocument(),
    readWorkflowProjectAssets({ outputDir: request.outputDir, glossaryPath: request.glossaryPath })
  ]);
  const references = [
    proofreadReferenceDocument(
      "approved-style-guide",
      "Approved style guide",
      assets.styleGuide,
      assets.paths.styleGuide
    )
  ].filter((entry): entry is ProofreadReferenceDocument => Boolean(entry));
  const watchedPaths = [
    workflow.path,
    assets.paths.glossary,
    assets.paths.characterBible,
    assets.paths.styleGuide
  ];
  return {
    workflow: {
      content: workflow.content,
      sourcePath: workflow.path,
      sha256: contentSha256(workflow.content)
    },
    references,
    watchedFingerprints: await fingerprints(watchedPaths)
  };
}

async function loadDynamicProofreadReferences(
  request: PiSessionPromptRequest
): Promise<ProofreadReferenceDocument[]> {
  const webReferences = await buildCachedWebReferenceContext({
    prompt: request.prompt,
    workspaceDir: request.outputDir
  });
  return [
    proofreadReferenceDocument("project-style", "Project style", request.style ?? "", "request:style"),
    proofreadReferenceDocument(
      "work-description",
      "Work description",
      request.workDescription ?? "",
      "request:work-description"
    ),
    proofreadReferenceDocument(
      "cached-web-references",
      "Cached web references",
      webReferences,
      path.join(request.outputDir, ".translation-workshop", "agent", "web-references"),
      false
    )
  ].filter((entry): entry is ProofreadReferenceDocument => Boolean(entry));
}

async function proofreadReferenceBundle(
  request: PiSessionPromptRequest,
  cache?: ProofreadWorkerReferenceCache
): Promise<ProofreadReferenceBundle> {
  const projectKey = path.resolve(request.outputDir);
  const fixedUnchanged = cache?.projectKey === projectKey
    && await fingerprintsMatch(cache.watchedFingerprints);
  const [fixed, dynamicReferences] = await Promise.all([
    fixedUnchanged && cache?.bundle
      ? Promise.resolve({
          workflow: cache.bundle.workflow,
          references: cache.bundle.references.filter((reference) => (
            reference.id === "approved-style-guide"
          )),
          watchedFingerprints: cache.watchedFingerprints!
        })
      : loadFixedProofreadReferences(request),
    loadDynamicProofreadReferences(request)
  ]);
  const references = [...fixed.references, ...dynamicReferences];
  const signature = contentSha256(JSON.stringify({
    workflow: { sourcePath: fixed.workflow.sourcePath, sha256: fixed.workflow.sha256 },
    references: references.map(({ id, sourcePath, sha256, required }) => ({
      id,
      sourcePath,
      sha256,
      required
    }))
  }));
  const bundle = {
    workflow: fixed.workflow,
    references,
    signature
  };
  if (cache) {
    cache.bundle = bundle;
    cache.projectKey = projectKey;
    cache.watchedFingerprints = fixed.watchedFingerprints;
  }
  return bundle;
}

async function validateAssignedRange(context: PiTranslationSubagentContext, toolSignal?: AbortSignal) {
  throwIfAborted(context.signal, toolSignal);
  const source = splitTextLines(await readFile(sourcePath(context.request), "utf8"));
  throwIfAborted(context.signal, toolSignal);
  const candidatePath = translationWorkingCandidatePath(context);
  let candidate: string[] = [];
  try {
    candidate = splitTextLines(await readFile(candidatePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throwIfAborted(context.signal, toolSignal);
  const from = context.task.fromLine - 1;
  const sourceSlice = source.slice(from, context.task.toLine);
  const candidateSlice = candidate.slice(from, context.task.toLine);
  const validation = validateTranslationCandidate(
    sourceSlice.join("\n"),
    candidateSlice.join("\n"),
    await createYnTranslationValidationOptions(context.request)
  );
  return {
    candidatePath,
    sourceSlice,
    candidateSlice,
    validation,
    accepted: (
      context.executionMode === "bounded_repair"
        ? isYnTranslationChunkWritable(validation)
        : isYnTranslationArtifactAccepted(validation)
    ) && candidateSlice.length === sourceSlice.length
  };
}

function validateAssignedSemanticAlignment(
  context: PiTranslationSubagentContext,
  progress: PiTranslationProgress,
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>,
  misalignedLines: number[] | undefined
) {
  if (context.executionMode !== "bounded_repair") return undefined;
  if (!misalignedLines) {
    progress.translationValidated = false;
    progress.translationAlignmentHash = undefined;
    throw new Error(
      "Bounded translation validation requires misalignedLines; use an empty array when no assigned row remains misaligned."
    );
  }
  const selectedLines = selectedTranslationRepairLines(context.task);
  const selectedSet = selectedLines.length > 0 ? new Set(selectedLines) : undefined;
  const uniqueLines = new Set<number>();
  for (const line of misalignedLines) {
    if (uniqueLines.has(line)) {
      throw new Error(`Duplicate misaligned line L${line}.`);
    }
    if (
      line < context.task.fromLine
      || line > context.task.toLine
      || (selectedSet && !selectedSet.has(line))
    ) {
      throw new Error(
        selectedSet
          ? `Misaligned line L${line} is outside the Host-selected repair lines (${selectedLines.map((selected) => `L${selected}`).join(", ")}).`
          : `Misaligned line L${line} is outside assigned range L${context.task.fromLine}-L${context.task.toLine}.`
      );
    }
    uniqueLines.add(line);
  }

  const sourceForAlignment = selectedLines.length > 0
    ? selectedLines.map((line) => artifact.sourceSlice[line - context.task.fromLine] ?? "")
    : artifact.sourceSlice;
  const candidateForAlignment = selectedLines.length > 0
    ? selectedLines.map((line) => artifact.candidateSlice[line - context.task.fromLine] ?? "")
    : artifact.candidateSlice;
  const audit = createTranslationAlignmentAudit({
    documentId: documentId(context.request),
    sourceText: sourceForAlignment.join("\n"),
    candidateText: candidateForAlignment.join("\n"),
    candidatePath: artifact.candidatePath,
    languagePair: context.request.languagePair
  });
  const remaining = [...uniqueLines].sort((left, right) => left - right);
  if (remaining.length > 0) {
    progress.translationValidated = false;
    progress.translationAlignmentHash = undefined;
    progress.requiredBatchLines = new Set(remaining);
    throw new Error(
      `Assigned translation semantic alignment still fails at ${remaining.map((line) => `L${line}`).join(", ")}. `
      + "Repair those exact lines, then submit a fresh lightweight alignment result."
    );
  }
  progress.translationAlignmentHash = audit.inputHash;
  return {
    auditId: audit.auditId,
    inputHash: audit.inputHash,
    checkedLineCount: sourceForAlignment.length,
    mechanicalSignalCount: audit.checks.filter((check) => check.signals.length > 0).length
  };
}

function assertCurrentAssignedSemanticAlignment(
  context: PiTranslationSubagentContext,
  progress: PiTranslationProgress,
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>
): void {
  if (context.executionMode !== "bounded_repair") return;
  const selectedLines = selectedTranslationRepairLines(context.task);
  const sourceForAlignment = selectedLines.length > 0
    ? selectedLines.map((line) => artifact.sourceSlice[line - context.task.fromLine] ?? "")
    : artifact.sourceSlice;
  const candidateForAlignment = selectedLines.length > 0
    ? selectedLines.map((line) => artifact.candidateSlice[line - context.task.fromLine] ?? "")
    : artifact.candidateSlice;
  const current = createTranslationAlignmentAudit({
    documentId: documentId(context.request),
    sourceText: sourceForAlignment.join("\n"),
    candidateText: candidateForAlignment.join("\n"),
    candidatePath: artifact.candidatePath,
    languagePair: context.request.languagePair
  });
  if (!progress.translationAlignmentHash || progress.translationAlignmentHash !== current.inputHash) {
    progress.translationValidated = false;
    progress.translationAlignmentHash = undefined;
    throw new Error(
      "The bounded translation candidate changed after semantic line-identity validation. Submit fresh misalignedLines before completion."
    );
  }
}

async function validateExistingAssignedRange(
  context: PiTranslationSubagentContext,
  toolSignal?: AbortSignal
) {
  try {
    await readFile(translationWorkingCandidatePath(context), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return validateAssignedRange(context, toolSignal);
}

function hasExistingAssignedTranslation(
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>
): boolean {
  return artifact.sourceSlice.some((sourceLine, index) => (
    sourceLine.trim() !== "" && (artifact.candidateSlice[index]?.trim() ?? "") !== ""
  ));
}

export interface AssignedTranslationRepairPlanInput {
  fromLine: number;
  sourceSlice: string[];
  validation: TranslationValidationResult;
  requiredLines?: number[];
  languagePair?: string;
  executionMode?: "full_workflow" | "bounded_repair" | "chunk_review_repair";
  glossaryCandidates?: boolean;
}

export function buildAssignedTranslationRepairPlan(input: AssignedTranslationRepairPlanInput) {
  const findings = input.executionMode === "bounded_repair"
    ? [...input.validation.blocking, ...ynTranslationStructuralWarnings(input.validation)]
    : [...input.validation.blocking];
  const rawIssues: Array<{
    code: string;
    severity: "blocking" | "warning";
    detail: string;
    line?: number;
  }> = findings.map((finding) => {
    const relativeLine = finding.line;
    const line = relativeLine === undefined ? undefined : input.fromLine + relativeLine - 1;
    return {
      code: finding.code,
      severity: finding.severity,
      detail: finding.detail,
      ...(line === undefined ? {} : { line })
    };
  });
  const issues = [...new Map(rawIssues.map((issue) => [
    `${issue.code}\0${issue.line ?? "range"}`,
    issue
  ])).values()];
  const assignmentToLine = input.fromLine + input.sourceSlice.length - 1;
  const requiredLines = [...new Set(input.requiredLines ?? [])]
    .filter((line) => Number.isInteger(line) && line >= input.fromLine && line <= assignmentToLine)
    .sort((left, right) => left - right);
  const issueLines = new Set(issues.flatMap((issue) => issue.line === undefined ? [] : [issue.line]));
  for (const line of requiredLines) {
    if (issueLines.has(line)) continue;
    issues.push({
      code: "host_required",
      severity: "warning",
      detail: `L${line} remains in the host-owned repair set and requires a fresh structurally valid translated value.`,
      line
    });
  }
  const fingerprint = JSON.stringify({
    sourceLineCount: input.validation.sourceLineCount,
    candidateLineCount: input.validation.candidateLineCount,
    issues
  });
  const repairLines = [...new Set(
    issues.flatMap((issue) => issue.line === undefined ? [] : [issue.line])
  )].sort((left, right) => left - right);
  const requiredBatchLines = repairLines.slice(0, MAX_STRUCTURED_TRANSLATION_REPAIR_LINES);
  const requiredBatchLineSet = new Set(requiredBatchLines);
  const repairInstruction = repairLines.length > 0
    ? [
      `Use the sourceBlocks returned by readAssignedSource to translate each required absolute line into the target language required by the workflow${input.languagePair?.trim() ? ` (${input.languagePair.trim()})` : ""}; returning the source unchanged is a failed repair.`,
      `Call repairAssignedTranslation once with entries for the next ${requiredBatchLines.length} required lines.`,
      "Use structured { line, translation } entries in ascending order. The host retains each valid correction and returns only lines still requiring repair. Do not call writeAssignedTranslation while host-required repair lines remain."
    ].join(" ")
    : "Use one batched repairAssignedTranslation call for the complete rejected range, using structured { line, translation } entries.";
  const sampledIssues = issues
    .filter((issue) => issue.line === undefined || requiredBatchLineSet.has(issue.line))
    .slice(0, MAX_TRANSLATION_REPAIR_ISSUE_SAMPLES);
  const repairEvidence = {
    summary: input.validation.summary,
    sourceLineCount: input.validation.sourceLineCount,
    candidateLineCount: input.validation.candidateLineCount,
    requiredLineCount: repairLines.length,
    requiredBatchLines,
    remainingRequiredLineCount: repairLines.length - requiredBatchLines.length,
    issues: sampledIssues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      detail: issue.detail,
      ...(issue.line === undefined ? {} : { absoluteLine: issue.line }),
    })),
    omittedIssueCount: Math.max(0, issues.length - sampledIssues.length)
  };
  const prompt = [
    "The host rejected only the listed lines from this translated chunk. Repair only those lines; every other translated line is already retained and repairAssignedTranslation performs the next strict validation.",
    requiredBatchLines.length > 0
      ? "Before repairing, call readAssignedSource only for compact spans covering the requiredBatchLines below. Do not read the entire assigned chunk when only sparse rows are rejected."
      : input.sourceSlice.length > MAX_ASSIGNED_TRANSLATION_CHUNK_LINES
        ? `Before repairing, call readAssignedSource in ordered chunks of at most ${MAX_ASSIGNED_TRANSLATION_CHUNK_LINES} lines until the assigned range is covered.`
        : "Call readAssignedSource for the exact assigned range before repairing if this assignment has not read it yet.",
    input.glossaryCandidates === false
      ? "Then use each issue's absolute line, exact validation detail, and the matching source line from the sourceBlocks returned by readAssignedSource. Glossary-candidate collection is disabled; translate intentional proper nouns directly instead of returning the source unchanged."
      : "Then use each issue's absolute line, exact validation detail, and the matching source line from the sourceBlocks returned by readAssignedSource. If an intentional proper noun needs a consistent rendering, report the term and target-language rendering as a glossary candidate instead of returning the source unchanged.",
    repairInstruction,
    JSON.stringify(repairEvidence)
  ].join("\n\n");
  return { issues, repairLines, fingerprint, prompt };
}

function isStructurallyCompleteAssignedTranslation(
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>
): boolean {
  return artifact.sourceSlice.length === artifact.candidateSlice.length;
}

function isLineAlignedAssignedTranslation(
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>
): boolean {
  return artifact.sourceSlice.length === artifact.candidateSlice.length;
}

function assignedCandidateHash(
  context: PiTranslationSubagentContext,
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>
): string {
  return contentSha256(JSON.stringify({
    fromLine: context.task.fromLine,
    toLine: context.task.toLine,
    candidate: artifact.candidateSlice
  }));
}

function assignedTranslationRepairExhaustionError(args: {
  context: PiTranslationSubagentContext;
  progress: PiTranslationProgress;
  artifact: Awaited<ReturnType<typeof validateAssignedRange>>;
  message: string;
}): NonRetryableAssignmentError {
  const rejectedLines = [...new Set(args.progress.requiredBatchLines ?? [])]
    .filter((line) => line >= args.context.task.fromLine && line <= args.context.task.toLine)
    .sort((left, right) => left - right);
  if (rejectedLines.length === 0) return new NonRetryableAssignmentError(args.message);

  const rejectedLineSet = new Set(rejectedLines);
  const issueFeedback = (args.progress.requiredBatchIssues ?? [])
    .filter((issue) => issue.absoluteLine !== undefined && rejectedLineSet.has(issue.absoluteLine))
    .map((issue) => `L${issue.absoluteLine} ${issue.code}: ${issue.detail}`);
  const validationFeedback = [
    ...args.artifact.validation.blocking,
    ...ynTranslationStructuralWarnings(args.artifact.validation)
  ].flatMap((finding) => {
    if (finding.line === undefined) return [];
    const absoluteLine = args.context.task.fromLine + finding.line - 1;
    return rejectedLineSet.has(absoluteLine)
      ? [`L${absoluteLine} ${finding.code}: ${finding.detail}`]
      : [];
  });
  const feedback = [...new Set([...issueFeedback, ...validationFeedback])].join("; ")
    || rejectedLines.map((line) => (
      `L${line} host_required: write a fresh structurally valid translated value`
    )).join("; ");
  return new ParentTakeoverAssignmentError(args.message, {
    documentId: args.context.task.documentId || documentId(args.context.request),
    fromLine: args.context.task.fromLine,
    toLine: args.context.task.toLine,
    rejectedLines,
    feedback,
    ...(args.context.workingCandidatePath
      ? { stagingCandidatePath: args.context.workingCandidatePath }
      : {}),
    candidateHash: assignedCandidateHash(args.context, args.artifact)
  });
}

function normalizedTranslationReviewFeedback(
  decision: Extract<PiTranslationChunkReviewDecision, { accepted: false }>,
  range: { fromLine: number; toLine: number }
): Array<{ line: number; reason: string }> {
  const feedback = decision.feedback.map((entry) => ({
    line: entry.line,
    reason: entry.reason.trim()
  }));
  if (
    feedback.length === 0
    || feedback.some((entry) => (
      !Number.isInteger(entry.line)
      || entry.line < range.fromLine
      || entry.line > range.toLine
      || !entry.reason
    ))
  ) {
    throw new NonRetryableAssignmentError(
      `Review-worker rejection for L${range.fromLine}-L${range.toLine} must include exact in-range lines and actionable repair reasons.`
    );
  }
  return feedback
    .sort((left, right) => left.line - right.line || left.reason.localeCompare(right.reason));
}

function reviewFeedbackSummary(feedback: Array<{ line: number; reason: string }>): string {
  return feedback.map((entry) => `L${entry.line} ${entry.reason}`).join("; ");
}

export const MAX_ASSIGNED_TRANSLATION_CHUNK_LINES = 1024;
export const MAX_ASSIGNED_TRANSLATION_REPAIR_TURNS = 4;
export const MAX_TRANSLATION_REVIEW_REPAIR_CYCLES = 3;
const MAX_TRANSLATION_CONTEXT_LINES = 40;
export const MAX_TRANSLATION_MODEL_PAGE_LINES = 500;
const MAX_SPARSE_TRANSLATION_ENTRY_LINES = 16;
const MAX_HOST_CONTRACT_NO_PROGRESS_TURNS = 3;
const TRANSLATION_WIRE_BLOCK_LINES = 16;
const MAX_STRUCTURED_TRANSLATION_REPAIR_LINES = TRANSLATION_WIRE_BLOCK_LINES * 16;
const MAX_TRANSLATION_REPAIR_ISSUE_SAMPLES = 32;

interface TranslationWireLine {
  line: number;
  sourceText: string;
}

interface TranslationWireBlock {
  id: string;
  lines: TranslationWireLine[];
}

interface TranslationWireOutputBlock {
  id: string;
  lines: string[];
}

interface TranslationRepairEntry {
  line: number;
  translation: string;
}

type TranslationRepairInputEntry = TranslationRepairEntry | string;

interface TranslationWireInvalidBlock {
  id: string;
  expectedLines: number;
  actualLines: number;
}

function translationWireBlocksFromLines(nonEmptyLines: TranslationWireLine[]): TranslationWireBlock[] {
  const blocks: TranslationWireBlock[] = [];
  for (let index = 0; index < nonEmptyLines.length; index += TRANSLATION_WIRE_BLOCK_LINES) {
    blocks.push({
      id: Math.floor(index / TRANSLATION_WIRE_BLOCK_LINES).toString(36),
      lines: nonEmptyLines.slice(index, index + TRANSLATION_WIRE_BLOCK_LINES)
    });
  }
  return blocks;
}

function translationWireBlocks(source: string[], fromLine: number): TranslationWireBlock[] {
  return translationWireBlocksFromLines(source.flatMap((sourceText, index) => sourceText.trim() === ""
    ? []
    : [{ line: fromLine + index, sourceText }]));
}

function translationWireSourceBlock(block: TranslationWireBlock) {
  return {
    id: block.id,
    absoluteLines: block.lines.map((line) => line.line),
    lines: block.lines.map((line, index) => `${index.toString(36)}${line.sourceText}`)
  };
}

function normalizeTranslationRepairEntry(
  entry: TranslationRepairInputEntry,
  operation: string
): TranslationRepairEntry {
  if (typeof entry === "string") {
    const separator = entry.indexOf(":");
    const line = separator > 0 ? Number(entry.slice(0, separator)) : Number.NaN;
    if (!Number.isInteger(line)) {
      throw new Error(`Each ${operation} entry must be a structured { line, translation } object.`);
    }
    return { line, translation: entry.slice(separator + 1) };
  }
  if (
    !entry
    || Array.isArray(entry)
    || typeof entry !== "object"
    || !Number.isInteger(entry.line)
    || typeof entry.translation !== "string"
  ) {
    throw new Error(`Each ${operation} entry must be a structured { line, translation } object.`);
  }
  return { line: entry.line, translation: entry.translation };
}

function parseTranslationWireOutputBlocks(
  expectedWireBlocks: TranslationWireBlock[],
  translatedBlocks: TranslationWireOutputBlock[]
): {
  translations: Map<number, string>;
  invalidBlocks: TranslationWireInvalidBlock[];
  invalidBlockLines: Set<number>;
} {
  const expectedBlocks = new Map(expectedWireBlocks.map((block) => [block.id, block]));
  const submittedBlocks = new Set<string>();
  const translations = new Map<number, string>();
  const invalidBlocks: TranslationWireInvalidBlock[] = [];
  const invalidBlockLines = new Set<number>();
  for (const translatedBlock of translatedBlocks) {
    const expected = expectedBlocks.get(translatedBlock.id);
    if (!expected) throw new Error(`Translated block ${translatedBlock.id} is not part of this host-provided range.`);
    if (submittedBlocks.has(translatedBlock.id)) throw new Error(`Translated block ${translatedBlock.id} is duplicated.`);
    submittedBlocks.add(translatedBlock.id);
    const records = translatedBlock.lines.filter((record) => record.trim() !== "");
    const expectedFields = new Map(expected.lines.map((line, index) => [index.toString(36), line]));
    const submittedFields = new Set<string>();
    let previousLine: number | undefined;
    for (const record of records) {
      const normalizedRecord = record.replace(/^[ \t]+/, "");
      const fieldId = normalizedRecord.slice(0, 1);
      const expectedLine = expectedFields.get(fieldId);
      if (!expectedLine) {
        if (previousLine !== undefined) {
          invalidBlockLines.add(previousLine);
          translations.delete(previousLine);
        }
        continue;
      }
      previousLine = expectedLine.line;
      if (submittedFields.has(fieldId)) {
        invalidBlockLines.add(expectedLine.line);
        translations.delete(expectedLine.line);
        continue;
      }
      submittedFields.add(fieldId);
      const text = normalizedRecord.slice(1);
      if (text.includes("\n") || text.includes("\r")) {
        invalidBlockLines.add(expectedLine.line);
        continue;
      }
      if (!invalidBlockLines.has(expectedLine.line)) translations.set(expectedLine.line, text);
    }
    if (submittedFields.size !== expected.lines.length) {
      invalidBlocks.push({
        id: translatedBlock.id,
        expectedLines: expected.lines.length,
        actualLines: submittedFields.size
      });
    }
    for (const [fieldId, expectedLine] of expectedFields) {
      if (!submittedFields.has(fieldId)) invalidBlockLines.add(expectedLine.line);
    }
  }
  return { translations, invalidBlocks, invalidBlockLines };
}

interface AssignedChunkInput {
  fromLine?: number;
  toLine?: number;
}

function selectedTranslationRepairLines(task: PiTranslationSubagentTask): number[] {
  const selected = [...new Set(task.selectedLines ?? [])].sort((left, right) => left - right);
  for (const line of selected) {
    if (!Number.isInteger(line) || line < task.fromLine || line > task.toLine) {
      throw new Error(
        `Selected translation repair line L${line} must stay inside L${task.fromLine}-L${task.toLine}.`
      );
    }
  }
  return selected;
}

function assignedRange(
  task: PiSubagentRangeTask,
  input: AssignedChunkInput,
  operation: string,
  maxLines?: number
): { fromLine: number; toLine: number } {
  const assignmentLength = task.toLine - task.fromLine + 1;
  const hasFrom = input.fromLine !== undefined;
  const hasTo = input.toLine !== undefined;
  if (hasFrom !== hasTo) throw new Error(`${operation} requires both fromLine and toLine.`);
  if (!hasFrom && maxLines !== undefined && assignmentLength > maxLines) {
    throw new Error(
      `${operation} must process this ${assignmentLength}-line assignment in chunks of at most ${maxLines} lines.`
    );
  }
  const fromLine = hasFrom ? Math.floor(input.fromLine!) : task.fromLine;
  const toLine = hasTo ? Math.floor(input.toLine!) : task.toLine;
  if (
    !Number.isInteger(fromLine)
    || !Number.isInteger(toLine)
    || fromLine < task.fromLine
    || toLine < fromLine
    || toLine > task.toLine
  ) {
    throw new Error(
      `${operation} range ${input.fromLine ?? "(missing)"}-${input.toLine ?? "(missing)"} must stay inside L${task.fromLine}-L${task.toLine}.`
    );
  }
  if (maxLines !== undefined && toLine - fromLine + 1 > maxLines) {
    throw new Error(`${operation} accepts at most ${maxLines} lines per call.`);
  }
  return { fromLine, toLine };
}

function assignedRepairRange(
  task: PiSubagentRangeTask,
  input: AssignedChunkInput,
  operation: string
): { fromLine: number; toLine: number } {
  return assignedRange(task, input, operation);
}

function assignedSparseRepairRange(
  task: PiSubagentRangeTask,
  input: AssignedChunkInput & { entries?: TranslationRepairInputEntry[] },
  operation: string
): { fromLine: number; toLine: number } {
  const lines = (input.entries ?? []).map((entry) => normalizeTranslationRepairEntry(entry, operation).line);
  if (lines.length === 0) return assignedRepairRange(task, input, operation);
  return assignedRepairRange(task, {
    fromLine: Math.min(...lines),
    toLine: Math.max(...lines)
  }, operation);
}

function markCovered(lines: Set<number>, range: { fromLine: number; toLine: number }): void {
  for (let line = range.fromLine; line <= range.toLine; line += 1) lines.add(line);
}

function contiguousLineRanges(lines: number[]): Array<{ fromLine: number; toLine: number }> {
  const ordered = [...new Set(lines)].sort((left, right) => left - right);
  const ranges: Array<{ fromLine: number; toLine: number }> = [];
  for (const line of ordered) {
    const current = ranges.at(-1);
    if (current && line === current.toLine + 1) {
      current.toLine = line;
    } else {
      ranges.push({ fromLine: line, toLine: line });
    }
  }
  return ranges;
}

function isCovered(lines: Set<number>, range: { fromLine: number; toLine: number }): boolean {
  for (let line = range.fromLine; line <= range.toLine; line += 1) {
    if (!lines.has(line)) return false;
  }
  return true;
}

function areLinesCovered(lines: Set<number>, requiredLines: readonly number[]): boolean {
  return requiredLines.every((line) => lines.has(line));
}

function missingAssignedRange(
  lines: Set<number>,
  task: PiSubagentRangeTask,
  pageLines = MAX_TRANSLATION_MODEL_PAGE_LINES
): { fromLine: number; toLine: number } | undefined {
  let fromLine: number | undefined;
  for (let line = task.fromLine; line <= task.toLine; line += 1) {
    if (!lines.has(line)) {
      fromLine ??= line;
      if (line - fromLine + 1 >= pageLines) {
        return { fromLine, toLine: line };
      }
    } else if (fromLine !== undefined) {
      return { fromLine, toLine: line - 1 };
    }
  }
  return fromLine === undefined ? undefined : { fromLine, toLine: task.toLine };
}

function assignedSourcePageRange(
  task: PiSubagentRangeTask,
  input: AssignedChunkInput,
  readLines: Set<number>
): { range: { fromLine: number; toLine: number }; requestedToLine?: number } {
  const hasFrom = input.fromLine !== undefined;
  const hasTo = input.toLine !== undefined;
  if (hasFrom !== hasTo) {
    throw new Error("readAssignedSource requires both fromLine and toLine.");
  }
  if (!hasFrom) {
    return {
      range: missingAssignedRange(readLines, task)
        ?? {
          fromLine: task.fromLine,
          toLine: Math.min(task.toLine, task.fromLine + MAX_TRANSLATION_MODEL_PAGE_LINES - 1)
        }
    };
  }
  const requested = assignedRange(task, input, "readAssignedSource");
  const toLine = Math.min(requested.toLine, requested.fromLine + MAX_TRANSLATION_MODEL_PAGE_LINES - 1);
  return {
    range: { fromLine: requested.fromLine, toLine },
    ...(toLine < requested.toLine ? { requestedToLine: requested.toLine } : {})
  };
}

function assignedWritePageRange(
  task: PiSubagentRangeTask,
  input: AssignedChunkInput,
  activeSourcePage: { fromLine: number; toLine: number } | undefined
): { fromLine: number; toLine: number } {
  const hasFrom = input.fromLine !== undefined;
  const hasTo = input.toLine !== undefined;
  if (hasFrom !== hasTo) {
    throw new Error("writeAssignedTranslation requires both fromLine and toLine.");
  }
  if (hasFrom) {
    return assignedRange(task, input, "writeAssignedTranslation", MAX_TRANSLATION_MODEL_PAGE_LINES);
  }
  if (!activeSourcePage) {
    throw new Error("Call readAssignedSource before writing the current model page.");
  }
  return activeSourcePage;
}

function translationPreparationDebt(progress: PiTranslationProgress, task: PiTranslationSubagentTask): number {
  const readLines = progress.readLines ?? new Set<number>();
  const writtenLines = progress.writtenLines ?? new Set<number>();
  let debt = progress.referenceRead ? 0 : 1;
  const selected = selectedTranslationRepairLines(task);
  const lines = selected.length > 0
    ? selected
    : Array.from({ length: task.toLine - task.fromLine + 1 }, (_, index) => task.fromLine + index);
  for (const line of lines) {
    if (!readLines.has(line)) debt += 1;
    if (!writtenLines.has(line)) debt += 1;
  }
  return debt;
}

export type PiTranslationToolHostControl = "continue" | "return_after_tool_batch";

export interface PiTranslationSubagentTool extends AgentTool {
  hostControl: PiTranslationToolHostControl;
}

function requireTranslationToolCapabilities(
  tools: readonly AgentTool[]
): PiTranslationSubagentTool[] {
  for (const tool of tools) {
    const hostControl = (tool as Partial<PiTranslationSubagentTool>).hostControl;
    if (hostControl !== "continue" && hostControl !== "return_after_tool_batch") {
      throw new Error(`Pi translation subagent tool ${tool.name} must declare its Host-control capability.`);
    }
  }
  return tools as PiTranslationSubagentTool[];
}

export function createTranslationWriteBatchHandoff(
  tools: readonly PiTranslationSubagentTool[]
): (
  context: AfterToolCallContext
) => Promise<AfterToolCallResult | undefined> {
  const hostControlByToolName = new Map<string, PiTranslationToolHostControl>();
  for (const tool of tools) {
    if (hostControlByToolName.has(tool.name)) {
      throw new Error(`Duplicate Pi translation subagent tool definition: ${tool.name}.`);
    }
    hostControlByToolName.set(tool.name, tool.hostControl);
  }
  return async (context) => {
    // A rejected terminal tool must stay in the same Pi turn so the child can
    // consume the exact error and repair its current assignment. Marking the
    // failed result terminal makes the supervisor retry the whole range.
    if (context.isError) return undefined;
    const toolCalls = context.assistantMessage.content.filter((block) => block.type === "toolCall");
    const returnsToHost = toolCalls.some((toolCall) => (
      hostControlByToolName.get(toolCall.name) === "return_after_tool_batch"
    ));
    if (!returnsToHost) return undefined;
    return toolCalls.some((toolCall) => toolCall.id === context.toolCall.id)
      ? { terminate: true }
      : undefined;
  };
}

export function createPiTranslationSubagentTools(
  context: PiTranslationSubagentContext,
  progress: PiTranslationProgress = {
    referenceRead: false,
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  }
): PiTranslationSubagentTool[] {
  progress.readLines ??= new Set<number>();
  progress.writtenLines ??= new Set<number>();
  progress.mutatedLines ??= new Set<number>();
  const selectedRepairLines = context.executionMode === "bounded_repair"
    ? selectedTranslationRepairLines(context.task)
    : [];
  const readSchema = selectedRepairLines.length > 0
    ? Type.Object({}, { additionalProperties: false })
    : Type.Object({
        fromLine: Type.Optional(Type.Integer({ minimum: context.task.fromLine })),
        toLine: Type.Optional(Type.Integer({ minimum: context.task.fromLine }))
      }, { additionalProperties: false });
  const translatedBlockSchema = Type.Object({
    id: Type.String({ description: "The exact sourceBlocks id." }),
    lines: Type.Array(Type.String(), {
      minItems: 1,
      description: "Ordered single-character relativeId followed immediately by translatedText for this source block."
    })
  }, { additionalProperties: false });
  const writeSchema = Type.Object({
    fromLine: Type.Optional(Type.Integer({ minimum: context.task.fromLine })),
    toLine: Type.Optional(Type.Integer({ minimum: context.task.fromLine })),
    blocks: Type.Array(translatedBlockSchema, {
      minItems: 1,
      description: "Initial bulk translation blocks. Mirror every sourceBlocks object and echo each compact relative line id exactly once."
    })
  }, { additionalProperties: false });
  const repairEntrySchema = Type.Object({
    line: Type.Integer({
      minimum: context.task.fromLine,
      maximum: context.task.toLine,
      description: "The exact absolute 1-based line from requiredBatchLines."
    }),
    translation: Type.String({
      minLength: 1,
      description: "The complete target-language translation for this one physical line."
    })
  }, { additionalProperties: false });
  const repairSchema = Type.Object({
    fromLine: Type.Optional(Type.Integer({ minimum: context.task.fromLine })),
    toLine: Type.Optional(Type.Integer({ minimum: context.task.fromLine })),
    entries: Type.Array(repairEntrySchema, {
      minItems: 1,
      maxItems: MAX_STRUCTURED_TRANSLATION_REPAIR_LINES,
      description: "Structured line/translation repairs for the host-reported requiredLines; never echo source text unchanged."
    })
  }, { additionalProperties: false });
  const glossaryCandidatesEnabled = context.request.glossaryCandidates !== false;
  const characterFactsEnabled = context.request.characterBible !== false;
  const validateSchema = Type.Object({
    fromLine: Type.Optional(Type.Integer({
      minimum: context.task.fromLine,
      maximum: context.task.toLine
    })),
    toLine: Type.Optional(Type.Integer({
      minimum: context.task.fromLine,
      maximum: context.task.toLine
    })),
    ...(context.executionMode === "bounded_repair" ? {
      misalignedLines: Type.Array(
        Type.Integer({ minimum: context.task.fromLine, maximum: context.task.toLine }), {
        maxItems: context.task.toLine - context.task.fromLine + 1
      })
    } : {}),
    ...(glossaryCandidatesEnabled ? { glossaryCandidates: Type.Optional(Type.Array(Type.Object({
      source: Type.String({ minLength: 1 }),
      target: Type.String({ minLength: 1 }),
      category: Type.Union([
        Type.Literal("proper_noun"),
        Type.Literal("character"),
        Type.Literal("organization"),
        Type.Literal("place"),
        Type.Literal("title"),
        Type.Literal("setting_term")
      ]),
      evidenceLine: Type.Integer({ minimum: context.task.fromLine, maximum: context.task.toLine }),
      rationale: Type.String({ minLength: 1, maxLength: 1_000 }),
      aliases: Type.Optional(Type.Array(Type.String({
        minLength: 1,
        description: "An alternate target-language rendering of this same source term; never put a source-language nickname or abbreviation here. Report a source nickname as its own candidate."
      }), {
        maxItems: 16,
        description: "Optional accepted target-language alternatives only."
      }))
    }, { additionalProperties: false }), { maxItems: 64 })) } : {}),
    ...(characterFactsEnabled ? { characterFacts: Type.Optional(Type.Array(Type.Object({
      sourceName: Type.String({ minLength: 1 }),
      targetName: Type.Optional(Type.String({ minLength: 1 })),
      evidenceLine: Type.Integer({ minimum: context.task.fromLine, maximum: context.task.toLine }),
      evidence: Type.String({ minLength: 1, maxLength: 2_000 }),
      gender: Type.Union([
        Type.Literal("male"),
        Type.Literal("female"),
        Type.Literal("nonbinary"),
        Type.Literal("unknown")
      ]),
      pronouns: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })),
      confidence: Type.Union([
        Type.Literal("confirmed"),
        Type.Literal("inferred"),
        Type.Literal("unknown")
      ])
    }, { additionalProperties: false }), { maxItems: 32 })) } : {})
  }, { additionalProperties: false });
  let executeAssignedTranslationWrite!: NonNullable<AgentTool["execute"]>;
  return [
    ...createPiSubagentReadOnlyProjectTools(context, {
      indexedReferenceReads: "search-only",
      searchResultLimit: 12,
      boundTranslationContext: true
    }).map((tool) => ({
      ...tool,
      hostControl: "continue" as const
    })),
    {
      name: "readTranslationContext",
      label: "readTranslationContext",
      hostControl: "continue",
      description: `Read a page of up to ${MAX_TRANSLATION_CONTEXT_LINES} numbered source and current-translation rows anywhere in the bound document for dialogue, pronoun, terminology, and scene context. Continue with nextFromLine as often as the translation requires. This is read-only and never expands the Host-owned write range L${context.task.fromLine}-L${context.task.toLine}.`,
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        const input = params as { fromLine: number; toLine: number };
        const sourceLines = splitTextLines(await readFile(sourcePath(context.request), "utf8"));
        if (input.toLine < input.fromLine || input.toLine > sourceLines.length) {
          throw new Error(
            `Translation context range L${input.fromLine}-L${input.toLine} is outside the bound source with ${sourceLines.length} lines.`
          );
        }
        const toLine = Math.min(input.toLine, input.fromLine + MAX_TRANSLATION_CONTEXT_LINES - 1);
        let translationLines: string[] = [];
        try {
	          translationLines = splitTextLines(await readFile(translationWorkingCandidatePath(context), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        throwIfAborted(context.signal, signal);
        return textResult({
          fromLine: input.fromLine,
          toLine,
          ...(toLine < input.toLine ? {
            requestedToLine: input.toLine,
            hasMore: true,
            nextFromLine: toLine + 1
          } : { hasMore: false }),
          totalLines: sourceLines.length,
          assignment: { fromLine: context.task.fromLine, toLine: context.task.toLine },
          writeAllowed: false,
          rows: Array.from({ length: toLine - input.fromLine + 1 }, (_, index) => {
            const line = input.fromLine + index;
            return {
              line,
              source: sourceLines[line - 1] ?? "",
              translation: translationLines[line - 1] ?? ""
            };
          })
        });
      }
    },
    {
      name: "readAssignedSource",
      label: "readAssignedSource",
      hostControl: "continue",
      description: context.executionMode === "bounded_repair" || context.executionMode === "chunk_review_repair"
        ? `Read one ordered source chunk for the host-owned bounded repair inside L${context.task.fromLine}-L${context.task.toLine}. Use readProjectFile/searchProjectText on demand for relevant project or user-provided external references; only artifact writes are assignment-bound.`
        : `Read one ordered source chunk for the host-owned write protocol inside L${context.task.fromLine}-L${context.task.toLine}, together with the complete built-in translation guide, canonical reference paths, and bounded direct glossary/character matches for this source. Use exact search for missing indexed terms and readProjectFile for other project, prior-translation, or user-provided external context; only artifact writes are assignment-bound.`,
      parameters: readSchema,
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        const input = params as AssignedChunkInput;
        const firstReferenceRead = !progress.referenceRead;
        const lines = splitTextLines(await readFile(sourcePath(context.request), "utf8"));
        const sourcePage = selectedRepairLines.length > 0
          ? { range: { fromLine: selectedRepairLines[0], toLine: selectedRepairLines.at(-1)! } }
          : assignedSourcePageRange(context.task, input, progress.readLines!);
        const range = sourcePage.range;
        const sourceBlocks = selectedRepairLines.length > 0
          ? contiguousLineRanges(selectedRepairLines).flatMap((selectedRange) => (
              translationWireBlocks(
                lines.slice(selectedRange.fromLine - 1, selectedRange.toLine),
                selectedRange.fromLine
              ).map((block) => ({
                ...translationWireSourceBlock(block),
                id: `s${selectedRange.fromLine}-${block.id}`
              }))
            ))
          : translationWireBlocks(
              lines.slice(range.fromLine - 1, range.toLine),
              range.fromLine
            ).map(translationWireSourceBlock);
        const visibleSourceLines = selectedRepairLines.length > 0
          ? selectedRepairLines.map((line) => lines[line - 1] ?? "")
          : lines.slice(range.fromLine - 1, range.toLine);
        const assignedSourceText = visibleSourceLines.join("\n");
        const [referenceContext, projectReferences] = await Promise.all([
          firstReferenceRead
            ? translationReferenceContext(context.request, context.executionMode, context.task)
            : Promise.resolve(undefined),
          translationProjectReferences(context.request, assignedSourceText)
        ]);
        let currentTranslation: string[] = [];
        if (context.executionMode === "bounded_repair" || context.executionMode === "chunk_review_repair") {
          try {
	            currentTranslation = splitTextLines(await readFile(translationWorkingCandidatePath(context), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        throwIfAborted(context.signal, signal);
        progress.referenceRead = true;
        progress.activeSourcePage = range;
        if (selectedRepairLines.length > 0) {
          for (const line of selectedRepairLines) progress.readLines!.add(line);
          progress.sourceRead = areLinesCovered(progress.readLines!, selectedRepairLines);
        } else {
          markCovered(progress.readLines!, range);
          progress.sourceRead = isCovered(progress.readLines!, context.task);
        }
        return textResult({
          ...(selectedRepairLines.length > 0
            ? { selectedLines: selectedRepairLines, selectedLineCount: selectedRepairLines.length }
            : {
                ...range,
                ...(sourcePage.requestedToLine ? { requestedToLine: sourcePage.requestedToLine } : {}),
                hasMore: !progress.sourceRead,
                ...(!progress.sourceRead
                  ? { nextFromLine: missingAssignedRange(progress.readLines!, context.task)?.fromLine }
                  : {})
              }),
          totalLines: lines.length,
          assignment: {
            fromLine: context.task.fromLine,
            toLine: context.task.toLine,
            ...(selectedRepairLines.length > 0 ? { selectedLines: selectedRepairLines } : {})
          },
          sourceBlocks,
          ...(context.executionMode === "bounded_repair" || context.executionMode === "chunk_review_repair" ? {
            currentTranslationEntries: (selectedRepairLines.length > 0
              ? selectedRepairLines
              : Array.from(
                  { length: range.toLine - range.fromLine + 1 },
                  (_, index) => range.fromLine + index
                )
            ).map((line) => `${line}:${currentTranslation[line - 1] ?? ""}`),
            artifactContract: {
              sourcePath: sourcePath(context.request),
              sourceReadOnly: true,
	              candidatePath: translationWorkingCandidatePath(context),
              encoding: "utf-8",
              lineNumbering: "1-based inclusive"
            }
          } : {}),
          ...(referenceContext ? { translationReference: referenceContext } : {}),
          projectReferences,
          blockFormat: "Each source block includes absoluteLines parallel to lines for exact evidenceLine lookup. Return translations as { id, lines: [\"relativeIdtranslation\", ...] }; the first character of every translated item is the 0-f relative marker and has no delimiter."
        });
      }
    },
    {
      name: "writeAssignedTranslation",
      label: "writeAssignedTranslation",
      hostControl: "return_after_tool_batch",
      description: `Merge the current model page of at most ${MAX_TRANSLATION_MODEL_PAGE_LINES} lines into the Host-owned logical assignment. The same worker retains assignment ownership and the Host retains every valid identified line.`,
      parameters: writeSchema,
      executionMode: "sequential",
      execute: executeAssignedTranslationWrite = async (_toolCallId, params, signal) => {
        throwIfAborted(context.signal, signal);
        const input = params as AssignedChunkInput & {
          blocks?: TranslationWireOutputBlock[];
          entries?: TranslationRepairInputEntry[];
        };
        if (!progress.referenceRead) {
          throw new Error("Call readAssignedSource successfully for the assigned range before writing.");
        }
        const requiredBatchLines = [...(progress.requiredBatchLines ?? [])].sort((left, right) => left - right);
        const submittedRepairLines = requiredBatchLines.length > 0 && Array.isArray(input.entries)
          ? input.entries.map((entry) => normalizeTranslationRepairEntry(entry, "repairAssignedTranslation").line)
          : undefined;
        const unauthorizedRepairLines = submittedRepairLines?.filter((line) => !progress.requiredBatchLines!.has(line)) ?? [];
        if (unauthorizedRepairLines.length > 0) {
          throw new Error(
            `Translated ${unauthorizedRepairLines.map((line) => `L${line}`).join(", ")} outside the Host-required sparse repair set (${requiredBatchLines.slice(0, 16).map((line) => `L${line}`).join(", ")}).`
          );
        }
        const range = requiredBatchLines.length > 0
          ? assignedSparseRepairRange(context.task, input, "repairAssignedTranslation")
          : assignedWritePageRange(context.task, input, progress.activeSourcePage);
        const missingReadLines = submittedRepairLines?.filter((line) => !progress.readLines!.has(line)) ?? [];
        if (submittedRepairLines
          ? !areLinesCovered(progress.readLines!, submittedRepairLines)
          : !isCovered(progress.readLines!, range)) {
          const missingRanges = contiguousLineRanges(missingReadLines);
          const requiredRead = missingRanges.length > 0
            ? missingRanges.map((item) => `L${item.fromLine}-L${item.toLine}`).join(", ")
            : `L${range.fromLine}-L${range.toLine}`;
          throw new Error(`Call readAssignedSource successfully for ${requiredRead} before writing that chunk.`);
        }
        const sourceLines = splitTextLines(await readFile(sourcePath(context.request), "utf8"));
        const source = sourceLines.slice(range.fromLine - 1, range.toLine);
        const wireBlocks = translationWireBlocks(source, range.fromLine);
        let translations = new Map<number, string>();
        let invalidBlocks: TranslationWireInvalidBlock[] = [];
        let invalidBlockLines = new Set<number>();
        const hasBlocks = Array.isArray(input.blocks);
        const hasEntries = Array.isArray(input.entries);
        if (hasBlocks === hasEntries) {
          throw new Error("Translation writing requires exactly one of blocks or entries.");
        }
        if (requiredBatchLines.length > 0 && !hasEntries) {
          throw new Error("Host-required sparse repair lines must be submitted as absolute-line entries.");
        }
        if (hasEntries) {
          const nonEmptyLineCount = source.filter((line) => line.trim() !== "").length;
          if (requiredBatchLines.length === 0 && nonEmptyLineCount > MAX_SPARSE_TRANSLATION_ENTRY_LINES) {
            throw new Error(
              "Bulk translation must mirror the sourceBlocks returned by readAssignedSource; absolute-line entries are reserved for sparse requiredLines repair."
            );
          }
          for (const rawEntry of input.entries!) {
            const entry = normalizeTranslationRepairEntry(rawEntry, "repairAssignedTranslation");
            const line = entry.line;
            const text = entry.translation;
            if (line < range.fromLine || line > range.toLine) {
              throw new Error(`Translated entry L${line} must stay inside L${range.fromLine}-L${range.toLine}.`);
            }
            if (requiredBatchLines.length > 0 && !progress.requiredBatchLines!.has(line)) {
              throw new Error(
                `Translated entry L${line} is not in the Host-required sparse repair set (${requiredBatchLines.slice(0, 16).map((requiredLine) => `L${requiredLine}`).join(", ") || "empty"}).`
              );
            }
            if (translations.has(line)) {
              throw new Error(`Translated entry L${line} is duplicated.`);
            }
            if (source[line - range.fromLine].trim() === "") {
              throw new Error(`L${line} is an empty source line preserved by the host and must not be submitted.`);
            }
            if (text.includes("\n") || text.includes("\r")) {
              throw new Error(`Translation for L${line} must contain exactly one physical line.`);
            }
            translations.set(line, text);
          }
        } else {
          ({ translations, invalidBlocks, invalidBlockLines } = parseTranslationWireOutputBlocks(
            wireBlocks,
            input.blocks!
          ));
        }
        const missing = source.flatMap((text, index) => {
          const line = range.fromLine + index;
          return text.trim() !== "" && !progress.writtenLines!.has(line) && !translations.has(line) ? [line] : [];
        });
        let existing: string[] = [];
        try {
	          existing = splitTextLines(await readFile(translationWorkingCandidatePath(context), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const proposedLines = source.map((sourceText, index) => {
          const line = range.fromLine + index;
          if (sourceText.trim() === "") return sourceText;
          const translated = translations.get(line);
          if (translated !== undefined && translated.trim() === "") return sourceText;
          return translated ?? (existing[line - 1] || sourceText);
        });
        throwIfAborted(context.signal, signal);
        const proposedValidation = validateTranslationCandidate(
          source.join("\n"),
          proposedLines.join("\n"),
          await createYnTranslationValidationOptions(context.request)
        );
        const structurallyRejectedLines = new Set<number>(missing);
        for (const line of invalidBlockLines) structurallyRejectedLines.add(line);
        for (const [line, text] of translations) {
          if (text.trim() === "") structurallyRejectedLines.add(line);
        }
        const proposedStructuralFindings = [
          ...proposedValidation.blocking,
          ...ynTranslationStructuralWarnings(proposedValidation)
        ];
        for (const finding of proposedStructuralFindings) {
          if (finding.line !== undefined) structurallyRejectedLines.add(range.fromLine + finding.line - 1);
        }
        const persistedLines = proposedLines.map((text, index) => {
          const line = range.fromLine + index;
          if (!structurallyRejectedLines.has(line)) return text;
          // Retain an existing human/model candidate during repair, but never
          // manufacture copied-source filler for a missing translation.
          return existing[line - 1] ?? "";
        });
        const persistedValidation = validateTranslationCandidate(
          source.join("\n"),
          persistedLines.join("\n"),
          await createYnTranslationValidationOptions(context.request)
        );
        throwIfAborted(context.signal, signal);
        const sparseEntries = selectedRepairLines.length > 0
          ? [...translations.keys()]
              .filter((line) => !structurallyRejectedLines.has(line))
              .sort((left, right) => left - right)
              .map((line) => ({
                line,
                text: persistedLines[line - range.fromLine] ?? existing[line - 1] ?? ""
              }))
          : [];
	        const result = selectedRepairLines.length > 0
            ? sparseEntries.length > 0
              ? await writeTranslationLines({
                  outputDir: context.request.outputDir,
                  sourcePaths: [sourcePath(context.request)],
                  documentId: documentId(context.request),
                  ...(context.workingCandidatePath ? { candidatePath: context.workingCandidatePath } : {}),
                  entries: sparseEntries
                })
              : {
                  ok: true,
                  path: translationWorkingCandidatePath(context),
                  fromLine: range.fromLine,
                  toLine: range.toLine,
                  linesWritten: 0,
                  totalCandidateLines: existing.length,
                  sourceLineCount: sourceLines.length,
                  created: false
                }
            : await writeTranslationChunk({
	              outputDir: context.request.outputDir,
	              sourcePaths: [sourcePath(context.request)],
	              documentId: documentId(context.request),
	              ...(context.workingCandidatePath ? { candidatePath: context.workingCandidatePath } : {}),
	              ...range,
	              lines: persistedLines
	            });
	        if (result.ok) {
	          progress.translationValidated = false;
	          progress.translationAlignmentHash = undefined;
	          if (!context.workingCandidatePath && (selectedRepairLines.length === 0 || sparseEntries.length > 0)) {
	            await context.onArtifactMutation?.(
                context.task.documentId,
                selectedRepairLines.length > 0
                  ? { ...range, lines: sparseEntries.map((entry) => entry.line) }
                  : range
              );
	          }
	        }
        if (!result.ok) throw new Error(result.error || "Failed to write the assigned translation range.");
        source.forEach((sourceText, index) => {
          const line = range.fromLine + index;
          if (sourceText.trim() === "" || (translations.has(line) && !structurallyRejectedLines.has(line))) {
            progress.writtenLines!.add(line);
            if (translations.has(line)) progress.mutatedLines!.add(line);
          }
        });
        for (const line of structurallyRejectedLines) progress.writtenLines!.delete(line);
        progress.translationWritten = isCovered(progress.writtenLines!, context.task);
        progress.activeSourcePage = undefined;
        const validationRepairLines = new Set<number>();
        const submittedRejectedLines = new Set([...translations.keys()].filter((line) => (
          structurallyRejectedLines.has(line)
        )));
        const submittedRejectionFindings = proposedStructuralFindings.filter((finding) => {
          if (finding.line === undefined) return false;
          return submittedRejectedLines.has(range.fromLine + finding.line - 1);
        });
        const persistedRepairFindings = context.executionMode === "bounded_repair"
          ? [...persistedValidation.blocking, ...ynTranslationStructuralWarnings(persistedValidation)]
          : [...persistedValidation.blocking];
        const validationRepairFindings = [...new Map([
          ...submittedRejectionFindings,
          ...persistedRepairFindings.filter((finding) => {
            if (finding.line === undefined) return submittedRejectionFindings.length === 0;
            return !submittedRejectedLines.has(range.fromLine + finding.line - 1);
          })
        ].map((finding) => [
          `${finding.code}\0${finding.line ?? "range"}\0${finding.detail}`,
          finding
        ])).values()];
        for (const finding of validationRepairFindings) {
          if (finding.line !== undefined) validationRepairLines.add(range.fromLine + finding.line - 1);
        }
        const requiredLines = [...new Set([
          ...structurallyRejectedLines,
          ...validationRepairLines,
          ...requiredBatchLines.filter((line) => !translations.has(line) || structurallyRejectedLines.has(line))
        ])].sort((left, right) => left - right);
        const repairIssues: Array<{
          code: string;
          severity: "blocking" | "warning";
          detail: string;
          absoluteLine?: number;
        }> = validationRepairFindings.map((finding) => {
          const absoluteLine = finding.line === undefined
            ? undefined
            : range.fromLine + finding.line - 1;
          return {
            code: finding.code,
            severity: finding.severity,
            detail: finding.detail,
            ...(absoluteLine === undefined ? {} : { absoluteLine })
          };
        });
        const issueLines = new Set(repairIssues.flatMap((issue) =>
          issue.absoluteLine === undefined ? [] : [issue.absoluteLine]
        ));
        for (const line of requiredLines) {
          if (issueLines.has(line)) continue;
          repairIssues.push({
            code: "host_required",
            severity: "warning",
            detail: `L${line} still requires a fresh structurally valid translated value.`,
            absoluteLine: line
          });
        }
        progress.requiredBatchIssues = requiredLines.length > 0 ? repairIssues : undefined;
        const accepted = progress.translationWritten
          && requiredLines.length === 0
          && (context.executionMode === "bounded_repair"
            ? isYnTranslationChunkWritable(persistedValidation)
            : isYnTranslationArtifactAccepted(persistedValidation));
        const deferredSparseRepair = context.deferSparseRepair === true
          && requiredLines.length > 0
          && requiredLines.length <= MAX_SPARSE_TRANSLATION_ENTRY_LINES;
        // Only a focused reviewer repair may hand a mechanically accepted write
        // directly back to the read-only review pool. Full translation and
        // bounded repair still owe the mandatory native validation submission.
        progress.translationValidated = context.executionMode === "chunk_review_repair" && accepted;
        progress.requiredBatchLines = requiredLines.length > 0 ? new Set(requiredLines) : undefined;
        if (context.workingCandidatePath) {
          try {
            await context.onStagingCandidateCheckpoint?.({
              documentId: context.task.documentId || documentId(context.request),
              fromLine: context.task.fromLine,
              toLine: context.task.toLine,
              candidatePath: context.workingCandidatePath,
              terminologyRepairLines: context.task.terminologyRepair === true
                ? [...new Set((context.task.reviewFeedback ?? [])
                    .filter((feedback) => feedback.reason.startsWith("terminology:"))
                    .map((feedback) => feedback.line))]
                : [],
              accepted,
              requiredLines,
              repairIssues
            });
          } catch (error) {
            throw new NonRetryableAssignmentError(
              `Failed to persist the staging recovery checkpoint for ${context.task.documentId || documentId(context.request)} L${context.task.fromLine}-L${context.task.toLine}. Cause: ${compactErrorCause(error)}`,
              error
            );
          }
        }
        throwIfAborted(context.signal, signal);
        const requiredBatchLinesForResult = requiredLines.slice(0, MAX_STRUCTURED_TRANSLATION_REPAIR_LINES);
        const repairDetails = {
          ...(requiredLines.length > 0 ? { repairMode: "entries" } : {}),
          requiredLineCount: requiredLines.length,
          requiredBatchLines: requiredBatchLinesForResult,
          remainingRequiredLineCount: requiredLines.length - requiredBatchLinesForResult.length
        };
        return {
          ...textResult({
          result,
          invalidBlocks,
          invalidBlockLines: [...invalidBlockLines].sort((left, right) => left - right),
          missingLines: missing,
          ...repairDetails,
          repairIssues: repairIssues.slice(0, MAX_TRANSLATION_REPAIR_ISSUE_SAMPLES),
          omittedRepairIssueCount: Math.max(0, repairIssues.length - MAX_TRANSLATION_REPAIR_ISSUE_SAMPLES),
          accepted,
          validation: {
            ok: persistedValidation.ok,
            summary: persistedValidation.summary,
            blockingCount: persistedValidation.blocking.length,
            warningCount: persistedValidation.warnings.length
          }
          }),
          terminate: !accepted
            || (accepted && context.terminateOnAcceptedWrite === true)
            || (accepted && context.executionMode === "chunk_review_repair")
            || deferredSparseRepair
        };
      }
    },
    {
      name: "repairAssignedTranslation",
      label: "repairAssignedTranslation",
      hostControl: "return_after_tool_batch",
      description: "After reading the host-reported required lines yourself with readAssignedSource, submit structured { line, translation } repairs. Never echo source text unchanged; every other translated line is already retained.",
      parameters: repairSchema,
      executionMode: "sequential",
      execute(...args) {
        return executeAssignedTranslationWrite(...args);
      }
    },
    {
      name: "validateAssignedTranslation",
      label: "validateAssignedTranslation",
      hostControl: "return_after_tool_batch",
      description: "Validate the assigned range and submit evidence-backed discoveries exactly once after writing. A successful call is terminal for this artifact turn.",
      parameters: validateSchema,
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        const envelope = params as { fromLine?: number; toLine?: number };
        if ((envelope.fromLine === undefined) !== (envelope.toLine === undefined)) {
          throw new Error("validateAssignedTranslation requires both fromLine and toLine when either is provided.");
        }
        if (envelope.fromLine !== undefined && (
          envelope.fromLine !== context.task.fromLine
          || envelope.toLine !== context.task.toLine
        )) {
          throw new Error(
            `validateAssignedTranslation range must match the assigned L${context.task.fromLine}-L${context.task.toLine}.`
          );
        }
        if (!progress.translationWritten) {
          const missing = missingAssignedRange(progress.writtenLines!, context.task);
          throw new Error(
            `The assigned translation is incomplete; write the remaining range L${missing?.fromLine ?? context.task.fromLine}-L${missing?.toLine ?? context.task.toLine} before validation.`
          );
        }
        const result = await validateAssignedRange(context, signal);
        throwIfAborted(context.signal, signal);
        if (!result.accepted) {
          throw new Error(`Assigned range is not valid: ${result.validation.summary}`);
        }
        const semanticAlignment = validateAssignedSemanticAlignment(
          context,
          progress,
          result,
          (params as { misalignedLines?: number[] }).misalignedLines
        );
        const submittedDiscoveries = params as Partial<PiTranslationDiscoveries>;
        const [discoverySourceLines, discoveryCandidateLines] = await Promise.all([
          readFile(sourcePath(context.request), "utf8").then(splitTextLines),
          readFile(result.candidatePath, "utf8").then(splitTextLines)
        ]);
        const discoveryReport = normalizeTranslationDiscoveries(
          {
            glossaryCandidates: glossaryCandidatesEnabled ? submittedDiscoveries.glossaryCandidates ?? [] : [],
            characterFacts: characterFactsEnabled ? submittedDiscoveries.characterFacts ?? [] : []
          },
          context.task,
          discoverySourceLines,
          discoveryCandidateLines
        );
        progress.discoveries = discoveryReport.discoveries;
        progress.translationValidated = true;
        return {
          ...textResult({
          candidatePath: result.candidatePath,
          fromLine: context.task.fromLine,
          toLine: context.task.toLine,
          validation: compactYnTranslationValidation(
            result.validation,
            context.executionMode === "bounded_repair" ? "chunk" : "artifact"
          ),
          ...(semanticAlignment ? { semanticAlignment } : {}),
          discoveries: progress.discoveries,
          rejectedDiscoveries: discoveryReport.rejectedDiscoveries
          }),
          terminate: true
        };
      }
    }
  ];
}

function missingTranslationPreparation(
  progress: PiTranslationProgress,
  task: PiSubagentRangeTask
): string[] {
  const missing: string[] = [];
  if (!progress.referenceRead || !progress.sourceRead) {
    const range = missingAssignedRange(progress.readLines ?? new Set<number>(), task);
    missing.push(`readAssignedSource for L${range?.fromLine ?? task.fromLine}-L${range?.toLine ?? task.toLine}`);
  }
  const hostOwnsRepair = (progress.requiredBatchLines?.size ?? 0) > 0;
  if (!hostOwnsRepair && !progress.translationWritten) {
    const range = missingAssignedRange(progress.writtenLines ?? new Set<number>(), task);
    missing.push(`writeAssignedTranslation for L${range?.fromLine ?? task.fromLine}-L${range?.toLine ?? task.toLine}`);
  }
  return missing;
}

function assertFindingInAssignedRange(finding: PiProofreadFindingInput, task: PiProofreadSubagentTask): void {
  const explicitlyOwned = task.sampledLines ?? task.reviewLines;
  const owned = explicitlyOwned ? new Set(explicitlyOwned) : undefined;
  if (
    !Number.isInteger(finding.sourceLine)
    || finding.sourceLine < task.fromLine
    || finding.sourceLine > task.toLine
    || (owned !== undefined && !owned.has(finding.sourceLine))
  ) {
    throw new Error(
      `Finding ${finding.id || "(missing id)"} must reference one host-assigned aligned line.`
    );
  }
}

function proofreadSeverityCode(id: string): string {
  const code = id.match(/^([HML]\d)-/i)?.[1]?.toUpperCase();
  if (!code || !/^(?:H[1-9]|M[1-5]|L[1-4])$/.test(code)) {
    throw new Error(`Finding ${id || "(missing id)"} must start with a supported proofreading code.`);
  }
  return code;
}

function proofreadFindingIdentity(finding: { id: string; sourceLine: number }): string {
  const code = finding.id.match(/^([HML]\d)-/i)?.[1]?.toUpperCase() ?? "M1";
  return `${finding.sourceLine}:${code}`;
}

function inspectAssignedFinding(
  finding: PiProofreadFindingInput,
  task: PiProofreadSubagentTask,
  sourceLines: string[],
  translationLines: string[]
): { ok: true; prepared: Record<string, unknown> } | { ok: false; id: string; sourceLine: number; reason: string } {
  const sourceLine = Number(finding.sourceLine);
  const id = finding.id || "(missing id)";
  const explicitlyOwned = task.sampledLines ?? task.reviewLines;
  const owned = explicitlyOwned ? new Set(explicitlyOwned) : undefined;
  if (!Number.isInteger(sourceLine) || sourceLine < task.fromLine || sourceLine > task.toLine || (owned !== undefined && !owned.has(sourceLine))) {
    return { ok: false, id, sourceLine, reason: `Finding ${id} must reference one host-assigned aligned line.` };
  }
  let severity: string;
  try {
    severity = proofreadSeverityCode(finding.id);
  } catch (error) {
    return { ok: false, id, sourceLine, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!finding.suggestedFix?.trim() || !finding.rationale?.trim()) {
    return { ok: false, id, sourceLine, reason: `Finding ${id} needs a replacement line and rationale.` };
  }
  const sourceText = sourceLines[sourceLine - 1] ?? "";
  const currentTranslation = translationLines[sourceLine - 1] ?? "";
  const prepared = {
    ...finding,
    sourceLine,
    severity,
    translationLine: sourceLine,
    sourceText,
    currentTranslation,
  };
  if (!proofreadSuggestedFixChangesTranslation({ currentTranslation, suggestedFix: finding.suggestedFix })) {
    return {
      ok: false,
      id,
      sourceLine,
      reason: `Finding ${id} suggestedFix must change the currentTranslation; identical text is a no-op on aligned line ${sourceLine}.`
    };
  }
  if (!proofreadSuggestedFixPreservesControlPrefix({
    sourceText,
    currentTranslation,
    suggestedFix: finding.suggestedFix
  })) {
    return {
      ok: false,
      id,
      sourceLine,
      reason: `Finding ${id} suggestedFix must preserve the exact leading control prefix on aligned line ${sourceLine}.`
    };
  }
  return { ok: true, prepared };
}

export function createPiProofreadSubagentTools(
  context: PiProofreadSubagentContext,
  subagentId: string,
  progress: PiProofreadProgress,
  assignmentReferences?: ProofreadAssignmentReferenceContext
): AgentTool[] {
  const glossaryCandidatesEnabled = context.request.glossaryCandidates !== false;
  const emptySchema = Type.Object({});
  const inlineReferenceLimit = 8_000;
  const hasPagedReference = assignmentReferences === undefined
    || assignmentReferences.bundle.references.some((reference) => (
      reference.content.length > inlineReferenceLimit
      && assignmentReferences.cache.referenceSha256.get(reference.id) !== reference.sha256
    ));
  let referenceBundlePromise: Promise<ProofreadReferenceBundle> | undefined;
  const referenceBundle = () => {
    referenceBundlePromise ??= assignmentReferences
      ? Promise.resolve(assignmentReferences.bundle)
      : proofreadReferenceBundle(context.request);
    return referenceBundlePromise;
  };
  const referenceDocuments = () => {
    return referenceBundle().then((bundle) => bundle.references);
  };
  const findingSchema = Type.Object({
    id: Type.String({ pattern: "^(?:H[1-9]|M[1-5]|L[1-4])-.+$" }),
    type: Type.String(),
    sourceLine: Type.Integer({ minimum: 1 }),
    suggestedFix: Type.String(),
    rationale: Type.String(),
    needsVerification: Type.Optional(Type.Boolean())
  }, { additionalProperties: false });
  const glossaryCandidateSchema = Type.Object({
    source: Type.String({ minLength: 1 }),
    target: Type.String({ minLength: 1 }),
    category: Type.Union([
      Type.Literal("proper_noun"),
      Type.Literal("character"),
      Type.Literal("organization"),
      Type.Literal("place"),
      Type.Literal("title"),
      Type.Literal("setting_term")
    ]),
    evidenceLine: Type.Integer({ minimum: context.task.fromLine, maximum: context.task.toLine }),
    rationale: Type.String({ minLength: 1, maxLength: 1_000 }),
    aliases: Type.Optional(Type.Array(Type.String({
      minLength: 1,
      description: "An alternate target-language rendering only; never a source-language nickname or abbreviation."
    }), {
      maxItems: 16,
      description: "Optional accepted target-language alternatives only."
    }))
  }, { additionalProperties: false });
  return [
    ...createPiSubagentReadOnlyProjectTools(context, {
      indexedReferenceReads: "search-only",
      proofreadSearchCache: context.proofreadSearchCache,
      searchResultLimit: 8,
      boundProofreadContext: true
    }),
    {
      name: "readAssignedProofreadContext",
      label: "readAssignedProofreadContext",
      description: `Read the aligned source and translation for L${context.task.fromLine}-L${context.task.toLine}, boundary context, deterministic host signals, the complete built-in proofreading workflow, and approved project references.`,
      parameters: emptySchema,
      async execute(_toolCallId, _params, signal) {
        throwIfAborted(context.signal, signal);
        const [sourceContent, translationContent, bundle] = await Promise.all([
          readFile(sourcePath(context.request), "utf8"),
          readFile(proofreadTranslationPath(context.request), "utf8"),
          referenceBundle()
        ]);
        const references = bundle.references;
        throwIfAborted(context.signal, signal);
        const sourceLines = splitTextLines(sourceContent);
        const translationLines = splitTextLines(translationContent);
        if (sourceLines.length !== translationLines.length) {
          throw new Error(
            `Proofreading requires aligned files; source has ${sourceLines.length} lines and translation has ${translationLines.length}.`
          );
        }
        if (context.task.fromLine < 1 || context.task.toLine < context.task.fromLine || context.task.toLine > sourceLines.length) {
          throw new Error(
            `Invalid proofreading range ${context.task.fromLine}-${context.task.toLine}; aligned files have ${sourceLines.length} lines.`
          );
        }
        const row = (line: number) => ({
          line,
          source: sourceLines[line - 1] ?? "",
          translation: translationLines[line - 1] ?? ""
        });
        const boundarySize = 2;
        const firstContextRead = progress.nextAssignedLine === undefined;
        if (
          !context.task.sampledLines
          && !context.task.reviewLines
          && (progress.nextAssignedLine ?? context.task.fromLine) > context.task.toLine
        ) {
          throw new Error("The complete host-owned proofreading assignment has already been read.");
        }
        const ownedLines = context.task.sampledLines
          ? [...new Set(context.task.sampledLines)].sort((left, right) => left - right)
          : context.task.reviewLines
            ? (() => {
                const all = [...new Set(context.task.reviewLines)].sort((left, right) => left - right);
                const from = progress.nextAssignedIndex ?? 0;
                if (from >= all.length) {
                  throw new Error("The complete Host-selected HOT-region proofreading assignment has already been read.");
                }
                const to = Math.min(all.length, from + (context.task.checkpointSize ?? all.length));
                progress.nextAssignedIndex = to;
                return all.slice(from, to);
              })()
          : (() => {
              const checkpointFrom = progress.nextAssignedLine ?? context.task.fromLine;
              const checkpointTo = Math.min(
                context.task.toLine,
                checkpointFrom + (context.task.checkpointSize ?? context.task.toLine - context.task.fromLine + 1) - 1
              );
              return Array.from(
                { length: checkpointTo - checkpointFrom + 1 },
                (_, index) => checkpointFrom + index
              );
            })();
        if (ownedLines.some((line) => line < context.task.fromLine || line > context.task.toLine)) {
          throw new Error("A Host-selected proofreading line is outside the task bounds.");
        }
        const ownedSet = new Set(ownedLines);
        const contextBeforeLines = new Set<number>();
        const contextAfterLines = new Set<number>();
        for (const line of ownedLines) {
          for (let offset = boundarySize; offset >= 1; offset -= 1) {
            if (line - offset >= 1 && !ownedSet.has(line - offset)) contextBeforeLines.add(line - offset);
          }
          for (let offset = 1; offset <= boundarySize; offset += 1) {
            if (line + offset <= sourceLines.length && !ownedSet.has(line + offset)) contextAfterLines.add(line + offset);
          }
        }
        const contextBefore = [...contextBeforeLines].sort((left, right) => left - right).map(row);
        const contextAfter = [...contextAfterLines].sort((left, right) => left - right).map(row);
        const assignedLines = ownedLines.map(row);
        const assignedText = assignedLines
          .flatMap((entry) => [entry.source, entry.translation])
          .join("\n");
        const projectReferences = await translationProjectReferences(
          context.request,
          assignedLines.map((entry) => entry.source).join("\n")
        );
        const pendingProofreadGlossaryCandidates = glossaryCandidatesEnabled
          ? (context.pendingProofreadGlossaryCandidates ?? [])
            .filter((candidate) => referenceLookupTerms(
              candidate as unknown as Record<string, unknown>,
              ["source", "aliases"]
            ).flatMap(referenceMentionForms).some((term) => assignedText.includes(term)))
            .slice(0, 16)
            .map((candidate) => ({
              ...candidate,
              status: "pending_unresolved" as const,
              canonical: false as const
            }))
          : [];
        const checkpointFrom = ownedLines[0];
        const checkpointTo = ownedLines.at(-1)!;
        if (context.task.sampledLines) {
          progress.nextAssignedLine = context.task.toLine + 1;
          progress.referenceRead = true;
        } else if (context.task.reviewLines) {
          progress.nextAssignedLine = context.task.reviewLines[(progress.nextAssignedIndex ?? 1)]
            ?? context.task.toLine + 1;
          progress.referenceRead = (progress.nextAssignedIndex ?? 0) >= new Set(context.task.reviewLines).size;
        } else {
          progress.nextAssignedLine = checkpointTo + 1;
          progress.referenceRead = progress.nextAssignedLine > context.task.toLine;
        }
        const referencesToInject = references.filter((reference) => (
          assignmentReferences?.cache.referenceSha256.get(reference.id) !== reference.sha256
        ));
        if (!progress.referenceOffsets) {
          progress.referenceOffsets = new Map(referencesToInject.map((reference) => {
            const inlined = reference.content.length <= inlineReferenceLimit;
            if (inlined && assignmentReferences) {
              assignmentReferences.cache.referenceSha256.set(reference.id, reference.sha256);
            }
            return [reference.id, {
              offset: inlined ? reference.content.length : 0,
              length: reference.content.length,
              required: reference.required
            }];
          }));
        }
        const workflowChanged = assignmentReferences?.cache.workflowSha256 !== bundle.workflow.sha256;
        if (workflowChanged && assignmentReferences) {
          assignmentReferences.cache.workflowSha256 = bundle.workflow.sha256;
        }
        return textResult({
          assignmentFromLine: context.task.fromLine,
          assignmentToLine: context.task.toLine,
          fromLine: checkpointFrom,
          toLine: checkpointTo,
          totalLines: sourceLines.length,
          assignmentComplete: progress.referenceRead,
          nextFromLine: progress.referenceRead ? undefined : progress.nextAssignedLine,
          assignedLines,
          contextBefore,
          contextAfter,
          projectReferences,
          pendingProofreadGlossaryCandidates,
          priorExactSearches: priorProofreadExactSearches(
            context.proofreadSearchCache,
            assignedText
          ),
          deterministicSignals: (context.task.deterministicSignals ?? [])
            .filter((entry) => ownedSet.has(entry.line)),
          mode: context.task.mode ?? "split",
          round: context.task.round,
          ...(firstContextRead ? {
            referenceCache: {
              status: assignmentReferences?.status ?? "loaded",
              signature: bundle.signature,
              workflow: {
                sourcePath: bundle.workflow.sourcePath,
                sha256: bundle.workflow.sha256
              }
            },
            ...(workflowChanged ? {
              workflow: `## Built-in proofread-translation child workflow\n${bundle.workflow.content}`
            } : {}),
            references: referencesToInject.map(({ id, label, content, required, sourcePath, sha256 }) => ({
              id,
              label,
              length: content.length,
              required,
              sourcePath,
              sha256,
              ...(content.length <= inlineReferenceLimit ? { content, complete: true } : { complete: false })
            }))
          } : {})
        });
      }
    },
    ...(hasPagedReference ? [{
      name: "readProofreadReference",
      label: "readProofreadReference",
      description: "Read the next bounded chunk of a project proofreading reference whose manifest entry has complete=false. Entries returned with complete=true are already fully read and must not be requested again. Start at offset 0 and continue only from the returned nextOffset.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        offset: Type.Integer({ minimum: 0 }),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_000 }))
      }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        if (!progress.referenceOffsets) {
          throw new Error("Read the assigned proofreading context before reading project references.");
        }
        const input = params as { id: string; offset: number; maxChars?: number };
        const reference = (await referenceDocuments()).find((candidate) => candidate.id === input.id);
        if (!reference) throw new Error(`Unknown proofreading reference: ${input.id}.`);
        const state = progress.referenceOffsets.get(reference.id);
        if (!state) throw new Error(`Proofreading reference ${reference.id} was not declared for this assignment.`);
        if (input.offset !== state.offset) {
          throw new Error(`Read proofreading reference ${reference.id} from the required next offset ${state.offset}.`);
        }
        const end = Math.min(reference.content.length, input.offset + (input.maxChars ?? 16_000));
        state.offset = end;
        if (end >= reference.content.length && assignmentReferences) {
          assignmentReferences.cache.referenceSha256.set(reference.id, reference.sha256);
        }
        return textResult({
          id: reference.id,
          label: reference.label,
          offset: input.offset,
          nextOffset: end,
          complete: end >= reference.content.length,
          content: reference.content.slice(input.offset, end)
        });
      }
    } satisfies AgentTool] : []),
    {
      name: "writeAssignedFindings",
      label: "writeAssignedFindings",
      description: glossaryCandidatesEnabled
        ? "Write zero or more strictly bound findings for the assigned range through the YN findings host contract. Every suggestedFix must be a changed, complete replacement line and must preserve the exact leading bracket control prefix from the bound source/current row. When both bound rows have no prefix, do not invent or diagnose one. Valid findings are kept even if other items fail; only rejected items are returned for rewrite. Identical no-op fixes are rejected without discarding the rest of the batch."
        : "Write zero or more strictly bound findings for the assigned range through the YN findings host contract. Glossary-candidate collection is disabled, so do not submit terminology candidates. Every suggestedFix must be a changed, complete replacement line and must preserve the exact leading bracket control prefix from the bound source/current row. Valid findings are kept even if other items fail.",
      parameters: Type.Object({
        findings: Type.Array(findingSchema),
        ...(glossaryCandidatesEnabled ? {
          glossaryCandidates: Type.Optional(Type.Array(glossaryCandidateSchema, { maxItems: 64 }))
        } : {})
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        if (progress.findingsWritten) {
          throw new Error("This proofreading assignment has already written its findings artifact.");
        }
        if (!progress.referenceRead) {
          throw new Error("Read the assigned proofreading context before writing findings.");
        }
        const unreadReferences = [...(progress.referenceOffsets?.entries() ?? [])]
          .filter(([, state]) => state.required && state.offset < state.length)
          .map(([id, state]) => `${id}@${state.offset}/${state.length}`);
        if (unreadReferences.length > 0) {
          throw new Error(`Read every project reference completely before writing findings: ${unreadReferences.join(", ")}.`);
        }
        const input = params as {
          findings: PiProofreadFindingInput[];
          glossaryCandidates?: PiTranslationGlossaryDiscovery[];
        };
        const [sourceContent, translationContent] = await Promise.all([
          readFile(sourcePath(context.request), "utf8"),
          readFile(proofreadTranslationPath(context.request), "utf8")
        ]);
        const sourceLines = splitTextLines(sourceContent);
        const translationLines = splitTextLines(translationContent);
        if (sourceLines.length !== translationLines.length) {
          throw new Error(
            `Proofreading findings cannot be written because source has ${sourceLines.length} lines and translation has ${translationLines.length}.`
          );
        }
        if (glossaryCandidatesEnabled) {
          for (const candidate of input.glossaryCandidates ?? []) {
            assertFindingInAssignedRange({
              id: `glossary:${candidate.source}`,
              type: "glossary_candidate",
              sourceLine: candidate.evidenceLine,
              suggestedFix: candidate.target,
              rationale: candidate.rationale
            }, context.task);
          }
        }
        const discoveryReport = normalizeTranslationDiscoveries({
          glossaryCandidates: glossaryCandidatesEnabled ? input.glossaryCandidates ?? [] : [],
          characterFacts: []
        }, context.task, sourceLines, translationLines);
        progress.glossaryCandidates = glossaryCandidatesEnabled
          ? discoveryReport.discoveries.glossaryCandidates
          : [];
        const excludedLines = new Set(context.request.auditWhitelistLines ?? []);
        const acceptedByIdentity = new Map<string, Record<string, unknown>>();
        for (const finding of progress.acceptedFindings ?? []) {
          const sourceLine = Number(finding.sourceLine);
          const id = String(finding.id ?? "");
          if (!Number.isInteger(sourceLine) || !id) continue;
          acceptedByIdentity.set(proofreadFindingIdentity({ id, sourceLine }), finding);
        }
        const rejected: Array<{ id: string; sourceLine: number; reason: string }> = [];
        for (const finding of input.findings) {
          if (excludedLines.has(Number(finding.sourceLine))) continue;
          const inspected = inspectAssignedFinding(finding, context.task, sourceLines, translationLines);
          if (!inspected.ok) {
            rejected.push({ id: inspected.id, sourceLine: inspected.sourceLine, reason: inspected.reason });
            continue;
          }
          acceptedByIdentity.set(
            proofreadFindingIdentity({
              id: String(inspected.prepared.id),
              sourceLine: Number(inspected.prepared.sourceLine)
            }),
            { ...inspected.prepared, agentId: subagentId }
          );
        }
        const findings = [...acceptedByIdentity.values()];
        throwIfAborted(context.signal, signal);
        if (
          findings.length === 0
          && (progress.acceptedFindings?.length ?? 0) > 0
          && rejected.length === 0
        ) {
          throw new Error(
            `Refusing to replace ${progress.acceptedFindings?.length ?? 0} already-accepted finding(s) with an empty list. Rewrite only rejected items.`
          );
        }
        if (findings.length > 0 || rejected.length === 0) {
          const writeArgs: Parameters<typeof writeProofreadFindings>[0] = {
            outputDir: context.request.outputDir,
            sourcePaths: [sourcePath(context.request)],
            documentId: documentId(context.request),
            reportScope: proofreadReportScope(context.request),
            translationPath: proofreadTranslationPath(context.request),
            kind: "findings_json",
            content: JSON.stringify(findings),
            chunkLabel: context.task.label || `L${context.task.fromLine}-L${context.task.toLine}`,
            mode: context.task.mode ?? "split",
            ...((context.task.mode ?? "split") === "split" ? {
              replaceRange: {
                fromLine: context.task.fromLine,
                toLine: context.task.toLine
              }
            } : {}),
            excludedLines: context.request.auditWhitelistLines,
            mechanicalScan: {
              scopeLines: context.task.reviewLines
                ?? context.task.sampledLines
                ?? Array.from(
                  { length: context.task.toLine - context.task.fromLine + 1 },
                  (_entry, index) => context.task.fromLine + index
                ),
              signals: context.task.deterministicSignals ?? []
            }
          };
          const result = await writeProofreadFindings(writeArgs);
          if (result.ok) await context.onArtifactMutation?.(context.task.documentId);
          throwIfAborted(context.signal, signal);
          if (!result.ok) throw new Error(result.error || "Assigned proofreading findings write failed.");
          progress.acceptedFindings = findings;
          progress.findingsCount = findings.length;
          progress.reportPath = result.path;
          if (rejected.length === 0) {
            progress.findingsWritten = true;
            return {
              ...textResult({
                ...result,
                fromLine: context.task.fromLine,
                toLine: context.task.toLine,
                findingsWritten: findings.length,
                rejectedFindings: [],
                rejectedGlossaryCandidates: discoveryReport.rejectedDiscoveries,
                glossaryCandidates: progress.glossaryCandidates,
                ...(discoveryReport.rejectedDiscoveries.length > 0 ? {
                  nextAction: "Valid findings were kept. Do not resubmit an empty findings list. Rewrite only rejected glossary candidates if they still matter."
                } : {})
              }),
              terminate: discoveryReport.rejectedDiscoveries.length === 0
            };
          }
          return textResult({
            ...result,
            fromLine: context.task.fromLine,
            toLine: context.task.toLine,
            findingsWritten: findings.length,
            acceptedCount: findings.length,
            rejectedCount: rejected.length,
            rejectedFindings: rejected,
            nextAction: "Valid findings were kept. Rewrite only the rejected items and call writeAssignedFindings again.",
            rejectedGlossaryCandidates: discoveryReport.rejectedDiscoveries,
            glossaryCandidates: progress.glossaryCandidates
          });
        }
        return textResult({
          ok: false,
          fromLine: context.task.fromLine,
          toLine: context.task.toLine,
          findingsWritten: 0,
          acceptedCount: 0,
          rejectedCount: rejected.length,
          rejectedFindings: rejected,
          nextAction: "No findings were written. Fix the rejected items and call writeAssignedFindings again."
        });
      }
    }
  ];
}

function createPiGeneralSubagentTools(context: PiGeneralSubagentContext): AgentTool[] {
  const tools: AgentTool[] = createPiSubagentReadOnlyProjectTools(context);

  if (context.request.sourcePath?.trim()) {
    tools.push({
      name: "readBoundSourceLines",
      label: "Read bound source lines",
      description: "Read exact one-based lines from the source document delegated by the parent.",
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const input = params as { fromLine: number; toLine: number };
        const lines = splitTextLines(await readFile(sourcePath(context.request as PiBoundSourceRequest), "utf8"));
        if (input.fromLine < 1 || input.toLine > lines.length || input.toLine < input.fromLine) {
          throw new Error(`Requested source range L${input.fromLine}-L${input.toLine} is outside source L1-L${lines.length}.`);
        }
        return textResult({
          documentId: context.task.documentId,
          fromLine: input.fromLine,
          toLine: input.toLine,
          totalLines: lines.length,
          lines: lines.slice(input.fromLine - 1, input.toLine)
        });
      }
    });
    tools.push({
      name: "readBoundTranslationLines",
      label: "Read bound translation lines",
      description: "Read exact one-based lines from the current translation candidate delegated by the parent.",
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const input = params as { fromLine: number; toLine: number };
        const candidate = candidatePath(context.request);
        const lines = splitTextLines(await readFile(candidate, "utf8"));
        if (input.fromLine < 1 || input.toLine > lines.length || input.toLine < input.fromLine) {
          throw new Error(`Requested translation range L${input.fromLine}-L${input.toLine} is outside translation L1-L${lines.length}.`);
        }
        return textResult({
          documentId: context.task.documentId,
          path: candidate,
          fromLine: input.fromLine,
          toLine: input.toLine,
          totalLines: lines.length,
          lines: lines.slice(input.fromLine - 1, input.toLine)
        });
      }
    });
  }
  return tools;
}

function createPiTranslationReviewRuntimeSpec(
  context: PiTranslationReviewSubagentContext
): PiSubagentRuntimeSpec<{
  decision: PiTranslationChunkReviewDecision;
}> {
  let assignmentRead = false;
  let submitted: PiTranslationChunkReviewDecision | undefined;
  const tools = (): AgentTool[] => [
    ...createPiSubagentReadOnlyProjectTools(context, {
      indexedReferenceReads: "search-only",
      maxProjectFileReadChars: 8_000
    }),
    {
      name: "readAssignedTranslationReview",
      label: "Read assigned translation review",
      description: "Read every Host-selected mechanical-risk row and deterministic clean sample with short neighboring context. Selected rows are mandatory review targets; a context row may also be rejected when it clearly shares or continues the discovered defect.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, _params, signal) {
        throwIfAborted(context.signal, signal);
        const assignment = await context.readAssignment(context.task, signal);
        const selectedSourceText = assignment.windows
          .flatMap((window) => window.rows.map((row) => row.source))
          .join("\n");
        const projectReferences = await translationProjectReferences(context.request, selectedSourceText);
        assignmentRead = true;
        return textResult({ ...assignment, projectReferences });
      }
    },
    {
      name: "submitTranslationReview",
      label: "Submit translation review",
      description: "Accept the selected review scope with no failures, or reject concrete bad lines with an actionable repair note. A clearly bad context row may be included; Host promotes it to repair debt and centers the next review window on it. Never emit per-line pass verdicts.",
      parameters: Type.Object({
        failures: Type.Array(Type.Object({
          line: Type.Integer({ minimum: context.task.fromLine, maximum: context.task.toLine }),
          code: Type.String({ minLength: 1, maxLength: 80 }),
          note: Type.String({ minLength: 1, maxLength: 240 })
        }, { additionalProperties: false }))
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        throwIfAborted(context.signal, signal);
        if (!assignmentRead) throw new Error("Read the assigned translation review before submitting failures.");
        const input = params as { failures: PiTranslationReviewFailure[] };
        const maximumFailureCount = context.task.toLine - context.task.fromLine + 1;
        if (input.failures.length > maximumFailureCount) {
          throw new Error(
            `Translation review L${context.task.fromLine}-L${context.task.toLine} accepts at most `
            + `${maximumFailureCount} failure entries; received ${input.failures.length}.`
          );
        }
        submitted = await context.submitAssignment(context.task, input.failures, signal);
        return {
          ...textResult({
            auditId: context.task.auditId,
            accepted: submitted.accepted,
            failureCount: submitted.accepted ? 0 : submitted.feedback.length
          }),
          terminate: true
        };
      }
    }
  ];
  return {
    kind: "translation-review",
    label: context.task.label?.trim()
      || `Review ${context.task.documentId} L${context.task.fromLine}-L${context.task.toLine}`,
    taskPrompt: [
      `Review translation safety gate ${context.task.auditId} for ${context.task.documentId} L${context.task.fromLine}-L${context.task.toLine}.`,
      `The Host selected every mechanical-risk row plus ${context.task.sampledLineCount} deterministic clean sample row(s).`,
      "FIRST TOOL: call readAssignedTranslationReview once. Inspect every selected row. Neighboring rows are context, but include one as a failure when it clearly shares or continues the same defect; Host will promote that row and expand the next repair review around it.",
      "Focus on one-to-one line identity, omissions, merged/split/shifted meaning, placeholder/meta text, untranslated residue, and material mistranslation. This is not the later full proofreading workflow; do not polish style or report minor wording preferences. Target-language punctuation and typography choices alone, including adding a conventional Chinese sentence-final mark inside a closing quote, are never safety-gate failures.",
      "The first tool result includes canonical projectReferences paths and direct matches for its review windows. Use those direct matches first. Do not invent shorthand paths such as 'glossary'. Use searchProjectText/readProjectFile only for one specific unresolved ambiguity, copying the exact returned path, and do not recursively search the project or read generated review HTML.",
      "Then call submitTranslationReview exactly once with the single argument {failures:[...]}; never copy JSON Schema keywords such as maxItems into tool arguments. Use failures=[] when the selected scope is safe. For a real problem, include only its absolute line, a compact machine-readable code, and a short actionable note that names the defect and required correction. Never list aligned rows and never explain why correct rows pass.",
      "Do not modify any file and do not launch another subagent."
    ].join("\n"),
    tools,
    systemPrompt: [
      "You are a read-only native Pi translation safety reviewer inside YN Translation Workshop.",
      "Review every Host-selected risk row and deterministic sample. Context may propagate a concrete neighboring failure into the next repair window. Correct rows produce no output."
    ],
    async execute(runtime, session, taskPrompt, onRetry) {
      await promptSubagentTurn({
        runtime,
        session,
        prompt: taskPrompt,
        signal: context.signal,
        onRetry
      });
      let correctiveTurns = 0;
      while (!submitted && correctiveTurns < MAX_HOST_CONTRACT_NO_PROGRESS_TURNS) {
        correctiveTurns += 1;
        await promptSubagentTurn({
          runtime,
          session,
          prompt: "The review contract is incomplete. Read the assigned scope if needed, then submit only concrete failures now; use an empty failures array to accept it.",
          signal: context.signal,
          onRetry
        });
      }
      if (!submitted) {
        throw new Error(`Translation review worker did not submit ${context.task.auditId}.`);
      }
      const resultSummary = submitted.accepted
        ? `Accepted ${context.task.documentId} L${context.task.fromLine}-L${context.task.toLine}; no selected risk/sample failure.`
        : `Rejected ${context.task.documentId} L${context.task.fromLine}-L${context.task.toLine}: ${submitted.feedback.length} line(s).`;
      return {
        reply: resultSummary,
        resultSummary,
        extra: { decision: submitted }
      };
    }
  };
}

function createPiTranslationAuditRuntimeSpec(
  context: PiGeneralSubagentContext
): PiSubagentRuntimeSpec<{
  translationAudit: NonNullable<PiGeneralSubagentResult["translationAudit"]>;
}> {
  const auditId = context.task.auditId?.trim();
  const documentId = context.task.documentId?.trim();
  const fromLine = context.task.fromLine;
  const toLine = context.task.toLine;
  if (!auditId || !documentId || fromLine === undefined || toLine === undefined) {
    throw new Error("A translation reuse audit child requires auditId, documentId, fromLine, and toLine.");
  }
  const selectedLines = context.task.lines?.length
    ? [...new Set(context.task.lines)].sort((left, right) => left - right)
    : Array.from({ length: toLine - fromLine + 1 }, (_, index) => fromLine + index);
  if (
    selectedLines.length === 0
    || selectedLines.length > 80
    || selectedLines.some((line) => !Number.isInteger(line) || line < fromLine || line > toLine)
  ) {
    throw new Error("A translation reuse audit child requires between 1 and 80 valid selected lines inside its declared range.");
  }
  const selectedLineLabel = selectedLines.length === toLine - fromLine + 1
    ? `L${fromLine}-L${toLine}`
    : selectedLines.map((line) => `L${line}`).join(", ");
  let read = false;
  let submitted: TranslationReuseAuditEntryInput[] | undefined;
  const tools = (): AgentTool[] => [
    {
      name: "readAssignedTranslationAudit",
      label: "Read assigned translation audit",
      description: "Read the exact aligned source/current-translation pairs assigned for semantic reuse review.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const batch = await readTranslationReuseAuditSelection({
          outputDir: context.request.outputDir,
          ownerSessionId: context.request.sessionId,
          auditId,
          documentId,
          lines: selectedLines
        });
        const selectedSourceText = [
          ...batch.lines.map((line) => line.source),
          ...batch.context.map((line) => line.source)
        ].join("\n");
        const projectReferences = await translationProjectReferences(context.request, selectedSourceText);
        read = true;
        return textResult({ ...batch, projectReferences });
      }
    },
    {
      name: "submitTranslationAudit",
      label: "Submit translation audit",
      description: "Submit one semantic verdict for every assigned line that requires semantic review.",
      parameters: Type.Object({
        entries: Type.Array(Type.Object({
          line: Type.Integer({ minimum: fromLine, maximum: toLine }),
          verdict: Type.Union([
            Type.Literal("reuse"),
            Type.Literal("retranslate")
          ]),
          reason: Type.String({ minLength: 1, maxLength: 1_000 })
        }, { additionalProperties: false }), { minItems: 1, maxItems: 200 })
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        if (!read) throw new Error("Read the assigned translation audit before submitting verdicts.");
        const input = params as { entries: TranslationReuseAuditEntryInput[] };
        const actual = [...new Set(input.entries.map((entry) => entry.line))].sort((left, right) => left - right);
        if (actual.length !== selectedLines.length || actual.some((line, index) => line !== selectedLines[index])) {
          throw new Error(`Submit exactly one semantic verdict for every selected line: ${selectedLineLabel}.`);
        }
        await recordTranslationReuseAuditBatch({
          outputDir: context.request.outputDir,
          ownerSessionId: context.request.sessionId,
          auditId,
          documentId,
          entries: input.entries
        });
        submitted = input.entries;
        return {
          ...textResult({ accepted: true, auditId, documentId, selectedLineCount: selectedLines.length }),
          terminate: true
        };
      }
    }
  ];
  return {
    kind: "general",
    label: context.task.label?.trim() || `Reuse audit ${documentId} (${selectedLines.length} lines)`,
    taskPrompt: [
      `Semantically audit the current translation candidate for ${documentId}. The exact selected lines are ${selectedLineLabel}.`,
      "FIRST TOOL: call readAssignedTranslationAudit. Then call submitTranslationAudit exactly once with one verdict per assigned line.",
      "reuse means the existing target is a complete, faithful, contextually usable translation of its aligned source and is neither placeholder/meta prose nor an untranslated/partial copy.",
      "retranslate means placeholder, generic completion text, untranslated residue, omission, fabrication, wrong meaning, or otherwise unusable output. These are the only two final verdicts: do not defer a line to human review.",
      "Length ratio, severe compression, and a repeated target used for distinct sources are fast-sieve risk signals, not proof by themselves. Judge source and target meaning directly.",
      "A semantic risk signal may be a false positive. Resolve it from the aligned source, target, and supplied context; choose reuse when the translation is actually correct, otherwise choose retranslate. If evidence remains ambiguous, choose the safer final retranslate verdict rather than asking for manual confirmation.",
      "The first tool result includes canonical projectReferences and bounded direct matches for the selected source and context. Treat directMatches.approvedGlossary as authoritative target wording; a candidate that already uses that target is not untranslated merely because the approved form is English or another non-Chinese script.",
      "Do not rewrite any file and do not propose a new translation in this audit. The Host will derive the count summary from your structured submission; do not spend another model turn restating it."
    ].join("\n"),
    tools,
    systemPrompt: [
      "You are a read-only native Pi translation-reuse audit subagent inside YN Translation Workshop.",
      "Audit meaning, completeness, and whether the target is real translation rather than placeholder/meta text. Do not launch subagents or modify artifacts."
    ],
    async execute(runtime, session, taskPrompt, onRetry) {
      await promptSubagentTurn({
        runtime,
        session,
        prompt: taskPrompt,
        signal: context.signal,
        onRetry
      });
      let correctiveTurns = 0;
      while (!submitted && correctiveTurns < MAX_HOST_CONTRACT_NO_PROGRESS_TURNS) {
        correctiveTurns += 1;
        await promptSubagentTurn({
          runtime,
          session,
          prompt: `The semantic reuse audit is incomplete. Read the assigned audit if needed, then submit exactly one verdict for every selected line (${selectedLineLabel}) now; do not answer only with prose.`,
          signal: context.signal,
          onRetry
        });
      }
      if (!submitted) {
        throw new Error(`Translation reuse audit child did not submit ${selectedLineLabel}.`);
      }
      const reuseCount = submitted.filter((entry) => entry.verdict === "reuse").length;
      const retranslateCount = submitted.length - reuseCount;
      const resultSummary = `Submitted ${submitted.length} reuse verdict(s): ${reuseCount} reuse, ${retranslateCount} retranslate.`;
      return {
        reply: resultSummary,
        resultSummary,
        extra: {
          translationAudit: { auditId, documentId, entries: submitted }
        }
      };
    }
  };
}

function createPiGeneralRuntimeSpec(
  context: PiGeneralSubagentContext
): PiSubagentRuntimeSpec<Record<string, never>> {
  return {
    kind: "general",
    label: context.task.label?.trim() || "Subagent task",
    taskPrompt: context.task.prompt.trim(),
    tools: () => createPiGeneralSubagentTools(context),
    systemPrompt: [
      "You are a general-purpose native Pi subagent inside YN Translation Workshop.",
      "Perform only the concrete task delegated by the parent. Establish evidence with the available project tools instead of guessing.",
      "You are read-only. Do not launch another subagent.",
      "Return a concise but complete result with exact files and line numbers when relevant."
    ],
    async execute(runtime, session, taskPrompt, onRetry) {
      const response = await promptSubagentTurn({
        runtime,
        session,
        prompt: taskPrompt,
        signal: context.signal,
        onRetry
      });
      const final = await requireNativeFinalReply({
        runtime,
        session,
        response,
        signal: context.signal,
        completionPrompt: "Return your concrete findings or completed result to the parent now. Include exact evidence; do not answer only with Done.",
        onRetry
      });
      return {
        reply: final.reply,
        resultSummary: final.reply,
        extra: {}
      };
    }
  };
}

export async function runPiGeneralSubagent(
  context: PiGeneralSubagentContext
): Promise<PiGeneralSubagentResult> {
  if (!context.task.prompt.trim()) throw new Error("A general subagent task prompt is required.");
  if (context.task.mode === "translation_audit") {
    return runPiSubagentRuntime(context, createPiTranslationAuditRuntimeSpec(context));
  }
  return runPiSubagentRuntime(context, createPiGeneralRuntimeSpec(context));
}

export interface PiTranslationReviewSubagentResult extends PiSubagentResult {
  decision: PiTranslationChunkReviewDecision;
}

export interface PiTranslationReviewSubagentWorker {
  control: PiSubagentControl;
  runAssignment: (context: PiTranslationReviewSubagentContext) => Promise<PiTranslationReviewSubagentResult>;
  finish: (outcome: PiTranslationWorkerFinish) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function createPiTranslationReviewSubagentWorker(
  initialContext: PiTranslationReviewSubagentContext & { workerLabel?: string }
): Promise<PiTranslationReviewSubagentWorker> {
  throwIfAborted(initialContext.signal);
  const subagentId = initialContext.subagentId ?? `subagent_${randomUUID()}`;
  const label = initialContext.workerLabel?.trim() || initialContext.task.label?.trim() || "Translation review worker";
  const selection = await (initialContext.createModelSelection ?? createPiModelSelection)({
    workspaceDir: initialContext.request.outputDir,
    providerId: initialContext.workerProviderId?.trim() || initialContext.request.providerId,
    modelId: initialContext.workerModelId?.trim() || initialContext.request.modelId
  });
  const session = await new PiSessionRepository(initialContext.request.outputDir).createChild(
    subagentId,
    initialContext.request.sessionId
  );
  const initialSpec = createPiTranslationReviewRuntimeSpec(initialContext);
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: subagentId,
    models: selection.models,
    model: selection.model,
    thinkingLevel: resolveThinkingLevelForModel(selection.model, initialContext.request.thinkingLevel),
    tools: initialSpec.tools(subagentId),
    systemPrompt: await subagentSystemPrompt(initialContext, initialSpec),
    providerStreamTimeouts: initialContext.providerStreamTimeouts,
    retry: CHILD_RUNTIME_RETRY
  });
  const workerStartedAt = Date.now();
  let assignmentsStarted = 0;
  let lastContext = initialContext;
  let lastSpec = initialSpec;
  let lastLabel = label;
  let disposed = false;
  let runtimeAbort: Promise<unknown> | undefined;
  const abortRuntime = () => runtimeAbort ??= runtime.abort();
  const onAbort = () => { void abortRuntime().catch(() => undefined); };
  initialContext.signal?.addEventListener("abort", onAbort, { once: true });
  const control: PiSubagentControl = {
    inspect: async () => (await session.buildContext()).messages,
    steer: async (text) => runtime.queueSteer(text),
    followUp: async (text) => runtime.followUp(text),
    abort: async () => { await abortRuntime(); }
  };
  initialContext.registerControl?.(control);

  return {
    control,
    async runAssignment(context) {
      if (disposed) throw new Error(`Pi translation review worker ${subagentId} is disposed.`);
      throwIfAborted(initialContext.signal, context.signal);
      const spec = createPiTranslationReviewRuntimeSpec(context);
      const assignmentLabel = context.task.label?.trim() || label;
      lastContext = context;
      lastSpec = spec;
      lastLabel = assignmentLabel;
      if (assignmentsStarted > 0) runtime.resetContext();
      runtime.reconfigure({
        tools: spec.tools(subagentId),
        systemPrompt: await subagentSystemPrompt(context, spec)
      });
      assignmentsStarted += 1;
      await (context.publishLiveCustomMessage ?? context.publishCustomMessage)(subagentCard({
        kind: "translation-review",
        id: subagentId,
        label: assignmentLabel,
        status: "running",
        prompt: spec.taskPrompt,
        task: context.task,
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.model.name,
        startedAt: workerStartedAt,
        extraDetails: {
          activity: `reviewing assignment ${assignmentsStarted}`,
          reviewer: true,
          riskLineCount: context.task.riskLineCount,
          sampledLineCount: context.task.sampledLineCount
        }
      }));
      const outcome = await spec.execute(runtime, session, spec.taskPrompt);
      await (context.publishLiveCustomMessage ?? context.publishCustomMessage)(subagentCard({
        kind: "translation-review",
        id: subagentId,
        label: assignmentLabel,
        status: "running",
        prompt: spec.taskPrompt,
        reply: outcome.reply,
        resultSummary: outcome.resultSummary,
        task: context.task,
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.model.name,
        startedAt: workerStartedAt,
        extraDetails: {
          activity: outcome.extra.decision.accepted ? "review accepted" : "repair requested",
          reviewer: true,
          riskLineCount: context.task.riskLineCount,
          sampledLineCount: context.task.sampledLineCount
        }
      }));
      return {
        subagentId,
        label: assignmentLabel,
        documentId: context.task.documentId,
        fromLine: context.task.fromLine,
        toLine: context.task.toLine,
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.model.name,
        reply: outcome.reply,
        resultSummary: outcome.resultSummary,
        decision: outcome.extra.decision
      };
    },
    async finish(outcome) {
      await initialContext.publishCustomMessage(subagentCard({
        kind: "translation-review",
        id: subagentId,
        label: lastLabel,
        status: outcome.status,
        prompt: lastSpec.taskPrompt,
        resultSummary: `${outcome.completedAssignments}/${outcome.assignmentCount} review assignments settled.`,
        error: outcome.error,
        task: lastContext.task,
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.model.name,
        startedAt: workerStartedAt,
        finishedAt: Date.now(),
        extraDetails: {
          reviewer: true,
          assignmentCount: outcome.assignmentCount,
          completedAssignments: outcome.completedAssignments
        }
      }));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      initialContext.signal?.removeEventListener("abort", onAbort);
      if (runtimeAbort) await runtimeAbort;
      runtime.dispose();
    }
  };
}

export interface PiTranslationAuditSubagentWorker {
  control: PiSubagentControl;
  runAssignment: (context: PiGeneralSubagentContext) => Promise<PiGeneralSubagentResult>;
  finish: (outcome: PiTranslationWorkerFinish) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function createPiTranslationAuditSubagentWorker(
  initialContext: PiGeneralSubagentContext & { workerLabel?: string }
): Promise<PiTranslationAuditSubagentWorker> {
  throwIfAborted(initialContext.signal);
  const subagentId = initialContext.subagentId ?? `subagent_${randomUUID()}`;
  const label = initialContext.workerLabel?.trim() || initialContext.task.label?.trim() || "Reuse audit worker";
  const taskProviderId = initialContext.task.providerId?.trim();
  const selection = await (initialContext.createModelSelection ?? createPiModelSelection)({
    workspaceDir: initialContext.request.outputDir,
    providerId: taskProviderId || initialContext.request.subagentProviderId || initialContext.request.providerId,
    modelId: initialContext.task.modelId?.trim()
      || (taskProviderId ? undefined : initialContext.request.subagentModelId || initialContext.request.modelId)
  });
  const session = await new PiSessionRepository(initialContext.request.outputDir).createChild(
    subagentId,
    initialContext.request.sessionId
  );
  const initialSpec = createPiTranslationAuditRuntimeSpec(initialContext);
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: subagentId,
    models: selection.models,
    model: selection.model,
    thinkingLevel: resolveThinkingLevelForModel(selection.model, initialContext.request.thinkingLevel),
    tools: initialSpec.tools(subagentId),
    systemPrompt: await subagentSystemPrompt(initialContext, initialSpec),
    providerStreamTimeouts: initialContext.providerStreamTimeouts,
    retry: CHILD_RUNTIME_RETRY
  });
  let assignmentsStarted = 0;
  let disposed = false;
  let activeSignal: AbortSignal | undefined;
  let runtimeAbort: Promise<unknown> | undefined;
  const abortRuntime = () => runtimeAbort ??= runtime.abort();
  const onAbort = () => { void abortRuntime().catch(() => undefined); };
  initialContext.signal?.addEventListener("abort", onAbort, { once: true });
  const control: PiSubagentControl = {
    inspect: async () => (await session.buildContext()).messages,
    steer: async (text) => runtime.queueSteer(text),
    followUp: async (text) => runtime.followUp(text),
    abort: async () => { await abortRuntime(); }
  };
  initialContext.registerControl?.(control);

  return {
    control,
    async runAssignment(context) {
      if (disposed) throw new Error(`Pi translation audit worker ${subagentId} is disposed.`);
      throwIfAborted(initialContext.signal, context.signal);
      activeSignal = context.signal;
      const spec = createPiTranslationAuditRuntimeSpec(context);
      if (assignmentsStarted > 0) runtime.resetContext();
      runtime.reconfigure({
        tools: spec.tools(subagentId),
        systemPrompt: await subagentSystemPrompt(context, spec)
      });
      assignmentsStarted += 1;
      const startedAt = Date.now();
      await (context.publishLiveCustomMessage ?? context.publishCustomMessage)(subagentCard({
        kind: "general", id: subagentId, label, status: "running", prompt: spec.taskPrompt,
        task: context.task, providerId: selection.providerId, modelId: selection.modelId,
        modelName: selection.model.name, startedAt,
        extraDetails: { activity: `auditing assignment ${assignmentsStarted}` }
      }));
      const outcome = await spec.execute(runtime, session, spec.taskPrompt);
      activeSignal = undefined;
      return {
        subagentId,
        label,
        documentId: context.task.documentId,
        fromLine: context.task.fromLine,
        toLine: context.task.toLine,
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.model.name,
        reply: outcome.reply,
        resultSummary: outcome.resultSummary,
        ...outcome.extra
      };
    },
    async finish(outcome) {
      await initialContext.publishCustomMessage(subagentCard({
        kind: "general", id: subagentId, label, status: outcome.status,
        prompt: initialSpec.taskPrompt,
        resultSummary: `${outcome.completedAssignments}/${outcome.assignmentCount} audit assignments settled.`,
        error: outcome.error, task: initialContext.task, providerId: selection.providerId,
        modelId: selection.modelId, modelName: selection.model.name, startedAt: Date.now(), finishedAt: Date.now(),
        extraDetails: { assignmentCount: outcome.assignmentCount, completedAssignments: outcome.completedAssignments }
      }));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      initialContext.signal?.removeEventListener("abort", onAbort);
      if (runtimeAbort) await runtimeAbort;
      runtime.dispose();
      void activeSignal;
    }
  };
}

function subagentCard(args: {
  kind: "general" | "translation" | "translation-review" | "proofread";
  id: string;
  label: string;
  status: "running" | "completed" | "failed" | "stopped";
  prompt: string;
  reply?: string;
  resultSummary?: string;
  task: PiSubagentTaskBase & { fromLine?: number; toLine?: number };
  providerId: string;
  modelId: string;
  modelName: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  extraDetails?: Record<string, unknown>;
}): AgentMessage {
  return {
    role: "custom",
    customType: `subagent.${args.kind}`,
    content: args.resultSummary || args.error || args.label,
    display: true,
    details: {
      subagentId: args.id,
      label: args.label,
      status: args.status,
      closed: args.status !== "running",
      completed: args.status === "completed",
      collapsed: true,
      resultSummary: args.resultSummary || "",
      error: args.error,
      providerId: args.providerId,
      modelId: args.modelId,
      modelName: args.modelName,
      ...(args.task.documentId ? { documentId: args.task.documentId } : {}),
      startedAt: args.startedAt,
      ...(args.finishedAt ? {
        finishedAt: args.finishedAt,
        durationMs: Math.max(0, args.finishedAt - args.startedAt)
      } : {}),
      ...(args.task.fromLine === undefined || args.task.toLine === undefined ? {} : {
        fromLine: args.task.fromLine,
        toLine: args.task.toLine,
        range: { fromLine: args.task.fromLine, toLine: args.task.toLine }
      }),
      ...args.extraDetails
    },
    timestamp: Date.now()
  };
}

interface PiSubagentRuntimeSpec<TExtra extends object> {
  kind: "general" | "translation" | "translation-review" | "proofread";
  label: string;
  taskPrompt: string;
  tools: (subagentId: string) => AgentTool[];
  systemPrompt: string[];
  execute: (
    runtime: PiSessionAgentRuntime,
    session: Session,
    taskPrompt: string,
    onRetry?: (attempt: number, error: string) => Promise<void> | void
  ) => Promise<{ reply?: string; resultSummary: string; extra: TExtra }>;
  cardDetails?: (extra: TExtra) => Record<string, unknown>;
}

async function subagentSystemPrompt<TTask extends PiSubagentTaskBase & { fromLine?: number; toLine?: number }, TExtra extends object>(
  context: PiSubagentContext<TTask>,
  spec: PiSubagentRuntimeSpec<TExtra>
): Promise<string> {
  const targetDocumentId = context.task.documentId?.trim()
    || (context.request.sourcePath?.trim() ? documentId(context.request) : undefined);
  const generalProjectStyle = spec.kind === "general"
    ? (await readProjectAssets({ outputDir: context.request.outputDir })).styleGuide.trim()
    : "";
  return [
    ...spec.systemPrompt,
    targetDocumentId && context.task.fromLine !== undefined && context.task.toLine !== undefined
      ? `Your delegated task target is ${targetDocumentId} L${context.task.fromLine}-L${context.task.toLine}. You may read any relevant project file, source context, or user-provided external reference; write-capable tools remain host-limited to this target.`
      : targetDocumentId
        ? `Your delegated task target is ${targetDocumentId}. You may read any relevant project file, source context, or user-provided external reference; write-capable tools remain host-limited to this target.`
        : "You may read any relevant file in the current YN project. Stay focused on the task explicitly delegated by the parent.",
    spec.kind === "general"
      ? "Report concrete evidence and results to the parent. Do not launch another subagent."
      : "The artifact, not chat prose, is the output contract. Complete all mandatory tool calls before answering.",
    generalProjectStyle ? `## Approved style guide\n${generalProjectStyle.slice(0, 24_000)}` : ""
  ].filter(Boolean).join("\n\n");
}

async function runPiSubagentRuntime<
  TTask extends PiSubagentTaskBase & { fromLine?: number; toLine?: number },
  TExtra extends object
>(
  context: PiSubagentContext<TTask>,
  spec: PiSubagentRuntimeSpec<TExtra>
): Promise<PiSubagentResult & TExtra> {
  throwIfAborted(context.signal);
  const subagentId = context.subagentId ?? `subagent_${randomUUID()}`;
  const label = context.task.label?.trim() || spec.label;
  const taskProviderId = context.task.providerId?.trim();
  const taskModelId = context.task.modelId?.trim();
  const selection = await (context.createModelSelection ?? createPiModelSelection)({
    workspaceDir: context.request.outputDir,
    providerId: taskProviderId || context.request.subagentProviderId || context.request.providerId,
    modelId: taskModelId || (taskProviderId ? undefined : context.request.subagentModelId || context.request.modelId)
  });
  throwIfAborted(context.signal);
  const session = await new PiSessionRepository(context.request.outputDir).createChild(
    subagentId,
    context.request.sessionId
  );
  throwIfAborted(context.signal);
  const taskPrompt = spec.taskPrompt;
  const startedAt = Date.now();
  const tools = spec.tools(subagentId);
  const translationTools = spec.kind === "translation"
    ? requireTranslationToolCapabilities(tools)
    : undefined;
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: subagentId,
    models: selection.models,
    model: selection.model,
    thinkingLevel: resolveThinkingLevelForModel(selection.model, context.request.thinkingLevel),
    tools,
    systemPrompt: await subagentSystemPrompt(context, spec),
    providerStreamTimeouts: context.providerStreamTimeouts,
    retry: CHILD_RUNTIME_RETRY,
    afterToolCall: translationTools
      ? createTranslationWriteBatchHandoff(translationTools)
      : undefined
  });
  let runtimeAbort: Promise<unknown> | undefined;
  let abortFailureHandled = false;
  const abortRuntime = () => {
    runtimeAbort ??= runtime.abort();
    return runtimeAbort;
  };
  context.registerControl?.({
    inspect: async () => (await session.buildContext()).messages,
    steer: async (text) => {
      throwIfAborted(context.signal);
      return runtime.queueSteer(text);
    },
    followUp: async (text) => {
      throwIfAborted(context.signal);
      await runtime.followUp(text);
    },
    abort: async () => {
      await abortRuntime();
    }
  });
  const onAbort = () => {
    const pending = abortRuntime();
    // The original promise is awaited below; this prevents a transient unhandled rejection.
    void pending.catch(() => undefined);
  };
  context.signal?.addEventListener("abort", onAbort, { once: true });
  if (context.signal?.aborted) onAbort();

  try {
    await context.publishCustomMessage(subagentCard({
      kind: spec.kind,
      id: subagentId,
      label,
      status: "running",
      prompt: taskPrompt,
      task: context.task,
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelName: selection.model.name,
      startedAt
    }));
    throwIfAborted(context.signal);
    const outcome = await spec.execute(runtime, session, taskPrompt, async (attempt, error) => {
      await (context.publishLiveCustomMessage ?? context.publishCustomMessage)(subagentCard({
        kind: spec.kind,
        id: subagentId,
        label,
        status: "running",
        prompt: taskPrompt,
        error,
        task: context.task,
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.model.name,
        startedAt,
        extraDetails: {
          activity: `retry ${attempt}/${CHILD_RUNTIME_RETRY.maxRetries}`,
          retryAttempt: attempt,
          retryError: error
        }
      }));
    });
    throwIfAborted(context.signal);
    await context.publishCustomMessage(subagentCard({
      kind: spec.kind,
      id: subagentId,
      label,
      status: "completed",
      prompt: taskPrompt,
      reply: outcome.reply,
      resultSummary: outcome.resultSummary,
      task: context.task,
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelName: selection.model.name,
      startedAt,
      finishedAt: Date.now(),
      extraDetails: spec.cardDetails?.(outcome.extra)
    }));
    return {
      subagentId,
      label,
      ...(context.task.documentId || context.request.sourcePath
        ? { documentId: context.task.documentId || documentId(context.request) }
        : {}),
      ...(context.task.fromLine === undefined ? {} : { fromLine: context.task.fromLine }),
      ...(context.task.toLine === undefined ? {} : { toLine: context.task.toLine }),
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelName: selection.model.name,
      reply: outcome.reply,
      resultSummary: outcome.resultSummary,
      ...outcome.extra
    };
  } catch (error) {
    let failure = error;
    if (context.signal?.aborted) {
      try {
        await abortRuntime();
      } catch (abortError) {
        abortFailureHandled = true;
        failure = new AggregateError([error, abortError], `${spec.kind} subagent abort failed.`);
      }
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    await context.publishCustomMessage(subagentCard({
      kind: spec.kind,
      id: subagentId,
      label,
      status: context.signal?.aborted ? "stopped" : "failed",
      prompt: taskPrompt,
      error: message,
      task: context.task,
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelName: selection.model.name,
      startedAt,
      finishedAt: Date.now()
    }));
    throw failure;
  } finally {
    context.signal?.removeEventListener("abort", onAbort);
    let unhandledAbortFailure: unknown;
    if (runtimeAbort) {
      try {
        await runtimeAbort;
      } catch (error) {
        if (!abortFailureHandled) unhandledAbortFailure = error;
      }
    }
    runtime.dispose();
    if (unhandledAbortFailure !== undefined) throw unhandledAbortFailure;
  }
}

export function createPiTranslationRuntimeSpec(
  context: PiTranslationSubagentContext,
  progress: PiTranslationProgress
): PiSubagentRuntimeSpec<{
  validation: ReturnType<typeof validateTranslationCandidate>;
  discoveries: PiTranslationDiscoveries;
}> {
  const assignmentLength = context.task.toLine - context.task.fromLine + 1;
  const boundedSelectedLines = context.executionMode === "bounded_repair"
    ? selectedTranslationRepairLines(context.task)
    : [];
  const glossaryCandidatesEnabled = context.request.glossaryCandidates !== false;
  const characterFactsEnabled = context.request.characterBible !== false;
  const discoveryInstruction = glossaryCandidatesEnabled || characterFactsEnabled
    ? `Call validateAssignedTranslation when requested and include evidence-backed ${[
        glossaryCandidatesEnabled ? "glossary candidates" : "",
        characterFactsEnabled ? "character facts" : ""
      ].filter(Boolean).join(" and ")}, or omit those optional fields when there are none.`
    : "Call validateAssignedTranslation when requested. Glossary-candidate and character-fact collection are disabled; do not report either field.";
  const sourceInstruction = assignmentLength > MAX_TRANSLATION_MODEL_PAGE_LINES
    ? [
      `Process the logical assignment in ordered model pages of at most ${MAX_TRANSLATION_MODEL_PAGE_LINES} lines.`,
      "For each page, call readAssignedSource and writeAssignedTranslation before requesting the next page. Omitted ranges automatically advance to the next unread page; paging never changes assignment ownership or its final review boundary."
    ]
    : ["Call readAssignedSource once for the exact assigned range before writeAssignedTranslation."];
  const boundedRepairPrompt = [
    context.task.instruction?.trim()
      ? `Parent-delegated bounded repair: ${context.task.instruction.trim()}`
      : "Apply the parent-delegated bounded repair.",
    `Target document: ${documentId(context.request)}.`,
    `Source file (read-only, UTF-8): ${sourcePath(context.request)}`,
    `Current translation candidate (UTF-8): ${translationWorkingCandidatePath(context)}`,
    ...(boundedSelectedLines.length > 0
      ? [
          `Read-only envelope: L${context.task.fromLine}-L${context.task.toLine}. Exact writable lines: ${boundedSelectedLines.map((line) => `L${line}`).join(", ")}. Language pair: ${context.request.languagePair}.`,
          "The Host rejects every write outside that exact sparse set; the envelope grants no additional write ownership."
        ]
      : [`Assigned lines: L${context.task.fromLine}-L${context.task.toLine} (1-based, inclusive). Language pair: ${context.request.languagePair}.`]),
    ...(context.request.style?.trim() ? [`Project style: ${context.request.style.trim()}`] : []),
    ...(context.request.workDescription?.trim() ? [`Work description: ${context.request.workDescription.trim()}`] : []),
    ...(customPreserveRuleContext(context.request) ? [customPreserveRuleContext(context.request)] : []),
    boundedSelectedLines.length > 0
      ? "FIRST TOOL: call readAssignedSource with no arguments. It returns only the exact writable rows. Use readTranslationContext separately for bounded read-only context; context never expands write ownership."
      : "FIRST TOOL: call readAssignedSource for the exact target. It returns aligned text, canonical projectReferences paths, and directMatches for indexed assets. Use directMatches first; whole-file glossary, character-bible, and glossary-candidate reads are disabled. Search one exact source term only when the repair has a real uncovered ambiguity. available:false means the asset does not exist and must not be probed. Use readTranslationContext for bounded surrounding context when needed.",
    "Stay inside this repair. Do not probe unavailable assets, rebuild shared assets, or launch a complete workflow. Never write to the source file.",
    boundedSelectedLines.length > 0 || assignmentLength <= MAX_SPARSE_TRANSLATION_ENTRY_LINES
      ? "Write the requested correction with repairAssignedTranslation using structured { line, translation } entries."
      : "Write the requested correction with writeAssignedTranslation blocks matching the returned sourceBlocks.",
    boundedSelectedLines.length > 0
      ? "After writing, semantically compare only the exact writable source/candidate rows, then call validateAssignedTranslation with misalignedLines containing only exact writable lines that still fail; use [] when none fail. Do not emit pass reasons."
      : "After writing, semantically compare every assigned source/candidate row, then call validateAssignedTranslation with misalignedLines containing only absolute lines that still fail; use [] when none fail. Do not emit pass reasons.",
    "A successful validateAssignedTranslation call returns directly to the Host. Do not spend another model turn on a prose confirmation."
  ].join("\n");
  const chunkReviewFeedback = context.task.reviewFeedback ?? [];
  const chunkReviewRepairPrompt = [
    "The parent rejected the current translated chunk after Host mechanical scanning and focused semantic review.",
    `Target document: ${documentId(context.request)}.`,
    `Source file (read-only, UTF-8): ${sourcePath(context.request)}`,
    `Current translation candidate (UTF-8): ${translationWorkingCandidatePath(context)}`,
    `Owned chunk: L${context.task.fromLine}-L${context.task.toLine} (1-based, inclusive). Language pair: ${context.request.languagePair}.`,
    ...(customPreserveRuleContext(context.request) ? [customPreserveRuleContext(context.request)] : []),
    "Repair only the exact rejected rows below in this same child session. Do not restart the workflow, do not rewrite already accepted rows, and do not change the source file.",
    ...chunkReviewFeedback.map((feedback) => `- L${feedback.line}: ${feedback.reason}`),
    "FIRST TOOL: call readAssignedSource only for compact spans covering the rejected rows; do not read the entire owned chunk. Use returned directMatches first; whole-file indexed-asset reads are disabled. Search one exact term or read bounded context only when the rejection requires it.",
    "Use repairAssignedTranslation for the rejected rows. A successful repair returns directly to the Host for focused re-review; do not spend another turn on validation or a prose confirmation."
  ].join("\n");
  return {
    kind: "translation",
    label: context.task.label?.trim() || (context.task.documentId
      ? `Subagent ${context.task.documentId}`
      : `Subagent L${context.task.fromLine}-L${context.task.toLine}`),
    taskPrompt: context.executionMode === "bounded_repair"
      ? boundedRepairPrompt
      : context.executionMode === "chunk_review_repair"
        ? chunkReviewRepairPrompt
        : [
      context.task.instruction?.trim()
        ? `Parent-delegated objective: ${context.task.instruction.trim()}`
        : "",
      `Translate ${assignmentDescription(context.task)}, exact assigned range L${context.task.fromLine}-L${context.task.toLine}, according to language pair ${context.request.languagePair}.`,
      ...(context.request.style?.trim() ? [`Project style: ${context.request.style.trim()}`] : []),
      ...(context.request.workDescription?.trim() ? [`Work description: ${context.request.workDescription.trim()}`] : []),
      ...(customPreserveRuleContext(context.request) ? [customPreserveRuleContext(context.request)] : []),
      ...sourceInstruction,
      "Read the complete translationReference from the first result. Use projectReferences.directMatches when present. Do not bulk-read the indexed glossary, character bible, or glossary candidates; exact-search one source term only for a real uncovered ambiguity. For the bound source document, use only readAssignedSource and readTranslationContext so context stays line-aware and centered on the assignment. Other project files and prior translations remain readable on demand.",
      ...(glossaryCandidatesEnabled ? [] : [
        "New glossary-candidate collection is disabled. Existing candidate entries in projectReferences remain read-only consistency references, but do not construct or report new candidate discoveries. The selected formal glossary, when present, remains authoritative."
      ]),
      "Write every returned sourceBlocks item with writeAssignedTranslation in the exact block format described by that tool result. Repair only Host-reported lines with repairAssignedTranslation.",
      discoveryInstruction,
      ...(glossaryCandidatesEnabled || characterFactsEnabled ? [
        "Report only proper names, named organizations/places/titles, coined setting terms, and character facts. Do not propose ordinary dictionary words or everyday phrases. glossaryCandidates.aliases means alternate target-language renderings only; report a source-language nickname or abbreviation as its own source candidate. Mark unresolved gender/pronouns as unknown with source-line evidence so the parent can research them; never guess."
      ] : []),
      "Every non-empty output line must be the actual translation of its matching source line. Never write progress narration, labels such as 'translation below', summaries, or generic placeholder prose such as （本段译文）, 本行译文, 译文待补, or 'translation goes here' into the translation artifact.",
      "Do not modify the source file or return the translation only in chat. A successful validateAssignedTranslation call returns directly to the Host; do not spend another model turn on a prose confirmation."
        ].join("\n"),
    tools: () => createPiTranslationSubagentTools(context, progress),
    systemPrompt: ["You are a Pi translation subagent for YN Translation Workshop."],
    async execute(runtime, session, taskPrompt, onRetry) {
      const existingArtifact = await validateExistingAssignedRange(context);
      const chunkReviewRepair = context.executionMode === "chunk_review_repair";
      if (boundedSelectedLines.length > 0) {
        if (!existingArtifact || !isStructurallyCompleteAssignedTranslation(existingArtifact)) {
          throw new Error(
            `Sparse bounded repair requires a structurally complete retained candidate inside L${context.task.fromLine}-L${context.task.toLine}.`
          );
        }
        progress.requiredBatchLines = new Set(boundedSelectedLines);
        markCovered(progress.writtenLines ??= new Set<number>(), context.task);
        progress.translationWritten = true;
      }
      if (chunkReviewRepair) {
        if (!existingArtifact || !isStructurallyCompleteAssignedTranslation(existingArtifact)) {
          throw new Error(
            `Review-worker repair requires a structurally complete retained chunk L${context.task.fromLine}-L${context.task.toLine}.`
          );
        }
        const rejectedLines = [...new Set((context.task.reviewFeedback ?? []).map((feedback) => feedback.line))]
          .sort((left, right) => left - right);
        if (rejectedLines.length === 0) {
          throw new Error("Review-worker repair requires at least one exact rejected line.");
        }
        progress.requiredBatchLines = new Set(rejectedLines);
        markCovered(progress.writtenLines ??= new Set<number>(), context.task);
        progress.translationWritten = true;
      }
	      const resumeRepair = existingArtifact !== undefined
	        && hasExistingAssignedTranslation(existingArtifact)
	        && !isYnTranslationChunkWritable(existingArtifact.validation)
	        && isLineAlignedAssignedTranslation(existingArtifact);
      if (resumeRepair) {
        markCovered(progress.writtenLines ??= new Set<number>(), context.task);
        progress.translationWritten = true;
        progress.translationValidated = false;
      }
      const resumeRepairPlan = resumeRepair && existingArtifact
        ? buildAssignedTranslationRepairPlan({
          fromLine: context.task.fromLine,
          sourceSlice: existingArtifact.sourceSlice,
          validation: existingArtifact.validation,
          languagePair: context.request.languagePair,
          executionMode: "bounded_repair",
          glossaryCandidates: glossaryCandidatesEnabled
        })
        : undefined;
      if (resumeRepairPlan) {
        progress.requiredBatchLines = new Set(resumeRepairPlan.repairLines);
      }
      const delegatedObjective = context.task.instruction?.trim();
      const initialPrompt = resumeRepairPlan
        ? [
          delegatedObjective ? `Parent-delegated objective: ${delegatedObjective}` : "",
          resumeRepairPlan.prompt
        ].filter(Boolean).join("\n\n")
        : taskPrompt;
      await promptSubagentTurn({
        runtime,
        session,
        prompt: initialPrompt,
        signal: context.signal,
        onRetry
      });
      const deferredSparseLines = [...(progress.requiredBatchLines ?? [])]
        .sort((left, right) => left - right);
      if (
        context.deferSparseRepair === true
        && deferredSparseLines.length > 0
        && deferredSparseLines.length <= MAX_SPARSE_TRANSLATION_ENTRY_LINES
      ) {
        const deferredArtifact = await validateAssignedRange(context);
        if (!isStructurallyCompleteAssignedTranslation(deferredArtifact)) {
          throw new Error(
            `Sparse repair cannot be deferred because L${context.task.fromLine}-L${context.task.toLine} is structurally incomplete: ${deferredArtifact.validation.summary}`
          );
        }
        return {
          reply: "",
          resultSummary: `Retained valid translations for L${context.task.fromLine}-L${context.task.toLine}; ${deferredSparseLines.length} sparse lines are deferred to the file-final repair turn.`,
          extra: {
            validation: deferredArtifact.validation,
            discoveries: progress.discoveries ?? EMPTY_TRANSLATION_DISCOVERIES
          }
        };
      }
      let artifact: Awaited<ReturnType<typeof validateAssignedRange>> | undefined;
      if (resumeRepair || chunkReviewRepair || (progress.requiredBatchLines?.size ?? 0) > 0) {
        const pendingRepairArtifact = await validateAssignedRange(context);
        if (isStructurallyCompleteAssignedTranslation(pendingRepairArtifact)) {
          artifact = pendingRepairArtifact;
        }
      }
      if (!artifact) {
        let missingPreparation = missingTranslationPreparation(progress, context.task);
        let preparationDebt = translationPreparationDebt(progress, context.task);
        let noProgressTurns = 0;
        while (missingPreparation.length > 0) {
          const latestToolError = await latestFailedToolFeedback(session);
          await promptSubagentTurn({
            runtime,
            session,
            prompt: [
              "The assigned translation artifact contract is incomplete.",
              `Complete only these missing native tools now, in order: ${missingPreparation.join(", ")}.`,
              ...(latestToolError ? [`Latest host tool rejection: ${latestToolError}`] : []),
              "This bounded repair child is still write-capable. Correct the rejected tool arguments or output and write the same managed candidate range; do not switch to a full workflow or merely describe the failure.",
              "Do not reuse or claim a pre-existing assignment; this child must read and write its own assigned source."
            ].join("\n"),
            signal: context.signal,
            onRetry
          });
          const remaining = missingTranslationPreparation(progress, context.task);
          const remainingDebt = translationPreparationDebt(progress, context.task);
          if (remainingDebt >= preparationDebt) {
            noProgressTurns += 1;
            if (noProgressTurns >= MAX_HOST_CONTRACT_NO_PROGRESS_TURNS) {
              const finalToolError = await latestFailedToolFeedback(session);
              const message = [
                `Translation subagent made no host-contract progress after ${noProgressTurns} corrective turns: ${remaining.join(", ")}.`,
                ...(finalToolError ? [`Latest host tool rejection: ${finalToolError}`] : [])
              ].join(" ");
              throw assignedTranslationRepairExhaustionError({
                context,
                progress,
                artifact: await validateAssignedRange(context),
                message
              });
            }
          } else {
            noProgressTurns = 0;
          }
          missingPreparation = remaining;
          preparationDebt = remainingDebt;
        }
        artifact = await validateAssignedRange(context);
      }
      let repairPlan = buildAssignedTranslationRepairPlan({
        fromLine: context.task.fromLine,
        sourceSlice: artifact.sourceSlice,
        validation: artifact.validation,
        requiredLines: [...(progress.requiredBatchLines ?? [])],
        languagePair: context.request.languagePair,
        executionMode: context.executionMode,
        glossaryCandidates: glossaryCandidatesEnabled
      });
      let repairTurn = 0;
      let repairNoProgressTurns = 0;
      let previousRepairFingerprint: string | undefined;
      while (
        (!artifact.accepted || (progress.requiredBatchLines?.size ?? 0) > 0)
        && (progress.translationWritten || repairPlan.repairLines.length > 0)
        && repairTurn < MAX_ASSIGNED_TRANSLATION_REPAIR_TURNS
      ) {
        repairTurn += 1;
        progress.requiredBatchLines = new Set(repairPlan.repairLines);
        const hasPriorRepairEvidence = await latestToolResultHasRepairEvidence(session);
        const repeatedEvidence = previousRepairFingerprint === repairPlan.fingerprint;
        const latestRepairToolError = await latestFailedToolFeedback(session);
        const repairPromptBody = hasPriorRepairEvidence
          ? repeatedEvidence
            ? [
                "The previous repair made no host-validation progress.",
                "Use the unchanged repairIssues and requiredBatchLines from the immediately preceding native tool result; do not restate or reread the whole assignment.",
                `Each replacement must be an actual translation in the target language required by the workflow${context.request.languagePair?.trim() ? ` (${context.request.languagePair.trim()})` : ""}.`,
                "Change only those rejected lines, call repairAssignedTranslation once, then validateAssignedTranslation."
              ].join("\n")
            : [
                "The host rejected only the listed lines in the immediately preceding native tool result.",
                "That Pi toolResult is the authoritative repair evidence; use its repairIssues and requiredBatchLines instead of requesting or restating the full chunk.",
                `Each replacement must be an actual translation in the target language required by the workflow${context.request.languagePair?.trim() ? ` (${context.request.languagePair.trim()})` : ""}.`,
                "Read only compact source spans needed for those lines, call repairAssignedTranslation once, then validateAssignedTranslation."
              ].join("\n")
          : repairPlan.prompt;
        const repairPrompt = [
          repairPromptBody,
          ...(latestRepairToolError ? [
            `Latest host tool rejection: ${latestRepairToolError}`,
            "This child is still write-capable only for the exact Host-required lines; correct the tool arguments without widening the task."
          ] : [])
        ].join("\n");
        await promptSubagentTurn({
          runtime,
          session,
          prompt: repairPrompt,
          signal: context.signal,
          onRetry
        });
        const repairedArtifact = await validateAssignedRange(context);
        const repairedPlan = buildAssignedTranslationRepairPlan({
          fromLine: context.task.fromLine,
          sourceSlice: repairedArtifact.sourceSlice,
          validation: repairedArtifact.validation,
          requiredLines: [...(progress.requiredBatchLines ?? [])],
          languagePair: context.request.languagePair,
          executionMode: context.executionMode,
          glossaryCandidates: glossaryCandidatesEnabled
        });
        const hasPendingRequiredLines = (progress.requiredBatchLines?.size ?? 0) > 0;
        if (
          (!repairedArtifact.accepted || hasPendingRequiredLines)
          && repairedPlan.fingerprint === repairPlan.fingerprint
        ) {
          repairNoProgressTurns += 1;
        } else {
          repairNoProgressTurns = 0;
        }
        artifact = repairedArtifact;
        previousRepairFingerprint = repairPlan.fingerprint;
        repairPlan = repairedPlan;
      }
      if (!progress.translationWritten && repairPlan.repairLines.length === 0) {
        let missingPreparation = missingTranslationPreparation(progress, context.task);
        let preparationDebt = translationPreparationDebt(progress, context.task);
        let noProgressTurns = 0;
        while (missingPreparation.length > 0) {
          const latestToolError = await latestFailedToolFeedback(session);
          await promptSubagentTurn({
            runtime,
            session,
            prompt: [
              "The current model page is repaired, but the logical assignment still has unread or unwritten pages.",
              `Complete only these missing native tools now, in order: ${missingPreparation.join(", ")}.`,
              `Translate the next page into the target language required by the workflow${context.request.languagePair?.trim() ? ` (${context.request.languagePair.trim()})` : ""}.`,
              ...(latestToolError ? [`Latest host tool rejection: ${latestToolError}`] : []),
              "Continue the same assignment with the next bounded source page. Do not use sparse repair entries for lines that have not yet been written."
            ].join("\n"),
            signal: context.signal,
            onRetry
          });
          const remaining = missingTranslationPreparation(progress, context.task);
          const remainingDebt = translationPreparationDebt(progress, context.task);
          if (remainingDebt >= preparationDebt) {
            noProgressTurns += 1;
            if (noProgressTurns >= MAX_HOST_CONTRACT_NO_PROGRESS_TURNS) {
              const finalToolError = await latestFailedToolFeedback(session);
              const message = [
                `Translation subagent made no pagination progress after ${noProgressTurns} corrective turns: ${remaining.join(", ")}.`,
                ...(finalToolError ? [`Latest host tool rejection: ${finalToolError}`] : [])
              ].join(" ");
              throw assignedTranslationRepairExhaustionError({
                context,
                progress,
                artifact: await validateAssignedRange(context),
                message
              });
            }
          } else {
            noProgressTurns = 0;
          }
          missingPreparation = remaining;
          preparationDebt = remainingDebt;
        }
        artifact = await validateAssignedRange(context);
        repairPlan = buildAssignedTranslationRepairPlan({
          fromLine: context.task.fromLine,
          sourceSlice: artifact.sourceSlice,
          validation: artifact.validation,
          requiredLines: [...(progress.requiredBatchLines ?? [])],
          languagePair: context.request.languagePair,
          executionMode: context.executionMode,
          glossaryCandidates: glossaryCandidatesEnabled
        });
      }
      const remainingRequiredLineCount = progress.requiredBatchLines?.size ?? 0;
      if (!artifact.accepted || remainingRequiredLineCount > 0) {
        const latestToolError = await latestFailedToolFeedback(session);
        const message = [
          `Subagent repair made no host-validation progress after ${MAX_ASSIGNED_TRANSLATION_REPAIR_TURNS} host-guided turns with ${remainingRequiredLineCount} required lines remaining (${repairNoProgressTurns} consecutive no-progress turns): ${artifact.validation.summary}`,
          ...(latestToolError ? [`Latest host tool rejection: ${latestToolError}`] : [])
        ].join(" ");
        throw assignedTranslationRepairExhaustionError({ context, progress, artifact, message });
      }
      progress.requiredBatchLines = undefined;
      progress.requiredBatchIssues = undefined;
      if (!progress.translationValidated) {
        await promptSubagentTurn({
          runtime,
          session,
          prompt: [
            "The assigned translation candidate now passes child-side validation, but your mandatory native tool sequence is incomplete.",
            context.executionMode === "bounded_repair"
              ? boundedSelectedLines.length > 0
                ? "Semantically compare only the Host-selected writable rows, then call validateAssignedTranslation with misalignedLines containing only selected rows that still fail; use [] when none fail. Do not emit pass reasons or rewrite until that native tool succeeds."
                : "Semantically compare every assigned source/candidate row, then call validateAssignedTranslation with misalignedLines containing only absolute lines that still fail; use [] when none fail. Do not emit pass reasons or rewrite until that native tool succeeds."
              : "Call validateAssignedTranslation now. Do not rewrite or answer until that native tool succeeds."
          ].join("\n"),
          signal: context.signal,
          onRetry
        });
        if (!progress.translationValidated) {
          throw new Error("Translation subagent did not complete the mandatory validateAssignedTranslation tool.");
        }
        artifact = await validateAssignedRange(context);
        if (!artifact.accepted) {
          throw new Error(`Assigned range changed after native validation: ${artifact.validation.summary}`);
        }
        assertCurrentAssignedSemanticAlignment(context, progress, artifact);
      }
      assertCurrentAssignedSemanticAlignment(context, progress, artifact);
      const resultSummary = `${context.task.documentId
        ? `Child-validated candidate for ${context.task.documentId}`
        : `Child-validated candidate L${context.task.fromLine}-L${context.task.toLine}`}; review-worker safety check required. ${artifact.validation.summary}`;
      return {
        reply: context.terminateOnAcceptedWrite ? "" : resultSummary,
        resultSummary,
        extra: {
          validation: artifact.validation,
          discoveries: progress.discoveries ?? EMPTY_TRANSLATION_DISCOVERIES
        }
      };
    }
  };
}

export async function runPiTranslationSubagent(
  context: PiTranslationSubagentContext
): Promise<PiTranslationSubagentResult> {
  const progress: PiTranslationProgress = {
    referenceRead: false,
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  return runPiSubagentRuntime(context, createPiTranslationRuntimeSpec(context, progress));
}

export interface PiTranslationWorkerFinish {
  status: "completed" | "failed" | "stopped";
  assignmentCount: number;
  completedAssignments: number;
  documentIds: string[];
  error?: string;
}

export interface PiTranslationSubagentWorker {
  control: PiSubagentControl;
  runAssignment: (context: PiTranslationSubagentContext) => Promise<PiTranslationSubagentResult>;
  finish: (outcome: PiTranslationWorkerFinish) => Promise<void>;
  dispose: () => Promise<void>;
}

function hostOwnedTranslationChunks(task: PiTranslationSubagentTask): PiTranslationSubagentTask[] {
  const chunks: PiTranslationSubagentTask[] = [];
  for (let fromLine = task.fromLine; fromLine <= task.toLine; fromLine += MAX_ASSIGNED_TRANSLATION_CHUNK_LINES) {
    chunks.push({
      ...task,
      fromLine,
      toLine: Math.min(task.toLine, fromLine + MAX_ASSIGNED_TRANSLATION_CHUNK_LINES - 1)
    });
  }
  return chunks;
}

function assertWorkerModel(
  selection: PiModelSelection,
  context: PiSubagentContext<PiSubagentTaskBase>
): void {
  const taskProviderId = context.task.providerId?.trim();
  const providerId = taskProviderId
    || context.request.subagentProviderId?.trim()
    || context.request.providerId?.trim();
  const modelId = context.task.modelId?.trim()
    || (taskProviderId
      ? undefined
      : context.request.subagentModelId?.trim() || context.request.modelId?.trim());
  if (providerId && providerId !== selection.providerId) {
    throw new Error(
      `Queued assignment requested provider ${providerId}, but this Pi worker is bound to ${selection.providerId}.`
    );
  }
  if (modelId && modelId !== selection.modelId) {
    throw new Error(
      `Queued assignment requested model ${modelId}, but this Pi worker is bound to ${selection.modelId}.`
    );
  }
}

export async function createPiTranslationSubagentWorker(
  initialContext: PiTranslationSubagentContext & { workerLabel?: string }
): Promise<PiTranslationSubagentWorker> {
  throwIfAborted(initialContext.signal);
  const subagentId = initialContext.subagentId ?? `subagent_${randomUUID()}`;
  const workerLabel = initialContext.workerLabel?.trim() || initialContext.task.label?.trim() || "Translation worker";
  const taskProviderId = initialContext.task.providerId?.trim();
  const selection = await (initialContext.createModelSelection ?? createPiModelSelection)({
    workspaceDir: initialContext.request.outputDir,
    providerId: taskProviderId || initialContext.request.subagentProviderId || initialContext.request.providerId,
    modelId: initialContext.task.modelId?.trim()
      || (taskProviderId ? undefined : initialContext.request.subagentModelId || initialContext.request.modelId)
  });
  throwIfAborted(initialContext.signal);
  const session = await new PiSessionRepository(initialContext.request.outputDir).createChild(
    subagentId,
    initialContext.request.sessionId
  );
  const initialProgress: PiTranslationProgress = {
    referenceRead: false,
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const initialSpec = createPiTranslationRuntimeSpec(initialContext, initialProgress);
  const tools = requireTranslationToolCapabilities(initialSpec.tools(subagentId));
  const runtime = new PiSessionAgentRuntime({
    session,
    sessionId: subagentId,
    models: selection.models,
    model: selection.model,
    thinkingLevel: resolveThinkingLevelForModel(selection.model, initialContext.request.thinkingLevel),
    tools,
    systemPrompt: await subagentSystemPrompt(initialContext, initialSpec),
    providerStreamTimeouts: initialContext.providerStreamTimeouts,
    retry: CHILD_RUNTIME_RETRY,
    afterToolCall: createTranslationWriteBatchHandoff(tools)
  });
  const workerStartedAt = Date.now();
  let activeContext: PiTranslationSubagentContext | undefined;
  let lastContext = initialContext;
  let lastPrompt = initialSpec.taskPrompt;
  let lastReply = "";
  let lastResultSummary = "";
  let lastError = "";
  let assignmentDiscoveries: PiTranslationDiscoveries = EMPTY_TRANSLATION_DISCOVERIES;
  let disposed = false;
  let assignmentsStarted = 0;
  const completedDocumentIds: string[] = [];
  const failedDocumentIds: string[] = [];

  const publishCard = async (args: {
    status: "running" | "completed" | "failed" | "stopped";
    live?: boolean;
    reply?: string;
    resultSummary?: string;
    error?: string;
    extraDetails?: Record<string, unknown>;
  }) => {
    const context = activeContext ?? lastContext;
    const publisher = args.live
      ? initialContext.publishLiveCustomMessage ?? initialContext.publishCustomMessage
      : initialContext.publishCustomMessage;
    await publisher(subagentCard({
      kind: "translation",
      id: subagentId,
      label: context.task.label?.trim() || workerLabel,
      status: args.status,
      prompt: lastPrompt,
      reply: args.reply,
      resultSummary: args.resultSummary,
      error: args.error,
      task: context.task,
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelName: selection.model.name,
      startedAt: workerStartedAt,
      ...(args.status === "running" ? {} : { finishedAt: Date.now() }),
      extraDetails: {
        currentDocumentId: context.task.documentId || documentId(context.request),
        completedDocumentIds: [...completedDocumentIds],
        failedDocumentIds: [...failedDocumentIds],
        ...args.extraDetails
      }
    }));
  };

  let runtimeAbort: Promise<unknown> | undefined;
  const abortRuntime = () => {
    runtimeAbort ??= runtime.abort();
    return runtimeAbort;
  };
  const onAbort = () => {
    const pending = abortRuntime();
    void pending.catch(() => undefined);
  };
  initialContext.signal?.addEventListener("abort", onAbort, { once: true });
  if (initialContext.signal?.aborted) onAbort();

  const control: PiSubagentControl = {
    inspect: async () => (await session.buildContext()).messages,
    steer: async (text) => {
      throwIfAborted(initialContext.signal);
      return runtime.queueSteer(text);
    },
    followUp: async (text) => {
      throwIfAborted(initialContext.signal);
      await runtime.followUp(text);
    },
    abort: async () => {
      await abortRuntime();
    }
  };
  initialContext.registerControl?.(control);
  await publishCard({
    status: "running",
    extraDetails: { activity: "queued" }
  });

  return {
    control,
    async runAssignment(context) {
      if (disposed) throw new Error(`Pi translation worker ${subagentId} is disposed.`);
      if (activeContext) throw new Error(`Pi translation worker ${subagentId} already owns an active assignment.`);
      throwIfAborted(initialContext.signal, context.signal);
      let stagingPath: string | undefined;
      let retainStagingAfterRun = Boolean(context.task.stagingCandidatePath?.trim());
      const assignmentDocumentId = context.task.documentId || documentId(context.request);
      if (context.onChunkReadyForReview) {
        stagingPath = await prepareTranslationStagingCandidate({
          outputDir: context.request.outputDir,
          sourcePaths: [sourcePath(context.request)],
          documentId: assignmentDocumentId,
          sessionId: context.request.sessionId,
          subagentId,
          assignmentId: `${assignmentDocumentId}:L${context.task.fromLine}-L${context.task.toLine}`,
          resumeStagingPath: context.task.stagingCandidatePath
        });
      }
      const assignmentContext: PiTranslationSubagentContext = stagingPath
        ? {
            ...context,
            workingCandidatePath: stagingPath,
            onStagingCandidateCheckpoint: async (checkpoint) => {
              retainStagingAfterRun = true;
              await context.onStagingCandidateCheckpoint?.(checkpoint);
            }
          }
        : context;
      activeContext = assignmentContext;
      lastContext = assignmentContext;
      assignmentDiscoveries = EMPTY_TRANSLATION_DISCOVERIES;
      const promoteAcceptedRange = async (
        chunkContext: PiTranslationSubagentContext,
        promotedDocumentId: string,
        promotedRange: { fromLine: number; toLine: number }
      ) => {
        if (!stagingPath) throw new Error("A reviewed translation requires a Host staging candidate.");
        const canonical = candidatePath(chunkContext.request);
        const sourceLineCount = splitTextLines(await readFile(sourcePath(chunkContext.request), "utf8")).length;
        let canonicalLines = Array.from({ length: sourceLineCount }, () => "");
        try {
          const current = splitTextLines(await readFile(canonical, "utf8"));
          if (current.length > sourceLineCount) {
            throw new Error(
              `Cannot promote reviewed translation: canonical candidate has ${current.length} lines but source has ${sourceLineCount}.`
            );
          }
          canonicalLines = current;
          while (canonicalLines.length < sourceLineCount) canonicalLines.push("");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const previousLines = canonicalLines.slice(promotedRange.fromLine - 1, promotedRange.toLine);
        const promoted = await promoteTranslationStagingRange({
          outputDir: chunkContext.request.outputDir,
          sourcePaths: [sourcePath(chunkContext.request)],
          documentId: promotedDocumentId,
          stagingPath,
          ...promotedRange
        });
        if (!promoted.ok) {
          throw new Error(
            promoted.error || `Failed to promote accepted range L${promotedRange.fromLine}-L${promotedRange.toLine}.`
          );
        }
        try {
          await context.onArtifactMutation?.(promotedDocumentId, promotedRange);
        } catch (error) {
          const rolledBack = await writeTranslationChunk({
            outputDir: chunkContext.request.outputDir,
            sourcePaths: [sourcePath(chunkContext.request)],
            documentId: promotedDocumentId,
            ...promotedRange,
            lines: previousLines
          });
          if (!rolledBack.ok) {
            throw new NonRetryableAssignmentError(
              `Accepted translation promotion failed and L${promotedRange.fromLine}-L${promotedRange.toLine} could not be rolled back.`,
              new AggregateError([error, new Error(rolledBack.error || "Unknown canonical rollback failure.")])
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          throw new NonRetryableAssignmentError(
            `Host evidence commit failed after accepting L${promotedRange.fromLine}-L${promotedRange.toLine}: ${message}`,
            error
          );
        }
      };
      const requestChunkReview = async (
        review: PiTranslationChunkReviewRequest
      ): Promise<PiTranslationChunkReviewDecision> => {
        if (!assignmentContext.onChunkReadyForReview) {
          throw new Error("Translation review callback is missing.");
        }
        try {
          return await assignmentContext.onChunkReadyForReview(review);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          throw new NonRetryableAssignmentError(
            `Translation review failed after staging ${review.documentId} L${review.fromLine}-L${review.toLine}; the staged candidate was retained for recovery.`,
            error
          );
        }
      };
      try {
        assertWorkerModel(selection, assignmentContext);
        const chunks = hostOwnedTranslationChunks(assignmentContext.task);
        await publishCard({
          status: "running",
          live: true,
          extraDetails: {
            activity: `translating ${context.task.documentId || documentId(context.request)}`,
            completedChunks: 0,
            totalChunks: chunks.length
          }
        });
        let outcome: Awaited<ReturnType<ReturnType<typeof createPiTranslationRuntimeSpec>["execute"]>> | undefined;
        for (const [chunkIndex, chunkTask] of chunks.entries()) {
          let reviewFeedback = chunkTask.reviewFeedback
            ?.filter((feedback) => feedback.line >= chunkTask.fromLine && feedback.line <= chunkTask.toLine)
            .map((feedback) => ({ line: feedback.line, reason: feedback.reason }));
          let previousRejectedCandidateHash: string | undefined;
          let reviewRepairCycles = 0;
          if (reviewFeedback?.length) {
            const rejectedContext: PiTranslationSubagentContext = {
              ...assignmentContext,
              task: chunkTask,
              executionMode: "chunk_review_repair"
            };
            const rejectedArtifact = await validateExistingAssignedRange(rejectedContext);
            if (rejectedArtifact && isStructurallyCompleteAssignedTranslation(rejectedArtifact)) {
              previousRejectedCandidateHash = assignedCandidateHash(rejectedContext, rejectedArtifact);
            }
          }
          while (true) {
            const repairingRejectedChunk = Boolean(reviewFeedback?.length);
            const chunkContext: PiTranslationSubagentContext = {
              ...assignmentContext,
              task: {
                ...chunkTask,
                ...(reviewFeedback ? { reviewFeedback } : {})
              },
              ...(repairingRejectedChunk ? { executionMode: "chunk_review_repair" as const } : {}),
              terminateOnAcceptedWrite: chunkIndex + 1 < chunks.length,
              deferSparseRepair: false
            };
            activeContext = chunkContext;
            const existingArtifact = repairingRejectedChunk
              ? undefined
              : await validateExistingAssignedRange(chunkContext);
            if (
              existingArtifact
              && isStructurallyCompleteAssignedTranslation(existingArtifact)
              && isYnTranslationChunkWritable(existingArtifact.validation)
            ) {
              const rangeLabel = `L${chunkTask.fromLine}-L${chunkTask.toLine}`;
              outcome = {
                reply: `Reused structurally valid translation ${rangeLabel}; the review-worker safety check is still required.`,
                resultSummary: `Structurally valid ${rangeLabel}; review-worker safety check required. ${existingArtifact.validation.summary}`,
                extra: {
                  validation: existingArtifact.validation,
                  discoveries: EMPTY_TRANSLATION_DISCOVERIES
                }
              };
            } else {
              const progress: PiTranslationProgress = {
                referenceRead: false,
                sourceRead: false,
                translationWritten: false,
                translationValidated: false,
                readLines: new Set<number>()
              };
              const spec = createPiTranslationRuntimeSpec(chunkContext, progress);
              lastPrompt = spec.taskPrompt;
              if (assignmentsStarted > 0) runtime.resetContext();
              runtime.reconfigure({
                tools: spec.tools(subagentId),
                systemPrompt: await subagentSystemPrompt(chunkContext, spec)
              });
              assignmentsStarted += 1;
              outcome = await spec.execute(runtime, session, spec.taskPrompt, async (attempt, error) => {
                await publishCard({
                  status: "running",
                  live: true,
                  extraDetails: {
                    activity: `${repairingRejectedChunk ? "repairing parent rejection" : `chunk ${chunkIndex + 1}/${chunks.length}`} · retry ${attempt}/${CHILD_RUNTIME_RETRY.maxRetries}`,
                    currentChunk: { fromLine: chunkTask.fromLine, toLine: chunkTask.toLine },
                    retryAttempt: attempt,
                    retryError: error
                  }
                });
              });
            }
            assignmentDiscoveries = mergeTranslationDiscoveries([
              assignmentDiscoveries,
              outcome.extra.discoveries
            ]);
            lastReply = outcome.reply || lastReply;
            const chunkArtifact = await validateAssignedRange(chunkContext);
            if (!chunkArtifact.accepted) {
              throw new Error(
                `Chunk L${chunkTask.fromLine}-L${chunkTask.toLine} failed mechanical validation before review-worker inspection: ${chunkArtifact.validation.summary}`
              );
            }
            if (!assignmentContext.onChunkReadyForReview) break;
            await publishCard({
              status: "running",
              live: true,
              extraDetails: {
                activity: `awaiting review worker for L${chunkTask.fromLine}-L${chunkTask.toLine}`,
                currentChunk: { fromLine: chunkTask.fromLine, toLine: chunkTask.toLine }
              }
            });
            retainStagingAfterRun = true;
            const decision = await requestChunkReview({
              subagentId,
              label: workerLabel,
              documentId: chunkTask.documentId || documentId(chunkContext.request),
              fromLine: chunkTask.fromLine,
              toLine: chunkTask.toLine,
              candidatePath: translationWorkingCandidatePath(chunkContext),
              validation: chunkArtifact.validation,
              discoveries: outcome.extra.discoveries,
              signal: context.signal
            });
            if (decision.accepted) {
              if (stagingPath) {
                await promoteAcceptedRange(
                  chunkContext,
                  chunkTask.documentId || documentId(chunkContext.request),
                  {
                  fromLine: chunkTask.fromLine,
                  toLine: chunkTask.toLine
                  }
                );
                retainStagingAfterRun = false;
              }
              break;
            }
            retainStagingAfterRun = true;
            const rejectedFeedback = normalizedTranslationReviewFeedback(decision, chunkTask);
            const rejectedCandidateHash = assignedCandidateHash(chunkContext, chunkArtifact);
            if (repairingRejectedChunk) {
              reviewRepairCycles += 1;
              if (previousRejectedCandidateHash === rejectedCandidateHash) {
                throw new ParentTakeoverAssignmentError(
                  `Review repair made no candidate progress for L${chunkTask.fromLine}-L${chunkTask.toLine}; reviewer still rejects ${reviewFeedbackSummary(rejectedFeedback)}.`,
                  {
                    documentId: chunkTask.documentId || documentId(chunkContext.request),
                    fromLine: chunkTask.fromLine,
                    toLine: chunkTask.toLine,
                    rejectedLines: [...new Set(rejectedFeedback.map((entry) => entry.line))].sort((left, right) => left - right),
                    feedback: reviewFeedbackSummary(rejectedFeedback),
                    ...(stagingPath ? { stagingCandidatePath: stagingPath } : {}),
                    candidateHash: rejectedCandidateHash
                  }
                );
              }
              if (reviewRepairCycles >= MAX_TRANSLATION_REVIEW_REPAIR_CYCLES) {
                throw new ParentTakeoverAssignmentError(
                  `Review repair did not pass after ${MAX_TRANSLATION_REVIEW_REPAIR_CYCLES} changed candidate attempts for L${chunkTask.fromLine}-L${chunkTask.toLine}. Latest feedback: ${reviewFeedbackSummary(rejectedFeedback)}.`,
                  {
                    documentId: chunkTask.documentId || documentId(chunkContext.request),
                    fromLine: chunkTask.fromLine,
                    toLine: chunkTask.toLine,
                    rejectedLines: [...new Set(rejectedFeedback.map((entry) => entry.line))].sort((left, right) => left - right),
                    feedback: reviewFeedbackSummary(rejectedFeedback),
                    ...(stagingPath ? { stagingCandidatePath: stagingPath } : {}),
                    candidateHash: rejectedCandidateHash
                  }
                );
              }
            }
            previousRejectedCandidateHash = rejectedCandidateHash;
            reviewFeedback = rejectedFeedback;
          }
        }
        throwIfAborted(initialContext.signal, context.signal);
        if (!outcome) throw new Error("Pi translation worker received an empty host chunk plan.");
        activeContext = context;
        let finalArtifact = await validateAssignedRange(context);
        if (!finalArtifact.accepted) {
          if (!isStructurallyCompleteAssignedTranslation(finalArtifact)) {
            throw new Error(
              `Whole-file validation is structurally incomplete after host chunk completion: ${finalArtifact.validation.summary}`
            );
          }
          const finalRepairFindings = [...finalArtifact.validation.blocking];
          let repairFeedback: Array<{ line: number; reason: string }> | undefined = finalRepairFindings
            .flatMap((finding) => finding.line === undefined
              ? []
              : [{
                  line: context.task.fromLine + finding.line - 1,
                  reason: finding.detail
                }])
            .filter((feedback) => feedback.line >= context.task.fromLine && feedback.line <= context.task.toLine);
          if (repairFeedback.length === 0) repairFeedback = undefined;
          let requiredReviewLines = [...new Set((repairFeedback ?? []).map((feedback) => feedback.line))]
            .filter((line) => line >= context.task.fromLine && line <= context.task.toLine)
            .sort((left, right) => left - right);
          let previousReviewRejectedCandidateHash: string | undefined;
          let reviewRepairCycles = 0;
          const repairProgress: PiTranslationProgress = {
            referenceRead: false,
            sourceRead: false,
            translationWritten: false,
            translationValidated: false
          };
          while (true) {
            const fileRepairContext: PiTranslationSubagentContext = {
              ...(assignmentContext.onChunkReadyForReview ? assignmentContext : context),
              task: repairFeedback
                ? { ...context.task, reviewFeedback: repairFeedback }
                : context.task,
              ...(repairFeedback ? { executionMode: "chunk_review_repair" as const } : {}),
              terminateOnAcceptedWrite: false,
              deferSparseRepair: false
            };
            activeContext = fileRepairContext;
            repairProgress.referenceRead = false;
            repairProgress.sourceRead = false;
            repairProgress.translationWritten = false;
            repairProgress.translationValidated = false;
            repairProgress.readLines = new Set<number>();
            repairProgress.writtenLines = new Set<number>();
            repairProgress.mutatedLines = new Set<number>();
            repairProgress.requiredBatchLines = undefined;
            repairProgress.requiredBatchIssues = undefined;
            if (repairFeedback?.length) {
              repairProgress.requiredBatchLines = new Set(requiredReviewLines);
              markCovered(repairProgress.writtenLines, context.task);
              repairProgress.translationWritten = true;
            }
            const repairSpec = createPiTranslationRuntimeSpec(fileRepairContext, repairProgress);
            runtime.resetContext();
            runtime.reconfigure({
              tools: repairSpec.tools(subagentId),
              systemPrompt: await subagentSystemPrompt(fileRepairContext, repairSpec)
            });
            assignmentsStarted += 1;
            outcome = await repairSpec.execute(runtime, session, repairSpec.taskPrompt, async (attempt, error) => {
              await publishCard({
                status: "running",
                live: true,
                extraDetails: {
                  activity: `file repair · retry ${attempt}/${CHILD_RUNTIME_RETRY.maxRetries}`,
                  retryAttempt: attempt,
                  retryError: error
                }
              });
            });
            assignmentDiscoveries = mergeTranslationDiscoveries([
              assignmentDiscoveries,
              outcome.extra.discoveries
            ]);
            lastReply = outcome.reply || lastReply;
            const mutatedLines = [...(repairProgress.mutatedLines ?? [])]
              .filter((line) => line >= context.task.fromLine && line <= context.task.toLine)
              .sort((left, right) => left - right);
            if (mutatedLines.length > 0) requiredReviewLines = mutatedLines;
            finalArtifact = await validateAssignedRange(fileRepairContext);
            if (!finalArtifact.accepted) {
              throw new Error(`Whole-file validation failed after host chunk repair: ${finalArtifact.validation.summary}`);
            }
            if (!assignmentContext.onChunkReadyForReview) break;

            const requiredLineSet = new Set(requiredReviewLines);
            const reviewTargets = requiredLineSet.size > 0
              ? chunks.filter((chunk) => [...requiredLineSet].some((line) => (
                  line >= chunk.fromLine && line <= chunk.toLine
                )))
              : chunks;
            const rejectedFeedback: Array<{ line: number; reason: string }> = [];
            for (const reviewTask of reviewTargets) {
              const reviewContext: PiTranslationSubagentContext = {
                ...fileRepairContext,
                task: reviewTask
              };
              const reviewedArtifact = await validateAssignedRange(reviewContext);
              if (!reviewedArtifact.accepted) {
                throw new Error(
                  `Repaired chunk L${reviewTask.fromLine}-L${reviewTask.toLine} failed mechanical validation before review-worker inspection: ${reviewedArtifact.validation.summary}`
                );
              }
              const requiredLines = [...requiredLineSet]
                .filter((line) => line >= reviewTask.fromLine && line <= reviewTask.toLine);
              await publishCard({
                status: "running",
                live: true,
                extraDetails: {
                  activity: `awaiting review worker for repaired L${reviewTask.fromLine}-L${reviewTask.toLine}`,
                  currentChunk: { fromLine: reviewTask.fromLine, toLine: reviewTask.toLine }
                }
              });
              retainStagingAfterRun = true;
              const decision = await requestChunkReview({
                subagentId,
                label: workerLabel,
                documentId: reviewTask.documentId || documentId(reviewContext.request),
                fromLine: reviewTask.fromLine,
                toLine: reviewTask.toLine,
                candidatePath: translationWorkingCandidatePath(reviewContext),
                validation: reviewedArtifact.validation,
                discoveries: outcome.extra.discoveries,
                ...(requiredLines.length > 0 ? { requiredLines } : {}),
                signal: context.signal
              });
              if (decision.accepted) {
                if (!stagingPath) {
                  throw new Error("A reviewed whole-file repair requires a Host staging candidate.");
                }
                const promotedRanges = requiredLines.length > 0
                  ? contiguousLineRanges(requiredLines)
                  : [{ fromLine: reviewTask.fromLine, toLine: reviewTask.toLine }];
                for (const promotedRange of promotedRanges) {
                  await promoteAcceptedRange(
                    reviewContext,
                    reviewTask.documentId || documentId(reviewContext.request),
                    promotedRange
                  );
                }
                retainStagingAfterRun = false;
                continue;
              }

              const feedback = normalizedTranslationReviewFeedback(decision, reviewTask);
              rejectedFeedback.push(...feedback);
              retainStagingAfterRun = true;
            }
            if (rejectedFeedback.length > 0) {
              reviewRepairCycles += 1;
              const rejectedCandidateHash = assignedCandidateHash(fileRepairContext, finalArtifact);
              if (previousReviewRejectedCandidateHash === rejectedCandidateHash) {
                throw new ParentTakeoverAssignmentError(
                  `Review repair made no candidate progress for L${context.task.fromLine}-L${context.task.toLine}; reviewer still rejects ${reviewFeedbackSummary(rejectedFeedback)}.`,
                  {
                    documentId: context.task.documentId || documentId(context.request),
                    fromLine: context.task.fromLine,
                    toLine: context.task.toLine,
                    rejectedLines: [...new Set(rejectedFeedback.map((entry) => entry.line))].sort((left, right) => left - right),
                    feedback: reviewFeedbackSummary(rejectedFeedback),
                    ...(stagingPath ? { stagingCandidatePath: stagingPath } : {}),
                    candidateHash: rejectedCandidateHash
                  }
                );
              }
              if (reviewRepairCycles >= MAX_TRANSLATION_REVIEW_REPAIR_CYCLES) {
                throw new ParentTakeoverAssignmentError(
                  `Review repair did not pass after ${MAX_TRANSLATION_REVIEW_REPAIR_CYCLES} changed candidate attempts for L${context.task.fromLine}-L${context.task.toLine}. Latest feedback: ${reviewFeedbackSummary(rejectedFeedback)}.`,
                  {
                    documentId: context.task.documentId || documentId(context.request),
                    fromLine: context.task.fromLine,
                    toLine: context.task.toLine,
                    rejectedLines: [...new Set(rejectedFeedback.map((entry) => entry.line))].sort((left, right) => left - right),
                    feedback: reviewFeedbackSummary(rejectedFeedback),
                    ...(stagingPath ? { stagingCandidatePath: stagingPath } : {}),
                    candidateHash: rejectedCandidateHash
                  }
                );
              }
              previousReviewRejectedCandidateHash = rejectedCandidateHash;
              repairFeedback = rejectedFeedback;
              requiredReviewLines = [...new Set(rejectedFeedback.map((entry) => entry.line))];
              continue;
            }
            finalArtifact = await validateAssignedRange(context);
            break;
          }
        }
        if (!finalArtifact.accepted) {
          throw new Error(`Whole-file validation failed after host chunk completion: ${finalArtifact.validation.summary}`);
        }
        const resolvedDocumentId = assignmentDocumentId;
        if (!completedDocumentIds.includes(resolvedDocumentId)) completedDocumentIds.push(resolvedDocumentId);
        const failedIndex = failedDocumentIds.indexOf(resolvedDocumentId);
        if (failedIndex >= 0) failedDocumentIds.splice(failedIndex, 1);
        lastError = "";
        lastResultSummary = `Review-worker-accepted candidate ${context.task.documentId ?? assignmentDocumentId} `
          + `L${context.task.fromLine}-L${context.task.toLine}; every Host-sized chunk was accepted before queue advance. `
          + finalArtifact.validation.summary;
        await publishCard({
          status: "running",
          live: true,
          reply: lastReply,
          resultSummary: lastResultSummary,
          extraDetails: {
            activity: `validated ${chunks.length}/${chunks.length} chunks`,
            completedChunks: chunks.length,
            totalChunks: chunks.length
          }
        });
        return {
          subagentId,
          label: workerLabel,
          documentId: resolvedDocumentId,
          fromLine: context.task.fromLine,
          toLine: context.task.toLine,
          providerId: selection.providerId,
          modelId: selection.modelId,
          modelName: selection.model.name,
          reply: lastReply,
          resultSummary: lastResultSummary,
          validation: finalArtifact.validation,
          discoveries: assignmentDiscoveries
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedDocumentId = context.task.documentId || documentId(context.request);
        if (!failedDocumentIds.includes(failedDocumentId)) failedDocumentIds.push(failedDocumentId);
        lastError = message;
        try {
          await publishCard({ status: "running", live: true, error: message });
        } catch (publishError) {
          throw new AggregateError([error, publishError], `${message}; publishing worker failure also failed.`);
        }
        throw error;
      } finally {
        activeContext = undefined;
        if (stagingPath && !retainStagingAfterRun) {
          await discardTranslationStagingCandidate({
            outputDir: context.request.outputDir,
            stagingPath
          });
        }
      }
    },
    async finish(outcome) {
      if (disposed) throw new Error(`Pi translation worker ${subagentId} is disposed.`);
      await publishCard({
        status: outcome.status,
        reply: outcome.status === "completed" ? lastReply : "",
        resultSummary: outcome.status === "completed"
          ? lastResultSummary
          : `${outcome.completedAssignments}/${outcome.assignmentCount} assignments settled; ${failedDocumentIds.length} failed.`,
        error: outcome.error || (outcome.status === "completed" ? undefined : lastError),
        extraDetails: {
          assignmentCount: outcome.assignmentCount,
          completedAssignments: outcome.completedAssignments,
          documentIds: [...outcome.documentIds]
        }
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      initialContext.signal?.removeEventListener("abort", onAbort);
      let abortFailure: unknown;
      if (runtimeAbort) {
        try {
          await runtimeAbort;
        } catch (error) {
          abortFailure = error;
        }
      }
      runtime.dispose();
      if (abortFailure !== undefined) throw abortFailure;
    }
  };
}

function missingProofreadSteps(progress: PiProofreadProgress): string[] {
  const missing: string[] = [];
  if (!progress.referenceRead) missing.push("readAssignedProofreadContext");
  for (const [id, state] of progress.referenceOffsets ?? []) {
    if (state.required && state.offset < state.length) {
      missing.push(`readProofreadReference(${id}, offset ${state.offset})`);
    }
  }
  if (!progress.findingsWritten) missing.push("writeAssignedFindings");
  return missing;
}

function proofreadProgressFingerprint(progress: PiProofreadProgress): string {
  return JSON.stringify({
    referenceRead: progress.referenceRead,
    nextAssignedLine: progress.nextAssignedLine,
    nextAssignedIndex: progress.nextAssignedIndex,
    referenceOffsets: [...(progress.referenceOffsets?.entries() ?? [])]
      .map(([id, state]) => [id, state.offset, state.length, state.required]),
    findingsWritten: progress.findingsWritten,
    findingsCount: progress.findingsCount
  });
}

export async function runPiProofreadSubagent(
  context: PiProofreadSubagentContext
): Promise<PiProofreadSubagentResult> {
  const progress: PiProofreadProgress = {
    referenceRead: false,
    findingsWritten: false,
    findingsCount: 0,
    glossaryCandidates: []
  };
  return runPiSubagentRuntime(context, createPiProofreadRuntimeSpec(context, progress));
}

function createPiProofreadRuntimeSpec(
  context: PiProofreadSubagentContext,
  progress: PiProofreadProgress,
  assignmentReferences?: ProofreadAssignmentReferenceContext
): PiSubagentRuntimeSpec<{
  findingsWritten: number;
  glossaryCandidates: PiTranslationGlossaryDiscovery[];
  reportPath?: string;
}> {
  const glossaryCandidatesEnabled = context.request.glossaryCandidates !== false;
  return {
    kind: "proofread",
    label: context.task.label?.trim() || (context.task.documentId
      ? `Proofread ${context.task.documentId}`
      : `Proofread L${context.task.fromLine}-L${context.task.toLine}`),
    taskPrompt: [
      context.task.sampledLines
        ? `Proofread only the ${context.task.sampledLines.length} host-sampled aligned lines assigned for Monte Carlo round ${context.task.round ?? 1}.`
        : context.task.reviewLines
          ? `Split-review only the ${context.task.reviewLines.length} Host-selected HOT-region aligned lines. Read every selected row; unlisted gap lines are boundary context, not owned findings.`
          : `Proofread the aligned ${assignmentDescription(context.task)}.`,
      ...(context.request.style?.trim() ? [`Project style: ${context.request.style.trim()}`] : []),
      ...(context.request.workDescription?.trim() ? [`Work description: ${context.request.workDescription.trim()}`] : []),
      "FIRST TOOL: call readAssignedProofreadContext. It returns complete structured glossary/character records, unresolved non-canonical candidates, and prior exact-search evidence directly matched to this assignment. Reuse those results. Use one exact searchProjectText lookup only for a still-missing ambiguous term. Reference manifest entries with complete=true are already fully read; call readProofreadReference only for complete=false, starting at offset 0 and continuing exactly from nextOffset. Optional web references are only for relevant ambiguity.",
      "readAssignedProofreadContext already contains the complete owned rows for source/current translation and the exact boundary rows. Do not call listProjectDir to rediscover them, do not reread the bound source/current translation through general file reads, and do not browse raw assets or preceding files for context already supplied by Host.",
      "Confirm or reject Host signals and semantically review every assigned row. Signals are evidence, not automatic findings.",
      glossaryCandidatesEnabled
        ? "Call writeAssignedFindings with exact one-based lines, complete replacement-ready fixes, rationales, and evidence-backed proper-term candidates. Every suggestedFix must change the current translation and preserve the exact leading control prefix from the bound source/current row. If both the source and current translation contain no leading prefix, do not invent one or diagnose its absence. Host keeps valid findings and returns only rejected items; rewrite those items instead of resubmitting the whole batch. glossaryCandidates.category must be one of proper_noun, character, organization, place, title, or setting_term; aliases contains alternate target-language renderings only, never source-language nicknames. [] is valid when clean."
        : "Call writeAssignedFindings with exact one-based lines, complete replacement-ready fixes, and rationales. Glossary-candidate collection is disabled; do not submit terminology candidates. Every suggestedFix must change the current translation and preserve the exact leading control prefix from the bound source/current row. Host keeps valid findings and returns only rejected items. [] is valid when clean.",
      "Never edit source, translation, or shared assets. A successful writeAssignedFindings call is terminal; do not spend another model turn summarizing it."
    ].join("\n"),
    tools: (subagentId) => createPiProofreadSubagentTools(
      context,
      subagentId,
      progress,
      assignmentReferences
    ),
    systemPrompt: [
      "You are a Pi proofreading subagent for YN Translation Workshop.",
      "Use only the host-owned proofreading tools. Never modify source or translation artifacts."
    ],
    async execute(runtime, session, taskPrompt, onRetry) {
      await assertProofreadAssignmentFiles(context.request);
      await promptSubagentTurn({ runtime, session, prompt: taskPrompt, signal: context.signal, onRetry });
      let missing = missingProofreadSteps(progress);
      while (missing.length > 0) {
        const beforeProgress = proofreadProgressFingerprint(progress);
        await promptSubagentTurn({
          runtime,
          session,
          prompt: [
            "The assigned proofreading artifact contract is incomplete.",
            `Complete only these missing native tools now: ${missing.join(", ")}.`,
            "Do not finish until writeAssignedFindings succeeds; [] is valid when there are no findings."
          ].join("\n"),
          signal: context.signal,
          onRetry
        });
        const remaining = missingProofreadSteps(progress);
        if (proofreadProgressFingerprint(progress) === beforeProgress) {
          throw new NonRetryableAssignmentError(
            `Proofread subagent made no host-contract progress: ${remaining.join(", ")}.`
          );
        }
        missing = remaining;
      }
      const summary = `Proofread L${context.task.fromLine}-L${context.task.toLine} completed with ${progress.findingsCount} findings.`;
      return {
        reply: summary,
        resultSummary: summary,
        extra: {
          findingsWritten: progress.findingsCount,
          glossaryCandidates: progress.glossaryCandidates ?? [],
          ...(progress.reportPath ? { reportPath: progress.reportPath } : {})
        }
      };
    },
    cardDetails: (extra) => ({
      findingsWritten: extra.findingsWritten,
      glossaryCandidates: extra.glossaryCandidates?.length ?? 0
    })
  };
}

export interface PiProofreadWorkerFinish {
  status: "completed" | "failed" | "stopped";
  assignmentCount: number;
  completedAssignments: number;
  documentIds: string[];
  error?: string;
}

export interface PiProofreadSubagentWorker {
  control: PiSubagentControl;
  runAssignment: (context: PiProofreadSubagentContext) => Promise<PiProofreadSubagentResult>;
  finish: (outcome: PiProofreadWorkerFinish) => Promise<void>;
  dispose: () => Promise<void>;
}

type PiProofreadWorkerInitialContext = Omit<PiProofreadSubagentContext, "task"> & {
  task?: PiProofreadSubagentTask;
  workerLabel?: string;
  workerProviderId?: string;
  workerModelId?: string;
};

export async function createPiProofreadSubagentWorker(
  initialContext: PiProofreadWorkerInitialContext
): Promise<PiProofreadSubagentWorker> {
  throwIfAborted(initialContext.signal);
  const subagentId = initialContext.subagentId ?? `subagent_${randomUUID()}`;
  const workerLabel = initialContext.workerLabel?.trim() || initialContext.task?.label?.trim() || "Proofread worker";
  const taskProviderId = initialContext.workerProviderId?.trim() || initialContext.task?.providerId?.trim();
  const selection = await (initialContext.createModelSelection ?? createPiModelSelection)({
    workspaceDir: initialContext.request.outputDir,
    providerId: taskProviderId || initialContext.request.subagentProviderId || initialContext.request.providerId,
    modelId: initialContext.workerModelId?.trim() || initialContext.task?.modelId?.trim()
      || (taskProviderId ? undefined : initialContext.request.subagentModelId || initialContext.request.modelId)
  });
  throwIfAborted(initialContext.signal);
  const session = await new PiSessionRepository(initialContext.request.outputDir).createChild(
    subagentId,
    initialContext.request.sessionId
  );
  const workerStartedAt = Date.now();
  let assignmentsStarted = 0;
  let disposed = false;
  let activeContext: PiProofreadSubagentContext | undefined;
  let lastContext = initialContext.task
    ? { ...initialContext, task: initialContext.task } as PiProofreadSubagentContext
    : undefined;
  let lastPrompt = "Waiting for a Host proofreading assignment.";
  let lastReply = "";
  let lastResultSummary = "";
  let lastError = "";
  let runtime: PiSessionAgentRuntime | undefined;
  let runtimeAbort: Promise<unknown> | undefined;
  const referenceCache: ProofreadWorkerReferenceCache = {
    referenceSha256: new Map()
  };

  const publishCard = async (args: {
    status: "running" | "completed" | "failed" | "stopped";
    live?: boolean;
    reply?: string;
    resultSummary?: string;
    error?: string;
    extraDetails?: Record<string, unknown>;
  }) => {
    const context = activeContext ?? lastContext;
    const publisher = args.live
      ? initialContext.publishLiveCustomMessage ?? initialContext.publishCustomMessage
      : initialContext.publishCustomMessage;
    await publisher(subagentCard({
      kind: "proofread",
      id: subagentId,
      label: workerLabel,
      status: args.status,
      prompt: lastPrompt,
      reply: args.reply,
      resultSummary: args.resultSummary,
      error: args.error,
      task: context?.task ?? {},
      providerId: selection.providerId,
      modelId: selection.modelId,
      modelName: selection.model.name,
      startedAt: workerStartedAt,
      ...(args.status === "running" ? {} : { finishedAt: Date.now() }),
      extraDetails: args.extraDetails
    }));
  };

  const abortRuntime = () => runtimeAbort ??= runtime?.abort() ?? Promise.resolve();
  const onAbort = () => { void abortRuntime().catch(() => undefined); };
  initialContext.signal?.addEventListener("abort", onAbort, { once: true });
  if (initialContext.signal?.aborted) onAbort();
  const control: PiSubagentControl = {
    inspect: async () => (await session.buildContext()).messages,
    steer: async (text) => {
      if (!runtime) throw new Error(`Pi proofread worker ${subagentId} has no active assignment to steer.`);
      return runtime.queueSteer(text);
    },
    followUp: async (text) => {
      if (!runtime) throw new Error(`Pi proofread worker ${subagentId} has no active assignment for follow-up.`);
      await runtime.followUp(text);
    },
    abort: async () => { await abortRuntime(); }
  };
  initialContext.registerControl?.(control);
  await publishCard({ status: "running", extraDetails: { activity: "queued" } });

  return {
    control,
    async runAssignment(context) {
      if (disposed) throw new Error(`Pi proofread worker ${subagentId} is disposed.`);
      if (activeContext) throw new Error(`Pi proofread worker ${subagentId} already owns an active assignment.`);
      throwIfAborted(initialContext.signal, context.signal);
      activeContext = context;
      lastContext = context;
      try {
        await assertProofreadAssignmentFiles(context.request);
        if (assignmentsStarted > 0) {
          referenceCache.workflowSha256 = undefined;
          referenceCache.referenceSha256.clear();
        }
        const bundle = await proofreadReferenceBundle(context.request, referenceCache);
        const previousReferenceSignature = referenceCache.signature;
        const referencesChanged = previousReferenceSignature !== undefined
          && previousReferenceSignature !== bundle.signature;
        if (referencesChanged) {
          referenceCache.workflowSha256 = undefined;
          referenceCache.referenceSha256.clear();
        }
        const assignmentReferences: ProofreadAssignmentReferenceContext = {
          bundle,
          cache: referenceCache,
          status: previousReferenceSignature === undefined
            ? "loaded"
            : referencesChanged ? "refreshed" : "reused"
        };
        referenceCache.signature = bundle.signature;
        const progress: PiProofreadProgress = {
          referenceRead: false,
          findingsWritten: false,
          findingsCount: 0,
          glossaryCandidates: []
        };
        const spec = createPiProofreadRuntimeSpec(context, progress, assignmentReferences);
        const systemPrompt = await subagentSystemPrompt(context, spec);
        if (!runtime) {
          runtime = new PiSessionAgentRuntime({
            session,
            sessionId: subagentId,
            models: selection.models,
            model: selection.model,
            thinkingLevel: resolveThinkingLevelForModel(selection.model, context.request.thinkingLevel),
            tools: spec.tools(subagentId),
            systemPrompt,
            providerStreamTimeouts: context.providerStreamTimeouts,
            retry: CHILD_RUNTIME_RETRY
          });
        } else {
          runtime.resetContext();
          runtime.reconfigure({
            tools: spec.tools(subagentId),
            systemPrompt
          });
        }
        assignmentsStarted += 1;
        lastPrompt = spec.taskPrompt;
        await publishCard({
          status: "running",
          live: true,
          extraDetails: {
            activity: `proofreading L${context.task.fromLine}-L${context.task.toLine}`,
            assignment: assignmentsStarted
          }
        });
        const outcome = await spec.execute(runtime, session, spec.taskPrompt, async (attempt, error) => {
          await publishCard({
            status: "running",
            live: true,
            extraDetails: {
              activity: `retrying L${context.task.fromLine}-L${context.task.toLine}`,
              retryAttempt: attempt,
              retryError: error
            }
          });
        });
        throwIfAborted(initialContext.signal, context.signal);
        lastReply = outcome.reply || lastReply;
        lastResultSummary = outcome.resultSummary;
        lastError = "";
        await publishCard({
          status: "running",
          live: true,
          reply: lastReply,
          resultSummary: lastResultSummary,
          extraDetails: {
            activity: `completed L${context.task.fromLine}-L${context.task.toLine}`,
            assignment: assignmentsStarted,
            findingsWritten: outcome.extra.findingsWritten
          }
        });
        return {
          subagentId,
          label: workerLabel,
          documentId: context.task.documentId,
          fromLine: context.task.fromLine,
          toLine: context.task.toLine,
          providerId: selection.providerId,
          modelId: selection.modelId,
          modelName: selection.model.name,
          reply: outcome.reply,
          resultSummary: outcome.resultSummary,
          findingsWritten: outcome.extra.findingsWritten,
          glossaryCandidates: outcome.extra.glossaryCandidates,
          ...(outcome.extra.reportPath ? { reportPath: outcome.extra.reportPath } : {})
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await publishCard({ status: "running", live: true, error: lastError });
        throw error;
      } finally {
        activeContext = undefined;
      }
    },
    async finish(outcome) {
      if (disposed) throw new Error(`Pi proofread worker ${subagentId} is disposed.`);
      await publishCard({
        status: outcome.status,
        reply: outcome.status === "completed" ? lastReply : "",
        resultSummary: outcome.status === "completed"
          ? `${outcome.completedAssignments}/${outcome.assignmentCount} proofreading assignments completed.`
          : `${outcome.completedAssignments}/${outcome.assignmentCount} proofreading assignments settled.`,
        error: outcome.error || (outcome.status === "completed" ? undefined : lastError),
        extraDetails: {
          assignmentCount: outcome.assignmentCount,
          completedAssignments: outcome.completedAssignments,
          lastResultSummary
        }
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      initialContext.signal?.removeEventListener("abort", onAbort);
      if (runtimeAbort) await runtimeAbort;
      runtime?.dispose();
    }
  };
}
