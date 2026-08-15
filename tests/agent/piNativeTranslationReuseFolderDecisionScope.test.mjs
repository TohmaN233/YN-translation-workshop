import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-reuse-folder-decision-scope-"));
const sourceDir = path.join(outputDir, "txt");
const retainedSource = path.join(sourceDir, "retained.txt");
const omittedSource = path.join(sourceDir, "omitted.txt");
const candidateFor = (sourcePath, documentId) => resolveTranslationCandidatePath({
  outputDir,
  sourcePaths: [sourcePath],
  documentId
});
const retainedCandidate = candidateFor(retainedSource, "retained.txt");
const omittedCandidate = candidateFor(omittedSource, "omitted.txt");

await mkdir(sourceDir, { recursive: true });
await mkdir(path.dirname(retainedCandidate), { recursive: true });
await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
await writeFile(retainedSource, "Save now.\n", "utf8");
await writeFile(omittedSource, "Open the gate.\n", "utf8");
await writeFile(retainedCandidate, "现在保存。\n", "utf8");
await writeFile(omittedCandidate, "打开大门。\n", "utf8");
await writeFile(path.join(outputDir, ".translation-workshop", "project.json"), JSON.stringify({
  sourcePath: sourceDir,
  sourceKind: "folder",
  languagePair: "en->zh-CN",
  folderTranslationOrder: '{\n"retained.txt"\n}',
  reuseExistingTranslation: true,
  subagentEnabled: false,
  splitSize: 100
}), "utf8");

const provider = fauxProvider({ provider: "folder-decision-scope", tokensPerSecond: 10_000 });
const models = createModels();
models.setProvider(provider.provider);
const service = new PiNativeSessionService({
  createModelSelection: async () => ({
    models,
    model: provider.getModel(),
    providerId: provider.provider.id,
    modelId: provider.getModel().id
  }),
  createTools: (context) => createYnDomainTools(context),
  buildSystemPrompt: () => "Use the typed Host workflow tools.",
  enforceDomainCompletion: true
});
let settledCount = 0;
const waiters = [];
const unsubscribe = service.subscribeEvents((entry) => {
  if (entry.event.type !== "settled") return;
  settledCount += 1;
  for (const waiter of waiters) if (settledCount >= waiter.count) waiter.resolve();
});
const waitForSettled = (count) => {
  if (settledCount >= count) return Promise.resolve();
  const waiter = deferred();
  waiters.push({ count, resolve: waiter.resolve });
  return Promise.race([
    waiter.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for turn ${count}`)), 5_000))
  ]);
};

try {
  const session = await service.createSession(outputDir);
  const request = {
    outputDir,
    sessionId: session.id,
    providerId: provider.provider.id,
    modelId: provider.getModel().id,
    sourcePath: sourceDir,
    sourceSelection: { kind: "folder", path: sourceDir },
    languagePair: "en->zh-CN",
    reuseExistingTranslation: true,
    subagentEnabled: false,
    subagentCount: 0
  };

  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "inspect-initial" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("prepareTranslationReuseAudit", {}, { id: "prepare" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("现有译文已完成审计，请确认是否保留。"))
  ]);
  await service.prompt({
    ...request,
    prompt: "Workflow: yn-translation-v1.\nAudit only the retained folder-order document."
  });
  await waitForSettled(1);

  let messages = await service.loadMessages(outputDir, session.id);
  const initialInspection = messages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "inspect-initial"
  ));
  assert.equal(initialInspection?.details?.sourceSelection?.documentCount, 1);

  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("applyTranslationReuseDecision", {
      decision: "reuse_accepted"
    }, { id: "apply" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("prepareTranslationReuseAudit", {}, {
      id: "prepare-after-decision"
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, {
      id: "inspect-after-decision"
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "intentional decision-scope inspection boundary"
    })
  ]);
  await service.prompt({ ...request, workflowIntent: undefined, prompt: "保留已确认译文。" });
  await waitForSettled(2);

  messages = await service.loadMessages(outputDir, session.id);
  const applied = messages.find((message) => message.role === "toolResult" && message.toolCallId === "apply");
  assert.equal(applied?.isError, false, JSON.stringify(applied));
  const repeatedPrepare = messages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "prepare-after-decision"
  ));
  assert.equal(repeatedPrepare?.isError, true, "a current-run artifact must not be reclassified as startup reuse work");
  assert.match(String(repeatedPrepare?.content?.[0]?.text || ""), /already owns|current workflow/i);
  const resumedInspection = messages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "inspect-after-decision"
  ));
  assert.equal(
    resumedInspection?.details?.sourceSelection?.documentCount,
    1,
    "a reuse-decision follow-up must not preload the unfiltered folder manifest before restoring the parked workflow"
  );
  assert.deepEqual(
    resumedInspection?.details?.sourceSelection?.documents?.map((document) => document.id),
    ["retained.txt"]
  );
} finally {
  unsubscribe();
  await service.disposeWorkspace(outputDir);
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok reuse-decision follow-up restores the retained folder scope before resolving its manifest");
