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

import {
  getTranslationReuseAuditSummary,
  planTranslationReuseAuditTasks,
  prepareTranslationReuseAudit
} from "../../src/main/agent/piNative/translationReuseAudit.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-reuse-audit-child-"));
const sourcePath = path.join(outputDir, "source.txt");
const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
await mkdir(path.dirname(candidatePath), { recursive: true });
await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
await writeFile(path.join(outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
  entries: [{ source: "ancient northern gate", target: "古老北门" }]
}), "utf8");
await writeFile(sourcePath, [
  "Open the ancient northern gate before sunset and wait for the signal.",
  "Exit immediately through the northern passage.",
  "Save your progress before entering the dungeon.",
  "Close the eastern gate after every traveler has returned safely.",
  "Load your last save before talking to the merchant."
].join("\n") + "\n", "utf8");
await writeFile(candidatePath, [
  "打开大门",
  "Salir ahora por el pasillo norte.",
  "进入地牢前保存你的进度。",
  "关闭东门",
  "Cargar la partida antes de hablar con el mercader."
].join("\n") + "\n", "utf8");
await new PiSessionRepository(outputDir).create("parent-reuse-audit");
const audit = await prepareTranslationReuseAudit({
  outputDir,
  ownerSessionId: "parent-reuse-audit",
  sourcePath,
  candidatePath,
  documentId: "source.txt",
  languagePair: "en->zh-CN"
});

const models = createModels();
const provider = fauxProvider({ provider: "reuse-audit-child", tokensPerSecond: 10_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationAudit", {}, { id: "read-audit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("submitTranslationAudit", {
    entries: [
      { line: 1, verdict: "retranslate", reason: "Generic completion label, not a translation of the source." },
      { line: 2, verdict: "retranslate", reason: "The target language is not Chinese." }
    ]
  }, { id: "submit-audit" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("readAssignedTranslationAudit", {}, { id: "read-audit-2" }), { stopReason: "toolUse" })
  ,fauxAssistantMessage(fauxToolCall("submitTranslationAudit", {
    entries: [
      { line: 4, verdict: "retranslate", reason: "The target omits the return condition and most of the source meaning." },
      { line: 5, verdict: "retranslate", reason: "The target language is not Chinese." }
    ]
  }, { id: "submit-audit-2" }), { stopReason: "toolUse" })
]);

let parentCompletion;
const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  notifyParent: async (message) => { parentCompletion = message; },
  createModelSelection: async () => ({
    models,
    model: provider.getModel(),
    providerId: provider.provider.id,
    modelId: provider.getModel().id
  })
});

try {
  const tasks = await planTranslationReuseAuditTasks({
    outputDir,
    ownerSessionId: "parent-reuse-audit",
    auditIds: [audit.auditId],
    maxLinesPerTask: 2
  });
  assert.deepEqual(tasks.map(({ fromLine, toLine, lines }) => ({ fromLine, toLine, lines })), [
    { fromLine: 1, toLine: 2, lines: [1, 2] },
    { fromLine: 4, toLine: 5, lines: [4, 5] }
  ]);
  supervisor.startGeneralBatch({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: "parent-reuse-audit",
      prompt: "Audit existing work.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: tasks.map((task, index) => ({
      ...task,
      prompt: `Audit high-risk existing translation range ${index + 1}.`,
      mode: "translation_audit"
    })),
    maxWorkers: 1
  });
  await supervisor.waitForAll();
  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  const summary = await getTranslationReuseAuditSummary(outputDir, audit.auditId, "parent-reuse-audit");
  assert.equal(summary.readyForUserDecision, true);
  assert.deepEqual(summary.counts, { reuse: 1, retranslate: 4 });
  const children = await new PiSessionRepository(outputDir).listChildMetadata();
  assert.equal(children.length, 1, "one persistent Pi child session must process both audit assignments");
  const child = await new PiSessionRepository(outputDir).openChild(children[0].id);
  const childMessages = (await child.buildContext()).messages;
  const firstAuditRead = childMessages.find((message) => (
    message.role === "toolResult" && message.toolName === "readAssignedTranslationAudit"
  ));
  const firstAuditPayload = JSON.parse(firstAuditRead.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(""));
  assert.deepEqual(firstAuditPayload.projectReferences.directMatches.approvedGlossary, [
    { source: "ancient northern gate", target: "古老北门" }
  ], "reuse-audit children must receive authoritative direct glossary matches for their selected source");
  assert.equal(childMessages.filter((message) => message.role === "user").length, 2);
  assert.equal(childMessages.filter((message) => message.role === "assistant").length, 4,
    "an accepted audit submission must not trigger a third model call just to restate counts");
  assert.ok(parentCompletion, "the completed background audit must wake the parent");
  assert.equal(parentCompletion.details.subagents[0].documentIds, undefined,
    "parent completion must not embed the worker's full document history");
  assert.ok(parentCompletion.content.length < 4_000,
    "parent completion must stay proportional to live worker count, not assignment history");
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok native Pi audit child semantically classifies existing translation without writing it");
