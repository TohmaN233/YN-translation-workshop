import { epubDocumentPathsFromArchive, normalizeArchivePath, xhtmlToLines, type ArchiveFiles } from "./epubText.ts";

export interface TranslatedEpubTextFiles {
  files: ArchiveFiles;
  changedDocuments: number;
}

export interface EpubReplacementOptions {
  mode?: "all" | "pair-position";
  replacePosition?: number;
  pairSize?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shouldReplaceLine(lineIndex: number, options: Required<EpubReplacementOptions>): boolean {
  if (options.mode === "all") {
    return true;
  }
  return (lineIndex % options.pairSize) + 1 === options.replacePosition;
}

function replacementForCurrentLine(
  originalText: string,
  translatedLines: string[],
  options: Required<EpubReplacementOptions>,
  counters: { lineIndex: number; replacementIndex: number }
): string | undefined {
  const currentLineIndex = counters.lineIndex;
  counters.lineIndex += 1;
  if (!shouldReplaceLine(currentLineIndex, options)) {
    return undefined;
  }
  if (counters.replacementIndex >= translatedLines.length) {
    return undefined;
  }
  const replacement = translatedLines[counters.replacementIndex] ?? "";
  counters.replacementIndex += 1;
  return replacement === originalText ? undefined : replacement;
}

function replaceInlineSpanLines(
  inner: string,
  translatedLines: string[],
  options: Required<EpubReplacementOptions>,
  counters: { lineIndex: number; replacementIndex: number }
): { inner: string; changed: boolean; handledLines: number } {
  let changed = false;
  let handledLines = 0;
  const nextInner = inner.replace(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi, (match, attrs: string, spanInner: string) => {
    const visibleLines = xhtmlToLines(spanInner);
    handledLines += visibleLines.length;
    if (visibleLines.length !== 1) {
      counters.lineIndex += visibleLines.length;
      return match;
    }
    const replacement = replacementForCurrentLine(visibleLines[0], translatedLines, options, counters);
    if (replacement === undefined) {
      return match;
    }
    changed = true;
    return `<span${attrs}>${escapeXml(replacement)}</span>`;
  });
  return { inner: nextInner, changed, handledLines };
}

function replaceXhtmlLinesInPlace(
  xhtml: string,
  translatedLines: string[],
  options: Required<EpubReplacementOptions>,
  counters: { lineIndex: number; replacementIndex: number }
): { xhtml: string; changed: boolean } {
  let changed = false;
  const nextXhtml = xhtml.replace(/<(h[1-6]|p|li|dt|dd|figcaption|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tag: string, attrs: string, inner: string) => {
    const visibleLines = xhtmlToLines(inner);
    if (visibleLines.length !== 1) {
      const inlineResult = replaceInlineSpanLines(inner, translatedLines, options, counters);
      if (inlineResult.handledLines > 0) {
        changed = changed || inlineResult.changed;
        return `<${tag}${attrs}>${inlineResult.inner}</${tag}>`;
      }
      counters.lineIndex += visibleLines.length;
      return match;
    }

    const replacement = replacementForCurrentLine(visibleLines[0], translatedLines, options, counters);
    if (replacement === undefined) {
      return match;
    }
    changed = true;
    return `<${tag}${attrs}>${escapeXml(replacement)}</${tag}>`;
  });
  return { xhtml: nextXhtml, changed };
}

export function buildTranslatedEpubTextFiles(files: ArchiveFiles, translatedLines: string[], replacementOptions: EpubReplacementOptions = {}): TranslatedEpubTextFiles {
  const normalizedFiles = Object.fromEntries(
    Object.entries(files).map(([filePath, content]) => [normalizeArchivePath(filePath), content])
  );
  const documentPaths = epubDocumentPathsFromArchive(normalizedFiles);
  if (documentPaths.length === 0) {
    throw new Error("EPUB export failed: no writable XHTML/HTML spine documents were found.");
  }

  const options: Required<EpubReplacementOptions> = {
    mode: replacementOptions.mode ?? "all",
    replacePosition: Math.max(1, Math.floor(replacementOptions.replacePosition ?? 1)),
    pairSize: Math.max(1, Math.floor(replacementOptions.pairSize ?? 2))
  };
  const nextFiles: ArchiveFiles = { ...normalizedFiles };
  const counters = { lineIndex: 0, replacementIndex: 0 };
  let changedDocuments = 0;

  for (const documentPath of documentPaths) {
    const result = replaceXhtmlLinesInPlace(normalizedFiles[documentPath] ?? "", translatedLines, options, counters);
    nextFiles[documentPath] = result.xhtml;
    if (result.changed) {
      changedDocuments += 1;
    }
  }

  return {
    files: nextFiles,
    changedDocuments
  };
}
