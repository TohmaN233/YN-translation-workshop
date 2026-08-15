import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";

import {
  YN_DEFAULT_SPLIT_SIZE,
  resolveWorkflowSubagentCount,
  type PiSessionPromptRequest
} from "../../../shared/agent/piSessionContract.ts";
import {
  splitTextLines,
  validateTranslationCandidate,
  type ValidationOptions
} from "../../../shared/validation/translationValidator.ts";
import {
  listProjectDir,
  readProjectFile,
  searchProjectText,
  writeProjectFile
} from "../projectFileTools.ts";
import {
  readProjectAssets,
  serializeCharacterBibleMarkdown,
  type ProjectAssets
} from "../projectAssets.ts";
import {
  readWorkspaceAssetsStatus,
  runWorkspaceGlossaryCandidateTransaction,
  validateGeneratedCharacterBibleContent,
  validateGeneratedGlossaryContent,
  type WorkspaceGlossaryCandidateCommit
} from "../workspaceAssets.ts";
import { relativeProjectPath, resolveProjectPath } from "../projectPathGuard.ts";
import { searchTranslationMemory } from "../translationMemory.ts";
import {
  resetProofreadFindings,
  removeLegacyProofreadSummary,
  proofreadSuggestedFixChangesTranslation,
  proofreadSuggestedFixPreservesControlPrefix,
  restoreProofreadFindings,
  resolveProofreadReportPath,
  snapshotProofreadFindings,
  writeProofreadFindings
} from "../writeProofreadFindings.ts";
import {
  isTranslationStagingCandidatePath,
  resolveTranslationCandidatePath,
  writeTranslationChunk
} from "../writeTranslationChunk.ts";
import { writeTextFileAtomically } from "../../atomicFile.ts";
import {
  listPiConfiguredModels,
  type PiConfiguredModel
} from "./providerRegistry.ts";
import type {
  YnDomainRunContract,
  YnResolvedTranslationTerm,
  YnTranslationDiscoveryConflict,
  YnTranslationDiscoveryRecord,
  YnTranslationTerminologyDebt
} from "./domainRunContract.ts";
import {
  assertYnTranslationArtifactAccepted,
  assertYnTranslationChunkWritable,
  compactYnTranslationValidation,
  isYnTranslationArtifactAccepted,
  isYnTranslationChunkWritable,
  ynTranslationValidationDebt
} from "./translationArtifactValidation.ts";
import { createYnTranslationValidationOptions } from "./translationValidationContext.ts";
import {
  buildProofreadDeterministicSignals,
  summarizeProofreadDeterministicSignals,
  type ProofreadDeterministicSignal,
  type ProofreadPrescanSummary
} from "./proofreadPrescan.ts";
import {
  createHotSplitProofreadTasks,
  createMontecarloProofreadTasks,
  createSplitProofreadTasks
} from "./proofreadPlan.ts";
import {
  mergeTranslationDiscoveries,
  type PiTranslationDiscoveries,
  type PiGeneralSubagentTask,
  type PiProofreadPendingGlossaryCandidate,
  type PiProofreadSubagentResult,
  type PiProofreadSubagentTask,
  type PiTranslationChunkReviewDecision,
  type PiTranslationChunkReviewRequest,
  type PiTranslationReviewAssignment,
  type PiTranslationReviewFailure,
  type PiTranslationReviewTask,
  type PiTranslationSubagentResult,
  type PiTranslationSubagentTask
} from "./subagentRunner.ts";
import {
  createYnSubagentBatchId,
  type YnSubagentSupervisor
} from "./subagentSupervisor.ts";
import {
  bindPiSourceDocument,
  requestDocumentId,
  resolvePiReadablePath,
  resolvePiSourceDocument,
  resolvePiSourceManifest,
  type PiBoundSourceRequest,
  type PiSourceManifest
} from "./sourceManifest.ts";
import {
  webReferenceService,
  type WebReferenceService
} from "./webReference.ts";
import {
  createProofreadHostState,
  proofreadDocumentHostState,
  type ProofreadCompletedSplitScope,
  type ProofreadGlossaryCandidateState,
  type ProofreadLocalScopeState,
  type ProofreadHostState
} from "./proofreadSessionState.ts";
import {
  createTranslationChunkReviewAudit,
  createTranslationMutationReviewAudit,
  createTranslationRepairReviewAudit,
  createTranslationAlignmentHostState,
  isActionableTranslationAlignmentReason,
  replaceTranslationAlignmentRange,
  translationAlignmentInputHash,
  translationAlignmentLinesInputHash,
  type TranslationAlignmentDocumentState,
  type TranslationAlignmentRangeState,
  type TranslationAlignmentHostState
} from "./translationAlignmentState.ts";
import {
  parseFolderTranslationOrder,
  planFolderTranslationTasks,
  subtractCompletedTranslationRanges
} from "./folderTranslationPlan.ts";
import {
  applyTranslationReuseAudits,
  discardTranslationCandidateForRetranslation,
  getTranslationReuseAuditSummary,
  listAppliedTranslationReuseAudits,
  listCurrentPendingTranslationReuseAudits,
  planAppliedTranslationReuseTasks,
  planTranslationReuseAuditTasks,
  prepareTranslationReuseAudits,
  readTranslationReuseAuditBatch,
  recordTranslationReuseAuditBatch
} from "./translationReuseAudit.ts";
import type { AppliedTranslationReuseAuditEvidence } from "./translationReuseAudit.ts";
import type { YnInterfaceContextSnapshot } from "../../../shared/agent/ynInterfaceContext.ts";

export interface YnDomainToolContext {
  request: PiSessionPromptRequest;
  publishCustomMessage: (message: AgentMessage) => Promise<void>;
  subagents: YnSubagentSupervisor;
  domainRun?: YnDomainRunContract;
  webReferences?: WebReferenceService;
  proofreadState?: ProofreadHostState;
  translationAlignmentState?: TranslationAlignmentHostState;
  persistHostState?: () => Promise<void>;
  isWorkflowSuspended?: () => boolean;
  resumeWorkflow?: () => Promise<void>;
  readInterfaceContext?: () => YnInterfaceContextSnapshot;
}

interface YnDomainAgentTool extends AgentTool {
  requiresSourceManifest?: true;
  restoreWorkflowBeforeSourceManifest?: true;
}

const WORKSPACE_GLOSSARY = "AI_translation/_workspace/glossary_candidates.json";
const WORKSPACE_CHARACTER_BIBLE = "AI_translation/_workspace/character_bible.md";
const MAX_TOOL_RESULT_COLLECTION_ITEMS = 12;
const MAX_TRANSLATION_REVIEW_NOTES_PER_LINE = 3;

function canonicalTranslationReviewCode(value: string): string {
  const token = value.trim().toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (!token) return "other";
  if (
    /(?:^|_)(?:line_identity|misalign(?:ment|ed)?|align(?:ment)?|neighbor(?:ing)?_shift|shift(?:ed)?|line_shift|line_merge|merged_line|line_split|split_line|omission|missing_line|extra_line|duplicate_translation)(?:_|$)/u
      .test(token)
  ) return "line_identity";
  if (/(?:^|_)(?:placeholder|template|generic|meta_text|ai_pollution)(?:_|$)/u.test(token)) {
    return "placeholder_or_meta";
  }
  if (/(?:^|_)(?:untranslated|not_translated|source_copy|source_residue|wrong_target_language)(?:_|$)/u.test(token)) {
    return "untranslated_or_source_residue";
  }
  if (/(?:^|_)(?:terminology|glossary|proper_name|named_term)(?:_|$)/u.test(token)) return "terminology";
  if (/(?:^|_)(?:mistranslation|semantic|meaning|accuracy|incorrect_translation)(?:_|$)/u.test(token)) {
    return "semantic_mistranslation";
  }
  if (/(?:^|_)(?:format|control_code|tag|variable)(?:_|$)/u.test(token)) return "format_or_control_code";
  return token.slice(0, 80);
}

function reopenMalformedTranslationReviewEvidence(scope: TranslationAlignmentRangeState): boolean {
  let changed = false;
  for (const check of scope.checks) {
    if (
      check.verdict === "misaligned"
      && !isActionableTranslationAlignmentReason(check.reason)
    ) {
      delete check.verdict;
      delete check.reason;
      changed = true;
    }
  }
  return changed;
}

function proofreadCandidateIdentity(candidate: {
  source: string;
  target: string;
  category: string;
}): string {
  return [candidate.source, candidate.target, candidate.category]
    .map((value) => value.trim().normalize("NFC"))
    .join("\0");
}

function registerProofreadGlossaryCandidates(
  documentState: ReturnType<typeof proofreadDocumentHostState>,
  results: PiProofreadSubagentResult[]
): ProofreadGlossaryCandidateState[] {
  const byIdentity = new Map(documentState.glossaryCandidates.map((candidate) => [
    proofreadCandidateIdentity(candidate),
    candidate
  ]));
  const added: ProofreadGlossaryCandidateState[] = [];
  for (const candidate of results.flatMap((result) => result.glossaryCandidates)) {
    const identity = proofreadCandidateIdentity(candidate);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.aliases = [...new Set([...(existing.aliases ?? []), ...(candidate.aliases ?? [])])];
      continue;
    }
    const registered: ProofreadGlossaryCandidateState = {
      id: `proofread-term-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      source: candidate.source.trim().normalize("NFC"),
      target: candidate.target.trim().normalize("NFC"),
      category: candidate.category,
      evidenceLine: candidate.evidenceLine,
      rationale: candidate.rationale.trim(),
      ...(candidate.aliases?.length ? { aliases: [...new Set(candidate.aliases.map((alias) => alias.trim().normalize("NFC")))] } : {}),
      status: "pending"
    };
    documentState.glossaryCandidates.push(registered);
    byIdentity.set(identity, registered);
    added.push(registered);
  }
  return added;
}

type ProofreadCandidateOccurrence = ProofreadGlossaryCandidateState & {
  documentId?: string;
};

function summarizeProofreadGlossaryCandidates(
  candidates: ProofreadCandidateOccurrence[]
) {
  const grouped = new Map<string, {
    candidate: ProofreadGlossaryCandidateState;
    aliases: Set<string>;
    documents: Set<string>;
    occurrenceCount: number;
    evidenceSamples: Array<{ documentId?: string; evidenceLine: number; rationale: string }>;
  }>();
  for (const occurrence of candidates) {
    const existing = grouped.get(occurrence.id);
    if (existing) {
      if (
        proofreadCandidateIdentity(existing.candidate) !== proofreadCandidateIdentity(occurrence)
        || existing.candidate.status !== occurrence.status
      ) {
        throw new Error(
          `Proofreading glossary candidate ${occurrence.id} has inconsistent identity or status across documents.`
        );
      }
      existing.occurrenceCount += 1;
      for (const alias of occurrence.aliases ?? []) existing.aliases.add(alias);
      if (occurrence.documentId) existing.documents.add(occurrence.documentId);
      if (existing.evidenceSamples.length < 3) {
        existing.evidenceSamples.push({
          ...(occurrence.documentId ? { documentId: occurrence.documentId } : {}),
          evidenceLine: occurrence.evidenceLine,
          rationale: occurrence.rationale
        });
      }
      continue;
    }
    grouped.set(occurrence.id, {
      candidate: occurrence,
      aliases: new Set(occurrence.aliases ?? []),
      documents: new Set(occurrence.documentId ? [occurrence.documentId] : []),
      occurrenceCount: 1,
      evidenceSamples: [{
        ...(occurrence.documentId ? { documentId: occurrence.documentId } : {}),
        evidenceLine: occurrence.evidenceLine,
        rationale: occurrence.rationale
      }]
    });
  }
  return [...grouped.values()].map((group) => ({
    id: group.candidate.id,
    source: group.candidate.source,
    target: group.candidate.target,
    category: group.candidate.category,
    ...(group.aliases.size > 0 ? { aliases: [...group.aliases] } : {}),
    status: group.candidate.status,
    ...(group.candidate.decisionRationale
      ? { decisionRationale: group.candidate.decisionRationale }
      : {}),
    occurrenceCount: group.occurrenceCount,
    documentCount: group.documents.size || 1,
    evidenceSamples: group.evidenceSamples
  }));
}

function pendingProofreadGlossaryCandidateEvidence(
  candidates: ProofreadCandidateOccurrence[]
): PiProofreadPendingGlossaryCandidate[] {
  return summarizeProofreadGlossaryCandidates(candidates)
    .filter((candidate) => candidate.status === "pending")
    .map((candidate) => ({
      id: candidate.id,
      source: candidate.source,
      target: candidate.target,
      category: candidate.category,
      ...(candidate.aliases ? { aliases: candidate.aliases } : {}),
      rationale: candidate.evidenceSamples[0]?.rationale ?? "Pending proofread candidate",
      occurrenceCount: candidate.occurrenceCount
    }));
}

interface ProofreadPrescanSnapshot {
  inputHash: string;
  translationPath: string;
  signals: ProofreadDeterministicSignal[];
  summary: ProofreadPrescanSummary;
}

function proofreadInputHash(
  sourceText: string,
  translationText: string,
  validationOptions: ValidationOptions,
  auditWhitelistLines: number[],
  assets: ProjectAssets
): string {
  return createHash("sha256")
    .update(sourceText)
    .update("\0")
    .update(translationText)
    .update("\0")
    .update(JSON.stringify({
      locale: validationOptions.locale,
      languagePair: validationOptions.languagePair,
      sourceLanguage: validationOptions.sourceLanguage,
      detectUntranslated: validationOptions.detectUntranslated,
      glossaryEntries: validationOptions.glossaryEntries ?? [],
      characterEntries: validationOptions.characterEntries ?? [],
      styleForbiddenTerms: validationOptions.styleForbiddenTerms ?? [],
      auditWhitelistLines: [...auditWhitelistLines].sort((left, right) => left - right),
      projectAssets: {
        glossary: assets.glossary.entries,
        characterBible: assets.characterBible.source,
        styleGuide: assets.styleGuide
      }
    }))
    .digest("hex");
}

function configuredSubagentMaximum(
  request: PiSessionPromptRequest,
  domainRun?: YnDomainRunContract
): number {
  const configured = domainRun?.configuredSubagents;
  return Number.isInteger(configured) && configured! >= 0
    ? configured!
    : resolveWorkflowSubagentCount(request.subagentEnabled, request.subagentCount);
}

function effectiveSubagentCount(
  request: PiSessionPromptRequest,
  totalLines: number,
  domainRun?: YnDomainRunContract
): number {
  if (totalLines === 1) return 0;
  return Math.min(totalLines, configuredSubagentMaximum(request, domainRun));
}

function effectiveTranslationReviewWorkerCount(
  request: PiSessionPromptRequest,
  translationWorkerCount: number,
  assignmentCount: number
): number {
  const configuredMaximum = request.reviewSubagentCount
    ?? resolveWorkflowSubagentCount(request.subagentEnabled, request.subagentCount);
  if (!Number.isInteger(configuredMaximum) || configuredMaximum < 1) {
    throw new Error(`reviewSubagentCount must be a positive integer, received ${configuredMaximum}.`);
  }
  return Math.min(configuredMaximum, translationWorkerCount, assignmentCount);
}

function translationDiscoveryCompletionContextFromRecords(records: YnTranslationDiscoveryRecord[]) {
  const glossaryCount = records.filter((record) => record.kind === "glossary").length;
  const characterCount = records.length - glossaryCount;
  const count = records.length;
  if (count === 0) {
    return {
      content: "The children reported no new terminology or character facts for parent review.",
      details: { glossaryCount: 0, characterCount: 0, conflictCount: 0 }
    };
  }
  const targetsBySource = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.kind !== "glossary") continue;
    const targets = targetsBySource.get(record.source) ?? new Set<string>();
    targets.add(record.target);
    targetsBySource.set(record.source, targets);
  }
  const conflictCount = [...targetsBySource.values()].filter((targets) => targets.size > 1).length;
  return {
    content: [
      `CHILD DISCOVERY REPORT: ${glossaryCount} unresolved terminology record(s), `
        + `${characterCount} character fact(s), ${conflictCount} conflicting source term(s).`,
      "The full evidence is persisted in Host state. Page it with readTranslationDiscoveries and settle it with resolveTranslationDiscoveries before final completion; do not ask for or reprint the complete child payload.",
      "Merge duplicate proposals by source identity, resolve conflicting targets against approved project assets, and reject ordinary dictionary words or everyday phrases.",
      "For every unknown gender/pronoun or unresolved character fact, search project text and any relevant configured web reference before deciding. Never infer without evidence; retain unknown when research is inconclusive.",
      `Persist accepted changes only through ${WORKSPACE_GLOSSARY} and ${WORKSPACE_CHARACTER_BIBLE}, preserving their validated schemas.`
    ].join("\n"),
    details: { glossaryCount, characterCount, conflictCount }
  };
}

function translationAssignmentCounts(
  tasks: PiTranslationSubagentTask[],
  fallbackDocumentId: string,
  ownedDocumentIds: string[] = []
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const documentId of ownedDocumentIds) counts[documentId] = 0;
  for (const task of tasks) {
    const id = task.documentId?.trim() || fallbackDocumentId;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function translationDiscoverySliceHash(lines: string[], fromLine: number, toLine: number): string {
  return createHash("sha256")
    .update(JSON.stringify(lines.slice(fromLine - 1, toLine)))
    .digest("hex");
}

function translationBatchSettlements(args: {
  documentIds: string[];
  results: PiTranslationSubagentResult[];
  acceptedAssignmentCounts?: Record<string, number>;
  failures?: Array<{ documentId?: string; error: string }>;
  error?: unknown;
}) {
  const acceptedByDocument = new Map<string, number>();
  if (args.acceptedAssignmentCounts) {
    for (const [id, count] of Object.entries(args.acceptedAssignmentCounts)) {
      acceptedByDocument.set(id, count);
    }
  } else {
    for (const result of args.results) {
      const id = result.documentId?.trim();
      if (!id) continue;
      acceptedByDocument.set(id, (acceptedByDocument.get(id) ?? 0) + 1);
    }
  }
  const failuresByDocument = new Map<string, string[]>();
  for (const failure of args.failures ?? []) {
    const id = failure.documentId?.trim();
    if (!id) continue;
    const current = failuresByDocument.get(id) ?? [];
    current.push(failure.error);
    failuresByDocument.set(id, current);
  }
  const globalError = args.error instanceof Error ? args.error.message : args.error === undefined ? "" : String(args.error);
  if (globalError && failuresByDocument.size === 0) {
    for (const id of args.documentIds) failuresByDocument.set(id, [globalError]);
  }
  return args.documentIds.map((documentId) => {
    const errors = failuresByDocument.get(documentId) ?? [];
    return {
      documentId,
      acceptedResultCount: acceptedByDocument.get(documentId) ?? 0,
      failedResultCount: errors.length,
      ...(errors.length > 0 ? { error: [...new Set(errors)].join(" | ") } : {})
    };
  });
}

function translationDiscoveryRecords(args: {
  task: PiTranslationSubagentTask;
  result: PiTranslationSubagentResult;
  documentId: string;
  sourceLines: string[];
  candidateLines: string[];
  includeGlossaryCandidates: boolean;
  includeCharacterFacts: boolean;
}): YnTranslationDiscoveryRecord[] {
  const sourceHash = translationDiscoverySliceHash(args.sourceLines, args.task.fromLine, args.task.toLine);
  const candidateHash = translationDiscoverySliceHash(args.candidateLines, args.task.fromLine, args.task.toLine);
  const identity = {
    documentId: args.documentId,
    fromLine: args.task.fromLine,
    toLine: args.task.toLine,
    sourceHash,
    candidateHash
  };
  const withId = <T extends Omit<YnTranslationDiscoveryRecord, "id">>(record: T): T & { id: string } => ({
    ...record,
    id: createHash("sha256").update(JSON.stringify(record)).digest("hex")
  });
  return [
    ...(args.includeGlossaryCandidates ? args.result.discoveries.glossaryCandidates : []).map((discovery) => withId({
      ...identity,
      kind: "glossary" as const,
      ...discovery
    })),
    ...(args.includeCharacterFacts ? args.result.discoveries.characterFacts : []).map((discovery) => withId({
      ...identity,
      kind: "character" as const,
      ...discovery
    }))
  ];
}

function normalizeTranslationTerm(value: string): string {
  return value.trim().normalize("NFC");
}

function translationGlossaryGroups(
  records: YnTranslationDiscoveryRecord[]
): Map<string, Extract<YnTranslationDiscoveryRecord, { kind: "glossary" }>[]> {
  const groups = new Map<string, Extract<YnTranslationDiscoveryRecord, { kind: "glossary" }>[]>();
  for (const record of records) {
    if (record.kind !== "glossary") continue;
    const key = normalizeTranslationTerm(record.source);
    const current = groups.get(key) ?? [];
    current.push(record);
    groups.set(key, current);
  }
  return groups;
}

function createTranslationDiscoveryConflict(args: {
  batchId: string;
  source: string;
  records: Extract<YnTranslationDiscoveryRecord, { kind: "glossary" }>[];
  observedTargets: string[];
}): YnTranslationDiscoveryConflict {
  const observedTargets = [...new Set(args.observedTargets.map(normalizeTranslationTerm).filter(Boolean))];
  const affectedRanges = [...new Map(args.records.map((record) => [
    `${record.documentId}\0${record.fromLine}\0${record.toLine}\0${record.sourceHash}\0${record.candidateHash}`,
    {
      documentId: record.documentId,
      fromLine: record.fromLine,
      toLine: record.toLine,
      sourceHash: record.sourceHash,
      candidateHash: record.candidateHash
    }
  ])).values()];
  const identity = JSON.stringify({
    batchId: args.batchId,
    source: normalizeTranslationTerm(args.source),
    observedTargets,
    discoveryIds: args.records.map((record) => record.id).sort()
  });
  return {
    id: `translation-term-conflict-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
    batchId: args.batchId,
    source: normalizeTranslationTerm(args.source),
    observedTargets,
    discoveryIds: args.records.map((record) => record.id),
    documentIds: [...new Set(args.records.map((record) => record.documentId))],
    affectedRanges,
    status: "conflict"
  };
}

function translationTerminologyConflictMessage(
  batchId: string,
  conflicts: YnTranslationDiscoveryConflict[]
): AgentMessage {
  const compact = conflicts.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS).map((conflict) => ({
    source: conflict.source,
    observedTargets: conflict.observedTargets,
    documentIds: conflict.documentIds,
    affectedRanges: conflict.affectedRanges.map((range) => ({
      documentId: range.documentId,
      fromLine: range.fromLine,
      toLine: range.toLine
    }))
  }));
  return {
    role: "custom",
    customType: "translation-terminology-conflict",
    content: [
      `HOST WORKFLOW EVENT: translation batch ${batchId} is paused at the terminology commit gate.`,
      `${conflicts.length} source term(s) have incompatible observed targets. No conflicting target was written to glossary_candidates.json.`,
      JSON.stringify(compact),
      "Call readTranslationDiscoveries for full evidence, then resolveTranslationDiscoveries once per source. The Host will enqueue only the affected line repairs before reopening the existing assignment queue."
    ].join("\n"),
    display: false,
    details: {
      batchId,
      conflicts: compact,
      omittedConflictCount: Math.max(0, conflicts.length - compact.length),
      deliverAs: "followUp",
      triggerTurn: true
    },
    timestamp: Date.now()
  };
}
function textResult(value: unknown, details: unknown = value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details
  };
}

type TranslationReuseAuditSummary = Awaited<ReturnType<typeof getTranslationReuseAuditSummary>>;

function compactTranslationReuseAuditSummary(audits: TranslationReuseAuditSummary[]) {
  const decisionAudits = audits.filter((audit) => audit.status !== "applied");
  return {
    existingCandidateCount: audits.length,
    documentCount: audits.length,
    sourceLineCount: audits.reduce((total, audit) => total + audit.sourceLineCount, 0),
    pendingSemanticLineCount: audits.reduce((total, audit) => total + audit.pendingSemanticLineCount, 0),
    automaticallyReusableLineCount: audits.reduce(
      (total, audit) => total + audit.automaticallyReusableLineCount,
      0
    ),
    deterministicRetranslationLineCount: audits.reduce(
      (total, audit) => total + audit.deterministicRetranslationLineCount,
      0
    ),
    counts: {
      reuse: audits.reduce((total, audit) => total + audit.counts.reuse, 0),
      retranslate: audits.reduce((total, audit) => total + audit.counts.retranslate, 0)
    },
    auditingDocumentCount: audits.filter((audit) => audit.status === "auditing").length,
    readyForUserDecisionCount: audits.filter((audit) => audit.readyForUserDecision).length,
    appliedDocumentCount: audits.filter((audit) => audit.status === "applied").length,
    decisionDocumentCount: decisionAudits.length,
    allReadyForUserDecision: decisionAudits.length > 0
      && decisionAudits.every((audit) => audit.readyForUserDecision)
  };
}

function restoreMutableObject(target: object, snapshot: object): void {
  const mutable = target as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, structuredClone(snapshot));
}

function currentTranslationAlignmentRangeHash(
  scope: TranslationAlignmentRangeState,
  sourceLines: string[],
  candidateLines: string[],
  languagePair?: string
): string {
  const sourceSlice = sourceLines.slice(scope.fromLine - 1, scope.toLine);
  const candidateSlice = candidateLines.slice(scope.fromLine - 1, scope.toLine);
  return scope.lineHashVersion === 2
    ? translationAlignmentLinesInputHash(sourceSlice, candidateSlice, languagePair)
    : translationAlignmentInputHash(sourceSlice.join("\n"), candidateSlice.join("\n"), languagePair);
}

function scanResolvedTerminologyDebt(args: {
  documentId: string;
  sourceLines: string[];
  candidateLines: string[];
  terms: YnResolvedTranslationTerm[];
}): YnTranslationTerminologyDebt[] {
  const debt: YnTranslationTerminologyDebt[] = [];
  for (const term of args.terms) {
    const variants = [...new Set(term.observedTargets.map((value) => value.trim()).filter(Boolean))];
    if (variants.length < 2) continue;
    const competing = variants.filter((target) => target !== term.target);
    if (competing.length === 0) continue;
    for (const [index, sourceLine] of args.sourceLines.entries()) {
      if (!sourceLine.includes(term.source)) continue;
      const candidateLine = args.candidateLines[index] ?? "";
      const observedTargets = competing.filter((target) => candidateLine.includes(target));
      if (observedTargets.length === 0) continue;
      debt.push({
        documentId: args.documentId,
        line: index + 1,
        source: term.source,
        expectedTarget: term.target,
        observedTargets
      });
    }
  }
  return debt;
}

interface ConfiguredModelCatalogQuery {
  providerId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}

export function compactConfiguredModelCatalog(
  models: PiConfiguredModel[],
  input: ConfiguredModelCatalogQuery
) {
  const providers = new Map<string, {
    providerId: string;
    providerName: string;
    authenticated: boolean;
    modelCount: number;
  }>();
  for (const model of models) {
    const existing = providers.get(model.providerId);
    if (existing) {
      existing.modelCount += 1;
      existing.authenticated ||= model.authenticated;
    } else {
      providers.set(model.providerId, {
        providerId: model.providerId,
        providerName: model.providerName,
        authenticated: model.authenticated,
        modelCount: 1
      });
    }
  }
  const providerId = input.providerId?.trim().toLowerCase();
  const query = input.query?.trim().toLowerCase();
  const filtered = models.filter((model) => (
    (!providerId || model.providerId.toLowerCase() === providerId)
    && (!query || [model.providerId, model.providerName, model.modelId, model.modelName]
      .some((value) => value.toLowerCase().includes(query)))
  ));
  const offset = Math.min(Math.max(0, input.offset ?? 0), filtered.length);
  const limit = Math.min(50, Math.max(1, input.limit ?? 25));
  const nextOffset = offset + limit < filtered.length ? offset + limit : undefined;
  return {
    providers: [...providers.values()],
    totalModels: filtered.length,
    offset,
    limit,
    models: filtered.slice(offset, offset + limit),
    ...(nextOffset === undefined ? {} : { nextOffset })
  };
}

const TRANSLATION_ALIGNMENT_PAGE_SIZE = 100;
const PARENT_LINE_READ_PAGE_SIZE = 512;

function translationAlignmentProgress(audit: TranslationAlignmentDocumentState) {
  const pending = audit.checks.filter((check) => !check.verdict);
  const page = pending.slice(0, TRANSLATION_ALIGNMENT_PAGE_SIZE);
  return {
    pendingCount: pending.length,
    pendingLines: page.map((check) => check.line),
    pendingChecks: page,
    hasMorePending: pending.length > page.length
  };
}

function sourcePath(request: PiBoundSourceRequest): string {
  const value = request.sourcePath?.trim();
  if (!value) throw new Error("This Pi session has no source document bound to it.");
  return path.resolve(value);
}

function documentId(request: PiBoundSourceRequest): string {
  return requestDocumentId(request);
}

function candidatePath(request: PiBoundSourceRequest): string {
  return resolveTranslationCandidatePath({
    outputDir: request.outputDir,
    sourcePaths: [sourcePath(request)],
    documentId: documentId(request)
  });
}

function proofreadTranslationPath(request: PiBoundSourceRequest, folderSource = false): string {
  if (folderSource) return candidatePath(request);
  const explicit = request.translationPath?.trim();
  return explicit ? path.resolve(explicit) : candidatePath(request);
}

function proofreadReportScope(
  request: PiBoundSourceRequest
): Parameters<typeof writeProofreadFindings>[0]["reportScope"] {
  const selection = request.sourceRootSelection ?? request.sourceSelection;
  return selection?.kind === "folder"
    ? { kind: "folder", sourcePath: path.resolve(selection.path) }
    : undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function normalizeRange(fromLine: number, toLine: number, totalLines: number) {
  const from = Math.floor(fromLine);
  const to = Math.floor(toLine);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from || to > totalLines) {
    throw new Error(`Invalid line range ${fromLine}-${toLine}; source has ${totalLines} lines.`);
  }
  return { fromLine: from, toLine: to };
}

function subtractCompletedProofreadScopes(
  tasks: PiProofreadSubagentTask[],
  completedScopes: ProofreadCompletedSplitScope[]
): PiProofreadSubagentTask[] {
  return tasks.flatMap((task) => {
    let remaining = [{ fromLine: task.fromLine, toLine: task.toLine }];
    for (const completed of completedScopes) {
      remaining = remaining.flatMap((range) => {
        if (completed.toLine < range.fromLine || completed.fromLine > range.toLine) return [range];
        const pieces: Array<{ fromLine: number; toLine: number }> = [];
        if (completed.fromLine > range.fromLine) {
          pieces.push({ fromLine: range.fromLine, toLine: completed.fromLine - 1 });
        }
        if (completed.toLine < range.toLine) {
          pieces.push({ fromLine: completed.toLine + 1, toLine: range.toLine });
        }
        return pieces;
      });
    }
    return remaining.map((range) => {
      const reviewLines = task.reviewLines?.filter((line) => (
        line >= range.fromLine && line <= range.toLine
      ));
      const sampledLines = task.sampledLines?.filter((line) => (
        line >= range.fromLine && line <= range.toLine
      ));
      return {
        ...task,
        ...range,
        label: (task.label ?? `Proofread L${task.fromLine}-L${task.toLine}`)
          .replace(/L\d+-L\d+/u, `L${range.fromLine}-L${range.toLine}`),
        checkpointSize: reviewLines?.length ?? sampledLines?.length ?? range.toLine - range.fromLine + 1,
        ...(reviewLines ? { reviewLines } : {}),
        ...(sampledLines ? { sampledLines } : {}),
        deterministicSignals: task.deterministicSignals?.filter((signal) => (
          signal.line >= range.fromLine && signal.line <= range.toLine
        ))
      };
    });
  });
}

function currentProofreadSplitScopes(
  documentState: ReturnType<typeof proofreadDocumentHostState>,
  inputHash: string,
  translationPath: string
): ProofreadCompletedSplitScope[] {
  const current = documentState.completedSplitScopes.filter((scope) => (
    scope.inputHash === inputHash && scope.translationPath === translationPath
  ));
  documentState.completedSplitScopes = current;
  return current;
}

function recordCompletedProofreadSplitScope(
  documentState: ReturnType<typeof proofreadDocumentHostState>,
  scope: ProofreadCompletedSplitScope
): void {
  const current = currentProofreadSplitScopes(documentState, scope.inputHash, scope.translationPath);
  const merged: ProofreadCompletedSplitScope[] = [];
  for (const candidate of [...current, scope]
    .sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine)) {
    const previous = merged.at(-1);
    if (previous && candidate.fromLine <= previous.toLine + 1) {
      previous.toLine = Math.max(previous.toLine, candidate.toLine);
    } else {
      merged.push({ ...candidate });
    }
  }
  documentState.completedSplitScopes = merged;
}

function parentLineReadRange(fromLine: number, toLine: number, totalLines: number) {
  const requested = normalizeRange(fromLine, toLine, totalLines);
  const pageToLine = Math.min(requested.toLine, requested.fromLine + PARENT_LINE_READ_PAGE_SIZE - 1);
  const hasMore = pageToLine < requested.toLine;
  return {
    fromLine: requested.fromLine,
    toLine: pageToLine,
    requestedToLine: requested.toLine,
    hasMore,
    ...(hasMore ? { nextFromLine: pageToLine + 1 } : {})
  };
}

function assertDomainWritePath(outputDir: string, requestedPath: string): string {
  const resolved = resolveProjectPath(outputDir, requestedPath);
  const relative = relativeProjectPath(outputDir, resolved).replace(/\\/g, "/");
  const comparable = relative.toLowerCase();
  if (comparable.startsWith("report/")) {
    throw new Error("Proofreading reports are host-owned; use writeProofreadFindings instead of a generic project write.");
  }
  const allowed = ["AI_translation/_workspace/", "settings/"];
  if (!allowed.some((prefix) => comparable.startsWith(prefix.toLowerCase()))) {
    throw new Error(`Direct writes are restricted to ${allowed.join(", ")}. Use writeTranslationChunk for translated text.`);
  }
  if (comparable === WORKSPACE_GLOSSARY.toLowerCase()) return WORKSPACE_GLOSSARY;
  if (comparable === WORKSPACE_CHARACTER_BIBLE.toLowerCase()) return WORKSPACE_CHARACTER_BIBLE;
  return relative;
}

function validateSubagentTasks(
  tasks: PiTranslationSubagentTask[],
  totalLines: number,
  request: PiSessionPromptRequest,
  domainRun?: YnDomainRunContract
): PiTranslationSubagentTask[] {
  const maximumCount = effectiveSubagentCount(request, totalLines, domainRun);
  if (maximumCount === 0) {
    throw new Error("Subagents are disabled for this workflow; the parent Agent must complete it directly.");
  }
  if (tasks.length < 1) throw new Error("A translation worker queue requires at least one assignment.");
  const normalized = tasks.map((task) => ({
    ...task,
    ...normalizeRange(task.fromLine, task.toLine, totalLines)
  })).sort((a, b) => a.fromLine - b.fromLine);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].fromLine <= normalized[index - 1].toLine) {
      throw new Error(`Subagent ranges overlap: ${normalized[index - 1].fromLine}-${normalized[index - 1].toLine} and ${normalized[index].fromLine}-${normalized[index].toLine}.`);
    }
  }
  const coversWholeSource = normalized[0].fromLine === 1
    && normalized.at(-1)?.toLine === totalLines
    && normalized.every((task, index) => index === 0 || task.fromLine === normalized[index - 1].toLine + 1);
  if (!coversWholeSource && domainRun?.fullWorkflow !== false) {
    throw new Error("The accepted subagent ranges must cover every source line exactly once.");
  }
  return normalized;
}

function applySubagentModelDefaults<T extends { providerId?: string; modelId?: string }>(
  tasks: T[],
  request: PiSessionPromptRequest
): T[] {
  const providerId = request.subagentProviderId?.trim();
  const modelId = request.subagentModelId?.trim();
  if (Boolean(providerId) !== Boolean(modelId)) {
    throw new Error("Subagent model selection requires both providerId and modelId.");
  }
  return tasks.map((task) => {
    const taskProviderId = task.providerId?.trim();
    const taskModelId = task.modelId?.trim();
    if (!taskProviderId && taskModelId) {
      throw new Error("A subagent task model override requires a providerId.");
    }
    if (taskProviderId && !taskModelId) {
      // A provider-only task means that Pi should use that provider's configured
      // default model. It must not silently combine the task provider with the
      // parent model.
      return {
        ...task,
        providerId: taskProviderId,
        modelId: undefined
      };
    }
    return {
      ...task,
      providerId: taskProviderId || providerId,
      modelId: taskModelId || modelId
    };
  });
}

type TranslationSubagentTaskInput = Omit<PiTranslationSubagentTask, "fromLine" | "toLine"> & {
  fromLine?: number;
  toLine?: number;
};

function normalizeTranslationTasks(
  input: TranslationSubagentTaskInput[] | undefined,
  manifest: PiSourceManifest,
  totalLines: number,
  request: PiBoundSourceRequest,
  domainRun?: YnDomainRunContract
): PiTranslationSubagentTask[] {
  if (manifest.kind !== "folder") {
    if (!input) throw new Error("Translation subagent ranges are required for a single source file.");
    return validateSubagentTasks(input as PiTranslationSubagentTask[], totalLines, request, domainRun);
  }

  throw new Error(
    "Folder translation assignments are host-owned. Call runTranslationSubagents without tasks so file order, split size, and dynamic worker scheduling cannot be bypassed."
  );
}

export function createYnDomainTools(context: YnDomainToolContext): AgentTool[] {
  const baseRequest = context.request;
  const glossaryCandidateCollectionEnabled = baseRequest.glossaryCandidates !== false;
  const characterFactCollectionEnabled = baseRequest.characterBible !== false;
  const recoveryPauseIdAtToolCreation = context.domainRun?.recoveryPauseId;
  const webReferences = context.webReferences ?? webReferenceService;
  let request: PiBoundSourceRequest = baseRequest;
  let manifest: PiSourceManifest | undefined;
  let manifestPromise: Promise<PiSourceManifest> | undefined;
  let folderStages: Map<string, number> | undefined;
  const proofreadState = context.proofreadState ?? createProofreadHostState();
  const translationAlignmentState = context.translationAlignmentState ?? createTranslationAlignmentHostState();
  const sourceLinesRead = new Set<string>();
  const translationLinesRead = new Set<string>();
  let activeTranslationChunkReview: {
    auditId: string;
    documentId: string;
    bound: PiBoundSourceRequest;
  } | undefined;
  const assertParentOwnsAlignmentReview = (): void => {
    const hasPendingBoundedMutation = (translationAlignmentState.ranges[documentId(request)] ?? [])
      .some((scope) => scope.auditId.startsWith("alignment-mutation-")
        && scope.checks.some((check) => !check.verdict || check.verdict === "misaligned"));
    if (
      context.domainRun?.fullWorkflow === true
      && context.domainRun.maximumSubagentsForActiveDocument > 0
      && !hasPendingBoundedMutation
    ) {
      throw new Error(
        "Chunk alignment review is owned by the read-only translation-review Pi pool in this full workflow. The parent may only run the final whole-artifact validation."
      );
    }
  };
  const alignmentReadKey = (currentDocumentId: string, line: number) => `${currentDocumentId}\0${line}`;
  const proofreadSampledLines = new Map<string, Set<number>>();
  const proofreadPrescans = new Map<string, ProofreadPrescanSnapshot>();
  const sampledLinesFor = (currentDocumentId: string): Set<number> => {
    let sampled = proofreadSampledLines.get(currentDocumentId);
    if (!sampled) {
      sampled = new Set(proofreadDocumentHostState(proofreadState, currentDocumentId).sampledLines);
      proofreadSampledLines.set(currentDocumentId, sampled);
    }
    return sampled;
  };
  const invalidateProofreadState = (currentDocumentId: string): void => {
    proofreadPrescans.delete(currentDocumentId);
    proofreadSampledLines.delete(currentDocumentId);
    delete proofreadState.documents[currentDocumentId];
    context.domainRun?.invalidateProofreadPrescan(currentDocumentId);
  };
  const refreshProofreadPrescanAfterBoundedMutation = async (
    bound: PiBoundSourceRequest,
    changedRange: { fromLine: number; toLine: number }
  ): Promise<void> => {
    const currentDocumentId = documentId(bound);
    const persistedDocument = proofreadState.documents[currentDocumentId];
    if (!persistedDocument?.prescan) return;
    const sourceLines = splitTextLines(await readFile(sourcePath(bound), "utf8"));
    const translationPath = proofreadTranslationPath(bound, manifest?.kind === "folder");
    const translationLines = splitTextLines(await readFile(translationPath, "utf8"));
    if (sourceLines.length !== translationLines.length) {
      throw new Error(
        `The bounded repair broke proofreading alignment for ${currentDocumentId}: `
        + `${sourceLines.length} source lines and ${translationLines.length} translation lines.`
      );
    }
    const validationOptions = await createYnTranslationValidationOptions(bound);
    const assets = await readProjectAssets({ outputDir: bound.outputDir });
    const auditWhitelistLines = new Set(bound.auditWhitelistLines ?? []);
    const signals = buildProofreadDeterministicSignals({
      sourceText: sourceLines.join("\n"),
      translationText: translationLines.join("\n"),
      validationOptions
    }).filter((signal) => !auditWhitelistLines.has(signal.line));
    const inputHash = proofreadInputHash(
      sourceLines.join("\n"),
      translationLines.join("\n"),
      validationOptions,
      bound.auditWhitelistLines ?? [],
      assets
    );
    const summary = summarizeProofreadDeterministicSignals({
      signals,
      totalLines: sourceLines.length,
      maximumWorkers: effectiveSubagentCount(bound, sourceLines.length, context.domainRun)
    });
    const refreshed = { inputHash, translationPath, signals, summary };
    proofreadPrescans.set(currentDocumentId, refreshed);
    persistedDocument.prescan = { inputHash, translationPath, summary };
    for (const [scopeId, scope] of Object.entries(proofreadState.localScopes)) {
      if (
        scope.documentId === currentDocumentId
        && scope.fromLine <= changedRange.toLine
        && scope.toLine >= changedRange.fromLine
      ) {
        delete proofreadState.localScopes[scopeId];
      }
    }
  };
  const translationReuseAudits = new Map<string, {
    auditId: string;
    status: "auditing" | "awaiting_user_decision" | "applied";
    readyForUserDecision: boolean;
    appliedFullyReused?: boolean;
    appliedEvidence?: AppliedTranslationReuseAuditEvidence;
  }>();
  let settledTranslationReuseAuditSummary: ReturnType<typeof compactTranslationReuseAuditSummary> | undefined;
  const refreshTranslationReuseAudits = async (documents: PiSourceManifest["documents"]) => {
    const preparedDocuments = [];
    for (const document of documents) {
      const bound = bindPiSourceDocument(baseRequest, document);
      const candidate = candidatePath(bound);
      if (!await exists(candidate)) continue;
      const candidateText = await readFile(candidate, "utf8");
      if (!splitTextLines(candidateText).some((line) => line.trim())) continue;
      preparedDocuments.push({
        document,
        input: {
          outputDir: bound.outputDir,
          ownerSessionId: baseRequest.sessionId,
          sourcePath: sourcePath(bound),
          candidatePath: candidate,
          documentId: document.id,
          languagePair: bound.languagePair,
          validationOptions: await createYnTranslationValidationOptions(bound)
        }
      });
    }
    const audits = await prepareTranslationReuseAudits(preparedDocuments.map((prepared) => prepared.input));
    for (const [index, prepared] of audits.entries()) {
      const { document } = preparedDocuments[index];
      const previousAudit = translationReuseAudits.get(document.id);
      translationReuseAudits.set(document.id, {
        auditId: prepared.auditId,
        status: prepared.status,
        readyForUserDecision: prepared.readyForUserDecision,
        appliedFullyReused: prepared.appliedFullyReused
      });
      if (prepared.status === "applied" && previousAudit?.status !== "applied") {
        context.domainRun?.restoreAppliedTranslationReuseDecision(
          document.id,
          prepared.appliedFullyReused === true
        );
        context.domainRun?.recordTranslationArtifactMutation(document.id);
      }
    }
    return audits;
  };
  const planAppliedReuseAssignments = async (
    resolvedManifest: PiSourceManifest
  ): Promise<PiTranslationSubagentTask[] | undefined> => {
    if (baseRequest.reuseExistingTranslation !== true) return undefined;
    const splitSize = Math.max(1, baseRequest.translationSplitSize ?? YN_DEFAULT_SPLIT_SIZE);
    const persistedAppliedAudits = await listAppliedTranslationReuseAudits(
      baseRequest.outputDir,
      baseRequest.sessionId
    );
    for (const audit of persistedAppliedAudits) {
      translationReuseAudits.set(audit.documentId, {
        auditId: audit.auditId,
        status: "applied",
        readyForUserDecision: false,
        appliedFullyReused: audit.appliedFullyReused,
        appliedEvidence: audit
      });
    }
    const appliedDocuments = new Map(persistedAppliedAudits.map((audit) => [audit.documentId, audit]));
    if (appliedDocuments.size === 0) return undefined;

    const plannedByDocument = new Map<string, PiTranslationSubagentTask[]>();
    let prunedStaleReviewEvidence = false;
    for (const document of resolvedManifest.documents) {
      const audit = appliedDocuments.get(document.id);
      if (!audit) continue;
      const bound = bindPiSourceDocument(baseRequest, document);
      const candidate = candidatePath(bound);
      const [sourceText, candidateText] = await Promise.all([
        readFile(sourcePath(bound), "utf8"),
        readFile(candidate, "utf8")
      ]);
      const sourceLines = splitTextLines(sourceText);
      const candidateLines = splitTextLines(candidateText);
      const existingScopes = [...(translationAlignmentState.ranges[document.id] ?? [])]
        .sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine);
      const overlappingScopes = new Set<TranslationAlignmentRangeState>();
      for (let index = 1; index < existingScopes.length; index += 1) {
        if (existingScopes[index].fromLine <= existingScopes[index - 1].toLine) {
          overlappingScopes.add(existingScopes[index - 1]);
          overlappingScopes.add(existingScopes[index]);
        }
      }
      const currentScopes = sourceLines.length === candidateLines.length
        ? existingScopes.filter((scope) => (
            !overlappingScopes.has(scope)
            && scope.candidatePath === candidate
            && scope.sourceLineCount === sourceLines.length
            && scope.inputHash === currentTranslationAlignmentRangeHash(
              scope,
              sourceLines,
              candidateLines,
              bound.languagePair
            )
          ))
        : [];
      if (currentScopes.length !== existingScopes.length) {
        prunedStaleReviewEvidence = true;
        if (currentScopes.length > 0) translationAlignmentState.ranges[document.id] = currentScopes;
        else delete translationAlignmentState.ranges[document.id];
      }
      const relevantScopes = currentScopes.filter((scope) => (
        audit.retranslationLines.some((line) => line >= scope.fromLine && line <= scope.toLine)
      ));
      const excludedLines = relevantScopes.flatMap((scope) => (
        audit.retranslationLines.filter((line) => line >= scope.fromLine && line <= scope.toLine)
      ));
      const reviewTasks = relevantScopes.flatMap((scope): PiTranslationSubagentTask[] => {
        if (reopenMalformedTranslationReviewEvidence(scope)) {
          prunedStaleReviewEvidence = true;
        }
        const pending = scope.checks.some((check) => !check.verdict);
        const feedback = scope.checks
          .filter((check) => check.verdict === "misaligned")
          .map((check) => ({
            line: check.line,
            reason: check.reason!.trim()
          }));
        if (!pending && feedback.length === 0) return [];
        return [{
          documentId: document.id,
          fromLine: scope.fromLine,
          toLine: scope.toLine,
          label: pending
            ? `Resume interrupted review ${document.id} L${scope.fromLine}-${scope.toLine}`
            : `Repair reviewed ${document.id} L${scope.fromLine}-${scope.toLine}`,
          ...(pending ? { reviewOnly: true as const } : { reviewFeedback: feedback }),
          ...(folderStages?.has(document.id) ? { scheduleStage: folderStages.get(document.id) } : {})
        }];
      });
      const ranges = audit.appliedFullyReused
        ? []
        : await planAppliedTranslationReuseTasks({
            outputDir: baseRequest.outputDir,
            ownerSessionId: baseRequest.sessionId,
            auditId: audit.auditId,
            documentId: document.id,
            maxLinesPerTask: splitSize,
            excludedLines
          });
      plannedByDocument.set(document.id, [
        ...reviewTasks,
        ...ranges.map((range) => ({
          ...range,
          label: `Retranslate ${document.id} L${range.fromLine}-${range.toLine}`,
          ...(folderStages?.has(document.id) ? { scheduleStage: folderStages.get(document.id) } : {})
        }))
      ].sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine));
    }
    if (prunedStaleReviewEvidence) await context.persistHostState?.();

    if (resolvedManifest.kind !== "folder") {
      return plannedByDocument.get(resolvedManifest.documents[0].id);
    }
    const ordinary = planFolderTranslationTasks({
      documents: resolvedManifest.documents,
      splitSize,
      order: baseRequest.folderTranslationOrder
    });
    return resolvedManifest.documents.flatMap((document) => (
      plannedByDocument.has(document.id)
        ? plannedByDocument.get(document.id)!
        : ordinary.filter((task) => task.documentId === document.id)
    ));
  };
  const markTranslationReuseAuditsReady = () => {
    const pendingAudits = [...translationReuseAudits.values()]
      .filter((audit) => audit.status !== "applied");
    if (
      pendingAudits.length > 0
      && pendingAudits.every((audit) => audit.status === "awaiting_user_decision")
    ) {
      context.domainRun?.recordTranslationReuseAuditReady(pendingAudits.map((audit) => audit.auditId));
    }
  };
  const assertTranslationReuseAuditEnabled = () => {
    if (baseRequest.reuseExistingTranslation !== true) {
      throw new Error("Translation reuse audit is disabled for this run; start clean retranslation instead.");
    }
    if (context.domainRun?.fullWorkflow !== true || context.domainRun.kind !== "translation") {
      throw new Error("Translation reuse audit requires the exact generated translation workflow contract.");
    }
  };
  const prepareExistingTranslationForWrite = async (bound: PiBoundSourceRequest): Promise<void> => {
    if (context.domainRun?.fullWorkflow !== true) return;
    const currentDocumentId = documentId(bound);
    if (context.domainRun.ownsCurrentTranslationArtifact(currentDocumentId)) return;
    const candidate = candidatePath(bound);
    if (!await exists(candidate)) return;
    const candidateText = await readFile(candidate, "utf8");
    if (!splitTextLines(candidateText).some((line) => line.trim())) return;
    if (baseRequest.reuseExistingTranslation === true) {
      const audit = translationReuseAudits.get(currentDocumentId);
      if (!audit) {
        throw new Error(
          `Existing translation work in ${currentDocumentId} has not been audited. Call prepareTranslationReuseAudit before writing or starting translation workers.`
        );
      }
      if (audit.status !== "applied") {
        throw new Error(
          `Existing translation work in ${currentDocumentId} is awaiting semantic audit or the user's reuse decision; do not change it yet.`
        );
      }
      return;
    }
    const discarded = await discardTranslationCandidateForRetranslation({
      outputDir: bound.outputDir,
      sourcePath: sourcePath(bound),
      candidatePath: candidate,
      documentId: currentDocumentId
    });
    if (discarded.discarded) {
      context.domainRun.recordTranslationArtifactMutation(currentDocumentId);
    }
  };
  const ensureManifest = () => {
    manifestPromise ??= resolvePiSourceManifest(baseRequest).then((resolvedManifest) => {
      const useWorkflowOrder = resolvedManifest.kind === "folder"
        && context.domainRun?.fullWorkflow !== false;
      const retainedDocumentIds = useWorkflowOrder
        ? parseFolderTranslationOrder(
            baseRequest.folderTranslationOrder,
            resolvedManifest.documents.map((entry) => entry.id)
          )
        : undefined;
      folderStages = retainedDocumentIds ?? (resolvedManifest.kind === "folder"
        ? new Map(resolvedManifest.documents.map((document) => [document.id, 0]))
        : undefined);
      const resolved = retainedDocumentIds
        ? {
            ...resolvedManifest,
            documents: resolvedManifest.documents
              .filter((document) => retainedDocumentIds!.has(document.id))
              .sort((left, right) => retainedDocumentIds!.get(left.id)! - retainedDocumentIds!.get(right.id)!)
          }
        : resolvedManifest;
      manifest = resolved;
      if (retainedDocumentIds) {
        const retained = new Set(resolved.documents.map((document) => document.id));
        for (const id of Object.keys(proofreadState.documents)) {
          if (!retained.has(id)) delete proofreadState.documents[id];
        }
        for (const [scopeId, scope] of Object.entries(proofreadState.localScopes)) {
          if (!retained.has(scope.documentId)) delete proofreadState.localScopes[scopeId];
        }
        for (const id of Object.keys(translationAlignmentState.documents)) {
          if (!retained.has(id)) delete translationAlignmentState.documents[id];
        }
        for (const id of Object.keys(translationAlignmentState.ranges)) {
          if (!retained.has(id)) delete translationAlignmentState.ranges[id];
        }
      }
      if (context.domainRun?.suspended !== true) {
        context.domainRun?.registerSourceManifest?.(resolved.documents.map((document) => ({
          id: document.id,
          sourceLineCount: document.lineCount,
          scheduleStage: folderStages?.get(document.id)
        })), { replace: context.domainRun.fullWorkflow === true });
      }
      const inherited = context.domainRun?.activeDocumentId;
      const selected = resolved.documents.find((document) => document.id === inherited) ?? resolved.documents[0];
      request = bindPiSourceDocument(baseRequest, selected);
      return resolved;
    });
    return manifestPromise;
  };
  const reserveSpecializedBatch = async (
    kind: "translation" | "proofread",
    batchId: string,
    start: {
      taskCount: number;
      workerCount: number;
      documentIds: string[];
      assignmentCounts?: Record<string, number>;
      readOnly?: boolean;
      workerCountContract?: "workflow" | "review_ceiling";
      workerCountCeiling?: number;
    }
  ): Promise<void> => {
    context.domainRun?.recordSubagentBatchStarted(kind, batchId, start);
    try {
      await context.persistHostState?.();
    } catch (error) {
      context.domainRun?.recordSubagentBatchStartFailure(kind, batchId, start.documentIds);
      throw error;
    }
  };
  const rollbackSpecializedBatch = async (
    kind: "translation" | "proofread",
    batchId: string,
    documentIds: string[]
  ): Promise<void> => {
    context.domainRun?.recordSubagentBatchStartFailure(kind, batchId, documentIds);
    await context.persistHostState?.();
  };
  const reserveGeneralBatch = async (batchId: string, taskCount: number): Promise<void> => {
    context.domainRun?.recordGeneralSubagentBatchStarted(batchId, taskCount);
    try {
      await context.persistHostState?.();
    } catch (error) {
      context.domainRun?.recordGeneralSubagentBatchFailure(
        batchId,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  };
  const rollbackGeneralBatch = async (batchId: string, error: unknown): Promise<void> => {
    context.domainRun?.recordGeneralSubagentBatchFailure(
      batchId,
      error instanceof Error ? error.message : String(error)
    );
    await context.persistHostState?.();
  };
  const selectDocument = (documentId: string): PiBoundSourceRequest => {
    const selected = manifest ? resolvePiSourceDocument(manifest, documentId) : undefined;
    if (!selected) throw new Error(`Source document ${documentId} is not in the host-resolved manifest.`);
    const nextRequest = bindPiSourceDocument(baseRequest, selected);
    context.domainRun?.selectDocument(selected.id);
    request = nextRequest;
    return request;
  };
  const boundForDocument = async (currentDocumentId: string): Promise<PiBoundSourceRequest> => {
    const resolvedManifest = await ensureManifest();
    const selected = resolvePiSourceDocument(resolvedManifest, currentDocumentId);
    if (!selected) throw new Error(`Source document ${currentDocumentId} is not in the host-resolved manifest.`);
    return bindPiSourceDocument(baseRequest, selected);
  };
  const prepareCurrentTranslationDiscoveryConflicts = async (
    resolvedManifest: PiSourceManifest
  ): Promise<YnTranslationDiscoveryConflict[]> => {
    const domainRun = context.domainRun;
    if (!glossaryCandidateCollectionEnabled) {
      if (!domainRun) return [];
      const glossaryDiscoveryIds = domainRun.pendingTranslationDiscoveries()
        .filter((record) => record.kind === "glossary")
        .map((record) => record.id);
      const conflicts = domainRun.pendingTranslationDiscoveryConflicts();
      const debt = domainRun.pendingTranslationTerminologyDebt();
      if (glossaryDiscoveryIds.length > 0 || conflicts.length > 0 || debt.length > 0) {
        await runWorkspaceGlossaryCandidateTransaction(request.outputDir, async () => {
          const rollbacks: Array<() => void> = [];
          if (glossaryDiscoveryIds.length > 0) {
            rollbacks.push(domainRun.resolveTranslationDiscoveries(glossaryDiscoveryIds, []));
          }
          if (conflicts.length > 0) {
            rollbacks.push(domainRun.replaceTranslationDiscoveryConflicts([]));
          }
          if (debt.length > 0) {
            rollbacks.push(domainRun.recordTranslationTerminologyDebt([]));
          }
          try {
            await context.persistHostState?.();
          } catch (error) {
            for (const rollback of rollbacks.reverse()) rollback();
            throw error;
          }
        });
      }
      domainRun.releaseTranslationTerminologyGate();
      return [];
    }
    const conflicts = domainRun?.pendingTranslationDiscoveryConflicts() ?? [];
    if (!domainRun || conflicts.length === 0) return conflicts;
    const documentsById = new Map(resolvedManifest.documents.map((document) => [document.id, document]));
    const lineCache = new Map<string, { sourceLines: string[]; candidateLines: string[] }>();
    const currentRange = async (range: YnTranslationDiscoveryConflict["affectedRanges"][number]): Promise<boolean> => {
      const document = documentsById.get(range.documentId);
      if (!document) return false;
      let lines = lineCache.get(range.documentId);
      if (!lines) {
        const bound = bindPiSourceDocument(baseRequest, document);
        lines = {
          sourceLines: splitTextLines(await readFile(sourcePath(bound), "utf8")),
          candidateLines: splitTextLines(await readOptional(candidatePath(bound)))
        };
        lineCache.set(range.documentId, lines);
      }
      return range.fromLine >= 1
        && range.toLine >= range.fromLine
        && range.toLine <= lines.sourceLines.length
        && range.toLine <= lines.candidateLines.length
        && translationDiscoverySliceHash(lines.sourceLines, range.fromLine, range.toLine) === range.sourceHash
        && translationDiscoverySliceHash(lines.candidateLines, range.fromLine, range.toLine) === range.candidateHash;
    };
    const pendingById = new Map(domainRun.pendingTranslationDiscoveries().map((record) => [record.id, record]));
    const currentConflicts: YnTranslationDiscoveryConflict[] = [];
    const staleDiscoveryIds = new Set<string>();
    for (const conflict of conflicts) {
      const currentRanges: YnTranslationDiscoveryConflict["affectedRanges"] = [];
      for (const range of conflict.affectedRanges) {
        if (await currentRange(range)) currentRanges.push(range);
      }
      const currentPendingIds: string[] = [];
      for (const discoveryId of conflict.discoveryIds) {
        const record = pendingById.get(discoveryId);
        if (!record) continue;
        if (await currentRange(record)) currentPendingIds.push(discoveryId);
        else staleDiscoveryIds.add(discoveryId);
      }
      if (currentRanges.length > 0 && currentPendingIds.length > 0) {
        currentConflicts.push({
          ...conflict,
          discoveryIds: currentPendingIds,
          documentIds: [...new Set(currentRanges.map((range) => range.documentId))],
          affectedRanges: currentRanges
        });
      } else {
        for (const discoveryId of conflict.discoveryIds) {
          if (pendingById.has(discoveryId)) staleDiscoveryIds.add(discoveryId);
        }
      }
    }
    if (
      staleDiscoveryIds.size === 0
      && JSON.stringify(currentConflicts) === JSON.stringify(conflicts)
    ) return currentConflicts;
    await runWorkspaceGlossaryCandidateTransaction(request.outputDir, async () => {
      const rollbacks: Array<() => void> = [];
      if (staleDiscoveryIds.size > 0) {
        rollbacks.push(domainRun.resolveTranslationDiscoveries([...staleDiscoveryIds], []));
      }
      const remainingIds = new Set(domainRun.pendingTranslationDiscoveries().map((record) => record.id));
      rollbacks.push(domainRun.replaceTranslationDiscoveryConflicts(currentConflicts
        .map((conflict) => ({
          ...conflict,
          discoveryIds: conflict.discoveryIds.filter((id) => remainingIds.has(id))
        }))
        .filter((conflict) => conflict.discoveryIds.length > 0)));
      try {
        await context.persistHostState?.();
      } catch (error) {
        for (const rollback of rollbacks.reverse()) rollback();
        throw error;
      }
    });
    if (domainRun.pendingTranslationDiscoveryConflicts().length === 0) {
      domainRun.releaseTranslationTerminologyGate();
    }
    return currentConflicts;
  };
  const planTranslationTerminologyRepairs = async (
    terms: YnResolvedTranslationTerm[]
  ): Promise<{
    debt: YnTranslationTerminologyDebt[];
    tasks: PiTranslationSubagentTask[];
  }> => {
    const observations = context.domainRun?.translationDiscoveryObservations() ?? [];
    const currentDocumentIds = new Set((await ensureManifest()).documents.map((document) => document.id));
    const debtByLine = new Map<string, YnTranslationTerminologyDebt>();
    const documentCache = new Map<string, { sourceLines: string[]; candidateLines: string[] }>();
    for (const term of terms) {
      const source = normalizeTranslationTerm(term.source);
      const expectedTarget = normalizeTranslationTerm(term.target);
      const competing = new Set(term.observedTargets
        .map(normalizeTranslationTerm)
        .filter((target) => target && target !== expectedTarget));
      if (competing.size === 0) continue;
      const matching = observations.filter((record): record is Extract<YnTranslationDiscoveryRecord, { kind: "glossary" }> => (
        record.kind === "glossary"
        && normalizeTranslationTerm(record.source) === source
        && competing.has(normalizeTranslationTerm(record.target))
      ));
      for (const record of matching) {
        if (!currentDocumentIds.has(record.documentId)) continue;
        let document = documentCache.get(record.documentId);
        if (!document) {
          const bound = await boundForDocument(record.documentId);
          document = {
            sourceLines: splitTextLines(await readFile(sourcePath(bound), "utf8")),
            candidateLines: splitTextLines(await readFile(candidatePath(bound), "utf8"))
          };
          documentCache.set(record.documentId, document);
        }
        if (
          record.fromLine < 1
          || record.toLine < record.fromLine
          || record.toLine > document.sourceLines.length
          || record.toLine > document.candidateLines.length
          || translationDiscoverySliceHash(document.sourceLines, record.fromLine, record.toLine) !== record.sourceHash
          || translationDiscoverySliceHash(document.candidateLines, record.fromLine, record.toLine) !== record.candidateHash
        ) continue;
        const observedTarget = normalizeTranslationTerm(record.target);
        for (let line = record.fromLine; line <= record.toLine; line += 1) {
          const sourceLine = document.sourceLines[line - 1] ?? "";
          const candidateLine = document.candidateLines[line - 1] ?? "";
          if (!sourceLine.includes(source) || !candidateLine.includes(observedTarget)) continue;
          const key = `${record.documentId}\0${line}\0${source}`;
          const existing = debtByLine.get(key);
          debtByLine.set(key, {
            documentId: record.documentId,
            line,
            source,
            expectedTarget,
            observedTargets: [...new Set([...(existing?.observedTargets ?? []), observedTarget])]
          });
        }
      }
    }
    const debt = [...debtByLine.values()].sort((left, right) => (
      left.documentId.localeCompare(right.documentId, "en") || left.line - right.line || left.source.localeCompare(right.source)
    ));
    const tasks = debt.map((item): PiTranslationSubagentTask => ({
        documentId: item.documentId,
        fromLine: item.line,
        toLine: item.line,
        label: `Repair terminology ${item.documentId} L${item.line}`,
        terminologyRepair: true,
        reviewFeedback: [{
          line: item.line,
          reason: `terminology: use ${item.expectedTarget} for ${item.source}; replace ${item.observedTargets.join(", ")}`
        }],
        ...(folderStages?.has(item.documentId) ? { scheduleStage: folderStages.get(item.documentId) } : {})
      }));
    return { debt, tasks };
  };
  const routeTranslationTerminologyRepairs = (
    tasks: PiTranslationSubagentTask[]
  ): Map<string, PiTranslationSubagentTask[]> => {
    const tasksByBatch = new Map<string, PiTranslationSubagentTask[]>();
    for (const task of tasks) {
      const batchId = context.subagents.translationPriorityBatchOwner(task);
      if (!batchId) continue;
      const current = tasksByBatch.get(batchId) ?? [];
      current.push(task);
      tasksByBatch.set(batchId, current);
    }
    return tasksByBatch;
  };
  const commitTranslationAssignmentDiscoveries = async (args: {
    batchId: string;
    records: YnTranslationDiscoveryRecord[];
    discoveries: PiTranslationDiscoveries;
  }): Promise<{ committedDiscoveries: PiTranslationDiscoveries; conflicts: YnTranslationDiscoveryConflict[] }> => {
    const domainRun = context.domainRun;
    const discoveries: PiTranslationDiscoveries = {
      glossaryCandidates: glossaryCandidateCollectionEnabled ? args.discoveries.glossaryCandidates : [],
      characterFacts: characterFactCollectionEnabled ? args.discoveries.characterFacts : []
    };
    const records = args.records.filter((record) => (
      record.kind === "glossary" ? glossaryCandidateCollectionEnabled : characterFactCollectionEnabled
    ));
    if (!domainRun || records.length === 0) {
      return { committedDiscoveries: discoveries, conflicts: [] };
    }
    return runWorkspaceGlossaryCandidateTransaction(request.outputDir, async (transaction) => {
    const rollbacks: Array<() => void | Promise<void>> = [];
    let candidateCommit: WorkspaceGlossaryCandidateCommit | undefined;
    let priorityTasksByBatch = new Map<string, PiTranslationSubagentTask[]>();
    let hostStatePersisted = false;
    try {
      rollbacks.push(domainRun.recordTranslationDiscoveries(records));
      const glossaryGroups = translationGlossaryGroups(records);
      const assets = glossaryGroups.size > 0
        ? await readProjectAssets({ outputDir: request.outputDir })
        : undefined;
      const formalBySource = new Map((assets?.glossary.entries ?? []).flatMap((entry) => {
        const source = normalizeTranslationTerm(String(entry.source ?? ""));
        const target = normalizeTranslationTerm(String(entry.target ?? ""));
        return source && target ? [[source, target] as const] : [];
      }));
      const priorTerms = new Map(domainRun.resolvedTranslationTerms().map((term) => [
        normalizeTranslationTerm(term.source),
        term
      ]));
      const candidateProposals: Array<{
        source: string;
        target: string;
        aliases: string[];
        info: string;
        status: "pending";
      }> = [];
      const autoTerms = new Map<string, YnResolvedTranslationTerm>();
      const autoIds = new Set<string>();
      const directConflicts: Array<{ source: string; targets: string[] }> = [];
      const formalSources = new Set<string>();
      for (const [source, records] of glossaryGroups) {
        const targets = [...new Set(records.map((record) => normalizeTranslationTerm(record.target)).filter(Boolean))];
        const prior = priorTerms.get(source);
        const observedTargets = [...new Set([...(prior?.observedTargets ?? []), ...(prior ? [prior.target] : []), ...targets])];
        const formalTarget = formalBySource.get(source);
        if (formalTarget) {
          formalSources.add(source);
          autoTerms.set(source, { source: records[0]!.source, target: formalTarget, observedTargets });
          records.forEach((record) => autoIds.add(record.id));
          continue;
        }
        if (prior && targets.some((target) => target !== normalizeTranslationTerm(prior.target))) {
          directConflicts.push({ source, targets: observedTargets });
          continue;
        }
        if (targets.length !== 1) {
          directConflicts.push({ source, targets: observedTargets });
          continue;
        }
        candidateProposals.push({
          source: records[0]!.source,
          target: targets[0]!,
          aliases: [...new Set(records.flatMap((record) => record.aliases ?? []).map(normalizeTranslationTerm))],
          info: `translation discovery: ${records[0]!.rationale.trim()}`,
          status: "pending"
        });
      }
      if (candidateProposals.length > 0 || formalSources.size > 0) {
        candidateCommit = await transaction.commit(
          candidateProposals,
          { removeSources: [...formalSources] }
        );
        rollbacks.push(() => candidateCommit!.rollback());
        for (const outcome of candidateCommit.outcomes) {
          if (outcome.status === "removed") continue;
          const records = glossaryGroups.get(normalizeTranslationTerm(outcome.source)) ?? [];
          const prior = priorTerms.get(normalizeTranslationTerm(outcome.source));
          if (outcome.status === "conflict") {
            directConflicts.push({
              source: outcome.source,
              targets: [...new Set([
                ...(prior?.observedTargets ?? []),
                ...(prior ? [prior.target] : []),
                outcome.existingTarget ?? "",
                outcome.target
              ].map(normalizeTranslationTerm).filter(Boolean))]
            });
            continue;
          }
          const observedTargets = [...new Set([
            ...(prior?.observedTargets ?? []),
            ...(prior ? [prior.target] : []),
            ...records.map((record) => normalizeTranslationTerm(record.target))
          ])];
          autoTerms.set(normalizeTranslationTerm(outcome.source), {
            source: records[0]?.source ?? outcome.source,
            target: outcome.target,
            observedTargets
          });
          records.forEach((record) => autoIds.add(record.id));
        }
      }
      const conflicts = directConflicts.map(({ source, targets }) => {
        const records = domainRun.translationDiscoveryObservations()
          .filter((record): record is Extract<YnTranslationDiscoveryRecord, { kind: "glossary" }> => (
            record.kind === "glossary" && normalizeTranslationTerm(record.source) === source
          ));
        return createTranslationDiscoveryConflict({
          batchId: args.batchId,
          source,
          records,
          observedTargets: targets
        });
      });
      if (conflicts.length > 0) {
        rollbacks.push(domainRun.recordTranslationDiscoveryConflicts(conflicts));
      }
      if (autoIds.size > 0) {
        rollbacks.push(domainRun.resolveTranslationDiscoveries([...autoIds], [...autoTerms.values()]));
      }
      const officialRepairTerms = [...autoTerms.values()].filter((term) => formalBySource.has(
        normalizeTranslationTerm(term.source)
      ));
      if (officialRepairTerms.length > 0) {
        const repairs = await planTranslationTerminologyRepairs(officialRepairTerms);
        const existingDebt = domainRun.pendingTranslationTerminologyDebt();
        rollbacks.push(domainRun.recordTranslationTerminologyDebt([...existingDebt, ...repairs.debt]));
        priorityTasksByBatch = routeTranslationTerminologyRepairs(repairs.tasks);
      }
      if (glossaryGroups.size > 0) await readWorkspaceAssetsStatus(request.outputDir);
      await context.persistHostState?.();
      hostStatePersisted = true;
      for (const [repairBatchId, repairTasks] of priorityTasksByBatch) {
        context.subagents.enqueueTranslationPriorityTasksIfActive(repairBatchId, repairTasks);
      }
      const committedSources = new Set(autoTerms.keys());
      return {
        committedDiscoveries: {
          glossaryCandidates: discoveries.glossaryCandidates.filter((entry) => (
            committedSources.has(normalizeTranslationTerm(entry.source))
          )),
          characterFacts: discoveries.characterFacts
        },
        conflicts
      };
    } catch (error) {
      if (hostStatePersisted) throw error;
      const rollbackErrors: unknown[] = [];
      for (const rollback of rollbacks.reverse()) {
        try {
          await rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "Translation discovery commit rollback failed.");
      }
      throw error;
    }
    });
  };
  const planOutstandingFolderTranslationTasks = async (
    resolvedManifest: PiSourceManifest
  ): Promise<PiTranslationSubagentTask[]> => {
    const planned = planFolderTranslationTasks({
      documents: resolvedManifest.documents,
      splitSize: request.translationSplitSize ?? YN_DEFAULT_SPLIT_SIZE,
      order: request.folderTranslationOrder
    });
    const ownedScopes = new Map<string, Array<{ fromLine: number; toLine: number }>>();
    const currentScopesByDocument = new Map<string, TranslationAlignmentRangeState[]>();
    const reviewTasks: PiTranslationSubagentTask[] = [];
    let prunedStaleEvidence = false;
    for (const document of resolvedManifest.documents) {
      const bound = bindPiSourceDocument(baseRequest, document);
      const candidate = candidatePath(bound);
      const sourceText = await readFile(sourcePath(bound), "utf8");
      const sourceLines = splitTextLines(sourceText);
      const existing = [...(translationAlignmentState.ranges[document.id] ?? [])]
        .sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine);
      const candidateLinesByPath = new Map<string, string[]>();
      for (const candidateSource of new Set(existing.map((scope) => path.resolve(scope.candidatePath)))) {
        if (
          candidateSource !== path.resolve(candidate)
          && !isTranslationStagingCandidatePath(bound.outputDir, candidateSource)
        ) continue;
        candidateLinesByPath.set(candidateSource, splitTextLines(await readOptional(candidateSource)));
      }
      const overlapping = new Set<TranslationAlignmentRangeState>();
      for (let index = 1; index < existing.length; index += 1) {
        if (existing[index].fromLine <= existing[index - 1].toLine) {
          overlapping.add(existing[index - 1]);
          overlapping.add(existing[index]);
        }
      }
      const current = existing.filter((scope) => {
        const candidateLines = candidateLinesByPath.get(path.resolve(scope.candidatePath));
        return Boolean(
          candidateLines
          && sourceLines.length === candidateLines.length
          && !overlapping.has(scope)
          && scope.fromLine >= 1
          && scope.toLine <= sourceLines.length
          && scope.sourceLineCount === sourceLines.length
          && scope.inputHash === currentTranslationAlignmentRangeHash(
            scope,
            sourceLines,
            candidateLines,
            bound.languagePair
          )
        );
      });
      if (current.length !== existing.length) {
        prunedStaleEvidence = true;
        if (current.length > 0) translationAlignmentState.ranges[document.id] = current;
        else delete translationAlignmentState.ranges[document.id];
      }
      currentScopesByDocument.set(document.id, current);
      if (current.length > 0) {
        ownedScopes.set(document.id, current.map((scope) => ({
          fromLine: scope.fromLine,
          toLine: scope.toLine
        })));
        for (const scope of current) {
          const stagingCandidatePath = path.resolve(scope.candidatePath) === path.resolve(candidate)
            ? undefined
            : scope.candidatePath;
          if (reopenMalformedTranslationReviewEvidence(scope)) {
            prunedStaleEvidence = true;
          }
          const pending = scope.checks.length === 0 || scope.checks.some((check) => !check.verdict);
          const feedback = scope.checks
            .filter((check) => check.verdict === "misaligned")
            .map((check) => ({
              line: check.line,
              reason: check.reason!.trim()
            }));
          if (!pending && feedback.length === 0 && !stagingCandidatePath) continue;
          reviewTasks.push({
            documentId: document.id,
            fromLine: scope.fromLine,
            toLine: scope.toLine,
            label: feedback.length > 0
              ? `Repair reviewed ${document.id} L${scope.fromLine}-${scope.toLine}`
              : pending
                ? `Resume interrupted review ${document.id} L${scope.fromLine}-${scope.toLine}`
                : `Promote accepted review ${document.id} L${scope.fromLine}-${scope.toLine}`,
            ...(feedback.length > 0
              ? { reviewFeedback: feedback }
              : pending
                ? { reviewOnly: true as const }
                : {}),
            ...(stagingCandidatePath ? { stagingCandidatePath } : {}),
            ...(folderStages?.has(document.id) ? { scheduleStage: folderStages.get(document.id) } : {})
          });
        }
      }
    }
    if (prunedStaleEvidence) await context.persistHostState?.();
    return [...reviewTasks, ...subtractCompletedTranslationRanges(planned, ownedScopes)];
  };
  const planPersistedTranslationTerminologyTasks = async (
    resolvedManifest: PiSourceManifest
  ): Promise<PiTranslationSubagentTask[]> => {
    if (!glossaryCandidateCollectionEnabled) return [];
    const domainRun = context.domainRun;
    const persistedDebt = domainRun?.pendingTranslationTerminologyDebt() ?? [];
    if (!domainRun || persistedDebt.length === 0) return [];

    const debtSources = new Set(persistedDebt.map((debt) => normalizeTranslationTerm(debt.source)));
    const terms = domainRun.resolvedTranslationTerms().filter((term) => (
      debtSources.has(normalizeTranslationTerm(term.source))
    ));
    const currentDebt: YnTranslationTerminologyDebt[] = [];
    for (const document of resolvedManifest.documents) {
      const bound = bindPiSourceDocument(baseRequest, document);
      const [sourceText, candidateText] = await Promise.all([
        readFile(sourcePath(bound), "utf8"),
        readOptional(candidatePath(bound))
      ]);
      currentDebt.push(...scanResolvedTerminologyDebt({
        documentId: document.id,
        sourceLines: splitTextLines(sourceText),
        candidateLines: splitTextLines(candidateText),
        terms
      }));
    }

    if (JSON.stringify(currentDebt) !== JSON.stringify(persistedDebt)) {
      const rollback = domainRun.recordTranslationTerminologyDebt(currentDebt);
      try {
        await context.persistHostState?.();
      } catch (error) {
        rollback();
        throw error;
      }
    }

    const tasks = new Map<string, PiTranslationSubagentTask>();
    for (const debt of currentDebt) {
      const document = resolvedManifest.documents.find((entry) => entry.id === debt.documentId);
      if (!document) continue;
      const key = `${document.id}\0${debt.line}`;
      const feedback = {
        line: debt.line,
        reason: `terminology: use ${debt.expectedTarget} for ${debt.source}; replace ${debt.observedTargets.join(", ")}`
      };
      const existing = tasks.get(key);
      if (existing) {
        existing.reviewFeedback = [...(existing.reviewFeedback ?? []), feedback];
        continue;
      }
      tasks.set(key, {
        documentId: document.id,
        fromLine: debt.line,
        toLine: debt.line,
        label: `Repair terminology ${document.id} L${debt.line}`,
        terminologyRepair: true,
        reviewFeedback: [feedback],
        ...(folderStages?.has(document.id) ? { scheduleStage: folderStages.get(document.id) } : {})
      });
    }
    return [...tasks.values()];
  };
  const mergePersistedTranslationTerminologyTasks = (
    ordinaryTasks: PiTranslationSubagentTask[],
    terminologyTasks: PiTranslationSubagentTask[]
  ): PiTranslationSubagentTask[] => {
    const merged = [...ordinaryTasks];
    const feedbackForRange = (
      feedback: PiTranslationSubagentTask["reviewFeedback"],
      fromLine: number,
      toLine: number
    ) => feedback?.filter((entry) => entry.line >= fromLine && entry.line <= toLine);
    const relabel = (task: PiTranslationSubagentTask, fromLine: number, toLine: number) => ({
      ...task,
      fromLine,
      toLine,
      label: `${task.documentId ?? documentId(request)} L${fromLine}-${toLine}`,
      reviewFeedback: feedbackForRange(task.reviewFeedback, fromLine, toLine)
    });

    for (const priority of terminologyTasks) {
      const priorityDocumentId = priority.documentId ?? documentId(request);
      const containingIndex = merged.findIndex((task) => (
        (task.documentId ?? documentId(request)) === priorityDocumentId
        && task.fromLine <= priority.fromLine
        && task.toLine >= priority.toLine
      ));
      if (containingIndex < 0) {
        merged.push(priority);
        continue;
      }
      const containing = merged[containingIndex];
      const combinedFeedback = [
        ...(containing.reviewFeedback ?? []),
        ...(priority.reviewFeedback ?? [])
      ];
      if (
        containing.fromLine === priority.fromLine
        && containing.toLine === priority.toLine
      ) {
        merged[containingIndex] = {
          ...containing,
          label: priority.label,
          reviewOnly: undefined,
          terminologyRepair: true,
          reviewFeedback: combinedFeedback
        };
        continue;
      }
      if (containing.reviewOnly === true || containing.stagingCandidatePath?.trim()) {
        merged[containingIndex] = {
          ...containing,
          label: `Repair terminology ${priorityDocumentId} L${priority.fromLine} within L${containing.fromLine}-${containing.toLine}`,
          reviewOnly: undefined,
          terminologyRepair: true,
          reviewFeedback: combinedFeedback
        };
        continue;
      }

      const replacements: PiTranslationSubagentTask[] = [];
      if (containing.fromLine < priority.fromLine) {
        replacements.push(relabel(containing, containing.fromLine, priority.fromLine - 1));
      }
      replacements.push({
        ...containing,
        ...priority,
        documentId: priority.documentId ?? containing.documentId,
        reviewOnly: undefined,
        terminologyRepair: true,
        reviewFeedback: feedbackForRange(combinedFeedback, priority.fromLine, priority.toLine)
      });
      if (priority.toLine < containing.toLine) {
        replacements.push(relabel(containing, priority.toLine + 1, containing.toLine));
      }
      merged.splice(containingIndex, 1, ...replacements);
    }
    return merged;
  };
  const translationMechanicalSignals = (
    validation: ReturnType<typeof validateTranslationCandidate>,
    fromLine: number,
    toLine: number
  ): Array<{ line: number; signals: string[] }> => {
    const byLine = new Map<number, Set<string>>();
    for (const [severity, findings] of [
      ["blocking", validation.blocking],
      ["warning", validation.warnings]
    ] as const) {
      for (const finding of findings) {
        if (!finding.line || finding.line < fromLine || finding.line > toLine) continue;
        const signals = byLine.get(finding.line) ?? new Set<string>();
        signals.add(`${severity}:${finding.code}`);
        byLine.set(finding.line, signals);
      }
    }
    return [...byLine.entries()]
      .sort(([left], [right]) => left - right)
      .map(([line, signals]) => ({ line, signals: [...signals] }));
  };
  const assertTranslationChunkReviewRangeAvailable = (
    currentDocumentId: string,
    range: { fromLine: number; toLine: number }
  ): void => {
    const overlap = (translationAlignmentState.ranges[currentDocumentId] ?? []).find((scope) => (
      scope.fromLine <= range.toLine
      && scope.toLine >= range.fromLine
      && (scope.fromLine !== range.fromLine || scope.toLine !== range.toLine)
    ));
    if (overlap) {
      throw new Error(
        `Translation chunk review ranges overlap for ${currentDocumentId}: `
        + `L${overlap.fromLine}-L${overlap.toLine} and L${range.fromLine}-L${range.toLine}.`
      );
    }
  };
  const registerTranslationChunkReview = async (
    bound: PiBoundSourceRequest,
    inputRange: {
      fromLine: number;
      toLine: number;
      requiredLines?: number[];
      requiredLineReasons?: Array<{ line: number; reason: string }>;
    },
    candidateOverride?: string
  ): Promise<TranslationAlignmentRangeState> => {
    const currentDocumentId = documentId(bound);
    const sourceText = await readFile(sourcePath(bound), "utf8");
    const candidate = candidateOverride ? path.resolve(candidateOverride) : candidatePath(bound);
    const candidateText = await readFile(candidate, "utf8");
    const sourceLines = splitTextLines(sourceText);
    const candidateLines = splitTextLines(candidateText);
    const range = normalizeRange(inputRange.fromLine, inputRange.toLine, sourceLines.length);
    assertTranslationChunkReviewRangeAvailable(currentDocumentId, range);
    if (candidateLines.length !== sourceLines.length) {
      throw new Error(
        `Translation chunk review requires equal line counts; source has ${sourceLines.length} and candidate has ${candidateLines.length}.`
      );
    }
    const validation = validateTranslationCandidate(
      sourceText,
      candidateText,
      await createYnTranslationValidationOptions(bound)
    );
    const created = createTranslationChunkReviewAudit({
      documentId: currentDocumentId,
      sourceLines: sourceLines.slice(range.fromLine - 1, range.toLine),
      candidateLines: candidateLines.slice(range.fromLine - 1, range.toLine),
      candidatePath: candidate,
      languagePair: bound.languagePair,
      fromLine: range.fromLine,
      toLine: range.toLine,
      sourceLineCount: sourceLines.length,
      mechanicalSignals: [
        ...translationMechanicalSignals(validation, range.fromLine, range.toLine),
        ...(inputRange.requiredLines ?? []).map((line) => ({
          line,
          signals: ["host_repaired_line"]
        }))
      ]
    });
    const existing = translationAlignmentState.ranges[currentDocumentId] ?? [];
    const exact = existing.find((scope) => (
      scope.fromLine === range.fromLine && scope.toLine === range.toLine
    ));
    const exactMatchesCurrentCandidate = exact !== undefined
      && exact.inputHash === created.inputHash
      && exact.candidatePath === created.candidatePath
      && exact.sourceLineCount === created.sourceLineCount;
    const scope = exact && exactMatchesCurrentCandidate
      ? exact
      : exact?.checks.every((check) => check.verdict !== undefined)
        && exact.checks.some((check) => check.verdict === "misaligned")
        ? createTranslationRepairReviewAudit(exact, created)
        : created;
    const previousExact = exact ? {
      ...exact,
      checks: exact.checks.map((check) => ({
        line: check.line,
        signals: [...check.signals],
        ...(check.verdict ? { verdict: check.verdict } : {}),
        ...(check.reason ? { reason: check.reason } : {})
      }))
    } : undefined;
    const previousDocument = translationAlignmentState.documents[currentDocumentId];
    const checksByLine = new Map(scope.checks.map((check) => [check.line, check]));
    for (const failure of inputRange.requiredLineReasons ?? []) {
      const check = checksByLine.get(failure.line);
      if (!check) {
        throw new Error(
          `Host-required staging repair L${failure.line} is outside the selected review evidence.`
        );
      }
      if (!isActionableTranslationAlignmentReason(failure.reason)) {
        throw new Error(`Host-required staging repair L${failure.line} has a malformed actionable reason.`);
      }
      check.verdict = "misaligned";
      check.reason = failure.reason.trim();
    }
    translationAlignmentState.ranges[currentDocumentId] = [
      ...existing.filter((entry) => entry !== exact),
      scope
    ].sort((left, right) => left.fromLine - right.fromLine);
    delete translationAlignmentState.documents[currentDocumentId];
    const clearedSourceReadKeys: string[] = [];
    const clearedTranslationReadKeys: string[] = [];
    if (scope === created) {
      for (let line = range.fromLine; line <= range.toLine; line += 1) {
        const key = alignmentReadKey(currentDocumentId, line);
        if (sourceLinesRead.delete(key)) clearedSourceReadKeys.push(key);
        if (translationLinesRead.delete(key)) clearedTranslationReadKeys.push(key);
      }
    }
    try {
      await context.persistHostState?.();
    } catch (error) {
      const liveRanges = translationAlignmentState.ranges[currentDocumentId] ?? [];
      const liveExact = liveRanges.find((entry) => (
        entry.fromLine === range.fromLine && entry.toLine === range.toLine
      ));
      if (liveExact === scope) {
        const restored = [
          ...liveRanges.filter((entry) => entry !== scope),
          ...(previousExact ? [previousExact] : [])
        ].sort((left, right) => left.fromLine - right.fromLine);
        if (restored.length > 0) translationAlignmentState.ranges[currentDocumentId] = restored;
        else delete translationAlignmentState.ranges[currentDocumentId];
      }
      if (translationAlignmentState.documents[currentDocumentId] === undefined && previousDocument) {
        translationAlignmentState.documents[currentDocumentId] = previousDocument;
      }
      for (const key of clearedSourceReadKeys) sourceLinesRead.add(key);
      for (const key of clearedTranslationReadKeys) translationLinesRead.add(key);
      throw error;
    }
    return scope;
  };
  const commitAcceptedTranslationChunkReview = async (
    bound: PiBoundSourceRequest,
    inputRange: { fromLine: number; toLine: number }
  ): Promise<void> => {
    const currentDocumentId = documentId(bound);
    const sourceText = await readFile(sourcePath(bound), "utf8");
    const sourceLines = splitTextLines(sourceText);
    const candidate = candidatePath(bound);
    const candidateText = await readFile(candidate, "utf8");
    const candidateLines = splitTextLines(candidateText);
    const range = normalizeRange(inputRange.fromLine, inputRange.toLine, sourceLines.length);
    const reviewed = (translationAlignmentState.ranges[currentDocumentId] ?? []).find((scope) => (
      scope.fromLine === range.fromLine && scope.toLine === range.toLine
    ));
    if (!reviewed || reviewed.checks.some((check) => check.verdict !== "aligned")) {
      throw new Error(
        `Cannot commit L${range.fromLine}-L${range.toLine}: the review worker has not accepted the complete Host-selected scope.`
      );
    }
    const validation = validateTranslationCandidate(
      sourceText,
      candidateText,
      await createYnTranslationValidationOptions(bound)
    );
    const committed = createTranslationChunkReviewAudit({
      documentId: currentDocumentId,
      sourceLines: sourceLines.slice(range.fromLine - 1, range.toLine),
      candidateLines: candidateLines.slice(range.fromLine - 1, range.toLine),
      candidatePath: candidate,
      languagePair: bound.languagePair,
      fromLine: range.fromLine,
      toLine: range.toLine,
      sourceLineCount: sourceLines.length,
      mechanicalSignals: translationMechanicalSignals(validation, range.fromLine, range.toLine)
    });
    if (reviewed.inputHash !== committed.inputHash) {
      throw new Error(
        `Cannot commit L${range.fromLine}-L${range.toLine}: the canonical candidate differs from the accepted staging review.`
      );
    }
    const committedScope: TranslationAlignmentRangeState = {
      ...committed,
      riskLineCount: reviewed.riskLineCount,
      sampledLineCount: reviewed.sampledLineCount,
      checks: reviewed.checks.map((check) => ({
        line: check.line,
        signals: [...check.signals],
        verdict: "aligned"
      }))
    };
    const previousRanges = [...(translationAlignmentState.ranges[currentDocumentId] ?? [])];
    const previousDocument = translationAlignmentState.documents[currentDocumentId];
    replaceTranslationAlignmentRange(
      translationAlignmentState,
      currentDocumentId,
      committedScope,
      reviewed.auditId
    );
    delete translationAlignmentState.documents[currentDocumentId];
    try {
      await context.persistHostState?.();
    } catch (error) {
      translationAlignmentState.ranges[currentDocumentId] = previousRanges;
      if (previousDocument) translationAlignmentState.documents[currentDocumentId] = previousDocument;
      else delete translationAlignmentState.documents[currentDocumentId];
      throw error;
    }
  };
  const prepareTranslationChunkReview = async (
    review: PiTranslationChunkReviewRequest
  ): Promise<
     | { decision: PiTranslationChunkReviewDecision }
     | {
         request: PiSessionPromptRequest;
         task: PiTranslationReviewTask;
        read: (task: PiTranslationReviewTask, signal?: AbortSignal) => Promise<PiTranslationReviewAssignment>;
        submit: (
          task: PiTranslationReviewTask,
          failures: PiTranslationReviewFailure[],
          signal?: AbortSignal
        ) => Promise<PiTranslationChunkReviewDecision>;
      }
  > => {
    const bound = await boundForDocument(review.documentId);
    const reviewCandidatePath = review.candidatePath?.trim() || candidatePath(bound);
    const audit = await registerTranslationChunkReview(bound, review, reviewCandidatePath);
    const malformedRejectedChecks = audit.checks.filter((check) => (
      check.verdict === "misaligned" && !isActionableTranslationAlignmentReason(check.reason)
    ));
    if (malformedRejectedChecks.length > 0) {
      for (const check of malformedRejectedChecks) {
        delete check.verdict;
        delete check.reason;
      }
      await context.persistHostState?.();
    }
    const pendingChecks = audit.checks.filter((check) => !check.verdict);
    if (pendingChecks.length === 0) {
      const rejected = audit.checks.filter((check) => check.verdict === "misaligned");
      return {
        decision: rejected.length === 0
          ? { accepted: true }
          : {
              accepted: false,
               feedback: rejected.map((check) => ({
                 line: check.line,
                 reason: check.reason!.trim()
               }))
            }
      };
    }
    const task: PiTranslationReviewTask = {
      auditId: audit.auditId,
      documentId: review.documentId,
      fromLine: audit.fromLine,
      toLine: audit.toLine,
      riskLineCount: pendingChecks.filter((check) => (
        check.signals.length !== 1 || check.signals[0] !== "deterministic_unflagged_sample"
      )).length,
      sampledLineCount: pendingChecks.filter((check) => (
        check.signals.length === 1 && check.signals[0] === "deterministic_unflagged_sample"
      )).length,
      label: `Review ${review.documentId} L${audit.fromLine}-L${audit.toLine}`
    };
    const currentScope = async (requested: PiTranslationReviewTask) => {
      if (requested.auditId !== audit.auditId || requested.documentId !== review.documentId) {
        throw new Error(`Translation review assignment ${requested.auditId} does not own ${review.documentId}.`);
      }
      const currentBound = await boundForDocument(review.documentId);
      const sourceLines = splitTextLines(await readFile(sourcePath(currentBound), "utf8"));
      const candidate = path.resolve(reviewCandidatePath);
      const candidateLines = splitTextLines(await readFile(candidate, "utf8"));
      const scope = (translationAlignmentState.ranges[review.documentId] ?? [])
        .find((entry) => entry.auditId === requested.auditId);
      if (!scope) throw new Error(`Translation review assignment ${requested.auditId} is stale or missing.`);
      const inputHash = currentTranslationAlignmentRangeHash(
        scope,
        sourceLines,
        candidateLines,
        currentBound.languagePair
      );
      if (
        sourceLines.length !== candidateLines.length
        || scope.inputHash !== inputHash
        || scope.candidatePath !== candidate
        || scope.sourceLineCount !== sourceLines.length
      ) {
        throw new Error(`Translation review assignment ${requested.auditId} changed after Host mechanical scan.`);
      }
      return { currentBound, sourceLines, candidateLines, scope };
    };
    const reviewWindows = (
      scope: TranslationAlignmentRangeState,
      selectedChecks = scope.checks.filter((check) => !check.verdict)
    ) => {
      const windows = selectedChecks
        .map((check) => ({
          fromLine: Math.max(scope.fromLine, check.line - 2),
          toLine: Math.min(scope.toLine, check.line + 2)
        }))
        .sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine)
        .reduce<Array<{ fromLine: number; toLine: number }>>((merged, window) => {
          const previous = merged.at(-1);
          if (previous && window.fromLine <= previous.toLine + 1) {
            previous.toLine = Math.max(previous.toLine, window.toLine);
          } else {
            merged.push({ ...window });
          }
          return merged;
        }, []);
      return windows;
    };
    return {
      request: bound,
      task,
      read: async (requested, signal) => {
        if (signal?.aborted) throw signal.reason;
        const { sourceLines, candidateLines, scope } = await currentScope(requested);
        const pending = scope.checks.filter((check) => !check.verdict);
        const selected = new Map(pending.map((check) => [check.line, check.signals]));
        return {
          auditId: scope.auditId,
          documentId: scope.documentId,
          fromLine: scope.fromLine,
          toLine: scope.toLine,
          riskLineCount: requested.riskLineCount,
          sampledLineCount: requested.sampledLineCount,
          windows: reviewWindows(scope, pending).map((window) => ({
            ...window,
            rows: Array.from({ length: window.toLine - window.fromLine + 1 }, (_, index) => {
              const line = window.fromLine + index;
              return {
                line,
                source: sourceLines[line - 1] ?? "",
                translation: candidateLines[line - 1] ?? "",
                selected: selected.has(line),
                signals: [...(selected.get(line) ?? [])]
              };
            })
          }))
        };
      },
      submit: async (requested, failures, signal) => {
        if (signal?.aborted) throw signal.reason;
        const { scope } = await currentScope(requested);
        const pending = scope.checks.filter((check) => !check.verdict);
        const windows = reviewWindows(scope, pending);
        const grouped = new Map<number, { codes: Set<string>; notes: Set<string> }>();
        for (const failure of failures) {
          const code = failure.code.trim();
          const note = typeof failure.note === "string" ? failure.note.trim() : "";
          if (!Number.isInteger(failure.line)) {
            throw new Error(`Translation review ${scope.auditId} contains an invalid line ${failure.line}.`);
          }
          if (!code) throw new Error(`Translation review failure L${failure.line} requires a code.`);
          if (!note) {
            throw new Error(
              `Translation review failure L${failure.line} requires an actionable repair note.`
            );
          }
          if (!windows.some((window) => failure.line >= window.fromLine && failure.line <= window.toLine)) {
            throw new Error(`Translation review failure L${failure.line} is outside the assigned review windows.`);
          }
          const entry = grouped.get(failure.line) ?? { codes: new Set<string>(), notes: new Set<string>() };
          entry.codes.add(canonicalTranslationReviewCode(code));
          entry.notes.add(note);
          grouped.set(failure.line, entry);
        }
        const normalized = [...grouped.entries()]
          .sort(([left], [right]) => left - right)
          .map(([line, entry]) => {
            const codes = [...entry.codes].sort().join("+");
            const notes = [...entry.notes].slice(0, MAX_TRANSLATION_REVIEW_NOTES_PER_LINE).join(" | ");
            return {
              line,
              reason: `${codes}: ${notes}`.slice(0, 500)
            };
          });
        const byLine = new Map(scope.checks.map((check) => [check.line, check]));
        for (const check of pending) {
          check.verdict = "aligned";
          delete check.reason;
        }
        for (const failure of normalized) {
          const check = byLine.get(failure.line) ?? {
            line: failure.line,
            signals: ["review_context_failure"]
          };
          check.verdict = "misaligned";
          check.reason = failure.reason;
          if (!byLine.has(failure.line)) scope.checks.push(check);
        }
        scope.checks.sort((left, right) => left.line - right.line);
        scope.sampledLineCount = scope.checks.filter((check) => (
          check.signals.length === 1 && check.signals[0] === "deterministic_unflagged_sample"
        )).length;
        scope.riskLineCount = scope.checks.length - scope.sampledLineCount;
        requested.riskLineCount = scope.riskLineCount;
        requested.sampledLineCount = scope.sampledLineCount;
        await context.persistHostState?.();
        return normalized.length === 0
          ? { accepted: true }
          : {
              accepted: false,
              feedback: normalized
            };
      }
    };
  };
  const resumedTranslationReviewRequest = async (
    task: PiTranslationSubagentTask,
    subagentId: string,
    signal?: AbortSignal
  ): Promise<PiTranslationChunkReviewRequest> => {
    if (signal?.aborted) throw signal.reason;
    if (!task.documentId) throw new Error("A resumed translation review requires a documentId.");
    const bound = await boundForDocument(task.documentId);
    const candidate = task.stagingCandidatePath?.trim() || candidatePath(bound);
    const [sourceText, candidateText] = await Promise.all([
      readFile(sourcePath(bound), "utf8"),
      readFile(candidate, "utf8")
    ]);
    return {
      subagentId,
      label: task.label?.trim() || `Resume review ${task.documentId} L${task.fromLine}-L${task.toLine}`,
      documentId: task.documentId,
      fromLine: task.fromLine,
      toLine: task.toLine,
      candidatePath: candidate,
      validation: validateTranslationCandidate(
        sourceText,
        candidateText,
        await createYnTranslationValidationOptions(bound)
      ),
      discoveries: {
        glossaryCandidates: [],
        characterFacts: []
      },
      signal
    };
  };
  const registerBoundedTranslationAlignment = async (
    bound: PiBoundSourceRequest,
    inputRange: { fromLine: number; toLine: number },
    options: { parentOwnedMutation?: boolean } = {}
  ): Promise<TranslationAlignmentRangeState> => {
    const currentDocumentId = documentId(bound);
    const sourceText = await readFile(sourcePath(bound), "utf8");
    const sourceLines = splitTextLines(sourceText);
    const requested = normalizeRange(inputRange.fromLine, inputRange.toLine, sourceLines.length);
    const candidate = candidatePath(bound);
    const candidateText = await readFile(candidate, "utf8");
    const candidateLines = splitTextLines(candidateText);
    if (candidateLines.length !== sourceLines.length) {
      throw new Error(
        `Translation alignment registration requires equal line counts; source has ${sourceLines.length} and candidate has ${candidateLines.length}.`
      );
    }
    const existing = translationAlignmentState.ranges[currentDocumentId] ?? [];
    let fromLine = requested.fromLine;
    let toLine = requested.toLine;
    const retained: TranslationAlignmentRangeState[] = [];
    for (const scope of existing) {
      if (scope.toLine < fromLine || scope.fromLine > toLine) {
        retained.push(scope);
        continue;
      }
      fromLine = Math.min(fromLine, scope.fromLine);
      toLine = Math.max(toLine, scope.toLine);
    }
    const validation = validateTranslationCandidate(
      sourceText,
      candidateText,
      await createYnTranslationValidationOptions(bound)
    );
    const inheritedSignals = new Map<number, Set<string>>();
    for (const entry of translationMechanicalSignals(validation, fromLine, toLine)) {
      inheritedSignals.set(entry.line, new Set(entry.signals));
    }
    for (const previous of existing) {
      if (previous.toLine < fromLine || previous.fromLine > toLine) continue;
      const previousCurrentHash = currentTranslationAlignmentRangeHash(
        previous,
        sourceLines,
        candidateLines,
        bound.languagePair
      );
      if (previousCurrentHash !== previous.inputHash) continue;
      for (const check of previous.checks) {
        if (check.verdict !== "misaligned") continue;
        const signals = inheritedSignals.get(check.line) ?? new Set<string>();
        signals.add("previous_misaligned_verdict");
        inheritedSignals.set(check.line, signals);
      }
    }
    const auditInput = {
      documentId: currentDocumentId,
      sourceText: sourceLines.slice(fromLine - 1, toLine).join("\n"),
      candidateText: candidateLines.slice(fromLine - 1, toLine).join("\n"),
      candidatePath: candidate,
      languagePair: bound.languagePair,
      fromLine,
      toLine,
      sourceLineCount: sourceLines.length,
      mechanicalSignals: [...inheritedSignals.entries()].map(([line, signals]) => ({
        line,
        signals: [...signals]
      }))
    };
    const created = options.parentOwnedMutation
      ? createTranslationMutationReviewAudit({
          ...auditInput,
          mutationFromLine: requested.fromLine,
          mutationToLine: requested.toLine,
          previousScopes: existing
        })
      : createTranslationChunkReviewAudit(auditInput);
    const previousChecks = new Map<number, TranslationAlignmentRangeState["checks"][number]>();
    for (const previous of existing) {
      if (previous.toLine < fromLine || previous.fromLine > toLine) continue;
      const previousCurrentHash = currentTranslationAlignmentRangeHash(
        previous,
        sourceLines,
        candidateLines,
        bound.languagePair
      );
      if (previousCurrentHash !== previous.inputHash) continue;
      for (const check of previous.checks) previousChecks.set(check.line, check);
    }
    const scope: TranslationAlignmentRangeState = {
      ...created,
      checks: created.checks.map((check) => {
        const previous = previousChecks.get(check.line);
          return previous?.verdict
            ? {
                ...check,
                verdict: previous.verdict,
                ...(previous.verdict === "misaligned" && previous.reason ? { reason: previous.reason } : {})
              }
          : check;
      })
    };
    translationAlignmentState.ranges[currentDocumentId] = [...retained, scope]
      .sort((left, right) => left.fromLine - right.fromLine);
    delete translationAlignmentState.documents[currentDocumentId];
    return scope;
  };

  const canonicalizeBoundedTranslationAlignments = async (
    bound: PiBoundSourceRequest
  ): Promise<TranslationAlignmentRangeState[]> => {
    const currentDocumentId = documentId(bound);
    const scopes = translationAlignmentState.ranges[currentDocumentId] ?? [];
    const legacyScopes = scopes.filter((scope) => scope.auditId.startsWith("alignment-range-"));
    if (legacyScopes.length === 0) return scopes;
    for (const scope of legacyScopes) {
      await registerBoundedTranslationAlignment(bound, {
        fromLine: scope.fromLine,
        toLine: scope.toLine
      }, { parentOwnedMutation: true });
    }
    await context.persistHostState?.();
    return translationAlignmentState.ranges[currentDocumentId] ?? [];
  };
  const currentRangeAlignmentHash = (
    scope: TranslationAlignmentRangeState,
    sourceLines: string[],
    candidateLines: string[],
    languagePair?: string
  ): string => currentTranslationAlignmentRangeHash(scope, sourceLines, candidateLines, languagePair);
  const requireCurrentBoundedTranslationAlignment = async (
    bound: PiBoundSourceRequest,
    sourceText: string,
    candidateText: string,
    candidate: string
  ): Promise<TranslationAlignmentRangeState[]> => {
    const currentDocumentId = documentId(bound);
    const sourceLines = splitTextLines(sourceText);
    const candidateLines = splitTextLines(candidateText);
    const scopes = translationAlignmentState.ranges[currentDocumentId] ?? [];
    if (scopes.length === 0) {
      throw new Error(
        `Complete a bounded translation alignment audit for the changed ranges in ${currentDocumentId} with inspectTranslationAlignment before validation.`
      );
    }
    for (const scope of scopes) {
      const currentHash = currentRangeAlignmentHash(scope, sourceLines, candidateLines, bound.languagePair);
      if (
        scope.inputHash !== currentHash
        || scope.candidatePath !== candidate
        || scope.sourceLineCount !== sourceLines.length
      ) {
        throw new Error(
          `The bounded translation range L${scope.fromLine}-L${scope.toLine} changed after alignment inspection. Run inspectTranslationAlignment again.`
        );
      }
      const pending = scope.checks.filter((check) => !check.verdict).map((check) => check.line);
      if (pending.length > 0) {
        throw new Error(
          `Bounded translation alignment audit is incomplete for ${currentDocumentId}; pending lines: ${pending.join(", ")}.`
        );
      }
      const misaligned = scope.checks.filter((check) => check.verdict === "misaligned").map((check) => check.line);
      if (misaligned.length > 0) {
        throw new Error(
          `Bounded translation alignment failed for ${currentDocumentId}; misaligned lines: ${misaligned.join(", ")}. Repair them and inspect again.`
        );
      }
    }
    return scopes;
  };
  const buildProofreadPrescan = async (
    bound: PiBoundSourceRequest,
    prepared?: {
      validationOptions: Awaited<ReturnType<typeof createYnTranslationValidationOptions>>;
      assets: Awaited<ReturnType<typeof readProjectAssets>>;
    }
  ): Promise<{
    sourceLines: string[];
    translationLines: string[];
    translationPath: string;
    prescan: ProofreadPrescanSnapshot;
  }> => {
    const sourceText = await readFile(sourcePath(bound), "utf8");
    const sourceLines = splitTextLines(sourceText);
    const translationPath = proofreadTranslationPath(bound, manifest?.kind === "folder");
    if (!await exists(translationPath)) {
      throw new Error(`Proofreading requires an existing translation candidate at ${translationPath}.`);
    }
    const translationText = await readFile(translationPath, "utf8");
    const translationLines = splitTextLines(translationText);
    if (sourceLines.length !== translationLines.length) {
      throw new Error(
        `Proofreading requires aligned files; source has ${sourceLines.length} lines and translation has ${translationLines.length}.`
      );
    }
    const validationOptions = prepared?.validationOptions
      ?? await createYnTranslationValidationOptions(bound);
    const assets = prepared?.assets
      ?? await readProjectAssets({ outputDir: bound.outputDir });
    const currentInputHash = proofreadInputHash(
      sourceLines.join("\n"),
      translationLines.join("\n"),
      validationOptions,
      bound.auditWhitelistLines ?? [],
      assets
    );
    const auditWhitelistLines = new Set(bound.auditWhitelistLines ?? []);
    const signals = buildProofreadDeterministicSignals({
      sourceText: sourceLines.join("\n"),
      translationText: translationLines.join("\n"),
      validationOptions
    }).filter((signal) => !auditWhitelistLines.has(signal.line));
    const summary = summarizeProofreadDeterministicSignals({
      signals,
      totalLines: sourceLines.length,
      maximumWorkers: effectiveSubagentCount(bound, sourceLines.length, context.domainRun)
    });
    return {
      sourceLines,
      translationLines,
      translationPath,
      prescan: { inputHash: currentInputHash, translationPath, signals, summary }
    };
  };
  const recordProofreadPrescanForBound = async (
    bound: PiBoundSourceRequest,
    prepared?: {
      validationOptions: Awaited<ReturnType<typeof createYnTranslationValidationOptions>>;
      assets: Awaited<ReturnType<typeof readProjectAssets>>;
    }
  ): Promise<Awaited<ReturnType<typeof buildProofreadPrescan>>> => {
    const current = await buildProofreadPrescan(bound, prepared);
    const currentDocumentId = documentId(bound);
    const previousPrescan = proofreadPrescans.get(currentDocumentId);
    const persistedDocument = proofreadDocumentHostState(proofreadState, currentDocumentId);
    if (
      (previousPrescan
        && (previousPrescan.inputHash !== current.prescan.inputHash
          || previousPrescan.translationPath !== current.translationPath))
      || (persistedDocument.prescan
        && (persistedDocument.prescan.inputHash !== current.prescan.inputHash
          || persistedDocument.prescan.translationPath !== current.translationPath))
    ) {
      invalidateProofreadState(currentDocumentId);
    }
    proofreadPrescans.set(currentDocumentId, current.prescan);
    proofreadDocumentHostState(proofreadState, currentDocumentId).prescan = {
      inputHash: current.prescan.inputHash,
      translationPath: current.translationPath,
      summary: current.prescan.summary
    };
    context.domainRun?.recordSourceRead(currentDocumentId);
    context.domainRun?.recordTranslationRead(currentDocumentId);
    context.domainRun?.recordProofreadPrescan(currentDocumentId);
    return current;
  };
  const requireProofreadPrescanForBound = async (
    bound: PiBoundSourceRequest
  ): Promise<Awaited<ReturnType<typeof buildProofreadPrescan>>> => {
    const currentDocumentId = documentId(bound);
    const persistedDocument = proofreadState.documents[currentDocumentId];
    if (!persistedDocument?.prescan) {
      throw new Error(
        `Complete the full deterministic prescan for ${currentDocumentId} with inspectTranslationContext before semantic proofreading.`
      );
    }
    const current = await buildProofreadPrescan(bound);
    if (
      persistedDocument.prescan.inputHash !== current.prescan.inputHash
      || persistedDocument.prescan.translationPath !== current.translationPath
    ) {
      invalidateProofreadState(currentDocumentId);
      throw new Error(
        `The aligned source, translation, or proofreading assets changed after the deterministic prescan for ${currentDocumentId}. Run inspectTranslationContext again before semantic review.`
      );
    }
    proofreadPrescans.set(currentDocumentId, current.prescan);
    context.domainRun?.assertProofreadPrescanReady(currentDocumentId);
    return current;
  };
  const requireCurrentProofreadPrescan = async () => requireProofreadPrescanForBound(request);
  const aggregateProofreadPrescans = (
    entries: Array<Awaited<ReturnType<typeof buildProofreadPrescan>>>
  ): ProofreadPrescanSummary & { documentCount: number } => {
    const countsByCode: ProofreadPrescanSummary["countsByCode"] = {
      H3: 0,
      H4: 0,
      H7: 0,
      H8: 0,
      H9: 0,
      M0: 0
    };
    const regionCounts: ProofreadPrescanSummary["regionCounts"] = { HOT: 0, WARM: 0, COLD: 0 };
    for (const entry of entries) {
      for (const code of Object.keys(countsByCode) as Array<keyof typeof countsByCode>) {
        countsByCode[code] += entry.prescan.summary.countsByCode[code];
      }
      for (const tier of Object.keys(regionCounts) as Array<keyof typeof regionCounts>) {
        regionCounts[tier] += entry.prescan.summary.regionCounts[tier];
      }
    }
    const totalLines = entries.reduce((sum, entry) => sum + entry.sourceLines.length, 0);
    const maximumWorkers = Math.min(
      configuredSubagentMaximum(baseRequest, context.domainRun),
      Math.max(1, totalLines)
    );
    return {
      completed: true,
      documentCount: entries.length,
      totalLines,
      signalCount: entries.reduce((sum, entry) => sum + entry.prescan.summary.signalCount, 0),
      affectedLineCount: entries.reduce((sum, entry) => sum + entry.prescan.summary.affectedLineCount, 0),
      countsByCode,
      recommendedWorkerCount: maximumWorkers === 0
        ? 0
        : Math.min(maximumWorkers, Math.max(1, Math.ceil(totalLines / 1_000))),
      regionCounts,
      highestRiskRegions: []
    };
  };
  const requireCurrentProofreadScope = async (scopeId: string): Promise<ProofreadLocalScopeState> => {
    const scope = proofreadState.localScopes[scopeId];
    if (!scope || scope.documentId !== documentId(request)) {
      throw new Error(`Unknown proofread range scope: ${scopeId}. Run inspectProofreadRange again.`);
    }
    const sourceLines = splitTextLines(await readFile(sourcePath(request), "utf8"));
    const translationPath = proofreadTranslationPath(request, manifest?.kind === "folder");
    const translationLines = splitTextLines(await readFile(translationPath, "utf8"));
    const range = normalizeRange(scope.fromLine, scope.toLine, sourceLines.length);
    if (translationLines.length !== sourceLines.length) {
      throw new Error("The aligned files changed after the bounded proofread range was inspected.");
    }
    const validationOptions = await createYnTranslationValidationOptions(request);
    const assets = await readProjectAssets({ outputDir: request.outputDir });
    const inputHash = proofreadInputHash(
      sourceLines.slice(range.fromLine - 1, range.toLine).join("\n"),
      translationLines.slice(range.fromLine - 1, range.toLine).join("\n"),
      validationOptions,
      (request.auditWhitelistLines ?? []).filter((line) => line >= range.fromLine && line <= range.toLine),
      assets
    );
    if (scope.inputHash !== inputHash || scope.translationPath !== translationPath) {
      delete proofreadState.localScopes[scopeId];
      throw new Error("The bounded proofread range or its project assets changed. Run inspectProofreadRange again.");
    }
    return scope;
  };
  const requireCurrentTranslationChunkReviews = async (
    bound: PiBoundSourceRequest,
    sourceText: string,
    candidateText: string,
    candidate: string
  ): Promise<TranslationAlignmentRangeState[]> => {
    const currentDocumentId = documentId(bound);
    const sourceLines = splitTextLines(sourceText);
    const candidateLines = splitTextLines(candidateText);
    const scopes = [...(translationAlignmentState.ranges[currentDocumentId] ?? [])]
      .sort((left, right) => left.fromLine - right.fromLine);
    const appliedAudit = baseRequest.reuseExistingTranslation === true
      ? (await listAppliedTranslationReuseAudits(baseRequest.outputDir, baseRequest.sessionId))
        .find((audit) => audit.documentId === currentDocumentId)
      : undefined;
    const requiredReviewLines = appliedAudit
      ? appliedAudit.retranslationLines.filter((line) => Boolean(sourceLines[line - 1]?.trim()))
      : undefined;
    const relevantScopes = requiredReviewLines
      ? scopes.filter((scope) => requiredReviewLines.some((line) => line >= scope.fromLine && line <= scope.toLine))
      : scopes;
    if (!appliedAudit && relevantScopes.length === 0) {
      throw new Error(
        `Complete hash-bound chunk review for ${currentDocumentId}: Host mechanical scan, every flagged row, and the deterministic unflagged sample.`
      );
    }
    if (
      appliedAudit
      && (
        path.resolve(appliedAudit.sourcePath) !== path.resolve(sourcePath(bound))
        || path.resolve(appliedAudit.candidatePath) !== path.resolve(candidate)
        || appliedAudit.sourceLineCount !== sourceLines.length
      )
    ) {
      throw new Error(`Applied translation reuse evidence no longer owns ${currentDocumentId}.`);
    }
    let previousTo = 0;
    for (const scope of relevantScopes) {
      if (scope.fromLine <= previousTo) {
        throw new Error(
          `Translation chunk review evidence overlaps for ${currentDocumentId} at L${scope.fromLine}-L${scope.toLine}.`
        );
      }
      const currentHash = currentRangeAlignmentHash(scope, sourceLines, candidateLines, bound.languagePair);
      if (
        scope.inputHash !== currentHash
        || scope.candidatePath !== candidate
        || scope.sourceLineCount !== sourceLines.length
      ) {
        throw new Error(
          `Translation chunk L${scope.fromLine}-L${scope.toLine} changed after review-worker acceptance. Send that chunk through review again before final validation.`
        );
      }
      const pending = scope.checks.filter((check) => !check.verdict).map((check) => check.line);
      if (pending.length > 0) {
        throw new Error(
          `Translation chunk review is incomplete for ${currentDocumentId} L${scope.fromLine}-L${scope.toLine}; pending selected lines: ${pending.join(", ")}.`
        );
      }
      const misaligned = scope.checks.filter((check) => check.verdict === "misaligned").map((check) => check.line);
      if (misaligned.length > 0) {
        throw new Error(
          `Translation chunk review rejected ${currentDocumentId} L${scope.fromLine}-L${scope.toLine}; misaligned lines: ${misaligned.join(", ")}. The same child must repair them before continuing.`
        );
      }
      previousTo = scope.toLine;
    }
    if (requiredReviewLines) {
      const acceptedLines = new Set<number>();
      for (const scope of relevantScopes) {
        for (let line = scope.fromLine; line <= scope.toLine; line += 1) acceptedLines.add(line);
      }
      const missing = requiredReviewLines.filter((line) => !acceptedLines.has(line));
      if (missing.length > 0) {
        throw new Error(
          `Translation reuse review coverage for ${currentDocumentId} is missing ${missing.length} rejected line(s): ${missing.slice(0, 32).join(", ")}${missing.length > 32 ? ", ..." : ""}. Retained rows are covered by the applied reuse audit; only rejected rows require worker-review acceptance.`
        );
      }
      return relevantScopes;
    }
    let cursor = 1;
    for (const scope of relevantScopes) {
      if (scope.fromLine !== cursor) {
        throw new Error(
          `Translation chunk review coverage for ${currentDocumentId} has a gap or overlap at line ${cursor}; next scope is L${scope.fromLine}-L${scope.toLine}.`
        );
      }
      cursor = scope.toLine + 1;
    }
    if (cursor !== sourceLines.length + 1) {
      throw new Error(
        `Translation chunk review coverage for ${currentDocumentId} stops at line ${cursor - 1}; source has ${sourceLines.length} lines.`
      );
    }
    return scopes;
  };
  const tools: YnDomainAgentTool[] = [
    {
      name: "resumeYnWorkflow",
      label: "Resume YN workflow",
      description: "Idempotently resume the Host-owned translation or proofreading workflow in this Pi session. If it is already active or this session has no suspended workflow, this succeeds without changing state.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        const currentRecoveryPauseId = context.domainRun?.recoveryPauseId;
        if (currentRecoveryPauseId) {
          if (recoveryPauseIdAtToolCreation !== currentRecoveryPauseId) {
            throw new Error(
              "An exhausted child assignment can only be resumed from a fresh explicit user prompt received after the failure. "
              + "Hidden completion follow-ups cannot authorize another batch."
            );
          }
          context.domainRun?.resumeAfterExplicitContinuation(currentRecoveryPauseId);
          await context.persistHostState?.();
          return textResult({
            resumed: true,
            status: "recovery_resumed",
            workflow: context.domainRun?.kind,
            pauseId: currentRecoveryPauseId
          });
        }
        const workflowSuspended = context.isWorkflowSuspended?.() === true;
        if (!workflowSuspended) {
          return textResult({
            resumed: false,
            status: context.domainRun?.fullWorkflow ? "already_active" : "not_suspended",
            ...(context.domainRun?.fullWorkflow ? { workflow: context.domainRun.kind } : {})
          });
        }
        if (!context.resumeWorkflow) {
          throw new Error("The Pi session reported a suspended YN workflow without a Host resume capability.");
        }
        await context.resumeWorkflow();
        if (!context.domainRun) {
          return textResult({ resumed: false, status: "not_suspended" });
        }
        return textResult({
          resumed: true,
          status: "resumed",
          workflow: context.domainRun.kind
        });
      }
    },
    {
      name: "readTranslationDiscoveries",
      label: "Read translation discoveries",
      description: "Page the current run's Host-persisted terminology and character discoveries, grouped by source identity with document and line evidence. Use this instead of re-reading child transcripts or requesting the entire batch payload.",
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const input = params as { offset?: number; limit?: number };
        const pending = (context.domainRun?.pendingTranslationDiscoveries() ?? []).filter((record) => (
          record.kind !== "glossary" || glossaryCandidateCollectionEnabled
        ));
        const discoveryConflicts = glossaryCandidateCollectionEnabled
          ? context.domainRun?.pendingTranslationDiscoveryConflicts() ?? []
          : [];
        const conflictsBySource = new Map(discoveryConflicts.map((conflict) => [
          normalizeTranslationTerm(conflict.source),
          conflict
        ]));
        const grouped = new Map<string, {
          kind: "glossary" | "character";
          source: string;
          records: YnTranslationDiscoveryRecord[];
        }>();
        for (const record of pending) {
          const source = record.kind === "glossary" ? record.source : record.sourceName;
          const key = `${record.kind}\0${source.normalize("NFC")}`;
          const group = grouped.get(key) ?? { kind: record.kind, source, records: [] };
          group.records.push(record);
          grouped.set(key, group);
        }
        const groups = [...grouped.values()].sort((left, right) => (
          left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source)
        ));
        const offset = Math.min(input.offset ?? 0, groups.length);
        const limit = input.limit ?? 12;
        const page = groups.slice(offset, offset + limit).map((group) => {
          const conflict = group.kind === "glossary"
            ? conflictsBySource.get(normalizeTranslationTerm(group.source))
            : undefined;
          return {
          kind: group.kind,
          source: group.source,
          recordIds: group.records.map((record) => record.id),
          ...(conflict ? {
            conflict: {
              observedTargets: conflict.observedTargets,
              documentIds: conflict.documentIds,
              affectedRanges: conflict.affectedRanges
            }
          } : {}),
          proposals: group.records.map((record) => record.kind === "glossary" ? {
            target: record.target,
            category: record.category,
            aliases: record.aliases ?? [],
            rationale: record.rationale,
            documentId: record.documentId,
            evidenceLine: record.evidenceLine,
            sourceHash: record.sourceHash,
            candidateHash: record.candidateHash
          } : {
            targetName: record.targetName,
            gender: record.gender,
            pronouns: record.pronouns ?? [],
            confidence: record.confidence,
            evidence: record.evidence,
            documentId: record.documentId,
            evidenceLine: record.evidenceLine,
            sourceHash: record.sourceHash,
            candidateHash: record.candidateHash
          })
        };
        });
        return textResult({
          totalGroups: groups.length,
          totalRecords: pending.length,
          offset,
          groups: page,
          hasMore: offset + page.length < groups.length,
          ...(offset + page.length < groups.length ? { nextOffset: offset + page.length } : {})
        });
      }
    },
    {
      name: "resolveTranslationDiscoveries",
      label: "Resolve translation discoveries",
      description: glossaryCandidateCollectionEnabled
        ? "Resolve one or more Host-persisted discovery groups. Accept writes the selected terminology to glossary_candidates.json or merges a validated character entry into character_bible.md; reject records that the proposal is ordinary, unsupported, or already covered. Every decision is typed and evidence remains auditable in Pi Host history."
        : "Resolve Host-persisted character discoveries. Glossary-candidate collection is disabled, so this tool cannot accept or write terminology candidates.",
      parameters: Type.Object({
        ...(glossaryCandidateCollectionEnabled ? { glossary: Type.Optional(Type.Array(Type.Object({
          source: Type.String({ minLength: 1 }),
          action: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
          target: Type.Optional(Type.String({ minLength: 1 })),
          rationale: Type.String({ minLength: 1, maxLength: 1_000 })
        }, { additionalProperties: false }))) } : {}),
        characters: Type.Optional(Type.Array(Type.Object({
          sourceName: Type.String({ minLength: 1 }),
          action: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
          targetName: Type.Optional(Type.String({ minLength: 1 })),
          gender: Type.Optional(Type.Union([
            Type.Literal("male"), Type.Literal("female"), Type.Literal("nonbinary"), Type.Literal("unknown")
          ])),
          confidence: Type.Optional(Type.Union([
            Type.Literal("confirmed"), Type.Literal("inferred"), Type.Literal("unknown")
          ])),
          rationale: Type.String({ minLength: 1, maxLength: 1_000 })
        }, { additionalProperties: false })))
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as {
          glossary?: Array<{ source: string; action: "accept" | "reject"; target?: string; rationale: string }>;
          characters?: Array<{
            sourceName: string;
            action: "accept" | "reject";
            targetName?: string;
            gender?: "male" | "female" | "nonbinary" | "unknown";
            confidence?: "confirmed" | "inferred" | "unknown";
            rationale: string;
          }>;
        };
        const decisions = [...(input.glossary ?? []), ...(input.characters ?? [])];
        if (decisions.length === 0) throw new Error("Resolve at least one translation discovery group.");
        await prepareCurrentTranslationDiscoveryConflicts(await ensureManifest());
        const pending = context.domainRun?.pendingTranslationDiscoveries() ?? [];
        const normalize = (value: string) => value.trim().normalize("NFC");
        const discoveryConflicts = context.domainRun?.pendingTranslationDiscoveryConflicts() ?? [];
        const conflictsBySource = new Map(discoveryConflicts.map((conflict) => [
          normalize(conflict.source),
          conflict
        ]));
        const glossaryGroups = new Map<string, Extract<YnTranslationDiscoveryRecord, { kind: "glossary" }>[]>();
        const characterGroups = new Map<string, Extract<YnTranslationDiscoveryRecord, { kind: "character" }>[]>();
        for (const record of pending) {
          const groups = record.kind === "glossary" ? glossaryGroups : characterGroups;
          const key = normalize(record.kind === "glossary" ? record.source : record.sourceName);
          const current = groups.get(key) ?? [];
          current.push(record as never);
          groups.set(key, current as never);
        }
        const seen = new Set<string>();
        const resolvedIds: string[] = [];
        const resolvedTerms: YnResolvedTranslationTerm[] = [];
        const acceptedGlossary: Array<{
          source: string;
          target: string;
          aliases: string[];
          rationale: string;
          observedTargets: string[];
        }> = [];
        for (const decision of input.glossary ?? []) {
          const key = normalize(decision.source);
          if (seen.has(`g\0${key}`)) throw new Error(`Duplicate terminology decision for ${decision.source}.`);
          seen.add(`g\0${key}`);
          const records = glossaryGroups.get(key);
          if (!records?.length) throw new Error(`No pending terminology discovery exists for ${decision.source}.`);
          resolvedIds.push(...records.map((record) => record.id));
          if (decision.action === "accept") {
            const target = normalize(decision.target ?? "");
            if (!target) throw new Error(`Accepted terminology ${decision.source} requires a selected target.`);
            const observedTargets = [...new Set([
              ...records.map((record) => normalize(record.target)),
              ...(conflictsBySource.get(key)?.observedTargets ?? []).map(normalize)
            ])];
            acceptedGlossary.push({
              source: records[0]!.source,
              target,
              aliases: [...new Set(records.flatMap((record) => record.aliases ?? []).map(normalize))],
              rationale: decision.rationale.trim(),
              observedTargets
            });
            resolvedTerms.push({ source: records[0]!.source, target, observedTargets });
          }
        }
        const acceptedCharacters: Record<string, unknown>[] = [];
        for (const decision of input.characters ?? []) {
          const key = normalize(decision.sourceName);
          if (seen.has(`c\0${key}`)) throw new Error(`Duplicate character decision for ${decision.sourceName}.`);
          seen.add(`c\0${key}`);
          const records = characterGroups.get(key);
          if (!records?.length) throw new Error(`No pending character discovery exists for ${decision.sourceName}.`);
          resolvedIds.push(...records.map((record) => record.id));
          if (decision.action === "accept") {
            const strongest = records.find((record) => record.confidence === "confirmed") ?? records[0]!;
            acceptedCharacters.push({
              name: strongest.sourceName,
              target: normalize(decision.targetName ?? strongest.targetName ?? strongest.sourceName),
              gender: decision.gender ?? strongest.gender,
              pronouns: [...new Set(records.flatMap((record) => record.pronouns ?? []))].join(", ") || "unknown",
              genderConfidence: decision.confidence ?? strongest.confidence,
              termsOfAddress: "unknown",
              evidence: `${decision.rationale.trim()} | ${strongest.documentId} L${strongest.evidenceLine}: ${strongest.evidence}`
            });
          }
        }

        const fileWrites: Array<{ path: string; content: string; previous?: string }> = [];
        if (acceptedCharacters.length > 0) {
          const assets = await readProjectAssets({ outputDir: request.outputDir });
          const characters = structuredClone(assets.characterBible.characters);
          const byName = new Map(characters.map((entry) => [normalize(String(entry.name ?? "")), entry]));
          for (const accepted of acceptedCharacters) {
            const key = normalize(String(accepted.name));
            const existing = byName.get(key);
            if (existing) Object.assign(existing, accepted);
            else {
              characters.push(accepted);
              byName.set(key, accepted);
            }
          }
          const content = serializeCharacterBibleMarkdown(characters);
          validateGeneratedCharacterBibleContent(content, WORKSPACE_CHARACTER_BIBLE);
          const previous = await readOptional(assets.paths.characterBible);
          fileWrites.push({
            path: assets.paths.characterBible,
            content,
            ...(previous === undefined ? {} : { previous })
          });
        }

        await runWorkspaceGlossaryCandidateTransaction(request.outputDir, async (transaction) => {
        const domainRollbacks: Array<() => void> = [];
        let glossaryCommit: WorkspaceGlossaryCandidateCommit | undefined;
        const written: typeof fileWrites = [];
        let hostStatePersisted = false;
        try {
          if (acceptedGlossary.length > 0) {
            glossaryCommit = await transaction.commit(
              acceptedGlossary.map((accepted) => ({
                source: accepted.source,
                target: accepted.target,
                aliases: accepted.aliases,
                info: `translation discovery: ${accepted.rationale}`,
                status: "pending" as const,
                allowTargetReplacement: conflictsBySource.has(normalize(accepted.source))
              }))
            );
            const unresolvedFileConflicts = glossaryCommit.outcomes.filter((outcome) => outcome.status === "conflict");
            if (unresolvedFileConflicts.length > 0) {
              throw new Error(
                `Canonical glossary candidate conflict was not registered in Host state: ${unresolvedFileConflicts
                  .map((outcome) => `${outcome.source} (${outcome.existingTarget} vs ${outcome.target})`).join(", ")}.`
              );
            }
          }
          for (const file of fileWrites) {
            await writeTextFileAtomically(file.path, file.content);
            written.push(file);
          }
          const repairs = resolvedTerms.length > 0
            ? await planTranslationTerminologyRepairs(resolvedTerms)
            : { debt: [], tasks: [] };
          const repairTasksByBatch = routeTranslationTerminologyRepairs(repairs.tasks);
          const rollbackResolution = context.domainRun?.resolveTranslationDiscoveries(resolvedIds, resolvedTerms);
          if (rollbackResolution) domainRollbacks.push(rollbackResolution);
          if (context.domainRun && repairs.debt.length > 0) {
            domainRollbacks.push(context.domainRun.recordTranslationTerminologyDebt([
              ...context.domainRun.pendingTranslationTerminologyDebt(),
              ...repairs.debt
            ]));
          }
          await readWorkspaceAssetsStatus(request.outputDir);
          await context.persistHostState?.();
          hostStatePersisted = true;
          for (const [repairBatchId, repairTasks] of repairTasksByBatch) {
            context.subagents.enqueueTranslationPriorityTasksIfActive(repairBatchId, repairTasks);
          }
          if ((context.domainRun?.pendingTranslationDiscoveryConflicts().length ?? 0) === 0) {
            context.domainRun?.releaseTranslationTerminologyGate();
          }
        } catch (error) {
          if (hostStatePersisted) throw error;
          for (const rollback of domainRollbacks.reverse()) rollback();
          const rollbackErrors: unknown[] = [];
          if (glossaryCommit) {
            try {
              await glossaryCommit.rollback();
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          for (const file of written.reverse()) {
            try {
              if (file.previous === undefined) await rm(file.path, { force: true });
              else await writeTextFileAtomically(file.path, file.previous);
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], "Translation discovery resolution rollback failed.");
          }
          throw error;
        }
        });
        const remaining = context.domainRun?.pendingTranslationDiscoveries() ?? [];
        return textResult({
          resolvedRecordCount: resolvedIds.length,
          acceptedTerminologyCount: acceptedGlossary.length,
          acceptedCharacterCount: acceptedCharacters.length,
          remainingRecordCount: remaining.length,
          remainingGroupCount: new Set(remaining.map((record) => (
            `${record.kind}\0${record.kind === "glossary" ? record.source : record.sourceName}`
          ))).size,
          nextAction: remaining.length > 0
            ? "Read the next discovery page and resolve the remaining groups."
            : context.domainRun?.pendingTranslationTerminologyDebt().length
              ? "The Host queued exact terminology repairs ahead of the existing translation queue."
              : "Continue the existing translation queue; its terminology gate is open."
        });
      }
    },
    {
      name: "readYnInterfaceContext",
      label: "Read YN interface context",
      description: "Read the currently visible generated YN page, its visible line range, and the focused source/translation row. Use this when the user refers to the current page, visible area, selected row, or 'this line'.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        return textResult(context.readInterfaceContext?.() ?? { available: false });
      }
    },
    {
      requiresSourceManifest: true,
      name: "inspectProofreadRange",
      label: "Inspect proofread range",
      description: "Create a hash-bound bounded re-proofread scope for an exact aligned range. This is for later local review after edits and does not claim or require the complete proofread workflow prescan.",
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as { fromLine: number; toLine: number };
        const sourceLines = splitTextLines(await readFile(sourcePath(request), "utf8"));
        const translationPath = proofreadTranslationPath(request, manifest?.kind === "folder");
        const translationLines = splitTextLines(await readFile(translationPath, "utf8"));
        if (sourceLines.length !== translationLines.length) {
          throw new Error(
            `Bounded proofreading requires aligned files; source has ${sourceLines.length} lines and translation has ${translationLines.length}.`
          );
        }
        const range = normalizeRange(input.fromLine, input.toLine, sourceLines.length);
        const validationOptions = await createYnTranslationValidationOptions(request);
        const assets = await readProjectAssets({ outputDir: request.outputDir });
        const scopedSource = sourceLines.slice(range.fromLine - 1, range.toLine).join("\n");
        const scopedTranslation = translationLines.slice(range.fromLine - 1, range.toLine).join("\n");
        const inputHash = proofreadInputHash(
          scopedSource,
          scopedTranslation,
          validationOptions,
          (request.auditWhitelistLines ?? []).filter((line) => line >= range.fromLine && line <= range.toLine),
          assets
        );
        const scopeId = `proofread-range-${inputHash.slice(0, 16)}-${range.fromLine}-${range.toLine}`;
        const scope: ProofreadLocalScopeState = {
          id: scopeId,
          documentId: documentId(request),
          inputHash,
          translationPath,
          ...range
        };
        proofreadState.localScopes[scopeId] = scope;
        const auditWhitelist = new Set(request.auditWhitelistLines ?? []);
        const signals = buildProofreadDeterministicSignals({
          sourceText: scopedSource,
          translationText: scopedTranslation,
          validationOptions
        })
          .map((signal) => ({ ...signal, line: signal.line + range.fromLine - 1 }))
          .filter((signal) => !auditWhitelist.has(signal.line));
        return textResult({ scopeId, ...scope, deterministicSignals: signals });
      }
    },
    {
      name: "fetchWebReference",
      label: "Fetch web reference",
      description: "Fetch and extract a public HTTP(S) reference URL. Use this before relying on a URL supplied by the user. The host validates redirects and network targets, uses the project proxy, and caches readable text for the parent and its subagents.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        maxChars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
        refresh: Type.Optional(Type.Boolean())
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        const input = params as { url: string; maxChars?: number; refresh?: boolean };
        return textResult(await webReferences.fetch({
          url: input.url,
          workspaceDir: baseRequest.outputDir,
          maxChars: input.maxChars,
          refresh: input.refresh,
          signal
        }));
      }
    },
    {
      requiresSourceManifest: true,
      name: "inspectTranslationContext",
      label: "Inspect translation context",
      description: "Inspect the bound source, candidate artifact, glossary, character bible, style guide, and translation memory. Returned exists/available fields are authoritative; do not probe paths reported unavailable. The Host-provided typed operation decides whether this is translation, proofreading, or read-only inspection; tool arguments cannot switch workflows.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const workflow = context.domainRun?.suspended === true
          ? "inspect_only"
          : context.domainRun?.kind ?? "inspect_only";
        if (workflow !== "inspect_only") context.domainRun?.activate(workflow);
        const source = sourcePath(request);
        const sourceInfo = await stat(source);
        if (!sourceInfo.isFile()) throw new Error("The bound source path is not a file.");
        const sourceLines = splitTextLines(await readFile(source, "utf8"));
        const assets = await readProjectAssets({ outputDir: request.outputDir });
        const candidate = candidatePath(request);
        const workspaceStatus = await readWorkspaceAssetsStatus(request.outputDir);
        const glossaryCandidateExists = workspaceStatus.available.glossaryCandidates;
        const characterBibleExists = workspaceStatus.available.characterBible;
        if (workflow !== "inspect_only") {
          context.domainRun?.recordInspection({
            sourceLineCount: sourceLines.length,
            documents: manifest?.documents.map((document) => ({
              id: document.id,
              sourceLineCount: document.lineCount,
              scheduleStage: folderStages?.get(document.id)
            })),
            glossaryCandidateExists,
            characterBibleExists
          });
        }
        let proofreadPrescan: (ProofreadPrescanSummary & { documentCount?: number }) | undefined;
        let boundProofreadTranslationPath: string | undefined;
        if (workflow === "proofread") {
          const validationOptions = await createYnTranslationValidationOptions(request);
          const prepared = { validationOptions, assets };
          if (manifest?.kind === "folder") {
            const scans = [];
            for (const document of manifest.documents) {
              scans.push(await recordProofreadPrescanForBound(
                bindPiSourceDocument(baseRequest, document),
                prepared
              ));
            }
            proofreadPrescan = aggregateProofreadPrescans(scans);
            const selectedIndex = manifest.documents.findIndex((document) => document.id === documentId(request));
            boundProofreadTranslationPath = scans[Math.max(0, selectedIndex)]?.translationPath;
          } else {
            const scan = await recordProofreadPrescanForBound(request, prepared);
            proofreadPrescan = scan.prescan.summary;
            boundProofreadTranslationPath = scan.translationPath;
          }
        }
        const manifestDocuments = manifest?.documents.map((document) => ({
          id: document.id,
          lineCount: document.lineCount,
          candidatePath: candidatePath(bindPiSourceDocument(baseRequest, document))
        })) ?? [];
        return textResult({
          sourcePath: source,
          sourceSelection: manifest ? {
            kind: manifest.kind,
            rootPath: manifest.rootPath,
            selectedDocumentId: documentId(request),
            documentCount: manifestDocuments.length,
            totalLineCount: manifestDocuments.reduce((sum, document) => sum + document.lineCount, 0),
            documents: manifestDocuments.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS),
            omittedDocumentCount: Math.max(0, manifestDocuments.length - MAX_TOOL_RESULT_COLLECTION_ITEMS)
          } : undefined,
          sourceLineCount: sourceLines.length,
          candidatePath: candidate,
          candidateExists: await exists(candidate),
          ...(boundProofreadTranslationPath ? { translationPath: boundProofreadTranslationPath } : {}),
          ...(proofreadPrescan ? {
            proofreadPrescan: {
              ...proofreadPrescan,
              nextAction: proofreadPrescan.recommendedWorkerCount > 0
                ? "Choose one to the configured maximum useful semantic workers, then call runProofreadSubagents."
                : "Subagents are disabled or unnecessary; complete semantic review in the parent session."
            }
          } : {}),
          ...(workflow === "proofread" ? {
            proofreadGlossaryCandidates: summarizeProofreadGlossaryCandidates(
              manifest?.kind === "folder"
                ? manifest.documents.flatMap((document) => (
                    proofreadDocumentHostState(proofreadState, document.id).glossaryCandidates.map((candidate) => ({
                      ...candidate,
                      documentId: document.id
                    }))
                  ))
                : proofreadDocumentHostState(proofreadState, documentId(request)).glossaryCandidates
            )
          } : {}),
          workspace: {
            glossaryCandidates: {
              path: resolveProjectPath(request.outputDir, WORKSPACE_GLOSSARY),
              exists: glossaryCandidateExists
            },
            characterBible: {
              path: resolveProjectPath(request.outputDir, WORKSPACE_CHARACTER_BIBLE),
              exists: characterBibleExists
            }
          },
          establishedAssets: {
            glossaryPath: assets.paths.glossary,
            glossaryEntries: assets.glossary.entries.length,
            glossaryAvailable: assets.glossary.entries.length > 0,
            characterBiblePath: assets.paths.characterBible,
            characters: assets.characterBible.characters.length,
            characterBibleAvailable: assets.characterBible.characters.length > 0,
            styleGuidePath: assets.paths.styleGuide,
            styleGuideAvailable: Boolean(assets.styleGuide.trim())
          },
          translationMemory: assets.translationMemory
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "selectSourceDocument",
      label: "Select source document",
      description: "Select one file from the immutable host-resolved source-folder manifest before reading, delegating, writing, or validating that file.",
      parameters: Type.Object({ documentId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as { documentId: string };
        const selected = selectDocument(input.documentId.trim());
        const sourceLines = splitTextLines(await readFile(sourcePath(selected), "utf8"));
        return textResult({
          documentId: documentId(selected),
          sourcePath: sourcePath(selected),
          sourceLineCount: sourceLines.length,
          candidatePath: candidatePath(selected)
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "prepareTranslationReuseAudit",
      label: "Prepare translation reuse audit",
      description: "Before restarting or resuming translation, discover meaningful existing candidate work and run the hash-bound Host quick scan across the complete host-resolved manifest. In a folder workflow this always covers every retained document, regardless of the currently selected document. Aligned target-language lines without structural, source-residue, language, length, repetition, or contamination risk are retained automatically; only flagged lines require semantic review. This never changes the candidate.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute() {
        assertTranslationReuseAuditEnabled();
        const resolvedManifest = await ensureManifest();
        const currentRunArtifacts = resolvedManifest.documents
          .filter((document) => context.domainRun?.ownsCurrentTranslationArtifact(document.id))
          .map((document) => document.id);
        if (currentRunArtifacts.length > 0) {
          throw new Error(
            `The current workflow already owns translation artifact ${currentRunArtifacts[0]}; `
              + "reuse audit applies only to candidates that existed before this workflow started."
          );
        }
        const audits = await refreshTranslationReuseAudits(resolvedManifest.documents);
        markTranslationReuseAuditsReady();
        const aggregate = compactTranslationReuseAuditSummary(audits);
        const result = {
          ...aggregate,
          nextAction: audits.length === 0
            ? "No meaningful existing translation work was found; continue the normal workflow."
            : aggregate.decisionDocumentCount === 0
              ? "All current translation reuse decisions are already applied; continue only the remaining Host workflow debt."
            : aggregate.allReadyForUserDecision
              ? "Ask the user whether to reuse accepted lines before changing any candidate."
              : "Semantically audit only the Host-flagged high-risk lines. Ordinary aligned target-language lines already passed the quick scan."
        };
        return textResult(result, {
          ...result,
          ...(audits.length === 1 ? { singleAudit: audits[0] } : {})
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "readTranslationReuseAudit",
      label: "Read translation reuse audit",
      description: "Read at most 80 aligned source/current-translation pairs from a prepared reuse audit. Only Host-flagged high-risk lines require a semantic verdict; mechanically accepted lines are included only as nearby context.",
      parameters: Type.Object({
        auditId: Type.String({ minLength: 1 }),
        documentId: Type.String({ minLength: 1 }),
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        assertTranslationReuseAuditEnabled();
        const input = params as { auditId: string; documentId: string; fromLine: number; toLine: number };
        if (input.toLine - input.fromLine + 1 > 80) {
          throw new Error("Read translation reuse audits in batches of at most 80 lines.");
        }
        return textResult(await readTranslationReuseAuditBatch({
          outputDir: baseRequest.outputDir,
          ownerSessionId: baseRequest.sessionId,
          ...input
        }));
      }
    },
    {
      requiresSourceManifest: true,
      name: "recordTranslationReuseAudit",
      label: "Record translation reuse audit",
      description: "Record the AI's final binary verdict for every Host-flagged high-risk line in an existing candidate. reuse means complete and faithful; retranslate means placeholder, untranslated, partial, wrong, or otherwise unusable. Host risk signals are evidence to investigate, not a forced verdict.",
      parameters: Type.Object({
        auditId: Type.String({ minLength: 1 }),
        documentId: Type.String({ minLength: 1 }),
        entries: Type.Array(Type.Object({
          line: Type.Integer({ minimum: 1 }),
          verdict: Type.Union([
            Type.Literal("reuse"),
            Type.Literal("retranslate")
          ]),
          reason: Type.String({ minLength: 1, maxLength: 1_000 })
        }, { additionalProperties: false }), { minItems: 1, maxItems: 80 })
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        assertTranslationReuseAuditEnabled();
        const input = params as {
          auditId: string;
          documentId: string;
          entries: Array<{ line: number; verdict: "reuse" | "retranslate"; reason: string }>;
        };
        const recorded = await recordTranslationReuseAuditBatch({
          outputDir: baseRequest.outputDir,
          ownerSessionId: baseRequest.sessionId,
          ...input
        });
        translationReuseAudits.set(input.documentId, {
          auditId: input.auditId,
          status: recorded.status,
          readyForUserDecision: recorded.readyForUserDecision
        });
        markTranslationReuseAuditsReady();
        return textResult(recorded);
      }
    },
    {
      requiresSourceManifest: true,
      name: "runTranslationReuseAudit",
      label: "Run translation reuse audit",
      description: "Send only Host-flagged high-risk ranges from the prepared reuse audit to persistent read-only native Pi workers. Ordinary lines stay out of model context. Workers classify existing risky lines only; they never write translations.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, _params, signal) {
        assertTranslationReuseAuditEnabled();
        const pendingAudits = [...translationReuseAudits.values()]
          .filter((audit) => audit.status === "auditing");
        const tasks = await planTranslationReuseAuditTasks({
          outputDir: baseRequest.outputDir,
          ownerSessionId: baseRequest.sessionId,
          auditIds: pendingAudits.map((audit) => audit.auditId),
          maxLinesPerTask: 80
        });
        if (tasks.length === 0) {
          markTranslationReuseAuditsReady();
          return textResult({ status: "completed", taskCount: 0, nextAction: "Ask the user for the reuse decision." });
        }
        const conflictingTask = tasks.find((task) => context.subagents.hasWriteConflict?.({
          documentId: task.documentId,
          fromLine: task.fromLine,
          toLine: task.toLine
        }) === true);
        if (conflictingTask) {
          throw new Error(
            `Translation reuse audit ${conflictingTask.documentId} L${conflictingTask.fromLine}-${conflictingTask.toLine} `
            + "overlaps an active child writer. Retry only this audit range after that exact write settles."
          );
        }
        const configuredWorkers = context.domainRun?.configuredSubagents
          ?? resolveWorkflowSubagentCount(baseRequest.subagentEnabled, baseRequest.subagentCount);
        if (configuredWorkers < 1) {
          return textResult({
            status: "parent_audit_required",
            taskCount: tasks.length,
            assignments: tasks.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS).map((task) => ({
              auditId: task.auditId,
              documentId: task.documentId,
              fromLine: task.fromLine,
              toLine: task.toLine,
              lines: task.lines
            })),
            omittedAssignmentCount: Math.max(0, tasks.length - MAX_TOOL_RESULT_COLLECTION_ITEMS),
            nextAction: "Subagents are disabled. Audit only the returned assignments with readTranslationReuseAudit and recordTranslationReuseAudit in the parent Pi session, then call runTranslationReuseAudit again for any omitted or remaining work."
          });
        }
        const batchId = createYnSubagentBatchId();
        settledTranslationReuseAuditSummary = undefined;
        await reserveGeneralBatch(batchId, tasks.length);
        try {
          const batch = context.subagents.startGeneralBatch({
            batchId,
            request,
            tasks: tasks.map((task) => ({
              ...task,
              prompt: `Semantically audit ${task.lines.length} selected existing-translation risk line(s) for ${task.documentId}.`,
              label: `Reuse audit ${task.documentId} (${task.lines.length} lines)`,
              mode: "translation_audit" as const
            })),
            maxWorkers: Math.min(configuredWorkers, tasks.length),
            signal,
            requestForTask: (task) => {
              const document = manifest?.documents.find((candidate) => candidate.id === task.documentId);
              if (!document) throw new Error(`Source document ${task.documentId} is not in the host-resolved manifest.`);
              return bindPiSourceDocument(baseRequest, document);
            },
            parentCompletionContext: ({ results, error }) => {
              const aggregate = settledTranslationReuseAuditSummary;
              return {
                content: error === undefined && aggregate
                  ? `Translation reuse audit completed across ${aggregate.documentCount} document(s): ${aggregate.counts.reuse} line(s) accepted for reuse and ${aggregate.counts.retranslate} line(s) marked for retranslation. Ask the user for one decision covering the whole candidate set: keep all AI-accepted lines, or discard every existing translation.`
                  : error === undefined
                    ? "Translation reuse audit workers settled, but the Host could not produce the required aggregate. Treat this as a workflow failure instead of rereading every audit into model context."
                    : "Translation reuse semantic audit workers failed. Inspect the child evidence and retry only the failed audit ranges.",
                details: {
                  kind: "translation_reuse_audit",
                  completedAssignments: results.length,
                  failed: error !== undefined,
                  ...(aggregate ?? {})
                }
              };
            },
            onSettled: async ({ batch: settledBatch, results, error }) => {
              if (error !== undefined) {
                context.domainRun?.recordGeneralSubagentBatchFailure(
                  settledBatch.id,
                  error instanceof Error ? error.message : String(error)
                );
                await context.persistHostState?.();
                return;
              }
              const summaries: TranslationReuseAuditSummary[] = [];
              for (const [documentId, audit] of translationReuseAudits) {
                if (audit.status === "applied") continue;
                const latest = await getTranslationReuseAuditSummary(
                  baseRequest.outputDir,
                  audit.auditId,
                  baseRequest.sessionId
                );
                translationReuseAudits.set(documentId, {
                  auditId: audit.auditId,
                  status: latest.status,
                  readyForUserDecision: latest.readyForUserDecision
                });
                summaries.push(latest);
              }
              settledTranslationReuseAuditSummary = compactTranslationReuseAuditSummary(summaries);
              markTranslationReuseAuditsReady();
              context.domainRun?.recordGeneralSubagentBatch(settledBatch.id, results.length);
              await context.persistHostState?.();
            }
          });
          return textResult({
            status: batch.status,
            batchId: batch.id,
            subagents: batch.subagents,
            workerCount: Math.min(configuredWorkers, tasks.length),
            taskCount: tasks.length
          });
        } catch (error) {
          await rollbackGeneralBatch(batchId, error);
          throw error;
        }
      }
    },
    {
      requiresSourceManifest: true,
      restoreWorkflowBeforeSourceManifest: true,
      name: "applyTranslationReuseDecision",
      label: "Apply translation reuse decision",
      description: "Apply the user's one explicit whole-candidate-set reuse choice after every prepared document finishes AI semantic audit. The Host transactionally backs up all candidates, retains only AI-approved lines, and blanks the rest for validated Pi translation workers. Never call before the user answers.",
      parameters: Type.Object({
        decision: Type.Union([
          Type.Literal("reuse_accepted"),
          Type.Literal("discard_existing")
        ])
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        if (context.isWorkflowSuspended?.() === true) {
          if (!context.resumeWorkflow) {
            throw new Error("The pending translation reuse decision cannot restore its suspended Host workflow.");
          }
          await context.resumeWorkflow();
        }
        assertTranslationReuseAuditEnabled();
        if (context.domainRun?.fullWorkflow !== true || context.domainRun.kind !== "translation") {
          throw new Error("A translation reuse decision requires its active Host-owned translation workflow.");
        }
        const input = params as {
          decision: "reuse_accepted" | "discard_existing";
        };
        const resolvedManifest = await ensureManifest();
        const currentCandidateDocuments = [];
        for (const document of resolvedManifest.documents) {
          const bound = bindPiSourceDocument(baseRequest, document);
          const currentCandidatePath = candidatePath(bound);
          if (!await exists(currentCandidatePath)) continue;
          currentCandidateDocuments.push({
            documentId: document.id,
            sourcePath: sourcePath(bound),
            candidatePath: currentCandidatePath
          });
        }
        const currentPending = await listCurrentPendingTranslationReuseAudits({
          outputDir: baseRequest.outputDir,
          ownerSessionId: baseRequest.sessionId,
          documents: currentCandidateDocuments
        });
        for (const audit of currentPending) {
          translationReuseAudits.set(audit.documentId, {
            auditId: audit.auditId,
            status: audit.status,
            readyForUserDecision: audit.readyForUserDecision
          });
        }
        const decisionAudits = currentPending.map((audit) => [
          audit.documentId,
          translationReuseAudits.get(audit.documentId)!
        ] as const);
        if (decisionAudits.length === 0) {
          throw new Error("There is no pending translation reuse audit owned by this Pi session.");
        }
        const incomplete = decisionAudits.find(([, audit]) => audit.status !== "awaiting_user_decision");
        if (incomplete) {
          throw new Error("Complete the semantic translation reuse audit before applying a user decision.");
        }
        const applied = await applyTranslationReuseAudits({
          outputDir: baseRequest.outputDir,
          ownerSessionId: baseRequest.sessionId,
          auditIds: decisionAudits.map(([, audit]) => audit.auditId),
          decision: input.decision
        });
        for (const document of applied.documents) {
          translationReuseAudits.set(document.documentId, {
            auditId: document.auditId,
            status: "applied",
            readyForUserDecision: false,
            appliedFullyReused: document.fullyReused
          });
          context.domainRun?.recordTranslationReuseDecision(
            document.auditId,
            document.documentId,
            document.fullyReused
          );
          context.domainRun?.recordTranslationArtifactMutation(document.documentId);
        }
        const result = {
          decision: applied.decision,
          documentCount: applied.documentCount,
          retainedLineCount: applied.retainedLineCount,
          retranslationLineCount: applied.retranslationLineCount,
          fullyReusedDocumentCount: applied.fullyReusedDocumentCount,
          nextAction: applied.retranslationLineCount === 0
            ? "Run whole-artifact validation; do not launch translation workers when every line was reused."
            : "Translate only the blanked/rejected lines through the existing validated Pi worker flow, then run whole-artifact validation."
        };
        return textResult(result);
      }
    },
    {
      name: "listAvailableModels",
      label: "List available models",
      description: "Query a bounded page of configured models only when the user explicitly requests a child-model override. Complete workflows already use their typed configured child model and must not call this tool before launching. Filter by providerId/query instead of requesting the complete catalog.",
      parameters: Type.Object({
        providerId: Type.Optional(Type.String({ minLength: 1 })),
        query: Type.Optional(Type.String({ minLength: 1 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return textResult(compactConfiguredModelCatalog(
          await listPiConfiguredModels(request.outputDir),
          params as ConfiguredModelCatalogQuery
        ));
      }
    },
    {
      name: "inspectSubagents",
      label: "Inspect subagents",
      description: "Inspect lightweight child status and assignment progress. Full child Pi transcripts stay in child JSONL and are loaded only by the user's Reply panel. Use only when the user asks for status or a child appears stalled; completion wakes the parent automatically, so do not poll.",
      parameters: Type.Object({
        subagentId: Type.Optional(Type.String({ minLength: 1 }))
      }),
      async execute(_toolCallId, params) {
        const input = params as { subagentId?: string };
        if (input.subagentId?.trim()) {
          const inspected = await context.subagents.inspect(input.subagentId.trim());
          const {
            transcript: _privateTranscript,
            reply: _privateReply,
            ...subagent
          } = inspected as typeof inspected & { transcript?: unknown; reply?: unknown };
          return textResult({
            subagent: {
              ...subagent,
              ...(typeof subagent.resultSummary === "string"
                ? { resultSummary: subagent.resultSummary.slice(0, 4_000) }
                : {})
            }
          });
        }
        return textResult({ batches: context.subagents.list() });
      }
    },
    {
      name: "steerSubagent",
      label: "Steer subagent",
      description: "Send concise parent guidance into one currently running native Pi child. The child consumes it through Pi's steering queue.",
      parameters: Type.Object({
        subagentId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 })
      }),
      async execute(_toolCallId, params) {
        const input = params as { subagentId: string; message: string };
        const receipt = await context.subagents.steer(input.subagentId, input.message);
        const recordDelivery = (status: "consumed" | "rejected", error?: string) => (
          context.publishCustomMessage({
            role: "custom",
            customType: "subagent.steer_delivery",
            content: status,
            display: false,
            details: {
              deliveryId: receipt.deliveryId,
              subagentId: input.subagentId,
              status,
              ...(error ? { error } : {})
            },
            timestamp: Date.now()
          })
        );
        void receipt.consumed.then(
          () => recordDelivery("consumed"),
          (error) => recordDelivery("rejected", error instanceof Error ? error.message : String(error))
        ).catch(() => undefined);
        return textResult({
          status: receipt.status,
          deliveryId: receipt.deliveryId,
          subagentId: input.subagentId
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "readSourceLines",
      label: "Read source lines",
      description: "Read a one-based range from the bound read-only source document. Results are paged at 512 lines; continue from nextFromLine when hasMore is true.",
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }),
      async execute(_toolCallId, params) {
        const input = params as { fromLine: number; toLine: number };
        const readRequest = activeTranslationChunkReview?.bound ?? request;
        const lines = splitTextLines(await readFile(sourcePath(readRequest), "utf8"));
        const range = parentLineReadRange(input.fromLine, input.toLine, lines.length);
        const currentDocumentId = documentId(readRequest);
        for (let line = range.fromLine; line <= range.toLine; line += 1) {
          sourceLinesRead.add(alignmentReadKey(currentDocumentId, line));
        }
        if (!context.domainRun?.suspended) context.domainRun?.recordSourceRead();
        if (context.domainRun?.kind === "proofread" && !context.domainRun.suspended) {
          context.domainRun.recordProofreadParentRead("source", range.fromLine, range.toLine);
        }
        return textResult({ ...range, totalLines: lines.length, lines: lines.slice(range.fromLine - 1, range.toLine) });
      }
    },
    {
      requiresSourceManifest: true,
      name: "readTranslationLines",
      label: "Read translation lines",
      description: "Read a one-based range from the current translation candidate. Results are paged at 512 lines; continue from nextFromLine when hasMore is true.",
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }),
      async execute(_toolCallId, params) {
        const input = params as { fromLine: number; toLine: number };
        const readRequest = activeTranslationChunkReview?.bound ?? request;
        const translation = activeTranslationChunkReview
          ? candidatePath(readRequest)
          : proofreadTranslationPath(readRequest, manifest?.kind === "folder");
        const text = await readOptional(translation);
        if (!text) return textResult({ exists: false, path: translation, lines: [] });
        const lines = splitTextLines(text);
        const range = parentLineReadRange(input.fromLine, input.toLine, lines.length);
        const currentDocumentId = documentId(readRequest);
        for (let line = range.fromLine; line <= range.toLine; line += 1) {
          translationLinesRead.add(alignmentReadKey(currentDocumentId, line));
        }
        if (!context.domainRun?.suspended) context.domainRun?.recordTranslationRead();
        if (context.domainRun?.kind === "proofread" && !context.domainRun.suspended) {
          context.domainRun.recordProofreadParentRead("translation", range.fromLine, range.toLine);
        }
        return textResult({ exists: true, path: translation, ...range, totalLines: lines.length, lines: lines.slice(range.fromLine - 1, range.toLine) });
      }
    },
    {
      name: "recordProofreadParentReview",
      label: "Record parent proofreading review",
      description: "Record an exact aligned range that the parent Agent has semantically reviewed after reading both source and translation. This is explicit semantic coverage, not a read receipt.",
      parameters: Type.Object({
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 })
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        await requireCurrentProofreadPrescan();
        const input = params as { fromLine: number; toLine: number };
        context.domainRun?.recordProofreadParentSemanticReview(input.fromLine, input.toLine);
        return textResult({ accepted: true, fromLine: input.fromLine, toLine: input.toLine });
      }
    },
    {
      name: "readProjectFile",
      label: "Read file",
      description: "Read one bounded UTF-8 page only when that exact file is needed. A bound source document id or source filename resolves to the actual Host-bound file, including extracted EPUB text. Other relative paths use the current project; absolute paths may point to user-provided external references. Use readSourceLines for the bound source, avoid generated historical review HTML, and continue a genuinely needed long file with offsetChars. This tool never writes.",
      parameters: Type.Object({
        path: Type.String(),
        offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_000 }))
      }),
      async execute(_toolCallId, params) {
        const input = params as { path: string; offsetChars?: number; maxChars?: number };
        const result = await readProjectFile({
          outputDir: request.outputDir,
          relativePath: resolvePiReadablePath(request, input.path),
          offsetChars: input.offsetChars,
          maxChars: input.maxChars ?? 16_000
        });
        if (!result.ok) throw new Error(result.error);
        return textResult(result);
      }
    },
    {
      name: "writeProjectFile",
      label: "Write workflow file",
      description: "Write only AI_translation/_workspace assets or settings files. Parent directories are created automatically: never create .gitkeep or initialize AI_translation. Translation candidates must use writeTranslationChunk and proofreading reports must use writeProofreadFindings.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
        append: Type.Optional(Type.Boolean())
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as { path: string; content: string; append?: boolean };
        const relativePath = assertDomainWritePath(request.outputDir, input.path);
        if (relativePath === WORKSPACE_GLOSSARY) {
          if (!glossaryCandidateCollectionEnabled) {
            throw new Error("Glossary-candidate generation is disabled for this workflow.");
          }
          if (input.append) throw new Error("Generated glossary candidates must be replaced as one validated JSON document, not appended.");
          validateGeneratedGlossaryContent(input.content, relativePath);
        }
        if (relativePath === WORKSPACE_CHARACTER_BIBLE) {
          if (input.append) throw new Error("The generated character bible must be replaced as one validated Markdown document, not appended.");
          validateGeneratedCharacterBibleContent(input.content, relativePath);
        }
        const result = await writeProjectFile({ outputDir: request.outputDir, relativePath, content: input.content, append: input.append });
        if (!result.ok) throw new Error(result.error);
        if (relativePath === WORKSPACE_GLOSSARY || relativePath === WORKSPACE_CHARACTER_BIBLE) {
          await readWorkspaceAssetsStatus(request.outputDir);
        }
        context.domainRun?.recordWorkflowWrite(relativePath);
        return textResult(result);
      }
    },
    {
      name: "listProjectDir",
      label: "List directory",
      description: "List a directory. Relative paths use the current project; absolute paths may point to user-provided external reference folders. This tool never writes.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
      }),
      async execute(_toolCallId, params) {
        const input = params as { path?: string; maxEntries?: number };
        const result = await listProjectDir({ outputDir: request.outputDir, relativePath: input.path, maxEntries: input.maxEntries });
        if (!result.ok) throw new Error(result.error);
        return textResult(result);
      }
    },
    {
      name: "searchProjectText",
      label: "Search text files",
      description: "Search UTF-8 files for bounded, match-centered terminology or context evidence. A bound source document id or source filename resolves to the actual Host-bound file, including extracted EPUB text. Other relative paths use the current project; absolute paths may point to user-provided external references. Recursive project search excludes generated historical review HTML; pass an exact HTML path only when genuinely required. This tool never writes.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        path: Type.Optional(Type.String()),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
      }),
      async execute(_toolCallId, params) {
        const input = params as { query: string; path?: string; maxResults?: number };
        const result = await searchProjectText({
          outputDir: request.outputDir,
          relativePath: resolvePiReadablePath(request, input.path),
          query: input.query,
          maxResults: input.maxResults
        });
        if (!result.ok) throw new Error(result.error);
        return textResult(result);
      }
    },
    {
      name: "searchTranslationMemory",
      label: "Search translation memory",
      description: "Search prior aligned source/target segments in the current project translation memory.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
      }),
      async execute(_toolCallId, params) {
        const input = params as { query?: string; maxResults?: number };
        return textResult(await searchTranslationMemory({ outputDir: request.outputDir, ...input }));
      }
    },
    {
      requiresSourceManifest: true,
      name: "inspectTranslationAlignment",
      label: "Inspect translation alignment",
      description: "Open a hash-bound alignment review only for a parent-owned single-line translation or bounded local repair. Full multi-line workflows delegate chunk review to the read-only translation-review Pi pool.",
      parameters: Type.Object({
        auditId: Type.Optional(Type.String({ minLength: 1 }))
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        assertParentOwnsAlignmentReview();
        const input = params as { auditId?: string };
        if (context.domainRun?.fullWorkflow !== true) {
          if (manifest?.kind === "folder") {
            const pendingDocumentIds = [
              ...(context.domainRun?.pendingTranslationValidationDocumentIds() ?? []),
              ...Object.keys(translationAlignmentState.ranges)
            ];
            const pendingDocumentId = pendingDocumentIds.find((id, index) => (
              pendingDocumentIds.indexOf(id) === index
              && (translationAlignmentState.ranges[id]?.some((scope) => scope.checks.some((check) => !check.verdict)) ?? false)
            ));
            if (pendingDocumentId && pendingDocumentId !== documentId(request)) {
              selectDocument(pendingDocumentId);
            }
          }
          const currentDocumentId = documentId(request);
          let scopes = await canonicalizeBoundedTranslationAlignments(request);
          if (scopes.length === 0) {
            const sourceLineCount = splitTextLines(await readFile(sourcePath(request), "utf8")).length;
            scopes = [await registerBoundedTranslationAlignment(request, {
              fromLine: 1,
              toLine: sourceLineCount
            })];
            await context.persistHostState?.();
          }
          const audit = scopes.find((scope) => scope.checks.some((check) => !check.verdict)) ?? scopes[0];
          return textResult({
            auditId: audit.auditId,
            documentId: currentDocumentId,
            sourceLineCount: audit.sourceLineCount,
            bounded: true,
            fromLine: audit.fromLine,
            toLine: audit.toLine,
            riskLineCount: audit.riskLineCount,
            sampledLineCount: audit.sampledLineCount,
            remainingRangeCount: scopes.filter((scope) => scope.auditId !== audit.auditId).length,
            ...translationAlignmentProgress(audit)
          });
        }
        const resolvedManifest = await ensureManifest();
        const requestedAuditId = input.auditId?.trim();
        const activeWriteConflict = !requestedAuditId && resolvedManifest.documents.some((document) => (
          context.subagents.hasWriteConflict?.({
            documentId: document.id,
            fromLine: 1,
            toLine: document.lineCount
          }) === true
        ));
        if (activeWriteConflict) {
          throw new Error(
            "A translation writer owns part of this document. Inspect its exact review auditId instead of creating a competing whole-document audit."
          );
        }
        const rangeEntries = () => Object.entries(translationAlignmentState.ranges)
          .flatMap(([ownerDocumentId, scopes]) => scopes.map((scope) => ({ ownerDocumentId, scope })));
        let selected = requestedAuditId
          ? rangeEntries().find(({ scope }) => scope.auditId === requestedAuditId)
          : rangeEntries().find(({ scope }) => scope.checks.some((check) => !check.verdict));
        if (requestedAuditId && !selected) {
          throw new Error(`Translation chunk review ${requestedAuditId} is missing or stale.`);
        }
        if (!selected) {
          for (const document of resolvedManifest.documents) {
            const scopes = [...(translationAlignmentState.ranges[document.id] ?? [])]
              .sort((left, right) => left.fromLine - right.fromLine);
            let cursor = 1;
            let missing: { fromLine: number; toLine: number } | undefined;
            for (const scope of scopes) {
              if (scope.fromLine > cursor) {
                missing = { fromLine: cursor, toLine: scope.fromLine - 1 };
                break;
              }
              cursor = Math.max(cursor, scope.toLine + 1);
            }
            if (!missing && cursor <= document.lineCount) {
              missing = { fromLine: cursor, toLine: document.lineCount };
            }
            if (!missing) continue;
            const bound = bindPiSourceDocument(baseRequest, document);
            const scope = await registerTranslationChunkReview(bound, missing);
            selected = { ownerDocumentId: document.id, scope };
            break;
          }
        }
        selected ??= rangeEntries()[0];
        if (!selected) throw new Error("No translation chunk review is available.");
        const selectedDocument = resolvedManifest.documents.find((document) => document.id === selected!.ownerDocumentId);
        if (!selectedDocument) throw new Error(`Source document ${selected.ownerDocumentId} is no longer available.`);
        const selectedBound = bindPiSourceDocument(baseRequest, selectedDocument);
        const selectedSourceLines = splitTextLines(await readFile(sourcePath(selectedBound), "utf8"));
        const selectedCandidateLines = splitTextLines(await readFile(candidatePath(selectedBound), "utf8"));
        if (
          selected.scope.candidatePath !== candidatePath(selectedBound)
          || selected.scope.sourceLineCount !== selectedSourceLines.length
          || selected.scope.inputHash !== currentRangeAlignmentHash(
            selected.scope,
            selectedSourceLines,
            selectedCandidateLines,
            selectedBound.languagePair
          )
        ) {
          selected = {
            ownerDocumentId: selected.ownerDocumentId,
            scope: await registerTranslationChunkReview(selectedBound, selected.scope)
          };
        }
        const audit = selected.scope;
        activeTranslationChunkReview = {
          auditId: audit.auditId,
          documentId: selected.ownerDocumentId,
          bound: selectedBound
        };
        return textResult({
          auditId: audit.auditId,
          documentId: selected.ownerDocumentId,
          sourceLineCount: audit.sourceLineCount,
          bounded: true,
          fromLine: audit.fromLine,
          toLine: audit.toLine,
          riskLineCount: audit.riskLineCount,
          sampledLineCount: audit.sampledLineCount,
          reviewPolicy: "all_mechanical_risks_plus_deterministic_unflagged_sample",
          ...translationAlignmentProgress(audit)
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "recordTranslationAlignmentChecks",
      label: "Record translation alignment checks",
      description: "Submit only concrete failures for a parent-owned single-line translation or bounded local repair. An empty failures array accepts every Host-selected row after both source and translation were read. Correct rows produce no verdict payload or reason. Full multi-line workflows accept review results only from the read-only translation-review Pi pool.",
      parameters: Type.Object({
        auditId: Type.String({ minLength: 1 }),
        failures: Type.Array(Type.Object({
          line: Type.Integer({ minimum: 1 }),
          code: Type.String({ minLength: 1, maxLength: 80 }),
          note: Type.String({ minLength: 1, maxLength: 240 })
        }, { additionalProperties: false }))
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        assertParentOwnsAlignmentReview();
        const input = params as {
          auditId: string;
          failures: Array<{ line: number; code: string; note: string }>;
        };
        await ensureManifest();
        const rangeOwner = Object.entries(translationAlignmentState.ranges)
          .map(([ownerDocumentId, scopes]) => ({
            ownerDocumentId,
            scopes,
            audit: scopes.find((scope) => scope.auditId === input.auditId)
          }))
          .find((entry) => entry.audit);
        const currentDocumentId = rangeOwner?.ownerDocumentId ?? documentId(request);
        const boundedScopes = rangeOwner?.scopes ?? translationAlignmentState.ranges[currentDocumentId] ?? [];
        const boundedAudit = rangeOwner?.audit ?? boundedScopes.find((scope) => scope.auditId === input.auditId);
        const audit = boundedAudit ?? translationAlignmentState.documents[currentDocumentId];
        if (!audit || audit.auditId !== input.auditId) {
          throw new Error("The translation alignment audit is missing or stale. Run inspectTranslationAlignment again.");
        }
        const reviewBound = activeTranslationChunkReview?.auditId === input.auditId
          ? activeTranslationChunkReview.bound
          : await boundForDocument(currentDocumentId);
        const sourceText = await readFile(sourcePath(reviewBound), "utf8");
        const candidateText = await readFile(audit.candidatePath, "utf8");
        const sourceLines = splitTextLines(sourceText);
        const candidateLines = splitTextLines(candidateText);
        const currentHash = boundedAudit
          ? currentRangeAlignmentHash(boundedAudit, sourceLines, candidateLines, reviewBound.languagePair)
          : translationAlignmentInputHash(sourceText, candidateText, reviewBound.languagePair);
        if (audit.inputHash !== currentHash) {
          if (boundedAudit) {
            translationAlignmentState.ranges[currentDocumentId] = boundedScopes
              .filter((scope) => scope.auditId !== boundedAudit.auditId);
          } else {
            delete translationAlignmentState.documents[currentDocumentId];
          }
          await context.persistHostState?.();
          if (activeTranslationChunkReview?.auditId === input.auditId) {
            activeTranslationChunkReview = undefined;
          }
          throw new Error("The translation candidate changed after alignment inspection. Run inspectTranslationAlignment again.");
        }
        const pendingTargets = audit.checks.filter((check) => !check.verdict);
        const byLine = new Map(pendingTargets.map((check) => [check.line, check]));
        for (const target of pendingTargets) {
          const readKey = alignmentReadKey(currentDocumentId, target.line);
          if (!sourceLinesRead.has(readKey) || !translationLinesRead.has(readKey)) {
            throw new Error(
              `Read both source and translation line ${target.line} before submitting the alignment review.`
            );
          }
        }
        const seen = new Set<number>();
        const failures = new Map<number, string>();
        for (const failure of input.failures) {
          if (seen.has(failure.line)) throw new Error(`Duplicate translation alignment failure for line ${failure.line}.`);
          seen.add(failure.line);
          if (!byLine.has(failure.line)) {
            throw new Error(`Line ${failure.line} is not selected by translation alignment audit ${audit.auditId}.`);
          }
          const code = canonicalTranslationReviewCode(failure.code);
          const note = failure.note.trim();
          if (!note) throw new Error(`Translation alignment failure line ${failure.line} requires an actionable note.`);
          failures.set(failure.line, `${code}: ${note}`);
        }
        for (const target of pendingTargets) {
          const reason = failures.get(target.line);
          const verdict = reason ? "misaligned" : "aligned";
          if (target.verdict && target.verdict !== verdict) {
            throw new Error(`Translation alignment line ${target.line} already has a different semantic verdict.`);
          }
          target.verdict = verdict;
          if (reason) target.reason = reason;
          else delete target.reason;
        }
        await context.persistHostState?.();
        const pendingChecks = audit.checks.filter((check) => !check.verdict);
        const misalignedChecks = audit.checks.filter((check) => check.verdict === "misaligned");
        let decision: "pending" | "accepted" | "rejected" = "pending";
        if (pendingChecks.length === 0) {
          if (misalignedChecks.length === 0) {
            decision = "accepted";
          } else {
            decision = "rejected";
          }
          if (activeTranslationChunkReview?.auditId === audit.auditId) {
            activeTranslationChunkReview = undefined;
          }
        }
        return textResult({
          auditId: audit.auditId,
          ...translationAlignmentProgress(audit),
          decision,
          misalignedLines: misalignedChecks.map((check) => check.line)
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "writeTranslationChunk",
      label: "Write translation chunk",
      description: "Strictly validate and atomically write one exact line range into the named translation candidate without changing the active workflow document.",
      parameters: Type.Object({
        documentId: Type.Optional(Type.String({ minLength: 1 })),
        fromLine: Type.Integer({ minimum: 1 }),
        toLine: Type.Integer({ minimum: 1 }),
        lines: Type.Array(Type.String())
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const boundedArtifactRepair = context.domainRun?.fullWorkflow !== true
          || context.domainRun.kind === "proofread"
          || context.domainRun.suspended;
        if (!boundedArtifactRepair) context.domainRun?.activate("translation");
        const input = params as { documentId?: string; fromLine: number; toLine: number; lines: string[] };
        const bound = input.documentId?.trim()
          ? await boundForDocument(input.documentId.trim())
          : request;
        const sourceLines = splitTextLines(await readFile(sourcePath(bound), "utf8"));
        const range = normalizeRange(input.fromLine, input.toLine, sourceLines.length);
        if (context.subagents.hasWriteConflict?.({
          documentId: documentId(bound),
          ...range
        }) === true) {
          throw new Error(
            `Translation write L${range.fromLine}-L${range.toLine} overlaps an active child writer for ${documentId(bound)}.`
          );
        }
        const expected = range.toLine - range.fromLine + 1;
        if (input.lines.length !== expected) {
          throw new Error(`Range ${range.fromLine}-${range.toLine} requires exactly ${expected} lines; received ${input.lines.length}.`);
        }
        const validation = validateTranslationCandidate(
          sourceLines.slice(range.fromLine - 1, range.toLine).join("\n"),
          input.lines.join("\n"),
          await createYnTranslationValidationOptions(bound)
        );
        if (!boundedArtifactRepair) {
          assertYnTranslationArtifactAccepted(validation, `Chunk L${range.fromLine}-L${range.toLine}`);
        } else {
          assertYnTranslationChunkWritable(validation, `Chunk L${range.fromLine}-L${range.toLine}`);
        }
        if (!boundedArtifactRepair) {
          assertTranslationChunkReviewRangeAvailable(documentId(bound), range);
          await prepareExistingTranslationForWrite(bound);
        }
        const targetCandidatePath = candidatePath(bound);
        const previousCandidateText = await readOptional(targetCandidatePath);
        const previousAlignmentState = structuredClone(translationAlignmentState);
        const previousProofreadState = structuredClone(proofreadState);
        const result = await writeTranslationChunk({
          outputDir: bound.outputDir,
          sourcePaths: [sourcePath(bound)],
          documentId: documentId(bound),
          ...range,
          lines: input.lines
        });
        if (!result.ok) throw new Error(result.error || "Translation chunk write failed.");
        let rollbackDomainMutation: (() => void) | undefined;
        try {
          if (boundedArtifactRepair) {
            rollbackDomainMutation = context.domainRun?.recordTranslationArtifactMutation(documentId(bound), range);
            if (context.domainRun?.kind === "proofread") {
              await refreshProofreadPrescanAfterBoundedMutation(bound, range);
            }
            await registerBoundedTranslationAlignment(bound, range, { parentOwnedMutation: true });
            await context.persistHostState?.();
          } else {
            rollbackDomainMutation = context.domainRun?.recordTranslationWrite("translation");
            await registerTranslationChunkReview(bound, range);
          }
        } catch (error) {
          rollbackDomainMutation?.();
          restoreMutableObject(translationAlignmentState, previousAlignmentState);
          restoreMutableObject(proofreadState, previousProofreadState);
          const rollbackFailures: unknown[] = [];
          try {
            if (previousCandidateText === undefined) await rm(targetCandidatePath, { force: true });
            else await writeTextFileAtomically(targetCandidatePath, previousCandidateText);
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
          try {
            await context.persistHostState?.();
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
          if (rollbackFailures.length > 0) {
            throw new AggregateError(
              [error, ...rollbackFailures],
              `Translation write L${range.fromLine}-L${range.toLine} failed and its rollback was incomplete.`
            );
          }
          throw error;
        }
        return textResult({
          result,
          validation: compactYnTranslationValidation(
            validation,
            boundedArtifactRepair ? "chunk" : "artifact"
          )
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "validateTranslationArtifact",
      label: "Validate translation artifact",
      description: "Run final validation for the bound file, every file in a generated folder workflow, or only the mutated documents in a bounded folder repair.",
      parameters: Type.Object({}),
      async execute() {
        const boundedArtifactValidation = context.domainRun?.fullWorkflow !== true
          || context.domainRun.kind === "proofread"
          || context.domainRun.suspended;
        if (!boundedArtifactValidation) context.domainRun?.activate("translation");
        const documents = (() => {
          if (manifest?.kind !== "folder") {
            return [{ id: documentId(request), path: sourcePath(request), lineCount: 0 }];
          }
          const folderManifest = manifest;
          if (!boundedArtifactValidation) return folderManifest.documents;
          const pendingIds = context.domainRun?.pendingTranslationValidationDocumentIds() ?? [];
          const selectedIds = pendingIds.length > 0 ? pendingIds : [documentId(request)];
          return selectedIds.map((id) => {
            const document = folderManifest.documents.find((candidate) => candidate.id === id);
            if (!document) throw new Error(`Bounded validation document ${id} is not in the host source manifest.`);
            return document;
          });
        })();
        const results = [];
        const warningDocuments: Array<{
          documentId: string;
          path: string;
          warningCount: number;
          warningByCode: Record<string, number>;
          warningLineRanges: string[];
          warningSamples: unknown[];
          omittedWarningSampleCount: number;
        }> = [];
        const failures: string[] = [];
        const validationHashes: Array<{ documentId: string; hash: string }> = [];
        const terminologyDebt: YnTranslationTerminologyDebt[] = [];
        const warningByCode: Record<string, number> = {};
        let totalSourceLineCount = 0;
        let totalWarningCount = 0;
        let acceptedDocumentCount = 0;
        for (const document of documents) {
          const bound = manifest?.kind === "folder"
            ? bindPiSourceDocument(baseRequest, document)
            : request;
          const sourceText = await readFile(sourcePath(bound), "utf8");
          const candidate = candidatePath(bound);
          const candidateText = await readOptional(candidate);
          if (!candidateText) {
            failures.push(`${document.id}: candidate does not exist at ${candidate}`);
            continue;
          }
          const validationOptions = await createYnTranslationValidationOptions(bound);
          const validation = validateTranslationCandidate(sourceText, candidateText, validationOptions);
          const validationHash = createHash("sha256")
            .update(sourceText)
            .update("\0")
            .update(candidateText)
            .update("\0")
            .update(JSON.stringify(validationOptions))
            .digest("hex");
          validationHashes.push({ documentId: document.id, hash: validationHash });
          if (!boundedArtifactValidation && isYnTranslationArtifactAccepted(validation)) {
            await requireCurrentTranslationChunkReviews(bound, sourceText, candidateText, candidate);
          } else if (boundedArtifactValidation && isYnTranslationChunkWritable(validation)) {
            await requireCurrentBoundedTranslationAlignment(bound, sourceText, candidateText, candidate);
          }
          const acceptance = boundedArtifactValidation ? "chunk" : "artifact";
          if (!boundedArtifactValidation || (
            context.domainRun?.fullWorkflow === false
            && context.domainRun.kind === "translation"
          )) {
            context.domainRun?.recordTranslationValidation(
              "translation",
              ynTranslationValidationDebt(validation, acceptance),
              document.id
            );
          }
          const compactValidation = compactYnTranslationValidation(validation, acceptance);
          results.push({ documentId: document.id, path: candidate, validation: compactValidation });
          const accepted = acceptance === "artifact"
            ? isYnTranslationArtifactAccepted(validation)
            : isYnTranslationChunkWritable(validation);
          if (!accepted) {
            failures.push([
              `${document.id}: ${validation.summary}`,
              compactValidation.blockingLineRanges.length > 0
                ? `blocking lines ${compactValidation.blockingLineRanges.join(", ")}`
                : "",
              compactValidation.qualityDebtLineRanges.length > 0
                ? `quality-debt lines ${compactValidation.qualityDebtLineRanges.join(", ")}`
                : ""
            ].filter(Boolean).join("; "));
          } else {
            acceptedDocumentCount += 1;
          }
          totalSourceLineCount += validation.sourceLineCount;
          totalWarningCount += validation.warnings.length;
          for (const [code, count] of Object.entries(compactValidation.warningByCode)) {
            warningByCode[code] = (warningByCode[code] ?? 0) + count;
          }
          if (validation.warnings.length > 0) {
            warningDocuments.push({
              documentId: document.id,
              path: candidate,
              warningCount: validation.warnings.length,
              warningByCode: compactValidation.warningByCode,
              warningLineRanges: compactValidation.warningLineRanges,
              warningSamples: compactValidation.warningSamples.slice(0, 4),
              omittedWarningSampleCount: Math.max(0, compactValidation.warningSamples.length - 4)
            });
          }
          if (glossaryCandidateCollectionEnabled) {
            terminologyDebt.push(...scanResolvedTerminologyDebt({
              documentId: document.id,
              sourceLines: splitTextLines(sourceText),
              candidateLines: splitTextLines(candidateText),
              terms: context.domainRun?.resolvedTranslationTerms() ?? []
            }));
          }
        }
        context.domainRun?.recordTranslationTerminologyDebt(terminologyDebt);
        if (terminologyDebt.length > 0) {
          const sample = terminologyDebt.slice(0, 32).map((entry) => (
            `${entry.documentId} L${entry.line}: ${entry.source} must use ${entry.expectedTarget}; `
            + `found ${entry.observedTargets.join(", ")}`
          ));
          failures.push(
            `Cross-file terminology consistency failed on ${terminologyDebt.length} line(s):\n${sample.join("\n")}`
            + (terminologyDebt.length > sample.length ? `\n${terminologyDebt.length - sample.length} additional lines omitted.` : "")
          );
        }
        if (failures.length > 0) throw new Error(`Final translation validation failed:\n${failures.join("\n")}`);
        if (boundedArtifactValidation) {
          for (const document of documents) delete translationAlignmentState.ranges[document.id];
          await context.persistHostState?.();
        }
        if (manifest?.kind !== "folder") return textResult(results[0]);
        const aggregateHash = createHash("sha256")
          .update(JSON.stringify(validationHashes.sort((left, right) => left.documentId.localeCompare(right.documentId, "en"))))
          .digest("hex");
        const warningSample = warningDocuments.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS);
        return textResult({
          status: "accepted",
          validationHash: aggregateHash,
          documentCount: documents.length,
          acceptedDocumentCount,
          totalSourceLineCount,
          totalWarningCount,
          warningByCode,
          warningDocuments: warningSample,
          omittedWarningDocumentCount: Math.max(0, warningDocuments.length - warningSample.length),
          completion: {
            complete: (context.domainRun?.incompleteReasons().length ?? 0) === 0,
            remainingReasonCount: context.domainRun?.incompleteReasons().length ?? 0
          }
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "writeProofreadFindings",
      label: "Write proofread findings",
      description: "Validate normalized JSON proofreading findings for the bound source and translation candidate. Full-workflow writes append; a hash-bound scope atomically replaces all prior findings in that exact range, including clearing them when the new findings list is empty.",
      parameters: Type.Object({
        findings: Type.Array(Type.Object({
          id: Type.String(),
          severity: Type.String(),
          type: Type.String(),
          sourceLine: Type.Integer({ minimum: 1 }),
          translationLine: Type.Integer({ minimum: 1 }),
          sourceText: Type.String(),
          currentTranslation: Type.String(),
          suggestedFix: Type.String(),
          rationale: Type.String(),
          needsVerification: Type.Optional(Type.Boolean())
        })),
        chunkLabel: Type.Optional(Type.String()),
        mode: Type.Optional(Type.Union([Type.Literal("split"), Type.Literal("montecarlo")])),
        scopeId: Type.Optional(Type.String({ minLength: 1 }))
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as {
          findings: Array<Record<string, unknown>>;
          chunkLabel?: string;
          mode?: "split" | "montecarlo";
          scopeId?: string;
        };
        const localScope = input.scopeId ? await requireCurrentProofreadScope(input.scopeId) : undefined;
        if (!localScope && context.isWorkflowSuspended?.()) {
          throw new Error(
            "The complete proofreading workflow is suspended. Resume it before replacing the full findings artifact; bounded scopeId writes remain independent."
          );
        }
        let mechanicalScan: NonNullable<Parameters<typeof writeProofreadFindings>[0]["mechanicalScan"]>;
        if (!localScope) {
          context.domainRun?.activate("proofread");
          const current = await requireCurrentProofreadPrescan();
          mechanicalScan = {
            scopeLines: current.sourceLines.map((_line, index) => index + 1),
            signals: current.prescan.signals
          };
          context.domainRun?.assertCanRecordFindingsWrite("proofread");
        } else {
          const sourceLines = splitTextLines(await readFile(sourcePath(request), "utf8"));
          const translationPath = proofreadTranslationPath(request, manifest?.kind === "folder");
          const translationLines = splitTextLines(await readFile(translationPath, "utf8"));
          const validationOptions = await createYnTranslationValidationOptions(request);
          mechanicalScan = {
            scopeLines: Array.from(
              { length: localScope.toLine - localScope.fromLine + 1 },
              (_entry, index) => localScope.fromLine + index
            ),
            signals: buildProofreadDeterministicSignals({
              sourceText: sourceLines.slice(localScope.fromLine - 1, localScope.toLine).join("\n"),
              translationText: translationLines.slice(localScope.fromLine - 1, localScope.toLine).join("\n"),
              validationOptions
            }).map((signal) => ({ ...signal, line: signal.line + localScope.fromLine - 1 }))
          };
        }
        const currentDocumentState = proofreadDocumentHostState(proofreadState, documentId(request));
        const replaceDocument = !localScope && !currentDocumentState.reportInitialized;
        if (localScope) {
          for (const finding of input.findings) {
            const sourceLine = Number(finding.sourceLine);
            const translationLine = Number(finding.translationLine);
            if (
              sourceLine < localScope.fromLine || sourceLine > localScope.toLine
              || translationLine < localScope.fromLine || translationLine > localScope.toLine
            ) {
              throw new Error(
                `Finding line ${sourceLine}/${translationLine} is outside proofread range ${localScope.fromLine}-${localScope.toLine}.`
              );
            }
          }
        }
        const writeArgs: Parameters<typeof writeProofreadFindings>[0] = {
          outputDir: request.outputDir,
          sourcePaths: [sourcePath(request)],
          documentId: documentId(request),
          reportScope: proofreadReportScope(request),
          translationPath: proofreadTranslationPath(request, manifest?.kind === "folder"),
          kind: "findings_json",
          content: JSON.stringify(input.findings),
          chunkLabel: input.chunkLabel,
          mode: input.mode ?? "split",
          excludedLines: request.auditWhitelistLines,
          mechanicalScan,
          ...(replaceDocument ? { replaceDocument: true } : {}),
          ...(localScope ? {
            replaceRange: { fromLine: localScope.fromLine, toLine: localScope.toLine }
          } : {})
        };
        const result = await writeProofreadFindings(writeArgs);
        if (!result.ok) throw new Error(result.error || "Proofread findings write failed.");
        if (!localScope) {
          if (replaceDocument) {
            context.domainRun?.recordProofreadArtifactReset();
            currentDocumentState.reportInitialized = true;
          }
          context.domainRun?.recordFindingsWrite("proofread", result.appended);
        } else {
          context.domainRun?.recordProofreadRangeValidated(
            localScope.documentId,
            localScope.fromLine,
            localScope.toLine
          );
          await context.persistHostState?.();
        }
        return textResult(result);
      }
    },
    {
      name: "resolveProofreadGlossaryCandidates",
      label: "Resolve proofreading glossary candidates",
      description: "Accept or reject evidence-bound proper-term candidates returned by proofreading children. Accepted candidates are merged into the validated workspace glossary candidate JSON; ordinary vocabulary must be rejected. Finalization is blocked while any candidate remains pending.",
      parameters: Type.Object({
        decisions: Type.Array(Type.Object({
          candidateId: Type.String({ minLength: 1 }),
          action: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
          rationale: Type.String({ minLength: 1, maxLength: 2_000 })
        }, { additionalProperties: false }), { minItems: 1 })
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const resolvedManifest = await ensureManifest();
        await Promise.all(resolvedManifest.documents.map((document) => (
          requireProofreadPrescanForBound(bindPiSourceDocument(baseRequest, document))
        )));
        const input = params as {
          decisions: Array<{ candidateId: string; action: "accept" | "reject"; rationale: string }>;
        };
        const documentStates = resolvedManifest.kind === "folder"
          ? resolvedManifest.documents.map((document) => proofreadDocumentHostState(proofreadState, document.id))
          : [proofreadDocumentHostState(proofreadState, documentId(request))];
        const allCandidates = documentStates.flatMap((state) => state.glossaryCandidates);
        const byId = new Map<string, typeof allCandidates>();
        for (const candidate of allCandidates) {
          const matches = byId.get(candidate.id) ?? [];
          matches.push(candidate);
          byId.set(candidate.id, matches);
        }
        const seen = new Set<string>();
        const resolved = input.decisions.map((decision) => {
          if (seen.has(decision.candidateId)) {
            throw new Error(`Duplicate proofreading glossary decision for ${decision.candidateId}.`);
          }
          seen.add(decision.candidateId);
          const candidates = byId.get(decision.candidateId);
          if (!candidates?.length) throw new Error(`Unknown proofreading glossary candidate ${decision.candidateId}.`);
          const targetStatus = decision.action === "accept" ? "accepted" : "rejected";
          if (candidates.some((candidate) => candidate.status !== "pending" && candidate.status !== targetStatus)) {
            throw new Error(
              `Proofreading glossary candidate ${decision.candidateId} already has a conflicting persisted decision; do not reverse it implicitly.`
            );
          }
          return { candidates, targetStatus, rationale: decision.rationale.trim() } as const;
        });
        const accepted = resolved.filter((entry) => (
          entry.targetStatus === "accepted" && entry.candidates.some((candidate) => candidate.status === "pending")
        ));
        if (accepted.length > 0) {
          const glossaryPath = resolveProjectPath(request.outputDir, WORKSPACE_GLOSSARY);
          const existingContent = await readOptional(glossaryPath);
          const entries = existingContent
            ? validateGeneratedGlossaryContent(existingContent, WORKSPACE_GLOSSARY)
            : [];
          const bySource = new Map(entries.map((entry) => [entry.source.trim().normalize("NFC"), entry]));
          for (const { candidates } of accepted) {
            const candidate = candidates[0];
            const sourceKey = candidate.source.trim().normalize("NFC");
            const existing = bySource.get(sourceKey);
            if (existing && existing.target.trim().normalize("NFC") !== candidate.target.trim().normalize("NFC")) {
              throw new Error(
                `Accepted proofreading candidate ${candidate.id} conflicts with the existing target for ${candidate.source}; resolve the shared glossary explicitly.`
              );
            }
            const info = `proofread ${candidate.category}; evidence line ${candidate.evidenceLine}; ${candidate.rationale}`;
            if (existing) {
              existing.aliases = [...new Set([...(existing.aliases ?? []), ...(candidate.aliases ?? [])])];
              existing.info ||= info;
              existing.status ||= "pending";
            } else {
              const entry = {
                source: candidate.source,
                target: candidate.target,
                ...(candidate.aliases?.length ? { aliases: candidate.aliases } : {}),
                info,
                status: "pending" as const
              };
              entries.push(entry);
              bySource.set(sourceKey, entry);
            }
          }
          const content = `${JSON.stringify({ entries }, null, 2)}\n`;
          validateGeneratedGlossaryContent(content, WORKSPACE_GLOSSARY);
          const writeResult = await writeProjectFile({
            outputDir: request.outputDir,
            relativePath: WORKSPACE_GLOSSARY,
            content
          });
          if (!writeResult.ok) throw new Error(writeResult.error);
          await readWorkspaceAssetsStatus(request.outputDir);
          context.domainRun?.recordWorkflowWrite(WORKSPACE_GLOSSARY);
        }
        for (const entry of resolved) {
          for (const candidate of entry.candidates) {
            candidate.status = entry.targetStatus;
            candidate.decisionRationale = entry.rationale;
          }
        }
        const summarizedCandidates = summarizeProofreadGlossaryCandidates(allCandidates);
        const pending = summarizedCandidates.filter((candidate) => candidate.status === "pending");
        return textResult({
          resolved: resolved.length,
          accepted: summarizedCandidates.filter((candidate) => candidate.status === "accepted").length,
          rejected: summarizedCandidates.filter((candidate) => candidate.status === "rejected").length,
          pending
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "finalizeProofreadReport",
      label: "Finalize proofreading JSON",
      description: "Validate the sole merged findings JSON artifact and close the proofreading completion gate. Call only after all split children, or after the host reports Monte Carlo convergence.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, _params) {
        context.domainRun?.activate("proofread");
        const resolvedManifest = await ensureManifest();
        const boundDocuments = resolvedManifest.documents.map((document) => ({
          document,
          bound: bindPiSourceDocument(baseRequest, document)
        }));
        await Promise.all(boundDocuments.map(({ bound }) => requireProofreadPrescanForBound(bound)));
        const pendingCandidates = summarizeProofreadGlossaryCandidates(
          boundDocuments.flatMap(({ document }) => (
            proofreadDocumentHostState(proofreadState, document.id).glossaryCandidates.map((candidate) => ({
              ...candidate,
              documentId: document.id
            }))
          ))
        ).filter((candidate) => candidate.status === "pending");
        if (pendingCandidates.length > 0) {
          throw new Error(
            `Resolve ${pendingCandidates.length} pending proofreading glossary candidate(s) with resolveProofreadGlossaryCandidates before finalizing.`
          );
        }
        const findingsPath = resolveProofreadReportPath({
          outputDir: request.outputDir,
          sourcePaths: [sourcePath(request)],
          documentId: documentId(request),
          reportScope: proofreadReportScope(request),
          kind: "findings_json"
        });
        const document = JSON.parse(await readFile(findingsPath, "utf8")) as {
          findings?: Array<{
            id?: unknown;
            severity?: unknown;
            type?: unknown;
            sourceLine?: unknown;
            sourceText?: unknown;
            currentTranslation?: unknown;
            suggestedFix?: unknown;
          }>;
          summaryPath?: unknown;
          [key: string]: unknown;
        };
        if (!Array.isArray(document.findings)) {
          throw new Error("The normalized proofreading findings artifact is missing or malformed.");
        }
        const legacyMechanicalCount = document.findings.length;
        document.findings = document.findings.filter((finding) => (
          String(finding.type ?? "").trim().toLowerCase() !== "mechanical_scan"
          && String(finding.severity ?? "").trim().toUpperCase() !== "M0"
          && !/^M0(?:-|$)/i.test(String(finding.id ?? "").trim())
        ));
        const removedLegacyMechanicalCount = legacyMechanicalCount - document.findings.length;
        const preNoOpCount = document.findings.length;
        document.findings = document.findings.filter((finding) => (
          typeof finding.currentTranslation !== "string"
          || typeof finding.suggestedFix !== "string"
          || proofreadSuggestedFixChangesTranslation({
            currentTranslation: finding.currentTranslation,
            suggestedFix: finding.suggestedFix
          })
        ));
        const removedNoOpFindingCount = preNoOpCount - document.findings.length;
        for (const finding of document.findings) {
          if (
            typeof finding.sourceText !== "string"
            || typeof finding.currentTranslation !== "string"
            || typeof finding.suggestedFix !== "string"
            || !proofreadSuggestedFixPreservesControlPrefix({
              sourceText: finding.sourceText,
              currentTranslation: finding.currentTranslation,
              suggestedFix: finding.suggestedFix
            })
          ) {
            throw new Error(
              `Proofreading finding ${String(finding.id ?? "(missing id)")} has an unsafe suggestedFix control prefix on line ${String(finding.sourceLine ?? "unknown")}; rerun that split before finalizing.`
            );
          }
        }
        const counts = new Map<string, number>();
        for (const finding of document.findings) {
          const severity = String(finding.severity ?? "unknown").trim() || "unknown";
          counts.set(severity, (counts.get(severity) ?? 0) + 1);
        }
        for (const { document } of boundDocuments) {
          context.domainRun?.assertProofreadReportReady(document.id);
        }
        if (
          Object.hasOwn(document, "summaryPath")
          || removedLegacyMechanicalCount > 0
          || removedNoOpFindingCount > 0
        ) {
          delete document.summaryPath;
          await writeTextFileAtomically(findingsPath, `${JSON.stringify(document, null, 2)}\n`);
        }
        await removeLegacyProofreadSummary({
          outputDir: request.outputDir,
          sourcePaths: [sourcePath(request)],
          documentId: documentId(request),
          reportScope: proofreadReportScope(request),
        });
        for (const { document: manifestDocument } of boundDocuments) {
          context.domainRun?.recordProofreadReportFinalized(manifestDocument.id);
        }
        return textResult({
          ok: true,
          path: findingsPath,
          relativePath: relativeProjectPath(request.outputDir, findingsPath),
          kind: "findings_json",
          finalized: true,
          documentCount: boundDocuments.length,
          findings: document.findings.length,
          removedLegacyMechanicalCount,
          removedNoOpFindingCount,
          severityCounts: Object.fromEntries(counts)
        });
      }
    },
    {
      name: "resolveProofreadMontecarloLimit",
      label: "Resolve Monte Carlo limit",
      description: "Apply the user's explicit choice after Monte Carlo reaches its round ceiling without convergence: continue for three rounds, switch only HOT regions to split review, or stop and finalize current findings.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("continue_sampling"),
          Type.Literal("switch_to_split"),
          Type.Literal("stop_and_finalize")
        ])
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as {
          action: "continue_sampling" | "switch_to_split" | "stop_and_finalize";
        };
        context.domainRun?.resolveProofreadMontecarloLimit(input.action);
        return textResult({
          accepted: true,
          action: input.action,
          mode: context.domainRun?.proofreadMode,
          hotSplitRequested: context.domainRun?.proofreadHotSplitRequested,
          roundMaximum: context.domainRun?.proofreadMontecarloRoundMaximum
        });
      }
    },
    {
      requiresSourceManifest: true,
      name: "runProofreadSubagents",
      label: "Run proofreading subagents",
      description: "Start host-planned native Pi proofreading workers in the background. In split mode, splitSize defines queued assignment blocks while workerCount only limits persistent Pi worker concurrency. The host owns every line assignment; optional worker records only select labels or configured models.",
      parameters: Type.Object({
        workerCount: Type.Optional(Type.Integer({ minimum: 1 })),
        workers: Type.Optional(Type.Array(Type.Object({
          label: Type.Optional(Type.String()),
          providerId: Type.Optional(Type.String()),
          modelId: Type.Optional(Type.String())
        })))
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        context.domainRun?.assertCanStartSubagentBatch("proofread");
        const input = params as {
          workerCount?: number;
          workers?: Array<{ label?: string; providerId?: string; modelId?: string }>;
        };
        const resolvedManifest = await ensureManifest();
        const currentPrescan = await requireCurrentProofreadPrescan();
        const {
          sourceLines,
          translationLines,
          prescan
        } = currentPrescan;
        const deterministicSignals = prescan.signals;
        const currentDocumentId = documentId(request);
        const currentDocumentState = proofreadDocumentHostState(proofreadState, currentDocumentId);
        const sampledLines = sampledLinesFor(currentDocumentId);
        const mode = context.domainRun?.proofreadMode ?? request.proofreadMode ?? "split";
        const hotSplitRequested = mode === "montecarlo"
          && context.domainRun?.proofreadHotSplitRequested === true;
        if (resolvedManifest.kind === "folder" && mode === "montecarlo") {
          throw new Error(
            "Folder proofreading supports split mode only. Monte Carlo state is document-scoped; select a single source file before using Monte Carlo mode."
          );
        }
        const folderPrescans = resolvedManifest.kind === "folder"
          ? await Promise.all(resolvedManifest.documents.map(async (document) => ({
              document,
              scan: await requireProofreadPrescanForBound(bindPiSourceDocument(baseRequest, document))
            })))
          : undefined;
        const planningSummary = folderPrescans
          ? aggregateProofreadPrescans(folderPrescans.map((entry) => entry.scan))
          : prescan.summary;
        const nextMontecarloRound = (context.domainRun?.proofreadMontecarloRoundsCompleted ?? 0) + 1;
        if (
          mode === "montecarlo"
          && !hotSplitRequested
          && nextMontecarloRound > (context.domainRun?.proofreadMontecarloRoundMaximum ?? request.proofreadMontecarloRoundMax ?? 5)
        ) {
          throw new Error("The configured maximum Monte Carlo proofreading rounds has already been reached.");
        }
        const dynamicSplitQueue = mode === "split" || hotSplitRequested;
        const configuredMaximum = configuredSubagentMaximum(request, context.domainRun);
        const domainSnapshot = typeof context.domainRun?.snapshot === "function"
          ? context.domainRun.snapshot()
          : undefined;
        const completedDomainDocuments = new Set((domainSnapshot?.documents ?? [])
          .filter((document) => (
            document.completedSubagentBatch?.kind === "proofread"
            && document.completedSubagentBatch.documentId === document.id
            && document.completedSubagentBatch.sourceLineCount === document.sourceLineCount
            && document.findingsWritten
            && document.validatedProofreadArtifactRevision === document.proofreadArtifactRevision
            && document.proofreadDirtyRanges.length === 0
          ))
          .map((document) => document.id));
        let existingReport: {
          schemaVersion?: unknown;
          findings?: Array<{
            documentId?: unknown;
            id?: unknown;
            severity?: unknown;
            type?: unknown;
            sourceText?: unknown;
            currentTranslation?: unknown;
            suggestedFix?: unknown;
          }>;
        } | undefined;
        if (dynamicSplitQueue && completedDomainDocuments.size > 0) {
          const findingsPath = resolveProofreadReportPath({
            outputDir: request.outputDir,
            sourcePaths: [sourcePath(request)],
            documentId: documentId(request),
            reportScope: proofreadReportScope(request),
            kind: "findings_json"
          });
          try {
            existingReport = JSON.parse(await readFile(findingsPath, "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw new Error(
                `Unable to validate completed proofreading scopes from ${findingsPath}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        }
        const legacyReportSliceIsSafe = (ownerDocumentId: string): boolean => {
          if (!Array.isArray(existingReport?.findings)) return false;
          const findings = existingReport.schemaVersion === "2.0"
            ? existingReport.findings.filter((finding) => finding.documentId === ownerDocumentId)
            : existingReport.findings;
          return findings.every((finding) => {
            const mechanical = String(finding.type ?? "").trim().toLowerCase() === "mechanical_scan"
              || String(finding.severity ?? "").trim().toUpperCase() === "M0"
              || /^M0(?:-|$)/i.test(String(finding.id ?? "").trim());
            if (mechanical) return true;
            return typeof finding.sourceText === "string"
              && typeof finding.currentTranslation === "string"
              && typeof finding.suggestedFix === "string"
              && proofreadSuggestedFixPreservesControlPrefix({
                sourceText: finding.sourceText,
                currentTranslation: finding.currentTranslation,
                suggestedFix: finding.suggestedFix
              });
          });
        };
        let completedScopeStateChanged = false;
        const completedScopesFor = (
          ownerDocumentId: string,
          scan: Awaited<ReturnType<typeof buildProofreadPrescan>>
        ): ProofreadCompletedSplitScope[] => {
          const ownerState = proofreadDocumentHostState(proofreadState, ownerDocumentId);
          const before = JSON.stringify(ownerState.completedSplitScopes);
          if (completedDomainDocuments.has(ownerDocumentId) && legacyReportSliceIsSafe(ownerDocumentId)) {
            recordCompletedProofreadSplitScope(ownerState, {
              inputHash: scan.prescan.inputHash,
              translationPath: scan.translationPath,
              fromLine: 1,
              toLine: scan.sourceLines.length
            });
          }
          const scopes = currentProofreadSplitScopes(
            ownerState,
            scan.prescan.inputHash,
            scan.translationPath
          );
          if (JSON.stringify(ownerState.completedSplitScopes) !== before) completedScopeStateChanged = true;
          return scopes;
        };
        const folderSplitTasks = folderPrescans && dynamicSplitQueue
          ? folderPrescans.flatMap(({ document, scan }) => subtractCompletedProofreadScopes(
              createSplitProofreadTasks({
                totalLines: scan.sourceLines.length,
                workerCount: 1,
                splitSize: request.proofreadSplitSize ?? YN_DEFAULT_SPLIT_SIZE,
                signals: scan.prescan.signals
              }).map((task) => ({
                ...task,
                documentId: document.id,
                label: `Proofread ${document.id} L${task.fromLine}-L${task.toLine}`
              })),
              completedScopesFor(document.id, scan)
            ))
          : undefined;
        const currentSplitTasks = !folderPrescans && dynamicSplitQueue
          ? subtractCompletedProofreadScopes(
              (hotSplitRequested
                ? createHotSplitProofreadTasks({
                    totalLines: sourceLines.length,
                    workerCount: 1,
                    splitSize: request.proofreadSplitSize ?? YN_DEFAULT_SPLIT_SIZE,
                    signals: deterministicSignals
                  })
                : createSplitProofreadTasks({
                    totalLines: sourceLines.length,
                    workerCount: 1,
                    splitSize: request.proofreadSplitSize ?? YN_DEFAULT_SPLIT_SIZE,
                    signals: deterministicSignals
                  })),
              completedScopesFor(currentDocumentId, currentPrescan)
            )
          : undefined;
        const remainingSplitTasks = folderSplitTasks ?? currentSplitTasks;
        const usefulMaximum = dynamicSplitQueue
          ? Math.min(configuredMaximum, remainingSplitTasks?.length ?? 0)
          : effectiveSubagentCount(request, sourceLines.length, context.domainRun);
        if (dynamicSplitQueue) {
          const remainingDocumentIds = new Set((remainingSplitTasks ?? [])
            .map((task) => task.documentId ?? currentDocumentId));
          const recovered = (folderPrescans
            ? folderPrescans.map(({ document, scan }) => ({
                documentId: document.id,
                scopeCount: completedScopesFor(document.id, scan).length
              }))
            : [{
                documentId: currentDocumentId,
                scopeCount: completedScopesFor(currentDocumentId, currentPrescan).length
              }])
            .filter((entry) => (
              entry.scopeCount > 0
              && !remainingDocumentIds.has(entry.documentId)
              && !completedDomainDocuments.has(entry.documentId)
            ));
          if (recovered.length > 0) {
            context.domainRun?.recordProofreadAssignmentsReconciled(recovered.map((entry) => ({
              documentId: entry.documentId,
              acceptedScopeCount: entry.scopeCount
            })));
            completedScopeStateChanged = true;
          }
          if (completedScopeStateChanged) await context.persistHostState?.();
          if ((remainingSplitTasks?.length ?? 0) === 0) {
            return textResult({
              status: "already_complete",
              strategy: hotSplitRequested ? "hot_split" : mode,
              deterministicPrescan: planningSummary,
              subagents: [],
              workerCount: 0,
              assignmentCount: 0,
              documentCount: resolvedManifest.documents.length
            });
          }
        }
        const maximumWorkers = usefulMaximum;
        if (maximumWorkers === 0) {
          throw new Error("Proofreading subagents are disabled for this workflow; complete semantic review in the parent Agent.");
        }
        const requestedWorkerCount = input.workerCount
          ?? input.workers?.length
          ?? Math.min(planningSummary.recommendedWorkerCount, maximumWorkers);
        if (!Number.isInteger(requestedWorkerCount) || requestedWorkerCount < 1 || requestedWorkerCount > maximumWorkers) {
          throw new Error(
            `Proofreading accepts between 1 and ${maximumWorkers} semantic workers for this document; received ${requestedWorkerCount}.`
          );
        }
        if (input.workerCount !== undefined && input.workers && input.workers.length !== input.workerCount) {
          throw new Error(
            `Proofreading workerCount ${input.workerCount} requires exactly ${input.workerCount} worker override records; received ${input.workers.length}.`
          );
        }
        const hostPlannedTasks = dynamicSplitQueue
          ? remainingSplitTasks ?? []
          : mode === "montecarlo"
            ? createMontecarloProofreadTasks({
                totalLines: sourceLines.length,
                workerCount: requestedWorkerCount,
                sampleSize: request.proofreadMontecarloSize ?? 3_000,
                round: nextMontecarloRound,
                signals: deterministicSignals,
                previouslySampled: sampledLines
              })
            : [];
        if (mode === "montecarlo" && !hotSplitRequested && hostPlannedTasks.length === 0) {
          context.domainRun?.recordProofreadMontecarloRound(0, true);
          await context.persistHostState?.();
          return textResult({
            status: "sampling_exhausted",
            strategy: mode,
            deterministicPrescan: prescan.summary,
            sampledLineCount: sampledLines.size,
            subagents: []
          });
        }
        const plannedTasks: PiProofreadSubagentTask[] = hostPlannedTasks.map((task, index) => dynamicSplitQueue ? ({
          ...task
        }) : ({
          ...task,
          ...(input.workers?.[index]?.label ? { label: input.workers[index].label } : {}),
          ...(input.workers?.[index]?.providerId ? { providerId: input.workers[index].providerId } : {}),
          ...(input.workers?.[index]?.modelId ? { modelId: input.workers[index].modelId } : {})
        }));
        const tasks = applySubagentModelDefaults(plannedTasks, request);
        const batchId = createYnSubagentBatchId();
        const reservedWorkerCount = Math.min(requestedWorkerCount, tasks.length);
        const batchDocumentIds = folderPrescans
          ? [...new Set(tasks.map((task) => task.documentId).filter((id): id is string => Boolean(id)))]
          : [currentDocumentId];
        const assignmentCounts = folderPrescans
          ? Object.fromEntries(batchDocumentIds.map((id) => [
              id,
              tasks.filter((task) => task.documentId === id).length
            ]))
          : undefined;
        await reserveSpecializedBatch("proofread", batchId, {
          taskCount: tasks.length,
          workerCount: reservedWorkerCount,
          documentIds: batchDocumentIds,
          ...(assignmentCounts ? { assignmentCounts } : {})
        });
        let proofreadArtifactsReset = false;
        try {
        // HOT-region escalation is a continuation of the existing Monte Carlo
        // report, including after a process/runtime reconstruction. Resetting
        // here would discard the deterministic and sampled findings that led
        // the user to choose the escalation.
        if (
          !hotSplitRequested
          && mode === "montecarlo"
          && !currentDocumentState.reportInitialized
        ) {
          await resetProofreadFindings({
            outputDir: request.outputDir,
            sourcePaths: [sourcePath(request)],
            documentId: documentId(request),
            reportScope: proofreadReportScope(request)
          });
          proofreadArtifactsReset = true;
        }
        const montecarloSnapshot = mode === "montecarlo"
          ? await snapshotProofreadFindings({
              outputDir: request.outputDir,
              sourcePaths: [sourcePath(request)],
              documentId: documentId(request),
              reportScope: proofreadReportScope(request)
            })
          : undefined;
        const batch = context.subagents.startProofreadBatch({
          batchId,
          request,
          tasks,
          ...(dynamicSplitQueue ? {
            maxWorkers: requestedWorkerCount,
            workers: input.workers,
            taskStage: (task) => task.documentId
              ? folderStages?.get(task.documentId) ?? 0
              : 0,
            ...(folderPrescans ? {
              requestForTask: (task: PiProofreadSubagentTask) => {
                const document = task.documentId
                  ? resolvePiSourceDocument(resolvedManifest, task.documentId)
                  : undefined;
                if (!document) {
                  throw new Error(`Unknown folder proofreading document ${task.documentId ?? "(missing)"}.`);
                }
                const bound = bindPiSourceDocument(baseRequest, document);
                return {
                  ...bound,
                  translationPath: proofreadTranslationPath(bound, true)
                };
              }
            } : {})
          } : {}),
          pendingGlossaryCandidatesForTask: () => pendingProofreadGlossaryCandidateEvidence(
            resolvedManifest.documents.flatMap((document) => (
              proofreadDocumentHostState(proofreadState, document.id).glossaryCandidates.map((candidate) => ({
                ...candidate,
                documentId: document.id
              }))
            ))
          ),
          signal,
          onArtifactMutation: dynamicSplitQueue
            ? (changedDocumentId) => {
                const ownerDocumentId = changedDocumentId ?? currentDocumentId;
                context.domainRun?.recordProofreadArtifactMutation(ownerDocumentId);
                proofreadDocumentHostState(proofreadState, ownerDocumentId).reportInitialized = true;
              }
            : undefined,
          onTaskCompleted: dynamicSplitQueue
            ? async (result, task) => {
                const ownerDocumentId = task.documentId ?? currentDocumentId;
                const ownerScan = folderPrescans
                  ? folderPrescans.find((entry) => entry.document.id === ownerDocumentId)?.scan
                  : currentPrescan;
                if (!ownerScan) {
                  throw new Error(
                    `Cannot checkpoint proofreading assignment L${task.fromLine}-L${task.toLine}: unknown document ${ownerDocumentId}.`
                  );
                }
                registerProofreadGlossaryCandidates(
                  proofreadDocumentHostState(proofreadState, ownerDocumentId),
                  [result]
                );
                recordCompletedProofreadSplitScope(
                  proofreadDocumentHostState(proofreadState, ownerDocumentId),
                  {
                    inputHash: ownerScan.prescan.inputHash,
                    translationPath: ownerScan.translationPath,
                    fromLine: task.fromLine,
                    toLine: task.toLine
                  }
                );
                await context.persistHostState?.();
              }
            : undefined,
          parentCompletionContext: folderPrescans
            ? ({ results, failures }) => ({
                content: `Folder proofreading settled ${results.length}/${tasks.length} assignment(s) across ${batchDocumentIds.length} document(s). Continue with the aggregate report only after all Host debt is complete.`,
                details: {
                  documentCount: batchDocumentIds.length,
                  assignmentCount: tasks.length,
                  acceptedAssignmentCount: results.length,
                  failedAssignmentCount: failures.length
                }
              })
            : undefined,
          onSettled: async ({ batch: settledBatch, results, failures = [], error }) => {
            if (error !== undefined) {
              if (montecarloSnapshot) await restoreProofreadFindings(montecarloSnapshot);
              if (folderPrescans) {
                const resultsByDocument = new Map<string, number>();
                for (const result of results) {
                  if (result.documentId) {
                    resultsByDocument.set(result.documentId, (resultsByDocument.get(result.documentId) ?? 0) + 1);
                  }
                }
                const failuresByDocument = new Map<string, typeof failures>();
                for (const failure of failures) {
                  if (failure.documentId) {
                    const documentFailures = failuresByDocument.get(failure.documentId) ?? [];
                    documentFailures.push(failure);
                    failuresByDocument.set(failure.documentId, documentFailures);
                  }
                }
                context.domainRun?.recordSubagentBatchSettlement(
                  "proofread",
                  settledBatch.id,
                  batchDocumentIds.map((id) => ({
                    documentId: id,
                    acceptedResultCount: resultsByDocument.get(id) ?? 0,
                    failedResultCount: Math.max(
                      failuresByDocument.get(id)?.length ?? 0,
                      (resultsByDocument.get(id) ?? 0) === assignmentCounts?.[id] ? 0 : 1
                    ),
                    error: failuresByDocument.get(id)?.map((failure) => failure.error).join(" | ")
                      || (resultsByDocument.get(id) === assignmentCounts?.[id]
                        ? undefined
                        : error instanceof Error ? error.message : String(error))
                  }))
                );
              } else {
                context.domainRun?.recordSubagentBatchFailure("proofread", settledBatch.id, [currentDocumentId]);
              }
              await context.persistHostState?.();
              return;
            }
            if (mode === "montecarlo" && !hotSplitRequested) {
              for (const task of plannedTasks) {
                if (task.sampledLines) {
                  for (const line of task.sampledLines) sampledLines.add(line);
                }
              }
              currentDocumentState.sampledLines = [...sampledLines].sort((left, right) => left - right);
            }
            if (mode === "montecarlo" && !hotSplitRequested) {
              context.domainRun?.recordProofreadArtifactMutation(currentDocumentId);
            }
            if (folderPrescans) {
              for (const id of batchDocumentIds) {
                const documentResults = results.filter((result) => result.documentId === id);
                proofreadDocumentHostState(proofreadState, id).reportInitialized = true;
                registerProofreadGlossaryCandidates(proofreadDocumentHostState(proofreadState, id), documentResults);
              }
              context.domainRun?.recordSubagentBatchSettlement(
                "proofread",
                settledBatch.id,
                batchDocumentIds.map((id) => ({
                  documentId: id,
                  acceptedResultCount: results.filter((result) => result.documentId === id).length,
                  failedResultCount: 0
                }))
              );
            } else {
              if (mode === "split") currentDocumentState.reportInitialized = true;
              registerProofreadGlossaryCandidates(currentDocumentState, results);
              context.domainRun?.recordSubagentBatch(
                "proofread",
                settledBatch.id,
                results.length,
                [currentDocumentId]
              );
            }
            if (hotSplitRequested) {
              context.domainRun?.recordProofreadHotSplitCompleted();
            } else if (mode === "montecarlo") {
              const exhaustive = createMontecarloProofreadTasks({
                totalLines: sourceLines.length,
                workerCount: requestedWorkerCount,
                sampleSize: request.proofreadMontecarloSize ?? 3_000,
                round: nextMontecarloRound + 1,
                signals: deterministicSignals,
                previouslySampled: sampledLines
              }).length === 0;
              context.domainRun?.recordProofreadMontecarloRound(
                results.reduce((count, result) => count + result.findingsWritten, 0),
                exhaustive
              );
            }
            await context.persistHostState?.();
          }
        });
        if (proofreadArtifactsReset) {
          context.domainRun?.recordProofreadArtifactReset();
          currentDocumentState.reportInitialized = true;
        }
        if (hotSplitRequested) currentDocumentState.reportInitialized = true;
        return textResult({
          status: batch.status,
          batchId: batch.id,
          strategy: hotSplitRequested ? "hot_split" : mode,
          deterministicPrescan: planningSummary,
          subagents: batch.subagents,
          workerCount: batch.subagents.length,
          assignmentCount: tasks.length,
          documentCount: batchDocumentIds.length
        });
        } catch (error) {
          const rollbackErrors: unknown[] = [];
          try {
            await rollbackSpecializedBatch("proofread", batchId, batchDocumentIds);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              "Split proofreading failed to start and its report transaction could not be fully rolled back."
            );
          }
          throw error;
        }
      }
    },
    {
      name: "runSubagents",
      label: "Run subagents",
      description: "Delegate concrete investigation or bounded translation-repair tasks to native Pi children. Project worker settings are concurrency preferences, never an authorization gate. A translation_repair child receives a host-confined writer for its named candidate document and exact line range even outside a generated workflow; it does not require the full translation queue. First locate the concrete target and evidence. Preserve each task's distinct objective; never substitute the full translation/proofreading workflow queue.",
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          prompt: Type.String({ minLength: 1 }),
          label: Type.Optional(Type.String()),
          mode: Type.Optional(Type.Union([
            Type.Literal("investigate"),
            Type.Literal("translation_repair")
          ])),
          documentId: Type.Optional(Type.String({ minLength: 1 })),
          fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
          toLine: Type.Optional(Type.Integer({ minimum: 1 })),
          providerId: Type.Optional(Type.String()),
          modelId: Type.Optional(Type.String())
      }, { additionalProperties: false }), { minItems: 1 })
      }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        context.domainRun?.assertCanStartGeneralSubagentBatch();
        const input = params as {
          tasks: Array<{
            prompt: string;
            label?: string;
            mode?: "investigate" | "translation_repair";
            documentId?: string;
            fromLine?: number;
            toLine?: number;
            providerId?: string;
            modelId?: string;
          }>;
        };
        // General delegation keeps task count and live worker count separate:
        // concrete tasks may queue beyond the project ceiling, but they must
        // never create more concurrent children than the configured 1..N.
        // A zero ceiling intentionally leaves useful bounded delegation
        // available instead of becoming another workflow authorization gate.
        const configuredWorkerCeiling = context.domainRun?.configuredSubagents
          ?? resolveWorkflowSubagentCount(request.subagentEnabled, request.subagentCount);
        const workerCount = configuredWorkerCeiling > 0
          ? Math.min(configuredWorkerCeiling, input.tasks.length)
          : input.tasks.length;
        if (baseRequest.sourcePath?.trim()) await ensureManifest();
        const normalized: PiGeneralSubagentTask[] = [];
        for (const value of input.tasks) {
          const prompt = value.prompt.trim();
          if (!prompt) throw new Error("Every delegated subagent needs a concrete prompt.");
          const mode = value.mode ?? "investigate";
          const requestedDocumentId = value.documentId?.trim();
          const selectedDocument = requestedDocumentId && manifest
            ? resolvePiSourceDocument(manifest, requestedDocumentId)
            : undefined;
          if (requestedDocumentId && !selectedDocument) {
            throw new Error(`Source document ${requestedDocumentId} is not in the immutable host source manifest.`);
          }
          if (mode === "translation_repair") {
            const boundDocument = selectedDocument
              ?? manifest?.documents.find((document) => document.id === requestDocumentId(request));
            if (!boundDocument) {
              throw new Error("A bounded translation repair must name a valid source document.");
            }
            if (value.fromLine === undefined || value.toLine === undefined) {
              throw new Error("A bounded translation repair requires exact fromLine and toLine values.");
            }
            const range = normalizeRange(value.fromLine, value.toLine, boundDocument.lineCount);
            normalized.push({
              ...value,
              ...range,
              prompt,
              mode,
              documentId: boundDocument.id
            });
            continue;
          }
          if ((value.fromLine === undefined) !== (value.toLine === undefined)) {
            throw new Error("An investigation range must provide both fromLine and toLine, or neither.");
          }
          const range = value.fromLine === undefined
            ? {}
            : normalizeRange(value.fromLine, value.toLine!, selectedDocument?.lineCount ?? splitTextLines(await readFile(sourcePath(request), "utf8")).length);
          normalized.push({
            ...value,
            ...range,
            prompt,
            mode,
            ...(selectedDocument ? { documentId: selectedDocument.id } : {})
          });
        }
        const repairTasks = normalized
          .filter((task) => task.mode === "translation_repair")
          .sort((left, right) => (left.documentId ?? "").localeCompare(right.documentId ?? "")
            || left.fromLine! - right.fromLine!);
        for (let index = 1; index < repairTasks.length; index += 1) {
          const previous = repairTasks[index - 1];
          const current = repairTasks[index];
          if (previous.documentId === current.documentId && current.fromLine! <= previous.toLine!) {
            throw new Error(
              `Prompt-defined translation repairs overlap in ${current.documentId}: L${previous.fromLine}-L${previous.toLine} and L${current.fromLine}-L${current.toLine}.`
            );
          }
        }
        const tasks = applySubagentModelDefaults(normalized, request);
        const batchId = createYnSubagentBatchId();
        await reserveGeneralBatch(batchId, tasks.length);
        try {
        const batch = context.subagents.startGeneralBatch({
          batchId,
          request,
          tasks,
          maxWorkers: workerCount,
          signal,
          requestForTask: (task) => {
            if (!task.documentId) return request;
            const document = manifest ? resolvePiSourceDocument(manifest, task.documentId) : undefined;
            if (!document) throw new Error(`Source document ${task.documentId} is not in the immutable host source manifest.`);
            return bindPiSourceDocument(baseRequest, document);
          },
          onArtifactMutation: async (mutationDocumentId, mutationRange) => {
            context.domainRun?.recordTranslationArtifactMutation(mutationDocumentId, mutationRange);
            if (mutationRange) {
              const document = mutationDocumentId
                ? manifest?.documents.find((candidate) => candidate.id === mutationDocumentId)
                : undefined;
              const bound = document ? bindPiSourceDocument(baseRequest, document) : request;
              if (mutationDocumentId && documentId(bound) !== mutationDocumentId) {
                throw new Error(`Cannot register bounded alignment for unknown document ${mutationDocumentId}.`);
              }
              if (context.domainRun?.kind === "proofread") {
                await refreshProofreadPrescanAfterBoundedMutation(bound, mutationRange);
              } else {
                await registerBoundedTranslationAlignment(bound, mutationRange, { parentOwnedMutation: true });
              }
            }
            await context.persistHostState?.();
          },
          onSettled: async ({ batch: settledBatch, results, error }) => {
            if (error !== undefined) {
              context.domainRun?.recordGeneralSubagentBatchFailure(
                settledBatch.id,
                error instanceof Error ? error.message : String(error)
              );
              await context.persistHostState?.();
              return;
            }
            context.domainRun?.recordGeneralSubagentBatch(settledBatch.id, results.length);
            await context.persistHostState?.();
          }
        });
        return textResult({
          status: batch.status,
          batchId: batch.id,
          subagents: batch.subagents,
          taskCount: tasks.length
        });
        } catch (error) {
          await rollbackGeneralBatch(batchId, error);
          throw error;
        }
      }
    },
    {
      requiresSourceManifest: true,
      name: "runTranslationSubagents",
      label: "Run translation subagents",
      description: "Start the native Pi translation worker queue in the background. For a folder, or after an existing-translation reuse decision, call once without tasks so the Host owns file order, split size, and the persisted rejected-line mask. Retained reuse lines are never repartitioned. Return immediately so the parent remains interactive; inspect structured cards only when needed.",
      parameters: Type.Object({
        tasks: Type.Optional(Type.Array(Type.Object({
          documentId: Type.Optional(Type.String({ minLength: 1 })),
          fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
          toLine: Type.Optional(Type.Integer({ minimum: 1 })),
          label: Type.Optional(Type.String()),
          providerId: Type.Optional(Type.String()),
          modelId: Type.Optional(Type.String())
        })))
      }),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        if (context.domainRun?.fullWorkflow === false) {
          throw new Error(
            "runTranslationSubagents is reserved for the complete Host-owned translation queue. "
            + "Use writeTranslationChunk for a small parent repair or runSubagents(mode=translation_repair) for exact bounded child repairs."
          );
        }
        context.domainRun?.assertCanStartSubagentBatch("translation");
        const input = params as { tasks?: TranslationSubagentTaskInput[] };
        const resolvedManifest = await ensureManifest();
        const currentDiscoveryConflicts = await prepareCurrentTranslationDiscoveryConflicts(resolvedManifest);
        const appliedReuseTasks = await planAppliedReuseAssignments(resolvedManifest);
        const totalLines = splitTextLines(await readFile(sourcePath(request), "utf8")).length;
        const outstandingFolderTasks = !appliedReuseTasks
          && resolvedManifest.kind === "folder"
          && !input.tasks?.length
          ? await planOutstandingFolderTranslationTasks(resolvedManifest)
          : undefined;
        const ordinaryTasks = appliedReuseTasks
          ?? outstandingFolderTasks
          ?? normalizeTranslationTasks(input.tasks, manifest as PiSourceManifest, totalLines, request, context.domainRun);
        const persistedTerminologyTasks = await planPersistedTranslationTerminologyTasks(resolvedManifest);
        let tasks = applySubagentModelDefaults(
          mergePersistedTranslationTerminologyTasks(ordinaryTasks, persistedTerminologyTasks),
          request
        );
        let initialTerminologyPriorityTasks = tasks.filter((task) => task.terminologyRepair === true);
        if (tasks.length === 0) {
          if (context.domainRun?.fullWorkflow === true) {
            const byId = new Map(context.domainRun.snapshot().documents.map((document) => [document.id, document]));
            const recoveryEvidence = resolvedManifest.documents.flatMap((document) => {
              const state = byId.get(document.id);
              if (state?.translationReuseApproved || state?.completedSubagentBatch?.kind === "translation") return [];
              const acceptedScopeCount = (translationAlignmentState.ranges[document.id] ?? []).filter((scope) => (
                scope.checks.length > 0 && scope.checks.every((check) => check.verdict === "aligned")
              )).length;
              if (acceptedScopeCount < 1) {
                throw new Error(
                  `No outstanding assignment was planned for ${document.id}, but Host has no hash-current accepted scope evidence to recover completion.`
                );
              }
              return [{ documentId: document.id, acceptedScopeCount }];
            });
            context.domainRun.recordTranslationAssignmentsReconciled(recoveryEvidence);
            await context.persistHostState?.();
          }
          const remainingReasons = context.domainRun?.incompleteReasons() ?? [];
          const nextAction = remainingReasons.length === 0
            ? "The Host completion contract is satisfied. Report completion without calling validation again."
            : remainingReasons.some((reason) => /discover|terminology/i.test(reason))
              ? "Resolve the persisted translation discoveries or exact terminology repair debt. Do not restart completed assignments."
              : remainingReasons.some((reason) => /validation/i.test(reason))
                ? "Run validateTranslationArtifact once for the current artifact revisions."
                : "Inspect the remaining Host completion reasons; do not recreate completed assignments.";
          return textResult({
            status: "no_outstanding_assignments",
            nextAction,
            remainingReasonCount: remainingReasons.length,
            subagents: [],
            workerCount: 0,
            reviewWorkerCount: 0,
            assignmentCount: 0
          });
        }
        const pendingReviewTasks = tasks.filter((task) => task.reviewOnly === true);
        if (pendingReviewTasks.length > 0 && initialTerminologyPriorityTasks.length > 0) {
          tasks = initialTerminologyPriorityTasks;
          initialTerminologyPriorityTasks = tasks;
        }
        if (pendingReviewTasks.length > 0 && initialTerminologyPriorityTasks.length === 0) {
          const configuredReviewMaximum = request.reviewSubagentCount
            ?? resolveWorkflowSubagentCount(request.subagentEnabled, request.subagentCount);
          const reviewWorkerCount = Math.min(
            effectiveTranslationReviewWorkerCount(request, pendingReviewTasks.length, pendingReviewTasks.length),
            pendingReviewTasks.length
          );
          const documentIds = [...new Set(pendingReviewTasks.map((task) => task.documentId ?? documentId(request)))];
          const batchId = createYnSubagentBatchId();
          await reserveSpecializedBatch("translation", batchId, {
            taskCount: pendingReviewTasks.length,
            workerCount: reviewWorkerCount,
            documentIds,
            assignmentCounts: translationAssignmentCounts(pendingReviewTasks, documentId(request)),
            readOnly: true,
            workerCountContract: "review_ceiling",
            workerCountCeiling: configuredReviewMaximum
          });
          try {
          const batch = context.subagents.startTranslationReviewBatch({
            batchId,
            request,
            tasks: pendingReviewTasks,
            maxWorkers: reviewWorkerCount,
            signal,
            reviewRequestForTask: resumedTranslationReviewRequest,
            prepareChunkReview: prepareTranslationChunkReview,
            onSettled: async ({ batch: settledBatch, error }) => {
              const documentIds = [...new Set(pendingReviewTasks.map((task) => task.documentId ?? documentId(request)))];
              if (error !== undefined) {
                context.domainRun?.recordSubagentBatchFailure("translation", settledBatch.id, documentIds);
              } else {
                context.domainRun?.recordSubagentBatchProgress("translation", settledBatch.id, documentIds);
              }
              await context.persistHostState?.();
            }
          });
          return textResult({
            status: batch.status,
            batchId: batch.id,
            subagents: batch.subagents.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS),
            omittedSubagentCount: Math.max(0, batch.subagents.length - MAX_TOOL_RESULT_COLLECTION_ITEMS),
            workerCount: 0,
            reviewWorkerCount,
            activeReviewWorkerCount: reviewWorkerCount,
            reviewWorkerMaximum: configuredReviewMaximum,
            assignmentCount: pendingReviewTasks.length,
            assignments: pendingReviewTasks.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS).map((task) => ({
              documentId: task.documentId || documentId(request),
              fromLine: task.fromLine,
              toLine: task.toLine
            })),
            omittedAssignmentCount: Math.max(0, pendingReviewTasks.length - MAX_TOOL_RESULT_COLLECTION_ITEMS)
          });
          } catch (error) {
            await rollbackSpecializedBatch("translation", batchId, documentIds);
            throw error;
          }
        }
        let completedDiscoveries = mergeTranslationDiscoveries([]);
        const configuredWorkerMaximum = context.domainRun?.configuredSubagents
          ?? resolveWorkflowSubagentCount(request.subagentEnabled, request.subagentCount);
        const workerCount = Math.min(configuredWorkerMaximum, tasks.length);
        const reviewWorkerCount = effectiveTranslationReviewWorkerCount(request, workerCount, tasks.length);
        const manifestDocumentIds = new Set(resolvedManifest.documents.map((document) => document.id));
        const terminologyPriorityWriteScopes = [...new Map(
          currentDiscoveryConflicts
            .flatMap((conflict) => conflict.affectedRanges)
            .filter((scope) => manifestDocumentIds.has(scope.documentId))
            .map((scope) => [
              `${scope.documentId}\0${scope.fromLine}\0${scope.toLine}`,
              { documentId: scope.documentId, fromLine: scope.fromLine, toLine: scope.toLine }
            ] as const)
        ).values()];
        const documentIds = [...new Set([
          ...tasks.map((task) => task.documentId ?? documentId(request)),
          ...terminologyPriorityWriteScopes.map((scope) => scope.documentId)
        ])];
        const batchId = createYnSubagentBatchId();
        const reservedTaskIdentities = new Set(tasks);
        const completedReservedAssignments: Record<string, number> = {};
        await reserveSpecializedBatch("translation", batchId, {
          taskCount: tasks.length,
          workerCount,
          documentIds,
          assignmentCounts: translationAssignmentCounts(tasks, documentId(request), documentIds)
        });
        try {
        if (context.domainRun?.fullWorkflow === true) {
          const taskDocumentIds = new Set(tasks.map((task) => task.documentId ?? documentId(request)));
          for (const workflowDocumentId of taskDocumentIds) {
            const bound = resolvedManifest.kind === "folder"
              ? bindPiSourceDocument(
                  baseRequest,
                  resolvedManifest.documents.find((entry) => entry.id === workflowDocumentId)!
                )
              : request;
            await prepareExistingTranslationForWrite(bound);
          }
        }
        const batch = context.subagents.startTranslationBatch({
          batchId,
          request,
          tasks,
          priorityTasks: initialTerminologyPriorityTasks,
          priorityWriteScopes: terminologyPriorityWriteScopes,
          maxWorkers: workerCount,
          ...(manifest?.kind === "folder" ? {
            taskStage: (task: PiTranslationSubagentTask & { scheduleStage?: number }) => task.scheduleStage ?? 0
          } : {}),
          signal,
          requestForTask: (task) => {
            if (!task.documentId) return request;
            const document = manifest?.documents.find((candidate) => candidate.id === task.documentId);
            if (!document) throw new Error(`Source document ${task.documentId} is not in the host-resolved manifest.`);
            return {
              ...bindPiSourceDocument(baseRequest, document),
              priorTranslationDiscoveries: completedDiscoveries
            };
          },
          ...(context.domainRun && glossaryCandidateCollectionEnabled ? {
            claimGate: {
              isBlocked: () => context.domainRun!.pendingTranslationDiscoveryConflicts().length > 0,
              wait: (gateSignal: AbortSignal) => context.domainRun!.waitForTranslationTerminologyGate(gateSignal),
              notificationKey: () => {
                const conflicts = context.domainRun!.pendingTranslationDiscoveryConflicts();
                return conflicts.length > 0
                  ? createHash("sha256").update(JSON.stringify(conflicts)).digest("hex")
                  : undefined;
              },
              onQuiescent: async () => {
                const conflicts = context.domainRun!.pendingTranslationDiscoveryConflicts();
                if (conflicts.length === 0) return;
                await context.subagents.notifyParent(translationTerminologyConflictMessage(batchId, conflicts));
              }
            }
          } : {}),
          onTaskCompleted: async (result, task) => {
            const completedDocumentId = task.documentId ?? documentId(request);
            const completedDocument = manifest?.documents.find((candidate) => candidate.id === completedDocumentId);
            const bound = completedDocument ? bindPiSourceDocument(baseRequest, completedDocument) : request;
            const [sourceLines, candidateLines] = await Promise.all([
              readFile(sourcePath(bound), "utf8").then(splitTextLines),
              readFile(candidatePath(bound), "utf8").then(splitTextLines)
            ]);
            const records = translationDiscoveryRecords({
              task,
              result,
              documentId: completedDocumentId,
              sourceLines,
              candidateLines,
              includeGlossaryCandidates: glossaryCandidateCollectionEnabled,
              includeCharacterFacts: characterFactCollectionEnabled
            });
            const committed = await commitTranslationAssignmentDiscoveries({
              batchId,
              records,
              discoveries: result.discoveries
            });
            completedDiscoveries = mergeTranslationDiscoveries([
              completedDiscoveries,
              committed.committedDiscoveries
            ]);
            if (reservedTaskIdentities.has(task)) {
              completedReservedAssignments[completedDocumentId] = (
                completedReservedAssignments[completedDocumentId] ?? 0
              ) + 1;
            }
            const terminologyRepairLines = new Set((task.reviewFeedback ?? [])
              .filter((feedback) => feedback.reason.startsWith("terminology:"))
              .map((feedback) => feedback.line));
            if (terminologyRepairLines.size > 0 && context.domainRun) {
              const currentDebt = context.domainRun.pendingTranslationTerminologyDebt();
              const rescanned = scanResolvedTerminologyDebt({
                documentId: completedDocumentId,
                sourceLines,
                candidateLines,
                terms: context.domainRun.resolvedTranslationTerms()
              });
              const untouched = currentDebt.filter((debt) => (
                debt.documentId !== completedDocumentId || !terminologyRepairLines.has(debt.line)
              ));
              const repairedScopeDebt = rescanned.filter((debt) => terminologyRepairLines.has(debt.line));
              context.domainRun.recordTranslationTerminologyDebt([...untouched, ...repairedScopeDebt]);
              await context.persistHostState?.();
              if (repairedScopeDebt.length > 0) {
                throw new Error(
                  `Terminology repair left ${repairedScopeDebt.length} conflicting line(s) in ${completedDocumentId}.`
                );
              }
            }
          },
          reviewWorkerCount,
          prepareChunkReview: prepareTranslationChunkReview,
          onStagingCandidateCheckpoint: async (checkpoint) => {
            const document = manifest?.documents.find((candidate) => candidate.id === checkpoint.documentId);
            const bound = document ? bindPiSourceDocument(baseRequest, document) : request;
            if (documentId(bound) !== checkpoint.documentId) {
              throw new Error(`Cannot checkpoint staging candidate for unknown document ${checkpoint.documentId}.`);
            }
            const issuesByLine = new Map<number, Array<{ code: string; detail: string }>>();
            for (const issue of checkpoint.repairIssues) {
              if (issue.absoluteLine === undefined) continue;
              const current = issuesByLine.get(issue.absoluteLine) ?? [];
              current.push({ code: canonicalTranslationReviewCode(issue.code), detail: issue.detail.trim() });
              issuesByLine.set(issue.absoluteLine, current);
            }
            await registerTranslationChunkReview(bound, {
              fromLine: checkpoint.fromLine,
              toLine: checkpoint.toLine,
              requiredLines: checkpoint.requiredLines,
              requiredLineReasons: checkpoint.requiredLines.map((line) => {
                const issues = issuesByLine.get(line) ?? [];
                const codes = [...new Set(issues.map((issue) => issue.code).filter(Boolean))];
                const notes = [...new Set(issues.map((issue) => issue.detail).filter(Boolean))];
                return {
                  line,
                  reason: `${codes.join("+") || "host_required"}: ${notes.join(" | ") || "write a fresh structurally valid translation"}`
                    .slice(0, 500)
                };
              })
            }, checkpoint.candidatePath);
          },
          onArtifactMutation: async (mutationDocumentId, mutationRange) => {
            const rollbackDomainMutation = context.domainRun
              ?.recordTranslationArtifactMutation(mutationDocumentId, mutationRange);
            try {
              if (mutationRange) {
                const document = mutationDocumentId
                  ? manifest?.documents.find((candidate) => candidate.id === mutationDocumentId)
                  : undefined;
                const bound = document ? bindPiSourceDocument(baseRequest, document) : request;
                if (mutationDocumentId && documentId(bound) !== mutationDocumentId) {
                  throw new Error(`Cannot register bounded alignment for unknown document ${mutationDocumentId}.`);
                }
                if (context.domainRun?.fullWorkflow === false) {
                  await registerBoundedTranslationAlignment(bound, mutationRange);
                  await context.persistHostState?.();
                } else {
                  await commitAcceptedTranslationChunkReview(bound, mutationRange);
                }
                return;
              }
              await context.persistHostState?.();
            } catch (error) {
              rollbackDomainMutation?.();
              throw error;
            }
          },
          parentCompletionContext: () => translationDiscoveryCompletionContextFromRecords(
            context.domainRun?.pendingTranslationDiscoveries() ?? []
          ),
          onSettled: async ({ batch: settledBatch, results, failures, error }) => {
            context.domainRun?.recordSubagentBatchSettlement(
              "translation",
              settledBatch.id,
              translationBatchSettlements({
                documentIds,
                results,
                ...(Object.keys(completedReservedAssignments).length > 0
                  ? { acceptedAssignmentCounts: completedReservedAssignments }
                  : {}),
                failures,
                error
              })
            );
            await context.persistHostState?.();
          }
        });
        const assignmentSummary = tasks.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS).map((task) => ({
          documentId: task.documentId || documentId(request),
          fromLine: task.fromLine,
          toLine: task.toLine
        }));
        const candidateSummary = tasks.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS).map((task) => ({
          documentId: task.documentId || documentId(request),
          path: candidatePath(task.documentId
            ? bindPiSourceDocument(baseRequest, manifest!.documents.find((document) => document.id === task.documentId)!)
            : request)
        }));
        return textResult({
          status: batch.status,
          batchId: batch.id,
          subagents: batch.subagents.slice(0, MAX_TOOL_RESULT_COLLECTION_ITEMS),
          omittedSubagentCount: Math.max(0, batch.subagents.length - MAX_TOOL_RESULT_COLLECTION_ITEMS),
          workerCount,
          reviewWorkerCount: 0,
          activeReviewWorkerCount: 0,
          reviewWorkerMaximum: reviewWorkerCount,
          assignmentCount: tasks.length,
          assignments: assignmentSummary,
          omittedAssignmentCount: Math.max(0, tasks.length - MAX_TOOL_RESULT_COLLECTION_ITEMS),
          candidates: candidateSummary,
          omittedCandidateCount: Math.max(0, tasks.length - MAX_TOOL_RESULT_COLLECTION_ITEMS)
        });
        } catch (error) {
          await rollbackSpecializedBatch("translation", batchId, documentIds);
          throw error;
        }
      }
    }
  ];
  return tools.map(({ requiresSourceManifest, restoreWorkflowBeforeSourceManifest, ...tool }) => {
    const execute = tool.execute.bind(tool);
    const guarded = {
      ...tool,
      async execute(...args: Parameters<typeof execute>) {
        return execute(...args);
      }
    };
    if (!requiresSourceManifest) return guarded;
    return {
      ...guarded,
      async execute(...args) {
        if (restoreWorkflowBeforeSourceManifest && context.isWorkflowSuspended?.() === true) {
          if (!context.resumeWorkflow) {
            throw new Error("The pending translation reuse decision cannot restore its suspended Host workflow.");
          }
          await context.resumeWorkflow();
        }
        await ensureManifest();
        return execute(...args);
      }
    };
  });
}
