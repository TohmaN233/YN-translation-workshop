import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,StandardFonts,beginText,endText,setFontAndSize,moveText,showText,beginMarkedContent,endMarkedContent} from 'pdf-lib';
import {readPdfLayout,readPdfProtectedLines,pdfReferencesForRange,createTranslatedPdf,assertPdfProtectedWrite} from '../src/main/pdfDocuments.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import {createPiTranslationSubagentWorker} from '../src/main/agent/piNative/subagentRunner.ts';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
const printService=process.versions.electron?undefined:await createNativePdfPrintBackend();
if(printService)configurePdfPrintBackend(printService.backend);
try {
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-boundary-'));
try {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([600,800]);
  for(const [text,y] of [['A centered wrapped title for',740],['complete translation',714]])page.drawText(text,{x:300-font.widthOfTextAtSize(text,17.2154)/2,y,font,size:17.2154});
  page.drawText('We introduce a method for unparameterized',{x:116.626,y:640,font,size:9.9626});
  page.drawText('planar curves and explain the complete method.',{x:101.682,y:625.654,font,size:9.9626});
  page.drawText('Its abstract ends with a final sentence.',{x:101.682,y:611.308,font,size:9.9626});
  page.drawText('The normal body uses a different font size and margin.',{x:74.409,y:570,font,size:10.9091});
  const key=page.node.newFontDictionary(font.name,font.ref);
  page.pushOperators(beginText(),setFontAndSize(key,12),moveText(40,500),showText(font.encodeText('let ')),beginMarkedContent('Formula'),showText(font.encodeText('x + y')),endMarkedContent(),showText(font.encodeText(' denote the quantity in the complete experiment.')),endText());
  page.pushOperators(beginMarkedContent('Formula'));page.drawText('x + y',{x:240,y:350,font,size:12});page.pushOperators(endMarkedContent());
  page.drawText('(1)',{x:510,y:350,font,size:12});
  const body='Source paragraph establishes the equation number right margin.';
  page.drawText(body,{x:510+font.widthOfTextAtSize('(1)',12)-font.widthOfTextAtSize(body,12),y:310,font,size:12});
  const original=path.join(root,'boundary.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop')),layout=await readPdfLayout(prepared.sourcePath,root);
  assert.equal(layout.blocks[0].text,'A centered wrapped title for complete translation');
  assert.ok(layout.blocks[1].text.endsWith('final sentence.'));assert.equal(layout.blocks[1].proseSegments[0].boxes.length,3);
  const narrow=layout.blocks.find(row=>row.text.startsWith('let')),label=layout.blocks.find(row=>row.text==='(1)');
  assert.equal(label.protection,'math');assert.ok((await readPdfProtectedLines(prepared.sourcePath,root)).some(row=>row.line===label.line));
  const refs=await pdfReferencesForRange(prepared.sourcePath,root,1,layout.blocks.length);
  assert.ok(refs.protectedLines.some(row=>row.line===label.line));
  await assert.rejects(assertPdfProtectedWrite(prepared.sourcePath,root,[{line:label.line,text:'（1）'}]),/protected math/);
  const token=narrow.inlineProtections[0].token,translated=`我们令${token}表示这个实验中的量，并保留完整的段落。`;
  const lines=layout.blocks.map(row=>row.protection?row.text:row===narrow?translated:row.line===1?'用于完整翻译的居中换行标题':row.line===2?'我们提出针对无参数化平面曲线的方法，并完整介绍其内容；摘要以最后一句结束。':'正文说明。');
  const provider=fauxProvider({provider:'pdf-boundary',tokensPerSecond:1_000_000,models:[{id:'fixture',reasoning:false,contextWindow:64000,maxTokens:4096}]});
  const models=createModels();models.setProvider(provider.provider);
  const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
  let reads=0;
  provider.setResponses([call('readAssignedSource',{}),context=>{
    const message=context.messages.filter(message=>message.role==='toolResult').at(-1),data=JSON.parse(message.content.find(block=>block.type==='text').text);
    assert.ok(data.sourceBlocks.flatMap(block=>block.lines).some(row=>String(row).includes('final sentence.')),'native model input receives a complete abstract');reads++;
    return call('writeAssignedTranslation',{blocks:data.sourceBlocks.map(block=>({id:block.id,lines:block.lines.map((row,index)=>row[0]+lines[block.absoluteLines[index]-1])}))});
  },call('validateAssignedTranslation',{})]);
  const request={sessionId:'fixture',outputDir:root,sourcePath:prepared.sourcePath,prompt:'Translate the complete paragraph.',providerId:provider.provider.id,modelId:provider.getModel().id,languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
  const common={request,publishCustomMessage:async()=>{},createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})};
  const worker=await createPiTranslationSubagentWorker({...common,task:{fromLine:2,toLine:2},onChunkReadyForReview:async()=>({accepted:true})});
  try{assert.equal((await worker.runAssignment({...common,task:{fromLine:2,toLine:2},onChunkReadyForReview:async()=>({accepted:true})})).validation.blocking.length,0);assert.equal(reads,1);}
  finally{await worker.dispose();}
  const result=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:lines});
  const html=await readFile(result.htmlPath,'utf8');
  assert.ok(html.includes('我们令'));assert.ok(html.includes(`data-token="${token}"`));assert.ok(!html.includes('height:13.6'),'source prose box height does not constrain target text');
  const output=await readFile(result.outputPath);
  const long=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:lines.map((line,index)=>index===narrow.line-1?line+'正文'.repeat(1000):line)});
  assert.ok(long.pages>result.pages,'long translation paginates instead of failing at the source box');
  const latest=await readFile(long.outputPath);
  await assert.rejects(createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:lines.map((line,index)=>index===narrow.line-1?line.replace(token,''):line)}),/markers/);
  assert.deepEqual(await readFile(result.outputPath),latest,'invalid marker ownership does not replace the prior PDF');
  const trace=JSON.parse(await readFile(prepared.sourcePath+'.pdf-segmentation.json','utf8'));
  assert.equal(trace.sourceHash,layout.sourceHash);
  assert.equal(trace.pages[0].decisions.length,layout.physicalBlocks.length,'production visual extraction retains each raw source primitive');
  assert.deepEqual(trace.pages[0].decisions.filter(row=>row.line===2).map(row=>row.physicalLine),layout.blocks[1].fragments,
    'the complete abstract candidate owns all visual rows after mechanical paragraph grouping');
  console.log('Complete paragraph native input/write, equation label protection, same-order native glyph reflow and atomic overflow checks pass');
}finally{await rm(root,{recursive:true,force:true});}

}finally{if(printService)await printService.close();}
