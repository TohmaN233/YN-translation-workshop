import assert from 'node:assert/strict';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfOutlinedText } from '../src/main/pdfOutlinedText.ts';
import { markPdfCodePanels, protectPdfText } from '../src/main/pdfProtection.ts';

const emptyFont={isType3Font:true,charProcOperatorList:new Map([['C1',{fnArray:[OPS.setCharWidthAndBounds]}]])};
const glyph={unicode:'x',operatorListId:'C1'};
function fixture({differentMatrix=false,mixed=false,interveningImage=false}={}) {
  const fnArray=[],argsArray=[];
  const add=(op,args=null)=>{fnArray.push(op);argsArray.push(args);return fnArray.length-1;};
  add(OPS.save);add(OPS.transform,[1,0,0,1,20,40]);
  const path=add(OPS.constructPath,[OPS.fill,[new Float32Array([0,0,0,1,10,20,4])],[0,0,10,20]]);
  add(OPS.restore);
  if(interveningImage)add(OPS.paintImageXObject,['image',10,10]);
  add(OPS.save);add(OPS.transform,[1,0,0,1,differentMatrix?21:20,40]);add(OPS.setFont,['f',10]);
  const text=add(OPS.showText,[[glyph]]);
  if(mixed)add(OPS.showText,[[{...glyph,unicode:'y'}]]);
  add(OPS.restore);
  return {ops:{fnArray,argsArray},path,text};
}
const plain=fixture();
const geometry=(ops,x=20,y=40)=>[{transform:[20,0,0,20,x,y],width:10,paintOperations:ops.fnArray.flatMap((op,index)=>op===OPS.showText?[index]:[])}];
const outlined=(f,retained=new Set(),font=emptyFont,items=geometry(f.ops))=>pdfOutlinedText(f.ops,OPS,()=>font,retained,1,items);
assert.deepEqual([...outlined(plain).hidden],[plain.path]);
assert.deepEqual([...outlined(plain,new Set([plain.text])).hidden],[]);
assert.deepEqual([...outlined(plain,new Set([plain.text])).paired],[plain.path]);
assert.throws(()=>outlined(plain,new Set(),emptyFont,geometry(plain.ops,500,500)),/outside.*glyph region/,'identical CTM and adjacent drawing do not own text elsewhere');
for(const options of [{differentMatrix:true},{interveningImage:true}]) {
  assert.throws(()=>outlined(fixture(options)),/no unambiguous/);
}
const mixed=fixture({mixed:true});
assert.throws(()=>outlined(mixed,new Set([mixed.text])),/mix protected/);
const ordinary={...emptyFont,isType3Font:false};
assert.equal(outlined(plain,new Set(),ordinary).paired.size,0);
const painted={...emptyFont,charProcOperatorList:new Map([['C1',{fnArray:[OPS.constructPath]}]])};
assert.equal(outlined(plain,new Set(),painted).paired.size,0);
assert.throws(()=>pdfOutlinedText({fnArray:[OPS.setFont,OPS.showText],argsArray:[['f',10],[[glyph]]]},OPS,()=>emptyFont,new Set(),1,[]),/no unambiguous/);

const item=(str,x,y,size=10)=>({str,transform:[size,0,0,size,x,200-y-size],width:str.length*5,fontName:'f',dir:'ltr',hasEOL:true});
const content={items:[item('Python',20,10,12),item('1',20,35),item('agent = Agent(',45,35),
  item('2',20,57),item('name=',45,57),item('Triage Agent"',70,57), // even erroneous code is immutable
  item('3',20,79),item(')',45,79),item('Translate this explanation.',20,140)],styles:{}};
const marked=markPdfCodePanels(content,[{x:10,y:0,width:180,height:110}],[1,0,0,-1,0,200]);
assert.ok(marked.slice(0,-1).every(entry=>entry.protection==='code'));
assert.equal(marked.at(-1).protection,undefined);
const continuation={items:[item('24',20,10),item(')',45,10),item('25',20,32),item('msg=',45,42),
  item('input(',65,42),item('"Translate this"',100,42),item(')',175,42),item('26',20,54),item(')',45,54),item('Body prose',20,140)]};
const continued=markPdfCodePanels(continuation,[{x:10,y:0,width:180,height:110}],[1,0,0,-1,0,200]);
assert.ok(continued.slice(0,-1).every(entry=>entry.protection==='code'),'different baseline offsets in outlined text must not lose code ownership');
assert.equal(continued.at(-1).protection,undefined);
const list={items:[item('1',20,10),item('First prose sentence.',45,10),item('2',20,32),item('Second prose sentence.',45,32),item('3',20,54),item('Third prose sentence.',45,54)]};
assert.ok(markPdfCodePanels(list,[{x:10,y:0,width:180,height:110}],[1,0,0,-1,0,200]).every(entry=>!entry.protection));
const mixedNumbered={items:[item('Python',20,10,12),item('1',20,35),item('agent=Agent()',45,35),
  item('2',20,57),item('Translate this explanation.',45,57),item('3',20,79),item('Another prose sentence.',45,79)]};
assert.throws(()=>markPdfCodePanels(mixedNumbered,[{x:10,y:0,width:190,height:110}],[1,0,0,-1,0,200]),/unmarked prose/);
for(const prose of ['Translate this explanation','Hello world.','翻译这里的说明。']) {
  const negative={items:mixedNumbered.items.map(entry=>entry.str==='Translate this explanation.'?{...entry,str:prose}:entry)};
  assert.throws(()=>markPdfCodePanels(negative,[{x:10,y:0,width:190,height:110}],[1,0,0,-1,0,200]),/unmarked prose/);
}
const mixedPanel={items:[item('Python',20,10,12),item('agent = Agent()',20,35),item('Translate this explanation.',20,57)]};
assert.ok(markPdfCodePanels(mixedPanel,[{x:10,y:0,width:180,height:110}],[1,0,0,-1,0,200]).every(entry=>!entry.protection));
const paints=marked.map((entry,index)=>({operator:index,text:entry.str,color:[0,0,0]}));
assert.equal(protectPdfText({...content,items:marked},null,paints,()=>'',1).retained.size,marked.length-1);
console.log('Outlined glyph ownership, numbered code panels, continued baselines and prose boundaries passed');
