import { strict as assert } from "node:assert";

import { compactConfiguredModelCatalog } from "../../src/main/agent/piNative/ynDomainTools.ts";

const models = Array.from({ length: 1_000 }, (_, index) => ({
  providerId: index < 900 ? "large-provider" : "small-provider",
  providerName: index < 900 ? "Large Provider" : "Small Provider",
  modelId: `model-${String(index).padStart(4, "0")}`,
  modelName: `Model ${index}`,
  authenticated: index < 900,
  supportsImages: index % 2 === 0
}));

const firstPage = compactConfiguredModelCatalog(models, {});
assert.equal(firstPage.totalModels, 1_000);
assert.equal(firstPage.models.length, 25, "an unfiltered model lookup must be bounded by default");
assert.equal(firstPage.nextOffset, 25);
assert.deepEqual(firstPage.providers.map((provider) => provider.modelCount), [900, 100]);
assert.ok(
  JSON.stringify(firstPage).length < 10_000,
  "the parent model catalog tool must not inject a provider's complete catalog into one Pi turn"
);

const filtered = compactConfiguredModelCatalog(models, {
  providerId: "small-provider",
  query: "model-099",
  limit: 10
});
assert.equal(filtered.totalModels, 10);
assert.equal(filtered.models.length, 10);
assert.ok(filtered.models.every((model) => model.providerId === "small-provider"));

console.log("ok parent model catalog output is summarized, filterable, and page-bounded");
