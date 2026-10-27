import { readSessionContext, appendSessionMessage, appendSessionCustomEntry, getDiskSessionAccess } from "./sessionAccess.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
  type AgentTool,
  type AgentMessage,
  type Session,
  type ThinkingLevel
} from "@earendil-works/pi-agent-core/node";
import type { ImageContent } from "@earendil-works/pi-ai";

import type {
  PiSessionBootstrap,
  PiSessionCompactRequest,
  PiSessionCompactionResult,
  PiSessionContextUsage,
  PiSessionEventEnvelope,
  PiSessionInputKind,
  PiSessionPromptAcceptance,
  PiSessionPromptRequest,
  PiSessionWarningReviewDecisionRequest,
  PiSessionWarningReviewDecisionResult,
  PiSessionRunState,
  PiSessionStateEnvelope,
  PiSessionStorageProgress,
  PiSessionSummary,
  PiSessionRuntimeEvent
} from "../../../shared/agent/piSessionContract.ts";
import { resolveWorkflowSubagentCount } from "../../../shared/agent/piSessionContract.ts";
import { resolveThinkingLevelForModel } from "../../../shared/agent/thinkingLevels.ts";
import { createPiModelSelection } from "./providerRegistry.ts";
import { isHostUserWaitGateToolResult, isTranslationWarningReviewGateToolResult, sessionHasOpenHostUserGate } from "./userGate.ts";
import {
  createYnDomainRunContract,
  type YnDomainRunContract,
  type YnDomainRunSnapshot,
  type YnWorkflowKind
} from "./domainRunContract.ts";
import {
  appendYnSessionHostState,
  createProofreadHostState,
  createTranslationAlignmentHostState,
  loadYnSessionHostState,
  getYnHostStateLoadDiagnostics,
  type YnSessionHostState,
  type ProofreadHostState
} from "./proofreadSessionState.ts";
import type { TranslationAlignmentHostState } from "./translationAlignmentState.ts";
import { PiSessionRepository } from "./sessionRepository.ts";
import { PiQueuedInputNotConsumedError, PiSessionAgentRuntime } from "./sessionAgentRuntime.ts";
import { PDF_STRUCTURE_PREPARATION_ENTRY, pdfStructureContextNeedsReset, type PdfStructurePreparationRequest, type PdfStructurePreparationResult } from "./sessionStructurePreparation.ts";
import { NonRetryableAssignmentError, TranslationReviewBindingChangedError, isWorkflowStoppingAssignmentError } from "./assignmentFailure.ts";
import { compactSubagentCards, interruptedSubagentCards } from "./subagentMessages.ts";
import { YnSubagentSupervisor } from "./subagentSupervisor.ts";
import { buildYnSystemPrompt } from "./systemPrompt.ts";
import { listCurrentTranslationReuseAudits } from "./translationReuseAudit.ts";
import { createYnDomainTools } from "./ynDomainTools.ts";
import { parseFolderTranslationOrder } from "./folderTranslationPlan.ts";
import { resolvePiSourceManifest } from "./sourceManifest.ts";
import { preflightPdfRequest } from "../../pdfDocuments.ts";
import { ynInterfaceContextStore } from "./interfaceContextStore.ts";
import { readProjectAssets } from "../projectAssets.ts";
import { ensureYnWorkflowWorkspace } from "../workspaceAssets.ts";
import { patchProjectState, readProjectState } from "../../projectState.ts";
import {
  applyProjectTranslationBinding,
  canonicalTranslationBindingPath,
  shouldPublishCanonicalTranslationBinding
} from "../translationBindingResolve.ts";
import { isExtractedWorkshopTranslationPath } from "../../../shared/core/translationBinding.ts";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { normalizeCustomPreserveRules } from "../../../shared/validation/customPreserveRules.ts";
import {
  buildTaskPreparationPrompt, createTaskPreparationState, createTaskPreparationTools,
  taskPreparationContext, type YnTaskPreparationHost, type YnTaskPreparationState
} from "./taskPreparation.ts";

type EventListener = (envelope: PiSessionEventEnvelope) => void;

function pendingTranslationWarningSnapshot(state: Pick<YnSessionHostState, "domainRun" | "parkedDomainRuns">): YnDomainRunSnapshot | undefined {
  return [state.domainRun, state.parkedDomainRuns?.translation].find(snapshot => (
    snapshot?.fullWorkflowActive === true && snapshot.activeKind === "translation"
      && snapshot.translationWarningReviewDecision === "pending"
  ));
}

function warningReviewFromHostState(state: YnSessionHostState): PiSessionRunState["warningReview"] {
  const snapshot = pendingTranslationWarningSnapshot(state);
  if (!snapshot) return undefined;
  return state.warningReview ? { ...state.warningReview } : {
    id: `${state.ownerSessionId}:translation-warning-review:${snapshot.progressRevision}`,
    warningCount: snapshot.documents.reduce((count, document) => count + (document.bestTranslationValidationDebt ?? 0), 0)
  };
}

function translationWorkflowBindings(request: PiSessionPromptRequest): NonNullable<PiSessionWarningReviewDecisionRequest["request"]> {
  const { outputDir: _outputDir, sessionId: _sessionId, prompt: _prompt, images: _images,
    taskPreparation: _taskPreparation, workflowIntent: _workflowIntent, ...bindings } = request;
  return bindings;
}
type StateListener = (
  workspaceDir: string,
  state: PiSessionRunState,
  selectionChange: PiSessionStateEnvelope["selectionChange"]
) => void;

const PROJECT_STRING_SETTINGS = [
  "languagePair",
  "style",
  "workDescription",
  "glossaryPath",
  "subagentProviderId",
  "subagentModelId",
  "folderTranslationOrder"
] as const;
const PROJECT_INTEGER_SETTINGS = [
  "subagentCount",
  "reviewSubagentCount",
  "proofreadMontecarloSize",
  "proofreadMontecarloRoundMin",
  "proofreadMontecarloRoundMax"
] as const;

async function resolveCurrentProjectPromptRequest(
  request: PiSessionPromptRequest
): Promise<PiSessionPromptRequest> {
  const markerIntent = /^(?:\uFEFF)?Workflow: yn-(translation|proofread)-v1\.(?:\r?\n|$)/u
    .exec(request.prompt)?.[1] as "translation" | "proofread" | undefined;
  if (markerIntent && request.workflowIntent && request.workflowIntent !== markerIntent) {
    throw new Error(`Workflow marker ${markerIntent} conflicts with typed workflowIntent ${request.workflowIntent}.`);
  }
  const state = await readProjectState(request.outputDir);
  const current: Partial<PiSessionPromptRequest> = {};
  if (markerIntent) current.workflowIntent = markerIntent;
  if (state.sourcePath !== undefined && typeof state.sourcePath !== "string") {
    throw new Error("Invalid project setting sourcePath: expected a string.");
  }
  if (state.sourceKind !== undefined && state.sourceKind !== "file" && state.sourceKind !== "folder") {
    throw new Error("Invalid project setting sourceKind: expected file or folder.");
  }
  // A saved empty homepage field is an absent selection, not corrupt state.
  // Materials preparation and ordinary conversation do not require a source.
  if (typeof state.sourcePath === "string" && state.sourcePath.trim()) {
    if (state.sourceKind !== "file" && state.sourceKind !== "folder") {
      throw new Error("Invalid project setting sourceKind: expected file or folder.");
    }
    const sourcePath = path.resolve(state.sourcePath);
    const requestSourcePath = request.sourceSelection?.path ?? request.sourcePath;
    // The visible review page owns the concrete Agent text binding. Project
    // state may intentionally retain a binary source such as the original EPUB.
    if (!requestSourcePath) {
      current.sourcePath = sourcePath;
      current.sourceSelection = { kind: state.sourceKind, path: sourcePath };
      current.folderSourceDocuments = undefined;
      current.folderSourceSelection = undefined;
    }
  }
  for (const key of PROJECT_STRING_SETTINGS) {
    const value = state[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`Invalid project setting ${key}: expected a string.`);
    (current as Record<string, unknown>)[key] = value;
  }
  for (const key of ["glossaryCandidates", "characterBible", "reuseExistingTranslation", "subagentEnabled"] as const) {
    if (state[key] !== undefined) {
      if (typeof state[key] !== "boolean") {
        throw new Error(`Invalid project setting ${key}: expected a boolean.`);
      }
      current[key] = state[key];
    }
  }
  if (state.proofreadMode !== undefined) {
    if (state.proofreadMode !== "split" && state.proofreadMode !== "montecarlo") {
      throw new Error("Invalid project setting proofreadMode: expected split or montecarlo.");
    }
    current.proofreadMode = state.proofreadMode;
  }
  for (const key of PROJECT_INTEGER_SETTINGS) {
    const value = state[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`Invalid project setting ${key}: expected a positive integer.`);
    }
    (current as Record<string, unknown>)[key] = value;
  }
  if (state.splitSize !== undefined) {
    if (!Number.isInteger(state.splitSize) || (state.splitSize as number) < 1) {
      throw new Error("Invalid project setting splitSize: expected a positive integer.");
    }
    current.translationSplitSize = state.splitSize as number;
    current.proofreadSplitSize = state.splitSize as number;
  }
  current.customPreserveRules = normalizeCustomPreserveRules(state.customPreserveRules ?? request.customPreserveRules);
  const folderSource = (current.sourceSelection ?? request.sourceSelection)?.kind === "folder"
    || request.sourceSelection?.kind === "folder";
  let translationState = state;
  const proofreadIntent = current.workflowIntent === "proofread" || request.workflowIntent === "proofread";
  const incomingTranslation = request.translationPath?.trim() || "";
  if (
    proofreadIntent
    && shouldPublishCanonicalTranslationBinding(translationState)
    && (!incomingTranslation || isExtractedWorkshopTranslationPath(incomingTranslation))
  ) {
    const canonicalPath = canonicalTranslationBindingPath({
      outputDir: request.outputDir,
      folderSource,
      sourcePath: current.sourcePath ?? request.sourcePath,
      documentId: path.basename(current.sourcePath ?? request.sourcePath ?? "translation.txt")
    });
    const alreadyBound = translationState.translationBindingOrigin === "canonical"
      && translationState.translationPath === canonicalPath;
    if (!alreadyBound && existsSync(canonicalPath)) {
      translationState = await patchProjectState(request.outputDir, {
        translationPath: canonicalPath,
        translationBindingOrigin: "canonical"
      });
    }
  }
  const translationBinding = applyProjectTranslationBinding(request, translationState);
  if (translationBinding.apply) {
    current.translationPath = translationBinding.translationPath;
    current.translationBindingOrigin = translationBinding.translationBindingOrigin;
  }
  return { ...request, ...current };
}

interface ActiveSession {
  pdfStructurePreparation?: PdfStructurePreparationOperation;
  workspaceDir: string;
  sessionId: string;
  runtime: PiSessionAgentRuntime;
  session: Session;
  unsubscribe: () => void;
  sequence: number;
  phase: PiSessionRunState["phase"];
  running: boolean;
  compacting: boolean;
  streamingMessage: AgentMessage | null;
  queuedSteer: AgentMessage[];
  queuedFollowUp: AgentMessage[];
  queuedNextTurn: AgentMessage[];
  liveSubagentMessages: Map<string, AgentMessage>;
  queuedUserOrder: QueuedInputOrderEntry[];
  error?: string;
  contextUsage?: PiSessionContextUsage;
  lastCompaction?: PiSessionCompactionResult;
  compactionError?: string;
  compactionTask?: Promise<PiSessionCompactionResult>;
  domainRun?: YnDomainRunContract;
  hostState: {
    translationWorkflowRequest?: PiSessionWarningReviewDecisionRequest["request"];
    warningReview?: PiSessionRunState["warningReview"];
    taskPreparation?: YnTaskPreparationState;
    domainRun?: YnDomainRunContract;
    parkedDomainRuns: Partial<Record<YnWorkflowKind, YnDomainRunSnapshot>>;
    workflowSuspended: boolean;
    proofread: ProofreadHostState;
    translationAlignment: TranslationAlignmentHostState;
  };
  persistHostState: (options?: { force?: boolean }) => Promise<void>;
  hostPersistence: { tail: Promise<void>; lastPersisted?: string };
  subagents: YnSubagentSupervisor;
  promptOperation?: PromptOperation;
  promptTask?: Promise<void>;
  childCompletionGeneration: number;
  reviewBindingRecovery?: { controller: AbortController; task: Promise<void>; keys: Set<string>; pending: boolean };
}

type QueuedInputKind = PiSessionInputKind | "nextTurn";

interface QueuedInputOrderEntry {
  sequence: number;
  kind: QueuedInputKind;
  text: string;
  signature: string;
  message?: AgentMessage;
  pendingNative: boolean;
}

interface OrderedQueuedMessage {
  message: AgentMessage;
  tracked?: QueuedInputOrderEntry;
}

interface SessionOperationReservation {
  pdfStructurePreparation?: PdfStructurePreparationOperation;
  preparationController?: AbortController;
  cancelled: boolean;
  stopSettlement?: Promise<void>;
}

interface PromptOperation {
  generation: number;
  cancelled: boolean;
  abortController: AbortController;
  /** Transaction undo retained only until this operation enters native input. */
  undoUnstartedWarningReview?: () => void;
}

interface PdfStructurePreparationOperation {
  controller: AbortController;
  settlement: Promise<void>;
  cancel: () => void;
}

interface PreparedRuntime {
  active: ActiveSession;
  previous?: ActiveSession;
  retirePreviousSubagents: boolean;
  preparationTimings: {
    storageOpenMs: number;
    hostRestoreMs: number;
    modelSelectionMs: number;
    runtimeSetupMs: number;
  };
}

function isWorkflowFailureReport(message: AgentMessage): boolean {
  if (message.role !== "custom" || message.customType !== "subagent-completion") return false;
  const details = message.details as { failureDisposition?: unknown } | undefined;
  return details?.failureDisposition === "host_integrity_failure"
    || details?.failureDisposition === "transport_retry_exhausted";
}

function ownedSubagentIds(active: ActiveSession | undefined): Set<string> {
  return new Set(active?.subagents.list().flatMap((batch) => (
    batch.subagents.map((subagent) => subagent.id)
  )) ?? []);
}

export interface PiNativeSessionServiceOptions {
  createModelSelection?: typeof createPiModelSelection;
  createTools?: (context: {
    supportsImages?: () => boolean;
    request: PiSessionPromptRequest;
    publishCustomMessage: (message: AgentMessage) => Promise<void>;
    subagents: YnSubagentSupervisor;
    domainRun?: YnDomainRunContract;
    proofreadState?: ProofreadHostState;
    translationAlignmentState?: TranslationAlignmentHostState;
    persistHostState?: () => Promise<void>;
    isWorkflowSuspended?: () => boolean;
    resumeWorkflow?: (kind?: "translation" | "proofread") => Promise<void>;
    parkedWorkflows?: () => Array<"translation" | "proofread">;
    readInterfaceContext?: () => ReturnType<typeof ynInterfaceContextStore.read>;
    recoverReviewBinding?: (error: TranslationReviewBindingChangedError, signal?: AbortSignal) => Promise<void>;
  }) => Promise<AgentTool[]> | AgentTool[];
  buildSystemPrompt?: (
    request: PiSessionPromptRequest,
    context: { fullWorkflow: boolean; workflowSuspended: boolean; domainRun?: YnDomainRunContract }
  ) => Promise<string> | string;
  enforceDomainCompletion?: boolean;
  appendHostState?: typeof appendYnSessionHostState;
}

const EVENT_LOG_LIMIT = 500;
const GENERIC_SYSTEM_PROMPT = [
  "You are the Agent OS embedded in YN Translation Workshop.",
  "Respond directly to ordinary conversation. For project work, inspect the provided context and use only available tools.",
  "Never expose internal event protocols, raw lifecycle messages, or hidden tool transport text to the user.",
  "Translation and proofreading constraints are supplied by YN domain tools when those workflows are requested."
].join("\n");

function workspaceKey(workspaceDir: string): string {
  return path.resolve(workspaceDir).toLowerCase();
}

function sessionKey(workspaceDir: string, sessionId: string): string {
  return `${workspaceKey(workspaceDir)}::${sessionId}`;
}

function normalizeThinkingLevel(
  model: { id: string } | undefined,
  value: ThinkingLevel | "auto" | undefined
): ThinkingLevel {
  return resolveThinkingLevelForModel(model, value);
}

function assertWorkflowPromptMetadata(request: PiSessionPromptRequest): void {
  if (request.workflowIntent && !request.languagePair?.trim()) {
    throw new Error("languagePair is required for translation and proofreading workflows.");
  }
  resolveWorkflowSubagentCount(request.subagentEnabled, request.subagentCount);
}

export { compactSubagentCards } from "./subagentMessages.ts";

function piWebDisplayMessage(message: AgentMessage): AgentMessage {
  if (message.role === "compactionSummary") {
    return {
      role: "user",
      content: [{
        type: "text",
        text: `*The conversation history before this point was compacted into the following summary:*\n\n${message.summary}`
      }],
      timestamp: message.timestamp
    };
  }
  if (message.role === "branchSummary") {
    return {
      role: "user",
      content: [{
        type: "text",
        text: `*The conversation briefly explored another branch and returned with this summary:*\n\n${message.summary}`
      }],
      timestamp: message.timestamp
    };
  }
  return message;
}

function messagesInSubmissionOrder(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message, index) => ({ message, index }))
    .sort((left, right) => (
      (left.message.timestamp ?? 0) - (right.message.timestamp ?? 0)
      || left.index - right.index
    ))
    .map(({ message }) => message);
}

function queuedUserPayload(message: AgentMessage): { text: string; images?: ImageContent[] } {
  if (message.role !== "user") {
    throw new Error(`Cannot carry queued Pi ${message.role} message into the next user turn.`);
  }
  if (typeof message.content === "string") return { text: message.content };
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const images = message.content.filter((block): block is ImageContent => block.type === "image");
  return { text, images: images.length > 0 ? images : undefined };
}

function queuedUserSignature(payload: { text: string; images?: ImageContent[] }): string {
  const images = payload.images ?? [];
  const fingerprints = images.map((image) => (
    `${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}:${image.data.slice(-24)}`
  ));
  return JSON.stringify([payload.text, fingerprints]);
}

function takeTrackedMessage(
  pool: AgentMessage[],
  entry: QueuedInputOrderEntry
): AgentMessage | undefined {
  let index = entry.message ? pool.findIndex((message) => message === entry.message) : -1;
  if (index < 0) {
    index = pool.findIndex((message) => queuedUserSignature(queuedUserPayload(message)) === entry.signature);
  }
  if (index < 0) return undefined;
  return pool.splice(index, 1)[0];
}

function orderedQueuedMessages(active: ActiveSession): OrderedQueuedMessage[] {
  const pools: Record<QueuedInputKind, AgentMessage[]> = {
    steer: [...active.queuedSteer],
    followUp: [...active.queuedFollowUp],
    nextTurn: [...active.queuedNextTurn]
  };
  const ordered: OrderedQueuedMessage[] = [];
  for (const entry of [...active.queuedUserOrder].sort((left, right) => left.sequence - right.sequence)) {
    const message = takeTrackedMessage(pools[entry.kind], entry);
    if (message) ordered.push({ message, tracked: entry });
  }
  ordered.push(...messagesInSubmissionOrder([...pools.steer, ...pools.followUp]).map((message) => ({ message })));
  ordered.push(...messagesInSubmissionOrder(pools.nextTurn).map((message) => ({ message })));
  return ordered;
}

export class PiNativeSessionService {
  private readonly coldWarningReviewStates = new Map<string, {
    path: string; stamp: string; warningReview: PiSessionRunState["warningReview"];
  }>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly sessionOperationReservations = new Map<string, SessionOperationReservation>();
  private readonly transitionTails = new Map<string, Promise<void>>();
  private readonly closingSessions = new Set<string>();
  private readonly events = new Map<string, PiSessionEventEnvelope[]>();
  private readonly coldStorageControllers = new Map<string, Set<AbortController>>();
  private readonly coldStorageSequences = new Map<string, number>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly options: PiNativeSessionServiceOptions;
  private nextQueuedInputSequence = 0;
  private nextPromptGeneration = 0;
  private taskPreparationHost?: YnTaskPreparationHost;
  private shuttingDown = false;
  private shutdownTask?: Promise<void>;

  private assertAcceptingOperations(): void {
    if (this.shuttingDown) throw new Error("YN is shutting down; wait for session storage to finish closing.");
  }

  constructor(options: PiNativeSessionServiceOptions = {}) {
    this.options = options;
  }

  configureTaskPreparationHost(host: YnTaskPreparationHost): void {
    this.taskPreparationHost = host;
  }

  subscribeEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async bootstrap(workspaceDir: string): Promise<PiSessionBootstrap> {
    const repository = new PiSessionRepository(workspaceDir);
    const [sessions, storedActive] = await Promise.all([
      repository.listSummaries(),
      repository.readActiveSessionId()
    ]);
    const activeSessionId = sessions.some((session) => session.id === storedActive)
      ? storedActive
      : sessions[0]?.id ?? "";
    return { sessions, activeSessionId };
  }

  async createSession(workspaceDir: string): Promise<PiSessionSummary> {
    this.assertAcceptingOperations();
    return this.withWorkspaceTransition(workspaceDir, async () => {
      this.assertAcceptingOperations();
      const repository = new PiSessionRepository(workspaceDir);
      const sessionId = `pi_${randomUUID()}`;
      const session = await repository.create(sessionId);
      let failure: unknown;
      let failed = false;
      let summary: PiSessionSummary;
      try {
        await repository.writeActiveSessionId(sessionId);
        summary = await repository.summaryForMetadata(session.metadata);
      } catch (error) {
        failed = true; failure = error; throw error;
      } finally {
        try { await repository.closeSession(sessionId); }
        catch (closeError) {
          if (failed) throw new AggregateError([failure, closeError], "Pi session creation and handle cleanup both failed.");
          throw closeError;
        }
      }
      this.emitState(workspaceDir, this.idleState(sessionId), true);
      return summary;
    });
  }

  async selectSession(workspaceDir: string, sessionId: string): Promise<void> {
    this.assertAcceptingOperations();
    await this.withWorkspaceTransition(workspaceDir, async () => {
      this.assertAcceptingOperations();
      const repository = new PiSessionRepository(workspaceDir);
      if (!(await repository.findMetadata(sessionId))) {
        throw new Error(`Pi session ${sessionId} was not found.`);
      }
      await repository.writeActiveSessionId(sessionId);
      const active = this.active.get(sessionKey(workspaceDir, sessionId));
      if (active) this.emitActiveState(active, true);
      else this.emitState(workspaceDir, this.idleState(sessionId), true);
    });
  }

  async deleteSession(workspaceDir: string, sessionId: string): Promise<boolean> {
    this.assertAcceptingOperations();
    const key = sessionKey(workspaceDir, sessionId);
    if (this.closingSessions.has(key)) throw new Error(`Pi session ${sessionId} is already closing.`);
    this.closingSessions.add(key);
    const reservation = this.sessionOperationReservations.get(key);
    if (reservation) { reservation.cancelled = true; reservation.preparationController?.abort(new DOMException("PDF session preparation was stopped.", "AbortError")); }
    try {
      await this.abort(workspaceDir, sessionId);
      return await this.withWorkspaceSessionTransition(workspaceDir, sessionId, async () => {
        this.assertAcceptingOperations();
        const active = this.active.get(key);
        if (active?.compacting) throw new Error("Wait for native Pi compaction before deleting this session.");
        active?.unsubscribe();
        active?.runtime.dispose();
        await active?.session.close(BACKGROUND_CONTEXT);
        this.active.delete(key);
        this.events.delete(key);
        this.coldStorageSequences.delete(key);

        const repository = new PiSessionRepository(workspaceDir);
        const selectedSessionId = await repository.readActiveSessionId();
        const removed = await repository.delete(sessionId);
        if (!removed) return false;
        const sessions = await repository.listSummaries();
        const selectedStillExists = sessions.some((session) => session.id === selectedSessionId);
        if (selectedSessionId === sessionId || !selectedStillExists) {
          const nextId = sessions[0]?.id ?? "";
          await repository.writeActiveSessionId(nextId);
          this.emitState(workspaceDir, this.idleState(nextId), true);
        }
        return true;
      });
    } finally {
      this.closingSessions.delete(key);
    }
  }

  async listSessions(workspaceDir: string): Promise<PiSessionSummary[]> {
    return new PiSessionRepository(workspaceDir).listSummaries();
  }

  async loadMessages(workspaceDir: string, sessionId: string): Promise<AgentMessage[]> {
    this.assertAcceptingOperations();
    if (!sessionId) return [];
    const key = sessionKey(workspaceDir, sessionId);
    const coldController = this.active.has(key) ? undefined : this.registerColdStorageController(key);
    try {
      return await this.withSessionTransition(workspaceDir, sessionId, async () => {
        this.assertAcceptingOperations();
        coldController?.signal.throwIfAborted();
        const active = this.active.get(key);
        const repository = new PiSessionRepository(workspaceDir);
        let session: Session | undefined;
        try {
          if (!active && coldController && !coldController.signal.aborted) {
            this.emitStorageProgress(workspaceDir, sessionId, { phase: "scan", processedBytes: 0, totalBytes: 0 });
          }
          session = active?.session ?? await repository.open(sessionId, coldController ? {
            signal: coldController.signal,
            onProgress: (progress) => {
              if (!coldController.signal.aborted) this.emitStorageProgress(workspaceDir, sessionId, progress);
            }
          } : undefined);
          const messages = compactSubagentCards((await readSessionContext(session)).messages
            .filter((message) => message.role !== "system").map(piWebDisplayMessage));
          const interrupted = interruptedSubagentCards(
            messages,
            Date.now(),
            ownedSubagentIds(this.active.get(key))
          );
          for (const message of interrupted) await appendSessionMessage(session, message);
          return interrupted.length > 0
            ? compactSubagentCards([...messages, ...interrupted])
            : messages;
        } finally {
          if (!active && session) await repository.closeSession(sessionId);
        }
      });
    } finally {
      if (coldController) this.releaseColdStorageController(key, coldController);
    }
  }

  async loadSubagentMessages(
    workspaceDir: string,
    parentSessionId: string,
    childSessionId: string
  ): Promise<AgentMessage[]> {
    this.assertAcceptingOperations();
    const key = sessionKey(workspaceDir, parentSessionId);
    const controller = this.registerColdStorageController(key);
    try {
      return await this.withSessionTransition(workspaceDir, parentSessionId, async () => {
        this.assertAcceptingOperations();
        controller.signal.throwIfAborted();
        const repository = new PiSessionRepository(workspaceDir, { signal: controller.signal });
        return repository.withChildSessionReadForParent(childSessionId, parentSessionId, async (child) => (
          (await readSessionContext(child)).messages
            .filter((message) => message.role !== "system")
            .map(piWebDisplayMessage)
        ));
      });
    } finally { this.releaseColdStorageController(key, controller); }
  }

  listRecentEvents(workspaceDir: string, sessionId: string, afterSequence = 0): PiSessionEventEnvelope[] {
    return (this.events.get(sessionKey(workspaceDir, sessionId)) ?? [])
      .filter((entry) => entry.sequence > afterSequence);
  }

  async getRunState(workspaceDir: string, sessionId: string): Promise<PiSessionRunState> {
    const key = sessionKey(workspaceDir, sessionId);
    const current = this.active.get(key);
    if (current) return this.stateFromActive(current);
    if (!sessionId) return this.idleState(sessionId);
    const controller = this.registerColdStorageController(key);
    try { return await this.withSessionTransition(workspaceDir, sessionId, async () => {
      controller.signal.throwIfAborted();
      const owner = this.active.get(key);
      if (owner) return this.stateFromActive(owner);
      const idle = { ...this.idleState(sessionId), sequence: this.coldStorageSequences.get(key) ?? 0 };
      const cached = this.coldWarningReviewStates.get(key);
      const stamp = async (filePath: string) => {
        const info = await stat(filePath);
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      };
      if (cached && existsSync(cached.path) && cached.stamp === await stamp(cached.path)) {
        return { ...idle, warningReview: cached.warningReview ? { ...cached.warningReview } : undefined };
      }
      const repository = new PiSessionRepository(workspaceDir);
      const metadata = await repository.findMetadata(sessionId);
      if (!metadata) { this.coldWarningReviewStates.delete(key); return idle; }
      const beforeStamp = await stamp(metadata.path);
      const session = await repository.open(sessionId, { signal: controller.signal });
      let warningReview: PiSessionRunState["warningReview"];
      try {
        const state = await loadYnSessionHostState(session, sessionId, { projectRoot: workspaceDir,
          throwIfCancelled: () => controller.signal.throwIfAborted() });
        warningReview = state ? warningReviewFromHostState(state) : undefined;
      } finally { await session.close(BACKGROUND_CONTEXT); }
      const afterStamp = await stamp(metadata.path);
      if (beforeStamp === afterStamp) this.coldWarningReviewStates.set(key, { path: metadata.path, stamp: afterStamp,
        warningReview: warningReview ? { ...warningReview } : undefined });
      else this.coldWarningReviewStates.delete(key);
      return { ...idle, warningReview };
    }); } finally { this.releaseColdStorageController(key, controller); }
  }

  private hostSnapshot(active: ActiveSession): YnSessionHostState {
    return { schemaVersion: 1, ownerSessionId: active.sessionId,
      ...active.hostState, domainRun: active.hostState.domainRun?.snapshot() };
  }

  private async withWarningReviewHost<T>(request: Pick<PiSessionWarningReviewDecisionRequest, "outputDir" | "sessionId">,
    action: (state: YnSessionHostState, session: Session, active?: ActiveSession) => Promise<T>): Promise<T> {
    const active = this.active.get(sessionKey(request.outputDir, request.sessionId));
    if (active) return action(this.hostSnapshot(active), active.session, active);
    const signal = this.sessionOperationReservations.get(sessionKey(request.outputDir, request.sessionId))?.preparationController?.signal;
    const session = await new PiSessionRepository(request.outputDir).open(request.sessionId, { signal });
    try {
      const state = await loadYnSessionHostState(session, request.sessionId, { projectRoot: request.outputDir,
        throwIfCancelled: () => signal?.throwIfAborted() });
      if (!state) throw new Error("No pending translation warning review exists in this Pi session.");
      return await action(state, session);
    } finally { await session.close(BACKGROUND_CONTEXT); }
  }

  async decideTranslationWarningReview(request: PiSessionWarningReviewDecisionRequest): Promise<PiSessionWarningReviewDecisionResult> {
    this.assertAcceptingOperations();
    if (!request.outputDir?.trim() || !request.sessionId?.trim() || !request.reviewId?.trim()) {
      throw new Error("outputDir, sessionId and reviewId are required for a translation warning-review decision.");
    }
    if (request.decision !== "review" && request.decision !== "skip") throw new Error("decision must be review or skip.");
    const key = sessionKey(request.outputDir, request.sessionId);
    const reservation: SessionOperationReservation | undefined = request.decision === "review"
      ? { cancelled: false, preparationController: new AbortController() } : undefined;
    if (reservation) {
      if (this.sessionOperationReservations.has(key)) throw new Error("Pi session is already running.");
      // Reserve before the first cold read so Stop also cancels binding replay.
      this.sessionOperationReservations.set(key, reservation);
    }
    try {
      const prompt = await this.withWorkspaceSessionTransition(request.outputDir, request.sessionId, async () => {
        if (reservation?.cancelled) throw new DOMException("Pi warning-review choice was stopped.", "AbortError");
        if ((this.sessionOperationReservations.has(key) && this.sessionOperationReservations.get(key) !== reservation)
          || this.closingSessions.has(key)) throw new Error("Pi session is already running or closing.");
        return this.withWarningReviewHost(request, async (state, session, active) => {
          if (active && (active.running || active.compacting || active.subagents.hasRunning())) throw new Error("Pi session is already running.");
          const gate = warningReviewFromHostState(state);
          if (!gate || gate.id !== request.reviewId) throw new Error("The pending translation warning review is stale or belongs to a different Pi session.");
          if (request.decision === "review") {
            const bindings = state.translationWorkflowRequest ?? request.request;
            if (!bindings?.sourcePath && !bindings?.sourceSelection) throw new Error("The pending translation warning review requires explicit original workflow source bindings.");
            if (!state.translationWorkflowRequest) {
              const manifest = await resolvePiSourceManifest({ ...bindings, outputDir: request.outputDir, sessionId: request.sessionId, prompt: "Host warning-review binding check" });
              const expected = pendingTranslationWarningSnapshot(state)!.documents.map(document => document.id).sort();
              const actual = manifest.documents.map(document => document.id).sort();
              if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("The supplied source bindings do not match the pending full translation workflow documents.");
            }
            return { ...bindings,
              ...(request.request ? { providerId: request.request.providerId, modelId: request.request.modelId, thinkingLevel: request.request.thinkingLevel } : {}),
              outputDir: request.outputDir, sessionId: request.sessionId, workflowIntent: "translation" as const,
              prompt: "Workflow: yn-translation-v1.\nThe Host recorded the user's choice to review the remaining translation warnings. Continue the existing full translation workflow: call inspectTranslationWarnings, judge its warnings, repair true positives, and complete whole-artifact validation." };
          }
          const snapshot = pendingTranslationWarningSnapshot(state)!;
          const run = active?.hostState.domainRun?.translationWarningReviewDecision === "pending"
            ? active.hostState.domainRun : createYnDomainRunContract({ fullWorkflow: true, workflowIntent: "translation", restoreSnapshot: snapshot });
          const wasSuspended = run.suspended;
          run.resume();
          const undo = run.recordTranslationWarningReviewDecision("skip");
          const priorParked = active?.hostState.parkedDomainRuns.translation;
          const priorSuspended = active?.hostState.workflowSuspended;
          try {
            if (active) {
              if (run === active.hostState.domainRun) active.hostState.workflowSuspended = false;
              else active.hostState.parkedDomainRuns.translation = run.snapshot();
              await active.persistHostState();
            } else {
              if (snapshot === state.domainRun) { state.domainRun = run.snapshot(); state.workflowSuspended = false; }
              else state.parkedDomainRuns!.translation = run.snapshot();
              await (this.options.appendHostState ?? appendYnSessionHostState)(session, state, { projectRoot: request.outputDir });
            }
          } catch (error) {
            undo();
            if (wasSuspended) run.suspend();
            if (active) { active.hostState.workflowSuspended = priorSuspended!; active.hostState.parkedDomainRuns.translation = priorParked; }
            throw new NonRetryableAssignmentError("Failed to persist the translation warning-review skip decision.", error);
          }
          if (active) this.emitActiveState(active);
          else this.emitState(request.outputDir, this.idleState(request.sessionId), false);
          return undefined;
        });
      });
      if (!prompt) return { decision: "skip", continuing: false };
      await this.acceptPrompt(prompt, undefined, () => reservation?.cancelled === true, request.reviewId, reservation);
      return { decision: "review", continuing: true };
    } finally {
      if (reservation && this.sessionOperationReservations.get(key) === reservation) this.sessionOperationReservations.delete(key);
    }
  }

  async prompt(request: PiSessionPromptRequest): Promise<PiSessionPromptAcceptance> {
    return this.acceptPrompt(request);
  }
  /** Host-only PDF preparation: await the actual native turn and durable receipt, never prompt acceptance. */
  async runPdfStructurePreparation(request: PdfStructurePreparationRequest): Promise<PdfStructurePreparationResult> {
    this.assertAcceptingOperations();
    request.signal?.throwIfAborted();
    if (!request.systemPrompt.trim() || !request.prompt.trim()) throw new Error("PDF structure preparation requires its system prompt and source prompt.");
    if (this.hasActiveWork(request.outputDir)) throw new Error("Finish or stop the current project Agent work before preparing PDF structure.");
    const sessionId = request.sessionId ?? `pi_${randomUUID()}`;
    const key = sessionKey(request.outputDir, sessionId);
    const controller = new AbortController();
    let settle!: () => void, failSettlement!: (error: unknown) => void;
    const settlement = new Promise<void>((resolve, reject) => { settle = resolve; failSettlement = reject; });
    void settlement.catch(() => undefined);
    let active: ActiveSession | undefined;
    const operation: PdfStructurePreparationOperation = {
      controller, settlement,
      cancel: () => {
        controller.abort(new DOMException("PDF structure preparation was stopped.", "AbortError"));
        active?.runtime.requestAbort();
      }
    };
    const reservation: SessionOperationReservation = { cancelled: false, preparationController: controller, pdfStructurePreparation: operation };
    const onAbort = () => { reservation.cancelled = true; operation.cancel(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    this.sessionOperationReservations.set(key, reservation);
    let ownsStructureContext = false;
    let session: Session | undefined;
    let runtime: PiSessionAgentRuntime | undefined;
    let failure: unknown;
    let result: PdfStructurePreparationResult | undefined;
    try {
      active = await this.withWorkspaceSessionTransition(request.outputDir, sessionId, async () => {
        this.assertAcceptingOperations();
        controller.signal.throwIfAborted();
        if ([...this.sessionOperationReservations.keys()].some(entry => entry !== key && entry.startsWith(`${workspaceKey(request.outputDir)}::`))
          || [...this.active.entries()].some(([entry, owner]) => entry !== key && entry.startsWith(`${workspaceKey(request.outputDir)}::`)
            && (owner.running || owner.compacting || owner.subagents.hasRunning() || owner.reviewBindingRecovery?.pending))) {
          throw new Error("The project Agent became busy before PDF structure preparation.");
        }
        const previous = this.active.get(key);
        if (previous && !previous.pdfStructurePreparation) throw new Error("PDF structure preparation cannot replace an existing Agent session.");
        if(previous?.error)throw new Error('The previous PDF preparation owner still has a storage/cleanup failure. Finish Stop/close before preparing again.');
        if (this.closingSessions.has(key)) throw new Error("The PDF preparation session is closing.");
        const repository = new PiSessionRepository(request.outputDir);
        session = previous?.session ?? (request.sessionId ? await repository.open(sessionId, {
          signal: controller.signal,
          onProgress: progress => this.emitStorageProgress(request.outputDir, sessionId, progress)
        }) : await repository.create(sessionId));
        if (!request.sessionId) await repository.writeActiveSessionId(sessionId);
        const state = await loadYnSessionHostState(session, sessionId, { projectRoot: request.outputDir });
        if (state?.domainRun || state?.taskPreparation || Object.keys(state?.parkedDomainRuns ?? {}).length) {
          throw new Error("PDF structure preparation cannot enter a session with an existing workflow.");
        }
        const context = await readSessionContext(session);
        if (!previous && context.messages.length && !await pdfStructureContextNeedsReset(session)) {
          throw new Error("PDF structure preparation requires a fresh session or its own completed native preparation session.");
        }
        ownsStructureContext = true;
        await appendSessionCustomEntry(session, PDF_STRUCTURE_PREPARATION_ENTRY, {
          phase: "preparing", sessionId, timestamp: Date.now(),
          providerId: request.providerId, modelId: request.modelId
        });
        controller.signal.throwIfAborted();
        const selection = await (this.options.createModelSelection ?? createPiModelSelection)({
          workspaceDir: request.outputDir, providerId: request.providerId, modelId: request.modelId
        });
        controller.signal.throwIfAborted();
        runtime = new PiSessionAgentRuntime({
          session, sessionId, models: selection.models, model: selection.model,
          thinkingLevel: normalizeThinkingLevel(selection.model, request.thinkingLevel),
          systemPrompt: request.systemPrompt, tools: request.tools ?? [],
          refreshExpiredProviderAuth: async model => (await (this.options.createModelSelection ?? createPiModelSelection)({
            workspaceDir: request.outputDir, providerId: model.provider, modelId: model.id
          })).model
        });
        runtime.resetContext();
        const owner: ActiveSession = {
          pdfStructurePreparation: operation,
          workspaceDir: path.resolve(request.outputDir), sessionId, session, runtime,
          unsubscribe: () => {}, sequence: Math.max(previous?.sequence ?? 0, this.coldStorageSequences.get(key) ?? 0),
          phase: "turn", running: true, compacting: false, streamingMessage: null,
          queuedSteer: [], queuedFollowUp: [], queuedNextTurn: [], queuedUserOrder: [],
          liveSubagentMessages: new Map(), childCompletionGeneration: 0,
          hostState: { parkedDomainRuns: {}, workflowSuspended: false,
            proofread: createProofreadHostState(), translationAlignment: createTranslationAlignmentHostState() },
          hostPersistence: { tail: Promise.resolve() },
          persistHostState: async () => {
            await runtime!.appendCustomEntry(PDF_STRUCTURE_PREPARATION_ENTRY, {
              phase: "checkpoint", sessionId, timestamp: Date.now(), cancelled: controller.signal.aborted,contextReset:true
            });
          },
          subagents: new YnSubagentSupervisor({
            publishCustomMessage: message => this.publishExternalMessage(request.outputDir, sessionId, message)
          })
        };
        active = owner;
        this.commitPreparedRuntime(key, { active: owner, previous, retirePreviousSubagents: false,
          preparationTimings: { storageOpenMs: 0, hostRestoreMs: 0, modelSelectionMs: 0, runtimeSetupMs: 0 } });
        result = { sessionId, providerId: selection.providerId, modelId: selection.modelId, text: "" };
        await runtime.appendCustomEntry(PDF_STRUCTURE_PREPARATION_ENTRY, {
          phase: "started", sessionId, providerId: selection.providerId, modelId: selection.modelId,
          thinkingLevel: runtime.getThinkingLevel(), timestamp: Date.now()
        });
        this.emitActiveState(owner);
        return owner;
      });
      controller.signal.throwIfAborted();
      const task = active.runtime.prompt(request.prompt);
      active.promptTask = task;
      await task;
      controller.signal.throwIfAborted();
      const messages = active.runtime.getMessages();
      if (request.responseMode === "structured-tool") {
        let submitted = false;
        for (const message of messages) {
          if (message.role !== "toolResult" || message.toolName !== "submitPdfStructureAudit") continue;
          if (message.isError && submitted) {
            const detail = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
            throw new NonRetryableAssignmentError(`PDF audit submission failed after its payload was sealed: ${detail}`);
          }
          if (!message.isError) submitted = true;
        }
      }
      const assistant = [...messages].reverse().find(message => message.role === "assistant");
      if (!assistant || assistant.role !== "assistant") throw new Error("PDF structure preparation returned no assistant response.");
      if (assistant.stopReason !== "stop" || active.error) {
        throw new Error(assistant.errorMessage || active.error || "PDF structure preparation did not complete its native model turn.");
      }
      const text = assistant.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (!text.trim() && request.responseMode !== "structured-tool") throw new Error("PDF structure preparation returned an empty structure response.");
      result!.text = text;
    } catch (error) {
      failure = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (runtime) {
        try {
          if (failure || controller.signal.aborted) await runtime.abort();
          else await runtime.waitForIdle();
        } catch (error) { cleanupErrors.push(error); }
        try {
          runtime.reconfigure({ systemPrompt: GENERIC_SYSTEM_PROMPT, tools: [] });
          runtime.resetContext();
          await runtime.appendCustomEntry(PDF_STRUCTURE_PREPARATION_ENTRY, {
            phase: failure || controller.signal.aborted ? controller.signal.aborted ? "cancelled" : "failed" : "completed",
            sessionId, providerId: result?.providerId, modelId: result?.modelId,
            timestamp: Date.now(), contextReset: true,
            ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {})
          });
        } catch (error) { cleanupErrors.push(error); }
      } else if (session && ownsStructureContext) {
        try {
          await appendSessionCustomEntry(session, PDF_STRUCTURE_PREPARATION_ENTRY, {
            phase: controller.signal.aborted ? "cancelled" : "failed", sessionId, timestamp: Date.now(), contextReset: true,
            ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {})
          });
        } catch (error) { cleanupErrors.push(error); }
      }
      try {
        await this.withWorkspaceSessionTransition(request.outputDir, sessionId, async () => {
          const current = this.active.get(key);
          if (active && current === active) {
            active.running = false; active.phase = "idle"; active.streamingMessage = null; active.promptTask = undefined;
            if (failure || controller.signal.aborted) active.error = failure instanceof Error ? failure.message : "PDF structure preparation cancelled.";
            await this.flushSessionStorage(active, "pdf-structure-preparation");
            this.emitActiveState(active);
          } else if (session) {
            await getDiskSessionAccess(session)?.storage.flushDerivedIndex();
          }
          // Successful preparation and clean cancellation release native handles. Audit JSONL remains;
          // the next regular prompt opens its own normal tools and observes the reset receipt.
          if (session) await session.close(BACKGROUND_CONTEXT);
          if (runtime) runtime.dispose();
          if (active && current === active) { active.unsubscribe(); this.active.delete(key); }
        });
      } catch (error) {
        cleanupErrors.push(error);
        if (active && this.active.get(key) === active) {
          active.error = error instanceof Error ? error.message : String(error);
          this.emitActiveState(active);
        }
        if (runtime && session && getDiskSessionAccess(session)) {
          try {
            await runtime.appendCustomEntry(PDF_STRUCTURE_PREPARATION_ENTRY, {
              phase: "failed", sessionId, timestamp: Date.now(), contextReset: true,
              error: error instanceof Error ? error.message : String(error), stage: "native-cleanup"
            });
          } catch (diagnosticError) { cleanupErrors.push(diagnosticError); }
        }
      }
      request.signal?.removeEventListener("abort", onAbort);
      if (this.sessionOperationReservations.get(key) === reservation) this.sessionOperationReservations.delete(key);
      if (cleanupErrors.length) {
        const errors = [...(failure ? [failure] : []), ...cleanupErrors];
        const error = new AggregateError(errors, `PDF structure preparation and native cleanup failed: ${errors.map(item => item instanceof Error ? item.message : String(item)).join("; ")}`);
        failure = error;
        failSettlement(error);
      } else settle();
    }
    if (failure) throw failure;
    controller.signal.throwIfAborted();
    request.signal?.throwIfAborted();
    if (!result) throw new Error("PDF structure preparation completed without its native result.");
    return result;
  }
  hasActiveWork(workspaceDir: string): boolean {
    const prefix = `${workspaceKey(workspaceDir)}::`;
    return [...this.sessionOperationReservations.keys()].some(key => key.startsWith(prefix))
      || [...this.active.entries()].some(([key, active]) => key.startsWith(prefix)
        && (active.running || active.compacting || active.subagents.hasRunning() || active.reviewBindingRecovery?.pending || active.pdfStructurePreparation&&active.error));
  }

  private async acceptPrompt(request: PiSessionPromptRequest, preparationHandoff?: YnTaskPreparationState, handoffCancelled?: () => boolean, warningReviewId?: string, warningReviewReservation?: SessionOperationReservation): Promise<PiSessionPromptAcceptance> {
    this.assertAcceptingOperations();
    if([...this.active.values()].some(owner=>workspaceKey(owner.workspaceDir)===workspaceKey(request.outputDir)&&owner.pdfStructurePreparation&&owner.error))throw new Error('PDF preparation storage/cleanup must finish before starting another model request.');
    if ([...this.sessionOperationReservations.entries()].some(([key, reservation]) => key.startsWith(`${workspaceKey(request.outputDir)}::`) && reservation.pdfStructurePreparation)) {
      throw new Error("PDF structure preparation is still running; await its gate before starting project Agent work.");
    }
    const preparationStarted = performance.now();
    // A Host choice owns the saved full-workflow scope even when another HTML
    // document is currently selected in the project.
    if (!warningReviewId) request = await resolveCurrentProjectPromptRequest(request);
    assertWorkflowPromptMetadata(request);
    if (request.workflowIntent) await ensureYnWorkflowWorkspace(request.outputDir);
    if (handoffCancelled?.()) throw new DOMException("Task preparation handoff was stopped.", "AbortError");
    const key = sessionKey(request.outputDir, request.sessionId);
    if (this.closingSessions.has(key)) throw new Error(`Pi session ${request.sessionId} is closing.`);
    await this.sessionOperationReservations.get(key)?.stopSettlement;
    await this.active.get(key)?.reviewBindingRecovery?.task;
    if ([...this.sessionOperationReservations.entries()].some(([entry, reservation]) => entry.startsWith(`${workspaceKey(request.outputDir)}::`) && reservation.pdfStructurePreparation)) {
      throw new Error("PDF structure preparation is still running; await its gate before starting project Agent work.");
    }
    if (this.sessionOperationReservations.has(key) && this.sessionOperationReservations.get(key) !== warningReviewReservation) {
      throw new Error("Pi session is already running. Use Steer or Follow-up.");
    }
    const reservation: SessionOperationReservation = warningReviewReservation ?? { cancelled: false, preparationController: new AbortController() };
    this.sessionOperationReservations.set(key, reservation);
    let preparationFailureActive: ActiveSession | undefined;
    try {
      await this.active.get(key)?.subagents.waitForTerminalSettlements();
      return await this.withWorkspaceSessionTransition(request.outputDir, request.sessionId, async () => {
        if (reservation.cancelled || handoffCancelled?.()) {
          throw new DOMException("Pi prompt was cancelled before the native runtime started.", "AbortError");
        }
        if (this.closingSessions.has(key)) throw new Error(`Pi session ${request.sessionId} is closing.`);
        if (this.active.get(key)?.running || this.active.get(key)?.compacting) {
          throw new Error("Pi session is already running. Use Steer or Follow-up.");
        }
        if (warningReviewId) {
          await this.withWarningReviewHost(request, async (state) => {
            if (warningReviewFromHostState(state)?.id !== warningReviewId) throw new Error("The pending translation warning review is stale.");
          });
        }
        const prepared = await this.prepareRuntime(request, "prompt", preparationHandoff);
        if (reservation.cancelled || handoffCancelled?.()) {
          await this.releaseCancelledPreparation(prepared,
            new DOMException("Pi prompt was cancelled before the native runtime started.", "AbortError"));
        }
        const active = this.commitPreparedRuntime(key, prepared);
        const operation: PromptOperation = {
          generation: ++this.nextPromptGeneration,
          cancelled: false,
          abortController: new AbortController()
        };
        active.promptOperation = operation;
        active.running = true;
        active.phase = "turn";
        active.error = undefined;
        try {
          const persistenceStarted = performance.now();
          const appendPreparationDiagnostics = (hostPersistenceMs?: number) => active.runtime.appendCustomEntry("yn_prompt_preparation", {
            timestamp: Date.now(),
            hostStateSource: prepared.previous ? "owned" : "replayed",
            elapsedMs: performance.now() - preparationStarted,
            stages: { ...prepared.preparationTimings, ...(hostPersistenceMs === undefined ? {} : { hostPersistenceMs }) },
            ...(!prepared.previous ? { hostReplay: getYnHostStateLoadDiagnostics(active.session) } : {})
          });
          // A native append failure latches the owner against later writes.
          // Complete that fallible append while pending is still authoritative.
          if (warningReviewId) await appendPreparationDiagnostics();
          this.assertPromptOperation(active, operation);
          // commitPreparedRuntime intentionally transfers preparation ownership.
          // Its old-owner handoff predicate is valid only before that commit;
          // the new operation and its reservation own cancellation from here.
          if (reservation.cancelled) throw new DOMException("Pi prompt was cancelled before native input.", "AbortError");
          if (warningReviewId) {
            if (active.domainRun?.kind !== "translation" || !active.domainRun.fullWorkflow
              || active.domainRun.translationWarningReviewDecision !== "pending") throw new Error("The pending translation warning review could not restore its full workflow.");
            operation.undoUnstartedWarningReview = active.domainRun.recordTranslationWarningReviewDecision("review");
          }
          await active.persistHostState();
          if (!warningReviewId) await appendPreparationDiagnostics(performance.now() - persistenceStarted);
          this.assertPromptOperation(active, operation);
          if (reservation.cancelled) throw new DOMException("Pi prompt was cancelled before native input.", "AbortError");
          this.emitActiveState(active);
          this.assertPromptOperation(active, operation);
          this.launchNativeInput(active, request.prompt, operation, request.images);
        } catch (error) {
          preparationFailureActive = active;
          operation.cancelled = true;
          operation.abortController.abort();
          active.runtime.requestAbort();
          active.subagents.abortAll();
          this.suspendDomainRun(active);
          active.running = false;
          active.phase = "idle";
          let failure = error;
          try { await this.restoreUnstartedWarningReview(active, operation); }
          catch (rollbackError) {
            failure = new NonRetryableAssignmentError(
              `Pi prompt preparation failed: ${String(error)}; restoring the unstarted warning-review choice also failed: ${String(rollbackError)}`,
              new AggregateError([error, rollbackError])
            );
          }
          active.error = failure instanceof Error ? failure.message : String(failure);
          this.emitActiveState(active);
          throw failure;
        }

        return { accepted: true, sessionId: active.sessionId };
      });
    } catch (error) {
      if (preparationFailureActive) {
        // Child settlement can publish through the session transition. Stop
        // signals above are immediate; await the real terminal state only
        // after releasing that transition, preserving the original failure.
        try {
          await this.abort(request.outputDir, request.sessionId);
        } catch (stopError) {
          throw new AggregateError([error, stopError], `Pi prompt preparation failed: ${error instanceof Error ? error.message : String(error)}; stopping the workflow also failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
        }
      }
      throw error;
    } finally {
      if (this.sessionOperationReservations.get(key) === reservation) this.sessionOperationReservations.delete(key);
    }
  }

  async compact(request: PiSessionCompactRequest): Promise<PiSessionCompactionResult> {
    this.assertAcceptingOperations();
    const key = sessionKey(request.outputDir, request.sessionId);
    if (this.sessionOperationReservations.has(key)) {
      throw new Error("Pi session is busy.");
    }
    const reservation: SessionOperationReservation = { cancelled: false };
    this.sessionOperationReservations.set(key, reservation);
    let task: Promise<PiSessionCompactionResult> | undefined;
    try {
      await this.withWorkspaceSessionTransition(request.outputDir, request.sessionId, async () => {
        if (reservation.cancelled) {
          throw new DOMException("Pi compaction was cancelled before the native runtime started.", "AbortError");
        }
        const current = this.active.get(key);
        if (current?.running || current?.compacting) throw new Error("Pi session is busy.");
        if (current?.subagents.hasRunning()) {
          throw new Error("Cannot compact while background subagents are running. Stop them or wait for completion.");
        }
        if (current && orderedQueuedMessages(current).length > 0) {
          throw new Error("Resolve queued Pi inputs before compacting this session.");
        }
        const prepared = await this.prepareRuntime({
          outputDir: request.outputDir,
          sessionId: request.sessionId,
          prompt: "",
          providerId: request.providerId,
          modelId: request.modelId,
          thinkingLevel: request.thinkingLevel
        }, "compaction");
        if (reservation.cancelled) {
          await this.releaseCancelledPreparation(prepared,
            new DOMException("Pi compaction was cancelled before the native runtime started.", "AbortError"));
        }
        const active = this.commitPreparedRuntime(key, prepared);
        active.compacting = true;
        active.phase = "compaction";
        active.compactionError = undefined;
        this.emitActiveState(active);
        task = this.runNativeCompaction(active, "manual", request.customInstructions);
        active.compactionTask = task;
      });
    } finally {
      if (this.sessionOperationReservations.get(key) === reservation) {
        this.sessionOperationReservations.delete(key);
      }
    }
    if (!task) throw new Error("Pi compaction did not start.");
    return task;
  }

  async sendInput(
    workspaceDir: string,
    sessionId: string,
    kind: PiSessionInputKind,
    text: string,
    images?: ImageContent[]
  ): Promise<void> {
    this.assertAcceptingOperations();
    await this.withSessionTransition(workspaceDir, sessionId, async () => {
      this.assertAcceptingOperations();
      const active = this.requireRunning(workspaceDir, sessionId);
      const entry: QueuedInputOrderEntry = {
        sequence: ++this.nextQueuedInputSequence,
        kind,
        text,
        signature: queuedUserSignature({ text, images }),
        pendingNative: true
      };
      active.queuedUserOrder.push(entry);
      try {
        if (!active.runtime.getModel().input.includes("image") && images?.length) {
          throw new Error(`Model ${active.runtime.getModel().name} does not accept image input.`);
        }
        if (kind === "steer") await active.runtime.steer(text, { images });
        else await active.runtime.followUp(text, { images });
        await active.persistHostState();
        entry.pendingNative = false;
        this.reconcileQueuedUserOrder(active);
      } catch (error) {
        active.queuedUserOrder = active.queuedUserOrder.filter((item) => item.sequence !== entry.sequence);
        throw error;
      }
    });
  }

  async abort(workspaceDir: string, sessionId: string): Promise<void> {
    const stopStartedAt = Date.now();
    const key = sessionKey(workspaceDir, sessionId);
    const reservation = this.sessionOperationReservations.get(key);
    if (reservation?.pdfStructurePreparation) {
      reservation.cancelled = true;
      reservation.pdfStructurePreparation.cancel();
      return reservation.pdfStructurePreparation.settlement;
    }
    const coldControllers = this.coldStorageControllers.get(key);
    const activeBeforeStop = this.active.get(key);
    if (!activeBeforeStop) {
      for (const controller of coldControllers ?? []) {
        controller.abort(new DOMException("Pi session storage preparation was stopped.", "AbortError"));
      }
    }
    if (reservation?.stopSettlement) return reservation.stopSettlement;
    const hasActiveWork = Boolean(
      reservation
      || (!activeBeforeStop && coldControllers?.size)
      || activeBeforeStop?.running
      || activeBeforeStop?.compacting
      || activeBeforeStop?.promptOperation
      || activeBeforeStop?.subagents.hasRunning()
      || activeBeforeStop?.reviewBindingRecovery?.pending
      || activeBeforeStop?.compactionTask
    );
    if (!hasActiveWork && !activeBeforeStop) return;
    if (reservation) { reservation.cancelled = true; reservation.preparationController?.abort(new DOMException("PDF session preparation was stopped.", "AbortError")); }
    let settleStop!: () => void;
    let failStop!: (error: unknown) => void;
    const stopReservation: SessionOperationReservation = {
      cancelled: true, stopSettlement: new Promise<void>((resolve, reject) => { settleStop = resolve; failStop = reject; })
    };
    // The initiating abort call reports failure; concurrent waiters receive the
    // same failure without creating an unhandled detached promise.
    void stopReservation.stopSettlement!.catch(() => undefined);
    this.sessionOperationReservations.set(key, stopReservation);
    let active = this.active.get(key);
    const signalStop = (current: ActiveSession) => {
      current.reviewBindingRecovery?.controller.abort(new DOMException("Host recovery was stopped.", "AbortError"));
      current.childCompletionGeneration += 1;
      if (current.promptOperation) {
        current.promptOperation.cancelled = true;
        current.promptOperation.abortController.abort(new DOMException("Pi operation was stopped.", "AbortError"));
      }
      current.runtime.requestAbort();
      current.subagents.abortAll();
    };
    // Cancellation cannot wait for a Host disk write or session transition.
    if (active && hasActiveWork) signalStop(active);
    try {
      await this.withSessionTransition(workspaceDir, sessionId, async () => {
        const current = this.active.get(key);
        if (current && current !== active && hasActiveWork) signalStop(current);
        active = current;
        if (active && hasActiveWork) this.suspendDomainRun(active);
      });
      if (!active) return;
      if (!hasActiveWork) {
        await this.flushSessionStorage(active, "idle-stop");
        return;
      }
      const hadActiveWork = active.running || active.compacting || active.subagents.hasRunning();
      // An exiting Host tool may publish through the session transition. Holding
      // that transition while waiting for native idle deadlocks both operations.
      const outcomes = await Promise.allSettled([
        active.running || active.promptOperation ? this.abortActiveSession(active) : Promise.resolve(),
        active.subagents.waitForAll(),
        ...(active.reviewBindingRecovery ? [active.reviewBindingRecovery.task] : []),
        ...(active.compactionTask ? [active.compactionTask] : []),
        active.runtime.appendCustomEntry("yn_workflow_stop", { phase: "requested", timestamp: stopStartedAt })
      ]);
      const errors = outcomes.flatMap((outcome) => outcome.status === "rejected"
        && !(outcome.reason instanceof Error && outcome.reason.name === "AbortError") ? [outcome.reason] : []);
      // A cancelled recovery may have been awaiting resume persistence when
      // Stop first suspended it. Reassert the terminal fence after it settles.
      await this.withSessionTransition(workspaceDir, sessionId, async () => {
        if (this.active.get(key) === active) this.suspendDomainRun(active!);
      });
      try {
        await active.persistHostState({ force: true });
      } catch (error) {
        errors.push(error);
      }
      try {
        await active.runtime.appendCustomEntry("yn_workflow_stop", {
          phase: "settled", timestamp: Date.now(), durationMs: Date.now() - stopStartedAt,
          running: active.running, childrenRunning: active.subagents.hasRunning(),
          errors: errors.map((error) => error instanceof Error ? error.message : String(error))
        });
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.flushSessionStorage(active, "stop");
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        const error = new AggregateError(errors, `Pi Stop failed to finish cleanly: ${errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")}`);
        active.error = error.message;
        this.emitActiveState(active);
        throw error;
      }
      if (hadActiveWork) this.emitActiveState(active);
    } catch (error) {
      failStop(error);
      throw error;
    } finally {
      if (this.sessionOperationReservations.get(key) === stopReservation) this.sessionOperationReservations.delete(key);
      settleStop();
    }
  }

  private async flushSessionStorage(active: ActiveSession, reason: string): Promise<void> {
    const disk = getDiskSessionAccess(active.session);
    if (!disk) return;
    const started = Date.now();
    // An idle Stop must not append a synthetic transaction just to flush an
    // already clean index. This also keeps repeated close/Stop requests cheap.
    console.info("Pi session restore index flush requested", { sessionId: active.sessionId, reason });
    try {
      await disk.storage.flushDerivedIndex();
      console.info("Pi session restore index flushed", { sessionId: active.sessionId, reason, elapsedMs: Date.now() - started });
    } catch (error) {
      active.error = error instanceof Error ? error.message : String(error);
      this.emitActiveState(active);
      try {
        await active.runtime.appendCustomEntry("yn_session_storage_flush", { phase: "failed", reason,
          timestamp: Date.now(), elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      } catch (diagnosticError) {
        throw new AggregateError([error, diagnosticError], "Pi restore index flush and failure diagnostic both failed.");
      }
      throw error;
    }
  }

  /** Block new model work before signalling every desktop session to Stop. */
  disposeAll(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shuttingDown = true;
    const workspaces = new Map<string, string>();
    for (const key of [...this.sessionOperationReservations.keys(), ...this.coldStorageControllers.keys()]) {
      const root = key.slice(0, key.lastIndexOf("::"));
      workspaces.set(workspaceKey(root), root);
    }
    for (const resource of this.transitionTails.keys()) {
      if (resource.startsWith("workspace:")) {
        const root = resource.slice("workspace:".length);
        workspaces.set(workspaceKey(root), root);
      }
    }
    for (const active of this.active.values()) workspaces.set(workspaceKey(active.workspaceDir), active.workspaceDir);
    this.shutdownTask = (async () => {
      const outcomes = await Promise.allSettled([...workspaces.values()].map(root => this.disposeWorkspace(root)));
      const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Desktop Pi session disposal failed.");
    })();
    return this.shutdownTask;
  }

  /** Only the desktop failure handler calls this after all quit settlements finished. */
  resumeAfterCancelledShutdown(): void {
    this.shuttingDown = false;
    this.shutdownTask = undefined;
  }

  private async abortActiveSession(active: ActiveSession): Promise<void> {
    const promptOperation = active.promptOperation;
    if (promptOperation) {
      promptOperation.cancelled = true;
      promptOperation.abortController.abort(new DOMException("Pi operation was stopped.", "AbortError"));
      await this.restoreUnstartedWarningReview(active, promptOperation);
    }
    const acceptedOrder = [...active.queuedUserOrder]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => ({ ...entry }));
    const cleared = await active.runtime.abort();
    const pools: Record<PiSessionInputKind, AgentMessage[]> = {
      steer: [...cleared.clearedSteer],
      followUp: [...cleared.clearedFollowUp]
    };
    const carryover: OrderedQueuedMessage[] = [];
    for (const entry of acceptedOrder) {
      if (entry.kind === "nextTurn") continue;
      const message = takeTrackedMessage(pools[entry.kind], entry);
      if (message) carryover.push({ message, tracked: entry });
    }
    carryover.push(...messagesInSubmissionOrder([...pools.steer, ...pools.followUp]).map((message) => ({ message })));
    for (const item of carryover) {
      const message = item.message;
      const payload = queuedUserPayload(message);
      const entry = item.tracked ?? {
        sequence: ++this.nextQueuedInputSequence,
        kind: "nextTurn" as const,
          text: payload.text,
          signature: queuedUserSignature(payload),
        pendingNative: true
      };
      entry.kind = "nextTurn";
      entry.text = payload.text;
      entry.signature = queuedUserSignature(payload);
      entry.message = undefined;
      entry.pendingNative = true;
      active.queuedUserOrder = active.queuedUserOrder.filter((current) => current.sequence !== entry.sequence);
      active.queuedUserOrder.push(entry);
      try {
        await active.runtime.nextTurn(payload.text, { images: payload.images });
        entry.pendingNative = false;
        this.reconcileQueuedUserOrder(active);
      } catch (error) {
        active.queuedUserOrder = active.queuedUserOrder.filter((current) => current.sequence !== entry.sequence);
        throw error;
      }
    }
    active.running = false;
    active.phase = "idle";
    active.streamingMessage = null;
    if (active.promptOperation === promptOperation) active.promptOperation = undefined;
    this.emitActiveState(active);
  }

  async suspendWorkspace(workspaceDir: string): Promise<void> {
    this.cancelWorkspaceOperationReservations(workspaceDir);
    const sessionIds = this.workspaceSessionIds(workspaceDir);
    await Promise.all(sessionIds.map((sessionId) => this.abort(workspaceDir, sessionId)));
  }

  async disposeWorkspace(workspaceDir: string): Promise<void> {
    this.cancelWorkspaceOperationReservations(workspaceDir);
    const sessionIds = this.workspaceSessionIds(workspaceDir);
    const outcomes = await Promise.allSettled(sessionIds.map((sessionId) => this.abort(workspaceDir, sessionId)));
    const errors: unknown[] = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    const failedStops = new Set(sessionIds.filter((_, index) => outcomes[index].status === "rejected"));
    await this.withTransitions(this.workspaceSessionResources(workspaceDir, sessionIds), async () => {
      const prefix = `${workspaceKey(workspaceDir)}::`;
      const sessions = [...this.active.entries()].filter(([key]) => key.startsWith(prefix));
      for (const [key, active] of sessions) {
        // Keep a usable warm owner when Stop could not save its latest index.
        // Pi close is terminal even on failure; closing now would destroy the
        // only owner that can retry that outstanding persistence safely.
        if (failedStops.has(active.sessionId)) continue;
        if (active.running || active.compacting || active.subagents.hasRunning()) {
          errors.push(new Error(`Cannot release Pi session ${active.sessionId}: native work did not settle after Stop.`));
          continue;
        }
        try { await this.flushSessionStorage(active, "dispose"); }
        catch (error) { errors.push(error); continue; }
        const releaseErrors: unknown[] = [];
        try { active.unsubscribe(); } catch (error) { releaseErrors.push(error); }
        try { active.runtime.dispose(); } catch (error) { releaseErrors.push(error); }
        try { await active.session.close(BACKGROUND_CONTEXT); } catch (error) { releaseErrors.push(error); }
        if(active.pdfStructurePreparation&&releaseErrors.length) {
          active.error=new AggregateError(releaseErrors,'PDF native owner could not be released.').message;
          this.emitActiveState(active);errors.push(...releaseErrors);continue;
        }
        // The latest restore window is already durable. Native Session.close
        // seals the owner even when it reports an error, so it must never be
        // reused by the next prompt or a retry of desktop shutdown.
        this.active.delete(key);
        this.events.delete(key);
        errors.push(...releaseErrors);
      }
      for (const key of this.coldStorageSequences.keys()) {
        if (key.startsWith(prefix)) {
          this.coldStorageSequences.delete(key);
          this.events.delete(key);
        }
      }
      for (const key of this.coldWarningReviewStates.keys()) {
        if (key.startsWith(prefix)) this.coldWarningReviewStates.delete(key);
      }
    });
    if (errors.length) throw new AggregateError(errors, `Pi workspace disposal failed: ${errors.map(error => error instanceof Error ? error.message : String(error)).join("; ")}`);
  }

  private async prepareRuntime(
    request: PiSessionPromptRequest,
    purpose: "prompt" | "compaction" = "prompt",
    preparationHandoff?: YnTaskPreparationState
  ): Promise<PreparedRuntime> {
    this.assertAcceptingOperations();
    const key = sessionKey(request.outputDir, request.sessionId);
    const previous = this.active.get(key);
    if (previous?.running || previous?.compacting) {
      throw new Error("Pi session is already running. Use Steer or Follow-up.");
    }
    const queuedCarryover = previous ? orderedQueuedMessages(previous).map((entry) => entry.message) : [];
    const repository = new PiSessionRepository(request.outputDir);
    const coldController = previous ? undefined : this.registerColdStorageController(key);
    let session: Session | undefined;
    try {
      const storageStarted = performance.now();
      if (coldController && !coldController.signal.aborted) {
        this.emitStorageProgress(request.outputDir, request.sessionId, { phase: "scan", processedBytes: 0, totalBytes: 0 });
      }
      session = previous?.session ?? await repository.open(request.sessionId, coldController ? {
        signal: coldController.signal,
        onProgress: (progress) => {
          if (!coldController.signal.aborted) this.emitStorageProgress(request.outputDir, request.sessionId, progress);
        }
      } : undefined);
      const storageOpenMs = performance.now() - storageStarted;
      const prepared = await this.prepareOwnedRuntime(request, purpose, previous, session, queuedCarryover, preparationHandoff, this.sessionOperationReservations.get(key)?.preparationController?.signal ?? coldController?.signal);
      prepared.preparationTimings.storageOpenMs = storageOpenMs;
      return prepared;
    } catch (error) {
      // A failed provider/tool preparation never transfers this new handle to
      // the active owner. Keep an existing owner's session usable on rejection.
      if (!previous && session) {
        try { await session.close(BACKGROUND_CONTEXT); }
        catch (closeError) { throw new AggregateError([error, closeError], "Pi runtime preparation failed and its session could not close."); }
      }
      throw error;
    } finally {
      if (coldController) this.releaseColdStorageController(key, coldController);
    }
  }

  private async prepareOwnedRuntime(
    request: PiSessionPromptRequest,
    purpose: "prompt" | "compaction",
    previous: ActiveSession | undefined,
    session: Session,
    queuedCarryover: AgentMessage[],
    preparationHandoff?: YnTaskPreparationState,
    preparationSignal?: AbortSignal
  ): Promise<PreparedRuntime> {
    // The current owner already holds the live Host state and its durable Pi
    // cursor. Replaying every historical checkpoint here blocks each message
    // for the lifetime of the project; only a cold owner needs that replay.
    const reservation = this.sessionOperationReservations.get(sessionKey(request.outputDir, request.sessionId));
    const restoreStarted = performance.now();
    const persistedHostState = previous ? undefined : await loadYnSessionHostState(session, request.sessionId, {
      projectRoot: request.outputDir,
      throwIfCancelled: () => {
        if (reservation?.cancelled) throw new DOMException("Pi Host replay was stopped.", "AbortError");
      },
      onReplayProgress: (processedEntries, totalEntries) => {
        if (reservation?.cancelled) return;
        this.emitStorageProgress(request.outputDir, request.sessionId, {
          phase: "replay",
          processedBytes: processedEntries,
          totalBytes: totalEntries
        });
      }
    });
    const hostRestoreMs = performance.now() - restoreStarted;
    const resetPdfPreparationContext = !previous && await pdfStructureContextNeedsReset(session);
    if (!previous) {
      this.emitStorageProgress(request.outputDir, request.sessionId, { phase: "complete", processedBytes: 0, totalBytes: 0 });
    }
    // Reject old/unprotected or drifted PDF projections before a paid provider turn.
    if (purpose === "prompt") {
      await preflightPdfRequest(request, preparationSignal);
      const preparation = preparationHandoff ?? previous?.hostState.taskPreparation ?? persistedHostState?.taskPreparation;
      if (preparation?.pendingRequest && !preparation.completed) await preflightPdfRequest(preparation.pendingRequest, preparationSignal);
    }
    preparationSignal?.throwIfAborted();
    const selectionStarted = performance.now();
    const selection = await (this.options.createModelSelection ?? createPiModelSelection)({
      workspaceDir: request.outputDir,
      providerId: request.providerId,
      modelId: request.modelId
    });
    preparationSignal?.throwIfAborted();
    const modelSelectionMs = performance.now() - selectionStarted;
    const setupStarted = performance.now();
    if (purpose === "prompt" && request.images?.length && !selection.model.input.includes("image")) {
      throw new Error(`Model ${selection.model.name} does not accept image input.`);
    }
    const publishCustomMessage = (message: AgentMessage) => (
      this.publishExternalMessage(request.outputDir, request.sessionId, message)
    );
    const publishLiveCustomMessage = (message: AgentMessage) => (
      this.publishExternalLiveMessage(request.outputDir, request.sessionId, message)
    );
    const runtimeRequest: PiSessionPromptRequest = request;
    const previousHostDomainRun = previous?.domainRun ?? previous?.hostState.domainRun;
    const persistedDomainSnapshot = purpose === "prompt"
      && this.options.enforceDomainCompletion
      ? persistedHostState?.domainRun
      : undefined;
    const markerIntent = /^(?:\uFEFF)?Workflow: yn-(translation|proofread)-v1\.(?:\r?\n|$)/u
      .exec(runtimeRequest.prompt)?.[1] as "translation" | "proofread" | undefined;
    if (
      markerIntent
      && runtimeRequest.workflowIntent
      && markerIntent !== runtimeRequest.workflowIntent
    ) {
      throw new Error(
        `Workflow marker ${markerIntent} conflicts with typed workflow intent ${runtimeRequest.workflowIntent}.`
      );
    }
    const workflowIntent = runtimeRequest.workflowIntent ?? markerIntent;
    // A verified generated marker starts a full workflow. Typed intent without
    // the marker may only continue the same incomplete Host contract; it can
    // never turn a fresh ordinary prompt into a complete workflow.
    const continuingTypedWorkflow = markerIntent === undefined
      && runtimeRequest.workflowIntent !== undefined
      && (
        previousHostDomainRun?.fullWorkflow === true
          && previousHostDomainRun.kind === runtimeRequest.workflowIntent
          && (previousHostDomainRun.suspended || previousHostDomainRun.incompleteReasons().length > 0)
        || previousHostDomainRun === undefined
          && persistedDomainSnapshot?.fullWorkflowActive === true
          && persistedDomainSnapshot.activeKind === runtimeRequest.workflowIntent
      );
    const explicitFullWorkflow = markerIntent !== undefined || continuingTypedWorkflow;
    const workflowRequirements = {
      glossaryCandidate: explicitFullWorkflow
        && workflowIntent === "translation"
        && runtimeRequest.glossaryCandidates === true
        && !runtimeRequest.glossaryPath?.trim(),
      characterBible: explicitFullWorkflow
        && workflowIntent === "translation"
        && runtimeRequest.characterBible === true
    };
    // A new explicit user delegation owns a new local task contract. A repeated
    // generated workflow for the same kind and Pi session resumes its incomplete
    // Host contract; selecting New creates the clean task boundary.
    const restoreDomainRun = (snapshot: YnDomainRunSnapshot): YnDomainRunContract => createYnDomainRunContract({
      workflowIntent: snapshot.activeKind ?? workflowIntent,
      workflowRequirements,
      subagentEnabled: runtimeRequest.subagentEnabled,
      subagentCount: runtimeRequest.subagentCount,
      folderSource: runtimeRequest.sourceSelection?.kind === "folder",
      proofreadMode: runtimeRequest.proofreadMode,
      proofreadMontecarloRoundMin: runtimeRequest.proofreadMontecarloRoundMin,
      proofreadMontecarloRoundMax: runtimeRequest.proofreadMontecarloRoundMax,
      fullWorkflow: snapshot.fullWorkflowActive,
      restoreSnapshot: snapshot
    });
    const persistedDomainRun = persistedDomainSnapshot
      ? restoreDomainRun(persistedDomainSnapshot)
      : undefined;
    const currentDomainRun = previousHostDomainRun ?? persistedDomainRun;
    const continuingBackgroundOperation = purpose === "prompt"
      && !explicitFullWorkflow
      && previous?.subagents.hasRunning() === true
      && currentDomainRun !== undefined;
    const fullWorkflow = explicitFullWorkflow
      || (continuingBackgroundOperation && currentDomainRun?.fullWorkflow === true);
    const parkedDomainRuns: Partial<Record<YnWorkflowKind, YnDomainRunSnapshot>> = {
      ...(persistedHostState?.parkedDomainRuns ?? {}),
      ...(previous?.hostState.parkedDomainRuns ?? {})
    };
    const requestedKind = explicitFullWorkflow
      ? workflowIntent
      : continuingBackgroundOperation && currentDomainRun?.fullWorkflow
        ? currentDomainRun.kind
        : undefined;
    const operationScopeChanged = purpose === "prompt"
      && this.options.enforceDomainCompletion === true
      && (
        (!fullWorkflow && !continuingBackgroundOperation)
        || currentDomainRun?.fullWorkflow !== true
        || currentDomainRun.kind !== requestedKind
      );
    if (operationScopeChanged && currentDomainRun?.incompleteReasons().length) {
      currentDomainRun.suspend();
      if (currentDomainRun.fullWorkflow) {
        delete parkedDomainRuns[currentDomainRun.kind!];
        parkedDomainRuns[currentDomainRun.kind!] = currentDomainRun.snapshot();
      }
    }
    const parkedTargetSnapshot = fullWorkflow && operationScopeChanged && requestedKind
      ? parkedDomainRuns[requestedKind]
      : undefined;
    const restoredParkedTarget = parkedTargetSnapshot
      && parkedTargetSnapshot.fullWorkflowActive === fullWorkflow
      ? restoreDomainRun(parkedTargetSnapshot)
      : undefined;
    if (restoredParkedTarget && requestedKind) delete parkedDomainRuns[requestedKind];
    const resumableCandidate = continuingBackgroundOperation
      ? currentDomainRun
      : fullWorkflow
        ? operationScopeChanged ? restoredParkedTarget : currentDomainRun
        : undefined;
    const finishingPreparation = !request.taskPreparation
      && (previous?.hostState.taskPreparation ?? persistedHostState?.taskPreparation)?.started === true
      && (previous?.hostState.taskPreparation ?? persistedHostState?.taskPreparation)?.completed !== true
      && currentDomainRun?.fullWorkflow === true
      && (markerIntent === undefined || markerIntent === currentDomainRun.kind)
      && (runtimeRequest.workflowIntent === undefined || runtimeRequest.workflowIntent === currentDomainRun.kind)
      && currentDomainRun.incompleteReasons().length === 0;
    const continuedDomainRun = finishingPreparation ? currentDomainRun : continuingBackgroundOperation
      ? resumableCandidate
      : resumableCandidate?.fullWorkflow && resumableCandidate.incompleteReasons().length > 0
        ? resumableCandidate
        : undefined;
    let domainRun = purpose === "prompt" && this.options.enforceDomainCompletion
      ? continuedDomainRun ?? createYnDomainRunContract({
        workflowIntent,
        workflowRequirements,
        subagentEnabled: runtimeRequest.subagentEnabled,
        subagentCount: runtimeRequest.subagentCount,
        folderSource: runtimeRequest.sourceSelection?.kind === "folder",
        proofreadMode: runtimeRequest.proofreadMode,
        proofreadMontecarloRoundMin: runtimeRequest.proofreadMontecarloRoundMin,
        proofreadMontecarloRoundMax: runtimeRequest.proofreadMontecarloRoundMax,
        fullWorkflow
      })
      : undefined;
    const proofreadState = previous?.hostState.proofread
      ?? persistedHostState?.proofread
      ?? createProofreadHostState();
    const translationAlignmentState = previous?.hostState.translationAlignment
      ?? persistedHostState?.translationAlignment
      ?? createTranslationAlignmentHostState();
    const inheritedSuspension = fullWorkflow && !operationScopeChanged && continuedDomainRun === currentDomainRun
      ? previous?.hostState.workflowSuspended ?? persistedHostState?.workflowSuspended
      : false;
    if (
      continuedDomainRun
      && !continuingBackgroundOperation
      && !inheritedSuspension
      && !continuedDomainRun.suspended
    ) {
      continuedDomainRun.configureProjectSubagentCeiling(
        runtimeRequest.subagentEnabled,
        runtimeRequest.subagentCount
      );
    }
    const inheritedPreparation = previous?.hostState.taskPreparation ?? persistedHostState?.taskPreparation;
    const retainedPreparation = workflowIntent && inheritedPreparation?.intent !== workflowIntent
      ? undefined : inheritedPreparation;
    const hostState = {
      translationWorkflowRequest: fullWorkflow && workflowIntent === "translation"
        ? translationWorkflowBindings(runtimeRequest)
        : previous?.hostState.translationWorkflowRequest ?? persistedHostState?.translationWorkflowRequest,
      warningReview: previous?.hostState.warningReview ?? persistedHostState?.warningReview,
      taskPreparation: preparationHandoff ?? (request.taskPreparation
        ? createTaskPreparationState(request.taskPreparation)
        : retainedPreparation),
      domainRun,
      parkedDomainRuns,
      workflowSuspended: Boolean(inheritedSuspension),
      proofread: proofreadState,
      translationAlignment: translationAlignmentState
    };
    if (!previous && hostState.taskPreparation?.pendingRequest && !hostState.taskPreparation.started) {
      // A cold reopen must recheck Host source/trial evidence through the start
      // tool before consuming a prepared request whose files may have changed.
      hostState.taskPreparation.stopped = true;
    }
    const autoResumeStoppedWorkflow = Boolean(
      explicitFullWorkflow
      && hostState.workflowSuspended
      && !operationScopeChanged
      && continuedDomainRun === currentDomainRun
      && domainRun !== undefined
      && domainRun.recoveryPauseId === undefined
    );
    if (hostState.workflowSuspended) domainRun?.suspend();
    const retirePreviousSubagents = Boolean(previous && operationScopeChanged);
    const childCompletionGeneration = (previous?.childCompletionGeneration ?? 0)
      + (retirePreviousSubagents ? 1 : 0);
    const subagents = previous && !retirePreviousSubagents
      ? previous.subagents
      : new YnSubagentSupervisor({
          publishCustomMessage,
          publishLiveCustomMessage,
          notifyParent: (message) => this.deliverParentNotification(
            request.outputDir,
            request.sessionId,
            message,
            childCompletionGeneration
          ),
          createModelSelection: this.options.createModelSelection ?? createPiModelSelection,
          onFatalHostFailure: async (error) => {
            const current = this.active.get(sessionKey(request.outputDir, request.sessionId));
            if (!current) throw error;
            // A failure in a newly started pool supersedes the recovery that
            // launched it; that older task must never clear the new error.
            if (current.reviewBindingRecovery?.pending) {
              current.reviewBindingRecovery.controller.abort(new DOMException("Host recovery was interrupted by a new failure.", "AbortError"));
            }
            const failureGeneration = current.childCompletionGeneration;
            const explicitlyStopping = Boolean(this.sessionOperationReservations.get(sessionKey(request.outputDir, request.sessionId))?.stopSettlement);
            current.error = error.message;
            // Settlement still owns the active batch contract. Fence model work
            // now, but let onSettled record accepted results and remaining debt.
            current.hostState.workflowSuspended = true;
            if (current.domainRun) current.hostState.domainRun = current.domainRun;
            current.runtime.requestAbort();
            try {
              await current.runtime.appendCustomEntry("yn_host_failure", {
                error: error.message, kind: error.name, timestamp: Date.now(),
                automaticRecovery: error instanceof TranslationReviewBindingChangedError
              });
              await current.persistHostState({ force: true });
            } catch (persistenceError) {
              current.error = `${error.message} Host failure persistence also failed: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`;
              throw persistenceError;
            } finally {
              this.emitActiveState(current);
            }
            if (error instanceof TranslationReviewBindingChangedError && !explicitlyStopping
              && current.childCompletionGeneration === failureGeneration) {
              const keys = current.reviewBindingRecovery?.keys ?? new Set<string>();
              if (keys.has(error.recoveryKey)) {
                await current.runtime.appendCustomEntry("yn_review_binding_recovery", {
                  phase: "blocked_repeat", recoveryKey: error.recoveryKey, error: error.message, timestamp: Date.now()
                });
                return;
              }
              keys.add(error.recoveryKey);
              const controller = new AbortController();
              const generation = failureGeneration;
              const task = (async () => {
                // Do not await this task inside onFatalHostFailure: the old
                // batch must finish its onSettled callback before recovery.
                await current.subagents.waitForAll();
                await current.promptTask;
                controller.signal.throwIfAborted();
                if (this.active.get(sessionKey(request.outputDir, request.sessionId)) !== current
                  || generation !== current.childCompletionGeneration) return;
                await current.runtime.appendCustomEntry("yn_review_binding_recovery", {
                  phase: "preflight", recoveryKey: error.recoveryKey, timestamp: Date.now()
                });
                const resume = tools.find(tool => tool.name === "resumeYnWorkflow");
                const start = tools.find(tool => tool.name === "runTranslationSubagents");
                const reconcile = toolContext.recoverReviewBinding;
                if (!resume || !start || !reconcile) throw new Error("Host review recovery requires verified rebinding and the existing translation resume and queue tools.");
                await reconcile(error, controller.signal);
                await resume.execute("host-review-recovery-resume", { workflow: "translation" }, controller.signal);
                controller.signal.throwIfAborted();
                const result = await start.execute("host-review-recovery-start", {}, controller.signal);
                controller.signal.throwIfAborted();
                current.error = undefined;
                await current.runtime.appendCustomEntry("yn_review_binding_recovery", {
                  phase: "restarted", recoveryKey: error.recoveryKey, result: result.details, timestamp: Date.now()
                });
                this.emitActiveState(current);
              })().catch(async recoveryError => {
                if (controller.signal.aborted) return;
                current.error = `${error.message} Host automatic recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
                current.hostState.workflowSuspended = true;
                current.subagents.abortAll(recoveryError);
                current.runtime.requestAbort();
                await current.subagents.waitForAll();
                await current.runtime.appendCustomEntry("yn_review_binding_recovery", {
                  phase: "failed", recoveryKey: error.recoveryKey, error: current.error, timestamp: Date.now()
                });
                await current.persistHostState({ force: true });
                this.emitActiveState(current);
              }).finally(() => {
                if (current.reviewBindingRecovery?.task === task) current.reviewBindingRecovery.pending = false;
              });
              current.reviewBindingRecovery = { controller, task, keys, pending: true };
              void task.catch(recoveryError => {
                current.error = `${current.error ?? error.message} Recovery diagnostics persistence failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
                this.emitActiveState(current);
              });
            }
          }
        });
    const appendHostState = this.options.appendHostState ?? appendYnSessionHostState;
    let runtime: PiSessionAgentRuntime | undefined;
    let activeRuntime: ActiveSession | undefined;
    // Child callbacks can still use the old owner's writer while an ordinary
    // parent turn replaces its runtime. Both writers must share one ordered
    // delta chain on the same native Session.
    const hostPersistence = previous?.hostPersistence ?? {
      tail: Promise.resolve(),
      lastPersisted: persistedHostState ? JSON.stringify(persistedHostState) : undefined
    };
    const persistHostState = (options: { force?: boolean } = {}): Promise<void> => {
      const state = {
        schemaVersion: 1 as const,
        ownerSessionId: request.sessionId,
        ...(hostState.domainRun ? { domainRun: hostState.domainRun.snapshot() } : {}),
        ...(Object.keys(hostState.parkedDomainRuns).length > 0
          ? { parkedDomainRuns: hostState.parkedDomainRuns }
          : {}),
        ...(hostState.workflowSuspended ? { workflowSuspended: true } : {}),
        ...(hostState.taskPreparation ? { taskPreparation: hostState.taskPreparation } : {}),
        ...(hostState.translationWorkflowRequest ? { translationWorkflowRequest: hostState.translationWorkflowRequest } : {}),
        ...(hostState.warningReview ? { warningReview: hostState.warningReview } : {}),
        proofread: hostState.proofread,
        translationAlignment: hostState.translationAlignment
      };
      const serialized = JSON.stringify(state);
      if (!options.force && serialized === hostPersistence.lastPersisted) return hostPersistence.tail;
      const snapshot = JSON.parse(serialized) as YnSessionHostState;
      const write = hostPersistence.tail
        .catch(() => undefined)
        .then(async () => {
          if (!options.force && serialized === hostPersistence.lastPersisted) return;
          await appendHostState(session, snapshot, {
            ...options,
              projectRoot: request.outputDir,
            ...(runtime ? {
              appendCustomEntry: (customType, data) => runtime!.appendCustomEntry(customType, data)
            } : {})
          });
          hostPersistence.lastPersisted = serialized;
        });
      hostPersistence.tail = write;
      return write;
    };
    let deferredTranslationReuseAuditIds: string[] = [];
    const retainedWorkflowDocumentIds = domainRun?.fullWorkflow === true
      && domainRun.kind === "translation"
      && runtimeRequest.reuseExistingTranslation === true
      ? await (async () => {
          const resolvedManifest = await resolvePiSourceManifest(runtimeRequest);
          if (resolvedManifest.kind !== "folder") {
            return new Set(resolvedManifest.documents.map((document) => document.id));
          }
          return new Set(parseFolderTranslationOrder(
            runtimeRequest.folderTranslationOrder,
            resolvedManifest.documents.map((document) => document.id)
          ).keys());
        })()
      : undefined;
    if (
      domainRun?.kind === "translation"
      && runtimeRequest.reuseExistingTranslation === true
    ) {
      const currentAudits = await listCurrentTranslationReuseAudits(
        runtimeRequest.outputDir,
        runtimeRequest.sessionId,
        retainedWorkflowDocumentIds
      );
      const readyAuditIds = currentAudits.length > 0
        && currentAudits.every((audit) => audit.status === "awaiting_user_decision")
        ? currentAudits.map((audit) => audit.auditId)
        : [];
      if (!hostState.workflowSuspended) domainRun.recordTranslationReuseAuditReady(readyAuditIds);
      if (
        readyAuditIds.length > 0
      ) {
        if (hostState.workflowSuspended) deferredTranslationReuseAuditIds = readyAuditIds;
      }
    }
    const hasParkedWorkflow = (): boolean => Object.values(hostState.parkedDomainRuns)
      .some((snapshot) => snapshot?.fullWorkflowActive === true);
    const hydrateCurrentTranslationReuseAudits = async (run: YnDomainRunContract): Promise<void> => {
      if (run.kind !== "translation" || runtimeRequest.reuseExistingTranslation !== true) return;
      const currentAudits = await listCurrentTranslationReuseAudits(
        runtimeRequest.outputDir,
        runtimeRequest.sessionId,
        retainedWorkflowDocumentIds
      );
      const readyAuditIds = currentAudits.length > 0
        && currentAudits.every((audit) => audit.status === "awaiting_user_decision")
        ? currentAudits.map((audit) => audit.auditId)
        : [];
      run.recordTranslationReuseAuditReady(readyAuditIds);
    };
    const toolContext: Parameters<NonNullable<PiNativeSessionServiceOptions["createTools"]>>[0] = {
      request: runtimeRequest,
      publishCustomMessage,
      subagents,
      domainRun,
      proofreadState,
      translationAlignmentState,
      persistHostState,
      isWorkflowSuspended: () => hostState.workflowSuspended,
      parkedWorkflows: () => (["translation", "proofread"] as const).filter((kind) => (
        hostState.parkedDomainRuns[kind]?.fullWorkflowActive === true
      )),
      resumeWorkflow: async (kind) => {
        const previousDomainRun = domainRun;
        const previousHostDomainRun = hostState.domainRun;
        const previousToolDomainRun = toolContext.domainRun;
        const previousWorkflowSuspended = hostState.workflowSuspended;
        const parkedKinds = (["translation", "proofread"] as const).filter((entry) => (
          hostState.parkedDomainRuns[entry]?.fullWorkflowActive === true
        ));
        const requestedKind = kind && (kind === "translation" || kind === "proofread") ? kind : undefined;
        let suspendedRun = hostState.workflowSuspended ? hostState.domainRun : undefined;
        let parkedKind: YnWorkflowKind | undefined;
        let parkedSnapshot: YnDomainRunSnapshot | undefined;
        let displacedKind: YnWorkflowKind | undefined;
        let displacedSnapshot: YnDomainRunSnapshot | undefined;
        if (requestedKind && hostState.domainRun?.kind === requestedKind && hostState.workflowSuspended) {
          suspendedRun = hostState.domainRun;
        } else if (requestedKind && hostState.parkedDomainRuns[requestedKind]?.fullWorkflowActive === true) {
          if (
            hostState.domainRun?.fullWorkflow
            && hostState.domainRun.kind
            && hostState.domainRun.kind !== requestedKind
          ) {
            hostState.domainRun.suspend();
            displacedKind = hostState.domainRun.kind;
            displacedSnapshot = hostState.domainRun.snapshot();
            hostState.parkedDomainRuns[displacedKind] = displacedSnapshot;
          }
          parkedKind = requestedKind;
          parkedSnapshot = hostState.parkedDomainRuns[requestedKind];
          suspendedRun = restoreDomainRun(parkedSnapshot!);
        } else if (!suspendedRun && !requestedKind && parkedKinds.length === 1 && !hostState.domainRun?.fullWorkflow) {
          parkedKind = parkedKinds[0];
          parkedSnapshot = hostState.parkedDomainRuns[parkedKind];
          suspendedRun = restoreDomainRun(parkedSnapshot!);
        } else if (!suspendedRun) {
          if (requestedKind) {
            throw new Error(`No parked ${requestedKind} workflow exists to resume.`);
          }
          throw new Error(
            parkedKinds.length > 0
              ? `resumeYnWorkflow requires workflow: ${parkedKinds.join(" | ")}.`
              : "This Pi session has no suspended Host workflow to resume."
          );
        }
        const suspendedSnapshot = suspendedRun.snapshot();
        const previousPreparationStopped = hostState.taskPreparation?.stopped;
        const previousDeferredTranslationReuseAuditIds = [...deferredTranslationReuseAuditIds];
        try {
          suspendedRun.resume();
          suspendedRun.configureProjectSubagentCeiling(
            runtimeRequest.subagentEnabled,
            runtimeRequest.subagentCount
          );
          if (suspendedRun.fullWorkflow && deferredTranslationReuseAuditIds.length > 0) {
            suspendedRun.recordTranslationReuseAuditReady(deferredTranslationReuseAuditIds);
            deferredTranslationReuseAuditIds = [];
          }
          await hydrateCurrentTranslationReuseAudits(suspendedRun);
          if (parkedKind) delete hostState.parkedDomainRuns[parkedKind];
          domainRun = suspendedRun;
          hostState.domainRun = suspendedRun;
          toolContext.domainRun = suspendedRun;
          if (activeRuntime) activeRuntime.domainRun = suspendedRun;
          hostState.workflowSuspended = false;
          if (hostState.taskPreparation?.started && hostState.taskPreparation.intent === suspendedRun.kind) {
            hostState.taskPreparation.stopped = false;
          }
          await persistHostState();
          subagents.resumeAfterHostFailure();
        } catch (error) {
          if (hostState.taskPreparation) hostState.taskPreparation.stopped = previousPreparationStopped;
          suspendedRun.suspend();
          const restoredSuspendedRun = restoreDomainRun(suspendedSnapshot);
          restoredSuspendedRun.suspend();
          const rollbackDomainRun = previousDomainRun === suspendedRun
            ? restoredSuspendedRun
            : previousDomainRun;
          const rollbackHostDomainRun = previousHostDomainRun === suspendedRun
            ? restoredSuspendedRun
            : previousHostDomainRun;
          const rollbackToolDomainRun = previousToolDomainRun === suspendedRun
            ? restoredSuspendedRun
            : previousToolDomainRun;
          domainRun = rollbackDomainRun;
          hostState.domainRun = rollbackHostDomainRun;
          toolContext.domainRun = rollbackToolDomainRun;
          if (activeRuntime) activeRuntime.domainRun = rollbackDomainRun;
          hostState.workflowSuspended = previousWorkflowSuspended;
          deferredTranslationReuseAuditIds = previousDeferredTranslationReuseAuditIds;
          if (parkedKind && parkedSnapshot) hostState.parkedDomainRuns[parkedKind] = parkedSnapshot;
          if (displacedKind) {
            if (displacedSnapshot) hostState.parkedDomainRuns[displacedKind] = displacedSnapshot;
            else delete hostState.parkedDomainRuns[displacedKind];
          }
          throw error;
        }
      }
    };
    if (autoResumeStoppedWorkflow) {
      // A new typed workflow prompt is explicit continuation authorization.
      // Reuse the transactional Host resume path before the model can falsely
      // report a stopped batch as active. Recovery pauses remain tool-gated.
      const autoKind = workflowIntent;
      await toolContext.resumeWorkflow?.(
        autoKind === "translation" || autoKind === "proofread" ? autoKind : undefined
      );
    }
    const preparation = hostState.taskPreparation;
    const preparing = purpose === "prompt" && preparation !== undefined && !preparation.started && !preparation.completed;
    if (preparing && !this.taskPreparationHost) throw new Error("YN task preparation Host is not configured.");
    toolContext.supportsImages = () => (runtime?.getModel() ?? selection.model).input.includes("image");
    const rawTools = purpose === "prompt" ? [
      ...await this.options.createTools?.(toolContext) ?? [],
      ...(preparing ? createTaskPreparationTools({ state: preparation!, request: runtimeRequest, host: this.taskPreparationHost!, persist: persistHostState }) : [])
    ] : [];
    const tools = rawTools.map((tool) => {
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        execute: (async (...args: Parameters<typeof execute>) => {
          const wasPendingWarningReview = domainRun?.translationWarningReviewDecision === "pending";
          try {
            return await execute(...args);
          } finally {
            try {
              if (domainRun?.fullWorkflow && domainRun.kind === "translation"
                && domainRun.translationWarningReviewDecision === "pending" && !wasPendingWarningReview) {
                hostState.warningReview = undefined;
                hostState.warningReview = warningReviewFromHostState({ schemaVersion: 1, ownerSessionId: request.sessionId,
                  domainRun: domainRun.snapshot(), proofread: hostState.proofread, translationAlignment: hostState.translationAlignment });
              }
              await persistHostState();
            } catch (error) {
              throw new NonRetryableAssignmentError(
                `Failed to persist Host state after ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
                error
              );
            }
          }
        }) as typeof tool.execute
      };
    });
    const promptRequest = domainRun ? {
      ...runtimeRequest,
      ...(domainRun.fullWorkflow && domainRun.kind ? { workflowIntent: domainRun.kind } : {}),
      subagentEnabled: domainRun.configuredSubagents > 0,
      subagentCount: domainRun.configuredSubagents
    } : runtimeRequest;
    const systemPrompt = (preparing ? buildTaskPreparationPrompt(preparation!) + "\n" : "") + (await this.options.buildSystemPrompt?.(promptRequest, {
      fullWorkflow: domainRun?.fullWorkflow ?? fullWorkflow,
      workflowSuspended: hostState.workflowSuspended || hasParkedWorkflow(),
      domainRun
    }) ?? GENERIC_SYSTEM_PROMPT);
    preparationSignal?.throwIfAborted();
    if (reservation?.cancelled) throw new DOMException("Pi runtime preparation was stopped.", "AbortError");
    let userGateAssistantKey = "";
    let terminateUserGateBatch = false;
    runtime = new PiSessionAgentRuntime({
      session,
      sessionId: request.sessionId,
      models: selection.models,
      model: selection.model,
      thinkingLevel: normalizeThinkingLevel(selection.model, request.thinkingLevel),
      systemPrompt,
      onFatalToolError: (error) => subagents.stopForHostFailure(error),
      tools,
      beforeToolCall: async () => domainRun?.fullWorkflow && domainRun.translationWarningReviewDecision === "pending"
        ? { block: true, reason: "Host is waiting for the fixed translation warning-review choice.", terminate: true }
        : hostState.taskPreparation?.pendingRequest && !hostState.taskPreparation.stopped
          ? { block: true, reason: "Preparation is complete; Host is handing off to the full workflow.", terminate: true }
          : undefined,
      deferThresholdCompaction: () => subagents.hasRunning(),
      refreshExpiredProviderAuth: async (model) => {
        const refreshed = await (this.options.createModelSelection ?? createPiModelSelection)({
          workspaceDir: request.outputDir,
          providerId: model.provider,
          modelId: model.id
        });
        return refreshed.model;
      },
      afterToolCall: async (context) => {
        // Pi only terminates when every result in an assistant batch agrees.
        // Mark earlier results too, and block later calls after preparation succeeds.
        if (context.assistantMessage.content.some(block => block.type === "toolCall" && block.name === "startPreparedWorkflow")) {
          if (context.toolCall.name !== "startPreparedWorkflow" || !context.isError) return { terminate: true };
        }
        const assistantKey = JSON.stringify([
          context.assistantMessage.timestamp,
          context.assistantMessage.content.map((block) => (
            block.type === "toolCall" ? block.id : block.type
          ))
        ]);
        if (assistantKey !== userGateAssistantKey) {
          userGateAssistantKey = assistantKey;
          terminateUserGateBatch = false;
        }
        if (isTranslationWarningReviewGateToolResult({ content: context.result.content, details: context.result.details }) || isHostUserWaitGateToolResult({
          isError: context.isError,
          content: context.result.content,
          details: context.result.details
        })) {
          terminateUserGateBatch = true;
          return { terminate: true };
        }
        if (terminateUserGateBatch) return { terminate: true };
        // Pi ends a tool batch only when every result votes to terminate. An
        // artifact validation is the batch's decision boundary: earlier calls
        // vote yes, while the final validation votes yes only for a typed gate.
        // With no gate that final result keeps ordinary execution running.
        const calls = context.assistantMessage.content.filter(block => block.type === "toolCall");
        let finalValidation = -1;
        for (let index = 0; index < calls.length; index += 1) {
          if (calls[index].name === "validateTranslationArtifact") finalValidation = index;
        }
        const currentCall = calls.findIndex(call => call.id === context.toolCall.id);
        return currentCall < finalValidation ? { terminate: true } : undefined;
      }
    });
    if (resetPdfPreparationContext) runtime.resetContext();
    const active: ActiveSession = {
      workspaceDir: path.resolve(request.outputDir),
      sessionId: request.sessionId,
      runtime,
      session,
      unsubscribe: () => {},
      sequence: Math.max(previous?.sequence ?? 0, this.coldStorageSequences.get(sessionKey(request.outputDir, request.sessionId)) ?? 0),
      phase: "idle",
      running: false,
      compacting: false,
      streamingMessage: null,
      queuedSteer: [],
      queuedFollowUp: [],
      queuedNextTurn: [],
      liveSubagentMessages: previous && !retirePreviousSubagents
        ? previous.liveSubagentMessages
        : new Map(),
      queuedUserOrder: [],
      contextUsage: previous?.contextUsage,
      lastCompaction: previous?.lastCompaction,
      compactionError: previous?.compactionError,
      domainRun,
      hostState,
      persistHostState,
      hostPersistence,
      subagents,
      childCompletionGeneration
    };
    activeRuntime = active;
    for (const message of queuedCarryover) {
      const payload = queuedUserPayload(message);
      active.queuedUserOrder.push({
        sequence: ++this.nextQueuedInputSequence,
        kind: "nextTurn",
        text: payload.text,
        signature: queuedUserSignature(payload),
        message,
        pendingNative: true
      });
      await runtime.nextTurn(payload.text, { images: payload.images });
    }
    for (const entry of active.queuedUserOrder) entry.pendingNative = false;
    active.queuedNextTurn = [...queuedCarryover];
    return { active, previous, retirePreviousSubagents, preparationTimings: {
      storageOpenMs: 0, hostRestoreMs, modelSelectionMs, runtimeSetupMs: performance.now() - setupStarted
    } };
  }

  private commitPreparedRuntime(key: string, prepared: PreparedRuntime): ActiveSession {
    if (this.active.get(key) !== prepared.previous) {
      throw new Error("Pi session changed while its native runtime was being prepared.");
    }
    if (prepared.previous) {
      prepared.active.sequence = Math.max(prepared.active.sequence, prepared.previous.sequence);
      prepared.active.contextUsage = prepared.previous.contextUsage ?? prepared.active.contextUsage;
      prepared.active.lastCompaction = prepared.previous.lastCompaction ?? prepared.active.lastCompaction;
      prepared.active.compactionError = prepared.previous.compactionError;
    }
    prepared.active.unsubscribe = prepared.active.runtime.subscribe((event) => (
      this.handleRuntimeEvent(prepared.active, event)
    ));
    prepared.previous?.unsubscribe();
    prepared.previous?.runtime.dispose();
    this.active.set(key, prepared.active);
    if (prepared.retirePreviousSubagents) prepared.previous?.subagents.abortAll();
    return prepared.active;
  }

  /** A cancelled preparation never transfers its newly opened handle to an owner. */
  private async releaseCancelledPreparation(prepared: PreparedRuntime, cancellation: DOMException): Promise<never> {
    const errors: unknown[] = [cancellation];
    try { prepared.active.runtime.dispose(); } catch (error) { errors.push(error); }
    if (!prepared.previous) {
      try { await prepared.active.session.close(BACKGROUND_CONTEXT); } catch (error) { errors.push(error); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "Cancelled Pi runtime preparation could not release its resources.");
    throw cancellation;
  }

  private requireRunning(workspaceDir: string, sessionId: string): ActiveSession {
    const active = this.active.get(sessionKey(workspaceDir, sessionId));
    if (active?.pdfStructurePreparation) throw new Error("PDF structure preparation accepts only its Host source prompt and structure tools.");
    if (!active?.running) throw new Error(`Pi session ${sessionId} is not running.`);
    return active;
  }

  private async handleRuntimeEvent(active: ActiveSession, event: PiSessionRuntimeEvent): Promise<void> {
    const key = sessionKey(active.workspaceDir, active.sessionId);
    if (this.active.get(key) !== active) return;
    if (event.type === "agent_start") {
      active.running = true;
      active.phase = "turn";
    } else if (event.type === "auto_retry_start") {
      active.running = true;
      active.phase = "retry";
      active.error = undefined;
    } else if (event.type === "auto_retry_end") {
      active.phase = active.running ? "turn" : "idle";
      if (event.success) active.error = undefined;
      else if (event.finalError && event.finalError !== "Retry cancelled") active.error = event.finalError;
    } else if (event.type === "compaction_start") {
      active.compacting = true;
      active.phase = "compaction";
      active.compactionError = undefined;
      if (event.reason === "overflow") active.error = undefined;
    } else if (event.type === "compaction_end") {
      active.compacting = false;
      active.phase = active.running ? "turn" : "idle";
      if (event.result) {
        active.lastCompaction = event.result;
        active.contextUsage = {
          tokens: event.result.estimatedTokensAfter,
          contextWindow: active.runtime.getModel().contextWindow,
          percent: active.runtime.getModel().contextWindow > 0
            ? Math.min(100, (event.result.estimatedTokensAfter / active.runtime.getModel().contextWindow) * 100)
            : 0
        };
        active.compactionError = undefined;
        if (event.willRetry) active.error = undefined;
      } else if (event.errorMessage) {
        active.compactionError = event.errorMessage;
      }
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      active.streamingMessage = event.message;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      active.streamingMessage = null;
      const assistant = event.message as Extract<AgentMessage, { role: "assistant" }> & {
        stopReason?: string;
        errorMessage?: string;
      };
      if (assistant.stopReason === "error") {
        active.error = assistant.errorMessage?.trim() || "The model provider failed without an error message.";
      }
    } else if (event.type === "settled") {
      // Native provider idle is not the end of a Host-owned preparation/finish.
      active.running = Boolean(active.pdfStructurePreparation || active.promptOperation && !active.promptOperation.cancelled
        && active.hostState.taskPreparation && !active.hostState.taskPreparation.completed);
      active.phase = active.running ? "turn" : "idle";
      active.streamingMessage = null;
    } else if (event.type === "queue_update") {
      active.queuedSteer = [...event.steer];
      active.queuedFollowUp = [...event.followUp];
      active.queuedNextTurn = [...event.nextTurn];
      this.reconcileQueuedUserOrder(active);
    }

    active.sequence += 1;
    const envelope: PiSessionEventEnvelope = {
      workspaceDir: active.workspaceDir,
      sessionId: active.sessionId,
      sequence: active.sequence,
      timestamp: Date.now(),
      event
    };
    const log = this.events.get(key) ?? [];
    log.push(envelope);
    if (log.length > EVENT_LOG_LIMIT) log.splice(0, log.length - EVENT_LOG_LIMIT);
    this.events.set(key, log);
    for (const listener of this.eventListeners) listener(envelope);
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      this.emitActiveState(active);
    }

    if (
      event.type !== "message_end"
      || event.message.role !== "assistant"
      || !active.domainRun
      || active.hostState.workflowSuspended
    ) return;
    const assistant = event.message as Extract<AgentMessage, { role: "assistant" }> & {
      stopReason?: string;
      errorMessage?: string;
    };
    const hasToolCall = Array.isArray(assistant.content)
      && assistant.content.some((block) => block.type === "toolCall");
    const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted" || Boolean(assistant.errorMessage);
    if (hasToolCall || failed) return;
    if (active.subagents.hasRunning()) {
      return;
    }
    if (active.domainRun.awaitingUserInput) return;
    if (sessionHasOpenHostUserGate(active.runtime.getMessages())) {
      console.info(JSON.stringify({
        type: "yn.host.user_gate",
        action: "suppress_domain_repair",
        sessionId: active.sessionId
      }));
      return;
    }

    const repairPrompt = active.domainRun.nextRepairPrompt();
    if (repairPrompt) {
      await active.runtime.followUpMessage({
        role: "custom",
        customType: "yn-domain-repair",
        content: repairPrompt,
        display: false,
        details: { kind: active.domainRun.kind, reasons: active.domainRun.incompleteReasons() },
        timestamp: Date.now()
      });
      return;
    }
    const incomplete = active.domainRun.incompleteReasons();
    if (incomplete.length > 0) {
      active.error = `YN workflow completion contract failed: ${incomplete.join("; ")}`;
    }
  }

  private async publishExternalMessage(
    workspaceDir: string,
    sessionId: string,
    message: AgentMessage
  ): Promise<void> {
    const key = sessionKey(workspaceDir, sessionId);
    let owner: ActiveSession | undefined;
    let appendTask: Promise<void> | undefined;
    let awaitedInsideTransition = false;
    await this.withSessionTransition(workspaceDir, sessionId, async () => {
      const active = this.active.get(key);
      if (!active) throw new Error("Pi session is not ready to publish a custom message.");
      owner = active;
      this.recordLiveSubagentMessage(active, message);
      appendTask = active.runtime.appendMessage(message);
      if (!active.running) {
        awaitedInsideTransition = true;
        await appendTask;
      }
    });
    if (!appendTask || !owner) throw new Error("Pi session custom message persistence did not start.");
    if (!awaitedInsideTransition) await appendTask;

    await this.withSessionTransition(workspaceDir, sessionId, async () => {
      const active = this.active.get(key);
      if (!active) return;
      if (active !== owner) this.recordLiveSubagentMessage(active, message);
      await this.handleRuntimeEvent(active, { type: "message_end", message } as PiSessionRuntimeEvent);
    });
  }

  private async publishExternalLiveMessage(
    workspaceDir: string,
    sessionId: string,
    message: AgentMessage
  ): Promise<void> {
    await this.withSessionTransition(workspaceDir, sessionId, async () => {
      const active = this.active.get(sessionKey(workspaceDir, sessionId));
      if (!active) throw new Error("Pi session is not ready to publish live child progress.");
      this.recordLiveSubagentMessage(active, message);
      await this.handleRuntimeEvent(active, { type: "message_end", message } as PiSessionRuntimeEvent);
    });
  }

  private async deliverParentNotification(
    workspaceDir: string,
    sessionId: string,
    message: AgentMessage,
    expectedGeneration: number
  ): Promise<void> {
    const key = sessionKey(workspaceDir, sessionId);
    const current = this.active.get(key);
    if (!current) throw new Error(`Pi session ${sessionId} is no longer active for child completion.`);
    if (current.childCompletionGeneration !== expectedGeneration) return;
    const deliveryGeneration = expectedGeneration;
    if (current.compactionTask) {
      await current.compactionTask.catch(() => undefined);
    }
    let lastAwaitedPromptTask: Promise<void> | undefined;
    while (true) {
      let consumptionTask: Promise<void> | undefined;
      let currentPromptTask: Promise<void> | undefined;
      let startedTurn = false;
      let cancelled = false;
      await this.withSessionTransition(workspaceDir, sessionId, async () => {
        const active = this.active.get(key);
        if (!active) throw new Error(`Pi session ${sessionId} is no longer active for child completion.`);
        if (active.childCompletionGeneration !== deliveryGeneration) {
          cancelled = true;
          return;
        }
        if (active.compacting) throw new Error("Cannot deliver child completion while Pi compaction is still active.");
        if (active.running) {
          currentPromptTask = active.promptTask;
          if (!isWorkflowFailureReport(message) && active.runtime.acceptsQueuedInput()) {
            consumptionTask = active.runtime.followUpMessageAndWaitForConsumption(message);
          }
          return;
        }
        const operation: PromptOperation = {
          generation: ++this.nextPromptGeneration,
          cancelled: false,
          abortController: new AbortController()
        };
        active.promptOperation = operation;
        active.running = true;
        active.phase = "turn";
        if (!isWorkflowFailureReport(message)) active.error = undefined;
        this.emitActiveState(active);
        this.launchNativeInput(active, message, operation);
        startedTurn = true;
      });
      if (cancelled) return;
      if (startedTurn) return;
      if (consumptionTask) {
        try {
          await consumptionTask;
          return;
        } catch (error) {
          if (!(error instanceof PiQueuedInputNotConsumedError)) throw error;
        }
      }
      if (!currentPromptTask) {
        throw new Error("The running Pi parent has no tracked native prompt task for child completion delivery.");
      }
      if (currentPromptTask === lastAwaitedPromptTask) {
        throw new Error(
          "Pi parent completion delivery made no progress after its tracked prompt settled."
        );
      }
      lastAwaitedPromptTask = currentPromptTask;
      await currentPromptTask;
    }
  }

  private async runNativeCompaction(
    active: ActiveSession,
    reason: PiSessionCompactionResult["reason"],
    customInstructions?: string
  ): Promise<PiSessionCompactionResult> {
    try {
      const nativeResult = await active.runtime.compact(customInstructions?.trim() || undefined);
      const context = await readSessionContext(active.session);
      const estimatedTokensAfter = estimateContextTokens(context.messages).tokens;
      const model = active.runtime.getModel();
      const contextWindow = model.contextWindow;
      const result: PiSessionCompactionResult = {
        reason,
        summary: nativeResult.summary,
        firstKeptEntryId: nativeResult.firstKeptEntryId,
        tokensBefore: nativeResult.tokensBefore,
        estimatedTokensAfter,
        timestamp: Date.now(),
        details: nativeResult.details
      };
      active.contextUsage = {
        tokens: estimatedTokensAfter,
        contextWindow,
        percent: contextWindow > 0 ? Math.min(100, (estimatedTokensAfter / contextWindow) * 100) : 0
      };
      active.lastCompaction = result;
      active.compactionError = undefined;
      return result;
    } catch (error) {
      active.compactionError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      active.compacting = false;
      active.compactionTask = undefined;
      active.phase = active.running ? "turn" : "idle";
      this.emitActiveState(active);
    }
  }

  private launchNativeInput(
    active: ActiveSession,
    input: string | AgentMessage,
    operation: PromptOperation,
    images?: ImageContent[]
  ): void {
    const task = this.runNativeInput(active, input, operation, images);
    active.promptTask = task;
    void task.then(
      () => {
        if (active.promptTask === task) active.promptTask = undefined;
      },
      () => {
        if (active.promptTask === task) active.promptTask = undefined;
      }
    );
  }

  private async restoreUnstartedWarningReview(active: ActiveSession, operation: PromptOperation): Promise<void> {
    const undo = operation.undoUnstartedWarningReview;
    if (!undo) return;
    operation.undoUnstartedWarningReview = undefined;
    undo();
    this.suspendDomainRun(active);
    try { await active.persistHostState({ force: true }); }
    catch (error) {
      throw new NonRetryableAssignmentError(
        `Failed to persist the restored unstarted warning-review choice: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  private async runNativeInput(
    active: ActiveSession,
    input: string | AgentMessage,
    operation: PromptOperation,
    images?: ImageContent[]
  ): Promise<void> {
    try {
      this.assertPromptOperation(active, operation);
      await this.compactBeforePromptIfNeeded(active, operation);
      this.assertPromptOperation(active, operation);
      active.phase = "turn";
      this.emitActiveState(active);
      this.assertPromptOperation(active, operation);
      const reportOnly = typeof input !== "string" && isWorkflowFailureReport(input);
      // From this call onward native input may have executed real work. A later
      // Stop/error retains review authorization and must never recreate a click.
      operation.undoUnstartedWarningReview = undefined;
      await active.runtime.prompt(input, { images, reportOnly });
      this.assertPromptOperation(active, operation);
      const incomplete = active.hostState.workflowSuspended || active.subagents.hasRunning()
        ? []
        : active.domainRun?.incompleteReasons() ?? [];
      if (
        !active.error
        && incomplete.length > 0
        && active.domainRun?.awaitingUserInput !== true
        && !sessionHasOpenHostUserGate(active.runtime.getMessages())
      ) {
        active.error = `YN workflow completion contract failed: ${incomplete.join("; ")}`;
      }
    } catch (error) {
      try { await this.restoreUnstartedWarningReview(active, operation); }
      catch (rollbackError) {
        active.error = `Native input preparation failed: ${String(error)}; restoring the unstarted warning-review choice also failed: ${String(rollbackError)}`;
        throw new NonRetryableAssignmentError(active.error, new AggregateError([error, rollbackError]));
      }
      if (this.isCurrentPromptOperation(active, operation) && !operation.cancelled) {
        active.error = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && isWorkflowStoppingAssignmentError(error)) {
          await active.subagents.stopForHostFailure(error);
        }
      }
    } finally {
      if (!this.isCurrentPromptOperation(active, operation) || operation.cancelled) return;
      active.streamingMessage = null;
      try {
        await this.refreshContextUsage(active);
      } catch (error) {
        active.error = error instanceof Error ? error.message : String(error);
      }
      if (!this.isCurrentPromptOperation(active, operation) || operation.cancelled) return;
      // Handoff is deliberately outside the prompt/session transition lock.
      // The old closures keep their immutable request until the native turn settles.
      try {
        await this.settleTaskPreparation(active, operation);
      } catch (error) {
        if (this.isCurrentPromptOperation(active, operation) && !operation.cancelled) {
          active.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (this.isCurrentPromptOperation(active, operation) && !operation.cancelled) {
          active.running = false;
          active.phase = "idle";
          active.promptOperation = undefined;
          this.emitActiveState(active);
        }
      }
    }
  }

  private async settleTaskPreparation(active: ActiveSession, operation: PromptOperation): Promise<void> {
    const preparation = active.hostState.taskPreparation;
    const stillOwned = () => !operation.cancelled
      && this.active.get(sessionKey(active.workspaceDir, active.sessionId)) === active
      && active.promptOperation === operation && !preparation?.stopped;
    if (!preparation || !stillOwned() || active.error || active.hostState.workflowSuspended || active.subagents.hasRunning()) return;
    if (preparation.pendingRequest && !preparation.started) {
      let request = structuredClone(preparation.pendingRequest);
      if (workspaceKey(request.outputDir) === workspaceKey(active.workspaceDir)) {
        request.sessionId = active.sessionId;
      } else {
        const summary = await this.createSession(request.outputDir);
        if (!stillOwned()) return;
        request.sessionId = summary.id;
        request.prompt += `\n\nPreparation handoff from another project: ${preparation.intent}; use only this project's current settings and assets.`;
      }
      if (!stillOwned()) return;
      const handoff = { ...preparation, pendingRequest: undefined, started: true, stopped: false };
      // The pending request is already durable. acceptPrompt persists the new
      // started baseline before its first provider call; do not claim a launch
      // in the old baseline, which would strand recovery if the app exits here.
      try {
        active.running = false;
        await this.acceptPrompt({ ...request, taskPreparation: undefined }, handoff, () => !stillOwned());
        if (workspaceKey(request.outputDir) !== workspaceKey(active.workspaceDir)) {
          preparation.pendingRequest = undefined;
          preparation.started = true;
          await active.persistHostState();
        }
      } catch (error) {
        preparation.started = false;
        preparation.stopped = true;
        await active.persistHostState();
        throw error;
      }
      return;
    }
    const domain = active.domainRun;
    if (!preparation.started || preparation.completed || !domain?.fullWorkflow
      || domain.kind !== preparation.intent || domain.awaitingUserInput || domain.recoveryPauseId
      || domain.incompleteReasons().length > 0) return;
    if (!this.taskPreparationHost) throw new Error("YN task completion Host is not configured.");
    await this.taskPreparationHost.finishWorkflow(taskPreparationContext(preparation, {
      outputDir: active.workspaceDir, sessionId: active.sessionId
    }), { workflow: domain.kind, autoApplyProofreadSuggestions: preparation.autoApplyProofreadSuggestions === true }, operation.abortController.signal);
    if (!stillOwned()) return;
    preparation.completed = true;
    try {
      await active.persistHostState();
    } catch (error) {
      preparation.completed = false;
      throw error;
    }
  }

  private async compactBeforePromptIfNeeded(active: ActiveSession, operation: PromptOperation): Promise<void> {
    this.assertPromptOperation(active, operation);
    const usage = await this.refreshContextUsage(active);
    this.assertPromptOperation(active, operation);
    if (active.subagents.hasRunning()) return;
    const model = active.runtime.getModel();
    if (!shouldCompact(usage.tokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
    active.compacting = true;
    active.phase = "compaction";
    active.compactionError = undefined;
    this.emitActiveState(active);
    const task = this.runNativeCompaction(active, "threshold");
    active.compactionTask = task;
    await task;
    this.assertPromptOperation(active, operation);
  }

  private isCurrentPromptOperation(active: ActiveSession, operation: PromptOperation): boolean {
    return this.active.get(sessionKey(active.workspaceDir, active.sessionId)) === active
      && active.promptOperation === operation;
  }

  private assertPromptOperation(active: ActiveSession, operation: PromptOperation): void {
    if (operation.cancelled || !this.isCurrentPromptOperation(active, operation)) {
      throw new DOMException(
        `Pi prompt generation ${operation.generation} is no longer active.`,
        "AbortError"
      );
    }
  }

  private async refreshContextUsage(active: ActiveSession): Promise<PiSessionContextUsage> {
    const messages = (await readSessionContext(active.session)).messages;
    const tokens = estimateContextTokens(messages).tokens;
    const contextWindow = active.runtime.getModel().contextWindow;
    const usage = {
      tokens,
      contextWindow,
      percent: contextWindow > 0 ? Math.min(100, (tokens / contextWindow) * 100) : 0
    };
    active.contextUsage = usage;
    return usage;
  }

  private stateFromActive(active: ActiveSession): PiSessionRunState {
    const model = active.runtime.getModel();
    const pendingWarningReview = active.hostState.domainRun?.translationWarningReviewDecision === "pending"
      || active.hostState.parkedDomainRuns.translation?.translationWarningReviewDecision === "pending";
    return {
      sessionId: active.sessionId,
      sequence: active.sequence,
      running: active.running || Boolean(active.promptOperation && !active.promptOperation.cancelled
        && active.hostState.taskPreparation && !active.hostState.taskPreparation.completed),
      phase: active.phase,
      streamingMessage: active.streamingMessage,
      model: { provider: model.provider, id: model.id, name: model.name },
      thinkingLevel: active.runtime.getThinkingLevel(),
      queuedSteer: active.queuedSteer,
      queuedFollowUp: active.queuedFollowUp,
      queuedNextTurn: active.queuedNextTurn,
      subagentMessages: [...active.liveSubagentMessages.values()],
      compacting: active.compacting,
      contextUsage: active.contextUsage,
      lastCompaction: active.lastCompaction,
      compactionError: active.compactionError,
      error: active.error,
      warningReview: pendingWarningReview
        ? active.hostState.warningReview ? { ...active.hostState.warningReview } : warningReviewFromHostState(this.hostSnapshot(active))
        : undefined
    };
  }

  private reconcileQueuedUserOrder(active: ActiveSession): void {
    const pools: Record<QueuedInputKind, AgentMessage[]> = {
      steer: [...active.queuedSteer],
      followUp: [...active.queuedFollowUp],
      nextTurn: [...active.queuedNextTurn]
    };
    const retained: QueuedInputOrderEntry[] = [];
    for (const entry of [...active.queuedUserOrder].sort((left, right) => left.sequence - right.sequence)) {
      const message = takeTrackedMessage(pools[entry.kind], entry);
      if (message) {
        entry.message = message;
        retained.push(entry);
      } else if (entry.pendingNative) {
        retained.push(entry);
      }
    }
    active.queuedUserOrder = retained;
  }

  private recordLiveSubagentMessage(active: ActiveSession, message: AgentMessage): void {
    if (message.role !== "custom" || !message.details || typeof message.details !== "object") return;
    const subagentId = (message.details as Record<string, unknown>).subagentId;
    if (typeof subagentId === "string" && subagentId) {
      active.liveSubagentMessages.set(subagentId, message);
    }
  }

  private registerColdStorageController(key: string): AbortController {
    const controller = new AbortController();
    const controllers = this.coldStorageControllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.coldStorageControllers.set(key, controllers);
    return controller;
  }

  private releaseColdStorageController(key: string, controller: AbortController): void {
    const controllers = this.coldStorageControllers.get(key);
    controllers?.delete(controller);
    if (controllers?.size === 0) this.coldStorageControllers.delete(key);
  }

  private emitStorageProgress(
    workspaceDir: string,
    sessionId: string,
    progress: PiSessionStorageProgress
  ): void {
    const key = sessionKey(workspaceDir, sessionId);
    const active = this.active.get(key);
    const previousSequence = Math.max(
      active?.sequence ?? 0,
      this.coldStorageSequences.get(key) ?? 0,
      this.events.get(key)?.at(-1)?.sequence ?? 0
    );
    const sequence = previousSequence + 1;
    if (active) active.sequence = sequence;
    else this.coldStorageSequences.set(key, sequence);
    const envelope: PiSessionEventEnvelope = {
      workspaceDir: path.resolve(workspaceDir),
      sessionId,
      sequence,
      timestamp: Date.now(),
      event: { type: "storage_progress", progress }
    };
    const log = this.events.get(key) ?? [];
    log.push(envelope);
    if (log.length > EVENT_LOG_LIMIT) log.splice(0, log.length - EVENT_LOG_LIMIT);
    this.events.set(key, log);
    for (const listener of this.eventListeners) listener(envelope);
  }

  private async withWorkspaceTransition<T>(workspaceDir: string, operation: () => Promise<T>): Promise<T> {
    return this.withTransitions([this.workspaceTransitionResource(workspaceDir)], operation);
  }

  private async withSessionTransition<T>(
    workspaceDir: string,
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withTransitions([this.sessionTransitionResource(workspaceDir, sessionId)], operation);
  }

  private async withWorkspaceSessionTransition<T>(
    workspaceDir: string,
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withTransitions([
      this.workspaceTransitionResource(workspaceDir),
      this.sessionTransitionResource(workspaceDir, sessionId)
    ], operation);
  }

  private async withTransitions<T>(
    resourceKeys: string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const resources = [...new Set(resourceKeys)].sort();
    const predecessors = resources
      .map((resource) => this.transitionTails.get(resource))
      .filter((tail): tail is Promise<void> => Boolean(tail));
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const resource of resources) this.transitionTails.set(resource, tail);
    try {
      await Promise.all(predecessors);
      return await operation();
    } finally {
      release();
      for (const resource of resources) {
        if (this.transitionTails.get(resource) === tail) this.transitionTails.delete(resource);
      }
    }
  }

  private cancelWorkspaceOperationReservations(workspaceDir: string): void {
    const prefix = `${workspaceKey(workspaceDir)}::`;
    for (const [key, reservation] of this.sessionOperationReservations) {
      if (key.startsWith(prefix)) { reservation.cancelled = true; reservation.preparationController?.abort(new DOMException("PDF workspace preparation was stopped.", "AbortError")); reservation.pdfStructurePreparation?.cancel(); }
    }
  }

  private workspaceTransitionResource(workspaceDir: string): string {
    return `workspace:${workspaceKey(workspaceDir)}`;
  }

  private sessionTransitionResource(workspaceDir: string, sessionId: string): string {
    return `session:${sessionKey(workspaceDir, sessionId)}`;
  }

  private workspaceSessionIds(workspaceDir: string): string[] {
    const prefix = `${workspaceKey(workspaceDir)}::`;
    const sessionIds = new Set(
      [...this.active.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, active]) => active.sessionId)
    );
    for (const key of this.sessionOperationReservations.keys()) {
      if (key.startsWith(prefix)) sessionIds.add(key.slice(prefix.length));
    }
    for (const key of this.coldStorageControllers.keys()) {
      if (key.startsWith(prefix)) sessionIds.add(key.slice(prefix.length));
    }
    return [...sessionIds];
  }

  private workspaceSessionResources(workspaceDir: string, sessionIds: string[]): string[] {
    return [
      this.workspaceTransitionResource(workspaceDir),
      ...sessionIds.map((sessionId) => this.sessionTransitionResource(workspaceDir, sessionId))
    ];
  }

  private suspendDomainRun(active: ActiveSession): void {
    if (active.hostState.taskPreparation) active.hostState.taskPreparation.stopped = true;
    const domainRun = active.domainRun ?? active.hostState.domainRun;
    if (domainRun && domainRun.incompleteReasons().length > 0) {
      domainRun.suspend();
      active.hostState.domainRun = domainRun;
      active.hostState.workflowSuspended = true;
    }
    active.domainRun = undefined;
  }

  private idleState(sessionId: string): PiSessionRunState {
    return {
      sessionId,
      sequence: 0,
      running: false,
      phase: "idle",
      streamingMessage: null,
      model: null,
      thinkingLevel: "off",
      queuedSteer: [],
      queuedFollowUp: [],
      queuedNextTurn: [],
      subagentMessages: [],
      compacting: false
    };
  }

  private emitState(
    workspaceDir: string,
    state: PiSessionRunState,
    selectionChange = false
  ): void {
    for (const listener of this.stateListeners) {
      listener(path.resolve(workspaceDir), state, selectionChange);
    }
  }

  private emitActiveState(active: ActiveSession, selectionChange = false): void {
    if (this.active.get(sessionKey(active.workspaceDir, active.sessionId)) !== active) return;
    active.sequence += 1;
    this.emitState(active.workspaceDir, this.stateFromActive(active), selectionChange);
  }
}

export async function buildProductYnSystemPrompt(
  request: PiSessionPromptRequest,
  context: { fullWorkflow: boolean; workflowSuspended: boolean; domainRun?: YnDomainRunContract } = {
    fullWorkflow: request.workflowIntent !== undefined,
    workflowSuspended: false
  }
): Promise<string> {
  const assets = await readProjectAssets({ outputDir: request.outputDir });
  return buildYnSystemPrompt(request, {
    approvedStyleGuide: assets.styleGuide,
    fullWorkflow: context.fullWorkflow,
    workflowSuspended: context.workflowSuspended
  });
}

export const piNativeSessionService = new PiNativeSessionService({
  createTools: (context) => {
    context.readInterfaceContext = () => ynInterfaceContextStore.read(context.request.outputDir);
    return createYnDomainTools(context);
  },
  buildSystemPrompt: buildProductYnSystemPrompt,
  enforceDomainCompletion: true
});
