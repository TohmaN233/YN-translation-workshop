import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const tempDir = await mkdtemp(path.join(root, ".tmp-electron-project-portability-"));
const userDataDir = await mkdtemp(path.join(root, ".tmp-electron-project-portability-user-"));
const mainPath = path.join(tempDir, "main.mjs");

try {
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/verify-electron-project-portability-main.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: mainPath,
    banner: {
      js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);'
    },
    external: [
      "electron",
      "extract-zip",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-ai/*",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-agent-core/*"
    ]
  });
  const result = await new Promise((resolve) => {
    const child = spawn(electronPath, [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--in-process-gpu",
      "--no-sandbox",
      `--user-data-dir=${userDataDir}`,
      mainPath
    ], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        YN_ELECTRON_VERIFY_HEADLESS: "1",
        YN_ELECTRON_VERIFY_OFFSCREEN: "0"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
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
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.stack || error.message}` });
    });
  });
  if (result.code !== 0 || !result.stdout.includes('"stopIndependentOfSave":true') || !result.stdout.includes('"queuedEditPreserved":true')) {
    throw new Error("Electron project portability/close verifier failed.");
  }
} finally {
  await Promise.all([
    rm(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  ]);
}
