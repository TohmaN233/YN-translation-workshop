import { strict as assert } from "node:assert";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";

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

const legacyAssetPrompt = [
  "Workflow: yn-translation-v1.",
  "No selected glossary file. Generate AI_translation/_workspace/glossary_candidates.json before spawning translation subagents.",
  "Character bible module: on. Generate AI_translation/_workspace/character_bible.md before spawning translation subagents."
].join("\n");

await test("prompt wording cannot create workflow asset requirements", () => {
  const legacyWording = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: legacyAssetPrompt
  });
  const unrelatedWording = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Translate the selected source without mentioning project assets."
  });

  for (const contract of [legacyWording, unrelatedWording]) {
    contract.recordInspection({
      sourceLineCount: 1,
      glossaryCandidateExists: false,
      characterBibleExists: false
    });
    assert.deepEqual(contract.workflowRequirements, {
      glossaryCandidate: false,
      characterBible: false
    });
    assert.doesNotMatch(contract.incompleteReasons().join("\n"), /glossary candidate|character bible/i);
  }
});

await test("typed workflow asset flags independently control completion requirements", () => {
  const glossaryOnly = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Character bible module: on.",
    workflowRequirements: {
      glossaryCandidate: true,
      characterBible: false
    }
  });
  glossaryOnly.recordInspection({
    sourceLineCount: 1,
    glossaryCandidateExists: false,
    characterBibleExists: false
  });
  assert.match(glossaryOnly.incompleteReasons().join("\n"), /glossary candidate/i);
  assert.doesNotMatch(glossaryOnly.incompleteReasons().join("\n"), /character bible/i);

  const characterOnly = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: legacyAssetPrompt,
    workflowRequirements: {
      glossaryCandidate: false,
      characterBible: true
    }
  });
  characterOnly.recordInspection({
    sourceLineCount: 1,
    glossaryCandidateExists: false,
    characterBibleExists: false
  });
  assert.doesNotMatch(characterOnly.incompleteReasons().join("\n"), /glossary candidate/i);
  assert.match(characterOnly.incompleteReasons().join("\n"), /character bible/i);
});

await test("snapshot restore preserves typed workflow asset requirements", () => {
  const original = createYnDomainRunContract({
    workflowIntent: "translation",
    workflowRequirements: {
      glossaryCandidate: true,
      characterBible: false
    }
  });
  original.recordInspection({
    sourceLineCount: 1,
    glossaryCandidateExists: false,
    characterBibleExists: false
  });

  const restored = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: legacyAssetPrompt,
    workflowRequirements: {
      glossaryCandidate: false,
      characterBible: true
    },
    restoreSnapshot: original.snapshot()
  });

  assert.deepEqual(restored.workflowRequirements, {
    glossaryCandidate: true,
    characterBible: false
  });
  assert.deepEqual(restored.snapshot().workflowRequirements, restored.workflowRequirements);
  assert.match(restored.incompleteReasons().join("\n"), /glossary candidate/i);
  assert.doesNotMatch(restored.incompleteReasons().join("\n"), /character bible/i);
});

await test("legacy snapshots retain their encoded asset debt without prompt parsing", () => {
  const legacySnapshot = createYnDomainRunContract({
    workflowIntent: "translation",
    workflowRequirements: {
      glossaryCandidate: true,
      characterBible: false
    }
  }).snapshot();
  delete legacySnapshot.workflowRequirements;

  const restored = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "No asset instructions are present.",
    restoreSnapshot: legacySnapshot
  });

  assert.deepEqual(restored.workflowRequirements, {
    glossaryCandidate: true,
    characterBible: false
  });
  assert.match(restored.incompleteReasons().join("\n"), /glossary candidate/i);
  assert.doesNotMatch(restored.incompleteReasons().join("\n"), /character bible/i);
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
