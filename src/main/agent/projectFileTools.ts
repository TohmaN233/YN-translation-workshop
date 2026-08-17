import { mkdir, readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import { relativeProjectPath, resolveProjectPath, resolveReadablePath } from "./projectPathGuard.ts";

function optionalProjectRoot(value?: string): string {
  return value?.trim() || ".";
}

function isSameOrInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const compareRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const compareTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  return compareTarget === compareRoot || compareTarget.startsWith(`${compareRoot}${path.sep}`);
}

function runtimeHistoryRoot(outputDir: string): string {
  return path.resolve(outputDir, ".translation-workshop", "agent");
}

function translationStagingRoot(outputDir: string): string {
  return path.resolve(runtimeHistoryRoot(outputDir), "translation-staging");
}

function isRuntimeHistoryPath(outputDir: string, target: string): boolean {
  return isSameOrInside(runtimeHistoryRoot(outputDir), target);
}

function isTranslationStagingPath(outputDir: string, target: string): boolean {
  return isSameOrInside(translationStagingRoot(outputDir), target);
}

function runtimeSessionRoots(outputDir: string): string[] {
  const root = runtimeHistoryRoot(outputDir);
  return [path.join(root, "pi-sessions"), path.join(root, "pi-child-sessions")];
}

function isRuntimeSessionPath(outputDir: string, target: string): boolean {
  return runtimeSessionRoots(outputDir).some((root) => isSameOrInside(root, target));
}

function isRuntimeSecretPath(outputDir: string, target: string): boolean {
  const secrets = path.resolve(runtimeHistoryRoot(outputDir), "oauth-secrets.json");
  const compareTarget = process.platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target);
  const compareSecrets = process.platform === "win32" ? secrets.toLowerCase() : secrets;
  return compareTarget === compareSecrets;
}

export type ProjectToolReadAccess = {
  allowRuntimeSessionRead?: boolean;
};

export const RUNTIME_HISTORY_READ_ERROR = "Pi runtime session data is not readable through project tools.";
export const RUNTIME_SECRET_READ_ERROR = "Agent OAuth secrets are not readable through project tools.";
export const TRANSLATION_STAGING_PROJECT_TOOL_ERROR = [
  "Unpromoted translation staging is Host-owned and cannot be browsed with project file tools.",
  "Empty canonical translation lines mean the accepted draft is still in staging, not that the range is missing.",
  "Call inspectTranslationAlignment, then readTranslationAlignmentRows.",
  "Repair only Host-listed rejected lines with writeTranslationChunk. Do not retranslate the whole assignment."
].join(" ");

function runtimeProjectToolError(
  outputDir: string,
  target: string,
  access: ProjectToolReadAccess = {}
): string | undefined {
  if (!isRuntimeHistoryPath(outputDir, target)) return undefined;
  if (isTranslationStagingPath(outputDir, target)) return TRANSLATION_STAGING_PROJECT_TOOL_ERROR;
  if (isRuntimeSecretPath(outputDir, target)) return RUNTIME_SECRET_READ_ERROR;
  const resolvedTarget = path.resolve(target);
  const historyRoot = runtimeHistoryRoot(outputDir);
  const sameHistoryRoot = process.platform === "win32"
    ? resolvedTarget.toLowerCase() === historyRoot.toLowerCase()
    : resolvedTarget === historyRoot;
  if (access.allowRuntimeSessionRead && (isRuntimeSessionPath(outputDir, target) || sameHistoryRoot)) {
    return undefined;
  }
  return RUNTIME_HISTORY_READ_ERROR;
}

function shouldHideRuntimeHistoryEntry(
  outputDir: string,
  entryPath: string,
  access: ProjectToolReadAccess = {}
): boolean {
  if (!isRuntimeHistoryPath(outputDir, entryPath)) return false;
  if (isTranslationStagingPath(outputDir, entryPath) || isRuntimeSecretPath(outputDir, entryPath)) return true;
  const resolvedEntry = path.resolve(entryPath);
  const historyRoot = runtimeHistoryRoot(outputDir);
  const sameHistoryRoot = process.platform === "win32"
    ? resolvedEntry.toLowerCase() === historyRoot.toLowerCase()
    : resolvedEntry === historyRoot;
  if (access.allowRuntimeSessionRead && (isRuntimeSessionPath(outputDir, entryPath) || sameHistoryRoot)) {
    return false;
  }
  return true;
}

export async function readProjectFile(args: {
  outputDir: string;
  relativePath: string;
  offsetChars?: number;
  maxChars?: number;
  allowRuntimeSessionRead?: boolean;
}): Promise<{
  ok: true;
  path: string;
  relativePath: string;
  outsideProject: boolean;
  content: string;
  truncated: boolean;
  offsetChars: number;
  totalChars: number;
  nextOffsetChars?: number;
} | { ok: false; error: string }> {
  try {
    const resolved = resolveReadablePath(args.outputDir, args.relativePath);
    const filePath = resolved.path;
    const runtimeError = !resolved.outsideProject
      ? runtimeProjectToolError(args.outputDir, filePath, args)
      : undefined;
    if (runtimeError) {
      return { ok: false, error: runtimeError };
    }
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { ok: false, error: "Path is not a file." };
    }
    const maxChars = args.maxChars ?? 48_000;
    if (!Number.isInteger(maxChars) || maxChars < 1) {
      return { ok: false, error: "maxChars must be a positive integer." };
    }
    const requestedOffset = args.offsetChars ?? 0;
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
      return { ok: false, error: "offsetChars must be a non-negative integer." };
    }
    const raw = await readFile(filePath, "utf8");
    const offsetChars = Math.min(requestedOffset, raw.length);
    const pageEnd = Math.min(raw.length, offsetChars + maxChars);
    const nextOffsetChars = pageEnd < raw.length ? pageEnd : undefined;
    const truncated = offsetChars > 0 || nextOffsetChars !== undefined;
    const page = raw.slice(offsetChars, pageEnd);
    const content = nextOffsetChars === undefined
      ? page
      : `${page}\n\n[…page ${offsetChars}-${pageEnd} of ${raw.length} chars…]`;
    return {
      ok: true,
      path: filePath,
      relativePath: resolved.relativePath,
      outsideProject: resolved.outsideProject,
      content,
      truncated,
      offsetChars,
      totalChars: raw.length,
      ...(nextOffsetChars === undefined ? {} : { nextOffsetChars })
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeProjectFile(args: {
  outputDir: string;
  relativePath: string;
  content: string;
  append?: boolean;
}): Promise<{ ok: true; path: string; relativePath: string; bytesWritten: number; appended: boolean } | { ok: false; error: string }> {
  try {
    const filePath = resolveProjectPath(args.outputDir, args.relativePath);
    if (isRuntimeHistoryPath(args.outputDir, filePath)) {
      return { ok: false, error: "Pi runtime session data cannot be written through project tools." };
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = String(args.content ?? "");
    if (args.append) {
      await appendFile(filePath, content, "utf8");
    } else {
      await writeFile(filePath, content, "utf8");
    }
    return {
      ok: true,
      path: filePath,
      relativePath: relativeProjectPath(args.outputDir, filePath),
      bytesWritten: Buffer.byteLength(content, "utf8"),
      appended: args.append === true
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listProjectDir(args: {
  outputDir: string;
  relativePath?: string;
  maxEntries?: number;
  allowRuntimeSessionRead?: boolean;
}): Promise<{ ok: true; path: string; relativePath: string; outsideProject: boolean; entries: Array<{ name: string; kind: "file" | "dir"; size?: number }> } | { ok: false; error: string }> {
  try {
    const resolved = resolveReadablePath(args.outputDir, optionalProjectRoot(args.relativePath));
    const dirPath = resolved.path;
    const runtimeError = !resolved.outsideProject
      ? runtimeProjectToolError(args.outputDir, dirPath, args)
      : undefined;
    if (runtimeError) {
      return { ok: false, error: runtimeError };
    }
    const info = await stat(dirPath);
    if (!info.isDirectory()) {
      return { ok: false, error: "Path is not a directory." };
    }
    const maxEntries = args.maxEntries ?? 200;
    const names = await readdir(dirPath, { withFileTypes: true });
    const entries = [];
    for (const entry of names.slice(0, maxEntries)) {
      const entryPath = path.join(dirPath, entry.name);
      if (!resolved.outsideProject && shouldHideRuntimeHistoryEntry(args.outputDir, entryPath, args)) continue;
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          size = (await stat(entryPath)).size;
        } catch {
          // ignore
        }
      }
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" as const : "file" as const,
        size
      });
    }
    return {
      ok: true,
      path: dirPath,
      relativePath: resolved.relativePath,
      outsideProject: resolved.outsideProject,
      entries
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);
const DEFAULT_SEARCH_RESULTS = 25;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_SNIPPET_CHARS = 240;

function centeredSearchSnippet(line: string, query: string): string {
  if (line.length <= MAX_SEARCH_SNIPPET_CHARS) return line;
  const payloadLimit = MAX_SEARCH_SNIPPET_CHARS - 6;
  const matchIndex = Math.max(0, line.indexOf(query));
  const queryWidth = Math.min(query.length, payloadLimit);
  let start = Math.max(0, matchIndex - Math.floor((payloadLimit - queryWidth) / 2));
  start = Math.min(start, Math.max(0, line.length - payloadLimit));
  const end = Math.min(line.length, start + payloadLimit);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

export async function searchProjectText(args: {
  outputDir: string;
  query: string;
  relativePath?: string;
  maxResults?: number;
  allowRuntimeSessionRead?: boolean;
}): Promise<{ ok: true; path: string; relativePath: string; outsideProject: boolean; query: string; matches: Array<{ path: string; line: number; text: string }> } | { ok: false; error: string }> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return { ok: false, error: "query is required." };
  }
  try {
    const resolved = resolveReadablePath(args.outputDir, optionalProjectRoot(args.relativePath));
    const root = resolved.path;
    if (!resolved.outsideProject) {
      const runtimeError = runtimeProjectToolError(args.outputDir, root, args);
      if (runtimeError) return { ok: false, error: runtimeError };
    }
    const excludedRuntimeHistoryRoot = runtimeHistoryRoot(args.outputDir);
    const generatedHtmlRoot = path.resolve(args.outputDir, ".translation-workshop", "html");
    const excludeGeneratedHtml = !resolved.outsideProject
      && isSameOrInside(root, generatedHtmlRoot)
      && !isSameOrInside(generatedHtmlRoot, root);
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, args.maxResults ?? DEFAULT_SEARCH_RESULTS));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const visit = async (entryPath: string) => {
      if (matches.length >= maxResults) return;
      if (
        !resolved.outsideProject
        && isSameOrInside(excludedRuntimeHistoryRoot, entryPath)
        && shouldHideRuntimeHistoryEntry(args.outputDir, entryPath, args)
      ) return;
      if (excludeGeneratedHtml && isSameOrInside(generatedHtmlRoot, entryPath)) return;
      const info = await stat(entryPath);
      if (info.isDirectory()) {
        const names = await readdir(entryPath, { withFileTypes: true });
        for (const entry of names) {
          if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
          await visit(path.join(entryPath, entry.name));
          if (matches.length >= maxResults) break;
        }
        return;
      }
      if (!info.isFile() || info.size > 2_000_000) return;
      const text = await readFile(entryPath, "utf8");
      if (!text || text.includes("\0")) return;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (lines[index].includes(query)) {
          matches.push({
            path: resolved.outsideProject ? entryPath : relativeProjectPath(args.outputDir, entryPath),
            line: index + 1,
            text: centeredSearchSnippet(lines[index], query)
          });
        }
      }
    };
    await visit(root);
    return {
      ok: true,
      path: root,
      relativePath: resolved.relativePath,
      outsideProject: resolved.outsideProject,
      query,
      matches
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
