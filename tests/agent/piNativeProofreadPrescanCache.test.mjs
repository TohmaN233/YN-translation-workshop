import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createProofreadHostState } from "../../src/main/agent/piNative/proofreadSessionState.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-prescan-host-cache-"));
const request = { outputDir, sourcePath: path.join(outputDir, "source.txt"),
  translationPath: path.join(outputDir, "translated.txt"), glossaryPath: path.join(outputDir, "terms.json"),
  sessionId: "cache-test", prompt: "Workflow: yn-proofread-v1.", workflowIntent: "proofread",
  providerId: "test", modelId: "test", languagePair: "ja->zh-CN", proofreadMode: "split",
  splitSize: 500, subagentEnabled: true, subagentCount: 3 };
const proofreadState = createProofreadHostState();
const domainRun = createYnDomainRunContract({ ...request, fullWorkflow: true });
const context = { request, proofreadState, domainRun, publishCustomMessage: async () => {},
  subagents: { hasRunning: () => false } };
let tools = createYnDomainTools(context);
const call = (name, params = {}, signal, onUpdate) => tools.find((tool) => tool.name === name)
  .execute(name, params, signal, onUpdate);
const inspect = () => call("inspectTranslationContext");
const journal = async () => (await readFile(path.join(outputDir, ".translation-workshop/agent/proofread-prescans/events.jsonl"), "utf8"))
  .trim().split("\n").map(JSON.parse);
const scans = async () => (await journal()).filter((event) => event.event === "completed").length;
try {
  await writeFile(request.sourcePath, "魔術師です\n次の行です");
  await writeFile(request.translationPath, "这是法师\n这是下一行");
  await writeFile(request.glossaryPath, JSON.stringify({ entries: [{ source: "魔術師", target: "法师" }] }));
  const initial = await inspect();
  assert.equal(await scans(), 1);
  assert.deepEqual((await inspect()).details.proofreadPrescan, initial.details.proofreadPrescan);
  assert.equal(await scans(), 1, "warm inspection must reuse full scan");
  tools = createYnDomainTools(context);
  assert.deepEqual((await inspect()).details.proofreadPrescan, initial.details.proofreadPrescan);
  assert.equal(await scans(), 1, "new tools must reuse the disk cache, not scan again");
  assert.equal((await journal()).filter((event) => event.event === "cache_hit").length, 1);
  await writeFile(request.translationPath, "这是错误译名\n这是下一行");
  await assert.rejects(call("runProofreadSubagents", { workerCount: 1 }), /changed after the deterministic prescan/);
  assert.equal(await scans(), 1, "changed inputs must invalidate before an expensive rescan or child launch");
  assert.equal(proofreadState.documents["source.txt"], undefined);
  await inspect();
  assert.equal(await scans(), 2);
  await writeFile(request.glossaryPath, JSON.stringify({ entries: [{ source: "魔術師", target: "错误译名" }] }));
  const changedAssets = await inspect();
  assert.equal(await scans(), 3);
  assert.equal(changedAssets.details.proofreadPrescan.countsByCode.H3, 0);
  request.auditWhitelistLines = [1];
  tools = createYnDomainTools(context);
  await inspect();
  assert.equal(await scans(), 4, "whitelist changes must have their own cache key");
  request.customPreserveRules = [{ label: "kana", pattern: "です", flags: "u" }];
  tools = createYnDomainTools(context);
  await inspect();
  assert.equal(await scans(), 5, "preservation rules must participate in input identity");
  await writeFile(request.sourcePath, "違う文です\n次の行です");
  const controller = new AbortController();
  await assert.rejects(call("inspectTranslationContext", {}, controller.signal,
    () => controller.abort(new Error("host cancellation"))), /host cancellation/);
  assert.equal(await scans(), 5, "tool cancellation must propagate to the actual worker");
  console.log("ok Host prescan cache survives tool recreation, invalidates exact inputs/assets, and respects Stop");
} finally { await rm(outputDir, { recursive: true, force: true }); }
