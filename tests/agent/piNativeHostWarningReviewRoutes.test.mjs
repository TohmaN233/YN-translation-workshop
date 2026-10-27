import assert from 'node:assert/strict';
import {test} from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {parsePiSessionWarningReviewDecisionRequest} from '../../src/main/ipc/agentSessionRequest.ts';
import {createLanAgentGateway,normalizeLanAgentRequest,lanAgentBridgeScript} from '../../src/main/lanAgentRemote.ts';
import {createAgentApi} from '../../src/main/agentApi.ts';

test('warning decision parser validates the fixed choice and strips injected prompt/preparation data',()=>{
  const parsed=parsePiSessionWarningReviewDecisionRequest({outputDir:'project',sessionId:'owner',reviewId:'gate',decision:'review',request:{providerId:'synthetic',modelId:'test',sourcePath:'source.txt',prompt:'injected',images:[{}],workflowIntent:'proofread',taskPreparation:{}}});
  assert.equal(parsed.request.prompt,undefined);assert.equal(parsed.request.images,undefined);assert.equal(parsed.request.workflowIntent,undefined);assert.equal(parsed.request.taskPreparation,undefined);
  assert.equal(parsed.request.sourcePath,'source.txt');
  assert.throws(()=>parsePiSessionWarningReviewDecisionRequest({outputDir:'project',sessionId:'owner',reviewId:'gate',decision:'yes'}),/review or skip/);
});
test('LAN uses the shared workspace and exact Host command for both choices',async()=>{
  const requests=[];
  const gateway=createLanAgentGateway({sessionService:{async decideTranslationWarningReview(request){requests.push(request);return{decision:request.decision,continuing:request.decision==='review'};}},providerService:{}});
  for(const decision of ['review','skip']){
    const command=normalizeLanAgentRequest({method:'decideTranslationWarningReview',args:{outputDir:'injected',sessionId:'owner',reviewId:'gate',decision}});
    assert(command);assert.deepEqual(await gateway.invoke('shared-project',command),{decision,continuing:decision==='review'});
  }
  assert(requests.every(request=>request.outputDir==='shared-project'));
  assert.match(lanAgentBridgeScript('token',{outputDir:'shared-project'}),/if \(result\?\.continuing\) startInputConvergence/);
});
test('official Agent API exposes the pending gate and delegates skip without selecting a model',async()=>{
  const outputDir=path.join(os.tmpdir(),'yn-synthetic-route-only');let calls=0;
  const api=createAgentApi({version:'test',cwd:outputDir,sessions:async()=>[{id:'owner'}],state:async()=>({sessionId:'owner',running:false,phase:'idle',sequence:0,warningReview:{id:'gate',warningCount:2}}),lastReply:()=>undefined,
    model:async()=>{throw new Error('skip must never select a model');},
    decideTranslationWarningReview:async request=>{calls++;assert.deepEqual(request,{outputDir,sessionId:'owner',reviewId:'gate',decision:'skip'});return{decision:'skip',continuing:false};},dispose:async()=>{}});
  try{
    assert.deepEqual((await api.call('status',{outputDir,sessionId:'owner'})).warningReview,{id:'gate',warningCount:2});
    assert.deepEqual(await api.call('decideTranslationWarningReview',{outputDir,sessionId:'owner',reviewId:'gate',decision:'skip'}),{decision:'skip',continuing:false});assert.equal(calls,1);
  }finally{await api.close();}
});
