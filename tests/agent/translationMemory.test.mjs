import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  readTranslationMemoryStats,
  rememberTranslationSegments,
  searchTranslationMemory,
  translationMemoryPath
} from "../../src/main/agent/translationMemory.ts";

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

await test("translation memory starts uninitialized and records imported line pairs", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-tm-"));
  try {
    const initial = await readTranslationMemoryStats(outputDir);
    assert.equal(initial.initialized, false);
    assert.equal(initial.segmentCount, 0);
    assert.equal(initial.path, translationMemoryPath(outputDir));

    const stats = await rememberTranslationSegments({
      outputDir,
      sourceText: "王都騎士団が来た。\n遥娜は笑った。",
      targetText: "王都骑士团来了。\n遥娜笑了。",
      sourcePath: path.join(outputDir, "source.txt"),
      targetPath: path.join(outputDir, "AI_translation", "source_translated.txt"),
      languagePair: "ja->zh-CN"
    });
    assert.equal(stats.available, true);
    assert.equal(stats.initialized, true);
    assert.equal(stats.segmentCount, 2);
    assert.ok(stats.updatedAt);

    const updated = await rememberTranslationSegments({
      outputDir,
      sourceText: "王都騎士団が来た。\n遥娜は笑った。",
      targetText: "王都骑士团抵达了。\n遥娜笑了。",
      sourcePath: path.join(outputDir, "source.txt"),
      targetPath: path.join(outputDir, "AI_translation", "source_translated.txt"),
      languagePair: "ja->zh-CN"
    });
    assert.equal(updated.segmentCount, 2);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation memory refuses non line-aligned text", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-tm-"));
  try {
    await assert.rejects(
      () => rememberTranslationSegments({
        outputDir,
        sourceText: "a\nb",
        targetText: "甲"
      }),
      /line-aligned/
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation memory can be searched for reusable line pairs", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-tm-"));
  try {
    await rememberTranslationSegments({
      outputDir,
      sourceText: "王都騎士団が来た。\n遥娜は笑った。",
      targetText: "王都骑士团来了。\n遥娜笑了。",
      sourcePath: path.join(outputDir, "source.txt"),
      targetPath: path.join(outputDir, "AI_translation", "source_translated.txt"),
      languagePair: "ja->zh-CN"
    });
    const result = await searchTranslationMemory({ outputDir, query: "騎士団", maxResults: 5 });
    assert.equal(result.available, true);
    assert.equal(result.initialized, true);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].sourceText, "王都騎士団が来た。");
    assert.equal(result.matches[0].targetText, "王都骑士团来了。");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("memory statistics and search remain read-only during a background write transaction", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-tm-reader-"));
  let writer;
  try {
    await rememberTranslationSegments({ outputDir, sourceText: "Source sentence", targetText: "译文句子" });
    writer = new DatabaseSync(translationMemoryPath(outputDir));
    writer.exec("BEGIN IMMEDIATE; UPDATE translation_segments SET target_text='uncommitted';");
    assert.equal((await readTranslationMemoryStats(outputDir)).segmentCount, 1);
    assert.equal((await searchTranslationMemory({ outputDir, query: "Source" })).matches[0].targetText, "译文句子");
    writer.exec("ROLLBACK");
  } finally { writer?.close(); await rm(outputDir, { recursive: true, force: true }); }
});

await test("read-only memory queries do not initialize a database without its schema", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-tm-empty-"));
  let db;
  try {
    const file=translationMemoryPath(outputDir);await mkdir(path.dirname(file),{recursive:true});db=new DatabaseSync(file);
    assert.equal((await readTranslationMemoryStats(outputDir)).initialized,false);
    const search=await searchTranslationMemory({outputDir,query:"Source"});assert.equal(search.initialized,false);assert.deepEqual(search.matches,[]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length,0,"reads must leave schema untouched");
  } finally { db?.close(); await rm(outputDir, { recursive: true, force: true }); }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
