import assert from 'node:assert/strict';
import { xhtmlToLines, extractEpubTextFromArchive } from '../../src/shared/core/epubText.ts';
import { buildTranslatedEpubTextFiles } from '../../src/shared/core/epubExport.ts';
import { legacyEpubLines } from '../../src/shared/core/epubLegacyProjection.ts';
import { load } from 'cheerio';
const files = {
 'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>',
 'EPUB/package.opf': '<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
 'EPUB/one.xhtml': '<html><head><title>not body</title><script>never translate</script></head><body><!-- <p>invisible notice</p>\ncomment tail --><h1 id="a">Chapter A</h1><div>Direct text</div><p><ruby>Base<rt>reading</rt></ruby> and <span>words</span><br/>Second line</p><p hidden="hidden">Invisible</p><p>Wrapped\n source</p></body></html>',
 'EPUB/two.xhtml': '<html><body><h2>Chapter B</h2><p>Final paragraph</p></body></html>'
};
const expected=['Chapter A','Direct text','Base and words','Second line','Wrapped source','Chapter B','Final paragraph'];
assert.deepEqual(xhtmlToLines(files['EPUB/one.xhtml']),expected.slice(0,5),'extract only rendered body units; XML wrapping is not a paragraph');
assert.equal(extractEpubTextFromArchive(files),expected.join('\n'));
const target=expected.map((_,i)=>`译文段落${i+1}`);
const result=buildTranslatedEpubTextFiles(files,target);
assert.equal(extractEpubTextFromArchive(result.files),target.join('\n'),'every translated unit must return to its own position across documents and br');
assert.match(result.files['EPUB/one.xhtml'],/id="a"/);
assert.throws(()=>buildTranslatedEpubTextFiles(files,target.slice(1)),/count|数量|lines/i,'never silently export a partially mapped translation');
assert.throws(()=>buildTranslatedEpubTextFiles(files,[...target,'extra']),/count|数量|lines/i);
console.log('ok EPUB visible body mapping, cross-document writeback and strict coverage');
const legacyFiles={...files,'EPUB/one.xhtml':'<html><body><!--\n<p>Secret notice</p>\nHidden footer\n-->\n<h1>Same</h1>\n<p><ruby>Same<rt>sound</rt></ruby> sentence</p>\n<p>Same</p></body></html>'};
const legacySource=['EPUB/one.xhtml','EPUB/two.xhtml'].flatMap(p=>legacyEpubLines(legacyFiles[p]).map(line=>line.text));
const legacyTargets=legacySource.map((_,i)=>`历史译文${i+1}`);
const migrated=buildTranslatedEpubTextFiles(legacyFiles,legacyTargets,{},legacySource);
assert.deepEqual(extractEpubTextFromArchive(migrated.files).split('\n'),legacyTargets.slice(3));
assert.equal(migrated.ignoredLegacyLines,3);
assert.throws(()=>buildTranslatedEpubTextFiles(legacyFiles,legacyTargets,{},legacySource.map((v,i)=>i===3?'different source':v)),/source projection/);
console.log('ok legacy mapping uses source offsets, excludes comment-only rows and rejects changed source');
const linkFiles={...files,'EPUB/one.xhtml':'<html><body><p>Read <a href="two.xhtml#next">chapter link</a></p></body></html>'};
const linked=buildTranslatedEpubTextFiles(linkFiles,['译文链接','标题','结尾']);
assert.equal(load(linked.files['EPUB/one.xhtml'],{xml:true})('a[href]').text(),'译文链接','translated navigation remains clickable after prefix text');
const pairFiles={...files,'EPUB/one.xhtml':'<html><body><p>Old A</p><p>Source A</p></body></html>','EPUB/two.xhtml':'<html><body><p>Old B</p><p>Source B</p></body></html>'};
const pairOptions={mode:'pair-position',replacePosition:1,pairSize:2};
assert.throws(()=>buildTranslatedEpubTextFiles(pairFiles,['New A','New B'],pairOptions,['Source B','Source A']),/source projection/);
const paired=buildTranslatedEpubTextFiles(pairFiles,['New A','New B'],pairOptions,['Source A','Source B']);
assert.equal(extractEpubTextFromArchive(paired.files),'New A\nSource A\nNew B\nSource B');
assert.throws(()=>buildTranslatedEpubTextFiles({...pairFiles,'EPUB/two.xhtml':'<html><body><p>unpaired</p></body></html>'},['one','two'],pairOptions),/complete.*pair/i);
console.log('ok linked labels and paired source identity remain intact');
