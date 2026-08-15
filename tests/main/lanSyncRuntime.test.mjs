import { strict as assert } from "node:assert";

import {
  commitLanSyncPatch,
  applyLanSyncPatchTransaction,
  applyLanSyncPatchToSession,
  hashLanSyncPin,
  isLanSyncAuthorized,
  isValidLanSyncPin,
  lanSyncAuthTokenFrom,
  lanSyncSessionPayload,
  normalizeLanSyncCommand,
  persistLanSyncDocumentPatch,
  registerLanSyncSession,
  stopLanSyncSession
} from "../../src/main/lanSyncRuntime.ts";

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

function client() {
  return {
    destroyed: false,
    chunks: [],
    ended: false,
    write(value) {
      this.chunks.push(String(value));
    },
    end() {
      this.ended = true;
    }
  };
}

function session(patch = {}) {
  return {
    token: "tok",
    title: "sync",
    locale: "zh-CN",
    authTokens: new Set(["auth"]),
    clients: new Set(),
    documents: {
      line: {
        title: "line",
        rows: [{ line: 1, source: "src", translation: "old", status: "draft" }],
        state: {},
        pageSize: 100,
        lineReviewPath: "line.html"
      },
      proposal: {
        title: "proposal",
        proposals: [{ id: "P1", line: 1, suggestion: "new" }],
        state: {},
        pageSize: 50,
        reportPath: "report.json",
        proposalReviewPath: "C:\\project\\.translation-workshop\\html\\proposal.html"
      }
    },
    ownerWebContentsId: 1,
    pinHash: hashLanSyncPin("123456"),
    createdAt: new Date(0).toISOString(),
    ...patch
  };
}

await test("LAN sync auth helpers validate PIN and auth token source", () => {
  assert.equal(isValidLanSyncPin("123456"), true);
  assert.equal(isValidLanSyncPin("12345"), false);
  const item = session();
  assert.equal(isLanSyncAuthorized(item, "auth"), true);
  assert.equal(isLanSyncAuthorized(item, "missing"), false);
  assert.equal(lanSyncAuthTokenFrom(new URL("http://x.test/?auth=query"), { authToken: "body" }), "query");
  assert.equal(lanSyncAuthTokenFrom(new URL("http://x.test/"), { authToken: "body" }), "body");
});

await test("LAN sync accepts only the desktop Agent open command", () => {
  assert.deepEqual(normalizeLanSyncCommand({ type: "open-agent-os", clientId: "remote" }), {
    type: "open-agent-os",
    clientId: "remote"
  });
  assert.equal(normalizeLanSyncCommand({ type: "run-shell" }), undefined);
  assert.equal(normalizeLanSyncCommand(null), undefined);
});

await test("LAN sync session payload preserves line and proposal documents", () => {
  const payload = lanSyncSessionPayload(session());
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.documents.line.lineReviewPath, "line.html");
  assert.equal(payload.documents.proposal.reportPath, "report.json");
  assert.equal(payload.labels.search, "搜索");
  assert.equal("agentStart" in payload.labels, false);
});

await test("LAN sync patch mutates line and proposal state with revision history", () => {
  const item = session();
  applyLanSyncPatchToSession(item, { type: "line-edit", line: 1, text: "new", status: "manual" });
  assert.equal(item.documents.line.state.edits["1"], "new");
  assert.equal(item.documents.line.state.status["1"], "manual");
  assert.equal(item.documents.line.state.revisionHistory["1"].length, 1);

  applyLanSyncPatchToSession(item, { type: "proposal-decision", proposalId: "P1", status: "rejected" });
  assert.equal(item.documents.proposal.state.decisions.P1.status, "rejected");
});

await test("LAN sync line patch commits only after canonical persistence succeeds", async () => {
  const item = session();
  const before = structuredClone(item.documents.line.state);
  let stagedText = "";

  await assert.rejects(
    applyLanSyncPatchTransaction(
      item,
      { type: "line-edit", line: 1, text: "rejected", status: "manual" },
      async (staged) => {
        stagedText = staged.documents.line.state.edits["1"];
        throw new Error("canonical persistence failed");
      }
    ),
    /canonical persistence failed/
  );
  assert.equal(stagedText, "rejected");
  assert.deepEqual(item.documents.line.state, before);

  await applyLanSyncPatchTransaction(
    item,
    { type: "line-edit", line: 1, text: "persisted", status: "manual" },
    async (staged) => {
      assert.equal(staged.documents.line.state.edits["1"], "persisted");
      assert.deepEqual(item.documents.line.state, before);
    }
  );
  assert.equal(item.documents.line.state.edits["1"], "persisted");
  assert.equal(item.documents.line.state.status["1"], "manual");
});

await test("LAN sync proposal decisions persist the staged canonical proposal state before commit", async () => {
  const item = session();
  item.documents.proposal.state.decisions = {
    P1: {
      status: "conflict",
      manualText: "",
      conflictCurrentText: "newer local text"
    }
  };
  const before = structuredClone(item.documents.proposal.state);
  let persisted;

  await applyLanSyncPatchTransaction(
    item,
    {
      type: "proposal-decision",
      proposalId: "P1",
      status: "accepted",
      manualText: "fixed",
      overrideConflict: true,
      conflictReason: "patch-conflict"
    },
    (staged, patch) => persistLanSyncDocumentPatch(staged, patch, {
      persistLine: async () => assert.fail("proposal decisions must not use line persistence"),
      persistProposal: async (document) => {
        persisted = {
          path: document.proposalReviewPath,
          state: structuredClone(document.state)
        };
        assert.deepEqual(item.documents.proposal.state, before);
      }
    })
  );

  assert.equal(persisted.path, "C:\\project\\.translation-workshop\\html\\proposal.html");
  assert.deepEqual(persisted.state.decisions.P1, {
    status: "accepted",
    manualText: "fixed",
    conflictCurrentText: "newer local text",
    overrideConflict: true,
    conflictReason: "patch-conflict"
  });
  assert.deepEqual(item.documents.proposal.state.decisions.P1, persisted.state.decisions.P1);
});

await test("LAN sync proposal persistence failure cannot publish or mutate live state", async () => {
  const item = session();
  const before = structuredClone(item.documents.proposal.state);
  let publishCount = 0;

  await assert.rejects(
    commitLanSyncPatch(
      item,
      { type: "proposal-decision", proposalId: "P1", status: "rejected" },
      (staged, patch) => persistLanSyncDocumentPatch(staged, patch, {
        persistLine: async () => assert.fail("proposal decisions must not use line persistence"),
        persistProposal: async () => {
          throw new Error("proposal sidecar persistence failed");
        }
      }),
      async () => {
        publishCount += 1;
      }
    ),
    /proposal sidecar persistence failed/
  );

  assert.deepEqual(item.documents.proposal.state, before);
  assert.equal(publishCount, 0);
});

await test("LAN sync canonical commit publishes only after persistence and live-state commit", async () => {
  const item = session();
  const before = structuredClone(item.documents.line.state);
  let publishCount = 0;

  await assert.rejects(
    commitLanSyncPatch(
      item,
      { type: "line-edit", line: 1, text: "rejected", status: "manual" },
      async () => {
        throw new Error("canonical persistence failed");
      },
      async () => {
        publishCount += 1;
      }
    ),
    /canonical persistence failed/
  );
  assert.deepEqual(item.documents.line.state, before);
  assert.equal(publishCount, 0);

  await commitLanSyncPatch(
    item,
    { type: "line-edit", line: 1, text: "persisted", status: "manual" },
    async (staged) => {
      assert.equal(staged.documents.line.state.edits["1"], "persisted");
      assert.deepEqual(item.documents.line.state, before);
    },
    async () => {
      publishCount += 1;
      assert.equal(item.documents.line.state.edits["1"], "persisted");
    }
  );
  assert.equal(publishCount, 1);
});

await test("LAN sync serializes concurrent canonical commits for one session", async () => {
  const item = session();
  item.documents.line.rows.push({ line: 2, source: "src-2", translation: "old-2", status: "draft" });
  const published = [];

  await Promise.all([
    commitLanSyncPatch(
      item,
      { type: "line-edit", line: 1, text: "first", status: "manual" },
      async () => new Promise((resolve) => setTimeout(resolve, 30)),
      async (_session, committedPatch) => published.push(committedPatch.line)
    ),
    commitLanSyncPatch(
      item,
      { type: "line-edit", line: 2, text: "second", status: "manual" },
      async () => new Promise((resolve) => setTimeout(resolve, 1)),
      async (_session, committedPatch) => published.push(committedPatch.line)
    )
  ]);

  assert.deepEqual(item.documents.line.state.edits, { "1": "first", "2": "second" });
  assert.deepEqual(published, [1, 2], "broadcast order must match durable commit order");
});

await test("LAN sync stop closes clients and removes session", async () => {
  const item = session();
  const sink = client();
  item.clients.add(sink);
  const sessions = new Map([[item.token, item]]);
  await stopLanSyncSession(item, sessions);
  assert.equal(sessions.has(item.token), false);
  assert.equal(sink.ended, true);
  assert.match(sink.chunks.join(""), /event: stop/);
});

await test("LAN sync registration keeps exactly one session per desktop owner", async () => {
  const first = session({ token: "first", ownerWebContentsId: 7 });
  const firstClient = client();
  first.clients.add(firstClient);
  const other = session({ token: "other", ownerWebContentsId: 8 });
  const replacement = session({ token: "replacement", ownerWebContentsId: 7 });
  const sessions = new Map([
    [first.token, first],
    [other.token, other]
  ]);

  await registerLanSyncSession(replacement, sessions);

  assert.equal(sessions.has("first"), false);
  assert.equal(firstClient.ended, true);
  assert.match(firstClient.chunks.join(""), /event: stop/);
  assert.equal(sessions.get("other"), other);
  assert.equal(sessions.get("replacement"), replacement);
  assert.equal([...sessions.values()].filter((item) => item.ownerWebContentsId === 7).length, 1);
});

await test("LAN sync replacement drains the active commit and rejects queued stale writes", async () => {
  const first = session({ token: "first", ownerWebContentsId: 7 });
  first.documents.line.rows.push({ line: 2, source: "src-2", translation: "old-2", status: "draft" });
  const replacement = session({ token: "replacement", ownerWebContentsId: 7 });
  const sessions = new Map([[first.token, first]]);
  const persisted = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const firstCommit = commitLanSyncPatch(
    first,
    { type: "line-edit", line: 1, text: "first", status: "manual" },
    async () => {
      persisted.push("first-start");
      markFirstStarted();
      await firstGate;
      persisted.push("first-end");
    },
    async () => persisted.push("first-publish")
  );
  await firstStarted;
  const queuedCommit = commitLanSyncPatch(
    first,
    { type: "line-edit", line: 2, text: "stale", status: "manual" },
    async () => persisted.push("queued-persist"),
    async () => persisted.push("queued-publish")
  );

  const registration = registerLanSyncSession(replacement, sessions);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sessions.has("replacement"), false, "replacement must wait for the old durable tail");

  releaseFirst();
  await firstCommit;
  await assert.rejects(queuedCommit, /stopped|closed/i);
  await registration;

  assert.deepEqual(persisted, ["first-start", "first-end"]);
  assert.equal(sessions.has("first"), false);
  assert.equal(sessions.get("replacement"), replacement);
});

await test("LAN sync never registers a replacement after its owner is destroyed", async () => {
  const first = session({ token: "first", ownerWebContentsId: 7 });
  const replacement = session({ token: "replacement", ownerWebContentsId: 7 });
  const sessions = new Map([[first.token, first]]);
  let ownerActive = true;
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const activeCommit = commitLanSyncPatch(
    first,
    { type: "line-edit", line: 1, text: "first", status: "manual" },
    async () => {
      markStarted();
      await gate;
    },
    async () => undefined
  );
  await started;

  const registration = registerLanSyncSession(replacement, sessions, () => ownerActive);
  ownerActive = false;
  releaseFirst();

  await activeCommit;
  assert.equal(await registration, false);
  assert.equal(sessions.has("first"), false);
  assert.equal(sessions.has("replacement"), false);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
