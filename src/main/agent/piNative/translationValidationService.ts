import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { TranslationValidationResult, ValidationOptions } from "../../../shared/validation/translationValidator.ts";

export interface TranslationValidationWorkerInput {
  sourceText: string;
  candidateText: string;
  validationOptions: Omit<ValidationOptions, "extractPlaceholders" | "extractTags">;
  journalPath?: string;
  runId: string;
}

export async function runTranslationValidation(args: Omit<TranslationValidationWorkerInput, "runId" | "journalPath"> & {
  signal?: AbortSignal;
  onProgress?: (completedLines: number, totalLines: number) => void;
  diagnostics?: { outputDir: string; documentId: string; phase: string; fromLine?: number; toLine?: number };
}): Promise<TranslationValidationResult> {
  args.signal?.throwIfAborted();
  const runId = randomUUID();
  const started = Date.now();
  const journalPath = args.diagnostics
    ? path.join(args.diagnostics.outputDir, ".translation-workshop", "agent", "validation", "events.jsonl")
    : undefined;
  const record = async (event: string, extra: Record<string, unknown> = {}) => {
    if (journalPath) await appendFile(journalPath, `${JSON.stringify({
      at: new Date().toISOString(), runId, ...args.diagnostics, outputDir: undefined,
      event, elapsedMs: Date.now() - started, ...extra
    })}\n`);
  };
  if (journalPath) await mkdir(path.dirname(journalPath), { recursive: true });
  await record("started", { sourceChars: args.sourceText.length, candidateChars: args.candidateText.length, memory: process.memoryUsage() });
  try {
    args.signal?.throwIfAborted();
    const workerUrl = new URL(import.meta.url.endsWith(".ts")
      ? "./translationValidationWorker.ts" : "./translationValidationWorker.js", import.meta.url);
    const result = await new Promise<TranslationValidationResult>((resolve, reject) => {
      const worker = new Worker(workerUrl, {
        workerData: { sourceText: args.sourceText, candidateText: args.candidateText,
          validationOptions: args.validationOptions, runId, journalPath } satisfies TranslationValidationWorkerInput,
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type") && !/^--expose[-_]gc(?:=|$)/.test(arg))
      });
      let result: TranslationValidationResult | undefined;
      let failure: unknown;
      const stop = (error: unknown) => {
        failure ??= error;
        void worker.terminate().catch((terminateError) => {
          failure = new AggregateError([failure, terminateError], "Translation validation worker termination failed.");
        });
      };
      const abort = () => stop(args.signal?.reason ?? new Error("Translation validation aborted."));
      worker.on("message", (message) => {
        if (failure !== undefined) return;
        if (message.type === "result") result = message.validation;
        else if (message.type === "progress") {
          try { args.onProgress?.(message.completedLines, message.totalLines); }
          catch (error) { stop(error); }
        }
      });
      worker.once("error", (error) => { failure ??= error; });
      worker.once("exit", (code) => {
        args.signal?.removeEventListener("abort", abort);
        if (failure !== undefined) reject(failure);
        else if (code !== 0 || !result) reject(new Error(`Translation validation worker exited without a result (code ${code}).`));
        else resolve(result);
      });
      if (args.signal?.aborted) abort();
      else args.signal?.addEventListener("abort", abort, { once: true });
    });
    args.signal?.throwIfAborted();
    await record("completed", { sourceLineCount: result.sourceLineCount, candidateLineCount: result.candidateLineCount,
      blockingCount: result.blocking.length, warningCount: result.warnings.length, memory: process.memoryUsage() });
    args.signal?.throwIfAborted();
    return result;
  } catch (error) {
    try { await record(args.signal?.aborted ? "cancelled" : "failed", { error: error instanceof Error ? error.message : String(error) }); }
    catch (journalError) { throw new AggregateError([error, journalError], "Translation validation and diagnostic persistence failed."); }
    throw error;
  }
}
