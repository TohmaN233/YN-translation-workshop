import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from "@earendil-works/pi-ai";

import { createPiProofreadSubagentWorker } from "../../src/main/agent/piNative/subagentRunner.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function currentTurnMessages(messages) {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      userIndex = index;
      break;
    }
  }
  return messages.slice(userIndex + 1);
}

function resultPayload(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return JSON.parse(text);
}

async function fixture({ largeGlossary = false, largeStyleGuide = false } = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-proofread-reference-cache-"));
  const sourcePath = path.join(outputDir, "source.txt");
  const translationDir = path.join(outputDir, "AI_translation");
  const workspaceDir = path.join(outputDir, ".translation-workshop");
  const assetWorkspaceDir = path.join(translationDir, "_workspace");
  const styleGuidePath = path.join(workspaceDir, "style_guide.md");
  await Promise.all([
    mkdir(translationDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(assetWorkspaceDir, { recursive: true })
  ]);
  await Promise.all([
    writeFile(sourcePath, "one\ntwo\nthree\n", "utf8"),
    writeFile(path.join(translationDir, "source_translated.txt"), "一\n二\n三\n", "utf8"),
    writeFile(path.join(workspaceDir, "glossary.json"), JSON.stringify({
      entries: [{
        source: "one",
        target: "一",
        info: largeGlossary
          ? "glossary-reference-".repeat(1_000)
          : "ONLY_FIRST_REFERENCE_SENTINEL"
      }]
    }), "utf8"),
    writeFile(path.join(assetWorkspaceDir, "character_bible.md"), [
      "# Character Bible",
      "",
      "## One / 一",
      "- Gender/pronouns: unknown; unknown confidence",
      "- Terms of address: One"
    ].join("\n"), "utf8"),
    writeFile(
      styleGuidePath,
      largeStyleGuide
        ? `# Style Guide\n\n${"LARGE_STYLE_REFERENCE ".repeat(600)}\n`
        : "# Style Guide\n\nCACHE_STYLE_OLD\n",
      "utf8"
    )
  ]);

  const provider = fauxProvider({ provider: "proofread-reference-cache", tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(provider.provider);
  const contextReads = [];
  const referenceReads = [];
  const referenceToolAvailability = [];
  provider.setResponses(Array.from({ length: 24 }, () => (context) => {
    referenceToolAvailability.push(
      context.tools.some((tool) => tool.name === "readProofreadReference")
    );
    const current = currentTurnMessages(context.messages);
    const toolResults = current.filter((message) => message.role === "toolResult");
    if (toolResults.length === 0) {
      return fauxAssistantMessage(
        fauxToolCall("readAssignedProofreadContext", {}),
        { stopReason: "toolUse" }
      );
    }
    const lastResult = toolResults.at(-1);
    if (lastResult?.toolName === "readAssignedProofreadContext") {
      const payload = resultPayload(lastResult);
      contextReads.push({ payload, serializedContext: JSON.stringify(context.messages) });
      const incomplete = payload.references.find((entry) => entry.required && entry.complete === false);
      if (incomplete) {
        return fauxAssistantMessage(
          fauxToolCall("readProofreadReference", { id: incomplete.id, offset: 0, maxChars: 32_000 }),
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage(
        fauxToolCall("writeAssignedFindings", { findings: [] }),
        { stopReason: "toolUse" }
      );
    }
    if (lastResult?.toolName === "readProofreadReference") {
      const payload = resultPayload(lastResult);
      referenceReads.push(payload);
      if (!payload.complete) {
        return fauxAssistantMessage(
          fauxToolCall("readProofreadReference", {
            id: payload.id,
            offset: payload.nextOffset,
            maxChars: 32_000
          }),
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage(
        fauxToolCall("writeAssignedFindings", { findings: [] }),
        { stopReason: "toolUse" }
      );
    }
    return fauxAssistantMessage(fauxText("Proofreading assignment completed."));
  }));

  const request = {
    outputDir,
    sourcePath,
    sessionId: "pi_proofread_reference_cache",
    prompt: "Proofread the assigned ranges.",
    providerId: provider.provider.id,
    modelId: provider.getModel().id,
    languagePair: "en->zh-CN"
  };
  const common = {
    request,
    publishCustomMessage: async () => {},
    createModelSelection: async () => ({
      models,
      model: provider.getModel(),
      providerId: provider.provider.id,
      modelId: provider.getModel().id
    })
  };
  const worker = await createPiProofreadSubagentWorker({
    ...common,
    subagentId: "proofread_reference_cache_worker"
  });
  return {
    outputDir,
    styleGuidePath,
    request,
    contextReads,
    referenceReads,
    referenceToolAvailability,
    worker,
    context(task) {
      return { ...common, task };
    },
    async close() {
      await worker.dispose();
      await rm(outputDir, { recursive: true, force: true });
    }
  };
}

await test("persistent proofread worker resets assignment context and reinjects only current reference evidence", async () => {
  const fx = await fixture();
  try {
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 1, toLine: 1 }));
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 2, toLine: 2 }));

    assert.equal(fx.contextReads.length, 2);
    assert.equal(typeof fx.contextReads[0].payload.workflow, "string");
    assert.match(fx.contextReads[0].payload.referenceCache.workflow.sourcePath, /proofread-child\.md$/);
    assert.match(fx.contextReads[0].payload.referenceCache.workflow.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fx.contextReads[0].payload.projectReferences.directMatches.approvedGlossary.length, 1);
    assert.equal(
      fx.contextReads[0].payload.projectReferences.directMatches.approvedGlossary[0].info,
      "ONLY_FIRST_REFERENCE_SENTINEL"
    );
    assert.equal(fx.contextReads[1].payload.referenceCache?.status, "reused");
    assert.equal(typeof fx.contextReads[1].payload.workflow, "string");
    assert.equal(fx.contextReads[1].payload.projectReferences?.directMatches, undefined);
    assert.ok(fx.contextReads[1].payload.references.some((entry) => entry.id === "approved-style-guide"));
    assert.doesNotMatch(
      fx.contextReads[1].serializedContext,
      /ONLY_FIRST_REFERENCE_SENTINEL/,
      "the second assignment retained the first assignment's indexed glossary evidence"
    );
  } finally {
    await fx.close();
  }
});

await test("fully inlined proofreading references do not expose an unusable paged-read tool", async () => {
  const fx = await fixture();
  try {
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 1, toLine: 1 }));
    assert.ok(fx.contextReads[0].payload.references.every((entry) => entry.complete === true));
    assert.deepEqual(
      [...new Set(fx.referenceToolAvailability)],
      [false],
      "the child could call readProofreadReference even though every declared reference was already complete"
    );
  } finally {
    await fx.close();
  }
});

await test("an oversized required proofreading reference keeps the paged-read tool", async () => {
  const fx = await fixture({ largeStyleGuide: true });
  try {
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 1, toLine: 1 }));
    assert.ok(fx.contextReads[0].payload.references.some((entry) => entry.complete === false));
    assert.ok(fx.referenceToolAvailability.every(Boolean));
    assert.equal(fx.referenceReads.length, 1);
    assert.equal(fx.referenceReads[0].complete, true);
  } finally {
    await fx.close();
  }
});

await test("persistent proofread worker invalidates changed references without retaining stale content", async () => {
  const fx = await fixture();
  try {
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 1, toLine: 1 }));
    await writeFile(fx.styleGuidePath, "# Style Guide\n\nCACHE_STYLE_NEW\n", "utf8");
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 2, toLine: 2 }));

    assert.equal(fx.contextReads.length, 2);
    const refreshed = fx.contextReads[1];
    assert.equal(refreshed.payload.referenceCache?.status, "refreshed");
    assert.equal(typeof refreshed.payload.workflow, "string");
    const style = refreshed.payload.references.find((entry) => entry.id === "approved-style-guide");
    assert.ok(style, "changed style guide was not reintroduced after cache invalidation");
    assert.match(style.content, /CACHE_STYLE_NEW/);
    assert.doesNotMatch(refreshed.serializedContext, /CACHE_STYLE_OLD/,
      "the persistent Pi context retained a stale style guide after invalidation");
  } finally {
    await fx.close();
  }
});

await test("persistent proofread worker keeps oversized indexed assets out of assignment context", async () => {
  const fx = await fixture({ largeGlossary: true });
  try {
    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 1, toLine: 1 }));
    assert.equal(fx.referenceReads.length, 0);
    assert.equal(fx.contextReads[0].payload.projectReferences.directMatches.approvedGlossary.length, 0);
    assert.equal(fx.contextReads[0].payload.projectReferences.directMatches.omitted.approvedGlossary, 1);
    assert.ok(fx.contextReads[0].payload.references.every((entry) => entry.id !== "approved-glossary"));

    await fx.worker.runAssignment(fx.context({ documentId: "source.txt", fromLine: 2, toLine: 2 }));
    assert.equal(fx.referenceReads.length, 0);
    assert.equal(fx.contextReads[1].payload.referenceCache?.status, "reused");
    assert.doesNotMatch(fx.contextReads[1].serializedContext, /glossary-reference-/);
  } finally {
    await fx.close();
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
