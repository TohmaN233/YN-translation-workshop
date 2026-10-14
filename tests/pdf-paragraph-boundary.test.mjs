import assert from 'node:assert/strict';
import {pdfTextBlocks} from '../src/main/pdfLayout.ts';
const item=(str,x,y,width,size)=>({str,transform:[size,0,0,size,x,y+size],width,height:size,dir:'ltr',hasEOL:true});
const viewport={transform:[1,0,0,1,0,0]};
const title=pdfTextBlocks([
  item('Curve Band Depth: A Band-Based Data Depth for',124.598,135.3966,346.373848,17.2154),
  item('Unparameterized Planar Curves',187.813,161.6976,219.6513,17.2154),
  item('Abstract',279.103,244.7164,37.0708,9.9626)
],viewport,1);
assert.equal(title.length,2,'a centered wrapped title is a complete translation row, not a first-line indent');
assert.equal(title[0].proseSegments[0].boxes.length,2);
const abstract=pdfTextBlocks([
  item('We introduce a method for unparameterized',116.626,266.0364,376.9708,9.9626),
  item('planar curves. Its complete abstract continues here.',101.682,280.3824,391.9121,9.9626),
  item('The method is evaluated in several experiments.',101.682,294.7284,226.9779,9.9626),
  item('Body text starts at a different margin and scale.',74.409,517.8409,448.2718,10.9091)
],viewport,1);
assert.equal(abstract.length,2,'nearby body font size must not consume the abstract column and split its indented first row');
assert.equal(abstract[0].proseSegments[0].boxes.length,3,'the abstract owns all three original visual rows');
assert.ok(abstract[0].text.endsWith('experiments.'));
const citation=pdfTextBlocks([
  item('The analysis began with halfspace depth (Tukey,',74.409,534.0999,447.8201,10.9091),
  item('1975) and broadened to other geometric alternatives.',73.591,550.3589,448.6409,10.9091),
  item('The complete paragraph ends here.',74.409,566.6179,160,10.9091),
  item('(1) This is the next ordered list item.',74.409,599.1359,220,10.9091),
  item('Its body continues on this visual row.',92.584,615.3949,210,10.9091),
  item('(2) Another ordered item stays separate.',74.409,631.6539,230,10.9091)
],viewport,1);
assert.equal(citation.length,3,'a closing parenthesized citation year is a continuation, while actual ordered items stay independent');
assert.ok(citation[0].text.includes('(Tukey, 1975)'));
assert.ok(citation[1].text.endsWith('visual row.'));
for(const [first,second] of [
  ['Related work includes Lopez-Pintado et al.','(2014), the multivariate alternative and later studies.'],
  ['We use preprocessed data of De Micheaux et al.','(2021).'],
  ['Table 3: Results on MNIST digit curves 1 and','7. In each split, training and test samples are separate.'],
  ['Depth compares (i) the probability of intersection and','(ii) the arc-length proportion within the halfspace.'],
  ['For the third condition we also require','(iii) the trace to have a continuous parameterization.']
]) {
  const rows=pdfTextBlocks([item(first,40,40,400,11),item(second,40,56,390,11)],viewport,1);
  assert.equal(rows.length,1,`visual prefix ${second} belongs to the ongoing sentence`);
}
const tail=pdfTextBlocks([
  item('Ordinary body paragraph establishes the column.',74.409,110,446.46,10.9091),
  {...item('integral expression',100,158.6189,240,10.9091),protection:'math',paintOperations:[1]},
  {...item('x',391.337,158.6189,65,10.9091),protection:'math',paintOperations:[2]},
  item('. Hence the measure is',460.8268,158.6189,60.0391,10.9091),
  item('independent of which representative is used.',74.409,174.8779,240.4147,10.9091),
  item('A new indented paragraph stays independent.',91.346,206.2159,429,10.9091)
],viewport,5);
assert.equal(tail.length,4,'the mixed tail of a display equation continues at the body margin, without swallowing the protected equation or the next paragraph');
assert.ok(tail[2].text.endsWith('representative is used.'));
assert.equal(tail[2].proseSegments.at(-1).boxes.length,2);
const headerItems=[item('Letters',180,140,30,10),item('Distance',222,140,36,10),item('CBD affinity',270,140,54,10),item('FW-CBD affinity',336,140,72,10)];
const dataItems=[160,176,192].flatMap(y=>[item('aho',180,y,18,10),item('0.511',228,y,22,10),item('0.844',285,y,22,10),item('0.844',360,y,22,10)]);
const cells=pdfTextBlocks([...headerItems,...dataItems],viewport,1,undefined,{visualRowsOnly:true});
assert.deepEqual(cells.slice(0,4).map(cell=>cell.text),['Letters','Distance','CBD affinity','FW-CBD affinity'],
  'Repeated source gutters retain four independent header primitives even with small header gaps.');
const ordinary=pdfTextBlocks(headerItems,viewport,1,undefined,{visualRowsOnly:true});
assert.equal(ordinary.length,1,'A gap by itself does not infer table columns without repeated source rows.');
const sparse=pdfTextBlocks([item('Enrollment',80,100,48,10),item('Method',140,100,33,10),
  ...[120,140,160].map(y=>item('A source data label',140,y,80,10))],viewport,1,undefined,{visualRowsOnly:true});
assert.deepEqual(sparse.slice(0,2).map(cell=>cell.text),['Enrollment','Method'],
  'A repeated source column start separates a header even when the first data column is empty.');
const mathItem=(text,x,y,width,size,operator)=>({...item(text,x,y,width,size),protection:'math',paintOperations:[operator],paintSpans:[{operator,start:0,end:text.length}]});
for(const scriptY of [34,47]) {
  const inline=pdfTextBlocks([item('The value ',40,40,40,10),mathItem('x',82,40,8,10,11),mathItem('n',91,scriptY,5,7,12),
    item(' completes the same physical line.',100,40,180,10)],viewport,1,undefined,{visualRowsOnly:true});
  assert.equal(inline.length,1,'a final superscript/subscript cannot replace the established prose baseline');
  assert.ok(inline[0].text.endsWith('same physical line.'));assert.equal(inline[0].inlineProtections.length,1);
  assert.deepEqual(inline[0].inlineProtections[0].paintOperations,[11,12],'glyph painter order is retained');
}
const tinyGutter=pdfTextBlocks([
  item('On ',40,40,20,10),mathItem('I',62,40,4,10,1),mathItem('=',72,40,6,10,2),mathItem('S',80,40,5,10,3),
  mathItem('1',86,34,5,7,4),item(' the ordinary sentence continues.',96,40,180,10),
  mathItem('A',62,80,4,10,5),mathItem('B',74,80,6,10,6),mathItem('A',62,100,4,10,7),mathItem('B',74,100,6,10,8)
],viewport,1,undefined,{visualRowsOnly:true});
assert.ok(tinyGutter[0].text.endsWith('sentence continues.'),'spaces inside unrelated native formulas do not become prose column evidence');
assert.deepEqual(tinyGutter[0].inlineProtections[0].paintOperations,[1,2,3,4]);
const backtracking=pdfTextBlocks([item('Suppose ',40,40,35,10),mathItem('x',78,40,6,10,1),
  mathItem('abc',85,34,12,7,2),mathItem('C',85,47,5,7,3),item(' is the representative.',101,40,150,10),
  mathItem('a',101,80,8,10,4),mathItem('a',101,100,8,10,5),mathItem('a',101,120,8,10,6)
],viewport,1,undefined,{visualRowsOnly:true});
assert.equal(backtracking[0].inlineProtections.length,1);assert.ok(backtracking[0].text.endsWith('representative.'),'the whole inline ink envelope owns its right edge after backtracking scripts');
assert.deepEqual(backtracking[0].inlineProtections[0].paintSpans.map(span=>span.operator),[1,2,3],'overlapping scripts keep their original source sequence');
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
const headingPairs=pdfTextBlocks([40,160,280].flatMap((y,index)=>[item(`2.${index+1}`,40,y,15,12),item('A subsection title',67,y,180,12)]),viewport,1,undefined,{visualRowsOnly:true});
assert.equal(headingPairs.length,3,'distant same-font heading spacers are not a local table gutter');
assert.ok(headingPairs.every(row=>/^2\.\d A subsection title$/u.test(row.text)));
const runin=pdfTextBlocks([item('A complete earlier paragraph.',40,40,400,10),
  item('A run-in label.',40,80,150,10),item('The normal body continues with opera-',200,80,240,10),
  item('tions over all the remaining source words.',40,96,400,10),
  item('A distant label.',40,220,150,10),item('unrelated distant body',200,220,240,10),
  item('Another label.',40,360,150,10),item('unrelated later body',200,360,240,10)],viewport,1);
assert.ok(runin.some(row=>row.text.includes('opera-tions over all the remaining source words.')),'a run-in right-hand body resumes at the full body margin at normal source leading');
const separateRunin=pdfTextBlocks([item('Established full-width body.',40,40,400,10),
  item('Independent run-in label.',40,80,150,10),item('A right-hand body continues with',208,80,232,10),
  item('all its normal next-row source words.',40,96,400,10)],viewport,1);
assert.ok(separateRunin.some(row=>row.text==='A right-hand body continues with all its normal next-row source words.'),'a separately retained run-in right fragment inherits the body column from its complete following row');
assert.ok(separateRunin.some(row=>row.text==='Independent run-in label.'),'column recovery does not force the independent label into the body owner');
const tallEntry=pdfTextBlocks([item('A fraction gives ',40,40,80,10),mathItem('n',122,30,6,7,21),mathItem('2',122,47,6,7,22),
  item(' and the ordinary sentence continues',131,40,250,10)],viewport,1,undefined,{visualRowsOnly:true});
assert.equal(tallEntry.length,1,'the first numerator baseline does not split a fraction from the two reliable prose baselines');
assert.deepEqual(tallEntry[0].inlineProtections[0].paintOperations,[21,22],'entry proof retains numerator/denominator paint sequence');
for(const ending of ['Φ .','I = S¹).']) {
  const nativeStop=pdfTextBlocks([item('The short paragraph ends through ',40,40,150,10),mathItem(ending,192,40,30,10,31),
    item('A separate following paragraph begins here.',40,56,360,10)],viewport,1);
  assert.equal(nativeStop.length,2,'a terminal period inside an immutable node completes the short source paragraph');
  assert.ok(nativeStop[0].text.endsWith(nativeStop[0].inlineProtections[0].token),'visible punctuation evidence does not rewrite the canonical marker');
}
const threeColumns=pdfTextBlocks([40,56,72].flatMap(y=>[item('Left source cell',30,y,100,10),item('Middle source cell',170,y,100,10),item('Right source cell',310,y,100,10)]),viewport,1);
assert.equal(threeColumns.length,9,'real three-column/table geometry remains independently owned');
console.log('PDF abstract, list, wrapped citation and source table primitive boundaries PASS');
