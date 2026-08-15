import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type { PiSessionPromptRequest, PiSourceSelection } from "../../../shared/agent/piSessionContract.ts";
import { splitTextLines } from "../../../shared/validation/translationValidator.ts";
import { collectSourceTreeFiles, IGNORED_SOURCE_DIRECTORIES } from "../../sourceFileTree.ts";

export interface PiSourceDocument {
  id: string;
  path: string;
  lineCount: number;
}

export interface PiSourceManifest {
  kind: PiSourceSelection["kind"];
  rootPath: string;
  documents: PiSourceDocument[];
}

export interface PiBoundSourceRequest extends PiSessionPromptRequest {
  sourceDocumentId?: string;
  /** Original folder binding retained after this request is rebound to one document. */
  sourceRootSelection?: PiSourceSelection;
  priorTranslationDiscoveries?: {
    glossaryCandidates: unknown[];
    characterFacts: unknown[];
  };
}

const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm"
]);
const IGNORED_SOURCE_FILES = new Set(["character_bible.md"]);

function isInsidePath(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const comparableRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const comparableTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}${path.sep}`);
}

function projectRoot(outputDir: string): string {
  const resolved = path.resolve(outputDir);
  return path.basename(resolved).toLowerCase() === ".translation-workshop" ? path.dirname(resolved) : resolved;
}

function assertSourceOutsideGeneratedRoots(outputDir: string, sourceRoot: string): void {
  const root = projectRoot(outputDir);
  if (!isInsidePath(root, sourceRoot)) return;
  const topLevelDirectory = path.relative(root, sourceRoot).split(path.sep)[0]?.toLowerCase();
  if (topLevelDirectory && IGNORED_SOURCE_DIRECTORIES.has(topLevelDirectory)) {
    const extractedTextRoot = path.join(root, ".translation-workshop", "extracted-text");
    if (topLevelDirectory === ".translation-workshop" && isInsidePath(extractedTextRoot, sourceRoot)) {
      return;
    }
    throw new Error(`Source selection cannot be inside generated workspace/output directory ${path.join(root, topLevelDirectory)}.`);
  }
}

function selectionFrom(request: PiSessionPromptRequest): PiSourceSelection {
  if (request.sourceSelection) return request.sourceSelection;
  const sourcePath = request.sourcePath?.trim();
  if (!sourcePath) throw new Error("This Pi session has no source selection bound to it.");
  return { kind: "file", path: sourcePath };
}

function normalizeDocumentId(value: string | undefined): string {
  return value?.trim().replace(/\\/g, "/") || "";
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function comparableDocumentId(value: string): string {
  const normalized = normalizeDocumentId(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve a model/user supplied document reference without making spelling a
 * permission boundary. Canonical IDs remain authoritative, while absolute
 * paths and unique basenames are accepted to avoid token-wasting retry loops.
 */
export function resolvePiSourceDocument(
  manifest: PiSourceManifest,
  reference: string | undefined
): PiSourceDocument | undefined {
  const requested = reference?.trim();
  if (!requested) return undefined;
  if (path.isAbsolute(requested)) {
    const comparableRequested = comparablePath(requested);
    return manifest.documents.find((document) => comparablePath(document.path) === comparableRequested);
  }

  const comparableRequestedId = comparableDocumentId(requested);
  const exact = manifest.documents.find(
    (document) => comparableDocumentId(document.id) === comparableRequestedId
  );
  if (exact) return exact;

  const basename = path.posix.basename(normalizeDocumentId(requested));
  const comparableBasename = process.platform === "win32" ? basename.toLowerCase() : basename;
  const basenameMatches = manifest.documents.filter((document) => {
    const candidate = path.posix.basename(normalizeDocumentId(document.id));
    return (process.platform === "win32" ? candidate.toLowerCase() : candidate) === comparableBasename;
  });
  if (basenameMatches.length === 1) return basenameMatches[0];
  if (basenameMatches.length > 1) {
    throw new Error(
      `Source document reference ${reference} is ambiguous. Use one canonical id: ${basenameMatches.map((entry) => entry.id).join(", ")}.`
    );
  }
  return undefined;
}

/** Resolve a model-visible source document id to the Host-bound readable file. */
export function resolvePiReadablePath(
  request: PiSessionPromptRequest | PiBoundSourceRequest,
  inputPath: string
): string;
export function resolvePiReadablePath(
  request: PiSessionPromptRequest | PiBoundSourceRequest,
  inputPath: string | undefined
): string | undefined;
export function resolvePiReadablePath(
  request: PiSessionPromptRequest | PiBoundSourceRequest,
  inputPath: string | undefined
): string | undefined {
  const trimmed = inputPath?.trim();
  if (!trimmed || trimmed === "." || path.isAbsolute(trimmed)) return inputPath;

  const requestedId = normalizeDocumentId(trimmed);
  const boundDocumentId = "sourceDocumentId" in request
    ? normalizeDocumentId(request.sourceDocumentId)
    : "";
  const boundSourcePath = request.sourcePath?.trim();
  if (
    boundSourcePath
    && (
      requestedId === boundDocumentId
      || requestedId === normalizeDocumentId(path.basename(boundSourcePath))
    )
  ) {
    return path.resolve(boundSourcePath);
  }

  const extractedDocuments = request.folderSourceDocuments ?? [];
  const extractedDocument = extractedDocuments.find(
    (entry) => comparableDocumentId(entry.id) === comparableDocumentId(requestedId)
  ) ?? (() => {
    const requestedBasename = path.posix.basename(requestedId);
    const comparableBasename = process.platform === "win32"
      ? requestedBasename.toLowerCase()
      : requestedBasename;
    const matches = extractedDocuments.filter(
      (entry) => {
        const candidate = path.posix.basename(normalizeDocumentId(entry.id));
        return (process.platform === "win32" ? candidate.toLowerCase() : candidate) === comparableBasename;
      }
    );
    return matches.length === 1 ? matches[0] : undefined;
  })();
  return extractedDocument ? path.resolve(extractedDocument.path) : inputPath;
}

async function sourceDocument(id: string, filePath: string): Promise<PiSourceDocument> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new Error(`Source manifest entries cannot be symbolic links: ${filePath}`);
  if (!info.isFile()) throw new Error(`Source manifest entry is not a file: ${filePath}`);
  const text = await readFile(filePath, "utf8");
  return { id, path: path.resolve(filePath), lineCount: splitTextLines(text).length };
}

async function collectFolderFiles(rootPath: string): Promise<Array<{ id: string; path: string }>> {
  const files = await collectSourceTreeFiles(rootPath, (filePath) => (
    !IGNORED_SOURCE_FILES.has(path.basename(filePath).toLowerCase())
    && SUPPORTED_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  ));
  return files.map((file) => ({ id: file.relativePath, path: file.path }));
}

async function explicitFolderDocuments(
  request: PiSessionPromptRequest,
  rootPath: string
): Promise<PiSourceDocument[]> {
  const entries = request.folderSourceDocuments;
  if (!entries) return [];
  const extractedTextRoot = path.join(projectRoot(request.outputDir), ".translation-workshop", "extracted-text");
  const seen = new Set<string>();
  const documents: PiSourceDocument[] = [];
  for (const entry of entries) {
    const id = entry.id.trim().replace(/\\/g, "/");
    if (!id || path.posix.isAbsolute(id) || id.split("/").some((part) => part === ".." || !part)) {
      throw new Error(`Invalid folder source document id: ${entry.id}.`);
    }
    const comparableId = process.platform === "win32" ? id.toLowerCase() : id;
    if (seen.has(comparableId)) throw new Error(`Duplicate folder source document id: ${id}.`);
    seen.add(comparableId);
    const filePath = path.resolve(entry.path);
    if (isInsidePath(rootPath, filePath)) {
      // Current files are rediscovered from the authoritative project folder below.
      continue;
    }
    if (!isInsidePath(extractedTextRoot, filePath)) {
      throw new Error(`Folder source document ${id} is outside the selected folder and extracted-text workspace.`);
    }
    const originalPath = path.resolve(rootPath, ...id.split("/"));
    if (!isInsidePath(rootPath, originalPath)) throw new Error(`Invalid folder source document id: ${entry.id}.`);
    if (path.extname(originalPath).toLowerCase() !== ".epub") continue;
    try {
      const originalInfo = await lstat(originalPath);
      if (!originalInfo.isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const extension = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported extracted source file type ${extension || "(none)"}: ${filePath}.`);
    }
    documents.push(await sourceDocument(id, filePath));
  }
  return documents;
}

export async function resolvePiSourceManifest(request: PiSessionPromptRequest): Promise<PiSourceManifest> {
  const selection = selectionFrom(request);
  const rootPath = path.resolve(selection.path);
  assertSourceOutsideGeneratedRoots(request.outputDir, rootPath);
  const rootInfo = await lstat(rootPath);
  if (rootInfo.isSymbolicLink()) throw new Error(`Source selections cannot be symbolic links: ${rootPath}`);
  if (selection.kind === "file") {
    if (!rootInfo.isFile()) throw new Error(`The selected source is not a file: ${rootPath}`);
    const extension = path.extname(rootPath).toLowerCase();
    if (!SUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
      throw new Error(
        `Unsupported source file type ${extension || "(none)"}: ${rootPath}. `
        + "Regenerate the review HTML so Agent receives extracted UTF-8 text."
      );
    }
    return {
      kind: "file",
      rootPath,
      documents: [await sourceDocument(path.basename(rootPath), rootPath)]
    };
  }
  if (!rootInfo.isDirectory()) throw new Error(`The selected source is not a folder: ${rootPath}`);
  const discoveredFiles = await collectFolderFiles(rootPath);
  const extractedDocuments = await explicitFolderDocuments(request, rootPath);
  const documentsById = new Map<string, PiSourceDocument>();
  for (const file of discoveredFiles) {
    documentsById.set(file.id, await sourceDocument(file.id, file.path));
  }
  for (const document of extractedDocuments) documentsById.set(document.id, document);
  const documents = [...documentsById.values()].sort((left, right) => left.id.localeCompare(right.id));
  const files = documents.map((document) => ({ id: document.id, path: document.path }));
  if (files.length === 0) throw new Error(`No supported source files were found in ${rootPath}.`);
  const candidateOwners = new Map<string, string>();
  for (const file of files) {
    const parsed = path.posix.parse(file.id);
    const candidateId = path.posix.join(parsed.dir, `${parsed.name}_translated.txt`).toLowerCase();
    const existing = candidateOwners.get(candidateId);
    if (existing) {
      throw new Error(`Source files ${existing} and ${file.id} would overwrite the same translation candidate ${candidateId}.`);
    }
    candidateOwners.set(candidateId, file.id);
  }
  return {
    kind: "folder",
    rootPath,
    documents
  };
}

export function bindPiSourceDocument(
  request: PiSessionPromptRequest,
  document: PiSourceDocument
): PiBoundSourceRequest {
  return {
    ...request,
    sourcePath: document.path,
    sourceSelection: { kind: "file", path: document.path },
    sourceRootSelection: request.sourceSelection?.kind === "folder"
      ? request.sourceSelection
      : (request as PiBoundSourceRequest).sourceRootSelection,
    sourceDocumentId: document.id
  };
}

export function requestDocumentId(request: PiBoundSourceRequest): string {
  return request.sourceDocumentId?.trim() || path.basename(request.sourcePath || "translation.txt");
}
