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

function text(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolCalls(messages, name) {
  return messages.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall" && block.name === name)
      : []
  ));
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-domain-completion-"));
const sourcePath = path.join(workspaceDir, "source.txt");
await writeFile(sourcePath, "one\ntwo", "utf8");

const releaseChildren = deferred();
const models = createModels();
const providers = new Map();

const parent = fauxProvider({ provider: "parent", tokensPerSecond: 1000 });
models.setProvider(parent.provider);
providers.set(parent.provider.id, parent);
parent.setResponses([
  fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "inspect-context" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {
    tasks: [
      { fromLine: 1, toLine: 1, providerId: "child-a", label: "shard-1" },
      { fromLine: 2, toLine: 2, providerId: "child-b", label: "shard-2" }
    ]
  }, { id: "spawn-children" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("The two native Pi children are running in the background; I remain available.")),
  fauxAssistantMessage(fauxToolCall("readTranslationDiscoveries", {}, {
    id: "read-discoveries"
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("resolveTranslationDiscoveries", {
    characters: [{
      sourceName: "one",
      action: "reject",
      rationale: "The fixture intentionally leaves character identity unsupported."
    }]
  }, { id: "resolve-discoveries" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, {
    id: "validate-final-artifact"
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Both child artifacts were merged and the final host validation passed."))
]);

const reviewer = fauxProvider({ provider: "review", tokensPerSecond: 1000 });
models.setProvider(reviewer.provider);
providers.set(reviewer.provider.id, reviewer);
reviewer.setResponses([1, 2].flatMap((index) => [
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, {
    id: `review-${index}-read`
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, {
    id: `review-${index}-submit`
  }), { stopReason: "toolUse" })
]));

for (const [index, providerId] of ["child-a", "child-b"].entries()) {
  const child = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(child.provider);
  providers.set(providerId, child);
  child.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, {
      id: `${providerId}-read`
    }), { stopReason: "toolUse" }),
    async () => {
      await releaseChildren.promise;
      if (index === 1) await new Promise((resolve) => setTimeout(resolve, 250));
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: index + 1, translation: index === 0 ? "\u4e00" : "\u4e8c" }]
      }, { id: `${providerId}-write` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", index === 0 ? {
      glossaryCandidates: [{
        source: "one",
        target: "\u4e00",
        category: "setting_term",
        evidenceLine: 1,
        rationale: "Potential recurring setting term."
      }],
      characterFacts: [{
        sourceName: "one",
        targetName: "\u4e00",
        evidenceLine: 1,
        evidence: "The assigned source names one without enough context to establish gender.",
        gender: "unknown",
        confidence: "unknown"
      }]
    } : {}, {
      id: `${providerId}-validate`
    }), { stopReason: "toolUse" })
  ]);
}

const service = new PiNativeSessionService({
  createModelSelection: async ({ providerId }) => {
    const provider = providers.get(providerId || "parent");
    assert.ok(provider, `unknown test provider ${providerId}`);
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  },
  createTools: createYnDomainTools,
  buildSystemPrompt: () => "Use only the native YN Pi tools. Validate the complete artifact before reporting completion.",
  enforceDomainCompletion: true
});

let settledCount = 0;
const settledWaiters = [];
const unsubscribe = service.subscribeEvents((entry) => {
  if (entry.event.type !== "settled") return;
  settledCount += 1;
  for (const waiter of [...settledWaiters]) {
    if (settledCount >= waiter.count) waiter.resolve();
  }
});

const waitForSettled = (count) => {
  if (settledCount >= count) return Promise.resolve();
  const pending = deferred();
  settledWaiters.push({ count, resolve: pending.resolve });
  return Promise.race([
    pending.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for parent settled ${count}`)), 5000))
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
    prompt: "Workflow: yn-translation-v1.\nTranslate the bound two-line source with exactly two parallel native Pi children.",
    workflowIntent: "translation",
    languagePair: "en->zh-CN",
    subagentProviderId: "review",
    subagentModelId: reviewer.getModel().id,
    reviewSubagentCount: 1,
    providerId: "parent",
    modelId: parent.getModel().id,
    sourcePath
  });

  await waitForSettled(1);
  await waitUntil(async () => {
    const state = await service.getRunState(workspaceDir, session.id);
    return state.subagentMessages.filter((message) => message.details?.status === "running").length === 2;
  }, "two running native child cards");

  let messages = await service.loadMessages(workspaceDir, session.id);
  assert.equal(toolCalls(messages, "validateTranslationArtifact").length, 0);
  assert.ok(messages.some((message) => message.role === "assistant" && /remain available/.test(text(message))));

  releaseChildren.resolve();
  await waitUntil(async () => {
    const currentMessages = await service.loadMessages(workspaceDir, session.id);
    return toolCalls(currentMessages, "validateTranslationArtifact").length === 1;
  }, "two chunk reviews followed by final validation");
  await waitUntil(async () => !(await service.getRunState(workspaceDir, session.id)).running, "parent workflow settle");

  messages = await service.loadMessages(workspaceDir, session.id);
  assert.equal(toolCalls(messages, "runTranslationSubagents").length, 1);
  assert.equal(toolCalls(messages, "inspectTranslationAlignment").length, 0);
  assert.equal(toolCalls(messages, "recordTranslationAlignmentChecks").length, 0);
  assert.equal(toolCalls(messages, "readTranslationDiscoveries").length, 1);
  assert.equal(toolCalls(messages, "resolveTranslationDiscoveries").length, 1);
  assert.equal(toolCalls(messages, "validateTranslationArtifact").length, 1);
  assert.ok(messages.some((message) => (
    message.role === "toolResult"
    && message.toolCallId === "validate-final-artifact"
    && message.isError === false
  )), JSON.stringify(messages.filter((message) => message.role === "toolResult"), null, 2));
  const completionNoticeIndex = messages.findIndex((message) => (
    message.role === "custom"
    && message.customType === "subagent-completion"
    && message.display === false
  ));
  const validationIndex = messages.findIndex((message) => (
    message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "toolCall" && block.name === "validateTranslationArtifact")
  ));
  const completionIndex = messages.findIndex((message) => (
    message.role === "assistant"
    && /final host validation passed/.test(text(message))
  ));
  assert.ok(completionNoticeIndex >= 0);
  const completionNotice = messages[completionNoticeIndex];
  assert.match(String(completionNotice.content), /CHILD DISCOVERY REPORT/);
  assert.match(String(completionNotice.content), /ordinary dictionary words or everyday phrases/);
  assert.match(String(completionNotice.content), /unknown gender\/pronoun/);
  assert.equal(completionNotice.details?.completionContext?.glossaryCount, 0,
    "reviewed terminology should be committed at the assignment gate, not replayed at batch completion");
  assert.equal(completionNotice.details?.completionContext?.characterCount, 1);
  assert.equal(Object.hasOwn(completionNotice.details?.completionContext ?? {}, "discoveries"), false,
    "terminal parent context must not duplicate the full child discovery payload");
  assert.ok(validationIndex > completionNoticeIndex);
  assert.ok(completionIndex > validationIndex);
  assert.equal(await readFile(path.join(workspaceDir, "AI_translation", "source_translated.txt"), "utf8"), "\u4e00\n\u4e8c\n");
  const glossaryCandidates = JSON.parse(await readFile(
    path.join(workspaceDir, "AI_translation", "_workspace", "glossary_candidates.json"),
    "utf8"
  ));
  assert.deepEqual(glossaryCandidates.entries.map((entry) => [entry.source, entry.target]), [["one", "\u4e00"]]);

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

console.log("ok native child completion wakes the parent, which validates the whole artifact before reporting completion");
