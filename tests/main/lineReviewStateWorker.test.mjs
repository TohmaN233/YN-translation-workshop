import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {commitLineReviewStateInWorker} from '../../src/main/lineReviewStateWorkerService.ts';
const project=await mkdtemp(path.join(os.tmpdir(),'yn-line-state-'));
try{
 const statePath=path.join(project,'.translation-workshop','state','line.json');await mkdir(path.dirname(statePath),{recursive:true});
 const base={documentRevision:4,edits:{1:'older',2:'manual'},status:{2:'manual'},revisions:{2:7},revisionHistory:{2:[{text:'manual'}]},translationPath:path.join(project,'target.txt')};
 await writeFile(statePath,JSON.stringify(base));
 const args={statePath,projectRoot:project,state:{edits:{1:'new'}},changedLines:[1],changedStateKeys:[],mutationAccepted:true,hydrate:false};
 const patch=await commitLineReviewStateInWorker(args);
 assert.equal(patch.documentRevision,5);assert.deepEqual(patch.edits,{1:'new'});assert.equal(patch.edits[2],undefined);
 const stored=JSON.parse(await readFile(statePath,'utf8'));assert.equal(stored.translationPath,'target.txt');assert.equal(stored.edits[2],'manual');assert.equal(stored.revisions[2],7);
 await assert.rejects(commitLineReviewStateInWorker({...args,expectedRevision:4}),/draft changed during import/);
 assert.equal(JSON.parse(await readFile(statePath,'utf8')).documentRevision,5,'CAS rejection leaves draft untouched');
 const full=await commitLineReviewStateInWorker({...args,state:{},changedLines:[],hydrate:true});assert.equal(full.edits[2],'manual');assert.equal(full.translationPath,path.join(project,'target.txt'));
 await writeFile(statePath,'bad json');await assert.rejects(commitLineReviewStateInWorker(args),/JSON/);
 console.log('Worker commit preserves manual rows/revisions, relative bindings, sparse acknowledgements and CAS/errors');
}finally{await rm(project,{recursive:true,force:true});}
