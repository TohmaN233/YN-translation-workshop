import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import extractZip from "extract-zip";
import { load } from "cheerio";

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
      { path: "EPUB/chapter.xhtml", data: Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="chapter-start"><span class="koboSpan" id="ncx-target">第一章</span></h1></body></html>') },
      { path: "EPUB/toc.ncx", data: Buffer.from('<ncx><navMap><navPoint id="point"><navLabel><text>Independent navigation label</text></navLabel><content src="chapter.xhtml#ncx-target"/></navPoint></navMap></ncx>') }
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
    assert.equal(load(toc, { xml: true })("a").text(), "第一章（译）");
    assert.match(chapter, /id="chapter-start"/);
    assert.equal(load(chapter, { xml: true })("h1#chapter-start").text(), "第一章（正文）");
    assert.equal(load(chapter, { xml: true })("#ncx-target").length, 1, "NCX-only referenced location survives export");
    const manuallyEdited = Buffer.from('Manually customized export must survive the next export.');
    await writeFile(result.outputPath, manuallyEdited);
    const next = await createTranslatedEpub({ templatePath, translatedLines: ["更新目录", "更新正文"], workspaceDir: path.join(root, "workspace"), outputDir });
    assert.notEqual(next.outputPath, result.outputPath);
    assert.deepEqual(await readFile(result.outputPath), manuallyEdited);
    await assert.rejects(createTranslatedEpub({ templatePath, translatedLines: ["missing paragraph"], workspaceDir: path.join(root, "workspace"), outputDir }), /line count mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
