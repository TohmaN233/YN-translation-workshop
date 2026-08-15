export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface GlossaryReplacementResult {
  lines: string[];
  changedLineNumbers: number[];
  replacementCount: number;
}

export interface GlossaryReplacementOptions {
  skipLineNumbers?: Set<number>;
  lineNumbers?: number[];
}

export interface GlossaryCandidateReplacement {
  target: string;
  candidates: string[];
}

export interface GlossaryTermAuditIssue {
  code: "H3";
  severity: "H";
  source: string;
  target: string;
  sourceCount: number;
  targetCount: number;
}

interface GlossaryCountCandidate {
  key: number;
  candidates: string[];
}

function cleanTerm(value: unknown): string {
  return String(value ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

function entryFromObject(value: Record<string, unknown>): GlossaryEntry | undefined {
  const source = cleanTerm(value.source ?? value.src ?? value.original ?? value.term ?? value["原文"] ?? value["源文"] ?? value["术语"]);
  const target = cleanTerm(value.target ?? value.dst ?? value.translation ?? value.translated ?? value["译文"] ?? value["标准译名"] ?? value["译名"]);
  return source && target ? { source, target } : undefined;
}

function parseJsonGlossary(text: string): GlossaryEntry[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const entries: GlossaryEntry[] = [];
    const appendArray = (items: unknown[]) => {
      for (const item of items) {
        if (Array.isArray(item)) {
          const source = cleanTerm(item[0]);
          const target = cleanTerm(item[1]);
          if (source && target) {
            entries.push({ source, target });
          }
          continue;
        }
        if (item && typeof item === "object") {
          const entry = entryFromObject(item as Record<string, unknown>);
          if (entry) entries.push(entry);
        }
      }
    };
    if (Array.isArray(parsed)) {
      appendArray(parsed);
      return entries;
    }
    if (parsed && typeof parsed === "object") {
      const object = parsed as Record<string, unknown>;
      const collection = object.entries ?? object.glossary ?? object.terms;
      if (Array.isArray(collection)) {
        appendArray(collection);
        return entries;
      }
      for (const [source, target] of Object.entries(object)) {
        if (typeof target === "string") {
          const entry = { source: cleanTerm(source), target: cleanTerm(target) };
          if (entry.source && entry.target) entries.push(entry);
        }
      }
      return entries;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function splitGlossaryLine(line: string): [string, string] | undefined {
  const separators = ["\t", "=>", "->", "=", ","];
  for (const separator of separators) {
    const index = line.indexOf(separator);
    if (index <= 0) {
      continue;
    }
    const source = cleanTerm(line.slice(0, index));
    const target = cleanTerm(line.slice(index + separator.length));
    if (source && target) {
      return [source, target];
    }
  }
  return undefined;
}

export function parseGlossaryText(text: string): GlossaryEntry[] {
  const jsonEntries = parseJsonGlossary(text);
  const rawEntries = jsonEntries ?? text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"))
    .map(splitGlossaryLine)
    .filter((entry): entry is [string, string] => Boolean(entry))
    .map(([source, target]) => ({ source, target }));

  const seen = new Set<string>();
  return rawEntries.filter((entry) => {
    const key = entry.source.toLocaleLowerCase();
    if (seen.has(key) || entry.source === entry.target) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function replaceGlossaryByLongestMatch(
  text: string,
  items: GlossaryCandidateReplacement[]
): { text: string; replacementCount: number } {
  const candidates = items
    .flatMap((item) => item.candidates.map((source) => ({ source, target: item.target })))
    .map((item) => ({ source: item.source.trim(), target: item.target }))
    .filter((item) => item.source && item.target && item.source !== item.target)
    .sort((left, right) => right.source.length - left.source.length);

  if (candidates.length === 0) {
    return { text, replacementCount: 0 };
  }

  let output = "";
  let index = 0;
  let replacementCount = 0;
  while (index < text.length) {
    const match = candidates.find((candidate) => text.startsWith(candidate.source, index));
    if (match) {
      output += match.target;
      index += match.source.length;
      replacementCount += 1;
      continue;
    }
    output += text[index];
    index += 1;
  }

  return { text: output, replacementCount };
}

function countLongestGlossaryMatches(text: string, items: GlossaryCountCandidate[]): Map<number, number> {
  const candidates = items
    .flatMap((item) => item.candidates.map((source) => ({ source: source.trim(), key: item.key })))
    .filter((item) => item.source)
    .sort((left, right) => right.source.length - left.source.length);
  const counts = new Map<number, number>();
  let index = 0;
  while (index < text.length) {
    const match = candidates.find((candidate) => text.startsWith(candidate.source, index));
    if (match) {
      counts.set(match.key, (counts.get(match.key) ?? 0) + 1);
      index += match.source.length;
      continue;
    }
    index += 1;
  }
  return counts;
}

export function auditGlossaryTermCounts(
  sourceText: string,
  translationText: string,
  entries: GlossaryEntry[]
): GlossaryTermAuditIssue[] {
  const validEntries = entries.filter((entry) => entry.source && entry.target && entry.source !== entry.target);
  const sourceCounts = countLongestGlossaryMatches(sourceText, validEntries.map((entry, index) => ({ key: index, candidates: [entry.source] })));
  const targetCounts = countLongestGlossaryMatches(translationText, validEntries.map((entry, index) => ({ key: index, candidates: [entry.target] })));

  return validEntries.flatMap((entry, index) => {
    const sourceCount = sourceCounts.get(index) ?? 0;
    const targetCount = targetCounts.get(index) ?? 0;
    if (sourceCount === targetCount) {
      return [];
    }
    return [{
      code: "H3" as const,
      severity: "H" as const,
      source: entry.source,
      target: entry.target,
      sourceCount,
      targetCount
    }];
  });
}

export function applyGlossaryReplacements(
  lines: string[],
  entries: GlossaryEntry[],
  options: GlossaryReplacementOptions = {}
): GlossaryReplacementResult {
  const replacementItems = entries.map((entry) => ({ target: entry.target, candidates: [entry.source] }));
  const nextLines = [...lines];
  const changedLineNumbers: number[] = [];
  let replacementCount = 0;

  for (let index = 0; index < nextLines.length; index += 1) {
    const lineNumber = options.lineNumbers?.[index] ?? index + 1;
    if (options.skipLineNumbers?.has(lineNumber)) {
      continue;
    }
    let value = nextLines[index] ?? "";
    let lineReplacementCount = 0;
    const replaced = replaceGlossaryByLongestMatch(value, replacementItems);
    value = replaced.text;
    lineReplacementCount += replaced.replacementCount;
    if (lineReplacementCount > 0) {
      nextLines[index] = value;
      changedLineNumbers.push(lineNumber);
      replacementCount += lineReplacementCount;
    }
  }

  return { lines: nextLines, changedLineNumbers, replacementCount };
}
