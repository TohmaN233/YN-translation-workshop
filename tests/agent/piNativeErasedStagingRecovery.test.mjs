import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { appendSessionMessage } from "../../src/main/agent/piNative/sessionAccess.ts";
import { recoverErasedTranslationStaging } from "../../src/main/agent/piNative/translationStagingRecovery.ts";
import { createTranslationAlignmentHostState, createTranslationChunkReviewAudit } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { prepareTranslationStagingCandidate, resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";
import { decodeProjectPaths } from "../../src/main/projectPaths.ts";

async function fixture({ failedReceipt = false, wrongOwner = false, tamperedPayload = false, multiPage = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-erased-stage-"));
  const sourcePath = path.join(root, "source.txt");
  const total = multiPage ? 720 : 24;
  const sourceLines = Array.from({ length: total }, (_, index) => `Source sentence ${index + 1} has its complete meaning.`);
  const candidates = sourceLines.map((_source, index) => `第${index + 1}句保留自己的完整含义。`);
  await writeFile(sourcePath, `${sourceLines.join("\n")}\n`);
  const repository = new PiSessionRepository(root);
  await repository.create("parent");
  const child = await repository.createChild("historical-child", wrongOwner ? "other-parent" : "parent");
  const staging = await prepareTranslationStagingCandidate({ outputDir: root, sourcePaths: [sourcePath], documentId: "source.txt", sessionId: "parent", subagentId: "historical-child", assignmentId: `source.txt:L1-L${total}` });
  const scope = createTranslationChunkReviewAudit({ documentId: "source.txt", sourceLines, candidateLines: candidates, candidatePath: staging,
    languagePair: "en->zh-CN", fromLine: 1, toLine: total, sourceLineCount: total, mechanicalSignals: [{ line: 3, signals: ["semantic_mistranslation"] }] });
  for (const check of scope.checks) { check.verdict = check.line === 3 ? "misaligned" : "aligned"; if (check.line === 3) check.reason = "semantic_mistranslation: restore this row's own meaning"; }
  for (let page = 0; page < total; page += 500) {
    const count = Math.min(500, total - page);
    const blocks = Array.from({ length: Math.ceil(count / 16) }, (_, index) => ({ id: index.toString(36), absoluteLines: sourceLines.slice(page + index * 16, Math.min(page + count, page + index * 16 + 16)).map((_source, i) => page + index * 16 + i + 1) }));
    await appendSessionMessage(child, { role: "toolResult", toolCallId: `read-${page}`, toolName: "readAssignedSource", content: [{ type: "text", text: "read" }], isError: false,
      details: { assignment: { fromLine: 1, toLine: total }, sourceBlocks: blocks }, timestamp: Date.now() });
    const payload = blocks.map((block) => ({ id: block.id, lines: block.absoluteLines.map((line, index) => `${index.toString(36)}${tamperedPayload ? "不同的内容。" : multiPage && line === 3 ? "第三行修复前的旧内容。" : candidates[line - 1]}`) }));
    await appendSessionMessage(child, fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", { blocks: payload }, { id: `write-${page}` }), { stopReason: "toolUse" }));
    await appendSessionMessage(child, { role: "toolResult", toolCallId: `write-${page}`, toolName: "writeAssignedTranslation", content: [{ type: "text", text: "written" }], isError: failedReceipt,
      details: { result: { ok: !failedReceipt, path: staging, fromLine: page + 1, toLine: page + count, sourceLineCount: total, totalCandidateLines: total }, invalidBlockLines: [] }, timestamp: Date.now() });
  }
  if (multiPage) {
    await appendSessionMessage(child, fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", { entries: [{ line: 3, translation: candidates[2] }] }, { id: "repair" }), { stopReason: "toolUse" }));
    await appendSessionMessage(child, { role: "toolResult", toolCallId: "repair", toolName: "repairAssignedTranslation", content: [{ type: "text", text: "repaired" }], isError: false,
      details: { result: { ok: true, path: staging, fromLine: 1, toLine: total, sourceLineCount: total, totalCandidateLines: total } }, timestamp: Date.now() });
  }
  const childPath = child.metadata.path;
  await repository.close();
  const erased = "\n".repeat(total);
  const canonical = resolveTranslationCandidatePath({ outputDir: root, sourcePaths: [sourcePath], documentId: "source.txt" });
  await mkdir(path.dirname(canonical), { recursive: true }); await writeFile(canonical, erased);
  const alignment = createTranslationAlignmentHostState(); alignment.ranges["source.txt"] = [scope];
  return { root, sourcePath, sourceLines, candidates, erased, staging, canonical, alignment, scope, childPath,
    recovery: () => recoverErasedTranslationStaging({ outputDir: root, parentSessionId: "parent", scope, sourceLines, languagePair: "en->zh-CN" }),
    close: () => rm(root, { recursive: true, force: true }) };
}

test("native acknowledged blocks reconstruct exact evidence without modifying native history", async () => {
  const fx = await fixture();
  try {
    const before = await readFile(fx.childPath);
    assert.deepEqual((await fx.recovery()).lines, fx.candidates);
    assert.deepEqual(await readFile(fx.childPath), before);
  } finally { await fx.close(); }
});

test("copied project reconstructs two native model pages and a later sparse repair through old absolute receipt paths", async () => {
  const fx = await fixture({ multiPage: true });
  const copied = await mkdtemp(path.join(os.tmpdir(), "yn-erased-stage-copied-"));
  try {
    await cp(fx.root, copied, { recursive: true });
    const scope = decodeProjectPaths(fx.scope, copied, fx.root);
    const childPath = path.join(copied, path.relative(fx.root, fx.childPath));
    const before = await readFile(childPath);
    const result = await recoverErasedTranslationStaging({ outputDir: copied, parentSessionId: "parent", scope, sourceLines: fx.sourceLines, languagePair: "en->zh-CN" });
    assert.deepEqual(result.lines, fx.candidates);
    assert.deepEqual(await readFile(childPath), before);
    assert.equal(result.childSessionId, "historical-child");
  } finally { await rm(copied, { recursive: true, force: true }); await fx.close(); }
});

for (const options of [{ failedReceipt: true }, { tamperedPayload: true }]) test(`recovery rejects ${JSON.stringify(options)} instead of trusting model prose`, async () => {
  const fx = await fixture(options);
  try { assert.equal(await fx.recovery(), undefined); } finally { await fx.close(); }
});

test("native child from another parent cannot restore an owned staging identity", async () => {
  const fx = await fixture({ wrongOwner: true });
  try { await assert.rejects(fx.recovery, /does not belong/); } finally { await fx.close(); }
});

for (const fault of [undefined, "persist", "double-persist", "later-scope", "nonblank"]) test(`whole Host recovery ${fault ?? "success"} keeps artifacts and evidence transactional`, async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.staging, fault === "nonblank" ? `${fx.candidates.map(() => "用户保留的修改。").join("\n")}\n` : fx.erased);
    if (fault === "later-scope") {
      const source = [...fx.sourceLines, ...fx.sourceLines]; await writeFile(fx.sourcePath, `${source.join("\n")}\n`);
      fx.scope.sourceLineCount = 48; await writeFile(fx.canonical, "\n".repeat(48)); await writeFile(fx.staging, "\n".repeat(48));
      fx.alignment.ranges["source.txt"].push({ ...fx.scope, fromLine: 25, toLine: 48, sourceLineCount: 47 });
    }
    const before = structuredClone(fx.alignment), previousStaging = await readFile(fx.staging, "utf8");
    let launches = 0, persists = 0;
    const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
    const tools = createYnDomainTools({ request: { outputDir: fx.root, sourcePath: fx.sourcePath, sessionId: "parent", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", languagePair: "en->zh-CN", splitSize: 24, subagentEnabled: true, subagentCount: 1, glossaryCandidates: false, characterBible: false },
      domainRun, translationAlignmentState: fx.alignment, publishCustomMessage: async () => {},
      persistHostState: async () => { persists++; if ((fault === "persist" && persists === 1) || fault === "double-persist") throw new Error("injected recovery persistence failure"); },
      subagents: { hasRunning: () => false, hasWriteConflict: () => false, startTranslationBatch(options) { launches++; return { id: options.batchId, kind: "translation", status: "running", startedAt: 1, subagents: [] }; } } });
    const execute = (name) => tools.find((tool) => tool.name === name).execute(name, {});
    await execute("inspectTranslationContext");
    if (fault) {
      await assert.rejects(() => execute("runTranslationSubagents"), /Host recovery preflight/);
      assert.equal(launches, 0);
      assert.deepEqual(fx.alignment, before);
      assert.equal(await readFile(fx.staging, "utf8"), fault === "double-persist" ? `${fx.candidates.join("\n")}\n` : previousStaging);
      if (["persist", "double-persist"].includes(fault)) {
        const dir = path.join(fx.root, ".translation-workshop/agent/recovery-transactions");
        const receipts = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith("-restore.json"));
        assert.equal(JSON.parse(await readFile(path.join(dir, receipts[0]), "utf8")).phase, fault === "persist" ? "rolled_back" : "compensation_unconfirmed");
      }
    } else {
      await execute("runTranslationSubagents");
      assert.equal(launches, 1);
      assert.deepEqual(fx.alignment, before);
      assert.equal(await readFile(fx.staging, "utf8"), `${fx.candidates.join("\n")}\n`);
      const directory = path.join(fx.root, ".translation-workshop/agent/recovery-transactions");
      const backups = (await readdir(directory, { recursive: true })).filter((file) => file.endsWith("displaced-staging.txt"));
      assert.equal(await readFile(path.join(directory, backups[0]), "utf8"), previousStaging);
    }
  } finally { await fx.close(); }
});

test("restored rejected native staging resumes exact repair and real readonly Pi review", async () => {
  const fx = await fixture();
  let supervisor;
  try {
    await writeFile(fx.staging, fx.erased);
    const provider = fauxProvider({ provider: "erased-recovery", tokensPerSecond: 100_000 });
    const models = createModels(); models.setProvider(provider.provider);
    let writes = 0;
    provider.setResponses(Array.from({ length: 15 }, () => (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult");
      if (getCurrentSystemPrompt(context.messages).includes("translation safety reviewer")) return results.length === 0
        ? fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }), { stopReason: "toolUse" });
      if (results.length === 0) return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}), { stopReason: "toolUse" });
      writes++;
      return fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", { entries: [{ line: 3, translation: "第三句已修复自己的完整含义。" }] }), { stopReason: "toolUse" });
    }));
    supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {}, createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id }) });
    const domainRun = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: true, subagentCount: 1 });
    const tools = createYnDomainTools({ request: { outputDir: fx.root, sourcePath: fx.sourcePath, sessionId: "parent", prompt: "Workflow: yn-translation-v1.", workflowIntent: "translation", languagePair: "en->zh-CN", splitSize: 24, subagentEnabled: true, subagentCount: 1, glossaryCandidates: false, characterBible: false, providerId: provider.provider.id, modelId: provider.getModel().id },
      domainRun, subagents: supervisor, translationAlignmentState: fx.alignment, publishCustomMessage: async () => {}, persistHostState: async () => {} });
    const execute = (name) => tools.find((tool) => tool.name === name).execute(name, {});
    await execute("inspectTranslationContext"); await execute("runTranslationSubagents"); await supervisor.waitForAll();
    assert.ok(supervisor.list().every((batch) => batch.status === "completed"), JSON.stringify(supervisor.list()));
    assert.equal(writes, 1, "recovery must never retranslate the entire chunk");
    const expected = [...fx.candidates]; expected[2] = "第三句已修复自己的完整含义。";
    assert.equal(await readFile(fx.canonical, "utf8"), `${expected.join("\n")}\n`);
    assert.ok(fx.alignment.ranges["source.txt"][0].checks.every((check) => check.verdict === "aligned"));
  } finally { await supervisor?.waitForAll(); await fx.close(); }
});
