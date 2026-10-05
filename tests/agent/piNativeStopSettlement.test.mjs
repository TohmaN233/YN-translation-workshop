import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Type} from 'typebox';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {appendYnSessionHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {appendSessionMessage,readSessionEntries} from '../../src/main/agent/piNative/sessionAccess.ts';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core/node';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),3000);})]);}finally{clearTimeout(timer);}}

// Exercise the actual native turn and Service transition; an exiting Host tool
// needs to persist its last child card while Stop waits for that turn to exit.
for(const mode of ['publish','stop','suspend','dispose','persistence-failure']){
 const dir=await mkdtemp(path.join(os.tmpdir(),'yn-stop-settlement-'));
 const entered=deferred(),release=deferred(),escape=deferred();
 const source=path.join(dir,'source.txt');await writeFile(source,'Source sentence.\n');
 const provider=fauxProvider({provider:`stop-settle-${mode}`,tokensPerSecond:100_000});
 const models=createModels();models.setProvider(provider.provider);
 provider.setResponses([fauxAssistantMessage(fauxToolCall('publish',{}),{stopReason:'toolUse'})]);
 let armed=false,publicationFinished=false,stopTask,active;
 const service=new PiNativeSessionService({
  createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),
  appendHostState:async(...args)=>{if(armed)throw new Error('Injected Stop checkpoint failure');return appendYnSessionHostState(...args);},
  buildSystemPrompt:()=> 'Publish a Host status.',enforceDomainCompletion:mode==='persistence-failure',
  createTools:context=>[{name:'publish',label:'Publish',description:'Publish Host status',parameters:Type.Object({}),
   async execute(){entered.resolve();await release.promise;
    await Promise.race([context.publishCustomMessage({role:'custom',customType:'stop-test',content:'status',display:false,timestamp:Date.now()}).then(()=>{publicationFinished=true;}),escape.promise]);
    return {content:[{type:'text',text:'done'}],details:{},terminate:true};}
  }]
 });
 try{
  const session=await service.createSession(dir);
  await service.prompt({outputDir:dir,sourcePath:source,sessionId:session.id,prompt:mode==='persistence-failure'?'Workflow: yn-translation-v1.\nPublish.':'Publish.',
   ...(mode==='persistence-failure'?{workflowIntent:'translation',languagePair:'en->zh-CN'}:{}),providerId:provider.provider.id,modelId:provider.getModel().id});
  await bounded(entered.promise,'Host tool did not start');active=[...service.active.values()][0];
  const requestAbort=active.runtime.requestAbort.bind(active.runtime);
  active.runtime.requestAbort=()=>{requestAbort();release.resolve();};
  if(mode==='publish'){release.resolve();await bounded(active.promptTask,'Same-turn Host publication deadlocked');}
  else{
   armed=mode==='persistence-failure';
   stopTask=mode==='suspend'?service.suspendWorkspace(dir):mode==='dispose'?service.disposeWorkspace(dir):service.abort(dir,session.id);
   if(armed){
    const duplicateStop=assert.rejects(service.abort(dir,session.id),/Injected Stop checkpoint failure/);
    await assert.rejects(bounded(stopTask,'Stop deadlocked on persistence failure'),/Injected Stop checkpoint failure/);
    await duplicateStop;
   }
   else await bounded(stopTask,'Stop deadlocked on Host publication');
   assert.equal(active.running,false);assert.equal(active.subagents.hasRunning(),false);
  }
  assert.equal(publicationFinished,true);assert.equal(provider.state.callCount,1);
  if(mode==='persistence-failure')assert.equal(active.hostState.workflowSuspended,true);
 }finally{
  armed=false;escape.resolve();release.resolve();active?.runtime.requestAbort();
  await stopTask?.catch(()=>{});await active?.promptTask;
  await service.disposeWorkspace(dir);await rm(dir,{recursive:true,force:true});
 }
 console.log(`ok native ${mode} settles Host publication and preserves explicit persistence errors`);
}

// Stop also revokes native compaction; it must not wait while holding the
// transition that compaction uses to publish its final state.
{
 const dir=await mkdtemp(path.join(os.tmpdir(),'yn-stop-compaction-'));
 const entered=deferred(),release=deferred();
 const provider=fauxProvider({provider:'stop-compaction',tokensPerSecond:100_000});
 const models=createModels();models.setProvider(provider.provider);
 provider.setResponses([async()=>{entered.resolve();await release.promise;return fauxAssistantMessage('Stopped summary.');}]);
 const service=new PiNativeSessionService({createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),buildSystemPrompt:()=> 'Compact.'});
 try{
  const selected=await service.createSession(dir),session=await new PiSessionRepository(dir).open(selected.id);
  for(let i=0;i<14;i++){
   await appendSessionMessage(session,{role:'user',content:[{type:'text',text:'u'.repeat(5000)}],timestamp:i*2});
   await appendSessionMessage(session,fauxAssistantMessage('a'.repeat(5000)));
  }
  await session.close(BACKGROUND_CONTEXT);
  const compacting=service.compact({outputDir:dir,sessionId:selected.id,providerId:provider.provider.id,modelId:provider.getModel().id,thinkingLevel:'off'});
  const compactRejected=assert.rejects(compacting,error=>error.name==='AbortError');
  await bounded(entered.promise,'Native compaction did not enter provider');
  const active=[...service.active.values()][0],requestAbort=active.runtime.requestAbort.bind(active.runtime);
  active.runtime.requestAbort=()=>{requestAbort();release.resolve();};
  await bounded(service.abort(dir,selected.id),'Stop deadlocked during native compaction');await compactRejected;
  assert.equal(active.compacting,false);assert.equal(active.running,false);
  const entries=await readSessionEntries(active.session);
  assert.equal(entries.filter(entry=>entry.type==='compaction').length,0);
  const stop=entries.filter(entry=>entry.type==='custom'&&entry.customType==='yn_workflow_stop');
  assert.deepEqual(stop.map(entry=>entry.data.phase),['requested','settled']);
  assert.deepEqual(stop[1].data.errors,[]);
  console.log('ok Stop cancels actual native compaction without committing a late summary');
 }finally{release.resolve();await service.disposeWorkspace(dir);await rm(dir,{recursive:true,force:true});}
}
