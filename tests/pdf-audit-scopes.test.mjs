import assert from 'node:assert/strict';
import {pdfAuditScopes} from '../src/main/pdfAuditScopes.ts';

function fixture(count,groups=Array.from({length:count},(_,index)=>[index+1])) {
  const raw=Array.from({length:count},(_,index)=>({line:index+1,page:index<3?1:2,text:`Source ${index+1}`,x:40,y:40+index*12,width:100,height:12,fontSize:10}));
  const layout=owners=>({originalHash:'same-pinned-original',physicalBlocks:structuredClone(raw),blocks:owners.map((ids,index)=>({...raw[ids[0]-1],line:index+1,fragments:[...ids],text:ids.map(id=>raw[id-1].text).join(' ')})),pages:[{page:1},{page:2}],references:[],figureGroups:[]});
  return {base:layout(raw.map(row=>[row.line])),applied:layout(groups)};
}
function coverage(base,applied,scopes) {
  assert.deepEqual(scopes.flatMap(scope=>scope.physicalLines).sort((a,b)=>a-b),base.physicalBlocks.map(row=>row.line));
  assert.deepEqual(scopes.flatMap(scope=>scope.logicalLines).sort((a,b)=>a-b),applied.blocks.map(row=>row.line),'core scopes partition all current owners exactly once');
  for(const scope of scopes) {
    assert.deepEqual(scope.logicalLines,[...scope.logicalLines].sort((a,b)=>a-b),'each core retains the current output order');
    assert.deepEqual(scope.physicalLines,scope.logicalLines.flatMap(line=>applied.blocks[line-1].fragments).sort((a,b)=>a-b));
    assert.deepEqual(scope.contextPhysicalLines,scope.contextLogicalLines.flatMap(line=>applied.blocks[line-1].fragments).sort((a,b)=>a-b),'context expands complete owners');
    assert.ok(scope.contextLogicalLines.every(line=>!scope.logicalLines.includes(line)));
    assert.ok(scope.contextPhysicalLines.every(line=>!scope.physicalLines.includes(line)));
  }
}

{
  const {base,applied}=fixture(8,[[1,2,3,4],[5],[6],[7,8]]),before=JSON.stringify({base,applied});
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:3});coverage(base,applied,scopes);
  assert.deepEqual(scopes[0].physicalLines,[1,2,3,4],'a cross-page owner exceeds the soft target intact');
  assert.equal(JSON.stringify({base,applied}),before,'planning never changes either source layout');
}
{
  const {base,applied}=fixture(9,[[1,2],[3,4],[5],[6],[7],[8],[9]]);
  applied.structureTables=[{id:'spanning-table',page:1,columnCount:3,captionPhysicalLine:1,rows:[
    [{physicalLines:[3,4],column:0,columnSpan:3}],
    [{physicalLines:[5],column:0,columnSpan:1},{physicalLines:[6],column:2,columnSpan:1}]
  ]}];
  base.pages[0].tableRules=[{id:'source-table',sourceLines:[3,4,5,6],captionLine:1}];
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:2});coverage(base,applied,scopes);
  assert.deepEqual(scopes[0].physicalLines,[1,2,3,4,5,6],'all table cells, multiline/spanning headers and complete caption share a core');
}
{
  const {base,applied}=fixture(8,[[1],[2],[3],[4],[5,6],[7],[8]]);
  for(const layout of [base,applied]) {
    layout.references=[{id:'p1-image1',captionLine:5},{id:'p1-image2',captionLine:5}];
    layout.figureGroups=[{id:'panel-grid',referenceIds:['p1-image1','p1-image2'],physicalLines:[3,4],captionLine:5}];
  }
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:1});coverage(base,applied,scopes);
  assert.deepEqual(scopes.find(scope=>scope.physicalLines.includes(3)).physicalLines,[3,4,5,6],'grouped figure labels and full caption are inseparable');
  assert.deepEqual(scopes.find(scope=>scope.physicalLines[0]===2).contextPhysicalLines,[1,3,4,5,6],'neighbor context recursively closes the figure dependency');
}
{
  const {base,applied}=fixture(8,[[5,6],[1],[2],[3],[4],[7],[8]]);
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:2});coverage(base,applied,scopes);
  const movedCore=scopes.find(scope=>scope.physicalLines.includes(5));
  assert.deepEqual(movedCore.physicalLines,[5,6]);
  assert.deepEqual(movedCore.contextPhysicalLines,[1,4,7],'moved content sees current reading-order and original source neighbors');
  const split=fixture(6,[[2,5],[1],[3,4],[6]]),result=pdfAuditScopes(split.base,split.applied,{targetPhysicalRows:1});coverage(split.base,split.applied,result);
  assert.deepEqual(result.find(scope=>scope.physicalLines.includes(2)).contextPhysicalLines,[1,3,4,6],'each disjoint physical run contributes complete neighboring owners');
}
{
  const {base,applied}=fixture(8,[[3],[7],[1],[2],[4],[5],[6],[8]]);
  applied.references=[{id:'p1-image1',captionLine:2},{id:'p1-image2',captionLine:2}];
  applied.figureGroups=[{id:'moved-caption',referenceIds:['p1-image1','p1-image2'],physicalLines:[1,2],captionLine:2}];
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:1});coverage(base,applied,scopes);
  assert.deepEqual(scopes.find(scope=>scope.physicalLines.includes(1)).physicalLines,[1,2,7],'figure caption logical IDs resolve through the current owner, not the raw number');
  assert.deepEqual(scopes.find(scope=>scope.physicalLines.includes(3)).physicalLines,[3],'caption mapping must not accidentally absorb raw L3');
  const chained=fixture(9);
  chained.applied.references=[{id:'p1-image1',captionLine:5},{id:'p1-image2',captionLine:5}];
  chained.applied.figureGroups=[{id:'chain',referenceIds:['p1-image1','p1-image2'],physicalLines:[3,4],captionLine:5}];
  chained.applied.structureTables=[{id:'related-table',captionPhysicalLine:7,rows:[[{physicalLines:[5,6],column:0,columnSpan:1}]],columnCount:1,page:1}];
  const closed=pdfAuditScopes(chained.base,chained.applied,{targetPhysicalRows:1});coverage(chained.base,chained.applied,closed);
  assert.deepEqual(closed.find(scope=>scope.physicalLines[0]===2).contextPhysicalLines,[1,3,4,5,6,7],'context follows transitive figure/table dependencies without becoming core');
}
{
  const {base,applied}=fixture(6);
  applied.structureTables=[{id:'moved',page:1,columnCount:1,captionPhysicalLine:1,rows:[[{physicalLines:[5],column:0,columnSpan:1}]]}];
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:1});coverage(base,applied,scopes);
  assert.deepEqual(scopes[0].logicalLines,[1,5],'a noncontiguous table component does not absorb unrelated owners');
  assert.deepEqual(scopes[0].contextLogicalLines,[2,4,6],'logical/source neighbors remain context, not core');
}
{
  const {base,applied}=fixture(1000);
  applied.references=[{id:'p1-image1',captionLine:800},{id:'p1-image2',captionLine:800}];
  applied.figureGroups=[{id:'distant-labels',referenceIds:['p1-image1','p1-image2'],physicalLines:[2,3],captionLine:800}];
  const scopes=pdfAuditScopes(base,applied);coverage(base,applied,scopes);
  const figure=scopes.find(scope=>scope.physicalLines.includes(2));
  assert.ok([2,3,800].every(id=>figure.physicalLines.includes(id)),'labels and their distant caption share one complete core');
  assert.deepEqual(scopes.map(scope=>scope.physicalLines.length),[201,200,200,199,200],'a spanning dependency belongs to its first source window without shifting later windows');
  assert.ok(!figure.physicalLines.includes(500),'intervening unrelated owners remain in other cores');
}
{
  const count=1000,ordinary=fixture(count),before=pdfAuditScopes(ordinary.base,ordinary.applied);
  const prefix=fixture(count,[Array.from({length:201},(_,index)=>index+1),...Array.from({length:count-201},(_,index)=>[index+202])]);
  const after=pdfAuditScopes(prefix.base,prefix.applied);coverage(prefix.base,prefix.applied,after);
  assert.deepEqual(after.map(scope=>scope.physicalLines.length),[201,199,200,200,200],'a prefix owner crossing a window remains intact in one bucket');
  assert.deepEqual(after.slice(2).map(scope=>({id:scope.id,core:scope.physicalLines})),before.slice(2).map(scope=>({id:scope.id,core:scope.physicalLines})),'prefix merges cannot cascade into unrelated later core partitions');
  const moved=fixture(count,[[500],...Array.from({length:count},(_,index)=>index+1).filter(id=>id!==500).map(id=>[id])]);
  const movedScopes=pdfAuditScopes(moved.base,moved.applied);coverage(moved.base,moved.applied,movedScopes);
  assert.deepEqual(movedScopes.map(scope=>({id:scope.id,core:scope.physicalLines})),before.map(scope=>({id:scope.id,core:scope.physicalLines})),'moving an entire owner preserves every source-anchored core');
  assert.notDeepEqual(movedScopes[0].contextPhysicalLines,before[0].contextPhysicalLines,'a moved owner changes actual neighbor context even when its core scope ID is stable');
  assert.notDeepEqual(movedScopes[2].logicalLines,before[2].logicalLines,'owners inside each bucket retain their actual current logical positions');
  assert.deepEqual(movedScopes[4].contextPhysicalLines,before[4].contextPhysicalLines,'unaffected distant context remains stable');
}
{
  const {base,applied}=fixture(501,[Array.from({length:501},(_,index)=>index+1)]);
  const scopes=pdfAuditScopes(base,applied,{targetPhysicalRows:1});coverage(base,applied,scopes);assert.equal(scopes.length,1);assert.equal(scopes[0].physicalLines.length,501);
  const ordinary=fixture(250),defaults=pdfAuditScopes(ordinary.base,ordinary.applied);coverage(ordinary.base,ordinary.applied,defaults);assert.deepEqual(defaults.map(scope=>scope.physicalLines.length),[200,50]);
  const small=pdfAuditScopes(ordinary.base,ordinary.applied,{targetPhysicalRows:17});coverage(ordinary.base,ordinary.applied,small);
  const moved=fixture(6,[[1],[3],[2],[4],[5],[6]]),unchanged=fixture(6);
  const first=pdfAuditScopes(unchanged.base,unchanged.applied,{targetPhysicalRows:1})[0],other=pdfAuditScopes(moved.base,moved.applied,{targetPhysicalRows:1})[0];
  assert.equal(first.id,other.id,'scope IDs bind core source IDs, not variable surrounding context');assert.notDeepEqual(first.contextPhysicalLines,other.contextPhysicalLines);
}
for(const [mutate,pattern] of [
  [(base)=>{base.physicalBlocks[1].line=1;},/physical source ID 1/],
  [(base)=>{base.blocks[1].fragments=[1];},/base repeats physical source ID 1/],
  [(base)=>{base.blocks.pop();},/base omits physical source IDs 4/],
  [(_base,applied)=>{applied.blocks[1].fragments=[999];},/foreign physical source ID 999/],
  [(_base,applied)=>{applied.blocks[1].fragments=[1];},/applied repeats physical source ID 1/],
  [(_base,applied)=>{applied.blocks.pop();},/applied omits physical source IDs 4/],
  [(_base,applied)=>{delete applied.blocks[1].fragments;},/logical L2 has no physical ownership/],
  [(_base,applied)=>{applied.physicalBlocks[1].text='rewritten source';},/physical source identities/],
  [(_base,applied)=>{applied.originalHash='foreign-original';},/different original/],
  [(_base,applied)=>{applied.structureTables=[{id:'bad',rows:[[{physicalLines:[999]}]]}];},/table bad.*999/],
  [(_base,applied)=>{applied.structureTables=[{id:'bad',rows:[[{physicalLines:[1,1]}]]}];},/table bad repeats/],
  [(_base,applied)=>{applied.figureGroups=[{id:'bad',physicalLines:[1],referenceIds:[],captionLine:999}];},/unknown logical caption L999/]
]) {const {base,applied}=fixture(4);mutate(base,applied);assert.throws(()=>pdfAuditScopes(base,applied),pattern);}
for(const targetPhysicalRows of [0,-1,1.5,NaN]) {const {base,applied}=fixture(2);assert.throws(()=>pdfAuditScopes(base,applied,{targetPhysicalRows}),/positive integer/);}
console.log('PDF audit scopes: exact core partition, complete cross-page/native owners, table/figure dependency closure, moved context, soft targets and invalid-source rejection PASS.');
