import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const tempDir = await mkdtemp(path.join(root, ".tmp-electron-real-folder-"));
const electronRuntimeDir = await mkdtemp(path.join(os.tmpdir(), "yn-real-folder-electron-runtime-"));
const outfile = path.join(tempDir, "real-folder-main.mjs");

async function removeElectronTempDir(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  });
}

if (process.argv.length < 5) {
  throw new Error("Usage: node scripts/verify-electron-agent-folder-history.mjs <source-folder> <batch-html> <pi-jsonl> [worker-count]");
}

await build({
  absWorkingDir: root,
  entryPoints: ["scripts/verify-electron-agent-folder-history-main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
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

try {
  const providerMode = String(process.env.TW_REAL_FOLDER_PROVIDER_MODE || "faux").trim().toLowerCase();
  if (providerMode !== "faux" && providerMode !== "real") {
    throw new Error(`TW_REAL_FOLDER_PROVIDER_MODE must be faux or real, received ${providerMode}.`);
  }
  const verificationTimeoutMs = providerMode === "real"
    ? Number(process.env.TW_REAL_FOLDER_TIMEOUT_MS || 1_200_000)
    : 180_000;
  if (
    providerMode === "real"
    && (!Number.isFinite(verificationTimeoutMs) || verificationTimeoutMs < 1_200_000 || verificationTimeoutMs > 1_320_000)
  ) {
    throw new Error(`TW_REAL_FOLDER_TIMEOUT_MS must be between 1200000 and 1320000, received ${process.env.TW_REAL_FOLDER_TIMEOUT_MS}.`);
  }
  const result = await new Promise((resolve) => {
    const child = spawn(electronPath, [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--in-process-gpu",
      "--no-sandbox",
      outfile
    ], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        YN_ELECTRON_VERIFY_HEADLESS: "1",
        YN_REAL_FOLDER_ROOT: process.argv[2],
        YN_REAL_FOLDER_HTML: process.argv[3],
        YN_REAL_FOLDER_SESSION: process.argv[4],
        YN_REAL_FOLDER_WORKERS: process.argv[5] ?? "5",
        YN_REAL_FOLDER_ELECTRON_RUNTIME: electronRuntimeDir,
        YN_REAL_FOLDER_PROVIDER_MODE: providerMode,
        YN_REAL_FOLDER_TIMEOUT_MS: String(verificationTimeoutMs),
        YN_REAL_FOLDER_PROVIDER_CONFIG_WORKSPACE: process.env.TW_REAL_PROVIDER_CONFIG_WORKSPACE_DIR || process.argv[2],
        YN_REAL_FOLDER_PROVIDER_ID: process.env.TW_REAL_PROVIDER_ID || "openai-chatgpt",
        YN_REAL_FOLDER_MODEL_ID: process.env.TW_REAL_PROVIDER_MODEL || "gpt-5.6-luna",
        YN_REAL_FOLDER_KEEP_TEMP: process.env.TW_REAL_PROVIDER_KEEP_TEMP || ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), verificationTimeoutMs + 120_000);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
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
    throw new Error([
      `Real folder Electron history verifier failed with exit code ${result.code}.`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`
    ].join("\n"));
  }
} finally {
  await removeElectronTempDir(tempDir);
  await removeElectronTempDir(electronRuntimeDir);
  await access(electronRuntimeDir).then(
    () => { throw new Error(`Electron runtime directory still exists after cleanup: ${electronRuntimeDir}`); },
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    }
  );
}
