/** Host-owned PDF protections, never editable project regex settings. */
export interface PdfProtectedLine { line: number; kind: "code" | "math" | "reference"; text: string }
/** Reserved projection markers identify native ink; prose remains writable. */
export function pdfInlineTokens(text: string): string[] {
  return text.match(/\{\{(?:formula|code):p\d+:\d+\}\}/gu) ?? [];
}
export function splitPdfInlineTranslation(source: string, candidate: string): string[] {
  const expected = pdfInlineTokens(source), actual = pdfInlineTokens(candidate);
  const expectedCounts = new Map<string,number>();
  for (const token of expected) expectedCounts.set(token,(expectedCounts.get(token)??0)+1);
  for (const token of actual) expectedCounts.set(token,(expectedCounts.get(token)??0)-1);
  if (expected.length !== actual.length || [...expectedCounts.values()].some(count=>count!==0)) {
    throw new Error('PDF inline code/formula markers must retain their exact identity and count within their source paragraph.');
  }
  const parts: string[] = []; let cursor=0;
  for (const token of actual) {
    const at=candidate.indexOf(token,cursor); parts.push(candidate.slice(cursor,at));cursor=at+token.length;
  }
  parts.push(candidate.slice(cursor));
  if (expected.length && /[\p{L}\p{N}]/u.test(source.replace(/\{\{(?:formula|code):p\d+:\d+\}\}/gu,''))
    && !parts.some(part=>/[\p{L}\p{N}]/u.test(part))) throw new Error('PDF paragraph contains only protected markers; its prose is still missing.');
  return parts;
}
export const PDF_PRESERVATION_INSTRUCTIONS = "PDF inline {{formula:pN:id}} and {{code:pN:id}} markers identify immutable native glyphs. Keep their exact identity and count within the complete translated source paragraph; markers may be reordered within that paragraph to match the translation. Never move a marker into another paragraph. Translate surrounding prose without completing another paragraph. Whole PDF code, mathematical formulas and References/Bibliography sections are immutable rows prepared by the Host. They are read-only context, excluded from writable sourceBlocks and translatableLines; never submit or copy them as model translations. The Host retains their original text and physical line positions, including comments, spacing and symbols. Do not flag their preserved source language as untranslated, change them during proofreading, or apply glossary substitutions to them. Translate only the surrounding prose; the Host enforces this rule independently of editable regex settings.";

/** Some older range APIs report local findings; rebase only their protection identities. */
export function localPdfProtectedLines(lines: PdfProtectedLine[] | undefined, fromLine: number): PdfProtectedLine[] | undefined {
  return lines?.filter(entry => entry.line >= fromLine).map(entry => ({ ...entry, line: entry.line - fromLine + 1 }));
}

export function hasPdfTaskSource(sourcePath?: string, documents?: Array<{projection?: {kind: string}}>): boolean {
  return /\.pdf$|[\\/]\.translation-workshop[\\/]extracted-text[\\/][^\\/]+-pdf-[a-f0-9]{16}(?:-v\d+)?(?:-e\d+)?[\\/]source[\\/]/i.test(sourcePath ?? "")
    || Boolean(documents?.some(document => document.projection?.kind === "pdf-text"));
}
