import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText,getCurrentSystemPrompt} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {readSessionEntries} from '../../src/main/agent/piNative/sessionAccess.ts';
async function runCase(mode) {
const trailingEmpty=mode==='recover-trailing-empty';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-auto-review-recovery-'));
const source=path.join(root,'source.txt');
await writeFile(source,`ソロモン：ここで待っている。\n${trailingEmpty?'':'ソロモン：次の場所へ行こう。'}\n`);
if(process.argv.includes('--saved-rules')){await mkdir(path.join(root,'.translation-workshop'),{recursive:true});await writeFile(path.join(root,'.translation-workshop','project.json'),JSON.stringify({customPreserveRules:[{pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}]}));}
const models=createModels();
const parent=fauxProvider({provider:'auto-recovery-parent',tokensPerSecond:100000});
const worker=fauxProvider({provider:'auto-recovery-worker',tokensPerSecond:100000});
for(const p of [parent,worker])models.setProvider(p.provider);
const tool=(name,args={})=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
parent.setResponses([tool('inspectTranslationContext'),tool('runTranslationSubagents'),fauxAssistantMessage(fauxText('The background queue is running.')),
 tool('validateTranslationArtifact'),fauxAssistantMessage(fauxText('Translation completed.'))]);
let service,injected=false,reviewStarts=0;
const response=async(context)=>{
 const system=getCurrentSystemPrompt(context.messages);
 const results=context.messages.filter(m=>m.role==='toolResult');
 if(system.includes('translation safety reviewer')){
  if(!results.length){
   reviewStarts++;
   if(mode==='new-failure'&&injected)await rm(source);
   if(!injected){
    injected=true;
    const active=[...service.active.values()][0];
    const scope=active.hostState.translationAlignment.ranges['source.txt'][0];
    scope.checks.find(check=>check.line===2).verdict='aligned';
    await active.persistHostState({force:true});
    if(mode==='source-changed')await writeFile(source,'ソロモン：原文が変わった。\nソロモン：次の場所へ行こう。\n');
    await writeFile(scope.candidatePath,`ソロモン：我会在这里等候。\n${trailingEmpty?'':'ソロモン：去下一个地方吧。'}\n`);
   }
   return tool('readAssignedTranslationReview');
  }
  return tool('submitTranslationReview',{failures:[]});
 }
 if(!results.length)return tool('readAssignedSource');
 if(!results.some(r=>r.toolName==='writeAssignedTranslation')){
  const blocks=results.find(r=>r.toolName==='readAssignedSource').details.sourceBlocks;
  return tool('writeAssignedTranslation',{blocks:blocks.map(block=>({id:block.id,lines:block.absoluteLines.map((line,index)=>index.toString(36)+
    (line===1?'ソロモン：在这里等待。':trailingEmpty?'':'ソロモン：去下一个地方吧。'))}))});
 }
 return tool('validateAssignedTranslation');
};
worker.setResponses(Array.from({length:40},()=>response));
service=new PiNativeSessionService({enforceDomainCompletion:true,
 createModelSelection:async({providerId})=>{const p=providerId==='auto-recovery-worker'?worker:parent;return {models,model:p.getModel(),providerId:p.provider.id,modelId:p.getModel().id};},
 createTools:context=>{
  const tools=createYnDomainTools(context);
  if(mode==='stop')context.recoverReviewBinding=async(_error,signal)=>new Promise((resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   if(signal.aborted)reject(signal.reason);
  });
  return tools;
 },buildSystemPrompt:()=> 'Inspect the source, start the queue. When completed validate and report.'});
try{
 const session=await service.createSession(root);
 await service.prompt({outputDir:root,sourcePath:source,sessionId:session.id,prompt:'Workflow: yn-translation-v1.\nTranslate the complete source.',languagePair:'ja->zh-CN',
  providerId:parent.provider.id,modelId:parent.getModel().id,subagentProviderId:worker.provider.id,subagentModelId:worker.getModel().id,
  customPreserveRules:[{pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}],subagentEnabled:true,subagentCount:1,splitSize:500,glossaryCandidates:false,characterBible:false});
 const active=[...service.active.values()][0];
 const deadline=Date.now()+12000;
 let entries;
 while(Date.now()<deadline){
  entries=await readSessionEntries(active.session);
  if((mode==='source-changed'||mode==='new-failure')&&active.error&&!active.subagents.hasRunning()&&!active.reviewBindingRecovery?.pending)break;
  if(mode==='stop'&&entries.some(e=>e.type==='custom'&&e.customType==='yn_review_binding_recovery'&&e.data.phase==='preflight')){
   await service.abort(root,session.id);
   entries=await readSessionEntries(active.session);
   break;
  }
  if(entries.some(e=>e.type==='custom'&&e.customType==='yn_review_binding_recovery'&&e.data.phase==='restarted')
    && !active.subagents.hasRunning())break;
  await new Promise(r=>setTimeout(r,25));
 }
 console.log(JSON.stringify({mode,error:active.error,reviewStarts,batches:active.subagents.list().map(b=>({kind:b.kind,status:b.status,error:b.error})),
  recovery:entries.filter(e=>e.type==='custom'&&e.customType==='yn_review_binding_recovery').map(e=>e.data)}));
 if(mode!=='recover'&&!trailingEmpty){
  assert.equal(reviewStarts,mode==='new-failure'?2:1,'terminal failures cannot restart another model');
  assert.equal(active.hostState.workflowSuspended,true);
  assert.equal(active.subagents.hasRunning(),false);
  if(mode!=='new-failure')assert.equal(entries.some(e=>e.type==='custom'&&e.customType==='yn_review_binding_recovery'&&e.data.phase==='restarted'),false);
  if(mode==='source-changed')assert.equal(entries.some(e=>e.type==='custom'&&e.customType==='yn_review_binding_recovery'),false);
  if(mode==='new-failure')assert.match(active.error,/Required workflow file is missing/);
  console.log(`PASS ${mode} remains stopped without automatic model restart`);
  return;
 }
 assert.ok(entries.some(e=>e.type==='custom'&&e.customType==='yn_review_binding_recovery'&&e.data.phase==='restarted'),'Host must restart automatically without another user prompt');
 assert.ok(reviewStarts>=2,'fresh reviewer must reread rebuilt evidence');
 assert.ok(active.subagents.list().some(b=>b.kind==='translation-review'&&b.status==='completed'));
 const recoveryReceipt=entries.find(e=>e.type==='message'&&e.message.role==='custom'&&e.message.customType==='yn_review_binding_recovery');
 assert.equal(recoveryReceipt?.message.details.retainedCheckCount,1,'unchanged accepted row keeps its exact evidence');
 assert.equal(active.hostState.workflowSuspended,false);
 const scope=active.hostState.translationAlignment.ranges['source.txt'][0];
 assert.ok(scope.checks.every(c=>c.verdict==='aligned'));
 assert.match(await readFile(scope.candidatePath,'utf8'),/我会在这里等候/,'current edited candidate is preserved');
 console.log('PASS actual Service stops stale owners, Host rebuilds evidence, and resumes the retained queue automatically');
} finally {await service.disposeWorkspace(root);await rm(root,{recursive:true,force:true});}
}
for(const mode of process.argv.includes('--saved-rules')?['recover']:['recover','source-changed','stop','recover-trailing-empty','new-failure'])await runCase(mode);
