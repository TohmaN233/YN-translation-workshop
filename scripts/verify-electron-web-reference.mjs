import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const url = process.argv[2];
if (!url) throw new Error("Usage: node scripts/verify-electron-web-reference.mjs <url>");
const tempDir = await mkdtemp(path.join(root, ".tmp-electron-web-reference-"));
const userDataDir = await mkdtemp(path.join(root, ".tmp-electron-web-reference-user-"));
const workspaceDir = await mkdtemp(path.join(root, ".tmp-electron-web-reference-workspace-"));
const mainPath = path.join(tempDir, "main.mjs");

try {
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/verify-electron-web-reference-main.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: mainPath,
    banner: {
      js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);'
    },
    external: ["electron", "cheerio", "cheerio/*", "undici"]
  });
  const result = await new Promise((resolve) => {
    const child = spawn(electronPath, [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--in-process-gpu",
      "--no-sandbox",
      `--user-data-dir=${userDataDir}`,
      mainPath,
      `--yn-url=${url}`,
      `--yn-workspace=${workspaceDir}`
    ], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        YN_ELECTRON_VERIFY_HEADLESS: "1",
        ELECTRON_ENABLE_LOGGING: "true",
        ELECTRON_ENABLE_STACK_DUMPING: "true"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stdout += value;
      process.stdout.write(value);
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stderr += value;
      process.stderr.write(value);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.stack || error.message}` });
    });
  });
  if (result.code !== 0 || !result.stdout.includes('"ok":true')) {
    throw new Error(`Electron web-reference verifier failed (exit ${result.code}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
} finally {
  await Promise.all([
    rm(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    rm(workspaceDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  ]);
}
