import path from "node:path";
import { realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT, NodeExecutionEnv, validateCommittedWrites } from "@earendil-works/pi-agent-core/node";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeInteger = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const unwrap = (result, action) => {
  if (!result.ok) throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
  return result.value;
};

function parseHeader(line, filePath) {
  const header = JSON.parse(line);
  if (!record(header) || typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new Error(`Invalid Pi session header identity: ${filePath}`);
  }
  if (header.type === "session" && header.version === 3
    && typeof header.timestamp === "string" && Number.isFinite(Date.parse(header.timestamp))
    && (header.parentSession === undefined || typeof header.parentSession === "string")) return header;
  if (header.kind === "header" && header.v === 4 && header.storageVersion === 1
    && safeInteger(header.createdAt, 0)
    && (header.nextSeq === undefined || safeInteger(header.nextSeq, 1))
    && (header.parentSessionId === undefined || typeof header.parentSessionId === "string")
    && (header.legacyParentSessionPath === undefined || typeof header.legacyParentSessionPath === "string")) return header;
  throw new Error(`Unsupported Pi session format in ${filePath}; expected legacy v3 or native v4/storage 1.`);
}

async function openReader(filePath) {
  const environment = new NodeExecutionEnv({ cwd: path.dirname(filePath) });
  return unwrap(await environment.openTextLineReader(filePath, BACKGROUND_CONTEXT), `Cannot read ${filePath}`);
}

async function headerLine(reader, filePath) {
  const line = unwrap(await reader.readLine(BACKGROUND_CONTEXT), `Cannot read header ${filePath}`);
  if (!line?.terminated || !line.text.trim()) throw new Error(`Missing complete Pi session header: ${filePath}`);
  return { header: parseHeader(line.text, filePath), bytes: Buffer.byteLength(line.text) };
}

export async function readPiSessionHeader(filePath) {
  const reader = await openReader(filePath);
  try { return (await headerLine(reader, filePath)).header; }
  finally { await reader.close(BACKGROUND_CONTEXT); }
}

function validateWrite(write) {
  if (!record(write) || !safeInteger(write.seq, 1)) throw new Error("Invalid native Pi transaction sequence.");
  if (write.kind === "value" || write.kind === "list") {
    if (typeof write.namespace !== "string" || !write.namespace || typeof write.key !== "string"
      || write.namespace.includes("\0") || write.key.includes("\0")
      || !(write.kind === "value" ? ["set", "delete"] : ["append", "delete"]).includes(write.op)
      || (["set", "append"].includes(write.op) && !("value" in write))) {
      throw new Error(`Invalid native Pi ${write.kind} write.`);
    }
    return;
  }
  if (typeof write.id !== "string" || !write.id) throw new Error("Invalid native Pi entry/usage ID.");
  if (write.kind === "usage") {
    if (!record(write.usage) || typeof write.adjustment !== "boolean") throw new Error("Invalid native Pi usage write.");
    return;
  }
  if (write.kind !== "entry" || !safeInteger(write.timestamp, 0)
    || !(write.parentId === null || typeof write.parentId === "string")) {
    throw new Error("Invalid native Pi transaction entry.");
  }
  switch (write.type) {
    case "message":
      if (!record(write.message) || typeof write.message.role !== "string") throw new Error("Invalid native Pi message entry.");
      break;
    case "custom":
      if (typeof write.customType !== "string") throw new Error("Invalid native Pi custom entry.");
      break;
    case "compaction":
      if (typeof write.summary !== "string" || !Array.isArray(write.retainedTail)
        || !Number.isFinite(write.tokensBefore) || typeof write.fromHook !== "boolean") throw new Error("Invalid native Pi compaction entry.");
      break;
    case "branch_summary":
      if (typeof write.summary !== "string" || !(write.fromId === null || typeof write.fromId === "string")
        || typeof write.fromHook !== "boolean") throw new Error("Invalid native Pi branch summary entry.");
      break;
    default: throw new Error(`Unsupported native Pi entry type: ${String(write.type)}`);
  }
}

/** Read audit entries without opening writable native storage or expanding retainedTail. */
export async function* readPiSessionEntries(filePath) {
  const reader = await openReader(filePath);
  try {
    const { header, bytes } = await headerLine(reader, filePath);
    const native = header.v === 4;
    yield { entry: native ? { ...header, type: "session", version: 4, timestamp: new Date(header.createdAt).toISOString() } : header, bytes };
    const ids = new Set();
    const entryIds = new Set();
    let nextSeq = 1;
    let lineNumber = 1;
    while (true) {
      const line = unwrap(await reader.readLine(BACKGROUND_CONTEXT), `Cannot read ${filePath}`);
      // Pi commits newline-terminated records. A live append's unfinished tail
      // is not committed yet; never repair or rewrite it from a diagnostic.
      if (!line || !line.terminated) break;
      lineNumber += 1;
      if (!line.text.trim()) continue;
      try {
        const parsed = JSON.parse(line.text);
        if (!native) {
          if (!record(parsed) || !["message", "custom", "custom_message", "branch_summary", "compaction", "model_change",
            "thinking_level_change", "active_tools_change", "session_info", "label"].includes(parsed.type)) {
            throw new Error(`Unsupported legacy Pi entry type: ${String(parsed?.type)}`);
          }
          const entry = parsed.type === "custom_message" ? { ...parsed, type: "message", message: {
            role: "custom", customType: parsed.customType, content: parsed.content, details: parsed.details,
            display: parsed.display, timestamp: Date.parse(parsed.timestamp)
          } } : parsed;
          yield { entry, bytes: Buffer.byteLength(line.text) };
          continue;
        }
        const writes = Array.isArray(parsed) ? parsed : [parsed];
        if (!writes.length) throw new Error("Empty native Pi transaction.");
        for (const write of writes) validateWrite(write);
        validateCommittedWrites(writes, nextSeq, {
          hasEntryOrUsageId: (id) => ids.has(id), hasEntryId: (id) => entryIds.has(id)
        });
        for (const write of writes) {
          nextSeq = write.seq + 1;
          if (write.kind === "entry" || write.kind === "usage") ids.add(write.id);
          if (write.kind !== "entry") continue;
          entryIds.add(write.id);
          yield { entry: { ...write, timestamp: new Date(write.timestamp).toISOString() }, bytes: Buffer.byteLength(JSON.stringify(write)) };
        }
      } catch (error) {
        throw new Error(`Invalid Pi JSONL ${filePath}: line ${lineNumber}: ${error.message}`, { cause: error });
      }
    }
  } finally { await reader.close(BACKGROUND_CONTEXT); }
}

const normalizedPath = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export async function isPiChildOf(childPath, parentPath, parentHeader) {
  const child = await readPiSessionHeader(childPath);
  if (normalizedPath(child.cwd) !== normalizedPath(parentHeader.cwd)) return false;
  if (child.v === 4 && child.parentSessionId !== undefined) return child.parentSessionId === parentHeader.id;
  const legacyPath = child.v === 4 ? child.legacyParentSessionPath : child.parentSession;
  if (typeof legacyPath !== "string" || normalizedPath(legacyPath) !== normalizedPath(parentPath)) return false;
  const [actualLegacy, actualParent] = await Promise.all([realpath(legacyPath), realpath(parentPath)]);
  if (normalizedPath(actualLegacy) !== normalizedPath(actualParent)) return false;
  const currentParent = await readPiSessionHeader(actualParent);
  if (currentParent.id !== parentHeader.id || normalizedPath(currentParent.cwd) !== normalizedPath(parentHeader.cwd)) {
    throw new Error(`Legacy Pi child parent identity changed: ${parentPath}`);
  }
  return true;
}
