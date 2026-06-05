import { app, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, webContents, type MenuItemConstructorOptions } from "electron";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

import { formatInteractiveAgentMessage } from "../shared/core/agentConsoleInput.ts";
import { buildTimestampedBackupPath } from "../shared/core/backups.ts";
import { buildAgentPromptFileMessage, shouldSendAgentPromptViaFile } from "../shared/core/agentPromptTransport.ts";
import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { executableNames, resolveCliFromPath } from "../shared/core/cliResolver.ts";
import { matchFolderFiles, type FolderLineFile } from "../shared/core/folderMatch.ts";
import { parseGlossaryText, type GlossaryEntry } from "../shared/core/glossary.ts";
import { renderBatchLineReviewIndexHtml, renderLineReviewHtml, renderProposalReviewHtml, type BatchLineReviewIndexFile, type UiLocale } from "../shared/core/html.ts";
import {
  embeddedProposalLinks,
  rewriteProposalReviewLineReviewPathContent,
  upgradeLegacyLineReviewHtmlContent,
  upgradeLegacyProposalReviewHtmlContent
} from "../shared/core/legacyHtml.ts";
import { rankProofreadReportCandidates, type ProofreadReportCandidate } from "../shared/core/reportDiscovery.ts";
import { parseProofreadMarkdown } from "../shared/core/reviewReport.ts";
import { buildGithubSkillInstallCommand, buildLocalSkillInstallArgs, buildLocalSkillInstallCommand, type SkillInstallAgent } from "../shared/core/skillInstall.ts";
import { buildPrompt, type PromptAdvancedOptions, type PromptBuildOptions } from "../shared/core/prompts.ts";
import { readEpubText } from "./epubReader.ts";
import { createTranslatedEpub } from "./epubWriter.ts";

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
}

interface LanSyncLineRow {
  line: number;
  source: string;
  translation?: string;
  status?: string;
}

interface LanSyncPatch {
  type: "line-edit" | "line-restore" | "proposal-decision";
  line?: number;
  proposalId?: string;
  text?: string;
  status?: string;
  manualText?: string;
  clientId?: string;
  timestamp?: string;
}

interface LanSyncLineDocument {
  title?: string;
  rows: LanSyncLineRow[];
  state: Record<string, unknown>;
  pageSize?: number;
  lineReviewPath?: string;
}

interface LanSyncProposalItem {
  id: string;
  line?: number;
  src?: string;
  current?: string;
  problemType?: string;
  problem?: string;
  suggestion?: string;
  status?: string;
}

interface LanSyncProposalDocument {
  title?: string;
  proposals: LanSyncProposalItem[];
  state: Record<string, unknown>;
  pageSize?: number;
  reportPath?: string;
  lineReviewPath?: string;
}

interface LanSyncStartArgs {
  title?: string;
  pin?: string;
  htmlPath?: string;
  outputDir?: string;
  agent?: "codex" | "claude";
  rows?: LanSyncLineRow[];
  state?: Record<string, unknown>;
  lineReviewPath?: string;
  lineDocument?: Partial<LanSyncLineDocument>;
  proposalDocument?: Partial<LanSyncProposalDocument>;
  locale?: UiLocale;
  pageSize?: number;
}

interface LanSyncSession {
  token: string;
  ownerWebContentsId: number;
  title: string;
  pinHash: string;
  authTokens: Set<string>;
  outputDir?: string;
  agent: "codex" | "claude";
  documents: {
    line?: LanSyncLineDocument;
    proposal?: LanSyncProposalDocument;
  };
  locale: UiLocale;
  createdAt: string;
  clients: Set<ServerResponse>;
}

interface WriteTextFileArgs {
  path?: string;
  text?: string;
  outputDir?: string;
}

interface ReadTextFileArgs {
  path?: string;
}

interface WriteGlossaryFileArgs {
  path?: string;
  text?: string;
  outputDir?: string;
}

interface WriteAuditWhitelistFileArgs {
  outputDir?: string;
  sourcePath?: string;
  lines?: number[];
}

interface WriteEpubFileArgs {
  templatePath?: string;
  lines?: string[];
  outputDir?: string;
  mode?: "all" | "pair-position";
  replacePosition?: number;
  pairSize?: number;
}

interface AgentConsoleStartArgs {
  agent?: "codex" | "claude";
  outputDir?: string;
  cols?: number;
  rows?: number;
}

interface AgentConsoleInputArgs {
  data?: string;
}

interface AgentConsoleInputResult {
  ok: boolean;
  message?: string;
  promptPath?: string;
}

interface AgentConsoleResizeArgs {
  cols?: number;
  rows?: number;
}

interface SkillInstallArgs {
  agent?: SkillInstallAgent;
}

type PromptBuildArgs = Partial<PromptBuildOptions>;

interface AgentInstallCheck {
  agent: "codex" | "claude";
  cliFound: boolean;
  cliPath: string;
  skillsFound: boolean;
  installedSkillPaths: string[];
  missingSkillPaths: string[];
}

interface SkillInstallStatus {
  selectedAgent: "codex" | "claude";
  home: string;
  anyCliFound: boolean;
  selected: AgentInstallCheck;
  agents: {
    codex: AgentInstallCheck;
    claude: AgentInstallCheck;
  };
}

interface PtyProcess {
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[], options: {
    cwd: string;
    cols: number;
    rows: number;
    name: string;
    env: NodeJS.ProcessEnv;
  }): PtyProcess;
}

interface InteractiveAgentSession {
  id: string;
  agent: "codex" | "claude";
  outputDir: string;
  startedAt: string;
  pty: PtyProcess;
  outputBuffer: string;
  recentOutput?: string;
  dismissedUpdatePrompt?: boolean;
  dismissedTrustPrompt?: boolean;
  lastDeniedClaudeMemoryPrompt?: string;
  cleanupPaths?: string[];
}

interface ApplyLineReviewStateArgs {
  lineReviewPath?: string;
  lineState?: unknown;
  line?: number;
  activate?: boolean;
}

interface HtmlCandidate {
  path: string;
  modifiedMs: number;
  depth: number;
}

type BilingualFileKind = "txt" | "epub";

const isDev = process.env.TRANSLATION_WORKSHOP_DEV === "1";
const repositoryUrl = "https://github.com/TohmaN233/YN-translation-workshop";
const require = createRequire(import.meta.url);
const htmlViewerTabs = new Map<string, { filePath: string; hash: string; title: string; view: BrowserView }>();
let htmlViewerWindow: BrowserWindow | undefined;
let activeHtmlViewerTab = "";
const htmlViewerTabBarHeight = 44;
let interactiveAgentSession: InteractiveAgentSession | undefined;
let lanSyncServer: Server | undefined;
let lanSyncPort = 0;
const lanSyncSessions = new Map<string, LanSyncSession>();

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

function lanSyncLabels(locale: UiLocale): Record<string, string> {
  if (locale === "en-US") {
    return {
      title: "translation-workshop shared workspace",
      loading: "Loading...",
      previous: "Previous",
      next: "Next",
      go: "Go",
      page: "Page",
      total: "Total",
      search: "Search",
      searchPlaceholder: "Search source, translation, issue, or suggestion",
      searchNoMatches: "No matches.",
      controlsOpen: "Show tools",
      controlsClose: "Hide tools",
      saved: "Synced",
      offline: "Disconnected",
      line: "Line",
      source: "Source",
      translation: "Translation",
      current: "Current translation",
      issueType: "Issue type",
      issue: "Issue",
      suggestion: "Suggested fix",
      accept: "Accept",
      reject: "Reject",
      manual: "Manual edit",
      unreviewed: "Unreviewed",
      lineTab: "Line review",
      proposalTab: "Proposal review",
      empty: "No document in this shared session.",
      pinTitle: "Enter PIN",
      pinHelp: "Use the fixed 6-digit PIN shown in the desktop app.",
      pinPlaceholder: "6-digit PIN",
      unlock: "Unlock",
      pinInvalid: "PIN must be 6 digits.",
      pinFailed: "PIN verification failed.",
      agentConsole: "Agent Console",
      agentOpen: "Open",
      agentClose: "Collapse",
      agentCodex: "Codex",
      agentClaude: "Claude Code",
      agentStart: "Start Agent",
      agentStop: "Stop",
      agentSend: "Send",
      agentInput: "Prompt / message",
      agentOutput: "Agent output",
      agentNeedsOutput: "This shared session has no bound output folder, so Agent cannot be started.",
      agentStarted: "Agent started",
      agentStopped: "Agent stopped",
      agentOutputReady: "Agent has output"
    };
  }
  return {
    title: "translation-workshop 共享工作区",
    loading: "加载中...",
    previous: "上一页",
    next: "下一页",
    go: "跳转",
    page: "页码",
    total: "总数",
    search: "搜索",
    searchPlaceholder: "搜索原文、译文、问题或建议",
    searchNoMatches: "没有匹配结果。",
    controlsOpen: "展开工具",
    controlsClose: "收起工具",
    saved: "已同步",
    offline: "连接已断开",
    line: "行",
    source: "源文",
    translation: "译文",
    current: "当前译文",
    issueType: "问题类型",
    issue: "问题说明",
    suggestion: "建议译文",
    accept: "接受",
    reject: "拒绝",
    manual: "人工改写",
    unreviewed: "未审阅",
    lineTab: "正文校对",
    proposalTab: "审阅建议",
    empty: "当前共享会话没有文档。",
    pinTitle: "输入 PIN",
    pinHelp: "请输入桌面端设置的固定 6 位 PIN。",
    pinPlaceholder: "6 位 PIN",
    unlock: "解锁",
    pinInvalid: "PIN 必须是 6 位数字。",
    pinFailed: "PIN 验证失败。",
    agentConsole: "Agent 控制台",
    agentOpen: "展开",
    agentClose: "收起",
    agentCodex: "Codex",
    agentClaude: "Claude Code",
    agentStart: "启动 Agent",
    agentStop: "停止",
    agentSend: "发送",
    agentInput: "提示词 / 消息",
    agentOutput: "Agent 输出",
    agentNeedsOutput: "当前共享会话没有绑定输出文件夹，无法启动 Agent。",
    agentStarted: "Agent 已启动",
    agentStopped: "Agent 已停止",
    agentOutputReady: "Agent 有新输出"
  };
}

function lanSyncJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function lanSyncResponse(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

function lanSyncEscapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  }[character] ?? character));
}

function lanSyncLandingHtml(): string {
  const sessions = [...lanSyncSessions.values()];
  const links = sessions
    .map((session) => `<li><a href="/s/${encodeURIComponent(session.token)}">${lanSyncEscapeHtml(session.title || "translation-workshop")}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>translation-workshop</title>
  <style>
    body { margin:0; padding:28px; font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#263452; background:#f5fbff; }
    main { max-width:680px; margin:auto; padding:24px; border:1px solid #d8e7f8; border-radius:12px; background:#fff; box-shadow:0 16px 38px rgba(78,105,150,.12); }
    h1 { margin:0 0 12px; font-size:24px; }
    p { margin:8px 0; color:#66708b; }
    a { color:#1f6fb2; font-weight:700; }
  </style>
</head>
<body>
  <main>
    <h1>translation-workshop</h1>
    ${sessions.length > 0
      ? `<p>请选择当前同步会话。外部穿透工具只给根地址时，也可以从这里进入。</p><ul>${links}</ul>`
      : `<p>没有正在运行的同步会话。请先在桌面端 HTML 中启动局域网同步。</p>`}
    <p>如果你使用 Cloudflare Tunnel/ngrok，请把穿透目标指向桌面端显示的本地同步端口。</p>
  </main>
</body>
</html>`;
}

function lanSyncSessionNotFoundHtml(requestedPath: string): string {
  const sessions = [...lanSyncSessions.values()];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Session not found</title>
  <style>
    body { margin:0; padding:28px; font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#263452; background:#fff7f7; }
    main { max-width:720px; margin:auto; padding:24px; border:1px solid #f2c4c4; border-radius:12px; background:#fff; box-shadow:0 16px 38px rgba(150,78,78,.12); }
    code { padding:2px 5px; border-radius:5px; background:#f7eef0; }
    a { color:#1f6fb2; font-weight:700; }
  </style>
</head>
<body>
  <main>
    <h1>Session not found</h1>
    <p>找不到这个同步会话：<code>${lanSyncEscapeHtml(requestedPath)}</code></p>
    <p>如果你正在使用 Cloudflare Tunnel/ngrok，请确认公网地址后面保留了桌面端链接中的 <code>/s/...</code> 路径。</p>
    <p>当前正在运行的会话数：${sessions.length}。${sessions.length === 1 ? `可以尝试打开 <a href="/s/${encodeURIComponent(sessions[0].token)}">当前会话</a>。` : `可以返回 <a href="/">同步入口</a>。`}</p>
  </main>
</body>
</html>`;
}

function normalizeLanSyncState(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeLanSyncRows(value: unknown): LanSyncLineRow[] {
  return Array.isArray(value)
    ? value
        .map((row) => {
          const source = row && typeof row === "object" ? row as Partial<LanSyncLineRow> : {};
          return {
            line: Number(source.line),
            source: String(source.source ?? ""),
            translation: source.translation === undefined ? undefined : String(source.translation),
            status: source.status === undefined ? undefined : String(source.status)
          };
        })
        .filter((row) => Number.isInteger(row.line) && row.line > 0)
    : [];
}

function normalizeLanSyncProposals(value: unknown): LanSyncProposalItem[] {
  return Array.isArray(value)
    ? value
        .map((item, index) => {
          const source = item && typeof item === "object" ? item as Partial<LanSyncProposalItem> : {};
          return {
            id: String(source.id || `P-${index + 1}`),
            line: Number.isInteger(Number(source.line)) && Number(source.line) > 0 ? Number(source.line) : undefined,
            src: source.src === undefined ? undefined : String(source.src),
            current: source.current === undefined ? undefined : String(source.current),
            problemType: source.problemType === undefined ? undefined : String(source.problemType),
            problem: source.problem === undefined ? undefined : String(source.problem),
            suggestion: source.suggestion === undefined ? undefined : String(source.suggestion),
            status: source.status === undefined ? undefined : String(source.status)
          };
        })
        .filter((item) => item.id)
    : [];
}

function normalizeLanSyncLineDocument(args: LanSyncStartArgs): LanSyncLineDocument | undefined {
  const source = args.lineDocument && typeof args.lineDocument === "object" ? args.lineDocument : {};
  const rows = normalizeLanSyncRows(source.rows ?? args.rows);
  if (rows.length === 0) {
    return undefined;
  }
  return {
    title: typeof source.title === "string" && source.title.trim() ? source.title : args.title,
    rows,
    state: normalizeLanSyncState(source.state ?? args.state),
    pageSize: Number.isInteger(Number(source.pageSize ?? args.pageSize)) && Number(source.pageSize ?? args.pageSize) > 0
      ? Number(source.pageSize ?? args.pageSize)
      : undefined,
    lineReviewPath: typeof source.lineReviewPath === "string" && source.lineReviewPath.trim()
      ? source.lineReviewPath
      : typeof args.lineReviewPath === "string" && args.lineReviewPath.trim()
        ? args.lineReviewPath
        : undefined
  };
}

function normalizeLinkedHtmlFilePath(value: string, basePath?: string): string {
  const raw = value.trim().replace(/#.*$/, "");
  if (!raw) {
    return "";
  }
  if (/^file:/i.test(raw)) {
    try {
      const pathname = decodeURIComponent(new URL(raw).pathname || "");
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return "";
    }
  }
  const normalized = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized;
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  const baseDir = basePath && path.isAbsolute(basePath) ? path.dirname(basePath) : "";
  return baseDir ? path.resolve(baseDir, raw) : "";
}

function workspaceRootFromContainedPath(value?: string): string {
  if (!value) {
    return "";
  }
  const filePath = normalizeLinkedHtmlFilePath(value);
  if (!filePath || !path.isAbsolute(filePath)) {
    return "";
  }
  const normalized = path.normalize(filePath);
  const parts = normalized.split(path.sep);
  const index = parts.findIndex((part) => part.toLowerCase() === ".translation-workshop");
  if (index > 0) {
    return parts.slice(0, index).join(path.sep) || path.parse(normalized).root;
  }
  return path.dirname(normalized);
}

function normalizeLanSyncOutputDir(args: LanSyncStartArgs, line?: LanSyncLineDocument, proposal?: LanSyncProposalDocument): string | undefined {
  const direct = typeof args.outputDir === "string" ? args.outputDir.trim() : "";
  if (direct && path.isAbsolute(direct)) {
    return direct;
  }
  const inferred = [
    workspaceRootFromContainedPath(proposal?.reportPath),
    workspaceRootFromContainedPath(proposal?.lineReviewPath),
    workspaceRootFromContainedPath(line?.lineReviewPath),
    workspaceRootFromContainedPath(typeof args.htmlPath === "string" ? args.htmlPath : undefined)
  ].find((item) => item && path.isAbsolute(item));
  return inferred || undefined;
}

function parseLineReviewRowsFromHtmlContent(html: string): LanSyncLineRow[] {
  const match = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[1]) as { rows?: unknown };
    return normalizeLanSyncRows(parsed.rows);
  } catch {
    return [];
  }
}

async function readLinkedLineReviewDocument(lineReviewPath: string, basePath?: string): Promise<LanSyncLineDocument | undefined> {
  const filePath = normalizeLinkedHtmlFilePath(lineReviewPath, basePath);
  if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) {
    return undefined;
  }
  const info = await stat(filePath);
  if (info.size > 80 * 1024 * 1024) {
    return undefined;
  }
  const rows = parseLineReviewRowsFromHtmlContent(await readFile(filePath, "utf8"));
  if (rows.length === 0) {
    return undefined;
  }
  return {
    title: path.basename(filePath),
    rows,
    state: {},
    pageSize: 1000,
    lineReviewPath: filePath
  };
}

function lanSyncLineTranslationCount(document: LanSyncLineDocument | undefined): number {
  if (!document) {
    return 0;
  }
  const edits = document.state.edits && typeof document.state.edits === "object"
    ? document.state.edits as Record<string, unknown>
    : {};
  return document.rows.filter((row) => {
    const edited = edits[String(row.line)];
    return String(edited ?? row.translation ?? "").trim().length > 0;
  }).length;
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

function normalizeLanSyncProposalDocument(args: LanSyncStartArgs): LanSyncProposalDocument | undefined {
  const source = args.proposalDocument && typeof args.proposalDocument === "object" ? args.proposalDocument : undefined;
  if (!source) {
    return undefined;
  }
  const proposals = normalizeLanSyncProposals(source.proposals);
  if (proposals.length === 0) {
    return undefined;
  }
  return {
    title: typeof source.title === "string" && source.title.trim() ? source.title : args.title,
    proposals,
    state: normalizeLanSyncState(source.state),
    pageSize: Number.isInteger(Number(source.pageSize ?? args.pageSize)) && Number(source.pageSize ?? args.pageSize) > 0
      ? Number(source.pageSize ?? args.pageSize)
      : undefined,
    reportPath: typeof source.reportPath === "string" && source.reportPath.trim() ? source.reportPath : undefined,
    lineReviewPath: typeof source.lineReviewPath === "string" && source.lineReviewPath.trim()
      ? source.lineReviewPath
      : typeof args.lineReviewPath === "string" && args.lineReviewPath.trim()
        ? args.lineReviewPath
        : undefined
  };
}

function hashLanSyncPin(pin: string): string {
  return createHash("sha256").update(pin, "utf8").digest("hex");
}

function isValidLanSyncPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

function lanSyncAuthTokenFrom(url: URL, body?: { authToken?: unknown }): string {
  const fromQuery = url.searchParams.get("auth");
  if (fromQuery) {
    return fromQuery;
  }
  return typeof body?.authToken === "string" ? body.authToken : "";
}

function isLanSyncAuthorized(session: LanSyncSession, token: string): boolean {
  return Boolean(token && session.authTokens.has(token));
}

function lanSyncSessionPayload(session: LanSyncSession): Record<string, unknown> {
  const line = session.documents.line;
  const proposal = session.documents.proposal;
  return {
    title: session.title,
    agent: session.agent,
    outputDir: session.outputDir,
    rows: line?.rows ?? [],
    state: line?.state ?? {},
    pageSize: line?.pageSize ?? 1000,
    documents: {
      line: line ? {
        title: line.title,
        rows: line.rows,
        state: line.state,
        pageSize: line.pageSize ?? 1000,
        lineReviewPath: line.lineReviewPath
      } : undefined,
      proposal: proposal ? {
        title: proposal.title,
        proposals: proposal.proposals,
        state: proposal.state,
        pageSize: proposal.pageSize ?? 1000,
        reportPath: proposal.reportPath,
        lineReviewPath: proposal.lineReviewPath
      } : undefined
    },
    labels: lanSyncLabels(session.locale),
    createdAt: session.createdAt
  };
}

function applyLanSyncPatchToSession(session: LanSyncSession, patch: LanSyncPatch): void {
  if (patch.type === "proposal-decision") {
    const proposalId = String(patch.proposalId || "").trim();
    const proposal = session.documents.proposal;
    if (!proposalId || !proposal) {
      return;
    }
    const decisions = (proposal.state.decisions && typeof proposal.state.decisions === "object")
      ? proposal.state.decisions as Record<string, unknown>
      : {};
    proposal.state.decisions = decisions;
    decisions[proposalId] = {
      status: patch.status || "manual",
      manualText: patch.manualText === undefined ? "" : String(patch.manualText)
    };
    return;
  }
  const lineDocument = session.documents.line;
  if (!lineDocument) {
    return;
  }
  const line = Number(patch.line || 0);
  if (!Number.isInteger(line) || line <= 0) {
    return;
  }
  const edits = (lineDocument.state.edits && typeof lineDocument.state.edits === "object")
    ? lineDocument.state.edits as Record<string, unknown>
    : {};
  const status = (lineDocument.state.status && typeof lineDocument.state.status === "object")
    ? lineDocument.state.status as Record<string, unknown>
    : {};
  lineDocument.state.edits = edits;
  lineDocument.state.status = status;
  lineDocument.state.activeLine = String(line);
  if (patch.type === "line-restore") {
    delete edits[String(line)];
    delete status[String(line)];
    return;
  }
  edits[String(line)] = String(patch.text ?? "");
  status[String(line)] = patch.status || "manual";
}

async function persistLanSyncLinePatch(session: LanSyncSession, patch: LanSyncPatch): Promise<void> {
  if (patch.type !== "line-edit" && patch.type !== "line-restore") {
    return;
  }
  const lineDocument = session.documents.line;
  if (!lineDocument?.lineReviewPath) {
    return;
  }
  const line = Number(patch.line || 0);
  if (!Number.isInteger(line) || line <= 0) {
    return;
  }
  try {
    await applyLineReviewStateToView({
      lineReviewPath: lineDocument.lineReviewPath,
      lineState: lineDocument.state,
      line,
      activate: false
    });
  } catch {
    // The live mobile session remains usable even if the linked desktop tab cannot be opened.
  }
}

function broadcastLanSyncPatch(session: LanSyncSession, patch: LanSyncPatch): void {
  const data = `event: patch\ndata: ${lanSyncJson({ patch })}\n\n`;
  for (const client of [...session.clients]) {
    if (client.destroyed) {
      session.clients.delete(client);
      continue;
    }
    client.write(data);
  }
}

function sendLanSyncPatchToOwner(session: LanSyncSession, patch: LanSyncPatch): void {
  webContents.fromId(session.ownerWebContentsId)?.send("lan-sync:patch", {
    token: session.token,
    patch
  });
}

function stopLanSyncSession(session: LanSyncSession): void {
  for (const client of session.clients) {
    client.write(`event: stop\ndata: ${lanSyncJson({ ok: true })}\n\n`);
    client.end();
  }
  lanSyncSessions.delete(session.token);
}

async function readLanSyncBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as unknown : {};
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
  <link rel="stylesheet" href="/assets/xterm/xterm.css">
  <script src="/assets/xterm/xterm.js"></script>
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
    main { display:grid; gap:12px; padding:12px; min-width:0; max-width:100vw; overflow-x:hidden; }
    article { display:grid; gap:8px; min-width:0; max-width:100%; padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); box-shadow:0 8px 20px rgba(95,111,191,.08); overflow:hidden; }
    .meta { display:flex; justify-content:space-between; gap:8px; min-width:0; color:var(--muted); font-size:12px; font-weight:700; }
    .meta span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .source { min-width:0; max-width:100%; padding:10px; border-radius:8px; background:#f8fbff; white-space:pre-wrap; overflow-wrap:anywhere; }
    .field { display:grid; gap:4px; min-width:0; }
    .field b { color:var(--muted); font-size:12px; }
    .field div { min-width:0; max-width:100%; padding:10px; border-radius:8px; background:#f8fbff; white-space:pre-wrap; overflow-wrap:anywhere; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    .actions button.active { border-color:#77c8ff; background:#eaf8ff; font-weight:700; }
    textarea { width:100%; min-width:0; max-width:100%; min-height:92px; resize:vertical; line-height:1.5; overflow-wrap:anywhere; }
    select { font:inherit; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); padding:8px 10px; }
    .agent { display:grid; gap:8px; padding:8px 10px; border:1px solid var(--line); border-radius:10px; background:#f8fbff; }
    .agent-head { display:flex; align-items:center; gap:8px; }
    .agent-head strong { margin-right:auto; }
    .agent-head .status { flex:1 1 auto; min-width:0; min-height:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; text-align:right; }
    .agent-body { display:grid; gap:8px; max-height:62vh; overflow:auto; overscroll-behavior:contain; }
    .agent.collapsed .agent-body { display:none; }
    .agent textarea { min-height:72px; }
    .agent-log { height:min(42vh,380px); min-height:260px; overflow:auto; padding:4px; border-radius:8px; background:#071523; color:#dbeafe; font:12px/1.35 Consolas,"Cascadia Mono","Courier New",monospace; overscroll-behavior:contain; }
    .agent-log .xterm { height:100%; }
    .agent-log .xterm-viewport { overflow-y:auto !important; }
    .status { color:var(--muted); min-height:22px; }
    @media (max-width: 640px) {
      header { gap:6px; padding:8px 10px; }
      .header-top h1 { display:none; }
      .tabs { flex:1 1 auto; min-width:0; }
      .tabs button { flex:1 1 0; min-width:0; padding:7px 8px; }
      .controls-toggle { min-height:36px; }
      .agent-body { max-height:64vh; }
      .agent-log { height:42vh; min-height:260px; }
      .agent textarea { min-height:58px; }
      .agent .bar { gap:6px; }
      .agent .bar button, .agent .bar select, #agentSend { padding:7px 8px; }
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
      <label class="search-box"><span id="searchLabel">Search</span><input id="searchInput" type="search"></label>
      <section class="agent collapsed" id="agentPanel">
        <div class="agent-head">
          <strong id="agentTitle">Agent Console</strong>
          <span id="agentStatus" class="status"></span>
          <button id="agentToggle" type="button">Open</button>
        </div>
        <div class="agent-body" id="agentBody" hidden>
          <div class="bar">
            <select id="agentSelect"><option value="codex">Codex</option><option value="claude">Claude Code</option></select>
            <button id="agentStart" type="button">Start Agent</button>
            <button id="agentStop" type="button">Stop</button>
          </div>
          <div id="agentOutput" class="agent-log"></div>
          <textarea id="agentInput" spellcheck="false" placeholder="Prompt / message"></textarea>
          <button id="agentSend" type="button">Send</button>
        </div>
      </section>
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
const agentBody = document.getElementById("agentBody");
const agentToggle = document.getElementById("agentToggle");
const agentSelect = document.getElementById("agentSelect");
const agentStatus = document.getElementById("agentStatus");
const agentOutput = document.getElementById("agentOutput");
const agentInput = document.getElementById("agentInput");
let agentOutputText = "";
let agentTerminal = undefined;
let agentHasUnreadOutput = false;
function t(key, fallback) { return labels[key] || fallback; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function rowValue(row) { return lineState.edits?.[row.line] ?? row.translation ?? ""; }
function setStatus(text) { statusEl.textContent = text; }
function setAgentStatus(text) { agentStatus.textContent = text || ""; }
function setControlsExpanded(expanded) {
  headerDrawer.hidden = !expanded;
  controlsToggle.textContent = expanded ? "⌃" : "⌄";
  controlsToggle.title = expanded ? t("controlsClose", "Hide tools") : t("controlsOpen", "Show tools");
  controlsToggle.setAttribute("aria-expanded", String(expanded));
}
function isAgentExpanded() { return !agentPanel.classList.contains("collapsed"); }
function setAgentExpanded(expanded) {
  agentPanel.classList.toggle("collapsed", !expanded);
  agentBody.hidden = !expanded;
  agentToggle.textContent = expanded ? t("agentClose", "Collapse") : t("agentOpen", "Open");
  if (expanded) {
    agentHasUnreadOutput = false;
    setTimeout(() => {
      ensureAgentTerminal();
      renderAgentOutput();
    }, 20);
  }
}
function ensureAgentTerminal() {
  if (!isAgentExpanded()) return undefined;
  if (agentTerminal) return agentTerminal;
  const TerminalCtor = window.Terminal?.Terminal || window.Terminal;
  if (!TerminalCtor) {
    agentOutput.textContent = agentOutputText;
    return undefined;
  }
  agentOutput.textContent = "";
  agentTerminal = new TerminalCtor({
    cursorBlink: false,
    convertEol: false,
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: { background: "#071523", foreground: "#dbeafe", cursor: "#ffffff", selectionBackground: "#355c7d" }
  });
  agentTerminal.open(agentOutput);
  resizeAgentTerminal();
  return agentTerminal;
}
function resizeAgentTerminal() {
  if (!agentTerminal || !agentOutput) return;
  const width = Math.max(0, agentOutput.clientWidth - 8);
  const height = Math.max(0, agentOutput.clientHeight - 8);
  if (!width || !height) return;
  const cols = Math.max(96, Math.min(160, Math.floor(width / 7.2)));
  const rows = Math.max(24, Math.min(40, Math.floor(height / 14.4)));
  try { agentTerminal.resize(cols, rows); } catch {}
}
function isAgentTerminalNearBottom() {
  const buffer = agentTerminal?.buffer?.active;
  if (buffer && agentTerminal?.rows) {
    return buffer.baseY - buffer.viewportY <= agentTerminal.rows + 2;
  }
  return agentOutput.scrollHeight - agentOutput.scrollTop - agentOutput.clientHeight < 48;
}
function scrollAgentTerminalToBottom(force = false) {
  if (!force && !isAgentTerminalNearBottom()) return;
  if (agentTerminal?.scrollToBottom) {
    try { agentTerminal.scrollToBottom(); return; } catch {}
  }
  agentOutput.scrollTop = agentOutput.scrollHeight;
}
function renderAgentOutput() {
  if (!isAgentExpanded()) return;
  const terminal = ensureAgentTerminal();
  if (terminal) {
    resizeAgentTerminal();
    terminal.reset?.();
    if (agentOutputText) terminal.write(agentOutputText);
    scrollAgentTerminalToBottom(true);
  } else {
    agentOutput.textContent = agentOutputText;
    agentOutput.scrollTop = agentOutput.scrollHeight;
  }
}
function appendAgentOutput(text) {
  agentOutputText = (agentOutputText + String(text || "")).slice(-120000);
  if (!isAgentExpanded()) {
    agentHasUnreadOutput = true;
    setAgentStatus(t("agentOutputReady", "Agent has output"));
    return;
  }
  const terminal = ensureAgentTerminal();
  if (terminal) {
    resizeAgentTerminal();
    const shouldFollow = isAgentTerminalNearBottom();
    terminal.write(String(text || ""));
    scrollAgentTerminalToBottom(shouldFollow);
  } else {
    agentOutput.textContent = agentOutputText;
    agentOutput.scrollTop = agentOutput.scrollHeight;
  }
}
function applyAuthLabels() {
  document.getElementById("pinTitle").textContent = t("pinTitle", "Enter PIN");
  document.getElementById("pinHelp").textContent = t("pinHelp", "Use the fixed 6-digit PIN shown in the desktop app.");
  document.getElementById("pinInput").placeholder = t("pinPlaceholder", "6-digit PIN");
  document.getElementById("unlockButton").textContent = t("unlock", "Unlock");
}
function authed(path) { return path + (path.includes("?") ? "&" : "?") + "auth=" + encodeURIComponent(authToken); }
async function postAgent(path, body = {}) {
  const result = await fetch(authed(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok || payload.ok === false) throw new Error(payload.message || result.statusText);
  return payload;
}
async function refreshAgentStatus() {
  const snapshot = await fetch(authed("/api/agent/status/" + encodeURIComponent(token))).then(res => res.json());
  if (snapshot?.output && snapshot.output !== agentOutputText) {
    agentOutputText = snapshot.output;
    if (isAgentExpanded()) renderAgentOutput();
    else if (agentOutputText) {
      agentHasUnreadOutput = true;
      setAgentStatus(t("agentOutputReady", "Agent has output"));
    }
  }
  if (snapshot?.agent) agentSelect.value = snapshot.agent;
  setAgentStatus(snapshot?.running ? (agentHasUnreadOutput ? t("agentOutputReady", "Agent has output") : t("agentStarted", "Agent started")) : "");
}
async function startAgent() {
  try {
    const payload = await postAgent("/api/agent/start/" + encodeURIComponent(token), {
      agent: agentSelect.value,
      cols: Math.max(96, agentTerminal?.cols || 120),
      rows: Math.max(24, agentTerminal?.rows || 32)
    });
    setAgentStatus(payload.message || t("agentStarted", "Agent started"));
    if (payload.status?.output) {
      agentOutputText = payload.status.output;
      renderAgentOutput();
    }
    return true;
  } catch (error) {
    setAgentStatus(error?.message || String(error));
    return false;
  }
}
async function sendAgentInput() {
  const text = agentInput.value;
  if (!text.trim()) return;
  try {
    if (!await startAgent()) return;
    agentInput.value = "";
    const payload = await postAgent("/api/agent/input/" + encodeURIComponent(token), { text });
    setAgentStatus(payload.promptPath ? payload.promptPath : t("saved", "Synced"));
  } catch (error) {
    agentInput.value = text;
    setAgentStatus(error?.message || String(error));
  }
}
async function stopAgent() {
  try {
    await postAgent("/api/agent/stop/" + encodeURIComponent(token), {});
    setAgentStatus(t("agentStopped", "Agent stopped"));
  } catch (error) {
    setAgentStatus(error?.message || String(error));
  }
}
function setTab(kind) {
  activeKind = kind;
  searchInput.value = searchByKind[activeKind] || "";
  document.getElementById("lineTab").classList.toggle("active", kind === "line");
  document.getElementById("proposalTab").classList.toggle("active", kind === "proposal");
  render();
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
  if (activeKind === "proposal") renderProposal();
  else renderLine();
}
async function postPatch(patch) {
  await fetch(authed("/api/patch/" + encodeURIComponent(token)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...patch, clientId, timestamp: new Date().toISOString() })
  });
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
  } else {
    lineState.edits[line] = String(patch.text ?? "");
    lineState.status[line] = patch.status || "manual";
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
  setControlsExpanded(false);
  document.getElementById("agentTitle").textContent = t("agentConsole", "Agent Console");
  document.getElementById("agentStart").textContent = t("agentStart", "Start Agent");
  document.getElementById("agentStop").textContent = t("agentStop", "Stop");
  document.getElementById("agentSend").textContent = t("agentSend", "Send");
  document.getElementById("agentInput").placeholder = t("agentInput", "Prompt / message");
  agentSelect.value = session.agent || "codex";
  document.getElementById("lineTab").hidden = lineRows.length === 0;
  document.getElementById("proposalTab").hidden = proposalItems.length === 0;
  activeKind = proposalItems.length > 0 && lineRows.length === 0 ? "proposal" : "line";
  document.getElementById("gate").hidden = true;
  document.getElementById("app").hidden = false;
  setAgentExpanded(false);
  setTab(activeKind);
  render();
  await refreshAgentStatus().catch(() => {});
  const events = new EventSource(authed("/events/" + encodeURIComponent(token)));
  events.addEventListener("patch", event => applyPatch(JSON.parse(event.data).patch));
  events.addEventListener("agent-console", event => appendAgentOutput(JSON.parse(event.data).data || ""));
  events.addEventListener("agent-exit", event => setAgentStatus(t("agentStopped", "Agent stopped") + ": " + (JSON.parse(event.data).exitCode ?? "")));
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
controlsToggle.onclick = () => setControlsExpanded(headerDrawer.hidden);
document.getElementById("agentStart").onclick = () => { void startAgent(); };
document.getElementById("agentStop").onclick = () => { void stopAgent(); };
document.getElementById("agentSend").onclick = () => { void sendAgentInput(); };
agentToggle.onclick = () => setAgentExpanded(agentPanel.classList.contains("collapsed"));
agentInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendAgentInput();
  }
});
window.addEventListener("resize", () => {
  if (!isAgentExpanded()) return;
  resizeAgentTerminal();
  scrollAgentTerminalToBottom();
});
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
</body>
</html>`;
}

function lanSyncUrls(token: string): { localUrl: string; lanUrls: string[] } {
  const pathPart = `/s/${encodeURIComponent(token)}`;
  const localUrl = `http://127.0.0.1:${lanSyncPort}${pathPart}`;
  const lanUrls: string[] = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        lanUrls.push(`http://${item.address}:${lanSyncPort}${pathPart}`);
      }
    }
  }
  return { localUrl, lanUrls: [...new Set(lanUrls)] };
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
        lanSyncResponse(res, 200, lanSyncLandingHtml(), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && route === "assets" && parts[2] === "xterm") {
        const filename = path.basename(parts[3] || "");
        if (!["xterm.css", "xterm.js", "addon-fit.js"].includes(filename)) {
          lanSyncResponse(res, 404, "Not found.", "text/plain; charset=utf-8");
          return;
        }
        const assetPath = path.join(app.getAppPath(), "assets", "vendor", "xterm", filename);
        const contentType = filename.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
        lanSyncResponse(res, 200, await readFile(assetPath, "utf8"), contentType);
        return;
      }
      const token = route === "api" && parts[2] === "agent" ? parts[4] : route === "api" ? parts[3] : parts[2];
      const session = token ? lanSyncSessions.get(decodeURIComponent(token)) : undefined;
      if (!session) {
        if (req.method === "GET" && (route === "s" || route === "")) {
          lanSyncResponse(res, 404, lanSyncSessionNotFoundHtml(url.pathname), "text/html; charset=utf-8");
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
      if (req.method === "GET" && route === "api" && parts[2] === "agent" && parts[3] === "status") {
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        lanSyncResponse(res, 200, lanSyncJson(interactiveConsoleSnapshot()), "application/json; charset=utf-8");
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
          "Access-Control-Allow-Origin": "*"
        });
        session.clients.add(res);
        res.write(`event: hello\ndata: ${lanSyncJson({ ok: true })}\n\n`);
        req.on("close", () => session.clients.delete(res));
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
          clientId: typeof body.clientId === "string" ? body.clientId : "remote",
          timestamp: typeof body.timestamp === "string" ? body.timestamp : new Date().toISOString()
        };
        applyLanSyncPatchToSession(session, patch);
        await persistLanSyncLinePatch(session, patch);
        sendLanSyncPatchToOwner(session, patch);
        broadcastLanSyncPatch(session, patch);
        lanSyncResponse(res, 200, lanSyncJson({ ok: true }), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST" && route === "api" && parts[2] === "agent" && parts[3] === "start") {
        const body = await readLanSyncBody(req) as { authToken?: unknown; agent?: unknown; cols?: unknown; rows?: unknown };
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url, body))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        if (!session.outputDir) {
          lanSyncResponse(res, 400, lanSyncJson({ ok: false, message: lanSyncLabels(session.locale).agentNeedsOutput }), "application/json; charset=utf-8");
          return;
        }
        const result = await startInteractiveAgentConsole({
          agent: body.agent === "claude" ? "claude" : session.agent,
          outputDir: session.outputDir,
          cols: Number(body.cols || 100),
          rows: Number(body.rows || 28)
        });
        lanSyncResponse(res, result.ok ? 200 : 500, lanSyncJson(result), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST" && route === "api" && parts[2] === "agent" && parts[3] === "input") {
        const body = await readLanSyncBody(req) as { authToken?: unknown; text?: unknown };
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url, body))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        if (!interactiveAgentSession) {
          lanSyncResponse(res, 400, lanSyncJson({ ok: false, message: "No interactive Agent Console is running." }), "application/json; charset=utf-8");
          return;
        }
        const result = await submitInteractiveAgentInput(interactiveAgentSession, typeof body.text === "string" ? body.text : "");
        lanSyncResponse(res, result.ok ? 200 : 500, lanSyncJson(result), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST" && route === "api" && parts[2] === "agent" && parts[3] === "stop") {
        const body = await readLanSyncBody(req) as { authToken?: unknown };
        if (!isLanSyncAuthorized(session, lanSyncAuthTokenFrom(url, body))) {
          lanSyncResponse(res, 401, lanSyncJson({ ok: false }), "application/json; charset=utf-8");
          return;
        }
        if (interactiveAgentSession) {
          const running = interactiveAgentSession;
          interactiveAgentSession = undefined;
          running.pty.kill();
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

async function isLineReviewHtml(targetPath: string | undefined): Promise<boolean> {
  if (!targetPath) {
    return false;
  }
  try {
    const html = await readFile(targetPath, "utf8");
    return html.includes("line-review") && html.includes('id="reviewData"');
  } catch {
    return false;
  }
}

async function findLatestLineReviewHtml(htmlDir: string): Promise<string> {
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
      if (!entry.isFile() || !/^line-review.*\.html$/i.test(entry.name)) {
        return;
      }
      if (!(await isLineReviewHtml(fullPath))) {
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

async function findLinkedLineReviewHtml(outputDir: string, explicitPath?: string): Promise<string | undefined> {
  const { workspaceDir } = normalizeProjectFolder(outputDir);
  const state = await readJsonObject(path.join(workspaceDir, "state.json"));
  const project = await readJsonObject(path.join(workspaceDir, "project.json"));
  const latestLineReview = await findLatestLineReviewHtml(path.join(workspaceDir, "html"));
  const candidates = [
    explicitPath,
    typeof state?.lastHtml === "string" ? state.lastHtml : undefined,
    typeof project?.lineReviewPath === "string" ? project.lineReviewPath : undefined,
    typeof project?.lastLineReviewHtml === "string" ? project.lastLineReviewHtml : undefined,
    latestLineReview
  ];
  for (const candidate of candidates) {
    if (await isLineReviewHtml(candidate)) {
      return candidate;
    }
  }
  return undefined;
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
  if (!filePath || !(await isLineReviewHtml(filePath))) {
    return undefined;
  }
  return workspaceDir && !isSameOrInside(workspaceDir, filePath) ? undefined : filePath;
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

async function repairProposalReviewHtmlLineReviewPath(targetPath: string, outputDir?: string): Promise<void> {
  const filePath = filePathFromPathLike(targetPath);
  if (!filePath) {
    return;
  }
  let html = "";
  try {
    html = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  const links = embeddedProposalLinks(html);
  if (!links) {
    return;
  }
  const lineReviewPath = await findLineReviewForProposalHtml(filePath, links, outputDir);
  if (!lineReviewPath || sameFilePath(filePathFromPathLike(links.lineReviewPath), lineReviewPath)) {
    return;
  }
  const rewritten = rewriteProposalReviewLineReviewPathContent(html, path.basename(filePath), lineReviewPath);
  if (rewritten) {
    await writeFile(filePath, rewritten, "utf8");
  }
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
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
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
      "This file looks like a proofreading / fix proposal report, but its finding blocks do not match the structured fix_proposal format required by the proofread-translation skill, so translation-workshop cannot parse it.",
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
    "该文件看起来像 proofreading / fix proposal 报告，但问题条目的 block 格式与 proofread-translation skill 要求的结构化 fix_proposal 格式不符，translation-workshop 无法解析。",
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

function safeExtractedTextBaseName(filePath: string): string {
  const baseName = path.basename(filePath).replace(/\.[^.]+$/, "") || "document";
  return baseName.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "document";
}

async function writeExtractedPromptText(
  workspaceDir: string,
  filePath: string,
  role: "source" | "translation",
  text: string
): Promise<string> {
  const digest = createHash("sha1").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 10);
  const extractedDir = path.join(workspaceDir, "extracted-text", digest, role);
  await mkdir(extractedDir, { recursive: true });
  const extractedPath = path.join(extractedDir, `${safeExtractedTextBaseName(filePath)}.txt`);
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
    return parseGlossaryText(await readFile(glossaryPath, "utf8"));
  } catch {
    return [];
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

function resolveCliCandidates(command: string): string[] {
  if (process.platform !== "win32") {
    const candidate = resolveCliFromPath(command, {
      platform: process.platform,
      pathEnv: process.env.PATH,
      pathext: process.env.PATHEXT,
      pathJoin: path.join,
      exists: existsSync
    });
    return candidate ? [candidate] : [];
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  const names = executableNames(command, process.platform, process.env.PATHEXT);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const key = candidate.toLowerCase();
      if (!seen.has(key) && existsSync(candidate)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function commandVersionScore(candidate: string): number {
  try {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = text.match(/(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?/);
    if (!match) {
      return -1;
    }
    const [, major, minor, patch, suffix] = match;
    const prereleasePenalty = suffix ? 0 : 500;
    return Number(major) * 1_000_000_000 + Number(minor) * 1_000_000 + Number(patch) * 1_000 + prereleasePenalty;
  } catch {
    return -1;
  }
}

function resolveCliCommand(command: string): string {
  if (command === "codex") {
    const candidates = resolveCliCandidates(command);
    if (candidates.length > 0) {
      return candidates
        .map((candidate, index) => ({ candidate, index, score: commandVersionScore(candidate) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)[0].candidate;
    }
  }
  const candidate = resolveCliFromPath(command, {
    platform: process.platform,
    pathEnv: process.env.PATH,
    pathext: process.env.PATHEXT,
    pathJoin: path.join,
    exists: existsSync
  });
  if (!candidate) {
    throw new Error(`${command} CLI was not found in PATH.`);
  }
  return candidate;
}

async function resolveAgentCli(agent: "codex" | "claude"): Promise<string> {
  return resolveCliCommand(agent === "codex" ? "codex" : "claude");
}

function normalizeSkillInstallAgent(value: unknown): SkillInstallAgent {
  return value === "codex" || value === "claude" || value === "all" ? value : "all";
}

function isSkillInstallRoot(candidate: string): boolean {
  return existsSync(path.join(candidate, "scripts", "install-skills.mjs")) && existsSync(path.join(candidate, "skills"));
}

function localPackageRoot(): string {
  const candidates = [
    ...(app.isPackaged ? [path.join(process.resourcesPath, "app.asar.unpacked")] : []),
    app.getAppPath(),
    process.cwd()
  ];
  for (const candidate of candidates) {
    if (isSkillInstallRoot(candidate)) {
      return candidate;
    }
  }
  return app.getAppPath();
}

function localSkillInstallDetails(agent: SkillInstallAgent): { repoRoot: string; command: string; githubCommand: string; args: string[] } {
  const repoRoot = localPackageRoot();
  return {
    repoRoot,
    command: buildLocalSkillInstallCommand(repoRoot, agent),
    githubCommand: buildGithubSkillInstallCommand(agent, process.platform),
    args: buildLocalSkillInstallArgs(repoRoot, agent)
  };
}

function tryResolveCliCommand(command: string): string {
  try {
    return resolveCliCommand(command);
  } catch {
    return "";
  }
}

function userHomeDir(): string {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || "";
}

function globalSkillTargets(agent: "codex" | "claude", home: string): string[] {
  if (agent === "codex") {
    return [
      path.join(home, ".codex", "skills", "translate-text", "SKILL.md"),
      path.join(home, ".codex", "skills", "proofread-translation", "SKILL.md")
    ];
  }
  return [
    path.join(home, ".claude", "commands", "translate-text.md"),
    path.join(home, ".claude", "commands", "proofread-translation.md")
  ];
}

function checkAgentInstall(agent: "codex" | "claude", home: string): AgentInstallCheck {
  const targets = globalSkillTargets(agent, home);
  const installedSkillPaths = targets.filter((target) => existsSync(target));
  const missingSkillPaths = targets.filter((target) => !existsSync(target));
  const cliPath = tryResolveCliCommand(agent === "codex" ? "codex" : "claude");
  return {
    agent,
    cliFound: Boolean(cliPath),
    cliPath,
    skillsFound: missingSkillPaths.length === 0,
    installedSkillPaths,
    missingSkillPaths
  };
}

function localSkillInstallStatus(agent: SkillInstallAgent): SkillInstallStatus {
  const selectedAgent = agent === "claude" ? "claude" : "codex";
  const home = userHomeDir();
  const codex = checkAgentInstall("codex", home);
  const claude = checkAgentInstall("claude", home);
  return {
    selectedAgent,
    home,
    anyCliFound: codex.cliFound || claude.cliFound,
    selected: selectedAgent === "claude" ? claude : codex,
    agents: { codex, claude }
  };
}

function loadNodePty(): NodePtyModule {
  try {
    return require("node-pty") as NodePtyModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Interactive Agent Console requires node-pty. Run npm install and restart translation-workshop. ${detail}`);
  }
}

const TRANSLATION_SKILLS = new Set(["translate-text", "proofread-translation"]);

interface InteractiveAgentLaunch {
  args: string[];
  cleanupPaths: string[];
  env?: NodeJS.ProcessEnv;
}

function toTomlPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/"/g, "\\\"");
}

function skillNameFromSkillPath(skillPath: string): string {
  return path.basename(path.dirname(skillPath));
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverSkillMarkdownFiles(skillDirs: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const results: string[] = [];
  async function visit(dirPath: string, depth: number): Promise<void> {
    if (depth > 3 || !await directoryExists(dirPath)) {
      return;
    }
    const directSkillPath = path.join(dirPath, "SKILL.md");
    try {
      if ((await stat(directSkillPath)).isFile()) {
        const normalized = path.resolve(directSkillPath).toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          results.push(directSkillPath);
        }
        return;
      }
    } catch {
      // Not every directory is a skill directory.
    }
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillPath = path.join(dirPath, entry.name);
      try {
        await visit(skillPath, depth + 1);
      } catch {
        // Ignore unreadable skill candidates.
      }
    }
  }
  for (const skillDir of skillDirs) {
    await visit(skillDir, 0);
  }
  return results;
}

async function discoverClaudeSkillNames(skillDirs: string[], commandDirs: string[]): Promise<string[]> {
  const names = new Set<string>(TRANSLATION_SKILLS);
  for (const skillPath of await discoverSkillMarkdownFiles(skillDirs)) {
    names.add(skillNameFromSkillPath(skillPath));
  }
  for (const commandDir of commandDirs) {
    if (!await directoryExists(commandDir)) {
      continue;
    }
    const entries = await readdir(commandDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        names.add(path.basename(entry.name, path.extname(entry.name)));
      }
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function workspaceAncestor(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, "package.json")) || existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function prepareClaudeTranslationLaunch(outputDir: string): Promise<InteractiveAgentLaunch> {
  const home = os.homedir();
  const skillNames = await discoverClaudeSkillNames(
    [
      path.join(outputDir, ".claude", "skills"),
      path.join(home, ".claude", "skills")
    ],
    [
      path.join(outputDir, ".claude", "commands"),
      path.join(home, ".claude", "commands")
    ]
  );
  const skillOverrides: Record<string, "on" | "user-invocable-only"> = {};
  for (const name of skillNames) {
    skillOverrides[name] = TRANSLATION_SKILLS.has(name) ? "on" : "user-invocable-only";
  }
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), "translation-workshop-claude-"));
  const settingsPath = path.join(settingsDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ skillOverrides }, null, 2), "utf8");
  return {
    args: ["--settings", settingsPath, "--add-dir", outputDir, "--permission-mode", "acceptEdits"],
    cleanupPaths: [settingsDir]
  };
}

async function prepareCodexTranslationLaunch(outputDir: string): Promise<InteractiveAgentLaunch> {
  const home = os.homedir();
  const repoRoot = workspaceAncestor(outputDir);
  const skillPaths = await discoverSkillMarkdownFiles([
    ...(repoRoot ? [path.join(repoRoot, ".agents", "skills")] : []),
    path.join(outputDir, ".agents", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills")
  ]);
  const disabledSkillPaths = skillPaths.filter((skillPath) => !TRANSLATION_SKILLS.has(skillNameFromSkillPath(skillPath)));
  const profileName = `translation-workshop-${process.pid}-${Date.now()}`;
  const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : path.join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  const profilePath = path.join(codexHome, `${profileName}.config.toml`);
  const profile = [
    "# Generated by translation-workshop for this Agent session.",
    "# Codex has no user-invocable-only equivalent, so non-translation skills are disabled by SKILL.md path.",
    ...disabledSkillPaths.flatMap((skillPath) => [
      "",
      "[[skills.config]]",
      `path = "${toTomlPath(skillPath)}"`,
      "enabled = false"
    ])
  ].join("\n");
  await writeFile(profilePath, profile, "utf8");
  return {
    args: ["--profile", profileName, "-c", "check_for_update_on_startup=false", "--cd", outputDir],
    cleanupPaths: [profilePath],
    env: { CODEX_HOME: codexHome }
  };
}

async function cleanupAgentLaunchFiles(paths: string[] | undefined): Promise<void> {
  for (const itemPath of paths ?? []) {
    try {
      await rm(itemPath, { recursive: true, force: true });
    } catch {
      // Temporary launcher files should never block Agent shutdown.
    }
  }
}

async function interactiveAgentLaunch(agent: "codex" | "claude", outputDir: string): Promise<InteractiveAgentLaunch> {
  return agent === "claude"
    ? prepareClaudeTranslationLaunch(outputDir)
    : prepareCodexTranslationLaunch(outputDir);
}

function dismissCodexUpdatePrompt(session: InteractiveAgentSession, output: string): void {
  if (session.agent !== "codex" || session.dismissedUpdatePrompt) {
    return;
  }
  if (/Update available/i.test(output) && /Skip/i.test(output)) {
    session.dismissedUpdatePrompt = true;
    session.pty.write("2\r");
  }
}

function dismissCodexTrustPrompt(session: InteractiveAgentSession, output: string): void {
  if (session.agent !== "codex" || session.dismissedTrustPrompt) {
    return;
  }
  if (/Do you trust the contents of this directory/i.test(output) && /Yes,\s*continue/i.test(output)) {
    session.dismissedTrustPrompt = true;
    session.pty.write("1\r");
  }
}

function compactConsoleText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function dismissClaudeMemoryPermissionPrompt(session: InteractiveAgentSession, output: string): void {
  if (session.agent !== "claude") {
    return;
  }
  const compact = compactConsoleText(output);
  if (!compact.includes(".claude") || !compact.includes("memory") || !compact.includes("doyouwanttoproceed")) {
    return;
  }
  const signature = compact.slice(-900);
  if (session.lastDeniedClaudeMemoryPrompt === signature) {
    return;
  }
  session.lastDeniedClaudeMemoryPrompt = signature;
  session.pty.write(compact.includes("3.no") ? "3\r" : "2\r");
}

function broadcastAgentConsoleEvent(channel: "agent-console:data" | "agent-console:exit", payload: unknown): void {
  const sent = new Set<number>();
  for (const window of BrowserWindow.getAllWindows()) {
    const webContents = window.webContents;
    if (!webContents.isDestroyed()) {
      sent.add(webContents.id);
      webContents.send(channel, payload);
    }
  }
  for (const tab of htmlViewerTabs.values()) {
    const webContents = tab.view.webContents;
    if (!webContents.isDestroyed() && !sent.has(webContents.id)) {
      webContents.send(channel, payload);
    }
  }
  const eventName = channel === "agent-console:data" ? "agent-console" : "agent-exit";
  for (const session of lanSyncSessions.values()) {
    const data = `event: ${eventName}\ndata: ${lanSyncJson(payload)}\n\n`;
    for (const client of [...session.clients]) {
      if (client.destroyed) {
        session.clients.delete(client);
        continue;
      }
      client.write(data);
    }
  }
}

function interactiveConsoleSnapshot() {
  return interactiveAgentSession
    ? {
        running: true,
        id: interactiveAgentSession.id,
        agent: interactiveAgentSession.agent,
        outputDir: interactiveAgentSession.outputDir,
        startedAt: interactiveAgentSession.startedAt,
        output: interactiveAgentSession.outputBuffer
      }
    : { running: false };
}

function toAgentRelativePath(outputDir: string, filePath: string): string {
  return path.relative(outputDir, filePath).split(path.sep).join("/");
}

async function spoolAgentPrompt(session: InteractiveAgentSession, text: string): Promise<{ text: string; promptPath: string }> {
  const workspaceDir = await ensureWorkspace(session.outputDir);
  const promptDir = path.join(workspaceDir, "agent-prompts");
  await mkdir(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `agent-prompt-${timestamp()}.md`);
  await writeFile(promptPath, text, "utf8");
  const relativePath = toAgentRelativePath(session.outputDir, promptPath);
  return {
    promptPath,
    text: buildAgentPromptFileMessage(relativePath, promptPath, text)
  };
}

async function submitInteractiveAgentInput(session: InteractiveAgentSession, text: string): Promise<AgentConsoleInputResult> {
  const prepared = shouldSendAgentPromptViaFile(text)
    ? await spoolAgentPrompt(session, text)
    : { text, promptPath: undefined };
  session.pty.write(formatInteractiveAgentMessage(session.agent, prepared.text));
  setTimeout(() => {
    session.pty.write("\r");
  }, session.agent === "codex" ? 80 : 120);
  return {
    ok: true,
    promptPath: prepared.promptPath,
    message: prepared.promptPath
      ? `Prompt saved to file; skill invocation was sent with a details reference: ${prepared.promptPath}`
      : undefined
  };
}

async function startInteractiveAgentConsole(args: AgentConsoleStartArgs): Promise<{ ok: boolean; message?: string; status?: ReturnType<typeof interactiveConsoleSnapshot> }> {
  const agent = args.agent === "claude" ? "claude" : "codex";
  const outputDir = args.outputDir?.trim();
  if (!outputDir || !path.isAbsolute(outputDir)) {
    return { ok: false, message: "An absolute output folder is required for the interactive Agent Console." };
  }
  if (interactiveAgentSession) {
    return { ok: true, message: `${interactiveAgentSession.agent} console is already running.`, status: interactiveConsoleSnapshot() };
  }
  try {
    await ensureWorkspace(outputDir);
    const [pty, cliPath] = await Promise.all([Promise.resolve(loadNodePty()), resolveAgentCli(agent)]);
    const launch = await interactiveAgentLaunch(agent, outputDir);
    const cols = Math.max(40, Math.min(240, Math.floor(args.cols || 120)));
    const rows = Math.max(10, Math.min(80, Math.floor(args.rows || 32)));
    let ptyProcess: PtyProcess;
    try {
      ptyProcess = pty.spawn(cliPath, launch.args, {
        cwd: outputDir,
        cols,
        rows,
        name: "xterm-color",
        env: { ...process.env, ...launch.env, TERM: "xterm-256color" }
      });
    } catch (error) {
      await cleanupAgentLaunchFiles(launch.cleanupPaths);
      throw error;
    }
    const session: InteractiveAgentSession = {
      id: `agent-console-${Date.now()}`,
      agent,
      outputDir,
      startedAt: new Date().toISOString(),
      pty: ptyProcess,
      outputBuffer: "",
      cleanupPaths: launch.cleanupPaths
    };
    interactiveAgentSession = session;
    ptyProcess.onData((data) => {
      session.outputBuffer = `${session.outputBuffer}${data}`.slice(-120000);
      session.recentOutput = `${session.recentOutput ?? ""}${data}`.slice(-4000);
      dismissCodexUpdatePrompt(session, session.recentOutput);
      dismissCodexTrustPrompt(session, session.recentOutput);
      dismissClaudeMemoryPermissionPrompt(session, session.recentOutput);
      broadcastAgentConsoleEvent("agent-console:data", { id: session.id, data });
    });
    ptyProcess.onExit((exit) => {
      if (interactiveAgentSession?.id === session.id) {
        interactiveAgentSession = undefined;
      }
      void cleanupAgentLaunchFiles(session.cleanupPaths);
      broadcastAgentConsoleEvent("agent-console:exit", { id: session.id, exitCode: exit.exitCode, signal: exit.signal });
    });
    return { ok: true, message: `Started interactive ${agent} console.`, status: interactiveConsoleSnapshot() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function collectLineFiles(folderPath: string, fileType: GenerateLineHtmlArgs["fileType"], workspaceDir: string): Promise<FolderLineFile[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const allowed = fileType === "epub" ? /\.epub$/i : fileType === "txt" ? /\.txt$/i : /\.(txt|epub)$/i;
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && allowed.test(entry.name))
      .map(async (entry) => {
        const fullPath = path.join(folderPath, entry.name);
        const text = await readLineDocument(fullPath, fileType, workspaceDir);
        return { name: entry.name, path: fullPath, lineCount: splitLines(text).length };
      })
  );
  return files.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

async function collectBilingualFiles(folderPath: string, fileType: GenerateLineHtmlArgs["fileType"]): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const allowed = fileType === "epub" ? /\.epub$/i : fileType === "txt" ? /\.txt$/i : /\.(txt|epub)$/i;
  return entries
    .filter((entry) => entry.isFile() && allowed.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(folderPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function preloadPath(): string {
  return path.join(app.getAppPath(), "dist", "main", "preload.cjs");
}

function appIconPath(): string {
  return path.join(app.getAppPath(), "assets", "app-icon.png");
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await win.loadURL("http://127.0.0.1:5173");
  } else {
    await win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  }
}

function splitHtmlOpenTarget(targetPath: string): { filePath: string; hash: string; key: string } {
  const htmlHashIndex = targetPath.toLowerCase().lastIndexOf(".html#");
  const rawFilePath = htmlHashIndex >= 0 ? targetPath.slice(0, htmlHashIndex + ".html".length) : targetPath;
  const hash = htmlHashIndex >= 0 ? targetPath.slice(htmlHashIndex + ".html#".length) : "";
  const filePath = path.resolve(rawFilePath);
  return { filePath, hash, key: filePath.toLowerCase() };
}

function isHtmlOpenTarget(targetPath: string): boolean {
  return /\.html(?:#|$)/i.test(targetPath);
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
  for (const tab of htmlViewerTabs.values()) {
    tab.view.setBounds(bounds);
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
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  htmlViewerWindow.on("resize", layoutHtmlViewerTabs);
  htmlViewerWindow.on("closed", () => {
    htmlViewerWindow = undefined;
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
  activeHtmlViewerTab = key;
  htmlViewerWindow.setBrowserView(tab.view);
  layoutHtmlViewerTabs();
  htmlViewerWindow.setTitle(tab.title);
  htmlViewerWindow.show();
  htmlViewerWindow.focus();
  updateHtmlViewerTabs();
  return true;
}

function closeHtmlViewerTab(key: string): boolean {
  const tab = htmlViewerTabs.get(key);
  if (!tab || !htmlViewerWindow || htmlViewerWindow.isDestroyed()) {
    return false;
  }
  const keys = Array.from(htmlViewerTabs.keys());
  const closedIndex = keys.indexOf(key);
  htmlViewerWindow.removeBrowserView(tab.view);
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

async function loadHtmlViewerTab(targetPath: string): Promise<{ filePath: string; hash: string; key: string; tab: { filePath: string; hash: string; title: string; view: BrowserView } }> {
  const { filePath, hash, key } = splitHtmlOpenTarget(targetPath);
  await upgradeLegacyReviewHtmlTree(filePath);
  await repairProposalReviewHtmlLineReviewPath(filePath);
  const win = await ensureHtmlViewerWindow();
  let tab = htmlViewerTabs.get(key);
  if (!tab) {
    const view = new BrowserView({
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    tab = { filePath, hash, title: path.basename(filePath), view };
    htmlViewerTabs.set(key, tab);
    view.webContents.on("page-title-updated", (_event, title) => {
      tab!.title = title || path.basename(filePath);
      updateHtmlViewerTabs();
    });
  } else {
    tab.hash = hash;
  }
  win.setBrowserView(tab.view);
  layoutHtmlViewerTabs();
  await tab.view.webContents.loadFile(filePath, { hash });
  return { filePath, hash, key, tab };
}

async function openHtmlWindow(targetPath: string): Promise<void> {
  const { key } = await loadHtmlViewerTab(targetPath);
  activateHtmlViewerTab(key);
}

async function applyLineReviewStateToView(args: ApplyLineReviewStateArgs): Promise<{ ok: boolean }> {
  if (!args.lineReviewPath) {
    throw new Error("Line review HTML path is required.");
  }
  const line = Number(args.line || 0);
  const targetPath = Number.isInteger(line) && line > 0
    ? `${args.lineReviewPath.replace(/#.*$/, "")}#line=${line}`
    : args.lineReviewPath;
  const { key, tab } = await loadHtmlViewerTab(targetPath);
  const stateJson = JSON.stringify(args.lineState ?? {});
  const lineJson = JSON.stringify(line);
  await tab.view.webContents.executeJavaScript(
    `(() => {
      const legacyKey = "translation-workshop:line:" + location.pathname;
      const primaryKey = typeof lineReviewStorageKey === "function" ? lineReviewStorageKey() : legacyKey;
      const storageKeys = [...new Set([primaryKey, legacyKey].filter(Boolean))];
      const existingState = JSON.parse(localStorage.getItem(primaryKey) || localStorage.getItem(legacyKey) || "{}") || {};
      const incomingState = ${stateJson};
      const mergedState = {
        ...existingState,
        ...incomingState,
        edits: { ...(existingState.edits || {}), ...(incomingState.edits || {}) },
        status: { ...(existingState.status || {}), ...(incomingState.status || {}) },
        auditIssues: { ...(existingState.auditIssues || {}), ...(incomingState.auditIssues || {}) },
        auditWhitelist: { ...(existingState.auditWhitelist || {}), ...(incomingState.auditWhitelist || {}) },
        theme: { ...(existingState.theme || {}), ...(incomingState.theme || {}) }
      };
      for (const storageKey of storageKeys) {
        localStorage.setItem(storageKey, JSON.stringify(mergedState));
      }
      if (typeof state === "object" && state) {
        Object.assign(state, mergedState);
        state.edits = mergedState.edits;
        state.status = mergedState.status;
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
        save();
      }
    })();`
  );
  if (args.activate !== false) {
    activateHtmlViewerTab(key);
  }
  return { ok: true };
}

async function upgradeLegacyReviewHtmlTree(targetPath: string): Promise<void> {
  await upgradeLegacyLineReviewHtml(targetPath);
  let html = "";
  try {
    html = await readFile(targetPath, "utf8");
  } catch {
    return;
  }
  const dataMatch = html.match(/<script id="batchData" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!dataMatch) {
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(dataMatch[1]);
  } catch {
    return;
  }
  const files = (data as { files?: Array<{ outputPath?: unknown }> })?.files;
  if (!Array.isArray(files)) {
    return;
  }
  await Promise.all(files.map(async (file) => {
    if (typeof file.outputPath !== "string" || !file.outputPath.toLowerCase().endsWith(".html")) {
      return;
    }
    await upgradeLegacyLineReviewHtml(path.resolve(path.dirname(targetPath), file.outputPath));
  }));
}

async function upgradeLegacyLineReviewHtml(targetPath: string): Promise<void> {
  let html = "";
  try {
    html = await readFile(targetPath, "utf8");
  } catch {
    return;
  }
  const fallbackTitle = path.basename(targetPath);
  const upgraded = upgradeLegacyLineReviewHtmlContent(html, fallbackTitle)
    ?? upgradeLegacyProposalReviewHtmlContent(html, fallbackTitle);
  if (upgraded) {
    await writeFile(targetPath, upgraded, "utf8");
  }
}

function promptBuildPath(value: unknown, label: string): string {
  return typeof value === "string" && value.trim() ? value : `[${label}]`;
}

function normalizePromptBuildArgs(args: unknown): PromptBuildOptions {
  const value = args && typeof args === "object" ? args as PromptBuildArgs : {};
  const kind = value.kind === "proofread" ? "proofread" : "translate";
  const agent = value.agent === "claude" ? "claude" : "codex";
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
    agent,
    sourcePath,
    translationPath,
    outputDir,
    glossaryPath,
    inputMode: value.inputMode === "bilingual" ? "bilingual" : "separate",
    advanced
  };
}

ipcMain.handle("dialog:openFile", async (_event, filters?: Electron.FileFilter[]) => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("dialog:openFileOrFolder", async (_event, filters?: Electron.FileFilter[]) => {
  const result = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"], filters });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("project:load", async (_event, outputDir?: string) => {
  if (!outputDir) {
    return undefined;
  }
  const projectFolder = normalizeProjectFolder(outputDir);
  const workspaceDir = projectFolder.workspaceDir;
  const project = await readJsonObject(path.join(workspaceDir, "project.json"));
  const state = await readJsonObject(path.join(workspaceDir, "state.json"));
  const latestHtml = await findLatestHtml(path.join(workspaceDir, "html"));
  if (!project && !state && !latestHtml) {
    return undefined;
  }
  const lastHtml = typeof state?.lastHtml === "string"
    ? state.lastHtml
    : typeof project?.lastHtml === "string"
      ? project.lastHtml
      : typeof project?.lastOutput === "string"
        ? project.lastOutput
        : latestHtml;
  const lastOutput = typeof project?.lastOutput === "string" && project.lastOutput
    ? project.lastOutput
    : lastHtml;
  return {
    ...project,
    outputDir: projectFolder.outputDir,
    lastHtml,
    lastOutput,
    generatedAt: state?.generatedAt ?? project?.generatedAt
  };
});

ipcMain.handle("project:save", async (_event, outputDir: string, state: unknown) => {
  const workspaceDir = await ensureWorkspace(outputDir);
  await writeFile(path.join(workspaceDir, "project.json"), JSON.stringify(state, null, 2), "utf8");
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
      const indexFiles: BatchLineReviewIndexFile[] = [];
      for (const [index, file] of sourceFiles.entries()) {
        const parsed = await parseBilingualDocument(file.path, args.fileType, workspaceDir, sourcePosition, translationPosition);
        const childName = htmlSafeName(file.name, index);
        const childPath = path.join(batchDir, childName);
        const html = renderLineReviewHtml({
          title: `${file.name} bilingual line review`,
          sourceText: parsed.sourceText,
          translationText: parsed.translationText,
          pageSize: args.pageSize,
          startPage: args.startPage,
          locale: args.locale,
          workflow: {
            sourcePath: file.path,
            translationPath: file.path,
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
        locale: args.locale
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
    const html = renderLineReviewHtml({
      title,
      sourceText: parsed.sourceText,
      translationText: parsed.translationText,
      pageSize: args.pageSize,
      startPage: args.startPage,
      locale: args.locale,
      workflow: {
        sourcePath: args.sourcePath,
        translationPath: args.sourcePath,
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
    const outputPath = path.join(workspaceDir, "html", `line-review-bilingual-${timestamp()}.html`);
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
      args.translationPath ? collectLineFiles(args.translationPath, args.fileType, workspaceDir) : Promise.resolve([])
    ]);
    if (sourceFiles.length === 0) {
      throw new Error("No .txt or .epub files were found in the source folder.");
    }
    const matches = matchFolderFiles(sourceFiles, translationFiles);
    const indexFiles: BatchLineReviewIndexFile[] = [];
    for (const [index, match] of matches.entries()) {
      const sourceDocument = await readLineDocumentForWorkflow(match.sourcePath, args.fileType, workspaceDir, "source");
      const translationDocument = match.status === "matched" && match.translationPath
        ? await readLineDocumentForWorkflow(match.translationPath, args.fileType, workspaceDir, "translation")
        : undefined;
      const childName = htmlSafeName(match.sourceName, index);
      const childPath = path.join(batchDir, childName);
      const html = renderLineReviewHtml({
        title: `${match.sourceName} line review`,
        sourceText: sourceDocument.text,
        translationText: translationDocument?.text,
        pageSize: args.pageSize,
        startPage: args.startPage,
        locale: args.locale,
        workflow: {
          sourcePath: match.sourcePath,
          translationPath: match.status === "matched" ? match.translationPath : undefined,
          sourcePromptPath: sourceDocument.promptPath,
          translationPromptPath: translationDocument?.promptPath,
          outputDir: args.outputDir,
          glossaryPath: args.glossaryPath,
          glossaryEntries,
          inputMode: "separate",
          advanced: args.advanced,
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
      locale: args.locale
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
    ? await readLineDocumentForWorkflow(args.translationPath, args.fileType, workspaceDir, "translation")
    : undefined;
  const title = `${path.basename(args.sourcePath)} line review`;
  const html = renderLineReviewHtml({
    title,
    sourceText: sourceDocument.text,
    translationText: translationDocument?.text,
    pageSize: args.pageSize,
    startPage: args.startPage,
    locale: args.locale,
    workflow: {
      sourcePath: args.sourcePath,
      translationPath: args.translationPath,
      sourcePromptPath: sourceDocument.promptPath,
      translationPromptPath: translationDocument?.promptPath,
      outputDir: args.outputDir,
      glossaryPath: args.glossaryPath,
      glossaryEntries,
      inputMode,
      advanced: args.advanced,
      epubExport: args.sourcePath.toLowerCase().endsWith(".epub") ? { mode: "all" } : undefined
    }
  });
  const outputPath = path.join(workspaceDir, "html", `line-review-${timestamp()}.html`);
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
  const proposals = parseProofreadMarkdown(reportText);
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
  return { outputPath, proposalCount: proposals.length, reportPath, lineReviewPath };
});

ipcMain.handle("html:openReviewHtml", async (_event, args: OpenReviewHtmlArgs) => {
  if (!args.htmlPath) {
    throw new Error("Review HTML path is required.");
  }
  await repairProposalReviewHtmlLineReviewPath(args.htmlPath, args.outputDir);
  await openHtmlWindow(args.htmlPath);
  return { ok: true };
});

ipcMain.handle("html:applyLineReviewState", async (_event, args: ApplyLineReviewStateArgs) => {
  return applyLineReviewStateToView(args);
});

ipcMain.handle("lan-sync:start", async (event, args: LanSyncStartArgs) => {
  if (!isValidLanSyncPin(args?.pin)) {
    throw new Error(args?.locale === "en-US" ? "LAN sync PIN must be exactly 6 digits." : "局域网同步 PIN 必须是 6 位数字。");
  }
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
    ownerWebContentsId: event.sender.id,
    title: String(args.title || "translation-workshop"),
    pinHash: hashLanSyncPin(args.pin),
    authTokens: new Set(),
    outputDir,
    agent: args.agent === "claude" ? "claude" : "codex",
    documents: {
      line: lineDocument,
      proposal: proposalDocument
    },
    locale: args.locale === "en-US" ? "en-US" : "zh-CN",
    createdAt: new Date().toISOString(),
    clients: new Set()
  };
  lanSyncSessions.set(token, session);
  event.sender.once("destroyed", () => {
    for (const item of [...lanSyncSessions.values()]) {
      if (item.ownerWebContentsId === session.ownerWebContentsId) {
        stopLanSyncSession(item);
      }
    }
  });
  return {
    ok: true,
    token,
    ...lanSyncUrls(token),
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
  applyLanSyncPatchToSession(session, patch);
  broadcastLanSyncPatch(session, patch);
  return { ok: true };
});

ipcMain.handle("lan-sync:stop", async (event, token: string) => {
  const session = lanSyncSessions.get(String(token || ""));
  if (!session || session.ownerWebContentsId !== event.sender.id) {
    return { ok: false };
  }
  stopLanSyncSession(session);
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
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("files:writeTextFile", async (_event, args: WriteTextFileArgs) => {
  const targetPath = args.path;
  const text = args.text ?? "";
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error("A bound absolute translation path is required.");
  }
  if (!/\.txt$/i.test(targetPath)) {
    throw new Error("Only txt translation files can be overwritten.");
  }
  const backupPath = await backupFile(targetPath, args.outputDir);
  await writeFile(targetPath, text, "utf8");
  return { ok: true, path: targetPath, backupPath };
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

ipcMain.handle("files:writeGlossaryFile", async (_event, args: WriteGlossaryFileArgs) => {
  const targetPath = args.path;
  const text = args.text ?? "";
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error("A bound absolute glossary path is required.");
  }
  if (!/\.(txt|json|csv|tsv|md)$/i.test(targetPath)) {
    throw new Error("Glossary writes support txt/json/csv/tsv/md files.");
  }
  const backupPath = await backupFile(targetPath, args.outputDir);
  await writeFile(targetPath, text, "utf8");
  return { ok: true, path: targetPath, backupPath };
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
  const backupPath = await backupFile(targetPath, outputRoot);
  const uniqueLines = [...new Set((args.lines ?? []).filter((line) => Number.isInteger(line) && line > 0))].sort((a, b) => a - b);
  await writeFile(targetPath, JSON.stringify({
    version: 1,
    sourcePath: args.sourcePath ?? "",
    lines: uniqueLines,
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
  return { ok: true, path: targetPath, backupPath, lineCount: uniqueLines.length };
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
    await openHtmlWindow(targetPath);
    return "";
  }
  return shell.openPath(targetPath);
});

ipcMain.handle("skills:installCommand", async (_event, args: SkillInstallArgs) => {
  const agent = normalizeSkillInstallAgent(args?.agent);
  return localSkillInstallDetails(agent);
});

ipcMain.handle("skills:status", async (_event, args: SkillInstallArgs) => {
  const agent = normalizeSkillInstallAgent(args?.agent);
  return localSkillInstallStatus(agent);
});

ipcMain.handle("html-tabs:activate", async (_event, key: string) => {
  return activateHtmlViewerTab(key);
});

ipcMain.handle("html-tabs:close", async (_event, key: string) => {
  return closeHtmlViewerTab(key);
});

ipcMain.handle("agent-console:start", async (_event, args: AgentConsoleStartArgs) => {
  return startInteractiveAgentConsole(args);
});

ipcMain.handle("agent-console:input", async (_event, args: AgentConsoleInputArgs) => {
  if (!interactiveAgentSession) {
    return { ok: false, message: "No interactive Agent Console is running." };
  }
  return submitInteractiveAgentInput(interactiveAgentSession, args.data ?? "");
});

ipcMain.handle("agent-console:write", async (_event, args: AgentConsoleInputArgs) => {
  if (!interactiveAgentSession) {
    return { ok: false, message: "No interactive Agent Console is running." };
  }
  interactiveAgentSession.pty.write(args.data ?? "");
  return { ok: true };
});

ipcMain.handle("agent-console:clear", async () => {
  if (!interactiveAgentSession) {
    return { ok: true };
  }
  interactiveAgentSession.outputBuffer = "";
  interactiveAgentSession.recentOutput = "";
  return { ok: true };
});

ipcMain.handle("agent-console:resize", async (_event, args: AgentConsoleResizeArgs) => {
  if (!interactiveAgentSession) {
    return { ok: false, message: "No interactive Agent Console is running." };
  }
  const cols = Math.max(40, Math.min(240, Math.floor(args.cols || 120)));
  const rows = Math.max(10, Math.min(80, Math.floor(args.rows || 32)));
  interactiveAgentSession.pty.resize(cols, rows);
  return { ok: true };
});

ipcMain.handle("agent-console:stop", async () => {
  if (!interactiveAgentSession) {
    return { ok: true };
  }
  const session = interactiveAgentSession;
  interactiveAgentSession = undefined;
  session.pty.kill();
  return { ok: true };
});

ipcMain.handle("agent-console:status", async () => {
  return interactiveConsoleSnapshot();
});

app.whenReady().then(async () => {
  configureApplicationMenu();
  await createWindow();
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
