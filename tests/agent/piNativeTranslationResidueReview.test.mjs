import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {createYnDomainRunContract} from '../../src/main/agent/piNative/domainRunContract.ts';
import {createTranslationAlignmentHostState} from '../../src/main/agent/piNative/translationAlignmentState.ts';
import {createPiTranslationReviewSubagentWorker} from '../../src/main/agent/piNative/subagentRunner.ts';
import {prepareTranslationStagingCandidate} from '../../src/main/agent/writeTranslationChunk.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-residue-review-'));
let repository,worker;
try {
  const sourcePath=path.join(root,'source.txt');await writeFile(sourcePath,'cedarKit\nThirdPartyPackageCore\n');
  repository=new PiSessionRepository(root);await repository.create('parent');
  const request={outputDir:root,sourcePath,sessionId:'parent',prompt:'Translate.',workflowIntent:'translation',languagePair:'en->zh-CN',subagentEnabled:true,subagentCount:1,glossaryCandidates:false,characterBible:false};
  const alignment=createTranslationAlignmentHostState(),domainRun=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:true,subagentEnabled:true,subagentCount:1});
  let batch;
  const tools=createYnDomainTools({request,domainRun,translationAlignmentState:alignment,publishCustomMessage:async()=>{},persistHostState:async()=>{},
    subagents:{hasRunning:()=>false,startTranslationBatch(options){batch=options;return{id:options.batchId,subagents:[],status:'running'};}}});
  await tools.find(t=>t.name==='confirmTranslationResidueSafe').execute('confirm',{entries:[
    {line:1,translation:'cedarKit',reason:'Exact package identifier.'},{line:2,translation:'ThirdPartyPackageCore',reason:'Exact namespace.'}]});
  await tools.find(t=>t.name==='runTranslationSubagents').execute('start',{});
  const stage=await prepareTranslationStagingCandidate({outputDir:root,sourcePaths:[sourcePath],documentId:'source.txt',sessionId:'parent',subagentId:'child',assignmentId:'source.txt:L1-L2'});
  await writeFile(stage,await readFile(sourcePath));
  await batch.onStagingCandidateCheckpoint({documentId:'source.txt',fromLine:1,toLine:2,candidatePath:stage,accepted:true,requiredLines:[],repairIssues:[]});
  const review=await batch.prepareChunkReview({documentId:'source.txt',subagentId:'child',label:'Translator',fromLine:1,toLine:2,candidatePath:stage,
    validation:{accepted:true,ok:true,blocking:[],warnings:[]},discoveries:{glossaryCandidates:[],characterFacts:[]}});
  const provider=fauxProvider({provider:'parent-residue-review',tokensPerSecond:1_000_000}),models=createModels();models.setProvider(provider.provider);
  const call=(name,args={})=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
  provider.setResponses([call('readAssignedTranslationReview'),input=>{
    const read=JSON.parse(input.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
    assert.deepEqual(read.residueConfirmations.map(row=>row.line),[1,2]);
    return call('submitTranslationReview',{failures:[{line:1,code:'wrong_target_language',note:'Package name lacks Chinese characters.'},
      {line:2,code:'semantic_mismatch',note:'Correct meaning independently of residue.'}]});
  }]);
  const context={request,task:review.task,readAssignment:review.read,submitAssignment:review.submit,publishCustomMessage:async()=>{},
    createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})};
  worker=await createPiTranslationReviewSubagentWorker(context);const result=await worker.runAssignment(context);
  assert.equal(result.decision.accepted,false,'unrelated semantic failures retain review debt');
  const checks=alignment.ranges['source.txt'][0].checks;
  assert.equal(checks.find(c=>c.line===1).verdict,'aligned');assert.ok(checks.find(c=>c.line===1).signals.includes('review_parent_confirmed_source_residue'));
  assert.equal(checks.find(c=>c.line===2).verdict,'misaligned');
  console.log('Native Pi review receives parent decisions and cannot recreate confirmed residue debt; independent semantic findings remain active');
} finally {await worker?.dispose();await repository?.close();await rm(root,{recursive:true,force:true});}
