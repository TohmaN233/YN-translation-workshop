import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, beginMarkedContent, endMarkedContent } from 'pdf-lib';
import { preparePdfDocument, readPdfLayout } from '../src/main/pdfDocuments.ts';
import { createPiTranslationSubagentTools } from '../src/main/agent/piNative/subagentRunner.ts';
import { prepareTranslationStagingCandidate, resolveTranslationCandidatePath } from '../src/main/agent/writeTranslationChunk.ts';
import { splitTextLines } from '../src/shared/validation/translationValidator.ts';
import { createPiTranslationSubagentWorker } from '../src/main/agent/piNative/subagentRunner.ts';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createYnDomainTools } from '../src/main/agent/piNative/ynDomainTools.ts';
import { createYnDomainRunContract } from '../src/main/agent/piNative/domainRunContract.ts';
import { YnSubagentSupervisor } from '../src/main/agent/piNative/subagentSupervisor.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-child-rejection-'));
try {
  const original=path.join(root,'case.pdf'),pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let i=1;i<=25;i++) {
    if(i===19)page.pushOperators(beginMarkedContent('Code'));
    if(i===20)page.pushOperators(beginMarkedContent('Formula'));
    page.drawText(i===19?'const n = 2;':i===20?'x = y':`Source sentence ${i} has its own complete meaning.`,{x:40,y:760-i*24,size:10,font});
    if(i===19||i===20)page.pushOperators(endMarkedContent());
  }
  await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const layout=await readPdfLayout(prepared.sourcePath,root);
  assert.equal(layout.blocks[19].protection,'math');
  assert.equal(layout.blocks[18].protection,'code');
  for(const staged of [true,false]) {
    const request={outputDir:root,sessionId:staged?'staged':'canonical',prompt:'Translate PDF.',sourcePath:prepared.sourcePath,languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
    const workingCandidatePath=staged?await prepareTranslationStagingCandidate({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'case.txt',sessionId:'test',subagentId:'test',assignmentId:'test'}):undefined;
    const candidate=workingCandidatePath??resolveTranslationCandidatePath({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'case.txt'});
    if (staged) {
      assert.equal(splitTextLines(await readFile(candidate,'utf8'))[19],layout.blocks[19].text,'formula must be fixed before any model tool runs');
      const retained=splitTextLines(await readFile(candidate,'utf8'));retained[0]='人工保留的第一行译文。';retained[18]='';retained[19]='incorrect historical formula';await writeFile(candidate,retained.join('\n')+'\n');
      await prepareTranslationStagingCandidate({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'case.txt',sessionId:'test',subagentId:'test',assignmentId:'test',resumeStagingPath:candidate});
      const resumed=splitTextLines(await readFile(candidate,'utf8'));assert.deepEqual(resumed,retained,'preparation must preserve old bytes until the Host verifies retained evidence');
    }
    const tools=createPiTranslationSubagentTools({request,task:{documentId:'case.txt',fromLine:17,toLine:23},executionMode:'translation',workingCandidatePath});
    const execute=async(name,args={})=>JSON.parse((await tools.find(tool=>tool.name===name).execute(name,args)).content[0].text);
    const read=await execute('readAssignedSource');
    assert.ok(read.sourceBlocks.every(block=>!block.absoluteLines.includes(19)&&!block.absoluteLines.includes(20)),'protected code/formula are not writable model rows');
    assert.equal(read.pdfReferences.protectedLines.find(row=>row.line===20).text,layout.blocks[19].text,'formula remains read-only semantic context');
    const values=read.sourceBlocks.map(block=>({id:block.id,lines:block.lines.map((line,index)=>line[0]+(block.absoluteLines[index]===20?layout.blocks[19].text:`第${block.absoluteLines[index]}行保留原文的完整含义。`))}));
    const malformed=structuredClone(values);malformed[0].lines=malformed[0].lines.filter((_,index)=>read.sourceBlocks[0].absoluteLines[index]!==21); // Missing prose marker; the formula is Host-owned.
    let rejected;
    await assert.doesNotReject(async()=>{rejected=await execute('writeAssignedTranslation',{blocks:malformed})},'invalid model block must return repair debt instead of a fatal Host persistence failure');
    assert.ok(rejected.requiredLineCount>0);
    assert.ok(!rejected.requiredBatchLines.includes(19)&&!rejected.requiredBatchLines.includes(20),'protected code/formula never become model repair debt');
    assert.equal(splitTextLines(await readFile(candidate,'utf8'))[19],layout.blocks[19].text,'Host must retain the formula even when the complete block is rejected');
    assert.equal(splitTextLines(await readFile(candidate,'utf8'))[16],'第17行保留原文的完整含义。','valid prose must remain committed while the formula marker is repaired');
    await execute('readAssignedSource');
    const repaired=await execute('repairAssignedTranslation',{entries:rejected.requiredBatchLines.map(line=>({line,translation:line===20?layout.blocks[19].text:`第${line}行保留原文的完整含义。`}))});
    assert.equal(repaired.requiredLineCount,0);
    assert.equal(splitTextLines(await readFile(candidate,'utf8'))[19],layout.blocks[19].text);
    assert.equal(splitTextLines(await readFile(candidate,'utf8'))[0],staged?'人工保留的第一行译文。':'','assignment never writes other prose');
    await execute('validateAssignedTranslation');
  }
  const candidate=resolveTranslationCandidatePath({outputDir:root,sourcePaths:[prepared.sourcePath],documentId:'case.txt'});await rm(candidate);
  const provider=fauxProvider({provider:'pdf-rejected-native',tokensPerSecond:1_000_000}),models=createModels();models.setProvider(provider.provider);
  const request={outputDir:root,sessionId:'native',prompt:'Translate PDF.',sourcePath:prepared.sourcePath,languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
  const call=(name,args={})=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
  provider.setResponses([call('readAssignedSource'),context=>{
    const read=JSON.parse(context.messages.filter(message=>message.role==='toolResult').at(-1).content[0].text);
    assert.ok(read.sourceBlocks.every(block=>!block.absoluteLines.includes(20)));
    return call('writeAssignedTranslation',{blocks:read.sourceBlocks.map(block=>({id:block.id,lines:block.lines.flatMap((line,index)=>block.absoluteLines[index]===21?[]:[line[0]+`第${block.absoluteLines[index]}行保留原文的完整含义。`])}))});
  },call('readAssignedSource'),call('repairAssignedTranslation',{entries:[{line:21,translation:'第21行保留原文的完整含义。'}]}),call('validateAssignedTranslation')]);
  let reviewed=0;
  const worker=await createPiTranslationSubagentWorker({request,task:{documentId:'case.txt',fromLine:17,toLine:23},publishCustomMessage:async()=>{},
    createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),
    onChunkReadyForReview:async()=>{reviewed++;return {accepted:true}}});
  try {const result=await worker.runAssignment({request,task:{documentId:'case.txt',fromLine:17,toLine:23},onChunkReadyForReview:async()=>{reviewed++;return {accepted:true}}});assert.equal(result.validation.blocking.length,0);assert.equal(reviewed,1);}
  finally {await worker.dispose();}
  assert.equal(splitTextLines(await readFile(candidate,'utf8'))[19],layout.blocks[19].text,'native Pi repair and promotion retain original math');
  await rm(candidate);
  let modelCalls=0;provider.setResponses([()=>{modelCalls++;throw new Error('An all-protected assignment must not request model translation.')}]);
  const protectedTask={documentId:'case.txt',fromLine:19,toLine:20,reviewFeedback:[{line:19,reason:'pdf_protected_code_mismatch: retain original code'},{line:20,reason:'pdf_protected_math_mismatch: retain original math'}]};
  const immutable=await createPiTranslationSubagentWorker({request,task:protectedTask,publishCustomMessage:async()=>{},
    createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}),onChunkReadyForReview:async()=>({accepted:true})});
  try {await immutable.runAssignment({request,task:protectedTask,onChunkReadyForReview:async()=>({accepted:true})});assert.equal(modelCalls,0,'old protected-only review feedback cannot launch translation');}
  finally{await immutable.dispose();}
  assert.equal(splitTextLines(await readFile(candidate,'utf8'))[19],layout.blocks[19].text);
  assert.equal(splitTextLines(await readFile(candidate,'utf8'))[18],layout.blocks[18].text);
  const supervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{}});
  const domain=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:false});
  const parentTools=createYnDomainTools({request,domainRun:domain,subagents:supervisor,publishCustomMessage:async()=>{}});
  const parent=async(name,params)=>JSON.parse((await parentTools.find(tool=>tool.name===name).execute(name,params)).content[0].text);
  const source=await parent('readSourceLines',{fromLine:17,toLine:23});assert.ok(source.translatableLines.every(row=>row.line!==19&&row.line!==20));
  await assert.rejects(parent('writeTranslationChunk',{fromLine:17,toLine:23,entries:[{line:19,translation:'changed'}]}),/immutable Host-prepared PDF/);
  await parent('writeTranslationChunk',{fromLine:17,toLine:23,entries:source.translatableLines.map(row=>({line:row.line,translation:`第${row.line}行保留原文的完整含义。`}))});
  assert.equal(splitTextLines(await readFile(candidate,'utf8'))[18],layout.blocks[18].text);assert.equal(splitTextLines(await readFile(candidate,'utf8'))[19],layout.blocks[19].text);
  await supervisor.waitForAll();
  console.log('Malformed PDF child blocks remain repairable with exact Host-protected formulas in staging, canonical and native Pi writes');
} finally {assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));await rm(root,{recursive:true,force:true});}
