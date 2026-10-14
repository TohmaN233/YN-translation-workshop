import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makePdfLogicalDocument} from '../src/main/pdfLogicalDocument.ts';
import {pdfProtectionHash,validatePdfLayout,PDF_LAYOUT_VERSION,PDF_EXTRACTOR_REVISION,pdfBlockPages} from '../src/main/pdfTypes.ts';
import {buildPdfReflowDocument} from '../src/main/pdfReflowDocument.ts';
import {pdfSourceTables} from '../src/main/pdfSourceTables.ts';
const hash=text=>createHash('sha256').update(text).digest('hex');
const box={x:40,y:50,width:400,height:14};
const prose=(text,page=1,extra={})=>({...box,line:0,page,text,fontSize:11,segmentation:'paragraph',inlineProtections:[],proseSegments:[{text,boxes:[{...box}]}],...extra});
const math=(text,page=1)=>({...box,line:0,page,text,fontSize:11,segmentation:'protected',protection:'math',paintOperations:[20],sourceInkBox:{...box}});
function layout(rows){
  rows.forEach((block,index)=>block.line=index+1);
  return {version:PDF_LAYOUT_VERSION,extractorRevision:PDF_EXTRACTOR_REVISION,originalPath:'/source.pdf',originalHash:hash('original'),sourcePath:'/source.txt',sourceHash:hash(rows.map(r=>r.text).join('\n')),protectionHash:'',references:[],figureGroups:[],blocks:rows,
    pages:Array.from({length:Math.max(...rows.map(r=>r.page))},(_,index)=>({page:index+1,width:600,height:800,backgroundPath:'/background.png',backgroundHash:hash('bg'),previewPath:'/preview.png',previewHash:hash('preview'),graphicOperations:[]}))};
}
function finish(value){value.sourceHash=hash(value.blocks.map(r=>r.text).join('\n'));value.protectionHash=pdfProtectionHash(value);validatePdfLayout(value);return value;}
const folio=prose('1',1,{x:290,y:750,width:8,sourceInkBox:{x:290,y:750,width:8,height:14},sourceInkPath:'/folio.png',sourceInkHash:hash('folio')});
const cross=layout([prose('This full sentence continues'),folio,prose('on the next page without repetition.',2)]);
makePdfLogicalDocument(cross);finish(cross);
assert.equal(cross.blocks.length,2);assert.equal(cross.blocks[0].text,'This full sentence continues on the next page without repetition.');
assert.deepEqual(cross.blocks[0].fragments,[1,3]);assert.deepEqual(pdfBlockPages(cross,cross.blocks[0]),[1,2]);
assert.deepEqual(cross.blocks[0].proseSegments[0].boxes.map(b=>b.page),[1,2]);
const complete=layout([prose('A complete paragraph starts'),prose('and continues across visual rows'),prose('before the page boundary'),folio,
  prose('and resumes on the next page',2),prose('with its entire final visual row.',2)]);
complete.blocks[3].line=4;complete.mechanicalParagraphs=[[1,2,3],[4],[5,6]];
const completePhysical=structuredClone(complete.blocks);
makePdfLogicalDocument(complete);finish(complete);
assert.deepEqual(complete.blocks[0].fragments,[1,2,3,5,6],'cross-page continuation joins complete same-page owners');
assert.deepEqual(complete.physicalBlocks,completePhysical,'mechanical grouping preserves every raw source property');
const floatContinuation=kind=>{
  const value=layout([prose('A paragraph starts'),prose('and continues across a source page'),folio,
    prose(`${kind} 1: A complete caption starts`,2),prose('and continues on its second visual row.',2),
    prose('Left',2,{x:70,y:100,width:30,segmentation:'parallel-region'}),prose('Right',2,{x:200,y:100,width:35,segmentation:'parallel-region'}),
    prose('with the real continuation after the float',2),prose('and all of its final words.',2)]);
  value.mechanicalParagraphs=[[1,2],[3],[4,5],[6],[7],[8,9]];
  value.references=[{id:'float',page:2,x:40,y:40,width:300,height:40,captionLine:4,caption:value.blocks[3].text}];
  if(kind==='Figure'){
    value.references[0]={...value.references[0],id:'p2-image1',x:40,y:10,width:100,height:20};
    value.references.push({...value.references[0],id:'p2-image2',x:180});
    value.figureGroups=[{id:'figure-group',page:2,x:40,y:10,width:240,height:20,referenceIds:['p2-image1','p2-image2'],physicalLines:[],captionLine:4}];
  }
  return value;
};
const tableFloat=floatContinuation('Table');makePdfLogicalDocument(tableFloat);finish(tableFloat);
assert.deepEqual(tableFloat.blocks[0].fragments,[1,2,8,9],'complete table captions and cells do not interrupt a cross-page body continuation');
assert.deepEqual(tableFloat.blocks.find(block=>block.text.startsWith('Table')).fragments,[4,5]);
assert.equal(tableFloat.references[0].captionLine,3,'physical caption references remap to the complete logical caption owner');
const figureFloat=floatContinuation('Figure');
// A figure has no table cells. Its caption alone interrupts the continuation.
figureFloat.blocks.splice(5,2);figureFloat.blocks.forEach((block,index)=>block.line=index+1);figureFloat.mechanicalParagraphs=[[1,2],[3],[4,5],[6,7]];
makePdfLogicalDocument(figureFloat);finish(figureFloat);
assert.deepEqual(figureFloat.blocks[0].fragments,[1,2,6,7],'actual figure-caption associations preserve wrapped caption ownership');
assert.deepEqual(figureFloat.blocks.find(block=>block.text.startsWith('Figure')).fragments,[4,5]);
assert.equal(figureFloat.figureGroups[0].captionLine,figureFloat.references[0].captionLine);
const hintedDisplay=layout([prose('The complete preceding paragraph'),prose('defines its quantity as'),math('x + y'),
  prose('and the following paragraph continues'),prose('through its final visual source line.')]);
hintedDisplay.mechanicalParagraphs=[[1,2],[3],[4,5]];makePdfLogicalDocument(hintedDisplay);finish(hintedDisplay);
assert.deepEqual(hintedDisplay.blocks[0].fragments,[1,2,3,4,5],'display connection consumes complete owners on both sides');
assert.deepEqual(hintedDisplay.blocks[0].inlineProtections[0].physicalLines,[3]);
for(const following of [[],[prose('An independent complete sentence.')]]) {
  const terminal=layout([prose('The resulting relation is'),math('x = y'),math('(2)'),...following]);
  const original=structuredClone(terminal.blocks);makePdfLogicalDocument(terminal);finish(terminal);
  assert.deepEqual(terminal.physicalBlocks,original,'attaching a terminal display preserves all original glyph/path geometry');
  assert.deepEqual(terminal.blocks[0].fragments,[1,2,3],'a display completes its unfinished prose owner without requiring a lowercase following paragraph');
  assert.deepEqual(terminal.blocks[0].inlineProtections[0].physicalLines,[2,3]);
  assert.deepEqual(terminal.blocks[0].proseSegments.at(-1),{text:'',boxes:[]},'a terminal display retains a valid empty trailing prose segment');
  assert.equal(terminal.blocks.length,following.length+1,'uppercase following prose remains independent');
}
const chainedDisplay=layout([prose('The first quantity is'),math('x = y'),prose('and its consequence is'),math('y = z'),prose('An independent sentence follows.')]);
const chainedPhysical=structuredClone(chainedDisplay.blocks);makePdfLogicalDocument(chainedDisplay);finish(chainedDisplay);
assert.deepEqual(chainedDisplay.blocks[0].fragments,[1,2,3,4],'lowercase connecting prose can accumulate another terminal display');
assert.deepEqual(chainedDisplay.blocks[0].inlineProtections.map(node=>node.physicalLines),[[2],[4]]);
assert.equal(chainedDisplay.blocks[0].text,`The first quantity is${chainedDisplay.blocks[0].inlineProtections[0].token}and its consequence is${chainedDisplay.blocks[0].inlineProtections[1].token}`);
assert.deepEqual(chainedDisplay.physicalBlocks,chainedPhysical);
for(const rows of [
  [prose('A completed sentence.'),math('x = y')],
  [prose('An unfinished lead-in'),{...math('print(x)'),protection:'code'}],
  [prose('An unfinished lead-in'),math('x = y',2)],
  [prose('1 A heading'),math('x = y')],
]) {const independentDisplay=layout(rows);makePdfLogicalDocument(independentDisplay);finish(independentDisplay);assert.equal(independentDisplay.blocks.length,2,'complete sentences, headings, code and cross-page native owners remain separate');}
const tableDisplay=layout([prose('An unfinished table cell'),math('x = y')]);
tableDisplay.pages[0].tableRules=[{id:'native-table',page:1,firstSourceLine:1,sourceLines:[1,2],rows:[[1,2]],box,paintOperations:[],horizontalRuleOperations:[],evidence:'caption-and-cells'}];
makePdfLogicalDocument(tableDisplay);finish(tableDisplay);assert.equal(tableDisplay.blocks.length,2,'table cell ownership cannot be swallowed by a display lead-in');
const floatDisplay=layout([prose('An unfinished body'),math('(a)')]);
floatDisplay.references=[{id:'p1-image1',page:1,...box},{id:'p1-image2',page:1,...box}];floatDisplay.figureGroups=[{id:'native-label',page:1,...box,referenceIds:['p1-image1','p1-image2'],physicalLines:[2]}];
// Native figure labels have an owner even when their figure has no caption.
makePdfLogicalDocument(floatDisplay);finish(floatDisplay);assert.equal(floatDisplay.blocks.length,2,'associated float source cannot become a prose display');
const cellHints=layout([prose('Cell one',1,{segmentation:'parallel-region'}),prose('Cell two',1,{x:200,segmentation:'parallel-region'}),prose('3',1,{sourceInkPath:'/numeric.png',sourceInkHash:hash('3'),sourceInkBox:{...box}}),prose('Body after a native numeric asset.')]);
cellHints.mechanicalParagraphs=[[1,2],[3,4]];cellHints.pages[0].tableRules=[{id:'source-table',page:1,firstSourceLine:1,sourceLines:[1,2],rows:[[1,2]],box,paintOperations:[],horizontalRuleOperations:[],evidence:'caption-and-cells'}];
makePdfLogicalDocument(cellHints);finish(cellHints);assert.deepEqual(cellHints.blocks.map(block=>block.fragments),[[1],[2],[3],[4]],'table cells and immutable numeric glyph assets retain independent ownership');
for(const hints of [[[1],[1]],[[1]],[[1],[3]]]){const invalid=layout([prose('one'),prose('two')]);invalid.mechanicalParagraphs=hints;assert.throws(()=>makePdfLogicalDocument(invalid),/repeat|invent|omit/);}
const independent=layout([prose('Completed sentence.'),prose('another paragraph.',2),prose('A fragment'),prose('a distinct font paragraph.',2,{fontSize:9})]);
makePdfLogicalDocument(independent);finish(independent);assert.equal(independent.blocks.length,4);
const display=layout([prose('We define the value as'),math('x + y'),math('(1)'),prose('and use it in this full sentence.'),prose('Independent formula follows.'),math('a + b')]);
makePdfLogicalDocument(display);finish(display);
assert.equal(display.blocks.length,3);assert.deepEqual(display.blocks[0].fragments,[1,2,3,4]);
const node=display.blocks[0].inlineProtections[0];assert.equal(node.kind,'math');assert.deepEqual(node.physicalLines,[2,3]);
assert.equal(display.blocks[0].text,`We define the value as${node.token}and use it in this full sentence.`);
const assets={inline:async()=>{throw Error('Display formula must use physical native rows');},native:async(page,rows)=>{assert.equal(page,1);assert.ok(rows.length);return {dataUrl:'data:image/png;base64,fixture',width:40,height:20};},figure:async()=>{throw Error('No figures');}};
const document=await buildPdfReflowDocument(display,display.blocks.map(r=>r.text),assets);
assert.equal(document.nodes[0].parts[1].image.display,true);assert.deepEqual(document.nodes.flatMap(n=>n.sourceLines),[1,2,3]);
for(const mutation of [
  value=>value.blocks[0].fragments.push(2),
  value=>value.blocks[0].fragments.reverse(),
  value=>value.blocks[0].inlineProtections[0].physicalLines=[2],
  value=>value.blocks[0].proseSegments[0].boxes[0].x++,
  value=>value.blocks[0].inlineProtections[0].kind='code',
]){const damaged=structuredClone(display);mutation(damaged);damaged.protectionHash=pdfProtectionHash(damaged);assert.throws(()=>validatePdfLayout(damaged),/PDF/);}
const tagged=prose('Before {{formula:p1:1}} after.');
tagged.inlineProtections=[{...box,token:'{{formula:p1:1}}',text:'x',kind:'math',paintOperations:[10],paintSpans:[{operator:10,start:0,end:1}],inkBox:{...box}}];
tagged.proseSegments=[{text:'Before ',boxes:[{...box}]},{text:' after.',boxes:[{...box}]}];
const inline=layout([tagged]);makePdfLogicalDocument(inline);finish(inline);
const corrupt=structuredClone(inline);corrupt.blocks[0].inlineProtections[0].paintSpans[0].end=2;corrupt.protectionHash=pdfProtectionHash(corrupt);
assert.throws(()=>validatePdfLayout(corrupt),/physical source/);
const tableSource=layout([prose('Table 5: Results.'),prose('Subset       Accuracy',1,{x:70,width:260}),
  prose('aho',1,{x:60,y:100,width:30,segmentation:'parallel-region'}),prose('0.844',1,{x:200,y:100,width:35,segmentation:'parallel-region'}),
  prose('bcd',1,{x:60,y:120,width:30,segmentation:'parallel-region'}),prose('0.511',1,{x:200,y:120,width:35,segmentation:'parallel-region'})]);
makePdfLogicalDocument(tableSource);finish(tableSource);assert.equal(pdfSourceTables(tableSource.blocks)[0].headerLine,2);
const tableDocument=await buildPdfReflowDocument(tableSource,tableSource.blocks.map(b=>b.text),assets);
assert.equal(tableDocument.nodes[1].type,'table');assert.deepEqual(tableDocument.nodes[1].cells.map(row=>row.map(cell=>cell.sourceLines[0])),[[2],[3,4],[5,6]]);
console.log('Cross-page source ownership, display formula sentences, independent regions, exact source geometry and tamper guards pass');
