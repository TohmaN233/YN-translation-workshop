export interface ReviewProposal {
  id: string;
  line?: number;
  src: string;
  current: string;
  problemType: string;
  problem: string;
  suggestion: string;
  status: "unreviewed" | "accepted" | "rejected" | "manual";
}

type ProposalField = keyof Omit<ReviewProposal, "id" | "status">;

const fieldAliases: Record<string, ProposalField> = {
  "行号": "line",
  "位置": "line",
  "琛屽彿": "line",
  "line": "line",
  "location": "line",
  "原文": "src",
  "源文": "src",
  "鍘熸枃": "src",
  "婧愭枃": "src",
  "source": "src",
  "source text": "src",
  "当前译文": "current",
  "现译": "current",
  "译文": "current",
  "褰撳墠璇戞枃": "current",
  "鐜拌瘧": "current",
  "璇戞枃": "current",
  "current": "current",
  "current translation": "current",
  "问题类型": "problemType",
  "类型": "problemType",
  "严重度": "problemType",
  "闂绫诲瀷": "problemType",
  "绫诲瀷": "problemType",
  "issue type": "problemType",
  "severity": "problemType",
  "问题说明": "problem",
  "问题": "problem",
  "说明": "problem",
  "闂璇存槑": "problem",
  "闂": "problem",
  "璇存槑": "problem",
  "explanation": "problem",
  "issue": "problem",
  "建议": "suggestion",
  "建议译文": "suggestion",
  "修正译文": "suggestion",
  "可替换译文": "suggestion",
  "替换译文": "suggestion",
  "寤鸿": "suggestion",
  "寤鸿璇戞枃": "suggestion",
  "淇璇戞枃": "suggestion",
  "鍙浛鎹㈣瘧鏂囷細": "suggestion",
  "鍙浛鎹㈣瘧鏂�": "suggestion",
  "鏇挎崲璇戞枃": "suggestion",
  "suggestion": "suggestion",
  "suggested translation": "suggestion",
  "suggested fix": "suggestion",
  "replacement": "suggestion"
};

function normalizeLabel(raw: string): string {
  return raw
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toFieldName(raw: string): ProposalField | undefined {
  const label = normalizeLabel(raw);
  return fieldAliases[label] ?? fieldAliases[raw.trim()];
}

function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
}

function lineNumberFromText(text: string): number | undefined {
  const patterns = [
    /\braw(?:\s*(?:line|row))?\s*[:#=：]?\s*L?(\d{1,7})(?=$|[\s)\]）】,，.;；:：])/i,
    /\bglobal(?:\s*(?:line|row))?\s*[:#=：]?\s*L?(\d{1,7})(?=$|[\s)\]）】,，.;；:：])/i,
    /\b(?:MC|Chunk|Region|Split|Part|Sample|Round)\b[^\n|#]*\bL(\d{1,7})(?=$|[\s)\]）】,，.;；:：])/i,
    /\|\s*[^\n#]*\bL(\d{1,7})(?=$|[\s)\]）】,，.;；:：])/i,
    /(?:^|[\s([（【])(?:line|row)\s*[:#：]?\s*L?(\d{1,7})(?=$|[\s)\]）】,，.;；:：])/i,
    /(?:^|[\s([（【])(?:行号|行)\s*[:#：]?\s*L?(\d{1,7})(?=$|[\s)\]）】,，.;；:：])/i,
    /第\s*(\d{1,7})\s*行/i
  ];
  for (const pattern of patterns) {
    const line = Number.parseInt(text.match(pattern)?.[1] ?? "", 10);
    if (Number.isFinite(line) && line > 0) {
      return line;
    }
  }
  return undefined;
}

function headingInfo(lines: string[]): { id?: string; problemType?: string; line?: number } {
  const heading = lines.find((line) => /^\s{0,3}#{1,6}\s+\S/.test(line));
  if (!heading) {
    return {};
  }
  const text = heading.replace(/^\s{0,3}#{1,6}\s+/, "").trim();
  const bracketId = text.match(/\[((?:H[1-9]|M[1-5]|L[1-4]|[HML])-?\d{1,4})\]/i)?.[1];
  const plainId = text.match(/\b((?:H[1-9]|M[1-5]|L[1-4]|[HML])-?\d{1,4})\b/i)?.[1];
  const id = (bracketId ?? plainId)?.toUpperCase();
  return {
    id,
    line: lineNumberFromText(text),
    problemType: text.replace(/^\[[^\]]+]\s*/, "")
  };
}

function parseFieldLine(line: string): { field: ProposalField; value: string } | undefined {
  const match = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?<label>[^:：锛歖*]{1,40})\s*(?:\*\*)?\s*[:：锛歖]\s*(?<value>.*)$/u);
  if (!match?.groups) {
    return undefined;
  }
  const field = toFieldName(match.groups.label);
  if (!field) {
    return undefined;
  }
  return { field, value: cleanValue(match.groups.value) };
}

function parseBlock(lines: string[], index: number): ReviewProposal | undefined {
  const data: Partial<ReviewProposal> = {};
  const heading = headingInfo(lines);
  if (heading.problemType) {
    data.problemType = heading.problemType;
  }
  if (heading.line !== undefined) {
    data.line = heading.line;
  }

  for (const line of lines) {
    const parsed = parseFieldLine(line);
    if (!parsed) {
      continue;
    }
    if (parsed.field === "line") {
      const parsedLine = lineNumberFromText("line " + parsed.value) ?? Number.parseInt(parsed.value, 10);
      if (Number.isFinite(parsedLine) && parsedLine > 0) {
        data.line = parsedLine;
      }
    } else {
      data[parsed.field] = parsed.value;
    }
  }

  if (!data.suggestion || !(data.src || data.current || data.problem)) {
    return undefined;
  }

  const id = heading.id
    ?? data.problemType?.match(/[HML]-?\d{1,4}/i)?.[0]?.toUpperCase()
    ?? `P-${String(index + 1).padStart(4, "0")}`;
  return {
    id,
    line: data.line,
    src: data.src ?? "",
    current: data.current ?? "",
    problemType: data.problemType ?? "",
    problem: data.problem ?? "",
    suggestion: data.suggestion,
    status: "unreviewed"
  };
}

function sequencedIdParts(id: string): { prefix: string; number: number; width: number } | undefined {
  const match = id.trim().toUpperCase().match(/^([HML][1-9]?|P)-(\d{1,6})$/);
  if (!match) {
    return undefined;
  }
  return {
    prefix: match[1],
    number: Number.parseInt(match[2], 10),
    width: match[2].length
  };
}

function proposalIdPrefix(proposal: ReviewProposal): string {
  const id = proposal.id.trim().toUpperCase();
  const sequenced = sequencedIdParts(id);
  if (sequenced) {
    return sequenced.prefix;
  }
  return id.match(/^([HML][1-9]?)/)?.[1]
    ?? proposal.problemType.match(/\b([HML][1-9]?)\b/i)?.[1]?.toUpperCase()
    ?? "P";
}

function normalizeDuplicateProposalIds(proposals: ReviewProposal[]): ReviewProposal[] {
  const maxByPrefix = new Map<string, { max: number; width: number }>();
  for (const proposal of proposals) {
    const parts = sequencedIdParts(proposal.id);
    if (!parts) {
      continue;
    }
    const current = maxByPrefix.get(parts.prefix) ?? { max: 0, width: 3 };
    maxByPrefix.set(parts.prefix, {
      max: Math.max(current.max, parts.number),
      width: Math.max(current.width, parts.width)
    });
  }

  const seen = new Set<string>();
  return proposals.map((proposal) => {
    const id = proposal.id.trim().toUpperCase() || "P-0001";
    if (!seen.has(id)) {
      seen.add(id);
      return id === proposal.id ? proposal : { ...proposal, id };
    }

    const prefix = proposalIdPrefix(proposal);
    const current = maxByPrefix.get(prefix) ?? { max: 0, width: 3 };
    let next = current.max + 1;
    let nextId = `${prefix}-${String(next).padStart(current.width, "0")}`;
    while (seen.has(nextId)) {
      next += 1;
      nextId = `${prefix}-${String(next).padStart(current.width, "0")}`;
    }
    maxByPrefix.set(prefix, { ...current, max: next });
    seen.add(nextId);
    return { ...proposal, id: nextId };
  });
}

export function parseProofreadMarkdown(markdown: string): ReviewProposal[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    const startsBlock = /^\s{0,3}#{1,6}\s+\S/.test(line)
      || /^\s*(?:[-*]\s*)?(?:ID|Finding|Issue|问题|闂)\b/i.test(line);
    if (startsBlock && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    if (line.trim() !== "" || current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }

  const proposals = blocks
    .map((block, index) => parseBlock(block, index))
    .filter((proposal): proposal is ReviewProposal => Boolean(proposal));
  return normalizeDuplicateProposalIds(proposals);
}
