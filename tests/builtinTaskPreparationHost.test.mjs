import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTaskDefaults } from "../src/shared/builtinTasks.ts";
import { createBuiltinTaskPreparationHost, validateBuiltinTaskSettings } from "../src/main/builtinTaskPreparationHost.ts";
import { patchProjectState, readProjectState } from "../src/main/projectState.ts";

async function fixture(work) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-prepared-task-"));
  const sourcePath = path.join(outputDir, "source.txt");
  await writeFile(sourcePath, "[speaker]こんにちは {name}。\n次の文です。\n");
  const settings = builtinTaskDefaults({ outputDir, sourcePath });
  await patchProjectState(outputDir, settings);
  const context = { outputDir, sessionId: "session-one", preparationId: "prep-one", intent: "translation" };
  const started = [];
  const finished = [];
  const host = createBuiltinTaskPreparationHost({ sourceFiles: async () => [sourcePath],
    workflowRequest: async (_context, next) => { started.push(next); return { prompt: "Workflow: yn-translation-v1.", ...context }; },
    finish: async (...args) => { finished.push(args); } });
  try { await work({ outputDir, sourcePath, settings, context, host, started, finished }); }
  finally { await rm(outputDir, { recursive: true, force: true }); }
}

test("new task defaults are 500/3 and explicit existing values survive", () => {
  const defaults = builtinTaskDefaults();
  assert.equal(defaults.splitSize, 500);
  assert.equal(defaults.subagentCount, 3);
  assert.equal(defaults.characterBible, true);
  assert.equal(builtinTaskDefaults({ split: false }).split, true);
  assert.equal(builtinTaskDefaults({ splitSize: 900, subagentCount: 4 }).splitSize, 900);
  assert.equal(builtinTaskDefaults({ splitSize: 900, subagentCount: 4 }).subagentCount, 4);
});

test("materials preparation does not require a still-existing source selection", () => fixture(async (f) => {
  await rm(f.sourcePath);
  const settings = await validateBuiltinTaskSettings({ task: "assets", settings: f.settings });
  assert.equal(settings.sourcePath, f.sourcePath);
  assert.equal((await f.host.inspectSettings({ ...f.context, intent: "assets" })).outputDir, f.outputDir);
  await assert.rejects(validateBuiltinTaskSettings({ task: "translation", settings: f.settings }), /ENOENT/);
}));

test("translation needs an explicit trial; selected rules are persisted without losing existing rules", () => fixture(async (f) => {
  const prior = { label: "prefix", pattern: "^\\[speaker\\]", flags: "u" };
  await patchProjectState(f.outputDir, { customPreserveRules: [prior] });
  const report = await f.host.inspectSources(f.context, {});
  assert.ok(report.candidates.some((candidate) => candidate.matchCount > 0));
  await assert.rejects(f.host.prepareWorkflow(f.context, {}), /Trial the selected/);
  const next = { label: "variable", pattern: "\\{name\\}", flags: "u" };
  await f.host.inspectSources(f.context, { rules: [next] });
  await f.host.prepareWorkflow(f.context, { customPreserveRules: [next] });
  const state = await readProjectState(f.outputDir);
  assert.deepEqual(state.customPreserveRules.map((r) => r.pattern), [prior.pattern, next.pattern]);
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0].splitSize, 500);
}));

test("prepared workflow cannot launch while its reference draft is uncommitted", () => fixture(async (f) => {
  await f.host.inspectSources(f.context, { rules: [] });
  const draft = await f.host.importAssets(f.context, { glossary: [{ source: "Alice", target: "爱丽丝" }] });
  await assert.rejects(f.host.prepareWorkflow(f.context, {}), /Reference draft is not committed/);
  assert.equal(f.started.length, 0);
  await f.host.checkAssetDraft(f.context, { expectedRevision: draft.revision, reviewSummary: "Reviewed reference name." });
  await f.host.commitAssets(f.context, { expectedRevision: draft.revision });
  await f.host.prepareWorkflow(f.context, {});
  assert.equal(f.started.length, 1);
}));

test("preflight edits the shared parameter file, rejects unknown fields and requires a fresh trial after edits", () => fixture(async f => {
  const inspected = await f.host.inspectSettings(f.context);
  assert.equal(inspected.settingsPath, path.join(f.outputDir, ".translation-workshop", "project.json"));
  assert.ok(inspected.editableParameters.includes("style"));
  assert.ok(!inspected.editableParameters.includes("split"));
  await f.host.inspectSources(f.context, { rules: [] });
  await f.host.updateSettings(f.context, { settings: { languagePair: "ja->en", style: "literary dialogue", splitSize: 47 }, reason: "Source is Japanese dialogue; corrected direction and requested style." });
  assert.equal((await readProjectState(f.outputDir)).style, "literary dialogue");
  await assert.rejects(f.host.prepareWorkflow(f.context, {}), /Trial the selected/);
  await assert.rejects(f.host.updateSettings(f.context, { settings: { sourcePath: "another-file" }, reason: "unsupported binding change" }), /not editable/);
  await assert.rejects(f.host.updateSettings(f.context, { settings: { style: 123 }, reason: "bad type" }), /must be a string/);
  await assert.rejects(f.host.updateSettings({ ...f.context, intent: "assets" }, { settings: { style: "other" }, reason: "unrelated" }), /cannot change translation settings/);
  await f.host.inspectSources(f.context, { rules: [] });
  await f.host.prepareWorkflow(f.context, {});
  assert.equal(f.started[0].style, "literary dialogue"); assert.equal(f.started[0].splitSize, 47);
}));

test("changed sources/settings and unmatched new rules refuse launch", () => fixture(async (f) => {
  await f.host.inspectSources(f.context, { rules: [] });
  await writeFile(f.sourcePath, "変わった文。\n");
  await assert.rejects(f.host.prepareWorkflow(f.context, {}), /Sources changed/);
  await f.host.inspectSources(f.context, { rules: [{ pattern: "missing", flags: "u" }] });
  await assert.rejects(f.host.prepareWorkflow(f.context, {}), /no source matches/);
  assert.equal(f.started.length, 0);
}));

test("proofreading rejects missing translations and retains explicit HTML-only application choice", () => fixture(async (f) => {
  await assert.rejects(validateBuiltinTaskSettings({ task: "proofread", settings: f.settings }), /existing translation/);
  const translationPath = path.join(f.outputDir, "translation.txt");
  await writeFile(translationPath, "你好。\n下一句。\n");
  await patchProjectState(f.outputDir, { translationPath });
  await f.host.finishWorkflow({ ...f.context, intent: "proofread" }, { workflow: "proofread", autoApplyProofreadSuggestions: true });
  assert.equal(f.finished[0][2], true);
  assert.equal(await readFile(translationPath, "utf8"), "你好。\n下一句。\n");
}));

test("prepared canonical binding retains original selected input without masking a later explicit choice", () => fixture(async (f) => {
  const selected = path.join(f.outputDir, "selected.txt");
  const canonical = path.join(f.outputDir, "candidate.txt");
  const later = path.join(f.outputDir, "later.txt");
  await Promise.all([selected, canonical, later].map((file) => writeFile(file, "你好。\n下一句。")));
  await patchProjectState(f.outputDir, { translationPath: canonical, translationBindingOrigin: "canonical", builtinTaskTranslationPath: canonical,
    builtinTaskInputSettings: { ...f.settings, translationPath: selected } });
  assert.equal((await f.host.inspectSettings({ ...f.context, intent: "proofread" })).translationPath, selected);
  await patchProjectState(f.outputDir, { translationPath: later, translationBindingOrigin: "user" });
  assert.equal((await f.host.inspectSettings({ ...f.context, intent: "proofread" })).translationPath, later);
  await assert.rejects(validateBuiltinTaskSettings({ task: "proofread", settings: { ...f.settings, translationPath: f.sourcePath } }), /different paths/);
}));
