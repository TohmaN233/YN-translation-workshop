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
  PiSessionRunState,
  PiSessionStateEnvelope,
  PiSessionSummary,
  PiSessionRuntimeEvent
} from "../../../shared/agent/piSessionContract.ts";
import { resolveWorkflowSubagentCount } from "../../../shared/agent/piSessionContract.ts";
import { resolveThinkingLevelForModel } from "../../../shared/agent/thinkingLevels.ts";
import { createPiModelSelection } from "./providerRegistry.ts";
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
  type ProofreadHostState
} from "./proofreadSessionState.ts";
import type { TranslationAlignmentHostState } from "./translationAlignmentState.ts";
import { PiSessionRepository } from "./sessionRepository.ts";
import { PiQueuedInputNotConsumedError, PiSessionAgentRuntime } from "./sessionAgentRuntime.ts";
import { compactSubagentCards, interruptedSubagentCards } from "./subagentMessages.ts";
import { YnSubagentSupervisor } from "./subagentSupervisor.ts";
import { buildYnSystemPrompt } from "./systemPrompt.ts";
import { listCurrentTranslationReuseAudits } from "./translationReuseAudit.ts";
import { createYnDomainTools } from "./ynDomainTools.ts";
import { parseFolderTranslationOrder } from "./folderTranslationPlan.ts";
import { resolvePiSourceManifest } from "./sourceManifest.ts";
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
import { normalizeCustomPreserveRules } from "../../../shared/validation/customPreserveRules.ts";

type EventListener = (envelope: PiSessionEventEnvelope) => void;
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
  if (state.sourcePath !== undefined || state.sourceKind !== undefined) {
    if (typeof state.sourcePath !== "string" || !state.sourcePath.trim()) {
      throw new Error("Invalid project setting sourcePath: expected a non-empty string.");
    }
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
  current.customPreserveRules = normalizeCustomPreserveRules(state.customPreserveRules);
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
    domainRun?: YnDomainRunContract;
    parkedDomainRuns: Partial<Record<YnWorkflowKind, YnDomainRunSnapshot>>;
    workflowSuspended: boolean;
    proofread: ProofreadHostState;
    translationAlignment: TranslationAlignmentHostState;
  };
  persistHostState: (options?: { force?: boolean }) => Promise<void>;
  subagents: YnSubagentSupervisor;
  promptOperation?: PromptOperation;
  promptTask?: Promise<void>;
  childCompletionGeneration: number;
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
  cancelled: boolean;
}

interface PromptOperation {
  generation: number;
  cancelled: boolean;
}

interface PreparedRuntime {
  active: ActiveSession;
  previous?: ActiveSession;
  retirePreviousSubagents: boolean;
}

function ownedSubagentIds(active: ActiveSession | undefined): Set<string> {
  return new Set(active?.subagents.list().flatMap((batch) => (
    batch.subagents.map((subagent) => subagent.id)
  )) ?? []);
}

export interface PiNativeSessionServiceOptions {
  createModelSelection?: typeof createPiModelSelection;
  createTools?: (context: {
    request: PiSessionPromptRequest;
    publishCustomMessage: (message: AgentMessage) => Promise<void>;
    subagents: YnSubagentSupervisor;
    domainRun?: YnDomainRunContract;
    proofreadState?: ProofreadHostState;
    translationAlignmentState?: TranslationAlignmentHostState;
    persistHostState?: () => Promise<void>;
    isWorkflowSuspended?: () => boolean;
    resumeWorkflow?: () => Promise<void>;
    readInterfaceContext?: () => ReturnType<typeof ynInterfaceContextStore.read>;
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
  private readonly active = new Map<string, ActiveSession>();
  private readonly sessionOperationReservations = new Map<string, SessionOperationReservation>();
  private readonly transitionTails = new Map<string, Promise<void>>();
  private readonly closingSessions = new Set<string>();
  private readonly events = new Map<string, PiSessionEventEnvelope[]>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly options: PiNativeSessionServiceOptions;
  private nextQueuedInputSequence = 0;
  private nextPromptGeneration = 0;

  constructor(options: PiNativeSessionServiceOptions = {}) {
    this.options = options;
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
    return this.withWorkspaceTransition(workspaceDir, async () => {
      const repository = new PiSessionRepository(workspaceDir);
      const sessionId = `pi_${randomUUID()}`;
      const session = await repository.create(sessionId);
      await repository.writeActiveSessionId(sessionId);
      const summary = await repository.summaryForMetadata(await session.getMetadata());
      this.emitState(workspaceDir, this.idleState(sessionId), true);
      return summary;
    });
  }

  async selectSession(workspaceDir: string, sessionId: string): Promise<void> {
    await this.withWorkspaceTransition(workspaceDir, async () => {
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
    const key = sessionKey(workspaceDir, sessionId);
    if (this.closingSessions.has(key)) throw new Error(`Pi session ${sessionId} is already closing.`);
    this.closingSessions.add(key);
    const reservation = this.sessionOperationReservations.get(key);
    if (reservation) reservation.cancelled = true;
    try {
      await this.abort(workspaceDir, sessionId);
      return await this.withWorkspaceSessionTransition(workspaceDir, sessionId, async () => {
        const active = this.active.get(key);
        if (active?.compacting) throw new Error("Wait for native Pi compaction before deleting this session.");
        active?.unsubscribe();
        active?.runtime.dispose();
        this.active.delete(key);
        this.events.delete(key);

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
    if (!sessionId) return [];
    return this.withSessionTransition(workspaceDir, sessionId, async () => {
      const key = sessionKey(workspaceDir, sessionId);
      const session = await new PiSessionRepository(workspaceDir).open(sessionId);
      const messages = compactSubagentCards((await session.buildContext()).messages.map(piWebDisplayMessage));
      const interrupted = interruptedSubagentCards(
        messages,
        Date.now(),
        ownedSubagentIds(this.active.get(key))
      );
      for (const message of interrupted) await session.appendMessage(message);
      return interrupted.length > 0
        ? compactSubagentCards([...messages, ...interrupted])
        : messages;
    });
  }

  async loadSubagentMessages(
    workspaceDir: string,
    parentSessionId: string,
    childSessionId: string
  ): Promise<AgentMessage[]> {
    const repository = new PiSessionRepository(workspaceDir);
    const child = await repository.openChildForParent(childSessionId, parentSessionId);
    return (await child.buildContext()).messages.map(piWebDisplayMessage);
  }

  listRecentEvents(workspaceDir: string, sessionId: string, afterSequence = 0): PiSessionEventEnvelope[] {
    return (this.events.get(sessionKey(workspaceDir, sessionId)) ?? [])
      .filter((entry) => entry.sequence > afterSequence);
  }

  async getRunState(workspaceDir: string, sessionId: string): Promise<PiSessionRunState> {
    const current = this.active.get(sessionKey(workspaceDir, sessionId));
    return current ? this.stateFromActive(current) : this.idleState(sessionId);
  }

  async prompt(request: PiSessionPromptRequest): Promise<PiSessionPromptAcceptance> {
    request = await resolveCurrentProjectPromptRequest(request);
    assertWorkflowPromptMetadata(request);
    if (request.workflowIntent) await ensureYnWorkflowWorkspace(request.outputDir);
    const key = sessionKey(request.outputDir, request.sessionId);
    if (this.closingSessions.has(key)) throw new Error(`Pi session ${request.sessionId} is closing.`);
    if (this.sessionOperationReservations.has(key)) {
      throw new Error("Pi session is already running. Use Steer or Follow-up.");
    }
    const reservation: SessionOperationReservation = { cancelled: false };
    this.sessionOperationReservations.set(key, reservation);
    try {
      await this.active.get(key)?.subagents.waitForTerminalSettlements();
      return await this.withWorkspaceSessionTransition(request.outputDir, request.sessionId, async () => {
        if (reservation.cancelled) {
          throw new DOMException("Pi prompt was cancelled before the native runtime started.", "AbortError");
        }
        if (this.closingSessions.has(key)) throw new Error(`Pi session ${request.sessionId} is closing.`);
        if (this.active.get(key)?.running || this.active.get(key)?.compacting) {
          throw new Error("Pi session is already running. Use Steer or Follow-up.");
        }
        const prepared = await this.prepareRuntime(request);
        if (reservation.cancelled) {
          throw new DOMException("Pi prompt was cancelled before the native runtime started.", "AbortError");
        }
        const active = this.commitPreparedRuntime(key, prepared);
        const operation: PromptOperation = {
          generation: ++this.nextPromptGeneration,
          cancelled: false
        };
        active.promptOperation = operation;
        active.running = true;
        active.phase = "turn";
        active.error = undefined;
        await active.persistHostState();
        this.emitActiveState(active);

        this.launchNativeInput(active, request.prompt, operation, request.images);

        return { accepted: true, sessionId: active.sessionId };
      });
    } finally {
      if (this.sessionOperationReservations.get(key) === reservation) this.sessionOperationReservations.delete(key);
    }
  }

  async compact(request: PiSessionCompactRequest): Promise<PiSessionCompactionResult> {
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
          throw new DOMException("Pi compaction was cancelled before the native runtime started.", "AbortError");
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
    await this.withSessionTransition(workspaceDir, sessionId, async () => {
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
    const key = sessionKey(workspaceDir, sessionId);
    const reservation = this.sessionOperationReservations.get(key);
    if (reservation) reservation.cancelled = true;
    let subagents: YnSubagentSupervisor | undefined;
    await this.withSessionTransition(workspaceDir, sessionId, async () => {
      const active = this.active.get(key);
      if (active?.compacting) throw new Error("Native Pi compaction is already in progress and cannot be stopped.");
      subagents = active?.subagents;
      if (active) {
        active.childCompletionGeneration += 1;
        this.suspendDomainRun(active);
        await active.persistHostState();
      }
      subagents?.abortAll();
      if (active?.running) await this.abortActiveSession(active);
      if (active) await active.persistHostState({ force: true });
    });
    await subagents?.waitForAll();
  }

  private async abortActiveSession(active: ActiveSession): Promise<void> {
    const promptOperation = active.promptOperation;
    if (promptOperation) promptOperation.cancelled = true;
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
    let supervisors: YnSubagentSupervisor[] = [];
    await this.withTransitions(
      this.workspaceSessionResources(workspaceDir, sessionIds),
      async () => { supervisors = await this.abortWorkspaceSessions(workspaceDir, sessionIds); }
    );
    await Promise.all(supervisors.map((supervisor) => supervisor.waitForAll()));
  }

  async disposeWorkspace(workspaceDir: string): Promise<void> {
    this.cancelWorkspaceOperationReservations(workspaceDir);
    const sessionIds = this.workspaceSessionIds(workspaceDir);
    let supervisors: YnSubagentSupervisor[] = [];
    await this.withTransitions(this.workspaceSessionResources(workspaceDir, sessionIds), async () => {
      supervisors = await this.abortWorkspaceSessions(workspaceDir, sessionIds);
    });
    await Promise.all(supervisors.map((supervisor) => supervisor.waitForAll()));
    await this.withTransitions(this.workspaceSessionResources(workspaceDir, sessionIds), async () => {
      const prefix = `${workspaceKey(workspaceDir)}::`;
      const sessions = [...this.active.entries()].filter(([key]) => key.startsWith(prefix));
      for (const [key, active] of sessions) {
        active.unsubscribe();
        active.runtime.dispose();
        this.active.delete(key);
        this.events.delete(key);
      }
    });
  }

  private async prepareRuntime(
    request: PiSessionPromptRequest,
    purpose: "prompt" | "compaction" = "prompt"
  ): Promise<PreparedRuntime> {
    const key = sessionKey(request.outputDir, request.sessionId);
    const previous = this.active.get(key);
    if (previous?.running || previous?.compacting) {
      throw new Error("Pi session is already running. Use Steer or Follow-up.");
    }
    const queuedCarryover = previous ? orderedQueuedMessages(previous).map((entry) => entry.message) : [];
    const repository = new PiSessionRepository(request.outputDir);
    const session = await repository.open(request.sessionId);
    const persistedHostState = await loadYnSessionHostState(session, request.sessionId);
    const selection = await (this.options.createModelSelection ?? createPiModelSelection)({
      workspaceDir: request.outputDir,
      providerId: request.providerId,
      modelId: request.modelId
    });
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
        && runtimeRequest.workflowIntent === "translation"
        && runtimeRequest.glossaryCandidates === true
        && !runtimeRequest.glossaryPath?.trim(),
      characterBible: explicitFullWorkflow
        && runtimeRequest.workflowIntent === "translation"
        && runtimeRequest.characterBible === true
    };
    // A new explicit user delegation owns a new local task contract. A repeated
    // generated workflow for the same kind and Pi session resumes its incomplete
    // Host contract; selecting New creates the clean task boundary.
    const restoreDomainRun = (snapshot: YnDomainRunSnapshot): YnDomainRunContract => createYnDomainRunContract({
      workflowIntent: snapshot.activeKind ?? runtimeRequest.workflowIntent,
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
      ? runtimeRequest.workflowIntent
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
    const continuedDomainRun = continuingBackgroundOperation
      ? resumableCandidate
      : resumableCandidate?.fullWorkflow && resumableCandidate.incompleteReasons().length > 0
        ? resumableCandidate
        : undefined;
    let domainRun = purpose === "prompt" && this.options.enforceDomainCompletion
      ? continuedDomainRun ?? createYnDomainRunContract({
        workflowIntent: runtimeRequest.workflowIntent,
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
    const hostState = {
      domainRun,
      parkedDomainRuns,
      workflowSuspended: Boolean(inheritedSuspension),
      proofread: proofreadState,
      translationAlignment: translationAlignmentState
    };
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
          createModelSelection: this.options.createModelSelection ?? createPiModelSelection
        });
    const appendHostState = this.options.appendHostState ?? appendYnSessionHostState;
    let runtime: PiSessionAgentRuntime | undefined;
    let activeRuntime: ActiveSession | undefined;
    let lastPersisted = persistedHostState ? JSON.stringify(persistedHostState) : undefined;
    let persistenceTail = Promise.resolve();
    const persistHostState = (options: { force?: boolean } = {}): Promise<void> => {
      const state = {
        schemaVersion: 1 as const,
        ownerSessionId: request.sessionId,
        ...(hostState.domainRun ? { domainRun: hostState.domainRun.snapshot() } : {}),
        ...(Object.keys(hostState.parkedDomainRuns).length > 0
          ? { parkedDomainRuns: hostState.parkedDomainRuns }
          : {}),
        ...(hostState.workflowSuspended ? { workflowSuspended: true } : {}),
        proofread: hostState.proofread,
        translationAlignment: hostState.translationAlignment
      };
      const serialized = JSON.stringify(state);
      if (!options.force && serialized === lastPersisted) return persistenceTail;
      const write = persistenceTail
        .catch(() => undefined)
        .then(async () => {
          if (!options.force && serialized === lastPersisted) return;
          await appendHostState(session, state, {
            ...options,
            ...(runtime ? {
              appendCustomEntry: (customType, data) => runtime!.appendCustomEntry(customType, data)
            } : {})
          });
          lastPersisted = serialized;
        });
      persistenceTail = write;
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
      isWorkflowSuspended: () => hostState.workflowSuspended || hasParkedWorkflow(),
      resumeWorkflow: async () => {
        const previousDomainRun = domainRun;
        const previousHostDomainRun = hostState.domainRun;
        const previousToolDomainRun = toolContext.domainRun;
        const previousWorkflowSuspended = hostState.workflowSuspended;
        let suspendedRun = hostState.workflowSuspended ? hostState.domainRun : undefined;
        let parkedKind: YnWorkflowKind | undefined;
        let parkedSnapshot: YnDomainRunSnapshot | undefined;
        if (!suspendedRun) {
          const parked = Object.entries(hostState.parkedDomainRuns)
            .filter((entry): entry is [YnWorkflowKind, YnDomainRunSnapshot] => (
              (entry[0] === "translation" || entry[0] === "proofread")
              && entry[1]?.fullWorkflowActive === true
            ));
          const latest = parked.at(-1);
          if (!latest) return;
          parkedKind = latest[0];
          parkedSnapshot = latest[1];
          suspendedRun = restoreDomainRun(parkedSnapshot);
        }
        const suspendedSnapshot = suspendedRun.snapshot();
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
          await persistHostState();
        } catch (error) {
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
          throw error;
        }
      }
    };
    if (autoResumeStoppedWorkflow) {
      // A new typed workflow prompt is explicit continuation authorization.
      // Reuse the transactional Host resume path before the model can falsely
      // report a stopped batch as active. Recovery pauses remain tool-gated.
      await toolContext.resumeWorkflow?.();
    }
    const rawTools = purpose === "prompt" ? await this.options.createTools?.(toolContext) ?? [] : [];
    const tools = rawTools.map((tool) => {
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        execute: (async (...args: Parameters<typeof execute>) => {
          try {
            return await execute(...args);
          } finally {
            await persistHostState();
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
    const systemPrompt = await this.options.buildSystemPrompt?.(promptRequest, {
      fullWorkflow: domainRun?.fullWorkflow ?? fullWorkflow,
      workflowSuspended: hostState.workflowSuspended || hasParkedWorkflow(),
      domainRun
    }) ?? GENERIC_SYSTEM_PROMPT;
    runtime = new PiSessionAgentRuntime({
      session,
      sessionId: request.sessionId,
      models: selection.models,
      model: selection.model,
      thinkingLevel: normalizeThinkingLevel(selection.model, request.thinkingLevel),
      systemPrompt,
      tools,
      deferThresholdCompaction: () => subagents.hasRunning()
    });
    const active: ActiveSession = {
      workspaceDir: path.resolve(request.outputDir),
      sessionId: request.sessionId,
      runtime,
      session,
      unsubscribe: () => {},
      sequence: previous?.sequence ?? 0,
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
    return { active, previous, retirePreviousSubagents };
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

  private requireRunning(workspaceDir: string, sessionId: string): ActiveSession {
    const active = this.active.get(sessionKey(workspaceDir, sessionId));
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
      active.running = false;
      active.phase = "idle";
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
          if (active.runtime.acceptsQueuedInput()) {
            consumptionTask = active.runtime.followUpMessageAndWaitForConsumption(message);
          }
          return;
        }
        const operation: PromptOperation = {
          generation: ++this.nextPromptGeneration,
          cancelled: false
        };
        active.promptOperation = operation;
        active.running = true;
        active.phase = "turn";
        active.error = undefined;
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
      const context = await active.session.buildContext();
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
      await active.runtime.prompt(input, { images });
      this.assertPromptOperation(active, operation);
      const incomplete = active.hostState.workflowSuspended || active.subagents.hasRunning()
        ? []
        : active.domainRun?.incompleteReasons() ?? [];
      if (!active.error && incomplete.length > 0 && active.domainRun?.awaitingUserInput !== true) {
        active.error = `YN workflow completion contract failed: ${incomplete.join("; ")}`;
      }
    } catch (error) {
      if (this.isCurrentPromptOperation(active, operation) && !operation.cancelled) {
        active.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (!this.isCurrentPromptOperation(active, operation) || operation.cancelled) return;
      active.running = false;
      active.phase = "idle";
      active.streamingMessage = null;
      try {
        await this.refreshContextUsage(active);
      } catch (error) {
        active.error = error instanceof Error ? error.message : String(error);
      }
      if (!this.isCurrentPromptOperation(active, operation) || operation.cancelled) return;
      active.promptOperation = undefined;
      this.emitActiveState(active);
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
    const messages = (await active.session.buildContext()).messages;
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
    return {
      sessionId: active.sessionId,
      sequence: active.sequence,
      running: active.running,
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
      error: active.error
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
      if (key.startsWith(prefix)) reservation.cancelled = true;
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
    return [...sessionIds];
  }

  private workspaceSessionResources(workspaceDir: string, sessionIds: string[]): string[] {
    return [
      this.workspaceTransitionResource(workspaceDir),
      ...sessionIds.map((sessionId) => this.sessionTransitionResource(workspaceDir, sessionId))
    ];
  }

  private async abortWorkspaceSessions(
    workspaceDir: string,
    sessionIds: string[]
  ): Promise<YnSubagentSupervisor[]> {
    const supervisors = new Set<YnSubagentSupervisor>();
    await Promise.all(sessionIds.map(async (sessionId) => {
      const active = this.active.get(sessionKey(workspaceDir, sessionId));
      if (active?.compactionTask) await active.compactionTask;
      if (active) {
        active.childCompletionGeneration += 1;
        this.suspendDomainRun(active);
        await active.persistHostState();
      }
      if (active?.subagents) {
        supervisors.add(active.subagents);
        active.subagents.abortAll();
      }
      if (active?.running) await this.abortActiveSession(active);
      if (active) await active.persistHostState({ force: true });
    }));
    return [...supervisors];
  }

  private suspendDomainRun(active: ActiveSession): void {
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
