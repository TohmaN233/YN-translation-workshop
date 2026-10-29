import { normalizeEpubText, type EpubDocument } from "./epubDocument.ts";
import { epubDocumentPathsFromArchive, type ArchiveFiles } from "./epubText.ts";

interface LegacyLine { text: string; offsets: number[] }

export function extractLegacyEpubTextForVerification(files: ArchiveFiles): string {
  return epubDocumentPathsFromArchive(files).flatMap(file => legacyEpubLines(files[file]).map(line => line.text)).join("\n");
}

/** Retained solely to verify an existing pre-DOM projection, never to extract a new task. */
export function legacyEpubLines(xhtml: string): LegacyLine[] {
  let text = xhtml;
  let offsets = Array.from({ length: text.length }, (_, index) => index);
  const replace = (pattern: RegExp, value: string | ((match: RegExpMatchArray) => string)) => {
    const parts: string[] = [], nextOffsets: number[] = [];
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index!;
      parts.push(text.slice(start, index));
      for (let at = start; at < index; at++) nextOffsets.push(offsets[at]);
      const replacement = typeof value === "string" ? value : value(match);
      parts.push(replacement);
      for (let at = 0; at < replacement.length; at++) nextOffsets.push(offsets[index]);
      start = index + match[0].length;
    }
    parts.push(text.slice(start));
    for (let at = start; at < text.length; at++) nextOffsets.push(offsets[at]);
    text = parts.join(""); offsets = nextOffsets;
  };
  replace(/<script\b[\s\S]*?<\/script>/gi, "");
  replace(/<style\b[\s\S]*?<\/style>/gi, "");
  replace(/<head\b[\s\S]*?<\/head>/gi, "");
  replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  replace(/<br\s*\/?>/gi, "\n");
  replace(/<\/(h[1-6]|p|div|li|tr|section|article|blockquote)>/gi, "\n");
  replace(/<[^>]+>/g, "");
  replace(/&([a-zA-Z]+|#x[\da-fA-F]+|#\d+);/g, match => {
    const entity = match[1];
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[entity] ?? match[0];
  });
  const lines: LegacyLine[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const normalized = normalizeEpubText(line);
    if (normalized) lines.push({ text: normalized, offsets: offsets.slice(start, start + line.length) });
    start += line.length + 1;
  }
  return lines;
}

/** Source offsets prove ownership even when the same sentence appears many times. */
export function legacyEpubUnitIndexes(document: EpubDocument, legacy: LegacyLine[]): number[][] {
  const owners = new Map<number, number>();
  const ends = legacy.map(line => line.offsets.at(-1) ?? -1);
  return document.units.map((unit, unitIndex) => {
    const candidates = new Set<number>();
    for (const slice of unit.slices) {
      const start = slice.node.startIndex, end = slice.node.endIndex;
      if (start === null || start === undefined || end === null || end === undefined) throw new Error("EPUB legacy mapping has no source offsets.");
      let low = 0, high = ends.length;
      while (low < high) { const middle = (low + high) >>> 1; if (ends[middle] < start) low = middle + 1; else high = middle; }
      for (let index = low; index < legacy.length && legacy[index].offsets[0] <= end; index++) {
        if (legacy[index].offsets.some(offset => offset >= start && offset <= end)) candidates.add(index);
      }
    }
    const matches = [...candidates].sort((a, b) => a - b);
    for (const index of matches) {
      if (owners.has(index)) throw new Error("EPUB legacy projection combines distinct visible units; automatic export is unsafe.");
      owners.set(index, unitIndex);
    }
    if (!matches.length || normalizeEpubText(matches.map(index => legacy[index].text).join(" ")) !== unit.text) {
      throw new Error(`EPUB legacy projection cannot map visible unit ${unitIndex + 1} exactly; no output was written.`);
    }
    return matches;
  });
}
