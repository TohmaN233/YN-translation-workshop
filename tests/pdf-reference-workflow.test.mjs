import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createCanvas,loadImage,DOMMatrix,Path2D,ImageData} from '@napi-rs/canvas';
import {preparePdfDocument,readPdfLayout,readPdfProtectedLines,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {createYnDomainTools} from '../src/main/agent/piNative/ynDomainTools.ts';
import {createYnDomainRunContract} from '../src/main/agent/piNative/domainRunContract.ts';
import {createPiTranslationSubagentTools} from '../src/main/agent/piNative/subagentRunner.ts';
import {prepareTranslationStagingCandidate} from '../src/main/agent/writeTranslationChunk.ts';
import {renderLineReviewHtml,LINE_REVIEW_PROTOCOL_VERSION} from '../src/shared/core/html.ts';
import {writeReviewHtml,readReviewHtml} from '../src/main/reviewHtmlPortability.ts';
import {upgradeLegacyReviewHtmlTree} from '../src/main/reviewHtmlUpgrade.ts';
Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const root=await mkdtemp(path.join(os.tmpdir(),'yn-reference-workflow-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),italic=await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const page=pdf.addPage([600,800]);
  for(const [text,y,size] of [['The method estimates curves.',740,12],['References',670,16],['Smith, A. (2021). A scientific paper.',635,12],['Jones, B. (2022). Another reference.',605,12]])page.drawText(text,{x:40,y,size,font});
  page.drawText('Author. An italic proof',{x:40,y:550,size:30,font:italic});
  const appendix=pdf.addPage([600,800]);appendix.drawText('Appendix A. Proofs',{x:40,y:740,size:16,font});appendix.drawText('This proof requires translation.',{x:40,y:700,size:12,font});
  const original=path.join(root,'references.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const layout=await readPdfLayout(prepared.sourcePath,root),protectedRows=await readPdfProtectedLines(prepared.sourcePath,root);
  const references=protectedRows.filter(row=>row.kind==='reference');
  assert.equal(references.length,4);assert.deepEqual(references.map(row=>row.line),[2,3,4,5]);
  const request={outputDir:root,sourcePath:prepared.sourcePath,sessionId:'references',prompt:'Translate.',languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
  const domainRun=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:false});
  const parent=createYnDomainTools({request,domainRun,subagents:{hasRunning:()=>false},publishCustomMessage:async()=>{},persistHostState:async()=>{}});
  const execute=(name,args={})=>parent.find(t=>t.name===name).execute(name,args);
  const read=JSON.parse((await execute('readSourceLines',{fromLine:1,toLine:7})).content[0].text);
  assert.deepEqual(read.translatableLines.map(row=>row.line),[1,6,7]);
  await assert.rejects(execute('writeTranslationChunk',{fromLine:2,toLine:2,lines:['参考文献']}),/参考文献|reference.*identical/i);
  const translations=['该方法估计曲线。',...references.map(row=>row.text),'附录 A：证明','该证明需要翻译。'];
  await execute('writeTranslationChunk',{fromLine:1,toLine:7,entries:[1,6,7].map(line=>({line,translation:translations[line-1]}))});
  const candidate=path.join(root,'AI_translation/references_translated.txt');
  assert.deepEqual((await readFile(candidate,'utf8')).trimEnd().split('\n'),translations);
  const stage=await prepareTranslationStagingCandidate({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'references.txt',sessionId:'references',subagentId:'child',assignmentId:'refs'});
  const child=createPiTranslationSubagentTools({request,task:{fromLine:1,toLine:7},workingCandidatePath:stage});
  const source=JSON.parse((await child.find(t=>t.name==='readAssignedSource').execute('read',{})).content[0].text);
  assert.ok(source.sourceBlocks.every(block=>block.absoluteLines.every(line=>![2,3,4,5].includes(line))),'references never enter model writable blocks');
  assert.equal(source.pdfReferences.protectedLines.filter(row=>row.kind==='reference').length,4);
  const childWrite=JSON.parse((await child.find(t=>t.name==='writeAssignedTranslation').execute('write',{blocks:source.sourceBlocks.map(block=>({id:block.id,lines:block.lines.map((line,index)=>line[0]+translations[block.absoluteLines[index]-1])}))})).content[0].text);
  assert.equal(childWrite.requiredLineCount,0);
  assert.deepEqual((await readFile(stage,'utf8')).trimEnd().split('\n'),translations,'staging retains reference rows without model writes');
  const htmlPath=path.join(root,'review.html');
  const html=renderLineReviewHtml({title:'PDF references',sourceText:prepared.text,translationText:translations.join('\n'),
    workflow:{sourcePath:original,validationSourcePath:prepared.sourcePath,outputDir:root}});
  await writeReviewHtml(htmlPath,html);
  const data=html=>JSON.parse(html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  let stored=await readReviewHtml(htmlPath);assert.equal(data(stored).rows[1].pdfProtection,'reference');
  await writeFile(htmlPath,stored.replace(`line-review-v${LINE_REVIEW_PROTOCOL_VERSION}`,`line-review-v${LINE_REVIEW_PROTOCOL_VERSION-1}`).replaceAll(/"pdfProtection"\s*:\s*"reference"/g,'"pdfProtection":"math"'));
  await upgradeLegacyReviewHtmlTree(htmlPath);stored=await readReviewHtml(htmlPath);assert.equal(data(stored).rows[1].pdfProtection,'reference','existing HTML is re-bound without extraction');
  if(process.versions.electron) {
    const {BrowserWindow}=await import('electron'),window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
    try {await window.loadFile(htmlPath);const rows=await window.webContents.executeJavaScript(`(()=>[2,6].map(line=>{const cell=document.querySelector('[data-line="'+line+'"] .target');return {editable:cell.contentEditable,text:cell.textContent};}))()`);
      assert.equal(rows[0].editable,'false');assert.equal(rows[0].text,'References');assert.equal(rows[1].editable,'true');assert.equal(window.isVisible(),false);
    } finally {window.close();}
  }
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:translations});
  const doc=pdfjs.getDocument({data:new Uint8Array(await readFile(exported.outputPath)),useSystemFonts:false}),opened=await doc.promise;
  try {
    const outputPage=await opened.getPage(1),viewport=outputPage.getViewport({scale:2}),canvas=createCanvas(viewport.width,viewport.height),ctx=canvas.getContext('2d');
    await outputPage.render({canvasContext:ctx,viewport}).promise;
    const originalImage=await loadImage(await readFile(layout.pages[0].previewPath)),originalCanvas=createCanvas(originalImage.width,originalImage.height),originalCtx=originalCanvas.getContext('2d');originalCtx.drawImage(originalImage,0,0);
    assert.deepEqual(ctx.getImageData(0,200,1200,1400).data,originalCtx.getImageData(0,200,1200,1400).data,'whole bibliography area including italic overhang retains exact source pixels; never compare only a nominal crop');
  } finally {await doc.destroy();}
  const before=await readFile(exported.outputPath);
  await assert.rejects(createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:translations.map((text,index)=>index===2?'changed citation':text)}),/reference|参考文献/i);
  assert.deepEqual(await readFile(exported.outputPath),before,'invalid reference edits cannot replace successful output');
  console.log('References are immutable in actual parent/child writes, existing HTML, staging and exported native page pixels; appendix remains translatable');
} finally {await rm(root,{recursive:true,force:true});}
