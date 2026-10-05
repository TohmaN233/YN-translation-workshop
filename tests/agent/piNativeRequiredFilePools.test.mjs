import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {YnSubagentSupervisor} from '../../src/main/agent/piNative/subagentSupervisor.ts';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const dir=await mkdtemp(path.join(os.tmpdir(),'yn-missing-pools-'));
const source=path.join(dir,'source.txt'),glossary=path.join(dir,'reference','glossary.json');
await mkdir(path.dirname(glossary),{recursive:true});await writeFile(source,'one\ntwo\nthree');
await writeFile(glossary,JSON.stringify({entries:[{source:'one',target:'一'}]}));
await new PiSessionRepository(dir).create('missing-pools-parent');
const models=createModels(),providers=new Map();
for(const id of ['missing-worker','reviewed-worker','review-pool']){const p=fauxProvider({provider:id,tokensPerSecond:100_000});providers.set(id,p);models.setProvider(p.provider);}
const reviewEntered=deferred(),releaseReview=deferred();
const tool=(name,params={})=>fauxAssistantMessage(fauxToolCall(name,params),{stopReason:'toolUse'});
providers.get('missing-worker').setResponses([
 tool('readAssignedSource'),tool('repairAssignedTranslation',{entries:[{line:1,translation:'一'}]}),
 async()=>{await reviewEntered.promise;await rm(glossary);return tool('validateAssignedTranslation');},
 fauxAssistantMessage('Must not retry the missing glossary.')
]);
providers.get('reviewed-worker').setResponses([tool('readAssignedSource'),tool('repairAssignedTranslation',{entries:[{line:2,translation:'二'}]}),tool('validateAssignedTranslation')]);
providers.get('review-pool').setResponses([async()=>{reviewEntered.resolve();await releaseReview.promise;return tool('readAssignedTranslationReview');}]);
const checkpoints=new Map(),messages=[];let fatalError;
const supervisor=new YnSubagentSupervisor({
 publishCustomMessage:async message=>messages.push(message),publishLiveCustomMessage:async message=>messages.push(message),
 notifyParent:async message=>messages.push(message),
 onFatalHostFailure:error=>{fatalError=error;releaseReview.resolve();},
 createModelSelection:async({providerId})=>{const p=providers.get(providerId);assert.ok(p,providerId);return {models,model:p.getModel(),providerId,modelId:p.getModel().id};}
});
let timer;
try{
 supervisor.startTranslationBatch({
  request:{outputDir:dir,sourcePath:source,glossaryPath:glossary,glossaryCandidates:false,sessionId:'missing-pools-parent',prompt:'Translate.',
   languagePair:'en->zh-CN',providerId:'missing-worker',modelId:providers.get('missing-worker').getModel().id,
   subagentProviderId:'review-pool',subagentModelId:providers.get('review-pool').getModel().id},
  tasks:[{documentId:'source.txt',fromLine:1,toLine:1,providerId:'missing-worker'},{documentId:'source.txt',fromLine:2,toLine:2,providerId:'reviewed-worker'},
   {documentId:'source.txt',fromLine:3,toLine:3,providerId:'missing-worker'}],maxWorkers:2,reviewWorkerCount:1,
  onStagingCandidateCheckpoint:async checkpoint=>{checkpoints.set(checkpoint.fromLine,checkpoint.candidatePath);},
  prepareChunkReview:async review=>({task:{auditId:'missing-review',documentId:review.documentId,fromLine:review.fromLine,toLine:review.toLine,riskLineCount:0,sampledLineCount:1},
   read:async()=>({auditId:'missing-review',documentId:review.documentId,fromLine:review.fromLine,toLine:review.toLine,riskLineCount:0,sampledLineCount:1,
    windows:[{fromLine:review.fromLine,toLine:review.toLine,rows:[{line:2,source:'two',translation:'二',selected:true,signals:[]}]}]}),submit:async()=>({accepted:true})})
 });
 await Promise.race([supervisor.waitForAll(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Required-file failure did not settle both native pools')),5000);})]);
 assert.equal(supervisor.hasRunning(),false);assert.equal(fatalError?.retryable,false);assert.ok(fatalError.message.includes(glossary));
 assert.equal(providers.get('missing-worker').state.callCount,3,'never retry the failing task or claim line 3');
 assert.ok(supervisor.list().some(batch=>batch.kind==='translation-review'),'review pool really started');
 assert.equal(checkpoints.size,2);
 for(const [line,file] of checkpoints){assert.ok((await readFile(file,'utf8')).split('\n')[line-1].trim(),'keep both written staging drafts');}
 assert.ok(messages.some(message=>message.customType==='subagent-completion'&&message.details?.failureDisposition==='host_integrity_failure'));
 console.log('ok a missing required file stops real translator/reviewer pools, fences queued work, and retains both staging drafts');
}finally{clearTimeout(timer);releaseReview.resolve();supervisor.abortAll();await supervisor.waitForAll();await rm(dir,{recursive:true,force:true});}
