import type { YnAgentRoute } from "./piweb/electronPiSessionClient.ts";
import { normalizeAgentUiLocale } from "./piweb/i18n.ts";

export function normalizeEmbeddedRoute(
  input: Partial<YnAgentRoute> | undefined,
  fallbackLocale: "zh-CN" | "en-US" = "zh-CN"
): YnAgentRoute {
  return {
    outputDir: input?.outputDir || "",
    locale: normalizeAgentUiLocale(input?.locale ?? fallbackLocale),
    languagePair: input?.languagePair || undefined,
    lineReviewPath: input?.lineReviewPath || undefined,
    sourcePath: input?.sourcePath || undefined,
    sourceKind: input?.sourceKind === "folder" ? "folder" : input?.sourceKind === "file" ? "file" : undefined,
    translationPath: input?.translationPath || undefined
  };
}
