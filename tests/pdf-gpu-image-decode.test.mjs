import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument,OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {renderPdfReflowHtml} from '../src/main/pdfReflow.ts';
import {configurePdfPrintBackend,printPdfHtml} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';

const directory=await mkdtemp(path.resolve('.translation-workshop/pdf-gpu-decode-'));
let service;
try {
  const font=pathToFileURL(path.resolve('assets/fonts/NotoSansSC-Regular.ttf')).href;
  const canvas=createCanvas(14,17),context=canvas.getContext('2d');
  const parts=Array.from({length:320},(_,index)=>{
    context.fillStyle=`rgb(${index%256},${Math.floor(index/256)},73)`;context.fillRect(0,0,14,17);
    return {token:`glyph-${index}`,image:{dataUrl:canvas.toDataURL('image/png'),width:7,height:8.5}};
  });
  const document={nodes:[{id:'many-glyphs',type:'paragraph',sourceLines:[105],sourcePages:[9],parts}]};
  const source=path.join(directory,'source.html'),output=path.join(directory,'output.pdf');
  await writeFile(source,renderPdfReflowHtml(document,font));
  // The old helper always disabled GPU and missed the real production failure
  // at image 257. Keep this regression on the default accelerated renderer.
  service=await createNativePdfPrintBackend({disableGpu:false});configurePdfPrintBackend(service.backend);
  await printPdfHtml(source,output);
  const loader=getDocument({data:new Uint8Array(await readFile(output))});
  try {
    const pdf=await loader.promise;let images=0;
    for(let page=1;page<=pdf.numPages;page++){
      const operators=await (await pdf.getPage(page)).getOperatorList();
      images+=operators.fnArray.filter(op=>op===OPS.paintImageXObject||op===OPS.paintInlineImageXObject).length;
    }
    assert.equal(images,320,'Every source glyph must survive printing beyond the GPU decode-cache limit');
  } finally {await loader.destroy();}
  const previous=await readFile(output);
  document.nodes[0].parts[256].image.dataUrl='data:image/png;base64,AAAA';
  await writeFile(source,renderPdfReflowHtml(document,font));
  await assert.rejects(printPdfHtml(source,output),error=>{
    assert.match(error.message,/image 257 failed to decode/);
    assert.match(error.message,/many-glyphs/);assert.match(error.message,/sourceLines.*105/);
    return true;
  });
  assert.deepEqual(await readFile(output),previous,'A genuinely corrupt PNG must not replace the last PDF');
  console.log('PASS default-GPU 320-image export, complete printed glyph coverage and corrupt-image atomic rejection');
} finally {configurePdfPrintBackend();await service?.close();await rm(directory,{recursive:true,force:true});}
