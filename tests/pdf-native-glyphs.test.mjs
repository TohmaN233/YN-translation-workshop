import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument, PDFName, PDFHexString, StandardFonts, pushGraphicsState, popGraphicsState,
  beginText, endText, setFontAndSize, setTextMatrix, showText, PDFOperator, PDFOperatorNames, PDFArray, PDFNumber, rgb } from 'pdf-lib';
import { createCanvas, loadImage, DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
import { preparePdfDocument, createTranslatedPdf, readPdfLayout } from '../src/main/pdfDocuments.ts';
import { pdfProtectionHash, PDF_EXTRACTOR_REVISION, PDF_LAYOUT_VERSION } from '../src/main/pdfTypes.ts';
import { encodeProjectPaths } from '../src/main/projectPaths.ts';
Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-native-'));
const type3=(pdf,page,{empty=false}={})=>{
  const ctx=pdf.context;
  const charProc=ctx.register(ctx.stream(empty?'1000 0 d0\n':'300 0 -100 0 400 700 d1\n-100 0 500 700 re f\n'));
  const font=ctx.register(ctx.obj({Type:'Font',Subtype:'Type3',Name:'GlyphFixture',FontBBox:[-100,0,400,700],FontMatrix:[.001,0,0,.001,0,0],
    CharProcs:ctx.obj({one:charProc}),Encoding:ctx.obj({Type:'Encoding',Differences:[49,PDFName.of('one')]}),FirstChar:49,LastChar:49,Widths:[empty?1000:300],Resources:ctx.obj({})}));
  return page.node.newFontDictionary('GlyphFixture',font);
};
const place=(page,font,x,y)=>page.pushOperators(pushGraphicsState(),beginText(),setFontAndSize(font,10),setTextMatrix(1,0,0,1,x,y),showText(PDFHexString.of('31')),endText(),popGraphicsState());
try {
  const project=path.join(root,'numeric');await mkdir(project);
  const pdf=await PDFDocument.create(),page=pdf.addPage([200,200]);place(page,type3(pdf,page),40,60);
  const original=path.join(project,'native.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(project,'.translation-workshop'));
  const layout=await readPdfLayout(prepared.sourcePath,project),block=layout.blocks[0];
  assert.ok(block.sourceInkBox.x<block.x && block.sourceInkBox.width>block.width,'ink overhang exceeds advance width');
  const isolated=await loadImage(await readFile(block.sourceInkPath)),isolatedCanvas=createCanvas(isolated.width,isolated.height);isolatedCanvas.getContext("2d").drawImage(isolated,0,0);
  assert.equal(isolatedCanvas.getContext("2d").getImageData(0,0,1,1).data[3],0,"numeric asset must not copy the prior canvas/background");
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:project,translatedLines:['1']});
  const image=await loadImage(await readFile(layout.pages[0].previewPath)),source=createCanvas(image.width,image.height);source.getContext('2d').drawImage(image,0,0);
  const loading=pdfjs.getDocument({data:new Uint8Array(await readFile(exported.outputPath)),useSystemFonts:false}),doc=await loading.promise;
  const outPage=await doc.getPage(1),viewport=outPage.getViewport({scale:2}),out=createCanvas(viewport.width,viewport.height);
  await outPage.render({canvas:out,canvasContext:out.getContext('2d'),viewport}).promise;
  const ink=canvas=>canvas.getContext('2d').getImageData(60,250,50,45).data;
  assert.deepEqual(ink(out),ink(source),'actual exported Type3 glyph keeps every source pixel');await loading.destroy();
  const mapPath=prepared.sourcePath+'.pdf-layout.json';
  const old={...layout,extractorRevision:0};old.protectionHash=pdfProtectionHash(old);
  await writeFile(mapPath,JSON.stringify(encodeProjectPaths(old,project)));
  await assert.rejects(readPdfLayout(prepared.sourcePath,project),/obsolete extractor/);
  await writeFile(mapPath,JSON.stringify(encodeProjectPaths(layout,project)));
  const oldPath=prepared.sourcePath.replace(`-v${PDF_LAYOUT_VERSION}-e${PDF_EXTRACTOR_REVISION}`,'-v2');await mkdir(path.dirname(oldPath),{recursive:true});
  await writeFile(oldPath,prepared.text);await writeFile(oldPath+'.pdf-layout.json',JSON.stringify({...old,sourcePath:oldPath}));
  const fresh=await preparePdfDocument(original,path.join(project,'.translation-workshop'));
  assert.notEqual(fresh.sourcePath,oldPath);assert.ok(await readFile(oldPath+'.pdf-layout.json'),'old artifacts retained');

  const decorative=await PDFDocument.create(),decorativePage=decorative.addPage([600,800]);
  decorativePage.drawRectangle({x:0,y:0,width:100,height:100,color:rgb(0,0,1)});
  place(decorativePage,type3(decorative,decorativePage,{empty:true}),500,500);
  const decorativePath=path.join(root,'decorative.pdf');await writeFile(decorativePath,await decorative.save());
  await assert.rejects(preparePdfDocument(decorativePath,path.join(root,'decorative','.translation-workshop')),/outside.*glyph region/);

  const shared=await PDFDocument.create(),sharedPage=shared.addPage([300,200]),font=await shared.embedFont(StandardFonts.Helvetica);
  const fontKey=sharedPage.node.newFontDictionary('Shared',font.ref);
  const glyphs=PDFArray.withContext(shared.context);glyphs.push(font.encodeText('1'));glyphs.push(PDFNumber.of(-4000));glyphs.push(font.encodeText('explanatory prose'));
  sharedPage.pushOperators(beginText(),setFontAndSize(fontKey,12),setTextMatrix(1,0,0,1,40,100),PDFOperator.of(PDFOperatorNames.ShowTextAdjusted,[glyphs]),endText());
  const sharedPath=path.join(root,'shared.pdf');await writeFile(sharedPath,await shared.save());
  const sharedProject=path.join(root,'shared'), sharedSource=await preparePdfDocument(sharedPath,path.join(sharedProject,'.translation-workshop'));
  const sharedLayout=await readPdfLayout(sharedSource.sourcePath,sharedProject),sharedNumber=sharedLayout.blocks.find(block=>block.text==='1');
  assert.ok(sharedNumber?.sourceInkPath,'a shared TJ paint must isolate its numeric glyph');
  assert.equal(sharedLayout.blocks.find(block=>block.text==='explanatory prose').protection,undefined,'the adjacent cell remains translatable');
  const sharedPreview=await loadImage(await readFile(sharedLayout.pages[0].previewPath)), sharedInk=await loadImage(await readFile(sharedNumber.sourceInkPath));
  const sourceCanvas=createCanvas(sharedPreview.width,sharedPreview.height);sourceCanvas.getContext('2d').drawImage(sharedPreview,0,0);
  const sharedIsolatedCanvas=createCanvas(sharedInk.width,sharedInk.height);sharedIsolatedCanvas.getContext('2d').fillStyle='white';sharedIsolatedCanvas.getContext('2d').fillRect(0,0,sharedInk.width,sharedInk.height);sharedIsolatedCanvas.getContext('2d').drawImage(sharedInk,0,0);
  const numericBox=sharedNumber.sourceInkBox;
  assert.deepEqual(sharedIsolatedCanvas.getContext('2d').getImageData(0,0,sharedInk.width,sharedInk.height).data,
    sourceCanvas.getContext('2d').getImageData(Math.round(numericBox.x*2),Math.round(numericBox.y*2),sharedInk.width,sharedInk.height).data,'shared-paint numeric pixels match the source exactly');
  assert.ok(sharedInk.width<20,'the asset must not include the neighboring prose');

  const clipped=await PDFDocument.create(),clippedPage=clipped.addPage([200,200]),clippedFont=await clipped.embedFont(StandardFonts.Helvetica);
  const clippedKey=clippedPage.node.newFontDictionary('Clipped',clippedFont.ref);
  const operation=(name,...args)=>PDFOperator.of(name,args.map(PDFNumber.of));
  clippedPage.pushOperators(operation('rg',1,1,1),operation('m',40,60),operation('l',65,60),operation('l',40,100),operation('h'),operation('W'),operation('f'),
    operation('rg',0,0,0),beginText(),setFontAndSize(clippedKey,40),setTextMatrix(1,0,0,1,40,60),showText(clippedFont.encodeText('8')),endText());
  const clippedPath=path.join(root,'clipped.pdf'),clippedProject=path.join(root,'clipped');await writeFile(clippedPath,await clipped.save());
  const clippedSource=await preparePdfDocument(clippedPath,path.join(clippedProject,'.translation-workshop'));
  const clippedLayout=await readPdfLayout(clippedSource.sourcePath,clippedProject),clippedNumber=clippedLayout.blocks[0];
  const clipPreview=await loadImage(await readFile(clippedLayout.pages[0].previewPath)),clipInk=await loadImage(await readFile(clippedNumber.sourceInkPath));
  const clipSourceCanvas=createCanvas(clipPreview.width,clipPreview.height);clipSourceCanvas.getContext('2d').drawImage(clipPreview,0,0);
  const clipInkCanvas=createCanvas(clipInk.width,clipInk.height);clipInkCanvas.getContext('2d').fillStyle='white';clipInkCanvas.getContext('2d').fillRect(0,0,clipInk.width,clipInk.height);clipInkCanvas.getContext('2d').drawImage(clipInk,0,0);
  assert.deepEqual(clipInkCanvas.getContext('2d').getImageData(0,0,clipInk.width,clipInk.height).data,
    clipSourceCanvas.getContext('2d').getImageData(Math.round(clippedNumber.sourceInkBox.x*2),Math.round(clippedNumber.sourceInkBox.y*2),clipInk.width,clipInk.height).data,'a path that clips and fills must keep its clip when isolating numeric ink');

  const fallback=await PDFDocument.create(),fallbackPage=fallback.addPage([300,200]),fallbackContext=fallback.context;
  const descriptor=fallbackContext.register(fallbackContext.obj({Type:'FontDescriptor',FontName:'YNMissingUnembeddedFont',FontBBox:[0,-200,1000,800],Flags:32,Ascent:800,Descent:-200,CapHeight:700,StemV:80}));
  const fallbackRef=fallbackContext.register(fallbackContext.obj({Type:'Font',Subtype:'Type1',BaseFont:'YNMissingUnembeddedFont',Encoding:'WinAnsiEncoding',FirstChar:32,LastChar:126,Widths:Array(95).fill(600),FontDescriptor:descriptor}));
  const fallbackKey=fallbackPage.node.newFontDictionary('MissingFixture',fallbackRef),fallbackText=PDFArray.withContext(fallbackContext);
  fallbackText.push(PDFHexString.of('31'));fallbackText.push(PDFNumber.of(-4000));fallbackText.push(PDFHexString.of(Buffer.from('explanatory prose','ascii').toString('hex')));
  fallbackPage.pushOperators(beginText(),setFontAndSize(fallbackKey,12),setTextMatrix(1,0,0,1,40,100),PDFOperator.of(PDFOperatorNames.ShowTextAdjusted,[fallbackText]),endText());
  const fallbackPath=path.join(root,'fallback.pdf'),fallbackProject=path.join(root,'fallback');await writeFile(fallbackPath,await fallback.save());
  const fallbackSource=await preparePdfDocument(fallbackPath,path.join(fallbackProject,'.translation-workshop'));
  const fallbackLayout=await readPdfLayout(fallbackSource.sourcePath,fallbackProject),fallbackNumber=fallbackLayout.blocks.find(block=>block.text==='1');
  const fallbackPreview=await loadImage(await readFile(fallbackLayout.pages[0].previewPath)),fallbackInk=await loadImage(await readFile(fallbackNumber.sourceInkPath));
  const fallbackSourceCanvas=createCanvas(fallbackPreview.width,fallbackPreview.height);fallbackSourceCanvas.getContext('2d').drawImage(fallbackPreview,0,0);
  const fallbackInkCanvas=createCanvas(fallbackInk.width,fallbackInk.height);fallbackInkCanvas.getContext('2d').fillStyle='white';fallbackInkCanvas.getContext('2d').fillRect(0,0,fallbackInk.width,fallbackInk.height);fallbackInkCanvas.getContext('2d').drawImage(fallbackInk,0,0);
  assert.deepEqual(fallbackInkCanvas.getContext('2d').getImageData(0,0,fallbackInk.width,fallbackInk.height).data,
    fallbackSourceCanvas.getContext('2d').getImageData(Math.round(fallbackNumber.sourceInkBox.x*2),Math.round(fallbackNumber.sourceInkBox.y*2),fallbackInk.width,fallbackInk.height).data,'selected fallback glyphs retain their original native painter');
  const packed=await PDFDocument.create(),packedPage=packed.addPage([200,200]),packedFont=await packed.embedFont(StandardFonts.Helvetica);
  packedPage.drawText('(1) Short line',{x:40,y:100,size:12,font:packedFont});packedPage.drawText('(2) Next line',{x:40,y:90,size:12,font:packedFont});
  const packedPath=path.join(root,'packed.pdf'),packedProject=path.join(root,'packed');await writeFile(packedPath,await packed.save());
  const packedSource=await preparePdfDocument(packedPath,path.join(packedProject,'.translation-workshop'));
  assert.equal(packedSource.text.split('\n').length,2);
  const packedOut=await createTranslatedPdf({templatePath:packedPath,sourcePath:packedSource.sourcePath,projectRoot:packedProject,translatedLines:['第一行','第二行']});
  const packedDoc=pdfjs.getDocument({data:new Uint8Array(await readFile(packedOut.outputPath)),useSystemFonts:false}),packedOpened=await packedDoc.promise;
  const packedItems=(await (await packedOpened.getPage(1)).getTextContent()).items.filter(item=>item.str?.trim());
  assert.ok(packedItems[0].height*1.2<=10.1,'adjacent row spacing caps drawn height');await packedDoc.destroy();
  console.log('Native numeric ink, obsolete extractor, decorative Type3 and shared TJ safety passed');
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'yn-pdf-native-'));
  await rm(root,{recursive:true,force:true});
}
