import type { PdfBox, PdfReference, PdfTextBlock } from './pdfTypes.ts';

export interface PdfFigureGroup {
  id: string;
  page: number;
  referenceIds: string[];
  /** Physical source rows rendered inside the crop, never translated prose. */
  physicalLines: number[];
  box: PdfBox;
  captionLine?: number;
}

const overlaps = (a: PdfBox, b: PdfBox) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;
const union = (boxes: PdfBox[]): PdfBox => {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y };
};
const purePanelLabel = (block: PdfTextBlock) => /^\([a-z]\)$/u.test(block.text.trim())
  && !block.protection && !block.inlineProtections?.length;

/** Keep a multi-panel figure's original spatial relationships only when its
 * source crop has complete text ownership. Rejected candidates remain separate
 * references; no body, caption, or descriptive panel label is frozen. */
export function discoverPdfFigureGroups(page: number, images: PdfReference[], blocks: PdfTextBlock[]): PdfFigureGroup[] {
  const fail = (message: string): never => { throw new Error(`PDF page ${page}: invalid figure grouping evidence: ${message}`); };
  if (!Number.isSafeInteger(page) || page < 1) fail('invalid page identity.');
  const checkBox = (box: PdfBox, identity: string) => {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
      fail(`invalid source bounds for ${identity}.`);
  };
  const pageImages = images.filter(image => image.page === page);
  const pageBlocks = blocks.filter(block => block.page === page);
  const imageIds = new Set<string>(), lines = new Set<number>();
  for (const image of pageImages) {
    if (!image.id || imageIds.has(image.id)) fail(`duplicate or missing reference identity ${image.id}.`);
    imageIds.add(image.id); checkBox(image, image.id);
    if (image.captionLine !== undefined && (!Number.isSafeInteger(image.captionLine) || image.captionLine < 1))
      fail(`invalid caption association for ${image.id}.`);
  }
  for (const block of pageBlocks) {
    if (!Number.isSafeInteger(block.line) || block.line < 1 || lines.has(block.line)) fail(`duplicate or invalid physical line ${block.line}.`);
    lines.add(block.line); checkBox(block, `physical line ${block.line}`);
    if (!Number.isFinite(block.fontSize) || block.fontSize <= 0) fail(`missing source font size for physical line ${block.line}.`);
  }
  const rasters = pageImages.filter(image => image.kind !== 'vector').sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  if (rasters.length < 2) return [];

  const candidate = (members: PdfReference[]): Omit<PdfFigureGroup, 'id'> | undefined => {
    if (members.length < 2) return undefined;
    const labels: PdfTextBlock[] = [];
    for (const block of pageBlocks) {
      if (!purePanelLabel(block)) continue;
      const owners = members.filter(image => block.x >= image.x && block.x + block.width <= image.x + image.width
        && block.y >= image.y + image.height - 0.001 && block.y - image.y - image.height <= 2 * block.fontSize);
      if (owners.length > 1) return undefined;
      if (owners.length === 1) labels.push(block);
    }
    const box = union([...members, ...labels]);
    const labelIds = new Set(labels.map(label => label.line));
    // Check the expanded ROI too: an otherwise safe label can extend the crop
    // into a foreign caption, formula, or descriptive line in another column.
    if (pageBlocks.some(block => overlaps(box, block) && !labelIds.has(block.line))) return undefined;
    const memberIds = new Set(members.map(member => member.id));
    if (pageImages.some(image => !memberIds.has(image.id) && overlaps(box, image))) return undefined;
    const captionLine = members[0].captionLine;
    return { page, referenceIds: members.map(member => member.id), physicalLines: labels.map(label => label.line).sort((a, b) => a - b), box,
      ...(captionLine !== undefined && members.every(member => member.captionLine === captionLine) ? { captionLine } : {}) };
  };

  const whole = candidate(rasters);
  if (whole) return [{ id: `p${page}-figure-group-1`, ...whole }];
  const rows: PdfReference[][] = [];
  for (const image of rasters) {
    const row = rows.at(-1);
    if (row && Math.abs(image.y - row[0].y) <= 2) row.push(image);
    else rows.push([image]);
  }
  const results: PdfFigureGroup[] = [], usedReferences = new Set<string>(), usedLines = new Set<number>();
  for (const row of rows) {
    const group = candidate(row);
    if (!group || group.referenceIds.some(id => usedReferences.has(id)) || group.physicalLines.some(line => usedLines.has(line))) continue;
    group.referenceIds.forEach(id => usedReferences.add(id)); group.physicalLines.forEach(line => usedLines.add(line));
    results.push({ id: `p${page}-figure-group-${results.length + 1}`, ...group });
  }
  return results;
}
