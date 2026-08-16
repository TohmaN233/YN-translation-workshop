import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertPinnedGrokTokenUrl,
  buildGrokAuthorizeUrl,
  GROK_CLI_AUTH_SCOPE_KEY,
  GROK_CLI_LEGACY_AUTH_SCOPE_KEY,
  GROK_DEFAULT_MODEL,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_TOKEN_URL,
  grokOAuthTokenExpired,
  parseGrokAuthJson,
  refreshGrokOAuthToken
} from "../../src/main/agent/grokOAuthPkce.ts";
import { generatePkcePair } from "../../src/main/agent/openAiCodexOAuthPkce.ts";
import {
  createPiModelSelection,
  listPiProviderModels
} from "../../src/main/agent/piNative/providerRegistry.ts";
import { readOAuthProfiles } from "../../src/main/agent/oauthProfilesStore.ts";
import { readProviderConfig, writeProviderConfig } from "../../src/main/agent/providerConfigStore.ts";
import {
  getProviderDescriptor,
  getProviderPreset,
  isGrokOAuthProvider,
  isOAuthPresetAuth
} from "../../src/shared/agent/providerPresets.ts";
import { listModelsForProvider } from "../../src/shared/agent/providerModels.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

await test("xai-grok is an OAuth-only preset separate from xai-api", () => {
  const grok = getProviderPreset("xai-grok");
  const api = getProviderPreset("xai-api");
  assert.equal(grok?.auth, "oauth_grok");
  assert.equal(grok?.config.model, GROK_DEFAULT_MODEL);
  assert.equal(grok?.config.piProviderId, "xai");
  assert.equal(grok?.config.baseUrl, "https://api.x.ai/v1");
  assert.equal(api?.auth, "api_key");
  assert.equal(api?.config.model, "grok-code-fast-1");
  assert.equal(isOAuthPresetAuth("oauth_grok"), true);
  assert.equal(isOAuthPresetAuth("api_key"), false);
  assert.equal(isGrokOAuthProvider(grok?.config), true);
  assert.equal(isGrokOAuthProvider(api?.config), false);
  assert.deepEqual(getProviderDescriptor("xai-grok")?.capabilities.authModes, ["oauth"]);
  assert.deepEqual(getProviderDescriptor("xai-api")?.capabilities.authModes, ["api_key"]);
});

await test("Grok authorize URL matches official PKCE params and rejects extra plan routing", () => {
  const pkce = generatePkcePair();
  const url = new URL(buildGrokAuthorizeUrl({
    pkce,
    state: "statevalue",
    nonce: "noncevalue",
    redirectUri: "http://127.0.0.1:56121/callback"
  }));
  assert.equal(url.origin + url.pathname, "https://auth.x.ai/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), GROK_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:56121/callback");
  assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "statevalue");
  assert.equal(url.searchParams.get("nonce"), "noncevalue");
  assert.ok(url.searchParams.get("scope")?.includes("grok-cli:access"));
  assert.equal(url.searchParams.get("plan"), null);
  assert.ok(!url.search.includes("plan=generic"));
});

await test("official ~/.grok/auth.json and legacy scopes parse without inventing fields", () => {
  const official = parseGrokAuthJson({
    [GROK_CLI_AUTH_SCOPE_KEY]: {
      key: "official-access",
      refresh_token: "official-refresh",
      expires_at: "2030-01-01T00:00:00.000Z"
    }
  });
  assert.equal(official?.accessToken, "official-access");
  assert.equal(official?.refreshToken, "official-refresh");
  assert.equal(official?.expiresAt, "2030-01-01T00:00:00.000Z");

  const legacy = parseGrokAuthJson({
    [GROK_CLI_LEGACY_AUTH_SCOPE_KEY]: {
      key: "legacy-access"
    }
  });
  assert.equal(legacy?.accessToken, "legacy-access");
  assert.equal(legacy?.refreshToken, undefined);

  const topLevel = parseGrokAuthJson({
    access_token: "top-access",
    refresh_token: "top-refresh",
    expires_at: 1_893_456_000_000
  });
  assert.equal(topLevel?.accessToken, "top-access");
  assert.equal(topLevel?.refreshToken, "top-refresh");
  assert.equal(topLevel?.expiresAt, new Date(1_893_456_000_000).toISOString());
});

await test("Grok token expiry uses the official two-minute refresh skew", () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  assert.equal(grokOAuthTokenExpired({ kind: "oauth", accessToken: "x", expiresAt: soon }), true);
  const later = new Date(Date.now() + 10 * 60_000).toISOString();
  assert.equal(grokOAuthTokenExpired({ kind: "oauth", accessToken: "x", expiresAt: later }), false);
});

await test("Grok refresh refuses any token endpoint except the pinned official URL", () => {
  assert.throws(() => assertPinnedGrokTokenUrl("https://example.test/oauth/token"), /untrusted token endpoint/);
  assert.doesNotThrow(() => assertPinnedGrokTokenUrl(GROK_OAUTH_TOKEN_URL));
});

await test("Grok model list keeps the Pi xAI catalog and the official grok-4.6 default", () => {
  const models = listModelsForProvider("xai-grok", { piProviderId: "xai", model: "grok-4.6" });
  assert.ok(models.some((model) => model.id === "grok-code-fast-1"));
  assert.ok(models.some((model) => model.id === "grok-4.6"));
});

await test("Grok OAuth hands a refreshed access token to Pi as an API key and keeps grok-4.6 selectable", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-grok-oauth-"));
  const originalFetch = globalThis.fetch;
  let refreshCalls = 0;
  try {
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "xai-grok",
      providers: {
        "xai-grok": {
          id: "xai-grok",
          type: "openai_compatible",
          name: "Grok (OAuth)",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-4.6",
          piProviderId: "xai",
          auth: {
            kind: "oauth",
            accessToken: "expired-grok-access",
            refreshToken: "grok-refresh-token",
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }
        }
      }
    });

    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), GROK_OAUTH_TOKEN_URL);
      assert.match(String(init?.body), /grant_type=refresh_token/);
      assert.match(String(init?.body), /refresh_token=grok-refresh-token/);
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: "fresh-grok-access",
        refresh_token: "next-grok-refresh",
        expires_in: 3600
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const models = await listPiProviderModels(projectDir, "xai-grok");
    assert.ok(models.some((model) => model.id === "grok-4.6"));

    const selection = await createPiModelSelection({
      workspaceDir: projectDir,
      providerId: "xai-grok",
      modelId: "grok-4.6"
    });
    assert.equal(selection.model.id, "grok-4.6");
    assert.equal(refreshCalls, 1);

    const config = await readProviderConfig(workspaceDir);
    assert.equal(config.providers["xai-grok"].auth?.accessToken, "fresh-grok-access");
    assert.equal(config.providers["xai-grok"].auth?.kind, "oauth");
    const profiles = await readOAuthProfiles(workspaceDir);
    assert.equal(profiles.profiles["xai-grok:default"].auth.accessToken, "fresh-grok-access");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("expired Grok OAuth without a refresh token fails instead of using an API key", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-grok-oauth-norefresh-"));
  try {
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "xai-grok",
      providers: {
        "xai-grok": {
          id: "xai-grok",
          type: "openai_compatible",
          name: "Grok (OAuth)",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-4.6",
          piProviderId: "xai",
          auth: {
            kind: "oauth",
            accessToken: "expired-grok-access",
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }
        },
        "xai-api": {
          id: "xai-api",
          type: "openai_compatible",
          name: "xAI",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-code-fast-1",
          piProviderId: "xai",
          auth: { kind: "api_key", key: "must-not-be-used" }
        }
      }
    });
    await assert.rejects(
      createPiModelSelection({
        workspaceDir: projectDir,
        providerId: "xai-grok",
        modelId: "grok-4.6"
      }),
      /expired|cannot be refreshed|not authenticated/i
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("refreshGrokOAuthToken posts only to the pinned token URL", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), GROK_OAUTH_TOKEN_URL);
      return new Response(JSON.stringify({
        access_token: "rotated",
        refresh_token: "rotated-refresh",
        expires_in: 1800
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const auth = await refreshGrokOAuthToken("old-refresh");
    assert.equal(auth.accessToken, "rotated");
    assert.equal(auth.refreshToken, "rotated-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
