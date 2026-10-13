import type { PdfBox, PdfTextBlock, PdfInlineProtection, PdfProseSegment } from "./pdfTypes.ts";
import type { PdfTextPaintSpan } from "./pdfProtection.ts";

interface PdfTextItem { str: string; transform: number[]; width: number; height: number; dir: string; hasEOL: boolean; paragraphScope?: string; color?: [number, number, number]; protection?: "code" | "math"; paintOperations?: number[]; paintSpans?: PdfTextPaintSpan[] }
type ExtractedPdfBlock = PdfTextBlock & { paintSpans?: PdfTextPaintSpan[] };

const union = (a: PdfBox,b: PdfBox): PdfBox => ({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),
  width:Math.max(a.x+a.width,b.x+b.width)-Math.min(a.x,b.x),height:Math.max(a.y+a.height,b.y+b.height)-Math.min(a.y,b.y)});
const joiner = (a: string,b: string) => !a || !b || /\s$/u.test(a) || /^\s/u.test(b)
  || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)
  || /[A-Za-z]-$/u.test(a)&&/^[A-Za-z]/u.test(b) ? '' : ' ';
const startsItem = (text: string) => /^\s*(?:\((?:\d+|[a-z]|[ivxlcdm]+)\)|\d+[.)])\s*\S|^\s*[•●▪‣–-]\s+\S/iu.test(text);
const startsHeading = (text: string) => /^\s*\d+(?:\.\d+)*\s+\p{L}|^(?:Fig(?:ure)?\.?|Table|図|图|表)\s*[\d一二三四五六七八九十]/iu.test(text);

/** Native paragraph/list/table-cell ownership is stronger than paint order. */
export function pdfParagraphStructure<T extends {items:any[]}>(content:T, tree:any): T {
  const scopes=new Map<string,string>();let serial=0;
  const visit=(node:any,scope?:string,list?:{scope:string;bodyUsed:boolean},inLabel=false)=>{
    if(!node||typeof node!=='object')return;
    if(node.role==='LI') {scope=`LI:${++serial}`;list={scope,bodyUsed:false};}
    else if(node.role==='P'&&list&&(inLabel||!list.bodyUsed)) {scope=list.scope;if(!inLabel)list.bodyUsed=true;}
    else if(/^(?:P|TD|TH|H[1-6])$/u.test(node.role??''))scope=`${node.role}:${++serial}`;
    if(node.role==='Lbl')inLabel=true;
    if(node.type==='content'&&typeof node.id==='string'&&scope)scopes.set(node.id,scope);
    for(const child of node.children??[])visit(child,scope,list,inLabel);
  };
  visit(tree);
  const stack:Array<string|undefined>=[];let scope:string|undefined;
  return {...content,items:content.items.map(item=>{
    if(item.type==='beginMarkedContent'||item.type==='beginMarkedContentProps'){stack.push(scope);scope=scopes.get(item.id)??scope;return item;}
    if(item.type==='endMarkedContent'){scope=stack.pop();return item;}
    return 'str' in item?{...item,paragraphScope:scope}:item;
  })};
}

/** Logical paragraphs retain ordered visual flow areas and immutable inline nodes. */
export function pdfTextBlocks(items: Array<PdfTextItem | { type: string }>, viewport: { transform: number[] }, page: number): ExtractedPdfBlock[] {
  const [a, b, c, d, e, f] = viewport.transform;
  type Run = ExtractedPdfBlock & { endsLine: boolean; baseline: number; scope?:string };
  const visual: Run[][]=[];
  for (const item of items) {
    if (!("str" in item) || !item.str.trim()) continue;
    if (item.dir === "ttb" || Math.abs(a*item.transform[2]+c*item.transform[3]) > 0.01
      || Math.abs(b*item.transform[0]+d*item.transform[1]) > 0.01) {
      throw new Error(`PDF page ${page} contains vertical/rotated text. Convert it to a horizontal text PDF before importing.`);
    }
    const tx = item.transform[4], ty = item.transform[5];
    const size = Math.max(1, Math.hypot(item.transform[2], item.transform[3]));
    const block: Run = { x: a * tx + c * ty + e, y: b * tx + d * ty + f - size,
      width: Math.max(item.width, 1), height: size * 1.25, fontSize: size,
      line: 0, page, text: item.str.replace(/[\r\n]+/g, " "), endsLine: item.hasEOL, color: item.color,
      protection: item.protection, paintOperations: item.paintOperations, paintSpans: item.paintSpans,
      scope:item.paragraphScope,
      baseline: b*tx+d*ty+f };
    const row=visual.at(-1),prior=row?.at(-1);
    const scale=Math.max(size,prior?.fontSize??size);
    let mathStart=-1;
    for(let index=(row?.length??0)-1;index>=0;index--)if(!row![index].protection){mathStart=index;break;}
    const fragmentStart=row?.[mathStart+1]??prior;
    const accessory=prior?.protection==='math'&&block.protection==='math'
      && block.x>=(fragmentStart?.x??prior.x)-scale*.3 && block.y<prior.y+prior.height && prior.y<block.y+block.height;
    const sameRow=prior&&prior.scope===block.scope&&(Math.abs(prior.baseline-block.baseline)<scale*.4||accessory)
      && (accessory||block.x>=prior.x-scale*.3) && block.x-(prior.x+prior.width)<scale*1.5;
    if(sameRow)row!.push(block);else visual.push([block]);
  }
  let inlineId=0;
  type Row = ExtractedPdfBlock & {baseline:number;lastX:number;lastWidth:number;rowCount:number;column:number;parallel:boolean;scope?:string};
  const rows: Row[]=visual.map(runs=>{
    const bounds=runs.map(run=>({x:run.x,y:run.y,width:run.width,height:run.height})).reduce(union);
    const prose=runs.filter(run=>!run.protection),primary=prose[0]??runs[0];
    const fragments: PdfInlineProtection[]=[],segments: PdfProseSegment[]=[{text:'',boxes:[]}];
    let currentProtection: PdfInlineProtection|undefined;
    for(const run of runs) {
      if(run.protection&&prose.length) {
        if(currentProtection?.kind===run.protection) {
          currentProtection.text+=joiner(currentProtection.text,run.text)+run.text;
          Object.assign(currentProtection,union(currentProtection,run));
          currentProtection.paintOperations=[...new Set([...currentProtection.paintOperations,...(run.paintOperations??[])])];
        } else {
          currentProtection={...({x:run.x,y:run.y,width:run.width,height:run.height}),kind:run.protection,
            token:`{{${run.protection==='math'?'formula':'code'}:p${page}:${++inlineId}}}`,text:run.text,paintOperations:run.paintOperations??[]};
          fragments.push(currentProtection);segments.push({text:'',boxes:[]});
        }
      } else {
        currentProtection=undefined;
        const segment=segments.at(-1)!;
        const previous=segment.boxes.at(-1);
        segment.text+=(previous&&run.x-previous.x-previous.width>run.fontSize*.2?joiner(segment.text,run.text):'')+run.text;
        if(previous)Object.assign(previous,union(previous,run));else segment.boxes.push({x:run.x,y:run.y,width:run.width,height:run.height});
      }
    }
    const pure=!prose.length;
    const text=pure?runs.map(run=>run.text).join(' '):segments.map((segment,index)=>segment.text+(fragments[index]?.token??'')).join('');
    if(!pure&&/\{\{(?:formula|code):p\d+:\d+\}\}/u.test(segments.map(segment=>segment.text).join('')))throw new Error('PDF prose contains a reserved inline protection marker.');
    return {...bounds,line:0,page,text,fontSize:Math.max(...(prose.length?prose:runs).map(run=>run.fontSize)),color:primary.color,
      protection:pure?runs[0].protection:undefined,paintOperations:[...new Set(runs.flatMap(run=>run.paintOperations??[]))],paintSpans:runs.flatMap(run=>run.paintSpans??[]),
      ...(pure?{}:{inlineProtections:fragments,proseSegments:segments}),baseline:primary.baseline,lastX:bounds.x,lastWidth:bounds.width,rowCount:1,column:-1,parallel:false,scope:primary.scope};
  });
  // Infer column margins once from substantial visual lines. Indented first
  // lines and hanging list continuations share that margin, separate columns do not.
  const columns: Array<{left:number;size:number}> = [];
  for (const row of rows.filter(row=>!row.protection).sort((a,b)=>a.x-b.x)) {
    if (!columns.some(column=>Math.abs(column.size-row.fontSize)<row.fontSize*.1&&row.x-column.left<row.fontSize*4))
      columns.push({left:row.x,size:row.fontSize});
  }
  for (const row of rows) row.column=columns.findIndex(column=>Math.abs(column.size-row.fontSize)<row.fontSize*.1
    &&row.x>=column.left-row.fontSize*.25&&row.x-column.left<row.fontSize*4);
  // Parallel cells must never be joined vertically into a synthetic paragraph.
  const byBaseline=rows.slice().sort((a,b)=>a.baseline-b.baseline);
  for(let i=0;i<byBaseline.length;i++)for(let j=i+1;j<byBaseline.length;j++) {
    const a=byBaseline[i],b=byBaseline[j];
    if(b.baseline-a.baseline>Math.max(a.fontSize,b.fontSize)*.4)break;
    if(a.x+a.width<b.x||b.x+b.width<a.x)a.parallel=b.parallel=true;
  }
  const paragraphs: Row[] = [];
  const scopedParagraphs=new Map<string,Row>();
  for (const row of rows) {
    const prior=row.scope?scopedParagraphs.get(row.scope):paragraphs.at(-1),leading=prior?row.baseline-prior.baseline:0;
    const sameColumn=prior&&prior.column>=0&&prior.column===row.column;
    const firstIndent=prior&&row.x>prior.lastX+row.fontSize*.75&&!(startsItem(prior.text)&&prior.rowCount===1);
    const completedShort=prior&&/[.!?。！？]$/u.test(prior.text.trim())&&prior.lastWidth<row.width-row.fontSize*2;
    const wrapped = prior && !prior.protection && !row.protection && prior.scope===row.scope
      && (Boolean(row.scope) || Math.abs(prior.fontSize-row.fontSize)<row.fontSize*.1
        && sameColumn && leading>row.fontSize*.75&&leading<row.fontSize*1.8
        && !row.parallel&&!prior.parallel && !firstIndent && !completedShort
        && !/^\s*\d+(?:\.\d+)*\s+\p{L}/u.test(prior.text) && !startsItem(row.text)&&!startsHeading(row.text));
    if (wrapped) {
      const last=prior.proseSegments!.at(-1)!,first=row.proseSegments![0];
      last.text+=joiner(last.text,first.text)+first.text;last.boxes.push(...first.boxes);
      prior.inlineProtections!.push(...row.inlineProtections!);prior.proseSegments!.push(...row.proseSegments!.slice(1));
      prior.text=prior.proseSegments!.map((segment,index)=>segment.text+(prior.inlineProtections![index]?.token??'')).join('');
      Object.assign(prior,union(prior,row));
      prior.baseline=row.baseline;prior.lastX=row.x;prior.lastWidth=row.width;prior.rowCount++;
      prior.paintOperations = [...new Set([...(prior.paintOperations ?? []), ...(row.paintOperations ?? [])])];
      prior.paintSpans = [...(prior.paintSpans ?? []), ...(row.paintSpans ?? [])];
    } else {
      paragraphs.push(row);
      if(row.scope) {if(row.protection)scopedParagraphs.delete(row.scope);else scopedParagraphs.set(row.scope,row);}
    }
  }
  return paragraphs.map(({baseline:_baseline,lastX:_x,lastWidth:_width,rowCount:_count,column:_column,parallel,scope,...block})=>({
    ...block,segmentation:block.protection?'protected':parallel&&!scope?'parallel-region':'paragraph'
  }));
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

/** Flow in original ordered prose areas; never allocate by source text ratios. */
export function flowPdfText(text: string, boxes: PdfBox[], size: number, measure: (text:string)=>number): Array<{text:string;box:PdfBox}> | undefined {
  let rest=text.trim();
  const placed: Array<{text:string;box:PdfBox}>=[];
  for(const box of boxes) {
    const capacity=Math.floor((box.height+.1)/(size*1.2));
    for(let row=0;row<capacity&&rest;row++) {
      let rows:string[];
      try {rows=wrapPdfText(rest,box.width,measure);}
      catch(error) {if(error instanceof Error&&error.message==='PDF text box is narrower than one glyph.')break;throw error;}
      const value=rows[0];
      placed.push({text:value,box:{...box,y:box.y+row*size*1.2,height:size*1.2}});
      // wrapPdfText can trim inter-word whitespace at the next visual row.
      rest=rest.slice(value.length).trimStart();
    }
    if(!rest)break;
  }
  return rest?undefined:placed;
}
