import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

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

await test("App setup exposes only current Agent network settings", async () => {
  const source = await readFile("src/renderer/App.tsx", "utf8");
  assert.doesNotMatch(source, /skillInstallCommand|skillInstallStatus|copySkillInstallCommand|bundledSkills/);
  assert.match(source, /agentProxyEnabled/);
  assert.match(source, /agentProxyUrl/);
  assert.match(source, /agentProxyEnabled:\s*false/);
});

await test("Pi Agent window contains no retired external-install controls", async () => {
  const chatInput = await readFile("src/renderer/agent/piweb/ChatInput.tsx", "utf8");
  const settings = await readFile("src/renderer/agent/piweb/ProviderSettingsPanel.tsx", "utf8");
  assert.doesNotMatch(chatInput, /external-install controls/i);
  assert.doesNotMatch(settings, /external-install controls/i);
});

await test("provider settings edits explicit model ids using project-scoped Pi model discovery", async () => {
  const settings = await readFile("src/renderer/agent/piweb/ProviderSettingsPanel.tsx", "utf8");
  const locale = await readFile("src/renderer/agent/piweb/i18n.ts", "utf8");
  assert.match(settings, /\{p\.modelIds\}/);
  assert.match(locale, /modelIds: "Model IDs \(one per line\)"/);
  assert.match(settings, /listAgentModels\(\{\s*outputDir,\s*providerId:/);
  assert.match(settings, /modelIdsDraft/);
  assert.match(settings, /value=\{modelIdsDraft\}/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
