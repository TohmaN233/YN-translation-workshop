import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const tempDir = await mkdtemp(path.join(root, ".tmp-electron-builtin-tasks-"));
const userDataDir = await mkdtemp(path.join(root, ".tmp-electron-builtin-user-"));
try {
  const external = ["electron", "electron-updater", "electron-updater/*", "extract-zip", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core/*"];
  // Independent upstream baseline: no YN imports or product window lifecycle.
  const baselinePath = path.join(tempDir, "browser-view-baseline.mjs");
  await writeFile(baselinePath, `import { app, BrowserWindow, BrowserView } from "electron";
app.disableHardwareAcceleration(); void app.whenReady().then(async () => {
const window = new BrowserWindow({show:false}); const before={resize:window.listenerCount("resize"),closed:window.listenerCount("closed")};
const view = new BrowserView(); window.addBrowserView(view); const attached={resize:window.listenerCount("resize"),closed:window.listenerCount("closed")};
window.removeBrowserView(view); const removed={resize:window.listenerCount("resize"),closed:window.listenerCount("closed")};
view.webContents.close(); await new Promise(resolve=>setTimeout(resolve,50)); const closed={resize:window.listenerCount("resize"),closed:window.listenerCount("closed")};
console.log(JSON.stringify({browserViewBaseline:true,electron:process.versions.electron,before,attached,removed,closed})); window.destroy(); app.exit(0); });`);
  const baseline = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, ["--disable-gpu", "--no-sandbox", `--user-data-dir=${userDataDir}`, baselinePath], { cwd:root, windowsHide:true, stdio:["ignore","pipe","pipe"] });
    let output=""; child.stdout.on("data", chunk=>{output+=chunk;process.stdout.write(chunk);}); child.stderr.on("data",chunk=>process.stderr.write(chunk));
    child.on("error",reject); child.on("close",code=>resolve({code,output}));
  });
  if (baseline.code !== 0) throw new Error("Independent Electron BrowserView baseline failed.");
  const diagnostics = JSON.parse(baseline.output.split(/\r?\n/).find(line=>line.includes('"browserViewBaseline":true')));
  if (diagnostics.closed.closed <= diagnostics.before.closed || diagnostics.removed.resize !== diagnostics.before.resize) throw new Error("Installed Electron baseline did not reproduce the observed BrowserView lifecycle.");
  const diagnosticDir = path.join(root,"artifacts","verification"); await mkdir(diagnosticDir,{recursive:true});
  await writeFile(path.join(diagnosticDir,"electron-browser-view-baseline.json"),JSON.stringify(diagnostics,null,2)+"\n");
  await build({ absWorkingDir: root, entryPoints: ["scripts/verify-electron-builtin-tasks-main.ts"], bundle: true,
    platform: "node", format: "esm", outfile: path.join(tempDir, "main.mjs"),
    banner: { js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);' }, external });
  await build({ absWorkingDir: root, entryPoints: ["src/main/agent/sourcePreparationWorker.ts"], bundle: true,
    platform: "node", format: "esm", outfile: path.join(tempDir, "sourcePreparationWorker.js") });
  const result = await new Promise(resolve => {
    const child = spawn(electronPath, ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu", "--no-sandbox", `--user-data-dir=${userDataDir}`, path.join(tempDir, "main.mjs")], {
      cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", YN_ELECTRON_VERIFY_HEADLESS: "1", YN_ELECTRON_VERIFY_OFFSCREEN: "1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", error => resolve({ code: 1, stdout, error }));
    child.on("close", code => resolve({ code, stdout }));
  });
  if (result.code !== 0 || !result.stdout.includes('"builtinTaskAcceptance":true')) throw new Error("Actual Electron built-in task acceptance failed.");
  // Exercise the same hidden startup branch used by packaged launch verification
  // against an actual-main bundle, with both workers beside import.meta.url.
  await build({ absWorkingDir: root, stdin: { contents: 'import { app } from "electron"; app.setAppPath(process.cwd()); app.disableHardwareAcceleration(); await import("./src/main/main.ts");',
    resolveDir: root, sourcefile: "builtin-smoke-entry.ts" }, bundle: true, platform: "node", format: "esm", outfile: path.join(tempDir, "smoke-main.mjs"),
    banner: { js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);' }, external });
  await build({ absWorkingDir: root, entryPoints: ["src/main/agent/piNative/proofreadPrescanWorker.ts"], bundle: true,
    platform: "node", format: "esm", outfile: path.join(tempDir, "proofreadPrescanWorker.js") });
  const smokeMarker = path.join(tempDir, "smoke-ready.json");
  const smokeCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu", "--no-sandbox", `--user-data-dir=${userDataDir}`, path.join(tempDir, "smoke-main.mjs")], {
      cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", YN_PORTABLE_SMOKE_MARKER: smokeMarker }, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject); child.on("close", resolve);
  });
  if (smokeCode !== 0) throw new Error("Actual bundled hidden worker smoke failed.");
  const smoke = JSON.parse(await readFile(smokeMarker, "utf8"));
  if (!smoke.sourcePreparationWorkerVerified || !smoke.sourcePreparationHeartbeatTicks || !smoke.proofreadWorkerVerified || smoke.windowVisible) throw new Error("Hidden bundled worker smoke did not prove responsiveness and invisible startup.");
  console.log(JSON.stringify({ bundledWorkerSmoke: true, sourcePreparationWorkerVerified: true, sourcePreparationHeartbeatTicks: smoke.sourcePreparationHeartbeatTicks }));
} finally {
  // Both resolved targets are explicit fixture directories allocated beneath root.
  for (const target of [tempDir, userDataDir]) {
    if (!path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}.tmp-electron-`)) throw new Error("Unsafe fixture cleanup target.");
    await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
