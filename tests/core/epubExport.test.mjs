import { strict as assert } from "node:assert";

import { buildTranslatedEpubTextFiles } from "../../src/shared/core/epubExport.ts";

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

const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>`;
const packageOpf = `<?xml version="1.0"?><package><manifest><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="title"/></spine></package>`;

await test("EPUB translation preserves title-page jump anchors and fragment targets", () => {
  const titlePage = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p id="start-link"><a class="title-jump" href="chapter-01.xhtml#chapter-start"><span>第一章</span></a></p></body></html>`;
  const result = buildTranslatedEpubTextFiles({
    "META-INF/container.xml": container,
    "EPUB/package.opf": packageOpf,
    "EPUB/title.xhtml": titlePage
  }, ["第一章（译）"]);
  const translated = result.files["EPUB/title.xhtml"];

  assert.match(translated, /id="start-link"/);
  assert.match(translated, /class="title-jump"/);
  assert.match(translated, /href="chapter-01\.xhtml#chapter-start"/);
  assert.match(translated, /<a[^>]*><span>第一章（译）<\/span><\/a>/);
  assert.doesNotMatch(translated, /<p id="start-link">第一章（译）<\/p>/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
