import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const activeTestProcesses = new Set();
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
  // Bundled verifiers resolve the prescan worker relative to their own bundle,
  // just as the packaged main process resolves dist/main/proofreadPrescanWorker.js.
  await copyFile(path.join(root, "dist/main/proofreadPrescanWorker.js"), path.join(tempDir, "proofreadPrescanWorker.js"));
  await copyFile(path.join(root, "dist/main/translationValidationWorker.js"), path.join(tempDir, "translationValidationWorker.js"));
  await copyFile(path.join(root, "dist/main/lineReviewStateWorker.js"), path.join(tempDir, "lineReviewStateWorker.js"));
  for (const worker of ["sessionIndexWorker.js", "sessionMaintenanceWorker.js", "sessionHostReplayWorker.js"]) {
    await copyFile(path.join(root, "dist/main", worker), path.join(tempDir, worker));
  }
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
      "pdfjs-dist", "pdfjs-dist/*", "pdf-lib", "@pdf-lib/fontkit", "@napi-rs/canvas",
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
  const result = await new Promise((resolve, reject) => {
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
    activeTestProcesses.add(child.pid);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(async () => {
      try {
        const evidence = path.join(tempDir, `timeout-${child.pid}.json`);
        await writeFile(evidence, JSON.stringify({ pid: child.pid, mainPath, tempDir, userDataDir, processPreserved: true, stdout, stderr }, null, 2));
        reject(new Error(`Electron verifier timed out; PID ${child.pid} and evidence ${evidence} retained, no process was killed.`));
      } catch (error) { reject(error); }
    }, timeoutMs);
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
      activeTestProcesses.delete(child.pid);
      clearTimeout(timer);
      resolve({ code, stdout, stderr, processId: child.pid });
    });
    child.on("error", (error) => {
      activeTestProcesses.delete(child.pid);
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.stack || error.message}`, processId: child.pid });
    });
  });
  if (
    result.code !== 0
    || !result.stdout.includes(successMarker)
    || /Error occurred in handler|No handler registered/.test(result.stderr)
    || /MaxListenersExceededWarning/.test(result.stderr)
    || /\[shutdown\].*(?:failed|cancelled)/i.test(result.stderr)
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
  if (!verifyOnly || verifyOnly === "warning-choice") {
    const warningChoiceMain = await buildVerifier(
      "scripts/verify-electron-warning-choice-main.ts",
      "warning-choice-main.mjs"
    );
    await runVerifier(warningChoiceMain, '"hostWarningChoice":true', 60_000, {
      YN_ELECTRON_VERIFY_OFFSCREEN: "1",
      YN_ELECTRON_WARNING_CHOICE_WORKSPACE: path.join(tempDir, "warning-choice-workspace")
    });
  }
  if (!verifyOnly || verifyOnly === "lan") {
    const lanAgentMain = await buildVerifier(
      "scripts/verify-electron-lan-agent-main.ts",
      "lan-agent-main.mjs"
    );
    await runVerifier(lanAgentMain, '"lanRemoteAgentOpen":true', 30_000, {
      YN_ELECTRON_LAN_WORKSPACE: path.join(tempDir, "lan-workspace")
    });
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

  if (!verifyOnly || verifyOnly === "proposal-epub") {
    const proposalEpubMain = await buildVerifier(
      "scripts/verify-electron-proposal-epub-main.ts",
      "proposal-epub-main.mjs"
    );
    for (const skipManualImport of ["0", "1"]) {
      await runVerifier(proposalEpubMain, '"proposalEpub":true', 60_000, {
        YN_ELECTRON_VERIFY_OFFSCREEN: "1",
        YN_EPUB_SKIP_MANUAL_IMPORT: skipManualImport
      });
    }
  }

  if (!verifyOnly || verifyOnly === "folder") {
    const productFolderMain = await buildVerifier(
      "scripts/verify-electron-folder-tabs-main.ts",
      "product-folder-tabs-main.mjs"
    );
    await runVerifier(productFolderMain, '"productFolderTabs":true', 90_000, {
      YN_ELECTRON_VERIFY_OFFSCREEN: "1"
    });
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
  if (activeTestProcesses.size === 0) {
    await removeElectronTempDir(tempDir);
    await removeElectronTempDir(userDataDir);
    await removeElectronTempDir(coldRestartWorkspace);
  } else console.error(`Preserved active test PIDs ${[...activeTestProcesses].join(", ")} and fixtures ${tempDir}, ${userDataDir}, ${coldRestartWorkspace}.`);
}
