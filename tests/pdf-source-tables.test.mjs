import assert from 'node:assert/strict';
import {pdfSourceTables} from '../src/main/pdfSourceTables.ts';
import {fixtureStructurePlan} from './helpers/pdf-structure-backend.mjs';
const row=(line,text,x,y,width=60,segmentation='parallel-region')=>({line,text,x,y,width,height:13,fontSize:10,page:1,segmentation});
const source=[row(1,'Table 1: A complete caption starts',40,40,400,'paragraph'),row(2,'and continues on the next visual line.',40,54,370,'paragraph'),
  row(3,'Method',80,80),row(4,'Value',180,80),row(5,'Protocol A: a source spanning label',80,94,170,'paragraph'),
  row(6,'First',80,110),row(7,'0.75',180,110),row(8,'Second',80,126),row(9,'0.50',180,126),
  row(10,'Body after the table.',40,156,200,'paragraph')];
const table=pdfSourceTables(source);
assert.equal(table.length,1);
assert.deepEqual(table[0].sourceLines,[3,4,5,6,7,8,9]);
assert.equal(table[0].captionLine,1);
assert.ok(!table[0].sourceLines.includes(2),'Caption continuation stays outside table data ownership.');
assert.equal(pdfSourceTables(source.map(block=>block.line===1?{...block,text:'Algorithm 1: steps'}:block)).length,0,
  'A rule frame or algorithm caption is not a formal semantic table declaration.');
assert.equal(pdfSourceTables(source.map(block=>block.line===1?{...block,y:500}:block)).length,0,
  'Paint order alone cannot bridge a caption to unrelated earlier page content.');
const outside=source.map(block=>block.line===5?{...block,x:300,y:500}:block);
assert.deepEqual(pdfSourceTables(outside)[0].sourceLines,[3,4],
  'A distant body region does not become a spanning row of an unrelated table candidate.');
console.log('Multi-line table captions, independent headers, spanning rows and body boundaries PASS.');
const plan=fixtureStructurePlan({pages:[{page:1,tableRules:[{sourceLines:[3,4,5,6,7,8,9],rows:[[3,4],[5],[6,7],[8,9]],captionPhysicalLine:1}]}],mechanicalParagraphs:[[1,2],...[3,4,5,6,7,8,9,10].map(line=>[line])]},source.map(block=>({...block,physicalLine:block.line})));
assert.equal(plan.tables[0].captionPhysicalLine,1,'native fixture preserves the explicit physical caption identity from current inspection metadata');
