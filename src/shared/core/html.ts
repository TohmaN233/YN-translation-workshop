import { buildLinePairs, paginateRows } from "./lineReview.ts";
import { buildPrompt, promptParameterDefaults, type AgentType, type PromptAdvancedOptions } from "./prompts.ts";
import type { GlossaryEntry } from "./glossary.ts";
import type { ReviewProposal } from "./reviewReport.ts";
import type { EpubReplacementOptions } from "./epubExport.ts";
import { renderXtermBrowserAssets } from "./xtermAssets.ts";

export type UiLocale = "zh-CN" | "en-US";

export interface LineReviewHtmlOptions {
  title: string;
  sourceText: string;
  translationText?: string;
  pageSize?: number;
  startPage?: number;
  locale?: UiLocale;
  workflow?: HtmlWorkflowOptions;
}

export interface ProposalReviewHtmlOptions {
  title: string;
  proposals: ReviewProposal[];
  pageSize?: number;
  startPage?: number;
  locale?: UiLocale;
  outputDir?: string;
  reportPath?: string;
  lineReviewPath?: string;
}

export interface BatchLineReviewIndexFile {
  sourceName: string;
  sourcePath: string;
  outputPath: string;
  status: "matched" | "missing-translation" | "line-count-mismatch";
  sourceLineCount: number;
  translationName?: string;
  translationPath?: string;
  translationLineCount?: number;
}

export interface BatchLineReviewIndexOptions {
  title: string;
  files: BatchLineReviewIndexFile[];
  locale?: UiLocale;
}

export interface HtmlWorkflowOptions {
  sourcePath?: string;
  translationPath?: string;
  sourcePromptPath?: string;
  translationPromptPath?: string;
  outputDir?: string;
  glossaryPath?: string;
  glossaryEntries?: GlossaryEntry[];
  agent?: AgentType;
  inputMode?: "separate" | "bilingual";
  promptInputMode?: "separate" | "bilingual";
  advanced?: PromptAdvancedOptions;
  bilingualPair?: {
    sourcePosition: number;
    translationPosition: number;
    pairSize?: 2;
  };
  epubExport?: EpubReplacementOptions;
}

const labels = {
  "zh-CN": {
    source: "原文",
    translation: "译文",
    search: "搜索",
    previous: "上一页",
    next: "下一页",
    page: "页码",
    jump: "跳转",
    total: "总数",
    changed: "人工改写",
    searchMatches: "匹配",
    searchNoMatches: "无匹配",
    issueFilter: "问题分类",
    allIssueTypes: "全部分类",
    exportJson: "导出状态 JSON",
    restore: "还原当前行",
    reviewTitle: "校对建议审阅",
    current: "当前译文",
    problemType: "问题类型",
    problem: "问题说明",
    suggestion: "建议译文",
    accept: "接受",
    reject: "拒绝",
    manual: "人工改写"
  },
  "en-US": {
    source: "Source",
    translation: "Translation",
    search: "Search",
    previous: "Previous",
    next: "Next",
    page: "Page",
    jump: "Go",
    total: "Total",
    changed: "Manual edits",
    searchMatches: "matches",
    searchNoMatches: "No matches",
    issueFilter: "Issue type",
    allIssueTypes: "All issue types",
    exportJson: "Export state JSON",
    restore: "Restore current row",
    reviewTitle: "Proposal Review",
    current: "Current translation",
    problemType: "Issue type",
    problem: "Issue",
    suggestion: "Suggested translation",
    accept: "Accept",
    reject: "Reject",
    manual: "Manual edit"
  }
} as const;

const workflowLabels: Record<UiLocale, Record<string, string>> = {
  "zh-CN": {
    aiTools: "AI \u5de5\u5177",
    agent: "Agent",
    generateTranslatePrompt: "\u751f\u6210\u7ffb\u8bd1\u63d0\u793a\u8bcd",
    generateProofreadPrompt: "\u751f\u6210\u6821\u5bf9\u63d0\u793a\u8bcd",
    promptSettingsTitle: "\u63d0\u793a\u8bcd\u53c2\u6570",
    promptSettingsTranslateTitle: "\u7ffb\u8bd1\u53c2\u6570",
    promptSettingsProofreadTitle: "\u6821\u5bf9\u53c2\u6570",
    promptSettingsApply: "\u751f\u6210\u63d0\u793a\u8bcd",
    promptSettingsCancel: "\u53d6\u6d88",
    promptGenerationFailed: "\u63d0\u793a\u8bcd\u751f\u6210\u5931\u8d25",
    languagePair: "\u8bed\u8a00\u65b9\u5411",
    style: "\u98ce\u683c",
    workDescription: "\u4f5c\u54c1\u8bf4\u660e",
    translateOutputDir: "\u7ffb\u8bd1\u8f93\u51fa\u6587\u4ef6\u5939",
    proofreadOutputDir: "\u62a5\u544a\u8f93\u51fa\u6587\u4ef6\u5939",
    split: "\u62c6\u5206",
    splitSize: "\u62c6\u5206\u5927\u5c0f",
    subagent: "Subagent",
    subagentCount: "Subagent \u6570\u91cf",
    proofreadMode: "\u6821\u5bf9\u6a21\u5f0f",
    candidateRatio: "H9 \u5019\u9009\u6bd4\u4f8b",
    montecarloSize: "Monte Carlo \u62bd\u6837\u6570\u91cf",
    montecarloRoundMin: "\u6700\u5c11\u8f6e\u6570",
    montecarloRoundMax: "\u6700\u591a\u8f6e\u6570",
    generateReviewHtml: "\u751f\u6210\u5ba1\u9605 HTML",
    copyPrompt: "\u590d\u5236\u63d0\u793a\u8bcd",
    callAgent: "\u8c03\u7528 Agent",
    startInteractiveAgent: "\u542f\u52a8\u63a7\u5236\u53f0",
    stopAgentConsole: "\u505c\u6b62",
    agentConsoleRunning: "控制台运行中",
    agentConsoleWaiting: "等待 Agent 回复...",
    agentConsoleStreaming: "Agent 输出中...",
    agentConsoleQuiet: "输出已静默，可能已完成。",
    collapseAgentWindow: "\u6536\u8d77\u7a97\u53e3",
    agentPromptInput: "\u63d0\u793a\u8bcd / \u6d88\u606f",
    agentConsoleEmpty: "\u4ea4\u4e92\u63a7\u5236\u53f0\u8f93\u51fa\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002",
    sendPromptToAgent: "\u53d1\u9001\u5230 Agent",
    syncTranslation: "\u540c\u6b65\u8bd1\u6587",
    chooseTranslationFile: "\u9009\u62e9\u5176\u4ed6\u8bd1\u6587",
    exportTxt: "\u5bfc\u51fa TXT",
    saveTxt: "\u5199\u5165 TXT",
    exportEpub: "\u5bfc\u51fa EPUB",
    exportTxtMode: "TXT \u683c\u5f0f",
    exportTxtMono: "\u5355\u8bed",
    exportTxtBilingual: "\u53cc\u8bed",
    syncHelp: "\u9009\u62e9\u7ffb\u8bd1\u540e\u7684 txt \u6587\u4ef6\uff0c\u6309\u884c\u540c\u6b65\u5230\u5f53\u524d HTML \u72b6\u6001\u3002",
    promptPreview: "\u63d0\u793a\u8bcd\u9884\u89c8",
    theme: "\u4e3b\u9898\u8272",
    copied: "\u5df2\u590d\u5236",
    synced: "\u5df2\u540c\u6b65\u8bd1\u6587",
    syncFailed: "\u8bd1\u6587\u540c\u6b65\u5931\u8d25",
    txtWritten: "TXT \u5df2\u5199\u5165",
    epubWritten: "EPUB \u5df2\u5bfc\u51fa",
    connectLineReview: "\u8fde\u63a5\u6b63\u6587 HTML",
    jumpLine: "\u8df3\u8f6c\u6b63\u6587\u884c",
    lineNumber: "\u884c\u53f7",
    applyProposalChanges: "\u4e00\u952e\u5e94\u7528\u5efa\u8bae",
    lineReviewMissing: "\u672a\u7ed1\u5b9a\u6b63\u6587 HTML",
    lineReviewLinked: "\u5df2\u6807\u8bb0\u6b63\u6587 HTML",
    proposalChangesApplied: "\u5df2\u5e94\u7528\u5efa\u8bae",
    proposalApplySkipped: "\u8df3\u8fc7",
    proposalSafetySkipped: "安全检查未通过",
    proposalOpenFailed: "\u6253\u5f00\u6b63\u6587 HTML \u5931\u8d25",
    reviewGenerated: "\u5df2\u751f\u6210\u5ba1\u9605 HTML",
    reviewGenerationFailed: "\u751f\u6210\u5ba1\u9605 HTML \u5931\u8d25",
    reviewFormatFallback: "AI 报告未通过格式审核，已生成格式修复提示词。",
    reviewHtmlNeedsApp: "\u751f\u6210\u5ba1\u9605 HTML \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML",
    reviewReportFound: "\u5df2\u627e\u5230\u6821\u5bf9\u62a5\u544a",
    agentLaunched: "Agent \u5df2\u542f\u52a8",
    agentLaunchFailed: "Agent \u542f\u52a8\u5931\u8d25",
    promptSentToAgent: "\u63d0\u793a\u8bcd\u5df2\u53d1\u9001\u5230 Agent",
    promptSentViaFile: "\u63d0\u793a\u8bcd\u8f83\u957f\uff0c\u5df2\u4fdd\u5b58\u4e3a\u6587\u4ef6\u5e76\u53d1\u9001\u6587\u4ef6\u5f15\u7528",
    agentConsoleNeedsApp: "\u53d1\u9001\u5230 Agent \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML",
    agentConsoleNeedsOutput: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a\u8f93\u51fa\u6587\u4ef6\u5939\uff0c\u65e0\u6cd5\u542f\u52a8 Agent",
    lanSync: "局域网同步",
    lanSyncStop: "停止同步",
    lanSyncCopy: "复制链接",
    lanSyncNeedsApp: "局域网同步需要在 translation-workshop 应用内打开此 HTML。",
    lanSyncStarted: "局域网同步已启动",
    lanSyncStopped: "局域网同步已停止",
    lanSyncFailed: "局域网同步失败",
    lanSyncLanUrl: "局域网地址",
    lanSyncLocalUrl: "本地地址",
    lanSyncPin: "6 位 PIN",
    lanSyncPinHelp: "手机或其他设备打开链接后需要输入这个 PIN。",
    lanSyncPinInvalid: "请输入 6 位数字 PIN。",
    lanSyncExternal: "外部穿透",
    lanSyncExternalNote: "translation-workshop 不内置公网穿透工具。如果你使用 Cloudflare Tunnel、ngrok 等工具，可将它们指向本地同步地址。",
    glossaryTitle: "\u672f\u8bed\u66ff\u6362",
    glossaryOpen: "\u672f\u8bed\u8868",
    glossaryClose: "\u5173\u95ed",
    glossarySearchPlaceholder: "搜索术语 / 译名",
    glossarySearchNoMatches: "没有匹配的术语",
    glossaryCurrent: "\u66ff\u6362\u5f53\u524d\u9875",
    glossaryAll: "\u66ff\u6362\u5168\u6587",
    syncGlossary: "\u540c\u6b65\u672f\u8bed",
    importGlossary: "\u5bfc\u5165\u672f\u8bed\u6587\u4ef6",
    exportGlossary: "\u5bfc\u51fa\u672f\u8bed",
    writeGlossary: "\u5199\u5165\u672f\u8bed",
    toggleAuditMarkers: "审计标记",
    runGlossaryAudit: "术语审计 H3",
    auditHint: "审计标记默认隐藏；点击行尾小框可加入/移出白名单。",
    auditWhitelistWritten: "审计白名单已写入",
    auditWhitelistWriteFailed: "审计白名单写入失败",
    auditPromptNote: "审计白名单行记录在 {path}，行号：{lines}。生成任何翻译校对/问题审计报告时必须跳过这些行；如果报告中出现与白名单行号一致的问题，请自动删除。",
    auditH3: "H3 术语数量不匹配",
    auditGlossaryFinished: "术语审计完成",
    glossaryEmpty: "\u672a\u52a0\u8f7d glossary",
    glossaryNoEntries: "\u672f\u8bed\u6587\u4ef6\u5df2\u8bfb\u53d6\uff0c\u4f46\u6ca1\u6709\u89e3\u6790\u5230\u672f\u8bed\u6761\u76ee",
    glossarySyncMissingTarget: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a glossary \u6587\u4ef6\uff0c\u8bf7\u5148\u5bfc\u5165\u672f\u8bed\u3002",
    glossaryConfirm: "\u786e\u8ba4\u6267\u884c\u672f\u8bed\u66ff\u6362\uff1f\u4f1a\u5c06\u65e7\u8bd1\u540d\u3001\u522b\u540d\u548c\u6b8b\u7559\u539f\u6587\u66ff\u6362\u4e3a\u53f3\u4fa7\u8bd1\u540d\uff0c\u4eba\u5de5\u6539\u5199\u884c\u4f1a\u8df3\u8fc7\u3002",
    glossaryApplied: "\u672f\u8bed\u66ff\u6362\u5df2\u5e94\u7528",
    glossaryEditHelp: "\u53f3\u4fa7\u8bd1\u540d\u53ef\u7f16\u8f91\u3002\u4fee\u6539\u540e\u53ef\u786e\u8ba4\u628a\u65e7\u8bd1\u540d\u81ea\u52a8\u66ff\u6362\u4e3a\u65b0\u8bd1\u540d\uff1b\u5de6\u4fa7\u539f\u6587\u4e0d\u4f1a\u88ab\u4fee\u6539\u3002",
    glossaryChangeConfirm: "\u662f\u5426\u5c06\u300c{from}\u300d\u66ff\u6362\u4e3a\u300c{to}\u300d\uff1f\u4eba\u5de5\u6539\u5199\u884c\u4f1a\u8df3\u8fc7\u3002",
    glossaryChangeCancelled: "\u672f\u8bed\u5df2\u66f4\u65b0\uff0c\u672a\u6279\u91cf\u66ff\u6362\u8bd1\u6587\u3002",
    glossarySynced: "\u672f\u8bed\u5df2\u540c\u6b65",
    glossaryWritten: "\u672f\u8bed\u5df2\u5199\u5165",
    glossaryWriteNeedsApp: "\u5199\u5165\u672f\u8bed\u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML\u3002",
    glossaryWriteMissingTarget: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a glossary \u6587\u4ef6\u8def\u5f84\u3002",
    glossaryReadFailed: "\u672f\u8bed\u540c\u6b65\u5931\u8d25",
    glossaryWriteFailed: "\u672f\u8bed\u5199\u5165\u5931\u8d25",
    txtWriteNeedsApp: "\u5199\u5165 TXT \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML\u3002\u8bf7\u4ece\u5e94\u7528\u91cd\u65b0\u6253\u5f00\u751f\u6210\u7ed3\u679c\u3002",
    txtWriteMissingTarget: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a\u8bd1\u6587\u6587\u4ef6\u8def\u5f84\uff0c\u4e0d\u80fd\u8986\u76d6\u5199\u5165\u3002\u8bf7\u5728\u5e94\u7528\u4e2d\u9009\u62e9\u8bd1\u6587\u6587\u4ef6\u540e\u91cd\u65b0\u751f\u6210 HTML\u3002",
    txtWriteFailed: "\u5199\u5165 TXT \u5931\u8d25",
    epubWriteNeedsApp: "\u5bfc\u51fa EPUB \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML\u3002",
    epubWriteMissingTemplate: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a EPUB \u6a21\u677f\u8def\u5f84\u3002",
    epubWriteFailed: "EPUB \u5bfc\u51fa\u5931\u8d25"
  },
  "en-US": {
    aiTools: "AI tools",
    agent: "Agent",
    generateTranslatePrompt: "Generate translation prompt",
    generateProofreadPrompt: "Generate proofread prompt",
    promptSettingsTitle: "Prompt parameters",
    promptSettingsTranslateTitle: "Translate parameters",
    promptSettingsProofreadTitle: "Proofread parameters",
    promptSettingsApply: "Generate prompt",
    promptSettingsCancel: "Cancel",
    promptGenerationFailed: "Prompt generation failed",
    languagePair: "Language pair",
    style: "Style",
    workDescription: "Work description",
    translateOutputDir: "Translation output folder",
    proofreadOutputDir: "Report output folder",
    split: "Split",
    splitSize: "Split size",
    subagent: "Subagent",
    subagentCount: "Subagent count",
    proofreadMode: "Proofread mode",
    candidateRatio: "H9 candidate ratio",
    montecarloSize: "Monte Carlo sample size",
    montecarloRoundMin: "Minimum rounds",
    montecarloRoundMax: "Maximum rounds",
    generateReviewHtml: "Generate review HTML",
    copyPrompt: "Copy prompt",
    callAgent: "Call Agent",
    startInteractiveAgent: "Start console",
    stopAgentConsole: "Stop",
    agentConsoleRunning: "Console running",
    agentConsoleWaiting: "Waiting for Agent reply...",
    agentConsoleStreaming: "Agent is writing...",
    agentConsoleQuiet: "Output is quiet; likely finished.",
    collapseAgentWindow: "Collapse window",
    agentPromptInput: "Prompt / message",
    agentConsoleEmpty: "Interactive console output will appear here.",
    sendPromptToAgent: "Send to Agent",
    syncTranslation: "Sync translation",
    chooseTranslationFile: "Choose other file",
    exportTxt: "Export TXT",
    saveTxt: "Save TXT",
    exportEpub: "Export EPUB",
    exportTxtMode: "TXT format",
    exportTxtMono: "Mono",
    exportTxtBilingual: "Bilingual",
    syncHelp: "Choose a translated txt file and sync it into this HTML state by line.",
    promptPreview: "Prompt preview",
    theme: "Theme color",
    copied: "Copied",
    synced: "Translation synced",
    syncFailed: "Translation sync failed",
    txtWritten: "TXT written",
    epubWritten: "EPUB exported",
    connectLineReview: "Link line HTML",
    jumpLine: "Jump to line",
    lineNumber: "Line",
    applyProposalChanges: "Apply proposals",
    lineReviewMissing: "No linked line review HTML",
    lineReviewLinked: "Line review HTML marked",
    proposalChangesApplied: "Proposals applied",
    proposalApplySkipped: "skipped",
    proposalSafetySkipped: "failed safety check",
    proposalOpenFailed: "Failed to open line HTML",
    reviewGenerated: "Review HTML generated",
    reviewGenerationFailed: "Review HTML generation failed",
    reviewFormatFallback: "The AI report failed format validation. A repair prompt was generated.",
    reviewHtmlNeedsApp: "Open this HTML in translation-workshop to generate review HTML.",
    reviewReportFound: "Report found",
    agentLaunched: "Agent launched",
    agentLaunchFailed: "Agent launch failed",
    promptSentToAgent: "Prompt sent to Agent",
    promptSentViaFile: "Prompt is long, so it was saved to a file and sent as a file reference",
    agentConsoleNeedsApp: "Sending to Agent requires opening this HTML inside translation-workshop.",
    agentConsoleNeedsOutput: "This HTML has no bound output folder, so Agent cannot be started.",
    lanSync: "LAN sync",
    lanSyncStop: "Stop sync",
    lanSyncCopy: "Copy link",
    lanSyncNeedsApp: "LAN sync requires opening this HTML inside the translation-workshop app.",
    lanSyncStarted: "LAN sync started",
    lanSyncStopped: "LAN sync stopped",
    lanSyncFailed: "LAN sync failed",
    lanSyncLanUrl: "LAN address",
    lanSyncLocalUrl: "Local address",
    lanSyncPin: "6-digit PIN",
    lanSyncPinHelp: "Phones and other devices must enter this PIN after opening the link.",
    lanSyncPinInvalid: "Enter a 6-digit numeric PIN.",
    lanSyncExternal: "External tunnel",
    lanSyncExternalNote: "translation-workshop does not bundle public tunneling tools. If you use Cloudflare Tunnel, ngrok, or similar tools, point them to the local sync address.",
    glossaryTitle: "Glossary replacement",
    glossaryOpen: "Glossary",
    glossaryClose: "Close",
    glossarySearchPlaceholder: "Search source / translation",
    glossarySearchNoMatches: "No matching terms",
    glossaryCurrent: "Replace current page",
    glossaryAll: "Replace all",
    syncGlossary: "Sync glossary",
    importGlossary: "Import glossary file",
    exportGlossary: "Export glossary",
    writeGlossary: "Write glossary",
    toggleAuditMarkers: "Audit marks",
    runGlossaryAudit: "Term audit H3",
    auditHint: "Audit marks are hidden by default; click a row marker to add/remove it from the whitelist.",
    auditWhitelistWritten: "Audit whitelist written",
    auditWhitelistWriteFailed: "Audit whitelist write failed",
    auditPromptNote: "Audit whitelist lines are recorded at {path}; line numbers: {lines}. Skip these lines in every proofreading/audit report, and remove any issues whose line number matches the whitelist.",
    auditH3: "H3 glossary term count mismatch",
    auditGlossaryFinished: "Term audit finished",
    glossaryEmpty: "No glossary loaded",
    glossaryNoEntries: "Glossary file was read, but no entries were parsed",
    glossarySyncMissingTarget: "This HTML has no bound glossary file. Import a glossary first.",
    glossaryConfirm: "Apply glossary replacements? Old translations, aliases, and remaining source terms will be replaced with the right-side term. Manual rows will be skipped.",
    glossaryApplied: "Glossary replacements applied",
    glossaryEditHelp: "Edit the right-side term. After a change, you can confirm replacing old translations with the new term; source text is never modified.",
    glossaryChangeConfirm: "Replace \"{from}\" with \"{to}\"? Manual rows will be skipped.",
    glossaryChangeCancelled: "Glossary term updated without applying replacements.",
    glossarySynced: "Glossary synced",
    glossaryWritten: "Glossary written",
    glossaryWriteNeedsApp: "Writing glossary needs this HTML to be opened inside the translation-workshop app.",
    glossaryWriteMissingTarget: "This HTML has no bound glossary file path.",
    glossaryReadFailed: "Glossary sync failed",
    glossaryWriteFailed: "Glossary write failed",
    txtWriteNeedsApp: "Writing TXT needs this HTML to be opened inside the translation-workshop app. Reopen the generated result from the app.",
    txtWriteMissingTarget: "This HTML has no bound translation file path, so it cannot overwrite a TXT file. Choose a translation file in the app and regenerate the HTML.",
    txtWriteFailed: "TXT write failed",
    epubWriteNeedsApp: "Exporting EPUB needs this HTML to be opened inside the translation-workshop app.",
    epubWriteMissingTemplate: "This HTML has no bound EPUB template path.",
    epubWriteFailed: "EPUB export failed"
  }
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function fallbackPath(value: string | undefined, label: string): string {
  return value && value.trim() ? value : `[${label}]`;
}

function workflowData(workflow: HtmlWorkflowOptions | undefined, initialTranslationLines: string[] = []) {
  const sourcePath = fallbackPath(workflow?.sourcePath, "source path");
  const translationPath = fallbackPath(workflow?.translationPath, "sync translation file first");
  const promptSourcePath = fallbackPath(workflow?.sourcePromptPath ?? workflow?.sourcePath, "source path");
  const promptTranslationPath = workflow?.translationPromptPath ?? workflow?.translationPath;
  const promptTranslationPathFallback = fallbackPath(promptTranslationPath, "sync translation file first");
  const outputDir = fallbackPath(workflow?.outputDir, "output folder");
  const glossaryPath = workflow?.glossaryPath;
  const advanced = workflow?.advanced;
  const inputMode = workflow?.inputMode ?? "separate";
  const promptInputMode = workflow?.promptInputMode ?? inputMode;
  const promptDefaults = promptParameterDefaults(outputDir, advanced);

  return {
    defaultAgent: workflow?.agent ?? "codex",
    inputMode,
    promptInputMode,
    paths: {
      sourcePath,
      translationPath: workflow?.translationPath ?? "",
      promptSourcePath,
      promptTranslationPath: promptTranslationPath ?? "",
      outputDir,
      glossaryPath: glossaryPath ?? ""
    },
    promptDefaults,
    glossaryEntries: workflow?.glossaryEntries ?? [],
    bilingualPair: workflow?.bilingualPair,
    epubExport: workflow?.epubExport ?? { mode: "all" },
    initialTranslationLines,
    hasInitialTranslation: initialTranslationLines.some((line) => line.trim() !== ""),
    prompts: {
      codex: {
        translate: buildPrompt({ kind: "translate", agent: "codex", sourcePath: promptSourcePath, translationPath: promptTranslationPath, outputDir, glossaryPath, inputMode: promptInputMode, advanced }),
        proofread: buildPrompt({ kind: "proofread", agent: "codex", sourcePath: promptSourcePath, translationPath: promptTranslationPathFallback, glossaryPath, outputDir, inputMode: promptInputMode, advanced })
      },
      claude: {
        translate: buildPrompt({ kind: "translate", agent: "claude", sourcePath: promptSourcePath, translationPath: promptTranslationPath, outputDir, glossaryPath, inputMode: promptInputMode, advanced }),
        proofread: buildPrompt({ kind: "proofread", agent: "claude", sourcePath: promptSourcePath, translationPath: promptTranslationPathFallback, glossaryPath, outputDir, inputMode: promptInputMode, advanced })
      }
    }
  };
}

function animeThemeCss(mode: "line" | "proposal"): string {
  const layout = mode === "line"
    ? `
    header { position:sticky; top:0; z-index:10; display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center; padding:14px 18px; background:linear-gradient(100deg,var(--night),#344b9a 46%,var(--sky)); color:white; box-shadow:0 8px 24px rgba(95,111,191,.22); border-bottom:3px solid rgba(255,255,255,.42); }
    header::after { content:""; position:absolute; inset:auto 22px -8px auto; width:118px; height:16px; border-radius:999px; background:linear-gradient(90deg,var(--sakura),var(--lemon),var(--mint)); opacity:.9; }
    .toolbar { display:flex; flex-wrap:wrap; justify-content:end; gap:8px; align-items:center; }
    main { max-width:1480px; margin:0 auto; padding:18px 18px 56px; }
    .status { display:flex; flex-wrap:wrap; gap:14px; color:var(--muted); font-size:13px; padding:10px 0 16px; }
    .status span { background:var(--panel-bg); border:1px solid var(--line); border-radius:999px; padding:6px 10px; }
    .row { display:grid; grid-template-columns:56px minmax(0,1fr) minmax(0,1fr); gap:10px; border-bottom:1px dashed var(--line); padding:8px 0; }
    body.audit-visible .row { grid-template-columns:56px minmax(0,1fr) minmax(0,1fr) 42px; }
    .row:hover .cell { border-color:#b7cdfd; box-shadow:0 6px 16px rgba(95,111,191,.08); }
    .line { color:#7b83a0; font:12px/1.4 Consolas,monospace; padding-top:10px; text-align:right; user-select:none; }
    .cell { min-height:44px; border:1px solid transparent; border-radius:8px; padding:9px 11px; background:var(--target-bg); line-height:1.72; font-size:15px; overflow-wrap:anywhere; white-space:pre-wrap; }
    .source { color:#3f4752; background:var(--source-bg); font-family:"Yu Gothic","Meiryo","Noto Sans CJK JP",sans-serif; }
    .target { border-color:#c9d7f5; }
    .target:focus { outline:2px solid var(--sky); outline-offset:1px; background:#fff; }
    .row.manual .target { background:#fff3c7; border-color:#f4b740; }
    .row.glossary .target { background:#effdf9; border-color:#8ee7d4; }
    body.audit-visible .row.audit-H { background:rgba(255,99,126,.16); border-radius:8px; }
    body.audit-visible .row.audit-H .target { background:#fff0f3; border-color:#ff7f9a; }
    body.audit-visible .row.audit-M { background:rgba(255,190,102,.12); border-radius:8px; }
    body.audit-visible .row.audit-M .target { background:#fff8ec; border-color:#ffd08a; }
    body.audit-visible .row.audit-L { background:rgba(126,205,255,.1); border-radius:8px; }
    body.audit-visible .row.audit-L .target { background:#f4fbff; border-color:#a9ddff; }
    .audit-marker { display:none; align-items:center; justify-content:center; align-self:stretch; min-height:32px; min-width:38px; padding:0 4px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--muted); font-size:11px; line-height:1; font-weight:800; letter-spacing:0; cursor:pointer; user-select:none; }
    body.audit-visible .audit-marker { display:flex; }
    .audit-marker.severity-H { color:#c72143; border-color:#ff8fa5; background:#fff0f3; }
    .audit-marker.severity-M { color:#9a6500; border-color:#ffd08a; background:#fff8ec; }
    .audit-marker.severity-L { color:#2d6e9f; border-color:#a9ddff; background:#f4fbff; }
    .audit-marker.whitelisted { color:#1a6f55; border-color:#9de3cd; background:#effdf9; }
    .row.match { background:rgba(185,225,255,.35); outline:1px solid #8bc8f3; border-radius:8px; }
    .row.match .cell { background:#fffbe6; border-color:#f3ca62; box-shadow:inset 0 0 0 1px rgba(243,202,98,.35); }
    .row.jump-target { background:rgba(255,229,138,.34); outline:2px solid #ffc764; border-radius:8px; }
    @media (max-width: 900px) { header { grid-template-columns:1fr; } .toolbar { justify-content:start; } .row, body.audit-visible .row { grid-template-columns:42px 1fr 42px; } .source,.target { grid-column:2; } .audit-marker { grid-column:3; grid-row:2 / span 2; } }`
    : `
    .app { display:grid; grid-template-columns:310px minmax(0,1fr); min-height:100vh; }
    aside { position:sticky; top:0; height:100vh; overflow:auto; padding:20px; background:var(--panel-bg); border-right:1px solid var(--line); box-shadow:10px 0 28px rgba(95,111,191,.1); }
    aside::before { content:""; display:block; width:118px; height:14px; margin:0 0 14px auto; border-radius:999px; background:linear-gradient(90deg,var(--sakura),var(--lemon),var(--mint)); }
    main { min-width:0; padding:24px 26px 68px; }
    .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; }
    .btn.primary,.btn.accept.active { background:linear-gradient(135deg,var(--mint),var(--sky)); color:#15324b; border-color:#8fd9d5; } .btn.reject.active { background:#ff8d9f; color:#fff; border-color:#ff8d9f; } .btn.manual.active { background:#f5bb4d; color:#3a2a00; border-color:#f5bb4d; }
    .cards { display:grid; gap:14px; }
    .card { background:var(--panel-bg); border:1px solid var(--line); border-radius:8px; box-shadow:0 10px 26px rgba(95,111,191,.12); overflow:hidden; }
    .card-head { display:flex; justify-content:space-between; gap:12px; padding:12px 14px; border-bottom:1px solid var(--line); background:linear-gradient(90deg,#fff7fb,#f2fbff); }
    .chip { display:inline-flex; border-radius:999px; background:#fff0f7; border:1px solid #ffd1e5; padding:3px 8px; font-size:12px; color:#7b3f72; font-weight:700; }
    .card-body { padding:14px; display:grid; gap:12px; } .field { display:grid; grid-template-columns:110px minmax(0,1fr); gap:10px; align-items:start; }
    .field b { color:var(--muted); font-size:13px; } .text { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--target-bg); border:1px solid #e5e9f6; border-radius:8px; padding:9px 10px; }
    .suggestion .text { background:#effdf9; border-color:#bceee2; } textarea { min-height:72px; resize:vertical; }
    @media (max-width: 900px) { .app { grid-template-columns:1fr; } aside { position:static; height:auto; } .field { grid-template-columns:1fr; } }`;

  return `
    :root { --bg:#eef8ff; --surface-a:#eef8ff; --surface-b:#f8fcff; --surface-c:#e2f4ff; --panel-bg:rgba(255,255,255,.9); --source-bg:#fbfdff; --target-bg:#f7fbff; --ink:#273046; --muted:#6d7896; --line:#cfdef2; --night:#2d5d9f; --sky:#72d3ff; --sakura:#9ad7ff; --mint:#b5ecff; --lemon:#eaf7ff; --manual:#9a6500; --focus:#dff3ff; --chip:#edf8ff; }
    * { box-sizing:border-box; }
    body.anime-workbench { margin:0; font-family:"Microsoft YaHei","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif; color:var(--ink); background:
      radial-gradient(circle at 8% 8%, color-mix(in srgb, var(--sakura) 28%, transparent), transparent 26%),
      radial-gradient(circle at 92% 12%, color-mix(in srgb, var(--sky) 24%, transparent), transparent 28%),
      linear-gradient(180deg,var(--surface-a) 0%,var(--surface-b) 54%,var(--surface-c) 100%); line-height:1.5; }
    body.anime-workbench::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.42; background-image:
      linear-gradient(135deg, rgba(255,255,255,.55) 25%, transparent 25%),
      linear-gradient(225deg, rgba(255,255,255,.4) 25%, transparent 25%); background-size:34px 34px; z-index:-1; }
    h1 { margin:0; font-size:18px; line-height:1.35; letter-spacing:0; }
    button,input,textarea,select { font:inherit; }
    input,select,textarea { border:1px solid var(--line); border-radius:8px; background:#fff; padding:8px 10px; color:var(--ink); }
    button,.btn { border:1px solid #bfd2f3; border-radius:8px; color:#283351; background:linear-gradient(180deg,#fff,#f8fbff); padding:8px 11px; cursor:pointer; min-height:36px; box-shadow:0 2px 0 rgba(119,200,255,.18); }
    button:hover,.btn:hover { border-color:var(--sky); transform:translateY(-1px); }
    button.primary { background:linear-gradient(135deg,var(--sakura),var(--sky)); border-color:#ffb4d6; color:#fff; font-weight:700; }
    .ribbon { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:5px 10px; background:rgba(255,255,255,.22); border:1px solid rgba(255,255,255,.45); font-size:12px; font-weight:700; }
    .agent-console-status { display:inline-flex; align-items:center; min-height:30px; padding:5px 9px; border:1px solid var(--line); border-radius:999px; background:#fff; color:var(--muted); font-size:12px; font-weight:800; }
    .agent-console-status[data-phase="waiting"],.agent-console-status[data-phase="streaming"] { color:#1f5b91; border-color:var(--sky); }
    .theme-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:10px 0; }
    .theme-controls strong { font-size:12px; color:var(--muted); }
    .theme-swatch { width:28px; min-width:28px; height:28px; min-height:28px; padding:0; border-radius:999px; border:2px solid rgba(255,255,255,.82); box-shadow:0 2px 8px rgba(95,111,191,.18); }
    .theme-swatch[data-theme-color="sakura"] { background:linear-gradient(135deg,#ff9ecb,#77c8ff); }
    .theme-swatch[data-theme-color="sky"] { background:linear-gradient(135deg,#72d3ff,#9ad7ff); }
    .theme-swatch[data-theme-color="mint"] { background:linear-gradient(135deg,#8ee7d4,#c7f3a5); }
    .theme-swatch[data-theme-color="lemon"] { background:linear-gradient(135deg,#ffe58a,#ffb86b); }
    .theme-color-input { width:38px; height:30px; min-height:30px; padding:2px; border-radius:8px; }
    .ai-tools { display:grid; gap:10px; margin:0 0 16px; padding:14px; border:1px solid var(--line); border-radius:8px; background:var(--panel-bg); box-shadow:0 10px 26px rgba(95,111,191,.1); }
    .ai-tools header { position:static; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; padding:0; color:var(--ink); background:none; box-shadow:none; border:0; }
    .ai-tools header::after { content:none; }
    .ai-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .ai-actions select { min-height:36px; }
    .compact-select { display:inline-flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
    .ai-tools textarea { width:100%; min-height:120px; resize:vertical; font:12px/1.5 Consolas,"Courier New",monospace; }
    .ai-status { color:var(--muted); font-size:12px; min-height:18px; }
    .lan-sync-panel { display:grid; gap:8px; padding:10px; border:1px solid #b9d8f4; border-radius:8px; background:rgba(246,251,255,.94); color:var(--ink); }
    .lan-sync-panel[hidden] { display:none; }
    .lan-sync-links { display:grid; gap:4px; font:12px/1.5 Consolas,"Courier New",monospace; }
    .lan-sync-links a { color:#1f5b91; overflow-wrap:anywhere; }
    .lan-sync-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .lan-sync-panel p { margin:0; color:var(--muted); font-size:12px; }
    .prompt-settings { display:grid; gap:12px; padding:12px; border:1px solid #c4d9f5; border-radius:8px; background:rgba(250,253,255,.94); }
    .prompt-settings[hidden] { display:none; }
    .prompt-settings header { position:static; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:0; color:var(--ink); background:none; box-shadow:none; border:0; }
    .prompt-settings header::after { content:none; }
    .prompt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; align-items:end; }
    .prompt-grid label { display:grid; gap:5px; color:var(--muted); font-size:12px; }
    .prompt-grid input,.prompt-grid select,.prompt-grid textarea { width:100%; min-width:0; }
    .prompt-wide { grid-column:1 / -1; }
    .prompt-check { align-self:center; display:flex !important; grid-auto-flow:column; justify-content:start; align-items:center; gap:8px !important; color:var(--ink) !important; }
    .prompt-check input { width:auto; }
    .prompt-section { display:grid; gap:8px; }
    .prompt-section strong { font-size:13px; color:#33405f; }
    .prompt-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:end; }
    .agent-panel { display:grid; gap:10px; padding:12px; border:1px solid #b9d8f4; border-radius:8px; background:rgba(246,251,255,.92); }
    .agent-window { position:fixed; z-index:34; right:20px; bottom:20px; width:min(720px,calc(100vw - 40px)); max-height:min(760px,calc(100vh - 40px)); overflow:auto; margin:0; background:rgba(246,251,255,.97); box-shadow:0 22px 60px rgba(30,54,105,.28); }
    .agent-panel[hidden], .agent-pane[hidden] { display:none; }
    .agent-panel-head,.agent-pane-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
    .agent-panel-head strong { margin-right:auto; }
    .agent-pane { display:grid; gap:8px; }
    .agent-log { height:min(46vh,360px); min-height:180px; overflow:auto; margin:0; padding:10px; border:1px solid #244b70; border-radius:8px; background:#071523; color:#dbeafe; font:12px/1.45 Consolas,"Courier New",monospace; overscroll-behavior:contain; }
    .agent-log .xterm { height:100%; padding:0; }
    .agent-log .xterm-viewport { border-radius:6px; overflow-y:auto !important; }
    .glossary-tools { display:grid; gap:10px; margin:0 0 16px; padding:14px; border:1px solid var(--line); border-radius:8px; background:var(--panel-bg); box-shadow:0 10px 26px rgba(95,111,191,.08); }
    .glossary-tools header { position:static; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; padding:0; color:var(--ink); background:none; box-shadow:none; border:0; }
    .glossary-tools header::after { content:none; }
    .glossary-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .glossary-search { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
    .glossary-search input { width:100%; min-width:0; }
    .glossary-search span { color:var(--muted); font-size:12px; white-space:nowrap; }
    .glossary-help { margin:0; min-height:auto; line-height:1.35; }
    .glossary-list { display:grid; gap:6px; max-height:min(72vh,calc(100vh - 220px)); overflow:auto; }
    .glossary-entry { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); gap:8px; align-items:center; font-size:13px; }
    .glossary-entry span,.glossary-entry input { min-width:0; width:100%; overflow-wrap:anywhere; padding:5px 8px; border:1px solid var(--line); border-radius:8px; background:#fff; }
    .glossary-source { color:var(--muted); background:var(--source-bg); }
    .glossary-target { background:var(--target-bg); }
    .glossary-target:focus { outline:2px solid var(--sky); outline-offset:1px; background:#fff; }
    .glossary-entry b { color:var(--muted); }
    .glossary-backdrop { position:fixed; inset:0; z-index:29; background:rgba(31,45,78,.24); opacity:0; pointer-events:none; transition:opacity .16s ease; }
    .glossary-backdrop.open { opacity:1; pointer-events:auto; }
    .glossary-drawer { position:fixed; z-index:30; inset:0 auto 0 0; width:min(700px,calc(100vw - 22px)); max-width:100vw; margin:0; border-radius:0 8px 8px 0; overflow:auto; transform:translateX(-105%); transition:transform .18s ease; }
    .glossary-drawer.open { transform:translateX(0); }
    .glossary-drawer header strong { display:flex; align-items:center; gap:4px; }
    .glossary-drawer .glossary-actions { justify-content:flex-start; }
    ${layout}`;
}

function themeControlsHtml(t: Record<string, string>): string {
  return `<div id="themeControls" class="theme-controls" data-default-theme="sky" aria-label="${t.theme ?? "Theme"}">
        <strong>${t.theme ?? "Theme"}</strong>
        <button class="theme-swatch" data-theme-color="sakura" title="Sakura"></button>
        <button class="theme-swatch" data-theme-color="sky" title="Sky"></button>
        <button class="theme-swatch" data-theme-color="mint" title="Mint"></button>
        <button class="theme-swatch" data-theme-color="lemon" title="Lemon"></button>
        <input id="customThemeColor" class="theme-color-input" type="color" value="#ff9ecb" title="${t.theme ?? "Theme"}">
      </div>`;
}

function promptSettingsHtml(t: Record<string, string>): string {
  return `<div id="promptSettingsPanel" class="prompt-settings" hidden>
        <header>
          <strong id="promptSettingsHeading">${t.promptSettingsTitle ?? "Prompt parameters"}</strong>
          <div class="prompt-actions">
            <button id="cancelPromptSettings" type="button">${t.promptSettingsCancel ?? "Cancel"}</button>
            <button id="applyPromptSettings" type="button" class="primary">${t.promptSettingsApply ?? "Generate prompt"}</button>
          </div>
        </header>
        <div class="prompt-grid">
          <label><span>${t.languagePair ?? "Language pair"}</span><input id="promptLanguagePair" type="text"></label>
          <label><span>${t.style ?? "Style"}</span><input id="promptStyle" type="text"></label>
          <label id="promptSplitSizeField"><span>${t.splitSize ?? "Split size"}</span><input id="promptSplitSize" type="number" min="1"></label>
          <label id="promptSubagentField" class="prompt-check"><input id="promptSubagent" type="checkbox"><span>${t.subagent ?? "Subagent"}</span></label>
          <label id="promptSubagentCountField"><span>${t.subagentCount ?? "Subagent count"}</span><input id="promptSubagentCount" type="number" min="1"></label>
          <label class="prompt-wide"><span>${t.workDescription ?? "Work description"}</span><textarea id="promptWorkDescription" spellcheck="false" placeholder="None"></textarea></label>
        </div>
        <div id="translatePromptSettings" class="prompt-section">
          <strong>${t.promptSettingsTranslateTitle ?? "Translate parameters"}</strong>
          <div class="prompt-grid">
            <label class="prompt-wide"><span>${t.translateOutputDir ?? "Translation output folder"}</span><input id="promptTranslateOutputDir" type="text"></label>
            <label id="promptSplitField" class="prompt-check"><input id="promptSplit" type="checkbox"><span>${t.split ?? "Split"}</span></label>
          </div>
        </div>
        <div id="proofreadPromptSettings" class="prompt-section">
          <strong>${t.promptSettingsProofreadTitle ?? "Proofread parameters"}</strong>
          <div class="prompt-grid">
            <label class="prompt-wide"><span>${t.proofreadOutputDir ?? "Report output folder"}</span><input id="promptProofreadOutputDir" type="text"></label>
            <label><span>${t.proofreadMode ?? "Proofread mode"}</span><select id="promptProofreadMode"><option value="split">split</option><option value="montecarlo">montecarlo</option></select></label>
            <label><span>${t.candidateRatio ?? "H9 candidate ratio"}</span><input id="promptCandidateRatio" type="number" min="0.1" step="0.1"></label>
            <label class="prompt-montecarlo-field"><span>${t.montecarloSize ?? "Monte Carlo sample size"}</span><input id="promptMontecarloSize" type="number" min="1"></label>
            <label class="prompt-montecarlo-field"><span>${t.montecarloRoundMin ?? "Minimum rounds"}</span><input id="promptMontecarloRoundMin" type="number" min="1"></label>
            <label class="prompt-montecarlo-field"><span>${t.montecarloRoundMax ?? "Maximum rounds"}</span><input id="promptMontecarloRoundMax" type="number" min="1"></label>
          </div>
        </div>
      </div>`;
}

function aiToolsHtml(t: Record<string, string>, workflow: ReturnType<typeof workflowData>): string {
  const sourcePath = workflow.paths?.sourcePath ?? "";
  const translationPath = workflow.paths?.translationPath ?? "";
  const sourceIsEpub = /\.epub$/i.test(sourcePath);
  const canSaveTxt = !sourceIsEpub && /\.txt$/i.test(translationPath);
  return `<section id="aiTools" class="ai-tools">
      <header>
        <strong>${t.aiTools ?? "AI tools"}</strong>
        <div class="ai-actions">
          <label>${t.agent ?? "Agent"} <select id="agentSelect"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
          <button id="translatePrompt" type="button">${t.generateTranslatePrompt ?? "Generate translation prompt"}</button>
          <button id="proofreadPrompt" type="button">${t.generateProofreadPrompt ?? "Generate proofread prompt"}</button>
          <button id="generateReviewHtml" type="button">${t.generateReviewHtml ?? "Generate review HTML"}</button>
          <button id="copyPrompt" type="button" class="primary">${t.copyPrompt ?? "Copy prompt"}</button>
          <button id="syncTranslation" type="button">${t.syncTranslation ?? "Sync translation"}</button>
          <button id="chooseTranslationFile" type="button">${t.chooseTranslationFile ?? "Choose other file"}</button>
          <label class="compact-select">${t.exportTxtMode ?? "TXT"} <select id="exportTxtMode"><option value="translation">${t.exportTxtMono ?? "Mono"}</option><option value="bilingual">${t.exportTxtBilingual ?? "Bilingual"}</option></select></label>
          <button id="exportTxt" type="button">${t.exportTxt ?? "Export TXT"}</button>
          ${sourceIsEpub ? `<button id="exportEpub" type="button">${t.exportEpub ?? "Export EPUB"}</button>` : ""}
          ${canSaveTxt ? `<button id="saveTxt" type="button">${t.saveTxt ?? "Save TXT"}</button>` : ""}
          <label class="compact-select">${t.lanSyncPin ?? "6-digit PIN"} <input id="lanSyncPin" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="\\d{6}" placeholder="000000" style="width:92px"></label>
          <button id="startLanSync" type="button">${t.lanSync ?? "LAN sync"}</button>
          <input id="syncTranslationInput" type="file" accept=".txt,text/plain" hidden>
        </div>
      </header>
      ${promptSettingsHtml(t)}
      <p class="ai-status" id="aiStatus">${t.syncHelp ?? ""}</p>
      <div id="lanSyncPanel" class="lan-sync-panel" hidden>
        <div><strong>${t.lanSync ?? "LAN sync"}</strong></div>
        <p>${t.lanSyncPinHelp ?? "Phones and other devices must enter this PIN after opening the link."}</p>
        <div id="lanSyncLinks" class="lan-sync-links"></div>
        <div class="lan-sync-actions">
          <button id="copyLanSyncLink" type="button">${t.lanSyncCopy ?? "Copy link"}</button>
          <button id="stopLanSync" type="button">${t.lanSyncStop ?? "Stop sync"}</button>
        </div>
        <p>${t.lanSyncExternal ?? "External tunnel"}: ${t.lanSyncExternalNote ?? "translation-workshop does not bundle public tunneling tools. If you use Cloudflare Tunnel, ngrok, or similar tools, point them to the local sync address."}</p>
      </div>
      <div id="agentPanel" class="agent-panel agent-window" hidden>
        <div class="agent-panel-head">
          <strong>${t.callAgent ?? "Call Agent"}</strong>
          <span id="interactiveAgentStatus" class="agent-console-status">${t.agentConsoleStopped ?? "Agent Console stopped."}</span>
          <button id="collapseAgentPanel" type="button">${t.collapseAgentWindow ?? "Collapse window"}</button>
        </div>
        <div id="interactiveAgentPane" class="agent-pane">
          <div class="agent-pane-actions">
              <button id="startInteractiveAgent" type="button">${t.startInteractiveAgent ?? "Start console"}</button>
              <button id="sendInteractiveAgentMessage" type="button" class="primary">${t.sendPromptToAgent ?? "Send to Agent"}</button>
              <button id="stopInteractiveAgent" type="button">${t.stopAgentConsole ?? "Stop"}</button>
            </div>
          <div id="interactiveAgentOutput" class="agent-log" aria-label="${t.agentConsole ?? "Agent Console"}" data-empty="${escapeHtml(t.agentConsoleEmpty ?? "")}"></div>
        </div>
        <label>${t.agentPromptInput ?? "Prompt / message"}<textarea id="agentMessageInput" spellcheck="false"></textarea></label>
      </div>
      <textarea id="promptPreview" spellcheck="false" hidden></textarea>
    </section>`;
}

function glossaryToolsHtml(t: Record<string, string>, entries: GlossaryEntry[]): string {
  const visibleEntries = entries.slice(0, 120);
  const helpText = entries.length === 0
    ? (t.glossaryEmpty ?? "No glossary loaded")
    : (t.glossaryEditHelp ?? "Edit the right-side term. Source text is never modified.");
  const body = `<div class="glossary-search">
        <input id="glossarySearch" type="search" placeholder="${escapeHtml(t.glossarySearchPlaceholder ?? "Search source / translation")}" autocomplete="off">
        <span id="glossarySearchMeta"></span>
      </div>
      <p id="glossaryHelp" class="ai-status glossary-help">${helpText}</p>
      <div id="glossaryList" class="glossary-list">${entries.length === 0 ? "" : visibleEntries.map((entry, index) => `<div class="glossary-entry" data-glossary-index="${index}">
        <input class="glossary-source" data-glossary-index="${index}" value="${escapeHtml(entry.source)}" readonly title="source term">
        <b>→</b>
        <input class="glossary-target" data-glossary-index="${index}" value="${escapeHtml(entry.target)}" data-original-target="${escapeHtml(entry.target)}" title="translation term">
      </div>`).join("")}</div>`;
  return `<div id="glossaryBackdrop" class="glossary-backdrop"></div>
    <aside id="glossaryTools" class="glossary-tools glossary-drawer" aria-hidden="true">
      <header>
        <strong>${t.glossaryTitle ?? "Glossary replacement"} (<span id="glossaryCount">${entries.length}</span>)</strong>
        <div class="glossary-actions">
          <button id="glossaryDrawerClose" type="button">${t.glossaryClose ?? "Close"}</button>
          <button id="importGlossary" type="button">${t.importGlossary ?? "Import glossary file"}</button>
          <button id="syncGlossary" type="button">${t.syncGlossary ?? "Sync glossary"}</button>
          <button id="exportGlossary" type="button">${t.exportGlossary ?? "Export glossary"}</button>
          <button id="writeGlossary" type="button">${t.writeGlossary ?? "Write glossary"}</button>
          <button id="applyGlossaryCurrent" type="button">${t.glossaryCurrent ?? "Replace current page"}</button>
          <button id="applyGlossaryAll" type="button">${t.glossaryAll ?? "Replace all"}</button>
          <button id="toggleAuditMarkers" type="button">${t.toggleAuditMarkers ?? "Audit marks"}</button>
          <button id="runGlossaryAudit" type="button">${t.runGlossaryAudit ?? "Term audit H3"}</button>
          <input id="syncGlossaryInput" type="file" accept=".txt,.json,.tsv,.csv,.md,text/plain,application/json,text/markdown" hidden>
        </div>
      </header>
      <p id="auditStatus" class="ai-status">${t.auditHint ?? ""}</p>
      ${body}
    </aside>`;
}

const batchLabels: Record<UiLocale, Record<string, string>> = {
  "zh-CN": {
    chooseFile: "\u9009\u62e9\u6587\u4ef6",
    source: "\u6e90\u6587\u4ef6",
    translation: "\u8bd1\u6587\u4ef6",
    status: "\u5339\u914d\u72b6\u6001",
    lines: "\u884c\u6570",
    matched: "\u5df2\u5339\u914d",
    missing: "\u672a\u627e\u5230\u540c\u540d\u8bd1\u6587",
    mismatch: "\u884c\u6570\u4e0d\u4e00\u81f4",
    open: "\u5728\u65b0\u7a97\u53e3\u6253\u5f00"
  },
  "en-US": {
    chooseFile: "Choose file",
    source: "Source file",
    translation: "Translation file",
    status: "Match status",
    lines: "Lines",
    matched: "Matched",
    missing: "No same-name translation",
    mismatch: "Line count mismatch",
    open: "Open in new window"
  }
};

function statusText(status: BatchLineReviewIndexFile["status"], t: Record<string, string>): string {
  if (status === "matched") return t.matched;
  if (status === "line-count-mismatch") return t.mismatch;
  return t.missing;
}

export function renderBatchLineReviewIndexHtml(options: BatchLineReviewIndexOptions): string {
  const locale = options.locale ?? "zh-CN";
  const t = batchLabels[locale];
  const firstFile = options.files[0];
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { --bg:#eef8ff; --panel:#ffffffea; --ink:#26324d; --muted:#6d7896; --line:#cfe0f5; --sky:#72d3ff; --night:#2d5d9f; --ok:#74d6b7; --warn:#ffca6b; --bad:#ff9db9; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); font-family:"Microsoft YaHei","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif; background:linear-gradient(180deg,#eef8ff,#f8fcff 56%,#e5f4ff); }
    header { position:sticky; top:0; z-index:2; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:center; padding:14px 18px; color:white; background:linear-gradient(100deg,var(--night),#344b9a 46%,var(--sky)); box-shadow:0 8px 24px rgba(95,111,191,.22); }
    h1 { margin:0; font-size:18px; line-height:1.35; letter-spacing:0; }
    select,button { min-height:36px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); padding:7px 10px; font:inherit; }
    button { cursor:pointer; }
    main { display:grid; min-height:calc(100vh - 66px); }
    .badge { display:inline-flex; border-radius:999px; padding:3px 8px; font-size:12px; font-weight:700; background:#eef8ff; }
    .badge.matched { background:#e8fff8; color:#146653; }
    .badge.missing-translation { background:#fff3d9; color:#7a4e00; }
    .badge.line-count-mismatch { background:#fff0f5; color:#8f2750; }
    .viewer { min-width:0; display:grid; grid-template-rows:auto minmax(0,1fr); }
    .viewerBar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); background:#ffffffc9; }
    iframe { width:100%; height:100%; border:0; background:#fff; }
    @media (max-width: 960px) { header { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(options.title)}</h1>
    <label>${t.chooseFile} <select id="fileSelect">${options.files.map((file, index) => `<option value="${index}">${escapeHtml(file.sourceName)} - ${escapeHtml(statusText(file.status, t))}</option>`).join("")}</select></label>
  </header>
  <main>
    <section class="viewer">
      <div class="viewerBar">
        <strong id="activeTitle">${escapeHtml(firstFile?.sourceName ?? "")}</strong>
        <span id="activeStatus" class="badge ${escapeHtml(firstFile?.status ?? "")}">${escapeHtml(firstFile ? statusText(firstFile.status, t) : "")}</span>
        <button id="openActive" type="button">${t.open}</button>
      </div>
      <iframe id="fileFrame" src="${escapeHtml(firstFile?.outputPath ?? "about:blank")}"></iframe>
    </section>
  </main>
  <script id="batchData" type="application/json">${jsonScript({ files: options.files, labels: t })}</script>
  <script>
const data = JSON.parse(document.getElementById("batchData").textContent);
const select = document.getElementById("fileSelect");
const frame = document.getElementById("fileFrame");
const title = document.getElementById("activeTitle");
const badge = document.getElementById("activeStatus");
function applyFile(index) {
  const file = data.files[index] || data.files[0];
  if (!file) return;
  select.value = String(index);
  frame.src = file.outputPath;
  title.textContent = file.sourceName;
  badge.textContent = file.status === "matched" ? data.labels.matched : file.status === "line-count-mismatch" ? data.labels.mismatch : data.labels.missing;
  badge.className = "badge " + file.status;
}
select.addEventListener("change", () => applyFile(Number(select.value || 0)));
document.getElementById("openActive").addEventListener("click", () => {
  const file = data.files[Number(select.value || 0)] || data.files[0];
  if (file) window.open(file.outputPath, "_blank");
});
applyFile(0);
  </script>
</body>
</html>`;
}

export function renderLineReviewHtml(options: LineReviewHtmlOptions): string {
  const locale = options.locale ?? "zh-CN";
  const t = { ...labels[locale], ...workflowLabels[locale] } as Record<string, string>;
  const rows = buildLinePairs(options.sourceText, options.translationText);
  const firstPage = paginateRows(rows, options.pageSize ?? 1000, options.startPage ?? 1);
  const workflow = workflowData(options.workflow, rows.map((row) => row.translation));

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>${animeThemeCss("line")}</style>
  ${renderXtermBrowserAssets()}
</head>
<body class="anime-workbench line-review">
  <header>
    <h1><span class="ribbon">translation-workshop</span> ${escapeHtml(options.title)}</h1>
    <div class="toolbar">
      <input id="search" type="search" placeholder="${t.search}">
      <button id="prev">${t.previous}</button>
      <input id="pageInput" type="number" min="1" value="${firstPage.page}" style="width:82px" aria-label="${t.page}">
      <button id="jump">${t.jump}</button>
      <button id="next">${t.next}</button>
      <button id="restore">${t.restore}</button>
      <button id="export" class="primary">${t.exportJson}</button>
      <button id="callAgent" type="button">${t.callAgent ?? "Call Agent"}</button>
      <button id="glossaryDrawerToggle" type="button">${t.glossaryOpen ?? "Glossary"}</button>
      ${themeControlsHtml(t)}
    </div>
  </header>
  ${glossaryToolsHtml(t, workflow.glossaryEntries)}
  <main>
    ${aiToolsHtml(t, workflow)}
    <div class="status">
      <span>${t.total}: <strong id="totalCount">${rows.length}</strong></span>
      <span>${t.changed}: <strong id="changedCount">0</strong></span>
      <span><strong id="pageInfo"></strong></span>
    </div>
    <section id="rows"></section>
  </main>
  <script id="reviewData" type="application/json">${jsonScript({ rows, pageSize: firstPage.pageSize, startPage: firstPage.page, labels: t, workflow })}</script>
  <script>${lineReviewScript()}</script>
</body>
</html>`;
}

function lineReviewScript(): string {
  return String.raw`
const data = JSON.parse(document.getElementById("reviewData").textContent);
const workflow = data.workflow || {};
const legacyKey = "translation-workshop:line:" + location.pathname;
function lineReviewStorageKey() {
  const sourcePath = workflow.paths?.sourcePath || "";
  const translationPath = workflow.paths?.translationPath || "";
  return sourcePath && !sourcePath.startsWith("[") ? "translation-workshop:line:" + sourcePath + "::" + translationPath : legacyKey;
}
const key = lineReviewStorageKey();
function readLineReviewState() {
  for (const candidate of [key, legacyKey]) {
    if (!candidate) continue;
    try {
      const value = localStorage.getItem(candidate);
      if (value) return JSON.parse(value) || {};
    } catch {
      // Try the next storage key.
    }
  }
  return {};
}
const state = readLineReviewState();
state.edits ||= {};
state.status ||= {};
for (const line in state.status) {
  if (state.status[line] === "machine") delete state.status[line];
}
if (state.synced) delete state.synced;
state.theme ||= {};
state.auditIssues ||= {};
state.auditWhitelist ||= {};
state.auditVisible ||= false;
let syncedLines = workflow.hasInitialTranslation ? (workflow.initialTranslationLines || []) : [];
let page = state.page || data.startPage || 1;
let activeLine = state.activeLine || null;
let restoringPosition = true;
let searchTerm = "";
let searchMatches = [];
const pageSize = data.pageSize || 1000;
const rowsEl = document.getElementById("rows");
const pageInput = document.getElementById("pageInput");
const pageInfo = document.getElementById("pageInfo");
const changedCount = document.getElementById("changedCount");
function save() {
  state.page = page;
  if (!restoringPosition) state.scrollY = scrollY;
  state.activeLine = activeLine;
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(key, serialized);
    if (key !== legacyKey) localStorage.setItem(legacyKey, serialized);
  } catch (error) {
    console.warn("translation-workshop could not persist small UI state", error);
  }
}
function rowValue(row) {
  const syncedValue = syncedLines[row.line - 1];
  return state.edits[row.line] ?? (syncedValue !== undefined ? syncedValue : row.translation ?? "");
}
function pageRows() { return data.rows.slice((page - 1) * pageSize, page * pageSize); }
function rowSearchText(row) {
  return [row.line, row.source, rowValue(row)].join("\n").toLowerCase();
}
function updateSearchMatches() {
  const needle = searchTerm.trim().toLowerCase();
  searchMatches = needle ? data.rows.filter(row => rowSearchText(row).includes(needle)) : [];
}
function rowIsSearchMatch(line) {
  return Boolean(searchTerm && searchMatches.some(row => String(row.line) === String(line)));
}
function searchSummary() {
  if (!searchTerm) return "";
  const label = data.labels.searchMatches || "matches";
  const empty = data.labels.searchNoMatches || "No matches";
  return " · " + (searchMatches.length > 0 ? label + " " + searchMatches.length : empty);
}
function render() {
  const totalPages = Math.max(1, Math.ceil(data.rows.length / pageSize));
  page = Math.min(Math.max(1, page), totalPages);
  document.body.classList.toggle("audit-visible", Boolean(state.auditVisible));
  pageInput.value = page;
  pageInfo.textContent = data.labels.page + " " + page + " / " + totalPages + searchSummary();
  changedCount.textContent = Object.keys(state.edits).length;
  rowsEl.innerHTML = pageRows().map(row => {
    const status = state.status[row.line] || row.status;
    const statusClass = status === "manual" ? "manual" : status === "glossary" ? "glossary" : "";
    const auditIssue = firstAuditIssue(row.line);
    const auditClass = auditIssue ? " audit-" + auditIssue.severity : "";
    const jumpClass = String(row.line) === String(activeLine || "") ? " jump-target" : "";
    const matchClass = rowIsSearchMatch(row.line) ? " match" : "";
    const whitelist = auditLineWhitelisted(row.line);
    const markerText = whitelist ? "✓" : (auditIssue?.code || auditIssue?.severity || "");
    const markerTitle = whitelist ? "whitelisted; click to remove" : (auditIssue ? auditIssue.code + ": " + auditIssue.message : "add to audit whitelist");
    const markerClass = whitelist ? " whitelisted" : (auditIssue ? " severity-" + auditIssue.severity : "");
    return '<article class="row ' + statusClass + auditClass + jumpClass + matchClass + '" data-line="' + row.line + '">' +
      '<div class="line">' + row.line + '</div>' +
      '<div class="cell source">' + escapeHtml(row.source) + '</div>' +
      '<div class="cell target" contenteditable="true" spellcheck="false">' + escapeHtml(rowValue(row)) + '</div>' +
      '<button class="audit-marker' + markerClass + '" type="button" title="' + escapeHtml(markerTitle) + '">' + escapeHtml(markerText) + '</button>' +
      '</article>';
  }).join("");
  save();
}
function escapeHtml(text) { return String(text).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
rowsEl.addEventListener("input", (event) => {
  const target = event.target.closest(".target");
  if (!target) return;
  const row = target.closest(".row");
  const line = row.dataset.line;
  activeLine = line;
  state.edits[line] = target.textContent;
  state.status[line] = "manual";
  row.classList.add("manual");
  changedCount.textContent = Object.keys(state.edits).length;
  save();
  queueLanSyncPatch({ type: "line-edit", line: Number(line), text: target.textContent, status: "manual" });
});
rowsEl.addEventListener("focusin", (event) => {
  const target = event.target.closest(".target");
  if (!target) return;
  const row = target.closest(".row");
  activeLine = row?.dataset.line || activeLine;
  save();
});
rowsEl.addEventListener("click", (event) => {
  const marker = event.target.closest(".audit-marker");
  if (!marker) return;
  const row = marker.closest(".row");
  const line = Number(row?.dataset.line || 0);
  if (line > 0) toggleAuditWhitelistLine(line);
});
document.getElementById("prev").onclick = () => { page -= 1; render(); scrollTo(0, 0); };
document.getElementById("next").onclick = () => { page += 1; render(); scrollTo(0, 0); };
document.getElementById("jump").onclick = () => { page = Number(pageInput.value || 1); render(); scrollTo(0, 0); };
function restoreCurrentLine() {
  const active = document.activeElement?.closest?.(".target");
  const rowEl = active?.closest(".row") || (activeLine ? Array.from(rowsEl.querySelectorAll(".row")).find(row => row.dataset.line === String(activeLine)) : null);
  const line = rowEl?.dataset.line || activeLine;
  if (!line) return;
  delete state.edits[line];
  delete state.status[line];
  const row = data.rows.find(item => String(item.line) === String(line));
  const targetEl = rowEl?.querySelector(".target");
  if (targetEl) targetEl.textContent = row ? rowValue(row) : "";
  rowEl?.classList.remove("manual");
  rowEl?.classList.remove("glossary");
  changedCount.textContent = Object.keys(state.edits).length;
  save();
  queueLanSyncPatch({ type: "line-restore", line: Number(line) });
}
document.getElementById("restore").onclick = restoreCurrentLine;
document.getElementById("export").onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "line-review-state.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
function jumpToSearchMatch(row) {
  if (!row) {
    render();
    return;
  }
  page = Math.ceil(Number(row.line) / pageSize);
  activeLine = String(row.line);
  render();
  requestAnimationFrame(scrollToActiveLine);
}
function moveSearchSelection(direction) {
  if (!searchMatches.length) {
    render();
    return;
  }
  const currentIndex = searchMatches.findIndex(row => String(row.line) === String(activeLine || ""));
  const nextIndex = currentIndex >= 0
    ? (currentIndex + direction + searchMatches.length) % searchMatches.length
    : (direction > 0 ? 0 : searchMatches.length - 1);
  jumpToSearchMatch(searchMatches[nextIndex]);
}
const searchInput = document.getElementById("search");
searchInput.addEventListener("input", (event) => {
  searchTerm = event.target.value;
  updateSearchMatches();
  jumpToSearchMatch(searchMatches[0]);
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  moveSearchSelection(event.shiftKey ? -1 : 1);
});
function lineFromLocationHash() {
  const hash = decodeURIComponent(location.hash || "");
  const match = hash.match(/(?:line|row)=(\d+)/i) || hash.match(/^#L?(\d+)$/i);
  const line = match ? Number(match[1]) : 0;
  return Number.isInteger(line) && line > 0 ? line : 0;
}
function scrollToActiveLine() {
  if (!activeLine) return;
  const row = rowsEl.querySelector('.row[data-line="' + activeLine + '"]');
  row?.scrollIntoView({ block: "center" });
}
function jumpToLine(line) {
  const targetLine = Number(line);
  if (!Number.isInteger(targetLine) || targetLine <= 0) return false;
  page = Math.ceil(targetLine / pageSize);
  activeLine = String(targetLine);
  render();
  requestAnimationFrame(scrollToActiveLine);
  return true;
}
addEventListener("hashchange", () => {
  const line = lineFromLocationHash();
  if (line) jumpToLine(line);
});
const aiStatus = document.getElementById("aiStatus");
const promptPreview = document.getElementById("promptPreview");
const agentPanel = document.getElementById("agentPanel");
const agentMessageInput = document.getElementById("agentMessageInput");
const interactiveAgentOutput = document.getElementById("interactiveAgentOutput");
const interactiveAgentStatus = document.getElementById("interactiveAgentStatus");
const agentSelect = document.getElementById("agentSelect");
const promptSettingsPanel = document.getElementById("promptSettingsPanel");
const promptSettingsHeading = document.getElementById("promptSettingsHeading");
const translatePromptSettings = document.getElementById("translatePromptSettings");
const proofreadPromptSettings = document.getElementById("proofreadPromptSettings");
const promptLanguagePair = document.getElementById("promptLanguagePair");
const promptStyle = document.getElementById("promptStyle");
const promptWorkDescription = document.getElementById("promptWorkDescription");
const promptTranslateOutputDir = document.getElementById("promptTranslateOutputDir");
const promptProofreadOutputDir = document.getElementById("promptProofreadOutputDir");
const promptSplit = document.getElementById("promptSplit");
const promptSplitSize = document.getElementById("promptSplitSize");
const promptSplitField = document.getElementById("promptSplitField");
const promptSplitSizeField = document.getElementById("promptSplitSizeField");
const promptSubagent = document.getElementById("promptSubagent");
const promptSubagentField = document.getElementById("promptSubagentField");
const promptSubagentCount = document.getElementById("promptSubagentCount");
const promptSubagentCountField = document.getElementById("promptSubagentCountField");
const promptProofreadMode = document.getElementById("promptProofreadMode");
const promptCandidateRatio = document.getElementById("promptCandidateRatio");
const promptMontecarloSize = document.getElementById("promptMontecarloSize");
const promptMontecarloRoundMin = document.getElementById("promptMontecarloRoundMin");
const promptMontecarloRoundMax = document.getElementById("promptMontecarloRoundMax");
const startLanSyncButton = document.getElementById("startLanSync");
const lanSyncPanel = document.getElementById("lanSyncPanel");
const lanSyncLinks = document.getElementById("lanSyncLinks");
const lanSyncPinInput = document.getElementById("lanSyncPin");
const copyLanSyncLinkButton = document.getElementById("copyLanSyncLink");
const stopLanSyncButton = document.getElementById("stopLanSync");
let activePromptKind = "translate";
let agentRawOutput = "";
let agentConsoleAgent = workflow.defaultAgent || "codex";
let agentConsoleSessionId = "";
let agentConsoleQuietTimer = 0;
let agentTerminal = undefined;
let agentFitAddon = undefined;
let lanSyncToken = "";
let lanSyncPrimaryUrl = "";
const lanSyncTimers = new Map();
function createAgentTerminal() {
  if (agentTerminal) return agentTerminal;
  if (!interactiveAgentOutput) return undefined;
  const TerminalCtor = window.Terminal?.Terminal || window.Terminal;
  if (!TerminalCtor) {
    interactiveAgentOutput.textContent = interactiveAgentOutput.dataset.empty || "";
    return undefined;
  }
  interactiveAgentOutput.textContent = "";
  agentTerminal = new TerminalCtor({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    scrollback: 8000,
    theme: {
      background: "#071523",
      foreground: "#dbeafe",
      cursor: "#ffffff",
      selectionBackground: "#355c7d"
    }
  });
  const FitAddonCtor = window.FitAddon?.FitAddon || window.FitAddon;
  if (FitAddonCtor) {
    agentFitAddon = new FitAddonCtor();
    agentTerminal.loadAddon(agentFitAddon);
  }
  agentTerminal.open(interactiveAgentOutput);
  agentTerminal.onData((rawInput) => {
    const bridge = invokeBridge();
    if (bridge?.writeAgentConsoleInput) void bridge.writeAgentConsoleInput(rawInput);
  });
  fitAgentTerminal();
  return agentTerminal;
}
function fitAgentTerminal() {
  if (!agentTerminal) return;
  try {
    agentFitAddon?.fit?.();
    const bridge = invokeBridge();
    if (bridge?.resizeAgentConsole) void bridge.resizeAgentConsole({ cols: agentTerminal.cols, rows: agentTerminal.rows });
  } catch {
    // xterm cannot measure before the panel is visible.
  }
}
function renderAgentConsoleOutput() {
  const terminal = createAgentTerminal();
  if (!terminal) return;
  fitAgentTerminal();
  terminal.reset?.();
  if (agentRawOutput) terminal.write(agentRawOutput);
  terminal.scrollToBottom?.();
}
function appendAgentConsoleOutput(chunk) {
  const terminal = createAgentTerminal();
  if (terminal && chunk) {
    fitAgentTerminal();
    terminal.write(chunk);
    terminal.scrollToBottom?.();
  }
}
function resetAgentConsoleTranscript() {
  agentRawOutput = "";
  agentTerminal?.reset?.();
  agentTerminal?.clear?.();
}
function setInteractiveAgentStatus(key) {
  if (!interactiveAgentStatus) return;
  const labels = data.labels || {};
  const text = key === "waiting"
    ? (labels.agentConsoleWaiting || "Waiting for Agent reply...")
    : key === "streaming"
      ? (labels.agentConsoleStreaming || "Agent is writing...")
      : key === "quiet"
        ? (labels.agentConsoleQuiet || "Output is quiet; likely finished.")
        : key === "running"
          ? (labels.agentConsoleRunning || "Console running")
          : (labels.agentConsoleStopped || "Agent Console stopped.");
  interactiveAgentStatus.textContent = text;
  interactiveAgentStatus.dataset.phase = key;
}
function markInteractiveAgentStreaming() {
  setInteractiveAgentStatus("streaming");
  if (agentConsoleQuietTimer) clearTimeout(agentConsoleQuietTimer);
  agentConsoleQuietTimer = setTimeout(() => setInteractiveAgentStatus("quiet"), 2200);
}
if (agentSelect) {
  agentSelect.value = workflow.defaultAgent || "codex";
}
function setAiStatus(text) {
  if (aiStatus) aiStatus.textContent = text || "";
}
const promptSettingsStorageKey = key + ":prompt-settings-v2";
function promptStoredDefaults() {
  const defaults = workflow.promptDefaults || {};
  return {
    languagePair: defaults.languagePair || "ja->zh-CN",
    style: defaults.style || "game",
    workDescription: defaults.workDescription || "",
    translateOutputDir: defaults.translateOutputDir || "",
    proofreadOutputDir: defaults.proofreadOutputDir || "",
    split: defaults.split !== false,
    splitSize: Number(defaults.splitSize || 2000),
    subagent: defaults.subagent === true,
    subagentCount: Number(defaults.subagentCount || 3),
    proofreadMode: defaults.proofreadMode === "montecarlo" ? "montecarlo" : "split",
    candidateRatio: Number(defaults.candidateRatio || 1.5),
    montecarloSize: Number(defaults.montecarloSize || 3000),
    montecarloRoundMin: Number(defaults.montecarloRoundMin || 2),
    montecarloRoundMax: Number(defaults.montecarloRoundMax || 5)
  };
}
function readStoredPromptSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(promptSettingsStorageKey) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function promptSettingsValue() {
  return { ...promptStoredDefaults(), ...readStoredPromptSettings() };
}
function writeStoredPromptSettings(settings) {
  localStorage.setItem(promptSettingsStorageKey, JSON.stringify(settings));
}
function setFieldValue(field, value) {
  if (field) field.value = value ?? "";
}
function setFieldChecked(field, value) {
  if (field) field.checked = value === true;
}
function numberFromField(field, fallback) {
  const value = Number(field?.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function currentPromptSettings() {
  const defaults = promptStoredDefaults();
  const proofreadMode = promptProofreadMode?.value === "montecarlo" ? "montecarlo" : "split";
  return {
    languagePair: promptLanguagePair?.value.trim() || defaults.languagePair,
    style: promptStyle?.value.trim() || defaults.style,
    workDescription: promptWorkDescription?.value.trim() || "",
    translateOutputDir: promptTranslateOutputDir?.value.trim() || defaults.translateOutputDir,
    proofreadOutputDir: promptProofreadOutputDir?.value.trim() || defaults.proofreadOutputDir,
    split: promptSplit?.checked !== false,
    splitSize: numberFromField(promptSplitSize, defaults.splitSize),
    subagent: proofreadMode === "montecarlo" ? false : promptSubagent?.checked === true,
    subagentCount: numberFromField(promptSubagentCount, defaults.subagentCount),
    proofreadMode,
    candidateRatio: Number(promptCandidateRatio?.value || defaults.candidateRatio) || defaults.candidateRatio,
    montecarloSize: numberFromField(promptMontecarloSize, defaults.montecarloSize),
    montecarloRoundMin: numberFromField(promptMontecarloRoundMin, defaults.montecarloRoundMin),
    montecarloRoundMax: numberFromField(promptMontecarloRoundMax, defaults.montecarloRoundMax)
  };
}
function fillPromptSettingsForm() {
  const settings = promptSettingsValue();
  setFieldValue(promptLanguagePair, settings.languagePair);
  setFieldValue(promptStyle, settings.style);
  setFieldValue(promptWorkDescription, settings.workDescription);
  setFieldValue(promptTranslateOutputDir, settings.translateOutputDir);
  setFieldValue(promptProofreadOutputDir, settings.proofreadOutputDir);
  setFieldChecked(promptSplit, settings.split);
  setFieldValue(promptSplitSize, settings.splitSize);
  setFieldChecked(promptSubagent, settings.subagent);
  setFieldValue(promptSubagentCount, settings.subagentCount);
  setFieldValue(promptProofreadMode, settings.proofreadMode);
  setFieldValue(promptCandidateRatio, settings.candidateRatio);
  setFieldValue(promptMontecarloSize, settings.montecarloSize);
  setFieldValue(promptMontecarloRoundMin, settings.montecarloRoundMin);
  setFieldValue(promptMontecarloRoundMax, settings.montecarloRoundMax);
}
function updatePromptSettingsVisibility() {
  const isProofread = activePromptKind === "proofread";
  const isTranslate = !isProofread;
  const isMontecarlo = isProofread && promptProofreadMode?.value === "montecarlo";
  const isSplitProofread = isProofread && !isMontecarlo;
  const isTranslateSplit = isTranslate && promptSplit?.checked !== false;
  if (promptSettingsHeading) {
    promptSettingsHeading.textContent = isProofread
      ? (data.labels.promptSettingsProofreadTitle || "Proofread parameters")
      : (data.labels.promptSettingsTranslateTitle || "Translate parameters");
  }
  if (translatePromptSettings) translatePromptSettings.hidden = isProofread;
  if (proofreadPromptSettings) proofreadPromptSettings.hidden = !isProofread;
  if (promptSplitField) promptSplitField.hidden = !isTranslate;
  if (promptSplitSizeField) promptSplitSizeField.hidden = !(isTranslateSplit || isSplitProofread);
  if (promptSubagentField) promptSubagentField.hidden = isMontecarlo;
  document.querySelectorAll(".prompt-montecarlo-field").forEach((field) => {
    field.hidden = !isMontecarlo;
  });
  if (promptSubagent) {
    promptSubagent.disabled = isMontecarlo;
    if (isMontecarlo) promptSubagent.checked = false;
  }
  if (promptSubagentCountField) {
    promptSubagentCountField.hidden = isMontecarlo || promptSubagent?.checked !== true;
  }
}
function openPromptSettings(kind) {
  activePromptKind = kind;
  fillPromptSettingsForm();
  updatePromptSettingsVisibility();
  if (promptSettingsPanel) promptSettingsPanel.hidden = false;
  setAiStatus("");
}
function closePromptSettings() {
  if (promptSettingsPanel) promptSettingsPanel.hidden = true;
}
async function buildPromptFromSettings() {
  const settings = currentPromptSettings();
  writeStoredPromptSettings(settings);
  const bridge = invokeBridge();
  let generated = "";
  if (bridge?.buildPrompt) {
    try {
      generated = await bridge.buildPrompt({
        kind: activePromptKind,
        agent: agentSelect?.value || workflow.defaultAgent || "codex",
        sourcePath: workflow.paths?.promptSourcePath || workflow.paths?.sourcePath || "",
        translationPath: boundPromptTranslationPath(),
        outputDir: workflow.paths?.outputDir || "",
        glossaryPath: boundGlossaryPath(),
        inputMode: workflow.promptInputMode || workflow.inputMode || "separate",
        advanced: settings
      });
    } catch (error) {
      setAiStatus((data.labels.promptGenerationFailed || "Prompt generation failed") + ": " + (error?.message || String(error)));
    }
  }
  if (!generated) {
    generated = activeAgentPrompts()[activePromptKind] || "";
  }
  setPromptText(promptWithAuditWhitelist(generated));
  closePromptSettings();
  openAgentPanel();
  agentMessageInput?.focus();
}
function openAgentPanel() {
  if (agentPanel) agentPanel.hidden = false;
  ensureAgentMessageInput();
  createAgentTerminal();
  requestAnimationFrame(() => {
    fitAgentTerminal();
    agentTerminal?.focus?.();
  });
  void refreshInteractiveAgentSnapshot();
}
function ensureAgentMessageInput() {
  if (!promptPreview.value) {
    activePromptKind = "translate";
    promptPreview.value = promptWithAuditWhitelist(activeAgentPrompts().translate || "");
  }
  if (agentMessageInput && !agentMessageInput.value.trim()) {
    agentMessageInput.value = promptPreview.value;
  }
  return agentMessageInput?.value || promptPreview.value;
}
function setPromptText(text) {
  promptPreview.value = text || "";
  if (agentMessageInput) agentMessageInput.value = promptPreview.value;
}
function activeAgentPrompts() {
  const agent = agentSelect?.value || workflow.defaultAgent || "codex";
  return workflow.prompts?.[agent] || workflow.prompts?.codex || {};
}
function auditWhitelistPathLabel() {
  const outputDir = workflow.paths?.outputDir || "";
  if (!outputDir || outputDir.startsWith("[")) return ".translation-workshop/audit-whitelist.json";
  return outputDir.replace(/[\\/]$/, "") + "/.translation-workshop/audit-whitelist.json";
}
function auditWhitelistLines() {
  return Object.keys(state.auditWhitelist || {}).map(Number).filter(line => Number.isInteger(line) && line > 0).sort((left, right) => left - right);
}
function auditWhitelistInstruction() {
  const lines = auditWhitelistLines();
  if (lines.length === 0) return "";
  const template = data.labels.auditPromptNote || "Audit whitelist lines are recorded at {path}; line numbers: {lines}. Skip these lines in every proofreading/audit report.";
  return "\n\n" + template.replace("{path}", auditWhitelistPathLabel()).replace("{lines}", lines.join(", "));
}
function promptWithAuditWhitelist(prompt) {
  return String(prompt || "") + auditWhitelistInstruction();
}
const syncDbName = "translation-workshop-html-cache";
const syncStoreName = "line-sync-v1";
const syncTextKey = key + ":translation-text";
// Bump when embedded prompts or prompt-related HTML behavior changes; old HTML will auto-upgrade.
const promptSettingsVersion = 8;
function splitSyncedText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r$/, "").replace(/\n$/, "").split("\n");
}
function openSyncDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(syncDbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(syncStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readCacheValue(cacheKey) {
  const db = await openSyncDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(syncStoreName, "readonly");
    const request = transaction.objectStore(syncStoreName).get(cacheKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}
async function writeCacheValue(cacheKey, value) {
  const db = await openSyncDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(syncStoreName, "readwrite");
    transaction.objectStore(syncStoreName).put(value, cacheKey);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}
function readSyncedText() {
  return readCacheValue(syncTextKey);
}
function writeSyncedText(text) {
  return writeCacheValue(syncTextKey, text);
}
async function restoreSyncedText() {
  if (!state.syncedFile) return;
  try {
    const text = await readSyncedText();
    if (typeof text !== "string") return;
    syncedLines = splitSyncedText(text);
    render();
    setAiStatus((data.labels.synced || "Translation synced") + ": " + state.syncedFile + " (" + syncedLines.length + "/" + data.rows.length + ")");
  } catch {
    setAiStatus(state.syncedFile ? (data.labels.synced || "Translation synced") + ": " + state.syncedFile : "");
  }
}
document.getElementById("translatePrompt")?.addEventListener("click", () => {
  openPromptSettings("translate");
});
document.getElementById("proofreadPrompt")?.addEventListener("click", () => {
  openPromptSettings("proofread");
});
document.getElementById("applyPromptSettings")?.addEventListener("click", () => {
  void buildPromptFromSettings();
});
document.getElementById("cancelPromptSettings")?.addEventListener("click", closePromptSettings);
promptProofreadMode?.addEventListener("change", updatePromptSettingsVisibility);
promptSplit?.addEventListener("change", updatePromptSettingsVisibility);
promptSubagent?.addEventListener("change", updatePromptSettingsVisibility);
function currentLineReviewPath() {
  if (location.protocol !== "file:") {
    return location.href;
  }
  return decodeURIComponent(location.pathname)
    .replace(/^\/([A-Za-z]:[\\/])/, "$1")
    .replace(/\//g, "\\");
}
function currentHtmlPath() {
  if (location.protocol !== "file:") {
    return location.href;
  }
  return decodeURIComponent(location.pathname)
    .replace(/^\/([A-Za-z]:[\\/])/, "$1")
    .replace(/\//g, "\\");
}
async function generateReviewHtmlFromReport(preferredReportPath) {
  const bridge = writeBridge();
  if (!bridge?.generateProposalReview) {
    setAiStatus(data.labels.reviewHtmlNeedsApp || "Open this HTML in translation-workshop to generate review HTML.");
    return;
  }
  const outputDir = workflow.paths?.outputDir || "";
  if (!outputDir || outputDir.startsWith("[")) {
    setAiStatus(data.labels.reviewGenerationFailed || "Review HTML generation failed");
    return;
  }
  try {
    let reportPath = typeof preferredReportPath === "string" ? preferredReportPath : "";
    if (!reportPath && bridge.findProofreadReport) {
      const reports = await bridge.findProofreadReport(outputDir);
      reportPath = reports?.[0]?.path || "";
      if (reportPath) {
        setAiStatus((data.labels.reviewReportFound || "Report found") + ": " + reportPath);
      }
    }
    const result = await bridge.generateProposalReview({
      reportPath,
      outputDir,
      pageSize: data.pageSize || 1000,
      startPage: 1,
      locale: document.documentElement.lang === "en-US" ? "en-US" : "zh-CN",
      lineReviewPath: currentLineReviewPath()
    });
    if (result?.fallbackPrompt) {
      setPromptText(result.fallbackPrompt);
      openAgentPanel();
      agentMessageInput?.focus();
      setAiStatus(data.labels.reviewFormatFallback || "The AI report failed format validation. A repair prompt was generated.");
      return;
    }
    setAiStatus((data.labels.reviewGenerated || "Review HTML generated") + ": " + (result?.outputPath || "") + " (" + (result?.proposalCount || 0) + ")");
    if (result?.outputPath && bridge.openPath) {
      await bridge.openPath(result.outputPath);
    }
  } catch (error) {
    setAiStatus((data.labels.reviewGenerationFailed || "Review HTML generation failed") + ": " + (error?.message || String(error)));
  }
}
document.getElementById("generateReviewHtml")?.addEventListener("click", () => generateReviewHtmlFromReport());
document.getElementById("copyPrompt")?.addEventListener("click", async () => {
  ensureAgentMessageInput();
  promptPreview.value = agentMessageInput?.value || promptPreview.value;
  promptPreview.select();
  try {
    await navigator.clipboard.writeText(promptPreview.value);
  } catch {
    document.execCommand("copy");
  }
  setAiStatus(data.labels.copied || "Copied");
});
agentMessageInput?.addEventListener("input", () => {
  promptPreview.value = agentMessageInput.value;
});
agentMessageInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendInteractiveAgentMessage();
  }
});
function invokeBridge() {
  return window.workshopHtml || window.parent?.workshopHtml || window.workshop || window.parent?.workshop;
}
function lanSyncRowPayload() {
  return data.rows.map(row => ({
    line: row.line,
    source: row.source,
    translation: rowValue(row),
    status: state.status[row.line] || row.status || ""
  }));
}
function lanSyncLineDocumentPayload() {
  return {
    title: document.title || "translation-workshop",
    rows: lanSyncRowPayload(),
    state,
    pageSize,
    lineReviewPath: currentLineReviewPath()
  };
}
window.translationWorkshopLineLanSyncPayload = lanSyncLineDocumentPayload;
function renderLanSyncLinks(result) {
  if (!lanSyncPanel || !lanSyncLinks) return;
  const lanUrls = Array.isArray(result?.lanUrls) ? result.lanUrls : [];
  lanSyncPrimaryUrl = lanUrls[0] || result?.localUrl || "";
  const linkRows = [];
  if (lanUrls[0]) {
    linkRows.push('<div><b>' + escapeHtml(data.labels.lanSyncLanUrl || "LAN address") + ':</b> <a href="' + escapeHtml(lanUrls[0]) + '">' + escapeHtml(lanUrls[0]) + '</a></div>');
  }
  if (result?.localUrl) {
    linkRows.push('<div><b>' + escapeHtml(data.labels.lanSyncLocalUrl || "Local address") + ':</b> <a href="' + escapeHtml(result.localUrl) + '">' + escapeHtml(result.localUrl) + '</a></div>');
  }
  lanSyncLinks.innerHTML = linkRows.join("");
  lanSyncPanel.hidden = false;
}
async function startLanSync() {
  const bridge = invokeBridge();
  if (!bridge?.startLanSync) {
    setAiStatus(data.labels.lanSyncNeedsApp || "LAN sync requires opening this HTML inside translation-workshop.");
    return;
  }
  const pin = String(lanSyncPinInput?.value || "").trim();
  if (!/^\d{6}$/.test(pin)) {
    setAiStatus(data.labels.lanSyncPinInvalid || "Enter a 6-digit numeric PIN.");
    lanSyncPinInput?.focus?.();
    return;
  }
  try {
    const result = await bridge.startLanSync({
      pin,
      htmlPath: currentHtmlPath(),
      outputDir: workflow.paths?.outputDir || "",
      agent: agentSelect?.value || workflow.defaultAgent || "codex",
      title: document.title || "translation-workshop",
      lineDocument: lanSyncLineDocumentPayload(),
      pageSize,
      locale: document.documentElement.lang === "en-US" ? "en-US" : "zh-CN"
    });
    lanSyncToken = result?.token || "";
    renderLanSyncLinks(result);
    setAiStatus((data.labels.lanSyncStarted || "LAN sync started") + ": " + (lanSyncPrimaryUrl || result?.localUrl || ""));
  } catch (error) {
    setAiStatus((data.labels.lanSyncFailed || "LAN sync failed") + ": " + (error?.message || String(error)));
  }
}
function queueLanSyncPatch(patch) {
  if (!lanSyncToken) return;
  const bridge = invokeBridge();
  if (!bridge?.sendLanSyncPatch) return;
  const line = Number(patch.line || 0);
  clearTimeout(lanSyncTimers.get(line));
  lanSyncTimers.set(line, setTimeout(() => {
    bridge.sendLanSyncPatch({
      token: lanSyncToken,
      patch: { ...patch, clientId: "desktop", timestamp: new Date().toISOString() }
    }).catch(() => {});
  }, patch.type === "line-edit" ? 250 : 0));
}
function applyRemoteLanSyncPatch(payload) {
  if (!payload || payload.token !== lanSyncToken) return;
  const patch = payload.patch || {};
  if (patch.clientId === "desktop") return;
  const line = Number(patch.line || 0);
  if (!Number.isInteger(line) || line <= 0) return;
  if (patch.type === "line-restore") {
    delete state.edits[line];
    delete state.status[line];
  } else {
    state.edits[line] = String(patch.text ?? "");
    state.status[line] = patch.status || "manual";
  }
  activeLine = String(line);
  save();
  const target = rowsEl.querySelector('.row[data-line="' + line + '"] .target');
  if (target && document.activeElement !== target) {
    target.textContent = rowValue({ line });
  }
  changedCount.textContent = Object.keys(state.edits).length;
}
invokeBridge()?.onLanSyncPatch?.(applyRemoteLanSyncPatch);
startLanSyncButton?.addEventListener("click", () => { void startLanSync(); });
copyLanSyncLinkButton?.addEventListener("click", () => {
  if (!lanSyncPrimaryUrl) return;
  navigator.clipboard?.writeText(lanSyncPrimaryUrl).then(() => setAiStatus(data.labels.copied || "Copied")).catch(() => {});
});
stopLanSyncButton?.addEventListener("click", () => {
  const token = lanSyncToken;
  lanSyncToken = "";
  lanSyncPanel.hidden = true;
  if (token) invokeBridge()?.stopLanSync?.(token).catch(() => {});
  setAiStatus(data.labels.lanSyncStopped || "LAN sync stopped");
});
async function refreshInteractiveAgentSnapshot() {
  const bridge = invokeBridge();
  if (!bridge?.agentConsoleStatus) return;
  try {
    const snapshot = await bridge.agentConsoleStatus();
    if (!snapshot?.running) return;
    if (snapshot.agent) agentConsoleAgent = snapshot.agent;
    if (snapshot.id && snapshot.id !== agentConsoleSessionId) {
      agentConsoleSessionId = snapshot.id;
      resetAgentConsoleTranscript();
    }
    if (interactiveAgentOutput && snapshot?.output) {
      agentRawOutput = snapshot.output;
      renderAgentConsoleOutput();
    }
    setInteractiveAgentStatus("running");
  } catch {
    // Older app bridges do not expose resumable console snapshots.
  }
}
async function startInteractiveAgent() {
  openAgentPanel();
  const bridge = invokeBridge();
  if (!bridge?.startAgentConsole) {
    setAiStatus(data.labels.agentConsoleNeedsApp || "Open this HTML in translation-workshop to send the prompt to Agent.");
    return false;
  }
  const outputDir = workflow.paths?.outputDir || "";
  if (!outputDir || outputDir.startsWith("[")) {
    setAiStatus(data.labels.agentConsoleNeedsOutput || "Output folder is required.");
    return false;
  }
  try {
    const requestedAgent = agentSelect?.value || workflow.defaultAgent || "codex";
    agentConsoleAgent = requestedAgent;
    const started = await bridge.startAgentConsole({
      agent: requestedAgent,
      outputDir,
      cols: agentTerminal?.cols || 120,
      rows: agentTerminal?.rows || 32
    });
    if (!started?.ok) {
      setAiStatus((data.labels.agentLaunchFailed || "Agent launch failed") + ": " + (started?.message || ""));
      return false;
    }
    if (started?.status?.id && started.status.id !== agentConsoleSessionId) {
      agentConsoleSessionId = started.status.id;
      resetAgentConsoleTranscript();
    }
    if (started?.status?.agent) agentConsoleAgent = started.status.agent;
    setInteractiveAgentStatus("running");
    setAiStatus(started?.message || (data.labels.agentLaunched || "Agent launched"));
    return true;
  } catch (error) {
    setAiStatus((data.labels.agentLaunchFailed || "Agent launch failed") + ": " + (error?.message || String(error)));
    return false;
  }
}
async function sendInteractiveAgentMessage() {
  const promptText = ensureAgentMessageInput();
  const bridge = invokeBridge();
  if (!bridge?.sendAgentConsoleInput) {
    setAiStatus(data.labels.agentConsoleNeedsApp || "Open this HTML in translation-workshop to send the prompt to Agent.");
    return;
  }
  const started = await startInteractiveAgent();
  if (!started) return;
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    setInteractiveAgentStatus("waiting");
    if (agentMessageInput) agentMessageInput.value = "";
    promptPreview.value = "";
    const result = await bridge.sendAgentConsoleInput(promptText);
    if (!result?.ok) {
      if (agentMessageInput) agentMessageInput.value = promptText;
      promptPreview.value = promptText;
    }
    setAiStatus(result?.ok
      ? result.promptPath
        ? (data.labels.promptSentViaFile || "Prompt saved to file") + ": " + result.promptPath
        : (data.labels.promptSentToAgent || "Prompt sent to Agent")
      : (result?.message || data.labels.agentLaunchFailed || "Agent launch failed"));
  } catch (error) {
    setAiStatus((data.labels.agentLaunchFailed || "Agent launch failed") + ": " + (error?.message || String(error)));
  }
}
document.getElementById("callAgent")?.addEventListener("click", () => openAgentPanel());
document.getElementById("collapseAgentPanel")?.addEventListener("click", () => {
  if (agentPanel) agentPanel.hidden = true;
});
window.addEventListener("resize", () => fitAgentTerminal());
document.getElementById("startInteractiveAgent")?.addEventListener("click", startInteractiveAgent);
document.getElementById("sendInteractiveAgentMessage")?.addEventListener("click", sendInteractiveAgentMessage);
document.getElementById("stopInteractiveAgent")?.addEventListener("click", async () => {
  const bridge = invokeBridge();
  try {
    await bridge?.stopAgentConsole?.();
    setInteractiveAgentStatus("stopped");
    setAiStatus(data.labels.agentConsoleStopped || "Agent Console stopped.");
  } catch (error) {
    setAiStatus((data.labels.agentLaunchFailed || "Agent launch failed") + ": " + (error?.message || String(error)));
  }
});
{
  const bridge = invokeBridge();
  if (bridge?.onAgentConsoleData && interactiveAgentOutput) {
    bridge.onAgentConsoleData((payload) => {
      if (payload.id && payload.id !== agentConsoleSessionId) {
        agentConsoleSessionId = payload.id;
        resetAgentConsoleTranscript();
      }
      agentRawOutput = (agentRawOutput + payload.data).slice(-240000);
      markInteractiveAgentStreaming();
      appendAgentConsoleOutput(payload.data);
    });
  }
  if (bridge?.onAgentConsoleExit) {
    bridge.onAgentConsoleExit((payload) => {
      setInteractiveAgentStatus("stopped");
      setAiStatus((data.labels.agentConsoleStopped || "Agent Console stopped.") + ": " + (payload.exitCode ?? ""));
    });
  }
  void refreshInteractiveAgentSnapshot();
}
async function syncLines(lines, label) {
  syncedLines = lines;
  delete state.synced;
  let importedCount = 0;
  for (let index = 0; index < data.rows.length; index += 1) {
    const lineNo = data.rows[index].line;
    if (lines[index] !== undefined && state.status[lineNo] !== "manual") {
      delete state.edits[lineNo];
      delete state.status[lineNo];
      importedCount += 1;
    }
  }
  state.syncedFile = label;
  state.syncedAt = new Date().toISOString();
  save();
  render();
  setAiStatus((data.labels.synced || "Translation synced") + ": " + label + " (" + importedCount + "/" + data.rows.length + ")");
  try {
    await writeSyncedText(lines.join("\n"));
  } catch (error) {
    console.warn("translation-workshop could not persist imported translation text", error);
  }
}
function openTranslationFilePicker() {
  const input = document.getElementById("syncTranslationInput");
  if (!input) return;
  input.value = "";
  input.click();
}
const translationFileFilters = [
  { name: "Text files", extensions: ["txt"] },
  { name: "All files", extensions: ["*"] }
];
const glossaryFileFilters = [
  { name: "Glossary files", extensions: ["json", "tsv", "txt", "csv"] },
  { name: "All files", extensions: ["*"] }
];
async function chooseTranslationFile() {
  const bridge = writeBridge();
  if (!bridge?.openFile || !bridge?.readTextFile) {
    openTranslationFilePicker();
    return;
  }
  const filePath = await bridge.openFile(translationFileFilters);
  if (!filePath) return;
  try {
    const result = await bridge.readTextFile({ path: filePath });
    if (typeof result?.text !== "string") return;
    const nextPath = result?.path || filePath;
    setBoundTranslationPath(nextPath, nextPath);
    await syncLines(splitSyncedText(result.text), nextPath);
  } catch (error) {
    setAiStatus((data.labels.syncFailed || "Translation sync failed") + ": " + (error?.message || String(error)));
  }
}
async function syncFromBoundTranslationFile() {
  const translationPath = boundTranslationPath();
  const bridge = writeBridge();
  if (!translationPath || !bridge?.readTextFile) return false;
  try {
    const result = await bridge.readTextFile({ path: translationPath });
    if (typeof result?.text !== "string") return false;
    const nextPath = result?.path || translationPath;
    setBoundTranslationPath(nextPath, nextPath);
    await syncLines(splitSyncedText(result.text), nextPath);
    return true;
  } catch (error) {
    setAiStatus((data.labels.syncFailed || "Translation sync failed") + ": " + (error?.message || String(error)));
    return false;
  }
}
async function syncFromInitialTranslation() {
  if (await syncFromBoundTranslationFile()) return;
  if (state.syncedFile && syncedLines.length > 0) {
    render();
    setAiStatus((data.labels.synced || "Translation synced") + ": " + state.syncedFile + " (" + syncedLines.length + "/" + data.rows.length + ")");
    return;
  }
  if (state.syncedFile) {
    try {
      const text = await readSyncedText();
      if (typeof text === "string") {
        syncedLines = splitSyncedText(text);
        render();
        setAiStatus((data.labels.synced || "Translation synced") + ": " + state.syncedFile + " (" + syncedLines.length + "/" + data.rows.length + ")");
        return;
      }
    } catch {
      // If the cache is unavailable, fall back to choosing a translation file.
    }
  }
  const lines = workflow.initialTranslationLines || [];
  if (!workflow.hasInitialTranslation) {
    openTranslationFilePicker();
    return;
  }
  syncLines(lines, boundTranslationPath() || "embedded translation");
}
function currentTargetLines() {
  return data.rows.map((row) => rowValue(row));
}
function currentTargetText() {
  return currentTargetLines().join("\n");
}
function currentBilingualTxtText() {
  const pair = workflow.bilingualPair || { sourcePosition: 1, translationPosition: 2, pairSize: 2 };
  return data.rows.map((row) => {
    const values = ["", ""];
    const sourceIndex = Number(pair.sourcePosition) === 1 ? 0 : 1;
    const translationIndex = Number(pair.translationPosition) === 1 ? 0 : 1;
    values[sourceIndex] = row.source;
    values[translationIndex] = rowValue(row);
    return values.join("\n");
  }).join("\n\n");
}
function exportTxtMode() {
  return document.getElementById("exportTxtMode")?.value || "translation";
}
function currentTxtExportText() {
  return exportTxtMode() === "bilingual" ? currentBilingualTxtText() : currentTargetText();
}
function suggestedTxtName() {
  const raw = boundTranslationPath() || "translation-workshop-output.txt";
  return raw.split(/[\\/]/).pop() || "translation-workshop-output.txt";
}
function suggestedTxtDownloadName() {
  const name = suggestedTxtName().replace(/\.(epub|json|jsv)$/i, ".txt");
  return exportTxtMode() === "bilingual" ? name.replace(/\.txt$/i, ".bilingual.txt") : name;
}
function downloadTxt() {
  const blob = new Blob([currentTxtExportText()], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedTxtDownloadName();
  a.click();
  URL.revokeObjectURL(a.href);
}
function boundTranslationPath() {
  return state.translationPath || workflow.paths?.translationPath || "";
}
function boundPromptTranslationPath() {
  return state.translationPromptPath || workflow.paths?.promptTranslationPath || boundTranslationPath();
}
function workflowPaths() {
  workflow.paths ||= {};
  return workflow.paths;
}
function setBoundTranslationPath(path, promptPath) {
  const value = String(path || "").trim();
  if (!value) return;
  const promptValue = String(promptPath || value).trim();
  state.translationPath = value;
  state.translationPromptPath = promptValue;
  const paths = workflowPaths();
  paths.translationPath = value;
  paths.promptTranslationPath = promptValue;
  save();
}
function writeBridge() {
  return window.workshopHtml || window.parent?.workshopHtml;
}
async function writeCurrentTranslationFile() {
  const targetPath = boundTranslationPath();
  if (!targetPath) {
    setAiStatus(data.labels.txtWriteMissingTarget || "No translation file is bound to this HTML.");
    return;
  }
  const bridge = writeBridge();
  if (!bridge?.writeTextFile) {
    setAiStatus((data.labels.txtWriteNeedsApp || "Open this HTML in translation-workshop to write TXT.") + ": " + targetPath);
    return;
  }
  try {
    const result = await bridge.writeTextFile({ path: targetPath, text: currentTargetText(), outputDir: workflow.paths?.outputDir });
    state.savedTxtFile = result?.path || targetPath;
    state.savedTxtAt = new Date().toISOString();
    setBoundTranslationPath(state.savedTxtFile, state.savedTxtFile);
    save();
    setAiStatus((data.labels.txtWritten || "TXT written") + ": " + state.savedTxtFile);
  } catch (error) {
    setAiStatus((data.labels.txtWriteFailed || "TXT write failed") + ": " + (error?.message || String(error)));
  }
}
async function writeCurrentEpubCopy() {
  const templatePath = workflow.paths?.sourcePath || "";
  if (!templatePath.toLowerCase().endsWith(".epub")) {
    setAiStatus(data.labels.epubWriteMissingTemplate || "No EPUB template path is bound to this HTML.");
    return;
  }
  const bridge = writeBridge();
  if (!bridge?.writeEpubFile) {
    setAiStatus((data.labels.epubWriteNeedsApp || "Open this HTML in translation-workshop to export EPUB.") + ": " + templatePath);
    return;
  }
  try {
    const result = await bridge.writeEpubFile({ templatePath, lines: currentTargetLines(), outputDir: workflow.paths?.outputDir, ...(workflow.epubExport || {}) });
    state.savedEpubFile = result?.path || "";
    state.savedEpubAt = new Date().toISOString();
    save();
    setAiStatus((data.labels.epubWritten || "EPUB exported") + ": " + state.savedEpubFile);
  } catch (error) {
    setAiStatus((data.labels.epubWriteFailed || "EPUB export failed") + ": " + (error?.message || String(error)));
  }
}
document.getElementById("syncTranslation")?.addEventListener("click", syncFromInitialTranslation);
document.getElementById("chooseTranslationFile")?.addEventListener("click", () => {
  void chooseTranslationFile();
});
document.getElementById("syncTranslationInput")?.addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const filePath = file.path || "";
    if (filePath) {
      setBoundTranslationPath(filePath, filePath);
    }
    await syncLines(splitSyncedText(text), filePath || file.name);
  } finally {
    input.value = "";
  }
});
document.getElementById("exportTxt")?.addEventListener("click", downloadTxt);
document.getElementById("saveTxt")?.addEventListener("click", writeCurrentTranslationFile);
document.getElementById("exportEpub")?.addEventListener("click", writeCurrentEpubCopy);
let glossaryEntries = workflow.glossaryEntries || [];
state.glossaryTargets ||= {};
state.glossaryAliases ||= {};
state.glossaryPath ||= workflow.paths?.glossaryPath || "";
const glossaryDrawer = document.getElementById("glossaryTools");
const glossaryBackdrop = document.getElementById("glossaryBackdrop");
const glossaryListEl = document.getElementById("glossaryList");
const glossaryCountEl = document.getElementById("glossaryCount");
const glossaryHelpEl = document.getElementById("glossaryHelp");
const glossarySearchEl = document.getElementById("glossarySearch");
const glossarySearchMetaEl = document.getElementById("glossarySearchMeta");
const glossaryRenderBatchSize = 120;
let glossaryVisibleCount = glossaryRenderBatchSize;
function setGlossaryDrawer(open) {
  glossaryDrawer?.classList.toggle("open", open);
  glossaryBackdrop?.classList.toggle("open", open);
  glossaryDrawer?.setAttribute("aria-hidden", open ? "false" : "true");
}
document.getElementById("glossaryDrawerToggle")?.addEventListener("click", () => setGlossaryDrawer(true));
document.getElementById("glossaryDrawerClose")?.addEventListener("click", () => setGlossaryDrawer(false));
glossaryBackdrop?.addEventListener("click", () => setGlossaryDrawer(false));
function uniqueGlossaryTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const term = String(value || "").trim();
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}
function glossaryTarget(index) {
  const custom = state.glossaryTargets?.[index];
  return typeof custom === "string" ? custom : (glossaryEntries[index]?.target || "");
}
function glossaryAliases(index) {
  const aliases = state.glossaryAliases?.[index];
  return Array.isArray(aliases) ? aliases : [];
}
function currentGlossaryEntries() {
  return glossaryEntries.map((entry, index) => ({ source: entry.source, target: glossaryTarget(index) }))
    .filter(entry => entry.source && entry.target);
}
function boundGlossaryPath() {
  return state.glossaryPath || workflow.paths?.glossaryPath || "";
}
function setBoundGlossaryPath(path) {
  const value = String(path || "").trim();
  if (!value) return;
  state.glossaryPath = value;
  workflowPaths().glossaryPath = value;
  save();
}
function glossarySearchQuery() {
  return String(glossarySearchEl?.value || "").trim().toLocaleLowerCase();
}
function glossaryEntryMatches(entry, index, query) {
  if (!query) return true;
  return [entry.source, entry.target, glossaryTarget(index), ...glossaryAliases(index)]
    .some(value => String(value || "").toLocaleLowerCase().includes(query));
}
function matchingGlossaryEntries() {
  const query = glossarySearchQuery();
  return glossaryEntries
    .map((entry, index) => ({ entry, index }))
    .filter(item => glossaryEntryMatches(item.entry, item.index, query));
}
function glossaryEntryHtml(entry, index) {
  const target = glossaryTarget(index);
  return '<div class="glossary-entry" data-glossary-index="' + index + '">' +
    '<input class="glossary-source" data-glossary-index="' + index + '" value="' + escapeHtml(entry.source) + '" readonly title="source term">' +
    '<b>→</b>' +
    '<input class="glossary-target" data-glossary-index="' + index + '" value="' + escapeHtml(target) + '" data-original-target="' + escapeHtml(entry.target) + '" data-current-target="' + escapeHtml(target) + '" title="translation term">' +
    '</div>';
}
function renderGlossaryEntries() {
  if (!glossaryListEl) return;
  if (glossaryEntries.length === 0) {
    if (glossaryCountEl) glossaryCountEl.textContent = "0";
    if (glossarySearchMetaEl) glossarySearchMetaEl.textContent = "";
    if (glossaryHelpEl) glossaryHelpEl.textContent = data.labels.glossaryEmpty || "No glossary loaded";
    glossaryListEl.innerHTML = "";
    return;
  }
  const query = glossarySearchQuery();
  const matchingEntries = matchingGlossaryEntries();
  glossaryVisibleCount = Math.min(Math.max(glossaryRenderBatchSize, glossaryVisibleCount), matchingEntries.length);
  const visibleEntries = matchingEntries.slice(0, glossaryVisibleCount);
  if (glossaryCountEl) glossaryCountEl.textContent = query ? (matchingEntries.length + "/" + glossaryEntries.length) : String(glossaryEntries.length);
  if (glossarySearchMetaEl) glossarySearchMetaEl.textContent = visibleEntries.length + "/" + matchingEntries.length;
  if (glossaryHelpEl) glossaryHelpEl.textContent = data.labels.glossaryEditHelp || "Edit the right-side term. Source text is never modified.";
  if (visibleEntries.length === 0) {
    glossaryListEl.innerHTML = '<p class="ai-status">' + escapeHtml(data.labels.glossarySearchNoMatches || "No matching terms") + '</p>';
    return;
  }
  glossaryListEl.innerHTML = visibleEntries.map(({ entry, index }) => glossaryEntryHtml(entry, index)).join("");
}
function loadMoreGlossaryEntries() {
  const matchingEntries = matchingGlossaryEntries();
  if (glossaryVisibleCount >= matchingEntries.length) return;
  const previousCount = glossaryVisibleCount;
  glossaryVisibleCount = Math.min(glossaryVisibleCount + glossaryRenderBatchSize, matchingEntries.length);
  glossaryListEl?.insertAdjacentHTML(
    "beforeend",
    matchingEntries
      .slice(previousCount, glossaryVisibleCount)
      .map(({ entry, index }) => glossaryEntryHtml(entry, index))
      .join("")
  );
  if (glossarySearchMetaEl) glossarySearchMetaEl.textContent = glossaryVisibleCount + "/" + matchingEntries.length;
}
function replacementCandidatesForEntry(entry, index, targetOverride, extraCandidates) {
  const target = targetOverride ?? glossaryTarget(index);
  return uniqueGlossaryTerms([entry.source, entry.target, ...glossaryAliases(index), ...(extraCandidates || [])])
    .filter(term => term !== target)
    .sort((left, right) => right.length - left.length);
}
function glossaryReplacementItems() {
  return glossaryEntries.map((entry, index) => {
    const target = glossaryTarget(index);
    const candidates = replacementCandidatesForEntry(entry, index, target);
    return { entry, index, target, candidates, maxLength: candidates[0]?.length || 0 };
  }).filter(item => item.target && item.candidates.length > 0)
    .sort((left, right) => right.maxLength - left.maxLength);
}
function replaceByLongestGlossaryItems(text, items) {
  const candidates = items.flatMap(item => item.candidates.map(source => ({ source: String(source || "").trim(), target: item.target })))
    .filter(item => item.source && item.target && item.source !== item.target)
    .sort((left, right) => right.source.length - left.source.length);
  if (candidates.length === 0) return { text, count: 0 };
  let output = "";
  let index = 0;
  let count = 0;
  const value = String(text);
  while (index < value.length) {
    const match = candidates.find(candidate => value.startsWith(candidate.source, index));
    if (match) {
      output += match.target;
      index += match.source.length;
      count += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return { text: output, count };
}
function countLongestGlossaryMatches(text, items) {
  const candidates = items.flatMap(item => item.candidates.map(source => ({ source: String(source || "").trim(), key: item.key })))
    .filter(item => item.source)
    .sort((left, right) => right.source.length - left.source.length);
  const counts = {};
  const value = String(text || "");
  let index = 0;
  while (index < value.length) {
    const match = candidates.find(candidate => value.startsWith(candidate.source, index));
    if (match) {
      counts[match.key] = (counts[match.key] || 0) + 1;
      index += match.source.length;
      continue;
    }
    index += 1;
  }
  return counts;
}
function glossaryTermKey(term) {
  return String(term || "").trim().toLocaleLowerCase();
}
function auditGlossaryTermCountsLocal(sourceText, translationText) {
  const entries = currentGlossaryEntries().filter(entry => entry.source && entry.target && entry.source !== entry.target);
  const sourceCounts = countLongestGlossaryMatches(sourceText, entries.map((entry, index) => ({ key: index, candidates: [entry.source] })));
  const uniqueTargets = uniqueGlossaryTerms(entries.map(entry => entry.target));
  const targetCounts = countLongestGlossaryMatches(
    translationText,
    uniqueTargets.map(target => ({ key: glossaryTermKey(target), candidates: [target] }))
  );
  return entries.flatMap((entry, index) => {
    const sourceCount = sourceCounts[index] || 0;
    const targetCount = targetCounts[glossaryTermKey(entry.target)] || 0;
    if (sourceCount <= targetCount) return [];
    return [{
      code: "H3",
      severity: "H",
      source: entry.source,
      target: entry.target,
      sourceCount,
      targetCount,
      message: (data.labels.auditH3 || "H3 glossary term count mismatch") + ": " + entry.source + " → " + entry.target + " (" + sourceCount + "/" + targetCount + ")"
    }];
  });
}
function auditLineWhitelisted(line) {
  return Boolean(state.auditWhitelist?.[line]);
}
function firstAuditIssue(line) {
  if (auditLineWhitelisted(line)) return undefined;
  const issues = state.auditIssues?.[line];
  return Array.isArray(issues) ? issues[0] : undefined;
}
function recomputeAuditIssueForLine(line) {
  const row = data.rows.find(item => Number(item.line) === Number(line));
  if (!row || auditLineWhitelisted(line)) {
    delete state.auditIssues[line];
    return;
  }
  const existing = Array.isArray(state.auditIssues[line]) ? state.auditIssues[line].filter(issue => issue.code !== "H3") : [];
  const issues = auditGlossaryTermCountsLocal(row.source, rowValue(row));
  if (issues.length > 0) {
    state.auditIssues[line] = [...existing, ...issues];
  } else if (existing.length > 0) {
    state.auditIssues[line] = existing;
  } else {
    delete state.auditIssues[line];
  }
}
function toggleAuditWhitelistLine(line) {
  if (auditLineWhitelisted(line)) {
    delete state.auditWhitelist[line];
    recomputeAuditIssueForLine(line);
  } else {
    state.auditWhitelist[line] = true;
    delete state.auditIssues[line];
  }
  state.auditVisible = true;
  save();
  render();
  writeAuditWhitelistFile();
}
async function writeAuditWhitelistFile() {
  const bridge = writeBridge();
  if (!bridge?.writeAuditWhitelistFile) {
    setAiStatus((data.labels.auditWhitelistWritten || "Audit whitelist written") + ": " + auditWhitelistPathLabel() + " (" + auditWhitelistLines().join(", ") + ")");
    return;
  }
  try {
    const result = await bridge.writeAuditWhitelistFile({
      outputDir: workflow.paths?.outputDir,
      sourcePath: workflow.paths?.sourcePath,
      lines: auditWhitelistLines()
    });
    setAiStatus((data.labels.auditWhitelistWritten || "Audit whitelist written") + ": " + (result?.path || auditWhitelistPathLabel()));
  } catch (error) {
    setAiStatus((data.labels.auditWhitelistWriteFailed || "Audit whitelist write failed") + ": " + (error?.message || String(error)));
  }
}
function runGlossaryAudit() {
  state.auditIssues ||= {};
  let issueCount = 0;
  let affectedLines = 0;
  for (const row of data.rows) {
    const lineNo = row.line;
    const existing = Array.isArray(state.auditIssues[lineNo]) ? state.auditIssues[lineNo].filter(issue => issue.code !== "H3") : [];
    if (auditLineWhitelisted(lineNo)) {
      if (existing.length > 0) state.auditIssues[lineNo] = existing;
      else delete state.auditIssues[lineNo];
      continue;
    }
    const issues = auditGlossaryTermCountsLocal(row.source, rowValue(row));
    if (issues.length > 0) {
      state.auditIssues[lineNo] = [...existing, ...issues];
      issueCount += issues.length;
      affectedLines += 1;
    } else if (existing.length > 0) {
      state.auditIssues[lineNo] = existing;
    } else {
      delete state.auditIssues[lineNo];
    }
  }
  state.auditVisible = true;
  save();
  render();
  setAiStatus((data.labels.auditGlossaryFinished || "Term audit finished") + ": " + affectedLines + " lines / " + issueCount + " H3");
}
function applyGlossaryItems(scope, items) {
  let changedLines = 0;
  let replacementCount = 0;
  const rows = scope === "page" ? pageRows() : data.rows;
  for (const row of rows) {
    const lineNo = row.line;
    if (state.status[lineNo] === "manual") continue;
    let value = rowValue(row);
    const replaced = replaceByLongestGlossaryItems(value, items);
    value = replaced.text;
    const rowReplacementCount = replaced.count;
    if (rowReplacementCount > 0) {
      state.edits[lineNo] = value;
      state.status[lineNo] = "glossary";
      changedLines += 1;
      replacementCount += rowReplacementCount;
    }
  }
  save();
  render();
  setAiStatus((data.labels.glossaryApplied || "Glossary replacements applied") + ": " + changedLines + " lines / " + replacementCount + " replacements");
}
function applyGlossaryReplacements(scope) {
  if (glossaryEntries.length === 0) {
    setAiStatus(data.labels.glossaryEmpty || "No glossary loaded");
    return;
  }
  if (!confirm(data.labels.glossaryConfirm || "Apply glossary replacements? Manual rows will be skipped.")) {
    return;
  }
  applyGlossaryItems(scope, glossaryReplacementItems());
}
function applyEditedGlossaryTerm(input) {
  const index = Number(input.dataset.glossaryIndex);
  const entry = glossaryEntries[index];
  if (!entry) return;
  const previousTarget = input.dataset.currentTarget || glossaryTarget(index) || entry.target || "";
  const nextTarget = input.value.trim();
  if (!nextTarget) {
    input.value = previousTarget;
    return;
  }
  if (nextTarget === previousTarget) return;
  state.glossaryTargets[index] = nextTarget;
  state.glossaryAliases[index] = uniqueGlossaryTerms([...glossaryAliases(index), previousTarget, entry.target]).filter(term => term !== nextTarget);
  input.dataset.currentTarget = nextTarget;
  save();
  const fromText = previousTarget || entry.target || entry.source;
  const message = (data.labels.glossaryChangeConfirm || "Replace \"{from}\" with \"{to}\"? Manual rows will be skipped.")
    .replace("{from}", fromText)
    .replace("{to}", nextTarget);
  if (!confirm(message)) {
    setAiStatus(data.labels.glossaryChangeCancelled || "Glossary term updated without applying replacements.");
    return;
  }
  applyGlossaryItems("all", [{
    entry,
    index,
    target: nextTarget,
    candidates: replacementCandidatesForEntry(entry, index, nextTarget, [previousTarget, entry.target])
  }]);
}
function cleanGlossaryTerm(value) {
  return String(value ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}
function entryFromGlossaryObject(value) {
  const source = cleanGlossaryTerm(value.source ?? value.src ?? value.original ?? value.term ?? value.from ?? value.ja ?? value.jp ?? value.key);
  const target = cleanGlossaryTerm(value.target ?? value.dst ?? value.translation ?? value.translated ?? value.to ?? value.zh ?? value.cn ?? value.value);
  return source && target ? { source, target } : undefined;
}
function parseGlossaryTextLocal(text) {
  try {
    const parsed = JSON.parse(text);
    const entries = [];
    const arrayCandidate = Array.isArray(parsed) ? parsed : (parsed?.entries ?? parsed?.glossary ?? parsed?.terms);
    if (Array.isArray(arrayCandidate)) {
      for (const item of arrayCandidate) {
        if (Array.isArray(item)) {
          const source = cleanGlossaryTerm(item[0]);
          const target = cleanGlossaryTerm(item[1]);
          if (source && target) entries.push({ source, target });
        } else if (item && typeof item === "object") {
          const entry = entryFromGlossaryObject(item);
          if (entry) entries.push(entry);
        }
      }
      return entries;
    }
    if (parsed && typeof parsed === "object") {
      for (const [source, target] of Object.entries(parsed)) {
        if (typeof target === "string") {
          const entry = { source: cleanGlossaryTerm(source), target: cleanGlossaryTerm(target) };
          if (entry.source && entry.target) entries.push(entry);
        }
      }
      return entries;
    }
  } catch {
    // Fall back to line based glossary.
  }
  const separators = ["\t", "=>", "->", "=", ",", "\uff1a", ":"];
  const entries = [];
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    for (const separator of separators) {
      const index = trimmed.indexOf(separator);
      if (index <= 0) continue;
      const source = cleanGlossaryTerm(trimmed.slice(0, index));
      const target = cleanGlossaryTerm(trimmed.slice(index + separator.length));
      if (source && target) entries.push({ source, target });
      break;
    }
  }
  const seen = new Set();
  return entries.filter(entry => {
    const key = entry.source.toLocaleLowerCase();
    if (seen.has(key) || entry.source === entry.target) return false;
    seen.add(key);
    return true;
  });
}
function syncGlossaryFromText(text, label) {
  const parsed = parseGlossaryTextLocal(text);
  if (parsed.length === 0) {
    if (glossaryHelpEl) glossaryHelpEl.textContent = data.labels.glossaryEmpty || "No glossary loaded";
    setAiStatus((data.labels.glossaryNoEntries || "No glossary entries parsed") + ": " + label);
    return false;
  }
  glossaryEntries = parsed;
  state.glossaryTargets = {};
  state.glossaryAliases = {};
  save();
  renderGlossaryEntries();
  setAiStatus((data.labels.glossarySynced || "Glossary synced") + ": " + label + " (" + parsed.length + ")");
  return true;
}
async function syncGlossaryFromBoundFile() {
  const glossaryPath = boundGlossaryPath();
  const bridge = writeBridge();
  if (!glossaryPath) {
    setAiStatus(data.labels.glossarySyncMissingTarget || "This HTML has no bound glossary file. Import a glossary first.");
    return;
  }
  if (!bridge?.readTextFile) {
    setAiStatus((data.labels.glossaryWriteNeedsApp || "Open this HTML in translation-workshop to write glossary.") + ": " + glossaryPath);
    return;
  }
  try {
    const result = await bridge.readTextFile({ path: glossaryPath });
    const nextPath = result?.path || glossaryPath;
    if (syncGlossaryFromText(result?.text || "", nextPath)) {
      setBoundGlossaryPath(nextPath);
    }
  } catch (error) {
    setAiStatus((data.labels.glossaryReadFailed || "Glossary sync failed") + ": " + (error?.message || String(error)));
  }
}
async function importGlossaryFromFile() {
  const bridge = writeBridge();
  if (!bridge?.openFile || !bridge?.readTextFile) {
    document.getElementById("syncGlossaryInput")?.click();
    return;
  }
  const filePath = await bridge.openFile(glossaryFileFilters);
  if (!filePath) return;
  try {
    const result = await bridge.readTextFile({ path: filePath });
    const nextPath = result?.path || filePath;
    if (syncGlossaryFromText(result?.text || "", nextPath)) {
      setBoundGlossaryPath(nextPath);
    }
  } catch (error) {
    setAiStatus((data.labels.glossaryReadFailed || "Glossary sync failed") + ": " + (error?.message || String(error)));
  }
}
function glossaryFileText() {
  const entries = currentGlossaryEntries();
  const glossaryPath = boundGlossaryPath();
  if (/\.json$/i.test(glossaryPath)) {
    return JSON.stringify(entries, null, 2);
  }
  return entries.map(entry => entry.source + "\t" + entry.target).join("\n");
}
function suggestedGlossaryName() {
  const raw = boundGlossaryPath() || "translation-workshop-glossary.tsv";
  const name = raw.split(/[\\/]/).pop() || "translation-workshop-glossary.tsv";
  return /\.[a-z0-9]+$/i.test(name) ? name : name + ".tsv";
}
function downloadGlossary() {
  const blob = new Blob([glossaryFileText()], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedGlossaryName();
  a.click();
  URL.revokeObjectURL(a.href);
}
async function writeCurrentGlossaryFile() {
  const glossaryPath = boundGlossaryPath();
  if (!glossaryPath) {
    setAiStatus(data.labels.glossaryWriteMissingTarget || "No glossary file is bound to this HTML.");
    return;
  }
  const bridge = writeBridge();
  if (!bridge?.writeGlossaryFile) {
    setAiStatus((data.labels.glossaryWriteNeedsApp || "Open this HTML in translation-workshop to write glossary.") + ": " + glossaryPath);
    return;
  }
  try {
    const result = await bridge.writeGlossaryFile({ path: glossaryPath, text: glossaryFileText(), outputDir: workflow.paths?.outputDir });
    setBoundGlossaryPath(result?.path || glossaryPath);
    setAiStatus((data.labels.glossaryWritten || "Glossary written") + ": " + (result?.path || glossaryPath));
  } catch (error) {
    setAiStatus((data.labels.glossaryWriteFailed || "Glossary write failed") + ": " + (error?.message || String(error)));
  }
}
let pendingGlossaryFocusIndex = null;
function restorePendingGlossaryFocus(index, changedIndex) {
  if (!Number.isInteger(index) || index === changedIndex) return;
  const nextInput = glossaryListEl?.querySelector('.glossary-target[data-glossary-index="' + index + '"]');
  nextInput?.focus();
}
glossaryListEl?.addEventListener("pointerdown", (event) => {
  const input = event.target.closest?.(".glossary-target");
  pendingGlossaryFocusIndex = input ? Number(input.dataset.glossaryIndex) : null;
}, true);
glossaryListEl?.addEventListener("change", (event) => {
  const input = event.target.closest?.(".glossary-target");
  if (!input) return;
  const nextFocusIndex = pendingGlossaryFocusIndex;
  pendingGlossaryFocusIndex = null;
  setTimeout(() => {
    const changedIndex = Number(input.dataset.glossaryIndex);
    applyEditedGlossaryTerm(input);
    restorePendingGlossaryFocus(nextFocusIndex, changedIndex);
  }, 0);
});
glossaryListEl?.addEventListener("keydown", (event) => {
  const input = event.target.closest?.(".glossary-target");
  if (!input || event.key !== "Enter") return;
  event.preventDefault();
  input.blur();
});
glossarySearchEl?.addEventListener("input", () => {
  glossaryVisibleCount = glossaryRenderBatchSize;
  renderGlossaryEntries();
});
glossaryListEl?.addEventListener("scroll", () => {
  if (!glossaryListEl || glossaryListEl.scrollTop + glossaryListEl.clientHeight < glossaryListEl.scrollHeight - 80) return;
  loadMoreGlossaryEntries();
});
renderGlossaryEntries();
document.getElementById("applyGlossaryCurrent")?.addEventListener("click", () => applyGlossaryReplacements("page"));
document.getElementById("applyGlossaryAll")?.addEventListener("click", () => applyGlossaryReplacements("all"));
document.getElementById("importGlossary")?.addEventListener("click", () => {
  void importGlossaryFromFile();
});
document.getElementById("syncGlossary")?.addEventListener("click", syncGlossaryFromBoundFile);
document.getElementById("exportGlossary")?.addEventListener("click", downloadGlossary);
document.getElementById("writeGlossary")?.addEventListener("click", writeCurrentGlossaryFile);
document.getElementById("toggleAuditMarkers")?.addEventListener("click", () => {
  state.auditVisible = !state.auditVisible;
  save();
  render();
});
document.getElementById("runGlossaryAudit")?.addEventListener("click", runGlossaryAudit);
document.getElementById("syncGlossaryInput")?.addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const ok = syncGlossaryFromText(await file.text(), file.path || file.name);
    if (ok && file.path) setBoundGlossaryPath(file.path);
  } finally {
    input.value = "";
  }
});
const themePalettes = {
  sakura: { "--surface-a": "#fff1f8", "--surface-b": "#fff9fd", "--surface-c": "#f9eaff", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fffaf6", "--target-bg": "#fff7fb", "--sakura": "#ff9ecb", "--sky": "#77c8ff", "--mint": "#8ee7d4", "--lemon": "#ffe58a", "--night": "#2f3a8f" },
  sky: { "--surface-a": "#eef8ff", "--surface-b": "#f8fcff", "--surface-c": "#e2f4ff", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fbfdff", "--target-bg": "#f7fbff", "--sakura": "#9ad7ff", "--sky": "#72d3ff", "--mint": "#b5ecff", "--lemon": "#eaf7ff", "--night": "#2d5d9f" },
  mint: { "--surface-a": "#effdf8", "--surface-b": "#fbfffd", "--surface-c": "#e8f8ef", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fbfffc", "--target-bg": "#f4fffb", "--sakura": "#9df0c9", "--sky": "#9ad7ff", "--mint": "#8ee7d4", "--lemon": "#dff6a9", "--night": "#24706d" },
  lemon: { "--surface-a": "#fff8e8", "--surface-b": "#fffdf5", "--surface-c": "#fff0d6", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fffdf8", "--target-bg": "#fffaf0", "--sakura": "#ffbb88", "--sky": "#9ad7ff", "--mint": "#bdeccf", "--lemon": "#ffe58a", "--night": "#8a6b1e" }
};
function applyTheme(theme) {
  Object.entries(theme).forEach(([name, value]) => document.documentElement.style.setProperty(name, value));
  state.theme = theme;
  save();
}
applyTheme(state.theme && Object.keys(state.theme).length > 0 ? state.theme : themePalettes.sky);
document.querySelectorAll("[data-theme-color]").forEach((button) => {
  button.addEventListener("click", () => applyTheme(themePalettes[button.dataset.themeColor] || themePalettes.sky));
});
document.getElementById("customThemeColor")?.addEventListener("input", (event) => {
  applyTheme({ ...(state.theme || themePalettes.sky), "--sakura": event.target.value, "--surface-a": event.target.value + "22" });
});
addEventListener("beforeunload", save);
render();
restoreSyncedText();
requestAnimationFrame(() => {
  const line = lineFromLocationHash();
  if (line) jumpToLine(line);
  else if (activeLine) jumpToLine(activeLine);
  else scrollTo(0, state.scrollY || 0);
  requestAnimationFrame(() => {
    restoringPosition = false;
    save();
  });
});
`;
}

export function renderProposalReviewHtml(options: ProposalReviewHtmlOptions): string {
  const locale = options.locale ?? "zh-CN";
  const t = { ...labels[locale], ...workflowLabels[locale] } as Record<string, string>;
  const firstPage = paginateRows(options.proposals, options.pageSize ?? 1000, options.startPage ?? 1);
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>${animeThemeCss("proposal")}</style>
</head>
<body class="anime-workbench proposal-review">
  <div class="app">
    <aside>
      <h1>${t.reviewTitle}</h1>
      <p class="subtle">${escapeHtml(options.title)}</p>
      ${themeControlsHtml(t)}
      <label>${t.search}</label><input id="search" type="search">
      <label>${t.issueFilter}</label><select id="issueFilter"></select>
      <label>${t.page}</label><input id="pageInput" type="number" min="1" value="${firstPage.page}">
      <div class="toolbar">
        <button class="btn" id="prev">${t.previous}</button>
        <button class="btn" id="jump">${t.jump}</button>
        <button class="btn" id="next">${t.next}</button>
      </div>
      <p class="subtle"><span id="pageInfo"></span></p>
      <p class="subtle">${t.total}: <strong>${options.proposals.length}</strong></p>
      <div class="toolbar">
        <button class="btn" id="connectLineReview">${t.connectLineReview}</button>
        <button class="btn primary" id="applyProposalChanges">${t.applyProposalChanges}</button>
      </div>
      <div class="toolbar">
        <label>${t.lanSyncPin ?? "6-digit PIN"}<input id="lanSyncPin" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="\\d{6}" placeholder="000000"></label>
        <button class="btn" id="startLanSync">${t.lanSync ?? "LAN sync"}</button>
      </div>
      <div id="lanSyncPanel" class="lan-sync-panel" hidden>
        <div><strong>${t.lanSync ?? "LAN sync"}</strong></div>
        <p>${t.lanSyncPinHelp ?? "Phones and other devices must enter this PIN after opening the link."}</p>
        <div id="lanSyncLinks" class="lan-sync-links"></div>
        <div class="lan-sync-actions">
          <button class="btn" id="copyLanSyncLink" type="button">${t.lanSyncCopy ?? "Copy link"}</button>
          <button class="btn" id="stopLanSync" type="button">${t.lanSyncStop ?? "Stop sync"}</button>
        </div>
        <p>${t.lanSyncExternal ?? "External tunnel"}: ${t.lanSyncExternalNote ?? "translation-workshop does not bundle public tunneling tools. If you use Cloudflare Tunnel, ngrok, or similar tools, point them to the local sync address."}</p>
      </div>
      <p class="subtle" id="proposalStatus"></p>
      <button class="btn primary" id="export">${t.exportJson}</button>
    </aside>
    <main><section id="cards" class="cards"></section></main>
  </div>
  <script id="proposalData" type="application/json">${jsonScript({ proposals: options.proposals, pageSize: firstPage.pageSize, startPage: firstPage.page, labels: t, outputDir: options.outputDir ?? "", reportPath: options.reportPath ?? "", lineReviewPath: options.lineReviewPath ?? "" })}</script>
  <script>${proposalReviewScript()}</script>
</body>
</html>`;
}

function proposalReviewScript(): string {
  return String.raw`
const data = JSON.parse(document.getElementById("proposalData").textContent);
const key = "translation-workshop:proposal:" + location.pathname;
const state = JSON.parse(localStorage.getItem(key) || "{}");
state.decisions ||= {};
state.theme ||= {};
let page = state.page || data.startPage || 1;
const pageSize = data.pageSize || 1000;
const cards = document.getElementById("cards");
const pageInput = document.getElementById("pageInput");
const pageInfo = document.getElementById("pageInfo");
const proposalStatus = document.getElementById("proposalStatus");
const searchInput = document.getElementById("search");
const issueFilter = document.getElementById("issueFilter");
const startLanSyncButton = document.getElementById("startLanSync");
const lanSyncPinInput = document.getElementById("lanSyncPin");
const lanSyncPanel = document.getElementById("lanSyncPanel");
const lanSyncLinks = document.getElementById("lanSyncLinks");
const copyLanSyncLinkButton = document.getElementById("copyLanSyncLink");
const stopLanSyncButton = document.getElementById("stopLanSync");
let lanSyncToken = "";
let lanSyncPrimaryUrl = "";
const lanSyncTimers = new Map();
function escapeHtml(text) { return String(text ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function save() {
  state.page = page;
  state.scrollY = scrollY;
  state.issueFilter = activeIssueFilter();
  localStorage.setItem(key, JSON.stringify(state));
}
function setProposalStatus(text) { if (proposalStatus) proposalStatus.textContent = text; }
function proposalCode(item) {
  const text = [item.id, item.problemType].filter(Boolean).join(" ");
  const exact = text.match(/\b([HML])[-\s]?(\d{1,4})\b/i);
  if (exact) return exact[1].toUpperCase() + exact[2];
  const severity = text.match(/\b([HML])\b/i);
  return severity ? severity[1].toUpperCase() : "M";
}
function proposalSeverity(item) {
  const code = proposalCode(item).charAt(0).toUpperCase();
  return ["H", "M", "L"].includes(code) ? code : "M";
}
function issueTypeOptions() {
  const exactCodes = [...new Set(data.proposals.map(proposalCode))].sort((left, right) => {
    const order = { H: 0, M: 1, L: 2 };
    const leftPrefix = left.charAt(0);
    const rightPrefix = right.charAt(0);
    const prefixDiff = (order[leftPrefix] ?? 9) - (order[rightPrefix] ?? 9);
    if (prefixDiff !== 0) return prefixDiff;
    return Number(left.slice(1) || 0) - Number(right.slice(1) || 0) || left.localeCompare(right);
  });
  const severities = ["H", "M", "L"].filter(prefix => exactCodes.some(code => code.startsWith(prefix)));
  return [...new Set(["", ...severities, ...exactCodes])];
}
function renderIssueFilterOptions() {
  if (!issueFilter) return;
  const selected = state.issueFilter || "";
  issueFilter.innerHTML = issueTypeOptions().map(value => {
    const label = value || (data.labels.allIssueTypes || "All issue types");
    return '<option value="' + escapeHtml(value) + '"' + (value === selected ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
  }).join("");
  if (![...issueFilter.options].some(option => option.value === selected)) {
    issueFilter.value = "";
    state.issueFilter = "";
  }
}
function activeIssueFilter() {
  return String(issueFilter?.value || state.issueFilter || "").trim().toUpperCase();
}
function proposalSearchText(item) {
  return JSON.stringify(item).toLowerCase();
}
function filteredItems() {
  const q = String(searchInput?.value || "").trim().toLowerCase();
  const type = activeIssueFilter();
  return data.proposals.filter(item => {
    const code = proposalCode(item);
    const severity = proposalSeverity(item);
    const typeMatches = !type || code === type || severity === type;
    const searchMatches = !q || proposalSearchText(item).includes(q);
    return typeMatches && searchMatches;
  });
}
function pageItems(items) { return items.slice((page - 1) * pageSize, page * pageSize); }
function render() {
  const visibleItems = filteredItems();
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  page = Math.min(Math.max(1, page), totalPages);
  pageInput.value = page;
  pageInfo.textContent = data.labels.page + " " + page + " / " + totalPages + " · " + data.labels.total + ": " + visibleItems.length + " / " + data.proposals.length;
  const visiblePageItems = pageItems(visibleItems);
  if (visiblePageItems.length === 0) {
    cards.innerHTML = '<p class="subtle">' + escapeHtml(data.labels.searchNoMatches || "No matches") + '</p>';
    save();
    return;
  }
  cards.innerHTML = visiblePageItems.map(item => {
    const decision = effectiveProposalDecision(item);
    const lineLabel = item.line ? (data.labels.lineNumber || "Line") + " " + item.line : (data.labels.lineNumber || "Line") + " ?";
    return '<article class="card" data-id="' + escapeHtml(item.id) + '" data-line="' + escapeHtml(item.line || "") + '">' +
      '<div class="card-head"><strong>' + escapeHtml(item.id) + '</strong><span class="chip line-chip">' + escapeHtml(lineLabel) + '</span><span class="chip status-chip">' + escapeHtml(decision.status || "unreviewed") + '</span></div>' +
      '<div class="card-body">' +
      field(data.labels.source, item.src) + field(data.labels.current, item.current) + field(data.labels.problemType, item.problemType) + field(data.labels.problem, item.problem) + field(data.labels.suggestion, item.suggestion, "suggestion") +
      '<textarea placeholder="' + data.labels.manual + '">' + escapeHtml(decision.manualText || "") + '</textarea>' +
      '<div class="toolbar"><button class="btn accept ' + (decision.status === "accepted" ? "active" : "") + '" data-action="accepted">' + data.labels.accept + '</button>' +
      '<button class="btn reject ' + (decision.status === "rejected" ? "active" : "") + '" data-action="rejected">' + data.labels.reject + '</button>' +
      '<button class="btn manual ' + (decision.status === "manual" ? "active" : "") + '" data-action="manual">' + data.labels.manual + '</button>' +
      '<button class="btn jump-line" id="jumpLine-' + escapeHtml(domId(item.id)) + '" data-jump-line="' + escapeHtml(item.line || "") + '">' + (data.labels.jumpLine || "Jump to line") + '</button></div>' +
      '</div></article>';
  }).join("");
  save();
}
function field(label, value, cls = "") { return '<div class="field ' + cls + '"><b>' + label + '</b><div class="text">' + escapeHtml(value) + '</div></div>'; }
function domId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-");
}
function reviewSourceKey() {
  return "proposal-review:" + (data.reportPath || location.pathname);
}
function lineReviewPathname() {
  const raw = String(data.lineReviewPath || "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    try { return new URL(raw).pathname; } catch { return ""; }
  }
  const normalized = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return "/" + normalized;
  return normalized.startsWith("/") ? normalized : "/" + normalized;
}
function lineReviewStorageKey() {
  const pathname = lineReviewPathname();
  return pathname ? "translation-workshop:line:" + pathname : "";
}
function lineReviewTargetForLine(line) {
  const raw = String(data.lineReviewPath || "").trim();
  if (!raw) return "";
  const numericLine = Number(line || 0);
  if (!Number.isInteger(numericLine) || numericLine <= 0) return raw;
  const hash = "line=" + numericLine;
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      url.hash = hash;
      return url.href;
    } catch {
      return raw.replace(/#.*$/, "") + "#line=" + numericLine;
    }
  }
  return raw.replace(/#.*$/, "") + "#line=" + numericLine;
}
function lineReviewFileUrl(line) {
  const target = lineReviewTargetForLine(line);
  if (!target || /^file:/i.test(target)) return target;
  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const normalized = pathPart.replace(/\\/g, "/");
  return "file:///" + normalized.replace(/^\/+/, "") + hash;
}
function lineReviewFilePath() {
  const raw = String(data.lineReviewPath || "").trim().replace(/#.*$/, "");
  if (!raw) return "";
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      const pathname = decodeURIComponent(url.pathname || "");
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return "";
    }
  }
  return raw;
}
function currentProposalHtmlPath() {
  if (location.protocol !== "file:") {
    return location.href;
  }
  return decodeURIComponent(location.pathname)
    .replace(/^\/([A-Za-z]:[\\/])/, "$1")
    .replace(/\//g, "\\");
}
let linkedLineReviewRowsPromise = null;
function parseLineReviewRowsFromHtml(html) {
  const match = String(html || "").match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}
async function readLinkedLineReviewRows() {
  if (linkedLineReviewRowsPromise) return linkedLineReviewRowsPromise;
  linkedLineReviewRowsPromise = (async () => {
    const bridge = htmlBridge();
    const targetPath = lineReviewFilePath();
    if (!targetPath || !bridge?.readTextFile) return [];
    try {
      const result = await bridge.readTextFile({ path: targetPath });
      return parseLineReviewRowsFromHtml(result?.text || "");
    } catch {
      return [];
    }
  })();
  return linkedLineReviewRowsPromise;
}
function comparableText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}
function textSimilarity(left, right) {
  const a = comparableText(left);
  const b = comparableText(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
function lineReviewRowFor(rows, line) {
  const numericLine = Number(line || 0);
  if (!Number.isInteger(numericLine) || numericLine <= 0) return undefined;
  return rows.find(row => Number(row.line) === numericLine) || rows[numericLine - 1];
}
function proposalSafetyCheck(item, lineState, rows) {
  const line = Number(item.line);
  const row = lineReviewRowFor(rows, line);
  if (!row) return { ok: false, reason: "missing-line" };
  const sourceScore = item.src ? textSimilarity(item.src, row.source) : 1;
  if (sourceScore < 0.8) return { ok: false, reason: "source-mismatch" };
  return { ok: true, reason: "" };
}
function readLineReviewState() {
  const storageKey = lineReviewStorageKey();
  if (!storageKey) {
    setProposalStatus(data.labels.lineReviewMissing || "No linked line review HTML");
    return undefined;
  }
  let lineState = {};
  try {
    lineState = JSON.parse(localStorage.getItem(storageKey) || "{}") || {};
  } catch {
    lineState = {};
  }
  lineState.edits ||= {};
  lineState.status ||= {};
  lineState.auditIssues ||= {};
  return { storageKey, lineState };
}
function htmlBridge() {
  return window.workshopHtml || window.parent?.workshopHtml || window.workshop;
}
function lanSyncLineRowsPayload(rows) {
  return rows.map(row => ({
    line: row.line,
    source: row.source,
    translation: row.translation,
    status: row.status || ""
  }));
}
function renderLanSyncLinks(result) {
  if (!lanSyncPanel || !lanSyncLinks) return;
  const lanUrls = Array.isArray(result?.lanUrls) ? result.lanUrls : [];
  lanSyncPrimaryUrl = lanUrls[0] || result?.localUrl || "";
  const rows = [];
  if (lanUrls[0]) {
    rows.push('<div><b>' + escapeHtml(data.labels.lanSyncLanUrl || "LAN address") + ':</b> <a href="' + escapeHtml(lanUrls[0]) + '">' + escapeHtml(lanUrls[0]) + '</a></div>');
  }
  if (result?.localUrl) {
    rows.push('<div><b>' + escapeHtml(data.labels.lanSyncLocalUrl || "Local address") + ':</b> <a href="' + escapeHtml(result.localUrl) + '">' + escapeHtml(result.localUrl) + '</a></div>');
  }
  lanSyncLinks.innerHTML = rows.join("");
  lanSyncPanel.hidden = false;
}
async function startLanSync() {
  const bridge = htmlBridge();
  if (!bridge?.startLanSync) {
    setProposalStatus(data.labels.lanSyncNeedsApp || "LAN sync requires opening this HTML inside translation-workshop.");
    return;
  }
  const pin = String(lanSyncPinInput?.value || "").trim();
  if (!/^\d{6}$/.test(pin)) {
    setProposalStatus(data.labels.lanSyncPinInvalid || "Enter a 6-digit numeric PIN.");
    lanSyncPinInput?.focus?.();
    return;
  }
  const linkedRows = await readLinkedLineReviewRows();
  const linkedState = readLineReviewState()?.lineState || {};
  try {
    const result = await bridge.startLanSync({
      pin,
      htmlPath: currentProposalHtmlPath(),
      outputDir: data.outputDir || "",
      agent: "codex",
      title: document.title || "translation-workshop",
      locale: document.documentElement.lang === "en-US" ? "en-US" : "zh-CN",
      pageSize,
      lineReviewPath: data.lineReviewPath,
      lineDocument: linkedRows.length > 0 ? {
        title: data.lineReviewPath || (data.labels.lineReviewLinked || "Line review"),
        rows: lanSyncLineRowsPayload(linkedRows),
        state: linkedState,
        pageSize,
        lineReviewPath: data.lineReviewPath
      } : undefined,
      proposalDocument: {
        title: document.title || "translation-workshop",
        proposals: data.proposals,
        state,
        pageSize,
        reportPath: data.reportPath,
        lineReviewPath: data.lineReviewPath
      }
    });
    lanSyncToken = result?.token || "";
    renderLanSyncLinks(result);
    setProposalStatus((data.labels.lanSyncStarted || "LAN sync started") + ": " + (lanSyncPrimaryUrl || result?.localUrl || ""));
  } catch (error) {
    setProposalStatus((data.labels.lanSyncFailed || "LAN sync failed") + ": " + (error?.message || String(error)));
  }
}
function queueLanSyncPatch(patch) {
  if (!lanSyncToken) return;
  const bridge = htmlBridge();
  if (!bridge?.sendLanSyncPatch) return;
  const key = patch.type === "proposal-decision" ? "proposal:" + patch.proposalId : "line:" + patch.line;
  clearTimeout(lanSyncTimers.get(key));
  lanSyncTimers.set(key, setTimeout(() => {
    bridge.sendLanSyncPatch({
      token: lanSyncToken,
      patch: { ...patch, clientId: "desktop", timestamp: new Date().toISOString() }
    }).catch(() => {});
  }, patch.type === "proposal-decision" ? 200 : 0));
}
function applyRemoteLanSyncPatch(payload) {
  if (!payload || payload.token !== lanSyncToken) return;
  const patch = payload.patch || {};
  if (patch.clientId === "desktop") return;
  if (patch.type === "proposal-decision") {
    const proposalId = String(patch.proposalId || "");
    if (!proposalId) return;
    state.decisions[proposalId] = { status: patch.status || "manual", manualText: patch.manualText || "" };
    save();
    render();
  }
}
async function persistLineReviewState(target, line) {
  localStorage.setItem(target.storageKey, JSON.stringify(target.lineState));
  const bridge = htmlBridge();
  if (!bridge?.applyLineReviewState || !data.lineReviewPath) {
    return false;
  }
  try {
    await bridge.applyLineReviewState({
      lineReviewPath: data.lineReviewPath,
      lineState: target.lineState,
      line
    });
    return true;
  } catch (error) {
    setProposalStatus((data.labels.proposalOpenFailed || "Failed to open line HTML") + ": " + (error?.message || String(error)));
    return false;
  }
}
function proposalById(id) {
  return data.proposals.find(item => item.id === id);
}
function proposalSuggestionText(item) {
  return String(item?.suggestion || "").trim();
}
function rawDecisionFor(item) {
  return state.decisions[item.id] || { status: item.status || "unreviewed", manualText: "" };
}
function effectiveProposalDecision(item, rawDecision) {
  const decision = rawDecision || rawDecisionFor(item);
  const manualText = String(decision.manualText || "").trim();
  if (manualText) return { ...decision, status: "manual" };
  if (decision.status === "rejected") return { ...decision, status: "rejected", manualText: "" };
  if (!proposalSuggestionText(item)) return { ...decision, status: "unreviewed", manualText: "" };
  return { ...decision, status: "accepted", manualText: "" };
}
function decisionFor(item) {
  return effectiveProposalDecision(item);
}
function applyDecisionVisual(card, decision) {
  const chip = card.querySelector(".status-chip");
  if (chip) chip.textContent = decision.status || "unreviewed";
  card.querySelectorAll("button[data-action]").forEach(button => {
    button.classList.toggle("active", button.dataset.action === decision.status);
  });
}
function issueFromProposal(item) {
  return {
    code: proposalCode(item),
    severity: proposalSeverity(item),
    message: item.problem || item.problemType || item.id,
    suggestion: item.suggestion || "",
    proposalId: item.id,
    source: reviewSourceKey()
  };
}
function removeReviewIssues(lineState, line, proposalId) {
  const issues = Array.isArray(lineState.auditIssues[line]) ? lineState.auditIssues[line] : [];
  const source = reviewSourceKey();
  const next = issues.filter(issue => issue.source !== source && issue.proposalId !== proposalId);
  if (next.length > 0) lineState.auditIssues[line] = next;
  else delete lineState.auditIssues[line];
}
function clearReviewIssues(lineState) {
  const source = reviewSourceKey();
  Object.keys(lineState.auditIssues || {}).forEach(line => {
    const issues = Array.isArray(lineState.auditIssues[line]) ? lineState.auditIssues[line] : [];
    const next = issues.filter(issue => issue.source !== source);
    if (next.length > 0) lineState.auditIssues[line] = next;
    else delete lineState.auditIssues[line];
  });
}
function markProposalIssue(lineState, item) {
  const line = Number(item.line);
  if (!Number.isInteger(line) || line <= 0) return false;
  const issue = issueFromProposal(item);
  const existing = Array.isArray(lineState.auditIssues[line]) ? lineState.auditIssues[line] : [];
  lineState.auditIssues[line] = existing.filter(entry => entry.source !== issue.source || entry.proposalId !== issue.proposalId);
  lineState.auditIssues[line].push(issue);
  return true;
}
async function openLinkedLineReview(line) {
  if (!data.lineReviewPath) {
    setProposalStatus(data.labels.lineReviewMissing || "No linked line review HTML");
    return;
  }
  const bridge = htmlBridge();
  const target = line ? lineReviewTargetForLine(line) : data.lineReviewPath;
  try {
    if (bridge?.openPath) {
      await bridge.openPath(target);
    } else {
      window.open(lineReviewFileUrl(line), "_blank");
    }
  } catch (error) {
    setProposalStatus((data.labels.proposalOpenFailed || "Failed to open line HTML") + ": " + (error?.message || String(error)));
  }
}
async function jumpToLineReviewLine(item) {
  const target = readLineReviewState();
  let persisted = false;
  if (target) {
    target.lineState.auditVisible = true;
    markProposalIssue(target.lineState, item);
    persisted = await persistLineReviewState(target, item.line);
  }
  if (!persisted) {
    await openLinkedLineReview(item.line);
  }
}
async function connectLineReview() {
  const target = readLineReviewState();
  if (!target) return;
  clearReviewIssues(target.lineState);
  target.lineState.auditVisible = true;
  let marked = 0;
  for (const item of data.proposals) {
    const line = Number(item.line);
    const decision = decisionFor(item);
    if (!Number.isInteger(line) || line <= 0 || decision.status === "rejected") continue;
    if (markProposalIssue(target.lineState, item)) marked += 1;
  }
  const persisted = await persistLineReviewState(target);
  setProposalStatus((data.labels.lineReviewLinked || "Line review HTML marked") + ": " + marked);
  if (!persisted) {
    await openLinkedLineReview();
  }
}
function proposalReplacementText(item, decision) {
  if (decision.status === "rejected") return "";
  if (decision.status === "manual") return String(decision.manualText || "").trim();
  if (decision.status === "accepted") return proposalSuggestionText(item);
  return "";
}
async function applyProposalChanges() {
  const target = readLineReviewState();
  if (!target) return;
  const lineRows = await readLinkedLineReviewRows();
  target.lineState.auditVisible = true;
  let applied = 0;
  let skipped = 0;
  let safetySkipped = 0;
  let firstAppliedLine = 0;
  for (const item of data.proposals) {
    const line = Number(item.line);
    const decision = decisionFor(item);
    const text = proposalReplacementText(item, decision);
    if (!Number.isInteger(line) || line <= 0 || !text) {
      skipped += 1;
      continue;
    }
    const safety = proposalSafetyCheck(item, target.lineState, lineRows);
    if (!safety.ok) {
      skipped += 1;
      safetySkipped += 1;
      continue;
    }
    target.lineState.edits[line] = text;
    target.lineState.status[line] = "manual";
    removeReviewIssues(target.lineState, line, item.id);
    if (decision.status !== "manual") {
      state.decisions[item.id] = { ...decision, status: "accepted", manualText: decision.manualText || "" };
    }
    if (!firstAppliedLine) firstAppliedLine = line;
    applied += 1;
  }
  const persisted = await persistLineReviewState(target, firstAppliedLine || undefined);
  save();
  render();
  const safetyNote = safetySkipped > 0 ? " / " + (data.labels.proposalSafetySkipped || "failed safety check") + ": " + safetySkipped : "";
  setProposalStatus((data.labels.proposalChangesApplied || "Proposals applied") + ": " + applied + " / " + (data.labels.proposalApplySkipped || "skipped") + ": " + skipped + safetyNote);
  if (!persisted) {
    await openLinkedLineReview(firstAppliedLine);
  }
}
cards.addEventListener("click", event => {
  const jumpButton = event.target.closest("button[data-jump-line]");
  if (jumpButton) {
    const item = proposalById(jumpButton.closest(".card")?.dataset.id);
    if (item) void jumpToLineReviewLine(item);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".card");
  const id = card.dataset.id;
  const item = proposalById(id);
  if (!item) return;
  const rawDecision = { status: button.dataset.action, manualText: card.querySelector("textarea").value };
  state.decisions[id] = rawDecision;
  const decision = effectiveProposalDecision(item, rawDecision);
  applyDecisionVisual(card, decision);
  save();
  queueLanSyncPatch({ type: "proposal-decision", proposalId: id, status: decision.status, manualText: decision.manualText || rawDecision.manualText || "" });
});
cards.addEventListener("input", event => {
  if (event.target.tagName !== "TEXTAREA") return;
  const card = event.target.closest(".card");
  const item = proposalById(card.dataset.id);
  if (!item) return;
  const rawDecision = { status: "manual", manualText: event.target.value };
  state.decisions[card.dataset.id] = rawDecision;
  const decision = effectiveProposalDecision(item, rawDecision);
  applyDecisionVisual(card, decision);
  save();
  queueLanSyncPatch({ type: "proposal-decision", proposalId: card.dataset.id, status: decision.status, manualText: event.target.value });
});
document.getElementById("prev").onclick = () => { page -= 1; render(); scrollTo(0, 0); };
document.getElementById("next").onclick = () => { page += 1; render(); scrollTo(0, 0); };
document.getElementById("jump").onclick = () => { page = Number(pageInput.value || 1); render(); scrollTo(0, 0); };
searchInput.oninput = () => { page = 1; render(); scrollTo(0, 0); };
issueFilter.onchange = () => { page = 1; state.issueFilter = activeIssueFilter(); render(); scrollTo(0, 0); };
document.getElementById("connectLineReview")?.addEventListener("click", connectLineReview);
document.getElementById("applyProposalChanges")?.addEventListener("click", applyProposalChanges);
htmlBridge()?.onLanSyncPatch?.(applyRemoteLanSyncPatch);
startLanSyncButton?.addEventListener("click", () => { void startLanSync(); });
copyLanSyncLinkButton?.addEventListener("click", () => {
  if (!lanSyncPrimaryUrl) return;
  navigator.clipboard?.writeText(lanSyncPrimaryUrl).then(() => setProposalStatus(data.labels.copied || "Copied")).catch(() => {});
});
stopLanSyncButton?.addEventListener("click", () => {
  const token = lanSyncToken;
  lanSyncToken = "";
  if (lanSyncPanel) lanSyncPanel.hidden = true;
  if (token) htmlBridge()?.stopLanSync?.(token).catch(() => {});
  setProposalStatus(data.labels.lanSyncStopped || "LAN sync stopped");
});
document.getElementById("export").onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "proposal-review-state.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
const themePalettes = {
  sakura: { "--surface-a": "#fff1f8", "--surface-b": "#fff9fd", "--surface-c": "#f9eaff", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fffaf6", "--target-bg": "#fff7fb", "--sakura": "#ff9ecb", "--sky": "#77c8ff", "--mint": "#8ee7d4", "--lemon": "#ffe58a", "--night": "#2f3a8f" },
  sky: { "--surface-a": "#eef8ff", "--surface-b": "#f8fcff", "--surface-c": "#e2f4ff", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fbfdff", "--target-bg": "#f7fbff", "--sakura": "#9ad7ff", "--sky": "#72d3ff", "--mint": "#b5ecff", "--lemon": "#eaf7ff", "--night": "#2d5d9f" },
  mint: { "--surface-a": "#effdf8", "--surface-b": "#fbfffd", "--surface-c": "#e8f8ef", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fbfffc", "--target-bg": "#f4fffb", "--sakura": "#9df0c9", "--sky": "#9ad7ff", "--mint": "#8ee7d4", "--lemon": "#dff6a9", "--night": "#24706d" },
  lemon: { "--surface-a": "#fff8e8", "--surface-b": "#fffdf5", "--surface-c": "#fff0d6", "--panel-bg": "rgba(255,255,255,.9)", "--source-bg": "#fffdf8", "--target-bg": "#fffaf0", "--sakura": "#ffbb88", "--sky": "#9ad7ff", "--mint": "#bdeccf", "--lemon": "#ffe58a", "--night": "#8a6b1e" }
};
function applyTheme(theme) {
  Object.entries(theme).forEach(([name, value]) => document.documentElement.style.setProperty(name, value));
  state.theme = theme;
  save();
}
applyTheme(state.theme && Object.keys(state.theme).length > 0 ? state.theme : themePalettes.sky);
document.querySelectorAll("[data-theme-color]").forEach((button) => {
  button.addEventListener("click", () => applyTheme(themePalettes[button.dataset.themeColor] || themePalettes.sky));
});
document.getElementById("customThemeColor")?.addEventListener("input", (event) => {
  applyTheme({ ...(state.theme || themePalettes.sky), "--sakura": event.target.value, "--surface-a": event.target.value + "22" });
});
addEventListener("beforeunload", save);
renderIssueFilterOptions();
render();
requestAnimationFrame(() => scrollTo(0, state.scrollY || 0));
`;
}
