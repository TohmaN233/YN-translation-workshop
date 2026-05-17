export interface ProofreadReportCandidateInput {
  path: string;
  size: number;
  modifiedMs: number;
  content: string;
}

export interface ProofreadReportCandidate extends ProofreadReportCandidateInput {
  score: number;
  reasons: string[];
}

type StructuredReportKind = "fix-proposal" | "summary" | "unknown";

interface StructuredReportDetection {
  kind: StructuredReportKind;
  score: number;
  reasons: string[];
}

const featurePatterns: Array<[string, RegExp, number]> = [
  ["suggestion-field", /(?:suggested translation|suggested fix|replacement)\s*(?:\*\*)?\s*[:：]|(?:寤|淇|鍙)[^\n]{0,24}(?:[:：]|锛)/i, 40],
  ["source-field", /(?:source text|source)\s*(?:\*\*)?\s*[:：]|(?:鍘熸枃|婧愭枃)[^\n]{0,16}(?:[:：]|锛)/i, 18],
  ["translation-field", /(?:current translation)\s*(?:\*\*)?\s*[:：]|(?:褰撳墠璇戞枃|鐜拌瘧|璇戞枃)[^\n]{0,16}(?:[:：]|锛)/i, 18],
  ["problem-field", /(?:issue type|issue|explanation)\s*(?:\*\*)?\s*[:：]|(?:闂|璇存槑)[^\n]{0,18}(?:[:：]|锛)/i, 18],
  ["proposal-heading", /^#{2,6}\s+(?:\[[HML]\d?-\d+]|\[[HML]-?\d+]|[HML]\d?-\d+|[HML]-?\d+|Finding|Issue)/im, 12],
  ["review-options", /accept suggestion|accept/i, 8]
];

function cleanLine(line: string): string {
  return line.replace(/^\uFEFF/, "").trim();
}

function firstNonEmptyLines(content: string, maxLines: number): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .slice(0, maxLines);
}

function normalizeLabel(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\*\*/g, "")
    .split(/[:：]/, 1)[0]
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, " ");
}

function hasOrderedMetadataLabels(lines: string[], labels: string[]): boolean {
  let cursor = 0;
  for (const line of lines) {
    if (normalizeLabel(line) !== labels[cursor]) {
      continue;
    }
    cursor += 1;
    if (cursor === labels.length) {
      return true;
    }
  }
  return false;
}

function hasProposalBlock(content: string): boolean {
  const blockStart = /^\s{0,3}###\s+(?:\[[HML]\d?-\d{1,4}]|[HML]\d?-\d{1,4})\b.*(?:\bL\d+\b)?/im;
  if (!blockStart.test(content)) {
    return false;
  }
  const hasSource = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*Source\s*(?:\*\*)?\s*[:：]/im.test(content);
  const hasCurrent = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*Current translation\s*(?:\*\*)?\s*[:：]/im.test(content);
  const hasIssue = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*Issue\s*(?:\*\*)?\s*[:：]/im.test(content);
  const hasSuggestion = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*Suggested (?:fix|translation)\s*(?:\*\*)?\s*[:：]/im.test(content);
  return hasSource && hasCurrent && hasIssue && hasSuggestion;
}

function hasLegacyProposalShape(content: string): boolean {
  const hasHeading = /^#{2,6}\s+(?:\[[HML]-?\d+]|\[[HML]\d?-\d+]|[HML]-?\d+|[HML]\d?-\d+|Finding|Issue)/im.test(content);
  const markdownFieldCount = content.match(/\*\*[^*\n]{1,40}\*\*\s*(?:[:：]|锛)/g)?.length ?? 0;
  return hasHeading && markdownFieldCount >= 3;
}

function detectStructuredReport(candidate: ProofreadReportCandidateInput): StructuredReportDetection {
  const lines = firstNonEmptyLines(candidate.content, 16);
  const first = lines[0] ?? "";
  const metadata = lines.slice(1, 10);
  const normalizedPath = candidate.path.replaceAll("\\", "/").toLowerCase();

  const hasFixProposalName = /(?:^|\/)[^/]*_fix_proposal\.md$/.test(normalizedPath);
  const hasSummaryName = /(?:^|\/)[^/]*_proofread_summary\.md$/.test(normalizedPath);
  const hasFixProposalTitle = /^#\s*fix[ _-]?proposals?\b/i.test(first);
  const hasSummaryTitle = /^#\s*proofread summary\b/i.test(first);
  const hasFixMetadata = hasOrderedMetadataLabels(metadata, ["source", "translation", "generated", "mode", "summary"]);
  const hasSummaryMetadata = hasOrderedMetadataLabels(metadata, ["source", "translation", "glossary", "type", "language pair", "mode"]);
  const hasBlock = hasProposalBlock(candidate.content);

  if ((hasFixProposalTitle || hasFixProposalName) && hasFixMetadata && hasBlock) {
    return {
      kind: "fix-proposal",
      score: 180,
      reasons: [
        hasFixProposalTitle ? "fix-proposal-title" : "fix-proposal-name",
        "ordered-fix-metadata",
        "proposal-block-schema"
      ]
    };
  }

  if (hasSummaryTitle || hasSummaryName || hasSummaryMetadata) {
    return {
      kind: "summary",
      score: -80,
      reasons: [hasSummaryTitle ? "summary-title" : hasSummaryName ? "summary-name" : "summary-metadata"]
    };
  }

  return { kind: "unknown", score: 0, reasons: [] };
}

export function scoreProofreadReportCandidate(candidate: ProofreadReportCandidateInput): ProofreadReportCandidate {
  const structured = detectStructuredReport(candidate);
  const reasons: string[] = [...structured.reasons];
  let score = structured.score;

  if (structured.kind === "summary") {
    return { ...candidate, score, reasons };
  }

  for (const [reason, pattern, weight] of featurePatterns) {
    if (pattern.test(candidate.content)) {
      reasons.push(reason);
      score += weight;
    }
  }
  if (hasLegacyProposalShape(candidate.content)) {
    reasons.push("legacy-proposal-block");
    if (!reasons.includes("suggestion-field")) {
      reasons.push("suggestion-field");
    }
    score += 40;
  }
  if (candidate.size > 1000) {
    reasons.push("substantial-size");
    score += Math.min(18, Math.floor(Math.log10(candidate.size) * 5));
  }
  if (/(?:fix[_ -]?proposal|proposal)/i.test(candidate.path)) {
    reasons.push("fix-proposal-name-hint");
    score += 40;
  } else if (/proofread|review/i.test(candidate.path)) {
    reasons.push("name-hint");
    score += 8;
  }
  if (/[\\/]\.translation-workshop[\\/]reports[\\/]/i.test(candidate.path)) {
    reasons.push("project-reports-folder");
    score += 16;
  }
  score += Math.min(8, Math.floor(candidate.modifiedMs / 1000 / 60 / 60 / 24 / 365));
  return { ...candidate, score, reasons };
}

export function rankProofreadReportCandidates(candidates: ProofreadReportCandidateInput[]): ProofreadReportCandidate[] {
  return candidates
    .map(scoreProofreadReportCandidate)
    .sort((left, right) => right.score - left.score || right.modifiedMs - left.modifiedMs || right.size - left.size);
}
