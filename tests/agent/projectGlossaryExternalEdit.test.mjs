import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  saveProjectAssets,
  updateProjectGlossaryEntry
} from "../../src/main/agent/projectAssets.ts";
import { patchProjectState } from "../../src/main/projectState.ts";

{
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-project-glossary-external-edit-"));
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "tw-project-glossary-external-src-"));
  try {
    const externalPath = path.join(externalDir, "shared.json");
    await writeFile(externalPath, JSON.stringify({
      entries: [
        { source: "王都騎士団", target: "王都骑士团" },
        { source: "勇者", target: "勇者" }
      ]
    }, null, 2), "utf8");
    await patchProjectState(outputDir, { glossaryPath: externalPath });

    const assets = await updateProjectGlossaryEntry({
      outputDir,
      boundGlossaryPath: externalPath,
      entry: { source: "勇者", target: "勇者大人" }
    });
    assert.match(assets.paths.glossary, /\.translation-workshop[\\/]glossary\.json$/);
    assert.notEqual(path.resolve(assets.paths.glossary), path.resolve(externalPath));
    assert.deepEqual(assets.glossary.entries, [
      { source: "王都騎士団", target: "王都骑士团" },
      { source: "勇者", target: "勇者大人" }
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(assets.paths.glossary, "utf8")),
      { entries: assets.glossary.entries }
    );
    assert.equal(
      path.resolve(JSON.parse(await readFile(path.join(outputDir, ".translation-workshop", "project.json"), "utf8")).glossaryPath),
      path.resolve(assets.paths.glossary)
    );
    assert.deepEqual(
      JSON.parse(await readFile(externalPath, "utf8")).entries,
      [
        { source: "王都騎士団", target: "王都骑士团" },
        { source: "勇者", target: "勇者" }
      ]
    );
    console.log("ok editing an external glossary copies the full table into the project before rebinding");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
}

{
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-project-glossary-external-save-"));
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "tw-project-glossary-external-save-src-"));
  try {
    const externalPath = path.join(externalDir, "shared.json");
    await writeFile(externalPath, JSON.stringify({
      entries: [
        { source: "王都騎士団", target: "王都骑士团" },
        { source: "勇者", target: "勇者" }
      ]
    }, null, 2), "utf8");
    await patchProjectState(outputDir, { glossaryPath: externalPath });
    const assets = await saveProjectAssets({
      outputDir,
      glossaryEntry: { source: "勇者", target: "勇者大人", status: "confirmed" }
    });
    assert.deepEqual(assets.glossary.entries.map((entry) => [entry.source, entry.target]), [
      ["王都騎士団", "王都骑士团"],
      ["勇者", "勇者大人"]
    ]);
    console.log("ok sidebar glossary edits copy an external binding before writing one term");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
}
