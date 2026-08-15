import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { splitTextLines } from "../../shared/validation/translationValidator.ts";

export interface TranslationMemoryStats {
  path: string;
  available: boolean;
  initialized: boolean;
  segmentCount: number;
  updatedAt?: string;
  error?: string;
}

export interface TranslationMemoryMatch {
  sourcePath: string;
  line: number;
  sourceText: string;
  targetText: string;
  targetPath: string;
  languagePair: string;
  updatedAt: string;
}

export interface SearchTranslationMemoryResult {
  path: string;
  available: boolean;
  initialized: boolean;
  query: string;
  matches: TranslationMemoryMatch[];
  error?: string;
}

export interface RememberTranslationSegmentsArgs {
  outputDir: string;
  sourceText: string;
  targetText: string;
  sourcePath?: string;
  targetPath?: string;
  languagePair?: string;
}

type DatabaseSyncLike = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
  };
  close(): void;
};

type DatabaseSyncCtor = new (filename: string) => DatabaseSyncLike;

function projectDir(outputDir: string): string {
  return path.basename(outputDir).toLowerCase() === ".translation-workshop"
    ? path.dirname(outputDir)
    : outputDir;
}

export function translationMemoryPath(outputDir: string): string {
  return path.join(projectDir(outputDir), ".translation-workshop", "translation_memory.sqlite");
}

async function loadDatabaseSync(): Promise<DatabaseSyncCtor | undefined> {
  try {
    const sqliteSpecifier = "node:sqlite";
    const sqlite = await import(sqliteSpecifier);
    return (sqlite as { DatabaseSync?: DatabaseSyncCtor }).DatabaseSync;
  } catch {
    return undefined;
  }
}

async function openTranslationMemory(outputDir: string): Promise<{ db?: DatabaseSyncLike; filePath: string; error?: string }> {
  const filePath = translationMemoryPath(outputDir);
  const DatabaseSync = await loadDatabaseSync();
  if (!DatabaseSync) {
    return { filePath, error: "node:sqlite is not available in this runtime." };
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS translation_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL DEFAULT '',
      line INTEGER NOT NULL,
      source_text TEXT NOT NULL,
      target_text TEXT NOT NULL,
      target_path TEXT NOT NULL DEFAULT '',
      language_pair TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_path, line, source_text)
    );
    CREATE INDEX IF NOT EXISTS idx_translation_segments_source_text
      ON translation_segments(source_text);
    CREATE INDEX IF NOT EXISTS idx_translation_segments_updated_at
      ON translation_segments(updated_at);
  `);
  return { db, filePath };
}

export async function readTranslationMemoryStats(outputDir: string): Promise<TranslationMemoryStats> {
  const filePath = translationMemoryPath(outputDir);
  try {
    await stat(filePath);
  } catch {
    return {
      path: filePath,
      available: true,
      initialized: false,
      segmentCount: 0
    };
  }

  const { db, error } = await openTranslationMemory(outputDir);
  if (!db) {
    return {
      path: filePath,
      available: false,
      initialized: true,
      segmentCount: 0,
      error
    };
  }
  try {
    const row = db.prepare("SELECT COUNT(*) AS segmentCount, MAX(updated_at) AS updatedAt FROM translation_segments").get() ?? {};
    return {
      path: filePath,
      available: true,
      initialized: true,
      segmentCount: Number(row.segmentCount ?? 0),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined
    };
  } finally {
    db.close();
  }
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function memoryMatchFromRow(row: Record<string, unknown>): TranslationMemoryMatch {
  return {
    sourcePath: String(row.source_path ?? ""),
    line: Number(row.line ?? 0),
    sourceText: String(row.source_text ?? ""),
    targetText: String(row.target_text ?? ""),
    targetPath: String(row.target_path ?? ""),
    languagePair: String(row.language_pair ?? ""),
    updatedAt: String(row.updated_at ?? "")
  };
}

export async function searchTranslationMemory(args: {
  outputDir: string;
  query?: string;
  maxResults?: number;
}): Promise<SearchTranslationMemoryResult> {
  const filePath = translationMemoryPath(args.outputDir);
  const query = String(args.query ?? "").trim();
  const maxResults = Math.min(Math.max(Math.floor(Number(args.maxResults ?? 12)) || 12, 1), 50);
  try {
    await stat(filePath);
  } catch {
    return { path: filePath, available: true, initialized: false, query, matches: [] };
  }

  const { db, error } = await openTranslationMemory(args.outputDir);
  if (!db) {
    return { path: filePath, available: false, initialized: true, query, matches: [], error };
  }
  try {
    const rows = query
      ? db.prepare(`
          SELECT source_path, line, source_text, target_text, target_path, language_pair, updated_at
          FROM translation_segments
          WHERE source_text LIKE ? ESCAPE '\\' OR target_text LIKE ? ESCAPE '\\'
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(likePattern(query), likePattern(query), maxResults)
      : db.prepare(`
          SELECT source_path, line, source_text, target_text, target_path, language_pair, updated_at
          FROM translation_segments
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(maxResults);
    return {
      path: filePath,
      available: true,
      initialized: true,
      query,
      matches: rows.map(memoryMatchFromRow)
    };
  } finally {
    db.close();
  }
}

export async function rememberTranslationSegments(args: RememberTranslationSegmentsArgs): Promise<TranslationMemoryStats> {
  const sourceLines = splitTextLines(args.sourceText);
  const targetLines = splitTextLines(args.targetText);
  if (sourceLines.length !== targetLines.length) {
    throw new Error("Translation memory requires line-aligned source and target text.");
  }

  const { db, filePath, error } = await openTranslationMemory(args.outputDir);
  if (!db) {
    return {
      path: filePath,
      available: false,
      initialized: false,
      segmentCount: 0,
      error
    };
  }

  const now = new Date().toISOString();
  try {
    const insert = db.prepare(`
      INSERT INTO translation_segments (
        source_path,
        line,
        source_text,
        target_text,
        target_path,
        language_pair,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path, line, source_text) DO UPDATE SET
        target_text = excluded.target_text,
        target_path = excluded.target_path,
        language_pair = excluded.language_pair,
        updated_at = excluded.updated_at
    `);
    db.exec("BEGIN");
    try {
      for (let i = 0; i < sourceLines.length; i += 1) {
        const source = sourceLines[i].trim();
        const target = targetLines[i].trim();
        if (!source || !target) continue;
        insert.run(
          args.sourcePath ?? "",
          i + 1,
          sourceLines[i],
          targetLines[i],
          args.targetPath ?? "",
          args.languagePair ?? "",
          now,
          now
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }

  return readTranslationMemoryStats(args.outputDir);
}
