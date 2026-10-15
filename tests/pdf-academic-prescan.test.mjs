import assert from 'node:assert/strict';
import {scanPdfPreservedSpans} from '../src/shared/validation/pdfAcademicPrescan.ts';
import {validateTranslationCandidate,createTranslationResiduePayloadReader} from '../src/shared/validation/translationValidator.ts';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts,beginMarkedContent,endMarkedContent} from 'pdf-lib';
import {readPdfPreservedSpans,pdfReferencesForRange} from '../src/main/pdfDocuments.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {createYnTranslationValidationOptions} from '../src/main/agent/piNative/translationValidationContext.ts';
import {createPiTranslationSubagentWorker,createPiTranslationReviewSubagentWorker} from '../src/main/agent/piNative/subagentRunner.ts';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {executeArtifactOperation} from '../src/main/agent/artifactValidationWorkerTasks.ts';
import {createYnDomainTools} from '../src/main/agent/piNative/ynDomainTools.ts';
import {createYnDomainRunContract} from '../src/main/agent/piNative/domainRunContract.ts';
import {createTranslationAlignmentHostState} from '../src/main/agent/piNative/translationAlignmentState.ts';
import {PiSessionRepository} from '../src/main/agent/piNative/sessionRepository.ts';
import {prepareTranslationStagingCandidate,resolveTranslationCandidatePath} from '../src/main/agent/writeTranslationChunk.ts';

const texts=[
  'The workshop runs the R package cedarKit beside the parcelView library.',
  'Sorting lane score (SLS) and parcel-weighted sorting lane score (PW-SLS) describe the conveyor.',
  'cedarKit', 'parcelView', '(c) PW-SLS', '(iv)',
  'The package contains spare label templates.',
  'cedarKit prints one label for every crate.',
  'R package version 4.2.6.',
  'package tagforge. Workshop Tools Quarterly.',
  'https://example.org/crates and doi:10.1000/toy456'
];
const blocks=texts.map((text,index)=>({line:index+1,page:1,text}));
const spans=scanPdfPreservedSpans(blocks);
const options={languagePair:'en->zh-CN',pdfPreservedSpans:spans};
assert.ok(spans.some(s=>s.text==='cedarKit'&&s.line===3));
assert.ok(spans.some(s=>s.text==='PW-SLS'&&s.line===5));
assert.ok(spans.some(s=>s.text==='(iv)'&&s.line===6));
assert.ok(!spans.some(s=>s.text==='contains'||s.text==='version'));
const candidate=[
  '车间运行 R 包 cedarKit 和 parcelView 库。',
  '分拣道评分（SLS）与包裹加权分拣道评分（PW-SLS）用于描述传送带。',
  'cedarKit','parcelView','(c) PW-SLS','(iv)',
  '该包包含备用标签模板。',
  'cedarKit 为每个箱子打印一张标签。',
  'R 软件包版本 4.2.6。',
  'tagforge 包。《车间工具季刊》。',
  'https://example.org/crates 和 doi:10.1000/toy456'
];
const result=validateTranslationCandidate(texts.join('\n'),candidate.join('\n'),options);
assert.equal(result.blocking.length,0,JSON.stringify(result.blocking));
assert.equal(result.warnings.filter(f=>f.code==='likely_untranslated').length,0,JSON.stringify(result.warnings));
const copied=[...candidate];copied[7]=texts[7];
assert.ok(validateTranslationCandidate(texts.join('\n'),copied.join('\n'),options).blocking.some(f=>f.line===8&&f.code==='likely_untranslated'),'preserving a package never exempts its prose');
assert.ok(validateTranslationCandidate('cedarKit','cedarKit',{languagePair:'en->zh-CN'}).blocking.some(f=>f.code==='likely_untranslated'),'TXT keeps its existing checks');
assert.equal(createTranslationResiduePayloadReader({...options,pdfPreservedSpans:spans.filter(s=>s.line===3).map(s=>({...s,line:1}))})('cedarKit','cedarkit').source.trim(),'cedarKit','changed identifier case is not excluded from prose checks');
assert.throws(()=>validateTranslationCandidate('different',candidate[2],{...options,pdfPreservedSpans:spans.filter(s=>s.line===3).map(s=>({...s,line:1}))}),/PDF.*prescan|PDF.*preserv/i,'stale scan cannot exempt another source');
const formal={...options,glossaryEntries:[{source:'cedarKit',target:'另一个明确译名'}]};
assert.ok(validateTranslationCandidate(texts.join('\n'),candidate.join('\n'),formal).warnings.some(f=>f.code==='glossary_missing'),'explicit glossary remains authoritative');
const table=scanPdfPreservedSpans([
  {line:1,page:1,text:'The depot defines three-letter labels'},
  {line:2,page:1,text:'for its crate racks: pax, vek, nor, fuz, and qin.'},
  {line:3,page:2,text:'nor',y:120},
  {line:4,page:2,text:'0.625',y:120},
  {line:5,page:2,text:'0.875',y:120},
  {line:6,page:2,text:'nor does the courier move an empty crate.',y:140}
]);
assert.ok(table.some(s=>s.line===3&&s.text==='nor'));
assert.ok(!table.some(s=>s.line===6),'a letter-code label must never exempt its spelling in ordinary prose');
console.log('ok PDF source prescan exempts evidenced identifiers and labels while retaining prose and glossary checks');

const datasetSource=[
  'The depot records the LUMOCRATE parcel dataset.',
  'Clustering comparisons on CEDAR Parcel Routes (Venn, 2044).',
  'CEDAR Parcel Routes records the morning deliveries.'
];
const datasetSpans=scanPdfPreservedSpans(datasetSource.map((text,index)=>({line:index+1,page:1,text})));
assert.ok(datasetSpans.some(span=>span.text==='LUMOCRATE'&&span.line===1),'explicit dataset declarations qualify names');
assert.ok(datasetSpans.some(span=>span.text==='CEDAR Parcel Routes'&&span.line===3),'declared corpus names propagate to actual occurrences');
assert.equal(validateTranslationCandidate(datasetSource.join('\n'),[
  '仓库记录 LUMOCRATE 包裹数据集。',
  '对 CEDAR Parcel Routes 进行聚类比较（Venn，2044）。',
  'CEDAR Parcel Routes 记录早间配送。'
].join('\n'),{languagePair:'en->zh-CN',pdfPreservedSpans:datasetSpans}).warnings.some(f=>f.code==='likely_untranslated'),false);
assert.ok(validateTranslationCandidate(datasetSource.join('\n'),datasetSource.join('\n'),{languagePair:'en->zh-CN',pdfPreservedSpans:datasetSpans})
  .blocking.some(f=>f.code==='likely_untranslated'),'declared datasets never exempt surrounding copied prose');
for(const word of ['THIS','THE','OUR','THESE','OTHER','NEW','ITS']) {
  const text=word+' dataset contains standard samples.';
  const rejectedNames=scanPdfPreservedSpans([{line:1,page:1,text},{line:2,page:1,text:word}]);
  assert.ok(!rejectedNames.some(span=>span.text===word),'ordinary uppercase determiners are not dataset declarations: '+word);
  assert.ok(validateTranslationCandidate(word,word,{languagePair:'en->zh-CN',pdfPreservedSpans:rejectedNames,lineOffset:1})
    .blocking.some(f=>f.code==='likely_untranslated'),'ordinary body words remain checked outside a dataset clause');
}
const occurrenceSource='Spectrum is the model name. Spectrum estimates curves.';
const occurrenceSpan={line:1,start:0,end:8,text:'Spectrum',kind:'software',evidenceLine:1};
const occurrenceRead=createTranslationResiduePayloadReader({pdfPreservedSpans:[occurrenceSpan]});
assert.ok(occurrenceRead(occurrenceSource,'Spectrum 是模型名。Spectrum estimates curves.').source.includes('Spectrum estimates curves'),
  'only the evidenced source occurrence may be removed; equal spellings elsewhere remain prose');
assert.equal(occurrenceRead('Spectrum is the model name.','Spectrum 是模型名。').source.trim(),'is the model name.');
const acronymSource=[texts[1],'SLS PW-SLS'];
const acronymSpans=scanPdfPreservedSpans(acronymSource.map((text,index)=>({line:index+1,page:1,text})));
const acronymReader=createTranslationResiduePayloadReader({pdfPreservedSpans:acronymSpans});
for(const candidate of ['SLS PW-SLS','PW-SLS SLS']) {
  assert.equal(acronymReader(acronymSource[1],candidate,2).source.trim(),'','longer compound names allocate candidate occurrences first');
  assert.equal(validateTranslationCandidate(acronymSource[1],candidate,{languagePair:'en->zh-CN',pdfPreservedSpans:acronymSpans,lineOffset:1})
    .blocking.some(f=>f.code==='likely_untranslated'),false);
}
assert.equal(acronymReader(acronymSource[1],'SLS SLS PW-SLS',2).source.trim(),'SLS','extra copies cannot manufacture a preservation exemption');
const contextSpan={line:1,start:0,end:8,text:'cedarKit',kind:'software',evidenceLine:1};
for(const pattern of ['(?<=cedarKit )HELLO','^cedarKit HELLO']) {
  const protectedContext={languagePair:'en->zh-CN',pdfPreservedSpans:[contextSpan],customPreserveRules:[{pattern,flags:'u'}]};
  assert.equal(validateTranslationCandidate('cedarKit HELLO','cedarKit HELLO',protectedContext).blocking.length,0,
    'regex context is evaluated on original text before PDF exclusions: '+pattern);
  const extra=validateTranslationCandidate('cedarKit HELLO; HELLO','cedarKit HELLO; HELLO',protectedContext);
  assert.ok(extra.blocking.some(f=>f.code==='likely_untranslated'),'equal spelling outside the actual regex match remains prose');
}
const markerNames=['We use the R package formula and the R package cedarKit.','cedarKit {{formula:p1:1}}'];
const markerNameSpans=scanPdfPreservedSpans(markerNames.map((text,index)=>({line:index+1,page:1,text})));
assert.equal(validateTranslationCandidate(markerNames[1],markerNames[1],{languagePair:'en->zh-CN',pdfPreservedSpans:markerNameSpans,lineOffset:1})
  .blocking.length,0,'software-name spans inside a Host marker cannot damage that marker before exclusion');
const placeholderSpan={line:1,start:1,end:9,text:'cedarKit',kind:'software',evidenceLine:1};
assert.equal(validateTranslationCandidate('{cedarKit}','{cedarKit}',{languagePair:'en->zh-CN',pdfPreservedSpans:[placeholderSpan]})
  .blocking.length,0,'placeholder positions are combined with overlapping PDF spans on original text');

const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-academic-'));
let repository,worker,reviewer;
try {
  const original=path.join(root,'academic.pdf'),pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  const source=[texts[0],'u = v','cedarKit',texts[7],'(iv)','PW-SLS',texts[1],'A courier carries the tagged crate upstairs.'];
  const translated=[candidate[0],'u = v','cedarKit',candidate[7],'(iv)','PW-SLS',candidate[1],'快递员把贴有标签的箱子搬上楼。'];
  source.forEach((text,index)=>{if(index===1)page.pushOperators(beginMarkedContent('Formula'));page.drawText(text,{x:40,y:740-index*35,size:10,font});if(index===1)page.pushOperators(endMarkedContent());});
  await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const spans=await readPdfPreservedSpans(prepared.sourcePath,root);
  assert.strictEqual(await readPdfPreservedSpans(prepared.sourcePath,root),spans,'unchanged source reuses the verified prescan instead of scanning per message');
  assert.ok(spans.some(s=>s.line===3&&s.text==='cedarKit'));
  const refs=await pdfReferencesForRange(prepared.sourcePath,root,3,6);
  assert.ok(refs.preservedSpans.some(s=>s.line===6&&s.text==='PW-SLS'),'full-source definitions reach a later assignment');
  repository=new PiSessionRepository(root);await repository.create('academic-parent');
  const provider=fauxProvider({provider:'academic-pdf',tokensPerSecond:1_000_000}),models=createModels();models.setProvider(provider.provider);
  const request={sourcePath:prepared.sourcePath,outputDir:root,sessionId:'academic-parent',prompt:'Translate PDF.',workflowIntent:'translation',languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false,subagentEnabled:true,subagentCount:1};
  const options=await createYnTranslationValidationOptions(request,undefined,3);
  assert.ok(options.pdfPreservedSpans.some(s=>s.line===1&&s.text==='cedarKit'),'range validation rebases only row identity');
  assert.equal(validateTranslationCandidate(source.slice(2,6).join('\n'),translated.slice(2,6).join('\n'),options).blocking.length,0);
  const call=(name,args={})=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
  provider.setResponses([call('readAssignedSource'),input=>{
    const read=JSON.parse(input.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
    assert.ok(read.pdfReferences.preservedSpans.some(s=>s.text==='cedarKit'));
    assert.ok(read.sourceBlocks.every(b=>!b.absoluteLines.includes(2)));
    return call('writeAssignedTranslation',{blocks:read.sourceBlocks.map(b=>({id:b.id,lines:b.lines.map((line,index)=>line[0]+(b.absoluteLines[index]===8?source[7]:translated[b.absoluteLines[index]-1]))}))});
  },input=>{
    const result=JSON.parse(input.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
    assert.deepEqual(result.requiredBatchLines,[8],'only genuinely untranslated prose becomes repair debt');
    assert.deepEqual(result.submittedValidation.rejectedLines,[8],'submitted rejection is distinguished from persisted candidate validation');
    assert.ok(result.submittedValidation.blockingCount>0);
    return call('readAssignedSource');
  },call('repairAssignedTranslation',{entries:[{line:8,translation:translated[7]}]}),call('validateAssignedTranslation')]);
  let reviews=0;
  const context={request,task:{documentId:'academic.txt',fromLine:1,toLine:8},publishCustomMessage:async()=>{},createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),onChunkReadyForReview:async()=>{reviews++;return{accepted:true}}};
  worker=await createPiTranslationSubagentWorker(context);const done=await worker.runAssignment(context);assert.equal(done.validation.blocking.length,0);assert.equal(reviews,1);await worker.dispose();worker=undefined;
  const canonical=resolveTranslationCandidatePath({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'academic.txt'});
  const artifact=await executeArtifactOperation({operation:'validate',args:{sourcePath:prepared.sourcePath,candidatePath:canonical,projectDir:root,languagePair:'en->zh-CN'},assets:{glossaryEntries:[],characterEntries:[],styleForbiddenTerms:[]}},()=>{},()=>{},async()=>{});
  assert.equal(artifact.validation.blocking.length,0,'candidate import uses the same PDF prescan');
  const translatedText=await readFile(canonical,'utf8');
  let batch;
  const alignment=createTranslationAlignmentHostState();
  const tools=createYnDomainTools({request,domainRun:createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:true,subagentEnabled:true,subagentCount:1}),translationAlignmentState:alignment,publishCustomMessage:async()=>{},persistHostState:async()=>{},subagents:{hasRunning:()=>false,startTranslationBatch(value){batch=value;return{id:'pdf-prescan-review',subagents:[],status:'running'}}}});
  await tools.find(t=>t.name==='runTranslationSubagents').execute('start',{});
  const staging=await prepareTranslationStagingCandidate({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'academic.txt',sessionId:request.sessionId,subagentId:'translator',assignmentId:'academic.txt:L1-L8'});
  await writeFile(staging,translatedText);
  assert.equal((await readFile(staging,'utf8')).split('\n')[2],'cedarKit','review staging must contain the translated package row');
  await batch.onStagingCandidateCheckpoint({documentId:'academic.txt',fromLine:1,toLine:8,candidatePath:staging,accepted:true,requiredLines:[],repairIssues:[]});
  const review=await batch.prepareChunkReview({documentId:'academic.txt',subagentId:'translator',label:'Translator',fromLine:1,toLine:8,candidatePath:staging,validation:{accepted:true,ok:true,blocking:[],warnings:[]},discoveries:{glossaryCandidates:[],characterFacts:[]}});
  provider.setResponses([call('readAssignedTranslationReview'),input=>{
    const read=JSON.parse(input.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
    assert.ok(read.pdfReferences.preservedSpans.some(s=>s.text==='cedarKit'));
    return call('submitTranslationReview',{failures:[{line:3,code:'untranslated_residue',note:'Translate the package name cedarKit.'}]});
  }]);
  const reviewContext={...context,task:review.task,readAssignment:review.read,submitAssignment:review.submit};
  reviewer=await createPiTranslationReviewSubagentWorker(reviewContext);
  const reviewed=await reviewer.runAssignment(reviewContext);
  assert.equal(reviewed.decision.accepted,true,'Host rejects false package-name repair debt from the real reviewer: '+JSON.stringify(reviewed.decision));
  console.log('ok native Pi translation, repair, review and candidate validation share the PDF academic prescan');
} finally {await worker?.dispose();await reviewer?.dispose();await repository?.close();await rm(root,{recursive:true,force:true});}
