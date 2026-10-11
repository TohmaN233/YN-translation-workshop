import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,getCurrentSystemPrompt,getCurrentTools} from '@earendil-works/pi-ai';
import { createPiTranslationRuntimeSpec, createPiTranslationSubagentTools, createPiProofreadSubagentTools, createPiTranslationSubagentWorker } from '../../src/main/agent/piNative/subagentRunner.ts';

const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-stable-prefix-'));
const sourcePath = path.join(dir, 'source.txt');
const request = {outputDir:dir,sourcePath,sessionId:'prefix-owner',languagePair:'en->zh-CN',style:'game',workDescription:'Stable project rules',glossaryCandidates:false,characterBible:false};
const context = (fromLine,toLine,extra={}) => ({request,task:{fromLine,toLine},publishCustomMessage:async()=>{},...extra});
const wireTools = tools => tools.map(({name,description,parameters})=>({name,description,parameters}));
try {
  await writeFile(sourcePath,Array.from({length:1000},(_,i)=>`An example source sentence ${i+1}.`).join('\n')+'\n');
  for (const executionMode of ['full_workflow','bounded_repair','chunk_review_repair']) {
    for (const enabled of [false,true]) {
      const a = context(1,500,{executionMode,request:{...request,glossaryCandidates:enabled,characterBible:enabled}});
      const b = context(501,1000,{executionMode,request:{...request,glossaryCandidates:enabled,characterBible:enabled}});
      assert.deepEqual(wireTools(createPiTranslationSubagentTools(a)),wireTools(createPiTranslationSubagentTools(b)),`${executionMode} tools must remain identical across assignments`);
    }
  }
  const proofreadProgress = () => ({contextRead:false,findingsWritten:false,findingsCount:0});
  assert.deepEqual(wireTools(createPiProofreadSubagentTools(context(1,500),'proof',proofreadProgress())),wireTools(createPiProofreadSubagentTools(context(501,1000),'proof',proofreadProgress())),'proofread tool declarations must remain stable');
  const spec = createPiTranslationRuntimeSpec(context(501,1000),{});
  const tools = spec.tools('prefix-worker');
  const read = tools.find(t=>t.name==='readAssignedSource');
  const write = tools.find(t=>t.name==='writeAssignedTranslation');
  const repair = tools.find(t=>t.name==='repairAssignedTranslation');
  const validate = tools.find(t=>t.name==='validateAssignedTranslation');
  await assert.rejects(read.execute('outside-read',{fromLine:1,toLine:500}),/inside|assigned|range/i);
  await assert.rejects(write.execute('outside-write',{fromLine:1,toLine:500,blocks:[{id:'a',lines:['0越界']}]}),/inside|assigned|range/i);
  await assert.rejects(write.execute('unread-write',{fromLine:501,toLine:1000,blocks:[{id:'a',lines:['0未读']}]}),/read|source|protocol|block/i);
  await assert.rejects(repair.execute('outside-repair',{entries:[{line:1,translation:'越界'}]}),/inside|assigned|range|writable/i);
  await assert.rejects(validate.execute('outside-validation',{fromLine:1,toLine:500}),/inside|assigned|range/i);
  await assert.rejects(readFile(path.join(dir,'AI_translation','source_translated.txt')),/ENOENT/);
  console.log('PASS stable translation/proofread tool schemas across ranges; Host rejects outside and unread writes');

  const models=createModels();
  const provider=fauxProvider({provider:'stable-prefix',tokensPerSecond:100000});
  models.setProvider(provider.provider);
  const model=models.getModels(provider.provider.id)[0];
  const baselines=[];
  const replies=[];
  for(let assignment=0;assignment<2;assignment++) {
    replies.push(async(ctx,options)=>{
      baselines.push({system:getCurrentSystemPrompt(ctx.messages),tools:wireTools(getCurrentTools(ctx.messages)),key:options?.sessionId,messages:JSON.stringify(ctx.messages)});
      return fauxAssistantMessage(fauxToolCall('readAssignedSource',{}),{stopReason:'toolUse'});
    });
    replies.push(async(ctx)=>{
      const result=ctx.messages.filter(x=>x.role==='toolResult' && x.toolName==='readAssignedSource').at(-1);
      const payload=JSON.parse(result.content.find(x=>x.type==='text').text);
      return fauxAssistantMessage(fauxToolCall('writeAssignedTranslation',{blocks:payload.sourceBlocks.map(block=>({id:block.id,lines:block.lines.map((line,i)=>`${line[0]}示例句子${block.absoluteLines[i]}。`)}))}),{stopReason:'toolUse'});
    });
    replies.push(fauxAssistantMessage(fauxToolCall('validateAssignedTranslation',{}),{stopReason:'toolUse'}));
  }
  provider.setResponses(replies);
  const workerContext=(fromLine,toLine)=>context(fromLine,toLine,{createModelSelection:async()=>({models,model,providerId:provider.provider.id,modelId:model.id}),request:{...request,providerId:provider.provider.id,modelId:model.id},onChunkReadyForReview:async()=>({accepted:true})});
  const worker=await createPiTranslationSubagentWorker(workerContext(1,500));
  try {
    for(const [fromLine,toLine] of [[1,500],[501,1000]]) {
      const result=await worker.runAssignment(workerContext(fromLine,toLine));
      assert.equal(result.validation.blocking.length,0);
    }
    assert.equal(baselines.length,2);
    assert.equal(baselines[0].system,baselines[1].system,'native reset must rebuild an identical stable system');
    assert.deepEqual(baselines[0].tools,baselines[1].tools);
    assert.match(baselines[0].key,/^subagent_[a-f\d-]+$/,'native worker ID is the provider session cache key');
    assert.equal(baselines[0].key,baselines[1].key,'same persistent worker keeps the session cache key');
    assert.match(baselines[1].system,/Translation Child Contract/);
    assert.match(baselines[1].system,/Stable project rules/);
    assert.doesNotMatch(baselines[1].messages,/example source sentence 1\.|示例句子1。|L1-L500/,'previous assignment prose and scope must be cleared');
    const candidate=await readFile(path.join(dir,'AI_translation','source_translated.txt'),'utf8');
    assert.equal(candidate.split('\n').filter(Boolean).length,1000);
    await worker.finish({status:'completed',assignmentCount:2,completedAssignments:2,documentIds:['source.txt']});
    const sparse=createPiTranslationSubagentTools(context(501,505,{executionMode:'bounded_repair',task:{fromLine:501,toLine:505,selectedLines:[501,503]}}));
    await sparse.find(t=>t.name==='readAssignedSource').execute('sparse-read',{});
    await assert.rejects(sparse.find(t=>t.name==='repairAssignedTranslation').execute('not-owned',{entries:[{line:502,translation:'不可改动'}]}),/owned|writable|sparse|selected|assignment|readAssignedSource/i);
    assert.equal(await readFile(path.join(dir,'AI_translation','source_translated.txt'),'utf8'),candidate);
    console.log('PASS real persistent worker: two 500-line assignments, stable system/tools/key, clean reset and exact sparse write protection');
  } finally {await worker.dispose();}
} finally {
  await rm(dir,{recursive:true,force:true});
}
