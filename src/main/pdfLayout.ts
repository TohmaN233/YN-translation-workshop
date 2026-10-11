import type { PdfBox, PdfTextBlock } from "./pdfTypes.ts";

interface PdfTextItem { str: string; transform: number[]; width: number; height: number; dir: string; hasEOL: boolean; color?: [number, number, number]; protection?: "code" | "math"; paintOperations?: number[] }

/** Keep PDF reading order, merging adjacent runs and wrapped lines only inside one column. */
export function pdfTextBlocks(items: Array<PdfTextItem | { type: string }>, viewport: { transform: number[] }, page: number): PdfTextBlock[] {
  const [a, b, c, d, e, f] = viewport.transform;
  const rows: Array<PdfTextBlock & { endsLine: boolean }> = [];
  for (const item of items) {
    if (!("str" in item) || !item.str.trim()) continue;
    if (item.dir === "ttb" || Math.abs(a*item.transform[2]+c*item.transform[3]) > 0.01
      || Math.abs(b*item.transform[0]+d*item.transform[1]) > 0.01) {
      throw new Error(`PDF page ${page} contains vertical/rotated text. Convert it to a horizontal text PDF before importing.`);
    }
    const tx = item.transform[4], ty = item.transform[5];
    const size = Math.max(1, Math.hypot(item.transform[2], item.transform[3]));
    const block = { x: a * tx + c * ty + e, y: b * tx + d * ty + f - size,
      width: Math.max(item.width, 1), height: size * 1.25, fontSize: size,
      line: 0, page, text: item.str.replace(/[\r\n]+/g, " "), endsLine: item.hasEOL, color: item.color,
      protection: item.protection, paintOperations: item.protection ? item.paintOperations : undefined };
    const prior = rows.at(-1);
    const sameRow = prior && Math.abs(prior.y - block.y) < size * 0.35
      && block.x >= prior.x && block.x - (prior.x + prior.width) < size * 1.5
      && JSON.stringify(prior.color) === JSON.stringify(block.color);
    if (sameRow && prior.protection === block.protection) {
      const gap = block.x - (prior.x + prior.width);
      prior.text += (gap > size * 0.2 && !/\s$/.test(prior.text) ? " " : "") + block.text;
      prior.width = Math.max(prior.width, block.x + block.width - prior.x);
      prior.height = Math.max(prior.height, block.height);
      prior.endsLine = block.endsLine;
      if (prior.protection) prior.paintOperations = [...new Set([...(prior.paintOperations ?? []), ...(block.paintOperations ?? [])])];
    } else rows.push(block);
  }
  const paragraphs: PdfTextBlock[] = [];
  for (const row of rows) {
    const prior = paragraphs.at(-1);
    const wrapped = prior && !prior.protection && !row.protection && Math.abs(prior.fontSize - row.fontSize) < row.fontSize * 0.1
      && Math.abs(prior.x - row.x) < row.fontSize * 0.75
      && row.y > prior.y && row.y - (prior.y + prior.height) < row.fontSize * 0.5
      && row.y - (prior.y + prior.height) > -row.fontSize * 0.35
      && prior.width > row.fontSize * 12
      && JSON.stringify(prior.color) === JSON.stringify(row.color)
      && !/^(?:Fig(?:ure)?\.?|Table|図|图|表)\s*[\d一二三四五六七八九十]/iu.test(row.text);
    if (wrapped) {
      const joiner = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(prior.text) ? "" : " ";
      prior.text += joiner + row.text;
      prior.width = Math.max(prior.width, row.width);
      prior.height = row.y + row.height - prior.y;
    } else { const { endsLine: _endsLine, ...block } = row; paragraphs.push(block); }
  }
  return paragraphs;
}

export function intersects(a: PdfBox, b: PdfBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Wrap at words where possible; CJK graphemes may wrap between characters. */
export function wrapPdfText(text: string, width: number, measure: (text: string) => number): string[] {
  const rows: string[] = [];
  let current = "";
  for (const token of text.match(/[^\S\r\n]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    if (measure(current + token) <= width) { current += token; continue; }
    if (current.trim()) rows.push(current.trimEnd());
    current = token.trimStart();
    if (measure(current) > width) {
      let part = "";
      for (const character of current) {
        if (measure(part + character) > width && part) { rows.push(part); part = ""; }
        if (measure(character) > width) throw new Error("PDF text box is narrower than one glyph.");
        part += character;
      }
      current = part;
    }
  }
  if (current.trim()) rows.push(current.trimEnd());
  return rows;
}
