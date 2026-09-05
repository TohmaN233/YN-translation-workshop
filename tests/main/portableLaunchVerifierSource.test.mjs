import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const source = await readFile("scripts/verify-packaged-launch.mjs", "utf8");
const mainSource = await readFile("src/main/main.ts", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

assert.doesNotMatch(
  source,
  /Stop-Process\s+-Force/,
  "packaged verification must not force-kill Electron processes"
);
assert.doesNotMatch(
  source,
  /launcher\.kill\s*\(/,
  "packaged verification must not terminate the application behind its lifecycle"
);
assert.match(
  source,
  /windowsHide:\s*true/,
  "packaged verification must never display the product on the user's desktop"
);
assert.doesNotMatch(
  source,
  /CloseMainWindow/,
  "packaged verification must not drive Electron shutdown through an external WM_CLOSE"
);
assert.match(
  source,
  /YN_PORTABLE_SMOKE_MARKER:\s*markerPath/,
  "packaged verification must request the product-owned smoke lifecycle through the environment"
);
assert.match(
  source,
  /smoke marker/i,
  "packaged verification must verify a durable product-owned readiness marker"
);
assert.match(
  source,
  /Refusing to launch packaged verification beside an existing Translation Workshop process/,
  "packaged verification must not start beside a user's running product session"
);
assert.match(source, /win-unpacked/, "automatic launch acceptance must use the packaged app, not the NSIS portable envelope");
assert.doesNotMatch(source, /-Portable-/, "automatic acceptance must never execute the NSIS portable envelope");
assert.equal(
  packageJson.build?.portable?.unpackDirName,
  "translation-workshop-portable",
  "portable releases need a stable inner executable path so Windows Firewall permissions survive upgrades"
);
assert.match(
  mainSource,
  /YN_PORTABLE_SMOKE_MARKER/,
  "the packaged product must own its hidden smoke readiness and shutdown lifecycle"
);
assert.match(
  mainSource,
  /show:\s*!portableSmokeMarkerPath/,
  "the packaged smoke lifecycle must create its renderer without showing a window"
);

console.log("packaged launch verifier cleanup source test passed");
