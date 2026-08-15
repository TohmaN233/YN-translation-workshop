import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderBatchLineReviewIndexHtml, renderLineReviewHtml } from "../../src/shared/core/html.ts";
import { agentChatRouteFromReviewData } from "../../src/shared/core/agentChatRoute.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

function fixture(locale = "zh-CN") {
  return renderBatchLineReviewIndexHtml({
    title: "Folder review",
    locale,
    workflow: {
      sourcePath: "G:/project/source",
      sourceKind: "folder",
      outputDir: "G:/project/output",
      advanced: { languagePair: "ja->zh-CN" }
    },
    files: [{
      sourceName: "scene-01.txt",
      sourcePath: "G:/project/source/scene-01.txt",
      outputPath: "folder-review/scene-01.html",
      status: "missing-translation",
      sourceLineCount: 3
    }]
  });
}

await test("folder review exposes the shared folder-batch translation prompt", () => {
  const html = fixture();
  assert.doesNotMatch(html, /id="folderTranslatePrompt"/);
  assert.doesNotMatch(html, /batchPromptPanel/);
  assert.match(html, /"sourceKind":"folder"/);
  assert.match(html, /"initialWorkflowIntent":"translation"/);
  assert.match(html, /"initialPrompt":"Workflow: yn-translation-v1/);
});

await test("folder child AI tools generate the folder prompt, not a child-file prompt", () => {
  const html = renderLineReviewHtml({
    title: "Folder child",
    sourceText: "source",
    translationText: "translation",
    workflow: {
      sourcePath: "G:/project/source/scene.txt",
      sourceKind: "file",
      sourcePromptPath: "G:/project/source",
      promptSourceKind: "folder",
      translationPath: "G:/project/translation/scene.txt",
      translationPromptPath: "G:/project/translation",
      outputDir: "G:/project/output"
    }
  });
  const reviewDataMatch = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(reviewDataMatch, "folder child is missing reviewData");
  const reviewData = JSON.parse(reviewDataMatch[1]);
  assert.match(reviewData.workflow.prompts.translate, /Source folder: G:\/project\/source/);
  assert.doesNotMatch(reviewData.workflow.prompts.translate, /Source path: G:\/project\/source\/scene\.txt/);
  assert.equal(reviewData.workflow.paths.promptSourceKind, "folder");
});

await test("folder child Agent route preserves the folder prompt binding", () => {
  const html = renderLineReviewHtml({
    title: "Folder child route",
    sourceText: "source",
    translationText: "translation",
    workflow: {
      sourcePath: "G:/project/source/scene-01.txt",
      sourceKind: "file",
      sourcePromptPath: "G:/project/source",
      promptSourceKind: "folder",
      translationPath: "G:/project/translation/scene-01.txt",
      translationPromptPath: "G:/project/translation",
      outputDir: "G:/project/output"
    }
  });
  const reviewDataMatch = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(reviewDataMatch, "folder child is missing reviewData");
  const reviewData = JSON.parse(reviewDataMatch[1]);
  const route = agentChatRouteFromReviewData(reviewData, "G:/project/review/scene-01.html");
  assert.equal(route.sourcePath, "G:/project/source");
  assert.equal(route.sourceKind, "folder");
});

await test("folder review opens the selected child in the existing Electron tab host", () => {
  const html = fixture();
  assert.match(html, />\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00</);
  assert.match(html, /new URL\(file\.outputPath, location\.href\)\.href/);
  assert.match(html, /api\.openPath\(targetUrl\)/);
  assert.doesNotMatch(html, /window\.open\(file\.outputPath/);
});

await test("folder review exposes one compact Host-backed batch TXT action", () => {
  const html = fixture();
  assert.match(html, /id="writeAllTxt"/);
  assert.match(html, />\u6279\u91cf\u5199\u5165 TXT</);
  assert.match(html, /api\.writeBatchLineReviewTxt\(\)/);
  assert.match(html, /id="batchWriteStatus"/);
  assert.doesNotMatch(html, /batchTxtPanel|batchTxtSidebar/);
});

await test("folder review does not expose stale same-name translation match status", () => {
  const html = fixture();
  assert.doesNotMatch(html, /scene-01\.txt - \u672a\u627e\u5230\u540c\u540d\u8bd1\u6587/);
  assert.doesNotMatch(html, /id="activeStatus"/);
  assert.doesNotMatch(html, /statusText\(file\.status/);
});

await test("folder child and standalone views subscribe to one canonical line state", () => {
  const html = renderLineReviewHtml({
    title: "Shared child",
    sourceText: "source A\nsource B",
    translationText: "old A\nold B",
    lineReviewPath: "G:/project/.translation-workshop/html/folder/shared.html",
    workflow: {
      sourcePath: "G:/project/source/shared.txt",
      sourceKind: "file",
      outputDir: "G:/project"
    }
  });
  assert.match(html, /onLineReviewStateUpdate/);
  assert.match(html, /applyCanonicalLineReviewState/);
  assert.match(html, /changedLines:/);
  assert.match(html, /clientId: lineReviewClientId/);
  assert.match(html, /if \(!applyingCanonicalState\) save\(\)/);
});

await test("folder review uses the same tab wording in English", () => {
  const html = fixture("en-US");
  assert.match(html, />Open in new tab</);
  assert.match(html, />Write all TXT</);
  const batchData = JSON.parse(html.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
  assert.equal(batchData.folderAgentRoute.locale, "en-US");
});

await test("embedded Pi-web host resolves the top-level Electron bridge for a folder child frame", () => {
  const embeddedSource = readFileSync(path.join(root, "src", "renderer", "agent", "embedded.tsx"), "utf8");
  assert.match(embeddedSource, /const parentWorkshop = window\.parent !== window \? window\.parent\.workshop : undefined/);
  assert.match(embeddedSource, /window\.parent !== window \? window\.parent\.workshopHtml/);
  assert.match(embeddedSource, /Embedded Agent OS cannot reach the Electron workshop bridge/);
  assert.match(embeddedSource, /window\.addEventListener\("pagehide", \(\) => root\.unmount\(\), \{ once: true \}\)/);
});

await test("HTML openPath routes HTML targets into the real workbench tab manager", () => {
  const mainSource = readFileSync(path.join(root, "src", "main", "main.ts"), "utf8");
  const start = mainSource.indexOf('ipcMain.handle("shell:openPath"');
  const end = mainSource.indexOf('ipcMain.handle("html-tabs:activate"', start);
  assert.ok(start >= 0 && end > start, "shell:openPath handler is missing");
  const handler = mainSource.slice(start, end);
  assert.match(handler, /if \(isHtmlOpenTarget\(targetPath\)\)/);
  assert.match(handler, /await openHtmlWindow\(targetPath\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
