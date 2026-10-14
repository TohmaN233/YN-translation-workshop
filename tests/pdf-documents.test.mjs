import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, setTextRenderingMode, TextRenderingMode, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createTranslatedPdf, readPdfLayout, pdfReferencesForRange, readPdfReferenceImage } from '../src/main/pdfDocuments.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';
import { createPdfReferenceTools } from '../src/main/agent/piNative/pdfReferenceTools.ts';
import { prepareBuiltinTaskDocuments, generateBuiltinTaskReview } from '../src/main/builtinTaskDocuments.ts';
import { builtinTaskDefaults } from '../src/shared/builtinTasks.ts';
import { resolvePiSourceManifest } from '../src/main/agent/piNative/sourceManifest.ts';
import { resolveReviewHtmlPaths } from '../src/main/reviewHtmlPortability.ts';
import { upgradeLegacyReviewHtmlTree } from '../src/main/reviewHtmlUpgrade.ts';
import { LINE_REVIEW_PROTOCOL_VERSION } from '../src/shared/core/html.ts';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';
import { createPiTranslationSubagentWorker, createPiProofreadSubagentWorker } from '../src/main/agent/piNative/subagentRunner.ts';

const printService=process.versions.electron?undefined:await createNativePdfPrintBackend();
if(printService)configurePdfPrintBackend(printService.backend);
try {
const root = await mkdtemp(path.resolve('.tmp-pdf-documents-'));
try {
  const projectRoot = path.join(root, 'project'), inputDir = path.join(projectRoot, 'inputs');
  await mkdir(inputDir, { recursive: true });
  const originalPath = path.join(inputDir, '図版.pdf');
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600,800]);
  page.drawText('PDF sample', { x: 40, y: 740, size: 22, font, color: rgb(.7,0,0) });
  page.drawText('See Figure 1 for the diagram.', { x: 40, y: 690, size: 12, font });
  page.drawRectangle({ x: 35, y: 560, width: 240, height: 30, borderWidth: 1, borderColor: rgb(0,0,1) });
  page.drawText('Table 1: sample', { x: 40, y: 620, size: 12, font });
  const canvas = createCanvas(160,80), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#225588'; ctx.fillRect(0,0,160,80);
  page.drawImage(await pdf.embedPng(canvas.toBuffer('image/png')), { x: 40, y: 400, width: 160, height: 80 });
  page.drawText('Figure 1. Blue rectangle', { x: 40, y: 378, size: 12, font });
  const second = pdf.addPage([600,800]); second.drawText('Second page', { x: 40,y:740,size:22,font });
  second.drawText('See Figure 1.', { x: 40,y:690,size:12,font });
  await writeFile(originalPath, await pdf.save());
  const original = await readFile(originalPath);
  const workspace = path.join(projectRoot,'.translation-workshop');
  const extracted = await preparePdfDocument(originalPath,workspace);
  assert.equal(path.basename(extracted.sourcePath),'図版.txt','PDF native candidate identity must retain the original Unicode stem');
  assert.equal(extracted.text.split('\n').length,6);
  assert.ok(extracted.sourcePath.endsWith('.txt'));
  const layout = await readPdfLayout(extracted.sourcePath,projectRoot);
  assert.equal(layout.pages.length,2); assert.equal(layout.references.filter(ref=>ref.id.includes('image')).length,1);
  assert.ok(Math.abs(layout.blocks[0].color[0]-.7)<1/255); assert.deepEqual(layout.blocks[0].color.slice(1),[0,0]);
  const previewStat = (await import('node:fs/promises')).stat;
  const before = (await previewStat(layout.pages[0].previewPath)).mtimeMs;
  await preparePdfDocument(originalPath,workspace);
  assert.equal((await previewStat(layout.pages[0].previewPath)).mtimeMs,before,'unchanged extraction must reuse assets');
  for(const asset of [layout.pages[0].previewPath,layout.pages[0].backgroundPath]) {
    const bytes=await readFile(asset);await writeFile(asset,Buffer.concat([bytes,Buffer.from('tampered')]));
    await assert.rejects(preparePdfDocument(originalPath,workspace),/PDF asset changed/,'batched warm verification must still hash every asset');
    await writeFile(asset,bytes);
  }
  const refs = await pdfReferencesForRange(extracted.sourcePath,projectRoot,2,2);
  assert.ok(refs.references.some(ref=>ref.id==='p1-image1'));
  assert.equal(JSON.stringify(refs).includes('base64'),false);
  const cross = await pdfReferencesForRange(extracted.sourcePath,projectRoot,6,6);
  assert.ok(cross.references.some(ref=>ref.id==='p1-image1'),'explicit cross-page figure references must resolve');
  assert.ok((await readPdfReferenceImage(extracted.sourcePath,projectRoot,'p1-image1',6)).data);
  await assert.rejects(readPdfReferenceImage(extracted.sourcePath,projectRoot,'p1-image1',5),/cited/);
  const request = { sessionId:'fixture', outputDir:projectRoot, sourcePath:extracted.sourcePath };
  const tools = createPdfReferenceTools(()=>request,()=>true);
  const index = await tools[0].execute('index',{fromLine:2,toLine:2});
  assert.equal(index.content.length,1); assert.equal(index.content[0].type,'text');
  const viewed = await tools[1].execute('image',{id:'p1-image1',sourceLine:2,reason:'Figure meaning'});
  assert.equal(viewed.content[1].type,'image'); assert.equal(viewed.content[1].mimeType,'image/png');
  await assert.rejects(createPdfReferenceTools(()=>request,()=>false)[1].execute('no-vision',{id:'p1-image1',sourceLine:2,reason:'Figure meaning'}),/active model/);
  assert.deepEqual(createPdfReferenceTools(()=>({...request,sourcePath:path.join(root,'plain.txt')}),()=>true),[]);
  const translatedLines = ['PDF\u2028示例','参见图 1 理解示意图。','表 1：示例','图 1：蓝色矩形','第二页','参见图 1。'];
  const provider = fauxProvider({provider:'pdf-native-vision',tokensPerSecond:1_000_000,
    models:[{id:'vision',input:['text','image'],reasoning:false,contextWindow:64000,maxTokens:4096}]});
  const models = createModels(); models.setProvider(provider.provider);
  const nativeRequest = {...request,prompt:'Translate and review the PDF source.',providerId:provider.provider.id,modelId:provider.getModel().id,languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
  const common = {request:nativeRequest,publishCustomMessage:async()=>{},createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})};
  const call = (name,args) => fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
  let sourceBlocks, imagesSeen = 0;
  const imageResult = context => {
    const result = context.messages.filter(message=>message.role==='toolResult').at(-1);
    assert.equal(result.isError,false,JSON.stringify(result.content));
    assert.ok(result.content.some(block=>block.type==='image'),'actual native child must receive a Pi image block'); imagesSeen++;
  };
  const replies=[];
  for (const line of [2,6]) replies.push(call('readAssignedSource',{}),context=>{
    const result=context.messages.filter(message=>message.role==='toolResult').at(-1);
    const payload=JSON.parse(result.content.find(block=>block.type==='text').text);sourceBlocks=payload.sourceBlocks;
    assert.ok(payload.pdfReferences.references.some(ref=>ref.id==='p1-image1'));
    assert.ok(!context.messages.some(message=>message.role==='toolResult'&&message.content.some(block=>block.type==='image')),'reset must clear previous image context');
    return call('viewPdfReference',{id:'p1-image1',sourceLine:line,reason:'The passage refers to Figure 1.'});
  },context=>{imageResult(context);return call('writeAssignedTranslation',{blocks:sourceBlocks.map(block=>({id:block.id,lines:block.lines.map((row,index)=>row[0]+translatedLines[block.absoluteLines[index]-1])}))});},call('validateAssignedTranslation',{}));
  provider.setResponses(replies);
  const worker=await createPiTranslationSubagentWorker({...common,task:{fromLine:2,toLine:2},onChunkReadyForReview:async()=>({accepted:true})});
  try {
    for(const line of [2,6]) assert.equal((await worker.runAssignment({...common,task:{fromLine:line,toLine:line},onChunkReadyForReview:async()=>({accepted:true})})).validation.blocking.length,0);
  } finally {await worker.dispose();}
  assert.equal(imagesSeen,2,'fresh assignment contexts must inherit actual worker vision capability');
  await writeFile(path.join(projectRoot,'AI_translation','図版_translated.txt'),translatedLines.join('\n'));
  const proofReplies=[];
  for(const line of [2,6]) proofReplies.push(call('readAssignedProofreadContext',{}),()=>call('viewPdfReference',{id:'p1-image1',sourceLine:line,reason:'Check the referenced figure.'}),context=>{imageResult(context);return call('writeAssignedFindings',{findings:[]});},fauxAssistantMessage(fauxText('Reviewed.')));
  provider.setResponses(proofReplies);
  const proofWorker=await createPiProofreadSubagentWorker(common);
  try {for(const line of [2,6]) await proofWorker.runAssignment({...common,task:{fromLine:line,toLine:line}});}
  finally {await proofWorker.dispose();}
  assert.equal(imagesSeen,4,'native persistent proofreading must also keep vision support across reset');
  const exported = await createTranslatedPdf({ templatePath:originalPath,sourcePath:extracted.sourcePath,projectRoot,translatedLines });
  const output = await readFile(exported.outputPath);
  const exportDocument=JSON.parse(await readFile(exported.documentPath,'utf8'));
  assert.ok(layout.references.some(reference=>reference.kind==='vector'),'independent blue border has explicit source vector ownership');
  assert.ok(exportDocument.nodes.some(node=>node.type==='figure'&&node.id.includes('vector')&&node.image),'successful reflow retains the source-owned blue border');
  if (process.env.YN_PDF_VISUAL_EVIDENCE) {
    const evidence = path.resolve(process.env.YN_PDF_VISUAL_EVIDENCE);
    await mkdir(evidence,{recursive:true});
    await writeFile(path.join(evidence,'source.pdf'),original);
    await writeFile(path.join(evidence,'translated.pdf'),output);
    await writeFile(path.join(evidence,'translated.html'),await readFile(exported.htmlPath));
    await writeFile(path.join(evidence,'translated.document.json'),await readFile(exported.documentPath));
    await writeFile(path.join(evidence,'layout.json'),JSON.stringify(layout,null,2));
  }
  const task = getDocument({data:new Uint8Array(output)}), roundtrip = await task.promise;
  assert.equal(roundtrip.numPages,exported.pages);
  const renderedTexts=[];
  for(let number=1;number<=roundtrip.numPages;number++)renderedTexts.push((await (await roundtrip.getPage(number)).getTextContent()).items.filter(item=>'str' in item).map(item=>item.str).join(''));
  const targetText = renderedTexts.join('').normalize('NFKC');
  assert.ok(targetText.includes('PDF 示例')); assert.ok(targetText.includes('蓝色矩形')); assert.ok(!targetText.includes('PDF sample'));
  await task.destroy();
  await assert.rejects(createTranslatedPdf({ templatePath:originalPath,sourcePath:extracted.sourcePath,projectRoot,translatedLines:translatedLines.slice(1) }),/one non-empty/);
  assert.deepEqual(await readFile(exported.outputPath),output,'invalid line count must retain previous output');
  const longText='很长的译文'.repeat(500)+'完整末字';
  const longExport=await createTranslatedPdf({ templatePath:originalPath,sourcePath:extracted.sourcePath,projectRoot,translatedLines:translatedLines.map((line,index)=>index===0?longText:line) });
  assert.ok(longExport.pages>exported.pages,'long translated heading must naturally paginate');
  const longLoader=getDocument({data:new Uint8Array(await readFile(longExport.outputPath))}),longPdf=await longLoader.promise;
  try {
    let complete='';for(let number=1;number<=longPdf.numPages;number++)complete+=(await (await longPdf.getPage(number)).getTextContent()).items.filter(item=>'str' in item).map(item=>item.str).join('');
    const continuous=complete.normalize('NFKC').replace(/\s+/gu,'');
    assert.ok(continuous.includes('完整末字'),'the naturally paginated long translation retains its final sentinel');
    // Chromium can choose a shared CJK radical codepoint in ToUnicode (e.g.
    // 长 -> ⻓). Verify each actual printed glyph against the bundled face,
    // while the editable source below verifies the exact requested Unicode.
    const paperFont=fontkit.create(await readFile(new URL('../assets/fonts/NotoSansSC-Regular.ttf',import.meta.url)));
    for(let index=0;index<longText.length;index++)assert.equal(paperFont.glyphForCodePoint(continuous.codePointAt(index)).id,paperFont.glyphForCodePoint(longText.codePointAt(index)).id,`printed long translation keeps source glyph at character ${index+1}`);
    if(process.env.YN_PDF_VISUAL_EVIDENCE){const evidence=path.resolve(process.env.YN_PDF_VISUAL_EVIDENCE);await writeFile(path.join(evidence,'long-translation.pdf'),await readFile(longExport.outputPath));await writeFile(path.join(evidence,'long-translation.html'),await readFile(longExport.htmlPath));for(const number of [1,longPdf.numPages]){const page=await longPdf.getPage(number),viewport=page.getViewport({scale:1.5}),image=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvas:image,canvasContext:image.getContext('2d'),viewport}).promise;await writeFile(path.join(evidence,`long-page-${number}.png`),image.toBuffer('image/png'));}}
  }finally{await longLoader.destroy();}
  const structured=JSON.parse(await readFile(longExport.documentPath,'utf8'));
  assert.equal(structured.nodes.find(node=>node.sourceLines.includes(1)).parts.map(part=>part.text??'').join(''),longText,'editable source retains the exact long translation Unicode');
  assert.equal(structured.sourceHash,layout.sourceHash);assert.equal(structured.originalHash,layout.originalHash);
  assert.ok((await readFile(longExport.htmlPath,'utf8')).includes('contenteditable="true"'),'export persists its editable HTML source');
  assert.deepEqual(await readFile(originalPath),original,'original PDF stays read-only');
  await writeFile(path.join(inputDir,'text.txt'),'Another document.');
  const settings = builtinTaskDefaults({outputDir:projectRoot,sourcePath:inputDir,sourceKind:'folder',fileType:'auto',glossaryCandidates:false,characterBible:false});
  const prepared = await prepareBuiltinTaskDocuments(settings);
  assert.equal(prepared.documents.length,2); assert.equal(prepared.documents.find(doc=>doc.id==='図版.pdf').projection.kind,'pdf-text');
  const manifest = await resolvePiSourceManifest({...request,sourcePath:inputDir,sourceSelection:{kind:'folder',path:inputDir},...prepared.advanced});
  assert.ok(manifest.documents.some(doc=>doc.id==='図版.pdf'));
  const folderTools = createPdfReferenceTools(()=>({...request,sourcePath:inputDir,sourceSelection:{kind:'folder',path:inputDir},...prepared.advanced}),()=>true);
  await assert.rejects(folderTools[0].execute('folder-missing',{fromLine:2,toLine:2}),/documentId/);
  assert.equal(JSON.parse((await folderTools[0].execute('folder-index',{fromLine:2,toLine:2,documentId:'図版.pdf'})).content[0].text).available,true);
  assert.equal((await folderTools[1].execute('folder-image',{id:'p1-image1',sourceLine:2,reason:'See the diagram',documentId:'図版.pdf'})).content[1].type,'image');
  await assert.rejects(prepareBuiltinTaskDocuments(builtinTaskDefaults({...settings,sourcePath:originalPath,sourceKind:'file',translationPath:originalPath})),/aligned translated TXT/);
  const review = await generateBuiltinTaskReview(builtinTaskDefaults({...settings,sourcePath:originalPath,sourceKind:'file',fileType:'pdf'}),'translation','fixture');
  const html = await readFile(review.outputPath,'utf8'); assert.ok(html.includes('id="exportPdf"'));
  const legacy = html.replace(`translation-workshop-line-review-v${LINE_REVIEW_PROTOCOL_VERSION}`,'translation-workshop-line-review-v48');
  await writeFile(review.outputPath,legacy); assert.equal(await upgradeLegacyReviewHtmlTree(review.outputPath),true);
  assert.ok((await readFile(review.outputPath,'utf8')).includes('id="exportPdf"'));
  const moved = path.join(root,'moved'); await cp(projectRoot,moved,{recursive:true});
  const movedSource = path.join(moved,path.relative(projectRoot,extracted.sourcePath));
  const movedOriginal = path.join(moved,path.relative(projectRoot,originalPath));
  assert.equal((await readPdfLayout(movedSource,moved)).originalPath,movedOriginal);
  const movedReview = path.join(moved,path.relative(projectRoot,review.outputPath));
  assert.ok(resolveReviewHtmlPaths(await readFile(movedReview,'utf8'),movedReview).includes(movedOriginal.replace(/\\/g,'\\\\')));
  assert.ok((await createTranslatedPdf({templatePath:movedOriginal,sourcePath:movedSource,projectRoot:moved,translatedLines})).outputPath.startsWith(moved));
  const projectionText = await readFile(extracted.sourcePath,'utf8');
  await writeFile(extracted.sourcePath,'CHANGED PROJECTION');
  await assert.rejects(prepareBuiltinTaskDocuments(builtinTaskDefaults({...settings,sourcePath:originalPath,sourceKind:'file',fileType:'pdf'}),review.outputPath),error=>error.name==='NonRetryableAssignmentError');
  assert.equal(await readFile(extracted.sourcePath,'utf8'),'CHANGED PROJECTION','bound projection drift must be retained, not silently repaired');
  await writeFile(extracted.sourcePath,projectionText);
  const mapPath = extracted.sourcePath+'.pdf-layout.json', mapBytes = await readFile(mapPath);
  await rm(mapPath);
  await assert.rejects(prepareBuiltinTaskDocuments(builtinTaskDefaults({...settings,sourcePath:originalPath,sourceKind:'file',fileType:'pdf'}),review.outputPath),error=>error.name==='RequiredWorkflowFileError');
  await writeFile(mapPath,mapBytes);
  const abort = new AbortController();abort.abort(new Error('fixture cancelled'));
  await assert.rejects(preparePdfDocument(originalPath,path.join(root,'cancelled','.translation-workshop'),{signal:abort.signal}),/cancelled/);
  const midAbort = new AbortController(), cancelledWorkspace = path.join(root,'mid-cancelled','.translation-workshop');
  await assert.rejects(preparePdfDocument(originalPath,cancelledWorkspace,{signal:midAbort.signal,onProgress:()=>midAbort.abort(new Error('mid-extraction cancellation'))}),/mid-extraction cancellation/);
  assert.ok((await readFile(path.join(cancelledWorkspace,'pdf','events.jsonl'),'utf8')).includes('"cancelled"'));
  const image = layout.pages[0].previewPath; await rm(image);
  await assert.rejects(preparePdfDocument(originalPath,workspace),error=>error.name==='RequiredWorkflowFileError','missing warm assets must stop preparation');
  await assert.rejects(readPdfReferenceImage(extracted.sourcePath,projectRoot,'p1-image1',2),error=>error.name==='RequiredWorkflowFileError');
  // Cover artwork is large before clipping, but its visible area is below native text.
  const clipped = await PDFDocument.create(), clippedPage = clipped.addPage([600,800]);
  clippedPage.drawText('Cover title',{x:40,y:650,size:22,font:await clipped.embedFont(StandardFonts.Helvetica)});
  clippedPage.pushOperators(pushGraphicsState(),rectangle(40,40,520,300),clip(),endPath());
  clippedPage.drawImage(await clipped.embedPng(canvas.toBuffer('image/png')),{x:0,y:0,width:600,height:800});
  clippedPage.pushOperators(popGraphicsState());
  const clippedPath = path.join(root,'clipped-cover.pdf'); await writeFile(clippedPath,await clipped.save());
  const clippedProject = path.join(root,'clipped-project');
  const clippedSource = await preparePdfDocument(clippedPath,path.join(clippedProject,'.translation-workshop'));
  const clippedLayout = await readPdfLayout(clippedSource.sourcePath,clippedProject);
  const clippedImage = clippedLayout.references.find(ref=>ref.id==='p1-image1');
  assert.deepEqual([clippedImage.x,clippedImage.y,clippedImage.width,clippedImage.height],[40,460,520,300]);
  assert.equal(clippedSource.text,'Cover title');
  const fullRaster = await PDFDocument.create(), rasterPage = fullRaster.addPage([600,800]);
  rasterPage.drawImage(await fullRaster.embedPng(canvas.toBuffer('image/png')),{x:0,y:0,width:600,height:800});
  rasterPage.drawText('Overlay',{x:40,y:650,size:22,font:await fullRaster.embedFont(StandardFonts.Helvetica)});
  const rasterPath=path.join(root,'raster-overlay.pdf'); await writeFile(rasterPath,await fullRaster.save());
  await assert.rejects(preparePdfDocument(rasterPath,path.join(root,'raster-project','.translation-workshop')),/full-page raster/);
  const scanned = await PDFDocument.create(); const scanPage = scanned.addPage([160,80]);scanPage.drawImage(await scanned.embedPng(canvas.toBuffer('image/png')),{x:0,y:0,width:160,height:80});
  const scanPath = path.join(root,'scan.pdf');await writeFile(scanPath,await scanned.save());
  await assert.rejects(preparePdfDocument(scanPath,path.join(root,'scan-project','.translation-workshop')),/OCR is required/);
  const ocr = await PDFDocument.create(), ocrPage = ocr.addPage([160,80]);
  ocrPage.drawImage(await ocr.embedPng(canvas.toBuffer('image/png')),{x:0,y:0,width:160,height:80});
  ocrPage.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  ocrPage.drawText('Hidden OCR',{x:10,y:40,size:10,font:await ocr.embedFont(StandardFonts.Helvetica)});
  const ocrPath = path.join(root,'ocr.pdf'); await writeFile(ocrPath,await ocr.save());
  await assert.rejects(preparePdfDocument(ocrPath,path.join(root,'ocr-project','.translation-workshop')),/hidden OCR/);
  const colored = await PDFDocument.create(), coloredPage = colored.addPage([600,800]), coloredFont = await colored.embedFont(StandardFonts.Helvetica);
  coloredPage.drawText('Title',{x:40,y:740,size:22,font:coloredFont,color:rgb(1,0,0)});
  coloredPage.drawText('Title',{x:40,y:690,size:22,font:coloredFont,color:rgb(0,0,1)});
  const colorPath = path.join(root,'colors.pdf'); await writeFile(colorPath,await colored.save());
  const colorSource = await preparePdfDocument(colorPath,path.join(root,'color-project','.translation-workshop'));
  assert.deepEqual((await readPdfLayout(colorSource.sourcePath,path.join(root,'color-project'))).blocks.map(block=>block.color),[[1,0,0],[0,0,1]]);
  const narrow = await PDFDocument.create(), narrowPage = narrow.addPage([200,200]);
  narrowPage.drawText('l',{x:40,y:120,size:12,font:await narrow.embedFont(StandardFonts.Helvetica)});
  narrowPage.drawText('11',{x:40,y:60,size:12,font:await narrow.embedFont(StandardFonts.TimesRoman)});
  const narrowPath=path.join(root,'narrow.pdf'), narrowProject=path.join(root,'narrow-project');
  await writeFile(narrowPath,await narrow.save());
  const narrowSource=await preparePdfDocument(narrowPath,path.join(narrowProject,'.translation-workshop'));
  const narrowExport=await createTranslatedPdf({templatePath:narrowPath,sourcePath:narrowSource.sourcePath,projectRoot:narrowProject,translatedLines:['.','11']});
  assert.equal((await PDFDocument.load(await readFile(narrowExport.outputPath))).getPageCount(),1,'short prose and source-native numeric glyphs print naturally on one page');
  console.log('PDF extraction, lazy native images, layout export, move, legacy upgrade and failure boundaries passed');
} finally { if(process.env.YN_PDF_ADAPTATION_KEEP==='1')console.log('retained PDF test fixture '+root);else await rm(root,{recursive:true,force:true}); }

}finally{if(printService)await printService.close();}
