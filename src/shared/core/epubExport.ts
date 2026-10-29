import { epubDocumentPathsFromArchive, normalizeArchivePath, type ArchiveFiles } from "./epubText.ts";
import { parseEpubDocument, replaceEpubUnits } from "./epubDocument.ts";
import { legacyEpubLines, legacyEpubUnitIndexes } from "./epubLegacyProjection.ts";
import { normalizeTranslatedEpubPresentation } from "./epubPresentation.ts";

export interface TranslatedEpubTextFiles {
  files: ArchiveFiles;
  changedDocuments: number;
  ignoredLegacyLines: number;
}

export interface EpubReplacementOptions {
  mode?: "all" | "pair-position";
  replacePosition?: number;
  pairSize?: number;
  targetLanguage?: string;
}

export function buildTranslatedEpubTextFiles(files: ArchiveFiles, translatedLines: string[], replacementOptions: EpubReplacementOptions = {}, sourceLines?: string[]): TranslatedEpubTextFiles {
  const normalizedFiles = Object.fromEntries(Object.entries(files).map(([filePath, content]) => [normalizeArchivePath(filePath), content]));
  const documents = epubDocumentPathsFromArchive(normalizedFiles).map(documentPath => {
    const xhtml = normalizedFiles[documentPath];
    if (xhtml === undefined) throw new Error(`EPUB export failed: spine document missing (${documentPath}).`);
    return { documentPath, xhtml, parsed: parseEpubDocument(xhtml) };
  });
  const mode = replacementOptions.mode ?? "all";
  const position = replacementOptions.replacePosition ?? 1, pairSize = replacementOptions.pairSize ?? 2;
  if (mode !== "all" && mode !== "pair-position" || !Number.isInteger(position) || !Number.isInteger(pairSize) || pairSize < 1 || position < 1 || position > pairSize) {
    throw new Error("EPUB export has invalid replacement positions.");
  }
  if (!translatedLines.every(line => typeof line === "string" && !/[\r\n]/.test(line))) throw new Error("EPUB export requires one physical line per translation unit.");
  const allUnits = documents.flatMap(document => document.parsed.units);
  if (mode === "pair-position" && allUnits.length % pairSize !== 0) throw new Error("EPUB export requires complete source/translation pairs; no output was written.");
  if (mode === "pair-position" && sourceLines) {
    const expectedSource = allUnits.filter((_, index) => index % pairSize !== position - 1).map(unit => unit.text);
    if (sourceLines.length !== expectedSource.length || sourceLines.some((line, index) => line !== expectedSource[index])) {
      throw new Error("EPUB export source projection differs from the non-replaced paired source; no output was written.");
    }
  }
  const selected = allUnits.filter((_, index) => mode === "all" || index % pairSize === position - 1);
  const currentSource = mode === "all" ? allUnits.map(unit => unit.text) : undefined;
  let targets = translatedLines;
  let ignoredLegacyLines = 0;
  if (sourceLines && mode === "all" && (sourceLines.length !== currentSource!.length || sourceLines.some((line, index) => line !== currentSource![index]))) {
    const legacy = documents.map(document => legacyEpubLines(document.xhtml));
    const legacySource = legacy.flat().map(line => line.text);
    if (sourceLines.length !== legacySource.length || sourceLines.some((line, index) => line !== legacySource[index]) || translatedLines.length !== sourceLines.length) {
      throw new Error("EPUB export source projection differs from both the current and verified legacy template; no output was written.");
    }
    let offset = 0;
    targets = documents.flatMap((document, index) => {
      const indexes = legacyEpubUnitIndexes(document.parsed, legacy[index]);
      const mapped = indexes.map(group => group.map(at => translatedLines[offset + at]).join(" "));
      ignoredLegacyLines += legacy[index].length - new Set(indexes.flat()).size;
      offset += legacy[index].length;
      return mapped;
    });
  }
  if (targets.length !== selected.length || !selected.length) {
    throw new Error(`EPUB export line count mismatch: expected ${selected.length} visible units, received ${targets.length}; no output was written.`);
  }
  const nextFiles: ArchiveFiles = { ...normalizedFiles };
  let line = 0, target = 0, changedDocuments = 0;
  for (const document of documents) {
    const replacements = new Map<number, string>();
    document.parsed.units.forEach((unit, index) => {
      if (mode === "all" || line % pairSize === position - 1) {
        const replacement = targets[target++];
        if (replacement !== unit.text) replacements.set(index, replacement);
      }
      line++;
    });
    replaceEpubUnits(document.parsed, replacements);
    nextFiles[document.documentPath] = replacements.size ? document.parsed.$.xml() : document.xhtml;
    if (replacements.size) changedDocuments++;
  }
  const resultFiles = mode === "all" ? normalizeTranslatedEpubPresentation(nextFiles, replacementOptions.targetLanguage ?? "") : nextFiles;
  return { files: resultFiles, changedDocuments, ignoredLegacyLines };
}
