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

  const stagingDir = path.join(projectDir, ".translation-workshop", "agent", "translation-staging", "batch");
  const stagingPath = path.join(stagingDir, "chunk_translated.txt");
  await mkdir(stagingDir, { recursive: true });
  await writeFile(stagingPath, "已有暂存译文 冲木达也\n", "utf8");
  const { TRANSLATION_STAGING_PROJECT_TOOL_ERROR } = await import("../../src/main/agent/projectFileTools.ts");
  const stagingRead = await readProjectFile({
    outputDir: projectDir,
    relativePath: stagingPath
  });
  assert.equal(stagingRead.ok, false);
  assert.equal(stagingRead.error, TRANSLATION_STAGING_PROJECT_TOOL_ERROR);
  const stagingSearch = await searchProjectText({
    outputDir: projectDir,
    relativePath: stagingDir,
    query: "冲木"
  });
  assert.equal(stagingSearch.ok, false, "searching staging must fail closed with a redirect, not return zero matches");
  assert.equal(stagingSearch.error, TRANSLATION_STAGING_PROJECT_TOOL_ERROR);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ok external references are readable while external writes remain blocked");

const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "yn-session-read-"));
const sessionProject = path.join(sessionRoot, "project");
try {
  const childSessionDir = path.join(sessionProject, ".translation-workshop", "agent", "pi-child-sessions", "workspace");
  const childSessionPath = path.join(childSessionDir, "history.jsonl");
  const secretPath = path.join(sessionProject, ".translation-workshop", "agent", "oauth-secrets.json");
  await mkdir(childSessionDir, { recursive: true });
  await writeFile(childSessionPath, '{"type":"message","finding":"L3-042 recovered"}\n', "utf8");
  await writeFile(secretPath, '{"token":"secret"}\n', "utf8");

  const blocked = await readProjectFile({
    outputDir: sessionProject,
    relativePath: ".translation-workshop/agent/pi-child-sessions/workspace/history.jsonl"
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Pi runtime session data is not readable/);

  const allowed = await readProjectFile({
    outputDir: sessionProject,
    relativePath: ".translation-workshop/agent/pi-child-sessions/workspace/history.jsonl",
    allowRuntimeSessionRead: true
  });
  assert.equal(allowed.ok, true, allowed.error);
  assert.match(allowed.content, /L3-042 recovered/);

  const listed = await listProjectDir({
    outputDir: sessionProject,
    relativePath: ".translation-workshop/agent",
    allowRuntimeSessionRead: true
  });
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.entries.some((entry) => entry.name === "pi-child-sessions"), true);
  assert.equal(listed.entries.some((entry) => entry.name === "oauth-secrets.json"), false);

  const secret = await readProjectFile({
    outputDir: sessionProject,
    relativePath: ".translation-workshop/agent/oauth-secrets.json",
    allowRuntimeSessionRead: true
  });
  assert.equal(secret.ok, false);
  assert.match(secret.error, /OAuth secrets/);

  const searched = await searchProjectText({
    outputDir: sessionProject,
    query: "L3-042 recovered",
    allowRuntimeSessionRead: true
  });
  assert.equal(searched.ok, true, searched.error);
  assert.equal(searched.matches.some((match) => match.text.includes("L3-042 recovered")), true);

  const writeBlocked = await writeProjectFile({
    outputDir: sessionProject,
    relativePath: ".translation-workshop/agent/pi-child-sessions/workspace/history.jsonl",
    content: "nope"
  });
  assert.equal(writeBlocked.ok, false);
  assert.match(writeBlocked.error, /cannot be written/);
} finally {
  await rm(sessionRoot, { recursive: true, force: true });
}

console.log("ok parent can read Pi session history while children and secrets stay blocked");
