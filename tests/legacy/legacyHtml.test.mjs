import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  embeddedBatchLineReviewFiles,
  needsLegacyBatchLineReviewUpgrade,
  needsLegacyLineReviewUpgrade,
  needsLegacyProposalReviewUpgrade,
  upgradeLegacyBatchLineReviewHtmlContent,
  upgradeLegacyLineReviewHtmlContent,
  upgradeLegacyProposalReviewHtmlContent
} from "../../src/shared/core/legacyHtml.ts";
import {
  BATCH_LINE_REVIEW_PROTOCOL_MARKER,
  BATCH_LINE_REVIEW_PROTOCOL_VERSION,
  LINE_REVIEW_PROTOCOL_MARKER,
  PROMPT_SETTINGS_VERSION,
  renderBatchLineReviewIndexHtml
} from "../../src/shared/core/html.ts";
import { agentChatFlowVersion } from "../../src/shared/core/agentChatEmbed.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const toyHtml = path.join(root, "examples", "toy-agent-artifacts", ".translation-workshop", "html", "line-review-source.html");

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

await test("legacy folder review upgrades to the current tab-host protocol", () => {
  const current = renderBatchLineReviewIndexHtml({
    title: "folder review",
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "missing-translation",
      sourceLineCount: 2
    }]
  });
  assert.equal(needsLegacyBatchLineReviewUpgrade(current), false);
  const legacy = current
    .replace(`<meta name="translation-workshop-batch-review" content="${BATCH_LINE_REVIEW_PROTOCOL_MARKER}">`, "")
    .replace("const error = await api.openPath(targetUrl);", 'window.open(file.outputPath, "_blank"); const error = "";');
  assert.equal(needsLegacyBatchLineReviewUpgrade(legacy), true);
  const upgraded = upgradeLegacyBatchLineReviewHtmlContent(legacy, "fallback.html");
  assert.ok(upgraded, "expected legacy folder review to upgrade");
  assert.match(upgraded, new RegExp(BATCH_LINE_REVIEW_PROTOCOL_MARKER));
  assert.match(upgraded, /api\.openPath\(targetUrl\)/);
  assert.match(upgraded, />\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00</);
  assert.doesNotMatch(upgraded, /window\.open\(file\.outputPath/);
});

await test("legacy folder review migration preserves the folder batch prompt", () => {
  const current = renderBatchLineReviewIndexHtml({
    title: "folder batch prompt",
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "matched",
      sourceLineCount: 2
    }],
    workflow: {
      sourcePath: "G:/project/source",
      sourceKind: "folder",
      outputDir: "G:/project/output",
      inputMode: "bilingual",
      advanced: { languagePair: "ja->zh-CN", splitSize: 500 }
    }
  });
  const legacy = current.replace(
    `<meta name="translation-workshop-batch-review" content="${BATCH_LINE_REVIEW_PROTOCOL_MARKER}">`,
    ""
  );
  const upgraded = upgradeLegacyBatchLineReviewHtmlContent(legacy, "fallback.html");
  assert.ok(upgraded, "expected legacy folder review to upgrade");
  assert.doesNotMatch(upgraded, /id="folderTranslatePrompt"/);
  assert.doesNotMatch(upgraded, /batchPromptPanel/);
  assert.match(upgraded, /Source folder: G:\/project\/source/);
  assert.match(upgraded, /File order \(removed names are skipped; braces remove relative ordering only\)/);
  assert.match(upgraded, /Subagents: enabled; maximum=project ceiling/);
  assert.doesNotMatch(upgraded, /Subagents: enabled; maximum=2/);
  assert.doesNotMatch(upgraded, /runTranslationSubagents|worker queue|line ranges/);
  assert.match(upgraded, /"inputMode":"bilingual"/);
  assert.match(upgraded, /"splitSize":500/);
});

await test("v2 folder indexes with the obsolete sidebar upgrade to the current clean index", () => {
  const current = renderBatchLineReviewIndexHtml({
    title: "old sidebar",
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "matched",
      sourceLineCount: 1
    }],
    workflow: {
      sourcePath: "G:/project/source",
      sourceKind: "folder",
      outputDir: "G:/project/output",
      advanced: { languagePair: "ja->zh-CN" }
    }
  });
  const legacy = current
    .replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-v2")
    .replace("<main>", '<main><aside class="batchPromptPanel"><textarea id="folderTranslatePrompt">old</textarea></aside>');
  assert.equal(needsLegacyBatchLineReviewUpgrade(legacy), true);
  const upgraded = upgradeLegacyBatchLineReviewHtmlContent(legacy, "old.html", "G:/project/output");
  assert.ok(upgraded, "expected v2 folder review to upgrade");
  assert.match(upgraded, new RegExp(BATCH_LINE_REVIEW_PROTOCOL_MARKER));
  assert.doesNotMatch(upgraded, /batchPromptPanel/);
  assert.doesNotMatch(upgraded, /id="folderTranslatePrompt"/);
  assert.match(upgraded, /Source folder: G:\/project\/source/);
});

await test("future folder-review protocols are never downgraded to the current renderer", () => {
  const current = renderBatchLineReviewIndexHtml({
    title: "future folder review",
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "matched",
      sourceLineCount: 2
    }]
  });
  const futureVersion = BATCH_LINE_REVIEW_PROTOCOL_VERSION + 1;
  const futureMarker = `translation-workshop-batch-review-v${futureVersion}`;
  const future = current.replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, futureMarker);
  assert.equal(needsLegacyBatchLineReviewUpgrade(future), false);
  assert.throws(
    () => upgradeLegacyBatchLineReviewHtmlContent(future, "future.html"),
    new RegExp(`newer batch review protocol v${futureVersion}`, "i")
  );
  const futureWithoutV1Data = future.replace(
    /<script\b[^>]*\bid=["']batchData["'][^>]*>[\s\S]*?<\/script>/i,
    ""
  );
  assert.equal(needsLegacyBatchLineReviewUpgrade(futureWithoutV1Data), false);
  assert.throws(
    () => upgradeLegacyBatchLineReviewHtmlContent(futureWithoutV1Data, "future.html"),
    new RegExp(`newer batch review protocol v${futureVersion}`, "i")
  );
});

await test("v1 folder indexes without a route are upgraded with a folder batch prompt", () => {
  const legacy = `<!doctype html><html lang="zh-CN"><head><meta name="translation-workshop-batch-review" content="translation-workshop-batch-review-v1"><title>old folder</title></head><body><script id="batchData" type="application/json">${JSON.stringify({
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "missing-translation",
      sourceLineCount: 2
    }],
    labels: {}
  })}</script></body></html>`;
  assert.equal(needsLegacyBatchLineReviewUpgrade(legacy), true);
  const upgraded = upgradeLegacyBatchLineReviewHtmlContent(legacy, "old.html", "G:/project/output");
  assert.ok(upgraded, "expected v1 folder index to upgrade");
  assert.doesNotMatch(upgraded, /id="folderTranslatePrompt"/);
  assert.doesNotMatch(upgraded, /batchPromptPanel/);
  assert.match(upgraded, /Source folder: G:\/project\/source/);
  assert.match(upgraded, /"sourceKind":"folder"/);
  assert.match(upgraded, /"outputDir":"G:\/project\/output"/);
});

await test("malformed named folder-review protocols fail visibly instead of being rewritten", () => {
  const current = renderBatchLineReviewIndexHtml({
    title: "malformed folder review",
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "matched",
      sourceLineCount: 2
    }]
  });
  const malformed = current.replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-next");
  assert.throws(() => needsLegacyBatchLineReviewUpgrade(malformed), /malformed batch review protocol/i);
  assert.throws(
    () => upgradeLegacyBatchLineReviewHtmlContent(malformed, "malformed.html"),
    /malformed batch review protocol/i
  );
  const malformedWithoutV1Data = malformed.replace(
    /<script\b[^>]*\bid=["']batchData["'][^>]*>[\s\S]*?<\/script>/i,
    ""
  );
  assert.throws(
    () => needsLegacyBatchLineReviewUpgrade(malformedWithoutV1Data),
    /malformed batch review protocol/i
  );
});

await test("folder-review migration parses one validated batchData contract", () => {
  const current = renderBatchLineReviewIndexHtml({
    title: "validated batch data",
    files: [{
      sourceName: "scene.txt",
      sourcePath: "G:/project/source/scene.txt",
      outputPath: "batch/scene.html",
      status: "matched",
      sourceLineCount: 2
    }]
  });
  assert.deepEqual(embeddedBatchLineReviewFiles(current)?.map((file) => file.outputPath), ["batch/scene.html"]);
  const malformedJson = current.replace(
    /(<script id="batchData" type="application\/json">)[\s\S]*?(<\/script>)/i,
    "$1{not-json$2"
  );
  assert.throws(() => embeddedBatchLineReviewFiles(malformedJson), /batch review data is not valid JSON/i);
});

await test("needsLegacyLineReviewUpgrade flags HTML missing agent artifact panel", () => {
  const stub = `<!doctype html><html lang="zh-CN"><body class="line-review"><script id="reviewData" type="application/json">${JSON.stringify({
    rows: [{ source: "a", translation: "甲" }],
    pageSize: 1000,
    startPage: 1,
    workflow: { paths: { outputDir: "G:/proj", sourcePath: "G:/proj/source.txt" } }
  })}</script><script>promptSettingsVersion = 8; lineFromLocationHash(); createAgentTerminal(); writeAgentConsoleInput(); glossaryTermKey(); boundPromptTranslationPath(); lineReviewStorageKey(); restoringPosition = true; searchMatches = needle ? data.rows.filter; .row.match .cell; id="glossarySearch"; glossaryRenderBatchSize; reviewFormatFallback; id="lanSyncPin"; id="generateReviewHtml"; id="callAgent"; id="collapseAgentPanel"; id="promptSettingsPanel"; id="startLanSync"; id="importGlossary"; glossarySyncMissingTarget; sourceCount <= targetCount; Output language: write all report prose in the target language</script></body></html>`;
  assert.equal(needsLegacyLineReviewUpgrade(stub), true);
});

await test("upgradeLegacyLineReviewHtmlContent injects agent artifacts and lineReviewPath", () => {
  const sourceFilePath = "G:/proj/.translation-workshop/html/line-review-old.html";
  const stub = `<!doctype html><html lang="zh-CN"><head><title>old review</title></head><body class="anime-workbench line-review"><script id="reviewData" type="application/json">${JSON.stringify({
    rows: [
      { line: 1, source: "原文", translation: "" },
      { line: 2, source: "第二行", translation: "draft" }
    ],
    pageSize: 1000,
    startPage: 1,
    labels: { source: "原文", translation: "译文" },
    workflow: {
      paths: {
        outputDir: "G:/proj",
        sourcePath: "G:/proj/source.txt",
        sourceKind: "file",
        promptSourcePath: "G:/proj/.translation-workshop/extracted/source.txt",
        promptTranslationPath: "G:/proj/.translation-workshop/extracted/translation.txt",
        translationPath: ""
      },
      glossaryEntries: []
    }
  })}</script><script>promptSettingsVersion = 8; lineFromLocationHash(); createAgentTerminal(); writeAgentConsoleInput(); glossaryTermKey(); boundPromptTranslationPath(); lineReviewStorageKey(); restoringPosition = true; searchMatches = needle ? data.rows.filter; .row.match .cell; id="glossarySearch"; glossaryRenderBatchSize; reviewFormatFallback; id="lanSyncPin"; id="generateReviewHtml"; id="callAgent"; id="collapseAgentPanel"; id="promptSettingsPanel"; id="startLanSync"; id="importGlossary"; glossarySyncMissingTarget; sourceCount <= targetCount; Output language: write all report prose in the target language</script></body></html>`;
  const upgraded = upgradeLegacyLineReviewHtmlContent(stub, "line-review-old.html", sourceFilePath);
  assert.ok(upgraded, "expected upgraded HTML");
  assert.match(upgraded, /id="agentArtifactsPanel"/);
  assert.match(upgraded, /discoverAgentArtifacts/);
  assert.match(upgraded, /function openLineRepair/);
  assert.match(upgraded, /importArtifactAsDraft/);
  assert.doesNotMatch(upgraded, /applyLineReviewState/);
  assert.match(upgraded, /"lineReviewPath":"G:[\\/]+proj[\\/]+.translation-workshop[\\/]+html[\\/]+line-review-old\.html"/);
  assert.match(upgraded, /"promptSourcePath":"G:\/proj\/.translation-workshop\/extracted\/source\.txt"/);
  assert.match(upgraded, /"promptTranslationPath":"G:\/proj\/.translation-workshop\/extracted\/translation\.txt"/);
  assert.match(upgraded, /"sourceKind":"file"/);
  assert.match(upgraded, /"importAsDraft":"导入为译文草稿"/);
});

await test("needsLegacyLineReviewUpgrade when exportTxt exists but saveTxt button is missing", () => {
  const stub = `<!doctype html><html lang="zh-CN"><body class="line-review"><button id="exportTxt"></button><script id="reviewData" type="application/json">${JSON.stringify({
    rows: [{ source: "a", translation: "" }],
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } }
  })}</script><script>promptSettingsVersion = 8; lineFromLocationHash(); createAgentTerminal(); writeAgentConsoleInput(); glossaryTermKey(); boundPromptTranslationPath(); lineReviewStorageKey(); restoringPosition = true; searchMatches = needle ? data.rows.filter; .row.match .cell; id="glossarySearch"; glossaryRenderBatchSize; reviewFormatFallback; id="lanSyncPin"; id="generateReviewHtml"; id="callAgent"; id="collapseAgentPanel"; id="promptSettingsPanel"; id="startLanSync"; id="importGlossary"; glossarySyncMissingTarget; sourceCount <= targetCount; Output language: write all report prose in the target language; id="agentArtifactsPanel"; discoverAgentArtifacts; artifactValidations; function openLineRepair; importArtifactAsDraft; "lineReviewPath":"G:/proj/html/x.html"; function updateSaveTxtVisibility; document.getElementById("saveTxt")</script></body></html>`;
  assert.equal(needsLegacyLineReviewUpgrade(stub.replace('id="saveTxt"', "saveTxtMissing")), true);
});

await test("upgrade injects saveTxt button for txt sources", () => {
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    `<!doctype html><html lang="zh-CN"><head><title>t</title></head><body class="anime-workbench line-review"><button id="exportTxt"></button><script id="reviewData" type="application/json">${JSON.stringify({
      rows: [{ line: 1, source: "a", translation: "" }],
      workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj", translationPath: "" } }
    })}</script><script>promptSettingsVersion = 8; lineFromLocationHash(); createAgentTerminal(); writeAgentConsoleInput(); glossaryTermKey(); boundPromptTranslationPath(); lineReviewStorageKey(); restoringPosition = true; searchMatches = needle ? data.rows.filter; .row.match .cell; id="glossarySearch"; glossaryRenderBatchSize; reviewFormatFallback; id="lanSyncPin"; id="generateReviewHtml"; id="callAgent"; id="collapseAgentPanel"; id="promptSettingsPanel"; id="startLanSync"; id="importGlossary"; glossarySyncMissingTarget; sourceCount <= targetCount; Output language: write all report prose in the target language</script></body></html>`,
    "line-review-old.html",
    "G:/proj/.translation-workshop/html/line-review-old.html"
  );
  assert.ok(upgraded);
  assert.match(upgraded, /id="saveTxt"/);
  assert.match(upgraded, /function ensureSaveTxtButton/);
});

await test("app-open upgrade uses the explicit line-review protocol marker", async () => {
  const { LINE_REVIEW_PROTOCOL_MARKER, LINE_REVIEW_PROTOCOL_VERSION, renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderLineReviewHtml({
    title: "old agent dock",
    sourceText: "a\n",
    translationText: "",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  assert.equal(needsLegacyLineReviewUpgrade(html), false);
  assert.match(html, new RegExp(LINE_REVIEW_PROTOCOL_MARKER));
  const previousMarker = `translation-workshop-line-review-v${LINE_REVIEW_PROTOCOL_VERSION - 1}`;
  assert.equal(needsLegacyLineReviewUpgrade(html.replace(LINE_REVIEW_PROTOCOL_MARKER, previousMarker)), true);
  assert.equal(needsLegacyLineReviewUpgrade(html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v16")), true);
  assert.equal(needsLegacyLineReviewUpgrade("<!doctype html><p>not a line review</p>"), false);
});

await test("new line-review HTML does not materialize an unset subagent count", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderLineReviewHtml({
    title: "unset child ceiling",
    sourceText: "a\n",
    translationText: "",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(payload);
  const workflow = JSON.parse(payload).workflow;
  assert.equal(Object.hasOwn(workflow.promptDefaults, "subagentCount"), false);
  assert.equal(Object.hasOwn(workflow.promptDefaults, "reviewSubagentCount"), false);
  assert.doesNotMatch(workflow.prompts.translate, /maximum=2/);
  assert.doesNotMatch(workflow.prompts.proofread, /maximum=2/);
});

await test("v16 line-review upgrade preserves advanced proofreading and subagent settings", async () => {
  const { LINE_REVIEW_PROTOCOL_MARKER, renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const advanced = {
    languagePair: "en->zh-CN",
    splitSize: 777,
    proofreadMode: "montecarlo",
    montecarloSize: 123,
    montecarloRoundMin: 3,
    montecarloRoundMax: 6,
    subagentEnabled: true,
    subagentCount: 4
  };
  const current = renderLineReviewHtml({
    title: "advanced migration",
    sourceText: "a\n",
    translationText: "b\n",
    workflow: {
      paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" },
      advanced
    },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    current.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v16"),
    "line-review-test.html",
    "G:/proj/html/line-review-test.html"
  );
  assert.ok(upgraded);
  const payload = upgraded.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(payload);
  assert.deepEqual(JSON.parse(payload).workflow.advanced, advanced);
});

await test("line-review upgrades an old Agent embed even when its page marker is current", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const { agentChatFlowVersion } = await import("../../src/shared/core/agentChatEmbed.ts");
  const current = renderLineReviewHtml({
    title: "line-review Agent protocol round trip",
    sourceText: "a\n",
    translationText: "b\n",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  assert.equal(needsLegacyLineReviewUpgrade(current), false);
  const oldEmbed = current.replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v3");
  assert.equal(needsLegacyLineReviewUpgrade(oldEmbed), true);
  const oldPromptSettings = current.replace(
    `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
    `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
  );
  assert.equal(needsLegacyLineReviewUpgrade(oldPromptSettings), true);
});

await test("line-review upgrades the previous v6 embed after EPUB route hardening", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderLineReviewHtml({
    title: "line-review previous Agent protocol",
    sourceText: "a\n",
    translationText: "b\n",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const previousV6 = current.replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v6");
  assert.equal(needsLegacyLineReviewUpgrade(previousV6), true);
});

await test("line-review upgrades v8 embeds that do not carry the UI locale", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderLineReviewHtml({
    title: "line-review locale route",
    locale: "en-US",
    sourceText: "a\n",
    translationText: "b\n",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const previousV8 = current.replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v8");
  assert.equal(needsLegacyLineReviewUpgrade(previousV8), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    previousV8,
    "line-review-test.html",
    "G:/proj/html/line-review-test.html"
  );
  assert.ok(upgraded);
  assert.match(upgraded, new RegExp(agentChatFlowVersion));
  assert.match(upgraded, /"locale":"en-US"/);
});

await test("line-review upgrades v9 embeds that retain stale generated-prompt metadata", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const { agentChatFlowVersion } = await import("../../src/shared/core/agentChatEmbed.ts");
  const current = renderLineReviewHtml({
    title: "line-review generated prompt replacement",
    sourceText: "a\nb\n",
    translationText: "\n\n",
    workflow: {
      paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" },
      advanced: { subagentEnabled: true, subagentCount: 8 }
    },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const previousV9 = current.replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v9");
  assert.equal(needsLegacyLineReviewUpgrade(previousV9), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    previousV9,
    "line-review-test.html",
    "G:/proj/html/line-review-test.html"
  );
  assert.ok(upgraded);
  assert.match(upgraded, new RegExp(agentChatFlowVersion));
  assert.match(upgraded, /replaceText\(promptText,\s*workflowMetadata\)/);
});

await test("line-review upgrades v7 children whose Agent route drops the folder prompt kind", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const { agentChatFlowVersion } = await import("../../src/shared/core/agentChatEmbed.ts");
  const current = renderLineReviewHtml({
    title: "folder child Agent route",
    sourceText: "a\n",
    translationText: "",
    workflow: {
      sourcePath: "G:/project/source/scene.txt",
      sourceKind: "file",
      sourcePromptPath: "G:/project/source",
      promptSourceKind: "folder",
      outputDir: "G:/project"
    },
    lineReviewPath: "G:/project/html/batch/scene.html"
  });
  const staleV7 = current.replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v7");
  assert.equal(needsLegacyLineReviewUpgrade(staleV7), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    staleV7,
    "scene.html",
    "G:/project/html/batch/scene.html"
  );
  assert.ok(upgraded);
  assert.match(upgraded, /paths\.promptSourceKind === "folder"/);
  assert.match(upgraded, /"promptSourceKind":"folder"/);
});

await test("toy line-review HTML without the current protocol marker triggers upgrade", async () => {
  const { LINE_REVIEW_PROTOCOL_MARKER } = await import("../../src/shared/core/html.ts");
  let html = readFileSync(toyHtml, "utf8");
  assert.match(html, /id="exportTxt"/);
  html = html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-legacy");
  assert.equal(needsLegacyLineReviewUpgrade(html), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(html, "line-review-source.html", toyHtml);
  assert.ok(upgraded);
  assert.match(upgraded, /id="saveTxt"/);
  assert.match(upgraded, /function ensureSaveTxtButton/);
});

await test("renderLineReviewHtml inline script is valid JavaScript", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderLineReviewHtml({
    title: "syntax test",
    sourceText: "一行\n二行\n",
    translationText: "",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const match = html.match(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, "expected inline line-review script");
  assert.doesNotThrow(() => new Function(match[1]), "line-review script must parse");
  assert.doesNotMatch(html, /id="agentSelect"/);
  assert.match(html, /id="agentChatSettingsGlobal"/);
  assert.match(html, new RegExp(`data-agent-chat-flow="${agentChatFlowVersion}"`));
  assert.match(html, new RegExp(`promptSettingsVersion = ${PROMPT_SETTINGS_VERSION}`));
  assert.match(html, new RegExp(`translation-workshop-prompt-settings.*content="${PROMPT_SETTINGS_VERSION}"`));
  assert.match(html, /id="promptGlossaryCandidates"/);
  assert.match(html, /id="promptCharacterBible"/);
  assert.match(html, /id="promptReuseExistingTranslation"/);
  assert.match(html, /reuseExistingTranslation:\s*defaults\.reuseExistingTranslation === true/);
  assert.match(html, /reuseExistingTranslation:\s*promptReuseExistingTranslation\?\.checked === true/);
  assert.match(html, /reuseExistingTranslation:\s*settings\.reuseExistingTranslation/);
  assert.match(html, /setFieldChecked\(promptReuseExistingTranslation, settings\.reuseExistingTranslation\)/);
  assert.match(html, /id="promptLanguagePair"/);
  assert.match(html, /id="resetPromptSettings"/);
  assert.match(html, /function promptFactoryDefaults/);
  assert.match(html, /function resetPromptSettings/);
  assert.match(html, /await writeStoredPromptSettings\(promptFactoryDefaults\(\)\)/);
  assert.match(html, /Default parameters restored/);
  assert.match(html, /languagePair:\s*promptLanguagePair\?\.value\.trim\(\)\s*\|\|\s*defaults\.languagePair/);
  assert.match(html, /setFieldValue\(promptLanguagePair, settings\.languagePair\)/);
  assert.match(html, /readProjectState/);
  assert.match(html, /readProjectAssets/);
  assert.match(html, /syncGlossaryFromText\(JSON\.stringify\(assets\?\.glossary/);
  assert.match(html, /onProjectStateUpdate/);
  assert.match(html, /await persistProjectState\(settings\)/);
  assert.ok(
    html.indexOf("await writeStoredPromptSettings(settings)") < html.indexOf("generated = await bridge.buildPrompt"),
    "prompt generation must wait for project settings to reach durable storage"
  );
  assert.match(
    html,
    /if \(!bridge\?\.buildPrompt\) \{[\s\S]*?promptGenerationFailed[\s\S]*?return;[\s\S]*?\}/,
    "project prompt generation must stop when the Electron prompt bridge is unavailable"
  );
  assert.match(
    html,
    /catch \(error\) \{\s*setAiStatus\(\(data\.labels\.promptGenerationFailed[\s\S]*?\);\s*return;\s*\}/,
    "project prompt generation must stop after a bridge failure"
  );
  assert.doesNotMatch(
    html,
    /if \(!generated\) \{\s*generated = activeAgentPrompts\(\)\[activePromptKind\]/,
    "a failed durable prompt build must not fall back to stale embedded prompt text"
  );
  assert.match(html, /importProjectGlossaryFile/);
  assert.match(html, /replaceProjectGlossary/);
  assert.match(html, /updateProjectGlossaryEntry/);
  assert.match(html, /onProjectAssetsUpdate/);
  assert.match(html, /const style = String\(value\.style \|\| ""\)\.trim\(\)/);
  assert.match(html, /const workDescription = String\(value\.workDescription \|\| ""\)\.trim\(\)/);
  assert.match(html, /\.\.\.\(style \? \{ style \} : \{\}\)/);
  assert.match(html, /\.\.\.\(workDescription \? \{ workDescription \} : \{\}\)/);
  assert.match(html, /function syncGlossaryFromText\(text, label, allowEmpty = false\)/);
  assert.match(html, /input\.value = previousTarget;[\s\S]*glossaryWriteFailed/);
  assert.doesNotMatch(html, /writeGlossaryFile/);
  assert.doesNotMatch(html, /files:writeGlossaryFile/);
  assert.doesNotMatch(html, /prompt-settings-v3/);
  assert.doesNotMatch(html, /localStorage\.setItem\(promptSettingsStorageKey/);
  assert.doesNotMatch(html, /state\.glossaryEntries\s*(?:=|\|\|)/);
  assert.doesNotMatch(html, /state\.glossaryTargets\s*(?:=|\|\|)/);
  assert.doesNotMatch(html, /state\.glossaryAliases\s*(?:=|\|\|)/);
  assert.doesNotMatch(html, /state\.glossaryPath\s*(?:=|\|\|)/);
  assert.match(html, /delete state\.glossaryEntries/);
  assert.match(html, /delete state\.glossaryPath/);
  assert.match(html, /id="promptSubagent"/);
  assert.match(html, /id="promptSubagentCount"/);
  assert.match(html, /id="promptReviewSubagentCount"/);
  assert.match(html, /\u8ddf\u968f\u7ffb\u8bd1 Agent \u6570\u91cf/);
  assert.match(html, /reviewSubagentCount:\s*optionalPositivePromptNumber\(defaults\.reviewSubagentCount\)/);
  assert.match(html, /reviewSubagentCount:\s*optionalPositivePromptNumber\(promptReviewSubagentCount\?\.value\) \?\? null/);
  assert.match(html, /setFieldValue\(promptReviewSubagentCount, settings\.reviewSubagentCount\)/);
  assert.doesNotMatch(html, /defaults\.reviewSubagentCount \?\? defaults\.subagentCount/);
  assert.doesNotMatch(html, /settings\.reviewSubagentCount \|\| settings\.subagentCount/);
  assert.match(html, /id="promptCustomPreserveRules"/);
  assert.match(html, /id="addPromptCustomPreserveRule"/);
  assert.match(html, /function renderPromptCustomPreserveRules/);
  assert.match(html, /customPreserveRules:\s*readPromptCustomPreserveRules\(\)/);
  assert.match(html, /setPromptCustomPreserveRules\(settings\.customPreserveRules\)/);
  assert.match(html, /customPreserveRules:\s*settings\.customPreserveRules/);
  assert.match(html, /Workflow prompt metadata customPreserveRules/);
  assert.ok(
    html.indexOf("await writeStoredPromptSettings(settings)") < html.indexOf("generated = await bridge.buildPrompt"),
    "custom preserve rules must reach durable project storage before prompt generation"
  );
  assert.match(
    html,
    /if \(separator <= 0 \|\| separator === value\.length - 1\) return \{\s*subagentProviderId: "",\s*subagentModelId: ""\s*\};/,
    "choosing Follow main Agent must explicitly clear a persisted subagent model override"
  );
  assert.match(html, /agent-global-controls/);
  assert.doesNotMatch(html, /id="agentChatProvider"/);
  assert.doesNotMatch(html, /id="agentChatModelSelect"/);
  assert.doesNotMatch(html, /id="agentChatProviderBadge"/);
  assert.doesNotMatch(html, /agent-chat-model-row/);
  assert.doesNotMatch(html, /id="agentChatSettings"/);
  assert.doesNotMatch(html, /agentChatSkillLoaded|data-kind="skill"|skill\.loaded/i);
  assert.doesNotMatch(html, /toolPreset|Tool preset|tool preset/);
  assert.doesNotMatch(html, />Codex</);
  assert.doesNotMatch(html, /Claude Code/);
});

await test("prompt reset embeds product defaults without losing the current folder manifest", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderLineReviewHtml({
    title: "prompt reset defaults",
    sourceText: "source",
    translationText: "translation",
    workflow: {
      sourcePath: "G:/proj/source",
      sourcePromptPath: "G:/proj/source",
      sourceKind: "file",
      promptSourceKind: "folder",
      outputDir: "G:/proj",
      advanced: {
        languagePair: "en->fr",
        style: "legal",
        split: false,
        splitSize: 77,
        glossaryCandidates: false,
        characterBible: false,
        reuseExistingTranslation: true,
        workDescription: "custom",
        translateOutputDir: "G:/custom/translations",
        proofreadOutputDir: "G:/custom/reports",
        proofreadMode: "montecarlo",
        candidateRatio: 9,
        montecarloSize: 42,
        montecarloRoundMin: 7,
        montecarloRoundMax: 8,
        subagentEnabled: false,
        subagentCount: 6,
        reviewSubagentCount: 4,
        subagentProviderId: "provider",
        subagentModelId: "model",
        folderTranslationOrder: '"b.txt"\n"a.txt"',
        folderSourceDocuments: [
          { id: "b.txt", path: "G:/proj/source/b.txt" },
          { id: "a.txt", path: "G:/proj/source/a.txt" }
        ],
        customPreserveRules: [{ pattern: "^prefix", flags: "u" }]
      }
    },
    lineReviewPath: "G:/proj/review.html"
  });
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(payload, "generated line-review HTML must contain reviewData");
  const reviewData = JSON.parse(payload);
  assert.equal(reviewData.workflow.promptDefaults.languagePair, "en->fr");
  assert.deepEqual(reviewData.workflow.factoryPromptDefaults, {
    languagePair: "ja->zh-CN",
    style: "game",
    split: true,
    splitSize: 1000,
    glossaryCandidates: true,
    characterBible: true,
    reuseExistingTranslation: false,
    workDescription: "",
    translateOutputDir: "G:/proj/AI_translation",
    proofreadOutputDir: "G:/proj/report",
    proofreadMode: "split",
    candidateRatio: 1.5,
    montecarloSize: 3000,
    montecarloRoundMin: 2,
    montecarloRoundMax: 5,
    subagentEnabled: true,
    folderSourceDocuments: [
      { id: "b.txt", path: "G:/proj/source/b.txt" },
      { id: "a.txt", path: "G:/proj/source/a.txt" }
    ],
    subagentProviderId: "",
    subagentModelId: "",
    folderTranslationOrder: "",
    customPreserveRules: []
  });
  assert.match(html, /defaultFolderTranslationOrder\(defaults\.folderSourceDocuments\)/);
  assert.match(html, /documentIds\.map\(\(documentId\) => JSON\.stringify\(documentId\)\)/);
  assert.match(html, /subagentCount:\s*null/);
  assert.match(html, /reviewSubagentCount:\s*null/);
});

await test("line review upgrades prompt settings that predate the editable language pair", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderLineReviewHtml({
    title: "language pair upgrade",
    sourceText: "source",
    translationText: "",
    workflow: {
      sourcePath: "G:/proj/source.txt",
      outputDir: "G:/proj",
      advanced: { languagePair: "en->zh-CN" }
    },
    lineReviewPath: "G:/proj/html/line-review-language.html"
  });
  const previous = current.replace(
    `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
    `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
  );
  assert.equal(needsLegacyLineReviewUpgrade(previous), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(previous, "line-review-language.html", "G:/proj/html/line-review-language.html");
  assert.ok(upgraded);
  assert.match(upgraded, /id="promptLanguagePair"/);
  assert.match(upgraded, /"languagePair":"en->zh-CN"/);
});

await test("v31 line review without the review Agent count upgrades to the current prompt form", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderLineReviewHtml({
    title: "review worker count upgrade",
    sourceText: "source",
    translationText: "",
    workflow: {
      sourcePath: "G:/proj/source.txt",
      outputDir: "G:/proj",
      advanced: { subagentCount: 3 }
    },
    lineReviewPath: "G:/proj/html/line-review-review-workers.html"
  });
  const v31 = current
    .replace(
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
      'name="translation-workshop-prompt-settings" content="31"'
    )
    .replace(/\s*<label id="promptReviewSubagentCountField">[\s\S]*?<\/label>/, "");

  assert.doesNotMatch(v31, /id="promptReviewSubagentCount"/);
  assert.equal(needsLegacyLineReviewUpgrade(v31), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    v31,
    "line-review-review-workers.html",
    "G:/proj/html/line-review-review-workers.html"
  );
  assert.ok(upgraded);
  assert.match(upgraded, /id="promptReviewSubagentCount"/);
  assert.match(upgraded, /\u5ba1\u9605 Agent \u6570\u91cf/);
});

await test("v33 line review with prompt fallback upgrades to the fail-fast bridge contract", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderLineReviewHtml({
    title: "prompt bridge upgrade",
    sourceText: "source",
    translationText: "",
    workflow: {
      sourcePath: "G:/proj/source.txt",
      outputDir: "G:/proj"
    },
    lineReviewPath: "G:/proj/html/line-review-prompt-bridge.html"
  });
  const v33 = current.replace(
    `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
    'name="translation-workshop-prompt-settings" content="33"'
  );
  assert.equal(needsLegacyLineReviewUpgrade(v33), true);
  const upgraded = upgradeLegacyLineReviewHtmlContent(
    v33,
    "line-review-prompt-bridge.html",
    "G:/proj/html/line-review-prompt-bridge.html"
  );
  assert.ok(upgraded);
  assert.match(upgraded, /if \(!bridge\?\.buildPrompt\)/);
  assert.doesNotMatch(upgraded, /generated = activeAgentPrompts\(\)\[activePromptKind\]/);
});

await test("renderLineReviewHtml binds imported TXT candidates for later Save TXT", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderLineReviewHtml({
    title: "agent import binding",
    sourceText: "一行\n二行\n",
    translationText: "",
    workflow: { paths: { sourcePath: "G:/proj/source.txt", outputDir: "G:/proj" } },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const match = html.match(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, "expected inline line-review script");
  assert.match(
    match[1],
    /async function importArtifactAsDraft\(candidatePath, sourcePath\)[\s\S]*canonicalEditablePath[\s\S]*setBoundTranslationPath\(canonicalEditablePath \|\| candidatePath, canonicalEditablePath \|\| candidatePath\)/
  );
});

await test("EPUB Agent route binds extracted text paths instead of binary EPUB paths", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const { agentChatRouteFromReviewData } = await import("../../src/shared/core/agentChatRoute.ts");
  const html = renderLineReviewHtml({
    title: "epub agent source",
    sourceText: "source line",
    translationText: "translated line",
    workflow: {
      sourcePath: "G:/proj/book.epub",
      translationPath: "G:/proj/translated.epub",
      sourcePromptPath: "G:/proj/.translation-workshop/extracted/book-source.txt",
      translationPromptPath: "G:/proj/.translation-workshop/extracted/book-translation.txt",
      outputDir: "G:/proj"
    }
  });
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(payload, "generated line-review HTML must contain reviewData");
  const reviewData = JSON.parse(payload);
  const route = agentChatRouteFromReviewData(reviewData, "G:/proj/review.html");
  assert.equal(route.sourcePath, "G:/proj/.translation-workshop/extracted/book-source.txt");
  assert.equal(route.translationPath, "G:/proj/.translation-workshop/extracted/book-translation.txt");
  assert.equal(route.sourceKind, "file");
  assert.equal(route.lineReviewPath, "G:/proj/review.html");
  assert.notEqual(route.sourcePath, "G:/proj/book.epub");
  assert.notEqual(route.translationPath, "G:/proj/translated.epub");

  const incompleteLegacyRoute = agentChatRouteFromReviewData({
    workflow: {
      paths: {
        outputDir: "G:/proj",
        promptSourcePath: "G:/proj/prompt-source.epub",
        promptTranslationPath: "G:/proj/prompt-translation.epub",
        sourcePath: "G:/proj/book.epub",
        translationPath: "G:/proj/translated.epub"
      }
    }
  });
  assert.equal(incompleteLegacyRoute.sourcePath, undefined);
  assert.equal(incompleteLegacyRoute.translationPath, undefined);
});

await test("EPUB Agent artifacts bind the extracted line source instead of the binary EPUB", async () => {
  const { LINE_REVIEW_PROTOCOL_MARKER, renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const { upgradeLegacyLineReviewHtmlContent } = await import("../../src/shared/core/legacyHtml.ts");
  const extractedSourcePath = "G:/proj/.translation-workshop/extracted/book-source.txt";
  const html = renderLineReviewHtml({
    title: "epub artifact source",
    sourceText: "source line",
    translationText: "",
    workflow: {
      sourcePath: "G:/proj/book.epub",
      sourcePromptPath: extractedSourcePath,
      validationSourcePath: extractedSourcePath,
      outputDir: "G:/proj"
    }
  });
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(payload, "generated line-review HTML must contain reviewData");
  const reviewData = JSON.parse(payload);
  assert.equal(reviewData.workflow.paths.validationSourcePath, extractedSourcePath);
  assert.match(
    html,
    /const sourcePath = workflow\.paths\?\.validationSourcePath \|\| workflow\.paths\?\.sourcePath \|\| "";/
  );

  const legacy = html
    .replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v15")
    .replace(`"validationSourcePath":"${extractedSourcePath}",`, "");
  const upgraded = upgradeLegacyLineReviewHtmlContent(legacy, "epub artifact source", "G:/proj/review.html");
  assert.ok(upgraded, "v15 EPUB line review must be upgraded");
  const upgradedPayload = upgraded.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(upgradedPayload, "upgraded EPUB line review must contain reviewData");
  assert.equal(JSON.parse(upgradedPayload).workflow.paths.validationSourcePath, extractedSourcePath);
});

await test("EPUB line review keeps EPUB export and writes edits to its canonical extracted translation TXT", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const editableTranslationPath = "G:/proj/.translation-workshop/extracted-text/book/translation/book.txt";
  const html = renderLineReviewHtml({
    title: "epub editable translation",
    sourceText: "source line",
    translationText: "translated line",
    workflow: {
      sourcePath: "G:/proj/book.epub",
      validationSourcePath: "G:/proj/.translation-workshop/extracted-text/book/source/book.txt",
      editableTranslationPath,
      translationPromptPath: editableTranslationPath,
      outputDir: "G:/proj",
      epubExport: { mode: "all" }
    }
  });
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(payload);
  assert.equal(JSON.parse(payload).workflow.paths.editableTranslationPath, editableTranslationPath);
  assert.match(html, /id="exportEpub"/);
  assert.match(html, /id="saveTxt"/);
  assert.match(html, /function boundTranslationPath\(\) \{[\s\S]*editableTranslationPath/);
  assert.doesNotMatch(html, /function canWriteBoundTxt\(\) \{\s*if \(sourceIsEpubDocument\(\)\) return false;/);
});

await test("line-review glossary drawer detects and imports generated workspace candidates", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderLineReviewHtml({
    title: "generated glossary import",
    sourceText: "勇者",
    translationText: "勇者",
    workflow: {
      sourcePath: "G:/proj/source.txt",
      translationPath: "G:/proj/translation.txt",
      outputDir: "G:/proj"
    }
  });
  assert.match(html, /id="importGeneratedGlossary"/);
  assert.match(html, /readWorkspaceAssetsStatus/);
  assert.match(html, /importGeneratedGlossaryCandidates/);
  assert.match(html, /actions\?\.importGlossaryCandidates/);
});

await test("line-review Agent entry opens embedded HTML dock and same-state popout", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const { agentChatRouteFromReviewData } = await import("../../src/shared/core/agentChatRoute.ts");
  const html = renderLineReviewHtml({
    title: "agent window",
    sourceText: "一行\n",
    translationText: "",
    workflow: {
      sourcePath: "G:/proj/source.txt",
      outputDir: "G:/proj",
      advanced: { languagePair: "en->zh-CN" }
    },
    lineReviewPath: "G:/proj/html/line-review-test.html"
  });
  const match = html.match(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, "expected inline line-review script");
  assert.match(match[1], /async function openEmbeddedPopout\(\)/);
  assert.match(match[1], /window\.__ynAgentChatPiWebEmbedded/);
  assert.match(match[1], /agentChatEmbeddedEntryUrl/);
  assert.match(match[1], /YnPiWebAgentEmbedded\.mount/);
  assert.match(match[1], /openAgentChatWindow\(route\)/);
  assert.match(match[1], /insertIntoAgentInput/);
  assert.match(html, new RegExp(LINE_REVIEW_PROTOCOL_MARKER));
  assert.match(match[1], /publishAgentInterfaceContext/);
  assert.match(match[1], /visibleLineRange\(\)/);
  assert.match(match[1], /rowsEl\.addEventListener\("contextmenu"/);
  assert.match(match[1], /请读取我刚刚在当前 YN 页面选中的行/);
  assert.match(html, /发送选中原文给 Agent/);
  assert.match(match[1], /sourceSelectionText\(source\)/);
  assert.match(match[1], /selectionRange\.intersectsNode\(sourceElement\)/);
  assert.match(match[1], /sourceRange\.setStart\(selectionRange\.startContainer, selectionRange\.startOffset\)/);
  assert.match(match[1], /sourceRange\.setEnd\(selectionRange\.endContainer, selectionRange\.endOffset\)/);
  assert.match(match[1], /主动选择的原文片段/);
  assert.doesNotMatch(match[1], /原文：" \+ row\.source/);
  assert.match(match[1], /embedded\.insertText\(prompt\)/);
  assert.match(html, /onLanSyncCommand\?\.\(applyRemoteLanSyncCommand\)/);
  assert.match(html, /function applyRemoteLanSyncCommand\(payload\)[\s\S]*__ynAgentChatPiWebEmbedded\?\.open\?\.\(\)/);
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(payload, "generated line-review HTML must contain reviewData");
  const route = agentChatRouteFromReviewData(JSON.parse(payload), "G:/proj/html/line-review-test.html");
  assert.equal(route.locale, "zh-CN");
  assert.equal(route.languagePair, "en->zh-CN");
  assert.equal(route.sourcePath, "G:/proj/source.txt");
  assert.match(match[1], /workflowIntent:\s*activePromptKind === "proofread" \? "proofread" : "translation"/);
  assert.match(match[1], /const settings = currentPromptSettings\(\);[\s\S]*languagePair:\s*settings\.languagePair/);
  assert.doesNotMatch(match[1], /dataset\.ynWorkflowIntent|querySelector\("#agentChatReactRoot textarea"\)/);
  assert.match(match[1], /isDocked\(\) && !document\.body\.classList\.contains\("agent-chat-popout"\)/);
  assert.match(match[1], /agentChatPopout"\)\?\.addEventListener\("click", \(\) => \{ void openEmbeddedPopout\(\); \}\)/);
  assert.match(match[1], /if \(String\(location\.hash \|\| ""\)\.includes\("agent-chat"\)\) setPopoutMode\(true\)/);
  assert.doesNotMatch(match[1], /agentChatOpenReactWindow/);
});

await test("proposal review Agent entry opens embedded HTML dock and same-state popout", async () => {
  const { renderProposalReviewHtml } = await import("../../src/shared/core/html.ts");
  const html = renderProposalReviewHtml({
    title: "proposal agent window",
    outputDir: "G:/proj",
    lineReviewPath: "G:/proj/html/line-review-test.html",
    proposals: [{
      id: "H3-001",
      line: 1,
      src: "原文",
      current: "旧译文",
      oldText: "旧译文",
      baseRevision: 1,
      problemType: "H3 terminology",
      problem: "术语不一致",
      suggestion: "新译文",
      status: "unreviewed"
    }]
  });
  assert.match(html, /id="openAgentChat"/);
  assert.match(html, /onLanSyncCommand\?\.\(applyRemoteLanSyncCommand\)/);
  assert.match(html, /function applyRemoteLanSyncCommand\(payload\)[\s\S]*__ynAgentChatPiWebEmbedded\?\.open\?\.\(\)/);
  assert.match(html, /id="agentChatReactRoot"/);
  assert.match(html, new RegExp(`data-agent-chat-flow="${agentChatFlowVersion}"`));
  assert.match(html, /id="proposalData"[\s\S]*"outputDir":"G:\/proj"/);
  const match = html.match(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, "expected inline proposal script");
  assert.match(match[1], /async function openEmbeddedPopout\(\)/);
  assert.match(match[1], /document\.getElementById\("reviewData"\) \|\| document\.getElementById\("proposalData"\)/);
  assert.match(match[1], /agentChatEmbeddedEntryUrl/);
  assert.match(match[1], /YnPiWebAgentEmbedded\.mount/);
});

await test("proposal review upgrades old embed protocol but not the current locale-aware embed", async () => {
  const { renderProposalReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderProposalReviewHtml({
    title: "proposal protocol round trip",
    proposals: [{ id: "p1", line: 1, src: "a", current: "b", problem: "c", suggestion: "d", status: "pending" }],
    workflow: { outputDir: "C:/project", sourcePath: "C:/project/source.txt", translationPath: "C:/project/translation.txt" }
  });
  assert.equal(needsLegacyLineReviewUpgrade(current), false, "proposal HTML must never enter the line-review migrator");
  assert.equal(needsLegacyProposalReviewUpgrade(current), false);
  const previousProposalProtocol = current.replace(/<meta name="translation-workshop-proposal-review"[^>]*>\s*/, "");
  assert.equal(needsLegacyProposalReviewUpgrade(previousProposalProtocol), true);
  const oldV6 = current.replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v6");
  assert.equal(needsLegacyProposalReviewUpgrade(oldV6), true);
});

await test("proposal review migration preserves aggregate document routing and project ownership", async () => {
  const { renderProposalReviewHtml } = await import("../../src/shared/core/html.ts");
  const current = renderProposalReviewHtml({
    title: "folder aggregate migration",
    outputDir: "G:/project",
    reportPath: "G:/project/report/folder.proofread.json",
    lineReviewPath: "G:/project/.translation-workshop/html/folder.html",
    proposals: [{
      id: "H1-001",
      documentId: "nested/chapter.txt",
      sourcePath: "G:/project/source/nested/chapter.txt",
      translationPath: "G:/project/AI_translation/nested/chapter_translated.txt",
      line: 7,
      src: "source",
      current: "current",
      oldText: "current",
      baseRevision: 3,
      problemType: "H1 accuracy",
      problem: "problem",
      suggestion: "suggestion",
      status: "conflict"
    }, {
      id: "H1-002",
      documentId: "nested/chapter.txt",
      sourcePath: "G:/project/source/nested/chapter.txt",
      translationPath: "G:/project/AI_translation/nested/chapter_translated.txt",
      line: 8,
      src: "source two",
      current: "current two",
      problemType: "H1 accuracy",
      problem: "problem two",
      suggestion: "suggestion two",
      status: "unreviewed"
    }]
  });
  const legacy = current.replace(/<meta name="translation-workshop-proposal-review"[^>]*>\s*/, "");
  const upgraded = upgradeLegacyProposalReviewHtmlContent(legacy, "fallback");
  assert.ok(upgraded);
  const match = upgraded.match(/<script id="proposalData" type="application\/json">([\s\S]*?)<\/script>/i);
  assert.ok(match);
  const data = JSON.parse(match[1]);
  assert.equal(data.outputDir, "G:/project");
  assert.equal(data.reportPath, "G:/project/report/folder.proofread.json");
  assert.equal(data.proposals[0].documentId, "nested/chapter.txt");
  assert.equal(data.proposals[0].sourcePath, "G:/project/source/nested/chapter.txt");
  assert.equal(data.proposals[0].translationPath, "G:/project/AI_translation/nested/chapter_translated.txt");
  assert.equal(data.proposals[0].baseRevision, 3);
  assert.equal(data.proposals[0].status, "conflict");
  assert.equal(data.proposals[1].status, "accepted");
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
