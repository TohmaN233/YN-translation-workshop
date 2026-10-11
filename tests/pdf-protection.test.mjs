import { prepareTranslationReuseAudit, readTranslationReuseAuditBatch, applyTranslationReuseAudits } from '../src/main/agent/piNative/translationReuseAudit.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, beginMarkedContent, endMarkedContent, beginText, endText, setFontAndSize, moveText, showText } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { preparePdfDocument, readPdfLayout, readPdfProtectedLines, createTranslatedPdf, preflightPdfRequest, pdfReferencesForRange, assertPdfProtectedWrite } from '../src/main/pdfDocuments.ts';
import { protectPdfText } from '../src/main/pdfProtection.ts';
import { validateTranslationCandidate } from '../src/shared/validation/translationValidator.ts';
import { validateProofreadReplacement } from '../src/shared/validation/proofreadReplacement.ts';
import { buildCandidateImportPlan } from '../src/main/agent/importCandidate.ts';
import { writeTranslationChunk, writeTranslationLines, prepareTranslationStagingCandidate, promoteTranslationStagingRange } from '../src/main/agent/writeTranslationChunk.ts';
import { createYnTranslationValidationOptions } from '../src/main/agent/piNative/translationValidationContext.ts';
import { createPiTranslationSubagentTools, createPiProofreadSubagentTools } from '../src/main/agent/piNative/subagentRunner.ts';
import { resolvePiSourceManifest } from '../src/main/agent/piNative/sourceManifest.ts';
import { buildProofreadDeterministicSignals } from '../src/main/agent/piNative/proofreadPrescan.ts';
import { writeReviewHtml, readReviewHtml } from '../src/main/reviewHtmlPortability.ts';
import { renderLineReviewHtml } from '../src/shared/core/html.ts';
import { pdfProtectionHash } from '../src/main/pdfTypes.ts';
import { PiNativeSessionService } from '../src/main/agent/piNative/sessionService.ts';

const protectedJapanese = '// 太郎の名前を表示する';
const options = { languagePair:'ja->zh-CN', pdfProtectedLines:[{line:501,kind:'code',text:protectedJapanese}], lineOffset:500,
  glossaryEntries:[{source:'太郎',target:'太朗'}], styleForbiddenTerms:['太郎'], customPreserveRules:[] };
assert.deepEqual(validateTranslationCandidate(protectedJapanese, protectedJapanese, options).warnings, []);
assert.equal(validateTranslationCandidate(protectedJapanese, '// 显示太朗的名字', options).blocking[0].code,'pdf_protected_content_mismatch');
assert.equal(validateTranslationCandidate(protectedJapanese, protectedJapanese+' ', options).ok,false,'exact whitespace is protected');
assert.equal(validateProofreadReplacement(protectedJapanese,'// 显示名字',options,501)[0].line,501);
assert.deepEqual(validateProofreadReplacement(protectedJapanese,protectedJapanese,options,501),[]);
assert.throws(()=>validateTranslationCandidate('different source',protectedJapanese,options),/source binding changed/);
assert.equal(buildCandidateImportPlan(protectedJapanese,'// 显示名字','zh-CN','ja->zh-CN',[],[],[],[],[{...options.pdfProtectedLines[0],line:1}]).ok,false);
assert.equal(validateTranslationCandidate(protectedJapanese+'\n私は今日もこの場所で皆さんを待っています。',protectedJapanese+'\n私は今日もこの場所で皆さんを待っています。',{...options,lineOffset:0,pdfProtectedLines:[{...options.pdfProtectedLines[0],line:1}]}).blocking.some(f=>f.line===2&&f.code==='likely_untranslated'),true,'unprotected prose still receives residue checks');
assert.deepEqual(buildProofreadDeterministicSignals({sourceText:protectedJapanese,translationText:protectedJapanese,
  validationOptions:{...options,lineOffset:0,pdfProtectedLines:[{...options.pdfProtectedLines[0],line:1}]}}),[]);

const item=(str,x=20,y=40)=>({str,fontName:'f',transform:[10,0,0,10,x,y],width:str.length*5,height:10,dir:'ltr',hasEOL:true});
const tagged = protectPdfText({items:[{type:'beginMarkedContentProps',id:'p1_mcid0'},item('Do not translate this code comment'),{type:'endMarkedContent'}],styles:{f:{fontFamily:'serif'}}},
  {role:'Document',children:[{role:'Code',children:[{type:'content',id:'p1_mcid0'}]}]},[{operator:7,text:'Do not translate this code comment',color:[0,0,0]}],()=>'',1);
assert.equal(tagged.items[0].protection,'code');assert.ok(tagged.retained.has(7));
assert.throws(()=>protectPdfText({items:[item('Energy is E = mc2')],styles:{}},null,[{operator:1,text:'Energy is E = mc2',color:[0,0,0]}],()=>'',2),/mixed with unmarked prose/);
for(const text of ['エネルギーはE = mc2です。','能量为 E = mc2。','It is x = y.','So x = 2.','const a = 1; Translate the following explanation.']) assert.throws(()=>protectPdfText({items:[item(text)],styles:{}},null,[{operator:1,text,color:[0,0,0]}],()=>'',2),/mixed with unmarked prose/);
for(const text of ['return to the previous page','print this page']) assert.equal(protectPdfText({items:[item(text)],styles:{}},null,[{operator:1,text,color:[0,0,0]}],()=>'',2).items[0].protection,undefined);
const separated=protectPdfText({items:[item('const a = 1;',20),item('explanation',80)],styles:{}},null,
  [{operator:1,text:'const a = 1;',color:[0,0,0]},{operator:2,text:'explanation',color:[0,0,0]}],()=>'',2);
assert.equal(separated.items[0].protection,'code');assert.equal(separated.items[1].protection,undefined);
assert.equal(protectPdfText({items:[item('x + y')],styles:{}},null,[{operator:1,text:'x + y',color:[0,0,0]}],()=>'',2).items[0].protection,'math');
assert.throws(()=>protectPdfText({items:[{type:'beginMarkedContent',tag:'Formula'},item('x=2'),{type:'endMarkedContent'},item('prose',40)],styles:{}},null,
  [{operator:1,text:'x=2prose',color:[0,0,0]}],()=>'',3),/shares a text paint/);

const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-protection-'));
try {
  const project=path.join(root,'project');await mkdir(project,{recursive:true});
  const originalPath=path.join(project,'protected.pdf'), pdf=await PDFDocument.create();
  const prose=await pdf.embedFont(StandardFonts.Helvetica), mono=await pdf.embedFont(StandardFonts.Courier);
  let page;
  for(let i=0;i<501;i++) {
    if(i%50===0)page=pdf.addPage([600,800]);
    page.drawText(`const n${i} = ${i};`,{x:40,y:740-(i%50)*12,font:mono,size:8});
  }
  page.drawText('Translate surrounding prose.',{x:40,y:700,font:prose,size:12});
  page.pushOperators(beginMarkedContent('Code'));
  page.drawText('Do not translate this code comment.',{x:40,y:660,font:prose,size:10});
  page.pushOperators(endMarkedContent(),beginMarkedContent('Formula'));
  page.drawText('E = mc',{x:40,y:620,font:prose,size:12});
  page.drawText('2',{x:83,y:626,font:prose,size:7});
  page.pushOperators(endMarkedContent());
  await writeFile(originalPath,await pdf.save());const original=await readFile(originalPath);
  const extracted=await preparePdfDocument(originalPath,path.join(project,'.translation-workshop'));
  const layout=await readPdfLayout(extracted.sourcePath,project), protections=await readPdfProtectedLines(extracted.sourcePath,project);
  assert.equal(layout.version,2);assert.equal(protections[500].line,501);assert.ok(protections.length>501);
  assert.equal(protections.find(p=>p.text.startsWith('Do not')).kind,'code');assert.ok(protections.some(p=>p.kind==='math'));
  assert.equal(layout.blocks.find(p=>p.text==='Translate surrounding prose.').protection,undefined);
  const refs=await pdfReferencesForRange(extracted.sourcePath,project,501,501);assert.equal(refs.protectedLines[0].line,501);
  const lines=extracted.text.split('\n'), translated=lines.map((line,i)=>layout.blocks[i].protection?line:'翻译周围的正文。');
  const request={outputDir:project,sessionId:'pdf-safe',prompt:'Translate PDF.',sourcePath:extracted.sourcePath,sourceSelection:{kind:'file',path:extracted.sourcePath},languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
  const validation=await createYnTranslationValidationOptions(request);
  assert.equal(validateTranslationCandidate(extracted.text,translated.join('\n'),validation).ok,true);
  const auditCandidate=path.join(project,'AI_translation','protected_translated.txt');await mkdir(path.dirname(auditCandidate),{recursive:true});
  const badReuse=translated.slice();badReuse[500]='changed';await writeFile(auditCandidate,badReuse.join('\n'));
  const audit=await prepareTranslationReuseAudit({outputDir:project,sourcePath:extracted.sourcePath,candidatePath:auditCandidate,documentId:'protected.pdf',languagePair:'en->zh-CN',validationOptions:validation});
  const auditRows=await readTranslationReuseAuditBatch({outputDir:project,auditId:audit.auditId,documentId:'protected.pdf',fromLine:500,toLine:501});
  assert.equal(auditRows.lines[0].deterministicDisposition,'automatic_reuse');assert.equal(auditRows.lines[1].deterministicDisposition,'must_retranslate');
  assert.deepEqual(auditRows.lines[0].semanticSignals,[]);assert.deepEqual(auditRows.lines[1].deterministicCodes,['pdf_protected_content_mismatch']);
  const local=await createYnTranslationValidationOptions(request,undefined,501);
  assert.equal(validateTranslationCandidate(lines[500],'changed code',local).blocking[0].line,1);
  await assert.rejects(writeTranslationChunk({outputDir:project,sourcePaths:[extracted.sourcePath],documentId:'protected.pdf',fromLine:501,toLine:501,lines:['changed']}),/protected code/);
  await assert.rejects(writeTranslationLines({outputDir:project,sourcePaths:[extracted.sourcePath],documentId:'protected.pdf',entries:[{line:501,text:'changed'}]}),/protected code/);
  await assert.rejects(assertPdfProtectedWrite(extracted.sourcePath,project,[],true),/retain all/);
  const staged=await prepareTranslationStagingCandidate({outputDir:project,sourcePaths:[extracted.sourcePath],documentId:'protected.pdf',subagentId:'fixture',sessionId:'fixture',assignmentId:'fixture'});
  const damaged=lines.slice();damaged[500]='changed';await writeFile(staged,damaged.join('\n')+'\n');
  await assert.rejects(promoteTranslationStagingRange({outputDir:project,sourcePaths:[extracted.sourcePath],documentId:'protected.pdf',stagingPath:staged,fromLine:501,toLine:501}),/protected code/);
  // Actual child submission must return an exact rejected row, without writing it.
  const context={request,task:{fromLine:501,toLine:501},executionMode:'translation'};
  const childTools=createPiTranslationSubagentTools(context);
  const read=childTools.find(t=>t.name==='readAssignedSource'),write=childTools.find(t=>t.name==='writeAssignedTranslation');
  const sourceBlocks=JSON.parse((await read.execute('read',{})).content[0].text).sourceBlocks;
  const rejected=JSON.parse((await write.execute('write',{blocks:sourceBlocks.map(block=>({id:block.id,lines:block.lines.map(line=>line[0]+'changed')}))})).content[0].text);
  assert.ok(JSON.stringify(rejected).includes('pdf_protected_content_mismatch'));assert.ok(JSON.stringify(rejected).includes('501'));
  const translationPath=path.join(project,'translation.txt');await writeFile(translationPath,translated.join('\n'));
  const proofTools=createPiProofreadSubagentTools({request:{...request,translationPath},task:{fromLine:501,toLine:501},publishCustomMessage:async()=>{}},'proof',{referenceRead:false,findingsWritten:false,findingsCount:0});
  await proofTools.find(t=>t.name==='readAssignedProofreadContext').execute('read',{});
  const proof=JSON.parse((await proofTools.find(t=>t.name==='writeAssignedFindings').execute('proof',{findings:[{id:'H1-code',sourceLine:501,suggestedFix:'changed',rationale:'rewrite'}]})).content[0].text);
  assert.equal(proof.rejectedFindings[0].sourceLine,501);assert.match(proof.rejectedFindings[0].reason,/pdf_protected_content_mismatch/);
  const htmlPath=path.join(project,'.translation-workshop','html','protected.html');
  await mkdir(path.dirname(htmlPath),{recursive:true});
  await writeReviewHtml(htmlPath,renderLineReviewHtml({title:'Protected',sourceText:extracted.text,translationText:translated.join('\n'),workflow:{sourcePath:originalPath,validationSourcePath:extracted.sourcePath,outputDir:project}}));
  const review=JSON.parse((await readReviewHtml(htmlPath)).match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(review.rows[500].pdfProtection,'code');assert.ok((await readFile(htmlPath,'utf8')).includes('row.pdfProtection'));
  const output=await createTranslatedPdf({templatePath:originalPath,sourcePath:extracted.sourcePath,projectRoot:project,translatedLines:translated});
  const bytes=await readFile(output.outputPath), changed=translated.slice();changed[500]='changed';
  await assert.rejects(createTranslatedPdf({templatePath:originalPath,sourcePath:extracted.sourcePath,projectRoot:project,translatedLines:changed}),/protected code/);
  assert.deepEqual(await readFile(output.outputPath),bytes);assert.deepEqual(await readFile(originalPath),original);
  // Native original glyph bounds, including the superscript, survive pixel-for-pixel.
  const last=layout.pages.at(-1), preview=await loadImage(await readFile(last.previewPath)), background=await loadImage(await readFile(last.backgroundPath));
  const pixels=image=>{const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(65,320,160,55).data;};
  assert.deepEqual(pixels(preview),pixels(background));
  if(process.env.YN_PDF_VISUAL_EVIDENCE){const evidence=path.resolve(process.env.YN_PDF_VISUAL_EVIDENCE);await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'protected-source.pdf'),original);await writeFile(path.join(evidence,'protected-translated.pdf'),bytes);await writeFile(path.join(evidence,'layout.json'),JSON.stringify(layout,null,2));}
  const sourceBytes=await readFile(extracted.sourcePath);await writeFile(extracted.sourcePath,sourceBytes.toString().replace('const n0','const z0'));
  await assert.rejects(readPdfProtectedLines(extracted.sourcePath,project),error=>error.name==='NonRetryableAssignmentError'&&/source binding changed/.test(error.message));
  await writeFile(extracted.sourcePath,sourceBytes);
  const forgedFolder=path.join(project,'forged');await mkdir(forgedFolder);const forgedOriginal=path.join(forgedFolder,'test.pdf'), forgedProjection=path.join(forgedFolder,'flat.txt');
  await writeFile(forgedOriginal,original);await writeFile(forgedProjection,extracted.text);
  const forgedRequest={...request,sourcePath:forgedFolder,sourceSelection:{kind:'folder',path:forgedFolder},folderSourceSelection:'prepared-inputs',folderSourceDocuments:[{id:'test.pdf',path:forgedProjection,projection:{kind:'pdf-text',originalHash:extracted.originalHash,projectionHash:extracted.sourceHash}}]};
  await assert.rejects(preflightPdfRequest(forgedRequest),/protected project projection/);await assert.rejects(resolvePiSourceManifest(forgedRequest),/protected project projection/);
  const largePdf=path.join(project,'large-bound.pdf'),handle=await open(largePdf,'w');await handle.truncate(256*1024*1024);await handle.close();
  const performanceMap={...layout,originalPath:largePdf,originalHash:'0'.repeat(64)};performanceMap.protectionHash=pdfProtectionHash(performanceMap);
  const realMap=await readFile(extracted.sourcePath+'.pdf-layout.json');await writeFile(extracted.sourcePath+'.pdf-layout.json',JSON.stringify(performanceMap));
  let pulses=0,maxGap=0,then=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-then);then=now;pulses++;},5);
  try { await assert.rejects(readPdfProtectedLines(extracted.sourcePath,project),/source binding changed/); } finally {clearInterval(heartbeat);}
  assert.ok(pulses>5&&maxGap<200,`PDF hashing must remain off the main thread: pulses=${pulses}, maxGap=${maxGap}`);
  const controller=new AbortController();const cancelled=preflightPdfRequest(request,controller.signal);setTimeout(()=>controller.abort(new DOMException('stop','AbortError')),15);await assert.rejects(cancelled,error=>error.name==='AbortError');
  let stopSelections=0;const stopService=new PiNativeSessionService({createModelSelection:async()=>{stopSelections++;throw new Error('Stopped PDF preparation must not select a provider.');}}),stopSession=await stopService.createSession(project);
  const journalPath=path.join(project,'.translation-workshop','pdf','events.jsonl'), priorJournal=(await readFile(journalPath,'utf8')).split('binding_verification_started').length;
  const stopping=stopService.prompt({...request,sessionId:stopSession.id}).then(()=>({accepted:true}),error=>({error}));
  const deadline=Date.now()+5000;
  while((await readFile(journalPath,'utf8')).split('binding_verification_started').length===priorJournal){assert.ok(Date.now()<deadline,'real service must enter PDF background preflight');await new Promise(resolve=>setTimeout(resolve,2));}
  await stopService.abort(project,stopSession.id);const stopped=await stopping;assert.equal(stopped.error?.name,'AbortError');assert.equal(stopSelections,0);
  await writeFile(extracted.sourcePath+'.pdf-layout.json',realMap);
  console.log(JSON.stringify({pdfBindingHeartbeat:{pulses,maxGap}}));
  const mapPath=extracted.sourcePath+'.pdf-layout.json', mapBytes=await readFile(mapPath), raw=JSON.parse(mapBytes);
  raw.blocks[500].protection=undefined;await writeFile(mapPath,JSON.stringify(raw));
  await assert.rejects(readPdfProtectedLines(extracted.sourcePath,project),error=>error.name==='NonRetryableAssignmentError');
  raw.version=1;await writeFile(mapPath,JSON.stringify(raw));
  await assert.rejects(preflightPdfRequest(request),/predates Host/);await assert.rejects(resolvePiSourceManifest(request),/predates Host/);
  let selections=0;const service=new PiNativeSessionService({createModelSelection:async()=>{selections++;throw new Error('Provider must not be selected.');}});
  const oldSession=await service.createSession(project);
  await assert.rejects(service.prompt({...request,sessionId:oldSession.id}),/predates Host/);assert.equal(selections,0,'cold old-PDF resume must stop before provider preparation');
  await writeFile(mapPath,mapBytes);await rm(mapPath);await assert.rejects(preflightPdfRequest(request),error=>error.name==='RequiredWorkflowFileError');
  await writeFile(mapPath,mapBytes);
  const ambiguous=await PDFDocument.create(),aPage=ambiguous.addPage([600,800]);aPage.drawText('Energy is E = mc2',{x:40,y:740,font:await ambiguous.embedFont(StandardFonts.Helvetica),size:12});
  // Native text cursor must advance through hidden prose before the formula paint.
  const inline=await PDFDocument.create(), inlinePage=inline.addPage([600,800]), inlineFont=await inline.embedFont(StandardFonts.Helvetica);
  const fontKey=inlinePage.node.newFontDictionary(inlineFont.name,inlineFont.ref);
  inlinePage.pushOperators(beginText(),setFontAndSize(fontKey,12),moveText(40,740),showText(inlineFont.encodeText('Before: ')),
    beginMarkedContent('Formula'),showText(inlineFont.encodeText('x + y')),endMarkedContent(),showText(inlineFont.encodeText(' after.')),endText());
  const inlinePath=path.join(project,'inline.pdf');await writeFile(inlinePath,await inline.save());
  const inlineExtracted=await preparePdfDocument(inlinePath,path.join(project,'.translation-workshop')), inlineLayout=await readPdfLayout(inlineExtracted.sourcePath,project);
  const inlineMath=inlineLayout.blocks.find(block=>block.protection==='math');assert.ok(inlineMath);
  const inlineImages=await Promise.all([inlineLayout.pages[0].previewPath,inlineLayout.pages[0].backgroundPath].map(async file=>loadImage(await readFile(file))));
  const mathPixels=image=>{const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(Math.floor(inlineMath.x*2),Math.floor(inlineMath.y*2),Math.ceil(inlineMath.width*2),Math.ceil(inlineMath.height*2)).data;};
  assert.deepEqual(mathPixels(inlineImages[0]),mathPixels(inlineImages[1]),'hiding prose must preserve native relative text advance');
  assert.equal(inlineLayout.blocks.filter(block=>!block.protection).length,2,'surrounding prose stays independently translatable');
  const aPath=path.join(project,'ambiguous.pdf');await writeFile(aPath,await ambiguous.save());await assert.rejects(preparePdfDocument(aPath,path.join(project,'.translation-workshop')),/mixed with unmarked prose/);
  console.log('PDF Host code/math extraction, exact range writes, child/proofreading/import, original glyph export, old map and ambiguity guards passed');
} finally {await rm(root,{recursive:true,force:true});}
