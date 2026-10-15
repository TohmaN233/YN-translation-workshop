import assert from 'node:assert/strict';
import { discoverPdfFigureGroups } from '../src/main/pdfFigureGroups.ts';

// These hand-authored harbor scenes exercise layout relationships only.
const image = (id, page, x, y, width, height, extra = {}) => ({ id, page, x, y, width, height, ...extra });
const block = (line, page, text, x, y, width = 40, extra = {}) =>
  ({ line, page, text, x, y, width, height: 10, fontSize: 10, ...extra });
const fixtures = [
  { page: 11, images: [
    image('harbor-11-a', 11, 40, 120, 120, 75, { captionLine: 8 }),
    image('harbor-11-b', 11, 180, 120, 120, 75, { captionLine: 8 })
  ], blocks: [block(1, 11, 'Keeper notes', 40, 40, 90), block(8, 11, 'Two lamps face the outer harbor.', 40, 210, 260)] },
  { page: 14, images: Array.from({ length: 12 }, (_, index) => {
    const column = index % 4, row = Math.floor(index / 4);
    return image(`harbor-14-panel-${index + 1}`, 14, 40 + column * 110, 40 + row * 80, 80, 50);
  }), blocks: Array.from({ length: 12 }, (_, index) => {
    const column = index % 4, row = Math.floor(index / 4);
    return block(100 + index, 14, `(${String.fromCharCode(97 + index)})`, 70 + column * 110, 92 + row * 80, 15);
  }) },
  { page: 18, images: [
    image('harbor-18-upper-west', 18, 40, 40, 160, 70),
    image('harbor-18-upper-east', 18, 220, 40, 160, 70),
    image('harbor-18-lower-west', 18, 40, 150, 160, 70, { captionLine: 9 }),
    image('harbor-18-lower-east', 18, 220, 150, 160, 70, { captionLine: 9 })
  ], blocks: [block(1, 18, 'The keeper records the turning tide between the two panels.', 40, 122, 340),
    block(9, 18, 'Upper and lower lantern views at moonrise.', 40, 230, 300)] },
  { page: 21, images: [
    image('harbor-21-chart', 21, 40, 40, 380, 75),
    image('harbor-21-key', 21, 40, 145, 380, 75),
    image('harbor-21-lower-west', 21, 40, 250, 180, 75, { captionLine: 42 }),
    image('harbor-21-lower-east', 21, 240, 250, 180, 75, { captionLine: 42 })
  ], blocks: [block(1, 21, 'A prose note separates the harbor chart from its key.', 45, 122, 340),
    block(2, 21, 'The lower pair shows the keeper and the courier.', 45, 225, 340),
    block(42, 21, 'Night watch at the north pier.', 40, 335, 280)] }
];

function discover(fixture) { return discoverPdfFigureGroups(fixture.page, fixture.images, fixture.blocks); }
function assertExactUnique(groups) {
  for (const field of ['referenceIds', 'physicalLines']) {
    const ids = groups.flatMap(group => group[field]);
    assert.equal(ids.length, new Set(ids).size, `${field} must have exactly one group owner.`);
  }
}
function assertBox(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `Synthetic layout ${key} is preserved.`);
}
const [twoPanelScene, gridScene, twoRowScene, separatedScene] = fixtures;
const retainedInput = JSON.stringify(fixtures);
const pair = discover(twoPanelScene);
assert.deepEqual(pair.map(group => group.referenceIds), [['harbor-11-a', 'harbor-11-b']]);
assert.deepEqual(pair[0].physicalLines, [], 'descriptive caption prose remains writable.');
assert.equal(pair[0].captionLine, 8, 'a shared caption association is retained.');
assertBox(pair[0].box, { x: 40, y: 120, width: 260, height: 75 });

const grid = discover(gridScene);
assert.equal(grid.length, 1, 'a synthetic three-by-four grid keeps its row and column relationships.');
assert.deepEqual(grid[0].referenceIds, gridScene.images.map(item => item.id));
assert.deepEqual(grid[0].physicalLines, Array.from({ length: 12 }, (_, index) => index + 100));
assert.equal(grid[0].captionLine, undefined);
assertBox(grid[0].box, { x: 40, y: 40, width: 410, height: 222 });

const rows = discover(twoRowScene);
assert.deepEqual(rows.map(group => group.referenceIds), [
  ['harbor-18-upper-west', 'harbor-18-upper-east'],
  ['harbor-18-lower-west', 'harbor-18-lower-east']
]);
assert.deepEqual(rows.flatMap(group => group.physicalLines), [], 'ordinary panel descriptions are not immutable labels.');
assert.equal(rows[0].captionLine, undefined);
assert.equal(rows[1].captionLine, 9);
assertBox(rows[0].box, { x: 40, y: 40, width: 340, height: 70 });
assertBox(rows[1].box, { x: 40, y: 150, width: 340, height: 70 });

const separated = discover(separatedScene);
assert.deepEqual(separated.map(group => group.referenceIds), [['harbor-21-lower-west', 'harbor-21-lower-east']],
  'intervening prose blocks page-wide grouping while the lower horizontal pair remains safe.');
assert.deepEqual(separated[0].physicalLines, []);
assert.equal(separated[0].captionLine, 42);
assertBox(separated[0].box, { x: 40, y: 250, width: 380, height: 75 });

for (const fixture of fixtures) {
  const groups = discover(fixture);
  assertExactUnique(groups);
  assert.deepEqual(discover({ ...fixture, images: fixture.images.slice().reverse(), blocks: fixture.blocks.slice().reverse() }), groups,
    'Grouping is independent of synthetic metadata array order.');
}
assert.equal(JSON.stringify(fixtures), retainedInput, 'The discovery API does not mutate the synthetic fixture.');

const simplePair = [image('left-panel', 1, 30, 40, 80, 40), image('right-panel', 1, 140, 40, 80, 40)];
const labels = [block(1, 1, '(a)', 60, 85, 15), block(2, 1, '(b)', 170, 85, 15)];
assert.deepEqual(discoverPdfFigureGroups(1, simplePair, labels)[0].physicalLines, [1, 2]);
assert.deepEqual(discoverPdfFigureGroups(1, simplePair, [block(1, 1, '(z)', 60, 100, 15)])[0].physicalLines, [1],
  'The maximum two-font label gap is included.');
for (const label of [block(1, 1, '(a)', 60, 100.01), block(1, 1, '(a)', 120, 85), block(1, 1, '(A)', 60, 85),
  block(1, 1, '(a) Description', 60, 85), block(1, 1, '(a){{formula:demo7:1}}', 60, 85),
  block(1, 1, '(a)', 60, 85, 15, { protection: 'math' }),
  block(1, 1, '(a)', 60, 85, 15, { inlineProtections: [{ token: '{{formula:demo7:1}}', text: '(a)', kind: 'math' }] })]) {
  assert.deepEqual(discoverPdfFigureGroups(1, simplePair, [label])[0].physicalLines, [],
    'Only pure, close, horizontally contained, unprotected structural labels can enter the crop.');
}
assert.deepEqual(discoverPdfFigureGroups(1, simplePair, [block(1, 1, '(a)', 60, 70)]), [],
  'Pure-looking text overlaid inside an image is not a below-image panel label.');
for (const text of ['harbor note', '(a) keeper description', 'Figure 2: night watch', 'm + 2']) {
  assert.deepEqual(discoverPdfFigureGroups(1, simplePair, [block(1, 1, text, 125, 50, 20)]), [],
    'Every intersecting body, caption, or formula block disqualifies the crop.');
}
assert.deepEqual(discoverPdfFigureGroups(1, simplePair, [...labels, block(3, 1, 'unrelated gutter note', 112, 85, 20)]), [],
  'Expanded label bounds must not freeze text in the gutter.');
assert.deepEqual(discoverPdfFigureGroups(1, [...simplePair, image('foreign-vector', 1, 115, 50, 20, 20, { kind: 'vector' })], []), [],
  'Foreign vector ownership is not silently captured by a raster group.');
assert.deepEqual(discoverPdfFigureGroups(1, [simplePair[0]], labels), []);
assert.deepEqual(discoverPdfFigureGroups(2, simplePair, labels), []);
assert.equal(discoverPdfFigureGroups(1, simplePair.map(item => ({ ...item, captionLine: 20 })), [])[0].captionLine, 20);
assert.equal(discoverPdfFigureGroups(1, [simplePair[0], { ...simplePair[1], captionLine: 20 }], [])[0].captionLine, undefined);
assert.throws(() => discoverPdfFigureGroups(1, [simplePair[0], simplePair[0]], []), /duplicate or missing reference identity/);
assert.throws(() => discoverPdfFigureGroups(1, simplePair, [labels[0], labels[0]]), /duplicate or invalid physical line/);
assert.throws(() => discoverPdfFigureGroups(1, [{ ...simplePair[0], width: 0 }, simplePair[1]], []), /invalid source bounds/);
assert.throws(() => discoverPdfFigureGroups(1, simplePair, [{ ...labels[0], fontSize: NaN }]), /missing source font size/);
assert.throws(() => discoverPdfFigureGroups(1, [simplePair[0], { ...simplePair[1], captionLine: 0 }], []), /invalid caption association/);
console.log('Synthetic PDF figure groups: layout relationships, immutable-label ownership, and unsafe crop rejection PASS.');
