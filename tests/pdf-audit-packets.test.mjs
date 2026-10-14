import assert from 'node:assert/strict';
import {pdfAuditPackets,pdfAuditPacketHash,pdfAuditGlobalPreparedHash,verifyPdfAuditEvidence,auditOwnerKey} from '../src/main/pdfAuditPackets.ts';

const contract={promptVersion:9,systemPrompt:'Independent current-packet audit.'};
const checks={readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true};
function fixture(count){
  const raw=Array.from({length:count},(_,index)=>({line:index+1,page:1,text:'A complete source sentence '+(index+1)+'.',x:40,y:40+index*12,width:300,height:12,fontSize:10}));
  const layout=()=>({originalHash:'a'.repeat(64),protectionHash:'b'.repeat(64),physicalBlocks:structuredClone(raw),
    blocks:raw.map(row=>({...row,fragments:[row.line],structureKind:'paragraph'})),pages:[{page:1,width:600,height:4000},{page:2,width:600,height:800}],references:[],figureGroups:[]});
  return {base:layout(),layout:layout()};
}
const passed=packets=>packets.map(packet=>({version:1,scopeId:packet.id,packetHash:pdfAuditPacketHash(packet),corePhysicalLines:[...packet.corePhysicalLines],coreOwnerKeys:[...packet.coreOwnerKeys],
  edgeKeys:[...packet.edgeKeys],relationKeys:[...packet.relationKeys],inspectedPhysicalLines:[...packet.requiredPhysicalLines],inspectedOwnerKeys:[...packet.requiredOwnerKeys],
  inspectedRecordIndices:packet.records.map((_,index)=>index),audit:{version:1,checks:{...checks},issues:[]},sessionId:'native-settled',providerId:'local-fixture',modelId:'fixture'}));
const dependencies=layout=>({hash:pdfAuditGlobalPreparedHash(layout),ownerKeys:layout.blocks.map(auditOwnerKey)});

{
  const {base,layout}=fixture(240),before=pdfAuditPackets(base,layout,contract),oldProof=passed(before);
  const changed=structuredClone(layout);
  changed.blocks[0].fragments=[1,2];changed.blocks[0].text+=' '+changed.blocks[1].text;changed.blocks.splice(1,1);
  changed.blocks.forEach((block,index)=>{block.line=index+1;});
  const after=pdfAuditPackets(base,changed,contract),unchanged=before.find(packet=>packet.kind==='local'&&packet.corePhysicalLines.includes(220));
  const current=after.find(packet=>packet.id===unchanged.id),proof=oldProof.find(item=>item.scopeId===unchanged.id);
  assert.deepEqual(current.corePhysicalLines,unchanged.corePhysicalLines);assert.deepEqual(current.requiredPhysicalLines,unchanged.requiredPhysicalLines);
  assert.deepEqual(current.requiredOwnerKeys,unchanged.requiredOwnerKeys);assert.notDeepEqual(current.requiredLogicalLines,unchanged.requiredLogicalLines,'current routing follows the early merge renumbering');
  assert.equal(pdfAuditPacketHash(current),pdfAuditPacketHash(unchanged),'an unchanged semantic packet is reusable despite shifted logical routing numbers');
  verifyPdfAuditEvidence([current],[proof],dependencies(changed));
  const aggregate=passed(after).map(item=>item.scopeId===proof.scopeId?proof:item);verifyPdfAuditEvidence(after,aggregate,dependencies(changed));
  assert.notEqual(pdfAuditPacketHash(before[0]),pdfAuditPacketHash(after[0]),'the actual merged core is invalidated');
  assert.notEqual(pdfAuditPacketHash(before.at(-1)),pdfAuditPacketHash(after.at(-1)),'the changed document owner outline is invalidated');
  assert.throws(()=>verifyPdfAuditEvidence(after,oldProof,dependencies(changed)),/packet or native identity changed/,'old evidence cannot pass a truly changed packet');
  for(const packet of after)for(const record of packet.records.filter(record=>record.record==='prepared')){
    assert.equal(record.ownerAnchor,record.physicalLines[0]);assert.equal(Object.hasOwn(record,'logicalLine'),false,'public packet uses stable physical ownership, not transient routing IDs');
  }
  console.log('ok early owner merge changes only affected packet/order proof; unchanged core/context reuse old positive owner evidence after logical renumbering');
}
{
  const {base,layout}=fixture(240),packets=pdfAuditPackets(base,layout,contract),evidence=passed(packets);
  assert.equal(packets.filter(packet=>packet.kind==='local').length,2);assert.equal(packets.at(-1).kind,'order');
  assert.deepEqual(packets.flatMap(packet=>packet.corePhysicalLines),base.physicalBlocks.map(row=>row.line));
  assert.equal(packets.flatMap(packet=>packet.edgeKeys).length,241,'every outgoing boundary plus START has an explicit responsibility');
  verifyPdfAuditEvidence(packets,evidence,dependencies(layout));
  for(const mutate of [
    rows=>rows.pop(),rows=>rows[0].corePhysicalLines.pop(),rows=>rows[0].inspectedOwnerKeys.pop(),rows=>rows.at(-1).inspectedRecordIndices.pop(),
    rows=>rows[0].edgeKeys.pop(),rows=>rows[0].relationKeys.push('unassigned'),rows=>rows[0].audit.issues.push({physicalLines:[1],message:'Unresolved defect.'}),rows=>rows[0].sessionId=''
  ]){const changed=structuredClone(evidence);mutate(changed);assert.throws(()=>verifyPdfAuditEvidence(packets,changed,dependencies(layout)),/PDF scoped audit/);}
  const changed=structuredClone(layout);changed.blocks[200].text+=' Changed neighboring evidence.';
  const next=pdfAuditPackets(base,changed,contract);
  assert.equal(next[0].id,packets[0].id);assert.notEqual(pdfAuditPacketHash(next[0]),pdfAuditPacketHash(packets[0]),'same core ID cannot reuse changed boundary context');
  assert.throws(()=>verifyPdfAuditEvidence(next,evidence,dependencies(changed)),/packet or native identity changed/);
}
{
  const {base,layout}=fixture(240),packets=pdfAuditPackets(base,layout,contract),evidence=passed(packets),extra=layout.blocks[230];
  evidence[0].extraPreparedOwnerKeys=[auditOwnerKey(extra)];evidence[0].globalPreparedHash=pdfAuditGlobalPreparedHash(layout);
  verifyPdfAuditEvidence(packets,evidence,dependencies(layout));
  const changed=structuredClone(layout);changed.blocks[230].text+=' Changed extra investigation.';
  const next=pdfAuditPackets(base,changed,contract);assert.equal(pdfAuditPacketHash(next[0]),pdfAuditPacketHash(packets[0]),'extra investigation is outside the normal packet');
  assert.throws(()=>verifyPdfAuditEvidence(next,evidence,dependencies(changed)),/additional investigation changed/);
  delete evidence[0].globalPreparedHash;assert.throws(()=>verifyPdfAuditEvidence(packets,evidence,dependencies(layout)),/additional investigation changed/);
}
{
  const {base,layout}=fixture(2);
  for(const candidate of [base,layout])candidate.references=[{id:'p2-image1',page:2,x:30,y:30,width:400,height:200}];
  const packets=pdfAuditPackets(base,layout,contract),packet=packets[0];
  assert.equal(packet.kind,'local');assert.ok(packet.relationKeys.some(key=>key.startsWith('image:')));
  const relation=packet.records.find(row=>row.record==='relationship');assert.ok(relation,'an otherwise textless image page has an explicit required evidence record');
  assert.ok(relation.evidence.figureIndex.references.some(ref=>ref.id==='p2-image1'));assert.ok(relation.pages.some(page=>page.page===2));
  const evidence=passed(packets);evidence[0].inspectedRecordIndices.pop();assert.throws(()=>verifyPdfAuditEvidence(packets,evidence,dependencies(layout)),/inspected packet records/);
}
{
  const {base,layout}=fixture(240),findings=[{physicalLines:[199,200,201],message:'Inspect the actual boundary.'},{physicalLines:[],message:'Inspect section order.'}];
  const packets=pdfAuditPackets(base,layout,{...contract,geometryFindings:findings});
  assert.ok(packets[0].metadata.geometryFindings.some(finding=>finding.message===findings[0].message));
  assert.ok(packets.at(-1).metadata.geometryFindings.some(finding=>finding.message===findings[1].message));
  const next=pdfAuditPackets(base,layout,{...contract,geometryFindings:[{...findings[0],message:'Different source clue.'},findings[1]]});
  assert.notEqual(pdfAuditPacketHash(next[0]),pdfAuditPacketHash(packets[0]),'soft findings are visible and bind the actual packet without becoming hard semantic rejection');
}
console.log('ok scoped audit seals exact owners, boundaries, current context, legal additional investigation and visible image-page evidence');
