import path from "node:path";
import { readFile } from "node:fs/promises";
import { decodeProjectPaths, encodeProjectPaths, PROJECT_PATH_FIELDS, PROJECT_PATH_FIELD_PATTERN } from "./projectPaths.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";
import { buildPrompt } from "../shared/core/prompts.ts";
import { readPdfProtectedLines, readPdfLayout } from "./pdfDocuments.ts";
import {currentPdfPreparationContext} from './pdfStructurePreparation.ts';

const payloadPattern = /(<script id="(reviewData|proposalData|batchData)" type="application\/json">)([\s\S]*?)(<\/script>)/i;
const decoderPattern = /\n?<script id="yn-project-paths">[\s\S]*?<\/script>/i;

export function containedProjectRoot(file: string): string | undefined {
  let current = path.dirname(path.resolve(file));
  while (path.dirname(current) !== current) {
    if (path.basename(current).toLowerCase() === ".translation-workshop") return path.dirname(current);
    current = path.dirname(current);
  }
  return undefined;
}

function payloadRoot(data: any): string | undefined {
  const root = data.workflow?.paths?.outputDir || data.folderAgentRoute?.outputDir || data.outputDir;
  return typeof root === "string" && (path.isAbsolute(root) || path.win32.isAbsolute(root)) ? root : undefined;
}

// Batch outputPath is already relative to the index HTML, not the project root.
function transformPayload(data: any, transform: (data: any) => any): any {
  const converted = transform(data);
  if (Array.isArray(data.files)) converted.files.forEach((file: any, index: number) => { file.outputPath = data.files[index].outputPath; });
  return converted;
}

function refreshGeneratedPrompts(data: any): void {
  const workflow = data.workflow;
  if (workflow?.paths && workflow.prompts) {
    const paths = workflow.paths;
    const options = { sourcePath: paths.promptSourcePath || paths.sourcePath, sourceKind: paths.promptSourceKind || paths.sourceKind,
      translationPath: paths.promptTranslationPath || undefined, outputDir: paths.outputDir, glossaryPath: paths.glossaryPath || undefined,
      inputMode: workflow.promptInputMode || workflow.inputMode, advanced: workflow.advanced };
    workflow.prompts = { translate: buildPrompt({ kind: "translate", ...options }), proofread: buildPrompt({ kind: "proofread", ...options }) };
  }
  const route = data.folderAgentRoute;
  if (route) route.initialPrompt = buildPrompt({ kind: "translate", sourcePath: route.sourcePath, sourceKind: "folder",
    translationPath: route.translationPath, outputDir: route.outputDir, glossaryPath: route.glossaryPath, inputMode: route.inputMode, advanced: route.advanced });
}

export interface ParsedReviewHtml {
  filePath:string; originalHtml:string; kind?:'reviewData'|'proposalData'|'batchData'; payload?:any; root?:string;
  boundChanged?:boolean;
}
/** One invocation owns one parsed document; this is never a cross-open cache. */
export function parseReviewHtml(html:string,file:string):ParsedReviewHtml {
    const match=payloadPattern.exec(html);
    if(!match)return {filePath:file,originalHtml:html};
    let data: any;
    try { data = JSON.parse(match[3]); }
    catch (error) { throw new Error(`Review data cannot be migrated: ${file}`, { cause: error }); }
    const portable = data.projectPaths?.version === 1;
    const root = containedProjectRoot(file) || (portable
      ? path.resolve(path.dirname(file), data.projectPaths.rootFromHtml)
      : payloadRoot(data));
    const resolved=root?transformPayload(data, (value) => decodeProjectPaths(value, root, portable ? undefined : payloadRoot(data))):data;
    if(root){if(match[2]==='reviewData')resolved.lineReviewPath=path.resolve(file);refreshGeneratedPrompts(resolved);}
    return {filePath:file,originalHtml:html,kind:match[2] as ParsedReviewHtml['kind'],payload:resolved,root};
}
export function resolvedReviewHtml(context:ParsedReviewHtml):string {
  if(!context.kind||!context.root&&!context.boundChanged)return context.originalHtml;
  return context.originalHtml.replace(payloadPattern,(_match,open,_kind,_json,close)=>open+JSON.stringify(context.payload).replace(/</g,'\\u003c')+close);
}
export function resolveReviewHtmlPaths(html: string, file: string): string {
  return resolvedReviewHtml(parseReviewHtml(html,file));
}

export function portableReviewHtml(html: string, file: string): string {
  return portableParsedReviewHtml(parseReviewHtml(html,file));
}
export function portableParsedReviewHtml(context:ParsedReviewHtml):string {
  const {filePath:file,payload:data,root}=context;
  if(!context.kind||!root)return context.originalHtml;
  const resolved=context.originalHtml.replace(decoderPattern,'');
  const encoded = transformPayload(data, (value) => encodeProjectPaths(value, root));
  refreshGeneratedPrompts(encoded);
  encoded.projectPaths = { version: 1, rootFromHtml: path.relative(path.dirname(file), root).replace(/\\/g, "/") || "." };
  const decoder = `<script id="yn-project-paths">
(() => {
  if (location.protocol !== "file:") return;
  const element = document.getElementById(${JSON.stringify(context.kind)});
  const data = JSON.parse(element.textContent);
  const escapedPath = value => value.replace(/\\\\/g, "/").split("/").map(encodeURIComponent).join("/");
  const root = new URL(escapedPath(data.projectPaths.rootFromHtml) + "/", location.href);
  const fields = new Set(${JSON.stringify(PROJECT_PATH_FIELDS)});
  const pattern = new RegExp(${JSON.stringify(PROJECT_PATH_FIELD_PATTERN)});
  const filePath = url => {
    let value = decodeURIComponent(url.pathname);
    if (url.hostname) return "\\\\\\\\" + url.hostname + value.replace(/\\//g, "\\\\");
    if (/^\\/[a-z]:\\//i.test(value)) value = value.slice(1).replace(/\\//g, "\\\\");
    return value.length > 3 ? value.replace(/[\\\\/]$/, "") : value;
  };
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (!(pattern.test(key) || fields.has(key)) || !value || value.startsWith("[") || /^(?:[a-z]:[\\\\/]|\\\\\\\\|\\/|[a-z][a-z\\d+.-]*:\\/\\/)/i.test(value)) return value;
      return filePath(new URL(escapedPath(value), root));
    }
    if (Array.isArray(value)) return value.map(item => visit(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  const resolved = visit(data);
  if (Array.isArray(data.files)) resolved.files.forEach((file, index) => { file.outputPath = data.files[index].outputPath; });
  if (${JSON.stringify(context.kind)} === "reviewData") resolved.lineReviewPath = filePath(new URL(location.href.split("#")[0]));
  element.textContent = JSON.stringify(resolved);
})();
</script>`;
  return resolved.replace(payloadPattern, (_match, opening, _kind, _json, closing) => opening + JSON.stringify(encoded).replace(/</g, "\\u003c") + closing + "\n" + decoder);
}

export async function readReviewHtml(file: string): Promise<string> {
  return resolveReviewHtmlPaths(await readFile(file, "utf8"), file);
}

export async function bindPdfReviewHtml(file: string, html: string): Promise<string> {
  const context=parseReviewHtml(html,file);
  await bindParsedPdfReviewHtml(context);
  return context.boundChanged?resolvedReviewHtml(context):html;
}
export async function bindParsedPdfReviewHtml(context:ParsedReviewHtml):Promise<void> {
  if(context.kind==='reviewData') {
    const data=context.payload,paths=data.workflow?.paths;
    const protections = paths?.outputDir ? await readPdfProtectedLines(paths.validationSourcePath, paths.outputDir) : undefined;
    if (protections) {
      const layout=(await readPdfLayout(paths.validationSourcePath,paths.outputDir))!;
      if(!Array.isArray(data.rows)||data.rows.length!==layout.blocks.length||data.rows.some((row:any,index:number)=>row?.line!==index+1)) {
        throw new Error(`PDF HTML row coverage differs from its accepted source: expected ${layout.blocks.length} uniquely numbered rows.`);
      }
      const protectedRows = new Map(protections.map(entry => [entry.line, entry]));
      for (const row of data.rows) {
        const protection = protectedRows.get(row.line);
        if (protection && row.source !== protection.text) throw new Error(`PDF HTML protected source changed at L${row.line}.`);
        const fields={pdfProtection:protection?.kind,pdfInlineProtections:undefined as unknown,pdfSegmentation:undefined as unknown};
        const block=layout.blocks[row.line-1];
        if(!block||block.text!==row.source)throw new Error(`PDF HTML paragraph source changed at L${row.line}.`);
        fields.pdfInlineProtections=block.inlineProtections?.map(({token,text,kind})=>({token,text,kind}));fields.pdfSegmentation=block.segmentation;
        for(const [key,value]of Object.entries(fields))if(JSON.stringify(row[key])!==JSON.stringify(value)){row[key]=value;context.boundChanged=true;}
      }
    }
  }
}
export async function writeReviewHtml(file: string, html: string): Promise<void> {
  currentPdfPreparationContext()?.signal?.throwIfAborted();
  const context=parseReviewHtml(html,file);await bindParsedPdfReviewHtml(context);
  const prepared=portableParsedReviewHtml(context);
  currentPdfPreparationContext()?.signal?.throwIfAborted();
  await writeTextFileAtomically(file,prepared,currentPdfPreparationContext()?.signal);
}
