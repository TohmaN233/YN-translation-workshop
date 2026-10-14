import type { PdfBox, PdfTextBlock } from "./pdfTypes.ts";

type Kind = NonNullable<PdfTextBlock["protection"]>;
interface TextItem {
  str: string; fontName: string; transform: number[]; width: number; height: number; dir: string; hasEOL: boolean;
  color?: [number, number, number]; protection?: Kind; paintOperations?: number[];
  paragraphScope?: string;
  paintSpans?: PdfTextPaintSpan[];
}
export interface PdfTextPaint { text: string; color: [number, number, number]; operator: number }
/** Transient character ownership, removed before the layout is committed. */
export interface PdfTextPaintSpan { operator: number; start: number; end: number }

export function selectPdfPaintGlyphs(glyphs: any[], spans: PdfTextPaintSpan[], normalize: (text: string) => string): Set<number> {
  const selected = new Set<number>();
  let cursor = 0, covered = 0;
  for (const [index, glyph] of glyphs.entries()) {
    if (typeof glyph !== "object") continue;
    const text = normalize(glyph.unicode ?? "").replace(/\s/g, ""), end = cursor + text.length;
    const overlaps = spans.filter(span => span.start < end && span.end > cursor);
    if (text && overlaps.length) {
      if (!overlaps.some(span => span.start <= cursor && span.end >= end)) throw new Error("PDF text ownership splits an indivisible glyph.");
      selected.add(index); covered += text.length;
    }
    cursor = end;
  }
  if (covered !== spans.reduce((total, span) => total + span.end-span.start, 0)) throw new Error("PDF glyph ownership is incomplete or overlapping.");
  return selected;
}

const mathWord = /^(?:sin|cos|tan|log|exp|lim|sum|max|min|sup|inf|sqrt|frac|alpha|beta|gamma|theta|delta|int|deg|det|mod|arg|argmin|argmax|Pr|Var|Cov|diag|rank|tr|span|Re|Im|dist|cl|clip|conv|supp|ker|dim|card|ceil|floor|sgn|sign)$/i;
const mathRomanTypeface = (name: string) => /(?:^|[+\s])CM(?:R|SS|BX)[A-Z]*\d+/i.test(name);
// Roman operators and subscripts may use text fonts. Their complete contents
// must have math syntax before they can join a protected formula.
const mathFragment = (text: string) => {
  const tokens = text.match(/(?:\d+(?:\.\d+)?|[\p{L}_][\p{L}\d_]*|[^\s])/gu) ?? [];
  return tokens.length > 0 && tokens.every(token => /^[\p{L}_][\p{L}\d_]*$/u.test(token)
    ? /^(?:[A-Za-zα-ωΑ-Ω]|[A-Z]{2,})$/u.test(token) || mathWord.test(token)
    : /^(?:\d+(?:\.\d+)?|[\p{Sm}\p{Sk}\p{M}\p{Ps}\p{Pe}.,;:!|\\^_∥/−ˆˇˉ-]|[\u0000-\u001f])$/u.test(token));
};

/** A labelled Python panel is explicit layout evidence even with outlined/Type3 fonts.
 * Check every physical code row; a nearby code example must not freeze prose in the box.
 */
export function markPdfCodePanels(content: { items: any[] }, areas: PdfBox[], transform: number[]) {
  const [a,b,c,d,e,f] = transform;
  const positioned = content.items.flatMap((item,index) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const size = Math.hypot(item.transform[2],item.transform[3]);
    return [{ item,index,size,x:a*item.transform[4]+c*item.transform[5]+e,
      y:b*item.transform[4]+d*item.transform[5]+f-size }];
  });
  const checkNumberedRows = (rows: typeof positioned[], numbers: typeof positioned) => {
    let quote="";
    for(const row of rows) {
      const text=row.filter(entry=>!numbers.includes(entry)).map(entry=>entry.item.str).join(" ");
      if (/(?:[\w.]+\s*=|[\w.]+\s*\()\s*["']/u.test(text)) quote="";
      // Explicit assignment values can contain a printed missing opening
      // quote. They remain code, but must not leak string state into prose.
      if (/^[\w.]+\s*=\s*[^"'=]+["']\s*[,)]*\s*$/u.test(text)) {quote="";continue;}
      let syntax="";
      for(let i=0;i<text.length;i++) {
        if(quote) {
          if(text[i]==="\\"){i++;continue;}
          if(text.startsWith(quote,i)){i+=quote.length-1;quote="";}
        } else if(text[i]==="#")break;
        else if(text[i]==='"'||text[i]==="'") {
          quote=text.slice(i,i+3)===text[i].repeat(3)?text[i].repeat(3):text[i];i+=quote.length-1;
        } else syntax+=text[i];
      }
      const keyword=/^\s*(?:(?:async\s+)?(?:def|class)\s+\w+|from\s+[\w.]+\s+import\b|import\s+[\w.]+|return\b|yield\b|raise\b|await\b|assert\b|if\b|elif\b|else\b|for\b|while\b|try\b|except\b|finally\b|with\b)/u.test(syntax);
      if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(syntax)
        || !keyword && /\b[A-Za-z]+\s+[A-Za-z]+\b/u.test(syntax.replace(/\b(?:await|not|and|or|in|is)\b/gu,""))) {
        throw new Error(`PDF numbered code panel contains unmarked prose (${text.slice(0,160)}); separate or tag its text before importing.`);
      }
    }
  };
  const protectedIndexes = new Set<number>();
  for (const box of areas) {
      const entries = positioned.filter(entry=>entry.x>=box.x-1
        && entry.x+entry.item.width<=box.x+box.width+1 && entry.y>=box.y-1
        && entry.y+entry.size<=box.y+box.height+1).sort((left,right)=>left.y-right.y||left.x-right.x);
      const rows: typeof entries[] = [];
      for (const entry of entries) {
        const row=rows.at(-1);
        if (row && Math.abs(row[0].y-entry.y)<Math.min(row[0].size,entry.size)*.4) row.push(entry);
        else rows.push([entry]);
      }
      const first=rows[0]?.[0];
      if(!first || first.y-box.y>first.size*2.5)continue;
      const label=rows[0].length===1 && /^Python$/i.test(first.item.str.trim()) ? first : undefined;
      if(label)rows.shift();
      const contentEntries=entries.filter(entry=>entry.index!==label?.index);
      const left=contentEntries[0]?.x;
      const numbers=contentEntries.filter(entry=>Math.abs(entry.x-left)<1 && /^\d+$/.test(entry.item.str.trim()));
      const codeEntries=contentEntries.filter(entry=>entry.x>left+(numbers[0]?.item.width??0)+first.size);
      const numberedPanel=numbers.length>=3 && numbers[0].y-contentEntries[0].y<first.size*.5
        && numbers.every((entry,index)=>!index || entry.y-numbers[index-1].y>entry.size
          && Number(entry.item.str.trim())>=Number(numbers[index-1].item.str.trim()))
        && contentEntries.every(entry=>entry.size<=numbers[0].size*1.1)
        && codeEntries.some(entry=>/^(?:(?:async\s+)?(?:def|class)\s+\w+|from\s+[\w.]+\s+import\b|import\s+[\w.]+|@\w|(?:[\w.]+)\s*(?:=|:=|\(|:))/u.test(entry.item.str.trim()));
      if(numberedPanel) {
        // A numbered panel is layout evidence, not permission to freeze every
        // sentence in its rectangle. Check prose outside explicit strings and
        // comments, retaining string state across printed wraps.
        checkNumberedRows(rows,numbers);
        if(label)protectedIndexes.add(label.index);
        for(const entry of contentEntries)protectedIndexes.add(entry.index);
        continue;
      }
      // A continued code panel may omit its language caption, but retains its
      // aligned, numbered code gutter. An explanatory paragraph ends that prefix.
      const gutter=(row:typeof entries)=>/^\d+$/.test(row[0].item.str.trim())
        && (!row[1] || row[1].x-row[0].x-row[0].item.width>row[0].size);
      const numbered=rows.slice(0,3).length===3 && rows.slice(0,3).every(gutter)
        && rows.slice(0,3).every(row=>Math.abs(row[0].x-rows[0][0].x)<1);
      if(!label && !numbered)continue;
      let quote = "", syntaxEvidence = false, valid = rows.length>0;
      const accepted: typeof entries = [];
      for (const row of rows) {
        if(numbered && (!gutter(row) || Math.abs(row[0].x-rows[0][0].x)>1))break;
        // Line-number gutters are printed separately from code and are immutable too.
        const code = row.filter((entry,index)=>!(index===0 && /^\d+$/.test(entry.item.str.trim())
          && row[1] && row[1].x-entry.x-entry.item.width>entry.size));
        let text="";
        for (const [index,entry] of code.entries()) {
          const previous = code[index-1];
          const gap = previous ? entry.x-previous.x-previous.item.width : 0;
          text += (gap>entry.size*.2 && !/\s$/.test(text)?" ":"")+entry.item.str.replace(/[\r\n]/g,"");
        }
        if(numbered) {
          // Numbered code listings may deliberately contain invalid syntax or
          // wrapped strings. Their explicit layout, not parser validity, owns the
          // entire row; comments/string contents must remain immutable as well.
          syntaxEvidence ||= /^(?:(?:async\s+)?(?:def|class)\s+\w+|from\s+[\w.]+\s+import\b|import\s+[\w.]+|@\w|(?:[\w.]+)\s*(?:=|:=|\())/u.test(text.trim());
          accepted.push(...row);continue;
        }
        const continuedString = Boolean(quote);
        let syntax="";
        for(let i=0;i<text.length;i++) {
          if(quote) {
            if(text[i]==="\\") {i++;continue;}
            if(text.startsWith(quote,i)) {i+=quote.length-1;quote="";syntax+='""';}
          } else if(text[i]==="#") break;
          else if(text[i]==='"'||text[i]==="'") {
            quote=text.slice(i,i+3)===text[i].repeat(3)?text[i].repeat(3):text[i]; i+=quote.length-1;
          } else syntax+=text[i];
        }
        const statement=syntax.trim();
        const concrete = /^(?:(?:async\s+)?(?:def|class)\s+\w+|from\s+[\w.]+\s+import\b|import\s+[\w.]+|@\w|(?:[\w.]+)\s*(?:=|:=|\(|:))/u.test(statement);
        syntaxEvidence ||= concrete;
        const codeRow = concrete || /^(?:return|yield|raise|await|assert|del|pass|break|continue|if|elif|else|for|while|try|except|finally|with|async)\b/u.test(statement)
          || /^[\s\[\](){}.,:*+\-=\/"\d]*$/.test(statement)
          || /^""\s*:/.test(statement)
          || /^[\w.]+(?:\s*,\s*[\w.]+)*\s*[,\])}]*$/.test(statement)
          || continuedString && !statement;
        if(!codeRow || /(?:=|\))[^;{}]*\b[A-Za-z]+\s+[A-Za-z]+\s+[A-Za-z]+/u.test(statement)) {valid=false;break;}
        accepted.push(...row);
      }
      if(valid && syntaxEvidence && !quote) {
        if(numbered)checkNumberedRows(rows.slice(0,accepted.length),rows.map(row=>row[0]));
        if(label)protectedIndexes.add(label.index);
        for(const entry of accepted) protectedIndexes.add(entry.index);
      }
  }
  return content.items.map((item,index)=>protectedIndexes.has(index)?{...item,protection:"code"}:item);
}

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
  const mathTypeface = (name: string) => /(?:CambriaMath|STIX.*Math|LatinModernMath|CMSY|CMMI|CMEX|MSAM|MSBM|MathJax|Symbol|Mathematical)/i.test(name);
  const textItems = content.items.filter((item): item is TextItem => "str" in item && Boolean(item.str.trim()));
  const scriptLabel = (item: TextItem) => /^\p{L}[\p{L}\d_]*$/u.test(item.str)
    && textItems.some(base => mathTypeface(fontName(base.fontName))
      && Math.hypot(item.transform[2],item.transform[3]) < Math.hypot(base.transform[2],base.transform[3]) * .85
      && Math.abs(item.transform[5]-base.transform[5]) > .5
      && Math.abs(item.transform[5]-base.transform[5]) < Math.hypot(base.transform[2],base.transform[3]) * .75
      && Math.abs(item.transform[4]-base.transform[4]-base.width) < Math.hypot(base.transform[2],base.transform[3]) * .5);
  const mathAccent = (item: TextItem) => /^[\p{Sk}\p{M}ˆˇˉ]+$/u.test(item.str)
    && textItems.some(base => mathTypeface(fontName(base.fontName))
      && item.transform[4] >= base.transform[4]-1 && item.transform[4] < base.transform[4]+base.width+1
      && Math.abs(item.transform[5]-base.transform[5]) < Math.hypot(base.transform[2],base.transform[3]) * .75);
  const romanFonts = new Map<string, boolean>();
  for (const item of textItems) {
    romanFonts.set(item.fontName, (romanFonts.get(item.fontName) ?? true) && (mathFragment(item.str) || scriptLabel(item)));
  }
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
    const mathFont = mathTypeface(name);
    const romanMath = mathRomanTypeface(name) && (romanFonts.get(item.fontName) || mathAccent(item));
    items.push({ ...item, protection: stack.at(-1) ?? item.protection ?? (mathFont || romanMath ? "math" : undefined) });
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
    const math = /[≠≈≤≥∑∏∫√∞∂∇∥]/u.test(text)
      || /=\s*(?:\d|[α-ωΑ-Ω]|[a-zA-Z](?:\b|[A-Za-z]*\d))/u.test(text)
      || mathFragment(text) && /(?:[=+−*/×÷^]|\b(?:sin|cos|tan|log|exp|sqrt|f|g)\s*\()/u.test(text)
      || /\b(?:sin|cos|tan|log|exp|sqrt|f|g)\s*\(/u.test(text);
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
      && !(mathFragment(token) && mathFragment(tokens[index+1])));
    const mixedMath = !code && (adjacentWords || /[.!?。！？]$/u.test(text) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
      || words.some(word => !mathWord.test(word)));
    if (mixedCode || mixedMath) throw new Error(`PDF page ${page}: code/formula is mixed with unmarked prose (${text.slice(0,120)}). Tag or separate the protected content before importing.`);
    return code ? "code" : "math";
  };
  const mono = (item: TextItem) => /(?:monospace|Courier|Consolas|Mono|Code)/i.test(`${fontName(item.fontName)} ${content.styles[item.fontName]?.fontFamily ?? ""}`);
  for (const row of rows) {
    // Expand only contiguous mathematical fragments. Prose in the same visual
    // row ends the cluster, even when it shares the formula's Roman font.
    let cluster: TextItem[] = [];
    const finishCluster = () => {
      if (cluster.length && (cluster.some(item => item.protection === "math")
        || detect(cluster.map(item => item.str).join(" "), false) === "math")) {
        for (const item of cluster) item.protection = "math";
      }
      cluster = [];
    };
    for (const item of row) {
      const name = fontName(item.fontName);
      // Acronyms printed in a prose typeface (e.g. a table's "SD" header) are
      // labels, not permission to freeze nearby text. Roman mathematical
      // operators/identifiers must retain their actual math typeface evidence.
      const romanIdentifier = /[A-Za-z]{2,}/u.test(item.str);
      const fragment = mathFragment(item.str) && (!romanIdentifier || !name || mathRomanTypeface(name));
      if (item.protection === "math" || !item.protection && fragment) cluster.push(item);
      else finishCluster();
    }
    finishCluster();
    const unprotected = row.filter(item => !item.protection);
    if (!unprotected.length) continue;
    // Independent text runs can separate complete code from neighboring prose.
    // Otherwise classify the complete row (e.g. a formula split into glyph runs).
    const kinds = unprotected.map(item => detect(item.str.trim(), mono(item)));
    if (kinds.some(Boolean) && kinds.some(kind => !kind)) {
      for (const [index,item] of unprotected.entries()) item.protection = kinds[index];
    } else {
      const kind = detect(unprotected.map(item => item.str).join(" ").trim(), unprotected.every(mono));
      if (kind) for (const item of unprotected) item.protection = kind;
    }
  }
  // Display-equation numbers may be painted far from the equation. A detached
  // right-hand math annotation and source margin establish its ownership;
  // spelling alone does not. Display explanations remain writable prose.
  // Keep this before paint binding so inseparable prose still fails visibly.
  for(const row of rows) {
    if(row.some(item=>item.protection||/^(?:TD|TH):/u.test(item.paragraphScope??''))||!/^\(\d+(?:\.\d+)*[a-z]?\)$/iu.test(row.map(item=>item.str).join('').replace(/\s/gu,'')))continue;
    const label=row[0],size=Math.hypot(label.transform[2],label.transform[3]);
    const right=Math.max(...row.map(item=>item.transform[4]+item.width));
    const peers=rows.filter(other=>other!==row&&other.some(item=>Math.abs(item.transform[5]-label.transform[5])<size*.4)).flat();
    const nearest=peers.slice().sort((a,b)=>b.transform[4]+b.width-a.transform[4]-a.width)[0];
    const margin=rows.some(other=>other!==row&&other.some(item=>!item.protection&&/[\p{L}]{2,}/u.test(item.str))
      &&Math.min(...other.map(item=>item.transform[4]))<label.transform[4]-size*4
      &&Math.abs(Math.max(...other.map(item=>item.transform[4]+item.width))-right)<size*.25);
    if(margin&&nearest?.protection==='math'&&label.transform[4]-nearest.transform[4]-nearest.width>size*1.5) {
      for(const item of row)item.protection='math';
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
    item.paintOperations = matches.map(segment => segment.paint.operator);
    item.paintSpans = matches.map(segment => ({ operator: segment.paint.operator,
      start: Math.max(start, segment.start)-segment.start, end: Math.min(end, segment.end)-segment.start }));
  }
  const retained = new Set<number>();
  for (const segment of segments) {
    if (![...segment.kinds].some(kind => kind !== undefined)) continue;
    if (segment.kinds.has(undefined) || segment.kinds.size !== 1 || segment.covered !== segment.end-segment.start) {
      throw new Error(`PDF page ${page}: protected content shares a text paint with prose or unbound glyphs; safe separation is required before importing. Paint ${segment.paint.operator}, kinds=${[...segment.kinds].map(kind=>kind??"prose").join(",")}, bound=${segment.covered}/${segment.end-segment.start}, text=${JSON.stringify(segment.paint.text.slice(0,120))}.`);
    }
    retained.add(segment.paint.operator);
  }
  return { items, retained };
}
