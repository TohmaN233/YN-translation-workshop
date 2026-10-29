import path from "node:path";
import { parseEpubDocument } from "./epubDocument.ts";

export type ArchiveFiles = Record<string, string>;

interface ManifestItem {
  href: string;
  mediaType: string;
}

export function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function findArchiveFile(files: ArchiveFiles, targetPath: string): string | undefined {
  const normalizedTarget = normalizeArchivePath(targetPath).toLocaleLowerCase();
  const match = Object.entries(files).find(([filePath]) => normalizeArchivePath(filePath).toLocaleLowerCase() === normalizedTarget);
  return match?.[1];
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    attrs[match[1].toLocaleLowerCase()] = match[2];
  }
  return attrs;
}

export function xhtmlToLines(xhtml: string): string[] {
  return parseEpubDocument(xhtml).units.map(unit => unit.text);
}

function opfRootPath(containerXml: string): string {
  const rootfileTag = containerXml.match(/<rootfile\b[^>]*>/i)?.[0];
  if (!rootfileTag) {
    throw new Error("EPUB parsing failed: META-INF/container.xml does not contain a rootfile.");
  }
  const fullPath = parseAttributes(rootfileTag)["full-path"];
  if (!fullPath) {
    throw new Error("EPUB parsing failed: rootfile is missing full-path.");
  }
  return normalizeArchivePath(fullPath);
}

function resolveHref(opfPath: string, href: string): string {
  const opfDir = path.posix.dirname(normalizeArchivePath(opfPath));
  const decodedHref = decodeURIComponent(href);
  return normalizeArchivePath(path.posix.normalize(path.posix.join(opfDir === "." ? "" : opfDir, decodedHref)));
}

function parseManifest(opfXml: string): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();
  for (const match of opfXml.matchAll(/<item\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (attrs.id && attrs.href) {
      manifest.set(attrs.id, {
        href: attrs.href,
        mediaType: attrs["media-type"] ?? ""
      });
    }
  }
  return manifest;
}

function parseSpineIds(opfXml: string): string[] {
  return [...opfXml.matchAll(/<itemref\b[^>]*>/gi)]
    .map((match) => parseAttributes(match[0]).idref)
    .filter((idref): idref is string => Boolean(idref));
}

function fallbackHtmlPaths(files: ArchiveFiles): string[] {
  return Object.keys(files)
    .map(normalizeArchivePath)
    .filter((filePath) => /\.(xhtml|html?)$/i.test(filePath))
    .filter((filePath) => !/content\.opf$/i.test(filePath))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export function epubDocumentPathsFromArchive(files: ArchiveFiles): string[] {
  const containerXml = findArchiveFile(files, "META-INF/container.xml");
  if (!containerXml) {
    throw new Error("EPUB parsing failed: META-INF/container.xml was not found.");
  }
  const opfPath = opfRootPath(containerXml);
  const opfXml = findArchiveFile(files, opfPath);
  if (!opfXml) {
    throw new Error(`EPUB parsing failed: package file was not found (${opfPath}).`);
  }

  const manifest = parseManifest(opfXml);
  const spinePaths = parseSpineIds(opfXml)
    .map((idref) => manifest.get(idref))
    .filter((item): item is ManifestItem => Boolean(item))
    .filter((item) => item.mediaType.includes("html") || /\.(xhtml|html?)$/i.test(item.href))
    .map((item) => resolveHref(opfPath, item.href));

  return spinePaths.length > 0 ? spinePaths : fallbackHtmlPaths(files);
}

export function extractEpubTextFromArchive(files: ArchiveFiles): string {
  const documentPaths = epubDocumentPathsFromArchive(files);
  const lines = documentPaths.flatMap((documentPath) => {
    const xhtml = findArchiveFile(files, documentPath);
    if (xhtml === undefined) throw new Error(`EPUB parsing failed: spine document was not found (${documentPath}).`);
    return xhtmlToLines(xhtml);
  });
  if (lines.length === 0) {
    throw new Error("EPUB parsing failed: no readable XHTML/HTML text was found.");
  }
  return lines.join("\n");
}
