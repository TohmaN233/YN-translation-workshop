import assert from 'node:assert/strict';
import fsp,{mkdtemp,mkdir,readFile,readdir,writeFile,rm,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../src/main/agent/piNative/sessionService.ts';
import {PiSessionRepository} from '../src/main/agent/piNative/sessionRepository.ts';
import {readSessionEntries,getOpenDiskSession} from '../src/main/agent/piNative/sessionAccess.ts';
import {configurePdfStructurePreparation,withPdfPreparationContext,pdfStructureDigest,verifyPdfStructureScopeEvidence} from '../src/main/pdfStructurePreparation.ts';
import {decodeProjectPaths} from '../src/main/projectPaths.ts';
import {applyPdfStructurePlan} from '../src/main/pdfStructurePlan.ts';
import {readPdfLayout,preparePdfDocument,preflightPdfRequest} from '../src/main/pdfDocuments.ts';
import {pdfProtectionHash} from '../src/main/pdfTypes.ts';
import {generateBuiltinTaskReview} from '../src/main/builtinTaskDocuments.ts';
import {builtinTaskDefaults} from '../src/shared/builtinTasks.ts';
import {readReviewHtml} from '../src/main/reviewHtmlPortability.ts';
const digest=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),12000);})]);}finally{clearTimeout(timer);}}
const allChecks=()=>({readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true});
// Exact final JSON from actual attempt 4, native session pi_b83a4b90-5b11-4931-8039-ead09be00729.
const capturedCompactRejection={version:1,useDraft:false,revision:1,audit:{readingOrder:false,paragraphs:false,tables:false,figures:false,protectedContent:false,
 issues:['Source ID 144 is rejected by validation: heading source IDs cannot enter a paragraph; the latest draft does not pass hard checks.']}};
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
function indexFrom(prompt){const marker=prompt.includes('Document index: ')?'Document index: ':'Index: ';return JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length).split('\nApplied source-ID plan: ')[0]);}
function toolData(context,name){const m=context.messages.filter(message=>message.role==='toolResult'&&message.toolName===name).at(-1)
 ??context.messages.filter(message=>message.role==='toolResult').at(-1);assert.ok(m,'native source inspection tool result reaches provider');return JSON.parse(m.content.find(block=>block.type==='text').text);}
async function assertSingleScopeAudit(f,source,layout,receipt,expected){
 const {scopeEvidence,...payload}=receipt.audit;
 assert.deepEqual(payload,expected,'Host aggregation preserves the exact typed version/checks/issues payload');
 assert.equal(scopeEvidence.length,1);assert.equal(layout.preparation.auditScopeCount,1);
 assert.equal(layout.preparation.auditScopesHash,pdfStructureDigest(scopeEvidence));assert.equal(layout.preparation.auditHash,pdfStructureDigest(receipt.audit));
 const scope=scopeEvidence[0];assert.deepEqual(scope.audit,expected);assert.match(scope.packetHash,/^[a-f0-9]{64}$/);
 assert.deepEqual(scope.corePhysicalLines,layout.physicalBlocks.map(block=>block.line));
 assert.deepEqual(scope.inspectedPhysicalLines,layout.physicalBlocks.map(block=>block.line));
 assert.equal(scope.inspectedOwnerKeys.length,layout.blocks.length);assert.equal(new Set(scope.inspectedOwnerKeys).size,layout.blocks.length);
 assert.ok(scope.edgeKeys.length&&scope.relationKeys.length>=2,'single scope includes global section/order responsibility');
 assert.ok(scope.inspectedRecordIndices.length>=layout.physicalBlocks.length+layout.blocks.length);
 assert.ok(scope.sessionId&&scope.providerId&&scope.modelId,'scope evidence pins the settled native identity');
 const mechanical=decodeProjectPaths(JSON.parse(await readFile(source+'.pdf-mechanical.json','utf8')),f.root);
 verifyPdfStructureScopeEvidence(mechanical,layout,receipt.audit,applyPdfStructurePlan(mechanical,receipt.plan).geometryFindings);return scope;
}
function planFrom(rows){
 const byText=new Map(rows.map(row=>[row.text,row]));
 for(const text of ['1 Introduction','Method','Score','Alpha','5','Beta','6'])assert.ok(byText.has(text),'actual PDF extraction must contain '+text);
 const first=rows.find(row=>row.text.startsWith('A complete source paragraph'));
 const continuation=rows.find(row=>row.text.startsWith('continues through'));
 assert.ok(first&&continuation,'physical wrapped source lines remain independently inspectable');
 const body=[first.physicalLine,continuation.physicalLine],cells=new Set(['Method','Score','Alpha','5','Beta','6'].map(text=>byText.get(text).physicalLine));
 const paragraphs=[];
 for(const row of rows){
  if(row.physicalLine===continuation.physicalLine)continue;
  const kind=row.reference?'preserved':row.text==='1 Introduction'?'heading':/^(?:Table|Figure) 1:/.test(row.text)?'caption':row.protection||/^\d+$/.test(row.text)?'preserved':cells.has(row.physicalLine)?'table-cell':'paragraph';
  paragraphs.push({physicalLines:row===first?body:[row.physicalLine],kind,reason:'Observed source IDs and aligned original geometry.'});
 }
 const caption=rows.find(row=>row.text.startsWith('Table 1:')).physicalLine;
 const tables=[{id:'source-results',page:1,columnCount:2,captionPhysicalLine:caption,
  rows:[['Method','Score'],['Alpha','5'],['Beta','6']].map(pair=>pair.map((text,column)=>({physicalLines:[byText.get(text).physicalLine],column,columnSpan:1})))}];
 return{version:1,paragraphs,tables,audit:{...allChecks(),issues:[]}};
}

async function makeFixture(mode){
 const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-pipeline-'+mode+'-')),original=path.join(root,'source.pdf');
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.TimesRoman),page=pdf.addPage([595.276,841.89]);
 const draw=(text,x,y,size=12)=>page.drawText(text,{x,y,size,font,color:rgb(0,0,0)});
 draw('1 Introduction',40,770,16);
 draw('A complete source paragraph begins on one physical line and',40,728);
 draw('continues through its next visual line without losing meaning.',40,712);
 if(['feedback-merge-anchors','feedback-split-repair'].includes(mode)){
  draw('The second owner continues the same source paragraph and',40,696);
  draw('has its complete final visual tail.',40,680);
 }
 draw('Table 1: Source structure statistics.',40,658);
 for(const [y,pair] of [[630,['Method','Score']],[612,['Alpha','5']],[594,['Beta','6']]]){draw(pair[0],40,y,11);draw(pair[1],260,y,11);}
 draw('The report follows its complete table.',40,548);
 if(mode==='source-ownership'){
  const canvas=createCanvas(100,70),context=canvas.getContext('2d');context.fillStyle='#225588';context.fillRect(0,0,100,70);
  const image=await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image,{x:40,y:320,width:100,height:70});page.drawImage(image,{x:200,y:320,width:100,height:70});
  draw('(a)',82,304,10);draw('(b)',242,304,10);
  draw('Figure 1: Two source panels.',40,260);draw('Panel descriptions remain translatable.',40,244);
  const referencePage=pdf.addPage([595.276,841.89]);
  for(const [text,y] of [['References',770],['[1] Example Author. Original source citation',740],['continues on its next physical row.',724],['2',22]])referencePage.drawText(text,{x:40,y,size:12,font});
 }
 draw('1',292,22,10);
 const bytes=Buffer.from(await pdf.save());await writeFile(original,bytes);
 const provider=fauxProvider({provider:'pdf-pipeline-'+mode,tokensPerSecond:100000,models:[{id:'native-fixture',reasoning:false,contextWindow:64000,maxTokens:4096}]});
 const models=createModels();models.setProvider(provider.provider);
 const service=new PiNativeSessionService({createTools:()=>{throw Error('Ordinary workflow tools must not enter structure preparation');},
  createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})});
 const settings=builtinTaskDefaults({outputDir:root,sourcePath:original,sourceKind:'file',fileType:'pdf',inputMode:'separate',locale:'en-US',
  glossaryCandidates:false,characterBible:false});
 const html=path.join(root,'.translation-workshop','html','builtin-pipeline.html');
 return{root,original,bytes,originalHash:digest(bytes),provider,service,settings,html,mode,turns:[],events:[],states:[],stages:[],sourceRows:[],plan:null,
  async generate(signal,onStage){return withPdfPreparationContext({signal,onStage:(stage,details)=>{this.stages.push(stage);onStage?.(stage,details);}},
   ()=>generateBuiltinTaskReview(settings,'translation','pipeline',signal));},
  async close(){await service.disposeWorkspace(root);assert.equal(digest(await readFile(original)),this.originalHash,'original PDF bytes stay read-only');if(process.env.YN_PDF_TEST_RETAIN==='1')console.log('Retained PDF pipeline fixture: '+root);else await rm(root,{recursive:true,force:true});}};
}
function installNative(f,{proposalDelay,auditDelay,enteredTool,releaseTool}={}){
 let activeStage='';f.service.subscribeEvents(event=>{f.events.push({...event,stage:activeStage,htmlExisted:existsSync(f.html)});});
 f.service.subscribeState((_,state)=>f.states.push(state));
 configurePdfStructurePreparation(async request=>{
  const audit=request.tools.some(tool=>tool.name==='readPdfPreparedStructure'),stage=audit?'audit':'proposal',index=indexFrom(request.prompt);
  activeStage=stage;f.turns.push(stage);
  const readTo=(stage==='proposal'&&f.mode==='missing-source'||stage==='audit'&&f.mode==='missing-audit-source')?index.sourceCount-1:index.sourceCount;
  const responses=[
   async context=>{
    if(audit)assert.equal(context.messages.some(message=>message.role==='assistant'),false,'fresh audit must not inherit proposal assistant judgment');
    return call('readPdfStructureSource',{fromLine:1,toLine:readTo});
   },
   async context=>{
    const data=toolData(context,'readPdfStructureSource');
    assert.equal(data.total,index.sourceCount);
    f.sourceRows.push({stage,rows:data.rows});
    if(audit){
     if(f.mode==='missing-prepared')return fauxAssistantMessage(fauxText(JSON.stringify({version:1,checks:allChecks(),issues:[]})));
     const count=index.preparedRowCount;
     return call('readPdfPreparedStructure',{fromLine:1,toLine:count});
    }
    let plan;
    if(f.mode==='missing-source'){
     plan={version:1,paragraphs:data.rows.map(row=>({physicalLines:[row.physicalLine],kind:'paragraph',reason:'Unaccepted incomplete fixture.'})),tables:[],audit:{...allChecks(),issues:[]}};
    }else plan=planFrom(data.rows);
    if(f.mode==='drop')plan.paragraphs.pop();
    if(f.mode==='duplicate')plan.paragraphs.push(structuredClone(plan.paragraphs[0]));
    if(f.mode==='foreign')plan.paragraphs[0].physicalLines=[index.sourceCount+20];
    if(f.mode==='rewrite')plan.paragraphs[0].text='Invented source text';
    if(f.mode==='source-ownership'){
     const citationIds=data.rows.filter(row=>row.text.startsWith('[1] Example')||row.text.startsWith('continues on its next physical row.')).map(row=>row.physicalLine);
     plan.paragraphs=plan.paragraphs.flatMap(paragraph=>paragraph.physicalLines.some(id=>citationIds.includes(id))?paragraph.physicalLines.includes(citationIds[0])?[{physicalLines:citationIds,kind:'preserved',reason:'Same-page ordinary reference wraps retain original glyphs.'}]:[]:paragraph);
     const folio=plan.paragraphs.find(paragraph=>data.rows.find(row=>row.physicalLine===paragraph.physicalLines[0])?.text==='1');
     plan.paragraphs=plan.paragraphs.filter(paragraph=>paragraph!==folio);plan.paragraphs.push(folio);
    }
    f.plan=structuredClone(plan);
    if(f.mode==='source-ownership')return call('readPdfStructureDraft',{fromParagraph:501,toParagraph:1023});
    if(proposalDelay){proposalDelay.entered.resolve();await proposalDelay.release.promise;}
    assert.equal(existsSync(f.html),false,'proposal has not yet settled, so HTML must not exist');
    return fauxAssistantMessage(fauxText(JSON.stringify(plan)));
   },
   ...(!audit&&f.mode==='source-ownership'?[async context=>{
    const result=context.messages.filter(message=>message.role==='toolResult').at(-1);
    assert.equal(result.isError,true);assert.match(result.content[0].text,/current total is \d+, maximum 500/);assert.match(result.content[0].text,/No rows were read/);
    return fauxAssistantMessage(fauxText(JSON.stringify(f.plan)));
   }]:[]),
   ...(audit?[async context=>{
    const data=toolData(context,'readPdfPreparedStructure');f.preparedRows=data.rows;f.preparedData=data;f.auditIndex=index;
    assert.equal(data.rows.length,data.total);
    assert.ok(data.rows.some(row=>row.physicalLines.length===2&&row.text.includes('without losing meaning.')),'audit reads actual reconstructed complete paragraph');
    if(auditDelay){auditDelay.entered.resolve();await auditDelay.release.promise;}
    assert.equal(existsSync(f.html),false,'audit has not yet settled, so HTML must not exist');
    if(f.mode==='source-ownership')return call('readPdfStructureSource',{fromLine:1,toLine:index.sourceCount,includeGeometry:true});
    const checks=allChecks();if(f.mode==='audit-false')checks.paragraphs=false;
    return call('submitPdfStructureAudit',{version:1,checks,issues:f.mode==='audit-false'?[{physicalLines:[2,3],message:'Unresolved source paragraph boundary.'}]:[],...(f.mode==='audit-false'?{unsupported:{reason:'This fixture cannot provide a source-preserving correction for its unresolved paragraph boundary.'}}:{})});
   },...(f.mode==='source-ownership'?[
    async context=>{f.geometryRows=toolData(context,'readPdfStructureSource').rows;return call('readPdfPreparedStructure',{fromLine:1,toLine:1});},
    async context=>{const page=toolData(context,'readPdfPreparedStructure');assert.equal(page.tables,undefined,'document metadata is not repeated by default');return call('readPdfPreparedStructure',{fromLine:1,toLine:1,includeMetadata:true});},
    async context=>{const page=toolData(context,'readPdfPreparedStructure');assert.deepEqual(page.tables,f.preparedData.tables,'document metadata remains explicitly retrievable');assert.equal(page.lineNumberSpace,'logical');return call('submitPdfStructureAudit',{version:1,checks:allChecks(),issues:[]});}
   ]:[]),async context=>{
    if(f.mode==='missing-audit-source'){assert.equal(context.messages.filter(message=>message.role==='toolResult').at(-1).isError,true);return fauxAssistantMessage(fauxText('Inspection remains incomplete; no authoritative audit was submitted.'));}
    assert.equal(toolData(context,'submitPdfStructureAudit').submitted,true);return fauxAssistantMessage(fauxText('Audit submitted.'));
   }]:[])
  ];
  if(!audit&&f.mode.startsWith('draft-')){
   for(const name of ['readPdfStructureDraft','revisePdfStructureDraft','checkPdfStructureDraft'])assert.equal(request.tools.find(tool=>tool.name===name).executionMode,'sequential','shared native draft tools must serialize same-assistant calls');
   const draftCount=Number(request.prompt.match(/draft \((\d+) paragraphs/)[1]);
   const patch=(physicalLines,kind='paragraph')=>({physicalLines,kind,reason:'Inspected source IDs; revise only these visual lines.'});
   let baseline,body,revision;
   const editing=[
    async context=>{const data=toolData(context,'readPdfStructureSource');f.sourceRows.push({stage,rows:data.rows});f.plan=planFrom(data.rows);return call('readPdfStructureDraft',{fromParagraph:1,toParagraph:draftCount});},
    async context=>{
     baseline=toolData(context,'readPdfStructureDraft');revision=baseline.revision;
     assert.deepEqual(baseline.paragraphs.flatMap(item=>item.physicalLines).sort((a,b)=>a-b),f.sourceRows[0].rows.map(item=>item.physicalLine));
     body=f.plan.paragraphs.find(item=>item.physicalLines.length===2).physicalLines;
     if(f.mode==='draft-cas')return call('revisePdfStructureDraft',{expectedRevision:999,paragraphs:[patch(body)]});
     if(f.mode==='draft-partial')return call('revisePdfStructureDraft',{expectedRevision:revision,paragraphs:[patch([body[0]])]});
     return call('revisePdfStructureDraft',{expectedRevision:revision,paragraphs:f.mode==='draft-no-progress'?[patch(body,'preserved')]:body.map(id=>patch([id]))});
    },
    async context=>{
     const result=context.messages.filter(message=>message.role==='toolResult').at(-1);
     if(['draft-cas','draft-partial'].includes(f.mode)){
      assert.equal(result.isError,true);assert.match(result.content[0].text,f.mode==='draft-cas'?/stale revision/:/partial groups/);
      return fauxAssistantMessage(fauxText(JSON.stringify({version:1,useDraft:true,revision:999,audit:{...allChecks(),issues:[]}})));
     }
     revision=toolData(context,'revisePdfStructureDraft').revision;assert.equal(revision,baseline.revision+1);
     if(f.mode==='draft-no-progress')return call('checkPdfStructureDraft',{});
     return call('revisePdfStructureDraft',{expectedRevision:revision,paragraphs:[patch(body)]});
    },
    async context=>{
     if(f.mode==='draft-no-progress'){const result=toolData(context,'checkPdfStructureDraft');assert.equal(result.valid,false);assert.match(result.finding,/writable prose/);return call('checkPdfStructureDraft',{});}
     revision=toolData(context,'revisePdfStructureDraft').revision;assert.equal(revision,baseline.revision+2);
     if(f.mode==='draft-unchecked')return fauxAssistantMessage(fauxText(JSON.stringify({version:1,useDraft:true,revision,audit:{...allChecks(),issues:[]}})));
     return call('checkPdfStructureDraft',{});
    },
    ...(f.mode==='draft-no-progress'||['draft-cas','draft-partial','draft-unchecked'].includes(f.mode)?[]:[async context=>{
     const checked=toolData(context,'checkPdfStructureDraft');assert.equal(checked.valid,true);assert.equal(checked.revision,revision);assert.equal(checked.metrics.coverage,1);
     f.plan={version:1,paragraphs:baseline.paragraphs.map(item=>item.physicalLines.some(id=>body.includes(id))?patch(body):item),tables:baseline.tables,audit:{...allChecks(),issues:[]}};
     return fauxAssistantMessage(fauxText(JSON.stringify({version:f.mode==='draft-bad-version'?2:1,useDraft:true,revision:f.mode==='draft-stale-ack'?revision-1:revision,audit:{...allChecks(),paragraphs:f.mode!=='draft-audit-false',issues:[]}})));
    }])
   ];
   responses.splice(1,responses.length-1,...editing);
   if(['draft-batch','draft-reason-no-progress','draft-new-attempt','draft-captured-rejection','draft-compact-malformed'].includes(f.mode)){
    const compact=revision=>fauxAssistantMessage(fauxText(JSON.stringify({version:1,useDraft:true,revision,audit:{...allChecks(),issues:[]}})));
    const sourceAndDraft=editing[0];
    const start=async context=>{
     baseline=toolData(context,'readPdfStructureDraft');body=f.plan.paragraphs.find(item=>item.physicalLines.length===2).physicalLines;
     if(['draft-batch','draft-captured-rejection','draft-compact-malformed'].includes(f.mode))return fauxAssistantMessage([
      fauxToolCall('revisePdfStructureDraft',{expectedRevision:0,paragraphs:[patch(body)]}),
      fauxToolCall('revisePdfStructureDraft',{expectedRevision:0,paragraphs:[{...patch(body),reason:'Stale sibling edit in the same assistant.'}]}),
      fauxToolCall('checkPdfStructureDraft',{})
     ],{stopReason:'toolUse'});
     return call('revisePdfStructureDraft',{expectedRevision:0,paragraphs:[patch(body,'preserved')]});
    };
    if(['draft-batch','draft-captured-rejection','draft-compact-malformed'].includes(f.mode))responses.splice(1,responses.length-1,sourceAndDraft,start,async context=>{
     const results=context.messages.filter(message=>message.role==='toolResult').slice(-3);assert.deepEqual(results.map(message=>message.toolName),['revisePdfStructureDraft','revisePdfStructureDraft','checkPdfStructureDraft']);
     assert.equal(JSON.parse(results[0].content[0].text).revision,1);assert.equal(results[1].isError,true);assert.match(results[1].content[0].text,/stale revision/);
     const checked=JSON.parse(results[2].content[0].text);assert.equal(checked.valid,true);assert.equal(checked.revision,1,'same-assistant check sees the first successful edit');
     const mechanical=await mechanicalPath(f.root),persisted=JSON.parse(await readFile(mechanical.replace('.pdf-mechanical.json','.pdf-draft-revision-1.json'),'utf8'));assert.equal(persisted.revision,1,'checked edit was durably retained before acceptance');
     if(f.mode==='draft-captured-rejection')return fauxAssistantMessage(fauxText(JSON.stringify(capturedCompactRejection)));
     if(f.mode==='draft-compact-malformed')return fauxAssistantMessage(fauxText(JSON.stringify({...capturedCompactRejection,useDraft:'false'})));
     return compact(1);
    });
    else{
     const invalid=async context=>{assert.equal(toolData(context,'revisePdfStructureDraft').revision,1);return call('checkPdfStructureDraft',{});};
     const afterFirst=async context=>{const checked=toolData(context,'checkPdfStructureDraft');assert.equal(checked.valid,false);assert.match(checked.finding,/writable prose/);
      return call('revisePdfStructureDraft',{expectedRevision:1,paragraphs:f.mode==='draft-reason-no-progress'?[{...patch(body,'preserved'),reason:'New wording cannot establish new structure.'}]:[patch([body[0]])]});
     };
     if(f.mode==='draft-reason-no-progress')responses.splice(1,responses.length-1,sourceAndDraft,start,invalid,afterFirst,async context=>{
      assert.equal(toolData(context,'revisePdfStructureDraft').revision,2,'reason-only changes may advance CAS while keeping structural shape');return call('checkPdfStructureDraft',{});
     });
     else responses.splice(1,responses.length-1,sourceAndDraft,start,invalid,afterFirst,
      async context=>{const result=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(result.isError,true);assert.match(result.content[0].text,/partial groups/);return call('checkPdfStructureDraft',{});},
      async context=>{const checked=toolData(context,'checkPdfStructureDraft');assert.equal(checked.valid,false);assert.equal(checked.revision,1,'a different rejected patch allows feedback at the same revision');return call('revisePdfStructureDraft',{expectedRevision:1,paragraphs:[patch([...body].reverse())]});},
      async context=>{assert.equal(toolData(context,'revisePdfStructureDraft').revision,2);return call('checkPdfStructureDraft',{});},
      async context=>{const checked=toolData(context,'checkPdfStructureDraft');assert.equal(checked.valid,true);assert.ok(checked.geometryFindings?.length,'different geometric source order is a clue for model correction, not automatic Host rejection');return call('revisePdfStructureDraft',{expectedRevision:2,paragraphs:[patch(body)]});},
      async context=>{assert.equal(toolData(context,'revisePdfStructureDraft').revision,3);return call('checkPdfStructureDraft',{});},
      async context=>{assert.equal(toolData(context,'checkPdfStructureDraft').valid,true);return compact(3);}
     );
    }
   }
  }
  f.provider.setResponses(responses);
  const tools=enteredTool?request.tools.map(tool=>tool.name!=='readPdfStructureSource'?tool:{...tool,async execute(...args){
   enteredTool.resolve();await releaseTool.promise;args[2]?.throwIfAborted();return tool.execute(...args);
  }}):request.tools;
  const result=await f.service.runPdfStructurePreparation({...request,tools});
  assert.equal(f.service.hasActiveWork(f.root),false,'native request includes its real durable settlement');
  assert.equal(existsSync(f.html),false,'even a completed native turn is not an HTML gate');
  return result;
 });
}
async function nativeAudit(f,sessionId){
 const repo=new PiSessionRepository(f.root),metadata=await repo.findMetadata(sessionId);
 assert.equal(getOpenDiskSession(metadata.path),undefined);
 const index=JSON.parse(await readFile(metadata.path+'.yn-index.json','utf8')).index;assert.equal(index.committedBytes,(await stat(metadata.path)).size);
 const session=await repo.open(sessionId);try{return await readSessionEntries(session);}finally{await repo.close();}
}
async function mechanicalPath(root){
 const scan=async folder=>{const found=[];for(const item of await readdir(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())found.push(...await scan(file));else if(item.name.endsWith('.pdf-mechanical.json'))found.push(file);}return found;};
 const files=await scan(path.join(root,'.translation-workshop','extracted-text'));assert.equal(files.length,1);return files[0];
}
async function assertNoHtml(f){
 assert.equal(existsSync(f.html),false);
 const folder=path.dirname(f.html);if(existsSync(folder))assert.ok(!(await readdir(folder)).some(name=>name.endsWith('.html')));
}
const section=process.argv.find(argument=>argument.startsWith('--section='))?.slice('--section='.length)??'all';
if(!['all','base','feedback','typed'].includes(section))throw Error('Unknown PDF pipeline test section: '+section);
if(['all','base'].includes(section)){
{
 const f=await makeFixture('accepted');installNative(f);
 try{
  const generated=await f.generate(undefined,stage=>{assert.equal(existsSync(f.html),false,'all gate stages precede HTML write');});
  const document=generated.documents[0],layout=await readPdfLayout(document.sourcePath,f.root);
  assert.ok(existsSync(f.html));assert.deepEqual(f.turns,['proposal','audit']);
  assert.equal(f.events.filter(event=>event.event.type==='settled').length,2);
  assert.ok(f.events.filter(event=>event.event.type==='settled').every(event=>!event.htmlExisted),'both actual native settlements precede HTML');
  assert.deepEqual(f.stages,['structuring','validating','auditing','accepted']);
  assert.equal(layout.preparation.originalHash,f.originalHash);assert.equal(layout.preparation.sourceInspectionCoverage,1);assert.equal(layout.preparation.auditInspectionCoverage,1);
  assert.equal(layout.preparation.metrics.coverage,1);assert.equal(layout.preparation.metrics.duplicates,0);assert.equal(layout.preparation.metrics.foreign,0);assert.equal(layout.preparation.metrics.semanticAuditAccepted,true);
  assert.equal(layout.preparation.planHash,pdfStructureDigest(f.plan));
  assert.equal(digest(await readFile(document.sourcePath)),layout.sourceHash);
  assert.deepEqual(f.sourceRows.map(item=>item.rows.map(row=>row.physicalLine)),[layout.physicalBlocks.map(row=>row.line),layout.physicalBlocks.map(row=>row.line)]);
  const entries=await nativeAudit(f,layout.preparation.sessionId);
  assert.equal(entries.filter(entry=>entry.type==='custom'&&entry.customType==='yn_pdf_structure_preparation'&&entry.data.phase==='completed').length,2);
  assert.equal(entries.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult').length,4);
  const html=await readReviewHtml(f.html),data=JSON.parse(html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.rows.map(row=>row.source),layout.blocks.map(row=>row.text));assert.equal(layout.structureTables[0].columnCount,2);assert.equal(layout.structureTables[0].rows.length,3);
  assert.ok(layout.blocks.some(row=>row.fragments.length===2));assert.ok(layout.blocks.some(row=>row.structureKind==='heading'));
  const before=f.provider.state.callCount;
  const warm=await f.generate();assert.equal(warm.documents[0].sourcePath,document.sourcePath);assert.equal(f.provider.state.callCount,before,'accepted warm preparation reuses zero new native/model turns');
  const layoutFile=document.sourcePath+'.pdf-layout.json',receiptFile=document.sourcePath+'.pdf-structure.json',mechanicalFile=document.sourcePath+'.pdf-mechanical.json';
  for(const [name,file,mutate] of [
   ['receipt',receiptFile,value=>{value.audit.checks.tables=false;}],
   ['physical-hash',mechanicalFile,value=>{value.physicalBlocks[0].text+=' tampered';}],
   ['absent-preparation',layoutFile,value=>{delete value.preparation;value.protectionHash=pdfProtectionHash(value);}],
   ['mechanical-receipt-hash',layoutFile,value=>{value.preparation.mechanicalHash='0'.repeat(64);value.protectionHash=pdfProtectionHash(value);}]
   ,['obsolete-prompt',layoutFile,value=>{value.preparation.promptVersion=8;value.protectionHash=pdfProtectionHash(value);}]
  ]){
   const bytes=await readFile(file),value=JSON.parse(bytes);mutate(value);await writeFile(file,JSON.stringify(value));
   await assert.rejects(readPdfLayout(document.sourcePath,f.root),/audit failed|binding changed|acceptance|evidence changed|inline structure|protection/i,name+' must invalidate warm binding');
   await assert.rejects(preflightPdfRequest({outputDir:f.root,sourcePath:document.sourcePath}),/audit failed|binding changed|acceptance|evidence changed|inline structure|protection/i,name+' must stop native Host preflight');
   await writeFile(file,bytes);await readPdfLayout(document.sourcePath,f.root);
  }
  assert.equal(digest(await readFile(f.original)),f.originalHash);
  console.log('ok real PDF extraction → native source-ID plan → worker apply → fresh native audit → sealed HTML; exact table/paragraph ownership, warm reuse and tamper/Host guards');
 }finally{await f.close();}
}
{
 const f=await makeFixture('source-ownership');installNative(f);
 try{
  const generated=await f.generate(),source=generated.documents[0].sourcePath,layout=await readPdfLayout(source,f.root);
  assert.ok(existsSync(f.html));assert.deepEqual(f.turns,['proposal','audit']);
  assert.equal(f.preparedData.lineNumberSpace,'logical');assert.equal(f.preparedData.sourceIdSpace,'physical');
  assert.ok(f.preparedRows.every(row=>Number.isInteger(row.logicalLine)&&!Object.hasOwn(row,'line')));
  assert.ok(f.sourceRows[0].rows.every(row=>!Object.hasOwn(row,'x')&&!Object.hasOwn(row,'fontSize')),'source geometry is opt-in');
  assert.equal(f.auditIndex.mechanicalParagraphs,undefined);assert.equal(f.auditIndex.preparedRowCount,layout.blocks.length);assert.equal(f.auditIndex.appliedPlanHash,pdfStructureDigest(f.plan));
  assert.deepEqual(f.geometryRows.map(row=>[row.physicalLine,row.text]),f.sourceRows[0].rows.map(row=>[row.physicalLine,row.text]));
  for(const row of f.geometryRows){const original=layout.physicalBlocks.find(block=>block.line===row.physicalLine);assert.equal(row.x,Math.round(original.x*100)/100);assert.equal(row.fontSize,Math.round(original.fontSize*100)/100);}
  const sourceCaption=f.sourceRows[0].rows.find(row=>row.text.startsWith('Figure 1:')).physicalLine;
  assert.ok(f.auditIndex.figureIndex.references.some(ref=>ref.captionPhysicalLine===sourceCaption),'figure captions are original physical IDs, not base logical rows');
  assert.ok(f.auditIndex.figureIndex.references.every(ref=>!Object.hasOwn(ref,'captionLine')));
  const physical=f.sourceRows[0].rows,sourceReferenceIds=physical.filter(row=>row.reference).map(row=>row.physicalLine);
  const ownedReferenceIds=f.preparedRows.flatMap(row=>row.referenceOwnership?.physicalLines??[]);
  assert.deepEqual(ownedReferenceIds.slice().sort((a,b)=>a-b),sourceReferenceIds.slice().sort((a,b)=>a-b),'prepared references bind original physical identities, not new output positions');
  const citation=f.preparedRows.find(row=>row.text.startsWith('[1] Example'));
  assert.equal(citation.kind,'preserved');assert.equal(citation.physicalLines.length,2);assert.equal(citation.referenceOwnership.readonly,true);assert.equal(citation.referenceOwnership.basis,'original-physical-source');
  assert.equal(citation.referenceOwnership.rendering,'original-source-glyphs');assert.deepEqual(citation.referenceOwnership.sourcePages,[2]);
  const movedFolio=f.preparedRows.at(-1);assert.equal(movedFolio.text,'1');assert.equal(movedFolio.referenceOwnership,undefined,'page-1 folio after references does not acquire read-only reference identity');
  assert.equal(movedFolio.folioPresentation.mayOmitFromReflow,true);assert.equal(movedFolio.folioPresentation.sourceOwned,true);
  const secondFolio=f.preparedRows.find(row=>row.text==='2');assert.equal(secondFolio.folioPresentation.mayOmitFromReflow,true);assert.equal(secondFolio.referenceOwnership.readonly,true,'source-defined reference protection can coexist with source-owned folio omission');
  assert.equal(layout.figureGroups.length,1);assert.equal(layout.figureGroups[0].physicalLines.length,2);
  const labels=f.preparedRows.filter(row=>row.figureLabelOwnership?.length);
  assert.equal(labels.length,2);
  for(const label of labels){assert.equal(label.kind,'preserved');assert.equal(label.protection,'math');assert.equal(label.figureLabelOwnership[0].renderedInGroup,true);assert.equal(label.figureLabelOwnership[0].groupId,layout.figureGroups[0].id);assert.deepEqual(label.figureLabelOwnership[0].physicalLines,label.physicalLines);assert.deepEqual(label.figureLabelOwnership[0].referenceIds,layout.figureGroups[0].referenceIds);
   const {x,y,width,height}=layout.figureGroups[0],round=value=>Math.round(value*100)/100;assert.deepEqual(label.figureLabelOwnership[0].sourceFrame,{x:round(x),y:round(y),width:round(width),height:round(height)});}
  const caption=f.preparedRows.find(row=>row.text.startsWith('Figure 1:'));assert.equal(caption.kind,'caption');assert.equal(caption.figureLabelOwnership,undefined);assert.equal(caption.referenceOwnership,undefined);
  const description=f.preparedRows.find(row=>row.text.startsWith('Panel descriptions'));assert.equal(description.kind,'paragraph');assert.equal(description.figureLabelOwnership,undefined);assert.equal(description.referenceOwnership,undefined);
  assert.equal(layout.preparation.metrics.coverage,1);assert.equal(layout.preparation.metrics.nativeCoverage,1);assert.equal(layout.preparation.metrics.figureCoverage,1);assert.equal(layout.preparation.sourceInspectionCoverage,1);assert.equal(layout.preparation.auditInspectionCoverage,1);
  console.log('ok native audit metadata binds original reference IDs, grouped source labels and presentation-only folios; explicit pagination diagnostics retain the gate');
 }finally{await f.close();}
}
for(const stage of ['proposal','audit']){
 const f=await makeFixture('delayed-'+stage),delay={entered:deferred(),release:deferred()};
 installNative(f,{[stage+'Delay']:delay});
 try{
  let done=false;const preparing=f.generate().then(result=>{done=true;return result;});
  await bounded(delay.entered.promise,stage+' provider did not reach delay');await assertNoHtml(f);assert.equal(done,false);assert.equal(f.service.hasActiveWork(f.root),true);
  delay.release.resolve();await bounded(preparing,stage+' gate did not finish');assert.ok(existsSync(f.html));
  console.log('ok '+stage+' native completion delay prevents HTML write');
 }finally{delay.release.resolve();await f.close();}
}
for(const mode of ['drop','duplicate','foreign','rewrite','audit-false','missing-source','missing-audit-source','missing-prepared']){
 const f=await makeFixture(mode);installNative(f);
 try{
  await assert.rejects(f.generate(),/structure preparation failed|structure plan|audit failed|unsupported|did not inspect|logical rows/);
  await assertNoHtml(f);
  const mechanical=await mechanicalPath(f.root),source=mechanical.slice(0,-'.pdf-mechanical.json'.length);
  assert.ok(existsSync(source+'.pdf-proposal-model.json'),'raw proposal model response retained for '+mode);
  if(['audit-false','missing-audit-source','missing-prepared'].includes(mode))assert.ok(existsSync(source+'.pdf-audit-model.json'),'raw audit model response retained');
  assert.equal(existsSync(source+'.pdf-layout.json'),false,'rejected structure cannot produce a formal accepted layout');
  const journal=(await readFile(path.join(f.root,'.translation-workshop','pdf','events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(journal.some(entry=>entry.event==='rejected'));
  console.log('ok '+mode+' fails full native preprocessing gate without HTML and retains precise diagnostics');
 }finally{await f.close();}
}
{
 const f=await makeFixture('cancelled'),entered=deferred(),release=deferred(),controller=new AbortController();
 installNative(f,{enteredTool:entered,releaseTool:release});
 try{
  const preparing=f.generate(controller.signal),rejected=assert.rejects(preparing,/stopped|abort|cancel/i);
  await bounded(entered.promise,'native read tool not entered');controller.abort(new DOMException('Pipeline user stopped','AbortError'));
  let settled=false;preparing.then(()=>{settled=true;},()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'real in-flight source tool owns its settlement');await assertNoHtml(f);
  release.resolve();await bounded(rejected,'cancelled pipeline did not settle');await assertNoHtml(f);assert.equal(f.service.hasActiveWork(f.root),false);
  const sessions=await f.service.listSessions(f.root);assert.equal(sessions.length,1);const entries=await nativeAudit(f,sessions[0].id);
  assert.equal(entries.filter(entry=>entry.type==='custom'&&entry.customType==='yn_pdf_structure_preparation').at(-1).data.phase,'cancelled');
  assert.equal(f.turns.length,1,'cancelled proposal cannot start audit');
  const mechanical=await mechanicalPath(f.root);assert.equal(existsSync(mechanical.replace('.pdf-mechanical.json','.pdf-layout.json')),false);
  console.log('ok cancellation waits for actual native source inspection, closes indexed Session and emits no HTML');
 }finally{release.resolve();await f.close();}
}
console.log('All pipeline scenarios used native Pi mock providers only; original PDFs remain hash-identical.');

for(const mode of ['draft-accepted','draft-cas','draft-partial','draft-unchecked','draft-stale-ack','draft-bad-version','draft-audit-false','draft-no-progress','draft-batch','draft-reason-no-progress','draft-new-attempt','draft-captured-rejection','draft-compact-malformed']){
 const f=await makeFixture(mode);installNative(f);
 try{
  if(['draft-accepted','draft-batch','draft-new-attempt'].includes(mode)){
   const generated=await f.generate(),layout=await readPdfLayout(generated.documents[0].sourcePath,f.root);
   assert.ok(existsSync(f.html));assert.deepEqual(f.turns,['proposal','audit']);assert.equal(layout.preparation.promptVersion,9);
   const entries=await nativeAudit(f,layout.preparation.sessionId),results=entries.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult');
   assert.equal(results.filter(entry=>entry.message.toolName==='revisePdfStructureDraft').length,mode==='draft-new-attempt'?4:2);
   assert.ok(results.some(entry=>entry.message.toolName==='readPdfStructureDraft'));assert.ok(results.some(entry=>entry.message.toolName==='checkPdfStructureDraft'));
   const proposal=JSON.parse(await readFile(generated.documents[0].sourcePath+'.pdf-proposal-model.json','utf8'));
   assert.deepEqual(Object.keys(JSON.parse(proposal.text)).sort(),['audit','revision','useDraft','version']);
   assert.equal(JSON.parse(proposal.text).revision,mode==='draft-batch'?1:mode==='draft-new-attempt'?3:2,'compact ack accepts checked incremental merge without enumerating whole unchanged plan');
   assert.ok(layout.blocks.some(row=>row.fragments.length===2&&row.text.includes('without losing meaning.')));
   assert.ok(f.events.filter(event=>event.event.type==='settled').every(event=>!event.htmlExisted));
   const receipt=JSON.parse(await readFile(generated.documents[0].sourcePath+'.pdf-structure.json','utf8'));assert.equal(layout.preparation.planHash,pdfStructureDigest(receipt.plan));
  }else{
   await assert.rejects(f.generate(),error=>{
    assert.match(error.message,/structure preparation failed|current successfully checked|repeated without progress/);
    if(mode==='draft-captured-rejection'){assert.match(error.message,/proposal rejected draft revision 1/);assert.match(error.message,/Source ID 144/);assert.doesNotMatch(error.message,/forbidden fields/);}
    if(mode==='draft-compact-malformed'){assert.match(error.message,/malformed compact response/);assert.doesNotMatch(error.message,/forbidden fields/);}
    return true;
   });await assertNoHtml(f);
   assert.deepEqual(f.turns,['proposal'],'rejected or unchecked compact proposal cannot start independent audit');
   const sessions=await f.service.listSessions(f.root),entries=await nativeAudit(f,sessions[0].id);
   if(['draft-cas','draft-partial','draft-no-progress','draft-reason-no-progress'].includes(mode))assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.isError),'native JSONL retains exact failed patch/check result');
   else{
    const mechanical=await mechanicalPath(f.root),proposal=JSON.parse(await readFile(mechanical.replace('.pdf-mechanical.json','.pdf-proposal-model.json'),'utf8'));
    assert.equal(JSON.parse(proposal.text).useDraft,mode==='draft-captured-rejection'?false:mode==='draft-compact-malformed'?'false':true,'compact acknowledgment or rejection remains available as model diagnostics');
   }
   if(['draft-captured-rejection','draft-compact-malformed'].includes(mode)){
    assert.deepEqual(f.stages,['structuring'],'compact rejection/malformed envelope never reaches full-plan apply or independent audit');
    const mechanical=await mechanicalPath(f.root),proposal=JSON.parse(await readFile(mechanical.replace('.pdf-mechanical.json','.pdf-proposal-model.json'),'utf8'));
    if(mode==='draft-captured-rejection')assert.deepEqual(JSON.parse(proposal.text),capturedCompactRejection,'exact actual-model rejection remains retained');
   }
   if(['draft-no-progress','draft-reason-no-progress'].includes(mode)){
    assert.equal(f.provider.state.callCount,mode==='draft-reason-no-progress'?6:5,'same structural failure stops before another model turn even when reason changes');
    assert.equal(entries.filter(entry=>entry.type==='custom'&&entry.customType==='yn_pdf_structure_preparation').at(-1).data.phase,'failed');
   }
  }
  console.log('ok '+mode+' exercises real native incremental draft tools and compact acceptance gate');
 }finally{await f.close();}
}

}
const repeatFeedbackModes=['feedback-selector-repeat','feedback-move-owner-repeat','feedback-move-target-repeat','feedback-table-repeat'];
if(['all','feedback'].includes(section))for(const mode of ['feedback-repair','feedback-noop','feedback-reason','feedback-check','feedback-table-name','feedback-merge-anchors','feedback-semantic-rejection','feedback-repeat-check','feedback-split-repair','feedback-full-plan',...repeatFeedbackModes]){
 if(process.argv.includes('--feedback-repeat-only')&&!repeatFeedbackModes.includes(mode))continue;
 const f=await makeFixture(mode);let proposalRound=0,auditRound=0,rejectedPlan,body,feedback,submittedCorrection;
 const repairModes=['feedback-repair','feedback-merge-anchors','feedback-split-repair'];
 configurePdfStructurePreparation(async request=>{
  const audit=request.tools.some(tool=>tool.name==='submitPdfStructureAudit'),index=indexFrom(request.prompt);f.turns.push(audit?'audit':'proposal');
  if(!audit){
   assert.equal(++proposalRound,1,'audit correction never launches a second full-source proposal');
   f.provider.setResponses([call('readPdfStructureSource',{fromLine:1,toLine:index.sourceCount}),context=>{
    const source=toolData(context,'readPdfStructureSource'),plan=planFrom(source.rows);body=plan.paragraphs.find(paragraph=>paragraph.physicalLines.length===2).physicalLines;
    if(['feedback-merge-anchors','feedback-split-repair'].includes(mode)){
     body=[...body,...source.rows.filter(row=>row.text.startsWith('The second owner')||row.text.startsWith('has its complete')).map(row=>row.physicalLine)];
     plan.paragraphs=plan.paragraphs.flatMap(paragraph=>paragraph.physicalLines.some(id=>body.includes(id))?
      paragraph.physicalLines.includes(body[0])?[{physicalLines:mode==='feedback-split-repair'?body:body.slice(0,2),kind:'paragraph',reason:'First full existing owner with retained tail.'}]:mode!=='feedback-split-repair'&&paragraph.physicalLines.includes(body[2])?[{physicalLines:body.slice(2),kind:'paragraph',reason:'Second full existing owner with retained tail.'}]:[]:paragraph);
    }else if(repeatFeedbackModes.includes(mode)&&mode!=='feedback-table-repeat')plan.paragraphs.find(paragraph=>paragraph.physicalLines.length===2).physicalLines=[...body].reverse();
    else plan.paragraphs=plan.paragraphs.flatMap(paragraph=>paragraph.physicalLines.length===2?body.map(id=>({physicalLines:[id],kind:'paragraph',reason:'Hard-valid source primitive requiring semantic repair.'})):paragraph);
    rejectedPlan=structuredClone(plan);return fauxAssistantMessage(fauxText(JSON.stringify(plan)));
   }]);
  }else{
   auditRound++;assert.equal(request.tools.some(tool=>tool.name==='revisePdfStructureDraft'),false);
   const owners=rejectedPlan.paragraphs.filter(paragraph=>paragraph.physicalLines.some(id=>body.includes(id))),ownerIndex=rejectedPlan.paragraphs.indexOf(owners[0]);
   const correction=second=>{
    if(mode==='feedback-repair')return {paragraphs:[{physicalLines:body,kind:'paragraph',reason:'Inspected source continuation forms a complete paragraph.'}]};
    if(mode==='feedback-merge-anchors')return {merges:[{anchors:[body[0],body[2]],kind:'paragraph',reason:'Expand both complete source owners.'}]};
    if(mode==='feedback-split-repair')return {splits:[{beforePhysicalLine:body[2],kind:'paragraph',reason:'A distinct source remark starts here.'}]};
    if(mode==='feedback-reason')return {paragraphs:owners.map(owner=>({...owner,reason:'A changed explanation cannot repair unchanged structure.'}))};
    if(['feedback-table-name','feedback-table-repeat'].includes(mode))return {tablePages:[1],tables:rejectedPlan.tables.map(table=>({...table,id:second?'Second cosmetic name':'First cosmetic name'}))};
    if(mode==='feedback-selector-repeat')return {merges:[{anchors:second?[body[1]]:[body[0],body[1],body[0]],kind:'paragraph',reason:'Select the same complete existing owner.'}]};
    if(['feedback-move-owner-repeat','feedback-move-target-repeat'].includes(mode))return {moves:[mode==='feedback-move-owner-repeat'?{physicalLine:body[second?1:0],afterPhysicalLine:rejectedPlan.paragraphs[ownerIndex-1].physicalLines[0]}:{physicalLine:rejectedPlan.paragraphs[ownerIndex+1].physicalLines[0],afterPhysicalLine:body[second?1:0]}]};
    if(mode==='feedback-semantic-rejection')return {paragraphs:[{physicalLines:[body[0],body[0]],kind:'paragraph',reason:'Duplicate source identity is invalid.'}]};
    if(mode==='feedback-full-plan')return {paragraphs:rejectedPlan.paragraphs,tables:rejectedPlan.tables};
    return {};
   };
   const negative=patch=>({version:1,checks:{...allChecks(),paragraphs:false},issues:[{physicalLines:mode==='feedback-split-repair'?body.slice(2):body,message:mode==='feedback-split-repair'?'These source IDs begin a distinct remark; split its existing owner without losing its tail.':'The source paragraph boundary requires a source-preserving correction.'}],correction:patch});
   const inspect=[context=>{assert.equal(context.messages.some(message=>message.role==='assistant'),false);return call('readPdfStructureSource',{fromLine:1,toLine:index.sourceCount});},call('readPdfPreparedStructure',{fromLine:1,toLine:index.preparedRowCount}),context=>{
    const prepared=toolData(context,'readPdfPreparedStructure');assert.equal(prepared.rows.length,prepared.total);assert.ok(prepared.rows.some(row=>row.kind==='preserved'&&row.text==='5'&&row.tableCells?.some(cell=>cell.column===1)));
    assert.match(request.systemPrompt,/confirmed unresolved defects that require a structure correction/);assert.match(request.systemPrompt,/floating figure\/table/);
    if(auditRound>1){assert.ok(repairModes.includes(mode));if(mode==='feedback-split-repair'){assert.ok(prepared.rows.some(row=>JSON.stringify(row.physicalLines)===JSON.stringify(body.slice(0,2))));assert.ok(prepared.rows.some(row=>JSON.stringify(row.physicalLines)===JSON.stringify(body.slice(2))));}else assert.ok(prepared.rows.some(row=>JSON.stringify(row.physicalLines)===JSON.stringify(body)));return call('submitPdfStructureAudit',{version:1,checks:allChecks(),issues:[]});}
    feedback=negative(correction(false));
    if(['feedback-merge-anchors','feedback-split-repair'].includes(mode))return call('submitPdfStructureAudit',negative({paragraphs:[{physicalLines:body.slice(0,3),kind:'paragraph',reason:'Captured incomplete-owner failure; tail omitted.'}]}));
    return call('submitPdfStructureAudit',feedback);
   }];
   if(auditRound===1&&['feedback-merge-anchors','feedback-split-repair'].includes(mode))inspect.push(context=>{const rejected=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/partial groups/);return call('submitPdfStructureAudit',feedback);});
   if(auditRound===1&&!repairModes.includes(mode))inspect.push(context=>{const rejected=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(rejected.isError,true,'invalid/no-op correction cannot be sealed');assert.match(rejected.content[0].text,/progress|chang|duplicate|correction|source/i);return call('submitPdfStructureAudit',negative(correction(true)));},context=>{assert.equal(context.messages.filter(message=>message.role==='toolResult').at(-1).isError,true);return fauxAssistantMessage(fauxText('No valid correction was submitted.'));});
   else inspect.push(context=>{assert.equal(toolData(context,'submitPdfStructureAudit').submitted,true);if(auditRound===1)submittedCorrection=structuredClone(feedback);assert.equal(existsSync(f.html),false);return fauxAssistantMessage(fauxText('Audit submitted. ,"issues":[]}'));});
   f.provider.setResponses(inspect);
  }
  const result=await f.service.runPdfStructurePreparation(request);assert.equal(existsSync(f.html),false);return result;
 });
 try{
  if(repairModes.includes(mode)){
   const result=await f.generate(),source=result.documents[0].sourcePath,layout=await readPdfLayout(source,f.root),receipt=JSON.parse(await readFile(source+'.pdf-structure.json','utf8'));
   assert.deepEqual(f.turns,['proposal','audit','audit']);assert.equal(proposalRound,1);assert.equal(auditRound,2);assert.ok(submittedCorrection.correction);assert.notEqual(pdfStructureDigest(receipt.plan),pdfStructureDigest(rejectedPlan));await assertSingleScopeAudit(f,source,layout,receipt,{version:1,checks:allChecks(),issues:[]});
   const entries=await nativeAudit(f,layout.preparation.sessionId);assert.equal(entries.filter(entry=>entry.type==='custom'&&entry.customType==='yn_pdf_structure_preparation'&&entry.data.phase==='completed').length,3,'both audit requests truly settle and persist');
   assert.ok(existsSync(source+'.pdf-proposal-model-round-1.json'));assert.equal(existsSync(source+'.pdf-proposal-model-round-2.json'),false,'correction does not create another full-source proposal');
  }else{
   await assert.rejects(f.generate(),error=>{assert.match(error.message,/progress|successful submitPdfStructureAudit|correction|duplicate|repeat/i);if(repeatFeedbackModes.includes(mode))assert.match(error.message,/repeated without progress/,'equivalent owner selectors/table names must reach the normalized typed stop rather than merely finish without submission');return true;});await assertNoHtml(f);assert.deepEqual(f.turns,['proposal','audit']);assert.equal(proposalRound,1);assert.equal(auditRound,1);
  }
  console.log('ok '+mode+' uses typed local correction, native settlement and structural no-progress fences');
 }finally{await f.close();}
}

// Typed-audit authority and native settlement use real PDF workers and Pi loops.
const auditCases=['audit-submit-garbage','audit-submit-empty','audit-submit-early','audit-submit-invalid-first','audit-submit-foreign-first','audit-submit-duplicate-issue','audit-submit-inconsistent-first','audit-submit-negative-missing-correction','audit-submit-positive-correction','audit-submit-positive-unsupported','audit-submit-revision-in-correction','audit-submit-missing','audit-submit-duplicate','audit-submit-conflict','audit-submit-invalid-second','audit-submit-provider-failure','audit-submit-stop','audit-submit-delayed-final','audit-submit-cleanup-failure','audit-submit-persistence-failure'];
const selectedAuditCase=process.argv.find(argument=>argument.startsWith('--audit-case='))?.slice('--audit-case='.length);
if(selectedAuditCase&&!auditCases.includes(selectedAuditCase))throw Error('Unknown typed PDF audit test case: '+selectedAuditCase);
if(['all','typed'].includes(section))for(const mode of auditCases.filter(mode=>!selectedAuditCase||selectedAuditCase===mode)){
 const f=await makeFixture(mode),controller=new AbortController(),entered=deferred(),release=deferred();let restoreClose,restoreWrite,activeOwner;
 const positive={version:1,checks:allChecks(),issues:[]},negative={version:1,checks:{...allChecks(),paragraphs:false},issues:[{physicalLines:[2,3],message:'Typed semantic issue identifies the current source paragraph.'}],unsupported:{reason:'This fixture declares its paragraph boundary unsupported.'}};
 configurePdfStructurePreparation(async request=>{
  const isAudit=request.tools.some(tool=>tool.name==='submitPdfStructureAudit'),index=indexFrom(request.prompt);f.turns.push(isAudit?'audit':'proposal');
  if(!isAudit){f.provider.setResponses([call('readPdfStructureSource',{fromLine:1,toLine:index.sourceCount}),async context=>{f.plan=planFrom(toolData(context,'readPdfStructureSource').rows);return fauxAssistantMessage(fauxText(JSON.stringify(f.plan)));}]);}
  else{
   assert.equal(request.responseMode,'structured-tool');assert.match(request.prompt,/Submit version 1,[^\n]+through submitPdfStructureAudit/);assert.match(request.prompt,/Read all \d+ records using readPdfStructureAuditScope/);assert.ok(!request.prompt.includes('Return {"version":1,"checks"'));
   if(mode==='audit-submit-stop'){
    const submit=request.tools.find(tool=>tool.name==='submitPdfStructureAudit'),execute=submit.execute;
    submit.execute=async(...args)=>{const result=await execute(...args);entered.resolve();await release.promise;return result;};
   }
   if(mode==='audit-submit-persistence-failure'){
    restoreWrite=fsp.writeFile;fsp.writeFile=async(target,...args)=>{if(String(target).includes('.pdf-audit-submission-round-1.json.'))throw Error('Injected audit-submission persistence failure');return restoreWrite(target,...args);};syncBuiltinESMExports();
   }
   const count=index.preparedRowCount;
   const inspect=[call('readPdfStructureSource',{fromLine:1,toLine:index.sourceCount}),call('readPdfPreparedStructure',{fromLine:1,toLine:count})];
   const submit=()=>call('submitPdfStructureAudit',positive),finish=async context=>{
    assert.equal(existsSync(f.html),false,'typed submission is not native settlement');
    if(mode==='audit-submit-missing')return fauxAssistantMessage(fauxText(JSON.stringify(positive)));
    assert.equal(toolData(context,'submitPdfStructureAudit').submitted,true);
    if(mode==='audit-submit-delayed-final'){entered.resolve();await release.promise;}
    if(mode==='audit-submit-cleanup-failure'){activeOwner=[...f.service.active.values()][0];restoreClose=activeOwner.session.close.bind(activeOwner.session);activeOwner.session.close=async()=>{throw Error('Injected audit native close failure');};}
    if(mode==='audit-submit-provider-failure')return fauxAssistantMessage(fauxText(''),{stopReason:'error',errorMessage:'Injected provider failure after typed audit'});
    return fauxAssistantMessage(fauxText(mode==='audit-submit-empty'?'':JSON.stringify(positive)+',"issues":[]}'));
   };
   if(mode==='audit-submit-early')f.provider.setResponses([submit(),async context=>{const result=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(result.isError,true);assert.match(result.content[0].text,/did not inspect/);return inspect[0];},inspect[1],submit(),finish]);
   else if(['audit-submit-invalid-first','audit-submit-foreign-first','audit-submit-duplicate-issue','audit-submit-inconsistent-first','audit-submit-negative-missing-correction','audit-submit-positive-correction','audit-submit-positive-unsupported','audit-submit-revision-in-correction'].includes(mode)){
    const invalid=mode==='audit-submit-negative-missing-correction'?{version:1,checks:negative.checks,issues:negative.issues}:mode==='audit-submit-positive-correction'?{...positive,correction:{}}:mode==='audit-submit-positive-unsupported'?{...positive,unsupported:{reason:'A positive audit cannot simultaneously declare an unsupported defect.'}}:mode==='audit-submit-revision-in-correction'?{version:1,checks:negative.checks,issues:negative.issues,correction:{expectedRevision:0}}:mode==='audit-submit-invalid-first'?{...positive,version:0}:mode==='audit-submit-foreign-first'?{...negative,issues:[{physicalLines:[999],message:'Foreign source claim.'}]}:mode==='audit-submit-duplicate-issue'?{...negative,issues:[{physicalLines:[2,2],message:'Duplicate identity.'}]}:{...positive,issues:negative.issues};
    f.provider.setResponses([...inspect,call('submitPdfStructureAudit',invalid),async context=>{assert.equal(context.messages.filter(message=>message.role==='toolResult').at(-1).isError,true);return submit();},finish]);
   }else if(mode==='audit-submit-duplicate')f.provider.setResponses([...inspect,submit(),async context=>{assert.equal(toolData(context,'submitPdfStructureAudit').submitted,true);return call('submitPdfStructureAudit',{issues:[],checks:{protectedContent:true,figures:true,tables:true,paragraphs:true,readingOrder:true},version:1});},async context=>{assert.equal(toolData(context,'submitPdfStructureAudit').duplicate,true);return finish(context);}]);
   else if(mode==='audit-submit-conflict')f.provider.setResponses([...inspect,
    fauxAssistantMessage([fauxToolCall('submitPdfStructureAudit',positive),fauxToolCall('submitPdfStructureAudit',negative)],{stopReason:'toolUse'}),fauxAssistantMessage(fauxText(''))]);
   else if(mode==='audit-submit-invalid-second')f.provider.setResponses([...inspect,submit(),call('submitPdfStructureAudit',{...positive,version:0}),fauxAssistantMessage(fauxText(''))]);
   else f.provider.setResponses([...inspect,...(mode==='audit-submit-missing'?[]:[submit()]),finish]);
  }
  return f.service.runPdfStructurePreparation(request);
 });
 try{
  const fails=['audit-submit-missing','audit-submit-conflict','audit-submit-invalid-second','audit-submit-provider-failure','audit-submit-stop','audit-submit-cleanup-failure','audit-submit-persistence-failure'].includes(mode);
  const generating=f.generate(controller.signal);let rejected;
  if(fails)rejected=assert.rejects(generating,/successful submitPdfStructureAudit|replace a successfully|payload was sealed|provider failure|abort|cancel|stopped|native close failure|submission persistence failed/i);
  if(mode==='audit-submit-stop'){await bounded(entered.promise,'typed audit submit did not enter');controller.abort();await assertNoHtml(f);assert.equal(f.service.hasActiveWork(f.root),true);release.resolve();}
  if(mode==='audit-submit-delayed-final'){await bounded(entered.promise,'native audit final turn did not reach delay');await assertNoHtml(f);assert.equal(f.service.hasActiveWork(f.root),true);release.resolve();}
  if(fails){await rejected;await assertNoHtml(f);if(mode==='audit-submit-cleanup-failure'){assert.equal(f.service.hasActiveWork(f.root),true);activeOwner.session.close=restoreClose;await f.service.disposeWorkspace(f.root);restoreClose=undefined;}}
  else{
   const generated=await generating,source=generated.documents[0].sourcePath,layout=await readPdfLayout(source,f.root),receipt=JSON.parse(await readFile(source+'.pdf-structure.json','utf8'));
   assert.equal(layout.preparation.promptVersion,9);await assertSingleScopeAudit(f,source,layout,receipt,positive);
   const record=JSON.parse(await readFile(source+'.pdf-audit-model-round-1.json','utf8')),submission=JSON.parse(await readFile(source+'.pdf-audit-submission-round-1.json','utf8'));
   assert.deepEqual(record.submittedAudit,positive);assert.equal(record.submittedAuditHash,pdfStructureDigest(positive));assert.deepEqual(submission.audit,positive);assert.equal(submission.payloadHash,record.submittedAuditHash);
   if(mode==='audit-submit-empty')assert.equal(record.text,'');else assert.throws(()=>JSON.parse(record.text),'malformed ordinary text cannot override typed audit payload');
   assert.ok(existsSync(f.html));
  }
  assert.deepEqual(f.turns,['proposal','audit']);console.log('ok '+mode+' uses authoritative typed audit submission and real native completion/failure fences');
 }finally{release.resolve();if(restoreWrite){fsp.writeFile=restoreWrite;syncBuiltinESMExports();}if(restoreClose)activeOwner.session.close=restoreClose;await f.close();}
}
