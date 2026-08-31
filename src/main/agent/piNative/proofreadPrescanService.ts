import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { writeTextFileAtomically } from "../../atomicFile.ts";
import type { ValidationOptions } from "../../../shared/validation/translationValidator.ts";
import type { ProofreadDeterministicSignal, ProofreadPrescanProgress } from "./proofreadPrescan.ts";

// Bump when deterministic signal semantics change, not for scheduling/performance-only changes.
const PRESCAN_CACHE_VERSION = 1;
type ScanInput = {
  sourceText: string;
  translationText: string;
  validationOptions: Omit<ValidationOptions, "extractPlaceholders" | "extractTags">;
};
export interface ProofreadPrescanWorkerInput {
  scan: ScanInput;
  journalPath?: string;
  runId: string;
}

function scanInWorker(input: ProofreadPrescanWorkerInput, options: {
  signal?: AbortSignal;
  onProgress?: (progress: ProofreadPrescanProgress) => void;
}): Promise<ProofreadDeterministicSignal[]> {
  options.signal?.throwIfAborted();
  const workerUrl = new URL(import.meta.url.endsWith(".ts")
    ? "./proofreadPrescanWorker.ts" : "./proofreadPrescanWorker.js", import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: input,
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type"))
    });
    let result: ProofreadDeterministicSignal[] | undefined;
    let failure: unknown;
    const abort = () => {
      failure = options.signal?.reason ?? new Error("Proofread prescan aborted.");
      void worker.terminate().catch((error) => { failure = error; });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message) => {
      if (failure) return;
      if (message.type === "result") result = message.signals;
      else if (message.type === "progress") {
        try { options.onProgress?.(message.progress); }
        catch (error) {
          failure = error;
          void worker.terminate().catch((terminateError) => { failure = terminateError; });
        }
      }
    });
    worker.once("error", (error) => { failure = error; });
    worker.once("exit", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Proofread prescan worker exited without a result (code ${code}).`));
      else resolve(result);
    });
  });
}

export async function runProofreadPrescan(args: ScanInput & {
  cache?: { directory: string; documentId: string; inputHash: string };
  signal?: AbortSignal;
  onProgress?: (progress: ProofreadPrescanProgress) => void;
}): Promise<ProofreadDeterministicSignal[]> {
  args.signal?.throwIfAborted();
  const runId = randomUUID();
  const started = Date.now();
  const journalPath = args.cache ? path.join(args.cache.directory, "events.jsonl") : undefined;
  const cachePath = args.cache ? path.join(args.cache.directory,
    `${createHash("sha256").update(args.cache.documentId).digest("hex")}.json`) : undefined;
  const record = async (event: string, extra: Record<string, unknown> = {}) => {
    if (journalPath) await appendFile(journalPath, `${JSON.stringify({
      at: new Date().toISOString(), runId, documentId: args.cache?.documentId,
      inputHash: args.cache?.inputHash, event, elapsedMs: Date.now() - started, ...extra
    })}\n`);
  };
  if (args.cache) await mkdir(args.cache.directory, { recursive: true });
  await record("started");
  try {
    if (cachePath) {
      let cachedText: string | undefined;
      try { cachedText = await readFile(cachePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (cachedText !== undefined) {
        const cached = JSON.parse(cachedText);
        if (cached.version === PRESCAN_CACHE_VERSION && cached.inputHash === args.cache!.inputHash) {
          if (!Array.isArray(cached.signals) || !cached.signals.every((signal: ProofreadDeterministicSignal) =>
            signal && Number.isInteger(signal.line) && signal.line > 0
            && ["H3", "H4", "H7", "H8", "H9", "M0"].includes(signal.code) && typeof signal.evidence === "string"
          )) throw new Error(`Invalid proofread prescan cache: ${cachePath}`);
          args.signal?.throwIfAborted();
          await record("cache_hit", { signalCount: cached.signals.length });
          args.signal?.throwIfAborted();
          return cached.signals;
        }
      }
    }
    const signals = await scanInWorker({
      runId, journalPath,
      scan: { sourceText: args.sourceText, translationText: args.translationText, validationOptions: args.validationOptions }
    }, args);
    args.signal?.throwIfAborted();
    if (cachePath) await writeTextFileAtomically(cachePath, JSON.stringify({
      version: PRESCAN_CACHE_VERSION, inputHash: args.cache!.inputHash, signals
    }));
    args.signal?.throwIfAborted();
    await record("completed", { signalCount: signals.length });
    args.signal?.throwIfAborted();
    return signals;
  } catch (error) {
    await record(args.signal?.aborted ? "cancelled" : "failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
