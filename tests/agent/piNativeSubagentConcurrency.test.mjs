import { strict as assert } from "node:assert";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const root = path.resolve(import.meta.dirname, "../..");
const piNativeDir = path.join(root, "src/main/agent/piNative");
const limiterPath = path.join(piNativeDir, "subagentConcurrency.ts");

await assert.rejects(
  () => access(limiterPath),
  (error) => error?.code === "ENOENT",
  "the product must not carry a process-wide child-harness concurrency limiter"
);

const sourceNames = (await readdir(piNativeDir, { recursive: true }))
  .filter((name) => name.endsWith(".ts"));
const productSources = await Promise.all(sourceNames.map(async (name) => ({
  name,
  source: await readFile(path.join(piNativeDir, name), "utf8")
})));

for (const { name, source } of productSources) {
  assert.doesNotMatch(source, /subagentConcurrency|runWithYnSubagentSlot|YN_MAX_CONCURRENT_SUBAGENTS/,
    `${name} still depends on the removed global limiter`);
  assert.doesNotMatch(source, /at most five child|最多(?:并行)?五个|concurrency ceiling of five/i,
    `${name} still teaches the model a nonexistent product limit`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const workflowCount = 3;
const expectedChildren = workflowCount * 2;
const allChildrenEntered = deferred();
const releaseChildren = deferred();
const startedProviders = new Set();
const models = createModels();
const providers = new Map();

for (let index = 0; index < expectedChildren; index += 1) {
  const provider = fauxProvider({ provider: `no-cap-child-${index}`, tokensPerSecond: 10_000 });
  provider.setResponses([
    async () => {
      startedProviders.add(provider.provider.id);
      if (startedProviders.size === expectedChildren) allChildrenEntered.resolve();
      await releaseChildren.promise;
      throw new Error(`concurrency probe released ${provider.provider.id}`);
    }
  ]);
  models.setProvider(provider.provider);
  providers.set(provider.provider.id, provider);
}

const workspaces = [];
const runs = [];
const supervisors = [];
try {
  for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), `yn-pi-no-cap-${workflowIndex}-`));
    workspaces.push(outputDir);
    const sourcePath = path.join(outputDir, "source.txt");
    await writeFile(sourcePath, "one\ntwo", "utf8");
    const createSubagentModelSelection = async ({ providerId }) => {
      const provider = providers.get(providerId);
      assert.ok(provider, `unexpected child provider ${providerId}`);
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    };
    const subagents = new YnSubagentSupervisor({
      publishCustomMessage: async () => {},
      createModelSelection: createSubagentModelSelection
    });
    supervisors.push(subagents);
    const tools = createYnDomainTools({
      request: {
        outputDir,
        sourcePath,
        sessionId: `pi_no_cap_${workflowIndex}`,
        prompt: "translate with two native Pi children",
        providerId: "parent",
        modelId: "parent",
        languagePair: "en->zh-CN",
        subagentEnabled: true,
        subagentCount: 2
      },
      publishCustomMessage: async () => {},
      createSubagentModelSelection,
      subagents
    });
    const tool = tools.find((entry) => entry.name === "runTranslationSubagents");
    assert.ok(tool, "missing runTranslationSubagents tool");
    const firstProvider = `no-cap-child-${workflowIndex * 2}`;
    const secondProvider = `no-cap-child-${workflowIndex * 2 + 1}`;
    runs.push(tool.execute(`no_cap_${workflowIndex}`, {
      tasks: [
        { fromLine: 1, toLine: 1, providerId: firstProvider },
        { fromLine: 2, toLine: 2, providerId: secondProvider }
      ]
    }));
  }

  await Promise.race([
    allChildrenEntered.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `only ${startedProviders.size}/${expectedChildren} native Pi children entered before release: ${JSON.stringify(supervisors.flatMap((supervisor) => supervisor.list()))}`
    )), 3_000))
  ]);
  assert.equal(startedProviders.size, expectedChildren);
} finally {
  releaseChildren.resolve();
  const outcomes = await Promise.allSettled(runs);
  assert.equal(outcomes.length, workflowCount);
  assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"),
    "background spawn tools should return before their children settle");
  await Promise.all(supervisors.map((supervisor) => supervisor.waitForAll()));
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
}

console.log(`ok ${expectedChildren} native Pi children entered concurrently with no product-wide fixed ceiling`);
