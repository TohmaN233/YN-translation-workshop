import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolvePiReadablePath,
  resolvePiSourceDocument,
  resolvePiSourceManifest
} from "../../src/main/agent/piNative/sourceManifest.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-pi-source-manifest-"));
try {
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "chapter"), { recursive: true });
  await mkdir(path.join(sourceRoot, "AI_translation"), { recursive: true });
  await writeFile(path.join(sourceRoot, "z.txt"), "z\n", "utf8");
  await writeFile(path.join(sourceRoot, "chapter", "a.txt"), "a\nb\n", "utf8");
  await writeFile(path.join(sourceRoot, "character_bible.md"), "# Character Bible\n", "utf8");
  await writeFile(path.join(sourceRoot, "chapter", "ignored.png"), "x", "utf8");
  await writeFile(path.join(sourceRoot, "AI_translation", "old.txt"), "old", "utf8");

  const manifest = await resolvePiSourceManifest({
    outputDir: root,
    sessionId: "pi_test",
    prompt: "translate folder",
    providerId: "test",
    modelId: "test",
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot }
  });
  assert.equal(manifest.kind, "folder");
  assert.deepEqual(manifest.documents.map((document) => document.id), ["chapter/a.txt", "z.txt"]);
  assert.deepEqual(manifest.documents.map((document) => document.lineCount), [2, 1]);
  assert.ok(manifest.documents.every((document) => path.isAbsolute(document.path)));
  assert.equal(resolvePiSourceDocument(manifest, "chapter\\a.txt")?.id, "chapter/a.txt");
  assert.equal(resolvePiSourceDocument(manifest, "a.txt")?.id, "chapter/a.txt");
  assert.equal(resolvePiSourceDocument(manifest, path.join(sourceRoot, "chapter", "a.txt"))?.id, "chapter/a.txt");
  assert.equal(resolvePiSourceDocument(manifest, "missing.txt"), undefined);

  await mkdir(path.join(sourceRoot, "other"), { recursive: true });
  await writeFile(path.join(sourceRoot, "other", "a.txt"), "other\n", "utf8");
  const ambiguousManifest = await resolvePiSourceManifest({
    outputDir: root,
    sessionId: "pi_test",
    prompt: "resolve ambiguous basename",
    providerId: "test",
    modelId: "test",
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot }
  });
  assert.throws(
    () => resolvePiSourceDocument(ambiguousManifest, "a.txt"),
    /ambiguous.*chapter\/a\.txt.*other\/a\.txt/i
  );
  await rm(path.join(sourceRoot, "other"), { recursive: true, force: true });

  const extractedSource = path.join(
    root,
    ".translation-workshop",
    "extracted-text",
    "6fdbf9ea9e",
    "source",
    "_.txt"
  );
  await mkdir(path.dirname(extractedSource), { recursive: true });
  await writeFile(extractedSource, "extracted source\nsecond line", "utf8");
  await writeFile(path.join(sourceRoot, "book.epub"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const extractedManifest = await resolvePiSourceManifest({
    outputDir: root,
    sessionId: "pi_test",
    prompt: "translate extracted text",
    providerId: "test",
    modelId: "test",
    sourcePath: extractedSource,
    sourceSelection: { kind: "file", path: extractedSource }
  });
  assert.equal(extractedManifest.kind, "file");
  assert.equal(extractedManifest.documents[0].path, extractedSource);
  assert.equal(extractedManifest.documents[0].lineCount, 2);

  const boundRequest = {
    outputDir: root,
    sessionId: "pi_test",
    prompt: "read extracted text by logical document id",
    providerId: "test",
    modelId: "test",
    sourcePath: extractedSource,
    sourceDocumentId: "book.epub"
  };
  assert.equal(resolvePiReadablePath(boundRequest, "book.epub"), extractedSource);
  assert.equal(resolvePiReadablePath(boundRequest, "_.txt"), extractedSource);
  assert.equal(resolvePiReadablePath(boundRequest, "AI_translation/book.txt"), "AI_translation/book.txt");
  assert.equal(resolvePiReadablePath(boundRequest, extractedSource), extractedSource);

  assert.equal(resolvePiReadablePath({
    ...boundRequest,
    sourcePath: sourceRoot,
    sourceDocumentId: undefined,
    folderSourceDocuments: [{ id: "book.epub", path: extractedSource }]
  }, "book.epub"), extractedSource);

  const explicitFolderManifest = await resolvePiSourceManifest({
    outputDir: root,
    sessionId: "pi_test",
    prompt: "translate generated folder manifest",
    providerId: "test",
    modelId: "test",
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    folderSourceDocuments: [
      { id: "z.txt", path: path.join(sourceRoot, "z.txt") },
      { id: "book.epub", path: extractedSource }
    ]
  });
  assert.deepEqual(explicitFolderManifest.documents.map((document) => document.id), ["book.epub", "chapter/a.txt", "z.txt"]);
  assert.deepEqual(explicitFolderManifest.documents.map((document) => document.lineCount), [2, 2, 1]);

  await writeFile(path.join(sourceRoot, "new.txt"), "new current source\n", "utf8");
  const refreshedManifest = await resolvePiSourceManifest({
    outputDir: root,
    sessionId: "pi_test",
    prompt: "ignore stale folder HTML entries",
    providerId: "test",
    modelId: "test",
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    folderSourceDocuments: [{ id: "z.txt", path: path.join(sourceRoot, "z.txt") }]
  });
  assert.ok(refreshedManifest.documents.some((document) => document.id === "new.txt"));

  const conflictingExtractedManifest = await resolvePiSourceManifest({
    outputDir: root,
    sessionId: "pi_test",
    prompt: "prefer current text over a stale extracted mapping",
    providerId: "test",
    modelId: "test",
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot },
    folderSourceDocuments: [{ id: "z.txt", path: extractedSource }]
  });
  assert.equal(
    conflictingExtractedManifest.documents.find((document) => document.id === "z.txt")?.path,
    path.join(sourceRoot, "z.txt")
  );

  const binaryEpub = path.join(root, "book.epub");
  await writeFile(binaryEpub, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await assert.rejects(
    resolvePiSourceManifest({
      outputDir: root,
      sessionId: "pi_test",
      prompt: "translate binary epub",
      providerId: "test",
      modelId: "test",
      sourceSelection: { kind: "file", path: binaryEpub }
    }),
    /unsupported source file|\.epub/i
  );

  const generatedSource = path.join(root, "AI_translation", "generated-source");
  await mkdir(generatedSource, { recursive: true });
  await writeFile(path.join(generatedSource, "generated.txt"), "generated", "utf8");
  await assert.rejects(
    resolvePiSourceManifest({
      outputDir: root,
      sessionId: "pi_test",
      prompt: "translate generated output",
      providerId: "test",
      modelId: "test",
      sourceSelection: { kind: "folder", path: generatedSource }
    }),
    /generated|workspace|output|AI_translation/i
  );

  const linkedTarget = path.join(root, "linked-target");
  const linkedRoot = path.join(root, "linked-root");
  await mkdir(linkedTarget, { recursive: true });
  await writeFile(path.join(linkedTarget, "linked.txt"), "linked", "utf8");
  await symlink(linkedTarget, linkedRoot, "junction");
  await assert.rejects(
    resolvePiSourceManifest({
      outputDir: root,
      sessionId: "pi_test",
      prompt: "translate linked root",
      providerId: "test",
      modelId: "test",
      sourceSelection: { kind: "folder", path: linkedRoot }
    }),
    /symbolic link|symlink/i
  );

  const nestedLink = path.join(sourceRoot, "linked-child");
  await symlink(linkedTarget, nestedLink, "junction");
  await assert.rejects(
    resolvePiSourceManifest({
      outputDir: root,
      sessionId: "pi_test",
      prompt: "translate folder with linked child",
      providerId: "test",
      modelId: "test",
      sourceSelection: { kind: "folder", path: sourceRoot }
    }),
    /symbolic link|symlink/i
  );

  await assert.rejects(
    resolvePiSourceManifest({
      outputDir: root,
      sessionId: "pi_test",
      prompt: "translate empty folder",
      providerId: "test",
      modelId: "test",
      sourcePath: path.join(root, "empty"),
      sourceSelection: { kind: "folder", path: path.join(root, "empty") }
    }),
    /no supported source files|ENOENT/i
  );

  const collisionRoot = path.join(root, "collision");
  await mkdir(collisionRoot, { recursive: true });
  await writeFile(path.join(collisionRoot, "same.txt"), "one", "utf8");
  await writeFile(path.join(collisionRoot, "same.md"), "two", "utf8");
  await assert.rejects(
    resolvePiSourceManifest({
      outputDir: root,
      sessionId: "pi_test",
      prompt: "translate collision folder",
      providerId: "test",
      modelId: "test",
      sourcePath: collisionRoot,
      sourceSelection: { kind: "folder", path: collisionRoot }
    }),
    /overwrite the same translation candidate/i
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ok native Pi source manifest resolves a stable folder batch");
