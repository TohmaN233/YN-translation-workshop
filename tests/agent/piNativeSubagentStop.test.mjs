import { strict as assert } from "node:assert";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function waitUntil(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-stop-"));
const sourcePath = path.join(workspaceDir, "source.txt");
await writeFile(sourcePath, "one\ntwo", "utf8");
const releaseChildren = deferred();
const models = createModels();
const providers = new Map();

const parent = fauxProvider({ provider: "parent", tokensPerSecond: 1000 });
models.setProvider(parent.provider);
providers.set(parent.provider.id, parent);
parent.setResponses([
  fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {}, { id: "spawn-children" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Children started; the parent turn is complete."))
]);

for (const [index, providerId] of ["child-a", "child-b"].entries()) {
  const child = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(child.provider);
  providers.set(providerId, child);
  child.setResponses([
    async () => {
      await releaseChildren.promise;
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: index + 1, translation: index === 0 ? "一" : "二" }]
      }, { id: `${providerId}-write` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxText(`Child ${providerId} should never complete after Stop.`))
  ]);
}

let translationSelectionCount = 0;
const service = new PiNativeSessionService({
  createModelSelection: async ({ providerId }) => {
    const provider = providerId === "translation-test-lane"
      ? providers.get(["child-a", "child-b"][translationSelectionCount++])
      : providers.get(providerId || "parent");
    assert.ok(provider, `unknown test provider ${providerId}`);
    return {
      models,
      model: provider.getModel(),
      providerId: providerId === "translation-test-lane" ? providerId : provider.provider.id,
      modelId: provider.getModel().id
    };
  },
  createTools: createYnDomainTools,
  buildSystemPrompt: () => "Use YN native tools.",
  enforceDomainCompletion: false
});

try {
  const session = await service.createSession(workspaceDir);
  await service.prompt({
    outputDir: workspaceDir,
    sessionId: session.id,
    prompt: "Workflow: yn-translation-v1.\nStart two translation children.",
    workflowIntent: "translation",
    providerId: "parent",
    modelId: parent.getModel().id,
    languagePair: "en->zh-CN",
    subagentProviderId: "translation-test-lane",
    subagentModelId: providers.get("child-a").getModel().id,
    subagentCount: 2,
    translationSplitSize: 1,
    sourcePath
  });
  try {
    await waitUntil(async () => {
      const state = await service.getRunState(workspaceDir, session.id);
      const messages = await service.loadMessages(workspaceDir, session.id);
      return !state.running
        && messages.filter((message) => message.role === "custom" && message.details?.status === "running").length === 2;
    }, "an idle parent with two running child cards");
  } catch (error) {
    const state = await service.getRunState(workspaceDir, session.id);
    const messages = await service.loadMessages(workspaceDir, session.id);
    const cards = messages
      .filter((message) => message.role === "custom")
      .map((message) => ({ status: message.details?.status, error: message.details?.error }));
    throw new Error(`${error.message}; state=${JSON.stringify(state)}; cards=${JSON.stringify(cards)}`);
  }

  await assert.rejects(
    service.compact({
      outputDir: workspaceDir,
      sessionId: session.id,
      providerId: "parent",
      modelId: parent.getModel().id,
      thinkingLevel: "off"
    }),
    /background subagents are running/i
  );
  const stateAfterRejectedCompaction = await service.getRunState(workspaceDir, session.id);
  assert.equal(stateAfterRejectedCompaction.running, false);
  assert.equal(
    stateAfterRejectedCompaction.subagentMessages.filter((message) => message.details?.status === "running").length,
    2
  );

  const abortStartedAt = Date.now();
  const abortTask = service.abort(workspaceDir, session.id);
  setTimeout(() => releaseChildren.resolve(), 25);
  await Promise.race([
    abortTask,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Child-only Stop deadlocked")), 2000))
  ]);
  assert.ok(Date.now() - abortStartedAt < 2000);

  const messages = await service.loadMessages(workspaceDir, session.id);
  const children = messages.filter((message) => message.role === "custom" && message.details?.subagentId);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((message) => message.details.status).sort(), ["stopped", "stopped"]);
  assert.equal(messages.some((message) => message.role === "custom" && message.customType === "subagent-completion"), false);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 2);
  await assert.rejects(access(path.join(workspaceDir, "AI_translation", "source_translated.txt")));
} finally {
  releaseChildren.resolve();
  await service.disposeWorkspace(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("ok active Pi children block compaction and child-only Stop terminates them without stale writes or wakeups");
