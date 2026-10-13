import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeTextFileAtomically } from "../../atomicFile.ts";
import { translationAlignmentInputHash, translationAlignmentLinesInputHash, translationReviewSourceHash, type TranslationAlignmentRangeState } from "./translationAlignmentState.ts";
import type { PdfProtectedLine } from "../../../shared/validation/pdfPreservation.ts";

function rangeHash(scope: TranslationAlignmentRangeState, sources: string[], candidates: string[], languagePair?: string): string {
  const source = sources.slice(scope.fromLine - 1, scope.toLine), candidate = candidates.slice(scope.fromLine - 1, scope.toLine);
  return scope.lineHashVersion === 2
    ? translationAlignmentLinesInputHash(source, candidate, languagePair)
    : translationAlignmentInputHash(source.join("\n"), candidate.join("\n"), languagePair);
}

// A write-ahead receipt is derived evidence for one existing Host range, not a
// new task. Its before-image contains only the protected rows the Host changes.
export async function preparePdfProtectionReceipt(args: {
  outputDir: string; scope: TranslationAlignmentRangeState; candidatePath: string;
  sourceLines: string[]; beforeLines: string[]; afterLines: string[]; languagePair?: string;
}): Promise<string> {
  const rows = args.beforeLines.slice(args.scope.fromLine - 1, args.scope.toLine)
    .flatMap((before, index) => {
      const line = args.scope.fromLine + index, after = args.afterLines[line - 1];
      return before === after ? [] : [{ line, before, after }];
    });
  if (!rows.length) throw new Error("PDF protection receipt requires changed protected rows.");
  const directory = path.join(args.outputDir, ".translation-workshop", "agent", "recovery-transactions");
  await mkdir(directory, { recursive: true });
  const receiptPath = path.join(directory, `pdf-protection-${randomUUID()}.json`);
  const candidatePath = path.relative(path.resolve(args.outputDir), path.resolve(args.candidatePath));
  if (path.isAbsolute(candidatePath) || candidatePath === ".." || candidatePath.startsWith(`..${path.sep}`)) throw new Error("PDF protection candidate is outside its project.");
  await writeTextFileAtomically(receiptPath, `${JSON.stringify({ schemaVersion: 1, kind: "pdf_protection", phase: "prepared",
    candidatePath, documentId: args.scope.documentId, auditId: args.scope.auditId,
    fromLine: args.scope.fromLine, toLine: args.scope.toLine, sourceLineCount: args.scope.sourceLineCount,
    sourceHash: translationReviewSourceHash(args.sourceLines.slice(args.scope.fromLine - 1, args.scope.toLine)),
    beforeHash: rangeHash(args.scope, args.sourceLines, args.beforeLines, args.languagePair),
    afterHash: rangeHash(args.scope, args.sourceLines, args.afterLines, args.languagePair), rows
  }, null, 2)}\n`);
  const handle = await open(receiptPath, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  return receiptPath;
}

export async function findPdfProtectionReceipt(args: {
  outputDir: string; scope: TranslationAlignmentRangeState; sourceLines: string[];
  candidateLines: string[]; protectedRows: PdfProtectedLine[]; languagePair?: string;
}): Promise<string | undefined> {
  const directory = path.join(args.outputDir, ".translation-workshop", "agent", "recovery-transactions");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const sourceHash = translationReviewSourceHash(args.sourceLines.slice(args.scope.fromLine - 1, args.scope.toLine));
  const actualHash = rangeHash(args.scope, args.sourceLines, args.candidateLines, args.languagePair);
  const protectedByLine = new Map(args.protectedRows.map(row => [row.line, row.text]));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("pdf-protection-") || !entry.name.endsWith(".json")) continue;
    const receiptPath = path.join(directory, entry.name);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.schemaVersion !== 1 || receipt.kind !== "pdf_protection" || receipt.phase !== "prepared"
      || typeof receipt.candidatePath !== "string" || path.isAbsolute(receipt.candidatePath)
      || path.resolve(args.outputDir, receipt.candidatePath) !== path.resolve(args.scope.candidatePath) || receipt.documentId !== args.scope.documentId
      || receipt.auditId !== args.scope.auditId || receipt.fromLine !== args.scope.fromLine || receipt.toLine !== args.scope.toLine
      || receipt.sourceLineCount !== args.scope.sourceLineCount || receipt.sourceHash !== sourceHash
      || receipt.beforeHash !== args.scope.inputHash || receipt.afterHash !== actualHash) continue;
    if (!Array.isArray(receipt.rows) || !receipt.rows.length) throw new Error(`Invalid PDF protection receipt: ${receiptPath}`);
    const before = [...args.candidateLines], seen = new Set<number>();
    for (const row of receipt.rows) {
      if (!Number.isInteger(row.line) || row.line < args.scope.fromLine || row.line > args.scope.toLine || seen.has(row.line)
        || typeof row.before !== "string" || typeof row.after !== "string" || /[\r\n]/.test(row.before + row.after)
        || protectedByLine.get(row.line) !== row.after || args.candidateLines[row.line - 1] !== row.after) {
        throw new Error(`Unverifiable PDF protection receipt: ${receiptPath}`);
      }
      seen.add(row.line); before[row.line - 1] = row.before;
    }
    if (rangeHash(args.scope, args.sourceLines, before, args.languagePair) !== args.scope.inputHash) {
      throw new Error(`PDF protection receipt does not reconstruct the original review proof: ${receiptPath}`);
    }
    return receiptPath;
  }
  return undefined;
}
