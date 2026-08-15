import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import extractZip from "extract-zip";

import { createTranslatedEpub } from "../../src/main/epubWriter.ts";
import { createZipBuffer } from "../../src/main/zipWriter.ts";

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

await test("exported EPUB keeps title navigation links clickable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-epub-export-"));
  const templatePath = path.join(root, "vertical-book.epub");
  const outputDir = path.join(root, "output");
  const extractedDir = path.join(root, "extracted");
  try {
    await mkdir(outputDir, { recursive: true });
    const zip = createZipBuffer([
      { path: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
      { path: "META-INF/container.xml", data: Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>') },
      { path: "EPUB/package.opf", data: Buffer.from('<?xml version="1.0"?><package><manifest><item id="toc" href="toc.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="toc"/><itemref idref="chapter"/></spine></package>') },
      { path: "EPUB/toc.xhtml", data: Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>　　　　<a href="chapter.xhtml#chapter-start">第一章</a></p></body></html>') },
      { path: "EPUB/chapter.xhtml", data: Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="chapter-start">第一章</h1></body></html>') }
    ]);
    await writeFile(templatePath, zip);

    const result = await createTranslatedEpub({
      templatePath,
      translatedLines: ["第一章（译）", "第一章（正文）"],
      workspaceDir: path.join(root, "workspace"),
      outputDir
    });
    await extractZip(result.outputPath, { dir: extractedDir });
    const toc = await readFile(path.join(extractedDir, "EPUB", "toc.xhtml"), "utf8");
    const chapter = await readFile(path.join(extractedDir, "EPUB", "chapter.xhtml"), "utf8");

    assert.match(toc, /href="chapter\.xhtml#chapter-start"/);
    assert.match(toc, /<a[^>]*>第一章（译）<\/a>/);
    assert.match(chapter, /id="chapter-start"/);
    assert.match(chapter, />第一章（正文）<\/h1>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
