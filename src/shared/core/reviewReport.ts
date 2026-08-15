export interface ReviewProposal {
  id: string;
  documentId?: string;
  sourcePath?: string;
  translationPath?: string;
  line?: number;
  src: string;
  current: string;
  oldText?: string;
  baseRevision?: number;
  problemType: string;
  problem: string;
  suggestion: string;
  kind?: "mechanical_scan";
  needsVerification?: boolean;
  status: "unreviewed" | "accepted" | "rejected" | "manual" | "conflict";
}

export interface TranslationPatchChange {
  lineId: number;
  oldText?: string;
  newText: string;
  baseRevision?: number;
  reason: string;
  sourceFindingId?: string;
}

export interface TranslationPatch {
  schemaVersion: "1.0";
  documentId: string;
  createdAt?: string;
  changes: TranslationPatchChange[];
}

export interface NormalizedProofreadFinding {
  id: string;
  documentId?: string;
  sourcePath?: string;
  translationPath?: string;
  severity: string;
  type: string;
  sourceLine?: number;
  translationLine?: number;
  sourceText: string;
  currentTranslation: string;
  oldText: string;
  baseRevision?: number;
  suggestedFix: string;
  rationale: string;
  agentId?: string;
  needsVerification?: boolean;
}

type ProposalField = keyof Omit<ReviewProposal, "id" | "status" | "kind" | "needsVerification">;

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
  "old text": "oldText",
  "oldText": "oldText",
  "base revision": "baseRevision",
  "baseRevision": "baseRevision",
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
  const bracketId = text.match(/\[((?:H[1-9]|M[0-5]|L[1-4]|[HML])-?\d{1,4})\]/i)?.[1];
  const plainId = text.match(/\b((?:H[1-9]|M[0-5]|L[1-4]|[HML])-?\d{1,4})\b/i)?.[1];
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
    } else if (parsed.field === "baseRevision") {
      const revision = Number.parseInt(parsed.value, 10);
      if (Number.isInteger(revision) && revision >= 0) {
        data.baseRevision = revision;
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
  const proposal: ReviewProposal = {
    id,
    line: data.line,
    src: data.src ?? "",
    current: data.current ?? "",
    oldText: data.oldText ?? data.current ?? "",
    baseRevision: data.baseRevision,
    problemType: data.problemType ?? "",
    problem: data.problem ?? "",
    suggestion: data.suggestion,
    status: "accepted"
  };
  if (isMechanicalScanProposal(proposal)) {
    proposal.kind = "mechanical_scan";
    proposal.needsVerification = true;
    proposal.status = "unreviewed";
  }
  return proposal;
}

export function isMechanicalScanProposal(
  proposal: Partial<ReviewProposal> & { type?: unknown; severity?: unknown }
): boolean {
  const id = String(proposal.id ?? "").trim();
  if (/^M0(?:-|$)/i.test(id)) return true;
  const markers = [proposal.kind, proposal.type, proposal.severity, proposal.problemType]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return markers.some((value) =>
    /^M0(?:\s|-|$)/i.test(value)
    || /(?:^|[\s:/_-])mechanical[\s_-]*scan(?:$|[\s:/_-])/i.test(value)
  );
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

function numericLine(value: unknown): number | undefined {
  const line = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function numericRevision(value: unknown): number | undefined {
  const revision = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(revision) && revision >= 0 ? revision : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function recordString(record: Record<string, unknown>, names: string[]): string {
  return stringValue(recordValue(record, names));
}

function recordLine(record: Record<string, unknown>, names: string[]): number | undefined {
  return numericLine(recordValue(record, names));
}

function recordRevision(record: Record<string, unknown>, names: string[]): number | undefined {
  return numericRevision(recordValue(record, names));
}

function parseJsonPayload(jsonText: string): unknown {
  const text = String(jsonText ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (!fenced) return undefined;
    try {
      return JSON.parse(fenced);
    } catch {
      return undefined;
    }
  }
}

function rawFindingRecords(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as { findings?: unknown; proposals?: unknown; issues?: unknown };
  if (Array.isArray(record.findings)) return record.findings;
  if (Array.isArray(record.proposals)) return record.proposals;
  if (Array.isArray(record.issues)) return record.issues;
  return [parsed];
}

export function normalizeProofreadFindingRecord(
  raw: unknown,
  index: number,
  chunkLabel?: string
): NormalizedProofreadFinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const severity = recordString(record, ["severity", "priority", "level"]).toUpperCase();
  const type = recordString(record, ["type", "problemType", "issueType", "category", "check"]);
  const sourceLine = recordLine(record, ["sourceLine", "source_line", "line", "lineNumber", "row"]);
  const translationLine = recordLine(record, ["translationLine", "targetLine", "target_line", "line", "lineNumber", "row"]) ?? sourceLine;
  const sourceText = recordString(record, ["sourceText", "source", "src", "original"]);
  const currentTranslation = recordString(record, ["currentTranslation", "current", "currentText", "translation", "targetText"]);
  const oldText = recordString(record, ["oldText", "old", "previousTranslation"]) || currentTranslation;
  const suggestedFix = recordString(record, ["suggestedFix", "suggestion", "suggestedTranslation", "replacement", "newText", "fix"]);
  const rationale = recordString(record, ["rationale", "reason", "problem", "explanation", "issue", "comment"]);
  if (!suggestedFix || !(sourceText || currentTranslation || rationale)) return undefined;
  const id = recordString(record, ["id", "findingId", "issueId"]).toUpperCase()
    || (severity ? `${severity}-${String(index + 1).padStart(3, "0")}` : `P-${String(index + 1).padStart(4, "0")}`);
  const finding: NormalizedProofreadFinding = {
    id,
    severity,
    type,
    sourceLine,
    translationLine,
    sourceText,
    currentTranslation,
    oldText,
    baseRevision: recordRevision(record, ["baseRevision", "revision"]),
    suggestedFix,
    rationale
  };
  const documentId = recordString(record, ["documentId", "document", "fileId"]);
  const sourcePath = recordString(record, ["sourcePath", "sourceFile"]);
  const translationPath = recordString(record, ["translationPath", "translationFile", "targetPath"]);
  if (documentId) finding.documentId = documentId;
  if (sourcePath) finding.sourcePath = sourcePath;
  if (translationPath) finding.translationPath = translationPath;
  const agentId = recordString(record, ["agentId", "agent", "sourceAgent"]) || stringValue(chunkLabel);
  if (agentId) finding.agentId = agentId;
  if (record.needsVerification === true) finding.needsVerification = true;
  return finding;
}

export function parseProofreadFindingRecords(jsonText: string, chunkLabel?: string): NormalizedProofreadFinding[] {
  const parsed = parseJsonPayload(jsonText);
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const inherited = root ? {
    documentId: recordString(root, ["documentId", "document", "fileId"]),
    sourcePath: recordString(root, ["sourcePath", "sourceFile"]),
    translationPath: recordString(root, ["translationPath", "translationFile", "targetPath"])
  } : undefined;
  return rawFindingRecords(parsed)
    .map((finding) => finding && typeof finding === "object" && inherited
      ? { ...inherited, ...(finding as Record<string, unknown>) }
      : finding)
    .map((finding, index) => normalizeProofreadFindingRecord(finding, index, chunkLabel))
    .filter((finding): finding is NormalizedProofreadFinding => Boolean(finding));
}

function findingToProposal(finding: NormalizedProofreadFinding): ReviewProposal | undefined {
  const suggestion = finding.suggestedFix;
  const src = finding.sourceText;
  const current = finding.currentTranslation;
  const oldText = finding.oldText || current;
  const problem = finding.rationale;
  if (!suggestion || !(src || current || problem)) {
    return undefined;
  }
  const mechanicalScan = isMechanicalScanProposal({
    id: finding.id,
    type: finding.type,
    severity: finding.severity
  });
  return {
    id: finding.id,
    ...(finding.documentId ? { documentId: finding.documentId } : {}),
    ...(finding.sourcePath ? { sourcePath: finding.sourcePath } : {}),
    ...(finding.translationPath ? { translationPath: finding.translationPath } : {}),
    line: finding.sourceLine ?? finding.translationLine,
    src,
    current,
    oldText,
    baseRevision: finding.baseRevision,
    problemType: [finding.severity, finding.type].filter(Boolean).join(" "),
    problem,
    suggestion,
    ...(mechanicalScan ? { kind: "mechanical_scan" as const, needsVerification: true } : {}),
    ...(!mechanicalScan && finding.needsVerification === true ? { needsVerification: true } : {}),
    status: mechanicalScan ? "unreviewed" : "accepted"
  };
}

export function parseProofreadFindingsJson(jsonText: string): ReviewProposal[] {
  const proposals = parseProofreadFindingRecords(jsonText)
    .map((finding) => findingToProposal(finding))
    .filter((proposal): proposal is ReviewProposal => Boolean(proposal));
  return normalizeDuplicateProposalIds(proposals);
}

export function parseProofreadReport(text: string, reportPath = ""): ReviewProposal[] {
  const lower = reportPath.toLowerCase();
  if (lower.endsWith(".json")) {
    const proposals = parseProofreadFindingsJson(text);
    if (proposals.length > 0) {
      return proposals;
    }
  }
  return parseProofreadMarkdown(text);
}

export function reviewProposalsToPatch(
  proposals: ReviewProposal[],
  documentId: string,
  options: { createdAt?: string } = {}
): TranslationPatch {
  return {
    schemaVersion: "1.0",
    documentId,
    createdAt: options.createdAt,
    changes: proposals.flatMap((proposal): TranslationPatchChange[] => {
      if (isMechanicalScanProposal(proposal)) return [];
      const lineId = Number(proposal.line);
      const newText = proposal.suggestion.trim();
      if (!Number.isInteger(lineId) || lineId <= 0 || !newText) return [];
      return [{
        lineId,
        oldText: proposal.oldText ?? proposal.current,
        newText,
        baseRevision: proposal.baseRevision,
        reason: proposal.problem || proposal.problemType || proposal.id,
        sourceFindingId: proposal.id
      }];
    })
  };
}

export function validateTranslationPatch(patch: unknown): string[] {
  const errors: string[] = [];
  if (!patch || typeof patch !== "object") return ["patch must be an object"];
  const value = patch as Partial<TranslationPatch>;
  if (value.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (!value.documentId || typeof value.documentId !== "string") errors.push("documentId is required");
  if (!Array.isArray(value.changes)) {
    errors.push("changes must be an array");
    return errors;
  }
  value.changes.forEach((change, index) => {
    if (!change || typeof change !== "object") {
      errors.push(`changes[${index}] must be an object`);
      return;
    }
    const lineId = (change as TranslationPatchChange).lineId;
    const newText = (change as TranslationPatchChange).newText;
    const reason = (change as TranslationPatchChange).reason;
    const baseRevision = (change as TranslationPatchChange).baseRevision;
    if (!Number.isInteger(lineId) || lineId <= 0) errors.push(`changes[${index}].lineId must be a positive integer`);
    if (typeof newText !== "string") errors.push(`changes[${index}].newText must be a string`);
    if (typeof reason !== "string" || reason.trim() === "") errors.push(`changes[${index}].reason is required`);
    if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
      errors.push(`changes[${index}].baseRevision must be a non-negative integer`);
    }
  });
  return errors;
}
