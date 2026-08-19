import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

import {
  lanSyncJson,
  lanSyncLabels,
  lanSyncLandingHtml,
  lanSyncResponse,
  lanSyncSessionNotFoundHtml
} from "../../src/main/lanSyncHttp.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function session(patch = {}) {
  return {
    token: "tok<en",
    title: "sync <one>",
    locale: "zh-CN",
    authTokens: new Set(),
    clients: new Set(),
    documents: {},
    ownerWebContentsId: 1,
    pinHash: "",
    createdAt: new Date(0).toISOString(),
    ...patch
  };
}

await test("LAN sync labels expose zh and en mobile copy", () => {
  assert.equal(lanSyncLabels("zh-CN").search, "搜索");
  assert.equal(lanSyncLabels("en-US").search, "Search");
  assert.equal(lanSyncLabels("zh-CN").openMobileAgent, "打开 Agent");
  assert.equal(lanSyncLabels("en-US").openMobileAgent, "Open Agent");
  assert.equal("agentStart" in lanSyncLabels("zh-CN"), false);
});

await test("LAN sync JSON is script-safe", () => {
  assert.equal(lanSyncJson({ value: "<script>" }), "{\"value\":\"\\u003cscript>\"}");
});

await test("LAN sync landing and not-found HTML escape session content", () => {
  const landing = lanSyncLandingHtml([session()]);
  assert.match(landing, /tok%3Cen/);
  assert.match(landing, /sync &lt;one&gt;/);
  assert.doesNotMatch(landing, /sync <one>/);

  const missing = lanSyncSessionNotFoundHtml("/s/missing<tag>", [session({ token: "known" })]);
  assert.match(missing, /missing&lt;tag&gt;/);
  assert.match(missing, /\/s\/known/);
});

await test("LAN sync response sets no-store CORS headers", () => {
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
  lanSyncResponse(res, 201, "ok", "text/plain");
  assert.equal(res.status, 201);
  assert.equal(res.body, "ok");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
});

await test("authenticated mobile workspace mounts the existing Pi-web Agent surface", async () => {
  const [mainSource, preloadSource] = await Promise.all([
    readFile("src/main/main.ts", "utf8"),
    readFile("src/main/preload.ts", "utf8")
  ]);
  assert.match(mainSource, /id="openMobileAgent"/);
  assert.match(mainSource, /let reviewScrollY = 0;/);
  assert.match(mainSource, /if \(enteringAgent\) reviewScrollY = window\.scrollY/);
  assert.match(mainSource, /if \(leavingAgent\) requestAnimationFrame\(\(\) => window\.scrollTo\(0, reviewScrollY\)\)/);
  assert.match(mainSource, /id="agentBack"/);
  assert.match(mainSource, /id="remoteAgentRoot"/);
  assert.match(mainSource, /position:fixed; inset:0/);
  assert.match(mainSource, /#app { min-height:100dvh; display:flex; flex-direction:column; }/);
  assert.match(mainSource, /article { display:flex; flex-direction:column;/);
  assert.doesNotMatch(mainSource, /id="agentTab"/);
  assert.match(mainSource, /\/api\/agent\//);
  assert.match(mainSource, /\/agent-assets\//);
  assert.match(mainSource, /lanAgentBridgeScript/);
  assert.match(mainSource, /"X-Accel-Buffering": "no"/);
  assert.match(mainSource, /: heartbeat /);
  assert.match(mainSource, /res\.once\("close", cleanup\)/);
  assert.doesNotMatch(mainSource, /req\.on\("close", \(\) => session\.clients\.delete\(res\)\)/);
  assert.doesNotMatch(mainSource, /function renderRemoteAgentMessage/);
  assert.match(preloadSource, /agentSession:/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
