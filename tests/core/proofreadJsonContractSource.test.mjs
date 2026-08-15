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

await test("proofread protocol names findings json as the primary machine contract", async () => {
  const protocol = await readFile("skills/proofread-translation/references/proofread-workflow.md", "utf8");
  assert.match(protocol, /Structured findings JSON: `\[basename\]\.proofread\.json`/);
  assert.match(protocol, /exactly one persisted output/i);
  assert.doesNotMatch(protocol, /Human summary:/i);
  assert.doesNotMatch(protocol, /validate-fix-proposal|Markdown fix proposal is a legacy fallback/i);
});

await test("hosted agent prompts request findings_json instead of markdown fix_proposal", async () => {
  const systemPrompt = await readFile("src/main/agent/piNative/systemPrompt.ts", "utf8");
  const domainTools = await readFile("src/main/agent/piNative/ynDomainTools.ts", "utf8");
  const promptBuilder = await readFile("src/shared/core/prompts.ts", "utf8");
  assert.match(systemPrompt, /writeProofreadFindings/);
  assert.match(domainTools, /kind: "findings_json"/);
  assert.match(promptBuilder, /\.proofread\.json/);
  assert.doesNotMatch(promptBuilder, /_proofread_summary\.md/);
  assert.doesNotMatch(domainTools, /kind: "summary"/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
