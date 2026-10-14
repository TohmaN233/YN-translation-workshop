import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PDFDocument,PDFName,PDFRawStream,decodePDFRawStream,StandardFonts,beginText,endText,setFontAndSize,moveText,showText,beginMarkedContent,endMarkedContent,setFillingRgbColor,rgb} from 'pdf-lib';
import {createCanvas,loadImage,DOMMatrix,Path2D,ImageData} from '@napi-rs/canvas';
import {preparePdfDocument,readPdfLayout,createTranslatedPdf,assertPdfProtectedWrite} from '../src/main/pdfDocuments.ts';
import {splitPdfInlineTranslation} from '../src/shared/validation/pdfPreservation.ts';
Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjsRoot=path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const evidence=process.env.YN_PDF_INLINE_REORDER_EVIDENCE;
const root=await mkdtemp(path.join(os.tmpdir(),'yn-inline-reorder-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([600,800]);
  page.drawRectangle({x:35,y:680,width:530,height:50,color:rgb(.8,.9,1)});
  const key=page.node.newFontDictionary(font.name,font.ref);
  page.pushOperators(beginText(),setFontAndSize(key,12),moveText(40,710),showText(font.encodeText('First ')),
    beginMarkedContent('Formula'),showText(font.encodeText('x + y')),endMarkedContent(),showText(font.encodeText(' relates to ')),
    beginMarkedContent('Code'),setFillingRgbColor(.8,.1,.2),showText(font.encodeText('value')),endMarkedContent(),setFillingRgbColor(0,0,0),showText(font.encodeText(' in a complete explanation.')),endText());
  page.pushOperators(beginText(),setFontAndSize(key,12),moveText(40,650),showText(font.encodeText('Second ')),
    beginMarkedContent('Formula'),showText(font.encodeText('a + b')),endMarkedContent(),showText(font.encodeText(' belongs to another paragraph.')),endText());
  const original=path.join(root,'inline.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const layout=await readPdfLayout(prepared.sourcePath,root),block=layout.blocks[0];
  const [a,b]=block.inlineProtections.map(node=>node.token),foreign=layout.blocks[1].inlineProtections[0].token;
  const translated=`正文 ${b} 连接 ${a} 结束。`;
  assert.deepEqual(splitPdfInlineTranslation(block.text,translated),['正文 ',' 连接 ',' 结束。']);
  await assertPdfProtectedWrite(prepared.sourcePath,root,[{line:1,text:translated}]);
  const exportLines=[translated,`第二段 ${foreign} 保留内容。`];
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:exportLines});
  const output=await readFile(exported.outputPath);
  const sourceLoader=pdfjs.getDocument({data:new Uint8Array(await readFile(original)),useSystemFonts:false,standardFontDataUrl:path.join(pdfjsRoot,'standard_fonts').replaceAll('\\','/')+'/'}),sourcePdf=await sourceLoader.promise;
  const exportedPdf=await PDFDocument.load(output),nativeMasks=exportedPdf.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFRawStream&&object.dict.get(PDFName.of('Subtype'))===PDFName.of('Image')&&object.dict.has(PDFName.of('SMask')));
  try {
    const sourcePage=await sourcePdf.getPage(1),sourceViewport=sourcePage.getViewport({scale:2}),sourceOps=await sourcePage.getOperatorList(),paintOps=sourceOps.fnArray.flatMap((op,index)=>op===pdfjs.OPS.showText?[index]:[]);
    for(const node of block.inlineProtections) {
      const isolated=createCanvas(sourceViewport.width,sourceViewport.height),hidden=[];let paintIndex=0;
      try {
        await sourcePage.render({canvas:null,canvasContext:isolated.getContext('2d'),viewport:sourceViewport,background:'rgba(0,0,0,0)',operationsFilter:(index,list)=>{
          if(list.fnArray[index]===pdfjs.OPS.constructPath)return false;
          if(list.fnArray[index]===pdfjs.OPS.showText&&!node.paintOperations.includes(paintOps[paintIndex++])) {const glyphs=list.argsArray[index][0];hidden.push({list,index,glyphs});list.argsArray[index][0]=glyphs.map(glyph=>typeof glyph==='object'?{...glyph,isInFont:false,fontChar:'',unicode:'',accent:null}:glyph);}
          return true;
        }}).promise;
        const box=node.inkBox,left=Math.max(0,Math.floor(box.x*2)-1),top=Math.max(0,Math.floor(box.y*2)-1),width=Math.ceil((box.x+box.width)*2)+1-left,height=Math.ceil((box.y+box.height)*2)+1-top;
        const rgba=isolated.getContext('2d').getImageData(left,top,width,height).data,alpha=Uint8Array.from({length:width*height},(_,i)=>rgba[i*4+3]);
        if(evidence) {await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'isolated-'+node.kind+'.png'),isolated.toBuffer('image/png'));}
        const match=nativeMasks.find(([,image])=>image.dict.get(PDFName.of('Width')).asNumber()===width&&image.dict.get(PDFName.of('Height')).asNumber()===height&&Buffer.from(decodePDFRawStream(exportedPdf.context.lookup(image.dict.get(PDFName.of('SMask')))).decode()).equals(Buffer.from(alpha)));
        assert.ok(match,`actual exported ${node.token} keeps the exact native glyph alpha pixels (${width}x${height})`);
        const colors=decodePDFRawStream(match[1]).decode();
        assert.ok(alpha.every((value,i)=>!value||[0,1,2].every(channel=>colors[i*3+channel]===rgba[i*4+channel])),`actual exported ${node.token} keeps exact native glyph color pixels`);
      } finally {for(const entry of hidden)entry.list.argsArray[entry.index][0]=entry.glyphs;isolated.width=isolated.height=1;}
    }
  } finally {await sourceLoader.destroy();}
  for(const bad of [translated.replace(a,''),translated.replace(a,b),translated+a,translated.replace(a,foreign),a+b]) {
    await assert.rejects(assertPdfProtectedWrite(prepared.sourcePath,root,[{line:1,text:bad}]),/PDF L1/);
    await assert.rejects(createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:[bad,exportLines[1]]}),/markers|prose/);
    assert.deepEqual(await readFile(exported.outputPath),output,'invalid reorder must never replace the prior export');
  }
  const loading=pdfjs.getDocument({data:new Uint8Array(output),useSystemFonts:false}),doc=await loading.promise;
  try {
    const outPage=await doc.getPage(1),viewport=outPage.getViewport({scale:2}),canvas=createCanvas(viewport.width,viewport.height),context=canvas.getContext('2d');
    await outPage.render({canvas,canvasContext:context,viewport}).promise;
    const preview=await loadImage(await readFile(layout.pages[0].previewPath)),source=createCanvas(preview.width,preview.height),sourceContext=source.getContext('2d');sourceContext.drawImage(preview,0,0);
    if(evidence) {await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'reordered.png'),canvas.toBuffer('image/png'));await writeFile(path.join(evidence,'source.png'),source.toBuffer('image/png'));await writeFile(path.join(evidence,'layout.json'),JSON.stringify(block,null,2));}
    // Locate every original native glyph crop in the actual exported page.
    const positions=[];
    for(const node of block.inlineProtections) {
      const box=node.inkBox,x=Math.floor(box.x*2),y=Math.floor(box.y*2),width=Math.ceil((box.x+box.width)*2)-x,height=Math.ceil((box.y+box.height)*2)-y;
      const native=sourceContext.getImageData(x,y,width,height).data;let found;
      for(let yy=150;yy<220&&!found;yy++)for(let xx=70;xx<1000&&!found;xx++) {
        const pixels=context.getImageData(xx,yy,width,height).data;
        if(pixels.every((value,index)=>Math.abs(value-native[index])<=1))found={token:node.token,x:xx,y:yy,width,height};
      }
      assert.ok(found,`exported ${node.token} renders its native pixels within one color-compositing rounding level`);positions.push(found);
    }
    assert.ok(positions[1].x<positions[0].x,'actual glyphs follow the candidate marker order');
    assert.deepEqual(context.getImageData(80,225,900,15).data,sourceContext.getImageData(80,225,900,15).data,'overlapping colored background remains intact');
    if(evidence) {await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'original.pdf'),await readFile(original));await writeFile(path.join(evidence,'reordered.pdf'),output);await writeFile(path.join(evidence,'reordered.png'),canvas.toBuffer('image/png'));await writeFile(path.join(evidence,'pixel-evidence.json'),JSON.stringify({translated,positions,nativeGlyphAlphaPixelsExactlyIdentical:true,maxCompositeColorDifference:1,coloredBackgroundIdentical:true,negativeCases:5},null,2));}
    const originalOrder=`正文 ${a} 连接 ${b} 结束。`,roundtrip=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:[originalOrder,exportLines[1]]});
    const roundtripBytes=await readFile(roundtrip.outputPath),roundtripLoader=pdfjs.getDocument({data:new Uint8Array(roundtripBytes),useSystemFonts:false}),roundtripDoc=await roundtripLoader.promise;
    try {
      const roundtripPage=await roundtripDoc.getPage(1),roundtripCanvas=createCanvas(viewport.width,viewport.height),roundtripContext=roundtripCanvas.getContext('2d');
      try {
        await roundtripPage.render({canvas:roundtripCanvas,canvasContext:roundtripContext,viewport}).promise;
        for(const node of block.inlineProtections) {
          const box=node.inkBox,x=Math.floor(box.x*2),y=Math.floor(box.y*2),width=Math.ceil((box.x+box.width)*2)-x,height=Math.ceil((box.y+box.height)*2)-y;
          assert.deepEqual(roundtripContext.getImageData(x,y,width,height).data,sourceContext.getImageData(x,y,width,height).data,'unchanged marker order retains exact source pixels and coordinates');
        }
        if(evidence)await writeFile(path.join(evidence,'original-order.pdf'),roundtripBytes);
      } finally {roundtripCanvas.width=roundtripCanvas.height=1;}
    } finally {await roundtripLoader.destroy();}
    canvas.width=canvas.height=source.width=source.height=1;
  } finally {await loading.destroy();}
  console.log('PDF same-paragraph marker reorder preserves original glyph pixels, candidate order, background and strict ownership/count/prose checks');
} finally {await rm(root,{recursive:true,force:true});}
