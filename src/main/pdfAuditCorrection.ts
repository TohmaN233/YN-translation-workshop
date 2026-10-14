import type {PdfLayout} from './pdfTypes.ts';
import {revisePdfStructureDraft,type PdfStructureDraft,type PdfStructureDraftPatch} from './pdfStructureDraft.ts';
import type {PdfStructurePlan} from './pdfStructurePlan.ts';

export type PdfAuditCorrectionPatch=Omit<PdfStructureDraftPatch,'expectedRevision'>;
export type PdfAuditCorrection=PdfAuditCorrectionPatch|{steps:PdfAuditCorrectionPatch[]};
export const pdfStructureShape=(plan:PdfStructurePlan)=>JSON.stringify({
  paragraphs:plan.paragraphs.map(({physicalLines,kind})=>({physicalLines,kind})),
  tables:plan.tables.map(({page,columnCount,rows,captionPhysicalLine})=>({page,columnCount,rows,captionPhysicalLine}))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
});
/** Failed attempts compare selected owners and operations, not their reasons,
 * table labels or alternative anchor spellings within one complete owner. */
export function normalizedPdfAuditAttempt(draft:PdfStructureDraft,value:unknown,base?:PdfLayout):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const audit=value as Record<string,unknown>,patch=audit.correction as Record<string,unknown>|undefined;
  const array=(item:unknown,format:(item:Record<string,unknown>)=>unknown)=>Array.isArray(item)?item.map(entry=>entry&&typeof entry==='object'&&!Array.isArray(entry)?format(entry):entry):item;
  const table=(entry:Record<string,unknown>)=>({page:entry.page,columnCount:entry.columnCount,rows:entry.rows,captionPhysicalLine:entry.captionPhysicalLine});
  const format=(patch:Record<string,unknown>,snapshot:PdfStructureDraft=draft,resolve=true):unknown=>{
    const owner=(id:unknown)=>resolve?snapshot.plan.paragraphs.find(paragraph=>paragraph.physicalLines.includes(id as number))?.physicalLines??{foreignAnchor:id}:{unresolvedSelector:id};
    let stage=snapshot,canResolve=resolve;
    const steps=array(patch.steps,step=>{
      const normalized=format(step,stage,canResolve);
      if(base&&canResolve){try{stage=revisePdfStructureDraft(base,stage,{...step,expectedRevision:stage.revision});}catch{canResolve=false;}}
      else canResolve=false;
      return normalized;
    });
    return {
      fields:Object.keys(patch).sort(),paragraphs:array(patch.paragraphs,entry=>({physicalLines:entry.physicalLines,kind:entry.kind})),
      merges:array(patch.merges,entry=>({owners:Array.isArray(entry.anchors)?[...new Map(entry.anchors.map(id=>{const selected=owner(id);return [JSON.stringify(selected),selected];})).values()]:entry.anchors,kind:entry.kind})),
      splits:array(patch.splits,entry=>({owner:owner(entry.beforePhysicalLine),beforePhysicalLine:entry.beforePhysicalLine,kind:entry.kind})),
      moves:array(patch.moves,entry=>({owner:owner(entry.physicalLine),after:entry.afterPhysicalLine===undefined?'START':owner(entry.afterPhysicalLine)})),
      tablePages:patch.tablePages,tables:array(patch.tables,table),steps
    };
  };
  return {version:audit.version,checks:audit.checks,issues:array(audit.issues,entry=>({physicalLines:entry.physicalLines})),
    unsupported:audit.unsupported===undefined?undefined:true,
    correction:patch&&typeof patch==='object'&&!Array.isArray(patch)?format(patch):patch};
}

/** A negative judgment must identify an executable, source-only correction.
 * This proves applicability, not semantic correctness: the result is audited
 * again in a fresh native context before it can authorize an HTML document. */
export function preparePdfAuditCorrection(base:PdfLayout,draft:PdfStructureDraft,
  correction:PdfAuditCorrection,issues:Array<{physicalLines:number[];message:string}>,
  inspected:{source:ReadonlySet<number>;prepared:ReadonlySet<number>;order:ReadonlySet<number>}) {
  if(!correction||typeof correction!=='object'||Array.isArray(correction))throw Error('PDF audit correction must be a source-only patch.');
  const steps='steps' in correction?correction.steps:[correction];
  if('steps' in correction&&(Object.keys(correction).some(key=>key!=='steps')||!Array.isArray(steps)||!steps.length))throw Error('PDF audit correction steps must be a nonempty explicit sequence without other fields.');
  let next=draft;
  for(const step of steps){
    if(!step||typeof step!=='object'||Array.isArray(step)||Object.keys(step).some(key=>!['paragraphs','merges','splits','tables','tablePages','moves'].includes(key)))throw Error('PDF audit correction has forbidden fields; revision and source text belong to the Host.');
    next=revisePdfStructureDraft(base,next,{...step,expectedRevision:next.revision});
  }
  if(pdfStructureShape(next.plan)===pdfStructureShape(draft.plan))throw Error('PDF audit correction makes no structural change. Accepted alternative formatting and reason-only changes are not unresolved defects.');
  const before=new Map(draft.plan.paragraphs.flatMap((paragraph,index)=>paragraph.physicalLines.map(id=>[id,{paragraph,index}] as const)));
  const after=new Map(next.plan.paragraphs.flatMap((paragraph,index)=>paragraph.physicalLines.map(id=>[id,{paragraph,index}] as const)));
  const signature=(plan:PdfStructurePlan,entry:{paragraph:PdfStructurePlan['paragraphs'][number];index:number})=>JSON.stringify({
    ids:entry.paragraph.physicalLines,kind:entry.paragraph.kind,
    previous:plan.paragraphs[entry.index-1]?.physicalLines[0]??'START',next:plan.paragraphs[entry.index+1]?.physicalLines[0]??'END',
    tables:plan.tables.flatMap(table=>[
      ...(table.captionPhysicalLine!==undefined&&entry.paragraph.physicalLines.includes(table.captionPhysicalLine)?[{page:table.page,columnCount:table.columnCount,rows:table.rows,captionPhysicalLine:table.captionPhysicalLine}]:[]),
      ...table.rows.flatMap((row,r)=>row.filter(cell=>cell.physicalLines.some(id=>entry.paragraph.physicalLines.includes(id)))
        .map(cell=>({page:table.page,columnCount:table.columnCount,row:r,cell,captionPhysicalLine:table.captionPhysicalLine})))])
  });
  const changed=[...before.keys()].filter(id=>signature(draft.plan,before.get(id)!)!==signature(next.plan,after.get(id)!));
  const unchanged=issues.filter(issue=>!issue.physicalLines.some(id=>changed.includes(id)));
  if(unchanged.length)throw Error('PDF audit correction does not change an owner, boundary or table relationship named by every issue. Unchanged issue source IDs: '+JSON.stringify(unchanged.map(issue=>issue.physicalLines))+'.');
  const requireOwner=(id:number,moveOnly=false)=>{
    const owner=before.get(id);if(!owner)throw Error('PDF audit correction claims an unknown source owner.');
    if(moveOnly&&owner.paragraph.physicalLines.every(line=>inspected.order.has(line)))return;
    if(!inspected.prepared.has(owner.index+1)||owner.paragraph.physicalLines.some(line=>!inspected.source.has(line)))
      throw Error('PDF audit correction must inspect the complete original source and current prepared owner before changing it; missing owner anchored at '+owner.paragraph.physicalLines[0]+'.');
  };
  for(const step of steps){
  for(const paragraph of step.paragraphs??[])for(const id of paragraph.physicalLines)requireOwner(id);
  for(const merge of step.merges??[])for(const id of merge.anchors)requireOwner(id);
  for(const split of step.splits??[])requireOwner(split.beforePhysicalLine);
  for(const move of step.moves??[]){requireOwner(move.physicalLine,true);if(move.afterPhysicalLine!==undefined)requireOwner(move.afterPhysicalLine,true);}
  if(step.tables!==undefined){
    const pages=new Set(step.tablePages??step.tables.map(table=>table.page));
    for(const table of [...draft.plan.tables,...next.plan.tables].filter(table=>pages.has(table.page))){
      for(const id of table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines)))requireOwner(id);
      if(table.captionPhysicalLine!==undefined)requireOwner(table.captionPhysicalLine);
    }
  }
  }
  return {draft:next,changedPhysicalLines:changed};
}
