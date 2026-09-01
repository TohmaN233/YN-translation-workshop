import { strict as assert } from "node:assert";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertLanSyncStartOwnership,
  normalizeLanSyncLineDocument,
  normalizeLanSyncProposalDocument,
  readLinkedLineReviewDocument,
  recordLineStateRevision
} from "../../src/main/lanSyncState.ts";

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

await test("normalizes line sync document rows and state", () => {
  const doc = normalizeLanSyncLineDocument({
    title: "sync",
    rows: [
      { line: 1, source: "a", translation: "b" },
      { line: 0, source: "bad" }
    ],
    state: { edits: { 1: "c" } },
    pageSize: 500
  });
  assert.equal(doc?.rows.length, 1);
  assert.equal(doc?.rows[0].translation, "b");
  assert.deepEqual(doc?.state, { edits: { 1: "c" } });
  assert.equal(doc?.pageSize, 500);
});

await test("normalizes the owning proposal review HTML path for durable LAN decisions", () => {
  const doc = normalizeLanSyncProposalDocument({
    title: "proposal",
    htmlPath: "C:\\project\\.translation-workshop\\html\\proposal.html",
    proposalDocument: {
      proposals: [{ id: "P1", line: 1, suggestion: "fixed" }],
      state: {}
    }
  });
  assert.equal(doc?.proposalReviewPath, "C:\\project\\.translation-workshop\\html\\proposal.html");
});

await test("LAN sync start binds every writable review document to the sender workspace", () => {
  const senderPath = "C:\\project\\.translation-workshop\\html\\proposal.html";
  assert.doesNotThrow(() => assertLanSyncStartOwnership({
    htmlPath: senderPath,
    lineReviewPath: "C:\\project\\.translation-workshop\\html\\line.html",
    proposalDocument: {
      proposals: [{ id: "P1" }],
      state: {},
      proposalReviewPath: senderPath,
      lineReviewPath: "C:\\project\\.translation-workshop\\html\\line.html"
    }
  }, senderPath));

  assert.throws(() => assertLanSyncStartOwnership({
    htmlPath: "C:\\other\\.translation-workshop\\html\\proposal.html",
    proposalDocument: { proposals: [{ id: "P1" }], state: {} }
  }, senderPath), /current HTML document/i);

  assert.throws(() => assertLanSyncStartOwnership({
    htmlPath: senderPath,
    proposalDocument: {
      proposals: [{ id: "P1" }],
      state: {},
      proposalReviewPath: "C:\\other\\.translation-workshop\\html\\proposal.html"
    }
  }, senderPath), /owning proposal review/i);

  assert.throws(() => assertLanSyncStartOwnership({
    htmlPath: senderPath,
    lineReviewPath: "C:\\other\\.translation-workshop\\html\\line.html"
  }, senderPath), /workspace boundary/i);
});

await test("records only recent revision history entries", () => {
  const state = {};
  for (let index = 1; index <= 14; index += 1) {
    recordLineStateRevision(state, 7, `text ${index}`, "manual", "test");
  }
  assert.equal(state.revisions["7"], 14);
  assert.equal(state.revisionHistory["7"].length, 12);
  assert.equal(state.revisionHistory["7"][0].revision, 3);
  assert.equal(state.revisionHistory["7"][11].text, "text 14");
});

await test("reads a valid line-review document larger than the legacy 80 MiB limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yn-large-line-review-"));
  const filePath = path.join(directory, "line-review.html");
  const file = await open(filePath, "w");
  try {
    await file.write('<script id="reviewData" type="application/json">{"rows":[{"line":1,"source":"source","translation":"target"}]}</script>');
    await file.truncate(81 * 1024 * 1024);
  } finally {
    await file.close();
  }
  try {
    const document = await readLinkedLineReviewDocument(filePath);
    assert.equal(document?.rows.length, 1);
    assert.equal(document?.rows[0].translation, "target");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
