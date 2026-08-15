import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
  type ToolResultMessage
} from "@earendil-works/pi-ai";

import { readOAuthProfiles, writeOAuthProfiles } from "../src/main/agent/oauthProfilesStore.ts";
import { createPiModelSelection } from "../src/main/agent/piNative/providerRegistry.ts";
import {
  PiNativeSessionService,
  type PiNativeSessionServiceOptions
} from "../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../src/main/agent/piNative/sessionRepository.ts";
import { MAX_ASSIGNED_TRANSLATION_CHUNK_LINES } from "../src/main/agent/piNative/subagentRunner.ts";
import type { YnSubagentBatchSnapshot } from "../src/main/agent/piNative/subagentSupervisor.ts";
import { buildYnSystemPrompt } from "../src/main/agent/piNative/systemPrompt.ts";
import { createYnDomainTools } from "../src/main/agent/piNative/ynDomainTools.ts";
import { resolveTranslationCandidatePath } from "../src/main/agent/writeTranslationChunk.ts";
import { resolvePiSourceManifest } from "../src/main/agent/piNative/sourceManifest.ts";
import { resolveBatchReviewChildForUpgrade } from "../src/main/batchReviewUpgradePaths.ts";
import {
  readProviderConfig,
  updateProviderConfig,
  writeProviderConfig
} from "../src/main/agent/providerConfigStore.ts";
import { registerAgentProviderIpc } from "../src/main/ipc/agentProviderHandlers.ts";
import { registerAgentSessionIpc } from "../src/main/ipc/agentSessionHandlers.ts";
import { upgradeLegacyReviewHtmlTree } from "../src/main/reviewHtmlUpgrade.ts";
import { getProviderPreset } from "../src/shared/agent/providerPresets.ts";
import { renderLineReviewHtml } from "../src/shared/core/html.ts";
import { embeddedBatchLineReviewFiles } from "../src/shared/core/legacyHtml.ts";
import { buildPrompt, buildTranslatePrompt } from "../src/shared/core/prompts.ts";
import {
  splitTextLines,
  validateTranslationCandidate
} from "../src/shared/validation/translationValidator.ts";

const root = process.cwd();
const sourceRoot = requiredEnv("YN_REAL_FOLDER_ROOT");
const batchHtmlPath = requiredEnv("YN_REAL_FOLDER_HTML");
const sessionPath = requiredEnv("YN_REAL_FOLDER_SESSION");
const electronRuntimeDir = requiredEnv("YN_REAL_FOLDER_ELECTRON_RUNTIME");
const realProviderMode = process.env.YN_REAL_FOLDER_PROVIDER_MODE === "real";
const providerConfigSource = path.resolve(process.env.YN_REAL_FOLDER_PROVIDER_CONFIG_WORKSPACE || sourceRoot);
const realProviderId = String(process.env.YN_REAL_FOLDER_PROVIDER_ID || "openai-chatgpt").trim();
const realModelId = String(process.env.YN_REAL_FOLDER_MODEL_ID || "gpt-5.6-luna").trim();
const keepTemporaryOutput = /^(1|true|yes)$/i.test(String(process.env.YN_REAL_FOLDER_KEEP_TEMP || ""));
const workerCount = Number(process.env.YN_REAL_FOLDER_WORKERS ?? "5");
if (!Number.isInteger(workerCount) || workerCount < 1) {
  throw new Error(`YN_REAL_FOLDER_WORKERS must be a positive integer, received ${process.env.YN_REAL_FOLDER_WORKERS}.`);
}
const workspace = await mkdtemp(path.join(os.tmpdir(), "yn-real-folder-history-"));
const controlledHtmlPath = path.join(workspace, "controlled-folder-review.html");
const artifactsDir = path.join(root, "artifacts");
const routeScreenshot = path.join(artifactsDir, "electron-agent-real-folder-route.png");
const batchScreenshot = path.join(artifactsDir, "electron-agent-real-folder-batch.png");
const completionScreenshot = path.join(artifactsDir, "electron-agent-real-folder-complete.png");
const currentFlow = "pi-web-react-embedded-v10";
const legacyFlow = "pi-web-react-embedded-v7";
const currentFolderRoute = 'paths.promptSourceKind === "folder" || paths.sourceKind === "folder" ? "folder" : "file"';
const legacyFolderRoute = 'paths.sourceKind === "folder" ? "folder" : "file"';
const realFolderTargetMs = 1_200_000;
const realFolderHardDeadlineMs = 1_320_000;
const requestedRealFolderTimeoutMs = Number(process.env.YN_REAL_FOLDER_TIMEOUT_MS || realFolderTargetMs);
if (
  realProviderMode
  && (
    !Number.isFinite(requestedRealFolderTimeoutMs)
    || requestedRealFolderTimeoutMs < realFolderTargetMs
    || requestedRealFolderTimeoutMs > realFolderHardDeadlineMs
  )
) {
  throw new Error(`YN_REAL_FOLDER_TIMEOUT_MS must be between ${realFolderTargetMs} and ${realFolderHardDeadlineMs}, received ${process.env.YN_REAL_FOLDER_TIMEOUT_MS}.`);
}
const batchTimeoutMs = realProviderMode ? requestedRealFolderTimeoutMs : 120_000;

app.disableHardwareAcceleration();
app.setPath("userData", path.join(electronRuntimeDir, "user-data"));
app.setPath("cache", path.join(electronRuntimeDir, "cache"));
app.on("window-all-closed", () => mark("window-all-closed-during-verification"));

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function mark(stage: string): void {
  console.log(`[electron-real-folder] ${stage}`);
}

function revealVerificationWindow(target: BrowserWindow): void {
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS === "1") return;
  target.show();
  target.focus();
}

function providerWorkspaceDir(value: string): string {
  return path.basename(value).toLowerCase() === ".translation-workshop"
    ? value
    : path.join(value, ".translation-workshop");
}

async function prepareRealProvider(): Promise<void> {
  const sourceWorkspace = providerWorkspaceDir(providerConfigSource);
  const targetWorkspace = path.join(workspace, ".translation-workshop");
  await mkdir(targetWorkspace, { recursive: true });
  const sourceConfig = await readProviderConfig(sourceWorkspace);
  const provider = sourceConfig.providers[realProviderId];
  assert(provider, `Provider ${realProviderId} is not configured in the selected project.`);
  await writeProviderConfig(targetWorkspace, sourceConfig);
  await writeOAuthProfiles(targetWorkspace, await readOAuthProfiles(sourceWorkspace));
  try {
    const project = JSON.parse(await readFile(path.join(sourceWorkspace, "project.json"), "utf8")) as {
      agentProxyEnabled?: boolean;
      agentProxyUrl?: string;
    };
    await writeFile(path.join(targetWorkspace, "project.json"), JSON.stringify({
      agentProxyEnabled: project.agentProxyEnabled === true,
      agentProxyUrl: typeof project.agentProxyUrl === "string" ? project.agentProxyUrl : ""
    }, null, 2), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await updateProviderConfig(targetWorkspace, {
    activeProviderId: realProviderId,
    provider: { ...provider, model: realModelId }
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

async function waitFor(win: BrowserWindow, expression: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

interface RendererBatchSignal {
  missing?: boolean;
  timeout?: boolean;
  sendAt: number;
  userSeenAt: number;
  cardsSeenAt: number;
  terminalAt: number;
  cards: number;
  complete: boolean;
  failureText: string;
}

async function installRendererBatchSignal(
  win: BrowserWindow,
  expectedCards: number,
  timeoutMs: number
): Promise<void> {
  const installed = await win.webContents.executeJavaScript(`(() => {
    const prior = window.__ynElectronBatchSignal;
    prior?.observer?.disconnect();
    if (prior?.timeoutId) clearTimeout(prior.timeoutId);
    const state = {
      sendAt: 0,
      userSeenAt: 0,
      cardsSeenAt: 0,
      terminalAt: 0,
      cards: 0,
      complete: false,
      failureText: "",
      scheduled: false,
      observer: null,
      timeoutId: 0,
      promise: null,
      resolve: null
    };
    state.promise = new Promise((resolve) => { state.resolve = resolve; });
    const snapshot = (extra = {}) => ({
      sendAt: state.sendAt,
      userSeenAt: state.userSeenAt,
      cardsSeenAt: state.cardsSeenAt,
      terminalAt: state.terminalAt,
      cards: state.cards,
      complete: state.complete,
      failureText: state.failureText,
      ...extra
    });
    const finish = (extra = {}) => {
      state.observer?.disconnect();
      if (state.timeoutId) clearTimeout(state.timeoutId);
      state.resolve?.(snapshot(extra));
    };
    const inspect = () => {
      state.scheduled = false;
      const root = document.querySelector("#agentChatReactRoot");
      if (!root) return;
      const now = performance.now();
      if (!state.userSeenAt && root.querySelector('[data-agent-message-role="user"]')) state.userSeenAt = now;
      const cards = [...root.querySelectorAll('[data-agent-subagent-card="true"]')];
      state.cards = cards.length;
      if (!state.cardsSeenAt && cards.length === ${expectedCards}) state.cardsSeenAt = now;
      const assistants = [...root.querySelectorAll('[data-agent-message-role="assistant"]')];
      const allWorkersCompleted = cards.length === ${expectedCards} && cards.every((card) => (
        (card.textContent || "").includes("已关闭 · completed")
      ));
      const failedWorker = cards.find((card) => /已关闭 · (failed|stopped|skipped)/i.test(card.textContent || ""));
      const hasFinalValidation = Boolean(root.querySelector('[data-agent-tool-call="validateTranslationArtifact"]'));
      if (${JSON.stringify(realProviderMode)}) {
        state.failureText = failedWorker?.textContent || "";
        state.complete = allWorkersCompleted && hasFinalValidation;
      } else {
        const failure = assistants.find((node) => (node.textContent || "").includes("REAL_FOLDER_BATCH_FAILED"));
        state.failureText = failure?.textContent || "";
        state.complete = assistants.some((node) => (node.textContent || "").includes("REAL_FOLDER_BATCH_COMPLETE"));
      }
      const stopVisible = [...root.querySelectorAll("button")]
        .some((button) => (button.textContent || "").includes("Stop"));
      if ((state.failureText || state.complete) && cards.length === ${expectedCards} && !stopVisible) {
        state.terminalAt = now;
        finish();
      }
    };
    const scheduleInspect = () => {
      if (state.scheduled) return;
      state.scheduled = true;
      requestAnimationFrame(inspect);
    };
    state.observer = new MutationObserver(scheduleInspect);
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    state.timeoutId = setTimeout(() => finish({ timeout: true }), ${timeoutMs});
    window.__ynElectronBatchSignal = state;
    scheduleInspect();
    return true;
  })()`);
  assert(installed, "Could not install the event-driven renderer batch signal.");
}

async function awaitRendererBatchSignal(win: BrowserWindow): Promise<RendererBatchSignal> {
  return win.webContents.executeJavaScript(`(() => {
    const state = window.__ynElectronBatchSignal;
    return state?.promise || Promise.resolve({ missing: true });
  })()`);
}

interface ElectronResourceSample {
  elapsedMs: number;
  rendererWorkingSetMb: number;
  rendererPrivateMb: number;
  totalWorkingSetMb: number;
  runtimeEvents: number;
}

interface RendererResourceProbe {
  maxEventLoopLagMs: number;
  ticks: number;
  rendererJsHeapUsedMb: number;
  rendererJsHeapTotalMb: number;
  domNodes: number;
  agentMessages: number;
  subagentCards: number;
  expandedSubagentCards: number;
}

function workingSetMb(kibibytes: number | undefined): number {
  return (kibibytes ?? 0) / 1024;
}

async function sampleElectronResources(
  win: BrowserWindow,
  startedAt: number,
  runtimeEvents: number
): Promise<ElectronResourceSample> {
  const rendererPid = win.webContents.getOSProcessId();
  const metrics = app.getAppMetrics();
  const rendererMetric = metrics.find((metric) => metric.pid === rendererPid);
  return {
    elapsedMs: performance.now() - startedAt,
    rendererWorkingSetMb: workingSetMb(rendererMetric?.memory?.workingSetSize),
    rendererPrivateMb: workingSetMb(rendererMetric?.memory?.privateBytes),
    totalWorkingSetMb: metrics.reduce((total, metric) => total + workingSetMb(metric.memory?.workingSetSize), 0),
    runtimeEvents
  };
}

async function installRendererResourceProbe(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(() => {
    const existing = window.__ynElectronResourceProbe;
    if (existing?.timer) clearInterval(existing.timer);
    const intervalMs = 50;
    const state = {
      lastTick: performance.now(),
      maxEventLoopLagMs: 0,
      ticks: 0,
      timer: 0
    };
    state.timer = setInterval(() => {
      const now = performance.now();
      state.maxEventLoopLagMs = Math.max(state.maxEventLoopLagMs, now - state.lastTick - intervalMs);
      state.lastTick = now;
      state.ticks += 1;
    }, intervalMs);
    window.__ynElectronResourceProbe = state;
  })()`);
}

async function stopRendererResourceProbe(win: BrowserWindow): Promise<RendererResourceProbe> {
  const renderer = await win.webContents.executeJavaScript(`(() => {
    const state = window.__ynElectronResourceProbe;
    if (state?.timer) clearInterval(state.timer);
    delete window.__ynElectronResourceProbe;
    const memory = performance.memory;
    return {
      maxEventLoopLagMs: state?.maxEventLoopLagMs || 0,
      ticks: state?.ticks || 0,
      jsHeapUsedBytes: memory?.usedJSHeapSize || 0,
      jsHeapTotalBytes: memory?.totalJSHeapSize || 0,
      domNodes: document.getElementsByTagName("*").length,
      agentMessages: document.querySelectorAll("[data-agent-message-role]").length,
      subagentCards: document.querySelectorAll("[data-agent-subagent-card=true]").length,
      expandedSubagentCards: document.querySelectorAll("[data-agent-subagent-expanded=true]").length
    };
  })()`) as {
    maxEventLoopLagMs: number;
    ticks: number;
    jsHeapUsedBytes: number;
    jsHeapTotalBytes: number;
    domNodes: number;
    agentMessages: number;
    subagentCards: number;
    expandedSubagentCards: number;
  };
  return {
    maxEventLoopLagMs: renderer.maxEventLoopLagMs,
    ticks: renderer.ticks,
    rendererJsHeapUsedMb: renderer.jsHeapUsedBytes / (1024 * 1024),
    rendererJsHeapTotalMb: renderer.jsHeapTotalBytes / (1024 * 1024),
    domNodes: renderer.domNodes,
    agentMessages: renderer.agentMessages,
    subagentCards: renderer.subagentCards,
    expandedSubagentCards: renderer.expandedSubagentCards
  };
}

async function startResourceSampler(
  win: BrowserWindow,
  readRuntimeEvents: () => number
): Promise<{
  samples: ElectronResourceSample[];
  renderer?: RendererResourceProbe;
  stop: () => Promise<void>;
}> {
  const samples: ElectronResourceSample[] = [];
  const startedAt = performance.now();
  let running = true;
  await installRendererResourceProbe(win);
  const result: {
    samples: ElectronResourceSample[];
    renderer?: RendererResourceProbe;
    stop: () => Promise<void>;
  } = {
    samples,
    async stop() {
      running = false;
      await task;
      result.renderer = await stopRendererResourceProbe(win);
    }
  };
  const task = (async () => {
    while (running && !win.isDestroyed()) {
      samples.push(await sampleElectronResources(win, startedAt, readRuntimeEvents()));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return result;
}

async function capture(win: BrowserWindow, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
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

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function hashFiles(filePaths: string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(filePaths.map(async (filePath) => [filePath, await sha256File(filePath)] as const)));
}

function assertHashesEqual(before: Map<string, string>, after: Map<string, string>): void {
  assert(before.size === after.size, "The real source document set changed during the Electron replay.");
  for (const [filePath, hash] of before) {
    assert(after.get(filePath) === hash, `The real source document changed during the Electron replay: ${filePath}`);
  }
}

async function assertPathMissing(targetPath: string): Promise<void> {
  try {
    await access(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Temporary verifier output still exists after cleanup: ${targetPath}`);
}

async function prepareLegacyBatchFixture(): Promise<{ parentPath: string; childPaths: string[] }> {
  const parentHtml = await readFile(batchHtmlPath, "utf8");
  const files = embeddedBatchLineReviewFiles(parentHtml);
  assert(files?.length, "The real batch HTML does not contain child review files.");
  const fixtureHtmlDir = path.join(workspace, "legacy-upgrade-fixture", ".translation-workshop", "html");
  const parentPath = path.join(fixtureHtmlDir, path.basename(batchHtmlPath));
  await mkdir(fixtureHtmlDir, { recursive: true });
  await writeFile(parentPath, parentHtml, "utf8");

  const childPaths = await Promise.all(files.map(async (file, index) => {
    assert(file.outputPath, `The real batch child ${index + 1} has no HTML output path.`);
    const actualChildPath = await resolveBatchReviewChildForUpgrade(batchHtmlPath, file.outputPath);
    const fixtureChildCandidate = path.resolve(path.dirname(parentPath), file.outputPath);
    const currentChild = await readFile(actualChildPath, "utf8");
    assert(currentChild.includes(currentFlow), `The real batch child ${index + 1} is not current v9 HTML.`);
    assert(currentChild.includes(currentFolderRoute), `The real batch child ${index + 1} lacks the current folder route.`);
    const legacyChild = currentChild
      .replaceAll(currentFlow, legacyFlow)
      .replaceAll(currentFolderRoute, legacyFolderRoute);
    assert(legacyChild.includes(legacyFlow) && legacyChild.includes(legacyFolderRoute), `Could not reconstruct the real v7 child ${index + 1}.`);
    await mkdir(path.dirname(fixtureChildCandidate), { recursive: true });
    await writeFile(fixtureChildCandidate, legacyChild, "utf8");
    const fixtureChildPath = await resolveBatchReviewChildForUpgrade(parentPath, file.outputPath);
    return fixtureChildPath;
  }));
  return { parentPath, childPaths };
}

function messageToolCalls(context: Context, name: string): number {
  return context.messages.reduce((count, message) => {
    if (message.role !== "assistant") return count;
    return count + message.content.filter((block) => block.type === "toolCall" && block.name === name).length;
  }, 0);
}

function toolResults(context: Context, name: string): ToolResultMessage[] {
  return context.messages.filter(
    (message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === name
  );
}

function hasAssistantText(context: Context, marker: string): boolean {
  return context.messages.some((message) => message.role === "assistant" && message.content.some(
    (block) => block.type === "text" && block.text.includes(marker)
  ));
}

function parseToolJson(message: ToolResultMessage): Record<string, unknown> {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

function successfulToolCalls(context: Context, name: string): Array<Record<string, unknown>> {
  const successfulIds = new Set(toolResults(context, name)
    .filter((result) => !result.isError)
    .map((result) => result.toolCallId));
  return context.messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    return message.content.flatMap((block) => block.type === "toolCall"
      && block.name === name
      && successfulIds.has(block.id)
      ? [block.arguments]
      : []);
  });
}

function assignedRange(context: Context): { fromLine: number; toLine: number } {
  const description = context.tools?.find((tool) => tool.name === "readAssignedSource")?.description ?? "";
  const match = /L(\d+)-L(\d+)/.exec(description);
  if (!match) throw new Error(`Could not resolve the assigned source range from: ${description}`);
  return { fromLine: Number(match[1]), toLine: Number(match[2]) };
}

function nextUnwrittenChunk(context: Context): { fromLine: number; toLine: number } | undefined {
  const assignment = assignedRange(context);
  const written = successfulToolCalls(context, "writeAssignedTranslation");
  let fromLine = assignment.fromLine;
  while (fromLine <= assignment.toLine) {
    const covered = written.some((input) => Number(input.fromLine) <= fromLine && Number(input.toLine) >= fromLine);
    if (!covered) break;
    fromLine += 1;
  }
  if (fromLine > assignment.toLine) return undefined;
  return {
    fromLine,
    toLine: Math.min(assignment.toLine, fromLine + MAX_ASSIGNED_TRANSLATION_CHUNK_LINES - 1)
  };
}

function deterministicCandidate(entries: string[]): string[] {
  return entries.flatMap((entry) => {
    assert(entry.length > 1, `Invalid compact source entry: ${entry}`);
    const lineNumber = entry.slice(0, 1);
    const sourceText = entry.slice(1);
    if (!sourceText.trim()) return [];
    const preservedAscii = sourceText.replace(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, "");
    return [`${lineNumber}验证译文${preservedAscii}`];
  });
}

function deterministicBlocks(sourceBlocks: unknown[]): Array<{ id: string; lines: string[] }> {
  return sourceBlocks.map((value) => {
    const block = value as { id?: unknown; lines?: unknown };
    return {
      id: String(block.id ?? ""),
      lines: deterministicCandidate(Array.isArray(block.lines) ? block.lines.map(String) : [])
    };
  });
}

type ObservableSupervisor = {
  hasRunning(): boolean;
  list(): YnSubagentBatchSnapshot[];
};

async function waitForChildren(supervisor: ObservableSupervisor | undefined): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (supervisor?.hasRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (supervisor?.hasRunning()) throw new Error("Real folder Pi children did not settle within 90 seconds.");
}

function responseFactory(activeSupervisor: () => ObservableSupervisor | undefined): FauxResponseFactory {
  return async (context) => {
    const names = new Set(context.tools?.map((tool) => tool.name) ?? []);
    if (names.has("readAssignedSource")) {
      const validation = toolResults(context, "validateAssignedTranslation").find((result) => !result.isError);
      if (validation) return fauxAssistantMessage(fauxText("REAL_FOLDER_CHILD_COMPLETE"));
      const nextChunk = nextUnwrittenChunk(context);
      if (!nextChunk && messageToolCalls(context, "validateAssignedTranslation") === 0) {
        return fauxAssistantMessage(fauxToolCall("validateAssignedTranslation", {}), { stopReason: "toolUse" });
      }
      assert(nextChunk, "A translation child has neither a remaining chunk nor a completed validation.");
      const matchingRead = toolResults(context, "readAssignedSource")
        .filter((result) => !result.isError)
        .map((result) => parseToolJson(result))
        .find((payload) => payload.fromLine === nextChunk.fromLine && payload.toLine === nextChunk.toLine);
      if (matchingRead) {
        const blocks = Array.isArray(matchingRead.sourceBlocks)
          ? deterministicBlocks(matchingRead.sourceBlocks)
          : [];
        return fauxAssistantMessage(
          fauxToolCall("writeAssignedTranslation", { ...nextChunk, blocks }),
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage(fauxToolCall("readAssignedSource", nextChunk), { stopReason: "toolUse" });
    }

    const successfulValidation = toolResults(context, "validateTranslationArtifact").find((result) => !result.isError);
    if (successfulValidation) {
      return fauxAssistantMessage(fauxText("REAL_FOLDER_BATCH_COMPLETE: every manifest document passed host validation."));
    }
    if (hasAssistantText(context, "REAL_FOLDER_BATCH_STARTED")) {
      const supervisor = activeSupervisor();
      await waitForChildren(supervisor);
      const latestBatch = supervisor?.list().at(-1);
      if (latestBatch?.status !== "completed") {
        return fauxAssistantMessage(fauxText(`REAL_FOLDER_BATCH_FAILED: ${JSON.stringify(latestBatch)}`));
      }
      return fauxAssistantMessage(fauxToolCall("validateTranslationArtifact", {}), { stopReason: "toolUse" });
    }
    if (toolResults(context, "runTranslationSubagents").some((result) => !result.isError)) {
      return fauxAssistantMessage(fauxText("REAL_FOLDER_BATCH_STARTED: native Pi children are running in parallel."));
    }
    if (toolResults(context, "inspectTranslationContext").some((result) => !result.isError)) {
      return fauxAssistantMessage(
        fauxToolCall("runTranslationSubagents", { tasks: [] }, { id: "real_folder_run" }),
        { stopReason: "toolUse" }
      );
    }
    return fauxAssistantMessage([
      fauxThinking("Inspecting the host-owned real folder manifest."),
      fauxToolCall("inspectTranslationContext", {}, { id: "real_folder_inspect" })
    ], { stopReason: "toolUse" });
  };
}

async function openNestedAgent(win: BrowserWindow): Promise<void> {
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.readyState === "complete"', 15_000);
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#openAgentChat")', 15_000);
  const opened = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#fileFrame")?.contentDocument?.querySelector("#openAgentChat");
    if (!button || typeof button.click !== "function") return false;
    button.click();
    return true;
  })()`);
  assert(opened, "The real folder child did not expose the Agent button.");
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.querySelector("#agentChatReactRoot textarea")', 5_000);
}

async function waitForNestedRoute(win: BrowserWindow): Promise<void> {
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentDocument?.readyState === "complete"', 15_000);
  await waitFor(win, 'document.querySelector("#fileFrame")?.contentWindow?.__ynAgentChatPiWebEmbedded?.route', 15_000);
}

async function nestedAgentRoute(win: BrowserWindow): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(() => {
    const child = document.querySelector("#fileFrame")?.contentWindow;
    const route = child?.__ynAgentChatPiWebEmbedded?.route;
    return {
      flow: child?.document?.querySelector("#agentChatDock")?.getAttribute("data-agent-chat-flow"),
      sourceKind: route?.sourceKind,
      sourcePath: route?.sourcePath,
      lineReviewPath: route?.lineReviewPath
    };
  })()`);
}

let routeWin: BrowserWindow | undefined;
let win: BrowserWindow | undefined;
let service: PiNativeSessionService | undefined;

async function run(): Promise<Record<string, unknown>> {
  const history = await readFile(sessionPath, "utf8");
  assert(history.includes("The selected source is not a file") || history.includes("The bound source path is not a file"), "The supplied Pi JSONL does not contain the reproduced folder-as-file failure.");
  assert(history.includes("runTranslationSubagents"), "The supplied Pi JSONL does not contain the failed folder subagent attempt.");

  const manifest = await resolvePiSourceManifest({
    outputDir: workspace,
    sourcePath: sourceRoot,
    sourceSelection: { kind: "folder", path: sourceRoot }
  });
  assert(manifest.kind === "folder", "The real source root did not resolve as a folder manifest.");
  assert(manifest.documents.length === 16, `Expected 16 real source documents, found ${manifest.documents.length}.`);
  assert(!manifest.documents.some((document) => /character_bible\.md$/i.test(document.id)), "Character bible leaked into the source manifest.");
  const sourceDocumentPaths = manifest.documents.map((document) => document.path);
  const sourceHashesBefore = await hashFiles(sourceDocumentPaths);
  const fauxResponseBudget = manifest.documents.reduce(
    (total, document) => total + Math.ceil(document.lineCount / MAX_ASSIGNED_TRANSLATION_CHUNK_LINES) * 4,
    100
  );

  let modelSelectionCalls = 0;
  let activeSupervisor: ObservableSupervisor | undefined;
  let expectedProviderId: string;
  let expectedModelId: string;
  const createProductTools: NonNullable<PiNativeSessionServiceOptions["createTools"]> = ({
    request,
    publishCustomMessage,
    subagents,
    domainRun
  }) => {
    activeSupervisor = subagents;
    return createYnDomainTools({ request, publishCustomMessage, subagents, domainRun });
  };
  const commonServiceOptions: Pick<PiNativeSessionServiceOptions, "enforceDomainCompletion" | "createTools"> = {
    enforceDomainCompletion: true,
    createTools: createProductTools
  };
  if (realProviderMode) {
    await prepareRealProvider();
    expectedProviderId = realProviderId;
    expectedModelId = realModelId;
    service = new PiNativeSessionService({
      ...commonServiceOptions,
      createModelSelection: async (args) => {
        modelSelectionCalls += 1;
        return createPiModelSelection(args);
      },
      buildSystemPrompt: buildYnSystemPrompt
    });
  } else {
    const providerPreset = getProviderPreset("openai-chatgpt");
    assert(providerPreset, "OpenAI ChatGPT provider preset is missing.");
    const faux = fauxProvider({
      provider: providerPreset.id,
      models: [{
        id: providerPreset.config.model,
        name: providerPreset.config.model.toUpperCase(),
        contextWindow: 2_000_000,
        maxTokens: 128_000
      }],
      tokensPerSecond: 20_000,
      tokenSize: { min: 250_000, max: 250_000 }
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const factory = responseFactory(() => activeSupervisor);
    faux.setResponses(Array.from({ length: fauxResponseBudget }, () => factory));
    expectedProviderId = providerPreset.id;
    expectedModelId = faux.getModel().id;
    service = new PiNativeSessionService({
      ...commonServiceOptions,
      createModelSelection: async () => {
        modelSelectionCalls += 1;
        return {
          models,
          model: faux.getModel(),
          providerId: faux.provider.id,
          modelId: faux.getModel().id
        };
      },
      buildSystemPrompt: () => "Use the native Pi tools. The host owns the folder manifest and all artifact validation."
    });
    await updateProviderConfig(path.join(workspace, ".translation-workshop"), {
      activeProviderId: providerPreset.id,
      provider: { ...providerPreset.config, auth: { kind: "oauth", accessToken: "real-folder-verifier" } }
    });
  }
  let observedRuntimeEvents = 0;
  const observedRuntimeEventTypes = new Map<string, number>();
  const observedMessageEndKinds = new Map<string, number>();
  service.subscribeEvents((envelope) => {
    observedRuntimeEvents += 1;
    const type = envelope.event.type;
    observedRuntimeEventTypes.set(type, (observedRuntimeEventTypes.get(type) ?? 0) + 1);
    if (type === "message_end" && envelope.event.message) {
      const message = envelope.event.message;
      const kind = message.role === "custom" ? `custom:${message.customType}` : message.role;
      observedMessageEndKinds.set(kind, (observedMessageEndKinds.get(kind) ?? 0) + 1);
    }
  });

  let observedBroadcasts = 0;
  let observedBroadcastBytes = 0;
  let largestBroadcastBytes = 0;
  const observedBroadcastChannels = new Map<string, { count: number; bytes: number; maxBytes: number }>();

  registerAgentSessionIpc({
    service,
    broadcast(channel, payload) {
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      observedBroadcasts += 1;
      observedBroadcastBytes += bytes;
      largestBroadcastBytes = Math.max(largestBroadcastBytes, bytes);
      const prior = observedBroadcastChannels.get(channel) ?? { count: 0, bytes: 0, maxBytes: 0 };
      observedBroadcastChannels.set(channel, {
        count: prior.count + 1,
        bytes: prior.bytes + bytes,
        maxBytes: Math.max(prior.maxBytes, bytes)
      });
      for (const target of BrowserWindow.getAllWindows()) {
        if (!target.webContents.isDestroyed()) target.webContents.send(channel, payload);
      }
    }
  });
  registerAgentProviderIpc();
  ipcMain.handle("prompts:build", async (_event, args: unknown) => buildPrompt(args as Parameters<typeof buildPrompt>[0]));
  ipcMain.handle("ui:agentChatEmbeddedEntryUrl", async () => ({
    ok: true,
    url: await rendererAssetUrl("agent-embedded-"),
    cssUrl: await rendererCssAssetUrl()
  }));
  ipcMain.handle("html:persistState", async () => ({ ok: true }));

  const firstDocument = manifest.documents[0];
  const sourceText = await readFile(firstDocument.path, "utf8");
  await writeFile(controlledHtmlPath, renderLineReviewHtml({
    title: "Real folder controlled Electron replay",
    sourceText,
    lineReviewPath: controlledHtmlPath,
    workflow: {
      sourcePath: firstDocument.path,
      sourceKind: "file",
      sourcePromptPath: sourceRoot,
      promptSourceKind: "folder",
      outputDir: workspace,
      advanced: {
        languagePair: "ja->zh-CN",
        glossaryCandidates: false,
        characterBible: false,
        subagentEnabled: true,
        subagentCount: workerCount
      }
    }
  }), "utf8");

  win = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(root, "dist", "main", "preload.cjs"),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: process.env.YN_ELECTRON_VERIFY_OFFSCREEN === "1"
    }
  });
  win.webContents.on("console-message", (details) => console.log(`[real-folder-renderer:${details.level}] ${details.message}`));
  await win.loadFile(controlledHtmlPath);
  mark("controlled-html-loaded");

  routeWin = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(root, "dist", "main", "preload.cjs"),
      partition: "yn-real-folder-route-verifier",
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: process.env.YN_ELECTRON_VERIFY_OFFSCREEN === "1"
    }
  });
  routeWin.webContents.on("console-message", (details) => console.log(`[real-folder-route:${details.level}] ${details.message}`));

  const legacyFixture = await prepareLegacyBatchFixture();
  await routeWin.loadFile(legacyFixture.parentPath);
  await waitForNestedRoute(routeWin);
  const legacyRoute = await nestedAgentRoute(routeWin);
  assert(legacyRoute.flow === legacyFlow && legacyRoute.sourceKind === "file", `The reconstructed v7 route did not reproduce the folder-as-file bug: ${JSON.stringify(legacyRoute)}`);
  const upgradedOnDisk = await upgradeLegacyReviewHtmlTree(legacyFixture.parentPath);
  assert(upgradedOnDisk, "The production legacy review-tree upgrader did not rewrite the reconstructed v7 batch.");
  const upgradedChildren = await Promise.all(legacyFixture.childPaths.map((childPath) => readFile(childPath, "utf8")));
  assert(upgradedChildren.every((html) => html.includes(currentFlow) && html.includes(currentFolderRoute) && !html.includes(legacyFlow)), "The production upgrader did not rewrite every v7 child to the current folder route.");
  await routeWin.loadFile(legacyFixture.parentPath);
  await waitForNestedRoute(routeWin);
  const upgradedRoute = await nestedAgentRoute(routeWin);
  assert(upgradedRoute.flow === currentFlow && upgradedRoute.sourceKind === "folder", `The Electron-loaded upgraded fixture did not expose the current folder route: ${JSON.stringify(upgradedRoute)}`);
  mark("legacy-v7-folder-route-reproduced-and-upgraded");

  const actualLoadStarted = performance.now();
  await routeWin.loadFile(batchHtmlPath);
  revealVerificationWindow(routeWin);
  await openNestedAgent(routeWin);
  const actualInteractiveMs = performance.now() - actualLoadStarted;
  const actualRoute = await nestedAgentRoute(routeWin);
  assert(actualRoute.flow === currentFlow, `Actual retained child is not v8: ${JSON.stringify(actualRoute)}`);
  assert(actualRoute.sourceKind === "folder", `Actual child still sends the folder as a file: ${JSON.stringify(actualRoute)}`);
  assert(path.resolve(actualRoute.sourcePath) === sourceRoot, `Actual child route lost the real folder root: ${JSON.stringify(actualRoute)}`);
  await capture(routeWin, routeScreenshot);
  mark("actual-history-route-reproduced-and-upgraded");
  routeWin.destroy();
  routeWin = undefined;
  revealVerificationWindow(win);
  win.webContents.focus();
  await waitFor(win, 'document.querySelector("#openAgentChat")', 10_000);
  const opened = await win.webContents.executeJavaScript(`(() => { const button = document.querySelector("#openAgentChat"); button?.click(); return Boolean(button); })()`);
  assert(opened, "Controlled real-folder Agent button is missing.");
  await waitFor(win, 'document.querySelector("#agentChatReactRoot textarea")', 5_000);
  const controlledRoute = await win.webContents.executeJavaScript(`window.__ynAgentChatPiWebEmbedded?.route`);
  const controlledVisibility = await win.webContents.executeJavaScript(`document.visibilityState`);
  assert(controlledVisibility === "visible" && win.isVisible(),
    `The measured Agent renderer is not foreground-visible: ${controlledVisibility}.`);
  assert(controlledRoute?.sourceKind === "folder" && path.resolve(controlledRoute.sourcePath) === sourceRoot, `Controlled replay lost the real folder route: ${JSON.stringify(controlledRoute)}`);
  assert(path.resolve(controlledRoute.outputDir) === workspace, `Controlled replay lost its temporary output directory: ${JSON.stringify(controlledRoute)}`);
  const providerProof = await win.webContents.executeJavaScript(`Promise.all([
    window.workshopHtml.getAgentProviderConfig({ outputDir: ${JSON.stringify(workspace)} }),
    window.workshopHtml.listAgentConfiguredModels({ outputDir: ${JSON.stringify(workspace)} })
  ]).then(([config, models]) => ({ config, models }))`);
  assert(providerProof?.config?.activeProviderId === expectedProviderId,
    `Controlled provider config did not select ${expectedProviderId}.`);
  assert(Array.isArray(providerProof.models) && providerProof.models.length > 0, `Controlled configured model catalog is empty: ${JSON.stringify(providerProof)}`);
  assert(providerProof.models.some((model: { providerId?: string; modelId?: string }) => (
    model.providerId === expectedProviderId && model.modelId === expectedModelId
  )), `Controlled configured model catalog does not include ${expectedProviderId}/${expectedModelId}.`);

  const basePrompt = buildTranslatePrompt({
    sourcePath: sourceRoot,
    sourceKind: "folder",
    outputDir: workspace,
    advanced: {
      languagePair: "ja->zh-CN",
      glossaryCandidates: false,
      characterBible: false,
      subagentEnabled: true,
      subagentCount: workerCount
    }
  });
  const prompt = realProviderMode
    ? [
        basePrompt,
        "真实文件夹验收约束：先调用 inspectTranslationContext，再用 runTranslationSubagents 的空 tasks 让 host 将全部文件排队给所选持久 worker。",
        `必须只启动 ${workerCount} 个持久 Pi worker；不要按文件数创建 child。每个 worker 继续领取文件直到队列为空。`,
        "若 host 返回 missingLines 或 validation findings，只修复这些绝对行号；不要重译已经通过的行。",
        "等待所有 worker 完成，再调用 validateTranslationArtifact。只有全部文件通过 host validation 后才能最终回复。"
      ].join("\n")
    : basePrompt;
  const inserted = await win.webContents.executeJavaScript(`(() => {
    const api = window.YnPiWebAgentEmbedded;
    if (!api?.insertText) return false;
    api.insertText(${JSON.stringify(prompt)}, {
      workflowIntent: "translation",
      languagePair: "ja->zh-CN",
      subagentEnabled: true,
      subagentCount: ${workerCount}
    });
    return true;
  })()`);
  assert(inserted, "Controlled real-folder Pi-web composer bridge is missing.");
  const idleSampler = await startResourceSampler(win, () => observedRuntimeEvents);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await idleSampler.stop();
  const idleStart = idleSampler.samples[0];
  const idleEnd = idleSampler.samples.at(-1);
  const idlePeakRendererWorkingSetMb = Math.max(...idleSampler.samples.map((sample) => sample.rendererWorkingSetMb));
  const idlePeakRendererPrivateMb = Math.max(...idleSampler.samples.map((sample) => sample.rendererPrivateMb));
  mark(`idle-resource-control ${JSON.stringify({
    samples: idleSampler.samples.length,
    startRendererWorkingSetMb: Number((idleStart?.rendererWorkingSetMb ?? 0).toFixed(1)),
    endRendererWorkingSetMb: Number((idleEnd?.rendererWorkingSetMb ?? 0).toFixed(1)),
    peakRendererWorkingSetMb: Number(idlePeakRendererWorkingSetMb.toFixed(1)),
    startRendererPrivateMb: Number((idleStart?.rendererPrivateMb ?? 0).toFixed(1)),
    endRendererPrivateMb: Number((idleEnd?.rendererPrivateMb ?? 0).toFixed(1)),
    peakRendererPrivateMb: Number(idlePeakRendererPrivateMb.toFixed(1)),
    maxEventLoopLagMs: Number((idleSampler.renderer?.maxEventLoopLagMs ?? 0).toFixed(1)),
    runtimeEvents: observedRuntimeEvents
  })}`);
  await installRendererBatchSignal(win, workerCount, batchTimeoutMs);
  const resourceSampler = await startResourceSampler(win, () => observedRuntimeEvents);
  const modelSelectionCallsBeforeSend = modelSelectionCalls;
  const batchStartedAt = performance.now();
  const sent = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#agentChatReactRoot button[aria-label="Send"]');
    const signal = window.__ynElectronBatchSignal;
    if (signal) signal.sendAt = performance.now();
    button?.click();
    return Boolean(button);
  })()`);
  assert(sent, "Controlled real-folder Send button is missing.");
  const batchSignal = await awaitRendererBatchSignal(win);
  assert(!batchSignal.missing, "The event-driven renderer batch signal was lost.");
  assert(!batchSignal.timeout, `Timed out waiting for the event-driven renderer batch signal: ${JSON.stringify(batchSignal)}`);
  assert(batchSignal.sendAt > 0 && batchSignal.userSeenAt >= batchSignal.sendAt,
    `The optimistic user message was not observed after Send: ${JSON.stringify(batchSignal)}`);
  assert(batchSignal.cards === workerCount,
    `The event-driven renderer signal observed ${batchSignal.cards} child cards instead of ${workerCount}.`);
  assert(!batchSignal.failureText, `Real folder worker batch failed: ${batchSignal.failureText}`);
  assert(batchSignal.complete, `The event-driven renderer signal did not observe the final completion message.`);
  const optimisticMs = batchSignal.userSeenAt - batchSignal.sendAt;
  await resourceSampler.stop();
  if (!realProviderMode) {
    const terminalMarker = await win.webContents.executeJavaScript(`(() => {
      const text = document.body.innerText;
      const failedAt = text.lastIndexOf("REAL_FOLDER_BATCH_FAILED");
      return failedAt >= 0 ? text.slice(failedAt, failedAt + 8000) : "";
    })()`);
    assert(!terminalMarker, `Real folder worker batch failed: ${terminalMarker}`);
  }
  assert(resourceSampler.samples.length >= 3, `Electron resource sampler captured only ${resourceSampler.samples.length} samples.`);
  assert(resourceSampler.renderer, "Electron renderer resource probe did not return a terminal sample.");
  const rendererProbe = resourceSampler.renderer;
  const peakRendererPingMs = rendererProbe.maxEventLoopLagMs;
  const peakRendererWorkingSetMb = Math.max(...resourceSampler.samples.map((sample) => sample.rendererWorkingSetMb));
  const peakRendererPrivateMb = Math.max(...resourceSampler.samples.map((sample) => sample.rendererPrivateMb));
  const peakTotalWorkingSetMb = Math.max(...resourceSampler.samples.map((sample) => sample.totalWorkingSetMb));
  const rendererWorkingSetGrowthMb = Math.max(0, peakRendererWorkingSetMb - idlePeakRendererWorkingSetMb);
  const rendererPrivateGrowthMb = Math.max(0, peakRendererPrivateMb - idlePeakRendererPrivateMb);
  const peakRendererJsHeapUsedMb = rendererProbe.rendererJsHeapUsedMb;
  const peakRendererJsHeapTotalMb = rendererProbe.rendererJsHeapTotalMb;
  const peakDomNodes = rendererProbe.domNodes;
  const peakAgentMessages = rendererProbe.agentMessages;
  const peakExpandedSubagentCards = rendererProbe.expandedSubagentCards;
  const resourceTimeline = resourceSampler.samples.filter((sample, index, samples) => (
    index === 0
    || index === samples.length - 1
    || sample.rendererWorkingSetMb === peakRendererWorkingSetMb
  ));
  mark(`resource-telemetry ${JSON.stringify({
    samples: resourceSampler.samples.length,
    peakRendererPingMs: Number(peakRendererPingMs.toFixed(1)),
    peakRendererWorkingSetMb: Number(peakRendererWorkingSetMb.toFixed(1)),
    peakRendererPrivateMb: Number(peakRendererPrivateMb.toFixed(1)),
    peakTotalWorkingSetMb: Number(peakTotalWorkingSetMb.toFixed(1)),
    rendererWorkingSetGrowthMb: Number(rendererWorkingSetGrowthMb.toFixed(1)),
    rendererPrivateGrowthMb: Number(rendererPrivateGrowthMb.toFixed(1)),
    peakRendererJsHeapUsedMb: Number(peakRendererJsHeapUsedMb.toFixed(1)),
    peakRendererJsHeapTotalMb: Number(peakRendererJsHeapTotalMb.toFixed(1)),
    peakDomNodes,
    peakAgentMessages,
    peakExpandedSubagentCards,
    rendererProbeTicks: rendererProbe.ticks,
    finalSubagentCards: rendererProbe.subagentCards,
    observedRuntimeEvents,
    observedRuntimeEventTypes: Object.fromEntries([...observedRuntimeEventTypes.entries()].sort()),
    observedMessageEndKinds: Object.fromEntries([...observedMessageEndKinds.entries()].sort()),
    observedBroadcasts,
    observedBroadcastBytes,
    largestBroadcastBytes,
    observedBroadcastChannels: Object.fromEntries([...observedBroadcastChannels.entries()].sort()),
    timeline: resourceTimeline.map((sample) => ({
      elapsedMs: Number(sample.elapsedMs.toFixed(1)),
      rendererWorkingSetMb: Number(sample.rendererWorkingSetMb.toFixed(1)),
      rendererPrivateMb: Number(sample.rendererPrivateMb.toFixed(1)),
      runtimeEvents: sample.runtimeEvents
    }))
  })}`);
  assert(peakRendererWorkingSetMb > 0, "Electron resource sampler could not identify the Agent renderer process.");
  assert(peakRendererPingMs < 250, `Agent renderer stopped responding during ${workerCount}-worker execution for ${peakRendererPingMs.toFixed(1)} ms.`);
  assert(peakRendererPrivateMb < 384, `Agent renderer exceeded the 384 MB private-memory budget: ${peakRendererPrivateMb.toFixed(1)} MB.`);
  assert(rendererWorkingSetGrowthMb < 192,
    `Agent renderer working set grew ${rendererWorkingSetGrowthMb.toFixed(1)} MB above its measured idle baseline.`);
  assert(rendererPrivateGrowthMb < 192,
    `Agent renderer private memory grew ${rendererPrivateGrowthMb.toFixed(1)} MB above its measured idle baseline.`);
  assert(peakTotalWorkingSetMb < 1_536, `Electron exceeded the 1.5 GB total working-set budget: ${peakTotalWorkingSetMb.toFixed(1)} MB.`);

  const completedBootstrap = await service.bootstrap(workspace);
  assert(completedBootstrap.activeSessionId, "Completed real-folder run lost its parent Pi session.");
  const completedRepository = new PiSessionRepository(workspace);
  const completedMetadata = await completedRepository.findMetadata(completedBootstrap.activeSessionId);
  assert(completedMetadata, "Completed real-folder parent Pi JSONL metadata is missing.");
  const completedParentJsonlBytes = (await stat(completedMetadata.path)).size;
  const completedParentMessages = await service.loadMessages(workspace, completedBootstrap.activeSessionId);
  const completedParentCards = completedParentMessages.filter((message) => (
    message.role === "custom"
    && message.details
    && typeof message.details === "object"
    && typeof (message.details as Record<string, unknown>).subagentId === "string"
  ));
  assert(completedParentCards.length === workerCount, `Completed parent projection has ${completedParentCards.length} child cards instead of ${workerCount}.`);
  assert(
    completedParentCards.every((message) => !Object.prototype.hasOwnProperty.call(message.details, "transcript")),
    "Completed parent cards duplicated child Pi transcripts."
  );
  const largestParentCardBytes = Math.max(...completedParentCards.map((message) => Buffer.byteLength(JSON.stringify(message))));
  assert(largestParentCardBytes < 16_384, `A lightweight parent card grew to ${largestParentCardBytes} bytes.`);
  assert(completedParentJsonlBytes < 2 * 1024 * 1024, `Parent Pi JSONL grew to ${completedParentJsonlBytes} bytes during a ${workerCount}-worker batch.`);
  const successfulFinalValidations = completedParentMessages.filter((message) => (
    message.role === "toolResult"
    && message.toolName === "validateTranslationArtifact"
    && !message.isError
  ));
  assert(successfulFinalValidations.length > 0,
    "The parent Pi session has no successful final validateTranslationArtifact result.");

  const candidatePaths = manifest.documents.map((document) => resolveTranslationCandidatePath({
    outputDir: workspace,
    sourcePaths: [document.path],
    documentId: document.id
  }));
  await Promise.all(candidatePaths.map((candidate) => access(candidate)));
  const candidateValidations = await Promise.all(manifest.documents.map(async (document, index) => {
    const sourceText = await readFile(document.path, "utf8");
    const candidateText = await readFile(candidatePaths[index], "utf8");
    return {
      documentId: document.id,
      validation: validateTranslationCandidate(sourceText, candidateText, {
        locale: "zh-CN",
        languagePair: "ja->zh-CN",
        detectUntranslated: true
      })
    };
  }));
  const invalidCandidates = candidateValidations.filter(({ validation }) => (
    !validation.ok || validation.warnings.some((finding) => finding.code === "likely_untranslated")
  ));
  assert(invalidCandidates.length === 0,
    `Independent host validation rejected ${invalidCandidates.length} candidates: ${invalidCandidates.map(({ documentId, validation }) => `${documentId}: ${validation.summary}`).join(" | ")}`);
  const uiProof = await win.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll("[data-agent-subagent-card=true]").length,
    completed: [...document.querySelectorAll("[data-agent-subagent-card=true]")].filter((card) => card.textContent?.includes("completed") || card.textContent?.includes("closed")).length,
    hasInspect: document.body.innerText.includes("inspectTranslationContext"),
    hasBatch: document.body.innerText.includes("runTranslationSubagents"),
    hasFinal: ${JSON.stringify(realProviderMode)}
      ? Boolean(document.querySelector('[data-agent-tool-call="validateTranslationArtifact"]'))
      : document.body.innerText.includes("REAL_FOLDER_BATCH_COMPLETE"),
    rawFolderError: document.body.innerText.includes("selected source is not a file") || document.body.innerText.includes("bound source path is not a file")
  }))()`);
  assert(uiProof.cards === workerCount && uiProof.completed === workerCount, `Real folder worker cards did not all close: ${JSON.stringify(uiProof)}`);
  assert(uiProof.hasInspect && uiProof.hasBatch && uiProof.hasFinal && !uiProof.rawFolderError, `Real folder UI proof failed: ${JSON.stringify(uiProof)}`);
  const promptRuntimeSelections = modelSelectionCalls - modelSelectionCallsBeforeSend;
  assert(
    promptRuntimeSelections === workerCount + 1,
    `Expected one parent plus exactly ${workerCount} persistent Pi worker runtimes, observed ${promptRuntimeSelections} model selections.`
  );
  const batchDurationMs = performance.now() - batchStartedAt;
  assert(batchDurationMs <= batchTimeoutMs,
    `Real folder translation took ${(batchDurationMs / 60_000).toFixed(2)} minutes, exceeding the approved ${(batchTimeoutMs / 60_000).toFixed(2)}-minute hard deadline.`);
  const workersScrolledIntoView = await win.webContents.executeJavaScript(`(() => {
    const firstWorker = document.querySelector("[data-agent-subagent-card=true]");
    if (!firstWorker) return false;
    firstWorker.scrollIntoView({ block: "start" });
    return true;
  })()`);
  assert(workersScrolledIntoView, `The ${workerCount} persistent worker cards were not available for screenshot evidence.`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await capture(win, batchScreenshot);
  const finalScrolledIntoView = await win.webContents.executeJavaScript(`(() => {
    const finalText = ${JSON.stringify(realProviderMode)}
      ? [...document.querySelectorAll('[data-agent-message-role="assistant"]')].at(-1)
      : [...document.querySelectorAll("#agentChatReactRoot *")].findLast((element) =>
          element.children.length === 0 && element.textContent?.includes("REAL_FOLDER_BATCH_COMPLETE")
        );
    if (!finalText) return false;
    finalText.scrollIntoView({ block: "center" });
    return true;
  })()`);
  assert(finalScrolledIntoView, "The final real-folder completion message was not available for screenshot evidence.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await capture(win, completionScreenshot);
  assertHashesEqual(sourceHashesBefore, await hashFiles(sourceDocumentPaths));

  return {
    ok: true,
    historyFailureReproduced: true,
    legacyV7RouteReproduced: true,
    productionLegacyTreeUpgradeApplied: upgradedOnDisk,
    upgradedRoute,
    actualRetainedHtmlCurrentV8: true,
    actualRoute,
    actualInteractiveMs: Number(actualInteractiveMs.toFixed(1)),
    optimisticMs: Number(optimisticMs.toFixed(1)),
    manifestKind: manifest.kind,
    manifestDocuments: manifest.documents.length,
    emptyTaskListExpandedByHost: true,
    nativePiWorkers: uiProof.cards,
    nativePiWorkerRuntimes: promptRuntimeSelections - 1,
    providerMode: realProviderMode ? "real" : "faux",
    providerId: expectedProviderId,
    modelId: expectedModelId,
    batchDurationMs: Number(batchDurationMs.toFixed(1)),
    healthTargetMs: realProviderMode ? realFolderTargetMs : undefined,
    healthDeadlineMs: batchTimeoutMs,
    healthOverrunMs: realProviderMode ? Number(Math.max(0, batchDurationMs - realFolderTargetMs).toFixed(1)) : 0,
    completedWorkers: uiProof.completed,
    queuedAssignments: manifest.documents.length,
    validatedCandidates: candidatePaths.length,
    resourceSamples: resourceSampler.samples.length,
    peakRendererPingMs: Number(peakRendererPingMs.toFixed(1)),
    peakRendererWorkingSetMb: Number(peakRendererWorkingSetMb.toFixed(1)),
    peakRendererPrivateMb: Number(peakRendererPrivateMb.toFixed(1)),
    peakTotalWorkingSetMb: Number(peakTotalWorkingSetMb.toFixed(1)),
    rendererWorkingSetGrowthMb: Number(rendererWorkingSetGrowthMb.toFixed(1)),
    rendererPrivateGrowthMb: Number(rendererPrivateGrowthMb.toFixed(1)),
    peakRendererJsHeapUsedMb: Number(peakRendererJsHeapUsedMb.toFixed(1)),
    peakRendererJsHeapTotalMb: Number(peakRendererJsHeapTotalMb.toFixed(1)),
    peakDomNodes,
    peakAgentMessages,
    peakExpandedSubagentCards,
    observedRuntimeEvents,
    observedRuntimeEventTypes: Object.fromEntries([...observedRuntimeEventTypes.entries()].sort()),
    observedMessageEndKinds: Object.fromEntries([...observedMessageEndKinds.entries()].sort()),
    observedBroadcasts,
    observedBroadcastBytes,
    largestBroadcastBytes,
    observedBroadcastChannels: Object.fromEntries([...observedBroadcastChannels.entries()].sort()),
    completedParentJsonlBytes,
    largestParentCardBytes,
    sourceDocumentsHashed: sourceHashesBefore.size,
    actualSourceDocumentsUnmodified: true,
    screenshots: [routeScreenshot, batchScreenshot, completionScreenshot]
  };
}

async function cleanup(): Promise<void> {
  if (routeWin && !routeWin.isDestroyed()) routeWin.destroy();
  if (win && !win.isDestroyed()) win.destroy();
  await service?.disposeWorkspace(workspace);
  if (keepTemporaryOutput) {
    mark(`temporary-output-preserved ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
    await assertPathMissing(workspace);
  }
}

async function writeResult(result: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : resolve());
  });
}

void app.whenReady().then(async () => {
  let result: Record<string, unknown> | undefined;
  try {
    result = await run();
    await cleanup();
    await writeResult({
      ...result,
      temporaryOutputRemovedOnExit: !keepTemporaryOutput,
      temporaryOutputDir: keepTemporaryOutput ? workspace : undefined
    });
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    if (win && !win.isDestroyed()) {
      const uiState = await win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll("[data-agent-subagent-card=true]")];
        return {
          url: location.href,
          cards: cards.length,
          expandedCards: document.querySelectorAll("[data-agent-subagent-expanded=true]").length,
          cardText: cards.map((card) => card.textContent?.slice(0, 500) || ""),
          messages: document.querySelectorAll("[data-agent-message-role]").length,
          text: document.body?.innerText?.slice(-2000) || ""
        };
      })()`).catch((inspectionError) => ({ inspectionError: String(inspectionError) }));
      console.error(`Failure UI state: ${JSON.stringify(uiState)}`);
    }
    try {
      const bootstrap = await service?.bootstrap(workspace);
      if (bootstrap?.activeSessionId) {
        const session = await new PiSessionRepository(workspace).open(bootstrap.activeSessionId);
        const context = await session.buildContext();
        const toolErrors = context.messages.filter((message): message is ToolResultMessage => (
          message.role === "toolResult" && message.isError
        )).slice(-20).map((message) => ({
          toolName: message.toolName,
          text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(0, 2000)
        }));
        console.error(`Failure native tool errors: ${JSON.stringify(toolErrors)}`);
      }
    } catch (inspectionError) {
      console.error(`Failure native state inspection failed: ${String(inspectionError)}`);
    }
    process.exitCode = 1;
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error(`Cleanup failed: ${cleanupError instanceof Error ? cleanupError.stack || cleanupError.message : String(cleanupError)}`);
    }
  }
  app.exit(process.exitCode ?? 0);
});
