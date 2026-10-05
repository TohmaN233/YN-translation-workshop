import path from "node:path";

// Only structured file bindings are transformed. Prompts, source text, reports,
// hashes, document ids and regexes must remain byte-for-byte unchanged.
export const PROJECT_PATH_FIELD_PATTERN = "(?:Path|Dir|Root)$";
export const PROJECT_PATH_FIELDS = ["path", "cwd", "syncedFile", "savedTxtFile", "savedEpubFile", "lastHtml", "lastLineReviewHtml", "lastProposalReviewHtml", "lastOutput", "sourceFolder", "translationFolder", "parentSessionPath"];
const pathField = new RegExp(PROJECT_PATH_FIELD_PATTERN);
const extraFields = new Set(PROJECT_PATH_FIELDS);

function filePathApi(value: string) { return /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? path.win32 : path; }
function absolute(value: string): boolean { return path.isAbsolute(value) || path.win32.isAbsolute(value); }
export function projectRelativePath(root: string, value: string): string | undefined {
  if (!absolute(value)) return undefined;
  const api = filePathApi(root);
  const relative = api.relative(root, value);
  if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
  return relative.replace(/\\/g, "/") || ".";
}

function transform<T>(value: T, convert: (value: string, key: string) => string, key = ""): T {
  if (typeof value === "string") return ((pathField.test(key) || extraFields.has(key)) ? convert(value, key) : value) as T;
  if (Array.isArray(value)) return value.map((item) => transform(item, convert, key)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, transform(item, convert, name)])) as T;
  return value;
}

export function encodeProjectPaths<T>(value: T, root: string): T {
  return transform(value, (file) => file && projectRelativePath(root, file) || file);
}

/** Resolve runtime bindings without rewriting immutable Pi history or content hashes. */
export function decodeProjectPaths<T>(value: T, root: string, legacyRoot?: string): T {
  const partialMove = legacyRoot && projectRelativePath(legacyRoot, root) !== undefined && projectRelativePath(legacyRoot, root) !== ".";
  return transform(value, (file, key) => {
    if (!file || file.startsWith("[") || /^[a-z][a-z\d+.-]*:\/\//i.test(file)) return file;
    if (!absolute(file)) return path.resolve(root, file.replace(/[/\\]/g, path.sep));
    if (!legacyRoot) return file;
    const relative = projectRelativePath(legacyRoot, file);
    if (relative === undefined) return file;
    // Moving only the generated project into a child directory does not move
    // explicitly selected source/reference files still in the original parent.
    if (partialMove && key !== "outputDir" && relative !== "." && !/^(?:\.translation-workshop|AI_translation|report)(?:\/|$)/i.test(relative)) return file;
    return path.resolve(root, relative.replace(/\//g, path.sep));
  });
}
