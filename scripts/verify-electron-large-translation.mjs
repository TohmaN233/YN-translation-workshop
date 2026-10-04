import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import electronPath from "electron";

const root = process.cwd();
const fixture = await mkdtemp(path.join(root, ".tmp-electron-large-validation-"));
try {
  await build({ absWorkingDir: root, entryPoints: ["scripts/verify-electron-large-translation-main.ts"], bundle: true,
    platform: "node", format: "esm", outfile: path.join(fixture, "main.mjs"),
    banner: { js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);' },
    external: ["electron", "electron-updater", "electron-updater/*", "extract-zip", "cheerio", "cheerio/*", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core/*"] });
  for (const worker of ["translationValidationWorker.js", "proofreadPrescanWorker.js", "sourcePreparationWorker.js"]) {
    await copyFile(path.join(root, "dist", "main", worker), path.join(fixture, worker));
  }
  let stdout = "";
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, ["--disable-gpu", "--no-sandbox", "--js-flags=--expose-gc", `--user-data-dir=${path.join(fixture, "user-data")}`, path.join(fixture, "main.mjs")],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        YN_ELECTRON_VERIFY_HEADLESS: "1", YN_ELECTRON_VERIFY_OFFSCREEN: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, `Electron large-file acceptance exited ${code}`);
  assert.ok(stdout.includes('"electronLargeFileAcceptance":true'), "Electron exited without completing the large-file acceptance.");
} finally {
  if (!path.resolve(fixture).startsWith(`${root}${path.sep}.tmp-electron-large-validation-`)) throw new Error("Unsafe fixture cleanup.");
  await rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
