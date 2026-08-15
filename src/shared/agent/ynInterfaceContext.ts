export type YnInterfacePageKind = "line-review" | "proposal-review" | "workspace";

export interface YnInterfaceFocusedLine {
  line: number;
  source: string;
  translation: string;
  status?: string;
  selectedSourceText?: string;
}

export interface YnInterfaceContext {
  version: 1;
  outputDir: string;
  htmlPath?: string;
  pageKind: YnInterfacePageKind;
  sourcePath?: string;
  translationPath?: string;
  page?: number;
  pageSize?: number;
  scrollTop?: number;
  activeLine?: number;
  visibleLineStart?: number;
  visibleLineEnd?: number;
  focusedLine?: YnInterfaceFocusedLine;
  updatedAt: number;
}

export interface YnInterfaceContextSnapshot {
  available: boolean;
  stale?: boolean;
  context?: YnInterfaceContext;
}

export type YnInterfaceContextPublishResult =
  | { ok: true }
  | { ok: false; message: string };
