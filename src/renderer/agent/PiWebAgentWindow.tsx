import { useEffect, useMemo } from "react";

import { ChatWindow } from "./piweb/ChatWindow";
import type { YnAgentRoute } from "./piweb/electronPiSessionClient";
import type { PiSessionPromptRequest } from "../../shared/agent/piSessionContract.ts";
import { normalizeAgentUiLocale } from "./piweb/i18n";

type FolderSourceDocuments = NonNullable<PiSessionPromptRequest["folderSourceDocuments"]>;
type FolderSourceProjection = FolderSourceDocuments[number]["projection"];

interface AgentChatWindowRouteError {
  routeError: string;
}

function parseFolderSourceBinding(params: URLSearchParams, sourceKind: "file" | "folder"):
  Pick<YnAgentRoute, "folderSourceDocuments" | "folderSourceSelection"> {
  const serializedDocuments = params.get("folderSourceDocuments");
  const serializedSelection = params.get("folderSourceSelection");
  if (sourceKind !== "folder") {
    if (serializedDocuments !== null || serializedSelection !== null) {
      throw new Error("Folder source bindings were supplied for a single-file Agent route.");
    }
    return {};
  }

  let folderSourceDocuments: FolderSourceDocuments | undefined;
  if (serializedDocuments !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedDocuments);
    } catch (error) {
      throw new Error(`Folder source document binding is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Folder source document binding must be a non-empty array.");
    }
    folderSourceDocuments = parsed.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Folder source document binding at index ${index} must be an object.`);
      }
      const document = entry as Record<string, unknown>;
      if (typeof document.id !== "string" || !document.id.trim() || typeof document.path !== "string" || !document.path.trim()
        || /\.epub$/i.test(document.path)) {
        throw new Error(`Folder source document binding at index ${index} requires an id and extracted text path.`);
      }
      let projection: FolderSourceProjection;
      if (document.projection !== undefined) {
        if (!document.projection || typeof document.projection !== "object" || Array.isArray(document.projection)) {
          throw new Error(`Folder source projection at index ${index} must be an object.`);
        }
        const proof = document.projection as Record<string, unknown>;
        if ((proof.kind !== "bilingual-pairs" && proof.kind !== "epub-text" && proof.kind !== "pdf-text" && proof.kind !== "text-lines")
          || typeof proof.originalHash !== "string" || !/^[a-f0-9]{64}$/.test(proof.originalHash)
          || typeof proof.projectionHash !== "string" || !/^[a-f0-9]{64}$/.test(proof.projectionHash)) {
          throw new Error(`Folder source projection provenance at index ${index} is invalid.`);
        }
        projection = { kind: proof.kind, originalHash: proof.originalHash, projectionHash: proof.projectionHash };
      }
      return { id: document.id, path: document.path, ...(projection ? { projection } : {}) };
    });
  }

  if (serializedSelection !== null && serializedSelection !== "prepared-inputs") {
    throw new Error("Folder source selection is invalid.");
  }
  if (serializedSelection === "prepared-inputs" && !folderSourceDocuments) {
    throw new Error("Prepared folder source selection requires its extracted document bindings.");
  }
  return {
    ...(folderSourceDocuments ? { folderSourceDocuments } : {}),
    ...(serializedSelection === "prepared-inputs" ? { folderSourceSelection: serializedSelection } : {})
  };
}

export function parsePiWebAgentWindowRoute(): (YnAgentRoute | AgentChatWindowRouteError) | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("agent-chat-window")) return null;
  const params = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  const sourceKind = params.get("sourceKind") === "folder" ? "folder" : "file";
  let folderSourceBinding: Pick<YnAgentRoute, "folderSourceDocuments" | "folderSourceSelection">;
  try {
    folderSourceBinding = parseFolderSourceBinding(params, sourceKind);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[agent-chat-window:route] Invalid folder source binding", error);
    return { routeError: message };
  }
  return {
    outputDir: params.get("outputDir") || "",
    locale: normalizeAgentUiLocale(params.get("locale")),
    languagePair: params.get("languagePair") || undefined,
    lineReviewPath: params.get("lineReviewPath") || undefined,
    sourcePath: params.get("sourcePath") || undefined,
    sourceKind,
    ...folderSourceBinding,
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

export function PiWebAgentWindow({ route }: { route: YnAgentRoute | AgentChatWindowRouteError }) {
  const locale = normalizeAgentUiLocale("locale" in route ? route.locale : undefined);
  const title = useMemo(() => {
    const source = "routeError" in route ? "Agent error" : route.sourcePath || route.lineReviewPath || route.outputDir || "Agent";
    return source.split(/[\\/]/).at(-1) || "Agent";
  }, [route]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.body.classList.add("ynAgentWindowBody");
    return () => document.body.classList.remove("ynAgentWindowBody");
  }, [locale]);

  if ("routeError" in route) {
    return <main role="alert" lang={locale} style={{ padding: "2rem", color: "#8a1c1c", fontFamily: "system-ui, sans-serif" }}>
      <h1>Agent window could not open</h1>
      <p>The serialized folder source binding is invalid. Reopen the Agent window from the source project.</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{route.routeError}</pre>
    </main>;
  }

  return <ChatWindow route={{ ...route, locale }} title={title} />;
}
