import { BrowserWindow, type NativeImage } from "electron";
import path from "node:path";
import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";

export interface AgentChatWindowArgs extends Pick<PiSessionPromptRequest, "folderSourceDocuments" | "folderSourceSelection"> {
  lineReviewPath?: string;
  outputDir?: string;
  locale?: "zh-CN" | "en-US";
  languagePair?: string;
  sourcePath?: string;
  sourceKind?: "file" | "folder";
  translationPath?: string;
  initialPrompt?: string;
  initialWorkflowIntent?: "translation" | "proofread";
  initialLanguagePair?: string;
}

export interface AgentChatWindowHostOptions {
  args: AgentChatWindowArgs;
  preloadPath: string;
  icon?: string | NativeImage;
  loadRendererRoute: (window: BrowserWindow, route: string) => Promise<void>;
  onWindowCreated?: (window: BrowserWindow) => void;
}

export interface AgentChatWindowResult {
  window: BrowserWindow;
  surface: "renderer-popout";
}

function serializeFolderSourceDocuments(documents: PiSessionPromptRequest["folderSourceDocuments"]): string {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("Folder source documents must be a non-empty array before opening an Agent window.");
  }
  return JSON.stringify(documents.map((document, index) => {
    if (!document || typeof document !== "object" || typeof document.id !== "string" || !document.id.trim()
      || typeof document.path !== "string" || !document.path.trim()) {
      throw new Error(`Folder source document ${index} requires an id and extracted text path before opening an Agent window.`);
    }
    const projection = document.projection;
    if (projection === undefined) return { id: document.id, path: document.path };
    if (!projection || typeof projection !== "object"
      || (projection.kind !== "bilingual-pairs" && projection.kind !== "epub-text" && projection.kind !== "pdf-text" && projection.kind !== "text-lines")
      || !/^[a-f0-9]{64}$/.test(projection.originalHash)
      || !/^[a-f0-9]{64}$/.test(projection.projectionHash)) {
      throw new Error(`Folder source projection provenance ${index} is invalid before opening an Agent window.`);
    }
    return {
      id: document.id,
      path: document.path,
      projection: {
        kind: projection.kind,
        originalHash: projection.originalHash,
        projectionHash: projection.projectionHash
      }
    };
  }));
}

function cleanLineReviewPath(value: string | undefined): string | undefined {
  const clean = value?.replace(/#.*$/, "").trim();
  return clean ? path.resolve(clean) : undefined;
}

export async function openAgentChatWindow(options: AgentChatWindowHostOptions): Promise<AgentChatWindowResult> {
  const lineReviewPath = cleanLineReviewPath(options.args.lineReviewPath);

  const window = new BrowserWindow({
    show: process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1",
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    icon: options.icon,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1",
      offscreen: process.env.YN_ELECTRON_VERIFY_OFFSCREEN === "1"
    }
  });
  options.onWindowCreated?.(window);

  const params = new URLSearchParams();
  if (options.args.outputDir) params.set("outputDir", options.args.outputDir);
  if (options.args.locale) params.set("locale", options.args.locale);
  if (options.args.languagePair) params.set("languagePair", options.args.languagePair);
  if (lineReviewPath) params.set("lineReviewPath", lineReviewPath);
  if (options.args.sourcePath) params.set("sourcePath", options.args.sourcePath);
  if (options.args.sourceKind) params.set("sourceKind", options.args.sourceKind);
  if (options.args.folderSourceDocuments !== undefined) {
    params.set("folderSourceDocuments", serializeFolderSourceDocuments(options.args.folderSourceDocuments));
  }
  if (options.args.folderSourceSelection !== undefined) {
    params.set("folderSourceSelection", options.args.folderSourceSelection);
  }
  if (options.args.translationPath) params.set("translationPath", options.args.translationPath);
  if (options.args.initialPrompt) params.set("initialPrompt", options.args.initialPrompt);
  if (options.args.initialWorkflowIntent) params.set("initialWorkflowIntent", options.args.initialWorkflowIntent);
  if (options.args.initialLanguagePair) params.set("initialLanguagePair", options.args.initialLanguagePair);
  await options.loadRendererRoute(window, `agent-chat-window?${params.toString()}`);
  return { window, surface: "renderer-popout" };
}
