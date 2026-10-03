import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  compileCustomPreserveRule,
  type CanonicalCustomPreserveRule
} from "../../shared/validation/customPreserveRules.ts";
import type {
  SourcePreparationExample,
  SourcePreparationFileDigest,
  SourcePreparationPatternReport,
  SourcePreparationRuleEvaluation,
  SourcePreparationScanReport
} from "./sourcePreparationScan.ts";

interface WorkerInput {
  files: string[];
  rules: CanonicalCustomPreserveRule[];
  exampleLimit: number;
  exampleTextLimit: number;
}

interface MatchRecord {
  text: string;
  index: number;
}

interface MutablePattern {
  label: string;
  pattern: string;
  flags: string;
  regex: RegExp;
  matchCount: number;
  linesWithMatches: number;
  filesWithMatches: Set<string>;
  examples: SourcePreparationExample[];
}

interface MutableRuleEvaluation extends MutablePattern {
  fullLineMatches: number;
}

const CANDIDATE_DEFINITIONS: Array<{ label: string; pattern: string; flags: string }> = [
  {
    label: "literal newline/tab escape",
    pattern: String.raw`\\[nrt]|/[nrt]`,
    flags: "gu"
  },
  {
    label: "printf-style format placeholder",
    pattern: String.raw`%(?:\d+\$)?[-+#0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:(?:hh|h|ll|l|j|z|t)[diuoxX]|(?:l|L)?[fFeEgGaA]|(?:hh|h|ll|l)?[cspn])`,
    flags: "gu"
  },
  {
    label: "named or numbered brace placeholder",
    pattern: String.raw`\{\{?[A-Za-z_][A-Za-z0-9_.:-]*\}?\}|\{[0-9]+\}`,
    flags: "gu"
  },
  {
    label: "backslash control token",
    pattern: String.raw`\\(?:[A-Z]{1,8}(?:\[[^\]\r\n]{1,80}\])?(?![A-Za-z])|[nrt](?![A-Za-z])|[0-9]{1,3}(?![A-Za-z0-9])|[^A-Za-z0-9\s])`,
    flags: "gu"
  },
  {
    label: "XML-like tag",
    pattern: String.raw`<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[^<>\r\n]*)?\/?>`,
    flags: "gu"
  },
  {
    label: "command-style bracket or line prefix",
    pattern: String.raw`^\s*\[(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|(?:WAIT|SPEED|COLOR|FONT|SIZE|RUBY|VOICE|JUMP|CHOICE|FLAG|VAR|IF|ENDIF|BGM|SE|FADE)(?:[:=][^\]\r\n]+))\]|^\s*@(IF|ELSE|ENDIF|JUMP|CHOICE|LABEL|CALL|RETURN|SET|VOICE)\b`,
    flags: "gimu"
  }
];

const input = workerData as WorkerInput;
const candidates: MutablePattern[] = CANDIDATE_DEFINITIONS.map((definition) => ({
  ...definition,
  regex: new RegExp(definition.pattern, definition.flags),
  matchCount: 0,
  linesWithMatches: 0,
  filesWithMatches: new Set<string>(),
  examples: []
}));

function lineExcerpt(value: string, maxLength: number, centerAt = 0): { text: string; truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  const start = Math.min(Math.max(0, centerAt - Math.floor(maxLength / 3)), value.length - maxLength);
  return { text: value.slice(start, start + maxLength), truncated: true };
}

function exampleFor(args: {
  filePath: string;
  lineNo: number;
  line: string;
  match: MatchRecord;
  previousLine?: string;
  exampleTextLimit: number;
}): SourcePreparationExample {
  const text = lineExcerpt(args.line, args.exampleTextLimit, args.match.index);
  const match = args.match.text.length <= args.exampleTextLimit
    ? { text: args.match.text, truncated: false }
    : { text: args.match.text.slice(0, args.exampleTextLimit), truncated: true };
  return {
    path: args.filePath,
    line: args.lineNo,
    text: text.text,
    match: match.text,
    textTruncated: text.truncated,
    matchTruncated: match.truncated,
    ...(args.previousLine === undefined ? {} : {
      before: {
        line: args.lineNo - 1,
        ...lineExcerpt(args.previousLine, args.exampleTextLimit)
      }
    })
  };
}

function findMatches(regex: RegExp, line: string): MatchRecord[] {
  regex.lastIndex = 0;
  const matches: MatchRecord[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match[0].length === 0) {
      throw new Error(`Rule /${regex.source}/${regex.flags} matched an empty string on a source line.`);
    }
    matches.push({ text: match[0], index: match.index });
  }
  regex.lastIndex = 0;
  return matches;
}

async function* readUtf8Lines(
  filePath: string,
  onBytes: (chunk: Uint8Array) => void
): AsyncGenerator<string> {
  const stream = createReadStream(filePath);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = "";
  let sawBytes = false;
  let sawLineFeed = false;
  for await (const rawChunk of stream) {
    const chunk = rawChunk as Buffer;
    sawBytes = true;
    onBytes(chunk);
    pending += decoder.decode(chunk, { stream: true });
    let lineFeed = pending.indexOf("\n");
    while (lineFeed >= 0) {
      let line = pending.slice(0, lineFeed);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
      pending = pending.slice(lineFeed + 1);
      sawLineFeed = true;
      lineFeed = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  const finalLine = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
  if (finalLine.length > 0 || (!sawLineFeed && sawBytes)) yield finalLine;
}

function recordLineMatches(args: {
  stat: MutablePattern;
  filePath: string;
  lineNo: number;
  line: string;
  matches: MatchRecord[];
  previousLine?: string;
  pendingExamples: SourcePreparationExample[];
  exampleLimit: number;
  exampleTextLimit: number;
}): void {
  if (args.matches.length === 0) return;
  args.stat.matchCount += args.matches.length;
  args.stat.linesWithMatches += 1;
  args.stat.filesWithMatches.add(args.filePath);
  if (args.stat.examples.length >= args.exampleLimit) return;
  const example = exampleFor({
    filePath: args.filePath,
    lineNo: args.lineNo,
    line: args.line,
    match: args.matches[0],
    previousLine: args.previousLine,
    exampleTextLimit: args.exampleTextLimit
  });
  args.stat.examples.push(example);
  args.pendingExamples.push(example);
}

async function scanCandidates(
  files: string[],
  exampleLimit: number,
  exampleTextLimit: number
): Promise<SourcePreparationFileDigest[]> {
  const digests: SourcePreparationFileDigest[] = [];
  for (const filePath of files) {
    const hash = createHash("sha256");
    let lineCount = 0;
    let previousLine: string | undefined;
    const head: SourcePreparationFileDigest["samples"] = [];
    const tail: SourcePreparationFileDigest["samples"] = [];
    const pendingExamples: SourcePreparationExample[] = [];
    for await (const line of readUtf8Lines(filePath, (chunk) => hash.update(chunk))) {
      const lineNo = ++lineCount;
      const sample = { line: lineNo, ...lineExcerpt(line, exampleTextLimit) };
      if (head.length < exampleLimit / 2) head.push(sample);
      tail.push(sample);
      if (tail.length > exampleLimit / 2) tail.shift();
      for (const example of pendingExamples) {
        example.after = {
          line: lineNo,
          ...lineExcerpt(line, exampleTextLimit)
        };
      }
      pendingExamples.length = 0;
      for (const candidate of candidates) {
        recordLineMatches({
          stat: candidate,
          filePath,
          lineNo,
          line,
          matches: findMatches(candidate.regex, line),
          previousLine,
          pendingExamples,
          exampleLimit,
          exampleTextLimit
        });
      }
      previousLine = line;
      if (lineCount % 512 === 0) parentPort?.postMessage({ type: "scan-progress", filePath, lineCount });
    }
    const samples = [...new Map([...head, ...tail].map(sample => [sample.line, sample])).values()];
    digests.push({ path: filePath, sha256: hash.digest("hex"), lineCount, samples });
  }
  return digests;
}

function isFullLineMatch(line: string, matches: MatchRecord[]): boolean {
  const firstContent = line.search(/\S/u);
  if (firstContent < 0) return false;
  let lastContent = line.length - 1;
  while (lastContent >= firstContent && /\s/u.test(line[lastContent])) lastContent -= 1;
  return matches.some((match) => match.index <= firstContent && match.index + match.text.length - 1 >= lastContent);
}

async function evaluateRules(
  files: string[],
  rules: CanonicalCustomPreserveRule[],
  totalLines: number,
  exampleLimit: number,
  exampleTextLimit: number
): Promise<SourcePreparationRuleEvaluation[]> {
  const evaluations: SourcePreparationRuleEvaluation[] = [];
  for (const [index, rule] of rules.entries()) {
    parentPort?.postMessage({ type: "rule-start", index, label: rule.label ?? "", pattern: rule.pattern });
    const stat: MutableRuleEvaluation = {
      label: rule.label ?? `Custom preserve rule ${index + 1}`,
      pattern: rule.pattern,
      flags: rule.flags,
      regex: compileCustomPreserveRule(rule),
      matchCount: 0,
      linesWithMatches: 0,
      filesWithMatches: new Set<string>(),
      examples: [],
      fullLineMatches: 0
    };
  for (const filePath of files) {
    let lineCount = 0;
    let previousLine: string | undefined;
    const pendingExamples: SourcePreparationExample[] = [];
    let lastProgressAt = Date.now();
    for await (const line of readUtf8Lines(filePath, () => undefined)) {
        const lineNo = ++lineCount;
        for (const example of pendingExamples) {
          example.after = { line: lineNo, ...lineExcerpt(line, exampleTextLimit) };
        }
        pendingExamples.length = 0;
        const matches = findMatches(stat.regex, line);
        if (matches.length > 0 && isFullLineMatch(line, matches)) stat.fullLineMatches += 1;
        recordLineMatches({
          stat,
          filePath,
          lineNo,
          line,
          matches,
          previousLine,
          pendingExamples,
          exampleLimit,
          exampleTextLimit
        });
        previousLine = line;
        const now = Date.now();
        if (lineCount % 128 === 0 || now - lastProgressAt >= 250) {
          parentPort?.postMessage({ type: "rule-progress", index });
          lastProgressAt = now;
        }
      }
      parentPort?.postMessage({ type: "rule-progress", index });
    }
    stat.regex.lastIndex = 0;
    const fileCount = files.length;
    evaluations.push({
      label: stat.label,
      pattern: stat.pattern,
      flags: stat.flags,
      matchCount: stat.matchCount,
      linesWithMatches: stat.linesWithMatches,
      filesWithMatches: stat.filesWithMatches.size,
      examples: stat.examples,
      totalLines,
      fullLineMatches: stat.fullLineMatches,
      lineCoverage: totalLines ? stat.linesWithMatches / totalLines : 0,
      fileCoverage: fileCount ? stat.filesWithMatches.size / fileCount : 0
    });
    parentPort?.postMessage({ type: "rule-complete", index });
  }
  return evaluations;
}

async function scan(input: WorkerInput): Promise<SourcePreparationScanReport> {
  const files = await scanCandidates(input.files, input.exampleLimit, input.exampleTextLimit);
  const totalLines = files.reduce((total, file) => total + file.lineCount, 0);
  const existingRules = await evaluateRules(
    input.files,
    input.rules,
    totalLines,
    input.exampleLimit,
    input.exampleTextLimit
  );
  const candidateReports: SourcePreparationPatternReport[] = candidates
    .filter((candidate) => candidate.matchCount > 0)
    .map((candidate) => ({
      label: candidate.label,
      pattern: candidate.pattern,
      flags: candidate.flags,
      matchCount: candidate.matchCount,
      linesWithMatches: candidate.linesWithMatches,
      filesWithMatches: candidate.filesWithMatches.size,
      examples: candidate.examples
    }));
  return {
    files,
    totalFiles: files.length,
    totalLines,
    candidates: candidateReports,
    existingRules,
    exampleLimit: input.exampleLimit,
    exampleTextLimit: input.exampleTextLimit
  };
}

void scan(input).then((report) => {
  parentPort?.postMessage({ type: "result", report });
}).catch((error: unknown) => {
  parentPort?.postMessage({
    type: "failure",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
  });
});
