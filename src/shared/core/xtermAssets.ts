import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface XtermBrowserAssets {
  css: string;
  xtermJs: string;
  fitJs: string;
}

let cachedAssets: XtermBrowserAssets | undefined;

function assetRoots(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : undefined;
  return [
    ...(resourcesPath ? [path.join(resourcesPath, "assets", "vendor", "xterm")] : []),
    path.resolve(moduleDir, "../../assets/vendor/xterm"),
    path.resolve(moduleDir, "../../../assets/vendor/xterm"),
    path.resolve(process.cwd(), "assets/vendor/xterm")
  ];
}

function readBundledAsset(fileName: string): string {
  const tried: string[] = [];
  for (const root of assetRoots()) {
    const assetPath = path.join(root, fileName);
    tried.push(assetPath);
    if (existsSync(assetPath)) {
      return readFileSync(assetPath, "utf8");
    }
  }
  throw new Error(`Bundled xterm asset is missing: ${fileName}. Tried: ${tried.join(", ")}. Run npm run prepare:xterm-assets before building.`);
}

function safeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

export function xtermBrowserAssets(): XtermBrowserAssets {
  cachedAssets ??= {
    css: readBundledAsset("xterm.css"),
    xtermJs: safeInlineScript(readBundledAsset("xterm.js")),
    fitJs: safeInlineScript(readBundledAsset("addon-fit.js"))
  };
  return cachedAssets;
}

export function renderXtermBrowserAssets(): string {
  const assets = xtermBrowserAssets();
  return `<style>${assets.css}</style>
  <script>${assets.xtermJs}</script>
  <script>${assets.fitJs}</script>`;
}
