import { createRoot } from "react-dom/client";

import { ChatWindow } from "./piweb/ChatWindow";
import type { YnAgentRoute } from "./piweb/electronPiSessionClient";
import type { PiWorkflowPromptMetadata } from "../../shared/agent/piSessionContract.ts";
import { normalizeEmbeddedRoute } from "./embeddedRoute";
import "../styles.css";

declare global {
  interface Window {
    YnPiWebAgentEmbedded?: {
      mount: (target: HTMLElement, route: { outputDir?: string; locale?: "zh-CN" | "en-US"; languagePair?: string; sourcePath?: string; sourceKind?: "file" | "folder"; translationPath?: string; lineReviewPath?: string }) => Promise<void>;
      close?: () => void;
      popout?: () => void;
      insertText?: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
      insertIfEmpty?: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
      replaceText?: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
      openSettings?: () => void;
    };
    __ynAgentChatPiWebEmbedded?: {
      close?: () => void;
      popout?: () => void;
      insertText?: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
      insertIfEmpty?: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
      replaceText?: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
      openSettings?: () => void;
    };
  }
}

function installEmbeddedWorkshopBridge() {
  if (window.workshop) return;
  const parentWorkshop = window.parent !== window ? window.parent.workshop : undefined;
  if (parentWorkshop) {
    (window as unknown as { workshop: unknown }).workshop = parentWorkshop;
    return;
  }
  const html = window.workshopHtml
    ?? (window.parent !== window ? window.parent.workshopHtml : undefined);
  if (!html) {
    throw new Error("Embedded Agent OS cannot reach the Electron workshop bridge.");
  }
  (window as unknown as { workshop: unknown }).workshop = {
    agentSession: html.agentSession,
    getAgentProviderConfig: html.getAgentProviderConfig,
    saveAgentProviderConfig: html.saveAgentProviderConfig,
    listAgentProviders: html.listAgentProviders,
    listAgentModels: html.listAgentModels,
    listAgentOAuthProfiles: html.listAgentOAuthProfiles,
    setAgentOAuthProfile: html.setAgentOAuthProfile,
    connectAgentProviderOAuth: html.connectAgentProviderOAuth,
    validateAgentProvider: html.validateAgentProvider,
    onAgentProviderUpdate: html.onAgentProviderUpdate,
    openAgentChatWindow: html.openAgentChatWindow
  };
}

window.YnPiWebAgentEmbedded = {
  close: () => window.__ynAgentChatPiWebEmbedded?.close?.(),
  popout: () => window.__ynAgentChatPiWebEmbedded?.popout?.(),
  openSettings: () => window.__ynAgentChatPiWebEmbedded?.openSettings?.(),
  mount(target, route) {
    installEmbeddedWorkshopBridge();
    const root = createRoot(target);
    window.addEventListener("pagehide", () => root.unmount(), { once: true });
    return new Promise<void>((resolve) => {
      root.render(
        <ChatWindow
          route={normalizeEmbeddedRoute(
            route,
            document.documentElement.lang === "en-US" ? "en-US" : "zh-CN"
          )}
          title="YN Agent OS"
          onEmbeddedReady={resolve}
        />
      );
    });
  }
};
