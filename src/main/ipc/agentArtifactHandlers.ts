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
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  discoverCandidateArtifacts,
  type DirEntry,
  type DiscoveredArtifact,
  type SourceEntry
} from "../agent/artifactDiscovery.ts";
import { buildCandidateImportPlan, buildRepairPrompt } from "../agent/importCandidate.ts";
import { readWorkflowTranslationValidationAssets } from "../agent/projectAssets.ts";
import { resolveProjectPath } from "../agent/projectPathGuard.ts";
import { rememberTranslationSegments } from "../agent/translationMemory.ts";
import { validateTranslationCandidate, type TranslationValidationResult } from "../../shared/validation/translationValidator.ts";

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
}

export interface RepairPromptArgs {
  projectDir: string;
  sourcePath: string;
  candidatePath: string;
  locale?: "zh-CN" | "en-US";
}

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
    try {
      const sourcePath = resolveProjectPath(projectDir, item);
      sources.push({ path: sourcePath, basename: path.basename(sourcePath).replace(/\.[^.]+$/, "") });
    } catch {
      // Ignore source paths outside the project boundary.
    }
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

  ipcMain.handle("agent-artifacts:validate", async (_event, args: ValidateArtifactArgs) => {
    if (!args?.projectDir || !path.isAbsolute(args.projectDir)) {
      throw new Error("An absolute project directory is required.");
    }
    const sourcePath = resolveProjectPath(args.projectDir, args.sourcePath);
    const candidatePath = resolveProjectPath(args.projectDir, args.candidatePath);
    const [sourceText, candidateText] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(candidatePath, "utf8")
    ]);
    const { glossaryEntries, characterEntries, styleForbiddenTerms } = await readWorkflowTranslationValidationAssets({
      outputDir: args.projectDir,
      glossaryPath: args.glossaryPath
    });
    const validation = validateTranslationCandidate(sourceText, candidateText, {
      locale: args.locale === "en-US" ? "en-US" : "zh-CN",
      languagePair: args.languagePair,
      glossaryEntries,
      characterEntries,
      styleForbiddenTerms
    });
    return validation satisfies TranslationValidationResult;
  });

  ipcMain.handle("agent-artifacts:importPlan", async (_event, args: ValidateArtifactArgs) => {
    if (!args?.projectDir || !path.isAbsolute(args.projectDir)) {
      throw new Error("An absolute project directory is required.");
    }
    const sourcePath = resolveProjectPath(args.projectDir, args.sourcePath);
    const candidatePath = resolveProjectPath(args.projectDir, args.candidatePath);
    const [sourceText, candidateText] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(candidatePath, "utf8")
    ]);
    // buildCandidateImportPlan refuses to emit edits when validation blocks;
    // the caller must show the repair entry point instead of importing.
    const { glossaryEntries, characterEntries, styleForbiddenTerms } = await readWorkflowTranslationValidationAssets({
      outputDir: args.projectDir,
      glossaryPath: args.glossaryPath
    });
    const plan = buildCandidateImportPlan(
      sourceText,
      candidateText,
      args.locale === "en-US" ? "en-US" : "zh-CN",
      args.languagePair,
      glossaryEntries,
      characterEntries,
      styleForbiddenTerms
    );
    if (plan.ok) {
      await rememberTranslationSegments({
        outputDir: args.projectDir,
        sourceText,
        targetText: candidateText,
        sourcePath,
        targetPath: candidatePath,
        languagePair: args.languagePair
      }).catch(() => undefined);
    }
    return plan;
  });

  ipcMain.handle("agent-artifacts:repairPrompt", async (_event, args: RepairPromptArgs) => {
    if (!args?.projectDir || !path.isAbsolute(args.projectDir)) {
      throw new Error("An absolute project directory is required.");
    }
    const sourcePath = resolveProjectPath(args.projectDir, args.sourcePath);
    const candidatePath = resolveProjectPath(args.projectDir, args.candidatePath);
    const [sourceText, candidateText] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(candidatePath, "utf8")
    ]);
    const locale = args.locale === "en-US" ? "en-US" : "zh-CN";
    const plan = buildCandidateImportPlan(sourceText, candidateText, locale);
    return buildRepairPrompt(sourceText, candidateText, plan.validation, locale);
  });
}
