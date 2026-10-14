import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pdfNativePlacement,pdfNativePlacementEvidence} from '../src/main/pdfNativePlacement.ts';
import {makePdfLogicalDocument} from '../src/main/pdfLogicalDocument.ts';
import {applyPdfStructurePlan} from '../src/main/pdfStructurePlan.ts';
import {buildPdfReflowDocument} from '../src/main/pdfReflowDocument.ts';
import {PDF_LAYOUT_VERSION,PDF_EXTRACTOR_REVISION,pdfProtectionHash,validatePdfLayout} from '../src/main/pdfTypes.ts';

const hash=text=>createHash('sha256').update(text).digest('hex');
const retained=JSON.parse(await readFile(new URL('./pdf-native-placement-fixtures.json',import.meta.url),'utf8'));
const box={x:40,y:90,width:170,height:14};
const prose=(text,extra={})=>({...box,line:0,page:1,text,fontSize:11,baseline:101,columnX:40,inlineProtections:[],proseSegments:[{text,boxes:[{...box,...extra}]}],...extra});
const math=(extra={})=>({...box,line:0,page:1,text:'x/y',fontSize:11,protection:'math',paintOperations:[20],...extra});
function source(rows,hints) {
  rows.forEach((row,index)=>row.line=index+1);
  return {version:PDF_LAYOUT_VERSION,extractorRevision:PDF_EXTRACTOR_REVISION,originalHash:retained.originalHash,originalPath:'/source.pdf',sourcePath:'/source.txt',sourceHash:hash(rows.map(row=>row.text).join('\n')),protectionHash:'',blocks:rows,references:[],figureGroups:[],mechanicalParagraphs:hints,
    pages:Array.from({length:Math.max(...rows.map(row=>row.page))},(_,index)=>({page:index+1,width:600,height:850,previewPath:'/preview.png',previewHash:hash('preview'),backgroundPath:'/background.png',backgroundHash:hash('background'),graphicOperations:[]}))};
}
function seal(layout){layout.sourceHash=hash(layout.blocks.map(row=>row.text).join('\n'));layout.protectionHash=pdfProtectionHash(layout);validatePdfLayout(layout);}
for(const fixture of retained.fixtures) {
  const rows=structuredClone(fixture.rows),local=id=>fixture.ids.indexOf(id)+1;
  const hints=fixture.name==='formula-only wrapped tail'?[[1,2],[3],[4]]:rows.map((_,index)=>[index+1]);
  const layout=source(rows,hints),raw=structuredClone(rows),native=local(fixture.native);
  assert.equal(pdfNativePlacement(rows,[native]),'inline',fixture.name);
  makePdfLogicalDocument(layout);seal(layout);
  assert.deepEqual(layout.physicalBlocks,raw,'geometry inference cannot change native source text/paint/boxes');
  const owner=layout.blocks.find(block=>block.fragments.includes(native));
  assert.ok(fixture.join.map(local).every(id=>owner.fragments.includes(id)),`${fixture.name}: complete inline owner`);
  const node=owner.inlineProtections.find(node=>node.physicalLines?.includes(native));
  assert.equal(node.placement,'inline');assert.deepEqual(node.physicalLines,[native]);
  assert.deepEqual(node.paintOperations,raw[native-1].paintOperations);
  const plan={version:1,paragraphs:layout.blocks.map(block=>({physicalLines:block.fragments,kind:block.protection?'preserved':'paragraph',reason:'Retained source geometry.'})),tables:[],audit:{readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true,issues:[]}};
  const applied=applyPdfStructurePlan(layout,plan).layout;
  assert.equal(applied.blocks.find(block=>block.fragments.includes(native)).inlineProtections.find(node=>node.physicalLines?.includes(native)).placement,'inline','plan rebuilding uses the same raw placement evidence');
  const nativeCalls=[],assets={inline:async()=>({dataUrl:'data:image/png;base64,fixture',width:10,height:10}),native:async(page,ids)=>{nativeCalls.push(ids);return {dataUrl:'data:image/png;base64,fixture',width:26,height:25};},figure:async()=>{throw Error('No source figure');}};
  const document=await buildPdfReflowDocument(applied,applied.blocks.map(block=>block.text),assets);
  const parts=document.nodes.flatMap(node=>node.parts??[]).filter(part=>part.token===node.token);
  assert.equal(parts.length,1);assert.equal(parts[0].image.display,false,'native source-row ownership does not force a block display image');
  assert.ok(nativeCalls.some(ids=>JSON.stringify(ids)===JSON.stringify([native])),'IR keeps the exact original native source rows');
}

const sameBaseline=()=>[prose('A fraction is'),math({x:213,y:82,width:24,height:25,baseline:93}),prose('-weighted.',{x:240,width:170})];
let rows=source(sameBaseline()).blocks;
assert.deepEqual(pdfNativePlacementEvidence(rows,[2]),{placement:'inline',continuationPhysicalLine:3});
for(const mutate of [
  value=>{value[2].x=350;}, // real gutter between independent columns
  value=>{value[2].baseline+=16;},
  value=>{value[1].sourceScope='TD:2';value[0].sourceScope='TD:1';},
  value=>{value[2].sourceScope='P:other';},
  value=>{value[1].height=70;},
]){rows=source(sameBaseline()).blocks;mutate(rows);assert.equal(pdfNativePlacement(rows,[2]),'display','column/cell/multiline evidence cannot be relaxed into inline');}

const wrapped=()=>[prose('A preceding body line',{y:74,baseline:85}),prose('A full unfinished line',{y:90,baseline:101}),math({x:40,y:106,width:35,height:14,baseline:117,columnX:40})];
rows=source(wrapped()).blocks;assert.equal(pdfNativePlacement(rows,[3]),'inline');
for(const mutate of [value=>{value[2].x=95;},value=>{value[1].text='A complete sentence.';},value=>{value[2].baseline=135;},value=>{value[1].width=70;},value=>{value[2].columnX=260;},value=>{value[2].height=45;},
  value=>{value[2].x=62;value[2].columnX=62;}, // independently indented list/native line
  value=>{value[2].sourceScope='P:new';value[1].sourceScope='P:body';}, // tagged new paragraph
]) {
  rows=source(wrapped()).blocks;mutate(rows);assert.equal(pdfNativePlacement(rows,[3]),'display','centered, separated, multiline and independent formulas remain display');
}
const displayLayout=source([prose('An unfinished definition'),math({x:250,y:130,width:90,height:14,baseline:141,columnX:250})]);
makePdfLogicalDocument(displayLayout);seal(displayLayout);
assert.equal(displayLayout.blocks[0].inlineProtections[0].placement,'display');
const forged=structuredClone(displayLayout);forged.blocks[0].inlineProtections[0].placement='inline';forged.protectionHash=pdfProtectionHash(forged);
assert.throws(()=>validatePdfLayout(forged),/inline placement lacks original source geometry/);
delete displayLayout.blocks[0].inlineProtections[0].placement;seal(displayLayout);
const legacy=await buildPdfReflowDocument(displayLayout,displayLayout.blocks.map(block=>block.text),{native:async()=>({dataUrl:'data:image/png;base64,fixture',width:90,height:14}),inline:async()=>{throw Error('No inline token');},figure:async()=>{throw Error('No figure');}});
assert.equal(legacy.nodes[0].parts[1].image.display,true,'old physical-backed markers without placement retain display compatibility');
console.log('PDF native placement: retained wrap/fraction geometry, full source/native ownership, plan/IR inline rendering, true columns/cells/display boundaries and legacy compatibility PASS.');
