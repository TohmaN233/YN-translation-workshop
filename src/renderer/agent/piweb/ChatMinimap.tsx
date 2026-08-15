"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { AgentMessage, AssistantMessage, TextContent } from "./types";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

const MINIMAP_WIDTH = 36;

function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((block) => block.type === "toolCall")
      .map((block) => (block as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
  }
  return "";
}

function getNodeColor(msg: AgentMessage | Partial<AgentMessage>): { bg: string; border: string } {
  if (msg.role === "user") {
    return { bg: "rgba(37,99,235,0.18)", border: "rgba(37,99,235,0.7)" };
  }
  return { bg: "rgba(107,114,128,0.12)", border: "rgba(107,114,128,0.5)" };
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((block) => block.type === "text");
  }
  return false;
}

interface NodeInfo {
  topRatio: number;
  heightRatio: number;
  msg: AgentMessage | Partial<AgentMessage>;
  index: number;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs }: Props) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const updatePositionsRef = useRef<() => void>(() => {});
  updatePositionsRef.current = () => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;

    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    const scrollable = totalH - clientH;

    setVisible(scrollable > 20);
    if (scrollable <= 0) {
      setScrollRatio(0);
      setViewportRatio(1);
    } else {
      setScrollRatio(scrollEl.scrollTop / scrollable);
      setViewportRatio(clientH / totalH);
    }

    const refs = messageRefs.current;
    const newNodes: NodeInfo[] = [];
    let refIndex = 0;

    for (const msg of allMessagesRef.current) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const el = refs?.[refIndex];
      refIndex += 1;
      if (!hasTextContent(msg)) continue;

      if (el && totalH > 0) {
        const elRect = el.getBoundingClientRect();
        const containerRect = scrollEl.getBoundingClientRect();
        const top = elRect.top - containerRect.top + scrollEl.scrollTop;
        newNodes.push({
          topRatio: top / totalH,
          heightRatio: elRect.height / totalH,
          msg,
          index: newNodes.length
        });
      }
    }
    setNodes(newNodes);
  };

  const updatePositions = useCallback(() => updatePositionsRef.current(), []);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return undefined;
    el.addEventListener("scroll", updatePositions, { passive: true });
    const ro = new ResizeObserver(updatePositions);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    updatePositions();
    return () => {
      el.removeEventListener("scroll", updatePositions);
      ro.disconnect();
    };
  }, [scrollContainer, updatePositions]);

  useEffect(() => {
    const timer = window.setTimeout(updatePositions, 50);
    return () => window.clearTimeout(timer);
  }, [messages.length, updatePositions]);

  const scrollToMinimapRatio = useCallback((viewportTopRatio: number) => {
    const el = scrollContainer.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const clamped = Math.max(0, Math.min(1 - viewportRatio, viewportTopRatio));
    el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
  }, [scrollContainer, viewportRatio]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    const rect = event.currentTarget.getBoundingClientRect();
    const clickRatio = (event.clientY - rect.top) / rect.height;
    const grabOffset = clickRatio - scrollRatio * (1 - viewportRatio);
    const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
    const offset = insideBox ? grabOffset : viewportRatio / 2;

    scrollToMinimapRatio(clickRatio - offset);

    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      const ratio = (moveEvent.clientY - rect.top) / rect.height;
      scrollToMinimapRatio(ratio - offset);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [scrollRatio, scrollToMinimapRatio, viewportRatio, visible]);

  const tooltipHeight = 22;
  const tooltipGap = 2;
  const minimapHeightPx = containerRef.current?.clientHeight ?? 600;

  const tooltipPositions = useMemo(() => {
    if (!minimapHovered || nodes.length === 0) return [];
    const positions = nodes.map((node) => Math.round(node.topRatio * minimapHeightPx - tooltipHeight / 2));
    for (let pass = 0; pass < 10; pass += 1) {
      for (let index = 1; index < positions.length; index += 1) {
        const minTop = positions[index - 1] + tooltipHeight + tooltipGap;
        if (positions[index] < minTop) positions[index] = minTop;
      }
      for (let index = positions.length - 2; index >= 0; index -= 1) {
        const maxTop = positions[index + 1] - tooltipHeight - tooltipGap;
        if (positions[index] > maxTop) positions[index] = maxTop;
      }
    }
    for (let index = 0; index < positions.length; index += 1) {
      positions[index] = Math.max(0, Math.min(minimapHeightPx - tooltipHeight, positions[index]));
    }
    return positions;
  }, [minimapHeightPx, minimapHovered, nodes]);

  if (!visible) return null;

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100;
  const viewportBoxHeight = viewportRatio * 100;
  const nearestIndex = mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node) => (
      Math.abs(node.topRatio - mouseYRatio) < Math.abs(nodes[best].topRatio - mouseYRatio) ? node.index : best
    ), 0)
    : null;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => {
        setMinimapHovered(false);
        setMouseYRatio(null);
      }}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMouseYRatio((event.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "default",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible"
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${viewportBoxTop}%`,
          height: `${viewportBoxHeight}%`,
          background: "rgba(100,100,100,0.1)",
          borderTop: "1px solid rgba(100,100,100,0.2)",
          borderBottom: "1px solid rgba(100,100,100,0.2)",
          pointerEvents: "none",
          zIndex: 1
        }}
      />

      {nodes.map((node) => {
        const color = getNodeColor(node.msg);
        const isNearest = minimapHovered && nearestIndex === node.index;
        const isUser = node.msg.role === "user";
        return (
          <div
            key={node.index}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 2
            }}
          >
            <div
              style={{
                width: isUser ? 8 : 6,
                height: isUser ? 8 : 6,
                borderRadius: isUser ? 2 : "50%",
                background: color.bg,
                border: `1.5px solid ${color.border}`,
                flexShrink: 0,
                transition: "transform 0.1s",
                transform: isNearest ? "scale(1.6)" : "scale(1)"
              }}
            />
          </div>
        );
      })}

      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0
        }}
      />

      {minimapHovered && nodes.map((node, index) => {
        const preview = getMessagePreview(node.msg);
        const color = getNodeColor(node.msg);
        const isNearest = nearestIndex === node.index;
        if (!preview || tooltipPositions.length === 0) return null;
        return (
          <div
            key={node.index}
            style={{
              position: "absolute",
              top: tooltipPositions[index],
              right: "100%",
              marginRight: 6,
              background: "var(--bg)",
              borderTop: `1px solid ${isNearest ? color.border : "var(--border)"}`,
              borderRight: `1px solid ${isNearest ? color.border : "var(--border)"}`,
              borderBottom: `1px solid ${isNearest ? color.border : "var(--border)"}`,
              borderLeft: `2px solid ${color.border}`,
              borderRadius: 4,
              padding: "2px 7px",
              width: 200,
              zIndex: 100,
              pointerEvents: "none",
              opacity: isNearest ? 1 : 0.45,
              transition: "top 0.1s, opacity 0.1s"
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: isNearest ? "var(--text)" : "var(--text-muted)",
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis"
              }}
            >
              {preview}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, index) => refs.current[index] ?? null);
  return refs;
}
