import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { isExpiredProviderAuthError } from "../../src/main/agent/piNative/assignmentFailure.ts";

assert.equal(
  isExpiredProviderAuthError('403 "The OAuth2 access token could not be validated."'),
  true
);
assert.equal(isExpiredProviderAuthError("fetch failed"), false);

function translationTurn(prefix, translatedText) {
  return [
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `${prefix}-read` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
      blocks: [{ id: "0", lines: [`0${translatedText}`] }]
    }, { id: `${prefix}-write` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, {
      id: `${prefix}-validate`
    }), { stopReason: "toolUse" })
  ];
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-auth-replace-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "first line\n", "utf8");
const models = createModels();
const provider = fauxProvider({ provider: "auth-replace", tokensPerSecond: 10_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: '403 "The OAuth2 access token could not be validated."'
  }),
  ...translationTurn("replaced", "第一句")
]);

let modelSelections = 0;
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  createModelSelection: async () => {
    modelSelections += 1;
    return {
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    };
  }
});

try {
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "auth-replace",
      prompt: "translate the assigned line",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    maxWorkers: 1,
    onChunkReadyForReview: async () => ({ accepted: true })
  });
  await supervisor.waitForAll();
  const [batch] = supervisor.list();
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(modelSelections >= 2, true, "expired OAuth must start a replacement runtime");
  assert.equal(batch.subagents.length, 2, "the expired worker must be replaced instead of pausing the batch");
  assert.equal(batch.subagents[1].completedAssignments, 1);
  assert.equal(batch.subagents[0].failureDisposition, undefined);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok expired provider auth replaces the worker and continues the assignment");
