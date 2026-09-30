import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { appendSessionMessage, readSessionContext, readSessionEntries } from "../../src/main/agent/piNative/sessionAccess.ts";

const timestamp = "2026-09-01T12:00:00.000Z";
const user = (content) => ({ role: "user", content, timestamp: Date.parse(timestamp) });
const usage = {
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const assistant = (text) => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
  provider: "test", model: "test-model", usage, stopReason: "stop", timestamp: Date.parse(timestamp)
});

async function fixture(workspace, id, { child = false, parentPath, entries = [] } = {}) {
  const directory = path.join(workspace, ".translation-workshop/agent", child ? "pi-child-sessions" : "pi-sessions",
    `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `2026-09-01T12-00-00-000Z_${id}.jsonl`);
  const text = [
    { type: "session", version: 3, id, timestamp, cwd: workspace, ...(parentPath ? { parentSession: parentPath } : {}) },
    ...entries.map((entry, index) => ({
      id: `legacy-${index}`, parentId: index === 0 ? null : `legacy-${index - 1}`, timestamp, ...entry
    }))
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(filePath, text, "utf8");
  return { path: filePath, text };
}

async function inWorkspace(run) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "yn-pi-v4-"));
  const repository = new PiSessionRepository(workspace);
  try { await run(workspace, repository); }
  finally {
    await repository.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

test("v3 history, compaction, host entries, name and usage survive native v4 write and reopen", async () => {
  await inWorkspace(async (workspace, repository) => {
    const legacy = await fixture(workspace, "legacy", { entries: [
      { type: "model_change", provider: "test", modelId: "test-model" },
      { type: "thinking_level_change", thinkingLevel: "medium" },
      { type: "session_info", name: "Original title" },
      { type: "message", message: user("first prompt") },
      { type: "message", message: assistant("original reply") },
      { type: "custom", customType: "yn.host-state", data: { schemaVersion: 1, marker: "preserved" } },
      { type: "compaction", summary: "native summary", firstKeptEntryId: "legacy-3", tokensBefore: 100, fromHook: false },
      { type: "message", message: user("after compaction") }
    ] });
    await repository.writeActiveSessionId("selected-other-session");
    const session = await repository.open("legacy");
    assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), legacy.text);
    assert.equal(JSON.parse((await readFile(legacy.path, "utf8")).split("\n")[0]).version, 3);
    assert.equal(await session.getName(BACKGROUND_CONTEXT), "Original title");
    const before = await readSessionContext(session);
    assert.equal(before.messages[0].role, "compactionSummary");
    assert.deepEqual(before.messages.filter((message) => message.role === "user").map((message) => message.content),
      ["first prompt", "after compaction"]);
    assert.equal((await repository.listSummaries())[0].firstMessage, "first prompt");
    assert.equal((await repository.listSummaries())[0].messageCount, 0);
    await appendSessionMessage(session, user("first native write"));
    const migrated = await readFile(legacy.path, "utf8");
    const records = migrated.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].v, 4);
    assert.equal(records[0].id, "legacy");
    assert.ok(records.slice(1).flatMap((record) => Array.isArray(record) ? record : [record])
      .every((write) => ["entry", "usage", "value", "list"].includes(write.kind)), "native transaction writes must keep their native kind");
    assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), legacy.text);
    await repository.closeSession("legacy");
    const reopened = await repository.open("legacy");
    assert.equal((await readSessionContext(reopened)).messages.at(-1).content, "first native write");
    assert.equal((await reopened.getStats(BACKGROUND_CONTEXT)).usage.totalTokens, 15);
    assert.equal((await reopened.getStats(BACKGROUND_CONTEXT)).messageCount, 4);
    assert.equal((await readSessionEntries(reopened)).find((entry) => entry.customType === "yn.host-state").data.marker, "preserved");
    assert.equal(await readFile(legacy.path, "utf8"), migrated, "reopening v4 must not rewrite native transactions");
    assert.equal(await repository.readActiveSessionId(), "selected-other-session");
  });
});

test("v3 parent transcript slimming backs up original and leaves child JSONL intact", async () => {
  await inWorkspace(async (workspace, repository) => {
    const details = { subagent: { id: "child", resultSummary: "done", transcript: [{ content: "large child body" }], reply: "large reply" } };
    const parent = await fixture(workspace, "parent", { entries: [
      { type: "message", message: user("parent prompt") },
      { type: "message", message: { role: "toolResult", toolCallId: "inspect", toolName: "inspectSubagents",
        details, content: [{ type: "text", text: JSON.stringify(details) }], isError: false, timestamp: Date.parse(timestamp) } },
      { type: "custom_message", customType: "subagent.translation", content: "large reply",
        details: { resultSummary: "done", prompt: "large prompt", reply: "large reply", transcript: ["large child body"] } }
    ] });
    const child = await fixture(workspace, "child", { child: true, parentPath: parent.path,
      entries: [{ type: "message", message: user("child content") }] });
    const parentSession = await repository.open("parent");
    assert.equal(await readFile(`${parent.path}.v3.backup`, "utf8"), parent.text);
    assert.doesNotMatch(await readFile(parent.path, "utf8"), /large child body|large reply|large prompt/);
    assert.equal(await readFile(child.path, "utf8"), child.text);
    const childMetadata = await repository.findChildMetadata("child");
    assert.equal(childMetadata.parentSessionId, "parent");
    const childSession = await repository.openChildForParent("child", "parent");
    await appendSessionMessage(childSession, user("child native append"));
    await appendSessionMessage(parentSession, user("parent native append"));
    const migratedParent = await readFile(parent.path, "utf8");
    await repository.closeSession("parent");
    await repository.open("parent");
    assert.equal(await readFile(parent.path, "utf8"), migratedParent);
    assert.equal(JSON.parse((await readFile(child.path, "utf8")).split("\n")[0]).parentSessionId, "parent");
    assert.equal(await readFile(`${child.path}.v3.backup`, "utf8"), child.text);
    await repository.delete("parent");
    assert.deepEqual(await repository.listChildMetadata(), []);
    assert.equal(await readFile(`${parent.path}.v3.backup`, "utf8"), parent.text);
  });
});

test("new children enforce ID ownership even when their parent is created later", async () => {
  await inWorkspace(async (_workspace, repository) => {
    await repository.create("parent");
    await repository.create("other");
    const child = await repository.createChild("child", "parent");
    assert.equal(child.metadata.parentSessionId, "parent");
    assert.equal(child.metadata.legacyParentSessionPath, undefined);
    assert.equal(await repository.openChildForParent("child", "parent"), child);
    await assert.rejects(repository.openChildForParent("child", "other"), /does not belong/);
    const detached = await repository.createChild("orphan", "missing");
    assert.equal(detached.metadata.parentSessionId, "missing");
    await assert.rejects(repository.openChildForParent("orphan", "parent"), /does not belong/);
    await repository.delete("other");
    assert.ok(await repository.findChildMetadata("child"));
  });
});

test("legacy path fallback validates the actual parent and never overrides an explicit ID", async () => {
  await inWorkspace(async (workspace, repository) => {
    const parent = await repository.create("parent");
    const child = await repository.createChild("fallback");
    await repository.closeChildSession("fallback");
    const filePath = child.metadata.path;
    const original = await readFile(filePath, "utf8");
    const lines = original.trimEnd().split("\n");
    const header = JSON.parse(lines[0]);
    header.legacyParentSessionPath = parent.metadata.path;
    lines[0] = JSON.stringify(header);
    await writeFile(filePath, `${lines.join("\n")}\n`);
    await repository.openChildForParent("fallback", "parent");
    await repository.closeChildSession("fallback");
    header.parentSessionId = "different-parent";
    lines[0] = JSON.stringify(header);
    await writeFile(filePath, `${lines.join("\n")}\n`);
    await assert.rejects(repository.openChildForParent("fallback", "parent"), /does not belong/);
    delete header.parentSessionId;
    header.legacyParentSessionPath = path.join(workspace, "unrelated.jsonl");
    lines[0] = JSON.stringify(header);
    await writeFile(filePath, `${lines.join("\n")}\n`);
    await assert.rejects(repository.openChildForParent("fallback", "parent"), /does not belong/);
  });
});

test("concurrent migration retains exactly the original backup and selection", async () => {
  await inWorkspace(async (workspace, repository) => {
    const legacy = await fixture(workspace, "concurrent", { entries: [{ type: "message", message: user("prompt") }] });
    const second = new PiSessionRepository(workspace);
    try {
      await repository.writeActiveSessionId("keep-selected");
      const [a, same, b] = await Promise.all([repository.open("concurrent"), repository.open("concurrent"), second.open("concurrent")]);
      assert.equal(a, same);
      assert.notEqual(a, b);
      assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), legacy.text);
      assert.equal(await repository.readActiveSessionId(), "keep-selected");
    } finally { await second.close(); }
  });
});

test("backup publication failure rejects before a legacy file or selection is changed", async () => {
  await inWorkspace(async (workspace, repository) => {
    const legacy = await fixture(workspace, "backup-failure", { entries: [{ type: "message", message: user("prompt") }] });
    await mkdir(`${legacy.path}.v3.backup`);
    await repository.writeActiveSessionId("selected");
    await assert.rejects(repository.open("backup-failure"));
    assert.equal(await readFile(legacy.path, "utf8"), legacy.text);
    assert.equal(await repository.readActiveSessionId(), "selected");
    await rm(`${legacy.path}.v3.backup`, { recursive: true });
    await repository.open("backup-failure");
    assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), legacy.text);
  });
});

test("malformed legacy transcript data fails visibly with original backup and no migration marker", async () => {
  await inWorkspace(async (workspace, repository) => {
    const legacy = await fixture(workspace, "invalid-inspection", { entries: [{ type: "message", message: {
      role: "toolResult", toolCallId: "inspect", toolName: "inspectSubagents", content: [{ type: "text", text: '{"transcript": invalid}' }],
      details: {}, isError: false, timestamp: Date.parse(timestamp)
    } }] });
    await assert.rejects(repository.open("invalid-inspection"), /not valid JSON/);
    assert.equal(await readFile(legacy.path, "utf8"), legacy.text);
    assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), legacy.text);
    await assert.rejects(readFile(path.join(workspace, ".translation-workshop/agent/pi-session-migrations.json")), { code: "ENOENT" });
  });
});

test("an existing same-ID backup from different content rejects without overwriting either file", async () => {
  await inWorkspace(async (workspace, repository) => {
    const legacy = await fixture(workspace, "backup-collision", { entries: [{ type: "message", message: user("current prompt") }] });
    const unrelatedBackup = legacy.text.replace("current prompt", "unrelated prompt");
    await writeFile(`${legacy.path}.v3.backup`, unrelatedBackup);
    await assert.rejects(repository.open("backup-collision"), /backup does not match/);
    assert.equal(await readFile(legacy.path, "utf8"), legacy.text);
    assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), unrelatedBackup);
  });
});

test("native v4 publication failure preserves v3 and backup and can retry in the same session", async () => {
  await inWorkspace(async (workspace, repository) => {
    const legacy = await fixture(workspace, "write-failure", { entries: [{ type: "message", message: user("prompt") }] });
    const session = await repository.open("write-failure");
    const rename = repository.env.renameFile;
    repository.env.renameFile = async () => ({ ok: false, error: new Error("injected native publication failure") });
    try {
      await assert.rejects(appendSessionMessage(session, user("retry append")), /injected native publication failure/);
    } finally { repository.env.renameFile = rename; }
    assert.equal(await readFile(legacy.path, "utf8"), legacy.text);
    assert.equal(await readFile(`${legacy.path}.v3.backup`, "utf8"), legacy.text);
    assert.equal((await readSessionContext(session)).messages.length, 1);
    await appendSessionMessage(session, user("retry append"));
    assert.equal((await readSessionContext(session)).messages.at(-1).content, "retry append");
    assert.equal(JSON.parse((await readFile(legacy.path, "utf8")).split("\n")[0]).v, 4);
  });
});

test("summary readers close without closing cached runtime sessions", async () => {
  await inWorkspace(async (_workspace, repository) => {
    const session = await repository.create("summary");
    await appendSessionMessage(session, user("native user title"));
    assert.equal((await repository.listSummaries())[0].firstMessage, "native user title");
    assert.equal((await repository.listSummaries())[0].messageCount, 0, "sidebar summaries do not scan full history");
    assert.equal(await repository.open("summary"), session);
    await appendSessionMessage(session, user("after summary"));
    assert.equal((await session.getStats(BACKGROUND_CONTEXT)).messageCount, 2);
    await repository.closeSession("summary");
    await repository.open("summary");
  });
});
