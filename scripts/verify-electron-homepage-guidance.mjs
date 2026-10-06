import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import electronPath from "electron";
import { build } from "esbuild";

// Isolated renderer acceptance: only the IPC boundary is substituted. No real
// projects, providers, Agent sessions, dist output or release files are touched.
const root = process.cwd();
const temporary = await mkdtemp(path.join(root, ".tmp-homepage-guidance-"));
try {
  await build({ entryPoints: ["src/renderer/App.tsx"], bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", outfile: path.join(temporary, "app.js"), loader: { ".png": "file" },
    define: { "process.env.NODE_ENV": '"production"' } });
  await writeFile(path.join(temporary, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script>
window.__requests=[]; window.__renderErrors=[]; window.__loadedRules=[];
addEventListener('error', event=>window.__renderErrors.push(event.message));
addEventListener('unhandledrejection', event=>window.__renderErrors.push(String(event.reason)));
window.workshop={
onWorkspaceAssetsStatus:()=>()=>{}, onProjectStateUpdate:()=>()=>{}, onProjectAssetsUpdate:()=>()=>{}, onAgentProviderUpdate:()=>()=>{},
getAgentProviderConfig:async()=>({providers:{},activeProviderId:''}),
openProjectFolder:async()=> 'C:/YN-test/project', openFile:async()=> 'C:/YN-test/source.txt',
loadProject:async()=>({sourcePath:'C:/YN-test/source.txt',customPreserveRules:window.__loadedRules}),
startBuiltinTask:async request=>{window.__requests.push(request);throw new Error('Fixture: request captured without starting a workflow.');}
};</script><script src="app.js"></script></body></html>`);
  const screenshotDir = path.join(root, "artifacts", "verification");
  await mkdir(screenshotDir, { recursive: true });
  await build({ entryPoints: ["scripts/verify-electron-homepage-guidance-main.ts"], bundle: true, platform: "node", format: "esm",
    outfile: path.join(temporary, "main.mjs"), external: ["electron"] });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, ["--disable-gpu", "--no-sandbox", `--user-data-dir=${path.join(temporary, "user-data")}`, path.join(temporary, "main.mjs")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", YN_GUIDANCE_FIXTURE: temporary, YN_GUIDANCE_SCREENSHOTS: screenshotDir }
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject); child.on("close", code => resolve({ code, output }));
  });
  if (result.code !== 0 || !result.output.includes('"homepageGuidance":true')) throw new Error("Homepage renderer acceptance failed.");
} finally {
  if (path.dirname(temporary) !== root || !path.basename(temporary).startsWith(".tmp-homepage-guidance-")) throw new Error("Unsafe fixture cleanup.");
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
