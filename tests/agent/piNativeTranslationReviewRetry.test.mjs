import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

test("a successful review retry retains the failed worker's actual error", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-review-retry-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const repository = new PiSessionRepository(outputDir);
  const provider = fauxProvider({ provider: "review-retry", tokensPerSecond: 1_000_000 });
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" })
  ]);
  let initializations = 0;
  const supervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    createModelSelection: async () => {
      if (++initializations === 1) throw new Error("synthetic review initialization failure");
      return { models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id };
    }
  });
  try {
    await writeFile(sourcePath, "One source row.\n");
    await repository.create("parent");
    const request = { outputDir, sourcePath, sessionId: "parent", prompt: "Review the row.", providerId: provider.provider.id,
      modelId: provider.getModel().id, subagentProviderId: provider.provider.id, subagentModelId: provider.getModel().id };
    const task = { documentId: "source.txt", fromLine: 1, toLine: 1, reviewOnly: true };
    supervisor.startTranslationReviewBatch({
      request, tasks: [task], maxWorkers: 1,
      reviewRequestForTask: async () => task,
      prepareChunkReview: async () => ({
        request, task: { ...task, auditId: "retry-audit", riskLineCount: 1, sampledLineCount: 0 },
        read: async () => ({ auditId: "retry-audit", ...task, windows: [{ fromLine: 1, toLine: 1,
          rows: [{ line: 1, source: "One source row.", translation: "一行译文。", selected: true, signals: [] }] }] }),
        submit: async () => ({ accepted: true })
      })
    });
    await supervisor.waitForAll();
    const batch = supervisor.list().find(entry => entry.kind === "translation-review");
    assert.equal(batch.status, "completed", batch.error);
    assert.equal(batch.subagents.length, 2);
    assert.equal(batch.subagents[0].status, "failed", "a retried initialization failure must not appear as completed");
    assert.match(batch.subagents[0].error, /synthetic review initialization failure/);
    assert.equal(batch.subagents[0].completedAssignments, 0);
    assert.equal(batch.subagents[1].status, "completed");
    assert.equal(batch.subagents[1].completedAssignments, 1);
  } finally {
    supervisor.abortAll();
    await supervisor.waitForAll();
    await repository.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});
