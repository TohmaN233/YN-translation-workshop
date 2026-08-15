import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import { writeTranslationChunk } from "../../src/main/agent/writeTranslationChunk.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-resume-validated-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "one\n", "utf8");
await writeTranslationChunk({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt",
  fromLine: 1,
  toLine: 1,
  lines: ["一"]
});
await new PiSessionRepository(outputDir).create("parent-resume-validated");

const models = createModels();
const provider = fauxProvider({ provider: "resume-validated-child", tokensPerSecond: 10_000 });
models.setProvider(provider.provider);
provider.setResponses([]);

const supervisor = new YnSubagentSupervisor({
  publishCustomMessage: async () => {},
  publishLiveCustomMessage: async () => {},
  createModelSelection: async () => ({
    models,
    model: provider.getModel(),
    providerId: provider.provider.id,
    modelId: provider.getModel().id
  })
});

try {
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "parent-resume-validated",
      prompt: "Resume the file.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 1 }],
    onChunkReadyForReview: async () => ({ accepted: true }),
    maxWorkers: 1
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(batch.subagents[0].completedAssignments, 1);
  assert.equal(await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"), "一\n");
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok persistent Pi workers resume host-validated chunks without retranslating them");
