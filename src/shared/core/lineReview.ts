import { splitTextLines } from "../validation/translationValidator.ts";

export type LineStatus = "empty" | "machine" | "manual" | "term";

export interface LineReviewRow {
  line: number;
  source: string;
  translation: string;
  status: LineStatus;
  sourceLocked: true;
}

export interface PageResult<T> {
  page: number;
  pageSize: number;
  totalPages: number;
  totalRows: number;
  rows: T[];
}

export function buildLinePairs(sourceText: string, translationText?: string): LineReviewRow[] {
  const sourceLines = splitTextLines(sourceText);
  const translationLines = splitTextLines(translationText);

  return sourceLines.map((source, index) => {
    const translation = translationLines[index] ?? "";
    return {
      line: index + 1,
      source,
      translation,
      status: translation ? "machine" : "empty",
      sourceLocked: true
    };
  });
}

export function paginateRows<T>(rows: T[], requestedPageSize = 1000, requestedPage = 1): PageResult<T> {
  const pageSize = Math.max(1, Math.floor(requestedPageSize || 1000));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage || 1)), totalPages);
  const start = (page - 1) * pageSize;

  return {
    page,
    pageSize,
    totalPages,
    totalRows: rows.length,
    rows: rows.slice(start, start + pageSize)
  };
}
