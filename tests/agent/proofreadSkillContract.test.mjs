import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const skillRoot = path.resolve("skills/proofread-translation");

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

const files = await filesBelow(skillRoot);
const obsolete = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  const relative = path.relative(skillRoot, file).replace(/\\/g, "/");
  if (/\bcompleteTask\b/.test(content) || (
    relative.endsWith("subagent-task-template.md") && /\bwriteProofreadFindings\b/.test(content)
  )) {
    obsolete.push(relative);
  }
}

assert.deepEqual(
  obsolete,
  [],
  "Packaged proofreading guidance must name only the restricted Pi child tools that actually exist"
);
console.log("ok packaged proofreading guidance contains no obsolete child tool protocol");
