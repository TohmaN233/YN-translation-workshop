import { createHash } from "node:crypto";
export const PDF_LAYOUT_VERSION = 3;
export const PDF_EXTRACTOR_REVISION = 4;
export interface PdfBox { x: number; y: number; width: number; height: number }
export interface PdfProseSegment { text: string; boxes: PdfBox[] }
export interface PdfInlineProtection extends PdfBox {
  token: string; text: string; kind: 'code' | 'math'; paintOperations: number[];
  /** Actual retained glyph/path ink, including scripts and overhang. */
  inkBox?: PdfBox;
}
export interface PdfTextBlock extends PdfBox {
  line: number; page: number; text: string; fontSize: number;
  color?: [number, number, number];
  protection?: "code" | "math";
  segmentation?: 'paragraph' | 'protected' | 'parallel-region';
  /** One logical paragraph, with immutable inline nodes and original prose flow areas. */
  inlineProtections?: PdfInlineProtection[];
  proseSegments?: PdfProseSegment[];
  /** Original text paint operations retained in the page background. */
  paintOperations?: number[];
  /** Actual native renderer ink envelope for unchanged numeric glyphs. */
  sourceInkBox?: PdfBox;
  sourceInkPath?: string; sourceInkHash?: string;
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
  version: number; extractorRevision: number; originalPath: string; originalHash: string;
  sourcePath: string; sourceHash: string;
  protectionHash: string;
  pages: PdfPageLayout[]; blocks: PdfTextBlock[]; references: PdfReference[];
}

export function pdfProtectionHash(layout: PdfLayout): string {
  return createHash("sha256").update(JSON.stringify({ version: layout.version, extractorRevision: layout.extractorRevision, originalHash: layout.originalHash, sourceHash: layout.sourceHash,
    blocks: layout.blocks.map(block => ({ line: block.line, page: block.page, text: block.text, protection: block.protection, paintOperations: block.paintOperations,
      segmentation:block.segmentation, inlineProtections: block.inlineProtections, proseSegments: block.proseSegments, sourceInkBox: block.sourceInkBox, sourceInkHash: block.sourceInkHash })) })).digest("hex");
}

/** Reject corrupt derived geometry before exposing references or replacing an export. */
export function validatePdfLayout(value: unknown): asserts value is PdfLayout {
  const layout = value as PdfLayout;
  const digest = (input: unknown) => typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
  const positive = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input > 0;
  if (!layout || layout.version !== PDF_LAYOUT_VERSION || layout.extractorRevision !== PDF_EXTRACTOR_REVISION || typeof layout.originalPath !== "string" || typeof layout.sourcePath !== "string"
    || !digest(layout.originalHash) || !digest(layout.sourceHash) || !digest(layout.protectionHash) || !Array.isArray(layout.pages) || !layout.pages.length
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
    if(block.segmentation!==undefined&&!['paragraph','protected','parallel-region'].includes(block.segmentation))throw new Error('Invalid PDF paragraph segmentation.');
    if (block.sourceInkBox) checkBox({...block.sourceInkBox,page:block.page});
    if (!block.protection && /^\d+$/u.test(block.text) && (!block.sourceInkBox || typeof block.sourceInkPath !== "string" || !digest(block.sourceInkHash))) throw new Error("Numeric PDF text lacks native ink geometry.");
    if (block.protection !== undefined && block.protection !== "code" && block.protection !== "math") throw new Error("Invalid PDF protection kind.");
    if (block.protection !== undefined && (!Array.isArray(block.paintOperations) || !block.paintOperations.length
      || block.paintOperations.some(op => !Number.isInteger(op) || op < 0))) throw new Error("Protected PDF text lacks original paint ownership.");
    if (block.protection === undefined && block.paintOperations !== undefined) throw new Error("Unprotected PDF block claims retained text paints.");
    if (block.inlineProtections !== undefined || block.proseSegments !== undefined) {
      if (block.protection || !Array.isArray(block.inlineProtections)
        || !Array.isArray(block.proseSegments) || block.proseSegments.length !== block.inlineProtections.length+1) throw new Error('Invalid PDF paragraph inline structure.');
      const tokens=new Set<string>();
      for (const fragment of block.inlineProtections) {
        if (!fragment || !/^\{\{(?:formula|code):p\d+:\d+\}\}$/u.test(fragment.token) || tokens.has(fragment.token)
          || !fragment.text || /[\r\n]/u.test(fragment.text) || !['code','math'].includes(fragment.kind)
          || !Array.isArray(fragment.paintOperations) || !fragment.paintOperations.length
          || fragment.paintOperations.some(op=>!Number.isInteger(op)||op<0)) throw new Error('Invalid immutable PDF inline node.');
        tokens.add(fragment.token);checkBox({...fragment,page:block.page});
        if (!fragment.inkBox) throw new Error('PDF inline node lacks native ink geometry.');
        checkBox({...fragment.inkBox,page:block.page});
      }
      for (const segment of block.proseSegments) {
        if (!segment || typeof segment.text!=='string' || /[\r\n]/u.test(segment.text) || !Array.isArray(segment.boxes)
          || (segment.text.trim() && !segment.boxes.length)) throw new Error('Invalid PDF paragraph prose segment.');
        for (const box of segment.boxes) checkBox({...box,page:block.page});
      }
      const text=block.proseSegments.map((segment,index)=>segment.text+(block.inlineProtections![index]?.token??'')).join('');
      if (text!==block.text || !block.proseSegments.some(segment=>segment.text.trim())) throw new Error('PDF paragraph source differs from its inline structure.');
    }
  }
  const ids = new Set<string>();
  if (layout.protectionHash !== pdfProtectionHash(layout)) throw new Error("PDF protection binding changed.");
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
