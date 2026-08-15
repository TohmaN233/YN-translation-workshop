import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  listProjectDir,
  readProjectFile,
  searchProjectText,
  writeProjectFile
} from "../../src/main/agent/projectFileTools.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-external-read-"));
const projectDir = path.join(root, "project");
const referenceDir = path.join(root, "references");
const referencePath = path.join(referenceDir, "outside-reference.txt");
const projectArtifactPath = path.join(projectDir, "AI_translation", "reference.txt");
const generatedHtmlDir = path.join(projectDir, ".translation-workshop", "html");
const generatedHtmlPath = path.join(generatedHtmlDir, "old-line-review.html");
const sourceSearchPath = path.join(projectDir, "txt", "search-source.txt");
const largeReferencePath = path.join(referenceDir, "large-reference.txt");
const missingExternalArtifactPath = path.join(root, "missing-external", "AI_translation", "reference.txt");

try {
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(referenceDir, { recursive: true }),
    mkdir(path.dirname(projectArtifactPath), { recursive: true }),
    mkdir(generatedHtmlDir, { recursive: true }),
    mkdir(path.dirname(sourceSearchPath), { recursive: true })
  ]);
  await writeFile(referencePath, "External lore reference\nGlass Archive", "utf8");
  await writeFile(projectArtifactPath, "project-local sentinel", "utf8");
  await writeFile(largeReferencePath, `${"a".repeat(30_000)}PAGE_MARK${"b".repeat(30_000)}`, "utf8");
  await writeFile(
    generatedHtmlPath,
    `${"x".repeat(20_000)}TARGET_NAME${"y".repeat(20_000)}`,
    "utf8"
  );
  await writeFile(
    sourceSearchPath,
    Array.from({ length: 40 }, (_, index) => `TARGET_NAME source row ${index + 1}`).join("\n"),
    "utf8"
  );

  const read = await readProjectFile({
    outputDir: projectDir,
    relativePath: referencePath
  });
  assert.equal(read.ok, true, "an absolute external reference should be readable without an approval state");
  assert.equal(read.outsideProject, true);
  assert.match(read.content, /Glass Archive/);

  const firstLargePage = await readProjectFile({
    outputDir: projectDir,
    relativePath: largeReferencePath,
    maxChars: 16_000
  });
  assert.equal(firstLargePage.ok, true);
  assert.equal(firstLargePage.content.length < 16_100, true);
  assert.equal(firstLargePage.nextOffsetChars, 16_000);
  const markedLargePage = await readProjectFile({
    outputDir: projectDir,
    relativePath: largeReferencePath,
    offsetChars: 29_000,
    maxChars: 4_000
  });
  assert.equal(markedLargePage.ok, true);
  assert.match(markedLargePage.content, /PAGE_MARK/);
  assert.equal(markedLargePage.offsetChars, 29_000);

  const list = await listProjectDir({
    outputDir: projectDir,
    relativePath: referenceDir
  });
  assert.equal(list.ok, true, "an external reference directory should be listable");
  assert.equal(list.outsideProject, true);
  assert.deepEqual(
    list.entries.map((entry) => entry.name).sort(),
    ["large-reference.txt", "outside-reference.txt"]
  );

  const search = await searchProjectText({
    outputDir: projectDir,
    relativePath: referenceDir,
    query: "Glass"
  });
  assert.equal(search.ok, true, "external UTF-8 references should be searchable");
  assert.equal(search.outsideProject, true);
  assert.equal(search.matches[0]?.path, referencePath);

  const boundedProjectSearch = await searchProjectText({
    outputDir: projectDir,
    query: "TARGET_NAME"
  });
  assert.equal(boundedProjectSearch.ok, true);
  assert.equal(boundedProjectSearch.matches.length, 25, "project search must have a bounded default result page");
  assert.equal(
    boundedProjectSearch.matches.some((match) => match.path.includes("old-line-review.html")),
    false,
    "a recursive project search must skip generated historical review HTML"
  );

  const explicitHtmlSearch = await searchProjectText({
    outputDir: projectDir,
    relativePath: generatedHtmlDir,
    query: "TARGET_NAME"
  });
  assert.equal(explicitHtmlSearch.ok, true, "an explicitly requested generated HTML directory remains readable");
  assert.equal(explicitHtmlSearch.matches.length, 1);
  assert.match(explicitHtmlSearch.matches[0].text, /TARGET_NAME/);
  assert.ok(explicitHtmlSearch.matches[0].text.length <= 240, "a long single-line payload must return a centered bounded snippet");

  const missingExternal = await readProjectFile({
    outputDir: projectDir,
    relativePath: missingExternalArtifactPath
  });
  assert.equal(missingExternal.ok, false, "a missing external absolute path must not fall back to a same-named project artifact");

  const write = await writeProjectFile({
    outputDir: projectDir,
    relativePath: path.join(referenceDir, "must-not-write.txt"),
    content: "blocked"
  });
  assert.equal(write.ok, false, "external write protection must remain intact");
  assert.match(write.error, /inside the project directory/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ok external references are readable while external writes remain blocked");
