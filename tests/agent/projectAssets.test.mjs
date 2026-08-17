import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  approveAssetProposal,
  listAssetProposals,
  proposeAssetUpdate,
  readProjectCharacterEntries,
  readProjectAssets,
  readProjectStyleForbiddenTerms,
  readProjectTranslationValidationAssets,
  readWorkflowProjectAssets,
  readWorkflowTranslationValidationAssets,
  saveProjectAssets
} from "../../src/main/agent/projectAssets.ts";
import { commitWorkspaceGlossaryCandidates } from "../../src/main/agent/workspaceAssets.ts";

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

await test("concurrent provisional glossary commits serialize and preserve the first conflict target", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-candidate-commit-"));
  try {
    const [first, second] = await Promise.all([
      commitWorkspaceGlossaryCandidates(outputDir, [{
        source: "ゲートオープン",
        target: "开门",
        status: "pending"
      }]),
      commitWorkspaceGlossaryCandidates(outputDir, [{
        source: "ゲートオープン",
        target: "开启战门",
        status: "pending"
      }])
    ]);
    assert.equal(first.outcomes[0].status, "inserted");
    assert.equal(second.outcomes[0].status, "conflict");
    const candidate = JSON.parse(await readFile(
      path.join(outputDir, "AI_translation", "_workspace", "glossary_candidates.json"),
      "utf8"
    ));
    assert.deepEqual(candidate.entries.map((entry) => [entry.source, entry.target]), [["ゲートオープン", "开门"]]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("provisional glossary commits remove aliases owned by a different primary source", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-candidate-alias-owner-"));
  try {
    await commitWorkspaceGlossaryCandidates(outputDir, [{
      source: "ホン・チーメイ",
      target: "洪芝梅",
      aliases: ["チー"],
      status: "pending"
    }, {
      source: "チー",
      target: "奇",
      status: "pending"
    }]);
    const candidate = JSON.parse(await readFile(
      path.join(outputDir, "AI_translation", "_workspace", "glossary_candidates.json"),
      "utf8"
    ));
    assert.equal(Object.hasOwn(candidate.entries[0], "aliases"), false,
      "a target alternative cannot also identify a different source/target record");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("a selected glossary stays authoritative while workflow reads retain nonconflicting canonical terms", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-selected-glossary-project-"));
  const referenceDir = await mkdtemp(path.join(os.tmpdir(), "tw-selected-glossary-reference-"));
  const selectedPath = path.join(referenceDir, "selected.json");
  try {
    await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
    await writeFile(path.join(outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
      entries: [
        { source: "Alice", target: "错误旧译" },
        { source: "Archive", target: "档案馆" }
      ]
    }), "utf8");
    await writeFile(selectedPath, JSON.stringify({ entries: [{
      source: "Alice",
      target: "爱丽丝",
      aliases: ["艾丽丝"],
      status: "confirmed"
    }] }), "utf8");

    const assets = await readWorkflowProjectAssets({ outputDir, glossaryPath: selectedPath });
    assert.equal(assets.paths.glossary, selectedPath);
    assert.equal(assets.available.glossary, true);
    assert.deepEqual(assets.glossary.entries, [
      {
        source: "Alice",
        target: "爱丽丝",
        aliases: ["艾丽丝"],
        status: "confirmed"
      },
      { source: "Archive", target: "档案馆" }
    ]);
    const validation = await readWorkflowTranslationValidationAssets({ outputDir, glossaryPath: selectedPath });
    assert.deepEqual(validation.glossaryEntries, assets.glossary.entries);
    assert.deepEqual((await readProjectAssets({ outputDir })).glossary.entries, [
      { source: "Alice", target: "错误旧译" },
      { source: "Archive", target: "档案馆" }
    ], "reading a selected reference must not import or overwrite it into the canonical asset");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(referenceDir, { recursive: true, force: true });
  }
});

await test("a missing or unparseable selected glossary fails instead of falling back to canonical", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-selected-glossary-fail-fast-project-"));
  const referenceDir = await mkdtemp(path.join(os.tmpdir(), "tw-selected-glossary-fail-fast-reference-"));
  const selectedPath = path.join(referenceDir, "selected.json");
  try {
    await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
    await writeFile(path.join(outputDir, ".translation-workshop", "glossary.json"), JSON.stringify({
      entries: [{ source: "Alice", target: "旧译" }]
    }), "utf8");
    await assert.rejects(
      readWorkflowProjectAssets({ outputDir, glossaryPath: selectedPath }),
      /Failed to read selected glossary/i
    );
    await writeFile(selectedPath, JSON.stringify({ entries: [{ source: "Alice" }] }), "utf8");
    await assert.rejects(
      readWorkflowTranslationValidationAssets({ outputDir, glossaryPath: selectedPath }),
      /no parseable source\/target entries/i
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(referenceDir, { recursive: true, force: true });
  }
});

await test("asset proposals require approval before writing formal assets without a separate decision ledger", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const proposed = await proposeAssetUpdate({
      outputDir,
      kind: "glossary",
      entry: { source: "王都騎士団", target: "王都骑士团" },
      reason: "term consistency"
    });
    assert.equal(proposed.status, "pending");

    let assets = await readProjectAssets({ outputDir });
    assert.deepEqual(assets.glossary.entries, []);
    assert.equal(assets.available.characterBible, false);
    assert.match(assets.paths.translationMemory, /translation_memory\.sqlite$/);
    assert.equal(assets.translationMemory.initialized, false);
    assert.equal(assets.translationMemory.segmentCount, 0);
    assert.equal((await listAssetProposals({ outputDir })).length, 1);

    const approved = await approveAssetProposal({
      outputDir,
      proposalId: proposed.id,
      approvedBy: "human"
    });
    assert.equal(approved.status, "approved");

    assets = await readProjectAssets({ outputDir });
    assert.deepEqual(assets.glossary.entries, [{ source: "王都騎士団", target: "王都骑士团" }]);
    await assert.rejects(
      readFile(path.join(outputDir, ".translation-workshop", "decisions.jsonl"), "utf8"),
      (error) => error?.code === "ENOENT"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("invalid asset proposals fail before entering the approval queue", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const glossaryPath = path.join(outputDir, ".translation-workshop", "glossary.json");
    await assert.rejects(
      proposeAssetUpdate({
        outputDir,
        kind: "glossary",
        entry: { source: "勇者" }
      }),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries\[0\]\.target must be a non-empty string/i.test(error.message)
    );
    assert.deepEqual(await listAssetProposals({ outputDir }), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("corrupt proposal records fail fast instead of disappearing from the queue", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const proposalsDir = path.join(outputDir, ".translation-workshop", "asset-proposals");
    await mkdir(proposalsDir, { recursive: true });
    const proposalPath = path.join(proposalsDir, "broken.json");
    await writeFile(proposalPath, JSON.stringify({}), "utf8");
    await assert.rejects(
      listAssetProposals({ outputDir }),
      (error) => error instanceof Error
        && error.message.includes(proposalPath)
        && /invalid asset proposal/i.test(error.message)
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("character proposals write character_bible only after approval", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const proposed = await proposeAssetUpdate({
      outputDir,
      kind: "character_bible",
      entry: { name: "遥娜", voice: "古风、自称咱家" },
      reason: "voice consistency"
    });
    const approved = await approveAssetProposal({ outputDir, proposalId: proposed.id });
    assert.equal(approved.status, "approved");

    const assets = await readProjectAssets({ outputDir });
    assert.deepEqual(assets.characterBible.characters, [{
      name: "遥娜",
      genderConfidence: "unknown",
      voice: "古风、自称咱家"
    }]);
    assert.match(assets.paths.characterBible, /character_bible\.md$/);
    assert.match(await readFile(assets.paths.characterBible, "utf8"), /^# Character Bible/m);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("the project character bible is the same Markdown asset used by the Pi workflow", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const characterPath = path.join(outputDir, "AI_translation", "_workspace", "character_bible.md");
    await mkdir(path.dirname(characterPath), { recursive: true });
    await writeFile(
      characterPath,
      "# Character Bible\n\n## 勇者 / 勇者\n- Gender/pronouns: male; he/him; inferred\n- Terms of address: 勇者\n",
      "utf8"
    );

    const assets = await readProjectAssets({ outputDir });
    assert.equal(assets.paths.characterBible, characterPath);
    assert.equal(assets.available.characterBible, true);
    assert.equal(assets.characterBible.characters.length, 1);
    assert.match(String(assets.characterBible.characters[0].name), /勇者/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("the temporary hidden Markdown path migrates into the Pi workflow workspace", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const hiddenPath = path.join(outputDir, ".translation-workshop", "character_bible.md");
    const canonicalPath = path.join(outputDir, "AI_translation", "_workspace", "character_bible.md");
    await mkdir(path.dirname(hiddenPath), { recursive: true });
    await writeFile(
      hiddenPath,
      "# Character Bible\n\n## 勇者 / 勇者\n- Gender/pronouns: male; he/him; inferred\n- Terms of address: 勇者\n",
      "utf8"
    );

    const assets = await readProjectAssets({ outputDir });
    assert.equal(assets.paths.characterBible, canonicalPath);
    assert.match(await readFile(canonicalPath, "utf8"), /## 勇者/);
    await assert.rejects(readFile(hiddenPath, "utf8"), (error) => error && error.code === "ENOENT");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("legacy JSON character bible migrates once to the canonical Markdown asset", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "character_bible.json"), JSON.stringify({
      characters: [{
        name: "遥娜",
        target: "遥娜",
        gender: "female",
        pronouns: "she/her",
        genderConfidence: "confirmed",
        requiredTerms: ["私 -> 咱家"]
      }]
    }), "utf8");
    const migratedReads = await Promise.all(
      Array.from({ length: 8 }, () => readProjectAssets({ outputDir }))
    );
    const assets = migratedReads[0];
    assert.ok(migratedReads.every((value) => value.characterBible.characters[0]?.gender === "female"));
    assert.match(assets.paths.characterBible, /character_bible\.md$/);
    assert.equal(assets.characterBible.characters[0].gender, "female");
    const markdown = await readFile(assets.paths.characterBible, "utf8");
    assert.match(markdown, /## 遥娜/);
    assert.match(markdown, /Gender\/pronouns:/i);
    assert.match(markdown, /Gender\/pronouns:\s*female;\s*she\/her;\s*confirmed/i);
    await assert.rejects(
      readFile(path.join(workspace, "character_bible.json"), "utf8"),
      (error) => error && error.code === "ENOENT"
    );
    assert.match(
      await readFile(path.join(workspace, "legacy", "character_bible.json.migrated"), "utf8"),
      /遥娜/
    );
    await rm(assets.paths.characterBible);
    const reopened = await readProjectAssets({ outputDir });
    assert.deepEqual(reopened.characterBible.characters, []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("all concurrent glossary mutations share one serialized writer", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    await Promise.all(Array.from({ length: 24 }, (_, index) => saveProjectAssets({
      outputDir,
      glossaryEntry: { source: `term-${index}`, target: `译名-${index}` }
    })));
    const assets = await readProjectAssets({ outputDir });
    assert.equal(assets.glossary.entries.length, 24);
    assert.deepEqual(
      new Set(assets.glossary.entries.map((entry) => entry.source)),
      new Set(Array.from({ length: 24 }, (_, index) => `term-${index}`))
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("duplicate glossary proposals merge before human approval", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const first = await proposeAssetUpdate({
      outputDir,
      kind: "glossary",
      entry: { source: "王都騎士団", target: "王都骑士团", aliases: ["骑士团"] },
      reason: "shard 1"
    });
    const second = await proposeAssetUpdate({
      outputDir,
      kind: "glossary",
      entry: { source: "王都騎士団", target: "首都骑士团", aliases: ["王城骑士团"] },
      reason: "shard 2"
    });
    assert.equal(second.id, first.id);

    const proposals = await listAssetProposals({ outputDir });
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0].entry.aliases, ["骑士团", "王城骑士团"]);
    assert.deepEqual(proposals[0].entry.alternatives, ["首都骑士团"]);
    assert.match(proposals[0].reason, /shard 1/);
    assert.match(proposals[0].reason, /shard 2/);

    await approveAssetProposal({ outputDir, proposalId: first.id });
    const assets = await readProjectAssets({ outputDir });
    assert.deepEqual(assets.glossary.entries, [{
      source: "王都騎士団",
      target: "王都骑士团",
      aliases: ["骑士团", "王城骑士团"],
      alternatives: ["首都骑士团"]
    }]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("approving a glossary proposal can choose an alternative target", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const proposed = await proposeAssetUpdate({
      outputDir,
      kind: "glossary",
      entry: { source: "王都騎士団", target: "王都骑士团", alternatives: ["首都骑士团"] },
      reason: "term conflict"
    });

    await approveAssetProposal({
      outputDir,
      proposalId: proposed.id,
      entry: { ...proposed.entry, target: "首都骑士团", alternatives: ["王都骑士团"] }
    });
    const assets = await readProjectAssets({ outputDir });
    assert.equal(assets.glossary.entries[0].target, "首都骑士团");
    assert.deepEqual(assets.glossary.entries[0].alternatives, ["王都骑士团"]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("asset approval rejects an invalid edited entry without approving or persisting it", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const proposed = await proposeAssetUpdate({
      outputDir,
      kind: "glossary",
      entry: { source: "勇者", target: "勇者" }
    });
    const glossaryPath = path.join(outputDir, ".translation-workshop", "glossary.json");
    await assert.rejects(
      approveAssetProposal({
        outputDir,
        proposalId: proposed.id,
        entry: { source: "勇者" }
      }),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries\[0\]\.target must be a non-empty string/i.test(error.message)
    );
    assert.deepEqual((await readProjectAssets({ outputDir })).glossary.entries, []);
    assert.equal((await listAssetProposals({ outputDir }))[0].status, "pending");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("style guide forbidden terms parse only explicit opt-in lines", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "style_guide.md"),
      [
        "# Style",
        "Avoid stiff prose in general.",
        "forbidden: 机器翻译腔, 欧化句式",
        "禁止：`违和称呼`、\"硬直译\"",
        "note: 这一行不应被解析"
      ].join("\n"),
      "utf8"
    );
    const terms = await readProjectStyleForbiddenTerms(outputDir);
    assert.deepEqual(terms, ["机器翻译腔", "欧化句式", "违和称呼", "硬直译"]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("character bible exposes explicit voice validator terms", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    await saveProjectAssets({
      outputDir,
      characterEntry: {
        name: "遥娜",
        target: "遥娜",
        requiredTerms: ["私 -> 咱家"],
        forbiddenTerms: ["机器翻译腔"]
      }
    });
    const entries = await readProjectCharacterEntries(outputDir);
    assert.deepEqual(entries, [{
      name: "遥娜",
      target: "遥娜",
      aliases: undefined,
      genderConfidence: "unknown",
      requiredTerms: ["私 -> 咱家"],
      forbiddenTerms: ["机器翻译腔"]
    }]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("handwritten character required terms reject names and bare words", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    await assert.rejects(
      saveProjectAssets({
        outputDir,
        characterEntry: { name: "遥娜", target: "遥娜", requiredTerms: ["咱家"] }
      }),
      /source -> target/i
    );
    await assert.rejects(
      saveProjectAssets({
        outputDir,
        characterEntry: { name: "遥娜", target: "遥娜", requiredTerms: ["遥娜 -> 咱家"] }
      }),
      /cannot use a character name/i
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("formal validation assets fail fast instead of disappearing when JSON is corrupt", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    const glossaryPath = path.join(workspace, "glossary.json");
    await writeFile(glossaryPath, "{ not valid JSON", "utf8");
    await assert.rejects(
      readProjectTranslationValidationAssets(outputDir),
      (error) => error instanceof Error
        && error.message.includes("Invalid JSON project asset")
        && error.message.includes(glossaryPath)
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("formal validation assets reject valid JSON whose rule collections have an invalid schema", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    const glossaryPath = path.join(workspace, "glossary.json");
    await writeFile(glossaryPath, JSON.stringify({}), "utf8");
    await assert.rejects(
      readProjectTranslationValidationAssets(outputDir),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries must be present/i.test(error.message)
    );

    await writeFile(glossaryPath, JSON.stringify({ entries: { source: "勇者", target: "勇者" } }), "utf8");
    await assert.rejects(
      readProjectTranslationValidationAssets(outputDir),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries must be an array/i.test(error.message)
    );

    await writeFile(glossaryPath, JSON.stringify({ entries: [] }), "utf8");
    const characterPath = path.join(workspace, "character_bible.json");
    await writeFile(characterPath, JSON.stringify({ characters: ["invalid character rule"] }), "utf8");
    await assert.rejects(
      readProjectTranslationValidationAssets(outputDir),
      (error) => error instanceof Error
        && error.message.includes(characterPath)
        && /characters\[0\] must be an object/i.test(error.message)
    );

    await writeFile(characterPath, JSON.stringify({ characters: [] }), "utf8");
    await writeFile(glossaryPath, JSON.stringify({ entries: [{ source: "勇者" }] }), "utf8");
    await assert.rejects(
      readProjectTranslationValidationAssets(outputDir),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries\[0\]\.target must be a non-empty string/i.test(error.message)
    );
    await assert.rejects(
      readProjectAssets({ outputDir }),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries\[0\]\.target must be a non-empty string/i.test(error.message)
    );

    await writeFile(glossaryPath, JSON.stringify({ entries: [] }), "utf8");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("formal project assets can be edited through the schema-lite save API", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    await saveProjectAssets({
      outputDir,
      glossaryEntry: { source: "鳳凰院", target: "凤凰院", aliases: ["凤院"] },
      characterEntry: {
        name: "遥娜",
        target: "遥娜",
        aliases: ["HARUNA"],
        requiredTerms: ["私 -> 咱家"],
        forbiddenTerms: ["机器翻译腔"]
      },
      styleGuide: "禁止：硬直译\n"
    });
    await saveProjectAssets({
      outputDir,
      glossaryEntry: { source: "鳳凰院", target: "凤凰院凶真", aliases: ["凶真"] }
    });
    const assets = await readProjectAssets({ outputDir });
    assert.deepEqual(assets.glossary.entries, [{
      source: "鳳凰院",
      target: "凤凰院",
      aliases: ["凤院", "凶真"],
      alternatives: ["凤凰院凶真"]
    }]);
    assert.equal(assets.characterBible.characters[0].name, "遥娜");
    assert.equal(assets.styleGuide, "禁止：硬直译\n");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("formal asset saves reject invalid entries before persisting them", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const glossaryPath = path.join(outputDir, ".translation-workshop", "glossary.json");
    await assert.rejects(
      saveProjectAssets({
        outputDir,
        glossaryEntry: { source: "勇者" }
      }),
      (error) => error instanceof Error
        && error.message.includes(glossaryPath)
        && /entries\[0\]\.target must be a non-empty string/i.test(error.message)
    );
    const assets = await readProjectAssets({ outputDir });
    assert.deepEqual(assets.glossary.entries, []);

    const invalidExisting = JSON.stringify({ entries: [{ source: "破损规则" }] }, null, 2);
    await mkdir(path.dirname(glossaryPath), { recursive: true });
    await writeFile(glossaryPath, invalidExisting, "utf8");
    await assert.rejects(
      saveProjectAssets({
        outputDir,
        glossaryEntry: { source: "勇者", target: "勇者" }
      }),
      /entries\[0\]\.target must be a non-empty string/i
    );
    assert.equal(await readFile(glossaryPath, "utf8"), invalidExisting);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("combined formal asset saves validate the whole request before publishing any file", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    const glossaryPath = path.join(workspace, "glossary.json");
    const characterPath = path.join(outputDir, "AI_translation", "_workspace", "character_bible.md");
    const stylePath = path.join(workspace, "style_guide.md");
    await assert.rejects(
      saveProjectAssets({
        outputDir,
        glossaryEntry: { source: "勇者", target: "勇者" },
        characterEntry: { target: "遥娜" },
        styleGuide: "禁止：硬直译\n"
      }),
      (error) => error instanceof Error
        && error.message.includes(characterPath)
        && /characters\[0\]\.name must be a non-empty string/i.test(error.message)
    );
    for (const filePath of [glossaryPath, characterPath, stylePath]) {
      await assert.rejects(
        readFile(filePath, "utf8"),
        (error) => error && error.code === "ENOENT"
      );
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("saving one formal asset refuses to publish while another formal asset is corrupt", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "tw-assets-"));
  try {
    const workspace = path.join(outputDir, ".translation-workshop");
    await mkdir(workspace, { recursive: true });
    const characterPath = path.join(workspace, "character_bible.json");
    const stylePath = path.join(workspace, "style_guide.md");
    await writeFile(characterPath, JSON.stringify({ characters: [{ target: "遥娜" }] }), "utf8");
    await writeFile(stylePath, "old style\n", "utf8");
    await assert.rejects(
      saveProjectAssets({ outputDir, styleGuide: "new style\n" }),
      (error) => error instanceof Error
        && error.message.includes(characterPath)
        && /characters\[0\]\.name must be a non-empty string/i.test(error.message)
    );
    assert.equal(await readFile(stylePath, "utf8"), "old style\n");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test("asset approval is exposed through IPC and the React approval panel", async () => {
  const main = await readFile("src/main/main.ts", "utf8");
  const ipc = await readFile("src/main/ipc/agentAssetHandlers.ts", "utf8");
  const preload = await readFile("src/main/preload.ts", "utf8");
  const app = await readFile("src/renderer/App.tsx", "utf8");
  const html = await readFile("src/shared/core/html.ts", "utf8");
  const globals = await readFile("src/renderer/global.d.ts", "utf8");
  const projectAssets = await readFile("src/main/agent/projectAssets.ts", "utf8");
  const workspaceAssets = await readFile("src/main/agent/workspaceAssets.ts", "utf8");
  assert.match(main, /registerAgentAssetIpc/);
  assert.doesNotMatch(main, /from "\.\/agent\/projectAssets\.ts"/);
  assert.match(ipc, /agent-assets:listProposals/);
  assert.match(ipc, /agent-assets:approveProposal/);
  assert.match(ipc, /agent-assets:save/);
  assert.match(ipc, /agent-assets:importGlossaryFile/);
  assert.match(ipc, /agent-assets:replaceGlossary/);
  assert.match(ipc, /agent-assets:updateGlossaryEntry/);
  assert.match(ipc, /agent-assets:projectUpdate/);
  assert.match(ipc, /path\.isAbsolute\(outputDir\)/);
  assert.match(preload, /saveProjectAssets/);
  assert.match(preload, /importProjectGlossaryFile/);
  assert.match(preload, /replaceProjectGlossary/);
  assert.match(preload, /updateProjectGlossaryEntry/);
  assert.match(preload, /listAssetProposals/);
  assert.match(preload, /approveAssetProposal/);
  assert.doesNotMatch(main, /files:writeGlossaryFile|WriteGlossaryFileArgs/);
  assert.doesNotMatch(preload, /writeGlossaryFile|files:writeGlossaryFile/);
  assert.doesNotMatch(globals, /writeGlossaryFile/);
  assert.doesNotMatch(html, /writeGlossaryFile/);
  assert.doesNotMatch(projectAssets, /legacyCharacterMigrationQueues/);
  assert.match(projectAssets, /AI_translation["'],\s*["']_workspace["'],\s*["']character_bible\.md["']/);
  assert.match(projectAssets, /enqueueProjectAssetWrite\(args\.outputDir, async \(\) => \{\s*await ensureLegacyCharacterBibleMigratedUnlocked/);
  assert.match(workspaceAssets, /mergeProjectGlossaryEntries/);
  assert.match(workspaceAssets, /commitWorkspaceGlossaryCandidates/);
  assert.match(workspaceAssets, /writeTextFileAtomically/);
  assert.doesNotMatch(workspaceAssets, /\.translation-workshop["'],\s*["']glossary\.json/);
  assert.match(app, /readProjectAssets/);
  assert.match(app, /saveProjectAssets/);
  assert.match(app, /assetRows\(\)\.map/);
  assert.match(app, /row\.path && row\.exists !== false/);
  assert.match(app, /translationMemory\?\.segmentCount/);
  assert.doesNotMatch(app, /translationMemory\?\.totalPairs/);
  assert.match(app, /window\.workshop\.openPath\(asset\.path\)/);
  assert.match(app, /function saveGlossaryEntry\(\)/);
  assert.match(app, /function saveCharacterEntry\(\)/);
  assert.match(app, /assetRequiredSource/);
  assert.match(app, /normalizeHandwrittenCharacterRequiredTerms/);
  assert.match(app, /function saveStyleGuide\(\)/);
  assert.match(app, /projectAssetEditor/);
  assert.match(app, /function glossaryAssetProposals\(\)/);
  assert.match(app, /function approveGlossaryAssetProposals\(\)/);
  assert.match(app, /glossaryAssetProposals\(\)\.length > 0/);
  assert.match(app, /approveGlossaryBatch/);
  assert.match(app, /assetProposals\.map/);
  assert.match(app, /function proposalTargetOptions\(proposal: AssetProposal\)/);
  assert.match(app, /entry\.alternatives/);
  assert.match(app, /className=\{target === String\(proposal\.entry\?\.\[proposalTargetKey\(proposal\)\] \?\? ""\) \? "active" : ""\}/);
  assert.match(app, /selectProposalTarget\(proposal, target\)/);
  assert.match(app, /approveAssetProposal\(proposal\)/);
  assert.match(app, /window\.workshop\.approveAssetProposal\(\{ outputDir: form\.outputDir, proposalId: proposal\.id, entry: proposal\.entry \}\)/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
