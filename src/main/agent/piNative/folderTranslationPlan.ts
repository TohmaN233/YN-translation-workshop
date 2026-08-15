import type { PiTranslationSubagentTask } from "./subagentRunner.ts";
import type { PiSourceDocument } from "./sourceManifest.ts";

export interface ScheduledTranslationTask extends PiTranslationSubagentTask {
  scheduleStage: number;
}

export interface CompletedTranslationRange {
  fromLine: number;
  toLine: number;
}

export function subtractCompletedTranslationRanges(
  tasks: ScheduledTranslationTask[],
  completedByDocument: Map<string, CompletedTranslationRange[]>
): ScheduledTranslationTask[] {
  return tasks.flatMap((task) => {
    const documentId = task.documentId;
    if (!documentId) return [task];
    const completed = [...(completedByDocument.get(documentId) ?? [])]
      .filter((range) => range.toLine >= task.fromLine && range.fromLine <= task.toLine)
      .sort((left, right) => left.fromLine - right.fromLine || left.toLine - right.toLine);
    if (completed.length === 0) return [task];

    const remaining: ScheduledTranslationTask[] = [];
    let cursor = task.fromLine;
    for (const range of completed) {
      const fromLine = Math.max(task.fromLine, range.fromLine);
      const toLine = Math.min(task.toLine, range.toLine);
      if (fromLine > cursor) {
        remaining.push({
          ...task,
          fromLine: cursor,
          toLine: fromLine - 1,
          label: `${documentId} L${cursor}-${fromLine - 1}`
        });
      }
      cursor = Math.max(cursor, toLine + 1);
      if (cursor > task.toLine) break;
    }
    if (cursor <= task.toLine) {
      remaining.push({
        ...task,
        fromLine: cursor,
        toLine: task.toLine,
        label: `${documentId} L${cursor}-${task.toLine}`
      });
    }
    return remaining;
  });
}

export function formatFolderTranslationOrder(documentIds: string[]): string {
  return [
    "{",
    ...[...documentIds].sort((left, right) => left.localeCompare(right, "en")).map((id) => JSON.stringify(id)),
    "}"
  ].join("\n");
}

function parseDocumentLine(line: string, lineNumber: number): string {
  const trimmed = line.trim();
  if (!trimmed) throw new Error(`Folder translation order line ${lineNumber} is empty.`);
  if (trimmed.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Folder translation order line ${lineNumber} is not a valid JSON string.`);
    }
    if (typeof parsed !== "string" || !parsed.trim()) {
      throw new Error(`Folder translation order line ${lineNumber} must name one file.`);
    }
    return parsed.trim().replace(/\\/g, "/");
  }
  return trimmed.replace(/\\/g, "/");
}

export function parseFolderTranslationOrder(spec: string | undefined, documentIds: string[]): Map<string, number> {
  const normalizedIds = [...documentIds].map((id) => id.replace(/\\/g, "/"));
  const known = new Set(normalizedIds);
  const lines = (spec?.trim() || formatFolderTranslationOrder(normalizedIds)).split(/\r?\n/);
  const result = new Map<string, number>();
  let stage = 0;
  let insideParallel = false;
  let parallelSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    if (line === "{") {
      if (insideParallel || parallelSeen) throw new Error("Folder translation order supports exactly one parallel group.");
      insideParallel = true;
      parallelSeen = true;
      continue;
    }
    if (line === "}") {
      if (!insideParallel) throw new Error("Folder translation order has an unmatched closing brace.");
      insideParallel = false;
      stage += 1;
      continue;
    }
    const id = parseDocumentLine(line, index + 1);
    if (!known.has(id)) throw new Error(`Folder translation order names an unknown file: ${id}.`);
    if (result.has(id)) throw new Error(`Folder translation order names ${id} more than once.`);
    result.set(id, stage);
    if (!insideParallel) stage += 1;
  }
  if (insideParallel) throw new Error("Folder translation order is missing a closing brace.");
  if (result.size === 0) {
    throw new Error("Folder translation order must retain at least one file; remove only the files that should be skipped.");
  }
  return result;
}

export function planFolderTranslationTasks(args: {
  documents: PiSourceDocument[];
  splitSize: number;
  order?: string;
}): ScheduledTranslationTask[] {
  if (!Number.isInteger(args.splitSize) || args.splitSize < 1) {
    throw new Error(`Translation splitSize must be a positive integer, received ${args.splitSize}.`);
  }
  const stages = parseFolderTranslationOrder(args.order, args.documents.map((document) => document.id));
  return args.documents.filter((document) => stages.has(document.id)).flatMap((document) => {
    const tasks: ScheduledTranslationTask[] = [];
    for (let fromLine = 1; fromLine <= document.lineCount; fromLine += args.splitSize) {
      const toLine = Math.min(document.lineCount, fromLine + args.splitSize - 1);
      tasks.push({
        documentId: document.id,
        fromLine,
        toLine,
        label: `${document.id} L${fromLine}-${toLine}`,
        scheduleStage: stages.get(document.id)!
      });
    }
    return tasks;
  }).sort((left, right) => left.scheduleStage - right.scheduleStage
    || (right.toLine - right.fromLine) - (left.toLine - left.fromLine)
    || left.documentId!.localeCompare(right.documentId!, "en")
    || left.fromLine - right.fromLine);
}
