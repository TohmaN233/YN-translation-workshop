import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function countToolCalls(messages, name) {
  return messages.reduce((count, message) => (
    count + (message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall" && block.name === name).length
      : 0)
  ), 0);
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-completion-"));
const sourcePath = path.join(workspaceDir, "source.txt");
const translationPath = path.join(workspaceDir, "translation.txt");
await writeFile(sourcePath, "hello\ngoodbye\nyes\nno", "utf8");
await writeFile(translationPath, "\u4f60\u597d\n\u518d\u89c1\n\u662f\n\u5426", "utf8");

const releaseChildren = deferred();
const models = createModels();
const providers = new Map();
const parent = fauxProvider({ provider: "proofread-parent", tokensPerSecond: 1000 });
models.setProvider(parent.provider);
providers.set(parent.provider.id, parent);
parent.setResponses([
  fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "inspect-proofread" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("runProofreadSubagents", {
    workers: [
      { providerId: "proofread-child-a", label: "review-1" },
      { providerId: "proofread-child-b", label: "review-2" }
    ]
  }, { id: "spawn-proofread" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The proofread children are running; the parent remains available.")),
  fauxAssistantMessage(fauxToolCall("finalizeProofreadReport", {}, {
    id: "finalize-proofread-report"
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The normalized proofreading report was merged, inspected, and host-validated."))
]);

for (const providerId of ["proofread-child-a", "proofread-child-b"]) {
  const child = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(child.provider);
  providers.set(providerId, child);
  child.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}, {
      id: `${providerId}-context`
    }), { stopReason: "toolUse" }),
    async () => {
      await releaseChildren.promise;
      return fauxAssistantMessage(fauxToolCall("writeAssignedFindings", {
        findings: []
      }, { id: `${providerId}-findings` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxText(`Child ${providerId} completed its proofread range.`))
  ]);
}

const service = new PiNativeSessionService({
  createModelSelection: async ({ providerId }) => {
    const provider = providers.get(providerId || parent.provider.id);
    assert.ok(provider, `unknown test provider ${providerId}`);
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  },
  createTools: createYnDomainTools,
  buildSystemPrompt: () => "Use native YN proofreading tools and inspect the merged report before reporting completion.",
  enforceDomainCompletion: true
});

let settledCount = 0;
const waiters = [];
const unsubscribe = service.subscribeEvents((entry) => {
  if (entry.event.type !== "settled") return;
  settledCount += 1;
  for (const waiter of [...waiters]) if (settledCount >= waiter.count) waiter.resolve();
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
const waitUntil = async (predicate, label) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

try {
  const session = await service.createSession(workspaceDir);
  await service.prompt({
    outputDir: workspaceDir,
    sessionId: session.id,
    prompt: "Workflow: yn-proofread-v1.\nUse 2 subagents in parallel to proofread the complete aligned document.",
    workflowIntent: "proofread",
    languagePair: "en->zh-CN",
    providerId: parent.provider.id,
    modelId: parent.getModel().id,
    sourcePath,
    translationPath,
    proofreadSplitSize: 2,
    subagentEnabled: true,
    subagentCount: 2
  });
  await waitForSettled(1);
  await waitUntil(async () => (
    (await service.getRunState(workspaceDir, session.id)).subagentMessages
      .filter((message) => message.details?.status === "running").length === 2
  ), "two running proofread children");

  releaseChildren.resolve();
  await waitForSettled(2);

  const messages = await service.loadMessages(workspaceDir, session.id);
  assert.equal(countToolCalls(messages, "runProofreadSubagents"), 1);
  assert.equal(countToolCalls(messages, "finalizeProofreadReport"), 1);
  assert.ok(messages.some((message) => (
    message.role === "custom"
    && message.customType === "subagent-completion"
    && message.display === false
  )));
  assert.ok(messages.some((message) => (
    message.role === "assistant"
    && /host-validated/.test(messageText(message))
  )));

  const report = JSON.parse(await readFile(path.join(workspaceDir, "report", "source.proofread.json"), "utf8"));
  assert.equal(report.findings.length, 0);
  assert.equal(Object.hasOwn(report, "summaryPath"), false);
  await assert.rejects(
    readFile(path.join(workspaceDir, "report", "source_proofread_summary.md"), "utf8"),
    { code: "ENOENT" }
  );
  const state = await service.getRunState(workspaceDir, session.id);
  assert.equal(state.running, false);
  assert.equal(state.phase, "idle");
  assert.equal(state.error, undefined);
} finally {
  releaseChildren.resolve();
  unsubscribe();
  await service.disposeWorkspace(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("ok native proofread completion wakes the parent to inspect the merged validated findings report");
