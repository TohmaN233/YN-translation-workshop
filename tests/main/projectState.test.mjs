import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  patchProjectState,
  readProjectState,
  saveProjectState,
  subscribeProjectState
} from "../../src/main/projectState.ts";

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

await test("project parameters survive reopen and preserve HTML-only settings", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await saveProjectState(outputDir, {
      languagePair: "en->zh-CN",
      style: "light novel",
      workDescription: "Prefer tips.txt before scripts.",
      splitSize: 500,
      reviewMode: "split 1000",
      translationSplitSize: 1000,
      proofreadSplitSize: 1000,
      subagentEnabled: true,
      subagentCount: 8,
      reviewSubagentCount: 3
    });
    await saveProjectState(outputDir, {
      sourcePath: path.join(outputDir, "source"),
      outputDir
    });

    const reopened = await readProjectState(outputDir);
    assert.equal(reopened.languagePair, "en->zh-CN");
    assert.equal(reopened.style, "light novel");
    assert.equal(reopened.workDescription, "Prefer tips.txt before scripts.");
    assert.equal(reopened.splitSize, 500);
    assert.equal(Object.hasOwn(reopened, "reviewMode"), false);
    assert.equal(Object.hasOwn(reopened, "translationSplitSize"), false);
    assert.equal(Object.hasOwn(reopened, "proofreadSplitSize"), false);
    assert.equal(reopened.subagentCount, 8);
    assert.equal(reopened.reviewSubagentCount, 3);
    assert.equal(reopened.sourcePath, path.join(outputDir, "source"));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("legacy reviewMode migrates to the canonical splitSize", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await saveProjectState(outputDir, { reviewMode: "split 500" });
    const reopened = await readProjectState(outputDir);
    assert.equal(reopened.splitSize, 500);
    assert.equal(Object.hasOwn(reopened, "reviewMode"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("legacy proofreadSplitSize migrates to the canonical splitSize", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await saveProjectState(outputDir, { proofreadSplitSize: 600 });
    const reopened = await readProjectState(outputDir);
    assert.equal(reopened.splitSize, 600);
    assert.equal(Object.hasOwn(reopened, "proofreadSplitSize"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("null clears inherited Agent count overrides", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await saveProjectState(outputDir, {
      subagentCount: 2,
      reviewSubagentCount: 3
    });
    await saveProjectState(outputDir, {
      subagentCount: null,
      reviewSubagentCount: null
    });
    const reopened = await readProjectState(outputDir);
    assert.equal(Object.hasOwn(reopened, "subagentCount"), false);
    assert.equal(Object.hasOwn(reopened, "reviewSubagentCount"), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("conflicting legacy split settings fail instead of silently choosing a default", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await assert.rejects(
      () => saveProjectState(outputDir, {
        translationSplitSize: 500,
        proofreadSplitSize: 1000
      }),
      /Conflicting legacy split settings/
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("folder pages share one atomic project state and receive live patches", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  const updates = [];
  const unsubscribe = subscribeProjectState((updatedOutputDir, state, patch) => {
    updates.push({ updatedOutputDir, state, patch });
  });
  try {
    await Promise.all([
      patchProjectState(outputDir, { languagePair: "ja->en", splitSize: 700 }),
      patchProjectState(outputDir, { glossaryPath: path.join(outputDir, ".translation-workshop", "glossary.json") })
    ]);
    const shared = await readProjectState(outputDir);
    assert.equal(shared.languagePair, "ja->en");
    assert.equal(shared.splitSize, 700);
    assert.match(String(shared.glossaryPath), /glossary\.json$/);
    assert.equal(updates.length, 2);
    assert.ok(updates.every((update) => path.resolve(update.updatedOutputDir) === path.resolve(outputDir)));
  } finally {
    unsubscribe();
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("custom preserve rules are canonical project settings shared by every HTML page", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await saveProjectState(outputDir, {
      customPreserveRules: [
        { label: "speaker id", pattern: "^@[A-Z_]+", flags: "mi" },
        { pattern: "[「」]", flags: "u" }
      ]
    });

    const reopened = await readProjectState(outputDir);
    assert.deepEqual(reopened.customPreserveRules, [
      { label: "speaker id", pattern: "^@[A-Z_]+", flags: "im" },
      { pattern: "[「」]", flags: "u" }
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("invalid custom preserve regex fails before corrupting project settings", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-project-state-"));
  try {
    await saveProjectState(outputDir, {
      customPreserveRules: [{ label: "valid", pattern: "^ID:", flags: "u" }]
    });
    await assert.rejects(
      () => patchProjectState(outputDir, {
        customPreserveRules: [{ label: "broken", pattern: "([", flags: "u" }]
      }),
      /Invalid custom preserve rule.*regular expression/i
    );
    assert.deepEqual((await readProjectState(outputDir)).customPreserveRules, [
      { label: "valid", pattern: "^ID:", flags: "u" }
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
