import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {applyPdfStructurePlan,validatePdfStructurePlan} from '../src/main/pdfStructurePlan.ts';
import {pdfProtectionHash,validatePdfLayout,PDF_LAYOUT_VERSION,PDF_EXTRACTOR_REVISION} from '../src/main/pdfTypes.ts';
import {pdfReferenceSections} from '../src/main/pdfReferenceSections.ts';

const hash=text=>createHash('sha256').update(text).digest('hex');
const prose=(text,y,extra={})=>({line:0,page:1,x:40,y,width:400,height:12,fontSize:10,segmentation:'paragraph',text,inlineProtections:[],proseSegments:[{text,boxes:[{x:40,y,width:400,height:12}]}],...extra});
const native=(text,y,protection='math',extra={})=>({line:0,page:1,x:160,y,width:100,height:12,fontSize:10,segmentation:'protected',text,protection,paintOperations:[y],nativePathOperations:[],sourceInkBox:{x:160,y,width:100,height:12},...extra});
function base(rows,references=[]) {
  rows=structuredClone(rows);rows.forEach((row,index)=>row.line=index+1);
  const physicalBlocks=structuredClone(rows),blocks=rows.map(row=>({...row,fragments:[row.line],
    ...(row.proseSegments?{proseSegments:row.proseSegments.map(segment=>({...segment,boxes:segment.boxes.map(box=>({...box,page:row.page}))}))}:{})}));
  const result={version:PDF_LAYOUT_VERSION,extractorRevision:PDF_EXTRACTOR_REVISION,originalPath:'/source.pdf',originalHash:hash('original'),sourcePath:'/source.txt',sourceHash:hash(blocks.map(row=>row.text).join('\n')),
    protectionHash:'',physicalBlocks,blocks,references,figureGroups:[],pages:Array.from({length:Math.max(...rows.map(row=>row.page))},(_,index)=>({page:index+1,width:600,height:800,backgroundPath:'/bg.png',backgroundHash:hash('bg'),previewPath:'/preview.png',previewHash:hash('preview'),graphicOperations:[]}))};
  result.protectionHash=pdfProtectionHash(result);validatePdfLayout(result);return result;
}
const paragraph=(physicalLines,kind='paragraph')=>({physicalLines,kind,reason:'Verified source geometry and visual reading order.'});
const audit={readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true,issues:[]};
const plan=(paragraphs,tables=[])=>({version:1,paragraphs,tables,audit:structuredClone(audit)});
const tagged=prose('First {{formula:p1:1}} phrase',100);
tagged.inlineProtections=[{x:90,y:100,width:10,height:12,token:'{{formula:p1:1}}',text:'x',kind:'math',paintOperations:[22],nativePathOperations:[],inkBox:{x:90,y:100,width:10,height:12}}];
tagged.proseSegments=[{text:'First ',boxes:[{x:40,y:100,width:50,height:12}]},{text:' phrase',boxes:[{x:100,y:100,width:100,height:12}]}];
const source=base([prose('1 Introduction',40,{structureKind:'heading'}),tagged,prose('continues as',114),native('a + b',128),native('(1)',142),prose('and finishes here.',156),native('const x = 1;',200,'code'),native('return x;',214,'code'),prose('Figure 1: Native image.',240)],
  [{id:'p1-image1',page:1,x:40,y:260,width:100,height:80,captionLine:9}]);
const accepted=plan([paragraph([9],'caption'),paragraph([1],'heading'),paragraph([2,3,4,5,6]),paragraph([7,8],'preserved')]);
const original=JSON.stringify(source),result=applyPdfStructurePlan(source,accepted);
assert.equal(JSON.stringify(source),original,'Applying a plan clones rather than mutating the sealed mechanical layout.');
assert.deepEqual(result.metrics,{physicalBlocks:9,paragraphs:4,coverage:1,coveragePercent:100,duplicates:0,foreign:0,protectedUnchanged:true,semanticAuditAccepted:true,nativeSources:5,nativeCoverage:1,graphicOperations:0,graphicCoverage:1,figureAssets:1,figureCoverage:1});
assert.deepEqual(result.layout.physicalBlocks,source.physicalBlocks,'Every original glyph/path/text/image primitive is retained.');
assert.equal(result.layout.references[0].captionLine,1);assert.equal(result.layout.references[0].id,'p1-image1');
assert.equal(result.layout.blocks[2].text,'First {{formula:p1:1}} phrase continues as{{formula:p1:2}}and finishes here.');
assert.deepEqual(result.layout.blocks[2].inlineProtections.map(node=>node.token),['{{formula:p1:1}}','{{formula:p1:2}}']);
assert.deepEqual(result.layout.blocks[2].inlineProtections[1].physicalLines,[4,5]);
assert.deepEqual(result.layout.blocks[2].inlineProtections[1].paintOperations,[128,142]);
assert.equal(result.layout.blocks[3].text,'const x = 1; return x;');assert.equal(result.layout.blocks[3].protection,'code');
assert.deepEqual(result.layout.blocks[3].paintOperations,[200,214]);
assert.equal(result.layout.blocks[2].structureKind,'paragraph');
assert.equal(result.sourceText,result.layout.blocks.map(block=>block.text).join('\n'));assert.ok(!result.sourceText.endsWith('\n'));
assert.equal(result.layout.sourceHash,hash(result.sourceText));assert.equal(result.layout.protectionHash,pdfProtectionHash(result.layout));

function rejected(source,accepted,mutate,pattern) {const bad=structuredClone(accepted);mutate(bad);assert.throws(()=>applyPdfStructurePlan(source,bad),pattern);}
function evidenced(source,accepted,mutate,pattern) {const candidate=structuredClone(accepted);mutate(candidate);const applied=applyPdfStructurePlan(source,candidate);
  assert.equal(applied.metrics.coverage,1);assert.ok(applied.geometryFindings.some(finding=>pattern.test(finding.message)),JSON.stringify(applied.geometryFindings));}
rejected(source,accepted,value=>value.paragraphs.pop(),/missing physical source IDs 7, 8/);
rejected(source,accepted,value=>value.paragraphs[1].physicalLines.push(2),/heading.*|multiple paragraphs|visual continuation/);
rejected(source,accepted,value=>value.paragraphs[2].physicalLines.push(99),/foreign physical source ID L99/);
rejected(source,accepted,value=>value.paragraphs[2].text='Rewritten text',/forbidden fields text/);
rejected(source,accepted,value=>value.paragraphs[2].physicalLines.push(3),/repeats physical IDs/);
rejected(source,accepted,value=>value.paragraphs[3].kind='paragraph',/native-only IDs 7,8/);
rejected(source,accepted,value=>{value.paragraphs[2].physicalLines.push(7,8);value.paragraphs.pop();},/code source IDs 7,8/);
rejected(source,accepted,value=>value.paragraphs[2].kind='preserved',/writable prose/);
rejected(source,accepted,value=>value.audit.readingOrder=false,/semantic audit/);
rejected(source,accepted,value=>value.audit.issues.push({physicalLines:[2],message:'Unresolved flow.'}),/semantic audit.*Unresolved flow/);
evidenced(source,accepted,value=>value.paragraphs=[paragraph([1,2,3,4,5,6]),paragraph([7,8],'preserved'),paragraph([9],'caption')],/heading hint/);
evidenced(source,accepted,value=>value.paragraphs[2].physicalLines=[3,2,4,5,6],/visual-wrap/);
const differentFont=structuredClone(source);differentFont.physicalBlocks[2].fontSize=11;differentFont.blocks[2].fontSize=11;differentFont.protectionHash=pdfProtectionHash(differentFont);
assert.ok(applyPdfStructurePlan(differentFont,accepted).geometryFindings.some(finding=>/font scales differ/.test(finding.message)));
const foreignNative=structuredClone(source);foreignNative.physicalBlocks[3].x=500;foreignNative.physicalBlocks[3].width=50;foreignNative.physicalBlocks[3].sourceInkBox={x:500,y:128,width:50,height:12};foreignNative.blocks[3]={...foreignNative.physicalBlocks[3],fragments:[4]};foreignNative.protectionHash=pdfProtectionHash(foreignNative);
assert.ok(applyPdfStructurePlan(foreignNative,accepted).geometryFindings.some(finding=>/Native L4/.test(finding.message)));

const cross=base([prose('continued',720),prose('on next page.',70,{page:2})]);
const numberedMath=base([native('1 B ( beta ( s )) ds,',100)]);
assert.equal(applyPdfStructurePlan(numberedMath,plan([paragraph([1],'preserved')])).layout.blocks[0].protection,'math',
  'Verified native math beginning with a number and letter is not a section heading.');
assert.deepEqual(applyPdfStructurePlan(cross,plan([paragraph([1,2])])).layout.blocks[0].fragments,[1,2]);
const gap=base([prose('continued',720),prose('foreign page.',70,{page:3})]);
assert.ok(applyPdfStructurePlan(gap,plan([paragraph([1,2])])).geometryFindings.some(finding=>/page order\/gaps/.test(finding.message)));
const midPage=base([prose('middle',300),prose('page continuation.',300,{page:2})]);
assert.ok(applyPdfStructurePlan(midPage,plan([paragraph([1,2])])).geometryFindings.some(finding=>/cross-page continuation/.test(finding.message)));
const giant=base([prose('First paragraph.',100),prose('Indented new paragraph.',114,{x:60}),prose('Last.',180)]);
assert.ok(applyPdfStructurePlan(giant,plan([paragraph([1,2,3])])).geometryFindings.some(finding=>/visual-wrap/.test(finding.message)));
const skipped=base([prose('first',100),prose('middle body',113),prose('last',126)]);
assert.ok(applyPdfStructurePlan(skipped,plan([paragraph([1,3]),paragraph([2])])).geometryFindings.some(finding=>/passes source IDs 2/.test(finding.message)));

// Real PDF glyph bounds are not baselines, and hanging list continuations
// share a source column even when their first visible character is indented.
for(const prefix of ['(1)','(ii)','•']) {
  const list=base([prose(`${prefix} A statement continuing to the`,100,{baseline:110,columnX:40}),
    prose('next indented line.',116,{x:58,baseline:126,columnX:40})]);
  assert.equal(applyPdfStructurePlan(list,plan([paragraph([1,2])])).layout.blocks[0].text,`${prefix} A statement continuing to the next indented line.`);
}
const wideBounds=base([prose('Original formula-bearing line continues',100,{baseline:112,columnX:40,height:29}),
  prose('through its normal baseline.',101,{baseline:128,columnX:40})]);
assert.equal(applyPdfStructurePlan(wideBounds,plan([paragraph([1,2])])).metrics.paragraphs,1);
const hanging=base([prose('(1) A complete first list line.',100,{baseline:110,columnX:40}),
  prose('still part of the same list item.',116,{x:72,baseline:126,columnX:40})]);
assert.equal(applyPdfStructurePlan(hanging,plan([paragraph([1,2])])).metrics.paragraphs,1);
const otherColumn=base([prose('Left column unfinished',100,{baseline:110,columnX:40}),
  prose('Right column unrelated.',116,{x:300,width:240,baseline:126,columnX:300,proseSegments:[{text:'Right column unrelated.',boxes:[{x:300,y:116,width:240,height:12}]}]})]);
assert.ok(applyPdfStructurePlan(otherColumn,plan([paragraph([1,2])])).geometryFindings.some(finding=>/same-column/.test(finding.message)));
const newParagraph=base([prose('Completed paragraph.',100,{baseline:110,columnX:40}),
  prose('Indented new paragraph.',116,{x:58,baseline:126,columnX:40})]);
assert.ok(applyPdfStructurePlan(newParagraph,plan([paragraph([1,2])])).geometryFindings.some(finding=>/same-column/.test(finding.message)));
const invalidGeometry=structuredClone(hanging);invalidGeometry.blocks[0].baseline=NaN;
assert.throws(()=>validatePdfLayout(invalidGeometry),/source baseline or column/);
const numericBody=base([prose('The population exceeded',100),prose('1 million people during that year.',116)]);
assert.equal(applyPdfStructurePlan(numericBody,plan([paragraph([1,2])])).metrics.paragraphs,1);
const columnRow=(text,x,y)=>prose(text,y,{x,width:200,columnX:x,baseline:y+10,proseSegments:[{text,boxes:[{x,y,width:200,height:12}]}]});
const columns=base([columnRow('End of the left',40,720),columnRow('column continues',40,736),
  columnRow('at the right top',320,50),columnRow('and ends here.',320,66)]);
assert.equal(applyPdfStructurePlan(columns,plan([paragraph([1,2,3,4])])).metrics.paragraphs,1);
assert.ok(applyPdfStructurePlan(columns,plan([paragraph([1,2,3,4],'heading')])).geometryFindings.some(finding=>/visual-wrap/.test(finding.message)));
assert.ok(applyPdfStructurePlan(columns,plan([paragraph([1,2,3,4],'caption')])).geometryFindings.some(finding=>/visual-wrap/.test(finding.message)));
const scopedColumns=structuredClone(columns);
for(const group of [scopedColumns.blocks,scopedColumns.physicalBlocks])for(const row of group)row.sourceScope=row.line<=2?'P:1':'P:2';
scopedColumns.protectionHash=pdfProtectionHash(scopedColumns);
assert.ok(applyPdfStructurePlan(scopedColumns,plan([paragraph([1,2,3,4])])).geometryFindings.some(finding=>/Source paragraph tags differ/.test(finding.message)));
const premature=base([columnRow('Left earlier',40,700),columnRow('Unconsumed left tail.',40,750),columnRow('Right top',320,50)]);
assert.ok(applyPdfStructurePlan(premature,plan([paragraph([1,3]),paragraph([2])])).geometryFindings.some(finding=>/visual-wrap/.test(finding.message)));
const horizontal=base([prose('Do',100,{x:40,width:16}),prose('I',100,{x:62,width:4}),prose('continue?',100,{x:72,width:54})]);
assert.ok(applyPdfStructurePlan(horizontal,plan([paragraph([1,3]),paragraph([2])])).geometryFindings.some(finding=>/Horizontal flow passes source IDs 2/.test(finding.message)),
  'Exact coverage is a hard gate; skipped horizontal words are explicit layout evidence for the independent semantic audit.');
invalidGeometry.blocks[0].baseline=110;invalidGeometry.blocks[0].columnX=Infinity;
assert.throws(()=>validatePdfLayout(invalidGeometry),/source baseline or column/);

const references=base([prose('References',100),prose('[1] Original citation.',114),prose('[2] Another citation.',128),prose('Appendix',180),prose('Appendix body.',200)]);
const referencePlan=plan([paragraph([1],'preserved'),paragraph([2,3],'preserved'),paragraph([4],'heading'),paragraph([5])]);
const referenceResult=applyPdfStructurePlan(references,referencePlan);
assert.equal(referenceResult.layout.blocks[0].text,'References');
assert.equal(referenceResult.layout.blocks[1].text,'[1] Original citation. [2] Another citation.');
rejected(references,referencePlan,value=>value.paragraphs[0].kind='paragraph',/reference section source IDs/);
evidenced(references,referencePlan,value=>value.paragraphs[1].physicalLines=[3,2],/Reference source order/);
rejected(references,referencePlan,value=>{value.paragraphs[0].physicalLines=[1,2,3];value.paragraphs.splice(1,1);},/reference heading source IDs/);
evidenced(references,referencePlan,value=>value.paragraphs=[paragraph([1],'preserved'),paragraph([4],'heading'),paragraph([2,3],'preserved'),paragraph([5])],/separated by other source owners/);
const folio=(page)=>prose(String(page),767,{page,x:292,width:10,sourceInkPath:`/folio-${page}.png`,sourceInkHash:hash(`folio-${page}`),sourceInkBox:{x:292,y:767,width:10,height:12}});
const folioReferences=base([prose('References',441),prose('Citation on first page.',472),folio(1),prose('Citation on second page.',93,{page:2}),folio(2),prose('Appendix',200,{page:2}),prose('Body still requires translation.',230,{page:2})]);
const movedFolios=applyPdfStructurePlan(folioReferences,plan([paragraph([3],'preserved'),paragraph([5],'preserved'),paragraph([1],'preserved'),paragraph([2],'preserved'),paragraph([4],'preserved'),paragraph([6],'heading'),paragraph([7])]));
assert.ok(movedFolios.geometryFindings.some(finding=>/Reference source order/.test(finding.message)),'presentation-only folios may move without changing reference identity');
assert.deepEqual(pdfReferenceSections(movedFolios.layout).protectedLines.map(row=>movedFolios.layout.blocks[row.line-1].fragments),[[3],[5],[1],[2],[4]]);
assert.ok(!pdfReferenceSections(movedFolios.layout).protectedLines.some(row=>row.text==='Body still requires translation.'),'new heading/output placement cannot freeze foreign body prose');
assert.equal(movedFolios.metrics.protectedUnchanged,true);assert.equal(movedFolios.metrics.coverage,1);

const cell=(text,x,y,width=60)=>prose(text,y,{x,width,segmentation:'parallel-region',proseSegments:[{text,boxes:[{x,y,width,height:12}]}]});
const tableSource=base([prose('Table 1: Source cells.',40),cell('Combined header',40,70,210),cell('left',40,100),cell('right',190,100),cell('multi',40,120),cell('line',40,134),cell('value',190,120),prose('Body below.',200)]);
const table={id:'source-table-1',page:1,columnCount:3,captionPhysicalLine:1,rows:[[{physicalLines:[2],column:0,columnSpan:3}],
  [{physicalLines:[3],column:0,columnSpan:1},{physicalLines:[4],column:2,columnSpan:1}],
  [{physicalLines:[5,6],column:0,columnSpan:1},{physicalLines:[7],column:2,columnSpan:1}]]};
const tablePlan=plan([paragraph([1],'caption'),paragraph([2],'table-cell'),paragraph([3],'table-cell'),paragraph([4],'table-cell'),paragraph([5,6],'table-cell'),paragraph([7],'table-cell'),paragraph([8])],[table]);
const tableResult=applyPdfStructurePlan(tableSource,tablePlan);assert.deepEqual(tableResult.layout.structureTables,[table]);
assert.equal(tableResult.layout.blocks[4].text,'multi line');
const unnumbered=structuredClone(tablePlan);delete unnumbered.tables[0].captionPhysicalLine;
assert.equal(validatePdfStructurePlan(tableSource,unnumbered).coveragePercent,100,'Uncaptioned tables use the same exact cell/geometry acceptance.');
rejected(tableSource,tablePlan,value=>value.tables[0].rows[2][0].physicalLines=[5],/do not exactly own/);
rejected(tableSource,tablePlan,value=>value.tables.push({...value.tables[0],id:'second'}),/table source L2 is reused/);
rejected(tableSource,tablePlan,value=>value.tables[0].rows[1][1].column=0,/overlaps column 0/);
rejected(tableSource,tablePlan,value=>value.tables[0].rows[1][1].columnSpan=2,/escape declared columns/);
rejected(tableSource,tablePlan,value=>value.tables[0].captionPhysicalLine=8,/caption L8/);
rejected(tableSource,tablePlan,value=>value.tables=[],/no table owner/);
rejected(tableSource,tablePlan,value=>value.tables[0].rows[1][1]={physicalLines:[8],column:2,columnSpan:1},/do not exactly own|confirmed table cell/);
rejected(tableSource,tablePlan,value=>value.paragraphs[2].kind='paragraph',/confirmed table cell|do not exactly own/);
console.log('PDF structure plan: hard source/native conservation and table ownership; flexible geometry evidence, semantic audit gates and hash binding PASS.');
