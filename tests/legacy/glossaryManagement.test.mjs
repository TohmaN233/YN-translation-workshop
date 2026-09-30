import { strict as assert } from "node:assert";
import { renderLineReviewHtml, LINE_REVIEW_PROTOCOL_MARKER } from "../../src/shared/core/html.ts";
import { needsLegacyLineReviewUpgrade, upgradeLegacyLineReviewHtmlContent } from "../../src/shared/core/legacyHtml.ts";

const html = renderLineReviewHtml({
  title: "Glossary management", sourceText: "テスト", translationText: "测试",
  workflow: { outputDir: "G:/test-project", sourcePath: "G:/test-project/source.txt", glossaryEntries: [{ source: "テスト", target: "测试" }] }
});
assert.match(html, /id="viewGlossaryCandidates"/, "AI candidates must be visible before import");
assert.match(html, /class="glossary-delete"/, "formal terms must be deletable in the HTML");
const legacy = html.replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v38");
assert.equal(needsLegacyLineReviewUpgrade(legacy), true, "2.1.2 HTML must upgrade to glossary management");
const upgraded = upgradeLegacyLineReviewHtmlContent(legacy);
assert.match(upgraded, /id="viewGlossaryCandidates"/);
assert.match(upgraded, /class="glossary-delete"/);
assert.equal(needsLegacyLineReviewUpgrade(upgraded), false);
console.log("ok generated and upgraded HTML expose candidate preview and term deletion");
