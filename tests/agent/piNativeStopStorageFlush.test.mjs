import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {getDiskSessionAccess,iterateSessionEntries,getOpenDiskSession} from '../../src/main/agent/piNative/sessionAccess.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-stop-index-'));
const provider=fauxProvider({tokensPerSecond:100000});provider.setResponses(Array.from({length:8},()=>fauxAssistantMessage(fauxText('Ready'))));
const models=createModels();models.setProvider(provider.provider);
const service=new PiNativeSessionService({createTools:()=>[],createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})});
const request=(dir,id)=>({outputDir:dir,sessionId:id,prompt:'Hello',providerId:provider.provider.id,modelId:provider.getModel().id});
try{
 const session=await service.createSession(root);await service.prompt(request(root,session.id));
 const active=[...service.active.values()][0];await active.promptTask;
 for(let i=0;i<30;i++){active.hostState.proofread.documents.chapter={sampledLines:[i+1],reportInitialized:true,completedSplitScopes:[],glossaryCandidates:[]};await active.persistHostState();}
 await service.abort(root,session.id);
 const file=active.session.metadata.path,index=JSON.parse(await readFile(file+'.yn-index.json','utf8')).index;
 assert.ok(index.hostRestorePoint,'idle Stop must save the latest Host restore point without requiring session.close');
 assert.equal(index.committedBytes,(await stat(file)).size);
 assert.deepEqual(index.hostRestorePoint.current.proofread.documents.chapter.sampledLines,[30]);
 const idleBytes=(await stat(file)).size;await service.abort(root,session.id);
 assert.equal((await stat(file)).size,idleBytes,'repeated idle Stop must not create artificial native transactions');
 const storage=getDiskSessionAccess(active.session).storage,flush=storage.flushDerivedIndex.bind(storage);
 let release;const held=new Promise(resolve=>{release=resolve});let entered;const began=new Promise(resolve=>{entered=resolve});let calls=0;
 storage.flushDerivedIndex=async()=>{calls++;entered();await held;return flush()};
 const first=service.abort(root,session.id);await began;const second=service.abort(root,session.id);let accepted=false;
 const next=service.prompt(request(root,session.id)).then(()=>{accepted=true});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(accepted,false,'new prompt waits for the complete Stop flush');release();await Promise.all([first,second,next]);await active.promptTask;assert.equal(calls,1);
 storage.flushDerivedIndex=async()=>{throw new Error('simulated derived-index failure')};
 await assert.rejects(service.abort(root,session.id),/simulated derived-index failure/);
 const failureEntries=[];for await(const entry of iterateSessionEntries(active.session,{type:'custom',customType:'yn_session_storage_flush'}))failureEntries.push(entry.data);
 assert.ok(failureEntries.some(entry=>entry.phase==='failed'),'flush failure remains visible in native session diagnostics');
 storage.flushDerivedIndex=flush;await service.abort(root,session.id);
 assert.equal(service.active.size,1,'Stop keeps the warm owner available');
 await service.disposeAll();assert.equal(service.active.size,0);
 await assert.rejects(service.createSession(root),/shutting down/);
 await assert.rejects(service.loadMessages(root,session.id),/shutting down/);
 await assert.rejects(service.loadSubagentMessages(root,session.id,'child'),/shutting down/);
 console.log('Stop saves the native restore point, coalesces flushes, blocks conflicting prompts and reports failures; desktop disposal closes owners');
}finally{service.resumeAfterCancelledShutdown?.();await service.disposeWorkspace(root);await rm(root,{recursive:true,force:true});}

// Desktop shutdown must cover both a warm owner and another workspace whose
// first prompt is still preparing. No cancelled preparation may start a model.
{
 const fixture=await mkdtemp(path.join(os.tmpdir(),'yn-desktop-owners-'));
 const warmRoot=path.join(fixture,'warm'),coldRoot=path.join(fixture,'cold');
 let entered,release;const began=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 const faux=fauxProvider({tokensPerSecond:100000});faux.setResponses([fauxAssistantMessage(fauxText('Ready'))]);
 const catalog=createModels();catalog.setProvider(faux.provider);
 let selections=0;
 const owners=new PiNativeSessionService({createTools:()=>[],createModelSelection:async()=>{
  if(++selections===2){entered();await gate;}
  return {models:catalog,model:faux.getModel(),providerId:faux.provider.id,modelId:faux.getModel().id};
 }});
 try{
  const warm=await owners.createSession(warmRoot),cold=await owners.createSession(coldRoot);
  const prompt=dir=>({outputDir:dir,sessionId:dir===warmRoot?warm.id:cold.id,prompt:'Hello',providerId:faux.provider.id,modelId:faux.getModel().id});
  await owners.prompt(prompt(warmRoot));await [...owners.active.values()][0].promptTask;
  const warmFile=[...owners.active.values()][0].session.metadata.path;
  let lockEntered,unlock;const lockBegan=new Promise(resolve=>{lockEntered=resolve}),lockGate=new Promise(resolve=>{unlock=resolve});
  const holding=owners.withSessionTransition(warmRoot,warm.id,async()=>{lockEntered();await lockGate});await lockBegan;
  const queuedReader=assert.rejects(owners.loadMessages(warmRoot,warm.id),/shutting down/);
  const preparing=owners.prompt(prompt(coldRoot));const rejected=assert.rejects(preparing,error=>error.name==='AbortError');await began;
  const shutdown=owners.disposeAll();assert.equal(owners.disposeAll(),shutdown,'concurrent desktop exits share disposal');
  await assert.rejects(owners.prompt(prompt(warmRoot)),/shutting down/);
  release();unlock();await Promise.all([shutdown,rejected,holding,queuedReader]);
  assert.equal(owners.active.size,0);assert.equal(getOpenDiskSession(warmFile),undefined);
  const repository=new PiSessionRepository(coldRoot),metadata=await repository.findMetadata(cold.id);assert.equal(getOpenDiskSession(metadata.path),undefined);
  assert.equal(faux.state.callCount,1,'cancelled cold preparation must not reach the provider');
  owners.resumeAfterCancelledShutdown();await owners.createSession(coldRoot);
  console.log('Desktop disposal awaits every workspace, cancels cold preparation and rejects racing model work');
 }finally{release();owners.resumeAfterCancelledShutdown();await owners.disposeWorkspace(warmRoot);await owners.disposeWorkspace(coldRoot);await rm(fixture,{recursive:true,force:true});}
}

// Existing transcript reads must finish and close their cold native handles
// before shutdown resolves. New reads are rejected until failure UI resets it.
for(const mode of ['parent','child']){
 const fixture=await mkdtemp(path.join(os.tmpdir(),'yn-desktop-reader-'));
 const owners=new PiNativeSessionService(),repository=new PiSessionRepository(fixture);
 let entered,release,file;const began=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 const originalOpen=PiSessionRepository.prototype.open,originalChildRead=PiSessionRepository.prototype.withChildSessionReadForParent;
 try{
  const parent=await owners.createSession(fixture),child=await repository.createChild('fixture-child',parent.id);await repository.close();
  if(mode==='parent')PiSessionRepository.prototype.open=async function(...args){
   const session=await originalOpen.apply(this,args);file=session.metadata.path;entered();await gate;return session;
  };
  else PiSessionRepository.prototype.withChildSessionReadForParent=function(id,parentId,reader){
   return originalChildRead.call(this,id,parentId,async session=>{file=session.metadata.path;entered();await gate;return reader(session)});
  };
  const reading=mode==='parent'?owners.loadMessages(fixture,parent.id):owners.loadSubagentMessages(fixture,parent.id,child.metadata.id);
  const readOutcome=reading.then(value=>({value}),error=>({error}));await began;
  let finished=false;const closing=owners.disposeAll().then(()=>{finished=true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false);assert.ok(getOpenDiskSession(file),'fixture read is holding a real native handle');
  await assert.rejects(owners.loadMessages(fixture,parent.id),/shutting down/);
  release();const result=await readOutcome;await closing;
  if(result.error)assert.equal(result.error.name,'AbortError');assert.equal(getOpenDiskSession(file),undefined);
  PiSessionRepository.prototype.open=originalOpen;PiSessionRepository.prototype.withChildSessionReadForParent=originalChildRead;
  owners.resumeAfterCancelledShutdown();assert.ok(Array.isArray(await owners.loadMessages(fixture,parent.id)));
  console.log(`Desktop disposal settles the existing ${mode} transcript reader and blocks late admission`);
 }finally{
  release();PiSessionRepository.prototype.open=originalOpen;PiSessionRepository.prototype.withChildSessionReadForParent=originalChildRead;
  owners.resumeAfterCancelledShutdown();await owners.disposeWorkspace(fixture);await repository.close();await rm(fixture,{recursive:true,force:true});
 }
}

for(const fault of ['index-save','native-close']){
 const fixture=await mkdtemp(path.join(os.tmpdir(),'yn-desktop-retry-'));
 const faux=fauxProvider({tokensPerSecond:100000});faux.setResponses([fauxAssistantMessage(fauxText('Ready'))]);
 const catalog=createModels();catalog.setProvider(faux.provider);
 const owners=new PiNativeSessionService({createTools:()=>[],createModelSelection:async()=>({models:catalog,model:faux.getModel(),providerId:faux.provider.id,modelId:faux.getModel().id})});
 let restore=()=>{};
 try{
  const selected=await owners.createSession(fixture);await owners.prompt({outputDir:fixture,sessionId:selected.id,prompt:'Hello',providerId:faux.provider.id,modelId:faux.getModel().id});
  const active=[...owners.active.values()][0];await active.promptTask;
  active.hostState.proofread.documents.chapter={sampledLines:[42],reportInitialized:true,completedSplitScopes:[],glossaryCandidates:[]};await active.persistHostState();
  const file=active.session.metadata.path,storage=getDiskSessionAccess(active.session).storage;
  if(fault==='index-save'){
   const refresh=storage.refreshIndex;storage.refreshIndex=async()=>{throw new Error('temporary index save failure')};restore=()=>{storage.refreshIndex=refresh};
  }else{
   const close=active.session.close.bind(active.session);active.session.close=async(...args)=>{await close(...args);throw new Error('reported terminal native close failure')};
  }
  await assert.rejects(owners.disposeAll(),/Desktop Pi session disposal failed/);
  if(fault==='index-save'){
   assert.equal(owners.active.size,1);assert.equal(getOpenDiskSession(file),active.session,'failed pre-close save must retain a usable owner for retry');
  }else{
   assert.equal(owners.active.size,0);assert.equal(getOpenDiskSession(file),undefined);
   const index=JSON.parse(await readFile(file+'.yn-index.json','utf8')).index;assert.deepEqual(index.hostRestorePoint.current.proofread.documents.chapter.sampledLines,[42],'retired closed owner must already have a durable latest restore window');
  }
  restore();owners.resumeAfterCancelledShutdown();await owners.disposeAll();assert.equal(owners.active.size,0);assert.equal(getOpenDiskSession(file),undefined);
  const index=JSON.parse(await readFile(file+'.yn-index.json','utf8')).index;assert.deepEqual(index.hostRestorePoint.current.proofread.documents.chapter.sampledLines,[42]);assert.equal(index.committedBytes,(await stat(file)).size);
  owners.resumeAfterCancelledShutdown();assert.ok(Array.isArray(await owners.loadMessages(fixture,selected.id)));
  console.log(`Desktop retry after ${fault} preserves the latest Host restore window and never reuses a sealed owner`);
 }finally{restore();owners.resumeAfterCancelledShutdown();await owners.disposeWorkspace(fixture);await rm(fixture,{recursive:true,force:true});}
}
