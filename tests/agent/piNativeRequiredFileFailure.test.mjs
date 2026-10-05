import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BACKGROUND_CONTEXT,MemorySessionRepo} from '@earendil-works/pi-agent-core/node';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {PiSessionAgentRuntime} from '../../src/main/agent/piNative/sessionAgentRuntime.ts';
import {createPiTranslationSubagentTools} from '../../src/main/agent/piNative/subagentRunner.ts';
import {readSessionEntries} from '../../src/main/agent/piNative/sessionAccess.ts';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {PiSessionRepository} from '../../src/main/agent/piNative/sessionRepository.ts';
import {loadYnSessionHostState} from '../../src/main/agent/piNative/proofreadSessionState.ts';

for(const missing of ['source','staging','staging-context','external-glossary','canonical-glossary','character-bible']) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'yn-required-file-'));
 const source=path.join(dir,'source.txt');
 const staging=path.join(dir,'.translation-workshop','agent','translation-staging','test','worker','candidate.txt');
 const glossary=path.join(dir,missing==='canonical-glossary'?'.translation-workshop':'reference','glossary.json');
 const bible=path.join(dir,'AI_translation','_workspace','character_bible.md');
 for(const file of [source,staging,glossary,bible])await mkdir(path.dirname(file),{recursive:true});
 await writeFile(source,'Alice says hello.');
 await writeFile(staging,'艾丽丝说你好。');
 await writeFile(glossary,JSON.stringify({entries:[{source:'Alice',target:'艾丽丝'}]}));
 await writeFile(bible,'# Character Bible\n\n## Reader / 读者\n- Gender/pronouns: unknown; unknown; unknown\n- Terms of address: Reader\n');
 const deleted={source,staging,'staging-context':staging,'external-glossary':glossary,'canonical-glossary':glossary,'character-bible':bible}[missing];
 const session=await new MemorySessionRepo().create({id:`required-${missing}`},BACKGROUND_CONTEXT);
 const provider=fauxProvider({provider:`required-${missing}`,tokensPerSecond:100_000});
 const models=createModels();models.setProvider(provider.provider);
 let requests=0;
 provider.setResponses([
  ()=>{requests++;return fauxAssistantMessage(fauxToolCall('readAssignedSource',{}, {id:'read'}),{stopReason:'toolUse'});},
  async()=>{requests++;await rm(deleted);return fauxAssistantMessage(fauxToolCall(missing==='staging-context'?'readTranslationContext':'validateAssignedTranslation',missing==='staging-context'?{fromLine:1,toLine:1}:{}, {id:'validate'}),{stopReason:'toolUse'});},
  ()=>{requests++;return fauxAssistantMessage(fauxToolCall('validateAssignedTranslation',{}, {id:'retry'}),{stopReason:'toolUse'});},
  ()=>{requests++;return fauxAssistantMessage('Must not continue after the dependency vanished.');}
 ]);
 const tools=createPiTranslationSubagentTools({request:{outputDir:dir,sourcePath:source,sessionId:session.metadata.id,
  prompt:'Validate.',providerId:provider.provider.id,modelId:provider.getModel().id,languagePair:'en->zh-CN',
  workflowIntent:'translation',glossaryPath:glossary,glossaryCandidates:false,characterBible:missing==='character-bible'},
  task:{documentId:'source.txt',fromLine:1,toLine:1},workingCandidatePath:staging,
  publishCustomMessage:async()=>{}},{referenceRead:false,sourceRead:false,translationWritten:true,
  translationValidated:false,writtenLines:new Set([1])});
 const runtime=new PiSessionAgentRuntime({session,sessionId:session.metadata.id,models,model:provider.getModel(),
  tools,thinkingLevel:'off',systemPrompt:'Use native tools.'});
 try {
  await assert.rejects(runtime.prompt('Validate the existing candidate.'),error=>error.retryable===false&&error.message.includes(deleted)&&/restore/i.test(error.message));
  assert.equal(requests,2,`${missing}: do not ask the model to repair a missing dependency`);
  const diagnostic=(await readSessionEntries(session)).find(e=>e.type==='custom'&&e.customType==='yn_host_tool_failure');
  assert.ok(diagnostic?.data.error.includes(deleted));
  assert.equal(diagnostic?.data.requiredFilePath,deleted);
  if(deleted!==staging)assert.equal(await readFile(staging,'utf8'),'艾丽丝说你好。','keep the existing draft');
 }finally{runtime.dispose();await session.close(BACKGROUND_CONTEXT);await rm(dir,{recursive:true,force:true});}
 console.log(`ok missing ${missing} terminates native tool turn and retains other draft files`);
}

// Real parent Host tools must also fence the workflow; a missing selected
// proofreading translation is mandatory even before any findings are written.
for(const missing of ['parent-source','proofread-translation','proofread-prescan','written-canonical','parent-bound-bible']){
 const dir=await mkdtemp(path.join(os.tmpdir(),'yn-parent-required-'));
 const source=path.join(dir,'source.txt'),translation=path.join(dir,'translation.txt');
 const canonical=path.join(dir,'AI_translation','source_translated.txt');
 await writeFile(source,'An actual complete sentence.');await writeFile(translation,'这是一句完整的句子。');
 const provider=fauxProvider({provider:missing,tokensPerSecond:100_000});
 const models=createModels();models.setProvider(provider.provider);
 const deleted=missing==='parent-source'?source:missing==='written-canonical'?canonical:missing==='parent-bound-bible'?path.join(dir,'AI_translation','_workspace','character_bible.md'):translation;
 const workflow=missing.startsWith('proofread')?'proofread':'translation';
 const bible=path.join(dir,'AI_translation','_workspace','character_bible.md');
 if(missing==='parent-bound-bible'){await mkdir(path.dirname(bible),{recursive:true});await writeFile(bible,'# Character Bible\n\n## Reader / 读者\n- Gender/pronouns: unknown; unknown; unknown\n- Terms of address: Reader\n');}

 provider.setResponses([
  fauxAssistantMessage(fauxToolCall((missing==='written-canonical'||missing==='parent-bound-bible')?'inspectTranslationContext':'readSourceLines',(missing==='written-canonical'||missing==='parent-bound-bible')?{}:{fromLine:1,toLine:1}),{stopReason:'toolUse'}),
  ...(missing==='written-canonical'?[fauxAssistantMessage(fauxToolCall('writeTranslationChunk',{fromLine:1,toLine:1,lines:['这是一句完整的句子。']}),{stopReason:'toolUse'})]:[]),
  async()=>{await rm(deleted);return fauxAssistantMessage(fauxToolCall(missing==='parent-source'?'readSourceLines':missing==='proofread-prescan'?'inspectTranslationContext':missing==='parent-bound-bible'?'writeTranslationChunk':'readTranslationLines',missing==='proofread-prescan'?{}:missing==='parent-bound-bible'?{fromLine:1,toLine:1,lines:['这是一句完整的句子。']}:{fromLine:1,toLine:1}),{stopReason:'toolUse'});},
  fauxAssistantMessage('Must never retry a missing task input.')
 ]);
 const service=new PiNativeSessionService({createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),
  createTools:createYnDomainTools,buildSystemPrompt:()=> 'Use the bound workflow tools.',enforceDomainCompletion:missing==='written-canonical'||missing==='proofread-prescan'});
 try{
  const session=await service.createSession(dir);
  await service.prompt({outputDir:dir,sourcePath:source,translationPath:translation,sessionId:session.id,workflowIntent:workflow,languagePair:'en->zh-CN',
   prompt:`Workflow: yn-${workflow}-v1.\nRead the bound files.`,providerId:provider.provider.id,modelId:provider.getModel().id});
  const active=[...service.active.values()][0];await active.promptTask;
  assert.match(active.error,/Restore this file before resuming/);assert.ok(active.error.includes(deleted));
  assert.equal(active.running,false);assert.equal(provider.state.callCount,missing==='written-canonical'?3:2);
  const reopened=await new PiSessionRepository(dir).open(session.id);
  try{const durable=await loadYnSessionHostState(reopened,session.id);assert.equal(durable.workflowSuspended,true);}finally{await reopened.close(BACKGROUND_CONTEXT);}
 }finally{await service.disposeWorkspace(dir);await rm(dir,{recursive:true,force:true});}
 console.log(`ok ${missing} stops the real parent workflow without model retries`);
}

// Enabling discovery is not a file binding. Both real task boundaries permit
// initially absent optional assets with the generated defaults enabled.
for (const workflow of ['translation', 'proofread']) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'yn-unbound-assets-'));
 const source=path.join(dir,'source.txt'),translation=path.join(dir,'translation.txt');
 await writeFile(source,'A complete sentence.');await writeFile(translation,'这是一句完整的句子。');
 const provider=fauxProvider({provider:`unbound-${workflow}`,tokensPerSecond:100_000});
 const models=createModels();models.setProvider(provider.provider);
 provider.setResponses([fauxAssistantMessage(fauxToolCall('inspectTranslationContext',{}),{stopReason:'toolUse'}),fauxAssistantMessage('Inspection completed.')]);
 const service=new PiNativeSessionService({createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),
  createTools:createYnDomainTools,buildSystemPrompt:()=> 'Inspect the task.',enforceDomainCompletion:false});
 try {
  const session=await service.createSession(dir);
  await service.prompt({outputDir:dir,sourcePath:source,translationPath:translation,sessionId:session.id,
   prompt:`Workflow: yn-${workflow}-v1.\nInspect.`,workflowIntent:workflow,languagePair:'en->zh-CN',
   characterBible:true,glossaryCandidates:true,providerId:provider.provider.id,modelId:provider.getModel().id});
  const active=[...service.active.values()][0];await active.promptTask;
  assert.equal(active.error,undefined);assert.equal(active.hostState.workflowSuspended,false);
  assert.equal(provider.state.callCount,2);
 }finally{await service.disposeWorkspace(dir);await rm(dir,{recursive:true,force:true});}
 console.log(`ok ${workflow} allows unbound optional assets with discovery defaults enabled`);
}
