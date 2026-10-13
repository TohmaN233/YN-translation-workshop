import { parentPort, workerData } from "node:worker_threads";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeProjectPaths, encodeProjectPaths } from "./projectPaths.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";
import { mergeCanonicalLineReviewState } from "./lineReviewStateSync.ts";
import type { LineStateWorkerRequest } from "./lineReviewStateWorkerService.ts";

const input = workerData as LineStateWorkerRequest;
let current: Record<string, unknown> = {};
try {
  current = JSON.parse(await readFile(input.statePath, "utf8"));
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error(`Invalid line-review state: ${input.statePath}`);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
if (input.projectRoot) {
  let legacyRoot = current.projectPathsVersion === 1 ? undefined : current.outputDir;
  if (!legacyRoot && current.projectPathsVersion !== 1) {
    try { legacyRoot = JSON.parse(await readFile(path.join(input.projectRoot, ".translation-workshop", "project.json"), "utf8")).outputDir; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  current = decodeProjectPaths(current, input.projectRoot, typeof legacyRoot === "string" ? legacyRoot : undefined);
}
if (input.expectedRevision !== undefined && Number(current.documentRevision ?? 0) !== input.expectedRevision) {
  throw new Error("The draft changed during import; refresh and import again to avoid overwriting newer edits.");
}
const merged = input.mutationAccepted ? mergeCanonicalLineReviewState(current, input.state, input.changedLines, input.changedStateKeys) : current;
await mkdir(path.dirname(input.statePath), { recursive: true });
const stored = input.projectRoot ? { ...encodeProjectPaths(merged, input.projectRoot), projectPathsVersion: 1 } : merged;
await writeTextFileAtomically(input.statePath, JSON.stringify(stored, null, 2));
let response = merged;
if (!input.hydrate) {
  response = { documentRevision: merged.documentRevision };
  for (const key of input.changedStateKeys) if (key in merged) response[key] = merged[key];
  for (const key of ["edits", "status", "revisions", "revisionHistory", "auditIssues", "auditWhitelist"]) {
    const map = merged[key] as Record<string, unknown> | undefined;
    const patch: Record<string, unknown> = {};
    for (const line of input.changedLines) if (map && line in map) patch[line] = map[line];
    response[key] = patch;
  }
}
parentPort!.postMessage(response);
