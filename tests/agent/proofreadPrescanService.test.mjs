import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProofreadDeterministicSignals } from "../../src/main/agent/piNative/proofreadPrescan.ts";
import { runProofreadPrescan } from "../../src/main/agent/piNative/proofreadPrescanService.ts";

const directory = await mkdtemp(path.join(os.tmpdir(), "yn-prescan-service-"));
const source = Array.from({ length: 1100 }, (_, i) => `第${i}話のエリザベスが来ました。`);
const translation = source.map((_, i) => `第${i}话伊丽莎白来了。`);
source[499] = "He opened the door. The room was empty.";
source[500] = "A bell rang.";
translation[499] = "他打开了门。";
translation[500] = "房间空无一人。钟声响起。";
for (const i of [1, 700, 1099]) translation[i] = "这是相同的译文。";
const scan = {
  sourceText: source.join("\n"), translationText: translation.join("\n"),
  validationOptions: { languagePair: "en->zh-CN", glossaryEntries: [
    { source: "エリザベス", target: "伊丽莎白" }, { source: "ベス", target: "贝丝" }
  ] }
};
const cache = { directory, documentId: "source.txt", inputHash: "input-1" };
const events = async () => (await readFile(path.join(directory, "events.jsonl"), "utf8"))
  .trim().split("\n").map(JSON.parse);
try {
  const expected = buildProofreadDeterministicSignals(scan);
  assert.ok(expected.some((signal) => signal.line === 500 && signal.code === "M0"));
  assert.ok(expected.some((signal) => signal.line === 701 && /Distinct source rows/.test(signal.evidence)));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let result;
  try { result = await runProofreadPrescan({ ...scan, cache }); }
  finally { clearInterval(timer); }
  assert.deepEqual(result, expected, "background scan must preserve cross-page and whole-file evidence");
  assert.ok(ticks > 0, "main event loop must remain responsive while worker scans");
  assert.deepEqual(await runProofreadPrescan({ ...scan, cache }), expected);
  assert.equal((await events()).filter((event) => event.event === "cache_hit").length, 1);
  const changed = { ...scan, translationText: scan.translationText.replace("伊丽莎白", "错误名字") };
  assert.deepEqual(await runProofreadPrescan({ ...changed, cache: { ...cache, inputHash: "input-2" } }),
    buildProofreadDeterministicSignals(changed));
  assert.equal((await events()).filter((event) => event.event === "completed").length, 2);

  const controller = new AbortController();
  await assert.rejects(runProofreadPrescan({
    ...scan, sourceText: `${scan.sourceText}\n`.repeat(30), translationText: `${scan.translationText}\n`.repeat(30),
    cache: { ...cache, inputHash: "cancelled-input" }, signal: controller.signal,
    onProgress: () => controller.abort(new Error("test cancellation"))
  }), /test cancellation/);
  assert.equal((await events()).at(-1).event, "cancelled");
  const cacheFile = (await readdir(directory)).find((name) => name.endsWith(".json"));
  assert.equal(JSON.parse(await readFile(path.join(directory, cacheFile), "utf8")).inputHash, "input-2",
    "cancelled scans must not replace a completed cache");
  await assert.rejects(runProofreadPrescan({ ...scan, translationText: "one line" }), /aligned files/);
  console.log("ok background prescan parity, event loop, durable cache, invalidation, cancellation and worker error");
} finally {
  await rm(directory, { recursive: true, force: true });
}
