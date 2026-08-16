"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentUiStrings, type AgentUiLocale, type AgentUiStrings } from "./i18n";

const DEFAULT_PROVIDER_ID = "openai-chatgpt";

type ProviderDescriptor = Awaited<ReturnType<typeof window.workshop.listAgentProviders>>[number];
type ProviderConfigDoc = Awaited<ReturnType<typeof window.workshop.getAgentProviderConfig>>;
type ModelEntry = Awaited<ReturnType<typeof window.workshop.listAgentModels>>[number];
type OAuthProfilesDoc = Awaited<ReturnType<typeof window.workshop.listAgentOAuthProfiles>>;

type OpenAiProvider = {
  id: string;
  presetId?: string;
  type: "openai_compatible";
  name: string;
  baseUrl: string;
  model: string;
  piProviderId?: string;
  models?: string[];
  supportsImages?: boolean;
  thinkingLevel?: string;
  enabled?: boolean;
  auth?: { kind: "api_key"; key: string } | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: string };
};

interface Props {
  outputDir: string;
  locale: AgentUiLocale;
  onClose: () => void;
  onSaved?: (providerConfig?: ProviderConfigDoc) => void;
}

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "7px 9px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 12
};

function normalizeModelIds(model: string | undefined, values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [model ?? "", ...(values ?? [])]) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function modelIdsText(provider: OpenAiProvider): string {
  return normalizeModelIds("", provider.models).join("\n");
}

function asProvider(value: unknown, fallbackId: string): OpenAiProvider {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<OpenAiProvider> : {};
  const model = typeof record.model === "string" ? record.model : "";
  return {
    id: typeof record.id === "string" ? record.id : fallbackId,
    presetId: typeof record.presetId === "string" ? record.presetId : undefined,
    type: "openai_compatible",
    name: typeof record.name === "string" ? record.name : fallbackId,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
    model,
    piProviderId: typeof record.piProviderId === "string" ? record.piProviderId : undefined,
    models: normalizeModelIds(model, Array.isArray(record.models) ? record.models : undefined),
    supportsImages: record.supportsImages === true,
    thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : undefined,
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    auth: record.auth
  };
}

function authLabel(provider: OpenAiProvider | undefined, p: AgentUiStrings["provider"]): string {
  if (!provider?.auth) return p.notConnected;
  if (provider.auth.kind === "oauth") return p.oauthConnectedShort;
  if (provider.auth.kind === "api_key" && provider.auth.key) return p.apiKeySet;
  return p.notConnected;
}

function connectionLabel(provider: OpenAiProvider | undefined, oauthProfileCount: number, p: AgentUiStrings["provider"]): string {
  if (provider?.enabled === false && provider.auth) return p.savedDisabled;
  if (oauthProfileCount > 0) return p.oauthProfiles.replace("{count}", String(oauthProfileCount));
  return authLabel(provider, p);
}

function descriptorAuthModes(provider: ProviderDescriptor | undefined): Array<"api_key" | "oauth"> {
  const record = provider as unknown as { auth?: string; capabilities?: { authModes?: string[] } } | undefined;
  const modes = record?.capabilities?.authModes;
  if (Array.isArray(modes) && modes.length > 0) {
    return modes
      .map((mode) => mode === "oauth" || String(mode).startsWith("oauth") ? "oauth" : mode === "api_key" ? "api_key" : undefined)
      .filter((mode): mode is "api_key" | "oauth" => mode === "api_key" || mode === "oauth");
  }
  const auth = record?.auth || "";
  if (auth === "oauth" || auth.startsWith("oauth")) return ["oauth"];
  if (auth === "api_key") return ["api_key"];
  return ["api_key"];
}

function descriptorAuthLabel(provider: ProviderDescriptor): string {
  const modes = descriptorAuthModes(provider);
  if (modes.includes("oauth") && !modes.includes("api_key")) return "oauth";
  if (modes.includes("oauth") && modes.includes("api_key")) return "api_key / oauth";
  return "api_key";
}

export function ProviderSettingsPanel({ outputDir, locale, onClose, onSaved }: Props) {
  const p = agentUiStrings[locale].provider;
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [config, setConfig] = useState<ProviderConfigDoc | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [oauthProfiles, setOauthProfiles] = useState<OAuthProfilesDoc>({ activeProfileId: "", profiles: [] });
  const [activeProviderId, setActiveProviderId] = useState(DEFAULT_PROVIDER_ID);
  const [draft, setDraft] = useState<OpenAiProvider | null>(null);
  const [modelIdsDraft, setModelIdsDraft] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const modelLoadEpochRef = useRef(0);
  const oauthProfileEpochRef = useRef(0);

  const activeDescriptor = providers.find((provider) => provider.id === activeProviderId);
  const providerAuthModes = descriptorAuthModes(activeDescriptor);
  const supportsOAuth = providerAuthModes.includes("oauth");
  const supportsApiKey = providerAuthModes.includes("api_key");
  const isOAuthOnly = supportsOAuth && !supportsApiKey;
  const usesExplicitModels = activeDescriptor?.capabilities?.modelSource === "explicit";
  const isCustomTemplate = activeProviderId === "custom-api";
  const isSavedCustomProfile = draft?.presetId === "custom-api" && !isCustomTemplate;
  const providerEnabled = draft?.enabled !== false && Boolean(draft?.auth);
  const oauthReady = oauthProfiles.profiles.length > 0 || draft?.auth?.kind === "oauth";
  const activeConnectionLabel = connectionLabel(draft ?? undefined, supportsOAuth ? oauthProfiles.profiles.length : 0, p);

  const load = useCallback(async () => {
    if (!outputDir) return;
    try {
      const [providerList, providerConfig] = await Promise.all([
        window.workshop.listAgentProviders({ outputDir }),
        window.workshop.getAgentProviderConfig({ outputDir })
      ]);
      const nextActiveProviderId = providerConfig.activeProviderId || providerList[0]?.id || DEFAULT_PROVIDER_ID;
      setProviders(providerList);
      setConfig(providerConfig);
      setActiveProviderId(nextActiveProviderId);
      const nextDraft = asProvider(providerConfig.providers?.[nextActiveProviderId], nextActiveProviderId);
      setDraft(nextDraft);
      setModelIdsDraft(modelIdsText(nextDraft));
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [outputDir]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeProviderId) return;
    const epoch = ++modelLoadEpochRef.current;
    setModels([]);
    void window.workshop.listAgentModels({ outputDir, providerId: activeProviderId })
      .then((nextModels) => {
        if (modelLoadEpochRef.current === epoch) setModels(nextModels);
      })
      .catch((error) => {
        if (modelLoadEpochRef.current === epoch) {
          setModels([]);
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
  }, [activeProviderId, outputDir]);

  useEffect(() => {
    if (!outputDir || !activeProviderId || !supportsOAuth) {
      oauthProfileEpochRef.current += 1;
      setOauthProfiles({ activeProfileId: "", profiles: [] });
      return;
    }
    const epoch = ++oauthProfileEpochRef.current;
    setOauthProfiles({ activeProfileId: "", profiles: [] });
    void window.workshop.listAgentOAuthProfiles({ outputDir, providerId: activeProviderId })
      .then((nextProfiles) => {
        if (oauthProfileEpochRef.current === epoch) setOauthProfiles(nextProfiles);
      })
      .catch((error) => {
        if (oauthProfileEpochRef.current === epoch) {
          setOauthProfiles({ activeProfileId: "", profiles: [] });
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
  }, [activeProviderId, outputDir, supportsOAuth]);

  useEffect(() => {
    if (!draft || usesExplicitModels || models.length === 0) return;
    if (draft.model && models.some((model) => model.id === draft.model)) return;
    setDraft({ ...draft, model: models[0]?.id || "" });
  }, [draft, models, usesExplicitModels]);

  const selectProvider = useCallback((providerId: string) => {
    setActiveProviderId(providerId);
    setModels([]);
    setOauthProfiles({ activeProfileId: "", profiles: [] });
    const nextDraft = asProvider(config?.providers?.[providerId], providerId);
    setDraft(nextDraft);
    setModelIdsDraft(modelIdsText(nextDraft));
    setApiKeyDraft("");
    setStatus("");
  }, [config]);

  const updateDraft = useCallback((patch: Partial<OpenAiProvider>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }, []);

  const updateExplicitModels = useCallback((value: string) => {
    setModelIdsDraft(value);
    const ids = normalizeModelIds("", value.split(/[\n,]/));
    setDraft((current) => {
      if (!current) return current;
      const model = ids.includes(current.model) ? current.model : (ids[0] ?? "");
      return { ...current, model, models: ids };
    });
  }, []);

  const save = useCallback(async () => {
    if (!outputDir || !draft) return;
    const explicitModelIds = usesExplicitModels
      ? normalizeModelIds("", modelIdsDraft.split(/[\n,]/))
      : normalizeModelIds(draft.model, draft.models);
    if (usesExplicitModels && explicitModelIds.length === 0) {
      setStatus(p.addModel);
      return;
    }
    setSaving(true);
    setStatus(p.saving);
    try {
      const auth = supportsApiKey && apiKeyDraft.trim()
        ? { kind: "api_key" as const, key: apiKeyDraft.trim() }
        : draft.auth;
      const nextConfig = await window.workshop.saveAgentProviderConfig({
        outputDir,
        activeProviderId,
        provider: {
          ...draft,
          models: usesExplicitModels ? explicitModelIds : undefined,
          enabled: true,
          auth
        }
      });
      setApiKeyDraft("");
      setConfig(nextConfig);
      const savedProviderId = nextConfig.activeProviderId || activeProviderId;
      setActiveProviderId(savedProviderId);
      const savedDraft = asProvider(nextConfig.providers?.[savedProviderId], savedProviderId);
      setDraft(savedDraft);
      setModelIdsDraft(modelIdsText(savedDraft));
      setProviders(await window.workshop.listAgentProviders({ outputDir }));
      setStatus(p.savedStatus);
      onSaved?.(nextConfig);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [activeProviderId, apiKeyDraft, draft, modelIdsDraft, onSaved, outputDir, supportsApiKey, usesExplicitModels]);

  const disableProvider = useCallback(async () => {
    if (!outputDir || !activeProviderId) return;
    setSaving(true);
    setStatus(p.disabling);
    try {
      const request = {
        outputDir: String(outputDir),
        providerId: String(activeProviderId),
        enabled: false
      };
      const nextConfig = await window.workshop.setAgentProviderEnabled(request);
      setConfig(nextConfig);
      const nextDraft = asProvider(nextConfig.providers?.[activeProviderId], activeProviderId);
      setDraft(nextDraft);
      setModelIdsDraft(modelIdsText(nextDraft));
      setProviders(await window.workshop.listAgentProviders({ outputDir }));
      setStatus(p.disabledStatus);
      onSaved?.(nextConfig);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [activeProviderId, onSaved, outputDir]);

  const deleteProfile = useCallback(async () => {
    if (!outputDir || !activeProviderId || !isSavedCustomProfile) return;
    if (!window.confirm(p.deleteConfirm.replace("{name}", draft?.name || activeProviderId))) return;
    setSaving(true);
    setStatus(p.deleting);
    try {
      const nextConfig = await window.workshop.deleteAgentProviderProfile({ outputDir, providerId: activeProviderId });
      const providerList = await window.workshop.listAgentProviders({ outputDir });
      const nextProviderId = nextConfig.activeProviderId || providerList[0]?.id || DEFAULT_PROVIDER_ID;
      const nextDraft = asProvider(nextConfig.providers?.[nextProviderId], nextProviderId);
      setProviders(providerList);
      setConfig(nextConfig);
      setActiveProviderId(nextProviderId);
      setDraft(nextDraft);
      setModelIdsDraft(modelIdsText(nextDraft));
      setApiKeyDraft("");
      setStatus(p.deletedStatus);
      onSaved?.(nextConfig);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [activeProviderId, draft?.name, isSavedCustomProfile, onSaved, outputDir, p.deleteConfirm]);

  const connectOAuth = useCallback(async (mode: "import" | "pkce") => {
    if (!outputDir || !activeProviderId) return;
    setSaving(true);
    setStatus(mode === "import" ? p.importingOAuth : p.openingOAuth);
    try {
      const result = await window.workshop.connectAgentProviderOAuth({ outputDir, providerId: activeProviderId, mode });
      setStatus(result.message || (result.ok ? p.oauthConnected : p.oauthFailed));
      setOauthProfiles(await window.workshop.listAgentOAuthProfiles({ outputDir, providerId: activeProviderId }));
      onSaved?.();
      void load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [activeProviderId, load, onSaved, outputDir]);

  const validate = useCallback(async () => {
    if (!outputDir || !activeProviderId) return;
    setSaving(true);
    setStatus(p.checking);
    try {
      const result = await window.workshop.validateAgentProvider({ outputDir, providerId: activeProviderId });
      setStatus(result.ok ? p.ready : result.detail || p.notReady);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [activeProviderId, outputDir]);

  const modelOptions = useMemo(() => {
    const byId = new Map<string, ModelEntry>();
    for (const model of models) byId.set(model.id, model);
    for (const id of normalizeModelIds(draft?.model, draft?.models)) {
      if (!byId.has(id)) byId.set(id, { id, label: id });
    }
    return [...byId.values()];
  }, [draft?.model, draft?.models, models]);

  if (!draft) {
    return (
      <section className="ynAgentProviderSettings">
        <div className="ynAgentProviderSettingsHeader">
          <strong>{p.settings}</strong>
          <button type="button" onClick={onClose}>{p.close}</button>
        </div>
        <div className="ynAgentProviderEmpty">{status || p.loading}</div>
      </section>
    );
  }

  return (
    <section className="ynAgentProviderSettings" aria-label={p.settings}>
      <div className="ynAgentProviderSettingsHeader">
        <div>
          <strong>{p.settings}</strong>
          <span>{activeDescriptor?.name || draft.name || activeProviderId} · {activeConnectionLabel}</span>
        </div>
        <button type="button" onClick={onClose}>{p.close}</button>
      </div>

      <div className="ynAgentProviderSettingsBody">
        <aside className="ynAgentProviderList">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={provider.id === activeProviderId ? "active" : ""}
              onClick={() => selectProvider(provider.id)}
            >
              <span>{provider.name || provider.id}</span>
              <small>{provider.id === "custom-api"
                ? p.newCustom
                : provider.presetId === "custom-api"
                  ? (provider.enabled ? p.customEnabled : p.customSaved)
                  : `${descriptorAuthLabel(provider)}${provider.enabled ? ` · ${p.enabled}` : ""}`}</small>
            </button>
          ))}
        </aside>

        <div className="ynAgentProviderForm">
          <div className="ynAgentProviderFields">
            {supportsApiKey ? (
              <>
                <label>
                  {p.name}
                  <input style={inputStyle} value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
                </label>
                <label>
                  {p.baseUrl}
                  <input style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
                </label>
              </>
            ) : (
              <div className="ynAgentProviderOAuthCard">
                <strong>{activeDescriptor?.name || draft.name}</strong>
                <span>{activeDescriptor?.description || p.oauthDescription}</span>
                <span>{p.connectionStatus}: {activeConnectionLabel}</span>
                {oauthProfiles.profiles.length > 0 ? (
                  <div className="ynAgentProviderProfileList">
                    {oauthProfiles.profiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        className={profile.id === oauthProfiles.activeProfileId ? "active" : ""}
                        onClick={() => {
                          void window.workshop.setAgentOAuthProfile({ outputDir, profileId: profile.id })
                            .then((result) => setOauthProfiles((current) => ({ ...current, activeProfileId: result.activeProfileId })))
                            .then(() => onSaved?.())
                            .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
                        }}
                      >
                        <span>{profile.label}</span>
                        <small>{profile.id === oauthProfiles.activeProfileId ? p.active : p.saved} · {new Date(profile.updatedAt).toLocaleString(locale)}</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <span>{p.noOAuthProfile}</span>
                )}
              </div>
            )}
            {usesExplicitModels && (
              <>
                <label>
                  {p.modelIds}
                  <textarea
                    style={{ ...inputStyle, minHeight: 96, resize: "vertical", fontFamily: "var(--font-mono)" }}
                    value={modelIdsDraft}
                    onChange={(event) => updateExplicitModels(event.target.value)}
                    placeholder={"translator-main\nproofreader-fast"}
                  />
                </label>
                <label className="ynAgentProviderCheckbox">
                  <input
                    type="checkbox"
                    checked={draft.supportsImages === true}
                    onChange={(event) => updateDraft({ supportsImages: event.target.checked })}
                  />
                  <span>{p.supportsImages}</span>
                </label>
              </>
            )}
            <label>
              {p.defaultModel}
              <select style={inputStyle} value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })}>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.label || model.id}</option>
                ))}
              </select>
            </label>
            {supportsApiKey && (
              <label>
                {p.apiKey}
                <input
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  type="password"
                  value={apiKeyDraft}
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                  placeholder={draft.auth?.kind === "api_key" ? p.keepSavedKey : p.pasteApiKey}
                />
              </label>
            )}
          </div>

          <div className="ynAgentProviderFooter">
            <div className="ynAgentProviderActions">
              {supportsOAuth && (
                <>
                  <button type="button" onClick={() => void connectOAuth("import")} disabled={saving}>{activeProviderId === "anthropic-claude" ? p.importClaude : activeProviderId === "openai-chatgpt" ? p.importCodex : activeProviderId === "xai-grok" ? p.importGrok : p.importOAuth}</button>
                  {activeProviderId !== "anthropic-claude" && (
                    <button type="button" onClick={() => void connectOAuth("pkce")} disabled={saving}>{activeProviderId === "openai-chatgpt" ? p.signInChatGpt : activeProviderId === "xai-grok" ? p.signInGrok : p.oauthLogin}</button>
                  )}
                </>
              )}
              <button type="button" onClick={() => void validate()} disabled={saving}>{p.test}</button>
              {providerEnabled && !isCustomTemplate && (
                <button type="button" onClick={() => void disableProvider()} disabled={saving}>{p.disable}</button>
              )}
              {isSavedCustomProfile && (
                <button type="button" onClick={() => void deleteProfile()} disabled={saving}>{p.delete}</button>
              )}
              <button type="button" className="primary" onClick={() => void save()} disabled={saving || (isOAuthOnly && !oauthReady)}>
                {draft.enabled === false && draft.auth ? p.enable : isOAuthOnly ? p.useProvider : p.save}
              </button>
            </div>
            {status && <div className="ynAgentProviderStatus">{status}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
