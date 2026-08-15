import { strict as assert } from "node:assert";

import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { listModelsForProvider } from "../../src/shared/agent/providerModels.ts";
import { getProviderDescriptor, PROVIDER_PRESETS } from "../../src/shared/agent/providerPresets.ts";
import { THINKING_LEVEL_OPTIONS } from "../../src/shared/agent/thinkingLevels.ts";

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

await test("standard provider model lists come directly from the pinned Pi registry", () => {
  const cases = [
    ["openai-chatgpt", openaiCodexProvider()],
    ["anthropic-claude", anthropicProvider()],
    ["deepseek-api", deepseekProvider()]
  ];
  for (const [providerId, piProvider] of cases) {
    assert.deepEqual(
      listModelsForProvider(providerId).map((model) => ({ id: model.id, label: model.label })),
      piProvider.getModels().map((model) => ({ id: model.id, label: model.name })),
      `${providerId} must expose the pinned Pi provider catalog without a hand-written copy`
    );
  }
});

await test("common OpenAI-compatible providers are first-class presets, not only custom API", () => {
  const ids = PROVIDER_PRESETS.map((preset) => preset.id);
  for (const id of [
    "deepseek-api",
    "openrouter-api",
    "zhipu-glm-api",
    "qwen-dashscope-api",
    "moonshot-kimi-api",
    "gemini-openai-api",
    "groq-api",
    "xai-api",
    "siliconflow-api"
  ]) {
    assert.ok(ids.includes(id), `${id} should be a provider preset`);
    assert.ok(PROVIDER_PRESETS.find((preset) => preset.id === id)?.config.model, `${id} should have an explicit default model`);
  }
});

await test("provider descriptor exposes Pi-style runtime capabilities", () => {
  const chatgpt = getProviderDescriptor("openai-chatgpt");
  assert.equal(chatgpt?.capabilities.authModes[0], "oauth");
  assert.equal(chatgpt?.capabilities.cacheStrategy, "prompt_cache_key");
  assert.equal(chatgpt?.capabilities.supportsReasoning, true);
  assert.ok(listModelsForProvider("openai-chatgpt").some((model) => model.id === "gpt-5.5"));
  for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.ok(listModelsForProvider("openai-chatgpt").some((model) => model.id === modelId));
  }
  assert.ok(THINKING_LEVEL_OPTIONS.some((level) => level.id === "max"));

  const claude = getProviderDescriptor("anthropic-claude");
  assert.equal(claude?.capabilities.authModes[0], "oauth");
  assert.equal(claude?.capabilities.cacheStrategy, "anthropic_cache_control");
  assert.equal(claude?.capabilities.supportsReasoning, false);

  const custom = getProviderDescriptor("custom-api");
  assert.deepEqual(custom?.capabilities.authModes, ["api_key"]);
  assert.equal(custom?.defaultModel, "gpt-4.1");
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
