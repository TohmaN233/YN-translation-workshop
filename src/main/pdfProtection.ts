import type { PdfTextBlock } from "./pdfTypes.ts";

type Kind = NonNullable<PdfTextBlock["protection"]>;
interface TextItem {
  str: string; fontName: string; transform: number[]; width: number; height: number; dir: string; hasEOL: boolean;
  color?: [number, number, number]; protection?: Kind; paintOperations?: number[];
}
export interface PdfTextPaint { text: string; color: [number, number, number]; operator: number }

/** PDF structure roles take precedence; untagged text requires concrete font/syntax evidence. */
export function protectPdfText(content: { items: any[]; styles: Record<string, { fontFamily: string }> },
  structure: any, paints: PdfTextPaint[], fontName: (id: string) => string, page: number) {
  const roles = new Map<string, Kind>();
  const visit = (node: any, inherited?: Kind) => {
    const role = node.role === "Code" ? "code" : node.role === "Formula" ? "math" : inherited;
    if (node.type === "content" && role) roles.set(node.id, role);
    for (const child of node.children ?? []) visit(child, role);
  };
  if (structure) visit(structure);
  const stack: Array<Kind | undefined> = [];
  const items: TextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item)) {
      if (item.type === "endMarkedContent") stack.pop();
      else stack.push(roles.get(item.id) ?? (item.tag === "Code" ? "code" : item.tag === "Formula" ? "math" : stack.at(-1)));
      continue;
    }
    if (!item.str.trim()) continue;
    const name = `${fontName(item.fontName)} ${content.styles[item.fontName]?.fontFamily ?? ""}`;
    const mathFont = /(?:CambriaMath|STIX.*Math|LatinModernMath|CMSY|CMMI|CMEX|MathJax|Symbol|Mathematical)/i.test(name);
    items.push({ ...item, protection: stack.at(-1) ?? (mathFont ? "math" : undefined) });
  }
  // Work within text rows, never across columns or paragraph boundaries.
  const rows: TextItem[][] = [];
  for (const item of items) {
    const row = rows.at(-1), previous = row?.at(-1);
    const size = Math.hypot(item.transform[2], item.transform[3]);
    if (previous && Math.abs(previous.transform[5] - item.transform[5]) < size * .4
      && item.transform[4] >= previous.transform[4]
      && item.transform[4] - previous.transform[4] - previous.width < size * 1.5) row!.push(item);
    else rows.push([item]);
  }
  const detect = (text: string, mono: boolean): Kind | undefined => {
    const code = /^(?:(?:const|let|var)\s+\w+\s*[:=]|(?:function|def)\s+\w+\s*\(|(?:print|printf|if|for|while)\s*\(|return\s+.+;$|#include\s*[<"]|[{};]+$)/u.test(text)
      || mono && /(?:^\s*\/\/|^\s*#|[{};]|\w\s*(?:=|:=|=>)\s*|\w\([^)]*\)|^\w+(?:\.\w+)+$|\+\+|--)/u.test(text);
    const math = /(?:[=≠≈≤≥∑∏∫√∞∂∇]|\w\s*\^\s*\w|[α-ωΑ-Ω]\s*[+−*/]|\b[a-zA-Z]\s*[+−*/×÷]\s*\w|\d\s*[+−*/×÷]\s*\w|\b(?:sin|cos|tan|log|exp|sqrt|f|g)\s*\()/u.test(text);
    if (!code && !math) return undefined;
    // Only explicit string literals/comments may carry natural prose inside code.
    const syntax = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""').replace(/\/\/.*$|^\s*#(?!include).*$/g, "");
    const tail = syntax.match(/;\s*(.+)$/)?.[1];
    const mixedCode = code && (tail && !/^(?:(?:const|let|var|return)\s|[{}]|\w+\s*[(=])/u.test(tail)
      || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(syntax)
      || /(?:=|\))[^;{}]*\b[A-Za-z]+\s+[A-Za-z]+\s+[A-Za-z]+/u.test(syntax));
    const words = text.match(/[A-Za-z]{3,}/g) ?? [];
    const tokens = text.match(/(?:\d+(?:\.\d+)?|[\p{L}_][\p{L}\d_]*|[^\s])/gu) ?? [];
    const identifier = (token: string) => /^[\p{L}_][\p{L}\d_]*$/u.test(token);
    const adjacentWords = tokens.some((token,index) => identifier(token) && identifier(tokens[index+1] ?? "")
      && !/^(?:sin|cos|tan|log|exp|lim|sum|max|min|sqrt)$/i.test(token));
    const mixedMath = !code && (adjacentWords || /[.!?。！？]$/u.test(text) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
      || words.some(word => !/^(?:sin|cos|tan|log|exp|lim|sum|max|min|sqrt|frac|alpha|beta|gamma|theta|delta|int)$/i.test(word)));
    if (mixedCode || mixedMath) throw new Error(`PDF page ${page}: code/formula is mixed with unmarked prose (${text.slice(0,120)}). Tag or separate the protected content before importing.`);
    return code ? "code" : "math";
  };
  const mono = (item: TextItem) => /(?:monospace|Courier|Consolas|Mono|Code)/i.test(`${fontName(item.fontName)} ${content.styles[item.fontName]?.fontFamily ?? ""}`);
  for (const row of rows) {
    const unprotected = row.filter(item => !item.protection);
    if (!unprotected.length) continue;
    // Independent text runs can separate complete code from neighboring prose.
    // Otherwise classify the complete row (e.g. a formula split into glyph runs).
    const kinds = unprotected.map(item => detect(item.str.trim(), mono(item)));
    if (kinds.some(Boolean) && kinds.some(kind => !kind)) {
      for (const [index,item] of unprotected.entries()) item.protection = kinds[index];
    } else {
      const kind = detect(unprotected.map(item => item.str).join(" ").trim(), unprotected.some(mono));
      if (kind) for (const item of unprotected) item.protection = kind;
    }
  }
  const compact = (text: string) => text.replace(/\s/g, "");
  const segments: Array<{ paint: PdfTextPaint; start: number; end: number; covered: number; kinds: Set<Kind | undefined> }> = [];
  let all = "";
  for (const paint of paints) {
    const text = compact(paint.text), start = all.length; all += text;
    if (text) segments.push({ paint, start, end: all.length, covered: 0, kinds: new Set() });
  }
  let cursor = 0;
  for (const item of items) {
    const text = compact(item.str), start = all.indexOf(text, cursor);
    if (start < 0) {
      if (item.protection) throw new Error(`PDF page ${page}: cannot bind protected text to its original paint operations.`);
      continue;
    }
    const end = start + text.length; cursor = end;
    const matches = segments.filter(segment => segment.start < end && segment.end > start);
    item.color = matches[0]?.paint.color;
    for (const segment of matches) {
      segment.covered += Math.min(segment.end, end) - Math.max(segment.start, start);
      segment.kinds.add(item.protection);
    }
    if (item.protection) item.paintOperations = matches.map(segment => segment.paint.operator);
  }
  const retained = new Set<number>();
  for (const segment of segments) {
    if (![...segment.kinds].some(kind => kind !== undefined)) continue;
    if (segment.kinds.has(undefined) || segment.kinds.size !== 1 || segment.covered !== segment.end-segment.start) {
      throw new Error(`PDF page ${page}: protected content shares a text paint with prose or unbound glyphs; safe separation is required before importing.`);
    }
    retained.add(segment.paint.operator);
  }
  return { items, retained };
}
