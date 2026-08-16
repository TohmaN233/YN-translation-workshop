import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyProjectTranslationBinding,
  resolveProofreadTranslationPath
} from "../../src/main/agent/translationBindingResolve.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${name}`);
    console.error(error);
  }
}

await test("proofread ignores an EPUB extract snapshot and reads the canonical translated file", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-binding-"));
  try {
    const sourcePath = path.join(outputDir, "book.txt");
    const snapshot = path.join(outputDir, ".translation-workshop", "extracted-text", "deadbeef01", "translation", "book.txt");
    const canonical = path.join(outputDir, "AI_translation", "book_translated.txt");
    await mkdir(path.dirname(snapshot), { recursive: true });
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(sourcePath, "原文\n", "utf8");
    await writeFile(snapshot, "快照\n", "utf8");
    await writeFile(canonical, "正式译文\n", "utf8");
    const request = {
      outputDir,
      sessionId: "pi_bind",
      prompt: "Workflow: yn-proofread-v1.",
      providerId: "test",
      modelId: "test",
      sourcePath,
      translationPath: snapshot
    };
    const resolved = resolveProofreadTranslationPath({
      request,
      documentId: "book.txt"
    });
    assert.equal(resolved, canonical);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a user-selected translation wins over the canonical translated file", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-binding-user-"));
  try {
    const sourcePath = path.join(outputDir, "book.txt");
    const selected = path.join(outputDir, "approved.txt");
    const canonical = path.join(outputDir, "AI_translation", "book_translated.txt");
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(sourcePath, "原文\n", "utf8");
    await writeFile(selected, "手选译文\n", "utf8");
    await writeFile(canonical, "机器译文\n", "utf8");
    const request = {
      outputDir,
      sessionId: "pi_bind",
      prompt: "Workflow: yn-proofread-v1.",
      providerId: "test",
      modelId: "test",
      sourcePath,
      translationPath: selected,
      translationBindingOrigin: "user"
    };
    const resolved = resolveProofreadTranslationPath({
      request,
      documentId: "book.txt"
    });
    assert.equal(resolved, path.resolve(selected));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("project overlay drops an unselected snapshot so Host can fall back", () => {
  const applied = applyProjectTranslationBinding({
    outputDir: "G:/proj",
    sessionId: "pi_bind",
    prompt: "proofread",
    providerId: "test",
    modelId: "test",
    translationPath: "G:/proj/.translation-workshop/extracted-text/deadbeef01/translation/book.txt"
  }, {});
  assert.equal(applied.apply, true);
  assert.equal(applied.translationPath, undefined);
  assert.equal(applied.translationBindingOrigin, undefined);
});

await test("folder proofread prefers a user-selected sibling file over the generated candidate", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-binding-folder-"));
  try {
    const sourceRoot = path.join(outputDir, "source");
    const selectedRoot = path.join(outputDir, "human");
    const sourcePath = path.join(sourceRoot, "a.txt");
    const selected = path.join(selectedRoot, "a.txt");
    const canonical = path.join(outputDir, "AI_translation", "a_translated.txt");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(selectedRoot, { recursive: true });
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(sourcePath, "one\n", "utf8");
    await writeFile(selected, "手选\n", "utf8");
    await writeFile(canonical, "机器\n", "utf8");
    const resolved = resolveProofreadTranslationPath({
      request: {
        outputDir,
        sessionId: "pi_bind",
        prompt: "Workflow: yn-proofread-v1.",
        providerId: "test",
        modelId: "test",
        sourcePath,
        sourceSelection: { kind: "folder", path: sourceRoot },
        translationPath: selectedRoot,
        translationBindingOrigin: "user"
      },
      folderSource: true,
      documentId: "a.txt"
    });
    assert.equal(resolved, path.resolve(selected));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("empty project state does not erase a request translation path", () => {
  const applied = applyProjectTranslationBinding({
    outputDir: "G:/proj",
    sessionId: "pi_bind",
    prompt: "proofread",
    providerId: "test",
    modelId: "test",
    translationPath: "G:/proj/approved.txt"
  }, {});
  assert.equal(applied.apply, false);
});

await test("project overlay keeps a user-selected translation", () => {
  const applied = applyProjectTranslationBinding({
    outputDir: "G:/proj",
    sessionId: "pi_bind",
    prompt: "proofread",
    providerId: "test",
    modelId: "test",
    translationPath: "G:/proj/.translation-workshop/extracted-text/deadbeef01/translation/book.txt"
  }, {
    translationPath: "G:/proj/approved.txt",
    translationBindingOrigin: "user"
  });
  assert.equal(applied.apply, true);
  assert.equal(applied.translationPath, "G:/proj/approved.txt");
  assert.equal(applied.translationBindingOrigin, "user");
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
