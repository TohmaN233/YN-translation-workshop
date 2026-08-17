import { strict as assert } from "node:assert";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { buildYnSystemPrompt } from "../../src/main/agent/piNative/systemPrompt.ts";

const proofreadWithBoundedRepair = createYnDomainRunContract({
  workflowIntent: "proofread",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 3
});
proofreadWithBoundedRepair.registerSourceManifest([{ id: "source.txt", sourceLineCount: 20 }]);
proofreadWithBoundedRepair.recordProofreadPrescan();
assert.equal(proofreadWithBoundedRepair.kind, "proofread");
assert.doesNotThrow(
  () => proofreadWithBoundedRepair.recordTranslationArtifactMutation(
    "source.txt",
    { fromLine: 7, toLine: 8 }
  ),
  "a bounded candidate repair must not be rejected merely because the parent workflow is proofreading"
);
assert.equal(
  proofreadWithBoundedRepair.kind,
  "proofread",
  "a bounded repair must not silently restart or replace the active proofreading workflow"
);
assert.deepEqual(
  proofreadWithBoundedRepair.snapshot().documents[0].proofreadDirtyRanges,
  [{ fromLine: 7, toLine: 8 }],
  "a bounded repair must invalidate only its exact proofreading range"
);
assert.equal(
  proofreadWithBoundedRepair.snapshot().documents[0].proofreadPrescanCompleted,
  true,
  "a Host-observed bounded repair must not discard the whole deterministic prescan"
);
assert.match(
  proofreadWithBoundedRepair.incompleteReasons().join("\n"),
  /re-proofread.*L7-8/i
);
proofreadWithBoundedRepair.recordProofreadRangeValidated("source.txt", 7, 8);
assert.deepEqual(proofreadWithBoundedRepair.snapshot().documents[0].proofreadDirtyRanges, []);

const transactionalArtifactMutation = createYnDomainRunContract({
  workflowIntent: "proofread",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 2
});
transactionalArtifactMutation.registerSourceManifest([{ id: "source.txt", sourceLineCount: 20 }]);
transactionalArtifactMutation.recordProofreadPrescan();
const beforeArtifactMutation = transactionalArtifactMutation.snapshot();
const rollbackArtifactMutation = transactionalArtifactMutation.recordTranslationArtifactMutation(
  "source.txt",
  { fromLine: 7, toLine: 8 }
);
assert.notDeepEqual(transactionalArtifactMutation.snapshot(), beforeArtifactMutation);
rollbackArtifactMutation();
assert.deepEqual(
  transactionalArtifactMutation.snapshot(),
  beforeArtifactMutation,
  "a failed Host persistence transaction must restore the complete domain-run mutation"
);

const concurrentProofreadRepair = createYnDomainRunContract({
  workflowIntent: "proofread",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 2
});
concurrentProofreadRepair.registerSourceManifest([{ id: "source.txt", sourceLineCount: 20 }]);
concurrentProofreadRepair.recordProofreadPrescan();
concurrentProofreadRepair.recordSubagentBatchStarted("proofread", "older-proofread", {
  taskCount: 1,
  workerCount: 1
});
concurrentProofreadRepair.recordTranslationArtifactMutation("source.txt", { fromLine: 7, toLine: 8 });
concurrentProofreadRepair.recordSubagentBatch("proofread", "older-proofread", 1);
assert.deepEqual(
  concurrentProofreadRepair.snapshot().documents[0].proofreadDirtyRanges,
  [{ fromLine: 7, toLine: 8 }],
  "an older proofreading batch must not erase a repair range created after that batch started"
);

const readOnlyProofreadSelection = createYnDomainRunContract({
  workflowIntent: "proofread",
  fullWorkflow: true,
  folderSource: true,
  subagentEnabled: true,
  subagentCount: 2
});
readOnlyProofreadSelection.registerSourceManifest([
  { id: "a.txt", sourceLineCount: 10 },
  { id: "b.txt", sourceLineCount: 10 }
]);
readOnlyProofreadSelection.recordProofreadPrescan();
readOnlyProofreadSelection.recordSubagentBatchStarted("proofread", "read-only-a", {
  taskCount: 1,
  workerCount: 1,
  documentIds: ["a.txt"]
});
assert.doesNotThrow(
  () => readOnlyProofreadSelection.selectDocument("b.txt"),
  "read-only proofreading in one document must not occupy selection for an independent repair in another document"
);

const exactTranslationWithShortReviewTail = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 5
});
exactTranslationWithShortReviewTail.registerSourceManifest([{ id: "source.txt", sourceLineCount: 20 }]);
assert.doesNotThrow(
  () => exactTranslationWithShortReviewTail.recordSubagentBatchStarted("translation", "review-tail", {
    taskCount: 2,
    workerCount: 2,
    readOnly: true,
    workerCountContract: "review_ceiling",
    workerCountCeiling: 2
  }),
  "a two-assignment read-only review tail must not be forced to recreate five exact translation workers"
);

const independentReviewCeiling = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 2
});
independentReviewCeiling.registerSourceManifest([{ id: "source.txt", sourceLineCount: 20 }]);
assert.doesNotThrow(
  () => independentReviewCeiling.recordSubagentBatchStarted("translation", "four-reviewers", {
    taskCount: 4,
    workerCount: 4,
    readOnly: true,
    workerCountContract: "review_ceiling",
    workerCountCeiling: 5
  }),
  "the review ceiling must be authoritative even when it exceeds the translation-worker ceiling"
);

const localRepair = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 8
});
assert.equal(localRepair.kind, undefined, "page metadata alone must not start a full workflow");
localRepair.activate("translation");
localRepair.recordInspection({
  sourceLineCount: 20,
  glossaryCandidateExists: false,
  characterBibleExists: false
});
assert.equal(
  localRepair.maximumSubagentsForActiveDocument,
  8,
  "project-enabled native Pi children must remain available up to the configured ceiling"
);
assert.doesNotThrow(
  () => localRepair.assertCanStartSubagentBatch("translation"),
  "project capability must not depend on magic wording in the latest user message"
);
localRepair.recordTranslationWrite("translation");
assert.match(
  localRepair.incompleteReasons().join("\n"),
  /whole-artifact validation after the bounded translation repair/,
  "a bounded write must remain incomplete until the parent validates the resulting artifact"
);
localRepair.recordFinalValidation("translation");
assert.deepEqual(localRepair.incompleteReasons(), []);

const mixedLocalOperation = createYnDomainRunContract({
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 3
});
mixedLocalOperation.activate("translation");
assert.doesNotThrow(
  () => mixedLocalOperation.activate("proofread"),
  "a bounded local operation must be able to switch tool families without a full-workflow permission conflict"
);
assert.equal(mixedLocalOperation.kind, "proofread");

const fullWorkflowKindBoundary = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 3
});
assert.throws(
  () => fullWorkflowKindBoundary.activate("proofread"),
  /active translation workflow/i,
  "a generated full workflow must keep its typed completion contract until it is parked by the session transition"
);

const userDelegatedRepair = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: false,
  subagentCount: 8
});
userDelegatedRepair.activate("translation");
userDelegatedRepair.recordInspection({
  sourceLineCount: 20,
  glossaryCandidateExists: false,
  characterBibleExists: false
});
assert.equal(userDelegatedRepair.configuredSubagents, 0);
assert.equal(userDelegatedRepair.maximumSubagentsForActiveDocument, 0);
assert.doesNotThrow(() => userDelegatedRepair.assertCanStartGeneralSubagentBatch());
assert.doesNotMatch(
  userDelegatedRepair.incompleteReasons().join("\n"),
  /glossary|character bible/i,
  "bounded delegation must not silently become the full generated workflow"
);

const generalDelegation = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false
});
assert.equal(generalDelegation.fullWorkflow, false);
assert.doesNotThrow(() => generalDelegation.assertCanStartGeneralSubagentBatch());
assert.equal(generalDelegation.kind, undefined, "general delegation must not activate translation completion debt");
assert.deepEqual(generalDelegation.incompleteReasons(), []);
generalDelegation.recordGeneralSubagentBatchStarted("general-five", 5);
assert.match(generalDelegation.incompleteReasons().join("\n"), /wait for native Pi child batch general-five/);
generalDelegation.recordGeneralSubagentBatchFailure("general-five", "one child failed validation");
assert.match(generalDelegation.incompleteReasons().join("\n"), /retry or repair.*one child failed validation/);
generalDelegation.registerSourceManifest([{ id: "tips.txt", sourceLineCount: 20 }]);
generalDelegation.recordTranslationArtifactMutation("tips.txt");
generalDelegation.recordFinalValidation("translation", "tips.txt");
assert.match(
  generalDelegation.incompleteReasons().join("\n"),
  /retry or repair.*one child failed validation/,
  "a parent direct-write fallback must not erase an explicitly requested failed child batch"
);
generalDelegation.recordGeneralSubagentBatchStarted("general-five-retry", 5);
generalDelegation.recordGeneralSubagentBatch("general-five-retry", 5);
assert.deepEqual(generalDelegation.incompleteReasons(), []);

const upToGeneralDelegation = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 5
});
assert.deepEqual(upToGeneralDelegation.incompleteReasons(), []);
assert.doesNotThrow(
  () => upToGeneralDelegation.recordGeneralSubagentBatchStarted("general-two", 2),
  "a two-lane repair is valid under a configured upper bound of five"
);
upToGeneralDelegation.recordGeneralSubagentBatch("general-two", 2);
assert.deepEqual(upToGeneralDelegation.incompleteReasons(), []);
assert.doesNotThrow(
  () => localRepair.assertCanStartGeneralSubagentBatch(),
  "project-enabled native Pi children must be available without magic words in the current message"
);

const projectGeneralDelegation = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 5
});
assert.deepEqual(projectGeneralDelegation.incompleteReasons(), []);
projectGeneralDelegation.recordGeneralSubagentBatchStarted("project-bounded", 1);
assert.match(projectGeneralDelegation.incompleteReasons().join("\n"), /wait for native Pi child batch project-bounded/);
projectGeneralDelegation.recordGeneralSubagentBatchFailure("project-bounded", "candidate validation failed");
assert.match(projectGeneralDelegation.incompleteReasons().join("\n"), /retry or repair.*candidate validation failed/);
projectGeneralDelegation.recordGeneralSubagentBatchStarted("project-bounded-retry", 1);
projectGeneralDelegation.recordGeneralSubagentBatch("project-bounded-retry", 1);
assert.deepEqual(
  projectGeneralDelegation.incompleteReasons(),
  [],
  "an autonomous project-enabled child batch must keep parent completion ownership until its retry succeeds"
);

const disabledLocalRepair = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: false,
  subagentCount: 8
});
assert.doesNotThrow(
  () => disabledLocalRepair.assertCanStartGeneralSubagentBatch(),
  "prompt-defined bounded subagents are independent from the full-workflow pool switch"
);

const parentPromptWithStyleGuide = buildYnSystemPrompt({
  outputDir: "C:/project",
  sessionId: "pi_style",
  prompt: "Inspect the project style.",
  providerId: "provider",
  modelId: "model",
  languagePair: "Eng->zh-CN"
}, {
  approvedStyleGuide: "Preserve restrained narration and precise technical terminology."
});
assert.match(parentPromptWithStyleGuide, /APPROVED PROJECT STYLE GUIDE/);
assert.match(parentPromptWithStyleGuide, /Preserve restrained narration and precise technical terminology/);

const upToDelegationPrompt = buildYnSystemPrompt({
  outputDir: "C:/project",
  sessionId: "pi_up_to_children",
  prompt: "请用子 agents 修复已经定位的问题。",
  providerId: "provider",
  modelId: "model",
  subagentEnabled: true,
  subagentCount: 5
});
assert.match(upToDelegationPrompt, /up to 5 concurrent tasks/i);
assert.doesNotMatch(upToDelegationPrompt, /authorized exactly 5|explicitly requested 5/i);

const fullWorkflowProjectDelegationPrompt = buildYnSystemPrompt({
  outputDir: "C:/project",
  sessionId: "pi_full_project_children",
  prompt: "Workflow: yn-proofread-v1.",
  workflowIntent: "proofread",
  providerId: "provider",
  modelId: "model",
  subagentEnabled: true,
  subagentCount: 3
});
assert.doesNotMatch(
  fullWorkflowProjectDelegationPrompt,
  /runSubagents batch.*only when the user's current instruction explicitly delegates/i,
  "project-enabled bounded delegation must remain available inside a full workflow without magic current-turn wording"
);

const reconciledTranslationQueue = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 2
});
reconciledTranslationQueue.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
reconciledTranslationQueue.recordTranslationArtifactMutation("source");
reconciledTranslationQueue.recordFinalValidation("translation", "source");
reconciledTranslationQueue.recordTranslationAssignmentsReconciled([
  { documentId: "source", acceptedScopeCount: 1 }
]);
assert.deepEqual(
  reconciledTranslationQueue.incompleteReasons(),
  [],
  "hash-current accepted scopes with no outstanding assignments must reconcile Host completion instead of requesting another batch"
);

const partialFolderSettlement = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  folderSource: true,
  subagentEnabled: true,
  subagentCount: 3
});
partialFolderSettlement.recordInspection({
  sourceLineCount: 2,
  documents: [
    { id: "accepted.txt", sourceLineCount: 2 },
    { id: "failed.txt", sourceLineCount: 2 }
  ],
  glossaryCandidateExists: true,
  characterBibleExists: true
});
partialFolderSettlement.recordSubagentBatchStarted("translation", "partial-folder", {
  taskCount: 2,
  workerCount: 2,
  documentIds: ["accepted.txt", "failed.txt"],
  assignmentCounts: { "accepted.txt": 1, "failed.txt": 1 }
});
partialFolderSettlement.recordTranslationArtifactMutation("accepted.txt", { fromLine: 1, toLine: 2 });
partialFolderSettlement.recordSubagentBatchSettlement("translation", "partial-folder", [
  { documentId: "accepted.txt", acceptedResultCount: 1 },
  { documentId: "failed.txt", acceptedResultCount: 0, failedResultCount: 1, error: "review exhausted" }
]);
const partialSnapshot = partialFolderSettlement.snapshot();
assert.equal(partialSnapshot.documents.find((document) => document.id === "accepted.txt")?.completedSubagentBatch?.count, 1);
assert.equal(
  partialSnapshot.documents.find((document) => document.id === "failed.txt")?.completedSubagentBatch,
  undefined,
  "one failed assignment must not erase or fabricate the independently accepted document result"
);
assert.equal(partialFolderSettlement.awaitingUserInput, true);
assert.ok(partialFolderSettlement.recoveryPauseId, "an exhausted assignment must persist an explicit-continuation pause");
assert.equal(partialFolderSettlement.nextRepairPrompt(), undefined, "the hidden completion loop must not auto-restart a failed queue");
assert.throws(
  () => partialFolderSettlement.assertCanStartSubagentBatch("translation"),
  /Call resumeYnWorkflow before starting another Host-owned child batch/i
);
assert.doesNotThrow(
  () => partialFolderSettlement.recordTranslationArtifactMutation("failed.txt", { fromLine: 1, toLine: 1 }),
  "an exhausted assignment must not block parent-owned takeover writes"
);
const pauseId = partialFolderSettlement.recoveryPauseId;
partialFolderSettlement.resumeAfterExplicitContinuation(pauseId);
assert.equal(partialFolderSettlement.awaitingUserInput, false);
assert.doesNotMatch(
  partialFolderSettlement.incompleteReasons().join("\n"),
  /accepted\.txt: complete one host-accepted batch/i,
  "accepted documents must remain settled after the failed assignment is explicitly resumed"
);

const discoveryClosure = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: false
});
discoveryClosure.recordInspection({
  sourceLineCount: 1,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
discoveryClosure.recordTranslationDiscoveries([
  {
    id: "term-gate-a",
    kind: "glossary",
    documentId: "source",
    fromLine: 1,
    toLine: 1,
    sourceHash: "source-hash",
    candidateHash: "candidate-hash-a",
    source: "ゲートオープン",
    target: "Gate Open",
    category: "setting_term",
    evidenceLine: 1,
    rationale: "battle call"
  },
  {
    id: "term-gate-b",
    kind: "glossary",
    documentId: "source",
    fromLine: 1,
    toLine: 1,
    sourceHash: "source-hash",
    candidateHash: "candidate-hash-b",
    source: "ゲートオープン",
    target: "开门",
    category: "setting_term",
    evidenceLine: 1,
    rationale: "battle call"
  }
]);
discoveryClosure.recordTranslationDiscoveryConflicts([{
  id: "term-conflict",
  batchId: "translation-batch",
  source: "ゲートオープン",
  observedTargets: ["Gate Open", "开门"],
  discoveryIds: ["term-gate-a", "term-gate-b"],
  documentIds: ["source"],
  affectedRanges: [{
    documentId: "source",
    fromLine: 1,
    toLine: 1,
    sourceHash: "source-hash",
    candidateHash: "candidate-hash-a"
  }],
  status: "conflict"
}]);
let terminologyGateOpened = false;
const terminologyGateWait = discoveryClosure.waitForTranslationTerminologyGate()
  .then(() => { terminologyGateOpened = true; });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(terminologyGateOpened, false, "a durable terminology conflict must close assignment claiming");
assert.match(discoveryClosure.incompleteReasons().join("\n"), /resolve 2 terminology/i);
const rollbackDiscoveryResolution = discoveryClosure.resolveTranslationDiscoveries(
  ["term-gate-a", "term-gate-b"],
  [{ source: "ゲートオープン", target: "开门", observedTargets: ["Gate Open", "开门"] }]
);
assert.equal(discoveryClosure.pendingTranslationDiscoveries().length, 0);
assert.deepEqual(discoveryClosure.resolvedTranslationTerms(), [
  { source: "ゲートオープン", target: "开门", observedTargets: ["Gate Open", "开门"] }
]);
rollbackDiscoveryResolution();
assert.equal(discoveryClosure.pendingTranslationDiscoveries().length, 2, "failed asset persistence must restore discovery debt");
assert.equal(discoveryClosure.pendingTranslationDiscoveryConflicts().length, 1);
discoveryClosure.resolveTranslationDiscoveries(
  ["term-gate-a", "term-gate-b"],
  [{ source: "ゲートオープン", target: "开门", observedTargets: ["Gate Open", "开门"] }]
);
assert.equal(discoveryClosure.translationDiscoveryObservations().length, 2,
  "settling discoveries must retain their hash-bound observed evidence");
discoveryClosure.releaseTranslationTerminologyGate();
await terminologyGateWait;
assert.equal(terminologyGateOpened, true);
discoveryClosure.recordTranslationTerminologyDebt([{
  documentId: "source",
  line: 1,
  source: "ゲートオープン",
  expectedTarget: "开门",
  observedTargets: ["Gate Open"]
}]);
assert.match(discoveryClosure.incompleteReasons().join("\n"), /cross-file terminology inconsistency/i);
discoveryClosure.recordTranslationTerminologyDebt([]);
assert.doesNotMatch(discoveryClosure.incompleteReasons().join("\n"), /cross-file terminology inconsistency/i);

const activeDelegatedBatch = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 2
});
activeDelegatedBatch.recordInspection({
  sourceLineCount: 10,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
activeDelegatedBatch.recordSubagentBatchStarted("translation", "active-user-batch", { taskCount: 2, workerCount: 2 });
assert.equal(activeDelegatedBatch.configuredSubagents, 2);
activeDelegatedBatch.recordTranslationArtifactMutation();
activeDelegatedBatch.recordSubagentBatch("translation", "active-user-batch", 2);
activeDelegatedBatch.recordFinalValidation("translation");
assert.deepEqual(activeDelegatedBatch.incompleteReasons(), []);

const contract = createYnDomainRunContract({
  workflowIntent: "translation",
  workflowRequirements: {
    glossaryCandidate: true,
    characterBible: true
  },
  prompt: [
    "Generate AI_translation/_workspace/glossary_candidates.json before spawning translation subagents.",
    "Character bible module: on. Generate AI_translation/_workspace/character_bible.md"
  ].join("\n")
});

assert.match(contract.nextRepairPrompt() || "", /inspect translation context/);

contract.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: false,
  characterBibleExists: false
});
assert.match(contract.nextRepairPrompt() || "", /glossary candidate/);

contract.recordWorkflowWrite("AI_translation/_workspace/glossary_candidates.json");
assert.match(
  contract.nextRepairPrompt() || "",
  /character bible/,
  "host progress must allow a third repair turn instead of hitting a fixed global cap"
);

contract.recordWorkflowWrite("AI_translation/_workspace/character_bible.md");
assert.match(contract.nextRepairPrompt() || "", /translation subagents/);

contract.recordSubagentBatchStarted("translation", "initial-translation", { taskCount: 2, workerCount: 2 });
contract.recordTranslationArtifactMutation();
contract.recordSubagentBatch("translation", "initial-translation", 2);
assert.match(contract.nextRepairPrompt() || "", /whole-artifact validation/);

contract.recordFinalValidation("translation");
assert.deepEqual(contract.incompleteReasons(), []);
assert.equal(contract.nextRepairPrompt(), undefined);

const stalled = createYnDomainRunContract({ workflowIntent: "translation" });
const first = stalled.nextRepairPrompt();
const second = stalled.nextRepairPrompt();
const third = stalled.nextRepairPrompt();
assert.ok(first);
assert.ok(second);
assert.ok(third, "the native Pi completion loop must not stop at a fixed small no-progress cap");
assert.match(third, /No host-observed progress/i);
assert.ok(stalled.nextRepairPrompt(), "repeated status-only replies must keep receiving actionable continuation debt");

const rerun = createYnDomainRunContract({ workflowIntent: "translation" });
rerun.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
rerun.recordSubagentBatchStarted("translation", "rerun-initial", { taskCount: 2, workerCount: 2 });
rerun.recordTranslationArtifactMutation();
rerun.recordSubagentBatch("translation", "rerun-initial", 2);
rerun.recordFinalValidation("translation");
assert.deepEqual(rerun.incompleteReasons(), []);
rerun.recordSubagentBatchStarted("translation", "rerun-replacement", { taskCount: 2, workerCount: 2 });
rerun.recordTranslationArtifactMutation();
rerun.recordSubagentBatch("translation", "rerun-replacement", 2);
rerun.recordFinalValidation("translation");
assert.deepEqual(
  rerun.incompleteReasons(),
  [],
  "a later successful full repair batch must replace, not poison, the prior completed batch contract"
);

const activityIsNotProgress = createYnDomainRunContract({ workflowIntent: "translation" });
activityIsNotProgress.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.ok(activityIsNotProgress.nextRepairPrompt());
activityIsNotProgress.recordTranslationArtifactMutation();
assert.ok(activityIsNotProgress.nextRepairPrompt());
activityIsNotProgress.recordTranslationArtifactMutation();
const mutatedAgainPrompt = activityIsNotProgress.nextRepairPrompt() || "";
assert.match(mutatedAgainPrompt, /whole-artifact validation/i);
assert.doesNotMatch(
  mutatedAgainPrompt,
  /No host-observed progress/i,
  "a real candidate revision is Host-observed progress even though validation debt remains"
);

const validationProgress = createYnDomainRunContract({ workflowIntent: "translation" });
validationProgress.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
validationProgress.recordSubagentBatchStarted("translation", "validation-progress", { taskCount: 2, workerCount: 2 });
validationProgress.recordTranslationArtifactMutation();
validationProgress.recordSubagentBatch("translation", "validation-progress", 2);
validationProgress.recordTranslationValidation("translation", 3);
assert.ok(validationProgress.nextRepairPrompt());
validationProgress.recordTranslationArtifactMutation();
validationProgress.recordTranslationValidation("translation", 2);
assert.ok(validationProgress.nextRepairPrompt());
validationProgress.recordTranslationArtifactMutation();
validationProgress.recordTranslationValidation("translation", 1);
assert.ok(validationProgress.nextRepairPrompt(), "strictly decreasing host validation debt should permit another repair turn");
validationProgress.recordTranslationArtifactMutation();
validationProgress.recordTranslationValidation("translation", 0);
assert.deepEqual(validationProgress.incompleteReasons(), []);
assert.throws(
  () => validationProgress.recordTranslationValidation("translation", -1),
  /Invalid translation validation debt/i,
  "negative validation debt must not be normalized into a successful whole-artifact validation"
);
assert.throws(
  () => validationProgress.recordTranslationValidation("translation", Number.POSITIVE_INFINITY),
  /Invalid translation validation debt/i
);

const detachedValidation = createYnDomainRunContract({ workflowIntent: "translation" });
detachedValidation.recordInspection({
  sourceLineCount: 1,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
detachedValidation.recordTranslationWrite("translation");
const { recordFinalValidation } = detachedValidation;
recordFinalValidation("translation");
assert.deepEqual(
  detachedValidation.incompleteReasons(),
  [],
  "recordFinalValidation must not depend on an object-method this binding"
);

const failedBatchActivity = createYnDomainRunContract({ workflowIntent: "translation" });
failedBatchActivity.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.ok(failedBatchActivity.nextRepairPrompt());
failedBatchActivity.recordSubagentBatchStarted("translation", "failed-activity-1", { taskCount: 2, workerCount: 2 });
failedBatchActivity.recordSubagentBatchFailure("translation", "failed-activity-1");
assert.equal(failedBatchActivity.nextRepairPrompt(), undefined);
failedBatchActivity.resumeAfterExplicitContinuation(failedBatchActivity.recoveryPauseId);
failedBatchActivity.recordSubagentBatchStarted("translation", "failed-activity-2", { taskCount: 2, workerCount: 2 });
failedBatchActivity.recordSubagentBatchFailure("translation", "failed-activity-2");
assert.equal(
  failedBatchActivity.nextRepairPrompt(),
  undefined,
  "each exhausted replacement batch must return to an explicit user continuation boundary"
);

const batchOwner = createYnDomainRunContract({ workflowIntent: "translation" });
batchOwner.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
batchOwner.recordSubagentBatchStarted("translation", "batch-old", { taskCount: 2, workerCount: 2 });
batchOwner.recordSubagentBatchFailure("translation", "batch-old");
batchOwner.resumeAfterExplicitContinuation(batchOwner.recoveryPauseId);
batchOwner.recordSubagentBatchStarted("translation", "batch-new", { taskCount: 2, workerCount: 2 });
assert.throws(
  () => batchOwner.recordSubagentBatch("translation", "batch-old", 2),
  /batch-new|current|stale/i,
  "a stale batch may not restore completion ownership after its replacement starts"
);

const proofreadRevision = createYnDomainRunContract({ workflowIntent: "proofread" });
proofreadRevision.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
proofreadRevision.recordProofreadPrescan();
proofreadRevision.recordSourceRead();
proofreadRevision.recordTranslationRead();
proofreadRevision.recordProofreadArtifactReset();
proofreadRevision.recordSubagentBatchStarted("proofread", "proofread-revision", { taskCount: 2, workerCount: 2 });
proofreadRevision.recordProofreadArtifactMutation();
proofreadRevision.recordSubagentBatch("proofread", "proofread-revision", 2);
proofreadRevision.recordProofreadReportFinalized();
assert.deepEqual(proofreadRevision.incompleteReasons(), []);
const legacyProofreadSnapshot = structuredClone(proofreadRevision.snapshot());
legacyProofreadSnapshot.schemaVersion = 4;
for (const document of legacyProofreadSnapshot.documents) {
  document.proofreadSummaryWritten = document.proofreadReportFinalized;
  delete document.proofreadReportFinalized;
}
const restoredProofreadRevision = createYnDomainRunContract({
  workflowIntent: "proofread",
  restoreSnapshot: legacyProofreadSnapshot
});
const restoredProofreadSnapshot = restoredProofreadRevision.snapshot();
assert.equal(restoredProofreadSnapshot.schemaVersion, 6);
assert.equal(restoredProofreadSnapshot.documents[0].proofreadReportFinalized, true);
assert.equal(Object.hasOwn(restoredProofreadSnapshot.documents[0], "proofreadSummaryWritten"), false);
proofreadRevision.recordProofreadArtifactMutation();
assert.match(
  proofreadRevision.incompleteReasons().join("\n"),
  /findings artifact/i,
  "a later report mutation reused stale successful proofread batch authorization"
);

const folderBatch = createYnDomainRunContract({
  workflowIntent: "translation",
  folderSource: true
});
folderBatch.recordInspection({
  sourceLineCount: 2,
  documents: [
    { id: "chapter/a.txt", sourceLineCount: 2 },
    { id: "chapter/b.txt", sourceLineCount: 1 }
  ],
  glossaryCandidateExists: true,
  characterBibleExists: true
});
folderBatch.recordSubagentBatchStarted("translation", "folder-a", {
  taskCount: 2,
  workerCount: 2,
  documentIds: ["chapter/a.txt", "chapter/b.txt"]
});
folderBatch.recordTranslationArtifactMutation("chapter/a.txt");
folderBatch.recordTranslationArtifactMutation("chapter/b.txt");
folderBatch.recordSubagentBatch("translation", "folder-a", 2, ["chapter/a.txt", "chapter/b.txt"]);
folderBatch.recordFinalValidation("translation", "chapter/a.txt");
assert.match(folderBatch.incompleteReasons().join("\n"), /chapter\/b\.txt.*whole-artifact validation/i);
folderBatch.recordFinalValidation("translation", "chapter/b.txt");
assert.deepEqual(folderBatch.incompleteReasons(), [], "folder completion requires every manifest document to validate");

const folderExactWorkerPool = createYnDomainRunContract({
  workflowIntent: "translation",
  folderSource: true,
  subagentEnabled: true,
  subagentCount: 5
});
folderExactWorkerPool.recordInspection({
  sourceLineCount: 8,
  documents: [
    { id: "chapter/a.txt", sourceLineCount: 4 },
    { id: "chapter/b.txt", sourceLineCount: 4 }
  ],
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.doesNotThrow(
  () => folderExactWorkerPool.recordSubagentBatchStarted("translation", "folder-five-workers", {
    taskCount: 8,
    workerCount: 5,
    documentIds: ["chapter/a.txt", "chapter/b.txt"]
  }),
  "five explicitly requested workers may drain more than five queued assignments"
);
folderExactWorkerPool.recordTranslationArtifactMutation("chapter/a.txt");
folderExactWorkerPool.recordTranslationArtifactMutation("chapter/b.txt");
assert.throws(
  () => folderExactWorkerPool.recordSubagentBatch("translation", "folder-five-workers", 5, ["chapter/a.txt", "chapter/b.txt"]),
  /5 results for 8 accepted tasks/i,
  "completion is measured against assignment count, not worker count"
);
folderExactWorkerPool.recordSubagentBatch("translation", "folder-five-workers", 8, ["chapter/a.txt", "chapter/b.txt"]);
folderExactWorkerPool.recordFinalValidation("translation", "chapter/a.txt");
folderExactWorkerPool.recordFinalValidation("translation", "chapter/b.txt");
assert.deepEqual(folderExactWorkerPool.incompleteReasons(), []);

const activeExactBatchWithLaterProjectCeiling = createYnDomainRunContract({
  workflowIntent: "translation",
  subagentEnabled: true,
  subagentCount: 5
});
activeExactBatchWithLaterProjectCeiling.recordInspection({
  sourceLineCount: 4,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
activeExactBatchWithLaterProjectCeiling.recordSubagentBatchStarted("translation", "turn-scoped-two", {
  taskCount: 4,
  workerCount: 2
});
assert.doesNotThrow(
  () => activeExactBatchWithLaterProjectCeiling.configureProjectSubagentCeiling(true, 5),
  "a completed parent turn may restore the future 1..N ceiling while the accepted batch settles from its own snapshot"
);
assert.equal(activeExactBatchWithLaterProjectCeiling.configuredSubagents, 5);
activeExactBatchWithLaterProjectCeiling.recordTranslationArtifactMutation();
activeExactBatchWithLaterProjectCeiling.recordSubagentBatch("translation", "turn-scoped-two", 4);
activeExactBatchWithLaterProjectCeiling.recordFinalValidation("translation");
assert.deepEqual(activeExactBatchWithLaterProjectCeiling.incompleteReasons(), []);

const activeTemporaryBatchAfterProjectDisable = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 2
});
activeTemporaryBatchAfterProjectDisable.recordInspection({
  sourceLineCount: 4,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
activeTemporaryBatchAfterProjectDisable.recordSubagentBatchStarted("translation", "temporary-two", {
  taskCount: 4,
  workerCount: 2
});
activeTemporaryBatchAfterProjectDisable.configureProjectSubagentCeiling(false, 5);
assert.equal(activeTemporaryBatchAfterProjectDisable.configuredSubagents, 0);
activeTemporaryBatchAfterProjectDisable.recordTranslationArtifactMutation();
assert.doesNotThrow(
  () => activeTemporaryBatchAfterProjectDisable.recordSubagentBatch("translation", "temporary-two", 4),
  "an accepted temporary batch must settle from its own snapshot after the future project ceiling returns to disabled"
);
activeTemporaryBatchAfterProjectDisable.recordFinalValidation("translation");
assert.deepEqual(activeTemporaryBatchAfterProjectDisable.incompleteReasons(), []);

const fullWorkflowBatchAfterProjectDisable = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 2
});
fullWorkflowBatchAfterProjectDisable.recordInspection({
  sourceLineCount: 4,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
fullWorkflowBatchAfterProjectDisable.recordSubagentBatchStarted("translation", "full-temporary-two", {
  taskCount: 4,
  workerCount: 2
});
fullWorkflowBatchAfterProjectDisable.configureProjectSubagentCeiling(false, 5);
fullWorkflowBatchAfterProjectDisable.recordTranslationArtifactMutation();
fullWorkflowBatchAfterProjectDisable.recordSubagentBatch("translation", "full-temporary-two", 4);
fullWorkflowBatchAfterProjectDisable.recordFinalValidation("translation");
assert.deepEqual(
  fullWorkflowBatchAfterProjectDisable.incompleteReasons(),
  [],
  "a Host-accepted full-workflow batch remains complete after the future project child ceiling is disabled"
);

const folderWrongExactWorkerPool = createYnDomainRunContract({
  workflowIntent: "translation",
  folderSource: true,
  subagentEnabled: true,
  subagentCount: 5
});
folderWrongExactWorkerPool.recordInspection({
  sourceLineCount: 8,
  documents: [{ id: "chapter/a.txt", sourceLineCount: 8 }],
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.doesNotThrow(
  () => folderWrongExactWorkerPool.recordSubagentBatchStarted("translation", "folder-four-workers", {
    taskCount: 8,
    workerCount: 4,
    documentIds: ["chapter/a.txt"]
  }),
  "any useful worker count from 1 through the configured ceiling is valid"
);

const configuredCount = createYnDomainRunContract({
  workflowIntent: "translation",
  subagentEnabled: true,
  subagentCount: 3
});
configuredCount.recordInspection({
  sourceLineCount: 3,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.equal(configuredCount.maximumSubagentsForActiveDocument, 3);
configuredCount.recordSubagentBatchStarted("translation", "three-way", { taskCount: 3, workerCount: 3 });
configuredCount.recordTranslationArtifactMutation();
configuredCount.recordSubagentBatch("translation", "three-way", 3);
configuredCount.recordFinalValidation("translation");
assert.deepEqual(configuredCount.incompleteReasons(), []);

const repairOwnedFolderDocument = createYnDomainRunContract({
  workflowIntent: "translation",
  folderSource: true,
  subagentEnabled: true,
  subagentCount: 2
});
repairOwnedFolderDocument.recordInspection({
  sourceLineCount: 2,
  documents: [
    { id: "a.txt", sourceLineCount: 1 },
    { id: "b.txt", sourceLineCount: 1 }
  ],
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.doesNotThrow(() => repairOwnedFolderDocument.recordSubagentBatchStarted(
  "translation",
  "folder-repair-ownership",
  {
    taskCount: 1,
    workerCount: 1,
    documentIds: ["a.txt", "b.txt"],
    assignmentCounts: { "a.txt": 0, "b.txt": 1 }
  }
));
assert.doesNotThrow(() => repairOwnedFolderDocument.recordSubagentBatchSettlement(
  "translation",
  "folder-repair-ownership",
  [
    { documentId: "a.txt", acceptedResultCount: 0, failedResultCount: 0 },
    { documentId: "b.txt", acceptedResultCount: 1, failedResultCount: 0 }
  ]
));

const disabled = createYnDomainRunContract({
  workflowIntent: "translation",
  subagentEnabled: false,
  subagentCount: 3
});
disabled.recordInspection({
  sourceLineCount: 3,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
assert.equal(disabled.maximumSubagentsForActiveDocument, 0);
assert.throws(
  () => disabled.recordSubagentBatchStarted("translation", "disabled", { taskCount: 3, workerCount: 3 }),
  /parent Agent|disabled/i
);
disabled.recordTranslationWrite("translation");
disabled.recordFinalValidation("translation");
assert.deepEqual(disabled.incompleteReasons(), []);

const resumeClearsPause = createYnDomainRunContract({ workflowIntent: "translation" });
resumeClearsPause.recordInspection({
  sourceLineCount: 2,
  glossaryCandidateExists: true,
  characterBibleExists: true
});
resumeClearsPause.recordSubagentBatchStarted("translation", "auth-paused", { taskCount: 1, workerCount: 1 });
resumeClearsPause.recordSubagentBatchFailure("translation", "auth-paused");
assert.ok(resumeClearsPause.recoveryPauseId);
resumeClearsPause.suspend();
resumeClearsPause.resume();
assert.equal(resumeClearsPause.recoveryPauseId, undefined, "resume() must drop the exhausted-assignment pause before later Host mutations");
assert.doesNotThrow(
  () => resumeClearsPause.recordTranslationReuseAuditReady([]),
  "resuming a parked failed batch must not stay blocked on explicit user continuation"
);

const warningReviewGate = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: true,
  subagentEnabled: true,
  subagentCount: 3
});
warningReviewGate.registerSourceManifest([{ id: "source.txt", sourceLineCount: 2 }]);
warningReviewGate.recordInspection({
  sourceLineCount: 2,
  documents: [{ id: "source.txt", sourceLineCount: 2 }],
  glossaryCandidateExists: true,
  characterBibleExists: true
});
warningReviewGate.recordTranslationWrite("translation");
warningReviewGate.recordTranslationValidation("translation", 12);
assert.equal(warningReviewGate.awaitingUserInput, false, "validation debt alone must not stop the completion loop");
warningReviewGate.notePendingTranslationWarningReview();
assert.equal(warningReviewGate.awaitingUserInput, true);
assert.equal(warningReviewGate.nextRepairPrompt(), undefined, "the parent must wait for the user before warning review");
warningReviewGate.recordTranslationWarningReviewDecision("review");
assert.equal(warningReviewGate.awaitingUserInput, false);
assert.equal(warningReviewGate.translationWarningReviewDecision, "review");
warningReviewGate.recordTranslationWarningReviewDecision("skip");
assert.equal(warningReviewGate.awaitingUserInput, false);
assert.equal(warningReviewGate.snapshot().documents[0].validatedArtifactRevision, warningReviewGate.snapshot().documents[0].artifactRevision);
assert.ok(!warningReviewGate.incompleteReasons().some((reason) => /warning review/i.test(reason)));

console.log("ok YN completion repair follows host progress rather than a fixed global turn cap");
