import {
  appendSessionCustomEntry,
  getDiskSessionAccess,
  PI_SESSION_BRANCH
} from "./sessionAccess.ts";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { StorageBackedSession, type Entry, type JsonlSessionMetadata, type Session } from "@earendil-works/pi-agent-core/node";
import { decodeProjectPaths, encodeProjectPaths } from "../../projectPaths.ts";
import {
  applyJsonDelta,
  createJsonDelta,
  hostStateHash,
  validateJsonDeltaOperations,
  type JsonDeltaOperation
} from "./hostStateDelta.ts";

import type { ProofreadPrescanSummary } from "./proofreadPrescan.ts";
import { normalizeTaskPreparationState, type YnTaskPreparationState } from "./taskPreparation.ts";
import {
  type YnDomainRunSnapshot,
  type YnWorkflowKind
} from "./domainRunContract.ts";
import {
  createTranslationAlignmentHostState,
  normalizeTranslationAlignmentState,
  type TranslationAlignmentHostState
} from "./translationAlignmentState.ts";

export const YN_HOST_STATE_CUSTOM_TYPE = "yn.host-state.v1";
export const YN_HOST_STATE_DELTA_CUSTOM_TYPE = "yn.host-state.v2";
export const YN_HOST_STATE_DELTA_SCHEMA_VERSION = 3;
export const YN_RUNTIME_CONTRACT_VERSION = 2;

const hostStatePersistenceCursors = new WeakMap<object, YnHostStateReplayCursor>();
const hostStateLoadDiagnostics = new WeakMap<object, YnHostStateLoadDiagnostics>();
const HOST_STATE_CHECKPOINT_INTERVAL = 256;
const HOST_STATE_DELTA_CHECKPOINT_RATIO = 0.65;

export interface YnHostStateLoadDiagnostics {
  reconstructedStateCount: number;
  peakRetainedStateCount: number;
  skippedStaleWorkflowRevivalCount: number;
  migratedRuntimeContractFromVersion?: number;
  elapsedMs: number;
  maxReplayStepMs: number;
  replayThread?: "main" | "worker";
}

export interface YnHostStateReplayProgress {
  processedEntries: number;
  totalEntries: number;
}

export interface YnHostStateReplayCursor {
  ownerSessionId: string;
  state: YnSessionHostState;
  stateHash: string;
  deltasSinceCheckpoint: number;
}

export interface YnHostStateReplayResult {
  state?: YnSessionHostState;
  cursor?: YnHostStateReplayCursor;
  diagnostics: YnHostStateLoadDiagnostics;
}

export interface YnHostStateLoadOptions {
  projectRoot?: string;
  throwIfCancelled?: () => void;
  onReplayProgress?: (processedEntries: number, totalEntries: number) => void;
}

export function getYnHostStateLoadDiagnostics(session: Session): YnHostStateLoadDiagnostics | undefined {
  const diagnostics = hostStateLoadDiagnostics.get(session as object);
  return diagnostics ? { ...diagnostics } : undefined;
}

export interface PersistedProofreadPrescan {
  inputHash: string;
  translationPath: string;
  summary: ProofreadPrescanSummary;
}

export interface ProofreadGlossaryCandidateState {
  id: string;
  source: string;
  target: string;
  category: "proper_noun" | "character" | "organization" | "place" | "title" | "setting_term";
  evidenceLine: number;
  rationale: string;
  aliases?: string[];
  status: "pending" | "accepted" | "rejected";
  decisionRationale?: string;
}

export interface ProofreadDocumentHostState {
  prescan?: PersistedProofreadPrescan;
  sampledLines: number[];
  reportInitialized: boolean;
  completedSplitScopes: ProofreadCompletedSplitScope[];
  glossaryCandidates: ProofreadGlossaryCandidateState[];
}

export interface ProofreadCompletedSplitScope {
  inputHash: string;
  translationPath: string;
  fromLine: number;
  toLine: number;
}

export interface ProofreadHostState {
  schemaVersion: 1;
  documents: Record<string, ProofreadDocumentHostState>;
  localScopes: Record<string, ProofreadLocalScopeState>;
}

export interface ProofreadLocalScopeState {
  id: string;
  documentId: string;
  inputHash: string;
  translationPath: string;
  fromLine: number;
  toLine: number;
}

export interface YnSessionHostState {
  taskPreparation?: YnTaskPreparationState;
  schemaVersion: 1;
  ownerSessionId: string;
  domainRun?: YnDomainRunSnapshot;
  parkedDomainRuns?: Partial<Record<YnWorkflowKind, YnDomainRunSnapshot>>;
  workflowSuspended?: boolean;
  proofread: ProofreadHostState;
  translationAlignment: TranslationAlignmentHostState;
}

export interface AppendYnSessionHostStateOptions {
  force?: boolean;
  projectRoot?: string;
  appendCustomEntry?: (customType: string, data: unknown) => Promise<void>;
}

export function createProofreadHostState(): ProofreadHostState {
  return { schemaVersion: 1, documents: {}, localScopes: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
}

function normalizeProofreadState(value: unknown): ProofreadHostState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.documents)) {
    return createProofreadHostState();
  }
  const documents: Record<string, ProofreadDocumentHostState> = {};
  for (const [documentId, raw] of Object.entries(value.documents)) {
    if (!documentId.trim() || !isRecord(raw)) continue;
    const sampledLines = Array.isArray(raw.sampledLines)
      ? [...new Set(raw.sampledLines.filter((line): line is number => Number.isInteger(line) && line > 0))]
          .sort((left, right) => left - right)
      : [];
    let prescan: PersistedProofreadPrescan | undefined;
    if (
      isRecord(raw.prescan)
      && typeof raw.prescan.inputHash === "string"
      && typeof raw.prescan.translationPath === "string"
      && isRecord(raw.prescan.summary)
    ) {
      prescan = raw.prescan as unknown as PersistedProofreadPrescan;
    }
    const glossaryCandidates = Array.isArray(raw.glossaryCandidates)
      ? raw.glossaryCandidates.filter((candidate): candidate is ProofreadGlossaryCandidateState => {
          if (!isRecord(candidate)) return false;
          return typeof candidate.id === "string" && Boolean(candidate.id.trim())
            && typeof candidate.source === "string" && Boolean(candidate.source.trim())
            && typeof candidate.target === "string" && Boolean(candidate.target.trim())
            && ["proper_noun", "character", "organization", "place", "title", "setting_term"].includes(String(candidate.category))
            && Number.isInteger(candidate.evidenceLine) && Number(candidate.evidenceLine) > 0
            && typeof candidate.rationale === "string" && Boolean(candidate.rationale.trim())
            && ["pending", "accepted", "rejected"].includes(String(candidate.status))
            && (candidate.aliases === undefined || (Array.isArray(candidate.aliases)
              && candidate.aliases.every((alias) => typeof alias === "string" && Boolean(alias.trim()))))
            && (candidate.decisionRationale === undefined || typeof candidate.decisionRationale === "string");
        }).map((candidate) => ({
          ...candidate,
          aliases: candidate.aliases ? [...new Set(candidate.aliases)] : undefined
        }))
      : [];
    const completedSplitScopes = Array.isArray(raw.completedSplitScopes)
      ? raw.completedSplitScopes.filter((scope): scope is ProofreadCompletedSplitScope => (
          isRecord(scope)
          && typeof scope.inputHash === "string"
          && Boolean(scope.inputHash.trim())
          && typeof scope.translationPath === "string"
          && Boolean(scope.translationPath.trim())
          && Number.isInteger(scope.fromLine)
          && Number(scope.fromLine) > 0
          && Number.isInteger(scope.toLine)
          && Number(scope.toLine) >= Number(scope.fromLine)
        )).map((scope) => ({ ...scope }))
          .sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine)
      : [];
    documents[documentId] = {
      sampledLines,
      reportInitialized: raw.reportInitialized === true,
      completedSplitScopes,
      glossaryCandidates,
      ...(prescan ? { prescan } : {})
    };
  }
  const localScopes: Record<string, ProofreadLocalScopeState> = {};
  if (isRecord(value.localScopes)) {
    for (const [scopeId, raw] of Object.entries(value.localScopes)) {
      if (!scopeId.trim() || !isRecord(raw)) continue;
      if (
        raw.id !== scopeId
        || typeof raw.documentId !== "string"
        || typeof raw.inputHash !== "string"
        || typeof raw.translationPath !== "string"
        || !Number.isInteger(raw.fromLine)
        || !Number.isInteger(raw.toLine)
        || Number(raw.fromLine) < 1
        || Number(raw.toLine) < Number(raw.fromLine)
      ) continue;
      localScopes[scopeId] = raw as unknown as ProofreadLocalScopeState;
    }
  }
  return { schemaVersion: 1, documents, localScopes };
}

export function proofreadDocumentHostState(
  state: ProofreadHostState,
  documentId: string
): ProofreadDocumentHostState {
  const id = documentId.trim();
  if (!id) throw new Error("A document ID is required for persisted proofreading state.");
  return state.documents[id] ??= {
    sampledLines: [],
    reportInitialized: false,
    completedSplitScopes: [],
    glossaryCandidates: []
  };
}

function normalizeYnSessionHostState(value: unknown, ownerSessionId: string): YnSessionHostState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("The persisted YN Host state has an unsupported schema.");
  }
  if (value.ownerSessionId !== ownerSessionId) {
    throw new Error("The persisted YN Host state belongs to a different Pi session.");
  }
  const parkedDomainRuns: Partial<Record<YnWorkflowKind, YnDomainRunSnapshot>> = {};
  if (isRecord(value.parkedDomainRuns)) {
    for (const kind of ["translation", "proofread"] as const) {
      const snapshot = value.parkedDomainRuns[kind];
      if (!isRecord(snapshot) || snapshot.activeKind !== kind) continue;
      parkedDomainRuns[kind] = snapshot as unknown as YnDomainRunSnapshot;
    }
  }
  return cloneJson({
    schemaVersion: 1,
    ownerSessionId,
    ...(isRecord(value.domainRun)
      ? { domainRun: value.domainRun as unknown as YnDomainRunSnapshot }
      : {}),
    ...(Object.keys(parkedDomainRuns).length > 0 ? { parkedDomainRuns } : {}),
    ...(value.workflowSuspended === true ? { workflowSuspended: true } : {}),
    ...(value.taskPreparation !== undefined ? { taskPreparation: normalizeTaskPreparationState(value.taskPreparation) } : {}),
    proofread: normalizeProofreadState(value.proofread),
    translationAlignment: normalizeTranslationAlignmentState(value.translationAlignment)
  });
}

function runtimeContractVersion(value: Record<string, unknown>): number {
  const version = value.runtimeContractVersion ?? 1;
  if (!Number.isInteger(version) || Number(version) < 1 || Number(version) > YN_RUNTIME_CONTRACT_VERSION) {
    throw new Error("The persisted YN Host-state runtime contract has an unsupported version.");
  }
  return Number(version);
}

function migrateLegacyRuntimeContract(state: YnSessionHostState): YnSessionHostState {
  const migrated = cloneJson(state);
  for (const scopes of Object.values(migrated.translationAlignment.ranges)) {
    for (const scope of scopes) {
      scope.checks = scope.checks.map((check) => check.verdict === "misaligned"
        ? check
        : {
            line: check.line,
            signals: [...check.signals]
          });
    }
  }
  return migrated;
}

const isEmptyProofreadState = (state: ProofreadHostState) => (
  Object.keys(state.documents).length === 0 && Object.keys(state.localScopes).length === 0
);

const isEmptyAlignmentState = (state: TranslationAlignmentHostState) => (
  Object.keys(state.documents).length === 0 && Object.keys(state.ranges).length === 0
);

const isEmptyHostState = (state: YnSessionHostState) => (
  !state.domainRun
  && Object.keys(state.parkedDomainRuns ?? {}).length === 0
  && isEmptyProofreadState(state.proofread)
  && isEmptyAlignmentState(state.translationAlignment)
);

/**
 * Host-state replay ignores unrelated custom entries. Fetch the two versioned
 * Host types in bounded pages, merge by durable sequence, and advance one
 * shared cursor so interleaved audit entries never change chain ordering.
 */
async function* iterateHostStateEntries(session: Session): AsyncGenerator<Entry> {
  const branch = await session.branch(PI_SESSION_BRANCH, BACKGROUND_CONTEXT);
  if (!branch) return;
  let cursor: { seq: number } | undefined;
  while (true) {
    const [legacy, deltas] = await Promise.all([
      branch.findEntries({ type: "custom", customType: YN_HOST_STATE_CUSTOM_TYPE, order: "oldestFirst", limit: 16, cursor }, BACKGROUND_CONTEXT),
      branch.findEntries({ type: "custom", customType: YN_HOST_STATE_DELTA_CUSTOM_TYPE, order: "oldestFirst", limit: 16, cursor }, BACKGROUND_CONTEXT)
    ]);
    const page = [...legacy, ...deltas].sort((left, right) => left.seq - right.seq).slice(0, 16);
    if (!page.length) return;
    for (const entry of page) yield entry;
    cursor = { seq: page[page.length - 1]!.seq };
  }
}

export async function replayYnSessionHostState(
  session: Session,
  ownerSessionId: string,
  options: YnHostStateLoadOptions = {}
): Promise<YnHostStateReplayResult> {
  const started = performance.now();
  options.throwIfCancelled?.();
  let current: YnSessionHostState | undefined;
  let previous: YnSessionHostState | undefined;
  let beforePrevious: YnSessionHostState | undefined;
  let latestProofread: ProofreadHostState | undefined;
  let latestAlignment: TranslationAlignmentHostState | undefined;
  let reconstructedStateCount = 0;
  let peakRetainedStateCount = 0;
  let currentHash = "";
  let relativePaths = false;
  let latestProofreadRelativePaths = false;
  let latestAlignmentRelativePaths = false;
  let deltasSinceCheckpoint = 0;
  let currentRuntimeContractVersion = 1;
  let replayStepStarted = performance.now();
  let maxReplayStepMs = 0;
  let processedEntries = 0;
  let lastProgressAt = Date.now();
  const reportProgress = (force = false): void => {
    if (!force && Date.now() - lastProgressAt < 250) return;
    options.onReplayProgress?.(processedEntries, 0);
    lastProgressAt = Date.now();
  };
  const retain = (next: YnSessionHostState): void => {
    beforePrevious = previous;
    previous = current;
    current = next;
    if (!isEmptyProofreadState(next.proofread)) { latestProofread = next.proofread; latestProofreadRelativePaths = relativePaths; }
    if (!isEmptyAlignmentState(next.translationAlignment)) { latestAlignment = next.translationAlignment; latestAlignmentRelativePaths = relativePaths; }
    reconstructedStateCount += 1;
    peakRetainedStateCount = Math.max(peakRetainedStateCount, new Set([
      current,
      previous,
      beforePrevious,
      latestProofread,
      latestAlignment
    ].filter(Boolean)).size);
  };
  for await (const entry of iterateHostStateEntries(session)) {
    processedEntries += 1;
    reportProgress();
    if (entry.type !== "custom") continue;
    if (entry.customType !== YN_HOST_STATE_CUSTOM_TYPE && entry.customType !== YN_HOST_STATE_DELTA_CUSTOM_TYPE) continue;
    // A cold replay must verify every durable state, but the historical chain
    // must not monopolize Electron's IPC/UI thread for its entire duration.
    maxReplayStepMs = Math.max(maxReplayStepMs, performance.now() - replayStepStarted);
    await yieldToEventLoop();
    options.throwIfCancelled?.();
    replayStepStarted = performance.now();
    if (entry.customType === YN_HOST_STATE_CUSTOM_TYPE) {
      relativePaths = false;
      if (current && currentRuntimeContractVersion >= YN_RUNTIME_CONTRACT_VERSION) {
        throw new Error("The persisted YN Host-state runtime contract version moved backwards.");
      }
      const next = normalizeYnSessionHostState(entry.data, ownerSessionId);
      currentHash = hostStateHash(next);
      deltasSinceCheckpoint = 0;
      currentRuntimeContractVersion = 1;
      retain(next);
      continue;
    }
    if (entry.customType !== YN_HOST_STATE_DELTA_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data) || (entry.data.schemaVersion !== 2 && entry.data.schemaVersion !== 3)) {
      throw new Error("The persisted YN Host-state checkpoint/delta has an unsupported schema.");
    }
    const deltaSchemaVersion = entry.data.schemaVersion;
    if (entry.data.ownerSessionId !== ownerSessionId) {
      throw new Error("The persisted YN Host state belongs to a different Pi session.");
    }
    const entryRuntimeContractVersion = runtimeContractVersion(entry.data);
    if (entryRuntimeContractVersion < currentRuntimeContractVersion) {
      throw new Error("The persisted YN Host-state runtime contract version moved backwards.");
    }
    relativePaths = entry.data.projectPathsVersion === 1;
    if (entry.data.mode === "checkpoint") {
      const next = normalizeYnSessionHostState(entry.data.state, ownerSessionId);
      currentHash = hostStateHash(next);
      if (entry.data.stateHash !== currentHash) {
        throw new Error("The persisted YN Host-state checkpoint hash does not match its state.");
      }
      deltasSinceCheckpoint = 0;
      currentRuntimeContractVersion = entryRuntimeContractVersion;
      retain(next);
      continue;
    }
    if (entry.data.mode !== "delta" || !Array.isArray(entry.data.operations)) {
      throw new Error("The persisted YN Host-state delta is invalid.");
    }
    if (!current || entry.data.baseHash !== currentHash) {
      throw new Error(
        `The persisted YN Host-state delta ${entry.id} does not match its preceding checkpoint `
        + `(expected ${currentHash || "none"}, received ${String(entry.data.baseHash || "none")}).`
      );
    }
    const next = normalizeYnSessionHostState(
      applyJsonDelta(current, entry.data.operations as JsonDeltaOperation[], deltaSchemaVersion),
      ownerSessionId
    );
    currentHash = hostStateHash(next);
    if (entry.data.stateHash !== currentHash) {
      throw new Error("The persisted YN Host-state delta hash does not match its reconstructed state.");
    }
    deltasSinceCheckpoint += 1;
    currentRuntimeContractVersion = entryRuntimeContractVersion;
    retain(next);
  }
  // A newer local/bounded contract is authoritative even when an old Stop
  // tombstone and full-workflow snapshot remain immediately behind it.
  const skippedStaleWorkflowRevivalCount = (
    current?.domainRun?.fullWorkflowActive !== true
    && current?.workflowSuspended !== true
    && previous !== undefined
    && isEmptyHostState(previous)
    && beforePrevious?.domainRun?.fullWorkflowActive === true
  ) ? 1 : 0;
  const migratedRuntimeContractFromVersion = current && currentRuntimeContractVersion < YN_RUNTIME_CONTRACT_VERSION
    ? currentRuntimeContractVersion
    : undefined;
  options.throwIfCancelled?.();
  reportProgress(true);
  const diagnostics: YnHostStateLoadDiagnostics = {
    reconstructedStateCount,
    peakRetainedStateCount,
    skippedStaleWorkflowRevivalCount,
    elapsedMs: performance.now() - started,
    maxReplayStepMs: Math.max(maxReplayStepMs, performance.now() - replayStepStarted),
    ...(migratedRuntimeContractFromVersion
      ? { migratedRuntimeContractFromVersion }
      : {})
  };
  const cursor = current ? {
      ownerSessionId,
      state: cloneJson(current),
      stateHash: currentHash,
      deltasSinceCheckpoint
    } : undefined;
  if (!current) return { diagnostics };
  const loaded = current.domainRun
    || !isEmptyProofreadState(current.proofread)
    || !isEmptyAlignmentState(current.translationAlignment)
    ? current
    : {
        // Releases before 2.0.0 used an empty Host-state entry as a Stop tombstone.
        // Recover only the latest hash-bound evidence while retaining a constant-size
        // history window instead of every reconstructed full state.
        ...current,
        proofread: latestProofread ?? current.proofread,
        translationAlignment: latestAlignment ?? current.translationAlignment
      };
  const historicalRoot = (session.metadata as { cwd?: string }).cwd;
  const projectRoot = options.projectRoot ?? historicalRoot;
  const rebound = projectRoot ? {
    ...decodeProjectPaths(loaded, projectRoot, relativePaths ? undefined : historicalRoot),
    proofread: decodeProjectPaths(loaded.proofread, projectRoot, (loaded.proofread === latestProofread ? latestProofreadRelativePaths : relativePaths) ? undefined : historicalRoot),
    translationAlignment: decodeProjectPaths(loaded.translationAlignment, projectRoot, (loaded.translationAlignment === latestAlignment ? latestAlignmentRelativePaths : relativePaths) ? undefined : historicalRoot)
  } : loaded;
  return { state: rebound, ...(cursor ? { cursor } : {}), diagnostics };
}

const HOST_STATE_WORKER_THRESHOLD_BYTES = 1024 * 1024;

async function hasIndexedHostStateEntry(
  session: Session,
  disk: NonNullable<ReturnType<typeof getDiskSessionAccess>>
): Promise<boolean> {
  const branch = await session.branch(PI_SESSION_BRANCH, BACKGROUND_CONTEXT);
  const tipId = await branch?.getTipId(BACKGROUND_CONTEXT);
  if (!tipId) return false;
  for (const customType of [YN_HOST_STATE_CUSTOM_TYPE, YN_HOST_STATE_DELTA_CUSTOM_TYPE]) {
    const matches = await disk.storage.scanBranchStructure({
      start: tipId,
      order: "newestFirst",
      type: "custom",
      customType,
      limit: 1
    }, BACKGROUND_CONTEXT);
    if (matches.length) return true;
  }
  return false;
}

function replayError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object" && "message" in value) {
    const serialized = value as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
    const error = new Error(typeof serialized.message === "string" ? serialized.message : "Host-state replay worker failed.");
    if (typeof serialized.name === "string") error.name = serialized.name;
    if (typeof serialized.stack === "string") error.stack = serialized.stack;
    if (typeof serialized.code === "string") Object.assign(error, { code: serialized.code });
    return error;
  }
  return new Error(String(value));
}

interface HostStateReplayWorkerInput {
  path: string;
  metadata: JsonlSessionMetadata;
  ownerSessionId: string;
  projectRoot?: string;
}

function runHostStateReplayWorker(
  input: HostStateReplayWorkerInput,
  options: YnHostStateLoadOptions
): Promise<YnHostStateReplayResult> {
  options.throwIfCancelled?.();
  const workerUrl = new URL(import.meta.url.endsWith(".ts")
    ? "./sessionHostReplayWorker.ts"
    : "./sessionHostReplayWorker.js", import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: input,
    execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type") && !arg.startsWith("--expose-gc"))
  });
  return new Promise((resolve, reject) => {
    let result: YnHostStateReplayResult | undefined;
    let failure: unknown;
    let terminating = false;
    const failAndTerminate = (error: unknown): void => {
      if (failure === undefined) failure = error;
      if (terminating) return;
      terminating = true;
      void worker.terminate().catch((terminateError) => {
        failure = new AggregateError([failure, terminateError], "Host-state replay failed and its worker could not be terminated.");
      });
    };
    const cancellationPoll = setInterval(() => {
      try { options.throwIfCancelled?.(); }
      catch (error) { failAndTerminate(error); }
    }, 25);
    worker.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        failAndTerminate(new Error("Host-state replay worker sent an invalid message."));
        return;
      }
      const event = message as Record<string, unknown>;
      if (event.type === "progress") {
        try {
          const processedEntries = event.processedEntries;
          const totalEntries = event.totalEntries;
          if (!Number.isInteger(processedEntries) || Number(processedEntries) < 0
            || !Number.isInteger(totalEntries) || Number(totalEntries) < 0) {
            throw new Error("Host-state replay worker sent invalid progress.");
          }
          options.onReplayProgress?.(Number(processedEntries), Number(totalEntries));
        } catch (error) { failAndTerminate(error); }
      } else if (event.type === "result") {
        result = event.result as YnHostStateReplayResult;
      } else if (event.type === "failure") {
        failure = replayError(event.error);
      } else {
        failAndTerminate(new Error(`Host-state replay worker sent an unknown message type: ${String(event.type)}.`));
      }
    });
    worker.once("error", (error) => { failure ??= error; });
    worker.once("exit", (code) => {
      clearInterval(cancellationPoll);
      if (failure !== undefined) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Host-state replay worker exited without a result (code ${code}).`));
      else resolve(result);
    });
  });
}

function installReplayResult(session: Session, result: YnHostStateReplayResult): void {
  hostStateLoadDiagnostics.set(session as object, { ...result.diagnostics });
  if (result.cursor) hostStatePersistenceCursors.set(session as object, result.cursor);
  else hostStatePersistenceCursors.delete(session as object);
}

export async function loadYnSessionHostState(
  session: Session,
  ownerSessionId: string,
  options: YnHostStateLoadOptions = {}
): Promise<YnSessionHostState | undefined> {
  options.throwIfCancelled?.();
  const disk = getDiskSessionAccess(session);
  const fileSize = disk ? (await stat(disk.path)).size : 0;
  const hasHostState = disk && fileSize > HOST_STATE_WORKER_THRESHOLD_BYTES
    ? await hasIndexedHostStateEntry(session, disk)
    : false;
  let result: YnHostStateReplayResult;
  if (disk && hasHostState) {
    result = await session.mutate(async () => {
      options.throwIfCancelled?.();
      // This queued storage read checks the registered source identity before
      // the background worker takes over replay.
      await disk.storage.getStats(BACKGROUND_CONTEXT);
      options.throwIfCancelled?.();
      const workerResult = await runHostStateReplayWorker({
        path: disk.path,
        metadata: session.metadata as JsonlSessionMetadata,
        ownerSessionId,
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {})
      }, options);
      await disk.storage.getStats(BACKGROUND_CONTEXT);
      options.throwIfCancelled?.();
      workerResult.diagnostics.replayThread = "worker";
      installReplayResult(session, workerResult);
      return workerResult;
    }, BACKGROUND_CONTEXT);
  } else {
    result = await replayYnSessionHostState(session, ownerSessionId, options);
    result.diagnostics.replayThread = "main";
    installReplayResult(session, result);
  }
  if (!result.state) return undefined;
  if (!result.diagnostics.migratedRuntimeContractFromVersion) return result.state;

  const migrated = migrateLegacyRuntimeContract(result.state);
  await appendYnSessionHostState(session, migrated, { force: true, projectRoot: options.projectRoot });
  return migrated;
}

export async function appendYnSessionHostState(
  session: Session,
  state: YnSessionHostState,
  options: AppendYnSessionHostStateOptions = {}
): Promise<void> {
  const projectRoot = options.projectRoot ?? (session.metadata as { cwd?: string }).cwd;
  const normalized = normalizeYnSessionHostState(projectRoot ? encodeProjectPaths(cloneJson(state), projectRoot) : cloneJson(state), state.ownerSessionId);
  const stateHash = hostStateHash(normalized);
  const cursor = hostStatePersistenceCursors.get(session as object);
  if (cursor && cursor.ownerSessionId !== normalized.ownerSessionId) {
    throw new Error("Cannot append YN Host state for a different Pi session owner.");
  }
  if (!options.force && cursor?.stateHash === stateHash) return;
  const checkpoint = {
    schemaVersion: YN_HOST_STATE_DELTA_SCHEMA_VERSION,
    runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
    ownerSessionId: normalized.ownerSessionId,
    mode: "checkpoint" as const,
    ...(projectRoot ? { projectPathsVersion: 1 } : {}),
    stateHash,
    state: normalized
  };
  let entry: Record<string, unknown> = checkpoint;
  let nextDeltaCount = 0;
  if (!options.force && cursor && cursor.deltasSinceCheckpoint < HOST_STATE_CHECKPOINT_INTERVAL) {
    const operations = createJsonDelta(cursor.state, normalized);
    const delta = {
      schemaVersion: YN_HOST_STATE_DELTA_SCHEMA_VERSION,
      runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
      ownerSessionId: normalized.ownerSessionId,
      mode: "delta" as const,
      ...(projectRoot ? { projectPathsVersion: 1 } : {}),
      baseHash: cursor.stateHash,
      stateHash,
      operations
    };
    if (JSON.stringify(delta).length < JSON.stringify(checkpoint).length * HOST_STATE_DELTA_CHECKPOINT_RATIO) {
      entry = delta;
      nextDeltaCount = cursor.deltasSinceCheckpoint + 1;
    }
  }
  if (options.appendCustomEntry) {
    await options.appendCustomEntry(YN_HOST_STATE_DELTA_CUSTOM_TYPE, entry);
  } else {
    await appendSessionCustomEntry(session, YN_HOST_STATE_DELTA_CUSTOM_TYPE, entry);
  }
  hostStatePersistenceCursors.set(session as object, {
    ownerSessionId: normalized.ownerSessionId,
    state: normalized,
    stateHash,
    deltasSinceCheckpoint: nextDeltaCount
  });
}

export { createTranslationAlignmentHostState };
export { applyJsonDelta, createJsonDelta, hostStateHash, validateJsonDeltaOperations };
export type { JsonDeltaOperation };
