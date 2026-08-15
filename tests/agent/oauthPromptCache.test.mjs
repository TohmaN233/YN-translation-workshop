import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  generatePkcePair,
  buildCodexAuthorizeUrl,
  oauthTokenExpired
} from "../../src/main/agent/openAiCodexOAuthPkce.ts";
import { upsertOAuthProfile, readOAuthProfiles } from "../../src/main/agent/oauthProfilesStore.ts";
import { readProviderConfig } from "../../src/main/agent/providerConfigStore.ts";

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

await test("PKCE pair has verifier and S256 challenge", () => {
  const pair = generatePkcePair();
  assert.ok(pair.verifier.length >= 32);
  assert.ok(pair.challenge.length >= 32);
  const url = buildCodexAuthorizeUrl({ pkce: pair, state: "test-state" });
  assert.match(url, /auth\.openai\.com\/oauth\/authorize/);
  assert.match(url, /code_challenge_method=S256/);
});

await test("oauthTokenExpired respects expiresAt skew", () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  assert.equal(oauthTokenExpired({ kind: "oauth", accessToken: "x", expiresAt: soon }), true);
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  assert.equal(oauthTokenExpired({ kind: "oauth", accessToken: "x", expiresAt: later }), false);
});

await test("oauth profiles persist active profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-oauth-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    await upsertOAuthProfile(workspaceDir, {
      providerId: "openai-chatgpt",
      profileId: "openai-chatgpt:default",
      label: "Main",
      auth: { kind: "oauth", accessToken: "token-a" }
    });
    await upsertOAuthProfile(workspaceDir, {
      providerId: "openai-chatgpt",
      profileId: "openai-chatgpt:alt",
      label: "Alt",
      auth: { kind: "oauth", accessToken: "token-b" },
      makeActive: true
    });
    const doc = await readOAuthProfiles(workspaceDir);
    assert.equal(doc.activeProfileId, "openai-chatgpt:alt");
    assert.equal(doc.profiles["openai-chatgpt:alt"].auth.accessToken, "token-b");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("oauthTokenExpired reads JWT exp when legacy OAuth metadata omits expiresAt", () => {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const expiredToken = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) - 60 })}.signature`;
  const freshToken = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 60 * 60 })}.signature`;

  assert.equal(oauthTokenExpired({ kind: "oauth", accessToken: expiredToken }), true);
  assert.equal(oauthTokenExpired({ kind: "oauth", accessToken: freshToken }), false);
});

await test("corrupt provider config fails fast with its file path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-provider-config-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    const configFile = path.join(workspaceDir, "agent", "provider-config.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, "{broken", "utf8");
    await assert.rejects(
      readProviderConfig(workspaceDir),
      (error) => error instanceof Error && error.message.includes(configFile)
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("corrupt OAuth profile config fails fast with its file path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-oauth-config-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    const profilesFile = path.join(workspaceDir, "agent", "oauth-profiles.json");
    await mkdir(path.dirname(profilesFile), { recursive: true });
    await writeFile(profilesFile, "[]", "utf8");
    await assert.rejects(
      readOAuthProfiles(workspaceDir),
      (error) => error instanceof Error && error.message.includes(profilesFile)
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("legacy preset endpoints migrate to the pinned Pi provider endpoint", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-provider-migration-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    const configFile = path.join(workspaceDir, "agent", "provider-config.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeProviderId: "openai-chatgpt",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          model: "gpt-5.4-mini"
        }
      }
    }), "utf8");
    const config = await readProviderConfig(workspaceDir);
    assert.equal(config.providers["openai-chatgpt"].baseUrl, "https://chatgpt.com/backend-api");
    assert.equal(config.providers["openai-chatgpt"].piProviderId, "openai-codex");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("legacy CLI provider records are discarded before the native Pi product contract", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-provider-cli-migration-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    const configFile = path.join(workspaceDir, "agent", "provider-config.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeProviderId: "codex-cli",
      providers: {
        "codex-cli": { id: "codex-cli", type: "cli", name: "Codex CLI", agent: "codex" }
      }
    }), "utf8");
    const config = await readProviderConfig(workspaceDir);
    assert.equal(config.activeProviderId, "openai-chatgpt");
    assert.equal("codex-cli" in config.providers, false);
    assert.equal(Object.values(config.providers).every((provider) => provider.type === "openai_compatible"), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("malformed provider records are rejected before entering the runtime registry", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-provider-shape-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    const configFile = path.join(workspaceDir, "agent", "provider-config.json");
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({
      activeProviderId: "broken",
      providers: { broken: null }
    }), "utf8");
    await assert.rejects(
      readProviderConfig(workspaceDir),
      (error) => error instanceof Error && error.message.includes(configFile)
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("malformed OAuth profile records are rejected before credential resolution", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-oauth-shape-"));
  try {
    const workspaceDir = path.join(tmp, ".translation-workshop");
    const profilesFile = path.join(workspaceDir, "agent", "oauth-profiles.json");
    await mkdir(path.dirname(profilesFile), { recursive: true });
    await writeFile(profilesFile, JSON.stringify({
      activeProfileId: "broken",
      profiles: { broken: { id: "broken", providerId: "openai-chatgpt" } }
    }), "utf8");
    await assert.rejects(
      readOAuthProfiles(workspaceDir),
      (error) => error instanceof Error && error.message.includes(profilesFile)
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
