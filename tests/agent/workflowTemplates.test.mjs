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
  assert.equal(workflowTemplates.length, 5);
  assert.equal(getWorkflowTemplate("initial_translation")?.promptKind, "translate");
  assert.equal(getWorkflowTemplate("proofread")?.promptKind, "proofread");
  assert.equal(getWorkflowTemplate("terminology_sweep")?.promptKind, "generic");
  assert.equal(getWorkflowTemplate("character_voice_check")?.promptKind, "generic");
  assert.equal(getWorkflowTemplate("final_qa")?.promptKind, "proofread");
  for (const template of workflowTemplates) {
    assert.equal("jobType" in template, false);
  }
});

await test("workflow templates declare their primary artifact protocol", () => {
  const expected = new Map([
    ["initial_translation", ["translation_candidate", "{translationOutputDir}/{document}_translated.txt"]],
    ["proofread", ["findings_json", "{reportOutputDir}/{document}.proofread.json"]],
    ["terminology_sweep", ["terminology_findings_json", "{reportOutputDir}/{document}.terminology.json"]],
    ["character_voice_check", ["character_voice_findings_json", "{reportOutputDir}/{document}.character-voice.json"]],
    ["final_qa", ["final_qa_findings_json", "{reportOutputDir}/{document}.final-qa.json"]]
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
  assert.match(source, /case "terminology_sweep"/);
  assert.match(source, /case "character_voice_check"/);
  assert.match(source, /case "final_qa"/);
  assert.match(source, /patch\(\{ translateOutputDir: event\.target\.value \}\)/);
  assert.match(source, /patch\(\{ proofreadMode: event\.target\.value as ProofreadMode \}\)/);
  assert.match(source, /patch\(\{ workDescription: event\.target\.value \}\)/);
  assert.match(source, /workflowTemplateId: getWorkflowTemplate\(loaded\.workflowTemplateId\)\.id/);
  assert.match(styles, /\.workflowTemplateParams/);
  assert.match(styles, /\.workflowTemplateParamGrid/);
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
