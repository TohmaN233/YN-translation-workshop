// Pure candidate-import planner.
//
// Given the source text and a candidate translation text, this runs the
// deterministic validator and produces a line-by-line edits map ready to be
// injected into the line-review workbench state. Import only ever updates the
// workbench draft (the line-review localStorage edits) — it never writes the
// final translation TXT. When validation blocks, no edits map is produced and
// the caller must route the user to the repair entry point.

import {
  validateTranslationCandidate,
  type TranslationValidationResult
} from "../../shared/validation/translationValidator.ts";
import { splitTextLines } from "../../shared/validation/translationValidator.ts";

export interface CandidateImportPlan {
  ok: boolean;
  validation: TranslationValidationResult;
  /** 1-based line -> candidate text, only present when ok. */
  edits: Record<number, string>;
  /** 1-based line -> "machine", mirroring the line-review status vocabulary. */
  status: Record<number, "machine">;
  lineCount: number;
}

/**
 * Build an import plan from a validated candidate. When validation fails, the
 * returned plan has ok=false and empty edits; the UI must refuse import and
 * offer the repair entry point instead.
 */
export function buildCandidateImportPlan(
  sourceText: string,
  candidateText: string,
  locale: "zh-CN" | "en-US" = "zh-CN",
  languagePair?: string,
  glossaryEntries?: Array<{ source?: string; target?: string; aliases?: string[] }>,
  characterEntries?: Array<{ name?: string; target?: string; aliases?: string[] }>,
  styleForbiddenTerms?: string[]
): CandidateImportPlan {
  const validation = validateTranslationCandidate(sourceText, candidateText, {
    locale,
    languagePair,
    glossaryEntries,
    characterEntries,
    styleForbiddenTerms
  });
  if (!validation.ok) {
    return { ok: false, validation, edits: {}, status: {}, lineCount: validation.sourceLineCount };
  }

  const candidateLines = splitTextLines(candidateText);
  const edits: Record<number, string> = {};
  const status: Record<number, "machine"> = {};

  for (let i = 0; i < candidateLines.length; i += 1) {
    const lineNo = i + 1;
    edits[lineNo] = candidateLines[i];
    status[lineNo] = "machine";
  }

  return {
    ok: true,
    validation,
    edits,
    status,
    lineCount: candidateLines.length
  };
}

/**
 * Repair-prompt generator for the line-count-mismatch case. Produces a short
 * instruction the user can send to the agent to fix the candidate format
 * without re-translating from scratch.
 */
export function buildRepairPrompt(
  sourceText: string,
  candidateText: string,
  validation: TranslationValidationResult,
  locale: "zh-CN" | "en-US" = "zh-CN"
): string {
  const sourceLines = splitTextLines(sourceText);
  const candidateLines = splitTextLines(candidateText);
  const delta = candidateLines.length - sourceLines.length;

  if (validation.ok) {
    return locale === "zh-CN"
      ? "无需修复：候选译文已通过校验。"
      : "No repair needed: candidate already passes validation.";
  }

  const lines: string[] = [];
  if (locale === "zh-CN") {
    lines.push("上一版候选译文未通过宿主校验，未被导入。");
    lines.push("");
    for (const finding of validation.blocking) {
      lines.push(`- [${finding.code}] ${finding.detail}`);
    }
    lines.push("");
    lines.push(`原文行数：${sourceLines.length}`);
    lines.push(`候选行数：${candidateLines.length}`);
    if (validation.blocking.some((f) => f.code === "line_count_mismatch")) {
      lines.push(
        delta > 0
          ? `候选多了 ${delta} 行。请重新输出恰好 ${sourceLines.length} 行译文，与原文逐行对齐，保留空行。`
          : `候选少了 ${Math.abs(delta)} 行。请重新输出恰好 ${sourceLines.length} 行译文，与原文逐行对齐，保留空行。`
      );
    }
    if (validation.blocking.some((f) => f.code === "placeholder_mismatch")) {
      lines.push("每一行必须保留原文中的占位符（{...}、%s、%d、$1、\\n、\\t 等），不得删改。");
    }
    if (validation.blocking.some((f) => f.code === "tag_mismatch")) {
      lines.push("每一行必须保留原文中的代码/标记（<>、[]、[[]] 等括号内仅含英文/数字/符号的片段），不得删改。");
    }
    lines.push("");
    lines.push("只输出修正后的译文行，不要解释。");
    return lines.join("\n");
  }

  lines.push("The previous translation candidate failed host-side validation and was NOT imported.");
  lines.push("");
  for (const finding of validation.blocking) {
    lines.push(`- [${finding.code}] ${finding.detail}`);
  }
  lines.push("");
  lines.push(`Source line count: ${sourceLines.length}`);
  lines.push(`Candidate line count: ${candidateLines.length}`);
  if (validation.blocking.some((f) => f.code === "line_count_mismatch")) {
    lines.push(
      delta > 0
        ? `The candidate has ${delta} extra line(s). Re-emit the translation with exactly ${sourceLines.length} lines, one per source line, preserving empty lines.`
        : `The candidate is missing ${Math.abs(delta)} line(s). Re-emit the translation with exactly ${sourceLines.length} lines, one per source line, preserving empty lines.`
    );
  }
  if (validation.blocking.some((f) => f.code === "placeholder_mismatch")) {
    lines.push("Preserve every placeholder ({...}, %s, %d, $1, \\n, \\t) from the source line verbatim in the matching output line.");
  }
  if (validation.blocking.some((f) => f.code === "tag_mismatch")) {
    lines.push("Preserve every code/markup span from the source line verbatim (<>, [], [[]], and similar bracketed ASCII payloads).");
  }
  lines.push("");
  lines.push("Output only the corrected translation lines, nothing else. Do not include explanations.");

  return lines.join("\n");
}
