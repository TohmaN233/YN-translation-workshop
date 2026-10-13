import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {preparePdfDocument} from '../src/main/pdfDocuments.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-cancel-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let page=0;page<3;page++)pdf.addPage([600,800]).drawText('A compressed PDF page for cancellation safety.',{x:40,y:700,size:12,font});
  const original=path.join(root,'cancel.pdf');await writeFile(original,await pdf.save());
  const durations=[];
  // Exercise the real page-completion boundary repeatedly: terminate() here
  // can interrupt the next page's native zlib constructor and abort all Node.
  for(let iteration=0;iteration<20;iteration++) {
    const workspace=path.join(root,String(iteration),'.translation-workshop');await mkdir(workspace,{recursive:true});
    const controller=new AbortController();let requestedAt;
    await assert.rejects(preparePdfDocument(original,workspace,{signal:controller.signal,onProgress:()=>{
      if(controller.signal.aborted)return;requestedAt=performance.now();controller.abort(new Error('cancel at page boundary'));
    }}),/cancel at page boundary/);
    assert.ok(requestedAt);durations.push(performance.now()-requestedAt);
    const events=(await readFile(path.join(workspace,'pdf/events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(events.at(-1).event,'cancelled','worker must really finish before cancellation is recorded');
    assert.ok(!events.some(event=>event.event==='completed'));
  }
  console.log(JSON.stringify({pass:true,cancellations:durations.length,maxCleanupMs:Math.max(...durations),forcedThreadTermination:false}));
} finally {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'yn-pdf-cancel-'));await rm(root,{recursive:true,force:true});}
