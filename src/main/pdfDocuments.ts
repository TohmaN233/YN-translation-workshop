import { createHash,randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { extractedWorkshopTextPath } from "./agent/translationBindingResolve.ts";
import { projectRelativePath } from "./projectPaths.ts";
import { PDF_LAYOUT_VERSION, PDF_EXTRACTOR_REVISION,pdfBlockPages, type PdfLayout, type PdfWorkerOperation } from "./pdfTypes.ts";
import { splitPdfInlineTranslation, type PdfProtectedLine } from "../shared/validation/pdfPreservation.ts";
import type { PdfPreservedSpan } from "../shared/validation/pdfAcademicPrescan.ts";
import type { PiSessionPromptRequest } from "../shared/agent/piSessionContract.ts";
import { RequiredWorkflowFileError, withRequiredWorkflowFile } from "./agent/requiredWorkflowFile.ts";
import { NonRetryableAssignmentError } from "./agent/piNative/assignmentFailure.ts";
import {pdfReferenceSections} from './pdfReferenceSections.ts';
import {printPdfHtml} from './pdfPrint.ts';
import {improvePdfStructure,currentPdfPreparationContext,PDF_STRUCTURE_PROMPT_VERSION,type PdfStructurePreparationOptions} from './pdfStructurePreparation.ts';
import {encodeProjectPaths} from './projectPaths.ts';
import {writeTextFileAtomically} from './atomicFile.ts';

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const pdfErrorDetails=(error:unknown):string=>error instanceof AggregateError
  ? `${error.message}: ${error.errors.map(pdfErrorDetails).join('; ')}`
  : error instanceof Error?error.message:String(error);
let resourceDirectory = fileURLToPath(new URL("../../", import.meta.url));
export function configurePdfResourceDirectory(directory: string): void { resourceDirectory = directory; }
function fontPath(): string {
  // Works in source, bundled main and app.asar; PDF libraries stay external.
  return path.join(resourceDirectory, "assets", "fonts", "NotoSansSC-Regular.ttf");
}

async function runPdfWorker(operation: PdfWorkerOperation, signal?: AbortSignal, onProgress?: (page: number, total: number) => void): Promise<any> {
  signal?.throwIfAborted();
  const journal = path.join(operation.projectRoot, ".translation-workshop", "pdf", "events.jsonl");
  await mkdir(path.dirname(journal), { recursive: true });
  const started = Date.now();
  const record = (event: string, details = {}) => appendFile(journal, JSON.stringify({ event, kind: operation.kind, at: new Date().toISOString(), elapsedMs: Date.now()-started, ...details }) + "\n");
  await record("started");
  try {
    const result = await new Promise<any>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./pdfWorker.ts" : "./pdfWorker.js", import.meta.url), {
        workerData: operation, execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")) });
      let result: any, failure: unknown;
      // PDF decoders can be creating native zlib handles. Interrupting the
      // thread between construction and initialization can abort Node itself.
      // Request cancellation and wait for render/decoder cleanup and real exit.
      const abort = () => { failure ??= signal?.reason ?? new Error("PDF operation cancelled."); worker.postMessage({type:"cancel"}); };
      worker.on("message", message => {
        if (message.type === "result") result = message.result;
        else if (message.type === "error") {
          const error=new Error(message.error);
          Object.assign(error,{workerStack:message.stack});
          if(message.cleanupFailure&&failure)failure=new AggregateError([failure,error],`PDF cancellation cleanup failed: ${pdfErrorDetails(failure)}; ${error.message}`);
          else if(message.cleanupFailure)failure=new AggregateError([error],error.message);
          else failure ??= error;
        }
        else if (message.type === "progress") {
          try { onProgress?.(message.page, message.total); }
          catch (error) { failure ??= error; abort(); }
        }
      });
      worker.once("error", error => { failure=failure
        ? new AggregateError([failure,error],`PDF operation and worker failure: ${pdfErrorDetails(failure)}; ${error.message}`)
        : error; });
      worker.once("exit", code => {
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new Error(`PDF worker exited without a result (${code}).`));
        else resolve(result);
      });
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
    signal?.throwIfAborted();
    await record(operation.kind==='export'?"source_prepared":"completed", { pages: result.pages, segmentation:result.segmentation,structure:result.structure,htmlPath:result.htmlPath });
    return result;
  } catch (error) {
    try { await record(signal?.aborted&&!(error instanceof AggregateError) ? "cancelled" : "failed", { error: pdfErrorDetails(error),workerStack:(error as {workerStack?:string})?.workerStack }); }
    catch (journalError) { throw new AggregateError([error, journalError], "PDF operation and diagnostic persistence failed."); }
    throw error;
  }
}

type VerifiedPdfBinding = { layout: PdfLayout; files: string[]; stamps: string[]; preservedSpans: PdfPreservedSpan[] };
const preservedSpansCache = new WeakMap<PdfLayout, PdfPreservedSpan[]>();
const verifiedBindings = new Map<string, VerifiedPdfBinding>();
async function fileStamp(file: string): Promise<string> {
  const value = await stat(file, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}
async function runBindingWorker(input: object, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./pdfBindingWorker.ts" : "./pdfBindingWorker.js", import.meta.url), {
      workerData: input, execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")) });
    let result: unknown, failure: unknown;
    const abort = () => { failure ??= signal?.reason ?? new Error("PDF binding verification cancelled."); void worker.terminate().catch(error => { failure = new AggregateError([failure, error], "PDF binding cancellation failed."); }); };
    worker.on("message", message => {
      if (message.error) failure = message.code === "ENOENT" || message.code === "ENOTDIR"
        ? new RequiredWorkflowFileError(message.file, Object.assign(new Error(message.error), {code:message.code}))
        : new NonRetryableAssignmentError(message.error);
      else result = message.result;
    });
    worker.once("error", error => { failure ??= new NonRetryableAssignmentError("PDF binding verification failed.", error); });
    worker.once("exit", code => {
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || result === undefined) reject(new NonRetryableAssignmentError(`PDF binding worker exited without a result (${code}).`));
      else resolve(result);
    });
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
export async function readPdfLayout(sourcePath: string, projectRoot: string, signal?: AbortSignal): Promise<PdfLayout | undefined> {
  signal?.throwIfAborted();
  const key = path.resolve(projectRoot) + "\0" + path.resolve(sourcePath);
  const cached = verifiedBindings.get(key);
  if (cached) {
    const stamps = await Promise.all(cached.files.map(file => withRequiredWorkflowFile(file, () => fileStamp(file), signal)));
    if (stamps.every((value, index) => value === cached.stamps[index])) {
      verifiedBindings.delete(key); verifiedBindings.set(key, cached);
      return cached.layout;
    }
    verifiedBindings.delete(key);
  }
  try { await stat(sourcePath + ".pdf-layout.json"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NonRetryableAssignmentError(`Cannot read PDF layout: ${sourcePath}.pdf-layout.json`, error);
  }
  const started = performance.now(), journal = path.join(projectRoot,".translation-workshop","pdf","events.jsonl");
  await mkdir(path.dirname(journal),{recursive:true});
  const record = (event: string, details = {}) => appendFile(journal,JSON.stringify({event,sourcePath,at:new Date().toISOString(),elapsedMs:performance.now()-started,...details})+"\n");
  await record("binding_verification_started");
  let binding: VerifiedPdfBinding;
  try {
    binding = await runBindingWorker({ kind: "verify", sourcePath, projectRoot }, signal) as VerifiedPdfBinding;
    preservedSpansCache.set(binding.layout,binding.preservedSpans);
    await record("binding_verification_completed",{pages:binding.layout.pages.length,rows:binding.layout.blocks.length,
      academicPrescan:{sourceHash:binding.layout.sourceHash,preservedOccurrences:binding.preservedSpans.length,
        preservedIdentifiers:[...new Set(binding.preservedSpans.filter(span=>span.kind==='software'||span.kind==='acronym'||span.kind==='dataset').map(span=>span.text))]}});
  } catch (error) {
    try { await record(signal?.aborted ? "binding_verification_cancelled" : "binding_verification_failed",{error:error instanceof Error ? error.message : String(error)}); }
    catch (journalError) { throw new NonRetryableAssignmentError("PDF binding verification and diagnostics failed.",new AggregateError([error,journalError])); }
    throw error;
  }
  // Derived cache only: every access checks all three file identities. Changes invalidate
  // the cache and require complete worker verification; no Host authority comes from it.
  verifiedBindings.set(key, binding);
  if (verifiedBindings.size > 16) verifiedBindings.delete(verifiedBindings.keys().next().value!);
  return binding.layout;
}

const pdfPreparationTails=new Map<string,Promise<void>>();
function reservePdfPath(tails:Map<string,Promise<void>>,key:string) {
  const prior=tails.get(key)??Promise.resolve();let release!:()=>void;
  const own=new Promise<void>(resolve=>{release=resolve;});
  const barrier=prior.then(()=>own);tails.set(key,barrier);
  return {
    wait:(signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
      const abort=()=>{signal?.removeEventListener('abort',abort);reject(signal?.reason??new Error('PDF operation cancelled.'));};
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      void prior.then(()=>{signal?.removeEventListener('abort',abort);resolve();});
    }),
    release:()=>{release();void barrier.then(()=>{if(tails.get(key)===barrier)tails.delete(key);});}
  };
}
export async function preparePdfDocument(originalPath:string,workspaceDir:string,options:PdfStructurePreparationOptions&{onProgress?:(page:number,total:number)=>void}={}) {
  options={...currentPdfPreparationContext(),...options};
  const stage=options.onStage;options.onStage=(value,details)=>stage?.(value,{...details,sourcePath:originalPath});
  const key=path.resolve(workspaceDir)+'\0'+path.resolve(originalPath);
  const ownership=reservePdfPath(pdfPreparationTails,key);
  try {await ownership.wait(options.signal);options.signal?.throwIfAborted();return await preparePdfDocumentOwned(originalPath,workspaceDir,options);}
  finally {ownership.release();}
}
async function preparePdfDocumentOwned(originalPath: string, workspaceDir: string, options: PdfStructurePreparationOptions&{onProgress?: (page: number, total: number) => void}) {
  options.signal?.throwIfAborted();
  const projectRoot = path.dirname(workspaceDir);
  const identityPath = extractedWorkshopTextPath(workspaceDir, originalPath, "source");
  const originalHash = await runBindingWorker({ kind: "hash", file: originalPath }, options.signal) as string;
  const identityDirectory = path.dirname(path.dirname(identityPath));
  const sourcePath = path.join(path.dirname(identityDirectory), path.basename(identityDirectory) + "-pdf-" + originalHash.slice(0,16) + `-v${PDF_LAYOUT_VERSION}-e${PDF_EXTRACTOR_REVISION}-p${PDF_STRUCTURE_PROMPT_VERSION}`, "source", path.parse(originalPath).name + ".txt");
  const existing = await readPdfLayout(sourcePath, projectRoot, options.signal);
  if (existing) {
    if (path.resolve(existing.originalPath) !== path.resolve(originalPath) || originalHash !== existing.originalHash) throw new NonRetryableAssignmentError("PDF projection has an incompatible original binding. Start a new task.");
    const sourceBytes = await withRequiredWorkflowFile(sourcePath, () => readFile(sourcePath), options.signal);
    await runBindingWorker({ kind: "verify-assets", sourcePath, projectRoot }, options.signal);
    return { sourcePath, text: sourceBytes.toString("utf8"), originalHash: existing.originalHash, sourceHash: existing.sourceHash };
  }
  let hasMechanical=false;
  try {await stat(sourcePath+'.pdf-mechanical.json');hasMechanical=true;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try {if(!hasMechanical)await runPdfWorker({ kind: "extract", originalPath, projectRoot, sourcePath, fontPath: fontPath(),visualRowsOnly:options.visualRowsOnly!==false }, options.signal, options.onProgress);}
  catch (error) {
    if (options.signal?.aborted) throw error;
    throw new NonRetryableAssignmentError(`PDF extraction cannot safely prepare ${originalPath}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  const mechanical=(await runBindingWorker({kind:'verify-mechanical',sourcePath,projectRoot},options.signal) as VerifiedPdfBinding).layout;
  await runBindingWorker({kind:'verify-assets',sourcePath,projectRoot,pending:true},options.signal);
  const journal=path.join(projectRoot,'.translation-workshop','pdf','events.jsonl');
  const attemptId=randomUUID(),diagnosticDirectory=sourcePath+'.pdf-preparation-attempts/'+attemptId;
  const stageRecord=(stage:string,value:unknown)=>appendFile(journal,JSON.stringify({event:stage,kind:'structure',attemptId,at:new Date().toISOString(),sourcePath,...value as object})+'\n');
  const retain=async(stage:string,value:unknown)=>{
    const text=JSON.stringify(value),diagnosticPath=path.join(diagnosticDirectory,stage+'.json');
    await mkdir(diagnosticDirectory,{recursive:true});
    await writeTextFileAtomically(diagnosticPath,text);
    await writeTextFileAtomically(sourcePath+`.pdf-${stage}.json`,text);
    await stageRecord(stage,{retained:true,diagnosticPath:projectRelativePath(projectRoot,diagnosticPath)});
  };
  let prepared:Awaited<ReturnType<typeof improvePdfStructure>>;
  let committed=false;
  try {
    prepared=await improvePdfStructure(mechanical,projectRoot,options,retain,
      async(layout,plan)=>await runBindingWorker({kind:'apply-structure',layout,plan},options.signal));
    options.signal?.throwIfAborted();
    const finalMechanical=(await runBindingWorker({kind:'verify-mechanical',sourcePath,projectRoot},options.signal) as VerifiedPdfBinding).layout;
    if(finalMechanical.protectionHash!==mechanical.protectionHash)throw new Error('PDF mechanical structure changed during model preparation.');
    await runBindingWorker({kind:'verify-assets',sourcePath,projectRoot,pending:true},options.signal);
    if(await runBindingWorker({kind:'hash',file:originalPath},options.signal)!==originalHash)throw new Error('PDF changed before structure acceptance; no usable projection or HTML was committed.');
    // The layout is the sole commit record and is published last. A failed or
    // cancelled creation leaves inspectable candidate files, never a usable
    // projection. Accepted projections are reused and never overwritten here.
    await writeTextFileAtomically(sourcePath,prepared.sourceText,options.signal);
    options.signal?.throwIfAborted();
    await writeTextFileAtomically(sourcePath+'.pdf-structure.json',JSON.stringify(prepared.receipt),options.signal);
    options.signal?.throwIfAborted();
    await writeTextFileAtomically(sourcePath+'.pdf-layout.json',JSON.stringify(encodeProjectPaths(prepared.layout,projectRoot)),options.signal);
    committed=true;
    await stageRecord('accepted',{metrics:prepared.metrics,sourceHash:prepared.layout.sourceHash,planHash:prepared.layout.preparation!.planHash});
    options.onStage?.('accepted',{metrics:prepared.metrics});
  } catch(error) {
    let failure=error;
    try {await stageRecord(committed?'committed-operation-failed':options.signal?.aborted?'cancelled':'rejected',{error:pdfErrorDetails(error)});}
    catch(diagnosticError){failure=new AggregateError([error,diagnosticError],'PDF preparation and diagnostic persistence both failed.');}
    throw new NonRetryableAssignmentError(`PDF structure preparation failed for ${originalPath}: ${pdfErrorDetails(failure)}. ${committed?'Accepted source was retained. ':''}No review HTML was generated.`,failure);
  }
  const layout = await readPdfLayout(sourcePath, projectRoot,options.signal);
  if (!layout) throw new Error("PDF extraction did not commit its layout manifest.");
  return { sourcePath, text: await readFile(sourcePath, "utf8"), originalHash: layout.originalHash, sourceHash: layout.sourceHash };
}

const pdfExportTails=new Map<string,Promise<void>>();
export async function createTranslatedPdf(args: { templatePath: string; sourcePath: string; translatedLines: string[]; projectRoot: string; signal?: AbortSignal }) {
  const translatedLines=[...args.translatedLines];
  const layout = await readPdfLayout(args.sourcePath, args.projectRoot);
  if (!layout || path.resolve(layout.originalPath) !== path.resolve(args.templatePath)) throw new Error("PDF export template does not match this review's extracted source.");
  if (projectRelativePath(path.join(args.projectRoot, ".translation-workshop", "extracted-text"), args.sourcePath) === undefined) throw new Error("PDF export requires a project-owned source projection.");
  const relativeInput = projectRelativePath(args.projectRoot, args.templatePath);
  const outputDirectory = relativeInput ? path.dirname(relativeInput) : path.join("pdf", path.basename(path.dirname(path.dirname(args.sourcePath))));
  const outputPath = path.join(args.projectRoot, "AI_translation", outputDirectory, `${path.parse(args.templatePath).name}.translated.pdf`);
  const key=process.platform==='win32'?path.resolve(outputPath).toLowerCase():path.resolve(outputPath);
  const ownership=reservePdfPath(pdfExportTails,key);
  try {
  await ownership.wait(args.signal);args.signal?.throwIfAborted();
  const prepared=await runPdfWorker({ kind: "export", layoutPath: args.sourcePath + ".pdf-layout.json", projectRoot: args.projectRoot,
    lines: translatedLines, outputPath, fontPath: fontPath() }, args.signal);
  const journal=path.join(args.projectRoot,'.translation-workshop','pdf','events.jsonl'),started=performance.now();
  const record=(event:string,details={})=>appendFile(journal,JSON.stringify({event,kind:'print',at:new Date().toISOString(),elapsedMs:performance.now()-started,htmlPath:prepared.htmlPath,...details})+'\n');
  await record('started');
  try {
    const printed=await printPdfHtml(prepared.htmlPath,outputPath,args.signal);
    await record('completed',{pages:printed.pages,sourcePages:prepared.sourcePages,sourceLines:prepared.sourceLines,structure:prepared.structure});
    return {...prepared,pages:printed.pages};
  }catch(error){
    try{await record(args.signal?.aborted?'cancelled':'failed',{error:pdfErrorDetails(error)});}
    catch(journalError){throw new AggregateError([error,journalError],'PDF print and diagnostic persistence failed.');}
    throw error;
  }
  }finally{ownership.release();}
}

export async function pdfReferencesForRange(sourcePath: string, projectRoot: string, fromLine: number, toLine: number) {
  const layout = await readPdfLayout(sourcePath, projectRoot);
  if (!layout) {
    if (isPdfSourceProjection(sourcePath)) throw new RequiredWorkflowFileError(sourcePath + ".pdf-layout.json");
    return undefined;
  }
  const blocks = layout.blocks.filter(block => block.line >= fromLine && block.line <= toLine);
  const pages = new Set(blocks.flatMap(block => pdfBlockPages(layout,block)));
  const references = layout.references.filter(ref => pages.has(ref.page) || blocks.some(block => refersToCaption(block.text, ref.caption)))
    .map(({ id, page, caption, captionLine }) => ({ id, page, caption, captionLine }));
  const scannedSpans = preservedSpansCache.get(layout);
  if (!scannedSpans) throw new Error('Verified PDF binding is missing its academic preservation prescan.');
  const preservedSpans = scannedSpans.filter(span=>span.line>=fromLine&&span.line<=toLine);
  return { references, preservedSpans, segmentationWarnings:blocks.filter(block=>block.segmentation==='parallel-region').map(block=>({line:block.line,reason:'Unmarked aligned columns/table areas are ambiguous; this visual row remains independent. Do not complete neighboring rows here.'})),
    inlineProtections:blocks.flatMap(block=>(block.inlineProtections??[]).map(({token,text,kind,sourcePage,physicalLines})=>({line:block.line,token,text,kind,sourcePage,display:Boolean(physicalLines),readOnly:true}))), protectedLines: (await readPdfProtectedLines(sourcePath,projectRoot))!.filter(block=>block.line>=fromLine&&block.line<=toLine).map(block=>({...block,readOnly:true})),
    instruction: "Each PDF source row owns one logical paragraph or independent source region. Source-evidenced page continuations and sentences interrupted by display formulas are already joined; translate the complete row once, without completing or copying a neighboring row. The output is structured HTML with automatic wrapping and pagination, so translated length is not restricted by the original text box. Inline {{formula:pN:id}} / {{code:pN:id}} markers stand for original native glyphs; retain exact identity, count and paragraph ownership. They may be reordered within their paragraph to fit translated syntax. Display formula markers retain their original display image. inlineProtections supplies read-only original text and source pages. Translate the complete surrounding prose. PDF code, independent mathematical formulas and References/Bibliography sections are immutable Host-prepared rows. protectedLines is read-only context; never submit, copy, translate or diagnose those rows as untranslated. Translate only writable sourceBlocks or translatableLines; the Host retains protected content at its logical source row. preservedSpans are source-evidenced software names, dataset names, defined acronyms, labels and reference identifiers: retain them unless an explicit project glossary requests a different target; do not diagnose unchanged retained text as untranslated. Surrounding prose still needs translation. Images are read-only PDF context, not automatic model input. When a passage refers to a figure/table or needs visual context, call viewPdfReference with its reference id and source line." };
}

export async function readPdfPreservedSpans(sourcePath: string | undefined, projectRoot: string, signal?: AbortSignal): Promise<PdfPreservedSpan[] | undefined> {
  if (!sourcePath || !isPdfSourceProjection(sourcePath)) return undefined;
  const layout = await readPdfLayout(sourcePath,projectRoot,signal);
  if (!layout) throw new RequiredWorkflowFileError(sourcePath+'.pdf-layout.json');
  const spans=preservedSpansCache.get(layout);
  if (!spans) throw new Error('Verified PDF binding is missing its academic preservation prescan.');
  return spans;
}

export function isPdfSourceProjection(sourcePath: string): boolean {
  return /[\\/]\.translation-workshop[\\/]extracted-text[\\/][^\\/]+-pdf-[a-f0-9]{16}(?:-v\d+)?(?:-e\d+)?(?:-p\d+)?[\\/]source[\\/]/i.test(sourcePath);
}

const protectedRowsCache = new WeakMap<PdfLayout, PdfProtectedLine[]>();
export async function readPdfProtectedLines(sourcePath: string | undefined, projectRoot: string, signal?: AbortSignal): Promise<PdfProtectedLine[] | undefined> {
  if (!sourcePath || !isPdfSourceProjection(sourcePath)) return undefined;
  const layout = await readPdfLayout(sourcePath, projectRoot, signal);
  if (!layout) throw new RequiredWorkflowFileError(sourcePath + ".pdf-layout.json");
  let rows = protectedRowsCache.get(layout);
  if (!rows) {
    const references=pdfReferenceSections(layout).protectedLines;
    const map=new Map<number,PdfProtectedLine>(layout.blocks.filter(block=>block.protection).map(block=>[block.line,{line:block.line,kind:block.protection!,text:block.text}]));
    for(const row of references)map.set(row.line,row);
    rows=[...map.values()].sort((a,b)=>a.line-b.line);protectedRowsCache.set(layout,rows);
  }
  return rows;
}

/** Only actual PDF task bindings are checked; ordinary file references/history stay readable. */
export async function preflightPdfRequest(request: Pick<PiSessionPromptRequest, "sourcePath" | "sourceSelection" | "folderSourceDocuments" | "outputDir"> & {sourceRootSelection?: PiSessionPromptRequest["sourceSelection"]}, signal?: AbortSignal): Promise<void> {
  const paths = new Set([request.sourcePath, request.sourceSelection?.kind === "file" ? request.sourceSelection.path : undefined,
    ...(request.folderSourceDocuments ?? []).map(document => document.path)].filter((file): file is string => Boolean(file && isPdfSourceProjection(file))));
  for (const entry of request.folderSourceDocuments ?? []) {
    if (entry.projection?.kind === "pdf-text" && !isPdfSourceProjection(entry.path)) throw new NonRetryableAssignmentError(`PDF source lacks a protected project projection: ${entry.path}. Generate a new review from the original PDF.`);
  }
  for (const sourcePath of paths) {
    const layout = await readPdfLayout(sourcePath, request.outputDir, signal);
    if (!layout) throw new RequiredWorkflowFileError(sourcePath + ".pdf-layout.json");
    for (const entry of request.folderSourceDocuments ?? []) {
      if (entry.path !== sourcePath || entry.projection?.kind !== "pdf-text") continue;
      const root = request.sourceRootSelection?.kind === "folder" ? request.sourceRootSelection.path : request.sourceSelection?.kind === "folder" ? request.sourceSelection.path : request.sourcePath;
      const original = root ? path.resolve(root, entry.id) : undefined;
      if (!original || path.resolve(layout.originalPath) !== original || layout.originalHash !== entry.projection.originalHash
        || layout.sourceHash !== entry.projection.projectionHash) throw new NonRetryableAssignmentError(`PDF source provenance changed for ${entry.id}. Restore its binding before resuming.`);
    }
  }
}

/** Final write boundary for touched rows; no unrelated prose checks or extra apply gate. */
export async function assertPdfProtectedWrite(sourcePath: string | undefined, projectRoot: string, entries: Array<{ line: number; text: string }>, fullDocument = false): Promise<void> {
  const protectedLines = await readPdfProtectedLines(sourcePath, projectRoot);
  if (!protectedLines) return;
  const layout = (await readPdfLayout(sourcePath!, projectRoot))!;
  const map = new Map(protectedLines.map(entry => [entry.line, entry]));
  if (fullDocument) {
    if (entries.length !== layout.blocks.length) throw new Error(`PDF translation must retain all ${layout.blocks.length} source rows, including protected code/math.`);
    const supplied = new Map(entries.map(entry => [entry.line, entry.text]));
    for (const original of protectedLines) if (supplied.get(original.line) !== original.text) throw new Error(`PDF L${original.line}: protected ${original.kind} is missing or changed.`);
  }
  for (const entry of entries) {
    const original = map.get(entry.line);
    if (original && entry.text !== original.text) throw new Error(`PDF L${entry.line}: protected ${original.kind} must remain exactly identical to its source.`);
    const source=layout.blocks[entry.line-1];
    if (!source) throw new Error(`PDF write is outside its source at L${entry.line}.`);
    // Empty draft rows remain unfinished; nonempty rows retain inline ownership.
    if(entry.text.trim()||fullDocument) {
      try {splitPdfInlineTranslation(source.text,entry.text);}
      catch(error){throw new Error(`PDF L${entry.line}: ${error instanceof Error?error.message:String(error)}`);}
    }
  }
}

function refersToCaption(text: string, caption?: string): boolean {
  const labels = (value: string) => [...value.matchAll(/\b(Fig(?:ure)?\.?|Table)\s*(\d+(?:[.-]\d+)*)(?!\d)|([図图表])\s*([\d一二三四五六七八九十]+)(?![\d一二三四五六七八九十])/giu)]
    .map(match => `${/^table$/i.test(match[1] ?? "") || match[3] === "表" ? "table" : "figure"}:${match[2] ?? match[4]}`);
  const label = caption && labels(caption)[0];
  return Boolean(label && labels(text).includes(label));
}

export async function readPdfReferenceImage(sourcePath: string, projectRoot: string, id: string, sourceLine: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const layout = await readPdfLayout(sourcePath, projectRoot, signal);
  if (!layout) throw new RequiredWorkflowFileError(sourcePath + ".pdf-layout.json");
  const block = layout.blocks.find(block => block.line === sourceLine), ref = layout.references.find(ref => ref.id === id);
  if (!block || !ref || (!pdfBlockPages(layout,block).includes(ref.page) && !refersToCaption(block.text, ref.caption))) throw new Error("PDF reference must belong to the cited source paragraph's pages or be explicitly cited by its figure/table label.");
  const page = layout.pages.find(page => page.page === ref.page)!;
  const bytes = await withRequiredWorkflowFile(page.previewPath, () => readFile(page.previewPath), signal);
  if (hash(bytes) !== page.previewHash) throw new NonRetryableAssignmentError("PDF reference image changed; restore the project assets before resuming.");
  signal?.throwIfAborted();
  // Decode/crop off the Electron thread, only after an explicit visual request.
  let result: { data: string };
  try { result = await runPdfWorker({ kind: "reference", projectRoot, bytes, box: ref, pageWidth: page.width, pageHeight: page.height }, signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new NonRetryableAssignmentError(`PDF reference rendering failed: ${id}.`, error);
  }
  return { reference: { id, page: ref.page, sourceLine, caption: ref.caption }, data: result.data };
}
