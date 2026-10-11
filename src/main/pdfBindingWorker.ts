import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { decodeProjectPaths, projectRelativePath } from "./projectPaths.ts";
import { PDF_LAYOUT_VERSION, validatePdfLayout } from "./pdfTypes.ts";

export async function pdfFileStamp(file: string): Promise<string> {
  const value = await stat(file, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

async function digest(file: string): Promise<string> {
  const before = await pdfFileStamp(file), hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  if (before !== await pdfFileStamp(file)) throw new Error(`PDF binding changed during verification: ${file}`);
  return hash.digest("hex");
}

async function verify(input: { sourcePath: string; projectRoot: string }) {
  const mapPath = input.sourcePath + ".pdf-layout.json", mapStamp = await pdfFileStamp(mapPath);
  const layout = decodeProjectPaths(JSON.parse(await readFile(mapPath, "utf8")), input.projectRoot);
  if (layout.version !== PDF_LAYOUT_VERSION) throw new Error("This PDF projection predates Host code/math protection. Generate a new review from the original PDF; the old projection and translations were retained.");
  validatePdfLayout(layout);
  if (path.resolve(layout.sourcePath) !== path.resolve(input.sourcePath)) throw new Error("PDF source binding differs from this projection.");
  for (const page of layout.pages) {
    if (projectRelativePath(path.dirname(input.sourcePath), page.backgroundPath) === undefined
      || projectRelativePath(path.dirname(input.sourcePath), page.previewPath) === undefined) throw new Error("PDF asset escaped its projection directory.");
  }
  const files = [mapPath, input.sourcePath, layout.originalPath];
  const stamps = await Promise.all(files.map(pdfFileStamp));
  if (stamps[0] !== mapStamp) throw new Error("PDF layout changed during verification.");
  if (await digest(input.sourcePath) !== layout.sourceHash) throw new Error(`PDF source binding changed: ${input.sourcePath}. Restore it before resuming.`);
  if (await digest(layout.originalPath) !== layout.originalHash) throw new Error(`PDF source binding changed: ${layout.originalPath}. Restore it before resuming.`);
  const after = await Promise.all(files.map(pdfFileStamp));
  if (after.some((value, index) => value !== stamps[index])) throw new Error("PDF binding changed during verification.");
  return { layout, files, stamps };
}

// Hashing and layout JSON validation never run on Electron's main thread.
if (parentPort) {
  try {
    const result = workerData.kind === "hash" ? await digest(workerData.file) : await verify(workerData);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException).code, file: (error as NodeJS.ErrnoException).path });
  }
}
