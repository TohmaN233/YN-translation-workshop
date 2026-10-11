import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, rename, unlink, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import type { CommittedWrite } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { readJsonlRecords, TornJsonlTailError } from "./jsonlRecords.ts";
import { applyJsonDelta, createJsonDelta, hostStateHash } from "./hostStateDelta.ts";

export interface PiSessionStorageProgress {
  phase: "scan" | "verify" | "backup" | "publish" | "index" | "replay" | "complete";
  processedBytes: number;
  totalBytes: number;
  originalBytes?: number;
  compactedBytes?: number;
}
export interface PiSessionStorageOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PiSessionStorageProgress) => void;
}
export const SESSION_STORAGE_MAINTENANCE_VERSION = 1;
const maintenanceTails = new Map<string, Promise<void>>();
const HOST_TYPE = "yn.host-state.v2";
type Data = Record<string, any>;
type HostReference = { offset: number; length: number; writeIndex: number; previous?: string };

async function firstHeader(filePath: string): Promise<Data> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) return JSON.parse(line);
    throw new Error(`Empty Pi session storage: ${filePath}`);
  } finally { lines.close(); input.destroy(); }
}

/** Only cold sessions enter this gate. The worker publishes after lossless verification. */
export async function upgradePiSessionStorage(filePath: string, options: PiSessionStorageOptions = {}, force = false): Promise<void> {
  const previous = maintenanceTails.get(filePath) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    options.signal?.throwIfAborted();
    const header = await firstHeader(filePath);
    if (header.v !== 4) return; // Legacy v3 retains Pi's existing first-write conversion/backup.
    if (header.ynSessionStorageVersion === SESSION_STORAGE_MAINTENANCE_VERSION && !force) return;
    if (header.ynSessionStorageVersion !== undefined && header.ynSessionStorageVersion !== SESSION_STORAGE_MAINTENANCE_VERSION) throw new Error(`Unsupported YN session storage version: ${header.ynSessionStorageVersion}`);
    const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./sessionMaintenanceWorker.ts" : "./sessionMaintenanceWorker.js", import.meta.url);
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(workerUrl, { workerData: { path: filePath },
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type") && arg !== "--expose-gc") });
      let error: unknown, complete = false;
      const cancel = () => {
        error = options.signal?.reason ?? new DOMException("Session preparation stopped.", "AbortError");
        // The worker checks cancellation immediately before rename; an in-flight atomic rename finishes.
        worker.postMessage({ type: "cancel" });
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      worker.on("message", (message) => {
        if (message.type === "progress") {
          try {
            options.onProgress?.(message.progress);
            if (message.progress.phase === "publish") worker.postMessage({ type: "publish-ready" });
          }
          catch (failure) { error = failure; worker.postMessage({ type: "cancel" }); }
        } else if (message.type === "complete") complete = true;
        else if (message.type === "failure") {
          const failure = new Error(message.message); failure.name = message.name; error ??= failure;
        }
      });
      worker.once("error", (failure) => { error ??= failure; });
      worker.once("exit", (code) => {
        options.signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else if (code !== 0 || !complete) reject(new Error(`Session upgrade exited without acceptance (${code}).`));
        else resolve();
      });
      if (options.signal?.aborted) cancel();
    });
    options.signal?.throwIfAborted();
  });
  maintenanceTails.set(filePath, task);
  try { await task; } finally { if (maintenanceTails.get(filePath) === task) maintenanceTails.delete(filePath); }
}

async function fileHash(filePath: string, compressed = false, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const digest = createHash("sha256");
  const input = createReadStream(filePath);
  // pipeline propagates source read errors through gunzip instead of leaving an unhandled input error.
  if (compressed) await pipeline(input, createGunzip(), digest, { signal });
  else await pipeline(input, digest, { signal });
  return digest.digest("hex");
}

/** Lossless recompression: every transaction, entry identity and represented Host state survives. */
export async function compactPiSessionFile(filePath: string, options: PiSessionStorageOptions & { beforePublish?: () => Promise<void> } = {}): Promise<Data> {
  const before = await stat(filePath);
  const temp = `${filePath}.${randomUUID()}.upgrade.tmp`;
  const receiptPath = `${filePath}.storage-upgrade.json`;
  const context = options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  const progress = (phase: PiSessionStorageProgress["phase"], bytes: number, total = before.size) =>
    options.onProgress?.({ phase, processedBytes: bytes, totalBytes: total });
  const references = new Map<string, HostReference>();
  const nearestHost = new Map<string, string | undefined>();
  const inputHandle = await open(filePath, "r");
  let outputHandle: Awaited<ReturnType<typeof open>>;
  try { outputHandle = await open(temp, "wx"); }
  catch (error) { await inputHandle.close(); throw error; }
  let rolling: Data | undefined, rollingId: string | undefined, rollingHash = "", deltas = 0;
  let lastProgress = 0, outputBytes = 0, hostCount = 0, converted = 0, tailBytes = 0;
  const originalSemantic = createHash("sha256");
  const originalBytesDigest = createHash("sha256");
  const candidateSemantic = createHash("sha256");
  let header: Data | undefined;
  let receiptTemp: string | undefined;
  let publishedReceiptTemp: string | undefined;
  let sourcePublished = false, receiptPublished = false;

  const verifyHost = (write: Data, previous?: Data): Data => {
    const data = write.data;
    if (![2, 3].includes(data?.schemaVersion) || data.ownerSessionId !== header?.id) {
      throw new Error(`Invalid Host state owner/schema at entry ${write.id}.`);
    }
    const state = data.mode === "checkpoint" ? data.state : data.mode === "delta" && previous
      ? applyJsonDelta(previous, data.operations, data.schemaVersion) : undefined;
    if (!state || state.ownerSessionId !== header?.id) throw new Error(`Missing Host baseline at entry ${write.id}.`);
    if (data.mode === "delta" && hostStateHash(previous) !== data.baseHash) throw new Error(`Stale Host delta base at entry ${write.id}.`);
    if (hostStateHash(state) !== data.stateHash) throw new Error(`Host state hash mismatch at entry ${write.id}.`);
    return state;
  };
  const readHost = async (id: string): Promise<Data> => {
    const chain: Data[] = [];
    let cursor: string | undefined = id;
    while (cursor) {
      const ref = references.get(cursor);
      if (!ref) throw new Error(`Missing historical Host reference ${cursor}.`);
      const buffer = Buffer.alloc(ref.length);
      const read = await inputHandle.read(buffer, 0, buffer.length, ref.offset);
      if (read.bytesRead !== buffer.length) throw new Error("Pi session changed during Host recovery.");
      const transaction = JSON.parse(buffer.toString("utf8"));
      const write = (Array.isArray(transaction) ? transaction : [transaction])[ref.writeIndex];
      chain.push(write);
      options.signal?.throwIfAborted();
      if (write.data.mode === "checkpoint") break;
      cursor = ref.previous;
    }
    let state: Data | undefined;
    for (const write of chain.reverse()) state = verifyHost(write, state);
    if (!state) throw new Error(`No Host checkpoint for ${id}.`);
    return state;
  };
  const signature = (write: Data, state?: Data) => {
    if (!state) return JSON.stringify(write);
    const { state: _state, operations: _operations, mode: _mode, baseHash: _baseHash,
      schemaVersion: _schemaVersion, ...metadata } = write.data;
    return JSON.stringify({ ...write, data: metadata });
  };
  const append = async (value: unknown) => {
    const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
    await outputHandle.writeFile(buffer); outputBytes += buffer.length;
  };
  try {
    progress("scan", 0);
    try {
      for await (const record of readJsonlRecords(filePath, context)) {
        options.signal?.throwIfAborted();
        originalBytesDigest.update(record.bytes);
        if (record.kind === "header") {
          header = record.header;
          await append({ ...header, ynSessionStorageVersion: SESSION_STORAGE_MAINTENANCE_VERSION });
          continue;
        }
        const transformed: CommittedWrite[] = [];
        for (const [writeIndex, write] of record.writes.entries()) {
          const entry = write as unknown as Data;
          let replacement: Data = entry;
          if (entry.kind === "entry") {
            const previousHost = entry.parentId === null ? undefined : nearestHost.get(entry.parentId);
            if (entry.type === "custom" && entry.customType === HOST_TYPE) {
              let previousState = previousHost && previousHost === rollingId ? rolling : undefined;
              if (previousHost && !previousState) previousState = await readHost(previousHost);
              const state = verifyHost(entry, previousState);
              if (entry.data.mode === "checkpoint" && previousState && previousHost === rollingId && deltas < 256) {
                const { state: _state, ...rest } = entry.data;
                const delta = { ...rest, schemaVersion: 3, mode: "delta", baseHash: rollingHash,
                  operations: createJsonDelta(previousState, state) };
                if (JSON.stringify(delta).length < JSON.stringify(entry.data).length * 0.65) {
                  replacement = { ...entry, data: delta }; converted += 1;
                }
              }
              deltas = replacement.data.mode === "checkpoint" ? 0 : deltas + 1;
              rolling = state; rollingId = entry.id; rollingHash = entry.data.stateHash;
              references.set(entry.id, { offset: record.offset, length: record.length, writeIndex, previous: previousHost });
              nearestHost.set(entry.id, entry.id);
              originalSemantic.update(signature(entry, state));
              hostCount += 1;
            } else {
              nearestHost.set(entry.id, previousHost);
              originalSemantic.update(signature(entry));
            }
          } else originalSemantic.update(signature(entry));
          transformed.push(replacement as CommittedWrite);
        }
        await append(transformed.length === 1 ? transformed[0] : transformed);
        if (Date.now() - lastProgress > 250) { progress("scan", record.offset + record.length); lastProgress = Date.now(); }
      }
    } catch (error) {
      if (!(error instanceof TornJsonlTailError)) throw error;
      tailBytes = error.tailBytes;
      // The incomplete suffix is not committed, but it must survive byte-for-byte in the backup.
      const buffer = Buffer.alloc(Math.min(tailBytes, 256 * 1024));
      for (let offset = 0; offset < tailBytes;) {
        options.signal?.throwIfAborted();
        const length = Math.min(buffer.length, tailBytes - offset);
        const read = await inputHandle.read(buffer, 0, length, error.committedBytes + offset);
        if (read.bytesRead !== length) throw new Error("Pi session changed during compression; original retained.");
        originalBytesDigest.update(buffer.subarray(0, length)); offset += length;
      }
    }
    const originalHash = originalBytesDigest.digest("hex");
    await outputHandle.sync(); await outputHandle.close();
    // Independently validate the rewritten native transactions and every Host hash on each branch.
    rolling = undefined; rollingId = undefined;
    const parents = new Map<string, string | undefined>();
    const outputHosts = new Map<string, HostReference>();
    const candidateHandle = await open(temp, "r");
    try {
      progress("verify", 0, outputBytes);
      for await (const record of readJsonlRecords(temp, context)) {
        if (record.kind === "header") continue;
        for (const [writeIndex, write] of record.writes.entries()) {
          const entry = write as unknown as Data;
          if (entry.kind === "entry") {
            const previousId = entry.parentId === null ? undefined : parents.get(entry.parentId);
            if (entry.type === "custom" && entry.customType === HOST_TYPE) {
              // Normal sequential branches retain only one state. Rare branch changes replay offsets.
              let previous = previousId === rollingId ? rolling : undefined;
              if (previousId && !previous) {
                const chain: Data[] = []; let id: string | undefined = previousId;
                while (id) {
                  const ref = outputHosts.get(id); if (!ref) throw new Error(`Missing rewritten Host parent ${id}.`);
                  options.signal?.throwIfAborted();
                  const buffer = Buffer.alloc(ref.length); const read = await candidateHandle.read(buffer, 0, buffer.length, ref.offset);
                  if (read.bytesRead !== buffer.length) throw new Error("Rewritten Pi session changed during verification.");
                  const tx = JSON.parse(buffer.toString("utf8")); const w = (Array.isArray(tx) ? tx : [tx])[ref.writeIndex];
                  chain.push(w); if (w.data.mode === "checkpoint") break; id = ref.previous;
                }
                for (const w of chain.reverse()) previous = verifyHost(w, previous);
              }
              const state = verifyHost(entry, previous);
              candidateSemantic.update(signature(entry, state));
              rolling = state; rollingId = entry.id;
              outputHosts.set(entry.id, { offset: record.offset, length: record.length, writeIndex, previous: previousId });
              parents.set(entry.id, entry.id);
            } else { parents.set(entry.id, previousId); candidateSemantic.update(signature(entry)); }
          } else candidateSemantic.update(signature(entry));
        }
        if (Date.now() - lastProgress > 250) { progress("verify", record.offset + record.length, outputBytes); lastProgress = Date.now(); }
      }
    } finally { await candidateHandle.close(); }
    if (originalSemantic.digest("hex") !== candidateSemantic.digest("hex")) throw new Error("Session compression changed committed semantics.");
    options.signal?.throwIfAborted();
    if (await fileHash(filePath, false, options.signal) !== originalHash) throw new Error("Pi session changed during compression; original retained.");
    const backup = `${filePath}.storage-v1.${originalHash.slice(0, 16)}.backup.jsonl.gz`;
    progress("backup", 0);
    const backupTemp = `${backup}.${randomUUID()}.tmp`;
    try {
      await pipeline(createReadStream(filePath), createGzip({ level: 1 }), createWriteStream(backupTemp, { flags: "wx" }), { signal: options.signal });
      const backupHandle = await open(backupTemp, "r+"); try { await backupHandle.sync(); } finally { await backupHandle.close(); }
      if (await fileHash(backupTemp, true, options.signal) !== originalHash) throw new Error("Session backup verification failed.");
      try { await link(backupTemp, backup); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await fileHash(backup, true, options.signal) !== originalHash) throw new Error(`Existing Pi backup is invalid: ${backup}`);
      }
    } finally { await unlink(backupTemp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    options.signal?.throwIfAborted();
    const compactedHash = await fileHash(temp, false, options.signal);
    const receipt = { version: SESSION_STORAGE_MAINTENANCE_VERSION, status: "candidate_verified", path: filePath, sessionId: header?.id,
      originalBytes: before.size, compactedBytes: outputBytes, originalHash, compactedHash, backup,
      hostCount, convertedCheckpoints: converted, uncommittedTailBytes: tailBytes, verified: true, timestamp: new Date().toISOString() };
    receiptTemp = `${receiptPath}.${randomUUID()}.prepared.tmp`;
    const receiptHandle = await open(receiptTemp, "wx");
    try { await receiptHandle.writeFile(JSON.stringify(receipt, null, 2)); await receiptHandle.sync(); }
    finally { await receiptHandle.close(); }
    progress("publish", before.size);
    // A worker waits for the main process to accept this progress callback before crossing the write boundary.
    await options.beforePublish?.();
    options.signal?.throwIfAborted();
    const after = await stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
      || await fileHash(filePath, false, options.signal) !== originalHash) throw new Error("Pi session changed during compression; original retained.");
    options.signal?.throwIfAborted();
    // Windows cannot replace a file while our own positional reader still owns it.
    await inputHandle.close();
    options.signal?.throwIfAborted();
    await rename(temp, filePath);
    sourcePublished = true;
    // Keep the prepared evidence until a separate, fully synced published receipt replaces the old receipt.
    // A crash here leaves hashes that distinguish the published candidate from the original backup.
    const publishedReceipt = { ...receipt, status: "published" };
    publishedReceiptTemp = `${receiptPath}.${randomUUID()}.published.tmp`;
    const publishedReceiptHandle = await open(publishedReceiptTemp, "wx");
    try { await publishedReceiptHandle.writeFile(JSON.stringify(publishedReceipt, null, 2)); await publishedReceiptHandle.sync(); }
    finally { await publishedReceiptHandle.close(); }
    await rename(publishedReceiptTemp, receiptPath);
    receiptPublished = true;
    progress("complete", outputBytes, outputBytes);
    return publishedReceipt;
  } finally {
    await inputHandle.close(); await outputHandle.close();
    await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (receiptTemp && (!sourcePublished || receiptPublished)) await unlink(receiptTemp).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (publishedReceiptTemp) await unlink(publishedReceiptTemp).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
