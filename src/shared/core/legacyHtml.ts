import { renderLineReviewHtml, renderProposalReviewHtml, type HtmlWorkflowOptions, type UiLocale } from "./html.ts";
import type { ReviewProposal } from "./reviewReport.ts";

interface EmbeddedReviewData {
  rows?: Array<{ source?: unknown; translation?: unknown }>;
  pageSize?: unknown;
  startPage?: unknown;
  workflow?: {
    defaultAgent?: unknown;
    paths?: Record<string, unknown>;
    glossaryEntries?: unknown;
    bilingualPair?: unknown;
    epubExport?: unknown;
  };
}

interface EmbeddedProposalData {
  proposals?: unknown;
  pageSize?: unknown;
  startPage?: unknown;
  reportPath?: unknown;
  lineReviewPath?: unknown;
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
  return {
    sourcePath: typeof paths.sourcePath === "string" ? paths.sourcePath : undefined,
    translationPath: typeof paths.translationPath === "string" ? paths.translationPath : undefined,
    outputDir: typeof paths.outputDir === "string" ? paths.outputDir : undefined,
    glossaryPath: typeof paths.glossaryPath === "string" ? paths.glossaryPath : undefined,
    glossaryEntries,
    bilingualPair: bilingualPair && typeof bilingualPair === "object" && !Array.isArray(bilingualPair)
      ? bilingualPair as HtmlWorkflowOptions["bilingualPair"]
      : undefined,
    epubExport: epubExport && typeof epubExport === "object" && !Array.isArray(epubExport)
      ? epubExport as HtmlWorkflowOptions["epubExport"]
      : undefined,
    agent: data.workflow?.defaultAgent === "claude" ? "claude" : "codex"
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function proposalStatus(value: unknown): ReviewProposal["status"] {
  return value === "accepted" || value === "rejected" || value === "manual" ? value : "unreviewed";
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
      return {
        id: stringValue(row.id) || `proposal-${index + 1}`,
        line: Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined,
        src: stringValue(row.src ?? row.source),
        current: stringValue(row.current ?? row.translation),
        problemType: stringValue(row.problemType ?? row.type ?? row.severity),
        problem: stringValue(row.problem ?? row.explanation ?? row.issue),
        suggestion: stringValue(row.suggestion ?? row.suggested ?? row.replacement),
        status: proposalStatus(row.status)
      };
    })
    .filter((item) => item.src || item.current || item.problem || item.suggestion);
  return proposals.length > 0 ? proposals : undefined;
}

export function needsLegacyLineReviewUpgrade(html: string): boolean {
  return html.includes("showSaveFilePicker")
    || html.includes("txt-file-handle")
    || (html.includes("setTimeout(() => applyEditedGlossaryTerm(input), 0)") && !html.includes("pendingGlossaryFocusIndex"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="generateReviewHtml"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("lineFromLocationHash"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="callAgent"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="collapseAgentPanel"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && html.includes('id="agentModeBackground"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && html.includes('id="startBackgroundAgent"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="promptSettingsPanel"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("promptSettingsVersion = 8"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("createAgentTerminal"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("writeAgentConsoleInput"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="startLanSync"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="importGlossary"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("glossarySyncMissingTarget"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("sourceCount <= targetCount"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("function glossaryTermKey"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("function boundPromptTranslationPath"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("function lineReviewStorageKey"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("let restoringPosition = true"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("searchMatches = needle ? data.rows.filter"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes(".row.match .cell"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="glossarySearch"'))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("glossaryRenderBatchSize"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("reviewFormatFallback"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes("Output language: write all report prose in the target language"))
    || (html.includes('id="reviewData"') && html.includes("line-review") && !html.includes('id="lanSyncPin"'));
}

export function needsLegacyProposalReviewUpgrade(html: string): boolean {
  return html.includes('id="proposalData"')
    && html.includes("proposal-review")
    && (
      !html.includes("persistLineReviewState")
      || !html.includes("proposalSafetyCheck")
      || !html.includes('id="issueFilter"')
      || !html.includes('id="startLanSync"')
      || !html.includes("currentProposalHtmlPath")
      || !html.includes("function issueTypeOptions")
      || html.includes("current-mismatch")
      || html.includes("currentScore")
    );
}

export function upgradeLegacyLineReviewHtmlContent(html: string, fallbackTitle: string): string | undefined {
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
    workflow: workflowOptions(data)
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
    reportPath: typeof data.reportPath === "string" ? data.reportPath : undefined,
    lineReviewPath
  });
}
