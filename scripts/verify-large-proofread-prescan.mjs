import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createYnDomainTools } from "../src/main/agent/piNative/ynDomainTools.ts";
import { createYnDomainRunContract } from "../src/main/agent/piNative/domainRunContract.ts";
import { createProofreadHostState } from "../src/main/agent/piNative/proofreadSessionState.ts";

const [sourcePath, translationPath, glossaryPath, output] = process.argv.slice(2);
assert.ok(sourcePath && translationPath && glossaryPath && output,
  "Usage: node --experimental-strip-types scripts/verify-large-proofread-prescan.mjs SOURCE TRANSLATION GLOSSARY ISOLATED_OUTPUT");
const outputDir = path.resolve(output);
await mkdir(outputDir, { recursive: true });
const request = {
  sourcePath: path.resolve(sourcePath), translationPath: path.resolve(translationPath),
  glossaryPath: path.resolve(glossaryPath), outputDir,
  sessionId: "prescan-verification", prompt: "Workflow: yn-proofread-v1.", workflowIntent: "proofread",
  providerId: "test", modelId: "test", languagePair: "ja->zh-CN", proofreadMode: "split",
  splitSize: 500, subagentEnabled: true, subagentCount: 10
};
const proofreadState = createProofreadHostState();
const domainRun = createYnDomainRunContract({ ...request, fullWorkflow: true });
const context = { request, proofreadState, domainRun, publishCustomMessage: async () => {},
  subagents: { hasRunning: () => false } };
const makeTools = () => createYnDomainTools(context);
const measurements = [];
let tools = makeTools();
for (const mode of ["cold", "warm", "recreated-tools"]) {
  if (mode === "recreated-tools") tools = makeTools();
  let last = performance.now();
  let maxEventLoopDelayMs = 0;
  let ticks = 0;
  let peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - last - 20);
    last = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    ticks++;
  }, 20);
  const start = performance.now();
  let result;
  try {
    result = await tools.find((tool) => tool.name === "inspectTranslationContext")
      .execute(`verify-${mode}`, {}, undefined, (update) => {
        console.log(JSON.stringify({ mode, progress: update.details }));
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally { clearInterval(timer); }
  const measurement = { mode, elapsedMs: Math.round(performance.now() - start),
    maxEventLoopDelayMs: Math.round(maxEventLoopDelayMs), ticks, peakRssMiB: Math.round(peakRss / 1024 ** 2),
    summary: result.details.proofreadPrescan };
  assert.equal(measurement.summary.completed, true);
  measurements.push(measurement);
  console.log(JSON.stringify(measurement));
}
assert.deepEqual(measurements[0].summary, measurements[1].summary);
assert.deepEqual(measurements[0].summary, measurements[2].summary);
const journal = (await readFile(path.join(outputDir, ".translation-workshop/agent/proofread-prescans/events.jsonl"), "utf8"))
  .trim().split("\n").map(JSON.parse);
const evidence = { measurements, scansCompleted: journal.filter((event) => event.event === "completed").length,
  cacheHits: journal.filter((event) => event.event === "cache_hit").length };
await writeFile(path.join(outputDir, "verification.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
