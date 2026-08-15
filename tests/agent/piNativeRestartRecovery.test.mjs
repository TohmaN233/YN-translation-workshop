import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-restart-recovery-"));

function deferred() {
  let resolve;
  const promise = new Promise((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function appendRunningCard(session, subagentId) {
  await session.appendMessage({
    role: "custom",
    customType: "subagent.translation",
    content: "Worker 1 is running",
    display: true,
    details: {
      subagentId,
      batchId: `batch_${subagentId}`,
      kind: "translation",
      label: "Worker 1",
      documentId: "chapter-01.txt",
      fromLine: 1,
      toLine: 200,
      status: "running",
      closed: false,
      startedAt: 1_700_000_000_000
    },
    timestamp: 1_700_000_000_000
  });
}

function createPromptService(selectionGate) {
  const faux = fauxProvider({ tokensPerSecond: 1_000, tokenSize: { min: 1, max: 2 } });
  faux.setResponses([fauxAssistantMessage(fauxText("ready"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    service: new PiNativeSessionService({
      createModelSelection: async () => {
        if (selectionGate) await selectionGate();
        return {
          models,
          model: faux.getModel(),
          providerId: faux.provider.id,
          modelId: faux.getModel().id
        };
      }
    })
  };
}

function promptRequest(sessionId, faux) {
  return {
    outputDir: workspaceDir,
    sessionId,
    prompt: "hello",
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
    thinkingLevel: "low"
  };
}

function findChild(messages, subagentId) {
  return messages.find((message) => (
    message.role === "custom" && message.details?.subagentId === subagentId
  ));
}

try {
  const repository = new PiSessionRepository(workspaceDir);
  const session = await repository.create("pi_restart_orphan");
  const metadata = await session.getMetadata();
  const subagentId = "subagent_orphan_after_process_exit";

  await appendRunningCard(session, subagentId);

  // A fresh service represents a cold Electron restart: no parent or child
  // runtime survived, while the Pi JSONL still contains the last live card.
  const restarted = new PiNativeSessionService();
  const runState = await restarted.getRunState(workspaceDir, metadata.id);
  assert.equal(runState.running, false);

  const [dockLoad, popoutLoad] = await Promise.all([
    restarted.loadMessages(workspaceDir, metadata.id),
    restarted.loadMessages(workspaceDir, metadata.id)
  ]);
  const recovered = findChild(dockLoad, subagentId);
  assert.ok(recovered, "the persisted Pi child card should remain visible after restart");
  assert.equal(recovered.details.status, "stopped", "a child runtime cannot remain running after its process exited");
  assert.equal(recovered.details.closed, true, "restart recovery must close the orphan child card");
  const popoutRecovered = findChild(popoutLoad, subagentId);
  assert.equal(popoutRecovered?.details?.status, "stopped", "concurrent popout load must observe the same terminal Pi card");

  const terminalEntryCount = async () => (await readFile(metadata.path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => (
      entry.type === "message"
      && entry.message?.role === "custom"
      && entry.message?.details?.subagentId === subagentId
      && entry.message?.details?.status === "stopped"
    )).length;

  assert.equal(await terminalEntryCount(), 1, "restart recovery must persist one terminal Pi message");
  await restarted.loadMessages(workspaceDir, metadata.id);
  assert.equal(await terminalEntryCount(), 1, "concurrent and repeated dock/popout loads must not duplicate restart recovery");
  await restarted.disposeWorkspace(workspaceDir);

  const loadFirstSession = await repository.create("pi_restart_load_first_race");
  const loadFirstMetadata = await loadFirstSession.getMetadata();
  const loadFirstId = "subagent_load_before_prompt_reservation";
  await appendRunningCard(loadFirstSession, loadFirstId);
  const loadFirst = createPromptService();
  const transitionEntered = deferred();
  const releaseTransition = deferred();
  const blocker = loadFirst.service.withSessionTransition(workspaceDir, loadFirstMetadata.id, async () => {
    transitionEntered.resolve();
    await releaseTransition.promise;
  });
  await transitionEntered.promise;
  const queuedLoad = loadFirst.service.loadMessages(workspaceDir, loadFirstMetadata.id);
  await Promise.resolve();
  const queuedPrompt = loadFirst.service.prompt(promptRequest(loadFirstMetadata.id, loadFirst.faux));
  releaseTransition.resolve();
  const [loadFirstMessages] = await Promise.all([queuedLoad, queuedPrompt, blocker]);
  assert.equal(
    findChild(loadFirstMessages, loadFirstId)?.details?.status,
    "stopped",
    "a later prompt reservation must not claim an orphan card queued for recovery"
  );
  await waitUntil(
    async () => !(await loadFirst.service.getRunState(workspaceDir, loadFirstMetadata.id)).running,
    "the load-first race prompt to settle"
  );
  await loadFirst.service.disposeWorkspace(workspaceDir);

  const promptFirstSession = await repository.create("pi_restart_prompt_first_race");
  const promptFirstMetadata = await promptFirstSession.getMetadata();
  const promptFirstId = "subagent_prompt_before_load";
  await appendRunningCard(promptFirstSession, promptFirstId);
  const selectionEntered = deferred();
  const releaseSelection = deferred();
  const promptFirst = createPromptService(async () => {
    selectionEntered.resolve();
    await releaseSelection.promise;
  });
  const promptBeforeLoad = promptFirst.service.prompt(promptRequest(promptFirstMetadata.id, promptFirst.faux));
  await selectionEntered.promise;
  const loadAfterPrompt = promptFirst.service.loadMessages(workspaceDir, promptFirstMetadata.id);
  releaseSelection.resolve();
  await promptBeforeLoad;
  const promptFirstMessages = await loadAfterPrompt;
  assert.equal(
    findChild(promptFirstMessages, promptFirstId)?.details?.status,
    "stopped",
    "a newly committed parent runtime must not claim a child from the previous process"
  );
  await waitUntil(
    async () => !(await promptFirst.service.getRunState(workspaceDir, promptFirstMetadata.id)).running,
    "the prompt-first race prompt to settle"
  );
  await promptFirst.service.disposeWorkspace(workspaceDir);

  console.log("ok cold restart recovery is idempotent across dock/popout and prompt reservation races");
} finally {
  await rm(workspaceDir, { recursive: true, force: true });
}
