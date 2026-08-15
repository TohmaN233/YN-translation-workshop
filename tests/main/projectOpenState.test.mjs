import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverProjectReviewTargets,
  readRecentProjectDir,
  writeRecentProjectDir
} from "../../src/main/projectOpenState.ts";

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

await test("recent project folder persists independently of source/output pickers", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "yn-recent-project-"));
  try {
    const projectDir = path.join(userDataDir, "visual-novel");
    await writeRecentProjectDir(userDataDir, projectDir);
    assert.equal(await readRecentProjectDir(userDataDir), path.resolve(projectDir));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

await test("project review discovery chooses the newest line and proposal HTML independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-project-open-"));
  const workspaceDir = path.join(root, ".translation-workshop");
  const htmlDir = path.join(workspaceDir, "html");
  try {
    await mkdir(htmlDir, { recursive: true });
    const oldLine = path.join(htmlDir, "line-review-old.html");
    const newestLine = path.join(htmlDir, "line-review-new.html");
    const batchLine = path.join(htmlDir, "line-review-batch.html");
    const oldProposal = path.join(htmlDir, "proposal-review-old.html");
    const newestProposal = path.join(htmlDir, "proposal-review-new.html");
    await Promise.all([
      writeFile(oldLine, '<script id="reviewData" type="application/json">{}</script>', "utf8"),
      writeFile(newestLine, '<script id="reviewData" type="application/json">{}</script>', "utf8"),
      writeFile(batchLine, '<script id="batchData" type="application/json">{}</script>', "utf8"),
      writeFile(oldProposal, '<script id="proposalData" type="application/json">{}</script>', "utf8"),
      writeFile(newestProposal, '<script id="proposalData" type="application/json">{}</script>', "utf8")
    ]);
    const base = new Date("2026-07-17T00:00:00Z");
    await Promise.all([
      utimes(oldLine, base, base),
      utimes(batchLine, new Date(base.getTime() + 1000), new Date(base.getTime() + 1000)),
      utimes(newestLine, new Date(base.getTime() + 2000), new Date(base.getTime() + 2000)),
      utimes(oldProposal, base, base),
      utimes(newestProposal, new Date(base.getTime() + 3000), new Date(base.getTime() + 3000))
    ]);

    const targets = await discoverProjectReviewTargets(workspaceDir);
    assert.equal(targets.lineReviewHtml, newestLine);
    assert.equal(targets.proposalReviewHtml, newestProposal);
    assert.equal(targets.primaryHtml, newestLine);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("project review discovery ignores nested batch children on the project-open hot path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yn-project-open-nested-"));
  const workspaceDir = path.join(root, ".translation-workshop");
  const htmlDir = path.join(workspaceDir, "html");
  const batchDir = path.join(htmlDir, "line-review-batch-fixture");
  try {
    await mkdir(batchDir, { recursive: true });
    const batchIndex = path.join(htmlDir, "line-review-batch-newest.html");
    const nestedChild = path.join(batchDir, "line-review-child.html");
    await Promise.all([
      writeFile(batchIndex, '<script id="batchData" type="application/json">{}</script>', "utf8"),
      writeFile(nestedChild, '<script id="reviewData" type="application/json">{}</script>', "utf8")
    ]);
    const base = new Date("2026-07-17T00:00:00Z");
    await Promise.all([
      utimes(batchIndex, base, base),
      utimes(nestedChild, new Date(base.getTime() + 10_000), new Date(base.getTime() + 10_000))
    ]);

    const targets = await discoverProjectReviewTargets(workspaceDir);
    assert.equal(targets.lineReviewHtml, batchIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
