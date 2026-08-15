import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import {
  createPiTranslationSubagentTools,
  createTranslationWriteBatchHandoff
} from "../../src/main/agent/piNative/subagentRunner.ts";

const sourcePath = path.resolve("src/main/agent/piNative/subagentRunner.ts");
const source = await readFile(sourcePath, "utf8");
assert.doesNotMatch(
  source,
  /TRANSLATION_HOST_HANDOFF_TOOLS|new Set\(\s*\[\s*["']writeAssignedTranslation/,
  "translation Host handoff must not be controlled by a tool-name blacklist"
);

const tools = createPiTranslationSubagentTools({
  request: {
    outputDir: process.cwd(),
    sourcePath: path.resolve("source.txt"),
    sessionId: "translation-tool-capabilities",
    prompt: "Translate the assigned range.",
    providerId: "test",
    modelId: "test",
    languagePair: "en->zh-CN"
  },
  task: { documentId: "source.txt", fromLine: 1, toLine: 2 },
  publishCustomMessage: async () => {}
});

assert.ok(tools.length > 5, "the contract must cover translation and shared read-only tools");
assert.ok(
  tools.every((tool) => tool.hostControl === "continue" || tool.hostControl === "return_after_tool_batch"),
  "every translation child tool definition must declare its Host-control capability"
);
assert.deepEqual(
  tools.filter((tool) => tool.hostControl === "return_after_tool_batch").map((tool) => tool.name).sort(),
  ["repairAssignedTranslation", "validateAssignedTranslation", "writeAssignedTranslation"],
  "artifact writes and terminal validation must return control to Host"
);

function afterToolContext(assistantMessage, toolCall, terminate = false) {
  return {
    assistantMessage,
    toolCall,
    result: { content: [], terminate }
  };
}

const handoff = createTranslationWriteBatchHandoff(tools);
const readOnlyMessage = fauxAssistantMessage([
  fauxToolCall("readAssignedSource", { fromLine: 1, toLine: 2 }, { id: "read-source" }),
  fauxToolCall("readTranslationContext", { fromLine: 1, toLine: 2 }, { id: "read-context" })
], { stopReason: "toolUse" });
const readOnlyCalls = readOnlyMessage.content.filter((block) => block.type === "toolCall");
for (const toolCall of readOnlyCalls) {
  assert.equal(
    await handoff(afterToolContext(readOnlyMessage, toolCall)),
    undefined,
    `ordinary read ${toolCall.name} must not hand control back to Host`
  );
}

const writeBatchMessage = fauxAssistantMessage([
  fauxToolCall("readAssignedSource", { fromLine: 1, toLine: 2 }, { id: "batch-read" }),
  fauxToolCall("writeAssignedTranslation", { blocks: [] }, { id: "batch-write" }),
  fauxToolCall("validateAssignedTranslation", {}, { id: "batch-validate" })
], { stopReason: "toolUse" });
const writeBatchCalls = writeBatchMessage.content.filter((block) => block.type === "toolCall");
assert.deepEqual(
  await handoff(afterToolContext(writeBatchMessage, writeBatchCalls[0])),
  { terminate: true },
  "a batch containing a Host handoff write must end after the complete tool batch"
);
assert.deepEqual(
  await handoff(afterToolContext(writeBatchMessage, writeBatchCalls[1])),
  { terminate: true },
  "a rejected write still returns the complete batch to Host for a bounded corrective turn"
);
assert.deepEqual(
  await handoff(afterToolContext(writeBatchMessage, writeBatchCalls[2])),
  { terminate: true },
  "every result in the mixed batch must terminate so Pi cannot self-continue before Host inspection"
);

console.log("ok translation child Host handoff is definition-owned, exhaustive, and read-safe");
