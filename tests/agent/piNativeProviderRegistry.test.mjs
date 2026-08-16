import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createPiModelSelection,
  listPiConfiguredModels,
  listPiProviderModels,
  readPiLocalOAuthCredential
} from "../../src/main/agent/piNative/providerRegistry.ts";
import { readOAuthProfiles } from "../../src/main/agent/oauthProfilesStore.ts";
import { readProviderConfig } from "../../src/main/agent/providerConfigStore.ts";
import { writeProviderConfig } from "../../src/main/agent/providerConfigStore.ts";

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

await test("custom OpenAI-compatible providers expose explicit model ids and declared image support to Pi", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-provider-"));
  try {
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "custom-api:local-translator",
      providers: {
        "custom-api:local-translator": {
          id: "custom-api:local-translator",
          presetId: "custom-api",
          type: "openai_compatible",
          name: "Local translator",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "translator-main",
          models: ["translator-main", "proofreader-fast", "translator-main"],
          supportsImages: true,
          auth: { kind: "api_key", key: "local-key" }
        }
      }
    });

    const models = await listPiProviderModels(projectDir, "custom-api:local-translator");
    assert.deepEqual(models.map((model) => model.id), ["translator-main", "proofreader-fast"]);
    assert.ok(models.every((model) => model.supportsImages === true));

    const selection = await createPiModelSelection({
      workspaceDir: projectDir,
      providerId: "custom-api:local-translator",
      modelId: "proofreader-fast"
    });
    assert.equal(selection.model.id, "proofreader-fast");
    assert.equal(selection.model.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(selection.model.reasoning, false, "unknown custom models must not receive unsupported reasoning parameters");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("disabled providers retain their settings without entering the configured Pi model catalog", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-provider-disabled-"));
  try {
    await writeProviderConfig(path.join(projectDir, ".translation-workshop"), {
      activeProviderId: "custom-api:opencode-go",
      providers: {
        "custom-api:opencode-go": {
          id: "custom-api:opencode-go",
          presetId: "custom-api",
          type: "openai_compatible",
          name: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: "deepseek-v4-flash",
          models: ["deepseek-v4-flash", "kimi-k2.5"],
          enabled: false,
          auth: { kind: "api_key", key: "saved-but-disabled" }
        }
      }
    });

    const configured = await listPiConfiguredModels(projectDir);
    assert.equal(
      configured.some((model) => model.providerId === "custom-api:opencode-go" && model.authenticated),
      false,
      "a disabled provider must not add its models to the chat picker"
    );
    await assert.rejects(
      createPiModelSelection({
        workspaceDir: projectDir,
        providerId: "custom-api:opencode-go",
        modelId: "deepseek-v4-flash"
      }),
      /not enabled/
    );

    const stored = await readProviderConfig(path.join(projectDir, ".translation-workshop"));
    assert.equal(stored.providers["custom-api:opencode-go"].auth?.key, "saved-but-disabled");
    assert.deepEqual(stored.providers["custom-api:opencode-go"].models, ["deepseek-v4-flash", "kimi-k2.5"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("ChatGPT OAuth can use an explicitly imported pinned Pi auth.json credential", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-oauth-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piAgentDir = path.join(projectDir, "pi-agent");
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(path.join(piAgentDir, "auth.json"), JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "pi-local-access",
        refresh: "pi-local-refresh",
        expires: Date.now() + 60 * 60_000
      }
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = piAgentDir;

    const credential = await readPiLocalOAuthCredential("openai-chatgpt");
    assert.equal(credential?.access, "pi-local-access");
    await writeProviderConfig(path.join(projectDir, ".translation-workshop"), {
      activeProviderId: "openai-chatgpt",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-5.4-mini",
          piProviderId: "openai-codex",
          auth: {
            kind: "oauth",
            accessToken: credential.access,
            refreshToken: credential.refresh || undefined,
            expiresAt: Number.isFinite(credential.expires) && credential.expires < Number.MAX_SAFE_INTEGER
              ? new Date(credential.expires).toISOString()
              : undefined
          }
        }
      }
    });

    const selection = await createPiModelSelection({
      workspaceDir: projectDir,
      providerId: "openai-chatgpt",
      modelId: "gpt-5.4-mini"
    });
    assert.equal(selection.model.id, "gpt-5.4-mini");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("ChatGPT OAuth refreshes an expired legacy JWT before Pi receives it", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-oauth-refresh-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const token = (expiresInSeconds) => `${encode({ alg: "none" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-refresh-test" }
  })}.signature`;
  const expiredAccess = token(-60);
  const refreshedAccess = token(60 * 60);
  let refreshCalls = 0;

  try {
    process.env.PI_CODING_AGENT_DIR = path.join(projectDir, "missing-pi-auth");
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "openai-chatgpt",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-5.6-luna",
          piProviderId: "openai-codex",
          auth: {
            kind: "oauth",
            accessToken: expiredAccess,
            refreshToken: "legacy-refresh-token"
          }
        }
      }
    });

    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://auth.openai.com/oauth/token");
      assert.match(String(init?.body), /grant_type=refresh_token/);
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: refreshedAccess,
        refresh_token: "next-refresh-token",
        expires_in: 3600
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const selection = await createPiModelSelection({
      workspaceDir: projectDir,
      providerId: "openai-chatgpt",
      modelId: "gpt-5.6-luna"
    });
    assert.equal(selection.model.id, "gpt-5.6-luna");
    assert.equal(refreshCalls, 1, "the stale project credential must pass through OAuth refresh before Pi use");

    const config = await readProviderConfig(workspaceDir);
    assert.equal(config.providers["openai-chatgpt"].auth?.accessToken, refreshedAccess);
    const profiles = await readOAuthProfiles(workspaceDir);
    assert.equal(profiles.profiles["openai-chatgpt:default"].auth.accessToken, refreshedAccess);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("ChatGPT OAuth adopts a newer same-account Codex credential before refreshing stale project state", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-oauth-newer-local-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const originalFetch = globalThis.fetch;
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const token = (expiresInSeconds) => `${encode({ alg: "none" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-same-user" }
  })}.signature`;
  const expiredAccess = token(-60);
  const currentAccess = token(10 * 24 * 60 * 60);

  try {
    process.env.PI_CODING_AGENT_DIR = path.join(projectDir, "missing-pi-auth");
    const codexHome = path.join(projectDir, "codex-home");
    process.env.CODEX_HOME = codexHome;
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: currentAccess,
        refresh_token: "current-refresh-token",
        account_id: "acct-same-user"
      }
    }), "utf8");

    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "openai-chatgpt",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-5.6-luna",
          piProviderId: "openai-codex",
          auth: {
            kind: "oauth",
            accessToken: expiredAccess,
            refreshToken: "already-used-refresh-token"
          }
        }
      }
    });

    globalThis.fetch = async () => {
      throw new Error("the stale refresh token must not be called when newer same-account local auth exists");
    };

    const selection = await createPiModelSelection({
      workspaceDir: projectDir,
      providerId: "openai-chatgpt",
      modelId: "gpt-5.6-luna"
    });
    assert.equal(selection.model.id, "gpt-5.6-luna");

    const config = await readProviderConfig(workspaceDir);
    assert.equal(config.providers["openai-chatgpt"].auth?.accessToken, currentAccess);
    assert.ok(config.providers["openai-chatgpt"].auth?.expiresAt);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("listing configured models does not refresh ChatGPT OAuth", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-oauth-single-flight-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const originalFetch = globalThis.fetch;
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const token = (expiresInSeconds) => `${encode({ alg: "none" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-single-flight" }
  })}.signature`;
  let refreshCalls = 0;

  try {
    process.env.PI_CODING_AGENT_DIR = path.join(projectDir, "missing-pi-auth");
    process.env.CODEX_HOME = path.join(projectDir, "missing-codex-home");
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "openai-chatgpt",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-5.6-luna",
          piProviderId: "openai-codex",
          auth: {
            kind: "oauth",
            accessToken: token(-60),
            refreshToken: "single-use-refresh-token"
          }
        }
      }
    });

    globalThis.fetch = async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        access_token: token(60 * 60),
        refresh_token: "rotated-refresh-token",
        expires_in: 3600
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    await Promise.all([
      listPiConfiguredModels(projectDir),
      listPiConfiguredModels(projectDir),
      listPiConfiguredModels(projectDir)
    ]);
    assert.equal(refreshCalls, 0, "model catalog listing must not consume a refresh token");

    await Promise.all([
      createPiModelSelection({ workspaceDir: projectDir, providerId: "openai-chatgpt", modelId: "gpt-5.6-luna" }),
      createPiModelSelection({ workspaceDir: projectDir, providerId: "openai-chatgpt", modelId: "gpt-5.6-luna" }),
      createPiModelSelection({ workspaceDir: projectDir, providerId: "openai-chatgpt", modelId: "gpt-5.6-luna" })
    ]);
    assert.equal(refreshCalls, 1, "actual model selection must single-flight one OAuth refresh");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("all models from every configured provider remain selectable together", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-multi-provider-"));
  try {
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "openai-api",
      providers: {
        "openai-api": {
          id: "openai-api",
          type: "openai_compatible",
          name: "OpenAI API",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.4-mini",
          piProviderId: "openai",
          auth: { kind: "api_key", key: "openai-key" }
        },
        "deepseek-api": {
          id: "deepseek-api",
          type: "openai_compatible",
          name: "DeepSeek API",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          piProviderId: "deepseek",
          auth: { kind: "api_key", key: "deepseek-key" }
        },
        "custom-api:local": {
          id: "custom-api:local",
          presetId: "custom-api",
          type: "openai_compatible",
          name: "Local",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "local-a",
          models: ["local-a", "local-b"],
          auth: { kind: "api_key", key: "local-key" }
        }
      }
    });

    const configured = (await listPiConfiguredModels(projectDir)).filter((entry) => entry.authenticated);
    for (const providerId of ["openai-api", "deepseek-api", "custom-api:local"]) {
      const expected = await listPiProviderModels(projectDir, providerId);
      const actual = configured.filter((entry) => entry.providerId === providerId);
      assert.deepEqual(actual.map((entry) => entry.modelId), expected.map((entry) => entry.id));
      assert.deepEqual(actual.map((entry) => entry.supportsImages), expected.map((entry) => entry.supportsImages));
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("an unlinked local Claude Code login does not activate Claude models", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-unlinked-claude-"));
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const claudeConfigDir = path.join(projectDir, "claude-home");
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(path.join(claudeConfigDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "unlinked-local-claude-token",
        refreshToken: "unlinked-local-claude-refresh"
      }
    }), "utf8");
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    process.env.PI_CODING_AGENT_DIR = path.join(projectDir, "missing-pi-auth");

    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "custom-api:configured",
      providers: {
        "custom-api:configured": {
          id: "custom-api:configured",
          presetId: "custom-api",
          type: "openai_compatible",
          name: "Configured custom API",
          baseUrl: "https://example.test/v1",
          model: "configured-model",
          models: ["configured-model"],
          auth: { kind: "api_key", key: "configured-key" }
        }
      }
    });

    const configured = (await listPiConfiguredModels(projectDir))
      .filter((entry) => entry.authenticated);
    assert.ok(configured.some((entry) => entry.providerId === "custom-api:configured"));
    assert.equal(
      configured.some((entry) => entry.providerId === "anthropic-claude"),
      false,
      "local Claude Code credentials must require an explicit project import before entering the model picker"
    );
  } finally {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("corrupt Pi auth config fails fast with its file path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tw-pi-auth-corrupt-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const authFile = path.join(tmp, "auth.json");
    await writeFile(authFile, "{broken", "utf8");
    process.env.PI_CODING_AGENT_DIR = tmp;
    await assert.rejects(
      readPiLocalOAuthCredential("openai-chatgpt"),
      (error) => error instanceof Error && error.message.includes(authFile)
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

await test("listing another provider's models does not refresh ChatGPT OAuth", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-list-models-no-refresh-"));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("OAuth refresh must not run while listing another provider");
    };
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "deepseek-api",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-5.5",
          piProviderId: "openai-codex",
          auth: {
            kind: "oauth",
            accessToken: "stale-chatgpt",
            refreshToken: "chatgpt-refresh",
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }
        },
        "deepseek-api": {
          id: "deepseek-api",
          type: "openai_compatible",
          name: "DeepSeek API",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          piProviderId: "deepseek",
          auth: { kind: "api_key", key: "deepseek-key" }
        }
      }
    });
    const models = await listPiProviderModels(projectDir, "deepseek-api");
    assert.ok(models.some((model) => model.id === "deepseek-v4-flash"));
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("a dead ChatGPT refresh token does not hide other configured models", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-list-configured-isolated-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "Your refresh token has already been used to generate a new access token. Please try signing in again.", code: "refresh_token_reused" }
    }), { status: 401, headers: { "Content-Type": "application/json" } });
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "deepseek-api",
      providers: {
        "openai-chatgpt": {
          id: "openai-chatgpt",
          type: "openai_compatible",
          name: "ChatGPT (OAuth)",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-5.5",
          piProviderId: "openai-codex",
          auth: {
            kind: "oauth",
            accessToken: "stale-chatgpt",
            refreshToken: "used-refresh",
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }
        },
        "deepseek-api": {
          id: "deepseek-api",
          type: "openai_compatible",
          name: "DeepSeek API",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          piProviderId: "deepseek",
          auth: { kind: "api_key", key: "deepseek-key" }
        }
      }
    });
    const configured = await listPiConfiguredModels(projectDir);
    assert.ok(configured.some((entry) => entry.providerId === "deepseek-api" && entry.authenticated));
    await assert.rejects(
      createPiModelSelection({
        workspaceDir: projectDir,
        providerId: "openai-chatgpt",
        modelId: "gpt-5.5"
      }),
      /401|refresh token|sign in again/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("Grok OAuth injects official grok-4.6 effort levels without inventing GPT tiers", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-pi-grok-thinking-"));
  try {
    await writeProviderConfig(path.join(projectDir, ".translation-workshop"), {
      activeProviderId: "xai-grok",
      providers: {
        "xai-grok": {
          id: "xai-grok",
          type: "openai_compatible",
          name: "Grok (OAuth)",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-4.6",
          piProviderId: "xai"
        },
        "custom-api:named-grok": {
          id: "custom-api:named-grok",
          presetId: "custom-api",
          type: "openai_compatible",
          name: "Named Grok",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "grok-4.6",
          models: ["grok-4.6", "translator-main"],
          auth: { kind: "api_key", key: "local-key" }
        }
      }
    });
    const configured = await listPiConfiguredModels(projectDir);
    const grok46 = configured.find((entry) => entry.providerId === "xai-grok" && entry.modelId === "grok-4.6");
    const grokFast = configured.find((entry) => entry.providerId === "xai-grok" && entry.modelId === "grok-code-fast-1");
    const grok43 = configured.find((entry) => entry.providerId === "xai-grok" && entry.modelId === "grok-4.3");
    assert.deepEqual(grok46?.thinkingLevels, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(grokFast?.thinkingLevels, ["off"]);
    assert.deepEqual(grok43?.thinkingLevels, ["off"]);

    const selection = await createPiModelSelection({
      workspaceDir: projectDir,
      providerId: "custom-api:named-grok",
      modelId: "grok-4.6"
    });
    assert.equal(selection.model.reasoning, true);
    assert.equal(selection.model.compat?.supportsReasoningEffort, true);
    assert.deepEqual(selection.model.thinkingLevelMap?.low, "low");
    assert.equal(selection.model.thinkingLevelMap?.off, null);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
