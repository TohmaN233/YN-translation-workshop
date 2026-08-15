import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";

import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-control-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "one\ntwo\n", "utf8");
const models = createModels();
const providers = new Map();
const childrenWaiting = deferred();
const releaseChildren = deferred();
const cards = [];
let waitingCount = 0;

for (const [index, providerId] of ["control-a", "control-b"].entries()) {
  const provider = fauxProvider({ provider: providerId, tokensPerSecond: 1000 });
  models.setProvider(provider.provider);
  providers.set(providerId, provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `${providerId}-read` }), { stopReason: "toolUse" }),
    async () => {
      waitingCount += 1;
      if (waitingCount === 2) childrenWaiting.resolve();
      await releaseChildren.promise;
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
        entries: [{ line: index + 1, translation: index === 0 ? "一" : "二" }]
      }, { id: `${providerId}-write` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage([
      fauxText(`Steer received by ${providerId}.`),
      fauxToolCall("validateAssignedTranslation", {}, { id: `${providerId}-validate` })
    ], { stopReason: "toolUse" })
  ]);
}

const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => cards.push(message),
  createModelSelection: async ({ providerId }) => {
    const provider = providers.get(providerId);
    assert.ok(provider);
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
      sessionId: "pi_child_control",
      prompt: "translate with supervised children",
      providerId: "parent",
      modelId: "parent",
      languagePair: "en->zh-CN"
    },
    tasks: [
      { fromLine: 1, toLine: 1, providerId: "control-a", label: "shard-1" },
      { fromLine: 2, toLine: 2, providerId: "control-b", label: "shard-2" }
    ],
    onChunkReadyForReview: async () => ({ accepted: true })
  });
  await Promise.race([
    childrenWaiting.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("children did not reach the supervised turn")), 3000))
  ]);

  const children = supervisor.list()[0].subagents;
  assert.equal(children.length, 2);
  const steering = [];
  for (const child of children) {
    const inspection = await supervisor.inspect(child.id);
    const transcript = await supervisor.inspectTranscript(child.id);
    assert.equal(inspection.status, "running");
    assert.ok(transcript.some((message) => message.role === "toolResult"));
    steering.push(supervisor.steer(child.id, `Parent guidance for ${child.label}`));
  }
  releaseChildren.resolve();
  await Promise.all(steering);
  await supervisor.waitForAll();

  for (const child of children) {
    const inspection = await supervisor.inspect(child.id);
    const transcript = await supervisor.inspectTranscript(child.id);
    assert.equal(inspection.status, "completed");
    assert.ok(transcript.some((message) => (
      message.role === "user" && textOf(message) === `Parent guidance for ${child.label}`
    )));
    assert.ok(transcript.some((message) => (
      message.role === "assistant" && /Steer received/.test(textOf(message))
    )));
  }
  assert.equal(cards.filter((card) => card.details?.status === "completed").length, 2);
} finally {
  releaseChildren.resolve();
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

const terminalOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-terminal-steer-"));
const terminalSourcePath = path.join(terminalOutputDir, "source.txt");
await writeFile(terminalSourcePath, "terminal\n", "utf8");
const terminalProvider = fauxProvider({ provider: "terminal-control", tokensPerSecond: 1000 });
const terminalModels = createModels();
terminalModels.setProvider(terminalProvider.provider);
terminalProvider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "terminal-read" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "终点" }]
  }, { id: "terminal-write" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "terminal-validate" }), { stopReason: "toolUse" })
]);
const terminalCardStarted = deferred();
const releaseTerminalCard = deferred();
const terminalSupervisor = new YnSubagentSupervisor({
  publishCustomMessage: async (message) => {
    if (message.details?.status !== "completed") return;
    terminalCardStarted.resolve();
    await releaseTerminalCard.promise;
  },
  createModelSelection: async () => ({
    models: terminalModels,
    model: terminalProvider.getModel(),
    providerId: terminalProvider.provider.id,
    modelId: terminalProvider.getModel().id
  })
});

try {
  terminalSupervisor.startTranslationBatch({
    request: {
      outputDir: terminalOutputDir,
      sourcePath: terminalSourcePath,
      sessionId: "pi_child_terminal_control",
      prompt: "translate at terminal boundary",
      providerId: terminalProvider.provider.id,
      modelId: terminalProvider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ fromLine: 1, toLine: 1, label: "terminal-shard" }],
    onChunkReadyForReview: async () => ({ accepted: true })
  });
  await Promise.race([
    terminalCardStarted.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("child did not reach terminal persistence")), 3000))
  ]);
  const child = terminalSupervisor.list()[0].subagents[0];
  assert.equal(child.status, "running", "supervisor remains running while the terminal card is persisted");
  await assert.rejects(
    terminalSupervisor.steer(child.id, "This must not be accepted after the Pi turn is idle."),
    /Pi child.*(?:idle|no longer accepting|finished)/i
  );
  releaseTerminalCard.resolve();
  await terminalSupervisor.waitForAll();
  const inspection = await terminalSupervisor.inspect(child.id);
  const transcript = await terminalSupervisor.inspectTranscript(child.id);
  assert.equal(inspection.status, "completed");
  assert.equal(
    transcript.some((message) => (
      message.role === "user" && textOf(message).includes("must not be accepted")
    )),
    false
  );
} finally {
  releaseTerminalCard.resolve();
  terminalSupervisor.abortAll();
  await terminalSupervisor.waitForAll();
  await rm(terminalOutputDir, { recursive: true, force: true });
}

console.log("ok parent can inspect and steer live Pi children, while terminal-boundary guidance is rejected explicitly");
