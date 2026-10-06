import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createTranslationAlignmentHostState } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { createPiTranslationReviewSubagentWorker } from "../../src/main/agent/piNative/subagentRunner.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { appendSessionMessage, readSessionEntries } from "../../src/main/agent/piNative/sessionAccess.ts";
import { prepareTranslationStagingCandidate, resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import { TranslationReviewBindingChangedError } from "../../src/main/agent/piNative/assignmentFailure.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-review-preservation-"));
const repository = new PiSessionRepository(outputDir);
let worker;
try {
  const sourcePath = path.join(outputDir, "source.txt");
  const sourceLines = Array.from({ length: 2 }, (_, index) => `ソロモン：マユラがここで待っている${index + 1}。`);
  const candidateLines = sourceLines.map((_line, index) => `ソロモン：マユラ在这里等待${index + 1}。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`);
  await repository.create("review-parent");
  const provider = fauxProvider({ provider: "native-review-compaction", tokensPerSecond: 1_000_000,
    models: [{ id: "review-model", reasoning: false, contextWindow: 64_000, maxTokens: 4096 }] });
  const models = createModels(); models.setProvider(provider.provider);
  const request = { outputDir, sourcePath, sessionId: "review-parent", prompt: "Workflow: yn-translation-v1.",
    workflowIntent: "translation", languagePair: "ja->zh-CN", customPreserveRules: [{ pattern: "^[^：:\\r\\n]+[：:]", flags: "u" }], splitSize: 500, subagentEnabled: true,
    subagentCount: 1, glossaryCandidates: false, characterBible: false, thinkingLevel: "off",
    providerId: provider.provider.id, modelId: provider.getModel().id };
  const alignment = createTranslationAlignmentHostState();
  const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
  let batch;
  const persisted = [];
  const hostContext = { request, domainRun, translationAlignmentState: alignment,
    publishCustomMessage: async () => {}, persistHostState: async () => { persisted.push(structuredClone(alignment)); },
    subagents: { hasRunning: () => false, startTranslationBatch(options) { batch = options; return { id: "review-compaction-batch", subagents: [], status: "running" }; } } };
  const tools = createYnDomainTools(hostContext);
  await tools.find(tool => tool.name === "recordTranslationPreservedTerms").execute("preserve-name", {
    entries: [{ source: "マユラ", rationale: "The supplied guide explicitly keeps マユラ unchanged." }]
  });
  await tools.find(tool => tool.name === "runTranslationSubagents").execute("start", {});
  const canonicalPath = resolveTranslationCandidatePath({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, `${candidateLines.join("\n")}\n`);
  const stagingPath = await prepareTranslationStagingCandidate({ outputDir, sourcePaths: [sourcePath], documentId: "source.txt",
    sessionId: request.sessionId, subagentId: "translator", assignmentId: "source.txt:L1-L2" });
  const checkpoint = () => batch.onStagingCandidateCheckpoint({ documentId: "source.txt", fromLine: 1, toLine: 2,
    candidatePath: stagingPath, accepted: true, requiredLines: [], repairIssues: [] });
  const prepare = () => batch.prepareChunkReview({ documentId: "source.txt", subagentId: "translator", label: "Translator",
    fromLine: 1, toLine: 2, candidatePath: stagingPath, validation: { accepted: true, ok: true, blocking: [], warnings: [] },
    discoveries: { glossaryCandidates: [], characterFacts: [] } });
  await checkpoint();
  const prepared = await prepare();
  const context = { request, task: prepared.task, readAssignment: prepared.read, submitAssignment: prepared.submit,
    publishCustomMessage: async () => {}, createModelSelection: async () => ({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id}) };
  provider.setResponses([
    async (input) => {
      const text = input.messages.filter(m=>m.role==='user').map(m=>JSON.stringify(m.content)).join('\n');
      assert.match(text, /intentionally untranslated/);
      assert.ok(text.includes('Custom verbatim preservation rules'));
      return fauxAssistantMessage(fauxToolCall('readAssignedTranslationReview',{}),{stopReason:'toolUse'});
    },
    fauxAssistantMessage(fauxToolCall('submitTranslationReview',{failures:[{line:1,code:'untranslated_residue',note:'Translate the remaining Japanese name マユラ.'}]}),{stopReason:'toolUse'})
  ]);
  worker = await createPiTranslationReviewSubagentWorker(context);
  const result = await worker.runAssignment(context);
  assert.equal(result.decision.accepted,true,'protected prefix and aligned formal glossary name must not cause repair debt');
  assert.ok(alignment.ranges['source.txt'][0].checks.every(c=>c.verdict==='aligned'));
  console.log('PASS native reviewer receives preservation rules and Host rejects false protected-residue debt');
  delete alignment.ranges['source.txt'][0].sourceHash;
  for(const check of alignment.ranges['source.txt'][0].checks)delete check.lineInputHash;
  await checkpoint(); await prepare();
  assert.match(alignment.ranges['source.txt'][0].sourceHash,/^[a-f0-9]{64}$/u);
  assert.ok(alignment.ranges['source.txt'][0].checks.every(c=>c.verdict==='aligned'&&/^[a-f0-9]{64}$/u.test(c.lineInputHash)), 'hash-current legacy evidence gains recovery proof without losing acceptance');
  await writeFile(stagingPath, `${[sourceLines[0], candidateLines[1]].join('\n')}\n`);
  await checkpoint();
  const untranslated = await prepare();
  await untranslated.read(untranslated.task);
  const rejected = await untranslated.submit(untranslated.task,[{line:1,code:'untranslated_residue',note:'Translate the Japanese dialogue after the preserved speaker prefix.'}]);
  assert.equal(rejected.accepted,false,'unprotected Japanese dialogue remains a genuine failure');
  assert.equal(alignment.ranges['source.txt'][0].checks.find(c=>c.line===1).verdict,'misaligned');
  const replacementPath = await prepareTranslationStagingCandidate({outputDir,sourcePaths:[sourcePath],documentId:'source.txt',
    sessionId:request.sessionId,subagentId:'replacement',assignmentId:'source.txt:L1-L2'});
  await writeFile(replacementPath,`${candidateLines.join('\n')}\n`);
  let bindingError;
  try {
    await batch.prepareChunkReview({documentId:'source.txt',subagentId:'replacement',label:'Replacement',fromLine:1,toLine:2,
      candidatePath:replacementPath,validation:{accepted:true,ok:true,blocking:[],warnings:[]},discoveries:{glossaryCandidates:[],characterFacts:[]}});
  } catch(error) {bindingError=error;}
  assert.ok(bindingError instanceof TranslationReviewBindingChangedError,'path mismatch is a typed Host recovery boundary');
  await hostContext.recoverReviewBinding(bindingError);
  const rebound=alignment.ranges['source.txt'][0];
  assert.equal(rebound.candidatePath,replacementPath);
  assert.equal(rebound.checks.find(c=>c.line===2).verdict,'aligned','unchanged accepted evidence survives rebinding');
  assert.equal(rebound.checks.find(c=>c.line===1).verdict,undefined,'repaired text must be freshly reviewed');
  console.log('PASS rejected range/path mismatch is reconciled by Host without discarding unchanged evidence');
  const replacementArgs={documentId:'source.txt',subagentId:'replacement',label:'Replacement',fromLine:1,toLine:2,
    candidatePath:replacementPath,validation:{accepted:true,ok:true,blocking:[],warnings:[]},discoveries:{glossaryCandidates:[],characterFacts:[]}};
  const replacementReview=await batch.prepareChunkReview(replacementArgs);
  await replacementReview.read(replacementReview.task);
  await replacementReview.submit(replacementReview.task,[{line:1,code:'semantic_mismatch',note:'Correct the remaining meaning on this row.'}]);
  await writeFile(replacementPath,'ソロモン：我会在这里等候。\nソロモン：还要在这里等待。\n');
  let changedAccepted;
  try {await batch.prepareChunkReview(replacementArgs);}catch(error){changedAccepted=error;}
  assert.ok(changedAccepted instanceof TranslationReviewBindingChangedError,'changing an accepted row invalidates repair scope evidence');
  await hostContext.recoverReviewBinding(changedAccepted);
  assert.ok(alignment.ranges['source.txt'][0].checks.every(c=>c.verdict===undefined),'changed accepted rows must not inherit stale acceptance');
  console.log('PASS same-path repair drift reopens changed accepted rows instead of inheriting stale verdicts');
} finally { await worker?.dispose(); await repository.close(); await rm(outputDir,{recursive:true,force:true}); }
