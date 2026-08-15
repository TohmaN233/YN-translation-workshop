import { strict as assert } from "node:assert";

import { normalizeEmbeddedRoute } from "../../src/renderer/agent/embeddedRoute.ts";

assert.deepEqual(normalizeEmbeddedRoute({
  outputDir: "G:/project",
  sourcePath: "G:/project/source",
  sourceKind: "folder",
  translationPath: "G:/project/translated"
}), {
  outputDir: "G:/project",
  locale: "zh-CN",
  languagePair: undefined,
  lineReviewPath: undefined,
  sourcePath: "G:/project/source",
  sourceKind: "folder",
  translationPath: "G:/project/translated"
});

assert.equal(normalizeEmbeddedRoute({ outputDir: "G:/project", sourceKind: "file" }).sourceKind, "file");
assert.equal(normalizeEmbeddedRoute({ outputDir: "G:/project", locale: "en-US" }).locale, "en-US");
console.log("ok embedded Pi-web route preserves typed folder source selection");
