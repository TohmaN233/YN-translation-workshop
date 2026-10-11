/** Host-owned PDF protections, never editable project regex settings. */
export interface PdfProtectedLine { line: number; kind: "code" | "math"; text: string }
export const PDF_PRESERVATION_INSTRUCTIONS = "PDF code and mathematical formulas are not translatable. Host-protected PDF rows must be copied exactly, including comments, spacing and symbols. Do not flag their preserved source language as untranslated, change them during proofreading, or apply glossary substitutions to them. Translate only the surrounding prose; the Host enforces this rule independently of editable regex settings.";

/** Some older range APIs report local findings; rebase only their protection identities. */
export function localPdfProtectedLines(lines: PdfProtectedLine[] | undefined, fromLine: number): PdfProtectedLine[] | undefined {
  return lines?.filter(entry => entry.line >= fromLine).map(entry => ({ ...entry, line: entry.line - fromLine + 1 }));
}

export function hasPdfTaskSource(sourcePath?: string, documents?: Array<{projection?: {kind: string}}>): boolean {
  return /\.pdf$|[\\/]\.translation-workshop[\\/]extracted-text[\\/][^\\/]+-pdf-[a-f0-9]{16}(?:-v\d+)?[\\/]source[\\/]/i.test(sourcePath ?? "")
    || Boolean(documents?.some(document => document.projection?.kind === "pdf-text"));
}
