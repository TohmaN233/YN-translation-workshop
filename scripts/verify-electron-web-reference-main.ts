import { app, BrowserWindow, session } from "electron";
import path from "node:path";

import {
  configureWebReferenceBrowserFetch,
  webReferenceService
} from "../src/main/agent/piNative/webReference.ts";

const url = process.argv.find((value) => value.startsWith("--yn-url="))?.slice("--yn-url=".length);
const workspaceDir = path.resolve(
  process.argv.find((value) => value.startsWith("--yn-workspace="))?.slice("--yn-workspace=".length)
    || process.cwd()
);
void app.whenReady().then(async () => {
  if (!url) throw new Error("A web reference URL is required.");
  const keepAliveWindow = new BrowserWindow({ show: false });
  configureWebReferenceBrowserFetch((target, init) => session.defaultSession.fetch(target, init));
  const result = await webReferenceService.fetch({
    url,
    workspaceDir,
    maxChars: 50_000,
    refresh: true
  });
  if (result.text.trim().length < 100) throw new Error("Fetched web reference has too little readable text.");
  console.log(JSON.stringify({
    ok: true,
    title: result.title,
    finalUrl: result.finalUrl,
    characters: result.text.length,
    sourceType: result.sourceType,
    excerpt: result.text.slice(0, 500)
  }));
  keepAliveWindow.destroy();
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(() => {
  app.exit(process.exitCode ?? 0);
});
