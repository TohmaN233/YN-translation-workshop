import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";

import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import {
  appendYnSessionHostState,
  loadYnSessionHostState
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-session-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt"
});
await mkdir(path.dirname(candidatePath), { recursive: true });
await mkdir(path.join(outputDir, "AI_translation", "_workspace"), { recursive: true });
await writeFile(sourcePath, "Open the gate.\nSave now.\n", "utf8");
await writeFile(candidatePath, "打开大门。\n现在保存。\n", "utf8");
await writeFile(path.join(outputDir, "AI_translation", "_workspace", "glossary_candidates.json"), '{"entries":[]}\n', "utf8");
await writeFile(path.join(outputDir, "AI_translation", "_workspace", "character_bible.md"), "# Character Bible\n", "utf8");

const models = createModels();
const provider = fauxProvider({ provider: "parent", tokensPerSecond: 1000 });
models.setProvider(provider.provider);
const toolContexts = [];

const createService = () => new PiNativeSessionService({
  createModelSelection: async () => ({
    models,
    model: provider.getModel(),
    providerId: provider.provider.id,
    modelId: provider.getModel().id
  }),
  createTools: (context) => {
    toolContexts.push(context);
    return createYnDomainTools(context);
  },
  buildSystemPrompt: () => "Use the YN host tools and obey their typed results.",
  enforceDomainCompletion: true
});
let service = createService();

let settledCount = 0;
const waiters = [];
let unsubscribe = service.subscribeEvents((entry) => {
  if (entry.event.type !== "settled") return;
  settledCount += 1;
  for (const waiter of waiters) if (settledCount >= waiter.count) waiter.resolve();
});
const waitForSettled = (count) => {
  if (settledCount >= count) return Promise.resolve();
  const pending = deferred();
  waiters.push({ count, resolve: pending.resolve });
  return Promise.race([
    pending.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for settled ${count}`)), 5000))
  ]);
};

try {
  const session = await service.createSession(outputDir);
  const promptRequest = {
    outputDir,
    sessionId: session.id,
    workflowIntent: "translation",
    languagePair: "en->zh-CN",
    providerId: provider.provider.id,
    modelId: provider.getModel().id,
    sourcePath,
    reuseExistingTranslation: true,
    subagentEnabled: false,
    subagentCount: 0
  };

  // Both existing translations pass the Host quick scan, so the native Pi loop
  // must ask for the reuse decision without creating a semantic child pass.
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "inspect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("prepareTranslationReuseAudit", {}, { id: "prepare" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("现有译文两行都通过快速检查。是否保留这两行并只处理其余内容？"))
  ]);

  await service.prompt({
    ...promptRequest,
    prompt: "Workflow: yn-translation-v1.\nResume this interrupted translation without discarding usable work."
  });
  await waitForSettled(1);

  let state = await service.getRunState(outputDir, session.id);
  assert.equal(state.running, false);
  assert.equal(state.error, undefined);
  let messages = await service.loadMessages(outputDir, session.id);
  assert.ok(messages.some((message) => message.role === "assistant" && String(message.content?.[0]?.text || "").includes("是否保留")));
  assert.equal(messages.some((message) => message.role === "custom" && message.customType === "yn-domain-repair"), false);
  const preparedAudit = messages.find((message) => message.role === "toolResult" && message.toolCallId === "prepare");
  const auditId = preparedAudit?.details?.singleAudit?.auditId;
  assert.equal(typeof auditId, "string");

  unsubscribe();
  await service.disposeWorkspace(outputDir);
  const reopenedBeforeResume = await new PiSessionRepository(outputDir).open(session.id);
  const persistedBeforeResume = await loadYnSessionHostState(reopenedBeforeResume, session.id);
  assert.ok(persistedBeforeResume?.domainRun, "reuse verifier could not load the suspended Host snapshot");
  await appendYnSessionHostState(reopenedBeforeResume, {
    ...persistedBeforeResume,
    workflowSuspended: true,
    domainRun: {
      ...persistedBeforeResume.domainRun,
      pendingTranslationReuseAuditIds: [],
      userAuthorizedTranslationReuseAuditIds: []
    }
  });
  service = createService();
  unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    for (const waiter of waiters) if (settledCount >= waiter.count) waiter.resolve();
  });

  const preparedProofread = await service.prepareRuntime({
    ...promptRequest,
    workflowIntent: "proofread",
    proofreadMode: "split",
    prompt: "Workflow: yn-proofread-v1.\nProofread without inheriting the parked translation decision."
  });
  assert.equal(preparedProofread.active.domainRun.kind, "proofread");
  assert.deepEqual(
    preparedProofread.active.hostState.parkedDomainRuns.translation?.pendingTranslationReuseAuditIds,
    [],
    "a pending translation audit leaked into the independent proofreading contract"
  );
  preparedProofread.active.runtime.dispose();
  preparedProofread.active.subagents.abortAll();
  await preparedProofread.active.subagents.waitForAll();

  const unrelatedSession = await service.createSession(outputDir);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("applyTranslationReuseDecision", {
      decision: "discard_existing"
    }, { id: "cross-session-apply" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("无法修改另一个会话拥有的审计。"))
  ]);
  await service.prompt({
    ...promptRequest,
    sessionId: unrelatedSession.id,
    workflowIntent: undefined,
    prompt: "你好"
  });
  await waitForSettled(2);
  const unrelatedMessages = await service.loadMessages(outputDir, unrelatedSession.id);
  const rejectedCrossSessionApply = unrelatedMessages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "cross-session-apply"
  ));
  assert.equal(rejectedCrossSessionApply?.role, "toolResult");
  assert.equal(rejectedCrossSessionApply?.isError, true,
    "an unrelated session must not inherit an ambient project-level reuse decision authorization");
  assert.equal(await readFile(candidatePath, "utf8"), "打开大门。\n现在保存。\n");

  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("applyTranslationReuseDecision", {
      decision: "reuse_accepted"
    }, { id: "apply" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspectTranslationAlignment", {}, {
      id: "inspect-reused-alignment"
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readSourceLines", {
      fromLine: 1,
      toLine: 2
    }, { id: "read-reused-source" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readTranslationLines", {
      fromLine: 1,
      toLine: 2
    }, { id: "read-reused-translation" }), { stopReason: "toolUse" }),
    (context) => {
      const inspected = [...context.messages].reverse().find((message) => (
        message.role === "toolResult" && message.toolName === "inspectTranslationAlignment"
      ));
      const text = Array.isArray(inspected?.content) ? inspected.content[0]?.text : inspected?.content;
      const payload = JSON.parse(text);
      return fauxAssistantMessage(fauxToolCall("recordTranslationAlignmentChecks", {
        auditId: payload.auditId,
        failures: []
      }, { id: "record-reused-alignment" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, { id: "validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("已保留通过审计的译文并完成整体验证。"))
  ]);
  await service.prompt({ ...promptRequest, workflowIntent: undefined, prompt: "保留通过的译文。" });
  await waitForSettled(3);
  state = await service.getRunState(outputDir, session.id);
  assert.equal(state.running, false);
  messages = await service.loadMessages(outputDir, session.id);
  assert.equal(
    state.error,
    undefined,
    `the resumed reuse workflow must settle after validation: ${JSON.stringify(messages.slice(-8))}`
  );
  const resumedContext = toolContexts.at(-1);
  assert.equal(
    resumedContext?.domainRun?.fullWorkflow,
    true,
    "applying the explicit reuse decision must atomically restore the parked full workflow"
  );
  assert.equal(
    resumedContext?.domainRun?.kind,
    "translation",
    "the reuse decision must restore the parked translation workflow kind"
  );
  assert.equal(
    resumedContext?.domainRun?.suspended,
    false,
    "the reuse decision must leave the restored full workflow active without a separate resume turn"
  );
  const applied = messages.find((message) => message.role === "toolResult" && message.toolCallId === "apply");
  assert.equal(applied?.role, "toolResult");
  assert.equal(
    applied?.isError,
    false,
    `cold restart must restore the pending Host audit before accepting the next user turn: ${JSON.stringify(applied)}`
  );
  const alignment = messages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "record-reused-alignment"
  ));
  assert.equal(alignment?.isError, false,
    "accepting the reuse decision must not bypass the independent final line-identity audit");
  assert.equal(await readFile(candidatePath, "utf8"), "打开大门。\n现在保存。\n");
} finally {
  unsubscribe();
  await service.disposeWorkspace(outputDir);
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok native Pi pauses for the reuse decision without a fake workflow error, then resumes the same audit");
