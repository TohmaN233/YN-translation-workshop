import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import electronPath from "electron";
import { build } from "esbuild";

const root = process.cwd();
const tempDir = await mkdtemp(path.join(root, ".tmp-electron-project-open-"));
const userDataDir = await mkdtemp(path.join(root, ".tmp-electron-project-open-user-"));
const mainPath = path.join(tempDir, "main.mjs");

try {
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/verify-electron-project-open-main.ts"],
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
        YN_ELECTRON_VERIFY_HEADLESS: "1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
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
  if (
    result.code !== 0
    || !result.stdout.includes('"projectPickerRestoredFolder":true')
    || !result.stdout.includes('"projectPickerTracksActiveHtml":true')
    || !result.stdout.includes('"nestedFolderReviewGenerated":true')
    || !result.stdout.includes('"projectPromptSettingsRestored":true')
    || !result.stdout.includes('"projectPromptSettingsLive":true')
    || !result.stdout.includes('"projectGlossaryImported":true')
    || !result.stdout.includes('"projectGlossaryImportedViaUi":true')
    || !result.stdout.includes('"projectGlossaryReferenceSelected":true')
    || !result.stdout.includes('"projectGlossaryLive":true')
    || !result.stdout.includes('"customPreserveRulesEditor":true')
    || !result.stdout.includes('"siblingHtmlLive":true')
    || !result.stdout.includes('"reactProjectStateLive":true')
    || !result.stdout.includes('"characterBibleMarkdown":true')
    || !result.stdout.includes('"styleGuideLoaded":true')
    || /ERR_ABORTED|Error occurred in handler/.test(result.stderr)
  ) {
    throw new Error("Electron project-open verifier failed.");
  }
} finally {
  await Promise.all([
    rm(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  ]);
}
