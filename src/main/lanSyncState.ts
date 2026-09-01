import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

import type { UiLocale } from "../shared/core/html.ts";

export interface LanSyncLineRow {
  line: number;
  source: string;
  translation?: string;
  status?: string;
}

export interface LanSyncPatch {
  type: "line-edit" | "line-restore" | "proposal-decision";
  line?: number;
  proposalId?: string;
  text?: string;
  status?: string;
  manualText?: string;
  overrideConflict?: boolean;
  conflictReason?: string;
  clientId?: string;
  timestamp?: string;
}

export interface LanSyncCommand {
  type: "open-agent-os";
  clientId?: string;
  timestamp?: string;
}

export interface LanSyncLineDocument {
  title?: string;
  rows: LanSyncLineRow[];
  state: Record<string, unknown>;
  pageSize?: number;
  lineReviewPath?: string;
}

export interface LanSyncProposalItem {
  id: string;
  line?: number;
  src?: string;
  current?: string;
  problemType?: string;
  problem?: string;
  suggestion?: string;
  status?: string;
}

export interface LanSyncProposalDocument {
  title?: string;
  proposals: LanSyncProposalItem[];
  state: Record<string, unknown>;
  pageSize?: number;
  reportPath?: string;
  lineReviewPath?: string;
  proposalReviewPath?: string;
}

export interface LanSyncStartArgs {
  title?: string;
  pin?: string;
  htmlPath?: string;
  outputDir?: string;
  rows?: LanSyncLineRow[];
  state?: Record<string, unknown>;
  lineReviewPath?: string;
  lineDocument?: Partial<LanSyncLineDocument>;
  proposalDocument?: Partial<LanSyncProposalDocument>;
  locale?: UiLocale;
  pageSize?: number;
}

export interface LanSyncSession {
  token: string;
  ownerWebContentsId: number;
  title: string;
  pinHash: string;
  authTokens: Set<string>;
  outputDir?: string;
  documents: {
    line?: LanSyncLineDocument;
    proposal?: LanSyncProposalDocument;
  };
  locale: UiLocale;
  createdAt: string;
  clients: Set<ServerResponse>;
}

export function recordLineStateRevision(
  state: Record<string, unknown>,
  line: number,
  text: string,
  status: string,
  source: string
): void {
  const key = String(line);
  const revisions = state.revisions && typeof state.revisions === "object"
    ? state.revisions as Record<string, unknown>
    : {};
  const revisionHistory = state.revisionHistory && typeof state.revisionHistory === "object"
    ? state.revisionHistory as Record<string, unknown>
    : {};
  state.revisions = revisions;
  state.revisionHistory = revisionHistory;
  const revision = Number(revisions[key] || 0) + 1;
  revisions[key] = revision;
  const history = Array.isArray(revisionHistory[key]) ? revisionHistory[key] as Array<Record<string, unknown>> : [];
  const entry = { revision, text, status, source };
  const last = history[history.length - 1];
  if (!last || last.text !== entry.text || last.status !== entry.status || last.source !== entry.source) history.push(entry);
  // ponytail: recent versions only; use a durable audit log if full history becomes product-critical.
  revisionHistory[key] = history.slice(-12);
}

export function normalizeLanSyncState(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeLanSyncRows(value: unknown): LanSyncLineRow[] {
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

export function normalizeLanSyncProposals(value: unknown): LanSyncProposalItem[] {
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

export function normalizeLanSyncLineDocument(args: LanSyncStartArgs): LanSyncLineDocument | undefined {
  const source = args.lineDocument && typeof args.lineDocument === "object" ? args.lineDocument : {};
  const rows = normalizeLanSyncRows(source.rows ?? args.rows);
  if (rows.length === 0) return undefined;
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

export function normalizeLinkedHtmlFilePath(value: string, basePath?: string): string {
  const raw = value.trim().replace(/#.*$/, "");
  if (!raw) return "";
  if (/^file:/i.test(raw)) {
    try {
      const pathname = decodeURIComponent(new URL(raw).pathname || "");
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return "";
    }
  }
  const normalized = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return normalized;
  if (path.isAbsolute(raw)) return raw;
  const baseDir = basePath && path.isAbsolute(basePath) ? path.dirname(basePath) : "";
  return baseDir ? path.resolve(baseDir, raw) : "";
}

function workspaceRootFromContainedPath(value?: string): string {
  if (!value) return "";
  const filePath = normalizeLinkedHtmlFilePath(value);
  if (!filePath || !path.isAbsolute(filePath)) return "";
  const normalized = path.normalize(filePath);
  const parts = normalized.split(path.sep);
  const index = parts.findIndex((part) => part.toLowerCase() === ".translation-workshop");
  if (index > 0) return parts.slice(0, index).join(path.sep) || path.parse(normalized).root;
  return path.dirname(normalized);
}

export function normalizeLanSyncOutputDir(
  args: LanSyncStartArgs,
  line?: LanSyncLineDocument,
  proposal?: LanSyncProposalDocument
): string | undefined {
  const direct = typeof args.outputDir === "string" ? args.outputDir.trim() : "";
  if (direct && path.isAbsolute(direct)) return direct;
  return [
    workspaceRootFromContainedPath(proposal?.reportPath),
    workspaceRootFromContainedPath(proposal?.lineReviewPath),
    workspaceRootFromContainedPath(line?.lineReviewPath),
    workspaceRootFromContainedPath(typeof args.htmlPath === "string" ? args.htmlPath : undefined)
  ].find((item) => item && path.isAbsolute(item)) || undefined;
}

export function parseLineReviewRowsFromHtmlContent(html: string): LanSyncLineRow[] {
  const match = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]) as { rows?: unknown };
    return normalizeLanSyncRows(parsed.rows);
  } catch {
    return [];
  }
}

async function readLineReviewRowsFromHtmlFile(filePath: string): Promise<LanSyncLineRow[]> {
  const opening = /<script id="reviewData" type="application\/json">/i;
  const closing = "</script>";
  const payloadChunks: string[] = [];
  let beforePayload = "";
  let payloadTail = "";
  let foundOpening = false;

  try {
    for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
      if (!foundOpening) {
        beforePayload += chunk;
        const match = opening.exec(beforePayload);
        if (!match) {
          beforePayload = beforePayload.slice(-opening.source.length);
          continue;
        }
        foundOpening = true;
        payloadTail = beforePayload.slice(match.index + match[0].length);
        beforePayload = "";
      } else {
        payloadTail += chunk;
      }

      const closingIndex = payloadTail.toLowerCase().indexOf(closing);
      if (closingIndex >= 0) {
        payloadChunks.push(payloadTail.slice(0, closingIndex));
        const parsed = JSON.parse(payloadChunks.join("")) as { rows?: unknown };
        return normalizeLanSyncRows(parsed.rows);
      }
      if (payloadTail.length > closing.length) {
        payloadChunks.push(payloadTail.slice(0, -closing.length));
        payloadTail = payloadTail.slice(-closing.length);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return [];
}

export async function hasLineReviewDataScript(filePath: string): Promise<boolean> {
  const opening = /<script\s+id=["']reviewData["']\s+type=["']application\/json["']>/i;
  let tail = "";
  try {
    for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
      tail += chunk;
      if (opening.test(tail)) return true;
      tail = tail.slice(-opening.source.length);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return false;
}

export async function readLinkedLineReviewDocument(
  lineReviewPath: string,
  basePath?: string,
  options: { includeRows?: boolean } = {}
): Promise<LanSyncLineDocument | undefined> {
  const filePath = normalizeLinkedHtmlFilePath(lineReviewPath, basePath);
  if (!filePath || !path.isAbsolute(filePath)) return undefined;
  if (options.includeRows === false) {
    try {
      await access(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return {
      title: path.basename(filePath),
      rows: [],
      state: {},
      pageSize: 1000,
      lineReviewPath: filePath
    };
  }
  const rows = await readLineReviewRowsFromHtmlFile(filePath);
  if (rows.length === 0) return undefined;
  return {
    title: path.basename(filePath),
    rows,
    state: {},
    pageSize: 1000,
    lineReviewPath: filePath
  };
}

export function lanSyncLineTranslationCount(document: LanSyncLineDocument | undefined): number {
  if (!document) return 0;
  const edits = document.state.edits && typeof document.state.edits === "object"
    ? document.state.edits as Record<string, unknown>
    : {};
  return document.rows.filter((row) => {
    const edited = edits[String(row.line)];
    return String(edited ?? row.translation ?? "").trim().length > 0;
  }).length;
}

export function normalizeLanSyncProposalDocument(args: LanSyncStartArgs): LanSyncProposalDocument | undefined {
  const source = args.proposalDocument && typeof args.proposalDocument === "object" ? args.proposalDocument : undefined;
  if (!source) return undefined;
  const proposals = normalizeLanSyncProposals(source.proposals);
  if (proposals.length === 0) return undefined;
  const requestedProposalReviewPath = typeof source.proposalReviewPath === "string" && source.proposalReviewPath.trim()
    ? source.proposalReviewPath
    : typeof args.htmlPath === "string"
      ? args.htmlPath
      : "";
  const normalizedProposalReviewPath = normalizeLinkedHtmlFilePath(requestedProposalReviewPath);
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
        : undefined,
    proposalReviewPath: normalizedProposalReviewPath
      && path.isAbsolute(normalizedProposalReviewPath)
      && path.extname(normalizedProposalReviewPath).toLowerCase() === ".html"
      ? path.normalize(normalizedProposalReviewPath)
      : undefined
  };
}

function sameLanSyncFilePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function translationWorkspaceDirFromPath(value: string): string {
  const parts = path.resolve(value).split(path.sep);
  const index = parts.map((part) => part.toLowerCase()).lastIndexOf(".translation-workshop");
  return index >= 0 ? parts.slice(0, index + 1).join(path.sep) : "";
}

export function assertLanSyncStartOwnership(args: LanSyncStartArgs, senderPathValue: string): void {
  const senderPath = normalizeLinkedHtmlFilePath(senderPathValue);
  if (!senderPath || !path.isAbsolute(senderPath) || path.extname(senderPath).toLowerCase() !== ".html") {
    throw new Error("LAN sync must be started by an open HTML review document.");
  }

  const requestedHtmlPath = typeof args.htmlPath === "string" && args.htmlPath.trim()
    ? normalizeLinkedHtmlFilePath(args.htmlPath, senderPath)
    : senderPath;
  if (!requestedHtmlPath || !sameLanSyncFilePath(senderPath, requestedHtmlPath)) {
    throw new Error("LAN sync must stay bound to the sender's current HTML document.");
  }

  const requestedProposalPath = typeof args.proposalDocument?.proposalReviewPath === "string"
    && args.proposalDocument.proposalReviewPath.trim()
    ? normalizeLinkedHtmlFilePath(args.proposalDocument.proposalReviewPath, senderPath)
    : requestedHtmlPath;
  if (args.proposalDocument && (!requestedProposalPath || !sameLanSyncFilePath(senderPath, requestedProposalPath))) {
    throw new Error("LAN sync proposal state must use the sender's owning proposal review HTML.");
  }

  const senderWorkspace = translationWorkspaceDirFromPath(senderPath);
  const linkedReviewPaths = [
    args.lineReviewPath,
    args.lineDocument?.lineReviewPath,
    args.proposalDocument?.lineReviewPath
  ];
  for (const value of linkedReviewPaths) {
    if (typeof value !== "string" || !value.trim()) continue;
    const linkedPath = normalizeLinkedHtmlFilePath(value, senderPath);
    const linkedWorkspace = linkedPath ? translationWorkspaceDirFromPath(linkedPath) : "";
    const owned = Boolean(
      linkedPath
      && path.isAbsolute(linkedPath)
      && path.extname(linkedPath).toLowerCase() === ".html"
      && (sameLanSyncFilePath(senderPath, linkedPath)
        || (senderWorkspace && linkedWorkspace && sameLanSyncFilePath(senderWorkspace, linkedWorkspace)))
    );
    if (!owned) {
      throw new Error("LAN sync linked review state cannot cross the sender workspace boundary.");
    }
  }
}
