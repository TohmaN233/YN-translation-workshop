import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfStructureHttpProvider } from "../tests/helpers/pdf-structure-http-provider.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const releaseDir = process.env.YN_RELEASE_DIR
  ? path.resolve(rootDir, process.env.YN_RELEASE_DIR)
  : path.join(rootDir, "release");
const packagedPath = path.join(releaseDir, "win-unpacked", `${packageJson.name}.exe`);
const timeoutMs = 45_000;

assert.equal(process.platform, "win32", "Packaged launch verification is Windows-only");
assert.ok(existsSync(packagedPath), `Missing unpacked packaged executable: ${packagedPath}`);

function listWorkshopProcesses() {
  const command = [
    "$items = try {",
    "  Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -like 'translation-workshop*.exe' } | ForEach-Object { [PSCustomObject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; InspectionFallback = $false } }",
    "} catch {",
    "  Get-Process -Name 'translation-workshop*' -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ ProcessId = $_.Id; ParentProcessId = 0; Name = $_.ProcessName + '.exe'; CommandLine = ''; InspectionFallback = $true } }",
    "}",
    "$items | ConvertTo-Json -Compress"
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to inspect Translation Workshop processes");
  }
  const output = result.stdout.trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processEvidence(items) {
  return items.map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    commandLine: String(item.CommandLine ?? "").slice(0, 500)
  }));
}

const baselineProcesses = listWorkshopProcesses();
assert.equal(
  baselineProcesses.length,
  0,
  `Refusing to launch packaged verification beside an existing Translation Workshop process: ${JSON.stringify(processEvidence(baselineProcesses))}`
);
const baselineProcessIds = new Set(baselineProcesses.map((item) => Number(item.ProcessId)));

const tempDir = await mkdtemp(path.join(os.tmpdir(), "yn-packaged-smoke-"));
const markerPath = path.join(tempDir, "ready.json");
// main.ts assigns marker-directory/user-data before app.whenReady, then sets
// the global Agent store to user-data/agent. Seed only this explicit smoke's
// isolated profile; normal application settings and model selection are intact.
const provider = await createPdfStructureHttpProvider();
const smokeAgentDir = path.join(tempDir, "user-data", "agent");
try {
  await mkdir(smokeAgentDir, { recursive: true });
  await writeFile(path.join(smokeAgentDir, "provider-config.json"), JSON.stringify({
    activeProviderId: provider.config.id,
    providers: { [provider.config.id]: provider.config }
  }, null, 2));
} catch (error) { await provider.close(); throw error; }
const startedAt = Date.now();
const launcher = spawn(packagedPath, [
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--in-process-gpu",
  "--no-sandbox"
], {
  cwd: path.dirname(packagedPath),
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    YN_PORTABLE_SMOKE_MARKER: markerPath
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let launchError;
let launcherExit;
let launcherStdout = "";
let launcherStderr = "";
launcher.once("error", (error) => {
  launchError = error;
});
launcher.once("exit", (code, signal) => {
  launcherExit = { code, signal };
});
launcher.stdout?.on("data", (chunk) => {
  launcherStdout = `${launcherStdout}${chunk}`.slice(-8_000);
});
launcher.stderr?.on("data", (chunk) => {
  launcherStderr = `${launcherStderr}${chunk}`.slice(-8_000);
});

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
let marker;
let leaveDiagnostics = false;
let failure;

try {
  while (Date.now() - startedAt < timeoutMs) {
    if (launchError) throw launchError;
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8"));
      break;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Packaged smoke marker is invalid JSON.", { cause: error });
      if (error?.code !== "ENOENT") throw error;
    }
    if (launcherExit && launcherExit.code !== 0) {
      throw new Error(`Packaged app exited before writing its smoke marker: ${JSON.stringify({ launcherExit, launcherStdout, launcherStderr })}`);
    }
    await wait(100);
  }

  assert.ok(marker, `Packaged app did not write its smoke marker within ${timeoutMs} ms.`);
  assert.equal(marker.version, packageJson.version, "Packaged smoke marker reported the wrong version");
  assert.equal(marker.rendererLoaded, true, "Packaged renderer was not loaded before the smoke marker");
  assert.equal(marker.windowVisible, false, "Packaged smoke verification displayed a product window");
  assert.equal(marker.proofreadWorkerVerified, true, "Packaged proofreading worker did not finish its background scan");
  assert.ok(marker.proofreadHeartbeatTicks > 0, "Packaged proofreading blocked the main event loop");
  assert.equal(marker.translationValidationWorkerVerified, true, "Packaged translation validation worker did not complete");
  assert.ok(marker.translationValidationHeartbeatTicks > 0, "Packaged translation validation blocked the main event loop");
  assert.equal(marker.sourcePreparationWorkerVerified, true, "Packaged source preparation worker did not finish its background scan");
  assert.ok(marker.sourcePreparationHeartbeatTicks > 0, "Packaged source preparation blocked the main event loop");
  assert.equal(marker.pdfWorkerVerified, true, "Packaged PDF extraction/reference/export failed");
  assert.ok(marker.pdfHeartbeatTicks > 0, "Packaged PDF processing blocked the main event loop");
  for (const name of ["readPdfStructureSource", "readPdfStructureDraft", "revisePdfStructureDraft", "checkPdfStructureDraft", "readPdfStructureAuditScope", "submitPdfStructureAudit"]) {
    assert.ok(provider.records.some(record => record.name === name), `Packaged PDF smoke did not execute its native Pi ${name} protocol.`);
  }
  assert.ok(provider.records.some(record => record.phase === "audit" && record.event === "completed"), "Packaged PDF smoke did not complete its independent native audit.");
  assert.ok(!provider.records.some(record => record.event === "fixture-error"), JSON.stringify(provider.records.filter(record => record.event === "fixture-error")));
  assert.match(String(marker.rendererUrl), /dist\/renderer\/index\.html/i, "Packaged smoke marker did not report the packaged renderer");

  const exitDeadline = Date.now() + 15_000;
  let remaining = [];
  while (Date.now() < exitDeadline) {
    remaining = listWorkshopProcesses().filter((item) => !baselineProcessIds.has(Number(item.ProcessId)));
    if (launcherExit && remaining.length === 0) break;
    await wait(100);
  }
  assert.ok(launcherExit, "Packaged app did not exit after its product-owned smoke shutdown");
  assert.equal(launcherExit.code, 0, `Packaged smoke failed: ${JSON.stringify({ launcherExit, launcherStdout, launcherStderr })}`);
  assert.equal(remaining.length, 0, `Packaged smoke shutdown left processes running: ${JSON.stringify(processEvidence(remaining))}`);

  console.log(JSON.stringify({
    executable: path.relative(releaseDir, packagedPath),
    version: marker.version,
    rendererReadyMs: Date.now() - startedAt,
    rendererUrl: marker.rendererUrl,
    windowVisible: marker.windowVisible,
    proofreadWorkerVerified: marker.proofreadWorkerVerified,
    proofreadHeartbeatTicks: marker.proofreadHeartbeatTicks,
    translationValidationWorkerVerified: marker.translationValidationWorkerVerified,
    translationValidationHeartbeatTicks: marker.translationValidationHeartbeatTicks,
    sourcePreparationWorkerVerified: marker.sourcePreparationWorkerVerified,
    sourcePreparationHeartbeatTicks: marker.sourcePreparationHeartbeatTicks,
    pdfWorkerVerified: marker.pdfWorkerVerified,
    pdfHeartbeatTicks: marker.pdfHeartbeatTicks,
    nativePdfStructureVerified: true,
    localProviderRequests: provider.records.filter(record => Array.isArray(record.tools)).length,
    paidCalls: 0,
    cleanExit: true
  }, null, 2));
} catch (error) {
  leaveDiagnostics = true;
  failure = error;
  process.exitCode = 1;
  console.error(error instanceof Error ? error.stack : String(error));
  console.error(`Packaged smoke diagnostics retained at ${tempDir}; no process was forcibly stopped.`);
} finally {
  await writeFile(path.join(tempDir, "provider-events.json"), JSON.stringify(provider.records, null, 2));
  if (launcherExit || launchError) {
    await provider.close();
  } else {
    // A timeout must preserve both the app and its local model endpoint. Keep
    // serving until the app's own exit, rather than severing an active turn.
    launcher.once("exit", () => { void provider.close().catch(error => { console.error(error); process.exitCode = 1; }); });
    console.error(`The retained packaged process ${launcher.pid} still owns its loopback provider; waiting for its normal exit.`);
  }
  if (!leaveDiagnostics) {
    await rm(tempDir, { recursive: true, force: true });
  }
}
if (failure && launcherExit) process.exitCode = 1;
