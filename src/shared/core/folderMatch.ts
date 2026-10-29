export type FolderMatchStatus = "matched" | "missing-translation" | "line-count-mismatch";

export interface FolderLineFile {
  name: string;
  relativePath?: string;
  path: string;
  lineCount: number;
}

export interface FolderFileMatch {
  sourceName: string;
  sourcePath: string;
  sourceLineCount: number;
  translationName?: string;
  translationPath?: string;
  translationLineCount?: number;
  status: FolderMatchStatus;
}

function normalizedRelativeName(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function relativeName(file: { name: string; relativePath?: string }): string {
  return file.relativePath || file.name;
}

function directoryName(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0 ? "" : relativePath.slice(0, separator);
}

function baseName(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0 ? relativePath : relativePath.slice(separator + 1);
}

function sourceStem(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
}

function ambiguousSourceMatch(translationRelativeName: string, candidates: readonly { name: string; relativePath?: string }[]): Error {
  const names = candidates.map(relativeName).join(", ");
  return new Error(`Ambiguous source match for translation "${translationRelativeName}": ${names}.`);
}

/** Match a translation artifact to one source by normalized relative identity. */
export function matchTranslationSource<T extends { name: string; relativePath?: string }>(
  translationRelativeName: string,
  sources: readonly T[]
): T | undefined {
  const translationKey = normalizedRelativeName(translationRelativeName);
  const exactMatches = sources.filter((source) => (
    normalizedRelativeName(relativeName(source)) === translationKey
  ));
  if (exactMatches.length > 1) throw ambiguousSourceMatch(translationRelativeName, exactMatches);
  if (exactMatches.length === 1) return exactMatches[0];

  const translationDirectory = directoryName(translationKey);
  const translationFileName = baseName(translationKey);
  const matches = sources.filter((source) => {
    const sourceKey = normalizedRelativeName(relativeName(source));
    if (directoryName(sourceKey) !== translationDirectory) return false;
    const stem = sourceStem(baseName(sourceKey));
    return translationFileName === `${stem}.txt`
      || translationFileName === `${stem}_translated.txt`
      || translationFileName === `${stem}.translated.txt`;
  });
  if (matches.length > 1) throw ambiguousSourceMatch(translationRelativeName, matches);
  return matches[0];
}

export function matchFolderFiles(sourceFiles: FolderLineFile[], translationFiles: FolderLineFile[] = []): FolderFileMatch[] {
  const translationsBySource = new Map<FolderLineFile, FolderLineFile[]>();
  for (const translation of translationFiles) {
    const source = matchTranslationSource(relativeName(translation), sourceFiles);
    if (!source) continue;
    const translations = translationsBySource.get(source) ?? [];
    translations.push(translation);
    translationsBySource.set(source, translations);
  }

  const displayName = (file: FolderLineFile): string => relativeName(file).replace(/\\/g, "/");

  return [...sourceFiles]
    .sort((left, right) => displayName(left).localeCompare(displayName(right), undefined, { sensitivity: "base" }))
    .map((source) => {
      const sourceName = displayName(source);
      const sourceTranslations = translationsBySource.get(source) ?? [];
      if (sourceTranslations.length > 1) {
        throw new Error(
          `Ambiguous translations for source "${sourceName}": ${sourceTranslations.map(displayName).join(", ")}.`
        );
      }
      const translation = sourceTranslations[0];
      if (!translation) {
        return {
          sourceName,
          sourcePath: source.path,
          sourceLineCount: source.lineCount,
          status: "missing-translation" as const
        };
      }

      return {
        sourceName,
        sourcePath: source.path,
        sourceLineCount: source.lineCount,
        translationName: displayName(translation),
        translationPath: translation.path,
        translationLineCount: translation.lineCount,
        status: source.lineCount === translation.lineCount ? "matched" as const : "line-count-mismatch" as const
      };
    });
}
