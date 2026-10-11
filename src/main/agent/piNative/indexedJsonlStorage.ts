import { open, stat, readFile, writeFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { createReadStream, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  BACKGROUND_CONTEXT, prepareStorageCommit, validateCommittedWrites, resolveListReadOptions, value,
  type Context, type Storage, type Write, type CommittedWrite, type Entry, type EntryStructure,
  type CommitResult, type SessionStats, type StorageBranchScan, type EntryScan, type UsageScan,
  type UsageRow, type Value, type StoredValue, type ValueList, type ListReadOptions, type ListElement,
} from "@earendil-works/pi-agent-core/node";
import { readJsonlRecords, parseNativeTransaction, TornJsonlTailError, type NativeJsonlHeader } from "./jsonlRecords.ts";
import type { HostRestorePoint } from "./hostRestorePoint.ts";
import { advanceHostRestorePoint } from "./hostRestorePoint.ts";
import type { YnSessionHostState } from "./proofreadSessionState.ts";
import { validateJsonDeltaOperations } from "./hostStateDelta.ts";

export interface JsonlSourceIdentity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
export interface JsonlWriteRef { offset: number; length: number; writeIndex: number; seq: number }
export interface IndexedHostMetadata { runtimeContractVersion: number; relativePaths: boolean; deltasSinceCheckpoint: number; stateHash?: string }
export type IndexedEntry = EntryStructure & JsonlWriteRef & { hostMetadata?: IndexedHostMetadata };
export interface IndexedValue { namespace: string; key: string; ref: JsonlWriteRef }
export interface IndexedList { namespace: string; key: string; refs: JsonlWriteRef[] }
export interface JsonlDiskIndex {
  version: 1; header: NativeJsonlHeader; identity: JsonlSourceIdentity; committedBytes: number;
  sourceFingerprint: string; entries: IndexedEntry[]; usage: (JsonlWriteRef & { id: string })[];
  values: IndexedValue[]; lists: IndexedList[]; stats: SessionStats; nextSeq: number;
  hostRestorePoint?: HostRestorePoint;
  hostMetadataVersion?: 2;
  verifiedHostHistory?: { version: 1; sourceFingerprint: string; committedBytes: number; throughSeq: number };
}
export interface JsonlIndexProgress { phase: "scan" | "cache-hit" | "rebuild" | "complete"; bytes?: number; totalBytes?: number; reason?: string }
export class JsonlSourceChangedError extends Error {
  readonly code = "PI_JSONL_SOURCE_CHANGED";
  constructor(path: string) { super(`Pi JSONL source changed outside its storage owner: ${path}; reopen required.`); this.name = "JsonlSourceChangedError"; }
}
export class JsonlAppendFailedError extends Error {
  readonly code = "PI_JSONL_APPEND_FAILED";
  constructor(path: string, cause?: unknown) { super(`Pi JSONL append failed in ${path}; writes are disabled until reopen.`, { cause }); this.name = "JsonlAppendFailedError"; }
}
const keyOf = (namespace: string, key: string) => `${namespace}\0${key}`;
export const sourceIdentity = (s: Stats): JsonlSourceIdentity => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
export const sameSourceIdentity = (a: JsonlSourceIdentity, b: JsonlSourceIdentity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
// Usage aggregation mirrors Pi 0.99.1 harness/utils/usage.ts (MIT, Earendil Works).
export function emptyIndexedUsage(): SessionStats["usage"] { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
export function addIndexedUsage(a: SessionStats["usage"], b: SessionStats["usage"]): SessionStats["usage"] {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheWrite1h === undefined && b.cacheWrite1h === undefined ? {} : { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) }),
    ...(a.reasoning === undefined && b.reasoning === undefined ? {} : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}
export function entryStructure(w: EntryStructure): EntryStructure { return { id: w.id, parentId: w.parentId, seq: w.seq, timestamp: w.timestamp, type: w.type, ...(w.customType === undefined ? {} : { customType: w.customType }) }; }
function decodedMemoryBudget(root: unknown): number {
  let bytes = 0;
  const pending: unknown[] = [root];
  while (pending.length) {
    const node = pending.pop();
    if (typeof node === "string") bytes += 32 + node.length * 2;
    else if (Array.isArray(node)) { bytes += 64 + node.length * 8; for (const child of node) pending.push(child); }
    else if (node !== null && typeof node === "object") {
      bytes += 64;
      for (const [key, child] of Object.entries(node)) { bytes += 48 + key.length * 2; pending.push(child); }
    } else bytes += 24;
  }
  return bytes;
}

const digestIndex = (index: JsonlDiskIndex) => createHash("sha256").update(JSON.stringify(index)).digest("hex");
export async function writeJsonlDiskIndex(path: string, index: JsonlDiskIndex): Promise<void> {
  const sidecar = `${path}.yn-index.json`, temp = `${sidecar}.${randomUUID()}.tmp`;
  try { await writeFile(temp,JSON.stringify({index,indexDigest:digestIndex(index)}),{flag:"wx"}); await rename(temp,sidecar); }
  catch(error) { try {await unlink(temp);} catch(cleanup) { if((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error,cleanup],"Pi index sidecar write and cleanup failed."); } throw error; }
}
async function fingerprint(path: string, totalBytes: number, context: Context, progress: (p: JsonlIndexProgress) => void, prefix?: {bytes:number;hash?:string}): Promise<string> {
  const hash = createHash("sha256"); let scanned = 0, lastProgress = Date.now();
  const prefixDigest = prefix ? createHash("sha256") : undefined;
  for await (const bytes of createReadStream(path, {highWaterMark: 1024 * 1024, signal: context.abortSignal})) {
    if (prefix && prefixDigest && scanned < prefix.bytes) prefixDigest.update(bytes.subarray(0,Math.min(bytes.length,prefix.bytes-scanned)));
    hash.update(bytes); scanned += bytes.length;
    if (Date.now() - lastProgress >= 250) { progress({phase:"scan",bytes:scanned,totalBytes}); lastProgress = Date.now(); }
  }
  if (prefix && prefixDigest) prefix.hash = prefixDigest.digest("hex");
  return hash.digest("hex");
}
function cacheShape(index: JsonlDiskIndex): boolean {
  return index?.version === 1 && index.header?.v === 4 && Array.isArray(index.entries) && Array.isArray(index.usage)
    && Array.isArray(index.values) && Array.isArray(index.lists) && Number.isSafeInteger(index.nextSeq)
    && index.nextSeq > 0 && index.committedBytes === index.identity?.size && typeof index.sourceFingerprint === "string" && index.hostMetadataVersion === 2;
}
export async function buildJsonlDiskIndex(path: string, context: Context = BACKGROUND_CONTEXT, progress: (p: JsonlIndexProgress) => void = () => {}): Promise<JsonlDiskIndex> {
  context.abortSignal?.throwIfAborted();
  const before = sourceIdentity(await stat(path)), sidecar = `${path}.yn-index.json`;
  let reason = "missing sidecar";
  let cached: {index: JsonlDiskIndex; indexDigest: string} | undefined;
  try { cached = JSON.parse(await readFile(sidecar,"utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) reason = "invalid sidecar JSON";
  }
  if (cached) {
    if (!cacheShape(cached.index) || digestIndex(cached.index) !== cached.indexDigest) reason = "invalid sidecar metadata or checksum";
    else if (!sameSourceIdentity(before,cached.index.identity)) reason = "source identity/size/mtime changed";
    else {
      let receipt: Record<string,any> | undefined;
      try {receipt=JSON.parse(await readFile(`${path}.storage-upgrade.json`,"utf8"));}
      catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;}
      const prefix = receipt?.version === 1 && receipt.status === "published" && receipt.verified === true && receipt.sessionId === cached.index.header.id
        && Number.isSafeInteger(receipt.compactedBytes) && receipt.compactedBytes > 0 && receipt.compactedBytes <= before.size ? {bytes:Number(receipt.compactedBytes),hash:undefined as string | undefined} : undefined;
      const actual = await fingerprint(path,before.size,context,progress,prefix);
      if (!sameSourceIdentity(before,sourceIdentity(await stat(path)))) throw new Error(`Pi JSONL source changed during fingerprint validation: ${path}`);
      if (actual === cached.index.sourceFingerprint) {
        if (cached.index.verifiedHostHistory && (!prefix || prefix.hash !== receipt!.compactedHash || cached.index.verifiedHostHistory.committedBytes !== prefix.bytes || cached.index.verifiedHostHistory.sourceFingerprint !== prefix.hash)) {
          delete cached.index.verifiedHostHistory;
          progress({phase:"scan",bytes:before.size,totalBytes:before.size,reason:"Host prefix certification invalidated: published receipt or native prefix does not match"});
        }
        progress({phase:"cache-hit",bytes:before.size,totalBytes:before.size});
        progress({phase:"complete",bytes:before.size,totalBytes:before.size});
        return cached.index;
      }
      reason = "source fingerprint changed";
    }
  }
  progress({phase:"rebuild",reason,totalBytes:before.size});
  const values = new Map<string,IndexedValue>(), lists = new Map<string,IndexedList>();
  const hostVersions = new Map<string, number>();
  const hostDeltaCounts = new Map<string,number>();
  let receipt: Record<string, any> | undefined;
  try { receipt = JSON.parse(await readFile(`${path}.storage-upgrade.json`,"utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  let certifiedPrefixHash: string | undefined;
  let certifiedThroughSeq = 0;
  const validCachedPrefix = cached && cacheShape(cached.index) && digestIndex(cached.index) === cached.indexDigest ? cached.index : undefined;
  let cachedPrefixHash: string | undefined;
  let index: JsonlDiskIndex | undefined; const hash = createHash("sha256"); let lastProgress = Date.now();
  for await (const r of readJsonlRecords(path,context)) {
    hash.update(r.bytes);
    if (r.kind === "header") {
      index = {version:1,hostMetadataVersion:2,header:r.header,identity:before,committedBytes:r.length,sourceFingerprint:"",entries:[],usage:[],values:[],lists:[],stats:{messageCount:0,usage:emptyIndexedUsage()},nextSeq:1};
    } else {
      const current = index!;
      r.writes.forEach((w,writeIndex) => {
        const ref = {offset:r.offset,length:r.length,writeIndex,seq:w.seq};
        switch (w.kind) {
          case "entry": {
            let version = w.parentId === null ? 1 : hostVersions.get(w.parentId) ?? 1;
            let deltaCount = w.parentId === null ? 0 : hostDeltaCounts.get(w.parentId) ?? 0;
            let metadata: IndexedHostMetadata | undefined;
            if (w.type === "custom" && ["yn.host-state.v1", "yn.host-state.v2"].includes(w.customType)) {
              const data = w.data as Record<string, any>;
              if (!data || typeof data !== "object" || data.ownerSessionId !== current.header.id) throw new Error(`Invalid Host state owner at entry ${w.id}.`);
              if (w.customType === "yn.host-state.v1") {
                if (data.schemaVersion !== 1 || version > 1) throw new Error(`Invalid or backwards Host runtime contract at entry ${w.id}.`);
                version = 1;
                deltaCount = 0;
              } else {
                const nextVersion = data.runtimeContractVersion ?? 1;
                if (![2,3].includes(data.schemaVersion) || !Number.isInteger(nextVersion) || nextVersion < version || nextVersion > 2) throw new Error(`Invalid or backwards Host runtime contract at entry ${w.id}.`);
                if (typeof data.stateHash !== "string") throw new Error(`Invalid Host state hash at entry ${w.id}.`);
                if (data.mode === "checkpoint") {
                  if (data.state?.schemaVersion !== 1 || data.state?.ownerSessionId !== current.header.id) throw new Error(`Invalid Host checkpoint state at entry ${w.id}.`);
                } else if (data.mode === "delta") {
                  if (typeof data.baseHash !== "string") throw new Error(`Invalid Host delta base at entry ${w.id}.`);
                  validateJsonDeltaOperations(data.operations,data.schemaVersion);
                } else throw new Error(`Invalid Host delta mode at entry ${w.id}.`);
                version = nextVersion;
                deltaCount = data.mode === "delta" ? deltaCount + 1 : 0;
              }
              metadata = {runtimeContractVersion:version,relativePaths:w.customType === "yn.host-state.v2" && data.projectPathsVersion === 1,deltasSinceCheckpoint:deltaCount,...(typeof data.stateHash === "string" ? {stateHash:data.stateHash} : {})};
            }
            hostVersions.set(w.id, version);
            hostDeltaCounts.set(w.id,deltaCount);
            current.entries.push({...entryStructure(w),...ref,...(metadata ? {hostMetadata:metadata} : {})}); if(w.type === "message") current.stats.messageCount++; break;
          }
          case "usage": current.usage.push({...ref,id:w.id}); current.stats.usage = addIndexedUsage(current.stats.usage,w.usage); break;
          case "value": if(w.op === "delete") values.delete(`${w.namespace}\0${w.key}`); else values.set(`${w.namespace}\0${w.key}`,{namespace:w.namespace,key:w.key,ref}); break;
          case "list": {
            const k = `${w.namespace}\0${w.key}`;
            if(w.op === "delete") lists.delete(k);
            else { const existing = lists.get(k); if(existing) existing.refs.push(ref); else lists.set(k,{namespace:w.namespace,key:w.key,refs:[ref]}); }
            break;
          }
        }
        current.nextSeq = w.seq + 1;
      });
      current.committedBytes = r.offset + r.length;
    }
    if (r.offset + r.length === receipt?.compactedBytes) { certifiedPrefixHash = hash.copy().digest("hex"); certifiedThroughSeq = index!.nextSeq - 1; }
    if (r.offset + r.length === validCachedPrefix?.committedBytes) cachedPrefixHash = hash.copy().digest("hex");
    if (Date.now() - lastProgress >= 250) {progress({phase:"scan",bytes:index!.committedBytes,totalBytes:before.size}); lastProgress = Date.now();}
  }
  if (!index) throw new Error(`Missing Pi JSONL header: ${path}`);
  context.abortSignal?.throwIfAborted();
  const after = sourceIdentity(await stat(path));
  if (!sameSourceIdentity(before,after) || index.committedBytes !== after.size) throw new Error(`Pi JSONL source changed during indexing: ${path}`);
  index.nextSeq = Math.max(index.nextSeq,index.header.nextSeq ?? 1);
  index.values = [...values.values()]; index.lists = [...lists.values()]; index.sourceFingerprint = hash.digest("hex");
  if (receipt?.version === 1 && receipt.status === "published" && receipt.verified === true && receipt.sessionId === index.header.id && receipt.compactedHash === certifiedPrefixHash) {
    index.verifiedHostHistory = {version:1,sourceFingerprint:certifiedPrefixHash!,committedBytes:receipt.compactedBytes,throughSeq:certifiedThroughSeq};
  }
  if (validCachedPrefix && validCachedPrefix.header.id === index.header.id && cachedPrefixHash === validCachedPrefix.sourceFingerprint && validCachedPrefix.hostRestorePoint) {
    index.hostRestorePoint = validCachedPrefix.hostRestorePoint;
    progress({phase:"scan",bytes:after.size,totalBytes:after.size,reason:"verified existing index prefix; appended Host tail requires replay"});
  }
  await writeJsonlDiskIndex(path,index);
  progress({phase:"complete",bytes:after.size,totalBytes:after.size}); return index;
}

async function indexInWorker(path: string, context: Context, onProgress?: (p: JsonlIndexProgress) => void): Promise<JsonlDiskIndex> {
  context.abortSignal?.throwIfAborted();
  const report = (p: JsonlIndexProgress) => { if (onProgress) onProgress(p); else if (p.phase === "rebuild" || p.reason) console.info("Pi JSONL index validation", {path,...p}); };
  // Scheduling threshold only: small sessions use the same async streaming builder without worker startup latency.
  const sourceSize = (await stat(path)).size;
  let sidecarSize = 0;
  try { sidecarSize = (await stat(`${path}.yn-index.json`)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  context.abortSignal?.throwIfAborted();
  if (sourceSize < 1024 * 1024 && sidecarSize < 1024 * 1024) return buildJsonlDiskIndex(path, context, report);
  const url = new URL(import.meta.url.endsWith(".ts") ? "./sessionIndexWorker.ts" : "./sessionIndexWorker.js", import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { path }, execArgv: process.execArgv.filter(a => !a.startsWith("--input-type") && a !== "--expose-gc") });
    let result: JsonlDiskIndex | undefined, failure: unknown;
    const stop = (error: unknown) => { failure = error; void worker.terminate().catch(reject); };
    const abort = () => stop(context.abortSignal?.reason ?? new Error("Pi JSONL indexing aborted."));
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    if (context.abortSignal?.aborted) abort();
    worker.on("message", m => {
      if (failure) return;
      if (m.type === "result") result = m.index;
      else if (m.type === "failure") {
        failure = m.code === "PI_JSONL_TORN_TAIL" ? new TornJsonlTailError(path, m.committedBytes, m.tailBytes) : new Error(m.message);
      } else if (m.type === "progress") { try { report(m.progress); } catch (error) { stop(error); } }
    });
    worker.once("error", error => { failure = error; });
    worker.once("exit", code => {
      context.abortSignal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Pi JSONL index worker exited without result (${code}).`));
      else resolve(result);
    });
  });
}

/** Native v4 JSONL remains authoritative; the index holds byte references and one bounded verified Host replay window. */
export class IndexedJsonlStorage implements Storage {
  readonly path: string;
  readonly header: NativeJsonlHeader;
  private handle: FileHandle;
  private index: JsonlDiskIndex;
  private entries = new Map<string, IndexedEntry>();
  private usageIds = new Set<string>();
  private values = new Map<string, IndexedValue>();
  private lists = new Map<string, IndexedList>();
  private cache = new Map<number, { writes: CommittedWrite[]; bytes: number }>();
  private cacheBytes = 0;
  private readonly cacheLimitBytes = 8 * 1024 * 1024;
  private readonly cacheLimitTransactions = 32;
  private commitQueue: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private appendFailure: JsonlAppendFailedError | undefined;
  private closePromise: Promise<void> | undefined;
  private indexDirty = false;
  constructor(path: string, handle: FileHandle, index: JsonlDiskIndex) {
    this.path = path; this.handle = handle; this.index = index; this.header = index.header;
    for (const e of index.entries) this.entries.set(e.id, e);
    for (const u of index.usage) this.usageIds.add(u.id);
    for (const v of index.values) this.values.set(keyOf(v.namespace, v.key), v);
    for (const l of index.lists) this.lists.set(keyOf(l.namespace, l.key), l);
    // These serialized arrays are redundant with the mutable maps after open.
    index.values = []; index.lists = [];
  }
  static async open(path: string, context: Context = BACKGROUND_CONTEXT, options: { onProgress?: (p: JsonlIndexProgress) => void } = {}): Promise<IndexedJsonlStorage> {
    const index = await indexInWorker(path, context, options.onProgress);
    context.abortSignal?.throwIfAborted();
    const handle = await open(path, "r+");
    try {
      if (!sameSourceIdentity(index.identity, sourceIdentity(await handle.stat())) || !sameSourceIdentity(index.identity, sourceIdentity(await stat(path)))) throw new JsonlSourceChangedError(path);
      return new IndexedJsonlStorage(path, handle, index);
    } catch (error) { await handle.close(); throw error; }
  }
  private async checkAdmitted(context: Context): Promise<void> {
    if (this.state === "closed") throw new Error("IndexedJsonlStorage is closed");
    context.abortSignal?.throwIfAborted();
    if (!sameSourceIdentity(this.index.identity, sourceIdentity(await this.handle.stat())) || !sameSourceIdentity(this.index.identity, sourceIdentity(await stat(this.path)))) throw new JsonlSourceChangedError(this.path);
  }
  private read<T>(context: Context, operation: () => Promise<T> | T): Promise<T> {
    if (this.state !== "open") return Promise.reject(new Error("IndexedJsonlStorage is closed"));
    const result = this.commitQueue.then(async () => {
      await this.checkAdmitted(context);
      const value = await operation();
      await this.checkAdmitted(context);
      return value;
    });
    this.commitQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async decode(ref: JsonlWriteRef, context: Context): Promise<CommittedWrite> {
    context.abortSignal?.throwIfAborted();
    let cached = this.cache.get(ref.offset);
    if (cached) { this.cache.delete(ref.offset); this.cache.set(ref.offset, cached); }
    else {
      const bytes = Buffer.allocUnsafe(ref.length); let read = 0;
      while (read < bytes.length) {
        context.abortSignal?.throwIfAborted();
        const result = await this.handle.read(bytes, read, bytes.length - read, ref.offset + read);
        if (!result.bytesRead) throw new JsonlSourceChangedError(this.path);
        read += result.bytesRead;
      }
      if (bytes[bytes.length - 1] !== 10) throw new JsonlSourceChangedError(this.path);
      const writes = parseNativeTransaction(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 1)));
      // Budget decoded strings, containers and property slots, rather than serialized bytes alone.
      cached = { writes, bytes: Math.max(ref.length * 2, decodedMemoryBudget(writes)) };
      if (cached.bytes <= this.cacheLimitBytes) {
        while (this.cache.size && (this.cacheBytes + cached.bytes > this.cacheLimitBytes || this.cache.size >= this.cacheLimitTransactions)) {
          const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.bytes; this.cache.delete(first);
        }
        this.cache.set(ref.offset, cached); this.cacheBytes += cached.bytes;
      }
    }
    const write = cached.writes[ref.writeIndex];
    if (!write || write.seq !== ref.seq) throw new JsonlSourceChangedError(this.path);
    // Do not expose mutable cached objects to native Session callers.
    return structuredClone(write);
  }
  private apply(writes: CommittedWrite[], offset: number, length: number): void {
    writes.forEach((w, writeIndex) => {
      const ref = { offset, length, writeIndex, seq: w.seq };
      switch (w.kind) {
        case "entry": {
          let metadata: IndexedHostMetadata | undefined;
          if (w.type === "custom" && ["yn.host-state.v1","yn.host-state.v2"].includes(w.customType)) {
            let parent = w.parentId === null ? undefined : this.entries.get(w.parentId);
            while (parent && !parent.hostMetadata) parent = parent.parentId === null ? undefined : this.entries.get(parent.parentId);
            const data = w.data as Record<string,any>;
            metadata = {runtimeContractVersion:w.customType === "yn.host-state.v1" ? 1 : data.runtimeContractVersion ?? 1,
              relativePaths:w.customType === "yn.host-state.v2" && data.projectPathsVersion === 1,
              deltasSinceCheckpoint:data.mode === "delta" ? (parent?.hostMetadata?.deltasSinceCheckpoint ?? 0) + 1 : 0,...(typeof data.stateHash === "string" ? {stateHash:data.stateHash} : {})};
          }
          const meta = { ...entryStructure(w), ...ref, ...(metadata ? {hostMetadata:metadata} : {}) }; this.entries.set(w.id, meta); this.index.entries.push(meta);
          if (w.type === "message") this.index.stats.messageCount++; break;
        }
        case "usage": this.usageIds.add(w.id); this.index.usage.push({ ...ref, id: w.id }); this.index.stats.usage = addIndexedUsage(this.index.stats.usage, w.usage); break;
        case "value": if (w.op === "delete") this.values.delete(keyOf(w.namespace, w.key)); else this.values.set(keyOf(w.namespace, w.key), { namespace: w.namespace, key: w.key, ref }); break;
        case "list": {
          const k = keyOf(w.namespace, w.key);
          if (w.op === "delete") this.lists.delete(k);
          else { const existing = this.lists.get(k); if (existing) existing.refs.push(ref); else this.lists.set(k, { namespace: w.namespace, key: w.key, refs: [ref] }); }
          break;
        }
      }
      this.index.nextSeq = w.seq + 1;
    });
  }
  commit(writes: Write[], context: Context): Promise<CommitResult> {
    if (this.state !== "open" || this.closePromise) return Promise.reject(new Error("IndexedJsonlStorage is closed"));
    const result = this.commitQueue.then(async () => {
      if (this.appendFailure) throw this.appendFailure;
      await this.checkAdmitted(context);
      const prepared = prepareStorageCommit(writes, this.index.nextSeq, Date.now());
      validateCommittedWrites(prepared.writes, this.index.nextSeq, { hasEntryOrUsageId: id => this.entries.has(id) || this.usageIds.has(id), hasEntryId: id => this.entries.has(id) });
      if (prepared.writes.length) {
        const bytes = Buffer.from(`${JSON.stringify(prepared.writes.length === 1 ? prepared.writes[0] : prepared.writes)}\n`);
        // Validate the exact persisted form before any bytes are appended.
        const serialized = parseNativeTransaction(bytes.subarray(0, bytes.length - 1).toString("utf8"));
        const offset = this.index.committedBytes;
        context.abortSignal?.throwIfAborted();
        try {
          let written = 0;
          while (written < bytes.length) {
            const result = await this.handle.write(bytes, written, bytes.length - written, offset + written);
            if (!result.bytesWritten) throw new Error("Pi JSONL append made no progress.");
            written += result.bytesWritten;
          }
          await this.handle.sync();
          const identity = sourceIdentity(await this.handle.stat());
          if (identity.size !== offset + bytes.length || identity.dev !== this.index.identity.dev || identity.ino !== this.index.identity.ino) throw new JsonlSourceChangedError(this.path);
          if (!sameSourceIdentity(identity, sourceIdentity(await stat(this.path)))) throw new JsonlSourceChangedError(this.path);
          this.apply(serialized, offset, bytes.length);
          this.index.committedBytes += bytes.length; this.index.identity = identity;
          this.indexDirty = true;
        } catch (error) { this.appendFailure = new JsonlAppendFailedError(this.path, error); throw this.appendFailure; }
      }
      return { ...prepared.result, stats: structuredClone(this.index.stats) };
    });
    this.commitQueue = result.then(() => undefined, () => undefined); return result;
  }
  async getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
    return this.read(context, () => this.loadEntries(ids, context));
  }
  private async loadEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
    const found = new Map<string, Entry>();
    for (const id of ids) { const ref = this.entries.get(id); if (ref) { const { kind: _, ...entry } = await this.decode(ref, context); found.set(id, entry as Entry); } }
    return found;
  }
  async getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
    return this.read(context, () => this.loadValue(address, context));
  }
  private async loadValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
    const stored = this.values.get(keyOf(address.namespace, address.key)); if (!stored) return undefined;
    const w = await this.decode(stored.ref, context); if (w.kind !== "value" || w.op !== "set") throw new Error("Invalid indexed scalar reference.");
    return { address: value<T>(stored.namespace, stored.key), seq: w.seq, value: w.value as T };
  }
  async scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
    return this.read(context, async () => {
    const compare = (a: string, b: string) => { const x = Array.from(a, c => c.codePointAt(0)!), y = Array.from(b, c => c.codePointAt(0)!); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
    const refs = [...this.values.values()].filter(v => v.namespace === prefix.namespace && v.key.startsWith(prefix.key)).sort((a,b) => compare(a.key,b.key));
    const results: StoredValue<T>[] = []; for (const v of refs) results.push((await this.loadValue<T>(value(v.namespace,v.key), context))!); return results;
    });
  }
  async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, context: Context): Promise<ListElement<T>[]> {
    return this.read(context, async () => {
    const q = resolveListReadOptions(options);
    let refs = (this.lists.get(keyOf(address.namespace,address.key))?.refs ?? []).filter(r => q.cursor === undefined || (q.order === "asc" ? r.seq > q.cursor.seq : r.seq < q.cursor.seq));
    if (q.order === "desc") refs = refs.reverse(); const result: ListElement<T>[] = [];
    for (const ref of refs.slice(0,q.limit)) { const w = await this.decode(ref,context); if (w.kind !== "list" || w.op !== "append") throw new Error("Invalid indexed list reference."); result.push({seq:w.seq,value:w.value as T}); } return result;
    });
  }
  private branchRefs(q: StorageBranchScan): IndexedEntry[] {
    let e = this.entries.get(q.start); if (!e) throw new Error(`Unknown branch start: ${q.start}`);
    const path: IndexedEntry[] = []; while (e) { path.push(e); if (e.parentId === null) break; e = this.entries.get(e.parentId); if (!e) throw new Error("Corrupt branch: missing parent"); }
    if (q.order === "oldestFirst") path.reverse(); const stopped: IndexedEntry[] = [];
    for (const candidate of path) { stopped.push(candidate); if (candidate.id === q.stopAtId || candidate.type === q.stopAtType) break; }
    const result = stopped.filter(e => (q.type === undefined || e.type === q.type) && (q.customType === undefined || e.customType === q.customType)
      && (q.cursor === undefined || (q.order === "oldestFirst" ? e.seq > q.cursor.seq : e.seq < q.cursor.seq)));
    return q.limit === undefined ? result : result.slice(0,Math.max(0,q.limit));
  }
  async scanBranch(q: StorageBranchScan, context: Context): Promise<Entry[]> { return this.read(context, async () => [...(await this.loadEntries(this.branchRefs(q).map(e => e.id),context)).values()]); }
  async scanBranchStructure(q: StorageBranchScan, context: Context): Promise<EntryStructure[]> { return this.read(context, () => this.branchRefs(q).map(entryStructure)); }
  async scanEntries(q: EntryScan, context: Context): Promise<Entry[]> {
    return this.read(context, async () => {
    const refs: IndexedEntry[] = [], limit = q.limit === undefined ? Infinity : Math.max(0,Math.trunc(q.limit));
    for (let i = q.order === "desc" ? this.index.entries.length - 1 : 0; i >= 0 && i < this.index.entries.length && refs.length < limit; i += q.order === "desc" ? -1 : 1) {
      const e = this.index.entries[i]; if ((q.type === undefined || e.type === q.type) && (q.customType === undefined || e.customType === q.customType) && (q.fromSeq === undefined || e.seq >= q.fromSeq) && (q.toSeq === undefined || e.seq <= q.toSeq)) refs.push(e);
    }
    return [...(await this.loadEntries(refs.map(e => e.id),context)).values()];
    });
  }
  async scanUsage(q: UsageScan, context: Context): Promise<UsageRow[]> {
    return this.read(context, async () => {
    let refs = this.index.usage.filter(r => (q.fromSeq === undefined || r.seq >= q.fromSeq) && (q.toSeq === undefined || r.seq <= q.toSeq));
    if (q.order === "desc") refs.reverse(); if (q.limit !== undefined) refs = refs.slice(0,Math.max(0,q.limit));
    const result: UsageRow[] = []; for (const ref of refs) { const { kind: _, ...row } = await this.decode(ref,context); result.push(row as UsageRow); } return result;
    });
  }
  async getStats(context: Context): Promise<SessionStats> { return this.read(context, () => structuredClone(this.index.stats)); }
  getHostRestorePoint(context: Context = BACKGROUND_CONTEXT): Promise<HostRestorePoint | undefined> {
    return this.read(context, () => this.index.hostRestorePoint ? structuredClone(this.index.hostRestorePoint) : undefined);
  }
  hasHostRestoreSource(context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
    return this.read(context, () => Boolean(this.index.hostRestorePoint || this.index.verifiedHostHistory));
  }
  getVerifiedHostPrefix(context: Context = BACKGROUND_CONTEXT): Promise<number | undefined> {
    return this.read(context, () => this.index.verifiedHostHistory?.throughSeq);
  }
  getCertifiedHostEntryIds(ids: string[], context: Context = BACKGROUND_CONTEXT): Promise<Set<string>> {
    return this.read(context, () => new Set(ids.filter(id => {
      const entry = this.entries.get(id), prefix = this.index.verifiedHostHistory;
      return Boolean(entry && prefix && entry.offset + entry.length <= prefix.committedBytes);
    })));
  }
  getHostMetadata(id: string, context: Context = BACKGROUND_CONTEXT): Promise<IndexedHostMetadata | undefined> {
    return this.read(context, () => this.entries.get(id)?.hostMetadata ? {...this.entries.get(id)!.hostMetadata!} : undefined);
  }
  /** Caller has validated the anchor and every state represented by this replay window. */
  setHostRestorePoint(point: HostRestorePoint, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    return this.read(context, () => {
      const anchor = this.entries.get(point.anchorId);
      if (!anchor || anchor.seq !== point.anchorSeq || point.ownerSessionId !== this.header.id) throw new Error("Host restore point does not match its native storage anchor.");
      this.index.hostRestorePoint = structuredClone(point);
      this.indexDirty = true;
    });
  }
  /** Advance the private verified window after an owned successful persistence.
   * Historical witnesses are immutable; copy only the newly supplied state. */
  advanceOwnedHostRestorePoint(tipId: string, state: YnSessionHostState, stateHash: string, data: Record<string,any>, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    return this.read(context, () => {
      let anchor = this.entries.get(tipId);
      while (anchor && !anchor.hostMetadata) anchor = anchor.parentId === null ? undefined : this.entries.get(anchor.parentId);
      if (!anchor || anchor.hostMetadata?.stateHash !== stateHash) return;
      let previous = anchor.parentId === null ? undefined : this.entries.get(anchor.parentId);
      while (previous && !previous.hostMetadata) previous = previous.parentId === null ? undefined : this.entries.get(previous.parentId);
      const prior = this.index.hostRestorePoint;
      if (previous && previous.id !== prior?.anchorId) return;
      const next = advanceHostRestorePoint(prior,{id:anchor.id,seq:anchor.seq,data},structuredClone(state),stateHash);
      if (prior?.incompleteLegacyRecoveryWindow) next.incompleteLegacyRecoveryWindow = true;
      this.index.hostRestorePoint = next;
      this.indexDirty = true;
    });
  }
  private async refreshIndex(): Promise<void> {
    if (!this.indexDirty || this.appendFailure) return;
    // A changed external file is never certified by the closing owner.
    if (!sameSourceIdentity(this.index.identity,sourceIdentity(await stat(this.path)))) {
      console.info("Pi derived index refresh skipped",{path:this.path,reason:"source identity changed outside the storage owner"});
      throw new JsonlSourceChangedError(this.path);
    }
    const before = this.index.identity;
    this.index.sourceFingerprint = await fingerprint(this.path,before.size,BACKGROUND_CONTEXT,()=>{});
    if (!sameSourceIdentity(before,sourceIdentity(await stat(this.path)))) throw new JsonlSourceChangedError(this.path);
    await writeJsonlDiskIndex(this.path,{...this.index,values:[...this.values.values()],lists:[...this.lists.values()]});
    this.indexDirty = false;
  }
  flushDerivedIndex(context: Context = BACKGROUND_CONTEXT): Promise<void> { return this.read(context, () => this.refreshIndex()); }
  captureForkNextSeq(context: Context): Promise<number> {
    if (this.state !== "open") return Promise.reject(new Error("IndexedJsonlStorage is closed"));
    const result = this.commitQueue.then(async () => { await this.checkAdmitted(context); return this.index.nextSeq; });
    this.commitQueue = result.then(() => undefined, () => undefined); return result;
  }
  /** Transaction cache occupancy; the separately bounded Host restore window is not a transcript cache. */
  getCacheDiagnostics(): { transactions: number; estimatedBytes: number; maxBytes: number } { return {transactions:this.cache.size,estimatedBytes:this.cacheBytes,maxBytes:this.cacheLimitBytes}; }
  close(_context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Queued commits remain authorized; closing rejects newly submitted commits.
    const tail = this.commitQueue;
    this.state = "closing";
    this.closePromise = tail.then(async () => {
      this.state = "closing"; this.cache.clear(); this.cacheBytes = 0;
      let failure: unknown;
      try { if (!this.appendFailure) await this.checkAdmitted(BACKGROUND_CONTEXT); await this.refreshIndex(); } catch (error) { failure = error; }
      try { await this.handle.close(); } catch (error) { failure = failure === undefined ? error : new AggregateError([failure,error],"Pi index refresh and storage close failed."); }
      this.state = "closed";
      if (failure !== undefined) throw failure;
    });
    return this.closePromise;
  }
}
