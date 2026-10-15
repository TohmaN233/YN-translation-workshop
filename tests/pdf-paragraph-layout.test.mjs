import assert from 'node:assert/strict';
import {pdfTextBlocks,pdfParagraphStructure} from '../src/main/pdfLayout.ts';
import {splitPdfInlineTranslation} from '../src/shared/validation/pdfPreservation.ts';
import {validateTranslationCandidate} from '../src/shared/validation/translationValidator.ts';
import {validateProofreadReplacement} from '../src/shared/validation/proofreadReplacement.ts';
const item=(str,x,y,width,size=11)=>({str,transform:[size,0,0,size,x,y+size],width,height:size,dir:'ltr',hasEOL:true,color:[0,0,0]});
const viewport={transform:[1,0,0,1,0,0]};
const list=pdfTextBlocks([
  item('(4) At dusk, the keeper winds the beacon and checks the harbor gate.',20,40,430),
  item('The brass key stays with the night courier.',38,58,360),
  item('A second check confirms the bell is audible.',38,76,340),
  item('(5) The next message waits beside the tide clock.',20,112,360)
],viewport,2);
assert.equal(list.length,2,'a hanging list paragraph is one translation unit; the next item remains independent');
assert.ok(list[0].text.endsWith('audible.'));
assert.ok(list[0].height>40,'paragraph export owns the complete multiline box');
assert.equal(list[0].proseSegments[0].boxes.length,3,'all synthetic flow areas remain ordered');
const prose=pdfTextBlocks([
  item('The lantern keeper marked the harbor har-',40,150,390),
  item('bor before the fog rolled in.',20,168,420),
  item('The route ledger records the quiet crossing.',20,186,150),
  item('A new paragraph begins beside the old bell.',40,204,360)
],viewport,2);
assert.equal(prose.length,2,'first-line indentation must not split a continuation or join a new paragraph');
assert.ok(!prose[0].text.includes('har- bor'),'a physical hyphenation break must not insert a word-internal space');
const columns=pdfTextBlocks([item('The north pier ledger continues',20,40,180),item('through the morning watch.',20,58,150),
  item('The south pier keeps a separate log.',270,46,180),item('Its next entry arrives at dusk.',270,64,170)],viewport,1);
assert.equal(columns.length,2);assert.ok(!columns[0].text.includes('south'));
const cells=pdfTextBlocks([item('North pier: lantern checked',20,100,180),item('East pier: bell checked',270,100,180),
  item('North pier: gate secured',20,118,180),item('East pier: tide recorded',270,118,180)],viewport,1);
assert.equal(cells.length,4,'parallel synthetic table cells are independent');
const columnMajor=[item('North pier: lantern checked',20,100,180),item('North pier: gate secured',20,118,180),
  item('East pier: bell checked',270,100,180),item('East pier: tide recorded',270,118,180)];
assert.equal(pdfTextBlocks(columnMajor,viewport,1).length,4,'ambiguous parallel areas stay independent in column-major paint order too');
const narrow=pdfTextBlocks([item('A narrow harbor',20,150,100),item('note continues for',20,168,100),item('three short rows.',20,186,80)],viewport,1);
assert.equal(narrow.length,1,'narrow prose has no minimum width prerequisite');
const structure={role:'Document',children:[{role:'P',children:[{type:'content',id:'north'}]},{role:'P',children:[{type:'content',id:'south'}]}]};
const tagged=pdfParagraphStructure({items:[{type:'beginMarkedContentProps',id:'north'},...columnMajor.slice(0,2),{type:'endMarkedContent'},
  {type:'beginMarkedContentProps',id:'south'},...columnMajor.slice(2),{type:'endMarkedContent'}]},structure);
assert.equal(pdfTextBlocks(tagged.items,viewport,1).length,2,'native paragraph scopes disambiguate aligned columns');
const tableTree={role:'Document',children:['cell-a','cell-b','cell-c','cell-d'].map(id=>({role:'TD',children:[{type:'content',id}]}))};
const table=pdfParagraphStructure({items:columnMajor.flatMap((row,index)=>[{type:'beginMarkedContentProps',id:['cell-a','cell-b','cell-c','cell-d'][index]},row,{type:'endMarkedContent'}])},tableTree);
assert.equal(pdfTextBlocks(table.items,viewport,1).length,4,'native table cells never merge across scope boundaries');
const rowMajorTree={role:'Document',children:[{role:'P',children:[{type:'content',id:'north-a'},{type:'content',id:'north-b'}]},
  {role:'P',children:[{type:'content',id:'south-a'},{type:'content',id:'south-b'}]}]};
const rowMajor=[columnMajor[0],columnMajor[2],columnMajor[1],columnMajor[3]].flatMap((row,index)=>[
  {type:'beginMarkedContentProps',id:['north-a','south-a','north-b','south-b'][index]},row,{type:'endMarkedContent'}]);
const rowMajorBlocks=pdfTextBlocks(pdfParagraphStructure({items:rowMajor},rowMajorTree).items,viewport,1);
assert.equal(rowMajorBlocks.length,2,'authoritative paragraph ownership gathers nonadjacent paint runs');
assert.ok(rowMajorBlocks[0].text.includes('North pier: gate'));assert.ok(!rowMajorBlocks[0].text.includes('East pier'));
const listTree={role:'Document',children:[{role:'LI',children:[{role:'Lbl',children:[{type:'content',id:'number'}]},
  {role:'LBody',children:[{role:'P',children:[{type:'content',id:'body'},{type:'content',id:'body-continuation'}]}]}]}]};
const listContent={items:[{type:'beginMarkedContentProps',id:'number'},item('(1)',20,40,15),{type:'endMarkedContent'},
  {type:'beginMarkedContentProps',id:'body'},item('The courier leaves a sealed note.',40,40,220),{type:'endMarkedContent'},
  {type:'beginMarkedContentProps',id:'body-continuation'},item('It reaches the lighthouse at dawn.',40,58,220),{type:'endMarkedContent'}]};
assert.equal(pdfTextBlocks(pdfParagraphStructure(listContent,listTree).items,viewport,1).length,1,'LI label and first LBody paragraph share one complete item');
const nested=pdfTextBlocks([item('(1) The keeper sends a message over two lines.',20,40,230),item('The courier reads it at the gate.',38,58,200),
  item('(a) A smaller note stays in the ledger.',38,76,220),item('Its final line names the north pier.',56,94,210)],viewport,1);
assert.equal(nested.length,2);
const mixed=pdfTextBlocks([item('The route ',20,40,70),{...item('a + b',92,40,35),protection:'math',paintOperations:[2]},
  item(' ends at the beacon after a clear crossing',130,40,280),item('which remains visible through the morning fog.',20,58,340)],viewport,1);
assert.equal(mixed.length,1);assert.equal(mixed[0].inlineProtections.length,1);
assert.ok(mixed[0].text.endsWith('morning fog.'));assert.equal(mixed[0].proseSegments[1].boxes.length,2);
const source='The route {{formula:p7:1}} passes {{formula:p7:2}} the beacon.';
const valid='路线 {{formula:p7:1}} 经过 {{formula:p7:2}} 灯塔。';
assert.deepEqual(splitPdfInlineTranslation(source,valid),['路线 ',' 经过 ',' 灯塔。']);
const reordered='路线 {{formula:p7:2}} 经过 {{formula:p7:1}} 灯塔。';
assert.deepEqual(splitPdfInlineTranslation(source,reordered),['路线 ',' 经过 ',' 灯塔。']);
assert.equal(validateTranslationCandidate(source,reordered,{extractPlaceholders:()=>[],extractTags:()=>[],detectUntranslated:false}).ok,true);
assert.equal(validateProofreadReplacement(source,reordered,{extractPlaceholders:()=>[]}).length,0);
for(const candidate of [valid.replace('{{formula:p7:1}}',''),valid.replace('p7:1','p8:1'),valid+'{{formula:p7:1}}',
  valid.replace('p7:1','p7:2'), '{{formula:p7:1}}{{formula:p7:2}}']) {
  assert.throws(()=>splitPdfInlineTranslation(source,candidate));
  assert.ok(validateTranslationCandidate(source,candidate,{extractPlaceholders:()=>[],extractTags:()=>[],detectUntranslated:false}).blocking.some(f=>f.code==='pdf_protected_content_mismatch'));
  assert.ok(validateProofreadReplacement(source,candidate,{extractPlaceholders:()=>[]}).length,'proofreading must preserve marker identity/count/paragraph ownership and prose');
}
assert.throws(()=>splitPdfInlineTranslation('ordinary prose','路线 {{formula:p7:1}}'));
console.log('ok synthetic PDF paragraphs preserve indents, ownership, and inline identity');
