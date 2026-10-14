import assert from 'node:assert/strict';
import {pdfTextBlocks,pdfParagraphStructure} from '../src/main/pdfLayout.ts';
import {splitPdfInlineTranslation} from '../src/shared/validation/pdfPreservation.ts';
import {validateTranslationCandidate} from '../src/shared/validation/translationValidator.ts';
import {validateProofreadReplacement} from '../src/shared/validation/proofreadReplacement.ts';
const item=(str,x,y,width,size=10.9091)=>({str,transform:[size,0,0,size,x,y+size],width,height:size,dir:'ltr',hasEOL:true,color:[0,0,0]});
const viewport={transform:[1,0,0,1,0,0]};
const list=pdfTextBlocks([
  item('(4) We describe an implementation of CBD and FW-CBD and report experiments on overlapping',74.409,559.7199,446.46294),
  item('handwriting and briefly examine clustering by reusing band contributions.',92.584,575.9789,428.28222),
  item('on character trajectories.',92.584,592.2379,110),
  item('(5) This is a separate list item.',74.409,617.4629,300)
],viewport,2);
assert.equal(list.length,2,'a hanging list paragraph is one translation unit; the next item remains independent');
assert.ok(list[0].text.endsWith('on character trajectories.'));
assert.ok(list[0].height>40,'paragraph export owns the complete multiline box');
assert.equal(list[0].proseSegments[0].boxes.length,3,'all visual flow areas remain ordered');
const prose=pdfTextBlocks([
  item('The rest of the paper is organized as follows. Section 2 reviews the back-',91.346,633.7219,431.3),
  item('ground and introduces the curve space.',74.409,649.9809,448.2),
  item('Section 3 introduces the method.',74.409,666.2399,180),
  item('A new paragraph begins with a first-line indent.',91.346,682.4989,420)
],viewport,2);
assert.equal(prose.length,2,'first-line indentation must not split a continuation or join a new paragraph');
assert.ok(!prose[0].text.includes('back- ground'),'a physical hyphenation break must not insert a word-internal space');
const columns=pdfTextBlocks([item('Left column prose starts here and continues',30,40,180),item('in the next visual row.',30,56,120),
  item('Right column stays independent of left.',270,46,180),item('Its next row completes the paragraph.',270,62,170)],viewport,1);
assert.equal(columns.length,2);assert.ok(!columns[0].text.includes('Right'));
const cells=pdfTextBlocks([item('Long left table cell with labels',30,40,180),item('Long right table cell with labels',270,40,180),
  item('Another left table cell with labels',30,56,180),item('Another right table cell with labels',270,56,180)],viewport,1);
assert.equal(cells.length,4,'parallel table cells are independent');
const columnMajor=[item('Long left table cell with labels',30,40,180),item('Another left table cell with labels',30,56,180),
  item('Long right table cell with labels',270,40,180),item('Another right table cell with labels',270,56,180)];
assert.equal(pdfTextBlocks(columnMajor,viewport,1).length,4,'ambiguous parallel table areas stay independent in column-major paint order too');
const narrow=pdfTextBlocks([item('Narrow paragraph',30,40,100),item('continues on three',30,56,100),item('visual lines.',30,72,65)],viewport,1);
assert.equal(narrow.length,1,'narrow prose has no minimum width prerequisite');
const structure={role:'Document',children:[{role:'P',children:[{type:'content',id:'left'}]},{role:'P',children:[{type:'content',id:'right'}]}]};
const tagged=pdfParagraphStructure({items:[{type:'beginMarkedContentProps',id:'left'},...columnMajor.slice(0,2),{type:'endMarkedContent'},
  {type:'beginMarkedContentProps',id:'right'},...columnMajor.slice(2),{type:'endMarkedContent'}]},structure);
assert.equal(pdfTextBlocks(tagged.items,viewport,1).length,2,'native paragraph scopes disambiguate aligned columns');
const tableTree={role:'Document',children:['a','b','c','d'].map(id=>({role:'TD',children:[{type:'content',id}]}))};
const table=pdfParagraphStructure({items:columnMajor.flatMap((row,index)=>[{type:'beginMarkedContentProps',id:['a','b','c','d'][index]},row,{type:'endMarkedContent'}])},tableTree);
assert.equal(pdfTextBlocks(table.items,viewport,1).length,4,'native table cells never merge across scope boundaries');
const rowMajorTree={role:'Document',children:[{role:'P',children:[{type:'content',id:'l1'},{type:'content',id:'l2'}]},
  {role:'P',children:[{type:'content',id:'r1'},{type:'content',id:'r2'}]}]};
const rowMajor=[columnMajor[0],columnMajor[2],columnMajor[1],columnMajor[3]].flatMap((row,index)=>[
  {type:'beginMarkedContentProps',id:['l1','r1','l2','r2'][index]},row,{type:'endMarkedContent'}]);
const rowMajorBlocks=pdfTextBlocks(pdfParagraphStructure({items:rowMajor},rowMajorTree).items,viewport,1);
assert.equal(rowMajorBlocks.length,2,'authoritative P ownership gathers nonadjacent paint runs');
assert.ok(rowMajorBlocks[0].text.includes('Another left'));assert.ok(!rowMajorBlocks[0].text.includes('right'));
const listTree={role:'Document',children:[{role:'LI',children:[{role:'Lbl',children:[{type:'content',id:'label'}]},
  {role:'LBody',children:[{role:'P',children:[{type:'content',id:'body'},{type:'content',id:'continuation'}]}]}]}]};
const listContent={items:[{type:'beginMarkedContentProps',id:'label'},item('(1)',30,40,15),{type:'endMarkedContent'},
  {type:'beginMarkedContentProps',id:'body'},item('List body first line.',50,40,150),{type:'endMarkedContent'},
  {type:'beginMarkedContentProps',id:'continuation'},item('Continues on a new line.',50,56,140),{type:'endMarkedContent'}]};
assert.equal(pdfTextBlocks(pdfParagraphStructure(listContent,listTree).items,viewport,1).length,1,'LI label and first LBody paragraph share one complete item');
const nested=pdfTextBlocks([item('(1) Parent list item extends over a visual line',30,40,220),item('continuation of its body.',48,56,170),
  item('(a) A nested list item is its own paragraph',48,72,210),item('continuation of the nested item.',66,88,180)],viewport,1);
assert.equal(nested.length,2);
const mixed=pdfTextBlocks([item('The energy ',30,40,70),{...item('x + y',101,40,35),protection:'math',paintOperations:[2]},
  item(' is followed by a complete explanation',140,40,230),item('which continues on the next visual line.',30,56,320)],viewport,1);
assert.equal(mixed.length,1);assert.equal(mixed[0].inlineProtections.length,1);
assert.ok(mixed[0].text.endsWith('visual line.'));assert.equal(mixed[0].proseSegments[1].boxes.length,2);
const source='Body {{formula:p1:1}} connects {{formula:p1:2}} end.';
const valid='正文 {{formula:p1:1}} 连接 {{formula:p1:2}} 结束。';
assert.deepEqual(splitPdfInlineTranslation(source,valid),['正文 ',' 连接 ',' 结束。']);
const reordered='正文 {{formula:p1:2}} 连接 {{formula:p1:1}} 结束。';
assert.deepEqual(splitPdfInlineTranslation(source,reordered),['正文 ',' 连接 ',' 结束。']);
assert.equal(validateTranslationCandidate(source,reordered,{extractPlaceholders:()=>[],extractTags:()=>[],detectUntranslated:false}).ok,true);
assert.equal(validateProofreadReplacement(source,reordered,{extractPlaceholders:()=>[]}).length,0);
for(const candidate of [valid.replace('{{formula:p1:1}}',''),valid.replace('p1:1','p9:1'),valid+'{{formula:p1:1}}',
  valid.replace('p1:1','p1:2'), '{{formula:p1:1}}{{formula:p1:2}}']) {
  assert.throws(()=>splitPdfInlineTranslation(source,candidate));
  assert.ok(validateTranslationCandidate(source,candidate,{extractPlaceholders:()=>[],extractTags:()=>[],detectUntranslated:false}).blocking.some(f=>f.code==='pdf_protected_content_mismatch'));
  assert.ok(validateProofreadReplacement(source,candidate,{extractPlaceholders:()=>[]}).length,'proofreading must preserve marker identity/count/paragraph ownership and prose');
}
assert.throws(()=>splitPdfInlineTranslation('ordinary prose','正文 {{formula:p1:1}}'));
console.log('ok PDF logical paragraphs preserve first-line/hanging indents and inline identity');
