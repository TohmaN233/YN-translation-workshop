import type { OpenAiCompatibleProviderConfig, ProviderAuthKind, ProviderDescriptor } from "../../shared/agent/providerConfigTypes.ts";
import { createPinnedPiProvider, resolvePiProviderId } from "./providerModels.ts";
import { modelShowsThinkingPicker } from "./thinkingLevels.ts";

/** Pi-style provider catalog — OAuth-first, API key optional. CLI is not an agent runtime. */

export type ProviderPresetAuth = "oauth_chatgpt" | "oauth_claude" | "oauth_grok" | "api_key" | "oauth_token_paste";

export interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  auth: ProviderPresetAuth;
  config: OpenAiCompatibleProviderConfig;
  /** Hide from default Agent session picker (legacy). */
  hidden?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai-chatgpt",
    name: "ChatGPT (OAuth)",
    description: "Sign in with ChatGPT Plus/Pro using the subscription OAuth endpoint.",
    auth: "oauth_chatgpt",
    config: {
      id: "openai-chatgpt",
      type: "openai_compatible",
      name: "ChatGPT (OAuth)",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.5",
      piProviderId: "openai-codex",
      thinkingLevel: "medium"
    }
  },
  {
    id: "xai-grok",
    name: "Grok (OAuth)",
    description: "Sign in with SuperGrok or X Premium+ using official Grok OAuth.",
    auth: "oauth_grok",
    config: {
      id: "xai-grok",
      type: "openai_compatible",
      name: "Grok (OAuth)",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
      piProviderId: "xai"
    }
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    description: "Platform API key (usage-based billing at api.openai.com).",
    auth: "api_key",
    config: {
      id: "openai-api",
      type: "openai_compatible",
      name: "OpenAI API",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      piProviderId: "openai"
    }
  },
  {
    id: "anthropic-claude",
    name: "Claude (OAuth)",
    description: "Anthropic subscription OAuth token import.",
    auth: "oauth_claude",
    config: {
      id: "anthropic-claude",
      type: "openai_compatible",
      name: "Claude (OAuth)",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-20250514",
      piProviderId: "anthropic"
    }
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Claude via platform API key from console.anthropic.com.",
    auth: "api_key",
    config: {
      id: "anthropic-api",
      type: "openai_compatible",
      name: "Anthropic API",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-20250514",
      piProviderId: "anthropic"
    }
  },
  {
    id: "deepseek-api",
    name: "DeepSeek API",
    description: "DeepSeek official OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "deepseek-api",
      type: "openai_compatible",
      name: "DeepSeek API",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      piProviderId: "deepseek"
    }
  },
  {
    id: "openrouter-api",
    name: "OpenRouter",
    description: "OpenRouter OpenAI-compatible gateway.",
    auth: "api_key",
    config: {
      id: "openrouter-api",
      type: "openai_compatible",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4.1-mini",
      piProviderId: "openrouter"
    }
  },
  {
    id: "zhipu-glm-api",
    name: "Zhipu GLM",
    description: "Zhipu AI / BigModel OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "zhipu-glm-api",
      type: "openai_compatible",
      name: "Zhipu GLM",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.2",
      piProviderId: "zai"
    }
  },
  {
    id: "qwen-dashscope-api",
    name: "Qwen DashScope",
    description: "Alibaba Cloud DashScope OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "qwen-dashscope-api",
      type: "openai_compatible",
      name: "Qwen DashScope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      models: ["qwen-plus"]
    }
  },
  {
    id: "moonshot-kimi-api",
    name: "Moonshot Kimi",
    description: "Moonshot AI OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "moonshot-kimi-api",
      type: "openai_compatible",
      name: "Moonshot Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.5",
      piProviderId: "moonshotai-cn"
    }
  },
  {
    id: "gemini-openai-api",
    name: "Gemini OpenAI-compatible",
    description: "Google Gemini OpenAI-compatible endpoint.",
    auth: "api_key",
    config: {
      id: "gemini-openai-api",
      type: "openai_compatible",
      name: "Gemini OpenAI-compatible",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-pro",
      piProviderId: "google"
    }
  },
  {
    id: "groq-api",
    name: "Groq",
    description: "Groq OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "groq-api",
      type: "openai_compatible",
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      piProviderId: "groq"
    }
  },
  {
    id: "xai-api",
    name: "xAI",
    description: "xAI OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "xai-api",
      type: "openai_compatible",
      name: "xAI",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-code-fast-1",
      piProviderId: "xai"
    }
  },
  {
    id: "siliconflow-api",
    name: "SiliconFlow",
    description: "SiliconFlow OpenAI-compatible API.",
    auth: "api_key",
    config: {
      id: "siliconflow-api",
      type: "openai_compatible",
      name: "SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V3",
      models: ["deepseek-ai/DeepSeek-V3"]
    }
  },
  {
    id: "custom-api",
    name: "Custom OpenAI-compatible",
    description: "Any OpenAI-compatible endpoint (local model, proxy, third-party).",
    auth: "api_key",
    config: {
      id: "custom-api",
      type: "openai_compatible",
      name: "Custom API",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      models: ["gpt-4.1"]
    }
  }
];

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

function authModesForPreset(preset: ProviderPreset): ProviderAuthKind[] {
  if (preset.auth === "oauth_chatgpt" || preset.auth === "oauth_claude" || preset.auth === "oauth_grok") {
    return ["oauth"];
  }
  if (preset.auth === "oauth_token_paste") {
    return ["api_key", "oauth"];
  }
  return ["api_key"];
}

function cacheStrategyForProvider(id: string): "none" | "prompt_cache_key" | "anthropic_cache_control" {
  if (id === "anthropic-api" || id === "anthropic-claude") {
    return "anthropic_cache_control";
  }
  return "prompt_cache_key";
}

function defaultModelShowsThinkingPicker(preset: ProviderPreset): boolean {
  const provider = createPinnedPiProvider(preset.id, preset.config.piProviderId);
  const catalogModel = provider?.getModels().find((model) => model.id === preset.config.model);
  return modelShowsThinkingPicker(catalogModel ?? { id: preset.config.model });
}

export function getProviderDescriptor(id: string): ProviderDescriptor | undefined {
  const preset = getProviderPreset(id);
  if (!preset) {
    return undefined;
  }
  const cacheStrategy = cacheStrategyForProvider(preset.id);
  return {
    id: preset.id,
    name: preset.name,
    type: preset.config.type,
    requiresAuth: !preset.hidden,
    description: preset.description,
    defaultModel: preset.config.model,
    capabilities: {
      authModes: authModesForPreset(preset),
      cacheStrategy,
      supportsPromptCache: cacheStrategy !== "none",
      supportsReasoning: defaultModelShowsThinkingPicker(preset),
      modelSource: resolvePiProviderId(preset.id, preset.config.piProviderId) ? "pi_registry" : "explicit"
    }
  };
}

export function isChatGptOAuthProvider(config: OpenAiCompatibleProviderConfig | undefined): boolean {
  return config?.id === "openai-chatgpt"
    || (config?.baseUrl ?? "").includes("chatgpt.com/backend-api");
}

export function isClaudeOAuthProvider(config: OpenAiCompatibleProviderConfig | undefined): boolean {
  return config?.id === "anthropic-claude";
}

export function isGrokOAuthProvider(config: OpenAiCompatibleProviderConfig | undefined): boolean {
  return config?.id === "xai-grok";
}

export function isAnthropicProvider(config: OpenAiCompatibleProviderConfig | undefined): boolean {
  return config?.id === "anthropic-api"
    || config?.id === "anthropic-claude"
    || (config?.baseUrl ?? "").includes("api.anthropic.com");
}

export function isOAuthPresetAuth(auth: ProviderPresetAuth | undefined): boolean {
  return auth === "oauth_chatgpt" || auth === "oauth_claude" || auth === "oauth_grok";
}
