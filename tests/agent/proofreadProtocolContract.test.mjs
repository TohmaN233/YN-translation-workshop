import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const protocolRoot = path.resolve("translation-protocol");

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

const files = await filesBelow(protocolRoot);
const obsolete = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  const relative = path.relative(protocolRoot, file).replace(/\\/g, "/");
  if (/\bcompleteTask\b/.test(content) || (
    relative === "proofread-child.md" && /\bwriteProofreadFindings\b/.test(content)
  )) {
    obsolete.push(relative);
  }
}

assert.deepEqual(
  obsolete,
  [],
  "Packaged proofreading guidance must name only the restricted Pi child tools that actually exist"
);
console.log("ok packaged proofreading protocol contains no obsolete child tool names");
