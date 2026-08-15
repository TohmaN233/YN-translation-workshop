import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const source = await readFile("scripts/verify-electron-agent-folder-history-main.ts", "utf8");
const launcher = await readFile("scripts/verify-electron-agent-folder-history.mjs", "utf8");
const measuredRunStart = source.indexOf("await installRendererBatchSignal(win, workerCount, batchTimeoutMs)");
const measuredRunEnd = source.indexOf("await resourceSampler.stop()", measuredRunStart);

assert.ok(measuredRunStart >= 0 && measuredRunEnd > measuredRunStart,
  "could not locate the measured Electron folder-run boundary");
const measuredRun = source.slice(measuredRunStart, measuredRunEnd);
assert.equal(measuredRun.includes("await waitFor("), false,
  "the measured run must not poll the renderer with waitFor/executeJavaScript");
assert.match(measuredRun, /await awaitRendererBatchSignal\(win\)/,
  "the measured run must await its one-shot renderer completion signal");
assert.match(source, /new MutationObserver\(scheduleInspect\)/,
  "the renderer completion signal must be event driven");
assert.match(source, /peakRendererPingMs < 250/,
  "the renderer event-loop lag gate must reject visibly frozen runs");
assert.equal(source.includes("peakRendererWorkingSetMb < 512"), false,
  "an absolute Chromium working-set gate must not confuse shared-page baseline variation with product growth");
assert.match(source, /peakRendererPrivateMb < 384/,
  "the verifier must bound renderer-owned private memory");
assert.match(source, /rendererWorkingSetGrowthMb < 192/,
  "the verifier must bound working-set growth above the measured idle baseline");
assert.match(source, /rendererPrivateGrowthMb < 192/,
  "the verifier must bound private-memory growth above the measured idle baseline");

assert.match(source, /YN_REAL_FOLDER_PROVIDER_MODE/,
  "the retained-folder verifier must expose an explicit real-provider mode");
assert.match(source, /createPiModelSelection/,
  "real folder acceptance must use the product Pi provider registry rather than a verifier provider shim");
assert.match(source, /buildYnSystemPrompt/,
  "real folder acceptance must use the product YN/Pi system prompt");
assert.match(source, /readOAuthProfiles/,
  "real folder acceptance must copy the configured OAuth profile without embedding credentials");
assert.match(source, /realProviderMode[\s\S]*allWorkersCompleted[\s\S]*hasFinalValidation/,
  "real completion must be event driven from closed Pi workers and the final validation tool, not a fake text marker");
assert.match(source, /validateTranslationCandidate\(sourceText, candidateText/,
  "the verifier must independently host-validate every translated file");
assert.match(launcher, /YN_REAL_FOLDER_TIMEOUT_MS:\s*String\(verificationTimeoutMs\)/,
  "the launcher must pass the user-approved real-provider deadline into the Electron verifier");
assert.match(source, /YN_REAL_FOLDER_TIMEOUT_MS/,
  "the Electron verifier must consume the launcher deadline instead of silently reverting to 20 minutes");
assert.match(source, /1_320_000/,
  "real folder acceptance must cap the approved fluctuation at a 22-minute hard deadline");

console.log("ok real-folder resource verification uses an event-driven completion signal during sampling");
