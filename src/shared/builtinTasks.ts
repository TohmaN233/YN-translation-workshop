import { promptAdvancedForSource, promptParameterDefaults, type PromptAdvancedOptions } from "./core/prompts.ts";

export type BuiltinTaskKind = "translation" | "proofread" | "assets";

export interface BuiltinTaskSettings extends PromptAdvancedOptions {
  outputDir: string;
  sourcePath: string;
  sourceKind: "file" | "folder";
  translationPath?: string;
  glossaryPath?: string;
  locale: "zh-CN" | "en-US";
  fileType: "auto" | "txt" | "epub" | "pdf";
  inputMode: "separate" | "bilingual";
  sourcePosition: number;
  translationPosition: number;
  pageSize: number;
  materials?: string;
}

export interface StartBuiltinTaskRequest {
  requestId?: string;
  task: BuiltinTaskKind;
  settings: BuiltinTaskSettings;
  autoApplyProofreadSuggestions?: boolean;
  /** Natural-language wishes for the preparation Agent, not executable rules. */
  preservationInstructions?: string;
}

export interface HtmlPreparationProgress {
  requestId:string;sourcePath:string;page:number;totalPages:number;
  phase?:'extracting'|'structuring'|'auditing'|'validating'|'accepted';
}

export function htmlPreparationProgressMessage(progress:HtmlPreparationProgress,locale:'zh-CN'|'en-US'):string {
  const zh=locale==='zh-CN',file=progress.sourcePath.split(/[\\/]/u).pop()||progress.sourcePath;
  switch(progress.phase) {
    case 'structuring':return zh?'正在整理 PDF 原文的段落、阅读顺序和表格…':'Organizing PDF paragraphs, reading order, and tables…';
    case 'auditing':return zh?'正在独立检查 PDF 原文结构与保留内容…':'Independently checking PDF structure and preserved content…';
    case 'validating':return zh?'正在核验源文覆盖、原生字形和结构验收…':'Validating source coverage, native glyphs, and structure acceptance…';
    case 'accepted':return zh?'PDF 原文结构已通过检查，正在生成 HTML…':'PDF source structure accepted. Generating HTML…';
    default:return progress.totalPages>0
      ?zh?`正在读取 ${file}：第 ${progress.page}/${progress.totalPages} 页…`:`Reading ${file}: page ${progress.page}/${progress.totalPages}…`
      :zh?'正在读取 PDF 原文…':'Reading PDF source…';
  }
}

/** Restore the input binding after lazy preparation replaced it with canonical TXT. */
export function restoreTaskInputTranslationPath(projectState: Record<string, unknown>, settings: BuiltinTaskSettings): BuiltinTaskSettings {
  const input = projectState.builtinTaskInputSettings;
  const expectedPath = projectState.builtinTaskTranslationPath;
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase();
  if (projectState.translationBindingOrigin === "canonical" && input && typeof input === "object" && !Array.isArray(input)
    && typeof expectedPath === "string" && expectedPath.trim() && normalize(settings.translationPath ?? "") === normalize(expectedPath)) {
    const translationPath = (input as Record<string, unknown>).translationPath;
    return { ...settings, translationPath: typeof translationPath === "string" ? translationPath : "" };
  }
  return settings;
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
  const advanced = promptAdvancedForSource(current.sourceKind, current);
  return {
    ...current,
    ...advanced,
    ...promptParameterDefaults(current.outputDir ?? "", advanced),
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
