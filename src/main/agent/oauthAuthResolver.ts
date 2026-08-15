import type {
  OpenAiCompatibleProviderConfig,
  ProviderOAuthAuth
} from "../../shared/agent/providerConfigTypes.ts";
import { isChatGptOAuthProvider } from "../../shared/agent/providerPresets.ts";
import {
  importCodexOAuthToProviderAuth,
  readOAuthFromWorkspaceProvider,
  writeOAuthToWorkspaceProvider
} from "./codexOAuthAuth.ts";
import {
  ensureFreshOAuthToken,
  oauthTokenExpiresAt
} from "./openAiCodexOAuthPkce.ts";
import {
  readOAuthProfiles,
  resolveOAuthProfile,
  upsertOAuthProfile
} from "./oauthProfilesStore.ts";
import { resolveAuthToken } from "./providerConfigStore.ts";
import { updateProviderConfig, readProviderConfig } from "./providerConfigStore.ts";
import { extractChatGptAccountId } from "./providers/codexJwt.ts";

const chatGptAuthResolutions = new Map<string, Promise<ProviderOAuthAuth>>();

function normalizedOAuthAuth(auth: ProviderOAuthAuth): ProviderOAuthAuth {
  const expiresAt = oauthTokenExpiresAt(auth);
  return expiresAt && expiresAt !== auth.expiresAt ? { ...auth, expiresAt } : auth;
}

function oauthAccountId(auth: ProviderOAuthAuth): string | undefined {
  return auth.accountId?.trim() || extractChatGptAccountId(auth.accessToken);
}

function preferNewerSameAccountAuth(
  stored: ProviderOAuthAuth | undefined,
  imported: ProviderOAuthAuth | undefined
): ProviderOAuthAuth | undefined {
  if (!stored) return imported ? normalizedOAuthAuth(imported) : undefined;
  if (!imported) return normalizedOAuthAuth(stored);
  const normalizedStored = normalizedOAuthAuth(stored);
  const normalizedImported = normalizedOAuthAuth(imported);
  const storedAccount = oauthAccountId(normalizedStored);
  const importedAccount = oauthAccountId(normalizedImported);
  if (!storedAccount || !importedAccount || storedAccount !== importedAccount) {
    return normalizedStored;
  }
  const storedExpires = Date.parse(normalizedStored.expiresAt ?? "");
  const importedExpires = Date.parse(normalizedImported.expiresAt ?? "");
  return Number.isFinite(importedExpires) && (!Number.isFinite(storedExpires) || importedExpires > storedExpires)
    ? normalizedImported
    : normalizedStored;
}

function oauthAuthChanged(
  before: ProviderOAuthAuth | undefined,
  after: ProviderOAuthAuth
): boolean {
  return !before
    || before.accessToken !== after.accessToken
    || before.refreshToken !== after.refreshToken
    || before.expiresAt !== after.expiresAt
    || before.accountId !== after.accountId;
}

async function resolveFreshChatGptAuth(args: {
  config: OpenAiCompatibleProviderConfig;
  workspaceDir?: string;
  storedAuth?: ProviderOAuthAuth;
  candidate: ProviderOAuthAuth;
}): Promise<ProviderOAuthAuth> {
  const account = oauthAccountId(args.candidate) ?? "unknown";
  const key = `${args.workspaceDir ?? ""}\u0000${args.config.id}\u0000${account}`;
  const active = chatGptAuthResolutions.get(key);
  if (active) return active;

  const pending = (async () => {
    const fresh = await ensureFreshOAuthToken(args.candidate, args.workspaceDir);
    if (args.workspaceDir && oauthAuthChanged(args.storedAuth, fresh)) {
      await persistOAuthAuth(args.workspaceDir, args.config.id, fresh);
    }
    return fresh;
  })();
  chatGptAuthResolutions.set(key, pending);
  try {
    return await pending;
  } finally {
    if (chatGptAuthResolutions.get(key) === pending) {
      chatGptAuthResolutions.delete(key);
    }
  }
}

export async function resolveProviderOAuthAuth(
  config: OpenAiCompatibleProviderConfig,
  workspaceDir?: string
): Promise<{ token: string; auth?: import("../../shared/agent/providerConfigTypes.ts").ProviderOAuthAuth }> {
  let auth = config.auth?.kind === "oauth" ? config.auth : undefined;

  if (workspaceDir) {
    const profiles = await readOAuthProfiles(workspaceDir);
    const profile = resolveOAuthProfile(profiles, config.id);
    if (profile?.auth?.accessToken) {
      auth = profile.auth;
    }
    if (!auth) {
      auth = await readOAuthFromWorkspaceProvider(workspaceDir, config.id);
    }
  }

  if (isChatGptOAuthProvider(config) && auth?.accessToken) {
    const storedAuth = auth;
    auth = preferNewerSameAccountAuth(storedAuth, await importCodexOAuthToProviderAuth());
    if (auth?.accessToken) {
      const fresh = await resolveFreshChatGptAuth({
        config,
        workspaceDir,
        storedAuth,
        candidate: auth
      });
      return { token: fresh.accessToken, auth: fresh };
    }
  }
  if (!auth?.accessToken) {
    const fromConfig = resolveAuthToken(config.auth);
    return { token: fromConfig ?? "" };
  }

  return { token: auth.accessToken, auth };
}

async function persistOAuthAuth(
  workspaceDir: string,
  providerId: string,
  auth: ProviderOAuthAuth
): Promise<void> {
  await writeOAuthToWorkspaceProvider(workspaceDir, providerId, auth);
  await upsertOAuthProfile(workspaceDir, {
    providerId,
    auth,
    makeActive: true
  });
  const doc = await readProviderConfig(workspaceDir);
  const stored = doc.providers[providerId];
  if (stored?.type === "openai_compatible") {
    await updateProviderConfig(workspaceDir, {
      provider: { ...stored, auth }
    });
  }
}
