import { Worker } from "node:worker_threads";
export interface LineStateWorkerRequest {
  statePath: string; projectRoot?: string; state: unknown; changedLines: number[]; changedStateKeys: string[];
  mutationAccepted: boolean; hydrate: boolean; expectedRevision?: number;
}
// The caller owns the existing sidecar queue. This worker never outlives an
// accepted commit: close/quit drains the same queue and waits for atomic write.
export function commitLineReviewStateInWorker(input: LineStateWorkerRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./lineReviewStateWorker.ts" : "./lineReviewStateWorker.js", import.meta.url), {
      workerData: input, execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type") && !/^--expose[-_]gc/.test(arg))
    });
    let result: Record<string, unknown> | undefined, failure: unknown;
    worker.once("message", message => { result = message; });
    worker.once("error", error => { failure = error; });
    worker.once("exit", code => {
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Line-review state worker exited without commit evidence (code ${code}).`));
      else resolve(result);
    });
  });
}
