import {
  maximumWorkflowSubagents,
  resolveWorkflowSubagentCount,
  type PiWorkflowIntent
} from "../../../shared/agent/piSessionContract.ts";

export type YnWorkflowKind = PiWorkflowIntent;

export interface YnWorkflowRequirements {
  glossaryCandidate: boolean;
  characterBible: boolean;
}

export interface YnDomainInspection {
  sourceLineCount: number;
  documents?: Array<{ id: string; sourceLineCount: number; scheduleStage?: number }>;
  glossaryCandidateExists: boolean;
  characterBibleExists: boolean;
}

export interface YnSubagentBatchStart {
  taskCount: number;
  workerCount: number;
  documentIds?: string[];
  assignmentCounts?: Record<string, number>;
  readOnly?: boolean;
  workerCountContract?: "workflow" | "review_ceiling";
  workerCountCeiling?: number;
}

export interface YnSubagentDocumentSettlement {
  documentId: string;
  acceptedResultCount: number;
  failedResultCount?: number;
  error?: string;
}

export type YnTranslationDiscoveryRecord = {
  id: string;
  documentId: string;
  fromLine: number;
  toLine: number;
  sourceHash: string;
  candidateHash: string;
} & (
  | {
      kind: "glossary";
      source: string;
      target: string;
      category: string;
      evidenceLine: number;
      rationale: string;
      aliases?: string[];
    }
  | {
      kind: "character";
      sourceName: string;
      targetName?: string;
      evidenceLine: number;
      evidence: string;
      gender: string;
      pronouns?: string[];
      confidence: string;
    }
);

export interface YnResolvedTranslationTerm {
  source: string;
  target: string;
  observedTargets: string[];
}

export interface YnTranslationTerminologyDebt {
  documentId: string;
  line: number;
  source: string;
  expectedTarget: string;
  observedTargets: string[];
  sourceLineHash?: string;
  candidateLineHash?: string;
  referenceHash?: string;
}

export interface YnTranslationDiscoveryConflict {
  id: string;
  batchId: string;
  source: string;
  observedTargets: string[];
  discoveryIds: string[];
  documentIds: string[];
  affectedRanges: Array<{
    documentId: string;
    fromLine: number;
    toLine: number;
    sourceHash: string;
    candidateHash: string;
  }>;
  status: "conflict";
}

export interface YnDomainRunContract {
  readonly kind: YnWorkflowKind | undefined;
  readonly fullWorkflow: boolean;
  readonly workflowRequirements: Readonly<YnWorkflowRequirements>;
  readonly maximumSubagentsForActiveDocument: number;
  readonly configuredSubagents: number;
  readonly activeDocumentId: string | undefined;
  readonly awaitingUserInput: boolean;
  readonly translationWarningReviewDecision: "pending" | "review" | "skip" | undefined;
  readonly recoveryPauseId: string | undefined;
  readonly proofreadMode: "split" | "montecarlo";
  readonly proofreadMontecarloRoundMaximum: number;
  readonly proofreadMontecarloRoundsCompleted: number;
  readonly proofreadHotSplitRequested: boolean;
  readonly suspended: boolean;
  assertWorkflowActive(): void;
  suspend(): void;
  resume(): void;
  resumeAfterExplicitContinuation(pauseId: string | undefined): void;
  configureProjectSubagentCeiling(enabled?: boolean, count?: number): void;
  activate(kind: YnWorkflowKind): void;
  selectDocument(documentId: string): void;
  registerSourceManifest(
    documents: Array<{ id: string; sourceLineCount: number; scheduleStage?: number }>,
    options?: { replace?: boolean }
  ): void;
  recordInspection(value: YnDomainInspection): void;
  recordSourceRead(documentId?: string): void;
  recordTranslationRead(documentId?: string): void;
  recordProofreadPrescan(documentId?: string): void;
  invalidateProofreadPrescan(documentId?: string): void;
  assertProofreadPrescanReady(documentId?: string): void;
  recordProofreadParentRead(kind: "source" | "translation", fromLine: number, toLine: number): void;
  recordProofreadParentSemanticReview(fromLine: number, toLine: number): void;
  resolveProofreadMontecarloLimit(action: "continue_sampling" | "switch_to_split" | "stop_and_finalize"): void;
  recordTranslationReuseAuditReady(auditIds: string[]): void;
  recordTranslationReuseDecision(auditId: string, documentId: string, fullyReused: boolean): void;
  notePendingTranslationWarningReview(): void;
  recordTranslationWarningReviewDecision(decision: "review" | "skip"): void;
  restoreAppliedTranslationReuseDecision(documentId: string, fullyReused: boolean): void;
  recordWorkflowWrite(relativePath: string): (() => void) | undefined;
  recordTranslationWrite(kind: "translation"): () => void;
  recordTranslationArtifactMutation(
    documentId?: string,
    range?: { fromLine: number; toLine: number }
  ): () => void;
  recordProofreadRangeValidated(documentId: string, fromLine: number, toLine: number): void;
  ownsCurrentTranslationArtifact(documentId: string): boolean;
  recordTranslationValidation(kind: "translation", debt: number, documentId?: string): void;
  pendingTranslationValidationDocumentIds(): string[];
  recordProofreadArtifactReset(documentId?: string): void;
  recordProofreadArtifactMutation(documentId?: string): void;
  recordProofreadMontecarloRound(findingsCount: number, exhaustive?: boolean): void;
  recordProofreadHotSplitCompleted(): void;
  assertProofreadReportReady(documentId?: string): void;
  recordProofreadReportFinalized(documentId?: string): void;
  assertCanStartSubagentBatch(kind: YnWorkflowKind): void;
  assertCanStartGeneralSubagentBatch(): void;
  recordGeneralSubagentBatchStarted(batchId: string, taskCount: number): void;
  recordGeneralSubagentBatchFailure(batchId: string, error?: string): void;
  recordGeneralSubagentBatch(batchId: string, resultCount: number): void;
  recordSubagentBatchStarted(
    kind: YnWorkflowKind,
    batchId: string,
    start: YnSubagentBatchStart
  ): void;
  recordSubagentBatchFailure(kind: YnWorkflowKind, batchId: string, documentIds?: string[]): void;
  recordSubagentBatchStartFailure(kind: YnWorkflowKind, batchId: string, documentIds?: string[]): void;
  recordSubagentBatchProgress(kind: YnWorkflowKind, batchId: string, documentIds?: string[]): void;
  recordSubagentBatch(kind: YnWorkflowKind, batchId: string, count: number, documentIds?: string[]): void;
  recordSubagentBatchSettlement(
    kind: YnWorkflowKind,
    batchId: string,
    settlements: YnSubagentDocumentSettlement[]
  ): void;
  recordTranslationAssignmentsReconciled(
    evidence: Array<{ documentId: string; acceptedScopeCount: number }>
  ): void;
  recordProofreadAssignmentsReconciled(
    evidence: Array<{ documentId: string; acceptedScopeCount: number }>
  ): void;
  recordTranslationDiscoveries(records: YnTranslationDiscoveryRecord[]): () => void;
  translationDiscoveryObservations(): YnTranslationDiscoveryRecord[];
  pendingTranslationDiscoveries(): YnTranslationDiscoveryRecord[];
  recordTranslationDiscoveryConflicts(conflicts: YnTranslationDiscoveryConflict[]): () => void;
  replaceTranslationDiscoveryConflicts(conflicts: YnTranslationDiscoveryConflict[]): () => void;
  pendingTranslationDiscoveryConflicts(): YnTranslationDiscoveryConflict[];
  waitForTranslationTerminologyGate(signal?: AbortSignal): Promise<void>;
  releaseTranslationTerminologyGate(): void;
  resolveTranslationDiscoveries(
    discoveryIds: string[],
    resolvedTerms?: YnResolvedTranslationTerm[]
  ): () => void;
  resolvedTranslationTerms(): YnResolvedTranslationTerm[];
  recordTranslationTerminologyDebt(debt: YnTranslationTerminologyDebt[]): () => void;
  pendingTranslationTerminologyDebt(): YnTranslationTerminologyDebt[];
  recordFinalValidation(kind: "translation", documentId?: string): void;
  assertCanRecordFindingsWrite(kind: "proofread"): void;
  recordFindingsWrite(kind: "proofread", artifactChanged?: boolean): void;
  snapshot(): YnDomainRunSnapshot;
  incompleteReasons(): string[];
  nextRepairPrompt(): string | undefined;
}

export interface CreateYnDomainRunContractOptions {
  workflowIntent?: YnWorkflowKind;
  workflowRequirements?: YnWorkflowRequirements;
  subagentEnabled?: boolean;
  subagentCount?: number;
  folderSource?: boolean;
  proofreadMode?: "split" | "montecarlo";
  proofreadMontecarloRoundMin?: number;
  proofreadMontecarloRoundMax?: number;
  fullWorkflow?: boolean;
  restoreSnapshot?: YnDomainRunRestoreSnapshot;
}

interface DocumentRunState {
  id: string;
  sourceLineCount: number;
  scheduleStage: number;
  sourceRead: boolean;
  translationRead: boolean;
  activeSubagentBatch?: {
    kind: YnWorkflowKind;
    id: string;
    workerCount: number;
    expectedResultCount: number;
    readOnly: boolean;
    artifactRevisionAtStart: number;
  };
  completedSubagentBatch?: {
    kind: YnWorkflowKind;
    id: string;
    count: number;
    documentId?: string;
    sourceLineCount?: number;
  };
  recoveryReason?: string;
  artifactRevision: number;
  validatedArtifactRevision?: number;
  bestTranslationValidationDebt?: number;
  translationWritten: boolean;
  translationReuseApproved: boolean;
  proofreadPrescanCompleted: boolean;
  findingsWritten: boolean;
  proofreadArtifactRevision: number;
  validatedProofreadArtifactRevision?: number;
  proofreadReportFinalized: boolean;
  proofreadParentSourceRanges: Array<{ fromLine: number; toLine: number }>;
  proofreadParentTranslationRanges: Array<{ fromLine: number; toLine: number }>;
  proofreadParentSemanticRanges: Array<{ fromLine: number; toLine: number }>;
  proofreadDirtyRanges: Array<{ fromLine: number; toLine: number }>;
}

interface GeneralSubagentBatchSnapshot {
  id?: string;
  status: "not_started" | "running" | "failed" | "completed";
  expectedCount?: number;
  error?: string;
}

export interface YnDomainRunSnapshot {
  schemaVersion: 6;
  fullWorkflowActive: boolean;
  activeKind?: YnWorkflowKind;
  inspected: boolean;
  glossaryReady: boolean;
  characterBibleReady: boolean;
  workflowRequirements?: YnWorkflowRequirements;
  documents: DocumentRunState[];
  selectedDocumentId?: string;
  progressRevision: number;
  pendingTranslationReuseAuditIds: string[];
  configuredSubagentCount: number;
  generalSubagentBatch?: GeneralSubagentBatchSnapshot;
  proofreadMontecarloRounds: number;
  proofreadMontecarloCleanRounds: number;
  activeProofreadMode: "split" | "montecarlo";
  proofreadMontecarloRoundCeiling: number;
  proofreadMontecarloStopApproved: boolean;
  proofreadHotSplitRequested: boolean;
  proofreadHotSplitCompleted: boolean;
  recoveryPause?: {
    id: string;
    batchId: string;
    reason: string;
  };
  pendingTranslationDiscoveries: YnTranslationDiscoveryRecord[];
  translationDiscoveryObservations: YnTranslationDiscoveryRecord[];
  translationDiscoveryConflicts: YnTranslationDiscoveryConflict[];
  resolvedTranslationTerms: YnResolvedTranslationTerm[];
  translationTerminologyDebt: YnTranslationTerminologyDebt[];
  translationWarningReviewDecision?: "pending" | "review" | "skip";
}

/**
 * One-way persistence migration input. These fields are accepted only while
 * restoring old JSON; the current snapshot contract can neither expose nor
 * persist them, so they cannot become ambient authorization again.
 */
export type YnDomainRunRestoreSnapshot = Omit<
  YnDomainRunSnapshot,
  "schemaVersion" | "translationDiscoveryObservations" | "translationDiscoveryConflicts"
> & {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  translationDiscoveryObservations?: YnTranslationDiscoveryRecord[];
  translationDiscoveryConflicts?: YnTranslationDiscoveryConflict[];
  explicitDelegationActive?: boolean;
  explicitDelegationCountMode?: "exact" | "up_to";
  userAuthorizedTranslationReuseAuditIds?: string[];
  workflowDelegationCountMode?: "exact" | "up_to";
  explicitDelegationBatch?: GeneralSubagentBatchSnapshot;
  proofreadMontecarloDecisionAuthorized?: boolean;
};

function createDocument(id: string, sourceLineCount: number, scheduleStage = 0): DocumentRunState {
  return {
    id,
    sourceLineCount,
    scheduleStage,
    sourceRead: false,
    translationRead: false,
    artifactRevision: 0,
    translationWritten: false,
    translationReuseApproved: false,
    proofreadPrescanCompleted: false,
    findingsWritten: false,
    proofreadArtifactRevision: 0,
    proofreadReportFinalized: false,
    proofreadParentSourceRanges: [],
    proofreadParentTranslationRanges: [],
    proofreadParentSemanticRanges: [],
    proofreadDirtyRanges: []
  };
}

export function createYnDomainRunContract({
  workflowIntent,
  workflowRequirements,
  subagentEnabled,
  subagentCount,
  folderSource = false,
  proofreadMode = "split",
  proofreadMontecarloRoundMin = 2,
  proofreadMontecarloRoundMax = 5,
  fullWorkflow = true,
  restoreSnapshot
}: CreateYnDomainRunContractOptions = {}): YnDomainRunContract {
  const restored = restoreSnapshot?.schemaVersion === 1
    || restoreSnapshot?.schemaVersion === 2
    || restoreSnapshot?.schemaVersion === 3
    || restoreSnapshot?.schemaVersion === 4
    || restoreSnapshot?.schemaVersion === 5
    || restoreSnapshot?.schemaVersion === 6
    ? restoreSnapshot
    : undefined;
  let fullWorkflowActive = restored?.fullWorkflowActive ?? fullWorkflow;
  let projectDelegationEnabled = subagentEnabled === true;
  let activeKind = restored?.activeKind ?? (fullWorkflowActive ? workflowIntent : undefined);
  const activeWorkflowRequirements: YnWorkflowRequirements = restored?.workflowRequirements
    ?? (restored
      ? {
          glossaryCandidate: !restored.glossaryReady,
          characterBible: !restored.characterBibleReady
        }
      : workflowRequirements ?? {
          glossaryCandidate: false,
          characterBible: false
        });
  let inspected = restored?.inspected ?? false;
  let glossaryReady = restored?.glossaryReady ?? !activeWorkflowRequirements.glossaryCandidate;
  let characterBibleReady = restored?.characterBibleReady ?? !activeWorkflowRequirements.characterBible;
  const documents = new Map<string, DocumentRunState>((restored?.documents ?? []).map((document) => {
    const {
      proofreadSummaryWritten: legacyProofreadSummaryWritten,
      ...currentDocument
    } = document as DocumentRunState & { proofreadSummaryWritten?: boolean };
    const completed = document.completedSubagentBatch;
    const completionHasDocumentProof = !folderSource
      || ((restored?.schemaVersion === 2 || restored?.schemaVersion === 3 || restored?.schemaVersion === 4 || restored?.schemaVersion === 5 || restored?.schemaVersion === 6)
        && completed?.documentId === document.id
        && completed.sourceLineCount === document.sourceLineCount);
    const discardedCompletion = completed !== undefined && !completionHasDocumentProof;
    const recoveryReason = discardedCompletion
      ? restored?.schemaVersion === 1
        ? `unbound legacy child completion ${completed.id} was discarded after restart; rerun the Host-planned batch`
        : `mismatched child completion ${completed.id} was discarded after restart; rerun the Host-planned batch`
      : document.recoveryReason;
    return [
      document.id,
      {
        ...currentDocument,
        activeSubagentBatch: undefined,
        completedSubagentBatch: discardedCompletion ? undefined : completed,
        recoveryReason,
        findingsWritten: discardedCompletion && completed.kind === "proofread"
          ? false
          : document.findingsWritten,
        validatedProofreadArtifactRevision: discardedCompletion && completed.kind === "proofread"
          ? undefined
          : document.validatedProofreadArtifactRevision,
        proofreadReportFinalized: discardedCompletion && completed.kind === "proofread"
          ? false
          : document.proofreadReportFinalized
            ?? legacyProofreadSummaryWritten
            ?? false,
        proofreadParentSourceRanges: [...document.proofreadParentSourceRanges],
        proofreadParentTranslationRanges: [...document.proofreadParentTranslationRanges],
        proofreadParentSemanticRanges: [...(document.proofreadParentSemanticRanges ?? [])],
        proofreadDirtyRanges: [...(document.proofreadDirtyRanges ?? [])]
      }
    ];
  }));
  let selectedDocumentId: string | undefined = restored?.selectedDocumentId;
  let progressRevision = restored?.progressRevision ?? 0;
  let suspended = false;
  let lastRepairProgressRevision = -1;
  let stalledRepairPrompts = 0;
  const pendingTranslationReuseAuditIds = new Set<string>(restored?.pendingTranslationReuseAuditIds ?? []);
  let configuredSubagentCount = restored?.configuredSubagentCount
    ?? resolveWorkflowSubagentCount(subagentEnabled, subagentCount);
  let generalSubagentBatch: {
    id?: string;
    status: "not_started" | "running" | "failed" | "completed";
    expectedCount?: number;
    error?: string;
  } | undefined = (restored?.schemaVersion === 3 || restored?.schemaVersion === 4 || restored?.schemaVersion === 5 || restored?.schemaVersion === 6) && restored.generalSubagentBatch
    ? {
        ...restored.generalSubagentBatch,
        status: restored.generalSubagentBatch.status === "running" ? "failed" : restored.generalSubagentBatch.status,
        error: restored.generalSubagentBatch.status === "running"
          ? "The previous process ended while this child batch was running. Retry the bounded batch."
          : restored.generalSubagentBatch.error
      }
    : undefined;
  let proofreadMontecarloRounds = restored?.proofreadMontecarloRounds ?? 0;
  let proofreadMontecarloCleanRounds = restored?.proofreadMontecarloCleanRounds ?? 0;
  let activeProofreadMode = restored?.activeProofreadMode ?? proofreadMode;
  let proofreadMontecarloRoundCeiling = restored?.proofreadMontecarloRoundCeiling ?? proofreadMontecarloRoundMax;
  let proofreadMontecarloStopApproved = restored?.proofreadMontecarloStopApproved ?? false;
  let proofreadHotSplitRequested = restored?.proofreadHotSplitRequested ?? false;
  let proofreadHotSplitCompleted = restored?.proofreadHotSplitCompleted ?? false;
  let recoveryPause = (restored?.schemaVersion === 4 || restored?.schemaVersion === 5 || restored?.schemaVersion === 6) && restored.recoveryPause
    ? { ...restored.recoveryPause }
    : undefined;
  let pendingTranslationDiscoveries = restored?.schemaVersion === 4 || restored?.schemaVersion === 5 || restored?.schemaVersion === 6
    ? structuredClone(restored.pendingTranslationDiscoveries ?? [])
    : [];
  let translationDiscoveryObservations = restored?.schemaVersion === 6
    ? structuredClone(restored.translationDiscoveryObservations ?? [])
    : structuredClone(pendingTranslationDiscoveries);
  let translationDiscoveryConflicts = restored?.schemaVersion === 6
    ? structuredClone(restored.translationDiscoveryConflicts ?? [])
    : [];
  let resolvedTranslationTerms = restored?.schemaVersion === 4 || restored?.schemaVersion === 5 || restored?.schemaVersion === 6
    ? structuredClone(restored.resolvedTranslationTerms ?? [])
    : [];
  let translationTerminologyDebt = restored?.schemaVersion === 4 || restored?.schemaVersion === 5 || restored?.schemaVersion === 6
    ? structuredClone(restored.translationTerminologyDebt ?? [])
    : [];
  let translationWarningReviewDecision = restored?.translationWarningReviewDecision === "pending"
    || restored?.translationWarningReviewDecision === "review"
    || restored?.translationWarningReviewDecision === "skip"
    ? restored.translationWarningReviewDecision
    : undefined;
  const terminologyGateWaiters = new Set<() => void>();
  const terminologyGateClosed = () => translationDiscoveryConflicts.length > 0;
  const wakeTerminologyGateWaiters = () => {
    if (terminologyGateClosed()) return;
    for (const wake of terminologyGateWaiters) wake();
    terminologyGateWaiters.clear();
  };
  if (proofreadMontecarloRoundMax < proofreadMontecarloRoundMin) {
    throw new Error("proofreadMontecarloRoundMax must be greater than or equal to proofreadMontecarloRoundMin.");
  }
  const montecarloConverged = () => activeProofreadMode !== "montecarlo"
    || proofreadMontecarloStopApproved
    || proofreadHotSplitCompleted
    || (proofreadMontecarloRounds >= proofreadMontecarloRoundMin && proofreadMontecarloCleanRounds >= 2);
  const montecarloDecisionRequired = () => activeProofreadMode === "montecarlo"
    && !montecarloConverged()
    && !proofreadHotSplitRequested
    && proofreadMontecarloRounds >= proofreadMontecarloRoundCeiling;

  const mergeRange = (
    ranges: Array<{ fromLine: number; toLine: number }>,
    next: { fromLine: number; toLine: number }
  ): Array<{ fromLine: number; toLine: number }> => {
    const sorted = [...ranges, next].sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine);
    const merged: Array<{ fromLine: number; toLine: number }> = [];
    for (const range of sorted) {
      const previous = merged.at(-1);
      if (!previous || range.fromLine > previous.toLine + 1) merged.push({ ...range });
      else previous.toLine = Math.max(previous.toLine, range.toLine);
    }
    return merged;
  };
  const coversWholeDocument = (
    ranges: Array<{ fromLine: number; toLine: number }>,
    document: DocumentRunState
  ): boolean => ranges.length === 1
    && ranges[0].fromLine === 1
    && ranges[0].toLine >= document.sourceLineCount;
  const semanticProofreadCoverageReady = (document: DocumentRunState): boolean => (
    document.proofreadDirtyRanges.length === 0
    && (
      document.completedSubagentBatch?.kind === "proofread"
      || coversWholeDocument(document.proofreadParentSemanticRanges, document)
    )
  );

  const subtractRange = (
    ranges: Array<{ fromLine: number; toLine: number }>,
    completed: { fromLine: number; toLine: number }
  ): Array<{ fromLine: number; toLine: number }> => ranges.flatMap((range) => {
    if (completed.toLine < range.fromLine || completed.fromLine > range.toLine) return [{ ...range }];
    const remaining: Array<{ fromLine: number; toLine: number }> = [];
    if (completed.fromLine > range.fromLine) {
      remaining.push({ fromLine: range.fromLine, toLine: completed.fromLine - 1 });
    }
    if (completed.toLine < range.toLine) {
      remaining.push({ fromLine: completed.toLine + 1, toLine: range.toLine });
    }
    return remaining;
  });

  const assertCanRecordFindingsWrite = (kind: "proofread"): DocumentRunState => {
    activate(kind);
    const document = requireDocument();
    if (!document.proofreadPrescanCompleted) {
      throw new Error(
        `Complete the full deterministic proofreading prescan for ${document.id} with inspectTranslationContext before semantic review.`
      );
    }
    if (!semanticProofreadCoverageReady(document)) {
      throw new Error(
        `Proofreading findings require semantic coverage from a completed Host-planned child batch or explicit parent semantic review covering the complete aligned range for ${document.id}. Read receipts alone do not satisfy this gate.`
      );
    }
    return document;
  };

  const rangeCovered = (
    ranges: Array<{ fromLine: number; toLine: number }>,
    fromLine: number,
    toLine: number
  ): boolean => ranges.some((range) => range.fromLine <= fromLine && range.toLine >= toLine);

  const markProgress = (): void => {
    if (suspended) {
      throw new Error(
        "The previous YN workflow is suspended. Call resumeYnWorkflow before continuing that Host-owned workflow."
      );
    }
    progressRevision += 1;
  };

  const activate = (kind: YnWorkflowKind): void => {
    if (suspended) {
      throw new Error(
        "The previous YN workflow is suspended. Call resumeYnWorkflow before continuing that Host-owned workflow."
      );
    }
    if (!activeKind) {
      activeKind = kind;
      markProgress();
      return;
    }
    if (activeKind !== kind) {
      if (!fullWorkflowActive) {
        const activeBatch = [...documents.values()].find((document) => document.activeSubagentBatch);
        if (activeBatch || generalSubagentBatch?.status === "running") {
          throw new Error("Settle the current native Pi child batch before switching this bounded operation to another tool family.");
        }
        activeKind = kind;
        markProgress();
        return;
      }
      throw new Error(`The active ${activeKind} workflow cannot be satisfied with ${kind} tools or artifacts.`);
    }
  };

  const requireDocument = (documentId = selectedDocumentId): DocumentRunState => {
    if (!documentId) throw new Error("Inspect and select a source document before using workflow artifact tools.");
    const document = documents.get(documentId);
    if (!document) throw new Error(`The selected source document ${documentId} is not in this workflow manifest.`);
    return document;
  };

  const maximumSubagentsFor = (document: DocumentRunState): number => (
    !fullWorkflowActive && !projectDelegationEnabled
      ? 0
      : folderSource && fullWorkflowActive && (activeKind === "translation" || activeKind === "proofread")
      ? (configuredSubagentCount > 0 ? 1 : 0)
      : configuredSubagentCount === 0
        ? 0
        : maximumWorkflowSubagents(true, configuredSubagentCount, document.sourceLineCount)
  );

  const assertCanStartSubagentBatch = (kind: YnWorkflowKind): void => {
    if (!fullWorkflowActive && !projectDelegationEnabled) {
      throw new Error(
        "This bounded operation has no configured specialized worker pool; use parent-owned repair or prompt-defined runSubagents."
      );
    }
    if (recoveryPause) {
      throw new Error(
        `YN child batch ${recoveryPause.batchId} is paused after an exhausted assignment. `
        + "Call resumeYnWorkflow before starting another Host-owned child batch; parent-owned reads, writes, and listed takeovers may continue."
      );
    }
    activate(kind);
    const activeBatch = [...documents.values()]
      .map((document) => document.activeSubagentBatch)
      .find((batch) => batch !== undefined);
    if (activeBatch) {
      throw new Error(
        `Pi child batch ${activeBatch.id} is still current; settle it before starting another ${kind} batch.`
      );
    }
  };

  const configureProjectSubagentCeiling = (enabled?: boolean, count?: number): void => {
    const nextCount = resolveWorkflowSubagentCount(enabled, count);
    const nextProjectDelegationEnabled = enabled === true;
    const changed = configuredSubagentCount !== nextCount
      || projectDelegationEnabled !== nextProjectDelegationEnabled;
    configuredSubagentCount = nextCount;
    projectDelegationEnabled = nextProjectDelegationEnabled;
    if (changed && !suspended) markProgress();
  };

  const batchDocuments = (documentIds?: string[]): DocumentRunState[] => {
    const ids = documentIds?.length
      ? [...new Set(documentIds.map((id) => id.trim()).filter(Boolean))]
      : [selectedDocumentId ?? ""];
    if (ids.length === 0 || ids.some((id) => !documents.has(id))) {
      throw new Error(`Source child batch contains an unknown document: ${ids.join(", ")}`);
    }
    return ids.map((id) => requireDocument(id));
  };

  const documentReason = (document: DocumentRunState, reason: string): string => (
    documents.size > 1 ? `${document.id}: ${reason}` : reason
  );

  const registerSourceManifest = (
    manifestDocuments: Array<{ id: string; sourceLineCount: number; scheduleStage?: number }>,
    options: { replace?: boolean } = {}
  ): void => {
    const normalized = manifestDocuments.map((valueDocument) => {
      if (!valueDocument.id.trim()) throw new Error("A source document ID is required.");
      if (!Number.isInteger(valueDocument.sourceLineCount) || valueDocument.sourceLineCount < 1) {
        throw new Error(`Invalid source line count for ${valueDocument.id}: ${valueDocument.sourceLineCount}.`);
      }
      const scheduleStage = valueDocument.scheduleStage ?? 0;
      if (!Number.isInteger(scheduleStage) || scheduleStage < 0) {
        throw new Error(`Invalid folder-order stage for ${valueDocument.id}: ${scheduleStage}.`);
      }
      return { ...valueDocument, id: valueDocument.id.trim(), scheduleStage };
    });
    const incomingIds = new Set(normalized.map((document) => document.id));
    if (incomingIds.size !== normalized.length) throw new Error("Source manifest contains duplicate document IDs.");
    if (options.replace) {
      const activeRemoved = [...documents.values()].find((document) => (
        !incomingIds.has(document.id) && document.activeSubagentBatch !== undefined
      ));
      if (activeRemoved) {
        throw new Error(`Cannot remove source document ${activeRemoved.id} while its Pi child batch is active.`);
      }
    }
    for (const valueDocument of normalized) {
      const existing = documents.get(valueDocument.id);
      if (existing && existing.sourceLineCount !== valueDocument.sourceLineCount) {
        throw new Error(`Source manifest changed for ${valueDocument.id}: ${existing.sourceLineCount} -> ${valueDocument.sourceLineCount} lines.`);
      }
    }
    if (options.replace) {
      for (const id of [...documents.keys()]) {
        if (!incomingIds.has(id)) documents.delete(id);
      }
    }
    for (const valueDocument of normalized) {
      const existing = documents.get(valueDocument.id);
      if (existing) {
        if (options.replace) existing.scheduleStage = valueDocument.scheduleStage;
      } else {
        documents.set(
          valueDocument.id,
          createDocument(valueDocument.id, valueDocument.sourceLineCount, valueDocument.scheduleStage)
        );
      }
    }
    if (selectedDocumentId && !documents.has(selectedDocumentId)) selectedDocumentId = undefined;
    if (!selectedDocumentId && normalized.length > 0) selectedDocumentId = normalized[0].id;
  };

  const documentComplete = (document: DocumentRunState): boolean => {
    const maximumChildren = maximumSubagentsFor(document);
    if (activeKind === "translation") {
      const translatedByAcceptedBatch = document.completedSubagentBatch?.kind === "translation";
      const workComplete = document.translationReuseApproved
        || translatedByAcceptedBatch
        || (maximumChildren === 0 && document.translationWritten);
      return workComplete === true
        && document.artifactRevision > 0
        && document.validatedArtifactRevision === document.artifactRevision;
    }
    if (activeKind === "proofread") {
      const childWorkComplete = maximumChildren === 0
        || document.completedSubagentBatch?.kind === "proofread";
      return document.sourceRead
        && document.translationRead
        && document.proofreadPrescanCompleted
        && document.proofreadDirtyRanges.length === 0
        && childWorkComplete
        && document.findingsWritten
        && document.validatedProofreadArtifactRevision === document.proofreadArtifactRevision
        && document.proofreadReportFinalized;
    }
    return false;
  };

  const incompleteReasons = (): string[] => {
    const reasons: string[] = [];
    if (recoveryPause) {
      reasons.push(
        `wait for explicit user continuation after failed child batch ${recoveryPause.batchId}: ${recoveryPause.reason}`
      );
    }
    if (pendingTranslationReuseAuditIds.size > 0) {
      reasons.push("confirm existing translation reuse with the user before changing the candidate artifact");
    }
    if (pendingTranslationDiscoveries.length > 0) {
      const glossaryCount = pendingTranslationDiscoveries.filter((entry) => entry.kind === "glossary").length;
      const characterCount = pendingTranslationDiscoveries.length - glossaryCount;
      reasons.push(
        `resolve ${glossaryCount} terminology and ${characterCount} character discovery record(s) from the current translation run`
      );
    }
    if (translationDiscoveryConflicts.length > 0) {
      reasons.push(
        `resolve ${translationDiscoveryConflicts.length} blocking terminology conflict(s) before translation workers claim more assignments`
      );
    }
    if (translationTerminologyDebt.length > 0) {
      const documentCount = new Set(translationTerminologyDebt.map((entry) => entry.documentId)).size;
      reasons.push(
        `repair ${translationTerminologyDebt.length} cross-file terminology inconsistency line(s) in ${documentCount} document(s)`
      );
    }
    if (generalSubagentBatch?.status === "running") {
      reasons.push(`wait for native Pi child batch ${generalSubagentBatch.id} to settle`);
    } else if (generalSubagentBatch?.status === "failed") {
        reasons.push(
          `retry or repair failed native Pi child batch ${generalSubagentBatch.id}`
          + (generalSubagentBatch.error ? `: ${generalSubagentBatch.error}` : "")
        );
    }
    if (activeKind === "translation" && !fullWorkflowActive) {
      for (const document of documents.values()) {
        if (document.artifactRevision > 0 && document.validatedArtifactRevision !== document.artifactRevision) {
          reasons.push(documentReason(document, "run successful whole-artifact validation after the bounded translation repair"));
        }
      }
    }
    if (!activeKind || !fullWorkflowActive) return reasons;
    if (!inspected || documents.size === 0) reasons.push("inspect translation context");
    if (activeKind === "translation") {
      if (activeWorkflowRequirements.glossaryCandidate && !glossaryReady) {
        reasons.push("create the requested glossary candidate file");
      }
      if (activeWorkflowRequirements.characterBible && !characterBibleReady) {
        reasons.push("create the requested character bible");
      }
    }
    for (const document of documents.values()) {
      if (document.recoveryReason) reasons.push(documentReason(document, document.recoveryReason));
      const maximumChildren = maximumSubagentsFor(document);
      if (activeKind === "translation") {
        if (
          maximumChildren > 0
          && !document.translationReuseApproved
          && document.completedSubagentBatch?.kind !== "translation"
        ) {
          reasons.push(documentReason(
            document,
            `complete one host-accepted batch using between 1 and ${configuredSubagentCount} translation subagents`
          ));
        }
        if (
          maximumChildren === 0
          && document.completedSubagentBatch?.kind !== "translation"
          && !document.translationWritten
          && !document.translationReuseApproved
        ) {
          reasons.push(documentReason(
            document,
            document.sourceLineCount === 1
              ? "write the single-line translation through the host artifact writer"
              : "write the translation through the host artifact writer"
          ));
        }
        if (document.artifactRevision === 0 || document.validatedArtifactRevision !== document.artifactRevision) {
          reasons.push(documentReason(
            document,
            document.bestTranslationValidationDebt && document.bestTranslationValidationDebt > 0
              ? `complete final warning review for ${document.bestTranslationValidationDebt} unreviewed warning signal(s), repair true positives, then rerun whole-artifact validation`
              : "run successful whole-artifact validation"
          ));
        }
      } else {
        for (const range of document.proofreadDirtyRanges) {
          reasons.push(documentReason(
            document,
            `re-proofread the changed candidate range L${range.fromLine}-${range.toLine} without restarting the complete workflow`
          ));
        }
        if (!document.proofreadPrescanCompleted) {
          reasons.push(documentReason(document, "complete the full deterministic H3/H4/H7/H8/H9 proofreading prescan plus the M0 mechanical-alignment scan"));
        }
        if (!document.sourceRead) reasons.push(documentReason(document, "read the aligned source range"));
        if (!document.translationRead) reasons.push(documentReason(document, "read the aligned translation range"));
        if (maximumChildren > 0 && document.completedSubagentBatch?.kind !== "proofread") {
          reasons.push(documentReason(
            document,
            `complete one host-planned batch using between 1 and ${configuredSubagentCount} proofreading subagents`
          ));
        }
        if (!document.findingsWritten || document.validatedProofreadArtifactRevision !== document.proofreadArtifactRevision) {
          reasons.push(documentReason(document, "write the normalized proofreading findings artifact"));
        }
        if (activeProofreadMode === "montecarlo" && !montecarloConverged()) {
          reasons.push(documentReason(
            document,
            proofreadHotSplitRequested
              ? "complete the user-selected HOT-region split review"
              : montecarloDecisionRequired()
              ? `Monte Carlo proofreading reached its maximum ${proofreadMontecarloRoundCeiling} rounds without convergence and requires a user decision to continue, switch to split review, or stop with current findings`
              : `continue Monte Carlo proofreading (${proofreadMontecarloRounds}/${proofreadMontecarloRoundMin}-${proofreadMontecarloRoundCeiling} rounds; ${proofreadMontecarloCleanRounds}/2 consecutive clean rounds)`
          ));
        }
        if (!document.proofreadReportFinalized) {
          reasons.push(documentReason(document, "finalize the normalized proofreading findings JSON"));
        }
      }
    }
    return reasons;
  };

  const recordTranslationValidation = (kind: "translation", debt: number, documentId?: string): void => {
    activate(kind);
    if (!Number.isInteger(debt) || debt < 0) throw new Error(`Invalid translation validation debt: ${debt}.`);
    const document = requireDocument(documentId);
    if (debt === 0) {
      if (document.validatedArtifactRevision !== document.artifactRevision) markProgress();
      document.validatedArtifactRevision = document.artifactRevision;
      document.bestTranslationValidationDebt = 0;
      if (translationWarningReviewDecision !== "skip") translationWarningReviewDecision = undefined;
      return;
    }
    document.validatedArtifactRevision = undefined;
    if (document.bestTranslationValidationDebt === undefined || debt < document.bestTranslationValidationDebt) {
      document.bestTranslationValidationDebt = debt;
      markProgress();
    }
  };

  return {
    get kind() {
      return activeKind;
    },
    get fullWorkflow() {
      return fullWorkflowActive;
    },
    get workflowRequirements() {
      return { ...activeWorkflowRequirements };
    },
    get maximumSubagentsForActiveDocument() {
      return selectedDocumentId ? maximumSubagentsFor(requireDocument()) : configuredSubagentCount;
    },
    get configuredSubagents() {
      return configuredSubagentCount;
    },
    get activeDocumentId() {
      return selectedDocumentId;
    },
    get awaitingUserInput() {
      return pendingTranslationReuseAuditIds.size > 0
        || montecarloDecisionRequired()
        || recoveryPause !== undefined
        || translationWarningReviewDecision === "pending";
    },
    get translationWarningReviewDecision() {
      return translationWarningReviewDecision;
    },
    get recoveryPauseId() {
      return recoveryPause?.id;
    },
    get proofreadMode() {
      return activeProofreadMode;
    },
    get proofreadMontecarloRoundMaximum() {
      return proofreadMontecarloRoundCeiling;
    },
    get proofreadMontecarloRoundsCompleted() {
      return proofreadMontecarloRounds;
    },
    get proofreadHotSplitRequested() {
      return proofreadHotSplitRequested;
    },
    get suspended() {
      return suspended;
    },
    assertWorkflowActive() {
      if (suspended) {
        throw new Error(
          "The previous YN workflow is suspended. Call resumeYnWorkflow before continuing that Host-owned workflow."
        );
      }
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
      if (recoveryPause) {
        recoveryPause = undefined;
        progressRevision += 1;
      }
    },
    resumeAfterExplicitContinuation(_pauseId) {
      if (!recoveryPause) return;
      recoveryPause = undefined;
      progressRevision += 1;
    },
    configureProjectSubagentCeiling,
    assertCanStartGeneralSubagentBatch() {
      if (generalSubagentBatch?.status === "running") {
        throw new Error(
          `Native Pi child batch ${generalSubagentBatch.id ?? "unknown"} is still running; settle it before starting another batch.`
        );
      }
    },
    activate,
    registerSourceManifest,
    selectDocument(documentId) {
      const id = documentId.trim();
      const selected = documents.get(id);
      if (!selected) throw new Error(`Source document ${id} is not in this workflow manifest.`);
      const running = [...documents.values()].find((document) => (
        document.activeSubagentBatch && !document.activeSubagentBatch.readOnly
      ));
      if (running && running.id !== id) {
        throw new Error(`Source document ${running.id} still owns active Pi child batch ${running.activeSubagentBatch?.id}.`);
      }
      if (folderSource) {
        const blocked = [...documents.values()].filter((document) => (
          document.scheduleStage < selected.scheduleStage && !documentComplete(document)
        ));
        if (blocked.length > 0) {
          throw new Error(
            `Complete the earlier folder-order stage before selecting ${id}: ${blocked.map((document) => document.id).join(", ")}.`
          );
        }
      }
      selectedDocumentId = id;
    },
    recordInspection(value) {
      const inspectedDocuments = value.documents?.length
        ? value.documents
        : [{ id: selectedDocumentId ?? "source", sourceLineCount: value.sourceLineCount }];
      registerSourceManifest(inspectedDocuments);
      const changed = !inspected
        || (!glossaryReady && value.glossaryCandidateExists)
        || (!characterBibleReady && value.characterBibleExists);
      inspected = true;
      glossaryReady ||= value.glossaryCandidateExists;
      characterBibleReady ||= value.characterBibleExists;
      if (changed) markProgress();
    },
    recordSourceRead(documentId) {
      const document = requireDocument(documentId);
      if (!document.sourceRead) markProgress();
      document.sourceRead = true;
    },
    recordTranslationRead(documentId) {
      const document = requireDocument(documentId);
      if (!document.translationRead) markProgress();
      document.translationRead = true;
    },
    recordProofreadPrescan(documentId) {
      activate("proofread");
      const document = requireDocument(documentId);
      if (!document.proofreadPrescanCompleted) markProgress();
      document.proofreadPrescanCompleted = true;
      document.sourceRead = true;
      document.translationRead = true;
    },
    invalidateProofreadPrescan(documentId) {
      activate("proofread");
      const document = requireDocument(documentId);
      if (
        document.proofreadPrescanCompleted
        || document.completedSubagentBatch?.kind === "proofread"
        || document.findingsWritten
        || document.proofreadReportFinalized
      ) markProgress();
      document.proofreadPrescanCompleted = false;
      document.sourceRead = false;
      document.translationRead = false;
      document.proofreadParentSourceRanges = [];
      document.proofreadParentTranslationRanges = [];
      document.proofreadParentSemanticRanges = [];
      document.proofreadDirtyRanges = [];
      if (document.completedSubagentBatch?.kind === "proofread") document.completedSubagentBatch = undefined;
      if (document.activeSubagentBatch?.kind === "proofread") document.activeSubagentBatch = undefined;
      document.findingsWritten = false;
      document.proofreadReportFinalized = false;
      document.validatedProofreadArtifactRevision = undefined;
      proofreadMontecarloRounds = 0;
      proofreadMontecarloCleanRounds = 0;
      proofreadMontecarloStopApproved = false;
      proofreadHotSplitRequested = false;
      proofreadHotSplitCompleted = false;
    },
    assertProofreadPrescanReady(documentId?: string) {
      activate("proofread");
      const document = requireDocument(documentId);
      if (!document.proofreadPrescanCompleted) {
        throw new Error(
          `Complete the full deterministic proofreading prescan for ${document.id} with inspectTranslationContext before semantic review.`
        );
      }
    },
    recordProofreadParentRead(kind, fromLine, toLine) {
      activate("proofread");
      const document = requireDocument();
      if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > document.sourceLineCount) {
        throw new Error(`Invalid parent proofreading ${kind} range L${fromLine}-L${toLine} for ${document.sourceLineCount} aligned lines.`);
      }
      if (kind === "source") {
        document.proofreadParentSourceRanges = mergeRange(document.proofreadParentSourceRanges, { fromLine, toLine });
        document.sourceRead = true;
      } else {
        document.proofreadParentTranslationRanges = mergeRange(document.proofreadParentTranslationRanges, { fromLine, toLine });
        document.translationRead = true;
      }
      markProgress();
    },
    recordProofreadParentSemanticReview(fromLine, toLine) {
      activate("proofread");
      const document = requireDocument();
      if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > document.sourceLineCount) {
        throw new Error(`Invalid parent semantic proofreading range L${fromLine}-L${toLine} for ${document.sourceLineCount} aligned lines.`);
      }
      if (
        !rangeCovered(document.proofreadParentSourceRanges, fromLine, toLine)
        || !rangeCovered(document.proofreadParentTranslationRanges, fromLine, toLine)
      ) {
        throw new Error(
          `Read the complete aligned source and translation range L${fromLine}-L${toLine} before recording parent semantic review.`
        );
      }
      document.proofreadParentSemanticRanges = mergeRange(
        document.proofreadParentSemanticRanges,
        { fromLine, toLine }
      );
      markProgress();
    },
    resolveProofreadMontecarloLimit(action) {
      activate("proofread");
      if (!montecarloDecisionRequired()) {
        throw new Error("Monte Carlo proofreading is not awaiting a maximum-round user decision.");
      }
      if (action === "continue_sampling") {
        proofreadMontecarloRoundCeiling += 3;
      } else if (action === "switch_to_split") {
        proofreadHotSplitRequested = true;
        proofreadHotSplitCompleted = false;
        for (const document of documents.values()) {
          if (document.completedSubagentBatch?.kind === "proofread") document.completedSubagentBatch = undefined;
          document.proofreadReportFinalized = false;
        }
      } else {
        proofreadMontecarloStopApproved = true;
      }
      markProgress();
    },
    recordTranslationReuseAuditReady(auditIds) {
      this.assertWorkflowActive();
      activate("translation");
      const ids = [...new Set(auditIds.map((id) => id.trim()).filter(Boolean))];
      const changed = ids.length !== pendingTranslationReuseAuditIds.size
        || ids.some((id) => !pendingTranslationReuseAuditIds.has(id));
      pendingTranslationReuseAuditIds.clear();
      for (const id of ids) pendingTranslationReuseAuditIds.add(id);
      if (changed) markProgress();
    },
    recordTranslationReuseDecision(auditId, documentId, fullyReused) {
      activate("translation");
      const id = auditId.trim();
      if (!id) throw new Error("A translation reuse audit ID is required.");
      const document = requireDocument(documentId);
      document.translationReuseApproved = fullyReused;
      pendingTranslationReuseAuditIds.delete(id);
      markProgress();
    },
    restoreAppliedTranslationReuseDecision(documentId, fullyReused) {
      activate("translation");
      const document = requireDocument(documentId);
      document.translationReuseApproved = fullyReused;
      markProgress();
    },
    recordWorkflowWrite(relativePath) {
      // A bounded operation may write a project asset while another complete
      // workflow is parked. That write must not silently satisfy or resume the
      // parked workflow's completion contract.
      if (suspended) return undefined;
      const previousGlossaryReady = glossaryReady;
      const previousCharacterBibleReady = characterBibleReady;
      const previousProgressRevision = progressRevision;
      const normalized = relativePath.replace(/\\/g, "/");
      if (normalized === "AI_translation/_workspace/glossary_candidates.json" && !glossaryReady) {
        glossaryReady = true;
        markProgress();
      }
      if (normalized === "AI_translation/_workspace/character_bible.md" && !characterBibleReady) {
        characterBibleReady = true;
        markProgress();
      }
      if (
        previousGlossaryReady === glossaryReady
        && previousCharacterBibleReady === characterBibleReady
      ) return undefined;
      return () => {
        glossaryReady = previousGlossaryReady;
        characterBibleReady = previousCharacterBibleReady;
        progressRevision = previousProgressRevision;
      };
    },
    recordTranslationWrite(kind) {
      const previousActiveKind = activeKind;
      const previousProgressRevision = progressRevision;
      activate(kind);
      const document = requireDocument();
      const previousDocumentState: DocumentRunState = {
        ...document,
        proofreadParentSourceRanges: document.proofreadParentSourceRanges.map((entry) => ({ ...entry })),
        proofreadParentTranslationRanges: document.proofreadParentTranslationRanges.map((entry) => ({ ...entry })),
        proofreadParentSemanticRanges: document.proofreadParentSemanticRanges.map((entry) => ({ ...entry })),
        proofreadDirtyRanges: document.proofreadDirtyRanges.map((entry) => ({ ...entry })),
        ...(document.activeSubagentBatch ? { activeSubagentBatch: { ...document.activeSubagentBatch } } : {}),
        ...(document.completedSubagentBatch ? { completedSubagentBatch: { ...document.completedSubagentBatch } } : {})
      };
      if (!document.translationWritten) markProgress();
      document.translationWritten = true;
      const wasValidated = document.validatedArtifactRevision === document.artifactRevision;
      document.artifactRevision += 1;
      document.validatedArtifactRevision = undefined;
      if (wasValidated) document.bestTranslationValidationDebt = undefined;
      if (translationWarningReviewDecision === "skip") translationWarningReviewDecision = undefined;
      return () => {
        activeKind = previousActiveKind;
        progressRevision = previousProgressRevision;
        documents.set(previousDocumentState.id, previousDocumentState);
      };
    },
    recordTranslationArtifactMutation(documentId?: string, range?: { fromLine: number; toLine: number }) {
      const previousActiveKind = activeKind;
      const previousProgressRevision = progressRevision;
      const previousDocument = requireDocument(documentId);
      const previousDocumentState: DocumentRunState = {
        ...previousDocument,
        proofreadParentSourceRanges: previousDocument.proofreadParentSourceRanges.map((entry) => ({ ...entry })),
        proofreadParentTranslationRanges: previousDocument.proofreadParentTranslationRanges.map((entry) => ({ ...entry })),
        proofreadParentSemanticRanges: previousDocument.proofreadParentSemanticRanges.map((entry) => ({ ...entry })),
        proofreadDirtyRanges: previousDocument.proofreadDirtyRanges.map((entry) => ({ ...entry })),
        ...(previousDocument.activeSubagentBatch
          ? { activeSubagentBatch: { ...previousDocument.activeSubagentBatch } }
          : {}),
        ...(previousDocument.completedSubagentBatch
          ? { completedSubagentBatch: { ...previousDocument.completedSubagentBatch } }
          : {})
      };
      // A bounded candidate repair is an artifact mutation, not a request to
      // replace the active workflow. Proofreading may legitimately repair a
      // rejected line and then re-review that scope without restarting the
      // complete translation workflow.
      if (!activeKind) activate("translation");
      const document = requireDocument(documentId);
      const wasValidated = document.validatedArtifactRevision === document.artifactRevision;
      document.artifactRevision += 1;
      document.validatedArtifactRevision = undefined;
      if (wasValidated) document.bestTranslationValidationDebt = undefined;
      if (translationWarningReviewDecision === "skip") translationWarningReviewDecision = undefined;
      if (activeKind === "proofread") {
        const dirtyRange = range ?? { fromLine: 1, toLine: document.sourceLineCount };
        if (
          !Number.isInteger(dirtyRange.fromLine)
          || !Number.isInteger(dirtyRange.toLine)
          || dirtyRange.fromLine < 1
          || dirtyRange.toLine < dirtyRange.fromLine
          || dirtyRange.toLine > document.sourceLineCount
        ) {
          throw new Error(
            `Invalid bounded proofreading repair L${dirtyRange.fromLine}-${dirtyRange.toLine} for ${document.sourceLineCount} lines.`
          );
        }
        document.proofreadDirtyRanges = mergeRange(document.proofreadDirtyRanges, dirtyRange);
        document.proofreadReportFinalized = false;
        document.proofreadArtifactRevision += 1;
        document.validatedProofreadArtifactRevision = undefined;
      }
      // A separate bounded repair may update the candidate while an older
      // complete workflow remains suspended. Record the artifact revision
      // without implicitly resuming that workflow.
      if (suspended) progressRevision += 1;
      else markProgress();
      return () => {
        activeKind = previousActiveKind;
        progressRevision = previousProgressRevision;
        documents.set(previousDocumentState.id, previousDocumentState);
      };
    },
    recordProofreadRangeValidated(documentId: string, fromLine: number, toLine: number) {
      if (activeKind !== "proofread") {
        throw new Error("A bounded proofreading review cannot settle a non-proofread workflow.");
      }
      const document = requireDocument(documentId);
      if (
        !Number.isInteger(fromLine)
        || !Number.isInteger(toLine)
        || fromLine < 1
        || toLine < fromLine
        || toLine > document.sourceLineCount
      ) {
        throw new Error(`Invalid reviewed proofreading range L${fromLine}-${toLine}.`);
      }
      const previous = document.proofreadDirtyRanges;
      document.proofreadDirtyRanges = subtractRange(previous, { fromLine, toLine });
      if (document.findingsWritten && document.proofreadDirtyRanges.length === 0) {
        document.validatedProofreadArtifactRevision = document.proofreadArtifactRevision;
      }
      if (document.proofreadDirtyRanges.length !== previous.length
        || document.proofreadDirtyRanges.some((range, index) => (
          range.fromLine !== previous[index]?.fromLine || range.toLine !== previous[index]?.toLine
        ))) {
        markProgress();
      }
    },
    ownsCurrentTranslationArtifact(documentId) {
      return requireDocument(documentId).artifactRevision > 0;
    },
    recordTranslationValidation,
    pendingTranslationValidationDocumentIds() {
      return [...documents.values()]
        .filter((document) => (
          document.artifactRevision > 0
          && document.validatedArtifactRevision !== document.artifactRevision
        ))
        .map((document) => document.id);
    },
    recordProofreadArtifactReset(documentId) {
      activate("proofread");
      const document = requireDocument(documentId);
      document.proofreadArtifactRevision += 1;
      document.findingsWritten = false;
      document.proofreadReportFinalized = false;
      document.validatedProofreadArtifactRevision = undefined;
    },
    recordProofreadArtifactMutation(documentId) {
      activate("proofread");
      const document = requireDocument(documentId);
      if (!document.findingsWritten) markProgress();
      document.findingsWritten = true;
      document.proofreadReportFinalized = false;
      document.proofreadArtifactRevision += 1;
      document.validatedProofreadArtifactRevision = undefined;
    },
    recordProofreadMontecarloRound(findingsCount, exhaustive = false) {
      activate("proofread");
      if (activeProofreadMode !== "montecarlo") {
        throw new Error("Monte Carlo round state cannot be recorded for split proofreading.");
      }
      if (montecarloDecisionRequired()) {
        throw new Error("Monte Carlo proofreading reached its round ceiling and is awaiting the user's decision.");
      }
      if (!Number.isInteger(findingsCount) || findingsCount < 0) {
        throw new Error(`Invalid Monte Carlo findings count: ${findingsCount}.`);
      }
      proofreadMontecarloRounds += 1;
      if (exhaustive) {
        proofreadMontecarloRounds = Math.max(proofreadMontecarloRounds, proofreadMontecarloRoundMin);
        proofreadMontecarloCleanRounds = 2;
      } else {
        proofreadMontecarloCleanRounds = findingsCount === 0 ? proofreadMontecarloCleanRounds + 1 : 0;
      }
      markProgress();
    },
    recordProofreadHotSplitCompleted() {
      activate("proofread");
      if (!proofreadHotSplitRequested) {
        throw new Error("HOT-region split review was not selected by the user.");
      }
      proofreadHotSplitCompleted = true;
      markProgress();
    },
    assertProofreadReportReady(documentId) {
      activate("proofread");
      const document = requireDocument(documentId);
      this.assertProofreadPrescanReady(document.id);
      if (!semanticProofreadCoverageReady(document)) {
        throw new Error("Proofreading semantic coverage is incomplete; finish the Host-planned children or explicitly record complete parent semantic review after reading both aligned sides.");
      }
      if (!document.findingsWritten || document.validatedProofreadArtifactRevision !== document.proofreadArtifactRevision) {
        throw new Error("The normalized proofreading findings JSON must be complete before finalization.");
      }
      if (!montecarloConverged()) {
        throw new Error("Monte Carlo proofreading has not reached its round/convergence gate.");
      }
    },
    recordProofreadReportFinalized(documentId) {
      this.assertProofreadReportReady(documentId);
      const document = requireDocument(documentId);
      if (!document.proofreadReportFinalized) markProgress();
      document.proofreadReportFinalized = true;
    },
    assertCanStartSubagentBatch,
    recordGeneralSubagentBatchStarted(batchId, taskCount) {
      const id = batchId.trim();
      if (!id) throw new Error("A native Pi child batch ID is required.");
      if (!Number.isInteger(taskCount) || taskCount < 1) {
        throw new Error(`A general Pi child batch requires a positive task count; received ${taskCount}.`);
      }
      if (generalSubagentBatch?.status === "running") {
        throw new Error(`Native Pi child batch ${generalSubagentBatch.id} is still running; settle it before starting ${id}.`);
      }
      generalSubagentBatch = {
        id,
        status: "running",
        expectedCount: taskCount
      };
    },
    recordGeneralSubagentBatchFailure(batchId, error) {
      const id = batchId.trim();
      if (generalSubagentBatch?.status !== "running" || generalSubagentBatch.id !== id) {
        throw new Error(
          `Cannot fail stale general child batch ${id}; current batch is ${generalSubagentBatch?.id ?? "none"}.`
        );
      }
      generalSubagentBatch = {
        ...generalSubagentBatch,
        status: "failed",
        error: error?.trim() || undefined
      };
    },
    recordGeneralSubagentBatch(batchId, resultCount) {
      const id = batchId.trim();
      if (generalSubagentBatch?.status !== "running" || generalSubagentBatch.id !== id) {
        throw new Error(
          `Cannot complete stale general child batch ${id}; current batch is ${generalSubagentBatch?.id ?? "none"}.`
        );
      }
      if (!Number.isInteger(resultCount) || resultCount !== generalSubagentBatch.expectedCount) {
        throw new Error(
          `General child batch ${id} completed ${resultCount} results for ${generalSubagentBatch.expectedCount} tasks.`
        );
      }
      generalSubagentBatch = {
        ...generalSubagentBatch,
        status: "completed",
        error: undefined
      };
      // A bounded batch may settle while the complete workflow is parked.
      // Persist that independent operation without implicitly resuming or
      // mutating the parked workflow contract.
      if (suspended) progressRevision += 1;
      else markProgress();
    },
    recordSubagentBatchStarted(kind, batchId, start) {
      assertCanStartSubagentBatch(kind);
      const id = batchId.trim();
      if (!id) throw new Error("A native Pi child batch ID is required.");
      const { taskCount, workerCount, documentIds } = start;
      if (!Number.isInteger(taskCount) || taskCount < 1) {
        throw new Error(`A native Pi child batch requires a positive task count; received ${taskCount}.`);
      }
      if (!Number.isInteger(workerCount) || workerCount < 1) {
        throw new Error(`A native Pi child batch requires a positive worker count; received ${workerCount}.`);
      }
      const batch = batchDocuments(documentIds);
      const assignmentCounts = start.assignmentCounts;
      if (assignmentCounts) {
        const knownIds = new Set(batch.map((document) => document.id));
        const entries = Object.entries(assignmentCounts);
        if (
          entries.length !== batch.length
          || entries.some(([documentId, count]) => (
            !knownIds.has(documentId) || !Number.isInteger(count) || count < 0
          ))
          || entries.reduce((sum, [, count]) => sum + count, 0) !== taskCount
        ) {
          throw new Error(
            `Native Pi child batch ${id} assignmentCounts must contain every owned batch document exactly once, use non-negative counts, and total ${taskCount}.`
          );
        }
      }
      for (const document of batch) {
        if (kind === "proofread" && !document.proofreadPrescanCompleted) {
          throw new Error(
            `Complete the full deterministic proofreading prescan for ${document.id} before starting semantic subagents.`
          );
        }
        if (maximumSubagentsFor(document) === 0) {
          throw new Error("This workflow is completed by the parent Agent and does not launch shard subagents.");
        }
        if (document.activeSubagentBatch) {
          throw new Error(`Pi child batch ${document.activeSubagentBatch.id} is still current; settle it before starting ${id}.`);
        }
      }
      const workerCountCeiling = start.workerCountContract === "review_ceiling"
        ? start.workerCountCeiling
        : configuredSubagentCount;
      if (!Number.isInteger(workerCountCeiling) || workerCountCeiling! < 1) {
        throw new Error(`Native Pi child batch ${id} requires a positive worker-count ceiling.`);
      }
      if (workerCount > workerCountCeiling!) {
        throw new Error(
          `Native Pi child batch ${id} starts ${workerCount} workers; the configured upper bound is ${workerCountCeiling}.`
        );
      }
      for (const document of batch) {
        document.activeSubagentBatch = {
          kind,
          id,
          workerCount,
          expectedResultCount: assignmentCounts?.[document.id] ?? taskCount,
          readOnly: kind === "proofread" || start.readOnly === true,
          artifactRevisionAtStart: document.artifactRevision
        };
        document.completedSubagentBatch = undefined;
        document.recoveryReason = undefined;
      }
    },
    recordSubagentBatchFailure(kind, batchId, documentIds) {
      activate(kind);
      const batch = batchDocuments(documentIds);
      for (const document of batch) {
        if (document.activeSubagentBatch?.kind !== kind || document.activeSubagentBatch.id !== batchId) {
          throw new Error(`Cannot fail stale child batch ${batchId}; current batch is ${document.activeSubagentBatch?.id ?? "none"}.`);
        }
      }
      for (const document of batch) {
        document.activeSubagentBatch = undefined;
        document.recoveryReason = `retry the failed assignment(s) from child batch ${batchId}`;
      }
      progressRevision += 1;
      recoveryPause = {
        id: `recovery-${batchId}-${progressRevision}`,
        batchId,
        reason: "one or more child assignments failed before Host acceptance"
      };
    },
    recordSubagentBatchStartFailure(kind, batchId, documentIds) {
      activate(kind);
      const batch = batchDocuments(documentIds);
      for (const document of batch) {
        if (document.activeSubagentBatch?.kind !== kind || document.activeSubagentBatch.id !== batchId) {
          throw new Error(
            `Cannot roll back stale child batch reservation ${batchId}; current batch is ${document.activeSubagentBatch?.id ?? "none"}.`
          );
        }
      }
      for (const document of batch) {
        document.activeSubagentBatch = undefined;
        document.recoveryReason = undefined;
      }
    },
    recordSubagentBatchProgress(kind, batchId, documentIds) {
      activate(kind);
      const batch = batchDocuments(documentIds);
      for (const document of batch) {
        if (document.activeSubagentBatch?.kind !== kind || document.activeSubagentBatch.id !== batchId) {
          throw new Error(`Cannot settle stale child progress batch ${batchId}; current batch is ${document.activeSubagentBatch?.id ?? "none"}.`);
        }
      }
      for (const document of batch) document.activeSubagentBatch = undefined;
      markProgress();
    },
    recordSubagentBatch(kind, batchId, count, documentIds) {
      activate(kind);
      const batch = batchDocuments(documentIds);
      for (const document of batch) {
        if (document.activeSubagentBatch?.kind !== kind || document.activeSubagentBatch.id !== batchId) {
          throw new Error(`Cannot complete stale child batch ${batchId}; current batch is ${document.activeSubagentBatch?.id ?? "none"}.`);
        }
      }
      const normalizedCount = Math.max(0, Math.floor(count));
      const expectedResultCount = batch[0]?.activeSubagentBatch?.expectedResultCount;
      if (!Number.isInteger(count) || expectedResultCount === undefined || normalizedCount !== expectedResultCount) {
        throw new Error(
          `Pi child batch ${batchId} completed ${count} results for ${expectedResultCount ?? "an unknown number of"} accepted tasks.`
        );
      }
      for (const document of batch) {
        const activeBatch = document.activeSubagentBatch!;
        const candidateRevisionIsCurrent = activeBatch.artifactRevisionAtStart === document.artifactRevision;
        document.activeSubagentBatch = undefined;
        document.completedSubagentBatch = {
          kind,
          id: batchId,
          count: normalizedCount,
          documentId: document.id,
          sourceLineCount: document.sourceLineCount
        };
        document.recoveryReason = undefined;
        if (kind === "proofread" && candidateRevisionIsCurrent) {
          if (!document.findingsWritten) markProgress();
          document.findingsWritten = true;
          document.validatedProofreadArtifactRevision = document.proofreadArtifactRevision;
          document.proofreadDirtyRanges = [];
        }
        markProgress();
      }
    },
    recordSubagentBatchSettlement(kind, batchId, settlements) {
      activate(kind);
      const normalized = settlements.map((settlement) => ({
        ...settlement,
        documentId: settlement.documentId.trim(),
        failedResultCount: settlement.failedResultCount ?? 0
      }));
      const settlementIds = new Set(normalized.map((settlement) => settlement.documentId));
      if (settlementIds.size !== normalized.length) {
        throw new Error(`Pi child batch ${batchId} contains duplicate document settlements.`);
      }
      const activeDocuments = [...documents.values()].filter((document) => (
        document.activeSubagentBatch?.kind === kind && document.activeSubagentBatch.id === batchId
      ));
      if (
        activeDocuments.length === 0
        || activeDocuments.length !== normalized.length
        || activeDocuments.some((document) => !settlementIds.has(document.id))
      ) {
        throw new Error(
          `Cannot settle stale or incomplete child batch ${batchId}; expected ${activeDocuments.map((document) => document.id).join(", ") || "no active documents"}.`
        );
      }
      let failedAssignments = 0;
      const failureMessages: string[] = [];
      for (const settlement of normalized) {
        if (
          !Number.isInteger(settlement.acceptedResultCount)
          || settlement.acceptedResultCount < 0
          || !Number.isInteger(settlement.failedResultCount)
          || settlement.failedResultCount < 0
        ) {
          throw new Error(`Invalid assignment settlement counts for ${settlement.documentId}.`);
        }
        const document = requireDocument(settlement.documentId);
        const activeBatch = document.activeSubagentBatch!;
        if (settlement.acceptedResultCount > activeBatch.expectedResultCount) {
          throw new Error(
            `Pi child batch ${batchId} accepted ${settlement.acceptedResultCount} results for ${settlement.documentId}, `
            + `but only ${activeBatch.expectedResultCount} assignments were reserved.`
          );
        }
        const complete = settlement.acceptedResultCount === activeBatch.expectedResultCount
          && settlement.failedResultCount === 0;
        document.activeSubagentBatch = undefined;
        if (complete) {
          const candidateRevisionIsCurrent = activeBatch.artifactRevisionAtStart === document.artifactRevision;
          document.completedSubagentBatch = {
            kind,
            id: batchId,
            count: settlement.acceptedResultCount,
            documentId: document.id,
            sourceLineCount: document.sourceLineCount
          };
          document.recoveryReason = undefined;
          if (kind === "proofread" && candidateRevisionIsCurrent) {
            if (!document.findingsWritten) markProgress();
            document.findingsWritten = true;
            document.validatedProofreadArtifactRevision = document.proofreadArtifactRevision;
            document.proofreadDirtyRanges = [];
          }
        } else {
          document.completedSubagentBatch = undefined;
          const outstanding = Math.max(0, activeBatch.expectedResultCount - settlement.acceptedResultCount);
          document.recoveryReason = [
            `complete ${outstanding} unsettled assignment(s) from child batch ${batchId}`,
            settlement.error?.trim()
          ].filter(Boolean).join(": ");
          failedAssignments += Math.max(1, settlement.failedResultCount);
          if (settlement.error?.trim()) failureMessages.push(`${document.id}: ${settlement.error.trim()}`);
        }
        progressRevision += 1;
      }
      if (failedAssignments > 0) {
        recoveryPause = {
          id: `recovery-${batchId}-${progressRevision}`,
          batchId,
          reason: failureMessages.join(" | ") || `${failedAssignments} assignment(s) exhausted their bounded retry path`
        };
      }
    },
    recordTranslationAssignmentsReconciled(evidence) {
      if (activeKind !== "translation") {
        throw new Error("Translation assignment reconciliation requires an active translation workflow.");
      }
      if (evidence.length === 0) return;
      const ids = evidence.map((entry) => entry.documentId);
      const counts = new Map<string, number>();
      for (const entry of evidence) {
        if (
          counts.has(entry.documentId)
          || !Number.isInteger(entry.acceptedScopeCount)
          || entry.acceptedScopeCount < 1
        ) {
          throw new Error(
            "Translation assignment reconciliation requires one positive hash-current accepted scope count per document."
          );
        }
        counts.set(entry.documentId, entry.acceptedScopeCount);
      }
      const batch = batchDocuments(ids);
      for (const document of batch) {
        if (document.activeSubagentBatch) {
          throw new Error(
            `Cannot reconcile translation assignments while child batch ${document.activeSubagentBatch.id} is active for ${document.id}.`
          );
        }
        // Hash-current Host alignment evidence proves that a candidate exists
        // even after restoring an older snapshot that predates artifact
        // revision tracking. Rehydrate the revision instead of demanding a
        // token-wasting replacement batch; whole-artifact validation remains
        // a separate required gate.
        if (document.artifactRevision < 1) {
          document.artifactRevision = 1;
          document.validatedArtifactRevision = undefined;
        }
        document.completedSubagentBatch = {
          kind: "translation",
          id: `host-recovered-hash-current-r${document.artifactRevision}`,
          count: counts.get(document.id)!,
          documentId: document.id,
          sourceLineCount: document.sourceLineCount
        };
        document.recoveryReason = undefined;
      }
      markProgress();
    },
    recordProofreadAssignmentsReconciled(evidence) {
      if (activeKind !== "proofread") {
        throw new Error("Proofreading assignment reconciliation requires an active proofreading workflow.");
      }
      if (evidence.length === 0) return;
      const counts = new Map<string, number>();
      for (const entry of evidence) {
        if (
          counts.has(entry.documentId)
          || !Number.isInteger(entry.acceptedScopeCount)
          || entry.acceptedScopeCount < 1
        ) {
          throw new Error(
            "Proofreading assignment reconciliation requires one positive hash-current accepted scope count per document."
          );
        }
        counts.set(entry.documentId, entry.acceptedScopeCount);
      }
      const batch = batchDocuments([...counts.keys()]);
      for (const document of batch) {
        if (document.activeSubagentBatch) {
          throw new Error(
            `Cannot reconcile proofreading assignments while child batch ${document.activeSubagentBatch.id} is active for ${document.id}.`
          );
        }
        if (!document.proofreadPrescanCompleted || !document.findingsWritten) {
          throw new Error(
            `Cannot reconcile proofreading assignments for ${document.id} without current prescan and findings artifacts.`
          );
        }
        document.completedSubagentBatch = {
          kind: "proofread",
          id: `host-recovered-hash-current-proofread-r${document.proofreadArtifactRevision}`,
          count: counts.get(document.id)!,
          documentId: document.id,
          sourceLineCount: document.sourceLineCount
        };
        document.validatedProofreadArtifactRevision = document.proofreadArtifactRevision;
        document.proofreadDirtyRanges = [];
        document.recoveryReason = undefined;
      }
      markProgress();
    },
    recordTranslationDiscoveries(records) {
      const previousPending = pendingTranslationDiscoveries;
      const previousObservations = translationDiscoveryObservations;
      const previousProgressRevision = progressRevision;
      if (records.length === 0) return () => undefined;
      const existing = new Set(pendingTranslationDiscoveries.map((record) => record.id));
      const additions = records.filter((record) => !existing.has(record.id));
      if (additions.length === 0) return () => undefined;
      pendingTranslationDiscoveries = [...pendingTranslationDiscoveries, ...structuredClone(additions)];
      const observed = new Set(translationDiscoveryObservations.map((record) => record.id));
      translationDiscoveryObservations = [
        ...translationDiscoveryObservations,
        ...structuredClone(additions.filter((record) => !observed.has(record.id)))
      ];
      markProgress();
      return () => {
        pendingTranslationDiscoveries = previousPending;
        translationDiscoveryObservations = previousObservations;
        progressRevision = previousProgressRevision;
      };
    },
    translationDiscoveryObservations() {
      return structuredClone(translationDiscoveryObservations);
    },
    pendingTranslationDiscoveries() {
      return structuredClone(pendingTranslationDiscoveries);
    },
    recordTranslationDiscoveryConflicts(conflicts) {
      const previous = translationDiscoveryConflicts;
      const previousProgressRevision = progressRevision;
      if (conflicts.length === 0) return () => undefined;
      const bySource = new Map(translationDiscoveryConflicts.map((conflict) => [
        conflict.source.trim().normalize("NFC"),
        conflict
      ]));
      for (const conflict of conflicts) {
        const source = conflict.source.trim().normalize("NFC");
        if (!source || conflict.observedTargets.length < 2) {
          throw new Error("A translation terminology conflict requires one source and at least two observed targets.");
        }
        const existing = bySource.get(source);
        bySource.set(source, existing ? {
          ...existing,
          batchId: conflict.batchId,
          observedTargets: [...new Set([...existing.observedTargets, ...conflict.observedTargets]
            .map((value) => value.trim().normalize("NFC")).filter(Boolean))],
          discoveryIds: [...new Set([...existing.discoveryIds, ...conflict.discoveryIds])],
          documentIds: [...new Set([...existing.documentIds, ...conflict.documentIds])],
          affectedRanges: [...new Map(
            [...existing.affectedRanges, ...conflict.affectedRanges].map((range) => [
              `${range.documentId}\0${range.fromLine}\0${range.toLine}\0${range.sourceHash}\0${range.candidateHash}`,
              range
            ])
          ).values()]
        } : structuredClone({ ...conflict, source }));
      }
      translationDiscoveryConflicts = [...bySource.values()];
      markProgress();
      return () => {
        translationDiscoveryConflicts = previous;
        progressRevision = previousProgressRevision;
        wakeTerminologyGateWaiters();
      };
    },
    replaceTranslationDiscoveryConflicts(conflicts) {
      const previous = translationDiscoveryConflicts;
      const previousProgressRevision = progressRevision;
      const normalized = structuredClone(conflicts);
      if (JSON.stringify(normalized) === JSON.stringify(translationDiscoveryConflicts)) return () => undefined;
      translationDiscoveryConflicts = normalized;
      markProgress();
      return () => {
        translationDiscoveryConflicts = previous;
        progressRevision = previousProgressRevision;
      };
    },
    pendingTranslationDiscoveryConflicts() {
      return structuredClone(translationDiscoveryConflicts);
    },
    async waitForTranslationTerminologyGate(signal) {
      if (!terminologyGateClosed()) return;
      if (signal?.aborted) throw signal.reason ?? new DOMException("Translation terminology gate wait was aborted.", "AbortError");
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          terminologyGateWaiters.delete(wake);
          reject(signal?.reason ?? new DOMException("Translation terminology gate wait was aborted.", "AbortError"));
        };
        terminologyGateWaiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (!terminologyGateClosed()) {
          terminologyGateWaiters.delete(wake);
          wake();
        }
      });
    },
    releaseTranslationTerminologyGate() {
      if (terminologyGateClosed()) {
        throw new Error("Cannot release the translation terminology gate while unresolved conflicts remain.");
      }
      wakeTerminologyGateWaiters();
    },
    resolveTranslationDiscoveries(discoveryIds, terms = []) {
      const previousDiscoveries = pendingTranslationDiscoveries;
      const previousTerms = resolvedTranslationTerms;
      const previousConflicts = translationDiscoveryConflicts;
      const previousProgressRevision = progressRevision;
      const ids = new Set(discoveryIds.map((id) => id.trim()).filter(Boolean));
      if (ids.size !== discoveryIds.length) {
        throw new Error("Translation discovery resolution contains an empty or duplicate discovery ID.");
      }
      const known = new Set(pendingTranslationDiscoveries.map((record) => record.id));
      const unknown = [...ids].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new Error(`Translation discovery resolution contains stale IDs: ${unknown.join(", ")}.`);
      }
      pendingTranslationDiscoveries = pendingTranslationDiscoveries.filter((record) => !ids.has(record.id));
      const bySource = new Map(resolvedTranslationTerms.map((term) => [term.source.normalize("NFC"), term]));
      for (const term of terms) {
        const source = term.source.trim().normalize("NFC");
        const target = term.target.trim().normalize("NFC");
        if (!source || !target) throw new Error("A resolved translation term requires non-empty source and target text.");
        bySource.set(source, {
          source,
          target,
          observedTargets: [...new Set(term.observedTargets.map((value) => value.trim().normalize("NFC")).filter(Boolean))]
        });
      }
      resolvedTranslationTerms = [...bySource.values()];
      const remainingIds = new Set(pendingTranslationDiscoveries.map((record) => record.id));
      translationDiscoveryConflicts = translationDiscoveryConflicts.filter((conflict) => (
        conflict.discoveryIds.some((id) => remainingIds.has(id))
      ));
      markProgress();
      return () => {
        pendingTranslationDiscoveries = previousDiscoveries;
        resolvedTranslationTerms = previousTerms;
        translationDiscoveryConflicts = previousConflicts;
        progressRevision = previousProgressRevision;
      };
    },
    resolvedTranslationTerms() {
      return structuredClone(resolvedTranslationTerms);
    },
    recordTranslationTerminologyDebt(debt) {
      const previous = translationTerminologyDebt;
      const previousProgressRevision = progressRevision;
      const normalized = structuredClone(debt).sort((left, right) => (
        left.documentId.localeCompare(right.documentId, "en") || left.line - right.line || left.source.localeCompare(right.source)
      ));
      if (JSON.stringify(normalized) === JSON.stringify(translationTerminologyDebt)) return () => undefined;
      translationTerminologyDebt = normalized;
      markProgress();
      return () => {
        translationTerminologyDebt = previous;
        progressRevision = previousProgressRevision;
      };
    },
    pendingTranslationTerminologyDebt() {
      return structuredClone(translationTerminologyDebt);
    },
    notePendingTranslationWarningReview() {
      if (translationWarningReviewDecision !== "review") {
        translationWarningReviewDecision = "pending";
      }
    },
    recordTranslationWarningReviewDecision(decision) {
      if (decision !== "review" && decision !== "skip") {
        throw new Error(`Invalid translation warning-review decision: ${decision}.`);
      }
      translationWarningReviewDecision = decision;
      if (decision === "skip") {
        for (const document of documents.values()) {
          if (document.artifactRevision > 0) recordTranslationValidation("translation", 0, document.id);
        }
      }
    },
    recordFinalValidation(kind, documentId?: string) {
      recordTranslationValidation(kind, 0, documentId);
    },
    assertCanRecordFindingsWrite(kind) {
      assertCanRecordFindingsWrite(kind);
    },
    recordFindingsWrite(kind, artifactChanged = true) {
      const document = assertCanRecordFindingsWrite(kind);
      const stateChanged = artifactChanged || !document.findingsWritten;
      if (!stateChanged) return;
      if (!document.findingsWritten) markProgress();
      document.findingsWritten = true;
      document.proofreadReportFinalized = false;
      document.proofreadArtifactRevision += 1;
      document.validatedProofreadArtifactRevision = document.proofreadArtifactRevision;
    },
    snapshot() {
      return {
        schemaVersion: 6,
        fullWorkflowActive,
        activeKind,
        inspected,
        glossaryReady,
        characterBibleReady,
        workflowRequirements: { ...activeWorkflowRequirements },
        documents: [...documents.values()].map((document) => ({
          ...document,
          proofreadParentSourceRanges: document.proofreadParentSourceRanges.map((range) => ({ ...range })),
          proofreadParentTranslationRanges: document.proofreadParentTranslationRanges.map((range) => ({ ...range })),
          proofreadParentSemanticRanges: document.proofreadParentSemanticRanges.map((range) => ({ ...range })),
          proofreadDirtyRanges: document.proofreadDirtyRanges.map((range) => ({ ...range })),
          ...(document.activeSubagentBatch ? { activeSubagentBatch: { ...document.activeSubagentBatch } } : {}),
          ...(document.completedSubagentBatch ? { completedSubagentBatch: { ...document.completedSubagentBatch } } : {})
        })),
        selectedDocumentId,
        progressRevision,
        pendingTranslationReuseAuditIds: [...pendingTranslationReuseAuditIds],
        configuredSubagentCount,
        ...(generalSubagentBatch ? { generalSubagentBatch: { ...generalSubagentBatch } } : {}),
        proofreadMontecarloRounds,
        proofreadMontecarloCleanRounds,
        activeProofreadMode,
        proofreadMontecarloRoundCeiling,
        proofreadMontecarloStopApproved,
        proofreadHotSplitRequested,
        proofreadHotSplitCompleted,
        ...(recoveryPause ? { recoveryPause: { ...recoveryPause } } : {}),
        pendingTranslationDiscoveries: structuredClone(pendingTranslationDiscoveries),
        translationDiscoveryObservations: structuredClone(translationDiscoveryObservations),
        translationDiscoveryConflicts: structuredClone(translationDiscoveryConflicts),
        resolvedTranslationTerms: structuredClone(resolvedTranslationTerms),
        translationTerminologyDebt: structuredClone(translationTerminologyDebt),
        ...(translationWarningReviewDecision ? { translationWarningReviewDecision } : {})
      };
    },
    incompleteReasons,
    nextRepairPrompt() {
      if (this.awaitingUserInput) return undefined;
      const reasons = incompleteReasons();
      if (reasons.length === 0) return undefined;
      if (lastRepairProgressRevision === progressRevision) {
        stalledRepairPrompts += 1;
      } else {
        lastRepairProgressRevision = progressRevision;
        stalledRepairPrompts = 0;
      }
      return [
        "The YN host completion contract is not yet satisfied.",
        ...reasons.map((reason) => `- ${reason}`),
        ...(stalledRepairPrompts > 0 ? [
          `No host-observed progress was made after ${stalledRepairPrompts} continuation turn${stalledRepairPrompts === 1 ? "" : "s"}. Change the tool action, inspect the failed child evidence, and retry the bounded task; an explanation alone cannot complete it.`
        ] : []),
        "Do not repeat a waiting or status reply. Continue the current workflow now with native tools. Repair validation failures instead of reporting completion."
      ].join("\n");
    }
  };
}
