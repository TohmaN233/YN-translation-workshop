import { strict as assert } from "node:assert";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discardTranslationStagingCandidate,
  prepareTranslationStagingCandidate,
  promoteTranslationStagingRange,
  resolveTranslationCandidatePath,
  writeTranslationChunk
} from "../../src/main/agent/writeTranslationChunk.ts";

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

await test("translation chunk fails fast when its source cannot be read", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-translation-chunk-source-error-"));
  const args = {
    outputDir,
    sourcePaths: [path.join(outputDir, "missing-source.txt")],
    documentId: "missing-source.txt",
    fromLine: 1,
    toLine: 1,
    lines: ["不能写入"]
  };
  const candidatePath = resolveTranslationCandidatePath(args);
  try {
    await assert.rejects(
      writeTranslationChunk(args),
      (error) => error?.code === "ENOENT" || /no such file/i.test(String(error))
    );
    await assert.rejects(access(candidatePath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation candidate readers observe only complete old or new versions", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-translation-chunk-atomic-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const lineCount = 300_000;
  const sourceLines = Array(lineCount).fill("s");
  const versionALines = Array(lineCount).fill("甲");
  const versionBLines = Array(lineCount).fill("乙");
  const expectedA = `${versionALines.join("\n")}\n`;
  const expectedB = `${versionBLines.join("\n")}\n`;
  const args = {
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt",
    fromLine: 1,
    toLine: lineCount,
    lines: versionALines
  };
  const candidatePath = resolveTranslationCandidatePath(args);
  let reading = true;
  let reads = 0;
  let invalidLength = -1;
  try {
    await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
    await writeTranslationChunk(args);
    const reader = (async () => {
      while (reading) {
        const observed = await readFile(candidatePath, "utf8");
        reads += 1;
        if (observed !== expectedA && observed !== expectedB) {
          invalidLength = observed.length;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    for (let index = 0; index < 10; index += 1) {
      await writeTranslationChunk({
        ...args,
        lines: index % 2 === 0 ? versionBLines : versionALines
      });
    }
    reading = false;
    await reader;
    assert.ok(reads > 0, "Concurrent reader did not observe the candidate during writes");
    assert.equal(invalidLength, -1, `Reader observed a partial translation candidate of ${invalidLength} characters`);
  } finally {
    reading = false;
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("translation chunk preserves a source whose final logical line is empty", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-translation-chunk-final-empty-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const args = {
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt",
    fromLine: 1,
    toLine: 2,
    lines: ["译文", ""]
  };
  try {
    await writeFile(sourcePath, "source\n\n", "utf8");
    const result = await writeTranslationChunk(args);
    assert.equal(result.ok, true);
    assert.equal(
      await readFile(resolveTranslationCandidatePath(args), "utf8"),
      "译文\n\n",
      "serializing a final empty line collapsed the candidate to one logical line"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder documents preserve relative directories in candidate paths", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-translation-chunk-folder-"));
  const sourcePath = path.join(outputDir, "source", "chapter", "scene.txt");
  const args = {
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "chapter/scene.txt",
    fromLine: 1,
    toLine: 1,
    lines: ["译文"]
  };
  try {
    await writeFile(sourcePath, "source", { encoding: "utf8", flag: "wx" }).catch(async (error) => {
      if (error?.code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, "source", "utf8");
    });
    const result = await writeTranslationChunk(args);
    assert.equal(result.ok, true);
    assert.equal(
      resolveTranslationCandidatePath(args),
      path.join(outputDir, "AI_translation", "chapter", "scene_translated.txt")
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("review staging keeps rejected text out of the canonical candidate until promotion", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-translation-chunk-staging-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const args = {
    outputDir,
    sourcePaths: [sourcePath],
    documentId: "source.txt"
  };
  const candidatePath = resolveTranslationCandidatePath(args);
  try {
    await writeFile(sourcePath, "source one\nsource two\nsource three", "utf8");
    await writeTranslationChunk({
      ...args,
      fromLine: 1,
      toLine: 3,
      lines: ["旧一", "旧二", "旧三"]
    });
    const stagingPath = await prepareTranslationStagingCandidate({
      ...args,
      sessionId: "parent-session",
      subagentId: "worker-1",
      assignmentId: "source-L2-L2"
    });
    const staged = await writeTranslationChunk({
      ...args,
      candidatePath: stagingPath,
      fromLine: 2,
      toLine: 2,
      lines: ["待审译文"]
    });
    assert.equal(staged.ok, true);
    assert.equal(
      await readFile(candidatePath, "utf8"),
      "旧一\n旧二\n旧三\n",
      "an unreviewed staging write must not mutate the canonical artifact"
    );
    assert.equal(await readFile(stagingPath, "utf8"), "旧一\n待审译文\n旧三\n");

    const promoted = await promoteTranslationStagingRange({
      ...args,
      stagingPath,
      fromLine: 2,
      toLine: 2
    });
    assert.equal(promoted.ok, true);
    assert.equal(await readFile(candidatePath, "utf8"), "旧一\n待审译文\n旧三\n");

    await discardTranslationStagingCandidate({ outputDir, stagingPath });
    await assert.rejects(access(stagingPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
