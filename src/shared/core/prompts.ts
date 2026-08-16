import { YN_DEFAULT_SPLIT_SIZE } from "../agent/piSessionContract.ts";
import {
  normalizeCustomPreserveRules,
  type CustomPreserveRule
} from "../validation/customPreserveRules.ts";

export type ProofreadMode = "split" | "montecarlo";
export type PromptKind = "translate" | "proofread";

export interface PromptAdvancedOptions {
  languagePair?: string;
  style?: string;
  split?: boolean;
  splitSize?: number;
  glossaryCandidates?: boolean;
  characterBible?: boolean;
  reuseExistingTranslation?: boolean;
  workDescription?: string;
  workflowTemplateId?: string;
  translateOutputDir?: string;
  proofreadOutputDir?: string;
  proofreadMode?: ProofreadMode;
  candidateRatio?: number;
  montecarloSize?: number;
  montecarloRoundMin?: number;
  montecarloRoundMax?: number;
  translationType?: string;
  subagentEnabled?: boolean;
  subagentCount?: number;
  reviewSubagentCount?: number;
  subagentProviderId?: string;
  subagentModelId?: string;
  folderTranslationOrder?: string;
  folderSourceDocuments?: Array<{ id: string; path: string }>;
  customPreserveRules?: CustomPreserveRule[];
}

export interface TranslatePromptOptions {
  sourcePath: string;
  sourceKind?: "file" | "folder";
  translationPath?: string;
  outputDir: string;
  glossaryPath?: string;
  advanced?: PromptAdvancedOptions;
}

export interface ProofreadPromptOptions {
  sourcePath: string;
  sourceKind?: "file" | "folder";
  translationPath: string;
  glossaryPath?: string;
  outputDir?: string;
  inputMode?: "separate" | "bilingual";
  advanced?: PromptAdvancedOptions;
}

export interface PromptBuildOptions {
  kind: PromptKind;
  sourcePath: string;
  sourceKind?: "file" | "folder";
  translationPath?: string;
  outputDir: string;
  glossaryPath?: string;
  inputMode?: "separate" | "bilingual";
  advanced?: PromptAdvancedOptions;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function numberOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? value : fallback;
}

function boolOrDefault(value: boolean | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value;
}

function optionalPositiveNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function joinLocalPath(root: string, child: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return trimmed ? `${trimmed}${separator}${child}` : child;
}

function outputPath(root: string, child: string): string {
  return joinLocalPath(root, child);
}

function basenameWithoutExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.split("/").filter(Boolean).at(-1) ?? "translation";
  return name.replace(/\.[^.]+$/, "") || "translation";
}

function valueOrNone(value: string | undefined): string {
  return clean(value) || "None";
}

function subagentModelText(advanced?: PromptAdvancedOptions): string {
  const providerId = clean(advanced?.subagentProviderId);
  const modelId = clean(advanced?.subagentModelId);
  if (!providerId && !modelId) return "follow the parent Agent model";
  if (!providerId || !modelId) return "invalid; both configured provider and model are required";
  return `use configured Pi model ${providerId}/${modelId}`;
}

function customPreserveRuleLines(rules: ReturnType<typeof normalizeCustomPreserveRules>): string[] {
  if (rules.length === 0) return [];
  return [
    "",
    "Custom preservation rules (each source match must remain verbatim on the same candidate line):",
    ...rules.map((rule, index) => `- ${rule.label || `Rule ${index + 1}`}: /${rule.pattern}/${rule.flags}`)
  ];
}

export function promptParameterDefaults(projectDir: string, advanced: PromptAdvancedOptions = {}) {
  const subagentCount = optionalPositiveNumber(advanced.subagentCount) ?? 3;
  return {
    languagePair: clean(advanced.languagePair) || "ja->zh-CN",
    style: clean(advanced.style) || "game",
    split: boolOrDefault(advanced.split, true),
    splitSize: numberOrDefault(advanced.splitSize, YN_DEFAULT_SPLIT_SIZE),
    glossaryCandidates: boolOrDefault(advanced.glossaryCandidates, true),
    characterBible: boolOrDefault(advanced.characterBible, true),
    reuseExistingTranslation: boolOrDefault(advanced.reuseExistingTranslation, false),
    workDescription: clean(advanced.workDescription),
    translateOutputDir: clean(advanced.translateOutputDir) || joinLocalPath(projectDir, "AI_translation"),
    proofreadOutputDir: clean(advanced.proofreadOutputDir) || joinLocalPath(projectDir, "report"),
    proofreadMode: advanced.proofreadMode === "montecarlo" ? "montecarlo" as const : "split" as const,
    candidateRatio: numberOrDefault(advanced.candidateRatio, 1.5),
    montecarloSize: numberOrDefault(advanced.montecarloSize, 3000),
    montecarloRoundMin: numberOrDefault(advanced.montecarloRoundMin, 2),
    montecarloRoundMax: numberOrDefault(advanced.montecarloRoundMax, 5),
    subagentEnabled: boolOrDefault(advanced.subagentEnabled, true),
    subagentCount,
    reviewSubagentCount: optionalPositiveNumber(advanced.reviewSubagentCount),
    subagentProviderId: clean(advanced.subagentProviderId),
    subagentModelId: clean(advanced.subagentModelId),
    folderTranslationOrder: clean(advanced.folderTranslationOrder),
    folderSourceDocuments: advanced.folderSourceDocuments?.map((document) => ({
      id: clean(document.id),
      path: clean(document.path)
    })).filter((document) => document.id && document.path),
    customPreserveRules: normalizeCustomPreserveRules(advanced.customPreserveRules)
  };
}

function translateDefaults(options: TranslatePromptOptions) {
  const defaults = promptParameterDefaults(options.outputDir, options.advanced);
  const basename = basenameWithoutExtension(options.sourcePath || options.translationPath || "translation.txt");
  return {
    languagePair: defaults.languagePair,
    style: defaults.style,
    split: defaults.split,
    splitSize: defaults.splitSize,
    glossaryCandidates: defaults.glossaryCandidates,
    characterBible: defaults.characterBible,
    reuseExistingTranslation: defaults.reuseExistingTranslation,
    subagentEnabled: defaults.subagentEnabled,
    subagentCount: defaults.subagentCount,
    reviewSubagentCount: defaults.reviewSubagentCount,
    folderTranslationOrder: defaults.folderTranslationOrder,
    customPreserveRules: defaults.customPreserveRules,
    workDescription: defaults.workDescription || "None",
    outputDir: defaults.translateOutputDir,
    basename
  };
}

function proofreadDefaults(options: ProofreadPromptOptions) {
  const defaults = promptParameterDefaults(options.outputDir || "", options.advanced);
  const mode: ProofreadMode = options.sourceKind === "folder" ? "split" : defaults.proofreadMode;
  const basename = basenameWithoutExtension(options.translationPath || options.sourcePath || "translation.txt");
  return {
    languagePair: defaults.languagePair,
    style: defaults.style,
    mode,
    splitSize: defaults.splitSize,
    montecarloSize: defaults.montecarloSize,
    montecarloRoundMin: defaults.montecarloRoundMin,
    montecarloRoundMax: defaults.montecarloRoundMax,
    candidateRatio: defaults.candidateRatio,
    subagentEnabled: defaults.subagentEnabled,
    subagentCount: defaults.subagentCount,
    reviewSubagentCount: defaults.reviewSubagentCount,
    folderTranslationOrder: defaults.folderTranslationOrder,
    customPreserveRules: defaults.customPreserveRules,
    workDescription: defaults.workDescription || "None",
    outputDir: defaults.proofreadOutputDir,
    basename
  };
}

function proofreadModeText(defaults: ReturnType<typeof proofreadDefaults>): string {
  if (defaults.mode === "montecarlo") {
    return `${defaults.mode} sample size=${defaults.montecarloSize} min round=${defaults.montecarloRoundMin} max round=${defaults.montecarloRoundMax}`;
  }
  return `${defaults.mode} ${defaults.splitSize}`;
}

function taskHeader(kind: PromptKind, languagePair: string, style: string): string[] {
  return [
    `Workflow: ${kind === "translate" ? "yn-translation-v1" : "yn-proofread-v1"}.`,
    `Language pair: ${languagePair}.`,
    `Text/domain style: ${style}.`
  ];
}

export function buildTranslatePrompt(options: TranslatePromptOptions): string {
  const defaults = translateDefaults(options);
  const folderBatch = options.sourceKind === "folder";
  const characterBibleModule = defaults.characterBible ? "on" : "off";
  const glossaryInstruction = options.glossaryPath
    ? `Selected glossary: ${options.glossaryPath}`
    : defaults.glossaryCandidates
      ? "Glossary candidates: AI_translation/_workspace/glossary_candidates.json"
      : "Glossary candidates: off";
  const candidateOutput = folderBatch
    ? `${defaults.outputDir}/[relative source path]/[basename]_translated.txt`
    : outputPath(defaults.outputDir, `${defaults.basename}_translated.txt`);

  return [
    ...taskHeader("translate", defaults.languagePair, defaults.style),
    "",
    "Task settings:",
    `- ${folderBatch ? "Source folder" : "Source path"}: ${valueOrNone(options.sourcePath)}`,
    `- Output directory: ${defaults.outputDir}`,
    `- Candidate output: ${candidateOutput}`,
    `- Work description: ${defaults.workDescription}`,
    `- ${glossaryInstruction}`,
    `- Character bible: ${characterBibleModule}`,
    `- Existing translation: ${defaults.reuseExistingTranslation ? "audit and reuse" : "discard and retranslate"}`,
    `- Split enabled: ${defaults.split}; splitSize=${defaults.splitSize}`,
    `- Subagents: ${defaults.subagentEnabled ? `enabled; maximum=${defaults.subagentCount ?? "project ceiling"}` : "disabled"}`,
    `- Translation review Agents: ${defaults.subagentEnabled ? `maximum=${defaults.reviewSubagentCount ?? defaults.subagentCount ?? "project ceiling"}` : "disabled"}`,
    `- Subagent model: ${subagentModelText(options.advanced)}`,
    ...customPreserveRuleLines(defaults.customPreserveRules),
    ...(folderBatch ? [
      "",
      "File order (removed names are skipped; braces remove relative ordering only):",
      defaults.folderTranslationOrder || "{\n(all manifest files in filename order)\n}"
    ] : [])
  ].join("\n");
}

export function buildProofreadPrompt(options: ProofreadPromptOptions): string {
  const defaults = proofreadDefaults(options);
  const folderBatch = options.sourceKind === "folder";
  const translationInput = folderBatch
    ? "host-resolved AI_translation candidate per retained file"
    : valueOrNone(options.translationPath);

  return [
    ...taskHeader("proofread", defaults.languagePair, defaults.style),
    "",
    "Task settings:",
    folderBatch
      ? `- Source folder: ${valueOrNone(options.sourcePath)}`
      : options.inputMode === "bilingual"
      ? `- Bilingual source path: ${valueOrNone(options.sourcePath)}`
      : `- Source path: ${valueOrNone(options.sourcePath)}`,
    `- Translation path: ${translationInput}`,
    `- Glossary/reference path: ${valueOrNone(options.glossaryPath)}`,
    `- Output directory: ${defaults.outputDir}`,
    `- Work description: ${defaults.workDescription}`,
    `- Mode: ${proofreadModeText(defaults)}`,
    `- H9 candidate ratio: ${defaults.candidateRatio}`,
    `- Subagents: ${defaults.subagentEnabled ? `enabled; maximum=${defaults.subagentCount ?? "project ceiling"}` : "disabled"}`,
    `- Subagent model: ${subagentModelText(options.advanced)}`,
    ...customPreserveRuleLines(defaults.customPreserveRules),
    ...(folderBatch ? [
      "",
      "File order (removed names are skipped; braces remove relative ordering only):",
      defaults.folderTranslationOrder || "{\n(all manifest files in filename order)\n}"
    ] : []),
    `- Report output: ${outputPath(defaults.outputDir, folderBatch ? "folder.proofread.json" : `${defaults.basename}.proofread.json`)}`
  ].join("\n");
}

export function buildPrompt(options: PromptBuildOptions): string {
  if (options.kind === "proofread") {
    return buildProofreadPrompt({
      sourcePath: options.sourcePath,
      sourceKind: options.sourceKind,
      translationPath: options.translationPath || "",
      glossaryPath: options.glossaryPath,
      outputDir: options.outputDir,
      inputMode: options.inputMode,
      advanced: options.advanced
    });
  }

  return buildTranslatePrompt({
    sourcePath: options.sourcePath,
    sourceKind: options.sourceKind,
    translationPath: options.translationPath,
    outputDir: options.outputDir,
    glossaryPath: options.glossaryPath,
    advanced: options.advanced
  });
}
