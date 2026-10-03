import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { applyAutomationProofread } from "../src/main/automationProofread.ts";
import { checkProposalSafety, proposalSafetyBrowserScript } from "../src/shared/core/proposalSafety.ts";

async function fixture(fn) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-automation-proofread-"));
  const workspace = path.join(outputDir, ".translation-workshop");
  await mkdir(path.join(workspace, "state"), { recursive: true });
  const sourcePath = path.join(outputDir, "source.txt");
  const translationPath = path.join(outputDir, "translation.txt");
  const reportPath = path.join(outputDir, "report.json");
  const statePath = path.join(workspace, "state", "line-review.html.json");
  const lineReviewPath = path.join(workspace, "review.html");
  const source = "こんにちは。\r\n世界です。\r\n";
  const translation = "您好。\r\n世界。\r\n";
  await writeFile(sourcePath, source);
  await writeFile(translationPath, translation);
  await writeFile(lineReviewPath, "fixture routed by Host");
  const report = { schemaVersion: "1.0", documentId: "source.txt", sourcePath, translationPath, generatedAt: new Date().toISOString(), findings: [{ id: "H-001", severity: "H", type: "accuracy", sourceLine: 2, translationLine: 2, sourceText: "世界です。", currentTranslation: "世界。", suggestedFix: "这是世界。", rationale: "Restore the sentence meaning." }] };
  const writeReport = async () => { const text = JSON.stringify(report); await writeFile(reportPath, text); return createHash("sha256").update(text).digest("hex"); };
  let expectedReportHash = await writeReport();
  const host = { prepareDocuments: async () => [{ documentId: "source.txt", sourcePath, translationPath, lineReviewPath, statePath, validationOptions: { languagePair: "ja->zh-CN" } }], withStateLocks: async (_paths, work) => work() };
  const apply = () => applyAutomationProofread({ outputDir, reportPath, expectedReportHash }, host);
  try { await fn({ outputDir, sourcePath, translationPath, reportPath, statePath, source, translation, report, host, apply, updateReport: async () => { expectedReportHash = await writeReport(); } }); }
  finally { await rm(outputDir, { recursive: true, force: true }); }
}

test("finalized findings update HTML suggestion state while source, TXT and report remain unchanged", () => fixture(async (f) => {
  const reportBefore = await readFile(f.reportPath);
  const result = await f.apply();
  assert.deepEqual(result.changedPaths, [f.statePath]);
  assert.deepEqual(result.counts, { findings: 1, changedLines: 1, changedFiles: 1, alreadyApplied: 0 });
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
  assert.deepEqual(result.backupPaths, []);
  await assert.rejects(readFile(path.join(f.outputDir, ".translation-workshop", "backups")), { code: "ENOENT" });
  assert.equal(await readFile(f.sourcePath, "utf8"), f.source);
  assert.deepEqual(await readFile(f.reportPath), reportBefore);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.edits[2], "这是世界。");
  assert.equal(state.revisions[2], 1);
  assert.equal(state.revisionHistory[2][0].source, "proposal-apply");
  assert.equal(state.savedTxtFile, undefined);
  assert.equal(state.savedTxtAt, undefined);
  const again = await f.apply();
  assert.equal(again.counts.alreadyApplied, 1);
  assert.equal(again.counts.changedFiles, 0);
}));

test("stale finalized hash, source text and current translation all reject without writing", () => fixture(async (f) => {
  await writeFile(f.reportPath, `${await readFile(f.reportPath, "utf8")} `);
  await assert.rejects(f.apply(), /changed after finalization/);
  await f.updateReport();
  await writeFile(f.translationPath, "您好。\r\n人类世界。\r\n");
  await assert.rejects(f.apply(), /stale translation|patch-conflict/);
  await writeFile(f.translationPath, f.translation);
  await writeFile(f.sourcePath, "こんにちは。\r\n人類の世界です。\r\n");
  await assert.rejects(f.apply(), /stale source|source-mismatch/);
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
}));

test("pending manual sidecar edits and desktop revision history cannot be overwritten", () => fixture(async (f) => {
  await writeFile(f.statePath, JSON.stringify({ edits: { 2: "人工修改。" } }));
  await assert.rejects(f.apply(), /pending manual/);
  await writeFile(f.statePath, JSON.stringify({ edits: { 2: "世界。" }, revisions: { 2: 1 }, revisionHistory: { 2: [{ revision: 1, source: "desktop-edit", text: "世界。" }] } }));
  await assert.rejects(f.apply(), /manual-edit/);
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
}));

test("idempotent reapply requires proposal provenance and rejects a later identical manual edit", () => fixture(async (f) => {
  f.report.findings[0].baseRevision = 0;
  await f.updateReport();
  await f.apply();
  const firstState = await readFile(f.statePath, "utf8");
  const repeated = await f.apply();
  assert.equal(repeated.counts.alreadyApplied, 1);
  assert.equal(await readFile(f.statePath, "utf8"), firstState);
  const state = JSON.parse(firstState);
  state.revisions[2] = 2;
  state.revisionHistory[2].push({ revision: 2, text: state.edits[2], status: "manual", source: "desktop-edit" });
  await writeFile(f.statePath, JSON.stringify(state));
  await assert.rejects(f.apply(), /manual-edit/);
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
}));

test("an applied HTML suggestion cannot hide a later external TXT change", () => fixture(async (f) => {
  await f.apply();
  const state = await readFile(f.statePath, "utf8");
  await writeFile(f.translationPath, "您好。\r\n另一个人工句子。\r\n");
  await assert.rejects(f.apply(), /stale translation/);
  assert.equal(await readFile(f.statePath, "utf8"), state);
}));

test("outside-project translation references remain read-only", () => fixture(async (f) => {
  const referenceDir = await mkdtemp(path.join(os.tmpdir(), "yn-proofread-reference-"));
  try {
    const referencePath = path.join(referenceDir, "translation.txt");
    await writeFile(referencePath, f.translation);
    f.report.translationPath = referencePath;
    const prepare = f.host.prepareDocuments;
    f.host.prepareDocuments = async () => (await prepare()).map((document) => ({ ...document, translationPath: referencePath }));
    await f.updateReport();
    const result = await f.apply();
    assert.deepEqual(result.changedPaths, [f.statePath]);
    assert.equal(await readFile(referencePath, "utf8"), f.translation);
    assert.equal(await readFile(f.sourcePath, "utf8"), f.source);
    assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).edits[2], "这是世界。");
  } finally { await rm(referenceDir, { recursive: true, force: true }); }
}));

test("unrelated manual HTML edits and saved TXT metadata survive proposal application", () => fixture(async (f) => {
  await writeFile(f.statePath, JSON.stringify({ edits: { 1: "你好。" }, status: { 1: "manual" }, savedTxtFile: "prior.txt", savedTxtAt: "prior-time", revisions: { 1: 5 }, revisionHistory: { 1: [{ revision: 5, text: "你好。", source: "desktop-edit" }] } }));
  await f.apply();
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.edits[1], "你好。");
  assert.equal(state.revisions[1], 5);
  assert.equal(state.savedTxtFile, "prior.txt");
  assert.equal(state.savedTxtAt, "prior-time");
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
}));

test("source translation binding and structurally unsafe fixes reject before sidecar commit", () => fixture(async (f) => {
  const originalPrepare = f.host.prepareDocuments;
  f.host.prepareDocuments = async () => (await originalPrepare()).map((document) => ({ ...document, translationPath: document.sourcePath }));
  await assert.rejects(f.apply(), /reference a source/);
  f.host.prepareDocuments = originalPrepare;
  f.report.findings[0].sourceText = "世界です。 {name}";
  f.report.findings[0].currentTranslation = "世界。 {name}";
  await writeFile(f.sourcePath, "こんにちは。\r\n世界です。 {name}\r\n");
  await writeFile(f.translationPath, "您好。\r\n世界。 {name}\r\n");
  await f.updateReport();
  await assert.rejects(f.apply(), /translation validation.*placeholder/);
  assert.equal(await readFile(f.translationPath, "utf8"), "您好。\r\n世界。 {name}\r\n");
}));

test("overlapping conflicting findings fail as one transaction", () => fixture(async (f) => {
  f.report.findings.push({ ...f.report.findings[0], id: "H-002", suggestedFix: "整个世界。" });
  await f.updateReport();
  await assert.rejects(f.apply(), /Conflicting finalized findings/);
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
}));

test("a conflict in a later document cannot partially apply an earlier valid finding", () => fixture(async (f) => {
  const sourcePath = path.join(f.outputDir, "other-source.txt");
  const translationPath = path.join(f.outputDir, "other-translation.txt");
  await writeFile(sourcePath, "別の文です。");
  await writeFile(translationPath, "手改后的句子。");
  const original = { documentId: f.report.documentId, sourcePath: f.report.sourcePath, translationPath: f.report.translationPath };
  f.report.schemaVersion = "2.0";
  f.report.scope = { kind: "folder", sourcePath: f.outputDir };
  f.report.findings[0] = { ...f.report.findings[0], ...original };
  f.report.findings.push({ ...f.report.findings[0], id: "H-002", documentId: "other-source.txt", sourcePath, translationPath, sourceLine: 1, translationLine: 1, sourceText: "別の文です。", currentTranslation: "旧句子。", suggestedFix: "另一句话。" });
  const prepare = f.host.prepareDocuments;
  f.host.prepareDocuments = async () => [...await prepare(), { documentId: "other-source.txt", sourcePath, translationPath, lineReviewPath: path.join(f.outputDir, ".translation-workshop", "other.html"), statePath: path.join(f.outputDir, ".translation-workshop", "state", "other.json") }];
  await f.updateReport();
  await assert.rejects(f.apply(), /stale translation|patch-conflict/);
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
  assert.equal(await readFile(translationPath, "utf8"), "手改后的句子。");
  await assert.rejects(readFile(f.statePath), { code: "ENOENT" });
}));

test("folder findings commit all HTML sidecars while retaining both original TXT files", () => fixture(async (f) => {
  const sourcePath = path.join(f.outputDir, "other-source.txt");
  const translationPath = path.join(f.outputDir, "other-translation.txt");
  const statePath = path.join(f.outputDir, ".translation-workshop", "state", "other.json");
  const otherSource = "別の文です。\r\n";
  const otherTranslation = "旧句子。\r\n";
  await writeFile(sourcePath, otherSource);
  await writeFile(translationPath, otherTranslation);
  const original = { documentId: f.report.documentId, sourcePath: f.report.sourcePath, translationPath: f.report.translationPath };
  f.report.schemaVersion = "2.0";
  f.report.scope = { kind: "folder", sourcePath: f.outputDir };
  f.report.findings[0] = { ...f.report.findings[0], ...original };
  f.report.findings.push({ ...f.report.findings[0], id: "H-002", documentId: "other-source.txt", sourcePath, translationPath, sourceLine: 1, translationLine: 1, sourceText: "別の文です。", currentTranslation: "旧句子。", suggestedFix: "另一句话。" });
  const prepare = f.host.prepareDocuments;
  f.host.prepareDocuments = async () => [...await prepare(), { documentId: "other-source.txt", sourcePath, translationPath, lineReviewPath: path.join(f.outputDir, ".translation-workshop", "other.html"), statePath }];
  await f.updateReport();
  const result = await f.apply();
  assert.deepEqual(result.changedPaths, [f.statePath, statePath]);
  assert.equal(result.counts.changedLines, 2);
  assert.equal(result.counts.changedFiles, 2);
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).edits[2], "这是世界。");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).edits[1], "另一句话。");
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
  assert.equal(await readFile(translationPath, "utf8"), otherTranslation);
  assert.equal(await readFile(sourcePath, "utf8"), otherSource);
}));

test("mutation binding retains exact Host source and translation evidence including leading spaces", () => fixture(async (f) => {
  await writeFile(f.sourcePath, "こんにちは。\r\n  世界です。\r\n");
  await writeFile(f.translationPath, "您好。\r\n  世界。\r\n");
  f.report.findings[0].sourceText = "  世界です。";
  f.report.findings[0].currentTranslation = "  世界。";
  await f.updateReport();
  const result = await f.apply();
  assert.equal(result.counts.changedLines, 1);
  assert.equal(await readFile(f.translationPath, "utf8"), "您好。\r\n  世界。\r\n");
}));

test("engine control prefixes use the existing finalized findings safety gate", () => fixture(async (f) => {
  f.report.findings[0].sourceText = "[speaker]世界です。";
  f.report.findings[0].currentTranslation = "[speaker]世界。";
  await f.updateReport();
  await assert.rejects(f.apply(), /unsafe control prefix/);
  assert.equal(await readFile(f.translationPath, "utf8"), f.translation);
}));

test("shared browser safety script matches Host safety for conflicts", () => {
  const args = { sourceText: "source", rowSource: "source", rowExists: true, currentText: "current", oldText: "current", intendedText: "new", revision: 3, baseRevision: 2 };
  const browser = vm.runInNewContext(`${proposalSafetyBrowserScript()} checkProposalSafety(${JSON.stringify(args)});`);
  assert.deepEqual(JSON.parse(JSON.stringify(browser)), checkProposalSafety(args));
  assert.equal(browser.reason, "base-revision-conflict");
});
