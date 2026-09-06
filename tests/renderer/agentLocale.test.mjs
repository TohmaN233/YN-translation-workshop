import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { agentUiStrings } from "../../src/renderer/agent/piweb/i18n.ts";
import { normalizeEmbeddedRoute } from "../../src/renderer/agent/embeddedRoute.ts";
import { agentChatRouteFromReviewData } from "../../src/shared/core/agentChatRoute.ts";
import {
  renderBatchLineReviewIndexHtml,
  renderLineReviewHtml,
  renderProposalReviewHtml
} from "../../src/shared/core/html.ts";

const han = /\p{Script=Han}/u;
const root = path.resolve(".");

function collectFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? collectFiles(full) : [full];
  });
}

const enDictionary = JSON.parse(readFileSync(path.join(root, "src/shared/i18n/en-US.json"), "utf8"));
const zhDictionary = JSON.parse(readFileSync(path.join(root, "src/shared/i18n/zh-CN.json"), "utf8"));
const {
  assetRequiredSourcePlaceholder,
  assetRequiredTargetPlaceholder,
  ...englishUiCopy
} = enDictionary;
assert.doesNotMatch(JSON.stringify(englishUiCopy), han, "the English workbench dictionary contains Han text outside intentional asset examples");
assert.match(assetRequiredSourcePlaceholder, han, "the source-term example must demonstrate a real source-script entry");
assert.match(assetRequiredTargetPlaceholder, han, "the target-term example must demonstrate a real translated entry");
assert.equal(enDictionary.startupSuggestions.length, 6, "the English startup suggestion set is incomplete");
assert.equal(zhDictionary.startupSuggestions.length, 6, "the Chinese startup suggestion set is incomplete");
assert.equal(new Set(zhDictionary.startupSuggestions).size, 6, "startup suggestions must be distinct");
assert.doesNotMatch(JSON.stringify(agentUiStrings["en-US"]), han, "the English Agent UI dictionary contains Han text");
assert.match(agentUiStrings["zh-CN"].emptyHint, han, "the Chinese Agent UI dictionary lost its Chinese copy");
assert.match(agentUiStrings["zh-CN"].promptUnavailable, han);
assert.match(agentUiStrings["zh-CN"].status.completed, han);

const messageViewSource = readFileSync(path.join(root, "src/renderer/agent/piweb/MessageView.tsx"), "utf8");
assert.doesNotMatch(messageViewSource, /\(prompt unavailable\)|\(reply unavailable\)|\$\{first\.length\} items|\$\{Object\.keys\(first\)\.length\} fields/);
assert.match(messageViewSource, /ui\.status\[status \|\| "running"\]/);

const unlocalizedAgentSources = collectFiles(path.join(root, "src/renderer/agent"))
  .filter((file) => /\.(?:ts|tsx)$/.test(file))
  .filter((file) => path.basename(file) !== "i18n.ts")
  .flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return han.test(source) ? [path.relative(root, file)] : [];
  });
assert.deepEqual(
  unlocalizedAgentSources,
  [],
  `Agent UI source contains Chinese outside its locale dictionary: ${unlocalizedAgentSources.join(", ")}`
);

const englishLineHtml = renderLineReviewHtml({
  title: "English line review",
  locale: "en-US",
  sourceText: "source",
  translationText: "translation",
  lineReviewPath: "G:/project/review.html",
  workflow: {
    sourcePath: "G:/project/source.txt",
    outputDir: "G:/project/output",
    advanced: { languagePair: "en->ja" }
  }
});
const lineData = JSON.parse(
  englishLineHtml.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "{}"
);
assert.equal(agentChatRouteFromReviewData(lineData, "G:/project/review.html").locale, "en-US");

const englishProposalHtml = renderProposalReviewHtml({
  title: "English proposal review",
  locale: "en-US",
  outputDir: "G:/project/output",
  proposals: [{ id: "p1", line: 1, src: "source", current: "current", problem: "issue", suggestion: "suggestion", status: "pending" }]
});
const proposalData = JSON.parse(
  englishProposalHtml.match(/<script id="proposalData" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "{}"
);
assert.equal(agentChatRouteFromReviewData(proposalData).locale, "en-US");

const englishBatchHtml = renderBatchLineReviewIndexHtml({
  title: "English folder review",
  locale: "en-US",
  workflow: {
    sourcePath: "G:/project/source",
    sourceKind: "folder",
    outputDir: "G:/project/output",
    advanced: { languagePair: "en->ja" }
  },
  files: [{
    sourceName: "scene.txt",
    sourcePath: "G:/project/source/scene.txt",
    outputPath: "scene.html",
    status: "missing-translation",
    sourceLineCount: 1
  }]
});
const batchData = JSON.parse(
  englishBatchHtml.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "{}"
);
assert.equal(batchData.folderAgentRoute.locale, "en-US");

assert.equal(normalizeEmbeddedRoute({ outputDir: "G:/project", locale: "en-US" }).locale, "en-US");
assert.equal(normalizeEmbeddedRoute({ outputDir: "G:/project" }, "en-US").locale, "en-US");
assert.equal(normalizeEmbeddedRoute({ outputDir: "G:/project" }, "zh-CN").locale, "zh-CN");

console.log("ok English and Chinese UI locales remain isolated across workbench, HTML, and Agent routes");
