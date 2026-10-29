import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import electronPath from "electron";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(process.cwd(), ".tmp-glossary-verify-"));
let cleanupTemporary = false;
try {
  const entry = path.join(temporary, "main.mjs");
  await build({
    entryPoints: ["scripts/verify-electron-glossary-main.ts"], bundle: true, platform: "node", format: "esm", outfile: entry,
    external: ["electron"],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu", "--no-sandbox", entry], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`Electron glossary verification is still running; PID ${child.pid ?? "unknown"}. Retaining process and evidence at ${temporary}.`);
    }, 45000);
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, timedOut }); });
  });
  if (result.code !== 0 || !result.output.includes('"glossaryManagement":true')) {
    throw new Error(`Electron glossary verification failed (exit ${result.code}).`);
  }
  cleanupTemporary = !result.timedOut;
} finally {
  if (cleanupTemporary) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } else {
    console.error(`Retaining Electron glossary verification evidence at ${temporary}.`);
  }
}
