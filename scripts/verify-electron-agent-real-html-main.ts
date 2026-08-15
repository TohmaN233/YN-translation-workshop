import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { readOAuthProfiles, writeOAuthProfiles } from "../src/main/agent/oauthProfilesStore.ts";
import { piNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import { openAgentChatWindow as openAgentChatWindowHost } from "../src/main/agent/piNative/agentChatWindowHost.ts";
import { readProviderConfig, updateProviderConfig, writeProviderConfig } from "../src/main/agent/providerConfigStore.ts";
import { resolveTranslationCandidatePath } from "../src/main/agent/writeTranslationChunk.ts";
import { registerAgentProviderIpc } from "../src/main/ipc/agentProviderHandlers.ts";
import { registerAgentSessionIpc } from "../src/main/ipc/agentSessionHandlers.ts";
import { listModelsForProvider } from "../src/shared/agent/providerModels.ts";
import { renderLineReviewHtml } from "../src/shared/core/html.ts";
import { buildTranslatePrompt } from "../src/shared/core/prompts.ts";
import { validateTranslationCandidate } from "../src/shared/validation/translationValidator.ts";

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-real-provider-workspace-"));
const workspaceDir = path.join(outputDir, ".translation-workshop");
const htmlPath = path.join(outputDir, "real-provider-review.html");
const sourcePath = path.join(outputDir, "real-provider-source.txt");
const artifactsDir = path.join(root, "artifacts");
const streamingScreenshot = path.join(artifactsDir, "electron-agent-real-streaming.png");
const completeScreenshot = path.join(artifactsDir, "electron-agent-real-complete.png");
const subagentsRunningScreenshot = path.join(artifactsDir, "electron-agent-real-subagents-running.png");
const subagentReplyScreenshot = path.join(artifactsDir, "electron-agent-real-subagent-reply.png");
const translationCompleteScreenshot = path.join(artifactsDir, "electron-agent-real-translation-complete.png");
const boundedRepairScreenshot = path.join(artifactsDir, "electron-agent-real-bounded-repair-complete.png");
const providerId = String(process.env.TW_REAL_PROVIDER_ID || "openai-chatgpt").trim();
const modelId = String(process.env.TW_REAL_PROVIDER_MODEL || "gpt-5.4-mini").trim();
const configSource = String(process.env.TW_REAL_PROVIDER_CONFIG_WORKSPACE_DIR || "").trim();
const projectConfigSource = String(process.env.TW_REAL_PROVIDER_PROJECT_WORKSPACE_DIR || "").trim();
const keepTemp = /^(1|true|yes)$/i.test(String(process.env.TW_REAL_PROVIDER_KEEP_TEMP || ""));
const boundedRepairOnly = /^(1|true|yes)$/i.test(String(process.env.TW_REAL_BOUNDED_REPAIR_ONLY || ""));
const timeoutMs = Math.max(60_000, Number(process.env.TW_REAL_PROVIDER_TIMEOUT_MS || 240_000));

app.setPath("userData", path.join(outputDir, "electron-user-data"));
app.setPath("cache", path.join(outputDir, "electron-cache"));

let win: BrowserWindow | undefined;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function mark(stage: string): void {
  console.log(`[electron-pi-real] ${stage}`);
}

function revealVerificationWindow(target: BrowserWindow): void {
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS === "1") return;
  target.show();
  target.focus();
}

function configWorkspace(value: string): string {
  const resolved = path.resolve(value);
  if (existsSync(path.join(resolved, "agent", "provider-config.json"))) return resolved;
  return path.basename(resolved).toLowerCase() === ".translation-workshop"
    ? resolved
    : path.join(resolved, ".translation-workshop");
}

async function prepareProvider(): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  let sourceConfig;
  if (configSource) {
    const sourceWorkspace = configWorkspace(configSource);
    sourceConfig = await readProviderConfig(sourceWorkspace);
    await writeProviderConfig(workspaceDir, sourceConfig);
    await writeOAuthProfiles(workspaceDir, await readOAuthProfiles(sourceWorkspace));
    try {
      const projectWorkspace = projectConfigSource
        ? configWorkspace(projectConfigSource)
        : sourceWorkspace;
      const project = JSON.parse(await readFile(path.join(projectWorkspace, "project.json"), "utf8")) as {
        agentProxyEnabled?: boolean;
        agentProxyUrl?: string;
      };
      await writeFile(path.join(workspaceDir, "project.json"), JSON.stringify({
        agentProxyEnabled: project.agentProxyEnabled === true,
        agentProxyUrl: typeof project.agentProxyUrl === "string" ? project.agentProxyUrl : ""
      }, null, 2), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else {
    sourceConfig = await readProviderConfig(workspaceDir);
  }
  const provider = sourceConfig.providers[providerId];
  assert(provider?.type === "openai_compatible", `Provider ${providerId} is not configured.`);
  await updateProviderConfig(workspaceDir, {
    activeProviderId: providerId,
    provider: { ...provider, model: modelId }
  });
}

async function rendererAssetUrl(prefix: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(path.join(root, "dist", "renderer", "assets"));
  const match = files.find((file) => file.startsWith(prefix) && file.endsWith(".js"));
  if (!match) throw new Error(`Missing renderer asset ${prefix}`);
  return pathToFileURL(path.join(root, "dist", "renderer", "assets", match)).toString();
}

async function rendererCssAssetUrl(): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(path.join(root, "dist", "renderer", "assets"));
  const match = files.find((file) => file.startsWith("styles-") && file.endsWith(".css"));
  return match ? pathToFileURL(path.join(root, "dist", "renderer", "assets", match)).toString() : undefined;
}

async function waitFor(expression: string, limit = timeoutMs): Promise<number> {
  assert(win, "Electron window is unavailable.");
  const started = performance.now();
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false);
    if (found) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function clickSelector(selector: string, limit = 3_000): Promise<void> {
  assert(win, "Electron window is unavailable.");
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLElement)) return false;
      node.click();
      return true;
    })()`).catch(() => false);
    if (clicked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Could not click ${selector} within ${limit}ms`);
}

async function sendMessage(text: string, workflowIntent?: "translation" | "proofread"): Promise<number> {
  assert(win, "Electron window is unavailable.");
  revealVerificationWindow(win);
  win.webContents.focus();
  const prepared = await win.webContents.executeJavaScript(`(() => {
    try {
    const input = window.YnPiWebAgentEmbedded;
    if (!input?.insertText) return { ok: false, error: "Pi-web ChatInput bridge is unavailable." };
    input.insertText(${JSON.stringify(text)}, ${workflowIntent ? JSON.stringify({ workflowIntent, languagePair: "ja->zh-CN" }) : "undefined"});
    return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error), stack: error && error.stack ? String(error.stack) : "" };
    }
  })()`);
  assert(prepared?.ok, `Could not prepare real-provider message: ${prepared?.error || "unknown renderer error"}\n${prepared?.stack || ""}`);
  await waitFor(
    `document.querySelector('#agentChatReactRoot textarea')?.value.includes(${JSON.stringify(text)})`,
    1000
  );
  const composerFocused = await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('#agentChatReactRoot textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    textarea.focus();
    return document.activeElement === textarea;
  })()`);
  assert(composerFocused, "Real-provider composer did not accept focus before native Enter.");
  await waitFor('document.activeElement === document.querySelector("#agentChatReactRoot textarea")', 1000);
  const started = performance.now();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  const optimisticSentinel = text.split(/\r?\n/, 1)[0].slice(0, 80);
  try {
    await waitFor(`[...document.querySelectorAll('[data-agent-message-role="user"]')].some((node) => (node.textContent || "").includes(${JSON.stringify(optimisticSentinel)}))`, 1000);
  } catch (optimisticError) {
    const diagnostics = await win.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('#agentChatReactRoot textarea');
      const buttons = [...document.querySelectorAll('#agentChatReactRoot button')];
      return {
        textareaValue: textarea?.value,
        activeTag: document.activeElement?.tagName,
        activeClass: document.activeElement?.className,
        stopVisible: Boolean(document.querySelector('[data-agent-stop="true"]')),
        sendDisabled: buttons.find((button) => (button.textContent || '').includes('Send'))?.disabled,
        queuedInput: document.querySelector('[data-agent-queued-input]')?.textContent,
        notice: document.querySelector('[data-agent-command-notice]')?.textContent,
        users: [...document.querySelectorAll('[data-agent-message-role="user"]')]
          .map((node) => node.textContent || '')
      };
    })()`);
    throw new Error(
      `${optimisticError instanceof Error ? optimisticError.message : String(optimisticError)}; `
      + `diagnostics=${JSON.stringify(diagnostics)}`
    );
  }
  return performance.now() - started;
}

async function submitComposer(text: string): Promise<void> {
  assert(win, "Electron window is unavailable.");
  revealVerificationWindow(win);
  win.webContents.focus();
  const prepared = await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#agentChatReactRoot textarea");
    if (!textarea) return false;
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    return true;
  })()`);
  assert(prepared, "Agent textarea is unavailable.");
  await new Promise((resolve) => setTimeout(resolve, 30));
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
}

async function capture(targetPath: string): Promise<void> {
  assert(win, "Electron window is unavailable.");
  if (win.isMinimized()) win.restore();
  revealVerificationWindow(win);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const frameLooksCorrupt = (png: Buffer) => {
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) return true;
    const bitmap = image.toBitmap();
    let black = 0;
    let translucent = 0;
    let samples = 0;
    for (let index = 0; index + 3 < bitmap.length; index += 40) {
      const blue = bitmap[index];
      const green = bitmap[index + 1];
      const red = bitmap[index + 2];
      const alpha = bitmap[index + 3];
      samples += 1;
      if (red < 8 && green < 8 && blue < 8 && alpha > 240) black += 1;
      if (alpha < 240) translucent += 1;
    }
    return black / Math.max(1, samples) > 0.08 || translucent / Math.max(1, samples) > 0.02;
  };
  for (const fromSurface of [false, true]) {
    const debug = win.webContents.debugger;
    const attachedHere = !debug.isAttached();
    if (attachedHere) debug.attach("1.3");
    let png: Buffer;
    try {
      const result = await debug.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface,
        captureBeyondViewport: false
      }) as { data?: string };
      png = Buffer.from(result.data || "", "base64");
    } finally {
      if (attachedHere && debug.isAttached()) debug.detach();
    }
    if (png.length > 0 && !frameLooksCorrupt(png)) {
      await writeFile(targetPath, png);
      return;
    }
    if (process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1") {
      win.hide();
      await new Promise((resolve) => setTimeout(resolve, 100));
      revealVerificationWindow(win);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error(`Electron produced a corrupt compositor screenshot for ${targetPath}`);
}

async function run(): Promise<void> {
  if (keepTemp) mark(`workspace-${outputDir}`);
  await prepareProvider();
  registerAgentSessionIpc({
    service: piNativeSessionService,
    broadcast(channel, payload) {
      for (const target of BrowserWindow.getAllWindows()) {
        if (!target.webContents.isDestroyed()) target.webContents.send(channel, payload);
      }
    },
    resolveInterfaceWorkspace: (sender) => sender === win?.webContents ? outputDir : undefined
  });
  registerAgentProviderIpc();
  ipcMain.handle("ui:agentChatEmbeddedEntryUrl", async () => ({
    ok: true,
    url: await rendererAssetUrl("agent-embedded-"),
    cssUrl: await rendererCssAssetUrl()
  }));
  ipcMain.handle("ui:openAgentChatWindow", async (_event, args) => {
    const result = await openAgentChatWindowHost({
      args,
      preloadPath: path.join(root, "dist", "main", "preload.cjs"),
      loadRendererRoute: async (window, route) => {
        await window.loadFile(path.join(root, "dist", "renderer", "index.html"), { hash: route });
      }
    });
    return { ok: true, surface: result.surface };
  });
  ipcMain.handle("html:persistState", async () => ({ ok: true }));
  ipcMain.handle("project:readState", async () => ({}));
  ipcMain.handle("project:patch", async () => true);
  ipcMain.handle("agent-assets:read", async (_event, args: { outputDir?: string } = {}) => ({
    paths: {
      glossary: path.join(args.outputDir || workspaceDir, ".translation-workshop", "glossary.json"),
      characterBible: path.join(args.outputDir || workspaceDir, ".translation-workshop", "character_bible.md"),
      styleGuide: path.join(args.outputDir || workspaceDir, ".translation-workshop", "style_guide.md")
    },
    glossary: { entries: [] },
    characterBible: { characters: [], source: "" },
    styleGuide: "",
    translationMemory: { initialized: false, entryCount: 0 }
  }));
  ipcMain.handle("clipboard:writeText", async () => true);
  ipcMain.handle("shell:openPath", async () => "");
  await mkdir(artifactsDir, { recursive: true });
  const sourceText = "こんにちは {player_name}\n\n<color=#FF0000>危険</color>\n残り %s 秒\\n";
  await writeFile(sourcePath, sourceText, "utf8");
  await writeFile(htmlPath, renderLineReviewHtml({
    title: "Real Pi provider acceptance",
    sourceText,
    translationText: "你好 {player_name}\n\n<color=#FF0000>危险</color>\n剩余 %s 秒\\n",
    lineReviewPath: htmlPath,
    workflow: { outputDir, sourcePath }
  }), "utf8");

  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(root, "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1",
      offscreen: process.env.YN_ELECTRON_VERIFY_OFFSCREEN === "1"
    }
  });
  win.webContents.on("console-message", (details) => {
    console.log(`[real-renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  await win.loadFile(htmlPath);
  await win.webContents.executeJavaScript("(() => { window.confirm = () => true; return true; })()");
  const openStarted = performance.now();
  await clickSelector("#openAgentChat");
  await waitFor('document.querySelector("#agentChatReactRoot textarea")', 3000);
  await waitFor('document.querySelector("[data-agent-model-button=true]")', 3000);
  await win.webContents.executeJavaScript(`(() => {
    window.__ynRealVerifierEvents = [];
    window.__ynRealVerifierStates = [];
    window.workshop.agentSession.onEvent((envelope) => {
      window.__ynRealVerifierEvents.push({
        sessionId: envelope.sessionId,
        sequence: envelope.sequence,
        type: envelope.event && envelope.event.type,
        role: envelope.event && envelope.event.message && envelope.event.message.role
      });
    });
    window.workshop.agentSession.onSessionUpdate((payload) => {
      window.__ynRealVerifierStates.push({
        sessionId: payload.state && payload.state.sessionId,
        sequence: payload.state && payload.state.sequence,
        running: payload.state && payload.state.running
      });
    });
    return true;
  })()`);
  const interactiveMs = performance.now() - openStarted;
  assert(interactiveMs < 3000, `Real-provider Electron UI took ${interactiveMs.toFixed(1)}ms to load.`);
  const modelText = await win.webContents.executeJavaScript('document.querySelector("[data-agent-model-button=true]").innerText');
  const expectedModelLabel = listModelsForProvider(providerId).find((model) => model.id === modelId)?.label || modelId;
  const normalizedModelText = String(modelText).trim().toLowerCase();
  assert(
    normalizedModelText === expectedModelLabel.trim().toLowerCase()
      || normalizedModelText === modelId.trim().toLowerCase(),
    `Chat model selector is not using ${modelId}: ${modelText}`);
  mark(`interactive-${interactiveMs.toFixed(1)}ms`);

  if (boundedRepairOnly) {
    const candidatePath = resolveTranslationCandidatePath({
      outputDir,
      sourcePaths: [sourcePath],
      documentId: path.basename(sourcePath)
    });
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, "（本段译文）\n\n<color=#FF0000>危险</color>\n剩余 %s 秒\\n\n", "utf8");
    const boundedPrompt = [
      "请调用 1 个 subagent 修复当前文件第 1 行占位译文（本段译文）。",
      "先精确读取第 1 行原文和当前译文；子代理必须通过受管候选写入把它改成真实简体中文译文，并调用 validateAssignedTranslation。",
      "子代理完成后，主 Agent 必须调用 validateTranslationArtifact 检查完整文件，再汇报完成。不要由主 Agent 直接写入来绕过失败的子代理。"
    ].join("\n");
    const boundedStarted = performance.now();
    const boundedOptimisticMs = await sendMessage(boundedPrompt, "translation");
    assert(boundedOptimisticMs < 300, `Bounded repair user bubble took ${boundedOptimisticMs.toFixed(1)}ms.`);
    await waitFor('document.querySelector(\'[data-agent-subagent-card="true"][data-agent-subagent-status="running"]\') || !document.querySelector(\'[data-agent-stop="true"]\')');
    assert(
      await win.webContents.executeJavaScript('Boolean(document.querySelector(\'[data-agent-subagent-card="true"][data-agent-subagent-status="running"]\'))'),
      `The real parent stopped before launching the repair child: ${await win.webContents.executeJavaScript('(document.querySelector(".ynAgentTranscript")?.innerText || "").slice(-3000)')}`
    );
    mark("bounded-repair-child-running");
    await waitFor('document.querySelector(\'[data-agent-subagent-card="true"][data-agent-subagent-status="completed"]\')');
    mark("bounded-repair-child-completed");
    await waitFor('document.querySelector("[data-agent-tool-call=validateTranslationArtifact]")');
    await waitFor('!document.querySelector(\'[data-agent-stop="true"]\')');
    const boundedBootstrap = await piNativeSessionService.bootstrap(outputDir);
    assert(boundedBootstrap.sessions.length === 1,
      `Expected one bounded-repair session, found ${boundedBootstrap.sessions.length}.`);
    const boundedMessages = await piNativeSessionService.loadMessages(outputDir, boundedBootstrap.activeSessionId);
    const boundedToolNames = boundedMessages.flatMap((message) => (
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
        : []
    ));
    assert(boundedToolNames.filter((name) => name === "runSubagents").length === 1,
      `Bounded repair did not launch exactly one child: ${boundedToolNames.join(", ")}`);
    assert(boundedToolNames.includes("validateTranslationArtifact"),
      "The parent stopped after child completion instead of running final validation.");
    assert(!boundedMessages.some((message) => JSON.stringify(message).includes("not in this workflow manifest")),
      "The bounded repair child still hit the stale workflow-manifest rejection.");
    const boundedTerminalCards = boundedMessages.filter((message) => (
      message.role === "custom"
      && message.customType === "subagent.translation"
      && message.details?.status === "completed"
    ));
    assert(boundedTerminalCards.length === 1,
      `Bounded repair retained ${boundedTerminalCards.length} completed child cards instead of one.`);
    const repairedCandidateText = await readFile(candidatePath, "utf8");
    assert(!repairedCandidateText.includes("（本段译文）"), "The real child left the placeholder sentence in the candidate.");
    const repairedValidation = validateTranslationCandidate(sourceText, repairedCandidateText, {
      locale: "zh-CN",
      languagePair: "ja->zh-CN",
      detectUntranslated: true
    });
    assert(repairedValidation.ok, `The real bounded child repair failed final validation: ${repairedValidation.summary}`);
    await capture(boundedRepairScreenshot);
    const boundedCompletionMs = performance.now() - boundedStarted;
    mark(`bounded-repair-complete-${boundedCompletionMs.toFixed(1)}ms`);
    console.log(JSON.stringify({
      ok: true,
      mode: "bounded-repair-only",
      providerId,
      modelId,
      interactiveMs: Number(interactiveMs.toFixed(1)),
      boundedRepairOptimisticMs: Number(boundedOptimisticMs.toFixed(1)),
      boundedRepairCompletionMs: Number(boundedCompletionMs.toFixed(1)),
      sessionId: boundedBootstrap.activeSessionId,
      translationCandidatePath: candidatePath,
      screenshot: boundedRepairScreenshot,
      boundedRepairChildValidated: true,
      parentContinuedAfterChild: true,
      outputDir: keepTemp ? outputDir : undefined
    }));
    return;
  }

  const prompt = "请先认真思考，再用 3 个编号要点简短说明真实 Pi、流式消息及翻译校验能力；每点 20 至 35 个中文字符，不调用工具。";
  const sendStarted = performance.now();
  mark("send-start");
  const optimisticMs = await sendMessage(prompt);
  mark(`optimistic-${optimisticMs.toFixed(1)}ms`);
  assert(optimisticMs < 300, `Real-provider optimistic user bubble took ${optimisticMs.toFixed(1)}ms.`);
  await waitFor('Boolean(document.querySelector(\'[data-agent-stop="true"]\'))', 3000);
  mark("stop-visible");
  const firstThinkingMs = await waitFor(`(() => {
    if (document.querySelector('[data-agent-thinking-block=true]')) return true;
    const assistants = [...document.querySelectorAll('[data-agent-message-role="assistant"]')];
    return !document.querySelector('[data-agent-stop="true"]')
      && assistants.some((node) => (node.textContent || '').trim());
  })()`);
  const firstThinkingVisible = await win.webContents.executeJavaScript(
    'Boolean(document.querySelector("[data-agent-thinking-block=true]"))'
  );
  if (!firstThinkingVisible) {
    const diagnostics = await win.webContents.executeJavaScript(`(() => ({
      events: window.__ynRealVerifierEvents,
      states: window.__ynRealVerifierStates,
      assistants: [...document.querySelectorAll('[data-agent-message-role="assistant"]')].map((node) => ({
        streaming: node.dataset.agentStreaming,
        text: (node.innerText || '').slice(0, 500)
      })),
      transcript: (document.querySelector('.ynAgentTranscript')?.innerText || '').slice(-2000)
    }))()`);
    throw new Error(`The real provider terminated before emitting a thinking block. Diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  mark(`thinking-${firstThinkingMs.toFixed(1)}ms`);
  let tokenSpeedMs: number;
  try {
    tokenSpeedMs = await waitFor('document.querySelector("[data-agent-token-speed=true]")', 30_000);
  } catch (error) {
    const diagnostics = await win.webContents.executeJavaScript(`(() => ({
      events: window.__ynRealVerifierEvents,
      states: window.__ynRealVerifierStates,
      assistants: [...document.querySelectorAll('[data-agent-message-role="assistant"]')].map((node) => ({
        streaming: node.dataset.agentStreaming,
        text: (node.innerText || '').slice(0, 240)
      })),
      transcript: (document.querySelector('.ynAgentTranscript')?.innerText || '').slice(-1200)
    }))()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
  }
  mark(`token-speed-${tokenSpeedMs.toFixed(1)}ms`);
  const thinkingCollapsed = await win.webContents.executeJavaScript(`(() => {
    const block = document.querySelector('[data-agent-thinking-block="true"]');
    return block instanceof HTMLElement
      && block.children.length === 1
      && block.firstElementChild instanceof HTMLButtonElement;
  })()`);
  assert(thinkingCollapsed, "Real-provider thinking is expanded or leaked by default.");
  const pinnedForEvidence = await win.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('.ynAgentTranscript');
    if (!(transcript instanceof HTMLElement)) return false;
    transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
    transcript.scrollTop = 0;
    transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
    return transcript.scrollTop <= 1;
  })()`);
  assert(pinnedForEvidence, "Could not pin the live transcript for screenshot evidence.");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const userScrollProtected = await win.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('.ynAgentTranscript');
    return transcript instanceof HTMLElement && transcript.scrollTop <= 2;
  })()`);
  assert(userScrollProtected, "Live streaming overrode the user's scroll position.");
  await waitFor(`(() => {
    const transcript = document.querySelector('.ynAgentTranscript');
    const user = document.querySelector('[data-agent-message-role="user"]');
    const thinking = document.querySelector('[data-agent-thinking-block="true"]');
    const speed = document.querySelector('[data-agent-token-speed="true"]');
    const stop = document.querySelector('[data-agent-stop="true"]');
    if (!transcript || !user || !thinking || !speed || !stop) return false;
    const viewport = transcript.getBoundingClientRect();
    return [user, thinking, speed].every((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
  })()`, 3_000);
  await capture(streamingScreenshot);
  mark("streaming-screenshot");

  await waitFor('!document.querySelector(\'[data-agent-stop="true"]\')');
  await waitFor('[...document.querySelectorAll(\'[data-agent-message-role="assistant"][data-agent-streaming="false"]\')].some((node) => (node.innerText || "").trim())');
  const completionMs = performance.now() - sendStarted;
  const transcriptText = await win.webContents.executeJavaScript('document.querySelector(".ynAgentTranscript").innerText');
  for (const forbidden of ["turn_start", "message_start", "to=host_tool", "eventRef", "tool_execution_start", "waiting_for_human"]) {
    assert(!String(transcriptText).includes(forbidden), `Raw protocol leaked into real-provider Electron transcript: ${forbidden}`);
  }
  await win.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('.ynAgentTranscript');
    if (!(transcript instanceof HTMLElement)) return false;
    transcript.scrollTop = transcript.scrollHeight;
    transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`);
  await capture(completeScreenshot);
  mark("complete-screenshot");

  const chatBootstrap = await piNativeSessionService.bootstrap(outputDir);
  assert(chatBootstrap.sessions.length === 1, `Expected one new real Pi session, found ${chatBootstrap.sessions.length}.`);
  const chatMessages = await piNativeSessionService.loadMessages(outputDir, chatBootstrap.activeSessionId);
  assert(chatMessages.filter((message) => message.role === "user").length === 1, "New real Pi session contains prior user history.");
  assert(chatMessages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.trim())),
    "Real Pi session persisted no assistant reply.");

  await clickSelector(".ynAgentSidebarHeader button");
  await waitFor('document.querySelectorAll(".ynAgentSessionItem").length === 2', 3_000);
  await waitFor('document.querySelectorAll("[data-agent-message-role]").length === 0', 3_000);
  const translationPrompt = [
    buildTranslatePrompt({
      sourcePath,
      outputDir,
      advanced: {
        languagePair: "ja->zh-CN",
        style: "game",
        split: true,
        splitSize: 2,
        glossaryCandidates: false,
        characterBible: false
      }
    }),
    "真实 Electron 验收附加约束：",
    "必须调用 runTranslationSubagents，并恰好并行启动两个原生 Pi child runtime：L1-L2 与 L3-L4。",
    "子 Agent 必须用受限工具读、写、校验各自范围。两者完成后，主 Agent 必须调用 validateTranslationArtifact，通过后才报告完成。",
    "保留空行、{player_name}、<color=#FF0000>、</color>、%s 与字面控制码 \\n；不要修改源文件。"
  ].join("\n");
  const translationStarted = performance.now();
  const translationOptimisticMs = await sendMessage(translationPrompt, "translation");
  assert(translationOptimisticMs < 300, `Real translation user bubble took ${translationOptimisticMs.toFixed(1)}ms.`);
  await waitFor('Boolean(document.querySelector(\'[data-agent-stop="true"]\'))', 3_000);
  await waitFor(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    return cards.length === 2 && cards.every((card) => card.dataset.agentSubagentStatus === 'running');
  })()`);
  await waitFor('document.querySelector("[data-agent-subagent-waiting=true]")');
  await waitFor(`(() => {
    const childrenRunning = document.querySelector('[data-agent-subagent-waiting=true]');
    const parentSteerMode = document.querySelector('button[aria-label="Steer"]');
    return Boolean(childrenRunning) && !parentSteerMode;
  })()`);
  const parentCheck = "请先用一句话确认主 Agent 仍可交互；随后按原工作流等待子任务完成通知。";
  const parentInteractionStarted = performance.now();
  const parentInteractionOptimisticMs = await sendMessage(parentCheck);
  assert(parentInteractionOptimisticMs < 300,
    `Parent interaction user bubble took ${parentInteractionOptimisticMs.toFixed(1)}ms while children ran.`);
  await waitFor(`(() => {
    const nodes = [...document.querySelectorAll('[data-agent-message-role]')];
    const userIndex = nodes.findIndex((node) => node.dataset.agentMessageRole === 'user'
      && (node.textContent || '').includes(${JSON.stringify(parentCheck)}));
    const replied = userIndex >= 0 && nodes.slice(userIndex + 1).some((node) => (
      node.dataset.agentMessageRole === 'assistant'
      && node.dataset.agentStreaming === 'false'
      && (node.textContent || '').trim()
    ));
    const translationCards = [...document.querySelectorAll('[data-agent-subagent-card=true][data-agent-subagent-kind="subagent.translation"]')];
    return replied
      && translationCards.length === 2
      && translationCards.some((card) => card.dataset.agentSubagentStatus === 'running');
  })()`);
  const parentInteractionMs = performance.now() - parentInteractionStarted;
  assert(
    await win.webContents.executeJavaScript('!document.querySelector("[data-agent-queued-input]")'),
    "Idle parent interaction was incorrectly routed through a queued Steer/Follow-up surface."
  );
  await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    cards.at(-1)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  })()`);
  await capture(subagentsRunningScreenshot);
  mark(`subagents-running-parent-interactive-${parentInteractionMs.toFixed(1)}ms`);

  try {
    await waitFor('[...document.querySelectorAll("[data-agent-subagent-card=true]")].every((card) => card.dataset.agentSubagentStatus === "completed")');
    mark("subagents-closed");
    await waitFor('document.querySelector("[data-agent-tool-call=validateTranslationArtifact]")');
    mark("translation-validated");
    await waitFor('!document.querySelector(\'[data-agent-stop="true"]\')');
    mark("translation-settled");
  } catch (error) {
    const diagnostics = await win.webContents.executeJavaScript(`(() => ({
      cards: [...document.querySelectorAll('[data-agent-subagent-card=true]')].map((card) => ({
        text: (card.innerText || '').slice(0, 1000),
        expanded: card.dataset.agentSubagentExpanded
      })),
      topbar: document.querySelector('.ynAgentTopbarTitle')?.textContent || '',
      stopVisible: Boolean(document.querySelector('[data-agent-stop="true"]')),
      events: (window.__ynRealVerifierEvents || []).slice(-30),
      states: (window.__ynRealVerifierStates || []).slice(-30),
      transcript: (document.querySelector('.ynAgentTranscript')?.innerText || '').slice(-4000)
    }))()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
  }
  const childReplyProofs: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true][data-agent-subagent-kind="subagent.translation"]')][${index}];
      if (card?.dataset.agentSubagentExpanded !== 'true') card?.querySelector(':scope > button')?.click();
      const reply = card?.querySelector('[data-agent-subagent-filter=reply]');
      if (reply?.getAttribute('aria-pressed') !== 'true') reply?.click();
    })()`);
    await waitFor(`(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true][data-agent-subagent-kind="subagent.translation"]')][${index}];
      const transcript = card?.querySelector('[data-agent-subagent-transcript=true]');
      const text = transcript?.textContent || '';
      const result = (card?.querySelector('[data-agent-subagent-result=true]')?.textContent || '').trim();
      return text.includes('readAssignedSource')
        && text.includes('writeAssignedTranslation')
        && text.includes('validateAssignedTranslation')
        && result.length > 0;
    })()`);
    childReplyProofs.push(await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true][data-agent-subagent-kind="subagent.translation"]')][${index}];
      return (card?.querySelector('[data-agent-subagent-transcript=true]')?.textContent || '').trim();
    })()`));
  }
  await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true][data-agent-subagent-kind="subagent.translation"]')];
    if (cards[0]?.dataset.agentSubagentExpanded === 'true') cards[0].querySelector(':scope > button')?.click();
    const card = cards[1];
    const childTranscript = card?.querySelector('[data-agent-subagent-transcript=true]');
    if (childTranscript instanceof HTMLElement) childTranscript.scrollTop = childTranscript.scrollHeight;
    const transcript = document.querySelector('.ynAgentTranscript');
    if (card instanceof HTMLElement && transcript instanceof HTMLElement) {
      transcript.scrollTop += card.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 16;
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await capture(subagentReplyScreenshot);
  mark("subagent-reply-screenshot");

  const translationBootstrap = await piNativeSessionService.bootstrap(outputDir);
  assert(translationBootstrap.sessions.length === 2,
    `Expected separate chat and translation Pi sessions, found ${translationBootstrap.sessions.length}.`);
  const translationMessages = await piNativeSessionService.loadMessages(outputDir, translationBootstrap.activeSessionId);
  const terminalCards = translationMessages.filter((message) => (
    message.role === "custom"
    && message.customType === "subagent.translation"
    && message.details?.status === "completed"
  ));
  assert(terminalCards.length === 2, `Real parent Pi JSONL retained ${terminalCards.length} completed child cards.`);
  assert(terminalCards.every((card) => (
    !Object.prototype.hasOwnProperty.call(card.details, "transcript")
    && String(card.details?.resultSummary || "").trim().length > 0
  )), "A real terminal child card is not a lightweight parent-owned projection.");
  const persistedChildTranscripts = await Promise.all(terminalCards.map((card) => (
    piNativeSessionService.loadSubagentMessages(
      outputDir,
      translationBootstrap.activeSessionId,
      String(card.details?.subagentId || "")
    )
  )));
  assert(persistedChildTranscripts.every((transcript) => (
    transcript.some((message) => message.role === "toolResult")
  )), "A real child Pi JSONL lost its tool-result transcript.");
  const candidatePath = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: path.basename(sourcePath)
  });
  const candidateText = await readFile(candidatePath, "utf8");
  const validation = validateTranslationCandidate(sourceText, candidateText, {
    locale: "zh-CN",
    languagePair: "ja->zh-CN",
    detectUntranslated: true
  });
  assert(validation.ok, `Real Electron translation failed host validation: ${validation.summary}`);
  assert(!validation.warnings.some((finding) => finding.code === "likely_untranslated"),
    `Real Electron translation retained untranslated text: ${validation.summary}`);
  await win.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('.ynAgentTranscript');
    if (transcript instanceof HTMLElement) transcript.scrollTop = transcript.scrollHeight;
  })()`);
  await capture(translationCompleteScreenshot);
  const translationCompletionMs = performance.now() - translationStarted;
  mark(`translation-complete-${translationCompletionMs.toFixed(1)}ms`);

  const candidateLines = candidateText.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  candidateLines[0] = "（本段译文）";
  await writeFile(candidatePath, `${candidateLines.join("\n")}\n`, "utf8");
  await submitComposer("/new");
  await waitFor('document.querySelectorAll(".ynAgentSessionItem").length === 3', 3_000);
  await waitFor('document.querySelectorAll("[data-agent-message-role]").length === 0', 3_000);
  const boundedPrompt = [
    "请调用 1 个 subagent 修复当前文件第 1 行占位译文（本段译文）。",
    "先精确读取第 1 行原文和当前译文；子代理必须通过受管候选写入把它改成真实简体中文译文，并调用 validateAssignedTranslation。",
    "子代理完成后，主 Agent 必须调用 validateTranslationArtifact 检查完整文件，再汇报完成。不要由主 Agent 直接写入来绕过失败的子代理。"
  ].join("\n");
  const boundedStarted = performance.now();
  const boundedOptimisticMs = await sendMessage(boundedPrompt, "translation");
  assert(boundedOptimisticMs < 300, `Bounded repair user bubble took ${boundedOptimisticMs.toFixed(1)}ms.`);
  await waitFor(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    return cards.length === 1 && cards[0].dataset.agentSubagentStatus === 'running';
  })()`);
  mark("bounded-repair-child-running");
  await waitFor(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    return cards.length === 1 && cards[0].dataset.agentSubagentStatus === 'completed';
  })()`);
  await waitFor('document.querySelector("[data-agent-tool-call=validateTranslationArtifact]")');
  await waitFor('!document.querySelector(\'[data-agent-stop="true"]\')');
  const boundedBootstrap = await piNativeSessionService.bootstrap(outputDir);
  assert(boundedBootstrap.sessions.length === 3,
    `Expected separate chat, workflow, and bounded-repair sessions, found ${boundedBootstrap.sessions.length}.`);
  const boundedMessages = await piNativeSessionService.loadMessages(outputDir, boundedBootstrap.activeSessionId);
  const boundedToolNames = boundedMessages.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
      : []
  ));
  assert(boundedToolNames.filter((name) => name === "runSubagents").length === 1,
    `Bounded repair did not launch exactly one prompt-defined child: ${boundedToolNames.join(", ")}`);
  assert(boundedToolNames.includes("validateTranslationArtifact"),
    "The parent stopped after child completion instead of running final validation.");
  assert(!boundedMessages.some((message) => JSON.stringify(message).includes("not in this workflow manifest")),
    "The bounded repair child still hit the stale workflow-manifest rejection.");
  const boundedTerminalCards = boundedMessages.filter((message) => (
    message.role === "custom"
    && message.customType === "subagent.translation"
    && message.details?.status === "completed"
  ));
  assert(boundedTerminalCards.length === 1,
    `Bounded repair retained ${boundedTerminalCards.length} completed child cards instead of one.`);
  const repairedCandidateText = await readFile(candidatePath, "utf8");
  assert(!repairedCandidateText.includes("（本段译文）"), "The real child left the placeholder sentence in the candidate.");
  const repairedValidation = validateTranslationCandidate(sourceText, repairedCandidateText, {
    locale: "zh-CN",
    languagePair: "ja->zh-CN",
    detectUntranslated: true
  });
  assert(repairedValidation.ok, `The real bounded child repair failed final validation: ${repairedValidation.summary}`);
  await win.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('.ynAgentTranscript');
    if (transcript instanceof HTMLElement) transcript.scrollTop = transcript.scrollHeight;
  })()`);
  await capture(boundedRepairScreenshot);
  const boundedCompletionMs = performance.now() - boundedStarted;
  mark(`bounded-repair-complete-${boundedCompletionMs.toFixed(1)}ms`);

  console.log(JSON.stringify({
    ok: true,
    providerId,
    modelId,
    interactiveMs: Number(interactiveMs.toFixed(1)),
    optimisticMs: Number(optimisticMs.toFixed(1)),
    firstThinkingMs: Number(firstThinkingMs.toFixed(1)),
    tokenSpeedMs: Number(tokenSpeedMs.toFixed(1)),
    completionMs: Number(completionMs.toFixed(1)),
    sessionId: chatBootstrap.activeSessionId,
    translationSessionId: translationBootstrap.activeSessionId,
    translationOptimisticMs: Number(translationOptimisticMs.toFixed(1)),
    parentInteractionMs: Number(parentInteractionMs.toFixed(1)),
    translationCompletionMs: Number(translationCompletionMs.toFixed(1)),
    boundedRepairOptimisticMs: Number(boundedOptimisticMs.toFixed(1)),
    boundedRepairCompletionMs: Number(boundedCompletionMs.toFixed(1)),
    childReplyCardsVerified: childReplyProofs.length,
    translationCandidatePath: candidatePath,
    screenshots: [
      streamingScreenshot,
      completeScreenshot,
      subagentsRunningScreenshot,
      subagentReplyScreenshot,
      translationCompleteScreenshot,
      boundedRepairScreenshot
    ],
    userScrollProtected: true,
    rawProtocolLeak: false,
    oldHistoryLeak: false,
    parentAnsweredWhileChildrenRan: true,
    translationValidated: true,
    boundedRepairChildValidated: true,
    outputDir: keepTemp ? outputDir : undefined
  }));
}

void app.whenReady().then(run).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy();
  await piNativeSessionService.disposeWorkspace(outputDir).catch(() => {});
  if (!keepTemp) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
