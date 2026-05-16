import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

interface XtermBrowserAssets {
  css: string;
  xtermJs: string;
  fitJs: string;
}

const require = createRequire(import.meta.url);
let cachedAssets: XtermBrowserAssets | undefined;

function readPackageFile(packagePath: string): string {
  return readFileSync(require.resolve(packagePath), "utf8");
}

function safeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

export function xtermBrowserAssets(): XtermBrowserAssets {
  cachedAssets ??= {
    css: readPackageFile("@xterm/xterm/css/xterm.css"),
    xtermJs: safeInlineScript(readPackageFile("@xterm/xterm/lib/xterm.js")),
    fitJs: safeInlineScript(readPackageFile("@xterm/addon-fit/lib/addon-fit.js"))
  };
  return cachedAssets;
}

export function renderXtermBrowserAssets(): string {
  const assets = xtermBrowserAssets();
  return `<style>${assets.css}</style>
  <script>${assets.xtermJs}</script>
  <script>${assets.fitJs}</script>`;
}
