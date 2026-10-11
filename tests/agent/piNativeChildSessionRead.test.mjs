import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { appendSessionMessage, getOpenDiskSession, readSessionContext } from "../../src/main/agent/piNative/sessionAccess.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-session-read-"));
const ownerRepository = new PiSessionRepository(workspaceDir);
const parent = await ownerRepository.create("parent-session");
const child = await ownerRepository.createChild("child-session", parent.metadata.id);
const childPath = child.metadata.path;

try {
  await appendSessionMessage(child, userMessage("before inspection"));
  assert.equal(getOpenDiskSession(childPath), child);

  const readerRepository = new PiSessionRepository(workspaceDir);
  const readEntered = deferred();
  const releaseRead = deferred();
  const inspection = readerRepository.withChildSessionReadForParent(
    child.metadata.id,
    parent.metadata.id,
    async (session) => {
      assert.equal(session, child, "inspection borrows the current native Session owner");
      readEntered.resolve();
      await releaseRead.promise;
      return readSessionContext(session);
    }
  );
  await readEntered.promise;

  let appendFinished = false;
  const append = appendSessionMessage(child, userMessage("appended while inspection waited"))
    .then(() => { appendFinished = true; });
  await Promise.resolve();
  assert.equal(appendFinished, false, "the read holds the Pi mutation line while it snapshots the transcript");

  releaseRead.resolve();
  const snapshot = await inspection;
  await append;
  assert.deepEqual(snapshot.messages.map((message) => message.content[0]?.text), ["before inspection"]);
  assert.equal(getOpenDiskSession(childPath), child, "inspection must not close the runtime owner");

  const service = new PiNativeSessionService();
  const displayed = await service.loadSubagentMessages(workspaceDir, parent.metadata.id, child.metadata.id);
  assert.deepEqual(displayed.map((message) => message.content[0]?.text), [
    "before inspection",
    "appended while inspection waited"
  ]);
  await appendSessionMessage(child, userMessage("append after inspection"));
  assert.equal(getOpenDiskSession(childPath), child, "the existing owner remains writable after UI inspection");
  assert.equal((await readSessionContext(child)).messages.length, 3);
  await readerRepository.close();
} finally {
  await ownerRepository.close();
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("ok child transcript reads borrow and serialize with the live native session owner");
