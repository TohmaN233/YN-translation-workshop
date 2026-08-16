import type {
  TranslationValidationResult,
  ValidationFinding
} from "../../../shared/validation/translationValidator.ts";

const MAX_VALIDATION_FINDING_SAMPLES = 24;
const MAX_VALIDATION_LINE_RANGES = 128;

const YN_TRANSLATION_STRUCTURAL_WARNING_CODES = new Set([
  "empty_line_displaced",
  "likely_untranslated"
]);

export interface YnTranslationArtifactAcceptanceOptions {
  acceptedQualityWarningKeys?: ReadonlySet<string>;
}

export function ynTranslationQualityWarningKey(finding: ValidationFinding): string | undefined {
  return Number.isInteger(finding.line) && Number(finding.line) > 0
    ? `${Number(finding.line)}\0${finding.code}`
    : undefined;
}

function selectedWarnings(
  validation: TranslationValidationResult,
  codes: ReadonlySet<string>
): ValidationFinding[] {
  return validation.warnings.filter((finding) => codes.has(finding.code));
}

export function ynTranslationQualityWarnings(
  validation: TranslationValidationResult,
  options: YnTranslationArtifactAcceptanceOptions = {}
): ValidationFinding[] {
  // Every warning is semantic post-translation review work. Keeping this
  // unfiltered prevents a newly added validator warning code from silently
  // bypassing the final review contract.
  return validation.warnings.filter((finding) => {
    const key = ynTranslationQualityWarningKey(finding);
    return !key || !options.acceptedQualityWarningKeys?.has(key);
  });
}

export function ynTranslationStructuralWarnings(
  validation: TranslationValidationResult
): ValidationFinding[] {
  return selectedWarnings(validation, YN_TRANSLATION_STRUCTURAL_WARNING_CODES);
}

export function ynTranslationValidationDebt(
  validation: TranslationValidationResult,
  acceptance: "artifact" | "chunk" = "artifact",
  options: YnTranslationArtifactAcceptanceOptions = {}
): number {
  const warnings = acceptance === "artifact"
    ? ynTranslationQualityWarnings(validation, options)
    : ynTranslationStructuralWarnings(validation);
  return validation.blocking.length + warnings.length;
}

export function isYnTranslationArtifactAccepted(
  validation: TranslationValidationResult,
  _options: YnTranslationArtifactAcceptanceOptions = {}
): boolean {
  return validation.ok;
}

export function isYnTranslationWarningReviewComplete(
  validation: TranslationValidationResult,
  options: YnTranslationArtifactAcceptanceOptions = {}
): boolean {
  return ynTranslationQualityWarnings(validation, options).length === 0;
}

export function isYnTranslationChunkWritable(validation: TranslationValidationResult): boolean {
  return validation.ok && ynTranslationStructuralWarnings(validation).length === 0;
}

function findingCounts(findings: ValidationFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  return counts;
}

function compactLineRanges(findings: ValidationFinding[]): {
  ranges: string[];
  omittedRangeCount: number;
} {
  const lines = [...new Set(findings.flatMap((finding) => (
    Number.isInteger(finding.line) && Number(finding.line) > 0 ? [Number(finding.line)] : []
  )))].sort((left, right) => left - right);
  const allRanges: string[] = [];
  for (let index = 0; index < lines.length;) {
    const start = lines[index];
    let end = start;
    while (index + 1 < lines.length && lines[index + 1] === end + 1) {
      end = lines[++index];
    }
    allRanges.push(start === end ? String(start) : `${start}-${end}`);
    index += 1;
  }
  return {
    ranges: allRanges.slice(0, MAX_VALIDATION_LINE_RANGES),
    omittedRangeCount: Math.max(0, allRanges.length - MAX_VALIDATION_LINE_RANGES)
  };
}

function findingSample(findings: ValidationFinding[]) {
  return findings.slice(0, MAX_VALIDATION_FINDING_SAMPLES).map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    ...(finding.line ? { line: finding.line } : {}),
    detail: finding.detail
  }));
}

export function compactYnTranslationValidation(
  validation: TranslationValidationResult,
  acceptance: "artifact" | "chunk" = "artifact",
  options: YnTranslationArtifactAcceptanceOptions = {}
) {
  const allQualityWarnings = ynTranslationQualityWarnings(validation);
  const qualityWarnings = ynTranslationQualityWarnings(validation, options);
  const structuralWarnings = ynTranslationStructuralWarnings(validation);
  const qualityDebt = acceptance === "artifact" ? qualityWarnings : [];
  const actionable = acceptance === "artifact"
    ? [...validation.blocking, ...qualityDebt]
    : [...validation.blocking, ...structuralWarnings];
  const blockingLines = compactLineRanges(validation.blocking);
  const warningLines = compactLineRanges(validation.warnings);
  const qualityDebtLines = compactLineRanges(qualityDebt);
  return {
    ok: validation.ok,
    accepted: acceptance === "artifact"
      ? isYnTranslationArtifactAccepted(validation, options)
      : isYnTranslationChunkWritable(validation),
    warningReviewComplete: acceptance !== "artifact" || qualityDebt.length === 0,
    summary: validation.summary,
    sourceLineCount: validation.sourceLineCount,
    candidateLineCount: validation.candidateLineCount,
    blockingCount: validation.blocking.length,
    warningCount: validation.warnings.length,
    qualityWarningCount: allQualityWarnings.length,
    qualityDebtCount: qualityDebt.length,
    warningReviewDebtCount: qualityDebt.length,
    blockingByCode: findingCounts(validation.blocking),
    warningByCode: findingCounts(validation.warnings),
    warningLineRanges: warningLines.ranges,
    omittedWarningRangeCount: warningLines.omittedRangeCount,
    blockingLineRanges: blockingLines.ranges,
    omittedBlockingRangeCount: blockingLines.omittedRangeCount,
    qualityDebtLineRanges: qualityDebtLines.ranges,
    warningReviewDebtLineRanges: qualityDebtLines.ranges,
    omittedQualityDebtRangeCount: qualityDebtLines.omittedRangeCount,
    findingSamples: findingSample(actionable),
    warningSamples: findingSample(validation.warnings),
    omittedFindingCount: Math.max(0, actionable.length - MAX_VALIDATION_FINDING_SAMPLES),
    styleScore: validation.styleScore,
    voiceScore: validation.voiceScore
  };
}

export function assertYnTranslationChunkWritable(
  validation: TranslationValidationResult,
  scope: string
): void {
  const structuralWarnings = ynTranslationStructuralWarnings(validation);
  if (isYnTranslationChunkWritable(validation)) return;
  const findings = [...validation.blocking, ...structuralWarnings];
  const lines = compactLineRanges(findings);
  const samples = findingSample(findings);
  throw new Error([
    `${scope} validation failed: ${validation.summary}`,
    lines.ranges.length > 0 ? `Affected lines: ${lines.ranges.join(", ")}` : "",
    ...samples.map((finding) => finding.detail),
    findings.length > samples.length ? `${findings.length - samples.length} additional findings omitted.` : ""
  ].filter(Boolean).join("\n"));
}

export function assertYnTranslationArtifactAccepted(
  validation: TranslationValidationResult,
  scope: string
): void {
  if (validation.ok) return;
  const findings = [...validation.blocking];
  const lines = compactLineRanges(findings);
  const samples = findingSample(findings);
  throw new Error([
    `${scope} validation failed: ${validation.summary}`,
    lines.ranges.length > 0 ? `Affected lines: ${lines.ranges.join(", ")}` : "",
    ...samples.map((finding) => finding.detail),
    findings.length > samples.length ? `${findings.length - samples.length} additional findings omitted.` : ""
  ].filter(Boolean).join("\n"));
}
