import assert from "node:assert/strict";

import { matchFolderFiles, matchTranslationSource } from "../../src/shared/core/folderMatch.ts";

const matches = matchFolderFiles(
  [
    { name: "scene.txt", relativePath: "route-a/scene.txt", path: "source/route-a/scene.txt", lineCount: 2 },
    { name: "scene.txt", relativePath: "route-b/scene.txt", path: "source/route-b/scene.txt", lineCount: 3 }
  ],
  [
    { name: "scene.txt", relativePath: "route-a/scene.txt", path: "translation/route-a/scene.txt", lineCount: 2 },
    { name: "scene.txt", relativePath: "route-b/scene.txt", path: "translation/route-b/scene.txt", lineCount: 3 }
  ]
);

assert.deepEqual(matches.map((match) => ({
  sourceName: match.sourceName,
  translationPath: match.translationPath,
  status: match.status
})), [
  {
    sourceName: "route-a/scene.txt",
    translationPath: "translation/route-a/scene.txt",
    status: "matched"
  },
  {
    sourceName: "route-b/scene.txt",
    translationPath: "translation/route-b/scene.txt",
    status: "matched"
  }
]);

const epubSource = {
  name: "book.epub",
  relativePath: "nested/book.epub",
  path: "source/nested/book.epub",
  lineCount: 2
};
assert.equal(matchTranslationSource("nested/book.txt", [epubSource]), epubSource);
assert.equal(matchTranslationSource("nested/book_translated.txt", [epubSource]), epubSource);
assert.equal(matchTranslationSource("nested/book.translated.txt", [epubSource]), epubSource);

const unicodePunctuationSource = {
  name: "第#二章 — Café.epub",
  relativePath: "卷二/第#二章 — Café.epub",
  path: "source/卷二/第#二章 — Café.epub",
  lineCount: 1
};
assert.equal(
  matchTranslationSource("卷二\\第#二章 — CAFÉ_TRANSLATED.TXT", [unicodePunctuationSource]),
  unicodePunctuationSource
);

const slashCaseSource = {
  name: "Chapter.TXT",
  relativePath: "Route/Chapter.TXT",
  path: "source/Route/Chapter.TXT",
  lineCount: 1
};
assert.equal(matchTranslationSource("route\\chapter.txt", [slashCaseSource]), slashCaseSource);

const sameBasenameSources = [
  { name: "scene.epub", relativePath: "route-a/scene.epub", path: "source/route-a/scene.epub", lineCount: 1 },
  { name: "scene.epub", relativePath: "route-b/scene.epub", path: "source/route-b/scene.epub", lineCount: 1 }
];
assert.equal(matchTranslationSource("route-b/scene.txt", sameBasenameSources), sameBasenameSources[1]);
assert.equal(matchTranslationSource("scene.txt", sameBasenameSources), undefined);

const suffixedSource = {
  name: "chapter_translated.epub",
  relativePath: "nested/chapter_translated.epub",
  path: "source/nested/chapter_translated.epub",
  lineCount: 1
};
assert.equal(matchTranslationSource("nested/chapter_translated.txt", [suffixedSource]), suffixedSource);
assert.equal(matchTranslationSource("nested/chapter_translated_translated.txt", [suffixedSource]), suffixedSource);

assert.throws(
  () => matchTranslationSource("nested/book.txt", [
    epubSource,
    { name: "book.pdf", relativePath: "nested/book.pdf", path: "source/nested/book.pdf", lineCount: 2 }
  ]),
  /ambiguous/i
);
assert.throws(
  () => matchTranslationSource("nested/book_translated.txt", [
    epubSource,
    { name: "book_translated.epub", relativePath: "nested/book_translated.epub", path: "source/nested/book_translated.epub", lineCount: 2 }
  ]),
  /ambiguous/i
);

assert.throws(
  () => matchFolderFiles([epubSource], [
    { name: "book.txt", relativePath: "nested/book.txt", path: "translation/nested/book.txt", lineCount: 2 },
    { name: "book_translated.txt", relativePath: "nested/book_translated.txt", path: "translation/nested/book_translated.txt", lineCount: 2 }
  ]),
  /ambiguous/i
);

const exactTxtSource = {
  name: "book.txt",
  relativePath: "nested/book.txt",
  path: "source/nested/book.txt",
  lineCount: 2
};
const exactTxtAndEpub = [epubSource, exactTxtSource];
assert.equal(matchTranslationSource("nested/book.txt", exactTxtAndEpub), exactTxtSource);

const epubTextPair = matchFolderFiles([epubSource], [
  { name: "book_translated.txt", relativePath: "nested/book_translated.txt", path: "translation/nested/book_translated.txt", lineCount: 2 }
]);
assert.equal(epubTextPair[0].translationPath, "translation/nested/book_translated.txt");
assert.equal(epubTextPair[0].status, "matched");

const exactMismatch = matchFolderFiles([exactTxtSource], [
  { name: "book.txt", relativePath: "nested/book.txt", path: "translation/nested/book.txt", lineCount: 3 }
]);
assert.equal(exactMismatch[0].status, "line-count-mismatch");

const absentTarget = matchFolderFiles([epubSource], [
  { name: "other.txt", relativePath: "nested/other.txt", path: "translation/nested/other.txt", lineCount: 2 }
]);
assert.equal(absentTarget[0].status, "missing-translation");

console.log("folderMatch tests passed");
