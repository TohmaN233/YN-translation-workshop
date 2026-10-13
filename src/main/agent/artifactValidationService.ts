import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ValidateArtifactArgs } from "../ipc/agentArtifactHandlers.ts";
import type { TranslationValidationResult } from "../../shared/validation/translationValidator.ts";
import type { CandidateImportPlan } from "./importCandidate.ts";
import { readWorkflowTranslationValidationAssets } from "./projectAssets.ts";
import { ArtifactCancelledError, deserializeArtifactError, serializeArtifactError } from "./artifactCancellation.ts";

export interface ArtifactWorkerRequest {
  args: ValidateArtifactArgs;
  operation: "validate" | "import" | "repair";
  compact?: boolean;
  cached?: { fingerprint: string; validation: TranslationValidationResult };
  assets?: Awaited<ReturnType<typeof readWorkflowTranslationValidationAssets>>;
}
export interface ArtifactWorkerResult {
  fingerprint: string;
  validation: TranslationValidationResult;
  cacheHit: boolean;
  plan?: CandidateImportPlan;
  lines?: string[];
  prompt?: string;
  memoryWarning?: string;
  validationBytes: number;
  memoryCommitted?: boolean;
}
export interface ArtifactProgress { requestId: string; phase: string; completedLines: number; totalLines: number }

// Only derived validation evidence is retained. Every use re-reads and hashes
// both files and the complete effective validation options in the worker.
const imports = new Map<string, Promise<unknown>>();
const cache = new Map<string, NonNullable<ArtifactWorkerRequest["cached"]> & { bytes: number }>();
export async function runArtifactOperation(request: Omit<ArtifactWorkerRequest, "cached">, options: {
  signal?: AbortSignal; requestId?: string; onProgress?: (progress: ArtifactProgress) => void;
} = {}): Promise<ArtifactWorkerResult> {
  if (request.operation !== "import") return executeArtifactOperation(request, options);
  const key = path.resolve(request.args.projectDir).toLowerCase();
  const previous = imports.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => executeArtifactOperation(request, options));
  imports.set(key, task);
  try { return await task; }
  finally { if (imports.get(key) === task) imports.delete(key); }
}
async function executeArtifactOperation(request: Omit<ArtifactWorkerRequest, "cached">, options: {
  signal?: AbortSignal; requestId?: string; onProgress?: (progress: ArtifactProgress) => void;
} = {}): Promise<ArtifactWorkerResult> {
  options.signal?.throwIfAborted();
  const requestId = options.requestId ?? randomUUID();
  const { requestId: _requestId, compact: _compact, ...settings } = request.args;
  const key = JSON.stringify(settings);
  // Keep asset migration and snapshots in the existing process-local project
  // transaction. Workers only receive the validated, immutable snapshot.
  const journal = path.join(request.args.projectDir, ".translation-workshop", "agent", "validation", "events.jsonl");
  await mkdir(path.dirname(journal), { recursive: true });
  const started = Date.now();
  const record = (event: string, detail: Record<string, unknown> = {}) => appendFile(journal, JSON.stringify({
    at: new Date().toISOString(), requestId, phase: `artifact-${request.operation}`, event,
    sourcePath: request.args.sourcePath, candidatePath: request.args.candidatePath, elapsedMs: Date.now() - started, ...detail
  }) + "\n");
  await record("started");
  try {
    const assets = await readWorkflowTranslationValidationAssets({ outputDir: request.args.projectDir, glossaryPath: request.args.glossaryPath });
    options.signal?.throwIfAborted();
    const result = await new Promise<ArtifactWorkerResult>((resolve, reject) => {
      const cancellation = new SharedArrayBuffer(4);
      const worker = new Worker(new URL(import.meta.url.endsWith(".ts")
        ? "./piNative/translationValidationWorker.ts" : "./translationValidationWorker.js", import.meta.url), {
        workerData: { artifact: { ...request, assets, cached: cache.get(key) }, cancellation, artifactJournal: journal, requestId },
        execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type") && !/^--expose[-_]gc/.test(arg))
      });
      let result: ArtifactWorkerResult | undefined, failure: unknown, cancellationRequested = false;
      const abort = () => {
        cancellationRequested = true;
        Atomics.store(new Int32Array(cancellation), 0, 1);
        // Import can be inside a SQLite transaction: cooperate, roll back and
        // close instead of interrupting COMMIT/cleanup with terminate().
        if (request.operation !== "import") void worker.terminate().catch(error => { failure = failure ? new AggregateError([failure, error], "Artifact worker termination failed.") : error; });
      };
      const confirmMemory = async () => {
        try {
          options.signal?.throwIfAborted();
          const latest = await readWorkflowTranslationValidationAssets({ outputDir: request.args.projectDir, glossaryPath: request.args.glossaryPath });
          options.signal?.throwIfAborted();
          if (JSON.stringify(assets) !== JSON.stringify(latest)) throw new Error("Validation assets changed during the check; refresh before importing.");
          worker.postMessage({ type: "memory-decision", ok: true });
        } catch (error) {
          failure ??= error;
          worker.postMessage({ type: "memory-decision", ok: false,
            error: { code: "YN_ARTIFACT_COMMIT_REJECTED", message: error instanceof Error ? error.message : String(error) } });
        }
      };
      worker.on("message", message => {
        if (message.type === "memory-precommit") { void confirmMemory(); return; }
        if (message.type === "artifact-failure") {
          const error = deserializeArtifactError(message.error);
          if (error instanceof ArtifactCancelledError && cancellationRequested) {
            failure ??= new ArtifactCancelledError(options.signal?.reason?.message ?? error.message);
          } else if (!(failure !== undefined && !(error instanceof AggregateError) && message.error.code === "YN_ARTIFACT_COMMIT_REJECTED")) {
            failure = failure ? new AggregateError([failure, error], "Artifact worker and cleanup failed.") : error;
          }
          return;
        }
        if (failure !== undefined) return;
        if (message.type === "artifact-result") result = message.result;
        if (message.type === "progress") {
          try { options.onProgress?.({ requestId, phase: message.phase ?? "validation", completedLines: message.completedLines, totalLines: message.totalLines }); }
          catch (error) { failure = error; abort(); }
        }
      });
      worker.once("error", error => { failure = failure ? new AggregateError([failure, error], "Artifact worker and cleanup failed.") : error; });
      worker.once("exit", code => {
        options.signal?.removeEventListener("abort", abort);
        if (failure !== undefined) reject(failure);
        else if (cancellationRequested) reject(new ArtifactCancelledError(options.signal?.reason?.message));
        else if (code !== 0 || !result) reject(new Error(`Artifact worker exited without a result (code ${code}).`));
        else resolve(result);
      });
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
    options.signal?.throwIfAborted();
    if (!result.memoryCommitted) {
      const currentAssets = await readWorkflowTranslationValidationAssets({ outputDir: request.args.projectDir, glossaryPath: request.args.glossaryPath });
      if (JSON.stringify(assets) !== JSON.stringify(currentAssets)) throw new Error("Validation assets changed during the check; refresh before importing.");
    }
    cache.delete(key);
    cache.set(key, { fingerprint: result.fingerprint, validation: result.validation, bytes: result.validationBytes });
    const cacheBytes = () => [...cache.values()].reduce((total, entry) => total + entry.bytes, 0);
    while (cache.size > 2 || cacheBytes() > 16 * 1024 * 1024) cache.delete(cache.keys().next().value!);
    await record("completed", { cacheHit: result.cacheHit, fingerprint: result.fingerprint, lineCount: result.validation.sourceLineCount, memoryWarning: result.memoryWarning });
    return result;
  } catch (error) {
    const failure = options.signal?.aborted && error === options.signal.reason
      ? new ArtifactCancelledError(error instanceof Error ? error.message : String(error)) : error;
    try { await record(failure instanceof ArtifactCancelledError ? "cancelled" : "failed", { error: failure instanceof Error ? failure.message : String(failure), failure: serializeArtifactError(failure) }); }
    catch (journalError) { throw new AggregateError([failure, journalError], "Artifact operation and diagnostic persistence failed."); }
    throw failure;
  }
}
