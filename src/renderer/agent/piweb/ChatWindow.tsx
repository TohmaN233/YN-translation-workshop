"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownRight, ExternalLink, ListPlus, LoaderCircle, PanelLeftClose, PanelLeftOpen, Square, Trash2, X } from "lucide-react";

import {
  ChatInput,
  type BuiltinSlashCommandResult,
  type ChatInputHandle,
  type SlashCommandInfo
} from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import type { PiSessionSummary, PiWorkflowPromptMetadata } from "../../../shared/agent/piSessionContract.ts";
import { electronPiSessionClient, type YnAgentRoute } from "./electronPiSessionClient";
import { agentUiStrings, normalizeAgentUiLocale, type AgentUiLocale } from "./i18n";
import { MessageView } from "./MessageView";
import { normalizeToolCalls } from "./normalize";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import type { ContextUsage, SessionStatsInfo } from "./sessionTypes";
import type { AgentMessage, ToolResultMessage } from "./types";
import { useAgentSession, type AgentPhase } from "./useAgentSession";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 350;
const USER_SCROLL_INTENT_MS = 1200;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface Props {
  route: YnAgentRoute;
  title: string;
  onAgentEnd?: () => void;
  onEmbeddedReady?: () => void;
}

function phaseLabel(phase: AgentPhase, fallback: string, locale: AgentUiLocale): string {
  const ui = agentUiStrings[locale];
  if (phase?.kind === "running_tools") return ui.runningTools;
  if (phase?.kind === "waiting_model") return ui.thinkingActive;
  if (phase?.kind === "running_command") return ui.runningCommand;
  if (locale === "zh-CN" && /^Stopping/i.test(fallback)) return ui.stopping;
  return fallback || ui.thinking;
}

function assistantText(message: AgentMessage | null | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function latestAssistantText(messages: AgentMessage[], streamingMessage: AgentMessage | null): string {
  const streamingText = assistantText(streamingMessage);
  if (streamingText) return streamingText;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantText(messages[index]);
    if (text) return text;
  }
  return "";
}

function queuedMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function queuedMessageImageCount(message: AgentMessage): number {
  if (message.role !== "user" || typeof message.content === "string") return 0;
  return message.content.filter((block) => block.type === "image").length;
}

export function buildQueuedInputs(
  queuedSteer: AgentMessage[],
  queuedFollowUp: AgentMessage[],
  queuedNextTurn: AgentMessage[]
) {
  return [
    ...queuedSteer.map((message) => ({ kind: "steer" as const, message, text: queuedMessageText(message), imageCount: queuedMessageImageCount(message) })),
    ...queuedFollowUp.map((message) => ({ kind: "followUp" as const, message, text: queuedMessageText(message), imageCount: queuedMessageImageCount(message) })),
    ...queuedNextTurn.map((message) => ({ kind: "nextTurn" as const, message, text: queuedMessageText(message), imageCount: queuedMessageImageCount(message) }))
  ].filter((item) => item.text.trim() || item.imageCount > 0);
}

interface SubagentProgress {
  total: number;
  running: number;
  closed: number;
}

export async function closeAgentSurface(options: {
  agentRunning: boolean;
  abort: () => Promise<unknown>;
  close: () => void;
}): Promise<void> {
  if (options.agentRunning) await options.abort();
  options.close();
}

export function ChatWindow({ route, title, onAgentEnd, onEmbeddedReady }: Props) {
  const locale = normalizeAgentUiLocale(route.locale);
  const ui = agentUiStrings[locale];
  const {
    loading,
    error,
    messages,
    streamState,
    agentRunning,
    isCompacting,
    compactResult,
    compactError,
    contextUsage,
    modelNames,
    modelList,
    thinkingLevel,
    displayModel,
    sessionStats,
    agentPhase,
    agentPhaseText,
    retryInfo,
    conversationId,
    isNew,
    conversations,
    queuedSteer,
    queuedFollowUp,
    queuedNextTurn,
    messagesEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    handleSend,
    handleAbort,
    handleCompact,
    handleSteer,
    handleFollowUp,
    handleThinkingLevelChange,
    handleSelectConversation,
    handleNewConversation,
    handleDeleteConversation,
    handleModelChange,
    applyProviderConfig,
    reloadProviderSettings
  } = useAgentSession({ route, onAgentEnd });
  const [sidebarOpen, setSidebarOpen] = useState(() => (
    typeof window === "undefined" || !window.matchMedia("(max-width: 840px)").matches
  ));
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const initialScrollDoneRef = useRef(false);
  const initialPromptInsertedRef = useRef(false);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const previousAgentRunningRef = useRef(false);

  const currentModelName = useMemo(() => {
    if (!displayModel) return ui.notSelected;
    return modelList.find((entry) => (
      entry.provider === displayModel.provider && entry.id === displayModel.modelId
    ))?.name ?? displayModel.modelId;
  }, [displayModel, modelList, ui.notSelected]);
  const currentThinkingLevels = useMemo(() => (
    displayModel
      ? modelList.find((entry) => entry.provider === displayModel.provider && entry.id === displayModel.modelId)?.thinkingLevels ?? []
      : []
  ), [displayModel, modelList]);
  const currentModelSupportsImages = useMemo(() => Boolean(displayModel && modelList.find((entry) => (
    entry.provider === displayModel.provider && entry.id === displayModel.modelId
  ))?.supportsImages), [displayModel, modelList]);

  const subagentProgress = useMemo<SubagentProgress>(() => {
    let total = 0;
    let running = 0;
    let closed = 0;
    for (const message of messages) {
      if (message.role !== "custom" || !message.details || typeof message.details !== "object") continue;
      const details = message.details as Record<string, unknown>;
      if (typeof details.subagentId !== "string" || !details.subagentId) continue;
      total += 1;
      if (details.status === "running") running += 1;
      else closed += 1;
    }
    return { total, running, closed };
  }, [messages]);

  const queuedInputs = useMemo(
    () => buildQueuedInputs(queuedSteer, queuedFollowUp, queuedNextTurn),
    [queuedFollowUp, queuedNextTurn, queuedSteer]
  );
  const visiblePhaseText = subagentProgress.running > 0
    ? ui.subagentsRunning.replace("{count}", String(subagentProgress.running))
    : isCompacting ? ui.compactingContext : phaseLabel(agentPhase, agentPhaseText, locale);
  const agentBusy = agentRunning || isCompacting;
  const subagentsRunning = subagentProgress.running > 0;
  const sessionBusy = agentBusy || subagentsRunning;

  const slashCommands = useMemo<SlashCommandInfo[]>(() => {
    const commands: SlashCommandInfo[] = [
      { name: "btw", description: ui.slash.progress },
      { name: "session", description: ui.slash.session },
      { name: "copy", description: ui.slash.copy }
    ];
    if (agentRunning) {
      commands.push(
        { name: "stop", description: ui.slash.stopRun },
        { name: "steer", description: ui.slash.steer, argumentHint: "<message>" },
        { name: "followup", description: ui.slash.followUp, argumentHint: "<message>" }
      );
    } else if (!isCompacting) {
      commands.push(
        ...(subagentsRunning ? [{ name: "stop", description: ui.slash.stopSubagents }] : []),
        ...(conversationId && messages.length > 0
          ? [{ name: "compact", description: ui.slash.compact }]
          : []),
        { name: "model", description: ui.slash.model },
        { name: "settings", description: ui.slash.settings },
        { name: "new", description: ui.slash.newSession }
      );
    }
    return commands;
  }, [agentRunning, conversationId, isCompacting, messages.length, subagentsRunning, ui]);

  const handleBuiltinCommand = useCallback(async (input: string): Promise<BuiltinSlashCommandResult> => {
    const match = input.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };
    const command = match[1].toLowerCase();
    const argument = (match[2] ?? "").trim();
    try {
      if (command === "btw" || command === "status" || command === "session") {
        setSessionPanelOpen(true);
        return { handled: true };
      }
      if (command === "copy") {
        const text = latestAssistantText(messages, streamState.streamingMessage);
        if (!text) return { handled: true, error: ui.commandResult.noReply };
        const copied = await window.workshop.copyText(text);
        return copied
          ? { handled: true, message: ui.commandResult.copiedReply }
          : { handled: true, error: ui.commandResult.copyFailed };
      }
      if (command === "compact") {
        if (agentRunning || subagentsRunning) return { handled: true, error: ui.commandResult.stopBeforeCompact };
        if (isCompacting) return { handled: true, error: ui.commandResult.compactionRunning };
        await handleCompact(argument || undefined);
        return { handled: true };
      }
      if (command === "model") {
        if (agentRunning) return { handled: true, error: ui.commandResult.stopBeforeModel };
        chatInputRef.current?.openModelPicker();
        return { handled: true };
      }
      if (command === "settings" || command === "login") {
        if (agentRunning) return { handled: true, error: ui.commandResult.stopBeforeSettings };
        setSessionPanelOpen(false);
        setProviderSettingsOpen(true);
        return { handled: true };
      }
      if (command === "new") {
        if (agentRunning || subagentsRunning) return { handled: true, error: ui.commandResult.stopBeforeNew };
        await handleNewConversation();
        return { handled: true, message: ui.commandResult.sessionCreated };
      }
      if (command === "stop" || command === "abort" || command === "cancel") {
        if (!agentRunning && !subagentsRunning) return { handled: true, error: ui.commandResult.noActiveWork };
        await handleAbort();
        return { handled: true, message: ui.commandResult.stopping };
      }
      if (command === "steer" || command === "interrupt" || command === "i") {
        if (!agentRunning) return { handled: true, error: ui.commandResult.steerUnavailable };
        if (!argument) return { handled: true, error: ui.commandResult.steerNeedsMessage };
        await handleSteer(argument);
        return { handled: true, message: ui.commandResult.steerSent };
      }
      if (command === "followup" || command === "follow-up" || command === "queue" || command === "q") {
        if (!agentRunning) return { handled: true, error: ui.commandResult.followUpUnavailable };
        if (!argument) return { handled: true, error: ui.commandResult.followUpNeedsMessage };
        await handleFollowUp(argument);
        return { handled: true, message: ui.commandResult.followUpQueued };
      }
      return { handled: false };
    } catch (commandError) {
      return {
        handled: true,
        error: commandError instanceof Error ? commandError.message : String(commandError)
      };
    }
  }, [agentRunning, handleAbort, handleCompact, handleFollowUp, handleNewConversation, handleSteer, isCompacting, messages, streamState.streamingMessage, subagentsRunning, ui.commandResult]);

  const handleClose = async () => {
    if (isCompacting) return;
    await closeAgentSurface({
      agentRunning: agentRunning || subagentsRunning,
      abort: handleAbort,
      close: () => {
        if (window.YnPiWebAgentEmbedded?.close) {
          window.YnPiWebAgentEmbedded.close();
          return;
        }
        window.close();
      }
    });
  };
  const embeddedInReviewHtml = Boolean(window.YnPiWebAgentEmbedded);

  useEffect(() => {
    const bridge = window.YnPiWebAgentEmbedded;
    if (!bridge) return undefined;
    const input = () => {
      if (!chatInputRef.current) throw new Error("Pi-web ChatInput is not mounted.");
      return chatInputRef.current;
    };
    const insertText = (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => {
      input().insertText(text, workflowMetadata);
    };
    const insertIfEmpty = (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => {
      input().insertIfEmpty(text, workflowMetadata);
    };
    const replaceText = (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => {
      input().replaceText(text, workflowMetadata);
    };
    const openSettings = () => {
      setProviderSettingsOpen(true);
    };
    const pendingSettingsRequest = (window as unknown as { __ynAgentOpenSettingsRequestedAt?: number }).__ynAgentOpenSettingsRequestedAt;
    if (pendingSettingsRequest) setProviderSettingsOpen(true);
    bridge.insertText = insertText;
    bridge.insertIfEmpty = insertIfEmpty;
    bridge.replaceText = replaceText;
    bridge.openSettings = openSettings;
    onEmbeddedReady?.();
    window.addEventListener("yn-agent-open-settings", openSettings);
    return () => {
      if (bridge.insertText === insertText) delete bridge.insertText;
      if (bridge.insertIfEmpty === insertIfEmpty) delete bridge.insertIfEmpty;
      if (bridge.replaceText === replaceText) delete bridge.replaceText;
      if (bridge.openSettings === openSettings) delete bridge.openSettings;
      window.removeEventListener("yn-agent-open-settings", openSettings);
    };
  }, [onEmbeddedReady]);

  useEffect(() => {
    if (initialPromptInsertedRef.current || !route.initialPrompt) return;
    if (!chatInputRef.current) return;
    chatInputRef.current.insertIfEmpty(route.initialPrompt, route.initialWorkflowMetadata);
    initialPromptInsertedRef.current = true;
  }, [route.initialPrompt, route.initialWorkflowMetadata]);

  const toolResults = useMemo(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }
    return results;
  }, [messages]);
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant"),
    [messages]
  );
  const messageRenderMetadata = useMemo(() => {
    let visibleIndex = -1;
    let lastUserIndex = -1;
    const visibleIndexes = messages.map((message, index) => {
      if (message.role === "user") lastUserIndex = index;
      if (message.role !== "user" && message.role !== "assistant") return -1;
      visibleIndex += 1;
      return visibleIndex;
    });
    return { visibleIndexes, lastUserIndex };
  }, [messages]);
  const loadSubagentMessages = useCallback((childSessionId: string) => (
    electronPiSessionClient.loadSubagentMessages(route.outputDir, conversationId, childSessionId)
      .then((childMessages) => childMessages.map(normalizeToolCalls))
  ), [route.outputDir, conversationId]);
  const messageRefs = useMessageRefs(visibleMessages.length);

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const scrollUserMsgToTop = () => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return false;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: Math.max(0, elAbsTop - 16), behavior: "smooth" });
    return true;
  };

  useEffect(() => {
    if (sessionBusy && !previousAgentRunningRef.current) {
      pendingScrollToUserRef.current = true;
      completionScrollAllowedRef.current = true;
    }
    previousAgentRunningRef.current = sessionBusy;
  }, [sessionBusy]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const markUserScrollIntent = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (!SCROLL_KEYS.has(event.key)) return;
        if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      }
      userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
    };
    const onScroll = () => {
      if (!sessionBusy) return;
      if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
      if (Date.now() > userScrollIntentUntilRef.current) return;
      completionScrollAllowedRef.current = false;
    };
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", onScroll);
    };
  }, [sessionBusy, scrollContainerRef]);

  useEffect(() => {
    if (messages.length === 0 && !streamState.streamingMessage) return;
    if (pendingScrollToUserRef.current) {
      if (scrollUserMsgToTop()) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
      }
      return;
    }
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
      return;
    }
    if (!sessionBusy && completionScrollAllowedRef.current) {
      scrollToBottom("smooth");
    }
  }, [messages.length, sessionBusy, streamState.streamingMessage]);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      locale={locale}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      isStreaming={agentRunning && !isCompacting}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      retryInfo={retryInfo}
      onCompact={conversationId && messages.length > 0 ? handleCompact : undefined}
      model={displayModel}
      modelNames={modelNames}
      modelList={modelList}
      supportsImages={currentModelSupportsImages}
      onModelChange={handleModelChange}
      thinkingLevel={thinkingLevel}
      thinkingLevels={currentThinkingLevels}
      onThinkingLevelChange={handleThinkingLevelChange}
      slashCommands={slashCommands}
      onBuiltinCommand={handleBuiltinCommand}
    />
  );

  const latestAssistantError = [...messages].reverse().find((message) => (
    message.role === "assistant" && message.stopReason === "error" && message.errorMessage?.trim()
  ));
  const standaloneError = error && (
    latestAssistantError?.role !== "assistant" || latestAssistantError.errorMessage?.trim() !== error.trim()
  ) ? error : null;

  const transcript = (
    <section className="ynAgentTranscript" ref={scrollContainerRef} aria-live="polite">
      <div className="ynAgentTranscriptInner">
        {loading && messages.length === 0 && !streamState.streamingMessage ? (
          <div className="ynAgentEmpty">{ui.loadingSession}</div>
        ) : isNew && messages.length === 0 && !agentBusy ? (
          <div className="ynAgentEmpty">
            <div className="ynAgentEmptyBrand">YN Agent OS</div>
            <div>{ui.emptyHint}</div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              if (message.role === "custom" && message.display === false) return null;
              const visible = message.role === "user" || message.role === "assistant";
              const visibleIndex = messageRenderMetadata.visibleIndexes[index];
              const childSessionId = message.role === "custom"
                && message.details
                && typeof message.details === "object"
                && typeof (message.details as Record<string, unknown>).subagentId === "string"
                ? (message.details as Record<string, unknown>).subagentId
                : "";
              const messageKey = `${conversationId}:${message.role}:${message.timestamp ?? "untimed"}:${childSessionId}:${index}`;
              return (
                <div
                  className="ynAgentMessage"
                  key={messageKey}
                  ref={(node) => {
                    if (visible && visibleIndex >= 0) messageRefs.current[visibleIndex] = node;
                    if (index === messageRenderMetadata.lastUserIndex) lastUserMsgRef.current = node;
                  }}
                >
                  <MessageView
                    message={message}
                    isStreaming={streamState.streamingMessage === message}
                    toolResults={toolResults}
                    modelNames={modelNames}
                    showTimestamp
                    prevTimestamp={index > 0 ? messages[index - 1].timestamp : undefined}
                    loadSubagentMessages={loadSubagentMessages}
                    locale={locale}
                  />
                </div>
              );
            })}
            {streamState.streamingMessage && (
              <div className="ynAgentMessage">
                <MessageView
                  message={streamState.streamingMessage}
                  isStreaming
                  toolResults={toolResults}
                  modelNames={modelNames}
                  showTimestamp
                  prevTimestamp={messages.at(-1)?.timestamp}
                  locale={locale}
                />
              </div>
            )}
          </>
        )}
        {standaloneError && (
          <div className="ynAgentError" role="alert">{standaloneError}</div>
        )}
        {agentRunning && <div className="ynAgentScrollPad" />}
        <div ref={messagesEndRef} />
      </div>
    </section>
  );

  return (
    <main className="ynAgent">
      <aside className={`ynAgentSidebar${sidebarOpen ? "" : " ynAgentSidebarClosed"}`}>
        <SessionSidebar
          title={title}
          conversations={conversations}
          activeConversationId={conversationId}
          route={route}
          locale={locale}
          disabled={sessionBusy}
          onSelect={handleSelectConversation}
          onNew={handleNewConversation}
          onDelete={handleDeleteConversation}
        />
      </aside>

      <section className="ynAgentMain">
        <header className={`ynAgentTopbar${sessionBusy ? " ynAgentTopbarRunning" : ""}`}>
          <button className="ynAgentIconButton" type="button" aria-label={sidebarOpen ? ui.hideSidebar : ui.showSidebar} title={sidebarOpen ? ui.hideSidebar : ui.showSidebar} onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <div className="ynAgentTopbarTitle">
            <span>{route.outputDir ? visiblePhaseText : "missing outputDir"}</span>
          </div>
          {!embeddedInReviewHtml && (
            <button className="ynAgentTopbarButton ynAgentTopbarButtonIcon" type="button" aria-label={ui.openNewWindow} title={ui.openNewWindow} onClick={() => void window.workshop.openAgentChatWindow({ ...route, locale })}>
              <ExternalLink size={15} />
            </button>
          )}
          <button
            className="ynAgentTopbarButton ynAgentTopbarButtonIcon"
            type="button"
            aria-label={ui.closeAgent}
            title={isCompacting ? ui.compactingContext : ui.closeAgent}
            disabled={isCompacting}
            onClick={handleClose}
          >
            <X size={16} />
          </button>
          <SessionStatsButton
            locale={locale}
            contextUsage={contextUsage}
            sessionStats={sessionStats}
            open={sessionPanelOpen}
            onToggle={() => setSessionPanelOpen((value) => !value)}
          />
        </header>
        {sessionPanelOpen && (
          <SessionStatsPanel
            locale={locale}
            contextUsage={contextUsage}
            sessionStats={sessionStats}
            agentRunning={sessionBusy}
            phaseText={visiblePhaseText}
            modelName={currentModelName}
            subagentProgress={subagentProgress}
          />
        )}
        {providerSettingsOpen && route.outputDir ? (
          <ProviderSettingsPanel
            outputDir={route.outputDir}
            locale={locale}
            onClose={() => setProviderSettingsOpen(false)}
            onSaved={(providerConfig) => void (providerConfig ? applyProviderConfig(providerConfig) : reloadProviderSettings())}
          />
        ) : (
          <>
            <div className="ynAgentChatPane">
              {transcript}
              <ChatMinimap
                messages={messages}
                streamingMessage={streamState.streamingMessage}
                scrollContainer={scrollContainerRef}
                messageRefs={messageRefs}
              />
            </div>

            <footer className="ynAgentComposer">
              {(subagentProgress.running > 0 || queuedInputs.length > 0) && (
                <div className="ynAgentRunActivity" aria-live="polite">
                  {subagentProgress.running > 0 && (
                    <div className="ynAgentRunActivityStatus" data-agent-subagent-waiting="true">
                      <LoaderCircle size={14} aria-hidden="true" />
                      <span>{ui.subagentsRunning.replace("{count}", String(subagentProgress.running))}</span>
                      <button type="button" className="ynAgentSubagentStop" title={ui.stopBackgroundSubagents} aria-label={ui.stopBackgroundSubagents} onClick={() => void handleAbort()}>
                        <Square size={11} fill="currentColor" />
                      </button>
                    </div>
                  )}
                  {queuedInputs.map((item) => (
                    <div
                      className="ynAgentQueuedInput"
                      data-agent-queued-input={item.kind}
                      key={`${item.kind}:${item.message.timestamp}:${item.text}`}
                    >
                      {item.kind === "steer" ? <CornerDownRight size={13} /> : <ListPlus size={13} />}
                      <strong>{item.kind === "steer" ? ui.queuedSteer : item.kind === "followUp" ? ui.queuedFollowUp : ui.queuedNextTurn}</strong>
                      <span>{item.text || ui.imageOnlyMessage.replace("{count}", String(item.imageCount))}</span>
                    </div>
                  ))}
                </div>
              )}
              {chatInputElement}
            </footer>
          </>
        )}
      </section>
    </main>
  );
}

function SessionSidebar({
  title,
  conversations,
  activeConversationId,
  route,
  locale,
  disabled,
  onSelect,
  onNew,
  onDelete
}: {
  title: string;
  conversations: PiSessionSummary[];
  activeConversationId: string;
  route: YnAgentRoute;
  locale: AgentUiLocale;
  disabled: boolean;
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => void;
}) {
  const confirmDelete = (conversation: PiSessionSummary) => {
    const title = conversation.name || conversation.firstMessage || conversation.id;
    if (!window.confirm(`${agentUiStrings[locale].deleteSessionConfirm}\n\n${title}`)) return;
    onDelete(conversation.id);
  };

  return (
    <>
      <div className="ynAgentSidebarHeader">
        <div>
          <strong>YN Agent OS</strong>
          <span>{route.outputDir || agentUiStrings[locale].noProject}</span>
        </div>
        <button type="button" disabled={disabled || !route.outputDir} onClick={onNew}>{agentUiStrings[locale].newSession}</button>
      </div>
      <div className="ynAgentSidebarSection">
        <div className="ynAgentSidebarLabel">{agentUiStrings[locale].sessions}</div>
        {conversations.length === 0 ? (
          <div className="ynAgentSidebarEmpty">{agentUiStrings[locale].noSessions}</div>
        ) : conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`ynAgentSessionItem${conversation.id === activeConversationId ? " ynAgentSessionItemActive" : ""}`}
          >
            <button
              type="button"
              className="ynAgentSessionSelect"
              disabled={disabled}
              onClick={() => onSelect(conversation.id)}
            >
              <span>{conversation.name === "New session"
                ? agentUiStrings[locale].untitledSession
                : conversation.name || conversation.firstMessage || agentUiStrings[locale].untitledSession}</span>
              <small>{new Date(conversation.modified || conversation.created).toLocaleString(locale)}</small>
            </button>
            <button
              type="button"
              className="ynAgentSessionDelete"
              title={agentUiStrings[locale].deleteSession}
              aria-label={agentUiStrings[locale].deleteSession}
              disabled={disabled}
              onClick={() => confirmDelete(conversation)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

function SessionStatsButton({
  locale,
  contextUsage,
  sessionStats,
  open,
  onToggle
}: {
  locale: AgentUiLocale;
  contextUsage: ContextUsage | null;
  sessionStats: SessionStatsInfo | null;
  open: boolean;
  onToggle: () => void;
}) {
  const tokens = sessionStats?.tokens;
  const cost = sessionStats?.cost ?? 0;
  const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01") : null;
  const contextText = contextUsage?.contextWindow
    ? `${contextUsage.percent !== null ? `${contextUsage.percent.toFixed(0)}%` : "?"} / ${formatCompactCount(contextUsage.contextWindow)}`
    : null;
  const tooltipParts: string[] = [];
  if (tokens) {
    tooltipParts.push(`in: ${tokens.input.toLocaleString()}`);
    tooltipParts.push(`out: ${tokens.output.toLocaleString()}`);
    tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString()}`);
    tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString()}`);
    if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
  }
  if (contextUsage?.contextWindow) {
    tooltipParts.push(`context: ${contextUsage.percent !== null ? `${contextUsage.percent.toFixed(1)}%` : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
  }
  return (
    <button
      className={`ynAgentTelemetry${open ? " ynAgentTelemetryActive" : ""}`}
      type="button"
      title={tooltipParts.join("  |  ") || agentUiStrings[locale].sessionInfo}
      onClick={onToggle}
    >
      {tokens && tokens.input > 0 && <span aria-label="input tokens">in {formatCompactCount(tokens.input)}</span>}
      {tokens && tokens.output > 0 && <span aria-label="output tokens">out {formatCompactCount(tokens.output)}</span>}
      {tokens && tokens.cacheRead > 0 && <span data-telemetry-secondary="true" aria-label="cache read tokens">cache {formatCompactCount(tokens.cacheRead)}</span>}
      {costText && <span data-telemetry-secondary="true">{costText}</span>}
      {contextText && <span data-telemetry-secondary="true">{contextText}</span>}
      {!tokens && <span>{agentUiStrings[locale].sessionShort}</span>}
    </button>
  );
}

function SessionStatsPanel({
  locale,
  contextUsage,
  sessionStats,
  agentRunning,
  phaseText,
  modelName,
  subagentProgress
}: {
  locale: AgentUiLocale;
  contextUsage: ContextUsage | null;
  sessionStats: SessionStatsInfo | null;
  agentRunning: boolean;
  phaseText: string;
  modelName: string;
  subagentProgress: SubagentProgress;
}) {
  const s = agentUiStrings[locale].stats;
  const tokenRows: string[][] = sessionStats ? [
    [s.input, sessionStats.tokens.input.toLocaleString()],
    [s.output, sessionStats.tokens.output.toLocaleString()],
    ...(sessionStats.tokens.cacheRead > 0 ? [[s.cacheRead, sessionStats.tokens.cacheRead.toLocaleString()]] : []),
    ...(sessionStats.tokens.cacheWrite > 0 ? [[s.cacheWrite, sessionStats.tokens.cacheWrite.toLocaleString()]] : []),
    [s.total, sessionStats.tokens.total.toLocaleString()]
  ] : [];
  const ctx = contextUsage ?? sessionStats?.contextUsage;
  const extraRows: string[][] = sessionStats ? [
    ...(sessionStats.cost > 0 ? [[s.cost, `$${sessionStats.cost.toFixed(4)}`]] : []),
    ...(ctx?.contextWindow ? [[s.context, `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompactCount(ctx.contextWindow)}`]] : [])
  ] : [];
  const currentRunRows: string[][] = [
    [s.state, agentRunning ? s.running : s.ready],
    ...(phaseText.toLowerCase() !== (agentRunning ? "running" : "ready") ? [[s.phase, phaseText]] : []),
    [s.model, modelName],
    ...(subagentProgress.total > 0
      ? [[s.subagents, s.subagentSummary.replace("{running}", String(subagentProgress.running)).replace("{closed}", String(subagentProgress.closed))]]
      : [])
  ];
  return (
    <div className="ynAgentSessionStatsPanel" data-agent-run-status={agentRunning ? "running" : "ready"}>
      <div className="ynAgentSessionStatsGrid">
        <StatsSection title={s.currentRun} rows={currentRunRows} />
        {sessionStats && (
          <StatsSection
            title={s.messages}
            rows={[
              [s.user, sessionStats.userMessages.toLocaleString()],
              [s.assistant, sessionStats.assistantMessages.toLocaleString()],
              [s.toolCalls, sessionStats.toolCalls.toLocaleString()],
              [s.toolResults, sessionStats.toolResults.toLocaleString()],
              [s.total, sessionStats.totalMessages.toLocaleString()]
            ]}
          />
        )}
        {sessionStats && <StatsSection title={s.tokens} rows={[...tokenRows, ...extraRows]} alignRight />}
      </div>
    </div>
  );
}

function StatsSection({ title, rows, alignRight }: { title: string; rows: string[][]; alignRight?: boolean }) {
  return (
    <div className="ynAgentStatsSection">
      <div className="ynAgentStatsTitle">{title}</div>
      <div className="ynAgentStatsRows">
        {rows.map(([label, value]) => (
          <div className="ynAgentStatsRow" key={`${title}:${label}`}>
            <span>{label}</span>
            <strong className={alignRight ? "ynAgentStatsValueRight" : undefined}>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
