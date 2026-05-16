import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "assets", "vendor", "xterm");

function packageRoot(packageName) {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

const xtermRoot = packageRoot("@xterm/xterm");
const fitRoot = packageRoot("@xterm/addon-fit");

const assets = [
  [path.join(xtermRoot, "css", "xterm.css"), "xterm.css"],
  [path.join(xtermRoot, "lib", "xterm.js"), "xterm.js"],
  [path.join(fitRoot, "lib", "addon-fit.js"), "addon-fit.js"]
];

await mkdir(outputDir, { recursive: true });

for (const [source, fileName] of assets) {
  await copyFile(source, path.join(outputDir, fileName));
}

console.log(`[translation-workshop] Prepared xterm assets in ${outputDir}`);
