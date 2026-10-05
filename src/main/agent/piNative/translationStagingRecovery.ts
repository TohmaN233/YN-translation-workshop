import path from "node:path";
import { decodeProjectPaths } from "../../projectPaths.ts";
import { PiSessionRepository } from "./sessionRepository.ts";
import { readSessionEntries } from "./sessionAccess.ts";
import { translationAlignmentInputHash, translationAlignmentLinesInputHash, type TranslationAlignmentRangeState } from "./translationAlignmentState.ts";

const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Recover only an exact, hash-bound write acknowledged by the owning native child. */
export async function recoverErasedTranslationStaging(args: {
  outputDir: string;
  parentSessionId: string;
  scope: TranslationAlignmentRangeState;
  sourceLines: string[];
  languagePair?: string;
  signal?: AbortSignal;
}): Promise<{ lines: string[]; childSessionId: string; receiptEntryId: string } | undefined> {
  const { scope } = args;
  const stagingRoot = path.join(args.outputDir, ".translation-workshop", "agent", "translation-staging");
  const relative = path.relative(stagingRoot, scope.candidatePath);
  const segments = relative.split(path.sep);
  if (relative.startsWith("..") || path.isAbsolute(relative) || segments.length !== 3) return undefined;
  const childSessionId = segments[1];
  const repository = new PiSessionRepository(args.outputDir);
  try {
    const metadata = await repository.findChildMetadata(childSessionId);
    if (!metadata) return undefined;
    const session = await repository.openChildForParent(childSessionId, args.parentSessionId);
    const calls = new Map<string, { name: string; arguments: Record<string, any> }>();
    let sourceBlocks = new Map<string, number[]>();
    const values = new Map<number, string>();
    let recovered: { lines: string[]; childSessionId: string; receiptEntryId: string } | undefined;
    for (const entry of await readSessionEntries(session)) {
      args.signal?.throwIfAborted();
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { name: block.name, arguments: block.arguments });
        continue;
      }
      if (message.role !== "toolResult" || message.isError || !record(message.details)) continue;
      const details: Record<string, any> = message.details;
      if (message.toolName === "readAssignedSource") {
        sourceBlocks = new Map();
        if (details.assignment?.fromLine !== scope.fromLine || details.assignment?.toLine !== scope.toLine) continue;
        for (const block of details.sourceBlocks ?? []) {
          if (record(block) && typeof block.id === "string" && Array.isArray(block.absoluteLines)
            && block.absoluteLines.every((line: unknown) => Number.isInteger(line) && Number(line) >= scope.fromLine && Number(line) <= scope.toLine)) {
            sourceBlocks.set(block.id, block.absoluteLines);
          }
        }
        continue;
      }
      if (!["writeAssignedTranslation", "repairAssignedTranslation"].includes(message.toolName)) continue;
      const call = calls.get(message.toolCallId);
      const result = details.result;
      if (!call || call.name !== message.toolName || !record(result) || result.ok !== true || typeof result.path !== "string") continue;
      const rebound = decodeProjectPaths({ candidatePath: result.path }, args.outputDir, metadata.cwd).candidatePath;
      if (path.resolve(rebound).toLowerCase() !== path.resolve(scope.candidatePath).toLowerCase()
        || result.sourceLineCount !== scope.sourceLineCount || result.totalCandidateLines !== scope.sourceLineCount) continue;
      const invalidLines = new Set<number>(Array.isArray(details.invalidBlockLines) ? details.invalidBlockLines : []);
      const written = new Map<number, string>();
      for (const block of call.arguments.blocks ?? []) {
        if (!record(block) || !Array.isArray(block.lines)) continue;
        const lines = sourceBlocks.get(block.id);
        if (!lines) continue;
        const seen = new Set<number>();
        for (const text of block.lines) {
          if (typeof text !== "string" || /[\r\n]/u.test(text)) continue;
          const normalized = text.replace(/^[ \t]+/u, "");
          const index = parseInt(normalized[0], 36);
          const line = lines[index];
          if (line === undefined || seen.has(line) || invalidLines.has(line)) continue;
          seen.add(line);
          written.set(line, normalized.slice(1));
        }
      }
      for (const item of call.arguments.entries ?? []) {
        if (record(item) && Number.isInteger(item.line) && item.line >= scope.fromLine && item.line <= scope.toLine
          && typeof item.translation === "string" && !/[\r\n]/u.test(item.translation) && !invalidLines.has(item.line)) written.set(item.line, item.translation);
      }
      for (const [line, text] of written) values.set(line, text);
      const sources = args.sourceLines.slice(scope.fromLine - 1, scope.toLine);
      const candidates = sources.map((source, index) => values.get(scope.fromLine + index) ?? (source.trim() === "" ? "" : undefined));
      if (candidates.some((line) => line === undefined)) continue;
      const lines = candidates as string[];
      const hash = scope.lineHashVersion === 2
        ? translationAlignmentLinesInputHash(sources, lines, args.languagePair)
        : translationAlignmentInputHash(sources.join("\n"), lines.join("\n"), args.languagePair);
      if (hash === scope.inputHash) recovered = { lines, childSessionId, receiptEntryId: entry.id };
    }
    return recovered;
  } finally { await repository.close(); }
}
