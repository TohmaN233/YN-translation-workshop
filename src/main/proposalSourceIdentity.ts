import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { isEpubPath } from "../shared/core/translationBinding.ts";
import type { EpubReplacementOptions } from "../shared/core/epubExport.ts";
import { splitTextLines } from "../shared/validation/translationValidator.ts";
import { extractedWorkshopTextPath, workshopDirFromOutput } from "./agent/translationBindingResolve.ts";
import { readEpubText } from "./epubReader.ts";
import { readProjectJsonObject } from "./projectJson.ts";

export interface ProposalSourceIdentity {
  sourcePath: string;
  validationSourcePath: string;
  epubExport?: EpubReplacementOptions;
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
  if (extractedWorkshopTextPath(workspace, originalPath, "source") !== sourcePath) {
    return { sourcePath, validationSourcePath: sourcePath };
  }

  const originalText = await readEpubText(originalPath, workspace, `proposal-source-${randomUUID()}`);
  const originalLines = splitTextLines(originalText);
  const projectionLines = splitTextLines(await readFile(sourcePath, "utf8"));

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
