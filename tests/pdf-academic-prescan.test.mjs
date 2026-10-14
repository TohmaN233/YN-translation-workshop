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
  'We use the R package mrfDepth and the curveDepth package.',
  'Curve band depth (CBD) and feature-weighted curve band depth (FW-CBD) are compared.',
  'mrfDepth', 'curveDepth', '(a) FW-CBD', '(ii)',
  'The package contains standard functions.',
  'We use mrfDepth to estimate the curves.',
  'R package version 1.0.17.',
  'package ddalpha. Journal of Statistical Software.',
  'https://example.org/data and doi:10.1000/xyz123'
];
const blocks=texts.map((text,index)=>({line:index+1,page:1,text}));
const spans=scanPdfPreservedSpans(blocks);
const options={languagePair:'en->zh-CN',pdfPreservedSpans:spans};
assert.ok(spans.some(s=>s.text==='mrfDepth'&&s.line===3));
assert.ok(spans.some(s=>s.text==='FW-CBD'&&s.line===5));
assert.ok(spans.some(s=>s.text==='(ii)'&&s.line===6));
assert.ok(!spans.some(s=>s.text==='contains'||s.text==='version'));
const candidate=[
  '我们使用 R 包 mrfDepth 和 curveDepth 包。',
  '比较曲线带深度（CBD）和特征加权曲线带深度（FW-CBD）。',
  'mrfDepth','curveDepth','(a) FW-CBD','(ii)',
  '该包包含标准函数。',
  '我们使用 mrfDepth 估计曲线。',
  'R 软件包版本 1.0.17。',
  'ddalpha 包。《统计软件杂志》。',
  'https://example.org/data 和 doi:10.1000/xyz123'
];
const result=validateTranslationCandidate(texts.join('\n'),candidate.join('\n'),options);
assert.equal(result.blocking.length,0,JSON.stringify(result.blocking));
assert.equal(result.warnings.filter(f=>f.code==='likely_untranslated').length,0,JSON.stringify(result.warnings));
const copied=[...candidate];copied[7]=texts[7];
assert.ok(validateTranslationCandidate(texts.join('\n'),copied.join('\n'),options).blocking.some(f=>f.line===8&&f.code==='likely_untranslated'),'preserving a package never exempts its prose');
assert.ok(validateTranslationCandidate('mrfDepth','mrfDepth',{languagePair:'en->zh-CN'}).blocking.some(f=>f.code==='likely_untranslated'),'TXT keeps its existing checks');
assert.equal(createTranslationResiduePayloadReader({...options,pdfPreservedSpans:spans.filter(s=>s.line===3).map(s=>({...s,line:1}))})('mrfDepth','mrfdepth').source.trim(),'mrfDepth','changed identifier case is not excluded from prose checks');
assert.throws(()=>validateTranslationCandidate('different',candidate[2],{...options,pdfPreservedSpans:spans.filter(s=>s.line===3).map(s=>({...s,line:1}))}),/PDF.*prescan|PDF.*preserv/i,'stale scan cannot exempt another source');
const formal={...options,glossaryEntries:[{source:'mrfDepth',target:'另一个明确译名'}]};
assert.ok(validateTranslationCandidate(texts.join('\n'),candidate.join('\n'),formal).warnings.some(f=>f.code==='glossary_missing'),'explicit glossary remains authoritative');
const table=scanPdfPreservedSpans([
  {line:1,page:1,text:'We consider three-letter subsets'},
  {line:2,page:1,text:'designed for clustering: aho, mwz, nor, uvw, and bgy.'},
  {line:3,page:2,text:'nor',y:120},
  {line:4,page:2,text:'0.511',y:120},
  {line:5,page:2,text:'0.867',y:120},
  {line:6,page:2,text:'nor does the method change the sample.',y:140}
]);
assert.ok(table.some(s=>s.line===3&&s.text==='nor'));
assert.ok(!table.some(s=>s.line===6),'a letter-code label must never exempt its spelling in ordinary prose');
console.log('ok PDF source prescan exempts evidenced identifiers and labels while retaining prose and glossary checks');

const datasetSource=[
  'We evaluate the MOBISIG online-signature dataset.',
  'Clustering comparisons on UCI Character Trajectories (Williams, 2006).',
  'UCI Character Trajectories supports this clustering analysis.'
];
const datasetSpans=scanPdfPreservedSpans(datasetSource.map((text,index)=>({line:index+1,page:1,text})));
assert.ok(datasetSpans.some(span=>span.text==='MOBISIG'&&span.line===1),'explicit dataset declarations qualify names');
assert.ok(datasetSpans.some(span=>span.text==='UCI Character Trajectories'&&span.line===3),'declared corpus names propagate to actual occurrences');
assert.equal(validateTranslationCandidate(datasetSource.join('\n'),[
  '我们评估 MOBISIG 在线签名数据集。',
  '在 UCI Character Trajectories 上进行聚类比较（Williams，2006）。',
  'UCI Character Trajectories 为该聚类分析提供数据。'
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
const acronymSource=['Curve band depth (CBD) and feature-weighted curve band depth (FW-CBD) are compared.','CBD FW-CBD'];
const acronymSpans=scanPdfPreservedSpans(acronymSource.map((text,index)=>({line:index+1,page:1,text})));
const acronymReader=createTranslationResiduePayloadReader({pdfPreservedSpans:acronymSpans});
for(const candidate of ['CBD FW-CBD','FW-CBD CBD']) {
  assert.equal(acronymReader(acronymSource[1],candidate,2).source.trim(),'','longer compound names allocate candidate occurrences first');
  assert.equal(validateTranslationCandidate(acronymSource[1],candidate,{languagePair:'en->zh-CN',pdfPreservedSpans:acronymSpans,lineOffset:1})
    .blocking.some(f=>f.code==='likely_untranslated'),false);
}
assert.equal(acronymReader(acronymSource[1],'CBD CBD FW-CBD',2).source.trim(),'CBD','extra copies cannot manufacture a preservation exemption');
const contextSpan={line:1,start:0,end:8,text:'mrfDepth',kind:'software',evidenceLine:1};
for(const pattern of ['(?<=mrfDepth )HELLO','^mrfDepth HELLO']) {
  const protectedContext={languagePair:'en->zh-CN',pdfPreservedSpans:[contextSpan],customPreserveRules:[{pattern,flags:'u'}]};
  assert.equal(validateTranslationCandidate('mrfDepth HELLO','mrfDepth HELLO',protectedContext).blocking.length,0,
    'regex context is evaluated on original text before PDF exclusions: '+pattern);
  const extra=validateTranslationCandidate('mrfDepth HELLO; HELLO','mrfDepth HELLO; HELLO',protectedContext);
  assert.ok(extra.blocking.some(f=>f.code==='likely_untranslated'),'equal spelling outside the actual regex match remains prose');
}
const markerNames=['We use the R package formula and the R package mrfDepth.','mrfDepth {{formula:p1:1}}'];
const markerNameSpans=scanPdfPreservedSpans(markerNames.map((text,index)=>({line:index+1,page:1,text})));
assert.equal(validateTranslationCandidate(markerNames[1],markerNames[1],{languagePair:'en->zh-CN',pdfPreservedSpans:markerNameSpans,lineOffset:1})
  .blocking.length,0,'software-name spans inside a Host marker cannot damage that marker before exclusion');
const placeholderSpan={line:1,start:1,end:9,text:'mrfDepth',kind:'software',evidenceLine:1};
assert.equal(validateTranslationCandidate('{mrfDepth}','{mrfDepth}',{languagePair:'en->zh-CN',pdfPreservedSpans:[placeholderSpan]})
  .blocking.length,0,'placeholder positions are combined with overlapping PDF spans on original text');

const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-academic-'));
let repository,worker,reviewer;
try {
  const original=path.join(root,'academic.pdf'),pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  const source=[texts[0],'x = y','mrfDepth',texts[7],'(ii)','FW-CBD',texts[1],'The method estimates the complete curve.'];
  const translated=['我们使用 R 包 mrfDepth 和 curveDepth 包。','x = y','mrfDepth','我们使用 mrfDepth 估计曲线。','(ii)','FW-CBD','比较曲线带深度（CBD）和特征加权曲线带深度（FW-CBD）。','该方法估计完整曲线。'];
  source.forEach((text,index)=>{if(index===1)page.pushOperators(beginMarkedContent('Formula'));page.drawText(text,{x:40,y:740-index*35,size:10,font});if(index===1)page.pushOperators(endMarkedContent());});
  await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const spans=await readPdfPreservedSpans(prepared.sourcePath,root);
  assert.strictEqual(await readPdfPreservedSpans(prepared.sourcePath,root),spans,'unchanged source reuses the verified prescan instead of scanning per message');
  assert.ok(spans.some(s=>s.line===3&&s.text==='mrfDepth'));
  const refs=await pdfReferencesForRange(prepared.sourcePath,root,3,6);
  assert.ok(refs.preservedSpans.some(s=>s.line===6&&s.text==='FW-CBD'),'full-source definitions reach a later assignment');
  repository=new PiSessionRepository(root);await repository.create('academic-parent');
  const provider=fauxProvider({provider:'academic-pdf',tokensPerSecond:1_000_000}),models=createModels();models.setProvider(provider.provider);
  const request={sourcePath:prepared.sourcePath,outputDir:root,sessionId:'academic-parent',prompt:'Translate PDF.',workflowIntent:'translation',languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false,subagentEnabled:true,subagentCount:1};
  const options=await createYnTranslationValidationOptions(request,undefined,3);
  assert.ok(options.pdfPreservedSpans.some(s=>s.line===1&&s.text==='mrfDepth'),'range validation rebases only row identity');
  assert.equal(validateTranslationCandidate(source.slice(2,6).join('\n'),translated.slice(2,6).join('\n'),options).blocking.length,0);
  const call=(name,args={})=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
  provider.setResponses([call('readAssignedSource'),input=>{
    const read=JSON.parse(input.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
    assert.ok(read.pdfReferences.preservedSpans.some(s=>s.text==='mrfDepth'));
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
  assert.equal((await readFile(staging,'utf8')).split('\n')[2],'mrfDepth','review staging must contain the translated package row');
  await batch.onStagingCandidateCheckpoint({documentId:'academic.txt',fromLine:1,toLine:8,candidatePath:staging,accepted:true,requiredLines:[],repairIssues:[]});
  const review=await batch.prepareChunkReview({documentId:'academic.txt',subagentId:'translator',label:'Translator',fromLine:1,toLine:8,candidatePath:staging,validation:{accepted:true,ok:true,blocking:[],warnings:[]},discoveries:{glossaryCandidates:[],characterFacts:[]}});
  provider.setResponses([call('readAssignedTranslationReview'),input=>{
    const read=JSON.parse(input.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
    assert.ok(read.pdfReferences.preservedSpans.some(s=>s.text==='mrfDepth'));
    return call('submitTranslationReview',{failures:[{line:3,code:'untranslated_residue',note:'Translate the package name mrfDepth.'}]});
  }]);
  const reviewContext={...context,task:review.task,readAssignment:review.read,submitAssignment:review.submit};
  reviewer=await createPiTranslationReviewSubagentWorker(reviewContext);
  const reviewed=await reviewer.runAssignment(reviewContext);
  assert.equal(reviewed.decision.accepted,true,'Host rejects false package-name repair debt from the real reviewer: '+JSON.stringify(reviewed.decision));
  console.log('ok native Pi translation, repair, review and candidate validation share the PDF academic prescan');
} finally {await worker?.dispose();await reviewer?.dispose();await repository?.close();await rm(root,{recursive:true,force:true});}
