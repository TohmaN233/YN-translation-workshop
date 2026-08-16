import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPiTranslationSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-line-entries-"));
const sourcePath = path.join(outputDir, "source.txt");
await writeFile(sourcePath, "Alpha\n\nBeta {name}\n  \nGamma\n", "utf8");

try {
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sessionId: "pi_line_entries",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 5 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "writeAssignedTranslation");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  const validate = tools.find((tool) => tool.name === "validateAssignedTranslation");
  assert.ok(read);
  assert.ok(write);
  assert.ok(repair);
  assert.deepEqual(write.parameters.required, ["blocks"]);
  assert.equal(Object.hasOwn(write.parameters.properties, "entries"), false);
  assert.equal(Object.hasOwn(write.parameters.properties, "payload"), false);
  assert.equal(write.parameters.additionalProperties, false);
  assert.equal(
    write.parameters.properties.blocks.items.type,
    "object",
    "bulk translation must use bounded typed blocks instead of one failure-prone whole-chunk string"
  );
  assert.deepEqual(write.parameters.properties.blocks.items.required, ["id", "lines"]);
  assert.equal(write.parameters.properties.blocks.items.additionalProperties, false);
  assert.deepEqual(repair.parameters.required, ["entries"]);
  assert.equal(Object.hasOwn(repair.parameters.properties, "blocks"), false);
  assert.equal(repair.parameters.additionalProperties, false);
  assert.equal(repair.parameters.properties.entries.items.type, "object");
  assert.deepEqual(repair.parameters.properties.entries.items.required, ["line", "translation"]);
  assert.equal(repair.parameters.properties.entries.items.additionalProperties, false);

  const source = await read.execute("read", {});
  assert.deepEqual(source.details.sourceBlocks, [{
    id: "0",
    absoluteLines: [1, 3, 5],
    lines: ["0Alpha", "1Beta {name}", "2Gamma"]
  }]);
  assert.equal(Object.hasOwn(source.details, "sourcePayload"), false);
  assert.equal(Object.hasOwn(source.details, "sourceEntries"), false);
  assert.equal(Object.hasOwn(source.details, "preservedEmptyLines"), false);
  assert.equal(Object.hasOwn(source.details, "lines"), false);

  await assert.rejects(
    repair.execute("legacy-pair", { entries: [["1", "阿尔法"]] }),
    /structured.*line.*translation/i,
    "the removed nested-pair wire contract must not survive as a compatibility branch"
  );

  const partial = await repair.execute("partial", {
    entries: [
      { line: 1, translation: "阿尔法" },
      { line: 3, translation: "" },
      { line: 5, translation: "" }
    ]
  });
  assert.deepEqual(partial.details.missingLines, []);
  assert.deepEqual(partial.details.requiredBatchLines, [3, 5]);
  assert.equal(Object.hasOwn(partial.details, "requiredLineContext"), false,
    "repair results must make the child reread source instead of injecting source/candidate text");
  const candidatePath = path.join(outputDir, "AI_translation", "source_translated.txt");
  assert.equal(
    await readFile(candidatePath, "utf8"),
    "阿尔法\n\n\n  \n\n",
    "the host must retain accepted keyed entries while leaving unresolved lines explicitly empty without shifting alignment"
  );

  const partialRepair = await repair.execute("incomplete-missing-batch", {
    entries: [{ line: 3, translation: "贝塔 {name}" }]
  });
  assert.deepEqual(
    partialRepair.details.requiredBatchLines,
    [5],
    "a valid partial correction must be retained and report only the still-invalid line"
  );
  assert.equal(
    await readFile(candidatePath, "utf8"),
    "阿尔法\n\n贝塔 {name}\n  \n\n",
    "repair recovery must not throw away a valid correction because another required line was omitted"
  );

  const complete = await repair.execute("complete", {
    entries: [{ line: 5, translation: "伽马" }]
  });
  assert.deepEqual(complete.details.missingLines, []);
  assert.equal(complete.details.accepted, true, "a complete strict-valid write must be host-validated without another model turn");
  assert.equal(progress.translationValidated, false,
    "an accepted artifact write must not impersonate the mandatory discovery/validation tool");
  const validated = await validate.execute("complete-validate", {
    glossaryCandidates: [],
    characterFacts: []
  });
  assert.equal(validated.terminate, true,
    "successful validation must terminate the Pi tool turn instead of paying for a prose-only continuation");
  assert.equal(progress.translationValidated, true);
  assert.equal(await readFile(candidatePath, "utf8"), "阿尔法\n\n贝塔 {name}\n  \n伽马\n");

  await repair.execute("targeted-repair", {
    fromLine: 3,
    toLine: 3,
    entries: [{ line: 3, translation: "贝塔角色 {name}" }]
  });
  assert.equal(progress.translationValidated, false);
  assert.equal(await readFile(candidatePath, "utf8"), "阿尔法\n\n贝塔角色 {name}\n  \n伽马\n");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

const blockOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-block-wire-"));
const blockSourcePath = path.join(blockOutputDir, "source.txt");
const blockSources = Array.from({ length: 17 }, (_, index) => `Source ${index + 1}`);
await writeFile(blockSourcePath, blockSources.join("\n"), "utf8");
try {
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir: blockOutputDir,
      sourcePath: blockSourcePath,
      sessionId: "pi_block_wire",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 17 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "writeAssignedTranslation");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  const source = await read.execute("block-read", {});
  assert.deepEqual(source.details.sourceBlocks, [
    {
      id: "0",
      absoluteLines: Array.from({ length: 16 }, (_, index) => index + 1),
      lines: blockSources.slice(0, 16).map((text, index) => `${index.toString(36)}${text}`)
    },
    { id: "1", absoluteLines: [17], lines: ["0Source 17"] }
  ]);

  await assert.rejects(
    repair.execute("unsafe-large-positional", {
      entries: blockSources.map((_, index) => `${index + 1}:译文 ${index + 1}`)
    }),
    /bulk.*sourceBlocks/i,
    "a bulk provider response must use the host-identified blocks rather than absolute repair entries"
  );

  const partial = await write.execute("block-partial", {
    blocks: [
      {
        id: "0",
        lines: blockSources.slice(0, 16).flatMap((_, index) => index === 7
          ? ["7译文 8", "7重复译文 8"]
          : [index === 3
            ? " \t3译文 4"
            : `${index.toString(36)}译文 ${index + 1}`])
      },
      { id: "1", lines: ["0译文 17"] }
    ]
  });
  assert.deepEqual(partial.details.invalidBlockLines, [8]);
  assert.deepEqual(partial.details.requiredBatchLines, [8]);
  assert.equal(
    await readFile(path.join(blockOutputDir, "AI_translation", "source_translated.txt"), "utf8"),
    [
      ...blockSources.slice(0, 16).map((sourceText, index) => index === 7
        ? ""
        : `译文 ${index + 1}`),
      "译文 17"
    ].join("\n") + "\n",
    "relative physical-line identities must retain every valid line despite one duplicated record"
  );

  const repaired = await repair.execute("block-sparse-repair", {
    entries: [{ line: 8, translation: "译文 8续" }]
  });
  assert.equal(repaired.details.accepted, true);
  assert.equal(progress.translationValidated, false);
  assert.equal(
    (await readFile(path.join(blockOutputDir, "AI_translation", "source_translated.txt"), "utf8")).split("\n")[7],
    "译文 8续",
    "the host must request and apply only the omitted relative field as an absolute sparse repair"
  );
} finally {
  await rm(blockOutputDir, { recursive: true, force: true });
}

const repairOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-retained-repair-"));
const repairSourcePath = path.join(repairOutputDir, "source.txt");
await writeFile(repairSourcePath, "First\nSecond\nThird", "utf8");
try {
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir: repairOutputDir,
      sourcePath: repairSourcePath,
      sessionId: "pi_retained_repair",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 3 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  await read.execute("repair-read", {});

  const retained = await repair.execute("repair-retain-valid", {
    entries: [
      { line: 1, translation: "第一" },
      { line: 2, translation: "" },
      { line: 3, translation: "第三" }
    ]
  });
  assert.deepEqual(retained.details.requiredBatchLines, [2]);
  assert.equal(
    await readFile(path.join(repairOutputDir, "AI_translation", "source_translated.txt"), "utf8"),
    "第一\n\n第三\n",
    "one invalid line must not discard the other valid translations from the same provider response"
  );

  const repaired = await repair.execute("repair-only-bad-line", {
    fromLine: 2,
    toLine: 2,
    entries: [{ line: 2, translation: "第二" }]
  });
  assert.equal(repaired.details.accepted, true);
  assert.equal(progress.translationValidated, false);
  assert.equal(
    await readFile(path.join(repairOutputDir, "AI_translation", "source_translated.txt"), "utf8"),
    "第一\n第二\n第三\n"
  );
} finally {
  await rm(repairOutputDir, { recursive: true, force: true });
}

const placeholderOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-placeholder-repair-"));
const placeholderSourcePath = path.join(placeholderOutputDir, "source.txt");
await writeFile(placeholderSourcePath, "First {name}\nSecond\nThird", "utf8");
try {
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir: placeholderOutputDir,
      sourcePath: placeholderSourcePath,
      sessionId: "pi_placeholder_repair",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 3 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  await read.execute("placeholder-read", {});

  const rejected = await repair.execute("placeholder-initial", {
    entries: [
      { line: 1, translation: "第一" },
      { line: 2, translation: "第二" },
      { line: 3, translation: "第三" }
    ]
  });
  assert.deepEqual(rejected.details.requiredBatchLines, [1]);
  assert.equal(rejected.details.accepted, false);
  assert.equal(
    await readFile(path.join(placeholderOutputDir, "AI_translation", "source_translated.txt"), "utf8"),
    "\n第二\n第三\n",
    "a placeholder error must revert only the failed line while retaining every already-valid translation"
  );

  const repaired = await repair.execute("placeholder-targeted-repair", {
    fromLine: 1,
    toLine: 1,
    entries: [{ line: 1, translation: "第一 {name}" }]
  });
  assert.equal(repaired.details.accepted, true);
  assert.equal(progress.translationValidated, false);
  assert.equal(
    await readFile(path.join(placeholderOutputDir, "AI_translation", "source_translated.txt"), "utf8"),
    "第一 {name}\n第二\n第三\n"
  );
} finally {
  await rm(placeholderOutputDir, { recursive: true, force: true });
}

const blockRepairOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-block-repair-"));
const blockRepairSourcePath = path.join(blockRepairOutputDir, "source.txt");
const blockRepairSources = Array.from({ length: 300 }, (_, index) => `Source ${index + 1}`);
await writeFile(blockRepairSourcePath, blockRepairSources.join("\n"), "utf8");
try {
  const progress = {
    sourceRead: false,
    translationWritten: false,
    translationValidated: false
  };
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir: blockRepairOutputDir,
      sourcePath: blockRepairSourcePath,
      sessionId: "pi_block_repair",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { fromLine: 1, toLine: 300 },
    publishCustomMessage: async () => {}
  }, progress);
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const write = tools.find((tool) => tool.name === "writeAssignedTranslation");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  assert.ok(repair, "large repair must use the same child-owned source-read repair tool");
  assert.equal(tools.some((tool) => tool.name === "repairAssignedTranslationBlocks"), false);

  await read.execute("block-repair-read", {});
  const partial = await write.execute("block-repair-partial", {
    blocks: [{
      id: "0",
      lines: blockRepairSources.slice(0, 16).map((_, index) => index < 8
        ? `${index.toString(36)}译文 ${index + 1}`
        : index.toString(36))
    }]
  });
  assert.equal(partial.details.accepted, false);
  assert.equal(partial.details.repairMode, "entries");
  assert.equal(partial.details.requiredLineCount, 248);
  assert.equal(partial.details.requiredBatchLines.length, 248);
  assert.equal(partial.details.remainingRequiredLineCount, 0);
  assert.equal(Object.hasOwn(partial.details, "requiredLineContext"), false);
  assert.equal(Object.hasOwn(partial.details, "requiredBlocks"), false,
    "large repair results must carry only line ownership, never host-injected source blocks");
  assert.equal(
    (await readFile(path.join(blockRepairOutputDir, "AI_translation", "source_translated.txt"), "utf8"))
      .split("\n")
      .slice(0, 8)
      .join("\n"),
    Array.from({ length: 8 }, (_, index) => `译文 ${index + 1}`).join("\n"),
    "valid lines from the bulk call must be retained before large repair"
  );

  const firstRepair = await repair.execute("block-repair-first-batch", {
    entries: partial.details.requiredBatchLines.map((line) => ({ line, translation: `译文 ${line}` }))
  });
  assert.equal(firstRepair.details.accepted, false);
  assert.equal(firstRepair.details.requiredLineCount, 0);
  assert.equal(firstRepair.details.remainingRequiredLineCount, 0);
  assert.equal(firstRepair.details.requiredBatchLines.length, 0);

  const remainingSource = await read.execute("block-repair-read-page-2", {});
  assert.equal(remainingSource.details.fromLine, 257);
  assert.equal(remainingSource.details.toLine, 300);
  const repaired = await write.execute("block-repair-complete-page-2", {
    blocks: Array.from({ length: 3 }, (_, blockIndex) => {
      const firstLine = 257 + blockIndex * 16;
      const count = Math.min(16, 301 - firstLine);
      return {
        id: blockIndex.toString(36),
        lines: Array.from({ length: count }, (_, relativeIndex) => (
          `${relativeIndex.toString(36)}译文 ${firstLine + relativeIndex}`
        ))
      };
    })
  });
  assert.equal(repaired.details.accepted, true);
  assert.equal(repaired.details.requiredLineCount, 0);
  assert.equal(progress.translationValidated, false);
  assert.deepEqual(
    (await readFile(path.join(blockRepairOutputDir, "AI_translation", "source_translated.txt"), "utf8"))
      .trimEnd()
      .split("\n"),
    Array.from({ length: 300 }, (_, index) => `译文 ${index + 1}`),
    "bounded repair entries must merge only failed lines without losing accepted translations"
  );
} finally {
  await rm(blockRepairOutputDir, { recursive: true, force: true });
}

const checkpointFailureOutputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-checkpoint-cause-"));
const checkpointFailureSourcePath = path.join(checkpointFailureOutputDir, "source.txt");
const checkpointFailureCandidatePath = path.join(
  checkpointFailureOutputDir,
  ".translation-workshop",
  "agent",
  "translation-staging",
  "source.txt",
  "checkpoint.txt"
);
await writeFile(checkpointFailureSourcePath, "Complete source sentence.\n", "utf8");
try {
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir: checkpointFailureOutputDir,
      sourcePath: checkpointFailureSourcePath,
      sessionId: "pi_checkpoint_cause",
      prompt: "translate",
      providerId: "test",
      modelId: "test",
      languagePair: "en->zh-CN"
    },
    task: { documentId: "source.txt", fromLine: 1, toLine: 1 },
    workingCandidatePath: checkpointFailureCandidatePath,
    onStagingCandidateCheckpoint: async () => {
      const appendFailure = Object.assign(new Error("checkpoint append denied"), { code: "EACCES" });
      throw new Error("host-state append failed", { cause: appendFailure });
    },
    publishCustomMessage: async () => {}
  });
  const read = tools.find((tool) => tool.name === "readAssignedSource");
  const repair = tools.find((tool) => tool.name === "repairAssignedTranslation");
  await read.execute("checkpoint-cause-read", {});
  await assert.rejects(
    () => repair.execute("checkpoint-cause-write", {
      entries: [{ line: 1, translation: "这是完整的译文。" }]
    }),
    /Failed to persist.*Cause: host-state append failed; EACCES: checkpoint append denied/i,
    "a persisted child tool error must retain its bounded low-level cause chain"
  );
  assert.equal(await readFile(checkpointFailureCandidatePath, "utf8"), "这是完整的译文。\n",
    "checkpoint failure must retain the staging artifact for recovery");
} finally {
  await rm(checkpointFailureOutputDir, { recursive: true, force: true });
}

console.log("ok translation child incrementally merges ordered translations and host-preserved empty lines");
