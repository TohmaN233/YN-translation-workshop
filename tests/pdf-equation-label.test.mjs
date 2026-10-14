import assert from 'node:assert/strict';
import {protectPdfText} from '../src/main/pdfProtection.ts';
const item=(str,x,y,fontName='text')=>({str,fontName,transform:[11,0,0,11,x,y],width:str.length*5,height:11,dir:'ltr',hasEOL:true});
const content=items=>({items,styles:{text:{fontFamily:'serif'},math:{fontFamily:'math'}}});
const protect=items=>protectPdfText(content(items),null,items.map((value,index)=>({text:value.str,color:[0,0,0],operator:index})),font=>font==='math'?'CMMI10':'Times',1);
const margin={...item('This ordinary body row establishes the prose right margin.',40,500),width:485};
const display=protect([item('x = y',200,640,'math'),item('(1)',510,640),margin]);
assert.equal(display.items[1].protection,'math','a detached equation number on a math-only baseline belongs to its native formula');
assert.ok(display.retained.has(1));
const explained=protect([item('(integral CBD)',40,640),item('x = y',200,640,'math'),item('(1)',510,640),margin]);
assert.equal(explained.items[0].protection,undefined,'mathematical display descriptions remain translatable');
assert.equal(explained.items[2].protection,'math');
for(const items of [
 [item('(1)',510,640)],
 [item('x = y',200,640,'math'),item('(1)',510,610)],
 [item('The value',40,640),item('x = y',200,640,'math'),item('in theorem',240,640),item('(1)',510,640)],
 [item('x = y',200,640,'math'),item('(1)',510,640),item('is discussed here.',550,640)],
 [item('const x = 1;',200,640),item('(1)',510,640)],
 [item('(1)',40,640),item('This is an ordinary list item.',70,640)]
])assert.equal(protect([...items,margin]).items.find(value=>value.str==='(1)').protection,undefined,'ordinary labels cannot be frozen by spelling or a nearby unrelated formula');
assert.equal(protect([item('x = y',200,640,'math'),{...item('(1)',510,640),paragraphScope:'TD:1'},margin]).items[1].protection,undefined,'an authoritative table cell is not an equation label');
assert.equal(protect([item('x = y',200,640,'math'),item('(1)',510,640)]).items[1].protection,undefined,'absent source margin evidence does not grant protected ownership');
console.log('Detached display equation labels use baseline ownership, ordinary list/table/prose labels remain writable');
