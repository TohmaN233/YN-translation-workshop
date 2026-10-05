import { createHash } from "node:crypto";
import { decodeProjectPaths } from "../src/main/projectPaths.ts";
import { readReviewHtml } from "../src/main/reviewHtmlPortability.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, cp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { builtinTaskDefaults } from "../src/shared/builtinTasks.ts";
import { generateBuiltinTaskReview, prepareBuiltinTaskDocuments } from "../src/main/builtinTaskDocuments.ts";
import { resolvePiSourceManifest } from "../src/main/agent/piNative/sourceManifest.ts";
import { createZipBuffer } from "../src/main/zipWriter.ts";
import { parsePiSessionPromptRequest } from "../src/main/ipc/agentSessionRequest.ts";
import { needsLegacyLineReviewUpgrade, upgradeLegacyLineReviewHtmlContent, upgradeLegacyBatchLineReviewHtmlContent, needsLegacyBatchLineReviewUpgrade } from "../src/shared/core/legacyHtml.ts";
import { BATCH_LINE_REVIEW_PROTOCOL_MARKER, LINE_REVIEW_PROTOCOL_MARKER } from "../src/shared/core/html.ts";
import { resolveLineReviewSidecarStatePath } from "../src/main/batchLineReviewTxt.ts";

const sourceLines = ["[speaker]こんにちは {name}。", "次の文です。"];
const targetLines = ["[speaker]你好 {name}。", "下一句。"];
const pairLines = targetLines.flatMap((line, i) => [line, sourceLines[i]]);
function epub(lines) {
  return createZipBuffer([
    { path: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
    { path: "META-INF/container.xml", data: Buffer.from('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>') },
    { path: "EPUB/package.opf", data: Buffer.from('<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>') },
    { path: "EPUB/chapter.xhtml", data: Buffer.from(`<html><body>${lines.map((line) => `<p>${line}</p>`).join("")}</body></html>`) }
  ]);
}
function reviewData(html) { return JSON.parse(html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]); }
async function childPath(prepared) {
  if (prepared.sourceKind !== "folder") return prepared.outputPath;
  const html = await readFile(prepared.outputPath, "utf8");
  const batch = JSON.parse(html.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  return path.join(path.dirname(prepared.outputPath), batch.files[0].outputPath);
}
async function fixture(options, work) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-builtin-documents-"));
  try {
    const sourceDir = path.join(root, "source");
    const targetDir = path.join(root, "target");
    await mkdir(path.join(sourceDir, "chapter"), { recursive: true });
    await mkdir(path.join(targetDir, "chapter"), { recursive: true });
    const original = path.join(sourceDir, "chapter", `物語.${options.kind}`);
    const target = path.join(targetDir, "chapter", `物語.${options.kind}`);
    const sourceBytes = options.kind === "epub" ? epub(options.bilingual ? pairLines : sourceLines) : Buffer.from((options.bilingual ? pairLines : sourceLines).join("\n"));
    const targetBytes = options.kind === "epub" ? epub(targetLines) : Buffer.from(targetLines.join("\n"));
    await writeFile(original, sourceBytes);
    await writeFile(target, targetBytes);
    const settings = builtinTaskDefaults({ outputDir: root, sourcePath: options.folder ? sourceDir : original,
      sourceKind: options.folder ? "folder" : "file", translationPath: options.bilingual ? original : options.folder ? targetDir : target,
      fileType: options.kind, inputMode: options.bilingual ? "bilingual" : "separate" });
    await work({ root, original, target, sourceBytes, targetBytes, settings });
    assert.deepEqual(await readFile(original), sourceBytes, "original source bytes remain untouched");
    assert.deepEqual(await readFile(target), targetBytes, "original selected translation bytes remain untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const kind of ["txt", "epub"]) for (const folder of [false, true]) {
  test(`bilingual ${folder ? "folder" : "single"} ${kind} shares separated native/HTML target bindings and preserves retry edits`, () => fixture({ kind, folder, bilingual: true }, async (f) => {
    const prepared = await generateBuiltinTaskReview(f.settings, "proofread");
    assert.equal(prepared.documents.length, 1);
    const doc = prepared.documents[0];
    assert.equal(await readFile(doc.sourcePath, "utf8"), sourceLines.join("\n"));
    assert.equal(await readFile(doc.translationPath, "utf8"), targetLines.join("\n"));
    assert.notEqual(doc.sourcePath, doc.translationPath);
    assert.match(doc.translationPath, /物語_translated\.txt$/);
    const htmlPath = await childPath(prepared);
    const data = reviewData(await readReviewHtml(htmlPath));
    assert.equal(data.workflow.paths.sourcePath, f.original);
    assert.equal(data.workflow.paths.validationSourcePath, doc.sourcePath);
    assert.equal(data.workflow.paths.translationPath, doc.translationPath);
    assert.equal(data.workflow.paths.editableTranslationPath, doc.translationPath);
    assert.equal(data.workflow.promptInputMode, "separate");
    assert.deepEqual(data.rows.map((row) => row.source), sourceLines);
    assert.deepEqual(data.rows.map((row) => row.translation), targetLines);
    assert.equal(data.workflow.bilingualPair.translationPosition, 1);
    if (kind === "epub") assert.equal(data.workflow.epubExport.mode, "pair-position");
    const request = parsePiSessionPromptRequest({ outputDir: f.root, prompt: "proofread", providerId: "test", modelId: "test", sessionId: "session-test",
      sourcePath: prepared.sourcePath, sourceSelection: { kind: prepared.sourceKind, path: prepared.sourcePath },
      folderSourceDocuments: prepared.advanced.folderSourceDocuments, folderSourceSelection: prepared.advanced.folderSourceSelection });
    const manifest = await resolvePiSourceManifest(request);
    assert.equal(manifest.documents[0].path, doc.sourcePath);
    assert.equal(manifest.documents[0].lineCount, 2);
    if (folder) assert.equal(manifest.documents[0].id, `chapter/物語.${kind}`);
    const scanned = await prepareBuiltinTaskDocuments(f.settings);
    assert.equal(scanned.documents[0].sourcePath, manifest.documents[0].path);
    await writeFile(doc.translationPath, targetLines.map((line) => `${line}更新`).join("\n"));
    await generateBuiltinTaskReview(f.settings, "proofread");
    assert.match(await readFile(doc.translationPath, "utf8"), /更新/);
    if (folder) {
      await writeFile(f.original, kind === "epub" ? epub([...pairLines, "新增译文", "新しい文"]) : [...pairLines, "新增译文", "新しい文"].join("\n"));
      await assert.rejects(resolvePiSourceManifest(request), /projection is stale/);
      await writeFile(f.original, f.sourceBytes);
      await writeFile(doc.sourcePath, "tampered source");
      await assert.rejects(resolvePiSourceManifest(request), /projection is stale/);
    }
  }));
}
test("separate folder EPUB copies extracted existing targets to canonical TXT, never binary EPUB", () => fixture({ kind: "epub", folder: true }, async (f) => {
  const prepared = await generateBuiltinTaskReview(f.settings, "proofread");
  const doc = prepared.documents[0];
  assert.equal(await readFile(doc.translationPath, "utf8"), targetLines.join("\n"));
  assert.equal(doc.id, "chapter/物語.epub");
  const manifest = await resolvePiSourceManifest({ outputDir: f.root, sourceSelection: { kind: "folder", path: f.settings.sourcePath }, folderSourceDocuments: prepared.advanced.folderSourceDocuments });
  assert.equal(manifest.documents[0].path, doc.sourcePath);
}));
test("separate single EPUB and TXT bind existing translations through canonical target", async () => {
  for (const kind of ["epub", "txt"]) await fixture({ kind }, async (f) => {
    const prepared = await generateBuiltinTaskReview(f.settings, "proofread");
    assert.equal(await readFile(prepared.translationPath, "utf8"), targetLines.join("\n"));
    assert.notEqual(prepared.translationPath, f.target);
  });
});
test("unverified copied TXT cannot override original folder source", () => fixture({ kind: "txt", folder: true, bilingual: true }, async (f) => {
  const prepared = await prepareBuiltinTaskDocuments(f.settings);
  const docs = prepared.advanced.folderSourceDocuments.map(({ projection, ...entry }) => entry);
  const manifest = await resolvePiSourceManifest({ outputDir: f.root, sourceSelection: { kind: "folder", path: f.settings.sourcePath }, folderSourceDocuments: docs });
  assert.equal(manifest.documents[0].path, f.original);
  assert.equal(manifest.documents[0].lineCount, 4);
}));
test("selecting a different translation refuses a conflicting canonical target without overwriting either", () => fixture({ kind: "txt" }, async (f) => {
  const prepared = await generateBuiltinTaskReview(f.settings, "proofread");
  const alternate = path.join(f.root, "alternate.txt");
  await writeFile(alternate, "另一版译文。\n另外一句。");
  await assert.rejects(generateBuiltinTaskReview({ ...f.settings, translationPath: alternate }, "proofread"), /conflicts with the existing canonical target/);
  assert.equal(await readFile(prepared.translationPath, "utf8"), targetLines.join("\n"));
  assert.equal(await readFile(alternate, "utf8"), "另一版译文。\n另外一句。");
  await generateBuiltinTaskReview({ ...f.settings, translationPath: prepared.translationPath }, "proofread");
}));
test("legacy built-in HTML upgrades preserve projection provenance and new embedded transport", () => fixture({ kind: "txt", folder: true, bilingual: true }, async (f) => {
  const prepared = await generateBuiltinTaskReview(f.settings, "proofread");
  const indexHtml = await readFile(prepared.outputPath, "utf8");
  const old = indexHtml.replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-v7");
  assert.equal(needsLegacyBatchLineReviewUpgrade(old), true);
  const upgraded = upgradeLegacyBatchLineReviewHtmlContent(old);
  const batch = JSON.parse(upgraded.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(batch.folderAgentRoute.advanced.folderSourceDocuments[0].projection, prepared.documents[0].projection);
  const childHtml = await readFile(await childPath(prepared), "utf8");
  const staleChild = childHtml.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v40");
  assert.equal(needsLegacyLineReviewUpgrade(staleChild), true);
  const upgradedChild = upgradeLegacyLineReviewHtmlContent(staleChild);
  assert.match(upgradedChild, /Invalid workflow source projection provenance/);
  assert.equal(reviewData(upgradedChild).workflow.promptDefaults.folderSourceSelection, "prepared-inputs");
}));
test("same preparation regenerates one review path without changing its sidecar edits or canonical output location", async () => {
  for (const folder of [false, true]) await fixture({ kind: "txt", folder, bilingual: true }, async (f) => {
    const prepared = await generateBuiltinTaskReview({ ...f.settings, translateOutputDir: path.join(f.root, "unsupported") }, "proofread", "pi-stable-session");
    const child = await childPath(prepared);
    const sidecar = await resolveLineReviewSidecarStatePath(child);
    await mkdir(path.dirname(sidecar), { recursive: true });
    const edits = JSON.stringify({ edits: { "1": "人工修改。" }, revisions: { "1": 2 } });
    await writeFile(sidecar, edits);
    const next = await generateBuiltinTaskReview({ ...f.settings, customPreserveRules: [{ pattern: "\\{name\\}", flags: "u" }] }, "proofread", "pi-stable-session");
    assert.equal(next.outputPath, prepared.outputPath);
    assert.equal(await childPath(next), child);
    assert.equal(await resolveLineReviewSidecarStatePath(await childPath(next)), sidecar);
    assert.equal(await readFile(sidecar, "utf8"), edits);
    assert.equal(next.advanced.translateOutputDir, path.join(f.root, "AI_translation"));
    assert.equal(reviewData(await readFile(child, "utf8")).workflow.promptDefaults.customPreserveRules.length, 1);
  });
});
test("different folder bindings never collide on an ordinal child sidecar filename", () => fixture({ kind: "txt", folder: true, bilingual: true }, async (f) => {
  const first = await generateBuiltinTaskReview(f.settings, "proofread", "first-session");
  const secondRoot = path.join(f.root, "another-source");
  await mkdir(secondRoot);
  await writeFile(path.join(secondRoot, "different.txt"), pairLines.join("\n"));
  const second = await generateBuiltinTaskReview({ ...f.settings, sourcePath: secondRoot }, "proofread", "second-session");
  assert.notEqual(await resolveLineReviewSidecarStatePath(await childPath(first)), await resolveLineReviewSidecarStatePath(await childPath(second)));
  const sameBinding = await generateBuiltinTaskReview(f.settings, "proofread", "restart-session");
  assert.equal(await resolveLineReviewSidecarStatePath(await childPath(first)), await resolveLineReviewSidecarStatePath(await childPath(sameBinding)));
}));
test("prepared folder selects exactly scanner/HTML inputs and verifies original plain TXT hashes", () => fixture({ kind: "txt", folder: true }, async (f) => {
  await writeFile(path.join(f.settings.sourcePath, "excluded.epub"), epub(sourceLines));
  await writeFile(path.join(f.settings.sourcePath, "notes.md"), "Unselected reference note");
  const prepared = await generateBuiltinTaskReview(f.settings, "proofread");
  const request = parsePiSessionPromptRequest({ outputDir: f.root, prompt: "proofread", providerId: "test", modelId: "test", sessionId: "session-test",
    sourceSelection: { kind: "folder", path: f.settings.sourcePath }, folderSourceSelection: prepared.advanced.folderSourceSelection,
    folderSourceDocuments: prepared.advanced.folderSourceDocuments });
  const manifest = await resolvePiSourceManifest(request);
  assert.deepEqual(manifest.documents.map((doc) => doc.path), prepared.documents.map((doc) => doc.sourcePath));
  assert.deepEqual(manifest.documents.map((doc) => doc.id), ["chapter/物語.txt"]);
  assert.equal(manifest.documents[0].path, f.original);
  await writeFile(f.original, "Changed plain text");
  await assert.rejects(resolvePiSourceManifest(request), /projection is stale/);
  await writeFile(f.original, f.sourceBytes);
  await assert.rejects(resolvePiSourceManifest({ ...request, folderSourceDocuments: request.folderSourceDocuments.map(({ projection, ...entry }) => entry) }), /provenance|type/);
  const manual = await resolvePiSourceManifest({ ...request, folderSourceSelection: undefined, folderSourceDocuments: undefined });
  assert.deepEqual(manual.documents.map((doc) => doc.id), ["chapter/物語.txt", "notes.md"]);
}));

for (const legacy of [false, true]) test(`copied folder preparation retains ${legacy ? "legacy" : "relative"} receipts, child identity and sidecar edits`, () => fixture({ kind: "txt", folder: true, bilingual: false }, async f => {
  const prepared = await generateBuiltinTaskReview(f.settings, "proofread", "same-session");
  let originalChild = await childPath(prepared);
  await writeFile(prepared.documents[0].translationPath, targetLines.map(line => line + "修改").join("\n"));
  if (legacy) {
    const receiptDir = path.join(f.root, ".translation-workshop", "agent", "builtin-targets");
    for (const name of await readdir(receiptDir)) {
      const file = path.join(receiptDir, name);
      const receipt = decodeProjectPaths(JSON.parse(await readFile(file, "utf8")), f.root);
      delete receipt.projectPathsVersion;
      const oldKey = createHash("sha256").update(path.resolve(prepared.documents[0].translationPath)).digest("hex");
      await rm(file);
      await writeFile(path.join(receiptDir, oldKey + ".json"), JSON.stringify(receipt));
    }
    const legacyChild = path.join(path.dirname(originalChild), "builtin-legacy-absolute-binding.html");
    await rename(originalChild, legacyChild); originalChild = legacyChild;
    const index = await readFile(prepared.outputPath, "utf8");
    const match = index.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/);
    const data = JSON.parse(match[1]);
    data.files[0].outputPath = path.relative(path.dirname(prepared.outputPath), legacyChild).replace(/\\/g, "/");
    await writeFile(prepared.outputPath, index.replace(match[1], JSON.stringify(data)));
  }
  const originalSidecar = await resolveLineReviewSidecarStatePath(originalChild);
  await mkdir(path.dirname(originalSidecar), { recursive: true });
  await writeFile(originalSidecar, JSON.stringify({ edits: { 1: "保留草稿" }, documentRevision: 7 }));
  const copyRoot = await mkdtemp(path.join(os.tmpdir(), "yn-builtin-copy-"));
  try {
    await cp(f.root, copyRoot, { recursive: true });
    const rebound = decodeProjectPaths(f.settings, copyRoot, f.root);
    const regenerated = await generateBuiltinTaskReview(rebound, "proofread", "same-session");
    const copiedChild = await childPath(regenerated);
    assert.equal(path.relative(copyRoot, copiedChild), path.relative(f.root, originalChild));
    assert.deepEqual(JSON.parse(await readFile(await resolveLineReviewSidecarStatePath(copiedChild), "utf8")), { edits: { 1: "保留草稿" }, documentRevision: 7 });
    assert.match(await readFile(regenerated.documents[0].translationPath, "utf8"), /修改/);
  } finally { await rm(copyRoot, { recursive: true, force: true }); }
}));

for (const kind of ["txt", "epub"]) for (const folder of [false, true]) for (const legacy of [false, true]) {
  test(`copied bilingual ${folder ? "folder" : "single"} ${kind} retains ${legacy ? "legacy" : "relative"} projection and review identity`, () => fixture({ kind, folder, bilingual: true }, async f => {
    const first = await generateBuiltinTaskReview(f.settings, "proofread", "projection-session");
    const document = first.documents[0];
    const originalChild = await childPath(first);
    let projectionPath = document.sourcePath;
    if (legacy) {
      const digest = createHash("sha1").update(path.resolve(f.original).toLowerCase()).digest("hex").slice(0, 10);
      const legacyPath = path.join(f.root, ".translation-workshop", "extracted-text", digest, "source", path.basename(projectionPath));
      if (legacyPath !== projectionPath) {
        await mkdir(path.dirname(legacyPath), { recursive: true });
        await rename(projectionPath, legacyPath);
      }
      for (const htmlPath of new Set([first.outputPath, originalChild])) {
        const html = await readReviewHtml(htmlPath);
        // Model the pre-portability absolute binding, without altering source rows.
        const legacyHtml = html.split(projectionPath.replace(/\\/g, "\\\\")).join(legacyPath.replace(/\\/g, "\\\\"));
        await writeFile(htmlPath, legacyHtml.replace(/(<script id="(?:reviewData|batchData)" type="application\/json">)([\s\S]*?)(<\/script>)/, (_all, open, json, close) => {
          const data = JSON.parse(json); delete data.projectPaths;
          return open + JSON.stringify(data) + close;
        }).replace(/<script id="yn-project-paths">[\s\S]*?<\/script>/, ""));
      }
      projectionPath = legacyPath;
    }
    await writeFile(document.translationPath, targetLines.map(line => line + "修改").join("\n"));
    const sidecar = await resolveLineReviewSidecarStatePath(originalChild);
    await mkdir(path.dirname(sidecar), { recursive: true });
    await writeFile(sidecar, JSON.stringify({ edits: { 1: "保留投影草稿" }, documentRevision: 9 }));
    const copyRoot = await mkdtemp(path.join(os.tmpdir(), "yn-projection-copy-"));
    try {
      await cp(f.root, copyRoot, { recursive: true });
      const settings = decodeProjectPaths(f.settings, copyRoot, f.root);
      const next = await generateBuiltinTaskReview(settings, "proofread", "projection-session");
      assert.equal(path.relative(copyRoot, next.documents[0].sourcePath), path.relative(f.root, projectionPath));
      const child = await childPath(next);
      assert.equal(path.relative(copyRoot, child), path.relative(f.root, originalChild));
      assert.deepEqual(JSON.parse(await readFile(await resolveLineReviewSidecarStatePath(child), "utf8")), { edits: { 1: "保留投影草稿" }, documentRevision: 9 });
      assert.match(await readFile(next.documents[0].translationPath, "utf8"), /修改/);
      const scanned = await prepareBuiltinTaskDocuments(settings, next.outputPath);
      assert.equal(scanned.documents[0].sourcePath, next.documents[0].sourcePath);
      if (!legacy) assert.equal((await prepareBuiltinTaskDocuments(settings)).documents[0].sourcePath, next.documents[0].sourcePath, "a fresh extraction has the same portable identity");
      const manifest = await resolvePiSourceManifest({ outputDir: copyRoot, sourceSelection: { kind: next.sourceKind, path: next.sourcePath },
        folderSourceDocuments: next.advanced.folderSourceDocuments, folderSourceSelection: next.advanced.folderSourceSelection });
      assert.equal(manifest.documents[0].path, next.documents[0].sourcePath);
      assert.deepEqual(next.documents[0].projection, document.projection);
      const oldWorkspace = path.resolve(f.root, ".translation-workshop");
      assert.ok(oldWorkspace.startsWith(path.resolve(f.root) + path.sep));
      await rm(oldWorkspace, { recursive: true, force: true });
      assert.equal((await generateBuiltinTaskReview(settings, "proofread", "projection-session")).documents[0].sourcePath, next.documents[0].sourcePath, "original extracted files are not consulted");
    } finally { await rm(copyRoot, { recursive: true, force: true }); }
  }));
}
