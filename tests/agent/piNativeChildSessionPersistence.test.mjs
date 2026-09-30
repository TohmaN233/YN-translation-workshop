import { readSessionConversation, appendSessionMessage } from "../helpers/pi-session.mjs";
import { strict as assert } from "node:assert";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

await test("Pi child sessions persist as reopenable JSONL without entering the parent session list", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-jsonl-"));
  const repository = new PiSessionRepository(workspaceDir);
  const reopenedRepository = new PiSessionRepository(workspaceDir);
  try {
    const parent = await repository.create("parent-session");
    const child = await repository.createChild("child-session", "parent-session");
    await appendSessionMessage(child, {
      role: "user",
      content: "persist this child turn",
      timestamp: Date.now()
    });

    const parentMetadata = await repository.findMetadata("parent-session");
    const childMetadata = await repository.findChildMetadata("child-session");
    assert.ok(parentMetadata);
    assert.ok(childMetadata);
    assert.match(childMetadata.path, /pi-child-sessions[\\/].+\.jsonl$/i);
    assert.equal(childMetadata.parentSessionId, parentMetadata.id);
    await access(childMetadata.path);
    assert.deepEqual((await repository.listMetadata()).map((item) => item.id), ["parent-session"]);

    const reopened = await reopenedRepository.openChildForParent("child-session", "parent-session");
    const context = await readSessionConversation(reopened);
    assert.deepEqual(context.messages.map((message) => message.role), ["user"]);
    assert.equal(context.messages[0].content, "persist this child turn");

    const unrelatedParent = await reopenedRepository.create("unrelated-parent");
    await assert.rejects(
      reopenedRepository.openChildForParent("child-session", unrelatedParent.metadata.id),
      /does not belong to Pi session unrelated-parent/
    );

    assert.equal(await reopenedRepository.delete("parent-session"), true);
    assert.deepEqual(await reopenedRepository.listChildMetadata(), []);
    await assert.rejects(access(childMetadata.path), /ENOENT/);
  } finally {
    await reopenedRepository.close();
    await repository.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("opening a legacy parent session removes embedded child transcripts without touching child JSONL", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-parent-migration-"));
  const repository = new PiSessionRepository(workspaceDir);
  const reopenedRepository = new PiSessionRepository(workspaceDir);
  try {
    const parent = await repository.create("legacy-parent-session");
    const child = await repository.createChild("preserved-child-session", "legacy-parent-session");
    await appendSessionMessage(child, {
      role: "assistant",
      content: [{ type: "text", text: "child transcript remains in the child session" }],
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    });

    const transcript = Array.from({ length: 5_000 }, (_, index) => ({
      role: "assistant",
      content: [{ type: "text", text: `large child message ${index}` }],
      timestamp: index
    }));
    const legacyDetails = {
      subagent: {
        id: "preserved-child-session",
        status: "completed",
        resultSummary: "translated requested range",
        transcript,
        reply: "full child reply must not remain in the parent"
      }
    };
    await appendSessionMessage(parent, {
      role: "toolResult",
      toolCallId: "inspect-call",
      toolName: "inspectSubagents",
      content: [{ type: "text", text: JSON.stringify(legacyDetails) }],
      details: legacyDetails,
      isError: false,
      timestamp: Date.now()
    });
    await appendSessionMessage(parent, {
      role: "custom",
      customType: "subagent.translation",
      content: `full child reply ${"x".repeat(50_000)}`,
      details: {
        subagentId: "preserved-child-session",
        label: "worker-1",
        status: "completed",
        prompt: `full child prompt ${"p".repeat(50_000)}`,
        reply: `full child reply ${"r".repeat(50_000)}`,
        resultSummary: "translated requested range",
        transcript
      },
      timestamp: Date.now()
    });

    const parentMetadata = await repository.findMetadata("legacy-parent-session");
    const childMetadata = await repository.findChildMetadata("preserved-child-session");
    assert.ok(parentMetadata);
    assert.ok(childMetadata);
    // The released runtime wrote flat format-3 records. Build the real old
    // fixture after releasing its native handle; native format-4 transactions
    // must never be modified by the legacy transcript slimming migration.
    const legacyMessages = (await readSessionConversation(parent)).messages;
    await repository.closeSession(parentMetadata.id);
    const legacyParentText = [
      { type: "session", version: 3, id: parentMetadata.id, cwd: workspaceDir,
        timestamp: new Date(parentMetadata.createdAt).toISOString() },
      ...legacyMessages.map((message, index) => ({
        type: "message", id: `legacy-message-${index}`,
        parentId: index === 0 ? null : `legacy-message-${index - 1}`,
        timestamp: new Date(message.timestamp).toISOString(), message
      }))
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(parentMetadata.path, legacyParentText, "utf8");
    const sizeBefore = (await stat(parentMetadata.path)).size;
    const childBefore = await readFile(childMetadata.path, "utf8");

    const reopened = await reopenedRepository.open("legacy-parent-session");
    const context = await readSessionConversation(reopened);
    const migrated = context.messages.find((message) => message.role === "toolResult");
    assert.ok(migrated);
    assert.equal(migrated.toolName, "inspectSubagents");
    assert.equal(migrated.details.subagent.resultSummary, "translated requested range");
    assert.equal("transcript" in migrated.details.subagent, false);
    assert.equal("reply" in migrated.details.subagent, false);
    assert.doesNotMatch(migrated.content[0].text, /large child message|full child reply/);
    const migratedCard = context.messages.find((message) => message.role === "custom");
    assert.ok(migratedCard);
    assert.equal(migratedCard.content, "translated requested range");
    assert.equal("prompt" in migratedCard.details, false);
    assert.equal("reply" in migratedCard.details, false);
    assert.equal("transcript" in migratedCard.details, false);

    const parentAfter = await readFile(parentMetadata.path, "utf8");
    const sizeAfter = (await stat(parentMetadata.path)).size;
    assert.doesNotMatch(parentAfter, /large child message|full child prompt|full child reply/);
    assert.ok(sizeAfter < sizeBefore / 20, `${sizeAfter} should be much smaller than ${sizeBefore}`);
    assert.equal(await readFile(childMetadata.path, "utf8"), childBefore);
    assert.equal(await readFile(`${parentMetadata.path}.v3.backup`, "utf8"), legacyParentText);

    const reopenedChild = await reopenedRepository.openChildForParent(
      "preserved-child-session",
      "legacy-parent-session"
    );
    assert.equal((await readSessionConversation(reopenedChild)).messages[0].content[0].text, "child transcript remains in the child session");
  } finally {
    await reopenedRepository.close();
    await repository.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

console.log(`\n# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
