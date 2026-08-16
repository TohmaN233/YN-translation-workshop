import { strict as assert } from "node:assert";

import { parseGlossaryText } from "../../src/shared/core/glossary.ts";

const entries = parseGlossaryText(JSON.stringify({
  entries: [
    { source: "王都騎士団", target: "王都骑士团" },
    { source: "勇者", target: "勇者" }
  ]
}));

assert.deepEqual(entries, [{ source: "王都騎士団", target: "王都骑士团" }]);
console.log("ok canonical project glossary JSON parses through the shared workflow parser");

assert.deepEqual(parseGlossaryText(JSON.stringify({ entries: [{
  source: "虹宮トーヤ",
  target: "虹宫斗也",
  aliases: ["虹宮", "虹宫"],
  info: "character name",
  status: "confirmed"
}] })), [{
  source: "虹宮トーヤ",
  target: "虹宫斗也",
  aliases: ["虹宮", "虹宫"],
  info: "character name",
  status: "confirmed"
}]);
console.log("ok structured glossary metadata survives the shared workflow parser");
