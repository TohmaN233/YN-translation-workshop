import { parentPort, workerData } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {pathToFileURL} from 'node:url';
import path from "node:path";
import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import fontkit from "@pdf-lib/fontkit";
import { pdfTextBlocks, pdfParagraphStructure, intersects, type PdfSegmentationDecision } from "./pdfLayout.ts";
import { pdfInlineTokens, splitPdfInlineTranslation } from "../shared/validation/pdfPreservation.ts";
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {makePdfLogicalDocument} from './pdfLogicalDocument.ts';
import {buildPdfReflowDocument} from './pdfReflowDocument.ts';
import {renderPdfReflowHtml,type PdfReflowImage} from './pdfReflow.ts';
import {classifyPdfGraphicRegions} from './pdfGraphicRegions.ts';
import {pdfSourceTables} from './pdfSourceTables.ts';
import {discoverPdfFigureGroups} from './pdfFigureGroups.ts';
import { markPdfCodePanels, protectPdfText, selectPdfPaintGlyphs, type PdfTextPaint } from "./pdfProtection.ts";
import { pdfOutlinedText } from "./pdfOutlinedText.ts";
import { encodePdfPng } from "./pdfPng.ts";
import { decodeProjectPaths, encodeProjectPaths } from "./projectPaths.ts";
import { PDF_LAYOUT_VERSION, PDF_EXTRACTOR_REVISION, pdfProtectionHash, validatePdfLayout, type PdfBox, type PdfLayout, type PdfReference, type PdfWorkerOperation } from "./pdfTypes.ts";
const unionBox=(a:PdfBox,b:PdfBox):PdfBox=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.max(a.x+a.width,b.x+b.width)-Math.min(a.x,b.x),height:Math.max(a.y+a.height,b.y+b.height)-Math.min(a.y,b.y)});

const cancellation=new AbortController(),cancellers=new Set<()=>void>(),cleanupFailures:unknown[]=[];
const checkCancelled=()=>cancellation.signal.throwIfAborted();
const errorDetails=(error:unknown):string=>error instanceof AggregateError
  ? `${error.message}: ${error.errors.map(errorDetails).join('; ')}`
  : error instanceof Error?error.message:String(error);
async function cleanup(description:string,action:()=>Promise<unknown>) {
  try {await action();}
  catch(error){cleanupFailures.push(new Error(`${description}: ${errorDetails(error)}`,{cause:error}));}
}
const cancelWorker=(message:any)=>{
  if(message?.type!=='cancel'||cancellation.signal.aborted)return;
  cancellation.abort(new Error('PDF operation cancelled.'));
  for(const cancel of [...cancellers])try{cancel();}catch(error){cleanupFailures.push(error);}
};
parentPort?.on('message',cancelWorker);

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const input = workerData as PdfWorkerOperation;
const progress = (page: number, total: number) => {checkCancelled();parentPort?.postMessage({ type: "progress", page, total });};

async function renderPdfPage(page:any,options:{operationsFilter?:(index:number,list:any)=>boolean;[key:string]:any}) {
  checkCancelled();
  const task=page.render(options),cancel=()=>task.cancel();cancellers.add(cancel);
  try {await task.promise;checkCancelled();}
  finally {cancellers.delete(cancel);}
}

async function atomic(file: string, bytes: string | Uint8Array) {
  checkCancelled();
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(temp, bytes,{signal:cancellation.signal});checkCancelled();await rename(temp, file); }
  finally { await cleanup(`PDF temporary file cleanup failed for ${temp}`,()=>rm(temp, { force: true })); }
}

async function openPdf(file: string) {
  checkCancelled();
  const bytes = await readFile(file,{signal:cancellation.signal});
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes),
    cMapUrl: path.join(pdfjsRoot, "cmaps").replace(/\\/g, "/") + "/",
    standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts").replace(/\\/g, "/") + "/",
    wasmUrl: path.join(pdfjsRoot, "wasm").replace(/\\/g, "/") + "/", useSystemFonts: false,
    stopAtErrors: true, fontExtraProperties: true });
  let destruction:Promise<void>|undefined;
  // Let text/operator reads finish before destroying the loader. Destroying
  // its transport during a fake-worker stream read can deadlock PDF.js.
  // Render tasks are cancelled directly; file reads use the AbortSignal.
  const destroy=()=>destruction??=cleanup(`PDF loader cleanup failed for ${file}`,()=>loading.destroy());
  try {const pdf=await loading.promise;checkCancelled();return {pdf,hash:digest(bytes),destroy};}
  catch(error){await destroy();throw error;}
}

function imageReferences(ops: { fnArray: number[]; argsArray: any[] }, viewport: any, page: number): { images: PdfReference[]; areas: PdfBox[]; imagePaints:Array<{operator:number;id?:string}> } {
  const result: PdfReference[] = [], areas: Array<{x:number;y:number;width:number;height:number}> = [],imagePaints:Array<{operator:number;id?:string}>=[];
  const stack: Array<{ matrix: number[]; clip: number[] | undefined }> = [];
  let matrix = [...viewport.transform];
  let visibleClip: number[] | undefined = [0, 0, viewport.width, viewport.height];
  let pendingClip = false;
  const apply = (m: number[], n: number[]) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
  const bounds = (box: ArrayLike<number>) => {
    const points = [[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]]
      .map(([x,y]) => [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]]);
    return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),
      Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  };
  const intersect = (a: number[] | undefined, b: number[]) => {
    if (!a) return undefined;
    const result = [Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];
    return result[2]>result[0] && result[3]>result[1] ? result : undefined;
  };
  const save = () => stack.push({ matrix: [...matrix], clip: visibleClip?.slice() });
  const restore = () => {
    const state = stack.pop();
    if (!state) throw new Error(`PDF page ${page}: image graphics state is unbalanced.`);
    matrix = state.matrix; visibleClip = state.clip;
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    if (op === pdfjs.OPS.save) save();
    else if (op === pdfjs.OPS.restore || op === pdfjs.OPS.paintFormXObjectEnd) restore();
    else if (op === pdfjs.OPS.paintFormXObjectBegin) {
      save();
      if (args[0]) matrix = apply(matrix,args[0]);
      if (args[1]) visibleClip = intersect(visibleClip,bounds(args[1]));
    }
    else if (op === pdfjs.OPS.transform) matrix = apply(matrix, args);
    else if (op === pdfjs.OPS.clip || op === pdfjs.OPS.eoClip) pendingClip = true;
    else if (op === pdfjs.OPS.constructPath) {
      // PDF.js consumes the pending clip with the next path paint/end operation.
      // Its path bounds are a conservative envelope for nonrectangular clips.
      if(pendingClip) {
        visibleClip = args[2] ? intersect(visibleClip,bounds(args[2])) : undefined;
        pendingClip = false;
      }
      if(args[2] && [pdfjs.OPS.fill,pdfjs.OPS.eoFill,pdfjs.OPS.fillStroke,pdfjs.OPS.eoFillStroke,pdfjs.OPS.closeFillStroke,pdfjs.OPS.closeEOFillStroke].includes(args[0])) {
        const box=intersect(visibleClip,bounds(args[2]));
        if(box)areas.push({x:box[0],y:box[1],width:box[2]-box[0],height:box[3]-box[1]});
      }
    }
    else if (op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject) {
      const paint:{operator:number;id?:string}={operator:i};imagePaints.push(paint);
      const visible = intersect(visibleClip,bounds([0,0,1,1]));
      if (!visible) continue;
      const [x,y] = visible, width = visible[2]-x, height = visible[3]-y;
      if (width > 0 && height > 0) {paint.id=`p${page}-image${result.length+1}`;result.push({ id:paint.id, page, x, y, width, height });}
    }
  }
  return { images: result, areas,imagePaints };
}

function textColors(ops: { fnArray: number[]; argsArray: any[] }) {
  let color: [number, number, number] = [0,0,0];
  const stack: typeof color[] = [], paints: PdfTextPaint[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    if (op === pdfjs.OPS.save) stack.push([...color]);
    else if (op === pdfjs.OPS.restore) color = stack.pop() ?? [0,0,0];
    else if (op === pdfjs.OPS.setFillRGBColor && /^#[\da-f]{6}$/i.test(args[0])) color = [1,3,5].map(offset => parseInt(args[0].slice(offset,offset+2),16)/255) as typeof color;
    else if (op === pdfjs.OPS.setTextRenderingMode && args[0] === 3) throw new Error("PDF contains hidden OCR text. Remove the scanned text image or convert it to a native text PDF before translation.");
    else if (op === pdfjs.OPS.setTextRenderingMode && args[0] >= 4) throw new Error("PDF uses text as a clipping mask; this layout cannot be reconstructed safely.");
    else if (op === pdfjs.OPS.showText || op === pdfjs.OPS.showSpacedText) {
      paints.push({ text: pdfjs.normalizeUnicode(args[0].filter((glyph: any) => typeof glyph === "object").map((glyph: any) => glyph.unicode ?? "").join("")), color: [...color], operator: i });
    }
  }
  return paints;
}

async function extract() {
  if (input.kind !== "extract") throw new Error("Invalid PDF extraction operation.");
  const { pdf, hash, destroy } = await openPdf(input.originalPath);
  const directory = path.join(path.dirname(input.sourcePath), `pdf-${hash.slice(0, 16)}-v${PDF_LAYOUT_VERSION}-e${PDF_EXTRACTOR_REVISION}`);
  await mkdir(directory, { recursive: true });
  const layout: PdfLayout = { version: PDF_LAYOUT_VERSION, extractorRevision: PDF_EXTRACTOR_REVISION, originalPath: input.originalPath, originalHash: hash,
    sourcePath: input.sourcePath, sourceHash: "", protectionHash: "", blocks: [], pages: [], references: [] };
  const segmentationPages:Array<{page:number;blocks:number;decisions:Array<PdfSegmentationDecision&{line:number}>}>=[];
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: true });
      const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
      const structTree=await page.getStructTree();
      const paints = textColors(ops);
      const unsupportedPaints=new Map(Object.entries(pdfjs.OPS).filter(([name])=>['shadingFill','paintXObject','rawFillPath','stroke','closeStroke','fill','eoFill','fillStroke','eoFillStroke','closeFillStroke','closeEOFillStroke'].includes(name)||/^paint.*Image/u.test(name)&&!['paintImageXObject','paintInlineImageXObject'].includes(name)).map(([name,code])=>[code,name]));
      for(const [operator,code] of ops.fnArray.entries())if(unsupportedPaints.has(code))throw new Error(`PDF page ${number}: unsupported source graphic ${unsupportedPaints.get(code)} at operator ${operator}; this content cannot be safely assigned for reflow.`);
      const {images,areas}=imageReferences(ops,viewport,number);
      const structuredContent=pdfParagraphStructure(content,structTree);
      const protectedText = protectPdfText({...structuredContent,items:markPdfCodePanels(structuredContent,areas,viewport.transform)}, structTree, paints,
        id => page.commonObjs.has(id) ? String(page.commonObjs.get(id).name ?? "") : "", number);
      const outlined=pdfOutlinedText(ops,pdfjs.OPS,id=>page.commonObjs.get(id),protectedText.retained,number,protectedText.items);
      const decisions:Array<PdfSegmentationDecision&{line:number}>=[],offset=layout.blocks.length;
      const blocks = pdfTextBlocks(protectedText.items, viewport, number,decision=>decisions.push({...decision,line:offset+decision.paragraph}),{visualRowsOnly:input.visualRowsOnly});
      if(input.visualRowsOnly) {
        const groups=new Map<number,number[]>();
        pdfTextBlocks(protectedText.items,viewport,number,decision=>{
          const ids=groups.get(decision.paragraph)??[];ids.push(offset+decision.visualRow);groups.set(decision.paragraph,ids);
        });
        layout.mechanicalParagraphs??=[];layout.mechanicalParagraphs.push(...groups.values());
      }
      segmentationPages.push({page:number,blocks:blocks.length,decisions});
      if (!blocks.length && images.some(image => image.width*image.height > viewport.width*viewport.height*0.65)) {
        throw new Error(`PDF page ${number} appears to be scanned and has no text layer. OCR is required before translation.`);
      }
      if (images.some(image => image.width*image.height > viewport.width*viewport.height*0.65
        && blocks.some(block => block.x < image.x+image.width && block.x+block.width > image.x && block.y < image.y+image.height && block.y+block.height > image.y))) {
        throw new Error(`PDF page ${number} has text over a full-page raster image. Its original text cannot be removed safely; use a native text PDF instead.`);
      }
      blocks.forEach(block => { block.line = layout.blocks.length + 1; layout.blocks.push(block); });
      const captions = blocks.filter(block => /^(?:Fig(?:ure)?\.?|Table|図|图|表)\s*[\d一二三四五六七八九十]/iu.test(block.text));
      for (const image of images) {
        const caption = captions.map(block => ({ block, distance: Math.abs(block.y - image.y - image.height) }))
          .filter(item => item.distance < 100).sort((a,b) => a.distance-b.distance)[0]?.block;
        if (caption) { image.caption = caption.text; image.captionLine = caption.line; }
      }
      layout.references.push(...captions.filter(caption => !images.some(image => image.captionLine === caption.line)).map(caption => ({
        id: `p${number}-caption${caption.line}`, page: number, x: 0, y: 0, width: viewport.width, height: viewport.height,
        caption: caption.text, captionLine: caption.line
      })));
      layout.references.push(...images, { id: `p${number}-page`, page: number, x: 0, y: 0, width: viewport.width, height: viewport.height,
        caption: "Page layout / vector figures and tables" });
      const scale = Math.min(2, 3000 / Math.max(viewport.width, viewport.height));
      const renderedViewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(renderedViewport.width), Math.ceil(renderedViewport.height));
      const renderedPaints: Array<{ index: number; text: string }> = [];
      const renderedPaths:Array<{index:number;bounds:string}>=[];
      await renderPdfPage(page,{ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport: renderedViewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE, recordOperations:true,
        operationsFilter: (index, list) => {
          if (list.fnArray[index] === pdfjs.OPS.showText || list.fnArray[index] === pdfjs.OPS.showSpacedText) {
            renderedPaints.push({ index, text: pdfjs.normalizeUnicode(list.argsArray[index][0].filter((glyph: any) => typeof glyph === "object").map((glyph: any) => glyph.unicode ?? "").join("")) });
          }
          if(list.fnArray[index]===pdfjs.OPS.constructPath && list.argsArray[index][2])renderedPaths.push({index,bounds:JSON.stringify(Array.from(list.argsArray[index][2]))});
          return true;
        } });
      const preview = encodePdfPng(canvas);
      const previewPath = path.join(directory, `page-${number}.png`);
      await atomic(previewPath, preview);
      const textPaint = new Set([pdfjs.OPS.showText, pdfjs.OPS.showSpacedText, pdfjs.OPS.nextLineShowText, pdfjs.OPS.nextLineSetSpacingShowText]);
      // Execute the full text stream so preceding prose still advances the cursor.
      // Hide only prose glyph painting; skipping showText would shift later formulas.
      if ((protectedText.retained.size || blocks.some(block => !block.protection && /^\d+$/u.test(block.text)))
        && (renderedPaints.length !== paints.length || paints.some((paint, index) => paint.text !== renderedPaints[index].text))) {
        throw new Error(`PDF page ${number}: rendered glyph ownership differs from extraction; protected export is unsafe.`);
      }
      const retainedRenderOps = new Set(paints.flatMap((paint, index) => protectedText.retained.has(paint.operator) ? [renderedPaints[index].index] : []));
      const originalPaths=ops.fnArray.flatMap((op,index)=>op===pdfjs.OPS.constructPath && ops.argsArray[index][2]?[{index,bounds:JSON.stringify(Array.from(ops.argsArray[index][2]))}]:[]);
      if(outlined.paired.size && (originalPaths.length!==renderedPaths.length || originalPaths.some((entry,index)=>entry.bounds!==renderedPaths[index].bounds))) {
        throw new Error(`PDF page ${number}: rendered outline ownership differs from extraction; safe export is unavailable.`);
      }
      const fonts = [...new Set(protectedText.items.map(item => page.commonObjs.get(item.fontName)))];
      if ((protectedText.retained.size || blocks.some(block=>/^\d+$/u.test(block.text))) && fonts.some(font => font.isInvalidPDFjsFont)) {
        throw new Error(`PDF page ${number}: protected content uses an unsupported glyph painter; safe text separation is required.`);
      }
      const missingFiles = fonts.map(font => font.missingFile);
      const missingDescriptors = fonts.map(font => Object.getOwnPropertyDescriptor(font, "missingFile"));
      const hiddenGlyphId = `yn-hidden-prose-${randomUUID()}`;
      for(const font of fonts) if(font.isType3Font) font.charProcOperatorList.set(hiddenGlyphId,{fnArray:[],argsArray:[]});
      const ink = page.recordedBBoxes;
      const nativeInkBox = (own: number[]): PdfBox => {
        const indexes = new Set(own.flatMap(index=>[
          renderedPaints[paints.findIndex(paint=>paint.operator===index)]?.index,
          ...(outlined.owners.get(index)??[]).map(pathIndex=>renderedPaths[originalPaths.findIndex(entry=>entry.index===pathIndex)]?.index)
        ]).filter((index):index is number=>index!==undefined));
        const boxes=[...indexes].filter(index=>ink && index<ink.length && !ink.isEmpty(index))
          .map(index=>[ink!.minX(index)*canvas.width/scale,ink!.minY(index)*canvas.height/scale,
            ink!.maxX(index)*canvas.width/scale,ink!.maxY(index)*canvas.height/scale]);
        if(!boxes.length)throw new Error(`PDF page ${number}: native protected ink geometry is unavailable.`);
        const x=Math.max(0,Math.min(...boxes.map(box=>box[0]))),y=Math.max(0,Math.min(...boxes.map(box=>box[1])));
        const right=Math.min(viewport.width,Math.max(...boxes.map(box=>box[2]))),bottom=Math.min(viewport.height,Math.max(...boxes.map(box=>box[3])));
        return {x,y,width:right-x,height:bottom-y};
      };
      const isolateInlineInk = async (own: number[], nominal: PdfBox, padding: number): Promise<PdfBox> => {
        const keepText=new Set(own.map(operator=>renderedPaints[paints.findIndex(paint=>paint.operator===operator)].index));
        const keepPaths=new Set(own.flatMap(operator=>(outlined.owners.get(operator)??[]).map(index=>renderedPaths[originalPaths.findIndex(entry=>entry.index===index)].index)));
        const hidden: Array<{list:any;index:number;glyphs:any[]}> = [], hiddenPaths:Array<{list:any;index:number;args:any[]}>=[];
        const imageOps=new Set(Object.entries(pdfjs.OPS).filter(([name])=>/^(?:paint.*Image|shadingFill)/u.test(name)).map(([,code])=>code));
        const leftEdge=Math.max(0,Math.floor((nominal.x-padding)*scale)),topEdge=Math.max(0,Math.floor((nominal.y-padding)*scale));
        const rightEdge=Math.min(canvas.width,Math.ceil((nominal.x+nominal.width+padding)*scale)),bottomEdge=Math.min(canvas.height,Math.ceil((nominal.y+nominal.height+padding)*scale));
        const inkCanvas=createCanvas(rightEdge-leftEdge,bottomEdge-topEdge),context=inkCanvas.getContext('2d');
        try {
          // Passing a canvas makes PDF.js reacquire it with alpha:false. Use
          // the existing alpha context explicitly for isolated ink measurement.
          await renderPdfPage(page,{canvas:null,canvasContext:context as any,viewport:renderedViewport,transform:[1,0,0,1,-leftEdge,-topEdge],
            annotationMode:pdfjs.AnnotationMode.DISABLE,background:'rgba(0,0,0,0)',operationsFilter:(index,list)=>{
              const op=list.fnArray[index];
              if(op===pdfjs.OPS.constructPath) {
                if(!keepPaths.has(index)&&list.argsArray[index][0]!==pdfjs.OPS.endPath){const args=list.argsArray[index];hiddenPaths.push({list,index,args});list.argsArray[index]=[pdfjs.OPS.endPath,...args.slice(1)];}
                return true;
              }
              if(imageOps.has(op))return false;
              if(!textPaint.has(op))return true;
              if(op!==pdfjs.OPS.showText&&op!==pdfjs.OPS.showSpacedText)throw new Error(`PDF page ${number}: unsupported inline glyph operation.`);
              if(!keepText.has(index)) {
                const glyphs=list.argsArray[index][0];hidden.push({list,index,glyphs});
                list.argsArray[index][0]=glyphs.map((glyph:any)=>typeof glyph==='object'?{...glyph,isInFont:false,fontChar:'',unicode:'',accent:null,operatorListId:hiddenGlyphId}:glyph);
              }
              return true;
            }});
          const pixels=context.getImageData(0,0,inkCanvas.width,inkCanvas.height).data;
          let left=inkCanvas.width,top=inkCanvas.height,right=-1,bottom=-1;
          for(let y=0;y<inkCanvas.height;y++)for(let x=0;x<inkCanvas.width;x++)if(pixels[(y*inkCanvas.width+x)*4+3]){
            left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
          }
          if(right<0)throw new Error(`PDF page ${number}: isolated inline glyphs have no ink.`);
          if ((left===0&&leftEdge>0)||(top===0&&topEdge>0)||(right===inkCanvas.width-1&&rightEdge<canvas.width)||(bottom===inkCanvas.height-1&&bottomEdge<canvas.height)) {
            for(const entry of hidden)entry.list.argsArray[entry.index][0]=entry.glyphs;
            for(const entry of hiddenPaths)entry.list.argsArray[entry.index]=entry.args;
            return await isolateInlineInk(own,nominal,padding*2);
          }
          const sx=canvas.width/viewport.width,sy=canvas.height/viewport.height;
          return {x:(leftEdge+left)/sx,y:(topEdge+top)/sy,width:(right-left+1)/sx,height:(bottom-top+1)/sy};
        } finally {
          for(const entry of hidden)entry.list.argsArray[entry.index][0]=entry.glyphs;
          for(const entry of hiddenPaths)entry.list.argsArray[entry.index]=entry.args;
          inkCanvas.width=inkCanvas.height=1;
        }
      };
      const inlineInkCache=new Map<string,PdfBox>();
      for(const block of blocks)for(const fragment of block.inlineProtections??[]) {
        if(fragment.paintOperations.some(op=>!protectedText.retained.has(op)))throw new Error(`PDF page ${number}: inline protection does not own retained glyphs.`);
        const key=fragment.paintOperations.join(',');
        let box=inlineInkCache.get(key);
        if(!box) {
          const recorded=nativeInkBox(fragment.paintOperations);
          // Some font painters report a conservative whole-page bound. Measure
          // isolated native pixels explicitly rather than treating that as ink.
          box=recorded.width>fragment.width+block.fontSize*4||recorded.height>fragment.height+block.fontSize*4
            ?await isolateInlineInk(fragment.paintOperations,fragment,block.fontSize*2):recorded;
          inlineInkCache.set(key,box);
        }
        fragment.inkBox=box;
      }
      // Subscripts and accent glyphs can extend beyond text advances. Reserve
      // the native ink envelope, not just the nominal source text box.
      const obstacles=blocks.flatMap(block=>block.inlineProtections??[]);
      for(const block of blocks)for(const segment of block.proseSegments??[]) {
        const originalBoxes=segment.boxes;
        let boxes=segment.boxes;
        for(const fragment of obstacles) {
          const inkBox=fragment.inkBox!;
          const obstacle={x:Math.max(0,inkBox.x-.5),y:Math.max(0,inkBox.y-.5),width:inkBox.width+1,height:inkBox.height+1};
          boxes=boxes.flatMap(box=>{
            if(!intersects(box,obstacle))return [box];
            // A preceding/following visual row may overhang slightly into this
            // row. Preserve its full width and reserve that vertical ink edge.
            if(fragment.y+fragment.height<=box.y || fragment.y>=box.y+box.height) {
              const y=fragment.y<box.y?Math.max(box.y,obstacle.y+obstacle.height):box.y;
              const bottom=fragment.y<box.y?box.y+box.height:Math.min(box.y+box.height,obstacle.y);
              return bottom>y?[{...box,y,height:bottom-y}]:[];
            }
            const left=Math.max(box.x,obstacle.x),right=Math.min(box.x+box.width,obstacle.x+obstacle.width);
            // Keep the prose baseline/line height. Tiny vertical slivers above
            // or below an accent are not usable text rows; trim horizontally.
            return [
              {x:box.x,y:box.y,width:left-box.x,height:box.height},
              {x:right,y:box.y,width:box.x+box.width-right,height:box.height}
            ].filter(area=>area.width>0&&area.height>0);
          });
        }
        segment.boxes=boxes.sort((a,b)=>a.y-b.y||a.x-b.x);
        if(segment.text.trim()&&!segment.boxes.length)throw new Error(`PDF page ${number} L${block.line}: protected ink covers prose ${JSON.stringify(segment.text)}; sourceBoxes=${JSON.stringify(originalBoxes)}; inlineInk=${JSON.stringify(obstacles.filter(node=>originalBoxes.some(box=>intersects(box,node.inkBox!))).map(node=>({token:node.token,ink:node.inkBox})))}.`);
      }
      const flowAreas=blocks.flatMap(block=>block.proseSegments?.flatMap(segment=>segment.boxes)??[block]);
      for(const block of blocks)for(const segment of block.proseSegments??[])for(const box of segment.boxes) {
        box.height=Math.min(box.height,...flowAreas.filter(other=>other!==box&&other.y>box.y+.5
          &&other.x<box.x+box.width&&other.x+other.width>box.x).map(other=>other.y-box.y));
      }
      const numericOwnership = new Map<typeof blocks[number],Set<number>>();
      const numericGlyphs = new Map<typeof blocks[number],Map<number,Set<number>>>();
      for(const block of blocks) {
        if(block.protection) {
          const indexes=new Set((block.paintOperations??[]).flatMap(operator=>[
            renderedPaints[paints.findIndex(paint=>paint.operator===operator)]?.index,
            ...(outlined.owners.get(operator)??[]).map(pathIndex=>renderedPaths[originalPaths.findIndex(entry=>entry.index===pathIndex)]?.index)
          ]).filter((index):index is number=>index!==undefined));
          const bounds=[...indexes].filter(index=>ink&&index<ink.length&&!ink.isEmpty(index)).map(index=>({x:ink!.minX(index)*canvas.width/scale,y:ink!.minY(index)*canvas.height/scale,right:ink!.maxX(index)*canvas.width/scale,bottom:ink!.maxY(index)*canvas.height/scale}));
          if(!bounds.length)throw new Error(`PDF page ${number}: protected source has no native ink geometry.`);
          const x=Math.max(0,Math.min(...bounds.map(box=>box.x))),y=Math.max(0,Math.min(...bounds.map(box=>box.y))),right=Math.min(viewport.width,Math.max(...bounds.map(box=>box.right))),bottom=Math.min(viewport.height,Math.max(...bounds.map(box=>box.bottom)));
          block.sourceInkBox={x,y,width:right-x,height:bottom-y};
        }
        if(!block.protection && /^\d+$/u.test(block.text)) {
          const own = block.paintOperations ?? [];
          if(!own.length || !block.paintSpans?.length) throw new Error(`PDF page ${number}: numeric glyph ownership is missing.`);
          const masks = new Map(own.map(operator => [operator, selectPdfPaintGlyphs(ops.argsArray[operator][0],
            block.paintSpans!.filter(span => span.operator === operator), pdfjs.normalizeUnicode)]));
          const selected = own.map(operator => ops.argsArray[operator][0].filter((_: unknown,index: number) => masks.get(operator)!.has(index))
            .map((glyph: any) => pdfjs.normalizeUnicode(glyph.unicode ?? "").replace(/\s/g,""))).flat().join("");
          if(selected !== block.text) throw new Error(`PDF page ${number}: numeric glyph text does not match its source block.`);
          numericGlyphs.set(block,masks);
          numericOwnership.set(block,new Set(own));
          const ownedPaths = new Set(own.flatMap(index=>outlined.owners.get(index)??[]));
          if(blocks.some(other=>other!==block && other.paintOperations?.some(index=>outlined.owners.get(index)?.some(pathIndex=>ownedPaths.has(pathIndex))))) throw new Error(`PDF page ${number}: numeric outlines share ownership with other text.`);
          const indexes = new Set(own.flatMap(index=>[
            renderedPaints[paints.findIndex(paint=>paint.operator===index)]?.index,
            ...(outlined.owners.get(index)??[]).map(pathIndex=>renderedPaths[originalPaths.findIndex(entry=>entry.index===pathIndex)]?.index)
          ]).filter((index):index is number=>index!==undefined));
          const boxes=[...indexes].filter(index=>ink && index<ink.length && !ink.isEmpty(index))
            .map(index=>[ink!.minX(index)*canvas.width/scale,ink!.minY(index)*canvas.height/scale,
              ink!.maxX(index)*canvas.width/scale,ink!.maxY(index)*canvas.height/scale]);
          if(!boxes.length)throw new Error(`PDF page ${number}: native numeric ink geometry is unavailable.`);
          const x=Math.max(0,Math.min(...boxes.map(box=>box[0]))),y=Math.max(0,Math.min(...boxes.map(box=>box[1])));
          const right=Math.min(viewport.width,Math.max(...boxes.map(box=>box[2]))),bottom=Math.min(viewport.height,Math.max(...boxes.map(box=>box[3])));
          block.sourceInkBox={x,y,width:right-x,height:bottom-y};

        }

      }
      if(originalPaths.length!==renderedPaths.length||originalPaths.some((entry,index)=>entry.bounds!==renderedPaths[index].bounds))throw new Error(`PDF page ${number}: graphic paint ownership differs from extraction.`);
      const graphicPaints:Array<PdfBox&{operator:number}>=[];
      for(const [index,entry] of originalPaths.entries()) {
        if(outlined.paired.has(entry.index)||ops.argsArray[entry.index][0]===pdfjs.OPS.endPath)continue;
        const rendered=renderedPaths[index].index;
        if(!ink||rendered>=ink.length)throw new Error(`PDF page ${number}: native graphic ${entry.index} has no recorded geometry.`);
        if(ink.isEmpty(rendered))continue;
        checkCancelled();
        // recordedBBoxes includes conservative stroke/filter padding. Measure
        // the original painter itself so a table rule cannot claim a nearby
        // variable, and a fraction bar cannot disappear as "decoration".
        const left=Math.max(0,Math.floor(ink.minX(rendered)*canvas.width)-1),top=Math.max(0,Math.floor(ink.minY(rendered)*canvas.height)-1),right=Math.min(canvas.width,Math.ceil(ink.maxX(rendered)*canvas.width)+1),bottom=Math.min(canvas.height,Math.ceil(ink.maxY(rendered)*canvas.height)+1);
        const isolated=createCanvas(right-left,bottom-top),context=isolated.getContext('2d'),alteredPaths:Array<{list:any;index:number;args:any[]}>=[];
        let pathIndex=0;
        try {
          await renderPdfPage(page,{canvas:null,canvasContext:context as any,viewport:renderedViewport,transform:[1,0,0,1,-left,-top],background:'rgba(0,0,0,0)',annotationMode:pdfjs.AnnotationMode.DISABLE,
            operationsFilter:(operation,list)=>{
              const code=list.fnArray[operation];
              if(textPaint.has(code)||Object.entries(pdfjs.OPS).some(([name,value])=>code===value&&/^(?:paint.*Image|shadingFill)/u.test(name)))return false;
              if(code===pdfjs.OPS.constructPath&&list.argsArray[operation][2]) {
                const original=originalPaths[pathIndex++];
                if(!original||original.bounds!==JSON.stringify(Array.from(list.argsArray[operation][2])))throw new Error(`PDF page ${number}: isolated graphic stream changed.`);
                if(original.index!==entry.index&&list.argsArray[operation][0]!==pdfjs.OPS.endPath){const args=list.argsArray[operation];alteredPaths.push({list,index:operation,args});list.argsArray[operation]=[pdfjs.OPS.endPath,...args.slice(1)];}
              }
              return true;
            }});
          const pixels=context.getImageData(0,0,isolated.width,isolated.height).data;
          let x0=isolated.width,y0=isolated.height,x1=-1,y1=-1;
          for(let y=0;y<isolated.height;y++)for(let x=0;x<isolated.width;x++)if(pixels[(y*isolated.width+x)*4+3]){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
          if(x1<0||pathIndex!==originalPaths.length)throw new Error(`PDF page ${number}: native graphic ${entry.index} cannot be isolated completely.`);
          graphicPaints.push({operator:entry.index,x:(left+x0)/scale,y:(top+y0)/scale,width:(x1-x0+1)/scale,height:(y1-y0+1)/scale});
        }finally{for(const hidden of alteredPaths)hidden.list.argsArray[hidden.index]=hidden.args;isolated.width=isolated.height=1;}
      }
      const natives:Array<{id:string;box:PdfBox;kind:'math'|'code'}>=[];
      const nativeSources=new Map<string,{nativePathOperations?:number[]}>();
      const numericClipOwners=new Map<number,PdfBox>();
      for(const paint of graphicPaints)if([pdfjs.OPS.clip,pdfjs.OPS.eoClip].includes(ops.fnArray[paint.operator-1])) {
        const restore=ops.fnArray.findIndex((code,index)=>index>paint.operator&&code===pdfjs.OPS.restore),end=restore<0?ops.fnArray.length:restore;
        const affected=blocks.filter(block=>block.paintOperations?.some(operator=>operator>paint.operator&&operator<end));
        if(affected.length===1&&!affected[0].protection&&/^\d+$/u.test(affected[0].text))numericClipOwners.set(affected[0].line,paint);
      }
      for(const block of blocks)if(!block.protection&&/^\d+$/u.test(block.text)) {
        const fraction=graphicPaints.find(paint=>{
          if(paint.height>1||paint.width<=2||Math.abs(block.x+block.width/2-paint.x-paint.width/2)>block.fontSize/2
            ||block.x<paint.x-1||block.x+block.width>paint.x+paint.width+1)return false;
          const numericCenter=block.y+block.fontSize/2;
          const opposite=protectedText.items.filter(item=>item.protection==='math').map(item=>{
            const size=Math.hypot(item.transform[2],item.transform[3]),x=viewport.transform[0]*item.transform[4]+viewport.transform[2]*item.transform[5]+viewport.transform[4];
            const y=viewport.transform[1]*item.transform[4]+viewport.transform[3]*item.transform[5]+viewport.transform[5]-size;
            return {x,right:x+item.width,center:y+size/2};
          }).filter(item=>(item.center-paint.y)*(numericCenter-paint.y)<0&&Math.abs(item.center-paint.y)<=block.fontSize*2
            &&item.x>=paint.x-1&&item.right<=paint.x+paint.width+1);
          return opposite.length>0&&Math.abs((Math.max(...opposite.map(item=>item.right))+Math.min(...opposite.map(item=>item.x)))/2-paint.x-paint.width/2)<=block.fontSize/2;
        });
        if(fraction||numericClipOwners.has(block.line)) {
          block.protection='math';block.segmentation='protected';delete block.proseSegments;delete block.inlineProtections;
          for(const operator of block.paintOperations??[]){protectedText.retained.add(operator);retainedRenderOps.add(renderedPaints[paints.findIndex(paint=>paint.operator===operator)].index);}
        }
      }
      for(let index=0;index<blocks.length;index++) {
        const block=blocks[index];
        for(const node of block.inlineProtections??[]){natives.push({id:node.token,box:unionBox(node,node.inkBox!),kind:node.kind});nativeSources.set(node.token,node);}
        if(block.protection) {
          const group=[block];
          while(index+1<blocks.length&&blocks[index+1].protection===block.protection&&blocks[index+1].y<=group.at(-1)!.y+group.at(-1)!.height+block.fontSize*2)group.push(blocks[++index]);
          const boxes=group.map(row=>row.sourceInkBox&&row.sourceInkBox.width<viewport.width*.95?unionBox(row,row.sourceInkBox):row);
          let box=boxes.reduce(unionBox);
          const numericClip=numericClipOwners.get(block.line);if(numericClip)box=unionBox(box,numericClip);
          const operators=group.flatMap(row=>row.paintOperations??[]);
          if(block.protection==='math'&&group.length>1)for(const paint of graphicPaints)if(paint.height<=1&&paint.width>paint.height
            &&paint.operator>Math.min(...operators)&&paint.operator<Math.max(...operators)&&paint.y>=box.y&&paint.y+paint.height<=box.y+box.height
            &&paint.x>=box.x-block.fontSize*2&&paint.x+paint.width<=box.x+box.width+block.fontSize*2)box=unionBox(box,paint);
          const id=`native:${block.line}`;natives.push({id,box,kind:block.protection});nativeSources.set(id,block);
        }
      }
      const graphicInput={page:number,width:viewport.width,height:viewport.height,paints:graphicPaints,textBlocks:blocks,rasterReferences:images,natives,tableRegions:pdfSourceTables(blocks)};
      await atomic(path.join(directory,`graphic-ownership-${number}.json`),JSON.stringify({input:graphicInput}));
      const graphics=classifyPdfGraphicRegions(graphicInput);
      await atomic(path.join(directory,`graphic-ownership-${number}.json`),JSON.stringify({input:graphicInput,result:graphics}));
      for(const owner of graphics.nativeOwners)nativeSources.get(owner.id)!.nativePathOperations=owner.paintOperations;
      layout.references.push(...graphics.references);
      const graphicMetadata={graphicOperations:graphicPaints.map(paint=>paint.operator),tableRules:graphics.tableRuleOwners};
      const hiddenRenderPaths=new Set(originalPaths.flatMap((entry,index)=>outlined.hidden.has(entry.index)?[renderedPaths[index].index]:[]));
      const altered: Array<{ list: any; index: number; glyphs: any[] }> = [];
      try {
        await renderPdfPage(page,{ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport: renderedViewport,
          annotationMode: pdfjs.AnnotationMode.DISABLE, operationsFilter: (index, list) => {
            if(hiddenRenderPaths.has(index))return false;
            if (!textPaint.has(list.fnArray[index])) return true;
            if (!protectedText.retained.size) return false;
            if (list.fnArray[index] !== pdfjs.OPS.showText && list.fnArray[index] !== pdfjs.OPS.showSpacedText) {
              throw new Error(`PDF page ${number}: unsupported text operation in a protected page.`);
            }
            const keep = retainedRenderOps.has(index);
            fonts.forEach((font, i) => Object.defineProperty(font, "missingFile", { value: keep ? missingFiles[i] : false, configurable: true }));
            if (!keep) {
              const glyphs = list.argsArray[index][0];
              altered.push({ list, index, glyphs });
              list.argsArray[index][0] = glyphs.map((glyph: any) => typeof glyph === "object" ? { ...glyph, isInFont: false, operatorListId:hiddenGlyphId } : glyph);
            }
            return true;
          } });
      } finally {
        fonts.forEach((font, i) => { if (missingDescriptors[i]) Object.defineProperty(font, "missingFile", missingDescriptors[i]!); else delete font.missingFile; });
        for (const entry of altered) entry.list.argsArray[entry.index][0] = entry.glyphs;

      }
      const background = encodePdfPng(canvas);
      const backgroundPath = path.join(directory, `background-${number}.png`);
      await atomic(backgroundPath, background);
      layout.pages.push({ page: number, width: viewport.width, height: viewport.height, previewPath, previewHash: digest(preview), backgroundPath, backgroundHash: digest(background),...graphicMetadata });
      const figureGroups=discoverPdfFigureGroups(number,images,blocks).map(({box,...group})=>({...group,...box}));
      layout.figureGroups??=[];layout.figureGroups.push(...figureGroups);
      for(const line of figureGroups.flatMap(group=>group.physicalLines)) {
        const block=blocks.find(block=>block.line===line)!;
        block.protection='math';block.segmentation='protected';delete block.proseSegments;delete block.inlineProtections;
      }
      // Numbers keep their original glyphs in an isolated transparent layer.
      // Native ink bounds can exceed text advances and are quantized; cropping
      // the page preview would otherwise cut overhang or include nearby prose.
      for(const block of blocks.filter(block=>numericOwnership.has(block))) {
        const own = numericOwnership.get(block)!;
        const masks = numericGlyphs.get(block)!;
        const keepText=new Set(paints.flatMap((paint,index)=>own.has(paint.operator)?[renderedPaints[index].index]:[]));
        const keepGlyphs=new Map(paints.flatMap((paint,index)=>own.has(paint.operator)?[[renderedPaints[index].index,masks.get(paint.operator)!] as const]:[]));
        const ownPaths=new Set([...own].flatMap(index=>outlined.owners.get(index)??[]));
        const keepPaths=new Set(originalPaths.flatMap((entry,index)=>ownPaths.has(entry.index)?[renderedPaths[index].index]:[]));
        if(!keepText.size)throw new Error(`PDF page ${number}: numeric isolated paint binding is missing.`);
        const hidden:Array<{list:any;index:number;glyphs:any[]}>=[];
        const hiddenPaths:Array<{list:any;index:number;args:any[]}>=[];
        try {
          const numericContext=canvas.getContext("2d");numericContext.resetTransform();numericContext.clearRect(0,0,canvas.width,canvas.height);
          await renderPdfPage(page,{canvas:canvas as any,canvasContext:canvas.getContext("2d") as any,viewport:renderedViewport,
            background:"rgba(0,0,0,0)",annotationMode:pdfjs.AnnotationMode.DISABLE,
            operationsFilter:(index,list)=>{
              const op=list.fnArray[index];
              if(op===pdfjs.OPS.constructPath) {
                // A filled/stroked path may also install a pending clip. Keep
                // its geometry and endPath semantics while suppressing paint.
                if(!keepPaths.has(index) && list.argsArray[index][0]!==pdfjs.OPS.endPath) {
                  const args=list.argsArray[index];hiddenPaths.push({list,index,args});
                  list.argsArray[index]=[pdfjs.OPS.endPath,...args.slice(1)];
                }
                return true;
              }
              if(Object.entries(pdfjs.OPS).some(([name,code])=>code===op && /^(?:paint.*Image|shadingFill)/u.test(name)))return false;
              if(!textPaint.has(op))return true;
              if(op!==pdfjs.OPS.showText && op!==pdfjs.OPS.showSpacedText)throw new Error(`PDF page ${number}: unsupported numeric glyph operation.`);
              const keep=keepText.has(index);
              const mask=keepGlyphs.get(index),glyphs=list.argsArray[index][0];
              const partial=keep && glyphs.some((glyph:any,i:number)=>typeof glyph==="object" && !mask!.has(i));
              if(!keep || partial) {
                hidden.push({list,index,glyphs});
                // Preserve the selected glyphs' native fallback painter and
                // every original text advance, including missing-file fonts.
                list.argsArray[index][0]=glyphs.map((glyph:any,i:number)=>typeof glyph==="object" && !mask?.has(i)
                  ?{...glyph,isInFont:false,fontChar:"",unicode:"",accent:null,operatorListId:hiddenGlyphId}:glyph);
              }
              return true;
            }});
          const sx=canvas.width/viewport.width,sy=canvas.height/viewport.height,box=block.sourceInkBox!;
          let left=Math.floor(box.x*sx),top=Math.floor(box.y*sy),right=Math.ceil((box.x+box.width)*sx),bottom=Math.ceil((box.y+box.height)*sy);
          const pixels=numericContext.getImageData(left,top,right-left,bottom-top),width=pixels.width,height=pixels.height;
          let x0=width,y0=height,x1=-1,y1=-1;
          for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels.data[(y*width+x)*4+3]) {
            x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
          }
          if(x1<0)throw new Error(`PDF page ${number}: isolated numeric glyphs have no native ink.`);
          // Retain one transparent pixel around the measured ink so PDF image
          // resampling cannot clip the edge of the original glyph.
          right=Math.min(canvas.width,left+x1+2);bottom=Math.min(canvas.height,top+y1+2);
          left=Math.max(0,left+x0-1);top=Math.max(0,top+y0-1);
          const crop=createCanvas(right-left,bottom-top);
          try {
            crop.getContext("2d").drawImage(canvas,left,top,crop.width,crop.height,0,0,crop.width,crop.height);
            const bytes=encodePdfPng(crop);
            block.sourceInkBox={x:left/sx,y:top/sy,width:crop.width/sx,height:crop.height/sy};
            block.sourceInkPath=path.join(directory,`numeric-${block.line}.png`);block.sourceInkHash=digest(bytes);
            await atomic(block.sourceInkPath,bytes);
          } finally {crop.width=crop.height=1;}
        } finally {
          fonts.forEach((font,i)=>{if(missingDescriptors[i])Object.defineProperty(font,"missingFile",missingDescriptors[i]!);else delete font.missingFile;});
          for(const entry of hidden)entry.list.argsArray[entry.index][0]=entry.glyphs;
          for(const entry of hiddenPaths)entry.list.argsArray[entry.index]=entry.args;
        }
      }
      for(const block of blocks) {
        delete block.paintSpans;
        if(!block.protection)delete block.paintOperations;
      }
      for(const font of fonts)if(font.isType3Font)font.charProcOperatorList.delete(hiddenGlyphId);
      canvas.width = canvas.height = 1;
      page.cleanup(); progress(number, pdf.numPages);
    }
    if (!layout.blocks.length) throw new Error("PDF contains no extractable text. OCR is required before translation.");
    makePdfLogicalDocument(layout);
    const logicalOwners=new Map(layout.blocks.flatMap(block=>block.fragments!.map(line=>[line,block.line] as const)));
    for(const page of segmentationPages)for(const decision of page.decisions)Object.assign(decision,{physicalLine:decision.line,line:logicalOwners.get(decision.line)});
    const text = layout.blocks.map(block => block.text).join("\n");
    layout.sourceHash = digest(text);
    layout.protectionHash = pdfProtectionHash(layout);
    if (digest(await readFile(input.originalPath)) !== hash) throw new Error("PDF changed during extraction; no projection was committed.");
    validatePdfLayout(layout);
    await atomic(input.sourcePath+'.pdf-mechanical.txt', text);
    await atomic(input.sourcePath+'.pdf-segmentation.json',JSON.stringify({originalHash:hash,sourceHash:layout.sourceHash,version:layout.version,extractorRevision:layout.extractorRevision,pages:segmentationPages}));
    // Commit the manifest last: incomplete image extraction never becomes usable.
    await atomic(input.sourcePath+'.pdf-mechanical.json', JSON.stringify(encodeProjectPaths(layout, input.projectRoot)));
    return { sourcePath: input.sourcePath, sourceHash: layout.sourceHash, originalHash: hash, pages: pdf.numPages, lines: layout.blocks.length,
      segmentation:{physicalRows:layout.physicalBlocks!.length,mechanicalParagraphCandidates:layout.mechanicalParagraphs?.length??layout.physicalBlocks!.length,
        logicalOwners:layout.blocks.length,multiSourceOwners:layout.blocks.filter(block=>block.fragments!.length>1).length,
        paragraphs:layout.blocks.filter(block=>block.segmentation==='paragraph').length,
        protectedRows:layout.blocks.filter(block=>block.protection).length,
        ambiguousParallelRows:layout.blocks.filter(block=>block.segmentation==='parallel-region').length,
        inlineNodes:layout.blocks.reduce((sum,block)=>sum+(block.inlineProtections?.length??0),0)} };
  } finally { await destroy(); }
}

/** Rebind reference glyph ownership from the hash-checked original; render a
 * transparent layer at full page size, so italic overhang cannot be cropped. */
async function referenceProseInk(page: any, number: number, boundBlocks: PdfLayout['blocks'], selectedRows: Set<number>, inline: {tokens:Set<string>;nativeRows?:boolean;includeImages?:Set<string>}) {
  const viewport=page.getViewport({scale:1}),content=await page.getTextContent({includeMarkedContent:true});
  const ops=await page.getOperatorList({annotationMode:pdfjs.AnnotationMode.DISABLE}),structure=await page.getStructTree(),paints=textColors(ops);
  const {areas,imagePaints}=imageReferences(ops,viewport,number),structured=pdfParagraphStructure(content,structure);
  const protectedText=protectPdfText({...structured,items:markPdfCodePanels(structured,areas,viewport.transform)},structure,paints,
    id=>page.commonObjs.has(id)?String(page.commonObjs.get(id).name??''):'',number);
  const outlined=pdfOutlinedText(ops,pdfjs.OPS,id=>page.commonObjs.get(id),protectedText.retained,number,protectedText.items);
  let blocks=pdfTextBlocks(protectedText.items,viewport,number);
  const matches=(candidate:typeof blocks)=>candidate.length===boundBlocks.length&&candidate.every((block,index)=>block.text===boundBlocks[index].text);
  if(!matches(blocks))blocks=pdfTextBlocks(protectedText.items,viewport,number,undefined,{visualRowsOnly:true});
  if(!matches(blocks))throw new Error(`PDF page ${number}: reference glyph ownership differs from its bound source.`);
  for(const id of inline.includeImages??[])if(!imagePaints.some(paint=>paint.id===id))throw new Error(`PDF page ${number}: raster paint ownership is missing for ${id}.`);
  const selected=blocks.filter((_,index)=>selectedRows.has(boundBlocks[index].line));
  const spans=new Map<number,Array<{operator:number;start:number;end:number}>>();
  const inlineOperations=new Set(blocks.flatMap(block=>(block.inlineProtections??[]).filter(node=>inline.tokens.has(node.token)).flatMap(node=>node.paintOperations)));
    const reboundTokens=blocks.flatMap(block=>(block.inlineProtections??[]).filter(node=>inline.tokens.has(node.token)).map(node=>node.token));
    if(reboundTokens.length!==inline.tokens.size)throw new Error(`PDF page ${number}: inline glyph ownership differs from its bound source.`);
    for(const operator of inlineOperations)if(!protectedText.retained.has(operator))throw new Error(`PDF page ${number}: inline glyph is not protected native ink.`);
    for(const node of blocks.flatMap(block=>block.inlineProtections??[]).filter(node=>inline.tokens.has(node.token))) {
      if(!node.paintSpans?.length)throw new Error(`PDF page ${number}: inline native glyph has no precise character ownership.`);
      for(const span of node.paintSpans)spans.set(span.operator,[...(spans.get(span.operator)??[]),span]);
    }
    if(inline.nativeRows)for(const block of selected)for(const span of block.paintSpans??[])spans.set(span.operator,[...(spans.get(span.operator)??[]),span]);
  const nativePaths=boundBlocks.flatMap(block=>[
    ...(inline.nativeRows&&selectedRows.has(block.line)?block.nativePathOperations??[]:[]),
    ...(block.inlineProtections??[]).filter(node=>inline.tokens.has(node.token)).flatMap(node=>node.nativePathOperations??[])
  ]);
  for(const operator of nativePaths)if(ops.fnArray[operator]!==pdfjs.OPS.constructPath||ops.argsArray[operator][0]===pdfjs.OPS.endPath)throw new Error(`PDF page ${number}: native graphic identity changed.`);
  const keptPaths=new Set([...nativePaths,...[...spans.keys()].flatMap(operator=>outlined.owners.get(operator)??[])]);
  if(inline.nativeRows)for(const [operator,owned] of spans)if(outlined.owners.get(operator)?.length
    &&owned.reduce((total,span)=>total+span.end-span.start,0)!==paints.find(paint=>paint.operator===operator)!.text.replace(/\s/gu,'').length)throw new Error(`PDF page ${number}: native outlines cannot be safely separated between source rows.`);
  const movedPaths=new Set([...nativePaths,...[...inlineOperations].flatMap(operator=>outlined.owners.get(operator)??[])]);
  if(blocks.some(block=>block.paintOperations?.some(operator=>!inlineOperations.has(operator)&&outlined.owners.get(operator)?.some(index=>movedPaths.has(index)))))throw new Error(`PDF page ${number}: inline outlines share ownership with other content.`);
  const originalPaths=ops.fnArray.flatMap((op:number,index:number)=>op===pdfjs.OPS.constructPath&&ops.argsArray[index][2]?[{index,bounds:JSON.stringify(Array.from(ops.argsArray[index][2]))}]:[]);
  const scale=Math.min(2,3000/Math.max(viewport.width,viewport.height)),rendered=page.getViewport({scale});
  const canvas=createCanvas(Math.ceil(rendered.width),Math.ceil(rendered.height)),fonts=[...new Set(protectedText.items.map(item=>page.commonObjs.get(item.fontName)))];
  const descriptors=fonts.map(font=>Object.getOwnPropertyDescriptor(font,'missingFile')),hiddenId=`yn-hidden-reference-${randomUUID()}`;
  if(fonts.some(font=>font.isInvalidPDFjsFont))throw new Error(`PDF page ${number}: unsupported reference glyph painter.`);
  for(const font of fonts)if(font.isType3Font)font.charProcOperatorList.set(hiddenId,{fnArray:[],argsArray:[]});
  const altered:Array<{list:any;index:number;args:any[]}>=[],images=new Set(Object.entries(pdfjs.OPS).filter(([name])=>/^(?:paint.*Image|shadingFill)/u.test(name)).map(([,code])=>code));
  let paintIndex=0,pathIndex=0,imageIndex=0;
  try {
    await renderPdfPage(page,{canvas:null,canvasContext:canvas.getContext('2d'),viewport:rendered,background:'rgba(0,0,0,0)',annotationMode:pdfjs.AnnotationMode.DISABLE,
      operationsFilter:(index:number,list:any)=>{
        const op=list.fnArray[index];
        if(images.has(op)) {
          if(op===pdfjs.OPS.paintImageXObject||op===pdfjs.OPS.paintInlineImageXObject) {
            const original=imagePaints[imageIndex++];
            if(!original||ops.fnArray[original.operator]!==op)throw new Error(`PDF page ${number}: raster paint stream changed.`);
            return Boolean(original.id&&inline.includeImages?.has(original.id));
          }
          return false;
        }
        if(op===pdfjs.OPS.constructPath&&list.argsArray[index][2]) {
          const original=originalPaths[pathIndex++];if(!original||original.bounds!==JSON.stringify(Array.from(list.argsArray[index][2])))throw new Error(`PDF page ${number}: reference outline stream changed.`);
          const keep=keptPaths.has(original.index);
          if(!keep){const args=list.argsArray[index];altered.push({list,index,args});list.argsArray[index]=[pdfjs.OPS.endPath,...args.slice(1)];}return true;
        }
        if(op!==pdfjs.OPS.showText&&op!==pdfjs.OPS.showSpacedText)return true;
        const paint=paints[paintIndex++],glyphs=list.argsArray[index][0];
        const text=pdfjs.normalizeUnicode(glyphs.filter((glyph:any)=>typeof glyph==='object').map((glyph:any)=>glyph.unicode??'').join(''));
        if(!paint||paint.text!==text)throw new Error(`PDF page ${number}: reference text stream changed.`);
        const own=spans.get(paint.operator),mask=own?selectPdfPaintGlyphs(glyphs,own,pdfjs.normalizeUnicode):new Set<number>();
        const args=list.argsArray[index];altered.push({list,index,args});list.argsArray[index]=[glyphs.map((glyph:any,i:number)=>typeof glyph==='object'&&!mask.has(i)?{...glyph,isInFont:false,fontChar:'',unicode:'',accent:null,operatorListId:hiddenId}:glyph),...args.slice(1)];return true;
      }});
    if(paintIndex!==paints.length||pathIndex!==originalPaths.length||imageIndex!==imagePaints.length)throw new Error(`PDF page ${number}: incomplete reference paint ownership.`);
    return encodePdfPng(canvas);
  } finally {
    for(const entry of altered.reverse())entry.list.argsArray[entry.index]=entry.args;
    for(const [index,font] of fonts.entries()){const descriptor=descriptors[index];if(descriptor)Object.defineProperty(font,'missingFile',descriptor);else delete font.missingFile;if(font.isType3Font)font.charProcOperatorList.delete(hiddenId);}
    canvas.width=canvas.height=1;
  }
}

async function exportPdf() {
  if(input.kind!=='export')throw new Error('Invalid PDF export operation.');
  const layout=decodeProjectPaths(JSON.parse(await readFile(input.layoutPath,'utf8')) as PdfLayout,input.projectRoot);
  validatePdfLayout(layout);
  if(digest(await readFile(layout.originalPath))!==layout.originalHash||digest(await readFile(layout.sourcePath))!==layout.sourceHash)throw new Error('PDF source or projection changed. Regenerate the review before exporting.');
  if(input.lines.length!==layout.blocks.length||input.lines.some((line,index)=>typeof line!=='string'||/[\r\n]/u.test(line)||layout.blocks[index].text.trim()&&!line.trim()))throw new Error('PDF export requires one non-empty translated line per source block, without extra physical line breaks.');
  const references=new Set(pdfReferenceSections(layout).protectedLines.map(row=>row.line));
  const bundledFont=fontkit.create(await readFile(input.fontPath));
  for(const block of layout.blocks) {
    if((block.protection||references.has(block.line))&&input.lines[block.line-1]!==block.text)throw new Error(`PDF page ${block.page} L${block.line}: protected ${block.protection??'reference'} must remain exactly identical to its source.`);
    try{splitPdfInlineTranslation(block.text,input.lines[block.line-1]);}catch(error){throw new Error(`PDF page ${block.page} L${block.line}: ${errorDetails(error)}`);}
    if(!block.protection&&!references.has(block.line))for(const character of splitPdfInlineTranslation(block.text,input.lines[block.line-1]).join('').replace(/[\u2028\u2029]/gu,' ')) {
      if(!bundledFont.hasGlyphForCodePoint(character.codePointAt(0)!))throw new Error(`PDF L${block.line}: bundled font cannot render ${JSON.stringify(character)}.`);
    }
  }
  const original=await openPdf(layout.originalPath);
  try {
    if(original.hash!==layout.originalHash)throw new Error('PDF changed while preparing its structured source.');
    const physical=layout.physicalBlocks??layout.blocks,inlineAssets=new Map<string,PdfReflowImage>(),preparedPages=new Set<number>();
    const nativeAssets=new Map<string,PdfReflowImage>();
    const imageValue=(bytes:Uint8Array,width:number,height:number):PdfReflowImage=>({dataUrl:'data:image/png;base64,'+Buffer.from(bytes).toString('base64'),width,height});
    async function prepareInlinePage(number:number) {
      if(preparedPages.has(number))return;
      const pageLayout=layout.pages[number-1],blocks=physical.filter(block=>block.page===number),nodes=blocks.flatMap(block=>block.inlineProtections??[]);
      if(!nodes.length){preparedPages.add(number);return;}
      const page=await original.pdf.getPage(number),combined=await loadImage(Buffer.from(await referenceProseInk(page,number,blocks,new Set(),{tokens:new Set(nodes.map(node=>node.token))})));
      const sx=combined.width/pageLayout.width,sy=combined.height/pageLayout.height;
      const crops=new Map(nodes.map(node=>{
        const box=node.inkBox!,left=Math.max(0,Math.floor(box.x*sx)-1),top=Math.max(0,Math.floor(box.y*sy)-1),right=Math.min(combined.width,Math.ceil((box.x+box.width)*sx)+1),bottom=Math.min(combined.height,Math.ceil((box.y+box.height)*sy)+1);
        return [node.token,{left,top,right,bottom,box:{x:left/sx,y:top/sy,width:(right-left)/sx,height:(bottom-top)/sy}}] as const;
      }));
      const full=createCanvas(combined.width,combined.height);
      try {
        full.getContext('2d').drawImage(combined,0,0);const pixels=full.getContext('2d').getImageData(0,0,full.width,full.height).data;
        for(let y=0;y<full.height;y++)for(let x=0;x<full.width;x++)if(pixels[(y*full.width+x)*4+3]&&!nodes.some(node=>{const crop=crops.get(node.token)!;return x>=crop.left&&x<crop.right&&y>=crop.top&&y<crop.bottom;}))throw new Error(`PDF page ${number}: native inline ink exceeds its bound crops at pixel ${x},${y}.`);
      }finally{full.width=full.height=1;}
      for(const node of nodes) {
        checkCancelled();const crop=crops.get(node.token)!;
        const isolate=nodes.some(other=>other!==node&&intersects(crop.box,other.inkBox!));
        const image=isolate?await loadImage(Buffer.from(await referenceProseInk(page,number,blocks,new Set(),{tokens:new Set([node.token])}))):combined;
        const canvas=createCanvas(crop.right-crop.left,crop.bottom-crop.top);
        try {
          canvas.getContext('2d').drawImage(image,crop.left,crop.top,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
          if(!canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4===3&&value))throw new Error(`PDF ${node.token}: native glyph image is empty.`);
          inlineAssets.set(node.token,imageValue(encodePdfPng(canvas),canvas.width/sx,canvas.height/sy));
        }finally{canvas.width=canvas.height=1;}
      }
      preparedPages.add(number);progress(number,layout.pages.length);
    }
    const document=await buildPdfReflowDocument(layout,input.lines,{
      inline:async token=>{await prepareInlinePage(Number(token.match(/:p(\d+):/u)![1]));const image=inlineAssets.get(token);if(!image)throw new Error(`PDF inline asset is missing: ${token}`);return image;},
      native:async(number,owned)=>{
        const key=number+':'+owned.join(',');if(nativeAssets.has(key))return nativeAssets.get(key)!;
        checkCancelled();const pageLayout=layout.pages[number-1],blocks=physical.filter(block=>block.page===number),page=await original.pdf.getPage(number);
        const image=await loadImage(Buffer.from(await referenceProseInk(page,number,blocks,new Set(owned),{tokens:new Set(),nativeRows:true}))),canvas=createCanvas(image.width,image.height);
        try {
          const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
          let left=canvas.width,top=canvas.height,right=-1,bottom=-1;
          for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
          if(right<0)throw new Error(`PDF page ${number}: native source rows ${owned.join(',')} have no ink.`);
          left=Math.max(0,left-1);top=Math.max(0,top-1);right=Math.min(canvas.width,right+2);bottom=Math.min(canvas.height,bottom+2);
          const cropped=createCanvas(right-left,bottom-top);
          try{cropped.getContext('2d').drawImage(canvas,left,top,cropped.width,cropped.height,0,0,cropped.width,cropped.height);const result=imageValue(encodePdfPng(cropped),cropped.width/(canvas.width/pageLayout.width),cropped.height/(canvas.height/pageLayout.height));nativeAssets.set(key,result);return result;}
          finally{cropped.width=cropped.height=1;}
        }finally{canvas.width=canvas.height=1;}
      },
      figure:async id=>{
        const ref=layout.figureGroups?.find(group=>group.id===id)??layout.references.find(ref=>ref.id===id);if(!ref)throw new Error(`PDF figure is missing: ${id}`);
        const page=layout.pages[ref.page-1],bytes=await readFile(page.previewPath);if(digest(bytes)!==page.previewHash)throw new Error(`PDF page ${ref.page} preview asset changed.`);
        // Raster crops own image paints plus audited pure panel labels. Page
        // previews also contain foreign PDF prose/formulas and cannot be used.
        // Vector references retain the extraction proof that their crop has no
        // foreign body/native overlap.
        const vector='kind' in ref&&ref.kind==='vector',ownedRows='physicalLines' in ref?ref.physicalLines:[];
        const rasterIds=new Set('referenceIds' in ref?ref.referenceIds:[ref.id]);
        const source=vector?bytes:await referenceProseInk(await original.pdf.getPage(ref.page),ref.page,physical.filter(block=>block.page===ref.page),new Set(ownedRows),{tokens:new Set(),nativeRows:true,includeImages:rasterIds});
        const image=await loadImage(Buffer.from(source)),sx=image.width/page.width,sy=image.height/page.height,left=Math.max(0,Math.floor(ref.x*sx)),top=Math.max(0,Math.floor(ref.y*sy)),right=Math.min(image.width,Math.ceil((ref.x+ref.width)*sx)),bottom=Math.min(image.height,Math.ceil((ref.y+ref.height)*sy));
        const canvas=createCanvas(right-left,bottom-top);
        try{canvas.getContext('2d').drawImage(image,left,top,canvas.width,canvas.height,0,0,canvas.width,canvas.height);return imageValue(encodePdfPng(canvas),canvas.width/sx,canvas.height/sy);}finally{canvas.width=canvas.height=1;}
      }
    });
    checkCancelled();
    const htmlPath=input.outputPath.replace(/\.pdf$/iu,'.html'),documentPath=input.outputPath.replace(/\.pdf$/iu,'.document.json');
    await atomic(htmlPath,renderPdfReflowHtml(document,pathToFileURL(input.fontPath).href));
    await atomic(documentPath,JSON.stringify(document));
    return {outputPath:input.outputPath,htmlPath,documentPath,sourcePages:layout.pages.length,sourceLines:layout.blocks.length,structure:{nodes:document.nodes.length,nativeImages:nativeAssets.size,inlineGlyphs:inlineAssets.size,figures:document.nodes.filter(node=>node.type==='figure').length}};
  }finally{await original.destroy();}
}

async function referenceImage() {
  if (input.kind !== "reference") throw new Error("Invalid PDF reference operation.");
  const image = await loadImage(Buffer.from(input.bytes));
  const scaleX = image.width/input.pageWidth, scaleY = image.height/input.pageHeight, ref = input.box;
  const canvas = createCanvas(Math.max(1, Math.ceil(ref.width*scaleX)), Math.max(1, Math.ceil(ref.height*scaleY)));
  try {
    canvas.getContext("2d").drawImage(image, ref.x*scaleX, ref.y*scaleY, ref.width*scaleX, ref.height*scaleY, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toBuffer("image/png").toString("base64") };
  } finally { canvas.width = canvas.height = 1; }
}

let result:unknown,failure:unknown;
try {
  checkCancelled();result=input.kind==='extract'?await extract():input.kind==='reference'?await referenceImage():await exportPdf();checkCancelled();
} catch(error) {failure=error;}
finally {
  if(failure||cleanupFailures.length) {
    const error=cleanupFailures.length?new AggregateError([...(failure?[failure]:[]),...cleanupFailures],'PDF operation and cleanup failed.'):failure;
    parentPort?.postMessage({type:'error',error:errorDetails(error),stack:error instanceof Error?error.stack:undefined,cleanupFailure:cleanupFailures.length>0});process.exitCode=1;
  } else parentPort?.postMessage({type:'result',result});
  parentPort?.removeListener('message',cancelWorker);parentPort?.close();
}
