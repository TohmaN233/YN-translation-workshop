import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configureGlobalAgentDataDir } from "../../src/main/agent/agentDataDir.ts";
import {
  readProviderConfig,
  saveProviderProfile
} from "../../src/main/agent/providerConfigStore.ts";
import {
  readOAuthProfiles,
  upsertOAuthProfile
} from "../../src/main/agent/oauthProfilesStore.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "tw-global-provider-scope-"));
const userDataDir = path.join(root, "user-data");
const workspaceA = path.join(root, "project-a", ".translation-workshop");
const workspaceB = path.join(root, "project-b", ".translation-workshop");

try {
  const legacyAgentDir = path.join(workspaceA, "agent");
  await mkdir(legacyAgentDir, { recursive: true });
  await writeFile(path.join(legacyAgentDir, "provider-config.json"), JSON.stringify({
    activeProviderId: "deepseek-api",
    providers: {
      "deepseek-api": {
        id: "deepseek-api",
        type: "openai_compatible",
        name: "DeepSeek API",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        models: ["deepseek-chat"],
        enabled: true,
        auth: { kind: "api_key", key: "global-deepseek-key" }
      }
    }
  }, null, 2), "utf8");
  await writeFile(path.join(legacyAgentDir, "oauth-profiles.json"), JSON.stringify({
    activeProfileId: "openai-chatgpt:default",
    profiles: {
      "openai-chatgpt:default": {
        id: "openai-chatgpt:default",
        label: "Codex",
        providerId: "openai-chatgpt",
        auth: { kind: "oauth", accessToken: "global-codex-token" },
        updatedAt: "2026-07-18T00:00:00.000Z"
      }
    }
  }, null, 2), "utf8");

  configureGlobalAgentDataDir(userDataDir);

  const migratedProvider = await readProviderConfig(workspaceA);
  assert.equal(migratedProvider.providers["deepseek-api"].auth?.key, "global-deepseek-key");
  const migratedOAuth = await readOAuthProfiles(workspaceA);
  assert.equal(migratedOAuth.profiles["openai-chatgpt:default"].auth.accessToken, "global-codex-token");

  await saveProviderProfile(workspaceA, {
    id: "custom-api",
    type: "openai_compatible",
    name: "shared-custom",
    baseUrl: "https://example.invalid/v1",
    model: "shared-model",
    models: ["shared-model"],
    auth: { kind: "api_key", key: "shared-key" }
  });
  await upsertOAuthProfile(workspaceA, {
    providerId: "openai-chatgpt",
    profileId: "openai-chatgpt:second",
    label: "Codex second",
    auth: { kind: "oauth", accessToken: "second-token" }
  });

  const providerFromOtherProject = await readProviderConfig(workspaceB);
  assert.ok(Object.values(providerFromOtherProject.providers).some((provider) => (
    provider.name === "shared-custom" && provider.auth?.key === "shared-key"
  )));
  const oauthFromOtherProject = await readOAuthProfiles(workspaceB);
  assert.equal(oauthFromOtherProject.profiles["openai-chatgpt:second"].auth.accessToken, "second-token");

  const globalAgentDir = path.join(userDataDir, "agent");
  assert.ok(JSON.parse(await readFile(path.join(globalAgentDir, "provider-config.json"), "utf8")));
  assert.ok(JSON.parse(await readFile(path.join(globalAgentDir, "oauth-profiles.json"), "utf8")));

  const mainSource = await readFile(path.resolve("src/main/main.ts"), "utf8");
  const readyIndex = mainSource.indexOf("app.whenReady().then");
  const globalConfigIndex = mainSource.indexOf("configureGlobalAgentDataDir(app.getPath(\"userData\"))", readyIndex);
  const ipcIndex = mainSource.indexOf("await ensureAgentIpcRegistered()", readyIndex);
  assert.ok(readyIndex >= 0 && globalConfigIndex > readyIndex && ipcIndex > globalConfigIndex);
  const rendererSource = await readFile(path.resolve("src/renderer/agent/piweb/useAgentSession.ts"), "utf8");
  assert.match(rendererSource, /payload\.scope !== "global"/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ok provider, model, API, and OAuth configuration is global across projects with legacy migration");
