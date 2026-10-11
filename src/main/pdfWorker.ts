import { parentPort, workerData } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { pdfTextBlocks, wrapPdfText } from "./pdfLayout.ts";
import { decodeProjectPaths, encodeProjectPaths } from "./projectPaths.ts";
import { PDF_LAYOUT_VERSION, validatePdfLayout, type PdfLayout, type PdfReference, type PdfWorkerOperation } from "./pdfTypes.ts";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const input = workerData as PdfWorkerOperation;
const progress = (page: number, total: number) => parentPort?.postMessage({ type: "progress", page, total });

async function atomic(file: string, bytes: string | Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(temp, bytes); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

async function openPdf(file: string) {
  const bytes = await readFile(file);
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes),
    cMapUrl: path.join(pdfjsRoot, "cmaps").replace(/\\/g, "/") + "/",
    standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts").replace(/\\/g, "/") + "/",
    wasmUrl: path.join(pdfjsRoot, "wasm").replace(/\\/g, "/") + "/", useSystemFonts: false,
    stopAtErrors: true });
  const pdf = await loading.promise;
  return { pdf, hash: digest(bytes), destroy: () => loading.destroy() };
}

function imageReferences(ops: { fnArray: number[]; argsArray: any[] }, viewport: any, page: number): PdfReference[] {
  const result: PdfReference[] = [];
  const stack: number[][] = [];
  let matrix = [...viewport.transform];
  const apply = (m: number[], n: number[]) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    if (op === pdfjs.OPS.save) stack.push([...matrix]);
    else if (op === pdfjs.OPS.restore) matrix = stack.pop() ?? [...viewport.transform];
    else if (op === pdfjs.OPS.transform) matrix = apply(matrix, args);
    else if (op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject) {
      const points = [[0,0],[0,1],[1,0],[1,1]].map(([x,y]) => [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]]);
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
      const width = Math.min(viewport.width, Math.max(...xs)) - x, height = Math.min(viewport.height, Math.max(...ys)) - y;
      if (width > 4 && height > 4) result.push({ id: `p${page}-image${result.length+1}`, page, x, y, width, height });
    }
  }
  return result;
}

function textColors(ops: { fnArray: number[]; argsArray: any[] }) {
  let color: [number, number, number] = [0,0,0];
  const stack: typeof color[] = [], paints: Array<{ text: string; color: typeof color }> = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    if (op === pdfjs.OPS.save) stack.push([...color]);
    else if (op === pdfjs.OPS.restore) color = stack.pop() ?? [0,0,0];
    else if (op === pdfjs.OPS.setFillRGBColor && /^#[\da-f]{6}$/i.test(args[0])) color = [1,3,5].map(offset => parseInt(args[0].slice(offset,offset+2),16)/255) as typeof color;
    else if (op === pdfjs.OPS.setTextRenderingMode && args[0] === 3) throw new Error("PDF contains hidden OCR text. Remove the scanned text image or convert it to a native text PDF before translation.");
    else if (op === pdfjs.OPS.setTextRenderingMode && args[0] >= 4) throw new Error("PDF uses text as a clipping mask; this layout cannot be reconstructed safely.");
    else if (op === pdfjs.OPS.showText || op === pdfjs.OPS.showSpacedText) {
      paints.push({ text: args[0].filter((glyph: any) => typeof glyph === "object").map((glyph: any) => glyph.unicode ?? "").join(""), color: [...color] });
    }
  }
  return paints;
}

async function extract() {
  if (input.kind !== "extract") throw new Error("Invalid PDF extraction operation.");
  const { pdf, hash, destroy } = await openPdf(input.originalPath);
  const directory = path.join(path.dirname(input.sourcePath), `pdf-${hash.slice(0, 16)}-v${PDF_LAYOUT_VERSION}`);
  await mkdir(directory, { recursive: true });
  const layout: PdfLayout = { version: PDF_LAYOUT_VERSION, originalPath: input.originalPath, originalHash: hash,
    sourcePath: input.sourcePath, sourceHash: "", blocks: [], pages: [], references: [] };
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const ops = await page.getOperatorList();
      const paints = textColors(ops);
      let paintIndex = 0, paintOffset = 0;
      const styledItems = content.items.map(item => {
        if (!("str" in item) || !item.str.trim()) return item;
        const text = item.str.replace(/\s/g, "");
        for (let index = paintIndex; index < paints.length; index++) {
          const painted = paints[index].text.replace(/\s/g, ""), offset = painted.indexOf(text, index === paintIndex ? paintOffset : 0);
          if (offset < 0) continue;
          paintIndex = index; paintOffset = offset + text.length;
          if (paintOffset >= painted.length) { paintIndex++; paintOffset = 0; }
          return { ...item, color: paints[index].color };
        }
        return item;
      });
      const blocks = pdfTextBlocks(styledItems, viewport, number);
      const images = imageReferences(ops, viewport, number);
      if (!blocks.length && images.some(image => image.width*image.height > viewport.width*viewport.height*0.65)) {
        throw new Error(`PDF page ${number} appears to be scanned and has no text layer. OCR is required before translation.`);
      }
      if (images.some(image => image.width*image.height > viewport.width*viewport.height*0.65
        && blocks.some(block => block.x < image.x+image.width && block.x+block.width > image.x && block.y < image.y+image.height && block.y+block.height > image.y))) {
        throw new Error(`PDF page ${number} has text over a full-page raster image. Its original text cannot be removed safely; use a native text PDF instead.`);
      }
      blocks.forEach(block => { block.line = layout.blocks.length + 1; layout.blocks.push(block); });
      const captions = blocks.filter(block => /^(?:Fig(?:ure)?\.?|Table|図|图|表)\s*[\d一二三四五六七八九十]/iu.test(block.text));
      for (const image of images) {
        const caption = captions.map(block => ({ block, distance: Math.abs(block.y - image.y - image.height) }))
          .filter(item => item.distance < 100).sort((a,b) => a.distance-b.distance)[0]?.block;
        if (caption) { image.caption = caption.text; image.captionLine = caption.line; }
      }
      layout.references.push(...captions.filter(caption => !images.some(image => image.captionLine === caption.line)).map(caption => ({
        id: `p${number}-caption${caption.line}`, page: number, x: 0, y: 0, width: viewport.width, height: viewport.height,
        caption: caption.text, captionLine: caption.line
      })));
      layout.references.push(...images, { id: `p${number}-page`, page: number, x: 0, y: 0, width: viewport.width, height: viewport.height,
        caption: "Page layout / vector figures and tables" });
      const scale = Math.min(2, 3000 / Math.max(viewport.width, viewport.height));
      const renderedViewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(renderedViewport.width), Math.ceil(renderedViewport.height));
      await page.render({ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport: renderedViewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
      const preview = canvas.toBuffer("image/png");
      const previewPath = path.join(directory, `page-${number}.png`);
      await atomic(previewPath, preview);
      const textPaint = new Set([pdfjs.OPS.showText, pdfjs.OPS.showSpacedText, pdfjs.OPS.nextLineShowText, pdfjs.OPS.nextLineSetSpacingShowText]);
      await page.render({ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport: renderedViewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE, operationsFilter: (index, list) => !textPaint.has(list.fnArray[index]) }).promise;
      const background = canvas.toBuffer("image/png");
      const backgroundPath = path.join(directory, `background-${number}.png`);
      await atomic(backgroundPath, background);
      layout.pages.push({ page: number, width: viewport.width, height: viewport.height, previewPath, previewHash: digest(preview), backgroundPath, backgroundHash: digest(background) });
      canvas.width = canvas.height = 1;
      page.cleanup(); progress(number, pdf.numPages);
    }
    if (!layout.blocks.length) throw new Error("PDF contains no extractable text. OCR is required before translation.");
    const text = layout.blocks.map(block => block.text).join("\n");
    layout.sourceHash = digest(text);
    if (digest(await readFile(input.originalPath)) !== hash) throw new Error("PDF changed during extraction; no projection was committed.");
    await atomic(input.sourcePath, text);
    // Commit the manifest last: incomplete image extraction never becomes usable.
    await atomic(input.sourcePath + ".pdf-layout.json", JSON.stringify(encodeProjectPaths(layout, input.projectRoot)));
    return { sourcePath: input.sourcePath, sourceHash: layout.sourceHash, originalHash: hash, pages: pdf.numPages, lines: layout.blocks.length };
  } finally { await destroy(); }
}

async function exportPdf() {
  if (input.kind !== "export") throw new Error("Invalid PDF export operation.");
  const layout = decodeProjectPaths(JSON.parse(await readFile(input.layoutPath, "utf8")) as PdfLayout, input.projectRoot);
  validatePdfLayout(layout);
  if (layout.version !== PDF_LAYOUT_VERSION || digest(await readFile(layout.originalPath)) !== layout.originalHash
    || digest(await readFile(layout.sourcePath)) !== layout.sourceHash) throw new Error("PDF source or projection changed. Regenerate the review before exporting.");
  if (input.lines.length !== layout.blocks.length || input.lines.some((line, i) => typeof line !== "string" || /[\r\n]/.test(line) || (layout.blocks[i].text.trim() && !line.trim()))) {
    throw new Error("PDF export requires one non-empty translated line per source block, without extra physical line breaks.");
  }
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(input.fontPath), { subset: false });
  const characterSet = new Set(font.getCharacterSet());
  const blocksByPage = new Map<number, typeof layout.blocks>();
  for (const block of layout.blocks) {
    const blocks = blocksByPage.get(block.page) ?? [];
    blocks.push(block); blocksByPage.set(block.page, blocks);
  }
  for (const pageLayout of layout.pages) {
    const page = pdf.addPage([pageLayout.width, pageLayout.height]);
    const background = await readFile(pageLayout.backgroundPath);
    if (digest(background) !== pageLayout.backgroundHash) throw new Error(`PDF page ${pageLayout.page} background asset changed.`);
    page.drawImage(await pdf.embedPng(background), { x: 0, y: 0, width: pageLayout.width, height: pageLayout.height });
    for (const block of blocksByPage.get(pageLayout.page) ?? []) {
      const text = input.lines[block.line - 1];
      for (const character of text) if (!characterSet.has(character.codePointAt(0)!)) {
        throw new Error(`PDF L${block.line}: bundled font cannot render ${JSON.stringify(character)}.`);
      }
      let size = block.fontSize, rows: string[] = [];
      const minSize = Math.min(size, Math.max(6, size * 0.65));
      for (;;) {
        rows = wrapPdfText(text, block.width, value => font.widthOfTextAtSize(value, size));
        if (rows.length * size * 1.2 <= block.height + 0.5) break;
        if (size <= minSize) throw new Error(`PDF page ${block.page} L${block.line}: translation does not fit its text box. Shorten this line before exporting; no text was clipped and no output was replaced.`);
        size = Math.max(minSize, size - 0.25);
      }
      rows.forEach((row, index) => page.drawText(row, { x: block.x, y: pageLayout.height - block.y - size - index * size * 1.2, size, font, color: rgb(...(block.color ?? [0,0,0])) }));
    }
    progress(pageLayout.page, layout.pages.length);
  }
  const bytes = await pdf.save();
  await atomic(input.outputPath, bytes);
  return { outputPath: input.outputPath, pages: layout.pages.length };
}

async function referenceImage() {
  if (input.kind !== "reference") throw new Error("Invalid PDF reference operation.");
  const image = await loadImage(Buffer.from(input.bytes));
  const scaleX = image.width/input.pageWidth, scaleY = image.height/input.pageHeight, ref = input.box;
  const canvas = createCanvas(Math.max(1, Math.ceil(ref.width*scaleX)), Math.max(1, Math.ceil(ref.height*scaleY)));
  try {
    canvas.getContext("2d").drawImage(image, ref.x*scaleX, ref.y*scaleY, ref.width*scaleX, ref.height*scaleY, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toBuffer("image/png").toString("base64") };
  } finally { canvas.width = canvas.height = 1; }
}

try { parentPort?.postMessage({ type: "result", result: input.kind === "extract" ? await extract() : input.kind === "reference" ? await referenceImage() : await exportPdf() }); }
catch (error) { parentPort?.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
