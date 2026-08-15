import { strict as assert } from "node:assert";

import {
  assertExpectedLineRevisions,
  acceptLineReviewMutationSequence,
  mergeCanonicalLineReviewState,
  mergeLegacyProposalLineReviewState
} from "../../src/main/lineReviewStateSync.ts";

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

await test("a stale folder-frame flush cannot overwrite a newer standalone edit", () => {
  const current = {
    documentRevision: 4,
    edits: { 1: "new standalone text" },
    status: { 1: "manual" },
    revisions: { 1: 2 },
    page: 1,
    translationPath: "new-translation.txt"
  };
  const staleFrame = {
    documentRevision: 2,
    edits: { 1: "old frame text" },
    status: { 1: "manual" },
    revisions: { 1: 1 },
    page: 2,
    translationPath: "old-translation.txt"
  };

  const merged = mergeCanonicalLineReviewState(current, staleFrame, []);
  assert.equal(merged.edits[1], "new standalone text");
  assert.equal(merged.revisions[1], 2);
  assert.equal(merged.page, 1);
  assert.equal(merged.translationPath, "new-translation.txt");
  assert.equal(merged.documentRevision, 5);
});

await test("an explicit document metadata patch updates the canonical path", () => {
  const current = {
    documentRevision: 5,
    translationPath: "old-translation.txt",
    translationPromptPath: "old-translation.txt"
  };
  const incoming = {
    documentRevision: 3,
    translationPath: "new-translation.txt",
    translationPromptPath: "new-prompt.txt",
    page: 99
  };

  const merged = mergeCanonicalLineReviewState(
    current,
    incoming,
    [],
    ["translationPath", "translationPromptPath"]
  );
  assert.equal(merged.translationPath, "new-translation.txt");
  assert.equal(merged.translationPromptPath, "new-prompt.txt");
  assert.equal(merged.page, undefined);
  assert.equal(merged.documentRevision, 6);
});

await test("a line patch merges with edits committed by another view", () => {
  const current = {
    documentRevision: 7,
    edits: { 1: "view A" },
    status: { 1: "manual" },
    revisions: { 1: 3 }
  };
  const incoming = {
    documentRevision: 4,
    edits: { 1: "stale A", 2: "view B" },
    status: { 1: "manual", 2: "manual" },
    revisions: { 1: 1, 2: 1 }
  };

  const merged = mergeCanonicalLineReviewState(current, incoming, [2]);
  assert.deepEqual(merged.edits, { 1: "view A", 2: "view B" });
  assert.deepEqual(merged.revisions, { 1: 3, 2: 1 });
  assert.equal(merged.documentRevision, 8);
});

await test("restoring a line deletes its canonical edit without touching other lines", () => {
  const current = {
    documentRevision: 9,
    edits: { 1: "keep", 2: "remove" },
    status: { 1: "manual", 2: "manual" }
  };
  const incoming = {
    documentRevision: 9,
    edits: { 1: "keep" },
    status: { 1: "manual" }
  };

  const merged = mergeCanonicalLineReviewState(current, incoming, [2]);
  assert.deepEqual(merged.edits, { 1: "keep" });
  assert.deepEqual(merged.status, { 1: "manual" });
});

await test("the Host rejects an older mutation from the same HTML client", () => {
  const sequences = new Map();
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-a", "client-a:8"), true);
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-a", "client-a:7"), false);
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-a", "client-a:8"), false);
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-a", "client-a:9"), true);
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-b", "client-b:1"), true);
});

await test("legacy or malformed mutation ids remain compatible", () => {
  const sequences = new Map();
  assert.equal(acceptLineReviewMutationSequence(sequences, "", ""), true);
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-a", "another-client:1"), true);
  assert.equal(acceptLineReviewMutationSequence(sequences, "client-a", "client-a:not-a-number"), true);
  assert.equal(sequences.size, 0);
});

await test("proposal commits reject a stale line revision instead of overwriting another view", () => {
  assert.doesNotThrow(() => assertExpectedLineRevisions(
    { revisions: { 7: 3 } },
    { 7: 3 },
    [7]
  ));
  assert.throws(
    () => assertExpectedLineRevisions(
      { revisions: { 7: 4 } },
      { 7: 3 },
      [7]
    ),
    /line 7 changed from revision 3 to 4/i
  );
});

await test("an accepted legacy proposal replaces the canonical machine baseline", () => {
  const current = {
    documentRevision: 147,
    edits: {
      1: "keep this imported line",
      10: "canonical machine baseline"
    },
    status: { 1: "machine", 10: "machine" }
  };
  const legacyProposal = {
    documentRevision: 3,
    edits: { 10: "accepted proposal" },
    status: { 10: "manual" },
    revisions: { 10: 1 },
    revisionHistory: {
      10: [{ revision: 1, text: "accepted proposal", status: "manual", source: "proposal-apply" }]
    }
  };

  const merged = mergeLegacyProposalLineReviewState(
    current,
    legacyProposal
  );
  assert.deepEqual(merged.edits, {
    1: "keep this imported line",
    10: "accepted proposal"
  });
  assert.deepEqual(merged.status, { 1: "machine", 10: "manual" });
  assert.equal(merged.revisions[10], 1);
  assert.equal(merged.revisionHistory[10][0].source, "proposal-apply");
  assert.equal(merged.documentRevision, 148);
});

await test("the latest duplicate proposal state replaces an older canonical manual edit", () => {
  const merged = mergeLegacyProposalLineReviewState(
    {
      documentRevision: 5,
      edits: { 10: "older standalone edit" },
      status: { 10: "manual" },
      revisions: { 10: 2 }
    },
    {
      documentRevision: 3,
      edits: { 10: "latest accepted proposal" },
      status: { 10: "manual" },
      revisions: { 10: 1 }
    }
  );
  assert.equal(merged.edits[10], "latest accepted proposal");
  assert.equal(merged.status[10], "manual");
  assert.equal(merged.revisions[10], 1);
  assert.equal(merged.documentRevision, 6);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
