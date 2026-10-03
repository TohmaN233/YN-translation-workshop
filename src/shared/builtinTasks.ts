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
