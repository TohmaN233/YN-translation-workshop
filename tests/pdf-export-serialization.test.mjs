import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-concurrent-'));
try {
  const source=await PDFDocument.create(),page=source.addPage([600,800]);page.drawText('Complete source paragraph.',{x:40,y:740,font:await source.embedFont(StandardFonts.Helvetica),size:12});
  const original=path.join(root,'source.pdf');await writeFile(original,await source.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const output=await PDFDocument.create();output.addPage();const bytes=await output.save();
  let startFirst,releaseFirst;
  const firstStarted=new Promise(resolve=>startFirst=resolve),gate=new Promise(resolve=>releaseFirst=resolve),observed=[];
  configurePdfPrintBackend(async htmlPath=>{if(!observed.length){startFirst();await gate;}const html=await readFile(htmlPath,'utf8');observed.push(html.includes('TARGET-A')?'A':html.includes('TARGET-B')?'B':'other');return bytes;});
  const args={templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root};
  const first=createTranslatedPdf({...args,translatedLines:['TARGET-A']});await firstStarted;
  const secondLines=['TARGET-B'],second=createTranslatedPdf({...args,translatedLines:secondLines});secondLines[0]='CHANGED AFTER REQUEST';
  const cancellation=new AbortController(),cancelled=createTranslatedPdf({...args,translatedLines:['CANCELLED'],signal:cancellation.signal});cancellation.abort(new Error('cancel queued print'));
  const cancelledResult=assert.rejects(cancelled,/cancel queued print/);
  // Stop a queued request while A still owns the print gate. The canceled
  // caller must settle promptly; its serialization barrier must remain behind
  // A so the next non-canceled export cannot overtake the active owner.
  let cancelDeadline;
  try {
    await Promise.race([cancelledResult,new Promise((_,reject)=>{cancelDeadline=setTimeout(()=>reject(new Error('Queued PDF cancellation waited for the active print owner.')),1000);})]);
    assert.deepEqual(observed,[], 'Queued cancellation does not release the active print or let B prepare over its source.');
  } catch(error) {releaseFirst();throw error;}
  finally {clearTimeout(cancelDeadline);}
  // Hold the source-loading phase long enough for a second worker to overwrite
  // a shared source if prepare and print are not owned by one serialization.
  await new Promise(resolve=>setTimeout(resolve,1200));releaseFirst();
  await Promise.all([first,second,cancelledResult]);assert.deepEqual(observed,['A','B']);
  assert.ok((await readFile(path.join(root,'AI_translation','source.translated.html'),'utf8')).includes('TARGET-B'));
  const last=await createTranslatedPdf({...args,translatedLines:['TARGET-A']});assert.equal(last.pages,1,'cancelled queued export releases its ownership');
  console.log('Concurrent PDF source preparation/printing retains request identity; queued cancellation and immutable target snapshots pass');
}finally{configurePdfPrintBackend();await rm(root,{recursive:true,force:true});}
