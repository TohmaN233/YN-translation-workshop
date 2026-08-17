import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { Session } from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";
import { buildProductYnSystemPrompt, PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";
import { createYnDomainRunContract } from "../../src/main/agent/piNative/domainRunContract.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";
import {
  appendYnSessionHostState,
  createProofreadHostState,
  loadYnSessionHostState,
  proofreadDocumentHostState
} from "../../src/main/agent/piNative/proofreadSessionState.ts";
import { createTranslationAlignmentHostState } from "../../src/main/agent/piNative/translationAlignmentState.ts";
import { bindPiSourceDocument, resolvePiSourceManifest } from "../../src/main/agent/piNative/sourceManifest.ts";
import { createPiTranslationSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";
import { buildTranslatePrompt } from "../../src/shared/core/prompts.ts";

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function userMessageText(message) {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

await test("active Pi session state remains valid JSON during concurrent window access", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-ui-state-"));
  const repositoryA = new PiSessionRepository(workspaceDir);
  const repositoryB = new PiSessionRepository(workspaceDir);
  const ids = [`session-a-${"a".repeat(256_000)}`, `session-b-${"b".repeat(256_000)}`];
  try {
    await repositoryA.writeActiveSessionId(ids[0]);
    const writers = [repositoryA, repositoryB].map(async (repository, writerIndex) => {
      for (let index = 0; index < 24; index += 1) {
        await repository.writeActiveSessionId(ids[(index + writerIndex) % ids.length]);
      }
    });
    const readers = Array.from({ length: 4 }, async () => {
      for (let index = 0; index < 120; index += 1) {
        const activeSessionId = await repositoryA.readActiveSessionId();
        assert.ok(ids.includes(activeSessionId), "Reader observed a partial or unknown active-session value");
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    await Promise.all([...writers, ...readers]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("workflow prompts require typed language-pair metadata at the Pi service boundary", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-workflow-metadata-"));
  let providerSelectionCalls = 0;
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      providerSelectionCalls += 1;
      throw new Error("provider selection must not run for an invalid workflow request");
    }
  });
  try {
    const session = await service.createSession(workspaceDir);
    await assert.rejects(
      service.prompt({
        outputDir: workspaceDir,
        sessionId: session.id,
        prompt: "Workflow: yn-translation-v1.\nLanguage pair is intentionally absent.",
        workflowIntent: "translation",
        providerId: "unused",
        modelId: "unused"
      }),
      /languagePair is required for translation and proofreading workflows/
    );
    assert.equal(providerSelectionCalls, 0);
    assert.deepEqual(await service.loadMessages(workspaceDir, session.id), []);
  } finally {
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("exact generated workflow markers restore typed intent and filter omitted folder documents", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-marker-folder-order-"));
  const sourceDir = path.join(workspaceDir, "txt");
  await mkdir(path.join(workspaceDir, ".translation-workshop"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "old.txt"), "old source\n", "utf8");
  await writeFile(path.join(sourceDir, "new.txt"), "new source\n", "utf8");
  await writeFile(path.join(workspaceDir, ".translation-workshop", "project.json"), JSON.stringify({
    sourcePath: sourceDir,
    sourceKind: "folder",
    languagePair: "en->zh-CN",
    folderTranslationOrder: '{\n"new.txt"\n}',
    reuseExistingTranslation: true,
    subagentEnabled: true,
    subagentCount: 2,
    splitSize: 100
  }), "utf8");

  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "inspect_marker_manifest" }), { stopReason: "toolUse" }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "intentional marker inspection boundary" })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: (context) => createYnDomainTools(context),
    buildSystemPrompt: () => "Inspect the exact generated workflow contract.",
    enforceDomainCompletion: true
  });
  const settled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") settled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    const previousDomainRun = createYnDomainRunContract({
      workflowIntent: "translation",
      fullWorkflow: true,
      folderSource: true,
      subagentEnabled: true,
      subagentCount: 2
    });
    previousDomainRun.registerSourceManifest([
      { id: "old.txt", sourceLineCount: 1, scheduleStage: 0 },
      { id: "new.txt", sourceLineCount: 1, scheduleStage: 0 }
    ]);
    previousDomainRun.recordInspection({
      sourceLineCount: 2,
      documents: [
        { id: "old.txt", sourceLineCount: 1, scheduleStage: 0 },
        { id: "new.txt", sourceLineCount: 1, scheduleStage: 0 }
      ],
      glossaryCandidateExists: true,
      characterBibleExists: true
    });
    previousDomainRun.recordTranslationReuseAuditReady(["old-removed-audit"]);
    await appendYnSessionHostState(
      await new PiSessionRepository(workspaceDir).open(session.id),
      {
        schemaVersion: 1,
        ownerSessionId: session.id,
        domainRun: previousDomainRun.snapshot(),
        proofread: createProofreadHostState(),
        translationAlignment: createTranslationAlignmentHostState()
      }
    );
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.\nTranslate only the retained file.",
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
      sourcePath: sourceDir,
      sourceSelection: { kind: "folder", path: sourceDir }
    });
    await Promise.race([
      settled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out inspecting marker workflow")), 3_000))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    const inspected = messages.find((message) => (
      message.role === "toolResult" && message.toolName === "inspectTranslationContext"
    ));
    assert.ok(inspected, "the marker workflow did not inspect its source manifest");
    assert.equal(inspected.details.sourceSelection.documentCount, 1);
    assert.equal(inspected.details.sourceSelection.documents[0].id, "new.txt");
    const persisted = await loadYnSessionHostState(
      await new PiSessionRepository(workspaceDir).open(session.id),
      session.id
    );
    assert.equal(persisted.domainRun.fullWorkflowActive, true);
    assert.equal(persisted.domainRun.activeKind, "translation");
    assert.deepEqual(persisted.domainRun.documents.map((document) => document.id), ["new.txt"]);
    assert.deepEqual(persisted.domainRun.pendingTranslationReuseAuditIds, []);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("workflow directory scaffold exists before provider selection without materializing assets", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-workflow-scaffold-order-"));
  const sourcePath = path.join(workspaceDir, "source.txt");
  await writeFile(sourcePath, "one\n", "utf8");
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([fauxAssistantMessage(fauxText("ready"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let observed = false;
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      for (const directory of [
        path.join(workspaceDir, ".translation-workshop"),
        path.join(workspaceDir, "AI_translation"),
        path.join(workspaceDir, "AI_translation", "_workspace"),
        path.join(workspaceDir, "report")
      ]) {
        assert.equal((await stat(directory)).isDirectory(), true);
      }
      await assert.rejects(
        readFile(path.join(workspaceDir, "AI_translation", "_workspace", "glossary_candidates.json")),
        (error) => error?.code === "ENOENT"
      );
      observed = true;
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    },
    createTools: () => [],
    buildSystemPrompt: () => "Use the typed workflow."
  });
  const settled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") settled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sourcePath,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "en->zh-CN",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await settled.promise;
    assert.equal(observed, true);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("EPUB review sessions keep the renderer-bound extracted text as the Pi source", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-epub-source-binding-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("extracted EPUB text received"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let toolRequest;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: ({ request }) => {
      toolRequest = request;
      return [];
    },
    buildSystemPrompt: () => "Use the extracted UTF-8 review source."
  });
  const settled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") settled.resolve();
  });
  try {
    const extractedSourcePath = path.join(
      workspaceDir,
      ".translation-workshop",
      "extracted-text",
      "247a523589",
      "source",
      "_.txt"
    );
    const originalEpubPath = path.join(workspaceDir, "original.epub");
    await mkdir(path.dirname(extractedSourcePath), { recursive: true });
    await writeFile(extractedSourcePath, "Extracted EPUB source line\n", "utf8");
    await writeFile(originalEpubPath, "EPUB binary placeholder", "utf8");
    await writeFile(path.join(workspaceDir, ".translation-workshop", "project.json"), JSON.stringify({
      sourceKind: "file",
      sourcePath: originalEpubPath,
      languagePair: "ja->zh-CN"
    }), "utf8");

    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Inspect the extracted EPUB source.",
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
      sourcePath: extractedSourcePath,
      sourceSelection: { kind: "file", path: extractedSourcePath },
      languagePair: "ja->zh-CN"
    });
    await Promise.race([
      settled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for EPUB source binding test")), 5000))
    ]);

    assert.equal(toolRequest.sourcePath, extractedSourcePath);
    assert.deepEqual(toolRequest.sourceSelection, { kind: "file", path: extractedSourcePath });
    const manifest = await resolvePiSourceManifest(toolRequest);
    assert.equal(manifest.kind, "file");
    assert.equal(manifest.documents[0].path, extractedSourcePath);
    assert.equal(manifest.documents[0].lineCount, 1);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Pi prompts without a page source fall back to the current project source", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-project-source-fallback-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("project source fallback received"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let toolRequest;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: ({ request }) => {
      toolRequest = request;
      return [];
    },
    buildSystemPrompt: () => "Use the project source fallback."
  });
  const settled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") settled.resolve();
  });
  try {
    const projectSourcePath = path.join(workspaceDir, "project-source.txt");
    await mkdir(path.join(workspaceDir, ".translation-workshop"), { recursive: true });
    await writeFile(projectSourcePath, "Project source line\n", "utf8");
    await writeFile(path.join(workspaceDir, ".translation-workshop", "project.json"), JSON.stringify({
      sourceKind: "file",
      sourcePath: projectSourcePath
    }), "utf8");

    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Inspect the project source.",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      settled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for project source fallback test")), 5000))
    ]);

    assert.equal(toolRequest.sourcePath, projectSourcePath);
    assert.deepEqual(toolRequest.sourceSelection, { kind: "file", path: projectSourcePath });
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("current project settings override stale HTML parameters without replacing the page-bound source", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-live-project-context-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("current project context received"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let toolRequest;
  let promptRequest;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: ({ request }) => {
      toolRequest = request;
      return [];
    },
    buildSystemPrompt: (request) => {
      promptRequest = request;
      return "Use the current project settings.";
    }
  });
  const settled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") settled.resolve();
  });
  try {
    await mkdir(path.join(workspaceDir, ".translation-workshop"), { recursive: true });
    const currentSourceRoot = path.join(workspaceDir, "current-source");
    await mkdir(currentSourceRoot, { recursive: true });
    await writeFile(path.join(currentSourceRoot, "tips.txt"), "Current folder source\n", "utf8");
    await writeFile(path.join(workspaceDir, ".translation-workshop", "project.json"), JSON.stringify({
      sourceKind: "folder",
      sourcePath: currentSourceRoot,
      languagePair: "Eng->zh-CN",
      style: "science-fiction mystery",
      workDescription: "Preserve technical terminology and restrained narration.",
      glossaryPath: path.join(workspaceDir, ".translation-workshop", "glossary.json"),
      glossaryCandidates: false,
      characterBible: true,
      reuseExistingTranslation: true,
      splitSize: 750,
      reviewMode: "split 1000",
      subagentEnabled: true,
      subagentCount: 4,
      reviewSubagentCount: 3,
      subagentProviderId: "configured-provider",
      subagentModelId: "configured-child-model",
      proofreadMode: "montecarlo",
      customPreserveRules: [{ label: "speaker marker", pattern: "^@[A-Z_]+", flags: "u" }]
    }), "utf8");
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Inspect the current project.",
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
      sourcePath: currentSourceRoot,
      sourceSelection: { kind: "folder", path: currentSourceRoot },
      languagePair: "ja->zh-CN",
      style: "stale-html-style",
      workDescription: "stale HTML description",
      glossaryPath: "stale-glossary.json",
      glossaryCandidates: true,
      characterBible: false,
      reuseExistingTranslation: false,
      subagentEnabled: false,
      subagentCount: 2,
      reviewSubagentCount: 1,
      subagentProviderId: "stale-provider",
      subagentModelId: "stale-model",
      proofreadMode: "split",
      folderSourceDocuments: [{ id: "tips.txt", path: path.join(currentSourceRoot, "tips.txt") }]
    });
    await Promise.race([
      settled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for current project context test")), 5000))
    ]);
    for (const request of [toolRequest, promptRequest]) {
      assert.equal(request.languagePair, "Eng->zh-CN");
      assert.equal(request.sourcePath, currentSourceRoot);
      assert.deepEqual(request.sourceSelection, { kind: "folder", path: currentSourceRoot });
      assert.equal(request.translationSplitSize, 750);
      assert.equal(request.proofreadSplitSize, 750);
      assert.equal(request.style, "science-fiction mystery");
      assert.equal(request.workDescription, "Preserve technical terminology and restrained narration.");
      assert.equal(request.glossaryPath, path.join(workspaceDir, ".translation-workshop", "glossary.json"));
      assert.equal(request.glossaryCandidates, false);
      assert.equal(request.characterBible, true);
      assert.equal(request.reuseExistingTranslation, true);
      assert.equal(request.subagentEnabled, true);
      assert.equal(request.subagentCount, 4);
      assert.equal(request.reviewSubagentCount, 3);
      assert.equal(request.subagentProviderId, "configured-provider");
      assert.equal(request.subagentModelId, "configured-child-model");
      assert.equal(request.proofreadMode, "montecarlo");
      assert.deepEqual(request.customPreserveRules, [{
        label: "speaker marker",
        pattern: "^@[A-Z_]+",
        flags: "u"
      }]);
      assert.deepEqual(request.folderSourceDocuments, [{
        id: "tips.txt",
        path: path.join(currentSourceRoot, "tips.txt")
      }]);
    }
    const manifest = await resolvePiSourceManifest(toolRequest);
    assert.deepEqual(manifest.documents.map((document) => document.id), ["tips.txt"]);
    const bound = bindPiSourceDocument(toolRequest, manifest.documents[0]);
    const childTools = createPiTranslationSubagentTools({
      request: bound,
      task: { documentId: "tips.txt", fromLine: 1, toLine: 1 },
      publishCustomMessage: async () => {}
    });
    await childTools.find((tool) => tool.name === "readAssignedSource").execute("read-tips", {});
    const childWrite = await childTools.find((tool) => tool.name === "repairAssignedTranslation").execute(
      "write-tips",
      { entries: [{ line: 1, translation: "当前文件夹译文" }] }
    );
    assert.equal(childWrite.details.accepted, true);
    assert.equal(
      await readFile(path.join(workspaceDir, "AI_translation", "tips_translated.txt"), "utf8"),
      "当前文件夹译文\n"
    );
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("product Pi system-prompt composition reads the approved project style guide", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-product-style-guide-"));
  try {
    const stateDir = path.join(workspaceDir, ".translation-workshop");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "style_guide.md"), "# Approved voice\nUse restrained first-person narration.", "utf8");
    const prompt = await buildProductYnSystemPrompt({
      outputDir: workspaceDir,
      sessionId: "style-product-path",
      prompt: "Inspect the current project.",
      providerId: "unused",
      modelId: "unused"
    });
    assert.match(prompt, /APPROVED PROJECT STYLE GUIDE/);
    assert.match(prompt, /Use restrained first-person narration/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("native Pi service acknowledges immediately, streams native events, and persists JSONL", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-native-"));
  const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 2 } });
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("先确认用户语言。"),
      fauxText("你好，我在。")
    ])
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  const terminal = deferred();
  const eventTypes = [];
  const updateSizes = [];
  const sequences = [];
  const unsubscribe = service.subscribeEvents((entry) => {
    eventTypes.push(entry.event.type);
    sequences.push(entry.sequence);
    if (entry.event.type === "message_update") {
      updateSizes.push(JSON.stringify(entry.event.message.content).length);
    }
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    assert.match(session.path, /\.jsonl$/i);
    const startedAt = Date.now();
    const accepted = await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "你好",
      providerId: "faux",
      modelId: faux.getModel().id,
      thinkingLevel: "medium"
    });
    assert.equal(accepted.accepted, true);
    assert.ok(Date.now() - startedAt < 250, "prompt acknowledgement should not wait for model completion");
    assert.equal((await service.getRunState(workspaceDir, session.id)).running, true);
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for native Pi agent_end")), 5000))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.ok(messages[1].content.some((block) => block.type === "thinking"));
    assert.ok(messages[1].content.some((block) => block.type === "text" && block.text.includes("你好")));
    for (const type of ["agent_start", "message_start", "message_update", "message_end", "agent_end"]) {
      assert.ok(eventTypes.includes(type), `missing native Pi event ${type}`);
    }
    assert.ok(updateSizes.length >= 2, "native Pi deltas should arrive before the final transcript reload");
    assert.ok(updateSizes.some((size, index) => index > 0 && size > updateSizes[index - 1]), "streamed Pi content should grow incrementally");
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal((await service.getRunState(workspaceDir, session.id)).running, false);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("native Pi service persists image input and rejects it for text-only models", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-native-image-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("我看到了图片。"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const multimodalModel = { ...faux.getModel(), input: ["text", "image"] };
  const textOnlyModel = { ...faux.getModel(), input: ["text"] };
  const image = {
    type: "image",
    mimeType: "image/png",
    data: Buffer.from("image-fixture").toString("base64")
  };
  const service = new PiNativeSessionService({
    createModelSelection: async ({ modelId }) => ({
      models,
      model: modelId === "text-only" ? textOnlyModel : multimodalModel,
      providerId: faux.provider.id,
      modelId: modelId === "text-only" ? "text-only" : multimodalModel.id
    })
  });
  const firstTerminal = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") firstTerminal.resolve();
  });
  try {
    const imageSession = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: imageSession.id,
      prompt: "看看这张图",
      images: [image],
      providerId: faux.provider.id,
      modelId: multimodalModel.id
    });
    await Promise.race([
      firstTerminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for image prompt")), 3000))
    ]);
    const messages = await service.loadMessages(workspaceDir, imageSession.id);
    assert.ok(messages[0].content.some((block) => block.type === "image" && block.data === image.data));

    const textSession = await service.createSession(workspaceDir);
    await assert.rejects(service.prompt({
      outputDir: workspaceDir,
      sessionId: textSession.id,
      prompt: "看看这张图",
      images: [image],
      providerId: faux.provider.id,
      modelId: "text-only"
    }), /does not accept image input/i);
    assert.deepEqual(await service.loadMessages(workspaceDir, textSession.id), []);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("page workflow metadata does not turn an ordinary local correction into a full workflow", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-local-correction-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("\u5df2\u68c0\u67e5\u5e76\u4fee\u6b63\u8fd9\u4e00\u884c\u3002"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let captured;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured = context;
      return [];
    }
  });
  const terminal = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "\u53ea\u4fee\u6b63\u5f53\u524d\u8bd1\u6587\u7b2c 3 \u884c\uff0c\u4e0d\u8981\u91cd\u65b0\u7ffb\u8bd1\u6574\u4e2a\u6587\u4ef6\u3002",
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for local correction")), 3000))
    ]);
    const state = await service.getRunState(workspaceDir, session.id);
    assert.equal(state.error, undefined);
    assert.equal(captured.domainRun.fullWorkflow, false);
    assert.equal(captured.domainRun.kind, undefined);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.ok(messages.some((message) => message.role === "assistant"
      && message.content.some((block) => block.type === "text" && block.text.includes("\u5df2\u68c0\u67e5\u5e76\u4fee\u6b63"))));
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("prompt wording never becomes child authorization or a generated workflow", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-explicit-child-request-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("已按用户要求安排子 Agent。"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let captured;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured = context;
      return [];
    },
    buildSystemPrompt: () => "Use native Pi tools and follow explicit user delegation."
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "我修改了源代码，现在子agent应该可以修复全部问题了。还是叫两个来修复。",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    assert.equal(captured.request.subagentCount, 5);
    assert.equal(captured.domainRun.configuredSubagents, 5);
    assert.equal(captured.domainRun.kind, undefined, "delegation must not activate a full workflow by itself");
    assert.doesNotThrow(() => captured.domainRun.assertCanStartGeneralSubagentBatch());
  } finally {
    await service.abort(workspaceDir, (await service.bootstrap(workspaceDir)).activeSessionId);
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a generated workflow ignores prompt-stated counts and uses typed project metadata", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-full-workflow-exact-children-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("已按当前要求启动工作流。"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let captured;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured = context;
      return [];
    },
    buildSystemPrompt: () => "Use the native Pi workflow tools."
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: buildTranslatePrompt({
        sourcePath: workspaceDir,
        sourceKind: "folder",
        outputDir: workspaceDir,
        advanced: {
          subagentEnabled: true,
          subagentCount: 5,
          workDescription: "这次明确叫两个 subagents 处理。"
        }
      }),
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    assert.equal(captured.request.subagentCount, 5);
    assert.equal(captured.domainRun.fullWorkflow, true);
    assert.equal(captured.domainRun.configuredSubagents, 5);
  } finally {
    await service.abort(workspaceDir, (await service.bootstrap(workspaceDir)).activeSessionId);
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("workflow worker ceilings stay typed across continuation turns", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-workflow-exact-turn-scope-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pauseForReuseDecision", {}, { id: "pause-reuse" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("等待用户决定。")),
    fauxAssistantMessage(fauxText("已按项目并发上限继续。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const captured = [];
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured.push(context);
      return [{
        name: "pauseForReuseDecision",
        label: "pause for reuse decision",
        description: "Create a typed user-decision boundary while retaining the workflow.",
        parameters: Type.Object({}),
        async execute() {
          context.domainRun.recordTranslationReuseAuditReady(["turn-scoped-exact-audit"]);
          return { content: [{ type: "text", text: "decision required" }], details: {} };
        }
      }];
    },
    buildSystemPrompt: () => "Keep workflow worker constraints scoped to the current user turn."
  });
  let settledCount = 0;
  const firstSettled = deferred();
  const secondSettled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    if (settledCount === 1) firstSettled.resolve();
    if (settledCount === 2) secondSettled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    };
    await service.prompt({
      ...common,
      prompt: buildTranslatePrompt({
        sourcePath: workspaceDir,
        sourceKind: "folder",
        outputDir: workspaceDir,
        advanced: {
          subagentEnabled: true,
          subagentCount: 5,
          workDescription: "这次明确叫两个 subagents 处理。"
        }
      })
    });
    await firstSettled.promise;
    assert.equal(captured[0].domainRun.configuredSubagents, 5);

    await service.prompt({ ...common, prompt: "继续处理已经确认的内容。" });
    await secondSettled.promise;
    assert.equal(captured[1].domainRun, captured[0].domainRun, "the incomplete workflow should retain its Host progress");
    assert.equal(captured[1].domainRun.configuredSubagents, 5, "the later turn must restore the project 1..N ceiling");
    assert.equal(captured[1].request.subagentCount, 5);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("an ordinary parent turn keeps a running background workflow and its children alive", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-background-parent-turn-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxText("background workflow started")),
    fauxAssistantMessage(fauxText("parent answered while children stayed active"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const captured = [];
  const promptContexts = [];
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured.push(context);
      if (captured.length === 1) context.subagents.hasRunning = () => true;
      return [];
    },
    buildSystemPrompt: (request, context) => {
      promptContexts.push({ workflowIntent: request.workflowIntent, fullWorkflow: context.fullWorkflow });
      return "Keep the active Host workflow available while background children run.";
    }
  });
  let settledCount = 0;
  const firstSettled = deferred();
  const secondSettled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    if (settledCount === 1) firstSettled.resolve();
    if (settledCount === 2) secondSettled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    };
    await service.prompt({
      ...common,
      prompt: "Workflow: yn-translation-v1.\nStart full translation.",
      workflowIntent: "translation",
      subagentCount: 2
    });
    await firstSettled.promise;

    await service.prompt({
      ...common,
      prompt: "answer this parent-side question while children continue",
      subagentCount: 5
    });
    await secondSettled.promise;

    assert.equal(captured.length, 2);
    assert.equal(captured[1].subagents, captured[0].subagents, "an idle parent turn must not retire live child runtimes");
    assert.equal(captured[1].domainRun, captured[0].domainRun, "the background workflow contract must remain the active typed scope");
    assert.equal(captured[1].domainRun.configuredSubagents, 2, "an untyped chat turn must not rewrite the active workflow ceiling");
    assert.deepEqual(promptContexts[1], { workflowIntent: "translation", fullWorkflow: true });
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a later ordinary local turn receives a fresh bounded operation contract", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-local-exact-turn-scope-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pauseLocalDecision", {}, { id: "pause-local" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("等待用户继续。")),
    fauxAssistantMessage(fauxText("已按项目并发上限继续。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const captured = [];
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured.push(context);
      return [{
        name: "pauseLocalDecision",
        label: "pause local decision",
        description: "Retain a bounded local Host contract across one user turn.",
        parameters: Type.Object({}),
        async execute() {
          context.domainRun.recordTranslationReuseAuditReady(["local-turn-scope-audit"]);
          return { content: [{ type: "text", text: "decision required" }], details: {} };
        }
      }];
    },
    buildSystemPrompt: () => "Keep explicit child counts scoped to the current user turn."
  });
  let settledCount = 0;
  const firstSettled = deferred();
  const secondSettled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    if (settledCount === 1) firstSettled.resolve();
    if (settledCount === 2) secondSettled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    };
    await service.prompt({ ...common, prompt: "请叫 2 个 subagents 处理已经定位的局部问题。" });
    await firstSettled.promise;
    assert.equal(captured[0].domainRun.fullWorkflow, false);
    assert.equal(captured[0].domainRun.configuredSubagents, 5);

    await service.prompt({ ...common, prompt: "继续处理这个局部问题。" });
    await secondSettled.promise;
    assert.notEqual(captured[1].domainRun, captured[0].domainRun);
    assert.equal(captured[1].domainRun.configuredSubagents, 5);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a generated workflow ceiling remains ordinary up-to project metadata", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-full-workflow-up-to-children-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("已读取工作流。"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let captured;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured = context;
      return [];
    },
    buildSystemPrompt: () => "Use the native Pi workflow tools."
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: buildTranslatePrompt({
        sourcePath: workspaceDir,
        sourceKind: "folder",
        outputDir: workspaceDir,
        advanced: { subagentEnabled: true, subagentCount: 5 }
      }),
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    assert.equal(captured.domainRun.configuredSubagents, 5);
  } finally {
    await service.abort(workspaceDir, (await service.bootstrap(workspaceDir)).activeSessionId);
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Stop preserves an incomplete generated workflow and its system-prompt contract for same-session continuation", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-stopped-workflow-resume-"));
  const firstFaux = fauxProvider({ tokensPerSecond: 1 });
  firstFaux.setResponses([
    fauxAssistantMessage(fauxText("正在处理尚未完成的翻译工作流。"))
  ]);
  const secondFaux = fauxProvider({ tokensPerSecond: 1000 });
  secondFaux.setResponses([
    fauxAssistantMessage(fauxToolCall("finishResumedWorkflow", {}, { id: "finish_resumed_workflow" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("剩余任务已经完成并通过校验。"))
  ]);
  const firstModels = createModels();
  firstModels.setProvider(firstFaux.provider);
  const secondModels = createModels();
  secondModels.setProvider(secondFaux.provider);
  let selectionCount = 0;
  let failNextResumePersistence = false;
  let resumePersistenceFailures = 0;
  const promptContexts = [];
  const resumeToolCalled = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      selectionCount += 1;
      return selectionCount === 1 ? {
        models: firstModels,
        model: firstFaux.getModel(),
        providerId: firstFaux.provider.id,
        modelId: firstFaux.getModel().id
      } : {
        models: secondModels,
        model: secondFaux.getModel(),
        providerId: secondFaux.provider.id,
        modelId: secondFaux.getModel().id
      };
    },
    appendHostState: async (session, state, options) => {
      if (failNextResumePersistence && state.workflowSuspended !== true) {
        failNextResumePersistence = false;
        resumePersistenceFailures += 1;
        throw new Error("transient Host-state append failure");
      }
      await appendYnSessionHostState(session, state, options);
    },
    enforceDomainCompletion: true,
    createTools: (toolContext) => [
      {
        name: "finishResumedWorkflow",
        label: "finish resumed workflow",
        description: "Complete the restored Host-owned workflow debt.",
        parameters: Type.Object({}),
        async execute() {
          toolContext.domainRun?.recordInspection({ sourceLineCount: 2, glossaryCandidateExists: true, characterBibleExists: true });
          toolContext.domainRun?.recordSubagentBatchStarted("translation", "resumed-batch", { taskCount: 2, workerCount: 2 });
          toolContext.domainRun?.recordTranslationArtifactMutation();
          toolContext.domainRun?.recordSubagentBatch("translation", "resumed-batch", 2);
          toolContext.domainRun?.recordFinalValidation("translation");
          resumeToolCalled.resolve();
          return { content: [{ type: "text", text: "validated" }], details: { validated: true } };
        }
      }
    ],
    buildSystemPrompt: (_request, context) => {
      promptContexts.push({
        fullWorkflow: context.fullWorkflow,
        workflowSuspended: context.workflowSuspended,
        configuredSubagents: context.domainRun?.configuredSubagents
      });
      return "Continue the active native Pi workflow contract.";
    }
  });
  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 3,
      providerId: firstFaux.provider.id,
      modelId: firstFaux.getModel().id
    };
    await service.prompt({
      ...common,
      prompt: buildTranslatePrompt({
        sourcePath: workspaceDir,
        sourceKind: "folder",
        outputDir: workspaceDir,
        advanced: {
          subagentEnabled: true,
          subagentCount: 3,
          workDescription: "本次明确使用 2 个 subagents。"
        }
      })
    });
    await service.abort(workspaceDir, session.id);
    const stopped = [...service.active.values()][0];
    assert.equal(stopped.domainRun, undefined, "Stop must detach the live workflow from the stopped Pi runtime");
    assert.equal(stopped.hostState.domainRun?.fullWorkflow, true, "same-session workflow debt must remain persisted");
    assert.equal(stopped.hostState.domainRun?.configuredSubagents, 3, "the stopped snapshot must retain the typed project worker ceiling");
    assert.equal(stopped.hostState.workflowSuspended, true);
    await service.disposeWorkspace(workspaceDir);
    const coldSession = await new PiSessionRepository(workspaceDir).open(session.id);
    const coldHostState = await loadYnSessionHostState(coldSession, session.id);
    assert.equal(coldHostState?.workflowSuspended, true, `cold JSONL lost the suspended workflow state: ${JSON.stringify(coldHostState)}`);

    failNextResumePersistence = true;
    await assert.rejects(() => service.prompt({
      ...common,
      subagentCount: 5,
      prompt: "Workflow: yn-translation-v1.\n继续完成剩余任务。"
    }), /transient Host-state append failure/);
    const persistedAfterFailure = await loadYnSessionHostState(
      await new PiSessionRepository(workspaceDir).open(session.id),
      session.id
    );
    assert.equal(persistedAfterFailure?.workflowSuspended, true, "failed automatic resume must leave the stopped Host contract durable");

    await service.prompt({
      ...common,
      subagentCount: 5,
      prompt: "Workflow: yn-translation-v1.\n继续完成剩余任务。"
    });
    assert.equal(promptContexts.at(-1)?.fullWorkflow, true, "continuation prompt must receive the persisted full-workflow contract");
    assert.equal(
      promptContexts.at(-1)?.workflowSuspended,
      false,
      `a fresh typed continuation must resume the stopped Host workflow before the model runs: ${JSON.stringify(promptContexts)}`
    );
    assert.equal(promptContexts.at(-1)?.configuredSubagents, 5, "automatic resume must atomically apply the current project 1..N ceiling");
    const resumedInTime = await Promise.race([
      resumeToolCalled.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000))
    ]);
    if (!resumedInTime) {
      const state = await service.getRunState(workspaceDir, session.id);
      const messages = await service.loadMessages(workspaceDir, session.id);
      throw new Error(`Timed out waiting for resumed Host workflow: ${JSON.stringify({ selectionCount, state, messages })}`);
    }
    const resumed = [...service.active.values()][0];
    assert.equal(resumed.domainRun?.fullWorkflow, true);
    assert.equal(resumed.domainRun?.configuredSubagents, 5, "successful resume must atomically apply the current project worker ceiling");
    assert.equal(resumed.hostState.workflowSuspended, false, "typed continuation must reactivate completion gating before Host progress");
    assert.equal(resumePersistenceFailures, 1, "the verifier must exercise one transient resume persistence failure");
    const persistedAfterRetry = await loadYnSessionHostState(
      await new PiSessionRepository(workspaceDir).open(session.id),
      session.id
    );
    assert.notEqual(persistedAfterRetry?.workflowSuspended, true, "a retry after transient persistence failure must commit the resumed Host state");
  } finally {
    await service.abort(workspaceDir, (await service.bootstrap(workspaceDir)).activeSessionId);
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Stop never lets an old Session writer overwrite a continuation accepted while child shutdown is pending", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-stop-session-owner-race-"));
  const slowFaux = fauxProvider({ tokensPerSecond: 1 });
  slowFaux.setResponses([fauxAssistantMessage(fauxText("slow interrupted workflow turn ".repeat(200)))]);
  const fastFaux = fauxProvider({ tokensPerSecond: 1000 });
  fastFaux.setResponses([fauxAssistantMessage(fauxText("continuation committed by the new Session owner"))]);
  const slowModels = createModels();
  slowModels.setProvider(slowFaux.provider);
  const fastModels = createModels();
  fastModels.setProvider(fastFaux.provider);
  let selectionCount = 0;
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      selectionCount += 1;
      const faux = selectionCount === 1 ? slowFaux : fastFaux;
      return {
        models: selectionCount === 1 ? slowModels : fastModels,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    },
    enforceDomainCompletion: true
  });
  const childShutdownEntered = deferred();
  const releaseChildShutdown = deferred();
  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      providerId: slowFaux.provider.id,
      modelId: slowFaux.getModel().id
    };
    await service.prompt({ ...common, prompt: "Workflow: yn-translation-v1." });
    const firstOwner = [...service.active.values()][0];
    const originalWaitForAll = firstOwner.subagents.waitForAll.bind(firstOwner.subagents);
    firstOwner.subagents.waitForAll = async () => {
      childShutdownEntered.resolve();
      await releaseChildShutdown.promise;
      await originalWaitForAll();
    };

    const aborting = service.abort(workspaceDir, session.id);
    await childShutdownEntered.promise;
    await service.prompt({ ...common, prompt: "普通继续消息，不自动恢复工作流。" });
    const continuationVisible = await Promise.race([
      (async () => {
        for (;;) {
          const messages = await service.loadMessages(workspaceDir, session.id);
          if (JSON.stringify(messages).includes("continuation committed by the new Session owner")) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000))
    ]);
    assert.equal(continuationVisible, true, "the continuation did not settle while old child shutdown was pending");

    releaseChildShutdown.resolve();
    await aborting;
    const reopened = await new PiSessionRepository(workspaceDir).open(session.id);
    const coldContext = await reopened.buildContext();
    assert.match(
      JSON.stringify(coldContext.messages),
      /continuation committed by the new Session owner/,
      "the stopped Session owner wrote after unlock and moved the cold branch behind the accepted continuation"
    );
  } finally {
    releaseChildShutdown.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("count wording never rewrites the typed project child ceiling", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-explicit-child-count-followup-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxText("已完成第一轮委派。")),
    fauxAssistantMessage(fauxText("已按五个并行任务继续。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const captured = [];
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      captured.push(context);
      return [];
    },
    buildSystemPrompt: () => "Use typed native Pi delegation metadata."
  });
  let settledCount = 0;
  const firstSettled = deferred();
  const secondSettled = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    if (settledCount === 1) firstSettled.resolve();
    if (settledCount === 2) secondSettled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    const common = {
      outputDir: workspaceDir,
      sessionId: session.id,
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    };
    await service.prompt({ ...common, prompt: "Workflow: yn-translation-v1.\n请叫 2 个 subagents 定位问题。" });
    await firstSettled.promise;
    await service.prompt({ ...common, prompt: "叫五个并行" });
    await secondSettled.promise;
    assert.equal(captured[0].domainRun.configuredSubagents, 5);
    assert.equal(captured[1].domainRun.configuredSubagents, 5);
    assert.equal(captured[1].domainRun, captured[0].domainRun, "the typed full workflow retains its Host progress");
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Steer changes native Pi input only and never mutates Host authorization", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-steer-child-request-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("holdTurn", {}, { id: "hold_turn" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("已收到委派要求。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  let domainRun;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => {
      domainRun = context.domainRun;
      return [{
        name: "holdTurn",
        label: "holdTurn",
        description: "Keep the native Pi turn active for Steer authorization.",
        parameters: Type.Object({}),
        async execute() {
          toolStarted.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        }
      }];
    },
    buildSystemPrompt: () => "Follow explicit user delegation."
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "检查当前译文。",
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: 5,
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    assert.equal(domainRun.configuredSubagents, 5);
    const activeRuntime = [...service.active.values()][0].runtime;
    const originalSteer = activeRuntime.steer.bind(activeRuntime);
    activeRuntime.steer = async () => {
      throw new Error("native Pi rejected this Steer");
    };
    await assert.rejects(
      service.sendInput(workspaceDir, session.id, "steer", "请叫 3 个 subagents 一起处理"),
      /native Pi rejected/i
    );
    assert.equal(domainRun.configuredSubagents, 5, "a rejected native Pi input must not mutate the typed ceiling");
    activeRuntime.steer = originalSteer;
    await service.sendInput(workspaceDir, session.id, "steer", "请叫 subagents 一起处理");
    assert.equal(domainRun.configuredSubagents, 5, "Steer without a count keeps the configured child ceiling");
    await service.sendInput(workspaceDir, session.id, "steer", "叫三个并行");
    assert.equal(domainRun.configuredSubagents, 5, "count-only wording cannot rewrite Host metadata");
    releaseTool.resolve();
    await service.abort(workspaceDir, session.id);
  } finally {
    releaseTool.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("native Pi provider errors remain observable in terminal run state", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-provider-error-"));
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectBeforeFailure", {}, { id: "inspect_before_failure" }), { stopReason: "toolUse" }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed visibly" })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: ({ domainRun }) => [{
      name: "inspectBeforeFailure",
      label: "inspect before provider failure",
      description: "Activate an incomplete translation contract before the provider fails.",
      parameters: Type.Object({}),
      async execute() {
        domainRun?.recordInspection({
          sourceLineCount: 3,
          glossaryCandidateExists: false,
          characterBibleExists: false
        });
        return { content: [{ type: "text", text: "inspected" }], details: { inspected: true } };
      }
    }]
  });
  const terminal = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "en->zh-CN",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for provider error")), 3000))
    ]);
    const terminalError = (await service.getRunState(workspaceDir, session.id)).error || "";
    assert.match(terminalError, /provider failed visibly/);
    assert.doesNotMatch(terminalError, /YN workflow completion contract failed/);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("proofreading Host state resumes from native Pi JSONL after a cold service restart", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-proofread-state-restart-"));
  const firstFaux = fauxProvider({ tokensPerSecond: 1000 });
  firstFaux.setResponses([
    fauxAssistantMessage(fauxToolCall("primeProofreadState", {}, { id: "prime_proofread_state" }), { stopReason: "toolUse" }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "intentional restart boundary" })
  ]);
  const firstModels = createModels();
  firstModels.setProvider(firstFaux.provider);
  const firstService = new PiNativeSessionService({
    createModelSelection: async () => ({
      models: firstModels,
      model: firstFaux.getModel(),
      providerId: firstFaux.provider.id,
      modelId: firstFaux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: ({ domainRun, proofreadState }) => [{
      name: "primeProofreadState",
      label: "prime proofreading state",
      description: "Record deterministic proofreading progress before a cold restart.",
      parameters: Type.Object({}),
      async execute() {
        domainRun?.recordInspection({
          sourceLineCount: 12,
          glossaryCandidateExists: true,
          characterBibleExists: true
        });
        domainRun?.recordProofreadPrescan();
        domainRun?.recordProofreadMontecarloRound(1);
        if (proofreadState) {
          const document = proofreadDocumentHostState(proofreadState, "default");
          document.sampledLines = [3, 7];
          document.reportInitialized = true;
        }
        return { content: [{ type: "text", text: "primed" }], details: { primed: true } };
      }
    }]
  });
  const firstTerminal = deferred();
  const firstUnsubscribe = firstService.subscribeEvents((entry) => {
    if (entry.event.type === "settled") firstTerminal.resolve();
  });
  try {
    const session = await firstService.createSession(workspaceDir);
    await firstService.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      languagePair: "en->zh-CN",
      proofreadMode: "montecarlo",
      providerId: firstFaux.provider.id,
      modelId: firstFaux.getModel().id
    });
    await Promise.race([
      firstTerminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out priming proofreading state")), 3000))
    ]);
    firstUnsubscribe();
    await firstService.disposeWorkspace(workspaceDir);

    const secondFaux = fauxProvider({ tokensPerSecond: 1000 });
    secondFaux.setResponses([fauxAssistantMessage(fauxText("resumed"))]);
    const secondModels = createModels();
    secondModels.setProvider(secondFaux.provider);
    let restoredDomainRun;
    let restoredProofreadState;
    const secondService = new PiNativeSessionService({
      createModelSelection: async () => ({
        models: secondModels,
        model: secondFaux.getModel(),
        providerId: secondFaux.provider.id,
        modelId: secondFaux.getModel().id
      }),
      enforceDomainCompletion: true,
      createTools: ({ domainRun, proofreadState }) => {
        restoredDomainRun = domainRun;
        restoredProofreadState = proofreadState;
        return [];
      }
    });
    await secondService.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      languagePair: "en->zh-CN",
      proofreadMode: "montecarlo",
      providerId: secondFaux.provider.id,
      modelId: secondFaux.getModel().id
    });
    assert.equal(restoredDomainRun?.kind, "proofread");
    assert.equal(restoredDomainRun?.proofreadMontecarloRoundsCompleted, 1);
    assert.deepEqual(restoredProofreadState?.documents.default.sampledLines, [3, 7]);
    assert.equal(restoredProofreadState?.documents.default.reportInitialized, true);
    await secondService.abort(workspaceDir, session.id);
    await secondService.disposeWorkspace(workspaceDir);
  } finally {
    firstUnsubscribe();
    await firstService.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("simultaneous prompts reserve one native Pi runtime per session", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-prompt-reservation-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(fauxText("first reply")),
    fauxAssistantMessage(fauxText("second reply"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const firstPreparing = deferred();
  const releaseSelection = deferred();
  const terminal = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      firstPreparing.resolve();
      await releaseSelection.promise;
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    }
  });
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    const firstPrompt = service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "first simultaneous prompt",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await firstPreparing.promise;
    const secondPrompt = service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "second simultaneous prompt",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    const outcomesPromise = Promise.allSettled([firstPrompt, secondPrompt]);
    releaseSelection.resolve();
    const outcomes = await outcomesPromise;
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.match(String(rejected.reason), /already running/i);
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for reserved native prompt")), 3000))
    ]);
    const userTexts = (await service.loadMessages(workspaceDir, session.id))
      .filter((message) => message.role === "user")
      .map(userMessageText);
    assert.deepEqual(userTexts, ["first simultaneous prompt"]);
  } finally {
    releaseSelection.resolve();
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("native Pi tool loop emits the tool call and paired result before the final assistant reply", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-tool-loop-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("先调用工具。"),
      fauxToolCall("echo", { value: "live" }, { id: "tool_live" })
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("工具已经完成。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "echo",
      label: "echo",
      description: "Return the supplied value.",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: params.value }],
          details: { value: params.value }
        };
      }
    }]
  });
  const terminal = deferred();
  const liveRoles = [];
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "message_end") liveRoles.push(entry.event.message.role);
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Use the tool",
      providerId: "faux",
      modelId: faux.getModel().id,
      thinkingLevel: "medium"
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for native Pi tool loop")), 5000))
    ]);
    assert.deepEqual(liveRoles, ["user", "assistant", "toolResult", "assistant"]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.deepEqual(messages.map((message) => message.role), liveRoles);
    const call = messages[1].content.find((block) => block.type === "toolCall");
    assert.equal(call.id, "tool_live");
    assert.equal(messages[2].toolCallId, "tool_live");
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Steer queued during a slow native tool is observable immediately and survives run-state reconnect", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-steer-queue-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_slow" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("已收到并应用 Steering。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const queueSeen = deferred();
  const terminal = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const queuedText = "优先采用现有术语表";
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "queue_update" && entry.event.steer.length > 0) queueSeen.resolve(entry.event);
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "run a slow tool",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;

    const queuedAt = Date.now();
    await service.sendInput(workspaceDir, session.id, "steer", queuedText);
    const queueEvent = await Promise.race([
      queueSeen.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for native queue_update")), 250))
    ]);
    assert.ok(Date.now() - queuedAt < 250, "queued Steer should be observable before the slow tool completes");
    assert.equal(userMessageText(queueEvent.steer[0]), queuedText);

    const runningState = await service.getRunState(workspaceDir, session.id);
    assert.equal(runningState.running, true);
    assert.equal(userMessageText(runningState.queuedSteer[0]), queuedText);

    releaseTool.resolve();
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for queued Steer completion")), 3000))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    const userTexts = messages.filter((message) => message.role === "user").map(userMessageText);
    assert.deepEqual(userTexts, ["run a slow tool", queuedText]);
    assert.equal(userTexts.filter((text) => text === queuedText).length, 1);
    assert.deepEqual((await service.getRunState(workspaceDir, session.id)).queuedSteer, []);
  } finally {
    releaseTool.resolve();
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("child persistence waiting for a Pi turn boundary never holds the Stop or input transition lock", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-child-persist-lock-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("abortableTool", {}, { id: "tool_child_persist_lock" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("The fallback release completed the turn."))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "abortableTool",
      label: "abortableTool",
      description: "Wait for Stop or the test fallback release.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        toolStarted.resolve();
        await Promise.race([
          releaseTool.promise,
          new Promise((_, reject) => {
            if (signal.aborted) {
              reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(signal.reason ?? new DOMException("Stopped", "AbortError")),
              { once: true }
            );
          })
        ]);
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  let persistTask;
  let steerTask;
  let abortTask;
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "run the abortable tool",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    persistTask = service.publishExternalMessage(workspaceDir, session.id, {
      role: "custom",
      customType: "subagent.translation",
      content: "child completed while parent was still running",
      display: true,
      details: { subagentId: "subagent_lock_test", status: "completed" },
      timestamp: Date.now()
    });
    await new Promise((resolve) => setImmediate(resolve));
    steerTask = service.sendInput(workspaceDir, session.id, "steer", "preserve this accepted input");
    abortTask = service.abort(workspaceDir, session.id);
    await Promise.race([
      Promise.all([persistTask, steerTask, abortTask]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Child persistence held the transition lock and blocked native input/Stop")),
        500
      ))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.ok(messages.some((message) => (
      message.role === "custom"
      && message.details?.subagentId === "subagent_lock_test"
    )), "the terminal child message was not persisted after Stop released the parent turn boundary");
    const runState = await service.getRunState(workspaceDir, session.id);
    assert.equal(userMessageText(runState.queuedNextTurn[0]), "preserve this accepted input");
  } finally {
    releaseTool.resolve();
    await Promise.allSettled([persistTask, steerTask, abortTask].filter(Boolean));
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("accepted Follow-up survives provider failure and is consumed exactly once by the next native turn", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-followup-recovery-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_failure" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed before Follow-up drain" }),
    fauxAssistantMessage(fauxText("恢复后已处理排队内容。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const firstTerminal = deferred();
  const secondTerminal = deferred();
  let settledCount = 0;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const queuedText = "保留这条 Follow-up，失败后继续处理";
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    if (settledCount === 1) firstTerminal.resolve();
    if (settledCount === 2) secondTerminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "first turn",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    await service.sendInput(workspaceDir, session.id, "followUp", queuedText);
    releaseTool.resolve();
    await Promise.race([
      firstTerminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for failed native turn")), 3000))
    ]);

    const failedState = await service.getRunState(workspaceDir, session.id);
    assert.equal(failedState.running, false);
    assert.equal(userMessageText(failedState.queuedFollowUp[0]), queuedText);

    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "retry turn",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      secondTerminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for recovered native turn")), 3000))
    ]);

    const userTexts = (await service.loadMessages(workspaceDir, session.id))
      .filter((message) => message.role === "user")
      .map(userMessageText);
    assert.deepEqual(userTexts, ["first turn", queuedText, "retry turn"]);
    assert.equal(userTexts.filter((text) => text === queuedText).length, 1);
    const recoveredState = await service.getRunState(workspaceDir, session.id);
    assert.deepEqual(recoveredState.queuedSteer, []);
    assert.deepEqual(recoveredState.queuedFollowUp, []);
    assert.deepEqual(recoveredState.queuedNextTurn, []);
  } finally {
    releaseTool.resolve();
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("accepted Steer survives abort and is consumed exactly once by the next native turn", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-steer-abort-recovery-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_abort" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("停止后已处理保留的 Steering。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const terminal = deferred();
  let settledCount = 0;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const queuedText = "停止后仍需处理这条 Steering";
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type !== "settled") return;
    settledCount += 1;
    if (settledCount >= 2) terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "turn before stop",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    await service.sendInput(workspaceDir, session.id, "steer", queuedText);
    const abortPromise = service.abort(workspaceDir, session.id);
    releaseTool.resolve();
    await abortPromise;

    const stoppedState = await service.getRunState(workspaceDir, session.id);
    assert.equal(stoppedState.running, false);
    assert.equal(userMessageText(stoppedState.queuedNextTurn[0]), queuedText);

    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "retry after stop",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for post-abort native turn")), 3000))
    ]);

    const userTexts = (await service.loadMessages(workspaceDir, session.id))
      .filter((message) => message.role === "user")
      .map(userMessageText);
    assert.deepEqual(userTexts, ["turn before stop", queuedText, "retry after stop"]);
    assert.equal(userTexts.filter((text) => text === queuedText).length, 1);
  } finally {
    releaseTool.resolve();
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("an accepted Steer survives an abort and replacement-prompt race", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-abort-prompt-race-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_abort_prompt_race" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("替换回合已处理停止前接受的 Steering。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const replacementAccepted = deferred();
  const replacementTerminal = deferred();
  let settledCount = 0;
  let replacementPrompt;
  const service = new PiNativeSessionService({
    createModelSelection: () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const queuedText = "停止事务尚未收尾时也不能丢失这条 Steering";
  try {
    const session = await service.createSession(workspaceDir);
    const unsubscribe = service.subscribeEvents((entry) => {
      if (entry.event.type !== "settled") return;
      settledCount += 1;
      if (settledCount === 1) {
        replacementPrompt = service.prompt({
          outputDir: workspaceDir,
          sessionId: session.id,
          prompt: "replacement prompt during abort",
          providerId: faux.provider.id,
          modelId: faux.getModel().id
        });
        replacementPrompt.then(replacementAccepted.resolve, replacementAccepted.reject);
      } else if (settledCount === 2) {
        replacementTerminal.resolve();
      }
    });
    try {
      await service.prompt({
        outputDir: workspaceDir,
        sessionId: session.id,
        prompt: "first prompt",
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      });
      await toolStarted.promise;
      await service.sendInput(workspaceDir, session.id, "steer", queuedText);

      const abortPromise = service.abort(workspaceDir, session.id);
      releaseTool.resolve();
      await Promise.all([abortPromise, replacementAccepted.promise]);
      await Promise.race([
        replacementTerminal.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for replacement native turn")), 3000))
      ]);

      const userTexts = (await service.loadMessages(workspaceDir, session.id))
        .filter((message) => message.role === "user")
        .map(userMessageText);
      assert.deepEqual(userTexts, ["first prompt", queuedText, "replacement prompt during abort"]);
      assert.equal(userTexts.filter((text) => text === queuedText).length, 1);
      const terminalState = await service.getRunState(workspaceDir, session.id);
      assert.deepEqual(terminalState.queuedSteer, []);
      assert.deepEqual(terminalState.queuedFollowUp, []);
      assert.deepEqual(terminalState.queuedNextTurn, []);
    } finally {
      unsubscribe();
    }
  } finally {
    releaseTool.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("deleting a session during abort cannot let a delayed replacement prompt restore its active pointer", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-delete-prompt-race-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_delete_prompt_race" }),
      { stopReason: "toolUse" }
    )
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const raceStarted = deferred();
  const releaseReplacementSelection = deferred();
  let selectionCount = 0;
  let replacementPrompt;
  let replacementOutcome;
  let deletePromise;
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      selectionCount += 1;
      if (selectionCount === 2) {
        await releaseReplacementSelection.promise;
      }
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    },
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  let unsubscribe = () => {};
  try {
    const deletedSession = await service.createSession(workspaceDir);
    const remainingSession = await service.createSession(workspaceDir);
    await service.selectSession(workspaceDir, deletedSession.id);
    unsubscribe = service.subscribeEvents((entry) => {
      if (entry.sessionId !== deletedSession.id || entry.event.type !== "settled" || replacementPrompt) return;
      replacementPrompt = service.prompt({
        outputDir: workspaceDir,
        sessionId: deletedSession.id,
        prompt: "replacement prompt for deleted session",
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      });
      replacementOutcome = replacementPrompt.then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, error })
      );
      deletePromise = service.deleteSession(workspaceDir, deletedSession.id);
      raceStarted.resolve();
    });

    await service.prompt({
      outputDir: workspaceDir,
      sessionId: deletedSession.id,
      prompt: "first prompt before delete",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    const abortPromise = service.abort(workspaceDir, deletedSession.id);
    releaseTool.resolve();
    await raceStarted.promise;
    assert.equal(await deletePromise, true);
    releaseReplacementSelection.resolve();
    await abortPromise;
    const outcome = await replacementOutcome;
    assert.equal(outcome.accepted, false);
    assert.ok(outcome.error instanceof Error);

    const bootstrap = await service.bootstrap(workspaceDir);
    assert.deepEqual(bootstrap.sessions.map((session) => session.id), [remainingSession.id]);
    assert.equal(bootstrap.activeSessionId, remainingSession.id);
    assert.equal(
      await new PiSessionRepository(workspaceDir).readActiveSessionId(),
      remainingSession.id,
      "Deleted session was restored as the on-disk active pointer"
    );
  } finally {
    unsubscribe();
    releaseTool.resolve();
    releaseReplacementSelection.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("aborting one session never blocks accepted Steer in another session", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-cross-session-queue-"));
  const fauxA = fauxProvider({ provider: "faux-session-a", tokensPerSecond: 1000 });
  const fauxB = fauxProvider({ provider: "faux-session-b", tokensPerSecond: 1000 });
  fauxA.setResponses([
    fauxAssistantMessage(fauxToolCall("slowTool", {}, { id: "tool_session_a" }), { stopReason: "toolUse" })
  ]);
  fauxB.setResponses([
    fauxAssistantMessage(fauxToolCall("slowTool", {}, { id: "tool_session_b" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("B 已处理自己的 Steering。"))
  ]);
  const models = createModels();
  models.setProvider(fauxA.provider);
  models.setProvider(fauxB.provider);
  const aStarted = deferred();
  const bStarted = deferred();
  const releaseA = deferred();
  const releaseB = deferred();
  const bTerminal = deferred();
  const controls = new Map([
    [fauxA.provider.id, { started: aStarted, release: releaseA }],
    [fauxB.provider.id, { started: bStarted, release: releaseB }]
  ]);
  const service = new PiNativeSessionService({
    createModelSelection: ({ providerId }) => {
      const faux = providerId === fauxA.provider.id ? fauxA : fauxB;
      return { models, model: faux.getModel(), providerId: faux.provider.id, modelId: faux.getModel().id };
    },
    createTools: ({ request }) => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases this session's tool.",
      parameters: Type.Object({}),
      async execute() {
        const control = controls.get(request.providerId);
        assert.ok(control, `Missing tool control for ${request.providerId}`);
        control.started.resolve();
        await control.release.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  let unsubscribe = () => {};
  try {
    const sessionA = await service.createSession(workspaceDir);
    const sessionB = await service.createSession(workspaceDir);
    unsubscribe = service.subscribeEvents((entry) => {
      if (entry.sessionId === sessionB.id && entry.event.type === "settled") bTerminal.resolve();
    });
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: sessionA.id,
      prompt: "A",
      providerId: fauxA.provider.id,
      modelId: fauxA.getModel().id
    });
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: sessionB.id,
      prompt: "B",
      providerId: fauxB.provider.id,
      modelId: fauxB.getModel().id
    });
    await Promise.all([aStarted.promise, bStarted.promise]);

    const abortA = service.abort(workspaceDir, sessionA.id);
    const steerText = "B session Steer must not wait for A";
    const inputOutcome = service.sendInput(workspaceDir, sessionB.id, "steer", steerText).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    const acceptedBeforeAReleased = await Promise.race([
      inputOutcome,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: new Error("Steer was blocked by session A") }), 300))
    ]);
    assert.equal(acceptedBeforeAReleased.ok, true, acceptedBeforeAReleased.error?.message);

    releaseB.resolve();
    await Promise.race([
      bTerminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for session B")), 3000))
    ]);
    releaseA.resolve();
    await abortA;

    const bUserTexts = (await service.loadMessages(workspaceDir, sessionB.id))
      .filter((message) => message.role === "user")
      .map(userMessageText);
    assert.deepEqual(bUserTexts, ["B", steerText]);
  } finally {
    unsubscribe();
    releaseA.resolve();
    releaseB.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("cancelling runtime preparation preserves the previous native queue exactly once", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-cancelled-preparation-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_cancelled_preparation" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("保留队列已由后续原生回合处理。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const replacementPreparing = deferred();
  const releaseReplacement = deferred();
  let selectionCount = 0;
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      selectionCount += 1;
      if (selectionCount === 2) {
        replacementPreparing.resolve();
        await releaseReplacement.promise;
      }
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    },
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const queuedText = "取消准备也不能丢失这条原生队列";
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "turn before cancelled preparation",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    await service.sendInput(workspaceDir, session.id, "steer", queuedText);
    const stopPromise = service.abort(workspaceDir, session.id);
    releaseTool.resolve();
    await stopPromise;
    assert.equal(userMessageText((await service.getRunState(workspaceDir, session.id)).queuedNextTurn[0]), queuedText);

    const cancelledPrompt = service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "this replacement must never start",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await replacementPreparing.promise;
    const cancelledPromptAssertion = assert.rejects(cancelledPrompt, (error) => error?.name === "AbortError");
    const cancelPreparation = service.abort(workspaceDir, session.id);
    releaseReplacement.resolve();
    await Promise.all([cancelPreparation, cancelledPromptAssertion]);

    const preserved = await service.getRunState(workspaceDir, session.id);
    assert.equal(userMessageText(preserved.queuedNextTurn[0]), queuedText);

    const terminal = deferred();
    const unsubscribe = service.subscribeEvents((entry) => {
      if (entry.event.type === "settled") terminal.resolve();
    });
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "run after cancelled preparation",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for preserved native queue")), 3000))
    ]);
    unsubscribe();

    const userTexts = (await service.loadMessages(workspaceDir, session.id))
      .filter((message) => message.role === "user")
      .map(userMessageText);
    assert.deepEqual(userTexts, ["turn before cancelled preparation", queuedText, "run after cancelled preparation"]);
    assert.equal(userTexts.filter((text) => text === queuedText).length, 1);
  } finally {
    releaseTool.resolve();
    releaseReplacement.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("workspace suspend cannot deadlock a concurrent prompt and later session creation", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-suspend-prompt-deadlock-"));
  const faux = fauxProvider({ provider: "faux-suspend-prompt", tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("prompt after suspend completed"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  let selectionCalls = 0;
  const service = new PiNativeSessionService({
    createModelSelection: () => {
      selectionCalls += 1;
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    }
  });
  let transitionsCompleted = false;
  try {
    const session = await service.createSession(workspaceDir);
    const suspendOutcome = service.suspendWorkspace(workspaceDir).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    const promptOutcome = service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "prompt racing workspace suspend",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    const createOutcome = service.createSession(workspaceDir).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    const outcomes = await Promise.race([
      Promise.all([suspendOutcome, promptOutcome, createOutcome]),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000))
    ]);
    assert.ok(outcomes, "Suspend, concurrent prompt, and later create entered a permanent transition cycle");
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true, true]);
    assert.equal(selectionCalls, 1);
    transitionsCompleted = true;
  } finally {
    if (transitionsCompleted) await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("suspending a workspace preserves accepted native input for the next turn", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-suspend-workspace-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_workspace_suspend" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxText("恢复后已处理关闭页面前接受的输入。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const steerText = "页面关闭后保留 Steering";
  const followUpText = "页面关闭后保留 Follow-up";
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "turn before workspace suspend",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    await service.sendInput(workspaceDir, session.id, "steer", steerText);
    await service.sendInput(workspaceDir, session.id, "followUp", followUpText);
    const suspendPromise = service.suspendWorkspace(workspaceDir);
    releaseTool.resolve();
    await suspendPromise;

    const suspended = await service.getRunState(workspaceDir, session.id);
    assert.equal(suspended.running, false);
    assert.deepEqual(suspended.queuedNextTurn.map(userMessageText), [steerText, followUpText]);

    const terminal = deferred();
    const unsubscribe = service.subscribeEvents((entry) => {
      if (entry.event.type === "settled") terminal.resolve();
    });
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "run after workspace suspend",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for suspended native queue")), 3000))
    ]);
    unsubscribe();

    const userTexts = (await service.loadMessages(workspaceDir, session.id))
      .filter((message) => message.role === "user")
      .map(userMessageText);
    assert.deepEqual(userTexts, ["turn before workspace suspend", steerText, followUpText, "run after workspace suspend"]);
    assert.equal(userTexts.filter((text) => text === steerText).length, 1);
    assert.equal(userTexts.filter((text) => text === followUpText).length, 1);
  } finally {
    releaseTool.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("mixed native inputs retain acceptance order when their timestamps collide", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-queue-order-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slowTool", {}, { id: "tool_before_mixed_queue_abort" }),
      { stopReason: "toolUse" }
    )
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const releaseTool = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    createTools: () => [{
      name: "slowTool",
      label: "slowTool",
      description: "Wait until the test releases the tool.",
      parameters: Type.Object({}),
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "released" }], details: { released: true } };
      }
    }]
  });
  const followUpText = "同毫秒先接受 Follow-up";
  const steerText = "同毫秒后接受 Steer";
  const originalNow = Date.now;
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "turn before mixed queue abort",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    Date.now = () => 123456789;
    await service.sendInput(workspaceDir, session.id, "followUp", followUpText);
    await service.sendInput(workspaceDir, session.id, "steer", steerText);
    Date.now = originalNow;

    const stopPromise = service.abort(workspaceDir, session.id);
    releaseTool.resolve();
    await stopPromise;
    const stopped = await service.getRunState(workspaceDir, session.id);
    assert.deepEqual(stopped.queuedNextTurn.map(userMessageText), [followUpText, steerText]);
  } finally {
    Date.now = originalNow;
    releaseTool.resolve();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Stop suspends the workflow contract so the next ordinary prompt does not resume it", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-stop-domain-contract-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("holdUntilStop", {}, { id: "hold_until_stop" }), { stopReason: "toolUse" })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: ({ domainRun, persistHostState }) => [
      {
        name: "holdUntilStop",
        label: "hold until Stop",
        description: "Hold the first workflow turn until its native abort signal arrives.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, signal) {
          domainRun?.recordInspection({ sourceLineCount: 2, glossaryCandidateExists: true, characterBibleExists: true });
          domainRun?.recordTranslationReuseAuditReady(["pending-after-stop"]);
          await persistHostState?.();
          toolStarted.resolve();
          await new Promise((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", resolve, { once: true });
          });
          throw new DOMException("Stopped by the user.", "AbortError");
        }
      },
      {
        name: "attemptStaleWorkflowMutation",
        label: "attempt stale workflow mutation",
        description: "Attempt workflow progress without an explicit resume.",
        parameters: Type.Object({}),
        async execute() {
          domainRun?.assertWorkflowActive();
          domainRun?.recordInspection({ sourceLineCount: 2, glossaryCandidateExists: true, characterBibleExists: true });
          return { content: [{ type: "text", text: "unexpected mutation" }] };
        }
      }
    ]
  });
  const ordinarySettled = deferred();
  let waitingForOrdinary = false;
  const unsubscribe = service.subscribeEvents((entry) => {
    if (waitingForOrdinary && entry.event.type === "settled") ordinarySettled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    await service.abort(workspaceDir, session.id);

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("attemptStaleWorkflowMutation", {}, { id: "stale_mutation" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("ordinary reply after Stop")),
      fauxAssistantMessage(fauxText("stale workflow repair one")),
      fauxAssistantMessage(fauxText("stale workflow repair two"))
    ]);
    waitingForOrdinary = true;
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "你好，这是停止后的普通对话。",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      ordinarySettled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for ordinary prompt after Stop")), 5000))
    ]);

    const messages = await service.loadMessages(workspaceDir, session.id);
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(assistantText, /ordinary reply after Stop/);
    assert.doesNotMatch(assistantText, /stale workflow repair/);
    assert.equal((await service.getRunState(workspaceDir, session.id)).error, undefined);
    const stoppedRuntime = [...service.active.values()][0];
    assert.equal(stoppedRuntime.hostState.workflowSuspended, false);
    assert.equal(stoppedRuntime.hostState.domainRun?.fullWorkflow, false, "ordinary chat must use a fresh bounded operation contract");
    assert.deepEqual(
      stoppedRuntime.hostState.domainRun?.snapshot().pendingTranslationReuseAuditIds,
      [],
      "ordinary chat cannot inherit or authorize a suspended pending reuse decision"
    );
    const reopened = await new PiSessionRepository(workspaceDir).open(session.id);
    const hostState = await loadYnSessionHostState(reopened, session.id);
    assert.equal(hostState?.domainRun?.fullWorkflowActive, false);
    assert.notEqual(hostState?.workflowSuspended, true);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a fresh explicit prompt for the same workflow resumes a Stop-suspended Host contract before model tools run", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-explicit-workflow-resume-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("holdExplicitWorkflow", {}, { id: "hold_explicit_workflow" }), { stopReason: "toolUse" })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const toolStarted = deferred();
  let activeWorkflowObserved = false;
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: ({ domainRun }) => [{
      name: "holdExplicitWorkflow",
      label: "hold explicit workflow",
      description: "Wait for Stop while an incomplete proofreading workflow is active.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        domainRun?.recordInspection({ sourceLineCount: 2, glossaryCandidateExists: true, characterBibleExists: true });
        domainRun?.recordProofreadPrescan();
        toolStarted.resolve();
        await new Promise((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", resolve, { once: true });
        });
        throw new DOMException("Stopped by the user.", "AbortError");
      }
    }, {
      name: "assertExplicitWorkflowActive",
      label: "assert explicit workflow active",
      description: "Verify that explicit typed continuation resumed the Host contract.",
      parameters: Type.Object({}),
      async execute() {
        domainRun?.assertWorkflowActive();
        activeWorkflowObserved = true;
        return { content: [{ type: "text", text: "workflow active" }] };
      }
    }]
  });
  const explicitSettled = deferred();
  let waitingForExplicit = false;
  const unsubscribe = service.subscribeEvents((entry) => {
    if (waitingForExplicit && entry.event.type === "settled") explicitSettled.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-proofread-v1.",
      workflowIntent: "proofread",
      languagePair: "ja->zh-CN",
      proofreadMode: "split",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await toolStarted.promise;
    await service.abort(workspaceDir, session.id);

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("assertExplicitWorkflowActive", {}, { id: "assert_explicit_active" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("explicit workflow resumed")),
      fauxAssistantMessage(fauxText("explicit workflow remains incomplete")),
      fauxAssistantMessage(fauxText("explicit workflow remains incomplete"))
    ]);
    waitingForExplicit = true;
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-proofread-v1. Continue proofreading.",
      workflowIntent: "proofread",
      languagePair: "ja->zh-CN",
      proofreadMode: "split",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await Promise.race([
      explicitSettled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for explicit workflow resume")), 5000))
    ]);

    assert.equal(activeWorkflowObserved, true);
    const active = [...service.active.values()][0];
    assert.equal(active.hostState.workflowSuspended, false);
    assert.equal(active.hostState.domainRun?.suspended, false);
    assert.match((await service.getRunState(workspaceDir, session.id)).error ?? "", /completion contract failed|No more faux responses queued/i);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Stop suspends the workflow while preserving its persisted translation review debt", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-stop-review-debt-"));
  const sourcePath = path.join(workspaceDir, "source.txt");
  await writeFile(sourcePath, "Source one.\nSource two.", "utf8");
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("holdRejectedReview", {}, { id: "hold-rejected-review" }), { stopReason: "toolUse" })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const reviewPersisted = deferred();
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: (context) => [{
      name: "holdRejectedReview",
      label: "hold rejected review",
      description: "Persist one rejected review row, then wait for Stop.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        context.translationAlignmentState.ranges["source.txt"] = [{
          documentId: "source.txt",
          auditId: "persisted-review-before-stop",
          inputHash: "reviewed-candidate-hash",
          candidatePath: path.join(workspaceDir, "AI_translation", "source_translated.txt"),
          sourceLineCount: 2,
          fromLine: 1,
          toLine: 2,
          riskLineCount: 1,
          sampledLineCount: 1,
          checks: [
            { line: 1, signals: ["review_context_failure"], verdict: "misaligned", reason: "Wrong meaning." },
            { line: 2, signals: ["deterministic_unflagged_sample"], verdict: "aligned" }
          ]
        }];
        await context.persistHostState();
        reviewPersisted.resolve();
        await new Promise((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", resolve, { once: true });
        });
        throw new DOMException("Stopped by the user.", "AbortError");
      }
    }]
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sourcePath,
      sourceDocumentId: "source.txt",
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "en->zh-CN",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await reviewPersisted.promise;
    await service.abort(workspaceDir, session.id);

    const reopened = await new PiSessionRepository(workspaceDir).open(session.id);
    const hostState = await loadYnSessionHostState(reopened, session.id);
    assert.equal(hostState?.domainRun?.fullWorkflowActive, true, "Stop must retain the same-session workflow contract");
    assert.equal(hostState?.workflowSuspended, true, "stopped work must not remain live");
    assert.equal(hostState?.translationAlignment.ranges["source.txt"]?.[0]?.checks[0]?.verdict, "misaligned");
    assert.equal(hostState?.translationAlignment.ranges["source.txt"]?.[0]?.checks[0]?.reason, "Wrong meaning.");
  } finally {
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("YN host completion contract keeps the native Pi loop running until validation succeeds", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-domain-gate-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(fauxText("已经完成。")),
    fauxAssistantMessage(fauxToolCall("finishWorkflow", {}, { id: "finish_workflow" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("产物已通过最终校验。"))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: ({ domainRun }) => [{
      name: "finishWorkflow",
      label: "finish workflow",
      description: "Complete all host-validated translation stages.",
      parameters: Type.Object({}),
      async execute() {
        domainRun?.recordInspection({ sourceLineCount: 3, glossaryCandidateExists: true, characterBibleExists: true });
        domainRun?.recordSubagentBatchStarted("translation", "test-completion-batch", {
          taskCount: 2,
          workerCount: 2
        });
        domainRun?.recordTranslationArtifactMutation();
        domainRun?.recordSubagentBatch("translation", "test-completion-batch", 2);
        domainRun?.recordFinalValidation("translation");
        return { content: [{ type: "text", text: "validated" }], details: { validated: true } };
      }
    }]
  });
  const terminal = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      providerId: "faux",
      modelId: faux.getModel().id,
      thinkingLevel: "medium"
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for host completion repair")), 5000))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.ok(messages.some((message) => message.role === "custom" && message.customType === "yn-domain-repair"));
    assert.ok(messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === "finishWorkflow")));
    assert.equal((await service.getRunState(workspaceDir, session.id)).error, undefined);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a Host wait-for-user tool result stops the native loop instead of retrying through domain-repair", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-user-wait-gate-"));
  let toolCalls = 0;
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("needUser", {}, { id: "need_user_wait" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("needUser", {}, { id: "need_user_retry" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("I retried the same gated tool."))
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: () => [{
      name: "needUser",
      label: "need user",
      description: "Request an explicit user continuation.",
      parameters: Type.Object({}),
      async execute() {
        toolCalls += 1;
        return {
          content: [{
            type: "text",
            text: "YN child batch batch_wait is paused after an exhausted assignment. Wait for an explicit user continuation before starting or mutating the workflow."
          }],
          isError: true
        };
      }
    }]
  });
  const terminal = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      providerId: "faux",
      modelId: faux.getModel().id,
      thinkingLevel: "medium"
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for wait-gate settlement")), 5000))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.equal(toolCalls, 1, "the wait-gate must terminate the current tool batch");
    assert.equal(messages.some((message) => message.role === "custom" && message.customType === "yn-domain-repair"), false);
    assert.equal(messages.filter((message) => message.role === "toolResult").length, 1);
    assert.equal((await service.getRunState(workspaceDir, session.id)).running, false);
    assert.equal((await service.getRunState(workspaceDir, session.id)).error, undefined);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a Host ask-the-user tool result can speak once but must not be kicked by domain-repair", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-user-ask-gate-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("needUser", {}, { id: "need_user_ask" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("请告诉我是否保留已通过的旧译。")),
    fauxAssistantMessage(fauxToolCall("needUser", {}, { id: "need_user_ask_retry" }), { stopReason: "toolUse" })
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    }),
    enforceDomainCompletion: true,
    createTools: () => [{
      name: "needUser",
      label: "need user",
      description: "Ask the user for a workflow decision.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "Ask the user for the reuse decision." }],
          details: { nextAction: "Ask the user for the reuse decision." }
        };
      }
    }]
  });
  const terminal = deferred();
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") terminal.resolve();
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Workflow: yn-translation-v1.",
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      providerId: "faux",
      modelId: faux.getModel().id,
      thinkingLevel: "medium"
    });
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for ask-gate settlement")), 5000))
    ]);
    const messages = await service.loadMessages(workspaceDir, session.id);
    assert.ok(messages.some((message) => (
      message.role === "assistant"
      && String(message.content?.[0]?.text || "").includes("是否保留")
    )));
    assert.equal(messages.some((message) => message.role === "custom" && message.customType === "yn-domain-repair"), false);
    assert.equal(
      messages.filter((message) => message.role === "toolResult").length,
      1,
      "domain-repair must not force another gated tool call after the model asked the user"
    );
    assert.equal((await service.getRunState(workspaceDir, session.id)).error, undefined);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("child completion delivered at the parent final queue boundary reaches a native Pi continuation", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-parent-completion-boundary-"));
  const releaseInitialProvider = deferred();
  const finalQueueBoundary = deferred();
  const releaseFinalQueueBoundary = deferred();
  let completionReachedProvider = false;
  const faux = fauxProvider({ provider: "parent-completion-boundary", tokensPerSecond: 1000 });
  faux.setResponses([
    async () => {
      await releaseInitialProvider.promise;
      return fauxAssistantMessage(fauxText("parent reached its final queue poll"));
    },
    async (context) => {
      completionReachedProvider = context.messages.some((message) => (
        message.role === "user"
        && userMessageText(message).includes("one child failed and one completed")
      ));
      return fauxAssistantMessage(fauxText("parent consumed the terminal child batch result"));
    }
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  let unsubscribeBoundary = () => {};
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "keep the parent alive until its native final queue boundary",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    const active = [...service.active.values()].find((candidate) => candidate.sessionId === session.id);
    assert.ok(active, "test could not observe the committed native Pi parent runtime");
    let holdFirstAgentEnd = true;
    unsubscribeBoundary = active.runtime.subscribe(async (event) => {
      if (event.type !== "agent_end" || !holdFirstAgentEnd) return;
      holdFirstAgentEnd = false;
      finalQueueBoundary.resolve();
      await releaseFinalQueueBoundary.promise;
    });

    releaseInitialProvider.resolve();
    await finalQueueBoundary.promise;
    const delivery = service.deliverParentNotification(workspaceDir, session.id, {
      role: "custom",
      customType: "subagent-completion",
      content: "one child failed and one completed; start a replacement batch",
      display: false,
      timestamp: Date.now()
    }, active.childCompletionGeneration);
    releaseFinalQueueBoundary.resolve();
    await Promise.race([
      delivery,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out delivering child completion at the parent final queue boundary")), 5000))
    ]);

    const startedAt = Date.now();
    while ((await service.getRunState(workspaceDir, session.id)).running) {
      if (Date.now() - startedAt > 5000) throw new Error("Timed out waiting for the parent continuation to settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completionReachedProvider, true);
    assert.deepEqual(
      (await service.loadMessages(workspaceDir, session.id)).map((message) => message.role),
      ["user", "assistant", "custom", "assistant"]
    );
  } finally {
    releaseInitialProvider.resolve();
    releaseFinalQueueBoundary.resolve();
    unsubscribeBoundary();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a recovery pause still delivers child completion through one visible parent reporting turn", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-recovery-pause-report-"));
  let completionReachedProvider = false;
  const faux = fauxProvider({ provider: "recovery-pause-report", tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage(fauxText("parent is ready")),
    async (context) => {
      completionReachedProvider = context.messages.some((message) => (
        message.role === "user" && userMessageText(message).includes("parent takeover required")
      ));
      return fauxAssistantMessage(fauxText("The translation batch paused after failure and requires explicit continuation."));
    }
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "start a normal parent turn",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    const initialStartedAt = Date.now();
    while ((await service.getRunState(workspaceDir, session.id)).running) {
      if (Date.now() - initialStartedAt > 5000) throw new Error("Timed out waiting for initial parent turn");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const active = [...service.active.values()].find((candidate) => candidate.sessionId === session.id);
    assert.ok(active);
    const domainRun = createYnDomainRunContract({
      workflowIntent: "translation",
      fullWorkflow: true,
      subagentEnabled: true,
      subagentCount: 1
    });
    domainRun.recordInspection({
      sourceLineCount: 2,
      documents: [{ id: "source.txt", sourceLineCount: 2 }],
      glossaryCandidateExists: false,
      characterBibleExists: false
    });
    domainRun.recordSubagentBatchStarted("translation", "failed-batch", {
      taskCount: 1,
      workerCount: 1,
      documentIds: ["source.txt"],
      assignmentCounts: { "source.txt": 1 }
    });
    domainRun.recordSubagentBatchFailure("translation", "failed-batch", ["source.txt"]);
    assert.ok(domainRun.recoveryPauseId);
    active.domainRun = domainRun;

    await service.deliverParentNotification(workspaceDir, session.id, {
      role: "custom",
      customType: "subagent-completion",
      content: "parent takeover required after the translation worker failed",
      display: false,
      timestamp: Date.now()
    }, active.childCompletionGeneration);
    const reportStartedAt = Date.now();
    while ((await service.getRunState(workspaceDir, session.id)).running) {
      if (Date.now() - reportStartedAt > 5000) throw new Error("Timed out waiting for recovery-pause report turn");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completionReachedProvider, true);
    assert.deepEqual(
      (await service.loadMessages(workspaceDir, session.id)).map((message) => message.role),
      ["user", "assistant", "custom", "assistant"]
    );
    assert.ok(domainRun.recoveryPauseId, "the reporting turn must not implicitly resume the failed queue");
  } finally {
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Stop cancels an in-flight child completion before it can resurrect a hidden parent turn", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-stop-parent-completion-"));
  const releaseInitialProvider = deferred();
  const finalQueueBoundary = deferred();
  const releaseFinalQueueBoundary = deferred();
  const completionQueueAttempted = deferred();
  let providerCalls = 0;
  const faux = fauxProvider({ provider: "stop-parent-completion", tokensPerSecond: 1000 });
  faux.setResponses([
    async () => {
      providerCalls += 1;
      await releaseInitialProvider.promise;
      return fauxAssistantMessage(fauxText("parent reached its final queue poll before Stop"));
    },
    async () => {
      providerCalls += 1;
      return fauxAssistantMessage(fauxText("cancelled child completion resurrected the parent"));
    }
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  let unsubscribeBoundary = () => {};
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "hold the parent at its final queue boundary before Stop",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    const active = [...service.active.values()].find((candidate) => candidate.sessionId === session.id);
    assert.ok(active, "test could not observe the committed native Pi parent runtime");
    const nativeFollowUp = active.runtime.followUpMessageAndWaitForConsumption.bind(active.runtime);
    active.runtime.followUpMessageAndWaitForConsumption = (message) => {
      const consumption = nativeFollowUp(message);
      completionQueueAttempted.resolve();
      return consumption;
    };
    let holdFirstAgentEnd = true;
    unsubscribeBoundary = active.runtime.subscribe(async (event) => {
      if (event.type !== "agent_end" || !holdFirstAgentEnd) return;
      holdFirstAgentEnd = false;
      finalQueueBoundary.resolve();
      await releaseFinalQueueBoundary.promise;
    });

    releaseInitialProvider.resolve();
    await finalQueueBoundary.promise;
    const delivery = service.deliverParentNotification(workspaceDir, session.id, {
      role: "custom",
      customType: "subagent-completion",
      content: "the background child batch settled immediately before Stop",
      display: false,
      timestamp: Date.now()
    }, active.childCompletionGeneration);
    await completionQueueAttempted.promise;

    const stopped = service.abort(workspaceDir, session.id);
    releaseFinalQueueBoundary.resolve();
    await Promise.race([
      Promise.all([delivery, stopped]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out racing Stop with child completion delivery")), 5000))
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(providerCalls, 1, "Stop allowed the cancelled child completion to start another provider turn");
    assert.equal((await service.getRunState(workspaceDir, session.id)).running, false);
    assert.deepEqual(
      (await service.loadMessages(workspaceDir, session.id)).map((message) => message.role),
      ["user", "assistant"],
      "Stop persisted a hidden child completion or its resurrected assistant reply"
    );
  } finally {
    releaseInitialProvider.resolve();
    releaseFinalQueueBoundary.resolve();
    unsubscribeBoundary();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Pi session bootstrap does not read every historical transcript body", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-bootstrap-"));
  const repository = new PiSessionRepository(workspaceDir);
  try {
    for (let index = 0; index < 24; index += 1) {
      const session = await repository.create(`history_${index}`);
      await session.appendMessage({ role: "user", content: `history ${index}`, timestamp: Date.now() });
      await session.appendMessage({
        role: "custom",
        customType: "large.history",
        content: "x".repeat(100_000),
        display: false,
        timestamp: Date.now()
      });
    }
    const service = new PiNativeSessionService();
    const startedAt = Date.now();
    const bootstrap = await service.bootstrap(workspaceDir);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(bootstrap.sessions.length, 24);
    assert.ok(elapsedMs < 3000, `bootstrap took ${elapsedMs}ms`);
    assert.ok(bootstrap.sessions.every((session) => session.firstMessage.startsWith("history ")));
  } finally {
    await repository.env.cleanup();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("prompting an inactive Pi session does not change the persisted active session", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-inactive-prompt-"));
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([fauxAssistantMessage(fauxText("inactive session reply"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  const settled = deferred();
  let inactiveSessionId = "";
  const unsubscribe = service.subscribeEvents((entry) => {
    if (entry.sessionId === inactiveSessionId && entry.event.type === "settled") settled.resolve();
  });
  try {
    const inactive = await service.createSession(workspaceDir);
    inactiveSessionId = inactive.id;
    const selected = await service.createSession(workspaceDir);
    await service.selectSession(workspaceDir, selected.id);

    await service.prompt({
      outputDir: workspaceDir,
      sessionId: inactive.id,
      prompt: "run this stale window without selecting it",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    assert.equal(
      (await service.bootstrap(workspaceDir)).activeSessionId,
      selected.id,
      "ordinary prompt preparation must not take persisted selection ownership"
    );
    await Promise.race([
      settled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for inactive prompt")), 3000))
    ]);
    assert.equal((await service.bootstrap(workspaceDir)).activeSessionId, selected.id);
  } finally {
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("deleting a non-active Pi session preserves the selected session", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-delete-session-"));
  const service = new PiNativeSessionService();
  try {
    const selected = await service.createSession(workspaceDir);
    const removed = await service.createSession(workspaceDir);
    await service.createSession(workspaceDir);
    await service.selectSession(workspaceDir, selected.id);
    assert.equal((await service.bootstrap(workspaceDir)).activeSessionId, selected.id);
    assert.equal(await service.deleteSession(workspaceDir, removed.id), true);
    assert.equal((await service.bootstrap(workspaceDir)).activeSessionId, selected.id);
  } finally {
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("deleting an idle inactive runtime never broadcasts it as the selected session", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-delete-inactive-runtime-"));
  const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  faux.setResponses([fauxAssistantMessage(fauxText("old session completed"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  const settled = deferred();
  const unsubscribeEvents = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled") settled.resolve();
  });
  const selectedSessionEvents = [];
  const unsubscribeState = service.subscribeState((_workspace, state) => {
    selectedSessionEvents.push(state.sessionId);
  });
  try {
    const oldSession = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: oldSession.id,
      prompt: "complete the old session",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await settled.promise;
    const selected = await service.createSession(workspaceDir);
    selectedSessionEvents.length = 0;

    assert.equal(await service.deleteSession(workspaceDir, oldSession.id), true);
    assert.deepEqual(selectedSessionEvents, []);
    assert.equal((await service.bootstrap(workspaceDir)).activeSessionId, selected.id);
  } finally {
    unsubscribeEvents();
    unsubscribeState();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("Stop during native preflight prevents the model turn from starting after context inspection resumes", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-stop-preflight-"));
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([fauxAssistantMessage(fauxText("This reply must never run."))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new PiNativeSessionService({
    createModelSelection: async () => ({
      models,
      model: faux.getModel(),
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    })
  });
  const contextInspectionStarted = deferred();
  const releaseContextInspection = deferred();
  const eventTypes = [];
  const originalBuildContext = Session.prototype.buildContext;
  let blockNextBuildContext = false;
  Session.prototype.buildContext = async function (...args) {
    if (blockNextBuildContext) {
      blockNextBuildContext = false;
      contextInspectionStarted.resolve();
      await releaseContextInspection.promise;
    }
    return originalBuildContext.apply(this, args);
  };
  const unsubscribe = service.subscribeEvents((entry) => eventTypes.push(entry.event.type));
  try {
    const session = await service.createSession(workspaceDir);
    blockNextBuildContext = true;
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "Do not run after Stop",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await contextInspectionStarted.promise;

    await service.abort(workspaceDir, session.id);
    assert.equal((await service.getRunState(workspaceDir, session.id)).running, false);
    releaseContextInspection.resolve();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(eventTypes.includes("agent_start"), false, "the Pi harness started after Stop completed");
    assert.deepEqual(await service.loadMessages(workspaceDir, session.id), []);
  } finally {
    Session.prototype.buildContext = originalBuildContext;
    releaseContextInspection.resolve();
    unsubscribe();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

await test("a replacement prompt rebases its sequence after the previous turn finalizes during runtime preparation", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-sequence-rebase-"));
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const releaseReplacement = deferred();
  faux.setResponses([
    fauxAssistantMessage(fauxText("first turn complete")),
    async () => {
      await releaseReplacement.promise;
      return fauxAssistantMessage(fauxText("replacement complete"));
    }
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const replacementPreparationStarted = deferred();
  const releaseReplacementPreparation = deferred();
  let modelSelectionCount = 0;
  const service = new PiNativeSessionService({
    createModelSelection: async () => {
      modelSelectionCount += 1;
      if (modelSelectionCount === 2) {
        replacementPreparationStarted.resolve();
        await releaseReplacementPreparation.promise;
      }
      return {
        models,
        model: faux.getModel(),
        providerId: faux.provider.id,
        modelId: faux.getModel().id
      };
    }
  });
  const previousFinalizationStarted = deferred();
  const releasePreviousFinalization = deferred();
  const previousIdleState = deferred();
  const originalBuildContext = Session.prototype.buildContext;
  let blockFinalBuildContext = false;
  let awaitingPreviousIdle = false;
  Session.prototype.buildContext = async function (...args) {
    if (blockFinalBuildContext) {
      blockFinalBuildContext = false;
      previousFinalizationStarted.resolve();
      await releasePreviousFinalization.promise;
    }
    return originalBuildContext.apply(this, args);
  };
  const unsubscribeEvents = service.subscribeEvents((entry) => {
    if (entry.event.type === "settled" && !blockFinalBuildContext) blockFinalBuildContext = true;
  });
  const unsubscribeState = service.subscribeState((_workspace, state) => {
    if (awaitingPreviousIdle && !state.running && state.phase === "idle") previousIdleState.resolve(state);
  });
  try {
    const session = await service.createSession(workspaceDir);
    await service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "first turn",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await previousFinalizationStarted.promise;

    const replacementPrompt = service.prompt({
      outputDir: workspaceDir,
      sessionId: session.id,
      prompt: "replacement turn",
      providerId: faux.provider.id,
      modelId: faux.getModel().id
    });
    await replacementPreparationStarted.promise;

    awaitingPreviousIdle = true;
    releasePreviousFinalization.resolve();
    const previousIdle = await previousIdleState.promise;
    releaseReplacementPreparation.resolve();
    await replacementPrompt;
    const replacementRunning = await service.getRunState(workspaceDir, session.id);

    assert.equal(previousIdle.running, false);
    assert.equal(replacementRunning.running, true);
    assert.ok(
      replacementRunning.sequence > previousIdle.sequence,
      `replacement prompt reused sequence ${replacementRunning.sequence} after terminal ${previousIdle.sequence}`
    );
  } finally {
    Session.prototype.buildContext = originalBuildContext;
    releasePreviousFinalization.resolve();
    releaseReplacementPreparation.resolve();
    releaseReplacement.resolve();
    unsubscribeEvents();
    unsubscribeState();
    await service.disposeWorkspace(workspaceDir);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
