import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { validateTranslationCandidate } from "../../../shared/validation/translationValidator.ts";
import type { TranslationValidationWorkerInput } from "./translationValidationService.ts";

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
