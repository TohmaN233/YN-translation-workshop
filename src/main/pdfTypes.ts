export const PDF_LAYOUT_VERSION = 1;
export interface PdfBox { x: number; y: number; width: number; height: number }
export interface PdfTextBlock extends PdfBox {
  line: number; page: number; text: string; fontSize: number;
  color?: [number, number, number];
}
export interface PdfReference extends PdfBox {
  id: string; page: number; caption?: string; captionLine?: number;
}
export interface PdfPageLayout {
  page: number; width: number; height: number;
  backgroundPath: string; backgroundHash: string;
  previewPath: string; previewHash: string;
}
/** One UTF-8 physical line per PDF text block; geometry is kept outside model text. */
export interface PdfLayout {
  version: number; originalPath: string; originalHash: string;
  sourcePath: string; sourceHash: string;
  pages: PdfPageLayout[]; blocks: PdfTextBlock[]; references: PdfReference[];
}

/** Reject corrupt derived geometry before exposing references or replacing an export. */
export function validatePdfLayout(value: unknown): asserts value is PdfLayout {
  const layout = value as PdfLayout;
  const digest = (input: unknown) => typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
  const positive = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input > 0;
  if (!layout || layout.version !== PDF_LAYOUT_VERSION || typeof layout.originalPath !== "string" || typeof layout.sourcePath !== "string"
    || !digest(layout.originalHash) || !digest(layout.sourceHash) || !Array.isArray(layout.pages) || !layout.pages.length
    || !Array.isArray(layout.blocks) || !layout.blocks.length || !Array.isArray(layout.references)) throw new Error("Invalid PDF layout binding.");
  for (const [index, page] of layout.pages.entries()) {
    if (!page || page.page !== index + 1 || !positive(page.width) || !positive(page.height)
      || typeof page.backgroundPath !== "string" || typeof page.previewPath !== "string"
      || !digest(page.backgroundHash) || !digest(page.previewHash)) throw new Error(`Invalid PDF page geometry or assets: ${index+1}.`);
  }
  const checkBox = (box: PdfBox & { page: number }) => {
    const page = layout.pages[box.page-1];
    if (!Number.isInteger(box.page) || !page || !Number.isFinite(box.x) || !Number.isFinite(box.y)
      || !positive(box.width) || !positive(box.height) || box.x < -1 || box.y < -1
      || box.x + box.width > page.width + 2 || box.y + box.height > page.height + 2) throw new Error("Invalid PDF content bounds.");
  };
  for (const [index, block] of layout.blocks.entries()) {
    if (!block || block.line !== index+1 || typeof block.text !== "string" || !block.text.trim() || /[\r\n]/.test(block.text)
      || !positive(block.fontSize) || (block.color !== undefined && (!Array.isArray(block.color) || block.color.length !== 3
        || block.color.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)))) throw new Error(`Invalid PDF text block: ${index+1}.`);
    checkBox(block);
  }
  const ids = new Set<string>();
  for (const ref of layout.references) {
    if (!ref || typeof ref.id !== "string" || !ref.id || ids.has(ref.id) || (ref.caption !== undefined && typeof ref.caption !== "string")
      || (ref.captionLine !== undefined && layout.blocks[ref.captionLine-1]?.page !== ref.page)) throw new Error("Invalid PDF reference identity.");
    ids.add(ref.id); checkBox(ref);
  }
}
export type PdfWorkerOperation =
  | { kind: "extract"; originalPath: string; projectRoot: string; sourcePath: string; fontPath: string }
  | { kind: "export"; layoutPath: string; projectRoot: string; lines: string[]; outputPath: string; fontPath: string }
  | { kind: "reference"; projectRoot: string; bytes: Uint8Array; box: PdfBox; pageWidth: number; pageHeight: number };
