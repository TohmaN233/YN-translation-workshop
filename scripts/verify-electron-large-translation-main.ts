import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { verifyLargeTranslationValidation } from "./verify-large-translation-validation.mjs";

app.setAppPath(process.cwd());
app.disableHardwareAcceleration();
await import("../src/main/main.ts");
async function run() {
await app.whenReady();
let win: BrowserWindow | undefined;
for (let attempt = 0; attempt < 150; attempt++) {
  win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
  if (win && !win.webContents.isLoadingMainFrame()) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!win || win.isVisible() || win.webContents.isLoadingMainFrame()) throw new Error("Actual YN hidden renderer did not become ready.");
let maximumUiLatencyMs = 0;
let samples = 0;
let ping: Promise<void> | undefined;
let pingError: unknown;
const observeUi = async () => {
  const started = performance.now();
  const ready = await win!.webContents.executeJavaScript("Boolean(document.body && document.querySelector('#root')?.children.length)");
  if (!ready) throw new Error("Actual YN renderer became empty during translation.");
  maximumUiLatencyMs = Math.max(maximumUiLatencyMs, performance.now() - started);
  samples += 1;
};
const heartbeat = setInterval(() => {
  if (ping) return;
  ping = observeUi().catch(error => { pingError = error; }).finally(() => { ping = undefined; });
}, 100);
let timeout: NodeJS.Timeout | undefined;
try {
  const records = await Promise.race([
    verifyLargeTranslationValidation({ observeUi }),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Electron large-file acceptance exceeded 240 seconds.")), 240000); })
  ]);
  await ping;
  if (pingError) throw pingError;
  if (maximumUiLatencyMs >= 1000) throw new Error(`Actual YN UI stalled ${maximumUiLatencyMs.toFixed(0)} ms.`);
  const appMetrics = app.getAppMetrics();
  const rendererMetrics = appMetrics.find(metric => metric.pid === win!.webContents.getOSProcessId());
  if (!rendererMetrics) throw new Error("Actual YN renderer memory metrics were unavailable.");
  const result = { electronLargeFileAcceptance: true, maximumUiLatencyMs, samples,
    rendererMemory: rendererMetrics.memory, appMetrics,
    windowVisible: win.isVisible(), records };
  const diagnostics = path.join(process.cwd(), "artifacts", "diagnostics", "large-file-crash-2026-10-03");
  await mkdir(diagnostics, { recursive: true });
  await writeFile(path.join(diagnostics, "electron-large-file-acceptance.json"), JSON.stringify(result, null, 2));
  await writeFile(path.join(diagnostics, "electron-large-file.png"), (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  if (timeout) clearTimeout(timeout);
  await ping;
  app.quit();
}
}
void run().catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
