import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { classifyPdfGraphicRegions } from '../src/main/pdfGraphicRegions.ts';

const block = (line, text, x, y, width, height = 12, extra = {}) => ({ line, page: 1, text, x, y, width, height, fontSize: 10, ...extra });
const paint = (operator, x, y, width, height) => ({ operator, x, y, width, height });
const base = { page: 1, width: 600, height: 800, textBlocks: [], rasterReferences: [], paints: [] };
const allOwners = result => [...result.references, ...result.tableRuleOwners, ...result.nativeOwners].flatMap(owner => owner.paintOperations);
function exactOwnership(input, result) {
  const expected = [...new Set(input.paints.map(paint => paint.operator))].sort((a, b) => a - b);
  const actual = allOwners(result).sort((a, b) => a - b);
  assert.deepEqual(actual, expected, 'Every visible original paint operator is retained exactly once.');
}

const diagram = { ...base, paints: [paint(9, 100, 200, 20, 40), paint(3, 121, 210, 70, .25), paint(12, 192, 200, 30, 40)] };
const connected = classifyPdfGraphicRegions(diagram);
assert.equal(connected.references.length, 1, 'Adjacent vector shapes/connector strokes form one source graphic.');
assert.deepEqual(connected.references[0].paintOperations, [3, 9, 12]);
assert.equal(connected.references[0].kind, 'vector');
assert.deepEqual([connected.references[0].x, connected.references[0].y, connected.references[0].width, connected.references[0].height], [100, 200, 122, 40]);
exactOwnership(diagram, connected);

const captioned = { ...diagram, textBlocks: [block(1, 'Figure 1: Diagram.', 100, 248, 160)] };
assert.equal(classifyPdfGraphicRegions(captioned).references[0].captionLine, 1);
for (const caption of ['Figure1 illustrates the method.', 'Table 2 shows results.', 'Fig. 3 is discussed here.']) {
  const result = classifyPdfGraphicRegions({ ...diagram, textBlocks: [block(1, caption, 100, 248, 180)] });
  assert.equal(result.references[0].captionLine, undefined, 'Numbered body mentions do not become formal captions.');
}
assert.equal(classifyPdfGraphicRegions({ ...diagram, textBlocks: [block(1, 'Fig. 3. Formal caption.', 100, 248, 180)] }).references[0].captionLine, 1);
assert.throws(() => classifyPdfGraphicRegions({ ...diagram, textBlocks: [block(1, 'Figure 1: Above.', 100, 180, 160), block(2, 'Figure 2: Below.', 100, 248, 160)] }), /competing formal captions/);

const fraction = { ...base, paints: [paint(42, 105, 106, 55, .05)], textBlocks: [block(1, 'Fraction glyphs', 95, 90, 80, 30, { protection: 'math' })],
  natives: [{ id: 'display:p1:1', kind: 'math', box: { x: 95, y: 90, width: 80, height: 30 } }] };
const fractionOwned = classifyPdfGraphicRegions(fraction);
assert.deepEqual(fractionOwned.nativeOwners, [{ id: 'display:p1:1', paintOperations: [42] }], 'Even a tiny fraction bar belongs to the original math group.');
assert.deepEqual(fractionOwned.references, []);
exactOwnership(fraction, fractionOwned);
assert.throws(() => classifyPdfGraphicRegions({ ...fraction, paints: [paint(42, 80, 106, 80, .05)] }), /operator 42 crosses native bounds/);
assert.throws(() => classifyPdfGraphicRegions({ ...fraction, natives: [...fraction.natives, { ...fraction.natives[0], id: 'another-math' }] }), /native owners display:p1:1, another-math/);
const sameNative = classifyPdfGraphicRegions({ ...fraction, natives: [...fraction.natives, fraction.natives[0]] });
exactOwnership(fraction, sameNative);
const codePanel = { ...base, paints: [paint(5, 40, 40, 200, 60)], textBlocks: [block(1, 'source code', 45, 45, 100, 20, { protection: 'code' })],
  natives: [{ id: 'code:p1:1', kind: 'code', box: { x: 40, y: 40, width: 200, height: 60 } }] };
assert.deepEqual(classifyPdfGraphicRegions(codePanel).nativeOwners[0].paintOperations, [5], 'An explicitly bounded native code panel retains its background graphic.');

const cells = [block(2, 'left heading', 110, 100, 60, 12, { segmentation: 'parallel-region' }), block(3, 'right heading', 210, 100, 80, 12, { segmentation: 'parallel-region' }),
  block(4, 'left value', 110, 130, 60, 12, { segmentation: 'parallel-region' }), block(5, 'right value', 210, 130, 80, 12, { segmentation: 'parallel-region' })];
const grid = [paint(10, 95, 90, 230, .3), paint(11, 95, 150, 230, .3), paint(12, 95, 90, .3, 60), paint(13, 195, 90, .3, 60), paint(14, 325, 90, .3, 60)];
const table = { ...base, paints: grid, textBlocks: [block(1, 'Table 1: Results.', 100, 65, 200), ...cells] };
const tableOwned = classifyPdfGraphicRegions(table);
assert.deepEqual(tableOwned.references, []);
assert.deepEqual(tableOwned.tableRuleOwners[0].sourceLines, [2, 3, 4, 5]);
exactOwnership(table, tableOwned);
const bridged = { ...table, textBlocks: [table.textBlocks[0], block(6, 'Combined header', 110, 91, 160, 7), ...cells],
  tableRegions: [{ captionLine: 1, sourceLines: [6, 2, 3, 4, 5], box: { x: 95, y: 90, width: 230, height: 60.3 } }] };
exactOwnership(bridged, classifyPdfGraphicRegions(bridged));
assert.throws(() => classifyPdfGraphicRegions({ ...bridged, textBlocks: [{ ...bridged.textBlocks[0], text: 'Table 1 illustrates results.' }, ...bridged.textBlocks.slice(1)] }), /lacks a formal caption/);
assert.throws(() => classifyPdfGraphicRegions({ ...bridged, paints: [paint(10, 95, 90, 230, 60)] }), /overlap source text/, 'A filled region cannot be silently treated as a removable table rule.');
assert.throws(() => classifyPdfGraphicRegions({ ...bridged, tableRegions: [bridged.tableRegions[0], { ...bridged.tableRegions[0], captionLine: 7 }], textBlocks: [...bridged.textBlocks, block(7, 'Table 2: Competing.', 100, 55, 200)] }), /multiple table regions/);
assert.throws(() => classifyPdfGraphicRegions({ ...bridged, tableRegions: [bridged.tableRegions[0], bridged.tableRegions[0]] }), /reuse the same caption identity/, 'Duplicate table metadata cannot duplicate paint ownership.');

const decorative = { ...base, paints: [paint(1, 20, 500, 100, 50), paint(2, 400, 500, 80, 20)] };
const decorations = classifyPdfGraphicRegions(decorative);
assert.equal(decorations.references.length, 2, 'Standalone decorative rectangles are retained as source graphics.');
exactOwnership(decorative, decorations);
assert.throws(() => classifyPdfGraphicRegions({ ...base, paints: [paint(6, 35, 610, 240, 30)], textBlocks: [block(1, 'Table 1: sample', 40, 615, 120)] }), /operators 6 overlap source text L1/, 'Blue border around an unproved caption cannot disappear or duplicate its text.');
assert.throws(() => classifyPdfGraphicRegions({ ...base, paints: [paint(7, 35, 80, 530, 50)], textBlocks: [block(1, 'ordinary prose', 40, 95, 400)] }), /operators 7 overlap source text L1/, 'An unknown colored prose panel is explicitly rejected.');
assert.throws(() => classifyPdfGraphicRegions({ ...base, paints: [paint(8, 100, 100, 100, 50)], rasterReferences: [{ id: 'p1-image1', page: 1, x: 100, y: 100, width: 100, height: 50 }] }), /raster references p1-image1/, 'Overlapping raster/vector ownership is explicit.');
const fragmentedOperator = { ...base, paints: [paint(4, 10, 10, 20, 20), paint(4, 400, 500, 20, 20)] };
exactOwnership(fragmentedOperator, classifyPdfGraphicRegions(fragmentedOperator));
assert.equal(classifyPdfGraphicRegions(fragmentedOperator).references.length, 1, 'One original operator cannot be rendered by two separate owners.');
assert.throws(() => classifyPdfGraphicRegions({ ...base, paints: [paint(1, 10, 10, 20, 0)] }), /invalid visible ink bounds/, 'Zero-height input is an invalid measurement, not an ignorable stroke.');

const notation = { ...base, paints: [paint(20, 95, 90, 230, .3), paint(21, 95, 150, 230, .3)], tableRegions: [],
  textBlocks: [block(1, 'C', 110, 100, 20, 12, { protection: 'math' }), block(2, 'curve space', 210, 100, 80),
    block(3, 'L(C)', 110, 130, 40, 12, { protection: 'math' }), block(4, 'arc length', 210, 130, 80)],
  natives: [{ id: 'native:1', kind: 'math', box: { x: 95, y: 89, width: 40, height: 23 } }] };
const notationOwned = classifyPdfGraphicRegions(notation), notationTable = notationOwned.tableRuleOwners[0];
assert.equal(notationTable.evidence, 'rules-and-grid');
assert.equal(notationTable.captionLine, undefined, 'Positive rule/grid evidence supports an unnumbered notation table.');
assert.equal(notationTable.firstSourceLine, 1);
assert.equal(notationTable.id, 'p1-tableL1');
assert.deepEqual(notationTable.rows, [[1, 2], [3, 4]]);
assert.deepEqual(notationTable.sourceLines, [1, 2, 3, 4]);
assert.deepEqual(notationTable.horizontalRuleOperations, [20, 21]);
exactOwnership(notation, notationOwned);
const centeredMath = { ...notation, natives: [], textBlocks: [block(1,'CBD',110,100,30),block(2,'value',210,100,40,12,{protection:'math'}),block(3,'FW CBD',110,130,40),block(4,'bold value',207,130,46,12,{protection:'math'})] };
assert.ok(classifyPdfGraphicRegions(centeredMath).tableRuleOwners.length===1,'Strictly centered math columns keep alignment when a bold value changes its advance width.');
const tableFraction = { ...notation, paints: [...notation.paints, paint(22, 115, 105, 10, .1)] };
const fractionTableOwned = classifyPdfGraphicRegions(tableFraction);
assert.deepEqual(fractionTableOwned.nativeOwners, [{ id: 'native:1', paintOperations: [22] }], 'A fraction bar inside a proven table remains native math.');
assert.deepEqual(fractionTableOwned.tableRuleOwners[0].paintOperations, [20, 21]);
exactOwnership(tableFraction, fractionTableOwned);
assert.throws(() => classifyPdfGraphicRegions({ ...notation, paints: [...notation.paints, paint(22, 115, 105, 10, .1), paint(22, 95, 120, 230, .1)] }), /mixes table rules with native ink/, 'One paint operator cannot silently drop its shared native fraction bar.');
exactOwnership({ ...notation, paints: [...notation.paints, paint(22, 95, 105, 230, .1)] }, classifyPdfGraphicRegions({ ...notation, paints: [...notation.paints, paint(22, 95, 105, 230, .1)] }));
const spanned = { ...notation, paints: [notation.paints[0], paint(21, 95, 180, 230, .3)],
  textBlocks: [...notation.textBlocks, block(5, 'combined source cell spanning the full row', 110, 160, 190)] };
assert.deepEqual(classifyPdfGraphicRegions(spanned).tableRuleOwners[0].rows, [[1, 2], [3, 4], [5]], 'A combined physical row retains exactly one source owner.');
const allMath = classifyPdfGraphicRegions({ ...notation, natives: [], textBlocks: notation.textBlocks.map(cell => ({ ...cell, protection: 'math' })) });
assert.deepEqual(allMath.tableRuleOwners, [], 'An all-math alignment cannot become a prose table.');
exactOwnership({ ...notation, natives: [] }, allMath);
const singleRow = classifyPdfGraphicRegions({ ...notation, natives: [], textBlocks: notation.textBlocks.slice(0, 2) });
assert.deepEqual(singleRow.tableRuleOwners, [], 'At least two complete aligned rows are required.');
const noRules = classifyPdfGraphicRegions({ ...notation, natives: [], paints: [] });
assert.deepEqual(noRules.tableRuleOwners, [], 'Cell alignment alone cannot authorize an unnumbered table.');
const crooked = classifyPdfGraphicRegions({ ...notation, natives: [], textBlocks: notation.textBlocks.map(cell => cell.line === 4 ? { ...cell, x: 220 } : cell) });
assert.deepEqual(crooked.tableRuleOwners, [], 'Repeated columns must align strictly.');
assert.throws(() => classifyPdfGraphicRegions({ ...notation, paints: [notation.paints[0]], tableRegions: [{ sourceLines: [1, 2, 3, 4], box: { x: 95, y: 90, width: 230, height: 60 } }] }), /lacks independent outer rules/, 'Supplying an unnumbered box cannot bypass the two-rule evidence requirement.');

const qed = { ...base, paints: [paint(30, 480, 110, 5, 5)], textBlocks: [block(1, 'Two visual prose rows', 40, 90, 445, 30,
  { proseSegments: [{ text: 'First long row', boxes: [{ x: 40, y: 90, width: 445, height: 10 }] }, { text: 'Short final row', boxes: [{ x: 40, y: 110, width: 200, height: 10 }] }], inlineProtections: [] })] };
assert.equal(classifyPdfGraphicRegions(qed).references.length, 1, 'QED square in paragraph envelope whitespace remains a standalone vector graphic.');
assert.throws(() => classifyPdfGraphicRegions({ ...qed, paints: [paint(30, 200, 110, 5, 5)] }), /overlap source text/, 'Actual prose segment overlap still fails.');
assert.throws(() => classifyPdfGraphicRegions({ ...qed, textBlocks: [{ ...qed.textBlocks[0], inlineProtections: [{ token: 'math', sourcePage: 1, x: 480, y: 110, width: 5, height: 5, inkBox: { x: 480, y: 110, width: 5, height: 5 } }] }] }), /overlap source text/, 'Actual inline glyph overlap cannot be hidden by paragraph whitespace.');
assert.equal(classifyPdfGraphicRegions({ ...qed, textBlocks: [block(1, 'native glyph', 40, 90, 20, 10, { protection: 'math', sourceInkBox: { x: 0, y: 0, width: 600, height: 800 } })] }).references.length, 1, 'Whole-page conservative native bounds do not falsely consume unrelated source graphics.');

const paddedTable = { ...base, paints: [paint(40, 94, 101, 208, 1), paint(41, 94, 131, 208, 1), paint(42, 94, 160, 208, 1)],
  textBlocks: [block(1, 'Table 3: Caption.', 100, 75, 195), block(2, 'header left', 100, 100, 50, 14, { segmentation: 'parallel-region' }), block(3, 'header right', 200, 100, 96, 14, { segmentation: 'parallel-region' }),
    block(4, 'data left', 100, 145, 50, 14, { segmentation: 'parallel-region' }), block(5, 'data right', 200, 145, 96, 14, { segmentation: 'parallel-region' })],
  tableRegions: [{ captionLine: 1, sourceLines: [2, 3, 4, 5], box: { x: 100, y: 100, width: 196, height: 59 } }],
  natives: [{ id: 'nominal-header', kind: 'math', box: { x: 200, y: 100, width: 40, height: 14 } }] };
const paddedOwned = classifyPdfGraphicRegions(paddedTable);
assert.deepEqual(paddedOwned.tableRuleOwners[0].paintOperations, [40, 41, 42], 'Repeated tabular padding proves rule ownership before nominal native-quad overlap.');
assert.deepEqual(paddedOwned.tableRuleOwners[0].horizontalRuleOperations, [40, 41, 42]);
exactOwnership(paddedTable, paddedOwned);
assert.throws(() => classifyPdfGraphicRegions({ ...paddedTable, paints: [paddedTable.paints[0]] }), /crosses native bounds/, 'An isolated outlying path cannot authorize tabular padding expansion.');

const pairedTables = { ...base, textBlocks: [block(1, 'Table 4: First.', 110, 75, 180), block(10, 'Table 5: Second.', 110, 245, 180)],
  paints: [paint(50, 104.5, 100.5, 191, .3), paint(51, 104.5, 113.5, 191, .3), paint(52, 104.5, 160.5, 191, .3),
    paint(53, 104.5, 270.5, 191, .3), paint(54, 104.5, 283.5, 191, .3), paint(55, 104.5, 330.5, 191, .3)], tableRegions: [] };
for(let row=0;row<4;row++){pairedTables.textBlocks.push(block(2+row*2,'first left',110,100+row*16,50,12,{segmentation:'parallel-region'}),block(3+row*2,'first right',210,100+row*16,80,12,{segmentation:'parallel-region'}),block(11+row*2,'second left',110,270+row*16,50,12,{segmentation:'parallel-region'}),block(12+row*2,'second right',210,270+row*16,80,12,{segmentation:'parallel-region'}));}
pairedTables.tableRegions=[{captionLine:1,sourceLines:Array.from({length:8},(_,index)=>index+2),box:{x:110,y:100,width:180,height:60}},{captionLine:10,sourceLines:Array.from({length:8},(_,index)=>index+11),box:{x:110,y:270,width:180,height:60}}];
const separated = classifyPdfGraphicRegions(pairedTables);
assert.deepEqual(separated.tableRuleOwners.map(table=>table.paintOperations),[[50,51,52],[53,54,55]],'Six same-span rules retain two separate table frames across the large empty gap.');
exactOwnership(pairedTables,separated);
const protocolTable = { ...base, paints: [paint(60,74,295.5,451,1),paint(61,74,307.5,451,1),paint(62,74,380,451,1)],
  textBlocks: [block(1,'Table 6: Protocol results.',74,245,446,36),block(2,'Enrollment Method',80,294.4,94,12.45,{segmentation:'parallel-region'}),block(3,'AUC EER Rank',261,294.4,257,12.45,{segmentation:'parallel-region'}),block(4,'Protocol A',80,306.77,169,13.2)],
  tableRegions:[{captionLine:1,sourceLines:[2,3],box:{x:80,y:294.4,width:438,height:12.45}}] };
for(let row=0;row<4;row++)for(const [column,x] of [140,279,384,483].entries())protocolTable.textBlocks.push(block(5+row*4+column,column===0?'CBD':'value',x,318.7+row*12,20,12.45,{segmentation:'parallel-region'}));
const protocolOwned=classifyPdfGraphicRegions(protocolTable);
assert.deepEqual(protocolOwned.tableRuleOwners[0].sourceLines,Array.from({length:19},(_,index)=>index+2),'Strong complete grid expands the partial caption/header candidate without losing protocol rows.');
assert.ok(protocolOwned.tableRuleOwners[0].rows.some(row=>row.length===1&&row[0]===4));
exactOwnership(protocolTable,protocolOwned);

if (process.env.YN_PDF_GRAPHIC_PAGE5_FIXTURE) {
  const fixture = JSON.parse(await readFile(process.env.YN_PDF_GRAPHIC_PAGE5_FIXTURE, 'utf8')).input;
  const result = classifyPdfGraphicRegions(fixture), summary = result.tableRuleOwners.find(table => table.sourceLines.includes(70));
  assert.ok(summary, 'Actual page 5 notation summary has positive unnumbered table evidence.');
  assert.deepEqual(summary.sourceLines, Array.from({ length: 24 }, (_, index) => index + 70));
  assert.deepEqual(summary.paintOperations, [945, 1275]);
  assert.ok(summary.rows.some(row => row.length === 1 && row[0] === 84));
  assert.ok(summary.rows.some(row => row.length === 1 && row[0] === 89));
  exactOwnership(fixture, result);
}
if (process.env.YN_PDF_GRAPHIC_PAGE10_FIXTURE) {
  const fixture = JSON.parse(await readFile(process.env.YN_PDF_GRAPHIC_PAGE10_FIXTURE, 'utf8')).input;
  const result = classifyPdfGraphicRegions(fixture), qed = result.references.find(ref => [212, 219, 226, 233].every(operator => ref.paintOperations.includes(operator)));
  assert.ok(qed, 'Actual page 10 QED strokes remain a standalone vector outside measured prose/inline ink.');
  exactOwnership(fixture, result);
}
if (process.env.YN_PDF_GRAPHIC_PAGE18_FIXTURE) {
  const fixture = JSON.parse(await readFile(process.env.YN_PDF_GRAPHIC_PAGE18_FIXTURE, 'utf8')).input;
  const result = classifyPdfGraphicRegions(fixture), table = result.tableRuleOwners.find(table => table.captionLine === 368);
  assert.ok(table, 'Actual page 18 captioned table retains its source rule frame outside nominal cell geometry.');
  assert.deepEqual(table.paintOperations, [57, 83, 286]);
  assert.deepEqual(table.sourceLines, Array.from({ length: 29 }, (_, index) => index + 369));
  exactOwnership(fixture, result);
}
if (process.env.YN_PDF_GRAPHIC_PAGE25_FIXTURE) {
  const fixture=JSON.parse(await readFile(process.env.YN_PDF_GRAPHIC_PAGE25_FIXTURE,'utf8')).input,result=classifyPdfGraphicRegions(fixture);
  const first=result.tableRuleOwners.find(table=>table.firstSourceLine===460),second=result.tableRuleOwners.find(table=>table.firstSourceLine===475);
  assert.ok(first&&second,'Actual page 25 same-width tables retain independent row anchors.');
  assert.equal(first.paintOperations.length,3);assert.equal(second.paintOperations.length,3);
  assert.ok(first.box.y+first.box.height<second.box.y,'The large gap is not swallowed into either source table frame.');
  exactOwnership(fixture,result);
}
if (process.env.YN_PDF_GRAPHIC_PAGE27_FIXTURE) {
  const fixture=JSON.parse(await readFile(process.env.YN_PDF_GRAPHIC_PAGE27_FIXTURE,'utf8')).input,result=classifyPdfGraphicRegions(fixture),table=result.tableRuleOwners.find(table=>table.captionLine===497);
  assert.ok(table,'Actual page 27 full Protocol table expands its truncated header-only caption evidence.');
  assert.deepEqual(table.sourceLines,Array.from({length:86},(_,index)=>index+498));
  assert.deepEqual(table.paintOperations,[37,62,309,552,795,1042]);
  for(const line of [500,521,542,563])assert.ok(table.rows.some(row=>row.length===1&&row[0]===line),'Every Protocol group stays one source-bound spanning row.');
  exactOwnership(fixture,result);
}

console.log(JSON.stringify({ pass: true, vectorGraphicsRetained: true, thinFractionBarOwned: true, tableRulesSourceBound: true, ambiguousOverlayRejected: true, everyOperatorExactlyOnce: true }));
