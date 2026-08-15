import path from "node:path";

import { webReferenceService } from "../src/main/agent/piNative/webReference.ts";

const url = process.argv[2];
const workspaceDir = path.resolve(process.argv[3] || process.cwd());
if (!url) {
  throw new Error("Usage: node --experimental-strip-types scripts/verify-web-reference.mjs <url> [workspaceDir]");
}

const result = await webReferenceService.fetch({
  url,
  workspaceDir,
  maxChars: 50_000,
  refresh: true
});
if (!result.title.trim()) throw new Error("Fetched web reference has no title.");
if (result.text.trim().length < 100) throw new Error("Fetched web reference has too little readable text.");

console.log(JSON.stringify({
  ok: true,
  requestedUrl: result.requestedUrl,
  finalUrl: result.finalUrl,
  title: result.title,
  sourceType: result.sourceType,
  contentType: result.contentType,
  characters: result.text.length,
  cacheHit: result.cacheHit,
  excerpt: result.text.slice(0, 500)
}, null, 2));
