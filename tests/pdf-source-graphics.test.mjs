import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,StandardFonts,rgb,beginMarkedContent,endMarkedContent,PDFName,PDFOperator,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib';
import {loadImage,createCanvas} from '@napi-rs/canvas';
import {readPdfLayout,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';
const service=process.versions.electron?undefined:await createNativePdfPrintBackend();if(service)configurePdfPrintBackend(service.backend);
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-graphics-'));
try {
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Native graphics regression.',{x:40,y:740,size:12,font});
  page.pushOperators(beginMarkedContent('Formula'));page.drawText('1',{x:225,y:660,size:12,font});
  page.drawLine({start:{x:210,y:650},end:{x:250,y:650},thickness:.5,color:rgb(0,0,0)});
  page.pushOperators(endMarkedContent());page.drawText('2',{x:225,y:632,size:12,font});
  page.drawLine({start:{x:80,y:430},end:{x:300,y:570},thickness:4,color:rgb(1,0,0)});
  page.drawCircle({x:200,y:490,size:40,borderWidth:3,borderColor:rgb(0,0,1)});
  page.drawText('Figure 1: Native vector graph',{x:40,y:380,size:12,font});
  page.drawText('This complete sentence continues',{x:40,y:60,size:12,font});page.drawText('1',{x:290,y:15,size:10,font});
  pdf.addPage([600,800]).drawText('on the following source page.',{x:40,y:740,size:12,font});
  const original=path.join(root,'graphics.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop')),layout=await readPdfLayout(prepared.sourcePath,root);
  assert.ok(layout.physicalBlocks.some(block=>block.nativePathOperations?.length),'fraction rule has a protected source owner');
  assert.equal(layout.references.filter(ref=>ref.kind==='vector').length,1,'connected independent vector strokes form one figure');
  const crossPage=layout.blocks.find(block=>block.text.startsWith('This complete'));assert.ok(crossPage.text.endsWith('on the following source page.'));assert.equal(crossPage.fragments.length,2,'actual extracted page continuation joins once');
  const translated=layout.blocks.map(block=>block.protection?block.text:block.text.startsWith('Figure')?'图 1：原始矢量图':'原生图形验证。');
  const result=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:translated});
  const document=JSON.parse(await readFile(result.documentPath,'utf8'));
  const formula=document.nodes.find(node=>node.type==='formula'),figure=document.nodes.find(node=>node.type==='figure');assert.ok(formula&&figure);
  async function pixels(image){const decoded=await loadImage(Buffer.from(image.dataUrl.split(',')[1],'base64')),canvas=createCanvas(decoded.width,decoded.height);try{canvas.getContext('2d').drawImage(decoded,0,0);return {width:canvas.width,height:canvas.height,data:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data};}finally{canvas.width=canvas.height=1;}}
  const fraction=await pixels(formula.image);let longest=0;
  for(let y=0;y<fraction.height;y++){let run=0;for(let x=0;x<fraction.width;x++){const index=(y*fraction.width+x)*4;run=fraction.data[index+3]>0&&fraction.data[index]<100?run+1:0;longest=Math.max(longest,run);}}
  assert.ok(longest>=70,'actual native formula PNG retains the full forty-point fraction bar');
  const diagram=await pixels(figure.image);let red=false,blue=false;for(let i=0;i<diagram.data.length;i+=4){red||=diagram.data[i]>180&&diagram.data[i+1]<80&&diagram.data[i+2]<80;blue||=diagram.data[i+2]>180&&diagram.data[i]<80&&diagram.data[i+1]<80;}
  assert.ok(red&&blue,'source vector figure retains both painted components');assert.ok(result.pages>0);
  const tablePdf=await PDFDocument.create(),tablePage=tablePdf.addPage([600,800]),tableFont=await tablePdf.embedFont(StandardFonts.Helvetica);
  tablePage.drawText('Table 5: Complete data.',{x:40,y:740,size:12,font:tableFont});
  tablePage.drawText('Subset and accuracy values',{x:80,y:705,size:12,font:tableFont});
  for(const [text,x,y]of [['aho',80,680],['0.844',220,680],['bcd',80,660],['0.511',220,660]])tablePage.drawText(text,{x,y,size:12,font:tableFont});
  for(const y of [715,645])tablePage.drawLine({start:{x:74,y},end:{x:260,y},thickness:.5,color:rgb(0,0,0)});
  const tablePath=path.join(root,'table.pdf');await writeFile(tablePath,await tablePdf.save());
  const tablePrepared=await preparePdfDocument(tablePath,path.join(root,'.translation-workshop')),tableLayout=await readPdfLayout(tablePrepared.sourcePath,root);
  const tableExport=await createTranslatedPdf({templatePath:tablePath,sourcePath:tablePrepared.sourcePath,projectRoot:root,translatedLines:tableLayout.blocks.map(block=>block.text)});
  const tableDocument=JSON.parse(await readFile(tableExport.documentPath,'utf8')),table=tableDocument.nodes.find(node=>node.type==='table');
  assert.ok(table,'actual extraction keeps caption/header/cell table relationship');assert.ok(table.cells.some(row=>row.length===1),'combined header remains one source unit');assert.ok(table.cells.some(row=>row.length===2),'two source columns remain paired');
  assert.ok((await readFile(tableExport.htmlPath,'utf8')).includes('colspan="2"'),'combined header spans the actual data columns');
  const unsupported=await PDFDocument.create(),gradientPage=unsupported.addPage([600,800]);gradientPage.drawText('Gradient source diagram',{x:40,y:740,size:12,font:await unsupported.embedFont(StandardFonts.Helvetica)});
  const functionRef=unsupported.context.register(unsupported.context.obj({FunctionType:2,Domain:[0,1],C0:[1,0,0],C1:[0,0,1],N:1}));
  const shade=unsupported.context.register(unsupported.context.obj({ShadingType:2,ColorSpace:'DeviceRGB',Coords:[80,430,300,430],Function:functionRef,Extend:[true,true]}));
  gradientPage.node.Resources().set(PDFName.of('Shading'),unsupported.context.obj({Shade:shade}));gradientPage.pushOperators(pushGraphicsState(),rectangle(80,430,220,140),clip(),endPath(),PDFOperator.of('sh',[PDFName.of('Shade')]),popGraphicsState());
  const gradientPath=path.join(root,'unsupported.pdf');await writeFile(gradientPath,await unsupported.save());
  await assert.rejects(preparePdfDocument(gradientPath,path.join(root,'.translation-workshop')),/unsupported source graphic shadingFill/,'unsupported visible gradient cannot silently disappear');
  console.log('Native normal-font fraction bar and connected colored vector diagram survive structured HTML and real Chromium PDF');
}finally{try{await rm(root,{recursive:true,force:true});}finally{await service?.close();}}
