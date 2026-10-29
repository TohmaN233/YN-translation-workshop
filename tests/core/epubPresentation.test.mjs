import assert from "node:assert/strict";
import { load } from "cheerio";

import { normalizeTranslatedEpubPresentation } from "../../src/shared/core/epubPresentation.ts";

const sourceFiles = {
  "META-INF/container.xml": "<container><rootfiles><rootfile full-path=\"Package/book.opf\"/></rootfiles></container>",
  "Package/book.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:rendition="http://www.idpf.org/vocab/rendition/#">
  <metadata><dc:language>en</dc:language></metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" properties="scripted nav"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml" properties="rendition:scripted scripted"/>
    <item id="kobo-script" href="kobo0001.js" media-type="text/javascript"/>
    <item id="reader-script" href="reader.js" media-type="text/javascript"/>
    <item id="style" href="styles/book.css" media-type="text/css"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="chapter" properties="page-spread-left rendition:page-spread-right rendition:flow-paginated"/>
    <itemref idref="chapter2" properties="rendition:page-spread-left page-spread-right rendition:spread-none"/>
  </spine>
</package>`,
  "Package/chapter.xhtml": `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="ja" xml:lang="ja" class="vrtl epub" style="color: navy; writing-mode: vertical-rl; direction: rtl">
  <head><title>Sample page</title><style>body { margin: 0; -epub-writing-mode: vertical-rl; color: navy; } .tcy { -epub-text-combine: horizontal; color: red; }</style></head>
  <body style="font-family: serif; -webkit-writing-mode: vertical-rl; text-orientation: upright" dir="rtl">
    <p class="story tcy upright" style="margin: 1em; text-combine-upright: all">Synthetic paragraph</p>
    <p class="chapter-title" style="text-align: center">Centered title</p>
    <p class="center-layout">Title centered by an external rule</p>
    <p class="divider">* * *</p>
    <p class="chapter-title">Heading styled as a paragraph</p>
    <p><img src="image.png" alt="Synthetic image"/></p>
    <p><ruby id="ruby-anchor">字<rp>(</rp><rt>ji</rt><rp>)</rp></ruby> and <a href="#kobo-anchor">a local link</a><span class="koboSpan" id="kobo-anchor">linked target</span><span class="koboSpan" id="ncx-anchor">NCX target</span><span class="koboSpan" id="unused-marker"></span></p>
    <p id="section-number">2</p>
    <script src="kobo0001.js"></script>
  </body>
</html>`,
  "Package/chapter2.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second page</title></head><body><p>Second synthetic paragraph</p><script src="reader.js"></script></body></html>`,
  "Package/styles/book.css": `body { -epub-writing-mode: vertical-rl; color: navy; } .upright { text-orientation: upright; font-weight: bold; } p { margin: 0; text-indent: 0 !important; } .story { text-indent: 0 !important; } .center-layout { text-align: center; }`,
  "Package/kobo0001.js": "window.koboLocationRuntime = true;",
  "Package/toc.ncx": `<ncx><navMap><navPoint><content src="chapter.xhtml#ruby-anchor"/><content src="chapter.xhtml#ncx-anchor"/></navPoint></navMap></ncx>`,
  "Package/reader.js": "window.readerFeature = true;",
  "Package/image.png": "synthetic-image-bytes"
};

const normalized = normalizeTranslatedEpubPresentation(sourceFiles, "zh-Hans");

assert.notEqual(normalized, sourceFiles, "returns a new archive record");
assert.match(sourceFiles["Package/chapter.xhtml"], /writing-mode: vertical-rl/, "does not mutate input files");
assert.equal(normalized["Package/image.png"], "synthetic-image-bytes", "preserves unrelated archive assets");
assert.equal(normalized["Package/reader.js"], sourceFiles["Package/reader.js"], "preserves unrelated script files");

const chapter = load(normalized["Package/chapter.xhtml"], { xmlMode: true });
const html = chapter("html").first();
const body = chapter("body").first();
assert.equal(html.attr("lang"), "zh-Hans");
assert.equal(html.attr("xml:lang"), "zh-Hans");
assert.equal(html.attr("dir"), "ltr");
assert.equal(html.attr("class"), "hltr epub", "replaces the vertical-layout class and preserves other classes");
assert.equal(body.attr("dir"), "ltr");
assert.match(html.attr("style"), /writing-mode:\s*horizontal-tb/i);
assert.match(html.attr("style"), /direction:\s*ltr/i);
assert.match(body.attr("style"), /-webkit-writing-mode:\s*horizontal-tb/i);
assert.match(body.attr("style"), /font-family:\s*serif/i);
assert.doesNotMatch(body.attr("style"), /text-orientation|text-combine-upright/i);

const storyParagraph = chapter("p.story").first();
assert.doesNotMatch(chapter('#section-number').attr('style') ?? '', /text-indent/);
assert.equal(storyParagraph.text(), "Synthetic paragraph");
assert.deepEqual(storyParagraph.attr("class").split(/\s+/), ["story"], "removes only vertical-only classes");
assert.match(storyParagraph.attr("style"), /margin:\s*1em/i);
assert.match(storyParagraph.attr("style"), /text-indent:\s*2em\s*!important/i, "inline indent overrides vertical Japanese CSS");
assert.doesNotMatch(storyParagraph.attr("style"), /text-combine-upright/i);
assert.doesNotMatch(chapter.html(), /<rt\b|<rp\b|<ruby\b|koboSpan|unused-marker|kobo\.js/i);
assert.match(chapter("p").eq(6).text(), /字/);
assert.match(chapter("p").eq(6).text(), /linked target.*NCX target/);
assert.equal(chapter("p").eq(6).find("a[href='#kobo-anchor']").length, 1, "keeps the local link");
assert.equal(chapter("a#kobo-anchor").length, 1, "keeps a target anchor when a link refers to a Kobo location");
assert.equal(chapter("a#ncx-anchor").length, 1, "keeps a Kobo location referenced by NCX");
assert.equal(chapter("a#ruby-anchor").length, 1, "keeps a ruby target referenced by NCX");
assert.equal(chapter("p").eq(1).attr("style"), "text-align: center", "does not indent centered titles");
assert.equal(chapter("p").eq(2).attr("style"), undefined, "does not indent titles centered by CSS");
assert.equal(chapter("p").eq(3).attr("style"), undefined, "does not indent separators");
assert.equal(chapter("p").eq(4).attr("style"), undefined, "does not indent title paragraphs");
assert.equal(chapter("p").eq(5).attr("style"), undefined, "does not indent image-only paragraphs");
assert.equal(chapter("body script").length, 0, "removes Kobo-specific scripts");

const chapter2 = load(normalized["Package/chapter2.xhtml"], { xmlMode: true });
assert.equal(chapter2("body script[src='reader.js']").length, 1, "keeps unrelated scripts");
assert.match(chapter2("p").attr("style"), /text-indent:\s*2em/i);

const stylesheet = normalized["Package/styles/book.css"];
assert.match(stylesheet, /writing-mode:\s*horizontal-tb/i);
assert.match(stylesheet, /color:\s*navy/i);
assert.match(stylesheet, /font-weight:\s*bold/i);
assert.doesNotMatch(stylesheet, /text-orientation|text-combine|vertical-rl/i);

const protectedCssSource = `p::before { content: "{writing-mode: vertical-rl;}"; /* ignored; direction: rtl; */ color: navy; } .layout { writing-mode: vertical-rl; direction: rtl; }`;
const protectedCss = normalizeTranslatedEpubPresentation({ "styles.css": protectedCssSource }, "en")["styles.css"];
assert.equal(protectedCss, `p::before { content: "{writing-mode: vertical-rl;}"; /* ignored; direction: rtl; */ color: navy; } .layout { writing-mode: horizontal-tb; direction: ltr; }`, "does not rewrite declarations inside CSS strings or comments");

const opf = load(normalized["Package/book.opf"], { xmlMode: true });
assert.equal(opf("dc\\:language").text(), "zh-Hans");
assert.equal(opf("spine").attr("page-progression-direction"), "ltr");
assert.equal(opf("itemref").eq(0).attr("properties"), "rendition:flow-paginated");
assert.equal(opf("itemref").eq(1).attr("properties"), "rendition:spread-none");
assert.equal(opf("item#chapter").attr("properties"), "nav", "drops scripted only after the document has no scripts");
assert.equal(opf("item#chapter2").attr("properties"), "rendition:scripted scripted", "retains scripted while an unrelated script remains");

const english = normalizeTranslatedEpubPresentation({
  "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p style="margin: 0">No indent expected</p></body></html>`
}, "en");
assert.equal(load(english["chapter.xhtml"], { xmlMode: true })("p").attr("style"), "margin: 0");

const cleanupOnly = normalizeTranslatedEpubPresentation({
  "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" lang="ja"><head/><body style="writing-mode: vertical-rl"><p><ruby>字<rt>ji</rt></ruby></p></body></html>`,
  "book.opf": `<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest/><spine/></package>`
}, "");
const cleanupDocument = load(cleanupOnly["chapter.xhtml"], { xmlMode: true });
assert.equal(cleanupDocument("html").attr("lang"), "ja", "empty language leaves existing document language alone");
assert.equal(cleanupDocument("body").attr("dir"), "ltr", "empty language still normalizes presentation");
assert.match(cleanupDocument("p").text(), /字/);
assert.equal(load(cleanupOnly["book.opf"], { xmlMode: true })("dc\\:language").length, 0, "empty language does not invent package metadata");

const packageWithLanguage = normalizeTranslatedEpubPresentation({
  "book.opf": `<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest/><spine/></package>`
}, "fr");
const translatedPackage = load(packageWithLanguage["book.opf"], { xmlMode: true });
assert.equal(translatedPackage("dc\\:language").text(), "fr", "adds dc:language when a package has no language entry");

const arabic = normalizeTranslatedEpubPresentation({
  "book.opf": `<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>en</dc:language></metadata><manifest/><spine page-progression-direction="ltr"/></package>`,
  "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" style="writing-mode: vertical-rl; direction: ltr"><head/><body style="direction: ltr" dir="ltr"><p>Neutral sample</p></body></html>`,
  "styles.css": `html, body { writing-mode: vertical-rl; direction: ltr; color: navy; }`
}, "ar");
const arabicDocument = load(arabic["chapter.xhtml"], { xmlMode: true });
assert.equal(arabicDocument("html").attr("dir"), "rtl");
assert.equal(arabicDocument("body").attr("dir"), "rtl");
assert.match(arabicDocument("html").attr("style"), /writing-mode:\s*horizontal-tb/i);
assert.match(arabicDocument("html").attr("style"), /direction:\s*rtl/i);
assert.match(arabic["styles.css"], /direction:\s*rtl/i);
assert.equal(load(arabic["book.opf"], { xmlMode: true })("spine").attr("page-progression-direction"), "rtl");

const compoundCenter = normalizeTranslatedEpubPresentation({
  "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" class="vrtl"><head/><body><div class="main"><p>Ordinary synthetic narrative</p><p class="center-layout">A centered synthetic title</p></div></body></html>`,
  "styles.css": `.vrtl .main { text-align: center; } .hltr .center-layout { text-align: center; } .hltr .main { text-align: left; }`
}, "zh-Hans");
const compoundDocument = load(compoundCenter["chapter.xhtml"], { xmlMode: true });
assert.match(compoundDocument("p").first().attr("style"), /text-indent:\s*2em/i, "does not treat ancestor layout classes as centered paragraphs");
assert.equal(compoundDocument("p").last().attr("style"), undefined, "still excludes the centered descendant");

console.log("epubPresentation tests passed");
const namespaced = normalizeTranslatedEpubPresentation({
  'chapter.xhtml':'<html><body><p>Independent namespace-selector sample.</p></body></html>',
  'book.css':'body{} *[epub|type~="chapter"] { text-align:center; } svg|text { text-align:center; }'
},'zh-CN');
assert.equal(load(namespaced['chapter.xhtml'],{xml:true})('p').text(),'Independent namespace-selector sample.');
const typographicHeading=normalizeTranslatedEpubPresentation({
  'chapter.xhtml':'<html><body><p class="large-type">Synthetic chapter heading</p><p>Ordinary narrative paragraph.</p></body></html>',
  'book.css':'.large-type { font-size: 130%; } p {text-indent:0}'
},'zh-CN');
const typography=load(typographicHeading['chapter.xhtml'],{xml:true});
assert.doesNotMatch(typography('.large-type').attr('style')??'',/text-indent/);
assert.match(typography('p').last().attr('style'),/text-indent: 2em/);
