import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import { agentUiStrings } from "../../src/renderer/agent/piweb/i18n.ts";

async function loadAgentSessionModule() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "yn-warning-review-ui-"));
  const outfile = path.join(tempDir, "useAgentSession.mjs");
  await build({
    entryPoints: [path.resolve("src/renderer/agent/piweb/useAgentSession.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm"
  });
  return {
    module: await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`),
    close: () => rm(tempDir, { recursive: true, force: true })
  };
}

const loaded = await loadAgentSessionModule();
try {
  const review = { id: "synthetic-review-1", warningCount: 3 };
  const current = {
    sessionId: "synthetic-session",
    sessions: [],
    messages: [],
    streamingMessage: null,
    agentRunning: false,
    storagePreparing: false,
    storageProgress: null,
    phase: null,
    phaseText: "ready",
    retryInfo: null,
    providerId: "synthetic-provider",
    modelId: "synthetic-model",
    modelList: [],
    modelNames: {},
    thinkingLevel: "high",
    queuedSteer: [],
    queuedFollowUp: [],
    queuedNextTurn: [],
    isCompacting: false,
    compactResult: null,
    compactError: null,
    contextUsage: null,
    warningReview: { id: "stale-review", warningCount: 1 },
    warningReviewSequence: 0,
    lastSequence: 4
  };
  const runState = {
    sessionId: current.sessionId,
    sequence: 1,
    running: false,
    compacting: false,
    streamingMessage: null,
    queuedSteer: [],
    queuedFollowUp: [],
    queuedNextTurn: [],
    subagentMessages: [],
    contextUsage: null,
    thinkingLevel: "off",
    warningReview: review
  };
  assert.deepEqual(
    loaded.module.mergePiRunState(current, runState).warningReview,
    review,
    "a newer message event must not outrank the warning snapshot inside an older full run-state read"
  );
  assert.equal(
    loaded.module.mergePiRunState(current, { ...runState, warningReview: undefined }).warningReview,
    undefined,
    "a Host snapshot without a choice clears the previous choice"
  );
  const newerEmptySnapshot = loaded.module.mergePiRunState(current, {
    ...runState,
    sequence: 5,
    warningReview: undefined
  });
  assert.equal(newerEmptySnapshot.warningReview, undefined);
  assert.equal(newerEmptySnapshot.warningReviewSequence, 5);
  const lateOldSnapshot = loaded.module.mergePiRunState(newerEmptySnapshot, runState);
  assert.equal(lateOldSnapshot.warningReview, undefined, "a genuinely newer full snapshot must reject older choice data");
  assert.equal(lateOldSnapshot.warningReviewSequence, 5);

  const route = {
    outputDir: "C:/synthetic-project",
    languagePair: "zh->en",
    sourcePath: "C:/synthetic-project/source.txt",
    sourceKind: "file",
    translationPath: "C:/synthetic-project/translation.txt",
    lineReviewPath: "C:/synthetic-project/review.html"
  };
  const metadata = {
    workflowIntent: "translation",
    languagePair: "zh->en",
    style: "plain",
    workDescription: "Synthetic translation",
    glossaryPath: "C:/synthetic-project/glossary.md",
    glossaryCandidates: true,
    characterBible: true,
    reuseExistingTranslation: true,
    translationSplitSize: 500
  };
  const image = { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" };
  const promptRequest = loaded.module.buildPiSessionPromptRequest(
    route,
    current,
    current.sessionId,
    "synthetic prompt",
    [image],
    metadata
  );
  assert.equal(promptRequest.providerId, "synthetic-provider");
  assert.equal(promptRequest.modelId, "synthetic-model");
  assert.equal(promptRequest.sourcePath, route.sourcePath);
  assert.deepEqual(promptRequest.sourceSelection, { kind: "file", path: route.sourcePath });
  assert.equal(promptRequest.translationPath, route.translationPath);
  assert.equal(promptRequest.lineReviewPath, route.lineReviewPath);
  assert.equal(promptRequest.style, "plain");
  assert.deepEqual(promptRequest.images, [image]);

  const decisionRequest = loaded.module.buildWarningReviewDecisionRequest(
    route,
    current,
    current.sessionId,
    review.id,
    "review",
    metadata
  );
  assert.deepEqual(
    { outputDir: decisionRequest.outputDir, sessionId: decisionRequest.sessionId, reviewId: decisionRequest.reviewId, decision: decisionRequest.decision },
    { outputDir: route.outputDir, sessionId: current.sessionId, reviewId: review.id, decision: "review" }
  );
  assert.equal(decisionRequest.request.providerId, current.providerId);
  assert.equal(decisionRequest.request.modelId, current.modelId);
  assert.equal(decisionRequest.request.sourcePath, route.sourcePath);
  assert.equal(decisionRequest.request.translationPath, route.translationPath);
  for (const key of ["outputDir", "sessionId", "reviewId", "decision", "prompt", "images", "taskPreparation", "workflowIntent"]) {
    assert.equal(Object.hasOwn(decisionRequest.request, key), false, `decision fallback must omit ${key}`);
  }
  assert.equal(
    Object.hasOwn(loaded.module.buildWarningReviewDecisionRequest(route, { ...current, providerId: "", modelId: "" }, current.sessionId, review.id, "skip", metadata), "request"),
    false,
    "the optional fallback is omitted until a current model is available"
  );
  assert.notEqual(
    loaded.module.warningReviewChoiceKey(route.outputDir, current.sessionId, review.id),
    loaded.module.warningReviewChoiceKey(route.outputDir, "other-session", review.id)
  );
} finally {
  await loaded.close();
}

const clientModule = await import("../../src/renderer/agent/piweb/electronPiSessionClient.ts");
const previousWindow = globalThis.window;
const bridgeCalls = [];
let promptCalls = 0;
globalThis.window = {
  workshop: {
    agentSession: {
      decideTranslationWarningReview: async (request) => {
        bridgeCalls.push(request);
        return { decision: request.decision, continuing: request.decision === "review" };
      },
      sendPrompt: async () => {
        promptCalls += 1;
      }
    }
  }
};
try {
  const request = {
    outputDir: "C:/synthetic-project",
    sessionId: "synthetic-session",
    reviewId: "synthetic-review-1",
    decision: "skip"
  };
  assert.deepEqual(await clientModule.electronPiSessionClient.decideTranslationWarningReview(request), {
    decision: "skip",
    continuing: false
  });
  assert.deepEqual(bridgeCalls, [request]);
  assert.equal(promptCalls, 0, "a warning decision must not send a model prompt");
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

const hookSource = await readFile("src/renderer/agent/piweb/useAgentSession.ts", "utf8");
assert.match(hookSource, /const warningReviewSnapshotIsCurrent = runState\.sequence >= \(current\.warningReviewSequence \?\? 0\)/);
assert.match(hookSource, /warningReview:\s*warningReviewSnapshotIsCurrent \? runState\.warningReview : current\.warningReview/);
const handlerStart = hookSource.indexOf("const handleWarningReviewDecision =");
const handlerEnd = hookSource.indexOf("const handleCompact =", handlerStart);
assert.notEqual(handlerStart, -1);
assert.notEqual(handlerEnd, -1);
const warningDecisionHandler = hookSource.slice(handlerStart, handlerEnd);
assert.match(warningDecisionHandler, /electronPiSessionClient\.decideTranslationWarningReview/);
assert.doesNotMatch(warningDecisionHandler, /sendPrompt|handleSend/);
assert.match(warningDecisionHandler, /current\.agentRunning/);
assert.match(warningDecisionHandler, /current\.isCompacting/);

const chatWindowSource = await readFile("src/renderer/agent/piweb/ChatWindow.tsx", "utf8");
assert.match(chatWindowSource, /role="alertdialog"/);
assert.match(chatWindowSource, /data-agent-warning-review="true"/);
assert.match(chatWindowSource, /data-agent-warning-review-decision="review"/);
assert.match(chatWindowSource, /data-agent-warning-review-decision="skip"/);
assert.equal((chatWindowSource.match(/disabled=\{warningReviewSubmitting \|\| sessionBusy\}/g) ?? []).length, 2);

assert.equal(agentUiStrings["zh-CN"].warningReviewYes, "是，继续审查");
assert.equal(agentUiStrings["zh-CN"].warningReviewNo, "否，跳过");
assert.match(agentUiStrings["zh-CN"].warningReviewDescription.replace("{count}", "3"), /3 条警告/);
assert.equal(agentUiStrings["en-US"].warningReviewYes, "Yes, review");
assert.equal(agentUiStrings["en-US"].warningReviewNo, "No, skip");
assert.match(agentUiStrings["en-US"].warningReviewDescription.replace("{count}", "3"), /3 warnings/);
