import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importAutomationAssets } from "../src/main/automationAssets.ts";
import { readProjectAssets } from "../src/main/agent/projectAssets.ts";
import { patchProjectState, readProjectState, subscribeProjectState } from "../src/main/projectState.ts";

async function project(fn) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-automation-assets-"));
  try { await fn(outputDir); } finally { await rm(outputDir, { recursive: true, force: true }); }
}

test("asset import merges selected external glossary read-only, serializes characters and is idempotent", () => project(async (outputDir) => {
  const external = path.join(outputDir, "external.json");
  const externalText = JSON.stringify({ entries: [{ source: "Alice", target: "爱丽丝", info: "reference" }] });
  await writeFile(external, externalText);
  await patchProjectState(outputDir, { glossaryPath: external, workDescription: "retain" });
  const input = { outputDir, glossary: [{ source: "Alice", target: "爱丽丝", aliases: ["小爱"] }, { source: "Archive", target: "档案馆" }], characters: [{ name: "Alice", target: "爱丽丝", gender: "female", aliases: ["小爱"], requiredTerms: ["先生 -> 老师"] }] };
  const first = await importAutomationAssets(input);
  assert.equal(first.counts.glossary.added, 1);
  assert.equal(first.counts.characters.added, 1);
  assert.equal(await readFile(external, "utf8"), externalText);
  const firstGlossary = await readFile(first.paths.glossary, "utf8");
  const firstCharacters = await readFile(first.paths.characterBible, "utf8");
  assert.match(firstCharacters, /^# Character Bible/m);
  assert.match(firstCharacters, /Required dialogue mappings:\n  - 先生 -> 老师/);
  const second = await importAutomationAssets(input);
  assert.equal(second.counts.glossary.added, 0);
  assert.equal(second.counts.characters.added, 0);
  assert.equal(await readFile(first.paths.glossary, "utf8"), firstGlossary);
  assert.equal(await readFile(first.paths.characterBible, "utf8"), firstCharacters);
  const state = await readProjectState(outputDir);
  assert.equal(state.glossaryPath, first.paths.glossary);
  assert.equal(state.workDescription, "retain");
}));

test("conflicting character or glossary values reject the complete combined import", () => project(async (outputDir) => {
  const result = await importAutomationAssets({ outputDir, glossary: [{ source: "Alice", target: "爱丽丝" }], characters: [{ name: "Alice", target: "爱丽丝", gender: "female" }] });
  const beforeGlossary = await readFile(result.paths.glossary, "utf8");
  const beforeCharacters = await readFile(result.paths.characterBible, "utf8");
  await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "New", target: "新" }], characters: [{ name: "Alice", gender: "male" }] }), /Character conflict/);
  await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "Alice", target: "艾丽丝" }], characters: [{ name: "New", target: "新" }] }), /Glossary conflict/);
  await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "New", target: "新" }], characters: [{ name: "New", target: "纽" }] }), /Formal asset conflict/);
  assert.equal(await readFile(result.paths.glossary, "utf8"), beforeGlossary);
  assert.equal(await readFile(result.paths.characterBible, "utf8"), beforeCharacters);
}));

test("character imports preserve preamble, unrelated raw sections and annotations on updated records", () => project(async (outputDir) => {
  const result = await importAutomationAssets({ outputDir, characters: [{ name: "Alice", target: "爱丽丝" }, { name: "Bob", target: "鲍勃" }] });
  const original = (await readFile(result.paths.characterBible, "utf8"))
    .replace("# Character Bible", "# Character Bible\n\n<!-- project reference -->")
    .replace("## Alice", "## Alice\n<!-- Alice annotation -->\n- Custom note: retain me")
    .replace("## Bob", "## Bob\n<!-- Bob annotation -->");
  await writeFile(result.paths.characterBible, original);
  await importAutomationAssets({ outputDir, characters: [] });
  assert.equal(await readFile(result.paths.characterBible, "utf8"), original);
  await importAutomationAssets({ outputDir, characters: [{ name: "Alice", voice: "quiet" }, { name: "Clara", target: "克拉拉" }] });
  const updated = await readFile(result.paths.characterBible, "utf8");
  assert.match(updated, /<!-- project reference -->/);
  assert.match(updated, /<!-- Alice annotation -->\n- Custom note: retain me/);
  assert.match(updated, /- Voice: quiet/);
  assert.ok(updated.includes(original.slice(original.indexOf("## Bob"))));
  await importAutomationAssets({ outputDir, characters: [{ name: "Alice", voice: "quiet" }, { name: "Clara", target: "克拉拉" }] });
  assert.equal(await readFile(result.paths.characterBible, "utf8"), updated);
}));

test("durable state commit failure rolls back both existing asset files and project binding", () => project(async (outputDir) => {
  const initial = await importAutomationAssets({ outputDir, glossary: [{ source: "Old", target: "旧" }], characters: [{ name: "Old", target: "旧" }] });
  const beforeGlossary = await readFile(initial.paths.glossary, "utf8");
  const beforeCharacters = await readFile(initial.paths.characterBible, "utf8");
  const statePath = path.join(outputDir, ".translation-workshop", "project.json");
  const beforeState = await readFile(statePath, "utf8");
  const unsubscribe = subscribeProjectState((root) => { if (root === outputDir) throw new Error("injected state notification failure"); });
  try {
    await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "New", target: "新" }], characters: [{ name: "New", target: "新" }] }), /injected state notification failure/);
  } finally { unsubscribe(); }
  assert.equal(await readFile(initial.paths.glossary, "utf8"), beforeGlossary);
  assert.equal(await readFile(initial.paths.characterBible, "utf8"), beforeCharacters);
  assert.equal(await readFile(statePath, "utf8"), beforeState);
}));

test("formal schema and canonical serializer reject lossy character fields before any write", () => project(async (outputDir) => {
  await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "Valid", target: "有效" }], characters: [{ name: "Alice", target: "爱丽丝", aliases: ["comma,name"] }] }), /canonical serializer/);
  await assert.rejects(importAutomationAssets({ outputDir, characters: [{ name: "Alice", requiredTerms: ["Alice -> 爱丽丝"] }] }), /cannot use a character name/);
  await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "", target: "invalid" }] }), /non-empty/);
  assert.equal((await readProjectAssets({ outputDir })).available.glossary, false);
}));

test("asset transaction failure on a new project removes both new assets and state", () => project(async (outputDir) => {
  const unsubscribe = subscribeProjectState((root) => { if (root === outputDir) throw new Error("fail after install"); });
  try { await assert.rejects(importAutomationAssets({ outputDir, glossary: [{ source: "New", target: "新" }], characters: [{ name: "New", target: "新" }] }), /fail after install/); }
  finally { unsubscribe(); }
  const assets = await readProjectAssets({ outputDir });
  assert.equal(assets.available.glossary, false);
  assert.equal(assets.available.characterBible, false);
  assert.deepEqual(await readProjectState(outputDir), {});
}));
