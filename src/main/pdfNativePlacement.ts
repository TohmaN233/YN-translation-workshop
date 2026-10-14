import type {PdfTextBlock} from './pdfTypes.ts';
import {pdfSourceVisibleText} from './pdfSourceVisibleText.ts';

export type PdfNativePlacement='inline'|'display';
export interface PdfNativePlacementEvidence {placement:PdfNativePlacement;continuationPhysicalLine?:number}
const sameScope=(a:PdfTextBlock,b:PdfTextBlock)=>a.sourceScope===b.sourceScope;
const right=(box:PdfTextBlock)=>box.x+box.width;

/** Infer presentation from original visual rows, never from translated text or
 * a reordered logical owner. Unknown geometry retains display presentation. */
export function pdfNativePlacementEvidence(physical:readonly PdfTextBlock[],physicalLines:readonly number[]):PdfNativePlacementEvidence {
  const display:PdfNativePlacementEvidence={placement:'display'};
  if(!physicalLines.length||new Set(physicalLines).size!==physicalLines.length)throw Error('PDF native placement requires distinct source IDs.');
  const rows=physicalLines.map(id=>physical[id-1]);
  if(rows.some((row,index)=>!row||row.line!==physicalLines[index]||row.protection!=='math'))throw Error(`PDF native placement has unknown or non-math source IDs ${physicalLines.join(',')}.`);
  if(rows.some((row,index)=>row.page!==rows[0].page||index>0&&row.line!==rows[index-1].line+1))return display;
  const left=physical[physicalLines[0]-2],after=physical[physicalLines.at(-1)!];
  if(!left||left.protection||!left.proseSegments||left.page!==rows[0].page||!Number.isFinite(left.baseline))return display;
  const size=left.fontSize;
  if(rows.some(row=>!sameScope(left,row)||Math.abs(row.fontSize-size)>.01))return display;
  const x=Math.min(...rows.map(row=>row.x)),end=Math.max(...rows.map(right));
  const y=Math.min(...rows.map(row=>row.y)),bottom=Math.max(...rows.map(row=>row.y+row.height));
  const baseline=left.baseline!;
  // Tall fractions have a script baseline of their own. Two neighboring prose
  // baselines and the fraction's full nominal glyph box establish the line.
  if(after&&!after.protection&&after.proseSegments&&after.page===left.page&&sameScope(left,after)&&Math.abs(after.fontSize-size)<=.01
    &&Number.isFinite(after.baseline)&&Math.abs(after.baseline!-baseline)<=size*.15
    &&x>=right(left)-size*.15&&x-right(left)<=size&&after.x>=end-size*.15&&after.x-end<=size
    &&y<=baseline+size*.15&&bottom>=baseline-size*.15&&bottom-y<=size*3
    &&rows.every((row,index)=>!index||row.x-right(rows[index-1])<=size))return {placement:'inline',continuationPhysicalLine:after.line};

  // A formula-only wrapped tail starts at the established body column, one
  // normal source leading below a full unfinished prose line. A short lead-in
  // or centered equation does not supply this evidence.
  if(rows.length!==1||!Number.isFinite(rows[0].baseline)||!Number.isFinite(left.columnX)||!Number.isFinite(rows[0].columnX)
    ||Math.abs(rows[0].columnX!-left.columnX!)>size*.5||Math.abs(x-left.columnX!)>size*.6
    ||/[.!?。！？]["'”’)]*$/u.test(pdfSourceVisibleText(left).trim()))return display;
  const column=physical.filter(row=>row.page===left.page&&!row.protection&&row.proseSegments&&sameScope(left,row)
    &&Math.abs(row.fontSize-size)<=.01&&Number.isFinite(row.baseline)&&Number.isFinite(row.columnX)&&Math.abs(row.columnX!-left.columnX!)<=size*.5);
  const baselines=[...new Set(column.map(row=>row.baseline!))].sort((a,b)=>a-b),leadings=baselines.slice(1).map((value,index)=>value-baselines[index]).filter(value=>value>=size&&value<=size*2.2).sort((a,b)=>a-b);
  if(!leadings.length)return display;
  const leading=leadings[Math.floor(leadings.length/2)],advance=rows[0].baseline!-baseline,columnRight=Math.max(...column.map(right));
  if(Math.abs(advance-leading)<=size*.25&&bottom-y<=leading+size*.25&&right(left)+(end-x)>columnRight+size*.2)return {placement:'inline'};
  return display;
}

export function pdfNativePlacement(physical:readonly PdfTextBlock[],physicalLines:readonly number[]):PdfNativePlacement {
  return pdfNativePlacementEvidence(physical,physicalLines).placement;
}
