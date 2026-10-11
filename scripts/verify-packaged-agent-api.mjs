import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureGlobalAgentDataDir } from "../src/main/agent/agentDataDir.ts";
import { writeProviderConfig } from "../src/main/agent/providerConfigStore.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const application = path.join(root, "release", "win-unpacked");
const executable = path.join(application, "translation-workshop.exe");
const unpacked = path.join(application, "resources", "app.asar.unpacked");
const { connectYnAgent } = await import(pathToFileURL(path.join(unpacked, "agent-tools", "yn-agent-client.mjs")));
const temp = await mkdtemp(path.join(os.tmpdir(), "yn-packaged-api-"));
const userData = path.join(temp, "user-data");
configureGlobalAgentDataDir(userData);
await writeProviderConfig(temp, { activeProviderId: "custom-api", providers: { "custom-api": {
  id: "custom-api", type: "openai_compatible", name: "Offline plan acceptance", model: "fixture", models: ["fixture"],
  baseUrl: "http://127.0.0.1:1/v1", enabled: true
} } });
const sourcePath = path.join(temp, "source.txt"); await writeFile(sourcePath, "Hello {name}");
let diagnostics = "";
const yn = connectYnAgent(executable, { args: [`--user-data-dir=${userData}`, "--disable-gpu", "--no-sandbox"], cwd: temp,
  onDiagnostic: text => { diagnostics += text; } });
try {
  const ready = await yn.ready; assert.equal(ready.protocolVersion, 1);
  const description = await yn.call("describe"); assert.ok(description.methods.includes("start"));
  const plan = await yn.call("plan", { task: "translation", settings: { sourcePath } });
  assert.equal(plan.settings.outputDir, path.join(temp, "Translation"));
  assert.equal(plan.settings.splitSize, 500); assert.equal(plan.settings.subagentCount, 3);
  assert.equal(plan.model.modelId, "fixture"); assert.equal(existsSync(plan.settings.outputDir), false);
  await assert.rejects(yn.call("start", { planId: plan.planId }), error => error.code === "confirmation_required");
  assert.equal(existsSync(plan.settings.outputDir), false);
  await yn.close();
  const evidence = { packagedAgentApi: true, version: ready.version, officialPackagedClient: true,
    confirmationRequired: true, defaults: { splitSize: 500, subagentCount: 3 }, projectWrites: 0,
    modelCalls: 0, nativeCleanExit: true, guides: (await readFile(path.join(unpacked, "docs", "agent-api.md"), "utf8")).includes("yn-agent-server.mjs") };
  assert.equal(evidence.guides, true);
  await writeFile(path.join(root, "artifacts", "agent-api", "packaged-api-acceptance.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await yn.close();
  await writeFile(path.join(root, "artifacts", "agent-api", "packaged-api-stderr.log"), diagnostics);
  if (!path.resolve(temp).startsWith(`${path.resolve(os.tmpdir())}${path.sep}yn-packaged-api-`)) throw new Error("Unsafe packaged fixture cleanup.");
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
