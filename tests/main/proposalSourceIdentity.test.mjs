import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createZipBuffer } from "../../src/main/zipWriter.ts";
import { extractedWorkshopTextPath, workshopDirFromOutput } from "../../src/main/agent/translationBindingResolve.ts";
import { stringifyProjectJson } from "../../src/main/projectJson.ts";
import { canonicalBatchProposalSourcePath, resolveProposalSourceIdentity } from "../../src/main/proposalSourceIdentity.ts";
import { readEpubText } from "../../src/main/epubReader.ts";

function createEpub(lines) {
  return createZipBuffer([
    { path: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
    { path: "META-INF/container.xml", data: Buffer.from('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>') },
    { path: "EPUB/package.opf", data: Buffer.from('<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>') },
    { path: "EPUB/chapter.xhtml", data: Buffer.from(`<html><body>${lines.map((line) => `<p>${line}</p>`).join("")}</body></html>`) }
  ]);
}

test("concurrent EPUB reads with the same name and cache label keep independent source text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-epub-source-isolation-"));
  const workspace = path.join(root, ".translation-workshop");
  const books = ["alpha", "beta"].map((label) => {
    const lines = [`Synthetic ${label} first paragraph.`, `Synthetic ${label} second paragraph.`];
    return { sourcePath: path.join(root, label, "source.epub"), lines, sourceBytes: createEpub(lines) };
  });
  try {
    for (const book of books) {
      await mkdir(path.dirname(book.sourcePath), { recursive: true });
      await writeFile(book.sourcePath, book.sourceBytes);
    }
    const text = await Promise.all(books.map((book) => readEpubText(book.sourcePath, workspace, "same-label-source.epub")));
    for (const [index, book] of books.entries()) {
      assert.equal(text[index].trim(), book.lines.join("\n"));
      assert.deepEqual(await readFile(book.sourcePath), book.sourceBytes, "reading must keep the original EPUB unchanged");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeProject({ lines, projectionLines, project: projectFields = {} }, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-proposal-source-"));
  const outputDir = path.join(root, "project");
  const originalPath = path.join(outputDir, "source.epub");
  const workspace = workshopDirFromOutput(outputDir);
  const projectionPath = extractedWorkshopTextPath(workspace, originalPath, "source");
  const sourceBytes = createEpub(lines);
  const projectionText = `${projectionLines.join("\n")}\n`;
  try {
    await mkdir(path.dirname(projectionPath), { recursive: true });
    await writeFile(originalPath, sourceBytes);
    await writeFile(projectionPath, projectionText, "utf8");
    await writeFile(path.join(workspace, "project.json"), stringifyProjectJson(path.join(workspace, "project.json"), {
      sourcePath: originalPath,
      inputMode: "separate",
      ...projectFields
    }, outputDir));
    await run({ outputDir, originalPath, projectionPath, sourceBytes, projectionText });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ordinary TXT with an EPUB project binding is not mistaken for its projection", async () => {
  await makeProject({
    lines: ["EPUB source paragraph."],
    projectionLines: ["Unrelated TXT paragraph."]
  }, async ({ outputDir, originalPath }) => {
    const ordinaryPath = path.join(outputDir, "source.txt");
    await writeFile(ordinaryPath, "Unrelated TXT paragraph.\n", "utf8");
    const result = await resolveProposalSourceIdentity(outputDir, ordinaryPath);
    assert.deepEqual(result, { sourcePath: ordinaryPath, validationSourcePath: ordinaryPath });
    assert.equal(result.epubExport, undefined);
    assert.equal(await readFile(originalPath).then((bytes) => bytes.length > 0), true);
  });
});

test("a matching EPUB TXT projection resolves to the original EPUB and retains the projection for validation", async () => {
  await makeProject({
    lines: ["Synthetic source paragraph one.", "Synthetic source paragraph two."],
    projectionLines: ["Synthetic source paragraph one.", "Synthetic source paragraph two."]
  }, async ({ outputDir, originalPath, projectionPath, sourceBytes, projectionText }) => {
    const result = await resolveProposalSourceIdentity(outputDir, projectionPath);
    assert.deepEqual(result, {
      sourcePath: originalPath,
      validationSourcePath: projectionPath,
      epubExport: { mode: "all" }
    });
    assert.deepEqual(await readFile(originalPath), sourceBytes);
    assert.equal(await readFile(projectionPath, "utf8"), projectionText);
  });
});

test("a bilingual EPUB projection validates the configured source half and exports into the translation half", async () => {
  await makeProject({
    lines: ["Synthetic source line one.", "Synthetic translation line one.", "Synthetic source line two.", "Synthetic translation line two."],
    projectionLines: ["Synthetic source line one.", "Synthetic source line two."],
    project: { inputMode: "bilingual", sourcePosition: 1, translationPosition: 2 }
  }, async ({ outputDir, originalPath, projectionPath }) => {
    const result = await resolveProposalSourceIdentity(outputDir, projectionPath);
    assert.deepEqual(result, {
      sourcePath: originalPath,
      validationSourcePath: projectionPath,
      epubExport: { mode: "pair-position", replacePosition: 2, pairSize: 2 }
    });
  });
});

test("a changed EPUB TXT projection is rejected", async () => {
  await makeProject({
    lines: ["Synthetic source paragraph one.", "Synthetic source paragraph two."],
    projectionLines: ["Synthetic source paragraph one.", "Changed projection paragraph."]
  }, async ({ outputDir, projectionPath }) => {
    await assert.rejects(
      resolveProposalSourceIdentity(outputDir, projectionPath),
      /EPUB source projection does not match the current EPUB content/
    );
  });
});

test("a direct EPUB input keeps all-position export behavior", async () => {
  await makeProject({ lines: ["Synthetic source paragraph."], projectionLines: ["Synthetic source paragraph."] }, async ({ outputDir, originalPath }) => {
    const result = await resolveProposalSourceIdentity(outputDir, originalPath);
    assert.deepEqual(result, {
      sourcePath: originalPath,
      validationSourcePath: originalPath,
      epubExport: { mode: "all" }
    });
  });
});

test("a missing matching projection is surfaced as an input error", async () => {
  await makeProject({ lines: ["Synthetic source paragraph."], projectionLines: ["Synthetic source paragraph."] }, async ({ outputDir, projectionPath }) => {
    await rm(projectionPath);
    await assert.rejects(resolveProposalSourceIdentity(outputDir, projectionPath), { code: "ENOENT" });
  });
});

test("batch proposal source identity accepts only exact or same-child explicit source bindings", async () => {
  const root = path.join(os.tmpdir(), "synthetic-portable-project");
  const physicalEpubPath = path.join(root, "source.epub");
  const projectionPath = path.join(root, "_workspace", "extracted", "source.txt");
  const otherBookProjectionPath = path.join(root, "other-book", "source.txt");
  const relocatedRoot = path.join(root, "portable-copy");
  const relocatedPhysicalEpubPath = path.join(relocatedRoot, "source.epub");
  const relocatedProjectionPath = path.join(relocatedRoot, "_workspace", "extracted", "source.txt");
  const documentId = "book/source.epub";

  assert.equal(canonicalBatchProposalSourcePath({
    documentId,
    sourcePath: physicalEpubPath,
    reportSourcePath: physicalEpubPath
  }), physicalEpubPath, "an exact physical source route remains valid without aliases");
  assert.equal(canonicalBatchProposalSourcePath({
    documentId,
    sourcePath: physicalEpubPath,
    reportSourcePath: projectionPath,
    boundSourcePaths: [physicalEpubPath, projectionPath]
  }), physicalEpubPath, "an EPUB projection is valid when both routes are explicitly bound by the same child HTML");
  assert.equal(canonicalBatchProposalSourcePath({
    documentId,
    sourcePath: relocatedPhysicalEpubPath,
    reportSourcePath: relocatedProjectionPath,
    boundSourcePaths: [relocatedPhysicalEpubPath, relocatedProjectionPath]
  }), relocatedPhysicalEpubPath, "portable relocated bindings use their decoded absolute paths");

  assert.throws(() => canonicalBatchProposalSourcePath({
    documentId,
    sourcePath: physicalEpubPath,
    reportSourcePath: otherBookProjectionPath,
    boundSourcePaths: [physicalEpubPath, projectionPath]
  }), /source|bound|document/i, "same-basename paths from another book must be rejected");
  assert.throws(() => canonicalBatchProposalSourcePath({
    documentId,
    sourcePath: physicalEpubPath,
    reportSourcePath: projectionPath,
    boundSourcePaths: [physicalEpubPath]
  }), /source|bound|document/i, "both routes must be explicit members of the child HTML binding");
  assert.throws(() => canonicalBatchProposalSourcePath({
    documentId,
    sourcePath: physicalEpubPath,
    reportSourcePath: "_workspace/extracted/source.txt",
    boundSourcePaths: [physicalEpubPath, projectionPath]
  }), /absolute|source|bound/i, "relative report paths must be rejected");
  assert.throws(() => canonicalBatchProposalSourcePath({
    documentId: "",
    sourcePath: physicalEpubPath,
    reportSourcePath: physicalEpubPath
  }), /document/i, "a source route requires a document identity");
  assert.throws(() => canonicalBatchProposalSourcePath({
    documentId: "../other-book/source.epub",
    sourcePath: physicalEpubPath,
    reportSourcePath: physicalEpubPath
  }), /document/i, "a source route must not use a traversal document identity");
});
