import type { Api, Model } from "@earendil-works/pi-ai";

// One-time migration input generated from the official Pi 0.80.6 catalog:
// only IDs removed by 0.99.1. Never used as a current model list; records are
// activated only when the user already explicitly configured the same ID.
export const PI_LEGACY_CONFIGURED_MODELS = {
  "anthropic": [
    {
      "id": "claude-opus-4-1",
      "name": "Claude Opus 4.1 (latest)",
      "api": "anthropic-messages",
      "provider": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      },
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    {
      "id": "claude-opus-4-1-20250805",
      "name": "Claude Opus 4.1",
      "api": "anthropic-messages",
      "provider": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      },
      "contextWindow": 200000,
      "maxTokens": 32000
    }
  ],
  "deepseek": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "api": "openai-completions",
      "provider": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "requiresReasoningContentOnAssistantMessages": true,
        "thinkingFormat": "deepseek"
      },
      "reasoning": true,
      "thinkingLevelMap": {
        "minimal": null,
        "low": null,
        "medium": null,
        "high": "high",
        "max": "max"
      },
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.14,
        "output": 0.28,
        "cacheRead": 0.0028,
        "cacheWrite": 0
      },
      "contextWindow": 1000000,
      "maxTokens": 384000
    }
  ],
  "google": [
    {
      "id": "gemini-2.0-flash",
      "name": "Gemini 2.0 Flash",
      "api": "google-generative-ai",
      "provider": "google",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.1,
        "output": 0.4,
        "cacheRead": 0.025,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    {
      "id": "gemini-2.0-flash-lite",
      "name": "Gemini 2.0 Flash-Lite",
      "api": "google-generative-ai",
      "provider": "google",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.075,
        "output": 0.3,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    {
      "id": "gemini-3-pro-preview",
      "name": "Gemini 3 Pro Preview",
      "api": "google-generative-ai",
      "provider": "google",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null,
        "minimal": null,
        "low": "LOW",
        "medium": null,
        "high": "HIGH"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 12,
        "cacheRead": 0.2,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 65536
    }
  ],
  "groq": [
    {
      "id": "meta-llama/llama-4-scout-17b-16e-instruct",
      "name": "Llama 4 Scout 17B 16E",
      "api": "openai-completions",
      "provider": "groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.11,
        "output": 0.34,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    {
      "id": "qwen/qwen3-32b",
      "name": "Qwen3-32B",
      "api": "openai-completions",
      "provider": "groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "minimal": null,
        "low": null,
        "medium": null,
        "high": "default"
      },
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.29,
        "output": 0.59,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 40960
    }
  ],
  "moonshotai-cn": [
    {
      "id": "kimi-k2-0711-preview",
      "name": "Kimi K2 0711",
      "api": "openai-completions",
      "provider": "moonshotai-cn",
      "baseUrl": "https://api.moonshot.cn/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.5,
        "cacheRead": 0.15,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    {
      "id": "kimi-k2-0905-preview",
      "name": "Kimi K2 0905",
      "api": "openai-completions",
      "provider": "moonshotai-cn",
      "baseUrl": "https://api.moonshot.cn/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.5,
        "cacheRead": 0.15,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "kimi-k2-thinking",
      "name": "Kimi K2 Thinking",
      "api": "openai-completions",
      "provider": "moonshotai-cn",
      "baseUrl": "https://api.moonshot.cn/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.6,
        "output": 2.5,
        "cacheRead": 0.15,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "kimi-k2-thinking-turbo",
      "name": "Kimi K2 Thinking Turbo",
      "api": "openai-completions",
      "provider": "moonshotai-cn",
      "baseUrl": "https://api.moonshot.cn/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 1.15,
        "output": 8,
        "cacheRead": 0.15,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "kimi-k2-turbo-preview",
      "name": "Kimi K2 Turbo",
      "api": "openai-completions",
      "provider": "moonshotai-cn",
      "baseUrl": "https://api.moonshot.cn/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 2.4,
        "output": 10,
        "cacheRead": 0.6,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "kimi-k2.5",
      "name": "Kimi K2.5",
      "api": "openai-completions",
      "provider": "moonshotai-cn",
      "baseUrl": "https://api.moonshot.cn/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.6,
        "output": 3,
        "cacheRead": 0.1,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  ],
  "openai": [
    {
      "id": "gpt-5-codex",
      "name": "GPT-5-Codex",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0
      },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    {
      "id": "gpt-5.1-chat-latest",
      "name": "GPT-5.1 Chat",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    {
      "id": "gpt-5.1-codex",
      "name": "GPT-5.1 Codex",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0
      },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    {
      "id": "gpt-5.1-codex-max",
      "name": "GPT-5.1 Codex Max",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0
      },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    {
      "id": "gpt-5.1-codex-mini",
      "name": "GPT-5.1 Codex mini",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 2,
        "cacheRead": 0.025,
        "cacheWrite": 0
      },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    {
      "id": "gpt-5.2-codex",
      "name": "GPT-5.2 Codex",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null,
        "xhigh": "xhigh"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.75,
        "output": 14,
        "cacheRead": 0.175,
        "cacheWrite": 0
      },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    {
      "id": "o3-deep-research",
      "name": "o3-deep-research",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 10,
        "output": 40,
        "cacheRead": 2.5,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    {
      "id": "o4-mini-deep-research",
      "name": "o4-mini-deep-research",
      "api": "openai-responses",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 8,
        "cacheRead": 0.5,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 100000
    }
  ],
  "openai-codex": [
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "api": "openai-codex-responses",
      "provider": "openai-codex",
      "baseUrl": "https://chatgpt.com/backend-api",
      "reasoning": true,
      "thinkingLevelMap": {
        "xhigh": "xhigh",
        "minimal": "low"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2.5,
        "output": 15,
        "cacheRead": 0.25,
        "cacheWrite": 0,
        "tiers": [
          {
            "inputTokensAbove": 272000,
            "input": 5,
            "output": 22.5,
            "cacheRead": 0.5,
            "cacheWrite": 0
          }
        ]
      },
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    {
      "id": "gpt-5.4-mini",
      "name": "GPT-5.4 mini",
      "api": "openai-codex-responses",
      "provider": "openai-codex",
      "baseUrl": "https://chatgpt.com/backend-api",
      "reasoning": true,
      "thinkingLevelMap": {
        "xhigh": "xhigh",
        "minimal": "low"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.75,
        "output": 4.5,
        "cacheRead": 0.075,
        "cacheWrite": 0
      },
      "contextWindow": 272000,
      "maxTokens": 128000
    }
  ],
  "openrouter": [
    {
      "id": "ai21/jamba-large-1.7",
      "name": "AI21: Jamba Large 1.7",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 2,
        "output": 8,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    {
      "id": "anthropic/claude-3-haiku",
      "name": "Anthropic: Claude 3 Haiku",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter",
        "cacheControlFormat": "anthropic"
      },
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 1.25,
        "cacheRead": 0.03,
        "cacheWrite": 0.3
      },
      "contextWindow": 200000,
      "maxTokens": 4096
    },
    {
      "id": "anthropic/claude-opus-4",
      "name": "Anthropic: Claude Opus 4",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter",
        "cacheControlFormat": "anthropic"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      },
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    {
      "id": "anthropic/claude-opus-4.7-fast",
      "name": "Anthropic: Claude Opus 4.7 (Fast)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter",
        "cacheControlFormat": "anthropic"
      },
      "reasoning": true,
      "thinkingLevelMap": {
        "xhigh": "xhigh",
        "max": "max"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 30,
        "output": 150,
        "cacheRead": 3,
        "cacheWrite": 37.5
      },
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    {
      "id": "anthropic/claude-opus-4.8-fast",
      "name": "Anthropic: Claude Opus 4.8 (Fast)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter",
        "cacheControlFormat": "anthropic"
      },
      "reasoning": true,
      "thinkingLevelMap": {
        "xhigh": "xhigh",
        "max": "max"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 10,
        "output": 50,
        "cacheRead": 1,
        "cacheWrite": 12.5
      },
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    {
      "id": "arcee-ai/trinity-mini",
      "name": "Arcee AI: Trinity Mini",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.045,
        "output": 0.15,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    {
      "id": "arcee-ai/virtuoso-large",
      "name": "Arcee AI: Virtuoso Large",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.75,
        "output": 1.2,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 64000
    },
    {
      "id": "google/gemini-2.5-pro-preview-05-06",
      "name": "Google: Gemini 2.5 Pro Preview 05-06",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0.375
      },
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    {
      "id": "ibm-granite/granite-4.1-8b",
      "name": "IBM: Granite 4.1 8B",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.05,
        "output": 0.1,
        "cacheRead": 0.05,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    {
      "id": "inclusionai/ling-2.6-1t",
      "name": "inclusionAI: Ling-2.6-1T",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.075,
        "output": 0.625,
        "cacheRead": 0.015,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    {
      "id": "inclusionai/ling-2.6-flash",
      "name": "inclusionAI: Ling-2.6-flash",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.01,
        "output": 0.03,
        "cacheRead": 0.002,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    {
      "id": "inclusionai/ring-2.6-1t",
      "name": "inclusionAI: Ring-2.6-1T",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.075,
        "output": 0.625,
        "cacheRead": 0.015,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    {
      "id": "kwaipilot/kat-coder-pro-v2",
      "name": "Kwaipilot: KAT-Coder-Pro V2",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.3,
        "output": 1.2,
        "cacheRead": 0.06,
        "cacheWrite": 0
      },
      "contextWindow": 256000,
      "maxTokens": 80000
    },
    {
      "id": "liquid/lfm-2.5-1.2b-thinking:free",
      "name": "LiquidAI: LFM2.5-1.2B-Thinking (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    {
      "id": "meta-llama/llama-3.3-70b-instruct:free",
      "name": "Meta: Llama 3.3 70B Instruct (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    {
      "id": "nex-agi/nex-n2-mini",
      "name": "Nex AGI: Nex-N2-Mini",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.025,
        "output": 0.1,
        "cacheRead": 0.0025,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "nex-agi/nex-n2-pro",
      "name": "Nex AGI: Nex-N2-Pro",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 1,
        "cacheRead": 0.025,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "name": "NVIDIA: Llama 3.3 Nemotron Super 49B V1.5",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.4,
        "output": 0.4,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    {
      "id": "nvidia/nemotron-3-nano-30b-a3b:free",
      "name": "NVIDIA: Nemotron 3 Nano 30B A3B (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    {
      "id": "nvidia/nemotron-nano-12b-v2-vl:free",
      "name": "NVIDIA: Nemotron Nano 12B 2 VL (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    {
      "id": "nvidia/nemotron-nano-9b-v2:free",
      "name": "NVIDIA: Nemotron Nano 9B V2 (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    {
      "id": "openai/gpt-4-turbo-preview",
      "name": "OpenAI: GPT-4 Turbo Preview",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 10,
        "output": 30,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    {
      "id": "openai/gpt-5-codex",
      "name": "OpenAI: GPT-5 Codex",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 0
      },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    {
      "id": "openai/gpt-5.1-chat",
      "name": "OpenAI: GPT-5.1 Chat",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.13,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    {
      "id": "openai/gpt-5.3-chat",
      "name": "OpenAI: GPT-5.3 Chat",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "thinkingLevelMap": {
        "xhigh": "xhigh"
      },
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.75,
        "output": 14,
        "cacheRead": 0.175,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    {
      "id": "openai/gpt-oss-120b:free",
      "name": "OpenAI: gpt-oss-120b (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    {
      "id": "openai/gpt-oss-20b:free",
      "name": "OpenAI: gpt-oss-20b (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    {
      "id": "openai/o3-deep-research",
      "name": "OpenAI: o3 Deep Research",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 10,
        "output": 40,
        "cacheRead": 2.5,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    {
      "id": "openai/o4-mini-deep-research",
      "name": "OpenAI: o4 Mini Deep Research",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 2,
        "output": 8,
        "cacheRead": 0.5,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    {
      "id": "poolside/laguna-m.1",
      "name": "Poolside: Laguna M.1",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.2,
        "output": 0.4,
        "cacheRead": 0.1,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    {
      "id": "poolside/laguna-m.1:free",
      "name": "Poolside: Laguna M.1 (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    {
      "id": "qwen/qwen-plus-2025-07-28:thinking",
      "name": "Qwen: Qwen Plus 0728 (thinking)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.26,
        "output": 0.78,
        "cacheRead": 0,
        "cacheWrite": 0.325
      },
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    {
      "id": "qwen/qwen3-coder:free",
      "name": "Qwen: Qwen3 Coder 480B A35B (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 1048576,
      "maxTokens": 262000
    },
    {
      "id": "qwen/qwen3-next-80b-a3b-instruct:free",
      "name": "Qwen: Qwen3 Next 80B A3B Instruct (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 4096
    },
    {
      "id": "tencent/hy3:free",
      "name": "Tencent: Hy3 (free)",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    {
      "id": "thedrummer/unslopnemo-12b",
      "name": "TheDrummer: UnslopNemo 12B",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.4,
        "output": 0.4,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    {
      "id": "~openai/gpt-latest",
      "name": "OpenAI GPT Latest",
      "api": "openai-completions",
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "openrouter"
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 30,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      },
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  ],
  "xai": [
    {
      "id": "grok-3",
      "name": "Grok 3",
      "api": "openai-completions",
      "provider": "xai",
      "baseUrl": "https://api.x.ai/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.75,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    {
      "id": "grok-3-fast",
      "name": "Grok 3 Fast",
      "api": "openai-completions",
      "provider": "xai",
      "baseUrl": "https://api.x.ai/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 5,
        "output": 25,
        "cacheRead": 1.25,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    {
      "id": "grok-4.20-0309-non-reasoning",
      "name": "Grok 4.20 (Non-Reasoning)",
      "api": "openai-completions",
      "provider": "xai",
      "baseUrl": "https://api.x.ai/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "reasoning": false,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 2.5,
        "cacheRead": 0.2,
        "cacheWrite": 0
      },
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    {
      "id": "grok-4.20-0309-reasoning",
      "name": "Grok 4.20 (Reasoning)",
      "api": "openai-completions",
      "provider": "xai",
      "baseUrl": "https://api.x.ai/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1.25,
        "output": 2.5,
        "cacheRead": 0.2,
        "cacheWrite": 0
      },
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    {
      "id": "grok-build-0.1",
      "name": "Grok Build 0.1",
      "api": "openai-completions",
      "provider": "xai",
      "baseUrl": "https://api.x.ai/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1,
        "output": 2,
        "cacheRead": 0.2,
        "cacheWrite": 0
      },
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    {
      "id": "grok-code-fast-1",
      "name": "Grok Code Fast 1",
      "api": "openai-completions",
      "provider": "xai",
      "baseUrl": "https://api.x.ai/v1",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "reasoning": false,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0.2,
        "output": 1.5,
        "cacheRead": 0.02,
        "cacheWrite": 0
      },
      "contextWindow": 32768,
      "maxTokens": 8192
    }
  ],
  "zai": [
    {
      "id": "glm-4.5-air",
      "name": "GLM-4.5-Air",
      "api": "openai-completions",
      "provider": "zai",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "zai"
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    {
      "id": "glm-5.1",
      "name": "GLM-5.1",
      "api": "openai-completions",
      "provider": "zai",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "zai",
        "zaiToolStream": true
      },
      "reasoning": true,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    {
      "id": "glm-5v-turbo",
      "name": "GLM-5V-Turbo",
      "api": "openai-completions",
      "provider": "zai",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "zai",
        "zaiToolStream": true
      },
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 200000,
      "maxTokens": 131072
    }
  ]
} as Record<string, Model<Api>[]>;
