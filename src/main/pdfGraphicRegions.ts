import type { PdfBox, PdfReference, PdfTextBlock } from './pdfTypes.ts';

export interface PdfGraphicPaint extends PdfBox { operator: number }
export interface PdfGraphicNativeOwner { id: string; box: PdfBox; kind: 'math' | 'code' }
export interface PdfGraphicTableRegion { id?: string; firstSourceLine?: number; captionLine?: number; sourceLines: number[]; box: PdfBox }
export interface PdfGraphicTableOwner extends PdfGraphicTableRegion {
  id: string;
  firstSourceLine: number;
  rows: number[][];
  paintOperations: number[];
  evidence: 'caption-and-cells' | 'rules-and-grid';
  horizontalRuleOperations: number[];
}
export interface PdfGraphicRegionsInput {
  page: number;
  width: number;
  height: number;
  /** Actual visible non-text, non-outline, non-bitmap paint ink, in page points. */
  paints: PdfGraphicPaint[];
  textBlocks: PdfTextBlock[];
  rasterReferences: PdfReference[];
  natives?: PdfGraphicNativeOwner[];
  tableRegions?: PdfGraphicTableRegion[];
}
export interface PdfVectorGraphicReference extends PdfReference { kind: 'vector'; paintOperations: number[] }
export interface PdfGraphicRegionsResult {
  references: PdfVectorGraphicReference[];
  tableRuleOwners: PdfGraphicTableOwner[];
  nativeOwners: Array<{ id: string; paintOperations: number[] }>;
}

const ADJACENCY = 2;
const union = (boxes: PdfBox[]): PdfBox => {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
};
const contains = (outer: PdfBox, inner: PdfBox, padding = 0) => inner.x >= outer.x - padding && inner.y >= outer.y - padding
  && inner.x + inner.width <= outer.x + outer.width + padding && inner.y + inner.height <= outer.y + outer.height + padding;
const overlaps = (a: PdfBox, b: PdfBox, padding = 0) => a.x < b.x + b.width + padding && b.x < a.x + a.width + padding
  && a.y < b.y + b.height + padding && b.y < a.y + a.height + padding;
const formalCaption = (text: string) => /^(?:Figure|Fig\.?|Table|图|表)\s*\d+[A-Za-z]?\s*[:.：．]/iu.test(text.trim());
const tableCaption = (text: string) => /^(?:Table|表)\s*\d+[A-Za-z]?\s*[:.：．]/iu.test(text.trim());
const thinRule = (box: PdfBox) => Math.min(box.width, box.height) <= 2 && Math.max(box.width, box.height) >= 4;
const horizontalRule = (box: PdfBox) => box.height <= 2 && box.width >= Math.max(4, box.height * 4);

function cellRows(cells: PdfTextBlock[]): PdfTextBlock[][] {
  const rows: PdfTextBlock[][] = [];
  for (const cell of cells.slice().sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x - b.x)) {
    const row = rows.at(-1), anchor = row?.[0];
    if (anchor && Math.abs(anchor.y + anchor.height / 2 - cell.y - cell.height / 2) <= Math.min(anchor.height, cell.height) / 2) row!.push(cell);
    else rows.push([cell]);
  }
  return rows.map(row => row.sort((a, b) => a.x - b.x));
}

type PaintGroup = { operator: number; boxes: PdfGraphicPaint[]; box: PdfBox };
function components(groups: PaintGroup[]): PaintGroup[][] {
  const parents = groups.map((_, index) => index);
  const root = (index: number): number => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  // A page-local bucket index avoids comparing every pair of isolated strokes.
  const buckets = new Map<string, Array<{ index: number; box: PdfBox }>>();
  groups.forEach((group, index) => {
    for (const box of group.boxes) {
      const candidates = new Set<number>();
      const keys: string[] = [];
      for (let y = Math.floor((box.y - ADJACENCY) / 64); y <= Math.floor((box.y + box.height + ADJACENCY) / 64); y++)
        for (let x = Math.floor((box.x - ADJACENCY) / 64); x <= Math.floor((box.x + box.width + ADJACENCY) / 64); x++) keys.push(`${x}:${y}`);
      for (const key of keys) for (const other of buckets.get(key) ?? []) {
        if (other.index === index || candidates.has(other.index) || root(other.index) === root(index)) continue;
        if (overlaps(box, other.box, ADJACENCY)) { candidates.add(other.index); parents[root(other.index)] = root(index); }
      }
      for (const key of keys) { const entries = buckets.get(key) ?? []; entries.push({ index, box }); buckets.set(key, entries); }
    }
  });
  const result = new Map<number, PaintGroup[]>();
  groups.forEach((group, index) => { const key = root(index); const members = result.get(key) ?? []; members.push(group); result.set(key, members); });
  return [...result.values()].sort((a, b) => a[0].operator - b[0].operator);
}

/** Deterministic ownership, not visual inference. Every paint operation gets
 * one native/table/vector owner, or the page fails with actionable evidence. */
export function classifyPdfGraphicRegions(input: PdfGraphicRegionsInput): PdfGraphicRegionsResult {
  const fail = (message: string): never => { throw new Error(`PDF page ${input.page}: ambiguous graphic ownership: ${message}`); };
  if (!Number.isSafeInteger(input.page) || input.page < 1 || !Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) fail('invalid page geometry.');
  function checkBox(box: PdfBox, description: string): void {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0
      || box.x < -2 || box.y < -2 || box.x + box.width > input.width + 2 || box.y + box.height > input.height + 2) fail(`invalid visible ink bounds for ${description}.`);
  }
  const grouped = new Map<number, PdfGraphicPaint[]>();
  for (const paint of input.paints) {
    if (!Number.isSafeInteger(paint.operator) || paint.operator < 0) fail('paint has no valid operator identity.');
    checkBox(paint, `operator ${paint.operator}`);
    const boxes = grouped.get(paint.operator) ?? []; boxes.push(paint); grouped.set(paint.operator, boxes);
  }
  const groups: PaintGroup[] = [...grouped].sort(([a], [b]) => a - b).map(([operator, boxes]) => ({ operator, boxes, box: union(boxes) }));
  const blocks = input.textBlocks.filter(block => block.page === input.page);
  if (new Set(blocks.map(block => block.line)).size !== blocks.length) fail('physical source line identities are duplicated.');
  for (const block of blocks) {
    checkBox(block, `source L${block.line}`);
    if (!Number.isSafeInteger(block.line) || block.line < 1) fail('text block has no physical line identity.');
    if (typeof block.text !== 'string' || !Number.isFinite(block.fontSize) || block.fontSize <= 0) fail(`source L${block.line} has invalid text/font geometry.`);
  }
  const rasters = input.rasterReferences.filter(ref => ref.page === input.page);
  for (const ref of rasters) checkBox(ref, `raster ${ref.id}`);
  function textInkBoxes(block: PdfTextBlock): PdfBox[] {
    if (block.proseSegments) return [...block.proseSegments.flatMap(segment => segment.boxes.filter(box => box.page === undefined || box.page === input.page)),
      ...(block.inlineProtections ?? []).filter(node => node.sourcePage === undefined || node.sourcePage === input.page).map(node => node.inkBox ?? node)];
    const ink = block.sourceInkBox;
    const conservativePage = ink && ink.x <= 2 && ink.y <= 2 && ink.width >= input.width - 2 && ink.height >= input.height - 2;
    return [ink && !conservativePage ? ink : block];
  }
  const nativeRegions = new Map<string, { kind: 'math' | 'code'; box: PdfBox }>();
  for (const native of input.natives ?? []) {
    checkBox(native.box, `native ${native.id}`);
    if (!native.id || !['math', 'code'].includes(native.kind)) fail('invalid native owner.');
    const prior = nativeRegions.get(native.id);
    if (prior && prior.kind !== native.kind) fail(`native ${native.id} has conflicting kinds.`);
    nativeRegions.set(native.id, { kind: native.kind, box: prior ? union([prior.box, native.box]) : native.box });
  }
  const nativeOwners = new Map<string, number[]>(), assigned = new Set<number>();
  const nativeCandidates = (group: PaintGroup) => [...nativeRegions].filter(([, native]) => group.boxes.every(box => contains(native.box, box)));
  function nearbyCaptions(box: PdfBox): PdfTextBlock[] {
    return blocks.filter(block => formalCaption(block.text) && block.x < box.x + box.width && box.x < block.x + block.width
      && Math.max(0, block.y - (box.y + box.height), box.y - (block.y + block.height)) <= Math.max(24, (block.fontSize ?? 11) * 3));
  }
  function parallelColumns(cells: PdfTextBlock[]): boolean {
    const eligible = (cell: PdfTextBlock) => cell.segmentation === 'parallel-region' || cell.protection === 'math';
    return cells.some((left, index) => cells.slice(index + 1).some(right => eligible(left) && eligible(right)
      && Math.abs(left.y - right.y) <= Math.min(left.height, right.height) / 2
      && (left.x + left.width <= right.x || right.x + right.width <= left.x)));
  }
  type TableEvidence = PdfGraphicTableRegion & { evidence: PdfGraphicTableOwner['evidence']; rows?: number[][]; horizontalRuleOperations?: number[] };
  const tableRegions: TableEvidence[] = input.tableRegions?.map(region => ({ id: region.id, firstSourceLine: region.firstSourceLine, captionLine: region.captionLine,
    sourceLines: [...region.sourceLines], box: { ...region.box }, evidence: region.captionLine === undefined ? 'rules-and-grid' : 'caption-and-cells' })) ?? [];
  const suppliedCaptioned = tableRegions.filter(table => table.captionLine !== undefined);
  if (new Set(suppliedCaptioned.map(table => table.captionLine)).size !== suppliedCaptioned.length) fail('multiple table regions reuse the same caption identity.');
  if (input.tableRegions === undefined) for (const component of components(groups)) {
    const box = union(component.map(group => group.box)), captions = nearbyCaptions(box).filter(block => tableCaption(block.text));
    const cells = blocks.filter(block => contains(box, block) && block.segmentation === 'parallel-region');
    if (captions.length === 1 && parallelColumns(cells) && component.every(group => group.boxes.every(thinRule))) tableRegions.push({ captionLine: captions[0].line, sourceLines: cells.map(block => block.line), box, evidence: 'caption-and-cells' });
  }
  function strictGrid(cells: PdfTextBlock[]): PdfTextBlock[][] | undefined {
    const rows = cellRows(cells), width = Math.max(0, ...rows.map(row => row.length)), complete = rows.filter(row => row.length === width), columns = complete[0];
    if (!columns || width < 2 || complete.length < 2) return undefined;
    const anchor = (cell: PdfTextBlock, mode: 'left' | 'center' | 'right') => cell.x + (mode === 'center' ? cell.width / 2 : mode === 'right' ? cell.width : 0);
    const positions = columns.map((column, index) => {
      const mode = (['left', 'center', 'right'] as const).find(mode => complete.every(row => Math.abs(anchor(row[index], mode) - anchor(column, mode)) <= ADJACENCY));
      return mode === undefined ? undefined : anchor(column, mode);
    });
    if (positions.some(position => position === undefined) || complete.some(row => row.some((cell, index) => index > 0 && row[index - 1].x + row[index - 1].width > cell.x))) return undefined;
    const prose = (cell: PdfTextBlock) => !cell.protection && (cell.proseSegments ? cell.proseSegments.some(segment => /\p{L}/u.test(segment.text)) : /\p{L}/u.test(cell.text.replace(/\{\{[^{}]+\}\}/gu, '')));
    for (const row of rows.filter(row => row.length < width)) {
      if (row.length === 1 && prose(row[0]) && row[0].x <= columns[0].x + ADJACENCY) continue;
      const covered = new Set<number>();
      for (const cell of row) {
        const spans = positions.flatMap((position, index) => position! >= cell.x - ADJACENCY && position! <= cell.x + cell.width + ADJACENCY ? [index] : []);
        if (!spans.length || spans.some(index => covered.has(index))) return undefined;
        spans.forEach(index => covered.add(index));
      }
    }
    if (rows.some((row, index) => index > 0 && Math.min(...row.map(cell => cell.y)) - Math.max(...rows[index - 1].map(cell => cell.y + cell.height))
      > 2 * Math.max(...row.map(cell => cell.fontSize), ...rows[index - 1].map(cell => cell.fontSize)))) return undefined;
    if (!columns.some((_, index) => complete.every(row => prose(row[index])))) return undefined;
    return rows;
  }
  // Two independently painted outer horizontal rules plus a complete aligned
  // row/column lattice are positive evidence even for an unnumbered notation
  // table. Fraction bars wholly bound to native math never seed discovery.
  const horizontal = groups.filter(group => horizontalRule(group.box) && group.boxes.every(horizontalRule) && nativeCandidates(group).length === 0);
  // Captioned tabular layouts commonly paint rules outside the text-cell
  // envelope by one source-font-width of horizontal padding. Expand only for
  // a repeated, same-span family that proves both frame boundaries; an
  // isolated underline or an unrelated long path cannot authorize expansion.
  for (const table of tableRegions.filter(table => table.captionLine !== undefined)) {
    const cells = blocks.filter(block => table.sourceLines.includes(block.line));
    const padding = Math.max(...cells.map(cell => cell.fontSize));
    if (!cells.length || !Number.isFinite(padding) || padding <= 0) continue;
    const candidates = horizontal.filter(group => group.box.x <= table.box.x + ADJACENCY && group.box.x + group.box.width >= table.box.x + table.box.width - ADJACENCY
      && table.box.x - group.box.x <= padding && group.box.x + group.box.width - table.box.x - table.box.width <= padding
      && group.box.y >= table.box.y - ADJACENCY && group.box.y + group.box.height <= table.box.y + table.box.height + ADJACENCY);
    const families: PaintGroup[][] = [];
    for (const group of candidates) {
      const family = families.find(values => Math.abs(values[0].box.x - group.box.x) <= ADJACENCY
        && Math.abs(values[0].box.x + values[0].box.width - group.box.x - group.box.width) <= ADJACENCY);
      if (family) family.push(group); else families.push([group]);
    }
    const frames = families.filter(family => family.length >= 2 && family.some(group => Math.abs(group.box.y - table.box.y) <= ADJACENCY)
      && family.some(group => Math.abs(group.box.y + group.box.height - table.box.y - table.box.height) <= ADJACENCY));
    if (frames.length > 1) fail(`table L${table.captionLine} has competing repeated rule frames.`);
    if (frames.length === 1) {
      table.box = union([table.box, ...frames[0].map(group => group.box)]);
      table.horizontalRuleOperations = frames[0].map(group => group.operator);
    }
  }
  const pairs = horizontal.flatMap((top, index) => horizontal.slice(index + 1).map(bottom => [top, bottom] as const))
    .map(([a, b]) => a.box.y <= b.box.y ? [a, b] as const : [b, a] as const).sort((a, b) => b[1].box.y - b[0].box.y - (a[1].box.y - a[0].box.y));
  for (const [top, bottom] of pairs) {
    if (top.operator === bottom.operator || Math.abs(top.box.x - bottom.box.x) > ADJACENCY || Math.abs(top.box.x + top.box.width - bottom.box.x - bottom.box.width) > ADJACENCY) continue;
    const box = union([top.box, bottom.box]), interior = { x: box.x, y: top.box.y + top.box.height, width: box.width, height: bottom.box.y - top.box.y - top.box.height };
    if (interior.height <= 0) continue;
    const cells = blocks.filter(block => block.x >= box.x - ADJACENCY && block.x + block.width <= box.x + box.width + ADJACENCY
      && block.y + block.height / 2 >= box.y && block.y + block.height / 2 <= box.y + box.height), rows = strictGrid(cells);
    if (!rows) continue;
    const first = rows[0], last = rows.at(-1)!;
    const firstGap = Math.min(...first.map(cell => cell.y)) - interior.y;
    const lastGap = bottom.box.y - Math.max(...last.map(cell => cell.y + cell.height));
    // A frame must directly enclose its first/last rows. Matching widths alone
    // cannot join separate same-column tables across a large empty/caption gap.
    if (firstGap > 2 * Math.max(...first.map(cell => cell.fontSize)) || lastGap > 2 * Math.max(...last.map(cell => cell.fontSize))) continue;
    const sourceLines = rows.flatMap(row => row.map(cell => cell.line));
    const existing = tableRegions.filter(table => table.sourceLines.some(line => sourceLines.includes(line)));
    // A prospective outer pair cannot merge independently evidenced source
    // tables. Their individual frames remain available for exact ownership.
    if (existing.length > 1) continue;
    if (existing.length === 1) {
      const table = existing[0];
      if (table.sourceLines.every(line => sourceLines.includes(line))) {
        table.sourceLines = sourceLines;
        table.rows = rows.map(row => row.map(cell => cell.line));
      } else if (!sourceLines.every(line => table.sourceLines.includes(line))) fail(`horizontal rules ${top.operator}, ${bottom.operator} conflict with existing table cells.`);
      table.box = union([table.box, box]);
      table.horizontalRuleOperations = [...new Set([...(table.horizontalRuleOperations ?? []), top.operator, bottom.operator])];
      continue;
    }
    tableRegions.push({ sourceLines, box, rows: rows.map(row => row.map(cell => cell.line)), evidence: 'rules-and-grid', horizontalRuleOperations: [top.operator, bottom.operator] });
  }
  const captioned = tableRegions.filter(table => table.captionLine !== undefined);
  if (new Set(captioned.map(table => table.captionLine)).size !== captioned.length) fail('multiple table regions reuse the same caption identity.');
  for (const table of tableRegions) {
    checkBox(table.box, `table source L${table.sourceLines[0]}`);
    const caption = blocks.find(block => block.line === table.captionLine);
    const cells = table.sourceLines.map(line => blocks.find(block => block.line === line));
    if (!table.sourceLines.length || new Set(table.sourceLines).size !== table.sourceLines.length || cells.some(cell => !cell || !contains(table.box, cell, ADJACENCY))) fail(`table source L${table.sourceLines[0]} has invalid cell ownership.`);
    if (table.captionLine !== undefined && (!caption || !tableCaption(caption.text) || !parallelColumns(cells as PdfTextBlock[]))) fail(`table L${table.captionLine} lacks a formal caption and aligned parallel cell ownership.`);
    if (table.captionLine === undefined && (!strictGrid(cells as PdfTextBlock[]) || (table.horizontalRuleOperations?.length ?? 0) < 2)) fail(`unnumbered table source L${table.sourceLines[0]} lacks independent outer rules and a strict prose-bearing grid.`);
    table.rows = cellRows(cells as PdfTextBlock[]).map(row => row.map(cell => cell.line));
    table.sourceLines = table.rows.flat();
    if (table.firstSourceLine !== undefined && table.firstSourceLine !== table.sourceLines[0]) fail(`table ${table.id ?? ''} has an invalid first source line.`);
    table.firstSourceLine = table.sourceLines[0];
    table.id ??= `p${input.page}-tableL${table.firstSourceLine}`;
  }
  if (new Set(tableRegions.map(table => table.id)).size !== tableRegions.length) fail('multiple table regions reuse the same table identity.');
  const tableOwners = new Map<string, number[]>();
  for (const group of groups) {
    const native = nativeCandidates(group);
    if (native.length > 1) fail(`operator ${group.operator} is contained by native owners ${native.map(([id]) => id).join(', ')}.`);
    // An interior fraction bar remains native math, even inside a real table.
    if (native.length === 1) { const id = native[0][0], operators = nativeOwners.get(id) ?? []; operators.push(group.operator); nativeOwners.set(id, operators); assigned.add(group.operator); continue; }
    const candidates = tableRegions.filter(table => group.boxes.every(box => thinRule(box) && contains(table.box, box, ADJACENCY)));
    if (candidates.length > 1) fail(`operator ${group.operator} belongs to multiple table regions ${candidates.map(table => table.id).join(', ')}.`);
    if (candidates.length === 1) {
      const table = candidates[0];
      const sharedNative = [...nativeRegions].filter(([, region]) => group.boxes.some(box => contains(region.box, box)));
      if (sharedNative.length) fail(`operator ${group.operator} mixes table rules with native ink ${sharedNative.map(([id]) => id).join(', ')}.`);
      const foreign = blocks.filter(block => !table.sourceLines.includes(block.line) && textInkBoxes(block).some(ink => group.boxes.some(box => overlaps(box, ink))));
      if (foreign.length) fail(`table rule operator ${group.operator} overlaps unowned source lines ${foreign.map(block => block.line).join(', ')}.`);
      const operators = tableOwners.get(table.id!) ?? []; operators.push(group.operator); tableOwners.set(table.id!, operators); assigned.add(group.operator);
      continue;
    }
    const partial = [...nativeRegions].filter(([, region]) => group.boxes.some(box => overlaps(region.box, box)));
    if (partial.length) fail(`operator ${group.operator} crosses native bounds ${partial.map(([id]) => id).join(', ')}.`);
  }
  const references: PdfVectorGraphicReference[] = [];
  for (const component of components(groups.filter(group => !assigned.has(group.operator)))) {
    const operators = component.map(group => group.operator), box = union(component.map(group => group.box));
    // Rendering a vector-only crop together with separately translated labels
    // must never duplicate or omit overlay text. Compare measured prose and
    // inline ink rather than the whitespace-filled paragraph union envelope.
    const overlay = blocks.filter(block => textInkBoxes(block).some(ink => overlaps(box, ink)));
    if (overlay.length) fail(`operators ${operators.join(', ')} overlap source text L${overlay.map(block => block.line).join(', L')}.`);
    const raster = rasters.filter(ref => overlaps(box, ref));
    if (raster.length) fail(`operators ${operators.join(', ')} overlap raster references ${raster.map(ref => ref.id).join(', ')}.`);
    const captions = nearbyCaptions(box);
    if (captions.length > 1) fail(`operators ${operators.join(', ')} have competing formal captions L${captions.map(block => block.line).join(', L')}.`);
    const caption = captions[0];
    references.push({ id: `p${input.page}-vector${references.length + 1}`, page: input.page, ...box, kind: 'vector', paintOperations: operators,
      ...(caption ? { caption: caption.text, captionLine: caption.line } : {}) });
    for (const operator of operators) { if (assigned.has(operator)) fail(`operator ${operator} has multiple owners.`); assigned.add(operator); }
  }
  if (assigned.size !== grouped.size) fail('not every visible paint operation has an owner.');
  return { references, tableRuleOwners: tableRegions.filter(table => tableOwners.has(table.id!)).map(table => ({ ...table, id: table.id!, firstSourceLine: table.firstSourceLine!, rows: table.rows!,
    paintOperations: tableOwners.get(table.id!)!, horizontalRuleOperations: tableOwners.get(table.id!)!.filter(operator => horizontalRule(union(grouped.get(operator)!))) })),
    nativeOwners: [...nativeOwners].map(([id, paintOperations]) => ({ id, paintOperations })) };
}
