import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../../src/main/agent/piNative/sessionService.ts';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-settlement-stop-audit-'));
const source=path.join(root,'source.txt');
await writeFile(source,'A complete first sentence.\nA complete second sentence.\nA complete third sentence.\n');
const models=createModels();
const parent=fauxProvider({provider:'settlement-parent',tokensPerSecond:100000});
const worker=fauxProvider({provider:'settlement-worker',tokensPerSecond:100000});
for(const p of [parent,worker])models.setProvider(p.provider);
const tool=name=>fauxAssistantMessage(fauxToolCall(name,{}),{stopReason:'toolUse'});
parent.setResponses([tool('inspectTranslationContext'),tool('runTranslationSubagents'),fauxAssistantMessage(fauxText('The background queue is running.'))]);
let releaseChild,childEntered;
const held=new Promise(r=>releaseChild=r),entered=new Promise(r=>childEntered=r);
worker.setResponses([async()=>{childEntered();await held;return tool('readAssignedSource');}]);
const errors=[];
let currentTools;
const service=new PiNativeSessionService({enforceDomainCompletion:true,
 createModelSelection:async({providerId})=>{const p=providerId==='settlement-worker'?worker:parent;return {models,model:p.getModel(),providerId:p.provider.id,modelId:p.getModel().id};},
 createTools:context=>(currentTools=createYnDomainTools(context)),
 buildSystemPrompt:()=> 'Inspect the translation context, start the complete background translation queue, then report it is running.'
});
let timeout;
try{
 const session=await service.createSession(root);
 await service.prompt({outputDir:root,sourcePath:source,sessionId:session.id,prompt:'Workflow: yn-translation-v1.\nTranslate the complete source.',languagePair:'en->zh-CN',
  providerId:parent.provider.id,modelId:parent.getModel().id,subagentProviderId:worker.provider.id,subagentModelId:worker.getModel().id,
  subagentEnabled:true,subagentCount:1,splitSize:2,glossaryCandidates:false,characterBible:false});
 await Promise.race([entered,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('Worker did not enter provider')),5000))]);
 const active=[...service.active.values()][0];
 await active.promptTask;
 const domain=active.domainRun;
 assert.ok(domain.snapshot().documents[0].activeSubagentBatch,'actual Host tool reserved a real batch');
 const stopping=service.abort(root,session.id);
 releaseChild();
 await stopping;
 const batches=active.subagents.list();
 const output={error:active.error,batches:batches.map(b=>({status:b.status,error:b.error})),suspended:domain.suspended,document:domain.snapshot().documents[0],parentCalls:parent.state.callCount,workerCalls:worker.state.callCount};
 console.log(JSON.stringify(output,null,2));
 assert.doesNotMatch(batches.find(batch=>batch.kind==='translation').error ?? '',/Host batch settlement failed/,'ordinary Stop must not cause Host batch settlement failure');
 assert.equal(active.error,undefined);
 assert.equal(domain.snapshot().documents[0].activeSubagentBatch,undefined,'Stop must settle the old batch ownership');
 assert.equal(active.hostState.workflowSuspended,true,'Stop must keep the workflow paused');
 console.log('PASS real Service Stop settles a reserved Host batch without reopening model work');
}finally{clearTimeout(timeout);releaseChild();await service.disposeWorkspace(root);await rm(root,{recursive:true,force:true});}
