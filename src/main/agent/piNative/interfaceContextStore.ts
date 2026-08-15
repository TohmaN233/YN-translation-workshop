import path from "node:path";

import type {
  YnInterfaceContext,
  YnInterfaceContextSnapshot,
  YnInterfaceFocusedLine,
  YnInterfacePageKind
} from "../../../shared/agent/ynInterfaceContext.ts";

const STALE_AFTER_MS = 8_000;
const MAX_PATH_LENGTH = 32_768;
const MAX_LINE_TEXT_LENGTH = 8_192;
const MAX_STATUS_LENGTH = 1_024;

function workspaceKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function boundedText(
  value: unknown,
  name: string,
  maximum: number,
  options: { required?: boolean; preserveWhitespace?: boolean } = {}
): string | undefined {
  const raw = typeof value === "string" ? value : "";
  const text = options.preserveWhitespace ? raw : raw.trim();
  if (options.required && !text.trim()) throw new Error(`${name} is required.`);
  if (!text && !options.preserveWhitespace) return undefined;
  if (text.length > maximum) throw new Error(`${name} is too long.`);
  return text;
}

function optionalNumber(value: unknown, name: string, integer = false): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a non-negative ${integer ? "integer" : "number"}.`);
  }
  return value;
}

function pageKind(value: unknown): YnInterfacePageKind {
  if (value === "line-review" || value === "proposal-review" || value === "workspace") return value;
  throw new Error("pageKind must be line-review, proposal-review, or workspace.");
}

function focusedLine(value: unknown): YnInterfaceFocusedLine | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("focusedLine must be an object.");
  }
  const line = value as Record<string, unknown>;
  const lineNumber = optionalNumber(line.line, "focusedLine.line", true);
  if (!lineNumber || lineNumber < 1) throw new Error("focusedLine.line must be a positive integer.");
  return {
    line: lineNumber,
    source: boundedText(line.source, "focusedLine.source", MAX_LINE_TEXT_LENGTH, { preserveWhitespace: true }) ?? "",
    translation: boundedText(line.translation, "focusedLine.translation", MAX_LINE_TEXT_LENGTH, { preserveWhitespace: true }) ?? "",
    status: boundedText(line.status, "focusedLine.status", MAX_STATUS_LENGTH),
    selectedSourceText: boundedText(
      line.selectedSourceText,
      "focusedLine.selectedSourceText",
      MAX_LINE_TEXT_LENGTH,
      { preserveWhitespace: true }
    )
  };
}

function parseContext(value: unknown, now: number): YnInterfaceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("YN interface context must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const version = optionalNumber(raw.version, "version", true);
  if (version !== 1) throw new Error("YN interface context version must be 1.");
  return {
    version: 1,
    outputDir: path.resolve(boundedText(raw.outputDir, "outputDir", MAX_PATH_LENGTH, { required: true })!),
    htmlPath: boundedText(raw.htmlPath, "htmlPath", MAX_PATH_LENGTH),
    pageKind: pageKind(raw.pageKind),
    sourcePath: boundedText(raw.sourcePath, "sourcePath", MAX_PATH_LENGTH),
    translationPath: boundedText(raw.translationPath, "translationPath", MAX_PATH_LENGTH),
    page: optionalNumber(raw.page, "page", true),
    pageSize: optionalNumber(raw.pageSize, "pageSize", true),
    scrollTop: optionalNumber(raw.scrollTop, "scrollTop"),
    activeLine: optionalNumber(raw.activeLine, "activeLine", true),
    visibleLineStart: optionalNumber(raw.visibleLineStart, "visibleLineStart", true),
    visibleLineEnd: optionalNumber(raw.visibleLineEnd, "visibleLineEnd", true),
    focusedLine: focusedLine(raw.focusedLine),
    updatedAt: now
  };
}

export class YnInterfaceContextStore {
  private readonly sources = new Map<number, YnInterfaceContext>();

  publish(
    senderId: number,
    value: unknown,
    now = Date.now(),
    trustedOutputDir?: string
  ): YnInterfaceContext {
    if (!Number.isInteger(senderId) || senderId < 1) throw new Error("senderId must be a positive integer.");
    const context = parseContext(value, now);
    if (trustedOutputDir) {
      const trustedWorkspace = path.resolve(trustedOutputDir);
      if (workspaceKey(context.outputDir) !== workspaceKey(trustedWorkspace)) {
        throw new Error("YN interface context cannot cross the sender's project workspace boundary.");
      }
      context.outputDir = trustedWorkspace;
    }
    this.sources.set(senderId, context);
    return context;
  }

  removeSource(senderId: number): void {
    this.sources.delete(senderId);
  }

  read(outputDir: string, now = Date.now()): YnInterfaceContextSnapshot {
    const workspace = workspaceKey(outputDir);
    const context = [...this.sources.values()]
      .filter((entry) => workspaceKey(entry.outputDir) === workspace)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!context) return { available: false };
    if (now - context.updatedAt > STALE_AFTER_MS) return { available: false, stale: true };
    return { available: true, context };
  }
}

export const ynInterfaceContextStore = new YnInterfaceContextStore();
