// A deterministic structure fixture for extraction/export tests. Production has
// no acceptance fallback; tests explicitly install this model adapter.
import {configurePdfStructurePreparation} from '../../src/main/pdfStructurePreparation.ts';
import {preparePdfDocument as prepareNativePdfDocument} from '../../src/main/pdfDocuments.ts';
import {pdfSourceTables} from '../../src/main/pdfSourceTables.ts';
const audit={readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true,issues:[]};
async function readAll(tool,signal) {
  const first=JSON.parse((await tool.execute('fixture-first',{fromLine:1,toLine:1},signal)).content[0].text);
  const rows=[];
  for(let fromLine=1;fromLine<=first.total;fromLine+=500)rows.push(...JSON.parse((await tool.execute('fixture-read',{fromLine,toLine:Math.min(first.total,fromLine+499),...(tool.name==='readPdfStructureSource'?{includeGeometry:true}:{})},signal)).content[0].text).rows);
  return rows;
}
function sourceIndex(prompt) {
  const marker=prompt.includes('Document index: ')?'Document index: ':'Index: ';
  const source=prompt.slice(prompt.indexOf(marker)+marker.length);
  return JSON.parse(source.split('\nApplied source-ID plan: ')[0]);
}
export function fixtureStructurePlan(index,rows) {
  const sources=rows.map(row=>({...row,line:row.physicalLine}));
  const ruled=index.pages.flatMap(page=>(page.tableRules??[]).map(table=>({...table,page:page.page})));
  const guessed=pdfSourceTables(sources).filter(table=>!ruled.some(rule=>rule.sourceLines.some(line=>table.sourceLines.includes(line))));
  const rawTables=[...ruled,...guessed.map(table=>({...table,rows:table.rows??table.sourceLines.reduce((groups,line)=>{
    const block=sources[line-1],last=groups.at(-1);
    if(last&&Math.abs(sources[last[0]-1].y-block.y)<block.fontSize*.5)last.push(line);else groups.push([line]);return groups;
  },[])}))];
  const tables=rawTables.map((table,tableIndex)=>{
    const complete=table.rows.reduce((best,row)=>row.length>best.length?row:best,[]).map(line=>sources[line-1]).sort((a,b)=>a.x-b.x);
    const anchors=complete.map(cell=>cell.x);
    return {id:`fixture-table-${tableIndex}`,page:table.page,columnCount:anchors.length,
      ...((table.captionPhysicalLine??table.captionLine)?{captionPhysicalLine:table.captionPhysicalLine??table.captionLine}:{}),
      rows:table.rows.map(row=>row.map(line=>{
        const cell=sources[line-1],span=row.length===1&&!cell.protection&&!/^\d+(?:\.\d+)?$/u.test(cell.text);
        const column=span?0:anchors.reduce((best,x,index)=>Math.abs(x-cell.x)<Math.abs(anchors[best]-cell.x)?index:best,0);
        return {physicalLines:[line],column,columnSpan:span?anchors.length:1};
      }))};
  });
  const tableCells=new Set(tables.flatMap(table=>table.rows.flatMap(row=>row.flatMap(cell=>cell.physicalLines))));
  const paragraphs=index.mechanicalParagraphs.map(physicalLines=>{
    const blocks=physicalLines.map(line=>sources[line-1]),first=blocks[0];
    const kind=blocks.every(block=>block.reference||block.protection||/^\d+$/u.test(block.text))?'preserved':tableCells.has(first.line)?'table-cell'
      :/^(?:Figure|Fig\.?|Table|图|表)\s*\d+\s*[:.]/iu.test(first.text)?'caption'
      :first.structureKind==='heading'||/^\s*(?:\d+(?:\.\d+)*\s+\p{L}|(?:Abstract|Appendix(?:\s+[A-Z0-9](?:[.:]\s*.*)?)?|Appendices|Acknowledgements)\s*$)/iu.test(first.text)?'heading':'paragraph';
    return {physicalLines,kind,reason:'Explicit retained mechanical fixture plan.'};
  });
  return {version:1,paragraphs,tables,audit:structuredClone(audit)};
}
export function installPdfStructureFixtureBackend() {
  configurePdfStructurePreparation(async request=>{
    request.signal?.throwIfAborted();
    const index=sourceIndex(request.prompt),isAudit=request.tools.some(tool=>tool.name==='readPdfPreparedStructure');
    if(isAudit){
      const packet=request.tools.find(tool=>tool.name==='readPdfStructureAuditScope');
      if(packet){
        const first=JSON.parse((await packet.execute('fixture-packet-first',{fromRecord:1,toRecord:1},request.signal)).content[0].text);
        for(let fromRecord=1;fromRecord<=first.total;fromRecord+=500)await packet.execute('fixture-packet-read',{fromRecord,toRecord:Math.min(first.total,fromRecord+499)},request.signal);
      }else{
        await readAll(request.tools.find(tool=>tool.name==='readPdfStructureSource'),request.signal);
        await readAll(request.tools.find(tool=>tool.name==='readPdfPreparedStructure'),request.signal);
      }
      const {issues,...checks}=audit;
      await request.tools.find(tool=>tool.name==='submitPdfStructureAudit').execute('fixture-audit',{version:1,checks,issues:[]},request.signal);
      return {sessionId:request.sessionId??'fixture-native-session',providerId:'fixture',modelId:'fixture-structure',text:'Fixture audit submitted.'};
    }
    const rows=await readAll(request.tools.find(tool=>tool.name==='readPdfStructureSource'),request.signal);
    return {sessionId:request.sessionId??'fixture-native-session',providerId:'fixture',modelId:'fixture-structure',
      text:JSON.stringify(fixtureStructurePlan(index,rows))};
  });
}
installPdfStructureFixtureBackend();
export const preparePdfDocument=(original,workspace,options={})=>prepareNativePdfDocument(original,workspace,options);
