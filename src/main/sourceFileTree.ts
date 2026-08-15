import { readdir } from "node:fs/promises";
import path from "node:path";

export const IGNORED_SOURCE_DIRECTORIES = new Set([
  "ai_translation",
  ".translation-workshop",
  "report",
  "node_modules"
]);

export interface SourceTreeFile {
  path: string;
  relativePath: string;
}

export async function collectSourceTreeFiles(
  rootPath: string,
  accepts: (filePath: string) => boolean
): Promise<SourceTreeFile[]> {
  const files: SourceTreeFile[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Source folders cannot contain symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRECTORIES.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !accepts(absolutePath)) continue;
      const relativePath = path.relative(rootPath, absolutePath);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`Source file escaped the selected folder: ${absolutePath}`);
      }
      files.push({ path: absolutePath, relativePath: relativePath.replace(/\\/g, "/") });
    }
  };

  await visit(rootPath);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}
