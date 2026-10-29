import type { PiFolderSourceDocument } from "../agent/piSessionContract.ts";

export interface AgentChatReviewRoute {
  outputDir: string;
  locale: "zh-CN" | "en-US";
  languagePair?: string;
  sourcePath?: string;
  sourceKind: "file" | "folder";
  translationPath?: string;
  lineReviewPath?: string;
  folderSourceDocuments?: PiFolderSourceDocument[];
  folderSourceSelection?: "prepared-inputs";
}

export function agentChatRouteFromReviewData(
  reviewData: unknown,
  currentHtmlPath = ""
): AgentChatReviewRoute {
  const record = (value: unknown): Record<string, unknown> => (
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  );
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  const safeTextPath = (value: unknown): string | undefined => {
    const candidate = text(value);
    return !candidate || /\.epub$/i.test(candidate) ? undefined : candidate;
  };
  const promptTextPath = (promptValue: unknown, fallbackValue: unknown): string | undefined => {
    return safeTextPath(promptValue) ?? safeTextPath(fallbackValue);
  };
  const data = record(reviewData);
  const workflow = record(data.workflow);
  const paths = record(workflow.paths);
  const promptDefaults = record(workflow.promptDefaults);
  const sourceKind = paths.promptSourceKind === "folder" || paths.sourceKind === "folder" ? "folder" : "file";
  const advanced = record(workflow.advanced);
  const documents = advanced.folderSourceDocuments ?? promptDefaults.folderSourceDocuments;
  const selection = advanced.folderSourceSelection ?? promptDefaults.folderSourceSelection;
  let folderSourceDocuments: PiFolderSourceDocument[] | undefined;
  if (sourceKind === "folder" && documents !== undefined) {
    if (!Array.isArray(documents) || !documents.length) throw new Error("Folder chat requires a non-empty extracted source document list.");
    folderSourceDocuments = documents.map(document => {
      const item = record(document);
      if (!text(item.id).trim() || !text(item.path).trim()) throw new Error("Folder chat source documents require an id and path.");
      return { id: text(item.id), path: text(item.path),
        ...(item.projection === undefined ? {} : { projection: item.projection as PiFolderSourceDocument["projection"] }) };
    });
  }
  if (sourceKind === "folder" && selection !== undefined && selection !== "prepared-inputs") throw new Error("Invalid folder chat source selection.");
  if (sourceKind === "folder" && selection && !folderSourceDocuments) throw new Error("Prepared folder chat requires its extracted source documents.");
  return {
    outputDir: text(paths.outputDir) || text(data.outputDir),
    locale: data.locale === "en-US" ? "en-US" : "zh-CN",
    languagePair: text(promptDefaults.languagePair) || undefined,
    sourcePath: promptTextPath(paths.promptSourcePath, paths.sourcePath),
    // A folder batch's child review page has a concrete file for line editing,
    // but its Agent prompt is bound to the parent folder manifest. The prompt
    // path/kind pair is the product route contract for that embedded Agent.
    sourceKind,
    translationPath: promptTextPath(paths.promptTranslationPath, paths.translationPath),
    lineReviewPath: currentHtmlPath || text(data.lineReviewPath) || text(paths.lineReviewPath) || undefined,
    ...(folderSourceDocuments ? { folderSourceDocuments } : {}),
    ...(sourceKind === "folder" && selection === "prepared-inputs" ? { folderSourceSelection: selection } : {})
  };
}
