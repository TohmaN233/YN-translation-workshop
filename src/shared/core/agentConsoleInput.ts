import type { AgentType } from "./prompts.ts";

export function formatInteractiveAgentMessage(agent: AgentType, text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (agent === "codex") {
    return `\x1b[200~${normalized}\x1b[201~`;
  }
  return normalized;
}

export function formatInteractiveAgentSubmit(agent: AgentType, text: string): string {
  return `${formatInteractiveAgentMessage(agent, text)}\r`;
}
