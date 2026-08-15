"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { agentUiStrings, normalizeAgentUiLocale, type AgentUiLocale } from "./i18n";
import { normalizeToolCalls } from "./normalize";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "./types";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  loadSubagentMessages?: (childSessionId: string) => Promise<AgentMessage[]>;
  locale?: AgentUiLocale;
}

function formatTime(ts: number | undefined, locale: AgentUiLocale): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString(locale, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export function MessageView({ message, isStreaming, toolResults, modelNames, showTimestamp, prevTimestamp, loadSubagentMessages, locale: localeInput }: Props) {
  const locale = normalizeAgentUiLocale(localeInput);
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} locale={locale} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} locale={locale} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    const custom = message as CustomMessage;
    if (custom.display === false) return null;
    return <CustomMessageView message={custom} loadSubagentMessages={loadSubagentMessages} locale={locale} />;
  }
  return null;
}

function UserMessageView({ message, locale }: {
  message: UserMessage;
  locale: AgentUiLocale;
}) {
  const ui = agentUiStrings[locale];
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  if (!content && imageBlocks.length === 0) return null;

  const time = formatTime(message.timestamp, locale);
  const copyContent = () => {
    copyText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      data-agent-message-role="user"
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid rgba(59,130,246,0.2)",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
                  />
                );
              })}
            </div>
          )}
          {content && <MarkdownBody className="markdown-user-message">{content}</MarkdownBody>}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
              title={ui.copy}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? ui.copied : ui.copy}
            </button>
          </div>
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  showTimestamp,
  prevTimestamp,
  locale,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  locale: AgentUiLocale;
}) {
  const ui = agentUiStrings[locale];
  const time = showTimestamp ? formatTime(message.timestamp, locale) : null;
  const blocks = message.content ?? [];
  const terminalError = message.stopReason === "error"
    ? message.errorMessage?.trim() || ui.providerFailed
    : null;
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      const callId = block.toolCallId;
      const result = toolResults.get(callId);
      if (!result) continue;
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [blocks, toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = Date.now();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const bs = blocksRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      bs.forEach((_, i) => {
        if (!blockStartTimesRef.current.has(i)) blockStartTimesRef.current.set(i, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < bs.length - 1; i++) {
          if (!next.has(i) && blockStartTimesRef.current.has(i)) {
            const start = blockStartTimesRef.current.get(i)!;
            const nextStart = blockStartTimesRef.current.get(i + 1) ?? now;
            next.set(i, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  return (
    <div
      data-agent-message-role="assistant"
      data-agent-streaming={isStreaming ? "true" : "false"}
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          const messageElapsed = message.timestamp
            ? Math.max(0, (Date.now() - message.timestamp) / 1000)
            : 0;
          const visibleTps = tps ?? (est > 0 && messageElapsed > 0.25 ? est / messageElapsed : null);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={ui.estimatedStreamingTokens}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {visibleTps !== null && (() => {
                    const bg = visibleTps >= 50 ? "#53b3cb" : visibleTps >= 30 ? "#9bc53d" : visibleTps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span data-agent-token-speed="true" style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {visibleTps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(i) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} locale={locale} />
        ))}
        {terminalError && (
          <div className="ynAgentError" role="alert" data-agent-message-error="true">
            {terminalError}
          </div>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage)}
          </div>
        )}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            title={ui.copy}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? ui.copied : ui.copy}
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, locale }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; locale: AgentUiLocale }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} locale={locale} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} locale={locale} />;
  }
  return null;
}

function TextBlock({ block, isStreaming }: { block: TextContent; isStreaming?: boolean }) {
  return <MarkdownBody isStreaming={isStreaming}>{block.text}</MarkdownBody>;
}

function ThinkingBlock({ block, duration, locale }: { block: ThinkingContent; duration?: number; locale: AgentUiLocale }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-agent-thinking-block="true"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span>{agentUiStrings[locale].thinking}</span>
        {duration !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {block.thinking}
        </div>
      )}
    </div>
  );
}


function ToolCallBlock({ block, result, duration, locale }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; locale: AgentUiLocale }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  return (
    <div
      data-agent-tool-call={block.toolName}
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
          {block.toolName}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {getToolPreview(block, locale)}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: input args ── */}
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
          locale={locale}
        />
      )}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError, locale }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
  locale: AgentUiLocale;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? `(${agentUiStrings[locale].noOutput})` : text}
      </pre>
    </div>
  );
}

function CustomMessageView({
  message,
  loadSubagentMessages,
  locale
}: {
  message: CustomMessage;
  loadSubagentMessages?: (childSessionId: string) => Promise<AgentMessage[]>;
  locale: AgentUiLocale;
}) {
  if (isSubagentMessage(message)) {
    return <SubagentMessageView message={message} loadSubagentMessages={loadSubagentMessages} locale={locale} />;
  }
  const isHiddenDisplay = message.display === false;
  const ui = agentUiStrings[locale];
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp, locale);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
          {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{ui.hiddenExtensionMessage}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  );
                })}
              </div>
            )}
            {text ? <MarkdownBody className="markdown-custom-message">{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({ui.noMessage})</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {text ? previewText(text, ui.showExtensionMessage) : ui.showExtensionMessage}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {copied ? ui.copied : ui.copy}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay
                ? (contentExpanded ? ui.collapse : ui.expand)
                : (detailsExpanded ? ui.hideDetails : ui.showDetails)}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function SubagentMessageView({
  message,
  loadSubagentMessages,
  locale
}: {
  message: CustomMessage;
  loadSubagentMessages?: (childSessionId: string) => Promise<AgentMessage[]>;
  locale: AgentUiLocale;
}) {
  const ui = agentUiStrings[locale];
  const details = asRecord(message.details);
  const status = String(details?.status || (details?.completed ? "completed" : "") || "").trim();
  const terminal = status === "completed" || status === "skipped" || status === "failed" || status === "stopped";
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<"prompt" | "reply">(terminal ? "reply" : "prompt");
  const [copied, setCopied] = useState(false);
  const [transcript, setTranscript] = useState<AgentMessage[] | null>(null);
  const [transcriptError, setTranscriptError] = useState("");
  const transcriptRequest = useRef<Promise<void> | null>(null);
  const transcriptGeneration = useRef(0);
  const text = getMessageText(message.content);
  const title = typeof details?.label === "string" && details.label.trim()
    ? details.label.trim()
    : formatCustomType(message.customType);
  const time = formatTime(message.timestamp, locale);
  const promptText = subagentPromptFromTranscript(transcript) || subagentPromptText(details);
  const replyText = subagentReplyText(details, text);
  const childSessionId = typeof details?.subagentId === "string" ? details.subagentId.trim() : "";
  const modelName = typeof details?.modelName === "string" && details.modelName.trim()
    ? details.modelName.trim()
    : typeof details?.modelId === "string" ? details.modelId.trim() : "";
  const activity = typeof details?.activity === "string" ? details.activity.trim() : "";
  const localizedStatus = (ui.status[status || "running"] ?? status) || ui.status.running;
  const statusText = [localizedStatus, activity].filter(Boolean).join(" · ");
  const closedText = status === "completed" || status === "skipped" || status === "failed" || status === "stopped"
    ? `${ui.subagentClosed} · ${statusText}`
    : `${ui.subagentCollapsed} · ${statusText}`;
  const activeText = view === "prompt" ? promptText : replyText;

  useEffect(() => {
    if (terminal) setView("reply");
  }, [terminal]);

  useEffect(() => {
    transcriptGeneration.current += 1;
    transcriptRequest.current = null;
    setTranscript(null);
    setTranscriptError("");
    setExpanded(false);
  }, [childSessionId]);

  const ensureTranscript = () => {
    if (transcript !== null || transcriptRequest.current || !childSessionId || !loadSubagentMessages) return;
    setTranscriptError("");
    const generation = ++transcriptGeneration.current;
    const startedAt = performance.now();
    console.debug("[pi-child-transcript-ui]", JSON.stringify({ phase: "load-start", childSessionId, generation }));
    const request = loadSubagentMessages(childSessionId)
      .then((messages) => {
        if (transcriptGeneration.current === generation) {
          setTranscript(normalizeSubagentTranscript(messages));
          console.debug("[pi-child-transcript-ui]", JSON.stringify({
            phase: "load-complete",
            childSessionId,
            generation,
            messages: messages.length,
            elapsedMs: Number((performance.now() - startedAt).toFixed(1))
          }));
        } else {
          console.debug("[pi-child-transcript-ui]", JSON.stringify({
            phase: "load-obsolete",
            childSessionId,
            generation,
            currentGeneration: transcriptGeneration.current
          }));
        }
      })
      .catch((error) => {
        if (transcriptGeneration.current === generation) {
          setTranscriptError(error instanceof Error ? error.message : String(error));
          console.error("[pi-child-transcript-ui]", JSON.stringify({
            phase: "load-error",
            childSessionId,
            generation,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      })
      .finally(() => {
        if (transcriptGeneration.current === generation) transcriptRequest.current = null;
      });
    transcriptRequest.current = request;
  };

  useEffect(() => {
    if (expanded) ensureTranscript();
  }, [expanded, view, childSessionId, loadSubagentMessages]);

  const copyActive = () => {
    copyText(activeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        data-agent-subagent-card="true"
        data-agent-subagent-kind={message.customType}
        data-agent-subagent-id={childSessionId || undefined}
        data-agent-subagent-expanded={expanded ? "true" : "false"}
        data-agent-subagent-status={status || "running"}
        style={{
          border: "1px solid rgba(99,102,241,0.24)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => {
            if (value) {
              transcriptGeneration.current += 1;
              console.debug("[pi-child-transcript-ui]", JSON.stringify({
                phase: "collapse",
                childSessionId,
                generation: transcriptGeneration.current
              }));
              setTranscript(null);
              setTranscriptError("");
              transcriptRequest.current = null;
            }
            return !value;
          })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 10px",
            border: "none",
            borderBottom: expanded ? "1px solid var(--border)" : "none",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
          <span style={{ color: status === "failed" ? "#f87171" : "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
            {expanded ? statusText : closedText}
          </span>
          {modelName && (
            <span
              data-agent-subagent-model="true"
              title={typeof details?.providerId === "string" ? `${details.providerId} / ${modelName}` : modelName}
              style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {modelName}
            </span>
          )}
          {time && <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{time}</span>}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>

        {expanded && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 9px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-subtle)",
              }}
            >
              {(["prompt", "reply"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  data-agent-subagent-filter={item}
                  aria-pressed={view === item}
                  onClick={() => setView(item)}
                  style={{
                    padding: "4px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: view === item ? "var(--bg-selected)" : "var(--bg)",
                    color: view === item ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: view === item ? 650 : 500,
                  }}
                >
                  {item === "prompt" ? ui.prompt : ui.reply}
                </button>
              ))}
              <button
                type="button"
                onClick={copyActive}
                style={{
                  marginLeft: "auto",
                  padding: "4px 8px",
                  border: "none",
                  background: "none",
                  color: copied ? "var(--accent)" : "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {copied ? ui.copied : ui.copy}
              </button>
            </div>
            {transcriptError ? (
              <pre data-agent-subagent-panel={view} className="ynAgentError">{transcriptError}</pre>
            ) : transcript === null && childSessionId && loadSubagentMessages ? (
              <pre data-agent-subagent-panel={view}>{ui.loadingChildSession}</pre>
            ) : view === "reply" && transcript && transcript.length > 0 ? (
              <SubagentTranscriptView transcript={transcript} resultSummary={replyText} locale={locale} />
            ) : (
              <pre
                data-agent-subagent-panel={view}
                style={{
                  margin: 0,
                  padding: "9px 10px",
                  color: activeText ? "var(--text-muted)" : "var(--text-dim)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 360,
                  overflow: "auto",
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg)",
                }}
              >
                {activeText || `(${view === "prompt" ? ui.promptUnavailable : ui.replyUnavailable})`}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeSubagentTranscript(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") return [];
    return [normalizeToolCalls(message as AgentMessage)];
  });
}

export function SubagentTranscriptView({
  transcript,
  resultSummary,
  locale: localeInput
}: {
  transcript: unknown;
  resultSummary?: string;
  locale?: AgentUiLocale;
}) {
  const locale = normalizeAgentUiLocale(localeInput);
  const messages = normalizeSubagentTranscript(transcript);
  const toolResults = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      toolResults.set(message.toolCallId, message);
    }
  }
  const visibleMessages = messages.filter((message) => message.role !== "toolResult");
  const summary = resultSummary?.trim() || "";
  const summaryKey = summary.replace(/\s+/g, " ").trim();
  const transcriptHasSummary = summaryKey.length > 0 && messages.some((message) => {
    if (message.role !== "assistant") return false;
    const assistant = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
    return assistant === summaryKey;
  });
  const showResultSummary = summaryKey.length > 0 && !transcriptHasSummary;

  return (
    <div
      data-agent-subagent-panel="reply"
      data-agent-subagent-transcript="true"
      style={{
        padding: "9px 10px",
        maxHeight: 420,
        overflow: "auto",
        background: "var(--bg)",
      }}
    >
      {visibleMessages.map((message, index) => (
        <MessageView
          key={`${message.role}-${message.timestamp ?? index}-${index}`}
          message={message}
          toolResults={toolResults}
          showTimestamp={false}
          prevTimestamp={visibleMessages[index - 1]?.timestamp}
          locale={locale}
        />
      ))}
      {showResultSummary && (
        <div
          data-agent-subagent-result="true"
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 9,
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <MarkdownBody className="markdown-subagent-result">{summary}</MarkdownBody>
        </div>
      )}
    </div>
  );
}

function isSubagentMessage(message: CustomMessage): boolean {
  const details = asRecord(message.details);
  return Boolean(details?.subagentId)
    || /^subagent(?:[.\s_-]|$)/i.test(message.customType)
    || /^sa-/.test(String(details?.id || ""));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function subagentPromptText(details: Record<string, unknown> | undefined): string {
  const prompt = details?.prompt ?? details?.rangePrompt ?? details?.taskPrompt;
  return typeof prompt === "string" ? prompt.trim() : "";
}

export function subagentPromptFromTranscript(transcript: AgentMessage[] | null): string {
  if (!transcript) return "";
  const firstUser = transcript.find((message) => message.role === "user");
  return firstUser ? getMessageText(firstUser.content).trim() : "";
}

function subagentReplyText(details: Record<string, unknown> | undefined, fallbackText: string): string {
  const reply = details?.resultSummary ?? details?.reply ?? details?.assistantText ?? details?.summary ?? details?.detail ?? details?.error;
  return typeof reply === "string" && reply.trim() ? reply.trim() : fallbackText.trim();
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent, locale: AgentUiLocale): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  if (Array.isArray(first)) return agentUiStrings[locale].itemCount.replace("{count}", String(first.length));
  if (first && typeof first === "object") return agentUiStrings[locale].fieldCount.replace("{count}", String(Object.keys(first).length));
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
