import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

import {
  getWorkflowTemplate,
  workflowTemplates
} from "../../src/shared/agent/workflowTemplates.ts";

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

await test("workflow templates select the prompt mode without a legacy job contract", () => {
  assert.deepEqual(workflowTemplates.map((template) => template.id), ["initial_translation", "proofread"]);
  assert.equal(getWorkflowTemplate("initial_translation")?.promptKind, "translate");
  assert.equal(getWorkflowTemplate("proofread")?.promptKind, "proofread");
  assert.equal(getWorkflowTemplate("terminology_sweep")?.id, "initial_translation");
  for (const template of workflowTemplates) {
    assert.equal("jobType" in template, false);
  }
});

await test("workflow templates declare their primary artifact protocol", () => {
  const expected = new Map([
    ["initial_translation", ["translation_candidate", "{translationOutputDir}/{document}_translated.txt"]],
    ["proofread", ["findings_json", "{reportOutputDir}/{document}.proofread.json"]]
  ]);
  for (const template of workflowTemplates) {
    const [kind, pathHint] = expected.get(template.id);
    assert.equal(template.outputArtifact.kind, kind);
    assert.equal(template.outputArtifact.pathHint, pathHint);
  }
});

await test("App persists the selected workflow template in project state", async () => {
  const source = await readFile("src/renderer/App.tsx", "utf8");
  const styles = await readFile("src/renderer/styles.css", "utf8");
  assert.match(source, /workflowTemplateId/);
  assert.match(source, /workflowTemplates\.map/);
  assert.match(source, /selectWorkflowTemplate/);
  assert.match(source, /function buildWorkflowTemplatePrompt/);
  assert.match(source, /function workflowArtifactInstruction/);
  assert.match(source, /function workflowTemplateParams/);
  assert.match(source, /workflowTemplateParams\(\)/);
  assert.match(source, /outputArtifact/);
  assert.match(source, /Primary artifact:/);
  assert.match(source, /Artifact kind:/);
  assert.doesNotMatch(source, /terminology_sweep|character_voice_check|final_qa/);
  assert.doesNotMatch(source, /proposeAssetUpdate|use readProjectAssets/);
  assert.match(source, /patch\(\{ translateOutputDir: event\.target\.value \}\)/);
  assert.match(source, /patch\(\{ proofreadMode: event\.target\.value as ProofreadMode \}\)/);
  assert.match(source, /patch\(\{ workDescription: event\.target\.value \}\)/);
  assert.match(source, /workflowTemplateId: getWorkflowTemplate\(loaded\.workflowTemplateId\)\.id/);
  assert.match(styles, /\.workflowTemplateParams/);
  assert.match(styles, /\.workflowTemplateParamGrid/);
});

await test("retired prompt presets are absent from product copy and the guide", async () => {
  const files = await Promise.all([
    readFile("src/shared/agent/workflowTemplates.ts", "utf8"),
    readFile("src/shared/i18n/zh-CN.json", "utf8"),
    readFile("src/shared/i18n/en-US.json", "utf8"),
    readFile("docs/yn-guide/content.js", "utf8"),
    readFile("docs/yn-guide/app.js", "utf8")
  ]);
  for (const source of files) {
    assert.doesNotMatch(source, /terminology_sweep|character_voice_check|final_qa/);
  }
});

await test("generated workflow prompts replace the embedded Pi draft and typed metadata instead of starting a legacy job", async () => {
  const html = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(html, /function promptSettingsValue/);
  assert.match(html, /workflowTemplateId: defaults\.workflowTemplateId/);
  assert.match(html, /agentHost\?\.replaceText/);
  assert.doesNotMatch(html, /runProviderJob|startJobWithTimeline/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
