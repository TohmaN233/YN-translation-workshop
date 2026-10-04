import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Type} from 'typebox';
import {BACKGROUND_CONTEXT,MemorySessionRepo} from '@earendil-works/pi-agent-core/node';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {PiSessionAgentRuntime} from '../../src/main/agent/piNative/sessionAgentRuntime.ts';
import {createPiTranslationSubagentTools,createTranslationWriteBatchHandoff} from '../../src/main/agent/piNative/subagentRunner.ts';
import {NonRetryableAssignmentError,SubagentTransportExhaustedError} from '../../src/main/agent/piNative/assignmentFailure.ts';
import {YnSubagentSupervisor} from '../../src/main/agent/piNative/subagentSupervisor.ts';
import {readSessionEntries} from '../../src/main/agent/piNative/sessionAccess.ts';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {loadYnSessionHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';

const dir=await mkdtemp(path.join(os.tmpdir(),'yn-fatal-host-test-'));
const sourcePath=path.join(dir,'source.txt');
const staging=path.join(dir,'.translation-workshop','agent','translation-staging','test','worker','candidate.txt');
await mkdir(path.dirname(staging),{recursive:true});
await writeFile(sourcePath,'A complete source sentence.\n');
await writeFile(staging,'这是完整的中文译文。\n');
const session=await new MemorySessionRepo().create({id:'fatal-host'},BACKGROUND_CONTEXT);
const provider=fauxProvider({provider:'fatal-host',tokensPerSecond:100_000});
const models=createModels();models.setProvider(provider.provider);
let checkpointCalls=0;let fatalNotifications=0;
const progress={referenceRead:false,sourceRead:false,translationWritten:true,translationValidated:false,
  writtenLines:new Set([1]),requiredBatchLines:new Set([1])};
const tools=createPiTranslationSubagentTools({request:{outputDir:dir,sourcePath,sessionId:'fatal-host',
  prompt:'Repair.',providerId:provider.provider.id,modelId:provider.getModel().id,languagePair:'en->zh-CN'},
  task:{documentId:'source.txt',fromLine:1,toLine:1,reviewFeedback:[{line:1,reason:'meaning: fix'}]},
  executionMode:'chunk_review_repair',workingCandidatePath:staging,publishCustomMessage:async()=>{},
  onStagingCandidateCheckpoint:async()=>{checkpointCalls++;throw new Error('Translation repair review scope does not match the rejected chunk.');}
},progress);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall('readAssignedSource',{}, {id:'read'}),{stopReason:'toolUse'}),
  ...Array.from({length:6},(_,i)=>fauxAssistantMessage(fauxToolCall('repairAssignedTranslation',{
    fromLine:1,toLine:1,entries:[{line:1,translation:'这是修改后的完整中文译文。'}]
  },{id:`repair-${i}`}),{stopReason:'toolUse'})),
  fauxAssistantMessage('Must never reach this.')
]);
const runtime=new PiSessionAgentRuntime({session,sessionId:session.metadata.id,models,model:provider.getModel(),
  thinkingLevel:'off',systemPrompt:'Repair only line 1.',tools,afterToolCall:createTranslationWriteBatchHandoff(tools),
  onFatalToolError:()=>{fatalNotifications++;}});
try{
  await assert.rejects(runtime.prompt('One repair assignment.'),/Failed to persist the staging recovery checkpoint/);
  assert.equal(checkpointCalls,1,'fatal checkpoint must never reach a second model submission');
  assert.equal(fatalNotifications,1);
  const entries=await readSessionEntries(session);
  assert.equal(entries.filter(e=>e.type==='custom'&&e.customType==='yn_host_tool_failure').length,1);
  const errorResult=entries.find(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='repairAssignedTranslation');
  assert.equal(errorResult.message.isError,true);
  assert.equal(errorResult.message.details.retryable,false);

  // Ordinary input mistakes can still be corrected in the same native Pi turn.
  let inputCalls=0;
  runtime.reconfigure({systemPrompt:'Correct the input.',tools:[{name:'input',label:'input',description:'input',parameters:Type.Object({}),
    execute:async()=>{if(++inputCalls===1)throw new Error('Invalid model arguments.');return {content:[{type:'text',text:'ok'}]};}}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('input',{}, {id:'input-1'}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxToolCall('input',{}, {id:'input-2'}),{stopReason:'toolUse'}),
    fauxAssistantMessage('Corrected.')
  ]);
  await runtime.prompt('Correct the input.');assert.equal(inputCalls,2);assert.equal(fatalNotifications,1);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('input',{}, {id:'report-tool'}),{stopReason:'toolUse'}),
    fauxAssistantMessage('Must not call the model again to retry a report tool.')
  ]);
  await runtime.prompt('Report the stopped workflow.',{reportOnly:true});
  assert.equal(inputCalls,2,'failure reports cannot execute workflow tools');
  provider.setResponses([fauxAssistantMessage(fauxToolCall('input',{}, {id:'later-input'}),{stopReason:'toolUse'}),
    fauxAssistantMessage('Normal tools restored.')]);
  await runtime.prompt('A later explicit user turn.');assert.equal(inputCalls,3);
}finally{runtime.dispose();await session.close(BACKGROUND_CONTEXT);await rm(dir,{recursive:true,force:true});}

// Exercise real Supervisor queue/cancellation: one Host failure stops siblings,
// both worker pools, and future assignments; user Stop is a separate condition.
const published=[];let observedFatal=0;let siblingAborted=false;let queuedStarted=false;
const fatal=new NonRetryableAssignmentError('Host checkpoint persistence failed.');
let releaseFailure;const gate=new Promise(resolve=>{releaseFailure=resolve;});
const supervisor=new YnSubagentSupervisor({publishCustomMessage:async m=>{published.push(m);},
  notifyParent:async m=>{published.push(m);},onFatalHostFailure:()=>{observedFatal++;}});
const request={outputDir:process.cwd(),sessionId:'supervisor-fatal',providerId:'test',modelId:'test',prompt:'test'};
const makeOptions=(kind,tasks,run)=>({kind,request,tasks,maxWorkers:2,maxAssignmentAttempts:3,
  label:t=>t.label,range:t=>({fromLine:t.line,toLine:t.line}),documentId:()=>undefined,run});
supervisor.startBatch(makeOptions('translation',[{label:'fatal',line:1},{label:'sibling',line:2},{label:'queued',line:3}],async(t,_r,signal)=>{
  if(t.line===1){await gate;throw fatal;}
  if(t.line===3){queuedStarted=true;return {};}
  await new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{siblingAborted=true;reject(signal.reason);},{once:true});});
}));
let reviewAborted=false;
supervisor.startBatch(makeOptions('translation_review',[{label:'review',line:4}],async(_t,_r,signal)=>{
  await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{reviewAborted=true;reject(signal.reason);},{once:true}));
}));
await new Promise(resolve=>setImmediate(resolve));releaseFailure();
await supervisor.waitForAll();
assert.equal(observedFatal,1);assert.equal(siblingAborted,true);assert.equal(reviewAborted,true);assert.equal(queuedStarted,false);
assert.ok(published.some(m=>m.customType==='subagent-completion'&&m.details?.failureDisposition==='host_integrity_failure'),
  'fatal workflow stop must remain visible in durable parent completion');

// Abort while Host review preparation is in flight must not enqueue after close.
const raceSupervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{}});
let releasePrepare;const preparationGate=new Promise(resolve=>{releasePrepare=resolve;});
const racePool=raceSupervisor.startTranslationReviewPool({request,workerCount:1,
  prepare:async()=>{await preparationGate;return {decision:{accepted:true}};}});
const pendingReview=racePool.enqueue({});
const rejectedReview=assert.rejects(pendingReview,/Host checkpoint persistence failed/);
await raceSupervisor.stopForHostFailure(fatal);releasePrepare();
await rejectedReview;await racePool.close();await raceSupervisor.waitForAll();

const failingStopSupervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{},
  createModelSelection:async()=>{throw fatal;},
  onFatalHostFailure:async()=>{throw new Error('Failure record disk write failed.');}});
const failingStopPool=failingStopSupervisor.startTranslationReviewPool({request,workerCount:1,
  prepare:async()=>({task:{documentId:'source.txt',fromLine:1,toLine:1},read:async()=>({}),submit:async()=>({accepted:true})})});
await assert.rejects(failingStopPool.enqueue({}),/Host checkpoint persistence failed/);
await assert.rejects(failingStopPool.close(),/Failure record disk write failed/);
await failingStopSupervisor.waitForAll();

const transportMessages=[];let transportCalls=0;
const transportSupervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{},
  notifyParent:async m=>transportMessages.push(m)});
transportSupervisor.startBatch({...makeOptions('translation',[{label:'transport',line:1},{label:'next',line:2}],async()=>{
  transportCalls++;throw new SubagentTransportExhaustedError('Native transport retries exhausted.');
}),maxWorkers:1});
await transportSupervisor.waitForAll();assert.equal(transportCalls,1);
assert.equal(transportMessages[0].details.failureDisposition,'transport_retry_exhausted');

for(const failingHook of ['onTaskCompleted','onSettled']){
  let runs=0;let stops=0;
  const commitSupervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{},onFatalHostFailure:()=>{stops++;}});
  commitSupervisor.startBatch({...makeOptions('translation',[{label:'commit',line:1}],async()=>{runs++;return {};}),
    [failingHook]:async()=>{throw new Error('Host disk write failed.');}});
  await commitSupervisor.waitForAll();assert.equal(runs,1);assert.equal(stops,1);
  assert.throws(()=>commitSupervisor.startBatch(makeOptions('translation',[],async()=>({}))),/Host .* failed/);
}

const failedSettlementReports=[];
const settlementSupervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{},
  notifyParent:async m=>failedSettlementReports.push(m),
  onFatalHostFailure:async()=>{throw new Error('Stop persistence disk failure.');}});
settlementSupervisor.startBatch({...makeOptions('translation',[{label:'settlement',line:1}],async()=>({})),
  onSettled:async()=>{throw new Error('Host settlement disk failure.');}});
await settlementSupervisor.waitForAll();
assert.equal(settlementSupervisor.list()[0].status,'failed');
assert.match(settlementSupervisor.list()[0].error,/Host settlement disk failure.*Stop persistence disk failure/);
assert.equal(failedSettlementReports.length,1);
assert.equal(failedSettlementReports[0].details.failureDisposition,'host_integrity_failure');

const preflightDir=await mkdtemp(path.join(os.tmpdir(),'yn-fatal-preflight-'));
await writeFile(path.join(preflightDir,'source.txt'),'A complete source sentence.\n');
await new PiSessionRepository(preflightDir).create('preflight');
const preflightProvider=fauxProvider({provider:'preflight',tokensPerSecond:100_000});
const preflightModels=createModels();preflightModels.setProvider(preflightProvider.provider);
let preflightProviderCalls=0;let preparations=0;
preflightProvider.setResponses([()=>{preflightProviderCalls++;return fauxAssistantMessage('Must never run.');}]);
const preflightSupervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{},
  createModelSelection:async()=>({models:preflightModels,model:preflightProvider.getModel(),
    providerId:preflightProvider.provider.id,modelId:preflightProvider.getModel().id})});
try{
  preflightSupervisor.startTranslationBatch({request:{outputDir:preflightDir,sourcePath:path.join(preflightDir,'source.txt'),
    sessionId:'preflight',prompt:'Resume.',providerId:preflightProvider.provider.id,modelId:preflightProvider.getModel().id,languagePair:'en->zh-CN'},
    tasks:[{documentId:'source.txt',fromLine:1,toLine:1}],maxWorkers:1,
    onStagingCandidatePrepared:async()=>{preparations++;throw new Error('Recovery review evidence is stale.');},
    onChunkReadyForReview:async()=>({accepted:true})});
  await preflightSupervisor.waitForAll();assert.equal(preparations,1);assert.equal(preflightProviderCalls,0);
  const failed=preflightSupervisor.list().find(b=>b.kind==='translation');
  assert.equal(failed.status,'failed');assert.match(failed.error,/Failed to prepare the staging recovery binding/);
}finally{preflightSupervisor.abortAll();await preflightSupervisor.waitForAll();await rm(preflightDir,{recursive:true,force:true});}

const serviceDir=await mkdtemp(path.join(os.tmpdir(),'yn-fatal-service-'));
const serviceSource=path.join(serviceDir,'source.txt');await writeFile(serviceSource,'Source sentence.\n');
const serviceProvider=fauxProvider({provider:'fatal-service',tokensPerSecond:100_000});
const serviceModels=createModels();serviceModels.setProvider(serviceProvider.provider);
let serviceProviderCalls=0;
serviceProvider.setResponses([
  ()=>{serviceProviderCalls++;return fauxAssistantMessage(fauxToolCall('failCheckpoint',{}, {id:'fatal'}),{stopReason:'toolUse'});},
  ()=>{serviceProviderCalls++;return fauxAssistantMessage('Must not retry.');}
]);
const service=new PiNativeSessionService({createModelSelection:async()=>({models:serviceModels,model:serviceProvider.getModel(),
  providerId:serviceProvider.provider.id,modelId:serviceProvider.getModel().id}),
  createTools:()=>[{name:'failCheckpoint',label:'Fail checkpoint',description:'Fail checkpoint',parameters:Type.Object({}),
    execute:async()=>{throw new NonRetryableAssignmentError('Checkpoint file cannot be persisted.');}}],
  buildSystemPrompt:()=> 'Run the translation workflow.',enforceDomainCompletion:true});
let unsubscribe;let timer;
try{
  const selected=await service.createSession(serviceDir);
  const stopped=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Host failure did not settle.')),10_000);
    unsubscribe=service.subscribeState((_dir,state)=>{if(state.sessionId===selected.id&&!state.running&&state.error)resolve(state);});
  });
  await service.prompt({outputDir:serviceDir,sourcePath:serviceSource,sessionId:selected.id,
    providerId:serviceProvider.provider.id,modelId:serviceProvider.getModel().id,languagePair:'en->zh-CN',
    workflowIntent:'translation',prompt:'Workflow: yn-translation-v1.\nTranslate the source.'});
  const state=await stopped;
  assert.match(state.error,/Checkpoint file cannot be persisted/);assert.equal(serviceProviderCalls,1);
  const reopened=await new PiSessionRepository(serviceDir).open(selected.id);
  try{const durable=await loadYnSessionHostState(reopened,selected.id);assert.equal(durable.workflowSuspended,true);}
  finally{await reopened.close(BACKGROUND_CONTEXT);}
}finally{clearTimeout(timer);unsubscribe?.();await service.disposeWorkspace(serviceDir);await rm(serviceDir,{recursive:true,force:true});}

const reportDir=await mkdtemp(path.join(os.tmpdir(),'yn-fatal-report-'));
await writeFile(path.join(reportDir,'source.txt'),'Source.\n');
const reportProvider=fauxProvider({provider:'fatal-report',tokensPerSecond:100_000});
const reportModels=createModels();reportModels.setProvider(reportProvider.provider);
let reportCalls=0;let resumeCalls=0;let reportContext;
reportProvider.setResponses([
  ()=>{reportCalls++;return fauxAssistantMessage('Ready.');},
  (context)=>{reportCalls++;assert.equal(context.tools?.length??0,0);
    return fauxAssistantMessage(fauxToolCall('resumeYnWorkflow',{}, {id:'auto-resume'}),{stopReason:'toolUse'});},
  ()=>{reportCalls++;return fauxAssistantMessage('Must never retry.');}
]);
const reportService=new PiNativeSessionService({createModelSelection:async()=>({models:reportModels,model:reportProvider.getModel(),
  providerId:reportProvider.provider.id,modelId:reportProvider.getModel().id}),
  createTools:context=>{reportContext=context;return [{name:'resumeYnWorkflow',label:'Resume',description:'Resume',parameters:Type.Object({}),
    execute:async()=>{resumeCalls++;return {content:[{type:'text',text:'resumed'}]};}}];},
  buildSystemPrompt:()=> 'Report failures.'});
try{
  const selected=await reportService.createSession(reportDir);
  await reportService.prompt({outputDir:reportDir,sourcePath:path.join(reportDir,'source.txt'),sessionId:selected.id,
    providerId:reportProvider.provider.id,modelId:reportProvider.getModel().id,prompt:'Ready.'});
  await reportService.active.get([...reportService.active.keys()][0]).promptTask;
  reportContext.subagents.startBatch(makeOptions('translation',[{label:'fatal',line:1}],async()=>{throw fatal;}));
  await reportContext.subagents.waitForAll();
  const active=reportService.active.get([...reportService.active.keys()][0]);
  await active.promptTask;
  assert.equal(reportCalls,2);assert.equal(resumeCalls,0);
  assert.match(active.error,/Host checkpoint persistence failed/);
  assert.equal(active.hostState.workflowSuspended,true);
}finally{await reportService.disposeWorkspace(reportDir);await rm(reportDir,{recursive:true,force:true});}
console.log('ok fatal Host errors terminate native tools, stop all child queues, and keep model-input recovery');
