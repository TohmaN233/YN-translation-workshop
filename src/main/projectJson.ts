import { readFile } from "node:fs/promises";
import path from "node:path";
import { containedProjectRoot, decodeProjectPaths, encodeProjectPaths } from "./projectPaths.ts";

async function readObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try { text = await readFile(filePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid project JSON object: ${filePath}`);
  return parsed;
}

/** Resolve every sidecar binding against its owning project, including legacy moves. */
export async function readProjectJsonObject(
  filePath: string,
  root = containedProjectRoot(filePath)
): Promise<Record<string, unknown> | undefined> {
  const parsed = await readObject(filePath);
  if (!parsed || !root) return parsed;
  let legacyRoot = parsed.projectPathsVersion === 1 ? undefined : parsed.outputDir;
  let origins: string[] = [];
  if (!legacyRoot && parsed.projectPathsVersion !== 1) {
    const project = await readObject(path.join(root, ".translation-workshop", "project.json"));
    legacyRoot = project?.projectPathsVersion === 1 ? undefined : project?.outputDir;
    if (Array.isArray(project?.projectMigrationOrigins)) origins = project.projectMigrationOrigins.filter((value): value is string => typeof value === "string");
  }
  return decodeProjectPaths(parsed, root, typeof legacyRoot === "string" ? legacyRoot : origins);
}

export function stringifyProjectJson(filePath: string, value: unknown, root = containedProjectRoot(filePath)): string {
  return JSON.stringify(root ? { ...encodeProjectPaths(value as Record<string, unknown>, root), projectPathsVersion: 1 } : value, null, 2);
}
