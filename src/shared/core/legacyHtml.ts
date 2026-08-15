import {
  BATCH_LINE_REVIEW_PROTOCOL_VERSION,
  LINE_REVIEW_PROTOCOL_MARKER,
  PROPOSAL_REVIEW_PROTOCOL_MARKER,
  PROMPT_SETTINGS_VERSION,
  renderBatchLineReviewIndexHtml,
  renderLineReviewHtml,
  renderProposalReviewHtml,
  type BatchLineReviewIndexFile,
  type HtmlWorkflowOptions,
  type UiLocale
} from "./html.ts";
import { agentChatFlowVersion } from "./agentChatEmbed.ts";
import { isMechanicalScanProposal, type ReviewProposal } from "./reviewReport.ts";

interface EmbeddedReviewData {
  rows?: Array<{ source?: unknown; translation?: unknown }>;
  pageSize?: unknown;
  startPage?: unknown;
  workflow?: {
    paths?: Record<string, unknown>;
    advanced?: unknown;
    glossaryEntries?: unknown;
    bilingualPair?: unknown;
    epubExport?: unknown;
  };
}

interface EmbeddedProposalData {
  proposals?: unknown;
  pageSize?: unknown;
  startPage?: unknown;
  outputDir?: unknown;
  reportPath?: unknown;
  lineReviewPath?: unknown;
}

interface EmbeddedBatchData {
  files?: unknown;
  folderAgentRoute?: unknown;
}

export interface EmbeddedProposalLinks {
  reportPath?: string;
  lineReviewPath?: string;
}

function htmlLocale(html: string): UiLocale {
  return /<html\s+lang="en-US"/i.test(html) ? "en-US" : "zh-CN";
}

function htmlTitle(html: string, fallback: string): string {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) {
    return fallback;
  }
  return match[1]
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim() || fallback;
}

function embeddedReviewData(html: string): EmbeddedReviewData | undefined {
  const match = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as EmbeddedReviewData : undefined;
  } catch {
    return undefined;
  }
}

function embeddedProposalData(html: string): EmbeddedProposalData | undefined {
  const match = html.match(/<script id="proposalData" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as EmbeddedProposalData : undefined;
  } catch {
    return undefined;
  }
}

function embeddedBatchDataText(html: string): string | undefined {
  return html.match(/<script\b[^>]*\bid\s*=\s*["']batchData["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
}

function embeddedBatchData(html: string): EmbeddedBatchData | undefined {
  const dataText = embeddedBatchDataText(html);
  if (dataText === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText);
  } catch (error) {
    throw new Error(`Batch review data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Batch review data must be a JSON object.");
  }
  return parsed as EmbeddedBatchData;
}

function htmlAttributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}

function hasScriptElement(html: string, id: string): boolean {
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.slice(cursor).match(/<script\b[^>]*>/i);
    if (!opening || opening.index === undefined) return false;
    const tagStart = cursor + opening.index;
    const tagEnd = tagStart + opening[0].length;
    if (htmlAttributeValue(opening[0], "id") === id) return true;
    const closing = html.toLowerCase().indexOf("</script>", tagEnd);
    if (closing < 0) return false;
    cursor = closing + "</script>".length;
  }
  return false;
}

export function batchLineReviewProtocolVersion(html: string): number | undefined {
  const protocolMeta = (html.match(/<meta\b[^>]*>/gi) ?? []).find((tag) => {
    return htmlAttributeValue(tag, "name") === "translation-workshop-batch-review";
  });
  if (!protocolMeta) {
    return embeddedBatchDataText(html) === undefined ? undefined : 0;
  }
  const content = htmlAttributeValue(protocolMeta, "content");
  const match = content?.match(/^translation-workshop-batch-review-v(\d+)$/);
  if (!match) {
    throw new Error("Malformed batch review protocol marker.");
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Malformed batch review protocol version.");
  }
  return version;
}

export function embeddedProposalLinks(html: string): EmbeddedProposalLinks | undefined {
  const data = embeddedProposalData(html);
  if (!data) {
    return undefined;
  }
  return {
    reportPath: typeof data.reportPath === "string" ? data.reportPath : undefined,
    lineReviewPath: typeof data.lineReviewPath === "string" ? data.lineReviewPath : undefined
  };
}

function workflowOptions(data: EmbeddedReviewData): HtmlWorkflowOptions {
  const paths = data.workflow?.paths ?? {};
  const sourcePath = typeof paths.sourcePath === "string" ? paths.sourcePath : undefined;
  const promptSourcePath = typeof paths.promptSourcePath === "string" ? paths.promptSourcePath : undefined;
  const promptTranslationPath = typeof paths.promptTranslationPath === "string" ? paths.promptTranslationPath : undefined;
  const validationSourcePath = typeof paths.validationSourcePath === "string"
    ? paths.validationSourcePath
    : sourcePath?.toLowerCase().endsWith(".epub")
      && paths.promptSourceKind !== "folder"
      && promptSourcePath?.toLowerCase().endsWith(".txt")
      ? promptSourcePath
      : sourcePath;
  const glossaryEntries = Array.isArray(data.workflow?.glossaryEntries)
    ? data.workflow.glossaryEntries.filter((entry): entry is { source: string; target: string } => {
      return Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as { source?: unknown }).source === "string"
        && typeof (entry as { target?: unknown }).target === "string";
    })
    : undefined;
  const epubExport = data.workflow?.epubExport;
  const bilingualPair = data.workflow?.bilingualPair;
  const advanced = data.workflow?.advanced;
  return {
    sourcePath,
    validationSourcePath,
    sourceKind: paths.sourceKind === "folder" ? "folder" : paths.sourceKind === "file" ? "file" : undefined,
    translationPath: typeof paths.translationPath === "string" ? paths.translationPath : undefined,
    editableTranslationPath: typeof paths.editableTranslationPath === "string"
      ? paths.editableTranslationPath
      : promptTranslationPath?.toLowerCase().endsWith(".txt") ? promptTranslationPath : undefined,
    sourcePromptPath: promptSourcePath,
    promptSourceKind: paths.promptSourceKind === "folder" ? "folder" : paths.promptSourceKind === "file" ? "file" : undefined,
    translationPromptPath: promptTranslationPath,
    outputDir: typeof paths.outputDir === "string" ? paths.outputDir : undefined,
    glossaryPath: typeof paths.glossaryPath === "string" ? paths.glossaryPath : undefined,
    glossaryEntries,
    advanced: advanced && typeof advanced === "object" && !Array.isArray(advanced)
      ? advanced as HtmlWorkflowOptions["advanced"]
      : undefined,
    bilingualPair: bilingualPair && typeof bilingualPair === "object" && !Array.isArray(bilingualPair)
      ? bilingualPair as HtmlWorkflowOptions["bilingualPair"]
      : undefined,
    epubExport: epubExport && typeof epubExport === "object" && !Array.isArray(epubExport)
      ? epubExport as HtmlWorkflowOptions["epubExport"]
      : undefined
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function lineCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function batchFiles(value: unknown): BatchLineReviewIndexFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const files: BatchLineReviewIndexFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    const sourceName = typeof row.sourceName === "string" ? row.sourceName : "";
    const sourcePath = typeof row.sourcePath === "string" ? row.sourcePath : "";
    const outputPath = typeof row.outputPath === "string" ? row.outputPath : "";
    const sourceLineCount = lineCount(row.sourceLineCount);
    const status = row.status;
    if (
      !sourceName
      || !sourcePath
      || !outputPath
      || sourceLineCount === undefined
      || (status !== "matched" && status !== "missing-translation" && status !== "line-count-mismatch")
    ) {
      return undefined;
    }
    const translationLineCount = lineCount(row.translationLineCount);
    files.push({
      sourceName,
      sourcePath,
      outputPath,
      status,
      sourceLineCount,
      translationName: typeof row.translationName === "string" ? row.translationName : undefined,
      translationPath: typeof row.translationPath === "string" ? row.translationPath : undefined,
      translationLineCount
    });
  }
  return files;
}

function commonParentDirectory(sourcePaths: string[]): string | undefined {
  if (sourcePaths.length === 0) return undefined;
  const normalized = sourcePaths.map((value) => value.replace(/\\/g, "/"));
  const caseInsensitive = normalized.some((value) => /^[A-Za-z]:\//.test(value) || value.includes("//"));
  const directories = normalized.map((value) => {
    const parts = value.split("/");
    if (parts.length < 2) return undefined;
    parts.pop();
    return parts;
  });
  if (directories.some((parts) => !parts)) return undefined;
  const first = directories[0]!;
  const comparable = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  let commonLength = first.length;
  for (const directory of directories.slice(1) as string[][]) {
    commonLength = Math.min(commonLength, directory.length);
    while (commonLength > 0 && comparable(directory[commonLength - 1]!) !== comparable(first[commonLength - 1]!)) {
      commonLength -= 1;
    }
  }
  if (commonLength === 0) return undefined;
  const result = first.slice(0, commonLength).join("/");
  return result || "/";
}

function batchWorkflowOptions(data: EmbeddedBatchData, fallbackOutputDir?: string): HtmlWorkflowOptions | undefined {
  const route = data.folderAgentRoute;
  if (route && typeof route === "object" && !Array.isArray(route)) {
    const values = route as Record<string, unknown>;
    const sourcePath = typeof values.sourcePath === "string" ? values.sourcePath : undefined;
    const outputDir = typeof values.outputDir === "string" ? values.outputDir : undefined;
    if (!sourcePath || !outputDir) return undefined;
    const inputMode = values.inputMode === "bilingual" || values.inputMode === "separate"
      ? values.inputMode
      : undefined;
    const advanced = values.advanced && typeof values.advanced === "object" && !Array.isArray(values.advanced)
      ? { ...(values.advanced as Record<string, unknown>) }
      : {};
    if (typeof advanced.languagePair !== "string") {
      const languagePair = typeof values.languagePair === "string"
        ? values.languagePair
        : typeof values.initialLanguagePair === "string" ? values.initialLanguagePair : undefined;
      if (languagePair) advanced.languagePair = languagePair;
    }
    return {
    sourcePath,
    sourceKind: "folder",
    translationPath: typeof values.translationPath === "string" ? values.translationPath : undefined,
    outputDir,
      glossaryPath: typeof values.glossaryPath === "string" ? values.glossaryPath : undefined,
      inputMode,
      promptInputMode: inputMode,
      advanced: Object.keys(advanced).length > 0 ? advanced as HtmlWorkflowOptions["advanced"] : undefined
    };
  }

  // v1 indexes had only the child file manifest. Reconstruct the folder route
  // from that manifest during the one-time on-disk migration; do not use the
  // selected child file as the Agent source.
  if (!fallbackOutputDir) return undefined;
  const files = batchFiles(data.files);
  const sourcePath = files ? commonParentDirectory(files.map((file) => file.sourcePath)) : undefined;
  if (!sourcePath) return undefined;
  return {
    sourcePath,
    sourceKind: "folder",
    outputDir: fallbackOutputDir,
    inputMode: "separate",
    promptInputMode: "separate"
  };
}

export function embeddedBatchLineReviewFiles(html: string): BatchLineReviewIndexFile[] | undefined {
  const data = embeddedBatchData(html);
  if (!data) return undefined;
  const files = batchFiles(data.files);
  if (!files) {
    throw new Error("Batch review data must contain valid child HTML entries.");
  }
  return files;
}

export function embeddedBatchLineReviewWorkflow(
  html: string,
  fallbackOutputDir?: string
): HtmlWorkflowOptions | undefined {
  return batchWorkflowOptions(embeddedBatchData(html) ?? {}, fallbackOutputDir);
}

function explicitProposalStatus(value: unknown): ReviewProposal["status"] | undefined {
  return value === "accepted" || value === "rejected" || value === "manual" || value === "conflict"
    ? value
    : undefined;
}

function proposalItems(value: unknown): ReviewProposal[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const proposals = value
    .filter((item) => item && typeof item === "object")
    .map((item, index): ReviewProposal => {
      const row = item as Record<string, unknown>;
      const line = Number(row.line);
      const baseRevision = Number(row.baseRevision);
      const proposal: ReviewProposal = {
        id: stringValue(row.id) || `proposal-${index + 1}`,
        documentId: stringValue(row.documentId) || undefined,
        sourcePath: stringValue(row.sourcePath) || undefined,
        translationPath: stringValue(row.translationPath) || undefined,
        line: Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined,
        src: stringValue(row.src ?? row.source),
        current: stringValue(row.current ?? row.translation),
        oldText: stringValue(row.oldText) || undefined,
        baseRevision: Number.isInteger(baseRevision) && baseRevision >= 0 ? baseRevision : undefined,
        problemType: stringValue(row.problemType ?? row.type ?? row.severity),
        problem: stringValue(row.problem ?? row.explanation ?? row.issue),
        suggestion: stringValue(row.suggestion ?? row.suggested ?? row.replacement),
        kind: row.kind === "mechanical_scan" ? "mechanical_scan" : undefined,
        needsVerification: row.needsVerification === true ? true : undefined,
        status: "unreviewed"
      };
      proposal.status = explicitProposalStatus(row.status)
        ?? (isMechanicalScanProposal(proposal) ? "unreviewed" : "accepted");
      return proposal;
    })
    .filter((item) => item.src || item.current || item.problem || item.suggestion);
  return proposals.length > 0 ? proposals : undefined;
}

export function needsLegacyLineReviewUpgrade(html: string): boolean {
  const isLineReview = hasScriptElement(html, "reviewData") && html.includes("line-review");
  return isLineReview && (
    !html.includes(`content="${LINE_REVIEW_PROTOCOL_MARKER}"`)
    || !html.includes(`data-agent-chat-flow="${agentChatFlowVersion}"`)
    || !html.includes(`<meta name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}">`)
  );
}

export function needsLegacyBatchLineReviewUpgrade(html: string): boolean {
  const version = batchLineReviewProtocolVersion(html);
  return version !== undefined && version < BATCH_LINE_REVIEW_PROTOCOL_VERSION;
}

export function needsLegacyProposalReviewUpgrade(html: string): boolean {
  return hasScriptElement(html, "proposalData")
    && html.includes("proposal-review")
    && (
      !html.includes(`content="${PROPOSAL_REVIEW_PROTOCOL_MARKER}"`)
      ||
      !html.includes("persistLineReviewState")
      || !html.includes("proposalSafetyCheck")
      || !html.includes('id="issueFilter"')
      || !html.includes('id="startLanSync"')
      || !html.includes('id="agentChatDock"')
      || !html.includes(`data-agent-chat-flow="${agentChatFlowVersion}"`)
      || !html.includes("agentChatReactRoot")
      || !html.includes("window.__ynAgentChatPiWebEmbedded")
      || !html.includes("YnPiWebAgentEmbedded.mount")
      || !html.includes("currentProposalHtmlPath")
      || !html.includes("function issueTypeOptions")
      || html.includes("current-mismatch")
      || html.includes("currentScore")
    );
}

export function upgradeLegacyLineReviewHtmlContent(
  html: string,
  fallbackTitle: string,
  sourceFilePath?: string,
  workflowOverride?: HtmlWorkflowOptions
): string | undefined {
  if (!needsLegacyLineReviewUpgrade(html)) {
    return undefined;
  }
  const data = embeddedReviewData(html);
  if (!data?.rows || !Array.isArray(data.rows)) {
    return undefined;
  }
  return renderLineReviewHtml({
    title: htmlTitle(html, fallbackTitle),
    sourceText: data.rows.map((row) => String(row.source ?? "")).join("\n"),
    translationText: data.rows.map((row) => String(row.translation ?? "")).join("\n"),
    pageSize: Number(data.pageSize || 1000),
    startPage: Number(data.startPage || 1),
    locale: htmlLocale(html),
    lineReviewPath: sourceFilePath,
    workflow: { ...workflowOptions(data), ...workflowOverride }
  });
}

export function upgradeLegacyBatchLineReviewHtmlContent(
  html: string,
  fallbackTitle: string,
  fallbackOutputDir?: string
): string | undefined {
  const version = batchLineReviewProtocolVersion(html);
  if (version === undefined || version === BATCH_LINE_REVIEW_PROTOCOL_VERSION) {
    return undefined;
  }
  if (version > BATCH_LINE_REVIEW_PROTOCOL_VERSION) {
    throw new Error(
      `Cannot open newer batch review protocol v${version}; this app supports v${BATCH_LINE_REVIEW_PROTOCOL_VERSION}.`
    );
  }
  const files = embeddedBatchLineReviewFiles(html);
  if (!files) throw new Error("Batch review data is missing.");
  return renderBatchLineReviewIndexHtml({
    title: htmlTitle(html, fallbackTitle),
    files,
    locale: htmlLocale(html),
    workflow: batchWorkflowOptions(embeddedBatchData(html) ?? {}, fallbackOutputDir)
  });
}

export function upgradeLegacyProposalReviewHtmlContent(html: string, fallbackTitle: string): string | undefined {
  if (!needsLegacyProposalReviewUpgrade(html)) {
    return undefined;
  }
  const data = embeddedProposalData(html);
  const proposals = proposalItems(data?.proposals);
  if (!data || !proposals) {
    return undefined;
  }
  return renderProposalReviewHtml({
    title: htmlTitle(html, fallbackTitle),
    proposals,
    pageSize: positiveNumber(data.pageSize, 1000),
    startPage: positiveNumber(data.startPage, 1),
    locale: htmlLocale(html),
    outputDir: typeof data.outputDir === "string" ? data.outputDir : undefined,
    reportPath: typeof data.reportPath === "string" ? data.reportPath : undefined,
    lineReviewPath: typeof data.lineReviewPath === "string" ? data.lineReviewPath : undefined
  });
}

export function rewriteProposalReviewLineReviewPathContent(
  html: string,
  fallbackTitle: string,
  lineReviewPath: string
): string | undefined {
  const data = embeddedProposalData(html);
  const proposals = proposalItems(data?.proposals);
  if (!data || !proposals) {
    return undefined;
  }
  return renderProposalReviewHtml({
    title: htmlTitle(html, fallbackTitle),
    proposals,
    pageSize: positiveNumber(data.pageSize, 1000),
    startPage: positiveNumber(data.startPage, 1),
    locale: htmlLocale(html),
    outputDir: typeof data.outputDir === "string" ? data.outputDir : undefined,
    reportPath: typeof data.reportPath === "string" ? data.reportPath : undefined,
    lineReviewPath
  });
}
