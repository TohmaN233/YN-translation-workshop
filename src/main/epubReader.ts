import extractZip from "extract-zip";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { extractEpubTextFromArchive } from "../shared/core/epubText.ts";

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

export async function readEpubText(epubPath: string, workspaceDir: string, cacheId: string): Promise<string> {
  const cacheDir = path.join(workspaceDir, "cache", "epub", cacheId.replace(/[^a-z0-9._-]+/gi, "_"));
  await mkdir(cacheDir, { recursive: true });
  try {
    await extractZip(epubPath, { dir: cacheDir });
    const files = await collectExtractedTextFiles(cacheDir);
    return extractEpubTextFromArchive(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`EPUB parsing failed for ${path.basename(epubPath)}: ${message}`);
  }
}
