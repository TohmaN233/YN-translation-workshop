import type {PdfBox,PdfTextBlock} from './pdfTypes.ts';
export interface PdfSourceTable {page:number;captionLine:number;sourceLines:number[];headerLine?:number;box:PdfBox}
/** A formal caption and aligned parallel cells supply positive table evidence.
 * A narrow, single-row header can bridge the caption and data cells. */
export function pdfSourceTables(blocks:PdfTextBlock[]):PdfSourceTable[] {
  const tables:PdfSourceTable[]=[];
  for(let index=0;index<blocks.length;index++) {
    const caption=blocks[index];if(!/^(?:Table|表)\s*\d+\s*[:.]/iu.test(caption.text))continue;
    let end=index+1;
    // A caption may wrap across several visual primitives. Its continuation
    // is prose, not an intervening body section or a table data cell.
    while(end<blocks.length&&blocks[end].page===caption.page&&!blocks[end].protection&&blocks[end].segmentation==='paragraph'
      &&Math.abs(blocks[end].fontSize-caption.fontSize)<=.01&&Math.abs(blocks[end].x-caption.x)<caption.fontSize*2
      &&blocks[end].y>=blocks[end-1].y-caption.fontSize*.3&&blocks[end].y-blocks[end-1].y<caption.fontSize*1.8
      &&!/^\s*(?:Table|Figure|Fig\.?|\d+(?:\.\d+)*\s+\p{L})/iu.test(blocks[end].text))end++;
    const header=blocks[end];let headerLine:number|undefined;
    if(header&&header.page===caption.page&&!header.protection&&header.segmentation==='paragraph'
      &&header.x>caption.x+caption.fontSize&&blocks[end+1]?.segmentation==='parallel-region'){headerLine=header.line;end++;}
    const cells:PdfTextBlock[]=[];
    while(end<blocks.length&&blocks[end].page===caption.page) {
      const cell=blocks[end],next=blocks[end+1];
      const spanning=cells.length>1&&!cell.protection&&cell.segmentation==='paragraph'&&next?.page===caption.page
        &&(next.segmentation==='parallel-region'||next.protection==='math')&&Math.abs(next.fontSize-cell.fontSize)<=.01
        &&next.y>=cell.y-cell.fontSize*.3&&next.y-cell.y<cell.fontSize*2
        &&cell.y>=cells.at(-1)!.y-cell.fontSize*.3&&cell.y-cells.at(-1)!.y<cell.fontSize*2
        &&cell.x>=Math.min(...cells.map(row=>row.x))-cell.fontSize*.25
        &&cell.x<=Math.max(...cells.map(row=>row.x+row.width))+cell.fontSize*.25;
      if(cell.segmentation!=='parallel-region'&&cell.protection!=='math'&&!spanning)break;
      cells.push(blocks[end++]);
    }
    if(!cells.some((cell,i)=>cells.slice(i+1).some(other=>Math.abs(cell.y-other.y)<Math.max(cell.fontSize,other.fontSize)*.5&&cell.x+cell.width<other.x)))continue;
    const regions=headerLine?[header,...cells]:cells,x=Math.min(...regions.map(block=>block.x)),y=Math.min(...regions.map(block=>block.y));
    tables.push({page:caption.page,captionLine:caption.line,sourceLines:regions.map(block=>block.line),...(headerLine?{headerLine}:{}),box:{x,y,width:Math.max(...regions.map(block=>block.x+block.width))-x,height:Math.max(...regions.map(block=>block.y+block.height))-y}});
  }
  return tables;
}
