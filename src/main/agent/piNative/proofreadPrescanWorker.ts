import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { buildProofreadDeterministicSignals, type ProofreadPrescanProgress } from "./proofreadPrescan.ts";
import type { ProofreadPrescanWorkerInput } from "./proofreadPrescanService.ts";

const input = workerData as ProofreadPrescanWorkerInput;
const started = Date.now();
let previousPhase = "";
let lastProgressAt = 0;
const signals = buildProofreadDeterministicSignals({
  ...input.scan,
  onProgress(progress: ProofreadPrescanProgress) {
    const now = Date.now();
    if (progress.phase === previousPhase && now - lastProgressAt < 1000) return;
    previousPhase = progress.phase;
    lastProgressAt = now;
    if (input.journalPath) appendFileSync(input.journalPath, `${JSON.stringify({
      at: new Date(now).toISOString(), runId: input.runId, event: "progress", ...progress, elapsedMs: now - started
    })}\n`);
    parentPort!.postMessage({ type: "progress", progress });
  }
});
parentPort!.postMessage({ type: "result", signals });
