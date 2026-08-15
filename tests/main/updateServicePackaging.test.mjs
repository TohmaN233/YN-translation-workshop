import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const result = await build({
  entryPoints: [path.join(rootDir, "src/main/updateService.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  external: ["electron", "electron-updater"],
  logLevel: "silent"
});
const output = result.outputFiles[0]?.text ?? "";

assert.ok(output.includes("electron-updater"), "Updater service bundle no longer references electron-updater");
assert.doesNotMatch(
  output,
  /import\s*\{[^}]*\bautoUpdater\b[^}]*\}\s*from\s*["']electron-updater["']/u,
  "Packaged ESM main must not use a named import from CommonJS electron-updater"
);
assert.match(
  output,
  /PORTABLE_EXECUTABLE_FILE/u,
  "Windows portable builds must be detectable before initializing electron-updater"
);
assert.match(
  output,
  /canCheckForUpdates:\s*!portableWindowsBuild/u,
  "Windows portable builds must bypass the electron-updater check path"
);

console.log("updateService packaging interop test passed");
