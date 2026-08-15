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

await test("agent artifact IPC keeps source and candidate paths inside projectDir", async () => {
  const source = await readFile("src/main/ipc/agentArtifactHandlers.ts", "utf8");
  assert.match(source, /import \{ resolveProjectPath \} from "\.\.\/agent\/projectPathGuard\.ts";/);
  assert.match(source, /export interface ValidateArtifactArgs \{\s+projectDir: string;/);
  assert.match(source, /export interface RepairPromptArgs \{\s+projectDir: string;/);
  assert.match(source, /sourceEntriesFromPaths\(projectDir: string, sourcePaths: string\[\] \| undefined\)/);
  assert.match(source, /const sourcePath = resolveProjectPath\(projectDir, item\);/);
  assert.ok((source.match(/resolveProjectPath\(args\.projectDir, args\.sourcePath\)/g) || []).length >= 3);
  assert.ok((source.match(/resolveProjectPath\(args\.projectDir, args\.candidatePath\)/g) || []).length >= 3);
});

await test("agent artifact validation passes project glossary into validator", async () => {
  const source = await readFile("src/main/ipc/agentArtifactHandlers.ts", "utf8");
  assert.match(source, /readProjectGlossaryEntries/);
  assert.match(source, /glossaryEntries/);
  assert.match(source, /validateTranslationCandidate\(sourceText, candidateText, \{[\s\S]*glossaryEntries/);
  assert.match(source, /buildCandidateImportPlan\([\s\S]*await readProjectGlossaryEntries\(args\.projectDir\)/);
});

await test("agent artifact validation passes character bible into validator", async () => {
  const source = await readFile("src/main/ipc/agentArtifactHandlers.ts", "utf8");
  assert.match(source, /readProjectCharacterEntries/);
  assert.match(source, /characterEntries/);
  assert.match(source, /validateTranslationCandidate\(sourceText, candidateText, \{[\s\S]*characterEntries/);
  assert.match(source, /buildCandidateImportPlan\([\s\S]*await readProjectCharacterEntries\(args\.projectDir\)/);
});

await test("agent artifact validation passes style guide forbidden terms into validator", async () => {
  const source = await readFile("src/main/ipc/agentArtifactHandlers.ts", "utf8");
  assert.match(source, /readProjectStyleForbiddenTerms/);
  assert.match(source, /styleForbiddenTerms/);
  assert.match(source, /validateTranslationCandidate\(sourceText, candidateText, \{[\s\S]*styleForbiddenTerms/);
  assert.match(source, /buildCandidateImportPlan\([\s\S]*await readProjectStyleForbiddenTerms\(args\.projectDir\)/);
});

await test("agent artifact import records accepted candidates into translation memory", async () => {
  const source = await readFile("src/main/ipc/agentArtifactHandlers.ts", "utf8");
  assert.match(source, /rememberTranslationSegments/);
  assert.match(source, /if \(plan\.ok\) \{[\s\S]*rememberTranslationSegments\(\{/);
  assert.match(source, /sourceText/);
  assert.match(source, /targetText: candidateText/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
