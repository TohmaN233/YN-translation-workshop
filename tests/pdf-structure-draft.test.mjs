import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPdfStructureDraft,revisePdfStructureDraft,expandPdfStructureMerges,expandPdfStructureSplits} from '../src/main/pdfStructureDraft.ts';
import {applyPdfStructurePlan} from '../src/main/pdfStructurePlan.ts';
import {makePdfLogicalDocument} from '../src/main/pdfLogicalDocument.ts';
import {PDF_LAYOUT_VERSION,PDF_EXTRACTOR_REVISION,pdfProtectionHash} from '../src/main/pdfTypes.ts';
const hash=value=>createHash('sha256').update(value).digest('hex');
const p=(physicalLines,kind='paragraph',reason='Source evidence inspected.')=>({physicalLines,kind,reason});
const row=(text,y,extra={})=>({page:1,x:40,y,width:180,height:12,fontSize:10,text,segmentation:'paragraph',...(extra.protection?{paintOperations:[y],nativePathOperations:[]}:{inlineProtections:[]}),...extra});
function fixture(rows,hints,logicalGroups){
 const physicalBlocks=structuredClone(rows).map((block,index)=>({...block,line:index+1,...(block.protection||/^\d+$/.test(block.text)?{sourceInkBox:{x:block.x,y:block.y,width:block.width,height:block.height},sourceInkPath:'/numeric.png',sourceInkHash:hash('numeric')}:{}),...(!block.protection?{proseSegments:[{text:block.text,boxes:[{x:block.x,y:block.y,width:block.width,height:block.height,page:block.page}]}]}:{})}));
 const blocks=(logicalGroups??physicalBlocks.map(block=>[block.line])).map((group,index)=>{
  const source=group.map(id=>physicalBlocks[id-1]),text=source.map(block=>block.text).join(' ');
  return {...structuredClone(source[0]),line:index+1,fragments:[...group],text,
   ...(group.length>1&&source.every(block=>!block.protection)?{proseSegments:[{text,boxes:source.flatMap(block=>block.proseSegments.flatMap(segment=>segment.boxes.map(box=>({...box,page:block.page}))))}]}:{})};
 });
 const base={version:PDF_LAYOUT_VERSION,extractorRevision:PDF_EXTRACTOR_REVISION,originalPath:'/original.pdf',originalHash:hash('original'),sourcePath:'/projection.txt',sourceHash:hash(blocks.map(block=>block.text).join('\n')),protectionHash:'',physicalBlocks,blocks,
  references:[{id:'p1-image1',page:1,x:300,y:100,width:40,height:40}],figureGroups:[],
  pages:Array.from({length:Math.max(...rows.map(block=>block.page))},(_,index)=>({page:index+1,width:600,height:800,backgroundPath:'/native.png',backgroundHash:hash('native'),previewPath:'/page.png',previewHash:hash('page'),graphicOperations:[]})),
  ...(hints?{mechanicalParagraphs:structuredClone(hints)}:{})};
 base.protectionHash=pdfProtectionHash(base);return base;
}
const allIds=draft=>draft.plan.paragraphs.flatMap(paragraph=>paragraph.physicalLines).sort((a,b)=>a-b);
{
 const base=fixture([row('Figure 2: A complete source caption begins',100),row('and continues with its original inline nodes.',114),
  row('A source paragraph with a year at its wrap',150),row('2024 continues the same sentence.',164)],[[1],[2],[3],[4]],[[1,2],[3,4]]);
 const original=JSON.stringify(base),draft=createPdfStructureDraft(base);
 assert.deepEqual(draft.plan.paragraphs.map(({physicalLines,kind})=>({physicalLines,kind})),[p([1,2],'caption'),p([3,4])].map(({physicalLines,kind})=>({physicalLines,kind})));
 assert.equal(applyPdfStructurePlan(base,draft.plan).metrics.coverage,1);
 base.mechanicalParagraphs=[[1,3],[2,4]];
 assert.deepEqual(createPdfStructureDraft(base).plan.paragraphs,draft.plan.paragraphs,'diagnostic visual hints never replace the completed logical owners');
 base.mechanicalParagraphs=JSON.parse(original).mechanicalParagraphs;assert.equal(JSON.stringify(base),original);
 const missing=structuredClone(base);delete missing.blocks[0].fragments;assert.throws(()=>createPdfStructureDraft(missing),/lacks physical source fragments/);
 console.log('Complete caption/wrap owners survive draft classification and diagnostic hints cannot split or regroup them PASS.');
}
{
 const base=fixture([row('We define the value as',100),row('x + y',124,{protection:'math'}),row('and use it in this sentence',150),
  row('1',760,{x:290,width:8}),row('continued on the next page.',70,{page:2})],[[1],[2],[3],[4],[5]]);
 delete base.physicalBlocks; // Exercise the real raw-extraction input seam.
 makePdfLogicalDocument(base);
 base.sourceHash=hash(base.blocks.map(block=>block.text).join('\n'));base.protectionHash=pdfProtectionHash(base);
 assert.deepEqual(base.blocks[0].fragments,[1,2,3,5]);
 const original=JSON.stringify(base),draft=createPdfStructureDraft(base),applied=applyPdfStructurePlan(base,draft.plan);
 assert.deepEqual(draft.plan.paragraphs.map(p=>p.physicalLines),[[1,2,3,5],[4]]);
 assert.equal(draft.plan.paragraphs[0].kind,'paragraph');assert.equal(applied.metrics.protectedUnchanged,true);
 assert.deepEqual(applied.layout.blocks[0].inlineProtections.find(node=>node.physicalLines).physicalLines,[2]);
 assert.deepEqual(allIds(draft),[1,2,3,4,5]);assert.equal(JSON.stringify(base),original);
 console.log('Real makePdfLogicalDocument display/cross-page owner reaches draft intact with immutable math marker and separate folio PASS.');
}
{
 const base=fixture([row('Use {{code:p1:1}} in this source',100),row('paragraph without rewriting it.',114)],[[1,2]]);
 const node={x:65,y:100,width:30,height:12,inkBox:{x:65,y:100,width:30,height:12},kind:'code',token:'{{code:p1:1}}',text:'x++',paintOperations:[45]};
 base.blocks[0].inlineProtections=[node];base.blocks[0].proseSegments=[{text:'Use ',boxes:[{x:40,y:100,width:25,height:12}]},{text:' in this source',boxes:[{x:95,y:100,width:85,height:12}]}];
 delete base.physicalBlocks;makePdfLogicalDocument(base);base.sourceHash=hash(base.blocks.map(block=>block.text).join('\n'));base.protectionHash=pdfProtectionHash(base);
 const before=JSON.stringify(base),draft=createPdfStructureDraft(base),applied=applyPdfStructurePlan(base,draft.plan);
 assert.deepEqual(draft.plan.paragraphs.map(p=>p.physicalLines),[[1,2]]);
 assert.deepEqual(applied.layout.blocks[0].inlineProtections,base.blocks[0].inlineProtections);assert.equal(applied.layout.blocks[0].text,base.blocks[0].text);
 assert.equal(JSON.stringify(base),before);assert.equal(applied.metrics.nativeCoverage,1);
 console.log('Inline code remains immutable inside a complete writable source paragraph PASS.');
}
{
 const base=fixture([row('Body before.',60),row('References',100),row('[1] Source citation',114),row('continues here.',128),
  row('x + y',142,{protection:'math'}),row('native code',156,{protection:'code'}),row('Appendix',180),row('Body after.',194)],[],[[1,2,3,4,5,6,7,8]]);
 const draft=createPdfStructureDraft(base);
 assert.deepEqual(draft.plan.paragraphs.map(({physicalLines,kind})=>({physicalLines,kind})),[
  {physicalLines:[1],kind:'paragraph'},{physicalLines:[2],kind:'preserved'},{physicalLines:[3,4],kind:'preserved'},
  {physicalLines:[5],kind:'preserved'},{physicalLines:[6],kind:'preserved'},{physicalLines:[7,8],kind:'paragraph'}]);
 assert.deepEqual(allIds(draft),[1,2,3,4,5,6,7,8],'readonly identity and native protection compatibility remain hard boundaries even for an incompatible candidate owner');
 const mixed=fixture([row('A source lead-in',60),row('native code',90,{protection:'code'}),row('and the source continuation.',120)],[],[[1,2,3]]);
 assert.deepEqual(createPdfStructureDraft(mixed).plan.paragraphs.map(p=>[p.physicalLines,p.kind]),[[[1],'paragraph'],[[2],'preserved'],[[3],'paragraph']],'standalone native code cannot become writable prose; existing inline code stays in its source prose owner');
 console.log('Reference heading, source reference identity, native math/code types and writable content remain separately renderable PASS.');
}
{
 const base=fixture([row('1 Introduction',40),row('A first visual line',100),row('continues here.',114),row('x + y',140,{protection:'math'}),row('A second paragraph.',180),row('Figure 1: Caption.',210),row('1',760),row('References',300),row('[1] Original citation.',314),row('Appendix',350),row('Appendix prose.',370)],[[1,2,3,4,5,6,7,8,9,10,11]],[[1],[2,3],[4],[5],[6],[7],[8],[9],[10],[11]]);
 const original=JSON.stringify(base),draft=createPdfStructureDraft(base);
 assert.equal(draft.revision,0);
 assert.deepEqual(draft.plan.paragraphs.map(item=>[item.physicalLines,item.kind]),[[[1],'heading'],[[2,3],'paragraph'],[[4],'preserved'],[[5],'paragraph'],[[6],'caption'],[[7],'preserved'],[[8],'preserved'],[[9],'preserved'],[[10],'heading'],[[11],'paragraph']]);
 assert.equal(JSON.stringify(base),original,'baseline does not mutate any original text/glyph/image/path assets');
 const before=JSON.stringify(draft),patch={expectedRevision:0,paragraphs:[p([2]),p([3])]},patchBytes=JSON.stringify(patch);
 const split=revisePdfStructureDraft(base,draft,patch);assert.equal(split.revision,1);assert.equal(JSON.stringify(draft),before);assert.equal(JSON.stringify(patch),patchBytes);
 const merged=revisePdfStructureDraft(base,split,{expectedRevision:1,paragraphs:[p([2,3])]});assert.equal(merged.revision,2);
 assert.deepEqual(allIds(merged),base.physicalBlocks.map(block=>block.line));
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([2])]}),error=>{
  assert.match(error.message,/partial groups/);assert.match(error.message,/"physicalLines":\[2,3\]/);
  assert.match(error.message,/Missing physical IDs: \[3\]/);assert.match(error.message,/splits/);return true;
 });
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([2,3]),p([3])]}),/duplicates/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([99])]}),/foreign source/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[{...p([2,3]),text:'Rewritten source'}]}),/forbidden fields text/);
 assert.throws(()=>revisePdfStructureDraft(base,merged,{expectedRevision:1}),/stale revision/);
 const unchanged=revisePdfStructureDraft(base,merged,{expectedRevision:2,paragraphs:[structuredClone(merged.plan.paragraphs.find(item=>item.physicalLines[0]===2))],moves:[]});assert.equal(unchanged.revision,2);
 assert.notEqual(unchanged.plan,merged.plan,'no-op still returns an independent snapshot');
 const empty=revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[],moves:[]});assert.equal(empty.revision,0);
 const moved=revisePdfStructureDraft(base,merged,{expectedRevision:2,moves:[{physicalLine:3}]});assert.deepEqual(moved.plan.paragraphs[0].physicalLines,[2,3]);assert.equal(moved.revision,3);
 const restored=revisePdfStructureDraft(base,moved,{expectedRevision:3,moves:[{physicalLine:2,afterPhysicalLine:1}]});assert.deepEqual(restored.plan.paragraphs[1].physicalLines,[2,3]);
 assert.equal(revisePdfStructureDraft(base,restored,{expectedRevision:4,moves:[{physicalLine:3,afterPhysicalLine:1}]}).revision,4,'whole paragraph already in requested location is no-op');
 assert.throws(()=>revisePdfStructureDraft(base,merged,{expectedRevision:2,moves:[{physicalLine:2,afterPhysicalLine:3}]}),/same paragraph/);
 assert.throws(()=>revisePdfStructureDraft(base,merged,{expectedRevision:2,moves:[{physicalLine:2,afterPhysicalLine:999}]}),/foreign source/);
 assert.equal(JSON.stringify(base),original);assert.deepEqual(base.physicalBlocks[3].paintOperations,[140]);
}
{
 const base=fixture([row('continued source',720),row('on next page.',70,{page:2})],[[1],[2]]);
 const draft=createPdfStructureDraft(base),cross=revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([1,2])]});assert.deepEqual(cross.plan.paragraphs[0].physicalLines,[1,2]);
 const split=revisePdfStructureDraft(base,cross,{expectedRevision:1,paragraphs:[p([1]),p([2])]});
 const join=revisePdfStructureDraft(base,split,{expectedRevision:2,paragraphs:[p([1,2])]});
 assert.deepEqual(applyPdfStructurePlan(base,join.plan).layout.blocks[0].fragments,[1,2],'final acceptance can verify a source-evidenced cross-page draft');
 const legacy=structuredClone(base);delete legacy.mechanicalParagraphs;legacy.blocks=[{...legacy.blocks[0],fragments:[1,2]}];assert.deepEqual(createPdfStructureDraft(legacy).plan.paragraphs[0].physicalLines,[1,2]);
 const malformed=structuredClone(base);malformed.blocks=[structuredClone(base.blocks[0])];assert.throws(()=>createPdfStructureDraft(malformed),/missing source IDs 2/);
 malformed.blocks=[{...structuredClone(base.blocks[0]),fragments:[1,2]},{...structuredClone(base.blocks[1]),fragments:[2]}];assert.throws(()=>createPdfStructureDraft(malformed),/duplicate paragraph owner/);
}
const cell=(text,x,y,page=1,width=60)=>row(text,y,{x,width,page,segmentation:'parallel-region'});
function twoTables(){
 const base=fixture([row('Table 1: Results.',40),cell('Wide header',40,70,1,210),cell('Left',40,100),cell('Right',190,100),cell('Alpha',40,120),cell('5',190,120),row('Body below.',180),
  row('Table 2: More results.',40,{page:2}),cell('Method',40,70,2),cell('Score',190,70,2),cell('Beta',40,90,2),cell('6',190,90,2)],[[1,2,3,4,5,6,7],[8,9,10,11,12]]);
 base.pages[0].graphicOperations=[500,501];base.pages[0].tableRules=[{id:'framed-table',firstSourceLine:2,captionLine:1,sourceLines:[2,3,4,5,6],rows:[[2],[3,4],[5,6]],paintOperations:[500,501],horizontalRuleOperations:[500,501],evidence:'rules-and-grid',box:{x:40,y:70,width:210,height:62}}];base.protectionHash=pdfProtectionHash(base);return base;
}
{
 const base=twoTables(),original=JSON.stringify(base),draft=createPdfStructureDraft(base);assert.equal(draft.plan.tables.length,2,'native frame first, caption/parallel fallback on unframed page');
 const table=draft.plan.tables[0];assert.equal(table.columnCount,2);assert.deepEqual(table.rows[0],[{physicalLines:[2],column:0,columnSpan:2}]);
 assert.equal(draft.plan.paragraphs.find(item=>item.physicalLines[0]===6).kind,'preserved');assert.equal(draft.plan.paragraphs.find(item=>item.physicalLines[0]===3).kind,'table-cell');
 assert.deepEqual(allIds(draft),base.physicalBlocks.map(block=>block.line));
 const replacement=structuredClone(table);replacement.id='reviewed-table';const patch={expectedRevision:0,tables:[replacement]},patchBefore=JSON.stringify(patch);
 const edited=revisePdfStructureDraft(base,draft,patch);assert.equal(edited.revision,1);assert.equal(JSON.stringify(patch),patchBefore);
 assert.deepEqual(edited.plan.tables.find(item=>item.page===2),draft.plan.tables[1],'unselected page table retained exactly');
 assert.equal(revisePdfStructureDraft(base,edited,{expectedRevision:1,tables:[structuredClone(replacement)]}).revision,1);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[]}),/empty.*pages/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[replacement],tablePages:[]}),/empty.*pages/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tablePages:[3]}),/foreign pages/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tablePages:[1]}),/requires an explicit tables array/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[replacement],tablePages:[2]}),/unselected page/);
 const foreign=structuredClone(replacement);foreign.rows[1][0].physicalLines=[9];assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[foreign]}),/foreign page/);
 const overlap=structuredClone(replacement);overlap.rows[1][1].column=0;assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[overlap]}),/overlaps column/);
 const outside=structuredClone(replacement);outside.rows[1][1].columnSpan=2;assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[outside]}),/escapes columns/);
 const partial=structuredClone(replacement);partial.rows[1][0].physicalLines=[3,5];assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[partial]}),/exactly own/);
 const removed=revisePdfStructureDraft(base,draft,{expectedRevision:0,tablePages:[1],tables:[],paragraphs:[p([2]),p([3]),p([4]),p([5])]});assert.equal(removed.plan.tables.length,1);assert.equal(removed.plan.tables[0].page,2);
 const withdrawn=applyPdfStructurePlan(base,removed.plan);assert.equal(withdrawn.metrics.coverage,1);assert.deepEqual(withdrawn.layout.structureTables,removed.plan.tables,'mechanical ruled frame can be withdrawn as semantic table without changing source ownership');
 assert.deepEqual(withdrawn.layout.pages[0].tableRules,base.pages[0].tableRules,'native rule-frame ownership remains preserved');
 assert.equal(JSON.stringify(base),original);
}
{
 const base=fixture(Array.from({length:1357},(_,index)=>row('Source visual row '+index,40+index%40*14,{page:Math.floor(index/40)+1})),Array.from({length:1357},(_,index)=>[index+1]));
 const draft=createPdfStructureDraft(base),patch={expectedRevision:0,paragraphs:[p([401,402])]};
 const revised=revisePdfStructureDraft(base,draft,patch);assert.equal(revised.plan.paragraphs.length,1356);assert.deepEqual(allIds(revised),base.physicalBlocks.map(block=>block.line));
 assert.ok(JSON.stringify(patch).length<200,'model patch size does not scale with unchanged document IDs');
}
console.log('PDF structure draft: complete mechanical baseline, bounded merge/split edits, CAS/no-op, whole-paragraph moves, table page/column ownership, final-gate separation and immutable native assets PASS.');

{
 const base=fixture([row('Table 1: One source column.',40),cell('Single header',40,70),cell('One value',40,90)]);
 base.pages[0].graphicOperations=[500,501];base.pages[0].tableRules=[{id:'one-column-frame',firstSourceLine:2,captionLine:1,sourceLines:[2,3],rows:[[2],[3]],paintOperations:[500,501],horizontalRuleOperations:[500,501],evidence:'rules-and-grid',box:{x:40,y:70,width:60,height:32}}];base.protectionHash=pdfProtectionHash(base);
 const draft=createPdfStructureDraft(base);assert.equal(draft.plan.tables[0].columnCount,1);assert.equal(applyPdfStructurePlan(base,draft.plan).metrics.coverage,1);
 const single=structuredClone(draft.plan.tables[0]);single.rows=single.rows.slice(0,1);
 const revised=revisePdfStructureDraft(base,draft,{expectedRevision:0,tables:[single],paragraphs:[p([3])]});assert.equal(revised.plan.tables[0].rows.length,1);assert.equal(applyPdfStructurePlan(base,revised.plan).metrics.coverage,1);
 console.log('One-column/one-row semantic table candidates remain editable under the same source/ownership schema PASS.');
}

{
 const base=fixture([row('First owner begins',100),row('and has a retained tail',114),row('next owner starts',128),row('and finishes here.',142),row('Separate body.',190)],[[1,2],[3,4],[5]],[[1,2],[3,4],[5]]);
 const draft=createPdfStructureDraft(base),before=JSON.stringify({base,draft});
 const merge={anchors:[2,3],kind:'paragraph',reason:'Explicit owner anchors from the actual audit finding.'};
 assert.deepEqual(expandPdfStructureMerges(base,draft,[merge]),[p([1,2,3,4],'paragraph',merge.reason)]);
 const patch={expectedRevision:0,merges:[merge]},originalPatch=JSON.stringify(patch),revised=revisePdfStructureDraft(base,draft,patch);
 assert.equal(revised.revision,1);assert.deepEqual(revised.plan.paragraphs[0].physicalLines,[1,2,3,4]);assert.deepEqual(allIds(revised),[1,2,3,4,5]);
 assert.deepEqual(applyPdfStructurePlan(base,revised.plan).layout.blocks[0].fragments,[1,2,3,4]);
 assert.equal(JSON.stringify({base,draft}),before);assert.equal(JSON.stringify(patch),originalPatch);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([2,3])]}),/partial groups/,'existing explicit partial-ID patches still reject rather than expanding silently');
 assert.deepEqual(revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[{...merge,anchors:[1,2,1]}]}).plan.paragraphs[0].physicalLines,[1,2],'redundant selectors preserve the complete owner once');
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[merge,{...merge,anchors:[4,5]}]}),/repeats.*owner/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[merge],paragraphs:[p([1,2])]}),error=>{
  assert.match(error.message,/same existing owner/);assert.match(error.message,/merge\[1\] conflicts with paragraphs \[1\]/);
  assert.match(error.message,/"physicalLines":\[1,2\]/);assert.match(error.message,/one operation per owner/);return true;
 });
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[{...merge,anchors:[999]}]}),/foreign source/);
 assert.throws(()=>revisePdfStructureDraft(base,revised,{expectedRevision:0,merges:[merge]}),/stale revision/);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[{...merge,text:'New prose'}]}),/forbidden fields text/);
 assert.deepEqual(expandPdfStructureMerges(base,draft,[{...merge,anchors:[3,1]}])[0].physicalLines,[3,4,1,2],'anchor order explicitly defines whole-owner order');
 const disjoint=revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[{...merge,anchors:[1]},{...merge,anchors:[3]}],paragraphs:[p([5],'heading')]});
 assert.deepEqual(disjoint.plan.paragraphs.map(item=>item.physicalLines),[[1,2],[3,4],[5]],'disjoint merges stay at their own earliest owner position');
 console.log('PDF explicit merge anchors: whole-owner expansion, captured partial-ID repair, source conservation, conflict/duplicate/CAS checks and immutable inputs PASS.');
}
{
 // Exact affected IDs and owner groups from real attempt 6's JSONL/applied plan.
 const rows=Array.from({length:29},(_,index)=>row('Other owned source '+index,40+index*14));
 rows.push(row('Recent work has',720),row('therefore pursued',734),row('continued evidence',748),row('1',770),
  row('developed depth notions',70,{page:2}),row('using source evidence',84,{page:2}),row('with complete owners',98,{page:2}),row('and a retained tail.',112,{page:2}));
 const base=fixture(rows,[...Array.from({length:29},(_,index)=>[index+1]),[30,31,32],[33],[34,35,36,37]],[...Array.from({length:29},(_,index)=>[index+1]),[30,31,32],[33],[34,35,36,37]]),draft=createPdfStructureDraft(base);
 assert.throws(()=>revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([30,31,32,34])]}),/partial groups/,'captured attempt6 patch omits owner tail 35–37');
 const revised=revisePdfStructureDraft(base,draft,{expectedRevision:0,merges:[{anchors:[32,34],kind:'paragraph',reason:'Explicit full-owner cross-page sentence repair.'}]});
 assert.deepEqual(revised.plan.paragraphs.find(item=>item.physicalLines.includes(30)).physicalLines,[30,31,32,34,35,36,37]);
 assert.deepEqual(revised.plan.paragraphs.find(item=>item.physicalLines.includes(33)),draft.plan.paragraphs.find(item=>item.physicalLines.includes(33)),'folio stays separately owned');
 assert.equal(applyPdfStructurePlan(base,revised.plan).metrics.coverage,1);assert.deepEqual(allIds(revised),Array.from({length:37},(_,index)=>index+1));
 console.log('Real attempt6 owner groups: explicit [32,34] anchors retain omitted 35–37 tail, independent folio, source conservation and hard validation PASS.');
}

{
 const base=fixture(Array.from({length:200},(_,index)=>row(`Source visual row ${index+1}.`,20+index*14)));
 const draft=createPdfStructureDraft(base);
 const owner=Array.from({length:12},(_,index)=>184+index);
 const complete=revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p(owner,'paragraph','Captured attempt7 owner L184–L195.')]});
 const original=JSON.stringify(complete),patch={expectedRevision:1,splits:[{beforePhysicalLine:194,kind:'caption',reason:'Caption continuation boundary.'},{beforePhysicalLine:192,kind:'paragraph',reason:'Audit reported only the new paragraph start.'}]};
 const patchBytes=JSON.stringify(patch),expanded=expandPdfStructureSplits(base,complete,patch.splits);
 assert.deepEqual(expanded[0].groups.map(group=>group.physicalLines),[owner.slice(0,8),owner.slice(8,10),owner.slice(10)]);
 assert.equal(expanded[0].groups[0].reason,'Captured attempt7 owner L184–L195.');
 const revised=revisePdfStructureDraft(base,complete,patch);
 assert.equal(revised.revision,2);assert.deepEqual(allIds(revised),allIds(complete));
 assert.equal(JSON.stringify(complete),original);assert.equal(JSON.stringify(patch),patchBytes);
 assert.throws(()=>revisePdfStructureDraft(base,complete,{expectedRevision:1,splits:[patch.splits[0],patch.splits[0]]}),/duplicate split/);
 assert.throws(()=>revisePdfStructureDraft(base,complete,{expectedRevision:1,splits:[{...patch.splits[0],beforePhysicalLine:999}]}),/foreign source/);
 assert.throws(()=>revisePdfStructureDraft(base,complete,{expectedRevision:1,splits:patch.splits,paragraphs:[p([184])]}),/same existing owner/);
 assert.throws(()=>revisePdfStructureDraft(base,complete,{expectedRevision:1,splits:patch.splits,merges:[{anchors:[1,2],kind:'paragraph',reason:'Separate edits required.'}]}),/separate revision/);
 const reordered=revisePdfStructureDraft(base,draft,{expectedRevision:0,paragraphs:[p([3,1,2])]});
 assert.deepEqual(expandPdfStructureSplits(base,reordered,[{beforePhysicalLine:2,kind:'heading',reason:'Later cut.'},{beforePhysicalLine:1,kind:'paragraph',reason:'Earlier cut.'}])[0].groups.map(group=>group.physicalLines),[[3],[1],[2]],'cuts follow owner order rather than numerical IDs');
 console.log('ok explicit source-boundary splits retain captured owner tails, roles, CAS and all source identities');
}
