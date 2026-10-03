import assert from "node:assert/strict";
import vm from "node:vm";
import {
  BATCH_LINE_REVIEW_PROTOCOL_MARKER, LINE_REVIEW_PROTOCOL_MARKER, PROPOSAL_REVIEW_PROTOCOL_MARKER,
  renderBatchLineReviewIndexHtml, renderLineReviewHtml, renderProposalReviewHtml
} from "../../src/shared/core/html.ts";
import {
  needsLegacyBatchLineReviewUpgrade, needsLegacyLineReviewUpgrade, needsLegacyProposalReviewUpgrade,
  upgradeLegacyBatchLineReviewHtmlContent, upgradeLegacyLineReviewHtmlContent, upgradeLegacyProposalReviewHtmlContent
} from "../../src/shared/core/legacyHtml.ts";
import { characterBibleTableScript } from "../../src/shared/core/characterBibleTable.ts";

const workflow = {sourcePath:"C:/project/source.txt",translationPath:"C:/project/translation.txt",outputDir:"C:/project"};
const pages = [
  [renderLineReviewHtml({title:"Table",sourceText:"原文",translationText:"译文",workflow}),LINE_REVIEW_PROTOCOL_MARKER,needsLegacyLineReviewUpgrade,upgradeLegacyLineReviewHtmlContent],
  [renderProposalReviewHtml({title:"Table",proposals:[{id:"one",src:"原文",current:"译文",problemType:"style",problem:"改写",suggestion:"新译文",status:"unreviewed"}],outputDir:"C:/project"}),PROPOSAL_REVIEW_PROTOCOL_MARKER,needsLegacyProposalReviewUpgrade,upgradeLegacyProposalReviewHtmlContent],
  [renderBatchLineReviewIndexHtml({title:"Table",workflow,files:[{sourceName:"source.txt",sourcePath:"C:/project/source.txt",outputPath:"source.html",status:"matched",sourceLineCount:1}]}),BATCH_LINE_REVIEW_PROTOCOL_MARKER,needsLegacyBatchLineReviewUpgrade,upgradeLegacyBatchLineReviewHtmlContent]
];
for (const [html,marker,needsUpgrade,upgrade] of pages) {
  assert.match(html,/id="characterBibleToggle"/); assert.match(html,/id="characterBibleDialog"/); assert.match(html,/mutateProjectCharacterBibleEntry/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!match[0].includes('type="application/json"')) new vm.Script(match[1]);
  }
  const old = html.replace(marker,marker.replace(/v(\d+)$/,(_,version)=>"v"+(Number(version)-1)));
  assert.equal(needsUpgrade(old),true);
  const upgraded = upgrade(old,"Table");
  assert.match(upgraded,/id="characterBibleDialog"/); assert.match(upgraded,/list.id = "characterBibleMappings"/); assert.equal(needsUpgrade(upgraded),false);
}
console.log("ok line, proposal and batch character tables emit valid JavaScript and upgrade legacy pages");

class Node {
  constructor() { this.children=[]; this.handlers={}; this.dataset={}; this.textContent=""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=[...nodes]; }
  addEventListener(name,fn) { this.handlers[name]=fn; }
  showModal() { this.open=true; }
  setAttribute() {}
}
const ids = Object.fromEntries(["reviewData","characterBibleDialog","characterBibleEditor","characterBibleRows","characterBibleStatus","characterBibleEditorStatus","characterBibleFields","characterBibleForm","characterBibleToggle","characterBibleRefresh","characterBibleAdd","characterBibleClose","characterBibleCancel","characterBibleSave"].map(id=>[id,new Node()]));
ids.reviewData.textContent=JSON.stringify({workflow:{paths:{outputDir:"C:/project"}},locale:"en-US"});
const dangerous = '<img src=x onerror="throw Error(1)"> </script>';
const response = {characterBible:{characters:[{name:dangerous,target:'" & < >',aliases:[dangerous]}],revisions:{[dangerous]:"hash"}}};
vm.runInNewContext(characterBibleTableScript(),{
  document:{getElementById:id=>ids[id]||null,documentElement:{lang:"en-US"},createElement:()=>new Node()},
  window:{workshopHtml:{readProjectAssets:async()=>response},addEventListener(){}},
  console
});
ids.characterBibleToggle.handlers.click();
await new Promise(resolve=>setImmediate(resolve));
const row=ids.characterBibleRows.children[0];
assert.equal(row.children[0].textContent,dangerous); assert.equal(row.children[2].textContent,dangerous);
assert.equal(row.children[0].children.length,0);
assert.equal(ids.characterBibleStatus.textContent,"Character records refreshed.");
assert.ok(!characterBibleTableScript().includes("innerHTML"));
console.log("ok untrusted character names and aliases render as text without HTML execution");
