import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

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
  const promise = new Promise((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

await test("cold session loading reports sequenced progress and aborts its open signal immediately", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-cold-storage-stop-"));
  const service = new PiNativeSessionService();
  const session = await service.createSession(workspaceDir);
  const originalOpen = PiSessionRepository.prototype.open;
  const openStarted = deferred();
  const events = [];
  let openOptions;
  const unsubscribe = service.subscribeEvents((envelope) => events.push(envelope));
  PiSessionRepository.prototype.open = async function (_sessionId, options) {
    openOptions = options;
    options.onProgress({ phase: "scan", processedBytes: 12, totalBytes: 120 });
    openStarted.resolve();
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    const loading = service.loadMessages(workspaceDir, session.id);
    await openStarted.promise;
    assert.ok(openOptions.signal instanceof AbortSignal);
    const stopping = service.abort(workspaceDir, session.id);
    assert.equal(openOptions.signal.aborted, true, "Stop must signal storage before waiting for the session transition");
    await assert.rejects(loading, (error) => error?.name === "AbortError");
    await stopping;
    const progress = events.filter((event) => event.event.type === "storage_progress");
    assert.deepEqual(progress.map((event) => event.sequence), [1, 2]);
    assert.deepEqual(progress.at(-1).event.progress, { phase: "scan", processedBytes: 12, totalBytes: 120 });
  } finally {
    unsubscribe();
    PiSessionRepository.prototype.open = originalOpen;
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("cold prompt preparation passes Stop to session storage without replacing the owner", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-cold-prompt-stop-"));
  const service = new PiNativeSessionService();
  const session = await service.createSession(workspaceDir);
  const originalOpen = PiSessionRepository.prototype.open;
  const openStarted = deferred();
  let openOptions;
  PiSessionRepository.prototype.open = async function (_sessionId, options) {
    openOptions = options;
    openStarted.resolve();
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    const prompt = service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "start",
      providerId: "unused",
      modelId: "unused"
    });
    await openStarted.promise;
    const stopping = service.abort(workspaceDir, session.id);
    assert.equal(openOptions.signal.aborted, true, "prompt Stop must synchronously signal cold storage");
    await assert.rejects(prompt, (error) => error?.name === "AbortError");
    await stopping;
    assert.equal(service.active.has(`${path.resolve(workspaceDir).toLowerCase()}::${session.id}`), false);
  } finally {
    PiSessionRepository.prototype.open = originalOpen;
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

console.log(`\n# ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
