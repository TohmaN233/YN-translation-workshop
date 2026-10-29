import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commitWorkspaceGlossaryCandidates,
  readGeneratedGlossaryCandidates,
  subscribeWorkspaceAssetsStatus,
  updateGeneratedGlossaryCandidate,
  workspaceAssetPaths
} from "../../src/main/agent/workspaceAssets.ts";
import { patchProjectState } from "../../src/main/projectState.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-candidate-edit-"));
try {
  const candidatePath = workspaceAssetPaths(root).glossaryCandidates;
  const formalPath = path.join(root, ".translation-workshop", "glossary.json");
  await mkdir(path.dirname(candidatePath), { recursive: true });
  await mkdir(path.dirname(formalPath), { recursive: true });
  const formalText = JSON.stringify({ entries: [{ source: "ASTER", target: "正式译名" }] });
  await writeFile(formalPath, formalText);
  await patchProjectState(root, { glossaryPath: formalPath });
  const original = { source: "ASTER", target: "初始候选", aliases: ["SYNTHETIC_ALIAS"], info: "Independent synthetic evidence.", status: "confirmed" };
  const other = { source: "OTHER", target: "其他候选", status: "auto" };
  await writeFile(candidatePath, JSON.stringify({ entries: [original, other] }));
  const update = (expectedTarget, target) => updateGeneratedGlossaryCandidate({ outputDir: root, source: "ASTER", expectedTarget, target });

  const edited = await update(original.target, "  修订候选  ");
  assert.deepEqual(edited, [{ ...original, target: "修订候选" }, other]);
  assert.deepEqual(await readGeneratedGlossaryCandidates(root), edited);
  assert.equal(await readFile(formalPath, "utf8"), formalText, "editing candidates does not change formal terminology");
  const saved = await readFile(candidatePath, "utf8");
  await assert.rejects(update(original.target, "过时修改"), /changed/i);
  await assert.rejects(update("修订候选", "  "), /non-empty|requires/i);
  await assert.rejects(updateGeneratedGlossaryCandidate({ outputDir: root, source: "MISSING", expectedTarget: "不存在", target: "新候选" }), /no longer exists/i);
  assert.equal(await readFile(candidatePath, "utf8"), saved);

  await Promise.all([
    update("修订候选", "并发修订"),
    commitWorkspaceGlossaryCandidates(root, [{ source: "ADDED", target: "同时新增", info: "Independent synthetic addition." }])
  ]);
  const concurrent = await readGeneratedGlossaryCandidates(root);
  assert.equal(concurrent.find(entry => entry.source === "ASTER").target, "并发修订");
  assert.equal(concurrent.find(entry => entry.source === "ADDED").target, "同时新增");
  assert.deepEqual(concurrent.find(entry => entry.source === "ASTER").aliases, original.aliases);
  const competing = await Promise.allSettled([update("并发修订", "第一修改"), update("并发修订", "第二修改")]);
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
  assert.match(competing.find(result => result.status === "rejected").reason.message, /changed/i);
  const current = (await readGeneratedGlossaryCandidates(root)).find(entry => entry.source === "ASTER");
  const beforeFailure = await readFile(candidatePath, "utf8");
  const unsubscribe = subscribeWorkspaceAssetsStatus(() => { throw new Error("synthetic status publication failure"); });
  try {
    await assert.rejects(update(current.target, "待回滚候选"), /synthetic status publication failure/);
    assert.equal(await readFile(candidatePath, "utf8"), beforeFailure, "failed candidate updates restore their artifact");
  } finally { unsubscribe(); }
  await commitWorkspaceGlossaryCandidates(root, [
    { source: "CASE", target: "大写候选" },
    { source: "case", target: "小写候选" }
  ]);
  await updateGeneratedGlossaryCandidate({ outputDir: root, source: "CASE", expectedTarget: "大写候选", target: "大写修订" });
  const distinct = await readGeneratedGlossaryCandidates(root);
  assert.equal(distinct.find(entry => entry.source === "CASE").target, "大写修订");
  assert.equal(distinct.find(entry => entry.source === "case").target, "小写候选", "case-sensitive candidate sources keep independent edit identities");
  const duplicateContent = JSON.stringify({ entries: [
    { source: "DUPLICATE", target: "首个候选" },
    { source: "DUPLICATE", target: "第二候选" }
  ] });
  await writeFile(candidatePath, duplicateContent);
  await assert.rejects(updateGeneratedGlossaryCandidate({ outputDir: root, source: "DUPLICATE", expectedTarget: "首个候选", target: "尝试修订" }), /ambiguous|duplicate/i);
  assert.equal(await readFile(candidatePath, "utf8"), duplicateContent, "ambiguous sources must not update a different row from the checked target");
  assert.equal(await readFile(formalPath, "utf8"), formalText);
  console.log("PASS candidate target edits persist, preserve metadata and concurrent entries, reject stale edits, and roll back failures");
} finally {
  await rm(root, { recursive: true, force: true });
}
