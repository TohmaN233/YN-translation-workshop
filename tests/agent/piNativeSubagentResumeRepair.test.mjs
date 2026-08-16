import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";

import { writeTranslationChunk } from "../../src/main/agent/writeTranslationChunk.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import { YnSubagentSupervisor } from "../../src/main/agent/piNative/subagentSupervisor.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-resume-repair-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "HeroTerm\ntwo\n", "utf8");
await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
await writeFile(path.join(outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
  entries: [{ source: "HeroTerm", target: "英雄术语" }]
}), "utf8");
await writeTranslationChunk({
  outputDir,
  sourcePaths: [sourcePath],
  documentId: "source.txt",
  fromLine: 1,
  toLine: 2,
  lines: ["英雄", "二"]
});
await new PiSessionRepository(outputDir).create("parent-resume-repair");

const models = createModels();
const provider = fauxProvider({ provider: "resume-repair-child", tokensPerSecond: 10_000 });
models.setProvider(provider.provider);
provider.setResponses([
  fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: "repair-source" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("repairAssignedTranslation", {
    entries: [{ line: 1, translation: "英雄术语" }]
  }, { id: "repair-line" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: "repair-validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Targeted repair completed."))
]);

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
  let reviewCount = 0;
  supervisor.startTranslationBatch({
    request: {
      outputDir,
      sourcePath,
      sessionId: "parent-resume-repair",
      prompt: "Repair the existing candidate.",
      providerId: provider.provider.id,
      modelId: provider.getModel().id,
      languagePair: "en->zh-CN"
    },
    tasks: [{ documentId: "source.txt", fromLine: 1, toLine: 2 }],
    onChunkReadyForReview: async (review) => {
      reviewCount += 1;
      if (reviewCount === 1) {
        assert.equal(review.validation.warnings.some((finding) => finding.code === "glossary_missing"), true);
        return {
          accepted: false,
          feedback: [{ line: 1, reason: "HeroTerm must use the project glossary target 英雄术语." }]
        };
      }
      return { accepted: true };
    },
    maxWorkers: 1
  });
  await supervisor.waitForAll();

  const batch = supervisor.list()[0];
  assert.equal(batch.status, "completed", batch.error);
  assert.equal(reviewCount, 2, "the warning must be semantically rejected once and the exact repair re-reviewed");
  assert.equal(await readFile(path.join(outputDir, "AI_translation", "source_translated.txt"), "utf8"), "英雄术语\n二\n");
  const repository = new PiSessionRepository(outputDir);
  const [childMetadata] = await repository.listChildMetadata();
  const childContext = await (await repository.openChild(childMetadata.id)).buildContext();
  const firstPrompt = childContext.messages
    .find((message) => message.role === "user")
    .content.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(firstPrompt, /call readAssignedSource/i);
  assert.match(firstPrompt, /L1: HeroTerm must use the project glossary target/);
  assert.match(firstPrompt, /compact spans covering the rejected rows/i);
  assert.doesNotMatch(firstPrompt, /do not call readAssignedSource/i);
} finally {
  supervisor.abortAll();
  await supervisor.waitForAll();
  await rm(outputDir, { recursive: true, force: true });
}

console.log("ok persistent Pi workers repair only invalid absolute lines in an existing chunk");
