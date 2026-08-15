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

await test("ordinary and conceptual chat do not activate a domain completion contract", () => {
  for (const prompt of [
    "你好",
    "“翻译”是什么意思？",
    "解释一下校对流程",
    "请解释如何翻译当前文件",
    "请告诉我怎么校对当前译文",
    "如何翻译当前文件？"
  ]) {
    const contract = createYnDomainRunContract({ prompt });
    assert.equal(contract.kind, undefined, prompt);
    assert.deepEqual(contract.incompleteReasons(), [], prompt);
  }
});

await test("typed workflow intent activates the host contract without regex intent guessing", () => {
  assert.equal(createYnDomainRunContract({ workflowIntent: "translation", prompt: "请翻译当前文件" }).kind, "translation");
  assert.equal(createYnDomainRunContract({ workflowIntent: "proofread", prompt: "请校对当前译文" }).kind, "proofread");
});

await test("translation cannot settle before assets, all requested children, and final validation", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: [
      "Workflow: yn-translation-v1.",
      "Use 2 parallel subagents for translation shards.",
      "No selected glossary file. Generate AI_translation/_workspace/glossary_candidates.json before spawning translation subagents.",
      "Character bible module: on. Generate AI_translation/_workspace/character_bible.md before spawning translation subagents."
    ].join("\n")
  });
  contract.recordInspection({ sourceLineCount: 3, glossaryCandidateExists: false, characterBibleExists: false });
  contract.recordWorkflowWrite("AI_translation/_workspace/glossary_candidates.json");
  contract.recordWorkflowWrite("AI_translation/_workspace/character_bible.md");
  contract.recordSubagentBatchStarted("translation", "translation-partial-1", { taskCount: 2, workerCount: 2 });
  contract.recordTranslationArtifactMutation();
  assert.throws(
    () => contract.recordSubagentBatch("translation", "translation-partial-1", 1),
    /1 results for 2 accepted tasks/i
  );
  contract.recordSubagentBatchFailure("translation", "translation-partial-1");
  assert.equal(contract.awaitingUserInput, true);
  assert.equal(contract.nextRepairPrompt(), undefined);
  contract.resumeAfterExplicitContinuation(contract.recoveryPauseId);
  assert.match(contract.nextRepairPrompt(), /host-accepted batch.*translation subagents/i);

  const complete = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: [
      "Workflow: yn-translation-v1.",
      "No selected glossary file. Generate AI_translation/_workspace/glossary_candidates.json before spawning translation subagents.",
      "Character bible module: on. Generate AI_translation/_workspace/character_bible.md before spawning translation subagents."
    ].join("\n")
  });
  complete.recordInspection({ sourceLineCount: 3, glossaryCandidateExists: true, characterBibleExists: true });
  complete.recordSubagentBatchStarted("translation", "translation-complete", { taskCount: 2, workerCount: 2 });
  complete.recordTranslationArtifactMutation();
  complete.recordSubagentBatch("translation", "translation-complete", 2);
  complete.recordFinalValidation("translation");
  assert.deepEqual(complete.incompleteReasons(), []);
});

await test("configured workflow child count is an upper bound and completion follows the accepted batch size", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "translation",
    prompt: "Workflow: yn-translation-v1.",
    subagentEnabled: true,
    subagentCount: 5
  });
  contract.recordInspection({ sourceLineCount: 10, glossaryCandidateExists: true, characterBibleExists: true });
  contract.recordSubagentBatchStarted("translation", "two-of-five", { taskCount: 2, workerCount: 2 });
  contract.recordTranslationArtifactMutation();
  contract.recordSubagentBatch("translation", "two-of-five", 2);
  contract.recordFinalValidation("translation");
  assert.deepEqual(contract.incompleteReasons(), []);
});

await test("proofreading requires aligned reads, requested children, and findings output", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "proofread",
    prompt: "Workflow: yn-proofread-v1.\nUse 2 parallel subagents for proofreading shards."
  });
  contract.recordInspection({ sourceLineCount: 3, glossaryCandidateExists: true, characterBibleExists: true });
  assert.throws(
    () => contract.recordSubagentBatchStarted("proofread", "proofread-too-early", { taskCount: 2, workerCount: 2 }),
    /deterministic proofreading prescan/i
  );
  contract.recordProofreadPrescan();
  contract.recordSourceRead();
  contract.recordTranslationRead();
  contract.recordProofreadArtifactReset();
  contract.recordSubagentBatchStarted("proofread", "proofread-complete", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "proofread-complete", 2);
  assert.match(contract.incompleteReasons().join("\n"), /finalize.*JSON/i);
  contract.recordProofreadReportFinalized();
  assert.deepEqual(contract.incompleteReasons(), []);
});

await test("Monte Carlo proofreading requires its minimum rounds and convergence before JSON finalization", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "proofread",
    proofreadMode: "montecarlo",
    proofreadMontecarloRoundMin: 2,
    proofreadMontecarloRoundMax: 5
  });
  contract.recordInspection({ sourceLineCount: 20, glossaryCandidateExists: true, characterBibleExists: true });
  contract.recordProofreadPrescan();
  contract.recordSourceRead();
  contract.recordTranslationRead();
  contract.recordProofreadArtifactReset();
  contract.recordSubagentBatchStarted("proofread", "mc-1", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "mc-1", 2);
  contract.recordProofreadMontecarloRound(3);
  assert.match(contract.incompleteReasons().join("\n"), /Monte Carlo.*round|clean round/i);
  contract.recordSubagentBatchStarted("proofread", "mc-2", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "mc-2", 2);
  contract.recordProofreadMontecarloRound(0);
  contract.recordSubagentBatchStarted("proofread", "mc-3", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "mc-3", 2);
  contract.recordProofreadMontecarloRound(0);
  assert.match(contract.incompleteReasons().join("\n"), /finalize.*JSON/i);
  contract.recordProofreadReportFinalized();
  assert.deepEqual(contract.incompleteReasons(), []);
});

await test("Monte Carlo maximum rounds require an explicit user decision instead of fake convergence", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "proofread",
    proofreadMode: "montecarlo",
    proofreadMontecarloRoundMin: 2,
    proofreadMontecarloRoundMax: 2,
    subagentEnabled: true,
    subagentCount: 2
  });
  contract.recordInspection({ sourceLineCount: 20, glossaryCandidateExists: true, characterBibleExists: true });
  contract.recordProofreadPrescan();
  contract.recordProofreadArtifactReset();
  for (let round = 1; round <= 2; round += 1) {
    contract.recordSubagentBatchStarted("proofread", `mc-dirty-${round}`, { taskCount: 2, workerCount: 2 });
    contract.recordProofreadArtifactMutation();
    contract.recordSubagentBatch("proofread", `mc-dirty-${round}`, 2);
    contract.recordProofreadMontecarloRound(1);
  }
  assert.equal(contract.awaitingUserInput, true);
  assert.match(contract.incompleteReasons().join("\n"), /maximum.*user decision|not converged/i);
  assert.throws(() => contract.recordProofreadReportFinalized(), /not converged|user decision|round\/convergence/i);
  contract.resolveProofreadMontecarloLimit("stop_and_finalize");
  contract.recordProofreadReportFinalized();
  assert.deepEqual(contract.incompleteReasons(), []);
});

await test("Monte Carlo HOT-region escalation requires a new semantic batch without discarding prior findings", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "proofread",
    proofreadMode: "montecarlo",
    proofreadMontecarloRoundMin: 2,
    proofreadMontecarloRoundMax: 2,
    subagentEnabled: true,
    subagentCount: 2
  });
  contract.recordInspection({ sourceLineCount: 1_000, glossaryCandidateExists: true, characterBibleExists: true });
  contract.recordProofreadPrescan();
  contract.recordProofreadArtifactReset();
  for (let round = 1; round <= 2; round += 1) {
    contract.recordSubagentBatchStarted("proofread", `mc-hot-${round}`, { taskCount: 2, workerCount: 2 });
    contract.recordProofreadArtifactMutation();
    contract.recordSubagentBatch("proofread", `mc-hot-${round}`, 2);
    contract.recordProofreadMontecarloRound(1);
  }
  contract.resolveProofreadMontecarloLimit("switch_to_split");
  assert.equal(contract.proofreadMode, "montecarlo", "HOT escalation must retain the Monte Carlo report mode");
  assert.equal(contract.proofreadHotSplitRequested, true);
  assert.equal(contract.awaitingUserInput, false);
  assert.match(contract.incompleteReasons().join("\n"), /HOT-region split review/i);
  contract.recordSubagentBatchStarted("proofread", "mc-hot-split", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "mc-hot-split", 2);
  contract.recordProofreadHotSplitCompleted();
  contract.recordProofreadReportFinalized();
  assert.deepEqual(contract.incompleteReasons(), []);
});

await test("stale proofreading input clears semantic coverage and old findings completion", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "proofread",
    subagentEnabled: true,
    subagentCount: 2
  });
  contract.recordInspection({ sourceLineCount: 4, glossaryCandidateExists: true, characterBibleExists: true });
  contract.recordProofreadPrescan();
  contract.recordProofreadArtifactReset();
  contract.recordSubagentBatchStarted("proofread", "proofread-old-input", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "proofread-old-input", 2);
  contract.recordProofreadReportFinalized();
  assert.deepEqual(contract.incompleteReasons(), []);

  contract.invalidateProofreadPrescan();
  contract.recordProofreadPrescan();
  const reasons = contract.incompleteReasons().join("\n");
  assert.match(reasons, /proofreading subagents/i);
  assert.match(reasons, /findings/i);
  assert.match(reasons, /finalize.*JSON/i);
});

await test("a Monte Carlo tail round may use fewer workers than the configured upper bound", () => {
  const contract = createYnDomainRunContract({
    workflowIntent: "proofread",
    proofreadMode: "montecarlo",
    proofreadMontecarloRoundMin: 1,
    proofreadMontecarloRoundMax: 1,
    subagentEnabled: true,
    subagentCount: 5
  });
  contract.recordInspection({ sourceLineCount: 10, glossaryCandidateExists: true, characterBibleExists: true });
  contract.recordProofreadPrescan();
  contract.recordSourceRead();
  contract.recordTranslationRead();
  contract.recordProofreadArtifactReset();
  contract.recordSubagentBatchStarted("proofread", "mc-tail", { taskCount: 2, workerCount: 2 });
  contract.recordProofreadArtifactMutation();
  contract.recordSubagentBatch("proofread", "mc-tail", 2);
  contract.recordProofreadMontecarloRound(0, true);
  contract.recordProofreadReportFinalized();
  assert.deepEqual(contract.incompleteReasons(), []);
});

await test("a workflow contract rejects subagent and artifact records from the other workflow", () => {
  const translation = createYnDomainRunContract({ workflowIntent: "translation", prompt: "translate" });
  translation.recordInspection({ sourceLineCount: 3, glossaryCandidateExists: true, characterBibleExists: true });
  assert.throws(() => translation.recordSubagentBatchStarted("proofread", "wrong-proofread", { taskCount: 2, workerCount: 2 }), /translation.*proofread|proofread.*translation/i);
  assert.throws(() => translation.recordFindingsWrite("proofread"), /translation.*proofread|proofread.*translation/i);

  const proofread = createYnDomainRunContract({ workflowIntent: "proofread", prompt: "proofread" });
  proofread.recordInspection({ sourceLineCount: 3, glossaryCandidateExists: true, characterBibleExists: true });
  assert.throws(() => proofread.recordSubagentBatchStarted("translation", "wrong-translation", { taskCount: 2, workerCount: 2 }), /translation.*proofread|proofread.*translation/i);
  assert.throws(() => proofread.recordFinalValidation("translation"), /translation.*proofread|proofread.*translation/i);
});

await test("single-line translation and proofreading use the parent contract without shard subagents", () => {
  const translation = createYnDomainRunContract({ workflowIntent: "translation", prompt: "translate" });
  translation.recordInspection({ sourceLineCount: 1, glossaryCandidateExists: true, characterBibleExists: true });
  assert.equal(translation.maximumSubagentsForActiveDocument, 0);
  translation.recordFinalValidation("translation");
  assert.match(translation.incompleteReasons().join("\n"), /write.*single|single.*write/i);
  translation.recordTranslationWrite("translation");
  assert.match(translation.incompleteReasons().join("\n"), /whole-artifact validation/i);
  translation.recordFinalValidation("translation");
  assert.deepEqual(translation.incompleteReasons(), []);

  translation.recordTranslationWrite("translation");
  assert.match(translation.incompleteReasons().join("\n"), /whole-artifact validation/i);
  translation.recordFinalValidation("translation");
  assert.deepEqual(translation.incompleteReasons(), []);

  const proofread = createYnDomainRunContract({ workflowIntent: "proofread", prompt: "proofread" });
  proofread.recordInspection({ sourceLineCount: 1, glossaryCandidateExists: true, characterBibleExists: true });
  proofread.recordProofreadPrescan();
  assert.equal(proofread.maximumSubagentsForActiveDocument, 0);
  assert.throws(() => proofread.recordFindingsWrite("proofread"), /semantic.*coverage|read.*range/i);
  proofread.recordProofreadParentRead("source", 1, 1);
  proofread.recordProofreadParentRead("translation", 1, 1);
  assert.throws(
    () => proofread.recordFindingsWrite("proofread"),
    /explicit parent semantic review|read receipts alone/i
  );
  proofread.recordProofreadParentSemanticReview(1, 1);
  proofread.recordFindingsWrite("proofread");
  proofread.recordProofreadReportFinalized();
  assert.deepEqual(proofread.incompleteReasons(), []);
});

await test("translation validation is bound to the artifact revision produced by a completed child batch", () => {
  const translation = createYnDomainRunContract({ workflowIntent: "translation", prompt: "translate" });
  translation.recordInspection({ sourceLineCount: 4, glossaryCandidateExists: true, characterBibleExists: true });

  translation.recordFinalValidation("translation");
  translation.recordSubagentBatchStarted("translation", "translated-revision", { taskCount: 2, workerCount: 2 });
  translation.recordTranslationArtifactMutation();
  translation.recordSubagentBatch("translation", "translated-revision", 2);
  assert.match(translation.incompleteReasons().join("\n"), /whole-artifact validation/i);

  translation.recordFinalValidation("translation");
  assert.deepEqual(translation.incompleteReasons(), []);
});

await test("repair prompts stay active past repeated status-only turns", () => {
  const contract = createYnDomainRunContract({ workflowIntent: "translation", prompt: "Workflow: yn-translation-v1." });
  assert.ok(contract.nextRepairPrompt());
  assert.ok(contract.nextRepairPrompt());
  assert.match(contract.nextRepairPrompt() || "", /No host-observed progress/i);
  assert.ok(contract.nextRepairPrompt());
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
