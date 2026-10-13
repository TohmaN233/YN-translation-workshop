import {isMainThread,workerData} from 'node:worker_threads';
// Isolated process preload: inject a failure after real PDF.js cleanup, without
// any production-only test hooks or interrupting native decoder construction.
if(!isMainThread&&workerData?.kind==='extract') {
  const {DOMMatrix,ImageData,Path2D}=await import('@napi-rs/canvas');
  Object.assign(globalThis,{DOMMatrix,ImageData,Path2D});
  const {PDFDocument}=await import('pdf-lib'),pdf=await PDFDocument.create();pdf.addPage();
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=pdfjs.getDocument({data:await pdf.save()});await task.promise;await task.destroy();
  const prototype=Object.getPrototypeOf(task),destroy=prototype.destroy;
  prototype.destroy=async function(){await destroy.call(this);throw new Error('injected PDF loader destroy failure');};
}
