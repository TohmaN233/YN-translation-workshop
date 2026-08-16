import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentMessage as NativeAgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

import type {
  PiSessionCompactionResult,
  PiSessionContextUsage,
  PiSessionEventEnvelope,
  PiSessionImageAttachment,
  PiSessionRunState,
  PiSessionSummary,
  PiWorkflowPromptMetadata
} from "../../../shared/agent/piSessionContract.ts";
import { electronPiSessionClient, type YnAgentRoute } from "./electronPiSessionClient";
import type { AttachedImage } from "./ChatInput";
import { normalizeToolCalls } from "./normalize";
import type { SessionStatsInfo } from "./sessionTypes";
import type { AgentMessage, AssistantMessage } from "./types";

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: Array<{ name: string }> }
  | { kind: "running_command" }
  | null;

export interface UseAgentSessionOptions {
  route: YnAgentRoute;
  onAgentEnd?: () => void;
}

type ThinkingLevelOption = ThinkingLevel | "auto";
type ModelEntry = { id: string; name: string; provider: string; supportsImages: boolean; thinkingLevels?: ThinkingLevel[] };

function thinkingLevelForModel(
  model: Pick<ModelEntry, "thinkingLevels"> | undefined,
  stored: ThinkingLevelOption | undefined
): ThinkingLevelOption {
  if (!stored || stored === "auto") return "auto";
  return model?.thinkingLevels?.includes(stored) ? stored : "auto";
}
type SelectedModel = { provider: string; modelId: string };
type ProviderConfigDoc = Awaited<ReturnType<typeof window.workshop.getAgentProviderConfig>>;

export function resolveConfiguredModelSelection(
  config: ProviderConfigDoc,
  modelList: ModelEntry[]
): SelectedModel {
  const activeProviderModels = modelList.filter((model) => model.provider === config.activeProviderId);
  const provider = activeProviderModels.length > 0
    ? config.activeProviderId
    : (modelList[0]?.provider ?? "");
  const providerModels = modelList.filter((model) => model.provider === provider);
  const storedModel = (config.providers[provider] as { model?: string } | undefined)?.model;
  const modelId = storedModel && providerModels.some((model) => model.id === storedModel)
    ? storedModel
    : (providerModels[0]?.id ?? "");
  return { provider, modelId };
}

export interface SessionState {
  sessionId: string;
  sessions: PiSessionSummary[];
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  agentRunning: boolean;
  phase: AgentPhase;
  phaseText: string;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  providerId: string;
  modelId: string;
  modelList: ModelEntry[];
  modelNames: Record<string, string>;
  thinkingLevel: ThinkingLevelOption;
  queuedSteer: AgentMessage[];
  queuedFollowUp: AgentMessage[];
  queuedNextTurn: AgentMessage[];
  isCompacting: boolean;
  compactResult: PiSessionCompactionResult | null;
  compactError: string | null;
  contextUsage: PiSessionContextUsage | null;
  lastSequence: number;
}

const INITIAL_STATE: SessionState = {
  sessionId: "",
  sessions: [],
  messages: [],
  streamingMessage: null,
  agentRunning: false,
  phase: null,
  phaseText: "ready",
  retryInfo: null,
  providerId: "",
  modelId: "",
  modelList: [],
  modelNames: {},
  thinkingLevel: "auto",
  queuedSteer: [],
  queuedFollowUp: [],
  queuedNextTurn: [],
  isCompacting: false,
  compactResult: null,
  compactError: null,
  contextUsage: null,
  lastSequence: 0
};

type SessionStateUpdate = SessionState | ((current: SessionState) => SessionState);

export function createSynchronizedSessionState(initial: SessionState) {
  const store = {
    current: initial,
    update(update: SessionStateUpdate): SessionState {
      const next = typeof update === "function" ? update(store.current) : update;
      store.current = next;
      return next;
    }
  };
  return store;
}

function workspaceMatches(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function userImageFingerprints(message: AgentMessage): string[] {
  if (message.role !== "user" || typeof message.content === "string") return [];
  return message.content.filter((block) => block.type === "image").map((block) => {
    const flat = block as unknown as { data?: string; mimeType?: string };
    const data = block.source?.data ?? flat.data ?? "";
    const mimeType = block.source?.media_type ?? flat.mimeType ?? "";
    return `${mimeType}:${data.length}:${data.slice(0, 24)}:${data.slice(-24)}`;
  });
}

function messageContentSignature(message: AgentMessage): string {
  if (message.role === "toolResult") return message.toolCallId;
  if (message.role === "user") return JSON.stringify([userText(message), userImageFingerprints(message)]);
  if (message.role === "assistant") return JSON.stringify(message.content);
  return JSON.stringify({ customType: message.customType, content: message.content, details: message.details });
}

export function appendPiSessionMessage(
  messages: AgentMessage[],
  incoming: NativeAgentMessage | AgentMessage
): AgentMessage[] {
  const normalized = normalizeToolCalls(incoming);
  if (normalized.role === "custom" && normalized.details && typeof normalized.details === "object") {
    const subagentId = (normalized.details as Record<string, unknown>).subagentId;
    if (typeof subagentId === "string" && subagentId) {
      const index = messages.findIndex((message) => (
        message.role === "custom"
        && message.details
        && typeof message.details === "object"
        && (message.details as Record<string, unknown>).subagentId === subagentId
      ));
      if (index >= 0) return messages.map((message, itemIndex) => itemIndex === index ? normalized : message);
      return [...messages, normalized];
    }
  }
  if (normalized.role === "user") {
    const signature = messageContentSignature(normalized);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant") break;
      if (message.role === "user" && messageContentSignature(message) === signature) {
        return messages.map((item, itemIndex) => itemIndex === index ? normalized : item);
      }
    }
  }
  const signature = messageContentSignature(normalized);
  if (messages.some((message) => (
    message.role === normalized.role
    && message.timestamp === normalized.timestamp
    && messageContentSignature(message) === signature
  ))) {
    return messages;
  }
  return [...messages, normalized];
}

function phaseFromState(runState: PiSessionRunState): AgentPhase {
  if (runState.compacting) return { kind: "running_command" };
  if (!runState.running) return null;
  return { kind: "waiting_model" };
}

export function mergePiRunState(
  current: SessionState,
  runState: PiSessionRunState,
  preserveOptimisticRun = false
): SessionState {
  const preserve = preserveOptimisticRun
    && !runState.running
    && !runState.compacting
    && !runState.error
    && !runState.compactionError;
  const messages = runState.subagentMessages.reduce(
    (merged, message) => appendPiSessionMessage(merged, message),
    current.messages
  );
  return {
    ...current,
    messages,
    agentRunning: preserve ? true : runState.running,
    streamingMessage: runState.streamingMessage
      ? normalizeToolCalls(runState.streamingMessage as AgentMessage)
      : preserve ? current.streamingMessage : null,
    phase: preserve ? current.phase : phaseFromState(runState),
    phaseText: preserve
      ? current.phaseText
      : runState.compactionError || runState.error || (runState.compacting ? "compacting" : runState.running ? "thinking" : "ready"),
    queuedSteer: runState.queuedSteer.map(normalizeToolCalls),
    queuedFollowUp: runState.queuedFollowUp.map(normalizeToolCalls),
    queuedNextTurn: runState.queuedNextTurn.map(normalizeToolCalls),
    isCompacting: runState.compacting,
    compactResult: runState.lastCompaction ?? current.compactResult,
    compactError: runState.compactionError ?? null,
    contextUsage: runState.contextUsage ?? current.contextUsage,
    lastSequence: Math.max(current.lastSequence, runState.sequence),
    thinkingLevel: current.thinkingLevel === "auto" && runState.thinkingLevel !== "off"
      ? runState.thinkingLevel
      : current.thinkingLevel
  };
}

export function nativeRunStateClaimsPrompt(runState: PiSessionRunState): boolean {
  return runState.running
    || runState.compacting
    || Boolean(runState.error)
    || Boolean(runState.compactionError);
}

export function convergePiTerminalState(
  current: SessionState,
  messages: AgentMessage[],
  runState: PiSessionRunState,
  terminalSequence: number,
  runError?: string,
  preserveOptimisticRun = false
): SessionState {
  const observedSequence = Math.max(terminalSequence, runState.sequence);
  if (current.lastSequence > observedSequence || (preserveOptimisticRun && current.agentRunning)) return current;
  const merged = mergePiRunState({ ...current, messages }, runState);
  return {
    ...merged,
    messages,
    phaseText: runError || runState.error || (runState.running ? "thinking" : "ready")
  };
}

export function shouldApplyPiSessionState(
  currentSessionId: string,
  incomingSessionId: string,
  selectionChange: boolean
): boolean {
  return currentSessionId === incomingSessionId || selectionChange;
}

export function reduceNativePiEvent(
  current: SessionState,
  envelope: PiSessionEventEnvelope
): SessionState {
  if (envelope.sessionId !== current.sessionId || envelope.sequence <= current.lastSequence) return current;
  const event = envelope.event;
  let next = { ...current, lastSequence: envelope.sequence };
  if (event.type === "agent_start") {
    return { ...next, agentRunning: true, phase: { kind: "waiting_model" }, phaseText: "thinking" };
  }
  if (event.type === "auto_retry_start") {
    return {
      ...next,
      agentRunning: true,
      phase: { kind: "waiting_model" },
      phaseText: `retrying ${event.attempt}/${event.maxAttempts}`,
      retryInfo: {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: event.errorMessage
      }
    };
  }
  if (event.type === "auto_retry_end") {
    return {
      ...next,
      agentRunning: event.success ? next.agentRunning : false,
      phase: null,
      phaseText: event.success ? "running" : (event.finalError || "retry failed"),
      retryInfo: null
    };
  }
  if ((event.type === "message_start" || event.type === "message_update") && event.message?.role === "assistant") {
    return {
      ...next,
      agentRunning: true,
      streamingMessage: normalizeToolCalls(event.message),
      phase: null,
      phaseText: "running"
    };
  }
  if (event.type === "message_end" && event.message) {
    const assistantError = event.message.role === "assistant"
      && event.message.stopReason === "error"
      ? event.message.errorMessage?.trim() || "The model provider failed without an error message."
      : null;
    return {
      ...next,
      messages: appendPiSessionMessage(next.messages, event.message),
      streamingMessage: event.message.role === "assistant" ? null : next.streamingMessage,
      agentRunning: assistantError ? false : next.agentRunning,
      phase: assistantError ? null : next.phase,
      phaseText: assistantError || next.phaseText
    };
  }
  if (event.type === "tool_execution_start") {
    return {
      ...next,
      phase: { kind: "running_tools", tools: [{ name: event.toolName || "tool" }] },
      phaseText: "running"
    };
  }
  if (event.type === "queue_update") {
    return {
      ...next,
      queuedSteer: event.steer.map(normalizeToolCalls),
      queuedFollowUp: event.followUp.map(normalizeToolCalls),
      queuedNextTurn: event.nextTurn.map(normalizeToolCalls)
    };
  }
  if (event.type === "settled") {
    return { ...next, agentRunning: false, streamingMessage: null, phase: null, phaseText: "ready" };
  }
  return next;
}

function assistantUsage(messages: AgentMessage[]) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = (message as AssistantMessage).usage;
    if (!usage) continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { tokens, cost };
}

export function useAgentSession({ route, onAgentEnd }: UseAgentSessionOptions) {
  const [state, setRenderedState] = useState<SessionState>(INITIAL_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerConfig, setProviderConfig] = useState<ProviderConfigDoc | null>(null);
  const stateStoreRef = useRef<ReturnType<typeof createSynchronizedSessionState> | null>(null);
  if (!stateStoreRef.current) stateStoreRef.current = createSynchronizedSessionState(INITIAL_STATE);
  const stateRef = stateStoreRef.current;
  const setState = useCallback((update: SessionStateUpdate) => {
    const next = stateRef.update(update);
    setRenderedState(next);
    return next;
  }, [stateRef]);
  const loadEpochRef = useRef(0);
  const ensureSessionRef = useRef<Promise<string> | null>(null);
  const promptSequenceRef = useRef(0);
  const pendingPromptRef = useRef<{
    id: number;
    sessionId: string;
    cancelled: boolean;
  } | null>(null);
  const terminalConvergenceRef = useRef("");
  const providerReloadEpochRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);

  const convergeTerminalSession = useCallback(async (
    sessionId: string,
    sequence: number,
    runError?: string
  ) => {
    if (!route.outputDir || !sessionId) return;
    const convergenceKey = `${sessionId}:${sequence}`;
    if (terminalConvergenceRef.current === convergenceKey) return;
    terminalConvergenceRef.current = convergenceKey;
    const hasPendingPrompt = () => {
      const pending = pendingPromptRef.current;
      return Boolean(pending && (!pending.sessionId || pending.sessionId === sessionId));
    };
    if (hasPendingPrompt()) {
      terminalConvergenceRef.current = "";
      return;
    }
    try {
      const [loadedMessages, runState] = await Promise.all([
        electronPiSessionClient.loadMessages(route.outputDir, sessionId),
        electronPiSessionClient.loadRunState(route.outputDir, sessionId)
      ]);
      const messages = loadedMessages.map(normalizeToolCalls);
      if (stateRef.current.sessionId !== sessionId) return;
      if (hasPendingPrompt()) {
        terminalConvergenceRef.current = "";
        return;
      }
      setState((current) => {
        if (current.sessionId !== sessionId) return current;
        return convergePiTerminalState(
          current,
          messages,
          runState,
          sequence,
          runError,
          hasPendingPrompt()
        );
      });
      if (runError || runState.error) setError(runError || runState.error || null);
      onAgentEnd?.();
    } catch (loadError) {
      if (terminalConvergenceRef.current === convergenceKey) terminalConvergenceRef.current = "";
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [onAgentEnd, route.outputDir]);

  const applyRunState = useCallback((runState: PiSessionRunState) => {
    if (runState.sessionId !== stateRef.current.sessionId) return;
    const pending = pendingPromptRef.current;
    const matchesPending = Boolean(pending && (!pending.sessionId || pending.sessionId === runState.sessionId));
    const nativeOwnsPrompt = matchesPending && nativeRunStateClaimsPrompt(runState);
    if (nativeOwnsPrompt) pendingPromptRef.current = null;
    const preserveOptimistic = matchesPending && !nativeOwnsPrompt;
    setState((current) => mergePiRunState(current, runState, preserveOptimistic));
  }, []);

  const loadSelectedSession = useCallback(async (sessionId: string, epoch: number) => {
    if (!route.outputDir || !sessionId) return;
    const runState = await electronPiSessionClient.loadRunState(route.outputDir, sessionId);
    const messages = (await electronPiSessionClient.loadMessages(route.outputDir, sessionId)).map(normalizeToolCalls);
    const recentEvents = await electronPiSessionClient.loadRecentEvents(
      route.outputDir,
      sessionId,
      runState.sequence
    );
    if (loadEpochRef.current !== epoch || stateRef.current.sessionId !== sessionId) return;
    setState((current) => {
      const liveAdvanced = current.lastSequence > runState.sequence;
      const loadedMessages = runState.subagentMessages.reduce(
        (merged, message) => appendPiSessionMessage(merged, message),
        messages
      );
      let next: SessionState = {
        ...current,
        messages: liveAdvanced
          ? current.messages.reduce((merged, message) => appendPiSessionMessage(merged, message), loadedMessages)
          : loadedMessages,
        agentRunning: liveAdvanced ? current.agentRunning : runState.running,
        streamingMessage: liveAdvanced
          ? current.streamingMessage
          : runState.streamingMessage
            ? normalizeToolCalls(runState.streamingMessage as AgentMessage)
            : null,
        phase: liveAdvanced ? current.phase : phaseFromState(runState),
        phaseText: liveAdvanced
          ? current.phaseText
          : runState.compactionError || runState.error || (runState.compacting ? "compacting" : runState.running ? "thinking" : "ready"),
        queuedSteer: liveAdvanced ? current.queuedSteer : runState.queuedSteer.map(normalizeToolCalls),
        queuedFollowUp: liveAdvanced ? current.queuedFollowUp : runState.queuedFollowUp.map(normalizeToolCalls),
        queuedNextTurn: liveAdvanced ? current.queuedNextTurn : runState.queuedNextTurn.map(normalizeToolCalls),
        isCompacting: liveAdvanced ? current.isCompacting : runState.compacting,
        compactResult: runState.lastCompaction ?? current.compactResult,
        compactError: runState.compactionError ?? null,
        contextUsage: runState.contextUsage ?? current.contextUsage,
        lastSequence: Math.max(current.lastSequence, runState.sequence)
      };
      for (const envelope of recentEvents) next = reduceNativePiEvent(next, envelope);
      return next;
    });
  }, [route.outputDir]);

  const reloadProviderSettings = useCallback(async () => {
    if (!route.outputDir) return;
    const epoch = ++providerReloadEpochRef.current;
    const config = await window.workshop.getAgentProviderConfig({ outputDir: route.outputDir });
    const configuredModels = await window.workshop.listAgentConfiguredModels({ outputDir: route.outputDir });
    if (epoch !== providerReloadEpochRef.current) return;
    const modelList = configuredModels.map((model) => ({
      id: model.modelId,
      name: model.modelName || model.modelId,
      provider: model.providerId,
      supportsImages: model.supportsImages,
      thinkingLevels: model.thinkingLevels ?? []
    }));
    const selection = resolveConfiguredModelSelection(config, modelList);
    const providerId = selection.provider;
    const activeStored = config.providers[providerId] as { model?: string; thinkingLevel?: ThinkingLevelOption } | undefined;
    const modelId = selection.modelId;
    setProviderConfig(config);
    setState((current) => {
      const next = {
        ...current,
        providerId,
        modelId,
        thinkingLevel: thinkingLevelForModel(
          modelList.find((model) => model.provider === providerId && model.id === modelId),
          activeStored?.thinkingLevel ?? current.thinkingLevel
        ),
        modelList,
        modelNames: Object.fromEntries(modelList.map((model) => [`${model.provider}:${model.id}`, model.name]))
      };
      return next;
    });
  }, [route.outputDir]);

  const applyProviderConfig = useCallback(async (config?: ProviderConfigDoc) => {
    if (config) setProviderConfig(config);
    await reloadProviderSettings();
  }, [reloadProviderSettings]);

  useEffect(() => {
    const epoch = ++loadEpochRef.current;
    ensureSessionRef.current = null;
    terminalConvergenceRef.current = "";
    setState(INITIAL_STATE);
    setError(null);
    if (!route.outputDir) return undefined;

    const unsubscribeEvents = electronPiSessionClient.subscribeEvents((envelope) => {
      if (!workspaceMatches(envelope.workspaceDir, route.outputDir)) return;
      if (envelope.sessionId !== stateRef.current.sessionId) return;
      if (envelope.sequence <= stateRef.current.lastSequence) return;
      const event = envelope.event;
      if (
        pendingPromptRef.current
        && (!pendingPromptRef.current.sessionId || pendingPromptRef.current.sessionId === envelope.sessionId)
        && (event.type === "agent_start" || event.type === "message_start" || event.type === "message_update")
      ) {
        pendingPromptRef.current = null;
      }
      setState((current) => reduceNativePiEvent(current, envelope));
      if (event.type === "settled") {
        queueMicrotask(() => void convergeTerminalSession(envelope.sessionId, envelope.sequence));
      }
    });
    const unsubscribeState = electronPiSessionClient.subscribeState((payload) => {
      if (!workspaceMatches(payload.workspaceDir, route.outputDir)) return;
      if (!shouldApplyPiSessionState(
        stateRef.current.sessionId,
        payload.state.sessionId,
        payload.selectionChange
      )) return;
      if (payload.state.sessionId !== stateRef.current.sessionId) {
        const sessionId = payload.state.sessionId;
        const selectionEpoch = ++loadEpochRef.current;
        const pending = pendingPromptRef.current;
        const pendingMatchesSession = Boolean(
          pending
          && (!pending.sessionId || pending.sessionId === sessionId)
        );
        const carryOptimisticMessages = Boolean(
          pendingMatchesSession
          && stateRef.current.agentRunning
        );
        if (pending && !pending.sessionId) pending.sessionId = sessionId;
        const nativeOwnsPrompt = pendingMatchesSession
          && nativeRunStateClaimsPrompt(payload.state);
        if (nativeOwnsPrompt) pendingPromptRef.current = null;
        const preserveOptimisticRun = carryOptimisticMessages && !nativeOwnsPrompt;
        const carriedMessages = carryOptimisticMessages ? stateRef.current.messages : [];
        setState((current) => mergePiRunState({
          ...current,
          sessionId,
          messages: carriedMessages,
          lastSequence: payload.state.sequence
        }, payload.state, preserveOptimisticRun));
        void electronPiSessionClient.loadBootstrap(route.outputDir)
          .then((bootstrap) => {
            if (loadEpochRef.current !== selectionEpoch) return;
            setState((current) => ({ ...current, sessions: bootstrap.sessions }));
            if (sessionId && !carryOptimisticMessages) return loadSelectedSession(sessionId, selectionEpoch);
          })
          .catch((syncError) => setError(syncError instanceof Error ? syncError.message : String(syncError)));
        return;
      }
      const wasRunning = stateRef.current.agentRunning;
      applyRunState(payload.state);
      if (payload.selectionChange && payload.state.sessionId) {
        const resyncEpoch = ++loadEpochRef.current;
        void loadSelectedSession(payload.state.sessionId, resyncEpoch).catch((syncError) => {
          setError(syncError instanceof Error ? syncError.message : String(syncError));
        });
      }
      if (payload.state.error) setError(payload.state.error);
      if (wasRunning && !payload.state.running) {
        queueMicrotask(() => void convergeTerminalSession(
          payload.state.sessionId,
          payload.state.sequence,
          payload.state.error
        ));
      }
    });
    const unsubscribeProvider = window.workshop.onAgentProviderUpdate((payload) => {
      if (payload.scope !== "global" && !workspaceMatches(payload.workspaceDir, route.outputDir)) return;
      setProviderConfig(payload.config);
      void reloadProviderSettings().catch((providerError) => {
        setError(providerError instanceof Error ? providerError.message : String(providerError));
      });
    });

    setLoading(true);
    void electronPiSessionClient.loadBootstrap(route.outputDir)
      .then((bootstrap) => {
        if (loadEpochRef.current !== epoch) return;
        const sessionId = bootstrap.activeSessionId;
        setState((current) => ({ ...current, sessions: bootstrap.sessions, sessionId }));
        if (sessionId) return loadSelectedSession(sessionId, epoch);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
      .finally(() => {
        if (loadEpochRef.current === epoch) setLoading(false);
      });
    void reloadProviderSettings().catch((providerError) => {
      setError(providerError instanceof Error ? providerError.message : String(providerError));
    });

    return () => {
      loadEpochRef.current += 1;
      unsubscribeEvents();
      unsubscribeState();
      unsubscribeProvider();
    };
  }, [applyRunState, convergeTerminalSession, loadSelectedSession, reloadProviderSettings, route.outputDir]);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (stateRef.current.sessionId) return stateRef.current.sessionId;
    if (!route.outputDir) throw new Error("outputDir is required.");
    if (ensureSessionRef.current) return ensureSessionRef.current;
    const pending = electronPiSessionClient.createSession(route.outputDir).then((session) => {
      setState((current) => ({
        ...current,
        sessionId: session.id,
        sessions: [session, ...current.sessions.filter((item) => item.id !== session.id)]
      }));
      return session.id;
    });
    ensureSessionRef.current = pending;
    try {
      return await pending;
    } finally {
      ensureSessionRef.current = null;
    }
  }, [route.outputDir]);

  const handleSend = useCallback(async (
    prompt: string,
    workflowMetadata?: PiWorkflowPromptMetadata,
    attachedImages: AttachedImage[] = []
  ) => {
    const text = prompt.trim();
    if ((!text && attachedImages.length === 0) || !route.outputDir) return;
    if (stateRef.current.isCompacting) throw new Error("Wait for native Pi compaction to finish.");
    const images: PiSessionImageAttachment[] = attachedImages.map((image) => ({
      type: "image",
      data: image.data,
      mimeType: image.mimeType
    }));
    const optimistic: AgentMessage = {
      role: "user",
      content: images.length === 0 ? text : [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mimeType, data: image.data }
        }))
      ],
      timestamp: Date.now()
    };
    const pending = { id: ++promptSequenceRef.current, sessionId: stateRef.current.sessionId, cancelled: false };
    pendingPromptRef.current = pending;
    setError(null);
    setState((current) => ({
      ...current,
      messages: [...current.messages, optimistic],
      streamingMessage: null,
      agentRunning: true,
      phase: { kind: "waiting_model" },
      phaseText: "thinking"
    }));
    try {
      const sessionId = await ensureSession();
      pending.sessionId = sessionId;
      if (pending.cancelled) {
        if (pendingPromptRef.current?.id === pending.id) pendingPromptRef.current = null;
        setState((current) => ({ ...current, agentRunning: false, phase: null, phaseText: "ready" }));
        return;
      }
      let current = stateRef.current;
      for (let attempt = 0; attempt < 2 && (!current.providerId || !current.modelId); attempt += 1) {
        await reloadProviderSettings();
        current = stateRef.current;
      }
      if (!current.providerId || !current.modelId) throw new Error("Configure and select a provider model first.");
      await electronPiSessionClient.sendPrompt({
        outputDir: route.outputDir,
        sessionId,
        prompt: text,
        images: images.length > 0 ? images : undefined,
        providerId: current.providerId,
        modelId: current.modelId,
        thinkingLevel: current.thinkingLevel,
        workflowIntent: workflowMetadata?.workflowIntent,
        languagePair: workflowMetadata?.languagePair ?? route.languagePair,
        style: workflowMetadata?.style,
        workDescription: workflowMetadata?.workDescription,
        glossaryPath: workflowMetadata?.glossaryPath,
        glossaryCandidates: workflowMetadata?.glossaryCandidates,
        characterBible: workflowMetadata?.characterBible,
        reuseExistingTranslation: workflowMetadata?.reuseExistingTranslation,
        auditWhitelistLines: workflowMetadata?.auditWhitelistLines,
        customPreserveRules: workflowMetadata?.customPreserveRules,
        subagentEnabled: workflowMetadata?.subagentEnabled,
        subagentCount: workflowMetadata?.subagentCount,
        reviewSubagentCount: workflowMetadata?.reviewSubagentCount,
        subagentProviderId: workflowMetadata?.subagentProviderId,
        subagentModelId: workflowMetadata?.subagentModelId,
        translationSplitSize: workflowMetadata?.translationSplitSize,
        folderTranslationOrder: workflowMetadata?.folderTranslationOrder,
        folderSourceDocuments: workflowMetadata?.folderSourceDocuments,
        proofreadMode: workflowMetadata?.proofreadMode,
        proofreadSplitSize: workflowMetadata?.proofreadSplitSize,
        proofreadMontecarloSize: workflowMetadata?.proofreadMontecarloSize,
        proofreadMontecarloRoundMin: workflowMetadata?.proofreadMontecarloRoundMin,
        proofreadMontecarloRoundMax: workflowMetadata?.proofreadMontecarloRoundMax,
        sourcePath: route.sourcePath,
        sourceSelection: route.sourcePath ? { kind: route.sourceKind ?? "file", path: route.sourcePath } : undefined,
        translationPath: route.translationPath,
        lineReviewPath: route.lineReviewPath
      });
      if (pending.cancelled) await electronPiSessionClient.abort(route.outputDir, sessionId);
    } catch (sendError) {
      if (pendingPromptRef.current?.id === pending.id) pendingPromptRef.current = null;
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      setState((current) => ({ ...current, agentRunning: false, phase: null, phaseText: "error" }));
    }
  }, [ensureSession, reloadProviderSettings, route.languagePair, route.lineReviewPath, route.outputDir, route.sourceKind, route.sourcePath, route.translationPath]);

  const handleCompact = useCallback(async (customInstructions?: string) => {
    const current = stateRef.current;
    if (!route.outputDir || !current.sessionId) throw new Error("No active Pi session to compact.");
    if (current.agentRunning || current.isCompacting) return;
    if (!current.providerId || !current.modelId) throw new Error("Configure and select a provider model first.");
    setError(null);
    setState((state) => ({
      ...state,
      isCompacting: true,
      compactError: null,
      compactResult: null,
      phase: { kind: "running_command" },
      phaseText: "compacting"
    }));
    try {
      const result = await electronPiSessionClient.compact({
        outputDir: route.outputDir,
        sessionId: current.sessionId,
        providerId: current.providerId,
        modelId: current.modelId,
        thinkingLevel: current.thinkingLevel,
        customInstructions: customInstructions?.trim() || undefined
      });
      const [loadedMessages, runState] = await Promise.all([
        electronPiSessionClient.loadMessages(route.outputDir, current.sessionId),
        electronPiSessionClient.loadRunState(route.outputDir, current.sessionId)
      ]);
      if (stateRef.current.sessionId !== current.sessionId) return;
      setState((state) => mergePiRunState({
        ...state,
        messages: loadedMessages.map(normalizeToolCalls),
        compactResult: result,
        compactError: null
      }, runState));
    } catch (compactError) {
      const message = compactError instanceof Error ? compactError.message : String(compactError);
      setError(message);
      setState((state) => ({
        ...state,
        isCompacting: false,
        compactResult: null,
        compactError: message,
        phase: null,
        phaseText: "ready"
      }));
      throw compactError;
    }
  }, [route.outputDir]);

  const handleAbort = useCallback(async () => {
    if (!route.outputDir) return;
    const pending = pendingPromptRef.current;
    if (pending) pending.cancelled = true;
    const sessionId = pending?.sessionId || stateRef.current.sessionId;
    if (!sessionId) {
      if (pendingPromptRef.current === pending) pendingPromptRef.current = null;
      setState((current) => ({ ...current, agentRunning: false, streamingMessage: null, phase: null, phaseText: "ready" }));
      return;
    }
    setState((current) => ({
      ...current,
      agentRunning: true,
      phaseText: "Stopping..."
    }));
    try {
      await electronPiSessionClient.abort(route.outputDir, sessionId);
      const [runState, messages] = await Promise.all([
        electronPiSessionClient.loadRunState(route.outputDir, sessionId),
        electronPiSessionClient.loadMessages(route.outputDir, sessionId)
      ]);
      if (stateRef.current.sessionId !== sessionId) return;
      setState((current) => mergePiRunState({
        ...current,
        messages: messages.map(normalizeToolCalls),
        streamingMessage: null,
        agentRunning: false,
        phase: null,
        phaseText: "ready"
      }, runState));
    } catch (abortError) {
      setError(abortError instanceof Error ? abortError.message : String(abortError));
    } finally {
      if (pendingPromptRef.current === pending) pendingPromptRef.current = null;
    }
  }, [route.outputDir]);

  const sendInput = useCallback(async (
    text: string,
    kind: "steer" | "followUp",
    attachedImages: AttachedImage[] = []
  ) => {
    const sessionId = stateRef.current.sessionId;
    if (!route.outputDir || !sessionId) throw new Error("No running Pi session.");
    const images: PiSessionImageAttachment[] = attachedImages.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
    const queued: AgentMessage = {
      role: "user",
      content: images.length === 0 ? text : [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType, data: image.data } }))
      ],
      timestamp: Date.now()
    };
    const queueKey = kind === "steer" ? "queuedSteer" : "queuedFollowUp";
    setState((current) => ({ ...current, [queueKey]: [...current[queueKey], queued] }));
    try {
      await electronPiSessionClient.sendInput(route.outputDir, sessionId, kind, text, images.length > 0 ? images : undefined);
    } catch (inputError) {
      const removeOptimistic = (items: AgentMessage[]) => items.filter((item) => item.timestamp !== queued.timestamp);
      setState((current) => ({ ...current, [queueKey]: removeOptimistic(current[queueKey]) }));
      throw inputError;
    }
  }, [route.outputDir]);

  const handleNewConversation = useCallback(async () => {
    if (!route.outputDir || stateRef.current.agentRunning || stateRef.current.isCompacting) return;
    const epoch = ++loadEpochRef.current;
    setError(null);
    setState((current) => ({ ...current, sessionId: "", messages: [], streamingMessage: null, queuedSteer: [], queuedFollowUp: [], queuedNextTurn: [], lastSequence: 0 }));
    try {
      const session = await electronPiSessionClient.createSession(route.outputDir);
      if (loadEpochRef.current !== epoch) return;
      setState((current) => ({
        ...current,
        sessionId: session.id,
        sessions: [session, ...current.sessions.filter((item) => item.id !== session.id)]
      }));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  }, [route.outputDir]);

  const handleSelectConversation = useCallback(async (sessionId: string) => {
    if (!route.outputDir || stateRef.current.agentRunning || stateRef.current.isCompacting || sessionId === stateRef.current.sessionId) return;
    const epoch = ++loadEpochRef.current;
    setError(null);
    setState((current) => ({ ...current, sessionId, messages: [], streamingMessage: null, queuedSteer: [], queuedFollowUp: [], queuedNextTurn: [], lastSequence: 0 }));
    try {
      await electronPiSessionClient.selectSession(route.outputDir, sessionId);
      await loadSelectedSession(sessionId, epoch);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  }, [loadSelectedSession, route.outputDir]);

  const handleDeleteConversation = useCallback(async (sessionId: string) => {
    if (!route.outputDir || stateRef.current.agentRunning || stateRef.current.isCompacting) return;
    const deletingActiveSession = sessionId === stateRef.current.sessionId;
    await electronPiSessionClient.deleteSession(route.outputDir, sessionId);
    const bootstrap = await electronPiSessionClient.loadBootstrap(route.outputDir);
    if (!deletingActiveSession) {
      setState((current) => ({ ...current, sessions: bootstrap.sessions }));
      return;
    }
    const epoch = ++loadEpochRef.current;
    setError(null);
    setState((current) => ({
      ...current,
      sessions: bootstrap.sessions,
      sessionId: bootstrap.activeSessionId,
      messages: [],
      streamingMessage: null,
      queuedSteer: [],
      queuedFollowUp: [],
      queuedNextTurn: [],
      lastSequence: 0
    }));
    if (bootstrap.activeSessionId) await loadSelectedSession(bootstrap.activeSessionId, epoch);
  }, [loadSelectedSession, route.outputDir]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (!route.outputDir || !providerConfig) return;
    if (stateRef.current.agentRunning || stateRef.current.isCompacting) return;
    const stored = providerConfig.providers[provider] as Record<string, unknown> | undefined;
    if (!stored) throw new Error(`Provider ${provider} is not configured.`);
    const nextThinking = thinkingLevelForModel(
      stateRef.current.modelList.find((model) => model.provider === provider && model.id === modelId),
      stateRef.current.thinkingLevel
    );
    setState((current) => ({ ...current, providerId: provider, modelId, thinkingLevel: nextThinking }));
    const next = await window.workshop.saveAgentProviderConfig({
      outputDir: route.outputDir,
      activeProviderId: provider,
      provider: { ...stored, id: provider, model: modelId, thinkingLevel: nextThinking }
    });
    setProviderConfig(next);
  }, [providerConfig, route.outputDir]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    if (stateRef.current.agentRunning || stateRef.current.isCompacting) return;
    setState((current) => ({ ...current, thinkingLevel: level }));
    if (!route.outputDir || !providerConfig || !stateRef.current.providerId) return;
    const provider = stateRef.current.providerId;
    const stored = providerConfig.providers[provider] as Record<string, unknown> | undefined;
    if (!stored) return;
    const next = await window.workshop.saveAgentProviderConfig({
      outputDir: route.outputDir,
      activeProviderId: provider,
      provider: { ...stored, id: provider, thinkingLevel: level }
    });
    setProviderConfig(next);
  }, [providerConfig, route.outputDir]);

  const displayModel = useMemo<SelectedModel | null>(() => (
    state.providerId && state.modelId ? { provider: state.providerId, modelId: state.modelId } : null
  ), [state.modelId, state.providerId]);
  const streamState = useMemo(() => ({
    isStreaming: state.agentRunning,
    streamingMessage: state.streamingMessage
  }), [state.agentRunning, state.streamingMessage]);
  const sessionStats = useMemo<SessionStatsInfo | null>(() => {
    const { tokens, cost } = assistantUsage(state.messages);
    if (state.messages.length === 0) return null;
    return {
      sessionId: state.sessionId,
      userMessages: state.messages.filter((message) => message.role === "user").length,
      assistantMessages: state.messages.filter((message) => message.role === "assistant").length,
      toolCalls: state.messages.reduce((count, message) => (
        message.role === "assistant"
          ? count + message.content.filter((block) => block.type === "toolCall").length
          : count
      ), 0),
      toolResults: state.messages.filter((message) => message.role === "toolResult").length,
      totalMessages: state.messages.length,
      tokens,
      cost
    };
  }, [state.messages, state.sessionId]);

  return {
    loading,
    error,
    messages: state.messages,
    streamState,
    agentRunning: state.agentRunning,
    isCompacting: state.isCompacting,
    compactResult: state.compactResult,
    compactError: state.compactError,
    contextUsage: state.contextUsage,
    modelNames: state.modelNames,
    modelList: state.modelList,
    thinkingLevel: state.thinkingLevel,
    displayModel,
    sessionStats,
    agentPhase: state.phase,
    agentPhaseText: state.phaseText,
    retryInfo: state.retryInfo,
    conversationId: state.sessionId,
    isNew: !state.sessionId,
    conversations: state.sessions,
    queuedSteer: state.queuedSteer,
    queuedFollowUp: state.queuedFollowUp,
    queuedNextTurn: state.queuedNextTurn,
    messagesEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    handleSend,
    handleAbort,
    handleCompact,
    handleSelectConversation,
    handleNewConversation,
    handleDeleteConversation,
    handleModelChange,
    handleSteer: (message: string, images?: AttachedImage[]) => sendInput(message, "steer", images),
    handleFollowUp: (message: string, images?: AttachedImage[]) => sendInput(message, "followUp", images),
    handleThinkingLevelChange,
    applyProviderConfig,
    reloadProviderSettings
  };
}
