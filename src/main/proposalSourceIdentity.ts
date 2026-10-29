import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { isEpubPath } from "../shared/core/translationBinding.ts";
import type { EpubReplacementOptions } from "../shared/core/epubExport.ts";
import { splitTextLines } from "../shared/validation/translationValidator.ts";
import { extractedWorkshopTextPath, workshopDirFromOutput } from "./agent/translationBindingResolve.ts";
import { readEpubText } from "./epubReader.ts";
import { matchesEpubProjectionPath } from "./epubProjection.ts";
import { readProjectJsonObject } from "./projectJson.ts";

export interface ProposalSourceIdentity {
  sourcePath: string;
  validationSourcePath: string;
  epubExport?: EpubReplacementOptions;
}

interface CanonicalBatchProposalSourcePathArgs {
  documentId: string;
  sourcePath: string;
  reportSourcePath: string;
  boundSourcePaths?: readonly string[];
}

function proposalDocumentId(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new Error("A valid relative proposal document id is required.");
  }
  return normalized;
}

function absoluteProposalSourcePath(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute source path.`);
  }
  return path.resolve(value);
}

function sameProposalSourcePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Resolve an aggregate-report source route to the physical source already
 * indexed for a child document. A distinct route is accepted only when both
 * absolute paths are explicitly present in that child's HTML binding.
 */
export function canonicalBatchProposalSourcePath({
  documentId,
  sourcePath,
  reportSourcePath,
  boundSourcePaths
}: CanonicalBatchProposalSourcePathArgs): string {
  const identity = proposalDocumentId(documentId);
  const physicalSource = absoluteProposalSourcePath(sourcePath, `Indexed source for ${identity}`);
  const reportSource = absoluteProposalSourcePath(reportSourcePath, `Report source for ${identity}`);
  if (sameProposalSourcePath(physicalSource, reportSource)) return physicalSource;

  if (!Array.isArray(boundSourcePaths)) {
    throw new Error(`Report source for ${identity} does not match its indexed physical source or child HTML binding.`);
  }
  const boundPaths = boundSourcePaths.map((candidate) => absoluteProposalSourcePath(candidate, `Child HTML source binding for ${identity}`));
  if (!boundPaths.some((candidate) => sameProposalSourcePath(candidate, physicalSource))
    || !boundPaths.some((candidate) => sameProposalSourcePath(candidate, reportSource))) {
    throw new Error(`Report source for ${identity} is not explicitly bound by the same child HTML as its indexed source.`);
  }
  return physicalSource;
}

function projectPairPosition(project: Record<string, unknown>, key: "sourcePosition" | "translationPosition", fallback: 1 | 2): 1 | 2 {
  const value = project[key];
  if (value === undefined) return fallback;
  if (value !== 1 && value !== 2) {
    throw new Error(`Invalid project ${key}: expected 1 or 2.`);
  }
  return value;
}

function assertSameLines(expected: string[], actual: string[], projectionPath: string): void {
  if (expected.length !== actual.length || expected.some((line, index) => line !== actual[index])) {
    throw new Error(`EPUB source projection does not match the current EPUB content: ${projectionPath}.`);
  }
}

export async function resolveProposalSourceIdentity(
  outputDir: string,
  sourcePath: string
): Promise<ProposalSourceIdentity> {
  if (isEpubPath(sourcePath)) {
    return {
      sourcePath,
      validationSourcePath: sourcePath,
      epubExport: { mode: "all" }
    };
  }

  const workspace = workshopDirFromOutput(outputDir);
  const projectRoot = path.dirname(workspace);
  const project = await readProjectJsonObject(path.join(workspace, "project.json"), projectRoot);
  const originalPath = project?.sourcePath;
  if (!project || typeof originalPath !== "string" || !isEpubPath(originalPath)) {
    return { sourcePath, validationSourcePath: sourcePath };
  }
  const projectionText = await readFile(sourcePath, "utf8");
  const projectionMode = project.inputMode === "bilingual" ? `bilingual:${projectPairPosition(project, "sourcePosition", 2)}:${projectPairPosition(project, "translationPosition", 1)}` : "separate";
  if (!matchesEpubProjectionPath(sourcePath, extractedWorkshopTextPath(workspace, originalPath, "source"), projectionText, projectionMode)) {
    return { sourcePath, validationSourcePath: sourcePath };
  }

  let originalText = await readEpubText(originalPath, workspace, `proposal-source-${randomUUID()}`);
  const projectionLines = splitTextLines(projectionText);
  const sourceOf = (text: string) => project.inputMode === "bilingual" ? parseBilingualPairs(text, {
    sourcePosition: projectPairPosition(project, "sourcePosition", 2), translationPosition: projectPairPosition(project, "translationPosition", 1)
  }).sourceText : text;
  if (JSON.stringify(splitTextLines(sourceOf(originalText))) !== JSON.stringify(projectionLines)) {
    originalText = await readEpubText(originalPath, workspace, `proposal-source-legacy-${randomUUID()}`, "legacy-verification");
  }
  const originalLines = splitTextLines(originalText);

  if (project.inputMode === "bilingual") {
    const sourcePosition = projectPairPosition(project, "sourcePosition", 2);
    const translationPosition = projectPairPosition(project, "translationPosition", 1);
    if (sourcePosition === translationPosition) {
      throw new Error("Invalid bilingual project settings: source and translation positions must differ.");
    }
    if (originalLines.length % 2 !== 0) {
      throw new Error("Bilingual EPUB content does not contain complete source/translation pairs.");
    }
    const paired = parseBilingualPairs(originalText, { sourcePosition, translationPosition });
    const expectedSourceLines = splitTextLines(paired.sourceText);
    if (paired.rowCount * 2 !== originalLines.length) {
      throw new Error("Bilingual EPUB content does not contain complete source/translation pairs.");
    }
    assertSameLines(expectedSourceLines, projectionLines, sourcePath);
    return {
      sourcePath: originalPath,
      validationSourcePath: sourcePath,
      epubExport: { mode: "pair-position", replacePosition: translationPosition, pairSize: 2 }
    };
  }

  assertSameLines(originalLines, projectionLines, sourcePath);
  return {
    sourcePath: originalPath,
    validationSourcePath: sourcePath,
    epubExport: { mode: "all" }
  };
}
