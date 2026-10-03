import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PiFolderSourceDocument } from "../shared/agent/piSessionContract.ts";
import type { BuiltinTaskSettings } from "../shared/builtinTasks.ts";
import { parseBilingualPairs } from "../shared/core/bilingualPairs.ts";
import { renderBatchLineReviewIndexHtml, renderLineReviewHtml, type BatchLineReviewIndexFile } from "../shared/core/html.ts";
import { parseGlossaryText } from "../shared/core/glossary.ts";
import type { PromptAdvancedOptions } from "../shared/core/prompts.ts";
import { splitTextLines } from "../shared/validation/translationValidator.ts";
import { formatFolderTranslationOrder } from "./agent/piNative/folderTranslationPlan.ts";
import { extractedWorkshopTextPath, resolveUserFolderTranslationPath, workshopDirFromOutput } from "./agent/translationBindingResolve.ts";
import { resolveTranslationCandidatePath, withTranslationCandidateLock } from "./agent/writeTranslationChunk.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";
import { readEpubText } from "./epubReader.ts";
import { collectSourceTreeFiles } from "./sourceFileTree.ts";

export interface BuiltinTaskDocument {
  id: string;
  originalPath: string;
  sourcePath: string;
  sourceText: string;
  translationPath: string;
  initialTranslationText?: string;
  inputTranslationPath?: string;
  projection?: PiFolderSourceDocument["projection"];
}
export interface BuiltinTaskDocuments {
  documents: BuiltinTaskDocument[];
  sourcePath: string;
  sourceKind: "file" | "folder";
  translationPath: string;
  advanced: PromptAdvancedOptions;
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function optionalText(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function documentText(file: string, workspace: string, bytes?: Buffer): Promise<string> {
  const snapshot = bytes ?? await readFile(file);
  if (!/\.epub$/i.test(file)) return snapshot.toString("utf8");
  const text = await readEpubText(file, workspace, hash(snapshot));
  if (hash(await readFile(file)) !== hash(snapshot)) throw new Error(`Input changed while EPUB text was being extracted: ${file}.`);
  return text;
}

/** Built-in tasks use separate UTF-8 source/target files; selected inputs stay read-only. */
export async function prepareBuiltinTaskDocuments(settings: BuiltinTaskSettings): Promise<BuiltinTaskDocuments> {
  const workspace = workshopDirFromOutput(settings.outputDir);
  const allowed = settings.fileType === "epub" ? /\.epub$/i : settings.fileType === "txt" ? /\.txt$/i : /\.(txt|epub)$/i;
  const inputs = settings.sourceKind === "folder"
    ? (await collectSourceTreeFiles(settings.sourcePath, (file) => allowed.test(file))).map((file) => ({ id: file.relativePath, path: file.path }))
    : [{ id: path.basename(settings.sourcePath), path: settings.sourcePath }];
  if (!inputs.length) throw new Error("No supported TXT or EPUB source documents were found.");
  const documents: BuiltinTaskDocument[] = [];
  for (const input of inputs) {
    const originalBytes = await readFile(input.path);
    const text = await documentText(input.path, workspace, originalBytes);
    const bilingual = settings.inputMode === "bilingual" ? parseBilingualPairs(text, settings) : undefined;
    const sourceText = bilingual?.sourceText ?? text;
    if (!splitTextLines(sourceText).length) throw new Error(`Source document is empty: ${input.id}.`);
    let sourcePath = input.path;
    let projection: PiFolderSourceDocument["projection"];
    if (bilingual || /\.epub$/i.test(input.path)) {
      // Retain the original stem, including non-ASCII names, for native candidate/report identity.
      sourcePath = path.join(path.dirname(extractedWorkshopTextPath(workspace, input.path, "source")), `${path.parse(input.path).name}.txt`);
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeTextFileAtomically(sourcePath, sourceText);
      projection = { kind: bilingual ? "bilingual-pairs" : "epub-text", originalHash: hash(originalBytes), projectionHash: hash(sourceText) };
    } else if (settings.sourceKind === "folder") {
      projection = { kind: "text-lines", originalHash: hash(originalBytes), projectionHash: hash(originalBytes) };
    }
    let translationText = bilingual?.translationText;
    let inputTranslationPath = bilingual ? input.path : undefined;
    if (!bilingual && settings.translationPath) {
      const selected = settings.sourceKind === "folder"
        ? resolveUserFolderTranslationPath(settings.translationPath, input.id)
        : settings.translationPath;
      if (selected) { translationText = await documentText(selected, workspace); inputTranslationPath = selected; }
    }
    const translationPath = resolveTranslationCandidatePath({ outputDir: settings.outputDir, sourcePaths: [sourcePath], documentId: input.id });
    documents.push({ id: input.id, originalPath: input.path, sourcePath, sourceText, translationPath, initialTranslationText: translationText, inputTranslationPath, projection });
  }
  const candidateOwners = new Set<string>();
  for (const document of documents) {
    const key = document.translationPath.toLowerCase();
    if (candidateOwners.has(key)) throw new Error(`Multiple source documents would overwrite the same translation: ${document.translationPath}.`);
    candidateOwners.add(key);
  }
  const folderSourceDocuments = documents.map(({ id, sourcePath, projection }) => ({ id, path: sourcePath, ...(projection ? { projection } : {}) }));
  return {
    documents,
    sourcePath: settings.sourceKind === "folder" ? settings.sourcePath : documents[0].sourcePath,
    sourceKind: settings.sourceKind,
    translationPath: settings.sourceKind === "folder" ? path.join(settings.outputDir, "AI_translation") : documents[0].translationPath,
    advanced: { ...settings, translateOutputDir: path.join(settings.outputDir, "AI_translation"), ...(settings.sourceKind === "folder" ? {
      folderSourceDocuments, folderSourceSelection: "prepared-inputs", folderTranslationOrder: settings.folderTranslationOrder?.trim() || formatFolderTranslationOrder(documents.map((document) => document.id))
    } : {}) }
  };
}

export async function generateBuiltinTaskReview(settings: BuiltinTaskSettings, intent: "translation" | "proofread", reviewId?: string) {
  if (reviewId !== undefined && !/^[a-z0-9_-]+$/i.test(reviewId)) throw new Error("Invalid built-in review identity.");
  const prepared = await prepareBuiltinTaskDocuments(settings);
  const glossaryEntries = settings.glossaryPath ? parseGlossaryText(await readFile(settings.glossaryPath, "utf8")) : [];
  if (settings.glossaryPath && !glossaryEntries.length) throw new Error("The selected glossary contains no parseable entries.");
  const workspace = workshopDirFromOutput(settings.outputDir);
  const batchName = `builtin-${reviewId ?? randomUUID()}`;
  const outputPath = path.join(workspace, "html", `${batchName}.html`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const files: BatchLineReviewIndexFile[] = [];
  for (const document of prepared.documents) {
    const translationText = await withTranslationCandidateLock(document.translationPath, async () => {
      const existing = await optionalText(document.translationPath);
      const initial = document.initialTranslationText ?? "";
      const receiptPath = path.join(workspace, "agent", "builtin-targets", `${hash(path.resolve(document.translationPath))}.json`);
      const receipt = initial ? JSON.stringify({ schemaVersion: 1, sourcePath: path.resolve(document.originalPath),
        inputTranslationPath: path.resolve(document.inputTranslationPath!), inputTranslationHash: hash(initial) }) : undefined;
      if (existing !== undefined) {
        if (initial && initial !== existing && await optionalText(receiptPath) !== receipt) {
          throw new Error(`Selected translation conflicts with the existing canonical target for ${document.id}: ${document.translationPath}. Select that canonical TXT or use another project before proofreading.`);
        }
        if (receipt) { await mkdir(path.dirname(receiptPath), { recursive: true }); await writeTextFileAtomically(receiptPath, receipt); }
        return existing;
      }
      if (intent === "proofread" && !initial.trim()) throw new Error(`Proofreading requires an existing translation for ${document.id}.`);
      if (initial && splitTextLines(initial).length !== splitTextLines(document.sourceText).length) throw new Error(`Source/translation line counts differ for ${document.id}.`);
      if (initial) {
        await mkdir(path.dirname(document.translationPath), { recursive: true });
        await writeTextFileAtomically(document.translationPath, initial);
        await mkdir(path.dirname(receiptPath), { recursive: true });
        await writeTextFileAtomically(receiptPath, receipt!);
      }
      return initial;
    });
    if (intent === "proofread" && (!translationText.trim() || splitTextLines(translationText).length !== splitTextLines(document.sourceText).length)) {
      throw new Error(`Proofreading requires an existing aligned translation for ${document.id}.`);
    }
    const bindingHash = hash(JSON.stringify({ sourcePath: path.resolve(document.originalPath), targetPath: document.translationPath, sourceHash: hash(document.sourceText) })).slice(0, 20);
    const childName = `builtin-${bindingHash}.html`;
    const childPath = settings.sourceKind === "folder" ? path.join(workspace, "html", batchName, childName) : outputPath;
    const priorHtml = await optionalText(childPath);
    if (priorHtml) {
      const match = priorHtml.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/);
      if (!match) throw new Error(`Existing built-in review has no document bindings: ${childPath}.`);
      const prior = JSON.parse(match[1]);
      if (prior.workflow?.paths?.validationSourcePath !== document.sourcePath || prior.workflow?.paths?.editableTranslationPath !== document.translationPath
        || JSON.stringify(prior.rows.map((row: { source: string }) => row.source)) !== JSON.stringify(splitTextLines(document.sourceText))) {
        throw new Error(`Built-in review document bindings changed; start a new task before reusing ${childPath}.`);
      }
    }
    await mkdir(path.dirname(childPath), { recursive: true });
    await writeFile(childPath, renderLineReviewHtml({
      title: `${document.id} line review`, sourceText: document.sourceText, translationText,
      pageSize: settings.pageSize, locale: settings.locale, lineReviewPath: childPath,
      workflow: {
        sourcePath: document.originalPath, validationSourcePath: document.sourcePath, sourceKind: "file",
        sourcePromptPath: prepared.sourcePath, promptSourceKind: prepared.sourceKind,
        translationPath: document.translationPath, editableTranslationPath: document.translationPath,
        translationPromptPath: prepared.translationPath, outputDir: settings.outputDir,
        glossaryPath: settings.glossaryPath, glossaryEntries, inputMode: "separate", promptInputMode: "separate", advanced: prepared.advanced,
        bilingualPair: settings.inputMode === "bilingual" ? { sourcePosition: settings.sourcePosition, translationPosition: settings.translationPosition, pairSize: 2 } : undefined,
        epubExport: /\.epub$/i.test(document.originalPath) ? (settings.inputMode === "bilingual"
          ? { mode: "pair-position", replacePosition: settings.translationPosition, pairSize: 2 } : { mode: "all" }) : undefined
      }
    }), "utf8");
    files.push({ sourceName: document.id, sourcePath: document.originalPath, sourceLineCount: splitTextLines(document.sourceText).length,
      translationName: path.basename(document.translationPath), translationPath: document.translationPath,
      translationLineCount: splitTextLines(translationText).length, status: "matched", outputPath: `${batchName}/${childName}` });
  }
  if (settings.sourceKind === "folder") await writeFile(outputPath, renderBatchLineReviewIndexHtml({
    title: `${path.basename(settings.sourcePath)} folder review`, files, locale: settings.locale,
    workflow: { sourcePath: prepared.sourcePath, sourceKind: "folder", translationPath: prepared.translationPath,
      outputDir: settings.outputDir, glossaryPath: settings.glossaryPath, inputMode: "separate", advanced: prepared.advanced }
  }), "utf8");
  await writeTextFileAtomically(path.join(workspace, "state.json"), JSON.stringify({ lastHtml: outputPath, generatedAt: new Date().toISOString() }, null, 2));
  return { ...prepared, outputPath };
}
