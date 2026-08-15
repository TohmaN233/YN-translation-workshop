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

export function matchFolderFiles(sourceFiles: FolderLineFile[], translationFiles: FolderLineFile[] = []): FolderFileMatch[] {
  const key = (file: FolderLineFile): string => (file.relativePath || file.name).replace(/\\/g, "/").toLowerCase();
  const displayName = (file: FolderLineFile): string => (file.relativePath || file.name).replace(/\\/g, "/");
  const translationsByName = new Map(translationFiles.map((file) => [key(file), file]));

  return [...sourceFiles]
    .sort((left, right) => displayName(left).localeCompare(displayName(right), undefined, { sensitivity: "base" }))
    .map((source) => {
      const sourceName = displayName(source);
      const translation = translationsByName.get(key(source));
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
