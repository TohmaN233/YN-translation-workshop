import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectSourceTreeFiles } from "../../src/main/sourceFileTree.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-source-tree-"));
try {
  await Promise.all([
    mkdir(path.join(root, "route-a"), { recursive: true }),
    mkdir(path.join(root, "route-b", "chapter"), { recursive: true }),
    mkdir(path.join(root, "AI_translation"), { recursive: true }),
    mkdir(path.join(root, ".translation-workshop"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, "route-a", "scene.txt"), "a", "utf8"),
    writeFile(path.join(root, "route-b", "chapter", "scene.txt"), "b", "utf8"),
    writeFile(path.join(root, "route-b", "chapter", "notes.md"), "ignored", "utf8"),
    writeFile(path.join(root, "AI_translation", "old_translated.txt"), "ignored", "utf8"),
    writeFile(path.join(root, ".translation-workshop", "cache.txt"), "ignored", "utf8")
  ]);

  const files = await collectSourceTreeFiles(root, (filePath) => filePath.toLowerCase().endsWith(".txt"));
  assert.deepEqual(files.map((file) => file.relativePath), [
    "route-a/scene.txt",
    "route-b/chapter/scene.txt"
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("sourceFileTree tests passed");
