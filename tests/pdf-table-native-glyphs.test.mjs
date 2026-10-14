import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createCanvas,loadImage,DOMMatrix,Path2D,ImageData} from '@napi-rs/canvas';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {readPdfLayout,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {buildPdfReflowDocument} from '../src/main/pdfReflowDocument.ts';
import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';

Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const service=process.versions.electron?undefined:await createNativePdfPrintBackend();
if(service)configurePdfPrintBackend(service.backend);
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-table-native-'));
try {
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]);
  const prose=await pdf.embedFont(StandardFonts.Helvetica),numeric=await pdf.embedFont(StandardFonts.TimesRomanItalic);
  page.drawText('Table 1: Source samples.',{x:40,y:740,size:12,font:prose});
  for(const [text,x,y]of [['Subset',80,700],['Samples',220,700],['alpha',80,680],['120',220,680],['beta',80,660],['500',220,660]]) {
    page.drawText(text,{x,y,size:12,font:/^\d+$/u.test(text)?numeric:prose});
  }
  const original=path.join(root,'table.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const layout=await readPdfLayout(prepared.sourcePath,root);
  const numbers=layout.blocks.filter(block=>/^\d+$/u.test(block.text));
  assert.deepEqual(numbers.map(block=>block.text),['120','500']);
  assert.ok(numbers.every(block=>block.sourceInkPath&&!block.protection),'unmarked numeric cells have explicit isolated native ink');
  assert.ok(layout.structureTables?.some(table=>numbers.every(block=>table.rows.flat().some(cell=>cell.physicalLines.includes(block.fragments[0])))));
  const lines=layout.blocks.map(block=>/^\d+$/u.test(block.text)?block.text:block.text==='alpha'?'甲组':block.text==='beta'?'乙组':block.text);
  const calls=[];
  const image={dataUrl:'data:image/png;base64,AA==',width:1,height:1};
  const built=await buildPdfReflowDocument(layout,lines,{native:async(page,physicalLines)=>{calls.push({page,physicalLines});return image;},inline:async()=>{throw new Error('Unexpected inline glyph');},figure:async()=>{throw new Error('Unexpected source figure');}});
  const table=built.nodes.find(node=>node.type==='table');assert.ok(table);
  for(const block of numbers) {
    assert.ok(calls.some(call=>call.page===block.page&&JSON.stringify(call.physicalLines)===JSON.stringify(block.fragments)),'table numeric cell must use assets.native with its exact physical owner');
    const cell=table.cells.flat().find(cell=>cell.sourceLines.includes(block.line));
    assert.equal(cell.type,'formula');assert.ok(cell.image);assert.equal(cell.parts,undefined);
  }
  assert.ok(table.cells.flat().some(cell=>cell.type==='paragraph'&&cell.parts?.some(part=>part.text==='甲组')),'adjacent prose remains translated editable text');
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:lines});
  const document=JSON.parse(await readFile(exported.documentPath,'utf8'));
  const exportedTable=document.nodes.find(node=>node.type==='table');assert.ok(exportedTable);
  async function rgba(bytes) {
    const ink=await loadImage(bytes),canvas=createCanvas(ink.width,ink.height);
    try {canvas.getContext('2d').drawImage(ink,0,0);return {width:ink.width,height:ink.height,pixels:canvas.getContext('2d').getImageData(0,0,ink.width,ink.height).data};}
    finally {canvas.width=canvas.height=1;}
  }
  const dimensions=[];
  for(const block of numbers) {
    const cell=exportedTable.cells.flat().find(cell=>cell.sourceLines.includes(block.line));
    assert.ok(cell.image,'actual exported numeric table cell retains its source glyph image');
    const source=await rgba(await readFile(block.sourceInkPath)),target=await rgba(Buffer.from(cell.image.dataUrl.split(',')[1],'base64'));
    assert.deepEqual(target,source,'table numeric glyph PNG retains original dimensions and every RGBA pixel');
    dimensions.push([source.width,source.height]);
  }
  const loading=pdfjs.getDocument({data:new Uint8Array(await readFile(exported.outputPath)),useSystemFonts:false}),printed=await loading.promise;
  try {
    const paints=[];let text='';
    for(let page=1;page<=printed.numPages;page++) {
      const output=await printed.getPage(page),ops=await output.getOperatorList();
      ops.fnArray.forEach((op,index)=>{if(op===pdfjs.OPS.paintImageXObject)paints.push(ops.argsArray[index].slice(1,3));});
      text+=(await output.getTextContent()).items.map(item=>item.str??'').join('');
    }
    assert.ok(dimensions.every(dimension=>paints.some(paint=>JSON.stringify(paint)===JSON.stringify(dimension))),'real Chromium PDF embeds both original numeric glyph assets');
    assert.match(text.normalize('NFKC'),/甲组/u);assert.match(text.normalize('NFKC'),/乙组/u);
  } finally {await loading.destroy();}
  console.log('Unmarked italic table numeric cells retain exact native asset ownership and pixels through real Chromium export');
} finally {try {await rm(root,{recursive:true,force:true});}finally {await service?.close();}}
