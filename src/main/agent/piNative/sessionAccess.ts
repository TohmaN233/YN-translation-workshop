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
  const entries = await readSessionEntries(session);
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") { compactionIndex = index; break; }
  }
  const contextEntries = compactionIndex < 0 ? entries : entries.slice(compactionIndex);
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
