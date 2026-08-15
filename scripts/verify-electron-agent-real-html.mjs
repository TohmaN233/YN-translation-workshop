import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
if (!/^(1|true|yes)$/i.test(String(process.env.TW_REAL_PROVIDER_SMOKE || ""))) {
  console.log(JSON.stringify({ skipped: true, reason: "Set TW_REAL_PROVIDER_SMOKE=1 to run real-provider Electron acceptance." }, null, 2));
  process.exit(0);
}

const tempDir = await mkdtemp(path.join(root, ".tmp-electron-pi-real-provider-"));
const mainOut = path.join(tempDir, "main.mjs");

try {
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/verify-electron-agent-real-html-main.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: mainOut,
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
    const child = spawn(electronPath, [mainOut], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        YN_ELECTRON_VERIFY_HEADLESS: "1",
        YN_ELECTRON_VERIFY_OFFSCREEN: "1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const stageTimeoutMs = Number(process.env.TW_REAL_PROVIDER_TIMEOUT_MS || 240_000);
    const timer = setTimeout(() => child.kill(), stageTimeoutMs + 120_000);
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
    if (result.code === 0) process.stderr.write("Real-provider Electron verifier exited without a success report.\n");
    process.exitCode = result.code || 1;
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
