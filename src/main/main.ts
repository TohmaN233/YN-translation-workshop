import { app, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell, webContents, type MenuItemConstructorOptions } from "electron";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { buildTimestampedBackupPath } from "../shared/core/backups.ts";
import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { matchFolderFiles, type FolderLineFile } from "../shared/core/folderMatch.ts";
import { parseGlossaryText, type GlossaryEntry } from "../shared/core/glossary.ts";
import {
  BATCH_LINE_REVIEW_PROTOCOL_MARKER,
  LINE_REVIEW_PROTOCOL_MARKER,
  PROPOSAL_REVIEW_PROTOCOL_MARKER,
  renderBatchLineReviewIndexHtml,
  renderLineReviewHtml,
  renderProposalReviewHtml,
  type BatchLineReviewIndexFile,
  type UiLocale
} from "../shared/core/html.ts";
import {
  embeddedProposalLinks,
  rewriteProposalReviewLineReviewPathContent
} from "../shared/core/legacyHtml.ts";
import { rankProofreadReportCandidates, type ProofreadReportCandidate } from "../shared/core/reportDiscovery.ts";
import { parseProofreadReport, type ReviewProposal } from "../shared/core/reviewReport.ts";
import { buildPrompt, type PromptAdvancedOptions, type PromptBuildOptions } from "../shared/core/prompts.ts";
import { splitTextLines } from "../shared/validation/translationValidator.ts";
import { formatFolderTranslationOrder } from "./agent/piNative/folderTranslationPlan.ts";
import { setPiSessionHtmlViewerTabsRef, subscribePiSessionBroadcast } from "./agent/piNative/broadcast.ts";
import { openAgentChatWindow } from "./agent/piNative/agentChatWindowHost.ts";
import { piNativeSessionService } from "./agent/piNative/sessionService.ts";
import { configureWebReferenceBrowserFetch } from "./agent/piNative/webReference.ts";
import { configureGlobalAgentDataDir } from "./agent/agentDataDir.ts";
import {
  subscribeActiveWorkspaceAssetsStatus,
  subscribeWorkspaceAssetsStatus,
  type WorkspaceAssetsStatus
} from "./agent/workspaceAssets.ts";
import { writeClipboardTextVerified } from "./clipboardText.ts";
import { buildLanSyncUrls, detectDefaultRouteIpv4Address } from "./lanSyncNetwork.ts";
import { mergeAuditWhitelistDocument } from "./auditWhitelist.ts";
import {
  bindBatchLineReviewTranslations,
  batchLineReviewOwnsChild,
  canonicalBatchLineReviewIndexPath,
  prepareBatchLineReviewTxtWrites,
  readBatchLineReviewChildren,
  readBatchLineReviewCurrentBindings,
  resolveLineReviewSidecarStatePath
} from "./batchLineReviewTxt.ts";
import {
  acceptLineReviewMutationSequence,
  assertExpectedLineRevisions,
  mergeCanonicalLineReviewState,
  mergeLegacyProposalLineReviewState,
  normalizeChangedLineNumbers,
  normalizeChangedStateKeys
} from "./lineReviewStateSync.ts";
import { writeTextFileAtomically, writeTextFilesAtomically } from "./atomicFile.ts";
import { withTranslationCandidateLock } from "./agent/writeTranslationChunk.ts";
import { readEpubText } from "./epubReader.ts";
import { createTranslatedEpub } from "./epubWriter.ts";
import { collectSourceTreeFiles } from "./sourceFileTree.ts";
import { upgradeLegacyReviewHtmlTree } from "./reviewHtmlUpgrade.ts";
import {
  discoverProjectReviewTargets,
  readRecentProjectDir,
  writeRecentProjectDir
} from "./projectOpenState.ts";
import { patchProjectState, readProjectState, saveProjectState, subscribeProjectState } from "./projectState.ts";
import { workflowTranslationPaths } from "../shared/core/translationBinding.ts";
import { extractedWorkshopTextPath } from "./agent/translationBindingResolve.ts";
import {
  lanSyncJson,
  lanSyncLabels,
  lanSyncLandingHtml,
  lanSyncResponse,
  lanSyncSessionNotFoundHtml
} from "./lanSyncHttp.ts";
import {
  broadcastLanSyncPatch,
  commitLanSyncPatch,
  hashLanSyncPin,
  isLanSyncAuthorized,
  isValidLanSyncPin,
  lanSyncAuthTokenFrom,
  lanSyncSessionPayload,
  normalizeLanSyncCommand,
  persistLanSyncDocumentPatch,
  readLanSyncBody,
  registerLanSyncSession,
  stopLanSyncSession
} from "./lanSyncRuntime.ts";
import {
  assertLanSyncStartOwnership,
  hasLineReviewDataScript,
  lanSyncLineTranslationCount,
  normalizeLanSyncLineDocument,
  normalizeLanSyncOutputDir,
  normalizeLanSyncProposalDocument,
  normalizeLanSyncRows,
  normalizeLanSyncState,
  normalizeLinkedHtmlFilePath,
  readLinkedLineReviewDocument,
  type LanSyncLineDocument,
  type LanSyncLineRow,
  type LanSyncCommand,
  type LanSyncPatch,
  type LanSyncSession,
  type LanSyncStartArgs
} from "./lanSyncState.ts";
import { createLanAgentGateway, lanAgentBridgeScript, normalizeLanAgentRequest } from "./lanAgentRemote.ts";
import {
  getAgentProviderConfig,
  listAgentConfiguredModels,
  saveAgentProviderConfig
} from "./ipc/agentProviderHandlers.ts";
import { checkForUpdatesManually, initializeAutoUpdates, repositoryUrl, scheduleStartupUpdateCheck } from "./updateService.ts";

interface GenerateLineHtmlArgs {
  sourcePath: string;
  translationPath?: string;
  outputDir: string;
  glossaryPath?: string;
  fileType: "auto" | "txt" | "epub";
  pageSize: number;
  startPage?: number;
  locale: UiLocale;
  inputMode?: "separate" | "bilingual";
  sourcePosition?: number;
  translationPosition?: number;
  // Legacy project state used "column" names before TXT bilingual files moved to adjacent pairs.
  sourceColumn?: number;
  translationColumn?: number;
  advanced?: PromptAdvancedOptions;
}

interface GenerateReviewHtmlArgs {
  reportPath?: string;
  lineReviewPath?: string;
  outputDir: string;
  pageSize: number;
  startPage?: number;
  locale: UiLocale;
}

interface ProposalReviewFallbackResult {
  fallbackPrompt: string;
  reportPath: string;
  proposalCount: 0;
}

interface OpenReviewHtmlArgs {
  htmlPath?: string;
  outputDir?: string;
  activate?: boolean;
}

interface WriteTextFileArgs {
  path?: string;
  text?: string;
  outputDir?: string;
}

interface ReadTextFileArgs {
  path?: string;
}

interface WriteAuditWhitelistFileArgs {
  outputDir?: string;
  documentId?: string;
  sourcePath?: string;
  lines?: number[];
  lineReviewPath?: string;
  lineState?: unknown;
  changedLines?: number[];
}

interface WriteEpubFileArgs {
  templatePath?: string;
  lines?: string[];
  outputDir?: string;
  mode?: "all" | "pair-position";
  replacePosition?: number;
  pairSize?: number;
}

type PromptBuildArgs = Partial<PromptBuildOptions>;

interface ApplyLineReviewStateArgs {
  lineReviewPath?: string;
  lineState?: unknown;
  line?: number;
  lines?: number[];
  activate?: boolean;
}

interface ResolveProposalLineReviewDocumentArgs {
  outputDir?: string;
  reportPath?: string;
  lineReviewPath?: string;
  documentId?: string;
  sourcePath?: string;
  translationPath?: string;
  locale?: UiLocale;
  includeRows?: boolean;
}

interface PrepareProposalLineReviewBatchArgs {
  outputDir?: string;
  reportPath?: string;
  lineReviewPath?: string;
  locale?: UiLocale;
  documents?: Array<{
    documentId?: string;
    sourcePath?: string;
    translationPath?: string;
  }>;
}

interface ApplyProposalLineReviewStatesArgs {
  documents?: Array<{
    reportPath?: string;
    documentId?: string;
    sourcePath?: string;
    translationPath?: string;
    lineReviewPath?: string;
    lineState?: unknown;
    changedLines?: number[];
    changedStateKeys?: string[];
    expectedLineRevisions?: Record<string, number>;
  }>;
}

interface HtmlCandidate {
  path: string;
  modifiedMs: number;
  depth: number;
}

type BilingualFileKind = "txt" | "epub";

const isDev = process.env.TRANSLATION_WORKSHOP_DEV === "1";
const electronVerificationHeadless = process.env.YN_ELECTRON_VERIFY_HEADLESS === "1";
const electronVerificationOffscreen = process.env.YN_ELECTRON_VERIFY_OFFSCREEN === "1";
const portableSmokeMarkerPath = (() => {
  const prefix = "--yn-portable-smoke=";
  const argument = process.argv.find((value) => value.startsWith(prefix));
  const markerPath = String(process.env.YN_PORTABLE_SMOKE_MARKER
    || argument?.slice(prefix.length)
    || "").trim();
  if (!markerPath) return undefined;
  if (!markerPath || !path.isAbsolute(markerPath)) {
    throw new Error("Portable smoke verification requires an absolute marker path.");
  }
  return path.resolve(markerPath);
})();

async function recordPortableSmoke(stage: string, detail?: unknown): Promise<void> {
  if (!portableSmokeMarkerPath) return;
  await writeFile(`${portableSmokeMarkerPath}.trace.json`, `${JSON.stringify({
    stage,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...(detail === undefined ? {} : { detail })
  }, null, 2)}\n`, "utf8");
}

if (portableSmokeMarkerPath) {
  app.disableHardwareAcceleration();
  const smokeRuntimeDir = path.dirname(portableSmokeMarkerPath);
  app.setPath("userData", path.join(smokeRuntimeDir, "user-data"));
  app.setPath("cache", path.join(smokeRuntimeDir, "cache"));
}
type HtmlViewerTab = {
  filePath: string;
  hash: string;
  title: string;
  view: BrowserView;
  workspaceDir?: string;
  loadPromise?: Promise<void>;
};
const htmlViewerTabs = new Map<string, HtmlViewerTab>();
const htmlStateWriteQueues = new Map<string, Promise<void>>();
const htmlStateMutationSequences = new Map<string, Map<string, number>>();
setPiSessionHtmlViewerTabsRef(htmlViewerTabs);
let htmlViewerWindow: BrowserWindow | undefined;
let htmlViewerWindowClosing = false;
let mainAppWindow: BrowserWindow | undefined;
let activeHtmlViewerTab = "";
const htmlViewerTabBarHeight = 44;
let lanSyncServer: Server | undefined;
let lanSyncPort = 0;
const lanSyncSessions = new Map<string, LanSyncSession>();
const lanSyncOwnerDestroyedHandlers = new Map<number, () => void>();
const lanAgentGateway = createLanAgentGateway({
  sessionService: piNativeSessionService,
  providerService: {
    getConfig: getAgentProviderConfig,
    listConfiguredModels: listAgentConfiguredModels,
    saveConfig: saveAgentProviderConfig
  }
});

function normalizedAgentWorkspace(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  return (path.basename(resolved).toLowerCase() === ".translation-workshop" ? path.dirname(resolved) : resolved).toLowerCase();
}

function broadcastLanAgent(
  eventName: "agent-event" | "agent-state" | "agent-provider",
  workspaceDir: string,
  payload: unknown,
  global = false
): void {
  const normalizedWorkspace = normalizedAgentWorkspace(workspaceDir);
  const data = `event: ${eventName}\ndata: ${lanSyncJson(payload)}\n\n`;
  for (const session of lanSyncSessions.values()) {
    if (!session.outputDir || (!global && normalizedAgentWorkspace(session.outputDir) !== normalizedWorkspace)) continue;
    for (const client of [...session.clients]) {
      if (client.destroyed) session.clients.delete(client);
      else client.write(data);
    }
  }
}

piNativeSessionService.subscribeEvents((payload) => broadcastLanAgent("agent-event", payload.workspaceDir, payload));
piNativeSessionService.subscribeState((workspaceDir, state, selectionChange) => broadcastLanAgent("agent-state", workspaceDir, {
  workspaceDir,
  state,
  selectionChange
}));
subscribePiSessionBroadcast((channel, payload) => {
  if (channel !== "agent-provider:update" || !payload || typeof payload !== "object") return;
  const update = payload as { scope?: unknown; workspaceDir?: unknown };
  if (typeof update.workspaceDir !== "string") return;
  broadcastLanAgent("agent-provider", update.workspaceDir, payload, update.scope === "global");
});
let activeWorkspaceAssets: { outputDir: string; status: WorkspaceAssetsStatus } | undefined;

subscribeWorkspaceAssetsStatus((outputDir, status) => {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send("agent-assets:workspaceUpdate", { outputDir, status });
  }
});

subscribeProjectState((outputDir, state, patch) => {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send("project:stateUpdate", { outputDir, state, patch });
  }
});

subscribeActiveWorkspaceAssetsStatus((outputDir, status) => {
  activeWorkspaceAssets = { outputDir, status };
  configureApplicationMenu();
});

async function openHtmlFromDialog(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: "Open HTML",
    properties: ["openFile"],
    filters: [
      { name: "HTML", extensions: ["html", "htm"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  const [filePath] = result.filePaths;
  if (!result.canceled && filePath) {
    await openHtmlWindow(filePath);
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open HTML...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void openHtmlFromDialog();
          }
        },
        ...(activeWorkspaceAssets?.status.available.characterBible ? [{
          id: "open-character-bible",
          label: "Open Character Bible",
          click: () => {
            const characterBiblePath = activeWorkspaceAssets?.status.paths.characterBible;
            if (!characterBiblePath) throw new Error("The active workspace has no completed character bible path.");
            void shell.openPath(characterBiblePath).then((error) => {
              if (error) dialog.showErrorBox("Open Character Bible", error);
            });
          }
        } satisfies MenuItemConstructorOptions] : []),
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" }
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Asset Form Examples... / 资产表单示例",
          click: () => {
            const options = {
              type: "info" as const,
              title: "Asset Form Examples",
              message: "术语表与角色表输入示例",
              detail: [
                "术语表 / Glossary",
                "source: シンオウリーグ",
                "target: 神奥联盟",
                "aliases: 联盟",
                "info: 神奥地区的联盟组织",
                "status: confirmed",
                "",
                "角色表 / Character bible",
                "先从“选择已有角色”下拉框载入角色，或选择“新建角色”。",
                "name: シロナ",
                "target: 希罗娜",
                "aliases: 竹兰",
                "gender: female",
                "pronouns: 她",
                "confidence: confirmed",
                "terms of address: 冠军",
                "dialogue mappings（可添加多组）:",
                "  私 -> 我",
                "  あなた -> 你",
                "以后再次选择シロナ，即可继续追加其他台词译法。",
                "forbidden terms: 本小姐",
                "",
                "character_bible.md 会保存为：",
                "- Required dialogue mappings:",
                "  - 私 -> 我",
                "  - あなた -> 你"
              ].join("\n")
            };
            const owner = resolveMainAppWindow();
            void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
          }
        },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => {
            void checkForUpdatesManually();
          }
        },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false
        },
        { type: "separator" },
        {
          label: "GitHub Repository",
          click: () => {
            void shell.openExternal(repositoryUrl);
          }
        }
      ]
    }
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function readOpenLineReviewDocument(lineReviewPath: string, basePath?: string): Promise<LanSyncLineDocument | undefined> {
  const filePath = normalizeLinkedHtmlFilePath(lineReviewPath, basePath);
  if (!filePath) {
    return undefined;
  }
  const tab = [...htmlViewerTabs.values()].find((item) => sameFilePath(item.filePath, filePath));
  if (!tab || tab.view.webContents.isDestroyed()) {
    return undefined;
  }
  try {
    const payload = await tab.view.webContents.executeJavaScript(`
      (async () => {
        try {
          if (typeof restoreSyncedText === "function") {
            await restoreSyncedText();
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (typeof window.translationWorkshopLineLanSyncPayload === "function") {
            return window.translationWorkshopLineLanSyncPayload();
          }
          const sourceRows = Array.isArray(data?.rows) ? data.rows : [];
          const clonedState = JSON.parse(JSON.stringify(typeof state === "object" && state ? state : {}));
          const rows = sourceRows.map((row) => ({
            line: Number(row.line),
            source: String(row.source ?? ""),
            translation: typeof rowValue === "function" ? String(rowValue(row) ?? "") : String(row.translation ?? ""),
            status: String(clonedState.status?.[row.line] || row.status || "")
          })).filter((row) => Number.isInteger(row.line) && row.line > 0);
          return {
            title: document.title,
            rows,
            state: clonedState,
            pageSize: typeof pageSize === "number" ? pageSize : Number(data?.pageSize || 1000)
          };
        } catch (error) {
          return { error: String(error?.message || error), rows: [] };
        }
      })();
    `) as Partial<LanSyncLineDocument> & { error?: string };
    const rows = normalizeLanSyncRows(payload.rows);
    if (rows.length === 0) {
      return undefined;
    }
    return {
      title: typeof payload.title === "string" ? payload.title : path.basename(filePath),
      rows,
      state: normalizeLanSyncState(payload.state),
      pageSize: Number.isInteger(Number(payload.pageSize)) && Number(payload.pageSize) > 0 ? Number(payload.pageSize) : 1000,
      lineReviewPath: filePath
    };
  } catch {
    return undefined;
  }
}

async function persistLanSyncPatch(session: LanSyncSession, patch: LanSyncPatch): Promise<void> {
  await persistLanSyncDocumentPatch(session, patch, {
    persistLine: async (lineDocument, line) => {
      await applyLineReviewStateToView({
        lineReviewPath: lineDocument.lineReviewPath!,
        lineState: lineDocument.state,
        line,
        activate: false
      });
    },
    persistProposal: async (proposalDocument) => {
      const statePath = await htmlSidecarStatePath(proposalDocument.proposalReviewPath!, "proposal");
      if (!statePath) {
        throw new Error("Unable to resolve the proposal review sidecar state path.");
      }
      await writeHtmlSidecarState(statePath, proposalDocument.state);
    }
  });
}

function sendLanSyncPatchToOwner(session: LanSyncSession, patch: LanSyncPatch): void {
  webContents.fromId(session.ownerWebContentsId)?.send("lan-sync:patch", {
    token: session.token,
    patch
  });
}

function sendLanSyncCommandToOwner(session: LanSyncSession, command: LanSyncCommand): boolean {
  const owner = webContents.fromId(session.ownerWebContentsId);
  if (!owner || owner.isDestroyed()) return false;
  const ownerWindow = BrowserWindow.getAllWindows().find((window) => {
    return window.webContents.id === owner.id
      || window.getBrowserViews().some((view) => view.webContents.id === owner.id);
  });
  if (ownerWindow) {
    if (ownerWindow.isMinimized()) ownerWindow.restore();
    if (!electronVerificationHeadless) {
      ownerWindow.show();
      ownerWindow.focus();
    }
  }
  owner.send("lan-sync:command", { token: session.token, command });
  return true;
}

function mobileWorkspaceHtml(session: LanSyncSession): string {
  const initialLabels = lanSyncLabels(session.locale);
  const token = session.token;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>translation-workshop shared workspace</title>
  <style>
    :root { color-scheme: light; --ink:#26324d; --muted:#6d7893; --line:#cfe0f7; --sky:#77c8ff; --panel:#ffffffec; --bg:#edf8ff; }
    * { box-sizing:border-box; }
    body { margin:0; font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:linear-gradient(135deg,#f7fbff,#e8f8ff); }
    header { position:sticky; top:0; z-index:2; display:grid; gap:8px; padding:10px 12px; background:rgba(255,255,255,.92); border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    h1 { margin:0; font-size:15px; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .header-top { display:flex; align-items:center; gap:8px; min-width:0; }
    .header-top h1 { flex:1 1 auto; min-width:0; }
    .header-drawer { display:grid; gap:8px; }
    .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .gate { min-height:100vh; display:grid; place-items:center; padding:18px; }
    .gate-card { width:min(420px,100%); display:grid; gap:12px; padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:0 12px 30px rgba(95,111,191,.14); }
    .tabs { display:flex; gap:8px; flex:0 0 auto; }
    .tabs button.active { border-color:#77c8ff; background:#eaf8ff; font-weight:700; }
    button,input,textarea { font:inherit; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); padding:8px 10px; }
    button { min-height:38px; box-shadow:0 2px 0 rgba(119,200,255,.18); }
    .controls-toggle { flex:0 0 auto; width:40px; min-width:40px; padding:7px 8px; font-weight:800; }
    input { width:72px; }
    .search-box { display:flex; gap:8px; align-items:center; min-width:0; }
    .search-box input { width:min(520px,100%); flex:1 1 180px; }
    html, body, #app { width:100%; max-width:100%; min-width:0; }
    #app { min-height:100dvh; display:flex; flex-direction:column; }
    main { display:flex; flex-direction:column; flex:1 1 auto; gap:10px; padding:10px; width:100%; max-width:none; min-width:0; overflow-x:hidden; }
    article { display:flex; flex-direction:column; gap:8px; width:100%; max-width:none; min-width:0; padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); box-shadow:0 8px 20px rgba(95,111,191,.08); overflow:hidden; }
    .meta { display:flex; justify-content:space-between; gap:8px; min-width:0; color:var(--muted); font-size:12px; font-weight:700; }
    .meta span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .source, .field, .field div, textarea { width:100%; max-width:none; min-width:0; }
    .source { padding:10px; border-radius:8px; background:#f8fbff; white-space:pre-wrap; overflow-wrap:anywhere; }
    .field { display:flex; flex-direction:column; gap:4px; }
    .field b { color:var(--muted); font-size:12px; }
    .field div { padding:10px; border-radius:8px; background:#f8fbff; white-space:pre-wrap; overflow-wrap:anywhere; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    .actions button.active { border-color:#77c8ff; background:#eaf8ff; font-weight:700; }
    textarea { min-height:28vh; resize:vertical; line-height:1.55; overflow-wrap:anywhere; field-sizing:content; }
    select { font:inherit; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); padding:8px 10px; }
    .status { color:var(--muted); min-height:22px; }
    #agentPanel {
      position:fixed; inset:0; z-index:30;
      display:flex; flex-direction:column;
      width:100%; height:100dvh; min-height:100dvh;
      background:#f6f8fb; overflow:hidden;
    }
    #agentPanel[hidden] { display:none !important; }
    .agent-mobile-bar {
      flex:0 0 auto; display:flex; align-items:center; gap:8px;
      padding:8px 10px; padding-top:max(8px, env(safe-area-inset-top));
      border-bottom:1px solid var(--line); background:#fff;
    }
    .agent-mobile-bar strong { font-size:15px; }
    #agentBack { min-height:36px; }
    #remoteAgentRoot { flex:1 1 auto; min-height:0; width:100%; }
    #remoteAgentRoot .ynAgent { width:100%; height:100%; min-height:0; }
    body.agent-open { overflow:hidden; }
    @media (max-width: 640px) {
      header { gap:6px; padding:8px 10px; }
      .header-top h1 { display:none; }
      .tabs { flex:1 1 auto; min-width:0; }
      .tabs button { flex:1 1 0; min-width:0; padding:7px 8px; }
      .controls-toggle { min-height:36px; }
    }
    [hidden] { display:none !important; }
  </style>
</head>
<body>
  <section id="gate" class="gate">
    <form id="pinForm" class="gate-card">
      <h1 id="pinTitle">Enter PIN</h1>
      <p id="pinHelp" class="status">Use the fixed 6-digit PIN shown in the desktop app.</p>
      <input id="pinInput" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" placeholder="6-digit PIN" style="width:100%">
      <button id="unlockButton" type="submit">Unlock</button>
      <div class="status" id="pinStatus"></div>
    </form>
  </section>
  <section id="app" hidden>
  <header>
    <div class="header-top">
      <h1 id="title">translation-workshop</h1>
      <div class="tabs">
        <button id="lineTab" type="button">Line review</button>
        <button id="proposalTab" type="button">Proposal review</button>
      </div>
      <button id="controlsToggle" class="controls-toggle" type="button" aria-expanded="false">⌄</button>
    </div>
    <div id="headerDrawer" class="header-drawer" hidden>
      <div class="bar"><button id="openMobileAgent" type="button">Open Agent</button></div>
      <label class="search-box"><span id="searchLabel">Search</span><input id="searchInput" type="search"></label>
      <div class="bar">
        <button id="prev" type="button">Previous</button>
        <span><span id="pageLabel">Page</span> <input id="pageInput" type="number" min="1" value="1"></span>
        <button id="jump" type="button">Go</button>
        <button id="next" type="button">Next</button>
      </div>
      <div class="status" id="status">Loading...</div>
    </div>
  </header>
  <main id="rows"></main>
  <section id="agentPanel" hidden>
    <div class="agent-mobile-bar">
      <button id="agentBack" type="button">Back</button>
      <strong id="agentTitle">Agent</strong>
    </div>
    <div id="remoteAgentRoot"></div>
  </section>
  </section>
  <script>
const token = ${lanSyncJson(token)};
const clientId = globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random();
const authStorageKey = "translation-workshop:lan-auth:" + token;
let authToken = sessionStorage.getItem(authStorageKey) || "";
let labels = ${lanSyncJson(initialLabels)};
let session = {};
let lineDoc = null;
let proposalDoc = null;
let lineRows = [];
let lineState = {};
let proposalItems = [];
let proposalState = {};
let pageByKind = { line: 1, proposal: 1 };
let searchByKind = { line: "", proposal: "" };
let pageSize = 50;
let activeKind = "line";
const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const pageInput = document.getElementById("pageInput");
const searchInput = document.getElementById("searchInput");
const headerDrawer = document.getElementById("headerDrawer");
const controlsToggle = document.getElementById("controlsToggle");
const agentPanel = document.getElementById("agentPanel");
let agentMounted = false;
function t(key, fallback) { return labels[key] || fallback; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function rowValue(row) { return lineState.edits?.[row.line] ?? row.translation ?? ""; }
function recordLineRevision(line, text, status, source) {
  const key = String(line);
  lineState.revisions ||= {};
  lineState.revisionHistory ||= {};
  const revision = Number(lineState.revisions[key] || 0) + 1;
  lineState.revisions[key] = revision;
  const history = Array.isArray(lineState.revisionHistory[key]) ? lineState.revisionHistory[key] : [];
  const entry = { revision, text: String(text ?? ""), status: String(status || ""), source: String(source || "lan") };
  const last = history[history.length - 1];
  if (!last || last.text !== entry.text || last.status !== entry.status || last.source !== entry.source) history.push(entry);
  lineState.revisionHistory[key] = history.slice(-12);
}
function setStatus(text) { statusEl.textContent = text; }
function setControlsExpanded(expanded) {
  headerDrawer.hidden = !expanded;
  controlsToggle.textContent = expanded ? "⌃" : "⌄";
  controlsToggle.title = expanded ? t("controlsClose", "Hide tools") : t("controlsOpen", "Show tools");
  controlsToggle.setAttribute("aria-expanded", String(expanded));
}
function applyAuthLabels() {
  document.getElementById("pinTitle").textContent = t("pinTitle", "Enter PIN");
  document.getElementById("pinHelp").textContent = t("pinHelp", "Use the fixed 6-digit PIN shown in the desktop app.");
  document.getElementById("pinInput").placeholder = t("pinPlaceholder", "6-digit PIN");
  document.getElementById("unlockButton").textContent = t("unlock", "Unlock");
}
function authed(path) { return path + (path.includes("?") ? "&" : "?") + "auth=" + encodeURIComponent(authToken); }
let reviewScrollY = 0;
function setTab(kind) {
  const leavingAgent = activeKind === "agent" && kind !== "agent";
  const enteringAgent = kind === "agent" && activeKind !== "agent";
  if (enteringAgent) reviewScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  activeKind = kind;
  const agentActive = kind === "agent";
  rowsEl.hidden = agentActive;
  agentPanel.hidden = !agentActive;
  document.body.classList.toggle("agent-open", agentActive);
  searchInput.value = searchByKind[kind === "agent" ? (lineRows.length ? "line" : "proposal") : activeKind] || "";
  document.getElementById("lineTab").classList.toggle("active", kind === "line");
  document.getElementById("proposalTab").classList.toggle("active", kind === "proposal");
  if (agentActive) {
    setControlsExpanded(false);
    if (!agentMounted) {
      agentMounted = true;
      window.mountRemoteYnAgent(document.getElementById("remoteAgentRoot")).catch(error => {
        agentMounted = false;
        agentPanel.textContent = String(error?.message || error);
      });
    }
    return;
  }
  render();
  if (leavingAgent) requestAnimationFrame(() => window.scrollTo(0, reviewScrollY));
}
function activeSearch() {
  return String(searchByKind[activeKind] || "").trim().toLowerCase();
}
function lineSearchText(row) {
  return [row.line, row.source, rowValue(row), lineState.status?.[row.line] || row.status || ""].join("\\n").toLowerCase();
}
function proposalSearchText(item) {
  const decision = decisionFor(item);
  return [item.id, item.line, item.src, item.current, item.problemType, item.problem, item.suggestion, decision.status, decision.manualText].join("\\n").toLowerCase();
}
function filteredLineRows() {
  const q = activeSearch();
  return q ? lineRows.filter(row => lineSearchText(row).includes(q)) : lineRows;
}
function filteredProposalItems() {
  const q = activeSearch();
  return q ? proposalItems.filter(item => proposalSearchText(item).includes(q)) : proposalItems;
}
function renderLine() {
  const visibleRows = filteredLineRows();
  let page = Math.min(Math.max(1, pageByKind.line || 1), Math.max(1, Math.ceil(visibleRows.length / pageSize)));
  pageByKind.line = page;
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  pageInput.value = page;
  const pageRows = visibleRows.slice((page - 1) * pageSize, page * pageSize);
  setStatus(t("lineTab", "Line review") + " · " + t("page", "Page") + " " + page + " / " + totalPages + " · " + t("total", "Total") + ": " + visibleRows.length + " / " + lineRows.length);
  rowsEl.innerHTML = pageRows.length ? pageRows.map(row => '<article data-line="' + row.line + '">' +
    '<div class="meta"><span>' + t("line", "Line") + ' ' + row.line + '</span><span>' + escapeHtml(lineState.status?.[row.line] || row.status || "") + '</span></div>' +
    '<div class="source">' + escapeHtml(row.source) + '</div>' +
    '<textarea spellcheck="false">' + escapeHtml(rowValue(row)) + '</textarea>' +
  '</article>').join("") : '<article>' + escapeHtml(activeSearch() ? t("searchNoMatches", "No matches.") : t("empty", "No document in this shared session.")) + '</article>';
}
function decisionFor(item) {
  const raw = proposalState.decisions?.[item.id] || { status: item.status || "unreviewed", manualText: "" };
  const manualText = String(raw.manualText || "");
  if (manualText.trim()) return { status: "manual", manualText };
  if (raw.status === "accepted" || raw.status === "rejected") return { status: raw.status, manualText: "" };
  if (String(item.suggestion || "").trim()) return { status: "accepted", manualText: "" };
  return { status: raw.status || "unreviewed", manualText: "" };
}
function renderProposal() {
  const proposalPageSize = Math.min(80, Math.max(10, Math.floor(Number(proposalDoc?.pageSize || 1000) / 20) || 50));
  const visibleItems = filteredProposalItems();
  let page = Math.min(Math.max(1, pageByKind.proposal || 1), Math.max(1, Math.ceil(visibleItems.length / proposalPageSize)));
  pageByKind.proposal = page;
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / proposalPageSize));
  pageInput.value = page;
  const pageItems = visibleItems.slice((page - 1) * proposalPageSize, page * proposalPageSize);
  setStatus(t("proposalTab", "Proposal review") + " · " + t("page", "Page") + " " + page + " / " + totalPages + " · " + t("total", "Total") + ": " + visibleItems.length + " / " + proposalItems.length);
  rowsEl.innerHTML = pageItems.length ? pageItems.map(item => {
    const decision = decisionFor(item);
    return '<article data-proposal-id="' + escapeHtml(item.id) + '">' +
      '<div class="meta"><span>' + escapeHtml(item.id) + '</span><span>' + t("line", "Line") + ' ' + escapeHtml(item.line || "?") + ' · ' + escapeHtml(decision.status || t("unreviewed", "Unreviewed")) + '</span></div>' +
      '<div class="field"><b>' + t("source", "Source") + '</b><div>' + escapeHtml(item.src || "") + '</div></div>' +
      '<div class="field"><b>' + t("current", "Current translation") + '</b><div>' + escapeHtml(item.current || "") + '</div></div>' +
      '<div class="field"><b>' + t("issueType", "Issue type") + '</b><div>' + escapeHtml(item.problemType || "") + '</div></div>' +
      '<div class="field"><b>' + t("issue", "Issue") + '</b><div>' + escapeHtml(item.problem || "") + '</div></div>' +
      '<div class="field"><b>' + t("suggestion", "Suggested fix") + '</b><div>' + escapeHtml(item.suggestion || "") + '</div></div>' +
      '<textarea spellcheck="false" placeholder="' + t("manual", "Manual edit") + '">' + escapeHtml(decision.manualText || "") + '</textarea>' +
      '<div class="actions"><button data-action="accepted" class="' + (decision.status === "accepted" ? "active" : "") + '">' + t("accept", "Accept") + '</button>' +
      '<button data-action="rejected" class="' + (decision.status === "rejected" ? "active" : "") + '">' + t("reject", "Reject") + '</button>' +
      '<button data-action="manual" class="' + (decision.status === "manual" ? "active" : "") + '">' + t("manual", "Manual edit") + '</button></div>' +
    '</article>';
  }).join("") : '<article>' + escapeHtml(activeSearch() ? t("searchNoMatches", "No matches.") : t("empty", "No document in this shared session.")) + '</article>';
}
function render() {
  if (activeKind === "agent") return;
  if (activeKind === "proposal") renderProposal();
  else renderLine();
}
async function postPatch(patch) {
  const response = await fetch(authed("/api/patch/" + encodeURIComponent(token)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...patch, clientId, timestamp: new Date().toISOString() })
  });
  if (!response.ok) throw new Error(await response.text() || t("syncFailed", "Could not sync change."));
  return response.json();
}
let timers = new Map();
rowsEl.addEventListener("input", event => {
  if (activeKind === "proposal") {
    const textarea = event.target.closest("textarea");
    if (!textarea) return;
    const proposalId = textarea.closest("article")?.dataset.proposalId || "";
    if (!proposalId) return;
    proposalState.decisions ||= {};
    proposalState.decisions[proposalId] = { status: "manual", manualText: textarea.value };
    clearTimeout(timers.get("proposal:" + proposalId));
    timers.set("proposal:" + proposalId, setTimeout(() => {
      postPatch({ type: "proposal-decision", proposalId, status: "manual", manualText: textarea.value })
        .then(() => setStatus(t("saved", "Synced")))
        .catch(error => setStatus(String(error?.message || error)));
    }, 300));
    return;
  }
  const textarea = event.target.closest("textarea");
  if (!textarea) return;
  const line = Number(textarea.closest("article")?.dataset.line || 0);
  if (!line) return;
  lineState.edits ||= {};
  lineState.status ||= {};
  lineState.edits[line] = textarea.value;
  lineState.status[line] = "manual";
  recordLineRevision(line, textarea.value, "manual", "lan-edit");
  clearTimeout(timers.get(line));
  timers.set(line, setTimeout(() => {
    postPatch({ type: "line-edit", line, text: textarea.value, status: "manual" })
      .then(() => setStatus(t("saved", "Synced")))
      .catch(error => setStatus(String(error?.message || error)));
  }, 300));
});
rowsEl.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || activeKind !== "proposal") return;
  const article = button.closest("article");
  const proposalId = article?.dataset.proposalId || "";
  if (!proposalId) return;
  const manualText = article.querySelector("textarea")?.value || "";
  const status = button.dataset.action || "manual";
  proposalState.decisions ||= {};
  proposalState.decisions[proposalId] = { status, manualText };
  render();
  postPatch({ type: "proposal-decision", proposalId, status, manualText })
    .then(() => setStatus(t("saved", "Synced")))
    .catch(error => setStatus(String(error?.message || error)));
});
function applyPatch(patch) {
  if (!patch || patch.clientId === clientId) return;
  if (patch.type === "proposal-decision") {
    const proposalId = String(patch.proposalId || "");
    if (!proposalId) return;
    proposalState.decisions ||= {};
    proposalState.decisions[proposalId] = { status: patch.status || "manual", manualText: patch.manualText || "" };
    if (activeKind === "proposal") render();
    return;
  }
  const line = Number(patch.line || 0);
  if (!line) return;
  lineState.edits ||= {};
  lineState.status ||= {};
  if (patch.type === "line-restore") {
    delete lineState.edits[line];
    delete lineState.status[line];
    recordLineRevision(line, rowValue({ line }), "", "remote-restore");
  } else {
    lineState.edits[line] = String(patch.text ?? "");
    lineState.status[line] = patch.status || "manual";
    recordLineRevision(line, lineState.edits[line], lineState.status[line], "remote-edit");
  }
  const visible = rowsEl.querySelector('article[data-line="' + line + '"] textarea');
  if (visible && document.activeElement !== visible) visible.value = rowValue({ line });
}
async function authenticate(pin) {
  const result = await fetch("/api/auth/" + encodeURIComponent(token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin })
  });
  if (!result.ok) throw new Error(t("pinFailed", "PIN verification failed."));
  const payload = await result.json();
  authToken = payload.authToken || "";
  if (!authToken) throw new Error(t("pinFailed", "PIN verification failed."));
  sessionStorage.setItem(authStorageKey, authToken);
}
async function boot() {
  const loaded = await fetch(authed("/api/session/" + encodeURIComponent(token)));
  if (loaded.status === 401 || loaded.status === 403) {
    sessionStorage.removeItem(authStorageKey);
    authToken = "";
    document.getElementById("gate").hidden = false;
    document.getElementById("app").hidden = true;
    return;
  }
  session = await loaded.json();
  labels = session.labels || {};
  lineDoc = session.documents?.line || null;
  proposalDoc = session.documents?.proposal || null;
  lineRows = lineDoc?.rows || [];
  lineState = lineDoc?.state || {};
  proposalItems = proposalDoc?.proposals || [];
  proposalState = proposalDoc?.state || {};
  pageSize = Math.min(100, Math.max(20, Math.floor(Number(lineDoc?.pageSize || session.pageSize || 1000) / 10) || 50));
  document.getElementById("title").textContent = session.title || t("title", "translation-workshop mobile review");
  document.getElementById("prev").textContent = t("previous", "Previous");
  document.getElementById("next").textContent = t("next", "Next");
  document.getElementById("pageLabel").textContent = t("page", "Page");
  document.getElementById("searchLabel").textContent = t("search", "Search");
  searchInput.placeholder = t("searchPlaceholder", "Search source, translation, issue, or suggestion");
  document.getElementById("jump").textContent = t("go", "Go");
  document.getElementById("lineTab").textContent = t("lineTab", "Line review");
  document.getElementById("proposalTab").textContent = t("proposalTab", "Proposal review");
  document.getElementById("openMobileAgent").textContent = t("openMobileAgent", "Open Agent");
  document.getElementById("agentBack").textContent = t("agentBack", "Back");
  document.getElementById("agentTitle").textContent = t("agentTab", "Agent");
  setControlsExpanded(false);
  document.getElementById("lineTab").hidden = lineRows.length === 0;
  document.getElementById("proposalTab").hidden = proposalItems.length === 0;
  activeKind = proposalItems.length > 0 && lineRows.length === 0 ? "proposal" : "line";
  document.getElementById("gate").hidden = true;
  document.getElementById("app").hidden = false;
  setTab(activeKind);
  render();
  const events = new EventSource(authed("/events/" + encodeURIComponent(token)));
  events.addEventListener("patch", event => applyPatch(JSON.parse(event.data).patch));
  events.onerror = () => setStatus(t("offline", "Disconnected"));
}
document.getElementById("prev").onclick = () => { pageByKind[activeKind] = (pageByKind[activeKind] || 1) - 1; render(); scrollTo(0, 0); };
document.getElementById("next").onclick = () => { pageByKind[activeKind] = (pageByKind[activeKind] || 1) + 1; render(); scrollTo(0, 0); };
document.getElementById("jump").onclick = () => { pageByKind[activeKind] = Number(pageInput.value || 1); render(); scrollTo(0, 0); };
searchInput.addEventListener("input", () => {
  searchByKind[activeKind] = searchInput.value || "";
  pageByKind[activeKind] = 1;
  render();
  scrollTo(0, 0);
});
document.getElementById("lineTab").onclick = () => setTab("line");
document.getElementById("proposalTab").onclick = () => setTab("proposal");
document.getElementById("openMobileAgent").onclick = () => setTab("agent");
document.getElementById("agentBack").onclick = () => setTab(lineRows.length ? "line" : "proposal");
window.addEventListener("yn-remote-agent-close", () => setTab(lineRows.length ? "line" : "proposal"));
controlsToggle.onclick = () => setControlsExpanded(headerDrawer.hidden);
document.getElementById("pinForm").addEventListener("submit", async event => {
  event.preventDefault();
  const pin = String(document.getElementById("pinInput").value || "").trim();
  if (!/^\\d{6}$/.test(pin)) {
    document.getElementById("pinStatus").textContent = t("pinInvalid", "PIN must be 6 digits.");
    return;
  }
  try {
    await authenticate(pin);
    await boot();
  } catch (error) {
    document.getElementById("pinStatus").textContent = error?.message || String(error);
  }
});
applyAuthLabels();
boot().catch(error => {
  document.getElementById("gate").hidden = false;
  document.getElementById("app").hidden = true;
  document.getElementById("pinStatus").textContent = String(error?.message || error);
});
  </script>
  <script>${lanAgentBridgeScript(token, { outputDir: `lan:${token}`, locale: session.locale })}</script>
  <link rel="stylesheet" href="/agent-assets/agent.css">
  <script type="module" src="/agent-assets/agent-embedded.js"></script>
</body>
</html>`;
}

async function lanSyncUrls(token: string): Promise<{ localUrl: string; lanUrls: string[] }> {
  const preferredAddress = await detectDefaultRouteIpv4Address();
  return buildLanSyncUrls(token, lanSyncPort, os.networkInterfaces(), preferredAddress);
}

async function ensureLanSyncServer(): Promise<void> {
  if (lanSyncServer?.listening) {
    return;
  }
  lanSyncServer = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        lanSyncResponse(res, 204, "", "text/plain; charset=utf-8");
        return;
      }
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const parts = url.pathname.split("/");
      const route = parts[1] || "";
      if (req.method === "GET" && route === "agent-assets") {
        const requested = decodeURIComponent(parts.slice(2).join("/"));
        if (!requested || path.basename(requested) !== requested) {
          lanSyncResponse(res, 400, "Invalid asset path.", "text/plain; charset=utf-8");
          return;
        }
        const assetsDir = path.join(app.getAppPath(), "dist", "renderer", "assets");
        const files = await readdir(assetsDir);
        const fileName = requested === "agent-embedded.js"
          ? files.find((file) => file.startsWith("agent-embedded-") && file.endsWith(".js"))
          : requested === "agent.css"
            ? files.find((file) => file.startsWith("styles-") && file.endsWith(".css"))
            : files.includes(requested) ? requested : undefined;
        if (!fileName) {
          lanSyncResponse(res, 404, "Agent asset not found.", "text/plain; charset=utf-8");
          return;
        }
        const contentType = fileName.endsWith(".css")
          ? "text/css; charset=utf-8"
          : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
        lanSyncResponse(res, 200, await readFile(path.join(assetsDir, fileName), "utf8"), contentType);
        return;
      }
      if (req.method === "GET" && (route === "" || route === "index.html")) {
        const sessions = [...lanSyncSessions.values()];
        if (sessions.length === 1) {
          res.writeHead(302, {
            "Location": `/s/${encodeURIComponent(sessions[0].token)}`,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          });
          res.end();
          return;
        }
        lanSyncResponse(res, 200, lanSyncLandingHtml(lanSyncSessions.values()), "text/html; charset=utf-8");
        return;
      }
      const token = route === "api" ? parts[3] : parts[2];
      const session = token ? lanSyncSessions.get(decodeURIComponent(token)) : undefined;
      if (!session) {
        if (req.method === "GET" && (route === "s" || route === "")) {
          lanSyncResponse(res, 404, lanSyncSessionNotFoundHtml(url.pathname, lanSyncSessions.values()), "text/html; charset=utf-8");
          return;
        }
        lanSyncResponse(res, 404, "Session not found.", "text/plain; charset=utf-8");
        return;
      }
      if (req.method === "GET" && route === "s") {
        lanSyncResponse(res, 200, mobileWorkspaceHtml(session), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "POST" && route === "api" && url.pathname.includes("/api/auth/")) {
        const body = await readLanSyncBody(req) as { pin?: unknown };
        if (!isValidLanSyncPin(body.pin) || hashLanSyncPin(body.pin) !== session.pinHash) {
          lanSyncResponse(res, 403, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        const authToken = randomBytes(18).toString("base64url");
        session.authTokens.add(authToken);
        lanSyncResponse(res, 200, lanSyncJson({ ok: true, authToken }), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "GET" && route === "api" && url.pathname.includes("/api/session/")) {
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        lanSyncResponse(res, 200, lanSyncJson(lanSyncSessionPayload(session)), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "GET" && route === "events") {
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url))) {
          lanSyncResponse(res, 401, "Unauthorized.", "text/plain; charset=utf-8");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Keep-Alive": "timeout=120",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": "*"
        });
        res.socket?.setKeepAlive(true, 15_000);
        session.clients.add(res);
        res.write(`event: hello\ndata: ${lanSyncJson({ ok: true })}\n\n`);
        const heartbeat = setInterval(() => {
          if (res.destroyed) return;
          res.write(`: heartbeat ${Date.now()}\n\n`);
        }, 15_000);
        const cleanup = () => {
          clearInterval(heartbeat);
          session.clients.delete(res);
        };
        res.once("close", cleanup);
        res.once("error", cleanup);
        return;
      }
      if (req.method === "POST" && route === "api" && url.pathname.includes("/api/patch/")) {
        const body = await readLanSyncBody(req) as Partial<LanSyncPatch> & { authToken?: unknown };
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url, body))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        const patch: LanSyncPatch = {
          type: body.type === "proposal-decision" ? "proposal-decision" : body.type === "line-restore" ? "line-restore" : "line-edit",
          line: Number(body.line || 0),
          proposalId: typeof body.proposalId === "string" ? body.proposalId : undefined,
          text: typeof body.text === "string" ? body.text : "",
          status: typeof body.status === "string" ? body.status : "manual",
          manualText: typeof body.manualText === "string" ? body.manualText : "",
          overrideConflict: typeof body.overrideConflict === "boolean" ? body.overrideConflict : undefined,
          conflictReason: typeof body.conflictReason === "string" ? body.conflictReason : undefined,
          clientId: typeof body.clientId === "string" ? body.clientId : "remote",
          timestamp: typeof body.timestamp === "string" ? body.timestamp : new Date().toISOString()
        };
        await commitLanSyncPatch(session, patch, persistLanSyncPatch, (committedSession, committedPatch) => {
          sendLanSyncPatchToOwner(committedSession, committedPatch);
          broadcastLanSyncPatch(committedSession, committedPatch);
        });
        lanSyncResponse(res, 200, lanSyncJson({ ok: true }), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST" && route === "api" && url.pathname.includes("/api/agent/")) {
        const body = await readLanSyncBody(req) as { authToken?: unknown } & Record<string, unknown>;
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url, body))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        const request = normalizeLanAgentRequest(body);
        if (!request) {
          lanSyncResponse(res, 400, lanSyncJson({ ok: false, message: "Unsupported Agent request." }), "application/json; charset=utf-8");
          return;
        }
        const result = await lanAgentGateway.invoke(session.outputDir, request);
        lanSyncResponse(res, 200, lanSyncJson(result), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST" && route === "api" && url.pathname.includes("/api/command/")) {
        const body = await readLanSyncBody(req) as { authToken?: unknown } & Record<string, unknown>;
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url, body))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        const command = normalizeLanSyncCommand(body);
        if (!command) {
          lanSyncResponse(res, 400, lanSyncJson({ ok: false, message: "Unsupported command." }), "application/json; charset=utf-8");
          return;
        }
        if (!sendLanSyncCommandToOwner(session, command)) {
          lanSyncResponse(res, 409, lanSyncJson({ ok: false, message: "Desktop workspace is unavailable." }), "application/json; charset=utf-8");
          return;
        }
        lanSyncResponse(res, 200, lanSyncJson({ ok: true }), "application/json; charset=utf-8");
        return;
      }
      lanSyncResponse(res, 404, "Not found.", "text/plain; charset=utf-8");
    } catch (error) {
      lanSyncResponse(res, 500, String((error as Error)?.message || error), "text/plain; charset=utf-8");
    }
  });
  await new Promise<void>((resolve, reject) => {
    lanSyncServer?.once("error", reject);
    lanSyncServer?.listen(0, "0.0.0.0", () => {
      lanSyncServer?.off("error", reject);
      lanSyncPort = (lanSyncServer?.address() as AddressInfo).port;
      resolve();
    });
  });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureWorkspace(outputDir: string): Promise<string> {
  const workspaceDir = path.join(outputDir, ".translation-workshop");
  await Promise.all([
    mkdir(path.join(workspaceDir, "backups"), { recursive: true }),
    mkdir(path.join(workspaceDir, "reports"), { recursive: true }),
    mkdir(path.join(workspaceDir, "html"), { recursive: true })
  ]);
  return workspaceDir;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProjectFolder(targetPath: string): { outputDir: string; workspaceDir: string } {
  if (path.basename(targetPath).toLowerCase() === ".translation-workshop") {
    return { outputDir: path.dirname(targetPath), workspaceDir: targetPath };
  }
  return { outputDir: targetPath, workspaceDir: path.join(targetPath, ".translation-workshop") };
}

async function findLatestHtml(htmlDir: string): Promise<string> {
  const candidates: HtmlCandidate[] = [];
  async function visit(folderPath: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(folderPath, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
        return;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".html")) {
        return;
      }
      const info = await stat(fullPath);
      candidates.push({ path: fullPath, modifiedMs: info.mtimeMs, depth });
    }));
  }
  await visit(htmlDir, 0);
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs || left.depth - right.depth || left.path.localeCompare(right.path));
  return candidates[0]?.path ?? "";
}

async function existingHtmlPath(candidate: unknown, workspaceDir: string): Promise<string> {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return "";
  }
  const normalized = normalizeLinkedHtmlFilePath(candidate);
  const candidates = [
    normalized,
    normalized ? path.join(workspaceDir, "html", path.basename(normalized)) : ""
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (!isSameOrInside(workspaceDir, filePath)) continue;
    try {
      if ((await stat(filePath)).isFile()) return filePath;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

async function htmlSidecarStatePath(filePath: string, kind: "line" | "proposal"): Promise<string> {
  if (kind === "line") return resolveLineReviewSidecarStatePath(filePath);
  const workspaceDir = workspaceDirFromKnownPath(filePath);
  return workspaceDir ? path.join(workspaceDir, "state", `${kind}-${path.basename(filePath)}.json`) : "";
}

async function writeHtmlSidecarState(statePath: string, state: unknown): Promise<void> {
  const key = path.resolve(statePath).toLowerCase();
  const previous = htmlStateWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeTextFileAtomically(statePath, JSON.stringify(state ?? {}, null, 2));
  });
  htmlStateWriteQueues.set(key, current);
  try {
    await current;
  } finally {
    if (htmlStateWriteQueues.get(key) === current) htmlStateWriteQueues.delete(key);
  }
}

async function updateHtmlSidecarState(
  statePath: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>
): Promise<Record<string, unknown>> {
  const key = path.resolve(statePath).toLowerCase();
  const previous = htmlStateWriteQueues.get(key) ?? Promise.resolve();
  let updated: Record<string, unknown> = {};
  const current = previous.catch(() => undefined).then(async () => {
    const existing = await readJsonObject(statePath) ?? {};
    updated = update(existing);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeTextFileAtomically(statePath, JSON.stringify(updated, null, 2));
  });
  htmlStateWriteQueues.set(key, current);
  try {
    await current;
    return updated;
  } finally {
    if (htmlStateWriteQueues.get(key) === current) htmlStateWriteQueues.delete(key);
  }
}

async function ensureTransactionalTextTarget(filePath: string, initialText: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await writeFile(filePath, initialText, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
  }
}

function broadcastLineReviewState(payload: Record<string, unknown>): void {
  for (const tab of htmlViewerTabs.values()) {
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.send("html:lineReviewStateUpdate", payload);
    }
  }
}

async function drainHtmlSidecarStateWrites(): Promise<void> {
  while (htmlStateWriteQueues.size > 0) {
    await Promise.all([...htmlStateWriteQueues.values()]);
  }
}

async function withHtmlStateWriteLocks<T>(statePaths: string[], task: () => Promise<T>): Promise<T> {
  const keys = [...new Set(statePaths.map((statePath) => path.resolve(statePath).toLowerCase()))].sort();
  const locks = keys.map((key) => {
    const previous = htmlStateWriteQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => held);
    htmlStateWriteQueues.set(key, tail);
    return { key, previous, release, tail };
  });
  await Promise.all(locks.map((lock) => lock.previous.catch(() => undefined)));
  try {
    return await task();
  } finally {
    for (const lock of locks) lock.release();
    for (const lock of locks) {
      if (htmlStateWriteQueues.get(lock.key) === lock.tail) htmlStateWriteQueues.delete(lock.key);
    }
  }
}

async function isLineReviewHtml(targetPath: string | undefined): Promise<boolean> {
  return targetPath ? hasLineReviewDataScript(targetPath) : false;
}

async function findLinkedLineReviewHtml(outputDir: string, explicitPath?: string): Promise<string | undefined> {
  const { workspaceDir } = normalizeProjectFolder(outputDir);
  const state = await readJsonObject(path.join(workspaceDir, "state.json"));
  const project = await readJsonObject(path.join(workspaceDir, "project.json"));
  const latestLineReview = (await discoverProjectReviewTargets(workspaceDir)).lineReviewHtml;
  const candidates = [
    explicitPath,
    typeof state?.lastHtml === "string" ? state.lastHtml : undefined,
    typeof project?.lineReviewPath === "string" ? project.lineReviewPath : undefined,
    typeof project?.lastLineReviewHtml === "string" ? project.lastLineReviewHtml : undefined,
    latestLineReview
  ];
  for (const candidate of candidates) {
    const linked = await lineReviewCandidateInWorkspace(candidate, workspaceDir);
    if (linked) return linked;
  }
  return undefined;
}

function normalizedProposalDocumentId(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/").toLowerCase() : "";
}

function validProposalDocumentId(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  return Boolean(normalized)
    && !path.isAbsolute(normalized)
    && !normalized.split("/").some((part) => part === "..");
}

async function proposalRoutingFromReport(args: ResolveProposalLineReviewDocumentArgs): Promise<{
  documentId: string;
  sourcePath: string;
  translationPath?: string;
  proposals: ReviewProposal[];
}> {
  if (!args.reportPath || !path.isAbsolute(args.reportPath)) {
    throw new Error("An absolute proofread report path is required.");
  }
  const reportText = await readFile(args.reportPath, "utf8");
  const proposals = parseProofreadReport(reportText, args.reportPath);
  if (proposals.length === 0) throw new Error("The proofread report has no findings to route.");
  let folderScopeRoot = "";
  let folderReport = false;
  if (reportText.trimStart().startsWith("{")) {
    try {
      const report = JSON.parse(reportText) as {
        schemaVersion?: unknown;
        scope?: { kind?: unknown; sourcePath?: unknown };
        findings?: unknown;
      };
      if (report.schemaVersion === "2.0") {
        folderReport = true;
        if (report.scope?.kind !== "folder" || typeof report.scope.sourcePath !== "string" || !path.isAbsolute(report.scope.sourcePath)) {
          throw new Error("Folder proofread report has an invalid absolute folder scope.");
        }
        folderScopeRoot = path.resolve(report.scope.sourcePath);
        const outputDir = typeof args.outputDir === "string" && path.isAbsolute(args.outputDir)
          ? path.resolve(args.outputDir)
          : "";
        if (!outputDir) throw new Error("Folder proofread routing requires an absolute project output directory.");
        const extractedRoot = outputDir
          ? path.join(normalizeProjectFolder(outputDir).workspaceDir, "extracted-text")
          : "";
        if (!Array.isArray(report.findings)) {
          throw new Error("Folder proofread report findings must be an array.");
        }
        const routeByDocumentId = new Map<string, { sourcePath: string; translationPath: string }>();
        for (const [index, rawFinding] of report.findings.entries()) {
          if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) {
            throw new Error(`Folder proofread finding ${index + 1} is not an object.`);
          }
          const finding = rawFinding as Record<string, unknown>;
          const documentId = typeof finding.documentId === "string" ? finding.documentId : "";
          const sourcePath = typeof finding.sourcePath === "string" && path.isAbsolute(finding.sourcePath)
            ? path.resolve(finding.sourcePath)
            : "";
          const translationPath = typeof finding.translationPath === "string" && path.isAbsolute(finding.translationPath)
            ? path.resolve(finding.translationPath)
            : "";
          if (!validProposalDocumentId(documentId) || !sourcePath || !(
            isSameOrInside(folderScopeRoot, sourcePath)
            || Boolean(extractedRoot && isSameOrInside(extractedRoot, sourcePath))
          )) {
            throw new Error(`Folder proofread finding is outside its declared document scope: ${documentId || sourcePath || "unknown"}`);
          }
          if (!translationPath || !isSameOrInside(outputDir, translationPath)) {
            throw new Error(`Folder proofread finding has an invalid project translation path: ${documentId || "unknown"}`);
          }
          const routeKey = normalizedProposalDocumentId(documentId);
          const previousRoute = routeByDocumentId.get(routeKey);
          if (previousRoute && (
            !sameFilePath(previousRoute.sourcePath, sourcePath)
            || !sameFilePath(previousRoute.translationPath, translationPath)
          )) {
            throw new Error(`Folder proofread document id maps to multiple file routes: ${documentId}`);
          }
          routeByDocumentId.set(routeKey, { sourcePath, translationPath });
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Proofread findings JSON is invalid.", { cause: error });
      throw error;
    }
  }
  const requestedId = normalizedProposalDocumentId(args.documentId);
  const requestedSource = typeof args.sourcePath === "string" && path.isAbsolute(args.sourcePath)
    ? path.resolve(args.sourcePath)
    : "";
  const matching = proposals.filter((item) => {
    const itemId = normalizedProposalDocumentId(item.documentId);
    const itemSource = typeof item.sourcePath === "string" && path.isAbsolute(item.sourcePath)
      ? path.resolve(item.sourcePath)
      : "";
    return requestedId ? itemId === requestedId : requestedSource ? sameFilePath(itemSource, requestedSource) : true;
  });
  const routed = matching[0];
  if (!routed) throw new Error(`Proofread document was not found in the aggregate report: ${args.documentId || args.sourcePath || "unknown"}`);
  const sourcePath = typeof routed.sourcePath === "string" && path.isAbsolute(routed.sourcePath)
    ? path.resolve(routed.sourcePath)
    : requestedSource;
  if (!sourcePath) throw new Error("The proofread finding is missing its absolute source path.");
  const documentId = String(routed.documentId || args.documentId || path.basename(sourcePath));
  const routedTranslationPath = typeof routed.translationPath === "string" && path.isAbsolute(routed.translationPath)
    ? path.resolve(routed.translationPath)
    : undefined;
  const translationPath = folderReport
    ? routedTranslationPath
    : routedTranslationPath ?? (typeof args.translationPath === "string" && path.isAbsolute(args.translationPath)
      ? path.resolve(args.translationPath)
      : undefined);
  if (folderReport && !translationPath) {
    throw new Error(`Folder proofread finding is missing its absolute translation path: ${documentId}`);
  }
  if (folderScopeRoot && !validProposalDocumentId(documentId)) {
    throw new Error(`Folder proofread document id is invalid: ${documentId}`);
  }
  if (requestedSource && !sameFilePath(requestedSource, sourcePath)) {
    throw new Error(`Proofread document source does not match its aggregate report route: ${documentId}`);
  }
  const requestedTranslation = typeof args.translationPath === "string" && path.isAbsolute(args.translationPath)
    ? path.resolve(args.translationPath)
    : "";
  if (requestedTranslation && translationPath && !sameFilePath(requestedTranslation, translationPath)) {
    throw new Error(`Proofread document translation does not match its aggregate report route: ${documentId}`);
  }
  return { documentId, sourcePath, ...(translationPath ? { translationPath } : {}), proposals: matching };
}

function proposalLineRows(proposals: ReviewProposal[]): LanSyncLineRow[] {
  const rows = new Map<number, LanSyncLineRow>();
  for (const proposal of proposals) {
    const line = Number(proposal.line);
    if (!Number.isInteger(line) || line <= 0) continue;
    const row = {
      line,
      source: String(proposal.src ?? ""),
      translation: String(proposal.current ?? "")
    };
    const previous = rows.get(line);
    if (previous && (previous.source !== row.source || previous.translation !== row.translation)) {
      throw new Error(`Proofread report has divergent source or translation text at line ${line}.`);
    }
    rows.set(line, row);
  }
  return [...rows.values()].sort((left, right) => left.line - right.line);
}

async function proposalLineReviewCandidates(outputDir: string, explicitPath?: string): Promise<string[]> {
  const { workspaceDir } = normalizeProjectFolder(outputDir);
  const [state, project, discovered] = await Promise.all([
    readJsonObject(path.join(workspaceDir, "state.json")),
    readJsonObject(path.join(workspaceDir, "project.json")),
    discoverProjectReviewTargets(workspaceDir)
  ]);
  return [...new Set([
    explicitPath,
    typeof state?.lastHtml === "string" ? state.lastHtml : undefined,
    typeof project?.lineReviewPath === "string" ? project.lineReviewPath : undefined,
    typeof project?.lastLineReviewHtml === "string" ? project.lastLineReviewHtml : undefined,
    discovered.lineReviewHtml
  ].filter((value): value is string => Boolean(value && path.isAbsolute(value))))];
}

function normalizedLineReviewRouting(paths: Record<string, unknown>): {
  sourcePaths: string[];
  translationPaths: string[];
} {
  const absolute = (names: string[]) => [...new Set(names
    .map((name) => paths[name])
    .filter((value): value is string => typeof value === "string" && path.isAbsolute(value))
    .map((value) => path.resolve(value)))];
  return {
    sourcePaths: absolute(["sourcePath", "validationSourcePath", "sourcePromptPath"]),
    translationPaths: absolute(["translationPath", "editableTranslationPath", "translationPromptPath"])
  };
}

async function lineReviewRouting(lineReviewPath: string): Promise<{ sourcePaths: string[]; translationPaths: string[] }> {
  const html = await readFile(lineReviewPath, "utf8");
  const match = html.match(/<script id=["']reviewData["'] type=["']application\/json["']>([\s\S]*?)<\/script>/i);
  if (!match) return { sourcePaths: [], translationPaths: [] };
  const parsed = JSON.parse(match[1]) as { workflow?: { paths?: Record<string, unknown> } };
  const routing = normalizedLineReviewRouting(parsed.workflow?.paths ?? {});
  const statePath = await resolveLineReviewSidecarStatePath(lineReviewPath);
  const state = statePath ? await readOptionalJsonObjectStrict(statePath) : undefined;
  const sidecarTranslationPaths = [state?.translationPath, state?.translationPromptPath]
    .filter((value): value is string => typeof value === "string" && path.isAbsolute(value))
    .map((value) => path.resolve(value));
  return {
    sourcePaths: routing.sourcePaths,
    translationPaths: [...new Map([...routing.translationPaths, ...sidecarTranslationPaths].map((value) => [
      process.platform === "win32" ? value.toLowerCase() : value,
      value
    ])).values()]
  };
}

async function openLineReviewRouting(lineReviewPath: string): Promise<{
  sourcePaths: string[];
  translationPaths: string[];
} | undefined> {
  const tab = [...htmlViewerTabs.values()].find((item) => (
    sameFilePath(item.filePath, lineReviewPath) && !item.view.webContents.isDestroyed()
  ));
  if (!tab) return undefined;
  if (tab.loadPromise) await tab.loadPromise;
  const paths = await tab.view.webContents.executeJavaScript(`(() => {
    if (typeof workflow !== "object" || !workflow || typeof workflow.paths !== "object" || !workflow.paths) return null;
    return workflow.paths;
  })()`);
  return paths && typeof paths === "object" && !Array.isArray(paths)
    ? normalizedLineReviewRouting(paths as Record<string, unknown>)
    : undefined;
}

function assertLineReviewRoutingBinding(
  binding: { sourcePaths: string[]; translationPaths: string[] },
  routing: { documentId: string; sourcePath: string; translationPath?: string }
): void {
  if (!binding.sourcePaths.some((candidate) => sameFilePath(candidate, routing.sourcePath))) {
    throw new Error(
      `Line-review HTML is not bound to proofread document ${routing.documentId}: expected ${routing.sourcePath}; got ${binding.sourcePaths.join(", ") || "no source binding"}.`
    );
  }
  if (routing.translationPath && !binding.translationPaths.some((candidate) => sameFilePath(candidate, routing.translationPath))) {
    throw new Error(`Line-review HTML translation is not bound to proofread document ${routing.documentId}.`);
  }
}

async function assertLineReviewMatchesProposalRouting(
  lineReviewPath: string,
  routing: { documentId: string; sourcePath: string; translationPath?: string }
): Promise<void> {
  const binding = await lineReviewRouting(lineReviewPath);
  assertLineReviewRoutingBinding(binding, routing);
}

interface EmbeddedLineReviewWorkflow {
  inputMode?: unknown;
  promptInputMode?: unknown;
  paths?: Record<string, unknown>;
  glossaryEntries?: unknown;
  bilingualPair?: unknown;
  epubExport?: unknown;
  advanced?: unknown;
}

interface BatchProposalSynchronizationPlan {
  documentId: string;
  sourcePath: string;
  translationPath: string;
  translationLineCount: number;
  childPath: string;
  html: string;
  statePath?: string;
  stateText?: string;
  legacyPaths: string[];
}

interface LegacyProposalLineReviewArtifact {
  htmlPath: string;
  statePath: string;
  state?: Record<string, unknown>;
  translationPath?: string;
  modifiedMs: number;
}

function lineReviewPayloadFromHtml(html: string, lineReviewPath: string): {
  workflow?: EmbeddedLineReviewWorkflow;
} {
  const match = html.match(/<script id=["']reviewData["'] type=["']application\/json["']>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error(`Line-review HTML is missing reviewData: ${lineReviewPath}`);
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("reviewData is not an object");
    }
    return parsed as { workflow?: EmbeddedLineReviewWorkflow };
  } catch (error) {
    throw new Error(`Line-review HTML has invalid reviewData: ${lineReviewPath}`, { cause: error });
  }
}

function embeddedWorkflowPath(workflow: EmbeddedLineReviewWorkflow | undefined, key: string): string | undefined {
  const value = workflow?.paths?.[key];
  return typeof value === "string" && value.trim() && !value.startsWith("[") ? value : undefined;
}

async function readOptionalJsonObjectStrict(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Line-review state is invalid JSON: ${filePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Line-review state is not an object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

async function existingFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function discoverLegacyProposalLineReviews(
  outputDir: string
): Promise<LegacyProposalLineReviewArtifact[]> {
  const workspaceDir = normalizeProjectFolder(outputDir).workspaceDir;
  const legacyDir = path.join(workspaceDir, "html", "proposal-line-review");
  let entries;
  try {
    entries = await readdir(legacyDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".html")
    .map(async (entry): Promise<LegacyProposalLineReviewArtifact> => {
      const htmlPath = path.join(legacyDir, entry.name);
      const statePath = await resolveLineReviewSidecarStatePath(htmlPath);
      const [html, htmlInfo, stateInfo] = await Promise.all([
        readFile(htmlPath, "utf8"),
        stat(htmlPath),
        stat(statePath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        })
      ]);
      const state = await readOptionalJsonObjectStrict(statePath).catch((error) => {
        console.warn(`[proposal-migration] Ignoring invalid duplicate state ${statePath}`, error);
        return undefined;
      });
      const workflow = (() => {
        try {
          return lineReviewPayloadFromHtml(html, htmlPath).workflow;
        } catch (error) {
          console.warn(`[proposal-migration] Duplicate HTML has no readable route ${htmlPath}`, error);
          return undefined;
        }
      })();
      const htmlBinding = embeddedWorkflowPath(workflow, "translationPath")
        ?? embeddedWorkflowPath(workflow, "editableTranslationPath");
      const stateBinding = typeof state?.translationPath === "string"
        && path.isAbsolute(state.translationPath)
        ? path.resolve(state.translationPath)
        : undefined;
      return {
        htmlPath,
        statePath,
        state,
        translationPath: htmlBinding && path.isAbsolute(htmlBinding)
          ? path.resolve(htmlBinding)
          : stateBinding,
        modifiedMs: Math.max(htmlInfo.mtimeMs, stateInfo?.mtimeMs ?? 0)
      };
    }));
}

async function migrateLegacySingleProposalLineReviews(
  outputDir: string,
  canonicalPath: string,
  routing: { documentId: string; sourcePath: string; translationPath?: string }
): Promise<number> {
  const workspaceDir = normalizeProjectFolder(outputDir).workspaceDir;
  const legacyDir = path.join(workspaceDir, "html", "proposal-line-review");
  if (isSameOrInside(legacyDir, canonicalPath)) return 0;

  const matching: LegacyProposalLineReviewArtifact[] = [];
  for (const artifact of await discoverLegacyProposalLineReviews(outputDir)) {
    if (sameFilePath(artifact.htmlPath, canonicalPath)) continue;
    try {
      await assertLineReviewMatchesProposalRouting(artifact.htmlPath, routing);
      matching.push(artifact);
    } catch {
      // This duplicate belongs to another source/translation pair.
    }
  }
  if (matching.length === 0) return 0;

  const canonicalStatePath = await resolveLineReviewSidecarStatePath(canonicalPath);
  let canonicalState = await readOptionalJsonObjectStrict(canonicalStatePath) ?? {};
  matching.sort((left, right) => left.modifiedMs - right.modifiedMs
    || left.htmlPath.localeCompare(right.htmlPath));
  for (const artifact of matching) {
    if (artifact.state) canonicalState = mergeLegacyProposalLineReviewState(canonicalState, artifact.state);
  }
  canonicalState = {
    ...canonicalState,
    ...(routing.translationPath ? {
      translationPath: routing.translationPath,
      translationPromptPath: routing.translationPath
    } : {})
  };
  await ensureTransactionalTextTarget(canonicalStatePath, "{}\n");
  await writeTextFileAtomically(canonicalStatePath, `${JSON.stringify(canonicalState, null, 2)}\n`);
  broadcastLineReviewState({
    ok: true,
    path: canonicalStatePath,
    lineReviewPath: canonicalPath,
    state: canonicalState,
    changedLines: [],
    changedStateKeys: ["translationPath", "translationPromptPath"]
  });

  let removed = 0;
  for (const artifact of matching) {
    for (const artifactPath of [artifact.htmlPath, artifact.statePath]) {
      if (!await existingFile(artifactPath)) continue;
      await rm(artifactPath);
      removed += 1;
    }
  }
  try {
    if ((await readdir(legacyDir)).length === 0) await rm(legacyDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.info("[proposal-migration] Merged duplicate single-file line-review state", {
    canonicalPath,
    duplicateCount: matching.length,
    removedArtifactCount: removed
  });
  return removed;
}

function proposalLineReviewArtifactPath(
  outputDir: string,
  routing: { documentId: string; sourcePath: string; translationPath?: string }
): string {
  const workspaceDir = normalizeProjectFolder(outputDir).workspaceDir;
  const digest = createHash("sha256")
    .update(`${routing.sourcePath}\0${routing.translationPath ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const safeName = path.basename(routing.documentId).replace(/[^A-Za-z0-9._-]+/g, "-") || "document.txt";
  return path.join(workspaceDir, "html", "proposal-line-review", `${digest}-${safeName}.html`);
}

async function planCanonicalBatchChildState(args: {
  outputDir: string;
  routing: { documentId: string; sourcePath: string; translationPath: string };
  childPath: string;
  translationPromptPath?: string;
  legacyArtifacts: LegacyProposalLineReviewArtifact[];
}): Promise<Pick<BatchProposalSynchronizationPlan, "statePath" | "stateText" | "legacyPaths">> {
  const canonicalStatePath = await resolveLineReviewSidecarStatePath(args.childPath);
  const canonicalState = canonicalStatePath
    ? await readOptionalJsonObjectStrict(canonicalStatePath) ?? {}
    : {};
  const currentBinding = typeof canonicalState.translationPath === "string" && path.isAbsolute(canonicalState.translationPath)
    ? path.resolve(canonicalState.translationPath)
    : undefined;
  if (currentBinding && !sameFilePath(currentBinding, args.routing.translationPath)) {
    throw new Error(
      `Canonical batch child ${args.routing.documentId} has a conflicting sidecar translation binding: ${currentBinding}.`
    );
  }

  const exactLegacyPath = proposalLineReviewArtifactPath(args.outputDir, args.routing);
  if (sameFilePath(exactLegacyPath, args.childPath)) return { legacyPaths: [] };
  const legacyArtifacts = args.legacyArtifacts
    .filter((artifact) => artifact.translationPath
      && sameFilePath(artifact.translationPath, args.routing.translationPath)
      && !sameFilePath(artifact.htmlPath, args.childPath));
  if (!legacyArtifacts.some((artifact) => sameFilePath(artifact.htmlPath, exactLegacyPath))) {
    const exactStatePath = await resolveLineReviewSidecarStatePath(exactLegacyPath);
    const [htmlExists, exactState, htmlInfo, stateInfo] = await Promise.all([
      existingFile(exactLegacyPath),
      readOptionalJsonObjectStrict(exactStatePath),
      stat(exactLegacyPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }),
      stat(exactStatePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      })
    ]);
    if (htmlExists || exactState) {
      legacyArtifacts.push({
        htmlPath: exactLegacyPath,
        statePath: exactStatePath,
        state: exactState,
        translationPath: args.routing.translationPath,
        modifiedMs: Math.max(htmlInfo?.mtimeMs ?? 0, stateInfo?.mtimeMs ?? 0)
      });
    }
  }
  if (legacyArtifacts.length === 0) return { legacyPaths: [] };

  legacyArtifacts.sort((left, right) => left.modifiedMs - right.modifiedMs
    || left.htmlPath.localeCompare(right.htmlPath));
  let mergedState = canonicalState;
  for (const artifact of legacyArtifacts) {
    if (artifact.state) {
      mergedState = mergeLegacyProposalLineReviewState(mergedState, artifact.state);
    }
  }
  mergedState = {
    ...mergedState,
    translationPath: args.routing.translationPath,
    ...(args.translationPromptPath ? { translationPromptPath: args.translationPromptPath } : {})
  };
  return {
    statePath: canonicalStatePath,
    stateText: `${JSON.stringify(mergedState, null, 2)}\n`,
    legacyPaths: legacyArtifacts.flatMap((artifact) => [artifact.htmlPath, artifact.statePath])
  };
}

async function buildSynchronizedBatchChild(args: {
  outputDir: string;
  documentId: string;
  sourcePath: string;
  translationPath: string;
  childPath: string;
  locale: UiLocale;
  legacyArtifacts: LegacyProposalLineReviewArtifact[];
}): Promise<BatchProposalSynchronizationPlan> {
  const workspaceDir = normalizeProjectFolder(args.outputDir).workspaceDir;
  const existingHtml = await readFile(args.childPath, "utf8");
  const payload = lineReviewPayloadFromHtml(existingHtml, args.childPath);
  const workflow = payload.workflow;
  const sourceBinding = embeddedWorkflowPath(workflow, "sourcePath");
  if (!sourceBinding || !sameFilePath(sourceBinding, args.sourcePath)) {
    throw new Error(`Batch child ${args.documentId} is not bound to its indexed source file.`);
  }
  const [sourceDocument, translationDocument] = await Promise.all([
    readLineDocumentForWorkflow(args.sourcePath, "auto", workspaceDir, "source"),
    readTranslationDocumentForWorkflow(args.translationPath, workspaceDir)
  ]);
  const sourceLineCount = splitTextLines(sourceDocument.text).length;
  const translationLineCount = splitTextLines(translationDocument.text).length;
  if (sourceLineCount !== translationLineCount) {
    throw new Error(
      `Cannot synchronize ${args.documentId}: source has ${sourceLineCount} lines but translation has ${translationLineCount}.`
    );
  }
  const editableTranslationPath = translationDocument.kind === "epub"
    ? translationDocument.promptPath
    : args.translationPath;
  const promptSourcePath = embeddedWorkflowPath(workflow, "promptSourcePath")
    ?? sourceDocument.promptPath
    ?? args.sourcePath;
  const promptTranslationPath = embeddedWorkflowPath(workflow, "promptTranslationPath")
    ?? translationDocument.promptPath
    ?? editableTranslationPath;
  const rendered = renderLineReviewHtml({
    title: `${args.documentId} line review`,
    sourceText: sourceDocument.text,
    translationText: translationDocument.text,
    pageSize: 1000,
    locale: args.locale,
    lineReviewPath: args.childPath,
    workflow: {
      sourcePath: args.sourcePath,
      validationSourcePath: embeddedWorkflowPath(workflow, "validationSourcePath")
        ?? sourceDocument.promptPath
        ?? args.sourcePath,
      sourceKind: workflow?.paths?.sourceKind === "folder" ? "folder" : "file",
      translationPath: args.translationPath,
      editableTranslationPath,
      sourcePromptPath: promptSourcePath,
      promptSourceKind: workflow?.paths?.promptSourceKind === "folder" ? "folder" : "file",
      translationPromptPath: promptTranslationPath,
      outputDir: args.outputDir,
      glossaryPath: embeddedWorkflowPath(workflow, "glossaryPath"),
      glossaryEntries: Array.isArray(workflow?.glossaryEntries)
        ? workflow.glossaryEntries as GlossaryEntry[]
        : [],
      inputMode: workflow?.inputMode === "bilingual" ? "bilingual" : "separate",
      promptInputMode: workflow?.promptInputMode === "bilingual" ? "bilingual" : "separate",
      advanced: workflow?.advanced && typeof workflow.advanced === "object"
        ? workflow.advanced as PromptAdvancedOptions
        : undefined,
      bilingualPair: workflow?.bilingualPair && typeof workflow.bilingualPair === "object"
        ? workflow.bilingualPair as { sourcePosition: number; translationPosition: number; pairSize?: 2 }
        : undefined,
      epubExport: workflow?.epubExport && typeof workflow.epubExport === "object"
        ? workflow.epubExport as { mode: "all" | "pair-position"; replacePosition?: number; pairSize?: number }
        : undefined
    }
  });
  const statePlan = await planCanonicalBatchChildState({
    outputDir: args.outputDir,
    routing: args,
    childPath: args.childPath,
    translationPromptPath: translationDocument.promptPath ?? editableTranslationPath,
    legacyArtifacts: args.legacyArtifacts
  });
  return {
    documentId: args.documentId,
    sourcePath: args.sourcePath,
    translationPath: args.translationPath,
    translationLineCount,
    childPath: args.childPath,
    html: rendered,
    ...statePlan
  };
}

async function synchronizeBatchProposalLineReviews(args: {
  outputDir: string;
  batchIndexPath: string;
  locale: UiLocale;
  onlyDocumentId?: string;
  routeOverrides?: Map<string, { sourcePath: string; translationPath: string }>;
}): Promise<{ synchronized: number; migrated: number }> {
  const workspaceDir = normalizeProjectFolder(args.outputDir).workspaceDir;
  if (!isSameOrInside(workspaceDir, args.batchIndexPath)) {
    throw new Error("The batch line-review index is outside the current project workspace.");
  }
  const children = await readBatchLineReviewCurrentBindings(args.batchIndexPath);
  const requestedKey = normalizedProposalDocumentId(args.onlyDocumentId);
  const selected = requestedKey
    ? children.filter((child) => normalizedProposalDocumentId(child.documentId) === requestedKey)
    : children;
  if (requestedKey && selected.length !== 1) {
    throw new Error(`Batch line-review index does not own document ${args.onlyDocumentId}.`);
  }
  const legacyArtifacts = await discoverLegacyProposalLineReviews(args.outputDir);
  const plans = await Promise.all(selected.map(async (child) => {
    const override = args.routeOverrides?.get(normalizedProposalDocumentId(child.documentId));
    if (override && !sameFilePath(override.sourcePath, child.sourcePath)) {
      throw new Error(`Proofread report source does not match batch child ${child.documentId}.`);
    }
    if (override && child.translationBinding === "explicit"
      && !sameFilePath(override.translationPath, child.translationPath)) {
      throw new Error(`Proofread report translation does not match the current batch child ${child.documentId}.`);
    }
    const translationPath = override?.translationPath ?? child.translationPath;
    return buildSynchronizedBatchChild({
      outputDir: args.outputDir,
      documentId: child.documentId,
      sourcePath: child.sourcePath,
      translationPath,
      childPath: child.childPath,
      locale: args.locale,
      legacyArtifacts
    });
  }));
  const indexHtml = await readFile(args.batchIndexPath, "utf8");
  const boundIndexHtml = bindBatchLineReviewTranslations(indexHtml, plans.map((plan) => ({
    documentId: plan.documentId,
    translationPath: plan.translationPath,
    translationLineCount: plan.translationLineCount
  })));
  for (const plan of plans) {
    if (plan.statePath && plan.stateText) await ensureTransactionalTextTarget(plan.statePath, "{}\n");
  }
  await writeTextFilesAtomically([
    ...plans.map((plan) => ({ targetPath: plan.childPath, text: plan.html })),
    { targetPath: args.batchIndexPath, text: boundIndexHtml },
    ...plans.flatMap((plan) => plan.statePath && plan.stateText
      ? [{ targetPath: plan.statePath, text: plan.stateText }]
      : [])
  ]);
  const cleanupPaths = [...new Set(plans.flatMap((plan) => plan.legacyPaths)
    .filter((candidate) => !plans.some((plan) => sameFilePath(plan.childPath, candidate))))];
  let migrated = 0;
  for (const cleanupPath of cleanupPaths) {
    if (await existingFile(cleanupPath)) {
      await rm(cleanupPath);
      migrated += 1;
    }
  }
  const legacyDir = path.join(workspaceDir, "html", "proposal-line-review");
  try {
    if ((await readdir(legacyDir)).length === 0) await rm(legacyDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tab = [...htmlViewerTabs.values()].find((item) => sameFilePath(item.filePath, args.batchIndexPath));
  if (tab && !tab.view.webContents.isDestroyed()) {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        tab.view.webContents.removeListener("did-fail-load", failed);
        resolve();
      };
      const failed = (_event: Electron.Event, errorCode: number, errorDescription: string) => {
        tab.view.webContents.removeListener("did-finish-load", done);
        reject(new Error(`Failed to reload synchronized batch review: ${errorCode} ${errorDescription}`));
      };
      tab.view.webContents.once("did-finish-load", done);
      tab.view.webContents.once("did-fail-load", failed);
      tab.view.webContents.reloadIgnoringCache();
    });
  }
  return { synchronized: plans.length, migrated };
}

async function existingProposalLineReview(
  outputDir: string,
  explicitPath: string | undefined,
  routing: { documentId: string; sourcePath: string; translationPath?: string },
  locale: UiLocale
): Promise<string | undefined> {
  for (const candidate of await proposalLineReviewCandidates(outputDir, explicitPath)) {
    if (await isLineReviewHtml(candidate)) {
      try {
        await assertLineReviewMatchesProposalRouting(candidate, routing);
      } catch {
        // This line-review document belongs to another report item.
        continue;
      }
      await migrateLegacySingleProposalLineReviews(outputDir, candidate, routing);
      return candidate;
    }
    let children: Awaited<ReturnType<typeof readBatchLineReviewChildren>>;
    try {
      children = await readBatchLineReviewChildren(candidate);
    } catch (error) {
      if (explicitPath && sameFilePath(candidate, explicitPath)) {
        throw new Error(`The linked batch line-review index is invalid: ${candidate}`, { cause: error });
      }
      // Not a batch line-review index.
      continue;
    }
    const match = children.find((child) => (
      normalizedProposalDocumentId(child.documentId) === normalizedProposalDocumentId(routing.documentId)
      || sameFilePath(child.sourcePath, routing.sourcePath)
    ));
    if (match && await isLineReviewHtml(match.childPath)) {
      try {
        await assertLineReviewMatchesProposalRouting(match.childPath, routing);
        return match.childPath;
      } catch {
        if (!routing.translationPath) {
          throw new Error(`Proofread document ${routing.documentId} is missing its translation route.`);
        }
      }
      await synchronizeBatchProposalLineReviews({
        outputDir,
        batchIndexPath: candidate,
        locale,
        onlyDocumentId: match.documentId,
        routeOverrides: new Map([[normalizedProposalDocumentId(match.documentId), {
          sourcePath: routing.sourcePath,
          translationPath: routing.translationPath
        }]])
      });
      await assertLineReviewMatchesProposalRouting(match.childPath, routing);
      return match.childPath;
    }
  }
  return undefined;
}

async function generateProposalLineReview(
  outputDir: string,
  routing: { documentId: string; sourcePath: string; translationPath?: string },
  locale: UiLocale
): Promise<string> {
  const workspaceDir = await ensureWorkspace(outputDir);
  const sourceDocument = await readLineDocumentForWorkflow(routing.sourcePath, "auto", workspaceDir, "source");
  const translationDocument = routing.translationPath
    ? await readTranslationDocumentForWorkflow(routing.translationPath, workspaceDir)
    : undefined;
  const editableTranslationPath = translationDocument?.kind === "epub"
    ? translationDocument.promptPath
    : routing.translationPath;
  const lineReviewPath = proposalLineReviewArtifactPath(outputDir, routing);
  await mkdir(path.dirname(lineReviewPath), { recursive: true });
  await writeTextFileAtomically(lineReviewPath, renderLineReviewHtml({
    title: `${routing.documentId} line review`,
    sourceText: sourceDocument.text,
    translationText: translationDocument?.text,
    pageSize: 1000,
    locale,
    lineReviewPath,
    workflow: {
      sourcePath: routing.sourcePath,
      validationSourcePath: sourceDocument.promptPath ?? routing.sourcePath,
      sourceKind: "file",
      translationPath: routing.translationPath,
      editableTranslationPath,
      sourcePromptPath: sourceDocument.promptPath,
      translationPromptPath: translationDocument?.promptPath ?? editableTranslationPath,
      outputDir,
      inputMode: "separate",
      epubExport: routing.sourcePath.toLowerCase().endsWith(".epub") ? { mode: "all" } : undefined
    }
  }));
  return lineReviewPath;
}

async function readProposalLineReviewDocument(
  lineReviewPath: string,
  rows: LanSyncLineRow[] = []
): Promise<LanSyncLineDocument> {
  const document = await readLinkedLineReviewDocument(lineReviewPath, undefined, { includeRows: false });
  if (!document) throw new Error(`Line-review document could not be read: ${lineReviewPath}`);
  document.rows = rows;
  const statePath = await resolveLineReviewSidecarStatePath(lineReviewPath);
  document.state = statePath ? await readJsonObject(statePath) ?? {} : {};
  document.lineReviewPath = lineReviewPath;
  return document;
}

function stripHtmlHash(value: string): string {
  const htmlHashIndex = value.toLowerCase().indexOf(".html#");
  if (htmlHashIndex >= 0) {
    return value.slice(0, htmlHashIndex + ".html".length);
  }
  return value.replace(/#.*$/, "");
}

function filePathFromPathLike(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const raw = stripHtmlHash(value.trim());
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      const pathname = decodeURIComponent(url.pathname || "");
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return undefined;
    }
  }
  return raw;
}

function workspaceDirFromKnownPath(value: string | undefined): string | undefined {
  const filePath = filePathFromPathLike(value);
  if (!filePath) {
    return undefined;
  }
  const parts = path.resolve(filePath).split(/[\\/]+/);
  const workspaceIndex = parts.map((part) => part.toLowerCase()).lastIndexOf(".translation-workshop");
  return workspaceIndex >= 0 ? parts.slice(0, workspaceIndex + 1).join(path.sep) : undefined;
}

function isSameOrInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFilePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function lineReviewCandidateInWorkspace(candidate: string | undefined, workspaceDir: string | undefined): Promise<string | undefined> {
  const filePath = filePathFromPathLike(candidate);
  if (!filePath) {
    return undefined;
  }
  const canonicalBatchIndex = await canonicalBatchLineReviewIndexPath(filePath);
  const resolvedPath = canonicalBatchIndex ?? filePath;
  if (!canonicalBatchIndex && !(await isLineReviewHtml(resolvedPath))) return undefined;
  return workspaceDir && !isSameOrInside(workspaceDir, resolvedPath) ? undefined : resolvedPath;
}

async function findLineReviewForProposalHtml(
  targetPath: string,
  links: { reportPath?: string; lineReviewPath?: string },
  outputDir?: string
): Promise<string | undefined> {
  const explicitWorkspace = outputDir?.trim() ? normalizeProjectFolder(outputDir).workspaceDir : undefined;
  const workspaceHints = [
    explicitWorkspace,
    workspaceDirFromKnownPath(targetPath),
    workspaceDirFromKnownPath(links.reportPath),
    workspaceDirFromKnownPath(links.lineReviewPath)
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  for (const workspaceDir of workspaceHints) {
    const existing = await lineReviewCandidateInWorkspace(links.lineReviewPath, workspaceDir);
    if (existing) {
      return existing;
    }
    const linked = await findLinkedLineReviewHtml(workspaceDir, undefined);
    if (linked) {
      return linked;
    }
  }

  return lineReviewCandidateInWorkspace(links.lineReviewPath, undefined);
}

async function repairProposalReviewHtmlLineReviewPath(targetPath: string, outputDir?: string): Promise<boolean> {
  const filePath = filePathFromPathLike(targetPath);
  if (!filePath) {
    return false;
  }
  let html = "";
  try {
    html = await readFile(filePath, "utf8");
  } catch {
    return false;
  }
  const links = embeddedProposalLinks(html);
  if (!links) {
    return false;
  }
  const lineReviewPath = await findLineReviewForProposalHtml(filePath, links, outputDir);
  if (!lineReviewPath || sameFilePath(filePathFromPathLike(links.lineReviewPath), lineReviewPath)) {
    return false;
  }
  const rewritten = rewriteProposalReviewLineReviewPathContent(html, path.basename(filePath), lineReviewPath);
  if (rewritten) {
    await writeFile(filePath, rewritten, "utf8");
    return true;
  }
  return false;
}

async function findProofreadReportCandidates(outputDir: string): Promise<ProofreadReportCandidate[]> {
  const candidates: Array<{ path: string; size: number; modifiedMs: number; content: string }> = [];
  async function visit(folderPath: string, depth: number): Promise<void> {
    if (depth > 5) {
      return;
    }
    let entries;
    try {
      entries = await readdir(folderPath, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      if (entry.name === "node_modules" || entry.name === ".git") {
        return;
      }
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
        return;
      }
      if (!entry.isFile() || !/\.(?:md|json)$/i.test(entry.name)) {
        return;
      }
      const info = await stat(fullPath);
      const content = await readFile(fullPath, "utf8");
      candidates.push({ path: fullPath, size: info.size, modifiedMs: info.mtimeMs, content });
    }));
  }
  await visit(outputDir, 0);
  return rankProofreadReportCandidates(candidates).filter((candidate) => candidate.score >= 40).slice(0, 20);
}

function buildReportFormatRepairPrompt(reportPath: string, locale: UiLocale): string {
  if (locale === "en-US") {
    return [
      "Please reorganize this proofreading report file in place:",
      reportPath,
      "",
      "This file looks like a proofreading / fix proposal report, but its finding blocks do not match the structured report protocol, so translation-workshop cannot parse it.",
      "",
      "Do not proofread the translation again. Only reorganize the existing report content.",
      "Do not omit any reported issue.",
      "Directly overwrite the same Markdown file after fixing the format.",
      "Every issue must use a global source line number L<N>.",
      "If the report contains chunk-local, batch-local, Bxxx, rawxxx, or similar internal IDs, convert them to global source line numbers L<N>.",
      "`Source` and `Current translation` must be the full exact row text. If the existing report only has a fragment, re-read that global line and fill the complete row.",
      "Final finding IDs must be unique. If any Hx/Mx/Lx ID is duplicated, renumber duplicates after the current max for that code.",
      "",
      "Each finding must use this structure:",
      "",
      "### H1-001 | MC L123",
      "**Source**: `<source text verbatim>`",
      "**Current translation**: `<current translation verbatim>`",
      "**Issue**: <brief explanation>",
      "**Suggested fix**: `<complete replacement in target language>`",
      "- [ ] Accept suggestion",
      "",
      "Use `Chunk 001 L123` for split mode and `MC L123` for montecarlo mode.",
      "Write all report prose in the target language; keep fixed parser labels in the required format."
    ].join("\n");
  }

  return [
    "请就地重新整理这个校对报告文件：",
    reportPath,
    "",
    "该文件看起来像 proofreading / fix proposal 报告，但问题条目的 block 格式与结构化报告协议不符，translation-workshop 无法解析。",
    "",
    "请不要重新校对译文，只基于现有报告内容重排格式。",
    "不要遗漏任何已报告的问题。",
    "修正格式后直接覆盖同一个 Markdown 文件。",
    "每条问题都必须使用全局源文行号 L<N>。",
    "如果报告里出现 chunk-local、batch-local、Bxxx、rawxxx 等内部编号，请换算为全局源文行号 L<N>。",
    "`Source` 和 `Current translation` 必须是该行完整原文和完整当前译文。如果现有报告只有片段，请重新读取对应全局行并补全整行。",
    "最终 finding 编号必须唯一。如果 Hx/Mx/Lx 编号重复，请接在该 code 当前最大编号后继续递增。",
    "",
    "每条 finding 必须使用这种结构：",
    "",
    "### H1-001 | MC L123",
    "**Source**: `<source text verbatim>`",
    "**Current translation**: `<current translation verbatim>`",
    "**Issue**: <brief explanation>",
    "**Suggested fix**: `<complete replacement in target language>`",
    "- [ ] Accept suggestion",
    "",
    "split 模式使用 `Chunk 001 L123`，montecarlo 模式使用 `MC L123`。",
    "所有报告正文使用目标语言书写；固定字段名保持格式要求。"
  ].join("\n");
}

function resolveLineFileType(filePath: string, fileType: GenerateLineHtmlArgs["fileType"]): "txt" | "epub" {
  const ext = path.extname(filePath).toLowerCase();
  const resolved = fileType === "auto" ? (ext === ".epub" ? "epub" : ext === ".txt" ? "txt" : ext.replace(".", "")) : fileType;
  if (resolved !== "txt" && resolved !== "epub") {
    throw new Error(`Line review supports txt and epub files. ${resolved || "unknown"} is not supported here.`);
  }
  return resolved;
}

function splitLines(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").replace(/\r$/, "").replace(/\n$/, "").split("\n");
}

function blankAlignedTranslationText(sourceText: string): string {
  return splitLines(sourceText).map(() => "").join("\n");
}

async function writeExtractedPromptText(
  workspaceDir: string,
  filePath: string,
  role: "source" | "translation",
  text: string
): Promise<string> {
  const extractedPath = extractedWorkshopTextPath(workspaceDir, filePath, role);
  await mkdir(path.dirname(extractedPath), { recursive: true });
  await writeFile(extractedPath, text, "utf8");
  return extractedPath;
}

function assertLineFolderMode(fileType: GenerateLineHtmlArgs["fileType"]): void {
  if (fileType !== "auto" && fileType !== "txt" && fileType !== "epub") {
    throw new Error(`Folder generation supports txt and epub files. ${fileType} is not supported here.`);
  }
}

function assertBilingualMode(fileType: GenerateLineHtmlArgs["fileType"]): void {
  if (fileType !== "auto" && fileType !== "txt" && fileType !== "epub") {
    throw new Error(`Bilingual generation supports adjacent bilingual txt and epub files. ${fileType} is not supported here.`);
  }
}

function resolveBilingualFileKind(filePath: string, fileType: GenerateLineHtmlArgs["fileType"]): BilingualFileKind {
  const ext = path.extname(filePath).toLowerCase();
  const resolved = fileType === "auto" ? (ext === ".epub" ? "epub" : ext === ".txt" ? "txt" : ext.replace(".", "")) : fileType;
  if (resolved !== "txt" && resolved !== "epub") {
    throw new Error(`Bilingual generation supports adjacent bilingual txt and epub files. ${resolved || "unknown"} is not supported here.`);
  }
  return resolved;
}

function normalizeBilingualPosition(value: number | undefined, fallback: 1 | 2): 1 | 2 {
  return value === 1 ? 1 : value === 2 ? 2 : fallback;
}

function htmlSafeName(name: string, index: number): string {
  return `${String(index + 1).padStart(3, "0")}-${name.replace(/[^a-z0-9._-]+/gi, "_").replace(/\.(txt|epub)$/i, "")}.html`;
}

async function isDirectory(targetPath: string | undefined): Promise<boolean> {
  if (!targetPath) {
    return false;
  }
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function readLineDocument(filePath: string, fileType: GenerateLineHtmlArgs["fileType"], workspaceDir: string): Promise<string> {
  const resolved = resolveLineFileType(filePath, fileType);
  if (resolved === "txt") {
    return readFile(filePath, "utf8");
  }
  return readEpubText(filePath, workspaceDir, `${timestamp()}-${path.basename(filePath)}`);
}

async function readLineDocumentForWorkflow(
  filePath: string,
  fileType: GenerateLineHtmlArgs["fileType"],
  workspaceDir: string,
  role: "source" | "translation"
): Promise<{ text: string; kind: "txt" | "epub"; promptPath?: string }> {
  const kind = resolveLineFileType(filePath, fileType);
  const text = await readLineDocument(filePath, kind, workspaceDir);
  const promptPath = kind === "epub" ? await writeExtractedPromptText(workspaceDir, filePath, role, text) : undefined;
  return { text, kind, promptPath };
}

async function readTranslationDocumentForWorkflow(
  filePath: string,
  workspaceDir: string
): Promise<{ text: string; kind: "txt" | "epub"; promptPath?: string }> {
  return readLineDocumentForWorkflow(filePath, "auto", workspaceDir, "translation");
}

async function parseBilingualDocument(
  filePath: string,
  fileType: GenerateLineHtmlArgs["fileType"],
  workspaceDir: string,
  sourcePosition: number,
  translationPosition: number
): Promise<{
  sourceText: string;
  translationText: string;
  rowCount: number;
  kind: BilingualFileKind;
  sourcePromptPath?: string;
  translationPromptPath?: string;
}> {
  const kind = resolveBilingualFileKind(filePath, fileType);
  const text = await readLineDocument(filePath, kind, workspaceDir);
  const parsed = parseBilingualPairs(text, { sourcePosition, translationPosition });
  if (kind !== "epub") {
    return { ...parsed, kind };
  }
  const [sourcePromptPath, translationPromptPath] = await Promise.all([
    writeExtractedPromptText(workspaceDir, filePath, "source", parsed.sourceText),
    writeExtractedPromptText(workspaceDir, filePath, "translation", parsed.translationText)
  ]);
  return { ...parsed, kind, sourcePromptPath, translationPromptPath };
}

async function loadGlossaryEntries(glossaryPath: string | undefined): Promise<GlossaryEntry[]> {
  if (!glossaryPath) {
    return [];
  }
  try {
    const source = await readFile(glossaryPath, "utf8");
    const entries = parseGlossaryText(source);
    if (source.trim() && entries.length === 0) {
      throw new Error("the selected file contains no parseable source/target entries");
    }
    return entries;
  } catch (error) {
    throw new Error(`Failed to load selected glossary: ${glossaryPath}`, { cause: error });
  }
}

async function backupFile(targetPath: string, outputDir?: string): Promise<string | undefined> {
  try {
    await stat(targetPath);
  } catch {
    return undefined;
  }
  const workspaceDir = outputDir && path.isAbsolute(outputDir)
    ? await ensureWorkspace(outputDir)
    : path.join(path.dirname(targetPath), ".translation-workshop");
  await mkdir(path.join(workspaceDir, "backups"), { recursive: true });
  const backupPath = buildTimestampedBackupPath(targetPath, workspaceDir);
  await copyFile(targetPath, backupPath);
  return backupPath;
}

async function writeBoundTranslationText(args: WriteTextFileArgs): Promise<{
  ok: true;
  path: string;
  backupPath?: string;
}> {
  const targetPath = args.path;
  const text = args.text ?? "";
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error("A bound absolute translation path is required.");
  }
  if (!/\.txt$/i.test(targetPath)) {
    throw new Error("Only txt translation files can be overwritten.");
  }
  const resolvedTargetPath = path.resolve(targetPath);
  await mkdir(path.dirname(resolvedTargetPath), { recursive: true });
  return withTranslationCandidateLock(resolvedTargetPath, async () => {
    const backupPath = await backupFile(resolvedTargetPath, args.outputDir);
    await writeTextFileAtomically(resolvedTargetPath, text);
    return { ok: true, path: resolvedTargetPath, backupPath };
  });
}

async function collectLineFiles(folderPath: string, fileType: GenerateLineHtmlArgs["fileType"], workspaceDir: string): Promise<FolderLineFile[]> {
  const allowed = fileType === "epub" ? /\.epub$/i : fileType === "txt" ? /\.txt$/i : /\.(txt|epub)$/i;
  const entries = await collectSourceTreeFiles(folderPath, (filePath) => allowed.test(filePath));
  return Promise.all(entries.map(async (entry) => {
    const text = await readLineDocument(entry.path, fileType, workspaceDir);
    return {
      name: path.basename(entry.path),
      relativePath: entry.relativePath,
      path: entry.path,
      lineCount: splitLines(text).length
    };
  }));
}

async function collectTranslationLineFiles(folderPath: string, workspaceDir: string): Promise<FolderLineFile[]> {
  return collectLineFiles(folderPath, "auto", workspaceDir);
}

async function collectBilingualFiles(folderPath: string, fileType: GenerateLineHtmlArgs["fileType"]): Promise<Array<{ name: string; path: string }>> {
  const allowed = fileType === "epub" ? /\.epub$/i : fileType === "txt" ? /\.txt$/i : /\.(txt|epub)$/i;
  const entries = await collectSourceTreeFiles(folderPath, (filePath) => allowed.test(filePath));
  return entries.map((entry) => ({ name: entry.relativePath, path: entry.path }));
}

function folderPromptAdvanced(
  advanced: PromptAdvancedOptions | undefined,
  documents: Array<{ id: string; path: string }>
): PromptAdvancedOptions {
  return {
    ...advanced,
    folderTranslationOrder: advanced?.folderTranslationOrder?.trim()
      || formatFolderTranslationOrder(documents.map((document) => document.id)),
    folderSourceDocuments: documents
  };
}

function preloadPath(): string {
  return path.join(app.getAppPath(), "dist", "main", "preload.cjs");
}

function appIconPath(): string {
  return path.join(app.getAppPath(), "assets", "app-icon.png");
}

function resolveMainAppWindow(): BrowserWindow | undefined {
  if (mainAppWindow && !mainAppWindow.isDestroyed()) {
    return mainAppWindow;
  }
  return BrowserWindow.getAllWindows().find((window) => {
    const url = window.webContents.getURL();
    return url.includes("renderer/index.html") || url.includes("127.0.0.1:5173");
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: !portableSmokeMarkerPath && !electronVerificationHeadless,
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: !electronVerificationHeadless,
      offscreen: electronVerificationOffscreen
    }
  });

  mainAppWindow = win;
  win.on("closed", () => {
    if (mainAppWindow === win) {
      mainAppWindow = undefined;
    }
  });

  if (isDev) {
    await win.loadURL("http://127.0.0.1:5173");
  } else {
    await win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  }
  return win;
}

async function loadRendererRoute(win: BrowserWindow, hash: string): Promise<void> {
  if (isDev) {
    await win.loadURL(`http://127.0.0.1:5173/#${hash}`);
    return;
  }
  await win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"), { hash });
}

async function rendererAssetUrl(prefix: string): Promise<string> {
  if (isDev) {
    return `http://127.0.0.1:5173/src/renderer/agent/embedded.tsx`;
  }
  const assetsDir = path.join(app.getAppPath(), "dist", "renderer", "assets");
  const files = await readdir(assetsDir);
  const match = files.find((file) => file.startsWith(prefix) && file.endsWith(".js"));
  if (!match) {
    throw new Error(`Renderer asset not found: ${prefix}`);
  }
  return pathToFileURL(path.join(assetsDir, match)).toString();
}

async function rendererCssAssetUrl(): Promise<string | undefined> {
  if (isDev) {
    return `http://127.0.0.1:5173/src/renderer/styles.css`;
  }
  const assetsDir = path.join(app.getAppPath(), "dist", "renderer", "assets");
  const files = await readdir(assetsDir);
  const match = files.find((file) => file.startsWith("styles-") && file.endsWith(".css"))
    ?? files.find((file) => file.endsWith(".css"));
  return match ? pathToFileURL(path.join(assetsDir, match)).toString() : undefined;
}

function splitHtmlOpenTarget(targetPath: string): { filePath: string; hash: string; key: string } {
  const htmlHashIndex = targetPath.toLowerCase().lastIndexOf(".html#");
  const rawFilePath = htmlHashIndex >= 0 ? targetPath.slice(0, htmlHashIndex + ".html".length) : targetPath.replace(/#.*$/, "");
  const hash = htmlHashIndex >= 0 ? targetPath.slice(htmlHashIndex + ".html#".length) : "";
  const filePath = normalizeLinkedHtmlFilePath(rawFilePath) || path.resolve(rawFilePath);
  const key = hash.includes("agent-chat-popout")
    ? `${filePath.toLowerCase()}::agent-popout`
    : filePath.toLowerCase();
  return { filePath, hash, key };
}

function isHtmlOpenTarget(targetPath: string): boolean {
  return /\.html(?:#|$)/i.test(targetPath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveHtmlOpenTarget(targetPath: string): Promise<string> {
  const { filePath, hash } = splitHtmlOpenTarget(targetPath);
  if (await fileExists(filePath)) {
    return targetPath;
  }

  const workspaceDir = workspaceDirFromKnownPath(filePath);
  if (!workspaceDir) {
    return targetPath;
  }

  const htmlDir = path.join(workspaceDir, "html");
  const sameName = await existingHtmlPath(path.join(htmlDir, path.basename(filePath)), workspaceDir);
  const fallback = sameName || await findLatestHtml(htmlDir);
  return fallback ? `${fallback}${hash ? `#${hash}` : ""}` : targetPath;
}

function renderHtmlTabShell(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: #eaf6ff; color: #25304a; font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; }
    #tabs { height: ${htmlViewerTabBarHeight}px; display: flex; align-items: end; gap: 6px; padding: 7px 10px 0; overflow-x: auto; background: linear-gradient(100deg, #2d5d9f, #344b9a 48%, #72d3ff); border-bottom: 1px solid rgba(255,255,255,.55); }
    .tab { flex: 0 0 auto; min-width: 140px; max-width: 280px; height: 34px; display: inline-flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; border: 1px solid rgba(255,255,255,.6); border-bottom: 0; border-radius: 8px 8px 0 0; background: rgba(255,255,255,.72); color: #26324d; font: inherit; font-weight: 700; text-align: left; cursor: pointer; }
    .tab.active { background: #fff; color: #17345f; }
    .tab-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tab-close { flex: 0 0 auto; width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 999px; color: #52617f; font-size: 18px; line-height: 1; }
    .tab-close:hover { background: rgba(42,63,103,.12); color: #17233c; }
  </style>
</head>
<body>
  <nav id="tabs"></nav>
  <script>
    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }
    window.renderTabs = function(tabs) {
      const root = document.getElementById("tabs");
      root.innerHTML = tabs.map(tab =>
        '<button title="' + escapeHtml(tab.title) + '" class="tab ' + (tab.active ? 'active' : '') + '" data-key="' + escapeHtml(tab.key) + '">' +
        '<span class="tab-title">' + escapeHtml(tab.title) + '</span>' +
        '<span class="tab-close" title="Close" aria-label="Close" data-close-key="' + escapeHtml(tab.key) + '">×</span>' +
        '</button>'
      ).join("");
    };
    document.getElementById("tabs").addEventListener("click", event => {
      const close = event.target.closest("[data-close-key]");
      if (close && window.workshopTabs) {
        event.stopPropagation();
        window.workshopTabs.close(close.dataset.closeKey);
        return;
      }
      const button = event.target.closest("button[data-key]");
      if (button && window.workshopTabs) window.workshopTabs.activate(button.dataset.key);
    });
  </script>
</body>
</html>`;
}

function layoutHtmlViewerTabs(): void {
  if (!htmlViewerWindow || htmlViewerWindow.isDestroyed()) {
    return;
  }
  const [width, height] = htmlViewerWindow.getContentSize();
  const bounds = { x: 0, y: htmlViewerTabBarHeight, width, height: Math.max(120, height - htmlViewerTabBarHeight) };
  for (const [key, tab] of htmlViewerTabs) {
    tab.view.setBounds(key === activeHtmlViewerTab
      ? bounds
      : { x: 0, y: 0, width: 0, height: 0 });
  }
}

function updateHtmlViewerTabs(): void {
  if (!htmlViewerWindow || htmlViewerWindow.isDestroyed()) {
    return;
  }
  const tabs = Array.from(htmlViewerTabs.entries()).map(([key, tab]) => ({
    key,
    title: tab.title,
    active: key === activeHtmlViewerTab
  }));
  void htmlViewerWindow.webContents.executeJavaScript(`window.renderTabs && window.renderTabs(${JSON.stringify(tabs)})`).catch(() => undefined);
}

async function ensureHtmlViewerWindow(): Promise<BrowserWindow> {
  if (htmlViewerWindow && !htmlViewerWindow.isDestroyed()) {
    return htmlViewerWindow;
  }
  htmlViewerWindow = new BrowserWindow({
    show: !electronVerificationHeadless,
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: !electronVerificationHeadless,
      offscreen: electronVerificationOffscreen
    }
  });
  htmlViewerWindowClosing = false;
  htmlViewerWindow.on("resize", layoutHtmlViewerTabs);
  htmlViewerWindow.on("close", (event) => {
    event.preventDefault();
    if (htmlViewerWindowClosing) return;
    const closingWindow = htmlViewerWindow;
    const tabs = [...htmlViewerTabs.values()];
    htmlViewerWindowClosing = true;
    void Promise.all(tabs.map(flushHtmlViewerTabState))
      .then(() => Promise.all(tabs.map(cancelHtmlViewerTabAgentRuns)))
      .then(() => {
        if (closingWindow && !closingWindow.isDestroyed()) {
          disposeHtmlViewerTabs(closingWindow, tabs);
          closingWindow.destroy();
        }
    }).catch((error) => {
      htmlViewerWindowClosing = false;
      console.error("[html-viewer] Failed to persist state and suspend Agent sessions before closing", error);
    });
  });
  htmlViewerWindow.on("closed", () => {
    htmlViewerWindow = undefined;
    htmlViewerWindowClosing = false;
    htmlViewerTabs.clear();
    activeHtmlViewerTab = "";
  });
  await htmlViewerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderHtmlTabShell())}`);
  return htmlViewerWindow;
}

function activateHtmlViewerTab(key: string): boolean {
  const tab = htmlViewerTabs.get(key);
  if (!tab || !htmlViewerWindow || htmlViewerWindow.isDestroyed()) {
    return false;
  }
  if (activeHtmlViewerTab !== key) {
    activeHtmlViewerTab = key;
    htmlViewerWindow.setTopBrowserView(tab.view);
  }
  layoutHtmlViewerTabs();
  htmlViewerWindow.setTitle(tab.title);
  if (!electronVerificationHeadless) {
    htmlViewerWindow.show();
    htmlViewerWindow.focus();
  }
  updateHtmlViewerTabs();
  return true;
}

async function rememberHtmlViewerTabProject(tab: HtmlViewerTab | undefined): Promise<void> {
  if (!tab?.workspaceDir) return;
  const { outputDir } = normalizeProjectFolder(tab.workspaceDir);
  await writeRecentProjectDir(app.getPath("userData"), outputDir);
}

async function rememberActiveHtmlViewerProject(): Promise<void> {
  await rememberHtmlViewerTabProject(htmlViewerTabs.get(activeHtmlViewerTab));
}

async function extractLineReviewWorkspaceDir(filePath: string): Promise<string | undefined> {
  const html = await readFile(filePath, "utf8").catch(() => "");
  const match = html.match(/<script id="(?:reviewData|proposalData|batchData)" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return undefined;
  try {
    const data = JSON.parse(match[1]);
    const outputDir = typeof data?.workflow?.paths?.outputDir === "string"
      ? data.workflow.paths.outputDir
      : typeof data?.folderAgentRoute?.outputDir === "string"
        ? data.folderAgentRoute.outputDir
      : typeof data?.outputDir === "string"
        ? data.outputDir
        : "";
    return outputDir && path.isAbsolute(outputDir)
      ? normalizeProjectFolder(outputDir).workspaceDir
      : undefined;
  } catch {
    return undefined;
  }
}

async function cancelHtmlViewerTabAgentRuns(tab: HtmlViewerTab): Promise<void> {
  if (tab.workspaceDir) await piNativeSessionService.suspendWorkspace(tab.workspaceDir);
}

async function flushHtmlViewerTabState(tab: HtmlViewerTab): Promise<void> {
  if (tab.view.webContents.isDestroyed()) return;
  await tab.view.webContents.executeJavaScript(`
    typeof window.flushTranslationWorkshopLineReviewState === "function"
      ? window.flushTranslationWorkshopLineReviewState()
      : undefined
  `);
}

function disposeHtmlViewerTabs(window: BrowserWindow, tabs: HtmlViewerTab[]): void {
  for (const tab of tabs) {
    window.removeBrowserView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }
}

async function closeHtmlViewerTab(key: string): Promise<boolean> {
  const tab = htmlViewerTabs.get(key);
  if (!tab || !htmlViewerWindow || htmlViewerWindow.isDestroyed()) {
    return false;
  }
  const keys = Array.from(htmlViewerTabs.keys());
  const closedIndex = keys.indexOf(key);
  await flushHtmlViewerTabState(tab);
  await cancelHtmlViewerTabAgentRuns(tab);
  htmlViewerWindow.removeBrowserView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  htmlViewerTabs.delete(key);
  if (htmlViewerTabs.size === 0) {
    activeHtmlViewerTab = "";
    updateHtmlViewerTabs();
    htmlViewerWindow.close();
    return true;
  }
  if (activeHtmlViewerTab === key) {
    const nextKeys = Array.from(htmlViewerTabs.keys());
    const nextKey = nextKeys[Math.min(Math.max(closedIndex, 0), nextKeys.length - 1)];
    if (nextKey) {
      return activateHtmlViewerTab(nextKey);
    }
  }
  updateHtmlViewerTabs();
  return true;
}

async function loadHtmlViewerTab(targetPath: string, outputDir?: string): Promise<{ key: string; tab: HtmlViewerTab }> {
  const resolvedTargetPath = await resolveHtmlOpenTarget(targetPath);
  const { filePath, hash, key } = splitHtmlOpenTarget(resolvedTargetPath);
  if (!(await fileExists(filePath))) {
    throw new Error(`HTML file not found: ${filePath}`);
  }
  let tab = htmlViewerTabs.get(key);
  if (tab?.loadPromise) await tab.loadPromise;
  if (tab && !tab.view.webContents.isDestroyed()) {
    const currentFilePath = normalizeLinkedHtmlFilePath(tab.view.webContents.getURL().replace(/#.*$/, ""));
    const currentProtocol = currentFilePath && sameFilePath(currentFilePath, filePath)
      ? await tab.view.webContents.executeJavaScript(`(() => {
          const currentMarkers = ${JSON.stringify([
            BATCH_LINE_REVIEW_PROTOCOL_MARKER,
            LINE_REVIEW_PROTOCOL_MARKER,
            PROPOSAL_REVIEW_PROTOCOL_MARKER
          ])};
          return [...document.querySelectorAll('meta[content]')]
            .some((item) => currentMarkers.includes(item.getAttribute('content')));
        })()`)
      : false;
    if (currentProtocol && !outputDir) {
      if (hash) {
        await tab.view.webContents.executeJavaScript(
          `if (location.hash !== "#${hash.replace(/"/g, "")}") location.hash = "#${hash.replace(/"/g, "")}";`
        );
      }
      tab.hash = hash;
      return { key, tab };
    }
  }
  const upgradedOnDisk = await upgradeLegacyReviewHtmlTree(filePath);
  const repairedOnDisk = await repairProposalReviewHtmlLineReviewPath(filePath, outputDir);
  const workspaceDir = await extractLineReviewWorkspaceDir(filePath);
  await ensureHtmlViewerWindow();
  if (!tab) {
    const view = new BrowserView({
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: !electronVerificationHeadless,
        offscreen: electronVerificationOffscreen
      }
    });
    tab = { filePath, hash, title: path.basename(filePath), view, workspaceDir };
    htmlViewerTabs.set(key, tab);
    htmlViewerWindow!.addBrowserView(view);
    view.webContents.on("page-title-updated", (_event, title) => {
      tab!.title = title || path.basename(filePath);
      updateHtmlViewerTabs();
    });
  } else {
    tab.hash = hash;
    tab.workspaceDir = workspaceDir;
  }
  const currentUrl = tab.view.webContents.getURL();
  const currentFilePath = normalizeLinkedHtmlFilePath(currentUrl.replace(/#.*$/, ""));
  const needsLoad = upgradedOnDisk || repairedOnDisk || !currentFilePath || !sameFilePath(currentFilePath, filePath);
  if (needsLoad) {
    if (!tab.loadPromise) {
      const pendingLoad = (async () => {
        await tab.view.webContents.loadFile(filePath, { hash });
        tab.filePath = filePath;
        await injectHtmlSidecarState(filePath, tab.view.webContents);
      })();
      tab.loadPromise = pendingLoad;
      const clearPendingLoad = () => {
        if (tab.loadPromise === pendingLoad) tab.loadPromise = undefined;
      };
      void pendingLoad.then(clearPendingLoad, clearPendingLoad);
    }
    await tab.loadPromise;
  } else if (hash) {
    await tab.view.webContents.executeJavaScript(`if (location.hash !== "#${hash.replace(/"/g, "")}") location.hash = "#${hash.replace(/"/g, "")}";`);
  }
  tab.hash = hash;
  return { key, tab };
}

async function injectHtmlSidecarState(filePath: string, contents: Electron.WebContents): Promise<void> {
  const html = await readFile(filePath, "utf8").catch(() => "");
  const kind = /<script\s+id=["']reviewData["']\s+type=["']application\/json["']>/i.test(html)
    ? "line"
    : /<script\s+id=["']proposalData["']\s+type=["']application\/json["']>/i.test(html)
      ? "proposal"
      : "";
  if (!kind) return;
  const statePath = await htmlSidecarStatePath(filePath, kind);
  const sidecarState = statePath ? await readJsonObject(statePath) : undefined;
  if (!sidecarState) return;
  const stateJson = JSON.stringify(sidecarState);
  await contents.executeJavaScript(`
    (() => {
      const incomingState = ${stateJson};
      if (!incomingState || typeof incomingState !== "object") return;
      if (${JSON.stringify(kind)} === "line") {
        const legacyKey = "translation-workshop:line:" + location.pathname;
        const primaryKey = typeof lineReviewStorageKey === "function" ? lineReviewStorageKey() : legacyKey;
        const existingState = JSON.parse(localStorage.getItem(primaryKey) || localStorage.getItem(legacyKey) || "{}") || {};
        const mergedState = {
          ...existingState,
          ...incomingState,
          edits: { ...(existingState.edits || {}), ...(incomingState.edits || {}) },
          status: { ...(existingState.status || {}), ...(incomingState.status || {}) },
          revisions: { ...(existingState.revisions || {}), ...(incomingState.revisions || {}) },
          revisionHistory: { ...(existingState.revisionHistory || {}), ...(incomingState.revisionHistory || {}) },
          auditIssues: { ...(existingState.auditIssues || {}), ...(incomingState.auditIssues || {}) },
          auditWhitelist: { ...(existingState.auditWhitelist || {}), ...(incomingState.auditWhitelist || {}) },
          theme: { ...(existingState.theme || {}), ...(incomingState.theme || {}) }
        };
        for (const storageKey of [...new Set([primaryKey, legacyKey].filter(Boolean))]) {
          localStorage.setItem(storageKey, JSON.stringify(mergedState));
        }
        if (typeof state === "object" && state) Object.assign(state, mergedState);
      } else {
        const existingState = JSON.parse(localStorage.getItem(key) || "{}") || {};
        const mergedState = {
          ...existingState,
          ...incomingState,
          decisions: { ...(existingState.decisions || {}), ...(incomingState.decisions || {}) },
          theme: { ...(existingState.theme || {}), ...(incomingState.theme || {}) }
        };
        localStorage.setItem(key, JSON.stringify(mergedState));
        if (typeof state === "object" && state) Object.assign(state, mergedState);
      }
      if (typeof render === "function") render();
    })();
  `);
}

async function openHtmlWindow(targetPath: string, outputDir?: string): Promise<void> {
  const { key, tab } = await loadHtmlViewerTab(targetPath, outputDir);
  if (activateHtmlViewerTab(key)) {
    await rememberHtmlViewerTabProject(tab);
  }
}

async function applyLineReviewStateToView(args: ApplyLineReviewStateArgs): Promise<{ ok: boolean }> {
  if (!args.lineReviewPath) {
    throw new Error("Line review HTML path is required.");
  }
  const normalizedPath = normalizeLinkedHtmlFilePath(args.lineReviewPath.replace(/#.*$/, ""));
  if (!normalizedPath) {
    throw new Error("Line review HTML path is invalid.");
  }
  const lines = [...new Set([
    ...(Array.isArray(args.lines) ? args.lines : []),
    args.line
  ].map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  const line = lines[0] ?? 0;
  const targetPath = Number.isInteger(line) && line > 0
    ? `${normalizedPath}#line=${line}`
    : normalizedPath;
  // Keep the currently visible proposal tab attached until the linked line state
  // has been applied. Attaching first exposes one stale frame and lets callers
  // observe the old translation before the state mutation finishes.
  const { key, tab } = await loadHtmlViewerTab(targetPath);
  const stateJson = JSON.stringify(args.lineState ?? {});
  const lineJson = JSON.stringify(line);
  const linesJson = JSON.stringify(lines);
  await tab.view.webContents.executeJavaScript(
    `(async () => {
      const legacyKey = "translation-workshop:line:" + location.pathname;
      const primaryKey = typeof lineReviewStorageKey === "function" ? lineReviewStorageKey() : legacyKey;
      const storageKeys = [...new Set([primaryKey, legacyKey].filter(Boolean))];
      const existingState = JSON.parse(localStorage.getItem(primaryKey) || localStorage.getItem(legacyKey) || "{}") || {};
      const incomingState = ${stateJson};
      const affectedLines = ${linesJson};
      const mergedState = {
        ...existingState,
        ...incomingState,
        theme: { ...(existingState.theme || {}), ...(incomingState.theme || {}) }
      };
      for (const field of ["edits", "status", "revisions", "revisionHistory", "auditIssues", "auditWhitelist"]) {
        const incomingMap = incomingState[field] || {};
        const nextMap = { ...(existingState[field] || {}) };
        if (affectedLines.length > 0) {
          for (const line of affectedLines) {
            const key = String(line);
            if (Object.prototype.hasOwnProperty.call(incomingMap, key)) nextMap[key] = incomingMap[key];
            else delete nextMap[key];
          }
        } else {
          Object.assign(nextMap, incomingMap);
        }
        mergedState[field] = nextMap;
      }
      for (const storageKey of storageKeys) {
        localStorage.setItem(storageKey, JSON.stringify(mergedState));
      }
      if (typeof state === "object" && state) {
        Object.assign(state, mergedState);
        state.edits = mergedState.edits;
        state.status = mergedState.status;
        state.revisions = mergedState.revisions;
        state.revisionHistory = mergedState.revisionHistory;
        state.auditIssues = mergedState.auditIssues;
        state.auditWhitelist = mergedState.auditWhitelist;
        state.theme = mergedState.theme;
      }
      if (typeof render === "function") {
        render();
      }
      const targetLine = ${lineJson};
      if (Number.isInteger(targetLine) && targetLine > 0 && typeof jumpToLine === "function") {
        requestAnimationFrame(() => jumpToLine(targetLine));
      }
      if (typeof save === "function") {
        await save(affectedLines.length > 0 ? affectedLines : Object.keys(incomingState.edits || {}).map(Number));
      }
    })();`
  );
  if (args.activate !== false) {
    if (activateHtmlViewerTab(key)) {
      await rememberHtmlViewerTabProject(tab);
    }
  }
  return { ok: true };
}

function promptBuildPath(value: unknown, label: string): string {
  return typeof value === "string" && value.trim() ? value : `[${label}]`;
}

function normalizePromptBuildArgs(args: unknown): PromptBuildOptions {
  const value = args && typeof args === "object" ? args as PromptBuildArgs : {};
  const kind = value.kind === "proofread" ? "proofread" : "translate";
  const outputDir = promptBuildPath(value.outputDir, "output folder");
  const sourcePath = promptBuildPath(value.sourcePath, "source path");
  const translationPath = kind === "proofread"
    ? promptBuildPath(value.translationPath, "sync translation file first")
    : typeof value.translationPath === "string" && value.translationPath.trim()
      ? value.translationPath
      : undefined;
  const glossaryPath = typeof value.glossaryPath === "string" && value.glossaryPath.trim() ? value.glossaryPath : undefined;
  const advanced = value.advanced && typeof value.advanced === "object" ? value.advanced as PromptAdvancedOptions : undefined;
  return {
    kind,
    sourcePath,
    sourceKind: value.sourceKind === "folder" ? "folder" : "file",
    translationPath,
    outputDir,
    glossaryPath,
    inputMode: value.inputMode === "bilingual" ? "bilingual" : "separate",
    advanced
  };
}

ipcMain.handle("ui:openAgentChatWindow", async (_event, args: { lineReviewPath?: string; outputDir?: string; locale?: "zh-CN" | "en-US"; languagePair?: string; sourcePath?: string; sourceKind?: "file" | "folder"; translationPath?: string; initialPrompt?: string; initialWorkflowIntent?: "translation" | "proofread"; initialLanguagePair?: string }) => {
  const result = await openAgentChatWindow({
    args,
    preloadPath: preloadPath(),
    icon: appIconPath(),
    loadRendererRoute
  });
  return { ok: true, surface: result.surface };
});

ipcMain.handle("ui:agentChatEmbeddedEntryUrl", async () => {
  return {
    ok: true,
    url: await rendererAssetUrl("agent-embedded-"),
    cssUrl: await rendererCssAssetUrl()
  };
});

ipcMain.handle("dialog:openFile", async (_event, filters?: Electron.FileFilter[]) => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("dialog:openProjectFolder", async () => {
  const userDataDir = app.getPath("userData");
  const defaultPath = await readRecentProjectDir(userDataDir);
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {})
  });
  if (result.canceled) return undefined;
  const selected = normalizeProjectFolder(result.filePaths[0]).outputDir;
  await writeRecentProjectDir(userDataDir, selected);
  return selected;
});

ipcMain.handle("project:load", async (_event, outputDir?: string) => {
  if (!outputDir) {
    return undefined;
  }
  const projectFolder = normalizeProjectFolder(outputDir);
  const workspaceDir = projectFolder.workspaceDir;
  const [project, state, reviewTargets] = await Promise.all([
    readProjectState(projectFolder.outputDir),
    readJsonObject(path.join(workspaceDir, "state.json")),
    discoverProjectReviewTargets(workspaceDir)
  ]);
  const latestHtml = reviewTargets.primaryHtml || await findLatestHtml(path.join(workspaceDir, "html"));
  if (Object.keys(project).length === 0 && !state && !latestHtml) {
    return undefined;
  }
  await writeRecentProjectDir(app.getPath("userData"), projectFolder.outputDir);
  const savedLastHtml = typeof state?.lastHtml === "string"
    ? state.lastHtml
    : typeof project?.lastHtml === "string"
      ? project.lastHtml
      : typeof project?.lastOutput === "string"
        ? project.lastOutput
        : "";
  const lastHtml = reviewTargets.primaryHtml || await existingHtmlPath(savedLastHtml, workspaceDir) || latestHtml;
  const lastOutput = typeof project?.lastOutput === "string" && project.lastOutput
    ? project.lastOutput
    : lastHtml;
  return {
    ...project,
    outputDir: projectFolder.outputDir,
    lastHtml,
    lastOutput,
    lastLineReviewHtml: reviewTargets.lineReviewHtml,
    lineReviewPath: reviewTargets.lineReviewHtml,
    lastProposalReviewHtml: reviewTargets.proposalReviewHtml,
    generatedAt: state?.generatedAt ?? project?.generatedAt
  };
});

ipcMain.handle("project:save", async (_event, outputDir: string, state: unknown) => {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Project state must be an object.");
  }
  await saveProjectState(outputDir, state as Record<string, unknown>);
  await writeRecentProjectDir(app.getPath("userData"), normalizeProjectFolder(outputDir).outputDir);
  return true;
});

ipcMain.handle("project:readState", async (_event, outputDir?: unknown) => {
  const value = typeof outputDir === "string" ? outputDir.trim() : "";
  return value ? readProjectState(value) : {};
});

ipcMain.handle("project:patch", async (_event, args: { outputDir?: unknown; patch?: unknown }) => {
  const outputDir = typeof args?.outputDir === "string" ? args.outputDir.trim() : "";
  const patch = args?.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
    ? args.patch as Record<string, unknown>
    : undefined;
  if (!outputDir || !patch) {
    return false;
  }
  await patchProjectState(outputDir, patch);
  return true;
});

ipcMain.handle("prompts:build", async (_event, args: unknown) => {
  return buildPrompt(normalizePromptBuildArgs(args));
});

ipcMain.handle("html:generateLineReview", async (_event, args: GenerateLineHtmlArgs) => {
  if (!args.sourcePath || !args.outputDir) {
    throw new Error("Source path and output folder are required.");
  }
  const sourceIsDirectory = await isDirectory(args.sourcePath);
  const translationIsDirectory = await isDirectory(args.translationPath);
  const inputMode = args.inputMode ?? "separate";
  const workspaceDir = await ensureWorkspace(args.outputDir);
  const glossaryEntries = await loadGlossaryEntries(args.glossaryPath);
  if (inputMode === "bilingual") {
    assertBilingualMode(args.fileType);
    const sourcePosition = normalizeBilingualPosition(args.sourcePosition ?? args.sourceColumn, 2);
    const translationPosition = normalizeBilingualPosition(args.translationPosition ?? args.translationColumn, 1);
    if (sourcePosition === translationPosition) {
      throw new Error("Source position and translation position must be different.");
    }
    if (sourceIsDirectory) {
      const batchId = `line-review-bilingual-batch-${timestamp()}`;
      const batchDir = path.join(workspaceDir, "html", batchId);
      await mkdir(batchDir, { recursive: true });
      const sourceFiles = await collectBilingualFiles(args.sourcePath, args.fileType);
      if (sourceFiles.length === 0) {
        throw new Error("No .txt or .epub bilingual files were found in the source folder.");
      }
      const preparedFiles = await Promise.all(sourceFiles.map(async (file) => {
        const parsed = await parseBilingualDocument(file.path, args.fileType, workspaceDir, sourcePosition, translationPosition);
        const agentSourcePath = parsed.sourcePromptPath ?? await writeExtractedPromptText(
          workspaceDir,
          file.path,
          "source",
          parsed.sourceText
        );
        return { file, parsed, agentSourcePath };
      }));
      const folderAdvanced = folderPromptAdvanced(args.advanced, preparedFiles.map(({ file, agentSourcePath }) => ({
        id: file.name,
        path: agentSourcePath
      })));
      const indexFiles: BatchLineReviewIndexFile[] = [];
      for (const [index, prepared] of preparedFiles.entries()) {
        const { file, parsed } = prepared;
        const childName = htmlSafeName(file.name, index);
        const childPath = path.join(batchDir, childName);
        const html = renderLineReviewHtml({
          title: `${file.name} bilingual line review`,
          sourceText: parsed.sourceText,
          translationText: parsed.translationText,
          pageSize: args.pageSize,
          startPage: args.startPage,
          locale: args.locale,
          lineReviewPath: childPath,
          workflow: {
            sourcePath: file.path,
            validationSourcePath: parsed.sourcePromptPath ?? file.path,
            sourceKind: "file",
            translationPath: file.path,
            editableTranslationPath: parsed.kind === "epub" ? parsed.translationPromptPath : file.path,
            sourcePromptPath: args.sourcePath,
            promptSourceKind: "folder",
            translationPromptPath: args.sourcePath,
            outputDir: args.outputDir,
            glossaryPath: args.glossaryPath,
            glossaryEntries,
            inputMode: "bilingual",
            promptInputMode: parsed.kind === "epub" ? "separate" : "bilingual",
            advanced: folderAdvanced,
            bilingualPair: { sourcePosition, translationPosition, pairSize: 2 },
            epubExport: parsed.kind === "epub" ? { mode: "pair-position", replacePosition: translationPosition, pairSize: 2 } : undefined
          }
        });
        await writeFile(childPath, html, "utf8");
        indexFiles.push({
          sourceName: file.name,
          sourcePath: file.path,
          sourceLineCount: parsed.rowCount,
          translationName: `position ${translationPosition}`,
          translationPath: file.path,
          translationLineCount: parsed.rowCount,
          status: "matched",
          outputPath: `${batchId}/${childName}`
        });
      }
      const outputPath = path.join(workspaceDir, "html", `${batchId}.html`);
      const indexHtml = renderBatchLineReviewIndexHtml({
        title: `${path.basename(args.sourcePath)} bilingual folder review`,
        files: indexFiles,
        locale: args.locale,
        workflow: {
          sourcePath: args.sourcePath,
          sourceKind: "folder",
          translationPath: args.sourcePath,
          outputDir: args.outputDir,
          glossaryPath: args.glossaryPath,
          inputMode: "bilingual",
          advanced: folderAdvanced
        }
      });
      await writeFile(outputPath, indexHtml, "utf8");
      await writeFile(
        path.join(workspaceDir, "state.json"),
        JSON.stringify({
          lastHtml: outputPath,
          generatedAt: new Date().toISOString(),
          batch: {
            inputMode,
            sourceFolder: args.sourcePath,
            sourcePosition,
            translationPosition,
            fileCount: indexFiles.length,
            matchedCount: indexFiles.length,
            warningCount: 0
          }
        }, null, 2),
        "utf8"
      );
      return { outputPath, fileCount: indexFiles.length, matchedCount: indexFiles.length, warningCount: 0 };
    }

    const parsed = await parseBilingualDocument(args.sourcePath, args.fileType, workspaceDir, sourcePosition, translationPosition);
    const title = `${path.basename(args.sourcePath)} bilingual line review`;
    const outputPath = path.join(workspaceDir, "html", `line-review-bilingual-${timestamp()}.html`);
    const html = renderLineReviewHtml({
      title,
      sourceText: parsed.sourceText,
      translationText: parsed.translationText,
      pageSize: args.pageSize,
      startPage: args.startPage,
      locale: args.locale,
      lineReviewPath: outputPath,
      workflow: {
        sourcePath: args.sourcePath,
        validationSourcePath: parsed.sourcePromptPath ?? args.sourcePath,
        translationPath: args.sourcePath,
        editableTranslationPath: parsed.kind === "epub" ? parsed.translationPromptPath : args.sourcePath,
        sourcePromptPath: parsed.sourcePromptPath,
        translationPromptPath: parsed.translationPromptPath,
        outputDir: args.outputDir,
        glossaryPath: args.glossaryPath,
        glossaryEntries,
        inputMode: "bilingual",
        promptInputMode: parsed.kind === "epub" ? "separate" : "bilingual",
        advanced: args.advanced,
        bilingualPair: { sourcePosition, translationPosition, pairSize: 2 },
        epubExport: parsed.kind === "epub" ? { mode: "pair-position", replacePosition: translationPosition, pairSize: 2 } : undefined
      }
    });
    await writeFile(outputPath, html, "utf8");
    await writeFile(
      path.join(workspaceDir, "state.json"),
      JSON.stringify({ lastHtml: outputPath, generatedAt: new Date().toISOString(), inputMode, sourcePosition, translationPosition }, null, 2),
      "utf8"
    );
    return { outputPath };
  }
  if (sourceIsDirectory) {
    assertLineFolderMode(args.fileType);
    if (args.translationPath && !translationIsDirectory) {
      throw new Error("When the source path is a folder, the translation path must be empty or a folder.");
    }
    const batchId = `line-review-batch-${timestamp()}`;
    const batchDir = path.join(workspaceDir, "html", batchId);
    await mkdir(batchDir, { recursive: true });
    const [sourceFiles, translationFiles] = await Promise.all([
      collectLineFiles(args.sourcePath, args.fileType, workspaceDir),
      args.translationPath ? collectTranslationLineFiles(args.translationPath, workspaceDir) : Promise.resolve([])
    ]);
    if (sourceFiles.length === 0) {
      throw new Error("No .txt or .epub files were found in the source folder.");
    }
    const matches = matchFolderFiles(sourceFiles, translationFiles);
    const preparedMatches = await Promise.all(matches.map(async (match) => ({
      match,
      sourceDocument: await readLineDocumentForWorkflow(match.sourcePath, args.fileType, workspaceDir, "source")
    })));
    const folderAdvanced = folderPromptAdvanced(args.advanced, preparedMatches.map(({ match, sourceDocument }) => ({
      id: match.sourceName,
      path: sourceDocument.promptPath ?? match.sourcePath
    })));
    const indexFiles: BatchLineReviewIndexFile[] = [];
    for (const [index, prepared] of preparedMatches.entries()) {
      const { match, sourceDocument } = prepared;
      const translationDocument = match.status === "matched" && match.translationPath
        ? await readTranslationDocumentForWorkflow(match.translationPath, workspaceDir)
        : undefined;
      const selectedTranslationPath = match.status === "matched" ? match.translationPath : undefined;
      const editableSnapshotPath = !selectedTranslationPath && sourceDocument.kind === "epub"
        ? await writeExtractedPromptText(
          workspaceDir,
          match.sourcePath,
          "translation",
          blankAlignedTranslationText(sourceDocument.text)
        )
        : undefined;
      const translationPaths = workflowTranslationPaths({
        sourceIsEpub: sourceDocument.kind === "epub",
        selectedTranslationPath,
        selectedTranslationIsEpub: translationDocument?.kind === "epub",
        selectedTranslationWorkingPath: translationDocument?.promptPath,
        editableSnapshotPath
      });
      const childName = htmlSafeName(match.sourceName, index);
      const childPath = path.join(batchDir, childName);
      const html = renderLineReviewHtml({
        title: `${match.sourceName} line review`,
        sourceText: sourceDocument.text,
        translationText: translationDocument?.text,
        pageSize: args.pageSize,
        startPage: args.startPage,
        locale: args.locale,
        lineReviewPath: childPath,
        workflow: {
          sourcePath: match.sourcePath,
          validationSourcePath: sourceDocument.promptPath ?? match.sourcePath,
          sourceKind: "file",
          translationPath: translationPaths.translationPath,
          editableTranslationPath: translationPaths.editableTranslationPath,
          sourcePromptPath: args.sourcePath,
          promptSourceKind: "folder",
          translationPromptPath: translationPaths.translationPromptPath,
          outputDir: args.outputDir,
          glossaryPath: args.glossaryPath,
          glossaryEntries,
          inputMode: "separate",
          advanced: folderAdvanced,
          epubExport: match.sourcePath.toLowerCase().endsWith(".epub") ? { mode: "all" } : undefined
        }
      });
      await writeFile(childPath, html, "utf8");
      indexFiles.push({
        sourceName: match.sourceName,
        sourcePath: match.sourcePath,
        sourceLineCount: match.sourceLineCount,
        translationName: match.translationName,
        translationPath: match.translationPath,
        translationLineCount: match.translationLineCount,
        status: match.status,
        outputPath: `${batchId}/${childName}`
      });
    }
    const outputPath = path.join(workspaceDir, "html", `${batchId}.html`);
    const indexHtml = renderBatchLineReviewIndexHtml({
      title: `${path.basename(args.sourcePath)} folder line review`,
      files: indexFiles,
      locale: args.locale,
      workflow: {
        sourcePath: args.sourcePath,
        sourceKind: "folder",
        translationPath: args.translationPath || undefined,
        outputDir: args.outputDir,
        glossaryPath: args.glossaryPath,
        inputMode: "separate",
        advanced: folderAdvanced
      }
    });
    await writeFile(outputPath, indexHtml, "utf8");
    await writeFile(
      path.join(workspaceDir, "state.json"),
      JSON.stringify({
        lastHtml: outputPath,
        generatedAt: new Date().toISOString(),
        batch: {
          sourceFolder: args.sourcePath,
          translationFolder: args.translationPath,
          fileCount: indexFiles.length,
          matchedCount: indexFiles.filter((file) => file.status === "matched").length,
          warningCount: indexFiles.filter((file) => file.status !== "matched").length
        }
      }, null, 2),
      "utf8"
    );
    return {
      outputPath,
      fileCount: indexFiles.length,
      matchedCount: indexFiles.filter((file) => file.status === "matched").length,
      warningCount: indexFiles.filter((file) => file.status !== "matched").length
    };
  }
  const sourceDocument = await readLineDocumentForWorkflow(args.sourcePath, args.fileType, workspaceDir, "source");
  const translationDocument = args.translationPath
    ? await readTranslationDocumentForWorkflow(args.translationPath, workspaceDir)
    : undefined;
  const editableSnapshotPath = !args.translationPath && sourceDocument.kind === "epub"
    ? await writeExtractedPromptText(
      workspaceDir,
      args.sourcePath,
      "translation",
      blankAlignedTranslationText(sourceDocument.text)
    )
    : undefined;
  const translationPaths = workflowTranslationPaths({
    sourceIsEpub: sourceDocument.kind === "epub",
    selectedTranslationPath: args.translationPath,
    selectedTranslationIsEpub: translationDocument?.kind === "epub",
    selectedTranslationWorkingPath: translationDocument?.promptPath,
    editableSnapshotPath
  });
  const title = `${path.basename(args.sourcePath)} line review`;
  const outputPath = path.join(workspaceDir, "html", `line-review-${timestamp()}.html`);
  const html = renderLineReviewHtml({
    title,
    sourceText: sourceDocument.text,
    translationText: translationDocument?.text,
    pageSize: args.pageSize,
    startPage: args.startPage,
    locale: args.locale,
    lineReviewPath: outputPath,
    workflow: {
      sourcePath: args.sourcePath,
      validationSourcePath: sourceDocument.promptPath ?? args.sourcePath,
      translationPath: translationPaths.translationPath,
      editableTranslationPath: translationPaths.editableTranslationPath,
      sourcePromptPath: sourceDocument.promptPath,
      translationPromptPath: translationPaths.translationPromptPath,
      outputDir: args.outputDir,
      glossaryPath: args.glossaryPath,
      glossaryEntries,
      inputMode,
      advanced: args.advanced,
      epubExport: args.sourcePath.toLowerCase().endsWith(".epub") ? { mode: "all" } : undefined
    }
  });
  await writeFile(outputPath, html, "utf8");
  await writeFile(path.join(workspaceDir, "state.json"), JSON.stringify({ lastHtml: outputPath, generatedAt: new Date().toISOString() }, null, 2), "utf8");
  return { outputPath };
});

ipcMain.handle("html:generateProposalReview", async (_event, args: GenerateReviewHtmlArgs) => {
  if (!args.outputDir) {
    throw new Error("Output folder is required.");
  }
  const workspaceDir = await ensureWorkspace(args.outputDir);
  let reportPath = args.reportPath;
  if (!reportPath) {
    const candidates = await findProofreadReportCandidates(args.outputDir);
    reportPath = candidates[0]?.path;
  }
  if (!reportPath) {
    throw new Error("No proofread Markdown report with replacement proposals was found.");
  }
  const reportText = await readFile(reportPath, "utf8");
  const proposals = parseProofreadReport(reportText, reportPath);
  if (proposals.length === 0) {
    return {
      fallbackPrompt: buildReportFormatRepairPrompt(reportPath, args.locale),
      reportPath,
      proposalCount: 0
    } satisfies ProposalReviewFallbackResult;
  }
  const lineReviewPath = await findLinkedLineReviewHtml(args.outputDir, args.lineReviewPath);
  const html = renderProposalReviewHtml({
    title: path.basename(reportPath),
    proposals,
    outputDir: args.outputDir,
    reportPath,
    lineReviewPath,
    pageSize: args.pageSize,
    startPage: args.startPage,
    locale: args.locale
  });
  const outputPath = path.join(workspaceDir, "html", `proposal-review-${timestamp()}.html`);
  await writeFile(outputPath, html, "utf8");
  await writeFile(path.join(workspaceDir, "state.json"), JSON.stringify({
    lastHtml: outputPath,
    generatedAt: new Date().toISOString()
  }, null, 2), "utf8");
  return { outputPath, proposalCount: proposals.length, reportPath, lineReviewPath };
});

ipcMain.handle("html:openReviewHtml", async (_event, args: OpenReviewHtmlArgs) => {
  if (!args.htmlPath) {
    throw new Error("Review HTML path is required.");
  }
  if (args.activate === false) {
    await loadHtmlViewerTab(args.htmlPath, args.outputDir);
  } else {
    await openHtmlWindow(args.htmlPath, args.outputDir);
  }
  return { ok: true };
});

ipcMain.handle("html:applyLineReviewState", async (_event, args: ApplyLineReviewStateArgs) => {
  return applyLineReviewStateToView(args);
});

ipcMain.handle("html:readLineReviewDocument", async (_event, args: { lineReviewPath?: unknown }) => {
  if (typeof args?.lineReviewPath !== "string" || !args.lineReviewPath.trim()) {
    throw new Error("Line review HTML path is required.");
  }
  const normalizedPath = normalizeLinkedHtmlFilePath(args.lineReviewPath.replace(/#.*$/, ""));
  if (!normalizedPath) {
    throw new Error("Line review HTML path is invalid.");
  }
  const existingTab = [...htmlViewerTabs.values()].find((item) => sameFilePath(item.filePath, normalizedPath));
  if (existingTab?.loadPromise) await existingTab.loadPromise;
  if (!existingTab) {
    await loadHtmlViewerTab(normalizedPath);
  }
  let document: LanSyncLineDocument | undefined;
  for (let attempt = 0; attempt < 5 && !document; attempt += 1) {
    document = await readOpenLineReviewDocument(normalizedPath);
    if (!document && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!document) {
    throw new Error("Line review document state is unavailable.");
  }
  return document;
});

ipcMain.handle("html:prepareProposalLineReviewBatch", async (_event, args: PrepareProposalLineReviewBatchArgs) => {
  try {
    if (!args.outputDir || !path.isAbsolute(args.outputDir)) {
      throw new Error("An absolute project output directory is required.");
    }
    const outputDir = path.resolve(args.outputDir);
    const workspaceDir = normalizeProjectFolder(outputDir).workspaceDir;
    if (!args.reportPath || !path.isAbsolute(args.reportPath)
      || (!isSameOrInside(outputDir, args.reportPath) && !isSameOrInside(workspaceDir, args.reportPath))) {
      throw new Error("The proofread report must belong to the current project.");
    }
    const batchIndexPath = typeof args.lineReviewPath === "string"
      ? normalizeLinkedHtmlFilePath(args.lineReviewPath.replace(/#.*$/, ""))
      : "";
    if (!batchIndexPath || await isLineReviewHtml(batchIndexPath)) {
      return { ok: true, batch: false, synchronized: 0, migrated: 0 };
    }
    try {
      await readBatchLineReviewChildren(batchIndexPath);
    } catch (error) {
      throw new Error(`The linked batch line-review index is invalid: ${batchIndexPath}`, { cause: error });
    }
    if (!isSameOrInside(workspaceDir, batchIndexPath)) {
      throw new Error("The batch line-review index is outside the current project workspace.");
    }
    const requestedDocuments = Array.isArray(args.documents) ? args.documents : [];
    if (requestedDocuments.length === 0) {
      throw new Error("Batch proposal preparation requires its embedded document routes.");
    }
    const reportText = await readFile(args.reportPath, "utf8");
    const proposals = parseProofreadReport(reportText, args.reportPath);
    if (proposals.length === 0) throw new Error("The proofread report has no findings to route.");
    await proposalRoutingFromReport({
      outputDir,
      reportPath: args.reportPath,
      documentId: proposals[0].documentId,
      sourcePath: proposals[0].sourcePath,
      translationPath: proposals[0].translationPath
    });
    const routeOverrides = new Map<string, { sourcePath: string; translationPath: string }>();
    for (const proposal of proposals) {
      const documentId = String(proposal.documentId || "");
      const sourcePath = typeof proposal.sourcePath === "string" && path.isAbsolute(proposal.sourcePath)
        ? path.resolve(proposal.sourcePath)
        : "";
      const translationPath = typeof proposal.translationPath === "string" && path.isAbsolute(proposal.translationPath)
        ? path.resolve(proposal.translationPath)
        : "";
      if (!validProposalDocumentId(documentId) || !sourcePath || !translationPath) {
        throw new Error(`Proofread report has an incomplete batch route: ${documentId || "unknown"}.`);
      }
      const key = normalizedProposalDocumentId(documentId);
      const previous = routeOverrides.get(key);
      if (previous && (!sameFilePath(previous.sourcePath, sourcePath)
        || !sameFilePath(previous.translationPath, translationPath))) {
        throw new Error(`Proofread report maps ${documentId} to multiple file routes.`);
      }
      routeOverrides.set(key, { sourcePath, translationPath });
    }
    for (const document of requestedDocuments) {
      const key = normalizedProposalDocumentId(document.documentId);
      const reportRoute = routeOverrides.get(key);
      const requestedSource = typeof document.sourcePath === "string" && path.isAbsolute(document.sourcePath)
        ? path.resolve(document.sourcePath)
        : "";
      const requestedTranslation = typeof document.translationPath === "string" && path.isAbsolute(document.translationPath)
        ? path.resolve(document.translationPath)
        : "";
      if (!reportRoute || !requestedSource || !requestedTranslation
        || !sameFilePath(reportRoute.sourcePath, requestedSource)
        || !sameFilePath(reportRoute.translationPath, requestedTranslation)) {
        throw new Error(`Proofread report translation route changed before batch proposal apply: ${document.documentId || "unknown"}.`);
      }
    }
    const result = await synchronizeBatchProposalLineReviews({
      outputDir,
      batchIndexPath,
      locale: args.locale === "en-US" ? "en-US" : "zh-CN",
      routeOverrides
    });
    return { ok: true, batch: true, ...result };
  } catch (error) {
    return {
      ok: false,
      batch: false,
      synchronized: 0,
      migrated: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("html:resolveProposalLineReviewDocument", async (_event, args: ResolveProposalLineReviewDocumentArgs) => {
  if (!args.outputDir || !path.isAbsolute(args.outputDir)) {
    throw new Error("An absolute project output directory is required.");
  }
  const outputDir = path.resolve(args.outputDir);
  const workspaceDir = normalizeProjectFolder(outputDir).workspaceDir;
  if (!args.reportPath || !path.isAbsolute(args.reportPath)
    || (!isSameOrInside(outputDir, args.reportPath) && !isSameOrInside(workspaceDir, args.reportPath))) {
    throw new Error("The proofread report must belong to the current project.");
  }
  const routing = await proposalRoutingFromReport(args);
  const locale = args.locale === "en-US" ? "en-US" : "zh-CN";
  const metadataOnly = args.includeRows === false;
  const requestedLineReviewPath = typeof args.lineReviewPath === "string"
    ? filePathFromPathLike(args.lineReviewPath)
    : undefined;
  const openRouting = metadataOnly && requestedLineReviewPath && isSameOrInside(workspaceDir, requestedLineReviewPath)
    ? await openLineReviewRouting(requestedLineReviewPath)
    : undefined;
  let directLineReviewPath: string | undefined;
  if (requestedLineReviewPath && openRouting) {
    assertLineReviewRoutingBinding(openRouting, routing);
    directLineReviewPath = path.resolve(requestedLineReviewPath);
  } else if (
    requestedLineReviewPath
    && isSameOrInside(workspaceDir, requestedLineReviewPath)
    && await isLineReviewHtml(requestedLineReviewPath)
  ) {
    try {
      await assertLineReviewMatchesProposalRouting(requestedLineReviewPath, routing);
      directLineReviewPath = path.resolve(requestedLineReviewPath);
    } catch {
      // Let the canonical candidate resolver select or synchronize the matching document.
    }
  }
  const lineReviewPath = directLineReviewPath
    ?? await existingProposalLineReview(outputDir, args.lineReviewPath, routing, locale)
    ?? await generateProposalLineReview(outputDir, routing, locale);
  if (!isSameOrInside(workspaceDir, lineReviewPath)) {
    throw new Error("The resolved line-review document is outside the current project workspace.");
  }
  const document = metadataOnly && openRouting && sameFilePath(lineReviewPath, requestedLineReviewPath)
    ? {
        title: path.basename(lineReviewPath),
        rows: [],
        state: {},
        lineReviewPath
      }
    : await readProposalLineReviewDocument(
        lineReviewPath,
        metadataOnly ? [] : proposalLineRows(routing.proposals)
      );
  return {
    ...document,
    documentId: routing.documentId,
    sourcePath: routing.sourcePath,
    translationPath: routing.translationPath,
    lineReviewPath
  };
});

ipcMain.handle("html:applyProposalLineReviewStates", async (event, args: ApplyProposalLineReviewStatesArgs) => {
  const documents = Array.isArray(args?.documents) ? args.documents : [];
  if (documents.length === 0) throw new Error("At least one line-review state is required.");
  const senderPath = [...htmlViewerTabs.values()]
    .find((tab) => tab.view.webContents.id === event.sender.id)?.filePath
    || normalizeLinkedHtmlFilePath(event.sender.getURL().replace(/#.*$/, ""));
  const senderWorkspace = workspaceDirFromKnownPath(senderPath);
  if (!senderWorkspace) throw new Error("The proposal review is outside a project workspace.");
  const senderOutputDir = path.dirname(senderWorkspace);
  const prepared: Array<{
    reportPath: string;
    routing: { documentId: string; sourcePath: string; translationPath?: string };
    lineReviewPath: string;
    statePath: string;
    lineState: unknown;
    changedLines: number[];
    changedStateKeys: string[];
    expectedLineRevisions: unknown;
  }> = [];
  const seenStatePaths = new Set<string>();
  for (const item of documents) {
    const lineReviewPath = typeof item?.lineReviewPath === "string"
      ? normalizeLinkedHtmlFilePath(item.lineReviewPath.replace(/#.*$/, ""))
      : "";
    if (!lineReviewPath || !(await isLineReviewHtml(lineReviewPath))) {
      throw new Error("A valid line-review HTML path is required for every proposal document.");
    }
    const documentWorkspace = workspaceDirFromKnownPath(lineReviewPath);
    if (!documentWorkspace || !sameFilePath(documentWorkspace, senderWorkspace)) {
      throw new Error("Proposal changes cannot cross the current project workspace boundary.");
    }
    const reportPath = typeof item?.reportPath === "string"
      ? normalizeLinkedHtmlFilePath(item.reportPath.replace(/#.*$/, ""))
      : "";
    if (!reportPath || (!isSameOrInside(senderOutputDir, reportPath) && !isSameOrInside(senderWorkspace, reportPath))) {
      throw new Error("The proofread report must belong to the current proposal project.");
    }
    let routing: { documentId: string; sourcePath: string; translationPath?: string };
    try {
      routing = await proposalRoutingFromReport({
        outputDir: senderOutputDir,
        reportPath,
        documentId: item.documentId,
        sourcePath: item.sourcePath,
        translationPath: item.translationPath
      });
      await assertLineReviewMatchesProposalRouting(lineReviewPath, routing);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        documents: []
      };
    }
    const statePath = await htmlSidecarStatePath(lineReviewPath, "line");
    if (!statePath) {
      throw new Error(`Proposal changes contain an invalid line-review state: ${lineReviewPath}`);
    }
    const comparableStatePath = path.resolve(statePath).toLowerCase();
    if (seenStatePaths.has(comparableStatePath)) {
      throw new Error(`Proposal changes contain a duplicate or invalid line-review state: ${lineReviewPath}`);
    }
    seenStatePaths.add(comparableStatePath);
    prepared.push({
      reportPath,
      routing,
      lineReviewPath,
      statePath,
      lineState: item.lineState,
      changedLines: normalizeChangedLineNumbers(item.changedLines),
      changedStateKeys: normalizeChangedStateKeys(item.changedStateKeys),
      expectedLineRevisions: item.expectedLineRevisions
    });
  }
  return withHtmlStateWriteLocks(prepared.map((item) => item.statePath), async () => {
    const updates = await Promise.all(prepared.map(async (item) => {
      const currentState = await readJsonObject(item.statePath) ?? {};
      assertExpectedLineRevisions(currentState, item.expectedLineRevisions, item.changedLines);
      return {
        ...item,
        state: mergeCanonicalLineReviewState(
          currentState,
          item.lineState,
          item.changedLines,
          item.changedStateKeys
        )
      };
    }));
    for (const item of updates) await ensureTransactionalTextTarget(item.statePath, "{}\n");
    await writeTextFilesAtomically(updates.map((item) => ({
      targetPath: item.statePath,
      text: `${JSON.stringify(item.state, null, 2)}\n`
    })));
    for (const item of updates) {
      broadcastLineReviewState({
        ok: true,
        path: item.statePath,
        lineReviewPath: item.lineReviewPath,
        state: item.state,
        changedLines: item.changedLines,
        changedStateKeys: item.changedStateKeys
      });
    }
    return {
      ok: true,
      documents: updates.map((item) => ({
        lineReviewPath: item.lineReviewPath,
        state: item.state,
        changedLines: item.changedLines,
        changedStateKeys: item.changedStateKeys
      }))
    };
  });
});

ipcMain.handle("html:persistState", async (event, args: {
  kind?: unknown;
  lineReviewPath?: unknown;
  state?: unknown;
  changedLines?: unknown;
  changedStateKeys?: unknown;
  clientId?: unknown;
  mutationId?: unknown;
}) => {
  const kind = args?.kind === "line" || args?.kind === "proposal" ? args.kind : "";
  if (!kind) return { ok: false };
  const senderTabPath = [...htmlViewerTabs.values()]
    .find((tab) => tab.view.webContents.id === event.sender.id)?.filePath;
  const senderPath = senderTabPath
    || normalizeLinkedHtmlFilePath(event.sender.getURL().replace(/#.*$/, ""));
  const requestedPath = typeof args.lineReviewPath === "string" && args.lineReviewPath.trim()
    ? normalizeLinkedHtmlFilePath(args.lineReviewPath, senderPath)
    : senderPath;
  if (!requestedPath || path.extname(requestedPath).toLowerCase() !== ".html") return { ok: false };
  const senderWorkspace = workspaceDirFromKnownPath(senderPath);
  const requestedWorkspace = workspaceDirFromKnownPath(requestedPath);
  const sameDocument = sameFilePath(senderPath, requestedPath);
  const sameWorkspace = Boolean(
    senderWorkspace && requestedWorkspace && sameFilePath(senderWorkspace, requestedWorkspace)
  );
  const ownedBatchChild = Boolean(
    senderPath && !sameDocument && await batchLineReviewOwnsChild(senderPath, requestedPath)
  );
  if (!sameDocument && !sameWorkspace && !ownedBatchChild) {
    throw new Error("HTML state cannot cross the current project workspace boundary.");
  }
  const filePath = requestedPath;
  const statePath = await htmlSidecarStatePath(filePath, kind);
  if (!statePath) return { ok: false };
  if (kind === "line") {
    const changedLines = normalizeChangedLineNumbers(args.changedLines);
    const changedStateKeys = normalizeChangedStateKeys(args.changedStateKeys);
    let mutationAccepted = true;
    const canonicalState = await updateHtmlSidecarState(
      statePath,
      (current) => {
        const stateKey = path.resolve(statePath).toLowerCase();
        const sequences = htmlStateMutationSequences.get(stateKey) ?? new Map<string, number>();
        htmlStateMutationSequences.set(stateKey, sequences);
        mutationAccepted = acceptLineReviewMutationSequence(
          sequences,
          args.clientId,
          args.mutationId
        );
        return mutationAccepted
          ? mergeCanonicalLineReviewState(current, args.state, changedLines, changedStateKeys)
          : current;
      }
    );
    const payload = {
      ok: true,
      path: statePath,
      lineReviewPath: filePath,
      state: canonicalState,
      changedLines: mutationAccepted ? changedLines : [],
      changedStateKeys: mutationAccepted ? changedStateKeys : [],
      clientId: typeof args.clientId === "string" ? args.clientId : "",
      mutationId: typeof args.mutationId === "string" ? args.mutationId : "",
      mutationAccepted
    };
    broadcastLineReviewState(payload);
    return payload;
  }
  await writeHtmlSidecarState(statePath, args.state);
  return { ok: true, path: statePath };
});

ipcMain.handle("html:writeBatchLineReviewTxt", async (event) => {
  const batchIndexPath = [...htmlViewerTabs.values()]
    .find((tab) => tab.view.webContents.id === event.sender.id)?.filePath;
  if (!batchIndexPath) {
    throw new Error("The batch review is not open in the Electron HTML workbench.");
  }
  await drainHtmlSidecarStateWrites();
  const writes = await prepareBatchLineReviewTxtWrites(batchIndexPath);
  const written = [];
  for (const write of writes) {
    const result = await writeBoundTranslationText({
      path: write.targetPath,
      text: write.text,
      outputDir: write.outputDir
    });
    written.push({
      path: result.path,
      backupPath: result.backupPath,
      lineCount: write.lineCount
    });
  }
  return { ok: true, written };
});

ipcMain.handle("lan-sync:start", async (event, args: LanSyncStartArgs) => {
  const ownerWebContentsId = event.sender.id;
  if (!lanSyncOwnerDestroyedHandlers.has(ownerWebContentsId)) {
    const handleOwnerDestroyed = () => {
      lanSyncOwnerDestroyedHandlers.delete(ownerWebContentsId);
      const ownedSessions = [...lanSyncSessions.values()]
        .filter((item) => item.ownerWebContentsId === ownerWebContentsId);
      void Promise.all(ownedSessions.map((item) => stopLanSyncSession(item, lanSyncSessions)));
    };
    lanSyncOwnerDestroyedHandlers.set(ownerWebContentsId, handleOwnerDestroyed);
    event.sender.once("destroyed", handleOwnerDestroyed);
  }
  if (!isValidLanSyncPin(args?.pin)) {
    throw new Error(args?.locale === "en-US" ? "LAN sync PIN must be exactly 6 digits." : "局域网同步 PIN 必须是 6 位数字。");
  }
  const senderTabPath = [...htmlViewerTabs.values()]
    .find((tab) => tab.view.webContents.id === event.sender.id)?.filePath;
  const senderPath = senderTabPath
    || normalizeLinkedHtmlFilePath(event.sender.getURL().replace(/#.*$/, ""));
  assertLanSyncStartOwnership(args, senderPath);
  await ensureLanSyncServer();
  const token = randomBytes(18).toString("base64url");
  let lineDocument = normalizeLanSyncLineDocument(args);
  const proposalDocument = normalizeLanSyncProposalDocument(args);
  if (proposalDocument?.lineReviewPath) {
    const basePath = typeof args.htmlPath === "string" ? args.htmlPath : proposalDocument.reportPath;
    const openLineDocument = await readOpenLineReviewDocument(proposalDocument.lineReviewPath, basePath);
    if (openLineDocument && lanSyncLineTranslationCount(openLineDocument) >= lanSyncLineTranslationCount(lineDocument)) {
      lineDocument = openLineDocument;
    }
    if (!lineDocument) {
      lineDocument = await readLinkedLineReviewDocument(proposalDocument.lineReviewPath, basePath);
    }
    if (lineDocument) {
      const incomingState = normalizeLanSyncState(args.lineDocument?.state);
      if (Object.keys(incomingState).length > 0 && lanSyncLineTranslationCount(lineDocument) === 0) {
        lineDocument.state = incomingState;
      }
      lineDocument.pageSize = Number.isInteger(Number(args.pageSize)) && Number(args.pageSize) > 0 ? Number(args.pageSize) : lineDocument.pageSize;
    }
  }
  if (!lineDocument && !proposalDocument) {
    throw new Error(args.locale === "en-US" ? "No shareable document was found." : "没有可共享的文档。");
  }
  const outputDir = normalizeLanSyncOutputDir(args, lineDocument, proposalDocument);
  const session: LanSyncSession = {
    token,
    ownerWebContentsId,
    title: String(args.title || "translation-workshop"),
    pinHash: hashLanSyncPin(args.pin),
    authTokens: new Set(),
    outputDir,
    documents: {
      line: lineDocument,
      proposal: proposalDocument
    },
    locale: args.locale === "en-US" ? "en-US" : "zh-CN",
    createdAt: new Date().toISOString(),
    clients: new Set()
  };
  const registered = await registerLanSyncSession(session, lanSyncSessions, () => !event.sender.isDestroyed());
  if (!registered || event.sender.isDestroyed()) {
    await stopLanSyncSession(session, lanSyncSessions);
    return { ok: false };
  }
  return {
    ok: true,
    token,
    ...await lanSyncUrls(token),
    externalTunnelNote: session.locale === "en-US"
      ? "translation-workshop does not bundle public tunneling tools. If you use Cloudflare Tunnel, ngrok, or similar tools, point them to the local sync address."
      : "translation-workshop 不内置公网穿透工具。如果你使用 Cloudflare Tunnel、ngrok 等工具，可将它们指向本地同步地址。"
  };
});

ipcMain.handle("lan-sync:patch", async (event, args: { token?: string; patch?: LanSyncPatch }) => {
  const token = String(args?.token || "");
  const session = lanSyncSessions.get(token);
  if (!session || session.ownerWebContentsId !== event.sender.id || !args.patch) {
    return { ok: false };
  }
  const patch: LanSyncPatch = {
    ...args.patch,
    clientId: args.patch.clientId || "desktop",
    timestamp: args.patch.timestamp || new Date().toISOString()
  };
  await commitLanSyncPatch(session, patch, persistLanSyncPatch, broadcastLanSyncPatch);
  return { ok: true };
});

ipcMain.handle("lan-sync:stop", async (event, token: string) => {
  const session = lanSyncSessions.get(String(token || ""));
  if (!session || session.ownerWebContentsId !== event.sender.id) {
    return { ok: false };
  }
  await stopLanSyncSession(session, lanSyncSessions);
  return { ok: true };
});

ipcMain.handle("reports:findProofreadReport", async (_event, outputDir: string) => {
  if (!outputDir) {
    return [];
  }
  return findProofreadReportCandidates(outputDir);
});

ipcMain.handle("files:scanTranslations", async (_event, outputDir: string) => {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.txt$/i.test(entry.name) && /trans|译|translation|zh|cn/i.test(entry.name))
      .map(async (entry) => {
        const fullPath = path.join(outputDir, entry.name);
        const info = await stat(fullPath);
        return { path: fullPath, size: info.size, modifiedAt: info.mtime.toISOString() };
      })
  );
  return candidates.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
});

ipcMain.handle("clipboard:writeText", async (_event, text: string) => {
  return writeClipboardTextVerified(clipboard, text);
});

ipcMain.handle("files:writeTextFile", async (_event, args: WriteTextFileArgs) => {
  return writeBoundTranslationText(args);
});

ipcMain.handle("files:readTextFile", async (_event, args: ReadTextFileArgs) => {
  const targetPath = args.path;
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error("A bound absolute text path is required.");
  }
  const info = await stat(targetPath);
  if (info.size > 20 * 1024 * 1024) {
    throw new Error("Text file is too large to sync safely.");
  }
  return { ok: true, path: targetPath, text: await readFile(targetPath, "utf8") };
});

ipcMain.handle("files:writeAuditWhitelistFile", async (_event, args: WriteAuditWhitelistFileArgs) => {
  const outputRoot = args.outputDir && path.isAbsolute(args.outputDir)
    ? args.outputDir
    : args.sourcePath && path.isAbsolute(args.sourcePath)
      ? path.dirname(args.sourcePath)
      : "";
  if (!outputRoot) {
    throw new Error("An absolute output or source path is required for the audit whitelist.");
  }
  const workspaceDir = await ensureWorkspace(outputRoot);
  const targetPath = path.join(workspaceDir, "audit-whitelist.json");
  const uniqueLines = [...new Set((args.lines ?? []).filter((line) => Number.isInteger(line) && line > 0))].sort((a, b) => a - b);
  const readMergedWhitelistText = async () => JSON.stringify(mergeAuditWhitelistDocument(
    await readJsonObject(targetPath) ?? {},
    {
      documentId: args.documentId,
      sourcePath: args.sourcePath,
      lines: uniqueLines
    }
  ), null, 2);
  const transactional = args.lineReviewPath !== undefined
    || args.lineState !== undefined
    || args.changedLines !== undefined;
  if (!transactional) {
    const backupPath = await backupFile(targetPath, outputRoot);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeTextFileAtomically(targetPath, await readMergedWhitelistText());
    return { ok: true, path: targetPath, backupPath, lineCount: uniqueLines.length };
  }

  const normalizedLineReviewPath = typeof args.lineReviewPath === "string"
    ? normalizeLinkedHtmlFilePath(args.lineReviewPath.replace(/#.*$/, ""))
    : "";
  const changedLines = normalizeChangedLineNumbers(args.changedLines);
  if (
    !normalizedLineReviewPath
    || path.extname(normalizedLineReviewPath).toLowerCase() !== ".html"
    || changedLines.length === 0
    || !args.lineState
  ) {
    throw new Error("Atomic audit-whitelist updates require a bound line-review HTML, line state, and changed lines.");
  }
  const statePath = await htmlSidecarStatePath(normalizedLineReviewPath, "line");
  if (!statePath || !isSameOrInside(workspaceDir, statePath)) {
    throw new Error("The linked line-review state is outside the project workspace.");
  }
  const queueKey = path.resolve(targetPath).toLowerCase();
  const previous = htmlStateWriteQueues.get(queueKey) ?? Promise.resolve();
  let canonicalState: Record<string, unknown> = {};
  const current = previous.catch(() => undefined).then(async () => {
    await ensureTransactionalTextTarget(statePath, "{}\n");
    await ensureTransactionalTextTarget(targetPath, `${JSON.stringify({
      version: 2,
      documents: {},
      updatedAt: new Date(0).toISOString()
    }, null, 2)}\n`);
    canonicalState = mergeCanonicalLineReviewState(
      await readJsonObject(statePath) ?? {},
      args.lineState,
      changedLines,
      ["auditVisible"]
    );
    const whitelistText = await readMergedWhitelistText();
    await writeTextFilesAtomically([
      { targetPath: statePath, text: `${JSON.stringify(canonicalState, null, 2)}\n` },
      { targetPath, text: `${whitelistText}\n` }
    ]);
  });
  htmlStateWriteQueues.set(queueKey, current);
  try {
    await current;
  } finally {
    if (htmlStateWriteQueues.get(queueKey) === current) htmlStateWriteQueues.delete(queueKey);
  }
  const payload = {
    ok: true,
    path: targetPath,
    lineCount: uniqueLines.length,
    lineReviewPath: normalizedLineReviewPath,
    state: canonicalState,
    changedLines,
    changedStateKeys: ["auditVisible"]
  };
  broadcastLineReviewState(payload);
  return payload;
});

ipcMain.handle("files:writeEpubFile", async (_event, args: WriteEpubFileArgs) => {
  const templatePath = args.templatePath;
  if (!templatePath || !path.isAbsolute(templatePath)) {
    throw new Error("An absolute EPUB template path is required.");
  }
  const outputRoot = args.outputDir && path.isAbsolute(args.outputDir) ? args.outputDir : path.dirname(templatePath);
  const workspaceDir = await ensureWorkspace(outputRoot);
  const result = await createTranslatedEpub({
    templatePath,
    translatedLines: args.lines ?? [],
    workspaceDir,
    outputDir: outputRoot,
    replacement: {
      mode: args.mode,
      replacePosition: args.replacePosition,
      pairSize: args.pairSize
    }
  });
  return { ok: true, path: result.outputPath, changedDocuments: result.changedDocuments };
});

ipcMain.handle("shell:openPath", async (_event, targetPath: string) => {
  if (isHtmlOpenTarget(targetPath)) {
    try {
      await openHtmlWindow(targetPath);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return shell.openPath(targetPath);
});

ipcMain.handle("html-tabs:activate", async (_event, key: string) => {
  const activated = activateHtmlViewerTab(key);
  if (activated) await rememberActiveHtmlViewerProject();
  return activated;
});

ipcMain.handle("html-tabs:close", async (_event, key: string) => {
  const closed = await closeHtmlViewerTab(key);
  if (closed) await rememberActiveHtmlViewerProject();
  return closed;
});

let agentIpcRegistered = false;
async function ensureAgentIpcRegistered(): Promise<void> {
  if (agentIpcRegistered) {
    return;
  }
  const [
    { registerAgentAssetIpc },
    { registerAgentArtifactIpc },
    { registerAgentSessionIpc },
    { registerAgentProviderIpc }
  ] = await Promise.all([
    import("./ipc/agentAssetHandlers.ts"),
    import("./ipc/agentArtifactHandlers.ts"),
    import("./ipc/agentSessionHandlers.ts"),
    import("./ipc/agentProviderHandlers.ts")
  ]);
  registerAgentAssetIpc();
  registerAgentArtifactIpc();
  registerAgentSessionIpc({
    resolveInterfaceWorkspace(sender) {
      const workspaceDir = [...htmlViewerTabs.values()]
        .find((tab) => tab.view.webContents.id === sender.id)?.workspaceDir;
      return workspaceDir ? normalizeProjectFolder(workspaceDir).outputDir : undefined;
    }
  });
  registerAgentProviderIpc();
  agentIpcRegistered = true;
}

app.whenReady().then(async () => {
  await recordPortableSmoke("app-ready");
  configureGlobalAgentDataDir(app.getPath("userData"));
  configureWebReferenceBrowserFetch((url, init) => session.defaultSession.fetch(url, init));
  initializeAutoUpdates();
  configureApplicationMenu();
  await ensureAgentIpcRegistered();
  await recordPortableSmoke("ipc-ready");
  const win = await createWindow();
  await recordPortableSmoke("renderer-ready", {
    rendererUrl: win.webContents.getURL(),
    rendererLoaded: !win.webContents.isLoadingMainFrame(),
    windowVisible: win.isVisible()
  });
  if (portableSmokeMarkerPath) {
    const { runProofreadPrescan } = await import("./agent/piNative/proofreadPrescanService.ts");
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 10);
    let prescanSignals;
    try {
      prescanSignals = await runProofreadPrescan({
        sourceText: "魔術師です。\n".repeat(5000),
        translationText: "这是另一种职业。\n".repeat(5000),
        validationOptions: { languagePair: "ja->zh-CN", glossaryEntries: [{ source: "魔術師", target: "法师" }] }
      });
    } finally { clearInterval(heartbeat); }
    if (!heartbeatTicks || prescanSignals.filter((signal) => signal.code === "H3").length !== 5000) {
      throw new Error("Packaged proofreading worker failed responsiveness/signal verification.");
    }
    await writeFile(portableSmokeMarkerPath, `${JSON.stringify({
      version: app.getVersion(),
      pid: process.pid,
      rendererUrl: win.webContents.getURL(),
      rendererLoaded: !win.webContents.isLoadingMainFrame(),
      windowVisible: win.isVisible(),
      proofreadWorkerVerified: true,
      proofreadHeartbeatTicks: heartbeatTicks
    }, null, 2)}\n`, "utf8");
    app.quit();
    return;
  }
  scheduleStartupUpdateCheck();
}).catch(async (error) => {
  await recordPortableSmoke("failed", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }).catch(() => undefined);
  console.error("[startup] Application initialization failed", error);
  app.exit(1);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
