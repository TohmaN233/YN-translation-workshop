import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {Type} from 'typebox';
import {StorageBackedSession as Session} from '@earendil-works/pi-agent-core/node';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {appendYnSessionHostState, createProofreadHostState, getYnHostStateLoadDiagnostics, loadYnSessionHostState, proofreadDocumentHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';
import {createTranslationAlignmentHostState} from '../../src/main/agent/piNative/translationAlignmentState.ts';
import {readSessionConversation, readSessionEntries, appendSessionCustomEntry} from '../helpers/pi-session.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-prompt-responsiveness-'));
let service,repository,release;
try {
 repository=new PiSessionRepository(root);
 const seed=await repository.create('responsive-owner');
 const state={schemaVersion:1,ownerSessionId:seed.metadata.id,proofread:createProofreadHostState(),translationAlignment:createTranslationAlignmentHostState()};
 const doc=proofreadDocumentHostState(state.proofread,'chapter.txt');
 for(let i=1;i<=80;i++){doc.sampledLines.push(i);await appendYnSessionHostState(seed,state);}
 let ticks=0,beating=true;const beat=()=>{if(beating){ticks++;setImmediate(beat);}};setImmediate(beat);
 try {await loadYnSessionHostState(seed,seed.metadata.id);}finally{beating=false;}
 assert.ok(ticks>=10,`cold Host replay must service the event loop throughout history, saw ${ticks} heartbeats`);
 console.log('ok cold Host replay yields while still validating all checkpoints and deltas');
 await repository.close();repository=undefined;

 const faux=fauxProvider({tokensPerSecond:100000});
 faux.setResponses([
  fauxAssistantMessage(fauxToolCall('remember',{line:81}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('first done')),
  fauxAssistantMessage(fauxToolCall('remember',{line:82}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('second done')),
  fauxAssistantMessage(fauxText('third done'))
 ]);
 const models=createModels();models.setProvider(faux.provider);
 let holdNextWrite=false,writing=0,maxWriting=0,entered;
 const heldSnapshots=[];
 service=new PiNativeSessionService({
  appendHostState:async(...args)=>{
   writing++;maxWriting=Math.max(maxWriting,writing);
   try {if(holdNextWrite){holdNextWrite=false;heldSnapshots.push(args[1]);entered();await new Promise(r=>{release=r;});}await appendYnSessionHostState(...args);}finally{writing--;}
  },
  createModelSelection:async()=>({models,model:faux.getModel(),providerId:faux.provider.id,modelId:faux.getModel().id}),
  createTools:context=>[{name:'remember',label:'remember',description:'Record a sampled line',parameters:Type.Object({line:Type.Number()}),execute:async(_id,args)=>{
   proofreadDocumentHostState(context.proofreadState,'chapter.txt').sampledLines.push(args.line);
   return {content:[{type:'text',text:'recorded'}],details:{}};
  }}]
 });
 const request={outputDir:root,sessionId:'responsive-owner',prompt:'remember',providerId:faux.provider.id,modelId:faux.getModel().id};
 async function turn(){await service.prompt(request);await [...service.active.values()][0].promptTask;}
 await turn();const owner=[...service.active.values()][0];const coldCount=getYnHostStateLoadDiagnostics(owner.session).reconstructedStateCount;
 // This live mutation has not been written yet. A new runtime must not call it
 // durable merely because it already exists in its warm in-memory owner.
 proofreadDocumentHostState(owner.hostState.proofread,'chapter.txt').sampledLines.push(999);
 await turn();const second=[...service.active.values()][0];
 assert.equal(getYnHostStateLoadDiagnostics(second.session).reconstructedStateCount,coldCount,'each warm message must not replay the full historical Host chain');
 assert.equal(second.hostState.proofread,owner.hostState.proofread,'the current owned Host object must be retained');
 assert.equal(second.hostPersistence,owner.hostPersistence,'replacement runtime writers must share their native persistence chain');
 const blocked=new Promise(r=>{entered=r;});holdNextWrite=true;
 proofreadDocumentHostState(second.hostState.proofread,'chapter.txt').sampledLines.push(1001);
 const oldWrite=second.persistHostState();await blocked;
 proofreadDocumentHostState(second.hostState.proofread,'chapter.txt').sampledLines.push(1002);
 const replacing=turn();await new Promise(r=>setTimeout(r,20));
 assert.equal(maxWriting,1,'replacement must not race an unfinished old-owner delta append');
 assert.ok(!heldSnapshots[0].proofread.documents['chapter.txt'].sampledLines.includes(1002),'a queued write must retain its own immutable snapshot');
 release();await oldWrite;await replacing;
 await service.disposeWorkspace(root);service=undefined;
 repository=new PiSessionRepository(root);const cold=await repository.open('responsive-owner');
 const loaded=await loadYnSessionHostState(cold,cold.metadata.id);
 assert.deepEqual(loaded.proofread.documents['chapter.txt'].sampledLines,[...Array.from({length:82},(_,i)=>i+1),999,1001,1002]);
 const telemetry=(await readSessionEntries(cold)).filter(e=>e.type==='custom'&&e.customType==='yn_prompt_preparation');
 assert.deepEqual(telemetry.map(e=>e.data.hostStateSource),['replayed','owned','owned']);
 assert.ok(telemetry.every(e=>Number.isFinite(e.data.elapsedMs)));
 assert.ok(!(await readSessionConversation(cold)).messages.some(m=>m.customType==='yn_prompt_preparation'),'preparation timing must stay outside model context');
 console.log('ok successive actual Pi service prompts reuse warm Host state and persist unsaved mutations');
 await repository.close();repository=undefined;
 let selectionCalls=0,stopping,armed=true;
 service=new PiNativeSessionService({createModelSelection:async()=>{selectionCalls++;return {models,model:faux.getModel(),providerId:faux.provider.id,modelId:faux.getModel().id};}});
 const originalBranch=Session.prototype.branch;
 Session.prototype.branch=async function(...args){
  const branch=await originalBranch.apply(this,args);
  if(armed&&this.metadata.id==='responsive-owner'&&branch){armed=false;const originalFind=branch.findEntries.bind(branch);branch.findEntries=async(...findArgs)=>{
   const entries=await originalFind(...findArgs);setImmediate(()=>{stopping=service.abort(root,'responsive-owner');});return entries;
  };}
  return branch;
 };
 try {
  await assert.rejects(service.prompt(request),error=>error.name==='AbortError');
  await stopping;
  assert.equal(selectionCalls,0,'Stop during yielded cold Host replay must prevent model preparation');
  assert.equal(service.active.size,0,'cancelled cold replay must not install a runtime owner');
  console.log('ok Stop interrupts actual cold Host replay before provider selection or owner commit');
 }finally{Session.prototype.branch=originalBranch;}
 await service.disposeWorkspace(root);service=undefined;
 repository=new PiSessionRepository(root);const corrupt=await repository.open('responsive-owner');
 await appendSessionCustomEntry(corrupt,'yn.host-state.v2',{schemaVersion:2,runtimeContractVersion:2,ownerSessionId:'responsive-owner',projectPathsVersion:1,mode:'delta',baseHash:'corrupted-base',stateHash:'corrupted-result',operations:[]});
 await repository.close();repository=undefined;
 service=new PiNativeSessionService({createModelSelection:async()=>{selectionCalls++;throw new Error('provider must not be reached');}});
 await assert.rejects(service.prompt(request),/does not match its preceding checkpoint/);
 assert.equal(selectionCalls,0,'cold replay must reject corrupt durable history before preparing a provider');
 console.log('ok yielded cold replay still rejects a corrupted trailing delta before model work');
}finally{release?.();if(service)await service.disposeWorkspace(root);if(repository)await repository.close();await rm(root,{recursive:true,force:true});}
