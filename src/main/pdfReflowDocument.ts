import {pdfInlineTokens,splitPdfInlineTranslation} from '../shared/validation/pdfPreservation.ts';
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {pdfBlockPages,type PdfLayout,type PdfTextBlock} from './pdfTypes.ts';
import type {PdfReflowDocument,PdfReflowImage,PdfReflowNode,PdfReflowPart} from './pdfReflow.ts';
import {pdfSourceTables} from './pdfSourceTables.ts';

export interface PdfReflowAssetPort {
  inline(token:string):Promise<PdfReflowImage>;
  native(page:number,physicalLines:number[]):Promise<PdfReflowImage>;
  figure(id:string):Promise<PdfReflowImage>;
}
const isCaption=(text:string)=>/^(?:Table|Fig(?:ure)?\.?|表|图)\s*\d+\s*[:.]/iu.test(text);
const isFolio=(block:PdfTextBlock,layout:PdfLayout)=>block.text===String(block.page)&&block.y>layout.pages[block.page-1].height*.85&&block.width<block.fontSize*3;

/** Build semantic source before printing. Each textual line has exactly one
 * leaf owner; native images and figures retain their explicit source pages. */
export async function buildPdfReflowDocument(layout:PdfLayout,lines:string[],assets:PdfReflowAssetPort):Promise<PdfReflowDocument> {
  const referenceLines=new Set(pdfReferenceSections(layout).protectedLines.map(row=>row.line));
  const physical=layout.physicalBlocks??layout.blocks;
  const sourceOwners=new Map(layout.blocks.flatMap(block=>(block.fragments??[block.line]).map(line=>[line,block.line] as const)));
  const groupedImages=new Set(layout.figureGroups?.flatMap(group=>group.referenceIds)??[]);
  const figureLabels=new Set(layout.figureGroups?.flatMap(group=>group.physicalLines.map(line=>sourceOwners.get(line)!))??[]);
  const images=[...layout.references.filter(ref=>/^p\d+-image\d+$/u.test(ref.id)&&!groupedImages.has(ref.id)||ref.kind==='vector'),...(layout.figureGroups??[])];
  const figureNode=async(ref:typeof images[number]):Promise<PdfReflowNode>=>({id:`figure:${ref.id}`,sourceLines:'physicalLines' in ref?ref.physicalLines.map(line=>sourceOwners.get(line)!):[],sourcePages:[ref.page],type:'figure',image:await assets.figure(ref.id)});
  const ruledTables=layout.pages.flatMap(page=>(page.tableRules??[]).map(table=>({...table,page:page.page,sourceLines:table.sourceLines.map(line=>sourceOwners.get(line)!),rows:table.rows.map(row=>row.map(line=>sourceOwners.get(line)!))})));
  const plannedTables=layout.structureTables?.map(table=>({...table,sourceLines:table.rows.flatMap(row=>row.map(cell=>sourceOwners.get(cell.physicalLines[0])!)),
    columns:new Map(table.rows.flatMap(row=>row.map(cell=>[sourceOwners.get(cell.physicalLines[0])!,{column:cell.column,columnSpan:cell.columnSpan}] as const))),
    rows:table.rows.map(row=>row.map(cell=>sourceOwners.get(cell.physicalLines[0])!))}));
  const tables=plannedTables??[...ruledTables,...pdfSourceTables(layout.blocks).filter(table=>!ruledTables.some(ruled=>ruled.sourceLines[0]===table.sourceLines[0]))];
  const panels=layout.structureTables===undefined?[]:layout.pages.flatMap(page=>(page.tableRules??[]).flatMap(frame=>{
    const selected=new Set(layout.structureTables!.flatMap(table=>table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines))));
    const covered=frame.sourceLines.filter(line=>selected.has(line));
    if(covered.length===frame.sourceLines.length)return [];
    if(covered.length)throw new Error(`PDF render ownership: source frame ${frame.id} has partial table ownership at physical IDs ${covered.join(',')}.`);
    const sourceLines=[...new Set(frame.sourceLines.map(line=>sourceOwners.get(line)))];
    if(sourceLines.some(line=>line===undefined))throw new Error(`PDF render ownership: source frame ${frame.id} has unmapped physical IDs.`);
    const owned=new Set(frame.sourceLines),logical=sourceLines as number[];
    for(const line of logical) {
      const block=layout.blocks[line-1],outside=(block.fragments??[line]).filter(id=>!owned.has(id));
      if(outside.length||figureLabels.has(line)||isFolio(block,layout))throw new Error(`PDF render ownership: source frame ${frame.id} crosses logical L${line} ownership at physical IDs ${outside.join(',')||frame.sourceLines.join(',')}.`);
    }
    const ordered=logical.slice().sort((a,b)=>a-b),foreign=layout.blocks.slice(ordered[0]-1,ordered.at(-1)).filter(block=>!logical.includes(block.line));
    if(foreign.length)throw new Error(`PDF render ownership: source frame ${frame.id} has interleaved foreign logical IDs ${foreign.map(block=>block.line).join(',')}.`);
    const rows=frame.rows.map(row=>[...new Set(row.map(line=>sourceOwners.get(line)!))]);
    for(const line of logical) {
      const containing=rows.filter(row=>row.includes(line));
      if(containing.length>1&&containing.some(row=>row.length>1))throw new Error(`PDF render ownership: source frame ${frame.id} logical L${line} spans independently labelled visual rows.`);
    }
    const seen=new Set<number>();
    const visualRows=rows.map(row=>row.filter(line=>{if(seen.has(line))return false;seen.add(line);return true;})).filter(row=>row.length);
    return [{frame,page:page.page,sourceLines:ordered,rows:visualRows}];
  }));
  const panelOwners=new Set(panels.flatMap(panel=>panel.sourceLines)),emittedPanelLines=new Set<number>();
  const emitted=new Set<string>(),emittedTableLines=new Set<number>(),nodes:PdfReflowNode[]=[];
  const sizes=layout.blocks.filter(block=>!block.protection&&block.text.length>80).map(block=>block.fontSize).sort((a,b)=>a-b);
  const bodySize=sizes[Math.floor(sizes.length/2)]??11;
  // Native ownership is identical inside and outside tables. In particular,
  // numeric source glyphs have isolated ink without a math protection flag.
  const nativeKind=(block:PdfTextBlock):'code'|'formula'|'references'|undefined=>referenceLines.has(block.line)?'references':block.protection==='code'?'code'
    :block.protection==='math'||block.sourceInkPath&&/^\d+$/u.test(block.text)&&lines[block.line-1]===block.text?'formula':undefined;
  async function proseNode(block:PdfTextBlock):Promise<PdfReflowNode> {
    const target=lines[block.line-1],parts:PdfReflowPart[]=[],chunks=splitPdfInlineTranslation(block.text,target),tokens=pdfInlineTokens(target);
    for(let index=0;index<chunks.length;index++) {
      if(chunks[index])parts.push({text:chunks[index].replace(/[\u2028\u2029]/gu,' ')});
      if(tokens[index]) {
        const node=block.inlineProtections!.find(node=>node.token===tokens[index])!;
        const image=node.physicalLines?.length?await assets.native(node.sourcePage!,node.physicalLines):await assets.inline(tokens[index]);
        parts.push({token:tokens[index],image:node.physicalLines?{...image,display:node.placement!=='inline'}:image});
      }
    }
    const inferredHeading=block.line===1&&block.fontSize>bodySize*1.2||!isCaption(block.text)&&block.fontSize>bodySize*1.15||/^(?:Abstract|摘要)$/iu.test(block.text.trim())
      ||!isCaption(block.text)&&/^\d+(?:\.\d+)*\s+\p{L}/u.test(block.text)&&block.fontSize>bodySize*1.05;
    const heading=block.structureKind?block.structureKind==='heading':inferredHeading;
    const level=block.line===1?1:/^\d+\.\d+/u.test(block.text)?3:2;
    return {id:`L${block.line}`,sourceLines:[block.line],sourcePages:pdfBlockPages(layout,block),type:heading?'heading':'paragraph',...(heading?{level}:{}),parts};
  }
  async function nativeNode(blocks:PdfTextBlock[],type:'code'|'formula'|'references'):Promise<PdfReflowNode> {
    const owned=blocks.flatMap(block=>block.fragments??[block.line]);
    const page=physical[owned[0]-1].page;
    if(owned.some(line=>physical[line-1].page!==page))throw new Error('A native source image cannot span pages.');
    return {id:`native:L${blocks[0].line}`,sourceLines:blocks.map(block=>block.line),sourcePages:[page],type,image:await assets.native(page,owned)};
  }
  async function emitFigures(block:PdfTextBlock) {
    const pages=pdfBlockPages(layout,block);
    for(const ref of images.filter(ref=>!emitted.has(ref.id)&&pages.includes(ref.page)
      &&(ref.captionLine===block.line||ref.captionLine===undefined&&ref.y+ref.height<=block.y))) {
      nodes.push(await figureNode(ref));emitted.add(ref.id);
    }
  }
  for(let index=0;index<layout.blocks.length;index++) {
    const block=layout.blocks[index];
    for(const ref of images.filter(ref=>!emitted.has(ref.id)&&ref.page<block.page)){nodes.push(await figureNode(ref));emitted.add(ref.id);}
    await emitFigures(block);
    if(emittedTableLines.has(block.line)||emittedPanelLines.has(block.line)||figureLabels.has(block.line))continue;
    if(isFolio(block,layout))continue;
    const panel=panels.find(panel=>panel.sourceLines[0]===block.line);
    if(panel) {
      const cells:PdfReflowNode[][]=[];
      for(const row of panel.rows) {
        const values:PdfReflowNode[]=[];
        for(const line of row) {
          const cell=layout.blocks[line-1],type=nativeKind(cell);
          values.push(type?await nativeNode([cell],type):await proseNode(cell));
        }
        cells.push(values);
      }
      nodes.push({id:`panel:${panel.frame.id}`,type:'panel',sourceLines:[],sourcePages:[panel.page],cells,
        sourceFrame:{page:panel.page,box:panel.frame.box,paintOperations:panel.frame.paintOperations,horizontalRuleOperations:panel.frame.horizontalRuleOperations,physicalRows:panel.frame.rows}});
      panel.sourceLines.forEach(line=>emittedPanelLines.add(line));continue;
    }
    const table=tables.find(table=>Math.min(...table.sourceLines)===block.line);
    if(table) {
      const source=table.sourceLines.map(line=>layout.blocks[line-1]),rows:PdfTextBlock[][]=[];
      if('rows' in table)rows.push(...table.rows.map(row=>row.map(line=>layout.blocks[line-1])));
      else for(const cell of source.slice().sort((a,b)=>a.y-b.y||a.x-b.x)) {
        const row=rows.at(-1);
        if(row&&Math.abs(row[0].y-cell.y)<Math.max(row[0].fontSize,cell.fontSize)*.5)row.push(cell);else rows.push([cell]);
      }
      const cells:PdfReflowNode[][]=[];
      const complete=rows.reduce((best,row)=>row.length>best.length?row:best,[] as PdfTextBlock[]).slice().sort((a,b)=>a.x-b.x);
      const anchors=complete.map(cell=>cell.x);
      for(const row of rows) {
        const values:PdfReflowNode[]=[];
        for(const cell of row.sort((a,b)=>a.x-b.x)) {
          const type=nativeKind(cell),value=type?await nativeNode([cell],type):await proseNode(cell);
          const spanning=row.length===1&&!cell.protection&&!/^\d+(?:\.\d+)?$/u.test(cell.text);
          const column=spanning?0:anchors.reduce((best,x,index)=>Math.abs(x-cell.x)<Math.abs(anchors[best]-cell.x)?index:best,0);
          const covered=anchors.flatMap((x,index)=>index>=column&&x>=cell.x-cell.fontSize/2&&x<cell.x+cell.width-cell.fontSize/2?[index]:[]);
          const columnSpan=spanning?anchors.length:Math.max(1,(covered.at(-1)??column)-column+1);
          Object.assign(value,'columns' in table?table.columns.get(cell.line):{column,columnSpan});values.push(value);
        }
        cells.push(values);
      }
      const tableNode:PdfReflowNode={id:`table:L${block.line}`,type:'table',sourceLines:[],sourcePages:[block.page],cells};
      Object.assign(tableNode,{columnCount:'columnCount' in table?table.columnCount:anchors.length});nodes.push(tableNode);source.forEach(cell=>emittedTableLines.add(cell.line));continue;
    }
    const nativeType=nativeKind(block);
    if(nativeType) {
      const group=[block];
      while(index+1<layout.blocks.length) {
        const next=layout.blocks[index+1],type=nativeKind(next);
        if(type!==nativeType||next.page!==block.page||isFolio(next,layout)||figureLabels.has(next.line)||panelOwners.has(next.line)||tables.some(table=>table.sourceLines.includes(next.line)))break;
        group.push(next);index++;
      }
      nodes.push(await nativeNode(group,nativeType));continue;
    }
    nodes.push(await proseNode(block));
  }
  for(const ref of images.filter(ref=>!emitted.has(ref.id)))nodes.push(await figureNode(ref));
  const owned=new Set<number>();
  const visit=(node:PdfReflowNode)=>{for(const line of node.sourceLines){if(owned.has(line))throw new Error(`PDF HTML repeats source L${line}.`);owned.add(line);}for(const row of node.cells??[])for(const cell of row)visit(cell);};
  nodes.forEach(visit);
  for(const block of layout.blocks)if(!isFolio(block,layout)&&!owned.has(block.line))throw new Error(`PDF HTML omitted source L${block.line}.`);
  return {title:lines[0],language:'zh-CN',sourceHash:layout.sourceHash,originalHash:layout.originalHash,layoutVersion:layout.version,extractorRevision:layout.extractorRevision,nodes};
}
