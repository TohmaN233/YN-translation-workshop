import {
  BACKGROUND_CONTEXT,
  branchTip,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  insertEntry,
  setValue,
  type AgentMessage,
  type CompactResult,
  type Context,
  type Entry,
  type JsonValue,
  type Session
} from "@earendil-works/pi-agent-core/node";
import type { IndexedJsonlStorage } from "./indexedJsonlStorage.ts";
import path from "node:path";

const diskSessions = new WeakMap<object, { path: string; storage: IndexedJsonlStorage }>();
const openDiskSessions = new Map<string, WeakRef<Session>>();
const sessionPathKey = (filePath: string) => process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
export function registerDiskSession(session: Session, storage: IndexedJsonlStorage): void {
  diskSessions.set(session, { path: storage.path, storage });
  openDiskSessions.set(sessionPathKey(storage.path), new WeakRef(session));
}
export function unregisterDiskSession(session: Session): void {
  const disk = diskSessions.get(session);
  if (disk && openDiskSessions.get(sessionPathKey(disk.path))?.deref() === session) openDiskSessions.delete(sessionPathKey(disk.path));
  diskSessions.delete(session);
}
/** Borrow for read-only inspection; the runtime retains its Session ownership. */
export function getOpenDiskSession(filePath: string): Session | undefined {
  return openDiskSessions.get(sessionPathKey(filePath))?.deref();
}
export function getDiskSessionAccess(session: Session): { path: string; storage: IndexedJsonlStorage } | undefined {
  return diskSessions.get(session);
}

export const PI_SESSION_BRANCH = "main";

// Keep Pi's native transaction/branch ownership. In particular, creating the
// initial branch and its first entry must share the session mutation barrier.
async function appendEntry(
  session: Session,
  payload: Omit<Extract<Entry, { type: "message" }>, "id" | "parentId" | "seq" | "timestamp">
    | Omit<Extract<Entry, { type: "custom" }>, "id" | "parentId" | "seq" | "timestamp">
    | Omit<Extract<Entry, { type: "compaction" }>, "id" | "parentId" | "seq" | "timestamp">,
  context: Context = BACKGROUND_CONTEXT
): Promise<string> {
  const id = session.idGenerator.next();
  await session.mutate(async (mutation) => {
    const tip = await mutation.getValue(branchTip(PI_SESSION_BRANCH), context);
    await mutation.commit([
      insertEntry({ ...payload, id, parentId: tip?.value ?? null }),
      setValue(branchTip(PI_SESSION_BRANCH), id)
    ], context);
  }, context);
  return id;
}

export function appendSessionMessage(session: Session, message: AgentMessage): Promise<string> {
  return appendEntry(session, { type: "message", message });
}

export function appendSessionCustomEntry(session: Session, customType: string, data: unknown): Promise<string> {
  return appendEntry(session, { type: "custom", customType, data: data as JsonValue });
}

export function appendSessionCompaction(session: Session, result: CompactResult): Promise<string> {
  return appendEntry(session, { type: "compaction", ...result, fromHook: false });
}

export async function readSessionEntries(session: Session): Promise<Entry[]> {
  const branch = await session.branch(PI_SESSION_BRANCH, BACKGROUND_CONTEXT);
  return branch ? branch.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT) : [];
}

/** Read bounded pages; historical Host payloads must not accumulate in memory. */
export async function* iterateSessionEntries(
  session: Session,
  options: { type?: Entry["type"]; customType?: string; afterSeq?: number } = {}
): AsyncGenerator<Entry> {
  const branch = await session.branch(PI_SESSION_BRANCH, BACKGROUND_CONTEXT);
  if (!branch) return;
  let cursor = options.afterSeq === undefined ? undefined : { seq: options.afterSeq };
  while (true) {
    const entries = await branch.findEntries({
      order: "oldestFirst", limit: 32, cursor,
      ...(options.type ? { type: options.type } : {}),
      ...(options.customType ? { customType: options.customType } : {})
    }, BACKGROUND_CONTEXT);
    if (!entries.length) return;
    for (const entry of entries) yield entry;
    cursor = { seq: entries[entries.length - 1]!.seq };
  }
}

/**
 * Source-adapted from Pi 0.99.1 harness/session/context.ts (MIT).
 * That helper is not a public package export. Keep its native retainedTail
 * projection; display/audit callers also retain failed assistant messages as
 * they did in YN v3. Runtime hydration requests Pi's model-context filtering.
 */
export async function readSessionContext(
  session: Session,
  options: { includeFailedAssistant?: boolean } = {}
): Promise<{ messages: AgentMessage[] }> {
  const branch = await session.branch(PI_SESSION_BRANCH, BACKGROUND_CONTEXT);
  const compaction = await branch?.findEntry({ type: "compaction", order: "newestFirst" }, BACKGROUND_CONTEXT);
  const contextEntries: Entry[] = compaction ? [compaction] : [];
  for (const type of ["message", "branch_summary"] as const) {
    for await (const entry of iterateSessionEntries(session, { type, afterSeq: compaction?.seq })) {
      contextEntries.push(entry);
    }
  }
  contextEntries.sort((left, right) => left.seq - right.seq);
  const messages: AgentMessage[] = [];
  for (const entry of contextEntries) {
    switch (entry.type) {
      case "message": messages.push(entry.message); break;
      case "compaction":
        messages.push(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail);
        break;
      case "branch_summary":
        if (entry.summary) messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
        break;
      case "custom": break; // Host state and diagnostics have no model projection.
    }
  }
  return {
    messages: options.includeFailedAssistant === false
      ? messages.filter((message) => message.role !== "assistant"
        || !["error", "aborted", "deferred"].includes(message.stopReason))
      : messages
  };
}
