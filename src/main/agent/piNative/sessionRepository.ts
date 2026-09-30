import { link, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createReadStream } from "node:fs";
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
  const header = readValidatedSessionHeader(source);
  // Released YN sessions use v3. Format 4 belongs to Pi's native transaction
  // codec and must never be rewritten as old flat message records.
  if (header.v === 4) return { text: source, changed: false };
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
    if (!isRecord(entry)) return line;
    const message = entry.type === "message" ? entry.message
      : entry.type === "custom_message" ? { ...entry, role: "custom" } : undefined;
    if (message === undefined) return line;
    const result = migrateLegacyParentMessage(message);
    if (!result.changed) return line;
    changed = true;
    if (entry.type === "message") return JSON.stringify({ ...entry, message: result.message });
    const migratedMessage = result.message as Record<string, unknown>;
    return JSON.stringify({ ...entry, content: migratedMessage.content, details: migratedMessage.details });
  });
  return {
    text: `${migrated.join("\n")}${hadTrailingNewline ? "\n" : ""}`,
    changed
  };
}

function readValidatedSessionHeader(source: string): Record<string, unknown> {
  const firstLine = source.split("\n", 1)[0];
  const header: unknown = JSON.parse(firstLine);
  if (!isRecord(header) || typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new Error("Invalid Pi session header identity.");
  }
  if (header.type === "session" && header.version === 3
    && typeof header.timestamp === "string" && Number.isFinite(Date.parse(header.timestamp))) return header;
  if (header.kind === "header" && header.v === 4
    && header.storageVersion === 1
    && Number.isSafeInteger(header.createdAt) && (header.createdAt as number) >= 0
    && (header.parentSessionId === undefined || typeof header.parentSessionId === "string")
    && (header.legacyParentSessionPath === undefined || typeof header.legacyParentSessionPath === "string")) return header;
  throw new Error("Unsupported Pi session header; expected legacy v3 or native v4.");
}

async function backupLegacySession(sessionPath: string, source: string): Promise<void> {
  const header = readValidatedSessionHeader(source);
  if (header.v === 4) return;
  const backupPath = `${sessionPath}.v3.backup`;
  const temporaryPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx");
    try {
      await file.writeFile(source, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // Hard-link publication is atomic and cannot overwrite the first backup,
      // even when two repository instances encounter the same legacy file.
      await link(temporaryPath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const backup = await readFile(backupPath, "utf8");
      const backupHeader = readValidatedSessionHeader(backup);
      if (backupHeader.version !== 3 || backupHeader.id !== header.id || backupHeader.cwd !== header.cwd) {
        throw new Error(`Legacy Pi backup identity does not match ${sessionPath}.`);
      }
      // A retry may follow an already committed v3 slimming write. Preserve the
      // earlier original, while rejecting an unusable or partial backup.
      for (const line of backup.split("\n")) if (line.trim()) JSON.parse(line);
      if (source.endsWith("\n") && !backup.endsWith("\n")) {
        throw new Error(`Legacy Pi backup is incomplete for ${sessionPath}.`);
      }
      if (backup !== source && migrateLegacyParentSessionJsonl(backup).text !== source) {
        throw new Error(`Legacy Pi backup does not match the original or migrated source at ${sessionPath}.`);
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
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
    if ((await readSessionHeader(sessionPath)).v === 4) return;
    const state = await readSessionMigrationState(statePath);
    const source = await readFile(sessionPath, "utf8");
    await backupLegacySession(sessionPath, source);
    if (state.migratedSessionPaths.includes(sessionPath)) return;
    const migrated = migrateLegacyParentSessionJsonl(source);
    if (migrated.changed) await writeTextFileAtomically(sessionPath, migrated.text);

    state.migratedSessionPaths.push(sessionPath);
    await mkdir(rootDir(workspaceDir), { recursive: true });
    await writeTextFileAtomically(statePath, JSON.stringify(state, null, 2));
  });
}

async function readSessionHeader(filePath: string): Promise<Record<string, unknown>> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) return readValidatedSessionHeader(line);
    }
    throw new Error(`Empty Pi session file: ${filePath}.`);
  } finally {
    lines.close();
    input.destroy();
  }
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
  let headerRead = false;
  let native = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (!headerRead) {
        native = readValidatedSessionHeader(line).v === 4;
        headerRead = true;
        continue;
      }
      const record: unknown = JSON.parse(line);
      const records = native && Array.isArray(record) ? record : [record];
      for (const entry of records) {
        if (!isRecord(entry) || (native && entry.kind !== "entry")) continue;
        if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
        return textFromMessage(entry.message as unknown as AgentMessage) || "New session";
      }
    }
    if (!headerRead) throw new Error(`Empty Pi session file: ${filePath}.`);
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
  private readonly sessions = new Map<string, Promise<Session<JsonlSessionMetadata>>>();
  private readonly childSessions = new Map<string, Promise<Session<JsonlSessionMetadata>>>();

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.env = new NodeExecutionEnv({ cwd: this.workspaceDir });
    this.repo = new JsonlSessionRepo({ fileSystem: this.env, sessionsRoot: sessionsRoot(this.workspaceDir) });
    this.childRepo = new JsonlSessionRepo({ fileSystem: this.env, sessionsRoot: childSessionsRoot(this.workspaceDir) });
  }

  async create(id?: string): Promise<Session<JsonlSessionMetadata>> {
    const session = await this.repo.create({ cwd: this.workspaceDir, id }, BACKGROUND_CONTEXT);
    this.sessions.set(session.metadata.id, Promise.resolve(session));
    return session;
  }

  async createChild(id?: string, parentSessionId?: string): Promise<Session<JsonlSessionMetadata>> {
    const session = await this.childRepo.create({
      cwd: this.workspaceDir,
      id,
      ...(parentSessionId ? { parentSessionId } : {})
    }, BACKGROUND_CONTEXT);
    this.childSessions.set(session.metadata.id, Promise.resolve(session));
    return session;
  }

  async listChildMetadata(): Promise<JsonlSessionMetadata[]> {
    return this.childRepo.list({ cwd: this.workspaceDir }, BACKGROUND_CONTEXT);
  }

  async findChildMetadata(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    return (await this.listChildMetadata()).find((item) => item.id === sessionId);
  }

  async openChild(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
    const metadata = await this.findChildMetadata(sessionId);
    if (!metadata) throw new Error(`Pi child session ${sessionId} was not found.`);
    return this.openOwned(metadata, true);
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
    if (!await this.belongsToParent(child, parent)) {
      throw new Error(`Pi child session ${childSessionId} does not belong to Pi session ${parentSessionId}.`);
    }
    return this.openOwned(child, true);
  }

  async listMetadata(): Promise<JsonlSessionMetadata[]> {
    return this.repo.list({ cwd: this.workspaceDir }, BACKGROUND_CONTEXT);
  }

  async findMetadata(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    return (await this.listMetadata()).find((item) => item.id === sessionId);
  }

  async open(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
    const metadata = await this.findMetadata(sessionId);
    if (!metadata) throw new Error(`Pi session ${sessionId} was not found.`);
    return this.openOwned(metadata, false);
  }

  async delete(sessionId: string): Promise<boolean> {
    const metadata = await this.findMetadata(sessionId);
    if (!metadata) return false;
    for (const child of await this.listChildMetadata()) {
      if (!await this.belongsToParent(child, metadata)) continue;
      await this.closeChildSession(child.id);
      await this.childRepo.delete(child, BACKGROUND_CONTEXT);
    }
    await this.closeSession(metadata.id);
    await this.repo.delete(metadata, BACKGROUND_CONTEXT);
    return true;
  }

  async listSummaries(): Promise<PiSessionSummary[]> {
    const metadata = await this.listMetadata();
    return Promise.all(metadata.map((item) => this.summaryForMetadata(item)));
  }

  async summaryForMetadata(item: JsonlSessionMetadata): Promise<PiSessionSummary> {
    // Keep the existing sidebar contract and streaming title read. Opening a
    // native Session just for getStats/name loads the entire historical JSONL.
    return {
      id: item.id,
      path: item.path,
      cwd: item.cwd,
      created: new Date(item.createdAt).toISOString(),
      modified: new Date(item.modifiedAt).toISOString(),
      messageCount: 0,
      firstMessage: await firstUserMessage(item.path)
    };
  }

  private async belongsToParent(child: JsonlSessionMetadata, parent: JsonlSessionMetadata): Promise<boolean> {
    if (child.parentSessionId !== undefined) return child.parentSessionId === parent.id;
    if (child.legacyParentSessionPath === undefined) return false;
    if (path.resolve(child.legacyParentSessionPath) !== path.resolve(parent.path)) return false;
    const [legacyPath, parentPath] = await Promise.all([realpath(child.legacyParentSessionPath), realpath(parent.path)]);
    if (legacyPath !== parentPath) return false;
    const header = await readSessionHeader(parentPath);
    if (header.id !== parent.id || path.resolve(header.cwd as string) !== this.workspaceDir) {
      throw new Error(`Legacy Pi parent identity does not match ${parent.id}.`);
    }
    return true;
  }

  private async openOwned(metadata: JsonlSessionMetadata, child: boolean): Promise<Session<JsonlSessionMetadata>> {
    const cache = child ? this.childSessions : this.sessions;
    const existing = cache.get(metadata.id);
    if (existing) return existing;
    const opening = (async () => {
      if (child) {
        await serializeSessionMigration(metadata.path, async () => {
          if ((await readSessionHeader(metadata.path)).v !== 4) {
            await backupLegacySession(metadata.path, await readFile(metadata.path, "utf8"));
          }
        });
      } else await migrateLegacyParentSession(this.workspaceDir, metadata.path);
      return (child ? this.childRepo : this.repo).open(metadata, BACKGROUND_CONTEXT);
    })();
    cache.set(metadata.id, opening);
    try { return await opening; }
    catch (error) {
      if (cache.get(metadata.id) === opening) cache.delete(metadata.id);
      throw error;
    }
  }

  async closeSession(sessionId: string): Promise<void> { await this.closeOwned(sessionId, false); }
  async closeChildSession(sessionId: string): Promise<void> { await this.closeOwned(sessionId, true); }

  private async closeOwned(sessionId: string, child: boolean): Promise<void> {
    const cache = child ? this.childSessions : this.sessions;
    const session = cache.get(sessionId);
    if (!session) return;
    await (await session).close(BACKGROUND_CONTEXT);
    if (cache.get(sessionId) === session) cache.delete(sessionId);
  }

  async close(): Promise<void> {
    for (const id of this.sessions.keys()) await this.closeSession(id);
    for (const id of this.childSessions.keys()) await this.closeChildSession(id);
    await this.repo.close(BACKGROUND_CONTEXT);
    await this.childRepo.close(BACKGROUND_CONTEXT);
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
