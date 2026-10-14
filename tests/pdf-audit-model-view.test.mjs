import assert from 'node:assert/strict';
import {makePdfLogicalDocument} from '../src/main/pdfLogicalDocument.ts';
import {sourceInspectionRows,preparedInspectionRows,preparedInspectionMetadata,pdfAuditPackets,sourceReadingSequence} from '../src/main/pdfAuditPackets.ts';

const policy={characters:'verbatim-original-source',lineWrapHyphenation:'retained-original-characters',structureEditsCannotRewriteWords:true};
const row=(line,text,y,extra={})=>({line,page:1,x:40,y,width:300,height:14,fontSize:11,text,segmentation:'paragraph',inlineProtections:[],proseSegments:[{text,boxes:[{x:40,y,width:300,height:14}]}],...extra});
const math=(line,text,y)=>row(line,text,y,{protection:'math',segmentation:'protected',paintOperations:[line*10],inlineProtections:undefined,proseSegments:undefined,sourceInkBox:{x:40,y,width:300,height:14}});
{
 const code={x:90,y:60,width:30,height:14,kind:'code',token:'{{code:p1:1}}',text:'x++',paintOperations:[7]};
 const lead=row(1,'The source {{code:p1:1}} defines a hy-phenated value',60,{inlineProtections:[code],proseSegments:[
  {text:'The source ',boxes:[{x:40,y:60,width:50,height:14}]},{text:' defines a hy-phenated value',boxes:[{x:120,y:60,width:220,height:14}]}]});
 const layout={originalHash:'a'.repeat(64),protectionHash:'b'.repeat(64),blocks:[lead,math(2,'x + y .',90),
  row(3,'Since the source text is ver-batim.',120),row(4,'Finally the source defines',150),math(5,'z = 2 .',180),
  row(6,'return x;',210,{protection:'code',segmentation:'protected',paintOperations:[60],inlineProtections:undefined,proseSegments:undefined}),math(7,'u = 3',240)],
  pages:[{page:1,width:600,height:800}],references:[],figureGroups:[],mechanicalParagraphs:Array.from({length:7},(_,index)=>[index+1])};
 makePdfLogicalDocument(layout);
 const before=JSON.stringify(layout),source=JSON.parse(JSON.stringify(sourceInspectionRows(layout,[1,2,3,4,5,6,7],false))),prepared=JSON.parse(JSON.stringify(preparedInspectionRows(layout,layout.blocks.map(block=>block.line))));
 assert.deepEqual(layout.blocks.map(block=>block.fragments),[[1,2],[3],[4,5],[6],[7]],'uppercase following prose and end-of-document do not prevent the actual prior display owner');
 assert.deepEqual(source[0].inlineNodes,[{token:code.token,text:code.text,kind:'code'}]);assert.equal(source[0].nativeNodes,undefined,'raw source retains its established inlineNodes vocabulary');
 assert.equal(source[1].protection,'math');assert.equal(source[1].inlineNodes,undefined);
 assert.ok(prepared.every(block=>!Object.hasOwn(block,'inlineNodes')),'prepared view never calls display-owned math inline');
 const inline=prepared[0].nativeNodes.find(node=>node.token===code.token),display=prepared[0].nativeNodes.find(node=>node.placement==='display');
 assert.deepEqual(inline,{token:code.token,text:code.text,kind:'code',placement:'inline',readonly:true,ownedByParagraph:true});
 assert.deepEqual(display.physicalLines,[2]);assert.equal(display.text,'x + y .');assert.equal(display.kind,'math');assert.equal(display.readonly,true);assert.equal(display.ownedByParagraph,true);
 assert.equal(prepared[2].nativeNodes.length,1);assert.equal(prepared[2].nativeNodes[0].placement,'display');assert.deepEqual(prepared[2].nativeNodes[0].physicalLines,[5]);
 for(const owner of prepared.filter(owner=>owner.nativeNodes?.length)){
  const expected=owner.nativeNodes.reduce((text,node)=>text.replaceAll(node.token,node.text),owner.text);
  assert.equal(owner.readingSequence.map(part=>part.text).join(''),expected,'readable sequence expands every native marker without changing characters');
  for(const node of owner.nativeNodes)assert.equal(owner.readingSequence.filter(part=>part.token===node.token).length,1);
 }
 assert.equal(source[0].readingSequence.map(part=>part.text).join(''),lead.text.replace(code.token,code.text));
 assert.equal(prepared[3].protection,'code');assert.equal(prepared[3].nativeNodes,undefined,'pure standalone native assets keep their source protection rather than an invented inline node');
 assert.ok(prepared[0].text.includes('hy-phenated'));assert.equal(prepared[1].text,'Since the source text is ver-batim.');
 assert.deepEqual(preparedInspectionMetadata(layout).sourceTextPolicy,policy);
 const packets=pdfAuditPackets(layout,layout,{promptVersion:9,systemPrompt:'Independent current-packet audit.'});
 for(const packet of packets){assert.deepEqual(packet.metadata.sourceTextPolicy,policy);for(const record of packet.records.filter(record=>record.record==='prepared')){assert.equal(record.ownerAnchor,record.physicalLines[0]);assert.equal(record.ownerKey,undefined);assert.equal(Object.hasOwn(record,'logicalLine'),false);}}
 for(const edge of packets[0].metadata.outgoingEdges){assert.ok(Number.isInteger(edge.beforePhysicalLine));assert.ok(Number.isInteger(edge.afterPhysicalLine)||edge.afterPhysicalLine==='END');assert.equal(edge.before,undefined);assert.equal(edge.after,undefined);}
 assert.ok(packets[0].coreOwnerKeys.every(key=>/^[a-f0-9]{64}$/.test(key)),'Host proof still carries immutable hashes independently of the readable model view');
 assert.equal(JSON.stringify(layout),before,'model views do not rewrite source text, nodes, geometry or ownership');
 console.log('ok p9 raw inlineNodes/prepared nativeNodes expose verbatim source reading sequence and retain every source hyphen');
}
{
 const token='{{formula:p1:115}}',native={token,text:'g ( x ))',kind:'math',physicalLines:[115],x:40,y:90,width:80,height:14,placement:'display'};
 const block={...row(1,'The condition is ('+token,60),fragments:[114,115],inlineProtections:[native]},before=JSON.stringify(block);
 const sequence=sourceReadingSequence(block);
 assert.equal(sequence.map(part=>part.text).join(''),'The condition is (g ( x ))');
 assert.deepEqual(sequence.at(-1),{kind:'native',token,text:native.text,readonly:true,placement:'display',physicalLines:[115]});
 assert.ok(sequence.at(-1).text.endsWith(')'),'closing punctuation owned by physical native 115 is visible inside the node; no duplicate writable punctuation is needed');
 assert.equal(sequence.at(-1).tex,undefined);assert.equal(JSON.stringify(block),before,'inspection never rewrites source text, tokens or native glyph evidence');
 console.log('ok native punctuation remains visible at physical 115 without pretending extracted glyph text is TeX');
}
{
 const raw=Array.from({length:240},(_,index)=>row(index+1,`Complete source owner ${index+1}. `+'Long literal source prose '.repeat(15),40+index*12));
 const base={originalHash:'a'.repeat(64),protectionHash:'b'.repeat(64),physicalBlocks:structuredClone(raw),blocks:raw.map(block=>({...structuredClone(block),fragments:[block.line]})),pages:[{page:1,width:600,height:4000}],references:[],figureGroups:[]};
 const layout=structuredClone(base);layout.blocks=[{...layout.blocks[0],fragments:[1,2,3]},...layout.blocks.slice(3)];layout.blocks.forEach((block,index)=>{block.line=index+1;block.structureKind='paragraph';});
 layout.blocks[0].text=raw.slice(0,3).map(block=>block.text).join(' ');layout.blocks[0].proseSegments=[{text:layout.blocks[0].text,boxes:raw.slice(0,3).flatMap(block=>block.proseSegments.flatMap(segment=>segment.boxes))}];
 layout.blocks[1].structureKind='heading';layout.blocks[2].structureKind='caption';
 const before=JSON.stringify({base,layout}),packets=pdfAuditPackets(base,layout,{promptVersion:9,systemPrompt:'Independent current-packet audit.'}),order=packets.find(packet=>packet.kind==='order');
 assert.ok(order);assert.deepEqual(order.metadata.sourceTextPolicy,policy);
 const first=order.records[0];assert.equal(first.ownerAnchor,1);assert.deepEqual(first.physicalLines,[1,2,3]);assert.equal(first.ownerKey,undefined);assert.equal(first.sourceFrames,undefined);
 assert.deepEqual(first.sourceRuns,[{page:1,fromPhysicalLine:1,toPhysicalLine:3,startX:raw[0].x,startY:raw[0].y,endX:raw[2].x,endY:raw[2].y}]);
 assert.equal(first.excerptOnly,true);assert.ok(first.text.startsWith(layout.blocks[0].text.slice(0,120)));assert.ok(first.text.endsWith(layout.blocks[0].text.slice(-80)));
 for(const index of [1,2]){assert.equal(order.records[index].text,layout.blocks[index].text);assert.equal(order.records[index].excerptOnly,false,'headings and captions remain complete in the global outline');}
 assert.ok(packets.every(packet=>packet.coreOwnerKeys.every(key=>/^[a-f0-9]{64}$/.test(key))));
 assert.equal(JSON.stringify({base,layout}),before);console.log('ok p9 readable owner anchors/global source runs retain complete source IDs, explicit excerpts and exact Host proof keys');
}
