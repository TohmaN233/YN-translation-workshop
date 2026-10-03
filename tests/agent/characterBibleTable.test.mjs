import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mutateProjectCharacterBibleEntry, readProjectAssets, saveProjectAssets } from "../../src/main/agent/projectAssets.ts";

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-character-table-"));
try {
  let assets = await mutateProjectCharacterBibleEntry({outputDir,operation:"add",entry:{name:"アリス",target:"爱丽丝",voice:"温柔",role:"主角",aliases:["小爱"],requiredTerms:["先輩 -> 学长"]}});
  await mutateProjectCharacterBibleEntry({outputDir,operation:"add",entry:{name:"ベス",target:"贝丝",identity:"朋友"}});
  const stale = assets.characterBible.revisions["アリス"];
  await saveProjectAssets({outputDir,characterEntry:{name:"アリス",gender:"female"}});
  const before = await readProjectAssets({outputDir});
  await assert.rejects(mutateProjectCharacterBibleEntry({outputDir,operation:"update",name:"アリス",expectedRevision:stale,entry:{voice:"活泼"}}),/changed since/);
  await assert.rejects(mutateProjectCharacterBibleEntry({outputDir,operation:"delete",name:"アリス",expectedRevision:stale}),/changed since/);
  assert.deepEqual((await readProjectAssets({outputDir})).characterBible,before.characterBible);
  // A fresh table snapshot still permits editing Alice after another character is updated.
  await mutateProjectCharacterBibleEntry({outputDir,operation:"update",name:"ベス",expectedRevision:before.characterBible.revisions["ベス"],entry:{voice:"安静"}});
  assets = await mutateProjectCharacterBibleEntry({outputDir,operation:"update",name:"アリス",expectedRevision:before.characterBible.revisions["アリス"],entry:{target:"艾丽丝"}});
  const alice = assets.characterBible.characters.find(entry => entry.name === "アリス");
  assert.equal(alice.target,"艾丽丝"); assert.equal(alice.role,"主角"); assert.equal(alice.gender,"female");
  assert.deepEqual(alice.aliases,["小爱"]); assert.deepEqual(alice.requiredTerms,["先輩 -> 学长"]);
  assert.equal(assets.characterBible.characters.find(entry => entry.name === "ベス").voice,"安静");
  assert.equal(assets.available.glossary,false); assert.equal(assets.available.styleGuide,false);
  console.log("ok per-character revisions reject stale Agent writes and preserve unrelated records and fields");

  const snapshot = await readFile(assets.paths.characterBible,"utf8");
  for (const entry of [
    {requiredTerms:["plain term"]}, {requiredTerms:["アリス -> 艾丽丝"]}, {aliases:["x,y"]},
    {voice:"injected\n## Another"}, {unsupported:"hidden"}, {name:"ベス"}, {aliases:"bad"}
  ]) {
    await assert.rejects(mutateProjectCharacterBibleEntry({outputDir,operation:"update",name:"アリス",expectedRevision:assets.characterBible.revisions["アリス"],entry}));
    assert.equal(await readFile(assets.paths.characterBible,"utf8"),snapshot);
  }
  const races = await Promise.allSettled(["一","二"].map(voice => mutateProjectCharacterBibleEntry({outputDir,operation:"update",name:"アリス",expectedRevision:assets.characterBible.revisions["アリス"],entry:{voice}})));
  assert.equal(races.filter(result => result.status === "fulfilled").length,1);
  console.log("ok strict canonical schema rejects lossy input before writing and serializes conflicting edits");

  assets = await readProjectAssets({outputDir});
  const source = assets.characterBible.source;
  const bethSection = source.slice(source.indexOf("## ベス")) + "<!-- keep unrelated record annotation -->\n";
  await writeFile(assets.paths.characterBible,source.slice(0,source.indexOf("## ベス")) + "<!-- keep edited record annotation -->\n\n" + bethSection,"utf8");
  assets = await readProjectAssets({outputDir});
  assets = await mutateProjectCharacterBibleEntry({outputDir,operation:"update",name:"アリス",expectedRevision:assets.characterBible.revisions["アリス"],entry:{aliases:[],requiredTerms:[]}});
  assert.equal(assets.characterBible.source.slice(assets.characterBible.source.indexOf("## ベス")),bethSection);
  assert.ok(assets.characterBible.source.includes("<!-- keep edited record annotation -->"));
  assert.equal(assets.characterBible.characters[0].requiredTerms,undefined);
  await mutateProjectCharacterBibleEntry({outputDir,operation:"delete",name:"アリス",expectedRevision:assets.characterBible.revisions["アリス"]});
  assets = await readProjectAssets({outputDir});
  assert.deepEqual(assets.characterBible.characters.map(entry => entry.name),["ベス"]);
  await assert.rejects(mutateProjectCharacterBibleEntry({outputDir,operation:"add",entry:{name:"ベス"}}),/already exists/);
  console.log("ok clearing mappings and deleting a record preserve other record source content");
} finally {
  await rm(outputDir,{recursive:true,force:true});
}
