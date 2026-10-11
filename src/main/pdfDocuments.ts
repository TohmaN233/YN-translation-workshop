import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { extractedWorkshopTextPath } from "./agent/translationBindingResolve.ts";
import { decodeProjectPaths, projectRelativePath } from "./projectPaths.ts";
import { validatePdfLayout, type PdfLayout, type PdfWorkerOperation } from "./pdfTypes.ts";
import { RequiredWorkflowFileError, withRequiredWorkflowFile } from "./agent/requiredWorkflowFile.ts";
import { NonRetryableAssignmentError } from "./agent/piNative/assignmentFailure.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
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
      const abort = () => { failure ??= signal?.reason ?? new Error("PDF operation cancelled."); void worker.terminate().catch(error => { failure = new AggregateError([failure, error], "PDF worker cancellation failed."); }); };
      worker.on("message", message => {
        if (message.type === "result") result = message.result;
        else if (message.type === "error") failure ??= new Error(message.error);
        else if (message.type === "progress") {
          try { onProgress?.(message.page, message.total); }
          catch (error) { failure ??= error; abort(); }
        }
      });
      worker.once("error", error => { failure ??= error; });
      worker.once("exit", code => {
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new Error(`PDF worker exited without a result (${code}).`));
        else resolve(result);
      });
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
    signal?.throwIfAborted();
    await record("completed", { pages: result.pages });
    return result;
  } catch (error) {
    try { await record(signal?.aborted ? "cancelled" : "failed", { error: error instanceof Error ? error.message : String(error) }); }
    catch (journalError) { throw new AggregateError([error, journalError], "PDF operation and diagnostic persistence failed."); }
    throw error;
  }
}

export async function readPdfLayout(sourcePath: string, projectRoot: string): Promise<PdfLayout | undefined> {
  let bytes: string;
  try { bytes = await readFile(sourcePath + ".pdf-layout.json", "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NonRetryableAssignmentError(`Cannot read PDF layout: ${sourcePath}.pdf-layout.json`, error);
  }
  let layout: PdfLayout;
  try {
    layout = decodeProjectPaths(JSON.parse(bytes) as PdfLayout, projectRoot);
    validatePdfLayout(layout);
    if (path.resolve(layout.sourcePath) !== path.resolve(sourcePath)) throw new Error("PDF source binding differs from this projection.");
    const assetRoot = path.dirname(sourcePath);
    for (const page of layout.pages) {
      if (projectRelativePath(assetRoot, page.backgroundPath) === undefined || projectRelativePath(assetRoot, page.previewPath) === undefined) throw new Error("PDF asset escaped its projection directory.");
    }
  }
  catch (error) { throw new NonRetryableAssignmentError(`Invalid PDF layout JSON: ${sourcePath}.pdf-layout.json`, error); }
  return layout;
}

export async function preparePdfDocument(originalPath: string, workspaceDir: string, options: { signal?: AbortSignal; onProgress?: (page: number, total: number) => void } = {}) {
  options.signal?.throwIfAborted();
  const projectRoot = path.dirname(workspaceDir);
  const identityPath = extractedWorkshopTextPath(workspaceDir, originalPath, "source");
  const originalHash = hash(await readFile(originalPath, { signal: options.signal }));
  const identityDirectory = path.dirname(path.dirname(identityPath));
  const sourcePath = path.join(path.dirname(identityDirectory), path.basename(identityDirectory) + "-pdf-" + originalHash.slice(0,16), "source", path.parse(originalPath).name + ".txt");
  const existing = await readPdfLayout(sourcePath, projectRoot);
  if (existing) {
    if (path.resolve(existing.originalPath) !== path.resolve(originalPath) || originalHash !== existing.originalHash) throw new NonRetryableAssignmentError("PDF projection has an incompatible original binding. Start a new task.");
    const sourceBytes = await withRequiredWorkflowFile(sourcePath, () => readFile(sourcePath), options.signal);
    if (hash(sourceBytes) !== existing.sourceHash) throw new NonRetryableAssignmentError(`PDF source projection changed: ${sourcePath}. Restore the bound projection before resuming; it was not overwritten.`);
    for (const page of existing.pages) {
      for (const [file, digest] of [[page.backgroundPath, page.backgroundHash], [page.previewPath, page.previewHash]]) {
        if (hash(await withRequiredWorkflowFile(file, () => readFile(file), options.signal)) !== digest) throw new NonRetryableAssignmentError(`PDF asset changed: ${file}. Restore it before resuming.`);
      }
    }
    return { sourcePath, text: sourceBytes.toString("utf8"), originalHash: existing.originalHash, sourceHash: existing.sourceHash };
  }
  await runPdfWorker({ kind: "extract", originalPath, projectRoot, sourcePath, fontPath: fontPath() }, options.signal, options.onProgress);
  const layout = await readPdfLayout(sourcePath, projectRoot);
  if (!layout) throw new Error("PDF extraction did not commit its layout manifest.");
  return { sourcePath, text: await readFile(sourcePath, "utf8"), originalHash: layout.originalHash, sourceHash: layout.sourceHash };
}

export async function createTranslatedPdf(args: { templatePath: string; sourcePath: string; translatedLines: string[]; projectRoot: string; signal?: AbortSignal }) {
  const layout = await readPdfLayout(args.sourcePath, args.projectRoot);
  if (!layout || path.resolve(layout.originalPath) !== path.resolve(args.templatePath)) throw new Error("PDF export template does not match this review's extracted source.");
  if (projectRelativePath(path.join(args.projectRoot, ".translation-workshop", "extracted-text"), args.sourcePath) === undefined) throw new Error("PDF export requires a project-owned source projection.");
  const relativeInput = projectRelativePath(args.projectRoot, args.templatePath);
  const outputDirectory = relativeInput ? path.dirname(relativeInput) : path.join("pdf", path.basename(path.dirname(path.dirname(args.sourcePath))));
  const outputPath = path.join(args.projectRoot, "AI_translation", outputDirectory, `${path.parse(args.templatePath).name}.translated.pdf`);
  return runPdfWorker({ kind: "export", layoutPath: args.sourcePath + ".pdf-layout.json", projectRoot: args.projectRoot,
    lines: args.translatedLines, outputPath, fontPath: fontPath() }, args.signal);
}

export async function pdfReferencesForRange(sourcePath: string, projectRoot: string, fromLine: number, toLine: number) {
  const layout = await readPdfLayout(sourcePath, projectRoot);
  if (!layout) {
    if (isPdfSourceProjection(sourcePath)) throw new RequiredWorkflowFileError(sourcePath + ".pdf-layout.json");
    return undefined;
  }
  const blocks = layout.blocks.filter(block => block.line >= fromLine && block.line <= toLine);
  const pages = new Set(blocks.map(block => block.page));
  const references = layout.references.filter(ref => pages.has(ref.page) || blocks.some(block => refersToCaption(block.text, ref.caption)))
    .map(({ id, page, caption, captionLine }) => ({ id, page, caption, captionLine }));
  return { references, instruction: "Images are read-only PDF context, not automatic model input. When a passage refers to a figure/table or its interpretation needs visual context, call viewPdfReference with the corresponding reference id and source line. Otherwise translate the text without viewing images." };
}

export function isPdfSourceProjection(sourcePath: string): boolean {
  return /[\\/]\.translation-workshop[\\/]extracted-text[\\/][^\\/]+-pdf-[a-f0-9]{16}[\\/]source[\\/]/i.test(sourcePath);
}

function refersToCaption(text: string, caption?: string): boolean {
  const labels = (value: string) => [...value.matchAll(/\b(Fig(?:ure)?\.?|Table)\s*(\d+(?:[.-]\d+)*)(?!\d)|([図图表])\s*([\d一二三四五六七八九十]+)(?![\d一二三四五六七八九十])/giu)]
    .map(match => `${/^table$/i.test(match[1] ?? "") || match[3] === "表" ? "table" : "figure"}:${match[2] ?? match[4]}`);
  const label = caption && labels(caption)[0];
  return Boolean(label && labels(text).includes(label));
}

export async function readPdfReferenceImage(sourcePath: string, projectRoot: string, id: string, sourceLine: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const layout = await readPdfLayout(sourcePath, projectRoot);
  if (!layout) throw new RequiredWorkflowFileError(sourcePath + ".pdf-layout.json");
  const block = layout.blocks.find(block => block.line === sourceLine), ref = layout.references.find(ref => ref.id === id);
  if (!block || !ref || (block.page !== ref.page && !refersToCaption(block.text, ref.caption))) throw new Error("PDF reference must belong to the cited source line's page or be explicitly cited by its figure/table label.");
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
