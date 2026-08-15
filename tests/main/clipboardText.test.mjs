import { strict as assert } from "node:assert";

import { writeClipboardTextVerified } from "../../src/main/clipboardText.ts";

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

await test("clipboard write retries transient native clipboard contention and verifies the result", async () => {
  let value = "";
  let writes = 0;
  const copied = await writeClipboardTextVerified({
    writeText(text) {
      writes += 1;
      if (writes >= 3) value = text;
    },
    readText() {
      return value;
    }
  }, "latest Agent reply", 4);
  assert.equal(copied, true);
  assert.equal(writes, 3);
});

await test("clipboard write reports failure instead of claiming a copy that never persisted", async () => {
  let writes = 0;
  const copied = await writeClipboardTextVerified({
    writeText() {
      writes += 1;
    },
    readText() {
      return "";
    }
  }, "latest Agent reply", 2);
  assert.equal(copied, false);
  assert.equal(writes, 2);
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
