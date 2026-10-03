import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSourcePreparation } from "../src/main/agent/sourcePreparationScan.ts";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yn-source-preparation-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("scans complete UTF-8 files, finds conservative code candidates, evaluates current rules, and does not write", async () => {
  await withTempDirectory(async (directory) => {
    const firstPath = path.join(directory, "scene-a.txt");
    const secondPath = path.join(directory, "scene-b.txt");
    const firstText = "Scene begins %2$s.\r\n<wait color=\"red\">{hero}</wait>\\N\nA note about \\Narrative stays prose.\nPlease wait [just a moment].";
    const secondText = "foo\n@IF enabled\n[WAIT:250]\nplain 100% text\n";
    await writeFile(firstPath, firstText, "utf8");
    await writeFile(secondPath, secondText, "utf8");
    const before = await Promise.all([stat(firstPath), stat(secondPath)]);
    const bytes = await Promise.all([readFile(firstPath), readFile(secondPath)]);

    const report = await scanSourcePreparation({
      files: [firstPath, secondPath],
      rules: [{ label: "foo literal", pattern: "foo", flags: "i" }]
    });

    assert.equal(report.totalFiles, 2);
    assert.equal(report.totalLines, 8);
    assert.deepEqual(report.files.map((file) => file.lineCount), [4, 4]);
    assert.deepEqual(report.files.map((file) => file.sha256), bytes.map((value) => createHash("sha256").update(value).digest("hex")));
    assert.equal(report.exampleLimit, 8);

    const candidateByLabel = new Map(report.candidates.map((candidate) => [candidate.label, candidate]));
    assert.equal(candidateByLabel.get("printf-style format placeholder")?.matchCount, 1);
    assert.equal(candidateByLabel.get("named or numbered brace placeholder")?.matchCount, 1);
    assert.equal(candidateByLabel.get("backslash control token")?.matchCount, 1);
    assert.equal(candidateByLabel.get("XML-like tag")?.matchCount, 2);
    assert.equal(candidateByLabel.get("command-style bracket or line prefix")?.matchCount, 2);
    assert.equal(candidateByLabel.get("command-style bracket or line prefix")?.examples.some((example) => example.text.includes("just a moment")), false,
      "ordinary bracketed prose must not be offered as a command candidate");
    const braceExample = candidateByLabel.get("named or numbered brace placeholder")?.examples[0];
    assert.deepEqual({ path: braceExample?.path, line: braceExample?.line, match: braceExample?.match }, {
      path: firstPath,
      line: 2,
      match: "{hero}"
    });
    assert.equal(braceExample?.before?.line, 1);
    assert.equal(braceExample?.after?.line, 3);

    assert.equal(report.existingRules.length, 1);
    const fooRule = report.existingRules[0];
    assert.deepEqual({
      label: fooRule?.label,
      pattern: fooRule?.pattern,
      flags: fooRule?.flags,
      matchCount: fooRule?.matchCount,
      linesWithMatches: fooRule?.linesWithMatches,
      filesWithMatches: fooRule?.filesWithMatches,
      totalLines: fooRule?.totalLines,
      fullLineMatches: fooRule?.fullLineMatches,
      lineCoverage: fooRule?.lineCoverage,
      fileCoverage: fooRule?.fileCoverage
    }, {
      label: "foo literal",
      pattern: "foo",
      flags: "i",
      matchCount: 1,
      linesWithMatches: 1,
      filesWithMatches: 1,
      totalLines: 8,
      fullLineMatches: 1,
      lineCoverage: 1 / 8,
      fileCoverage: 1 / 2
    });
    assert.equal(fooRule?.examples[0]?.match, "foo");

    const after = await Promise.all([stat(firstPath), stat(secondPath)]);
    assert.deepEqual(after.map((value) => value.mtimeMs), before.map((value) => value.mtimeMs));
    assert.deepEqual(await Promise.all([readFile(firstPath), readFile(secondPath)]), bytes);
  });
});

test("counts all matches while retaining only bounded examples", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "many-lines.txt");
    const content = Array.from({ length: 40 }, (_, index) => `row ${index} TOKEN`).join("\n");
    await writeFile(filePath, content, "utf8");
    const report = await scanSourcePreparation({
      files: [filePath],
      rules: [{ pattern: "TOKEN" }]
    });

    assert.equal(report.totalLines, 40);
    assert.equal(report.existingRules[0]?.matchCount, 40);
    assert.equal(report.existingRules[0]?.linesWithMatches, 40);
    assert.equal(report.existingRules[0]?.examples.length, 8);
    assert.equal(report.existingRules[0]?.lineCoverage, 1);
  });
});

test("literal /n and backslash escapes return narrow token candidates and representative prose samples", async () => {
  await withTempDirectory(async directory => {
    const filePath = path.join(directory, "controls.txt");
    const text = "Hello/nworld.\\nNext.\n普通正文。\n終わり。";
    await writeFile(filePath, text);
    const report = await scanSourcePreparation({ files: [filePath], rules: [{ pattern: String.raw`/n|\\n` }] });
    const candidate = report.candidates.find(candidate => candidate.label === "literal newline/tab escape");
    assert.equal(candidate.matchCount, 2);
    assert.equal(candidate.examples[0].match, "/n");
    assert.deepEqual(report.files[0].samples.map(sample => sample.text), text.split("\n"));
    assert.equal(report.existingRules[0].matchCount, 2);
    assert.equal(report.existingRules[0].fullLineMatches, 0, "rules preserve only controls and leave prose translatable");
  });
});

test("aborting terminates a worker that is evaluating a custom expression", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "cancel.txt");
    await writeFile(filePath, `${"a".repeat(40_000)}!`, "utf8");
    const controller = new AbortController();
    const scan = scanSourcePreparation({
      files: [filePath],
      rules: [{ pattern: "(a+)+$" }],
      signal: controller.signal
    });
    const cancellation = new Error("test cancellation");
    setTimeout(() => controller.abort(cancellation), 50);
    await assert.rejects(scan, /test cancellation/);
  });
});

test("a pathological custom expression fails visibly without returning a partial report", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "timeout.txt");
    await writeFile(filePath, `${"a".repeat(40_000)}!`, "utf8");
    const controller = new AbortController();
    const scan = scanSourcePreparation({
      files: [filePath],
      rules: [{ label: "deliberately expensive", pattern: "(a+)+$" }],
      signal: controller.signal
    });
    const timeout = setTimeout(() => controller.abort(new Error("outer test safety timeout")), 8_000);
    try {
      await assert.rejects(scan, /timed out while evaluating custom preserve rule 1[\s\S]*no partial report was returned/i);
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted) controller.abort(new Error("test cleanup"));
    }
  });
});
