import { strict as assert } from "node:assert";

import { rebuildNewProjectForm } from "../../src/renderer/newProjectForm.ts";

const defaults = {
  outputDir: "",
  translateOutputDir: "",
  proofreadOutputDir: "",
  sourcePath: "",
  style: "game",
  languagePair: "ja->zh-CN",
  splitSize: 1000,
  agentProxyEnabled: false,
  agentProxyUrl: "http://127.0.0.1:3067"
};

const previous = {
  outputDir: "E:\\novel\\old",
  translateOutputDir: "E:\\novel\\old\\AI_translation",
  proofreadOutputDir: "E:\\novel\\old\\report",
  sourcePath: "E:\\novel\\new.epub",
  style: "light novel",
  languagePair: "en->zh-CN",
  splitSize: 500,
  agentProxyEnabled: true,
  agentProxyUrl: "http://127.0.0.1:7890"
};

const rebuilt = rebuildNewProjectForm(
  defaults,
  previous,
  new Set(["sourcePath", "style", "splitSize"]),
  "E:\\novel\\new-project"
);

assert.deepEqual(rebuilt, {
  ...defaults,
  sourcePath: "E:\\novel\\new.epub",
  style: "light novel",
  splitSize: 500,
  outputDir: "E:\\novel\\new-project",
  translateOutputDir: "E:\\novel\\new-project\\AI_translation",
  proofreadOutputDir: "E:\\novel\\new-project\\report"
});

console.log("ok new project keeps only user-selected parameters and rebases derived paths");

const explicitlySelectedProxy = rebuildNewProjectForm(
  defaults,
  previous,
  new Set(["agentProxyEnabled", "agentProxyUrl", "translateOutputDir"]),
  "E:\\novel\\another-project"
);

assert.equal(explicitlySelectedProxy.agentProxyEnabled, true);
assert.equal(explicitlySelectedProxy.agentProxyUrl, "http://127.0.0.1:7890");
assert.equal(explicitlySelectedProxy.translateOutputDir, "E:\\novel\\another-project\\AI_translation");
console.log("ok explicit proxy selection survives while project-derived paths cannot be carried over");
