import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transform } from "esbuild";
import { renderLineReviewHtml, PROMPT_SETTINGS_VERSION } from "../../src/shared/core/html.ts";
import { upgradeLegacyLineReviewHtmlContent, needsLegacyLineReviewUpgrade } from "../../src/shared/core/legacyHtml.ts";
import { builtinTaskDefaults } from "../../src/shared/builtinTasks.ts";
import { parsePiSessionPromptRequest } from "../../src/main/ipc/agentSessionRequest.ts";

function functionSource(source, name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing actual function ${name}`);
  let parens = 0, signatureEnd;
  for (let i = source.indexOf("(", match.index); i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) { signatureEnd = i; break; }
  }
  let depth = 0, quote = "", escape = false;
  for (let i = source.indexOf("{", signatureEnd); i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) quote = "";
    } else if ('"\'`'.includes(char)) quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`Unbalanced actual function ${name}`);
}
function dataOf(html) {
  return JSON.parse(html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
}
function page(advanced, sourceKind = "file") {
  return renderLineReviewHtml({ title: "metadata regression", sourceText: "日本語", translationText: "中文",
    workflow: { sourcePath: "G:/project/source.txt", sourceKind, outputDir: "G:/project", advanced } });
}
async function insert(html, kind) {
  const workflow = dataOf(html).workflow;
  let accepted;
  const context = vm.createContext({ workflow, promptSettingsVersion: PROMPT_SETTINGS_VERSION,
    activePromptKind: kind, promptPreview: { value: "Workflow prompt" }, boundGlossaryPath: () => "", auditWhitelistLines: () => [],
    currentPromptSettings: () => workflow.promptDefaults,
    window: { __ynAgentChatPiWebEmbedded: { replaceText: (_text, metadata) => { accepted = context.workflowMetadata(metadata); } } } });
  vm.runInContext(["optionalPositivePromptNumber", "normalizedPromptDefaults", "promptStoredDefaults", "defaultFolderTranslationOrder",
    "workflowPromptMetadata", "workflowMetadata", "openAgentChatForPrompt"].map(name => functionSource(html, name)).join("\n"), context);
  await context.openAgentChatForPrompt();
  return parsePiSessionPromptRequest({ ...JSON.parse(JSON.stringify(accepted)), prompt: "Workflow prompt", sessionId: "metadata-fixture",
    outputDir: "G:/project", providerId: "fixture", modelId: "fixture" });
}

for (const kind of ["translate", "proofread"]) {
  test(`single-file ${kind} accepts homepage empty folder metadata`, async () => {
    const html = page({ folderSourceDocuments: [], splitSize: 500, style: "game" });
    const metadata = await insert(html, kind);
    assert.equal(metadata.folderSourceDocuments, undefined);
    assert.equal(metadata.workflowIntent, kind === "translate" ? "translation" : "proofread");
  });
  test(`single-file ${kind} excludes stale folder-to-file bindings`, async () => {
    const html = page({ folderSourceDocuments: [{ id: "old.txt", path: "G:/old/old.txt" }], folderSourceSelection: "prepared-inputs", folderTranslationOrder: '"old.txt"' });
    const data = dataOf(html).workflow;
    for (const parameters of [data.advanced, data.promptDefaults, data.factoryPromptDefaults]) {
      assert.equal(parameters.folderSourceDocuments, undefined);
      assert.equal(parameters.folderSourceSelection, undefined);
    }
    const metadata = await insert(html, kind);
    assert.equal(metadata.folderSourceDocuments, undefined);
    assert.equal(metadata.folderSourceSelection, undefined);
    assert.equal(metadata.folderTranslationOrder, undefined);
  });
}

test("legacy single-file page carrying empty folder metadata upgrades and injects", async () => {
  const original = page({ languagePair: "ja->zh-CN", splitSize: 77, style: "game" });
  const data = dataOf(original);
  for (const parameters of [data.workflow.advanced, data.workflow.promptDefaults, data.workflow.factoryPromptDefaults]) parameters.folderSourceDocuments = [];
  const legacy = original.replace(/(<script id="reviewData" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(data)}$2`)
    .replace(`name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`, 'name="translation-workshop-prompt-settings" content="43"');
  assert.ok(needsLegacyLineReviewUpgrade(legacy), "previous release marker must trigger upgrade");
  const upgraded = upgradeLegacyLineReviewHtmlContent(legacy, "legacy single");
  assert.ok(upgraded);
  assert.equal(needsLegacyLineReviewUpgrade(upgraded), false);
  assert.equal(dataOf(upgraded).workflow.promptDefaults.splitSize, 77);
  for (const kind of ["translate", "proofread"]) assert.equal((await insert(upgraded, kind)).folderSourceDocuments, undefined);
});

test("folder page retains actual prepared-input manifest", async () => {
  const documents = [{ id: "chapter.txt", path: "G:/project/source/chapter.txt" }];
  const html = page({ folderSourceDocuments: documents, folderSourceSelection: "prepared-inputs", folderTranslationOrder: '{"chapter.txt"}' }, "folder");
  for (const kind of ["translate", "proofread"]) {
    const metadata = await insert(html, kind);
    assert.deepEqual(metadata.folderSourceDocuments, documents);
    assert.equal(metadata.folderSourceSelection, "prepared-inputs");
  }
});

test("builtin single-file defaults discard inactive folder settings", () => {
  const settings = builtinTaskDefaults({ sourceKind: "file", folderSourceDocuments: [], folderSourceSelection: "prepared-inputs" });
  assert.equal(settings.folderSourceDocuments, undefined);
  assert.equal(settings.folderSourceSelection, undefined);
});

test("empty manifest is still rejected when explicitly used as a folder manifest", async () => {
  await assert.rejects(insert(page({ folderSourceDocuments: [] }, "folder"), "translate"), /folderSourceDocuments must be a non-empty array/);
});

test("actual homepage generation excludes a loaded folder manifest after selecting file", async () => {
  const source = readFileSync(new URL("../../src/renderer/App.tsx", import.meta.url), "utf8");
  const code = (await transform(functionSource(source, "initialFormState") + "\n" + functionSource(source, "promptAdvanced"), { loader: "ts" })).code;
  const prompts = await import("../../src/shared/core/prompts.ts");
  const context = vm.createContext({ ...prompts, YN_DEFAULT_SPLIT_SIZE: 500, YN_WORKFLOW_SUBAGENT_COUNT: 3,
    savedCustomPreserveRules: [], defaultTranslateOutputDir: () => "G:/project/AI_translation", defaultProofreadOutputDir: () => "G:/project/report" });
  vm.runInContext(code + '\nvar form=initialFormState(); form.sourceKind="file"; form.folderSourceDocuments=[{id:"old.txt",path:"G:/old/old.txt"}];', context);
  const advanced = context.promptAdvanced();
  assert.equal(advanced.folderSourceDocuments, undefined);
  assert.equal((await insert(page(advanced), "translate")).folderSourceDocuments, undefined);
});
