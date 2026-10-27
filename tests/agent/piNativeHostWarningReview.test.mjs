import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Type} from 'typebox';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core/node';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {PiSessionAgentRuntime} from '../../src/main/agent/piNative/sessionAgentRuntime.ts';
import {IndexedJsonlStorage} from '../../src/main/agent/piNative/indexedJsonlStorage.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {createYnDomainRunContract} from '../../src/main/agent/piNative/domainRunContract.ts';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {createTranslationAlignmentRangeAudit} from '../../src/main/agent/piNative/translationAlignmentState.ts';
import {mergeProjectGlossaryEntries} from '../../src/main/agent/projectAssets.ts';
import {appendSessionCustomEntry} from '../../src/main/agent/piNative/sessionAccess.ts';
import {appendYnSessionHostState,loadYnSessionHostState,createProofreadHostState,createTranslationAlignmentHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';

async function fixture(options={}){
  const outputDir=await mkdtemp(path.join(os.tmpdir(),'yn-host-warning-'));
  const sessionId='synthetic-warning-parent', sourcePath=path.join(outputDir,'source.txt');
  await writeFile(sourcePath,'Synthetic first line.\nSynthetic second line.','utf8');
  const owner=await new PiSessionRepository(outputDir).create(sessionId);
  for(let index=0;index<(options.historyEntries??0);index++)await appendSessionCustomEntry(owner,'synthetic.background',{index,payload:'Synthetic historical observation. '.repeat(256)});
  const domain=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:true,subagentEnabled:false});
  domain.recordInspection({sourceLineCount:2,documents:[{id:'source.txt',sourceLineCount:2}],glossaryCandidateExists:true,characterBibleExists:true});
  domain.recordTranslationWrite('translation');
  const alignment=createTranslationAlignmentHostState();
  if(options.live){
    const candidatePath=path.join(outputDir,'AI_translation','source_translated.txt');
    await mkdir(path.dirname(candidatePath),{recursive:true});
    await writeFile(candidatePath,'第一段人工合成内容。\n第二段人工合成内容。');
    const range=createTranslationAlignmentRangeAudit({documentId:'source.txt',sourceText:'Synthetic first line.\nSynthetic second line.',candidateText:'第一段人工合成内容。\n第二段人工合成内容。',candidatePath,languagePair:'en->zh-CN',fromLine:1,toLine:2,sourceLineCount:2});
    range.checks.forEach(check=>{check.verdict='aligned';});alignment.ranges['source.txt']=[range];
    await mergeProjectGlossaryEntries({outputDir,entries:[{source:'Synthetic',target:'合成专名'}]});
  }else{domain.recordTranslationValidation('translation',2,'source.txt');domain.notePendingTranslationWarningReview();}
  const models=createModels(), provider=fauxProvider({provider:'host-warning-choice',tokensPerSecond:1_000_000,tokenSize:{min:100_000,max:100_000}});
  models.setProvider(provider.provider);
  const request={sourcePath,sourceDocumentId:'source.txt',languagePair:'en->zh-CN',providerId:provider.provider.id,modelId:provider.getModel().id,subagentEnabled:false};
  await appendYnSessionHostState(owner,{schemaVersion:1,ownerSessionId:sessionId,domainRun:domain.snapshot(),...(options.saved?{translationWorkflowRequest:request}:{}),proofread:createProofreadHostState(),translationAlignment:alignment});
  await owner.close(BACKGROUND_CONTEXT);
  let selections=0, finished=0, context;
  const service=new PiNativeSessionService({enforceDomainCompletion:true,
    createModelSelection:async()=>{selections++;await options.beforeSelection?.();return{models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id};},
    appendHostState:options.appendHostState,
    createTools:current=>{context=current;return[...createYnDomainTools(current),{name:'finishReview',label:'Finish review',description:'Complete synthetic review',parameters:Type.Object({}),async execute(){finished++;assert.equal(current.domainRun.translationWarningReviewDecision,'review');await options.beforeFinish?.();current.domainRun.recordFinalValidation('translation','source.txt');return{content:[{type:'text',text:'complete'}]};}}];}
  });
  return{outputDir,sessionId,sourcePath,request,service,provider,get selections(){return selections;},get finished(){return finished;},get context(){return context;},
    async state(){const s=await new PiSessionRepository(outputDir).open(sessionId);try{return await loadYnSessionHostState(s,sessionId,{projectRoot:outputDir});}finally{await s.close(BACKGROUND_CONTEXT);}},
    async clean(){await service.disposeWorkspace(outputDir);await rm(outputDir,{recursive:true,force:true});}};
}
async function settled(service,action){let timer;const promise=new Promise((resolve,reject)=>{const unsub=service.subscribeEvents(event=>{if(event.event.type==='settled'){unsub();clearTimeout(timer);resolve();}});timer=setTimeout(()=>{unsub();reject(new Error('Native turn did not settle'));},5000);});try{await action();await promise;}finally{clearTimeout(timer);}}

test('cold pending choice is read-only, survives reopen, and skip never selects a model',async()=>{
  const f=await fixture();try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    assert.equal(gate?.warningCount,2);assert.equal(f.selections,0);assert.equal(f.service.hasActiveWork(f.outputDir),false);
    assert.deepEqual((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview,gate);
    assert.deepEqual(await f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'skip'}),{decision:'skip',continuing:false});
    assert.equal(f.selections,0);assert.equal((await f.state()).domainRun.translationWarningReviewDecision,'skip');
    assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview,undefined);
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review',request:f.request}),/pending|stale/i);
  }finally{await f.clean();}
});
test('Host review restores saved full binding, rejects stale and duplicate clicks, and native final continues',async()=>{
  const f=await fixture({saved:true});try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id+'-stale',decision:'review',request:f.request}),/pending|stale/i);
    assert.equal(f.selections,0);
    f.provider.setResponses([fauxAssistantMessage(fauxText('Only part of the review is complete.')),fauxAssistantMessage(fauxToolCall('finishReview',{}, {id:'finish'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('Complete.'))]);
    await settled(f.service,async()=>{
      assert.deepEqual(await f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review',request:{...f.request,sourcePath:path.join(f.outputDir,'wrong-page.txt'),sourceDocumentId:'wrong-page.txt'}}),{decision:'review',continuing:true});
      await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review',request:f.request}),/running|pending|stale/i);
    });
    assert.equal(f.context.request.sourcePath,f.sourcePath);assert.equal(f.context.domainRun.fullWorkflow,true);assert.equal(f.finished,1);
    assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).error,undefined);
  }finally{await f.clean();}
});
test('review persistence failure sends no model turn and preserves pending choice',async()=>{
  let fail=true;
  const f=await fixture({saved:true,appendHostState:async(...args)=>{if(fail)throw new Error('synthetic disk failure');return appendYnSessionHostState(...args);}});try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'}),/synthetic disk failure/);
    fail=false;
    assert.equal(f.finished,0);assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview?.id,gate.id);
  }finally{fail=false;await f.clean();}
});
test('real validation emits a typed Host gate and Yes starts warning inspection without another user prompt',async()=>{
  const f=await fixture({live:true});try{
    f.provider.setResponses([fauxAssistantMessage([fauxToolCall('readSourceLines',{fromLine:1,toLine:2},{id:'before-gate'}),fauxToolCall('validateTranslationArtifact',{}, {id:'validate'})],{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('This assistant response must never run after a Host gate.'))]);
    await settled(f.service,()=>f.service.prompt({...f.request,outputDir:f.outputDir,sessionId:f.sessionId,workflowIntent:'translation',prompt:'Workflow: yn-translation-v1.\nFinish this synthetic translation.'}));
    const messages=await f.service.loadMessages(f.outputDir,f.sessionId);
    const result=messages.find(message=>message.role==='toolResult'&&message.toolName==='validateTranslationArtifact');
    assert.equal(result?.details?.warningReviewDecision,'pending',JSON.stringify(result));
    assert.equal(messages.some(message=>message.role==='assistant'&&message.content?.some(block=>block.type==='text'&&block.text.includes('must never run'))),false);
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    assert(gate?.warningCount>0);assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).error,undefined);
    f.provider.setResponses([fauxAssistantMessage(fauxToolCall('inspectTranslationWarnings',{}, {id:'inspect-warnings'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('Only one page complete.')),fauxAssistantMessage(fauxToolCall('finishReview',{}, {id:'complete-warnings'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('Complete.'))]);
    await settled(f.service,()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'}));
    assert.equal(f.finished,1);
    const final=await f.service.loadMessages(f.outputDir,f.sessionId);
    assert(final.some(message=>message.role==='toolResult'&&message.toolName==='inspectTranslationWarnings'&&!message.isError));
    assert(final.some(message=>message.role==='custom'&&message.customType==='yn-domain-repair'),'Host choice must release the old user gate for completion repair');
    assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).error,undefined);
  }finally{await f.clean();}
});
test('ordinary read-only chat parks pending translation and leaves the Host choice usable',async()=>{
  const f=await fixture({saved:true});try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    f.provider.setResponses([fauxAssistantMessage(fauxToolCall('readSourceLines',{fromLine:1,toLine:2},{id:'read-only'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('Synthetic source explanation.'))]);
    await settled(f.service,()=>f.service.prompt({...f.request,outputDir:f.outputDir,sessionId:f.sessionId,prompt:'Explain the source only.'}));
    assert.equal(f.context.domainRun.fullWorkflow,false);assert.deepEqual((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview,gate);
    const selections=f.selections;
    await f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'skip'});
    assert.equal(f.selections,selections);assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview,undefined);
    assert.equal((await f.state()).parkedDomainRuns.translation.translationWarningReviewDecision,'skip');
  }finally{await f.clean();}
});
test('Stop during review preparation cancels before native model input',async()=>{
  let release,started;const selected=new Promise(resolve=>{started=resolve;});const held=new Promise(resolve=>{release=resolve;});
  const f=await fixture({saved:true,beforeSelection:async()=>{started();await held;}});try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    const deciding=f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'});
    await selected;const stopping=f.service.abort(f.outputDir,f.sessionId);release();
    await assert.rejects(deciding,/stopped|cancelled|abort/i);await stopping;
    assert.equal(f.finished,0);assert.equal((await f.state()).domainRun.translationWarningReviewDecision,'pending');
  }finally{release();await f.clean();}
});
test('cold skip persistence failure preserves pending and does not select a model',async()=>{
  let fail=true;const f=await fixture({appendHostState:async(...args)=>{if(fail)throw new Error('synthetic skip storage failure');return appendYnSessionHostState(...args);}});try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'skip'}),/persist.*skip/i);
    assert.equal(f.selections,0);assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview.id,gate.id);
  }finally{fail=false;await f.clean();}
});
test('cold polling reuses verified unchanged JSONL identity and refreshes after a Host decision',async()=>{
  const f=await fixture({historyEntries:160});const originalOpen=PiSessionRepository.prototype.open;let opens=0;
  PiSessionRepository.prototype.open=async function(...args){opens++;return originalOpen.apply(this,args);};
  try{
    const state=await f.service.getRunState(f.outputDir,f.sessionId);const id=state.warningReview.id;
    state.warningReview.id='caller-mutation';
    for(let index=0;index<20;index++)assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview.id,id);
    assert.equal(opens,1,'unchanged polling must not reopen/replay the native history');
    assert.equal(f.selections,0);
    await f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:id,decision:'skip'});
    assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview,undefined);
    assert.equal(opens,3,'decision must re-read authority, then changed JSONL must invalidate the display cache');
  }finally{PiSessionRepository.prototype.open=originalOpen;await f.clean();}
});
test('legacy review requires matching explicit bindings and another session cannot use the gate',async()=>{
  const f=await fixture();try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    const other=await new PiSessionRepository(f.outputDir).create('different-parent');
    const state=await f.state();await appendYnSessionHostState(other,{...state,ownerSessionId:'different-parent'});await other.close(BACKGROUND_CONTEXT);
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:'different-parent',reviewId:gate.id,decision:'skip'}),/stale|different Pi session/i);
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'}),/explicit.*bindings/i);
    const wrong=path.join(f.outputDir,'wrong.txt');await writeFile(wrong,'Synthetic unrelated page.');
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review',request:{...f.request,sourcePath:wrong}}),/bindings.*match/i);
    assert.equal(f.selections,0);
    f.provider.setResponses([fauxAssistantMessage(fauxToolCall('finishReview',{}, {id:'legacy-finish'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('Complete.'))]);
    await settled(f.service,()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review',request:f.request}));
    assert.equal(f.finished,1);
  }finally{await f.clean();}
});
test('Stop immediately after a Host click cancels even the initial cold binding read',async()=>{
  const f=await fixture({saved:true});try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    const deciding=f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'});
    const stopping=f.service.abort(f.outputDir,f.sessionId);
    await assert.rejects(deciding,/stopped|cancelled|abort/i);await stopping;
    assert.equal(f.selections,0);assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview.id,gate.id);
  }finally{await f.clean();}
});
test('native diagnostics append failure leaves the unstarted Host warning choice pending on disk',async()=>{
  const f=await fixture({saved:true});const originalCommit=IndexedJsonlStorage.prototype.commit;const originalPrompt=PiSessionAgentRuntime.prototype.prompt;let inputs=0,failed=false;
  IndexedJsonlStorage.prototype.commit=function(writes,context){
    if(!failed&&writes.some(write=>write.kind==='entry'&&write.entry?.customType==='yn_prompt_preparation')){failed=true;return Promise.reject(new Error('synthetic diagnostics append failure'));}
    return originalCommit.call(this,writes,context);
  };
  PiSessionAgentRuntime.prototype.prompt=async function(...args){inputs++;return originalPrompt.apply(this,args);};
  try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    await assert.rejects(()=>f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'}),/synthetic diagnostics append failure/);
    assert.equal(inputs,0);assert.equal(failed,true);
    assert([...f.service.active.values()][0].runtime.sessionFailure,'native append failure must latch the existing nonretryable runtime failure');
    assert.equal((await f.state()).domainRun.translationWarningReviewDecision,'pending');
    assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview?.id,gate.id);
  }finally{
    IndexedJsonlStorage.prototype.commit=originalCommit;PiSessionAgentRuntime.prototype.prompt=originalPrompt;
    // The synthetic commit injection intentionally latches runtime persistence
    // failure. Clear only this test latch so the fixture can close normally.
    for(const active of f.service.active.values())active.runtime.sessionFailure=undefined;
    await f.clean();
  }
});
for(const stage of ['diagnostics','decision_commit'])test(`Stop during ${stage} restores the unstarted choice and rejects acceptance`,async()=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  let pause=true;
  const f=await fixture({saved:true,appendHostState:async(...args)=>{
    await appendYnSessionHostState(...args);
    if(stage==='decision_commit'&&pause&&args[1].domainRun?.translationWarningReviewDecision==='review'){pause=false;entered();await held;}
  }});
  const originalAppend=PiSessionAgentRuntime.prototype.appendCustomEntry,originalPrompt=PiSessionAgentRuntime.prototype.prompt;let inputs=0;
  PiSessionAgentRuntime.prototype.appendCustomEntry=async function(type,data){
    if(stage==='diagnostics'&&pause&&type==='yn_prompt_preparation'){pause=false;entered();await held;}
    return originalAppend.call(this,type,data);
  };
  PiSessionAgentRuntime.prototype.prompt=async function(...args){inputs++;return originalPrompt.apply(this,args);};
  try{
    const gate=(await f.service.getRunState(f.outputDir,f.sessionId)).warningReview;
    const deciding=f.service.decideTranslationWarningReview({outputDir:f.outputDir,sessionId:f.sessionId,reviewId:gate.id,decision:'review'});
    await started;const stopping=f.service.abort(f.outputDir,f.sessionId);release();
    await assert.rejects(deciding,/stopped|cancelled|abort/i);await stopping;
    assert.equal(inputs,0);assert.equal((await f.state()).domainRun.translationWarningReviewDecision,'pending');
    assert.equal((await f.service.getRunState(f.outputDir,f.sessionId)).warningReview?.id,gate.id);
  }finally{release();PiSessionAgentRuntime.prototype.appendCustomEntry=originalAppend;PiSessionAgentRuntime.prototype.prompt=originalPrompt;await f.clean();}
});
test('a failure before first native input restores pending, while Stop after input preserves review authorization',async()=>{
  const before=await fixture({saved:true});const originalPreflight=before.service.compactBeforePromptIfNeeded;
  try{
    const gate=(await before.service.getRunState(before.outputDir,before.sessionId)).warningReview;
    before.service.compactBeforePromptIfNeeded=async()=>{throw new Error('synthetic before-input preparation failure');};
    await before.service.decideTranslationWarningReview({outputDir:before.outputDir,sessionId:before.sessionId,reviewId:gate.id,decision:'review'});
    const active=[...before.service.active.values()][0];await active.promptTask;
    assert.equal((await before.state()).domainRun.translationWarningReviewDecision,'pending');
    assert.equal((await before.service.getRunState(before.outputDir,before.sessionId)).warningReview.id,gate.id);
  }finally{before.service.compactBeforePromptIfNeeded=originalPreflight;await before.clean();}
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const after=await fixture({saved:true,beforeFinish:async()=>{entered();await held;throw new DOMException('Synthetic executing review was stopped.','AbortError');}});
  try{
    const gate=(await after.service.getRunState(after.outputDir,after.sessionId)).warningReview;
    after.provider.setResponses([fauxAssistantMessage(fauxToolCall('finishReview',{}, {id:'running-warning-review'}),{stopReason:'toolUse'})]);
    await after.service.decideTranslationWarningReview({outputDir:after.outputDir,sessionId:after.sessionId,reviewId:gate.id,decision:'review'});
    await started;const stopping=after.service.abort(after.outputDir,after.sessionId);release();await stopping;
    assert.equal(after.finished,1);assert.equal((await after.state()).domainRun.translationWarningReviewDecision,'review');
    assert.equal((await after.service.getRunState(after.outputDir,after.sessionId)).warningReview,undefined);
  }finally{release();await after.clean();}
});
test('ordinary automatic preparation hands ownership to the full workflow without a false Stop',async()=>{
  const outputDir=await mkdtemp(path.join(os.tmpdir(),'yn-warning-handoff-regression-'));
  const sourcePath=path.join(outputDir,'source.txt');await writeFile(sourcePath,'Synthetic prepared source.');
  const models=createModels(),provider=fauxProvider({provider:'synthetic-preparation-handoff',tokensPerSecond:1_000_000,tokenSize:{min:100_000,max:100_000}});models.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage(fauxToolCall('startPreparedWorkflow',{}, {id:'start-prepared'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxToolCall('completePreparedTranslation',{}, {id:'complete-prepared'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('Synthetic preparation handoff completed.'))]);
  let completed;const finished=new Promise(resolve=>{completed=resolve;});let preparations=0;
  const service=new PiNativeSessionService({enforceDomainCompletion:true,createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),createTools:context=>[{
    name:'completePreparedTranslation',label:'Complete prepared translation',description:'Provide synthetic complete workflow evidence',parameters:Type.Object({}),async execute(){
      assert.equal(context.domainRun.fullWorkflow,true);context.domainRun.recordInspection({sourceLineCount:1,glossaryCandidateExists:true,characterBibleExists:true});context.domainRun.recordTranslationWrite('translation');context.domainRun.recordFinalValidation('translation');return{content:[{type:'text',text:'complete'}]};
    }
  }]});
  let timer;
  try{
    const session=await service.createSession(outputDir),base={outputDir,sessionId:session.id,sourcePath,languagePair:'en->zh-CN',providerId:provider.provider.id,modelId:provider.getModel().id,subagentEnabled:false};
    service.configureTaskPreparationHost({prepareWorkflow:async()=>{preparations++;return{...base,workflowIntent:'translation',prompt:'Workflow: yn-translation-v1.\nTranslate the prepared synthetic source.'};},finishWorkflow:async()=>{completed();}});
    await service.prompt({...base,prompt:'Prepare and translate the synthetic file.',taskPreparation:{intent:'translation'}});
    await Promise.race([finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Automatic preparation never reached full-workflow completion')),3000);})]);
    await [...service.active.values()][0].promptTask;
    const state=await service.getRunState(outputDir,session.id);assert.equal(state.error,undefined);assert.equal(preparations,1);
    assert((await service.loadMessages(outputDir,session.id)).some(message=>message.role==='assistant'&&message.content?.some(block=>block.type==='text'&&block.text==='Synthetic preparation handoff completed.')));
  }finally{clearTimeout(timer);await service.disposeWorkspace(outputDir);await rm(outputDir,{recursive:true,force:true});}
});
