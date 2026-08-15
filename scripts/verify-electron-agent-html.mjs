import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const verifyOnly = process.env.YN_VERIFY_ONLY?.trim();
const tempDir = await mkdtemp(path.join(root, ".tmp-electron-pi-native-"));
const userDataDir = await mkdtemp(path.join(root, ".tmp-electron-user-data-"));
const coldRestartWorkspace = await mkdtemp(path.join(root, ".tmp-electron-cold-restart-"));

async function removeElectronTempDir(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  });
}

async function buildVerifier(entryPoint, outputName) {
  const outfile = path.join(tempDir, outputName);
  await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
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
  return outfile;
}

async function runVerifier(mainPath, successMarker, timeoutMs, envOverrides = {}) {
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
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
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
      resolve({ code, stdout, stderr, processId: child.pid });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.stack || error.message}`, processId: child.pid });
    });
  });
  if (
    result.code !== 0
    || !result.stdout.includes(successMarker)
    || /Error occurred in handler|No handler registered/.test(result.stderr)
    || /MaxListenersExceededWarning/.test(result.stderr)
    || /Uncaught (?:ReferenceError|TypeError|SyntaxError)/.test(`${result.stdout}\n${result.stderr}`)
  ) {
    if (result.code === 0 && !result.stdout.includes(successMarker)) {
      process.stderr.write(`Electron verifier exited without ${successMarker}.\n`);
    }
    throw new Error(
      `Electron verifier failed: ${path.basename(mainPath)}; `
      + `exit=${result.code}; stdout=${JSON.stringify(result.stdout.slice(-4_000))}; `
      + `stderr=${JSON.stringify(result.stderr.slice(-4_000))}`
    );
  }
  return result;
}

try {
  if (!verifyOnly || verifyOnly === "lan") {
    const lanAgentMain = await buildVerifier(
      "scripts/verify-electron-lan-agent-main.ts",
      "lan-agent-main.mjs"
    );
    await runVerifier(lanAgentMain, '"lanRemoteAgentOpen":true', 30_000);
  }

  if (!verifyOnly || verifyOnly === "proposal") {
    const proposalReviewMain = await buildVerifier(
      "scripts/verify-electron-proposal-review-main.ts",
      "proposal-review-main.mjs"
    );
    await runVerifier(proposalReviewMain, '"folderProofreadAggregate":true', 60_000, {
      YN_ELECTRON_VERIFY_OFFSCREEN: "1"
    });
  }

  if (!verifyOnly || verifyOnly === "folder") {
    const productFolderMain = await buildVerifier(
      "scripts/verify-electron-folder-tabs-main.ts",
      "product-folder-tabs-main.mjs"
    );
    await runVerifier(productFolderMain, '"productFolderTabs":true', 90_000);
  }

  if (!verifyOnly || verifyOnly === "agent") {
    const agentMain = await buildVerifier(
      "scripts/verify-electron-agent-html-main.ts",
      "agent-main.mjs"
    );
    await runVerifier(agentMain, '"ok":true', 120_000);
  }

  if (!verifyOnly || verifyOnly === "restart") {
    const coldRestartMain = await buildVerifier(
      "scripts/verify-electron-agent-cold-restart-main.ts",
      "agent-cold-restart-main.mjs"
    );
    const seedResult = await runVerifier(coldRestartMain, '"coldRestartSeeded":true', 20_000, {
      YN_ELECTRON_VERIFY_OFFSCREEN: "1",
      YN_COLD_RESTART_PHASE: "seed",
      YN_COLD_RESTART_WORKSPACE: coldRestartWorkspace
    });
    const recoveryResult = await runVerifier(coldRestartMain, '"coldRestartRecovered":true', 30_000, {
      YN_ELECTRON_VERIFY_OFFSCREEN: "1",
      YN_COLD_RESTART_PHASE: "recover",
      YN_COLD_RESTART_WORKSPACE: coldRestartWorkspace
    });
    if (!seedResult.processId || !recoveryResult.processId || seedResult.processId === recoveryResult.processId) {
      throw new Error("Cold-restart verifier did not use two distinct Electron main processes.");
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  await removeElectronTempDir(tempDir);
  await removeElectronTempDir(userDataDir);
  await removeElectronTempDir(coldRestartWorkspace);
}
