import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts,beginText,endText,setFontAndSize,moveText,showText,beginMarkedContent,endMarkedContent} from 'pdf-lib';
import {preparePdfDocument,readPdfLayout,createTranslatedPdf,pdfReferencesForRange,assertPdfProtectedWrite} from '../src/main/pdfDocuments.ts';
import {writeTranslationChunk,prepareTranslationStagingCandidate} from '../src/main/agent/writeTranslationChunk.ts';
import {validateTranslationCandidate} from '../src/shared/validation/translationValidator.ts';
import {validateProofreadReplacement} from '../src/shared/validation/proofreadReplacement.ts';
import {buildCandidateImportPlan} from '../src/main/agent/importCandidate.ts';
import {renderLineReviewHtml,LINE_REVIEW_PROTOCOL_VERSION} from '../src/shared/core/html.ts';
import {writeReviewHtml,readReviewHtml} from '../src/main/reviewHtmlPortability.ts';
import {upgradeLegacyReviewHtmlTree} from '../src/main/reviewHtmlUpgrade.ts';
import {pdfProtectionHash} from '../src/main/pdfTypes.ts';
import {encodeProjectPaths} from '../src/main/projectPaths.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-paragraph-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([600,800]);
  page.drawText('(1) This list item has a complete first line before a hanging',{x:40,y:740,size:12,font});
  page.drawText('indent continues the body and completes the paragraph.',{x:58,y:722,size:12,font});
  const key=page.node.newFontDictionary(font.name,font.ref);
  page.pushOperators(beginText(),setFontAndSize(key,12),moveText(40,660),showText(font.encodeText('The energy ')),
    beginMarkedContent('Formula'),showText(font.encodeText('x + y')),endMarkedContent(),showText(font.encodeText(' relates to ')),
    beginMarkedContent('Formula'),showText(font.encodeText('z + w')),endMarkedContent(),showText(font.encodeText(' in the described experiment.')),endText());
  page.drawText('Its explanation continues as part of the same paragraph.',{x:40,y:642,size:12,font});
  page.pushOperators(beginMarkedContent('Code'));page.drawText('const value = 1; // preserve this',{x:40,y:570,size:10,font});page.pushOperators(endMarkedContent());
  const original=path.join(root,'paragraph.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const layout=await readPdfLayout(prepared.sourcePath,root);
  assert.equal(layout.blocks.length,3);assert.ok(layout.blocks[0].text.endsWith('paragraph.'));
  const block=layout.blocks[1];assert.equal(block.inlineProtections.length,2);assert.equal(block.proseSegments.length,3);
  assert.ok(block.text.endsWith('same paragraph.'));
  const [a,b]=block.inlineProtections.map(node=>node.token),translated=`能量 ${a} 关联 ${b}，这是实验中的解释，同一段落还包含后续说明。`;
  const refs=await pdfReferencesForRange(prepared.sourcePath,root,2,2);
  assert.deepEqual(refs.inlineProtections.map(node=>node.text),['x + y','z + w']);assert.equal(refs.protectedLines.length,0);
  const entries=layout.blocks.map(row=>row.protection?{line:row.line,text:row.text}:{line:row.line,text:row.line===2?translated:'（1）这是完整的列表项，悬挂缩进的后续正文与首行合并。'});
  const options={languagePair:'en->zh-CN',pdfProtectedLines:[{line:3,kind:'code',text:layout.blocks[2].text}]};
  assert.equal(validateTranslationCandidate(prepared.text,entries.map(e=>e.text).join('\n'),options).ok,true);
  const staged=await prepareTranslationStagingCandidate({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'paragraph.pdf',subagentId:'fixture',sessionId:'fixture',assignmentId:'fixture'});
  const staging=(await readFile(staged,'utf8')).split('\n');assert.equal(staging[1],'','an inline paragraph is unfinished, never a marker-only completed skeleton');
  for(const bad of [translated.replace(a,''),translated.replace(a,b),translated.replace(a,'TEMP').replace(b,a).replace('TEMP',b),a+b]) {
    await assert.rejects(assertPdfProtectedWrite(prepared.sourcePath,root,[{line:2,text:bad}]),/PDF L2/);
    await assert.rejects(writeTranslationChunk({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'paragraph.pdf',fromLine:2,toLine:2,lines:[bad]}),/PDF L2/);
    assert.ok(validateProofreadReplacement(block.text,bad,{},2).some(f=>f.code==='pdf_protected_content_mismatch'));
    const candidate=entries.map(e=>e.line===2?bad:e.text).join('\n');assert.equal(buildCandidateImportPlan(prepared.text,candidate,'zh-CN','en->zh-CN').ok,false);
  }
  const html=path.join(root,'.translation-workshop','html','paragraph.html');await mkdir(path.dirname(html),{recursive:true});
  await writeReviewHtml(html,renderLineReviewHtml({title:'PDF paragraphs',sourceText:prepared.text,translationText:entries.map(e=>e.text).join('\n'),workflow:{sourcePath:original,validationSourcePath:prepared.sourcePath,outputDir:root}}));
  let data=JSON.parse((await readReviewHtml(html)).match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]);assert.equal(data.rows[1].pdfInlineProtections.length,2);
  await writeFile(html,(await readFile(html,'utf8')).replace(`translation-workshop-line-review-v${LINE_REVIEW_PROTOCOL_VERSION}`,'translation-workshop-line-review-v52'));
  await upgradeLegacyReviewHtmlTree(html);data=JSON.parse((await readReviewHtml(html)).match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]);assert.equal(data.rows[1].pdfInlineProtections.length,2);
  if(process.versions.electron) {
    const {BrowserWindow}=await import('electron');const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
    try {await window.loadFile(html);const actual=await window.webContents.executeJavaScript(`(()=>{const row=document.querySelector('[data-line="2"]');return {count:row.querySelectorAll('.target .pdf-inline').length,text:row.querySelector('.target').textContent,editable:row.querySelector('.target .pdf-inline').contentEditable,visible:document.querySelector('.pdf-inline').dataset.label};})()`);
      assert.equal(actual.count,2);assert.equal(actual.text,translated);assert.equal(actual.editable,'false');assert.ok(actual.visible.includes('+'));assert.equal(window.isVisible(),false);
    } finally {window.close();}
  }
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:entries.map(e=>e.text)});
  const bytes=await readFile(exported.outputPath);
  await assert.rejects(createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:entries.map(e=>e.line===2?translated.replace(a,''):e.text)}),/markers/);
  assert.deepEqual(await readFile(exported.outputPath),bytes);
  const savedMap=await readFile(prepared.sourcePath+'.pdf-layout.json');const old={...layout,version:2};old.protectionHash=pdfProtectionHash(old);
  await writeFile(prepared.sourcePath+'.pdf-layout.json',JSON.stringify(encodeProjectPaths(old,root)));await assert.rejects(readPdfLayout(prepared.sourcePath,root),/old row numbers/);
  await writeFile(prepared.sourcePath+'.pdf-layout.json',savedMap);
  console.log('PDF complete paragraph / inline ownership write, proofread, import, staging, HTML/legacy, export and old projection guards passed');
} finally {await rm(root,{recursive:true,force:true});}
