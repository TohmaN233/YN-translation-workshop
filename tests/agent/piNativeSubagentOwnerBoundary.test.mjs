import { strict as assert } from "node:assert";
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

import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import {
  runPiProofreadSubagent,
  runPiTranslationSubagent
} from "../../src/main/agent/piNative/subagentRunner.ts";

async function modelFixture(providerId, responses) {
  const models = createModels();
  const provider = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  provider.setResponses(responses);
  return {
    models,
    provider,
    select: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    })
  };
}

function assertParentBoundary(persistedCards, liveCards, kind) {
  assert.deepEqual(
    persistedCards.map((message) => message.details.status),
    ["running", "completed"],
    `${kind} must persist only one initial and one terminal parent card`
  );
  assert.deepEqual(
    liveCards,
    [],
    `${kind} child assistant/tool turns must stay in child Pi JSONL instead of parent live IPC`
  );
  assert.ok(
    persistedCards.every((message) => (
      !Object.hasOwn(message.details, "transcript")
      && Buffer.byteLength(JSON.stringify(message)) < 16_384
    )),
    `${kind} parent cards must stay lightweight and transcript-free`
  );
}

async function verifyTranslationBoundary(root) {
  const outputDir = path.join(root, "translation");
  const sourcePath = path.join(outputDir, "source.txt");
  await mkdir(outputDir, { recursive: true });
  await writeFile(sourcePath, "hello\n", "utf8");
  await new PiSessionRepository(outputDir).create("parent-translation-owner");
  const fx = await modelFixture("translation-owner-boundary", [
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "translation-read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: [{ line: 1, translation: "你好" }]
    }, { id: "translation-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "translation-validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Translation completed."))
  ]);
  const persistedCards = [];
  const liveCards = [];
  await runPiTranslationSubagent({
    request: {
      outputDir,
      sourcePath,
      sessionId: "parent-translation-owner",
      prompt: "Translate the assigned source.",
      providerId: fx.provider.provider.id,
      modelId: fx.provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1 },
    publishCustomMessage: async (message) => persistedCards.push(message),
    publishLiveCustomMessage: async (message) => liveCards.push(message),
    createModelSelection: fx.select
  });
  assertParentBoundary(persistedCards, liveCards, "translation");
}

async function verifyProofreadBoundary(root) {
  const outputDir = path.join(root, "proofread");
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "AI_translation", "source_translated.txt");
  await mkdir(path.dirname(translationPath), { recursive: true });
  await writeFile(sourcePath, "hello\n", "utf8");
  await writeFile(translationPath, "你好\n", "utf8");
  await new PiSessionRepository(outputDir).create("parent-proofread-owner");
  const fx = await modelFixture("proofread-owner-boundary", [
    fauxAssistantMessage(fauxToolCall("readAssignedProofreadContext", {}, { id: "proofread-read-context" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("writeAssignedFindings", { findings: [] }, { id: "proofread-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Proofread completed with 0 findings."))
  ]);
  const persistedCards = [];
  const liveCards = [];
  await runPiProofreadSubagent({
    request: {
      outputDir,
      sourcePath,
      translationPath,
      sessionId: "parent-proofread-owner",
      prompt: "Proofread the assigned source.",
      providerId: fx.provider.provider.id,
      modelId: fx.provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 1 },
    publishCustomMessage: async (message) => persistedCards.push(message),
    publishLiveCustomMessage: async (message) => liveCards.push(message),
    createModelSelection: fx.select
  });
  assertParentBoundary(persistedCards, liveCards, "proofread");
}

const root = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-owner-boundary-"));
try {
  await verifyTranslationBoundary(root);
  await verifyProofreadBoundary(root);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ok ordinary translation and proofread children keep internal Pi turns in child JSONL");
