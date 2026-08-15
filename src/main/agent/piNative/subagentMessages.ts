import type { AgentMessage } from "@earendil-works/pi-agent-core/node";

const MAX_SUBAGENT_CARD_SUMMARY_CHARS = 4_000;

function boundedCardText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_CARD_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUBAGENT_CARD_SUMMARY_CHARS)}\n[truncated]`;
}

export function lightweightSubagentCard(message: AgentMessage): AgentMessage {
  const details = message.role === "custom" && message.details && typeof message.details === "object"
    ? message.details as Record<string, unknown>
    : undefined;
  if (!details || typeof details.subagentId !== "string" || !details.subagentId) return message;

  const lightweightDetails = { ...details };
  delete lightweightDetails.transcript;
  delete lightweightDetails.prompt;
  delete lightweightDetails.reply;
  const resultSummary = boundedCardText(lightweightDetails.resultSummary);
  if (resultSummary) lightweightDetails.resultSummary = resultSummary;
  const content = resultSummary
    || boundedCardText(lightweightDetails.error)
    || boundedCardText(lightweightDetails.label)
    || "Subagent";
  return {
    ...message,
    content,
    details: lightweightDetails
  } as AgentMessage;
}

export function compactSubagentCards(messages: AgentMessage[]): AgentMessage[] {
  const compacted: AgentMessage[] = [];
  const indexes = new Map<string, number>();
  for (const message of messages) {
    const details = message.role === "custom" && message.details && typeof message.details === "object"
      ? message.details as Record<string, unknown>
      : undefined;
    const subagentId = typeof details?.subagentId === "string" ? details.subagentId : "";
    if (!subagentId) {
      compacted.push(message);
      continue;
    }
    const lightweightMessage = lightweightSubagentCard(message);
    const existing = indexes.get(subagentId);
    if (existing === undefined) {
      indexes.set(subagentId, compacted.length);
      compacted.push(lightweightMessage);
    } else {
      compacted[existing] = lightweightMessage;
    }
  }
  return compacted;
}

export function interruptedSubagentCards(
  messages: AgentMessage[],
  timestamp = Date.now(),
  ownedSubagentIds: ReadonlySet<string> = new Set()
): AgentMessage[] {
  return compactSubagentCards(messages).flatMap((message) => {
    if (message.role !== "custom" || !message.customType.startsWith("subagent.")) return [];
    if (!message.details || typeof message.details !== "object") return [];
    const details = message.details as Record<string, unknown>;
    if (
      typeof details.subagentId !== "string"
      || details.status !== "running"
      || ownedSubagentIds.has(details.subagentId)
    ) return [];
    const startedAt = typeof details.startedAt === "number" ? details.startedAt : undefined;
    const reason = "Application exited before this subagent completed.";
    return [{
      ...message,
      content: reason,
      details: {
        ...details,
        status: "stopped",
        closed: true,
        completed: false,
        collapsed: true,
        error: reason,
        finishedAt: timestamp,
        ...(startedAt === undefined ? {} : { durationMs: Math.max(0, timestamp - startedAt) }),
        recoveryReason: "process_restart"
      },
      timestamp
    } as AgentMessage];
  });
}
