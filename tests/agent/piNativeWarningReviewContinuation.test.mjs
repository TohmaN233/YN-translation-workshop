import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Type} from 'typebox';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core/node';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {createYnDomainRunContract} from '../../src/main/agent/piNative/domainRunContract.ts';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {appendYnSessionHostState,createProofreadHostState,createTranslationAlignmentHostState,loadYnSessionHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';

for (const action of ['review','skip','read_only']) test(`warning-review follow-up ${action} preserves the correct workflow ownership`, async()=>{
  const outputDir=await mkdtemp(path.join(os.tmpdir(),'yn-warning-review-continuation-'));
  const sourcePath=path.join(outputDir,'source.txt');
  const documentId='source.txt';
  const sessionId='warning-review-parent';
  const source='Synthetic first sentence.\nSynthetic second sentence.';
  await writeFile(sourcePath,source,'utf8');
  const owner=await new PiSessionRepository(outputDir).create(sessionId);
  const previous=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:true,subagentEnabled:false});
  previous.recordInspection({sourceLineCount:2,documents:[{id:documentId,sourceLineCount:2}],glossaryCandidateExists:true,characterBibleExists:true});
  previous.recordTranslationWrite('translation');
  previous.recordTranslationValidation('translation',1,documentId);
  previous.notePendingTranslationWarningReview();
  await appendYnSessionHostState(owner,{schemaVersion:1,ownerSessionId:sessionId,domainRun:previous.snapshot(),proofread:createProofreadHostState(),translationAlignment:createTranslationAlignmentHostState()});
  await owner.close(BACKGROUND_CONTEXT);

  const models=createModels();
  const provider=fauxProvider({provider:'warning-review-continuation',tokensPerSecond:1_000_000,tokenSize:{min:100_000,max:100_000}});
  models.setProvider(provider.provider);
  let modelCalls=0;
  const responses=action==='review' ? [
    fauxAssistantMessage(fauxText('One review page is complete; more work remains.')),
    fauxAssistantMessage(fauxToolCall('finishSyntheticWarningReview',{},{id:'finish-review'}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxText('All authorized review work is complete.'))
  ] : action==='skip' ? [
    fauxAssistantMessage(fauxText('The optional warning review was skipped.'))
  ] : [
    fauxAssistantMessage(fauxToolCall('readSourceLines',{fromLine:1,toLine:2},{id:'readonly-source'}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxText('Here is the requested source explanation.'))
  ];
  provider.setResponses(responses.map(response=>()=>{modelCalls++;return response;}));
  let context;
  let finished=0;
  const service=new PiNativeSessionService({
    createModelSelection:async()=>{
      assert.notEqual(action,'skip','Skipping warnings must not prepare a model');
      return {models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id};
    },
    enforceDomainCompletion:true,
    buildSystemPrompt:()=> 'Use the Host tools to finish the authorized review.',
    createTools:current=>{
      context=current;
      return [...createYnDomainTools(current),{
        name:'finishSyntheticWarningReview',label:'Finish synthetic review',description:'Settle the synthetic final review stage.',parameters:Type.Object({}),
        async execute(){
          finished++;
          assert.equal(current.domainRun.translationWarningReviewDecision,'review');
          current.domainRun.recordFinalValidation('translation',documentId);
          await current.persistHostState();
          return {content:[{type:'text',text:'review complete'}]};
        }
      }];
    }
  });
  let timer;
  let resolveSettled;
  const settled=new Promise(resolve=>{resolveSettled=resolve;});
  const unsubscribe=service.subscribeEvents(event=>{
    if(event.event.type==='settled')resolveSettled();
  });
  try{
    if(action==='read_only'){
      await service.prompt({outputDir,sourcePath,sourceDocumentId:documentId,sessionId,prompt:'Explain the source without resuming the translation.',languagePair:'en->zh-CN',providerId:provider.provider.id,modelId:provider.getModel().id,subagentEnabled:false});
    }else{
      const before=await service.getRunState(outputDir,sessionId);
      assert(before.warningReview,'A persisted pending choice must be visible without running a model');
      assert.equal(before.warningReview.warningCount,1);
      const decision=await service.decideTranslationWarningReview({
        outputDir,sessionId,reviewId:before.warningReview.id,decision:action,
        request:{sourcePath,sourceDocumentId:documentId,languagePair:'en->zh-CN',providerId:provider.provider.id,modelId:provider.getModel().id,subagentEnabled:false}
      });
      assert.equal(decision.continuing,action==='review');
    }
    if(action!=='skip')await Promise.race([settled,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Warning review did not settle')),10_000);
      timer.unref();
    })]);
    const messages=await service.loadMessages(outputDir,sessionId);
    const repaired=messages.some(message=>message.role==='custom'&&message.customType==='yn-domain-repair');
    if(action==='read_only'){
      assert.equal(context.domainRun.fullWorkflow,false,'Reading source alone must not resume a parked translation');
      assert(context.parkedWorkflows().includes('translation'));
      assert.equal(repaired,false);
      assert.equal(finished,0);
    }else{
      assert.equal(finished,action==='review'?1:0,'The native loop stopped after a partial review instead of enforcing the remaining full-workflow debt');
      if(action==='review'){
        assert.equal(context.domainRun.fullWorkflow,true);
        assert.equal(context.domainRun.translationWarningReviewDecision,'review','one accepted choice remains attached to the complete workflow');
        assert.deepEqual(context.domainRun.incompleteReasons(),[]);
      }else assert.equal(modelCalls,0);
      assert.equal(repaired,action==='review','Only the unfinished authorized review needs a Host continuation');
    }
    assert.equal((await service.getRunState(outputDir,sessionId)).error,undefined);
    assert.equal(await readFile(sourcePath,'utf8'),source);
    await service.disposeWorkspace(outputDir);
    const stored=await new PiSessionRepository(outputDir).open(sessionId);
    try{
      const host=await loadYnSessionHostState(stored,sessionId);
      if(action==='skip'){
        assert.equal(host.domainRun.fullWorkflowActive,true);
        assert.equal(host.domainRun.translationWarningReviewDecision,'skip');
      }
    }finally{await stored.close(BACKGROUND_CONTEXT);}
  }finally{
    clearTimeout(timer);
    unsubscribe();
    await service.disposeWorkspace(outputDir);
    await rm(outputDir,{recursive:true,force:true});
  }
});
