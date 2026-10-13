import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { validateTranslationCandidate } from "../../../shared/validation/translationValidator.ts";
import type { TranslationValidationWorkerInput } from "./translationValidationService.ts";
import { executeArtifactOperation } from "../artifactValidationWorkerTasks.ts";
import { ArtifactCancelledError, serializeArtifactError, deserializeArtifactError, type ArtifactErrorPacket } from "../artifactCancellation.ts";

if (workerData.artifact) {
  try {
  const started = Date.now();
  const result = await executeArtifactOperation(workerData.artifact, (phase, completedLines, totalLines) => {
    if (workerData.artifactJournal) appendFileSync(workerData.artifactJournal, JSON.stringify({
      at: new Date().toISOString(), requestId: workerData.requestId, event: "progress", phase: `artifact-${phase}`,
      completedLines, totalLines, elapsedMs: Date.now() - started, memory: process.memoryUsage()
    }) + "\n");
    parentPort!.postMessage({ type: "progress", phase, completedLines, totalLines });
  }, () => { if (Atomics.load(new Int32Array(workerData.cancellation), 0)) throw new ArtifactCancelledError(); }, () => new Promise<void>((resolve, reject) => {
    const receive = (message: { type: string; ok: boolean; error?: ArtifactErrorPacket }) => {
      if (message.type !== "memory-decision") return;
      parentPort!.removeListener("message", receive);
      if (message.ok) resolve(); else reject(deserializeArtifactError(message.error!));
    };
    parentPort!.on("message", receive);
    parentPort!.postMessage({ type: "memory-precommit" });
  }));
  parentPort!.postMessage({ type: "artifact-result", result });
  } catch (error) { parentPort!.postMessage({ type: "artifact-failure", error: serializeArtifactError(error) }); }
} else {
const input = workerData as TranslationValidationWorkerInput;
const started = Date.now();
let lastProgressAt = 0;
parentPort!.postMessage({ type: "progress", completedLines: 0, totalLines: 0 });
const validation = validateTranslationCandidate(input.sourceText, input.candidateText, input.validationOptions,
  (completedLines, totalLines) => {
    const now = Date.now();
    if (completedLines !== totalLines && now - lastProgressAt < 1000) return;
    lastProgressAt = now;
    if (input.journalPath) appendFileSync(input.journalPath, `${JSON.stringify({
      at: new Date(now).toISOString(), runId: input.runId, event: "progress", completedLines, totalLines,
      elapsedMs: now - started, memory: process.memoryUsage()
    })}\n`);
    parentPort!.postMessage({ type: "progress", completedLines, totalLines });
  });
parentPort!.postMessage({ type: "result", validation });
}
