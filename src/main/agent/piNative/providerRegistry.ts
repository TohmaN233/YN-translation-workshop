import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Api,
  type Credential,
  type Model,
  type Models,
  type Provider
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  OpenAiCompatibleProviderConfig,
  ProviderConfigDocument
} from "../../../shared/agent/providerConfigTypes.ts";
import {
  createPinnedPiProvider,
  normalizeExplicitModelIds,
  resolvePiProviderId
} from "../../../shared/agent/providerModels.ts";
import { isGrokOAuthProvider } from "../../../shared/agent/providerPresets.ts";
import { applyKnownThinkingContract, listThinkingLevelsForModel } from "../../../shared/agent/thinkingLevels.ts";
import { resolveProviderOAuthAuth } from "../oauthAuthResolver.ts";
import { readProviderConfig } from "../providerConfigStore.ts";
import { resolveProviderProxyUrl, runWithProviderProxy } from "../providers/proxyFetch.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface PiModelSelection {
  models: Models;
  model: Model<Api>;
  providerId: string;
  modelId: string;
}

export interface PiConfiguredModel {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  authenticated: boolean;
  supportsImages: boolean;
  thinkingLevels: ReturnType<typeof listThinkingLevelsForModel>;
}

function providerWorkspaceDir(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  return path.basename(resolved).toLowerCase() === ".translation-workshop"
    ? resolved
    : path.join(resolved, ".translation-workshop");
}

function toExpires(value: string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

interface PiCredentialDocument {
  filePath: string;
  entries: Record<string, unknown>;
}

async function readPiCredentialDocument(): Promise<PiCredentialDocument | undefined> {
  const filePath = path.join(piAgentDir(), "auth.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error(`Failed to read Pi credentials ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to read Pi credentials ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Pi credentials ${filePath}: expected a JSON object.`);
  }
  return { filePath, entries: parsed as Record<string, unknown> };
}

function credentialFromPiDocument(
  document: PiCredentialDocument | undefined,
  providerId: string,
  configuredPiProviderId?: string
): Credential | undefined {
  if (!document) return undefined;
  const piProviderId = resolvePiProviderId(providerId, configuredPiProviderId);
  if (!piProviderId) return undefined;
  const { filePath, entries } = document;
  const value = entries[piProviderId];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Pi credential ${filePath} for ${piProviderId}: expected an object.`);
  }
  const credential = value as Partial<Credential> & Record<string, unknown>;
  if (credential.type === "api_key") {
    if (credential.key !== undefined && typeof credential.key !== "string") {
      throw new Error(`Invalid Pi credential ${filePath} for ${piProviderId}: API key must be a string.`);
    }
    return { type: "api_key", key: credential.key };
  }
  if (credential.type === "oauth") {
    if (typeof credential.access !== "string" || !credential.access.trim()) {
      throw new Error(`Invalid Pi credential ${filePath} for ${piProviderId}: OAuth access token is required.`);
    }
    return {
      type: "oauth",
      access: credential.access,
      refresh: typeof credential.refresh === "string" ? credential.refresh : "",
      expires: typeof credential.expires === "number" && Number.isFinite(credential.expires)
        ? credential.expires
        : Number.MAX_SAFE_INTEGER
    };
  }
  throw new Error(`Invalid Pi credential ${filePath} for ${piProviderId}: unsupported credential type.`);
}

export async function readPiLocalOAuthCredential(
  providerId: string,
  configuredPiProviderId?: string
): Promise<Extract<Credential, { type: "oauth" }> | undefined> {
  const credential = credentialFromPiDocument(await readPiCredentialDocument(), providerId, configuredPiProviderId);
  return credential?.type === "oauth" ? credential : undefined;
}

async function credentialFor(
  workspaceDir: string,
  config: OpenAiCompatibleProviderConfig,
  options?: { refresh?: boolean }
): Promise<Credential | undefined> {
  if (config.enabled === false) return undefined;
  if (config.auth?.kind === "api_key" && config.auth.key.trim()) {
    return { type: "api_key", key: config.auth.key.trim() };
  }
  if (config.auth?.kind === "oauth") {
    const resolved = await resolveProviderOAuthAuth(config, workspaceDir, options);
    const auth = resolved.auth ?? (resolved.token
      ? {
          kind: "oauth" as const,
          accessToken: resolved.token,
          refreshToken: config.auth?.kind === "oauth" ? config.auth.refreshToken : undefined,
          expiresAt: config.auth?.kind === "oauth" ? config.auth.expiresAt : undefined
        }
      : undefined);
    if (auth?.accessToken) {
      if (isGrokOAuthProvider(config)) {
        console.info("[grok-oauth]", "handing refreshed access token to Pi as API key", {
          providerId: config.id,
          expiresAt: auth.expiresAt
        });
        return { type: "api_key", key: auth.accessToken };
      }
      return {
        type: "oauth",
        access: auth.accessToken,
        refresh: auth.refreshToken ?? "",
        expires: toExpires(auth.expiresAt)
      };
    }
  }
  return undefined;
}

function aliasProvider(source: Provider, config: OpenAiCompatibleProviderConfig): Provider {
  const configuredBaseUrl = config.baseUrl.trim();
  const remap = (model: Model<Api>): Model<Api> => applyKnownThinkingContract({
    ...model,
    provider: config.id,
    baseUrl: configuredBaseUrl || model.baseUrl
  });
  const catalog = source.getModels().map((model) => remap(model as Model<Api>));
  if (isGrokOAuthProvider(config)) {
    const existing = new Set(catalog.map((model) => model.id));
    const extras = normalizeExplicitModelIds(config.model, config.models).filter((id) => !existing.has(id));
    const template = catalog.find((model) => model.id.startsWith("grok-4")) ?? catalog[0];
    if (extras.length > 0 && !template) {
      throw new Error(`Grok (OAuth) has no Pi xAI catalog model to clone for ${extras.join(", ")}.`);
    }
    if (extras.length > 0 && template) {
      for (const id of extras) {
        catalog.push(applyKnownThinkingContract({ ...template, id, name: id }));
      }
    }
  }
  return {
    id: config.id,
    name: config.name,
    baseUrl: configuredBaseUrl || source.baseUrl,
    headers: source.headers,
    auth: source.auth,
    getModels: () => catalog,
    refreshModels: source.refreshModels ? async () => source.refreshModels?.() : undefined,
    stream: (model, context, options) => source.stream(model, context, options),
    streamSimple: (model, context, options) => source.streamSimple(model, context, options)
  };
}

function customOpenAiProvider(config: OpenAiCompatibleProviderConfig): Provider {
  const models = normalizeExplicitModelIds(config.model, config.models)
    .map((modelId) => applyKnownThinkingContract({
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      provider: config.id,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: (config.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS
    }));
  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.name} API key`, []) },
    models,
    api: openAICompletionsApi()
  });
}

function providerFor(config: OpenAiCompatibleProviderConfig): Provider {
  const piProvider = createPinnedPiProvider(config.id, config.piProviderId);
  if (piProvider) return aliasProvider(piProvider, config);
  return customOpenAiProvider(config);
}

function withNetworkProxy(source: Provider, proxyUrl: string): Provider {
  if (!proxyUrl) return source;
  return {
    ...source,
    stream: (model, context, options) => runWithProviderProxy(
      proxyUrl,
      () => source.stream(model, context, options)
    ),
    streamSimple: (model, context, options) => runWithProviderProxy(
      proxyUrl,
      () => source.streamSimple(model, context, options)
    )
  };
}

async function createPiRegistry(projectDir: string, options?: {
  refreshProviderId?: string;
}): Promise<{
  config: ProviderConfigDocument;
  models: Models;
  authenticatedProviders: Set<string>;
  credentialErrors: Map<string, unknown>;
}> {
  const workspaceDir = providerWorkspaceDir(projectDir);
  const config = await readProviderConfig(workspaceDir);
  const proxyUrl = await resolveProviderProxyUrl({ workspaceDir });
  const credentialStore = new InMemoryCredentialStore();
  const models = createModels({ credentials: credentialStore });
  const authenticatedProviders = new Set<string>();
  const credentialErrors = new Map<string, unknown>();
  for (const stored of Object.values(config.providers)) {
    models.setProvider(withNetworkProxy(providerFor(stored), proxyUrl));
    try {
      const credential = await credentialFor(workspaceDir, stored, {
        refresh: options?.refreshProviderId === stored.id
      });
      if (credential) {
        await credentialStore.modify(stored.id, async () => credential);
        authenticatedProviders.add(stored.id);
      }
    } catch (error) {
      credentialErrors.set(stored.id, error);
      console.error("[provider-registry] credential resolution failed", {
        providerId: stored.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { config, models, authenticatedProviders, credentialErrors };
}

export async function listPiConfiguredModels(projectDir: string): Promise<PiConfiguredModel[]> {
  const { config, models, authenticatedProviders } = await createPiRegistry(projectDir);
  const entries: PiConfiguredModel[] = [];
  for (const provider of models.getProviders()) {
    const configured = config.providers[provider.id];
    if (!configured) continue;
    const providerModels = models.getModels(provider.id);
    const authenticated = authenticatedProviders.has(provider.id);
    for (const model of providerModels) {
      entries.push({
        providerId: provider.id,
        providerName: configured.name,
        modelId: model.id,
        modelName: model.name,
        authenticated,
        supportsImages: model.input.includes("image"),
        thinkingLevels: listThinkingLevelsForModel(model)
      });
    }
  }
  return entries;
}

export async function listPiProviderModels(projectDir: string, providerId: string) {
  const workspaceDir = providerWorkspaceDir(projectDir);
  const config = await readProviderConfig(workspaceDir);
  const stored = config.providers[providerId];
  if (!stored) return [];
  return providerFor(stored).getModels().map((model) => ({
    id: model.id,
    label: model.name,
    supportsImages: model.input.includes("image")
  }));
}

export async function createPiModelSelection(args: {
  workspaceDir: string;
  providerId?: string;
  modelId?: string;
}): Promise<PiModelSelection> {
  const requestedProviderId = args.providerId?.trim()
    || (await readProviderConfig(providerWorkspaceDir(args.workspaceDir))).activeProviderId;
  const { config: configDocument, models, authenticatedProviders, credentialErrors } = await createPiRegistry(
    args.workspaceDir,
    { refreshProviderId: requestedProviderId }
  );
  const providerId = requestedProviderId;
  const selectedConfig = configDocument.providers[providerId];
  if (!selectedConfig) {
    throw new Error(`Provider ${providerId || "(none)"} is not configured.`);
  }
  if (selectedConfig.enabled === false) {
    throw new Error(`Provider ${selectedConfig.name} is not enabled.`);
  }
  const credentialError = credentialErrors.get(providerId);
  if (credentialError) {
    throw credentialError instanceof Error ? credentialError : new Error(String(credentialError));
  }
  if (!authenticatedProviders.has(providerId)) {
    throw new Error(`Provider ${selectedConfig.name} is not authenticated.`);
  }

  const modelId = args.modelId?.trim() || selectedConfig.model;
  const model = models.getModel(providerId, modelId);
  if (!model) {
    const available = models.getModels(providerId).map((item) => item.id).join(", ");
    throw new Error(`Model ${providerId}/${modelId} is unavailable. Configured models: ${available || "none"}.`);
  }
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error(`Provider ${selectedConfig.name} is not authenticated.`);
  }
  return { models, model, providerId, modelId };
}
