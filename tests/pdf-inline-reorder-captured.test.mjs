import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,readdir,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCanvas,loadImage,DOMMatrix,ImageData,Path2D} from '@napi-rs/canvas';
import {readPdfLayout,assertPdfProtectedWrite,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {validateTranslationCandidate} from '../src/shared/validation/translationValidator.ts';
import {validateProofreadReplacement} from '../src/shared/validation/proofreadReplacement.ts';
import {buildCandidateImportPlan} from '../src/main/agent/importCandidate.ts';
import {pdfInlineTokens} from '../src/shared/validation/pdfPreservation.ts';
const captured=process.env.YN_PDF_INLINE_REORDER_CAPTURED_ROOT;
if(!captured) {console.log('skip captured PDF reorder evidence (set YN_PDF_INLINE_REORDER_CAPTURED_ROOT to the authorized read-only fixture)');}
else {
  const root=await mkdtemp(path.join(os.tmpdir(),'yn-captured-reorder-')),project=path.join(root,'project');
  try {
    await cp(path.join(captured,'project-copy'),project,{recursive:true});
    const candidates=JSON.parse(await readFile(path.join(captured,'inline-reorder-candidates.json'),'utf8'));
    const projections=await readdir(path.join(project,'.translation-workshop','extracted-text'));
    assert.equal(projections.length,1);const sourcePath=path.join(project,'.translation-workshop','extracted-text',projections[0],'source','main.txt');
    const layout=await readPdfLayout(sourcePath,project),lines=layout.blocks.map(block=>block.text);
    const findings=[];
    for(const row of candidates) {
      const source=layout.blocks[row.line-1].text;assert.equal(source,row.source);
      await assertPdfProtectedWrite(sourcePath,project,[{line:row.line,text:row.candidate}]);
      const candidateValidation=validateTranslationCandidate(source,row.candidate,{languagePair:'en->zh-CN',detectUntranslated:false});
      assert.equal(candidateValidation.ok,true,JSON.stringify(candidateValidation.blocking));
      assert.equal(validateProofreadReplacement(source,row.candidate,{},row.line).length,0);
      const importPlan=buildCandidateImportPlan(source,row.candidate,'zh-CN','en->zh-CN');
      assert.equal(importPlan.ok,true,JSON.stringify(importPlan.validation.blocking));
      lines[row.line-1]=row.candidate;findings.push({line:row.line,write:true,validation:true,proofread:true,import:true});
    }
    const original=path.join(project,'main.pdf'),exported=await createTranslatedPdf({templatePath:original,sourcePath,projectRoot:project,translatedLines:lines});
    const bytes=await readFile(exported.outputPath);
    const evidence=path.join(captured,'inline-reorder');await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'captured-reordered.pdf'),bytes);
    Object.assign(globalThis,{DOMMatrix,ImageData,Path2D});const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loader=pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:false}),doc=await loader.promise;
    const nativeOrder=[];
    try {for(const number of [3,4]) {
      const page=await doc.getPage(number),viewport=page.getViewport({scale:2}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      try {
        const ops=await page.getOperatorList(),images=ops.fnArray.flatMap((op,index)=>op===pdfjs.OPS.paintImageXObject?[ops.argsArray[index].slice(1,3)]:[]);
        const originalPage=layout.pages[number-1],preview=await loadImage(await readFile(originalPage.previewPath)),sx=preview.width/originalPage.width,sy=preview.height/originalPage.height;
        const expected=candidates.filter(row=>layout.blocks[row.line-1].page===number).flatMap(row=>pdfInlineTokens(row.candidate).map(token=>{
          const node=layout.blocks[row.line-1].inlineProtections.find(node=>node.token===token),box=node.inkBox;
          return {token,width:Math.ceil((box.x+box.width)*sx)+1-Math.floor(box.x*sx)+1,height:Math.ceil((box.y+box.height)*sy)+1-Math.floor(box.y*sy)+1};
        }));
        const start=images.findIndex((_,index)=>expected.every((node,offset)=>images[index+offset]?.[0]===node.width&&images[index+offset]?.[1]===node.height));
        assert.ok(start>=0,`page ${number} actually embeds each original native glyph raster in candidate marker order`);
        nativeOrder.push({page:number,markers:expected.map(node=>node.token),originalRasterDimensionsInCandidateOrder:true});
        await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;await writeFile(path.join(evidence,`captured-page-${number}.png`),canvas.toBuffer('image/png'));
      } finally {canvas.width=canvas.height=1;}
    }}
    finally {await loader.destroy();}
    await assert.rejects(createTranslatedPdf({templatePath:original,sourcePath,projectRoot:project,translatedLines:lines.map((text,index)=>index===39?text+'正文'.repeat(10000):text)}),/does not fit/);
    assert.deepEqual(await readFile(exported.outputPath),bytes);
    await writeFile(path.join(evidence,'captured-evidence.json'),JSON.stringify({findings,export:true,nativeOrder,overflowRejectedWithoutReplacingOutput:true,pages:exported.pages},null,2));
    console.log('Captured L40/L43/L48 reorder accepts real writes, validation, proofread and import; actual paper export and overflow protection pass');
  } finally {await rm(root,{recursive:true,force:true});}
}
