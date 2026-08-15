import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const source = await readFile("src/renderer/App.tsx", "utf8");

assert.match(source, /className="customPreserveEditor"/);
assert.match(source, /t\.assetStyleGuide[\s\S]*className="customPreserveEditor"/);
assert.match(source, /onClick=\{addCustomPreserveRule\}/);
assert.match(source, /async function saveCustomPreserveRules\(\)/);
assert.match(
  source,
  /window\.workshop\.saveProject\(form\.outputDir, \{ customPreserveRules: rules \}\)/
);
assert.match(source, /customPreserveRules: savedCustomPreserveRules/);

console.log("1 passed, 0 failed");
