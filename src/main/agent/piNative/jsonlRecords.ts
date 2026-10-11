import { createReadStream } from "node:fs";
import { BACKGROUND_CONTEXT, validateCommittedWrites, type Context, type CommittedWrite } from "@earendil-works/pi-agent-core/node";

export interface NativeJsonlHeader {
  kind: "header"; v: 4; storageVersion: 1; id: string; cwd: string; createdAt: number;
  nextSeq?: number; parentSessionId?: string; legacyParentSessionPath?: string;
}
export class TornJsonlTailError extends Error {
  readonly code = "PI_JSONL_TORN_TAIL";
  readonly path: string;
  readonly committedBytes: number;
  readonly tailBytes: number;
  constructor(path: string, committedBytes: number, tailBytes: number) {
    super(`Uncommitted Pi JSONL tail in ${path}: ${tailBytes} bytes after offset ${committedBytes}; exclusive recovery is required before appending.`);
    this.name = "TornJsonlTailError";
    this.path = path; this.committedBytes = committedBytes; this.tailBytes = tailBytes;
  }
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, minimum: number): v is number => Number.isSafeInteger(v) && (v as number) >= minimum;
export function parseNativeHeader(text: string): NativeJsonlHeader {
  const v: unknown = JSON.parse(text);
  if (!record(v) || v.kind !== "header" || v.v !== 4 || v.storageVersion !== 1 || typeof v.id !== "string"
    || typeof v.cwd !== "string" || !integer(v.createdAt, 0)
    || (v.nextSeq !== undefined && !integer(v.nextSeq, 1))
    || (v.parentSessionId !== undefined && typeof v.parentSessionId !== "string")
    || (v.legacyParentSessionPath !== undefined && typeof v.legacyParentSessionPath !== "string")) {
    throw new Error("Unsupported Pi JSONL header; expected native v4/storage 1.");
  }
  return v as unknown as NativeJsonlHeader;
}
/** Schema checks complement Pi's authoritative sequence/id/parent validator. */
export function parseNativeTransaction(text: string): CommittedWrite[] {
  const value: unknown = JSON.parse(text);
  const writes = Array.isArray(value) ? value : [value];
  if (writes.length === 0) throw new Error("Empty Pi JSONL transaction.");
  for (const w of writes) {
    if (!record(w) || !integer(w.seq, 1)) throw new Error("Invalid Pi JSONL write sequence.");
    if (w.kind === "value" || w.kind === "list") {
      if (typeof w.namespace !== "string" || !w.namespace || typeof w.key !== "string"
        || w.namespace.includes("\0") || w.key.includes("\0")
        || !(w.kind === "value" ? ["set", "delete"] : ["append", "delete"]).includes(String(w.op))
        || (["set", "append"].includes(String(w.op)) && !("value" in w))) throw new Error("Invalid Pi JSONL value/list write.");
      continue;
    }
    if (typeof w.id !== "string" || !w.id) throw new Error("Invalid Pi JSONL entry/usage id.");
    if (w.kind === "usage") {
      const usage = w.usage;
      const cost = record(usage) ? usage.cost : undefined;
      if (!record(usage) || !record(cost) || typeof w.adjustment !== "boolean"
        || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(k => Number.isFinite(usage[k]))
        || !["input", "output", "cacheRead", "cacheWrite", "total"].every(k => Number.isFinite(cost[k]))) {
        throw new Error("Invalid Pi JSONL usage write.");
      }
      continue;
    }
    if (w.kind !== "entry" || !integer(w.timestamp, 0) || !(w.parentId === null || typeof w.parentId === "string")) throw new Error("Invalid Pi JSONL entry.");
    switch (w.type) {
      case "message": if (!record(w.message) || typeof w.message.role !== "string") throw new Error("Invalid Pi message."); break;
      case "custom": if (typeof w.customType !== "string") throw new Error("Invalid Pi custom entry."); break;
      case "compaction": if (typeof w.summary !== "string" || !Array.isArray(w.retainedTail) || !Number.isFinite(w.tokensBefore) || typeof w.fromHook !== "boolean") throw new Error("Invalid Pi compaction."); break;
      case "branch_summary": if (typeof w.summary !== "string" || !(w.fromId === null || typeof w.fromId === "string") || typeof w.fromHook !== "boolean") throw new Error("Invalid Pi branch summary."); break;
      default: throw new Error(`Invalid Pi entry type: ${String(w.type)}`);
    }
  }
  return writes as CommittedWrite[];
}
export type JsonlRecord = ({ kind: "header"; header: NativeJsonlHeader } | { kind: "transaction"; writes: CommittedWrite[] })
  & { offset: number; length: number; lineNumber: number; bytes: Buffer };

/** Only one complete native transaction is decoded at a time. Byte offsets include CRLF/newline. */
export async function* readJsonlRecords(path: string, context: Context = BACKGROUND_CONTEXT): AsyncGenerator<JsonlRecord> {
  context.abortSignal?.throwIfAborted();
  const stream = createReadStream(path, { highWaterMark: 256 * 1024, signal: context.abortSignal });
  let fragments: Buffer[] = [], fragmentBytes = 0, offset = 0, lineNumber = 0, nextSeq = 1;
  const ids = new Set<string>(), entryIds = new Set<string>();
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let start = 0;
      while (start < buffer.length) {
        context.abortSignal?.throwIfAborted();
        const newline = buffer.indexOf(10, start);
        if (newline < 0) { fragments.push(buffer.subarray(start)); fragmentBytes += buffer.length - start; break; }
        const last = buffer.subarray(start, newline + 1);
        const bytes = fragments.length ? Buffer.concat([...fragments, last], fragmentBytes + last.length) : last;
        fragments = []; fragmentBytes = 0; lineNumber++;
        try {
          // Decode after complete byte assembly, so UTF-8 sequences spanning chunks survive.
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 1));
          if (lineNumber === 1) yield { kind: "header", header: parseNativeHeader(text), offset, length: bytes.length, lineNumber, bytes };
          else {
            const writes = parseNativeTransaction(text);
            validateCommittedWrites(writes, nextSeq, { hasEntryOrUsageId: id => ids.has(id), hasEntryId: id => entryIds.has(id) });
            for (const w of writes) {
              nextSeq = w.seq + 1;
              if (w.kind === "entry" || w.kind === "usage") ids.add(w.id);
              if (w.kind === "entry") entryIds.add(w.id);
            }
            yield { kind: "transaction", writes, offset, length: bytes.length, lineNumber, bytes };
          }
        } catch (error) {
          throw new Error(`Invalid Pi JSONL ${path}: line ${lineNumber} at byte ${offset}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        offset += bytes.length; start = newline + 1;
      }
    }
    context.abortSignal?.throwIfAborted();
    if (fragmentBytes > 0) throw new TornJsonlTailError(path, offset, fragmentBytes);
    if (lineNumber === 0) throw new Error(`Missing complete Pi JSONL header: ${path}`);
  } finally { stream.destroy(); }
}
