import extractZip from "extract-zip";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { extractEpubTextFromArchive } from "../shared/core/epubText.ts";
import { extractLegacyEpubTextForVerification } from "../shared/core/epubLegacyProjection.ts";

async function collectExtractedTextFiles(folderPath: string, rootPath = folderPath): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = await readdir(folderPath, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await collectExtractedTextFiles(fullPath, rootPath));
      return;
    }
    if (!entry.isFile() || !/\.(xml|opf|xhtml|html?)$/i.test(entry.name)) {
      return;
    }
    const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");
    files[relativePath] = await readFile(fullPath, "utf8");
  }));
  return files;
}

export async function readEpubText(epubPath: string, workspaceDir: string, cacheId: string, projection: "current" | "legacy-verification" = "current"): Promise<string> {
  const cacheRoot = path.resolve(workspaceDir, "cache", "epub");
  await mkdir(cacheRoot, { recursive: true });
  const cacheDir = await mkdtemp(path.join(cacheRoot, `${cacheId.replace(/[^a-z0-9._-]+/gi, "_")}-`));
  if (path.dirname(cacheDir) !== cacheRoot) throw new Error("EPUB extraction directory is outside its cache root.");
  let readFailure: Error | undefined;
  try {
    await extractZip(epubPath, { dir: cacheDir });
    const files = await collectExtractedTextFiles(cacheDir);
    return projection === "legacy-verification" ? extractLegacyEpubTextForVerification(files) : extractEpubTextFromArchive(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    readFailure = new Error(`EPUB parsing failed for ${path.basename(epubPath)}: ${message}`, { cause: error });
    throw readFailure;
  } finally {
    try {
      await rm(cacheDir, { recursive: true, force: true });
    } catch (cleanupError) {
      if (readFailure) throw new AggregateError([readFailure, cleanupError], "EPUB parsing and extraction cleanup failed.");
      throw cleanupError;
    }
  }
}
