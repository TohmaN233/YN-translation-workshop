import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCachedWebReferenceContext,
  createWebReferenceService
} from "../../src/main/agent/piNative/webReference.ts";

const wikiUrl = "https://ja.wikipedia.org/wiki/%E3%82%BC%E3%83%8E%E3%83%B3%E3%82%B6%E3%83%BC%E3%83%89";
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "yn-web-reference-"));

try {
  let fetchCalls = 0;
  const service = createWebReferenceService({
    async fetch(url) {
      fetchCalls += 1;
      assert.match(String(url), /^https:\/\/ja\.wikipedia\.org\/w\/api\.php\?/);
      return new Response(JSON.stringify({
        query: {
          pages: [{
            pageid: 123,
            title: "ゼノンザード",
            extract: "『ゼノンザード』は、バンダイが配信していたスマートフォン向けデジタルカードゲーム。"
          }]
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    },
    async lookupHost() {
      return ["1.1.1.1"];
    },
    now: () => new Date("2026-07-16T00:00:00.000Z")
  });

  const fetched = await service.fetch({
    url: wikiUrl,
    workspaceDir,
    maxChars: 10_000
  });
  assert.equal(fetched.cacheHit, false);
  assert.equal(fetched.sourceType, "mediawiki");
  assert.equal(fetched.title, "ゼノンザード");
  assert.match(fetched.text, /デジタルカードゲーム/);

  const cached = await service.fetch({
    url: wikiUrl,
    workspaceDir,
    maxChars: 10_000
  });
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.text, fetched.text);
  assert.equal(fetchCalls, 1);

  const variantWikiUrl = "https://zh.wikipedia.org/zh-hans/%E8%B6%8A%E4%BD%90%E5%A4%A7%E6%A9%8B%E7%B3%BB%E5%88%97";
  const variantService = createWebReferenceService({
    async fetch(url) {
      const apiUrl = new URL(String(url));
      assert.equal(apiUrl.origin, "https://zh.wikipedia.org");
      assert.equal(apiUrl.pathname, "/w/api.php");
      assert.equal(apiUrl.searchParams.get("titles"), "越佐大橋系列");
      return new Response(JSON.stringify({
        query: {
          pages: [{
            pageid: 456,
            title: "越佐大橋系列",
            extract: "越佐大橋系列是成田良悟創作的輕小說系列。"
          }]
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    },
    async lookupHost() {
      return ["1.1.1.1"];
    }
  });
  const variantWiki = await variantService.fetch({
    url: variantWikiUrl,
    workspaceDir,
    refresh: true
  });
  assert.equal(variantWiki.sourceType, "mediawiki");
  assert.equal(variantWiki.title, "越佐大橋系列");
  assert.match(variantWiki.text, /成田良悟/);

  const networkFailure = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })
  });
  const failingService = createWebReferenceService({
    async fetch() {
      throw networkFailure;
    },
    async lookupHost() {
      return ["1.1.1.1"];
    }
  });
  await assert.rejects(
    failingService.fetch({
      url: "https://example.com/reference",
      workspaceDir,
      refresh: true
    }),
    /UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error/
  );

  const childContext = await buildCachedWebReferenceContext({
    prompt: `Use this background reference: ${wikiUrl}`,
    workspaceDir
  });
  assert.match(childContext, /ゼノンザード/);
  assert.match(childContext, /デジタルカードゲーム/);
  assert.match(childContext, /untrusted reference data/i);

  const htmlService = createWebReferenceService({
    async fetch() {
      return new Response(`
        <!doctype html>
        <html>
          <head><title>Card Game Reference</title><script>ignoreMe()</script></head>
          <body>
            <nav>Site navigation</nav>
            <main>
              <h1>World setting</h1>
              <p>The game takes place in the city of Beholder.</p>
              <p>Code Man is a central title.</p>
            </main>
          </body>
        </html>
      `, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    },
    async lookupHost() {
      return ["1.1.1.1"];
    }
  });
  const html = await htmlService.fetch({
    url: "https://example.com/reference",
    workspaceDir,
    refresh: true
  });
  assert.equal(html.sourceType, "html");
  assert.equal(html.title, "Card Game Reference");
  assert.match(html.text, /city of Beholder/);
  assert.doesNotMatch(html.text, /Site navigation|ignoreMe/);

  let browserFetchCalls = 0;
  const browserFallbackService = createWebReferenceService({
    async fetch() {
      return new Response("Automated client blocked", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/plain" }
      });
    },
    async browserFetch(url, init) {
      browserFetchCalls += 1;
      assert.equal(String(url), "https://tvtropes.org/pmwiki/pmwiki.php/VisualNovel/TheSekimeiyaSpunGlass");
      assert.equal(init.credentials, "include");
      return new Response(`
        <!doctype html>
        <html><head><title>The Sekimeiya: Spun Glass - TV Tropes</title></head>
        <body><main><h1>The Sekimeiya: Spun Glass</h1><p>A visual novel reference page.</p></main></body></html>
      `, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    },
    async lookupHost() {
      return ["1.1.1.1"];
    }
  });
  const browserFallback = await browserFallbackService.fetch({
    url: "https://tvtropes.org/pmwiki/pmwiki.php/VisualNovel/TheSekimeiyaSpunGlass",
    workspaceDir,
    refresh: true
  });
  assert.equal(browserFetchCalls, 1);
  assert.equal(browserFallback.sourceType, "html");
  assert.match(browserFallback.text, /visual novel reference page/i);

  let privateFetchCalled = false;
  const privateService = createWebReferenceService({
    async fetch() {
      privateFetchCalled = true;
      return new Response("should not be fetched");
    },
    async lookupHost() {
      return ["127.0.0.1"];
    }
  });
  await assert.rejects(
    privateService.fetch({
      url: "https://internal.example.test/secret",
      workspaceDir,
      refresh: true
    }),
    /non-public address/
  );
  assert.equal(privateFetchCalled, false);

  const public203Service = createWebReferenceService({
    async fetch() {
      return new Response("<main><p>Public reference text is readable.</p></main>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    },
    async lookupHost() {
      return ["203.0.114.1"];
    }
  });
  const public203 = await public203Service.fetch({
    url: "https://public-203.example.test/reference",
    workspaceDir,
    refresh: true
  });
  assert.match(public203.text, /Public reference text/);
} finally {
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log("Pi native web reference tests passed");
