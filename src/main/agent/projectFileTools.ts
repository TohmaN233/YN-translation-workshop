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

function isRuntimeHistoryPath(outputDir: string, target: string): boolean {
  return isSameOrInside(runtimeHistoryRoot(outputDir), target);
}

const RUNTIME_HISTORY_READ_ERROR = "Pi runtime session data is not readable through project tools.";

export async function readProjectFile(args: {
  outputDir: string;
  relativePath: string;
  offsetChars?: number;
  maxChars?: number;
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
    if (!resolved.outsideProject && isRuntimeHistoryPath(args.outputDir, filePath)) {
      return { ok: false, error: RUNTIME_HISTORY_READ_ERROR };
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
}): Promise<{ ok: true; path: string; relativePath: string; outsideProject: boolean; entries: Array<{ name: string; kind: "file" | "dir"; size?: number }> } | { ok: false; error: string }> {
  try {
    const resolved = resolveReadablePath(args.outputDir, optionalProjectRoot(args.relativePath));
    const dirPath = resolved.path;
    if (!resolved.outsideProject && isRuntimeHistoryPath(args.outputDir, dirPath)) {
      return { ok: false, error: RUNTIME_HISTORY_READ_ERROR };
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
      if (!resolved.outsideProject && isRuntimeHistoryPath(args.outputDir, entryPath)) continue;
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
}): Promise<{ ok: true; path: string; relativePath: string; outsideProject: boolean; query: string; matches: Array<{ path: string; line: number; text: string }> } | { ok: false; error: string }> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return { ok: false, error: "query is required." };
  }
  try {
    const resolved = resolveReadablePath(args.outputDir, optionalProjectRoot(args.relativePath));
    const root = resolved.path;
    const excludedRuntimeHistoryRoot = runtimeHistoryRoot(args.outputDir);
    const generatedHtmlRoot = path.resolve(args.outputDir, ".translation-workshop", "html");
    const excludeGeneratedHtml = !resolved.outsideProject
      && isSameOrInside(root, generatedHtmlRoot)
      && !isSameOrInside(generatedHtmlRoot, root);
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, args.maxResults ?? DEFAULT_SEARCH_RESULTS));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const visit = async (entryPath: string) => {
      if (matches.length >= maxResults) return;
      if (!resolved.outsideProject && isSameOrInside(excludedRuntimeHistoryRoot, entryPath)) return;
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
