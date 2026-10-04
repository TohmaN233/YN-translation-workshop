import { validateTranslationCandidate, type ValidationFinding, type ValidationOptions } from "./translationValidator.ts";

/** Only structural translation invariants gate a proofreading replacement. */
export function validateProofreadReplacement(
  sourceText: string,
  suggestedFix: string,
  options: Pick<ValidationOptions, "customPreserveRules" | "extractPlaceholders" | "extractTags" | "locale"> = {},
  line = 1
): ValidationFinding[] {
  // A replacement is one physical row, including at its trailing boundary.
  // The full-file validator intentionally tolerates a final file newline.
  if (/[\r\n]/u.test(suggestedFix)) {
    return [{ code: "line_count_mismatch", severity: "blocking", line,
      detail: `Line ${line}: suggestedFix must be one complete replacement row without physical newlines.` }];
  }
  return validateTranslationCandidate(sourceText, suggestedFix, { ...options, detectUntranslated: false })
    .blocking.filter(finding => (
      finding.code === "placeholder_mismatch"
      || finding.code === "custom_preserve_mismatch" || finding.code === "tag_mismatch"
    )).map(finding => ({
      ...finding,
      line,
      detail: finding.detail.replace(/第 1 行/g, `第 ${line} 行`)
        .replace(/\b([Ll]ine) 1\b/g, `$1 ${line}`)
    }));
}
