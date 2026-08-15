import path from "node:path";

export interface AuditWhitelistDocument {
  documentId: string;
  sourcePath: string;
  lines: number[];
  updatedAt: string;
}

export interface AuditWhitelistStore {
  version: 2;
  documents: Record<string, AuditWhitelistDocument>;
  updatedAt: string;
}

interface LegacyAuditWhitelistStore {
  version?: 1;
  sourcePath?: unknown;
  lines?: unknown;
  updatedAt?: unknown;
}

function normalizedLines(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(Number)
    .filter((line) => Number.isInteger(line) && line > 0))]
    .sort((left, right) => left - right);
}

function normalizedDocumentId(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
}

function normalizedSourcePath(value: unknown): string {
  return typeof value === "string" && value.trim() && path.isAbsolute(value)
    ? path.resolve(value)
    : "";
}

function documentKey(documentId: string, sourcePath: string): string {
  const key = normalizedDocumentId(documentId) || normalizedSourcePath(sourcePath).replace(/\\/g, "/");
  if (!key) throw new Error("An audit whitelist document id or absolute source path is required.");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function documentRecord(value: unknown, fallbackKey: string, fallbackUpdatedAt: string): AuditWhitelistDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Audit whitelist document ${fallbackKey} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const documentId = normalizedDocumentId(raw.documentId);
  const sourcePath = normalizedSourcePath(raw.sourcePath);
  if (!documentId && !sourcePath) {
    throw new Error(`Audit whitelist document ${fallbackKey} is missing its identity.`);
  }
  return {
    documentId,
    sourcePath,
    lines: normalizedLines(raw.lines),
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : fallbackUpdatedAt
  };
}

function normalizeStore(value: unknown, now: string): AuditWhitelistStore {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    return { version: 2, documents: {}, updatedAt: now };
  }
  const raw = value as Record<string, unknown>;
  if (raw.version === 2) {
    if (!raw.documents || typeof raw.documents !== "object" || Array.isArray(raw.documents)) {
      throw new Error("Audit whitelist version 2 requires a documents map.");
    }
    const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : now;
    const documents: Record<string, AuditWhitelistDocument> = {};
    for (const [key, item] of Object.entries(raw.documents as Record<string, unknown>)) {
      const record = documentRecord(item, key, updatedAt);
      documents[documentKey(record.documentId, record.sourcePath)] = record;
    }
    return { version: 2, documents, updatedAt };
  }
  const legacy = raw as LegacyAuditWhitelistStore;
  if (legacy.version !== undefined && legacy.version !== 1) {
    throw new Error(`Unsupported audit whitelist version: ${String(legacy.version)}.`);
  }
  const sourcePath = normalizedSourcePath(legacy.sourcePath);
  if (!sourcePath) return { version: 2, documents: {}, updatedAt: now };
  const updatedAt = typeof legacy.updatedAt === "string" && legacy.updatedAt ? legacy.updatedAt : now;
  const record: AuditWhitelistDocument = {
    documentId: "",
    sourcePath,
    lines: normalizedLines(legacy.lines),
    updatedAt
  };
  return {
    version: 2,
    documents: { [documentKey("", sourcePath)]: record },
    updatedAt
  };
}

export function mergeAuditWhitelistDocument(
  current: unknown,
  input: { documentId?: string; sourcePath?: string; lines?: number[] },
  now = new Date().toISOString()
): AuditWhitelistStore {
  const store = normalizeStore(current, now);
  const documentId = normalizedDocumentId(input.documentId);
  const sourcePath = normalizedSourcePath(input.sourcePath);
  const key = documentKey(documentId, sourcePath);
  for (const [existingKey, existing] of Object.entries(store.documents)) {
    const sameDocument = Boolean(documentId && normalizedDocumentId(existing.documentId) === documentId);
    const existingSourcePath = normalizedSourcePath(existing.sourcePath);
    const sameSource = Boolean(
      sourcePath
      && existingSourcePath
      && documentKey("", existingSourcePath) === documentKey("", sourcePath)
    );
    if ((sameDocument || sameSource) && existingKey !== key) delete store.documents[existingKey];
  }
  store.documents[key] = {
    documentId,
    sourcePath,
    lines: normalizedLines(input.lines),
    updatedAt: now
  };
  store.updatedAt = now;
  return store;
}
