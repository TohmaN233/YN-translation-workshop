import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PiNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../src/main/agent/piNative/sessionRepository.ts";
import { updateProviderConfig } from "../src/main/agent/providerConfigStore.ts";
import { registerAgentProviderIpc } from "../src/main/ipc/agentProviderHandlers.ts";
import { registerAgentSessionIpc } from "../src/main/ipc/agentSessionHandlers.ts";
import { getProviderPreset } from "../src/shared/agent/providerPresets.ts";
import { renderLineReviewHtml } from "../src/shared/core/html.ts";
import { buildPrompt } from "../src/shared/core/prompts.ts";

const root = process.cwd();
const workspace = path.resolve(process.env.YN_COLD_RESTART_WORKSPACE || "");
const phase = process.env.YN_COLD_RESTART_PHASE;
const sourcePath = path.join(workspace, "source.txt");
const translationPath = path.join(workspace, "translation.txt");
const htmlPath = path.join(workspace, "review.html");
const screenshotPath = path.join(root, "artifacts", "electron-agent-native-restart-recovery.png");
const sessionId = "pi_electron_cold_restart";
const subagentId = "subagent_electron_process_exit";
const service = new PiNativeSessionService();

if (!workspace || !["seed", "recover"].includes(phase || "")) {
  throw new Error("YN_COLD_RESTART_WORKSPACE and a valid YN_COLD_RESTART_PHASE are required.");
}

app.disableHardwareAcceleration();
app.setPath("userData", path.join(workspace, `electron-user-data-${phase}`));
app.setPath("cache", path.join(workspace, `electron-cache-${phase}`));

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function rendererAssetUrl(prefix: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const assetsDir = path.join(root, "dist", "renderer", "assets");
  const match = (await readdir(assetsDir)).find((file) => file.startsWith(prefix) && file.endsWith(".js"));
  if (!match) throw new Error(`Missing renderer asset ${prefix}`);
  return pathToFileURL(path.join(assetsDir, match)).toString();
}

async function rendererCssAssetUrl(): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const assetsDir = path.join(root, "dist", "renderer", "assets");
  const match = (await readdir(assetsDir)).find((file) => file.startsWith("styles-") && file.endsWith(".css"));
  return match ? pathToFileURL(path.join(assetsDir, match)).toString() : undefined;
}

async function waitFor(win: BrowserWindow, expression: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function capturePaintedWindow(win: BrowserWindow): Promise<void> {
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1") {
    win.show();
    win.focus();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  const decoded = nativeImage.createFromBuffer(png);
  assert(png.length > 0 && !decoded.isEmpty(), "Cold-restart Electron screenshot was empty");
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, png);
}

async function seed(): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await writeFile(sourcePath, "こんにちは\nさようなら", "utf8");
  await writeFile(translationPath, "你好\n再见", "utf8");
  await writeFile(htmlPath, renderLineReviewHtml({
    title: "Pi cold restart verifier",
    sourceText: "こんにちは\nさようなら",
    translationText: "你好\n再见",
    locale: "zh-CN",
    lineReviewPath: htmlPath,
    workflow: { outputDir: workspace, sourcePath, translationPath }
  }), "utf8");
  const providerPreset = getProviderPreset("openai-chatgpt");
  assert(providerPreset, "OpenAI ChatGPT provider preset is missing");
  await updateProviderConfig(path.join(workspace, ".translation-workshop"), {
    activeProviderId: providerPreset.id,
    provider: {
      ...providerPreset.config,
      auth: { kind: "oauth", accessToken: "cold-restart-verifier" }
    }
  });
  const repository = new PiSessionRepository(workspace);
  const session = await repository.create(sessionId);
  await session.appendMessage({
    role: "custom",
    customType: "subagent.translation",
    content: "Worker 1 is running",
    display: true,
    details: {
      subagentId,
      batchId: "batch_electron_process_exit",
      kind: "translation",
      label: "Worker 1",
      documentId: "interrupted.txt",
      fromLine: 1,
      toLine: 200,
      status: "running",
      closed: false,
      startedAt: Date.now() - 5_000
    },
    timestamp: Date.now() - 5_000
  });
  await repository.writeActiveSessionId(sessionId);
  console.log(JSON.stringify({ coldRestartSeeded: true, processId: process.pid, sessionId }));
}

async function recover(): Promise<void> {
  registerAgentSessionIpc({
    service,
    broadcast(channel, payload) {
      for (const target of BrowserWindow.getAllWindows()) {
        if (!target.webContents.isDestroyed()) target.webContents.send(channel, payload);
      }
    }
  });
  registerAgentProviderIpc();
  ipcMain.handle("prompts:build", async (_event, args: unknown) => (
    buildPrompt(args as Parameters<typeof buildPrompt>[0])
  ));
  ipcMain.handle("ui:agentChatEmbeddedEntryUrl", async () => ({
    ok: true,
    url: await rendererAssetUrl("agent-embedded-"),
    cssUrl: await rendererCssAssetUrl()
  }));
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

  const win = new BrowserWindow({
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
  try {
    await win.loadFile(htmlPath);
    await waitFor(win, 'document.querySelector("#openAgentChat")');
    await win.webContents.executeJavaScript('document.querySelector("#openAgentChat").click()');
    await waitFor(win, '[...document.querySelectorAll("[data-agent-subagent-card=true]")].some((card) => card.innerText.includes("该 subagent 已关闭"))');
    const ui = await win.webContents.executeJavaScript(`(() => ({
      cardCount: document.querySelectorAll('[data-agent-subagent-card=true]').length,
      closed: [...document.querySelectorAll('[data-agent-subagent-card=true]')]
        .every((card) => card.innerText.includes('该 subagent 已关闭')),
      stopVisible: [...document.querySelectorAll('button')]
        .some((button) => button.textContent?.includes('Stop')),
      inputEnabled: document.querySelector('#agentChatReactRoot textarea')?.disabled === false,
      compacting: document.querySelector('#agentChatReactRoot textarea')?.placeholder?.includes('Compacting') === true
    }))()`);
    assert(ui.cardCount === 1 && ui.closed, `Cold process restart did not close the child card: ${JSON.stringify(ui)}`);
    assert(!ui.stopVisible, "Cold process restart exposed Stop without a live Pi runtime");
    assert(ui.inputEnabled && !ui.compacting, `Cold process restart left the composer busy: ${JSON.stringify(ui)}`);

    const runState = await service.getRunState(workspace, sessionId);
    assert(!runState.running && !runState.compacting, `Cold process restart restored a fake run state: ${JSON.stringify(runState)}`);
    await service.loadMessages(workspace, sessionId);
    const recoveredSession = await new PiSessionRepository(workspace).open(sessionId);
    const terminalEntries = (await recoveredSession.getBranch()).filter((entry) => {
      if (entry.type !== "message" || entry.message.role !== "custom") return false;
      if (!entry.message.details || typeof entry.message.details !== "object") return false;
      const details = entry.message.details as Record<string, unknown>;
      return details.subagentId === subagentId && details.status === "stopped";
    });
    assert(terminalEntries.length === 1, `Cold process restart persisted ${terminalEntries.length} terminal child cards`);
    await capturePaintedWindow(win);
    console.log(JSON.stringify({
      coldRestartRecovered: true,
      processId: process.pid,
      stoppedCard: true,
      stopHidden: true,
      composerReady: true,
      terminalEntries: terminalEntries.length,
      screenshot: screenshotPath
    }));
  } finally {
    win.destroy();
  }
}

void app.whenReady().then(async () => {
  if (phase === "seed") await seed();
  else await recover();
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (phase === "recover") await service.disposeWorkspace(workspace).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
