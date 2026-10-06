import { promptParameterDefaults, type PromptAdvancedOptions } from "./core/prompts.ts";

export type BuiltinTaskKind = "translation" | "proofread" | "assets";

export interface BuiltinTaskSettings extends PromptAdvancedOptions {
  outputDir: string;
  sourcePath: string;
  sourceKind: "file" | "folder";
  translationPath?: string;
  glossaryPath?: string;
  locale: "zh-CN" | "en-US";
  fileType: "auto" | "txt" | "epub";
  inputMode: "separate" | "bilingual";
  sourcePosition: number;
  translationPosition: number;
  pageSize: number;
  materials?: string;
}

export interface StartBuiltinTaskRequest {
  task: BuiltinTaskKind;
  settings: BuiltinTaskSettings;
  autoApplyProofreadSuggestions?: boolean;
  /** Natural-language wishes for the preparation Agent, not executable rules. */
  preservationInstructions?: string;
}

export function builtinTranslationPreparationPrompt(instructions?: string): string {
  if (instructions !== undefined && typeof instructions !== "string") throw new Error("Preservation instructions must be a string.");
  const prompt = "Check the confirmed parameters against representative source content and control-token examples. Use inspectTaskSettings to obtain the internal shared parameter path; updateTaskSettings only when content contradicts the settings. Inspect /n, backslash escapes, tags and code prefixes, and trial narrow preservation rules including existing rules. Then startPreparedWorkflow saves the same HTML parameter form and starts exactly its normal translation prompt. Do not translate during this preflight or create another translation entry. Keep ordinary prose translatable.";
  return instructions?.trim()
    ? `${prompt}\nUser preservation wishes:\n${instructions.trim()}\nInfer narrowly scoped regular expressions from these wishes and actual source examples. Check matched examples and trial the combined rules before saving them to the shared HTML parameters. Do not treat these wishes as executable regex or freeze surrounding translatable prose.`
    : prompt;
}

/** Existing project choices win; new task defaults have one source of truth. */
export function builtinTaskDefaults(current: Partial<BuiltinTaskSettings> = {}): BuiltinTaskSettings {
  return {
    ...current,
    ...promptParameterDefaults(current.outputDir ?? "", current),
    outputDir: current.outputDir ?? "",
    sourcePath: current.sourcePath ?? "",
    sourceKind: current.sourceKind ?? "file",
    translationPath: current.translationPath ?? "",
    glossaryPath: current.glossaryPath ?? "",
    locale: current.locale ?? "zh-CN",
    fileType: current.fileType ?? "auto",
    inputMode: current.inputMode ?? "separate",
    sourcePosition: current.sourcePosition ?? 2,
    translationPosition: current.translationPosition ?? 1,
    pageSize: current.pageSize ?? 1000,
    materials: current.materials ?? ""
  };
}
