import { strict as assert } from "node:assert";
import {
  isExtractedWorkshopTranslationPath,
  normalizeTranslationBinding,
  shouldAutoBindCanonicalTranslation,
  workflowTranslationPaths
} from "../../src/shared/core/translationBinding.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${name}`);
    console.error(error);
  }
}

await test("extracted EPUB snapshots are not a user translation binding", () => {
  const snapshot = "G:/proj/.translation-workshop/extracted-text/ab12cd34ef/translation/book.txt";
  assert.equal(isExtractedWorkshopTranslationPath(snapshot), true);
  assert.deepEqual(normalizeTranslationBinding({ path: snapshot }), {});
  assert.equal(shouldAutoBindCanonicalTranslation(normalizeTranslationBinding({ path: snapshot })), true);
});

await test("an explicit frontend path stays user-authored", () => {
  const binding = normalizeTranslationBinding({ path: "G:/proj/approved.txt" });
  assert.deepEqual(binding, { path: "G:/proj/approved.txt" });
  assert.equal(shouldAutoBindCanonicalTranslation(binding), false);
});

await test("canonical origin remains auto-updatable only when not user", () => {
  const binding = normalizeTranslationBinding({
    origin: "canonical",
    path: "G:/proj/AI_translation/book_translated.txt"
  });
  assert.equal(binding.origin, "canonical");
  assert.equal(shouldAutoBindCanonicalTranslation(binding), false);
  assert.equal(shouldAutoBindCanonicalTranslation({ origin: "canonical" }), true);
});

await test("EPUB HTML without a selected translation does not advertise the snapshot as the prompt binding", () => {
  const paths = workflowTranslationPaths({
    sourceIsEpub: true,
    editableSnapshotPath: "G:/proj/.translation-workshop/extracted-text/hash/translation/book.txt"
  });
  assert.equal(paths.translationPath, undefined);
  assert.equal(paths.translationPromptPath, undefined);
  assert.equal(
    paths.editableTranslationPath,
    "G:/proj/.translation-workshop/extracted-text/hash/translation/book.txt"
  );
});

await test("rendered EPUB review without a selected translation does not prompt-bind the snapshot", async () => {
  const { renderLineReviewHtml } = await import("../../src/shared/core/html.ts");
  const snapshot = "G:/proj/.translation-workshop/extracted-text/hash/translation/book.txt";
  const html = renderLineReviewHtml({
    title: "epub no selected translation",
    sourceText: "原文",
    translationText: "",
    workflow: {
      sourcePath: "G:/proj/book.epub",
      editableTranslationPath: snapshot,
      outputDir: "G:/proj"
    }
  });
  const payload = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(payload);
  const paths = JSON.parse(payload).workflow.paths;
  assert.equal(paths.editableTranslationPath, snapshot);
  assert.equal(paths.translationPromptPath || "", "");
  assert.equal(paths.translationPath || "", "");
});

await test("a selected translation keeps its own working path instead of the EPUB snapshot", () => {
  const paths = workflowTranslationPaths({
    sourceIsEpub: true,
    selectedTranslationPath: "G:/proj/AI_translation/book_translated.txt",
    editableSnapshotPath: "G:/proj/.translation-workshop/extracted-text/hash/translation/book.txt"
  });
  assert.equal(paths.translationPath, "G:/proj/AI_translation/book_translated.txt");
  assert.equal(paths.translationPromptPath, "G:/proj/AI_translation/book_translated.txt");
  assert.equal(paths.editableTranslationPath, "G:/proj/AI_translation/book_translated.txt");
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
