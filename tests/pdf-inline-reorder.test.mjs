import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PDFDocument,StandardFonts,beginText,endText,setFontAndSize,moveText,showText,beginMarkedContent,endMarkedContent,setFillingRgbColor,rgb} from 'pdf-lib';
import {createCanvas,loadImage,DOMMatrix,Path2D,ImageData} from '@napi-rs/canvas';
import {readPdfLayout,createTranslatedPdf,assertPdfProtectedWrite} from '../src/main/pdfDocuments.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {splitPdfInlineTranslation} from '../src/shared/validation/pdfPreservation.ts';
const printService=process.versions.electron?undefined:await createNativePdfPrintBackend();
if(printService)configurePdfPrintBackend(printService.backend);
try {
Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjsRoot=path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const evidence=process.env.YN_PDF_INLINE_REORDER_EVIDENCE;
const root=await mkdtemp(path.resolve('.tmp-inline-reorder-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([600,800]);
  page.drawRectangle({x:35,y:480,width:530,height:50,color:rgb(.8,.9,1)});
  const key=page.node.newFontDictionary(font.name,font.ref);
  page.pushOperators(beginText(),setFontAndSize(key,12),moveText(40,710),showText(font.encodeText('First ')),
    beginMarkedContent('Formula'),showText(font.encodeText('x + y')),endMarkedContent(),showText(font.encodeText(' relates to ')),
    beginMarkedContent('Code'),setFillingRgbColor(.8,.1,.2),showText(font.encodeText('value')),endMarkedContent(),setFillingRgbColor(0,0,0),showText(font.encodeText(' in a complete explanation.')),endText());
  page.pushOperators(beginText(),setFontAndSize(key,12),moveText(40,650),showText(font.encodeText('Second ')),
    beginMarkedContent('Formula'),showText(font.encodeText('a + b')),endMarkedContent(),showText(font.encodeText(' belongs to another paragraph.')),endText());
  const original=path.join(root,'inline.pdf');await writeFile(original,await pdf.save());
  const overlayPdf=await PDFDocument.create(),overlayPage=overlayPdf.addPage([600,800]),overlayFont=await overlayPdf.embedFont(StandardFonts.Helvetica);
  overlayPage.drawRectangle({x:35,y:680,width:530,height:50,color:rgb(.8,.9,1)});
  overlayPage.drawText('Unknown colored prose panel.',{x:40,y:710,size:12,font:overlayFont});
  const overlayPath=path.join(root,'colored-prose-panel.pdf');await writeFile(overlayPath,await overlayPdf.save());
  await assert.rejects(preparePdfDocument(overlayPath,path.join(root,'colored-prose-panel','.translation-workshop')),/ambiguous graphic ownership.*overlap.*source text/,'source prose and an unknown colored panel cannot be silently dropped or duplicated');
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
  const document=JSON.parse(await readFile(exported.documentPath,'utf8')),paragraph=document.nodes.find(node=>node.sourceLines.includes(1));
  assert.ok(layout.references.some(reference=>reference.kind==='vector'),'non-overlapping colored panel has explicit source vector ownership');
  assert.ok(document.nodes.some(node=>node.type==='figure'&&node.id.includes('vector')&&node.image),'successful reflow retains the independent colored source panel');
  const nativeParts=paragraph.parts.filter(part=>part.image);
  assert.deepEqual(nativeParts.map(part=>part.token),[b,a],'source HTML native images follow the translated marker order');
  const nativeDimensions=new Map();
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
        const rgba=isolated.getContext('2d').getImageData(left,top,width,height).data;
        if(evidence) {await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'isolated-'+node.kind+'.png'),isolated.toBuffer('image/png'));}
        const part=nativeParts.find(part=>part.token===node.token),sourceImage=await loadImage(Buffer.from(part.image.dataUrl.split(',')[1],'base64')),sourceCanvas=createCanvas(sourceImage.width,sourceImage.height);sourceCanvas.getContext('2d').drawImage(sourceImage,0,0);
        assert.deepEqual([sourceImage.width,sourceImage.height],[width,height],`${node.token} keeps original PNG dimensions`);
        assert.deepEqual(sourceCanvas.getContext('2d').getImageData(0,0,width,height).data,rgba,`${node.token} keeps every native alpha/color pixel in the editable source`);
        nativeDimensions.set(node.token,[width,height]);
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
    const operations=await outPage.getOperatorList(),images=operations.fnArray.flatMap((operation,index)=>operation===pdfjs.OPS.paintImageXObject?[operations.argsArray[index].slice(1,3)]:[]);
    assert.deepEqual(images.slice(0,2),[nativeDimensions.get(b),nativeDimensions.get(a)],'actual Chromium PDF embeds original raster dimensions in translated marker order');
    const printedText=(await outPage.getTextContent()).items.map(item=>item.str??'').join('').normalize('NFKC');
    for(const text of ['正文','连接','结束','第二段','保留内容'])assert.ok(printedText.includes(text),`translated prose remains complete: ${text}`);
    const html=await readFile(exported.htmlPath,'utf8');for(const part of nativeParts)assert.ok(html.includes(part.image.dataUrl),'printed HTML uses the verified source-native PNG');
    if(evidence) {await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'original.pdf'),await readFile(original));await writeFile(path.join(evidence,'reordered.pdf'),output);await writeFile(path.join(evidence,'reordered.html'),html);await writeFile(path.join(evidence,'reordered.document.json'),JSON.stringify(document,null,2));await writeFile(path.join(evidence,'reordered.png'),canvas.toBuffer('image/png'));await writeFile(path.join(evidence,'pixel-evidence.json'),JSON.stringify({translated,nativeOrder:[b,a],nativePngRgbaExactlyIdentical:true,pdfRasterDimensionsInCandidateOrder:true,negativeCases:5},null,2));}
    const originalOrder=`正文 ${a} 连接 ${b} 结束。`,roundtrip=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:[originalOrder,exportLines[1]]});
    const roundtripBytes=await readFile(roundtrip.outputPath),roundtripLoader=pdfjs.getDocument({data:new Uint8Array(roundtripBytes),useSystemFonts:false}),roundtripDoc=await roundtripLoader.promise;
    try {
      const roundtripPage=await roundtripDoc.getPage(1),roundtripCanvas=createCanvas(viewport.width,viewport.height),roundtripContext=roundtripCanvas.getContext('2d');
      try {
        await roundtripPage.render({canvas:roundtripCanvas,canvasContext:roundtripContext,viewport}).promise;
        const sourceDocument=JSON.parse(await readFile(roundtrip.documentPath,'utf8')),sourceParts=sourceDocument.nodes.find(node=>node.sourceLines.includes(1)).parts.filter(part=>part.image);
        assert.deepEqual(sourceParts.map(part=>part.token),[a,b],'original marker order remains explicit in the source HTML');
        for(const part of sourceParts)assert.equal(part.image.dataUrl,nativeParts.find(native=>native.token===part.token).image.dataUrl,'reordering changes placement without changing source PNGs');
        const sourceOperations=await roundtripPage.getOperatorList(),sourceImages=sourceOperations.fnArray.flatMap((operation,index)=>operation===pdfjs.OPS.paintImageXObject?[sourceOperations.argsArray[index].slice(1,3)]:[]);
        assert.deepEqual(sourceImages.slice(0,2),[nativeDimensions.get(a),nativeDimensions.get(b)],'original marker order prints both native rasters in that order');
        if(evidence)await writeFile(path.join(evidence,'original-order.pdf'),roundtripBytes);
      } finally {roundtripCanvas.width=roundtripCanvas.height=1;}
    } finally {await roundtripLoader.destroy();}
    canvas.width=canvas.height=source.width=source.height=1;
  } finally {await loading.destroy();}
  console.log('PDF marker reorder preserves source PNG RGBA, actual printed image order and strict ownership/count/prose checks');
} finally {if(process.env.YN_PDF_ADAPTATION_KEEP==='1')console.log('retained PDF test fixture '+root);else await rm(root,{recursive:true,force:true});}

}finally{if(printService)await printService.close();}
