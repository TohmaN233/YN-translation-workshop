import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function revisedEpubProjectionPath(basePath: string, text: string, mode = "separate"): string {
  const hash = createHash("sha256").update(JSON.stringify({ contract: "epub-dom-v1", mode, text })).digest("hex");
  return path.join(path.dirname(basePath), `epub-dom-v1-${hash}`, path.basename(basePath));
}

export function matchesEpubProjectionPath(candidate: string, basePath: string, text: string, mode = "separate"): boolean {
  return candidate === basePath || candidate === revisedEpubProjectionPath(basePath, text, mode);
}

/** Existing projections remain immutable because older HTML and sessions still own them. */
export async function writeEpubProjection(basePath: string, text: string, mode = "separate"): Promise<string> {
  await mkdir(path.dirname(basePath), { recursive: true });
  try { await writeFile(basePath, text, { encoding: "utf8", flag: "wx" }); return basePath; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (await readFile(basePath, "utf8") === text) return basePath;
  const revised = revisedEpubProjectionPath(basePath, text, mode);
  await mkdir(path.dirname(revised), { recursive: true });
  try { await writeFile(revised, text, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (await readFile(revised, "utf8") !== text) throw new Error(`EPUB projection content conflict: ${revised}.`);
  return revised;
}
