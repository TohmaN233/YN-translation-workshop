import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  batchLineReviewProtocolVersion,
  embeddedBatchLineReviewFiles,
  embeddedBatchLineReviewWorkflow,
  needsLegacyLineReviewUpgrade,
  needsLegacyProposalReviewUpgrade,
  upgradeLegacyBatchLineReviewHtmlContent,
  upgradeLegacyLineReviewHtmlContent,
  upgradeLegacyProposalReviewHtmlContent
} from "../shared/core/legacyHtml.ts";
import type { HtmlWorkflowOptions } from "../shared/core/html.ts";
import { writeTextFileAtomically, writeTextFilesAtomically } from "./atomicFile.ts";
import { resolveBatchReviewChildForUpgrade } from "./batchReviewUpgradePaths.ts";
import { formatFolderTranslationOrder } from "./agent/piNative/folderTranslationPlan.ts";

function prepareLegacyReviewHtmlFile(
  targetPath: string,
  currentHtml: string,
  workflowOverride?: HtmlWorkflowOptions
): string | undefined {
  const fallbackTitle = path.basename(targetPath);
  const lineReviewNeedsUpgrade = needsLegacyLineReviewUpgrade(currentHtml);
  const proposalReviewNeedsUpgrade = needsLegacyProposalReviewUpgrade(currentHtml);
  if (lineReviewNeedsUpgrade && proposalReviewNeedsUpgrade) {
    throw new Error(`Review HTML has conflicting legacy formats and cannot be migrated: ${targetPath}`);
  }
  if (lineReviewNeedsUpgrade) {
    const upgraded = upgradeLegacyLineReviewHtmlContent(currentHtml, fallbackTitle, targetPath, workflowOverride);
    if (!upgraded) {
      throw new Error(`Legacy line-review data cannot be migrated: ${targetPath}`);
    }
    return upgraded;
  }
  if (proposalReviewNeedsUpgrade) {
    const upgraded = upgradeLegacyProposalReviewHtmlContent(currentHtml, fallbackTitle);
    if (!upgraded) {
      throw new Error(`Legacy proposal-review data cannot be migrated: ${targetPath}`);
    }
    return upgraded;
  }
  return undefined;
}

async function upgradeLegacyReviewHtmlFile(targetPath: string, html?: string): Promise<boolean> {
  const currentHtml = html ?? await readFile(targetPath, "utf8");
  const upgraded = prepareLegacyReviewHtmlFile(targetPath, currentHtml);
  if (!upgraded) return false;
  await writeTextFileAtomically(targetPath, upgraded);
  return true;
}

function batchReviewOutputDir(targetPath: string): string | undefined {
  const htmlDir = path.dirname(targetPath);
  if (path.basename(htmlDir).toLowerCase() !== "html") return undefined;
  const workshopDir = path.dirname(htmlDir);
  if (path.basename(workshopDir).toLowerCase() !== ".translation-workshop") return undefined;
  return path.dirname(workshopDir);
}

function folderPromptWorkflowOverride(
  folderWorkflow: HtmlWorkflowOptions,
  files: Array<{ sourceName?: string; sourcePath?: string }>,
  childHtml: string[]
): HtmlWorkflowOptions {
  const sourceRoot = folderWorkflow.sourcePath?.trim();
  const documentIds = files.map((file) => {
    if (sourceRoot && file.sourcePath) {
      const relative = path.relative(sourceRoot, file.sourcePath);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return relative.replace(/\\/g, "/");
      }
    }
    return file.sourceName?.trim() || path.basename(file.sourcePath || "source.txt");
  });
  const validationSourcePath = (html: string): string | undefined => {
    const payload = html.match(/<script\s+id="reviewData"\s+type="application\/json">([\s\S]*?)<\/script>/i)?.[1];
    if (!payload) return undefined;
    try {
      const parsed = JSON.parse(payload) as { workflow?: { paths?: { validationSourcePath?: unknown } } };
      const value = parsed.workflow?.paths?.validationSourcePath;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const sourcePaths = files.map((file, index) => {
    const indexedSourcePath = file.sourcePath?.trim();
    const extractedSourcePath = validationSourcePath(childHtml[index] ?? "");
    return (/\.epub$/i.test(indexedSourcePath ?? "") ? extractedSourcePath : indexedSourcePath)
      || extractedSourcePath
      || (sourceRoot ? path.join(sourceRoot, documentIds[index]!) : undefined);
  });
  const folderSourceDocuments = sourcePaths.every(Boolean)
    ? files.map((_file, index) => ({
      id: documentIds[index]!,
      path: sourcePaths[index]!
    }))
    : undefined;
  return {
    sourcePromptPath: folderWorkflow.sourcePath,
    promptSourceKind: "folder",
    translationPromptPath: folderWorkflow.translationPath,
    outputDir: folderWorkflow.outputDir,
    glossaryPath: folderWorkflow.glossaryPath,
    promptInputMode: folderWorkflow.promptInputMode ?? folderWorkflow.inputMode,
    advanced: {
      ...folderWorkflow.advanced,
      folderTranslationOrder: folderWorkflow.advanced?.folderTranslationOrder?.trim()
        || formatFolderTranslationOrder(documentIds),
      folderSourceDocuments
    }
  };
}

export async function upgradeLegacyReviewHtmlTree(targetPath: string): Promise<boolean> {
  const absoluteTargetPath = path.resolve(targetPath);
  const html = await readFile(absoluteTargetPath, "utf8");
  const batchProtocolVersion = batchLineReviewProtocolVersion(html);
  if (batchProtocolVersion === undefined) {
    return upgradeLegacyReviewHtmlFile(absoluteTargetPath, html);
  }

  const batchUpgrade = upgradeLegacyBatchLineReviewHtmlContent(
    html,
    path.basename(absoluteTargetPath),
    batchReviewOutputDir(absoluteTargetPath)
  );
  const folderWorkflow = embeddedBatchLineReviewWorkflow(
    html,
    batchReviewOutputDir(absoluteTargetPath)
  );
  const childReferences = embeddedBatchLineReviewFiles(html);
  if (!childReferences) throw new Error(`Batch review data is missing: ${absoluteTargetPath}`);

  const childPaths = await Promise.all(childReferences.map(async (file, index) => {
    if (!file.outputPath) throw new Error(`Batch review child ${index + 1} has no HTML output path.`);
    return resolveBatchReviewChildForUpgrade(absoluteTargetPath, file.outputPath);
  }));
  const comparableChildPaths = childPaths.map((childPath) => {
    return process.platform === "win32" ? childPath.toLowerCase() : childPath;
  });
  if (new Set(comparableChildPaths).size !== comparableChildPaths.length) {
    throw new Error(`Batch review data references the same child HTML more than once: ${absoluteTargetPath}`);
  }

  const childHtml = await Promise.all(childPaths.map((childPath) => readFile(childPath, "utf8")));
  const childUpgrades = childPaths.map((childPath, index) => {
    return prepareLegacyReviewHtmlFile(
      childPath,
      childHtml[index],
      folderWorkflow ? folderPromptWorkflowOverride(folderWorkflow, childReferences, childHtml) : undefined
    );
  });
  const updates = [
    ...(batchUpgrade ? [{ targetPath: absoluteTargetPath, text: batchUpgrade }] : []),
    ...childPaths.flatMap((childPath, index) => {
      const upgraded = childUpgrades[index];
      return upgraded ? [{ targetPath: childPath, text: upgraded }] : [];
    })
  ];
  if (updates.length === 0) return false;
  await writeTextFilesAtomically(updates);
  return true;
}
