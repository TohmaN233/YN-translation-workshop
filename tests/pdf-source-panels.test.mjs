import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {load} from 'cheerio';
import {preparePdfDocument,fixtureStructurePlan} from './helpers/pdf-structure-backend.mjs';
import {configurePdfStructurePreparation} from '../src/main/pdfStructurePreparation.ts';
import {readPdfLayout,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {buildPdfReflowDocument} from '../src/main/pdfReflowDocument.ts';
import {configurePdfPrintBackend} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

const service=process.versions.electron?undefined:await createNativePdfPrintBackend();if(service)configurePdfPrintBackend(service.backend);
const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-source-panel-'));
const audit={readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true,issues:[]};
configurePdfStructurePreparation(async request=>{
  const read=async name=>{
    const tool=request.tools.find(tool=>tool.name===name),first=JSON.parse((await tool.execute('first',{fromLine:1,toLine:1},request.signal)).content[0].text),rows=[];
    for(let fromLine=1;fromLine<=first.total;fromLine+=500)rows.push(...JSON.parse((await tool.execute('read',{fromLine,toLine:Math.min(first.total,fromLine+499),...(name==='readPdfStructureSource'?{includeGeometry:true}:{})},request.signal)).content[0].text).rows);
    return rows;
  };
  const rows=await read('readPdfStructureSource'),isAudit=request.tools.some(tool=>tool.name==='readPdfPreparedStructure');
  if(isAudit){await read('readPdfPreparedStructure');const {issues,...checks}=audit;await request.tools.find(tool=>tool.name==='submitPdfStructureAudit').execute('panel-audit',{version:1,checks,issues:[]},request.signal);return {sessionId:request.sessionId??'panel-fixture',providerId:'fixture',modelId:'fixture',text:'Audit submitted.'};}
  const marker=request.prompt.includes('Document index: ')?'Document index: ':'Index: ',index=JSON.parse(request.prompt.slice(request.prompt.indexOf(marker)+marker.length).split('\nApplied source-ID plan: ')[0]);
  const plan=fixtureStructurePlan(index,rows);plan.tables=[];
  plan.paragraphs.forEach(paragraph=>{if(paragraph.kind==='table-cell')paragraph.kind='paragraph';});
  return {sessionId:request.sessionId??'panel-fixture',providerId:'fixture',modelId:'fixture',text:isAudit?'Audit submitted.':JSON.stringify(plan)};
});
try {
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Source algorithm example.',{x:40,y:740,size:12,font});
  page.drawText('Algorithm 1: Iterative source steps',{x:80,y:700,size:12,font});
  for(const [number,text,y]of [['1','Initialize the source value.',680],['2','Update the current source value.',660],['3','Return the complete result.',640]]) {
    page.drawText(number,{x:80,y,size:12,font});page.drawText(text,{x:110,y,size:12,font});
  }
  for(const y of [715,625])page.drawLine({start:{x:74,y},end:{x:330,y},thickness:.5,color:rgb(0,0,0)});
  const original=path.join(root,'algorithm.pdf');await writeFile(original,await pdf.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop')),layout=await readPdfLayout(prepared.sourcePath,root);
  assert.equal(layout.structureTables.length,0,'source IDs remain owned after the model declines tabular semantics');
  const frame=layout.pages[0].tableRules[0];assert.equal(frame.evidence,'rules-and-grid');
  assert.equal(frame.paintOperations.length,2,'both original horizontal rule paints remain physically owned');
  const longBody='更新当前源值。'.repeat(240)+'PANEL_TAIL_SENTINEL';
  const targets=layout.blocks.map(block=>block.text.startsWith('Initialize')?'初始化源值。':block.text.startsWith('Update')?longBody:block.text.startsWith('Return')?'返回完整结果。':block.text);
  const exported=await createTranslatedPdf({templatePath:original,sourcePath:prepared.sourcePath,projectRoot:root,translatedLines:targets});
  const document=JSON.parse(await readFile(exported.documentPath,'utf8')),panel=document.nodes.find(node=>node.type==='panel');
  assert.ok(panel);assert.equal(document.nodes.filter(node=>node.type==='table').length,0);
  assert.deepEqual(panel.sourceFrame.paintOperations,frame.paintOperations);assert.deepEqual(panel.sourceFrame.physicalRows,frame.rows);
  assert.deepEqual(panel.cells.flat().flatMap(cell=>cell.sourceLines).sort((a,b)=>a-b),[...new Set(frame.sourceLines.map(line=>layout.blocks.find(block=>block.fragments.includes(line)).line))].sort((a,b)=>a-b));
  for(const label of ['1','2','3']) {
    const row=panel.cells.find(row=>row.some(cell=>cell.sourceLines.some(line=>layout.blocks[line-1].text===label)));
    assert.equal(row.length,2,'source step number stays horizontally adjacent to its editable body');
    assert.ok(row[0].image,'step label remains an original numeric glyph');assert.equal(row[1].type,'paragraph');assert.ok(row[1].parts);
  }
  const $=load(await readFile(exported.htmlPath,'utf8'));
  assert.equal($('.source-panel').length,1);assert.equal($('.source-panel table').length,0);assert.equal($('.source-frame-row').filter((_,row)=>$(row).find('.source-frame-cell').length===2).length,3);
  assert.equal($('.source-panel').text().includes('初始化源值。'),true,'source frame body stays live translated text');
  const loading=getDocument({data:new Uint8Array(await readFile(exported.outputPath)),useSystemFonts:true}),printed=await loading.promise;
  try {
    assert.ok(printed.numPages>1,'editable panel prose grows naturally across pages without a source frame fit cap');
    let text='';for(let page=1;page<=printed.numPages;page++)text+=(await (await printed.getPage(page)).getTextContent()).items.map(item=>item.str).join('').normalize('NFKC');
    assert.match(text,/初始化源值。/u);assert.match(text,/更新当前源值。/u);assert.match(text,/返回完整结果。/u);
    assert.equal(text.split('更新当前源值。').length-1,240,'every long translated panel body fragment survives pagination');assert.match(text,/PANEL_TAIL_SENTINEL/u);
  }finally {await loading.destroy();}
  const asset={dataUrl:'data:image/png;base64,AA==',width:1,height:1},ports={native:async()=>asset,inline:async()=>asset,figure:async()=>asset};
  const partial=structuredClone(layout);partial.structureTables=[{id:'partial',page:1,columnCount:1,rows:[[{physicalLines:[frame.sourceLines[0]],column:0,columnSpan:1}]]}];
  await assert.rejects(buildPdfReflowDocument(partial,targets,ports),/partial table ownership/);
  const captioned=structuredClone(layout);captioned.pages[0].tableRules[0].evidence='caption-and-cells';
  assert.ok((await buildPdfReflowDocument(captioned,targets,ports)).nodes.some(node=>node.type==='panel'),'a machine caption hint does not force table semantics after acceptance');
  const paired=frame.rows.filter(row=>row.length===2),merged=structuredClone(layout),owner=merged.blocks.find(block=>block.fragments.includes(paired[0][1]));
  owner.fragments.push(paired.at(-1)[1]);
  merged.blocks=merged.blocks.filter(block=>block===owner||!block.fragments.includes(paired.at(-1)[1]));
  merged.blocks.forEach((block,index)=>block.line=index+1);
  await assert.rejects(buildPdfReflowDocument(merged,merged.blocks.map(block=>block.text),ports),/spans independently labelled visual rows/);
  const numbered=await PDFDocument.create(),numberedPage=numbered.addPage([600,800]),numberedFont=await numbered.embedFont(StandardFonts.Helvetica);
  numberedPage.drawText('Table 1: Original source results.',{x:40,y:740,size:12,font:numberedFont});
  numberedPage.drawText('Combined source results',{x:80,y:700,size:12,font:numberedFont});
  for(const [text,x,y]of [['alpha',80,680],['first result',220,680],['beta',80,660],['second result',220,660]])numberedPage.drawText(text,{x,y,size:12,font:numberedFont});
  for(const y of [715,645])numberedPage.drawLine({start:{x:74,y},end:{x:330,y},thickness:.5,color:rgb(0,0,0)});
  const numberedPath=path.join(root,'numbered.pdf');await writeFile(numberedPath,await numbered.save());
  const numberedPrepared=await preparePdfDocument(numberedPath,path.join(root,'.translation-workshop')),numberedLayout=await readPdfLayout(numberedPrepared.sourcePath,root);
  assert.equal(numberedLayout.structureTables.length,0);assert.equal(numberedLayout.pages[0].tableRules[0].evidence,'caption-and-cells','the real numbered source yields a mechanical table hint');
  const caption=numberedLayout.blocks.find(block=>block.text.startsWith('Table 1:'));
  const numberedTargets=numberedLayout.blocks.map(block=>block===caption?'表 1：可译的源说明。':block.text==='first result'?'第一项结果。':block.text==='second result'?'第二项结果。':block.text);
  const numberedExport=await createTranslatedPdf({templatePath:numberedPath,sourcePath:numberedPrepared.sourcePath,projectRoot:root,translatedLines:numberedTargets});
  const numberedDocument=JSON.parse(await readFile(numberedExport.documentPath,'utf8')),numberedPanel=numberedDocument.nodes.find(node=>node.type==='panel');
  assert.ok(numberedPanel);assert.equal(numberedDocument.nodes.filter(node=>node.type==='table').length,0);
  assert.deepEqual(numberedPanel.sourceFrame.paintOperations,numberedLayout.pages[0].tableRules[0].paintOperations);
  assert.ok(!numberedPanel.cells.flat().some(cell=>cell.sourceLines.includes(caption.line)),'the caption keeps its independent source owner');
  const numberedHtml=load(await readFile(numberedExport.htmlPath,'utf8'));
  assert.equal(numberedHtml(`#L${caption.line}`).parents('.source-panel').length,0);assert.equal(numberedHtml(`#L${caption.line}`).text(),'表 1：可译的源说明。');
  const numberedLoading=getDocument({data:new Uint8Array(await readFile(numberedExport.outputPath)),useSystemFonts:true}),numberedPrinted=await numberedLoading.promise;
  try {const text=(await (await numberedPrinted.getPage(1)).getTextContent()).items.map(item=>item.str).join('').normalize('NFKC');assert.match(text,/表\s*1:可译的源说明。/u);assert.match(text,/第一项结果。/u);assert.match(text,/第二项结果。/u);}finally {await numberedLoading.destroy();}
  console.log('Declined ruled-grid and numbered-caption table hints preserve editable source panels and independent captions through real Chromium, with unsafe render ownership rejected');
}finally {try {await rm(root,{recursive:true,force:true});}finally {await service?.close();}}
