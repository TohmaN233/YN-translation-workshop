import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteProjectGlossaryEntry, readProjectAssets, updateProjectGlossaryEntry } from "../../src/main/agent/projectAssets.ts";
import { commitWorkspaceGlossaryCandidates, deleteGeneratedGlossaryCandidate, importGeneratedGlossaryCandidates, readGeneratedGlossaryCandidates, readWorkspaceAssetsStatus, subscribeWorkspaceAssetsStatus, workspaceAssetPaths } from "../../src/main/agent/workspaceAssets.ts";
import { patchProjectState, readProjectState } from "../../src/main/projectState.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-glossary-management-"));
const external = await mkdtemp(path.join(os.tmpdir(), "yn-glossary-reference-"));
try {
  const externalPath = path.join(external, "reference.json");
  const original = JSON.stringify({ entries: [
    { source: "騎士団", target: "骑士团", aliases: ["骑士队"], info: "keep metadata", status: "confirmed" },
    { source: "不要", target: "不需要" },
    { source: "勇者", target: "勇者大人" }
  ] });
  await writeFile(externalPath, original);
  await patchProjectState(root, { glossaryPath: externalPath });
  const first = await deleteProjectGlossaryEntry({ outputDir: root, boundGlossaryPath: externalPath, source: "不要", expectedTarget: "不需要" });
  assert.deepEqual(first.glossary.entries.map(e => e.source), ["騎士団", "勇者"]);
  assert.equal(await readFile(externalPath, "utf8"), original);
  assert.equal(first.glossary.entries[0].info, "keep metadata");
  assert.equal((await readProjectState(root)).glossaryPath, first.paths.glossary);
  const second = await deleteProjectGlossaryEntry({ outputDir: root, boundGlossaryPath: externalPath, source: "勇者", expectedTarget: "勇者大人" });
  assert.deepEqual(second.glossary.entries.map(e => e.source), ["騎士団"], "stale HTML external binding must not resurrect a deleted entry");
  await assert.rejects(deleteProjectGlossaryEntry({ outputDir: root, source: "騎士団", expectedTarget: "stale" }), /changed/);
  await Promise.all([
    deleteProjectGlossaryEntry({ outputDir: root, source: "騎士団", expectedTarget: "骑士团" }),
    updateProjectGlossaryEntry({ outputDir: root, entry: { source: "王都", target: "王城" } })
  ]);
  assert.deepEqual((await readProjectAssets({ outputDir: root })).glossary.entries.map(e => e.source), ["王都"]);
  await deleteProjectGlossaryEntry({ outputDir: root, source: "王都", expectedTarget: "王城" });
  assert.deepEqual((await readProjectAssets({ outputDir: root })).glossary.entries, []);
  console.log("ok formal deletion persists, preserves concurrent edits and external source, rejects stale targets, and deletes the last entry");

  assert.deepEqual(await readGeneratedGlossaryCandidates(root), []);
  const candidatePath = workspaceAssetPaths(root).glossaryCandidates;
  await mkdir(path.dirname(candidatePath), { recursive: true });
  const candidates = [
    { source: "テスト", target: "测试", aliases: ["试验"], info: "evidence", status: "pending" },
    { source: "不要", target: "不需要", status: "auto" }
  ];
  await writeFile(candidatePath, JSON.stringify({ entries: candidates }));
  assert.deepEqual(await readGeneratedGlossaryCandidates(root), candidates);
  await assert.rejects(deleteGeneratedGlossaryCandidate({ outputDir: root, source: "不要", expectedTarget: "stale" }), /changed/);
  const previousContent = await readFile(candidatePath, "utf8");
  const unsubscribe = subscribeWorkspaceAssetsStatus(() => { throw new Error("status publication failure"); });
  try {
    await assert.rejects(deleteGeneratedGlossaryCandidate({ outputDir: root, source: "不要", expectedTarget: "不需要" }), /status publication failure/);
    assert.equal(await readFile(candidatePath, "utf8"), previousContent, "failed deletion rolls back the candidate artifact");
  } finally {
    unsubscribe();
  }
  const kept = await deleteGeneratedGlossaryCandidate({ outputDir: root, source: "不要", expectedTarget: "不需要" });
  assert.deepEqual(kept, [candidates[0]]);
  assert.equal((await readWorkspaceAssetsStatus(root)).pending.glossaryCandidates, 1);
  const imported = await importGeneratedGlossaryCandidates(root);
  assert.deepEqual(imported.assets.glossary.entries.map(e => e.source), ["テスト"]);
  assert.equal(imported.assets.glossary.entries[0].info, "evidence");
  await Promise.all([
    deleteGeneratedGlossaryCandidate({ outputDir: root, source: "テスト", expectedTarget: "测试" }),
    commitWorkspaceGlossaryCandidates(root, [{ source: "追加", target: "追加候选" }])
  ]);
  assert.deepEqual((await readGeneratedGlossaryCandidates(root)).map(e => e.source), ["追加"], "concurrent discoveries are preserved");
  await deleteGeneratedGlossaryCandidate({ outputDir: root, source: "追加", expectedTarget: "追加候选" });
  assert.deepEqual(await readGeneratedGlossaryCandidates(root), []);
  assert.equal((await readProjectAssets({ outputDir: root })).glossary.entries.length, 1, "candidate deletion does not silently delete the formal entry");
  console.log("ok AI candidates are readable before import; deleted candidates stay out of import; the formal table remains independent");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(external, { recursive: true, force: true });
}
