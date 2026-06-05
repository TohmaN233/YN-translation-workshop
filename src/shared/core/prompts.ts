import { bundledSkillPaths } from "./skillInstall.ts";

export type AgentType = "codex" | "claude";
export type ProofreadMode = "split" | "montecarlo";
export type PromptKind = "translate" | "proofread";

export interface PromptAdvancedOptions {
  languagePair?: string;
  style?: string;
  split?: boolean;
  splitSize?: number;
  subagent?: boolean;
  subagentCount?: number;
  workDescription?: string;
  translateOutputDir?: string;
  proofreadOutputDir?: string;
  proofreadMode?: ProofreadMode;
  candidateRatio?: number;
  montecarloSize?: number;
  montecarloRoundMin?: number;
  montecarloRoundMax?: number;
  reviewMode?: string;
  translationType?: string;
}

export interface TranslatePromptOptions {
  agent: AgentType;
  sourcePath: string;
  translationPath?: string;
  outputDir: string;
  glossaryPath?: string;
  advanced?: PromptAdvancedOptions;
}

export interface ProofreadPromptOptions {
  agent: AgentType;
  sourcePath: string;
  translationPath: string;
  glossaryPath?: string;
  outputDir?: string;
  inputMode?: "separate" | "bilingual";
  advanced?: PromptAdvancedOptions;
}

export interface PromptBuildOptions {
  kind: PromptKind;
  agent: AgentType;
  sourcePath: string;
  translationPath?: string;
  outputDir: string;
  glossaryPath?: string;
  inputMode?: "separate" | "bilingual";
  advanced?: PromptAdvancedOptions;
}

export const skillPaths = {
  codex: {
    translate: bundledSkillPaths.codex.translate,
    proofread: bundledSkillPaths.codex.proofread,
    installTarget: bundledSkillPaths.codex.installTarget,
    displayName: "Codex",
    workflowKind: "skill",
    bundledLabel: "Bundled Codex skill path",
    installTargetLabel: "Global Codex skill target"
  },
  claude: {
    translate: bundledSkillPaths.claude.translate,
    proofread: bundledSkillPaths.claude.proofread,
    installTarget: bundledSkillPaths.claude.installTarget,
    displayName: "Claude Code",
    workflowKind: "command",
    bundledLabel: "Bundled Claude Code command path",
    installTargetLabel: "Global Claude Code command target"
  }
} as const;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function numberOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? value : fallback;
}

function boolOrDefault(value: boolean | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value;
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

function bracketedPath(pathValue: string): string {
  return `[${pathValue || ""}]`;
}

function skillInvocation(agent: AgentType, skillName: "translate-text" | "proofread-translation"): string {
  return agent === "claude" ? `/${skillName}` : `$${skillName}`;
}

export function promptParameterDefaults(projectDir: string, advanced: PromptAdvancedOptions = {}) {
  return {
    languagePair: clean(advanced.languagePair) || "ja->zh-CN",
    style: clean(advanced.style) || "game",
    split: boolOrDefault(advanced.split, true),
    splitSize: numberOrDefault(advanced.splitSize, 2000),
    subagent: boolOrDefault(advanced.subagent, false),
    subagentCount: numberOrDefault(advanced.subagentCount, 3),
    workDescription: clean(advanced.workDescription),
    translateOutputDir: clean(advanced.translateOutputDir) || joinLocalPath(projectDir, "AI_translation"),
    proofreadOutputDir: clean(advanced.proofreadOutputDir) || joinLocalPath(projectDir, "report"),
    proofreadMode: advanced.proofreadMode === "montecarlo" ? "montecarlo" as const : "split" as const,
    candidateRatio: numberOrDefault(advanced.candidateRatio, 1.5),
    montecarloSize: numberOrDefault(advanced.montecarloSize, 3000),
    montecarloRoundMin: numberOrDefault(advanced.montecarloRoundMin, 2),
    montecarloRoundMax: numberOrDefault(advanced.montecarloRoundMax, 5)
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
    subagent: defaults.subagent,
    subagentCount: defaults.subagentCount,
    workDescription: defaults.workDescription || "None",
    outputDir: defaults.translateOutputDir,
    basename
  };
}

function proofreadDefaults(options: ProofreadPromptOptions) {
  const defaults = promptParameterDefaults(options.outputDir || "", options.advanced);
  const mode: ProofreadMode = defaults.proofreadMode;
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
    subagent: mode === "split" ? defaults.subagent : false,
    subagentCount: defaults.subagentCount,
    workDescription: defaults.workDescription || "None",
    outputDir: defaults.proofreadOutputDir,
    basename
  };
}

function translateCommandLine(options: TranslatePromptOptions, defaults: ReturnType<typeof translateDefaults>): string {
  const split = defaults.split ? `; Split=${defaults.splitSize}` : "";
  const translationReference = options.translationPath ? `; existing translation/reference:${options.translationPath}` : "";
  return [
    `${skillInvocation(options.agent, "translate-text")} ${defaults.languagePair}; Genre: ${defaults.style}; source:${options.sourcePath}${translationReference}${split}; glossary: ${bracketedPath(options.glossaryPath || "")}; Work description: ${bracketedPath(defaults.workDescription)}`
  ].join("\n");
}

function proofreadModeText(defaults: ReturnType<typeof proofreadDefaults>): string {
  if (defaults.mode === "montecarlo") {
    return `${defaults.mode} sample size=${defaults.montecarloSize} min round=${defaults.montecarloRoundMin} max round=${defaults.montecarloRoundMax}`;
  }
  return `${defaults.mode} ${defaults.splitSize}`;
}

function proofreadCommandLine(options: ProofreadPromptOptions, defaults: ReturnType<typeof proofreadDefaults>): string {
  const sourcePart = options.inputMode === "bilingual"
    ? `bilingual file:${options.sourcePath}; translation:${options.translationPath}`
    : `source:${options.sourcePath}; translation:${options.translationPath}`;
  return `${skillInvocation(options.agent, "proofread-translation")} Mode: ${proofreadModeText(defaults)}; ${defaults.languagePair}; Genre: ${defaults.style}; ${sourcePart}; glossary: ${bracketedPath(options.glossaryPath || "")}; Work description: ${bracketedPath(defaults.workDescription)}`;
}

export function buildTranslatePrompt(options: TranslatePromptOptions): string {
  const defaults = translateDefaults(options);
  const subagentLines = defaults.subagent
    ? [
        `CALL SUBAGENT; SUBAGENT_COUNT=${defaults.subagentCount};`,
        `Split=${defaults.splitSize} is a checkpoint interval, not the task scope.`,
        `Divide the full source line range into ${defaults.subagentCount} non-overlapping agent ranges of roughly equal size; each subagent must process its full assigned range and save progress every ${defaults.splitSize} source lines.`,
        "Boundary/context lines are read-only references only; subagents must not translate, count, or write them into outputs.",
        "After all complete, merge in part order:",
        `- Final translation (single file): ${outputPath(defaults.outputDir, `${defaults.basename}_translated.txt`)}`,
        `- Merged glossary: ${outputPath(defaults.outputDir, "glossary.json")}`,
        `- Merged character bible: ${outputPath(defaults.outputDir, "character_bible.md")}`,
        `- Workspace: ${outputPath(defaults.outputDir, "_workspace/")}`,
        "Merge rules:",
        "- Concatenate translated parts in order. No line drops or reordering.",
        "- Glossary: dedupe by src, keep most-frequent dst; conflicts marked `inconsistent`.",
        "- Character bible: merge by name; on field conflicts, keep the more detailed entry."
      ]
    : [
        "NO SUBAGENT;",
        "Output paths:",
        `- Final translation: ${outputPath(defaults.outputDir, `${defaults.basename}_translated.txt`)}`,
        `- Glossary: ${options.glossaryPath ? `direct edit ${bracketedPath(options.glossaryPath)}` : outputPath(defaults.outputDir, "glossary.json")}`,
        `- Character bible: ${outputPath(defaults.outputDir, "character_bible.md")}`,
        `- Workspace: ${outputPath(defaults.outputDir, "_workspace/")}`
      ];
  const outputContract = [
    defaults.split ? `- Split=${defaults.splitSize} means checkpoint/save interval. Process the whole assigned range; do not stop after one split.` : "",
    "- Write the final translation and auxiliary output prose in the target language of the language pair; keep source terms, paths, placeholders, IDs, and schema keys unchanged where required.",
    "- Do not modify the source file.",
    "- MUST preserve one-to-one line alignment, placeholders, tags, variables, IDs, and empty lines. Before finalizing, self-check that source line count equals output line count and every output line maps to the same source line number; fix any mismatch before writing the final file.",
    "- Do not write explanations into translated lines."
  ].filter(Boolean);

  return [
    translateCommandLine(options, defaults),
    ...subagentLines,
    "",
    "Output contract:",
    ...outputContract
  ].join("\n");
}

export function buildProofreadPrompt(options: ProofreadPromptOptions): string {
  const defaults = proofreadDefaults(options);
  const subagentLines = defaults.subagent
    ? [
        `CALL SUBAGENT; SUBAGENT_COUNT=${defaults.subagentCount};`,
        `Mode split ${defaults.splitSize} is a checkpoint interval, not the review scope.`,
        `Divide the full aligned line range into ${defaults.subagentCount} non-overlapping agent ranges of roughly equal size; each subagent must review its full assigned range and save/report progress every ${defaults.splitSize} line pairs.`,
        "After all complete, merge into a single report:",
        `- Final merged overall review: ${outputPath(defaults.outputDir, `${defaults.basename}_proofread_summary.md`)}`,
        `- Final merged fix proposal (single md with suggested fixes): ${outputPath(defaults.outputDir, `${defaults.basename}_fix_proposal.md`)}`,
        "Merge rule: final fix proposal IDs must be globally unique; if parallel outputs duplicate Hx/Mx/Lx numbers, renumber duplicates after the current max for that code."
      ]
    : [
        "NO SUBAGENT;",
        "Output paths:",
        `- ${outputPath(defaults.outputDir, `${defaults.basename}_proofread_summary.md`)}`,
        `- ${outputPath(defaults.outputDir, `${defaults.basename}_fix_proposal.md`)}`
      ];
  const reportContract = [
    defaults.mode === "split" ? `- In split mode, ${defaults.splitSize} means checkpoint/save interval. Review the complete assigned range; do not stop after one split.` : "",
    "- Output language: write all report prose in the target language of the language pair. Keep parser-required fixed labels exactly as required by the proofread-translation format, such as `Suggested fix`.",
    "- `Source` and `Current translation` must contain the full exact line text. `Suggested fix` must be a complete replacement line in the target language, with no explanation or partial edit."
  ].filter(Boolean);

  return [
    proofreadCommandLine(options, defaults),
    `H9 candidate ratio: ${defaults.candidateRatio};`,
    ...subagentLines,
    "",
    "Report contract:",
    ...reportContract
  ].join("\n");
}

export function buildPrompt(options: PromptBuildOptions): string {
  if (options.kind === "proofread") {
    return buildProofreadPrompt({
      agent: options.agent,
      sourcePath: options.sourcePath,
      translationPath: options.translationPath || "",
      glossaryPath: options.glossaryPath,
      outputDir: options.outputDir,
      inputMode: options.inputMode,
      advanced: options.advanced
    });
  }

  return buildTranslatePrompt({
    agent: options.agent,
    sourcePath: options.sourcePath,
    translationPath: options.translationPath,
    outputDir: options.outputDir,
    glossaryPath: options.glossaryPath,
    advanced: options.advanced
  });
}

export function getAgentSetupText(agentType: AgentType): string {
  const agent = skillPaths[agentType];
  if (agentType === "codex") {
    return [
      "Codex setup",
      `Bundled translate-text skill: ${agent.translate}.`,
      `Bundled proofread-translation skill: ${agent.proofread}.`,
      `Global install target: ${agent.installTarget}.`,
      "Use the local Node install command shown in the UI before invoking Codex."
    ].join("\n");
  }

  return [
    "Claude Code setup",
    `Bundled translate command: ${agent.translate}.`,
    `Bundled proofread command: ${agent.proofread}.`,
    `Global install target: ${agent.installTarget}.`,
    "Use the local Node install command shown in the UI before invoking Claude Code."
  ].join("\n");
}
