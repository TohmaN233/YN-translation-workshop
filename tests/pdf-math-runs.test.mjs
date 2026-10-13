import assert from 'node:assert/strict';
import { protectPdfText, selectPdfPaintGlyphs } from '../src/main/pdfProtection.ts';
const item = (str, x, y = 40, size = 10, fontName = 'roman') => ({ str, fontName, transform: [size,0,0,size,x,y], width: str.length*5, height: size, dir: 'ltr', hasEOL: false });
const check = items => protectPdfText({ items, styles: {} }, null, items.map((item,index) => ({operator:index,text:item.str,color:[0,0,0]})), () => '', 3);
// PDF.js separates subscripts from their variable. Adjacent single-letter
// identifiers are not evidence of natural-language prose in a norm expression.
const norm = [item('∥',20),item('f',25),item('(',30),item('τ',35),item('j',40,38.5,7),item(')',45),item('−',50),
 item('f',55),item('(',60),item('τ',65),item('j',70,38.5,7),item('−',75,38.5,7),item('1',80,38.5,7),item(')',85),item('∥',90),item('2',95,38.5,7)];
const protectedNorm = check(norm);
assert.ok(protectedNorm.items.every(item => item.protection === 'math'), 'every norm glyph, including subscripts and punctuation, must be immutable');
assert.equal(protectedNorm.retained.size, norm.length);
for (const text of ['Energy is E = mc2', 'It is x = y.', '能量为 E = mc2。']) assert.throws(() => check([item(text,20)]), /mixed with unmarked prose/);
const styledProse=[item('drawn',20),item('i',50,40,10,'mono'),item('trajectories; the second reverses the roles',60)];
assert.ok(protectPdfText({items:styledProse,styles:{}},null,styledProse.map((i,index)=>({operator:index,text:i.str,color:[0,0,0]})),id=>id==='mono'?'Courier':'Times-Roman',20).items.every(i=>!i.protection),'a monospace word must not turn neighboring prose into code');
const inline=[item('Surrounding prose',0),item('f',85,40,10,'math'),item('(',90),item('t',95,40,10,'math'),item(')',100),item(' remains translatable',110)];
const inlineProtected=protectPdfText({items:inline,styles:{}},null,inline.map((i,index)=>({operator:index,text:i.str,color:[0,0,0]})),id=>id==='math'?'Subset+CMMI10':'Subset+CMR10',3);
assert.deepEqual(inlineProtected.items.map(i=>i.protection),[undefined,'math','math','math','math',undefined],'a Roman font reused by prose must still preserve every inline formula delimiter');
const header=[item('Mean (',0),item('±',40,40,10,'math'),item('SD',50),item(')',65),item('Mean rank',100)];
const headerProtected=protectPdfText({items:header,styles:{}},null,[{operator:1,text:'Mean (',color:[0,0,0]},{operator:2,text:'±',color:[0,0,0]},{operator:3,text:'SD)Mean rank',color:[0,0,0]}],id=>id==='math'?'Subset+CMSY10':'Times-Roman',25);
assert.deepEqual(headerProtected.items.map(i=>i.protection),[undefined,'math',undefined,undefined,undefined],'a statistics acronym in prose typeface must not freeze a table header');
const accented=[item('ordinary prose',0),item('˜',75,43,10,'roman'),item('C',75,40,10,'math'),item('another prose phrase',90)];
const accentedProtected=protectPdfText({items:accented,styles:{}},null,accented.map((i,index)=>({operator:index,text:i.str,color:[0,0,0]})),id=>id==='math'?'Subset+CMMI10':'Subset+CMR10',15);
assert.deepEqual(accentedProtected.items.map(i=>i.protection),[undefined,'math','math',undefined],'an accent over a mathematical variable remains immutable when the Roman typeface also has prose');
const hat=accented.map(i=>i.str==='˜'?{...i,str:'ˆ'}:i);
assert.equal(protectPdfText({items:hat,styles:{}},null,hat.map((i,index)=>({operator:index,text:i.str,color:[0,0,0]})),id=>id==='math'?'Subset+CMMI10':'Subset+CMR10',30).items[1].protection,'math','a spacing modifier letter hat is also a mathematical accent');
assert.equal(protectPdfText({items:[item('B',20)],styles:{}},null,[{operator:1,text:'B',color:[0,0,0]}],()=> 'Subset+CMSS10',29).items[0].protection,'math','a sans-serif Computer Modern matrix symbol has the same math-only font evidence');
assert.deepEqual([...selectPdfPaintGlyphs([{unicode:'F'},{unicode:'W'},-100,{unicode:'1'},{unicode:'2'},{unicode:'0'},{unicode:'–'}], [{operator:1,start:2,end:5}],text=>text)], [3,4,5]);
assert.throws(()=>selectPdfPaintGlyphs([{unicode:'12'}],[{operator:1,start:1,end:2}],text=>text),/indivisible glyph/);
assert.throws(()=>selectPdfPaintGlyphs([{unicode:'1'}],[{operator:1,start:0,end:2}],text=>text),/incomplete/);
console.log('PDF split mathematical glyph runs retain every formula glyph without freezing mixed prose');
