import path from "node:path";
import { readFile } from "node:fs/promises";
import { decodeProjectPaths, encodeProjectPaths, PROJECT_PATH_FIELDS, PROJECT_PATH_FIELD_PATTERN } from "./projectPaths.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";
import { buildPrompt } from "../shared/core/prompts.ts";

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

export function resolveReviewHtmlPaths(html: string, file: string): string {
  return html.replace(payloadPattern, (_match, opening, kind, json, closing) => {
    let data: any;
    try { data = JSON.parse(json); }
    catch (error) { throw new Error(`Review data cannot be migrated: ${file}`, { cause: error }); }
    const portable = data.projectPaths?.version === 1;
    const root = containedProjectRoot(file) || (portable
      ? path.resolve(path.dirname(file), data.projectPaths.rootFromHtml)
      : payloadRoot(data));
    if (!root) return _match;
    const resolved = transformPayload(data, (value) => decodeProjectPaths(value, root, portable ? undefined : payloadRoot(data)));
    if (kind === "reviewData") resolved.lineReviewPath = path.resolve(file);
    refreshGeneratedPrompts(resolved);
    return opening + JSON.stringify(resolved).replace(/</g, "\\u003c") + closing;
  });
}

export function portableReviewHtml(html: string, file: string): string {
  const resolved = resolveReviewHtmlPaths(html, file).replace(decoderPattern, "");
  const match = payloadPattern.exec(resolved);
  if (!match) return html;
  const data = JSON.parse(match[3]);
  const root = containedProjectRoot(file) || payloadRoot(data);
  if (!root) return html;
  const encoded = transformPayload(data, (value) => encodeProjectPaths(value, root));
  refreshGeneratedPrompts(encoded);
  encoded.projectPaths = { version: 1, rootFromHtml: path.relative(path.dirname(file), root).replace(/\\/g, "/") || "." };
  const decoder = `<script id="yn-project-paths">
(() => {
  if (location.protocol !== "file:") return;
  const element = document.getElementById(${JSON.stringify(match[2])});
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
  if (${JSON.stringify(match[2])} === "reviewData") resolved.lineReviewPath = filePath(new URL(location.href.split("#")[0]));
  element.textContent = JSON.stringify(resolved);
})();
</script>`;
  return resolved.replace(payloadPattern, (_match, opening, _kind, _json, closing) => opening + JSON.stringify(encoded).replace(/</g, "\\u003c") + closing + "\n" + decoder);
}

export async function readReviewHtml(file: string): Promise<string> {
  return resolveReviewHtmlPaths(await readFile(file, "utf8"), file);
}

export async function writeReviewHtml(file: string, html: string): Promise<void> {
  await writeTextFileAtomically(file, portableReviewHtml(html, file));
}
