import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {PiSessionAgentRuntime} from '../../src/main/agent/piNative/sessionAgentRuntime.ts';
import {appendYnSessionHostState,loadYnSessionHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
for(const fault of ['first-save','timing-log']){
 const root=await mkdtemp(path.join(os.tmpdir(),'yn-prompt-preparation-fault-'));
 const faux=fauxProvider({tokensPerSecond:100000});faux.setResponses([fauxAssistantMessage(fauxText('Background task is running.'))]);
 const models=createModels();models.setProvider(faux.provider);
 let armed=false,created=false,started=0,settled=0,repository;
 const entered=deferred();
 const originalAppend=PiSessionAgentRuntime.prototype.appendCustomEntry;
 PiSessionAgentRuntime.prototype.appendCustomEntry=async function(type,data){if(armed&&fault==='timing-log'&&type==='yn_prompt_preparation'){armed=false;throw new Error('Injected timing-log failure');}return originalAppend.call(this,type,data);};
 const service=new PiNativeSessionService({
  enforceDomainCompletion:true,
  createModelSelection:async()=>({models,model:faux.getModel(),providerId:faux.provider.id,modelId:faux.getModel().id}),
  appendHostState:async(...args)=>{if(armed&&fault==='first-save'){armed=false;throw new Error('Injected first-save failure');}return appendYnSessionHostState(...args);},
  createTools:context=>{
   if(!created){created=true;
    for(const kind of ['translation','proofread'])context.subagents.startBatch({
     kind,request:context.request,tasks:[{line:1},{line:2}],maxWorkers:1,label:()=>`Held ${kind}`,range:t=>({fromLine:t.line,toLine:t.line}),
     run:async(_task,_request,signal)=>{started++;if(started===2)entered.resolve();if(!signal.aborted)await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw new DOMException('Fixture child stopped','AbortError');},
     onSettled:async()=>{await service.loadMessages(root,context.request.sessionId);settled++;}
    });
   }
   return [];
  }
 });
 try{
  const session=await service.createSession(root);
  const request={outputDir:root,sessionId:session.id,providerId:faux.provider.id,modelId:faux.getModel().id,languagePair:'en->zh-CN',subagentEnabled:true,subagentCount:2};
  await service.prompt({...request,prompt:'Workflow: yn-translation-v1.\nWork in the background.'});
  await entered.promise;await [...service.active.values()][0].promptTask;
  const first=[...service.active.values()][0];assert.equal(first.subagents.hasRunning(),true);
  armed=true;await assert.rejects(service.prompt({...request,prompt:'What is the progress?'}),new RegExp(`Injected ${fault} failure`));
  const active=[...service.active.values()][0];
  assert.equal(active.running,false);assert.equal(active.subagents.hasRunning(),false);
  assert.equal(active.hostState.workflowSuspended,true);assert.equal(active.hostState.domainRun.suspended,true);
  assert.equal(settled,2,'both real supervisor batches must finish lock-reentrant publication before reporting failure');
  assert.equal(started,2,'stopped pools must not claim queued assignments');
  assert.equal(faux.state.callCount,1,'failed preparation must not start another provider turn');
  repository=new PiSessionRepository(root);const cold=await repository.open(session.id);assert.equal((await loadYnSessionHostState(cold,session.id)).workflowSuspended,true);
  console.log(`ok ${fault} stops and settles both actual background supervisor batches before rejecting`);
 }finally{armed=false;PiSessionAgentRuntime.prototype.appendCustomEntry=originalAppend;await service.disposeWorkspace(root);if(repository)await repository.close();await rm(root,{recursive:true,force:true});}
}
