import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../src/main/agent/piNative/sessionService.ts';
import {PiSessionRepository} from '../src/main/agent/piNative/sessionRepository.ts';
import {readSessionEntries,getOpenDiskSession} from '../src/main/agent/piNative/sessionAccess.ts';
import {configurePdfStructurePreparation,withPdfPreparationContext,pdfStructureDigest} from '../src/main/pdfStructurePreparation.ts';
import {readPdfLayout,preflightPdfRequest} from '../src/main/pdfDocuments.ts';
import {pdfProtectionHash} from '../src/main/pdfTypes.ts';
import {pdfAuditGlobalPreparedHash,auditOwnerKey} from '../src/main/pdfAuditPackets.ts';
import {generateBuiltinTaskReview} from '../src/main/builtinTaskDocuments.ts';
import {builtinTaskDefaults} from '../src/shared/builtinTasks.ts';

const checks=()=>({readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true});
const positive=()=>({version:1,checks:checks(),issues:[]});
const digest=value=>createHash('sha256').update(value).digest('hex');
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const final=text=>fauxAssistantMessage(fauxText(text));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const toolData=(context,name)=>JSON.parse(context.messages.filter(message=>message.role==='toolResult'&&message.toolName===name).at(-1).content.find(block=>block.type==='text').text);
const indexFrom=request=>JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('Index: ')+7));
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),20000);})]);}finally{clearTimeout(timer);}}
async function files(root){const result=[];for(const entry of await readdir(root,{withFileTypes:true})){const name=path.join(root,entry.name);result.push(...entry.isDirectory()?await files(name):[name]);}return result;}
async function noHtml(f){assert.equal(existsSync(f.html),false);assert.equal((await files(f.root)).some(file=>/\.pdf-layout\.json$/.test(file)),false);}
async function fixture(mode){
 const root=await mkdtemp(path.join(os.tmpdir(),'yn-scoped-native-'+mode+'-')),original=path.join(root,'source.pdf');
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.TimesRoman);
 for(let number=1;number<=8;number++){
  const page=pdf.addPage([595.276,841.89]);
  for(let row=0;row<30;row++)page.drawText(number===8&&row===0?'Detailed methods':`Independent observation ${number*30+row} ends here.`,{x:40,y:780-row*23,size:number===8&&row===0?16:11,font});
  page.drawText(String(number),{x:290,y:22,size:10,font});
 }
 const bytes=Buffer.from(await pdf.save());await writeFile(original,bytes);
 const provider=fauxProvider({provider:'scoped-native-'+mode,tokensPerSecond:100000,models:[{id:'fixture',reasoning:false,contextWindow:64000,maxTokens:4096}]}),models=createModels();models.setProvider(provider.provider);
 const service=new PiNativeSessionService({createTools:()=>{throw Error('Scoped preparation cannot use ordinary domain tools');},createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})});
 const settings=builtinTaskDefaults({outputDir:root,sourcePath:original,sourceKind:'file',fileType:'pdf',inputMode:'separate',locale:'en-US',glossaryCandidates:false,characterBible:false});
 const html=path.join(root,'.translation-workshop','html','builtin-scoped.html'),f={root,original,originalHash:digest(bytes),provider,service,html,requests:[],packets:[],events:[],stages:[],proposalRound:0,controller:new AbortController(),entered:deferred(),release:deferred()};
 service.subscribeEvents(event=>f.events.push({event,htmlExisted:existsSync(html)}));
 f.generate=()=>withPdfPreparationContext({signal:f.controller.signal,onStage:(stage,details)=>f.stages.push({stage,...details})},()=>generateBuiltinTaskReview(settings,'translation','scoped',f.controller.signal));
 f.close=async()=>{f.release.resolve();await service.disposeWorkspace(root);assert.equal(digest(await readFile(original)),f.originalHash);await rm(root,{recursive:true,force:true});};
 configurePdfStructurePreparation(async request=>{
  const audit=request.tools.some(tool=>tool.name==='submitPdfStructureAudit');
  f.requests.push({audit,index:audit?indexFrom(request):undefined});
  if(!audit){
   f.proposalRound++;
   const marker='Document index: ',index=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf(marker)+marker.length));
   const responses=[call('readPdfStructureSource',{fromLine:1,toLine:index.sourceCount}),
    context=>{const rows=toolData(context,'readPdfStructureSource').rows;assert.equal(rows.length,index.sourceCount);f.target=rows.find(row=>row.text==='Detailed methods').physicalLine;return call('readPdfStructureDraft',{fromParagraph:1,toParagraph:Number(request.prompt.match(/draft \((\d+) paragraphs/)[1])});},
    context=>{const draft=toolData(context,'readPdfStructureDraft');f.revision=draft.revision;f.initialDraft=structuredClone(draft);
     assert.equal(f.proposalRound,1,'local audit corrections must not restart a full-source proposal');return call('checkPdfStructureDraft',{});},
    context=>{assert.equal(toolData(context,'checkPdfStructureDraft').valid,true);return final(JSON.stringify({version:1,useDraft:true,revision:f.revision,audit:{...checks(),issues:[]}}));}];
   f.provider.setResponses(responses);
  }else{
   const index=indexFrom(request),isOrder=index.kind==='order';assert.ok(index.recordCount>0);assert.ok(index.scopeId);
   const workerInvalid=['worker-invalid-correction','worker-invalid-correction-repeat'].includes(mode)&&!isOrder&&!f.workerRejected;
   const orderedCorrection=['ordered-correction','ordered-correction-invalid-later'].includes(mode)&&!isOrder&&!f.orderedSubmissionFinished;
   f.packets.push({id:index.scopeId,kind:index.kind,afterCorrection:f.repairSent===true,core:index.coreSourceCount,records:index.recordCount});
   const seenRecords=[];
   const freshRead=args=>context=>{assert.equal(context.messages.some(message=>message.role==='assistant'),false,'each packet begins in a fresh native context');return call('readPdfStructureAuditScope',args);};
   const receive=context=>{const value=toolData(context,'readPdfStructureAuditScope');assert.equal(value.scopeId,index.scopeId);assert.equal(value.recordNumberSpace,'packet');seenRecords.push(...value.rows);f.packet=value;return value;};
   const submit=context=>{
    if(context.messages.filter(message=>message.role==='toolResult').at(-1).toolName==='readPdfStructureAuditScope')receive(context);
    if(isOrder){assert.ok(seenRecords.every(row=>row.record==='order'));assert.equal(f.packet.corePhysicalLines.length,0);}
    else{assert.ok(seenRecords.some(row=>row.record==='source'));const prepared=seenRecords.filter(row=>row.record==='prepared');assert.ok(prepared.length);assert.ok(prepared.every(row=>row.ownerAnchor===row.physicalLines[0]&&!Object.hasOwn(row,'ownerKey')&&!Object.hasOwn(row,'logicalLine')));}
    if(orderedCorrection){
     const owners=seenRecords.filter(row=>row.record==='prepared'&&row.kind==='paragraph'&&!row.protection&&row.physicalLines.every(id=>f.packet.corePhysicalLines.includes(id))).slice(0,2);assert.equal(owners.length,2);
     f.orderedOwners=owners.map(owner=>({physicalLines:owner.physicalLines,kind:owner.kind}));
     f.currentSubmission={version:1,checks:{...checks(),paragraphs:false},issues:[{physicalLines:owners[1].physicalLines,message:'The suffix owner requires its own heading role after the explicit sequential source-owner repair.'}],correction:{steps:[
      {merges:[{anchors:owners.map(owner=>owner.ownerAnchor),kind:owners[0].kind,reason:'Create the complete combined owner for the following split.'}]},
      {splits:[{beforePhysicalLine:mode==='ordered-correction-invalid-later'?999999:owners[1].ownerAnchor,kind:'heading',reason:'Assign the suffix role while retaining the prefix role.'}]}
     ]}};return call('submitPdfStructureAudit',f.currentSubmission);
    }
    if(workerInvalid){
     const owner=seenRecords.find(row=>row.record==='prepared'&&row.kind==='paragraph'&&!row.protection&&row.physicalLines.some(id=>f.packet.corePhysicalLines.includes(id)));assert.ok(owner,'worker-invalid fixture must select a complete writable current source owner');
     f.invalidWorkerSubmission={version:1,checks:{...checks(),paragraphs:false},issues:[{physicalLines:owner.physicalLines,message:'Fixture deliberately attempts to freeze writable source prose.'}],correction:{paragraphs:[{physicalLines:owner.physicalLines,kind:'preserved',reason:'Worker must reject this otherwise source-conserving role change.'}]}};
     return call('submitPdfStructureAudit',f.invalidWorkerSubmission);
    }
    const negative=['repair-reuse','extra-read-invalidation'].includes(mode)&&!f.repairSent&&!isOrder&&f.packet.corePhysicalLines.includes(f.target)
     ||['negative-unchanged','unsupported'].includes(mode)&&!isOrder&&f.packet.corePhysicalLines.includes(1);
    const audit=negative?{version:1,checks:{...checks(),paragraphs:false},issues:[{physicalLines:[['negative-unchanged','unsupported'].includes(mode)?1:f.target],message:'This exact source owner has the explicit unresolved fixture structure defect.'}],...(mode==='unsupported'?{unsupported:{reason:'The fixture source defect cannot be represented by a source-only structure correction.'}}:{correction:mode==='negative-unchanged'?{}:{paragraphs:[{physicalLines:[f.target],kind:'heading',reason:'The source large-font title identifies this complete heading owner.'}]}})}:positive();
    f.currentSubmission=audit;
    return call('submitPdfStructureAudit',audit);
   };
   const responses=[];
   if(mode==='context-not-core'&&!isOrder&&f.packets.filter(packet=>packet.kind==='local').length===2){
    responses.push(freshRead({fromRecord:1,toRecord:1}),context=>{
     const value=receive(context);assert.ok(value.rows[0].physicalLine<Math.min(...value.corePhysicalLines),'first record is boundary context, not assigned core');
     f.skippedCore=Math.min(...value.corePhysicalLines);return call('readPdfStructureAuditScope',{fromRecord:3,toRecord:index.recordCount});
    },submit,context=>{const result=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(result.toolName,'submitPdfStructureAudit');assert.equal(result.isError,true);assert.match(result.content[0].text,new RegExp('missing IDs: '+f.skippedCore));return final('No successful typed scope submission; context did not discharge core responsibility.');});
   }else{
    for(let fromRecord=1;fromRecord<=index.recordCount;fromRecord+=500)responses.push(fromRecord===1?freshRead({fromRecord,toRecord:Math.min(index.recordCount,fromRecord+499)}):context=>{receive(context);return call('readPdfStructureAuditScope',{fromRecord,toRecord:Math.min(index.recordCount,fromRecord+499)});});
    if(mode==='extra-read-invalidation'&&!isOrder&&f.packets.find(packet=>packet.kind==='local').id===index.scopeId)responses.push(context=>{
     receive(context);return call('readPdfPreparedStructure',{fromLine:1,toLine:1});
    },context=>{const first=toolData(context,'readPdfPreparedStructure');return call('readPdfPreparedStructure',{fromLine:first.total,toLine:first.total});
    },context=>{const extra=toolData(context,'readPdfPreparedStructure');assert.ok(extra.rows.every(row=>row.physicalLines.every(id=>!f.packet.corePhysicalLines.includes(id))));return submit(context);});
    else responses.push(submit);
    if(orderedCorrection&&mode==='ordered-correction-invalid-later')responses.push(context=>{
     const failed=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(failed.toolName,'submitPdfStructureAudit');assert.equal(failed.isError,true);assert.match(failed.content[0].text,/split.*(?:999999|foreign|source)|(?:foreign|unknown).*999999/i);assert.equal(existsSync(html),false);
     f.orderedSubmissionFinished=true;f.currentSubmission=positive();return call('submitPdfStructureAudit',f.currentSubmission);
    });
    if(workerInvalid)responses.push(context=>{
     const failed=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(failed.toolName,'submitPdfStructureAudit');assert.equal(failed.isError,true,'real apply-plan worker rejection remains a correctable native tool result');assert.match(failed.content[0].text,/PDF structure plan: preserved paragraph claims writable prose IDs/);assert.equal(existsSync(html),false);
     f.workerRejected=true;f.currentSubmission=mode==='worker-invalid-correction-repeat'?f.invalidWorkerSubmission:positive();return call('submitPdfStructureAudit',f.currentSubmission);
    });
    responses.push(async context=>{
     if(mode==='worker-invalid-correction-repeat'){assert.equal(context.messages.filter(message=>message.role==='toolResult').at(-1).isError,true);return final('Repeated worker-invalid correction was not submitted.');}
     if(mode==='negative-unchanged'){
      const failed=context.messages.filter(message=>message.role==='toolResult').at(-1);assert.equal(failed.isError,true,'no-op correction cannot seal a negative audit');assert.match(failed.content[0].text,/progress|chang|no.op|correction/i);return call('submitPdfStructureAudit',f.currentSubmission);
     }
     assert.equal(toolData(context,'submitPdfStructureAudit').submitted,true);
     if(orderedCorrection)f.orderedSubmissionFinished=true;
     if(f.currentSubmission.correction)f.repairSent=true;
     if(isOrder&&['delayed-final','stop-after-submit'].includes(mode)){f.entered.resolve();await f.release.promise;}
     return final('');
    });
    if(mode==='negative-unchanged')responses.push(context=>{assert.equal(context.messages.filter(message=>message.role==='toolResult').at(-1).isError,true);return final('The typed no-op correction was rejected; no correction has been sealed.');});
   }
   f.provider.setResponses(responses);
  }
  const result=await service.runPdfStructurePreparation(request);assert.equal(existsSync(html),false,'each actual native request must settle before HTML');return result;
 });
 return f;
}

async function nativeEvidence(f,source){
 const layout=await readPdfLayout(source,f.root),repo=new PiSessionRepository(f.root),metadata=await repo.findMetadata(layout.preparation.sessionId);
 assert.equal(getOpenDiskSession(metadata.path),undefined);const session=await repo.open(layout.preparation.sessionId);let entries;try{entries=await readSessionEntries(session);}finally{await repo.close();}
 const index=JSON.parse(await readFile(metadata.path+'.yn-index.json','utf8')).index;
 assert.equal(index.committedBytes,(await stat(metadata.path)).size,'all scope JSONL must be durable');
 assert.equal(entries.filter(entry=>entry.type==='custom'&&entry.customType==='yn_pdf_structure_preparation'&&entry.data.phase==='completed').length,f.requests.length);
 assert.equal(f.events.filter(event=>event.event.event?.type==='settled').some(event=>event.htmlExisted),false);
 return layout;
}

const scenario=process.argv.find(argument=>argument.startsWith('--scenario='))?.slice('--scenario='.length);
const scenarios=['repair-reuse','negative-unchanged','context-not-core','delayed-final','stop-after-submit','extra-read-invalidation','unsupported','worker-invalid-correction','worker-invalid-correction-repeat','ordered-correction','ordered-correction-invalid-later'];
if(scenario&&!scenarios.includes(scenario))throw Error('Unknown scoped native fixture scenario: '+scenario);
for(const mode of scenarios.filter(mode=>!scenario||mode===scenario)){
 const f=await fixture(mode);
 try{
  const fails=['negative-unchanged','context-not-core','stop-after-submit','unsupported','worker-invalid-correction-repeat'].includes(mode),generation=f.generate();let rejected;
  if(fails)rejected=assert.rejects(generation,error=>{assert.match(error.message,/rejected draft|successful submitPdfStructureAudit|unsupported|progress|correction|abort|cancel|stopped/i);if(mode==='worker-invalid-correction-repeat')assert.match(error.message,/repeated without progress: PDF structure plan: preserved paragraph claims writable prose IDs/);return true;});
  if(['delayed-final','stop-after-submit'].includes(mode)){
   await bounded(f.entered.promise,'last real native scope did not reach post-submit final turn');await noHtml(f);assert.equal(f.service.hasActiveWork(f.root),true);
   if(mode==='stop-after-submit')f.controller.abort(new DOMException('Stop current audit scope','AbortError'));
   let settled=false;generation.then(()=>{settled=true;},()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'typed submit alone does not complete the native request');f.release.resolve();
  }
  if(fails){await bounded(rejected,'negative scoped preparation did not settle');await noHtml(f);
   if(mode==='negative-unchanged'){assert.equal(f.packets.length,1,'invalid no-op correction cannot start another audit or be positive-cached');assert.equal(f.proposalRound,1);}
   if(mode==='unsupported'){assert.equal(f.packets.length,1);assert.equal(f.proposalRound,1);assert.equal(f.requests.length,2,'settled unsupported submission stops without another proposal or audit');}
   if(mode==='worker-invalid-correction-repeat'){assert.ok(f.workerRejected);assert.equal(f.packets.length,1);assert.equal(f.proposalRound,1);}
  }else{
   const result=await bounded(generation,'scoped preparation did not finish'),source=result.documents[0].sourcePath,layout=await nativeEvidence(f,source),receipt=JSON.parse(await readFile(source+'.pdf-structure.json','utf8'));
   assert.ok(existsSync(f.html));assert.equal(layout.preparation.promptVersion,9);assert.equal(f.proposalRound,1);assert.ok(layout.preparation.auditScopeCount>=3);
   assert.equal(layout.preparation.auditScopeCount,receipt.audit.scopeEvidence.length);assert.equal(layout.preparation.auditScopesHash,pdfStructureDigest(receipt.audit.scopeEvidence));assert.equal(layout.preparation.auditHash,pdfStructureDigest(receipt.audit));
   const cores=receipt.audit.scopeEvidence.flatMap(evidence=>evidence.corePhysicalLines);assert.deepEqual(cores.slice().sort((a,b)=>a-b),layout.physicalBlocks.map(row=>row.line));assert.equal(new Set(cores).size,cores.length);
   const global=receipt.audit.scopeEvidence.find(evidence=>evidence.scopeId==='global-order');assert.ok(global);assert.equal(global.corePhysicalLines.length,0);assert.equal(global.audit.issues.length,0);
   assert.ok(receipt.audit.scopeEvidence.every(evidence=>evidence.inspectedRecordIndices.length&&evidence.audit.issues.length===0&&Object.values(evidence.audit.checks).every(Boolean)));
   assert.equal(layout.preparation.sourceInspectionCoverage,1);assert.equal(layout.preparation.auditInspectionCoverage,1);assert.equal(layout.preparation.metrics.coverage,1);assert.equal(layout.preparation.metrics.duplicates,0);
   if(mode==='worker-invalid-correction'){assert.ok(f.workerRejected);assert.ok(receipt.audit.scopeEvidence.every(evidence=>!evidence.audit.correction),'rejected worker candidate never becomes accepted authority');}
   if(['ordered-correction','ordered-correction-invalid-later'].includes(mode)){
    assert.ok(f.orderedSubmissionFinished);const owners=receipt.plan.paragraphs.filter(owner=>owner.physicalLines.some(id=>f.orderedOwners.some(original=>original.physicalLines.includes(id))));
    assert.deepEqual(owners.map(owner=>owner.physicalLines),f.orderedOwners.map(owner=>owner.physicalLines),'both sequential steps preserve the complete source owner union');
    if(mode==='ordered-correction'){
     assert.equal(owners[0].kind,f.orderedOwners[0].kind,'split retains the prefix role');assert.equal(owners[1].kind,'heading','split kind belongs to the suffix');
     const first=f.packets.find(packet=>packet.kind==='local');assert.equal(f.packets.filter(packet=>packet.id===first.id).length,2,'applied ordered correction requires a genuinely fresh positive native audit');
     const sourcePrefix=source;const revision=JSON.parse(await readFile(sourcePrefix+'.pdf-audit-correction-round-1.json','utf8'));assert.equal(revision.toRevision-revision.fromRevision,2,'Host supplies each private step revision sequentially');
    }else{
     assert.deepEqual(receipt.plan.paragraphs.map(({physicalLines,kind})=>({physicalLines,kind})),f.initialDraft.paragraphs.map(({physicalLines,kind})=>({physicalLines,kind})),'a later-step error rolls back the private merge snapshot in full');
     assert.equal(existsSync(source+'.pdf-audit-correction-round-1.json'),false);assert.equal(f.packets.filter(packet=>packet.id===f.packets[0].id).length,1,'failed sequence creates no changed-plan re-audit');
    }
   }
   if(mode==='extra-read-invalidation'){
    const first=f.packets.find(packet=>packet.kind==='local'),proof=receipt.audit.scopeEvidence.find(scope=>scope.scopeId===first.id);
    assert.equal(f.packets.filter(packet=>packet.id===first.id).length,2,'optional extra prepared investigation is allowed and invalidates cached proof when the complete prepared dependency changes');
    assert.deepEqual(proof.extraPreparedOwnerKeys,[auditOwnerKey(layout.blocks.at(-1))]);assert.equal(proof.globalPreparedHash,pdfAuditGlobalPreparedHash(layout));
    const before=f.provider.state.callCount;await f.generate();assert.equal(f.provider.state.callCount,before,'accepted exact additional dependencies reuse zero model turns');
   }
   if(mode==='repair-reuse'){
    const first=f.packets.find(packet=>packet.kind==='local');assert.equal(f.packets.filter(packet=>packet.id===first.id).length,1,'an unchanged positive packet requires no new native request after local repair');
    assert.ok(f.stages.some(stage=>stage.stage==='auditing'&&stage.reused===true));assert.equal(f.packets.filter(packet=>packet.kind==='order').length,1,'first valid local correction restarts packets before an obsolete global audit runs');assert.ok(f.repairSent);
    const before=f.provider.state.callCount,requests=f.requests.length;await f.generate();assert.equal(f.provider.state.callCount,before);assert.equal(f.requests.length,requests,'warm accepted binding has zero new native requests');
    const layoutFile=source+'.pdf-layout.json',receiptFile=source+'.pdf-structure.json',layoutBytes=await readFile(layoutFile),receiptBytes=await readFile(receiptFile);
    for(const [name,mutate] of [
     ['missing-scope-count',(layout)=>{delete layout.preparation.auditScopeCount;}],['missing-scope-hash',(layout)=>{delete layout.preparation.auditScopesHash;}],
     ['wrong-scope-count',(layout)=>{layout.preparation.auditScopeCount++;}],
     ['missing-current-core',(_layout,receipt)=>{receipt.audit.scopeEvidence[0].corePhysicalLines.pop();}],
     ['missing-current-record',(_layout,receipt)=>{receipt.audit.scopeEvidence[0].inspectedRecordIndices.pop();}],
     ['wrong-packet-hash',(_layout,receipt)=>{receipt.audit.scopeEvidence[0].packetHash='0'.repeat(64);}],
     ['missing-global-relation',(_layout,receipt)=>{receipt.audit.scopeEvidence.find(item=>item.scopeId==='global-order').relationKeys.pop();}],
     ['negative-scope-under-positive-aggregate',(_layout,receipt)=>{receipt.audit.scopeEvidence[0].audit.checks.paragraphs=false;receipt.audit.scopeEvidence[0].audit.issues=[{physicalLines:[1],message:'Retained negative scope cannot be hidden by aggregate flags.'}];}]
    ]){
     const editedLayout=JSON.parse(layoutBytes),editedReceipt=JSON.parse(receiptBytes);mutate(editedLayout,editedReceipt);
     if(!name.startsWith('missing-scope-')&&name!=='wrong-scope-count'){editedLayout.preparation.auditScopesHash=pdfStructureDigest(editedReceipt.audit.scopeEvidence);editedLayout.preparation.auditHash=pdfStructureDigest(editedReceipt.audit);}
     editedLayout.protectionHash=pdfProtectionHash(editedLayout);await writeFile(layoutFile,JSON.stringify(editedLayout));await writeFile(receiptFile,JSON.stringify(editedReceipt));
     await assert.rejects(readPdfLayout(source,f.root),/audit|acceptance|evidence|binding|scop/i,name);await assert.rejects(preflightPdfRequest({outputDir:f.root,sourcePath:source}),/audit|acceptance|evidence|binding|scop/i,name+' Host preflight');
     await writeFile(layoutFile,layoutBytes);await writeFile(receiptFile,receiptBytes);await readPdfLayout(source,f.root);
    }
   }
  }
  assert.equal(f.service.hasActiveWork(f.root),false);console.log('ok scoped-native '+mode+' uses real PDF/native tools and strict current packet evidence');
 }finally{await f.close();}
}
console.log('Scoped native PDF regressions use mock providers only; original PDFs remain hash-identical.');
