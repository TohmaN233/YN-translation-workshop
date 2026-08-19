import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

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

async function loadChatWindowModule() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "yn-chat-lifecycle-"));
  const outfile = path.join(tempDir, "ChatWindow.mjs");
  await build({
    entryPoints: [path.resolve("src/renderer/agent/piweb/ChatWindow.tsx")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic"
  });
  return {
    module: await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`),
    close: () => rm(tempDir, { recursive: true, force: true })
  };
}

await test("dock close awaits native Pi abort before hiding a running Agent surface", async () => {
  const loaded = await loadChatWindowModule();
  try {
    assert.equal(typeof loaded.module.closeAgentSurface, "function");
    const order = [];
    await loaded.module.closeAgentSurface({
      agentRunning: true,
      abort: async () => {
        order.push("abort:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("abort:complete");
      },
      close: () => order.push("hide")
    });
    assert.deepEqual(order, ["abort:start", "abort:complete", "hide"]);
  } finally {
    await loaded.close();
  }
});

await test("the Agent composer exposes Steer, Follow-up, and abort-carried next-turn input", async () => {
  const loaded = await loadChatWindowModule();
  try {
    assert.equal(typeof loaded.module.buildQueuedInputs, "function");
    const steer = { role: "user", content: "steer now", timestamp: 1 };
    const followUp = { role: "user", content: "follow later", timestamp: 2 };
    const nextTurn = { role: "user", content: "preserved after stop", timestamp: 3 };
    assert.deepEqual(
      loaded.module.buildQueuedInputs([steer], [followUp], [nextTurn]),
      [
        { kind: "steer", message: steer, text: "steer now", imageCount: 0 },
        { kind: "followUp", message: followUp, text: "follow later", imageCount: 0 },
        { kind: "nextTurn", message: nextTurn, text: "preserved after stop", imageCount: 0 }
      ]
    );
  } finally {
    await loaded.close();
  }
});

await test("the popout locks scrolling to the transcript and compaction success is transient", async () => {
  const [windowSource, inputSource, messageViewSource, styles] = await Promise.all([
    readFile("src/renderer/agent/PiWebAgentWindow.tsx", "utf8"),
    readFile("src/renderer/agent/piweb/ChatInput.tsx", "utf8"),
    readFile("src/renderer/agent/piweb/MessageView.tsx", "utf8"),
    readFile("src/renderer/styles.css", "utf8")
  ]);
  assert.match(windowSource, /document\.body\.classList\.add\("ynAgentWindowBody"\)/);
  assert.match(windowSource, /document\.body\.classList\.remove\("ynAgentWindowBody"\)/);
  assert.match(styles, /body\.ynAgentWindowBody\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /body\.ynAgentWindowBody\s*>\s*#root\s*\{[^}]*height:\s*100%/s);
  assert.match(styles, /\.ynAgentSidebarSection\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(inputSource, /const COMPACTION_NOTICE_MS = 2_000/);
  assert.match(inputSource, /setVisibleCompactResult\(compactResult\)/);
  assert.match(inputSource, /setVisibleCompactResult\(null\)/);
  assert.match(messageViewSource, /data-agent-message-error="true"/);
  assert.match(messageViewSource, /message\.stopReason === "error"/);
});

await test("Agent transcript scrolling never uses scrollIntoView on the host HTML", async () => {
  const [chatWindow, styles, embed] = await Promise.all([
    readFile("src/renderer/agent/piweb/ChatWindow.tsx", "utf8"),
    readFile("src/renderer/styles.css", "utf8"),
    readFile("src/shared/core/agentChatEmbed.ts", "utf8")
  ]);
  assert.doesNotMatch(chatWindow, /scrollIntoView/);
  assert.match(chatWindow, /scrollTranscriptToBottom\(scrollContainerRef\.current, behavior\)/);
  assert.match(chatWindow, /toggleSessionSidebar/);
  assert.match(chatWindow, /captureHostPageScroll\(\)/);
  assert.match(chatWindow, /restoreHostPageScroll\(snapshot\)/);
  assert.match(styles, /\.ynAgentTranscript\s*\{[^}]*overflow-anchor:\s*none/s);
  assert.match(styles, /\.ynAgentTranscript\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(embed, /function readReviewScroll\(\)/);
  assert.match(embed, /function writeReviewScroll\(top\)/);
  assert.match(embed, /const top = readReviewScroll\(\);/);
  assert.match(embed, /requestAnimationFrame\(\(\) => writeReviewScroll\(top\)\)/);
  assert.match(embed, /overflow-anchor: none/);
});

await test("transcript and host page scroll helpers stay inside their own containers", async () => {
  const loaded = await loadChatWindowModule();
  try {
    const calls = [];
    const container = {
      scrollHeight: 2400,
      clientHeight: 800,
      scrollTo(options) { calls.push(options); }
    };
    loaded.module.scrollTranscriptToBottom(container, "instant");
    assert.deepEqual(calls, [{ top: 1600, behavior: "instant" }]);

    const main = { scrollTop: 888, isConnected: true };
    const doc = {
      querySelector(selector) { return selector === ".line-review-main" ? main : null; },
      scrollingElement: { scrollTop: 12 },
      documentElement: { scrollTop: 12 }
    };
    const snapshot = loaded.module.captureHostPageScroll(doc);
    assert.deepEqual({ top: snapshot.top, same: snapshot.target === main }, { top: 888, same: true });
    main.scrollTop = 0;
    loaded.module.restoreHostPageScroll(snapshot, doc);
    assert.equal(main.scrollTop, 888);
    assert.equal(doc.scrollingElement.scrollTop, 12);
  } finally {
    await loaded.close();
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
