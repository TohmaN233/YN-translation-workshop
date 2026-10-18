import { parentPort, workerData } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readProjectJsonObject, stringifyProjectJson } from "./projectJson.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";
import { mergeCanonicalLineReviewState } from "./lineReviewStateSync.ts";
import type { LineStateWorkerRequest } from "./lineReviewStateWorkerService.ts";

const input = workerData as LineStateWorkerRequest;
const current = await readProjectJsonObject(input.statePath, input.projectRoot) ?? {};
if (input.expectedRevision !== undefined && Number(current.documentRevision ?? 0) !== input.expectedRevision) {
  throw new Error(`[YN_DRAFT_REVISION_CONFLICT] The draft changed during import; refresh and import again to avoid overwriting newer edits. (expected revision ${input.expectedRevision}, actual ${Number(current.documentRevision ?? 0)})`);
}
const merged = input.mutationAccepted ? mergeCanonicalLineReviewState(current, input.state, input.changedLines, input.changedStateKeys) : current;
await mkdir(path.dirname(input.statePath), { recursive: true });
await writeTextFileAtomically(input.statePath, stringifyProjectJson(input.statePath, merged, input.projectRoot));
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
