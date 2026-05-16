import extractZip from "extract-zip";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildTranslatedEpubTextFiles, type EpubReplacementOptions } from "../shared/core/epubExport.ts";
import { createZipBuffer } from "./zipWriter.ts";

interface ArchiveBufferFile {
  path: string;
  data: Buffer;
}

export interface CreateTranslatedEpubOptions {
  templatePath: string;
  translatedLines: string[];
  workspaceDir: string;
  outputDir?: string;
  replacement?: EpubReplacementOptions;
}

function safeCacheName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function translatedEpubPath(templatePath: string, outputDir: string): string {
  const parsed = path.parse(templatePath);
  return path.join(outputDir, `${parsed.name}.translated.epub`);
}

async function collectExtractedFiles(folderPath: string, rootPath = folderPath): Promise<ArchiveBufferFile[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      return collectExtractedFiles(fullPath, rootPath);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [{
      path: path.relative(rootPath, fullPath).replace(/\\/g, "/"),
      data: await readFile(fullPath)
    }];
  }));
  return files.flat();
}

function textArchiveFiles(files: ArchiveBufferFile[]): Record<string, string> {
  return Object.fromEntries(
    files
      .filter((file) => /\.(xml|opf|xhtml|html?)$/i.test(file.path))
      .map((file) => [file.path, file.data.toString("utf8")])
  );
}

function orderForEpub(files: ArchiveBufferFile[]): ArchiveBufferFile[] {
  const mimetype = files.find((file) => file.path === "mimetype");
  const rest = files
    .filter((file) => file.path !== "mimetype")
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }));
  return mimetype ? [mimetype, ...rest] : rest;
}

export async function createTranslatedEpub(options: CreateTranslatedEpubOptions): Promise<{ outputPath: string; changedDocuments: number }> {
  if (!options.templatePath.toLowerCase().endsWith(".epub")) {
    throw new Error("EPUB export requires an .epub template path.");
  }
  const cacheDir = path.join(options.workspaceDir, "cache", "epub-export", safeCacheName(`${Date.now()}-${path.basename(options.templatePath)}`));
  await mkdir(cacheDir, { recursive: true });
  try {
    await extractZip(options.templatePath, { dir: cacheDir });
    const files = await collectExtractedFiles(cacheDir);
    const translatedTextFiles = buildTranslatedEpubTextFiles(textArchiveFiles(files), options.translatedLines, options.replacement);
    const nextFiles = orderForEpub(files.map((file) => ({
      ...file,
      data: translatedTextFiles.files[file.path] === undefined ? file.data : Buffer.from(translatedTextFiles.files[file.path], "utf8")
    })));
    const zip = createZipBuffer(nextFiles.map((file) => ({ path: file.path, data: file.data, store: file.path === "mimetype" })));
    const outputPath = translatedEpubPath(options.templatePath, options.outputDir || path.dirname(options.templatePath));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, zip);
    return { outputPath, changedDocuments: translatedTextFiles.changedDocuments };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`EPUB export failed for ${path.basename(options.templatePath)}: ${message}`);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}
