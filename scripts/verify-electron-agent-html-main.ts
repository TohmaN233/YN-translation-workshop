import { app, BrowserWindow, clipboard, ipcMain, nativeImage } from "electron";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { PiNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../src/main/agent/piNative/sessionRepository.ts";
import { listPiConfiguredModels } from "../src/main/agent/piNative/providerRegistry.ts";
import { openAgentChatWindow } from "../src/main/agent/piNative/agentChatWindowHost.ts";
import { createYnDomainRunContract } from "../src/main/agent/piNative/domainRunContract.ts";
import { YnSubagentSupervisor } from "../src/main/agent/piNative/subagentSupervisor.ts";
import { createYnDomainTools } from "../src/main/agent/piNative/ynDomainTools.ts";
import { ynInterfaceContextStore } from "../src/main/agent/piNative/interfaceContextStore.ts";
import { updateProviderConfig } from "../src/main/agent/providerConfigStore.ts";
import { writeProofreadFindings } from "../src/main/agent/writeProofreadFindings.ts";
import { writeClipboardTextVerified } from "../src/main/clipboardText.ts";
import { patchProjectState } from "../src/main/projectState.ts";
import { registerAgentProviderIpc } from "../src/main/ipc/agentProviderHandlers.ts";
import { registerAgentAssetIpc } from "../src/main/ipc/agentAssetHandlers.ts";
import { registerAgentSessionIpc } from "../src/main/ipc/agentSessionHandlers.ts";
import { getProviderPreset } from "../src/shared/agent/providerPresets.ts";
import {
  PROMPT_SETTINGS_VERSION,
  renderBatchLineReviewIndexHtml,
  renderLineReviewHtml
} from "../src/shared/core/html.ts";
import { buildPrompt, buildTranslatePrompt } from "../src/shared/core/prompts.ts";

const root = process.cwd();
const workspace = await mkdtemp(path.join(os.tmpdir(), "yn-electron-pi-native-"));
const externalReferenceDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-external-reference-"));
const externalReferencePath = path.join(externalReferenceDir, "outside-project-lore.md");
let verifierProjectState: Record<string, unknown> = {};
const sourcePath = path.join(workspace, "source.txt");
const translationPath = path.join(workspace, "approved-translation.txt");
const htmlPath = path.join(workspace, "review.html");
const secondHtmlPath = path.join(workspace, "review-2.html");
const epubHtmlPath = path.join(workspace, "epub-review.html");
const epubOriginalSourcePath = path.join(workspace, "book.epub");
const epubExtractedSourcePath = path.join(workspace, ".translation-workshop", "extracted-text", "epub", "source", "book.txt");
const epubEditableTranslationPath = path.join(workspace, ".translation-workshop", "extracted-text", "epub", "translation", "book.txt");
const folderHtmlPath = path.join(workspace, "folder-review.html");
const folderSourceRoot = path.join(workspace, "folder-source");
const folderFirstHtmlPath = path.join(workspace, "folder-a.html");
const folderSecondHtmlPath = path.join(workspace, "folder-b.html");
const artifactsDir = path.join(root, "artifacts");
const folderAgentScreenshot = path.join(artifactsDir, "electron-agent-native-folder-iframe.png");
const commandsScreenshot = path.join(artifactsDir, "electron-agent-native-commands.png");
const promptSettingsScreenshot = path.join(artifactsDir, "electron-agent-native-prompt-settings.png");
const progressScreenshot = path.join(artifactsDir, "electron-agent-native-progress.png");
const providerRetryScreenshot = path.join(artifactsDir, "electron-agent-native-provider-retry.png");
const streamScreenshot = path.join(artifactsDir, "electron-agent-native-streaming.png");
const interfaceImageScreenshot = path.join(artifactsDir, "electron-agent-native-interface-image.png");
const subagentInteractionScreenshot = path.join(artifactsDir, "electron-agent-native-subagents-live-interaction.png");
const subagentRepliesScreenshot = path.join(artifactsDir, "electron-agent-native-subagent-replies.png");
const folderBatchRunScreenshot = path.join(artifactsDir, "electron-agent-native-folder-batch-run.png");
const translationReuseDecisionScreenshot = path.join(artifactsDir, "electron-agent-native-translation-reuse-decision.png");
const completeScreenshot = path.join(artifactsDir, "electron-agent-native-complete.png");
const providerSettingsScreenshot = path.join(artifactsDir, "electron-agent-native-provider-settings.png");
const popoutScreenshot = path.join(artifactsDir, "electron-agent-native-popout.png");
const compactionScreenshot = path.join(artifactsDir, "electron-agent-native-compaction.png");

app.disableHardwareAcceleration();
app.setPath("userData", path.join(workspace, "electron-user-data"));
app.setPath("cache", path.join(workspace, "electron-cache"));

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function mark(stage: string): void {
  console.log(`[electron-pi-native] ${stage}`);
}

function revealVerificationWindow(win: BrowserWindow): void {
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS === "1") {
    const bounds = win.getBounds();
    win.setSkipTaskbar(true);
    win.setBounds({ x: -32000, y: -32000, width: bounds.width, height: bounds.height });
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

async function rendererAssetUrl(prefix: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const assetsDir = path.join(root, "dist", "renderer", "assets");
  const files = await readdir(assetsDir);
  const match = files.find((file) => file.startsWith(prefix) && file.endsWith(".js"));
  if (!match) throw new Error(`Missing renderer asset ${prefix}`);
  return pathToFileURL(path.join(assetsDir, match)).toString();
}

async function rendererCssAssetUrl(): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const assetsDir = path.join(root, "dist", "renderer", "assets");
  const files = await readdir(assetsDir);
  const match = files.find((file) => file.startsWith("styles-") && file.endsWith(".css"));
  return match ? pathToFileURL(path.join(assetsDir, match)).toString() : undefined;
}

async function waitFor(win: BrowserWindow, expression: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await win.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false);
    if (matched) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function waitForProjectState(
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs = 3_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = verifierProjectState;
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for the expected project state.");
}

async function clickByText(win: BrowserWindow, selector: string, text: string): Promise<void> {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => (item.textContent || "").trim().includes(${JSON.stringify(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`);
  assert(clicked, `Could not click ${selector} containing ${text}`);
}

async function clickSelector(win: BrowserWindow, selector: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
  throw new Error(`Could not click ${selector} within ${timeoutMs}ms`);
}

async function capturePaintedWindow(win: BrowserWindow, targetPath: string): Promise<void> {
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

async function waitForPaint(win: BrowserWindow): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function sendMessage(
  win: BrowserWindow,
  text: string,
  workflowIntent?: "translation" | "proofread"
): Promise<number> {
  revealVerificationWindow(win);
  win.webContents.focus();
  const prepared = await win.webContents.executeJavaScript(`(() => {
    const input = ${workflowIntent ? "window.__ynAgentChatPiWebEmbedded" : "window.YnPiWebAgentEmbedded"};
    if (!input?.insertText) return false;
    input.insertText(${JSON.stringify(text)}, ${workflowIntent ? JSON.stringify({
      workflowIntent,
      languagePair: "ja->zh-CN",
      style: "historical drama",
      workDescription: "typed project context"
    }) : "undefined"});
    return true;
  })()`);
  assert(prepared, "Pi-web ChatInput bridge is missing");
  await waitFor(
    win,
    `document.querySelector('#agentChatReactRoot textarea')?.value.includes(${JSON.stringify(text)})`,
    1000
  );
  const userCountBefore = await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-agent-message-role="user"]').length`
  ) as number;
  const renderedLines = text
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*(?:[-*+] |\d+\.\s+)/, "")
      .replace(/[*_`~]/g, "")
      .trim())
    .filter(Boolean);
  const renderedNeedles = [...new Set([
    renderedLines[0],
    renderedLines[renderedLines.length - 1]
  ].filter((value): value is string => Boolean(value)))];
  const renderedMessageCheck = `[...document.querySelectorAll('[data-agent-message-role="user"]')]
    .slice(${userCountBefore})
    .some((node) => {
      const value = node.textContent || '';
      return ${JSON.stringify(renderedNeedles)}.every((needle) => value.includes(needle));
    })`;
  const started = performance.now();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  const deadline = started + 1000;
  while (performance.now() < deadline) {
    const found = await win.webContents.executeJavaScript(renderedMessageCheck).catch(() => false);
    if (found) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // After a long native run, Chromium can keep the textarea focused while the
  // synthetic key event misses React's handler during the focus handoff. The
  // visible Pi-web send control is the same ChatInput submit path and gives
  // this verifier a deterministic fallback without injecting a fake message.
  const fallbackClicked = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#agentChatReactRoot button[aria-label="Send"]');
    if (!(button instanceof HTMLElement) || button.disabled) return false;
    button.click();
    return true;
  })()`).catch(() => false);
  if (fallbackClicked) {
    const fallbackDeadline = performance.now() + 1000;
    while (performance.now() < fallbackDeadline) {
      const found = await win.webContents.executeJavaScript(renderedMessageCheck).catch(() => false);
      if (found) return performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const diagnostics = await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('#agentChatReactRoot textarea');
    const buttons = [...document.querySelectorAll('#agentChatReactRoot button')];
    return {
      textareaValue: textarea?.value,
      activeTag: document.activeElement?.tagName,
      activeClass: document.activeElement?.className,
      stopVisible: buttons.some((button) => (button.textContent || '').includes('Stop')),
      sendDisabled: buttons.find((button) => (button.textContent || '').includes('Send'))?.disabled,
      queuedInput: document.querySelector('[data-agent-queued-input]')?.textContent,
      notice: document.querySelector('[data-agent-command-notice]')?.textContent,
      users: [...document.querySelectorAll('[data-agent-message-role="user"]')]
        .map((node) => node.textContent || '')
    };
  })()`);
  throw new Error(
    `Optimistic user message ${JSON.stringify(text)} did not render within 1 second: ${JSON.stringify(diagnostics)}`
  );
}

async function setComposerValue(win: BrowserWindow, text: string): Promise<void> {
  const prepared = await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#agentChatReactRoot textarea");
    if (!textarea) return false;
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(text)}
    }));
    return true;
  })()`);
  assert(prepared, "Agent textarea is missing");
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function submitNestedComposer(win: BrowserWindow, expectedText: string): Promise<void> {
  const prepared = await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea");
    return Boolean(textarea?.value.includes(${JSON.stringify(expectedText)}));
  })()`);
  assert(prepared, "Nested Pi-web ChatInput did not retain the generated workflow prompt");
  const sent = await win.webContents.executeJavaScript(`(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    const button = child?.document?.querySelector('#agentChatReactRoot button[aria-label="Send"]');
    if (!button || typeof button.click !== "function") return false;
    button.click();
    return true;
  })()`);
  assert(sent, "Nested Pi-web Send button is missing");
  await waitFor(win, `document.querySelector("#fileFrame")?.contentDocument?.querySelectorAll('[data-agent-message-role="user"]').length > 0`, 2_000);
}

async function submitComposer(win: BrowserWindow, text: string): Promise<void> {
  revealVerificationWindow(win);
  win.webContents.focus();
  await setComposerValue(win, text);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
}

async function openPopoutAndMeasure(hostWindow: BrowserWindow): Promise<number> {
  const started = performance.now();
  await clickSelector(hostWindow, "#agentChatPopout");
  const deadline = Date.now() + 3000;
  while ((!popoutWin || popoutWin.isDestroyed()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(popoutWin && !popoutWin.isDestroyed(), "Open-as-page control did not create the product popout window");
  try {
    await waitFor(popoutWin, 'document.querySelector("textarea") && document.querySelector(".ynAgentTranscript")', 3000);
  } catch (popoutError) {
    const diagnostics = await popoutWin.webContents.executeJavaScript(`(() => ({
      href: location.href,
      readyState: document.readyState,
      bodyClass: document.body?.className,
      bodyText: (document.body?.innerText || '').slice(0, 500),
      rootPresent: Boolean(document.querySelector('#agentChatReactRoot')),
      rootText: (document.querySelector('#agentChatReactRoot')?.textContent || '').slice(0, 500),
      composerPresent: Boolean(document.querySelector('textarea')),
      transcriptPresent: Boolean(document.querySelector('.ynAgentTranscript')),
      embeddedApiPresent: Boolean(window.YnPiWebAgentEmbedded),
      embeddedMountPresent: typeof window.YnPiWebAgentEmbedded?.mount === 'function',
      hostApiPresent: Boolean(window.__ynAgentChatPiWebEmbedded),
      scriptSources: [...document.scripts].map((script) => script.src).filter(Boolean),
      styleLinks: [...document.querySelectorAll('link[rel=stylesheet]')].map((link) => link.href)
    }))()`).catch((error) => ({ executeJavaScriptError: String(error) }));
    throw new Error(
      `${popoutError instanceof Error ? popoutError.message : String(popoutError)}; `
      + `lifecycle=${JSON.stringify(popoutLifecycle)}; diagnostics=${JSON.stringify(diagnostics)}`
    );
  }
  const interactiveMs = performance.now() - started;
  assert(interactiveMs < 3000, `Agent popout took ${interactiveMs.toFixed(1)}ms to become interactive`);
  mark(`popout-interactive-${interactiveMs.toFixed(1)}ms`);
  return interactiveMs;
}

const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 2 } });
const models = createModels();
models.setProvider(faux.provider);
const childProviders = new Map<string, ReturnType<typeof fauxProvider>>();
const translationBlocks = (lines: readonly string[]) => {
  const nonEmpty = lines.filter((text) => text.trim());
  const blocks = [];
  for (let index = 0; index < nonEmpty.length; index += 16) {
    blocks.push({
      id: Math.floor(index / 16).toString(36),
      lines: nonEmpty.slice(index, index + 16)
        .map((text, lineIndex) => `${lineIndex.toString(36)}${text}`)
    });
  }
  return blocks;
};
const messageText = (message: { content?: unknown }): string => {
  if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
};
const latestToolPayload = (
  context: Parameters<Parameters<typeof faux.setResponses>[0][number]>[0],
  toolName: string
): Record<string, unknown> => {
  const result = [...context.messages].reverse().find((message) => (
    message.role === "toolResult" && message.toolName === toolName
  ));
  if (result?.details && typeof result.details === "object") {
    return result.details as Record<string, unknown>;
  }
  const content = Array.isArray(result?.content) ? result.content[0]?.text : result?.content;
  assert(typeof content === "string", `Verifier could not read ${toolName} result content`);
  return JSON.parse(content) as Record<string, unknown>;
};
let releaseBackgroundChildren!: () => void;
const backgroundChildrenRelease = new Promise<void>((resolve) => {
  releaseBackgroundChildren = resolve;
});
for (const [providerId, lines] of [
  ["verify-child-a", ["你好 {name}", ""]],
  ["verify-child-b", ["再见", "结束"]]
] as const) {
  const child = fauxProvider({ provider: providerId, tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
  child.setResponses([
    async () => {
      await backgroundChildrenRelease;
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id: `${providerId}_read` }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
      blocks: translationBlocks(lines)
    }, { id: `${providerId}_write` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id: `${providerId}_validate` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText(`${providerId} validated`))
  ]);
  childProviders.set(providerId, child);
  models.setProvider(child.provider);
}
const reviewProviderId = "verify-translation-review";
const reviewProvider = fauxProvider({ provider: reviewProviderId, tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
let reviewResponseId = 0;
reviewProvider.setResponses(Array.from({ length: 40 }, () => async (context) => {
  const serialized = JSON.stringify(context.messages);
  const id = `${reviewProviderId}_${reviewResponseId++}`;
  if (serialized.includes('\"name\":\"submitTranslationReview\"')) {
    return fauxAssistantMessage(fauxText(`${reviewProviderId} accepted the assignment.`));
  }
  if (serialized.includes('\"name\":\"readAssignedTranslationReview\"')) {
    return fauxAssistantMessage(fauxToolCall("submitTranslationReview", { failures: [] }, { id }), { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id }), { stopReason: "toolUse" });
}));
childProviders.set(reviewProviderId, reviewProvider);
models.setProvider(reviewProvider.provider);
const folderChildProviderId = "verify-folder-worker";
const folderChild = fauxProvider({ provider: folderChildProviderId, tokensPerSecond: 1000, tokenSize: { min: 10, max: 20 } });
let folderChildResponseId = 0;
folderChild.setResponses(Array.from({ length: 40 }, () => async (context) => {
  const serialized = JSON.stringify(context.messages);
  const id = `${folderChildProviderId}_${folderChildResponseId++}`;
  if (serialized.includes('"name":"submitTranslationAudit"')) {
    return fauxAssistantMessage(fauxText(`${folderChildProviderId} reuse audit submitted`));
  }
  if (serialized.includes('"name":"readAssignedTranslationAudit"')) {
    const result = [...context.messages].reverse().find((message) => (
      message.role === "toolResult" && message.toolName === "readAssignedTranslationAudit"
    ));
    const lines = (result?.details as { lines?: Array<{ line: number; semanticSignals?: string[] }> } | undefined)?.lines ?? [];
    return fauxAssistantMessage(fauxToolCall("submitTranslationAudit", {
      entries: lines.map((line) => ({
        line: line.line,
        verdict: (line.semanticSignals?.length ?? 0) > 0 ? "retranslate" : "reuse",
        reason: (line.semanticSignals?.length ?? 0) > 0
          ? "The aligned text is not reliable enough to reuse; translate this line again."
          : "Complete, faithful, and contextually usable translation."
      }))
    }, { id }), { stopReason: "toolUse" });
  }
  if (serialized.includes("Semantically audit the current translation candidate")) {
    return fauxAssistantMessage(fauxToolCall("readAssignedTranslationAudit", {}, { id }), { stopReason: "toolUse" });
  }
  if (serialized.includes('"name":"submitTranslationReview"')) {
    return fauxAssistantMessage(fauxText(`${folderChildProviderId} translation review accepted`));
  }
  if (serialized.includes('"name":"readAssignedTranslationReview"')) {
    return fauxAssistantMessage(fauxToolCall("submitTranslationReview", {
      failures: []
    }, { id }), { stopReason: "toolUse" });
  }
  if (serialized.includes("FIRST TOOL: call readAssignedTranslationReview once")) {
    return fauxAssistantMessage(fauxToolCall("readAssignedTranslationReview", {}, { id }), { stopReason: "toolUse" });
  }
  if (serialized.includes('"name":"validateAssignedTranslation"')) {
    return fauxAssistantMessage(fauxText(`${folderChildProviderId} validated`));
  }
  if (serialized.includes('"name":"writeAssignedTranslation"')) {
    return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}, { id }), { stopReason: "toolUse" });
  }
  if (serialized.includes('"name":"readAssignedSource"')) {
    const result = [...context.messages].reverse().find((message) => (
      message.role === "toolResult" && message.toolName === "readAssignedSource"
    ));
    const assignedLines = (result?.details as { lines?: Array<{ text?: string }> } | undefined)?.lines ?? [];
    const translatedLines = assignedLines.length > 0
      ? assignedLines.map((line) => line.text?.includes("甲") ? "翻译甲" : line.text?.includes("乙") ? "翻译乙" : "翻译")
      : ["翻译甲", "翻译乙"];
    return fauxAssistantMessage(fauxToolCall("writeAssignedTranslation", {
      blocks: translationBlocks(translatedLines)
    }, { id }), { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(fauxToolCall("readAssignedSource", {}, { id }), { stopReason: "toolUse" });
}));
childProviders.set(folderChildProviderId, folderChild);
models.setProvider(folderChild.provider);
const longThinking = "我正在确认会话上下文、用户语言和回复目标。".repeat(32);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("readYnInterfaceContext", {}, { id: "tool_interface_context" }), { stopReason: "toolUse" }),
  async (context) => {
    const snapshot = latestToolPayload(context, "readYnInterfaceContext") as {
      available?: boolean;
      context?: { activeLine?: number; focusedLine?: { line?: number; source?: string } };
    };
    assert(snapshot.available, "Pi Agent could not read the live YN interface context");
    assert(snapshot.context?.focusedLine?.line === 1, `Pi Agent read the wrong focused line: ${JSON.stringify(snapshot)}`);
    assert(snapshot.context.focusedLine.source?.includes("こんにちは"), `Pi Agent lost focused source text: ${JSON.stringify(snapshot)}`);
    return fauxAssistantMessage(fauxText("已读取当前 YN 页面第 1 行及相邻上下文。"));
  },
  fauxAssistantMessage(fauxToolCall("readProjectFile", {
    path: externalReferencePath
  }, { id: "tool_external_reference" }), { stopReason: "toolUse" }),
  async (context) => {
    const external = latestToolPayload(context, "readProjectFile") as {
      outsideProject?: boolean;
      path?: string;
      content?: string;
    };
    assert(external.outsideProject === true, `External reference was not marked outside-project: ${JSON.stringify(external)}`);
    assert(path.resolve(external.path || "") === externalReferencePath, `External reference resolved to the wrong path: ${JSON.stringify(external)}`);
    assert(external.content?.includes("Aurora Bridge"), `External reference content was not returned: ${JSON.stringify(external)}`);
    return fauxAssistantMessage(fauxText("已直接读取项目外部参考资料。"));
  },
  fauxAssistantMessage(fauxText("图片已通过原生 Pi 多模态消息收到。")),
  fauxAssistantMessage([fauxThinking(longThinking), fauxText("你好，我在。Pi 会话已经正常完成。")]),
  fauxAssistantMessage(fauxToolCall("echo", { value: "paired-result" }, { id: "tool_pair_1" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("工具调用与结果已经**配对**。")),
  fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "tool_translation_inspect" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("过早声称翻译完成。")),
  fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {
    tasks: [
      { fromLine: 1, toLine: 2, providerId: "verify-child-a", label: "Subagent 1" },
      { fromLine: 3, toLine: 4, providerId: "verify-child-b", label: "Subagent 2" }
    ]
  }, { id: "tool_subagents_1" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("两个 subagent 已在后台运行，主 Agent 仍可立即交互。")),
  fauxAssistantMessage(fauxText("主 Agent 已在 subagent 运行期间即时回复。")),
  fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, { id: "tool_translation_validate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("两个 subagent 已完成，主 Agent 已汇总。")),
  async () => { throw new Error("insufficient_quota: deterministic provider failure"); },
  fauxAssistantMessage(fauxText("当前新会话保留。")),
  fauxAssistantMessage([fauxThinking("确认两个窗口绑定同一会话。"), fauxText("共享窗口已经实时同步。")]),
  fauxAssistantMessage(fauxText("关闭弹窗后 dock 仍继续工作。")),
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    return fauxAssistantMessage(fauxText("Native Pi memory summary retained the current task, decisions, and validated artifacts."));
  },
  fauxAssistantMessage(fauxText("Recent turn prefix retained the active request and its current execution state."))
]);

const service = new PiNativeSessionService({
  createModelSelection: async ({ providerId, modelId }) => {
    const provider = !providerId || providerId === faux.provider.id || providerId === "openai-chatgpt"
      ? faux
      : childProviders.get(providerId);
    assert(provider, `Unexpected verifier provider ${String(providerId)}`);
    return {
      models,
      model: provider === faux
        ? { ...provider.getModel(), input: ["text", "image"] }
        : provider.getModel(),
      // Production selection preserves the configured provider/model identity even
      // when its Pi provider implementation differs. Keep the faux adapter faithful
      // so persistent workers do not mistake the next assignment for a model switch.
      providerId: providerId?.trim() || provider.provider.id,
      modelId: modelId?.trim() || provider.getModel().id
    };
  },
  buildSystemPrompt: () => "Use the supplied native Pi tools and answer concisely.",
  enforceDomainCompletion: true,
  createTools: (toolContext) => {
    const { request } = toolContext;
    const expectedTranslationPath = expectEpubHostBinding
      ? epubEditableTranslationPath
      : request.sourceSelection?.kind === "folder"
        ? path.join(workspace, "AI_translation")
        : translationPath;
    assert(
      request.translationPath === expectedTranslationPath,
      `Product agent-session IPC dropped translationPath: ${String(request.translationPath)}`
    );
    if (expectEpubHostBinding) {
      assert(request.sourcePath === epubExtractedSourcePath,
        `EPUB Host request used the wrong source: ${String(request.sourcePath)}`);
      assert(request.sourceSelection?.kind === "file" && request.sourceSelection.path === epubExtractedSourcePath,
        `EPUB Host request lost its extracted source selection: ${JSON.stringify(request.sourceSelection)}`);
      epubHostBindingObserved = true;
    }
    if (request.workflowIntent !== undefined) {
      assert(request.workflowIntent === "translation", `Unexpected workflow intent: ${request.workflowIntent}`);
      typedWorkflowIntentObserved = true;
      assert(request.languagePair === "ja->zh-CN", `Unexpected workflow language pair: ${request.languagePair}`);
      typedLanguagePairObserved = true;
      if (request.style === "historical drama") typedStyleObserved = true;
      if (request.workDescription === "typed project context") typedWorkDescriptionObserved = true;
      if (expectTypedFolderAssetMetadata && request.sourceSelection?.kind === "folder") {
        assert(
          request.glossaryPath === path.join(workspace, ".translation-workshop", "glossary.json"),
          `Folder workflow lost its typed glossary path: ${String(request.glossaryPath)}`
        );
        assert(request.glossaryCandidates === false, "Folder workflow lost its typed glossary-candidate setting");
        assert(request.characterBible === false, "Folder workflow lost its typed character-bible setting");
        assert(
          JSON.stringify(request.auditWhitelistLines) === "[1]",
          `Folder workflow lost its typed audit whitelist: ${JSON.stringify(request.auditWhitelistLines)}`
        );
        typedFolderAssetMetadataObserved = true;
        expectTypedFolderAssetMetadata = false;
      }
    }
    toolContext.readInterfaceContext = () => ynInterfaceContextStore.read(request.outputDir);
    return [
    {
      name: "echo",
      label: "echo",
      description: "Return a value for paired tool-result verification.",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
      }
    },
    ...createYnDomainTools(toolContext)
    ];
  }
});

let win: BrowserWindow | undefined;
let folderWin: BrowserWindow | undefined;
let popoutWin: BrowserWindow | undefined;
let popoutLifecycle: string[] = [];
let popoutInteractiveMs = 0;
let typedWorkflowIntentObserved = false;
let typedLanguagePairObserved = false;
let typedStyleObserved = false;
let typedWorkDescriptionObserved = false;
let typedFolderAssetMetadataObserved = false;
let expectTypedFolderAssetMetadata = false;
let expectEpubHostBinding = false;
let epubHostBindingObserved = false;
let clipboardWriteRequested = "";
let requestedHtmlTabPath = "";

async function run(): Promise<void> {
  mark("app-ready");
  registerAgentSessionIpc({
    service,
    resolveInterfaceWorkspace(sender) {
      return sender.id === win?.webContents.id || sender.id === folderWin?.webContents.id
        ? workspace
        : undefined;
    },
    broadcast(channel, payload) {
      const deliver = () => {
        for (const target of BrowserWindow.getAllWindows()) {
          if (!target.webContents.isDestroyed()) target.webContents.send(channel, payload);
        }
      };
      const event = payload && typeof payload === "object"
        ? (payload as { event?: { type?: string } }).event
        : undefined;
      if (channel === "agent-session:event" && event?.type === "settled") {
        setTimeout(deliver, 150);
      } else {
        deliver();
      }
    }
  });
  registerAgentProviderIpc();
  registerAgentAssetIpc();
  ipcMain.handle("prompts:build", async (_event, args: unknown) => {
    return buildPrompt(args as Parameters<typeof buildPrompt>[0]);
  });
  ipcMain.handle("ui:agentChatEmbeddedEntryUrl", async () => ({
    ok: true,
    url: await rendererAssetUrl("agent-embedded-"),
    cssUrl: await rendererCssAssetUrl()
  }));
  ipcMain.handle("ui:openAgentChatWindow", async (_event, args) => {
    const result = await openAgentChatWindow({
      args,
      preloadPath: path.join(root, "dist", "main", "preload.cjs"),
      loadRendererRoute: async (window, route) => {
        await window.loadFile(path.join(root, "dist", "renderer", "index.html"), { hash: route });
      },
      onWindowCreated(window) {
        popoutWin = window;
        const createdAt = Date.now();
        const record = (event: string) => popoutLifecycle.push(`${Date.now() - createdAt}ms:${event}`);
        popoutLifecycle = [];
        record("created");
        window.webContents.on("did-start-loading", () => record("did-start-loading"));
        window.webContents.on("dom-ready", () => record("dom-ready"));
        window.webContents.on("did-finish-load", () => record("did-finish-load"));
        window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
          record(`did-fail-load:${code}:${description}:${url}:${isMainFrame}`);
        });
        window.on("unresponsive", () => record("unresponsive"));
      }
    });
    return { ok: true, surface: result.surface };
  });
  ipcMain.handle("html:persistState", async () => ({ ok: true }));
  ipcMain.handle("project:readState", async () => verifierProjectState);
  ipcMain.handle("project:patch", async (_event, args?: { outputDir?: unknown; patch?: unknown }) => {
    const outputDir = typeof args?.outputDir === "string" ? args.outputDir.trim() : "";
    const patch = args?.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
      ? args.patch as Record<string, unknown>
      : undefined;
    if (!outputDir || !patch) throw new Error("Project state patch requires outputDir and patch.");
    verifierProjectState = { ...verifierProjectState, ...patch };
    return verifierProjectState;
  });
  ipcMain.handle("files:writeAuditWhitelistFile", async (_event, args: {
    outputDir?: string;
    sourcePath?: string;
    lines?: number[];
  }) => {
    assert(args.outputDir === workspace, `Audit whitelist used the wrong workspace: ${String(args.outputDir)}`);
    const lines = [...new Set((args.lines ?? []).filter((line) => Number.isInteger(line) && line > 0))]
      .sort((left, right) => left - right);
    const targetPath = path.join(workspace, ".translation-workshop", "audit-whitelist.json");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify({ version: 1, sourcePath: args.sourcePath ?? "", lines }), "utf8");
    return { ok: true, path: targetPath, lineCount: lines.length };
  });
  ipcMain.handle("clipboard:writeText", async (_event, text: string) => {
    clipboardWriteRequested = text;
    return writeClipboardTextVerified(clipboard, text);
  });
  ipcMain.handle("shell:openPath", async (_event, targetPath: string) => {
    requestedHtmlTabPath = targetPath;
    return "";
  });

  await mkdir(artifactsDir, { recursive: true });
  const providerPreset = getProviderPreset("openai-chatgpt");
  assert(providerPreset, "OpenAI ChatGPT provider preset is missing");
  await updateProviderConfig(path.join(workspace, ".translation-workshop"), {
    activeProviderId: providerPreset.id,
    provider: {
      ...providerPreset.config,
      auth: { kind: "oauth", accessToken: "deterministic-verifier" }
    }
  });
  await writeFile(sourcePath, "こんにちは {name}\n\nさようなら\n終わり", "utf8");
  await writeFile(translationPath, "你好 {name}\n\n再见\n结束", "utf8");
  await writeFile(externalReferencePath, "External lore: Aurora Bridge\n", "utf8");
  const localProofreadSourcePath = path.join(workspace, "local-proofread-source.txt");
  const localProofreadTranslationPath = path.join(
    workspace,
    "AI_translation",
    "local-proofread-source_translated.txt"
  );
  await mkdir(path.dirname(localProofreadTranslationPath), { recursive: true });
  await writeFile(localProofreadSourcePath, "one\ntwo\nthree\n", "utf8");
  await writeFile(localProofreadTranslationPath, "一\n旧译文\n三\n", "utf8");
  const seededLocalProofread = await writeProofreadFindings({
    outputDir: workspace,
    sourcePaths: [localProofreadSourcePath],
    documentId: "local-proofread-source.txt",
    translationPath: localProofreadTranslationPath,
    kind: "findings_json",
    content: JSON.stringify([{
      id: "H1-504",
      severity: "H1",
      type: "accuracy",
      sourceLine: 2,
      translationLine: 2,
      sourceText: "two",
      currentTranslation: "旧译文",
      suggestedFix: "修订后的译文",
      rationale: "The old translation was inaccurate."
    }])
  });
  assert(seededLocalProofread.ok && seededLocalProofread.path, seededLocalProofread.error || "Failed to seed local proofread report");
  await writeFile(localProofreadTranslationPath, "一\n修订后的译文\n三\n", "utf8");
  const localProofreadTools = createYnDomainTools({
    request: {
      outputDir: workspace,
      sourcePath: localProofreadSourcePath,
      sessionId: "electron-local-reproofread",
      prompt: "Re-proofread only line 2 after the accepted edit.",
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
      languagePair: "en->zh-CN",
      workflowIntent: "proofread"
    },
    publishCustomMessage: async () => {},
    subagents: new YnSubagentSupervisor({ publishCustomMessage: async () => {} })
  });
  const inspectProofreadRange = localProofreadTools.find((tool) => tool.name === "inspectProofreadRange");
  const writeScopedProofreadFindings = localProofreadTools.find((tool) => tool.name === "writeProofreadFindings");
  assert(inspectProofreadRange && writeScopedProofreadFindings, "Bounded re-proofread Host tools are missing");
  const localScopeResult = await inspectProofreadRange.execute(
    "electron-local-reproofread-inspect",
    { fromLine: 2, toLine: 2 }
  );
  const localScopeId = (localScopeResult.details as { scopeId?: string }).scopeId;
  assert(localScopeId, "Bounded re-proofread inspection did not return a scopeId");
  const localReplacement = await writeScopedProofreadFindings.execute(
    "electron-local-reproofread-write",
    { scopeId: localScopeId, findings: [] }
  );
  assert(
    (localReplacement.details as { replacedFindingCount?: number }).replacedFindingCount === 1,
    `Bounded re-proofread did not replace the stale finding: ${JSON.stringify(localReplacement.details)}`
  );
  const localProofreadReport = JSON.parse(await readFile(seededLocalProofread.path, "utf8")) as { findings?: unknown[] };
  assert(localProofreadReport.findings?.length === 0, "Bounded re-proofread left the stale H1-504 finding in the report");
  mark("bounded-reproofread-replaced-stale-finding");
  const generatedGlossaryPath = path.join(workspace, "AI_translation", "_workspace", "glossary_candidates.json");
  await mkdir(path.dirname(generatedGlossaryPath), { recursive: true });
  await writeFile(generatedGlossaryPath, JSON.stringify({
    entries: [{ source: "固有名詞", target: "专有名词" }]
  }), "utf8");
  await mkdir(folderSourceRoot, { recursive: true });
  const folderFirstSourcePath = path.join(folderSourceRoot, "a.txt");
  const folderSecondSourcePath = path.join(folderSourceRoot, "b.txt");
  await writeFile(folderFirstSourcePath, "原文甲\n原文乙", "utf8");
  await writeFile(folderSecondSourcePath, "原文甲\n原文乙", "utf8");
  const folderDomainRun = createYnDomainRunContract({ workflowIntent: "translation", folderSource: true });
  const folderDomainTools = createYnDomainTools({
    request: {
      outputDir: workspace,
      sourcePath: folderSourceRoot,
      sourceSelection: { kind: "folder", path: folderSourceRoot },
      sessionId: "electron-folder-manifest",
      prompt: "translate folder",
      providerId: faux.provider.id,
      modelId: faux.getModel().id,
      languagePair: "ja->zh-CN"
    },
    publishCustomMessage: async () => {},
    subagents: new YnSubagentSupervisor({ publishCustomMessage: async () => {} }),
    domainRun: folderDomainRun
  });
  const folderInspectionTool = folderDomainTools.find((tool) => tool.name === "inspectTranslationContext");
  assert(folderInspectionTool, "Folder inspection tool is missing from the native Pi domain toolset");
  const folderInspection = await folderInspectionTool.execute("electron-folder-inspect", {});
  const folderInspectionDetails = folderInspection.details as { sourcePath?: string; sourceSelection?: { kind?: string; documents?: Array<{ id: string }> } };
  assert(folderInspectionDetails.sourceSelection?.kind === "folder", "Folder inspection lost the host folder manifest");
  assert(
    folderInspectionDetails.sourceSelection.documents?.map((document) => document.id).join(",") === "a.txt,b.txt",
    `Folder inspection did not enumerate the host manifest: ${JSON.stringify(folderInspectionDetails.sourceSelection)}`
  );
  assert(folderInspectionDetails.sourcePath === path.join(folderSourceRoot, "a.txt"), "Folder inspection did not bind the current source to a concrete manifest file");
  mark("folder-manifest-inspect");

  const folderBatchRun = createYnDomainRunContract({
    workflowIntent: "translation",
    folderSource: true,
    subagentEnabled: true,
    subagentCount: 2
  });
  const folderBatchSupervisor = new YnSubagentSupervisor({
    publishCustomMessage: async () => {},
    notifyParent: async () => {},
    createModelSelection: async ({ providerId }) => {
      const provider = childProviders.get(providerId);
      assert(provider, `Unexpected folder child provider ${String(providerId)}`);
      return {
        models,
        model: provider.getModel(),
        providerId: provider.provider.id,
        modelId: provider.getModel().id
      };
    }
  });
  const folderBatchPrompt = buildTranslatePrompt({
    sourcePath: folderSourceRoot,
    sourceKind: "folder",
    outputDir: workspace,
    advanced: {
      glossaryCandidates: false,
      characterBible: false,
      subagentProviderId: folderChildProviderId,
      subagentModelId: folderChild.getModel().id
    }
  });
  const folderBatchRequest = {
    outputDir: workspace,
    sourcePath: folderSourceRoot,
    sourceSelection: { kind: "folder" as const, path: folderSourceRoot },
    sessionId: "electron-folder-native-batch",
    prompt: folderBatchPrompt,
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
    languagePair: "ja->zh-CN",
    subagentEnabled: true,
    subagentCount: 2,
    subagentProviderId: folderChildProviderId,
    subagentModelId: folderChild.getModel().id,
    reviewSubagentCount: 2
  };
  const folderBatchTools = createYnDomainTools({
    request: folderBatchRequest,
    publishCustomMessage: async () => {},
    subagents: folderBatchSupervisor,
    domainRun: folderBatchRun
  });
  const folderBatchInspectTool = folderBatchTools.find((tool) => tool.name === "inspectTranslationContext");
  const folderBatchRunTool = folderBatchTools.find((tool) => tool.name === "runTranslationSubagents");
  const folderBatchValidateTool = folderBatchTools.find((tool) => tool.name === "validateTranslationArtifact");
  const folderBatchSelectTool = folderBatchTools.find((tool) => tool.name === "selectSourceDocument");
  assert(
    folderBatchInspectTool
      && folderBatchRunTool
      && folderBatchValidateTool
      && folderBatchSelectTool,
    "Folder native batch tools are incomplete"
  );
  await folderBatchInspectTool.execute("electron-folder-batch-inspect", {});
  const folderBatchStart = await folderBatchRunTool.execute("electron-folder-batch-run", {});
  assert(folderBatchStart.details.subagents.length === 2, "Folder native batch did not create the configured two-worker pool");
  assert(folderBatchStart.details.assignmentCount === 2, "Folder native batch did not queue both manifest assignments");
  await folderBatchSupervisor.waitForAll();
  const folderBatchSnapshots = folderBatchSupervisor.list();
  const folderBatchSnapshot = folderBatchSnapshots.find((batch) => batch.kind === "translation");
  const folderReviewSnapshot = folderBatchSnapshots.find((batch) => batch.kind === "translation-review");
  assert(folderBatchSnapshot?.status === "completed", `Folder native batch did not complete: ${JSON.stringify(folderBatchSnapshot)}`);
  assert(
    folderReviewSnapshot?.status === "completed"
      && folderReviewSnapshot.subagents.reduce((sum, worker) => sum + (worker.completedAssignments ?? 0), 0) === 2,
    `Folder workers advanced without one review-pool decision per chunk: ${JSON.stringify(folderReviewSnapshot)}`
  );
  const folderBatchValidation = await folderBatchValidateTool.execute("electron-folder-batch-validate", {});
  assert(
    folderBatchValidation.details.documentCount === 2
      && folderBatchValidation.details.acceptedDocumentCount === 2,
    `Folder native batch final validation did not cover every manifest file: ${JSON.stringify(folderBatchValidation.details)}`
  );
  assert(
    JSON.stringify(folderBatchValidation.content).length < 12_000,
    "Folder native batch final validation returned an oversized per-document success payload"
  );
  const folderCandidateContents = await Promise.all(["a", "b"].map(async (name) => {
    const candidate = path.join(workspace, "AI_translation", `${name}_translated.txt`);
    try {
      return { name, content: await readFile(candidate, "utf8") };
    } catch (error) {
      return { name, content: `READ_ERROR:${error instanceof Error ? error.message : String(error)}` };
    }
  }));
  assert(
    folderCandidateContents.every(({ content }) => content.replace(/\r?\n$/, "") === "翻译甲\n翻译乙"),
    `Folder child candidates were not written as expected: snapshot=${JSON.stringify(folderBatchSnapshot)} contents=${JSON.stringify(folderCandidateContents)} validation=${JSON.stringify(folderBatchValidation.details)}`
  );
  mark("folder-native-batch-files");
  await writeFile(htmlPath, renderLineReviewHtml({
    title: "Pi native verifier",
    locale: "en-US",
    sourceText: "こんにちは {name}\n\nさようなら\n終わり",
    translationText: "你好 {name}\n\n再见\n结束",
    lineReviewPath: htmlPath,
    workflow: { outputDir: workspace, sourcePath, translationPath }
  }), "utf8");
  await writeFile(secondHtmlPath, renderLineReviewHtml({
    title: "Pi native verifier second file",
    locale: "en-US",
    sourceText: "こんにちは {name}\n\nさようなら\n終わり",
    translationText: "你好 {name}\n\n再见\n结束",
    lineReviewPath: secondHtmlPath,
    workflow: { outputDir: workspace, sourcePath, translationPath }
  }), "utf8");
  await mkdir(path.dirname(epubExtractedSourcePath), { recursive: true });
  await mkdir(path.dirname(epubEditableTranslationPath), { recursive: true });
  await writeFile(epubExtractedSourcePath, "原文一\n原文二", "utf8");
  await writeFile(epubEditableTranslationPath, "译文一\n译文二", "utf8");
  await writeFile(epubHtmlPath, renderLineReviewHtml({
    title: "EPUB editable TXT verifier",
    locale: "en-US",
    sourceText: "原文一\n原文二",
    translationText: "译文一\n译文二",
    lineReviewPath: epubHtmlPath,
    workflow: {
      outputDir: workspace,
      sourcePath: epubOriginalSourcePath,
      validationSourcePath: epubExtractedSourcePath,
      sourcePromptPath: epubExtractedSourcePath,
      editableTranslationPath: epubEditableTranslationPath,
      translationPromptPath: epubEditableTranslationPath,
      epubExport: { mode: "all" }
    }
  }), "utf8");
  await writeFile(folderFirstHtmlPath, renderLineReviewHtml({
    title: "Folder native verifier a",
    sourceText: "原文甲\n原文乙",
    translationText: "翻译甲\n翻译乙",
    lineReviewPath: folderFirstHtmlPath,
    workflow: {
      outputDir: workspace,
      sourcePath: folderFirstSourcePath,
      sourceKind: "file",
      sourcePromptPath: folderSourceRoot,
      promptSourceKind: "folder",
      translationPath: path.join(workspace, "AI_translation", "a_translated.txt"),
      translationPromptPath: path.join(workspace, "AI_translation")
    }
  }), "utf8");
  await writeFile(folderSecondHtmlPath, renderLineReviewHtml({
    title: "Folder native verifier b",
    sourceText: "原文甲\n原文乙",
    translationText: "翻译甲\n翻译乙",
    lineReviewPath: folderSecondHtmlPath,
    workflow: {
      outputDir: workspace,
      sourcePath: folderSecondSourcePath,
      sourceKind: "file",
      sourcePromptPath: folderSourceRoot,
      promptSourceKind: "folder",
      translationPath: path.join(workspace, "AI_translation", "b_translated.txt"),
      translationPromptPath: path.join(workspace, "AI_translation")
    }
  }), "utf8");
  await writeFile(folderHtmlPath, renderBatchLineReviewIndexHtml({
    title: "Folder Pi native verifier",
    files: [{
      sourceName: path.basename(folderFirstSourcePath),
      sourcePath: folderFirstSourcePath,
      outputPath: path.basename(folderFirstHtmlPath),
      status: "matched",
      sourceLineCount: 2,
      translationName: "a_translated.txt",
      translationPath: path.join(workspace, "AI_translation", "a_translated.txt"),
      translationLineCount: 2
    }, {
      sourceName: path.basename(folderSecondSourcePath),
      sourcePath: folderSecondSourcePath,
      outputPath: path.basename(folderSecondHtmlPath),
      status: "matched",
      sourceLineCount: 2,
      translationName: "b_translated.txt",
      translationPath: path.join(workspace, "AI_translation", "b_translated.txt"),
      translationLineCount: 2
    }],
    workflow: {
      sourcePath: folderSourceRoot,
      sourceKind: "folder",
      outputDir: workspace,
      advanced: {
        languagePair: "ja->zh-CN",
        glossaryCandidates: false,
        characterBible: false,
        subagentProviderId: folderChildProviderId,
        subagentModelId: folderChild.getModel().id
      }
    }
  }), "utf8");
  mark("fixture-written");

  folderWin = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(root, "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1",
      offscreen: process.env.YN_ELECTRON_VERIFY_OFFSCREEN === "1"
    }
  });
  folderWin.webContents.on("console-message", (details) => {
    console.log(`[folder-renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  folderWin.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    console.log(`[folder-did-fail-load] ${code} ${description} ${url} main=${isMainFrame}`);
  });
  folderWin.webContents.on("render-process-gone", (_event, details) => {
    console.log(`[folder-render-process-gone] ${JSON.stringify(details)}`);
  });
  await folderWin.loadFile(folderHtmlPath);
  revealVerificationWindow(folderWin);
  await waitFor(folderWin, 'document.querySelector("#fileFrame")?.contentDocument?.readyState === "complete"');
  await waitFor(folderWin, 'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#openAgentChat")');
  const nestedAgentOpened = await folderWin.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#openAgentChat");
    if (!button || typeof button.click !== "function") return false;
    button.click();
    return true;
  })()`);
  assert(nestedAgentOpened, "Folder child line review did not expose the Agent control");
  try {
    await waitFor(
      folderWin,
      'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")',
      3_000
    );
  } catch {
    const diagnostics = await folderWin.webContents.executeJavaScript(`(() => {
      const child = document.querySelector("#fileFrame")?.contentWindow;
      const doc = child?.document;
      return {
        childWorkshopHtml: Boolean(child?.workshopHtml),
        childWorkshop: Boolean(child?.workshop),
        flow: doc?.querySelector("#agentChatDock")?.getAttribute("data-agent-chat-flow"),
        docked: doc?.body?.classList.contains("agent-chat-docked"),
        rootText: (doc?.querySelector("#agentChatReactRoot")?.textContent || "").slice(0, 500),
        textarea: Boolean(doc?.querySelector("#agentChatReactRoot textarea"))
      };
    })()`);
    throw new Error(`Folder child Agent did not mount through the Pi-web host: ${JSON.stringify(diagnostics)}`);
  }
  const nestedWorkshopContractComplete = await folderWin.webContents.executeJavaScript(`(() => {
    const workshop = document.querySelector("#fileFrame")?.contentWindow?.workshop;
    return typeof workshop?.agentSession?.sendPrompt === "function"
      && typeof workshop?.copyText === "function"
      && typeof workshop?.openAgentChatWindow === "function";
  })()`);
  assert(nestedWorkshopContractComplete, "Folder child received only a partial Electron workshop bridge");
  const nestedFolderRoute = await folderWin.webContents.executeJavaScript(`(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    const route = child?.__ynAgentChatPiWebEmbedded?.route;
    return {
      sourceKind: route?.sourceKind,
      sourcePath: route?.sourcePath,
      lineReviewPath: route?.lineReviewPath,
      locale: route?.locale,
      closeLabel: child?.document
        ?.querySelector('.ynAgentTopbar button[aria-label="关闭 Agent"]')
        ?.getAttribute("aria-label")
    };
  })()`);
  assert(nestedFolderRoute.sourceKind === "folder", `Folder child Agent route lost promptSourceKind: ${JSON.stringify(nestedFolderRoute)}`);
  assert(nestedFolderRoute.sourcePath === folderSourceRoot, `Folder child Agent route used the selected file instead of the folder: ${JSON.stringify(nestedFolderRoute)}`);
  assert(nestedFolderRoute.locale === "zh-CN", `Chinese folder child Agent route lost its locale: ${JSON.stringify(nestedFolderRoute)}`);
  assert(nestedFolderRoute.closeLabel === "关闭 Agent", `Chinese folder child Agent chrome did not render in Chinese: ${JSON.stringify(nestedFolderRoute)}`);
  await folderWin.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#fileSelect");
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(folderWin, 'document.querySelector("#fileFrame")?.contentDocument?.title === "Folder native verifier b"');
  const secondNestedAgentOpened = await folderWin.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#openAgentChat");
    if (!button || typeof button.click !== "function") return false;
    button.click();
    return true;
  })()`);
  assert(secondNestedAgentOpened, "Second folder child did not expose the Agent control");
  await waitFor(
    folderWin,
    'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")',
    3_000
  );
  await clickSelector(folderWin, "#openActive");
  const tabRequestDeadline = Date.now() + 1_000;
  while (!requestedHtmlTabPath && Date.now() < tabRequestDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(
    requestedHtmlTabPath === pathToFileURL(folderSecondHtmlPath).toString(),
    `Folder child requested the wrong HTML tab: ${requestedHtmlTabPath}`
  );
  await capturePaintedWindow(folderWin, folderAgentScreenshot);
  win = folderWin;
  folderWin = undefined;
  mark("folder-iframe-agent-and-tab");

  await patchProjectState(workspace, {
    subagentProviderId: reviewProviderId,
    subagentModelId: reviewProvider.getModel().id,
    reviewSubagentCount: 2
  });
  verifierProjectState = { reviewSubagentCount: 3 };
  win.webContents.on("console-message", (details) => {
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  await win.loadFile(htmlPath);
  mark("html-loaded");
  await win.webContents.executeJavaScript("(() => { window.confirm = () => true; return true; })()");

  await clickSelector(win, "#glossaryDrawerToggle");
  await waitFor(win, 'document.querySelector("#importGeneratedGlossary")?.hidden === false');
  const generatedGlossaryButtonText = await win.webContents.executeJavaScript('document.querySelector("#importGeneratedGlossary")?.textContent || ""');
  assert(generatedGlossaryButtonText.includes("1"), `Generated glossary import did not show its pending count: ${generatedGlossaryButtonText}`);
  await clickSelector(win, "#importGeneratedGlossary");
  await waitFor(win, 'document.querySelector("#importGeneratedGlossary")?.hidden === true && document.querySelector("#glossaryCount")?.textContent === "1"');
  const importedGlossary = JSON.parse(await readFile(path.join(workspace, ".translation-workshop", "glossary.json"), "utf8"));
  assert(importedGlossary.entries?.[0]?.source === "固有名詞", "Generated glossary one-click import did not persist the formal glossary");
  await clickSelector(win, "#glossaryDrawerClose");
  mark("generated-glossary-one-click-import");

  const openStarted = Date.now();
  await clickSelector(win, "#openAgentChat");
  await waitFor(win, 'document.querySelector("#agentChatReactRoot textarea")');
  const interactiveMs = Date.now() - openStarted;
  assert(interactiveMs < 3000, `Agent dock took ${interactiveMs}ms to become interactive`);
  mark(`interactive-${interactiveMs}ms`);
  await waitFor(win, 'document.querySelector("[data-agent-model-button=true]")', 3_000);
  const fullyReadyMs = Date.now() - openStarted;
  assert(fullyReadyMs < 3000, `Agent dock model controls took ${fullyReadyMs}ms to become interactive`);
  mark(`controls-ready-${fullyReadyMs}ms`);
  const englishAgentUi = await win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector("#agentChatReactRoot");
    const attributes = [...root.querySelectorAll("[title], [aria-label], textarea")]
      .flatMap((node) => [
        node.getAttribute("title") || "",
        node.getAttribute("aria-label") || "",
        node.getAttribute("placeholder") || ""
      ])
      .filter(Boolean);
    return {
      lang: document.documentElement.lang,
      text: root.innerText || "",
      attributes: attributes.join("\\n")
    };
  })()`);
  assert(englishAgentUi.lang === "en-US", `English Agent host has the wrong document locale: ${JSON.stringify(englishAgentUi)}`);
  assert(!/\p{Script=Han}/u.test(`${englishAgentUi.text}\n${englishAgentUi.attributes}`), `English Agent chrome contains Chinese UI copy: ${JSON.stringify(englishAgentUi)}`);
  mark("english-agent-locale");
  await clickSelector(win, "#translatePrompt");
  await waitFor(win, 'document.querySelector("#promptSubagentModel")');
  await waitFor(win, 'document.querySelector("#promptSubagent") && document.querySelector("#promptSubagentCount") && document.querySelector("#promptReviewSubagentCount")');
  await waitFor(win, 'document.querySelector("#promptSubagentModel")?.options.length > 1', 3_000);
  const promptSubagentModelState = await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#promptSubagentModel");
    const enabled = document.querySelector("#promptSubagent");
    const count = document.querySelector("#promptSubagentCount");
    const reviewCount = document.querySelector("#promptReviewSubagentCount");
    const reviewCountField = document.querySelector("#promptReviewSubagentCountField");
    return {
      followParent: select?.querySelector('option[value=""]')?.textContent || "",
      configured: [...(select?.options || [])].filter((option) => option.value).map((option) => ({ value: option.value, label: option.textContent || "" })),
      enabled: Boolean(enabled?.checked),
      count: count?.value || "",
      reviewCount: reviewCount?.value || "",
      reviewCountVisible: Boolean(reviewCountField && !reviewCountField.hidden && reviewCountField.getClientRects().length),
      reviewCountLabel: reviewCountField?.querySelector("span")?.textContent || ""
    };
  })()`);
  assert(promptSubagentModelState.enabled, "Prompt settings did not restore subagent enabled state");
    assert(promptSubagentModelState.count === "", "Prompt settings unexpectedly materialized a default subagent count");
    assert(promptSubagentModelState.reviewCount === "", "Prompt settings unexpectedly materialized a default review Agent count");
  assert(promptSubagentModelState.reviewCountVisible, "Prompt settings did not render the review Agent count as a visible control");
  assert(/Review Agent count/i.test(promptSubagentModelState.reviewCountLabel), "Prompt settings lost the review Agent count label");
  await waitForProjectState((state) => (
    state.reviewSubagentCount === null
    && state.promptSettingsVersion === PROMPT_SETTINGS_VERSION
  ));
  const inheritedReviewCountState = await win.webContents.executeJavaScript(`(async () => {
    const count = document.querySelector("#promptSubagentCount");
    const reviewCount = document.querySelector("#promptReviewSubagentCount");
    count.value = "4";
    count.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 220));
    return {
      count: count.value,
      reviewCount: reviewCount.value,
      reviewPlaceholder: reviewCount.placeholder
    };
  })()`);
  assert(inheritedReviewCountState.count === "4", "Prompt settings lost the translation Agent count edit");
  assert(inheritedReviewCountState.reviewCount === "", "Translation Agent count incorrectly materialized a review Agent override");
  assert(/Follow translation Agent count/i.test(inheritedReviewCountState.reviewPlaceholder), "Review Agent field does not explain its inherited value");
  await waitForProjectState((state) => state.subagentCount === 4 && state.reviewSubagentCount === null);
  await win.webContents.executeJavaScript(`(async () => {
    const reviewCount = document.querySelector("#promptReviewSubagentCount");
    reviewCount.value = "2";
    reviewCount.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 220));
  })()`);
  await waitForProjectState((state) => state.reviewSubagentCount === 2);
  await win.webContents.executeJavaScript(`(async () => {
    const reviewCount = document.querySelector("#promptReviewSubagentCount");
    reviewCount.value = "";
    reviewCount.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 220));
  })()`);
  await waitForProjectState((state) => state.reviewSubagentCount === null);
  assert(promptSubagentModelState.followParent, "Prompt settings lost the follow-parent subagent model option");
  assert(promptSubagentModelState.configured.length > 0, "Prompt settings did not load configured Pi subagent models");
  const selectedSubagentModel = await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#promptSubagentModel");
    const option = [...select.options].find((item) => item.value);
    select.value = option?.value || "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.scrollIntoView({ block: "center", behavior: "instant" });
    return select.value;
  })()`);
  const selectedModelSeparator = selectedSubagentModel.indexOf(":");
  assert(selectedModelSeparator > 0, `Prompt settings selected an invalid subagent model: ${selectedSubagentModel}`);
  const selectedSubagentProviderId = selectedSubagentModel.slice(0, selectedModelSeparator);
  const selectedSubagentModelId = selectedSubagentModel.slice(selectedModelSeparator + 1);
  await waitForProjectState((state) => (
    state.subagentProviderId === selectedSubagentProviderId
    && state.subagentModelId === selectedSubagentModelId
  ));
  const promptPreviewBeforeReset = await win.webContents.executeJavaScript(
    'document.querySelector("#promptPreview")?.value || ""'
  );
  await win.webContents.executeJavaScript(`(async () => {
    const setValue = (id, value) => {
      const field = document.querySelector(id);
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const setChecked = (id, checked) => {
      const field = document.querySelector(id);
      field.checked = checked;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    setValue("#promptLanguagePair", "ko->en");
    setValue("#promptStyle", "reset-me");
    setValue("#promptWorkDescription", "discard this project override");
    setValue("#promptTranslateOutputDir", "G:/custom/translation");
    setValue("#promptProofreadOutputDir", "G:/custom/report");
    setValue("#promptSplitSize", "77");
    setValue("#promptSubagentCount", "6");
    setValue("#promptReviewSubagentCount", "4");
    setValue("#promptCandidateRatio", "9");
    setValue("#promptMontecarloSize", "42");
    setValue("#promptMontecarloRoundMin", "7");
    setValue("#promptMontecarloRoundMax", "8");
    setValue("#promptProofreadMode", "montecarlo");
    setChecked("#promptGlossaryCandidates", false);
    setChecked("#promptCharacterBible", false);
    setChecked("#promptReuseExistingTranslation", true);
    setChecked("#promptSplit", false);
    document.querySelector("#addPromptCustomPreserveRule")?.click();
    setValue(".prompt-preserve-pattern", "^prefix");
    setChecked("#promptSubagent", false);
    await new Promise((resolve) => setTimeout(resolve, 240));
  })()`);
  await waitForProjectState((state) => (
    state.languagePair === "ko->en"
    && state.style === "reset-me"
    && state.splitSize === 77
    && state.reuseExistingTranslation === true
    && state.subagentEnabled === false
    && state.subagentCount === 6
    && state.reviewSubagentCount === 4
    && state.subagentProviderId === selectedSubagentProviderId
    && state.subagentModelId === selectedSubagentModelId
    && Array.isArray(state.customPreserveRules)
    && state.customPreserveRules.length === 1
  ));
  await clickSelector(win, "#resetPromptSettings");
  const resetProjectState = await waitForProjectState((state) => (
    state.languagePair === "ja->zh-CN"
    && state.style === "game"
    && state.workDescription === ""
    && state.translateOutputDir === path.join(workspace, "AI_translation")
    && state.proofreadOutputDir === path.join(workspace, "report")
    && state.split === true
    && state.splitSize === 1000
    && state.glossaryCandidates === true
    && state.characterBible === true
    && state.reuseExistingTranslation === false
    && state.proofreadMode === "split"
    && state.candidateRatio === 1.5
    && state.montecarloSize === 3000
    && state.montecarloRoundMin === 2
    && state.montecarloRoundMax === 5
    && state.subagentEnabled === true
    && state.subagentCount === null
    && state.reviewSubagentCount === null
    && state.subagentProviderId === ""
    && state.subagentModelId === ""
    && Array.isArray(state.customPreserveRules)
    && state.customPreserveRules.length === 0
  ));
  assert(resetProjectState.promptSettingsVersion === PROMPT_SETTINGS_VERSION, "Prompt reset did not persist the current settings version");
  const resetPromptUi = await win.webContents.executeJavaScript(`(() => ({
    panelOpen: document.querySelector("#promptSettingsPanel")?.hidden === false,
    resetLabel: document.querySelector("#resetPromptSettings")?.textContent || "",
    status: document.querySelector("#aiStatus")?.textContent || "",
    promptPreview: document.querySelector("#promptPreview")?.value || "",
    languagePair: document.querySelector("#promptLanguagePair")?.value || "",
    style: document.querySelector("#promptStyle")?.value || "",
    workDescription: document.querySelector("#promptWorkDescription")?.value || "",
    translateOutputDir: document.querySelector("#promptTranslateOutputDir")?.value || "",
    proofreadOutputDir: document.querySelector("#promptProofreadOutputDir")?.value || "",
    split: Boolean(document.querySelector("#promptSplit")?.checked),
    splitSize: document.querySelector("#promptSplitSize")?.value || "",
    glossaryCandidates: Boolean(document.querySelector("#promptGlossaryCandidates")?.checked),
    characterBible: Boolean(document.querySelector("#promptCharacterBible")?.checked),
    reuseExistingTranslation: Boolean(document.querySelector("#promptReuseExistingTranslation")?.checked),
    proofreadMode: document.querySelector("#promptProofreadMode")?.value || "",
    candidateRatio: document.querySelector("#promptCandidateRatio")?.value || "",
    montecarloSize: document.querySelector("#promptMontecarloSize")?.value || "",
    montecarloRoundMin: document.querySelector("#promptMontecarloRoundMin")?.value || "",
    montecarloRoundMax: document.querySelector("#promptMontecarloRoundMax")?.value || "",
    subagentEnabled: Boolean(document.querySelector("#promptSubagent")?.checked),
    subagentCount: document.querySelector("#promptSubagentCount")?.value || "",
    reviewSubagentCount: document.querySelector("#promptReviewSubagentCount")?.value || "",
    subagentModel: document.querySelector("#promptSubagentModel")?.value || "",
    customRuleCount: document.querySelectorAll(".prompt-preserve-row").length
  }))()`);
  assert(resetPromptUi.panelOpen, "Restoring defaults unexpectedly closed the prompt settings panel");
  assert(/Restore defaults/i.test(resetPromptUi.resetLabel), `Prompt reset button has the wrong label: ${resetPromptUi.resetLabel}`);
  assert(/Default parameters restored/i.test(resetPromptUi.status), `Prompt reset did not report success: ${resetPromptUi.status}`);
  assert(resetPromptUi.promptPreview === promptPreviewBeforeReset, "Restoring defaults unexpectedly generated or replaced a prompt");
  assert(resetPromptUi.languagePair === "ja->zh-CN" && resetPromptUi.style === "game", `Prompt reset lost core defaults: ${JSON.stringify(resetPromptUi)}`);
  assert(resetPromptUi.workDescription === "", "Prompt reset did not clear the work description");
  assert(resetPromptUi.translateOutputDir === path.join(workspace, "AI_translation"), "Prompt reset restored the wrong translation output folder");
  assert(resetPromptUi.proofreadOutputDir === path.join(workspace, "report"), "Prompt reset restored the wrong report output folder");
  assert(resetPromptUi.split && resetPromptUi.splitSize === "1000", "Prompt reset did not restore split defaults");
  assert(resetPromptUi.glossaryCandidates && resetPromptUi.characterBible && !resetPromptUi.reuseExistingTranslation, "Prompt reset did not restore translation toggles");
  assert(resetPromptUi.proofreadMode === "split" && resetPromptUi.candidateRatio === "1.5", "Prompt reset did not restore proofread defaults");
  assert(resetPromptUi.montecarloSize === "3000" && resetPromptUi.montecarloRoundMin === "2" && resetPromptUi.montecarloRoundMax === "5", "Prompt reset did not restore Monte Carlo defaults");
  assert(resetPromptUi.subagentEnabled && resetPromptUi.subagentCount === "" && resetPromptUi.reviewSubagentCount === "", "Prompt reset did not restore Agent count defaults");
  assert(resetPromptUi.subagentModel === "" && resetPromptUi.customRuleCount === 0, "Prompt reset did not clear model or preservation-rule overrides");
  await win.webContents.executeJavaScript('document.querySelector("#resetPromptSettings")?.scrollIntoView({ block: "center", behavior: "instant" })');
  await capturePaintedWindow(win, promptSettingsScreenshot);
  mark("prompt-settings-restored-defaults");
  await clickSelector(win, "#cancelPromptSettings");
  await clickSelector(win, "#translatePrompt");
  await waitFor(win, 'document.querySelector("#promptSubagentModel")?.options.length > 1', 3_000);
  const followParentRestored = await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#promptSubagentModel");
    return select.value === "" && Boolean(select.selectedOptions[0]?.textContent);
  })()`);
  assert(followParentRestored, "Prompt settings did not restore Follow main Agent after clearing a model override");
  mark("prompt-settings-follow-parent-restored");
  await win.webContents.executeJavaScript(`(() => {
    const languagePair = document.querySelector("#promptLanguagePair");
    const count = document.querySelector("#promptSubagentCount");
    const style = document.querySelector("#promptStyle");
    const workDescription = document.querySelector("#promptWorkDescription");
    languagePair.value = "en->zh-CN";
    languagePair.dispatchEvent(new Event("input", { bubbles: true }));
    languagePair.dispatchEvent(new Event("change", { bubbles: true }));
    count.value = "8";
    count.dispatchEvent(new Event("input", { bubbles: true }));
    count.dispatchEvent(new Event("change", { bubbles: true }));
    style.value = "historical drama";
    style.dispatchEvent(new Event("input", { bubbles: true }));
    style.dispatchEvent(new Event("change", { bubbles: true }));
    workDescription.value = "typed project context";
    workDescription.dispatchEvent(new Event("input", { bubbles: true }));
    workDescription.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await clickSelector(win, "#applyPromptSettings");
  await waitFor(win, `(() => {
    const value = document.querySelector("#agentChatReactRoot textarea")?.value || "";
    return value.includes("Language pair: en->zh-CN.")
      && value.includes("Text/domain style: historical drama.")
      && value.includes("Work description: typed project context")
      && value.includes("Subagents: enabled; maximum=8")
      && !value.includes("runTranslationSubagents");
  })()`);
  mark("generated-prompt-kept-language-pair-and-eight-subagents");
  await setComposerValue(win, "");
  const productBackedInput = await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('#agentChatReactRoot textarea');
    const attach = document.querySelector('[data-agent-attach-image=true]');
    return Boolean(attach)
      && attach?.getAttribute('title') === 'Attach images'
      && textarea?.getAttribute('placeholder') === 'Message… Type / for commands';
  })()`);
  assert(productBackedInput, "Agent input did not expose the Pi model-backed image attachment surface");
  await setComposerValue(win, "/");
  await waitFor(win, 'document.querySelector("[data-agent-slash-menu=true]")');
  const idleSlashCommands = await win.webContents.executeJavaScript(`[
    ...document.querySelectorAll('[data-agent-slash-command]')
  ].map((node) => node.getAttribute('data-agent-slash-command'))`);
  const englishSlashText = await win.webContents.executeJavaScript(
    'document.querySelector("[data-agent-slash-menu=true]")?.innerText || ""'
  );
  assert(!/\p{Script=Han}/u.test(englishSlashText), `English slash command palette contains Chinese UI copy: ${englishSlashText}`);
  for (const command of ["btw", "session", "copy", "model", "settings", "new"]) {
    assert(idleSlashCommands.includes(command), `Missing backed slash command /${command}`);
  }
  for (const command of ["fork", "tree", "name"]) {
    assert(!idleSlashCommands.includes(command), `Unbacked slash command /${command} leaked into the product palette`);
  }
  assert(!idleSlashCommands.includes("compact"), "/compact must stay hidden until a Pi session has context to compact");
  await capturePaintedWindow(win, commandsScreenshot);
  mark("commands-screenshot");
  await setComposerValue(win, "");
  await waitFor(win, '!document.querySelector("[data-agent-slash-menu=true]")');

  const rowMenuOpened = await win.webContents.executeJavaScript(`(() => {
    const source = document.querySelector('.row[data-line="1"] .source');
    if (!(source instanceof HTMLElement)) return false;
    const textNode = [...source.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (!textNode?.textContent) return false;
    const selected = textNode.textContent.slice(0, Math.min(5, textNode.textContent.length));
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, selected.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 420 }));
    const button = document.querySelector('.yn-agent-row-menu button');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return { opened: true, selected };
  })()`);
  assert(rowMenuOpened?.opened, "Source-row context menu did not offer an Agent translation question");
  await waitFor(win, `document.querySelector('#agentChatReactRoot textarea')?.value.includes('source excerpt')`);
  const interfacePublishDeadline = Date.now() + 1_000;
  let publishedInterface = ynInterfaceContextStore.read(workspace);
  while (publishedInterface.context?.focusedLine?.line !== 1 && Date.now() < interfacePublishDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    publishedInterface = ynInterfaceContextStore.read(workspace);
  }
  assert(publishedInterface.available, "Line-review HTML did not publish its live interface context");
  assert(publishedInterface.context?.focusedLine?.line === 1, `Line-review HTML published the wrong focused row: ${JSON.stringify(publishedInterface)}`);
  assert(
    publishedInterface.context?.focusedLine?.selectedSourceText === rowMenuOpened.selected,
    `Line-review HTML lost the explicit source selection: ${JSON.stringify(publishedInterface)}`
  );
  const crossWorkspacePublishRejected = await win.webContents.executeJavaScript(`window.workshopHtml.publishAgentInterfaceContext({
    version: 1,
    outputDir: ${JSON.stringify(path.join(workspace, "other-project"))},
    pageKind: "line-review"
  }).then(result => result?.ok === false)`);
  assert(crossWorkspacePublishRejected, "A renderer could publish interface context into another project workspace");
  const rowQuestion = await win.webContents.executeJavaScript('document.querySelector("#agentChatReactRoot textarea")?.value || ""') as string;
  assert(rowQuestion.includes(rowMenuOpened.selected), "Right-click question did not include the source text explicitly selected by the user");
  assert(!rowQuestion.includes(String(publishedInterface.context?.focusedLine?.source || "")), "Right-click question copied the whole source row instead of the user's selection");
  assert(!rowQuestion.includes(String(publishedInterface.context?.focusedLine?.translation || "")), "Right-click question copied translation text into the Pi transcript");
  await submitComposer(win, rowQuestion);
  await waitFor(win, 'document.body.innerText.includes("已读取当前 YN 页面第 1 行及相邻上下文。")', 5_000);
  await waitFor(win, '!document.querySelector("#agentChatReactRoot .ynAgentInputStop")');

  await submitComposer(win, `读取这个项目外参考文件：${externalReferencePath}`);
  await waitFor(win, 'document.querySelectorAll("[data-agent-tool-call=readProjectFile]").length === 1', 5_000);
  await waitFor(win, 'document.body.innerText.includes("已直接读取项目外部参考资料。")', 5_000);
  await waitFor(win, '!document.querySelector("#agentChatReactRoot .ynAgentInputStop")');
  mark("external-reference-read-through-pi-host");

  const imageAttached = await win.webContents.executeJavaScript(`(async () => {
    const textarea = document.querySelector('#agentChatReactRoot textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.fillStyle = '#315aa3';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.font = 'bold 30px sans-serif';
    context.fillText('YN', 36, 50);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!(blob instanceof Blob)) return false;
    const file = new File([blob], 'pasted.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
    textarea.dispatchEvent(event);
    return true;
  })()`);
  assert(imageAttached, "Electron could not dispatch a pasted image to Pi-web ChatInput");
  await waitFor(win, 'document.querySelector("[data-agent-image-previews=true] img")', 2_000);
  await submitComposer(win, "这张图里有什么？");
  await waitFor(win, 'document.body.innerText.includes("图片已通过原生 Pi 多模态消息收到。")', 5_000);
  await waitFor(win, 'document.querySelector("[data-agent-message-role=user] img")', 2_000);
  await capturePaintedWindow(win, interfaceImageScreenshot);
  mark("interface-context-row-question-and-image-paste");
  popoutInteractiveMs = await openPopoutAndMeasure(win);
  await submitComposer(win, "/model");
  await waitFor(win, 'document.querySelector("[data-agent-model-menu=true]")');
  for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    await waitFor(win, `document.querySelector('[data-agent-model-option$=":${modelId}"]')`);
  }
  await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector("#agentChatReactRoot textarea");
    if (!(textarea instanceof HTMLElement)) return false;
    textarea.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    textarea.click();
    return true;
  })()`);
  await waitFor(win, '!document.querySelector("[data-agent-model-menu=true]")');
  await waitForPaint(win);

  const optimisticMs = await sendMessage(win, "你好");
  assert(optimisticMs < 300, `Optimistic user message took ${optimisticMs.toFixed(1)}ms`);
  mark(`optimistic-${optimisticMs.toFixed(1)}ms`);
  await waitFor(win, 'document.querySelector("#agentChatReactRoot .ynAgentInputStop")');
  await waitFor(win, 'document.querySelector("[data-agent-thinking-block=true]")');
  await waitFor(win, 'document.querySelector("[data-agent-token-speed=true]")', 12_000);
  const thinkingCollapsed = await win.webContents.executeJavaScript(`(() => {
    const block = document.querySelector('[data-agent-thinking-block="true"]');
    return block && !(block.textContent || "").includes(${JSON.stringify(longThinking.slice(0, 30))});
  })()`);
  assert(thinkingCollapsed, "Thinking content is expanded or leaked by default");
  await capturePaintedWindow(win, streamScreenshot);
  mark("streaming-screenshot");
  const userMessagesBeforeBtw = await win.webContents.executeJavaScript('document.querySelectorAll("[data-agent-message-role=user]").length');
  await setComposerValue(win, "/");
  await waitFor(win, 'document.querySelector("[data-agent-slash-menu=true]")');
  const runningSlashCommands = await win.webContents.executeJavaScript(`[
    ...document.querySelectorAll('[data-agent-slash-command]')
  ].map((node) => node.getAttribute('data-agent-slash-command'))`);
  for (const command of ["btw", "session", "copy", "stop", "steer", "followup"]) {
    assert(runningSlashCommands.includes(command), `Missing running slash command /${command}`);
  }
  for (const command of ["model", "settings", "new"]) {
    assert(!runningSlashCommands.includes(command), `Idle-only slash command /${command} remained active during a run`);
  }
  await submitComposer(win, "/btw");
  await waitFor(win, 'document.querySelector("[data-agent-run-status=running]")');
  const btwStayedLocal = await win.webContents.executeJavaScript(`(() => {
    const users = [...document.querySelectorAll('[data-agent-message-role=user]')];
    return users.length === ${userMessagesBeforeBtw}
      && !users.some((node) => (node.textContent || '').includes('/btw'));
  })()`);
  assert(btwStayedLocal, "/btw was sent to the model instead of opening native Pi progress");
  await capturePaintedWindow(win, progressScreenshot);
  mark("progress-screenshot");
  await clickSelector(win, ".ynAgentTelemetry");
  await waitFor(win, '!document.querySelector("[data-agent-run-status]")');

  await waitFor(win, 'document.body.innerText.includes("Pi 会话已经正常完成")', 15_000);
  await waitFor(win, '!document.querySelector("#agentChatReactRoot .ynAgentInputStop, #agentChatReactRoot .ynAgentSubagentStop")');
  await submitComposer(win, "/copy");
  await waitFor(win, 'document.querySelector("[data-agent-command-notice]")');
  const copiedAssistantText = clipboard.readText();
  const clipboardNativeVerified = copiedAssistantText.includes("Pi 会话已经正常完成");
  assert(
    clipboardWriteRequested.includes("Pi 会话已经正常完成"),
    `/copy sent the wrong assistant reply to native IPC: ${JSON.stringify(clipboardWriteRequested)}`
  );
  const copyNoticeKind = await win.webContents.executeJavaScript(
    'document.querySelector("[data-agent-command-notice]")?.getAttribute("data-agent-command-notice")'
  );
  assert(
    (copyNoticeKind === "success") === clipboardNativeVerified,
    `Clipboard notice did not reflect native write verification: notice=${copyNoticeKind} clipboard=${JSON.stringify(copiedAssistantText)}`
  );
  await setComposerValue(win, "");
  mark("hello-complete");

  await sendMessage(win, "调用工具");
  await waitFor(win, 'document.querySelectorAll("[data-agent-tool-call=echo]").length === 1');
  await waitFor(win, 'document.body.innerText.includes("工具调用与结果已经配对")');
  const markdownRendered = await win.webContents.executeJavaScript(`(() => {
    const strong = [...document.querySelectorAll('.markdown-body strong')]
      .find((node) => (node.textContent || '').trim() === '配对');
    return Boolean(strong) && !document.body.innerText.includes('**配对**');
  })()`);
  assert(markdownRendered, "Pi-web Markdown did not render bold text structurally");
  await clickSelector(win, '[data-agent-tool-call="echo"] button');
  await waitFor(win, 'document.querySelector("[data-agent-tool-call=echo]").innerText.includes("paired-result")');
  mark("tool-paired");

  const translationPrompt = buildTranslatePrompt({
    sourcePath,
    outputDir: workspace,
    advanced: { glossaryCandidates: false, characterBible: false }
  });
  await sendMessage(win, translationPrompt, "translation");
  await waitFor(win, `(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    return cards.length === 2 && cards.every((card) => card.getAttribute('data-agent-subagent-status') === 'running');
  })()`);
  const runningChildModelsVisible = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    return cards.length === 2 && cards.every((card) => {
      const model = card.querySelector('[data-agent-subagent-model=true]');
      return Boolean((model?.textContent || '').trim());
    });
  })()`);
  assert(runningChildModelsVisible, "Running subagent cards do not identify their selected models");
  await waitFor(win, 'document.querySelector("[data-agent-subagent-waiting=true]")');
  const parentDuringChildrenText = "两个子任务运行时主 Agent 能否立即回答？";
  const parentDuringChildrenMs = await sendMessage(win, parentDuringChildrenText);
  assert(
    parentDuringChildrenMs < 300,
    `Parent interaction took ${parentDuringChildrenMs.toFixed(1)}ms to become visible while children ran`
  );
  await waitFor(win, 'document.body.innerText.includes("主 Agent 已在 subagent 运行期间即时回复")');
  const parentAnsweredBeforeChildren = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    return cards.length === 2 && cards.every((card) => card.getAttribute('data-agent-subagent-status') === 'running');
  })()`);
  assert(parentAnsweredBeforeChildren, "Parent response waited for the background children to finish");
  releaseBackgroundChildren();
  assert(
    await win.webContents.executeJavaScript('!document.querySelector("[data-agent-queued-input]")'),
    "Idle parent interaction was incorrectly routed through a queued Steer/Follow-up surface"
  );
  await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    cards.at(-1)?.scrollIntoView({ block: 'end', behavior: 'instant' });
  })()`);
  await waitForPaint(win);
  await capturePaintedWindow(win, subagentInteractionScreenshot);
  mark(`subagents-running-parent-interactive-${parentDuringChildrenMs.toFixed(1)}ms`);
  await waitFor(win, '[...document.querySelectorAll("[data-agent-subagent-card=true]")].every((card) => card.innerText.includes("Subagent closed"))');
  await waitFor(win, 'document.body.innerText.includes("两个 subagent 已完成，主 Agent 已汇总")');
  await waitFor(win, '!document.querySelector("#agentChatReactRoot .ynAgentInputStop, #agentChatReactRoot .ynAgentSubagentStop")');
  await waitFor(win, '!document.querySelector("[data-agent-queued-input]")');
  const toolDetailsStayedOpen = await win.webContents.executeJavaScript(
    'document.querySelector("[data-agent-tool-call=echo] pre") !== null'
  );
  assert(toolDetailsStayedOpen, "An open tool detail was reset by live updates or terminal transcript convergence");

  // Drop all in-memory run/card state, then rebuild the renderer from the parent
  // Pi JSONL. This is the regression boundary for replies collapsing to `Done.`.
  await service.disposeWorkspace(workspace);
  const reloaded = new Promise<void>((resolve) => win!.webContents.once("did-finish-load", () => resolve()));
  win.webContents.reloadIgnoringCache();
  await reloaded;
  await win.webContents.executeJavaScript(`(() => {
    window.confirm = () => true;
    if (!document.querySelector('#agentChatReactRoot textarea')) {
      document.querySelector('#openAgentChat')?.click();
    }
    return true;
  })()`);
  await waitFor(win, 'document.querySelector("#agentChatReactRoot textarea")');
  await waitFor(win, '[...document.querySelectorAll("[data-agent-subagent-card=true]")].length === 4');
  await waitFor(win, '[...document.querySelectorAll("[data-agent-subagent-card=true]")].every((card) => card.innerText.includes("Subagent closed"))');
  mark("subagent-transcript-jsonl-reload");
  const reloadedParentSessionId = (await service.bootstrap(workspace)).activeSessionId;
  const reloadedParentMessages = await service.loadMessages(workspace, reloadedParentSessionId);
  const reloadedChildIds = reloadedParentMessages.flatMap((message) => {
    const details = message.role === "custom" && message.details && typeof message.details === "object"
      ? message.details as Record<string, unknown>
      : undefined;
    return message.role === "custom"
      && message.customType === "subagent.translation"
      && typeof details?.subagentId === "string"
      ? [details.subagentId]
      : [];
  });
  assert(reloadedChildIds.length === 2, `Reloaded parent did not expose two lightweight child references: ${JSON.stringify(reloadedChildIds)}`);
  const directChildLoadStarted = performance.now();
  const directChildMessages = await service.loadSubagentMessages(workspace, reloadedParentSessionId, reloadedChildIds[0]);
  mark(`subagent-direct-jsonl-${directChildMessages.length}-${(performance.now() - directChildLoadStarted).toFixed(1)}ms`);
  const ipcChildLoadStarted = performance.now();
  const ipcChildMessageCount = await win.webContents.executeJavaScript(`window.workshop.agentSession.loadSubagentMessages({
    outputDir: ${JSON.stringify(workspace)},
    parentSessionId: ${JSON.stringify(reloadedParentSessionId)},
    childSessionId: ${JSON.stringify(reloadedChildIds[0])}
  }).then((messages) => messages.length)`);
  assert(ipcChildMessageCount === directChildMessages.length, `Child transcript IPC returned ${ipcChildMessageCount} messages instead of ${directChildMessages.length}`);
  mark(`subagent-ipc-jsonl-${ipcChildMessageCount}-${(performance.now() - ipcChildLoadStarted).toFixed(1)}ms`);
  const cardsCollapsed = await win.webContents.executeJavaScript('[...document.querySelectorAll("[data-agent-subagent-card=true]")].every((card) => card.dataset.agentSubagentExpanded === "false")');
  assert(cardsCollapsed, "Subagent cards must be collapsed by default");
  const childReplyProofs: Array<{ label: string; reply: string }> = [];
  for (let index = 0; index < 2; index += 1) {
    await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .filter((entry) => !(entry.textContent || '').includes('Review Worker'))[${index}];
      if (!card) return false;
      if (card.dataset.agentSubagentExpanded !== 'true') card.querySelector(':scope > button')?.click();
      return true;
    })()`);
    await waitFor(win, `(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .filter((entry) => !(entry.textContent || '').includes('Review Worker'))[${index}];
      return card?.dataset.agentSubagentExpanded === 'true'
        && card.querySelector('[data-agent-subagent-filter=prompt]')
        && card.querySelector('[data-agent-subagent-filter=reply]');
    })()`);
    await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .filter((entry) => !(entry.textContent || '').includes('Review Worker'))[${index}];
      const reply = card?.querySelector('[data-agent-subagent-filter=reply]');
      if (reply?.getAttribute('aria-pressed') !== 'true') reply?.click();
    })()`);
    await waitFor(win, `(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .filter((entry) => !(entry.textContent || '').includes('Review Worker'))[${index}];
      return card?.querySelector('[data-agent-subagent-filter=reply]')?.getAttribute('aria-pressed') === 'true';
    })()`);
    await waitFor(win, `(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .filter((entry) => !(entry.textContent || '').includes('Review Worker'))[${index}];
      return Boolean(card?.querySelector('[data-agent-subagent-transcript=true]'))
        || Boolean(card?.querySelector('[data-agent-subagent-panel=reply].ynAgentError'));
    })()`);
    const proof = await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .filter((entry) => !(entry.textContent || '').includes('Review Worker'))[${index}];
      const label = (card?.querySelector(':scope > button span')?.textContent || '').trim();
      const reply = (card?.querySelector('[data-agent-subagent-panel=reply]')?.textContent || '').trim();
      const result = (card?.querySelector('[data-agent-subagent-result=true]')?.textContent || '').trim();
      return { label, reply, result };
    })()`);
    assert(
      proof.reply.length > 0
        && !proof.reply.includes("unavailable")
        && proof.reply.includes("readAssignedSource")
        && proof.reply.includes("writeAssignedTranslation")
        && proof.reply.includes("validateAssignedTranslation")
        && /review-worker-accepted candidate/i.test(proof.result)
        && /accepted before queue advance/i.test(proof.result),
      `Completed subagent card ${index + 1} does not expose its complete native Pi transcript`
    );
    childReplyProofs.push(proof);
  }
  assert(childReplyProofs.length === 2, "Electron verification did not inspect both child replies");
  assert(new Set(childReplyProofs.map((proof) => proof.label)).size === 2, "Electron verification inspected the same child card twice");
  await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('[data-agent-subagent-card=true]')];
    const translationCards = cards.filter((entry) => !(entry.textContent || '').includes('Review Worker'));
    if (translationCards[0]?.dataset.agentSubagentExpanded === 'true') translationCards[0].querySelector(':scope > button')?.click();
    const card = translationCards[1];
    const childTranscript = card?.querySelector('[data-agent-subagent-transcript=true]');
    if (childTranscript instanceof HTMLElement) childTranscript.scrollTop = childTranscript.scrollHeight;
    const transcript = document.querySelector('.ynAgentTranscript');
    if (card instanceof HTMLElement && transcript instanceof HTMLElement) {
      transcript.scrollTop += card.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 16;
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitForPaint(win);
  await capturePaintedWindow(win, subagentRepliesScreenshot);
  mark("subagent-replies-screenshot");
  await waitFor(win, `[
    ...document.querySelectorAll('[data-agent-message-role=user]')
  ].filter((node) => !node.closest('[data-agent-subagent-transcript=true]'))
    .some((node) => (node.textContent || '').includes(${JSON.stringify(parentDuringChildrenText)}))`);
  const parentInteractionDomOrder = await win.webContents.executeJavaScript(`(() => {
    const users = [...document.querySelectorAll('[data-agent-message-role=user]')]
      .filter((node) => !node.closest('[data-agent-subagent-transcript=true]'))
      .map((node) => node.textContent || '');
    const interactionIndexes = users
      .map((text, index) => text.includes(${JSON.stringify(parentDuringChildrenText)}) ? index : -1)
      .filter((index) => index >= 0);
    const translationIndex = users.findIndex((text) => text.includes('Workflow: yn-translation-v1'));
    return { interactionIndexes, translationIndex };
  })()`);
  assert(
    parentInteractionDomOrder.interactionIndexes.length === 1,
    `Parent interaction rendered ${parentInteractionDomOrder.interactionIndexes.length} times instead of exactly once`
  );
  assert(
    parentInteractionDomOrder.interactionIndexes[0] === parentInteractionDomOrder.translationIndex + 1,
    `Parent interaction rendered out of user-message order: ${JSON.stringify(parentInteractionDomOrder)}`
  );
  const translationSessionId = (await service.bootstrap(workspace)).activeSessionId;
  const translationMessages = await service.loadMessages(workspace, translationSessionId);
  const translationUserTexts = translationMessages
    .filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  const parentInteractionIndex = translationUserTexts.indexOf(parentDuringChildrenText);
  const translationPromptIndex = translationUserTexts.indexOf(translationPrompt);
  assert(
    translationUserTexts.filter((text) => text === parentDuringChildrenText).length === 1,
    `Native Pi persisted the parent interaction more than once: ${JSON.stringify(translationUserTexts)}`
  );
  assert(
    parentInteractionIndex === translationPromptIndex + 1,
    `Native Pi persisted the parent interaction out of order: ${JSON.stringify(translationUserTexts)}`
  );
  assert(
    translationMessages.some((message) => message.role === "custom" && message.customType === "yn-domain-repair"),
    "Deterministic verifier did not exercise the host completion repair gate"
  );
  assert(
    (await service.getRunState(workspace, translationSessionId)).error === undefined,
    "Host completion gate did not settle successfully after the repaired workflow"
  );
  assert(typedWorkflowIntentObserved, "Generated translation intent did not cross the product IPC contract");
  assert(typedLanguagePairObserved, "Generated language pair did not cross the product IPC contract");
  assert(typedStyleObserved, "Generated style did not cross the product IPC contract");
  assert(typedWorkDescriptionObserved, "Generated work description did not cross the product IPC contract");
  await waitFor(win, '!document.querySelector(".ynAgentInputStop, .ynAgentSubagentStop")', 5_000);
  mark("subagents-complete");

  faux.setResponses([
    fauxAssistantMessage(fauxText("错误前的当前会话记录仍然存在。")),
    async () => { throw new Error("insufficient_quota: deterministic provider failure"); },
    async () => { throw new Error("fetch failed"); },
    fauxAssistantMessage(fauxText("临时网络失败已由同一 Pi turn 自动恢复。")),
    fauxAssistantMessage(fauxText("当前新会话保留。")),
    fauxAssistantMessage([fauxThinking("确认两个窗口绑定同一会话。"), fauxText("共享窗口已经实时同步。")]),
    fauxAssistantMessage(fauxText("关闭弹窗后 dock 仍继续工作。")),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return fauxAssistantMessage(fauxText("Native Pi memory summary retained the current task, decisions, and validated artifacts."));
    },
    fauxAssistantMessage(fauxText("Recent turn prefix retained the active request and its current execution state."))
  ]);

  const transcriptText = await win.webContents.executeJavaScript('document.querySelector("#agentChatReactRoot").innerText');
  for (const forbidden of [
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "to=host_tool",
    "eventRef",
    "tool_execution_start",
    "yn-domain-repair",
    "hidden extension message",
    "{\"path\"",
    "[object Object]"
  ]) assert(!transcriptText.includes(forbidden), `Raw protocol leaked into transcript: ${forbidden}`);
  await capturePaintedWindow(win, completeScreenshot);
  mark("complete-screenshot");

  const beforeNew = await service.bootstrap(workspace);
  assert(beforeNew.sessions.length === 1, "Expected one completed Pi session");
  await submitComposer(win, "/new");
  await waitFor(win, 'document.querySelectorAll(".ynAgentSessionItem").length === 2');
  await waitFor(win, 'document.querySelectorAll("[data-agent-message-role]").length === 0');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const newSessionStayedEmpty = await win.webContents.executeJavaScript('document.querySelectorAll("[data-agent-message-role]").length === 0');
  assert(newSessionStayedEmpty, "New Pi session briefly reloaded the previous session transcript");
  const oldErrorCleared = await win.webContents.executeJavaScript(
    '!document.body.innerText.includes("deterministic provider failure")'
  );
  assert(oldErrorCleared, "New Pi session retained the previous session error");
  await sendMessage(win, "建立错误前记录");
  await waitFor(win, 'document.body.innerText.includes("错误前的当前会话记录仍然存在")');
  await waitFor(win, '!document.querySelector(".ynAgentInputStop, .ynAgentSubagentStop")', 2_000);
  await sendMessage(win, "触发错误但保留记录");
  await waitFor(win, 'document.body.innerText.includes("deterministic provider failure")');
  await waitFor(win, '!document.querySelector(".ynAgentInputStop, .ynAgentSubagentStop")', 2_000);
  const inlineProviderError = await win.webContents.executeJavaScript(`(() => {
    const errors = [...document.querySelectorAll('.ynAgentError')]
      .filter((element) => element.getClientRects().length > 0);
    const error = errors.at(-1);
    const stopVisible = [...document.querySelectorAll('.ynAgentInputStop')]
      .some((button) => !button.disabled && button.getClientRects().length > 0);
    return {
      count: errors.length,
      text: error?.textContent || '',
      stopVisible
    };
  })()`);
  assert(inlineProviderError.count === 1, `Provider failure rendered ${inlineProviderError.count} visible errors`);
  assert(
    inlineProviderError.text.includes("deterministic provider failure"),
    `Provider failure was not rendered in the transcript: ${JSON.stringify(inlineProviderError)}`
  );
  assert(!inlineProviderError.stopVisible, "Provider failure left the Agent UI running after the terminal error");
  const transcriptSurvivedError = await win.webContents.executeJavaScript(`(() => {
    const text = document.querySelector('.ynAgentTranscript')?.innerText || '';
    return text.includes('错误前的当前会话记录仍然存在') && text.includes('触发错误但保留记录');
  })()`);
  assert(transcriptSurvivedError, "A runtime error replaced the existing Pi transcript");
  mark("error-kept-transcript");
  const transientRetryPaintMs = await sendMessage(win, "触发临时网络失败并自动恢复");
  await waitFor(
    win,
    'Boolean(document.querySelector("[data-agent-auto-retry]"))',
    3_000
  );
  const retryUi = await win.webContents.executeJavaScript(`(() => {
    const notice = document.querySelector('[data-agent-auto-retry]');
    const stopVisible = [...document.querySelectorAll('.ynAgentInputStop')]
      .some((button) => !button.disabled && button.getClientRects().length > 0);
    return {
      text: notice?.textContent || '',
      stopVisible
    };
  })()`);
  assert(retryUi.text.includes("1/3"), `Pi retry progress was not visible: ${JSON.stringify(retryUi)}`);
  assert(retryUi.stopVisible, "Pi retry did not remain abortable while waiting for the provider");
  await capturePaintedWindow(win, providerRetryScreenshot);
  await waitFor(win, 'document.body.innerText.includes("临时网络失败已由同一 Pi turn 自动恢复")', 8_000);
  await waitFor(win, '!document.querySelector("[data-agent-auto-retry]")', 2_000);
  await waitFor(win, '!document.querySelector(".ynAgentInputStop, .ynAgentSubagentStop")', 2_000);
  assert(
    transientRetryPaintMs < 1_000,
    `Transient provider failure delayed optimistic user feedback by ${transientRetryPaintMs.toFixed(1)}ms`
  );
  const retryUserCount = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('[data-agent-message-role="user"]')]
      .filter((node) => (node.textContent || '').includes('触发临时网络失败并自动恢复')).length
  `);
  assert(retryUserCount === 1, `Pi retry duplicated the user turn ${retryUserCount} times`);
  mark("provider-auto-retry-complete");

  faux.setResponses([
    async () => { throw new Error("fetch failed"); },
    fauxAssistantMessage(fauxText("取消后的重试不应继续请求模型。"))
  ]);
  await sendMessage(win, "触发临时网络失败并在退避期停止");
  await waitFor(win, 'Boolean(document.querySelector("[data-agent-auto-retry]"))', 3_000);
  const retryAbortStartedAt = performance.now();
  const retryStopClicked = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.ynAgentInputStop')]
      .find((node) => !node.disabled && node.getClientRects().length > 0);
    button?.click();
    return Boolean(button);
  })()`);
  assert(retryStopClicked, "Electron retry acceptance could not click the visible Stop button");
  await waitFor(win, '!document.querySelector("[data-agent-auto-retry]")', 1_000);
  await waitFor(win, '!document.querySelector(".ynAgentInputStop, .ynAgentSubagentStop")', 1_000);
  const retryAbortMs = performance.now() - retryAbortStartedAt;
  assert(retryAbortMs < 1_000, `Stopping Pi retry backoff took ${retryAbortMs.toFixed(1)}ms`);
  const cancelledRetryContinued = await win.webContents.executeJavaScript(
    'document.body.innerText.includes("取消后的重试不应继续请求模型")'
  );
  assert(!cancelledRetryContinued, "Stop allowed the provider retry to continue after backoff cancellation");
  mark("provider-auto-retry-aborted");

  faux.setResponses([
    fauxAssistantMessage(fauxText("当前新会话保留。")),
    fauxAssistantMessage([fauxThinking("确认两个窗口绑定同一会话。"), fauxText("共享窗口已经实时同步。")]),
    fauxAssistantMessage(fauxText("关闭弹窗后 dock 仍继续工作。")),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return fauxAssistantMessage(fauxText("Native Pi memory summary retained the current task, decisions, and validated artifacts."));
    },
    fauxAssistantMessage(fauxText("Recent turn prefix retained the active request and its current execution state."))
  ]);
  await sendMessage(win, "当前会话消息");
  await waitFor(win, 'document.body.innerText.includes("当前新会话保留")');
  await waitFor(win, '!document.querySelector("#agentChatReactRoot .ynAgentInputStop, #agentChatReactRoot .ynAgentSubagentStop")');
  await win.webContents.executeJavaScript(`(() => {
    window.__agentDeleteMessageMissing = false;
    window.__agentDeleteObserver = new MutationObserver(() => {
      const text = document.querySelector('.ynAgentTranscript')?.innerText || '';
      if (!text.includes('当前会话消息') || !text.includes('当前新会话保留')) {
        window.__agentDeleteMessageMissing = true;
      }
    });
    window.__agentDeleteObserver.observe(document.querySelector('.ynAgentTranscript'), { childList: true, subtree: true });
  })()`);
  const oldPath = beforeNew.sessions[0].path;
  const deleted = await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.ynAgentSessionItem')]
      .find((node) => !node.classList.contains('ynAgentSessionItemActive'));
    const button = item?.querySelector('.ynAgentSessionDelete');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(deleted, "Could not invoke session deletion from the UI");
  await waitFor(win, 'document.querySelectorAll(".ynAgentSessionItem").length === 1');
  let sessionFileDeleted = false;
  try {
    await access(oldPath);
  } catch (fileError) {
    sessionFileDeleted = (fileError as NodeJS.ErrnoException).code === "ENOENT";
  }
  assert(sessionFileDeleted, `Deleted session still exists on disk: ${oldPath}`);
  const activeTranscriptPreserved = await win.webContents.executeJavaScript(`(() => {
    window.__agentDeleteObserver?.disconnect();
    const text = document.querySelector('.ynAgentTranscript')?.innerText || '';
    return !window.__agentDeleteMessageMissing
      && text.includes('当前会话消息')
      && text.includes('当前新会话保留');
  })()`);
  assert(activeTranscriptPreserved, "Deleting an inactive session cleared or switched the active transcript");
  mark("session-delete");

  await clickSelector(win, '.ynAgentTopbar button[aria-label="Close Agent"]');
  await waitFor(win, '!document.body.classList.contains("agent-chat-docked")');
  await clickSelector(win, "#openAgentChat");
  await waitFor(win, 'document.body.classList.contains("agent-chat-docked") && document.querySelector("#agentChatReactRoot textarea")');
  await submitComposer(win, "/settings");
  await waitFor(win, 'document.querySelector(".ynAgentProviderSettings")');
  await waitFor(win, 'document.querySelector(".ynAgentProviderList") && [...document.querySelectorAll(".ynAgentProviderSettings button")].some((button) => button.textContent.includes("Test"))');
  const settingsCloseLayout = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.ynAgentProviderSettings');
    const header = document.querySelector('.ynAgentProviderSettingsHeader');
    const topbar = document.querySelector('.ynAgentTopbar');
    const close = [...document.querySelectorAll('.ynAgentProviderSettingsHeader button')]
      .find((button) => (button.textContent || '').trim() === 'Close');
    if (!(panel instanceof HTMLElement) || !(header instanceof HTMLElement) || !(topbar instanceof HTMLElement) || !(close instanceof HTMLButtonElement)) return { ok: false, reason: 'missing-element' };
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const topbarRect = topbar.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const centerX = closeRect.left + closeRect.width / 2;
    const centerY = closeRect.top + closeRect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const ok = closeRect.width > 0
      && closeRect.height > 0
      && headerRect.top >= topbarRect.bottom - 1
      && headerRect.top >= panelRect.top
      && closeRect.top >= panelRect.top
      && closeRect.bottom <= panelRect.bottom
      && closeRect.left >= panelRect.left
      && closeRect.right <= panelRect.right
      && !document.querySelector('.ynAgentComposer')
      && (hit === close || close.contains(hit));
    return {
      ok,
      panel: { top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, right: panelRect.right },
      header: { top: headerRect.top, bottom: headerRect.bottom },
      topbar: { top: topbarRect.top, bottom: topbarRect.bottom },
      close: { top: closeRect.top, bottom: closeRect.bottom, left: closeRect.left, right: closeRect.right },
      hit: hit?.className || hit?.tagName || null,
      composerPresent: Boolean(document.querySelector('.ynAgentComposer'))
    };
  })()`);
  assert(settingsCloseLayout?.ok, `Provider settings Close button is clipped or covered and cannot be clicked by the user: ${JSON.stringify(settingsCloseLayout)}`);
  const settingsFunctional = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.ynAgentProviderSettings');
    const list = document.querySelector('.ynAgentProviderList');
    const buttons = [...panel.querySelectorAll('button')].map((button) => (button.textContent || '').trim());
    return Boolean(list && getComputedStyle(list).overflowY !== 'visible' && buttons.some((text) => text.includes('Test')) && buttons.some((text) => text.includes('Use provider') || text.includes('Save')));
  })()`);
  assert(settingsFunctional, "Provider settings is not scrollable or lacks functional actions");
  await clickByText(win, ".ynAgentProviderList button", "Custom API");
  await waitFor(win, 'document.querySelector(".ynAgentProviderSettings textarea")');
  await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.ynAgentProviderSettings textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, 'opencode-main');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return true;
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.ynAgentProviderSettings textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, textarea.value + '\\n');
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertLineBreak',
      data: null
    }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const multilineModelIds = await win.webContents.executeJavaScript(
    `document.querySelector(".ynAgentProviderSettings textarea")?.value`
  );
  assert(multilineModelIds === "opencode-main\n", "Model IDs textarea discarded the Enter newline");
  mark("provider-multiline");
  const customDraftReady = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.ynAgentProviderSettings');
    const inputs = [...panel.querySelectorAll('input')];
    const name = inputs.find((input) => input.closest('label')?.textContent?.includes('Name'));
    const baseUrl = inputs.find((input) => input.closest('label')?.textContent?.includes('Base URL'));
    const apiKey = inputs.find((input) => input.closest('label')?.textContent?.includes('API key'));
    const textarea = panel.querySelector('textarea');
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setTextarea = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (!(name instanceof HTMLInputElement) || !(baseUrl instanceof HTMLInputElement)
      || !(apiKey instanceof HTMLInputElement) || !(textarea instanceof HTMLTextAreaElement)) return false;
    setInput(name, 'Verifier OpenCode Go');
    setInput(baseUrl, 'https://opencode.example/v1');
    setInput(apiKey, 'verifier-opencode-key');
    setTextarea(textarea, 'opencode-main\\nopencode-fast');
    return true;
  })()`);
  assert(customDraftReady, "Could not populate the named Custom API profile");
  await clickByText(win, ".ynAgentProviderActions button", "Save");
  await waitFor(win, `[...document.querySelectorAll('.ynAgentProviderList button')].some((button) => button.textContent.includes('Verifier OpenCode Go'))`);
  mark("provider-profile-saved");
  await clickByText(win, ".ynAgentProviderList button", "ChatGPT");
  await clickByText(win, ".ynAgentProviderList button", "Verifier OpenCode Go");
  mark("provider-profile-switched");
  const restoredCustomProfile = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.ynAgentProviderSettings');
    const name = [...panel.querySelectorAll('input')].find((input) => input.closest('label')?.textContent?.includes('Name'));
    const textarea = panel.querySelector('textarea');
    return name?.value === 'Verifier OpenCode Go'
      && textarea?.value === 'opencode-main\\nopencode-fast'
      && [...document.querySelectorAll('.ynAgentProviderList button')].some((button) => button.textContent.includes('new custom provider'));
  })()`);
  assert(restoredCustomProfile, "Named Custom API settings were not restored after switching providers");
  mark("provider-profile-restored");
  await clickByText(win, ".ynAgentProviderActions button", "Disable");
  mark("provider-disable-clicked");
  await waitFor(win, `document.querySelector('.ynAgentProviderStatus')?.textContent.includes('Disabled')`);
  mark("provider-disabled");
  const disabledCustomExcluded = !(await listPiConfiguredModels(workspace))
    .some((model) => model.providerName === "Verifier OpenCode Go" && model.authenticated);
  assert(disabledCustomExcluded, "Disabled Custom API models remained in the chat model picker");
  await clickByText(win, ".ynAgentProviderActions button", "Enable");
  await waitFor(win, `document.querySelector('.ynAgentProviderStatus')?.textContent.includes('Saved')`);
  const reenabledCustomModels = (await listPiConfiguredModels(workspace))
    .filter((model) => model.providerName === "Verifier OpenCode Go" && model.authenticated)
    .map((model) => model.modelId);
  assert(
    JSON.stringify(reenabledCustomModels) === JSON.stringify(["opencode-main", "opencode-fast"]),
    "Re-enabled Custom API did not restore all saved models"
  );
  await win.webContents.executeJavaScript(`(() => { window.confirm = () => true; return true; })()`);
  await clickByText(win, ".ynAgentProviderActions button", "Delete");
  await waitFor(win, `![...document.querySelectorAll('.ynAgentProviderList button')].some((button) => button.textContent.includes('Verifier OpenCode Go'))`);
  await capturePaintedWindow(win, providerSettingsScreenshot);
  mark("provider-settings");
  await clickByText(win, ".ynAgentProviderSettingsHeader button", "Close");

  assert(popoutWin && !popoutWin.isDestroyed(), "Shared Pi-web popout closed before the live-state check");
  await sendMessage(win, "共享窗口测试");
  await waitFor(popoutWin, 'document.body.innerText.includes("共享窗口测试")', 3000);
  await waitFor(popoutWin, 'document.body.innerText.includes("共享窗口已经实时同步")', 10_000);
  await waitFor(win, 'document.body.innerText.includes("共享窗口已经实时同步")', 10_000);
  const popoutLayout = await popoutWin.webContents.executeJavaScript(`(async () => {
    const root = document.querySelector('#root');
    const sidebar = document.querySelector('.ynAgentSidebar');
    const transcript = document.querySelector('.ynAgentTranscript');
    const sidebarTopBefore = sidebar?.getBoundingClientRect().top ?? -1;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      bodyHasWindowClass: document.body.classList.contains('ynAgentWindowBody'),
      bodyOverflow: getComputedStyle(document.body).overflow,
      rootOverflow: root ? getComputedStyle(root).overflow : '',
      rootHeight: root?.getBoundingClientRect().height ?? 0,
      viewportHeight: window.innerHeight,
      windowScrollY: window.scrollY,
      sidebarTopBefore,
      sidebarTopAfter: sidebar?.getBoundingClientRect().top ?? -1
    };
  })()`);
  assert(popoutLayout.bodyHasWindowClass, "Agent popout did not activate the window viewport contract");
  assert(popoutLayout.bodyOverflow === "hidden", `Agent popout body overflow is ${popoutLayout.bodyOverflow}`);
  assert(popoutLayout.rootOverflow === "hidden", `Agent popout root overflow is ${popoutLayout.rootOverflow}`);
  assert(Math.abs(popoutLayout.rootHeight - popoutLayout.viewportHeight) <= 2, "Agent popout root is not viewport-bound");
  assert(popoutLayout.windowScrollY === 0, "Agent popout scrolled the outer document with the transcript");
  assert(Math.abs(popoutLayout.sidebarTopAfter - popoutLayout.sidebarTopBefore) <= 1, "Agent popout sidebar moved with transcript scrolling");
  await capturePaintedWindow(popoutWin, popoutScreenshot);
  popoutWin.close();
  await sendMessage(win, "关闭弹窗后继续测试 dock");
  await waitFor(win, 'document.body.innerText.includes("关闭弹窗后 dock 仍继续工作。")', 10_000);
  mark("popout-shared-live-state");

  const compactionBootstrap = await service.bootstrap(workspace);
  assert(compactionBootstrap.activeSessionId, "Native Pi compaction verifier has no active session");
  await service.disposeWorkspace(workspace);
  const compactionSession = await new PiSessionRepository(workspace).open(compactionBootstrap.activeSessionId);
  for (let index = 0; index < 30; index += 1) {
    await compactionSession.appendMessage({
      role: "custom",
      customType: "verifier-memory-seed",
      content: `memory-${index}: ${"persistent context ".repeat(450)}`,
      display: false,
      details: { verifier: true, index },
      timestamp: Date.now() + index
    });
  }
  await setComposerValue(win, "/");
  await waitFor(win, 'document.querySelector("[data-agent-slash-command=compact]")');
  await submitComposer(win, "/compact");
  await waitFor(win, `(() => {
    const button = document.querySelector('[data-agent-compact-button=true]');
    const textarea = document.querySelector('#agentChatReactRoot textarea');
    const close = document.querySelector('.ynAgentTopbar button[aria-label="Close Agent"]');
    const stop = document.querySelector('#agentChatReactRoot .ynAgentInputStop, #agentChatReactRoot .ynAgentSubagentStop');
    return button?.disabled === true && textarea?.disabled === true && close?.disabled === true && !stop;
  })()`, 1_000);
  await waitFor(win, 'document.querySelector("[data-agent-compaction-result=true]")', 15_000);
  const compactionUi = await win.webContents.executeJavaScript(`(() => {
    const notice = document.querySelector('[data-agent-compaction-result=true]');
    const transcript = document.querySelector('.ynAgentTranscript')?.innerText || '';
    return {
      notice: (notice?.textContent || '').trim(),
      inputEnabled: document.querySelector('#agentChatReactRoot textarea')?.disabled === false,
      hiddenSeedLeaked: transcript.includes('verifier-memory-seed') || transcript.includes('persistent context')
    };
  })()`);
  assert(compactionUi.notice.includes("Compacted") && compactionUi.notice.includes("saved"), "Pi-web compaction result is missing token savings");
  assert(compactionUi.inputEnabled, "Agent input did not recover after native Pi compaction");
  assert(!compactionUi.hiddenSeedLeaked, "Hidden native Pi memory seed leaked into the transcript");
  const compactionState = await service.getRunState(workspace, compactionBootstrap.activeSessionId);
  assert(!compactionState.compacting && compactionState.lastCompaction, "Native Pi compaction did not reach a terminal result");
  assert(
    compactionState.lastCompaction.tokensBefore > compactionState.lastCompaction.estimatedTokensAfter,
    `Native Pi compaction did not reduce context: ${JSON.stringify(compactionState.lastCompaction)}`
  );
  assert(compactionState.contextUsage?.tokens === compactionState.lastCompaction.estimatedTokensAfter, "Context telemetry does not match the native Pi compaction result");
  const compactedSession = await new PiSessionRepository(workspace).open(compactionBootstrap.activeSessionId);
  const compactionEntries = (await compactedSession.getBranch()).filter((entry) => entry.type === "compaction");
  assert(compactionEntries.length === 1, `Expected one native Pi JSONL compaction entry, found ${compactionEntries.length}`);
  await capturePaintedWindow(win, compactionScreenshot);
  await waitFor(win, '!document.querySelector("[data-agent-compaction-result=true]")', 4_000);
  mark("compaction-notice-dismissed");
  mark("native-compaction");

  // Re-open a real folder child after the native compaction run. This is the
  // product-path acceptance for the route that previously sent a folder path
  // as a file: the embedded prompt starts the native file-level batch, and the
  // two configured child providers write the two manifest candidates.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "folder_ui_inspect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("runTranslationSubagents", {}, { id: "folder_ui_subagents" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("文件级子任务正在运行，主 Agent 继续监控。")),
    fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}, { id: "folder_ui_validate" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("文件夹中的两个文件都已翻译并通过校验。"))
  ]);
  await submitComposer(win, "/new");
  await waitFor(win, 'document.querySelectorAll("[data-agent-message-role]").length === 0');
  // This section proves a fresh folder workflow can create both candidates. Earlier
  // verifier turns intentionally wrote the same temp artifacts; remove those fixture
  // outputs so the product's existing-work reuse audit is not bypassed or mistaken for
  // a first-run translation path.
  await Promise.all(["a", "b"].map((name) => (
    rm(path.join(workspace, "AI_translation", `${name}_translated.txt`), { force: true })
  )));
  await patchProjectState(workspace, {
    languagePair: "ja->zh-CN",
    style: "game",
    subagentEnabled: true,
    subagentCount: 2,
    reviewSubagentCount: 2,
    subagentProviderId: folderChildProviderId,
    subagentModelId: folderChild.getModel().id,
    glossaryCandidates: false,
    characterBible: false,
    split: true,
    splitSize: 2_000
  });
  await win.loadFile(folderHtmlPath);
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.readyState === "complete"');
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#translatePrompt")');
  const folderPromptClicked = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#translatePrompt");
    if (!button || typeof button.click !== "function") return false;
    button.click();
    return true;
  })()`);
  assert(folderPromptClicked, "Folder child translation prompt button was not clickable");
  try {
    await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#promptSettingsPanel")?.hidden === false');
  } catch (error) {
    const diagnostics = await win.webContents.executeJavaScript(`(() => {
      const child = document.querySelector("#fileFrame")?.contentWindow;
      const doc = child?.document;
      return {
        readyState: doc?.readyState,
        translateButton: Boolean(doc?.querySelector("#translatePrompt")),
        panel: doc?.querySelector("#promptSettingsPanel")?.outerHTML.slice(0, 300),
        panelHidden: doc?.querySelector("#promptSettingsPanel")?.hidden,
        childConsole: Boolean(child?.__ynAgentChatPiWebEmbedded)
      };
    })()`);
    throw new Error(`Folder prompt settings did not open: ${JSON.stringify(diagnostics)}; ${error instanceof Error ? error.message : String(error)}`);
  }
  await waitFor(win, `Boolean(document.querySelector("#fileFrame")?.contentWindow?.boundGlossaryPath?.())`, 3_000);
  expectTypedFolderAssetMetadata = true;
  const folderPromptApplied = await win.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    const marker = doc?.querySelector(".audit-marker");
    const button = doc?.querySelector("#applyPromptSettings");
    if (!marker || !button || typeof marker.click !== "function" || typeof button.click !== "function") return false;
    if (!marker.classList.contains("whitelisted")) marker.click();
    button.click();
    return true;
  })()`);
  assert(folderPromptApplied, "Folder prompt did not apply its typed project metadata");
  await waitFor(win, `document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")?.value.includes(${JSON.stringify("Source folder")})`, 3_000);
  await submitNestedComposer(win, "Source folder");
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.querySelectorAll("[data-agent-subagent-card=true]").length >= 2', 8_000);
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.body?.innerText.includes("文件夹中的两个文件都已翻译并通过校验。")', 15_000);
  await waitFor(win, '!document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot .ynAgentInputStop, #agentChatReactRoot .ynAgentSubagentStop")', 15_000);
  const folderTerminalProof = await win.webContents.executeJavaScript(`(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    return {
      cards: doc?.querySelectorAll("[data-agent-subagent-card=true]").length ?? -1,
      cardText: Array.from(doc?.querySelectorAll("[data-agent-subagent-card=true]") ?? [])
        .map((card) => card.textContent?.trim() ?? ""),
      final: doc?.body?.innerText.includes("文件夹中的两个文件都已翻译并通过校验。") ?? false
    };
  })()`);
  const folderUiBootstrap = await service.bootstrap(workspace);
  const folderUiMessages = folderUiBootstrap.activeSessionId
    ? await service.loadMessages(workspace, folderUiBootstrap.activeSessionId)
    : [];
  const folderUiToolNames = folderUiMessages.flatMap((message) => (
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((block) => (
        block.type === "toolCall" && typeof block.name === "string" ? [block.name] : []
      ))
      : []
  ));
  assert(
    !folderUiToolNames.includes("inspectTranslationAlignment")
      && !folderUiToolNames.includes("recordTranslationAlignmentChecks"),
    `Folder UI leaked serial chunk review back into the parent Pi transcript: ${JSON.stringify(folderUiToolNames)}`
  );
  assert(
    !folderUiToolNames.includes("selectSourceDocument"),
    "Concurrent folder chunk review must not mutate the parent active source selection"
  );
  const folderUiChildStates = folderUiMessages
    .filter((message) => message.role === "custom" && message.customType.startsWith("subagent."))
    .map((message) => message.details);
  const folderUiReviewCards = folderUiMessages.filter((message) => (
    message.role === "custom" && message.customType === "subagent.translation-review" && message.details?.closed
  ));
  const folderUiReviewedAssignments = folderUiReviewCards.reduce((sum, message) => (
    sum + (typeof message.details?.assignmentCount === "number" ? message.details.assignmentCount : 0)
  ), 0);
  assert(
    folderTerminalProof.cards === 2 + folderUiReviewCards.length
      && folderTerminalProof.final
      && folderUiReviewCards.length >= 1
      && folderUiReviewCards.length <= 2
      && folderUiReviewedAssignments === 2,
    `Folder UI terminal transcript lost its translation/review worker cards: ${JSON.stringify(folderTerminalProof)} children=${JSON.stringify(folderUiChildStates)}`);
  const folderUiCandidates = await Promise.all(["a", "b"].map(async (name) => {
    const candidate = path.join(workspace, "AI_translation", `${name}_translated.txt`);
    try {
      return { name, content: (await readFile(candidate, "utf8")).replace(/\r?\n$/, "") };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  assert(
    folderUiCandidates.every((entry) => entry.content === "翻译甲\n翻译乙"),
    `Folder UI batch wrote unexpected candidates: ${JSON.stringify(folderUiCandidates)} cards=${JSON.stringify(folderTerminalProof)} children=${JSON.stringify(folderUiChildStates)}`
  );
  assert(typedFolderAssetMetadataObserved, "Folder prompt metadata did not cross Electron IPC, Pi session, and the Host tool boundary");
  await capturePaintedWindow(win, folderBatchRunScreenshot);
  mark("folder-ui-batch-files");

  // Product-path existing-work acceptance: one ordinary line passes the Host
  // quick scan, one placeholder fails mechanically, and one suspiciously short
  // line alone reaches a native Pi audit child.
  await writeFile(
    folderFirstSourcePath,
    "原文甲\n原文乙\nこれは夕暮れ前に北の門を開けて合図を待つための長い指示です。",
    "utf8"
  );
  await writeFile(path.join(workspace, "AI_translation", "a_translated.txt"), "翻译甲\n（本段译文）\n打开北门", "utf8");
  await rm(path.join(workspace, "AI_translation", "b_translated.txt"), { force: true });
  await patchProjectState(workspace, { reuseExistingTranslation: true });
  // Start this acceptance flow with a fresh provider queue. A leftover faux
  // response would prove only that a tool bubble rendered, not that the
  // restarted Pi runtime executed the user's decision.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "reuse_ui_inspect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("prepareTranslationReuseAudit", {}, { id: "reuse_ui_prepare" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("runTranslationReuseAudit", {}, { id: "reuse_ui_run" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("正在审计快速检查标出的高风险译文；完成后会请你确认保留范围。")),
    fauxAssistantMessage(fauxText("高风险译文语义审计完成。是否保留通过的行并只重译不合格行？"))
  ]);
  const reuseDecisionResponses = () => [
    fauxAssistantMessage(fauxToolCall("resumeYnWorkflow", {}, { id: "reuse_ui_resume" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("resumeYnWorkflow", {}, { id: "reuse_ui_resume_again" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("applyTranslationReuseDecision", {
      decision: "reuse_accepted"
    }, { id: "reuse_ui_apply" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("已保留通过审计的译文，并把不合格行交给续跑修复。"))
  ];
  const reuseSessionCountBefore = await win.webContents.executeJavaScript(
    'document.querySelector("#fileFrame")?.contentDocument?.querySelectorAll(".ynAgentSessionItem").length ?? 0'
  );
  const reuseSession = await service.createSession(workspace);
  await waitFor(win, `(() => {
    const doc = document.querySelector("#fileFrame")?.contentDocument;
    return doc?.querySelectorAll("[data-agent-message-role]").length === 0
      && doc?.querySelectorAll(".ynAgentSessionItem").length === ${Number(reuseSessionCountBefore) + 1}
      && Boolean(doc?.querySelector(".ynAgentSessionItemActive"));
  })()`);
  await waitFor(win, `(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    const textarea = child?.document?.querySelector("#agentChatReactRoot textarea");
    return Boolean(child?.__ynAgentChatPiWebEmbedded?.insertText && textarea && !textarea.disabled);
  })()`);
  const reusePromptInserted = await win.webContents.executeJavaScript(`(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    if (!child?.__ynAgentChatPiWebEmbedded?.insertText) return false;
    child.__ynAgentChatPiWebEmbedded.insertText(${JSON.stringify(folderBatchPrompt.replace("Existing translation: discard and retranslate", "Existing translation: audit and reuse"))}, ${JSON.stringify({
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      reuseExistingTranslation: true,
      subagentEnabled: true,
      subagentCount: 2,
      translationSplitSize: 2000
    })});
    return true;
  })()`);
  assert(reusePromptInserted, "New-session product input bridge rejected the reuse workflow prompt");
  await waitFor(win, `document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")?.value.includes(${JSON.stringify("Source folder")})`);
  await waitFor(win, `(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector('#agentChatReactRoot button[aria-label="Send"]');
    return Boolean(button && !button.disabled);
  })()`);
  await submitNestedComposer(win, "Source folder");
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.body?.innerText.includes("是否保留通过的行")', 15_000);
  const reuseAuditCardCount = await win.webContents.executeJavaScript(
    'document.querySelector("#fileFrame")?.contentDocument?.querySelectorAll("[data-agent-subagent-card=true]").length ?? 0'
  );
  assert(reuseAuditCardCount === 1, `Expected only the one high-risk reuse range to reach a Pi child, found ${reuseAuditCardCount}`);
  const reuseIdleDeadline = Date.now() + 5_000;
  let reuseRunState = await service.getRunState(workspace, reuseSession.id);
  while (reuseRunState.running && Date.now() < reuseIdleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    reuseRunState = await service.getRunState(workspace, reuseSession.id);
  }
  assert(!reuseRunState.running, `Reuse decision prompt did not settle before restart: ${JSON.stringify(reuseRunState)}`);
  await win.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector("#fileFrame")?.contentDocument?.querySelector(".ynAgentTranscript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  })()`);
  await capturePaintedWindow(win, translationReuseDecisionScreenshot);
  assert(
    (await readFile(path.join(workspace, "AI_translation", "a_translated.txt"), "utf8")).replace(/\r\n/g, "\n") === "翻译甲\n（本段译文）\n打开北门",
    "Reuse audit changed the candidate before the user decision"
  );
  // Mirror the product close path: suspend before disposing the live Pi
  // runtime. The following UI turn must rehydrate and explicitly resume the
  // same JSONL session and persisted audit.
  await service.suspendWorkspace(workspace);
  await service.disposeWorkspace(workspace);
  faux.setResponses(reuseDecisionResponses());
  assert(faux.getPendingResponseCount() === 4, "Restart verifier did not arm the idempotent resume and decision tool responses");
  await win.webContents.executeJavaScript(`(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    const textarea = child?.document?.querySelector("#agentChatReactRoot textarea");
    const setter = Object.getOwnPropertyDescriptor(child.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "保留通过的行");
    textarea.dispatchEvent(new child.InputEvent("input", { bubbles: true, inputType: "insertText", data: "保留通过的行" }));
    child.document.querySelector('#agentChatReactRoot button[aria-label="Send"]')?.click();
  })()`);
  const reuseCandidatePath = path.join(workspace, "AI_translation", "a_translated.txt");
  let reuseCandidateLines: string[] = [];
  const reuseApplyDeadline = Date.now() + 15_000;
  while (Date.now() < reuseApplyDeadline) {
    reuseCandidateLines = (await readFile(reuseCandidatePath, "utf8")).replace(/\r\n/g, "\n").split("\n");
    if (reuseCandidateLines[0] === "翻译甲" && reuseCandidateLines[1] === "" && reuseCandidateLines[2] === "") break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const reuseBootstrap = await service.bootstrap(workspace);
  const reuseMessages = reuseBootstrap.activeSessionId
    ? await service.loadMessages(workspace, reuseBootstrap.activeSessionId)
    : [];
  const reuseApplyResult = reuseMessages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "reuse_ui_apply"
  ));
  const reuseResumeResult = reuseMessages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "reuse_ui_resume"
  ));
  const repeatedReuseResumeResult = reuseMessages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "reuse_ui_resume_again"
  ));
  assert(
    reuseResumeResult?.role === "toolResult" && !reuseResumeResult.isError,
    `Restarted reuse workflow did not explicitly resume before mutation: ${JSON.stringify(reuseResumeResult)}`
  );
  assert(
    repeatedReuseResumeResult?.role === "toolResult"
      && !repeatedReuseResumeResult.isError
      && repeatedReuseResumeResult.details?.status === "already_active",
    `Repeated resume was not an idempotent active-workflow success: ${JSON.stringify(repeatedReuseResumeResult)}`
  );
  assert(
    reuseCandidateLines[0] === "翻译甲" && reuseCandidateLines[1] === "" && reuseCandidateLines[2] === "",
    `Existing-work reuse decision did not preserve only the accepted line for sparse resume: candidate=${JSON.stringify(reuseCandidateLines)} result=${JSON.stringify(reuseApplyResult)} messages=${JSON.stringify(reuseMessages.map((message) => ({ role: message.role, ...message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, content: message.content } : message.role === "assistant" ? { stopReason: message.stopReason, content: message.content } : {} })))}`
  );
  assert(
    reuseApplyResult?.role === "toolResult" && !reuseApplyResult.isError,
    `Existing-work reuse decision did not persist a successful paired tool result: ${JSON.stringify(reuseApplyResult)}`
  );
  const reuseFinalState = await service.getRunState(workspace, reuseSession.id);
  if (reuseFinalState.running) await service.abort(workspace, reuseSession.id);
  await patchProjectState(workspace, { reuseExistingTranslation: false });
  mark("translation-reuse-ui-decision");

  await win.loadFile(epubHtmlPath);
  await waitFor(win, 'document.querySelector("#saveTxt") && document.querySelector("#exportEpub")');
  await clickSelector(win, "#openAgentChat");
  await waitFor(win, 'document.querySelector("#agentChatReactRoot textarea")');
  const epubEditContract = await win.webContents.executeJavaScript(`(() => ({
    saveVisible: document.querySelector("#saveTxt")?.hidden === false,
    exportVisible: document.querySelector("#exportEpub")?.hidden === false,
    target: typeof boundTranslationPath === "function" ? boundTranslationPath() : "",
    agentSourcePath: window.__ynAgentChatPiWebEmbedded?.route?.sourcePath || ""
  }))()`);
  assert(epubEditContract.saveVisible && epubEditContract.exportVisible,
    `EPUB line review did not expose both TXT save and EPUB export: ${JSON.stringify(epubEditContract)}`);
  assert(epubEditContract.target === epubEditableTranslationPath,
    `EPUB line review bound the wrong editable TXT: ${JSON.stringify(epubEditContract)}`);
  assert(epubEditContract.agentSourcePath === epubExtractedSourcePath,
    `EPUB Agent route did not bind the extracted source TXT: ${JSON.stringify(epubEditContract)}`);
  await writeFile(path.join(workspace, ".translation-workshop", "project.json"), JSON.stringify({
    sourceKind: "file",
    sourcePath: epubOriginalSourcePath,
    languagePair: "ja->zh-CN"
  }), "utf8");
  expectEpubHostBinding = true;
  // The EPUB binding scenario is a different task. Keep the suspended folder
  // workflow in its original Pi session and create the same clean boundary the
  // product's New button provides instead of silently reusing it.
  const epubSession = await service.createSession(workspace);
  await waitFor(win, 'document.querySelectorAll("#agentChatReactRoot [data-agent-message-role]").length === 0');
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("inspectTranslationContext", {}, { id: "tool_epub_inspect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("EPUB extracted Host inspect passed."))
  ]);
  await sendMessage(win, "Inspect the bound EPUB review text.");
  await waitFor(win, 'document.querySelector("#agentChatReactRoot")?.textContent?.includes("EPUB extracted Host inspect passed.")', 10_000);
  const epubMessages = await service.loadMessages(workspace, epubSession.id);
  const epubInspectResult = epubMessages.find((message) => (
    message.role === "toolResult" && message.toolCallId === "tool_epub_inspect"
  ));
  assert(epubHostBindingObserved, "EPUB page prompt did not reach the Host with its extracted TXT binding");
  assert(epubInspectResult?.role === "toolResult" && !epubInspectResult.isError,
    `EPUB Host inspection failed: ${JSON.stringify(epubInspectResult)}`);
  assert((epubInspectResult.details as { sourcePath?: string } | undefined)?.sourcePath === epubExtractedSourcePath,
    `EPUB Host inspection resolved the wrong source: ${JSON.stringify(epubInspectResult?.details)}`);
  mark("epub-editable-txt-binding");

  console.log(JSON.stringify({
    ok: true,
    interactiveMs,
    optimisticMs: Number(optimisticMs.toFixed(1)),
    screenshots: [folderAgentScreenshot, folderBatchRunScreenshot, translationReuseDecisionScreenshot, commandsScreenshot, interfaceImageScreenshot, progressScreenshot, providerRetryScreenshot, streamScreenshot, subagentInteractionScreenshot, subagentRepliesScreenshot, completeScreenshot, providerSettingsScreenshot, popoutScreenshot, compactionScreenshot],
    folderIframeAgent: true,
    folderManifestInspect: true,
    folderNativeBatchFiles: true,
    folderBatchDocuments: ["a.txt", "b.txt"],
    folderChildPromptBinding: true,
    folderUiBatchFiles: true,
    folderTypedMetadataThroughHost: true,
    translationReuseUiDecision: true,
    translationReuseRestartDecision: true,
    folderTabRequestContract: true,
    generatedGlossaryOneClickImport: true,
    epubEditableTxtBinding: true,
    epubHostExtractedSourceBinding: true,
    boundedReproofreadReplacement: true,
    nativePiEvents: true,
    rawProtocolLeak: false,
    duplicateToolBubble: false,
    pairedToolResult: true,
    subagentCards: 4,
    subagentModelsVisible: true,
    subagentFollowParentReset: true,
    subagentRepliesVisible: childReplyProofs.length === 2,
    subagentReplyCardsVerified: childReplyProofs.map((proof) => proof.label),
    parentDuringChildrenMs: Number(parentDuringChildrenMs.toFixed(1)),
    parentAnsweredBeforeChildren: true,
    parentInteractionExactlyOnce: true,
    parentInteractionOrderStable: true,
    perChunkReviewWorker: true,
    reviewedChunkCount: folderUiReviewCards.length,
    folderConcurrentReviewWithoutSourceSwitch: true,
    clipboardNativeVerified,
    hostCompletionGate: true,
    hiddenCustomLeak: false,
    errorTranscriptPreserved: true,
    providerAutoRetry: true,
    providerAutoRetryAbortable: true,
    terminalStateConvergence: true,
    sessionFileDeleted: true,
    inactiveDeletePreserved: true,
    liveYnInterfaceContext: true,
    sourceRowAgentQuestion: true,
    externalReferenceRead: true,
    nativePiImageInput: true,
    providerModelIdsMultiline: multilineModelIds === "opencode-main\n",
    dynamicGpt56Catalog: true,
    popoutInteractiveMs: Number(popoutInteractiveMs.toFixed(1)),
    popoutSharedLiveState: true,
    popoutClosePreservedDock: true,
    nativePiCompaction: true,
    compactionJsonlEntry: true,
    compactionContextTelemetry: true
  }));
}

void app.whenReady().then(run).catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (win && !win.isDestroyed()) {
    await win.webContents.executeJavaScript(`(() => {
      const doc = document.querySelector("#fileFrame")?.contentDocument || document;
      return {
        url: location.href,
        cards: doc.querySelectorAll("[data-agent-subagent-card=true]").length,
        messages: doc.querySelectorAll("[data-agent-message-role]").length,
        text: doc.body?.innerText?.slice(-5000) || ""
      };
    })()`).then((state) => console.error(`Failure UI state: ${JSON.stringify(state)}`)).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy();
  if (folderWin && !folderWin.isDestroyed()) folderWin.destroy();
  if (popoutWin && !popoutWin.isDestroyed()) popoutWin.destroy();
  await service.disposeWorkspace(workspace).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  await rm(externalReferenceDir, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
