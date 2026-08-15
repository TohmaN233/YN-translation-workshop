import type {
  PiSessionBootstrap,
  PiSessionCompactRequest,
  PiSessionCompactionResult,
  PiSessionEventEnvelope,
  PiSessionImageAttachment,
  PiSessionPromptRequest,
  PiSessionRunState,
  PiSessionStateEnvelope,
  PiSessionSummary,
  PiWorkflowPromptMetadata
} from "../../../shared/agent/piSessionContract.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface YnAgentRoute {
  outputDir: string;
  locale?: "zh-CN" | "en-US";
  languagePair?: string;
  lineReviewPath?: string;
  sourcePath?: string;
  sourceKind?: "file" | "folder";
  translationPath?: string;
  initialPrompt?: string;
  initialWorkflowMetadata?: PiWorkflowPromptMetadata;
}

function api(): Window["workshop"]["agentSession"] {
  const value = window.workshop?.agentSession;
  if (!value) throw new Error("Pi AgentSession bridge is unavailable.");
  return value;
}

export const electronPiSessionClient = {
  loadBootstrap(outputDir: string): Promise<PiSessionBootstrap> {
    return api().loadBootstrap({ outputDir });
  },

  loadMessages(outputDir: string, sessionId: string): Promise<AgentMessage[]> {
    return api().loadMessages({ outputDir, sessionId });
  },

  loadSubagentMessages(outputDir: string, parentSessionId: string, childSessionId: string): Promise<AgentMessage[]> {
    return api().loadSubagentMessages({ outputDir, parentSessionId, childSessionId });
  },

  loadRunState(outputDir: string, sessionId: string): Promise<PiSessionRunState> {
    return api().loadRunState({ outputDir, sessionId });
  },

  loadRecentEvents(outputDir: string, sessionId: string, afterSequence = 0): Promise<PiSessionEventEnvelope[]> {
    return api().loadRecentEvents({ outputDir, sessionId, afterSequence });
  },

  createSession(outputDir: string): Promise<PiSessionSummary> {
    return api().createSession({ outputDir });
  },

  async selectSession(outputDir: string, sessionId: string): Promise<void> {
    await api().selectSession({ outputDir, sessionId });
  },

  async deleteSession(outputDir: string, sessionId: string): Promise<void> {
    await api().deleteSession({ outputDir, sessionId });
  },

  sendPrompt(request: PiSessionPromptRequest) {
    return api().sendPrompt(request);
  },

  compact(request: PiSessionCompactRequest): Promise<PiSessionCompactionResult> {
    return api().compact(request);
  },

  async abort(outputDir: string, sessionId: string): Promise<void> {
    await api().abort({ outputDir, sessionId });
  },

  async sendInput(
    outputDir: string,
    sessionId: string,
    kind: "steer" | "followUp",
    text: string,
    images?: PiSessionImageAttachment[]
  ): Promise<void> {
    await api().sendInput({ outputDir, sessionId, kind, text, images });
  },

  subscribeEvents(listener: (event: PiSessionEventEnvelope) => void): () => void {
    return api().onEvent(listener);
  },

  subscribeState(listener: (payload: PiSessionStateEnvelope) => void): () => void {
    return api().onSessionUpdate(listener);
  }
};
