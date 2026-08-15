// Pure candidate-translation artifact discovery.
//
// Initial-translation jobs (Codex / Claude / API) conventionally write their
// output to <project>/AI_translation/<basename>_translated.txt. This module
// scans a project output directory for those candidate artifacts so the host
// can surface them as import cards in the workbench, run the line-aligned
// validator, and let the user import a candidate as a draft without
// overwriting the final translation TXT.
//
// Pure (no fs) so it can be unit-tested; the IPC layer supplies readdir/stat.

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
}

/**
 * Match a candidate artifact to a source file by basename. A candidate named
 * `chapter03_translated.txt` matches a source named `chapter03.txt` (or any
 * extension). When no source matches, the candidate is still returned without
 * a sourcePath — the UI will ask the user to bind one before importing.
 */
export function matchCandidateToSource(
  candidate: CandidateArtifact,
  sources: SourceEntry[]
): DiscoveredArtifact {
  const candidateBase = candidate.basename.toLowerCase();
  const exact = sources.find((s) => s.basename.toLowerCase() === candidateBase);
  if (exact) {
    return { ...candidate, sourcePath: exact.path, sourceBasename: exact.basename };
  }
  // Fall back to a starts-with match: `chapter03` -> `chapter03_intro.txt`.
  const prefix = sources.find(
    (s) => s.basename.toLowerCase().startsWith(candidateBase) || candidateBase.startsWith(s.basename.toLowerCase())
  );
  if (prefix) {
    return { ...candidate, sourcePath: prefix.path, sourceBasename: prefix.basename };
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
  const directories = [pathJoin(projectDir, "AI_translation")];
  const seen = new Set<string>();
  const artifacts: CandidateArtifact[] = [];

  for (const dir of directories) {
    const bucket = listing.find((entry) => normalizePath(entry.directory) === normalizePath(dir));
    if (!bucket) {
      continue;
    }
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
        directory: dir
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
