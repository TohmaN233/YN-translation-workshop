import assert from 'node:assert/strict';
import {pdfTextBlocks} from '../src/main/pdfLayout.ts';
const item=(str,x,y,width,size)=>({str,transform:[size,0,0,size,x,y+size],width,height:size,dir:'ltr',hasEOL:true});
const viewport={transform:[1,0,0,1,0,0]};
const title=pdfTextBlocks([
  item('Clockwork Beacon: A Harbor Almanac for',80,40,360,18),
  item('Couriers on the Outer Coast',135,62,250,18),
  item('Opening note',185,112,70,10)
],viewport,1);
assert.equal(title.length,2,'a centered wrapped title is a complete translation row, not a first-line indent');
assert.equal(title[0].proseSegments[0].boxes.length,2);
const abstract=pdfTextBlocks([
  item('At dusk, the keeper winds the beacon and checks the tide.',40,150,360,10),
  item('The brass key stays with the night courier.',26,166,340,10),
  item('A bell answers from the far side of the harbor.',26,182,350,10),
  item('Body text resumes below the opening note.',20,410,360,11)
],viewport,1);
assert.equal(abstract.length,2,'nearby body font size must not consume the abstract column and split its indented first row');
assert.equal(abstract[0].proseSegments[0].boxes.length,3,'the synthetic opening note owns all three visual rows');
assert.ok(abstract[0].text.endsWith('harbor.'));
const citation=pdfTextBlocks([
  item('The first lantern map is credited to Mira (Rowan,',20,440,340,11),
  item('2032) and follows the northern shore.',20,456,310,11),
  item('The keeper adds a note about the tide.',20,472,300,11),
  item('(1) A sealed letter reaches the north pier.',20,508,330,11),
  item('Its final line mentions the bell tower.',38,524,300,11),
  item('(2) A second letter waits beside the clock.',20,540,330,11)
],viewport,1);
assert.equal(citation.length,3,'a closing parenthesized citation year is a continuation, while actual ordered items stay independent');
assert.ok(citation[0].text.includes('(Rowan, 2032)'));
assert.ok(citation[1].text.endsWith('bell tower.'));
for(const [first,second] of [
  ['The lantern log was kept by Mira et al.','(2032), who guarded the eastern quay.'],
  ['A note from Rowan Vale','(2034) describes the old tide clock.'],
  ['Panel 3: lanterns at the north gate and','south gate. Both remain visible at dawn.'],
  ['The courier compared (i) the west pier and','(ii) the inlet path in calm weather.'],
  ['For the final harbor walk, keep','(iii) the bell tower in sight.']
]) {
  const rows=pdfTextBlocks([item(first,20,40,360,11),item(second,20,56,340,11)],viewport,1);
  assert.equal(rows.length,1,`visual prefix ${second} belongs to the ongoing sentence`);
}
const tail=pdfTextBlocks([
  item('A short harbor note establishes the column.',20,30,360,11),
  {...item('a + b',70,78,55,11),protection:'math',paintOperations:[1]},
  {...item('c',220,78,8,11),protection:'math',paintOperations:[2]},
  item('. The lantern remains',233,78,147,11),
  item('visible from the southern pier.',20,96,260,11),
  item('A new indented paragraph begins here.',40,132,310,11)
],viewport,5);
assert.equal(tail.length,4,'the mixed tail of a display equation continues at the body margin, without swallowing the protected equation or the next paragraph');
assert.ok(tail[2].text.endsWith('southern pier.'));
assert.equal(tail[2].proseSegments.at(-1).boxes.length,2);
const headerItems=[item('Pier',60,100,25,10),item('Signal',95,100,35,10),item('Visits',140,100,35,10),item('Note',185,100,28,10)];
const dataItems=[120,138,156].flatMap(y=>[item('N',60,y,10,10),item('clear',102,y,20,10),item('3',147,y,5,10),item('quiet',192,y,20,10)]);
const cells=pdfTextBlocks([...headerItems,...dataItems],viewport,1,undefined,{visualRowsOnly:true});
assert.deepEqual(cells.slice(0,4).map(cell=>cell.text),['Pier','Signal','Visits','Note'],
  'Repeated source gutters retain four independent header primitives even with small header gaps.');
const ordinary=pdfTextBlocks(headerItems,viewport,1,undefined,{visualRowsOnly:true});
assert.equal(ordinary.length,1,'A gap by itself does not infer table columns without repeated source rows.');
const sparse=pdfTextBlocks([item('Pier',20,100,25,10),item('Watch',80,100,32,10),
  ...[120,140,160].map(y=>item('Night watch',80,y,70,10))],viewport,1,undefined,{visualRowsOnly:true});
assert.deepEqual(sparse.slice(0,2).map(cell=>cell.text),['Pier','Watch'],
  'A repeated source column start separates a header even when the first data column is empty.');
const mathItem=(text,x,y,width,size,operator)=>({...item(text,x,y,width,size),protection:'math',paintOperations:[operator],paintSpans:[{operator,start:0,end:text.length}]});
for(const scriptY of [34,47]) {
  const inline=pdfTextBlocks([item('The route ',40,40,40,10),mathItem('r',82,40,8,10,11),mathItem('3',91,scriptY,5,7,12),
    item(' reaches the same harbor gate.',100,40,180,10)],viewport,1,undefined,{visualRowsOnly:true});
  assert.equal(inline.length,1,'a final superscript/subscript cannot replace the established prose baseline');
  assert.ok(inline[0].text.endsWith('same harbor gate.'));assert.equal(inline[0].inlineProtections.length,1);
  assert.deepEqual(inline[0].inlineProtections[0].paintOperations,[11,12],'glyph painter order is retained');
}
const tinyGutter=pdfTextBlocks([
  item('At ',40,40,20,10),mathItem('A',62,40,4,10,1),mathItem('+',72,40,6,10,2),mathItem('B',80,40,5,10,3),
  mathItem('3',86,34,5,7,4),item(' the harbor story continues.',96,40,180,10),
  mathItem('A',62,80,4,10,5),mathItem('B',74,80,6,10,6),mathItem('A',62,100,4,10,7),mathItem('B',74,100,6,10,8)
],viewport,1,undefined,{visualRowsOnly:true});
assert.ok(tinyGutter[0].text.endsWith('story continues.'),'spaces inside unrelated native formulas do not become prose column evidence');
assert.deepEqual(tinyGutter[0].inlineProtections[0].paintOperations,[1,2,3,4]);
const backtracking=pdfTextBlocks([item('Imagine ',40,40,35,10),mathItem('r',78,40,6,10,1),
  mathItem('pq',85,34,12,7,2),mathItem('s',85,47,5,7,3),item(' is the harbor route.',101,40,150,10),
  mathItem('a',101,80,8,10,4),mathItem('a',101,100,8,10,5),mathItem('a',101,120,8,10,6)
],viewport,1,undefined,{visualRowsOnly:true});
assert.equal(backtracking[0].inlineProtections.length,1);assert.ok(backtracking[0].text.endsWith('harbor route.'),'the whole inline ink envelope owns its right edge after backtracking scripts');
assert.deepEqual(backtracking[0].inlineProtections[0].paintSpans.map(span=>span.operator),[1,2,3],'overlapping scripts keep their synthetic input order');
const compactNativeCells=pdfTextBlocks([40,60,80].flatMap((y,index)=>[item('Label',40,y,40,10),
  mathItem('1',90,y,6,10,index*2+1),mathItem('2',107,y,6,10,index*2+2)]),viewport,1,undefined,{visualRowsOnly:true});
assert.equal(compactNativeCells.length,9,'prose-backed table gutters and pure-native cell gutters retain all compact table cells');
const distinctScopes=pdfTextBlocks([{...item('Cell A',40,40,35,10),paragraphScope:'TD:1'},
  {...mathItem('x',77,40,6,10,1),paragraphScope:'TD:2'},
  {...item('tail',86,40,20,10),paragraphScope:'TD:3'}],viewport,1,undefined,{visualRowsOnly:true});
assert.equal(distinctScopes.length,3,'same-baseline proximity never crosses native table-cell/source scopes');
const trueColumns=pdfTextBlocks([item('Left column body',40,40,170,10),mathItem('x',212,40,6,10,1),
  item('Right column body',280,40,160,10),item('Left continuation',40,56,178,10),item('Right continuation',280,56,160,10)],viewport,1,undefined,{visualRowsOnly:true});
assert.equal(trueColumns.length,4);assert.ok(trueColumns[0].text.startsWith('Left'));assert.ok(!trueColumns[0].text.includes('Right'),'a genuine two-column gutter remains independent');
const headingPairs=pdfTextBlocks([40,160,280].flatMap((y,index)=>[item(`4.${index+1}`,40,y,15,12),item('Pier watch',67,y,180,12)]),viewport,1,undefined,{visualRowsOnly:true});
assert.equal(headingPairs.length,3,'distant same-font heading spacers are not a local table gutter');
assert.ok(headingPairs.every(row=>/^4\.\d Pier watch$/u.test(row.text)));
const runin=pdfTextBlocks([item('A harbor log begins before dawn.',40,40,400,10),
  item('Watch label.',40,80,150,10),item('The keeper records the lantern-',200,80,240,10),
  item('light over the outer water.',40,96,400,10),
  item('A distant marker.',40,220,150,10),item('unrelated pier note',200,220,240,10),
  item('Another heading.',40,360,150,10),item('unrelated later note',200,360,240,10)],viewport,1);
assert.ok(runin.some(row=>row.text.includes('lantern-light over the outer water.')),'a run-in right-hand body resumes at the full body margin at normal source leading');
const separateRunin=pdfTextBlocks([item('A full-width harbor log is established.',40,40,400,10),
  item('Independent watch label.',40,80,150,10),item('The courier marks the channel',208,80,232,10),
  item('before the lighthouse bell rings.',40,96,400,10)],viewport,1);
assert.ok(separateRunin.some(row=>row.text==='The courier marks the channel before the lighthouse bell rings.'),'a separately retained run-in right fragment inherits the body column from its complete following row');
assert.ok(separateRunin.some(row=>row.text==='Independent watch label.'),'column recovery does not force the independent label into the body owner');
const tallEntry=pdfTextBlocks([item('A signal gives ',40,40,80,10),mathItem('g',122,30,6,7,21),mathItem('3',122,47,6,7,22),
  item(' and the harbor story continues',131,40,250,10)],viewport,1,undefined,{visualRowsOnly:true});
assert.equal(tallEntry.length,1,'the first numerator baseline does not split a fraction from the two reliable prose baselines');
assert.deepEqual(tallEntry[0].inlineProtections[0].paintOperations,[21,22],'entry proof retains numerator/denominator paint sequence');
for(const ending of ['k .','m + 2).']) {
  const nativeStop=pdfTextBlocks([item('The short harbor note ends after ',40,40,150,10),mathItem(ending,192,40,30,10,31),
    item('A separate watch note begins here.',40,56,360,10)],viewport,1);
  assert.equal(nativeStop.length,2,'a terminal period inside an immutable node completes the short source paragraph');
  assert.ok(nativeStop[0].text.endsWith(nativeStop[0].inlineProtections[0].token),'visible punctuation evidence does not rewrite the canonical marker');
}
const threeColumns=pdfTextBlocks([40,56,72].flatMap(y=>[item('North pier',30,y,100,10),item('Middle pier',170,y,100,10),item('South pier',310,y,100,10)]),viewport,1);
assert.equal(threeColumns.length,9,'synthetic three-column geometry remains independently owned');
console.log('Synthetic PDF opening note, list, wrapped citation and table primitive boundaries PASS');
