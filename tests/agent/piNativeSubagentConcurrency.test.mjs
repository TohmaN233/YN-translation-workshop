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
let startedChildren = 0;
const models = createModels();

const workspaces = [];
const runs = [];
const supervisors = [];
try {
  for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), `yn-pi-no-cap-${workflowIndex}-`));
    workspaces.push(outputDir);
    const sourcePath = path.join(outputDir, "source.txt");
    await writeFile(sourcePath, "one\ntwo", "utf8");
    const provider = fauxProvider({ provider: `no-cap-workflow-${workflowIndex}`, tokensPerSecond: 10_000 });
    provider.setResponses(Array.from({ length: 2 }, () => async () => {
      startedChildren += 1;
      if (startedChildren === expectedChildren) allChildrenEntered.resolve();
      await releaseChildren.promise;
      throw new Error(`concurrency probe released ${provider.provider.id}`);
    }));
    models.setProvider(provider.provider);
    const createSubagentModelSelection = async ({ providerId }) => {
      assert.equal(providerId, provider.provider.id, `unexpected child provider ${providerId}`);
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
        subagentCount: 2,
        subagentProviderId: provider.provider.id,
        subagentModelId: provider.getModel().id,
        translationSplitSize: 1
      },
      publishCustomMessage: async () => {},
      createSubagentModelSelection,
      subagents
    });
    const tool = tools.find((entry) => entry.name === "runTranslationSubagents");
    assert.ok(tool, "missing runTranslationSubagents tool");
    runs.push(tool.execute(`no_cap_${workflowIndex}`, { workerCount: 2 }));
  }

  await Promise.race([
    allChildrenEntered.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `only ${startedChildren}/${expectedChildren} native Pi children entered before release: ${JSON.stringify(supervisors.flatMap((supervisor) => supervisor.list()))}`
    )), 3_000))
  ]);
  assert.equal(startedChildren, expectedChildren);
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
