import {createHash} from 'node:crypto';
import type {PdfLayout,PdfTextBlock} from './pdfTypes.ts';
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {pdfAuditScopes} from './pdfAuditScopes.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const auditOwnerKey=(block:PdfTextBlock)=>digest([block.fragments??[block.line],block.structureKind??'paragraph']);
export const auditChecks=['readingOrder','paragraphs','tables','figures','protectedContent'] as const;
export interface PdfAuditResult {version:1;checks:Record<typeof auditChecks[number],boolean>;issues:Array<{physicalLines:number[];message:string}>}
export interface PdfAuditPacket {
  version:1;id:string;kind:'local'|'order';promptVersion:number;systemHash:string;originalHash:string;mechanicalHash:string;
  corePhysicalLines:number[];coreOwnerKeys:string[];edgeKeys:string[];relationKeys:string[];
  requiredPhysicalLines:number[];requiredLogicalLines:number[];requiredOwnerKeys:string[];
  records:Array<Record<string,unknown>>;metadata:Record<string,unknown>;
}
export interface PdfAuditScopeEvidence {
  version:1;scopeId:string;packetHash:string;corePhysicalLines:number[];coreOwnerKeys:string[];edgeKeys:string[];relationKeys:string[];
  inspectedPhysicalLines:number[];inspectedOwnerKeys:string[];audit:PdfAuditResult;
  inspectedRecordIndices:number[];
  extraPreparedOwnerKeys?:string[];globalPreparedHash?:string;
  sessionId:string;providerId:string;modelId:string;
}

/** Formatting is an inspection view only; canonical coordinates stay exact. */
export function inspectionGeometry<T>(value:T):T {
  if(Array.isArray(value))return value.map(inspectionGeometry) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,inspectionGeometry(item)])) as T;
  if(typeof value==='number'&&!Number.isInteger(value)){
    const rounded=Math.round(value*100)/100;return (rounded===0&&value!==0?Number(value.toPrecision(3)):rounded) as T;
  }
  return value;
}
export function figureInspectionIndex(layout:PdfLayout){
  const caption=(logical:number|undefined)=>{
    if(logical===undefined)return undefined;const block=layout.blocks[logical-1];
    if(!block||layout.physicalBlocks&&!block.fragments?.length)throw new Error('PDF figure caption lacks physical source identity.');
    return block.fragments?.[0]??block.line;
  };
  return inspectionGeometry({references:layout.references.filter(ref=>/^p\d+-image\d+$/u.test(ref.id)||ref.kind==='vector').map(ref=>({id:ref.id,page:ref.page,kind:ref.kind??'raster',
    x:ref.x,y:ref.y,width:ref.width,height:ref.height,captionPhysicalLine:caption(ref.captionLine),preservation:'original-source-image'})),
    groups:(layout.figureGroups??[]).map(group=>({id:group.id,page:group.page,referenceIds:group.referenceIds,physicalLines:group.physicalLines,
      x:group.x,y:group.y,width:group.width,height:group.height,captionPhysicalLine:caption(group.captionLine),preservation:'original-source-image-and-owned-labels'}))});
}
export function tableRuleInspection(layout:PdfLayout){
  return layout.pages.flatMap(page=>(page.tableRules??[]).map(({captionLine,...frame})=>({...frame,page:page.page,...(captionLine===undefined?{}:{captionPhysicalLine:captionLine})})));
}
/** Present the actual source reading sequence without asking the model to
 * mentally replace opaque markers. Extracted native text is read-only glyph
 * evidence, never TeX or replacement prose. Rendering still uses the native ink. */
export function sourceReadingSequence(block:PdfTextBlock){
  const nodes=new Map((block.inlineProtections??[]).map(node=>[node.token,node]));
  if(!nodes.size)return [{kind:block.protection?'native':'prose',text:block.text,...(block.protection?{readonly:true}: {})}];
  const sequence:Array<Record<string,unknown>>=[];let cursor=0;
  for(const match of block.text.matchAll(/\{\{(?:formula|code):p\d+:\d+\}\}/gu)){
    const node=nodes.get(match[0]);if(!node)throw new Error('PDF audit reading sequence has an unknown native marker.');
    if(match.index>cursor)sequence.push({kind:'prose',text:block.text.slice(cursor,match.index)});
    sequence.push({kind:'native',token:node.token,text:node.text,readonly:true,
      placement:node.placement??(node.physicalLines?.length?'display':'inline'),...(node.physicalLines?{physicalLines:node.physicalLines}:{})});
    cursor=match.index+match[0].length;
  }
  if(cursor<block.text.length)sequence.push({kind:'prose',text:block.text.slice(cursor)});
  return sequence;
}
export function sourceInspectionRows(layout:PdfLayout,ids:number[],geometry:boolean){
  const physical=layout.physicalBlocks??layout.blocks,byId=new Map(physical.map(row=>[row.line,row]));
  const references=new Set(pdfReferenceSections({blocks:physical}).protectedLines.map(row=>row.line));
  return ids.map(id=>{
    const block=byId.get(id);if(!block)throw new Error('PDF source inspection has an unknown physical ID.');
    return inspectionGeometry({physicalLine:block.line,page:block.page,text:block.text,
      ...(block.inlineProtections?.length?{readingSequence:sourceReadingSequence(block)}:{}),
      ...(geometry?{x:block.x,y:block.y,width:block.width,height:block.height,fontSize:block.fontSize,segmentation:block.segmentation,sourceScope:block.sourceScope,baseline:block.baseline,columnX:block.columnX}:{}),
      protection:block.protection,...(references.has(id)?{reference:true}:{}),
      ...(block.inlineProtections?.length?{inlineNodes:block.inlineProtections.map(node=>({token:node.token,text:node.text,kind:node.kind}))}:{})});
  });
}
export function preparedInspectionRows(layout:PdfLayout,ids:number[]){
  const physical=layout.physicalBlocks??layout.blocks,sourceById=new Map(physical.map(row=>[row.line,row]));
  const referenceIds=new Set(pdfReferenceSections({blocks:physical}).protectedLines.map(row=>row.line));
  return ids.map(id=>{
    const block=layout.blocks[id-1];if(!block||block.line!==id)throw new Error('PDF prepared inspection has an unknown logical row.');
    const sourceIds=block.fragments??[id];if(sourceIds.some(sourceId=>!sourceById.has(sourceId)))throw new Error('PDF prepared inspection claims an unknown source ID.');
    const referenceOwnership=sourceIds.filter(sourceId=>referenceIds.has(sourceId));
    const figureLabelOwnership=(layout.figureGroups??[]).flatMap(group=>{
      const physicalLines=sourceIds.filter(sourceId=>group.physicalLines.includes(sourceId));
      return physicalLines.length?[{groupId:group.id,page:group.page,physicalLines,referenceIds:group.referenceIds,sourceFrame:{x:group.x,y:group.y,width:group.width,height:group.height},renderedInGroup:true}]:[];
    });
    const folios=sourceIds.filter(sourceId=>{const source=sourceById.get(sourceId)!;return source.text===String(source.page)&&source.y>layout.pages[source.page-1].height*.85&&source.width<source.fontSize*3;});
    const tableCells=layout.structureTables?.flatMap(table=>table.rows.flatMap((row,rowIndex)=>row.filter(cell=>JSON.stringify(cell.physicalLines)===JSON.stringify(sourceIds)).map(cell=>({tableId:table.id,page:table.page,row:rowIndex,column:cell.column,columnSpan:cell.columnSpan}))));
    return inspectionGeometry({logicalLine:id,physicalLines:sourceIds,kind:block.structureKind,text:block.text,protection:block.protection,
      ...(block.inlineProtections?.length?{readingSequence:sourceReadingSequence(block)}:{}),
      ...(referenceOwnership.length?{referenceOwnership:{physicalLines:referenceOwnership,readonly:true,basis:'original-physical-source',sourcePages:[...new Set(referenceOwnership.map(sourceId=>sourceById.get(sourceId)!.page))],rendering:'original-source-glyphs'}}:{}),
      ...(figureLabelOwnership.length?{figureLabelOwnership}:{}),...(folios.length?{folioPresentation:{physicalLines:folios,mayOmitFromReflow:folios.length===sourceIds.length,sourceOwned:true}}:{}),
      ...(block.inlineProtections?.length?{nativeNodes:block.inlineProtections.map(node=>({token:node.token,text:node.text,kind:node.kind,physicalLines:node.physicalLines,
        placement:node.placement??(node.physicalLines?.length?'display':'inline'),readonly:true,ownedByParagraph:true}))}:{}),...(tableCells?.length?{tableCells}:{})});
  });
}
export function preparedInspectionMetadata(layout:PdfLayout,allowed?:ReadonlySet<number>){
  const tableSources=new Set(layout.structureTables?.flatMap(table=>table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines)))??[]);
  const related=(ids:number[])=>!allowed||ids.some(id=>allowed.has(id));
  const tableFrames=tableRuleInspection(layout).filter(frame=>related(frame.sourceLines));
  const figures=figureInspectionIndex(layout);
  const captionRelated=(line:number|undefined)=>line!==undefined&&(!allowed||allowed.has(line));
  return {sourceTextPolicy:{characters:'verbatim-original-source',lineWrapHyphenation:'retained-original-characters',structureEditsCannotRewriteWords:true},
    tables:layout.structureTables?.filter(table=>related(table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines)))||captionRelated(table.captionPhysicalLine)),tableFrames,
    sourceRulePanels:tableFrames.filter(frame=>frame.evidence==='rules-and-grid'&&!frame.sourceLines.some(id=>tableSources.has(id))).map(frame=>({...frame,semanticTable:false})),
    figureIndex:{references:figures.references.filter(ref=>!allowed||captionRelated(ref.captionPhysicalLine)||layout.blocks.some(block=>(block.fragments??[block.line]).some(id=>allowed.has(id))&&block.page===ref.page)),
      groups:figures.groups.filter(group=>related(group.physicalLines)||captionRelated(group.captionPhysicalLine))}};
}

function relations(layout:PdfLayout){
  const figures=figureInspectionIndex(layout),captionIds=(line:number|undefined)=>line===undefined?[]:[line];
  return [...(layout.structureTables??[]).map(table=>({key:'table:'+digest(table),ids:[...table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines)),...captionIds(table.captionPhysicalLine)]})),
    ...tableRuleInspection(layout).map(frame=>({key:'frame:'+digest(frame),ids:[...frame.sourceLines,...captionIds(frame.captionPhysicalLine)]})),
    ...figures.groups.map(group=>({key:'figure:'+digest(group),ids:[...group.physicalLines,...captionIds(group.captionPhysicalLine)]})),
    ...figures.references.map(ref=>({key:'image:'+digest(ref),ids:captionIds(ref.captionPhysicalLine),page:ref.page}))];
}
const orderedEdge=(before:string,after:string)=>digest(['reading-edge',before,after]);
export function pdfAuditPackets(base:PdfLayout,layout:PdfLayout,contract:{promptVersion:number;systemPrompt:string;geometryFindings?:Array<{physicalLines:number[];message:string}>}):PdfAuditPacket[]{
  const scopes=pdfAuditScopes(base,layout),raw=base.physicalBlocks??base.blocks,rawById=new Map(raw.map(row=>[row.line,row]));
  const keys=layout.blocks.map(auditOwnerKey),allRelations=relations(layout),globalKey='global-order:'+digest(keys);
  const sectionKey='section-order:'+digest(layout.blocks.filter(block=>block.structureKind==='heading').map(block=>[auditOwnerKey(block),block.text]));
  const common={version:1 as const,promptVersion:contract.promptVersion,systemHash:digest(contract.systemPrompt),originalHash:base.originalHash,mechanicalHash:base.protectionHash};
  const packets:PdfAuditPacket[]=scopes.map(scope=>{
    const coreIds=new Set(scope.physicalLines),logical=[...new Set([...scope.logicalLines,...scope.contextLogicalLines])].sort((a,b)=>a-b);
    const physical=[...new Set(logical.flatMap(line=>layout.blocks[line-1].fragments??[line]))].sort((a,b)=>a-b),allowed=new Set(physical);
    const ownedRelations=allRelations.filter(relation=>relation.ids.some(id=>coreIds.has(id))||!relation.ids.length&&'page' in relation&&scope.physicalLines.some(id=>rawById.get(id)?.page===relation.page));
    const edgeKeys=scope.logicalLines.flatMap(line=>[...(line===1?[orderedEdge('START',keys[0])]:[]),orderedEdge(keys[line-1],keys[line]??'END')]);
    const records:Array<Record<string,unknown>>=[...sourceInspectionRows(base,physical,true).map(row=>({record:'source',...row})),...preparedInspectionRows(layout,logical).map(({logicalLine:_routing,...row})=>({record:'prepared',ownerAnchor:row.physicalLines[0],...row}))];
    return {...common,id:scope.id,kind:'local' as const,corePhysicalLines:scope.physicalLines,coreOwnerKeys:scope.logicalLines.map(line=>keys[line-1]),edgeKeys,
      relationKeys:ownedRelations.map(relation=>relation.key),requiredPhysicalLines:physical,requiredLogicalLines:logical,requiredOwnerKeys:logical.map(line=>keys[line-1]),records,
      metadata:inspectionGeometry({...preparedInspectionMetadata(layout,allowed),coreOwnerAnchors:scope.logicalLines.map(line=>layout.blocks[line-1].fragments![0]),
        contextOwnerAnchors:scope.contextLogicalLines.map(line=>layout.blocks[line-1].fragments![0]),
        geometryFindings:(contract.geometryFindings??[]).filter(finding=>finding.physicalLines.some(id=>allowed.has(id))||scopes.length===1&&!finding.physicalLines.length),
        outgoingEdges:scope.logicalLines.map(line=>({beforePhysicalLine:layout.blocks[line-1].fragments![0],afterPhysicalLine:layout.blocks[line]?.fragments?.[0]??'END'})),
        ...(scope.logicalLines.includes(1)?{startOwnerPhysicalLine:layout.blocks[0].fragments![0]}:{}),
        pages:base.pages.filter(page=>physical.some(id=>rawById.get(id)?.page===page.page)).map(page=>({page:page.page,width:page.width,height:page.height}))})};
  });
  const finish=()=>{
    sameSet(packets.flatMap(packet=>packet.corePhysicalLines),raw.map(row=>row.line),'complete core source partition');
    sameSet(packets.flatMap(packet=>packet.coreOwnerKeys),keys,'complete core owner partition');
    sameSet(packets.flatMap(packet=>packet.edgeKeys),[orderedEdge('START',keys[0]),...keys.map((key,index)=>orderedEdge(key,keys[index+1]??'END'))],'complete boundary edge partition');
    const expectedRelations=[...new Set([...allRelations.map(relation=>relation.key),globalKey,sectionKey])];
    const assigned=new Set(packets.flatMap(packet=>packet.relationKeys));
    // A source image can occupy a page with no text owner. Its relation is an
    // explicit global responsibility, never silently credited to source counts.
    const missing=expectedRelations.filter(key=>!assigned.has(key));
    if(missing.length){
      const last=packets.at(-1)!;last.relationKeys.push(...missing);
      last.records.push({record:'relationship',relationKeys:missing,evidence:inspectionGeometry(preparedInspectionMetadata(layout)),
        pages:base.pages.map(page=>({page:page.page,width:page.width,height:page.height,previewHash:page.previewHash})),
        responsibility:'Inspect these source figures/relationships, including pages without text or a caption. Request original page images when uncertain.'});
    }
    sameSet([...new Set(packets.flatMap(packet=>packet.relationKeys))],expectedRelations,'complete relation responsibility');
    return packets;
  };
  if(packets.length===1){packets[0].relationKeys.push(globalKey,sectionKey);packets[0].metadata.globalResponsibility='Complete document section and reading order, including all boundaries.';return finish();}
  // Global order is a separate fresh judgment over the complete source-addressed
  // outline. Local packets independently check complete prose and every edge.
  const orderRecords=layout.blocks.map(block=>{
    const sourceIds=block.fragments??[block.line],runs:Array<{page:number;fromPhysicalLine:number;toPhysicalLine:number;startX:number;startY:number;endX:number;endY:number}>=[];
    for(const id of sourceIds){const source=rawById.get(id)!,last=runs.at(-1);
      if(last&&last.page===source.page&&last.toPhysicalLine+1===id){last.toPhysicalLine=id;last.endX=source.x;last.endY=source.y;}
      else runs.push({page:source.page,fromPhysicalLine:id,toPhysicalLine:id,startX:source.x,startY:source.y,endX:source.x,endY:source.y});
    }
    const complete=block.structureKind==='heading'||block.structureKind==='caption',excerpt=!complete&&!block.protection&&block.text.length>200;
    return {record:'order',ownerAnchor:sourceIds[0],physicalLines:sourceIds,kind:block.structureKind,sourceRuns:runs,excerptOnly:excerpt,
      text:complete?block.text:!block.protection?(excerpt?block.text.slice(0,120)+' … '+block.text.slice(-80):block.text):'[Host-preserved native content]'};
  });
  packets.push({...common,id:'global-order',kind:'order',corePhysicalLines:[],coreOwnerKeys:[],edgeKeys:[],relationKeys:[globalKey,sectionKey],
    requiredPhysicalLines:[],requiredLogicalLines:[],requiredOwnerKeys:[],records:inspectionGeometry(orderRecords),
    metadata:inspectionGeometry({responsibility:'Global section and reading order; local full-text judgments are separately required.',
      geometryFindings:(contract.geometryFindings??[]).filter(finding=>!finding.physicalLines.length),...preparedInspectionMetadata(layout)})});
  return finish();
}
export const pdfAuditPacketHash=({requiredLogicalLines:_routing,...semantic}:PdfAuditPacket)=>digest(semantic);
/** Optional investigation can read outside a packet. Such prepared reads pin
 * the complete current prepared view, rather than silently omitting dependencies. */
export const pdfAuditGlobalPreparedHash=(layout:PdfLayout)=>digest({rows:preparedInspectionRows(layout,layout.blocks.map(block=>block.line)),metadata:preparedInspectionMetadata(layout)});
function sameSet(actual:unknown,expected:string[]|number[],label:string){
  if(!Array.isArray(actual)||actual.length!==expected.length||new Set(actual).size!==actual.length||actual.some(value=>!expected.includes(value as never)))throw new Error('PDF scoped audit evidence differs from current '+label+'.');
}
export function verifyPdfAuditEvidence(packets:PdfAuditPacket[],evidence:PdfAuditScopeEvidence[],globalPrepared?:{hash:string;ownerKeys:string[]}){
  if(!Array.isArray(evidence)||evidence.length!==packets.length)throw new Error('PDF scoped audit evidence does not cover every current packet.');
  const seen=new Set<string>();
  for(const packet of packets){
    const item=evidence.find(value=>value.scopeId===packet.id);if(!item||seen.has(item.scopeId))throw new Error('PDF scoped audit is missing or repeats a current packet.');seen.add(item.scopeId);
    if(item.version!==1||item.packetHash!==pdfAuditPacketHash(packet)||![item.sessionId,item.providerId,item.modelId].every(value=>typeof value==='string'&&value.length))throw new Error('PDF scoped audit packet or native identity changed.');
    sameSet(item.corePhysicalLines,packet.corePhysicalLines,'core source IDs');sameSet(item.coreOwnerKeys,packet.coreOwnerKeys,'core owners');
    sameSet(item.edgeKeys,packet.edgeKeys,'reading edges');sameSet(item.relationKeys,packet.relationKeys,'relationships');
    sameSet(item.inspectedPhysicalLines,packet.requiredPhysicalLines,'inspected source IDs');sameSet(item.inspectedOwnerKeys,packet.requiredOwnerKeys,'inspected owners');
    sameSet(item.inspectedRecordIndices,packet.records.map((_,index)=>index),'inspected packet records');
    const extra=item.extraPreparedOwnerKeys??[];
    if(!Array.isArray(extra)||new Set(extra).size!==extra.length||extra.some(key=>!globalPrepared?.ownerKeys.includes(key)||packet.requiredOwnerKeys.includes(key)))throw new Error('PDF scoped audit has stale additional investigation owners.');
    if(extra.length?item.globalPreparedHash!==globalPrepared?.hash:item.globalPreparedHash!==undefined)throw new Error('PDF scoped audit additional investigation changed.');
    if(!item.audit||item.audit.version!==1||auditChecks.some(key=>item.audit.checks?.[key]!==true)||!Array.isArray(item.audit.issues)||item.audit.issues.length||Object.hasOwn(item.audit,'correction')||Object.hasOwn(item.audit,'unsupported'))throw new Error('PDF scoped audit has an unresolved semantic finding.');
  }
}
