import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {preparePdfDocument} from '../src/main/pdfDocuments.ts';
import {configurePdfStructurePreparation} from '../src/main/pdfStructurePreparation.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-retention-'));
async function files(directory){return(await Promise.all((await readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]))).flat();}
try {
  const original=path.join(root,'source.pdf'),pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('A complete source paragraph.',{x:40,y:700,font,size:12});await writeFile(original,await pdf.save());
  let attempt=0;
  configurePdfStructurePreparation(async request=>{
    await request.tools.find(tool=>tool.name==='readPdfStructureSource').execute('inspect',{fromLine:1,toLine:1},request.signal);
    return {sessionId:'retained-attempt-'+attempt,providerId:'fixture',modelId:'fixture',text:'Malformed proposal '+attempt};
  });
  const captures=[];
  for(attempt=1;attempt<=2;attempt++){
    await assert.rejects(preparePdfDocument(original,path.join(root,'.translation-workshop')),/structure proposal/);
    const all=await files(root),archives=all.filter(file=>path.basename(file)==='proposal-model-round-1.json');
    assert.equal(archives.length,attempt,'each failed attempt retains a separate model snapshot');
    const matching=[];
    for(const file of archives){const text=await readFile(file,'utf8');if(JSON.parse(text).sessionId==='retained-attempt-'+attempt)matching.push({file,text});}
    assert.equal(matching.length,1);captures.push(matching[0]);
    assert.ok(!all.some(file=>file.endsWith('.pdf-layout.json')||file.endsWith('.html')));
  }
  assert.notEqual(path.dirname(captures[0].file),path.dirname(captures[1].file));
  assert.equal(await readFile(captures[0].file,'utf8'),captures[0].text,'retry cannot replace the prior Host snapshot');
  const events=(await readFile(path.join(root,'.translation-workshop','pdf','events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const retained=events.filter(event=>event.event==='proposal-model-round-1'&&event.retained);
  assert.equal(new Set(retained.map(event=>event.attemptId)).size,2);
  for(const event of retained)assert.equal(await readFile(path.join(root,event.diagnosticPath),'utf8'),captures.find(capture=>capture.file===path.join(root,event.diagnosticPath)).text);
  console.log('ok failed PDF preparation retries retain immutable per-attempt Host snapshots and trace paths without accepting HTML');
}finally{assert.ok(root.startsWith(path.join(os.tmpdir(),'yn-pdf-retention-')));await rm(root,{recursive:true,force:true});}
