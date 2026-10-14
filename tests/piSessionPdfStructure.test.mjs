import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Type} from 'typebox';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../src/main/agent/piNative/sessionService.ts';
import {PiSessionRepository} from '../src/main/agent/piNative/sessionRepository.ts';
import {readSessionEntries,getOpenDiskSession} from '../src/main/agent/piNative/sessionAccess.ts';
import {PDF_STRUCTURE_PREPARATION_ENTRY} from '../src/main/agent/piNative/sessionStructurePreparation.ts';
import {NonRetryableAssignmentError} from '../src/main/agent/piNative/assignmentFailure.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),5000);})]);}finally{clearTimeout(timer);}}
async function fixture(name,extra={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-structure-'+name+'-'));
 const provider=fauxProvider({provider:'pdf-structure-'+name,tokensPerSecond:100000});
 const models=createModels();models.setProvider(provider.provider);
 const service=new PiNativeSessionService({createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),...extra});
 return{root,provider,models,service,request:{outputDir:root,systemPrompt:'Inspect source structure only.',prompt:'Source spans SECRET-PDF-CONTENT'},
  async close(){await service.disposeWorkspace(root);await rm(root,{recursive:true,force:true});}};
}
async function audit(f,id){
 const repo=new PiSessionRepository(f.root),metadata=await repo.findMetadata(id);
 assert.equal(getOpenDiskSession(metadata.path),undefined,'preparation must close its native handle before returning');
 const file=await readFile(metadata.path,'utf8'),index=JSON.parse(await readFile(metadata.path+'.yn-index.json','utf8')).index;
 assert.equal(index.committedBytes,(await stat(metadata.path)).size,'latest JSONL tail must be durable');
 const session=await repo.open(id);try{return{metadata,file,entries:await readSessionEntries(session)};}finally{await repo.close();}
}
{
 let normalTools=0,normalContext;
 const f=await fixture('completion',{createTools:()=>{normalTools++;return[{name:'normalTool',label:'Normal',description:'Normal project tool',parameters:Type.Object({}),execute:async()=>({content:[],details:{}})}];},buildSystemPrompt:()=> 'NORMAL-SYSTEM'});
 f.provider.setResponses([
  async context=>{assert.deepEqual(context.tools??[],[]);return fauxAssistantMessage(fauxText('{"groups":[[1,2]]}'));},
  async context=>{assert.ok(!JSON.stringify(context).includes('SECRET-PDF-CONTENT'),'next PDF sees reset context');return fauxAssistantMessage(fauxText('{"groups":[[3,4]]}'));},
  async context=>{normalContext=context;return fauxAssistantMessage(fauxText('Normal continuation complete.'));}
 ]);
 const events=[],states=[];f.service.subscribeEvents(e=>events.push(e));f.service.subscribeState((_,s)=>states.push(s));
 try{
  const empty=await f.service.createSession(f.root);
  const result=await f.service.runPdfStructurePreparation({...f.request,sessionId:empty.id});
  assert.equal(result.sessionId,empty.id);assert.equal(result.text,'{"groups":[[1,2]]}');assert.equal(result.providerId,f.provider.provider.id);
  assert.equal(normalTools,0,'structure cannot call the ordinary domain tool factory');assert.equal(f.service.hasActiveWork(f.root),false);
  const first=await audit(f,empty.id),stages=first.entries.filter(e=>e.type==='custom'&&e.customType===PDF_STRUCTURE_PREPARATION_ENTRY);
  assert.deepEqual(stages.map(e=>e.data.phase),['preparing','started','completed']);assert.equal(stages.at(-1).data.contextReset,true);
  assert.equal(events.some(e=>e.event.type==='abort'),false,'successful preparation must not emit a misleading Stop');
  await f.service.runPdfStructurePreparation({...f.request,sessionId:empty.id,prompt:'Second source spans.'});
  assert.ok(states.some(s=>s.running));assert.ok(events.some(e=>e.event.type==='message_update'));
  await f.service.prompt({outputDir:f.root,sessionId:empty.id,prompt:'Continue the normal task.',providerId:f.provider.provider.id,modelId:f.provider.getModel().id});
  await bounded([...f.service.active.values()][0].promptTask,'normal prompt did not finish');
  assert.equal(normalTools,1);assert.ok(JSON.stringify(normalContext).includes('normalTool'));
  assert.ok(!JSON.stringify(normalContext).includes('SECRET-PDF-CONTENT'));assert.ok(!JSON.stringify(normalContext).includes('"groups"'));
  await assert.rejects(f.service.runPdfStructurePreparation({...f.request,sessionId:empty.id}),/existing Agent session/);
  console.log('ok PDF structure waits for native result, writes JSONL, resets cold context and restores ordinary tools');
 }finally{await f.close();}
}
{
 let toolCalls=0;
 const f=await fixture('host-tools');
 f.provider.setResponses([fauxAssistantMessage(fauxToolCall('inspectSource',{}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('{"nodes":[]}'))]);
 try{
  const result=await f.service.runPdfStructurePreparation({...f.request,tools:[{name:'inspectSource',label:'Inspect',description:'Host source inspection',parameters:Type.Object({}),
   async execute(){toolCalls++;return{content:[{type:'text',text:'Known source spans'}],details:{sourceHash:'fixture'}};}}]});
  assert.equal(toolCalls,1);assert.equal(result.text,'{"nodes":[]}');await audit(f,result.sessionId);
  console.log('ok PDF structure receives only explicit Host tools in the native runtime');
 }finally{await f.close();}
}
for(const mode of ['signal','stop','shutdown']){
 const entered=deferred(),release=deferred();
 const f=await fixture('cancel-'+mode),controller=new AbortController();
 f.provider.setResponses([fauxAssistantMessage(fauxToolCall('inspectSource',{}),{stopReason:'toolUse'})]);
 try{
  const session=await f.service.createSession(f.root);
  const prep=f.service.runPdfStructurePreparation({...f.request,sessionId:session.id,signal:controller.signal,tools:[{name:'inspectSource',label:'Inspect',description:'Source work retaining native ownership until release',parameters:Type.Object({}),
   async execute(){entered.resolve();await release.promise;return{content:[{type:'text',text:'inspection stopped'}],details:{}};}}]});
  const rejected=assert.rejects(prep,error=>error.name==='AbortError');await bounded(entered.promise,'source tool not entered');
  assert.equal(f.service.hasActiveWork(f.root),true);
  await assert.rejects(f.service.prompt({outputDir:f.root,sessionId:session.id,prompt:'Race ordinary work.'}),/structure preparation is still running/);
  let ended=false;
  const stopping=mode==='signal'?(controller.abort(),prep.catch(()=>{})):mode==='shutdown'?f.service.disposeAll():f.service.abort(f.root,session.id);
  const stopFinished=stopping.then(()=>{ended=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false,'Stop must wait for the real native source tool');
  release.resolve();await bounded(Promise.all([rejected,stopFinished]),'structure cancellation did not settle');
  assert.equal(f.service.hasActiveWork(f.root),false);assert.equal(f.service.active.size,0);
  const saved=await audit(f,session.id),receipt=saved.entries.filter(e=>e.type==='custom'&&e.customType===PDF_STRUCTURE_PREPARATION_ENTRY).at(-1);
  assert.equal(receipt.data.phase,'cancelled');assert.equal(receipt.data.contextReset,true);
  console.log('ok PDF '+mode+' cancellation waits for source tools and closes the native indexed Session');
 }finally{release.resolve();f.service.resumeAfterCancelledShutdown();await f.close();}
}
{
 const entered=deferred(),release=deferred();
 const f=await fixture('selection-stop');
 f.service.options.createModelSelection=async()=>{entered.resolve();await release.promise;return{models:f.models,model:f.provider.getModel(),providerId:f.provider.provider.id,modelId:f.provider.getModel().id};};
 try{
  const session=await f.service.createSession(f.root);
  const prep=f.service.runPdfStructurePreparation({...f.request,sessionId:session.id});
  const rejected=assert.rejects(prep,error=>error.name==='AbortError');await entered.promise;
  const stopping=f.service.abort(f.root,session.id);release.resolve();await bounded(Promise.all([rejected,stopping]),'selection cancellation deadlocked');
  assert.equal(f.provider.state.callCount,0);await audit(f,session.id);
  console.log('ok Stop during model selection prevents any provider turn and closes storage');
 }finally{release.resolve();await f.close();}
}
for(const mode of ['empty','provider-error','selection-error']){
 const f=await fixture(mode);
 if(mode==='selection-error')f.service.options.createModelSelection=async()=>{throw new Error('Selection cannot authenticate');};
 else f.provider.setResponses([mode==='empty'?fauxAssistantMessage(fauxText('')):fauxAssistantMessage(fauxText(''),{stopReason:'error',errorMessage:'invalid API key'})]);
 try{
  const session=await f.service.createSession(f.root);
  await assert.rejects(f.service.runPdfStructurePreparation({...f.request,sessionId:session.id}),mode==='empty'?/empty structure response/:mode==='provider-error'?/invalid API key/:/cannot authenticate/);
  await audit(f,session.id);assert.equal(f.service.hasActiveWork(f.root),false);
  console.log('ok PDF structure '+mode+' rejects without a successful preparation receipt');
 }finally{await f.close();}
}

{
 const f=await fixture('workflow-rejection');
 try{
  const summary=await f.service.createSession(f.root),repo=new PiSessionRepository(f.root),session=await repo.open(summary.id);
  const {appendYnSessionHostState,createProofreadHostState,loadYnSessionHostState}=await import('../src/main/agent/piNative/proofreadSessionState.ts');
  const {createTranslationAlignmentHostState}=await import('../src/main/agent/piNative/translationAlignmentState.ts');
  await appendYnSessionHostState(session,{schemaVersion:1,ownerSessionId:summary.id,taskPreparation:{id:'existing-task',intent:'translation'},
   proofread:createProofreadHostState(),translationAlignment:createTranslationAlignmentHostState()});
  await repo.close();
  await assert.rejects(f.service.runPdfStructurePreparation({...f.request,sessionId:summary.id}),/existing workflow/);
  assert.equal(f.provider.state.callCount,0);
  const checkingRepo=new PiSessionRepository(f.root),check=await checkingRepo.open(summary.id);assert.equal((await loadYnSessionHostState(check,summary.id)).taskPreparation.id,'existing-task');await checkingRepo.close();
  await audit(f,summary.id);
  console.log('ok cold workflow session cannot be replaced or reset by PDF preparation');
 }finally{await f.close();}
}
{
 const f=await fixture('flush-failure');let storage,flush;
 f.provider.setResponses([async()=>{
  const active=[...f.service.active.values()][0];
  const {getDiskSessionAccess}=await import('../src/main/agent/piNative/sessionAccess.ts');
  storage=getDiskSessionAccess(active.session).storage;flush=storage.flushDerivedIndex.bind(storage);
  storage.flushDerivedIndex=async()=>{throw new Error('Injected PDF index flush failure');};
  return fauxAssistantMessage(fauxText('{"nodes":[]}'));
 }]);
 try{
  const session=await f.service.createSession(f.root);
  await assert.rejects(f.service.runPdfStructurePreparation({...f.request,sessionId:session.id}),/Injected PDF index flush failure/);
  assert.equal(f.service.active.size,1,'failed durable flush retains its owner for an observable retry');
  const active=[...f.service.active.values()][0],entries=await readSessionEntries(active.session);
  const last=entries.filter(e=>e.type==='custom'&&e.customType===PDF_STRUCTURE_PREPARATION_ENTRY).at(-1);
  assert.equal(last.data.phase,'failed');assert.equal(last.data.stage,'native-cleanup');
  assert.match((await f.service.getRunState(f.root,session.id)).error,/flush failure/);
  storage.flushDerivedIndex=flush;await f.service.disposeWorkspace(f.root);await audit(f,session.id);
  console.log('ok native persistence failure rejects and keeps diagnostics/owner until cleanup can succeed');
 }finally{if(storage)storage.flushDerivedIndex=flush;await f.close();}
}

for(const mode of ['close-failure','typed-and-close-failure']){
 const f=await fixture(mode),create=PiSessionRepository.prototype.create;let captured,close,closeCalls=0;
 const typed=new NonRetryableAssignmentError('Typed source ownership failure',new Error('Exact physical owner evidence'));
 PiSessionRepository.prototype.create=async function(...args){
  const session=await create.apply(this,args);captured=session;close=session.close.bind(session);
  session.close=async()=>{closeCalls++;throw new Error('Injected native close failure');};return session;
 };
 f.provider.setResponses([mode==='close-failure'?fauxAssistantMessage(fauxText('{}')):fauxAssistantMessage(fauxToolCall('inspectSource',{}),{stopReason:'toolUse'})]);
 try{
  let failure;
  await assert.rejects(f.service.runPdfStructurePreparation({...f.request,tools:mode==='close-failure'?[]:[{
   name:'inspectSource',label:'Inspect',description:'A typed fatal source failure',parameters:Type.Object({}),execute:async()=>{throw typed;}
  }]}),error=>{failure=error;return error instanceof AggregateError&&/native close failure/.test(error.message);});
  PiSessionRepository.prototype.create=create;
  if(mode==='typed-and-close-failure'){
   const find=(error,predicate)=>predicate(error)||error?.cause&&find(error.cause,predicate)||error instanceof AggregateError&&error.errors.some(item=>find(item,predicate));
   assert.ok(find(failure,error=>error instanceof NonRetryableAssignmentError&&/Typed source ownership failure/.test(error.message)),'cleanup aggregation preserves typed fatal cause');
   assert.ok(find(failure,error=>error?.message==='Exact physical owner evidence'),'wrapped failure retains exact diagnostic cause');
  }
  assert.equal(f.provider.state.callCount,1,'fatal/cleanup failure cannot trigger another paid/model turn');
  assert.equal(f.service.active.size,1);assert.equal(f.service.hasActiveWork(f.root),true,'failed close retains live owner and work visibility');
  assert.ok(getOpenDiskSession(captured.metadata.path),'native handle remains owned after close fails');
  await assert.rejects(f.service.prompt({outputDir:f.root,sessionId:captured.metadata.id,prompt:'Race storage cleanup.'}),/cleanup must finish/);
  await assert.rejects(f.service.disposeWorkspace(f.root),/native close failure/);assert.equal(f.service.active.size,1);assert.ok(closeCalls>=2);
  const entries=await readSessionEntries(captured),last=entries.filter(entry=>entry.type==='custom'&&entry.customType===PDF_STRUCTURE_PREPARATION_ENTRY).at(-1);
  assert.equal(last.data.phase,'failed');assert.equal(last.data.contextReset,true);
  captured.close=close;await f.service.disposeWorkspace(f.root);assert.equal(f.service.active.size,0);assert.equal(f.service.hasActiveWork(f.root),false);
  await audit(f,captured.metadata.id);
  f.provider.setResponses([async context=>{assert.ok(!JSON.stringify(context).includes('SECRET-PDF-CONTENT'),'cleanup checkpoint preserves cold context isolation');return fauxAssistantMessage(fauxText('{}'));}]);
  await f.service.runPdfStructurePreparation({...f.request,sessionId:captured.metadata.id,prompt:'New isolated source.'});
  console.log('ok '+mode+' preserves typed causes, busy native owner and cold reset until real close retry succeeds');
 }finally{PiSessionRepository.prototype.create=create;if(captured&&close)captured.close=close;await f.close();}
}

console.log('PDF structure preparation uses only native mock providers; no live provider requests.');


for(const mode of ['structured-empty','structured-sdk-invalid-first','structured-sdk-invalid-second']){
 const f=await fixture(mode);let executed=0;
 const submit={name:'submitPdfStructureAudit',label:'Submit',description:'Host typed audit output',parameters:Type.Object({version:Type.Literal(1)},{additionalProperties:false}),execute:async()=>{executed++;return{content:[{type:'text',text:'{"submitted":true}'}],details:undefined};}};
 const tool=value=>fauxAssistantMessage(fauxToolCall('submitPdfStructureAudit',{version:value}),{stopReason:'toolUse'});
 f.provider.setResponses(mode==='structured-sdk-invalid-first'?[tool(0),async context=>{assert.equal(context.messages.filter(message=>message.role==='toolResult').at(-1).isError,true);return tool(1);},fauxAssistantMessage(fauxText(''))]:mode==='structured-sdk-invalid-second'?[tool(1),tool(0),fauxAssistantMessage(fauxText(''))]:[tool(1),fauxAssistantMessage(fauxText(''))]);
 try{
  if(mode==='structured-sdk-invalid-second')await assert.rejects(f.service.runPdfStructurePreparation({...f.request,responseMode:'structured-tool',tools:[submit]}),error=>error instanceof NonRetryableAssignmentError&&/payload was sealed/.test(error.message)&&/version/.test(error.message));
  else{const result=await f.service.runPdfStructurePreparation({...f.request,responseMode:'structured-tool',tools:[submit]});assert.equal(result.text,'');await audit(f,result.sessionId);}
  assert.equal(executed,1,'SDK-invalid input never reaches Host execute');assert.equal(f.service.hasActiveWork(f.root),false);
  console.log('ok '+mode+' enforces Host-only native structured output and post-seal SDK failure authority');
 }finally{await f.close();}
}
