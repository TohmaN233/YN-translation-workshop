import type { Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export interface ProviderModelOption {
  id: string;
  label: string;
  description?: string;
}

type PiProviderFactory = () => Provider;

const PI_PROVIDER_FACTORIES: Record<string, PiProviderFactory> = {
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
  google: googleProvider,
  groq: groqProvider,
  "moonshotai-cn": moonshotaiCnProvider,
  openai: openaiProvider,
  "openai-codex": openaiCodexProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  zai: zaiProvider
};

const CONFIG_PROVIDER_TO_PI_PROVIDER: Record<string, string> = {
  "openai-chatgpt": "openai-codex",
  "openai-api": "openai",
  "anthropic-claude": "anthropic",
  "anthropic-api": "anthropic",
  "deepseek-api": "deepseek",
  "openrouter-api": "openrouter",
  "zhipu-glm-api": "zai",
  "moonshot-kimi-api": "moonshotai-cn",
  "gemini-openai-api": "google",
  "groq-api": "groq",
  "xai-api": "xai"
};

export function resolvePiProviderId(providerId: string, configuredPiProviderId?: string): string | undefined {
  const explicit = configuredPiProviderId?.trim();
  return explicit || CONFIG_PROVIDER_TO_PI_PROVIDER[providerId];
}

export function createPinnedPiProvider(providerId: string, configuredPiProviderId?: string): Provider | undefined {
  const piProviderId = resolvePiProviderId(providerId, configuredPiProviderId);
  return piProviderId ? PI_PROVIDER_FACTORIES[piProviderId]?.() : undefined;
}

export function normalizeExplicitModelIds(model: string | undefined, modelIds: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of [model ?? "", ...(modelIds ?? [])]) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function listModelsForProvider(
  providerId: string,
  options?: { piProviderId?: string; model?: string; modelIds?: readonly string[] }
): ProviderModelOption[] {
  const provider = createPinnedPiProvider(providerId, options?.piProviderId);
  if (provider) {
    return provider.getModels().map((model) => ({ id: model.id, label: model.name }));
  }
  return normalizeExplicitModelIds(options?.model, options?.modelIds)
    .map((id) => ({ id, label: id }));
}

export function getDefaultModelForProvider(
  providerId: string,
  options?: { piProviderId?: string; model?: string; modelIds?: readonly string[] }
): string {
  return listModelsForProvider(providerId, options)[0]?.id ?? "";
}

export function normalizeProviderModel(
  providerId: string,
  model: string | undefined,
  options?: { piProviderId?: string; modelIds?: readonly string[] }
): string {
  const trimmed = model?.trim() ?? "";
  if (trimmed) return trimmed;
  return getDefaultModelForProvider(providerId, { ...options, model: trimmed });
}
