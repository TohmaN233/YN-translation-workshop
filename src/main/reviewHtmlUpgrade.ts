import { readFile,stat } from "node:fs/promises";
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
import { BATCH_LINE_REVIEW_PROTOCOL_VERSION, type HtmlWorkflowOptions } from "../shared/core/html.ts";
import { writeTextFileAtomically, writeTextFilesAtomically } from "./atomicFile.ts";
import { resolveBatchReviewChildForUpgrade } from "./batchReviewUpgradePaths.ts";
import { formatFolderTranslationOrder } from "./agent/piNative/folderTranslationPlan.ts";
import { portableReviewHtml, resolveReviewHtmlPaths,parseReviewHtml,resolvedReviewHtml,portableParsedReviewHtml,bindParsedPdfReviewHtml,type ParsedReviewHtml } from "./reviewHtmlPortability.ts";
import { readProjectJsonObject } from "./projectJson.ts";
import { lineReviewSidecarStatePath } from "./batchLineReviewTxt.ts";
import { readEpubText } from "./epubReader.ts";
import { splitTextLines } from "../shared/validation/translationValidator.ts";
import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { isExtractedWorkshopTranslationPath } from "../shared/core/translationBinding.ts";
import { projectRelativePath } from "./projectPaths.ts";

async function optionalReviewStamp(file: string): Promise<string | undefined> {
  try { return await readReviewHtmlSourceStamp(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function bindCanonicalTranslation(context: ParsedReviewHtml, refreshTranslation = false): Promise<void> {
  if (context.kind !== 'reviewData') return;
  const data = context.payload, paths = data.workflow?.paths;
  if (!paths) return;
  const statePath = lineReviewSidecarStatePath(context.filePath, paths.outputDir);
  if (!statePath) return;
  const stamp = await optionalReviewStamp(statePath);
  const state = await readProjectJsonObject(statePath);
  const folderPrompt = paths.promptSourceKind === 'folder';
  let target = folderPrompt ? state?.translationPath || paths.editableTranslationPath : state?.translationPromptPath || state?.translationPath;
  let project: Record<string, unknown> | undefined;
  let projectPath: string | undefined, projectStamp: string | undefined;
  if (!target && !paths.translationPath && context.root) {
    projectPath = path.join(context.root, '.translation-workshop', 'project.json');
    projectStamp = await optionalReviewStamp(projectPath);
    project = await readProjectJsonObject(projectPath);
    const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const sameSource = typeof project?.sourcePath === 'string' && project.sourceKind !== 'folder'
      && [paths.sourcePath, paths.validationSourcePath, paths.promptSourcePath].some(value => typeof value === 'string' && key(value) === key(project!.sourcePath as string));
    if (!sameSource) return;
    target = project?.promptTranslationPath || project?.translationPath;
  }
  const embedded = folderPrompt ? paths.editableTranslationPath || paths.translationPath : paths.promptTranslationPath || paths.editableTranslationPath || paths.translationPath;
  const plannedOutput = !state?.translationPath && !state?.translationPromptPath
    && !project?.translationPath && !project?.promptTranslationPath && !refreshTranslation && !data.workflow.hasInitialTranslation;
  target ||= embedded;
  if (typeof target !== 'string' || !path.isAbsolute(target)) return;
  if (plannedOutput && await optionalReviewStamp(target) === undefined) return;
  if (!refreshTranslation && typeof embedded === 'string' && path.resolve(embedded).toLowerCase() === path.resolve(target).toLowerCase()
    && data.workflow.hasInitialTranslation && data.workflow.initialTranslationLines?.length === data.rows.length) return;
  const text = /\.epub$/i.test(target)
    ? await readEpubText(target, path.join(context.root!, '.translation-workshop'), `binding-${Date.now()}`)
    : await readFile(target, 'utf8');
  if (await optionalReviewStamp(statePath) !== stamp
    || projectPath && await optionalReviewStamp(projectPath) !== projectStamp) throw new Error('Canonical translation binding changed while preparing its HTML; reopen it.');
  // An unselected generated empty draft is not an imported translation. Older
  // drafts also omitted the final empty-line terminator; no text needs migrating.
  if (plannedOutput && context.root && projectRelativePath(context.root, target) !== undefined
    && isExtractedWorkshopTranslationPath(target) && !text.trim()) return;
  const samePath = (left: string, right: string) => process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
  const bilingualSource = data.workflow.inputMode === 'bilingual'
    && typeof paths.sourcePath === 'string' && samePath(target, paths.sourcePath);
  const lines = splitTextLines(bilingualSource ? parseBilingualPairs(text, data.workflow.bilingualPair ?? {sourcePosition:2,translationPosition:1}).translationText : text);
  if (lines.length !== data.rows.length) throw new Error(`Canonical translation line count differs from its HTML document: ${target} (translation: ${lines.length}, HTML: ${data.rows.length})`);
  for (const row of data.rows) {
    row.translation = lines[row.line - 1];
    row.status = row.translation ? 'machine' : 'empty';
  }
  data.workflow.initialTranslationLines = lines;
  data.workflow.hasInitialTranslation = lines.some(line => line.trim());
  data.workflow.initialTranslationSyncedAt = state?.syncedAt ?? null;
  paths.translationPath = state?.translationPath || project?.translationPath || target;
  paths.editableTranslationPath = target;
  paths.promptTranslationPath = target;
  context.boundChanged = true;
}

export interface ReviewHtmlOpenContext {
  filePath:string;html:string;kind?:ParsedReviewHtml['kind'];payload?:any;changed:boolean;sourceStamp:string;
}
export async function readReviewHtmlSourceStamp(filePath:string):Promise<string> {
  const value=await stat(filePath,{bigint:true});
  return [value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');
}
async function readSource(file:string) {
  const sourceStamp=await readReviewHtmlSourceStamp(file),html=await readFile(file,'utf8');
  if(await readReviewHtmlSourceStamp(file)!==sourceStamp)throw new Error(`Review HTML changed while opening: ${file}`);
  return {html,sourceStamp};
}
async function assertSource(file:string,stamp:string) {
  if(await readReviewHtmlSourceStamp(file)!==stamp)throw new Error(`Review HTML changed before migration: ${file}`);
}

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
  const sourceDocuments = files.map((file, index) => {
    const id=documentIds[index]!;
    const existing=folderWorkflow.advanced?.folderSourceDocuments?.find(document=>document.id===id);
    const indexedSourcePath = file.sourcePath?.trim();
    const extractedSourcePath = validationSourcePath(childHtml[index] ?? "");
    // A lazy open has no sibling HTML evidence. Preserve the index's complete
    // projection binding, and refine only a child that was actually read.
    const sourcePath = extractedSourcePath
      || existing?.path
      || indexedSourcePath
      || (sourceRoot ? path.join(sourceRoot, documentIds[index]!) : undefined);
    return sourcePath?{...existing,id,path:sourcePath}:undefined;
  });
  const folderSourceDocuments = sourceDocuments.every(document=>document!==undefined)
    ? sourceDocuments
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
      folderSourceDocuments,
      folderSourceSelection: folderWorkflow.advanced?.folderSourceSelection
    }
  };
}

export async function prepareReviewHtmlOpen(targetPath:string,workflowOverride?:HtmlWorkflowOptions,options?:{refreshTranslation?:boolean}):Promise<ReviewHtmlOpenContext> {
  return prepareReviewHtmlSource(targetPath,await readSource(path.resolve(targetPath)),workflowOverride,options?.refreshTranslation);
}
async function prepareReviewHtmlSource(targetPath:string,source:{html:string;sourceStamp:string},workflowOverride?:HtmlWorkflowOptions,refreshTranslation = false):Promise<ReviewHtmlOpenContext> {
  const absoluteTargetPath = path.resolve(targetPath);
  const rawHtml=source.html;
  const rawBatchVersion = batchLineReviewProtocolVersion(rawHtml);
  if (rawBatchVersion !== undefined && rawBatchVersion > BATCH_LINE_REVIEW_PROTOCOL_VERSION) {
    throw new Error(`Cannot open newer batch review protocol v${rawBatchVersion}; this app supports v${BATCH_LINE_REVIEW_PROTOCOL_VERSION}.`);
  }
  let context=parseReviewHtml(rawHtml,absoluteTargetPath);
  const batchProtocolVersion=rawBatchVersion;
  if(batchProtocolVersion===undefined) {
    const legacy=needsLegacyLineReviewUpgrade(rawHtml)||needsLegacyProposalReviewUpgrade(rawHtml);
    if(legacy)context=parseReviewHtml(prepareLegacyReviewHtmlFile(absoluteTargetPath,resolvedReviewHtml(context),workflowOverride)!,absoluteTargetPath);
    await bindCanonicalTranslation(context,refreshTranslation);
    await bindParsedPdfReviewHtml(context);
    const stored=!legacy&&!context.boundChanged&&context.payload?.projectPaths?.version===1&&rawHtml.includes('<script id="yn-project-paths">')?rawHtml:portableParsedReviewHtml(context);
    const changed=stored!==rawHtml;
    await assertSource(absoluteTargetPath,source.sourceStamp);
    if(changed)await writeTextFileAtomically(absoluteTargetPath,stored);
    return {filePath:absoluteTargetPath,html:resolvedReviewHtml(context),kind:context.kind,payload:context.payload,changed,sourceStamp:changed?await readReviewHtmlSourceStamp(absoluteTargetPath):source.sourceStamp};
  }
  const html=resolvedReviewHtml(context);
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
  // v10 already has the canonical folder route/link schema. Its only required
  // migration here is the v11 frame preparation hook, not every child body.
  if(batchProtocolVersion>=10) {
    if(batchUpgrade)context=parseReviewHtml(batchUpgrade,absoluteTargetPath);
    const stored=!batchUpgrade&&context.payload?.projectPaths?.version===1&&rawHtml.includes('<script id="yn-project-paths">')?rawHtml:portableParsedReviewHtml(context),changed=stored!==rawHtml;
    await assertSource(absoluteTargetPath,source.sourceStamp);
    if(changed)await writeTextFileAtomically(absoluteTargetPath,stored);
    return {filePath:absoluteTargetPath,html:batchUpgrade?resolvedReviewHtml(context):html,kind:context.kind,payload:context.payload,changed,sourceStamp:changed?await readReviewHtmlSourceStamp(absoluteTargetPath):source.sourceStamp};
  }
  // Legacy index migration is one atomic compatibility transaction. Modern
  // indices prepare only the child actually requested by the frame/host hook.
  const childSources=await Promise.all(childPaths.map(readSource)),rawChildHtml=childSources.map(source=>source.html);
  const childHtml = rawChildHtml.map((html, index) => resolveReviewHtmlPaths(html, childPaths[index]));
  const childUpgrades = await Promise.all(childPaths.map(async (childPath, index) => {
    const parsed=parseReviewHtml(prepareLegacyReviewHtmlFile(
      childPath,
      childHtml[index],
      folderWorkflow ? folderPromptWorkflowOverride(folderWorkflow, childReferences, childHtml) : undefined
    ) ?? childHtml[index],childPath);
    await bindCanonicalTranslation(parsed);
    await bindParsedPdfReviewHtml(parsed);return portableParsedReviewHtml(parsed);
  }));
  const updates = [
    ...((portableReviewHtml(batchUpgrade ?? html, absoluteTargetPath) !== rawHtml)
      ? [{ targetPath: absoluteTargetPath, text: portableReviewHtml(batchUpgrade ?? html, absoluteTargetPath) }] : []),
    ...childPaths.flatMap((childPath, index) => {
      const upgraded = childUpgrades[index];
      return upgraded !== rawChildHtml[index] ? [{ targetPath: childPath, text: upgraded }] : [];
    })
  ];
  await assertSource(absoluteTargetPath,source.sourceStamp);
  await Promise.all(childPaths.map((file,index)=>assertSource(file,childSources[index].sourceStamp)));
  if(updates.length)await writeTextFilesAtomically(updates);
  const prepared=parseReviewHtml(updates.find(update=>update.targetPath===absoluteTargetPath)?.text??rawHtml,absoluteTargetPath);
  return {filePath:absoluteTargetPath,html:resolvedReviewHtml(prepared),kind:prepared.kind,payload:prepared.payload,changed:updates.length>0,sourceStamp:await readReviewHtmlSourceStamp(absoluteTargetPath)};
}

export async function upgradeLegacyReviewHtmlTree(targetPath:string):Promise<boolean> {
  return (await prepareReviewHtmlOpen(targetPath)).changed;
}

/** An iframe must await this exact target before executing its old scripts. */
export async function prepareReviewHtmlChildOpen(parent:ReviewHtmlOpenContext,outputPath:string):Promise<ReviewHtmlOpenContext> {
  await assertSource(parent.filePath,parent.sourceStamp);
  if(parent.kind!=='batchData'||!Array.isArray(parent.payload?.files)||!parent.payload.files.some((file:any)=>file.outputPath===outputPath))throw new Error('Requested HTML child is not owned by this batch.');
  const child=await resolveBatchReviewChildForUpgrade(parent.filePath,outputPath);
  const source=await readSource(child);
  // Child source is read once by the normal preparation path. The override is
  // needed only for legacy folder metadata, and contains no model invocation.
  const workflow=needsLegacyLineReviewUpgrade(source.html)?embeddedBatchLineReviewWorkflow(parent.html,batchReviewOutputDir(parent.filePath)):undefined;
  const override=workflow?folderPromptWorkflowOverride(workflow,parent.payload.files,parent.payload.files.map((file:any)=>file.outputPath===outputPath?resolveReviewHtmlPaths(source.html,child):'')):undefined;
  return prepareReviewHtmlSource(child,source,override);
}
