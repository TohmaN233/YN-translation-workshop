import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resetProofreadFindings,
  resolveProofreadReportPath,
  restoreProofreadFindings,
  snapshotProofreadFindings,
  writeProofreadFindings
} from "../../src/main/agent/writeProofreadFindings.ts";

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

async function fixture() {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-proofread-findings-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "AI_translation", "source_translated.txt");
  await mkdir(path.dirname(translationPath), { recursive: true });
  await writeFile(sourcePath, "source one\nsource two\nsource three\n", "utf8");
  await writeFile(translationPath, "译文一\n译文二\n译文三\n", "utf8");

  const baseArgs = {
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt",
    kind: "findings_json",
    mode: "split"
  };
  const reportPath = resolveProofreadReportPath(baseArgs);

  return {
    outputDir,
    sourcePath,
    translationPath,
    reportPath,
    baseArgs,
    finding(overrides = {}) {
      return {
        id: "M1-001",
        severity: "M1",
        type: "accuracy",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "source two",
        currentTranslation: "译文二",
        suggestedFix: "修订译文二",
        rationale: "Meaning drift",
        ...overrides
      };
    },
    async write(finding) {
      return writeProofreadFindings({
        ...baseArgs,
        content: JSON.stringify([finding])
      });
    },
    async close() {
      await rm(outputDir, { recursive: true, force: true });
    }
  };
}

await test("Host overwrites provided sourceText with the bound source line", async () => {
  const fx = await fixture();
  try {
    const result = await fx.write(fx.finding({ sourceText: "source TWO" }));
    assert.equal(result.ok, true);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings[0].sourceText, "source two");
  } finally {
    await fx.close();
  }
});

await test("Host overwrites provided currentTranslation with the bound translation line", async () => {
  const fx = await fixture();
  try {
    const result = await fx.write(fx.finding({ currentTranslation: "错误译文" }));
    assert.equal(result.ok, true);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings[0].currentTranslation, "译文二");
  } finally {
    await fx.close();
  }
});

await test("Host fills omitted sourceText and currentTranslation from the bound line", async () => {
  const fx = await fixture();
  try {
    const { sourceText, currentTranslation, ...lineOnly } = fx.finding();
    const result = await fx.write(lineOnly);
    assert.equal(result.ok, true, result.error);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings[0].sourceText, "source two");
    assert.equal(report.findings[0].currentTranslation, "译文二");
  } finally {
    await fx.close();
  }
});

await test("refuses to replace existing findings with an empty list", async () => {
  const fx = await fixture();
  try {
    const seeded = await fx.write(fx.finding());
    assert.equal(seeded.ok, true, seeded.error);
    const wiped = await writeProofreadFindings({
      ...fx.baseArgs,
      replaceDocument: true,
      content: "[]"
    });
    assert.equal(wiped.ok, false);
    assert.match(wiped.error ?? "", /Refusing to replace 1 existing proofread finding/i);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings.length, 1);
  } finally {
    await fx.close();
  }
});

await test("suggested fixes preserve the exact leading control prefix", async () => {
  const fx = await fixture();
  try {
    await writeFile(
      fx.sourcePath,
      "[ev10001:0003]source one\nsource two\nsource three\n",
      "utf8"
    );
    await writeFile(
      fx.translationPath,
      "[ev10001:0003]译文一\n译文二\n译文三\n",
      "utf8"
    );
    const finding = fx.finding({
      sourceLine: 1,
      translationLine: 1,
      sourceText: "[ev10001:0003]source one",
      currentTranslation: "[ev10001:0003]译文一"
    });

    for (const suggestedFix of ["[ev10001:0002]修订译文一", "修订译文一"]) {
      const rejected = await fx.write({ ...finding, suggestedFix });
      assert.equal(rejected.ok, false);
      assert.match(rejected.error ?? "", /control prefix.*ev10001:0003/i);
      await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
    }

    const accepted = await fx.write({ ...finding, suggestedFix: "[ev10001:0003]修订译文一" });
    assert.equal(accepted.ok, true, accepted.error);
  } finally {
    await fx.close();
  }
});

await test("rejects findings whose suggested fix is identical to the current translation", async () => {
  const fx = await fixture();
  try {
    const result = await fx.write(fx.finding({ suggestedFix: "译文二" }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /M1-001.*suggestedFix.*(?:change|identical|no-op)/i);
    await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
  } finally {
    await fx.close();
  }
});

await test("deduplicates repeated semantic findings by aligned line and issue code", async () => {
  const fx = await fixture();
  try {
    const first = await fx.write(fx.finding());
    assert.equal(first.ok, true, first.error);
    assert.equal(first.newFindingCount, 1);

    const duplicate = await fx.write(fx.finding({ id: "M1-099" }));
    assert.equal(duplicate.ok, true, duplicate.error);
    assert.equal(duplicate.appended, false);
    assert.equal(duplicate.newFindingCount, 0);
    assert.equal(duplicate.duplicateFindingCount, 1);
    assert.equal(duplicate.totalFindingCount, 1);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].id, "M1-001");
  } finally {
    await fx.close();
  }
});

await test("rejects conflicting findings for the same aligned line and issue code", async () => {
  const fx = await fixture();
  try {
    const first = await fx.write(fx.finding());
    assert.equal(first.ok, true, first.error);
    const before = await readFile(fx.reportPath, "utf8");
    const conflict = await fx.write(fx.finding({
      id: "M1-099",
      suggestedFix: "另一份互相冲突的修订"
    }));
    assert.equal(conflict.ok, false);
    assert.match(conflict.error ?? "", /same line and issue code 2:M1/i);
    assert.equal(await readFile(fx.reportPath, "utf8"), before);
  } finally {
    await fx.close();
  }
});

await test("rejects out-of-bounds and cross-line source/translation bindings", async () => {
  const fx = await fixture();
  try {
    const sourceResult = await fx.write(fx.finding({
      sourceLine: 4,
      sourceText: "out of bounds"
    }));
    assert.equal(sourceResult.ok, false);
    assert.match(sourceResult.error ?? "", /M1-001.*sourceLine 4.*3 source lines/i);

    const translationResult = await fx.write(fx.finding({
      translationLine: 4,
      currentTranslation: "out of bounds"
    }));
    assert.equal(translationResult.ok, false);
    assert.match(translationResult.error ?? "", /M1-001.*translationLine 4.*3 translation lines/i);

    const crossResult = await fx.write(fx.finding({
      sourceLine: 1,
      translationLine: 2
    }));
    assert.equal(crossResult.ok, false);
    assert.match(crossResult.error ?? "", /M1-001.*same aligned line/i);
    await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
  } finally {
    await fx.close();
  }
});

await test("rejects corrupt existing findings JSON without overwriting it", async () => {
  const fx = await fixture();
  const corrupt = "{ definitely-not-valid-json";
  try {
    await mkdir(path.dirname(fx.reportPath), { recursive: true });
    await writeFile(fx.reportPath, corrupt, "utf8");

    const result = await fx.write(fx.finding());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /existing proofread findings.*invalid JSON/i);
    assert.equal(await readFile(fx.reportPath, "utf8"), corrupt);
  } finally {
    await fx.close();
  }
});

await test("rejects an existing document with malformed finding records", async () => {
  const fx = await fixture();
  const malformed = `${JSON.stringify({
    schemaVersion: "1.0",
    documentId: "source",
    sourcePath: fx.sourcePath,
    translationPath: fx.translationPath,
    generatedAt: new Date(0).toISOString(),
    findings: [{}]
  }, null, 2)}\n`;
  try {
    await mkdir(path.dirname(fx.reportPath), { recursive: true });
    await writeFile(fx.reportPath, malformed, "utf8");

    const result = await fx.write(fx.finding());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /existing proofread findings.*finding 1.*invalid/i);
    assert.equal(await readFile(fx.reportPath, "utf8"), malformed);
  } finally {
    await fx.close();
  }
});

await test("revalidates every existing finding against the current bound files", async () => {
  const fx = await fixture();
  try {
    const initial = await fx.write(fx.finding());
    assert.equal(initial.ok, true, initial.error);
    const unchangedReport = await readFile(fx.reportPath, "utf8");
    await writeFile(fx.translationPath, "译文一\n已变化的译文二\n译文三\n", "utf8");

    const result = await fx.write(fx.finding({
      id: "M1-002",
      sourceLine: 1,
      translationLine: 1,
      sourceText: "source one",
      currentTranslation: "译文一"
    }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /M1-001.*currentTranslation.*line 2/i);
    assert.equal(await readFile(fx.reportPath, "utf8"), unchangedReport);
  } finally {
    await fx.close();
  }
});

await test("rejects appends whose source or translation path differs from existing report metadata", async () => {
  const fx = await fixture();
  try {
    const initial = await fx.write(fx.finding());
    assert.equal(initial.ok, true, initial.error);
    const unchangedReport = await readFile(fx.reportPath, "utf8");
    const alternateSource = path.join(fx.outputDir, "alternate", "source.txt");
    const alternateTranslation = path.join(fx.outputDir, "alternate", "source_translated.txt");
    await mkdir(path.dirname(alternateSource), { recursive: true });
    await writeFile(alternateSource, "source one\nsource two\nsource three\n", "utf8");
    await writeFile(alternateTranslation, "译文一\n译文二\n译文三\n", "utf8");

    const result = await writeProofreadFindings({
      ...fx.baseArgs,
      sourcePaths: [alternateSource],
      translationPath: alternateTranslation,
      content: JSON.stringify([fx.finding({ id: "M1-002" })])
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /existing proofread report.*bound.*(?:source|translation).*path/i);
    assert.equal(await readFile(fx.reportPath, "utf8"), unchangedReport);
  } finally {
    await fx.close();
  }
});

await test("preserves exact leading and trailing whitespace in bound line text", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.sourcePath, "source one\n  source two\t\nsource three\n", "utf8");
    await writeFile(fx.translationPath, "译文一\n  译文二  \n译文三\n", "utf8");

    const result = await fx.write(fx.finding({
      sourceText: "  source two\t",
      currentTranslation: "  译文二  "
    }));
    assert.equal(result.ok, true, result.error);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings[0].sourceText, "  source two\t");
    assert.equal(report.findings[0].currentTranslation, "  译文二  ");
  } finally {
    await fx.close();
  }
});

await test("accepts an omission finding when the bound translation line is empty", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.translationPath, "译文一\n\n译文三\n", "utf8");
    const result = await fx.write(fx.finding({
      currentTranslation: "",
      suggestedFix: "补回缺失译文",
      rationale: "The non-empty source line was omitted."
    }));
    assert.equal(result.ok, true, result.error);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings[0].currentTranslation, "");
  } finally {
    await fx.close();
  }
});

await test("accepts and revalidates an extraneous translation finding on an empty source line", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.sourcePath, "source one\n\nsource three\n", "utf8");
    await writeFile(fx.translationPath, "译文一\n多余译文\n译文三\n", "utf8");
    const first = await fx.write(fx.finding({
      sourceText: "",
      currentTranslation: "多余译文",
      suggestedFix: "删除多余译文",
      rationale: "The target contains text where the bound source line is empty."
    }));
    assert.equal(first.ok, true, first.error);

    const second = await fx.write(fx.finding({
      id: "M1-002",
      sourceLine: 3,
      translationLine: 3,
      sourceText: "source three",
      currentTranslation: "译文三"
    }));
    assert.equal(second.ok, true, second.error);

    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0].sourceText, "");
    assert.equal(report.findings[0].currentTranslation, "多余译文");
  } finally {
    await fx.close();
  }
});

await test("rejects findings when the bound translation file cannot be read", async () => {
  const fx = await fixture();
  try {
    await rm(fx.translationPath);
    const result = await fx.write(fx.finding());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unable to read bound translation file/i);
    await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
  } finally {
    await fx.close();
  }
});

await test("rejects findings when the bound source file cannot be read", async () => {
  const fx = await fixture();
  try {
    await rm(fx.sourcePath);
    const result = await fx.write(fx.finding());
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unable to read bound source file/i);
    await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
  } finally {
    await fx.close();
  }
});

await test("rejects the whole batch instead of silently dropping a malformed finding", async () => {
  const fx = await fixture();
  try {
    const malformed = fx.finding({ id: "M1-002" });
    delete malformed.suggestedFix;
    const result = await writeProofreadFindings({
      ...fx.baseArgs,
      content: JSON.stringify([fx.finding(), malformed])
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /incoming proofread finding 2 is invalid/i);
    await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
  } finally {
    await fx.close();
  }
});

await test("concurrent appends publish one complete lossless findings document", async () => {
  const fx = await fixture();
  try {
    const issueCodes = ["H1", "H2", "H3", "M1", "M2", "M3", "L1", "L2"];
    const results = await Promise.all(issueCodes.map((issueCode) => fx.write(fx.finding({
      id: `${issueCode}-001`,
      severity: issueCode
    }))));
    assert.ok(results.every((result) => result.ok), JSON.stringify(results));

    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.schemaVersion, "1.0");
    assert.equal(report.findings.length, 8);
    assert.deepEqual(
      report.findings.map((finding) => finding.id).sort(),
      issueCodes.map((issueCode) => `${issueCode}-001`).sort()
    );
  } finally {
    await fx.close();
  }
});

await test("writes and appends the normalized machine contract without temporary artifacts", async () => {
  const fx = await fixture();
  try {
    const first = await writeProofreadFindings({
      ...fx.baseArgs,
      chunkLabel: "Chunk 001",
      content: JSON.stringify([fx.finding({ id: "m1-001", needsVerification: true })])
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.created, true);

    const second = await fx.write(fx.finding({
      id: "M1-001",
      sourceLine: 3,
      translationLine: 3,
      sourceText: "source three",
      currentTranslation: "译文三"
    }));
    assert.equal(second.ok, true, second.error);
    assert.equal(second.created, false);

    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.schemaVersion, "1.0");
    assert.equal(report.documentId, "source");
    assert.equal(report.sourcePath, fx.sourcePath);
    assert.equal(report.translationPath, fx.translationPath);
    assert.equal(report.mode, "split");
    assert.deepEqual(report.findings.map((finding) => finding.id), ["M1-001", "M1-002"]);
    assert.equal(report.findings[0].agentId, "Chunk 001");
    assert.equal(report.findings[0].needsVerification, true);
    assert.deepEqual(await readdir(path.dirname(fx.reportPath)), [path.basename(fx.reportPath)]);
  } finally {
    await fx.close();
  }
});

await test("writes an empty findings document when proofreading finds no issues", async () => {
  const fx = await fixture();
  try {
    const result = await writeProofreadFindings({
      ...fx.baseArgs,
      documentId: "source.txt",
      content: "[]",
      mode: "split"
    });
    assert.equal(result.ok, true);
    const document = JSON.parse(await readFile(result.path, "utf8"));
    assert.deepEqual(document.findings, []);
  } finally {
    await fx.close();
  }
});

await test("folder proofreading stores every document in one aggregate JSON without cross-document collisions", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-folder-proofread-findings-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const sourceA = path.join(sourceRoot, "chapter-a.txt");
  const sourceB = path.join(sourceRoot, "nested", "chapter-b.txt");
  const translationA = path.join(translationRoot, "chapter-a_translated.txt");
  const translationB = path.join(translationRoot, "nested", "chapter-b_translated.txt");
  const reportScope = { kind: "folder", sourcePath: sourceRoot };
  try {
    await mkdir(path.dirname(sourceB), { recursive: true });
    await mkdir(path.dirname(translationB), { recursive: true });
    await writeFile(sourceA, "source a\n", "utf8");
    await writeFile(sourceB, "source b\n", "utf8");
    await writeFile(translationA, "译文甲\n", "utf8");
    await writeFile(translationB, "译文乙\n", "utf8");

    const reportA = resolveProofreadReportPath({
      outputDir,
      sourcePaths: [sourceA],
      documentId: "chapter-a.txt",
      kind: "findings_json",
      reportScope
    });
    const reportB = resolveProofreadReportPath({
      outputDir,
      sourcePaths: [sourceB],
      documentId: "nested/chapter-b.txt",
      kind: "findings_json",
      reportScope
    });
    assert.equal(reportA, reportB);
    assert.equal(path.basename(reportA), "folder.proofread.json");

    const commonFinding = {
      id: "H1-001",
      severity: "H1",
      type: "accuracy",
      sourceLine: 1,
      translationLine: 1,
      suggestedFix: "修订译文",
      rationale: "Accuracy issue"
    };
    const first = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourceB],
      translationPath: translationB,
      documentId: "nested/chapter-b.txt",
      kind: "findings_json",
      mode: "split",
      reportScope,
      content: JSON.stringify([{ ...commonFinding, sourceText: "source b", currentTranslation: "译文乙" }])
    });
    const second = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourceA],
      translationPath: translationA,
      documentId: "chapter-a.txt",
      kind: "findings_json",
      mode: "split",
      reportScope,
      content: JSON.stringify([{ ...commonFinding, sourceText: "source a", currentTranslation: "译文甲" }])
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);

    const report = JSON.parse(await readFile(reportA, "utf8"));
    assert.equal(report.schemaVersion, "2.0");
    assert.deepEqual(report.scope, { kind: "folder", sourcePath: sourceRoot });
    assert.equal(report.findings.length, 2);
    assert.deepEqual(
      report.findings.map((finding) => finding.documentId),
      ["chapter-a.txt", "nested/chapter-b.txt"]
    );
    assert.deepEqual(
      report.findings.map((finding) => finding.sourcePath).sort(),
      [sourceA, sourceB].sort()
    );
    assert.equal(new Set(report.findings.map((finding) => finding.id)).size, 2);
    assert.deepEqual(
      (await readdir(path.dirname(reportA))).filter((name) => name.endsWith(".proofread.json")),
      ["folder.proofread.json"]
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("resetting one folder document preserves findings for every other document", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-folder-proofread-reset-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const reportScope = { kind: "folder", sourcePath: sourceRoot };
  const documents = ["a.txt", "b.txt"];
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(translationRoot, { recursive: true });
    for (const [index, documentId] of documents.entries()) {
      const sourcePath = path.join(sourceRoot, documentId);
      const translationPath = path.join(translationRoot, documentId.replace(/\.txt$/i, "_translated.txt"));
      await writeFile(sourcePath, `source ${index + 1}\n`, "utf8");
      await writeFile(translationPath, `译文${index + 1}\n`, "utf8");
      const result = await writeProofreadFindings({
        outputDir,
        sourcePaths: [sourcePath],
        translationPath,
        documentId,
        kind: "findings_json",
        mode: "split",
        reportScope,
        content: JSON.stringify([{
          id: "M1-001",
          severity: "M1",
          type: "accuracy",
          sourceLine: 1,
          translationLine: 1,
          sourceText: `source ${index + 1}`,
          currentTranslation: `译文${index + 1}`,
          suggestedFix: `修订${index + 1}`,
          rationale: "test"
        }])
      });
      assert.equal(result.ok, true, result.error);
    }
    const legacySummaryPath = path.join(outputDir, "report", "folder_proofread_summary.md");
    await mkdir(path.dirname(legacySummaryPath), { recursive: true });
    await writeFile(legacySummaryPath, "retired companion", "utf8");

    const reportPath = await resetProofreadFindings({
      outputDir,
      sourcePaths: [path.join(sourceRoot, "a.txt")],
      documentId: "a.txt",
      reportScope
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.findings.map((finding) => finding.documentId), ["b.txt"]);
    await assert.rejects(readFile(legacySummaryPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("resetting the last folder document keeps the sole shared JSON aggregate", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-folder-proofread-last-reset-"));
  const sourceRoot = path.join(outputDir, "source");
  const sourcePath = path.join(sourceRoot, "only.txt");
  const translationPath = path.join(outputDir, "AI_translation", "only_translated.txt");
  const reportScope = { kind: "folder", sourcePath: sourceRoot };
  try {
    await mkdir(path.dirname(translationPath), { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, "only source\n", "utf8");
    await writeFile(translationPath, "唯一译文\n", "utf8");
    const finding = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourcePath],
      translationPath,
      documentId: "only.txt",
      kind: "findings_json",
      mode: "split",
      reportScope,
      content: JSON.stringify([{
        id: "M1-001",
        severity: "M1",
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText: "only source",
        currentTranslation: "唯一译文",
        suggestedFix: "修订译文",
        rationale: "test"
      }])
    });
    assert.equal(finding.ok, true, finding.error);
    const reportPath = await resetProofreadFindings({
      outputDir,
      sourcePaths: [sourcePath],
      documentId: "only.txt",
      reportScope
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.schemaVersion, "2.0");
    assert.deepEqual(report.findings, []);
    assert.equal(Object.hasOwn(report, "summaryPath"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("document replacement validates before atomically replacing only its folder slice", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-folder-proofread-atomic-replace-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const reportScope = { kind: "folder", sourcePath: sourceRoot };
  const writeDocument = async (documentId, sourceText, translationText, id, suggestedFix, replaceDocument = false) => {
    const sourcePath = path.join(sourceRoot, documentId);
    const translationPath = path.join(translationRoot, documentId.replace(/\.txt$/i, "_translated.txt"));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(sourcePath, `${sourceText}\n`, "utf8");
    await writeFile(translationPath, `${translationText}\n`, "utf8");
    const result = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourcePath],
      translationPath,
      documentId,
      kind: "findings_json",
      mode: "split",
      reportScope,
      replaceDocument,
      content: JSON.stringify([{
        id,
        severity: id.split("-")[0],
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText,
        currentTranslation: translationText,
        suggestedFix,
        rationale: "test"
      }])
    });
    return { result, sourcePath, translationPath };
  };
  try {
    const first = await writeDocument("a.txt", "source a", "译文甲", "M1-001", "旧修订甲");
    const sibling = await writeDocument("b.txt", "source b", "译文乙", "M1-001", "修订乙");
    assert.equal(first.result.ok, true, first.result.error);
    assert.equal(sibling.result.ok, true, sibling.result.error);
    const before = await readFile(first.result.path, "utf8");

    const invalid = await writeProofreadFindings({
      outputDir,
      sourcePaths: [first.sourcePath],
      translationPath: first.translationPath,
      documentId: "a.txt",
      kind: "findings_json",
      mode: "split",
      reportScope,
      replaceDocument: true,
      content: JSON.stringify([{
        id: "H1-002",
        severity: "H1",
        type: "accuracy",
        sourceLine: 9,
        translationLine: 9,
        sourceText: "source a",
        currentTranslation: "错误绑定",
        suggestedFix: "新修订甲",
        rationale: "invalid replacement"
      }])
    });
    assert.equal(invalid.ok, false);
    assert.equal(await readFile(first.result.path, "utf8"), before);

    const replacement = await writeDocument("a.txt", "source a", "译文甲", "H1-002", "新修订甲", true);
    assert.equal(replacement.result.ok, true, replacement.result.error);
    assert.equal(replacement.result.replacedFindingCount, 1);
    const report = JSON.parse(await readFile(first.result.path, "utf8"));
    assert.deepEqual(
      report.findings.map((finding) => `${finding.documentId}:${finding.id}`),
      ["a.txt:H1-002", "b.txt:M1-002"]
    );
    assert.equal(Object.hasOwn(report, "summaryPath"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("restoring one folder document snapshot does not erase a sibling written after the snapshot", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-folder-proofread-rollback-"));
  const sourceRoot = path.join(outputDir, "source");
  const translationRoot = path.join(outputDir, "AI_translation");
  const reportScope = { kind: "folder", sourcePath: sourceRoot };
  const writeDocument = async (documentId, index, suggestedFix) => {
    const sourcePath = path.join(sourceRoot, documentId);
    const translationPath = path.join(translationRoot, documentId.replace(/\.txt$/i, "_translated.txt"));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(translationPath), { recursive: true });
    await writeFile(sourcePath, `source ${index}\n`, "utf8");
    await writeFile(translationPath, `译文${index}\n`, "utf8");
    const result = await writeProofreadFindings({
      outputDir,
      sourcePaths: [sourcePath],
      translationPath,
      documentId,
      kind: "findings_json",
      mode: "split",
      reportScope,
      content: JSON.stringify([{
        id: "M1-001",
        severity: "M1",
        type: "accuracy",
        sourceLine: 1,
        translationLine: 1,
        sourceText: `source ${index}`,
        currentTranslation: `译文${index}`,
        suggestedFix,
        rationale: "test"
      }])
    });
    assert.equal(result.ok, true, result.error);
    return { sourcePath, reportPath: result.path };
  };
  try {
    const first = await writeDocument("a.txt", 1, "修订甲");
    const snapshot = await snapshotProofreadFindings({
      outputDir,
      sourcePaths: [first.sourcePath],
      documentId: "a.txt",
      reportScope
    });
    await resetProofreadFindings({
      outputDir,
      sourcePaths: [first.sourcePath],
      documentId: "a.txt",
      reportScope
    });
    await writeDocument("b.txt", 2, "修订乙");
    await restoreProofreadFindings(snapshot);

    const report = JSON.parse(await readFile(first.reportPath, "utf8"));
    assert.deepEqual(
      report.findings.map((finding) => finding.documentId).sort(),
      ["a.txt", "b.txt"]
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("host removes audit-whitelisted lines from the persisted findings artifact", async () => {
  const fx = await fixture();
  try {
    const result = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      excludedLines: [2],
      content: JSON.stringify([
        fx.finding({ id: "M1-001" }),
        fx.finding({
          id: "M1-002",
          sourceLine: 3,
          translationLine: 3,
          sourceText: "source three",
          currentTranslation: "译文三"
        })
      ])
    });
    assert.equal(result.ok, true, result.error);
    const document = JSON.parse(await readFile(result.path, "utf8"));
    assert.deepEqual(document.findings.map((finding) => finding.sourceLine), [3]);
  } finally {
    await fx.close();
  }
});

await test("host mechanical scan risks remain evidence and are not persisted as findings", async () => {
  const fx = await fixture();
  try {
    const result = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      content: "[]",
      mechanicalScan: {
        scopeLines: [1, 2, 3],
        signals: [
          { line: 2, code: "M0", evidence: "Possible sentence boundary moved to the next row." },
          { line: 2, code: "H9", evidence: "Suspiciously short translation for this source row." }
        ]
      }
    });
    assert.equal(result.ok, true, result.error);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.deepEqual(report.findings, []);
  } finally {
    await fx.close();
  }
});

await test("semantic findings suppress mechanical scan cards on the same aligned line", async () => {
  const fx = await fixture();
  try {
    const result = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      content: JSON.stringify([fx.finding()]),
      mechanicalScan: {
        scopeLines: [1, 2, 3],
        signals: [{ line: 2, code: "M0", evidence: "Possible alignment risk." }]
      }
    });
    assert.equal(result.ok, true, result.error);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.deepEqual(report.findings.map((finding) => finding.id), ["M1-001"]);
  } finally {
    await fx.close();
  }
});

await test("mechanical scan scope removes stale risks and honors the audit whitelist", async () => {
  const fx = await fixture();
  try {
    await mkdir(path.dirname(fx.reportPath), { recursive: true });
    await writeFile(fx.reportPath, `${JSON.stringify({
      schemaVersion: "1.0",
      documentId: "source",
      sourcePath: fx.sourcePath,
      translationPath: fx.translationPath,
      generatedAt: new Date().toISOString(),
      mode: "split",
      findings: [{
        id: "M0-002",
        severity: "M0",
        type: "mechanical_scan",
        sourceLine: 2,
        translationLine: 2,
        sourceText: "source two",
        currentTranslation: "译文二",
        suggestedFix: "译文二",
        rationale: "Legacy mechanical risk",
        agentId: "host-mechanical-scan",
        needsVerification: true
      }]
    }, null, 2)}\n`, "utf8");

    const cleared = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      content: "[]",
      excludedLines: [2],
      mechanicalScan: { scopeLines: [2], signals: [] }
    });
    assert.equal(cleared.ok, true, cleared.error);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.deepEqual(report.findings, []);
  } finally {
    await fx.close();
  }
});

await test("model-authored M0 variants cannot bypass Host ownership", async () => {
  const variants = [
    { id: "M0-777", severity: "M1", type: "accuracy" },
    { id: "M1-777", severity: "m0", type: "accuracy" },
    { id: "M1-777", severity: "M1", type: "Mechanical_Scan" }
  ];
  for (const variant of variants) {
    const fx = await fixture();
    try {
      const result = await writeProofreadFindings({
        ...fx.baseArgs,
        translationPath: fx.translationPath,
        content: JSON.stringify([fx.finding(variant)])
      });
      assert.equal(result.ok, false, JSON.stringify(variant));
      assert.match(result.error ?? "", /Host-owned mechanical scan/i);
      await assert.rejects(access(fx.reportPath), { code: "ENOENT" });
    } finally {
      await fx.close();
    }
  }
});

await test("a bounded replacement removes stale findings in range and preserves findings outside it", async () => {
  const fx = await fixture();
  try {
    const seeded = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      content: JSON.stringify([
        fx.finding({
          id: "M1-001",
          sourceLine: 1,
          translationLine: 1,
          sourceText: "source one",
          currentTranslation: "译文一"
        }),
        fx.finding({ id: "H1-504", severity: "H1" })
      ])
    });
    assert.equal(seeded.ok, true, seeded.error);

    await writeFile(fx.translationPath, "译文一\n修订后的译文二\n译文三\n", "utf8");
    const replaced = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      replaceRange: { fromLine: 2, toLine: 2 },
      content: "[]"
    });

    assert.equal(replaced.ok, true, replaced.error);
    assert.equal(replaced.replacedFindingCount, 1);
    assert.equal(replaced.totalFindingCount, 1);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.deepEqual(report.findings.map((finding) => finding.id), ["M1-001"]);
  } finally {
    await fx.close();
  }
});

await test("a bounded replacement atomically replaces a stale finding with the new scoped conclusion", async () => {
  const fx = await fixture();
  try {
    const seeded = await fx.write(fx.finding({ id: "H1-504", severity: "H1" }));
    assert.equal(seeded.ok, true, seeded.error);
    await writeFile(fx.translationPath, "译文一\n修订后的译文二\n译文三\n", "utf8");

    const replacement = fx.finding({
      id: "H1-690",
      severity: "H1",
      currentTranslation: "修订后的译文二",
      suggestedFix: "再次修订译文二",
      rationale: "The bounded re-proofread found a remaining issue."
    });
    const replaced = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      replaceRange: { fromLine: 2, toLine: 2 },
      content: JSON.stringify([replacement])
    });

    assert.equal(replaced.ok, true, replaced.error);
    assert.equal(replaced.replacedFindingCount, 1);
    const report = JSON.parse(await readFile(fx.reportPath, "utf8"));
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].id, "H1-690");
    assert.equal(report.findings[0].currentTranslation, "修订后的译文二");
  } finally {
    await fx.close();
  }
});

await test("a bounded replacement rejects out-of-range findings without changing the report", async () => {
  const fx = await fixture();
  try {
    const seeded = await fx.write(fx.finding());
    assert.equal(seeded.ok, true, seeded.error);
    const before = await readFile(fx.reportPath, "utf8");

    const rejected = await writeProofreadFindings({
      ...fx.baseArgs,
      translationPath: fx.translationPath,
      replaceRange: { fromLine: 2, toLine: 2 },
      content: JSON.stringify([fx.finding({
        id: "M1-003",
        sourceLine: 3,
        translationLine: 3,
        sourceText: "source three",
        currentTranslation: "译文三"
      })])
    });

    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /outside.*replacement range|replacement range.*line 3/i);
    assert.equal(await readFile(fx.reportPath, "utf8"), before);
  } finally {
    await fx.close();
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
