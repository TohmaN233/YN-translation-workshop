import { strict as assert } from "node:assert";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveBatchReviewChildForUpgrade } from "../../src/main/batchReviewUpgradePaths.ts";
import { writeTextFilesAtomically } from "../../src/main/atomicFile.ts";
import { upgradeLegacyReviewHtmlTree } from "../../src/main/reviewHtmlUpgrade.ts";
import {
  BATCH_LINE_REVIEW_PROTOCOL_MARKER,
  BATCH_LINE_REVIEW_PROTOCOL_VERSION,
  LINE_REVIEW_PROTOCOL_MARKER,
  PROMPT_SETTINGS_VERSION,
  renderBatchLineReviewIndexHtml,
  renderLineReviewHtml
} from "../../src/shared/core/html.ts";
import { agentChatFlowVersion } from "../../src/shared/core/agentChatEmbed.ts";

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

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-batch-upgrade-"));
  const reviewDir = path.join(root, "review");
  const outsideDir = path.join(root, "outside");
  await mkdir(path.join(reviewDir, "nested"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const indexPath = path.join(reviewDir, "index.html");
  const childPath = path.join(reviewDir, "nested", "child.html");
  const outsidePath = path.join(outsideDir, "outside.html");
  await Promise.all([
    writeFile(indexPath, "index", "utf8"),
    writeFile(childPath, "child", "utf8"),
    writeFile(outsidePath, "outside", "utf8")
  ]);
  return { root, reviewDir, indexPath, childPath, outsideDir, outsidePath };
}

await test("batch child upgrade resolves an existing nested HTML inside the batch directory", async () => {
  const item = await fixture();
  try {
    const resolved = await resolveBatchReviewChildForUpgrade(item.indexPath, "nested/child.html");
    assert.equal(resolved, item.childPath);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("batch child upgrade rejects absolute and drive-relative paths", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, item.outsidePath),
      /relative HTML path/i
    );
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, "C:outside.html"),
      /relative HTML path/i
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("batch child upgrade rejects parent traversal and non-HTML targets", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, "../outside/outside.html"),
      /path segments|stay inside the batch review directory/i
    );
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, "nested/../nested/child.html"),
      /path segments/i
    );
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, "nested/child.txt"),
      /HTML file/i
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("batch child upgrade rejects missing files instead of silently skipping migration", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, "nested/missing.html"),
      /does not exist/i
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("batch child upgrade rejects a symlinked child and a directory junction escape", async () => {
  const item = await fixture();
  try {
    if (process.platform !== "win32") {
      const childLink = path.join(item.reviewDir, "child-link.html");
      await symlink(item.childPath, childLink, "file");
      await assert.rejects(
        resolveBatchReviewChildForUpgrade(item.indexPath, "child-link.html"),
        /symbolic links/i
      );
    }

    const outsideLink = path.join(item.reviewDir, "outside-link");
    await symlink(item.outsideDir, outsideLink, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      resolveBatchReviewChildForUpgrade(item.indexPath, "outside-link/outside.html"),
      /symbolic links|stay inside the batch review directory/i
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("product batch-tree migration upgrades the index and its contained child together", async () => {
  const item = await fixture();
  try {
    const legacyChild = renderLineReviewHtml({
      title: "Child",
      sourceText: "source",
      translationText: "translation",
      lineReviewPath: item.childPath
    }).replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v0");
    const legacyIndex = renderBatchLineReviewIndexHtml({
      title: "Batch",
      files: [{
        sourceName: "source.txt",
        sourcePath: path.join(item.reviewDir, "source.txt"),
        outputPath: "nested/child.html",
        status: "matched",
        sourceLineCount: 1
      }]
    }).replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-v0");
    await Promise.all([
      writeFile(item.childPath, legacyChild, "utf8"),
      writeFile(item.indexPath, legacyIndex, "utf8")
    ]);

    assert.equal(await upgradeLegacyReviewHtmlTree(item.indexPath), true);
    assert.match(await readFile(item.indexPath, "utf8"), new RegExp(BATCH_LINE_REVIEW_PROTOCOL_MARKER));
    assert.match(await readFile(item.childPath, "utf8"), new RegExp(LINE_REVIEW_PROTOCOL_MARKER));
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("legacy EPUB folder upgrade binds the extracted validation text in Agent metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-folder-epub-upgrade-"));
  const outputDir = path.join(root, "output");
  const sourceDir = path.join(root, "source");
  const htmlDir = path.join(outputDir, ".translation-workshop", "html");
  const childPath = path.join(htmlDir, "batch", "book.html");
  const indexPath = path.join(htmlDir, "index.html");
  const epubPath = path.join(sourceDir, "book.epub");
  const extractedPath = path.join(outputDir, ".translation-workshop", "extracted-text", "book", "source.txt");
  try {
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(path.dirname(extractedPath), { recursive: true });
    await writeFile(extractedPath, "source text\n", "utf8");
    const child = renderLineReviewHtml({
      title: "Book",
      sourceText: "source text",
      translationText: "",
      lineReviewPath: childPath,
      workflow: {
        outputDir,
        sourcePath: epubPath,
        validationSourcePath: extractedPath,
        sourceKind: "file"
      }
    }).replace(
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
    );
    const index = renderBatchLineReviewIndexHtml({
      title: "Folder",
      files: [{
        sourceName: "book.epub",
        sourcePath: epubPath,
        outputPath: "batch/book.html",
        status: "missing-translation",
        sourceLineCount: 1
      }],
      workflow: {
        sourcePath: sourceDir,
        sourceKind: "folder",
        outputDir,
        inputMode: "separate"
      }
    });
    await Promise.all([
      writeFile(childPath, child, "utf8"),
      writeFile(indexPath, index, "utf8")
    ]);

    assert.equal(await upgradeLegacyReviewHtmlTree(indexPath), true);
    const upgraded = await readFile(childPath, "utf8");
    const payload = upgraded.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(payload, "upgraded EPUB child lost reviewData");
    const reviewData = JSON.parse(payload);
    assert.deepEqual(reviewData.workflow.advanced.folderSourceDocuments, [{
      id: "book.epub",
      path: extractedPath
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("legacy EPUB folder upgrade replaces an already persisted binary manifest path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-folder-epub-stale-manifest-"));
  const outputDir = path.join(root, "output");
  const sourceDir = path.join(root, "source");
  const htmlDir = path.join(outputDir, ".translation-workshop", "html");
  const childPath = path.join(htmlDir, "batch", "book.html");
  const indexPath = path.join(htmlDir, "index.html");
  const epubPath = path.join(sourceDir, "book.epub");
  const extractedPath = path.join(outputDir, ".translation-workshop", "extracted-text", "book", "source.txt");
  try {
    await mkdir(path.dirname(childPath), { recursive: true });
    await mkdir(path.dirname(extractedPath), { recursive: true });
    await writeFile(extractedPath, "source text\n", "utf8");
    const child = renderLineReviewHtml({
      title: "Book",
      sourceText: "source text",
      translationText: "",
      lineReviewPath: childPath,
      workflow: {
        outputDir,
        sourcePath: epubPath,
        validationSourcePath: extractedPath,
        sourceKind: "file"
      }
    }).replace(
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
    );
    const index = renderBatchLineReviewIndexHtml({
      title: "Folder",
      files: [{
        sourceName: "book.epub",
        sourcePath: epubPath,
        outputPath: "batch/book.html",
        status: "missing-translation",
        sourceLineCount: 1
      }],
      workflow: {
        sourcePath: sourceDir,
        sourceKind: "folder",
        outputDir,
        inputMode: "separate",
        advanced: {
          folderSourceDocuments: [{ id: "book.epub", path: epubPath }]
        }
      }
    });
    await Promise.all([
      writeFile(childPath, child, "utf8"),
      writeFile(indexPath, index, "utf8")
    ]);

    assert.equal(await upgradeLegacyReviewHtmlTree(indexPath), true);
    const upgraded = await readFile(childPath, "utf8");
    const payload = upgraded.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(payload, "upgraded EPUB child lost reviewData");
    const reviewData = JSON.parse(payload);
    assert.deepEqual(reviewData.workflow.advanced.folderSourceDocuments, [{
      id: "book.epub",
      path: extractedPath
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("current folder index upgrades a stale v7 child to the folder-bound Agent route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-folder-child-route-upgrade-"));
  const outputDir = path.join(root, "output");
  const sourceDir = path.join(root, "source");
  const htmlDir = path.join(outputDir, ".translation-workshop", "html");
  const indexPath = path.join(htmlDir, "index.html");
  const childPath = path.join(htmlDir, "batch", "scene.html");
  try {
    await mkdir(path.dirname(childPath), { recursive: true });
    const sourcePath = path.join(sourceDir, "scene.txt");
    const currentIndex = renderBatchLineReviewIndexHtml({
      title: "Folder",
      files: [{
        sourceName: "scene.txt",
        sourcePath,
        outputPath: "batch/scene.html",
        status: "missing-translation",
        sourceLineCount: 1
      }],
      workflow: {
        sourcePath: sourceDir,
        sourceKind: "folder",
        outputDir,
        inputMode: "separate"
      }
    });
    const staleChild = renderLineReviewHtml({
      title: "Scene",
      sourceText: "source",
      translationText: "",
      lineReviewPath: childPath,
      workflow: {
        sourcePath,
        sourceKind: "file",
        sourcePromptPath: sourceDir,
        promptSourceKind: "folder",
        outputDir
      }
    })
      .replaceAll(agentChatFlowVersion, "pi-web-react-embedded-v7")
      .replace(
        'paths.promptSourceKind === "folder" || paths.sourceKind === "folder"',
        'paths.sourceKind === "folder"'
      );
    await Promise.all([
      writeFile(indexPath, currentIndex, "utf8"),
      writeFile(childPath, staleChild, "utf8")
    ]);

    assert.equal(await upgradeLegacyReviewHtmlTree(indexPath), true);
    assert.equal(await readFile(indexPath, "utf8"), currentIndex);
    const upgradedChild = await readFile(childPath, "utf8");
    assert.match(upgradedChild, new RegExp(agentChatFlowVersion));
    assert.match(upgradedChild, /paths\.promptSourceKind === "folder"/);
    assert.match(upgradedChild, /"promptSourceKind":"folder"/);
    const reviewDataMatch = upgradedChild.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(reviewDataMatch, "upgraded child is missing reviewData");
    const reviewData = JSON.parse(reviewDataMatch[1]);
    assert.equal(reviewData.workflow.paths.promptSourcePath, sourceDir);
    assert.equal(reviewData.workflow.paths.promptSourceKind, "folder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("product opening auto-upgrades a v1 folder index into the batch prompt route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-folder-index-upgrade-"));
  const outputDir = path.join(root, "output");
  const htmlDir = path.join(outputDir, ".translation-workshop", "html");
  const indexPath = path.join(htmlDir, "index.html");
  const childPath = path.join(htmlDir, "nested", "child.html");
  try {
    await mkdir(path.dirname(childPath), { recursive: true });
    const childHtml = renderLineReviewHtml({
      title: "Child",
      sourceText: "source",
      translationText: "translation",
      lineReviewPath: childPath,
      workflow: {
        sourcePath: path.join(root, "source", "source.txt"),
        sourceKind: "file",
        translationPath: path.join(root, "translation", "source.txt"),
        outputDir
      }
    }).replace(
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}"`,
      `name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION - 1}"`
    );
    const legacyIndex = renderBatchLineReviewIndexHtml({
      title: "Folder",
      files: [{
        sourceName: "source.txt",
        sourcePath: path.join(root, "source", "source.txt"),
        outputPath: "nested/child.html",
        status: "missing-translation",
        sourceLineCount: 1
      }]
    }).replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-v1");
    await Promise.all([
      writeFile(indexPath, legacyIndex, "utf8"),
      writeFile(childPath, childHtml, "utf8")
    ]);

    assert.equal(await upgradeLegacyReviewHtmlTree(indexPath), true);
    const upgraded = await readFile(indexPath, "utf8");
    assert.doesNotMatch(upgraded, /id="folderTranslatePrompt"/);
    assert.match(upgraded, /Source folder:/);
    assert.match(upgraded, /"outputDir":"[^"]+"/);
    const upgradedChild = await readFile(childPath, "utf8");
    const childDataMatch = upgradedChild.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(childDataMatch, "upgraded child is missing reviewData");
    const childData = JSON.parse(childDataMatch[1]);
    assert.match(childData.workflow.prompts.translate, /Source folder:/);
    assert.doesNotMatch(childData.workflow.prompts.translate, /Source path: .*source\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("product batch-tree migration rejects escaped children before mutating any referenced file", async () => {
  const item = await fixture();
  try {
    const outsideBefore = renderLineReviewHtml({
      title: "Outside",
      sourceText: "outside",
      translationText: "unchanged",
      lineReviewPath: item.outsidePath
    }).replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v0");
    const unsafeIndex = renderBatchLineReviewIndexHtml({
      title: "Unsafe batch",
      files: [{
        sourceName: "outside.txt",
        sourcePath: path.join(item.outsideDir, "outside.txt"),
        outputPath: "../outside/outside.html",
        status: "matched",
        sourceLineCount: 1
      }]
    }).replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-v0");
    await Promise.all([
      writeFile(item.outsidePath, outsideBefore, "utf8"),
      writeFile(item.indexPath, unsafeIndex, "utf8")
    ]);

    await assert.rejects(upgradeLegacyReviewHtmlTree(item.indexPath), /path segments|stay inside the batch review directory/i);
    assert.equal(await readFile(item.indexPath, "utf8"), unsafeIndex);
    assert.equal(await readFile(item.outsidePath, "utf8"), outsideBefore);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("product batch-tree migration validates every legacy child before mutating the index or siblings", async () => {
  const item = await fixture();
  const secondChildPath = path.join(item.reviewDir, "nested", "second.html");
  try {
    const firstChildBefore = renderLineReviewHtml({
      title: "First child",
      sourceText: "first source",
      translationText: "first translation",
      lineReviewPath: item.childPath
    }).replace(LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-line-review-v0");
    const malformedChildBefore = `<!doctype html><html><body class="line-review"><script id="reviewData" type="application/json">{not-json</script></body></html>`;
    const indexBefore = renderBatchLineReviewIndexHtml({
      title: "Transactional batch",
      files: [
        {
          sourceName: "first.txt",
          sourcePath: path.join(item.reviewDir, "first.txt"),
          outputPath: "nested/child.html",
          status: "matched",
          sourceLineCount: 1
        },
        {
          sourceName: "second.txt",
          sourcePath: path.join(item.reviewDir, "second.txt"),
          outputPath: "nested/second.html",
          status: "matched",
          sourceLineCount: 1
        }
      ]
    }).replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, "translation-workshop-batch-review-v0");
    await Promise.all([
      writeFile(item.childPath, firstChildBefore, "utf8"),
      writeFile(secondChildPath, malformedChildBefore, "utf8"),
      writeFile(item.indexPath, indexBefore, "utf8")
    ]);

    await assert.rejects(upgradeLegacyReviewHtmlTree(item.indexPath), /cannot be migrated|review data/i);
    assert.equal(await readFile(item.indexPath, "utf8"), indexBefore);
    assert.equal(await readFile(item.childPath, "utf8"), firstChildBefore);
    assert.equal(await readFile(secondChildPath, "utf8"), malformedChildBefore);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("multi-file text commit restores every original when a later install fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-text-transaction-"));
  const firstPath = path.join(root, "first.html");
  const secondPath = path.join(root, "second.html");
  try {
    await Promise.all([
      writeFile(firstPath, "first-before", "utf8"),
      writeFile(secondPath, "second-before", "utf8")
    ]);
    let installedCount = 0;
    await assert.rejects(
      writeTextFilesAtomically(
        [
          { targetPath: firstPath, text: "first-after" },
          { targetPath: secondPath, text: "second-after" }
        ],
        {
          rename: async (sourcePath, targetPath) => {
            if (sourcePath.endsWith(".stage.tmp")) {
              installedCount += 1;
              if (installedCount === 2) throw new Error("injected second install failure");
            }
            await rename(sourcePath, targetPath);
          }
        }
      ),
      /injected second install failure/i
    );
    assert.equal(await readFile(firstPath, "utf8"), "first-before");
    assert.equal(await readFile(secondPath, "utf8"), "second-before");
    assert.deepEqual((await readdir(root)).sort(), ["first.html", "second.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("multi-file text commit stays successful when committed backup cleanup needs a retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-text-cleanup-"));
  const firstPath = path.join(root, "first.html");
  const secondPath = path.join(root, "second.html");
  try {
    await Promise.all([
      writeFile(firstPath, "first-before", "utf8"),
      writeFile(secondPath, "second-before", "utf8")
    ]);
    let injectedCleanupFailure = false;
    await writeTextFilesAtomically(
      [
        { targetPath: firstPath, text: "first-after" },
        { targetPath: secondPath, text: "second-after" }
      ],
      {
        rm: async (targetPath, options) => {
          if (!injectedCleanupFailure && targetPath.endsWith(".backup.tmp")) {
            injectedCleanupFailure = true;
            throw new Error("injected committed backup cleanup failure");
          }
          await rm(targetPath, options);
        }
      }
    );
    assert.equal(injectedCleanupFailure, true);
    assert.equal(await readFile(firstPath, "utf8"), "first-after");
    assert.equal(await readFile(secondPath, "utf8"), "second-after");
    assert.deepEqual((await readdir(root)).sort(), ["first.html", "second.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("multi-file text staging leaves no late temporary file after an earlier preflight failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-text-staging-"));
  const firstPath = path.join(root, "first.html");
  const secondPath = path.join(root, "second.html");
  try {
    await Promise.all([
      writeFile(firstPath, "first-before", "utf8"),
      writeFile(secondPath, "second-before", "utf8")
    ]);
    await assert.rejects(
      writeTextFilesAtomically(
        [
          { targetPath: firstPath, text: "first-after" },
          { targetPath: secondPath, text: "second-after" }
        ],
        {
          lstat: async (targetPath) => {
            if (path.resolve(targetPath) === path.resolve(firstPath)) {
              throw new Error("injected first staging preflight failure");
            }
            return lstat(targetPath);
          },
          writeFile: async (...args) => {
            await new Promise((resolve) => setTimeout(resolve, 75));
            return writeFile(...args);
          }
        }
      ),
      /injected first staging preflight failure/i
    );
    await new Promise((resolve) => setTimeout(resolve, 125));
    assert.deepEqual((await readdir(root)).sort(), ["first.html", "second.html"]);
    assert.equal(await readFile(firstPath, "utf8"), "first-before");
    assert.equal(await readFile(secondPath, "utf8"), "second-before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("product batch-tree migration leaves a newer on-disk protocol byte-identical", async () => {
  const item = await fixture();
  try {
    const childBefore = renderLineReviewHtml({
      title: "Current child",
      sourceText: "source",
      translationText: "translation",
      lineReviewPath: item.childPath
    });
    const futureVersion = BATCH_LINE_REVIEW_PROTOCOL_VERSION + 1;
    const futureIndex = renderBatchLineReviewIndexHtml({
      title: "Future batch",
      files: [{
        sourceName: "source.txt",
        sourcePath: path.join(item.reviewDir, "source.txt"),
        outputPath: "nested/child.html",
        status: "matched",
        sourceLineCount: 1
      }]
    }).replace(BATCH_LINE_REVIEW_PROTOCOL_MARKER, `translation-workshop-batch-review-v${futureVersion}`);
    await Promise.all([
      writeFile(item.childPath, childBefore, "utf8"),
      writeFile(item.indexPath, futureIndex, "utf8")
    ]);

    await assert.rejects(
      upgradeLegacyReviewHtmlTree(item.indexPath),
      new RegExp(`newer batch review protocol v${futureVersion}`, "i")
    );
    assert.equal(await readFile(item.indexPath, "utf8"), futureIndex);
    assert.equal(await readFile(item.childPath, "utf8"), childBefore);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

await test("future batch markers are rejected before parsing a missing or changed v1 batchData schema", async () => {
  const item = await fixture();
  try {
    const futureVersion = BATCH_LINE_REVIEW_PROTOCOL_VERSION + 1;
    const futureWithoutBatchData = `<!doctype html><html><head><meta name="translation-workshop-batch-review" content="translation-workshop-batch-review-v${futureVersion}"></head><body>future schema</body></html>`;
    await writeFile(item.indexPath, futureWithoutBatchData, "utf8");

    await assert.rejects(
      upgradeLegacyReviewHtmlTree(item.indexPath),
      new RegExp(`newer batch review protocol v${futureVersion}`, "i")
    );
    assert.equal(await readFile(item.indexPath, "utf8"), futureWithoutBatchData);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
