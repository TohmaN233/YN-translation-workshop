import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { upsertTaskAssetDraft, readTaskAssetDraft, deleteTaskAssetDraftEntries, checkTaskAssetDraft, commitTaskAssets, assertTaskAssetDraftCommitted } from "../src/main/taskAssetDrafts.ts";
import { importAutomationAssets } from "../src/main/automationAssets.ts";
import { readProjectAssets } from "../src/main/agent/projectAssets.ts";
import { subscribeProjectState, readProjectState } from "../src/main/projectState.ts";
import { createBuiltinTaskPreparationHost } from "../src/main/builtinTaskPreparationHost.ts";

async function project(fn) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-asset-drafts-"));
  try { await fn({ outputDir, sessionId: "session", preparationId: "preparation", intent: "assets" }); }
  finally { await rm(outputDir, { recursive: true, force: true }); }
}
const read = (context, kind = "glossary") => readTaskAssetDraft(context, { kind });
const check = (context, revision) => checkTaskAssetDraft(context, { expectedRevision: revision, reviewSummary: "Names and facts reviewed against the supplied references." });

test("reference preparation freely corrects own glossary and character draft before any formal write", () => project(async context => {
  const host = createBuiltinTaskPreparationHost({});
  let result = await host.importAssets(context, {
    glossary: [{ source: "ウォードバイパー", target: "守卫葺蛇", info: "wrong", aliases: ["错误"] }, { source: "Noise", target: "删掉" }],
    characters: [{ name: "Alice", target: "爱丽丝", gender: "male", voice: "wrong" }]
  });
  await assert.rejects(commitTaskAssets(context, { expectedRevision: result.revision }), /Check the current/);
  await assert.rejects(assertTaskAssetDraftCommitted(context), /not committed/);
  result = await host.importAssets(context, { expectedRevision: result.revision,
    glossary: [{ source: "ウォードバイパー", target: "守卫蝰蛇", info: "verified", aliases: [] }],
    characters: [{ name: "Alice", gender: "female", voice: null }]
  });
  result = await deleteTaskAssetDraftEntries(context, { kind: "glossary", keys: ["Noise"], expectedRevision: result.revision });
  assert.deepEqual((await read(context)).entries, [{ source: "ウォードバイパー", target: "守卫蝰蛇", info: "verified", aliases: [] }]);
  assert.deepEqual((await read(context, "characters")).entries, [{ name: "Alice", target: "爱丽丝", gender: "female" }]);
  await assert.rejects(readFile(path.join(context.outputDir, ".translation-workshop", "glossary.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(context.outputDir, "AI_translation", "_workspace", "character_bible.md")), { code: "ENOENT" });
  const checked = await check(context, result.revision);
  assert.equal(checked.status, "checked");
  assert.equal((await readProjectAssets(context)).available.glossary, false);
  const committed = await commitTaskAssets(context, { expectedRevision: result.revision });
  assert.equal(committed.status, "committed");
  const assets = await readProjectAssets(context);
  assert.equal(assets.glossary.entries[0].target, "守卫蝰蛇");
  assert.equal(assets.characterBible.characters[0].gender, "female");
  await assertTaskAssetDraftCommitted(context);
  assert.deepEqual(await commitTaskAssets(context, { expectedRevision: result.revision }), committed, "durable receipt makes retry idempotent");
  await assert.rejects(upsertTaskAssetDraft(context, { glossary: [] }), /already committed/);
}));

test("invalid facts and cross-asset conflicts remain editable after failed checks", () => project(async context => {
  let result = await upsertTaskAssetDraft(context, { glossary: [{ source: "Alice" }], characters: [{ name: "Alice", target: "艾丽丝", gender: "unknown-invalid" }] });
  await assert.rejects(check(context, result.revision), /target|gender/);
  result = await upsertTaskAssetDraft(context, { glossary: [{ source: "Alice", target: "爱丽丝" }], characters: [{ name: "Alice", gender: "female" }] });
  await assert.rejects(check(context, result.revision), /Formal asset conflict/);
  result = await upsertTaskAssetDraft(context, { characters: [{ name: "Alice", target: "爱丽丝" }] });
  await check(context, result.revision);
  const updated = await upsertTaskAssetDraft(context, { glossary: [{ source: "Alice", info: "new evidence" }] });
  await assert.rejects(commitTaskAssets(context, { expectedRevision: result.revision }), /draft changed/);
  await assert.rejects(commitTaskAssets(context, { expectedRevision: updated.revision }), /Check the current/);
  await check(context, updated.revision);
  await commitTaskAssets(context, { expectedRevision: updated.revision });
}));

test("formal changes invalidate checked draft; existing facts and unrelated annotations remain authoritative", () => project(async context => {
  const initial = await importAutomationAssets({ outputDir: context.outputDir, glossary: [{ source: "Old", target: "旧" }], characters: [{ name: "Old", target: "旧" }] });
  const original = (await readFile(initial.paths.characterBible, "utf8")).replace("## Old", "## Old\n<!-- keep annotation -->");
  await writeFile(initial.paths.characterBible, original);
  let draft = await upsertTaskAssetDraft(context, { glossary: [{ source: "Old", target: "新" }], characters: [{ name: "New", target: "新" }] });
  await assert.rejects(check(context, draft.revision), /Glossary conflict/);
  draft = await upsertTaskAssetDraft(context, { glossary: [{ source: "Old", target: "旧" }] });
  await check(context, draft.revision);
  await importAutomationAssets({ outputDir: context.outputDir, glossary: [{ source: "Other", target: "别的" }] });
  await assert.rejects(commitTaskAssets(context, { expectedRevision: draft.revision }), /Formal assets changed/);
  assert.equal((await read(context)).status, "checked");
  await check(context, draft.revision);
  await commitTaskAssets(context, { expectedRevision: draft.revision });
  const assets = await readProjectAssets(context);
  assert.equal(assets.glossary.entries.find(entry => entry.source === "Old").target, "旧");
  assert.ok(assets.glossary.entries.some(entry => entry.source === "Other"));
  assert.ok(assets.characterBible.source.includes(original.slice(original.indexOf("## Old"))));
}));

test("formal transaction failure rolls back both assets, project binding and commit receipt; same draft can retry", () => project(async context => {
  const draft = await upsertTaskAssetDraft(context, { glossary: [{ source: "Alice", target: "爱丽丝" }], characters: [{ name: "Alice", target: "爱丽丝" }] });
  await check(context, draft.revision);
  const before = await readFile(draft.draftPath, "utf8");
  const stop = subscribeProjectState(root => { if (root === context.outputDir) throw new Error("injected commit failure"); });
  try { await assert.rejects(commitTaskAssets(context, { expectedRevision: draft.revision }), /injected commit failure/); }
  finally { stop(); }
  assert.equal(await readFile(draft.draftPath, "utf8"), before);
  assert.equal((await read(context)).status, "checked");
  const assets = await readProjectAssets(context);
  assert.equal(assets.available.glossary, false);
  assert.equal(assets.available.characterBible, false);
  assert.equal((await readProjectState(context.outputDir)).glossaryPath, undefined);
  await commitTaskAssets(context, { expectedRevision: draft.revision });
}));

test("Stop and cold follow-up retain the draft; concurrent edits use revisions and ownership is enforced", () => project(async context => {
  const initial = await upsertTaskAssetDraft(context, { glossary: [{ source: "Alice", target: "wrong" }, { source: "Bob", target: "鲍勃" }] });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(upsertTaskAssetDraft(context, { glossary: [{ source: "Alice", target: "爱丽丝" }] }, controller.signal), { name: "AbortError" });
  assert.equal((await read({ ...context })).entries[0].target, "wrong");
  const attempts = await Promise.allSettled([
    upsertTaskAssetDraft(context, { expectedRevision: initial.revision, glossary: [{ source: "Alice", target: "爱丽丝" }] }),
    upsertTaskAssetDraft(context, { expectedRevision: initial.revision, characters: [{ name: "Alice", target: "爱丽丝" }] })
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.match(attempts.find(result => result.status === "rejected").reason.message, /draft changed/);
  assert.equal((await read(context)).entries[0].target, "爱丽丝");
  const page = await readTaskAssetDraft(context, { kind: "glossary", limit: 1 });
  assert.equal(page.nextOffset, 1);
  assert.equal((await readTaskAssetDraft(context, { kind: "glossary", offset: page.nextOffset, limit: 1 })).entries[0].source, "Bob");
  await assert.rejects(read({ ...context, sessionId: "other" }), /another preparation/);
  assert.equal((await read({ ...context, preparationId: "other" })).counts.glossary, 0);
  await writeFile(initial.draftPath, "{broken-json");
  await assert.rejects(read(context), SyntaxError);
}));

test("draft paths reject symlink escapes before reading or writing", () => project(async context => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "yn-draft-outside-"));
  try {
    const agent = path.join(context.outputDir, ".translation-workshop", "agent");
    await mkdir(agent, { recursive: true });
    await symlink(outside, path.join(agent, "asset-drafts"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(upsertTaskAssetDraft(context, { glossary: [] }), /outside the project/);
    await assert.rejects(read({ ...context, preparationId: "../outside" }), /ownership/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

for (const extension of ["md", "json"]) {
  test(`checking and failed commit leave legacy character ${extension} input intact`, () => project(async context => {
    const workspace = path.join(context.outputDir, ".translation-workshop");
    await mkdir(workspace);
    const legacyPath = path.join(workspace, `character_bible.${extension}`);
    const original = extension === "md" ? "# Character Bible\n\n## Old\n<!-- retain -->\n- Localized name: 旧\n" : JSON.stringify({ characters: [{ name: "Old", target: "旧" }] });
    await writeFile(legacyPath, original);
    const draft = await upsertTaskAssetDraft(context, { glossary: [{ source: "Alice", target: "爱丽丝" }], characters: [{ name: "Alice", target: "爱丽丝" }] });
    await check(context, draft.revision);
    const canonical = path.join(context.outputDir, "AI_translation", "_workspace", "character_bible.md");
    await assert.rejects(readFile(canonical), { code: "ENOENT" });
    const stop = subscribeProjectState(root => { if (root === context.outputDir) throw new Error("legacy rollback test"); });
    try { await assert.rejects(commitTaskAssets(context, { expectedRevision: draft.revision }), /legacy rollback test/); }
    finally { stop(); }
    assert.equal(await readFile(legacyPath, "utf8"), original);
    await assert.rejects(readFile(canonical), { code: "ENOENT" });
    await commitTaskAssets(context, { expectedRevision: draft.revision });
    assert.equal(await readFile(legacyPath, "utf8"), original);
    const text = await readFile(canonical, "utf8");
    assert.match(text, /## Old/); assert.match(text, /## Alice/);
    if (extension === "md") assert.match(text, /<!-- retain -->/);
  }));
}
