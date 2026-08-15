import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

import {
  createLanAgentGateway,
  lanAgentBridgeScript,
  normalizeLanAgentRequest
} from "../../src/main/lanAgentRemote.ts";

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

function fakeService(calls) {
  return {
    bootstrap: async (workspaceDir) => (calls.push(["bootstrap", workspaceDir]), { activeSessionId: "s1", sessions: [] }),
    loadMessages: async (workspaceDir, sessionId) => (calls.push(["messages", workspaceDir, sessionId]), []),
    loadSubagentMessages: async (workspaceDir, parentSessionId, childSessionId) => (calls.push(["childMessages", workspaceDir, parentSessionId, childSessionId]), []),
    getRunState: async (workspaceDir, sessionId) => (calls.push(["runState", workspaceDir, sessionId]), { sessionId, running: false, sequence: 0 }),
    listRecentEvents: (workspaceDir, sessionId, afterSequence) => (calls.push(["events", workspaceDir, sessionId, afterSequence]), []),
    createSession: async (workspaceDir) => (calls.push(["create", workspaceDir]), { id: "s2" }),
    selectSession: async (workspaceDir, sessionId) => calls.push(["select", workspaceDir, sessionId]),
    deleteSession: async (workspaceDir, sessionId) => (calls.push(["delete", workspaceDir, sessionId]), true),
    prompt: async (request) => (calls.push(["prompt", request]), { accepted: true, sessionId: request.sessionId }),
    compact: async (request) => (calls.push(["compact", request]), { compacted: true }),
    abort: async (workspaceDir, sessionId) => calls.push(["abort", workspaceDir, sessionId]),
    sendInput: async (workspaceDir, sessionId, kind, text) => calls.push(["input", workspaceDir, sessionId, kind, text])
  };
}

await test("LAN Agent request accepts only the native Pi bridge allowlist", () => {
  assert.deepEqual(normalizeLanAgentRequest({ method: "loadBootstrap", args: {} }), { method: "loadBootstrap", args: {} });
  assert.equal(normalizeLanAgentRequest({ method: "run-shell", args: {} }), undefined);
  assert.equal(normalizeLanAgentRequest(null), undefined);
});

await test("LAN Agent gateway forces the shared workspace and delegates to the native Pi service", async () => {
  const calls = [];
  const gateway = createLanAgentGateway({
    sessionService: fakeService(calls),
    providerService: {
      getConfig: async () => ({ activeProviderId: "p", providers: {} }),
      listConfiguredModels: async () => [],
      saveConfig: async () => ({ activeProviderId: "p", providers: {} })
    }
  });
  await gateway.invoke("C:\\project", { method: "sendPrompt", args: {
    outputDir: "C:\\attacker",
    sessionId: "s1",
    prompt: "hello",
    providerId: "p",
    modelId: "m"
  } });
  assert.equal(calls[0][0], "prompt");
  assert.equal(calls[0][1].outputDir, "C:\\project");
  await gateway.invoke("C:\\project", { method: "sendInput", args: { sessionId: "s1", kind: "steer", text: "now" } });
  assert.deepEqual(calls[1], ["input", "C:\\project", "s1", "steer", "now"]);
  await gateway.invoke("C:\\project", { method: "abort", args: { sessionId: "s1" } });
  assert.deepEqual(calls[2], ["abort", "C:\\project", "s1"]);
});

await test("remote bridge exposes the existing Pi-web workshop contract without a second renderer", () => {
  const source = lanAgentBridgeScript("token", { outputDir: "lan:token", locale: "zh-CN" });
  assert.match(source, /window\.workshop\s*=/);
  assert.match(source, /agentSession/);
  assert.match(source, /onEvent/);
  assert.match(source, /onSessionUpdate/);
  assert.match(source, /YnPiWebAgentEmbedded\.mount/);
  assert.match(source, /await connectEvents\(\)/);
  assert.match(source, /async function resync/);
  assert.match(source, /async function convergeAcceptedInput/);
  assert.match(source, /const state = await call\("loadRunState"/);
  assert.match(source, /publishState\(state, true\)/);
  assert.match(source, /sendPrompt,/);
  assert.match(source, /async function sendInput/);
  assert.match(source, /startInputConvergence\(args\?\.sessionId\)/);
  assert.match(source, /loadRunState/);
  assert.match(source, /selectionChange: true/);
  assert.doesNotMatch(source, /C:\\project/);
  assert.doesNotMatch(source, /renderMessage|toolCallBubble|thinkingBubble/);
});

await test("remote reconnect forces the existing Pi-web session loader to refresh the shared transcript", async () => {
  const source = await readFile(new URL("../../src/renderer/agent/piweb/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(source, /payload\.selectionChange && payload\.state\.sessionId/);
  assert.match(source, /loadSelectedSession\(payload\.state\.sessionId, resyncEpoch\)/);
});

await test("desktop provider updates are forwarded to authenticated remote Agent clients", async () => {
  const source = await readFile(new URL("../../src/main/main.ts", import.meta.url), "utf8");
  assert.match(source, /subscribePiSessionBroadcast/);
  assert.match(source, /agent-provider:update/);
  assert.match(source, /broadcastLanAgent\("agent-provider"/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
