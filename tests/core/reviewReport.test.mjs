import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

import {
  parseProofreadFindingsJson,
  parseProofreadReport,
  reviewProposalsToPatch,
  validateTranslationPatch
} from "../../src/shared/core/reviewReport.ts";
import { rankProofreadReportCandidates } from "../../src/shared/core/reportDiscovery.ts";

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

const findingsJson = JSON.stringify({
  schemaVersion: "1.0",
  documentId: "chapter03",
  findings: [
    {
      id: "H3-001",
      severity: "H3",
      type: "terminology",
      sourceLine: 12,
      translationLine: 12,
      sourceText: "Guild name",
      currentTranslation: "Old term",
      oldText: "Old term",
      baseRevision: 7,
      suggestedFix: "New term",
      rationale: "Terminology mismatch"
    },
    {
      id: "H3-001",
      severity: "H3",
      type: "terminology",
      sourceLine: 13,
      translationLine: 13,
      sourceText: "Second",
      currentTranslation: "Old second",
      suggestedFix: "New second",
      rationale: "Duplicate id must be renumbered"
    }
  ]
});

await test("parseProofreadFindingsJson maps findings to review proposals", () => {
  const proposals = parseProofreadFindingsJson(findingsJson);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].id, "H3-001");
  assert.equal(proposals[0].line, 12);
  assert.equal(proposals[0].src, "Guild name");
  assert.equal(proposals[0].current, "Old term");
  assert.equal(proposals[0].oldText, "Old term");
  assert.equal(proposals[0].baseRevision, 7);
  assert.equal(proposals[0].problemType, "H3 terminology");
  assert.equal(proposals[0].suggestion, "New term");
  assert.equal(proposals[0].status, "accepted");
  assert.equal(proposals[1].id, "H3-002");
  assert.equal(proposals[1].status, "accepted");
});

await test("mechanical scan findings remain verification-only review proposals", () => {
  const proposals = parseProofreadFindingsJson(JSON.stringify({
    schemaVersion: "1.0",
    documentId: "chapter03",
    findings: [{
      id: "M0-012",
      severity: "M",
      type: "mechanical_scan",
      sourceLine: 12,
      translationLine: 12,
      sourceText: "Guild name",
      currentTranslation: "Old term",
      suggestedFix: "Old term",
      rationale: "Possible sentence-boundary mismatch.",
      needsVerification: true
    }]
  }));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "mechanical_scan");
  assert.equal(proposals[0].needsVerification, true);
  assert.equal(proposals[0].status, "unreviewed");
});

await test("legacy or malformed M0 ownership markers remain non-patchable", () => {
  for (const finding of [
    { id: "M0-901", severity: "M1", type: "accuracy" },
    { id: "M1-901", severity: "m0", type: "accuracy" },
    { id: "M1-901", severity: "M1", type: "Mechanical_Scan" }
  ]) {
    const proposals = parseProofreadFindingsJson(JSON.stringify({
      schemaVersion: "1.0",
      documentId: "chapter03",
      findings: [{
        ...finding,
        sourceLine: 12,
        translationLine: 12,
        sourceText: "Guild name",
        currentTranslation: "Old term",
        suggestedFix: "New term",
        rationale: "Malformed host-owned record."
      }]
    }));
    assert.equal(proposals[0].kind, "mechanical_scan", JSON.stringify(finding));
    assert.equal(proposals[0].needsVerification, true, JSON.stringify(finding));
    assert.deepEqual(reviewProposalsToPatch(proposals, "chapter03").changes, []);
  }
});

await test("legacy Markdown M0 findings remain verification-only and non-patchable", () => {
  const proposals = parseProofreadReport(`
# M0-001

- 行号: 12
- 原文: Guild name
- 当前译文: Old term
- 问题类型: sentence boundary mismatch
- 问题说明: Possible omitted sentence.
- 建议译文: New term
`, "chapter03.proofread.md");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, "M0-001");
  assert.equal(proposals[0].kind, "mechanical_scan");
  assert.equal(proposals[0].needsVerification, true);
  assert.deepEqual(reviewProposalsToPatch(proposals, "chapter03").changes, []);
});

await test("parseProofreadReport prefers JSON findings for json reports", () => {
  const proposals = parseProofreadReport(findingsJson, "chapter03.proofread.json");
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].id, "H3-001");
});

await test("parseProofreadReport accepts workflow template findings json reports", () => {
  for (const path of [
    "report/chapter03.terminology.json",
    "report/chapter03.character-voice.json",
    "report/chapter03.final-qa.json"
  ]) {
    const proposals = parseProofreadReport(findingsJson, path);
    assert.equal(proposals.length, 2, path);
    assert.equal(proposals[0].suggestion, "New term", path);
  }
});

await test("parseProofreadReport accepts template json aliases and fenced payloads", () => {
  const proposals = parseProofreadReport("```json\n" + JSON.stringify({
    findings: [{
      issueId: "m2-001",
      priority: "m2",
      category: "voice",
      line: 8,
      source: "Source line",
      current: "flat voice",
      replacement: "in-character voice",
      reason: "Character voice drift",
      revision: "3"
    }]
  }) + "\n```", "report/chapter03.character-voice.json");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, "M2-001");
  assert.equal(proposals[0].line, 8);
  assert.equal(proposals[0].current, "flat voice");
  assert.equal(proposals[0].oldText, "flat voice");
  assert.equal(proposals[0].baseRevision, 3);
  assert.equal(proposals[0].problemType, "M2 voice");
  assert.equal(proposals[0].suggestion, "in-character voice");
  assert.equal(proposals[0].status, "accepted");
});

await test("rankProofreadReportCandidates discovers findings json reports", () => {
  const ranked = rankProofreadReportCandidates([
    { path: "report/chapter03_proofread_summary.md", size: 80, modifiedMs: 1, content: "# Proofread Summary\nclean" },
    { path: "report/chapter03.proofread.json", size: findingsJson.length, modifiedMs: 1, content: findingsJson }
  ]);
  assert.equal(ranked[0].path, "report/chapter03.proofread.json");
  assert.ok(ranked[0].score >= 190);
});

await test("folder aggregate findings outrank stale single-file reports", () => {
  const aggregate = JSON.stringify({
    schemaVersion: "2.0",
    scope: { kind: "folder", sourcePath: "D:\\project\\source" },
    findings: []
  });
  const ranked = rankProofreadReportCandidates([
    {
      path: "report/newer_fix_proposal.proofread.json",
      size: findingsJson.length * 100,
      modifiedMs: 9_999_999_999_999,
      content: findingsJson
    },
    { path: "report/folder.proofread.json", size: aggregate.length, modifiedMs: 1, content: aggregate }
  ]);
  assert.equal(ranked[0].path, "report/folder.proofread.json");
  assert.ok(ranked[0].score >= 190);
  assert.ok(ranked[0].reasons.includes("folder-aggregate-schema"));
});

await test("review proposals convert to translation patch schema shape", () => {
  const proposals = parseProofreadFindingsJson(findingsJson);
  const patch = reviewProposalsToPatch(proposals, "chapter03", {
    createdAt: "2026-06-27T00:00:00.000Z"
  });
  assert.equal(patch.schemaVersion, "1.0");
  assert.equal(patch.documentId, "chapter03");
  assert.equal(patch.changes.length, 2);
  assert.deepEqual(patch.changes[0], {
    lineId: 12,
    oldText: "Old term",
    newText: "New term",
    baseRevision: 7,
    reason: "Terminology mismatch",
    sourceFindingId: "H3-001"
  });
  assert.deepEqual(validateTranslationPatch(patch), []);
});

await test("folder aggregate findings preserve per-document routing metadata", () => {
  const proposals = parseProofreadFindingsJson(JSON.stringify({
    schemaVersion: "2.0",
    scope: { kind: "folder", sourcePath: "D:\\project\\source" },
    generatedAt: "2026-08-10T00:00:00.000Z",
    findings: [
      {
        documentId: "chapter-a.txt",
        sourcePath: "D:\\project\\source\\chapter-a.txt",
        translationPath: "D:\\project\\AI_translation\\chapter-a_translated.txt",
        id: "H1-001",
        severity: "H1",
        type: "accuracy",
        sourceLine: 4,
        translationLine: 4,
        sourceText: "source a",
        currentTranslation: "译文甲",
        suggestedFix: "修订甲",
        rationale: "issue a"
      },
      {
        documentId: "nested/chapter-b.txt",
        sourcePath: "D:\\project\\source\\nested\\chapter-b.txt",
        translationPath: "D:\\project\\AI_translation\\nested\\chapter-b_translated.txt",
        id: "H1-002",
        severity: "H1",
        type: "accuracy",
        sourceLine: 4,
        translationLine: 4,
        sourceText: "source b",
        currentTranslation: "译文乙",
        suggestedFix: "修订乙",
        rationale: "issue b"
      }
    ]
  }));
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map((proposal) => ({
    documentId: proposal.documentId,
    sourcePath: proposal.sourcePath,
    translationPath: proposal.translationPath,
    line: proposal.line
  })), [
    {
      documentId: "chapter-a.txt",
      sourcePath: "D:\\project\\source\\chapter-a.txt",
      translationPath: "D:\\project\\AI_translation\\chapter-a_translated.txt",
      line: 4
    },
    {
      documentId: "nested/chapter-b.txt",
      sourcePath: "D:\\project\\source\\nested\\chapter-b.txt",
      translationPath: "D:\\project\\AI_translation\\nested\\chapter-b_translated.txt",
      line: 4
    }
  ]);
});

await test("schema 1.0 report metadata is inherited by every proposal", () => {
  const proposals = parseProofreadFindingsJson(JSON.stringify({
    schemaVersion: "1.0",
    documentId: "chapter03",
    sourcePath: "D:\\project\\chapter03.txt",
    translationPath: "D:\\project\\AI_translation\\chapter03_translated.txt",
    generatedAt: "2026-08-10T00:00:00.000Z",
    findings: [JSON.parse(findingsJson).findings[0]]
  }));
  assert.equal(proposals[0].documentId, "chapter03");
  assert.equal(proposals[0].sourcePath, "D:\\project\\chapter03.txt");
  assert.equal(proposals[0].translationPath, "D:\\project\\AI_translation\\chapter03_translated.txt");
});

await test("validateTranslationPatch rejects malformed patch payloads", () => {
  const errors = validateTranslationPatch({
    schemaVersion: "1.0",
    documentId: "chapter03",
    changes: [
      { lineId: 0, newText: "x", reason: "" },
      { lineId: 2, newText: 12, reason: "bad" },
      { lineId: 3, newText: "x", reason: "bad", baseRevision: -1 }
    ]
  });
  assert.deepEqual(errors, [
    "changes[0].lineId must be a positive integer",
    "changes[0].reason is required",
    "changes[1].newText must be a string",
    "changes[2].baseRevision must be a non-negative integer"
  ]);
});

await test("patch schema stays aligned with generated patch field names", async () => {
  const schema = JSON.parse(await readFile("translation-protocol/patch.schema.json", "utf8"));
  assert.deepEqual(schema.required, ["schemaVersion", "documentId", "changes"]);
  assert.deepEqual(schema.$defs.Change.required, ["lineId", "newText", "reason"]);
  assert.ok(schema.$defs.Change.properties.oldText);
  assert.ok(schema.$defs.Change.properties.baseRevision);
  assert.ok(schema.$defs.Change.properties.sourceFindingId);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
