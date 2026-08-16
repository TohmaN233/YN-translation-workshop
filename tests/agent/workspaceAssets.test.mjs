import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  activateWorkspaceAssets,
  ensureYnWorkflowWorkspace,
  importGeneratedGlossaryCandidates,
  readWorkspaceAssetsStatus,
  subscribeActiveWorkspaceAssetsStatus,
  validateGeneratedCharacterBibleContent,
  workspaceAssetPaths
} from "../../src/main/agent/workspaceAssets.ts";

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
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-workspace-assets-"));
  const paths = workspaceAssetPaths(outputDir);
  await mkdir(path.dirname(paths.glossaryCandidates), { recursive: true });
  return { outputDir, paths };
}

async function cleanup(outputDir) {
  await rm(outputDir, { recursive: true, force: true });
}

await test("workflow startup creates the canonical directory scaffold without inventing completed assets", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-workflow-scaffold-"));
  try {
    const paths = await ensureYnWorkflowWorkspace(outputDir);
    for (const directory of [
      paths.projectMetadata,
      paths.translationOutput,
      paths.workspaceAssets,
      paths.proofreadReports
    ]) {
      assert.equal((await stat(directory)).isDirectory(), true);
    }
    const status = await readWorkspaceAssetsStatus(outputDir);
    assert.deepEqual(status.available, { glossaryCandidates: false, characterBible: false });
    for (const absentFile of [paths.glossaryCandidates, paths.characterBible, paths.styleGuide]) {
      await assert.rejects(
        stat(absentFile),
        (error) => error?.code === "ENOENT",
        `${absentFile} must not be materialized by directory preflight`
      );
    }

    await writeFile(paths.glossaryCandidates, '{"entries":[]}', "utf8");
    await writeFile(paths.characterBible, "# User character bible", "utf8");
    await writeFile(paths.styleGuide, "user style", "utf8");
    await ensureYnWorkflowWorkspace(outputDir);
    assert.equal(await readFile(paths.glossaryCandidates, "utf8"), '{"entries":[]}');
    assert.equal(await readFile(paths.characterBible, "utf8"), "# User character bible");
    assert.equal(await readFile(paths.styleGuide, "utf8"), "user style");
  } finally {
    await cleanup(outputDir);
  }
});

await test("missing generated assets report unavailable without hiding errors", async () => {
  const fx = await fixture();
  try {
    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.deepEqual(status.paths, fx.paths);
    assert.deepEqual(status.counts, { glossaryCandidates: 0, characterBibleLines: 0 });
    assert.deepEqual(status.available, { glossaryCandidates: false, characterBible: false });
    assert.deepEqual(status.pending, { glossaryCandidates: 0 });
    assert.deepEqual(status.actions, { importGlossaryCandidates: false });
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("valid generated assets report their paths, counts, and availability", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [
        { source: "勇者", target: "勇者", aliases: ["英雄"] },
        { source: "王都", target: "王都" }
      ]
    }), "utf8");
    await writeFile(
      fx.paths.characterBible,
      "# Character Bible\n\n## 勇者 / 勇者\n- Gender/pronouns: male; he/him; inferred\n- Terms of address: 勇者\n",
      "utf8"
    );
    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.equal(status.available.glossaryCandidates, true);
    assert.equal(status.available.characterBible, true);
    assert.deepEqual(status.counts, { glossaryCandidates: 2, characterBibleLines: 5 });
    assert.deepEqual(status.pending, { glossaryCandidates: 2 });
    assert.deepEqual(status.actions, { importGlossaryCandidates: true });
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("character bible without gender and address metadata is not considered ready", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.characterBible, "# Character Bible\n\n## 勇者 / 勇者\n- Voice/register: formal\n", "utf8");
    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.equal(status.available.characterBible, false);
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("character bible accepts the documented canonical and ordinary Markdown label forms", () => {
  const canonical = [
    "# Character Bible",
    "",
    "## Erina / 绘里奈",
    "- Source/target name: Erina -> 绘里奈",
    "- Identity/role: protagonist",
    "- Gender/pronouns: female; she/her (confidence: inferred)",
    "- Voice/register: calm",
    "- Relationships: unknown",
    "- Terms of address: use names until confirmed",
    "- Catchphrases: unknown",
    "- Evidence: script.txt L120 uses her"
  ].join("\n");
  const emphasized = canonical
    .replace("- Gender/pronouns:", "- **Gender/pronouns:**")
    .replace("- Terms of address:", "- **Terms of address:**");
  assert.equal(validateGeneratedCharacterBibleContent(canonical), canonical);
  assert.equal(validateGeneratedCharacterBibleContent(emphasized), emphasized);
});

await test("malformed generated glossary data fails fast", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({ entries: [{ source: "勇者" }] }), "utf8");
    await assert.rejects(
      readWorkspaceAssetsStatus(fx.outputDir),
      (error) => error instanceof Error && /target must be a non-empty string/.test(error.message)
    );
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("empty character bible is unavailable", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.characterBible, " \n\t\n", "utf8");
    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.equal(status.available.characterBible, false);
    assert.equal(status.counts.characterBibleLines, 0);
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("successful import writes formal glossary and returns updated assets and counts", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "勇者", target: "勇者", aliases: ["英雄"] }]
    }), "utf8");
    const result = await importGeneratedGlossaryCandidates(fx.outputDir);
    assert.equal(result.assets.glossary.entries.length, 1);
    assert.deepEqual(result.assets.glossary.entries[0], {
      source: "勇者",
      target: "勇者",
      aliases: ["英雄"]
    });
    assert.deepEqual(result.counts, { imported: 1, added: 1, deduplicated: 0, aliasesAdded: 1 });
    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.deepEqual(status.pending, { glossaryCandidates: 0 });
    assert.deepEqual(status.actions, { importGlossaryCandidates: false });
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("candidate import consolidates the selected glossary into canonical before switching the binding", async () => {
  const fx = await fixture();
  const projectDir = path.join(fx.outputDir, ".translation-workshop");
  const canonicalPath = path.join(projectDir, "glossary.json");
  const selectedPath = path.join(fx.outputDir, "selected-glossary.json");
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(canonicalPath, JSON.stringify({
      entries: [{ source: "既有术语", target: "既有译名" }]
    }), "utf8");
    await writeFile(selectedPath, JSON.stringify({
      entries: [{ source: "外部术语", target: "外部译名" }]
    }), "utf8");
    await writeFile(path.join(projectDir, "project.json"), JSON.stringify({
      outputDir: fx.outputDir,
      glossaryPath: selectedPath
    }), "utf8");
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "候选术语", target: "候选译名", status: "confirmed" }]
    }), "utf8");

    const result = await importGeneratedGlossaryCandidates(fx.outputDir);
    assert.deepEqual(result.assets.glossary.entries, [
      { source: "既有术语", target: "既有译名" },
      { source: "外部术语", target: "外部译名" },
      { source: "候选术语", target: "候选译名", status: "confirmed" }
    ]);
    const state = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(path.resolve(state.glossaryPath), path.resolve(canonicalPath));
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("candidate consolidation leaves canonical and the external binding unchanged on conflict", async () => {
  const fx = await fixture();
  const projectDir = path.join(fx.outputDir, ".translation-workshop");
  const canonicalPath = path.join(projectDir, "glossary.json");
  const selectedPath = path.join(fx.outputDir, "selected-glossary.json");
  const originalCanonical = JSON.stringify({ entries: [{ source: "既有术语", target: "既有译名" }] }, null, 2);
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(canonicalPath, originalCanonical, "utf8");
    await writeFile(selectedPath, JSON.stringify({
      entries: [{ source: "冲突术语", target: "外部译名" }]
    }), "utf8");
    await writeFile(path.join(projectDir, "project.json"), JSON.stringify({
      outputDir: fx.outputDir,
      glossaryPath: selectedPath
    }), "utf8");
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "冲突术语", target: "候选译名" }]
    }), "utf8");

    await assert.rejects(
      importGeneratedGlossaryCandidates(fx.outputDir),
      /glossary conflict/i
    );
    assert.equal(await readFile(canonicalPath, "utf8"), originalCanonical);
    const state = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(path.resolve(state.glossaryPath), path.resolve(selectedPath));
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("character gender and pronoun metadata survives generated glossary import", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{
        source: "ソロモン",
        target: "所罗门",
        aliases: ["Solomon"],
        info: "角色；男性；he/him；confirmed",
        status: "confirmed"
      }]
    }), "utf8");
    const result = await importGeneratedGlossaryCandidates(fx.outputDir);
    assert.deepEqual(result.assets.glossary.entries[0], {
      source: "ソロモン",
      target: "所罗门",
      aliases: ["Solomon"],
      info: "角色；男性；he/him；confirmed",
      status: "confirmed"
    });
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("new character metadata remains pending when the term itself was already imported", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "マリア", target: "玛利亚", info: "角色；女性；she/her；inferred" }]
    }), "utf8");
    const formalPath = path.join(fx.outputDir, ".translation-workshop", "glossary.json");
    await mkdir(path.dirname(formalPath), { recursive: true });
    await writeFile(formalPath, JSON.stringify({
      entries: [{ source: "マリア", target: "玛利亚" }]
    }), "utf8");
    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.deepEqual(status.pending, { glossaryCandidates: 1 });
    const result = await importGeneratedGlossaryCandidates(fx.outputDir);
    assert.equal(result.assets.glossary.entries[0].info, "角色；女性；she/her；inferred");
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("workspace status reports only candidates not already present in the formal glossary", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [
        { source: "勇者", target: "勇者", aliases: ["英雄", "救世主"] },
        { source: "王都", target: "王都" }
      ]
    }), "utf8");
    const formalPath = path.join(fx.outputDir, ".translation-workshop", "glossary.json");
    await mkdir(path.dirname(formalPath), { recursive: true });
    await writeFile(formalPath, JSON.stringify({
      entries: [{ source: "勇者", target: "勇者", aliases: ["英雄"] }]
    }), "utf8");

    const status = await readWorkspaceAssetsStatus(fx.outputDir);
    assert.deepEqual(status.pending, { glossaryCandidates: 2 });
    assert.deepEqual(status.actions, { importGlossaryCandidates: true });
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("exact matches and aliases are deduplicated during import", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [
        { source: "勇者", target: "勇者", aliases: ["英雄", "英雄"] },
        { source: "勇者", target: "勇者", aliases: ["英雄", "救世主"] }
      ]
    }), "utf8");
    const first = await importGeneratedGlossaryCandidates(fx.outputDir);
    assert.deepEqual(first.counts, { imported: 2, added: 1, deduplicated: 1, aliasesAdded: 2 });
    assert.deepEqual(first.assets.glossary.entries[0].aliases, ["英雄", "救世主"]);

    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "勇者", target: "勇者", aliases: ["救世主"] }]
    }), "utf8");
    const second = await importGeneratedGlossaryCandidates(fx.outputDir);
    assert.deepEqual(second.counts, { imported: 1, added: 0, deduplicated: 1, aliasesAdded: 0 });
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("conflicts are detected before the formal glossary is written", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "勇者", target: "英雄" }]
    }), "utf8");
    const formalPath = path.join(fx.outputDir, ".translation-workshop", "glossary.json");
    const original = JSON.stringify({ entries: [{ source: "勇者", target: "勇者" }] }, null, 2);
    await mkdir(path.dirname(formalPath), { recursive: true });
    await writeFile(formalPath, original, "utf8");
    await assert.rejects(
      importGeneratedGlossaryCandidates(fx.outputDir),
      (error) => error instanceof Error && /glossary conflict/i.test(error.message)
    );
    assert.equal(await readFile(formalPath, "utf8"), original);
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("concurrent generated glossary imports serialize the read-merge-write transaction", async () => {
  const fx = await fixture();
  try {
    await writeFile(fx.paths.glossaryCandidates, JSON.stringify({
      entries: [{ source: "勇者", target: "勇者" }]
    }), "utf8");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => importGeneratedGlossaryCandidates(fx.outputDir))
    );
    assert.equal(results.reduce((total, result) => total + result.counts.added, 0), 1);
    assert.equal(results.reduce((total, result) => total + result.counts.deduplicated, 0), 11);
    const formal = JSON.parse(await readFile(path.join(fx.outputDir, ".translation-workshop", "glossary.json"), "utf8"));
    assert.deepEqual(formal.entries, [{ source: "勇者", target: "勇者" }]);
  } finally {
    await cleanup(fx.outputDir);
  }
});

await test("background workspace status cannot replace the explicitly active workspace", async () => {
  const first = await fixture();
  const second = await fixture();
  const activated = [];
  const unsubscribe = subscribeActiveWorkspaceAssetsStatus((outputDir, status) => {
    activated.push({ outputDir, path: status.paths.characterBible });
  });
  try {
    const firstBible = "# Character Bible\n\n## First\n- Gender/pronouns: unknown; unknown; unknown\n- Terms of address: unknown\n";
    const secondBible = "# Character Bible\n\n## Second\n- Gender/pronouns: unknown; unknown; unknown\n- Terms of address: unknown\n";
    await writeFile(first.paths.characterBible, firstBible, "utf8");
    await writeFile(second.paths.characterBible, secondBible, "utf8");
    await activateWorkspaceAssets(first.outputDir);
    await readWorkspaceAssetsStatus(second.outputDir);
    assert.deepEqual(activated, [{
      outputDir: first.outputDir,
      path: first.paths.characterBible
    }]);
  } finally {
    unsubscribe();
    await cleanup(first.outputDir);
    await cleanup(second.outputDir);
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
