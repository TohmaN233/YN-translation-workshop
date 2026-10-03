export type YnTaskPreparationIntent = "translation" | "assets" | "proofread";

export interface YnTaskPreparationRequest {
  intent: YnTaskPreparationIntent;
  /** Apply suggestions to the HTML review state only. TXT export stays manual. */
  autoApplyProofreadSuggestions?: boolean;
}

export function normalizeTaskPreparationRequest(value: unknown): YnTaskPreparationRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("taskPreparation must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (!["translation", "assets", "proofread"].includes(String(input.intent))) {
    throw new Error("taskPreparation.intent must be translation, assets or proofread.");
  }
  if (input.autoApplyProofreadSuggestions !== undefined && typeof input.autoApplyProofreadSuggestions !== "boolean") {
    throw new Error("autoApplyProofreadSuggestions must be a boolean.");
  }
  if (input.autoApplyProofreadSuggestions === true && input.intent !== "proofread") {
    throw new Error("Only proofreading can apply HTML review suggestions.");
  }
  return {
    intent: input.intent as YnTaskPreparationIntent,
    ...(input.autoApplyProofreadSuggestions !== undefined
      ? { autoApplyProofreadSuggestions: input.autoApplyProofreadSuggestions as boolean } : {})
  };
}
