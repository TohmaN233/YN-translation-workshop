import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {preparePdfDocument} from './pdf-structure-backend.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-cleanup-fault-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let page=0;page<3;page++)pdf.addPage([600,800]).drawText('Cancellation cleanup failure must be visible.',{x:40,y:700,size:12,font});
  const original=path.join(root,'cancel.pdf'),workspace=path.join(root,'.translation-workshop');
  await writeFile(original,await pdf.save());await mkdir(workspace,{recursive:true});
  const controller=new AbortController(),progressFailure=process.argv[2]==='progress';
  const reason=progressFailure?'injected PDF progress failure':'cancel at page boundary';
  await assert.rejects(preparePdfDocument(original,workspace,{signal:controller.signal,onProgress:()=>{
    if(progressFailure)throw new Error(reason);
    if(!controller.signal.aborted)controller.abort(new Error(reason));
  }}),error=>{
    assert.ok(error instanceof AggregateError||error.cause instanceof AggregateError,'primary and cleanup failures are both retained');
    assert.match(error.message,new RegExp(reason));assert.match(error.message,/injected PDF loader destroy failure/);
    assert.match(error.message,/cancel\.pdf/);return true;
  });
  const events=(await readFile(path.join(workspace,'pdf/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event,'failed','cleanup failure must not be reported as an ordinary cancellation');
  assert.match(events.at(-1).error,new RegExp(reason));assert.match(events.at(-1).error,/injected PDF loader destroy failure/);
  assert.ok(!events.some(event=>event.event==='completed'));
  console.log(JSON.stringify({pass:true,primaryReason:reason,cleanupFailureVisible:true,forcedThreadTermination:false}));
} finally {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'yn-pdf-cleanup-fault-'));await rm(root,{recursive:true,force:true});}
