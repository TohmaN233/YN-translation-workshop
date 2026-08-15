import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { lanSyncJson, lanSyncLabels } from "./lanSyncHttp.ts";
import {
  recordLineStateRevision,
  type LanSyncCommand,
  type LanSyncLineDocument,
  type LanSyncPatch,
  type LanSyncProposalDocument,
  type LanSyncSession
} from "./lanSyncState.ts";

export interface LanSyncDocumentPersistence {
  persistLine: (document: LanSyncLineDocument, line: number, patch: LanSyncPatch) => Promise<void>;
  persistProposal: (document: LanSyncProposalDocument, patch: LanSyncPatch) => Promise<void>;
}

export function normalizeLanSyncCommand(value: unknown): LanSyncCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Partial<LanSyncCommand>;
  if (source.type !== "open-agent-os") return undefined;
  return {
    type: "open-agent-os",
    ...(typeof source.clientId === "string" && source.clientId ? { clientId: source.clientId } : {}),
    ...(typeof source.timestamp === "string" && source.timestamp ? { timestamp: source.timestamp } : {})
  };
}

export function hashLanSyncPin(pin: string): string {
  return createHash("sha256").update(pin, "utf8").digest("hex");
}

export function isValidLanSyncPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

export function lanSyncAuthTokenFrom(url: URL, body?: { authToken?: unknown }): string {
  const fromQuery = url.searchParams.get("auth");
  if (fromQuery) return fromQuery;
  return typeof body?.authToken === "string" ? body.authToken : "";
}

export function isLanSyncAuthorized(session: LanSyncSession, token: string): boolean {
  return Boolean(token && session.authTokens.has(token));
}

export function lanSyncSessionPayload(session: LanSyncSession): Record<string, unknown> {
  const line = session.documents.line;
  const proposal = session.documents.proposal;
  return {
    title: session.title,
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

export function applyLanSyncPatchToSession(session: LanSyncSession, patch: LanSyncPatch): void {
  if (patch.type === "proposal-decision") {
    const proposalId = String(patch.proposalId || "").trim();
    const proposal = session.documents.proposal;
    if (!proposalId || !proposal) return;
    const decisions = (proposal.state.decisions && typeof proposal.state.decisions === "object")
      ? proposal.state.decisions as Record<string, unknown>
      : {};
    proposal.state.decisions = decisions;
    const previous = decisions[proposalId] && typeof decisions[proposalId] === "object"
      ? decisions[proposalId] as Record<string, unknown>
      : {};
    decisions[proposalId] = {
      ...previous,
      status: patch.status || "manual",
      manualText: patch.manualText === undefined ? "" : String(patch.manualText),
      ...(patch.overrideConflict !== undefined ? { overrideConflict: patch.overrideConflict === true } : {}),
      ...(patch.conflictReason !== undefined ? { conflictReason: String(patch.conflictReason) } : {})
    };
    return;
  }
  const lineDocument = session.documents.line;
  if (!lineDocument) return;
  const line = Number(patch.line || 0);
  if (!Number.isInteger(line) || line <= 0) return;
  const edits = (lineDocument.state.edits && typeof lineDocument.state.edits === "object")
    ? lineDocument.state.edits as Record<string, unknown>
    : {};
  const status = (lineDocument.state.status && typeof lineDocument.state.status === "object")
    ? lineDocument.state.status as Record<string, unknown>
    : {};
  lineDocument.state.edits = edits;
  lineDocument.state.status = status;
  lineDocument.state.activeLine = String(line);
  const row = lineDocument.rows.find((item) => Number(item.line) === line);
  if (patch.type === "line-restore") {
    delete edits[String(line)];
    delete status[String(line)];
    recordLineStateRevision(lineDocument.state, line, row?.translation ?? "", row?.status ?? "", "lan-restore");
    return;
  }
  edits[String(line)] = String(patch.text ?? "");
  status[String(line)] = patch.status || "manual";
  recordLineStateRevision(lineDocument.state, line, String(edits[String(line)] ?? ""), String(status[String(line)] ?? ""), "lan-edit");
}

export async function applyLanSyncPatchTransaction(
  session: LanSyncSession,
  patch: LanSyncPatch,
  persist: (stagedSession: LanSyncSession, patch: LanSyncPatch) => Promise<void>
): Promise<void> {
  const stagedSession: LanSyncSession = {
    ...session,
    documents: {
      line: session.documents.line
        ? { ...session.documents.line, state: structuredClone(session.documents.line.state) }
        : undefined,
      proposal: session.documents.proposal
        ? { ...session.documents.proposal, state: structuredClone(session.documents.proposal.state) }
        : undefined
    }
  };

  applyLanSyncPatchToSession(stagedSession, patch);
  await persist(stagedSession, patch);

  if (session.documents.line && stagedSession.documents.line) {
    session.documents.line.state = stagedSession.documents.line.state;
  }
  if (session.documents.proposal && stagedSession.documents.proposal) {
    session.documents.proposal.state = stagedSession.documents.proposal.state;
  }
}

export async function persistLanSyncDocumentPatch(
  session: LanSyncSession,
  patch: LanSyncPatch,
  persistence: LanSyncDocumentPersistence
): Promise<void> {
  if (patch.type === "proposal-decision") {
    const proposalId = String(patch.proposalId || "").trim();
    const document = session.documents.proposal;
    if (!proposalId || !document?.proposals.some((proposal) => proposal.id === proposalId)) {
      throw new Error(`Unknown LAN proposal decision target: ${proposalId || "<missing>"}.`);
    }
    if (!document.proposalReviewPath) {
      throw new Error("LAN proposal decisions require an owning proposal review HTML path.");
    }
    await persistence.persistProposal(document, patch);
    return;
  }

  const document = session.documents.line;
  const line = Number(patch.line || 0);
  if (!document?.lineReviewPath || !Number.isInteger(line) || line <= 0) {
    throw new Error(`LAN line patch requires an owning line-review HTML path and a valid line: ${line || "<missing>"}.`);
  }
  if (!document.rows.some((row) => row.line === line)) {
    throw new Error(`Unknown LAN line patch target: ${line}.`);
  }
  await persistence.persistLine(document, line, patch);
}

const lanSyncCommitTails = new WeakMap<LanSyncSession, Promise<void>>();
const closedLanSyncSessions = new WeakSet<LanSyncSession>();
const lanSyncOwnerRegistrationTails = new Map<number, Promise<boolean>>();

function assertLanSyncSessionOpen(session: LanSyncSession): void {
  if (closedLanSyncSessions.has(session)) {
    throw new Error("LAN sync session has stopped; stale edits cannot be committed.");
  }
}

export async function commitLanSyncPatch(
  session: LanSyncSession,
  patch: LanSyncPatch,
  persist: (stagedSession: LanSyncSession, patch: LanSyncPatch) => Promise<void>,
  publish: (session: LanSyncSession, patch: LanSyncPatch) => void | Promise<void>
): Promise<void> {
  assertLanSyncSessionOpen(session);
  const previous = lanSyncCommitTails.get(session) ?? Promise.resolve();
  const commit = previous
    .catch(() => undefined)
    .then(async () => {
      assertLanSyncSessionOpen(session);
      await applyLanSyncPatchTransaction(session, patch, persist);
      if (!closedLanSyncSessions.has(session)) {
        await publish(session, patch);
      }
    });
  lanSyncCommitTails.set(session, commit);
  try {
    await commit;
  } finally {
    if (lanSyncCommitTails.get(session) === commit) lanSyncCommitTails.delete(session);
  }
}

export function broadcastLanSyncPatch(session: LanSyncSession, patch: LanSyncPatch): void {
  const data = `event: patch\ndata: ${lanSyncJson({ patch })}\n\n`;
  for (const client of [...session.clients]) {
    if (client.destroyed) {
      session.clients.delete(client);
      continue;
    }
    client.write(data);
  }
}

export async function stopLanSyncSession(session: LanSyncSession, sessions: Map<string, LanSyncSession>): Promise<void> {
  closedLanSyncSessions.add(session);
  for (const client of session.clients) {
    client.write(`event: stop\ndata: ${lanSyncJson({ ok: true })}\n\n`);
    client.end();
  }
  session.clients.clear();
  if (sessions.get(session.token) === session) sessions.delete(session.token);
  await lanSyncCommitTails.get(session)?.catch(() => undefined);
}

export async function registerLanSyncSession(
  session: LanSyncSession,
  sessions: Map<string, LanSyncSession>,
  isOwnerActive: () => boolean = () => true
): Promise<boolean> {
  const ownerId = session.ownerWebContentsId;
  const previous = lanSyncOwnerRegistrationTails.get(ownerId) ?? Promise.resolve(true);
  const registration = previous
    .catch(() => undefined)
    .then(async () => {
      for (const existing of [...sessions.values()]) {
        if (existing.ownerWebContentsId === ownerId) {
          await stopLanSyncSession(existing, sessions);
        }
      }
      if (!isOwnerActive()) {
        closedLanSyncSessions.add(session);
        return false;
      }
      closedLanSyncSessions.delete(session);
      sessions.set(session.token, session);
      return true;
    });
  lanSyncOwnerRegistrationTails.set(ownerId, registration);
  try {
    return await registration;
  } finally {
    if (lanSyncOwnerRegistrationTails.get(ownerId) === registration) {
      lanSyncOwnerRegistrationTails.delete(ownerId);
    }
  }
}

export async function readLanSyncBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as unknown : {};
}
