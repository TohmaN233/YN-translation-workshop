import { strict as assert } from "node:assert";
import {
  discoverCandidateArtifacts,
  isCandidateTranslationTxt,
  candidateBasename,
  matchCandidateToSource
} from "../../src/main/agent/artifactDiscovery.ts";

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

await test("isCandidateTranslationTxt accepts *_translated.txt", () => {
  assert.equal(isCandidateTranslationTxt("chapter03_translated.txt"), true);
  assert.equal(isCandidateTranslationTxt("chapter03.txt"), true);
});

await test("isCandidateTranslationTxt rejects glossary/state/workspace files", () => {
  assert.equal(isCandidateTranslationTxt("glossary.json"), false);
  assert.equal(isCandidateTranslationTxt("glossary.txt"), false);
  assert.equal(isCandidateTranslationTxt("character_bible.txt"), false);
  assert.equal(isCandidateTranslationTxt("TRANSLATION_STATE.txt"), false);
  assert.equal(isCandidateTranslationTxt("readme.txt"), false);
  assert.equal(isCandidateTranslationTxt("chapter03.md"), false);
});

await test("candidateBasename strips _translated suffix and extension", () => {
  assert.equal(candidateBasename("chapter03_translated.txt"), "chapter03");
  assert.equal(candidateBasename("chapter03.txt"), "chapter03");
  assert.equal(candidateBasename("chapter03.translated.txt"), "chapter03");
});

await test("matchCandidateToSource matches by basename", () => {
  const candidate = { path: "/p/AI_translation/ch03_translated.txt", basename: "ch03", size: 100, modifiedAt: "t", directory: "/p/AI_translation" };
  const sources = [
    { path: "/p/source/ch03.txt", basename: "ch03" },
    { path: "/p/source/ch04.txt", basename: "ch04" }
  ];
  const result = matchCandidateToSource(candidate, sources);
  assert.equal(result.sourcePath, "/p/source/ch03.txt");
  assert.equal(result.sourceBasename, "ch03");
});

await test("EPUB-safe extracted basename matches its translated artifact", () => {
  const candidate = {
    path: "/p/AI_translation/__translated.txt",
    basename: candidateBasename("__translated.txt"),
    size: 100,
    modifiedAt: "t",
    directory: "/p/AI_translation"
  };
  const result = matchCandidateToSource(candidate, [
    { path: "/p/.translation-workshop/extracted-text/hash/source/_.txt", basename: "_" }
  ]);
  assert.equal(result.sourcePath, "/p/.translation-workshop/extracted-text/hash/source/_.txt");
});

await test("matchCandidateToSource falls back to prefix match", () => {
  const candidate = { path: "/p/AI_translation/ch03_translated.txt", basename: "ch03", size: 100, modifiedAt: "t", directory: "/p/AI_translation" };
  const sources = [{ path: "/p/source/ch03_intro.txt", basename: "ch03_intro" }];
  const result = matchCandidateToSource(candidate, sources);
  assert.equal(result.sourcePath, "/p/source/ch03_intro.txt");
});

await test("matchCandidateToSource returns candidate without source when no match", () => {
  const candidate = { path: "/p/AI_translation/unknown_translated.txt", basename: "unknown", size: 100, modifiedAt: "t", directory: "/p/AI_translation" };
  const result = matchCandidateToSource(candidate, [{ path: "/p/source/ch03.txt", basename: "ch03" }]);
  assert.equal(result.sourcePath, undefined);
  assert.equal(result.basename, "unknown");
});

await test("discoverCandidateArtifacts scans AI_translation first, newest first", () => {
  const listing = [
    {
      directory: "/proj/AI_translation",
      entries: [
        { name: "ch01_translated.txt", isFile: true, size: 10, modifiedAt: "2026-01-01T00:00:00Z" },
        { name: "ch02_translated.txt", isFile: true, size: 20, modifiedAt: "2026-02-01T00:00:00Z" },
        { name: "glossary.json", isFile: true, size: 5, modifiedAt: "2026-03-01T00:00:00Z" },
        { name: "notes.txt", isFile: true, size: 3, modifiedAt: "2026-01-15T00:00:00Z" }
      ]
    }
  ];
  const result = discoverCandidateArtifacts("/proj", listing, []);
  assert.equal(result.length, 3);
  // newest modifiedAt first: ch02 (2026-02-01) > notes (2026-01-15) > ch01 (2026-01-01)
  assert.equal(result[0].basename, "ch02");
  assert.equal(result[1].basename, "notes");
  assert.equal(result[2].basename, "ch01");
});

await test("discoverCandidateArtifacts dedupes the same path listed twice", () => {
  const sameDir = "/proj/AI_translation";
  const listing = [
    { directory: sameDir, entries: [{ name: "ch01_translated.txt", isFile: true, size: 10, modifiedAt: "2026-02-01T00:00:00Z" }] },
    { directory: sameDir, entries: [{ name: "ch01_translated.txt", isFile: true, size: 10, modifiedAt: "2026-02-01T00:00:00Z" }] }
  ];
  const result = discoverCandidateArtifacts("/proj", listing, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].basename, "ch01");
});

await test("discoverCandidateArtifacts ignores project-root txt files", () => {
  // Only Agent-generated files under AI_translation are candidates. Root TXT
  // files are usually source or human target files and must not be auto-detected.
  const listing = [
    { directory: "/proj/AI_translation", entries: [{ name: "ch01_translated.txt", isFile: true, size: 10, modifiedAt: "2026-02-01T00:00:00Z" }] },
    { directory: "/proj", entries: [{ name: "ch01_translated.txt", isFile: true, size: 9, modifiedAt: "2026-01-01T00:00:00Z" }] }
  ];
  const result = discoverCandidateArtifacts("/proj", listing, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/proj/AI_translation/ch01_translated.txt");
});

await test("discoverCandidateArtifacts ignores non-file entries", () => {
  const listing = [
    {
      directory: "/proj/AI_translation",
      entries: [{ name: "subfolder", isFile: false, size: 0, modifiedAt: "t" }]
    }
  ];
  const result = discoverCandidateArtifacts("/proj", listing, []);
  assert.equal(result.length, 0);
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
