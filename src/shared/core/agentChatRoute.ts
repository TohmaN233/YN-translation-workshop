export interface AgentChatReviewRoute {
  outputDir: string;
  locale: "zh-CN" | "en-US";
  languagePair?: string;
  sourcePath?: string;
  sourceKind: "file" | "folder";
  translationPath?: string;
  lineReviewPath?: string;
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
  return {
    outputDir: text(paths.outputDir) || text(data.outputDir),
    locale: data.locale === "en-US" ? "en-US" : "zh-CN",
    languagePair: text(promptDefaults.languagePair) || undefined,
    sourcePath: promptTextPath(paths.promptSourcePath, paths.sourcePath),
    // A folder batch's child review page has a concrete file for line editing,
    // but its Agent prompt is bound to the parent folder manifest. The prompt
    // path/kind pair is the product route contract for that embedded Agent.
    sourceKind: paths.promptSourceKind === "folder" || paths.sourceKind === "folder" ? "folder" : "file",
    translationPath: promptTextPath(paths.promptTranslationPath, paths.translationPath),
    lineReviewPath: currentHtmlPath || text(data.lineReviewPath) || text(paths.lineReviewPath) || undefined
  };
}
