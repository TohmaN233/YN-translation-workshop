import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { createPiTranslationReviewSubagentWorker } from "../../src/main/agent/piNative/subagentRunner.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { appendSessionMessage, readSessionEntries } from "../../src/main/agent/piNative/sessionAccess.ts";
import { prepareTranslationStagingCandidate, resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-review-native-compaction-"));
const repository = new PiSessionRepository(outputDir);
let worker;
try {
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 500 }, (_, index) => `Source sentence ${index + 1} preserves its distinct complete meaning.`);
  const candidateLines = sourceLines.map((_line, index) => `第${index + 1}行保留原句完整含义。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`);
  await repository.create("review-parent");
  const provider = fauxProvider({ provider: "native-review-compaction", tokensPerSecond: 1_000_000,
    models: [{ id: "review-model", reasoning: false, contextWindow: 64_000, maxTokens: 4096 }] });
  const models = createModels(); models.setProvider(provider.provider);
  const request = { outputDir, sourcePath, sessionId: "review-parent", prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation", languagePair: "en->zh-CN", splitSize: 500, subagentEnabled: true,
    subagentCount: 1, glossaryCandidates: false, characterBible: false, thinkingLevel: "off",
    providerId: provider.provider.id, modelId: provider.getModel().id };
  const alignment = createTranslationAlignmentHostState();
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
  let batch;
  const persisted = [];
  const tools = createYnDomainTools({ request, domainRun, translationAlignmentState: alignment,
    publishCustomMessage: async () => {}, persistHostState: async () => { persisted.push(structuredClone(alignment)); },
    subagents: { hasRunning: () => false, startTranslationBatch(options) { batch = options; return { id: "review-compaction-batch", subagents: [], status: "running" }; } } });
  await tools.find(tool => tool.name === "runTranslationSubagents").execute("start", {});
  const canonicalPath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, `${candidateLines.join("\n")}\n`);
  const stagingPath = await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt",
    sessionId: request.sessionId, subagentId: "translator", assignmentId: "source.txt:L1-L500" });
  const checkpoint = () => batch.onStagingCandidateCheckpoint({ documentId: "source.txt", fromLine: 1, toLine: 500,
    candidatePath: stagingPath, accepted: true, requiredLines: [], repairIssues: [] });
  const prepare = () => batch.prepareChunkReview({ documentId: "source.txt", subagentId: "translator", label: "Translator",
    fromLine: 1, toLine: 500, candidatePath: stagingPath, validation: { accepted: true, ok: true, blocking: [], warnings: [] },
    discoveries: { glossaryCandidates: [], characterFacts: [] } });
  await checkpoint();
  const prepared = await prepare();
  const assignment = await prepared.read(prepared.task);
  const failedLines = assignment.windows.flatMap(window => window.rows.filter(row => row.selected).map(row => row.line)).slice(0, 10);
  assert.equal(failedLines.length, 10);
  const context = { request, task: prepared.task, subagentId: "reviewer", readAssignment: prepared.read, submitAssignment: prepared.submit,
    publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(),
      providerId: provider.provider.id, modelId: provider.getModel().id }) };
  let childSession;
  const createChild = PiSessionRepository.prototype.createChild;
  PiSessionRepository.prototype.createChild = async function (...args) {
    childSession = await createChild.apply(this, args);
    for (let index = 0; index < 22; index++) {
      await appendSessionMessage(childSession, { role: "user", content: `old user ${index}: ${"u".repeat(5000)}`, timestamp: Date.now() });
      await appendSessionMessage(childSession, fauxAssistantMessage(fauxText(`old assistant ${index}: ${"a".repeat(5000)}`)));
    }
    return childSession;
  };
  try { worker = await createPiTranslationReviewSubagentWorker(context); }
  finally { PiSessionRepository.prototype.createChild = createChild; }
  provider.setResponses([
    fauxAssistantMessage(fauxText("## Goal\nKeep the current translation review and its authoritative failure verdict.")),
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: failedLines.map(line => ({ line, code: "omission", note: "Restore this line's omitted meaning." })) }), { stopReason: "toolUse" })
  ]);
  const rejected = await worker.runAssignment(context);
  assert.equal(rejected.decision.accepted, false);
  assert.deepEqual(rejected.decision.feedback.map(row => row.line), failedLines);
  assert.equal(provider.state.callCount, 3, "native compaction must not cause a duplicate reviewer provider turn");
  const entries = await readSessionEntries(childSession);
  assert.equal(entries.filter(entry => entry.type === "compaction").length, 1, "the fixture must trigger real native Pi threshold compaction");
  assert.equal(entries.filter(entry => entry.type === "message" && entry.message.role === "user"
    && JSON.stringify(entry.message.content).includes("Review translation safety gate")).length, 1);
  assert.deepEqual(await prepared.submit(prepared.task, []), rejected.decision, "repeat receipts retain all ten real rejection rows");
  const oldAccepted = alignment.ranges["source.txt"][0].checks.filter(check => check.verdict === "aligned").map(check => check.line);
  for (const line of failedLines) candidateLines[line - 1] = `第${line}行修复遗漏并保留原句完整含义。`;
  await writeFile(stagingPath, `${candidateLines.join("\n")}\n`);
  await checkpoint();
  const repaired = await prepare();
  assert.deepEqual(alignment.ranges["source.txt"][0].checks.filter(check => !check.verdict).map(check => check.line), failedLines);
  assert.ok(oldAccepted.every(line => alignment.ranges["source.txt"][0].checks.find(check => check.line === line)?.verdict === "aligned"));
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" })
  ]);
  const accepted = await worker.runAssignment({ ...context, task: repaired.task, readAssignment: repaired.read, submitAssignment: repaired.submit });
  assert.equal(accepted.decision.accepted, true);
  await writeFile(canonicalPath, await readFile(stagingPath));
  await batch.onArtifactMutation("source.txt", { fromLine: 1, toLine: 500 });
  assert.equal(alignment.ranges["source.txt"][0].candidatePath, canonicalPath);
  assert.ok(alignment.ranges["source.txt"][0].checks.every(check => check.verdict === "aligned"));
  assert.ok(persisted.some(snapshot => snapshot.ranges["source.txt"]?.[0].checks.filter(check => check.verdict === "misaligned").length === 10));
  console.log("ok real native reviewer threshold compaction submits once, retains ten failures, and commits only after exact repair/review");
} finally {
  if (worker) await worker.dispose();
  await repository.close();
  await rm(outputDir, { recursive: true, force: true });
}
