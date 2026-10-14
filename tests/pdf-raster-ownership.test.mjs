import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts,beginMarkedContent,endMarkedContent} from 'pdf-lib';
import {createCanvas,loadImage,DOMMatrix,Path2D,ImageData} from '@napi-rs/canvas';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {readPdfLayout,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {buildPdfReflowDocument} from '../src/main/pdfReflowDocument.ts';
import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';

Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const service=process.versions.electron?undefined:await createNativePdfPrintBackend();if(service)configurePdfPrintBackend(service.backend);
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-raster-owner-'));
try {
  const canvas=createCanvas(200,100),context=canvas.getContext('2d');context.fillStyle='#dddddd';context.fillRect(0,0,200,100);
  const png=canvas.toBuffer('image/png'),pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),raster=await pdf.embedPng(png);
  const first=pdf.addPage([600,800]);first.drawText('First source context\ncontinues on a visual source row.',{x:40,y:740,size:12,lineHeight:14,font});first.drawImage(raster,{x:40,y:500,width:200,height:100});first.drawText('Readable overlay label',{x:60,y:550,size:12,font});
  const second=pdf.addPage([600,800]);second.drawText('Formula overlay context.',{x:40,y:740,size:12,font});second.drawImage(raster,{x:40,y:500,width:200,height:100});
  second.pushOperators(beginMarkedContent('Formula'));second.drawText('x + y',{x:60,y:550,size:12,font});second.pushOperators(endMarkedContent());
  const third=pdf.addPage([600,800]);third.drawText('Panel group context.',{x:40,y:740,size:12,font});
  third.drawImage(raster,{x:40,y:500,width:200,height:100});third.drawImage(raster,{x:300,y:500,width:200,height:100});
  third.drawText('(a)',{x:100,y:480,size:12,font});third.drawText('(b)',{x:360,y:480,size:12,font});third.drawText('Figure 1: Original pair.',{x:40,y:430,size:12,font});
  const original=path.join(root,'raster.pdf');await writeFile(original,await pdf.save());
  const originalBytes=await readFile(original);
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'),{visualRowsOnly:true}),layout=await readPdfLayout(prepared.sourcePath,root);
  const overlay=layout.blocks.find(block=>block.text==='Readable overlay label'),formula=layout.blocks.find(block=>block.text==='x + y');
  assert.ok(layout.physicalBlocks.some(block=>block.text==='First source context')&&layout.physicalBlocks.some(block=>block.text==='continues on a visual source row.'),'image isolation rebinds production visual-row primitives even when mechanical paragraph evidence joins source rows');
  assert.ok(overlay&&!overlay.protection&&overlay.fragments.length===1,'external PDF overlay prose has one translatable source owner');
  assert.ok(formula?.protection==='math','external overlay formula has independent native ownership');
  const group=layout.figureGroups.find(group=>group.page===3);assert.ok(group);assert.equal(group.physicalLines.length,2);
  assert.deepEqual(group.physicalLines.map(line=>layout.physicalBlocks[line-1].text),['(a)','(b)']);
  const lines=layout.blocks.map(block=>block.protection?block.text:block===overlay?'Translated overlay label':block.text==='Formula overlay context.'?'Translated formula context.':block.text==='Panel group context.'?'Translated panel context.':block.text.startsWith('Figure 1:')?'Translated figure caption.':block.text);
  const calls=[],placeholder={dataUrl:'data:image/png;base64,AA==',width:1,height:1};
  const built=await buildPdfReflowDocument(layout,lines,{figure:async id=>{calls.push({kind:'figure',id});return placeholder;},native:async(page,physicalLines)=>{calls.push({kind:'native',page,physicalLines});return placeholder;},inline:async token=>{calls.push({kind:'inline',token});return placeholder;}});
  assert.deepEqual(calls.filter(call=>call.kind==='figure').map(call=>call.id).sort(),['p1-image1','p2-image1',group.id].sort(),'raster paints have exactly one standalone/group asset owner');
  assert.ok(calls.some(call=>call.kind==='native'&&JSON.stringify(call.physicalLines)===JSON.stringify(formula.fragments)));
  assert.ok(!calls.some(call=>call.kind==='native'&&call.physicalLines.some(line=>group.physicalLines.includes(line))),'group panel labels are rendered only by their owning figure asset');
  assert.equal(built.nodes.filter(node=>node.sourceLines.includes(overlay.line)).length,1);
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:lines});
  const document=JSON.parse(await readFile(exported.documentPath,'utf8'));
  async function pixels(bytes) {
    const image=await loadImage(bytes),canvas=createCanvas(image.width,image.height);
    try {canvas.getContext('2d').drawImage(image,0,0);return {width:image.width,height:image.height,rgba:canvas.getContext('2d').getImageData(0,0,image.width,image.height).data};}
    finally {canvas.width=canvas.height=1;}
  }
  const figureBytes=node=>Buffer.from(node.image.dataUrl.split(',')[1],'base64');
  const figures=document.nodes.filter(node=>node.type==='figure');assert.equal(figures.length,3);
  for(const page of [1,2]) {
    const figure=figures.find(node=>node.sourcePages[0]===page),ink=await pixels(figureBytes(figure));
    assert.deepEqual(figure.sourceLines,[],'standalone raster image does not claim any PDF text source row');
    assert.deepEqual([ink.width,ink.height],[400,200]);
    for(let index=0;index<ink.rgba.length;index+=4)assert.deepEqual(Array.from(ink.rgba.subarray(index,index+4)),[221,221,221,255],'standalone native raster preserves original opaque gray pixels without foreign prose or formula ink');
  }
  const grouped=figures.find(node=>node.sourcePages[0]===3),groupInk=await pixels(figureBytes(grouped));
  const labelOwners=group.physicalLines.map(line=>layout.blocks.find(block=>block.fragments.includes(line)).line);
  assert.deepEqual(grouped.sourceLines,labelOwners);assert.ok(!document.nodes.some(node=>node!==grouped&&node.sourceLines.some(line=>labelOwners.includes(line))));
  assert.ok(groupInk.rgba.some((value,index)=>index%4===3&&value===0),'the group keeps transparent original space between raster panels');
  let labelDark=0,imageDark=0;const imageBottom=Math.round((layout.references.find(ref=>ref.id===group.referenceIds[0]).y+100-group.y)*2);
  for(let y=0;y<groupInk.height;y++)for(let x=0;x<groupInk.width;x++) {const index=(y*groupInk.width+x)*4;if(groupInk.rgba[index+3]&&groupInk.rgba[index]<100&&groupInk.rgba[index+1]<100&&groupInk.rgba[index+2]<100){if(y>=imageBottom)labelDark++;else imageDark++;}}
  assert.ok(labelDark>50,'the group native image retains only its audited pure panel labels');assert.equal(imageDark,0);
  const ownedFormula=document.nodes.find(node=>node.sourceLines.includes(formula.line));assert.equal(ownedFormula.type,'formula');assert.ok(ownedFormula.image);
  const formulaInk=await pixels(figureBytes(ownedFormula));assert.ok(formulaInk.rgba.some((value,index)=>index%4===3&&value>0));
  const loading=pdfjs.getDocument({data:new Uint8Array(await readFile(exported.outputPath)),useSystemFonts:false}),printed=await loading.promise;
  try {
    let text='',imageCount=0;
    for(let page=1;page<=printed.numPages;page++) {const output=await printed.getPage(page),ops=await output.getOperatorList();text+=(await output.getTextContent()).items.map(item=>item.str??'').join('');imageCount+=ops.fnArray.filter(op=>op===pdfjs.OPS.paintImageXObject).length;}
    assert.equal(text.split('Translated overlay label').length-1,1,'real Chromium emits the overlay translation exactly once');assert.doesNotMatch(text,/Readable overlay label/);
    assert.match(text,/Translated formula context/);assert.match(text,/Translated figure caption/);assert.ok(imageCount>=4,'real Chromium embeds the three figure assets and independent native formula');
  }finally {await loading.destroy();}
  assert.deepEqual(await readFile(original),originalBytes,'the original PDF bytes stay immutable');
  if(process.env.YN_PDF_RASTER_EVIDENCE) {const evidence=path.resolve(process.env.YN_PDF_RASTER_EVIDENCE);await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'source-image.png'),png);for(const figure of figures)await writeFile(path.join(evidence,`figure-page${figure.sourcePages[0]}.png`),figureBytes(figure));await writeFile(path.join(evidence,'raster-printed.pdf'),await readFile(exported.outputPath));await writeFile(path.join(evidence,'raster-document.json'),JSON.stringify(document,null,2));await writeFile(path.join(evidence,'raster-result.json'),JSON.stringify({pass:true,figureCalls:calls,standaloneForeignDarkPixels:0,groupLabelDarkPixels:labelDark,sourceUnchanged:true,nativeChromium:true},null,2));}
  console.log('Raster figure crops keep only owned image paints and pure group labels; foreign PDF prose/formula stays independently owned through real Chromium export');
}finally {try {await rm(root,{recursive:true,force:true});}finally {await service?.close();}}
