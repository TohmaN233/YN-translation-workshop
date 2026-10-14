import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PdfLayout} from './pdfTypes.ts';

export interface PdfAuditScope {
  id:string;
  physicalLines:number[];
  logicalLines:number[];
  contextPhysicalLines:number[];
  contextLogicalLines:number[];
}

/** Partition complete current source owners for independent audit. The target
 * sets fixed physical-ID windows, never an owner/dependency acceptance limit. */
export function pdfAuditScopes(base:PdfLayout,applied:PdfLayout,options?:{targetPhysicalRows?:number}):PdfAuditScope[] {
  const fail:(message:string)=>never=message=>{throw new Error(`PDF audit scopes: ${message}`);};
  const target=options?.targetPhysicalRows??200;
  if(!Number.isSafeInteger(target)||target<1)fail('targetPhysicalRows must be a positive integer.');
  const raw=base.physicalBlocks??base.blocks;
  if(!Array.isArray(raw)||!raw.length)fail('the base has no physical source rows.');
  for(const [index,row] of raw.entries())if(row.line!==index+1)fail(`base physical source ID ${row.line} is duplicated, missing, or out of order at ${index+1}.`);
  if(base.originalHash!==applied.originalHash)fail('applied source belongs to a different original PDF.');
  if(applied.physicalBlocks&&!isDeepStrictEqual(raw,applied.physicalBlocks))fail('applied physical source identities/text/native evidence differ from the base.');

  const ownership=(layout:PdfLayout,label:string)=>{
    if(!Array.isArray(layout.blocks)||!layout.blocks.length)fail(`${label} has no logical owners.`);
    const byPhysical=new Map<number,number>();
    const fragments=layout.blocks.map((block,index)=>{
      if(block.line!==index+1)fail(`${label} logical ID ${block.line} is duplicated, missing, or out of order at ${index+1}.`);
      const ids=block.fragments??(layout.physicalBlocks?undefined:[block.line]);
      if(!Array.isArray(ids)||!ids.length)fail(`${label} logical L${block.line} has no physical ownership.`);
      for(const id of ids) {
        if(!Number.isSafeInteger(id)||id<1||id>raw.length)fail(`${label} logical L${block.line} has foreign physical source ID ${id}.`);
        if(byPhysical.has(id))fail(`${label} repeats physical source ID ${id}.`);
        byPhysical.set(id,index);
      }
      return ids;
    });
    if(byPhysical.size!==raw.length)fail(`${label} omits physical source IDs ${raw.filter(row=>!byPhysical.has(row.line)).map(row=>row.line).join(',')}.`);
    return {byPhysical,fragments};
  };
  const baseOwners=ownership(base,'base'),current=ownership(applied,'applied');
  const parents=applied.blocks.map((_,index)=>index);
  const find=(index:number):number=>{while(parents[index]!==index){parents[index]=parents[parents[index]];index=parents[index];}return index;};
  const dependency=(ids:number[],label:string)=>{
    const owners=ids.map(id=>{
      const owner=current.byPhysical.get(id);
      if(owner===undefined)fail(`${label} references foreign physical source ID ${id}.`);
      return owner!;
    });
    if(!owners.length)return;
    const first=find(owners[0]);for(const owner of owners)parents[find(owner)]=first;
  };
  const uniqueDependency=(ids:number[],label:string)=>{
    if(new Set(ids).size!==ids.length)fail(`${label} repeats a physical source ID.`);
    dependency(ids,label);
  };
  for(const [name,layout] of [['base',base],['applied',applied]] as const) {
    for(const table of layout.structureTables??[])uniqueDependency([
      ...table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines)),
      ...(table.captionPhysicalLine===undefined?[]:[table.captionPhysicalLine])
    ],`${name} table ${table.id}`);
  }
  for(const page of base.pages)for(const table of page.tableRules??[])uniqueDependency([
    ...table.sourceLines,...(table.captionLine===undefined?[]:[table.captionLine])
  ],`source frame ${table.id}`);

  for(const [name,layout,owners] of [['base',base,baseOwners],['applied',applied,current]] as const) {
    const references=new Map(layout.references.map(reference=>[reference.id,reference]));
    const captionIds=(line:number|undefined,label:string):number[]=>{
      if(line===undefined)return [];
      if(!Number.isSafeInteger(line)||!owners.fragments[line-1])fail(`${label} has unknown logical caption L${line}.`);
      return owners.fragments[line-1];
    };
    for(const group of layout.figureGroups??[]) {
      const ids=[...group.physicalLines,...captionIds(group.captionLine,`${name} figure ${group.id}`)];
      for(const id of group.referenceIds) {
        const reference=references.get(id);if(!reference)fail(`${name} figure ${group.id} has unknown image reference ${id}.`);
        ids.push(...captionIds(reference!.captionLine,`${name} image ${id}`));
      }
      dependency(ids,`${name} figure ${group.id}`);
    }
  }

  const members=new Map<number,number[]>();
  for(let index=0;index<parents.length;index++){const root=find(index),group=members.get(root)??[];group.push(index);members.set(root,group);}
  // Keep the actual dependency component intact, even when its members were
  // moved apart. Absorbing the interval would drag unrelated owners into a
  // giant packet. Neighbor context and explicit order audit retain the edges.
  // Anchor each complete component to its first immutable source ID. A merge
  // or move changes only the components involved, rather than shifting every
  // later greedy boundary and invalidating unrelated accepted audit packets.
  const buckets=new Map<number,number[]>();
  for(const unit of members.values()) {
    const first=unit.reduce((minimum,index)=>current.fragments[index].reduce((value,id)=>Math.min(value,id),minimum),Infinity);
    const bucket=Math.floor((first-1)/target),core=buckets.get(bucket)??[];
    core.push(...unit);buckets.set(bucket,core);
  }
  const packets=[...buckets].sort(([a],[b])=>a-b).map(([,core])=>core);
  return packets.map(core=>{
    core.sort((a,b)=>a-b);
    const coreOwners=new Set(core),physicalLines=core.flatMap(index=>current.fragments[index]).sort((a,b)=>a-b),context=new Set<number>();
    const addContext=(index:number|undefined)=>{if(index!==undefined&&!coreOwners.has(index))for(const member of members.get(find(index))!)if(!coreOwners.has(member))context.add(member);};
    for(const index of core){if(index>0)addContext(index-1);if(index+1<parents.length)addContext(index+1);}
    for(let start=0;start<physicalLines.length;){let end=start;while(end+1<physicalLines.length&&physicalLines[end+1]===physicalLines[end]+1)end++;
      addContext(current.byPhysical.get(physicalLines[start]-1));addContext(current.byPhysical.get(physicalLines[end]+1));start=end+1;}
    const contextOwners=[...context].sort((a,b)=>a-b);
    return {id:`pdf-scope-${createHash('sha256').update(JSON.stringify(physicalLines)).digest('hex').slice(0,16)}`,
      physicalLines,logicalLines:core.map(index=>applied.blocks[index].line),
      contextPhysicalLines:contextOwners.flatMap(index=>current.fragments[index]).sort((a,b)=>a-b),
      contextLogicalLines:contextOwners.map(index=>applied.blocks[index].line)};
  });
}
