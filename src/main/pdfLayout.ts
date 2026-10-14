import type { PdfBox, PdfTextBlock, PdfInlineProtection, PdfProseSegment } from "./pdfTypes.ts";
import type { PdfTextPaintSpan } from "./pdfProtection.ts";
import {pdfSourceVisibleText} from './pdfSourceVisibleText.ts';

interface PdfTextItem { str: string; transform: number[]; width: number; height: number; dir: string; hasEOL: boolean; paragraphScope?: string; color?: [number, number, number]; protection?: "code" | "math"; paintOperations?: number[]; paintSpans?: PdfTextPaintSpan[] }
type ExtractedPdfBlock = PdfTextBlock & { paintSpans?: PdfTextPaintSpan[] };
export interface PdfSegmentationDecision {
  visualRow:number; paragraph:number; merged:boolean; fontSize:number; column:number;
  scope?:string; displayTail:boolean; reasons:string[];
}

const union = (a: PdfBox,b: PdfBox): PdfBox => ({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),
  width:Math.max(a.x+a.width,b.x+b.width)-Math.min(a.x,b.x),height:Math.max(a.y+a.height,b.y+b.height)-Math.min(a.y,b.y)});
const joiner = (a: string,b: string) => !a || !b || /\s$/u.test(a) || /^\s/u.test(b)
  || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)
  || /[A-Za-z]-$/u.test(a)&&/^[A-Za-z]/u.test(b) ? '' : ' ';
const startsItem = (text: string) => /^\s*(?:\((?:\d+|[a-z]|[ivxlcdm]+)\)|\d+[.)])\s*(?![,;:.!?])\S|^\s*[•●▪‣–-]\s+\S/iu.test(text);
const startsHeading = (text: string) => /^\s*\d+(?:\.\d+)*\s+\p{L}|^(?:Fig(?:ure)?\.?|Table|図|图|表)\s*[\d一二三四五六七八九十]/iu.test(text);
// Text transforms have numerical noise; intentionally different type sizes
// must not share a margin cohort (e.g. a 10pt abstract inside an 11pt body).
const sameTextScale = (a:number,b:number) => Math.abs(a-b)<=.01;
const endsSentence = (text:string) => /[.!?。！？]["'”’)]*$/u.test(text.trim());

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
export function pdfTextBlocks(items: Array<PdfTextItem | { type: string }>, viewport: { transform: number[] }, page: number,
  onDecision?:(decision:PdfSegmentationDecision)=>void, options?:{visualRowsOnly?:boolean}): ExtractedPdfBlock[] {
  const [a, b, c, d, e, f] = viewport.transform;
  // Repeated empty gutters in neighbouring rows are source column evidence.
  // Keep header/symbol runs separate even when their gap is smaller than the
  // ordinary prose joining threshold, so the model can own actual table cells.
  const ink=items.filter((item):item is PdfTextItem=>'str' in item&&Boolean(item.str.trim())).map(item=>({
    x:a*item.transform[4]+c*item.transform[5]+e,width:Math.max(item.width,1),
    baseline:b*item.transform[4]+d*item.transform[5]+f,size:Math.max(1,Math.hypot(item.transform[2],item.transform[3])),protection:item.protection
  }));
  const gutterRows:Array<typeof ink>=[];
  for(const run of ink.slice().sort((left,right)=>left.baseline-right.baseline||left.x-right.x)) {
    const row=gutterRows.find(row=>sameTextScale(row[0].size,run.size)&&Math.abs(row[0].baseline-run.baseline)<run.size*.3);
    if(row)row.push(run);else gutterRows.push([run]);
  }
  const gutters=gutterRows.flatMap(row=>row.slice().sort((left,right)=>left.x-right.x).flatMap((run,index,sorted)=>{
    const next=sorted[index+1];return next&&next.x-run.x-run.width>=run.size*.8?[{left:run.x+run.width,right:next.x,baseline:run.baseline,size:run.size,
      proseBoundary:!run.protection||!next.protection}]:[];
  }));
  const columnGap=(left:number,right:number,baseline:number,size:number,proseFlow=false,localProse=false)=>right-left>size*.5
    &&(new Set(gutters.filter(gutter=>sameTextScale(gutter.size,size)&&Math.abs(gutter.baseline-baseline)>size*.5
      &&(!localProse||Math.abs(gutter.baseline-baseline)<=size*6)
      &&(!proseFlow||gutter.proseBoundary)&&gutter.left<=left+.1&&gutter.right>=right-.1)
      .map(gutter=>Math.round(gutter.baseline*10))).size>=2
      ||right-left>=size*.8&&new Set(ink.filter(run=>(!proseFlow||!run.protection)&&sameTextScale(run.size,size)&&Math.abs(run.x-right)<size*.2
        &&(!localProse||Math.abs(run.baseline-baseline)<=size*6)
        &&Math.abs(run.baseline-baseline)>size*.5).map(run=>Math.round(run.baseline*10))).size>=3);
  type Run = ExtractedPdfBlock & { endsLine: boolean; baseline: number; scope?:string };
  const visual: Run[][]=[];let inlineThrough=-1;
  for (const [itemIndex,item] of items.entries()) {
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
    const proseAnchor=mathStart>=0?row![mathStart]:undefined;
    // The final painted glyph can be a superscript or a backtracking subscript.
    // Use the complete inline ink's right edge and the actual prose baseline,
    // while preserving the original glyph/paint sequence.
    const fragmentBounds=prior?.protection==='math'?row!.slice(mathStart+1).map(run=>({x:run.x,y:run.y,width:run.width,height:run.height})).reduce(union):undefined;
    const priorRight=fragmentBounds?fragmentBounds.x+fragmentBounds.width:prior?prior.x+prior.width:0;
    const resumesProse=prior?.protection==='math'&&!block.protection&&proseAnchor&&sameTextScale(proseAnchor.fontSize,size)
      &&Math.abs(proseAnchor.baseline-block.baseline)<size*.4;
    const accessory=prior?.protection==='math'&&block.protection==='math'
      &&(itemIndex<inlineThrough||block.x>=(fragmentStart?.x??prior.x)-scale*.3&&block.y<fragmentBounds!.y+fragmentBounds!.height&&fragmentBounds!.y<block.y+block.height);
    // A fraction may paint its numerator before its baseline glyphs. Only two
    // neighboring prose anchors establish entry into such native inline ink.
    let entersInline=false;
    if(prior&&!prior.protection&&block.protection==='math'&&prior.scope===block.scope) {
      const native:Run[]=[block];let following:Run|undefined,followingIndex=-1;
      for(let nextIndex=itemIndex+1;nextIndex<items.length;nextIndex++) {
        const next=items[nextIndex];
        if(!('str' in next)||!next.str.trim())continue;
        const nextSize=Math.max(1,Math.hypot(next.transform[2],next.transform[3]));
        const run={x:a*next.transform[4]+c*next.transform[5]+e,y:b*next.transform[4]+d*next.transform[5]+f-nextSize,
          width:Math.max(next.width,1),height:nextSize*1.25,baseline:b*next.transform[4]+d*next.transform[5]+f,scope:next.paragraphScope,fontSize:nextSize,protection:next.protection} as Run;
        if(run.scope!==prior.scope||run.protection==='code')break;
        if(!run.protection){following=run;followingIndex=nextIndex;break;}native.push(run);
      }
      if(following&&sameTextScale(prior.fontSize,following.fontSize)&&Math.abs(prior.baseline-following.baseline)<prior.fontSize*.15) {
        const bounds=native.map(run=>({x:run.x,y:run.y,width:run.width,height:run.height})).reduce(union);
        entersInline=bounds.x>=priorRight-scale*.15&&bounds.x-priorRight<=scale&&following.x>=bounds.x+bounds.width-scale*.15
          &&following.x-bounds.x-bounds.width<=scale&&bounds.y<=prior.baseline+scale*.15&&bounds.y+bounds.height>=prior.baseline-scale*.15&&bounds.height<=scale*3;
        if(entersInline)inlineThrough=followingIndex;
      }
    }
    const sameRow=prior&&prior.scope===block.scope&&(Math.abs(prior.baseline-block.baseline)<scale*.4||accessory||resumesProse||entersInline)
      && (accessory||block.x>=prior.x-scale*.3) && block.x-priorRight<scale*1.5
      // A formula's repeated internal spaces are not evidence of prose columns.
      // Pure native rows still use all gutters, retaining compact numeric cells.
      &&!columnGap(priorRight,block.x,block.baseline,scale,Boolean(proseAnchor&&(prior.protection==='math'||block.protection==='math')),!prior.protection&&!block.protection);
    if(sameRow)row!.push(block);else visual.push([block]);
  }
  let inlineId=0;
  type Row = ExtractedPdfBlock & {baseline:number;lastX:number;lastWidth:number;rowCount:number;column:number;parallel:boolean;displayTail?:boolean;scope?:string};
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
          currentProtection.paintSpans=[...(currentProtection.paintSpans??[]),...(run.paintSpans??[])];
        } else {
          currentProtection={...({x:run.x,y:run.y,width:run.width,height:run.height}),kind:run.protection,
            token:`{{${run.protection==='math'?'formula':'code'}:p${page}:${++inlineId}}}`,text:run.text,paintOperations:run.paintOperations??[],paintSpans:run.paintSpans};
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
  const columns: Array<{left:number;right:number;size:number}> = [];
  for (const row of rows.filter(row=>!row.protection).sort((a,b)=>a.x-b.x)) {
    const column=columns.find(column=>sameTextScale(column.size,row.fontSize)&&row.x-column.left<row.fontSize*4);
    if(column)column.right=Math.max(column.right,row.x+row.width);
    else columns.push({left:row.x,right:row.x+row.width,size:row.fontSize});
  }
  for (const row of rows) {
    // A display formula can leave prose at the right-hand end of its last
    // visual row, continuing at the body margin below. Its leading native
    // fragment, left-hand math ownership and shared right margin distinguish
    // that partial row from an independently aligned prose/table column.
    row.displayTail=!row.protection&&Boolean(row.inlineProtections?.length)&&!row.proseSegments![0].text.trim()
      &&rows.some(other=>other.protection==='math'&&Math.abs(other.baseline-row.baseline)<row.fontSize*.4&&other.x+other.width<=row.x);
    row.column=columns.findIndex(column=>sameTextScale(column.size,row.fontSize)
      &&row.x>=column.left-row.fontSize*.25&&(row.x-column.left<row.fontSize*4
        ||row.displayTail&&Math.abs(row.x+row.width-column.right)<row.fontSize*.25));
  }
  // Parallel cells must never be joined vertically into a synthetic paragraph.
  const byBaseline=rows.slice().sort((a,b)=>a.baseline-b.baseline);
  for(let i=0;i<byBaseline.length;i++)for(let j=i+1;j<byBaseline.length;j++) {
    const a=byBaseline[i],b=byBaseline[j];
    if(b.baseline-a.baseline>Math.max(a.fontSize,b.fontSize)*.4)break;
    if(a.x+a.width<b.x||b.x+b.width<a.x) {
      const left=a.x<b.x?a:b,right=a.x<b.x?b:a,gap=right.x-left.x-left.width;
      if(a.protection||b.protection||gap>Math.max(a.fontSize,b.fontSize)*3
        ||columnGap(left.x+left.width,right.x,left.baseline,left.fontSize,false,true))a.parallel=b.parallel=true;
    }
  }
  // A run-in label can end with native ink, leaving a separate right-hand
  // prose primitive. Its next full visual row proves the body margin; the
  // short primitive's x must not invent another document column.
  for(const row of rows) {
    if(row.protection||row.parallel)continue;
    const left=rows.filter(other=>other!==row&&!other.protection&&!other.parallel&&other.scope===row.scope
      &&sameTextScale(other.fontSize,row.fontSize)&&Math.abs(other.baseline-row.baseline)<row.fontSize*.15&&other.x+other.width<=row.x)
      .sort((a,b)=>b.x-a.x)[0];
    if(!left||left.column<0)continue;
    const next=rows.find(other=>!other.protection&&!other.parallel&&other.scope===row.scope&&sameTextScale(other.fontSize,row.fontSize)
      &&other.baseline-row.baseline>row.fontSize*.75&&other.baseline-row.baseline<row.fontSize*1.8
      &&Math.abs(other.x-left.x)<row.fontSize*.5&&other.x<row.x-row.fontSize*2
      &&Math.abs(other.x+other.width-row.x-row.width)<row.fontSize*.5);
    if(next&&Math.abs(row.x+row.width-columns[left.column].right)<row.fontSize*.5)row.column=left.column;
  }
  const paragraphs: Row[] = [];
  const scopedParagraphs=new Map<string,Row>();
  for (const [visualRow,row] of rows.entries()) {
    const prior=row.scope?scopedParagraphs.get(row.scope):paragraphs.at(-1),leading=prior?row.baseline-prior.baseline:0;
    const sameColumn=prior&&prior.column>=0&&prior.column===row.column;
    const centered=prior&&Math.abs(prior.lastX+prior.lastWidth/2-row.x-row.width/2)<row.fontSize*.1;
    const firstIndent=prior&&!centered&&row.x>prior.lastX+row.fontSize*.75&&!(startsItem(prior.text)&&prior.rowCount===1);
    const priorVisible=prior?pdfSourceVisibleText(prior):'';
    const completedShort=prior&&endsSentence(priorVisible)&&prior.lastWidth<row.width-row.fontSize*2;
    // A citation year or inline (ii) at a visual wrap is not a new list.
    // Prefixes delimit items only with a completed preceding paragraph or
    // established list/heading ownership; geometry still distinguishes indents.
    const prefixBoundary=prior&&(startsItem(row.text)||startsHeading(row.text))
      && (endsSentence(priorVisible)||startsItem(prior.text));
    const wrapped = !options?.visualRowsOnly && prior && !prior.protection && !row.protection && prior.scope===row.scope
      && (Boolean(row.scope) || sameTextScale(prior.fontSize,row.fontSize)
        && sameColumn && leading>row.fontSize*.75&&leading<row.fontSize*1.8
        && !row.parallel&&(!prior.parallel||prior.displayTail) && !firstIndent && !completedShort
        && !/^\s*\d+(?:\.\d+)*\s+\p{L}/u.test(prior.text) && !prefixBoundary);
    onDecision?.({visualRow:visualRow+1,paragraph:wrapped?paragraphs.indexOf(prior)+1:paragraphs.length+1,merged:Boolean(wrapped),fontSize:row.fontSize,column:row.column,
      scope:row.scope,displayTail:Boolean(row.displayTail),reasons:wrapped?[row.scope?'native-scope':'visual-wrap']:!prior?['first-row']:[
        ...(prior.protection||row.protection?['protected-content']:[]),...(prior.scope!==row.scope?['different-scope']:[]),
        ...(!sameTextScale(prior.fontSize,row.fontSize)?['different-text-scale']:[]),...(!sameColumn?['different-column']:[]),
        ...(!(leading>row.fontSize*.75&&leading<row.fontSize*1.8)?['vertical-separation']:[]),
        ...(row.parallel||prior.parallel&&!prior.displayTail?['parallel-region']:[]),...(firstIndent?['first-line-indent']:[]),
        ...(completedShort?['completed-short-line']:[]),...(/^\s*\d+(?:\.\d+)*\s+\p{L}/u.test(prior.text)?['previous-heading']:[]),...(prefixBoundary?['new-item-or-heading']:[])
      ]});
    if (wrapped) {
      const last=prior.proseSegments!.at(-1)!,first=row.proseSegments![0];
      last.text+=joiner(last.text,first.text)+first.text;last.boxes.push(...first.boxes);
      prior.inlineProtections!.push(...row.inlineProtections!);prior.proseSegments!.push(...row.proseSegments!.slice(1));
      prior.text=prior.proseSegments!.map((segment,index)=>segment.text+(prior.inlineProtections![index]?.token??'')).join('');
      Object.assign(prior,union(prior,row));
      prior.baseline=row.baseline;prior.lastX=row.x;prior.lastWidth=row.width;prior.rowCount++;
      prior.parallel=row.parallel;prior.displayTail=row.displayTail;
      prior.paintOperations = [...new Set([...(prior.paintOperations ?? []), ...(row.paintOperations ?? [])])];
      prior.paintSpans = [...(prior.paintSpans ?? []), ...(row.paintSpans ?? [])];
    } else {
      paragraphs.push(row);
      if(row.scope) {if(row.protection)scopedParagraphs.delete(row.scope);else scopedParagraphs.set(row.scope,row);}
    }
  }
  return paragraphs.map(({baseline:_baseline,lastX:_x,lastWidth:_width,rowCount:_count,column:_column,parallel,displayTail:_tail,scope,...block})=>({
    ...block,baseline:_baseline,columnX:columns[_column]?.left,sourceScope:scope,segmentation:block.protection?'protected':parallel&&!scope?'parallel-region':'paragraph'
  }));
}

export function intersects(a: PdfBox, b: PdfBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
