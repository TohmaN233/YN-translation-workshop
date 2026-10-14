import type {PdfLayout,PdfTextBlock} from './pdfTypes.ts';
import type {PdfStructureKind,PdfStructureParagraph,PdfStructurePlan,PdfStructureTable} from './pdfStructurePlan.ts';
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {pdfSourceTables} from './pdfSourceTables.ts';

export interface PdfStructureDraft {revision:number;plan:PdfStructurePlan}
export interface PdfStructureMerge {anchors:number[];kind:PdfStructureKind;reason:string}
export interface PdfStructureSplit {beforePhysicalLine:number;kind:PdfStructureKind;reason:string}
export interface PdfStructureDraftPatch {
  expectedRevision:number;paragraphs?:PdfStructureParagraph[];tables?:PdfStructureTable[];tablePages?:number[];
  merges?:PdfStructureMerge[];
  splits?:PdfStructureSplit[];
  moves?:Array<{physicalLine:number;afterPhysicalLine?:number}>;
}
const fail=(message:string):never=>{throw new Error(`PDF structure draft: ${message}`);};
const audit=()=>({readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true,issues:[]});
const allowed=(value:unknown,keys:string[],label:string):void=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be an object.`);
  const foreign=Object.keys(value as object).filter(key=>!keys.includes(key));
  if(foreign.length)fail(`${label} has forbidden fields ${foreign.join(', ')}; source text is read-only.`);
};
function sources(base:PdfLayout):Map<number,PdfTextBlock> {
  if(!base.physicalBlocks?.length)fail('physical source blocks are missing.');
  const result=new Map<number,PdfTextBlock>();
  for(const block of base.physicalBlocks!){
    if(!Number.isSafeInteger(block.line)||block.line<1||result.has(block.line)||!base.pages.some(page=>page.page===block.page))fail(`invalid physical source identity L${block.line}.`);
    result.set(block.line,block);
  }
  return result;
}
function ids(value:unknown,source:Map<number,PdfTextBlock>,label:string):number[] {
  if(!Array.isArray(value)||!value.length)fail(`${label} has no source IDs.`);
  const seen=new Set<number>();
  for(const id of value as number[]){
    if(!Number.isSafeInteger(id)||!source.has(id))fail(`${label} claims foreign source ID L${id}.`);
    if(seen.has(id))fail(`${label} duplicates source ID L${id}.`);
    seen.add(id);
  }
  return value as number[];
}
/** Hard draft invariants deliberately exclude geometric and semantic acceptance.
 * A complete candidate may still require native edits before final plan validation. */
function assertHard(base:PdfLayout,plan:PdfStructurePlan):void {
  const source=sources(base),owned=new Map<number,PdfStructureParagraph>();
  allowed(plan,['version','paragraphs','tables','audit'],'plan');
  if(plan.version!==1||!Array.isArray(plan.paragraphs)||!Array.isArray(plan.tables))fail('invalid plan arrays/version.');
  allowed(plan.audit,['readingOrder','paragraphs','tables','figures','protectedContent','issues'],'placeholder audit');
  if(['readingOrder','paragraphs','tables','figures','protectedContent'].some(key=>(plan.audit as unknown as Record<string,unknown>)[key]!==true)||!Array.isArray(plan.audit.issues)||plan.audit.issues.length)fail('draft placeholder audit changed; semantic acceptance belongs to the final native audit.');
  for(const paragraph of plan.paragraphs){
    allowed(paragraph,['physicalLines','kind','reason'],'paragraph');
    ids(paragraph.physicalLines,source,'paragraph');
    if(!['paragraph','heading','caption','table-cell','preserved'].includes(paragraph.kind)||typeof paragraph.reason!=='string'||!paragraph.reason.trim())fail('invalid paragraph role/reason.');
    for(const id of paragraph.physicalLines){if(owned.has(id))fail(`duplicate paragraph owner for L${id}.`);owned.set(id,paragraph);}
  }
  const missing=[...source.keys()].filter(id=>!owned.has(id));if(missing.length)fail(`missing source IDs ${missing.join(', ')}.`);
  const tableIds=new Set<string>(),cells=new Set<number>();
  for(const table of plan.tables){
    allowed(table,['id','page','columnCount','rows','captionPhysicalLine'],'table');
    if(typeof table.id!=='string'||!table.id.trim()||tableIds.has(table.id))fail('duplicate or missing table identity.');tableIds.add(table.id);
    if(!base.pages.some(page=>page.page===table.page)||!Number.isSafeInteger(table.columnCount)||table.columnCount<1||!Array.isArray(table.rows)||!table.rows.length)fail(`invalid table ${table.id} page/columns/rows.`);
    for(const row of table.rows){
      if(!Array.isArray(row)||!row.length)fail(`empty row in table ${table.id}.`);
      const columns=new Set<number>();
      for(const cell of row){
        allowed(cell,['physicalLines','column','columnSpan'],'table cell');ids(cell.physicalLines,source,'table cell');
        const owner=owned.get(cell.physicalLines[0])!;
        if(!['table-cell','preserved'].includes(owner.kind)||JSON.stringify(owner.physicalLines)!==JSON.stringify(cell.physicalLines))fail(`table cell IDs ${cell.physicalLines} do not exactly own a table-cell/preserved paragraph.`);
        if(!Number.isSafeInteger(cell.column)||!Number.isSafeInteger(cell.columnSpan)||cell.column<0||cell.columnSpan<1||cell.column+cell.columnSpan>table.columnCount)fail(`table ${table.id} cell escapes columns.`);
        for(let column=cell.column;column<cell.column+cell.columnSpan;column++){if(columns.has(column))fail(`table ${table.id} overlaps column ${column}.`);columns.add(column);}
        for(const id of cell.physicalLines){if(source.get(id)!.page!==table.page)fail(`table ${table.id} claims foreign page ID L${id}.`);if(cells.has(id))fail(`table cell source L${id} reused.`);cells.add(id);}
      }
    }
    if(table.captionPhysicalLine!==undefined){
      ids([table.captionPhysicalLine],source,'table caption');
      if(source.get(table.captionPhysicalLine)!.page!==table.page||owned.get(table.captionPhysicalLine)!.kind!=='caption'||cells.has(table.captionPhysicalLine))fail(`invalid table ${table.id} caption ownership.`);
    }
  }
  for(const paragraph of plan.paragraphs)if(paragraph.kind==='table-cell'&&paragraph.physicalLines.some(id=>!cells.has(id)))fail(`table-cell IDs ${paragraph.physicalLines} have no table owner.`);
}
const caption=(block:PdfTextBlock)=>/^\s*(?:Figure|Fig\.?|Table|图|表)\s*\d+[A-Za-z]?\s*[:.：．]/iu.test(block.text);
const heading=(block:PdfTextBlock)=>block.structureKind==='heading'||/^\s*(?:\d+(?:\.\d+)*\s+\p{L}|(?:Abstract|Appendix(?:\s+[A-Z0-9](?:[.:]\s*.*)?)?|Appendices|Acknowledgements)\s*$)/iu.test(block.text);
function geometricRows(blocks:PdfTextBlock[]):number[][] {
  const rows:PdfTextBlock[][]=[];
  for(const block of blocks.slice().sort((a,b)=>a.y+a.height/2-b.y-b.height/2||a.x-b.x)){
    const row=rows.at(-1),anchor=row?.[0];
    if(anchor&&Math.abs(anchor.y+anchor.height/2-block.y-block.height/2)<=Math.min(anchor.height,block.height)/2)row!.push(block);else rows.push([block]);
  }
  return rows.map(row=>row.sort((a,b)=>a.x-b.x).map(block=>block.line));
}
function baselineTables(base:PdfLayout,source:Map<number,PdfTextBlock>):PdfStructureTable[] {
  const candidates=base.pages.flatMap(page=>(page.tableRules??[]).map(frame=>({id:frame.id,page:page.page,sourceLines:frame.sourceLines,rows:frame.rows,captionLine:frame.captionLine})));
  const framed=new Set(candidates.flatMap(table=>table.sourceLines));
  for(const table of pdfSourceTables(base.physicalBlocks!))if(!table.sourceLines.some(id=>framed.has(id)))candidates.push({id:`source-table-p${table.page}-L${table.captionLine}`,page:table.page,sourceLines:table.sourceLines,rows:[],captionLine:table.captionLine});
  return candidates.map(table=>{
    const lines=ids(table.sourceLines,source,'mechanical table').filter(id=>id!==table.captionLine);
    const rowIds=table.rows?.length?table.rows.map(row=>row.filter(id=>id!==table.captionLine)).filter(row=>row.length):geometricRows(lines.map(id=>source.get(id)!));
    if(JSON.stringify([...rowIds.flat()].sort((a,b)=>a-b))!==JSON.stringify([...lines].sort((a,b)=>a-b)))fail(`mechanical table ${table.id} rows do not conserve its source IDs.`);
    const anchors:number[]=[];
    for(const row of rowIds.filter(row=>row.length>1))for(const id of row){const x=source.get(id)!.x;if(!anchors.some(anchor=>Math.abs(anchor-x)<=2))anchors.push(x);}
    if(!anchors.length)for(const id of lines){const x=source.get(id)!.x;if(!anchors.some(anchor=>Math.abs(anchor-x)<=2))anchors.push(x);}
    anchors.sort((a,b)=>a-b);if(!anchors.length)fail(`mechanical table ${table.id} lacks source column anchors.`);
    return {id:table.id,page:table.page,columnCount:anchors.length,...(table.captionLine!==undefined?{captionPhysicalLine:table.captionLine}:{}),rows:rowIds.map(row=>row.map(id=>{
      const block=source.get(id)!,column=anchors.reduce((best,x,index)=>Math.abs(block.x-x)<Math.abs(block.x-anchors[best])?index:best,0);
      let columnSpan=1;while(column+columnSpan<anchors.length&&block.x+block.width>anchors[column+columnSpan]+2)columnSpan++;
      return {physicalLines:[id],column,columnSpan};
    }).sort((a,b)=>a.column-b.column))};
  }).sort((a,b)=>a.page-b.page||a.id.localeCompare(b.id));
}

/** Host owns a complete mechanical candidate, so the model never has to emit
 * every unchanged source ID. Placeholder audit flags are not acceptance. */
export function createPdfStructureDraft(base:PdfLayout):PdfStructureDraft {
  const source=sources(base),tables=baselineTables(base,source);
  const cells=new Map(tables.flatMap(table=>table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines.map(id=>[id,cell] as const)))));
  const references=new Set(pdfReferenceSections({blocks:base.physicalBlocks!}).protectedLines.map(row=>row.line));
  const referenceHeadings=new Set(base.physicalBlocks!.filter((block,index)=>references.has(block.line)&&!references.has(base.physicalBlocks![index-1]?.line)).map(block=>block.line));
  const labels=new Set(base.figureGroups?.flatMap(group=>group.physicalLines)??[]);
  const paragraphs:PdfStructureParagraph[]=[];
  // The extractor has already reconciled visual wraps, captions, cross-page
  // continuations and display markers. Hints are diagnostic inputs to that
  // stage, not a second owner map that can undo its result here.
  for(const logical of base.blocks){
    if(!logical.fragments?.length)fail(`mechanical logical owner L${logical.line} lacks physical source fragments.`);
    const group=ids(logical.fragments,source,'mechanical logical owner'),blocks=group.map(id=>source.get(id)!);
    const writable=blocks.find(block=>!block.protection&&!references.has(block.line)&&!labels.has(block.line));
    const flowKind:PdfStructureKind=writable&&caption(writable)?'caption':writable&&heading(writable)?'heading':'paragraph';
    const nativeOnly=blocks.every(block=>block.protection),numericOnly=blocks.every(block=>/^\d+$/u.test(block.text));
    let current:PdfStructureParagraph|undefined,key='';
    for(const block of blocks){
      const cell=cells.get(block.line),folio=block.text===String(block.page)&&block.y>base.pages[block.page-1].height*.85&&block.width<block.fontSize*3;
      let nextKey='flow';let kind:PdfStructureKind=flowKind;
      if(references.has(block.line)) {
        nextKey=`reference:${block.page}:${block.protection??'text'}:${referenceHeadings.has(block.line)?block.line:'body'}`;kind='preserved';
      }else if(labels.has(block.line)||folio) {nextKey=`independent:${block.line}`;kind='preserved';}
      else if(cell) {nextKey=`cell:${cell.physicalLines.join(',')}`;kind=block.protection||/^\d+$/u.test(block.text)?'preserved':'table-cell';}
      else if(block.protection==='code'||nativeOnly) {nextKey=`native:${block.page}:${block.protection}`;kind='preserved';}
      else if(numericOnly) {nextKey=`numeric:${block.line}`;kind='preserved';}
      if(nextKey!==key||!current){current={physicalLines:[],kind,reason:'Host complete mechanical logical owner with immutable ownership boundaries.'};paragraphs.push(current);key=nextKey;}
      current.physicalLines.push(block.line);
    }
  }
  const draft={revision:0,plan:{version:1 as const,paragraphs,tables,audit:audit()}};assertHard(base,draft.plan);return structuredClone(draft);
}

/** Replace complete existing owners and move whole paragraphs under CAS.
 * Final geometric and semantic validation remains applyPdfStructurePlan's job. */
export function resolvePdfStructureMerges(base:PdfLayout,draft:PdfStructureDraft,merges:PdfStructureMerge[]) {
  assertHard(base,draft.plan);const source=sources(base);
  if(!Array.isArray(merges))fail('merges must be an array.');
  const owners=new Map(draft.plan.paragraphs.flatMap((paragraph,index)=>paragraph.physicalLines.map(id=>[id,index] as const))),claimed=new Set<number>();
  return merges.map(merge=>{
    allowed(merge,['anchors','kind','reason'],'merge');
    if(!Array.isArray(merge.anchors)||!merge.anchors.length||merge.anchors.some(anchor=>!Number.isSafeInteger(anchor)||!source.has(anchor)))fail('merge anchors must name nonempty known physical source IDs; foreign source selections are forbidden.');
    if(!['paragraph','heading','caption','table-cell','preserved'].includes(merge.kind)||typeof merge.reason!=='string'||!merge.reason.trim())fail('invalid merge role/reason.');
    const selected=new Set<number>(),resolvedOwners:Array<{anchor:number;physicalLines:number[];kind:PdfStructureKind}>=[],anchorOwners:Array<{anchor:number;ownerAnchor:number;repeatedSelection:boolean}>=[];
    const physicalLines=merge.anchors.flatMap(anchor=>{
      const owner=owners.get(anchor)!;
      const paragraph=draft.plan.paragraphs[owner],first=resolvedOwners.find(item=>item.physicalLines[0]===paragraph.physicalLines[0]);
      anchorOwners.push({anchor,ownerAnchor:first?.anchor??anchor,repeatedSelection:selected.has(owner)});
      if(selected.has(owner))return [];
      if(claimed.has(owner)){
        fail(`merge anchor L${anchor} repeats an existing paragraph owner across merges. Complete owner physicalLines in current order: ${JSON.stringify(paragraph.physicalLines)}; kind: ${paragraph.kind}. Each merge may select an owner repeatedly, but different merges cannot reuse it. For internal reordering or splitting submit explicit paragraphs replacing this complete ID union (or splits for a boundary). Source IDs were not sorted or discarded. This revision is atomic; correct the invalid group and resubmit, optionally as separate local revisions.`);
      }
      selected.add(owner);claimed.add(owner);resolvedOwners.push({anchor,physicalLines:[...paragraph.physicalLines],kind:paragraph.kind});return paragraph.physicalLines;
    });
    return {paragraph:{physicalLines,kind:merge.kind,reason:merge.reason},owners:resolvedOwners,anchorOwners};
  });
}
export function expandPdfStructureMerges(base:PdfLayout,draft:PdfStructureDraft,merges:PdfStructureMerge[]):PdfStructureParagraph[] {
  return resolvePdfStructureMerges(base,draft,merges).map(item=>item.paragraph);
}

export function expandPdfStructureSplits(base:PdfLayout,draft:PdfStructureDraft,splits:PdfStructureSplit[]):Array<{ownerPhysicalLines:number[];groups:PdfStructureParagraph[]}> {
  assertHard(base,draft.plan);const source=sources(base);
  if(!Array.isArray(splits))fail('splits must be an array.');
  const cuts=new Map<PdfStructureParagraph,PdfStructureSplit[]>(),seen=new Set<number>();
  for(const split of splits){
    allowed(split,['beforePhysicalLine','kind','reason'],'split');ids([split.beforePhysicalLine],source,'split');
    if(seen.has(split.beforePhysicalLine))fail(`duplicate split boundary L${split.beforePhysicalLine}.`);seen.add(split.beforePhysicalLine);
    if(!['paragraph','heading','caption','table-cell','preserved'].includes(split.kind)||typeof split.reason!=='string'||!split.reason.trim())fail('invalid split role/reason.');
    const owner=draft.plan.paragraphs.find(paragraph=>paragraph.physicalLines.includes(split.beforePhysicalLine))!;
    const entries=cuts.get(owner)??[];entries.push(split);cuts.set(owner,entries);
  }
  return [...cuts].sort(([a],[b])=>draft.plan.paragraphs.indexOf(a)-draft.plan.paragraphs.indexOf(b)).map(([owner,boundaries])=>{
    boundaries.sort((a,b)=>owner.physicalLines.indexOf(a.beforePhysicalLine)-owner.physicalLines.indexOf(b.beforePhysicalLine));
    const groups:PdfStructureParagraph[]=[];let start=0,kind=owner.kind,reason=owner.reason;
    for(const boundary of boundaries){const end=owner.physicalLines.indexOf(boundary.beforePhysicalLine);
      if(end>start)groups.push({physicalLines:owner.physicalLines.slice(start,end),kind,reason});
      start=end;kind=boundary.kind;reason=boundary.reason;
    }
    groups.push({physicalLines:owner.physicalLines.slice(start),kind,reason});
    return {ownerPhysicalLines:[...owner.physicalLines],groups};
  });
}

export function revisePdfStructureDraft(base:PdfLayout,draft:PdfStructureDraft,input:PdfStructureDraftPatch):PdfStructureDraft {
  allowed(input,['expectedRevision','paragraphs','tables','tablePages','moves','merges','splits'],'patch');
  if(!Number.isSafeInteger(draft.revision)||draft.revision<0||input.expectedRevision!==draft.revision)fail(`stale revision: expected ${input.expectedRevision}, current ${draft.revision}.`);
  assertHard(base,draft.plan);const result=structuredClone(draft),source=sources(base);
  const expanded=input.merges===undefined?[]:expandPdfStructureMerges(base,draft,input.merges);
  const splitGroups=input.splits===undefined?[]:expandPdfStructureSplits(base,draft,input.splits);
  if(expanded.length&&splitGroups.length)fail('submit merges and splits in separate revision calls.');
  if(input.paragraphs!==undefined&&!Array.isArray(input.paragraphs))fail('paragraph patch must be an array.');
  const explicitIds=new Set((input.paragraphs??[]).flatMap(paragraph=>ids(paragraph.physicalLines,source,'paragraph patch')));
  const operationConflict=(operation:string,groups:number[][])=>{
    for(const [operationIndex,group] of groups.entries()){
      const overlap=group.filter(id=>explicitIds.has(id));if(!overlap.length)continue;
      const owners=draft.plan.paragraphs.filter(paragraph=>paragraph.physicalLines.some(id=>overlap.includes(id)));
      const paragraphIndexes=(input.paragraphs??[]).flatMap((paragraph,index)=>paragraph.physicalLines.some(id=>group.includes(id))?[index+1]:[]);
      fail(`${operation} and explicit paragraph patches claim the same existing owner. ${operation}[${operationIndex+1}] conflicts with paragraphs ${JSON.stringify(paragraphIndexes)} at physical IDs ${JSON.stringify(overlap)}. Complete touched owners in current source order: ${JSON.stringify(owners.map(({physicalLines,kind})=>({physicalLines,kind})))}. This revision is atomic; use one operation per owner, or separate local revisions. Explicit paragraphs must replace the complete owner union; use splits for a boundary without guessing its tail.`);
    }
  };
  operationConflict('merge',expanded.map(paragraph=>paragraph.physicalLines));
  operationConflict('split',splitGroups.map(group=>group.ownerPhysicalLines));
  const replace=(paragraphs:PdfStructureParagraph[])=>{
    if(paragraphs.length){
      const patchIds=paragraphs.flatMap(paragraph=>ids(paragraph.physicalLines,source,'paragraph patch'));
      if(new Set(patchIds).size!==patchIds.length)fail('paragraph patch duplicates source IDs.');
      const touched=new Set(patchIds),indexes=result.plan.paragraphs.flatMap((paragraph,index)=>paragraph.physicalLines.some(id=>touched.has(id))?[index]:[]);
      const previous=indexes.flatMap(index=>result.plan.paragraphs[index].physicalLines);
      if(previous.length!==patchIds.length||previous.some(id=>!touched.has(id)))fail(`paragraph patch must replace the complete ID union of every touched owner; partial groups are forbidden. Complete touched owners in current source order: ${JSON.stringify(indexes.map(index=>{const {physicalLines,kind}=result.plan.paragraphs[index];return {physicalLines,kind};}))}. Missing physical IDs: ${JSON.stringify(previous.filter(id=>!touched.has(id)))}. Submitted physical IDs: ${JSON.stringify(patchIds)}. Use explicit splits:[{beforePhysicalLine:SOURCE_ID,kind,reason}] to retain the prefix and complete suffix automatically, or submit explicit paragraphs covering this exact complete owner union. The rejected revision changed no source ownership.`);
      const removed=new Set(indexes),first=indexes[0];
      result.plan.paragraphs=result.plan.paragraphs.flatMap((paragraph,index)=>index===first?structuredClone(paragraphs):removed.has(index)?[]:[paragraph]);
    }
  };
  replace(input.paragraphs??[]);
  for(const paragraph of expanded)replace([paragraph]);
  for(const group of splitGroups)replace(group.groups);
  if(input.tablePages!==undefined||input.tables!==undefined){
    if(input.tables!==undefined&&!Array.isArray(input.tables))fail('tables patch must be an array.');
    const tables=input.tables??[],pages=input.tablePages??[...new Set(tables.map(table=>table.page))];
    if(!Array.isArray(pages)||!pages.length||new Set(pages).size!==pages.length||pages.some(page=>!Number.isSafeInteger(page)||!base.pages.some(item=>item.page===page)))fail('table patch has empty, duplicate or foreign pages.');
    if(input.tablePages!==undefined&&input.tables===undefined)fail('tablePages requires an explicit tables array; submit all tables for each replaced page, or [] to explicitly remove that page\'s candidate tables.');
    if(tables.some(table=>!pages.includes(table.page)))fail('table patch claims an unselected page.');
    result.plan.tables=[...result.plan.tables.filter(table=>!pages.includes(table.page)),...structuredClone(tables)].sort((a,b)=>a.page-b.page||a.id.localeCompare(b.id));
  }
  if(input.moves!==undefined){
    if(!Array.isArray(input.moves))fail('moves must be an array.');
    for(const move of input.moves){
      allowed(move,['physicalLine','afterPhysicalLine'],'move');ids([move.physicalLine],source,'move');
      const from=result.plan.paragraphs.findIndex(paragraph=>paragraph.physicalLines.includes(move.physicalLine));
      const target=move.afterPhysicalLine===undefined?-1:result.plan.paragraphs.findIndex(paragraph=>paragraph.physicalLines.includes(ids([move.afterPhysicalLine],source,'move anchor')[0]));
      if(from===target)fail('move anchor points to the same paragraph.');
      const [paragraph]=result.plan.paragraphs.splice(from,1);
      const after=move.afterPhysicalLine===undefined?-1:result.plan.paragraphs.findIndex(item=>item.physicalLines.includes(move.afterPhysicalLine!));
      result.plan.paragraphs.splice(after+1,0,paragraph);
    }
  }
  result.plan.audit=audit();assertHard(base,result.plan);
  if(JSON.stringify(result.plan)!==JSON.stringify(draft.plan))result.revision++;
  return result;
}
