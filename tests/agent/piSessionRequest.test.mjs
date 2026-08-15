import { strict as assert } from "node:assert";

import {
  parsePiSessionInputRequest,
  parsePiSessionPromptRequest
} from "../../src/main/ipc/agentSessionRequest.ts";

const base = {
  outputDir: " C:/project ",
  sessionId: " session-1 ",
  prompt: " translate ",
  providerId: " provider ",
  modelId: " model "
};

assert.deepEqual(parsePiSessionPromptRequest({
  ...base,
  sourceSelection: { kind: "folder", path: " C:/project/source " }
}).sourceSelection, {
  kind: "folder",
  path: "C:/project/source"
});

for (const sourceSelection of [
  { kind: "folder", path: "" },
  { kind: "file", path: 42 },
  { kind: "directory", path: "C:/project/source" },
  "C:/project/source"
]) {
  assert.throws(
    () => parsePiSessionPromptRequest({
      ...base,
      sourcePath: "C:/project/fallback.txt",
      sourceSelection
    }),
    /sourceSelection/i
  );
}

assert.equal(parsePiSessionPromptRequest(base).sourceSelection, undefined);

assert.deepEqual(parsePiSessionPromptRequest({
  ...base,
  translationSplitSize: 800,
  folderTranslationOrder: '"tips.txt"\n{\n"script.txt"\n}',
  style: " light novel ",
  workDescription: " Prioritize character voice. ",
  glossaryPath: " C:/project/glossary.json ",
  glossaryCandidates: false,
  characterBible: true,
  reuseExistingTranslation: true,
  auditWhitelistLines: [3, 1, 3]
}), {
  ...parsePiSessionPromptRequest(base),
  translationSplitSize: 800,
  folderTranslationOrder: '"tips.txt"\n{\n"script.txt"\n}',
  style: "light novel",
  workDescription: "Prioritize character voice.",
  glossaryPath: "C:/project/glossary.json",
  glossaryCandidates: false,
  characterBible: true,
  reuseExistingTranslation: true,
  auditWhitelistLines: [1, 3]
});

assert.deepEqual(parsePiSessionPromptRequest({
  ...base,
  workflowIntent: "proofread",
  proofreadMode: "montecarlo",
  proofreadSplitSize: 1200,
  proofreadMontecarloSize: 3000,
  proofreadMontecarloRoundMin: 2,
  proofreadMontecarloRoundMax: 5
}), {
  outputDir: "C:/project",
  sessionId: "session-1",
  prompt: "translate",
  images: undefined,
  providerId: "provider",
  modelId: "model",
  thinkingLevel: undefined,
  workflowIntent: "proofread",
  languagePair: undefined,
    style: undefined,
    workDescription: undefined,
    glossaryPath: undefined,
    glossaryCandidates: undefined,
    characterBible: undefined,
    reuseExistingTranslation: undefined,
    auditWhitelistLines: undefined,
    customPreserveRules: [],
    subagentEnabled: undefined,
  subagentCount: undefined,
  reviewSubagentCount: undefined,
  subagentProviderId: undefined,
  subagentModelId: undefined,
  translationSplitSize: undefined,
  folderTranslationOrder: undefined,
  folderSourceDocuments: undefined,
  sourcePath: undefined,
  sourceSelection: undefined,
  translationPath: undefined,
  lineReviewPath: undefined,
  proofreadMode: "montecarlo",
  proofreadSplitSize: 1200,
  proofreadMontecarloSize: 3000,
  proofreadMontecarloRoundMin: 2,
  proofreadMontecarloRoundMax: 5
});

assert.equal(parsePiSessionPromptRequest({ ...base, reviewSubagentCount: 3 }).reviewSubagentCount, 3);
assert.throws(
  () => parsePiSessionPromptRequest({ ...base, reviewSubagentCount: 0 }),
  /reviewSubagentCount.*positive integer/i
);

assert.deepEqual(parsePiSessionPromptRequest({
  ...base,
  customPreserveRules: [{ label: " marker ", pattern: " ^@[A-Z_]+ ", flags: "ui" }]
}).customPreserveRules, [{ label: "marker", pattern: "^@[A-Z_]+", flags: "iu" }]);
for (const customPreserveRules of [
  [{ pattern: "(" }],
  [{ pattern: "^" }],
  [{ pattern: "x", flags: "g" }],
  [{ pattern: "x", unexpected: true }]
]) {
  assert.throws(
    () => parsePiSessionPromptRequest({ ...base, customPreserveRules }),
    /custom preserve rule|customPreserveRules|regular expression|empty string|unsupported/i
  );
}

assert.deepEqual(parsePiSessionPromptRequest({
  ...base,
  sourceSelection: { kind: "folder", path: "C:/project/source" },
  folderSourceDocuments: [
    { id: "scene.txt", path: " C:/project/source/scene.txt " },
    { id: "book.epub", path: " C:/project/.translation-workshop/extracted-text/book/source.txt " }
  ]
}).folderSourceDocuments, [
  { id: "scene.txt", path: "C:/project/source/scene.txt" },
  { id: "book.epub", path: "C:/project/.translation-workshop/extracted-text/book/source.txt" }
]);

for (const folderSourceDocuments of [
  [],
  [{ id: "", path: "C:/project/source/scene.txt" }],
  [{ id: "scene.txt", path: "" }],
  [{ id: "book.epub", path: "C:/project/source/book.epub" }],
  [{ id: "scene.txt", path: 42 }]
]) {
  assert.throws(
    () => parsePiSessionPromptRequest({ ...base, folderSourceDocuments }),
    /folderSourceDocuments|EPUB|extracted UTF-8 text/i
  );
}

for (const request of [
  { ...base, sourcePath: "C:/project/book.epub" },
  { ...base, sourceSelection: { kind: "file", path: "C:/project/book.epub" } },
  { ...base, translationPath: "C:/project/translated.epub" }
]) {
  assert.throws(
    () => parsePiSessionPromptRequest(request),
    /EPUB|extracted UTF-8 text/i
  );
}

for (const request of [
  { ...base, glossaryCandidates: "yes" },
  { ...base, characterBible: 1 },
  { ...base, reuseExistingTranslation: "yes" },
  { ...base, auditWhitelistLines: "1,2" },
  { ...base, auditWhitelistLines: [0] },
  { ...base, auditWhitelistLines: [1.5] },
  { ...base, auditWhitelistLines: [1, "2"] }
]) {
  assert.throws(
    () => parsePiSessionPromptRequest(request),
    /glossaryCandidates|characterBible|reuseExistingTranslation|auditWhitelistLines/i
  );
}

const tinyImage = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZxN8AAAAASUVORK5CYII="
};

assert.deepEqual(parsePiSessionPromptRequest({
  ...base,
  prompt: "",
  images: [tinyImage]
}).images, [tinyImage]);

assert.deepEqual(parsePiSessionInputRequest({
  outputDir: " C:/project ",
  sessionId: " session-1 ",
  kind: "steer",
  text: "",
  images: [tinyImage]
}), {
  outputDir: "C:/project",
  sessionId: "session-1",
  kind: "steer",
  text: "",
  images: [tinyImage]
});

for (const request of [
  { ...base, prompt: "", images: undefined },
  { ...base, images: [{ ...tinyImage, mimeType: "image/svg+xml" }] },
  { ...base, images: [{ ...tinyImage, data: Buffer.from("not-a-png").toString("base64") }] },
  { ...base, images: [{ ...tinyImage, data: `data:image/png;base64,${tinyImage.data}` }] },
  { ...base, images: Array.from({ length: 6 }, () => tinyImage) }
]) {
  assert.throws(
    () => parsePiSessionPromptRequest(request),
    /prompt or images|unsupported image|declared image type|raw base64|between 1 and 5/i
  );
}

assert.throws(
  () => parsePiSessionInputRequest({ outputDir: "C:/project", sessionId: "session-1", kind: "steer", text: "" }),
  /text or images/i
);

console.log("ok native Pi prompt IPC rejects malformed source selections instead of falling back");
