import { spawn } from "node:child_process";
import { mkdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import electronPath from "electron";
import { build } from "esbuild";
const root = process.cwd();
const directory = path.join(root, "artifacts", "settlement-failure-2026-10-05", "electron");
await mkdir(directory, { recursive: true });
const external = ["electron", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core/*", "cheerio", "extract-zip"];
for (const [entry, name] of [["scripts/verify-electron-preservation-recovery-main.ts", "main.mjs"],
  ["tests/agent/piNativeTranslationAutomaticReviewRecovery.test.mjs", "recovery.mjs"]]) {
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: path.join(directory, name), external,
    banner: { js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);' } });
}
await copyFile(path.join(root, "dist/main/translationValidationWorker.js"), path.join(directory, "translationValidationWorker.js"));
await copyFile(path.join(root, "dist/main/proofreadPrescanWorker.js"), path.join(directory, "proofreadPrescanWorker.js"));
await copyFile(path.join(root, "dist/main/sourcePreparationWorker.js"), path.join(directory, "sourcePreparationWorker.js"));
const result = await new Promise((resolve, reject) => {
  const child = spawn(electronPath, ["--disable-gpu", "--no-sandbox", `--user-data-dir=${path.join(directory, "user-data")}`, path.join(directory, "main.mjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      YN_RECOVERY_VERIFY_DIR: directory, YN_RECOVERY_VERIFY_TEST: pathToFileURL(path.join(directory, "recovery.mjs")).href } });
  let output = "";
  child.stdout.on("data", data => { output += data; process.stdout.write(data); });
  child.stderr.on("data", data => process.stderr.write(data));
  child.once("error", reject);
  child.once("close", code => resolve({ code, output }));
  // Never terminate Electron to manufacture a passing exit. On timeout retain
  // its files/process for diagnosis; normal success quits from inside the app.
  const timeout = setTimeout(() => reject(new Error(`Electron verification did not finish; process ${child.pid} and diagnostics retained at ${directory}`)), 60000);
  child.once("close", () => clearTimeout(timeout));
});
if (result.code !== 0 || !result.output.includes('"preservationRecoveryElectron":true')) throw new Error(`Electron preservation/recovery verification failed (exit ${result.code}).`);
await rm(path.join(directory, "user-data"), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
