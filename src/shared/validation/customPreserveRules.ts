export interface CustomPreserveRule {
  label?: string;
  pattern: string;
  flags?: string;
}

export interface CanonicalCustomPreserveRule {
  label?: string;
  pattern: string;
  flags: string;
}

const MAX_RULE_COUNT = 64;
const MAX_PATTERN_LENGTH = 500;
const MAX_LABEL_LENGTH = 80;
const FLAG_ORDER = "imsu";

function canonicalFlags(value: unknown, index: number): string {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Invalid custom preserve rule ${index + 1}: flags must be a string.`);
  }
  const requested = String(value ?? "u").trim();
  for (const flag of requested) {
    if (!FLAG_ORDER.includes(flag)) {
      throw new Error(
        `Invalid custom preserve rule ${index + 1}: unsupported flag '${flag}'. Use only i, m, s, or u.`
      );
    }
  }
  return [...FLAG_ORDER].filter((flag) => requested.includes(flag)).join("");
}

function canonicalRule(value: unknown, index: number): CanonicalCustomPreserveRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid custom preserve rule ${index + 1}: expected an object.`);
  }
  const input = value as Record<string, unknown>;
  const extraKeys = Object.keys(input).filter((key) => !["label", "pattern", "flags"].includes(key));
  if (extraKeys.length > 0) {
    throw new Error(
      `Invalid custom preserve rule ${index + 1}: unsupported properties ${extraKeys.join(", ")}.`
    );
  }
  if (typeof input.pattern !== "string" || !input.pattern.trim()) {
    throw new Error(`Invalid custom preserve rule ${index + 1}: pattern is required.`);
  }
  const pattern = input.pattern.trim();
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Invalid custom preserve rule ${index + 1}: pattern exceeds ${MAX_PATTERN_LENGTH} characters.`
    );
  }
  const flags = canonicalFlags(input.flags, index);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, `${flags}g`);
  } catch (error) {
    throw new Error(
      `Invalid custom preserve rule ${index + 1}: regular expression failed to compile: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (regex.test("")) {
    throw new Error(
      `Invalid custom preserve rule ${index + 1}: regular expression must not match an empty string.`
    );
  }
  const label = input.label === undefined ? "" : String(input.label).trim();
  if (label.length > MAX_LABEL_LENGTH) {
    throw new Error(
      `Invalid custom preserve rule ${index + 1}: label exceeds ${MAX_LABEL_LENGTH} characters.`
    );
  }
  return {
    ...(label ? { label } : {}),
    pattern,
    flags
  };
}

export function normalizeCustomPreserveRules(value: unknown): CanonicalCustomPreserveRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid customPreserveRules: expected an array.");
  }
  if (value.length > MAX_RULE_COUNT) {
    throw new Error(`Invalid customPreserveRules: at most ${MAX_RULE_COUNT} rules are allowed.`);
  }
  return value.map(canonicalRule);
}

export function compileCustomPreserveRule(rule: CanonicalCustomPreserveRule): RegExp {
  return new RegExp(rule.pattern, `${rule.flags}g`);
}
