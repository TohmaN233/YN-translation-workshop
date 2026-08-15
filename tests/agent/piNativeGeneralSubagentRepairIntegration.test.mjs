import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function assistantText(message) {
  return message?.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    : "";
}

function toolCalls(messages, name) {
  return messages.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall" && block.name === name)
      : []
  ));
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runScenario({ recoverAfterFailure, folderManifest = false }) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-general-repair-"));
  const sourceRoot = folderManifest ? path.join(workspaceDir, "source") : workspaceDir;
  const sourcePath = folderManifest ? sourceRoot : path.join(sourceRoot, "tips.txt");
  const tipsSourcePath = path.join(sourceRoot, "tips.txt");
  const candidatePath = path.join(workspaceDir, "AI_translation", "tips_translated.txt");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(tipsSourcePath, "A real source sentence.", "utf8");
  if (folderManifest) await writeFile(path.join(sourceRoot, "script.txt"), "An unrelated unfinished file.", "utf8");
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await writeFile(candidatePath, "（本段译文）\n", "utf8");

  const models = createModels();
  const providers = new Map();
  const parent = fauxProvider({ provider: `general-parent-${recoverAfterFailure ? "retry" : "success"}`, tokensPerSecond: 1000 });
  const healthy = fauxProvider({ provider: `general-child-${recoverAfterFailure ? "retry" : "success"}`, tokensPerSecond: 1000 });
  const failing = recoverAfterFailure
    ? fauxProvider({ provider: "general-child-failing", tokensPerSecond: 1000 })
    : undefined;
  for (const provider of [parent, healthy, failing].filter(Boolean)) {
    models.setProvider(provider.provider);
    providers.set(provider.provider.id, provider);
  }

  const task = (providerId, id) => fauxAssistantMessage(fauxToolCall("runSubagents", {
    tasks: [{
      prompt: "Replace the assigned placeholder with a complete Simplified Chinese translation, validate it, and report only after the managed candidate write succeeds.",
      label: id,
      mode: "translation_repair",
      documentId: "tips.txt",
      fromLine: 1,
      toLine: 1,
      providerId
    }]
  }, { id }), { stopReason: "toolUse" });
  const parentAlignmentAudit = (idPrefix) => [
    fauxAssistantMessage(fauxToolCall("inspectTranslationAlignment", {}, {
      id: `${idPrefix}-inspect-alignment`
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readSourceLines", { fromLine: 1, toLine: 1 }, {
      id: `${idPrefix}-read-source`
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("readTranslationLines", { fromLine: 1, toLine: 1 }, {
      id: `${idPrefix}-read-translation`
    }), { stopReason: "toolUse" }),
    (context) => {
      const inspected = [...context.messages].reverse().find((message) => (
        message.role === "toolResult" && message.toolName === "inspectTranslationAlignment"
      ));
      const text = Array.isArray(inspected?.content) ? inspected.content[0]?.text : inspected?.content;
      const payload = JSON.parse(text);
      return fauxAssistantMessage(fauxToolCall("recordTranslationAlignmentChecks", {
        auditId: payload.auditId,
        failures: []
      }, { id: `${idPrefix}-record-alignment` }), { stopReason: "toolUse" });
    }
  ];

  if (recoverAfterFailure) {
    parent.setResponses([
      task(failing.provider.id, "start-failing-child"),
      fauxAssistantMessage(fauxText("The first child is running.")),
      fauxAssistantMessage(fauxText("The child failed because its managed write was rejected.")),
      fauxAssistantMessage(fauxText("The failed child still needs attention.")),
      fauxAssistantMessage(fauxText("I cannot report completion while that child remains failed.")),
      task(healthy.provider.id, "retry-bounded-child"),
      fauxAssistantMessage(fauxText("The bounded retry is running.")),
      ...parentAlignmentAudit("retry"),
      fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, {
        id: "validate-repaired-placeholder"
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("The child retry completed, the placeholder is gone, and final validation passed."))
    ]);
    failing.setResponses([
      async () => { throw new Error("forced managed child failure"); }
    ]);
  } else {
    parent.setResponses([
      task(healthy.provider.id, "start-healthy-child"),
      fauxAssistantMessage(fauxText("The child is running.")),
      fauxAssistantMessage(fauxText("The child completed its assigned repair.")),
      ...parentAlignmentAudit("success"),
      fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, {
        id: "validate-clean-placeholder"
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("The child completed the managed repair and final validation passed."))
    ]);
  }

  healthy.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, {
      id: "read-placeholder-source"
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
      entries: [{ line: 1, translation: "这是一句完整的中文译文。" }]
    }, { id: "write-real-translation" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {
      misalignedLines: []
    }, {
      id: "validate-managed-translation"
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Managed candidate write and assigned validation completed."))
  ]);

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
    buildSystemPrompt: () => "Use native Pi children for bounded repairs. Inspect failures, retry them, and validate the final candidate before reporting completion.",
    enforceDomainCompletion: true
  });

  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Use 1 child agent to replace the placeholder in tips.txt, then validate the repaired translation and finish the task.",
      workflowIntent: undefined,
      languagePair: "en->zh-CN",
      providerId: parent.provider.id,
      modelId: parent.getModel().id,
      subagentEnabled: true,
      subagentCount: 1,
      sourcePath,
      sourceSelection: folderManifest ? { kind: "folder", path: sourceRoot } : undefined
    });

    await waitUntil(async () => {
      const messages = await service.loadMessages(workspaceDir, session.id);
      return messages.some((message) => /final validation passed/i.test(assistantText(message)));
    }, "the parent to continue through child settlement and final validation");

    const messages = await service.loadMessages(workspaceDir, session.id);
    const state = await service.getRunState(workspaceDir, session.id);
    const cards = state.subagentMessages.filter((message) => message.details?.subagentId);
    const completedCards = cards.filter((message) => message.details?.status === "completed" && message.details?.closed === true);
    assert.equal(await readFile(candidatePath, "utf8"), "这是一句完整的中文译文。\n");
    assert.ok(
      messages.some((message) => (
        message.role === "toolResult"
        && message.toolName === "validateTranslationArtifact"
        && message.isError !== true
      )),
      "the parent never completed a successful final artifact validation"
    );
    if (folderManifest) {
      await assert.rejects(
        readFile(path.join(workspaceDir, "AI_translation", "script_translated.txt"), "utf8"),
        /ENOENT/,
        "the bounded tips.txt repair must not create or require an unrelated script.txt candidate"
      );
    }
    assert.equal(toolCalls(messages, "validateTranslationArtifact").length, 1);
    assert.ok(
      completedCards.length >= 1,
      `the managed repair child never reached a completed terminal card: ${JSON.stringify(state.subagentMessages.map((message) => ({ customType: message.customType, details: message.details })))}`
    );
    assert.equal(state.running, false);
    assert.equal(state.phase, "idle");
    assert.equal(state.error, undefined);

    if (recoverAfterFailure) {
      assert.equal(toolCalls(messages, "runSubagents").length, 2);
      const diagnosisIndex = messages.findIndex((message) => /managed write was rejected/i.test(assistantText(message)));
      const repairPromptIndex = messages.findIndex((message) => (
        message.role === "custom" && message.customType === "yn-domain-repair"
      ));
      const repairPrompts = messages.filter((message) => (
        message.role === "custom" && message.customType === "yn-domain-repair"
      ));
      const retryIndex = messages.findIndex((message) => (
        message.role === "assistant"
        && Array.isArray(message.content)
        && message.content.some((block) => block.type === "toolCall" && block.id === "retry-bounded-child")
      ));
      assert.ok(diagnosisIndex >= 0);
      assert.equal(repairPrompts.length, 3, "the completion loop stopped after repeated status-only replies");
      assert.ok(repairPromptIndex > diagnosisIndex, "the host did not inject a native Pi continuation after the status-only reply");
      assert.ok(retryIndex > repairPromptIndex, "the parent stopped instead of consuming the continuation and retrying the child");
    } else {
      assert.equal(toolCalls(messages, "runSubagents").length, 1);
      assert.equal(
        messages.filter((message) => message.role === "custom" && message.customType === "yn-domain-repair").length,
        1,
        "the host did not continue after a successful child when the parent only reported status"
      );
      assert.ok(!messages.some((message) => (
        message.role === "toolResult" && /workflow manifest/i.test(String(message.content))
      )), "a clean child repair still hit the stale workflow-manifest rejection");
    }
  } finally {
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

await runScenario({ recoverAfterFailure: false });
console.log("ok one native Pi child replaces a placeholder, registers the managed write, validates, and closes cleanly");

await runScenario({ recoverAfterFailure: true });
console.log("ok a status-only parent reply cannot stop the Pi loop after child failure; it retries and validates automatically");

await runScenario({ recoverAfterFailure: false, folderManifest: true });
console.log("ok a folder-bounded child repair validates only its mutated document before parent completion");
