import assert from 'node:assert/strict';
import { discoverPdfFigureGroups } from '../src/main/pdfFigureGroups.ts';

// Retained v5/e5 physical metadata from figure-group-study.json and the bound
// projection layout. Original SHA256 1fec87f08d1ce1480740ec8fcfb1d151575df4b9936a7b9ecaae650fff9ebca5.
// Reference caption IDs are retained as recorded; physical rows are never
// substituted for a different projection's existing caption association.
const actualPages = [
  { page: 6, images: [
    {"id":"p6-image1","page":6,"x":74.409,"y":294.3171133899999,"width":200.89554226000007,"height":134.09288661000005,"captionLine":69},
    {"id":"p6-image2","page":6,"x":319.962,"y":294.3171133899999,"width":200.89554226000007,"height":134.09288661000005,"captionLine":69}
  ], blocks: [
    {"line":95,"page":6,"text":"3 Curve band regions and Curve Band Depth","x":74.409,"y":90.14579999999997,"width":287.7130410000001,"height":17.93275,"fontSize":14.3462},
    {"line":96,"page":6,"text":"3.1 Band region","x":74.409,"y":120.56579999999995,"width":89.4607616,"height":14.944000000000003,"fontSize":11.9552},
    {"line":97,"page":6,"text":"Given{{formula:p6:1}}, define the (global) band region","x":74.409,"y":145.23389999999992,"width":210.3300256,"height":13.636375000000015,"fontSize":10.9091},
    {"line":98,"page":6,"text":"R ( A, B ) = { (1 − λ ) x + λy : x ∈ A, y ∈ B, λ ∈ [0 , 1] } .","x":168.885,"y":174.6438999999999,"width":257.50554798,"height":13.636375000000015,"protection":"math","fontSize":10.9091},
    {"line":99,"page":6,"text":"(2)","x":508.877,"y":174.6438999999999,"width":12.720010600000002,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":100,"page":6,"text":"Equivalently,{{formula:p6:2}}is the union of all straight line segments joining a point on{{formula:p6:3}}to a point on{{formula:p6:4}}; it depends only on the traces of{{formula:p6:5}}and{{formula:p6:6}}, hence is parameterization-invariant.","x":74.409,"y":204.0529,"width":446.4571916325,"height":29.89537500000003,"fontSize":10.9091},
    {"line":101,"page":6,"text":"Figure 1 illustrates the global band under CBD as well as the corresponding FW-CBD band (which will be introduced in Section 3.3) on the same pair of curves. In this example, the FW band is visibly a subset of the global convex-combination band.","x":74.017,"y":236.57090000000002,"width":446.8469942949999,"height":46.154374999999874,"fontSize":10.9091},
    {"line":102,"page":6,"text":"(a) Global band{{formula:p6:7}}","x":122.87,"y":432.79339999999996,"width":103.65464999999995,"height":12.453250000000025,"fontSize":9.9626},
    {"line":103,"page":6,"text":"(b) FW band{{formula:p6:8}}","x":367.784,"y":432.79339999999996,"width":104.93165000000005,"height":13.20105000000001,"fontSize":9.9626},
    {"line":104,"page":6,"text":"Figure 1: The global band of (2) and the FW band of (9) for the same pair of generating curves{{formula:p6:9}}","x":77.29700000000003,"y":454.88089999999994,"width":440.6812749999999,"height":13.636374999999987,"fontSize":10.9091},
    {"line":105,"page":6,"text":"For any{{formula:p6:10}}and band region{{formula:p6:11}}, define in-band proportion as","x":91.346,"y":484.79789999999997,"width":308.25501640000004,"height":13.636374999999987,"fontSize":10.9091},
    {"line":106,"page":6,"text":"P ( C | R ( A, B )) := μ C ( R ( A, B )) = 1","x":159.096,"y":509.14089999999993,"width":184.27854999999994,"height":21.970625000000098,"protection":"math","fontSize":10.9091},
    {"line":107,"page":6,"text":"L ( C )","x":328.405,"y":524.0039,"width":24.485548989999984,"height":13.636375000000044,"protection":"math","fontSize":10.9091},
    {"line":108,"page":6,"text":"Z","x":355.905,"y":501.67289999999997,"width":6.061095960000001,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":109,"page":6,"text":"C 1 R ( A,B ) ( s ) ds.","x":361.965,"y":516.5209000000001,"width":74.21482970000005,"height":22.793624999999906,"protection":"math","fontSize":10.9091},
    {"line":110,"page":6,"text":"(3)","x":508.877,"y":516.5209000000001,"width":12.720010600000002,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":111,"page":6,"text":"3.2 Integral and infimal CBD","x":74.40899999999999,"y":550.8728,"width":157.4260736,"height":14.94399999999996,"fontSize":11.9552},
    {"line":112,"page":6,"text":"Let{{formula:p6:12}}be a sample with{{formula:p6:13}}","x":74.40899999999999,"y":575.5419,"width":207.663275,"height":14.537624999999935,"fontSize":10.9091},
    {"line":113,"page":6,"text":"Definition 3.1 (Integral and infimal curve band depth). Fix a band construction{{formula:p6:14}}. For any target curve{{formula:p6:15}}, define","x":74.409,"y":600.7669,"width":446.45437198139996,"height":29.895375000000058,"fontSize":10.9091},
    {"line":114,"page":6,"text":"(integral CBD)","x":115.40100000000001,"y":651.2039,"width":65.7600548,"height":13.636375000000001,"fontSize":10.9091},
    {"line":115,"page":6,"text":"D ( b ) int ( C | { C i } ) :=","x":202.978,"y":648.3928999999999,"width":82.83092475000007,"height":19.045624999999973,"protection":"math","fontSize":10.9091},
    {"line":116,"page":6,"text":"\u0012 n","x":288.836,"y":635.8219,"width":14.57864182000003,"height":21.638374999999996,"protection":"math","fontSize":10.9091},
    {"line":117,"page":6,"text":"2","x":297.41400000000004,"y":658.6869,"width":5.454550000000001,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":118,"page":6,"text":"\u0013 − 1 X","x":303.415,"y":635.8219,"width":46.995104039999944,"height":18.654375000000073,"protection":"math","fontSize":10.9091},
    {"line":119,"page":6,"text":"1 ≤ i<j ≤ n","x":324.58199999999994,"y":667.2899,"width":35.899323469999956,"height":9.962625000000003,"protection":"math","fontSize":7.9701},
    {"line":120,"page":6,"text":"P \u0000 C | R b ( C i , C j ) \u0001 ,","x":362.2989999999999,"y":642.3669,"width":89.27454798000002,"height":23.515625,"protection":"math","fontSize":10.9091},
    {"line":121,"page":6,"text":"(4)","x":508.87699999999995,"y":651.2039,"width":12.720010600000002,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":122,"page":6,"text":"(infimal CBD)","x":119.04499999999996,"y":688.7759,"width":62.11641540000001,"height":13.636375000000001,"fontSize":10.9091},
    {"line":123,"page":6,"text":"D ( b ) inf ( C | { C i } ) :=","x":202.97899999999996,"y":685.9649,"width":82.82992475000006,"height":19.235625000000027,"protection":"math","fontSize":10.9091},
    {"line":124,"page":6,"text":"\u0012 n","x":288.837,"y":673.3949,"width":14.577641819999997,"height":21.63737500000002,"protection":"math","fontSize":10.9091},
    {"line":125,"page":6,"text":"2","x":297.414,"y":696.2599,"width":5.454550000000001,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":126,"page":6,"text":"\u0013 − 1 X","x":303.41499999999996,"y":673.3949,"width":46.995104039999944,"height":18.654375000000073,"protection":"math","fontSize":10.9091},
    {"line":127,"page":6,"text":"1 ≤ i<j ≤ n","x":324.5819999999999,"y":704.8629,"width":35.899323469999956,"height":9.962625000000003,"protection":"math","fontSize":7.9701},
    {"line":128,"page":6,"text":"1 \b μ C \u0000 R b ( C i , C j ) \u0001 = 1 .","x":362.29899999999986,"y":679.9399,"width":117.5755479799999,"height":23.515625,"protection":"math","fontSize":10.9091},
    {"line":129,"page":6,"text":"(5)","x":508.8769999999998,"y":688.7759,"width":12.720010600000002,"height":13.636375000000001,"protection":"math","fontSize":10.9091},
    {"line":130,"page":6,"text":"6","x":294.9109999999998,"y":767.3359,"width":5.454550000000001,"height":13.636375000000001,"fontSize":10.9091}
  ] },
  { page: 19, images: [
    {"id":"p19-image1","page":19,"x":74.409,"y":367.80831974,"width":107.13827961,"height":65.18368025999996},
    {"id":"p19-image2","page":19,"x":187.511,"y":367.80831974,"width":107.13827961000001,"height":65.18368025999996},
    {"id":"p19-image3","page":19,"x":300.613,"y":367.80831974,"width":107.13827960999998,"height":65.18368025999996},
    {"id":"p19-image4","page":19,"x":413.714,"y":367.80831974,"width":107.13827960999998,"height":65.18368025999996},
    {"id":"p19-image5","page":19,"x":74.409,"y":451.92431974,"width":107.13827961,"height":65.18368025999996},
    {"id":"p19-image6","page":19,"x":187.511,"y":451.92431974,"width":107.13827961000001,"height":65.18368025999996},
    {"id":"p19-image7","page":19,"x":300.613,"y":451.92431974,"width":107.13827960999998,"height":65.18368025999996},
    {"id":"p19-image8","page":19,"x":413.714,"y":451.92431974,"width":107.13827960999998,"height":65.18368025999996},
    {"id":"p19-image9","page":19,"x":74.409,"y":536.04031974,"width":107.13827961,"height":65.18368025999996,"captionLine":318},
    {"id":"p19-image10","page":19,"x":187.511,"y":536.04031974,"width":107.13827961000001,"height":65.18368025999996,"captionLine":318},
    {"id":"p19-image11","page":19,"x":300.613,"y":536.04031974,"width":107.13827960999998,"height":65.18368025999996,"captionLine":318},
    {"id":"p19-image12","page":19,"x":413.714,"y":536.04031974,"width":107.13827960999998,"height":65.18368025999996,"captionLine":318}
  ], blocks: [
    {"line":407,"page":19,"text":"6.1 Toy examples","x":74.409,"y":92.53679999999996,"width":95.8687488,"height":14.944000000000003,"fontSize":11.9552},
    {"line":408,"page":19,"text":"We compare CBD, FW-CBD, and HCD on four toy configurations: heterogeneous parallel segments, an equal-length star, a restricted-angle star, and concentric circles.","x":73.897,"y":117.20590000000001,"width":446.96829974600047,"height":29.89537500000003,"fontSize":10.9091},
    {"line":409,"page":19,"text":"The four columns of Figure 4 illustrate where the three methods agree and where they diverge. For parallel segments, all three favor curves near the middle of the sample. Without length adjustment, however, CBD and FW-CBD also prefer shorter segments, because shorter curves are more easily covered by pairwise bands. In the equal-length star, all three assign essentially the same depth to every curve; this is forced by the symmetry of the configuration together with similarity invariance. In the restricted-angle star, all three again favor rays near the angular center of the observed wedges, with qualitatively similar rankings.","x":74.409,"y":149.72390000000004,"width":447.8174640900006,"height":111.19037499999999,"fontSize":10.9091},
    {"line":410,"page":19,"text":"The clearest disagreement is on concentric circles. CBD ranks the innermost circles as deepest, since every pairwise band contains the inner ones. FW-CBD picks a circle whose radius is roughly in the middle of the observed range, because the FW band behaves like a radial interval between two circles. HCD also attains its maximum at an interior radius, between the two but visually closer to the FW-CBD choice.","x":74.409,"y":263.5369,"width":448.37170091550036,"height":78.67237499999993,"fontSize":10.9091},
    {"line":411,"page":19,"text":"We now move to real data.","x":91.346,"y":344.83189999999996,"width":116.07282399999998,"height":13.636375000000001,"fontSize":10.9091},
    {"line":412,"page":19,"text":"(a)","x":122.292,"y":437.37539999999996,"width":11.058486,"height":12.45325,"fontSize":9.9626},
    {"line":413,"page":19,"text":"(b)","x":235.114,"y":437.37539999999996,"width":11.6163916,"height":12.45325,"fontSize":9.9626},
    {"line":414,"page":19,"text":"(c)","x":348.495,"y":437.37539999999996,"width":11.058486,"height":12.45325,"fontSize":9.9626},
    {"line":415,"page":19,"text":"(d)","x":461.318,"y":437.37539999999996,"width":11.6163916,"height":12.45325,"fontSize":9.9626},
    {"line":416,"page":19,"text":"(e)","x":122.292,"y":521.4914,"width":11.058486,"height":12.45325,"fontSize":9.9626},
    {"line":417,"page":19,"text":"(f)","x":235.946,"y":521.4914,"width":9.9526374,"height":12.45325,"fontSize":9.9626},
    {"line":418,"page":19,"text":"(g)","x":348.216,"y":521.4914,"width":11.6163916,"height":12.45325,"fontSize":9.9626},
    {"line":419,"page":19,"text":"(h)","x":461.318,"y":521.4914,"width":11.6163916,"height":12.45325,"fontSize":9.9626},
    {"line":420,"page":19,"text":"(i)","x":123.119,"y":605.6084000000001,"width":9.4046944,"height":12.45325,"fontSize":9.9626},
    {"line":421,"page":19,"text":"(j)","x":236.22,"y":605.6084000000001,"width":9.4046944,"height":12.45325,"fontSize":9.9626},
    {"line":422,"page":19,"text":"(k)","x":348.216,"y":605.6084000000001,"width":11.6163916,"height":12.45325,"fontSize":9.9626},
    {"line":423,"page":19,"text":"(l)","x":462.423,"y":605.6084000000001,"width":9.4046944,"height":12.45325,"fontSize":9.9626},
    {"line":424,"page":19,"text":"Figure 4: Toy-example rankings under three methods: CBD (top row), FW-CBD (middle row), and HCD (bottom row). The four columns correspond to heterogeneous parallel segments, an equal-length star, a restricted-angle star, and concentric circles. In each panel the deepest curve is shown in blue, and depth increases from yellow to red.","x":74.049,"y":627.6949000000001,"width":446.8184847757001,"height":54.284374999999955,"fontSize":10.9091},
    {"line":425,"page":19,"text":"19","x":292.183,"y":767.3359,"width":10.909100000000002,"height":13.636375000000001,"fontSize":10.9091}
  ] },
  { page: 24, images: [
    {"id":"p24-image1","page":24,"x":74.409,"y":192.34085371999998,"width":214.29190248000003,"height":191.64314628},
    {"id":"p24-image2","page":24,"x":306.569,"y":192.34085371999998,"width":214.29190248000003,"height":191.64314628},
    {"id":"p24-image3","page":24,"x":74.409,"y":402.91085372,"width":214.29190248000003,"height":191.64314628,"captionLine":347},
    {"id":"p24-image4","page":24,"x":306.569,"y":402.91085372,"width":214.29190248000003,"height":191.64314628,"captionLine":347}
  ], blocks: [
    {"line":449,"page":24,"text":"(a) CBD","x":164.378,"y":388.3674,"width":34.032241599999985,"height":12.45325,"fontSize":9.9626},
    {"line":450,"page":24,"text":"(b) CBD (length adjusted)","x":361.394,"y":388.3674,"width":104.31838460000009,"height":12.45325,"fontSize":9.9626},
    {"line":451,"page":24,"text":"(c) FW-CBD","x":155.571,"y":598.9374,"width":51.646118399999985,"height":12.45325,"fontSize":9.9626},
    {"line":452,"page":24,"text":"(d) HCD","x":395.984,"y":598.9374,"width":35.138090200000015,"height":12.45325,"fontSize":9.9626},
    {"line":453,"page":24,"text":"Figure 8: Ordered depth values for the second contamination experiment, where blue points correspond to the a outliers.","x":74.409,"y":621.0249,"width":446.4529538620003,"height":27.185375000000022,"fontSize":10.9091},
    {"line":454,"page":24,"text":"24","x":292.183,"y":767.3359,"width":10.909100000000002,"height":13.636375000000001,"fontSize":10.9091}
  ] },
  { page: 28, images: [
    {"id":"p28-image1","page":28,"x":74.409,"y":138.575,"width":446.45760000000007,"height":145.584},
    {"id":"p28-image2","page":28,"x":74.409,"y":308.542,"width":446.45760000000007,"height":145.584},
    {"id":"p28-image3","page":28,"x":74.409,"y":478.5101199999999,"width":218.76523200000003,"height":156.26088000000004,"captionLine":482},
    {"id":"p28-image4","page":28,"x":302.1,"y":478.5101199999999,"width":218.76523199999997,"height":156.26088000000004,"captionLine":482}
  ], blocks: [
    {"line":585,"page":28,"text":"(a) Protocol A AUC.","x":256.243,"y":288.54339999999996,"width":82.46044020000008,"height":12.45325,"fontSize":9.9626},
    {"line":586,"page":28,"text":"(b) Protocol A EER.","x":256.796,"y":458.50939999999997,"width":81.35459160000006,"height":12.45325,"fontSize":9.9626},
    {"line":587,"page":28,"text":"(c) Protocol B AUC.","x":142.672,"y":639.1544,"width":81.91249719999996,"height":12.45325,"fontSize":9.9626},
    {"line":588,"page":28,"text":"(d) Protocol B EER.","x":370.915,"y":639.1544,"width":80.80664860000007,"height":12.45325,"fontSize":9.9626},
    {"line":589,"page":28,"text":"Figure 9: Per-user AUC and EER distributions for the five depth scores on MOBISIG. Protocol A uses random enrollment with{{formula:p28:1}}; Protocol B uses the first-session genuine signatures as the reference set. Each box aggregates{{formula:p28:2}}per-user values.","x":74.409,"y":661.2409,"width":446.46091083240015,"height":40.73537500000009,"fontSize":10.9091},
    {"line":590,"page":28,"text":"28","x":292.183,"y":767.3359,"width":10.909100000000002,"height":13.636375000000001,"fontSize":10.9091}
  ] }
];

function discover(fixture) { return discoverPdfFigureGroups(fixture.page, fixture.images, fixture.blocks); }
function assertExactUnique(groups) {
  for (const field of ['referenceIds', 'physicalLines']) {
    const ids = groups.flatMap(group => group[field]);
    assert.equal(ids.length, new Set(ids).size, `${field} must have exactly one group owner.`);
  }
}
function assertBox(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `Exact original source ${key} is retained.`);
}
const [page6, page19, page24, page28] = actualPages;
const retainedInput = JSON.stringify(actualPages);
const six = discover(page6);
assert.deepEqual(six.map(group => group.referenceIds), [['p6-image1', 'p6-image2']]);
assert.deepEqual(six[0].physicalLines, [], 'Global band/FW band descriptions remain writable, including their native math.');
assert.equal(six[0].captionLine, 69, 'Only the existing common caption association is inherited.');
assertBox(six[0].box, { x: 74.409, y: 294.3171133899999, width: 446.44854226000007, height: 134.09288661000005 });
const nineteen = discover(page19);
assert.equal(nineteen.length, 1, 'The Figure 4 three-by-four grid keeps its original spatial relationships.');
assert.deepEqual(nineteen[0].referenceIds, page19.images.map(image => image.id));
assert.deepEqual(nineteen[0].physicalLines, Array.from({ length: 12 }, (_, index) => index + 412));
assert.equal(nineteen[0].captionLine, undefined, 'Upper rows are not relocated to the bottom-row caption.');
assertBox(nineteen[0].box, { x: 74.409, y: 367.80831974, width: 446.44327961, height: 250.2533302600001 });
assert.ok(nineteen[0].box.y + nineteen[0].box.height < page19.blocks.find(block => block.line === 424).y);
const twentyFour = discover(page24);
assert.deepEqual(twentyFour.map(group => group.referenceIds), [['p24-image1', 'p24-image2'], ['p24-image3', 'p24-image4']]);
assert.deepEqual(twentyFour.flatMap(group => group.physicalLines), [], 'CBD length-adjusted and method names are not immutable panel tags.');
assert.equal(twentyFour[0].captionLine, undefined);
assert.equal(twentyFour[1].captionLine, 347);
assertBox(twentyFour[0].box, { x: 74.409, y: 192.34085371999998, width: 446.45190248000006, height: 191.64314628 });
assertBox(twentyFour[1].box, { x: 74.409, y: 402.91085372, width: 446.45190248000006, height: 191.64314628 });
const twentyEight = discover(page28);
assert.deepEqual(twentyEight.map(group => group.referenceIds), [['p28-image3', 'p28-image4']], 'Protocol prose disqualifies the complete page union; only its horizontal bottom pair is safe.');
assert.deepEqual(twentyEight[0].physicalLines, []);
assertBox(twentyEight[0].box, { x: 74.409, y: 478.5101199999999, width: 446.456232, height: 156.26088000000004 });
for (const fixture of actualPages) {
  const groups = discover(fixture);
  assertExactUnique(groups);
  assert.deepEqual(discover({ ...fixture, images: fixture.images.slice().reverse(), blocks: fixture.blocks.slice().reverse() }), groups, 'Grouping is independent of source metadata array order.');
}
assert.equal(JSON.stringify(actualPages), retainedInput, 'The discovery API does not mutate source references or physical rows.');

const image = (id, x, y, width = 100, height = 50, extra = {}) => ({ id, page: 1, x, y, width, height, ...extra });
const block = (line, text, x, y, width = 15, extra = {}) => ({ line, page: 1, text, x, y, width, height: 10, fontSize: 10, ...extra });
const pair = [image('left', 20, 40), image('right', 150, 40)];
const labels = [block(1, '(a)', 60, 95), block(2, '(b)', 190, 95)];
assert.deepEqual(discoverPdfFigureGroups(1, pair, labels)[0].physicalLines, [1, 2]);
assert.deepEqual(discoverPdfFigureGroups(1, pair, [block(1, '(z)', 60, 110)])[0].physicalLines, [1], 'The maximum two-font gap is included.');
for (const label of [block(1, '(a)', 60, 110.01), block(1, '(a)', 120, 95), block(1, '(A)', 60, 95), block(1, '(a) Description', 60, 95),
  block(1, '(a){{formula:p1:1}}', 60, 95), block(1, '(a)', 60, 95, 15, { protection: 'math' }),
  block(1, '(a)', 60, 95, 15, { inlineProtections: [{ token: '{{formula:p1:1}}', text: '(a)', kind: 'math' }] })]) {
  assert.deepEqual(discoverPdfFigureGroups(1, pair, [label])[0].physicalLines, [], 'Only pure, close, horizontally contained unprotected structural labels can enter the crop.');
}
assert.deepEqual(discoverPdfFigureGroups(1, pair, [block(1, '(a)', 60, 70)]), [], 'Pure-looking text overlaid inside an image is not a below-image panel label.');
for (const text of ['translatable body', '(a) Description', 'Figure 2: Caption', 'x + y']) {
  assert.deepEqual(discoverPdfFigureGroups(1, pair, [block(1, text, 125, 50, 20)]), [], 'Every intersecting body/caption/math block disqualifies the crop.');
}
assert.deepEqual(discoverPdfFigureGroups(1, pair, [...labels, block(3, 'foreign gutter prose', 123, 95, 25)]), [], 'Expanded tag ROI must not freeze text in the gutter.');
assert.deepEqual(discoverPdfFigureGroups(1, [...pair, image('vector', 125, 50, 20, 20, { kind: 'vector' })], []), [], 'Foreign vector ownership is not silently captured by a raster group.');
assert.deepEqual(discoverPdfFigureGroups(1, [pair[0]], labels), []);
assert.deepEqual(discoverPdfFigureGroups(2, pair, labels), []);
assert.equal(discoverPdfFigureGroups(1, pair.map(item => ({ ...item, captionLine: 20 })), [])[0].captionLine, 20);
assert.equal(discoverPdfFigureGroups(1, [pair[0], { ...pair[1], captionLine: 20 }], [])[0].captionLine, undefined);
assert.throws(() => discoverPdfFigureGroups(1, [pair[0], pair[0]], []), /duplicate or missing reference identity/);
assert.throws(() => discoverPdfFigureGroups(1, pair, [labels[0], labels[0]]), /duplicate or invalid physical line/);
assert.throws(() => discoverPdfFigureGroups(1, [{ ...pair[0], width: 0 }, pair[1]], []), /invalid source bounds/);
assert.throws(() => discoverPdfFigureGroups(1, pair, [{ ...labels[0], fontSize: NaN }]), /missing source font size/);
assert.throws(() => discoverPdfFigureGroups(1, [pair[0], { ...pair[1], captionLine: 0 }], []), /invalid caption association/);
console.log('PDF figure groups: actual pages 6/19/24/28, source bounds, immutable-label ownership, and unsafe crop rejection PASS.');
