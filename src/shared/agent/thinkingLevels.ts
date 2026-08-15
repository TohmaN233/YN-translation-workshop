import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";

/** Pi thinking levels plus the renderer-only automatic selection. */
export type ThinkingLevel = PiThinkingLevel | "auto";

export const THINKING_LEVEL_OPTIONS: Array<{ id: ThinkingLevel; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" }
];

export function providerSupportsThinkingLevel(providerId: string): boolean {
  return providerId === "openai-chatgpt";
}
