import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import electronPath from "electron";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(process.cwd(), ".tmp-glossary-verify-"));
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
    const timer = setTimeout(() => { console.error("Electron glossary verification timed out."); child.kill(); }, 45000);
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  if (result.code !== 0 || !result.output.includes('"glossaryManagement":true')) {
    throw new Error(`Electron glossary verification failed (exit ${result.code}).`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
