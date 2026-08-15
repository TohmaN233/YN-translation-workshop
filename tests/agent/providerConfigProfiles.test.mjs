import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteProviderProfile,
  listProviderDescriptors,
  readProviderConfig,
  saveProviderProfile,
  setProviderEnabled,
  writeProviderConfig
} from "../../src/main/agent/providerConfigStore.ts";

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

await test("legacy renamed custom API becomes a reusable named profile beside a clean template", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tw-provider-profiles-"));
  try {
    await writeProviderConfig(workspaceDir, {
      activeProviderId: "custom-api",
      providers: {
        "custom-api": {
          id: "custom-api",
          type: "openai_compatible",
          name: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: "deepseek-v4-flash",
          models: ["deepseek-v4-flash", "kimi-k2.5"],
          auth: { kind: "api_key", key: "persist-me" }
        }
      }
    });

    const migrated = await readProviderConfig(workspaceDir);
    const named = Object.values(migrated.providers).find((provider) => provider.presetId === "custom-api");
    assert.ok(named, "the renamed legacy custom provider must become a named profile");
    assert.notEqual(named.id, "custom-api");
    assert.equal(named.name, "opencode-go");
    assert.equal(named.auth?.key, "persist-me");
    assert.equal(migrated.providers["custom-api"].name, "Custom API");
    assert.equal(migrated.providers["custom-api"].auth, undefined);
    assert.equal(migrated.activeProviderId, named.id);

    const descriptor = listProviderDescriptors(migrated).find((entry) => entry.id === named.id);
    assert.equal(descriptor?.capabilities?.modelSource, "explicit");
    assert.deepEqual(descriptor?.capabilities?.authModes, ["api_key"]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("named custom profiles can switch, disable, re-enable, and delete without losing credentials", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tw-provider-profile-actions-"));
  try {
    const first = await saveProviderProfile(workspaceDir, {
      id: "custom-api",
      type: "openai_compatible",
      name: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4-flash",
      models: ["deepseek-v4-flash"],
      auth: { kind: "api_key", key: "opencode-key" }
    });
    const firstId = first.activeProviderId;
    assert.match(firstId, /^custom-api:/);
    assert.equal(first.providers[firstId].enabled, true);

    const second = await saveProviderProfile(workspaceDir, {
      id: "custom-api",
      type: "openai_compatible",
      name: "local-qwen",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3",
      models: ["qwen3"],
      auth: { kind: "api_key", key: "local-key" }
    });
    const secondId = second.activeProviderId;
    assert.notEqual(secondId, firstId);
    assert.equal(second.providers[firstId].auth?.key, "opencode-key");

    const disabled = await setProviderEnabled(workspaceDir, firstId, false);
    assert.equal(disabled.providers[firstId].enabled, false);
    assert.equal(disabled.providers[firstId].auth?.key, "opencode-key");

    const reenabled = await setProviderEnabled(workspaceDir, firstId, true);
    assert.equal(reenabled.providers[firstId].enabled, true);
    assert.equal(reenabled.activeProviderId, firstId);

    const deleted = await deleteProviderProfile(workspaceDir, firstId);
    assert.equal(deleted.providers[firstId], undefined);
    assert.ok(deleted.providers[secondId]);
    await assert.rejects(deleteProviderProfile(workspaceDir, "custom-api"), /template cannot be deleted/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

console.log(`provider config profiles: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
