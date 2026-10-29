import { strict as assert } from "node:assert";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  bindBatchLineReviewTranslations,
  batchLineReviewOwnsChild,
  canonicalBatchLineReviewIndexPath,
  prepareBatchLineReviewTxtWrites,
  readBatchLineReviewChildren,
  readBatchLineReviewCurrentBindings,
  resolveLineReviewSidecarStatePath
} from "../../src/main/batchLineReviewTxt.ts";
import { renderBatchLineReviewIndexHtml, renderLineReviewHtml } from "../../src/shared/core/html.ts";
import { readProjectJsonObject, stringifyProjectJson } from "../../src/main/projectJson.ts";

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
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "yn-batch-txt-"));
  const workspaceDir = path.join(projectDir, ".translation-workshop");
  const htmlDir = path.join(workspaceDir, "html");
  const childDir = path.join(htmlDir, "batch");
  const stateDir = path.join(workspaceDir, "state");
  const sourceDir = path.join(projectDir, "source");
  const translationDir = path.join(projectDir, "existing");
  await Promise.all([
    mkdir(childDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(path.join(sourceDir, "nested"), { recursive: true }),
    mkdir(translationDir, { recursive: true })
  ]);

  const sourceA = path.join(sourceDir, "a.txt");
  const sourceB = path.join(sourceDir, "nested", "b.txt");
  const translationA = path.join(translationDir, "a.txt");
  const childA = path.join(childDir, "a.html");
  const childB = path.join(childDir, "b.html");
  const indexPath = path.join(htmlDir, "batch.html");
  await Promise.all([
    writeFile(sourceA, "A1\nA2", "utf8"),
    writeFile(sourceB, "B1\nB2", "utf8"),
    writeFile(translationA, "disk A1\ndisk A2", "utf8")
  ]);

  await Promise.all([
    writeFile(childA, renderLineReviewHtml({
      title: "A",
      sourceText: "A1\nA2",
      translationText: "embedded A1\nembedded A2",
      lineReviewPath: childA,
      workflow: {
        sourcePath: sourceA,
        sourceKind: "file",
        translationPath: translationA,
        editableTranslationPath: translationA,
        outputDir: projectDir
      }
    }), "utf8"),
    writeFile(childB, renderLineReviewHtml({
      title: "B",
      sourceText: "B1\nB2",
      translationText: "",
      lineReviewPath: childB,
      workflow: {
        sourcePath: sourceB,
        sourceKind: "file",
        sourcePromptPath: sourceDir,
        promptSourceKind: "folder",
        outputDir: projectDir
      }
    }), "utf8")
  ]);
  await writeFile(
    path.join(stateDir, "line-a.html.json"),
    JSON.stringify({ edits: { 2: "manual A2" } }),
    "utf8"
  );
  await writeFile(
    path.join(stateDir, "line-b.html.json"),
    JSON.stringify({ edits: { 1: "manual B1", 2: "manual B2" } }),
    "utf8"
  );
  await writeFile(indexPath, renderBatchLineReviewIndexHtml({
    title: "Batch",
    files: [
      {
        sourceName: "a.txt",
        sourcePath: sourceA,
        outputPath: "batch/a.html",
        status: "matched",
        sourceLineCount: 2,
        translationName: "a.txt",
        translationPath: translationA,
        translationLineCount: 2
      },
      {
        sourceName: "nested/b.txt",
        sourcePath: sourceB,
        outputPath: "batch/b.html",
        status: "missing-translation",
        sourceLineCount: 2
      }
    ],
    workflow: {
      sourcePath: sourceDir,
      sourceKind: "folder",
      outputDir: projectDir
    }
  }), "utf8");
  return { projectDir, sourceA, sourceB, translationA, childA, childB, indexPath };
}

async function writeBlankEpubBatchFixture(item, options = {}) {
  const sourcePath = path.join(item.projectDir, "synthetic-book.epub");
  const editableTranslationPath = options.editableTranslationPath ?? path.join(
    item.projectDir,
    ".translation-workshop",
    "extracted-text",
    "synthetic-book",
    "translation",
    "synthetic-book_translated.txt"
  );
  await writeFile(sourcePath, "synthetic EPUB source", "utf8");
  await mkdir(path.dirname(editableTranslationPath), { recursive: true });
  await writeFile(editableTranslationPath, "", "utf8");
  await writeFile(item.childB, renderLineReviewHtml({
    title: "Synthetic EPUB draft",
    sourceText: "Synthetic source line one.\nSynthetic source line two.",
    translationText: "",
    lineReviewPath: item.childB,
    workflow: {
      sourcePath,
      sourceKind: "file",
      editableTranslationPath,
      ...(options.workflowTranslationPath ? { translationPath: options.workflowTranslationPath } : {}),
      outputDir: item.projectDir
    }
  }), "utf8");
  const indexTranslationPath = options.indexTranslationPath ?? undefined;
  await writeFile(item.indexPath, renderBatchLineReviewIndexHtml({
    title: "Synthetic EPUB batch",
    files: [{
      sourceName: "synthetic-book.epub",
      sourcePath,
      outputPath: "batch/b.html",
      sourceLineCount: 2,
      ...(indexTranslationPath ? { translationPath: indexTranslationPath } : {})
    }],
    workflow: {
      sourcePath: path.dirname(sourcePath),
      sourceKind: "folder",
      outputDir: item.projectDir
    }
  }), "utf8");
  const statePath = path.join(item.projectDir, ".translation-workshop", "state", "line-b.html.json");
  await writeFile(statePath, JSON.stringify({
    ...(options.sidecarTranslationPath ? { translationPath: options.sidecarTranslationPath } : {}),
    edits: {}
  }), "utf8");
  return { sourcePath, editableTranslationPath, statePath };
}

await test("batch TXT planning overlays each child sidecar on the latest bound translation", async () => {
  const item = await fixture();
  const plans = await prepareBatchLineReviewTxtWrites(item.indexPath);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].targetPath, item.translationA);
  assert.equal(plans[0].text, "disk A1\nmanual A2");
  assert.equal(
    plans[1].targetPath,
    path.join(item.projectDir, "AI_translation", "nested", "b_translated.txt")
  );
  assert.equal(plans[1].text, "manual B1\nmanual B2");
  assert.equal(await readFile(item.sourceA, "utf8"), "A1\nA2");
  assert.equal(await readFile(item.sourceB, "utf8"), "B1\nB2");
});

await test("batch index exposes document routing metadata for aggregate proposal review", async () => {
  const item = await fixture();
  const children = await readBatchLineReviewChildren(item.indexPath);
  assert.deepEqual(children, [{
    documentId: "a.txt",
    sourcePath: item.sourceA,
    translationPath: item.translationA,
    childPath: item.childA,
    outputPath: "batch/a.html",
    sourceLineCount: 2,
    outputDir: item.projectDir
  }, {
    documentId: "nested/b.txt",
    sourcePath: item.sourceB,
    childPath: item.childB,
    outputPath: "batch/b.html",
    sourceLineCount: 2,
    outputDir: item.projectDir
  }]);
});

await test("a folder child route resolves back to its canonical batch index", async () => {
  const item = await fixture();
  assert.equal(await canonicalBatchLineReviewIndexPath(item.childA), item.indexPath);
  assert.equal(await canonicalBatchLineReviewIndexPath(item.childB), item.indexPath);
  assert.equal(await canonicalBatchLineReviewIndexPath(item.indexPath), item.indexPath);
});

await test("proposal synchronization and batch TXT share an imported child translation binding", async () => {
  const item = await fixture();
  const importedB = path.join(item.projectDir, "imported", "b.txt");
  await mkdir(path.dirname(importedB), { recursive: true });
  await writeFile(importedB, "imported B1\nimported B2", "utf8");
  await writeFile(
    path.join(item.projectDir, ".translation-workshop", "state", "line-b.html.json"),
    JSON.stringify({ translationPath: importedB, edits: { 1: "manual B1", 2: "manual B2" } }),
    "utf8"
  );
  const bindings = await readBatchLineReviewCurrentBindings(item.indexPath);
  assert.equal(bindings.find((binding) => binding.documentId === "nested/b.txt")?.translationPath, importedB);
  const plans = await prepareBatchLineReviewTxtWrites(item.indexPath);
  assert.equal(plans.find((plan) => plan.childPath === item.childB)?.targetPath, importedB);
});

await test("batch index binding updates make every canonical child point at its current translation", async () => {
  const item = await fixture();
  const translationB = path.join(item.projectDir, "AI_translation", "nested", "b_translated.txt");
  const updated = bindBatchLineReviewTranslations(await readFile(item.indexPath, "utf8"), [{
    documentId: "nested/b.txt",
    translationPath: translationB,
    translationLineCount: 2
  }]);
  const match = updated.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/i);
  const payload = JSON.parse(match[1]);
  assert.equal(payload.files[1].translationPath, translationB);
  assert.equal(payload.files[1].translationName, "b_translated.txt");
  assert.equal(payload.files[1].translationLineCount, 2);
  assert.equal(payload.files[1].status, "matched");
});

await test("a canonical imported sidecar overrides stale HTML and index translation bindings", async () => {
  const item = await fixture();
  const imported = path.join(item.projectDir, "other.txt");
  await writeFile(imported, "imported A1\nimported A2");
  await writeFile(
    path.join(item.projectDir, ".translation-workshop", "state", "line-a.html.json"),
    JSON.stringify({ translationPath: imported, edits: { 2: "manual A2" } }),
    "utf8"
  );
  const plan = (await prepareBatchLineReviewTxtWrites(item.indexPath)).find(plan => plan.childPath === item.childA);
  assert.equal(plan.targetPath, imported);
  assert.equal(plan.text, "imported A1\nmanual A2");
});

await test("a copied batch project resolves relative sidecar bindings under its new root", async () => {
  const item = await fixture();
  const copied = await mkdtemp(path.join(os.tmpdir(), "yn-batch-moved-"));
  try {
    const imported = path.join(item.projectDir, "existing", "imported-b.txt");
    await writeFile(imported, "imported B1\nimported B2");
    const statePath = path.join(item.projectDir, ".translation-workshop", "state", "line-b.html.json");
    await writeFile(statePath, stringifyProjectJson(statePath, {
      translationPath: imported, translationPromptPath: imported, edits: { 1: "reviewed B1" }
    }));
    await cp(item.projectDir, copied, { recursive: true });
    const index = path.join(copied, ".translation-workshop", "html", "batch.html");
    const bindings = await readBatchLineReviewCurrentBindings(index);
    assert.equal(bindings.find(binding => binding.documentId === "nested/b.txt").translationPath,
      path.join(copied, "existing", "imported-b.txt"));
    const writes = await prepareBatchLineReviewTxtWrites(index);
    const plan = writes.find(write => write.childPath.endsWith("b.html"));
    assert.equal(plan.targetPath, path.join(copied, "existing", "imported-b.txt"));
    assert.equal(plan.text, "reviewed B1\nimported B2");
    assert.equal(await readFile(imported, "utf8"), "imported B1\nimported B2", "the still-existing old project stays untouched");
  } finally {
    assert.ok(copied.startsWith(path.join(os.tmpdir(), "yn-batch-moved-")));
    await rm(copied, { recursive: true, force: true });
  }
});

await test("a moved legacy sidecar uses project.json ownership while preserving external references", async () => {
  const item = await fixture();
  const copied = await mkdtemp(path.join(os.tmpdir(), "yn-batch-legacy-moved-"));
  try {
    await writeFile(path.join(item.projectDir, ".translation-workshop", "project.json"), JSON.stringify({ outputDir: item.projectDir }));
    const external = path.join(os.tmpdir(), "external-reference.txt");
    await writeFile(path.join(item.projectDir, ".translation-workshop", "state", "line-a.html.json"),
      JSON.stringify({ translationPath: item.translationA, referencePath: external, edits: { 2: "moved manual A2" } }));
    await cp(item.projectDir, copied, { recursive: true });
    const index = path.join(copied, ".translation-workshop", "html", "batch.html");
    const plan = (await prepareBatchLineReviewTxtWrites(index)).find(write => write.childPath.endsWith("a.html"));
    assert.equal(plan.targetPath, path.join(copied, "existing", "a.txt"));
    assert.equal(plan.text, "disk A1\nmoved manual A2");
    const sidecar = await readProjectJsonObject(path.join(copied, ".translation-workshop", "state", "line-a.html.json"));
    assert.equal(sidecar.referencePath, external);
  } finally {
    assert.ok(copied.startsWith(path.join(os.tmpdir(), "yn-batch-legacy-moved-")));
    await rm(copied, { recursive: true, force: true });
  }
});

await test("batch TXT planning refuses to create a partial translation from an empty child", async () => {
  const item = await fixture();
  await writeFile(
    path.join(item.projectDir, ".translation-workshop", "state", "line-b.html.json"),
    JSON.stringify({ edits: { 1: "manual B1" } }),
    "utf8"
  );
  await assert.rejects(
    () => prepareBatchLineReviewTxtWrites(item.indexPath),
    /no current translation artifact.*nested\/b\.txt/i
  );
});

await test("an extracted EPUB editable snapshot alone stays canonical-default and rejects stale targets", async () => {
  const item = await fixture();
  const draft = await writeBlankEpubBatchFixture(item);
  const binding = (await readBatchLineReviewCurrentBindings(item.indexPath))[0];
  const canonicalTarget = path.join(item.projectDir, "AI_translation", "synthetic-book_translated.txt");
  assert.equal(binding.translationBinding, "canonical-default");
  assert.equal(binding.translationPath, canonicalTarget);
  assert.notEqual(binding.translationPath, draft.editableTranslationPath);

  await mkdir(path.dirname(canonicalTarget), { recursive: true });
  await writeFile(canonicalTarget, "Synthetic target one.\nSynthetic target two.\nStale extra line.", "utf8");
  await assert.rejects(
    () => prepareBatchLineReviewTxtWrites(item.indexPath),
    /line count changed.*synthetic-book\.epub.*expected 2, got 3/i
  );
});

await test("explicit EPUB sidecar, index, and original-file bindings keep their extracted editable target", async () => {
  for (const bindingKind of ["sidecar", "index", "selected-epub"]) {
    const item = await fixture();
    const editableTranslationPath = path.join(
      item.projectDir,
      ".translation-workshop",
      "extracted-text",
      "synthetic-book",
      "translation",
      "synthetic-book_translated.txt"
    );
    const options = bindingKind === "sidecar"
      ? { sidecarTranslationPath: editableTranslationPath }
      : bindingKind === "index"
        ? { indexTranslationPath: editableTranslationPath }
        : { workflowTranslationPath: path.join(item.projectDir, "selected-translation.epub") };
    await writeBlankEpubBatchFixture(item, options);
    await writeFile(editableTranslationPath, "Synthetic target one.\nSynthetic target two.", "utf8");

    const binding = (await readBatchLineReviewCurrentBindings(item.indexPath))[0];
    assert.equal(binding.translationBinding, "explicit", `${bindingKind} selection remains explicit`);
    assert.equal(binding.translationPath, editableTranslationPath);
    const plan = (await prepareBatchLineReviewTxtWrites(item.indexPath))[0];
    assert.equal(plan.targetPath, editableTranslationPath);
    assert.equal(plan.text, "Synthetic target one.\nSynthetic target two.");

    await writeFile(editableTranslationPath, "Synthetic target one.\nSynthetic target two.\nStale extra line.", "utf8");
    await assert.rejects(
      () => prepareBatchLineReviewTxtWrites(item.indexPath),
      /line count changed.*synthetic-book\.epub.*expected 2, got 3/i,
      `${bindingKind} selection must keep stale-target rejection`
    );
  }
});

await test("a standalone editable TXT remains an explicit target without selected bindings", async () => {
  const item = await fixture();
  const standaloneTarget = path.join(item.projectDir, "editable-translation.txt");
  await writeBlankEpubBatchFixture(item, { editableTranslationPath: standaloneTarget });
  const binding = (await readBatchLineReviewCurrentBindings(item.indexPath))[0];
  assert.equal(binding.translationBinding, "explicit");
  assert.equal(binding.translationPath, standaloneTarget);
});

await test("batch TXT planning rejects a current translation whose line count drifted", async () => {
  const item = await fixture();
  await writeFile(item.translationA, "disk A1\ndisk A2\ndisk A3", "utf8");
  await assert.rejects(
    () => prepareBatchLineReviewTxtWrites(item.indexPath),
    /line count changed.*a\.txt.*expected 2, got 3/i
  );
});

await test("batch TXT planning never treats a source TXT as the writable translation", async () => {
  const item = await fixture();
  const html = await readFile(item.childA, "utf8");
  await writeFile(item.childA, html
    .replaceAll(item.translationA.replaceAll("\\", "\\\\"), item.sourceA.replaceAll("\\", "\\\\"))
    .replaceAll(item.translationA, item.sourceA), "utf8");
  const plans = await prepareBatchLineReviewTxtWrites(item.indexPath);
  assert.notEqual(plans[0].targetPath, item.sourceA);
});

await test("batch TXT planning rejects child traversal before producing any writes", async () => {
  const item = await fixture();
  const indexHtml = await readFile(item.indexPath, "utf8");
  await writeFile(item.indexPath, indexHtml.replaceAll("batch/a.html", "../outside.html"), "utf8");
  await assert.rejects(
    () => prepareBatchLineReviewTxtWrites(item.indexPath),
    /cannot contain|stay inside|relative HTML path/i
  );
});

await test("legacy root batch children keep project sidecars and explicit batch ownership", async () => {
  const item = await fixture();
  const rootChild = path.join(item.projectDir, "legacy-a.html");
  const rootIndex = path.join(item.projectDir, "legacy-batch.html");
  await writeFile(rootChild, await readFile(item.childA, "utf8"), "utf8");
  await writeFile(rootIndex, renderBatchLineReviewIndexHtml({
    title: "Legacy batch",
    files: [{
      sourceName: "a.txt",
      sourcePath: item.sourceA,
      outputPath: path.basename(rootChild),
      status: "matched",
      sourceLineCount: 2,
      translationName: "a.txt",
      translationPath: item.translationA,
      translationLineCount: 2
    }],
    workflow: {
      sourcePath: path.dirname(item.sourceA),
      sourceKind: "folder",
      outputDir: item.projectDir
    }
  }), "utf8");
  assert.equal(await batchLineReviewOwnsChild(rootIndex, rootChild), true);
  assert.equal(await batchLineReviewOwnsChild(rootIndex, item.childB), false);
  assert.equal(
    await resolveLineReviewSidecarStatePath(rootChild),
    path.join(item.projectDir, ".translation-workshop", "state", "line-legacy-a.html.json")
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
