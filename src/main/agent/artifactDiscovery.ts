// Pure candidate-translation artifact discovery.
//
// Agent translations use <project>/AI_translation/<relative document stem>_translated.txt.
// Match those document identities while validation reads their UTF-8 source
// projections. Import updates the review draft and leaves candidate TXT intact.
//
// Pure (no fs) so it can be unit-tested; the IPC layer supplies readdir/stat.
import { matchTranslationSource } from "../../shared/core/folderMatch.ts";

export interface CandidateArtifact {
  /** Absolute path to the candidate translation TXT. */
  path: string;
  /** Basename without extension, derived from the source or candidate filename. */
  basename: string;
  /** File size in bytes. */
  size: number;
  /** ISO timestamp of last modification. */
  modifiedAt: string;
  /** Directory the candidate lives in (typically <project>/AI_translation). */
  directory: string;
  /** Path relative to AI_translation, including any source subdirectory. */
  relativePath?: string;
}

export interface DiscoveredArtifact extends CandidateArtifact {
  /** Best-effort match to a source file under the project, when resolvable. */
  sourcePath?: string;
  /** Source basename, when a source match was found. */
  sourceBasename?: string;
}

const CANDIDATE_NAME_RE = /^(.+?)(_translated|\.translated)?$/i;

export function candidateBasename(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const match = base.match(CANDIDATE_NAME_RE);
  return match ? match[1] : base;
}

/**
 * Filter raw directory entries down to candidate translation TXTs.
 *
 * Heuristics, intentionally loose so we don't miss a valid candidate:
 * - .txt extension
 * - not a glossary / character-bible / state / workspace file
 *
 * Tightening is the validator's job; discovery stays permissive.
 */
export function isCandidateTranslationTxt(fileName: string): boolean {
  if (!/\.txt$/i.test(fileName)) {
    return false;
  }
  const lower = fileName.toLowerCase();
  const excluded = [
    "glossary",
    "character_bible",
    "translation_state",
    "_workspace",
    "readme"
  ];
  return !excluded.some((token) => lower.includes(token));
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  size: number;
  modifiedAt: string;
}

export interface SourceEntry {
  path: string;
  basename: string;
  /** Original document identity; path may be its extracted UTF-8 projection. */
  documentId?: string;
}

/**
 * Use the same relative document identity as initial folder matching. Reading
 * and validation follow the source's UTF-8 projection, not its display name.
 */
export function matchCandidateToSource(
  candidate: CandidateArtifact,
  sources: SourceEntry[]
): DiscoveredArtifact {
  const matched = matchTranslationSource(candidate.relativePath ?? candidate.path.replace(/\\/g, "/").split("/").at(-1)!, sources.map((source) => ({
    ...source,
    name: source.documentId ?? source.path.replace(/\\/g, "/").split("/").at(-1)!
  })));
  if (matched) {
    return { ...candidate, sourcePath: matched.path, sourceBasename: matched.basename };
  }
  return candidate;
}

/**
 * Discover candidate translation artifacts under the fixed agent output
 * directory only. Human source/target TXT files in the project root are not
 * candidates.
 */
export function discoverCandidateArtifacts(
  projectDir: string,
  listing: { directory: string; entries: DirEntry[] }[],
  sources: SourceEntry[] = []
): DiscoveredArtifact[] {
  const outputRoot = pathJoin(projectDir, "AI_translation");
  const normalizedRoot = normalizePath(outputRoot);
  const seen = new Set<string>();
  const artifacts: CandidateArtifact[] = [];

  for (const bucket of listing) {
    const normalizedDir = normalizePath(bucket.directory);
    if (normalizedDir !== normalizedRoot && !normalizedDir.startsWith(normalizedRoot + "/")) continue;
    const relativeDir = bucket.directory.replace(/\\/g, "/").replace(/\/+$/, "").slice(outputRoot.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\/+/, "");
    if (relativeDir.split("/").some((segment) => segment.toLowerCase() === "_workspace")) continue;
    const dir = bucket.directory;
    for (const entry of bucket.entries) {
      if (!entry.isFile || !isCandidateTranslationTxt(entry.name)) {
        continue;
      }
      const fullPath = pathJoin(dir, entry.name);
      const key = normalizePath(fullPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      artifacts.push({
        path: fullPath,
        basename: candidateBasename(entry.name),
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        directory: dir,
        relativePath: [relativeDir, entry.name].filter(Boolean).join("/")
      });
    }
  }

  const discovered = artifacts
    .map((artifact) => matchCandidateToSource(artifact, sources))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  return discovered;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function pathJoin(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return trimmed ? `${trimmed}${separator}${name}` : name;
}
