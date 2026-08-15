import { useEffect, useMemo } from "react";

import { ChatWindow } from "./piweb/ChatWindow";
import type { YnAgentRoute } from "./piweb/electronPiSessionClient";
import { normalizeAgentUiLocale } from "./piweb/i18n";

export function parsePiWebAgentWindowRoute(): YnAgentRoute | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("agent-chat-window")) return null;
  const params = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  return {
    outputDir: params.get("outputDir") || "",
    locale: normalizeAgentUiLocale(params.get("locale")),
    languagePair: params.get("languagePair") || undefined,
    lineReviewPath: params.get("lineReviewPath") || undefined,
    sourcePath: params.get("sourcePath") || undefined,
    sourceKind: params.get("sourceKind") === "folder" ? "folder" : "file",
    translationPath: params.get("translationPath") || undefined,
    initialPrompt: params.get("initialPrompt") || undefined,
    initialWorkflowMetadata: (() => {
      const workflowIntent = params.get("initialWorkflowIntent");
      const languagePair = params.get("initialLanguagePair") || params.get("languagePair") || "";
      return (workflowIntent === "translation" || workflowIntent === "proofread") && languagePair
        ? { workflowIntent, languagePair }
        : undefined;
    })()
  };
}

export function PiWebAgentWindow({ route }: { route: YnAgentRoute }) {
  const locale = normalizeAgentUiLocale(route.locale);
  const title = useMemo(() => {
    const source = route.sourcePath || route.lineReviewPath || route.outputDir || "Agent";
    return source.split(/[\\/]/).at(-1) || "Agent";
  }, [route.lineReviewPath, route.outputDir, route.sourcePath]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.body.classList.add("ynAgentWindowBody");
    return () => document.body.classList.remove("ynAgentWindowBody");
  }, [locale]);

  return <ChatWindow route={{ ...route, locale }} title={title} />;
}
