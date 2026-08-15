import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { resolveTranslationCandidatePath } from "../../src/main/agent/writeTranslationChunk.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-local-repair-ownership-"));
const sourceRoot = path.join(outputDir, "source");
const firstPath = path.join(sourceRoot, "a.txt");
const secondPath = path.join(sourceRoot, "b.txt");
await mkdir(sourceRoot, { recursive: true });
await writeFile(firstPath, "first one\nfirst two\n", "utf8");
await writeFile(secondPath, "second one\nsecond two\n", "utf8");

let capturedBatch;
const subagents = {
  hasWriteConflict: () => false,
  startGeneralBatch(options) {
    capturedBatch = options;
    return {
      id: options.batchId,
      status: "running",
      subagents: [{ id: "bounded-child", label: "bounded child", status: "running" }]
    };
  }
};
const domainRun = createYnDomainRunContract({
  workflowIntent: "translation",
  fullWorkflow: false,
  subagentEnabled: true,
  subagentCount: 2,
  folderSource: true
});
const request = {
  outputDir,
  sourcePath: sourceRoot,
  sourceSelection: { kind: "folder", path: sourceRoot },
  sessionId: "pi_local_repair_ownership",
  prompt: "Repair only b.txt line 2.",
  workflowIntent: "translation",
  providerId: "test",
  modelId: "test",
  languagePair: "en->zh-CN",
  subagentEnabled: true,
  subagentCount: 2
};
const tools = createYnDomainTools({
  request,
  domainRun,
  subagents,
  publishCustomMessage: async () => {}
});
const tool = (name) => {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
};
const execute = (name, params = {}) => tool(name).execute(`call_${name}`, params);

try {
  await execute("writeTranslationChunk", {
    documentId: "b.txt",
    fromLine: 2,
    toLine: 2,
    lines: ["第二行"]
  });
  const secondCandidate = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [secondPath],
    documentId: "b.txt"
  });
  assert.equal(await readFile(secondCandidate, "utf8"), "\n第二行\n");
  assert.equal(domainRun.activeDocumentId, "a.txt", "bounded parent writes must not move the workflow stage");

  await execute("runSubagents", {
    tasks: [{
      mode: "translation_repair",
      label: "repair b line one",
      prompt: "Repair only b.txt line 1.",
      documentId: "b.txt",
      fromLine: 1,
      toLine: 1
    }]
  });
  assert.equal(capturedBatch.tasks[0].documentId, "b.txt");
  assert.equal(capturedBatch.requestForTask(capturedBatch.tasks[0]).sourcePath, secondPath);
  assert.equal(domainRun.activeDocumentId, "a.txt", "bounded child writes must not move the workflow stage");
  console.log("ok parent and child bounded repairs share exact document/range ownership without stage selection");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
