import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  normalizeCustomPreserveRules,
  type CanonicalCustomPreserveRule,
} from "../../shared/validation/customPreserveRules.ts";

export interface SourcePreparationNeighbor {
  line: number;
  text: string;
  truncated: boolean;
}

export interface SourcePreparationExample {
  path: string;
  line: number;
  text: string;
  match: string;
  textTruncated: boolean;
  matchTruncated: boolean;
  before?: SourcePreparationNeighbor;
  after?: SourcePreparationNeighbor;
}

export interface SourcePreparationFileDigest {
  path: string;
  sha256: string;
  lineCount: number;
  samples: SourcePreparationNeighbor[];
}

export interface SourcePreparationPatternReport {
  label: string;
  pattern: string;
  flags: string;
  matchCount: number;
  linesWithMatches: number;
  filesWithMatches: number;
  examples: SourcePreparationExample[];
}

export interface SourcePreparationRuleEvaluation extends SourcePreparationPatternReport {
  totalLines: number;
  fullLineMatches: number;
  lineCoverage: number;
  fileCoverage: number;
}

export interface SourcePreparationScanReport {
  files: SourcePreparationFileDigest[];
  totalFiles: number;
  totalLines: number;
  candidates: SourcePreparationPatternReport[];
  existingRules: SourcePreparationRuleEvaluation[];
  exampleLimit: number;
  exampleTextLimit: number;
}

interface ScanWorkerInput {
  files: string[];
  rules: CanonicalCustomPreserveRule[];
  exampleLimit: number;
  exampleTextLimit: number;
}

type WorkerMessage =
  | { type: "rule-start"; index: number; label: string; pattern: string }
  | { type: "rule-progress"; index: number }
  | { type: "rule-complete"; index: number }
  | { type: "result"; report: SourcePreparationScanReport }
  | { type: "failure"; message: string; stack?: string };

/** A blocked user-supplied regex is terminated and reported as a failed scan after this idle period. */
export const SOURCE_PREPARATION_RULE_TIMEOUT_MS = 2_000;

export function scanSourcePreparation(args: {
  files: string[];
  rules?: CanonicalCustomPreserveRule[];
  signal?: AbortSignal;
}): Promise<SourcePreparationScanReport> {
  args.signal?.throwIfAborted();
  if (!Array.isArray(args.files)) throw new Error("Source preparation scan files must be an array.");
  const files = args.files.map((file, index) => {
    if (typeof file !== "string" || !file.trim()) {
      throw new Error(`Source preparation scan file ${index + 1} must be a non-empty path.`);
    }
    return path.resolve(file);
  });
  const seen = new Set<string>();
  for (const file of files) {
    const identity = process.platform === "win32" ? file.toLocaleLowerCase("en-US") : file;
    if (seen.has(identity)) throw new Error(`Duplicate source preparation scan file: ${file}`);
    seen.add(identity);
  }
  const rules = normalizeCustomPreserveRules(args.rules);
  args.signal?.throwIfAborted();

  // In source mode the worker sits beside this file. The main esbuild bundle resolves
  // import.meta.url from dist/main/main.js, so the build emits dist/main/sourcePreparationWorker.js.
  const workerUrl = new URL(
    import.meta.url.endsWith(".ts") ? "./sourcePreparationWorker.ts" : "./sourcePreparationWorker.js",
    import.meta.url
  );
  const workerData: ScanWorkerInput = {
    files,
    rules,
    exampleLimit: 8,
    exampleTextLimit: 280
  };

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData,
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type"))
    });
    let report: SourcePreparationScanReport | undefined;
    let failure: unknown;
    let timeout: NodeJS.Timeout | undefined;
    let activeRule: Extract<WorkerMessage, { type: "rule-start" }> | undefined;
    let settled = false;

    const clearRuleTimer = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    };
    const setRuleTimer = () => {
      clearRuleTimer();
      if (!activeRule) return;
      const rule = activeRule;
      timeout = setTimeout(() => {
        failure = new Error(
          `Source preparation scan timed out while evaluating custom preserve rule ${rule.index + 1} `
          + `(${rule.label || rule.pattern}) after ${SOURCE_PREPARATION_RULE_TIMEOUT_MS} ms. `
          + "The scan was stopped; no partial report was returned."
        );
        void worker.terminate().catch((error: unknown) => {
          if (failure instanceof Error && error instanceof Error) {
            failure = new Error(`${failure.message} Worker termination also failed: ${error.message}`);
          }
        });
      }, SOURCE_PREPARATION_RULE_TIMEOUT_MS);
    };
    const abort = () => {
      if (failure !== undefined) return;
      failure = args.signal?.reason ?? new Error("Source preparation scan aborted.");
      clearRuleTimer();
      void worker.terminate().catch((error: unknown) => {
        if (failure instanceof Error && error instanceof Error) {
          failure = new Error(`${failure.message} Worker termination also failed: ${error.message}`);
        }
      });
    };
    const cleanup = () => {
      clearRuleTimer();
      args.signal?.removeEventListener("abort", abort);
    };

    worker.on("message", (rawMessage: WorkerMessage) => {
      if (failure !== undefined) return;
      if (rawMessage.type === "rule-start") {
        activeRule = rawMessage;
        setRuleTimer();
      } else if (rawMessage.type === "rule-progress") {
        if (activeRule?.index === rawMessage.index) setRuleTimer();
      } else if (rawMessage.type === "rule-complete") {
        if (activeRule?.index === rawMessage.index) {
          activeRule = undefined;
          clearRuleTimer();
        }
      } else if (rawMessage.type === "result") {
        report = rawMessage.report;
      } else if (rawMessage.type === "failure") {
        failure = new Error(rawMessage.message);
        if (rawMessage.stack) failure = new Error(rawMessage.message, { cause: rawMessage.stack });
      }
    });
    worker.once("error", (error: Error) => {
      failure ??= error;
    });
    worker.once("exit", (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure !== undefined) reject(failure);
      else if (code !== 0 || !report) {
        reject(new Error(`Source preparation scan worker exited without a complete report (code ${code}).`));
      } else resolve(report);
    });

    if (args.signal?.aborted) abort();
    else args.signal?.addEventListener("abort", abort, { once: true });
  });
}
