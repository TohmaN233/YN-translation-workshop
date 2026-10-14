import { createHash } from "node:crypto";
import type {PdfGraphicTableOwner} from './pdfGraphicRegions.ts';
import type {PdfStructureTable} from './pdfStructurePlan.ts';
import {pdfNativePlacement} from './pdfNativePlacement.ts';
export const PDF_LAYOUT_VERSION = 5;
export const PDF_EXTRACTOR_REVISION = 15;
export interface PdfBox { x: number; y: number; width: number; height: number }
export interface PdfProseSegment { text: string; boxes: Array<PdfBox&{page?:number}> }
export interface PdfInlineProtection extends PdfBox {
  token: string; text: string; kind: 'code' | 'math'; paintOperations: number[];
  /** Actual retained glyph/path ink, including scripts and overhang. */
  inkBox?: PdfBox;
  sourcePage?:number;
  /** Native source rows represented by one Host marker within a logical sentence. */
  physicalLines?:number[];
  /** Omitted on old physical-backed nodes means display. */
  placement?:'inline'|'display';
  paintSpans?:Array<{operator:number;start:number;end:number}>;
  nativePathOperations?:number[];
}
export interface PdfTextBlock extends PdfBox {
  line: number; page: number; text: string; fontSize: number;
  color?: [number, number, number];
  protection?: "code" | "math";
  segmentation?: 'paragraph' | 'protected' | 'parallel-region';
  /** One logical paragraph, with immutable inline nodes and original prose flow areas. */
  inlineProtections?: PdfInlineProtection[];
  proseSegments?: PdfProseSegment[];
  /** Original text paint operations retained in the page background. */
  paintOperations?: number[];
  /** Actual native renderer ink envelope for unchanged numeric glyphs. */
  sourceInkBox?: PdfBox;
  sourceInkPath?: string; sourceInkHash?: string;
  /** Ordered physical source blocks; logical paragraphs may cross pages. */
  fragments?:number[];
  nativePathOperations?:number[];
  structureKind?:'paragraph'|'heading'|'caption'|'table-cell'|'preserved';
  sourceScope?:string;
  baseline?:number;columnX?:number;
}
export interface PdfReference extends PdfBox {
  id: string; page: number; caption?: string; captionLine?: number;
  kind?:'vector'; paintOperations?:number[];
}
export interface PdfFigureGroup extends PdfBox {id:string;page:number;referenceIds:string[];physicalLines:number[];captionLine?:number}
export interface PdfPageLayout {
  page: number; width: number; height: number;
  backgroundPath: string; backgroundHash: string;
  previewPath: string; previewHash: string;
  graphicOperations?:number[];
  tableRules?:PdfGraphicTableOwner[];
}
/** One UTF-8 line per logical source unit; native page geometry remains explicit. */
export interface PdfLayout {
  version: number; extractorRevision: number; originalPath: string; originalHash: string;
  sourcePath: string; sourceHash: string;
  protectionHash: string;
  pages: PdfPageLayout[]; blocks: PdfTextBlock[]; references: PdfReference[];
  physicalBlocks?:PdfTextBlock[];
  figureGroups?:PdfFigureGroup[];
  mechanicalParagraphs?:number[][];
  structureTables?:PdfStructureTable[];
  preparation?:{
    version:1; originalHash:string; mechanicalHash:string; planHash:string;
    sessionId:string; providerId:string; modelId:string; promptVersion:number;
    auditSessionId:string; auditProviderId:string; auditModelId:string; auditHash:string;
    sourceInspectionCoverage:number;auditInspectionCoverage:number;
    auditScopeCount:number;auditScopesHash:string;
    metrics:{coverage:number;duplicates:number;foreign:number;protectedUnchanged:boolean;semanticAuditAccepted:boolean;nativeCoverage:number;graphicCoverage:number;figureCoverage:number};
  };
}

export function pdfProtectionHash(layout: PdfLayout): string {
  const pin=(block:PdfTextBlock)=>({line:block.line,page:block.page,text:block.text,x:block.x,y:block.y,width:block.width,height:block.height,fontSize:block.fontSize,color:block.color,protection:block.protection,paintOperations:block.paintOperations,
    segmentation:block.segmentation,structureKind:block.structureKind,sourceScope:block.sourceScope,baseline:block.baseline,columnX:block.columnX,fragments:block.fragments,inlineProtections:block.inlineProtections,proseSegments:block.proseSegments,sourceInkBox:block.sourceInkBox,sourceInkHash:block.sourceInkHash,nativePathOperations:block.nativePathOperations});
  return createHash("sha256").update(JSON.stringify({ version: layout.version, extractorRevision: layout.extractorRevision, originalHash: layout.originalHash, sourceHash: layout.sourceHash,
    blocks:layout.blocks.map(pin),physicalBlocks:layout.physicalBlocks?.map(pin),references:layout.references,figureGroups:layout.figureGroups,mechanicalParagraphs:layout.mechanicalParagraphs,structureTables:layout.structureTables,preparation:layout.preparation,
    pages:layout.pages.map(page=>({page:page.page,width:page.width,height:page.height,previewHash:page.previewHash,backgroundHash:page.backgroundHash,graphicOperations:page.graphicOperations,tableRules:page.tableRules})) })).digest("hex");
}

/** Reject corrupt derived geometry before exposing references or replacing an export. */
export function validatePdfLayout(value: unknown): asserts value is PdfLayout {
  const layout = value as PdfLayout;
  const digest = (input: unknown) => typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
  const positive = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input > 0;
  if (!layout || layout.version !== PDF_LAYOUT_VERSION || layout.extractorRevision !== PDF_EXTRACTOR_REVISION || typeof layout.originalPath !== "string" || typeof layout.sourcePath !== "string"
    || !digest(layout.originalHash) || !digest(layout.sourceHash) || !digest(layout.protectionHash) || !Array.isArray(layout.pages) || !layout.pages.length
    || !Array.isArray(layout.blocks) || !layout.blocks.length || !Array.isArray(layout.references)) throw new Error("Invalid PDF layout binding.");
  for (const [index, page] of layout.pages.entries()) {
    if (!page || page.page !== index + 1 || !positive(page.width) || !positive(page.height)
      || typeof page.backgroundPath !== "string" || typeof page.previewPath !== "string"
      || !digest(page.backgroundHash) || !digest(page.previewHash)) throw new Error(`Invalid PDF page geometry or assets: ${index+1}.`);
  }
  const checkBox = (box: PdfBox & { page: number }) => {
    const page = layout.pages[box.page-1];
    if (!Number.isInteger(box.page) || !page || !Number.isFinite(box.x) || !Number.isFinite(box.y)
      || !positive(box.width) || !positive(box.height) || box.x < -1 || box.y < -1
      || box.x + box.width > page.width + 2 || box.y + box.height > page.height + 2) throw new Error("Invalid PDF content bounds.");
  };
  for (const [index, block] of layout.blocks.entries()) {
    if (!block || block.line !== index+1 || typeof block.text !== "string" || !block.text.trim() || /[\r\n]/.test(block.text)
      || !positive(block.fontSize) || (block.color !== undefined && (!Array.isArray(block.color) || block.color.length !== 3
        || block.color.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)))) throw new Error(`Invalid PDF text block: ${index+1}.`);
    checkBox(block);
    if ((block.baseline !== undefined && !Number.isFinite(block.baseline))
      || (block.columnX !== undefined && !Number.isFinite(block.columnX))) throw new Error(`Invalid PDF source baseline or column: ${index+1}.`);
    if(block.segmentation!==undefined&&!['paragraph','protected','parallel-region'].includes(block.segmentation))throw new Error('Invalid PDF paragraph segmentation.');
    if (block.sourceInkBox) checkBox({...block.sourceInkBox,page:block.page});
    if (!block.protection && /^\d+$/u.test(block.text) && (!block.sourceInkBox || typeof block.sourceInkPath !== "string" || !digest(block.sourceInkHash))) throw new Error("Numeric PDF text lacks native ink geometry.");
    if (block.protection !== undefined && block.protection !== "code" && block.protection !== "math") throw new Error("Invalid PDF protection kind.");
    if (block.protection !== undefined && (!Array.isArray(block.paintOperations) || !block.paintOperations.length
      || block.paintOperations.some(op => !Number.isInteger(op) || op < 0))) throw new Error("Protected PDF text lacks original paint ownership.");
    if (block.protection === undefined && block.paintOperations !== undefined) throw new Error("Unprotected PDF block claims retained text paints.");
    if (block.inlineProtections !== undefined || block.proseSegments !== undefined) {
      if (block.protection || !Array.isArray(block.inlineProtections)
        || !Array.isArray(block.proseSegments) || block.proseSegments.length !== block.inlineProtections.length+1) throw new Error('Invalid PDF paragraph inline structure.');
      const tokens=new Set<string>();
      for (const fragment of block.inlineProtections) {
        if (!fragment || !/^\{\{(?:formula|code):p\d+:\d+\}\}$/u.test(fragment.token) || tokens.has(fragment.token)
          || !fragment.text || /[\r\n]/u.test(fragment.text) || !['code','math'].includes(fragment.kind)
          || fragment.placement!==undefined&&!['inline','display'].includes(fragment.placement)
          || !Array.isArray(fragment.paintOperations) || !fragment.paintOperations.length
          || fragment.paintOperations.some(op=>!Number.isInteger(op)||op<0)) throw new Error('Invalid immutable PDF inline node.');
        const sourcePage=fragment.sourcePage??block.page;
        if(Number(fragment.token.match(/:p(\d+):/u)?.[1])!==sourcePage)throw new Error('PDF inline node source page differs from its identity.');
        tokens.add(fragment.token);checkBox({...fragment,page:sourcePage});
        if (!fragment.inkBox) throw new Error('PDF inline node lacks native ink geometry.');
        checkBox({...fragment.inkBox,page:sourcePage});
      }
      for (const segment of block.proseSegments) {
        if (!segment || typeof segment.text!=='string' || /[\r\n]/u.test(segment.text) || !Array.isArray(segment.boxes)
          || (segment.text.trim() && !segment.boxes.length)) throw new Error('Invalid PDF paragraph prose segment.');
        for (const box of segment.boxes) checkBox({...box,page:box.page??block.page});
      }
      const text=block.proseSegments.map((segment,index)=>segment.text+(block.inlineProtections![index]?.token??'')).join('');
      if (text!==block.text || !block.proseSegments.some(segment=>segment.text.trim())) throw new Error('PDF paragraph source differs from its inline structure.');
    }
  }
  if(layout.physicalBlocks) {
    if(layout.mechanicalParagraphs) {
      const owned=new Set<number>();
      for(const group of layout.mechanicalParagraphs) {
        if(!Array.isArray(group)||!group.length||new Set(group.map(line=>layout.physicalBlocks![line-1]?.page)).size!==1)throw new Error('PDF mechanical paragraph hint has invalid source ownership.');
        for(const line of group){if(!Number.isInteger(line)||!layout.physicalBlocks[line-1]||owned.has(line))throw new Error('PDF mechanical paragraph hints repeat or invent source IDs.');owned.add(line);}
      }
      if(owned.size!==layout.physicalBlocks.length)throw new Error('PDF mechanical paragraph hints omit source IDs.');
    }
    const physicalLayout={...layout,blocks:layout.physicalBlocks,physicalBlocks:undefined,references:[]};
    physicalLayout.protectionHash=pdfProtectionHash(physicalLayout);validatePdfLayout(physicalLayout);
    const ownership=new Set<number>();
    for(const block of layout.blocks) {
      if(!block.fragments?.length)throw new Error('PDF logical paragraph lacks physical source ownership.');
      for(const line of block.fragments) {
        const physical=layout.physicalBlocks[line-1];
        if(!physical||physical.line!==line||ownership.has(line))throw new Error('PDF physical source is missing or owned more than once.');
        ownership.add(line);
      }
      const ownedPages=new Set(block.fragments.map(line=>layout.physicalBlocks![line-1].page));
      if(block.inlineProtections?.some(node=>!ownedPages.has(node.sourcePage??block.page))
        ||block.proseSegments?.some(segment=>segment.boxes.some(box=>!ownedPages.has(box.page??block.page))))throw new Error('PDF paragraph geometry escaped its source fragments.');
      const fragments=block.fragments.map(line=>layout.physicalBlocks![line-1]);
      if(block.page!==fragments[0].page
        ||block.protection!==undefined&&fragments.some(source=>source.protection!==block.protection||source.page!==block.page))throw new Error('PDF logical source order or protection differs from its physical ownership.');
      if(block.protection&&JSON.stringify(block.paintOperations)!==JSON.stringify([...new Set(fragments.flatMap(source=>source.paintOperations!))]))throw new Error('PDF logical native paints differ from their physical ownership.');
      const displays=(block.inlineProtections??[]).filter(node=>node.physicalLines?.length),coveredDisplay=new Set<number>();
      for(const node of displays) {
        const owned=node.physicalLines!.map(line=>layout.physicalBlocks![line-1]);
        if(node.kind!=='math'||owned.some(source=>!source||source.protection!=='math'||source.page!==node.sourcePage||!block.fragments!.includes(source.line)||coveredDisplay.has(source.line))
          ||node.text!==owned.map(source=>source.text).join(' ')||JSON.stringify(node.paintOperations)!==JSON.stringify([...new Set(owned.flatMap(source=>source.paintOperations!))]))throw new Error('PDF display marker differs from its immutable source rows.');
        if(node.placement==='inline'&&pdfNativePlacement(layout.physicalBlocks,node.physicalLines!)!=='inline')throw new Error('PDF native inline placement lacks original source geometry.');
        node.physicalLines!.forEach(line=>coveredDisplay.add(line));
      }
      if(!block.protection&&fragments.some(source=>source.protection&&source!==fragments[0]&&!coveredDisplay.has(source.line))
        ||!block.protection&&fragments.some(source=>source.protection&&!coveredDisplay.has(source.line)))throw new Error('PDF logical prose claims immutable source without a display marker.');
      const nativePin=(node:PdfInlineProtection)=>JSON.stringify({token:node.token,text:node.text,kind:node.kind,placement:node.placement,paintOperations:node.paintOperations,paintSpans:node.paintSpans,nativePathOperations:node.nativePathOperations,x:node.x,y:node.y,width:node.width,height:node.height,inkBox:node.inkBox});
      const originalNodes=fragments.flatMap(source=>source.inlineProtections??[]),logicalNodes=(block.inlineProtections??[]).filter(node=>!node.physicalLines);
      if(originalNodes.length!==logicalNodes.length||originalNodes.some((node,index)=>nativePin(node)!==nativePin(logicalNodes[index])))throw new Error('PDF logical inline glyph differs from its physical source.');
      const originalBoxes=fragments.filter(source=>!source.protection).flatMap(source=>source.proseSegments?.flatMap(segment=>segment.boxes.map(box=>({...box,page:source.page})))??[]);
      const logicalBoxes=block.proseSegments?.flatMap(segment=>segment.boxes)??[];
      if(JSON.stringify(originalBoxes)!==JSON.stringify(logicalBoxes))throw new Error('PDF logical prose geometry differs from its physical source.');
      let expected='',lastText='';const expectedTokens:string[]=[];
      for(const fragment of fragments) {
        const display=displays.find(node=>node.physicalLines![0]===fragment.line);
        if(display){expected+=display.token;expectedTokens.push(display.token);lastText='';continue;}
        if(coveredDisplay.has(fragment.line))continue;
        const first=fragment.proseSegments?.[0].text??fragment.text;
        expected+=(!lastText||!first||/\s$/u.test(lastText)||/^\s/u.test(first)||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(lastText)||/[A-Za-z]-$/u.test(lastText)&&/^[A-Za-z]/u.test(first)?'':' ')+fragment.text;
        expectedTokens.push(...(fragment.inlineProtections?.map(node=>node.token)??[]));lastText=fragment.proseSegments?.at(-1)?.text??fragment.text;
      }
      if(expected!==block.text||JSON.stringify(expectedTokens)!==JSON.stringify(block.inlineProtections?.map(node=>node.token)??[]))throw new Error('PDF logical paragraph differs from its exact physical source.');
    }
    if(ownership.size!==layout.physicalBlocks.length)throw new Error('PDF physical source was omitted from logical paragraphs.');
  }
  const ids = new Set<string>();
  if (layout.protectionHash !== pdfProtectionHash(layout)) throw new Error("PDF protection binding changed.");
  for (const ref of layout.references) {
    if (!ref || typeof ref.id !== "string" || !ref.id || ids.has(ref.id) || (ref.caption !== undefined && typeof ref.caption !== "string")
      || (ref.captionLine !== undefined && !pdfBlockPages(layout,layout.blocks[ref.captionLine-1]).includes(ref.page))) throw new Error("Invalid PDF reference identity.");
    ids.add(ref.id); checkBox(ref);
  }
  if(layout.physicalBlocks)for(const page of layout.pages) {
    if(!Array.isArray(page.graphicOperations)||new Set(page.graphicOperations).size!==page.graphicOperations.length)throw new Error('PDF page lacks an explicit native graphic audit. Regenerate its projection.');
    const claims=new Set<number>(),physical=layout.physicalBlocks.filter(block=>block.page===page.page);
    const own=(operations:number[])=>{for(const operator of operations){if(!Number.isInteger(operator)||operator<0||claims.has(operator)||!page.graphicOperations?.includes(operator))throw new Error('PDF native graphic ownership is invalid or duplicated.');claims.add(operator);}};
    for(const block of physical){own(block.nativePathOperations??[]);for(const node of block.inlineProtections??[])own(node.nativePathOperations??[]);}
    for(const ref of layout.references.filter(ref=>ref.page===page.page&&ref.kind==='vector')){if(!ref.paintOperations?.length)throw new Error('PDF vector figure has no original paint ownership.');own(ref.paintOperations);}
    for(const table of page.tableRules??[]){checkBox({...table.box,page:page.page});if(table.captionLine!==undefined&&!physical.some(block=>block.line===table.captionLine&&/^(?:Table|表)\s*\d+\s*[:.]/iu.test(block.text))||table.sourceLines.some(line=>!physical.some(block=>block.line===line))||table.firstSourceLine!==table.sourceLines[0]||JSON.stringify(table.rows.flat())!==JSON.stringify(table.sourceLines)||!['caption-and-cells','rules-and-grid'].includes(table.evidence)||table.evidence==='rules-and-grid'&&table.horizontalRuleOperations.length<2)throw new Error('PDF table rule ownership escaped its source.');own(table.paintOperations);}
    if(claims.size!==(page.graphicOperations?.length??0))throw new Error('PDF native graphic source was omitted.');
  }
  if(layout.physicalBlocks) {
    if(!Array.isArray(layout.figureGroups))throw new Error('PDF layout lacks its source figure grouping audit.');
    const grouped=new Set<string>(),labels=new Set<number>(),groupIds=new Set<string>();
    for(const group of layout.figureGroups) {
      checkBox(group);
      if(!group.id||groupIds.has(group.id)||group.referenceIds.length<2||group.captionLine!==undefined&&!pdfBlockPages(layout,layout.blocks[group.captionLine-1]).includes(group.page))throw new Error('PDF source figure group identity is invalid.');
      groupIds.add(group.id);
      for(const id of group.referenceIds){const ref=layout.references.find(ref=>ref.id===id);if(!ref||!/^p\d+-image\d+$/u.test(id)||ref.page!==group.page||grouped.has(id))throw new Error('PDF figure image has ambiguous group ownership.');grouped.add(id);}
      for(const line of group.physicalLines){const block=layout.physicalBlocks[line-1];if(!block||block.page!==group.page||block.protection!=='math'||!/^\([a-z]\)$/u.test(block.text.trim())||labels.has(line))throw new Error('PDF figure group claimed translatable source prose.');labels.add(line);}
    }
  }
}
export function pdfBlockPages(layout:PdfLayout,block:PdfTextBlock|undefined):number[] {
  if(!block)return [];
  return [...new Set(block.fragments&&layout.physicalBlocks?block.fragments.map(line=>layout.physicalBlocks![line-1].page):[block.page])];
}
export type PdfWorkerOperation =
  | { kind: "extract"; originalPath: string; projectRoot: string; sourcePath: string; fontPath: string; visualRowsOnly?:boolean }
  | { kind: "export"; layoutPath: string; projectRoot: string; lines: string[]; outputPath: string; fontPath: string }
  | { kind: "reference"; projectRoot: string; bytes: Uint8Array; box: PdfBox; pageWidth: number; pageHeight: number };
