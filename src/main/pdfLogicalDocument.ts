import type {PdfLayout,PdfTextBlock} from './pdfTypes.ts';
import {pdfSourceTables} from './pdfSourceTables.ts';
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {pdfNativePlacementEvidence} from './pdfNativePlacement.ts';
import {pdfSourceVisibleText} from './pdfSourceVisibleText.ts';

const joiner=(a:string,b:string)=>!a||!b||/\s$/u.test(a)||/^\s/u.test(b)||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)||/[A-Za-z]-$/u.test(a)&&/^[A-Za-z]/u.test(b)?'':' ';
const prose=(text:string)=>text.replace(/\{\{(?:formula|code):p\d+:\d+\}\}/gu,'').trim();
const caption=(text:string)=>/^\s*(?:Table|Fig(?:ure)?\.?|图|図|表)\s*[\d一二三四五六七八九十]+[A-Za-z]?\s*[:.：．]/iu.test(text);
const heading=(text:string)=>/^\s*(?:\d+(?:\.\d+)*\s+\p{L}|(?:References|Bibliography|Abstract)\s*$)/iu.test(text)||caption(text);
const folio=(block:PdfTextBlock,layout:PdfLayout)=>block.text===String(block.page)&&block.y>layout.pages[block.page-1].height*.85&&block.width<block.fontSize*3;
const union=(a:PdfTextBlock,b:PdfTextBlock)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.max(a.x+a.width,b.x+b.width)-Math.min(a.x,b.x),height:Math.max(a.y+a.height,b.y+b.height)-Math.min(a.y,b.y)});

function sourceOwner(source:PdfTextBlock):PdfTextBlock {
  return {...source,fragments:[source.line],inlineProtections:source.inlineProtections?.map(node=>({...structuredClone(node),sourcePage:source.page})),
    proseSegments:source.proseSegments?.map(segment=>({...segment,boxes:segment.boxes.map(box=>({...box,page:source.page}))}))};
}
function appendProse(target:PdfTextBlock,source:PdfTextBlock):void {
  const last=target.proseSegments!.at(-1)!,head=source.proseSegments![0];
  last.text+=joiner(last.text,head.text)+head.text;last.boxes.push(...head.boxes);
  target.inlineProtections!.push(...source.inlineProtections!);target.proseSegments!.push(...source.proseSegments!.slice(1));
  target.text=target.proseSegments!.map((segment,index)=>segment.text+(target.inlineProtections![index]?.token??'')).join('');
  if(target.page===source.page)Object.assign(target,union(target,source));
  target.fragments!.push(...source.fragments!);
}

/** Consume source-only paragraph evidence before connecting complete owners.
 * These are editable mechanical candidates, not semantic acceptance. Physical
 * rows and every native glyph/path remain immutable and independently owned. */
export function makePdfLogicalDocument(layout:PdfLayout):void {
  if(layout.physicalBlocks)throw new Error('PDF logical candidates already have physical ownership; rebuild from the original mechanical extraction.');
  const physical=layout.blocks,owners=new Map<number,PdfTextBlock>();
  const tables=pdfSourceTables(physical);
  const tableCells=new Set([...layout.pages.flatMap(page=>page.tableRules?.flatMap(table=>table.sourceLines)??[]),...tables.flatMap(table=>table.sourceLines)]);
  const referenceLines=new Set(pdfReferenceSections(layout).protectedLines.map(row=>row.line));
  const tableCellOwners=new Map<number,string>();
  for(const page of layout.pages)for(const table of page.tableRules??[])for(const [row,cells] of table.rows.entries())for(const [column,line] of cells.entries())tableCellOwners.set(line,`${table.id}:${row}:${column}`);
  const hints=layout.mechanicalParagraphs??physical.map(block=>[block.line]),covered=new Set<number>(),candidates:PdfTextBlock[]=[];
  for(const hint of hints) {
    if(!hint.length)throw new Error('PDF mechanical paragraph candidate has no source IDs.');
    let prior:PdfTextBlock|undefined;
    for(const line of hint) {
      const source=physical[line-1];
      if(!source||source.line!==line||covered.has(line))throw new Error(`PDF mechanical paragraph candidates repeat or invent source ID ${line}.`);
      covered.add(line);
      const next=sourceOwner(source),priorSource=prior?physical[prior.fragments!.at(-1)!-1]:undefined;
      // Independent native assets, table cells and distinct native scopes must
      // not become one writable paragraph merely because a hint groups them.
      const merge=prior&&priorSource&&prior.page===source.page&&!prior.protection&&!source.protection
        &&!priorSource.sourceInkPath&&!source.sourceInkPath&&Boolean(prior.proseSegments)&&Boolean(next.proseSegments)
        &&priorSource.sourceScope===source.sourceScope
        &&referenceLines.has(priorSource.line)===referenceLines.has(source.line)
        &&tableCellOwners.get(priorSource.line)===tableCellOwners.get(source.line)
        &&(!tableCells.has(priorSource.line)&&!tableCells.has(source.line)||Boolean(source.sourceScope?.match(/^(?:TD|TH):/u)))
        &&!folio(priorSource,layout)&&!folio(source,layout)&&!heading(source.text);
      if(merge)appendProse(prior!,next);
      else {candidates.push(next);prior=next;}
      owners.set(line,prior!);
    }
  }
  if(covered.size!==physical.length)throw new Error('PDF mechanical paragraph candidates omit physical source IDs.');

  // Follow actual associations with complete caption owners, so a caption's
  // wrapped tail cannot masquerade as the next page's body continuation.
  const floatLines=new Set<number>();
  const addFloat=(lines:number[])=>{for(const line of lines){const owner=owners.get(line);if(!owner)throw new Error(`PDF float candidate has unknown source ID ${line}.`);for(const fragment of owner.fragments!)floatLines.add(fragment);}};
  for(const table of [...tables,...layout.pages.flatMap(page=>page.tableRules??[])])if(table.captionLine!==undefined)addFloat([table.captionLine,...table.sourceLines]);
  for(const reference of layout.references)if(reference.captionLine!==undefined&&caption(physical[reference.captionLine-1]?.text??''))addFloat([reference.captionLine]);
  for(const group of layout.figureGroups??[]){addFloat(group.physicalLines);if(group.captionLine!==undefined&&caption(physical[group.captionLine-1]?.text??''))addFloat([group.captionLine]);}
  const isFloat=(block:PdfTextBlock)=>block.fragments!.some(line=>floatLines.has(line));
  const nextToken=new Map(layout.pages.map(page=>[page.page,Math.max(0,...physical.filter(block=>block.page===page.page).flatMap(block=>block.inlineProtections?.map(node=>Number(node.token.match(/:(\d+)\}\}$/u)![1]))??[]))+1]));
  const appendNative=(prior:PdfTextBlock,native:PdfTextBlock[],placement:'inline'|'display',following?:PdfTextBlock)=>{
    const page=native[0].page,number=nextToken.get(page)!;nextToken.set(page,number+1);
    const boxes=native.map(block=>block.sourceInkBox??block),x=Math.min(...boxes.map(box=>box.x)),y=Math.min(...boxes.map(box=>box.y));
    const box={x,y,width:Math.max(...boxes.map(box=>box.x+box.width))-x,height:Math.max(...boxes.map(box=>box.y+box.height))-y};
    const physicalLines=native.flatMap(block=>block.fragments!);
    prior.inlineProtections!.push({...box,inkBox:box,kind:'math',token:`{{formula:p${page}:${number}}}`,text:native.map(block=>block.text).join(' '),sourcePage:page,physicalLines,placement,
      paintOperations:[...new Set(native.flatMap(block=>block.paintOperations!))],nativePathOperations:[...new Set(native.flatMap(block=>block.nativePathOperations??[]))]});
    prior.proseSegments!.push(...(following?following.proseSegments!:[{text:'',boxes:[]}]));
    if(following)prior.inlineProtections!.push(...following.inlineProtections!);
    const appended=[...physicalLines,...(following?following.fragments!:[])];prior.fragments!.push(...appended);
    prior.text=prior.proseSegments!.map((segment,i)=>segment.text+(prior.inlineProtections![i]?.token??'')).join('');
    for(const line of appended)owners.set(line,prior);
  };
  // Recover original inline fractions and formula-only wrapped tails before
  // connecting paragraphs. Their source rows stay native, with explicit
  // presentation independent from physical ownership.
  for(let index=1;index<candidates.length;index++) {
    const native=candidates[index],prior=candidates[index-1];
    if(native.protection!=='math'||prior.protection||!prior.proseSegments||isFloat(native)||isFloat(prior)||heading(prior.text)
      ||[...prior.fragments!,...native.fragments!].some(line=>tableCells.has(line)||referenceLines.has(line)))continue;
    const evidence=pdfNativePlacementEvidence(physical,native.fragments!);
    if(evidence.placement!=='inline'||prior.fragments!.at(-1)!==native.fragments![0]-1)continue;
    const after=candidates[index+1],following=evidence.continuationPhysicalLine!==undefined&&after?.fragments![0]===evidence.continuationPhysicalLine&&!after.protection
      &&after.proseSegments&&!isFloat(after)&&!after.fragments!.some(line=>tableCells.has(line)||referenceLines.has(line))?after:undefined;
    // A same-baseline proof needs both prose sides to remain in this owner.
    if(evidence.continuationPhysicalLine!==undefined&&!following)continue;
    appendNative(prior,[native],'inline',following);candidates.splice(index,following?2:1);index--;
  }
  const blocks:PdfTextBlock[]=[];
  for(const source of candidates) {
    const previous=blocks.filter(block=>!folio(block,layout)&&!isFloat(block)).at(-1);
    const prior=previous?physical[previous.fragments!.at(-1)!-1]:undefined,head=physical[source.fragments![0]-1];
    const intervening=prior?physical.slice(prior.line,head.line-1):[];
    const first=prose(head.text),tail=prior?pdfSourceVisibleText(prior).trim():'';
    const crosses=previous&&prior&&!isFloat(source)&&!prior.protection&&!head.protection&&!prior.sourceInkPath&&!head.sourceInkPath
      &&!referenceLines.has(prior.line)&&!referenceLines.has(head.line)&&head.page===prior.page+1
      &&Math.abs(prior.fontSize-head.fontSize)<=.01&&prior.segmentation==='paragraph'&&head.segmentation==='paragraph'
      &&intervening.every(block=>folio(block,layout)||floatLines.has(block.line))&&!heading(previous.text)&&!heading(head.text)
      &&!/[.!?。！？]["'”’)]*$/u.test(tail)&&/^(?:\p{Ll}|[,(;])/u.test(first)&&head.x<=prior.x+head.fontSize*.75;
    if(crosses){appendProse(previous!,source);for(const line of source.fragments!)owners.set(line,previous!);}
    else blocks.push(source);
  }
  // Only explicitly protected math can join a sentence via an immutable marker.
  for(let index=0;index<blocks.length;index++) {
    const prior=blocks[index];if(prior.protection||isFloat(prior)||prior.fragments!.some(line=>tableCells.has(line)||referenceLines.has(line))||heading(prior.text)||/[.!?。！？]["'”’)]*$/u.test(pdfSourceVisibleText(prior).trim())||!prior.proseSegments)continue;
    const lastPage=physical[prior.fragments!.at(-1)!-1].page;
    let end=index+1;const display:PdfTextBlock[]=[];
    while(end<blocks.length&&blocks[end].protection==='math'&&blocks[end].page===lastPage&&!isFloat(blocks[end])&&!blocks[end].fragments!.some(line=>tableCells.has(line)||referenceLines.has(line)))display.push(blocks[end++]);
    if(!display.length)continue;
    const following=blocks[end];
    // A display may complete its prose lead-in at the end of a paragraph or
    // before an independent sentence. Only a genuine lower-case continuation
    // also joins the owner after the display; it is not required to own math.
    const continues=following&&!following.protection&&!isFloat(following)&&!following.fragments!.some(line=>tableCells.has(line)||referenceLines.has(line))&&!heading(following.text)&&following.page===lastPage&&/^\p{Ll}/u.test(prose(following.text))
      &&Math.abs(prior.fontSize-following.fontSize)<=.01&&following.x<=prior.x+prior.fontSize*.75&&Boolean(following.proseSegments);
    appendNative(prior,display,'display',continues?following:undefined);
    blocks.splice(index+1,display.length+(continues?1:0));index--;
  }
  blocks.forEach((block,index)=>block.line=index+1);
  for(const ref of layout.references)if(ref.captionLine!==undefined)ref.captionLine=owners.get(ref.captionLine)!.line;
  for(const group of layout.figureGroups??[])if(group.captionLine!==undefined)group.captionLine=owners.get(group.captionLine)!.line;
  layout.physicalBlocks=physical;layout.blocks=blocks;
}
