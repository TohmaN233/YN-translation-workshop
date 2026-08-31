import {
  splitTextLines,
  validateTranslationCandidate,
  type ValidationCode,
  type ValidationOptions,
  type TranslationValidationResult
} from "../../../shared/validation/translationValidator.ts";
import { createTranslationAlignmentAudit } from "./translationAlignmentState.ts";

export interface ProofreadDeterministicSignal {
  line: number;
  code: "H3" | "H4" | "H7" | "H8" | "H9" | "M0";
  evidence: string;
}

export interface ProofreadPrescanProgress {
  phase: "validation" | "signals" | "alignment" | "complete";
  completedLines: number;
  totalLines: number;
}

export interface ProofreadPrescanSummary {
  completed: true;
  totalLines: number;
  signalCount: number;
  affectedLineCount: number;
  countsByCode: Record<ProofreadDeterministicSignal["code"], number>;
  recommendedWorkerCount: number;
  regionCounts: Record<"HOT" | "WARM" | "COLD", number>;
  highestRiskRegions: Array<{
    fromLine: number;
    toLine: number;
    affectedLineCount: number;
    density: number;
    tier: "HOT" | "WARM" | "COLD";
  }>;
}

const PROOFREAD_SIGNAL_CODES = ["H3", "H4", "H7", "H8", "H9", "M0"] as const;

const AI_CONTAMINATION_PATTERNS = [
  /^(Translation:|Here is|Sure[,，]|Of course)/i,
  /(the source says|the translation should be|translated as follows)/i,
  /(I will translate|I translated this as|as an AI)/i,
  /(以下是|下面是|这是.*?翻译|译文如下|翻译如下)/i,
  /(我来翻译|我将翻译|根据原文|综合.*?来看|综上所述)/i
] as const;

function proofreadCode(code: ValidationCode): ProofreadDeterministicSignal["code"] | undefined {
  if (code === "glossary_missing" || code === "character_name_missing") return "H3";
  if (code === "likely_untranslated") return "H4";
  if (code === "character_pronoun_mismatch") return "H8";
  if (code === "length_anomaly") return "H9";
  return undefined;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character) ? 2 : 1;
  }
  return width;
}

function expansionSuspect(source: string, translation: string, languagePair?: string): boolean {
  const sourceWidth = Math.max(displayWidth(source), 1);
  if (sourceWidth < 8) return false;
  const targetWidth = displayWidth(translation);
  const target = languagePair?.split(/->|→|=>/)[1]?.trim().toLowerCase() ?? "";
  const chinese = /^(zh|chinese)/.test(target);
  const english = /^(en|english)/.test(target);
  const ratio = chinese ? 1.5 : english ? 1.8 : 1.7;
  const extraWidth = chinese ? 32 : english ? 48 : 40;
  return targetWidth / sourceWidth >= ratio && targetWidth - sourceWidth >= extraWidth;
}

function alignmentEvidence(signal: string): string {
  const descriptions: Record<string, string> = {
    severe_length_compression: "Translation is mechanically much shorter than its aligned source row.",
    severe_length_expansion: "Translation is mechanically much longer than its aligned source row.",
    repeated_candidate_for_distinct_sources: "Distinct source rows reuse the same translation text.",
    consecutive_repeated_candidate_for_distinct_sources: "Adjacent distinct source rows reuse the same translation text.",
    adjacent_length_compensation: "Adjacent rows have opposing length anomalies that may indicate shifted content.",
    sentence_boundary_count_mismatch: "The aligned source and translation have different sentence boundary counts.",
    adjacent_sentence_boundary_compensation: "Adjacent rows have opposing sentence boundary counts that may indicate a sentence boundary moved between rows."
  };
  return descriptions[signal] ?? `Host mechanical alignment signal: ${signal}.`;
}

export function buildProofreadDeterministicSignals(args: {
  sourceText: string;
  translationText: string;
  validationOptions: ValidationOptions;
  validationResult?: TranslationValidationResult;
  onProgress?: (progress: ProofreadPrescanProgress) => void;
}): ProofreadDeterministicSignal[] {
  const sourceLines = splitTextLines(args.sourceText);
  const translationLines = splitTextLines(args.translationText);
  if (sourceLines.length !== translationLines.length) {
    throw new Error(
      `Proofreading requires aligned files; source has ${sourceLines.length} lines and translation has ${translationLines.length}.`
    );
  }

  args.onProgress?.({ phase: "validation", completedLines: 0, totalLines: sourceLines.length });
  const validation = args.validationResult ?? validateTranslationCandidate(
    args.sourceText,
    args.translationText,
    args.validationOptions,
    (completedLines, totalLines) => args.onProgress?.({ phase: "validation", completedLines, totalLines })
  );
  const signals: ProofreadDeterministicSignal[] = [];
  for (const finding of [...validation.blocking, ...validation.warnings]) {
    const code = proofreadCode(finding.code);
    if (!code || !finding.line) continue;
    signals.push({ line: finding.line, code, evidence: finding.detail });
  }

  for (let index = 0; index < translationLines.length; index += 1) {
    if (index % 1000 === 0) args.onProgress?.({ phase: "signals", completedLines: index, totalLines: sourceLines.length });
    const translation = translationLines[index] ?? "";
    const contamination = AI_CONTAMINATION_PATTERNS.find((pattern) => pattern.test(translation));
    if (contamination) {
      signals.push({
        line: index + 1,
        code: "H7",
        evidence: `Translation matches AI-contamination pattern ${contamination.source}.`
      });
    }
    if (expansionSuspect(sourceLines[index] ?? "", translation, args.validationOptions.languagePair)) {
      signals.push({
        line: index + 1,
        code: "H9",
        evidence: "Translation exceeds the built-in target-language expansion threshold."
      });
    }
  }

  args.onProgress?.({ phase: "alignment", completedLines: 0, totalLines: sourceLines.length });
  const alignmentAudit = createTranslationAlignmentAudit({
    documentId: "proofread-prescan",
    sourceText: args.sourceText,
    candidateText: args.translationText,
    candidatePath: "proofread-prescan",
    languagePair: args.validationOptions.languagePair
  });
  for (const check of alignmentAudit.checks) {
    for (const signal of check.signals) {
      signals.push({ line: check.line, code: "M0", evidence: alignmentEvidence(signal) });
    }
  }

  const seen = new Set<string>();
  const result = signals
    .sort((left, right) => left.line - right.line || left.code.localeCompare(right.code))
    .filter((signal) => {
      const key = `${signal.code}:${signal.line}:${signal.evidence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  args.onProgress?.({ phase: "complete", completedLines: sourceLines.length, totalLines: sourceLines.length });
  return result;
}

export function summarizeProofreadDeterministicSignals(args: {
  signals: ProofreadDeterministicSignal[];
  totalLines: number;
  maximumWorkers: number;
  regionSize?: number;
}): ProofreadPrescanSummary {
  const totalLines = Math.max(0, Math.floor(args.totalLines));
  const maximumWorkers = Math.max(0, Math.floor(args.maximumWorkers));
  const regionSize = Math.max(1, Math.floor(args.regionSize ?? 500));
  const countsByCode = Object.fromEntries(
    PROOFREAD_SIGNAL_CODES.map((code) => [code, 0])
  ) as ProofreadPrescanSummary["countsByCode"];
  const affectedLines = new Set<number>();
  const regionLines = new Map<number, Set<number>>();

  for (const signal of args.signals) {
    countsByCode[signal.code] += 1;
    affectedLines.add(signal.line);
    const regionIndex = Math.floor((signal.line - 1) / regionSize);
    const lines = regionLines.get(regionIndex) ?? new Set<number>();
    lines.add(signal.line);
    regionLines.set(regionIndex, lines);
  }

  const regionCount = totalLines === 0 ? 0 : Math.ceil(totalLines / regionSize);
  const regions = Array.from({ length: regionCount }, (_, regionIndex) => {
    const fromLine = regionIndex * regionSize + 1;
    const toLine = Math.min(totalLines, fromLine + regionSize - 1);
    const affectedLineCount = regionLines.get(regionIndex)?.size ?? 0;
    const density = affectedLineCount / Math.max(1, toLine - fromLine + 1);
    const tier = density > 0.05 ? "HOT" : density > 0.01 ? "WARM" : "COLD";
    return { fromLine, toLine, affectedLineCount, density, tier } as const;
  });
  const regionCounts = { HOT: 0, WARM: 0, COLD: 0 };
  for (const region of regions) regionCounts[region.tier] += 1;

  return {
    completed: true,
    totalLines,
    signalCount: args.signals.length,
    affectedLineCount: affectedLines.size,
    countsByCode,
    recommendedWorkerCount: maximumWorkers === 0 || totalLines === 0
      ? 0
      : Math.min(maximumWorkers, Math.max(1, Math.ceil(totalLines / 1_000))),
    regionCounts,
    highestRiskRegions: regions
      .filter((region) => region.affectedLineCount > 0)
      .sort((left, right) => right.density - left.density || left.fromLine - right.fromLine)
      .slice(0, 12)
  };
}
