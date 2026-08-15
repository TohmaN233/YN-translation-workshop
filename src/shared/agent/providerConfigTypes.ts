import type { ThinkingLevel } from "./thinkingLevels.ts";

/** Provider credential — Pi-style api_key | oauth per provider id. */
export type ProviderAuthKind = "api_key" | "oauth";

export interface ProviderApiKeyAuth {
  kind: "api_key";
  key: string;
}

export interface ProviderOAuthAuth {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  /** ChatGPT account id for the subscription `chatgpt-account-id` header (from JWT or import). */
  accountId?: string;
}

export type ProviderAuth = ProviderApiKeyAuth | ProviderOAuthAuth;

export interface OpenAiCompatibleProviderConfig {
  id: string;
  /** Preset family used by a saved named profile (for example, custom-api). */
  presetId?: string;
  type: "openai_compatible";
  name: string;
  baseUrl: string;
  model: string;
  /** Pinned Pi provider whose runtime and generated model registry back this configuration. */
  piProviderId?: string;
  /** Explicit model ids for endpoints that do not have a native Pi provider. */
  models?: string[];
  /** User-declared image input support for explicit Custom API model ids. */
  supportsImages?: boolean;
  /** Pi-style reasoning effort for subscription OAuth, including max when the selected model supports it. */
  thinkingLevel?: ThinkingLevel;
  /** False keeps the complete saved profile while excluding it from Pi's active model catalog. */
  enabled?: boolean;
  auth?: ProviderAuth;
}

export type StoredProviderConfig = OpenAiCompatibleProviderConfig;

export interface ProviderConfigDocument {
  activeProviderId: string;
  providers: Record<string, StoredProviderConfig>;
}

export interface ProviderDescriptor {
  id: string;
  presetId?: string;
  name: string;
  type: "openai_compatible";
  /** Whether the user must supply API/OAuth credentials in settings. */
  requiresAuth?: boolean;
  description?: string;
  defaultModel?: string;
  enabled?: boolean;
  models?: Array<{ id: string; label: string; description?: string }>;
  capabilities?: {
    authModes: ProviderAuthKind[];
    cacheStrategy: "none" | "prompt_cache_key" | "anthropic_cache_control";
    supportsPromptCache: boolean;
    supportsReasoning: boolean;
    modelSource?: "pi_registry" | "explicit";
  };
}
