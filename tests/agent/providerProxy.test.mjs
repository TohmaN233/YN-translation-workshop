import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchWithProxy, resolveProviderProxyUrl } from "../../src/main/agent/providers/proxyFetch.ts";

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

await test("provider proxy stays disabled when project has no setting", async () => {
  assert.equal(
    await resolveProviderProxyUrl({ env: { HTTPS_PROXY: "http://127.0.0.1:7890" } }),
    ""
  );
});

await test("project proxy switch overrides environment proxy", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tw-provider-proxy-"));
  try {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "project.json"), JSON.stringify({
      agentProxyEnabled: false,
      agentProxyUrl: "http://127.0.0.1:7890"
    }), "utf8");
    assert.equal(
      await resolveProviderProxyUrl({ workspaceDir, env: { HTTPS_PROXY: "http://127.0.0.1:7890" } }),
      ""
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("project root resolves proxy settings from .translation-workshop", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-provider-project-proxy-"));
  try {
    const workspaceDir = path.join(projectDir, ".translation-workshop");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "project.json"), JSON.stringify({
      agentProxyEnabled: true,
      agentProxyUrl: "http://127.0.0.1:3067"
    }), "utf8");
    assert.equal(
      await resolveProviderProxyUrl({ workspaceDir: projectDir, env: {} }),
      "http://127.0.0.1:3067"
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

await test("fetchWithProxy attaches a dispatcher when proxy is enabled", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tw-provider-enabled-proxy-"));
  const originalFetch = globalThis.fetch;
  let capturedInit;
  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return new Response("ok");
  };
  try {
    await writeFile(path.join(workspaceDir, "project.json"), JSON.stringify({
      agentProxyEnabled: true,
      agentProxyUrl: "http://127.0.0.1:7890"
    }), "utf8");
    await fetchWithProxy("https://chatgpt.com/backend-api/codex/responses", {}, {
      workspaceDir
    });
    assert.ok(capturedInit?.dispatcher);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
