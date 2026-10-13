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

// Read-only sources may be outside projectDir. The former source-text assertion
// enforced the obsolete boundary; actual discovery/validation/import behavior
// and the candidate boundary are covered by agentArtifactReadableSource.test.mjs.

await test("artifact checks share workflow assets and the canonical validator in a worker", async () => {
  const handler = await readFile("src/main/ipc/agentArtifactHandlers.ts", "utf8");
  const service = await readFile("src/main/agent/artifactValidationService.ts", "utf8");
  const worker = await readFile("src/main/agent/artifactValidationWorkerTasks.ts", "utf8");
  assert.match(handler, /runArtifactOperation/);
  assert.doesNotMatch(handler, /validateTranslationCandidate\(/);
  assert.match(service, /readWorkflowTranslationValidationAssets/);
  assert.match(worker, /validateTranslationCandidate\(sourceText, candidateText, validationOptions/);
  assert.match(worker, /rememberTranslationSegments\(/);
  assert.doesNotMatch(worker, /catch\(\(\) => undefined\)/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
