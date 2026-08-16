import { ipcMain, shell } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  importCodexOAuthToProviderAuth,
  readCodexAuthFromDisk,
  startCodexDeviceLogin,
  waitForCodexAuthFile,
  writeOAuthToWorkspaceProvider
} from "../agent/codexOAuthAuth.ts";
import {
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  generatePkcePair,
  startCodexOAuthCallbackServer
} from "../agent/openAiCodexOAuthPkce.ts";
import {
  GROK_PI_OAUTH_PROVIDER_ID,
  importGrokOAuthToProviderAuth,
  runGrokPkceLogin
} from "../agent/grokOAuthPkce.ts";
import {
  listOAuthProfilesForProvider,
  readOAuthProfiles,
  setActiveOAuthProfile,
  upsertOAuthProfile
} from "../agent/oauthProfilesStore.ts";
import {
  deleteProviderProfile,
  listProviderDescriptors,
  readProviderConfig,
  saveProviderProfile,
  setProviderEnabled,
  updateProviderConfig
} from "../agent/providerConfigStore.ts";
import { getProviderPreset, isOAuthPresetAuth, PROVIDER_PRESETS } from "../../shared/agent/providerPresets.ts";
import { listModelsForProvider } from "../../shared/agent/providerModels.ts";
import { importClaudeOAuthToProviderAuth } from "../agent/claudeOAuthAuth.ts";
import type { OpenAiCompatibleProviderConfig, ProviderAuth, StoredProviderConfig } from "../../shared/agent/providerConfigTypes.ts";
import { broadcastPiSession } from "../agent/piNative/broadcast.ts";
import {
  createPiModelSelection,
  listPiConfiguredModels,
  listPiProviderModels,
  readPiLocalOAuthCredential
} from "../agent/piNative/providerRegistry.ts";

export interface ProviderProjectArgs {
  outputDir: string;
}

export interface SaveProviderConfigArgs extends ProviderProjectArgs {
  activeProviderId?: string;
  provider: StoredProviderConfig;
}

export function resolveProjectPaths(outputDir: string): { outputDir: string; workspaceDir: string; projectId: string } {
  if (!outputDir || !path.isAbsolute(outputDir)) {
    throw new Error("An absolute output directory is required.");
  }
  const normalizedOutputDir = path.basename(outputDir).toLowerCase() === ".translation-workshop"
    ? path.dirname(outputDir)
    : outputDir;
  const workspaceDir = path.join(normalizedOutputDir, ".translation-workshop");
  return {
    outputDir: normalizedOutputDir,
    workspaceDir,
    projectId: normalizedOutputDir
  };
}

function redactProviderConfig(provider: StoredProviderConfig): StoredProviderConfig {
  const copy: OpenAiCompatibleProviderConfig = { ...provider };
  if (copy.auth?.kind === "api_key" && copy.auth.key) {
    copy.auth = { kind: "api_key", key: copy.auth.key ? "••••••••" : "" };
  }
  if (copy.auth?.kind === "oauth" && copy.auth.accessToken) {
    copy.auth = {
      kind: "oauth",
      accessToken: "••••••••",
      refreshToken: copy.auth.refreshToken ? "••••••••" : undefined,
      expiresAt: copy.auth.expiresAt
    };
  }
  return copy;
}

export function providerConfigResponse(doc: Awaited<ReturnType<typeof readProviderConfig>>) {
  return {
    activeProviderId: doc.activeProviderId,
    providers: Object.fromEntries(
      Object.entries(doc.providers).map(([id, provider]) => [id, redactProviderConfig(provider)])
    )
  };
}

export async function getAgentProviderConfig(outputDir: string) {
  const { workspaceDir } = resolveProjectPaths(outputDir);
  return providerConfigResponse(await readProviderConfig(workspaceDir));
}

export async function saveAgentProviderConfig(args: SaveProviderConfigArgs) {
  const { workspaceDir } = resolveProjectPaths(args.outputDir);
  const current = await readProviderConfig(workspaceDir);
  let provider = args.provider;
  const existing = current.providers[provider.id];
  const incomingAuth = provider.auth;
  if (existing && incomingAuth) {
    const mergedAuth: ProviderAuth | undefined = (() => {
      if (incomingAuth.kind === "api_key" && incomingAuth.key.includes("••••")) return existing.auth;
      if (incomingAuth.kind === "oauth" && incomingAuth.accessToken.includes("••••")) return existing.auth;
      return incomingAuth;
    })();
    provider = { ...provider, auth: mergedAuth };
  }
  const doc = await saveProviderProfile(workspaceDir, provider);
  const response = providerConfigResponse(doc);
  broadcastPiSession("agent-provider:update", { scope: "global", workspaceDir, config: response });
  return response;
}

export async function listAgentConfiguredModels(outputDir: string) {
  const { outputDir: projectDir } = resolveProjectPaths(outputDir);
  return (await listPiConfiguredModels(projectDir))
    .filter((entry) => entry.authenticated)
    .map((entry) => ({
      providerId: entry.providerId,
      providerName: entry.providerName,
      modelId: entry.modelId,
      modelName: entry.modelName,
      supportsImages: entry.supportsImages,
      thinkingLevels: entry.thinkingLevels
    }));
}

async function broadcastProviderConfig(workspaceDir: string): Promise<void> {
  const config = providerConfigResponse(await readProviderConfig(workspaceDir));
  broadcastPiSession("agent-provider:update", { scope: "global", workspaceDir, config });
}

async function persistOAuthSession(
  workspaceDir: string,
  providerId: string,
  auth: import("../../shared/agent/providerConfigTypes.ts").ProviderOAuthAuth,
  profileId?: string,
  label?: string
): Promise<void> {
  const profileKey = profileId ?? `${providerId}:default`;
  await upsertOAuthProfile(workspaceDir, {
    providerId,
    profileId: profileKey,
    label: label ?? profileKey,
    auth,
    makeActive: true
  });
  await writeOAuthToWorkspaceProvider(workspaceDir, providerId, auth);
  const preset = getProviderPreset(providerId);
  if (preset) {
    await updateProviderConfig(workspaceDir, {
      activeProviderId: providerId,
      provider: { ...preset.config, auth }
    });
  }
  await broadcastProviderConfig(workspaceDir);
}

export function registerAgentProviderIpc(): void {
  ipcMain.handle("agent-provider:list", async (_event, args?: ProviderProjectArgs) => {
    if (!args?.outputDir) {
      return PROVIDER_PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.name,
        type: "openai_compatible" as const,
        requiresAuth: true,
        auth: preset.auth
      }));
    }
    const { workspaceDir } = resolveProjectPaths(args.outputDir);
    const doc = await readProviderConfig(workspaceDir);
    return listProviderDescriptors(doc).map((descriptor) => {
      const preset = getProviderPreset(descriptor.presetId ?? descriptor.id);
      return { ...descriptor, auth: preset?.auth };
    });
  });

  ipcMain.handle("agent-provider:getConfig", async (_event, args: ProviderProjectArgs) => {
    return getAgentProviderConfig(args.outputDir);
  });

  ipcMain.handle("agent-provider:saveConfig", async (_event, args: SaveProviderConfigArgs) => {
    return saveAgentProviderConfig(args);
  });

  ipcMain.handle("agent-provider:setEnabled", async (_event, outputDir: string, providerId: string, enabled: boolean) => {
    const { workspaceDir } = resolveProjectPaths(outputDir);
    const doc = await setProviderEnabled(workspaceDir, providerId, enabled);
    const response = providerConfigResponse(doc);
    broadcastPiSession("agent-provider:update", { scope: "global", workspaceDir, config: response });
    return response;
  });

  ipcMain.handle("agent-provider:deleteProfile", async (_event, outputDir: string, providerId: string) => {
    const { workspaceDir } = resolveProjectPaths(outputDir);
    const doc = await deleteProviderProfile(workspaceDir, providerId);
    const response = providerConfigResponse(doc);
    broadcastPiSession("agent-provider:update", { scope: "global", workspaceDir, config: response });
    return response;
  });

  ipcMain.handle("agent-provider:validate", async (_event, args: { outputDir?: string; providerId: string }) => {
    if (!args.outputDir) {
      return { ok: false, detail: "An output directory is required." };
    }
    const { outputDir, workspaceDir } = resolveProjectPaths(args.outputDir);
    const config = await readProviderConfig(workspaceDir);
    const stored = config.providers[args.providerId];
    if (!stored || stored.type !== "openai_compatible") {
      return { ok: false, detail: `Provider ${args.providerId} is not configured.` };
    }
    try {
      const selection = await createPiModelSelection({
        workspaceDir: outputDir,
        providerId: args.providerId,
        modelId: stored.model
      });
      return { ok: true, detail: `${selection.providerId}/${selection.modelId} is ready in Pi.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("agent-provider:listModels", async (_event, args: { outputDir?: string; providerId: string }) => {
    if (args.outputDir) {
      const { outputDir } = resolveProjectPaths(args.outputDir);
      return listPiProviderModels(outputDir, args.providerId);
    }
    const preset = getProviderPreset(args.providerId);
    return listModelsForProvider(args.providerId, preset ? {
      piProviderId: preset.config.piProviderId,
      model: preset.config.model,
      modelIds: preset.config.models
    } : undefined);
  });

  ipcMain.handle("agent-provider:listConfiguredModels", async (_event, args: ProviderProjectArgs) => {
    return listAgentConfiguredModels(args.outputDir);
  });

  ipcMain.handle(
    "agent-provider:connectOAuth",
    async (
      _event,
      args: ProviderProjectArgs & {
        providerId: string;
        mode?: "pkce" | "import" | "device";
        profileId?: string;
        label?: string;
      }
    ) => {
      const { workspaceDir } = resolveProjectPaths(args.outputDir);
      const preset = getProviderPreset(args.providerId);
      if (!preset || !isOAuthPresetAuth(preset.auth)) {
        return { ok: false, message: "OAuth connect is only supported for ChatGPT, Claude, or Grok subscription providers." };
      }

      if (preset.auth === "oauth_claude") {
        const piCredential = await readPiLocalOAuthCredential(args.providerId, preset.config.piProviderId);
        const auth = piCredential
          ? {
              kind: "oauth" as const,
              accessToken: piCredential.access,
              refreshToken: piCredential.refresh || undefined,
              expiresAt: Number.isFinite(piCredential.expires) && piCredential.expires < Number.MAX_SAFE_INTEGER
                ? new Date(piCredential.expires).toISOString()
                : undefined
            }
          : await importClaudeOAuthToProviderAuth();
        if (!auth?.accessToken) {
          return {
            ok: false,
            message: "No Pi or Claude Code OAuth session found. Sign in once, then import the local login."
          };
        }
        await persistOAuthSession(workspaceDir, args.providerId, auth, args.profileId, args.label);
        return { ok: true, message: piCredential ? "Claude OAuth connected from Pi." : "Claude OAuth connected from Claude Code." };
      }

      if (preset.auth === "oauth_grok") {
        const mode = args.mode ?? "pkce";
        if (mode === "device") {
          return { ok: false, message: "Grok OAuth uses browser sign-in or ~/.grok/auth.json import. Device login is ChatGPT-only." };
        }
        if (mode === "import") {
          const piCredential = await readPiLocalOAuthCredential(GROK_PI_OAUTH_PROVIDER_ID, GROK_PI_OAUTH_PROVIDER_ID);
          const auth = piCredential
            ? {
                kind: "oauth" as const,
                accessToken: piCredential.access,
                refreshToken: piCredential.refresh || undefined,
                expiresAt: Number.isFinite(piCredential.expires) && piCredential.expires < Number.MAX_SAFE_INTEGER
                  ? new Date(piCredential.expires).toISOString()
                  : undefined
              }
            : await importGrokOAuthToProviderAuth();
          if (!auth?.accessToken) {
            return {
              ok: false,
              message: "No ~/.grok/auth.json or Pi xai-auth OAuth session found. Sign in with Grok, or import the official Grok CLI login."
            };
          }
          await persistOAuthSession(workspaceDir, args.providerId, auth, args.profileId, args.label);
          return { ok: true, message: piCredential ? "Grok OAuth connected from Pi." : "Grok OAuth connected from Grok CLI." };
        }
        try {
          const auth = await runGrokPkceLogin({
            openBrowser: (url) => shell.openExternal(url),
            workspaceDir
          });
          await persistOAuthSession(workspaceDir, args.providerId, auth, args.profileId, args.label);
          return { ok: true, message: "Grok OAuth connected (PKCE)." };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "Grok PKCE OAuth login failed."
          };
        }
      }

      const mode = args.mode ?? "pkce";

      if (mode === "import") {
        const piCredential = await readPiLocalOAuthCredential(args.providerId, preset.config.piProviderId);
        let auth = piCredential
          ? {
              kind: "oauth" as const,
              accessToken: piCredential.access,
              refreshToken: piCredential.refresh || undefined,
              expiresAt: Number.isFinite(piCredential.expires) && piCredential.expires < Number.MAX_SAFE_INTEGER
                ? new Date(piCredential.expires).toISOString()
                : undefined
            }
          : await importCodexOAuthToProviderAuth();
        if (!auth?.accessToken) {
          const disk = await readCodexAuthFromDisk();
          if (!disk) {
            return { ok: false, message: "No ~/.codex/auth.json found. Run codex login once or use Sign in with ChatGPT." };
          }
          auth = {
            kind: "oauth",
            accessToken: disk.accessToken,
            refreshToken: disk.refreshToken,
            expiresAt: disk.expiresAt
          };
        }
        await persistOAuthSession(workspaceDir, args.providerId, auth, args.profileId, args.label);
        return { ok: true, message: piCredential ? "Imported Pi OAuth session." : "Imported Codex OAuth session." };
      }

      if (mode === "device") {
        let auth = await importCodexOAuthToProviderAuth();
        if (!auth) {
          try {
            const { resolveCodexCliPath } = await import("../agent/codexOAuthAuth.ts");
            const codexPath = await resolveCodexCliPath();
            const session = await startCodexDeviceLogin(codexPath);
            await shell.openExternal(session.verificationUri);
            auth = await waitForCodexAuthFile();
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : "Codex device login failed."
            };
          }
        }
        await persistOAuthSession(workspaceDir, args.providerId, auth, args.profileId, args.label);
        return { ok: true, message: "ChatGPT OAuth connected via Codex CLI." };
      }

      try {
        const pkce = generatePkcePair();
        const state = randomBytes(16).toString("base64url");
        const authorizeUrl = buildCodexAuthorizeUrl({ pkce, state });
        const callbackPromise = startCodexOAuthCallbackServer({ expectedState: state });
        await shell.openExternal(authorizeUrl);
        const { code } = await callbackPromise;
        const auth = await exchangeCodexAuthorizationCode({ code, pkce, workspaceDir });
        await persistOAuthSession(workspaceDir, args.providerId, auth, args.profileId, args.label);
        return { ok: true, message: "ChatGPT OAuth connected (PKCE)." };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "PKCE OAuth login failed."
        };
      }
    }
  );

  ipcMain.handle("agent-provider:listOAuthProfiles", async (_event, args: ProviderProjectArgs & { providerId: string }) => {
    const { workspaceDir } = resolveProjectPaths(args.outputDir);
    const profiles = await listOAuthProfilesForProvider(workspaceDir, args.providerId);
    const doc = await readOAuthProfiles(workspaceDir);
    return {
      activeProfileId: doc.activeProfileId,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        updatedAt: profile.updatedAt
      }))
    };
  });

  ipcMain.handle("agent-provider:setOAuthProfile", async (_event, args: ProviderProjectArgs & { profileId: string }) => {
    const { workspaceDir } = resolveProjectPaths(args.outputDir);
    const doc = await setActiveOAuthProfile(workspaceDir, args.profileId);
    const profile = doc.profiles[args.profileId];
    if (profile?.auth) {
      await writeOAuthToWorkspaceProvider(workspaceDir, profile.providerId, profile.auth);
      const preset = getProviderPreset(profile.providerId);
      if (preset) {
        await updateProviderConfig(workspaceDir, {
          activeProviderId: profile.providerId,
          provider: { ...preset.config, auth: profile.auth }
        });
      }
    }
    await broadcastProviderConfig(workspaceDir);
    return { ok: true, activeProfileId: doc.activeProfileId };
  });

}
