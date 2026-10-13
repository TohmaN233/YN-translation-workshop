// IPC handlers for agent translation artifacts.
//
// Surfaces candidate translation TXTs produced by initial-translation jobs
// (Codex / Claude / API), runs the deterministic line-aligned validator, and
// generates repair prompts when validation blocks. Import is deliberately NOT
// a server-side write to the final translation TXT — the HTML workbench pulls
// the candidate text via files:readTextFile and injects it into the line-review
// draft state via html:applyLineReviewState, so only the workbench draft
// changes and the bound translation file stays untouched until the user
// explicitly exports.
//
// Kept separate from main.ts per RFC Issue 13: agent/artifact/validation logic
// lives in src/main/agent and src/main/ipc, not in the monolithic main process.

import { ipcMain } from "electron";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactCancelledError } from "../agent/artifactCancellation.ts";

import {
  discoverCandidateArtifacts,
  type DirEntry,
  type DiscoveredArtifact,
  type SourceEntry
} from "../agent/artifactDiscovery.ts";
import { runArtifactOperation, type ArtifactWorkerRequest, type ArtifactWorkerResult } from "../agent/artifactValidationService.ts";
import { resolveProjectPath, resolveReadablePath } from "../agent/projectPathGuard.ts";
import type { CustomPreserveRule } from "../../shared/validation/customPreserveRules.ts";

export interface DiscoverArtifactsArgs {
  projectDir: string;
  /** Optional source path(s) to help match candidates to sources by basename. */
  sourcePaths?: string[];
}

export interface ValidateArtifactArgs {
  projectDir: string;
  sourcePath: string;
  candidatePath: string;
  locale?: "zh-CN" | "en-US";
  languagePair?: string;
  glossaryPath?: string;
  customPreserveRules?: CustomPreserveRule[];
  requestId?: string;
  compact?: boolean;
}

export type RepairPromptArgs = ValidateArtifactArgs;

async function readDirEntries(dir: string): Promise<{ directory: string; entries: DirEntry[] } | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const mapped: DirEntry[] = [];
    for (const entry of entries) {
      let size = 0;
      let modifiedAt = "";
      try {
        const info = await stat(path.join(dir, entry.name));
        size = info.size;
        modifiedAt = info.mtime.toISOString();
      } catch {
        // Skip stat errors; entry still listed with zero size.
      }
      mapped.push({ name: entry.name, isFile: entry.isFile(), size, modifiedAt });
    }
    return { directory: dir, entries: mapped };
  } catch {
    return undefined;
  }
}

function sourceEntriesFromPaths(projectDir: string, sourcePaths: string[] | undefined): SourceEntry[] {
  if (!sourcePaths) {
    return [];
  }
  const sources: SourceEntry[] = [];
  for (const item of sourcePaths) {
    const sourcePath = resolveReadablePath(projectDir, item).path;
    sources.push({ path: sourcePath, basename: path.basename(sourcePath).replace(/\.[^.]+$/, "") });
  }
  return sources;
}

export function registerAgentArtifactIpc(): void {
  ipcMain.handle("agent-artifacts:discover", async (_event, args: DiscoverArtifactsArgs) => {
    if (!args?.projectDir || !path.isAbsolute(args.projectDir)) {
      throw new Error("An absolute project directory is required.");
    }
    const dirs = [path.join(args.projectDir, "AI_translation")];
    const listing = [];
    for (const dir of dirs) {
      const bucket = await readDirEntries(dir);
      if (bucket) {
        listing.push(bucket);
      }
    }
    const sources = sourceEntriesFromPaths(args.projectDir, args.sourcePaths);
    return discoverCandidateArtifacts(args.projectDir, listing, sources) satisfies DiscoveredArtifact[];
  });

  const running = new Map<string, { owner: number; controller: AbortController; task: Promise<ArtifactWorkerResult> }>();
  async function execute(event: Electron.IpcMainInvokeEvent, args: ValidateArtifactArgs, operation: ArtifactWorkerRequest["operation"]) {
    if (!args?.projectDir || !path.isAbsolute(args.projectDir)) throw new Error("An absolute project directory is required.");
    const resolved = { ...args, sourcePath: resolveReadablePath(args.projectDir, args.sourcePath).path,
      candidatePath: resolveProjectPath(args.projectDir, args.candidatePath) };
    const requestId = args.requestId || randomUUID();
    if (running.has(requestId)) throw new Error("Artifact request is already running.");
    const controller = new AbortController();
    const sender = event.sender;
    const abort = () => controller.abort(new ArtifactCancelledError("Artifact window closed."));
    sender?.once("destroyed", abort);
    if (sender?.isDestroyed()) abort();
    const task = runArtifactOperation({ args: resolved, operation, compact: args.compact }, { requestId, signal: controller.signal,
      onProgress: progress => { if (requestId && sender && !sender.isDestroyed()) sender.send("agent-artifacts:progress", progress); } });
    running.set(requestId, { owner: sender?.id, controller, task });
    try {
      return await task;
    } finally {
      sender?.removeListener("destroyed", abort);
      running.delete(requestId);
    }
  }
  ipcMain.handle("agent-artifacts:cancel", async (event, args: { requestId?: string }) => {
    const entries = args?.requestId ? [running.get(args.requestId)].filter(Boolean) : [...running.values()];
    const owned = entries.filter(entry => entry!.owner === event.sender?.id);
    if (!owned.length) return { ok: false };
    for (const entry of owned) entry!.controller.abort(new ArtifactCancelledError());
    // A cancel acknowledgement also proves worker/SQLite cleanup is finished.
    const settled = await Promise.allSettled(owned.map(entry => entry!.task));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected" && !(result.reason instanceof ArtifactCancelledError)).map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Artifact cancellation cleanup failed.");
    return { ok: true };
  });
  ipcMain.handle("agent-artifacts:validate", async (event, args: ValidateArtifactArgs) => (await execute(event, args, "validate")).validation);
  ipcMain.handle("agent-artifacts:importPlan", async (event, args: ValidateArtifactArgs) => {
    const result = await execute(event, args, "import");
    return args.compact ? { ok: result.validation.ok, validation: result.validation, lines: result.lines ?? [],
      lineCount: result.validation.candidateLineCount, memoryWarning: result.memoryWarning } : { ...result.plan, memoryWarning: result.memoryWarning };
  });
  ipcMain.handle("agent-artifacts:repairPrompt", async (event, args: RepairPromptArgs) => (await execute(event, args, "repair")).prompt);
}
