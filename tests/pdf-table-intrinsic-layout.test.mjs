import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument,OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {load} from 'cheerio';
import {renderPdfReflowHtml} from '../src/main/pdfReflow.ts';
import {configurePdfPrintBackend,printPdfHtml} from '../src/main/pdfPrint.ts';
import {createNativePdfPrintBackend} from './helpers/pdf-print-backend.mjs';

// Sparse source columns must not reserve equal widths for empty placeholders.
// Exercise the actual renderer and hidden Chromium; inspect the printed ink,
// text line geometry and native image transforms instead of matching CSS.
const workspace=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(workspace,'.translation-workshop'),{recursive:true});
const directory=await mkdtemp(path.join(workspace,'.translation-workshop/table-intrinsic-'));
const keep=process.env.YN_PDF_TABLE_LAYOUT_KEEP==='1',legacy=process.argv.includes('--legacy-layout');
const count=36,method='CounterbalancedEstimator',columns=18;
const node=(id,type,extra={})=>({id,type,sourceLines:[1],sourcePages:[1],...extra});
const canvas=createCanvas(220,60),context=canvas.getContext('2d');
context.fillStyle='white';context.fillRect(0,0,220,60);context.fillStyle='black';context.font='48px sans-serif';context.fillText('0.987',8,46);
const native={dataUrl:canvas.toDataURL('image/png'),width:44,height:12};canvas.width=canvas.height=1;
const rows=[
 [node('table-title','paragraph',{column:0,columnSpan:columns,text:'Sparse comparison with complete native numeric values'})],
 [node('method-header','paragraph',{column:1,columnSpan:6,text:'Estimator'}),node('metric-a-header','paragraph',{column:7,columnSpan:4,text:'Metric A'}),node('metric-b-header','paragraph',{column:11,columnSpan:6,text:'Metric B'}),node('metric-c-header','paragraph',{column:17,text:'Metric C'})],
 ...Array.from({length:count},(_,index)=>[
  node('method-'+index,'paragraph',{column:1,text:`ROW_${String(index+1).padStart(3,'0')} ${method}`}),
  ...[7,11,17].map((column,metric)=>node(`value-${index}-${metric}`,'formula',{column,image:native}))
 ])
];
const document={title:'Intrinsic sparse table regression',nodes:[node('wide-table','table',{columnCount:columns,cells:rows}),node('tail','paragraph',{text:'AFTER_TABLE_END'})]};
const fontUri=pathToFileURL(path.join(workspace,'assets/fonts/NotoSansSC-Regular.ttf')).href;
let html=renderPdfReflowHtml(document,fontUri);
const $=load(html),tableRows=$('#wide-table tr');assert.equal(tableRows.length,count+2);
assert.equal(tableRows.first().find('td').attr('colspan'),String(columns),'combined title retains its complete source column span');
assert.deepEqual(tableRows.eq(1).find('td').map((_,cell)=>$(cell).attr('colspan')??'1').get(),['1','6','4','6','1']);
for(let row=2;row<tableRows.length;row++){
 const cells=tableRows.eq(row).find('td');assert.equal(cells.length,columns);assert.equal(cells.filter('.empty-cell').length,14);
 assert.ok(cells.eq(1).find('[id^="method-"]').length);for(const column of [7,11,17])assert.equal(cells.eq(column).find('img').length,1,'native values retain their actual sparse source column');
}
// Optional red probe reproduces the former layout in real Chromium. The normal
// regression always uses production HTML without overrides.
if(legacy)html=html.replace('</style>','table{table-layout:fixed}td.empty-cell{padding-inline:5pt}tr{break-inside:auto}</style>');
const source=path.join(directory,'table.html'),output=path.join(directory,'table.pdf');
let service,loader;
const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
try{
 await writeFile(source,html);service=await createNativePdfPrintBackend();configurePdfPrintBackend(service.backend);await printPdfHtml(source,output);
 loader=getDocument({data:new Uint8Array(await readFile(output)),useSystemFonts:true});const pdf=await loader.promise;
 assert.ok(pdf.numPages>=2,'complete table rows must paginate naturally across actual print pages');
 const pages=[],paints=[],margin=20*72/25.4;
 for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
  const page=await pdf.getPage(pageNumber),viewport=page.getViewport({scale:1}),items=(await page.getTextContent()).items.filter(item=>item.str?.trim());
  const operators=await page.getOperatorList(),stack=[];let matrix=[1,0,0,1,0,0];
  for(let index=0;index<operators.fnArray.length;index++){
   const operation=operators.fnArray[index],args=operators.argsArray[index];
   if(operation===OPS.save)stack.push([...matrix]);
   else if(operation===OPS.restore){assert.ok(stack.length);matrix=stack.pop();}
   else if(operation===OPS.transform)matrix=multiply(matrix,args);
   else if(operation===OPS.paintImageXObject||operation===OPS.paintInlineImageXObject){
    const corners=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]]);
    paints.push({page:pageNumber,width:Math.hypot(matrix[0],matrix[1]),height:Math.hypot(matrix[2],matrix[3]),x:Math.min(...corners.map(point=>point[0])),y:Math.min(...corners.map(point=>point[1]))});
   }
  }
  pages.push({page:pageNumber,items});
  for(const item of items)assert.ok(item.transform[4]>=margin-2&&item.transform[4]+item.width<=viewport.width-margin+2,`printed text overflows body: ${item.str}`);
  const scale=1.5,rendered=createCanvas(Math.ceil(viewport.width*scale),Math.ceil(viewport.height*scale));
  try{
   await page.render({canvas:rendered,canvasContext:rendered.getContext('2d'),viewport:page.getViewport({scale})}).promise;
   const pixels=rendered.getContext('2d').getImageData(0,0,rendered.width,rendered.height).data,left=Math.floor((margin-3)*scale),right=Math.ceil((viewport.width-margin+3)*scale);
   for(let y=0;y<rendered.height;y++)for(const [from,to]of [[0,left],[right,rendered.width]])for(let x=from;x<to;x++){
    const offset=(y*rendered.width+x)*4;assert.ok(pixels[offset+3]===0||Math.min(pixels[offset],pixels[offset+1],pixels[offset+2])>=245,`printed table ink crosses body at page ${pageNumber}, pixel ${x},${y}`);
   }
   if(keep&&(pageNumber===1||pageNumber===pdf.numPages))await writeFile(path.join(directory,`page-${pageNumber}.png`),rendered.toBuffer('image/png'));
  }finally{rendered.width=rendered.height=1;}
 }
 const items=pages.flatMap(page=>page.items),text=items.map(item=>item.str).join('');
 assert.equal(items.filter(item=>item.str.includes(method)).length,count,'every long method word stays readable on a text line instead of stacking character fragments');
 assert.ok(text.includes('Sparse comparison with complete native numeric values'));assert.ok(text.includes('AFTER_TABLE_END'));
 assert.equal(paints.length,count*3,'all three source numeric glyph images survive every table row exactly once');
 for(const image of paints){assert.ok(image.width>=40&&image.height>=10,`native numeric glyph became unreadably small: ${JSON.stringify(image)}`);assert.ok(image.x>=margin-2&&image.x+image.width<=595.28-margin+2,'native image stays inside print body');}
 const rowPages=new Set();
 for(let number=1;number<=count;number++){
  const marker='ROW_'+String(number).padStart(3,'0'),owners=pages.flatMap(page=>page.items.filter(item=>item.str.includes(marker)).map(item=>({...item,page:page.page})));
  assert.equal(owners.length,1,`table row ${marker} must occur once without loss or duplication`);const owner=owners[0];rowPages.add(owner.page);
  const images=paints.filter(image=>image.page===owner.page&&Math.abs(image.y+image.height/2-owner.transform[5])<22);
  assert.equal(images.length,3,`row ${marker} keeps its three numeric cells together on its print page`);
 }
 assert.ok(rowPages.size>=2,'whole rows flow onto later pages rather than forcing the table onto one oversized page');
 console.log(JSON.stringify({pass:true,nativeChromium:true,tableRows:count,pages:pdf.numPages,nativeImages:paints.length,minNativeWidth:Math.min(...paints.map(image=>image.width)),minNativeHeight:Math.min(...paints.map(image=>image.height)),...(keep?{evidence:directory}:{})}));
}finally{
 try{await loader?.destroy();}finally{configurePdfPrintBackend();await service?.close();if(!keep)await rm(directory,{recursive:true,force:true});}
}
