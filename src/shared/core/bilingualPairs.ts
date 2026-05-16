export interface BilingualPairOptions {
  sourcePosition: number;
  translationPosition: number;
}

export interface BilingualPairResult {
  sourceText: string;
  translationText: string;
  rowCount: number;
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r$/, "")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseBilingualPairs(text: string, options: BilingualPairOptions): BilingualPairResult {
  const sourceIndex = Math.max(1, Math.min(2, Math.floor(options.sourcePosition || 2))) - 1;
  const translationIndex = Math.max(1, Math.min(2, Math.floor(options.translationPosition || 1))) - 1;
  if (sourceIndex === translationIndex) {
    throw new Error("Source position and translation position must be different.");
  }

  const lines = splitLines(text);
  const sourceLines: string[] = [];
  const translationLines: string[] = [];

  for (let index = 0; index < lines.length - 1; index += 2) {
    const pair = [lines[index], lines[index + 1]];
    sourceLines.push(pair[sourceIndex] ?? "");
    translationLines.push(pair[translationIndex] ?? "");
  }

  return {
    sourceText: sourceLines.join("\n"),
    translationText: translationLines.join("\n"),
    rowCount: sourceLines.length
  };
}
