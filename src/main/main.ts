import { app, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { CODEX_DISABLE_SUPERPOWERS_CONFIG } from "../shared/core/agentInvoke.ts";
import { formatInteractiveAgentMessage } from "../shared/core/agentConsoleInput.ts";
import { buildTimestampedBackupPath } from "../shared/core/backups.ts";
import { buildAgentPromptFileMessage, shouldSendAgentPromptViaFile } from "../shared/core/agentPromptTransport.ts";
import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { resolveCliFromPath } from "../shared/core/cliResolver.ts";
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

interface OpenReviewHtmlArgs {
  htmlPath?: string;
  outputDir?: string;
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
}

interface ApplyLineReviewStateArgs {
  lineReviewPath?: string;
  lineState?: unknown;
  line?: number;
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

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: process.platform === "darwin" ? [{ role: "close" }] : [{ role: "quit" }]
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

function resolveCliCommand(command: string): string {
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

function interactiveAgentArgs(agent: "codex" | "claude", outputDir: string): string[] {
  if (agent === "codex") {
    return ["-c", "check_for_update_on_startup=false", "-c", CODEX_DISABLE_SUPERPOWERS_CONFIG, "--cd", outputDir];
  }
  return ["--add-dir", outputDir, "--permission-mode", "acceptEdits"];
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
  activateHtmlViewerTab(key);
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
    throw new Error("No replacement proposals were found in the Markdown report.");
  }
  const lineReviewPath = await findLinkedLineReviewHtml(args.outputDir, args.lineReviewPath);
  const html = renderProposalReviewHtml({
    title: path.basename(reportPath),
    proposals,
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
    const cols = Math.max(40, Math.min(240, Math.floor(args.cols || 120)));
    const rows = Math.max(10, Math.min(80, Math.floor(args.rows || 32)));
    const ptyProcess = pty.spawn(cliPath, interactiveAgentArgs(agent, outputDir), {
      cwd: outputDir,
      cols,
      rows,
      name: "xterm-color",
      env: { ...process.env, TERM: "xterm-256color" }
    });
    const session: InteractiveAgentSession = {
      id: `agent-console-${Date.now()}`,
      agent,
      outputDir,
      startedAt: new Date().toISOString(),
      pty: ptyProcess,
      outputBuffer: ""
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
      broadcastAgentConsoleEvent("agent-console:exit", { id: session.id, exitCode: exit.exitCode, signal: exit.signal });
    });
    return { ok: true, message: `Started interactive ${agent} console.`, status: interactiveConsoleSnapshot() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
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
