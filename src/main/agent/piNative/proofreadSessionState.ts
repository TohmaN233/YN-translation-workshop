import { createHash } from "node:crypto";

import type { Session } from "@earendil-works/pi-agent-core/node";

import type { ProofreadPrescanSummary } from "./proofreadPrescan.ts";
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
export const YN_RUNTIME_CONTRACT_VERSION = 2;

type JsonPathPart = string | number;

interface JsonDeltaOperation {
  op: "set" | "delete";
  path: JsonPathPart[];
  value?: unknown;
}

interface HostStatePersistenceCursor {
  ownerSessionId: string;
  state: YnSessionHostState;
  stateHash: string;
  deltasSinceCheckpoint: number;
}

const hostStatePersistenceCursors = new WeakMap<object, HostStatePersistenceCursor>();
const hostStateLoadDiagnostics = new WeakMap<object, YnHostStateLoadDiagnostics>();
const HOST_STATE_CHECKPOINT_INTERVAL = 256;
const HOST_STATE_DELTA_CHECKPOINT_RATIO = 0.65;

export interface YnHostStateLoadDiagnostics {
  reconstructedStateCount: number;
  peakRetainedStateCount: number;
  skippedStaleWorkflowRevivalCount: number;
  migratedRuntimeContractFromVersion?: number;
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

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])
  );
}

function hostStateHash(state: YnSessionHostState): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(state))).digest("hex");
}

function createJsonDelta(
  previous: unknown,
  current: unknown,
  path: JsonPathPart[] = [],
  operations: JsonDeltaOperation[] = []
): JsonDeltaOperation[] {
  if (Object.is(previous, current)) return operations;
  if (Array.isArray(previous) && Array.isArray(current)) {
    if (previous.length !== current.length) {
      operations.push({ op: "set", path, value: current });
      return operations;
    }
    for (let index = 0; index < current.length; index += 1) {
      createJsonDelta(previous[index], current[index], [...path, index], operations);
    }
    return operations;
  }
  if (isRecord(previous) && isRecord(current)) {
    for (const key of Object.keys(previous)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        operations.push({ op: "delete", path: [...path, key] });
      }
    }
    for (const key of Object.keys(current)) {
      if (!Object.prototype.hasOwnProperty.call(previous, key)) {
        operations.push({ op: "set", path: [...path, key], value: current[key] });
      } else {
        createJsonDelta(previous[key], current[key], [...path, key], operations);
      }
    }
    return operations;
  }
  operations.push({ op: "set", path, value: current });
  return operations;
}

function applyJsonDelta(base: YnSessionHostState, operations: JsonDeltaOperation[]): YnSessionHostState {
  let root: unknown = cloneJson(base);
  for (const operation of operations) {
    if (operation.op !== "set" && operation.op !== "delete") {
      throw new Error("The persisted YN Host-state delta contains an unsupported operation.");
    }
    if (!Array.isArray(operation.path) || operation.path.some((part) => (
      typeof part !== "string" && (!Number.isInteger(part) || Number(part) < 0)
    ))) {
      throw new Error("The persisted YN Host-state delta contains an invalid path.");
    }
    if (operation.path.length === 0) {
      if (operation.op !== "set") throw new Error("The persisted YN Host-state delta cannot delete its root.");
      root = cloneJson(operation.value);
      continue;
    }
    let parent: unknown = root;
    for (const part of operation.path.slice(0, -1)) {
      if (Array.isArray(parent) && typeof part === "number") parent = parent[part];
      else if (isRecord(parent) && typeof part === "string") parent = parent[part];
      else throw new Error("The persisted YN Host-state delta path does not exist in its checkpoint.");
    }
    const leaf = operation.path.at(-1)!;
    if (Array.isArray(parent) && typeof leaf === "number") {
      if (operation.op === "delete") {
        throw new Error("The persisted YN Host-state delta cannot delete an array element.");
      }
      if (leaf < 0 || leaf >= parent.length) {
        throw new Error("The persisted YN Host-state delta array index is outside its checkpoint.");
      }
      parent[leaf] = cloneJson(operation.value);
    } else if (isRecord(parent) && typeof leaf === "string") {
      if (operation.op === "delete") delete parent[leaf];
      else parent[leaf] = cloneJson(operation.value);
    } else {
      throw new Error("The persisted YN Host-state delta path does not match its checkpoint.");
    }
  }
  if (!isRecord(root)) throw new Error("The persisted YN Host-state delta did not produce an object.");
  return root as unknown as YnSessionHostState;
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

export async function loadYnSessionHostState(
  session: Session,
  ownerSessionId: string
): Promise<YnSessionHostState | undefined> {
  const branch = await session.getBranch();
  let current: YnSessionHostState | undefined;
  let previous: YnSessionHostState | undefined;
  let beforePrevious: YnSessionHostState | undefined;
  let latestProofread: ProofreadHostState | undefined;
  let latestAlignment: TranslationAlignmentHostState | undefined;
  let reconstructedStateCount = 0;
  let peakRetainedStateCount = 0;
  let currentHash = "";
  let deltasSinceCheckpoint = 0;
  let currentRuntimeContractVersion = 1;
  const retain = (next: YnSessionHostState): void => {
    beforePrevious = previous;
    previous = current;
    current = next;
    if (!isEmptyProofreadState(next.proofread)) latestProofread = next.proofread;
    if (!isEmptyAlignmentState(next.translationAlignment)) latestAlignment = next.translationAlignment;
    reconstructedStateCount += 1;
    peakRetainedStateCount = Math.max(peakRetainedStateCount, new Set([
      current,
      previous,
      beforePrevious,
      latestProofread,
      latestAlignment
    ].filter(Boolean)).size);
  };
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === YN_HOST_STATE_CUSTOM_TYPE) {
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
    if (!isRecord(entry.data) || entry.data.schemaVersion !== 2) {
      throw new Error("The persisted YN Host-state checkpoint/delta has an unsupported schema.");
    }
    if (entry.data.ownerSessionId !== ownerSessionId) {
      throw new Error("The persisted YN Host state belongs to a different Pi session.");
    }
    const entryRuntimeContractVersion = runtimeContractVersion(entry.data);
    if (entryRuntimeContractVersion < currentRuntimeContractVersion) {
      throw new Error("The persisted YN Host-state runtime contract version moved backwards.");
    }
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
      applyJsonDelta(current, entry.data.operations as JsonDeltaOperation[]),
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
  hostStateLoadDiagnostics.set(session as object, {
    reconstructedStateCount,
    peakRetainedStateCount,
    skippedStaleWorkflowRevivalCount,
    ...(migratedRuntimeContractFromVersion
      ? { migratedRuntimeContractFromVersion }
      : {})
  });
  if (current) {
    hostStatePersistenceCursors.set(session as object, {
      ownerSessionId,
      state: cloneJson(current),
      stateHash: currentHash,
      deltasSinceCheckpoint
    });
  } else {
    hostStatePersistenceCursors.delete(session as object);
  }
  if (!current) return undefined;
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
  if (!migratedRuntimeContractFromVersion) return loaded;

  const migrated = migrateLegacyRuntimeContract(loaded);
  await appendYnSessionHostState(session, migrated, { force: true });
  return migrated;
}

export async function appendYnSessionHostState(
  session: Session,
  state: YnSessionHostState,
  options: AppendYnSessionHostStateOptions = {}
): Promise<void> {
  const normalized = normalizeYnSessionHostState(cloneJson(state), state.ownerSessionId);
  const stateHash = hostStateHash(normalized);
  const cursor = hostStatePersistenceCursors.get(session as object);
  if (cursor && cursor.ownerSessionId !== normalized.ownerSessionId) {
    throw new Error("Cannot append YN Host state for a different Pi session owner.");
  }
  if (!options.force && cursor?.stateHash === stateHash) return;
  const checkpoint = {
    schemaVersion: 2 as const,
    runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
    ownerSessionId: normalized.ownerSessionId,
    mode: "checkpoint" as const,
    stateHash,
    state: normalized
  };
  let entry: Record<string, unknown> = checkpoint;
  let nextDeltaCount = 0;
  if (!options.force && cursor && cursor.deltasSinceCheckpoint < HOST_STATE_CHECKPOINT_INTERVAL) {
    const operations = createJsonDelta(cursor.state, normalized);
    const delta = {
      schemaVersion: 2 as const,
      runtimeContractVersion: YN_RUNTIME_CONTRACT_VERSION,
      ownerSessionId: normalized.ownerSessionId,
      mode: "delta" as const,
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
    await session.appendCustomEntry(YN_HOST_STATE_DELTA_CUSTOM_TYPE, entry);
  }
  hostStatePersistenceCursors.set(session as object, {
    ownerSessionId: normalized.ownerSessionId,
    state: normalized,
    stateHash,
    deltasSinceCheckpoint: nextDeltaCount
  });
}

export { createTranslationAlignmentHostState };
