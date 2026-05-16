export type FolderMatchStatus = "matched" | "missing-translation" | "line-count-mismatch";

export interface FolderLineFile {
  name: string;
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
  const translationsByName = new Map(translationFiles.map((file) => [file.name.toLowerCase(), file]));

  return [...sourceFiles]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((source) => {
      const translation = translationsByName.get(source.name.toLowerCase());
      if (!translation) {
        return {
          sourceName: source.name,
          sourcePath: source.path,
          sourceLineCount: source.lineCount,
          status: "missing-translation" as const
        };
      }

      return {
        sourceName: source.name,
        sourcePath: source.path,
        sourceLineCount: source.lineCount,
        translationName: translation.name,
        translationPath: translation.path,
        translationLineCount: translation.lineCount,
        status: source.lineCount === translation.lineCount ? "matched" as const : "line-count-mismatch" as const
      };
    });
}
