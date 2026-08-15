import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  OpenAiCompatibleProviderConfig,
  ProviderConfigDocument,
  ProviderDescriptor,
  StoredProviderConfig
} from "../../shared/agent/providerConfigTypes.ts";
import { getProviderDescriptor, PROVIDER_PRESETS } from "../../shared/agent/providerPresets.ts";
import { resolvePiProviderId } from "../../shared/agent/providerModels.ts";
import {
  agentDataDir,
  legacyAgentDataDir,
  usesGlobalAgentDataDir
} from "./agentDataDir.ts";

const CONFIG_FILE = "provider-config.json";
const CUSTOM_TEMPLATE_ID = "custom-api";

const LEGACY_PRESET_BASE_URLS: Record<string, string[]> = {
  "openai-chatgpt": ["https://chatgpt.com/backend-api/codex"],
  "anthropic-claude": ["https://api.anthropic.com/v1"],
  "anthropic-api": ["https://api.anthropic.com/v1"],
  "gemini-openai-api": ["https://generativelanguage.googleapis.com/v1beta/openai"]
};

const LEGACY_PRESET_MODELS: Record<string, string[]> = {
  "moonshot-kimi-api": ["moonshot-v1-32k"]
};

function defaultDocument(): ProviderConfigDocument {
  const providers: Record<string, StoredProviderConfig> = {};
  for (const preset of PROVIDER_PRESETS) {
    providers[preset.id] = { ...preset.config };
  }
  return {
    activeProviderId: "openai-chatgpt",
    providers
  };
}

function configPath(workspaceDir: string): string {
  return path.join(agentDataDir(workspaceDir), CONFIG_FILE);
}

function legacyConfigPath(workspaceDir: string): string {
  return path.join(legacyAgentDataDir(workspaceDir), CONFIG_FILE);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function configReadError(filePath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Failed to read provider config ${filePath}: ${detail}`);
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

function validateProviderRecord(id: string, value: unknown, filePath: string): StoredProviderConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" must be an object.`);
  }
  const provider = value as Partial<StoredProviderConfig> & Record<string, unknown>;
  const providerType: unknown = (value as Record<string, unknown>).type;
  if (provider.id !== id) {
    throw new Error(`Invalid provider config ${filePath}: provider key "${id}" must match its id.`);
  }
  if (providerType === "cli") {
    return undefined;
  }
  if (providerType !== "openai_compatible") {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" has an unsupported type.`);
  }
  for (const field of ["name", "baseUrl", "model"] as const) {
    if (typeof provider[field] !== "string") {
      throw new Error(`Invalid provider config ${filePath}: provider "${id}" field "${field}" must be a string.`);
    }
  }
  if (provider.piProviderId !== undefined && typeof provider.piProviderId !== "string") {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" piProviderId must be a string.`);
  }
  if (provider.presetId !== undefined && typeof provider.presetId !== "string") {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" presetId must be a string.`);
  }
  if (provider.enabled !== undefined && typeof provider.enabled !== "boolean") {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" enabled must be a boolean.`);
  }
  if (provider.supportsImages !== undefined && typeof provider.supportsImages !== "boolean") {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" supportsImages must be a boolean.`);
  }
  if (provider.models !== undefined && (
    !Array.isArray(provider.models) || provider.models.some((model) => typeof model !== "string")
  )) {
    throw new Error(`Invalid provider config ${filePath}: provider "${id}" models must be string ids.`);
  }
  const auth = provider.auth;
  if (auth !== undefined) {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      throw new Error(`Invalid provider config ${filePath}: provider "${id}" auth must be an object.`);
    }
    if (auth.kind === "api_key" && typeof auth.key !== "string") {
      throw new Error(`Invalid provider config ${filePath}: provider "${id}" API key must be a string.`);
    }
    if (auth.kind === "oauth" && typeof auth.accessToken !== "string") {
      throw new Error(`Invalid provider config ${filePath}: provider "${id}" OAuth access token must be a string.`);
    }
    if (auth.kind !== "api_key" && auth.kind !== "oauth") {
      throw new Error(`Invalid provider config ${filePath}: provider "${id}" has an unsupported auth kind.`);
    }
  }
  return provider as OpenAiCompatibleProviderConfig;
}

function customProfileId(provider: StoredProviderConfig): string {
  const slug = provider.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "profile";
  const fingerprint = createHash("sha256")
    .update(`${provider.name.trim()}\n${provider.baseUrl.trim()}`)
    .digest("hex")
    .slice(0, 8);
  return `${CUSTOM_TEMPLATE_ID}:${slug}-${fingerprint}`;
}

function isCustomizedTemplate(saved: StoredProviderConfig, template: StoredProviderConfig): boolean {
  return Boolean(saved.auth)
    || saved.name !== template.name
    || saved.baseUrl !== template.baseUrl
    || saved.model !== template.model
    || JSON.stringify(saved.models ?? []) !== JSON.stringify(template.models ?? [])
    || saved.supportsImages !== template.supportsImages;
}

function migrateLegacyCustomTemplate(
  parsed: ProviderConfigDocument,
  defaults: ProviderConfigDocument
): { document: ProviderConfigDocument; changed: boolean } {
  const saved = parsed.providers[CUSTOM_TEMPLATE_ID];
  const template = defaults.providers[CUSTOM_TEMPLATE_ID];
  if (!saved || !template || !isCustomizedTemplate(saved, template)) {
    return { document: parsed, changed: false };
  }
  const id = customProfileId(saved);
  const profile: StoredProviderConfig = {
    ...saved,
    id,
    presetId: CUSTOM_TEMPLATE_ID,
    enabled: saved.enabled ?? true
  };
  return {
    changed: true,
    document: {
      activeProviderId: parsed.activeProviderId === CUSTOM_TEMPLATE_ID ? id : parsed.activeProviderId,
      providers: {
        ...parsed.providers,
        [CUSTOM_TEMPLATE_ID]: { ...template, enabled: false },
        [id]: profile
      }
    }
  };
}

function validateDocument(value: unknown, filePath: string): ProviderConfigDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid provider config ${filePath}: expected a JSON object.`);
  }
  const record = value as Partial<ProviderConfigDocument>;
  if (!record.providers || typeof record.providers !== "object" || Array.isArray(record.providers)) {
    throw new Error(`Invalid provider config ${filePath}: "providers" must be an object.`);
  }
  if (record.activeProviderId !== undefined && typeof record.activeProviderId !== "string") {
    throw new Error(`Invalid provider config ${filePath}: "activeProviderId" must be a string.`);
  }
  const providers: Record<string, StoredProviderConfig> = {};
  for (const [id, provider] of Object.entries(record.providers as Record<string, unknown>)) {
    const validated = validateProviderRecord(id, provider, filePath);
    if (validated) providers[id] = validated;
  }
  return {
    activeProviderId: record.activeProviderId ?? "",
    providers
  };
}

function mergePresetProvider(
  id: string,
  defaultProvider: OpenAiCompatibleProviderConfig,
  saved: OpenAiCompatibleProviderConfig
): OpenAiCompatibleProviderConfig {
  const merged = {
    ...defaultProvider,
    ...saved,
    piProviderId: saved.piProviderId ?? defaultProvider.piProviderId,
    models: saved.models ?? (saved.model ? [saved.model] : defaultProvider.models)
  };
  if (LEGACY_PRESET_BASE_URLS[id]?.includes(saved.baseUrl)) {
    merged.baseUrl = defaultProvider.baseUrl;
  }
  if (LEGACY_PRESET_MODELS[id]?.includes(saved.model)) {
    merged.model = defaultProvider.model;
  }
  return merged;
}

export async function readProviderConfig(workspaceDir: string): Promise<ProviderConfigDocument> {
  await mkdir(agentDataDir(workspaceDir), { recursive: true });
  const defaults = defaultDocument();
  const filePath = configPath(workspaceDir);
  let sourceFilePath = filePath;
  let raw: string;
  let migratedFromLegacy = false;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw configReadError(filePath, error);
    if (!usesGlobalAgentDataDir()) return defaults;
    const legacyPath = legacyConfigPath(workspaceDir);
    try {
      raw = await readFile(legacyPath, "utf8");
      sourceFilePath = legacyPath;
      migratedFromLegacy = true;
    } catch (legacyError) {
      if (isMissingFile(legacyError)) return defaults;
      throw configReadError(legacyPath, legacyError);
    }
  }

  let parsed: ProviderConfigDocument;
  try {
    parsed = validateDocument(JSON.parse(raw) as unknown, sourceFilePath);
  } catch (error) {
    if (error instanceof Error && error.message.includes(sourceFilePath)) throw error;
    throw configReadError(sourceFilePath, error);
  }

  const migrated = migrateLegacyCustomTemplate(parsed, defaults);
  parsed = migrated.document;
  if (migrated.changed || migratedFromLegacy) {
    await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");
  }
  const mergedProviders: Record<string, StoredProviderConfig> = { ...parsed.providers };
  for (const [id, defaultProvider] of Object.entries(defaults.providers)) {
    const saved = parsed.providers[id];
    mergedProviders[id] = saved ? mergePresetProvider(id, defaultProvider, saved) : defaultProvider;
  }
  return {
    activeProviderId: parsed.activeProviderId === "codex-cli" || parsed.activeProviderId === "claude-cli"
      ? "openai-chatgpt"
      : (parsed.activeProviderId || defaults.activeProviderId),
    providers: mergedProviders
  };
}

export async function writeProviderConfig(workspaceDir: string, doc: ProviderConfigDocument): Promise<void> {
  await mkdir(agentDataDir(workspaceDir), { recursive: true });
  await writeFile(configPath(workspaceDir), JSON.stringify(doc, null, 2), "utf8");
}

export async function updateProviderConfig(
  workspaceDir: string,
  patch: Partial<Pick<ProviderConfigDocument, "activeProviderId">> & {
    provider?: StoredProviderConfig;
  }
): Promise<ProviderConfigDocument> {
  const current = await readProviderConfig(workspaceDir);
  const next: ProviderConfigDocument = {
    activeProviderId: patch.activeProviderId ?? current.activeProviderId,
    providers: { ...current.providers }
  };
  if (patch.provider) {
    next.providers[patch.provider.id] = patch.provider;
    if (!next.activeProviderId) {
      next.activeProviderId = patch.provider.id;
    }
  }
  await writeProviderConfig(workspaceDir, next);
  return next;
}

function firstEnabledProviderId(doc: ProviderConfigDocument, excludedId?: string): string {
  return Object.values(doc.providers).find((provider) => (
    provider.id !== excludedId && provider.enabled !== false && Boolean(resolveAuthToken(provider.auth))
  ))?.id ?? "openai-chatgpt";
}

export async function saveProviderProfile(
  workspaceDir: string,
  provider: StoredProviderConfig
): Promise<ProviderConfigDocument> {
  const isNewCustomProfile = provider.id === CUSTOM_TEMPLATE_ID;
  const savedProvider: StoredProviderConfig = isNewCustomProfile
    ? {
        ...provider,
        id: customProfileId(provider),
        presetId: CUSTOM_TEMPLATE_ID,
        enabled: true
      }
    : { ...provider, enabled: true };
  return updateProviderConfig(workspaceDir, {
    activeProviderId: savedProvider.id,
    provider: savedProvider
  });
}

export async function setProviderEnabled(
  workspaceDir: string,
  providerId: string,
  enabled: boolean
): Promise<ProviderConfigDocument> {
  const current = await readProviderConfig(workspaceDir);
  const provider = current.providers[providerId];
  if (!provider) throw new Error(`Provider ${providerId} is not configured.`);
  if (providerId === CUSTOM_TEMPLATE_ID) throw new Error("The Custom API template cannot be enabled directly; save it as a named profile.");
  if (enabled && !resolveAuthToken(provider.auth)) throw new Error(`Provider ${provider.name} has no saved credential.`);
  const next: ProviderConfigDocument = {
    activeProviderId: enabled
      ? providerId
      : (current.activeProviderId === providerId ? firstEnabledProviderId(current, providerId) : current.activeProviderId),
    providers: {
      ...current.providers,
      [providerId]: { ...provider, enabled }
    }
  };
  await writeProviderConfig(workspaceDir, next);
  return next;
}

export async function deleteProviderProfile(
  workspaceDir: string,
  providerId: string
): Promise<ProviderConfigDocument> {
  if (providerId === CUSTOM_TEMPLATE_ID) throw new Error("The Custom API template cannot be deleted.");
  const current = await readProviderConfig(workspaceDir);
  const provider = current.providers[providerId];
  if (!provider) throw new Error(`Provider ${providerId} is not configured.`);
  if (provider.presetId !== CUSTOM_TEMPLATE_ID) throw new Error("Only saved Custom API profiles can be deleted.");
  const providers = { ...current.providers };
  delete providers[providerId];
  const next: ProviderConfigDocument = {
    activeProviderId: current.activeProviderId === providerId
      ? firstEnabledProviderId({ ...current, providers }, providerId)
      : current.activeProviderId,
    providers
  };
  await writeProviderConfig(workspaceDir, next);
  return next;
}

export function listProviderDescriptors(doc: ProviderConfigDocument): ProviderDescriptor[] {
  return Object.values(doc.providers)
    .map((provider) => {
      const presetId = provider.presetId ?? provider.id;
      const presetDescriptor = getProviderDescriptor(presetId);
      return {
        ...presetDescriptor,
        id: provider.id,
        presetId,
        name: provider.name,
        type: "openai_compatible" as const,
        requiresAuth: true,
        defaultModel: provider.model,
        enabled: provider.enabled !== false && Boolean(resolveAuthToken(provider.auth)),
        capabilities: presetDescriptor?.capabilities
          ? {
              ...presetDescriptor.capabilities,
              modelSource: resolvePiProviderId(provider.id, provider.piProviderId) ? "pi_registry" : "explicit"
            }
          : undefined
      };
    });
}

export function getStoredProvider(doc: ProviderConfigDocument, providerId: string): StoredProviderConfig | undefined {
  return doc.providers[providerId];
}

export function resolveAuthToken(config: OpenAiCompatibleProviderConfig["auth"]): string | undefined {
  if (!config) {
    return undefined;
  }
  if (config.kind === "api_key") {
    return config.key.trim() || undefined;
  }
  if (config.kind === "oauth") {
    return config.accessToken.trim() || undefined;
  }
  return undefined;
}
