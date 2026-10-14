import {createHash} from 'node:crypto';
import {pdfProtectionHash,validatePdfLayout} from './pdfTypes.ts';
import type {PdfBox,PdfInlineProtection,PdfLayout,PdfProseSegment,PdfTextBlock} from './pdfTypes.ts';
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {pdfNativePlacement} from './pdfNativePlacement.ts';

export type PdfStructureKind = 'paragraph'|'heading'|'caption'|'table-cell'|'preserved';
export interface PdfStructureParagraph {physicalLines:number[];kind:PdfStructureKind;reason:string}
export interface PdfStructureTableCell {physicalLines:number[];column:number;columnSpan:number}
export interface PdfStructureTable {id:string;page:number;columnCount:number;rows:PdfStructureTableCell[][];captionPhysicalLine?:number}
export interface PdfStructurePlan {
  version:1;
  paragraphs:PdfStructureParagraph[];
  tables:PdfStructureTable[];
  audit:{readingOrder:boolean;paragraphs:boolean;tables:boolean;figures:boolean;protectedContent:boolean;issues:Array<{physicalLines:number[];message:string}>};
}
export interface PdfStructurePlanMetrics {
  physicalBlocks:number;paragraphs:number;coverage:number;coveragePercent:number;
  duplicates:number;foreign:number;protectedUnchanged:boolean;
  /** The supplied semantic judgment passed its acceptance gate, not a mechanical proof. */
  semanticAuditAccepted:boolean;
  nativeSources:number;nativeCoverage:number;graphicOperations:number;graphicCoverage:number;figureAssets:number;figureCoverage:number;
}
export interface PdfStructureGeometryFinding {physicalLines:number[];message:string}
const joiner=(a:string,b:string)=>!a||!b||/\s$/u.test(a)||/^\s/u.test(b)||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)||/[A-Za-z]-$/u.test(a)&&/^[A-Za-z]/u.test(b)?'':' ';
const union=(boxes:PdfBox[]):PdfBox=>{const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};};
const keys=(value:unknown,allowed:string[],identity:string):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`PDF structure plan ${identity}: expected an object.`);
  const record=value as Record<string,unknown>,unknown=Object.keys(record).filter(key=>!allowed.includes(key));
  if(unknown.length)throw Error(`PDF structure plan ${identity}: forbidden fields ${unknown.join(', ')}; source text is read-only.`);
  return record;
};
const signature=(lines:number[])=>JSON.stringify(lines);
const startsList=(text:string)=>/^\s*(?:\((?:\d+|[a-z]|[ivxlcdm]+)\)|\d+[.)])\s*\S|^\s*[•●▪‣–-]\s+\S/iu.test(text);

/** Validate identity and source ownership independently of the LLM's semantic
 * audit. The plan contains source IDs only; it cannot author or replace text. */
export function validatePdfStructurePlan(base:PdfLayout,value:unknown,onEvidence?:(finding:PdfStructureGeometryFinding)=>void):PdfStructurePlanMetrics {
  validatePdfLayout(base);
  const physical=base.physicalBlocks;
  if(!physical?.length)throw Error('PDF structure plan: physical source blocks are missing; regenerate the source projection.');
  const fail=(message:string):never=>{throw Error(`PDF structure plan: ${message}`);};
  const evidence=(physicalLines:number[],message:string)=>onEvidence?.({physicalLines:[...physicalLines],message});
  const plan=keys(value,['version','paragraphs','tables','audit'],'root');
  if(plan.version!==1||!Array.isArray(plan.paragraphs)||!plan.paragraphs.length||!Array.isArray(plan.tables))fail('unsupported version or missing paragraph/table arrays.');
  const sources=new Map(physical.map(block=>[block.line,block])),owners=new Map<number,PdfStructureParagraph>(),cellOwners=new Map<string,PdfStructureParagraph>();
  const referenceIds=new Set(pdfReferenceSections({blocks:physical}).protectedLines.map(row=>row.line));
  const referenceHeadings=new Set(physical.filter((block,index)=>referenceIds.has(block.line)&&!referenceIds.has(physical[index-1]?.line)).map(block=>block.line));
  const declaredTableIds=(plan.tables as PdfStructureTable[]).flatMap(table=>Array.isArray(table?.rows)?table.rows.flatMap(row=>Array.isArray(row)?row.flatMap(cell=>Array.isArray(cell?.physicalLines)?cell.physicalLines.filter(line=>sources.has(line)):[]):[]):[]);
  const sourceTableIds=new Set(declaredTableIds);
  const figureLabelIds=new Set(base.figureGroups?.flatMap(group=>group.physicalLines)??[]);
  const folio=(block:PdfTextBlock)=>block.text===String(block.page)&&block.y>base.pages[block.page-1].height*.85&&block.width<block.fontSize*3;
  const caption=(block:PdfTextBlock)=>!block.protection&&/^\s*(?:Figure|Fig\.?|Table|图|表)\s*\d+[A-Za-z]?\s*[:.：．]/iu.test(block.text);
  // Untagged text prefixes ("1 million", for example) are semantic hints for
  // the model, not hard heading authority. Explicit source roles remain pinned.
  const heading=(block:PdfTextBlock)=>!block.protection&&block.structureKind==='heading';
  const tokens=new Set<string>();
  for(const block of physical)for(const native of block.inlineProtections??[]){
    if(tokens.has(native.token))fail(`native token ${native.token} is reused by physical source L${block.line}.`);
    tokens.add(native.token);
  }
  const sourceLines=(value:unknown,identity:string):number[]=>{
    if(!Array.isArray(value)||!value.length)fail(`${identity} has no physical source IDs.`);
    for(const line of value as unknown[])if(!Number.isSafeInteger(line)||!sources.has(line as number))fail(`${identity} claims foreign physical source ID L${String(line)}.`);
    if(new Set(value as number[]).size!==(value as number[]).length)fail(`${identity} repeats physical IDs ${JSON.stringify(value)}.`);
    return value as number[];
  };
  for(const [index,entry] of (plan.paragraphs as unknown[]).entries()) {
    const item=keys(entry,['physicalLines','kind','reason'],`paragraph ${index+1}`);
    const ids=sourceLines(item.physicalLines,`paragraph ${index+1}`),blocks=ids.map(line=>sources.get(line)!);
    if(!['paragraph','heading','caption','table-cell','preserved'].includes(item.kind as string)||typeof item.reason!=='string'||!item.reason.trim())fail(`paragraph ${index+1} has invalid kind/reason for IDs ${ids}.`);
    for(const line of ids){if(owners.has(line))fail(`physical source L${line} is owned by multiple paragraphs.`);owners.set(line,entry as PdfStructureParagraph);}
    const pages=blocks.map(block=>block.page);
    if(pages.some((page,index)=>index>0&&(page<pages[index-1]||page>pages[index-1]+1)))evidence(ids,'Source page order/gaps change; inspect floats and reading flow.');
    const protectedBlocks=blocks.filter(block=>block.protection),kind=item.kind as PdfStructureKind;
    if(blocks.some(block=>referenceIds.has(block.line))&&!(kind==='preserved'&&blocks.every(block=>referenceIds.has(block.line))))fail(`reference section source IDs ${ids} must retain preserved ownership.`);
    if(blocks.some(block=>referenceHeadings.has(block.line))&&ids.length!==1)fail(`reference heading source IDs ${ids} must remain independent so section protection stays discoverable.`);
    if(blocks.some(block=>figureLabelIds.has(block.line))&&!(kind==='preserved'&&ids.length===1))fail(`figure panel label source IDs ${ids} must retain independent native ownership.`);
    if(blocks.some(folio)&&!(kind==='preserved'&&ids.length===1))fail(`folio source IDs ${ids} cannot enter a paragraph.`);
    if(blocks.some(heading)&&kind!=='heading')evidence(ids,`Source heading hint enters ${kind}; verify its actual semantic role.`);
    if(blocks.some(caption)&&kind!=='caption')evidence(ids,`Source caption prefix enters ${kind}; verify its actual semantic role.`);
    if(blocks.some(block=>sourceTableIds.has(block.line))&&kind!=='table-cell'&&kind!=='preserved')fail(`confirmed table cell source IDs ${ids} cannot enter ${kind}.`);
    if(kind==='preserved') {
      if(blocks.some(block=>!block.protection&&!referenceIds.has(block.line)&&!/^\d+$/u.test(block.text)))fail(`preserved paragraph claims writable prose IDs ${ids}.`);
      if(new Set(pages).size!==1||new Set(blocks.map(block=>block.protection)).size!==1)fail(`preserved IDs ${ids} mix pages or native protection kinds.`);
      if(blocks.some(block=>!block.protection&&!referenceIds.has(block.line))&&ids.length>1)fail(`numeric native source IDs ${ids} must retain independent glyph ownership.`);
    } else {
      if(!blocks.some(block=>!block.protection))fail(`native-only IDs ${ids} must remain preserved.`);
      if(protectedBlocks.some(block=>block.protection==='code'))fail(`code source IDs ${protectedBlocks.filter(block=>block.protection==='code').map(block=>block.line)} cannot become writable prose.`);
      if(protectedBlocks.length&&kind!=='paragraph'&&kind!=='table-cell')evidence(ids,`Native display content appears in ${kind}; inspect its source role while retaining the original glyphs.`);
      if(new Set(pages).size>1&&kind!=='paragraph')evidence(ids,`${kind} spans source pages; verify continuation ownership.`);
    }
    if(kind!=='preserved') {
      const prose=blocks.filter(block=>!block.protection);
      if(prose.some(block=>Math.abs(block.fontSize-prose[0].fontSize)>.01))evidence(ids,'Source font scales differ; this may be emphasis or a semantic boundary.');
      for(const native of protectedBlocks) {
        const column=prose.filter(block=>block.page===native.page);
        if(!column.length||native.x<Math.min(...column.map(block=>block.x))-native.fontSize
          ||native.x+native.width>Math.max(...column.map(block=>block.x+block.width))+native.fontSize
          ||native.y<Math.min(...column.map(block=>block.y))-native.height-native.fontSize*1.5
          ||native.y>Math.max(...column.map(block=>block.y+block.height))+native.fontSize*1.5)
          evidence(ids,`Native L${native.line} is outside the inferred prose envelope; inspect display ownership.`);
      }
      for(let cursor=1;cursor<prose.length;cursor++) {
        const before=prose[cursor-1],after=prose[cursor],nativeBetween=blocks.slice(blocks.indexOf(before)+1,blocks.indexOf(after));
        if(after.page===before.page) {
          const last=nativeBetween.length?union(nativeBetween):before;
          const leading=(after.baseline??after.y+after.fontSize)-(before.baseline??before.y+before.fontSize);
          const sameColumn=before.columnX!==undefined&&after.columnX!==undefined?Math.abs(after.columnX-before.columnX)<before.fontSize*.5:Math.abs(after.x-before.x)<=before.fontSize*2;
          const horizontalContinuation=Math.abs(leading)<before.fontSize*.4&&after.x>=before.x+before.width-before.fontSize*.3
            &&after.x-before.x-before.width<=before.fontSize*2;
          if(before.sourceScope&&after.sourceScope&&before.sourceScope!==after.sourceScope)evidence(ids,`Source paragraph tags differ on page ${before.page}; tags may describe runs instead of semantic paragraphs.`);
          if(horizontalContinuation) {
            const skipped=physical.filter(block=>block.page===before.page&&!ids.includes(block.line)
              &&Math.abs((block.baseline??block.y+block.fontSize)-(before.baseline??before.y+before.fontSize))<before.fontSize*.4
              &&block.x>=before.x+before.width-before.fontSize*.3&&block.x+block.width<=after.x+before.fontSize*.3);
            if(skipped.length)evidence(ids,`Horizontal flow passes source IDs ${skipped.map(block=>block.line)}; inspect reading order.`);
            continue;
          }
          const left=before.columnX??before.x,right=after.columnX??after.x,font=before.fontSize;
          const body=physical.filter(block=>block.page===before.page&&!block.protection&&!folio(block)&&!sourceTableIds.has(block.line)&&!caption(block)&&!heading(block)&&Math.abs(block.fontSize-font)<=.01);
          const leftBody=body.filter(block=>Math.abs((block.columnX??block.x)-left)<font*.5);
          const rightBody=body.filter(block=>Math.abs((block.columnX??block.x)-right)<font*.5);
          // A same-page column transition needs source evidence: nonoverlapping
          // columns, last body row at the bottom then first row at the top.
          const columnTransition=kind==='paragraph'&&!sameColumn&&right>left+font*2
            &&before.y+before.height>base.pages[before.page-1].height*.65&&after.y<base.pages[after.page-1].height*.35
            &&leftBody.every(block=>block.x+block.width<=right+font)
            &&leftBody.every(block=>(block.baseline??block.y+font)<=(before.baseline??before.y+font)+font*.4)
            &&rightBody.every(block=>(block.baseline??block.y+font)>=(after.baseline??after.y+font)-font*.4);
          if(columnTransition)continue;
          const indentedBoundary=after.x>before.x+before.fontSize*.75&&!startsList(before.text)&&/[.!?。！？]["'”’)]*$/u.test(before.text.trim());
          if(leading<before.fontSize*.4||!sameColumn||indentedBoundary||after.y-(last.y+last.height)>before.fontSize*1.5)
            evidence(ids,`Source L${before.line},L${after.line} differ from the same-column visual-wrap heuristic.`);
          const skip=physical.filter(block=>block.page===before.page&&!ids.includes(block.line)&&!folio(block)&&!sourceTableIds.has(block.line)
            &&!caption(block)&&block.y>=before.y+before.height/2&&block.y<after.y&&Math.abs(block.x-before.x)<=before.fontSize*2);
          if(skip.length)evidence(ids,`Flow passes source IDs ${skip.map(block=>block.line)}; inspect columns, floats and reading order.`);
        } else {
          if(before.y+before.height<base.pages[before.page-1].height*.65||after.y>base.pages[after.page-1].height*.35
            ||Math.abs(before.x-after.x)>before.fontSize*2)evidence(ids,`Source L${before.line},L${after.line} differ from the cross-page continuation heuristic.`);
        }
      }
    }
    if(kind==='table-cell'||kind==='preserved')cellOwners.set(signature(ids),entry as PdfStructureParagraph);
  }
  const missing=physical.filter(block=>!owners.has(block.line)).map(block=>block.line);
  if(missing.length)fail(`missing physical source IDs ${missing.join(', ')}.`);
  const startPages=(plan.paragraphs as PdfStructureParagraph[]).map(paragraph=>sources.get(paragraph.physicalLines[0])!.page);
  if(startPages.some((page,index)=>index>0&&page<startPages[index-1]))evidence([], 'Document flow revisits earlier source pages; verify floats and reading order.');
  const tableIds=new Set<string>(),claimedCells=new Set<number>();
  for(const raw of plan.tables as unknown[]) {
    const table=keys(raw,['id','page','columnCount','rows','captionPhysicalLine'],'table');
    if(typeof table.id!=='string'||!table.id.trim()||tableIds.has(table.id))fail(`duplicate or missing table identity ${String(table.id)}.`);
    tableIds.add(table.id as string);
    if(!Number.isSafeInteger(table.page)||!base.pages.some(page=>page.page===table.page)||!Number.isSafeInteger(table.columnCount)||(table.columnCount as number)<1||!Array.isArray(table.rows)||!table.rows.length)fail(`table ${table.id} has invalid page/column/row ownership.`);
    const rowBoxes:PdfBox[][]=[];
    for(const [rowIndex,rawRow] of (table.rows as unknown[]).entries()) {
      if(!Array.isArray(rawRow)||!rawRow.length)fail(`table ${table.id} row ${rowIndex+1} is empty.`);
      const occupied=new Set<number>(),boxes:PdfBox[]=[],columns:number[]=[];
      for(const rawCell of rawRow as unknown[]) {
        const cell=keys(rawCell,['physicalLines','column','columnSpan'],`table ${table.id} cell`),ids=sourceLines(cell.physicalLines,`table ${table.id} cell`);
        if(!cellOwners.has(signature(ids)))fail(`table ${table.id} cell IDs ${ids} do not exactly own one table-cell/preserved paragraph.`);
        if(!Number.isSafeInteger(cell.column)||!Number.isSafeInteger(cell.columnSpan)||(cell.column as number)<0||(cell.columnSpan as number)<1||(cell.column as number)+(cell.columnSpan as number)>(table.columnCount as number))fail(`table ${table.id} cell IDs ${ids} escape declared columns.`);
        for(let column=cell.column as number;column<(cell.column as number)+(cell.columnSpan as number);column++){if(occupied.has(column))fail(`table ${table.id} row ${rowIndex+1} overlaps column ${column}.`);occupied.add(column);}
        for(const line of ids){if(claimedCells.has(line))fail(`table source L${line} is reused.`);if(sources.get(line)!.page!==table.page)fail(`table ${table.id} claims foreign page source L${line}.`);claimedCells.add(line);}
        boxes.push(union(ids.map(line=>sources.get(line)!)));columns.push(cell.column as number);
      }
      const sorted=boxes.map((box,index)=>({box,column:columns[index]})).sort((a,b)=>a.column-b.column);
      if(sorted.some((cell,index)=>index>0&&cell.box.x<sorted[index-1].box.x+sorted[index-1].box.width-2))evidence((rawRow as PdfStructureTableCell[]).flatMap(cell=>cell.physicalLines),`Table ${table.id} row ${rowIndex+1} source envelopes overlap or reverse; verify columns.`);
      const centers=boxes.map(box=>box.y+box.height/2);
      if(Math.max(...centers)-Math.min(...centers)>Math.max(...boxes.map(box=>box.height)))evidence((rawRow as PdfStructureTableCell[]).flatMap(cell=>cell.physicalLines),`Table ${table.id} row ${rowIndex+1} has separate source baselines; verify cell relations.`);
      rowBoxes.push(boxes);
    }
    if(rowBoxes.filter(row=>row.length>=2).length<2)evidence([],`Table ${table.id} has limited repeated-column evidence; inspect the original page.`);
    if(table.captionPhysicalLine!==undefined){
      const ids=sourceLines([table.captionPhysicalLine],`table ${table.id} caption`),source=sources.get(ids[0])!;
      if(source.page!==table.page||owners.get(source.line)!.kind!=='caption'||claimedCells.has(source.line))fail(`table ${table.id} caption L${source.line} lacks independent same-page caption ownership.`);
    }
  }
  for(const paragraph of plan.paragraphs as PdfStructureParagraph[])if(paragraph.kind==='table-cell'&&paragraph.physicalLines.some(line=>!claimedCells.has(line)))fail(`table-cell IDs ${paragraph.physicalLines} have no table owner.`);
  const plannedReferenceIds=(plan.paragraphs as PdfStructureParagraph[]).flatMap(paragraph=>paragraph.physicalLines.filter(line=>referenceIds.has(line)));
  if(signature(plannedReferenceIds)!==signature([...referenceIds]))evidence(plannedReferenceIds,'Reference source order differs; inspect citation flow and presentation-only folios.');
  const referencePositions=(plan.paragraphs as PdfStructureParagraph[]).map((paragraph,index)=>paragraph.physicalLines.some(line=>referenceIds.has(line))?index:-1).filter(index=>index>=0);
  if(referencePositions.some((position,index)=>index>0&&position!==referencePositions[index-1]+1))evidence(plannedReferenceIds,'Reference owners are separated by other source owners; inspect columns, floats and section placement.');
  const audit=keys(plan.audit,['readingOrder','paragraphs','tables','figures','protectedContent','issues'],'audit');
  if(!Array.isArray(audit.issues))fail('semantic audit issues must be an array.');
  if(['readingOrder','paragraphs','tables','figures','protectedContent'].some(key=>audit[key]!==true)||(audit.issues as unknown[]).length)fail(`semantic audit has not accepted all requirements; issues ${JSON.stringify(audit.issues)}.`);
  return {physicalBlocks:physical.length,paragraphs:(plan.paragraphs as unknown[]).length,coverage:1,coveragePercent:100,duplicates:0,foreign:0,protectedUnchanged:true,semanticAuditAccepted:true,
    nativeSources:physical.filter(block=>block.protection).length+physical.reduce((sum,block)=>sum+(block.inlineProtections?.length??0),0),nativeCoverage:1,
    graphicOperations:base.pages.reduce((sum,page)=>sum+(page.graphicOperations?.length??0),0),graphicCoverage:1,
    figureAssets:base.references.filter(ref=>/^p\d+-image\d+$/u.test(ref.id)||ref.kind==='vector').length,figureCoverage:1};
}

/** Build text exclusively from the retained physical source, preserving native
 * paint identities and source pages while honoring the accepted reading order. */
export function applyPdfStructurePlan(base:PdfLayout,plan:PdfStructurePlan):{layout:PdfLayout;sourceText:string;metrics:PdfStructurePlanMetrics;geometryFindings:PdfStructureGeometryFinding[];renderOwnershipVerified?:boolean} {
  const geometryFindings:PdfStructureGeometryFinding[]=[];
  const metrics=validatePdfStructurePlan(base,plan,finding=>geometryFindings.push(finding)),layout=structuredClone(base),physical=layout.physicalBlocks!;
  const byId=new Map(physical.map(block=>[block.line,block])),owners=new Map<number,number>();
  const nextToken=new Map(layout.pages.map(page=>[page.page,Math.max(0,...physical.filter(block=>block.page===page.page).flatMap(block=>block.inlineProtections?.map(node=>Number(node.token.match(/:(\d+)\}\}$/u)![1]))??[]))+1]));
  const oldCaptionPhysical=(line:number)=>base.blocks[line-1]?.fragments?.[0]??line;
  layout.blocks=plan.paragraphs.map((paragraph,index)=>{
    const source=paragraph.physicalLines.map(line=>byId.get(line)!),first=source[0];
    paragraph.physicalLines.forEach(line=>owners.set(line,index+1));
    const block:PdfTextBlock={...structuredClone(first),line:index+1,fragments:[...paragraph.physicalLines],structureKind:paragraph.kind};
    if(paragraph.kind==='preserved'&&first.protection) {
      block.text=source.reduce((text,item)=>text+joiner(text,item.text)+item.text,'');
      if(source.length>1){Object.assign(block,union(source));block.sourceInkBox=union(source.map(item=>item.sourceInkBox??item));delete block.sourceInkPath;delete block.sourceInkHash;}
      if(first.protection)block.paintOperations=[...new Set(source.flatMap(item=>item.paintOperations??[]))];
      block.nativePathOperations=[...new Set(source.flatMap(item=>item.nativePathOperations??[]))];
      return block;
    }
    delete block.protection;delete block.paintOperations;
    if(!(paragraph.kind==='preserved'&&source.length===1&&/^\d+$/u.test(first.text))) {
      delete block.sourceInkPath;delete block.sourceInkHash;delete block.sourceInkBox;delete block.nativePathOperations;
    }
    const segments:PdfProseSegment[]=[{text:'',boxes:[]}],nodes:PdfInlineProtection[]=[];
    for(let cursor=0;cursor<source.length;cursor++) {
      const item=source[cursor];
      if(item.protection==='math') {
        const placement=pdfNativePlacement(physical,[item.line]),displays=[item];
        while(source[cursor+1]?.protection==='math'&&source[cursor+1].page===item.page
          &&pdfNativePlacement(physical,[source[cursor+1].line])===placement
          &&(placement==='display'||pdfNativePlacement(physical,[...displays.map(row=>row.line),source[cursor+1].line])==='inline'))displays.push(source[++cursor]);
        const box=union(displays.map(display=>display.sourceInkBox??display)),number=nextToken.get(item.page)!;nextToken.set(item.page,number+1);
        nodes.push({...box,inkBox:box,token:`{{formula:p${item.page}:${number}}}`,text:displays.map(display=>display.text).join(' '),kind:'math',sourcePage:item.page,physicalLines:displays.map(display=>display.line),placement,paintOperations:[...new Set(displays.flatMap(display=>display.paintOperations??[]))],nativePathOperations:[...new Set(displays.flatMap(display=>display.nativePathOperations??[]))]});
        segments.push({text:'',boxes:[]});continue;
      }
      const incoming=item.proseSegments??[{text:item.text,boxes:[item]}],last=segments.at(-1)!;
      last.text+=joiner(last.text,incoming[0].text)+incoming[0].text;
      last.boxes.push(...incoming[0].boxes.map(box=>({...structuredClone(box),page:box.page??item.page})));
      for(let part=0;part<(item.inlineProtections?.length??0);part++) {
        nodes.push({...structuredClone(item.inlineProtections![part]),sourcePage:item.page});
        const segment=incoming[part+1];segments.push({text:segment.text,boxes:segment.boxes.map(box=>({...structuredClone(box),page:box.page??item.page}))});
      }
    }
    block.inlineProtections=nodes;block.proseSegments=segments;block.text=segments.map((segment,index)=>segment.text+(nodes[index]?.token??'')).join('');
    return block;
  });
  for(const reference of layout.references)if(reference.captionLine!==undefined)reference.captionLine=owners.get(oldCaptionPhysical(reference.captionLine))!;
  for(const group of layout.figureGroups??[])if(group.captionLine!==undefined)group.captionLine=owners.get(oldCaptionPhysical(group.captionLine))!;
  layout.structureTables=structuredClone(plan.tables);
  const sourceText=layout.blocks.map(block=>block.text).join('\n');
  layout.sourceHash=createHash('sha256').update(sourceText).digest('hex');layout.protectionHash=pdfProtectionHash(layout);
  validatePdfLayout(layout);
  const beforeReferences=pdfReferenceSections({blocks:physical}).protectedLines.map(row=>row.line);
  const afterReferences=pdfReferenceSections(layout).protectedLines.flatMap(row=>layout.blocks[row.line-1].fragments!);
  if(signature(beforeReferences.slice().sort((a,b)=>a-b))!==signature(afterReferences.slice().sort((a,b)=>a-b)))throw Error(`PDF structure plan: applied reference source IDs changed from ${beforeReferences} to ${afterReferences}.`);
  return {layout,sourceText,metrics,geometryFindings};
}
