import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { writeTextFileAtomically } from "./atomicFile.ts";

const RECENT_PROJECT_FILE = "recent-project.json";

export interface ProjectReviewTargets {
  lineReviewHtml: string;
  proposalReviewHtml: string;
  primaryHtml: string;
}

interface ReviewCandidate {
  path: string;
  modifiedMs: number;
}

export async function readRecentProjectDir(userDataDir: string): Promise<string | undefined> {
  const filePath = path.join(userDataDir, RECENT_PROJECT_FILE);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid recent project state: ${filePath}`);
  }
  const projectDir = (parsed as { projectDir?: unknown }).projectDir;
  if (typeof projectDir !== "string" || !projectDir.trim()) {
    throw new Error(`Invalid recent project folder: ${filePath}`);
  }
  return path.resolve(projectDir);
}

export async function writeRecentProjectDir(userDataDir: string, projectDir: string): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writeTextFileAtomically(path.join(userDataDir, RECENT_PROJECT_FILE), JSON.stringify({
    projectDir: path.resolve(projectDir),
    updatedAt: new Date().toISOString()
  }, null, 2));
}

export async function discoverProjectReviewTargets(workspaceDir: string): Promise<ProjectReviewTargets> {
  const lineCandidates: ReviewCandidate[] = [];
  const proposalCandidates: ReviewCandidate[] = [];
  const htmlDir = path.join(workspaceDir, "html");
  let entries;
  try {
    entries = await readdir(htmlDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lineReviewHtml: "", proposalReviewHtml: "", primaryHtml: "" };
    }
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const isLineReview = /^line-review.*\.html$/i.test(entry.name);
    const isProposalReview = /^proposal-review.*\.html$/i.test(entry.name);
    if (!isLineReview && !isProposalReview) return;
    const fullPath = path.join(htmlDir, entry.name);
    const candidate = { path: fullPath, modifiedMs: (await stat(fullPath)).mtimeMs };
    if (isLineReview) {
      lineCandidates.push(candidate);
    } else {
      proposalCandidates.push(candidate);
    }
  }));
  const newestFirst = (left: ReviewCandidate, right: ReviewCandidate) =>
    right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path);
  lineCandidates.sort(newestFirst);
  proposalCandidates.sort(newestFirst);
  const lineReviewHtml = lineCandidates[0]?.path ?? "";
  const proposalReviewHtml = proposalCandidates[0]?.path ?? "";
  return {
    lineReviewHtml,
    proposalReviewHtml,
    primaryHtml: lineReviewHtml || proposalReviewHtml
  };
}
