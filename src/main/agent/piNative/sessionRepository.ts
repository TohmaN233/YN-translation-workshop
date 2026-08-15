import { mkdir, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentMessage,
  type JsonlSessionMetadata,
  type Session
} from "@earendil-works/pi-agent-core/node";

import type { PiSessionSummary } from "../../../shared/agent/piSessionContract.ts";
import { writeTextFileAtomically } from "../../atomicFile.ts";

const AGENT_DIR = ".translation-workshop/agent";
const SESSION_DIR = "pi-sessions";
const CHILD_SESSION_DIR = "pi-child-sessions";
const UI_STATE_FILE = "pi-session-ui.json";
const SESSION_MIGRATIONS_FILE = "pi-session-migrations.json";
const PARENT_INSPECTION_MIGRATION_VERSION = 2;
const MAX_MIGRATED_RESULT_SUMMARY_CHARS = 4_000;
const uiStateWriteTails = new Map<string, Promise<void>>();
const sessionMigrationTails = new Map<string, Promise<void>>();

interface PiSessionUiState {
  activeSessionId: string;
}

interface PiSessionMigrationState {
  parentInspectionVersion: number;
  migratedSessionPaths: string[];
}

function rootDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), AGENT_DIR);
}

function sessionsRoot(workspaceDir: string): string {
  return path.join(rootDir(workspaceDir), SESSION_DIR);
}

function childSessionsRoot(workspaceDir: string): string {
  return path.join(rootDir(workspaceDir), CHILD_SESSION_DIR);
}

function uiStatePath(workspaceDir: string): string {
  return path.join(rootDir(workspaceDir), UI_STATE_FILE);
}

function sessionMigrationsPath(workspaceDir: string): string {
  return path.join(rootDir(workspaceDir), SESSION_MIGRATIONS_FILE);
}

async function serializeUiStateWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = uiStateWriteTails.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => completed);
  uiStateWriteTails.set(filePath, tail);
  await previous;
  try {
    await write();
  } finally {
    release();
    if (uiStateWriteTails.get(filePath) === tail) uiStateWriteTails.delete(filePath);
  }
}

async function serializeSessionMigration(filePath: string, migrate: () => Promise<void>): Promise<void> {
  const previous = sessionMigrationTails.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => completed);
  sessionMigrationTails.set(filePath, tail);
  await previous;
  try {
    await migrate();
  } finally {
    release();
    if (sessionMigrationTails.get(filePath) === tail) sessionMigrationTails.delete(filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeLegacyInspectionValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((item) => {
      const result = sanitizeLegacyInspectionValue(item);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: sanitized, changed: true } : { value, changed: false };
  }
  if (!isRecord(value)) return { value, changed: false };

  let changed = false;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "transcript" || key === "prompt" || key === "reply") {
      changed = true;
      continue;
    }
    if (key === "resultSummary" && typeof item === "string" && item.length > MAX_MIGRATED_RESULT_SUMMARY_CHARS) {
      sanitized[key] = `${item.slice(0, MAX_MIGRATED_RESULT_SUMMARY_CHARS)}\n[truncated]`;
      changed = true;
      continue;
    }
    const result = sanitizeLegacyInspectionValue(item);
    sanitized[key] = result.value;
    changed ||= result.changed;
  }
  return changed ? { value: sanitized, changed: true } : { value, changed: false };
}

function migrateLegacyInspectionMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "inspectSubagents") {
    return { message, changed: false };
  }

  const detailsResult = sanitizeLegacyInspectionValue(message.details);
  let contentChanged = false;
  let parsedTextBlock = false;
  const originalContent = Array.isArray(message.content) ? message.content : [];
  const sanitizedContent = originalContent.map((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
    try {
      const parsed = JSON.parse(block.text) as unknown;
      parsedTextBlock = true;
      const result = sanitizeLegacyInspectionValue(parsed);
      if (!result.changed) return block;
      contentChanged = true;
      return { ...block, text: JSON.stringify(result.value, null, 2) };
    } catch {
      if (/\"(?:transcript|reply)\"\s*:/.test(block.text)) {
        throw new Error("Legacy inspectSubagents content contains child transcript data but is not valid JSON.");
      }
      return block;
    }
  });

  if (!detailsResult.changed && !contentChanged) return { message, changed: false };
  const migratedContent = detailsResult.changed && !contentChanged && parsedTextBlock
    ? [{ type: "text", text: JSON.stringify(detailsResult.value, null, 2) }]
    : sanitizedContent;
  return {
    message: {
      ...message,
      details: detailsResult.value,
      content: migratedContent
    },
    changed: true
  };
}

function migrateLegacySubagentMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!isRecord(message) || message.role !== "custom" || typeof message.customType !== "string") {
    return { message, changed: false };
  }
  if (!message.customType.startsWith("subagent." ) && message.customType !== "subagent-completion") {
    return { message, changed: false };
  }
  const detailsResult = sanitizeLegacyInspectionValue(message.details);
  if (!message.customType.startsWith("subagent.")) {
    return detailsResult.changed
      ? { message: { ...message, details: detailsResult.value }, changed: true }
      : { message, changed: false };
  }
  const details = isRecord(detailsResult.value) ? detailsResult.value : {};
  const content = [details.resultSummary, details.error, details.label]
    .find((value) => typeof value === "string" && value.trim());
  const lightweightContent = typeof content === "string" ? content.trim() : "Subagent";
  if (!detailsResult.changed && message.content === lightweightContent) return { message, changed: false };
  return {
    message: { ...message, content: lightweightContent, details },
    changed: true
  };
}

function migrateLegacyParentMessage(message: unknown): { message: unknown; changed: boolean } {
  const inspection = migrateLegacyInspectionMessage(message);
  if (inspection.changed) return inspection;
  return migrateLegacySubagentMessage(message);
}

function migrateLegacyParentSessionJsonl(source: string): { text: string; changed: boolean } {
  const hadTrailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (hadTrailingNewline) lines.pop();
  let changed = false;
  const migrated = lines.map((line, index) => {
    if (!line.trim()) return line;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Failed to migrate Pi session JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(entry) || entry.type !== "message") return line;
    const result = migrateLegacyParentMessage(entry.message);
    if (!result.changed) return line;
    changed = true;
    return JSON.stringify({ ...entry, message: result.message });
  });
  return {
    text: `${migrated.join("\n")}${hadTrailingNewline ? "\n" : ""}`,
    changed
  };
}

async function readSessionMigrationState(filePath: string): Promise<PiSessionMigrationState> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<PiSessionMigrationState>;
    if (
      typeof parsed.parentInspectionVersion !== "number"
      || parsed.parentInspectionVersion > PARENT_INSPECTION_MIGRATION_VERSION
      || !Array.isArray(parsed.migratedSessionPaths)
      || parsed.migratedSessionPaths.some((item) => typeof item !== "string")
    ) {
      throw new Error(`Unsupported Pi session migration state at ${filePath}.`);
    }
    return {
      parentInspectionVersion: PARENT_INSPECTION_MIGRATION_VERSION,
      migratedSessionPaths: parsed.parentInspectionVersion === PARENT_INSPECTION_MIGRATION_VERSION
        ? [...parsed.migratedSessionPaths]
        : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        parentInspectionVersion: PARENT_INSPECTION_MIGRATION_VERSION,
        migratedSessionPaths: []
      };
    }
    throw error;
  }
}

async function migrateLegacyParentSession(workspaceDir: string, sessionPath: string): Promise<void> {
  const statePath = sessionMigrationsPath(workspaceDir);
  await serializeSessionMigration(statePath, async () => {
    const state = await readSessionMigrationState(statePath);
    if (state.migratedSessionPaths.includes(sessionPath)) return;

    const source = await readFile(sessionPath, "utf8");
    const migrated = migrateLegacyParentSessionJsonl(source);
    if (migrated.changed) await writeTextFileAtomically(sessionPath, migrated.text);

    state.migratedSessionPaths.push(sessionPath);
    await mkdir(rootDir(workspaceDir), { recursive: true });
    await writeTextFileAtomically(statePath, JSON.stringify(state, null, 2));
  });
}

function textFromMessage(message: AgentMessage): string {
  if (message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

async function firstUserMessage(filePath: string): Promise<string> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      return textFromMessage(entry.message) || "New session";
    }
    return "New session";
  } finally {
    lines.close();
    input.destroy();
  }
}

export class PiSessionRepository {
  readonly workspaceDir: string;
  readonly env: NodeExecutionEnv;
  readonly repo: JsonlSessionRepo;
  readonly childRepo: JsonlSessionRepo;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.env = new NodeExecutionEnv({ cwd: this.workspaceDir });
    this.repo = new JsonlSessionRepo({ fs: this.env, sessionsRoot: sessionsRoot(this.workspaceDir) });
    this.childRepo = new JsonlSessionRepo({ fs: this.env, sessionsRoot: childSessionsRoot(this.workspaceDir) });
  }

  async create(id?: string): Promise<Session<JsonlSessionMetadata>> {
    return this.repo.create({ cwd: this.workspaceDir, id });
  }

  async createChild(id?: string, parentSessionId?: string): Promise<Session<JsonlSessionMetadata>> {
    const parent = parentSessionId ? await this.findMetadata(parentSessionId) : undefined;
    return this.childRepo.create({
      cwd: this.workspaceDir,
      id,
      ...(parent ? { parentSessionPath: parent.path } : {})
    });
  }

  async listChildMetadata(): Promise<JsonlSessionMetadata[]> {
    return this.childRepo.list({ cwd: this.workspaceDir });
  }

  async findChildMetadata(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    return (await this.listChildMetadata()).find((item) => item.id === sessionId);
  }

  async openChild(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
    const metadata = await this.findChildMetadata(sessionId);
    if (!metadata) throw new Error(`Pi child session ${sessionId} was not found.`);
    return this.childRepo.open(metadata);
  }

  async openChildForParent(
    childSessionId: string,
    parentSessionId: string
  ): Promise<Session<JsonlSessionMetadata>> {
    const [child, parent] = await Promise.all([
      this.findChildMetadata(childSessionId),
      this.findMetadata(parentSessionId)
    ]);
    if (!child) throw new Error(`Pi child session ${childSessionId} was not found.`);
    if (!parent) throw new Error(`Pi session ${parentSessionId} was not found.`);
    if (child.parentSessionPath !== parent.path) {
      throw new Error(`Pi child session ${childSessionId} does not belong to Pi session ${parentSessionId}.`);
    }
    return this.childRepo.open(child);
  }

  async listMetadata(): Promise<JsonlSessionMetadata[]> {
    return this.repo.list({ cwd: this.workspaceDir });
  }

  async findMetadata(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    return (await this.listMetadata()).find((item) => item.id === sessionId);
  }

  async open(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
    const metadata = await this.findMetadata(sessionId);
    if (!metadata) throw new Error(`Pi session ${sessionId} was not found.`);
    await migrateLegacyParentSession(this.workspaceDir, metadata.path);
    return this.repo.open(metadata);
  }

  async delete(sessionId: string): Promise<boolean> {
    const metadata = await this.findMetadata(sessionId);
    if (!metadata) return false;
    const linkedChildren = (await this.listChildMetadata())
      .filter((child) => child.parentSessionPath === metadata.path);
    for (const child of linkedChildren) await this.childRepo.delete(child);
    await this.repo.delete(metadata);
    return true;
  }

  async listSummaries(): Promise<PiSessionSummary[]> {
    const metadata = await this.listMetadata();
    return Promise.all(metadata.map((item) => this.summaryForMetadata(item)));
  }

  async summaryForMetadata(item: JsonlSessionMetadata): Promise<PiSessionSummary> {
    const [firstMessage, fileInfo] = await Promise.all([
      firstUserMessage(item.path),
      this.env.fileInfo(item.path)
    ]);
    if (!fileInfo.ok) throw fileInfo.error;
    return {
      id: item.id,
      path: item.path,
      cwd: item.cwd,
      created: item.createdAt,
      modified: new Date(fileInfo.value.mtimeMs).toISOString(),
      messageCount: 0,
      firstMessage
    };
  }

  async readActiveSessionId(): Promise<string> {
    try {
      const state = JSON.parse(await readFile(uiStatePath(this.workspaceDir), "utf8")) as Partial<PiSessionUiState>;
      return typeof state.activeSessionId === "string" ? state.activeSessionId : "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new Error(`Failed to read Pi session UI state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async writeActiveSessionId(sessionId: string): Promise<void> {
    await mkdir(rootDir(this.workspaceDir), { recursive: true });
    const targetPath = uiStatePath(this.workspaceDir);
    await serializeUiStateWrite(targetPath, async () => {
      await writeTextFileAtomically(
        targetPath,
        JSON.stringify({ activeSessionId: sessionId } satisfies PiSessionUiState, null, 2)
      );
    });
  }
}
