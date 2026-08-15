import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  importProjectGlossaryFile,
  updateProjectGlossaryEntry
} from "../../src/main/agent/projectAssets.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-project-glossary-import-"));
try {
  const sourcePath = path.join(outputDir, "external.tsv");
  await writeFile(sourcePath, "王都騎士団\t王都骑士团\n", "utf8");

  const assets = await importProjectGlossaryFile({ outputDir, filePath: sourcePath });
  assert.match(assets.paths.glossary, /\.translation-workshop[\\/]glossary\.json$/);
  assert.deepEqual(assets.glossary.entries, [{ source: "王都騎士団", target: "王都骑士团" }]);
  assert.deepEqual(
    JSON.parse(await readFile(assets.paths.glossary, "utf8")),
    { entries: [{ source: "王都騎士団", target: "王都骑士团" }] }
  );

  await Promise.all([
    updateProjectGlossaryEntry({ outputDir, entry: { source: "王都騎士団", target: "王城骑士团" } }),
    updateProjectGlossaryEntry({ outputDir, entry: { source: "勇者", target: "勇者大人" } })
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(assets.paths.glossary, "utf8")),
    {
      entries: [
        { source: "王都騎士団", target: "王城骑士团" },
        { source: "勇者", target: "勇者大人" }
      ]
    }
  );
  console.log("ok imported glossaries become the canonical shared project asset");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
