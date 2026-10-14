import assert from 'node:assert/strict';import vm from 'node:vm';
import {renderLineReviewHtml} from '../src/shared/core/html.ts';
const html=renderLineReviewHtml({title:'Cancel import',sourceText:'One row',lineReviewPath:'G:/project/review.html',workflow:{sourcePath:'G:/source.txt',outputDir:'G:/project'}});
const script=html.match(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/i)[1];
const start=script.indexOf('function captureDraftImportState('),end=script.indexOf('\nfunction openLineRepair(',start);assert.ok(start>=0&&end>start);
let commitCalls=0;
const ctx=vm.createContext({Promise,String,Number,Error,Math,syncedLines:[],artifactImportBusy:false,artifactClosing:false,artifactCancelled:false,
 rowsEl:{inert:false},refreshAgentArtifactsButton:{disabled:false},artifactCancelButton:{disabled:false},lineReviewClientId:'test',localLineMutationSequence:0,
 state:{edits:{1:'prior manual draft'},status:{1:'manual'},documentRevision:5},workflow:{paths:{sourcePath:'G:/source.txt',outputDir:'G:/project'}},
 data:{lineReviewPath:'G:/project/review.html',rows:[{line:1}],labels:{artifactCancelled:'cancelled',artifactMerging:'{done}/{total}',importFailed:'failed'}},deferredArtifactCanonicalStates:[],
 invokeBridge:()=>({buildAgentImportPlan:async()=>({ok:true,lineCount:1,lines:['candidate']}),persistHtmlState:async()=>{commitCalls++;return {ok:true,mutationAccepted:true}}}),
 cancelArtifactOperation:async()=>{},flushQueuedLineReviewStateWrite:async()=>{},lastHostStateWrite:Promise.resolve(),
 artifactOperationStarted:()=>{ctx.artifactCancelled=false;return 'request'},artifactOperationFinished:()=>{},artifactArguments:()=>({}),setAiStatus:()=>{},
 setBoundTranslationPath:()=>{},updateSaveTxtVisibility:()=>{},trackHostStateRequest:()=>{},applyCanonicalLineReviewState:()=>{},updateProjectState:()=>{},render:()=>{},
 setTimeout:callback=>queueMicrotask(()=>{ctx.artifactCancelled=true;callback()})});
vm.runInContext(script.slice(start,end),ctx);
await vm.runInContext("importCandidateDraft('G:/project/candidate.txt','G:/source.txt')",ctx);
assert.equal(commitCalls,0,'cancellation during the last batch yield must prevent accepting a commit');
assert.equal(ctx.state.edits[1],'prior manual draft');assert.equal(ctx.rowsEl.inert,false);assert.equal(ctx.artifactImportBusy,false);
console.log('The actual HTML import function checks cancellation after its final yield and preserves the prior draft');
