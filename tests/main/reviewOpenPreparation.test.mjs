import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {renderLineReviewHtml,renderBatchLineReviewIndexHtml,LINE_REVIEW_PROTOCOL_MARKER,BATCH_LINE_REVIEW_PROTOCOL_MARKER} from '../../src/shared/core/html.ts';
import {portableReviewHtml} from '../../src/main/reviewHtmlPortability.ts';
import * as preparation from '../../src/main/reviewHtmlUpgrade.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-review-open-')),htmlDir=path.join(root,'.translation-workshop','html');
await mkdir(path.join(htmlDir,'batch'),{recursive:true});
const rows=count=>Array.from({length:count},(_,index)=>`Source row ${index+1}: the complete original sentence.`).join('\n');
const files=[],children=[];
try {
  for(let index=0;index<20;index++) {
    const file=path.join(htmlDir,'batch',`part-${index}.html`);children.push(file);
    const html=renderLineReviewHtml({title:`Part ${index}`,sourceText:rows(5000),translationText:'',lineReviewPath:file,workflow:{outputDir:root,sourcePath:path.join(root,`part-${index}.txt`)}});
    await writeFile(file,portableReviewHtml(html,file));
    files.push({sourceName:`part-${index}.txt`,sourcePath:path.join(root,`part-${index}.txt`),outputPath:`batch/part-${index}.html`,status:'missing-translation',sourceLineCount:5000});
  }
  const index=path.join(htmlDir,'index.html'),single=path.join(htmlDir,'single.html');
  await writeFile(index,portableReviewHtml(renderBatchLineReviewIndexHtml({title:'Modern index',files,workflow:{outputDir:root,sourcePath:root,sourceKind:'folder'}}),index));
  await writeFile(single,portableReviewHtml(renderLineReviewHtml({title:'Large review',sourceText:rows(50000),translationText:'',lineReviewPath:single,workflow:{outputDir:root,sourcePath:path.join(root,'source.txt')}}),single));
  const nativeRead=fs.promises.readFile,reads=[];
  fs.promises.readFile=async(...args)=>{const result=await nativeRead(...args);reads.push({file:path.resolve(String(args[0])),bytes:Buffer.byteLength(result)});return result;};syncBuiltinESMExports();
  const measure=async(name,file)=>{reads.length=0;const started=performance.now();const value=preparation.prepareReviewHtmlOpen?await preparation.prepareReviewHtmlOpen(file):await preparation.upgradeLegacyReviewHtmlTree(file);return {value,metric:{name,elapsedMs:performance.now()-started,readCount:reads.length,readBytes:reads.reduce((total,read)=>total+read.bytes,0),childContentReads:reads.filter(read=>children.includes(read.file)).length}};};
  const metrics=[];
  try {
    for(const [name,file]of [['single-cold',single],['single-warm',single],['modern-batch-cold',index],['modern-batch-warm',index]]) {
      const result=await measure(name,file);metrics.push(result.metric);
      if(!process.env.YN_REVIEW_OPEN_BASELINE) {
        assert.ok(result.value.payload,'the returned context contains real parsed document rows, not a loading shell');
        if(file===single)assert.equal(result.value.payload.rows.length,50000);
        else {assert.equal(result.value.payload.files.length,20);assert.equal(result.metric.childContentReads,0,'modern index opening must not load unrelated child documents');}
        assert.equal(result.metric.readCount,1,'one target open reads its HTML contents once');
      }
    }
    if(!process.env.YN_REVIEW_OPEN_BASELINE) {
      await writeFile(index,(await nativeRead(index,'utf8')).replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER,'translation-workshop-batch-review-v10'));
      const result=await measure('previous-modern-batch-cold',index);metrics.push(result.metric);
      assert.equal(result.value.changed,true,'previous modern index gets the lazy frame hook');
      assert.equal(result.metric.readCount,1);assert.equal(result.metric.childContentReads,0,'v10 index migration must not eagerly parse its twenty children');
    }
  }finally {fs.promises.readFile=nativeRead;syncBuiltinESMExports();}
  console.log(JSON.stringify({phase:process.env.YN_REVIEW_OPEN_BASELINE?'baseline':'after',metrics}));
  if(process.env.YN_REVIEW_OPEN_EVIDENCE){await mkdir(path.resolve(process.env.YN_REVIEW_OPEN_EVIDENCE),{recursive:true});await writeFile(path.join(process.env.YN_REVIEW_OPEN_EVIDENCE,process.env.YN_REVIEW_OPEN_BASELINE?'baseline.json':'after.json'),JSON.stringify({metrics,rows:50000,childCount:20,childRows:5000},null,2));}
  if(process.env.YN_REVIEW_OPEN_BASELINE)process.exitCode=0;
  else {
    const before=await readFile(children[0],'utf8'),legacy=before.replace(LINE_REVIEW_PROTOCOL_MARKER,'translation-workshop-line-review-v0');
    await writeFile(children[0],legacy);await preparation.prepareReviewHtmlOpen(index);
    assert.equal(await readFile(children[0],'utf8'),legacy,'an unrelated stale child waits until it is actually opened');
    const opened=await preparation.prepareReviewHtmlOpen(children[0]);assert.equal(opened.payload.rows.length,5000);assert.equal(opened.changed,true);assert.match(await readFile(children[0],'utf8'),new RegExp(LINE_REVIEW_PROTOCOL_MARKER));
    const stamp=await preparation.readReviewHtmlSourceStamp(single);assert.equal((await preparation.prepareReviewHtmlOpen(single)).sourceStamp,stamp);
    await writeFile(single,(await readFile(single,'utf8')).replace('Large review','Changed review'));assert.notEqual(await preparation.readReviewHtmlSourceStamp(single),stamp,'same-process warm reuse invalidates when the actual HTML epoch changes');
  }
}finally {assert.ok(root.startsWith(path.join(os.tmpdir(),'yn-review-open-')));await rm(root,{recursive:true,force:true});}
