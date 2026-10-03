import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PiSessionPromptRequest } from "../shared/agent/piSessionContract.ts";
import { builtinTaskDefaults, type BuiltinTaskSettings, type StartBuiltinTaskRequest } from "../shared/builtinTasks.ts";
import { normalizeCustomPreserveRules, type CanonicalCustomPreserveRule } from "../shared/validation/customPreserveRules.ts";
import type { YnTaskPreparationContext, YnTaskPreparationHost } from "./agent/piNative/taskPreparation.ts";
import { scanSourcePreparation, type SourcePreparationScanReport } from "./agent/sourcePreparationScan.ts";
import { upsertTaskAssetDraft, readTaskAssetDraft, deleteTaskAssetDraftEntries, checkTaskAssetDraft, commitTaskAssets, assertTaskAssetDraftCommitted } from "./taskAssetDrafts.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";
import { patchProjectState, readProjectState } from "./projectState.ts";

export interface BuiltinTaskNavigation {
  synchronizeSettings?(context: YnTaskPreparationContext): Promise<void>;
  sourceFiles(settings: BuiltinTaskSettings): Promise<string[]>;
  workflowRequest(context: YnTaskPreparationContext, settings: BuiltinTaskSettings): Promise<PiSessionPromptRequest>;
  finish(context: YnTaskPreparationContext, settings: BuiltinTaskSettings, autoApply: boolean, signal?: AbortSignal): Promise<void>;
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function evidencePath(context: YnTaskPreparationContext): string {
  if (!/^[\w-]+$/.test(context.preparationId)) throw new Error("Invalid task preparation identity.");
  return path.join(context.outputDir, ".translation-workshop", "agent", "source-preparation", `${context.preparationId}.json`);
}
function mergedRules(existing: unknown, proposed: unknown): CanonicalCustomPreserveRule[] {
  const rules = normalizeCustomPreserveRules(existing);
  for (const next of normalizeCustomPreserveRules(proposed)) {
    if (!rules.some((rule) => rule.pattern === next.pattern && rule.flags === next.flags)) rules.push(next);
  }
  return normalizeCustomPreserveRules(rules);
}
function scanSettingsHash(settings: BuiltinTaskSettings): string {
  return hash({ parameters: Object.fromEntries(editableParameters.map(key => [key, settings[key]])),
    sourcePath: settings.sourcePath, sourceKind: settings.sourceKind, translationPath: settings.translationPath,
    inputMode: settings.inputMode, fileType: settings.fileType, sourcePosition: settings.sourcePosition, translationPosition: settings.translationPosition });
}

const editableParameters = ["languagePair", "style", "workDescription", "translateOutputDir", "proofreadOutputDir", "splitSize",
  "glossaryCandidates", "characterBible", "reuseExistingTranslation", "subagentEnabled", "subagentCount", "reviewSubagentCount",
  "subagentProviderId", "subagentModelId", "folderTranslationOrder", "proofreadMode", "candidateRatio", "montecarloSize",
  "montecarloRoundMin", "montecarloRoundMax", "customPreserveRules"] as const;

export async function validateBuiltinTaskSettings(input: StartBuiltinTaskRequest): Promise<BuiltinTaskSettings> {
  if (!["translation", "proofread", "assets"].includes(input?.task)) throw new Error("Unknown built-in task.");
  if (!input.settings || typeof input.settings !== "object") throw new Error("Task settings are required.");
  for (const key of ["splitSize", "subagentCount", "reviewSubagentCount", "pageSize", "montecarloSize", "montecarloRoundMin", "montecarloRoundMax"] as const) {
    const value = input.settings[key];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) throw new Error(`${key} must be a positive integer.`);
  }
  for (const key of ["split", "subagentEnabled", "glossaryCandidates", "characterBible", "reuseExistingTranslation"] as const) {
    if (input.settings[key] !== undefined && typeof input.settings[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
  const settings = builtinTaskDefaults(input.settings);
  const requiredPaths: Array<"outputDir" | "sourcePath"> = input.task === "assets" ? ["outputDir"] : ["outputDir", "sourcePath"];
  for (const key of requiredPaths) {
    if (typeof settings[key] !== "string" || !path.isAbsolute(settings[key])) throw new Error(`An absolute ${key} is required.`);
  }
  for (const key of ["splitSize", "subagentCount", "pageSize", "montecarloSize", "montecarloRoundMin", "montecarloRoundMax"] as const) {
    if (!Number.isInteger(settings[key]) || Number(settings[key]) < 1) throw new Error(`${key} must be a positive integer.`);
  }
  if (Number(settings.montecarloRoundMax) < Number(settings.montecarloRoundMin)) throw new Error("Maximum proofreading rounds cannot be smaller than minimum rounds.");
  if (settings.reviewSubagentCount !== undefined && (!Number.isInteger(settings.reviewSubagentCount) || settings.reviewSubagentCount < 1)) throw new Error("Review worker count must be a positive integer.");
  settings.customPreserveRules = normalizeCustomPreserveRules(settings.customPreserveRules);
  if (input.task !== "assets" && settings.sourcePath) {
    const info = await stat(settings.sourcePath);
    if (!info.isFile() && !info.isDirectory()) throw new Error("Source must be a file or folder.");
    settings.sourceKind = info.isDirectory() ? "folder" : "file";
  }
  if (input.task === "proofread") {
    if (settings.inputMode === "bilingual") settings.translationPath = settings.sourcePath;
    if (!settings.translationPath || !path.isAbsolute(settings.translationPath)) throw new Error("Proofreading requires an existing translation file or folder.");
    if (settings.inputMode !== "bilingual" && path.resolve(settings.sourcePath).toLowerCase() === path.resolve(settings.translationPath).toLowerCase()) {
      throw new Error("Separate proofreading source and translation must use different paths.");
    }
    const info = await stat(settings.translationPath);
    if (settings.sourceKind === "folder" ? !info.isDirectory() : !info.isFile()) throw new Error("Translation must match the source file/folder mode.");
    if (info.isFile() && info.size === 0) throw new Error("Proofreading requires an existing non-empty translation.");
  }
  if (input.autoApplyProofreadSuggestions !== undefined && typeof input.autoApplyProofreadSuggestions !== "boolean") throw new Error("Invalid proofreading application choice.");
  return settings;
}

export function createBuiltinTaskPreparationHost(navigation: BuiltinTaskNavigation): YnTaskPreparationHost {
  const settingsFor = async (context: YnTaskPreparationContext) => {
    const state = await readProjectState(context.outputDir);
    const original = state.builtinTaskInputSettings;
    const canonicalStillBound = state.translationBindingOrigin === "canonical"
      && typeof state.translationPath === "string" && typeof state.builtinTaskTranslationPath === "string"
      && path.resolve(state.translationPath).toLowerCase() === path.resolve(state.builtinTaskTranslationPath).toLowerCase();
    return validateBuiltinTaskSettings({ task: context.intent, settings: {
      ...state,
      ...(canonicalStillBound && original && typeof original === "object" && !Array.isArray(original)
        ? { translationPath: (original as Record<string, unknown>).translationPath } : {}),
      outputDir: context.outputDir
    } as BuiltinTaskSettings });
  };
  return {
    async inspectSettings(context) {
      await navigation.synchronizeSettings?.(context);
      const root = path.basename(context.outputDir).toLowerCase() === ".translation-workshop" ? path.dirname(context.outputDir) : context.outputDir;
      return { ...await settingsFor(context), settingsPath: path.join(root, ".translation-workshop", "project.json"),
        lineReviewPath: context.lineReviewPath, editableParameters };
    },
    async updateSettings(context, input, signal) {
      if (context.intent === "assets") throw new Error("Reference preparation cannot change translation settings.");
      if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings) || !Object.keys(input.settings).length
        || typeof input.reason !== "string" || !input.reason.trim()) throw new Error("Provide supported parameter changes and an evidence-based reason.");
      for (const [key, value] of Object.entries(input.settings)) {
        if (!(editableParameters as readonly string[]).includes(key)) throw new Error(`Task parameter is not editable: ${key}`);
        if (["languagePair", "style", "workDescription", "translateOutputDir", "proofreadOutputDir", "subagentProviderId", "subagentModelId", "folderTranslationOrder"].includes(key)
          && typeof value !== "string") throw new Error(`${key} must be a string.`);
        if (key === "candidateRatio" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error("candidateRatio must be positive.");
        if (key === "proofreadMode" && value !== "split" && value !== "montecarlo") throw new Error("Invalid proofreadMode.");
      }
      await navigation.synchronizeSettings?.(context);
      const validated = await validateBuiltinTaskSettings({ task: context.intent, settings: { ...await settingsFor(context), ...input.settings } });
      const patch = Object.fromEntries(Object.keys(input.settings).map(key => [key, validated[key as keyof BuiltinTaskSettings]]));
      signal?.throwIfAborted();
      await patchProjectState(context.outputDir, patch);
      return { updated: patch, reason: input.reason.trim(), settings: await settingsFor(context) };
    },
    async inspectSources(context, input, signal) {
      await navigation.synchronizeSettings?.(context);
      const settings = await settingsFor(context);
      const rules = mergedRules(settings.customPreserveRules, input.rules);
      const report = await scanSourcePreparation({ files: await navigation.sourceFiles(settings), rules, signal });
      signal?.throwIfAborted();
      if (!report.totalFiles || !report.totalLines) throw new Error("No source lines were found to prepare.");
      const filePath = evidencePath(context);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeTextFileAtomically(filePath, JSON.stringify({ schemaVersion: 1, settingsHash: scanSettingsHash(settings),
        trial: input.rules !== undefined, rules, report }, null, 2));
      return report;
    },
    async importAssets(context, input, signal) {
      return upsertTaskAssetDraft(context, input, signal);
    },
    readAssetDraft: readTaskAssetDraft,
    deleteAssetDraftEntries: deleteTaskAssetDraftEntries,
    checkAssetDraft: checkTaskAssetDraft,
    commitAssets: commitTaskAssets,
    async prepareWorkflow(context, input, signal) {
      await assertTaskAssetDraftCommitted(context);
      await navigation.synchronizeSettings?.(context);
      let settings = await settingsFor(context);
      if (context.intent === "translation") {
        const evidence = JSON.parse(await readFile(evidencePath(context), "utf8")) as {
          schemaVersion: number; settingsHash: string; trial: boolean; rules: CanonicalCustomPreserveRule[]; report: SourcePreparationScanReport
        };
        const rules = mergedRules(settings.customPreserveRules, input.customPreserveRules ?? evidence.rules);
        if (!evidence.trial || evidence.schemaVersion !== 1 || evidence.settingsHash !== scanSettingsHash(settings)
          || hash(rules) !== hash(evidence.rules)) throw new Error("Trial the selected preservation rules against the current settings before starting translation.");
        const current = await scanSourcePreparation({ files: await navigation.sourceFiles(settings), rules, signal });
        if (hash(current.files) !== hash(evidence.report.files)) throw new Error("Sources changed after the preservation preview. Inspect and trial the rules again.");
        const existing = normalizeCustomPreserveRules(settings.customPreserveRules);
        for (const rule of current.existingRules) {
          if (!rule.matchCount && !existing.some((item) => item.pattern === rule.pattern && item.flags === rule.flags)) {
            throw new Error(`New preservation rule has no source matches: ${rule.label || rule.pattern}`);
          }
        }
        signal?.throwIfAborted();
        await patchProjectState(context.outputDir, { customPreserveRules: rules });
        settings = { ...settings, customPreserveRules: rules };
      }
      signal?.throwIfAborted();
      return navigation.workflowRequest(context, settings);
    },
    async finishWorkflow(context, input, signal) {
      signal?.throwIfAborted();
      await navigation.finish(context, await settingsFor(context), input.autoApplyProofreadSuggestions, signal);
    }
  };
}
