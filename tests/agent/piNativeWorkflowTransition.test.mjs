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
import { Type } from "typebox";

import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function waitForNextSettled(service) {
  const gate = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    unsubscribe();
    gate.resolve();
  });
  return Promise.race([
    gate.promise,
    new Promise((_, reject) => setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the Pi session to settle."));
    }, 5_000))
  ]);
}

function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

await test("incomplete translation is suspended across an explicit proofread switch and old children cannot enter the new run", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-full-workflow-transition-"));
  const sourcePath = path.join(workspaceDir, "source.txt");
  const translationPath = path.join(workspaceDir, "AI_translation", "source_translated.txt");
  const parent = fauxProvider({ provider: "workflow-transition-parent", tokensPerSecond: 10_000 });
  const oldChild = fauxProvider({ provider: "workflow-transition-old-child", tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(parent.provider);
  models.setProvider(oldChild.provider);
  const oldChildSelectionStarted = deferred();
  const releaseOldChild = deferred();
  const contexts = [];
  let oldBatchId = "";

  parent.setResponses([
    fauxAssistantMessage(fauxToolCall("leaveFullTranslationDebt", {}, { id: "translation-debt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Translation is waiting on a typed decision.")),
    fauxAssistantMessage(fauxToolCall("leaveFullProofreadDebt", {}, { id: "proofread-debt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Proofreading is waiting on its own typed decision.")),
    fauxAssistantMessage(fauxText("The parked translation contract is active again."))
  ]);
  oldChild.setResponses([fauxAssistantMessage(fauxText("Old translation child completed."))]);

  const service = new PiNativeSessionService({
    createModelSelection: async ({ providerId }) => {
      if (providerId === oldChild.provider.id) {
        oldChildSelectionStarted.resolve();
        await releaseOldChild.promise;
        return {
          models,
          model: oldChild.getModel(),
          providerId: oldChild.provider.id,
          modelId: oldChild.getModel().id
        };
      }
      return {
        models,
        model: parent.getModel(),
        providerId: parent.provider.id,
        modelId: parent.getModel().id
      };
    },
    enforceDomainCompletion: true,
    createTools: (context) => {
      contexts.push(context);
      if (context.request.workflowIntent === "translation") {
        return [{
          name: "leaveFullTranslationDebt",
          label: "leave full translation debt",
          description: "Keep a typed translation decision outstanding and launch an old child.",
          parameters: Type.Object({}),
          async execute() {
            context.domainRun.recordInspection({
              sourceLineCount: 3,
              glossaryCandidateExists: true,
              characterBibleExists: true
            });
            context.domainRun.recordTranslationReuseAuditReady(["full-translation-debt"]);
            const batch = context.subagents.startGeneralBatch({
              request: {
                ...context.request,
                providerId: oldChild.provider.id,
                modelId: oldChild.getModel().id
              },
              tasks: [{
                label: "old translation child",
                prompt: "Remain active until the workflow switches.",
                mode: "investigate",
                providerId: oldChild.provider.id,
                modelId: oldChild.getModel().id
              }],
              maxWorkers: 1
            });
            oldBatchId = batch.id;
            return { content: [{ type: "text", text: "translation debt retained" }], details: { batchId: batch.id } };
          }
        }];
      }
      return [{
        name: "leaveFullProofreadDebt",
        label: "leave full proofread debt",
        description: "Keep the explicitly selected proofreading workflow incomplete.",
        parameters: Type.Object({}),
        async execute() {
          context.domainRun.recordInspection({
            sourceLineCount: 3,
            glossaryCandidateExists: true,
            characterBibleExists: true
          });
          context.domainRun.recordProofreadPrescan();
          context.domainRun.recordProofreadMontecarloRound(1);
          return { content: [{ type: "text", text: "proofread decision retained" }], details: {} };
        }
      }];
    },
    buildSystemPrompt: () => "Exercise typed workflow transitions without merging their Host state."
  });

  try {
    await writeFile(sourcePath, "one\ntwo\nthree", "utf8");
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(translationPath, "one\ntwo\nthree", "utf8");
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      sourcePath,
      sourceSelection: { kind: "file", path: sourcePath },
      translationPath,
      languagePair: "en->zh-CN",
      providerId: parent.provider.id,
      modelId: parent.getModel().id,
      subagentEnabled: true,
      subagentCount: 2
    };

    const translationSettled = waitForNextSettled(service);
    await service.prompt({
      ...common,
      workflowIntent: "translation",
      prompt: "Workflow: yn-translation-v1."
    });
    await translationSettled;
    await Promise.race([
      oldChildSelectionStarted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Old child did not start.")), 5_000))
    ]);

    const proofreadSettled = waitForNextSettled(service);
    await service.prompt({
      ...common,
      workflowIntent: "proofread",
      proofreadMode: "montecarlo",
      proofreadMontecarloRoundMin: 1,
      proofreadMontecarloRoundMax: 1,
      prompt: "Workflow: yn-proofread-v1."
    });
    await proofreadSettled;

    const translationContext = contexts[0];
    const proofreadContext = contexts[1];
    const parkedTranslationDebt = translationContext.domainRun.snapshot().pendingTranslationReuseAuditIds;
    const translationWasSuspended = translationContext.domainRun.suspended;
    const oldChildVisibleInProofread = proofreadContext.subagents.list().some((batch) => batch.id === oldBatchId);

    releaseOldChild.resolve();
    await translationContext.subagents.waitForAll();
    const messages = await service.loadMessages(workspaceDir, session.id);
    const oldChildTriggeredProofreadTurn = messages.some((message) => (
      assistantText(message).includes("OLD_CHILD_COMPLETION_REACHED_NEW_PROOFREAD_RUN")
    ));

    const resumedTranslationSettled = waitForNextSettled(service);
    await service.prompt({
      ...common,
      workflowIntent: "translation",
      prompt: "Workflow: yn-translation-v1.\nContinue the parked translation decision."
    });
    await resumedTranslationSettled;
    const resumedTranslationContext = contexts[2];

    assert.deepEqual({
      translationKind: translationContext.domainRun.kind,
      translationDebt: parkedTranslationDebt,
      translationWasSuspended,
      proofreadKind: proofreadContext.domainRun.kind,
      reusedTranslationContract: proofreadContext.domainRun === translationContext.domainRun,
      restoredTranslationContractIsFreshInstance: resumedTranslationContext.domainRun !== translationContext.domainRun,
      restoredTranslationDebt: resumedTranslationContext.domainRun.snapshot().pendingTranslationReuseAuditIds,
      restoredTranslationSuspended: resumedTranslationContext.domainRun.suspended,
      oldChildVisibleInProofread,
      oldChildTriggeredProofreadTurn
    }, {
      translationKind: "translation",
      translationDebt: ["full-translation-debt"],
      translationWasSuspended: true,
      proofreadKind: "proofread",
      reusedTranslationContract: false,
      restoredTranslationContractIsFreshInstance: true,
      restoredTranslationDebt: ["full-translation-debt"],
      restoredTranslationSuspended: false,
      oldChildVisibleInProofread: false,
      oldChildTriggeredProofreadTurn: false
    });
  } finally {
    releaseOldChild.resolve();
    for (const supervisor of new Set(contexts.map((context) => context.subagents))) {
      supervisor.abortAll();
      await supervisor.waitForAll();
    }
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("incomplete local translation is suspended instead of being reused as a local proofread contract", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-local-workflow-transition-"));
  const parent = fauxProvider({ provider: "local-workflow-transition", tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(parent.provider);
  const contexts = [];

  parent.setResponses([
    fauxAssistantMessage(fauxToolCall("leaveLocalTranslationDebt", {}, { id: "local-translation-debt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Local translation repair remains incomplete.")),
    fauxAssistantMessage(fauxToolCall("activateLocalProofread", {}, { id: "local-proofread" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Local proofreading is now the active bounded task."))
  ]);

  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: parent.getModel(),
      providerId: parent.provider.id,
      modelId: parent.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      contexts.push(context);
      if (context.request.workflowIntent === "translation") {
        return [{
          name: "leaveLocalTranslationDebt",
          label: "leave local translation debt",
          description: "Keep a bounded translation repair incomplete.",
          parameters: Type.Object({}),
          async execute() {
            context.domainRun.activate("translation");
            context.domainRun.recordTranslationReuseAuditReady(["local-translation-debt"]);
            return { content: [{ type: "text", text: "local translation debt retained" }], details: {} };
          }
        }];
      }
      return [{
        name: "activateLocalProofread",
        label: "activate local proofread",
        description: "Activate a distinct bounded proofreading task.",
        parameters: Type.Object({}),
        async execute() {
          context.domainRun.activate("proofread");
          return { content: [{ type: "text", text: "local proofread active" }], details: {} };
        }
      }];
    },
    buildSystemPrompt: () => "Keep bounded translation and proofreading contracts distinct."
  });

  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      languagePair: "en->zh-CN",
      providerId: parent.provider.id,
      modelId: parent.getModel().id,
      subagentEnabled: true,
      subagentCount: 3
    };

    const translationSettled = waitForNextSettled(service);
    await service.prompt({
      ...common,
      workflowIntent: "translation",
      prompt: "Repair only the already located translation line."
    });
    await translationSettled;

    const proofreadSettled = waitForNextSettled(service);
    await service.prompt({
      ...common,
      workflowIntent: "proofread",
      prompt: "Now proofread only that bounded line."
    });
    await proofreadSettled;

    const translationContext = contexts[0];
    const proofreadContext = contexts[1];
    assert.deepEqual({
      translationKind: translationContext.domainRun.kind,
      translationDebt: translationContext.domainRun.snapshot().pendingTranslationReuseAuditIds,
      translationSuspended: translationContext.domainRun.suspended,
      proofreadKind: proofreadContext.domainRun.kind,
      reusedTranslationContract: proofreadContext.domainRun === translationContext.domainRun
    }, {
      translationKind: "translation",
      translationDebt: ["local-translation-debt"],
      translationSuspended: true,
      proofreadKind: "proofread",
      reusedTranslationContract: false
    });
  } finally {
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
