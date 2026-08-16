import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";

/** Pi thinking levels plus the renderer-only automatic selection. */
export type ThinkingLevel = PiThinkingLevel | "auto";
export type ConcreteThinkingLevel = Exclude<ThinkingLevel, "auto">;

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

const CONCRETE_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const AUTO_FALLBACK_ORDER = ["medium", "high", "low", "xhigh", "minimal"] as const satisfies readonly ModelThinkingLevel[];

type ThinkingModelLike = {
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
  compat?: { supportsReasoningEffort?: boolean } & Record<string, unknown>;
};

type OfficialThinkingContract = {
  defaultLevel: Exclude<ModelThinkingLevel, "off" | "minimal">;
  thinkingLevelMap: Partial<Record<ModelThinkingLevel, string | null>>;
};

const OFFICIAL_GROK_THINKING_CONTRACTS: Record<"grok-4.6" | "grok-4.5", OfficialThinkingContract> = {
  "grok-4.6": {
    defaultLevel: "high",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh"
    }
  },
  "grok-4.5": {
    defaultLevel: "high",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high"
    }
  }
};

function officialGrokThinkingFamily(modelId: string): keyof typeof OFFICIAL_GROK_THINKING_CONTRACTS | undefined {
  const id = modelId.trim().toLowerCase();
  if (id === "grok-4.6" || id.startsWith("grok-4.6-")) return "grok-4.6";
  if (id === "grok-4.5" || id.startsWith("grok-4.5-")) return "grok-4.5";
  return undefined;
}

export function officialThinkingContract(modelId: string): OfficialThinkingContract | undefined {
  const family = officialGrokThinkingFamily(modelId);
  return family ? OFFICIAL_GROK_THINKING_CONTRACTS[family] : undefined;
}

export function applyKnownThinkingContract<T extends { id: string }>(model: T): T {
  const contract = officialThinkingContract(model.id);
  if (!contract) return model;
  const current = model as T & ThinkingModelLike;
  return {
    ...current,
    reasoning: true,
    thinkingLevelMap: {
      ...current.thinkingLevelMap,
      ...contract.thinkingLevelMap
    },
    compat: {
      ...current.compat,
      supportsReasoningEffort: true
    }
  };
}

function asPiModel(model: { id: string }): Model<Api> {
  return applyKnownThinkingContract(model) as Model<Api>;
}

function hasExplicitEffortControls(model: { id: string }): boolean {
  const applied = applyKnownThinkingContract(model) as ThinkingModelLike;
  if (!applied.reasoning) return false;
  const map = applied.thinkingLevelMap;
  if (!map) return false;
  return CONCRETE_EFFORT_LEVELS.some((level) => map[level] != null);
}

export function listThinkingLevelsForModel(model: { id: string } | undefined): ModelThinkingLevel[] {
  if (!model) return ["off"];
  const applied = asPiModel(model);
  if (!applied.reasoning || !hasExplicitEffortControls(model)) return ["off"];
  return getSupportedThinkingLevels(applied);
}

export function modelShowsThinkingPicker(model: { id: string } | undefined): boolean {
  return listThinkingLevelsForModel(model).some((level) => level !== "off");
}

export function defaultThinkingLevelForModel(model: { id: string } | undefined): ModelThinkingLevel {
  if (!model) return "off";
  const supported = listThinkingLevelsForModel(model);
  const contract = officialThinkingContract(model.id);
  if (contract && supported.includes(contract.defaultLevel)) return contract.defaultLevel;
  for (const candidate of AUTO_FALLBACK_ORDER) {
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? "off";
}

function requestedConcreteLevel(value: ThinkingLevel | undefined): ModelThinkingLevel | "auto" | undefined {
  if (!value || value === "auto") return value;
  if (value === "max") return "xhigh";
  return value;
}

/** Resolve the thinking level that may actually be sent for this model. */
export function resolveThinkingLevelForModel(
  model: { id: string } | undefined,
  value: ThinkingLevel | undefined
): ModelThinkingLevel {
  if (!model || !hasExplicitEffortControls(model)) {
    if (model && value && value !== "auto" && value !== "off") {
      console.info("[thinking-level] model has no official effort controls; not sending GPT tiers", {
        modelId: model.id,
        requested: value
      });
    }
    return "off";
  }
  const requested = requestedConcreteLevel(value);
  const concrete = !requested || requested === "auto"
    ? defaultThinkingLevelForModel(model)
    : requested;
  const resolved = clampThinkingLevel(asPiModel(model), concrete);
  if (value && value !== "auto" && value !== resolved) {
    console.info("[thinking-level] clamped to model-supported effort", {
      modelId: model.id,
      requested: value,
      resolved,
      supported: listThinkingLevelsForModel(model)
    });
  }
  return resolved;
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_OPTIONS.find((option) => option.id === level)?.label ?? level;
}
