import { app, BrowserWindow, type BrowserView } from "electron";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { renderLineReviewHtml } from "../src/shared/core/html.ts";
import { saveAgentProviderConfig } from "../src/main/ipc/agentProviderHandlers.ts";

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-lan-agent-"));
const htmlDir = path.join(outputDir, ".translation-workshop", "html");
const sourcePath = path.join(outputDir, "source.txt");
const translationPath = path.join(outputDir, "translation.txt");
const lineReviewPath = path.join(htmlDir, "line-review-lan-agent.html");
let providerRequests = 0;
const providerServer = createServer((req, res) => {
  providerRequests += 1;
  const requestNumber = providerRequests;
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${JSON.stringify({
    id: "remote-agent-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "远程 Agent " }, finish_reason: null }]
  })}\n\n`);
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({
      id: "remote-agent-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: `回复正常 ${requestNumber}` }, finish_reason: null }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "remote-agent-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  }, 400);
});
await new Promise<void>((resolve, reject) => {
  providerServer.once("error", reject);
  providerServer.listen(0, "127.0.0.1", () => resolve());
});
const providerPort = (providerServer.address() as AddressInfo).port;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reportStage(stage: string): void {
  console.log(`[lan-agent-verifier] ${stage}`);
}

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

async function captureFreshPage(window: BrowserWindow, outputPath: string): Promise<Buffer> {
  await window.webContents.capturePage();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const image = await window.webContents.capturePage();
  const png = image.toPNG();
  await writeFile(outputPath, png);
  return png;
}

await mkdir(htmlDir, { recursive: true });
await Promise.all([
  writeFile(sourcePath, "原文", "utf8"),
  writeFile(translationPath, "译文", "utf8")
]);
await writeFile(lineReviewPath, renderLineReviewHtml({
  title: "LAN Agent fixture",
  sourceText: "原文",
  translationText: "译文",
  lineReviewPath,
  workflow: { sourcePath, translationPath, outputDir }
}), "utf8");
await saveAgentProviderConfig({
  outputDir,
  activeProviderId: "lan-test",
  provider: {
    id: "lan-test",
    presetId: "custom-api",
    type: "openai_compatible",
    name: "LAN test provider",
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    model: "lan-test-model",
    models: ["lan-test-model"],
    enabled: true,
    auth: { kind: "api_key", key: "test-key" }
  }
});

app.setAppPath(root);
app.disableHardwareAcceleration();
await import("../src/main/main.ts");

async function run(): Promise<void> {
  reportStage("waiting for product renderer");
  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("renderer/index.html")),
    Boolean,
    "the product renderer"
  );
  assert(mainWindow, "Product renderer was not created");
  reportStage("opening line review");
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('typeof window.workshop?.openReviewHtml === "function"').catch(() => false),
    Boolean,
    "the HTML open bridge"
  );
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: lineReviewPath, outputDir })})`
  );
  const viewerWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
    Boolean,
    "the HTML tab viewer"
  );
  assert(viewerWindow, "HTML tab viewer was not created");
  reportStage("starting LAN workspace");
  const lineView = await waitFor(
    () => viewerWindow.getBrowserView(),
    (view): view is BrowserView => Boolean(view && !view.webContents.isDestroyed()),
    "the line-review BrowserView"
  );
  await waitFor(
    () => lineView.webContents.executeJavaScript('Boolean(document.querySelector("#startLanSync"))').catch(() => false),
    Boolean,
    "the LAN sync controls"
  );
  await lineView.webContents.executeJavaScript(`(() => {
    document.querySelector("#lanSyncPin").value = "123456";
    document.querySelector("#startLanSync").click();
  })()`);
  const localUrl = await waitFor(
    () => lineView.webContents.executeJavaScript(`[...document.querySelectorAll("#lanSyncLinks a")].map(a => a.href).find(href => href.includes("127.0.0.1")) || ""`),
    (value) => typeof value === "string" && value.includes("127.0.0.1"),
    "the local authenticated workspace URL"
  );
  const sessionUrl = new URL(localUrl);
  const token = decodeURIComponent(sessionUrl.pathname.split("/").filter(Boolean).at(-1) || "");
  assert(token, "LAN session token was missing");
  const origin = sessionUrl.origin;
  reportStage("authenticating LAN workspace");
  const authResponse = await fetch(`${origin}/api/auth/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "123456" })
  });
  assert(authResponse.ok, `LAN authentication failed: ${authResponse.status}`);
  const auth = await authResponse.json() as { authToken?: string };
  assert(auth.authToken, "LAN authentication token was missing");

  const configuredModelsResponse = await fetch(`${origin}/api/agent/${encodeURIComponent(token)}?auth=${encodeURIComponent(auth.authToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "listConfiguredModels", args: {} })
  });
  assert(configuredModelsResponse.ok, `Remote configured-model lookup failed: ${configuredModelsResponse.status}`);
  const configuredModels = await configuredModelsResponse.json() as Array<{ providerId?: string; modelId?: string }>;
  assert(
    configuredModels.some((model) => model.providerId === "lan-test" && model.modelId === "lan-test-model"),
    `Remote Agent did not resolve the configured test provider: ${JSON.stringify(configuredModels)}`
  );

  const unauthorized = await fetch(`${origin}/api/agent/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "loadBootstrap", args: {} })
  });
  assert(unauthorized.status === 401, "Remote Agent API must require LAN authentication");

  const remoteWindow = new BrowserWindow({
    show: process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1",
    width: 1080,
    height: 820
  });
  reportStage("opening remote workspace");
  await remoteWindow.loadURL(sessionUrl.toString());
  await remoteWindow.webContents.executeJavaScript(
    `sessionStorage.setItem(${JSON.stringify(`translation-workshop:lan-auth:${token}`)}, ${JSON.stringify(auth.authToken)})`
  );
  await remoteWindow.webContents.reload();
  await waitFor(
    () => remoteWindow.webContents.executeJavaScript('Boolean(document.querySelector("#agentTab")) && !document.querySelector("#app").hidden').catch(() => false),
    Boolean,
    "the authenticated remote workspace"
  );
  reportStage("verifying desktop line edit persistence and LAN convergence");
  await lineView.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(".row[data-line='1'] .target");
    target.textContent = "桌面同步译文";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "桌面同步译文" }));
  })()`);
  await waitFor(
    async () => {
      const [remoteText, response] = await Promise.all([
        remoteWindow.webContents.executeJavaScript('document.querySelector("#rows textarea")?.value || ""'),
        fetch(`${origin}/api/session/${encodeURIComponent(token)}?auth=${encodeURIComponent(auth.authToken)}`)
      ]);
      const payload = await response.json() as { documents?: { line?: { state?: { edits?: Record<string, unknown> } } } };
      return {
        remoteText,
        canonicalText: payload.documents?.line?.state?.edits?.["1"]
      };
    },
    (value) => value.remoteText === "桌面同步译文" && value.canonicalText === "桌面同步译文",
    "the canonical desktop-to-LAN line edit"
  );

  reportStage("verifying remote line edit persistence and desktop convergence");
  await remoteWindow.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#rows textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "远程同步译文");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(
    () => lineView.webContents.executeJavaScript('document.querySelector(".row[data-line=\\"1\\"] .target")?.textContent || ""'),
    (value) => value === "远程同步译文",
    "the canonical LAN-to-desktop line edit"
  );
  await remoteWindow.webContents.executeJavaScript('document.querySelector("#agentTab").click()');
  reportStage("waiting for remote Agent composer");
  await waitFor(
    () => remoteWindow.webContents.executeJavaScript('Boolean(document.querySelector("#remoteAgentRoot .ynAgent textarea"))').catch(() => false),
    Boolean,
    "the reused Pi-web Agent composer"
  );
  await remoteWindow.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#remoteAgentRoot .ynAgent textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "你好，验证远程交互");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  })()`);
  reportStage("waiting for streamed remote reply");
  const remoteState = await waitFor(
    () => remoteWindow.webContents.executeJavaScript(`({
      text: document.querySelector("#remoteAgentRoot .ynAgentTranscript")?.textContent || "",
      running: Boolean(document.querySelector("#remoteAgentRoot .ynAgentTopbarRunning")),
      composer: Boolean(document.querySelector("#remoteAgentRoot .ynAgent textarea")),
      close: Boolean(document.querySelector("#remoteAgentRoot button[title*='Close'], #remoteAgentRoot button[title*='关闭']"))
    })`),
    (value) => typeof value?.text === "string" && value.text.includes("远程 Agent 回复正常") && value.running === false,
    "the streamed remote Agent reply",
    20_000
  );
  await new Promise((resolve) => setTimeout(resolve, 750));
  const stableRemoteState = await remoteWindow.webContents.executeJavaScript(`({
    text: document.querySelector("#remoteAgentRoot .ynAgentTranscript")?.textContent || "",
    sessions: document.querySelectorAll("#remoteAgentRoot .ynAgentSessionItem").length,
    running: Boolean(document.querySelector("#remoteAgentRoot .ynAgentTopbarRunning")),
    agentVisible: !document.querySelector("#agentPanel").hidden
  })`);
  assert(stableRemoteState.text.includes("你好，验证远程交互"), "Remote user message disappeared after native Pi settled");
  assert(stableRemoteState.text.includes("远程 Agent 回复正常"), "Remote assistant reply disappeared after native Pi settled");
  assert(stableRemoteState.running === false, "Remote Agent remained running after the native Pi reply settled");
  assert(stableRemoteState.agentVisible === true, "Remote Agent panel closed without user action");
  const desktopSharedMessages = await mainWindow.webContents.executeJavaScript(`(async () => {
    const bootstrap = await window.workshop.agentSession.loadBootstrap({ outputDir: ${JSON.stringify(outputDir)} });
    if (!bootstrap.activeSessionId) return [];
    return window.workshop.agentSession.loadMessages({
      outputDir: ${JSON.stringify(outputDir)},
      sessionId: bootstrap.activeSessionId
    });
  })()`);
  const desktopSharedText = JSON.stringify(desktopSharedMessages);
  assert(desktopSharedText.includes("你好，验证远程交互"), "Desktop Agent did not see the remote user message in the shared Pi session");
  assert(desktopSharedText.includes("远程 Agent 回复正常"), "Desktop Agent did not see the remote assistant reply in the shared Pi session");
  reportStage("verifying remote terminal convergence after the Agent event stream drops");
  await remoteWindow.webContents.executeJavaScript('document.querySelector("#remoteAgentRoot .ynAgentSidebarHeader button")?.click()');
  await waitFor(
    () => remoteWindow.webContents.executeJavaScript(`({
      sessions: document.querySelectorAll("#remoteAgentRoot .ynAgentSessionItem").length,
      text: document.querySelector("#remoteAgentRoot .ynAgentTranscript")?.textContent || "",
      composer: Boolean(document.querySelector("#remoteAgentRoot .ynAgent textarea"))
    })`),
    (value) => value?.sessions === 2 && value?.composer === true && !value?.text.includes("远程 Agent 回复正常 1"),
    "a fresh remote Pi session for the dropped-stream turn"
  );
  await remoteWindow.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#remoteAgentRoot .ynAgent textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "事件流断开后的远程消息");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  })()`);
  await waitFor(
    () => providerRequests,
    (value) => value >= 2,
    "the second remote prompt to reach the local Pi provider"
  );
  await remoteWindow.webContents.executeJavaScript("window.__ynLanAgentEventSource.close()");
  await waitFor(
    () => mainWindow.webContents.executeJavaScript(`(async () => {
      const bootstrap = await window.workshop.agentSession.loadBootstrap({ outputDir: ${JSON.stringify(outputDir)} });
      if (!bootstrap.activeSessionId) return { running: true, messages: [] };
      return {
        running: (await window.workshop.agentSession.loadRunState({
          outputDir: ${JSON.stringify(outputDir)},
          sessionId: bootstrap.activeSessionId
        })).running,
        messages: await window.workshop.agentSession.loadMessages({
          outputDir: ${JSON.stringify(outputDir)},
          sessionId: bootstrap.activeSessionId
        })
      };
    })()`),
    (value) => value?.running === false && JSON.stringify(value?.messages).includes("远程 Agent 回复正常 2"),
    "the dropped-stream reply to settle in the local durable Pi session",
    8_000
  );
  const droppedStreamRemoteState = await waitFor(
    () => remoteWindow.webContents.executeJavaScript(`({
      text: document.querySelector("#remoteAgentRoot .ynAgentTranscript")?.textContent || "",
      running: Boolean(document.querySelector("#remoteAgentRoot .ynAgentTopbarRunning")),
      topbarClass: document.querySelector("#remoteAgentRoot .ynAgentTopbar")?.className || "",
      topbarText: document.querySelector("#remoteAgentRoot .ynAgentTopbarTitle")?.textContent || "",
      stopVisible: Boolean(document.querySelector("#remoteAgentRoot [data-agent-stop='true']")),
      statsStatus: document.querySelector("#remoteAgentRoot [data-agent-run-status]")?.getAttribute("data-agent-run-status") || "closed"
    })`),
    (value) => typeof value?.text === "string"
      && value.text.includes("事件流断开后的远程消息")
      && value.text.includes("远程 Agent 回复正常 2")
      && value.running === false
      && value.stopVisible === false,
    "the remote transcript to converge after its Agent event stream dropped",
    8_000
  );
  await new Promise((resolve) => setTimeout(resolve, 750));
  const stableDroppedStreamRemoteState = await remoteWindow.webContents.executeJavaScript(`(async () => {
    const bootstrap = await window.workshop.agentSession.loadBootstrap({ outputDir: ${JSON.stringify(outputDir)} });
    const sessionId = bootstrap.activeSessionId;
    return {
      text: document.querySelector("#remoteAgentRoot .ynAgentTranscript")?.textContent || "",
      running: Boolean(document.querySelector("#remoteAgentRoot .ynAgentTopbarRunning")),
      topbarClass: document.querySelector("#remoteAgentRoot .ynAgentTopbar")?.className || "",
      topbarText: document.querySelector("#remoteAgentRoot .ynAgentTopbarTitle")?.textContent || "",
      stopVisible: Boolean(document.querySelector("#remoteAgentRoot [data-agent-stop='true']")),
      statsStatus: document.querySelector("#remoteAgentRoot [data-agent-run-status]")?.getAttribute("data-agent-run-status") || "closed",
      durableState: await window.workshop.agentSession.loadRunState({ outputDir: ${JSON.stringify(outputDir)}, sessionId }),
      durableMessages: await window.workshop.agentSession.loadMessages({ outputDir: ${JSON.stringify(outputDir)}, sessionId })
    };
  })()`);
  assert(
    stableDroppedStreamRemoteState.running === false
      && stableDroppedStreamRemoteState.stopVisible === false
      && stableDroppedStreamRemoteState.text.includes("事件流断开后的远程消息")
      && stableDroppedStreamRemoteState.text.includes("远程 Agent 回复正常 2"),
    `Remote Agent lost its converged terminal transcript: ${JSON.stringify(stableDroppedStreamRemoteState)}`
  );
  const droppedStreamScreenshotPath = path.join(root, "artifacts", "lan-agent-remote-event-drop-recovery.png");
  await mkdir(path.dirname(droppedStreamScreenshotPath), { recursive: true });
  await remoteWindow.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector("#remoteAgentRoot .ynAgentTranscript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    const messages = document.querySelectorAll("#remoteAgentRoot .ynAgentMessage");
    [...messages].find((message) => message.textContent?.includes("远程 Agent 回复正常 2"))
      ?.scrollIntoView({ block: "center", behavior: "instant" });
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await captureFreshPage(remoteWindow, droppedStreamScreenshotPath);
  reportStage("verifying reconnect convergence");
  await remoteWindow.webContents.executeJavaScript("window.__ynLanAgentEventSource.close()");
  reportStage("sending desktop turn while remote SSE is closed");
  const desktopPromptSessionId = await mainWindow.webContents.executeJavaScript(`(async () => {
    const bootstrap = await window.workshop.agentSession.loadBootstrap({ outputDir: ${JSON.stringify(outputDir)} });
    await window.workshop.agentSession.sendPrompt({
      outputDir: ${JSON.stringify(outputDir)},
      sessionId: bootstrap.activeSessionId,
      prompt: "桌面断线期间的消息",
      providerId: "lan-test",
      modelId: "lan-test-model",
      thinkingLevel: "off"
    });
    return bootstrap.activeSessionId;
  })()`);
  await waitFor(
    () => mainWindow.webContents.executeJavaScript(`(async () => ({
      state: await window.workshop.agentSession.loadRunState({ outputDir: ${JSON.stringify(outputDir)}, sessionId: ${JSON.stringify(desktopPromptSessionId)} }),
      messages: await window.workshop.agentSession.loadMessages({ outputDir: ${JSON.stringify(outputDir)}, sessionId: ${JSON.stringify(desktopPromptSessionId)} })
    }))()`),
    (value) => value?.state?.running === false && JSON.stringify(value?.messages).includes("桌面断线期间的消息"),
    "the desktop turn completed while the remote SSE client was disconnected",
    20_000
  );
  reportStage("desktop turn settled; reopening remote SSE");
  await remoteWindow.webContents.executeJavaScript('window.__ynLanAgentEventSource.dispatchEvent(new Event("open"))');
  await waitFor(
    () => remoteWindow.webContents.executeJavaScript(`({
      text: document.querySelector("#remoteAgentRoot .ynAgentTranscript")?.textContent || "",
      running: Boolean(document.querySelector("#remoteAgentRoot .ynAgentTopbarRunning"))
    })`),
    (value) => typeof value?.text === "string"
      && value.text.includes("桌面断线期间的消息")
      && value.text.includes("远程 Agent 回复正常 3")
      && value.running === false,
    "the remote transcript resynced after SSE reconnect",
    10_000
  );
  reportStage("remote transcript converged");
  reportStage("waiting for remote paint");
  await remoteWindow.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector("#remoteAgentRoot .ynAgentTranscript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  reportStage("capturing remote screenshot");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  const screenshotPath = path.join(root, "artifacts", "lan-agent-remote.png");
  const finalScreenshot = await captureFreshPage(remoteWindow, screenshotPath);
  await writeFile(droppedStreamScreenshotPath, finalScreenshot);
  reportStage("collapsing remote Agent panel");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await remoteWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("yn-remote-agent-close"))');
  const collapsed = await remoteWindow.webContents.executeJavaScript('document.querySelector("#agentPanel").hidden && !document.querySelector("#rows").hidden');
  assert(collapsed, "Remote Agent panel did not collapse back to review mode");
  assert(providerRequests > 0, "Remote prompt did not reach the native Pi provider path");
  reportStage("complete");
  console.log(JSON.stringify({
    ok: true,
    lanRemoteAgentOpen: true,
    lanRemoteAgentPrompt: true,
    sharedNativePiProviderRequests: providerRequests,
    desktopSharedSession: true,
    reconnectTranscriptResynced: true,
    droppedAgentEventStreamRecovered: droppedStreamRemoteState.running === false,
    desktopLineEditSynced: true,
    remoteLineEditSynced: true,
    unauthorizedRejected: true,
    collapsed,
    screenshotPath,
    droppedStreamScreenshotPath,
    remoteState: stableRemoteState
  }));
}

void app.whenReady().then(run).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  await new Promise<void>((resolve) => providerServer.close(() => resolve())).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
