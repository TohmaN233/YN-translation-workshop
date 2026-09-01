import { buildLinePairs, paginateRows } from "./lineReview.ts";
import { buildPrompt, promptParameterDefaults, type PromptAdvancedOptions } from "./prompts.ts";
import type { GlossaryEntry } from "./glossary.ts";
import type { ReviewProposal } from "./reviewReport.ts";
import type { EpubReplacementOptions } from "./epubExport.ts";
import { agentChatEmbedCss, agentChatEmbedHtml, agentChatEmbedScript } from "./agentChatEmbed.ts";

export type UiLocale = "zh-CN" | "en-US";

export interface LineReviewHtmlOptions {
  title: string;
  sourceText: string;
  translationText?: string;
  pageSize?: number;
  startPage?: number;
  locale?: UiLocale;
  /** Absolute path to this HTML file; embedded so import/repair IPC uses a real path, not location.href. */
  lineReviewPath?: string;
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
  /** Relative child HTML path rooted at the batch index directory. */
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
  workflow?: HtmlWorkflowOptions;
}

export interface HtmlWorkflowOptions {
  sourcePath?: string;
  /** UTF-8 line source used to match, validate, repair, and import Agent artifacts. */
  validationSourcePath?: string;
  sourceKind?: "file" | "folder";
  translationPath?: string;
  /** Host-owned UTF-8 TXT that line-review edits may overwrite, including EPUB-extracted translations. */
  editableTranslationPath?: string;
  sourcePromptPath?: string;
  /** Prompt-only source scope; line-review editing may still remain file-scoped. */
  promptSourceKind?: "file" | "folder";
  translationPromptPath?: string;
  outputDir?: string;
  glossaryPath?: string;
  glossaryEntries?: GlossaryEntry[];
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
    documentFilter: "文件",
    allDocuments: "全部文件",
    exportJson: "导出状态 JSON",
    restore: "还原当前行",
    reviewTitle: "校对建议审阅",
    current: "当前译文",
    problemType: "问题类型",
    problem: "问题说明",
    suggestion: "建议译文",
    accept: "接受",
    reject: "拒绝",
    manual: "人工改写",
    conflict: "冲突",
    keepCurrent: "保留当前",
    acceptAgent: "接受 Agent",
    manualMerge: "手动合并",
    conflictList: "冲突列表",
    revisionHistory: "版本历史",
    noConflicts: "暂无冲突",
    askAgentTranslation: "发送给 Agent 询问翻译",
    askAgentSelection: "发送选中原文给 Agent"
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
    documentFilter: "Document",
    allDocuments: "All documents",
    exportJson: "Export state JSON",
    restore: "Restore current row",
    reviewTitle: "Proposal Review",
    current: "Current translation",
    problemType: "Issue type",
    problem: "Issue",
    suggestion: "Suggested translation",
    accept: "Accept",
    reject: "Reject",
    manual: "Manual edit",
    conflict: "Conflict",
    keepCurrent: "Keep current",
    acceptAgent: "Accept Agent",
    manualMerge: "Manual merge",
    conflictList: "Conflicts",
    revisionHistory: "Revision history",
    noConflicts: "No conflicts",
    askAgentTranslation: "Ask Agent about this translation",
    askAgentSelection: "Send selected source to Agent"
  }
} as const;

const workflowLabels: Record<UiLocale, Record<string, string>> = {
  "zh-CN": {
    aiTools: "AI \u5de5\u5177",
    generateTranslatePrompt: "\u751f\u6210\u7ffb\u8bd1\u63d0\u793a\u8bcd",
    generateProofreadPrompt: "\u751f\u6210\u6821\u5bf9\u63d0\u793a\u8bcd",
    promptSettingsTitle: "\u63d0\u793a\u8bcd\u53c2\u6570",
    promptSettingsTranslateTitle: "\u7ffb\u8bd1\u53c2\u6570",
    promptSettingsProofreadTitle: "\u6821\u5bf9\u53c2\u6570",
    promptSettingsReset: "\u6062\u590d\u9ed8\u8ba4",
    promptSettingsResetDone: "\u5df2\u6062\u590d\u9ed8\u8ba4\u53c2\u6570",
    promptSettingsApply: "\u751f\u6210\u63d0\u793a\u8bcd",
    promptSettingsCancel: "\u53d6\u6d88",
    promptGenerationFailed: "\u63d0\u793a\u8bcd\u751f\u6210\u5931\u8d25",
    style: "\u98ce\u683c",
    workDescription: "\u4f5c\u54c1\u8bf4\u660e",
    translateOutputDir: "\u7ffb\u8bd1\u8f93\u51fa\u6587\u4ef6\u5939",
    proofreadOutputDir: "\u62a5\u544a\u8f93\u51fa\u6587\u4ef6\u5939",
    split: "\u62c6\u5206",
    splitSize: "\u62c6\u5206\u5927\u5c0f",
    folderTranslationOrder: "\u6587\u4ef6\u7ffb\u8bd1\u987a\u5e8f",
    folderTranslationOrderHint: "\u5927\u62ec\u53f7\u5185\u7684\u6587\u4ef6\u4e92\u76f8\u6ca1\u6709\u5148\u540e\u8981\u6c42\uff0c\u4ecd\u7531\u5b50 Agent \u6309\u884c\u6570\u52a8\u6001\u6392\u961f\uff0c\u4e0d\u4ee3\u8868\u5fc5\u987b\u540c\u65f6\u5f00\u59cb\u6216\u5b8c\u6210\uff1b\u79fb\u5230\u5927\u62ec\u53f7\u5916\u624d\u4f1a\u6309\u4e66\u5199\u987a\u5e8f\u4e25\u683c\u5148\u540e\u5904\u7406\uff1b\u4ece\u8868\u8fbe\u5f0f\u4e2d\u5220\u9664\u7684\u6587\u4ef6\u4f1a\u5728\u7ffb\u8bd1\u548c\u6821\u5bf9\u4e2d\u8df3\u8fc7\u3002",
    customPreserveRules: "\u81ea\u5b9a\u4e49\u6b63\u5219\u4fdd\u7559\u89c4\u5219",
    customPreserveRulesHint: "\u6bcf\u6761\u89c4\u5219\u5339\u914d\u5230\u7684\u539f\u6587\u5fc5\u987b\u5728\u8bd1\u6587\u4e2d\u539f\u6837\u4fdd\u7559\u3002\u9002\u5408\u4fdd\u7559\u884c\u9996\u6807\u8bc6\u7b26\u3001\u5bf9\u8bdd\u65b9\u6846\u548c\u9879\u76ee\u7279\u6709\u63a7\u5236\u7801\u3002",
    customPreserveRuleLabel: "\u8bf4\u660e",
    customPreserveRulePattern: "\u6b63\u5219\u8868\u8fbe\u5f0f",
    customPreserveRuleFlags: "\u6807\u5fd7",
    addCustomPreserveRule: "\u6dfb\u52a0\u4fdd\u7559\u89c4\u5219",
    removeCustomPreserveRule: "\u5220\u9664\u4fdd\u7559\u89c4\u5219",
    reuseExistingTranslation: "\u5ba1\u8ba1\u5e76\u590d\u7528\u5df2\u6709\u8bd1\u6587",
    subagent: "\u5b50 Agent",
    subagentCount: "\u5b50 Agent \u6570\u91cf",
    reviewSubagentCount: "\u5ba1\u9605 Agent \u6570\u91cf",
    reviewSubagentCountFollowTranslation: "\u8ddf\u968f\u7ffb\u8bd1 Agent \u6570\u91cf",
    proofreadMode: "\u6821\u5bf9\u6a21\u5f0f",
    candidateRatio: "H9 \u5019\u9009\u6bd4\u4f8b",
    montecarloSize: "Monte Carlo \u62bd\u6837\u6570\u91cf",
    montecarloRoundMin: "\u6700\u5c11\u8f6e\u6570",
    montecarloRoundMax: "\u6700\u591a\u8f6e\u6570",
    subagentModel: "\u5b50 Agent \u6a21\u578b",
    subagentModelFollowParent: "\u8ddf\u968f\u4e3b Agent",
    subagentModelLoading: "\u6b63\u5728\u52a0\u8f7d\u5df2\u914d\u7f6e\u7684 Pi \u6a21\u578b...",
    subagentModelUnavailable: "\u672a\u627e\u5230\u5df2\u914d\u7f6e\u6a21\u578b\uff0c\u5b50 Agent \u9ed8\u8ba4\u8ddf\u968f\u4e3b Agent",
    generateReviewHtml: "\u751f\u6210\u5ba1\u9605 HTML",
    copyPrompt: "\u590d\u5236\u63d0\u793a\u8bcd",
    openAgentChat: "Agent \u4f1a\u8bdd",
    agentChatPopout: "\u65b0\u7a97\u53e3",
    agentChatSettings: "\u8bbe\u7f6e",
    agentChatSettingsTitle: "Agent \u670d\u52a1\u8bbe\u7f6e",
    agentChatLoading: "\u6b63\u5728\u52a0\u8f7d Agent OS\u2026",
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
    refresh: "\u5237\u65b0",
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
    proposalApplyRunning: "\u6b63\u5728\u5e94\u7528\u5efa\u8bae",
    proposalApplyFailed: "\u5e94\u7528\u5efa\u8bae\u5931\u8d25",
    proposalApplySkipped: "\u8df3\u8fc7",
    mechanicalScan: "\u673a\u68b0\u626b\u63cf",
    mechanicalConfirm: "\u786e\u8ba4\u95ee\u9898",
    mechanicalFalsePositive: "\u8bef\u62a5",
    mechanicalConfirmed: "\u5df2\u786e\u8ba4\u4e3a\u95ee\u9898",
    mechanicalSuppressed: "\u5df2\u8bb0\u5f55\u8bef\u62a5\uff0c\u9996\u9875\u4e0d\u518d\u663e\u793a",
    proposalSafetySkipped: "安全检查未通过",
    proposalConflictSkipped: "冲突未应用",
    proposalOpenFailed: "\u6253\u5f00\u6b63\u6587 HTML \u5931\u8d25",
    reviewGenerated: "\u5df2\u751f\u6210\u5ba1\u9605 HTML",
    reviewFindings: "审阅 findings",
    reviewTerminologyFindings: "审阅术语 findings",
    reviewCharacterVoiceFindings: "审阅角色语气 findings",
    reviewFinalQaFindings: "审阅最终 QA findings",
    reviewGenerationFailed: "\u751f\u6210\u5ba1\u9605 HTML \u5931\u8d25",
    reviewFormatFallback: "AI 报告未通过格式审核，已生成格式修复提示词。",
    reviewHtmlNeedsApp: "\u751f\u6210\u5ba1\u9605 HTML \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML",
    reviewReportFound: "\u5df2\u627e\u5230\u6821\u5bf9\u62a5\u544a",
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
    importGeneratedGlossary: "\u4e00\u952e\u5bfc\u5165 Agent \u672f\u8bed\u5019\u9009",
    generatedGlossaryImported: "Agent \u672f\u8bed\u5019\u9009\u5df2\u5bfc\u5165",
    generatedGlossaryImportFailed: "Agent \u672f\u8bed\u5019\u9009\u5bfc\u5165\u5931\u8d25",
    txtWriteNeedsApp: "\u5199\u5165 TXT \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML\u3002\u8bf7\u4ece\u5e94\u7528\u91cd\u65b0\u6253\u5f00\u751f\u6210\u7ed3\u679c\u3002",
    txtWriteMissingTarget: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a\u8bd1\u6587\u6587\u4ef6\u8def\u5f84\uff0c\u4e0d\u80fd\u8986\u76d6\u5199\u5165\u3002\u8bf7\u5728\u5e94\u7528\u4e2d\u9009\u62e9\u8bd1\u6587\u6587\u4ef6\u540e\u91cd\u65b0\u751f\u6210 HTML\u3002",
    txtWriteFailed: "\u5199\u5165 TXT \u5931\u8d25",
    epubWriteNeedsApp: "\u5bfc\u51fa EPUB \u9700\u8981\u5728 translation-workshop \u5e94\u7528\u5185\u6253\u5f00\u6b64 HTML\u3002",
    epubWriteMissingTemplate: "\u5f53\u524d HTML \u6ca1\u6709\u7ed1\u5b9a EPUB \u6a21\u677f\u8def\u5f84\u3002",
    epubWriteFailed: "EPUB \u5bfc\u51fa\u5931\u8d25",
    agentArtifacts: "Agent 译文产物",
    artifactsPanelIntro: "扫描 AI_translation/ 下的 Agent 初翻候选，校验后可导入为行审草稿。",
    artifactsBridgeMissing: "请从 translation-workshop 应用内打开此 HTML，以使用 Agent 产物发现。",
    refreshArtifacts: "刷新",
    scanningArtifacts: "正在扫描 Agent 产物…",
    noArtifacts: "未在 AI_translation/ 下找到候选译文产物。",
    artifactsNeedOutputDir: "需要先选择输出文件夹才能发现 Agent 产物。",
    artifactScanFailed: "产物扫描失败",
    importAsDraft: "导入为译文草稿",
    openRepair: "定位到问题行",
    generateRepairPrompt: "生成格式修复提示词",
    openArtifact: "打开产物文件",
    importingDraft: "正在导入候选译文为草稿…",
    importedDraft: "已导入为草稿",
    importedDraftNote: "（{count} 行）最终 TXT 需手动导出才会写入。",
    importBlocked: "校验未通过，已阻止导入",
    importFailed: "导入失败",
    repairPromptReady: "修复提示词已填入下方 Agent 输入框，可直接复制或发送。",
    repairPromptFailed: "修复提示词生成失败",
    repairJumpedToLine: "已跳转到第 {line} 行，请对照原文检查候选译文。",
    repairLineCountHint: "行数不一致（原文 {source} 行，候选 {candidate} 行），无法定位单行；请使用「生成格式修复提示词」。",
    artifactSourceLabel: "原文",
    artifactSourceUnmatched: "未匹配到原文文件，绑定原文后才能导入。",
    artifactOkBadge: "通过",
    artifactBlockingBadge: "阻断",
    artifactWarningBadge: "警告",
    artifactValidationFailed: "校验失败",
    artifactsRescanned: "已从磁盘重新扫描 {count} 个产物。"
  },
  "en-US": {
    aiTools: "AI tools",
    generateTranslatePrompt: "Generate translation prompt",
    generateProofreadPrompt: "Generate proofread prompt",
    promptSettingsTitle: "Prompt parameters",
    promptSettingsTranslateTitle: "Translate parameters",
    promptSettingsProofreadTitle: "Proofread parameters",
    promptSettingsReset: "Restore defaults",
    promptSettingsResetDone: "Default parameters restored",
    promptSettingsApply: "Generate prompt",
    promptSettingsCancel: "Cancel",
    promptGenerationFailed: "Prompt generation failed",
    style: "Style",
    workDescription: "Work description",
    translateOutputDir: "Translation output folder",
    proofreadOutputDir: "Report output folder",
    split: "Split",
    splitSize: "Split size",
    folderTranslationOrder: "File translation order",
    folderTranslationOrderHint: "Files inside braces have no order preference and remain in the line-balanced dynamic worker queue; they do not have to start or finish together. Move a file outside the braces to enforce written order. Delete a filename from the expression to skip it in translation and proofreading.",
    customPreserveRules: "Custom regex preservation rules",
    customPreserveRulesHint: "Every source match must remain verbatim in the translation. Use this for line prefixes, dialogue brackets, and project-specific control codes.",
    customPreserveRuleLabel: "Label",
    customPreserveRulePattern: "Regular expression",
    customPreserveRuleFlags: "Flags",
    addCustomPreserveRule: "Add preservation rule",
    removeCustomPreserveRule: "Remove preservation rule",
    reuseExistingTranslation: "Audit and reuse existing translation",
    subagent: "Subagent",
    subagentCount: "Subagent count",
    reviewSubagentCount: "Review Agent count",
    reviewSubagentCountFollowTranslation: "Follow translation Agent count",
    proofreadMode: "Proofread mode",
    candidateRatio: "H9 candidate ratio",
    montecarloSize: "Monte Carlo sample size",
    montecarloRoundMin: "Minimum rounds",
    montecarloRoundMax: "Maximum rounds",
    subagentModel: "Subagent model",
    subagentModelFollowParent: "Follow main Agent",
    subagentModelLoading: "Loading configured Pi models...",
    subagentModelUnavailable: "No configured model found; subagents will follow the main Agent",
    generateReviewHtml: "Generate review HTML",
    copyPrompt: "Copy prompt",
    openAgentChat: "Agent chat",
    agentChatPopout: "New window",
    agentChatSettings: "Settings",
    agentChatSettingsTitle: "Provider settings",
    agentChatLoading: "Loading Agent OS…",
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
    refresh: "Refresh",
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
    proposalApplyRunning: "Applying proposals",
    proposalApplyFailed: "Failed to apply proposals",
    proposalApplySkipped: "skipped",
    proposalSafetySkipped: "failed safety check",
    proposalConflictSkipped: "conflicts",
    mechanicalScan: "Mechanical scan",
    mechanicalConfirm: "Confirm issue",
    mechanicalFalsePositive: "False positive",
    mechanicalConfirmed: "Confirmed as an issue",
    mechanicalSuppressed: "False positive saved and hidden from the main review",
    proposalOpenFailed: "Failed to open line HTML",
    reviewGenerated: "Review HTML generated",
    reviewFindings: "Review findings",
    reviewTerminologyFindings: "Review terminology findings",
    reviewCharacterVoiceFindings: "Review character voice findings",
    reviewFinalQaFindings: "Review final QA findings",
    reviewGenerationFailed: "Review HTML generation failed",
    reviewFormatFallback: "The AI report failed format validation. A repair prompt was generated.",
    reviewHtmlNeedsApp: "Open this HTML in translation-workshop to generate review HTML.",
    reviewReportFound: "Report found",
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
    importGeneratedGlossary: "Import Agent glossary candidates",
    generatedGlossaryImported: "Agent glossary candidates imported",
    generatedGlossaryImportFailed: "Agent glossary candidate import failed",
    txtWriteNeedsApp: "Writing TXT needs this HTML to be opened inside the translation-workshop app. Reopen the generated result from the app.",
    txtWriteMissingTarget: "This HTML has no bound translation file path, so it cannot overwrite a TXT file. Choose a translation file in the app and regenerate the HTML.",
    txtWriteFailed: "TXT write failed",
    epubWriteNeedsApp: "Exporting EPUB needs this HTML to be opened inside the translation-workshop app.",
    epubWriteMissingTemplate: "This HTML has no bound EPUB template path.",
    epubWriteFailed: "EPUB export failed",
    agentArtifacts: "Agent translation artifacts",
    artifactsPanelIntro: "Scans AI_translation/ for agent draft candidates; import validated results as line-review drafts.",
    artifactsBridgeMissing: "Open this HTML inside translation-workshop to discover agent artifacts.",
    refreshArtifacts: "Refresh",
    scanningArtifacts: "Scanning for agent artifacts…",
    noArtifacts: "No candidate translation artifacts found under AI_translation/.",
    artifactsNeedOutputDir: "Set an output folder to discover agent artifacts.",
    artifactScanFailed: "Artifact scan failed",
    importAsDraft: "Import as draft",
    openRepair: "Jump to issue line",
    generateRepairPrompt: "Generate repair prompt",
    openArtifact: "Open artifact",
    importingDraft: "Importing candidate as draft…",
    importedDraft: "Imported as draft",
    importedDraftNote: "({count} lines). Export manually to write the final TXT.",
    importBlocked: "Import blocked by validation",
    importFailed: "Import failed",
    repairPromptReady: "Repair prompt is in the Agent input box below — copy or send it.",
    repairPromptFailed: "Repair prompt generation failed",
    repairJumpedToLine: "Jumped to line {line}. Compare the candidate against the source.",
    repairLineCountHint: "Line count mismatch ({source} source vs {candidate} candidate). Use Generate repair prompt.",
    artifactSourceLabel: "Source",
    artifactSourceUnmatched: "Source not matched — bind a source file before importing.",
    artifactOkBadge: "OK",
    artifactBlockingBadge: "blocking",
    artifactWarningBadge: "warnings",
    artifactValidationFailed: "Validation failed",
    artifactsRescanned: "Rescanned {count} artifact(s) from disk."
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
  const validationSourcePath = fallbackPath(workflow?.validationSourcePath ?? workflow?.sourcePath, "source path");
  const translationPath = fallbackPath(workflow?.translationPath, "sync translation file first");
  const promptSourcePath = fallbackPath(workflow?.sourcePromptPath ?? workflow?.sourcePath, "source path");
  const promptTranslationPath = workflow?.translationPromptPath ?? workflow?.translationPath;
  const promptTranslationPathFallback = fallbackPath(promptTranslationPath, "sync translation file first");
  const promptSourceKind = workflow?.promptSourceKind ?? workflow?.sourceKind;
  const outputDir = fallbackPath(workflow?.outputDir, "output folder");
  const glossaryPath = workflow?.glossaryPath;
  const advanced = workflow?.advanced;
  const inputMode = workflow?.inputMode ?? "separate";
  const promptInputMode = workflow?.promptInputMode ?? inputMode;
  const promptDefaults = promptParameterDefaults(outputDir, advanced);
  const factoryPromptDefaults = promptParameterDefaults(outputDir, {
    folderSourceDocuments: advanced?.folderSourceDocuments
  });

  return {
    inputMode,
    promptInputMode,
    paths: {
      sourcePath,
      validationSourcePath,
      sourceKind: workflow?.sourceKind ?? "file",
      promptSourceKind: promptSourceKind ?? "file",
      translationPath: workflow?.translationPath ?? "",
      editableTranslationPath: workflow?.editableTranslationPath ?? "",
      promptSourcePath,
      promptTranslationPath: promptTranslationPath ?? "",
      outputDir,
      glossaryPath: glossaryPath ?? ""
    },
    promptDefaults,
    factoryPromptDefaults,
    glossaryEntries: workflow?.glossaryEntries ?? [],
    bilingualPair: workflow?.bilingualPair,
    epubExport: workflow?.epubExport ?? { mode: "all" },
    advanced,
    initialTranslationLines,
    hasInitialTranslation: initialTranslationLines.some((line) => line.trim() !== ""),
    prompts: {
      translate: buildPrompt({ kind: "translate", sourcePath: promptSourcePath, sourceKind: promptSourceKind, translationPath: promptTranslationPath, outputDir, glossaryPath, inputMode: promptInputMode, advanced }),
      proofread: buildPrompt({ kind: "proofread", sourcePath: promptSourcePath, translationPath: promptTranslationPathFallback, glossaryPath, outputDir, inputMode: promptInputMode, advanced })
    }
  };
}

function animeThemeCss(mode: "line" | "proposal"): string {
  const layout = mode === "line"
    ? `
    header { position:sticky; top:0; z-index:10; display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center; padding:14px 18px; background:linear-gradient(100deg,var(--night),#344b9a 46%,var(--sky)); color:white; box-shadow:0 8px 24px rgba(95,111,191,.22); border-bottom:3px solid rgba(255,255,255,.42); }
    header::after { content:none; }
    .toolbar { display:flex; flex-wrap:wrap; justify-content:end; gap:8px; align-items:center; }
    .agent-global-controls { display:flex; align-items:center; gap:8px; }
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
    @media (max-width: 900px) { header { grid-template-columns:1fr; } .toolbar { justify-content:start; } main { max-width:none; padding:12px 10px 40px; } .row, body.audit-visible .row { grid-template-columns:36px minmax(0,1fr); } .source,.target { grid-column:2; width:100%; max-width:none; } .audit-marker { grid-column:1; grid-row:2; } }`
    : `
    .app { display:grid; grid-template-columns:310px minmax(0,1fr); min-height:100vh; }
    aside { position:sticky; top:0; height:100vh; overflow:auto; padding:20px; background:var(--panel-bg); border-right:1px solid var(--line); box-shadow:10px 0 28px rgba(95,111,191,.1); }
    aside::before { content:""; display:block; width:118px; height:14px; margin:0 0 14px auto; border-radius:999px; background:linear-gradient(90deg,var(--sakura),var(--lemon),var(--mint)); }
    .app aside > label { display:block; margin-top:10px; color:var(--muted); font-size:13px; font-weight:700; }
    .app aside > input,.app aside > select { display:block; width:100%; margin-top:4px; }
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
    .conflict-box { display:grid; gap:8px; border:1px solid #ffd08a; border-radius:8px; background:#fff8ec; padding:10px; }
    .conflict-box b { color:#9a6500; }
    .conflict-box .toolbar { margin:0; }
    .conflict-merge-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
    .conflict-merge-pane { display:grid; gap:4px; min-width:0; }
    .conflict-merge-pane span { font-size:12px; color:var(--muted); font-weight:700; }
    .conflict-merge-pane .text { max-height:120px; overflow:auto; border:1px solid #f4d28f; border-radius:6px; background:#fff; padding:8px; white-space:pre-wrap; }
    .conflict-diff-old { background:#ffe4e6; color:#9f1239; text-decoration:line-through; }
    .conflict-diff-new { background:#dcfce7; color:#166534; }
    .conflict-history { display:grid; gap:6px; padding:8px; border:1px solid #f4d28f; border-radius:6px; background:#fffdfa; color:#6d4b13; font-size:12px; }
    .conflict-history summary { cursor:pointer; font-weight:700; }
    .conflict-history-row { display:grid; gap:3px; padding-top:6px; border-top:1px solid #f8e6bd; }
    .conflict-history-row code { display:inline; color:#6d4b13; background:#fff8ec; }
    .conflict-history-row .text { max-height:76px; overflow:auto; background:#fff; border-color:#f4d28f; }
    .conflict-summary { display:grid; gap:6px; margin:10px 0; padding:10px; border:1px solid #ffd08a; border-radius:8px; background:#fff8ec; }
    .conflict-summary b { color:#9a6500; }
    .conflict-summary button { justify-content:flex-start; text-align:left; white-space:normal; }
    @media (max-width: 900px) { .app { grid-template-columns:1fr; } aside { position:static; height:auto; } .field { grid-template-columns:1fr; } .conflict-merge-grid { grid-template-columns:1fr; } }`;

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
    .agent-artifacts { display:grid; gap:10px; margin:0 0 16px; padding:14px; border:1px solid var(--line); border-radius:8px; background:var(--panel-bg); box-shadow:0 10px 26px rgba(95,111,191,.08); }
    .agent-artifacts header { position:static; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; padding:0; color:var(--ink); background:none; box-shadow:none; border:0; }
    .agent-artifacts header::after { content:none; }
    .agent-artifact-list { display:grid; gap:10px; max-height:min(60vh,520px); overflow:auto; }
    .artifact-card { display:grid; gap:6px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:#fff; }
    .artifact-card header { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:14px; }
    .artifact-meta { font-size:12px; color:var(--muted); word-break:break-all; }
    .artifact-meta.warn { color:#b45309; }
    .artifact-badge { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); background:#fff; }
    .artifact-badge.ok { color:#15803d; border-color:#86efac; background:#ecfdf5; }
    .artifact-badge.warn { color:#b45309; border-color:#fcd34d; background:#fffbeb; }
    .artifact-badge.block { color:#b91c1c; border-color:#fca5a5; background:#fef2f2; }
    .artifact-blocking, .artifact-warnings { margin:4px 0 0; padding-left:18px; font-size:12px; line-height:1.4; }
    .artifact-blocking li { color:#b91c1c; }
    .artifact-warnings li { color:#92400e; }
    .artifact-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:4px; }
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
    #promptFolderTranslationOrder { min-height:120px; max-height:240px; resize:vertical; }
    .prompt-preserve-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .prompt-preserve-heading button { width:34px; min-width:34px; min-height:34px; padding:0; font-size:20px; line-height:1; }
    .prompt-preserve-rules { display:grid; gap:8px; }
    .prompt-preserve-row { display:grid; grid-template-columns:minmax(110px,.65fr) minmax(220px,1.8fr) 72px 34px; gap:8px; align-items:center; }
    .prompt-preserve-row input { width:100%; min-width:0; }
    .prompt-preserve-row button { width:34px; min-width:34px; min-height:34px; padding:0; font-size:18px; line-height:1; }
    @media (max-width:720px) { .prompt-preserve-row { grid-template-columns:1fr 72px 34px; } .prompt-preserve-row .prompt-preserve-label { grid-column:1 / -1; } }
    .glossary-drawer header strong { display:flex; align-items:center; gap:4px; }
    .glossary-drawer .glossary-actions { justify-content:flex-start; }
    ${agentChatEmbedCss()}
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
            <button id="resetPromptSettings" type="button">${t.promptSettingsReset ?? "Restore defaults"}</button>
            <button id="cancelPromptSettings" type="button">${t.promptSettingsCancel ?? "Cancel"}</button>
            <button id="applyPromptSettings" type="button" class="primary">${t.promptSettingsApply ?? "Generate prompt"}</button>
          </div>
        </header>
        <div class="prompt-grid">
          <label><span>${t.languagePair ?? "Language pair"}</span><input id="promptLanguagePair" type="text" placeholder="ja->zh-CN"></label>
          <label><span>${t.style ?? "Style"}</span><input id="promptStyle" type="text"></label>
          <label id="promptSplitSizeField"><span>${t.splitSize ?? "Split size"}</span><input id="promptSplitSize" type="number" min="1"></label>
          <label class="prompt-wide"><span>${t.workDescription ?? "Work description"}</span><textarea id="promptWorkDescription" spellcheck="false" placeholder="None"></textarea></label>
          <label id="promptFolderTranslationOrderField" class="prompt-wide" hidden><span>${t.folderTranslationOrder ?? "File translation order"}</span><textarea id="promptFolderTranslationOrder" spellcheck="false"></textarea><small>${t.folderTranslationOrderHint ?? "Files inside braces have no order preference and remain in the dynamic worker queue. Move a file outside the braces to enforce written order."}</small></label>
        </div>
        <div class="prompt-section prompt-preserve-settings">
          <div class="prompt-preserve-heading">
            <strong>${t.customPreserveRules ?? "Custom regex preservation rules"}</strong>
            <button id="addPromptCustomPreserveRule" type="button" title="${t.addCustomPreserveRule ?? "Add preservation rule"}" aria-label="${t.addCustomPreserveRule ?? "Add preservation rule"}">+</button>
          </div>
          <div id="promptCustomPreserveRules" class="prompt-preserve-rules"></div>
          <small>${t.customPreserveRulesHint ?? "Every source match must remain verbatim in the translation."}</small>
        </div>
        <div class="prompt-section prompt-subagent-settings">
          <strong>${t.subagentModel ?? "Subagent model"}</strong>
          <div class="prompt-grid">
            <label id="promptSubagentField" class="prompt-check"><input id="promptSubagent" type="checkbox"><span>${t.subagent ?? "Subagent"}</span></label>
            <label id="promptSubagentCountField"><span>${t.subagentCount ?? "Subagent count"}</span><input id="promptSubagentCount" type="number" min="1"></label>
            <label id="promptReviewSubagentCountField"><span>${t.reviewSubagentCount ?? "Review Agent count"}</span><input id="promptReviewSubagentCount" type="number" min="1" placeholder="${t.reviewSubagentCountFollowTranslation ?? "Follow translation Agent count"}"></label>
            <label class="prompt-wide"><span>${t.subagentModel ?? "Subagent model"}</span><select id="promptSubagentModel"><option value="">${t.subagentModelFollowParent ?? "Follow main Agent"}</option></select><small id="promptSubagentModelStatus">${t.subagentModelFollowParent ?? "Follow main Agent"}</small></label>
          </div>
        </div>
        <div id="translatePromptSettings" class="prompt-section">
          <strong>${t.promptSettingsTranslateTitle ?? "Translate parameters"}</strong>
          <div class="prompt-grid">
            <label class="prompt-wide"><span>${t.translateOutputDir ?? "Translation output folder"}</span><input id="promptTranslateOutputDir" type="text"></label>
            <label class="prompt-check"><input id="promptGlossaryCandidates" type="checkbox"><span>${t.glossaryCandidates ?? "Glossary candidates"}</span></label>
            <label class="prompt-check"><input id="promptCharacterBible" type="checkbox"><span>${t.characterBible ?? "Character bible"}</span></label>
            <label class="prompt-check"><input id="promptReuseExistingTranslation" type="checkbox"><span>${t.reuseExistingTranslation ?? "Audit and reuse existing translation"}</span></label>
            <label id="promptSplitField" class="prompt-check"><input id="promptSplit" type="checkbox"><span>${t.split ?? "Split"}</span></label>
          </div>
        </div>
        <div id="proofreadPromptSettings" class="prompt-section">
          <strong>${t.promptSettingsProofreadTitle ?? "Proofread parameters"}</strong>
          <div class="prompt-grid">
            <label class="prompt-wide"><span>${t.proofreadOutputDir ?? "Report output folder"}</span><input id="promptProofreadOutputDir" type="text"></label>
            <label id="promptProofreadModeField"><span>${t.proofreadMode ?? "Proofread mode"}</span><select id="promptProofreadMode"><option value="split">split</option><option value="montecarlo">montecarlo</option></select></label>
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
  const editableTranslationPath = workflow.paths?.editableTranslationPath ?? translationPath;
  const canSaveTxt = /\.txt$/i.test(editableTranslationPath);
  return `<section id="aiTools" class="ai-tools">
      <header>
        <strong>${t.aiTools ?? "AI tools"}</strong>
        <div class="ai-actions">
          <button id="translatePrompt" type="button">${t.generateTranslatePrompt ?? "Generate translation prompt"}</button>
          <button id="proofreadPrompt" type="button">${t.generateProofreadPrompt ?? "Generate proofread prompt"}</button>
          <button id="generateReviewHtml" type="button">${t.generateReviewHtml ?? "Generate review HTML"}</button>
          <button id="copyPrompt" type="button" class="primary">${t.copyPrompt ?? "Copy prompt"}</button>
          <button id="syncTranslation" type="button">${t.syncTranslation ?? "Sync translation"}</button>
          <button id="chooseTranslationFile" type="button">${t.chooseTranslationFile ?? "Choose other file"}</button>
          <label class="compact-select">${t.exportTxtMode ?? "TXT"} <select id="exportTxtMode"><option value="translation">${t.exportTxtMono ?? "Mono"}</option><option value="bilingual">${t.exportTxtBilingual ?? "Bilingual"}</option></select></label>
          <button id="exportTxt" type="button">${t.exportTxt ?? "Export TXT"}</button>
          ${sourceIsEpub ? `<button id="exportEpub" type="button">${t.exportEpub ?? "Export EPUB"}</button>` : ""}
          <button id="saveTxt" type="button"${canSaveTxt ? "" : " hidden"}>${t.saveTxt ?? "Save TXT"}</button>
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
      <section id="agentArtifactsPanel" class="agent-artifacts">
        <header>
          <strong>${t.agentArtifacts ?? "Agent translation artifacts"}</strong>
          <button id="refreshAgentArtifacts" type="button">${t.refreshArtifacts ?? "Refresh"}</button>
        </header>
        <p class="ai-status" id="agentArtifactsStatus">${t.artifactsPanelIntro ?? "Scanning AI_translation/ for agent draft candidates."}</p>
        <div id="agentArtifactsList" class="agent-artifact-list"></div>
      </section>
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
          <button id="importGeneratedGlossary" type="button" hidden>${t.importGeneratedGlossary ?? "Import Agent glossary candidates"}</button>
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
    open: "\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00",
    writeAllTxt: "\u6279\u91cf\u5199\u5165 TXT",
    batchWriteRunning: "\u6b63\u5728\u5199\u5165\u5168\u90e8 TXT...",
    batchWriteDone: "\u5df2\u5199\u5165 {count} \u4e2a TXT",
    batchWriteFailed: "\u6279\u91cf\u5199\u5165\u5931\u8d25",
    promptTitle: "\u6587\u4ef6\u5939\u6279\u91cf\u7ffb\u8bd1\u63d0\u793a\u8bcd",
    promptHint: "\u8fd9\u662f\u9488\u5bf9\u5f53\u524d\u6587\u4ef6\u5939\u7684\u6279\u91cf\u7ffb\u8bd1\u63d0\u793a\u8bcd\uff0c\u4f1a\u6309\u6587\u4ef6\u5206\u522b\u5904\u7406\u3002",
    copyPrompt: "\u590d\u5236\u63d0\u793a\u8bcd",
    openAgent: "\u5728 Agent \u4e2d\u6253\u5f00",
    agentOpened: "Agent \u5df2\u6253\u5f00\uff0c\u63d0\u793a\u8bcd\u5df2\u653e\u5165\u8f93\u5165\u6846",
    agentOpenFailed: "\u65e0\u6cd5\u6253\u5f00 Agent",
    copied: "\u5df2\u590d\u5236",
    copyFailed: "\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u9009\u4e2d\u63d0\u793a\u8bcd"
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
    open: "Open in new tab",
    writeAllTxt: "Write all TXT",
    batchWriteRunning: "Writing all TXT files...",
    batchWriteDone: "Wrote {count} TXT files",
    batchWriteFailed: "Batch TXT write failed",
    promptTitle: "Folder batch translation prompt",
    promptHint: "This prompt targets the selected folder and processes its files as separate translation artifacts.",
    copyPrompt: "Copy prompt",
    openAgent: "Open in Agent",
    agentOpened: "Agent opened with the prompt in its composer",
    agentOpenFailed: "Could not open Agent",
    copied: "Copied",
    copyFailed: "Copy failed; select the prompt manually"
  }
};

// v3 removed the obsolete outer batch prompt sidebar. v4 added the compact,
// Host-backed batch TXT action. v5 flushes the active child before Host preflight.
// v6 keeps match state internal instead of presenting stale same-name-file status.
export const BATCH_LINE_REVIEW_PROTOCOL_VERSION = 6;
export const BATCH_LINE_REVIEW_PROTOCOL_MARKER = `translation-workshop-batch-review-v${BATCH_LINE_REVIEW_PROTOCOL_VERSION}`;

export function renderBatchLineReviewIndexHtml(options: BatchLineReviewIndexOptions): string {
  const locale = options.locale ?? "zh-CN";
  const t = batchLabels[locale];
  const firstFile = options.files[0];
  const workflow = options.workflow
    ? workflowData({ ...options.workflow, sourceKind: "folder" })
    : undefined;
  const folderTranslatePrompt = workflow?.prompts.translate ?? "";
  const folderAgentRoute = workflow
    ? {
      outputDir: workflow.paths.outputDir,
      locale,
      languagePair: workflow.promptDefaults.languagePair,
      sourcePath: workflow.paths.sourcePath,
      sourceKind: "folder" as const,
      translationPath: workflow.paths.translationPath,
      inputMode: workflow.inputMode,
      glossaryPath: workflow.paths.glossaryPath,
      advanced: workflow.advanced,
      initialPrompt: folderTranslatePrompt,
      initialWorkflowIntent: "translation" as const,
      initialLanguagePair: workflow.promptDefaults.languagePair
    }
    : undefined;
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="translation-workshop-batch-review" content="${BATCH_LINE_REVIEW_PROTOCOL_MARKER}">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { --bg:#eef8ff; --panel:#ffffffea; --ink:#26324d; --muted:#6d7896; --line:#cfe0f5; --sky:#72d3ff; --night:#2d5d9f; --ok:#74d6b7; --warn:#ffca6b; --bad:#ff9db9; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); font-family:"Microsoft YaHei","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif; background:linear-gradient(180deg,#eef8ff,#f8fcff 56%,#e5f4ff); }
    header { position:sticky; top:0; z-index:2; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:center; padding:14px 18px; color:white; background:linear-gradient(100deg,var(--night),#344b9a 46%,var(--sky)); box-shadow:0 8px 24px rgba(95,111,191,.22); }
    h1 { margin:0; font-size:18px; line-height:1.35; letter-spacing:0; }
    select,button { min-height:36px; border:1px solid var(--line); border-radius:8px; background:#fff; color:var(--ink); padding:7px 10px; font:inherit; }
    button { cursor:pointer; }
    main { display:grid; grid-template-columns:minmax(0,1fr); min-height:calc(100vh - 66px); }
    .viewer { min-width:0; display:grid; grid-template-rows:auto minmax(0,1fr); }
    .viewerBar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); background:#ffffffc9; }
    .batchWriteStatus { min-width:0; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    .batchWriteStatus.error { color:#a52850; }
    iframe { width:100%; height:100%; border:0; background:#fff; }
    @media (max-width: 960px) { header { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(options.title)}</h1>
    <label>${t.chooseFile} <select id="fileSelect">${options.files.map((file, index) => `<option value="${index}">${escapeHtml(file.sourceName)}</option>`).join("")}</select></label>
  </header>
  <main>
    <section class="viewer">
      <div class="viewerBar">
        <strong id="activeTitle">${escapeHtml(firstFile?.sourceName ?? "")}</strong>
        <button id="openActive" type="button">${t.open}</button>
        <button id="writeAllTxt" type="button">${t.writeAllTxt}</button>
        <span id="batchWriteStatus" class="batchWriteStatus" role="status" aria-live="polite"></span>
      </div>
      <iframe id="fileFrame" src="${escapeHtml(firstFile?.outputPath ?? "about:blank")}"></iframe>
    </section>
  </main>
  <script id="batchData" type="application/json">${jsonScript({ files: options.files, labels: t, folderAgentRoute })}</script>
  <script>
const data = JSON.parse(document.getElementById("batchData").textContent);
const select = document.getElementById("fileSelect");
const frame = document.getElementById("fileFrame");
const title = document.getElementById("activeTitle");
function applyFile(index) {
  const file = data.files[index] || data.files[0];
  if (!file) return;
  select.value = String(index);
  frame.src = file.outputPath;
  title.textContent = file.sourceName;
}
select.addEventListener("change", () => applyFile(Number(select.value || 0)));
document.getElementById("openActive").addEventListener("click", async () => {
  const file = data.files[Number(select.value || 0)] || data.files[0];
  if (!file) return;
  try {
    const api = window.workshopHtml || window.workshop;
    if (!api?.openPath) throw new Error("The Electron HTML tab host is unavailable.");
    const targetUrl = new URL(file.outputPath, location.href).href;
    const error = await api.openPath(targetUrl);
    if (error) throw new Error(error);
  } catch (error) {
    console.error(error);
    window.alert(String(error && error.message ? error.message : error));
  }
});
document.getElementById("writeAllTxt").addEventListener("click", async () => {
  const button = document.getElementById("writeAllTxt");
  const status = document.getElementById("batchWriteStatus");
  button.disabled = true;
  status.className = "batchWriteStatus";
  status.textContent = data.labels.batchWriteRunning;
  try {
    const api = window.workshopHtml || window.workshop;
    if (!api?.writeBatchLineReviewTxt) throw new Error("The Electron batch TXT host is unavailable.");
    const flushChild = frame.contentWindow?.flushTranslationWorkshopLineReviewState;
    if (typeof flushChild === "function") await flushChild.call(frame.contentWindow);
    const result = await api.writeBatchLineReviewTxt();
    status.textContent = data.labels.batchWriteDone.replace("{count}", String(result?.written?.length || 0));
  } catch (error) {
    console.error(error);
    status.className = "batchWriteStatus error";
    status.textContent = data.labels.batchWriteFailed + ": " + String(error && error.message ? error.message : error);
  } finally {
    button.disabled = false;
  }
});
applyFile(0);
  </script>
</body>
</html>`;
}

export const LINE_REVIEW_PROTOCOL_VERSION = 36;
export const LINE_REVIEW_PROTOCOL_MARKER = `translation-workshop-line-review-v${LINE_REVIEW_PROTOCOL_VERSION}`;
export const PROPOSAL_REVIEW_PROTOCOL_VERSION = 12;
export const PROPOSAL_REVIEW_PROTOCOL_MARKER = `translation-workshop-proposal-review-v${PROPOSAL_REVIEW_PROTOCOL_VERSION}`;
export const PROMPT_SETTINGS_VERSION = 40;

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
  <meta name="translation-workshop-line-review" content="${LINE_REVIEW_PROTOCOL_MARKER}">
  <meta name="translation-workshop-prompt-settings" content="${PROMPT_SETTINGS_VERSION}">
  <title>${escapeHtml(options.title)}</title>
  <style>${animeThemeCss("line")}</style>
  <style>${animeThemeCss("line")}</style>
  <style>
    .yn-agent-row-menu { position:fixed; z-index:10000; min-width:210px; padding:4px; border:1px solid var(--border); border-radius:6px; background:var(--panel-bg); box-shadow:0 12px 28px rgba(15,23,42,.18); }
    .yn-agent-row-menu button { width:100%; border:0; background:transparent; padding:8px 10px; text-align:left; color:var(--text); }
    .yn-agent-row-menu button:hover { background:color-mix(in srgb, var(--sky) 18%, transparent); }
  </style>
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
      <div class="agent-global-controls" aria-label="${t.agentChatSettingsTitle ?? "Agent settings"}">
        <button id="agentChatSettingsGlobal" type="button">${t.agentChatSettings ?? "Settings"}</button>
      </div>
      <button id="openAgentChat" type="button" class="primary">${t.openAgentChat ?? "Agent chat"}</button>
      <button id="agentChatPopout" type="button">${t.agentChatPopout ?? "New window"}</button>
      <button id="agentChatPopoutBack" type="button" hidden>${t.back ?? "Back"}</button>
      <button id="glossaryDrawerToggle" type="button">${t.glossaryOpen ?? "Glossary"}</button>
      ${themeControlsHtml(t)}
    </div>
  </header>
  ${glossaryToolsHtml(t, workflow.glossaryEntries)}
  <div class="line-review-shell">
    <div class="line-review-main">
      <main>
        ${aiToolsHtml(t, workflow)}
        <div class="status">
          <span>${t.total}: <strong id="totalCount">${rows.length}</strong></span>
          <span>${t.changed}: <strong id="changedCount">0</strong></span>
          <span><strong id="pageInfo"></strong></span>
        </div>
        <section id="rows"></section>
      </main>
    </div>
    ${agentChatEmbedHtml(t)}
  </div>
  <script id="reviewData" type="application/json">${jsonScript({ rows, pageSize: firstPage.pageSize, startPage: firstPage.page, labels: t, workflow, locale, lineReviewPath: options.lineReviewPath ?? "" })}</script>
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
state.documentRevision = Number.isInteger(Number(state.documentRevision)) ? Number(state.documentRevision) : 0;
const lineReviewClientId = globalThis.crypto?.randomUUID?.()
  || "line-review-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
const lineScopedStateKeys = ["edits", "status", "revisions", "revisionHistory", "auditIssues", "auditWhitelist"];
const synchronizedDocumentStateKeys = [
  "translationPath",
  "translationPromptPath",
  "syncedFile",
  "syncedAt",
  "savedTxtFile",
  "savedTxtAt",
  "savedEpubFile",
  "savedEpubAt"
];
delete state.glossaryEntries;
delete state.glossaryTargets;
delete state.glossaryAliases;
delete state.glossaryPath;
state.edits ||= {};
state.status ||= {};
for (const line in state.status) {
  if (state.status[line] === "machine") delete state.status[line];
}
if (state.synced) delete state.synced;
state.theme ||= {};
state.auditIssues ||= {};
state.auditWhitelist ||= {};
state.revisions ||= {};
state.revisionHistory ||= {};
state.auditVisible ||= false;
let syncedLines = workflow.hasInitialTranslation ? (workflow.initialTranslationLines || []) : [];
let page = state.page || data.startPage || 1;
let activeLine = state.activeLine || null;
let projectGlossaryPath = workflow.paths?.glossaryPath || "";
let restoringPosition = true;
let searchTerm = "";
let searchMatches = [];
const pageSize = data.pageSize || 1000;
const rowsEl = document.getElementById("rows");
const pageInput = document.getElementById("pageInput");
const pageInfo = document.getElementById("pageInfo");
const changedCount = document.getElementById("changedCount");
let lastHostStateWrite = Promise.resolve();
let applyingCanonicalState = false;
let canonicalStateHydrated = false;
let localLineMutationSequence = 0;
const pendingLineMutations = new Map();
let queuedLineReviewStateWrite = null;
let lastTrackedHostStateRequest = null;
const lineReviewSyncTrace = [];
window.__ynLineReviewSyncTrace = lineReviewSyncTrace;
function traceLineReviewSync(type, detail) {
  lineReviewSyncTrace.push({ type, at: Date.now(), ...detail });
  if (lineReviewSyncTrace.length > 80) lineReviewSyncTrace.splice(0, lineReviewSyncTrace.length - 80);
}
function normalizedLineReviewPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function sameLineReviewPath(value) {
  const expected = data.lineReviewPath || currentLineReviewPath();
  return normalizedLineReviewPath(value) === normalizedLineReviewPath(expected);
}
function storeLineReviewStateLocally() {
  const serialized = JSON.stringify(state);
  localStorage.setItem(key, serialized);
  if (key !== legacyKey) localStorage.setItem(legacyKey, serialized);
  return serialized;
}
function normalizedChangedLines(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(line => Number.isInteger(line) && line > 0))];
}
function capturePendingLineMutation(snapshot, changedLines, mutationId) {
  for (const line of changedLines) {
    const lineKey = String(line);
    const values = {};
    for (const mapKey of lineScopedStateKeys) {
      const map = snapshot[mapKey] && typeof snapshot[mapKey] === "object" && !Array.isArray(snapshot[mapKey])
        ? snapshot[mapKey]
        : {};
      values[mapKey] = Object.prototype.hasOwnProperty.call(map, lineKey)
        ? { present: true, value: map[lineKey] }
        : { present: false };
    }
    pendingLineMutations.set(lineKey, { mutationId, values });
  }
}
function acknowledgePendingLineMutation(payload, changedLines) {
  if (payload?.clientId !== lineReviewClientId || !payload?.mutationId) return;
  for (const line of changedLines) {
    const lineKey = String(line);
    if (pendingLineMutations.get(lineKey)?.mutationId === payload.mutationId) {
      pendingLineMutations.delete(lineKey);
    }
  }
}
function clearRejectedLineMutation(changedLines, mutationId) {
  for (const line of changedLines) {
    const lineKey = String(line);
    if (pendingLineMutations.get(lineKey)?.mutationId === mutationId) {
      pendingLineMutations.delete(lineKey);
    }
  }
}
function trackHostStateRequest(request) {
  if (lastTrackedHostStateRequest === request) return request;
  lastTrackedHostStateRequest = request;
  lastHostStateWrite = Promise.all([lastHostStateWrite.catch(() => undefined), request]).then(() => undefined);
  void lastHostStateWrite.catch(error => console.warn("translation-workshop could not persist line-review state", error));
  return request;
}
function dispatchLineReviewStateWrite(persist, request) {
  traceLineReviewSync("persist-start", {
    mutationId: request.mutationId,
    changedLines: request.changedLines,
    edits: request.changedLines.map(line => [line, request.state.edits?.[line]])
  });
  return persist(request).then((result) => {
    applyCanonicalLineReviewState(result);
    return result;
  }).catch((error) => {
    clearRejectedLineMutation(request.changedLines, request.mutationId);
    console.error("translation-workshop failed to persist line-review state", error);
    throw error;
  });
}
function dispatchQueuedLineReviewStateWrite() {
  const pending = queuedLineReviewStateWrite;
  if (!pending) return Promise.resolve();
  queuedLineReviewStateWrite = null;
  clearTimeout(pending.timer);
  const request = dispatchLineReviewStateWrite(pending.persist, pending.request);
  request.then(pending.resolve, pending.reject);
  return request;
}
function queueLineReviewStateWrite(persist, request) {
  const previous = queuedLineReviewStateWrite;
  if (previous) clearTimeout(previous.timer);
  let resolve = previous?.resolve;
  let reject = previous?.reject;
  const completion = previous?.completion || new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  const changedLines = [...new Set([...(previous?.request.changedLines || []), ...request.changedLines])];
  const mergedRequest = { ...request, changedLines };
  capturePendingLineMutation(mergedRequest.state, changedLines, mergedRequest.mutationId);
  const pending = {
    persist,
    request: mergedRequest,
    completion,
    resolve,
    reject,
    timer: 0
  };
  pending.timer = setTimeout(() => {
    void dispatchQueuedLineReviewStateWrite().catch(() => undefined);
  }, 40);
  queuedLineReviewStateWrite = pending;
  return completion;
}
function flushQueuedLineReviewStateWrite() {
  return dispatchQueuedLineReviewStateWrite();
}
function applyCanonicalLineMaps(incoming, changedLines, hydrate) {
  for (const mapKey of lineScopedStateKeys) {
    const incomingMap = incoming[mapKey] && typeof incoming[mapKey] === "object" && !Array.isArray(incoming[mapKey])
      ? incoming[mapKey]
      : {};
    if (hydrate) {
      state[mapKey] = { ...incomingMap };
      continue;
    }
    state[mapKey] ||= {};
    for (const line of changedLines) {
      const lineKey = String(line);
      if (Object.prototype.hasOwnProperty.call(incomingMap, lineKey)) state[mapKey][lineKey] = incomingMap[lineKey];
      else delete state[mapKey][lineKey];
    }
  }
}
function overlayPendingLineMutations() {
  for (const [lineKey, pending] of pendingLineMutations) {
    for (const mapKey of lineScopedStateKeys) {
      state[mapKey] ||= {};
      const entry = pending.values[mapKey];
      if (entry?.present) state[mapKey][lineKey] = entry.value;
      else delete state[mapKey][lineKey];
    }
  }
}
function refreshRenderedCanonicalLines(changedLines, activeEditor) {
  for (const line of changedLines) {
    const rowElement = rowsEl.querySelector('.row[data-line="' + line + '"]');
    const target = rowElement?.querySelector(".target");
    const row = data.rows.find(item => Number(item.line) === Number(line));
    if (!rowElement || !target || !row || target === activeEditor) continue;
    target.textContent = rowValue(row);
    const status = state.status[line] || row.status;
    rowElement.classList.toggle("manual", status === "manual");
    rowElement.classList.toggle("glossary", status === "glossary");
  }
  changedCount.textContent = Object.keys(state.edits).length;
}
async function refreshSyncedLinesFromCanonical(path, syncedAt) {
  const filePath = String(path || "").trim();
  const bridge = writeBridge();
  if (!filePath || !bridge?.readTextFile || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(filePath)) return;
  try {
    const result = await bridge.readTextFile({ path: filePath });
    if (state.syncedFile !== filePath || state.syncedAt !== syncedAt) return;
    syncedLines = splitSyncedText(result.text || "");
    await writeSyncedText(syncedLines.join("\n"));
    applyingCanonicalState = true;
    try {
      render();
    } finally {
      applyingCanonicalState = false;
    }
  } catch (error) {
    console.warn("translation-workshop could not refresh synchronized translation text", error);
  }
}
function applyCanonicalLineReviewState(payload) {
  const incoming = payload?.state;
  if (!incoming || typeof incoming !== "object" || !sameLineReviewPath(payload?.lineReviewPath)) return;
  const incomingRevision = Number(incoming.documentRevision || 0);
  if (incomingRevision <= Number(state.documentRevision || 0)) return;
  const changedLines = normalizedChangedLines(payload?.changedLines);
  const changedStateKeys = Array.isArray(payload?.changedStateKeys) ? payload.changedStateKeys.map(String) : [];
  const hydrate = !canonicalStateHydrated;
  traceLineReviewSync("canonical-received", {
    revision: incomingRevision,
    mutationId: payload?.mutationId || "",
    changedLines,
    incomingEdits: changedLines.map(line => [line, incoming.edits?.[line]]),
    pending: changedLines.map(line => [line, pendingLineMutations.get(String(line))?.mutationId || ""])
  });
  acknowledgePendingLineMutation(payload, changedLines);
  const previousSyncedAt = state.syncedAt;
  applyCanonicalLineMaps(incoming, changedLines, hydrate);
  const stateKeysToApply = hydrate ? synchronizedDocumentStateKeys : changedStateKeys;
  for (const key of stateKeysToApply) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) state[key] = incoming[key];
    else delete state[key];
  }
  canonicalStateHydrated = true;
  state.documentRevision = incomingRevision;
  overlayPendingLineMutations();
  traceLineReviewSync("canonical-applied", {
    revision: incomingRevision,
    mutationId: payload?.mutationId || "",
    edits: changedLines.map(line => [line, state.edits?.[line]]),
    pending: changedLines.map(line => [line, pendingLineMutations.get(String(line))?.mutationId || ""])
  });
  const ownWrite = payload?.clientId === lineReviewClientId;
  const refreshSyncedText = !ownWrite
    && incoming.syncedAt
    && incoming.syncedAt !== previousSyncedAt
    && typeof incoming.syncedFile === "string";
  try {
    storeLineReviewStateLocally();
  } catch (error) {
    console.warn("translation-workshop could not store synchronized line-review state", error);
  }
  const activeEditor = document.activeElement?.closest?.(".target");
  if (activeEditor) {
    refreshRenderedCanonicalLines(hydrate ? pageRows().map(row => row.line) : changedLines, activeEditor);
    return;
  }
  if (!hydrate && changedLines.length === 0 && changedStateKeys.length === 0) {
    return;
  }
  if (ownWrite && changedLines.length > 0) {
    return;
  }
  applyingCanonicalState = true;
  try {
    render();
  } finally {
    applyingCanonicalState = false;
  }
  if (refreshSyncedText) void refreshSyncedLinesFromCanonical(incoming.syncedFile, incoming.syncedAt);
}
function save(changedLines = [], changedStateKeys = []) {
  state.page = page;
  if (!restoringPosition) state.scrollY = scrollY;
  state.activeLine = activeLine;
  try {
    const serialized = storeLineReviewStateLocally();
    const persist = invokeBridge()?.persistHtmlState;
    if (persist) {
      const snapshot = JSON.parse(serialized);
      const normalizedLines = normalizedChangedLines(changedLines);
      const mutationId = normalizedLines.length > 0
        ? lineReviewClientId + ":" + (++localLineMutationSequence)
        : "";
      const persistRequest = {
        kind: "line",
        lineReviewPath: data.lineReviewPath || "",
        state: snapshot,
        changedLines: normalizedLines,
        changedStateKeys: Array.isArray(changedStateKeys) ? changedStateKeys.map(String) : [],
        clientId: lineReviewClientId,
        mutationId
      };
      const request = normalizedLines.length > 0 && changedStateKeys.length === 0
        ? queueLineReviewStateWrite(persist, persistRequest)
        : flushQueuedLineReviewStateWrite().then(() => {
          if (mutationId) capturePendingLineMutation(snapshot, normalizedLines, mutationId);
          return dispatchLineReviewStateWrite(persist, persistRequest);
        });
      trackHostStateRequest(request);
    }
  } catch (error) {
    console.warn("translation-workshop could not persist small UI state", error);
  }
  return lastHostStateWrite;
}
window.flushTranslationWorkshopLineReviewState = async () => {
  await flushQueuedLineReviewStateWrite();
  return save();
};
const unsubscribeLineReviewState = invokeBridge()?.onLineReviewStateUpdate?.((payload) => {
  applyCanonicalLineReviewState(payload);
});
setTimeout(() => { void save(); }, 0);
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
  scheduleAgentInterfaceContextPublish();
  if (!applyingCanonicalState) save();
}
function escapeHtml(text) { return String(text).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function recordLineRevision(line, text, status, source) {
  const key = String(line);
  state.revisions ||= {};
  state.revisionHistory ||= {};
  const revision = Number(state.revisions[key] || 0) + 1;
  state.revisions[key] = revision;
  const history = Array.isArray(state.revisionHistory[key]) ? state.revisionHistory[key] : [];
  const entry = { revision, text: String(text ?? ""), status: String(status || ""), source: String(source || "edit") };
  const last = history[history.length - 1];
  if (!last || last.text !== entry.text || last.status !== entry.status || last.source !== entry.source) {
    history.push(entry);
  }
  // Keep bounded local history; canonical state is persisted by the Electron host.
  state.revisionHistory[key] = history.slice(-12);
  return revision;
}
const composingTargets = new WeakSet();
const lastPersistedTargetText = new WeakMap();
function updateEditedTarget(target, persist) {
  if (!target) return;
  const row = target.closest(".row");
  if (!row) return;
  const line = row.dataset.line;
  if (lanSyncStopping || lanSyncStarting) {
    const canonicalRow = data.rows.find(item => String(item.line) === String(line));
    target.textContent = canonicalRow ? rowValue(canonicalRow) : "";
    return;
  }
  const text = target.textContent || "";
  activeLine = line;
  state.edits[line] = text;
  state.status[line] = "manual";
  row.classList.add("manual");
  changedCount.textContent = Object.keys(state.edits).length;
  if (!persist || lastPersistedTargetText.get(target) === text) {
    scheduleAgentInterfaceContextPublish();
    return;
  }
  lastPersistedTargetText.set(target, text);
  recordLineRevision(line, text, "manual", "desktop-edit");
  persistLineReviewPatch({ type: "line-edit", line: Number(line), text, status: "manual" });
  scheduleAgentInterfaceContextPublish();
}
rowsEl.addEventListener("compositionstart", (event) => {
  const target = event.target.closest?.(".target");
  if (target) composingTargets.add(target);
});
rowsEl.addEventListener("compositionend", (event) => {
  const target = event.target.closest?.(".target");
  if (!target) return;
  composingTargets.delete(target);
  updateEditedTarget(target, true);
});
rowsEl.addEventListener("input", (event) => {
  const target = event.target.closest?.(".target");
  if (!target) return;
  updateEditedTarget(target, !event.isComposing && !composingTargets.has(target));
});
rowsEl.addEventListener("focusin", (event) => {
  const target = event.target.closest(".target");
  if (!target) return;
  const row = target.closest(".row");
  activeLine = row?.dataset.line || activeLine;
  save();
  scheduleAgentInterfaceContextPublish();
});
rowsEl.addEventListener("focusout", (event) => {
  const target = event.target.closest?.(".target");
  const line = Number(target?.closest?.(".row")?.dataset.line || 0);
  queueMicrotask(() => {
    if (document.activeElement?.closest?.(".target")) return;
    if (line > 0) refreshRenderedCanonicalLines([line], null);
  });
});
rowsEl.addEventListener("click", (event) => {
  const marker = event.target.closest(".audit-marker");
  if (!marker) return;
  const row = marker.closest(".row");
  const line = Number(row?.dataset.line || 0);
  if (line > 0) void toggleAuditWhitelistLine(line).catch(error => {
    console.error("translation-workshop failed to update the audit whitelist", error);
  });
});
document.getElementById("prev").onclick = () => { page -= 1; render(); scrollTo(0, 0); };
document.getElementById("next").onclick = () => { page += 1; render(); scrollTo(0, 0); };
document.getElementById("jump").onclick = () => { page = Number(pageInput.value || 1); render(); scrollTo(0, 0); };
function restoreCurrentLine() {
  const active = document.activeElement?.closest?.(".target");
  const rowEl = active?.closest(".row") || (activeLine ? Array.from(rowsEl.querySelectorAll(".row")).find(row => row.dataset.line === String(activeLine)) : null);
  const line = rowEl?.dataset.line || activeLine;
  if (!line) return;
  if (lanSyncStopping || lanSyncStarting) return;
  delete state.edits[line];
  delete state.status[line];
  const row = data.rows.find(item => String(item.line) === String(line));
  const targetEl = rowEl?.querySelector(".target");
  if (targetEl) targetEl.textContent = row ? rowValue(row) : "";
  recordLineRevision(line, row ? rowValue(row) : "", row?.status || "", "desktop-restore");
  rowEl?.classList.remove("manual");
  rowEl?.classList.remove("glossary");
  changedCount.textContent = Object.keys(state.edits).length;
  persistLineReviewPatch({ type: "line-restore", line: Number(line) });
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
const promptSettingsPanel = document.getElementById("promptSettingsPanel");
const promptSettingsHeading = document.getElementById("promptSettingsHeading");
const translatePromptSettings = document.getElementById("translatePromptSettings");
const proofreadPromptSettings = document.getElementById("proofreadPromptSettings");
const promptLanguagePair = document.getElementById("promptLanguagePair");
const promptStyle = document.getElementById("promptStyle");
const promptWorkDescription = document.getElementById("promptWorkDescription");
const promptTranslateOutputDir = document.getElementById("promptTranslateOutputDir");
const promptProofreadOutputDir = document.getElementById("promptProofreadOutputDir");
const promptGlossaryCandidates = document.getElementById("promptGlossaryCandidates");
const promptCharacterBible = document.getElementById("promptCharacterBible");
const promptReuseExistingTranslation = document.getElementById("promptReuseExistingTranslation");
const promptSplit = document.getElementById("promptSplit");
const promptSplitSize = document.getElementById("promptSplitSize");
const promptSplitField = document.getElementById("promptSplitField");
const promptSplitSizeField = document.getElementById("promptSplitSizeField");
const promptFolderTranslationOrder = document.getElementById("promptFolderTranslationOrder");
const promptFolderTranslationOrderField = document.getElementById("promptFolderTranslationOrderField");
const promptCustomPreserveRules = document.getElementById("promptCustomPreserveRules");
const addPromptCustomPreserveRule = document.getElementById("addPromptCustomPreserveRule");
const promptSubagent = document.getElementById("promptSubagent");
const promptSubagentField = document.getElementById("promptSubagentField");
const promptSubagentCount = document.getElementById("promptSubagentCount");
const promptSubagentCountField = document.getElementById("promptSubagentCountField");
const promptReviewSubagentCount = document.getElementById("promptReviewSubagentCount");
const promptReviewSubagentCountField = document.getElementById("promptReviewSubagentCountField");
const promptProofreadMode = document.getElementById("promptProofreadMode");
const promptProofreadModeField = document.getElementById("promptProofreadModeField");
const promptCandidateRatio = document.getElementById("promptCandidateRatio");
const promptMontecarloSize = document.getElementById("promptMontecarloSize");
const promptMontecarloRoundMin = document.getElementById("promptMontecarloRoundMin");
const promptMontecarloRoundMax = document.getElementById("promptMontecarloRoundMax");
const promptSubagentModel = document.getElementById("promptSubagentModel");
const promptSubagentModelStatus = document.getElementById("promptSubagentModelStatus");
const startLanSyncButton = document.getElementById("startLanSync");
const lanSyncPanel = document.getElementById("lanSyncPanel");
const lanSyncLinks = document.getElementById("lanSyncLinks");
const lanSyncPinInput = document.getElementById("lanSyncPin");
const copyLanSyncLinkButton = document.getElementById("copyLanSyncLink");
const stopLanSyncButton = document.getElementById("stopLanSync");
let activePromptKind = "translate";
let lanSyncToken = "";
let lanSyncPrimaryUrl = "";
let lanSyncStarting = false;
let lanSyncStopping = false;
const lanSyncPendingPatches = new Map();
function setAiStatus(text) {
  if (aiStatus) aiStatus.textContent = text || "";
}
let projectPromptSettings = {};
let promptSettingsEditRevision = 0;
let promptSettingsDirty = false;
const promptSettingsVersion = ${PROMPT_SETTINGS_VERSION};
const projectPromptSettingKeys = [
  "languagePair", "style", "workDescription", "workflowTemplateId",
  "translateOutputDir", "proofreadOutputDir", "split", "splitSize",
  "folderTranslationOrder", "glossaryCandidates", "characterBible", "reuseExistingTranslation",
  "proofreadMode", "candidateRatio", "montecarloSize", "montecarloRoundMin",
  "montecarloRoundMax", "subagentEnabled", "subagentCount", "reviewSubagentCount",
  "subagentProviderId", "subagentModelId", "customPreserveRules", "promptSettingsVersion"
];
function optionalPositivePromptNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
function normalizedPromptDefaults(defaults = {}) {
  return {
    languagePair: defaults.languagePair || "ja->zh-CN",
    style: defaults.style || "game",
    workDescription: defaults.workDescription || "",
    workflowTemplateId: defaults.workflowTemplateId || "",
    translateOutputDir: defaults.translateOutputDir || "",
    proofreadOutputDir: defaults.proofreadOutputDir || "",
    split: defaults.split !== false,
    splitSize: Number(defaults.splitSize || 1000),
    folderTranslationOrder: defaults.folderTranslationOrder || "",
    folderSourceDocuments: Array.isArray(defaults.folderSourceDocuments)
      ? defaults.folderSourceDocuments
      : undefined,
    customPreserveRules: Array.isArray(defaults.customPreserveRules) ? defaults.customPreserveRules : [],
    glossaryCandidates: defaults.glossaryCandidates !== false,
    characterBible: defaults.characterBible !== false,
    reuseExistingTranslation: defaults.reuseExistingTranslation === true,
    proofreadMode: defaults.proofreadMode === "montecarlo" ? "montecarlo" : "split",
    candidateRatio: Number(defaults.candidateRatio || 1.5),
    montecarloSize: Number(defaults.montecarloSize || 3000),
    montecarloRoundMin: Number(defaults.montecarloRoundMin || 2),
    montecarloRoundMax: Number(defaults.montecarloRoundMax || 5),
    subagentEnabled: defaults.subagentEnabled !== false,
    subagentCount: optionalPositivePromptNumber(defaults.subagentCount),
    reviewSubagentCount: optionalPositivePromptNumber(defaults.reviewSubagentCount),
    subagentProviderId: defaults.subagentProviderId || "",
    subagentModelId: defaults.subagentModelId || "",
    promptSettingsVersion
  };
}
function promptStoredDefaults() {
  return normalizedPromptDefaults(workflow.promptDefaults || {});
}
function defaultFolderTranslationOrder(documents) {
  const documentIds = (Array.isArray(documents) ? documents : [])
    .map((document) => String(document?.id || "").trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en"));
  return documentIds.length > 0
    ? ["{", ...documentIds.map((documentId) => JSON.stringify(documentId)), "}"].join("\n")
    : "";
}
function promptFactoryDefaults() {
  const defaults = normalizedPromptDefaults(workflow.factoryPromptDefaults || {});
  const folderTranslationOrder = defaultFolderTranslationOrder(defaults.folderSourceDocuments);
  delete defaults.folderSourceDocuments;
  return {
    ...defaults,
    folderTranslationOrder,
    customPreserveRules: [],
    reviewSubagentCount: null,
    subagentProviderId: "",
    subagentModelId: "",
    promptSettingsVersion
  };
}
function readStoredPromptSettings() {
  return projectPromptSettings;
}
function promptSettingsValue() {
  return { ...promptStoredDefaults(), ...readStoredPromptSettings() };
}
async function writeStoredPromptSettings(settings) {
  projectPromptSettings = { ...settings };
  await persistProjectState(settings);
}

function promptSettingsFromProjectState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const settings = {};
  for (const settingKey of projectPromptSettingKeys) {
    if (Object.prototype.hasOwnProperty.call(value, settingKey)) settings[settingKey] = value[settingKey];
  }
  const storedVersion = optionalPositivePromptNumber(settings.promptSettingsVersion) || 0;
  if (storedVersion < promptSettingsVersion) {
    // Older HTML materialized the inherited review-worker fallback as an explicit
    // project value. Clear it once; users can set a real override in the new field.
    settings.reviewSubagentCount = null;
    if (optionalPositivePromptNumber(settings.subagentCount) === undefined) {
      settings.subagentCount = promptStoredDefaults().subagentCount;
    }
    settings.promptSettingsVersion = promptSettingsVersion;
  }
  return settings;
}

function normalizedProjectOutputDir(value) {
  return String(value || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase();
}

let projectTranslationPath = "";
let projectTranslationOrigin = "";
function applyProjectPromptSettings(value) {
  projectPromptSettings = promptSettingsFromProjectState(value);
  const needsPromptSettingsMigration = Number(value?.promptSettingsVersion || 0) < promptSettingsVersion;
  const hasGlossaryPath = Boolean(value && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, "glossaryPath"));
  const glossaryPath = String(value?.glossaryPath || "").trim();
  if (hasGlossaryPath) {
    projectGlossaryPath = glossaryPath;
    workflowPaths().glossaryPath = glossaryPath;
  }
  applyProjectTranslationBinding(value);
  if (!promptSettingsTextEditorActive()) {
    fillPromptSettingsForm();
    updatePromptSettingsVisibility();
  }
  if (needsPromptSettingsMigration) {
    void writeStoredPromptSettings(projectPromptSettings).catch((error) => {
      setAiStatus((data.labels.promptSettingsSaveFailed || "Project settings save failed") + ": " + (error?.message || String(error)));
    });
  }
  return hasGlossaryPath;
}

async function hydrateProjectPromptSettings() {
  const outputDir = String(workflow.paths?.outputDir || "").trim();
  const bridge = writeBridge();
  if (!outputDir || outputDir.startsWith("[") || !bridge?.readProjectState) return;
  try {
    const hasProjectGlossaryPath = applyProjectPromptSettings(await bridge.readProjectState(outputDir));
    if (boundGlossaryPath()) {
      await syncGlossaryFromBoundFile();
    } else if (bridge.readProjectAssets) {
      const assets = await bridge.readProjectAssets({ outputDir });
      const glossaryPath = String(assets?.paths?.glossary || "").trim();
      if (assets?.available?.glossary === true
        && syncGlossaryFromText(JSON.stringify(assets.glossary), glossaryPath || "project glossary", true)) {
        if (glossaryPath) setBoundGlossaryPath(glossaryPath);
      } else if (hasProjectGlossaryPath) {
        syncGlossaryFromText("", "project glossary", true);
      }
    } else if (hasProjectGlossaryPath) {
      syncGlossaryFromText("", "project glossary", true);
    }
  } catch (error) {
    setAiStatus("Project settings load failed: " + (error?.message || String(error)));
  }
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
function canonicalPromptRegexFlags(value) {
  const requested = String(value ?? "u").trim();
  for (const flag of requested) {
    if (!"imsu".includes(flag)) throw new Error("Unsupported regex flag '" + flag + "'. Use only i, m, s, or u.");
  }
  return [..."imsu"].filter((flag) => requested.includes(flag)).join("");
}
function readPromptCustomPreserveRules() {
  if (!promptCustomPreserveRules) return [];
  return [...promptCustomPreserveRules.querySelectorAll(".prompt-preserve-row")].map((row, index) => {
    const label = String(row.querySelector(".prompt-preserve-label")?.value || "").trim();
    const pattern = String(row.querySelector(".prompt-preserve-pattern")?.value || "").trim();
    const flags = canonicalPromptRegexFlags(row.querySelector(".prompt-preserve-flags")?.value);
    if (!pattern) return null;
    let regex;
    try {
      regex = new RegExp(pattern, flags + "g");
    } catch (error) {
      throw new Error("Invalid custom preserve rule " + (index + 1) + ": " + (error?.message || String(error)));
    }
    if (regex.test("")) throw new Error("Invalid custom preserve rule " + (index + 1) + ": regular expression must not match an empty string.");
    return { ...(label ? { label } : {}), pattern, flags };
  }).filter(Boolean);
}
function appendPromptCustomPreserveRule(rule = {}) {
  if (!promptCustomPreserveRules) return;
  const row = document.createElement("div");
  row.className = "prompt-preserve-row";
  const label = document.createElement("input");
  label.className = "prompt-preserve-label";
  label.type = "text";
  label.placeholder = data.labels.customPreserveRuleLabel || "Label";
  label.value = String(rule.label || "");
  const pattern = document.createElement("input");
  pattern.className = "prompt-preserve-pattern";
  pattern.type = "text";
  pattern.spellcheck = false;
  pattern.placeholder = data.labels.customPreserveRulePattern || "Regular expression";
  pattern.value = String(rule.pattern || "");
  const flags = document.createElement("input");
  flags.className = "prompt-preserve-flags";
  flags.type = "text";
  flags.placeholder = data.labels.customPreserveRuleFlags || "Flags";
  flags.value = String(rule.flags ?? "u");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "\u00d7";
  remove.title = data.labels.removeCustomPreserveRule || "Remove preservation rule";
  remove.setAttribute("aria-label", remove.title);
  for (const field of [label, pattern, flags]) {
    field.addEventListener("input", markPromptSettingsEdited);
    field.addEventListener("blur", commitPromptSettingsAfterFieldExit);
  }
  remove.addEventListener("click", () => {
    row.remove();
    scheduleProjectPromptSettingsWrite();
  });
  row.append(label, pattern, flags, remove);
  promptCustomPreserveRules.appendChild(row);
  if (!rule.pattern) pattern.focus();
}
function setPromptCustomPreserveRules(rules) {
  if (!promptCustomPreserveRules) return;
  promptCustomPreserveRules.replaceChildren();
  for (const rule of Array.isArray(rules) ? rules : []) appendPromptCustomPreserveRule(rule);
}
function renderPromptCustomPreserveRules(rules) {
  setPromptCustomPreserveRules(rules);
}
addPromptCustomPreserveRule?.addEventListener("click", () => appendPromptCustomPreserveRule());
function promptSubagentSelection() {
  const value = String(promptSubagentModel?.value || "").trim();
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return {
    subagentProviderId: "",
    subagentModelId: ""
  };
  return {
    subagentProviderId: value.slice(0, separator),
    subagentModelId: value.slice(separator + 1)
  };
}
function currentPromptSettings() {
  const defaults = promptStoredDefaults();
  const folderPrompt = workflow.paths?.promptSourceKind === "folder";
  const proofreadMode = folderPrompt
    ? "split"
    : promptProofreadMode?.value === "montecarlo" ? "montecarlo" : "split";
  return {
    languagePair: promptLanguagePair?.value.trim() || defaults.languagePair,
    style: promptStyle?.value.trim() || defaults.style,
    workDescription: promptWorkDescription?.value.trim() || "",
    workflowTemplateId: defaults.workflowTemplateId || "",
    translateOutputDir: promptTranslateOutputDir?.value.trim() || defaults.translateOutputDir,
    proofreadOutputDir: promptProofreadOutputDir?.value.trim() || defaults.proofreadOutputDir,
    split: promptSplit?.checked !== false,
    splitSize: numberFromField(promptSplitSize, defaults.splitSize),
    folderTranslationOrder: promptFolderTranslationOrder?.value.trim() || defaults.folderTranslationOrder || "",
    customPreserveRules: readPromptCustomPreserveRules(),
    glossaryCandidates: promptGlossaryCandidates?.checked !== false,
    characterBible: promptCharacterBible?.checked !== false,
    reuseExistingTranslation: promptReuseExistingTranslation?.checked === true,
    proofreadMode,
    candidateRatio: Number(promptCandidateRatio?.value || defaults.candidateRatio) || defaults.candidateRatio,
    montecarloSize: numberFromField(promptMontecarloSize, defaults.montecarloSize),
    montecarloRoundMin: numberFromField(promptMontecarloRoundMin, defaults.montecarloRoundMin),
    montecarloRoundMax: numberFromField(promptMontecarloRoundMax, defaults.montecarloRoundMax),
    subagentEnabled: promptSubagent?.checked !== false,
    subagentCount: optionalPositivePromptNumber(promptSubagentCount?.value) ?? null,
    reviewSubagentCount: optionalPositivePromptNumber(promptReviewSubagentCount?.value) ?? null,
    promptSettingsVersion,
    ...promptSubagentSelection()
  };
}
function fillPromptSettingsForm() {
  const settings = promptSettingsValue();
  setFieldValue(promptLanguagePair, settings.languagePair);
  setFieldValue(promptStyle, settings.style);
  setFieldValue(promptWorkDescription, settings.workDescription);
  setFieldValue(promptTranslateOutputDir, settings.translateOutputDir);
  setFieldValue(promptProofreadOutputDir, settings.proofreadOutputDir);
  setFieldChecked(promptGlossaryCandidates, settings.glossaryCandidates);
  setFieldChecked(promptCharacterBible, settings.characterBible);
  setFieldChecked(promptReuseExistingTranslation, settings.reuseExistingTranslation);
  setFieldChecked(promptSplit, settings.split);
  setFieldValue(promptSplitSize, settings.splitSize);
  setFieldValue(promptFolderTranslationOrder, settings.folderTranslationOrder);
  setPromptCustomPreserveRules(settings.customPreserveRules);
  setFieldValue(promptProofreadMode, workflow.paths?.promptSourceKind === "folder" ? "split" : settings.proofreadMode);
  setFieldValue(promptCandidateRatio, settings.candidateRatio);
  setFieldValue(promptMontecarloSize, settings.montecarloSize);
  setFieldValue(promptMontecarloRoundMin, settings.montecarloRoundMin);
  setFieldValue(promptMontecarloRoundMax, settings.montecarloRoundMax);
  setFieldChecked(promptSubagent, settings.subagentEnabled);
  setFieldValue(promptSubagentCount, settings.subagentCount);
  setFieldValue(promptReviewSubagentCount, settings.reviewSubagentCount);
  if (promptSubagentModel) {
    const providerId = String(settings.subagentProviderId || "").trim();
    const modelId = String(settings.subagentModelId || "").trim();
    promptSubagentModel.value = providerId && modelId ? providerId + ":" + modelId : "";
  }
}
function setPromptSubagentModelStatus(text) {
  if (promptSubagentModelStatus) promptSubagentModelStatus.textContent = text || "";
}
function appendPromptSubagentOption(select, entry) {
  const value = entry.providerId + ":" + entry.modelId;
  if ([...select.options].some((option) => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = (entry.providerName || entry.providerId) + " / " + (entry.modelName || entry.modelId);
  select.appendChild(option);
}
async function loadPromptSubagentModels() {
  if (!promptSubagentModel) return;
  const bridge = invokeBridge();
  const outputDir = String(workflow.paths?.outputDir || "").trim();
  promptSubagentModel.replaceChildren(new Option(
    data.labels.subagentModelFollowParent || "Follow main Agent",
    ""
  ));
  if (!bridge?.listAgentConfiguredModels || !outputDir) {
    setPromptSubagentModelStatus(data.labels.subagentModelUnavailable || "No configured model found; subagents will follow the main Agent");
    promptSubagentModel.value = "";
    return;
  }
  setPromptSubagentModelStatus(data.labels.subagentModelLoading || "Loading configured Pi models...");
  try {
    const models = await bridge.listAgentConfiguredModels({ outputDir });
    for (const model of models) appendPromptSubagentOption(promptSubagentModel, model);
    const stored = promptSettingsValue();
    const selected = stored.subagentProviderId && stored.subagentModelId
      ? stored.subagentProviderId + ":" + stored.subagentModelId
      : "";
    promptSubagentModel.value = [...promptSubagentModel.options].some((option) => option.value === selected) ? selected : "";
    setPromptSubagentModelStatus(promptSubagentModel.value
      ? promptSubagentModel.options[promptSubagentModel.selectedIndex]?.textContent || ""
      : (data.labels.subagentModelFollowParent || "Follow main Agent"));
  } catch (error) {
    promptSubagentModel.value = "";
    setPromptSubagentModelStatus(
      (data.labels.subagentModelUnavailable || "No configured model found; subagents will follow the main Agent")
      + ": " + (error?.message || String(error))
    );
  }
}
function updatePromptSettingsVisibility() {
  const isProofread = activePromptKind === "proofread";
  const isTranslate = !isProofread;
  const isFolderPrompt = workflow.paths?.promptSourceKind === "folder";
  if (isFolderPrompt && promptProofreadMode) promptProofreadMode.value = "split";
  const isMontecarlo = isProofread && !isFolderPrompt && promptProofreadMode?.value === "montecarlo";
  const isSplitProofread = isProofread && !isMontecarlo;
  const isTranslateSplit = isTranslate && promptSplit?.checked !== false;
  if (promptSettingsHeading) {
    promptSettingsHeading.textContent = isProofread
      ? (data.labels.promptSettingsProofreadTitle || "Proofread parameters")
      : (data.labels.promptSettingsTranslateTitle || "Translate parameters");
  }
  if (translatePromptSettings) translatePromptSettings.hidden = isProofread;
  if (proofreadPromptSettings) proofreadPromptSettings.hidden = !isProofread;
  if (promptProofreadModeField) promptProofreadModeField.hidden = isProofread && isFolderPrompt;
  if (promptSplitField) promptSplitField.hidden = !isTranslate;
  if (promptSplitSizeField) promptSplitSizeField.hidden = !(isTranslateSplit || isSplitProofread);
  if (promptFolderTranslationOrderField) {
    promptFolderTranslationOrderField.hidden = !isFolderPrompt;
  }
  const subagentsEnabled = promptSubagent?.checked !== false;
  if (promptSubagentField) promptSubagentField.hidden = false;
  if (promptSubagentCountField) promptSubagentCountField.hidden = !subagentsEnabled;
  if (promptSubagentCount) promptSubagentCount.disabled = !subagentsEnabled;
  if (promptReviewSubagentCountField) promptReviewSubagentCountField.hidden = !subagentsEnabled;
  if (promptReviewSubagentCount) promptReviewSubagentCount.disabled = !subagentsEnabled;
  if (promptSubagentModel) promptSubagentModel.disabled = !subagentsEnabled;
  document.querySelectorAll(".prompt-montecarlo-field").forEach((field) => {
    field.hidden = !isMontecarlo;
  });
}

let promptSettingsWriteTimer = 0;
function promptSettingsTextEditorActive() {
  const active = document.activeElement;
  return Boolean(promptSettingsPanel && active && promptSettingsPanel.contains(active)
    && (active.matches("textarea") || active.matches('input:not([type="checkbox"]):not([type="radio"])')));
}
function markPromptSettingsEdited() {
  promptSettingsEditRevision += 1;
  promptSettingsDirty = true;
}
function commitPromptSettingsAfterFieldExit() {
  window.setTimeout(() => {
    if (promptSettingsDirty) {
      scheduleProjectPromptSettingsWrite();
    } else if (!promptSettingsTextEditorActive()) {
      fillPromptSettingsForm();
      updatePromptSettingsVisibility();
    }
  }, 0);
}
function scheduleProjectPromptSettingsWrite(delay = 0) {
  window.clearTimeout(promptSettingsWriteTimer);
  promptSettingsWriteTimer = window.setTimeout(() => {
    promptSettingsWriteTimer = 0;
    try {
      const settings = currentPromptSettings();
      const editRevision = promptSettingsEditRevision;
      void writeStoredPromptSettings(settings).then(() => {
        if (promptSettingsEditRevision === editRevision) promptSettingsDirty = false;
        if (!promptSettingsTextEditorActive()) {
          fillPromptSettingsForm();
          updatePromptSettingsVisibility();
        }
      }).catch((error) => {
        setAiStatus((data.labels.promptSettingsSaveFailed || "Project settings save failed") + ": " + (error?.message || String(error)));
      });
    } catch (error) {
      setAiStatus((data.labels.promptSettingsSaveFailed || "Project settings save failed") + ": " + (error?.message || String(error)));
    }
  }, delay);
}
for (const field of [
  promptLanguagePair, promptStyle, promptWorkDescription,
  promptTranslateOutputDir, promptProofreadOutputDir, promptSplitSize,
  promptFolderTranslationOrder, promptSubagentCount, promptReviewSubagentCount, promptCandidateRatio,
  promptMontecarloSize, promptMontecarloRoundMin, promptMontecarloRoundMax
]) {
  field?.addEventListener("input", markPromptSettingsEdited);
  field?.addEventListener("blur", commitPromptSettingsAfterFieldExit);
}
for (const field of [
  promptGlossaryCandidates, promptCharacterBible, promptReuseExistingTranslation, promptSplit, promptSubagent,
  promptProofreadMode, promptSubagentModel
]) {
  field?.addEventListener("change", () => {
    updatePromptSettingsVisibility();
    scheduleProjectPromptSettingsWrite();
  });
}

function openPromptSettings(kind) {
  activePromptKind = kind;
  fillPromptSettingsForm();
  updatePromptSettingsVisibility();
  if (promptSettingsPanel) promptSettingsPanel.hidden = false;
  void loadPromptSubagentModels();
  setAiStatus("");
}
function closePromptSettings() {
  if (promptSettingsPanel) promptSettingsPanel.hidden = true;
}
async function resetPromptSettings() {
  window.clearTimeout(promptSettingsWriteTimer);
  promptSettingsWriteTimer = 0;
  const previousSettings = { ...projectPromptSettings };
  try {
    await writeStoredPromptSettings(promptFactoryDefaults());
    fillPromptSettingsForm();
    updatePromptSettingsVisibility();
    setPromptSubagentModelStatus(data.labels.subagentModelFollowParent || "Follow main Agent");
    setAiStatus(data.labels.promptSettingsResetDone || "Default parameters restored");
  } catch (error) {
    projectPromptSettings = previousSettings;
    fillPromptSettingsForm();
    updatePromptSettingsVisibility();
    setAiStatus((data.labels.promptSettingsSaveFailed || "Project settings save failed") + ": " + (error?.message || String(error)));
  }
}
async function buildPromptFromSettings() {
  let settings;
  window.clearTimeout(promptSettingsWriteTimer);
  promptSettingsWriteTimer = 0;
  try {
    settings = currentPromptSettings();
    await writeStoredPromptSettings(settings);
  } catch (error) {
    setAiStatus((data.labels.promptSettingsSaveFailed || "Project settings save failed") + ": " + (error?.message || String(error)));
    return;
  }
  const bridge = invokeBridge();
  if (!bridge?.buildPrompt) {
    setAiStatus((data.labels.promptGenerationFailed || "Prompt generation failed") + ": Electron prompt bridge is unavailable.");
    return;
  }
  let generated = "";
  try {
    generated = await bridge.buildPrompt({
      kind: activePromptKind,
      sourcePath: workflow.paths?.promptSourcePath || workflow.paths?.sourcePath || "",
      sourceKind: workflow.paths?.promptSourceKind || workflow.paths?.sourceKind || "file",
      translationPath: boundPromptTranslationPath(),
      outputDir: workflow.paths?.outputDir || "",
      glossaryPath: boundGlossaryPath(),
      inputMode: workflow.promptInputMode || workflow.inputMode || "separate",
      advanced: settings
    });
  } catch (error) {
    setAiStatus((data.labels.promptGenerationFailed || "Prompt generation failed") + ": " + (error?.message || String(error)));
    return;
  }
  if (!generated.trim()) {
    setAiStatus((data.labels.promptGenerationFailed || "Prompt generation failed") + ": Empty prompt returned by Electron host.");
    return;
  }
  setPromptText(generated);
  closePromptSettings();
  try {
    await openAgentChatForPrompt();
  } catch (error) {
    setAiStatus("Agent prompt insertion failed: " + (error?.message || String(error)));
  }
}
async function openAgentChatForPrompt() {
  const promptText = promptPreview.value || "";
  const settings = currentPromptSettings();
  const defaults = promptStoredDefaults();
  const workflowMetadata = {
    workflowIntent: activePromptKind === "proofread" ? "proofread" : "translation",
    languagePair: settings.languagePair,
    style: settings.style,
    workDescription: settings.workDescription,
    glossaryPath: boundGlossaryPath(),
    glossaryCandidates: settings.glossaryCandidates,
    characterBible: settings.characterBible,
    reuseExistingTranslation: settings.reuseExistingTranslation,
    auditWhitelistLines: auditWhitelistLines(),
    customPreserveRules: settings.customPreserveRules,
    subagentEnabled: settings.subagentEnabled,
    subagentCount: settings.subagentCount,
    reviewSubagentCount: settings.reviewSubagentCount,
    subagentProviderId: settings.subagentProviderId,
    subagentModelId: settings.subagentModelId,
    translationSplitSize: settings.splitSize,
    folderTranslationOrder: settings.folderTranslationOrder,
    folderSourceDocuments: defaults.folderSourceDocuments,
    proofreadMode: settings.proofreadMode,
    proofreadSplitSize: settings.splitSize,
    proofreadMontecarloSize: settings.montecarloSize,
    proofreadMontecarloRoundMin: settings.montecarloRoundMin,
    proofreadMontecarloRoundMax: settings.montecarloRoundMax
  };
  const agentHost = window.__ynAgentChatPiWebEmbedded;
  if (agentHost?.replaceText) {
    await agentHost.replaceText(promptText, workflowMetadata);
  } else if (agentHost?.insertText) {
    await agentHost.insertText(promptText, workflowMetadata);
  } else {
    throw new Error("Agent embedded host is unavailable.");
  }
}
function ensureAgentMessageInput() {
  if (!promptPreview.value) {
    activePromptKind = "translate";
    promptPreview.value = activeAgentPrompts().translate || "";
  }
  return promptPreview.value;
}
function setPromptText(text) {
  promptPreview.value = text || "";
}
function activeAgentPrompts() {
  return workflow.prompts || {};
}
function auditWhitelistPathLabel() {
  const outputDir = workflow.paths?.outputDir || "";
  if (!outputDir || outputDir.startsWith("[")) return ".translation-workshop/audit-whitelist.json";
  return outputDir.replace(/[\\/]$/, "") + "/.translation-workshop/audit-whitelist.json";
}
function auditWhitelistLines() {
  return Object.keys(state.auditWhitelist || {}).map(Number).filter(line => Number.isInteger(line) && line > 0).sort((left, right) => left - right);
}
const syncDbName = "translation-workshop-html-cache";
const syncStoreName = "line-sync-v1";
const syncTextKey = key + ":translation-text";
// Bump when embedded prompts or prompt-related HTML behavior changes; old HTML will auto-upgrade.
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
document.getElementById("resetPromptSettings")?.addEventListener("click", () => {
  void resetPromptSettings();
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
      await openAgentChatForPrompt();
      setAiStatus(data.labels.reviewFormatFallback || "The AI report failed format validation. A repair prompt was generated.");
      return;
    }
    setAiStatus((data.labels.reviewGenerated || "Review HTML generated") + ": " + (result?.outputPath || "") + " (" + (result?.proposalCount || 0) + ")");
    if (result?.outputPath && bridge.openReviewHtml) {
      if (bridge.updateProjectState) {
        await bridge.updateProjectState({
          outputDir,
          patch: {
            lastHtml: result.outputPath,
            lastOutput: result.outputPath,
            lastProposalReviewHtml: result.outputPath,
            reportPath: result.reportPath || reportPath,
            lineReviewPath: result.lineReviewPath || currentLineReviewPath()
          }
        });
      }
      await bridge.openReviewHtml({ htmlPath: result.outputPath, outputDir });
    }
  } catch (error) {
    setAiStatus((data.labels.reviewGenerationFailed || "Review HTML generation failed") + ": " + (error?.message || String(error)));
  }
}
document.getElementById("generateReviewHtml")?.addEventListener("click", () => generateReviewHtmlFromReport());
document.getElementById("copyPrompt")?.addEventListener("click", async () => {
  ensureAgentMessageInput();
  promptPreview.select();
  try {
    await navigator.clipboard.writeText(promptPreview.value);
  } catch {
    document.execCommand("copy");
  }
  setAiStatus(data.labels.copied || "Copied");
});
function invokeBridge() {
  return window.workshopHtml || window.parent?.workshopHtml || window.workshop || window.parent?.workshop;
}
let agentInterfacePublishFrame = 0;
let agentRowMenu = null;
let agentSelectedSourceText = "";
function renderedRowFromPoint(y) {
  const main = document.querySelector(".line-review-main");
  const rect = main?.getBoundingClientRect();
  if (!rect) return null;
  const x = Math.max(rect.left + 8, Math.min(rect.right - 8, rect.left + rect.width / 2));
  return document.elementFromPoint(x, y)?.closest?.(".row") || null;
}
function visibleLineRange() {
  const main = document.querySelector(".line-review-main");
  const rect = main?.getBoundingClientRect();
  const rows = Array.from(rowsEl.querySelectorAll(".row"));
  if (!rect || rows.length === 0) return {};
  const first = renderedRowFromPoint(Math.max(0, rect.top) + 8) || rows[0];
  const last = renderedRowFromPoint(Math.min(window.innerHeight, rect.bottom) - 8) || rows[rows.length - 1];
  return {
    visibleLineStart: Number(first?.dataset.line || 0) || undefined,
    visibleLineEnd: Number(last?.dataset.line || 0) || undefined
  };
}
function focusedInterfaceLine() {
  const line = Number(activeLine || 0);
  if (!line) return undefined;
  const row = data.rows.find(item => Number(item.line) === line);
  if (!row) return undefined;
  return {
    line,
    source: row.source || "",
    translation: rowValue(row),
    status: state.status[line] || row.status || "",
    selectedSourceText: agentSelectedSourceText || undefined
  };
}
async function publishAgentInterfaceContext() {
  const bridge = invokeBridge();
  const outputDir = String(workflow.paths?.outputDir || "").trim();
  if (!bridge?.publishAgentInterfaceContext || !outputDir || outputDir.startsWith("[")) return;
  const main = document.querySelector(".line-review-main");
  try {
    const result = await bridge.publishAgentInterfaceContext({
      version: 1,
      outputDir,
      htmlPath: currentHtmlPath(),
      pageKind: "line-review",
      sourcePath: workflow.paths?.sourcePath || "",
      translationPath: boundTranslationPath() || workflow.paths?.translationPath || "",
      page,
      pageSize,
      scrollTop: main?.scrollTop || window.scrollY || 0,
      activeLine: Number(activeLine || 0) || undefined,
      ...visibleLineRange(),
      focusedLine: focusedInterfaceLine(),
      updatedAt: Date.now()
    });
    if (!result?.ok) throw new Error(result?.message || "YN interface context was rejected.");
  } catch (error) {
    console.warn("translation-workshop could not publish YN interface context", error);
  }
}
function scheduleAgentInterfaceContextPublish() {
  if (agentInterfacePublishFrame) return;
  agentInterfacePublishFrame = requestAnimationFrame(() => {
    agentInterfacePublishFrame = 0;
    void publishAgentInterfaceContext();
  });
}
function closeAgentRowMenu() {
  agentRowMenu?.remove();
  agentRowMenu = null;
}
function sourceSelectionText(sourceElement) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const selectionRange = selection.getRangeAt(0);
  if (!selectionRange.intersectsNode(sourceElement)) return "";
  const sourceRange = document.createRange();
  sourceRange.selectNodeContents(sourceElement);
  if (selectionRange.comparePoint(sourceElement, 0) < 0) {
    sourceRange.setStart(selectionRange.startContainer, selectionRange.startOffset);
  }
  if (selectionRange.comparePoint(sourceElement, sourceElement.childNodes.length) > 0) {
    sourceRange.setEnd(selectionRange.endContainer, selectionRange.endOffset);
  }
  return sourceRange.toString().trim();
}
function askAgentAboutRow(rowElement, selectedSourceText = "") {
  const line = Number(rowElement?.dataset.line || 0);
  const row = data.rows.find(item => Number(item.line) === line);
  if (!row) return;
  activeLine = String(line);
  agentSelectedSourceText = selectedSourceText;
  save([Number(line)]);
  scheduleAgentInterfaceContextPublish();
  const prompt = selectedSourceText
    ? data.locale === "en-US"
      ? "Please check this source excerpt I deliberately selected against the current YN page and adjacent context, answer my translation question, and suggest a better translation when needed:\\n\\n" + selectedSourceText
      : "请结合当前 YN 页面和相邻上下文检查以下我主动选择的原文片段，回答我的翻译问题；如有必要，请给出更合适的译文：\\n\\n" + selectedSourceText
    : data.locale === "en-US"
      ? "Please read the line I just selected in the current YN page, check its translation against the adjacent context, and suggest a better translation when needed."
      : "请读取我刚刚在当前 YN 页面选中的行，结合相邻上下文检查翻译；如有必要，请给出更合适的译文。";
  const embedded = window.__ynAgentChatPiWebEmbedded || window.parent?.__ynAgentChatPiWebEmbedded;
  if (embedded?.insertText) {
    void Promise.resolve(embedded.insertText(prompt));
    return;
  }
  invokeBridge()?.openAgentChatWindow?.({
    outputDir: workflow.paths?.outputDir,
    locale: data.locale,
    languagePair: promptSettingsValue().languagePair,
    lineReviewPath: currentLineReviewPath(),
    sourcePath: workflow.paths?.sourcePath,
    translationPath: boundTranslationPath() || workflow.paths?.translationPath,
    initialPrompt: prompt
  });
}
rowsEl.addEventListener("contextmenu", (event) => {
  const source = event.target.closest?.(".source");
  if (!source) return;
  event.preventDefault();
  closeAgentRowMenu();
  const row = source.closest(".row");
  const selectedSourceText = sourceSelectionText(source);
  agentRowMenu = document.createElement("div");
  agentRowMenu.className = "yn-agent-row-menu";
  agentRowMenu.style.left = Math.min(event.clientX, window.innerWidth - 230) + "px";
  agentRowMenu.style.top = Math.min(event.clientY, window.innerHeight - 52) + "px";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = selectedSourceText
    ? data.labels.askAgentSelection || "Send selected source to Agent"
    : data.labels.askAgentTranslation || "Ask Agent about this translation";
  button.addEventListener("click", () => {
    closeAgentRowMenu();
    askAgentAboutRow(row, selectedSourceText);
  });
  agentRowMenu.appendChild(button);
  document.body.appendChild(agentRowMenu);
});
document.addEventListener("pointerdown", (event) => {
  if (agentRowMenu && !agentRowMenu.contains(event.target)) {
    closeAgentRowMenu();
    if (agentSelectedSourceText) {
      agentSelectedSourceText = "";
      scheduleAgentInterfaceContextPublish();
    }
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAgentRowMenu();
});
document.querySelector(".line-review-main")?.addEventListener("scroll", () => {
  closeAgentRowMenu();
  scheduleAgentInterfaceContextPublish();
}, { passive: true });
document.addEventListener("visibilitychange", scheduleAgentInterfaceContextPublish);
const agentInterfaceHeartbeat = window.setInterval(scheduleAgentInterfaceContextPublish, 2000);
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
  if (lanSyncToken || lanSyncStarting || lanSyncStopping) return;
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
  lanSyncStarting = true;
  try {
    const result = await bridge.startLanSync({
      pin,
      htmlPath: currentHtmlPath(),
      outputDir: workflow.paths?.outputDir || "",
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
  } finally {
    lanSyncStarting = false;
  }
}
function reportLineReviewPersistFailure(error) {
  const message = error?.message || String(error);
  console.error("translation-workshop failed to persist a line-review edit", error);
  setAiStatus((data.labels.lanSyncFailed || "LAN sync failed") + ": " + message);
}
function persistLineReviewPatch(patch) {
  const line = Number(patch?.line || 0);
  let request;
  if (lanSyncToken) {
    try {
      storeLineReviewStateLocally();
    } catch (error) {
      reportLineReviewPersistFailure(error);
    }
    request = queueLanSyncPatch(patch);
  } else {
    request = save(line > 0 ? [line] : []);
  }
  void Promise.resolve(request).catch(reportLineReviewPersistFailure);
  return request;
}
async function dispatchPendingLanSyncPatch(key) {
  const pending = lanSyncPendingPatches.get(key);
  if (!pending) return;
  lanSyncPendingPatches.delete(key);
  clearTimeout(pending.timer);
  try {
    const result = await pending.bridge.sendLanSyncPatch({
      token: pending.token,
      patch: { ...pending.patch, clientId: "desktop", timestamp: new Date().toISOString() }
    });
    if (!result?.ok) throw new Error("The Electron host rejected the LAN edit.");
    for (const waiter of pending.waiters) waiter.resolve(result);
  } catch (error) {
    for (const waiter of pending.waiters) waiter.reject(error);
    throw error;
  }
}
function flushPendingLanSyncPatches() {
  return Promise.all([...lanSyncPendingPatches.keys()].map(dispatchPendingLanSyncPatch));
}
function queueLanSyncPatch(patch) {
  if (lanSyncStopping) return Promise.reject(new Error("LAN sync is stopping; wait for it to finish before editing."));
  if (!lanSyncToken) return Promise.reject(new Error("LAN sync is not active."));
  const bridge = invokeBridge();
  if (!bridge?.sendLanSyncPatch) return Promise.reject(new Error("LAN sync is unavailable in this window."));
  const line = Number(patch.line || 0);
  const key = String(line);
  return new Promise((resolve, reject) => {
    const previous = lanSyncPendingPatches.get(key);
    if (previous) clearTimeout(previous.timer);
    const pending = {
      token: lanSyncToken,
      bridge,
      patch,
      waiters: [...(previous?.waiters || []), { resolve, reject }],
      timer: 0
    };
    pending.timer = setTimeout(() => {
      void dispatchPendingLanSyncPatch(key).catch(reportLineReviewPersistFailure);
    }, patch.type === "line-edit" ? 250 : 0);
    lanSyncPendingPatches.set(key, pending);
  });
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
  const target = rowsEl.querySelector('.row[data-line="' + line + '"] .target');
  if (target && document.activeElement !== target) {
    target.textContent = rowValue({ line });
  }
  changedCount.textContent = Object.keys(state.edits).length;
}
function applyRemoteLanSyncCommand(payload) {
  if (!payload || payload.token !== lanSyncToken) return;
  if (payload.command?.type !== "open-agent-os") return;
  window.__ynAgentChatPiWebEmbedded?.open?.();
}
invokeBridge()?.onLanSyncPatch?.(applyRemoteLanSyncPatch);
invokeBridge()?.onLanSyncCommand?.(applyRemoteLanSyncCommand);

// --- Agent translation artifacts: discovery + line-aligned import draft ----
// Per RFC 5.4: agent initial-translation writes a candidate TXT under
// AI_translation/. The host discovers it, runs the deterministic validator,
// and lets the user import it as a DRAFT (line-review localStorage edits only).
// Import never overwrites the bound translation TXT. On blocking errors the
// import button is replaced by a repair entry point.
const agentArtifactsPanel = document.getElementById("agentArtifactsPanel");
const agentArtifactsList = document.getElementById("agentArtifactsList");
const agentArtifactsStatus = document.getElementById("agentArtifactsStatus");
const refreshAgentArtifactsButton = document.getElementById("refreshAgentArtifacts");

function setArtifactStatus(text) {
  if (agentArtifactsStatus) agentArtifactsStatus.textContent = text || "";
}

function artifactValidationBadge(validation) {
  if (!validation) return "";
  if (validation.ok) {
    const w = validation.warnings.length;
    const okLabel = data.labels.artifactOkBadge || "OK";
    const warnLabel = data.labels.artifactWarningBadge || "warnings";
    const warnSpan = w > 0 ? '<span class="artifact-badge warn">' + w + ' ' + warnLabel + '</span>' : "";
    return '<span class="artifact-badge ok">' + escapeHtml(okLabel) + '</span>' + warnSpan;
  }
  const blockLabel = data.labels.artifactBlockingBadge || "blocking";
  return '<span class="artifact-badge block">' + validation.blocking.length + ' ' + escapeHtml(blockLabel) + '</span>';
}

function artifactCardHtml(artifact, validation) {
  const source = artifact.sourcePath || "";
  const sourceLabel = data.labels.artifactSourceLabel || "Source";
  const sourceLine = source
    ? '<div class="artifact-meta">' + escapeHtml(sourceLabel) + ': ' + escapeHtml(source) + '</div>'
    : '<div class="artifact-meta warn">' + escapeHtml(data.labels.artifactSourceUnmatched || "Source not matched") + '</div>';
  const blockingList = (validation?.blocking || []).map(function (f) { return '<li>' + escapeHtml(f.detail) + '</li>'; }).join("");
  const warningList = (validation?.warnings || []).slice(0, 8).map(function (f) { return '<li>' + escapeHtml(f.detail) + '</li>'; }).join("");
  const canImport = validation?.ok && !!source;
  const importBtn = canImport
    ? '<button type="button" class="primary artifact-import" data-path="' + escapeHtml(artifact.path) + '" data-source="' + escapeHtml(source) + '">' + escapeHtml(data.labels.importAsDraft || "Import as draft") + '</button>'
    : '<button type="button" class="artifact-repair" data-path="' + escapeHtml(artifact.path) + '">' + escapeHtml(data.labels.openRepair || "Jump to issue line") + '</button>';
  const repairBtn = !validation?.ok
    ? '<button type="button" class="artifact-repair-prompt" data-path="' + escapeHtml(artifact.path) + '" data-source="' + escapeHtml(source) + '">' + escapeHtml(data.labels.generateRepairPrompt || "Generate repair prompt") + '</button>'
    : "";
  const openBtn = '<button type="button" class="artifact-open" data-path="' + escapeHtml(artifact.path) + '">' + escapeHtml(data.labels.openArtifact || "Open artifact") + '</button>';
  const blockingUl = blockingList ? '<ul class="artifact-blocking">' + blockingList + '</ul>' : "";
  const warningUl = warningList ? '<ul class="artifact-warnings">' + warningList + '</ul>' : "";
  return '<article class="artifact-card">'
    + '<header><strong>' + escapeHtml(artifact.basename) + '</strong> ' + artifactValidationBadge(validation) + '</header>'
    + '<div class="artifact-meta">' + escapeHtml(artifact.path) + '</div>'
    + sourceLine
    + blockingUl
    + warningUl
    + '<div class="artifact-actions">' + importBtn + repairBtn + openBtn + '</div>'
    + '</article>';
}

const artifactValidations = new Map();

function artifactLanguagePair() {
  return promptSettingsValue().languagePair || workflow.promptDefaults?.languagePair || "ja->zh-CN";
}

async function discoverAgentArtifacts() {
  if (!agentArtifactsPanel) return;
  agentArtifactsPanel.hidden = false;
  const bridge = invokeBridge();
  if (!bridge?.discoverAgentArtifacts) {
    setArtifactStatus(data.labels.artifactsBridgeMissing || "Open this HTML inside translation-workshop to discover agent artifacts.");
    if (agentArtifactsList) agentArtifactsList.innerHTML = "";
    return;
  }
  const projectDir = workflow.paths?.outputDir || "";
  if (!projectDir || (projectDir.startsWith("[") && projectDir.endsWith("]"))) {
    setArtifactStatus(data.labels.artifactsNeedOutputDir || "Set an output folder to discover agent artifacts.");
    if (agentArtifactsList) agentArtifactsList.innerHTML = "";
    return;
  }
  setArtifactStatus(data.labels.scanningArtifacts || "Scanning for agent artifacts…");
  artifactValidations.clear();
  try {
    const sourcePath = workflow.paths?.validationSourcePath || workflow.paths?.sourcePath || "";
    const locale = data.locale || document.documentElement.lang || "zh-CN";
    const artifacts = await bridge.discoverAgentArtifacts({
      projectDir,
      sourcePaths: sourcePath ? [sourcePath] : []
    });
    if (artifacts.length === 0) {
      setArtifactStatus(data.labels.noArtifacts || "No candidate translation artifacts found under AI_translation/.");
      if (agentArtifactsList) agentArtifactsList.innerHTML = "";
      return;
    }
    setArtifactStatus(String(data.labels.artifactsRescanned || "Rescanned {count} artifact(s) from disk.").replace("{count}", String(artifacts.length)));
    if (agentArtifactsList) agentArtifactsList.innerHTML = "";
    for (const artifact of artifacts) {
      let validation = null;
      if (artifact.sourcePath) {
        try {
          validation = await bridge.validateAgentArtifact({
            projectDir,
            sourcePath: artifact.sourcePath,
            candidatePath: artifact.path,
            locale,
            languagePair: artifactLanguagePair(),
            glossaryPath: boundGlossaryPath() || undefined
          });
        } catch (error) {
          validation = {
            ok: false,
            blocking: [{ detail: (data.labels.artifactValidationFailed || "Validation failed") + ": " + (error?.message || String(error)) }],
            warnings: []
          };
        }
      }
      artifactValidations.set(artifact.path, validation);
      const card = document.createElement("div");
      card.innerHTML = artifactCardHtml(artifact, validation);
      agentArtifactsList.appendChild(card.firstChild);
    }
  } catch (error) {
    setArtifactStatus((data.labels.artifactScanFailed || "Artifact scan failed") + ": " + (error?.message || String(error)));
  }
}

async function importArtifactAsDraft(candidatePath, sourcePath) {
  const bridge = invokeBridge();
  if (!bridge?.buildAgentImportPlan) return;
  setAiStatus(data.labels.importingDraft || "Importing candidate as draft…");
  try {
    const plan = await bridge.buildAgentImportPlan({
      projectDir: workflow.paths?.outputDir || "",
      sourcePath,
      candidatePath,
      locale: data.locale || "zh-CN",
      languagePair: artifactLanguagePair(),
      glossaryPath: boundGlossaryPath() || undefined
    });
    if (!plan.ok) {
      setAiStatus((data.labels.importBlocked || "Import blocked by validation") + ": " + (plan.validation.blocking[0]?.detail || ""));
      return;
    }
    const importedLines = [];
    for (const line in plan.edits) {
      state.edits[line] = String(plan.edits[line] ?? "");
      state.status[line] = plan.status[line] || "machine";
      importedLines.push(Number(line));
    }
    save(importedLines);
    render();
    if (/\.txt$/i.test(candidatePath)) {
      const sourceIsEpub = /\.epub$/i.test(workflow.paths?.sourcePath || "");
      if (sourceIsEpub && workflow.paths?.editableTranslationPath) {
        state.translationPath = workflow.paths.editableTranslationPath;
      }
      setBoundTranslationPath(candidatePath, candidatePath, { userSelected: true });
    } else {
      updateSaveTxtVisibility();
    }
    setAiStatus((data.labels.importedDraft || "Imported as draft") + " " + String(data.labels.importedDraftNote || "({count} lines).").replace("{count}", String(plan.lineCount)));
  } catch (error) {
    setAiStatus((data.labels.importFailed || "Import failed") + ": " + (error?.message || String(error)));
  }
}

function openLineRepair(candidatePath) {
  const validation = artifactValidations.get(candidatePath);
  const firstLine = (validation?.blocking || []).find(function (finding) {
    return Number.isInteger(finding.line) && finding.line > 0;
  });
  if (firstLine?.line && jumpToLine(firstLine.line)) {
    setAiStatus(String(data.labels.repairJumpedToLine || "Jumped to line {line}").replace("{line}", String(firstLine.line)));
    return;
  }
  const sourceCount = validation?.sourceLineCount;
  const candidateCount = validation?.candidateLineCount;
  if (sourceCount && candidateCount && sourceCount !== candidateCount) {
    setAiStatus(String(data.labels.repairLineCountHint || "Line count mismatch")
      .replace("{source}", String(sourceCount))
      .replace("{candidate}", String(candidateCount)));
    return;
  }
  setAiStatus(validation?.blocking?.[0]?.detail || data.labels.importBlocked || "Import blocked");
}

async function generateRepairPrompt(candidatePath, sourcePath) {
  const bridge = invokeBridge();
  if (!bridge?.buildAgentRepairPrompt) return;
  try {
    const prompt = await bridge.buildAgentRepairPrompt({
      projectDir: workflow.paths?.outputDir || "",
      sourcePath,
      candidatePath,
      locale: data.locale || "zh-CN"
    });
    setPromptText(prompt);
    await openAgentChatForPrompt();
    setAiStatus(data.labels.repairPromptReady || "Repair prompt ready in the prompt box.");
  } catch (error) {
    setAiStatus((data.labels.repairPromptFailed || "Repair prompt generation failed") + ": " + (error?.message || String(error)));
  }
}

agentArtifactsList?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const path = target.getAttribute("data-path") || "";
  const source = target.getAttribute("data-source") || "";
  if (target.classList.contains("artifact-import")) {
    void importArtifactAsDraft(path, source);
  } else if (target.classList.contains("artifact-repair")) {
    openLineRepair(path);
  } else if (target.classList.contains("artifact-repair-prompt")) {
    void generateRepairPrompt(path, source);
  } else if (target.classList.contains("artifact-open")) {
    invokeBridge()?.openPath?.(path).catch(() => {});
  }
});

refreshAgentArtifactsButton?.addEventListener("click", () => { void discoverAgentArtifacts(); });

// Discover on demand via Refresh — avoid blocking every line-review open.
// --- end agent translation artifacts ----------------------------------------

startLanSyncButton?.addEventListener("click", () => { void startLanSync(); });
copyLanSyncLinkButton?.addEventListener("click", () => {
  if (!lanSyncPrimaryUrl) return;
  navigator.clipboard?.writeText(lanSyncPrimaryUrl).then(() => setAiStatus(data.labels.copied || "Copied")).catch(() => {});
});
stopLanSyncButton?.addEventListener("click", async () => {
  if (lanSyncStopping || lanSyncStarting) return;
  lanSyncStopping = true;
  const token = lanSyncToken;
  try {
    await flushPendingLanSyncPatches();
    if (token) {
      const result = await invokeBridge()?.stopLanSync?.(token);
      if (result && result.ok === false) throw new Error("The Electron host could not stop LAN sync.");
    }
    lanSyncToken = "";
    lanSyncPanel.hidden = true;
    setAiStatus(data.labels.lanSyncStopped || "LAN sync stopped");
  } catch (error) {
    reportLineReviewPersistFailure(error);
  } finally {
    lanSyncStopping = false;
  }
});
async function syncLines(lines, label) {
  syncedLines = lines;
  delete state.synced;
  let importedCount = 0;
  const synchronizedLines = [];
  for (let index = 0; index < data.rows.length; index += 1) {
    const lineNo = data.rows[index].line;
    if (lines[index] !== undefined && state.status[lineNo] !== "manual") {
      delete state.edits[lineNo];
      delete state.status[lineNo];
      importedCount += 1;
      synchronizedLines.push(lineNo);
    }
  }
  state.syncedFile = label;
  state.syncedAt = new Date().toISOString();
  save(synchronizedLines, ["syncedFile", "syncedAt"]);
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
    setBoundTranslationPath(nextPath, nextPath, { userSelected: true });
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
  return state.translationPath || workflow.paths?.editableTranslationPath || workflow.paths?.translationPath || "";
}
function canWriteBoundTxt() {
  const path = boundTranslationPath();
  return Boolean(path && !path.startsWith("[") && /\.txt$/i.test(path));
}
function updateSaveTxtVisibility() {
  const button = document.getElementById("saveTxt");
  if (!button) return;
  button.hidden = !canWriteBoundTxt();
}
function ensureSaveTxtButton() {
  if (document.getElementById("saveTxt")) return;
  const exportBtn = document.getElementById("exportTxt");
  if (!exportBtn) return;
  const button = document.createElement("button");
  button.id = "saveTxt";
  button.type = "button";
  button.hidden = true;
  button.textContent = data.labels.saveTxt || "Save TXT";
  exportBtn.insertAdjacentElement("afterend", button);
  button.addEventListener("click", () => { void writeCurrentTranslationFile(); });
}
function isExtractedWorkshopTranslationPath(filePath) {
  const value = String(filePath || "").trim().replace(/\\/g, "/");
  return Boolean(value) && /\/\.translation-workshop\/extracted-text\/[^/]+\/translation\//i.test(value);
}
function projectTranslationBindingPath() {
  return String(projectTranslationPath || "").trim();
}
function boundPromptTranslationPath() {
  const projectPath = projectTranslationBindingPath();
  if (projectPath) {
    if (/\.epub$/i.test(projectPath)) return workflow.paths?.promptTranslationPath || "";
    if (workflow.paths?.promptSourceKind === "folder") return projectPath;
    return projectPath;
  }
  if (workflow.paths?.promptSourceKind === "folder") {
    const folderPath = workflow.paths?.promptTranslationPath || "";
    return isExtractedWorkshopTranslationPath(folderPath) ? "" : folderPath;
  }
  const selected = state.translationPromptPath || workflow.paths?.promptTranslationPath || "";
  if (selected && !isExtractedWorkshopTranslationPath(selected)) return selected;
  return "";
}
function applyProjectTranslationBinding(value) {
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "translationPath")) return;
  const nextPath = String(value.translationPath || "").trim();
  const origin = value.translationBindingOrigin === "user" || value.translationBindingOrigin === "canonical"
    ? value.translationBindingOrigin
    : "";
  projectTranslationPath = nextPath;
  projectTranslationOrigin = origin;
  const paths = workflowPaths();
  if (origin === "user" && nextPath) {
    paths.translationPath = nextPath;
    if (!/\.epub$/i.test(nextPath)) paths.promptTranslationPath = nextPath;
    state.translationPromptPath = paths.promptTranslationPath || nextPath;
  } else if (origin === "canonical" && nextPath) {
    paths.translationPath = nextPath;
    paths.promptTranslationPath = nextPath;
    state.translationPromptPath = nextPath;
  } else if (!nextPath) {
    if (isExtractedWorkshopTranslationPath(paths.promptTranslationPath)) paths.promptTranslationPath = "";
    if (isExtractedWorkshopTranslationPath(state.translationPromptPath)) state.translationPromptPath = "";
    if (isExtractedWorkshopTranslationPath(paths.translationPath)) paths.translationPath = "";
  }
}
function workflowPaths() {
  workflow.paths ||= {};
  return workflow.paths;
}
async function persistProjectState(patch) {
  const outputDir = workflow.paths?.outputDir || "";
  const bridge = writeBridge();
  if (!outputDir) return;
  if (!bridge?.updateProjectState) {
    throw new Error("Project settings bridge is unavailable.");
  }
  await bridge.updateProjectState({ outputDir, patch });
}
function updateProjectState(patch) {
  void persistProjectState(patch).catch((error) => {
    setAiStatus((data.labels.projectStateSaveFailed || "Project state save failed") + ": " + (error?.message || String(error)));
  });
}
function setBoundTranslationPath(path, promptPath, options) {
  const value = String(path || "").trim();
  if (!value) return;
  const promptValue = String(promptPath || value).trim();
  const userSelected = Boolean(options?.userSelected);
  const extracted = isExtractedWorkshopTranslationPath(value);
  state.translationPath = value;
  const paths = workflowPaths();
  paths.editableTranslationPath = value;
  if (userSelected || !extracted) {
    state.translationPromptPath = promptValue;
    paths.translationPath = value;
    paths.promptTranslationPath = extracted ? promptValue : value;
    save([], ["translationPath", "translationPromptPath"]);
    updateProjectState({
      translationPath: value,
      translationBindingOrigin: "user",
      promptTranslationPath: paths.promptTranslationPath
    });
  } else {
    save([], ["translationPath", "translationPromptPath"]);
  }
  updateSaveTxtVisibility();
}
function writeBridge() {
  return window.workshopHtml || window.parent?.workshopHtml;
}
const unsubscribeProjectState = writeBridge()?.onProjectStateUpdate?.((payload) => {
  if (normalizedProjectOutputDir(payload?.outputDir) !== normalizedProjectOutputDir(workflow.paths?.outputDir)) return;
  const nextProjectState = payload?.state || payload?.patch;
  const hasGlossaryPath = applyProjectPromptSettings(nextProjectState);
  if (hasGlossaryPath) {
    if (boundGlossaryPath()) void syncGlossaryFromBoundFile(false);
    else void hydrateProjectPromptSettings();
  }
});
window.addEventListener("beforeunload", () => unsubscribeProjectState?.(), { once: true });
void hydrateProjectPromptSettings();
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
    save([], ["savedTxtFile", "savedTxtAt"]);
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
    save([], ["savedEpubFile", "savedEpubAt"]);
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
      setBoundTranslationPath(filePath, filePath, { userSelected: true });
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
let glossaryTargets = {};
let glossaryAliasesByIndex = {};
const glossaryDrawer = document.getElementById("glossaryTools");
const glossaryBackdrop = document.getElementById("glossaryBackdrop");
const glossaryListEl = document.getElementById("glossaryList");
const glossaryCountEl = document.getElementById("glossaryCount");
const glossaryHelpEl = document.getElementById("glossaryHelp");
const glossarySearchEl = document.getElementById("glossarySearch");
const glossarySearchMetaEl = document.getElementById("glossarySearchMeta");
const importGeneratedGlossaryButton = document.getElementById("importGeneratedGlossary");
const glossaryRenderBatchSize = 120;
let glossaryVisibleCount = glossaryRenderBatchSize;
function setGlossaryDrawer(open) {
  glossaryDrawer?.classList.toggle("open", open);
  glossaryBackdrop?.classList.toggle("open", open);
  glossaryDrawer?.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) void refreshGeneratedGlossaryStatus();
}
document.getElementById("glossaryDrawerToggle")?.addEventListener("click", () => setGlossaryDrawer(true));
document.getElementById("glossaryDrawerClose")?.addEventListener("click", () => setGlossaryDrawer(false));
glossaryBackdrop?.addEventListener("click", () => setGlossaryDrawer(false));
function normalizedWorkspacePath(value) {
  return String(value || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase();
}
function applyGeneratedGlossaryStatus(status) {
  if (!importGeneratedGlossaryButton) return;
  const pending = Number(status?.pending?.glossaryCandidates || 0);
  const importable = Boolean(status?.actions?.importGlossaryCandidates && pending > 0);
  importGeneratedGlossaryButton.hidden = !importable;
  importGeneratedGlossaryButton.textContent = importable
    ? (data.labels.importGeneratedGlossary || "Import Agent glossary candidates") + " (" + pending + ")"
    : (data.labels.importGeneratedGlossary || "Import Agent glossary candidates");
}
async function refreshGeneratedGlossaryStatus() {
  const outputDir = workflow.paths?.outputDir || "";
  const bridge = writeBridge();
  if (!outputDir || outputDir.startsWith("[") || !bridge?.readWorkspaceAssetsStatus) {
    applyGeneratedGlossaryStatus(undefined);
    return;
  }
  try {
    applyGeneratedGlossaryStatus(await bridge.readWorkspaceAssetsStatus({ outputDir }));
  } catch (error) {
    setAiStatus((data.labels.generatedGlossaryImportFailed || "Agent glossary candidate import failed") + ": " + (error?.message || String(error)));
  }
}
async function importGeneratedGlossary() {
  const outputDir = workflow.paths?.outputDir || "";
  const bridge = writeBridge();
  if (!outputDir || outputDir.startsWith("[") || !bridge?.importGeneratedGlossaryCandidates) return;
  try {
    const result = await bridge.importGeneratedGlossaryCandidates({ outputDir });
    const glossary = result?.assets?.glossary;
    const glossaryPath = result?.assets?.paths?.glossary || "";
    if (glossaryPath) await adoptBoundGlossaryPath(glossaryPath);
    if (!syncGlossaryFromText(JSON.stringify(glossary || { entries: [] }), glossaryPath || "project glossary", true)) return;
    applyGeneratedGlossaryStatus({ pending: { glossaryCandidates: 0 }, actions: { importGlossaryCandidates: false } });
    setAiStatus((data.labels.generatedGlossaryImported || "Agent glossary candidates imported") + ": " + Number(result?.counts?.added || 0));
  } catch (error) {
    setAiStatus((data.labels.generatedGlossaryImportFailed || "Agent glossary candidate import failed") + ": " + (error?.message || String(error)));
  }
}
importGeneratedGlossaryButton?.addEventListener("click", () => { void importGeneratedGlossary(); });
const unsubscribeWorkspaceAssets = writeBridge()?.onWorkspaceAssetsStatus?.((payload) => {
  if (normalizedWorkspacePath(payload?.outputDir) !== normalizedWorkspacePath(workflow.paths?.outputDir)) return;
  applyGeneratedGlossaryStatus(payload?.status);
});
window.addEventListener("beforeunload", () => unsubscribeWorkspaceAssets?.(), { once: true });
const unsubscribeProjectAssets = writeBridge()?.onProjectAssetsUpdate?.((payload) => {
  if (normalizedWorkspacePath(payload?.outputDir) !== normalizedWorkspacePath(workflow.paths?.outputDir)) return;
  const glossaryPath = String(payload?.assets?.paths?.glossary || "").trim();
  const glossary = payload?.assets?.glossary;
  const boundPath = boundGlossaryPath();
  const canonicalGlossaryIsBound = !boundPath
    || normalizedWorkspacePath(boundPath) === normalizedWorkspacePath(glossaryPath);
  if (canonicalGlossaryIsBound && glossaryPath && glossary
    && syncGlossaryFromText(JSON.stringify(glossary), glossaryPath, true, false)) {
    setBoundGlossaryPath(glossaryPath);
  } else if (!payload?.assets && boundPath) {
    void syncGlossaryFromBoundFile(false);
  }
});
window.addEventListener("beforeunload", () => unsubscribeProjectAssets?.(), { once: true });
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
  const custom = glossaryTargets[index];
  return typeof custom === "string" ? custom : (glossaryEntries[index]?.target || "");
}
function glossaryAliases(index) {
  const aliases = glossaryAliasesByIndex[index];
  if (Array.isArray(aliases)) return aliases;
  return Array.isArray(glossaryEntries[index]?.aliases) ? glossaryEntries[index].aliases : [];
}
function currentGlossaryEntries() {
  return glossaryEntries.map((entry, index) => ({ ...entry, target: glossaryTarget(index), aliases: glossaryAliases(index) }))
    .filter(entry => entry.source && entry.target);
}
function boundGlossaryPath() {
  return projectGlossaryPath || workflow.paths?.glossaryPath || "";
}
function setBoundGlossaryPath(path) {
  const value = String(path || "").trim();
  if (!value) return;
  projectGlossaryPath = value;
  workflowPaths().glossaryPath = value;
}
async function adoptBoundGlossaryPath(path) {
  const value = String(path || "").trim();
  if (!value) throw new Error("Canonical glossary path is missing.");
  await persistProjectState({ glossaryPath: value });
  setBoundGlossaryPath(value);
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
function removeMechanicalAuditIssues(targetState, line) {
  const issues = Array.isArray(targetState.auditIssues?.[line]) ? targetState.auditIssues[line] : [];
  const next = issues.filter(issue => {
    const code = String(issue?.code || "").trim();
    const severity = String(issue?.severity || "").trim();
    const source = String(issue?.source || "").trim();
    return !(/^M0(?:-|$)/i.test(code) || /^M0$/i.test(severity) || source === "host-mechanical-scan");
  });
  targetState.auditIssues ||= {};
  if (next.length > 0) targetState.auditIssues[line] = next;
  else delete targetState.auditIssues[line];
}
async function toggleAuditWhitelistLine(line) {
  const previousWhitelist = { ...(state.auditWhitelist || {}) };
  const previousIssues = Array.isArray(state.auditIssues?.[line]) ? [...state.auditIssues[line]] : undefined;
  if (auditLineWhitelisted(line)) {
    delete state.auditWhitelist[line];
    recomputeAuditIssueForLine(line);
  } else {
    state.auditWhitelist[line] = true;
    removeMechanicalAuditIssues(state, line);
  }
  state.auditVisible = true;
  applyingCanonicalState = true;
  try {
    render();
  } finally {
    applyingCanonicalState = false;
  }
  try {
    await writeAuditWhitelistFile([line]);
  } catch (error) {
    state.auditWhitelist = previousWhitelist;
    state.auditIssues ||= {};
    if (previousIssues) state.auditIssues[line] = previousIssues;
    else delete state.auditIssues[line];
    applyingCanonicalState = true;
    try {
      render();
    } finally {
      applyingCanonicalState = false;
    }
    throw error;
  }
}
async function writeAuditWhitelistFile(changedLines = []) {
  const bridge = writeBridge();
  if (!bridge?.writeAuditWhitelistFile) {
    await save(changedLines, ["auditVisible"]);
    setAiStatus((data.labels.auditWhitelistWritten || "Audit whitelist written") + ": " + auditWhitelistPathLabel() + " (" + auditWhitelistLines().join(", ") + ")");
    return;
  }
  try {
    const result = await bridge.writeAuditWhitelistFile({
      outputDir: workflow.paths?.outputDir,
      sourcePath: workflow.paths?.sourcePath,
      lines: auditWhitelistLines(),
      lineReviewPath: data.lineReviewPath,
      lineState: state,
      changedLines
    });
    applyCanonicalLineReviewState(result);
    setAiStatus((data.labels.auditWhitelistWritten || "Audit whitelist written") + ": " + (result?.path || auditWhitelistPathLabel()));
  } catch (error) {
    setAiStatus((data.labels.auditWhitelistWriteFailed || "Audit whitelist write failed") + ": " + (error?.message || String(error)));
    throw error;
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
  save(data.rows.map(row => row.line));
  render();
  setAiStatus((data.labels.auditGlossaryFinished || "Term audit finished") + ": " + affectedLines + " lines / " + issueCount + " H3");
}
function applyGlossaryItems(scope, items) {
  let changedLines = 0;
  let replacementCount = 0;
  const changedLineNumbers = [];
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
      changedLineNumbers.push(lineNo);
    }
  }
  save(changedLineNumbers);
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
async function applyEditedGlossaryTerm(input) {
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
  const nextAliases = uniqueGlossaryTerms([...glossaryAliases(index), previousTarget, entry.target]).filter(term => term !== nextTarget);
  const bridge = writeBridge();
  const outputDir = workflow.paths?.outputDir || "";
  if (!outputDir || !bridge?.updateProjectGlossaryEntry) {
    input.value = previousTarget;
    input.dataset.currentTarget = previousTarget;
    setAiStatus(data.labels.glossaryWriteNeedsApp || "Open this HTML in translation-workshop to write glossary.");
    return;
  }
  try {
    const assets = await bridge.updateProjectGlossaryEntry({
      outputDir,
      boundGlossaryPath: boundGlossaryPath() || undefined,
      entry: {
        source: entry.source,
        target: nextTarget,
        aliases: nextAliases
      }
    });
    const glossaryPath = String(assets?.paths?.glossary || boundGlossaryPath()).trim();
    if (glossaryPath) await adoptBoundGlossaryPath(glossaryPath);
    if (!syncGlossaryFromText(JSON.stringify(assets?.glossary || { entries: [] }), glossaryPath || "project glossary", true)) {
      throw new Error("Canonical project glossary response could not be applied.");
    }
  } catch (error) {
    input.value = previousTarget;
    input.dataset.currentTarget = previousTarget;
    setAiStatus((data.labels.glossaryWriteFailed || "Glossary write failed") + ": " + (error?.message || String(error)));
    return;
  }
  const canonicalIndex = glossaryEntries.findIndex(item => String(item.source || "").trim().toLocaleLowerCase() === String(entry.source || "").trim().toLocaleLowerCase());
  const appliedIndex = canonicalIndex >= 0 ? canonicalIndex : index;
  const appliedEntry = glossaryEntries[appliedIndex] || entry;
  const fromText = previousTarget || entry.target || entry.source;
  const message = (data.labels.glossaryChangeConfirm || "Replace \"{from}\" with \"{to}\"? Manual rows will be skipped.")
    .replace("{from}", fromText)
    .replace("{to}", nextTarget);
  if (!confirm(message)) {
    setAiStatus(data.labels.glossaryChangeCancelled || "Glossary term updated without applying replacements.");
    return;
  }
  applyGlossaryItems("all", [{
    entry: appliedEntry,
    index: appliedIndex,
    target: nextTarget,
    candidates: replacementCandidatesForEntry(appliedEntry, appliedIndex, nextTarget, [previousTarget, entry.target])
  }]);
}
function cleanGlossaryTerm(value) {
  return String(value ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}
function entryFromGlossaryObject(value) {
  const source = cleanGlossaryTerm(value.source ?? value.src ?? value.original ?? value.term ?? value.from ?? value.ja ?? value.jp ?? value.key);
  const target = cleanGlossaryTerm(value.target ?? value.dst ?? value.translation ?? value.translated ?? value.to ?? value.zh ?? value.cn ?? value.value);
  if (!source || !target) return undefined;
  const aliases = Array.isArray(value.aliases)
    ? [...new Set(value.aliases.map(cleanGlossaryTerm).filter(Boolean))]
    : [];
  const info = cleanGlossaryTerm(value.info);
  const status = ["confirmed", "auto", "pending"].includes(value.status) ? value.status : undefined;
  return {
    source,
    target,
    ...(aliases.length ? { aliases } : {}),
    ...(info ? { info } : {}),
    ...(status ? { status } : {})
  };
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
function syncGlossaryFromText(text, label, allowEmpty = false, announce = true) {
  const parsed = parseGlossaryTextLocal(text);
  if (parsed.length === 0) {
    if (allowEmpty) {
      glossaryEntries = [];
      glossaryTargets = {};
      glossaryAliasesByIndex = {};
      renderGlossaryEntries();
      if (announce) setAiStatus((data.labels.glossarySynced || "Glossary synced") + ": " + label + " (0)");
      return true;
    }
    if (glossaryHelpEl) glossaryHelpEl.textContent = data.labels.glossaryEmpty || "No glossary loaded";
    if (announce) setAiStatus((data.labels.glossaryNoEntries || "No glossary entries parsed") + ": " + label);
    return false;
  }
  glossaryEntries = parsed;
  glossaryTargets = {};
  glossaryAliasesByIndex = {};
  renderGlossaryEntries();
  if (announce) setAiStatus((data.labels.glossarySynced || "Glossary synced") + ": " + label + " (" + parsed.length + ")");
  return true;
}
async function syncGlossaryFromBoundFile(announce = true) {
  const glossaryPath = boundGlossaryPath();
  const bridge = writeBridge();
  if (!glossaryPath) {
    if (announce) setAiStatus(data.labels.glossarySyncMissingTarget || "This HTML has no bound glossary file. Import a glossary first.");
    return;
  }
  if (!bridge?.readTextFile) {
    if (announce) setAiStatus((data.labels.glossaryWriteNeedsApp || "Open this HTML in translation-workshop to write glossary.") + ": " + glossaryPath);
    return;
  }
  try {
    const result = await bridge.readTextFile({ path: glossaryPath });
    const nextPath = result?.path || glossaryPath;
    if (syncGlossaryFromText(result?.text || "", nextPath, true, announce)) {
      setBoundGlossaryPath(nextPath);
    }
  } catch (error) {
    if (announce) setAiStatus((data.labels.glossaryReadFailed || "Glossary sync failed") + ": " + (error?.message || String(error)));
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
    const outputDir = workflow.paths?.outputDir || "";
    if (outputDir && bridge.importProjectGlossaryFile) {
      const assets = await bridge.importProjectGlossaryFile({ outputDir, path: filePath });
      const glossaryPath = String(assets?.paths?.glossary || "").trim();
      if (glossaryPath) await adoptBoundGlossaryPath(glossaryPath);
      if (syncGlossaryFromText(JSON.stringify(assets?.glossary || { entries: [] }), glossaryPath || filePath, true)) {
        if (!glossaryPath) setBoundGlossaryPath(filePath);
      }
      return;
    }
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
    return JSON.stringify({ entries }, null, 2);
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
  const outputDir = workflow.paths?.outputDir || "";
  if (!outputDir || !bridge?.replaceProjectGlossary) {
    setAiStatus((data.labels.glossaryWriteNeedsApp || "Open this HTML in translation-workshop to write glossary.") + ": " + glossaryPath);
    return;
  }
  try {
    const assets = await bridge.replaceProjectGlossary({ outputDir, entries: currentGlossaryEntries() });
    const projectPath = String(assets?.paths?.glossary || glossaryPath).trim();
    await adoptBoundGlossaryPath(projectPath);
    if (!syncGlossaryFromText(JSON.stringify(assets?.glossary || { entries: [] }), projectPath || "project glossary", true)) {
      throw new Error("Canonical project glossary response could not be applied.");
    }
    setAiStatus((data.labels.glossaryWritten || "Glossary written") + ": " + projectPath);
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
    void applyEditedGlossaryTerm(input);
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
addEventListener("beforeunload", () => {
  window.clearInterval(agentInterfaceHeartbeat);
  unsubscribeLineReviewState?.();
  state.page = page;
  state.scrollY = scrollY;
  state.activeLine = activeLine;
  storeLineReviewStateLocally();
});
render();
ensureSaveTxtButton();
updateSaveTxtVisibility();
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
${agentChatEmbedScript()}
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
  <meta name="translation-workshop-proposal-review" content="${PROPOSAL_REVIEW_PROTOCOL_MARKER}">
  <title>${escapeHtml(options.title)}</title>
  <style>${animeThemeCss("proposal")}</style>
</head>
<body class="anime-workbench proposal-review">
  <div class="proposal-review-shell">
  <div class="app">
    <aside>
      <h1>${t.reviewTitle}</h1>
      <p class="subtle">${escapeHtml(options.title)}</p>
      ${themeControlsHtml(t)}
      <label>${t.search}</label><input id="search" type="search">
      <label>${t.documentFilter}</label><select id="documentFilter"></select>
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
        <button class="btn primary" id="openAgentChat" type="button">${t.openAgentChat ?? "Agent chat"}</button>
        <button class="btn" id="agentChatPopout" type="button">${t.agentChatPopout ?? "New window"}</button>
        <button class="btn" id="agentChatPopoutBack" type="button" hidden>${t.back ?? "Back"}</button>
      </div>
      <div id="conflictSummary" class="conflict-summary" hidden></div>
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
  ${agentChatEmbedHtml(t)}
  </div>
  <script id="proposalData" type="application/json">${jsonScript({ proposals: options.proposals, pageSize: firstPage.pageSize, startPage: firstPage.page, labels: t, locale, outputDir: options.outputDir ?? "", reportPath: options.reportPath ?? "", lineReviewPath: options.lineReviewPath ?? "" })}</script>
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
let proposalApplyInFlight;
const proposalApplyTrace = [];
window.__ynProposalApplyTrace = proposalApplyTrace;
function traceProposalApply(type, detail = {}) {
  proposalApplyTrace.push({ type, at: Date.now(), ...detail });
  if (proposalApplyTrace.length > 80) proposalApplyTrace.splice(0, proposalApplyTrace.length - 80);
}
let page = state.page || data.startPage || 1;
const pageSize = data.pageSize || 1000;
const cards = document.getElementById("cards");
const pageInput = document.getElementById("pageInput");
const pageInfo = document.getElementById("pageInfo");
const proposalStatus = document.getElementById("proposalStatus");
const searchInput = document.getElementById("search");
const documentFilter = document.getElementById("documentFilter");
const issueFilter = document.getElementById("issueFilter");
const conflictSummary = document.getElementById("conflictSummary");
const startLanSyncButton = document.getElementById("startLanSync");
const lanSyncPinInput = document.getElementById("lanSyncPin");
const lanSyncPanel = document.getElementById("lanSyncPanel");
const lanSyncLinks = document.getElementById("lanSyncLinks");
const copyLanSyncLinkButton = document.getElementById("copyLanSyncLink");
const stopLanSyncButton = document.getElementById("stopLanSync");
let lanSyncToken = "";
let lanSyncPrimaryUrl = "";
let lanSyncStarting = false;
let lanSyncStopping = false;
const lanSyncPendingPatches = new Map();
function escapeHtml(text) { return String(text ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function storeProposalStateLocally() {
  state.page = page;
  state.scrollY = scrollY;
  state.documentFilter = activeDocumentFilter();
  state.issueFilter = activeIssueFilter();
  localStorage.setItem(key, JSON.stringify(state));
}
function reportProposalStateSaveFailure(error) {
  console.warn("translation-workshop could not persist proposal UI state", error);
  setProposalStatus((data.labels.lanSyncFailed || "Save failed") + ": " + (error?.message || String(error)));
}
function save() {
  try {
    storeProposalStateLocally();
  } catch (error) {
    reportProposalStateSaveFailure(error);
  }
  try {
    const request = htmlBridge()?.persistHtmlState?.({ kind: "proposal", state });
    if (request) void Promise.resolve(request).then(result => {
      if (result?.ok === false) throw new Error("The Electron host rejected the proposal state write.");
    }).catch(reportProposalStateSaveFailure);
  } catch (error) {
    reportProposalStateSaveFailure(error);
  }
}
setTimeout(save, 0);
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
function proposalDocumentKey(item) {
  return String(item?.documentId || item?.sourcePath || "").trim().replace(/\\/g, "/");
}
function proposalDocumentLabel(item) {
  const documentId = String(item?.documentId || "").trim();
  if (documentId) return documentId.replace(/\\/g, "/");
  const sourcePath = String(item?.sourcePath || "").trim().replace(/\\/g, "/");
  return sourcePath ? sourcePath.split("/").pop() : (data.labels.allDocuments || "All documents");
}
function groupProposalsByDocument(items = data.proposals) {
  const groups = new Map();
  for (const item of items) {
    const key = proposalDocumentKey(item) || "__single__";
    const group = groups.get(key) || { key, label: proposalDocumentLabel(item), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function documentFilterOptions() {
  return [{ key: "", label: data.labels.allDocuments || "All documents" }, ...groupProposalsByDocument()
    .map(group => ({ key: group.key, label: group.label }))
    .sort((left, right) => left.label.localeCompare(right.label))];
}
function renderDocumentFilterOptions() {
  if (!documentFilter) return;
  const selected = String(state.documentFilter || "");
  documentFilter.innerHTML = documentFilterOptions().map(option => (
    '<option value="' + escapeHtml(option.key) + '"' + (option.key === selected ? " selected" : "") + '>' + escapeHtml(option.label) + '</option>'
  )).join("");
  if (![...documentFilter.options].some(option => option.value === selected)) {
    documentFilter.value = "";
    state.documentFilter = "";
  }
}
function activeDocumentFilter() {
  return String(documentFilter ? documentFilter.value : state.documentFilter || "").trim();
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
  const value = issueFilter ? issueFilter.value : state.issueFilter;
  return String(value || "").trim().toUpperCase();
}
function isMechanicalScan(item) {
  const id = String(item?.id || "").trim();
  const problemType = String(item?.problemType || "").trim();
  const type = String(item?.type || "").trim();
  return item?.kind === "mechanical_scan"
    || /^M0(?:-|$)/i.test(id)
    || /^M0(?:\s|-|$)/i.test(problemType)
    || /(?:^|[\s:/_-])mechanical[\s_-]*scan(?:$|[\s:/_-])/i.test(type)
    || /(?:^|[\s:/_-])mechanical[\s_-]*scan(?:$|[\s:/_-])/i.test(problemType);
}
function proposalSearchText(item) {
  return JSON.stringify(item).toLowerCase();
}
function filteredItems() {
  const q = String(searchInput?.value || "").trim().toLowerCase();
  const type = activeIssueFilter();
  const documentId = activeDocumentFilter();
  return data.proposals.filter(item => {
    const code = proposalCode(item);
    const severity = proposalSeverity(item);
    const documentMatches = !documentId || proposalDocumentKey(item) === documentId;
    const typeMatches = !type || code === type || severity === type;
    const searchMatches = !q || proposalSearchText(item).includes(q);
    return documentMatches && typeMatches && searchMatches;
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
  renderConflictSummary();
  if (visiblePageItems.length === 0) {
    cards.innerHTML = '<p class="subtle">' + escapeHtml(data.labels.searchNoMatches || "No matches") + '</p>';
    save();
    return;
  }
  cards.innerHTML = visiblePageItems.map(item => {
    const decision = effectiveProposalDecision(item);
    const lineLabel = item.line ? (data.labels.lineNumber || "Line") + " " + item.line : (data.labels.lineNumber || "Line") + " ?";
    const documentChip = proposalDocumentKey(item)
      ? '<span class="chip document-chip">' + escapeHtml(proposalDocumentLabel(item)) + '</span>'
      : '';
    if (isMechanicalScan(item)) {
      const statusLabel = decision.status === "accepted"
        ? (data.labels.mechanicalConfirmed || "Confirmed as an issue")
        : decision.status === "rejected"
          ? (data.labels.mechanicalFalsePositive || "False positive")
          : "unreviewed";
      return '<article class="card mechanical-scan-card" data-id="' + escapeHtml(item.id) + '" data-line="' + escapeHtml(item.line || "") + '">' +
        '<div class="card-head"><strong>' + escapeHtml(data.labels.mechanicalScan || "Mechanical scan") + '</strong>' + documentChip + '<span class="chip line-chip">' + escapeHtml(lineLabel) + '</span><span class="chip status-chip">' + escapeHtml(statusLabel) + '</span></div>' +
        '<div class="card-body">' +
        field(data.labels.source, item.src) + field(data.labels.current, item.current) + field(data.labels.problem, item.problem) +
        '<div class="toolbar"><button class="btn accept ' + (decision.status === "accepted" ? "active" : "") + '" data-mechanical-action="confirm">' + escapeHtml(data.labels.mechanicalConfirm || "Confirm issue") + '</button>' +
        '<button class="btn reject ' + (decision.status === "rejected" ? "active" : "") + '" data-mechanical-action="false-positive">' + escapeHtml(data.labels.mechanicalFalsePositive || "False positive") + '</button>' +
        '<button class="btn jump-line" data-jump-line="' + escapeHtml(item.line || "") + '">' + (data.labels.jumpLine || "Jump to line") + '</button></div>' +
        '</div></article>';
    }
    return '<article class="card" data-id="' + escapeHtml(item.id) + '" data-line="' + escapeHtml(item.line || "") + '">' +
      '<div class="card-head"><strong>' + escapeHtml(item.id) + '</strong>' + documentChip + '<span class="chip line-chip">' + escapeHtml(lineLabel) + '</span><span class="chip status-chip">' + escapeHtml(decision.status || "unreviewed") + '</span></div>' +
      '<div class="card-body">' +
      field(data.labels.source, item.src) + field(data.labels.current, item.current) + field(data.labels.problemType, item.problemType) + field(data.labels.problem, item.problem) + field(data.labels.suggestion, item.suggestion, "suggestion") +
      '<textarea placeholder="' + data.labels.manual + '">' + escapeHtml(decision.manualText || "") + '</textarea>' +
      conflictControls(item, decision) +
      '<div class="toolbar"><button class="btn accept ' + (decision.status === "accepted" ? "active" : "") + '" data-action="accepted">' + data.labels.accept + '</button>' +
      '<button class="btn reject ' + (decision.status === "rejected" ? "active" : "") + '" data-action="rejected">' + data.labels.reject + '</button>' +
      '<button class="btn manual ' + (decision.status === "manual" ? "active" : "") + '" data-action="manual">' + data.labels.manual + '</button>' +
      '<button class="btn jump-line" id="jumpLine-' + escapeHtml(domId(item.id)) + '" data-jump-line="' + escapeHtml(item.line || "") + '">' + (data.labels.jumpLine || "Jump to line") + '</button></div>' +
      '</div></article>';
  }).join("");
  save();
}
function field(label, value, cls = "") { return '<div class="field ' + cls + '"><b>' + label + '</b><div class="text">' + escapeHtml(value) + '</div></div>'; }
function conflictControls(item, decision) {
  if (decision.status !== "conflict") return "";
  const reason = decision.conflictReason ? " · " + decision.conflictReason : "";
  const currentText = decision.conflictCurrentText || item.current || item.oldText || "";
  const agentText = proposalSuggestionText(item);
  return '<div class="conflict-box"><b>' + escapeHtml(data.labels.conflict || "Conflict") + escapeHtml(reason) + '</b>' +
    conflictHistoryHtml(item, decision) +
    '<div class="conflict-merge-grid">' +
    conflictMergePane(data.labels.source || "Source", item.src, "source") +
    conflictMergePane(data.labels.current || "Current translation", currentText, "current", agentText) +
    conflictMergePane(data.labels.suggestion || "Suggested translation", agentText, "agent", currentText) +
    '</div>' +
    '<div class="toolbar">' +
    '<button class="btn reject" data-conflict-action="keep-current">' + escapeHtml(data.labels.keepCurrent || "Keep current") + '</button>' +
    '<button class="btn accept" data-conflict-action="accept-agent">' + escapeHtml(data.labels.acceptAgent || "Accept Agent") + '</button>' +
    '<button class="btn manual" data-conflict-action="manual-merge">' + escapeHtml(data.labels.manualMerge || "Manual merge") + '</button>' +
    '</div></div>';
}
function conflictHistoryHtml(item, decision) {
  const base = Number(item.baseRevision);
  const current = Number(decision.conflictCurrentRevision);
  const meta = [];
  if (Number.isInteger(base) && base >= 0) meta.push("base r" + base);
  if (Number.isInteger(current) && current >= 0) meta.push("current r" + current);
  const history = Array.isArray(decision.conflictRevisionHistory) ? decision.conflictRevisionHistory.slice(-6) : [];
  const label = data.labels.revisionHistory || "Revision history";
  if (history.length === 0) {
    return meta.length ? '<div class="conflict-history">' + escapeHtml(label + " · " + meta.join(" / ")) + '</div>' : "";
  }
  return '<details class="conflict-history" open><summary>' + escapeHtml(label + (meta.length ? " · " + meta.join(" / ") : "")) + '</summary>' +
    history.map(entry => '<div class="conflict-history-row"><code>r' + escapeHtml(entry.revision ?? "?") + ' · ' + escapeHtml(entry.source || "edit") + ' · ' + escapeHtml(entry.status || "") + '</code><div class="text">' + escapeHtml(entry.text || "") + '</div></div>').join("") +
    '</details>';
}
function conflictMergePane(label, value, kind, compareValue = "") {
  return '<div class="conflict-merge-pane" data-conflict-preview="' + escapeHtml(kind) + '"><span>' + escapeHtml(label) + '</span><div class="text">' + conflictDiffHtml(value, compareValue, kind) + '</div></div>';
}
function conflictDiffHtml(value, compareValue, kind) {
  const text = String(value || "");
  const other = String(compareValue || "");
  if (!other || text === other || (kind !== "current" && kind !== "agent")) return escapeHtml(text);
  let start = 0;
  while (start < text.length && start < other.length && text[start] === other[start]) start += 1;
  let endText = text.length;
  let endOther = other.length;
  while (endText > start && endOther > start && text[endText - 1] === other[endOther - 1]) {
    endText -= 1;
    endOther -= 1;
  }
  const cls = kind === "current" ? "conflict-diff-old" : "conflict-diff-new";
  return escapeHtml(text.slice(0, start)) +
    '<mark class="' + cls + '">' + escapeHtml(text.slice(start, endText)) + '</mark>' +
    escapeHtml(text.slice(endText));
}
function conflictItems() {
  return data.proposals.filter(item => decisionFor(item).status === "conflict");
}
function renderConflictSummary() {
  if (!conflictSummary) return;
  const items = conflictItems();
  if (items.length === 0) {
    conflictSummary.hidden = true;
    conflictSummary.innerHTML = "";
    return;
  }
  conflictSummary.hidden = false;
  conflictSummary.innerHTML = '<b>' + escapeHtml(data.labels.conflictList || "Conflicts") + ': ' + items.length + '</b>' +
    items.map(item => {
      const line = item.line ? (data.labels.lineNumber || "Line") + " " + item.line : (data.labels.lineNumber || "Line") + " ?";
      return '<button type="button" class="btn" data-conflict-jump="' + escapeHtml(item.id) + '">' +
        escapeHtml(item.id + " · " + line) +
        '</button>';
    }).join("");
}
function domId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-");
}
function reviewSourceKey() {
  return "proposal-review:" + (data.reportPath || location.pathname);
}
function lineReviewPathname(pathValue = data.lineReviewPath) {
  const raw = String(pathValue || "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    try { return new URL(raw).pathname; } catch { return ""; }
  }
  const normalized = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return "/" + normalized;
  return normalized.startsWith("/") ? normalized : "/" + normalized;
}
function lineReviewStorageKey(pathValue = data.lineReviewPath) {
  const pathname = lineReviewPathname(pathValue);
  return pathname ? "translation-workshop:line:" + pathname : "";
}
function lineReviewTargetForLine(line, pathValue = data.lineReviewPath) {
  const raw = String(pathValue || "").trim();
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
function lineReviewFileUrl(line, pathValue = data.lineReviewPath) {
  const target = lineReviewTargetForLine(line, pathValue);
  if (!target || /^file:/i.test(target)) return target;
  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const normalized = pathPart.replace(/\\/g, "/");
  return "file:///" + normalized.replace(/^\/+/, "") + hash;
}
function lineReviewFilePath(pathValue = data.lineReviewPath) {
  const raw = String(pathValue || "").trim().replace(/#.*$/, "");
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
const linkedLineReviewDocumentPromises = new Map();
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
async function resolveProposalLineReviewDocument(item = data.proposals[0], { includeRows = true } = {}) {
  const documentKey = proposalDocumentKey(item) || "__single__";
  const cacheKey = documentKey + (includeRows ? ":rows" : ":metadata");
  if (linkedLineReviewDocumentPromises.has(cacheKey)) return linkedLineReviewDocumentPromises.get(cacheKey);
  const promise = (async () => {
    const bridge = htmlBridge();
    if (bridge?.resolveProposalLineReviewDocument) {
      const resolved = await bridge.resolveProposalLineReviewDocument({
        outputDir: data.outputDir || "",
        reportPath: data.reportPath || "",
        lineReviewPath: data.lineReviewPath || "",
        documentId: item?.documentId || "",
        sourcePath: item?.sourcePath || "",
        translationPath: item?.translationPath || "",
        locale: data.locale === "en-US" ? "en-US" : "zh-CN",
        includeRows
      });
      if (resolved?.lineReviewPath && (!includeRows || (Array.isArray(resolved?.rows) && resolved.rows.length > 0))) {
        return { ...resolved, state: resolved.state || {} };
      }
    }
    const targetPath = lineReviewFilePath(data.lineReviewPath);
    if (!targetPath) return { rows: [], state: {} };
    if (bridge?.readLineReviewDocument) {
      const document = await bridge.readLineReviewDocument({ lineReviewPath: targetPath });
      if (Array.isArray(document?.rows) && document.rows.length > 0) {
        return { rows: document.rows, state: document.state || {}, lineReviewPath: targetPath };
      }
    }
    if (!bridge?.readTextFile) return { rows: [], state: {} };
    try {
      const result = await bridge.readTextFile({ path: targetPath });
      return { rows: parseLineReviewRowsFromHtml(result?.text || ""), state: {}, lineReviewPath: targetPath };
    } catch {
      return { rows: [], state: {} };
    }
  })();
  linkedLineReviewDocumentPromises.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    linkedLineReviewDocumentPromises.delete(cacheKey);
    throw error;
  }
}
async function readLinkedLineReviewDocument(item = data.proposals[0]) {
  return resolveProposalLineReviewDocument(item);
}
async function readLinkedLineReviewRows(item = data.proposals[0]) {
  return (await readLinkedLineReviewDocument(item)).rows;
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
function currentLineReviewText(row, lineState, line) {
  return String(lineState?.edits?.[line] ?? row?.translation ?? "");
}
function currentProposalLineText(item, lineState, rows) {
  const line = Number(item.line);
  return currentLineReviewText(lineReviewRowFor(rows, line), lineState, line);
}
function lineReviewRevision(lineState, line) {
  const revision = Number(lineState?.revisions?.[line] ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}
function lineReviewRevisionHistory(lineState, line) {
  return Array.isArray(lineState?.revisionHistory?.[line]) ? lineState.revisionHistory[line].slice(-12) : [];
}
function recordTargetLineRevision(lineState, line, text, status, source) {
  const key = String(line);
  lineState.revisions ||= {};
  lineState.revisionHistory ||= {};
  const revision = Number(lineState.revisions[key] || 0) + 1;
  lineState.revisions[key] = revision;
  const history = Array.isArray(lineState.revisionHistory[key]) ? lineState.revisionHistory[key] : [];
  const entry = { revision, text: String(text ?? ""), status: String(status || ""), source: String(source || "proposal") };
  const last = history[history.length - 1];
  if (!last || last.text !== entry.text || last.status !== entry.status || last.source !== entry.source) history.push(entry);
  lineState.revisionHistory[key] = history.slice(-12);
  return revision;
}
function proposalSafetyCheck(item, lineState, rows, options = {}) {
  const line = Number(item.line);
  const row = lineReviewRowFor(rows, line);
  if (!row) return { ok: false, reason: "missing-line" };
  const sourceScore = item.src ? textSimilarity(item.src, row.source) : 1;
  if (sourceScore < 0.8) return { ok: false, reason: "source-mismatch" };
  const currentText = currentLineReviewText(row, lineState, line);
  const intendedText = String(options.intendedText ?? proposalSuggestionText(item) ?? "").trim();
  if (intendedText && textSimilarity(intendedText, currentText) >= 0.98) {
    return { ok: true, reason: "", alreadyApplied: true };
  }
  const lastRevision = lineReviewRevisionHistory(lineState, line).at(-1);
  if (lastRevision?.source === "desktop-edit" && options.allowStaleTarget !== true) {
    return { ok: false, reason: "manual-edit" };
  }
  if (options.allowStaleTarget === true) return { ok: true, reason: "" };
  const oldText = String(item.oldText || item.current || "");
  if (oldText && textSimilarity(oldText, currentText) < 0.8) {
    return { ok: false, reason: "patch-conflict" };
  }
  const baseRevision = Number(item.baseRevision);
  if (Number.isInteger(baseRevision) && baseRevision >= 0 && lineReviewRevision(lineState, line) !== baseRevision) {
    return { ok: false, reason: "base-revision-conflict" };
  }
  return { ok: true, reason: "" };
}
function reconcileStoredProposalConflicts(lineState, rows, documentKey = "", setDecision = (id, decision) => {
  state.decisions[id] = decision;
}) {
  let changed = false;
  for (const item of data.proposals) {
    if (documentKey && (proposalDocumentKey(item) || "__single__") !== documentKey) continue;
    const decision = state.decisions[item.id];
    if (decision?.status !== "conflict") continue;
    if (!proposalSafetyCheck(item, lineState, rows).ok) continue;
    setDecision(item.id, { status: "accepted", manualText: "" });
    changed = true;
  }
  return changed;
}
function readLineReviewState(canonicalState, pathValue = data.lineReviewPath) {
  const storageKey = lineReviewStorageKey(pathValue);
  if (!storageKey) {
    setProposalStatus(data.labels.lineReviewMissing || "No linked line review HTML");
    return undefined;
  }
  let lineState = canonicalState && typeof canonicalState === "object" ? canonicalState : undefined;
  if (!lineState) {
    try {
      lineState = JSON.parse(localStorage.getItem(storageKey) || "{}") || {};
    } catch {
      lineState = {};
    }
  }
  lineState.edits ||= {};
  lineState.status ||= {};
  lineState.auditIssues ||= {};
  lineState.auditWhitelist ||= {};
  lineState.revisions ||= {};
  lineState.revisionHistory ||= {};
  return { storageKey, lineState, lineReviewPath: String(pathValue || data.lineReviewPath || "") };
}
function cloneLineReviewTarget(target) {
  return {
    ...target,
    lineState: JSON.parse(JSON.stringify(target.lineState || {}))
  };
}
function cloneProposalDecision(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function proposalDecisionsEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
function setProposalDecisionForApply(changes, id, decision) {
  if (!changes.has(id)) {
    changes.set(id, {
      hadBefore: Object.prototype.hasOwnProperty.call(state.decisions, id),
      before: cloneProposalDecision(state.decisions[id]),
      applied: undefined
    });
  }
  const next = cloneProposalDecision(decision);
  changes.get(id).applied = next;
  state.decisions[id] = next;
}
function rollbackProposalDecisionChanges(changes) {
  for (const [id, change] of changes) {
    if (!proposalDecisionsEqual(state.decisions[id], change.applied)) continue;
    if (change.hadBefore) state.decisions[id] = cloneProposalDecision(change.before);
    else delete state.decisions[id];
  }
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
  if (lanSyncToken || lanSyncStarting || lanSyncStopping) return;
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
  lanSyncStarting = true;
  try {
    const selectedDocumentId = activeDocumentFilter();
    const selectedProposal = data.proposals.find(item => !selectedDocumentId || proposalDocumentKey(item) === selectedDocumentId) || data.proposals[0];
    const linkedDocument = await readLinkedLineReviewDocument(selectedProposal);
    const linkedRows = linkedDocument.rows;
    const linkedState = readLineReviewState(linkedDocument.state)?.lineState || {};
    const result = await bridge.startLanSync({
      pin,
      htmlPath: currentProposalHtmlPath(),
      outputDir: data.outputDir || "",
      title: document.title || "translation-workshop",
      locale: document.documentElement.lang === "en-US" ? "en-US" : "zh-CN",
      pageSize,
      lineReviewPath: linkedDocument?.lineReviewPath || data.lineReviewPath,
      lineDocument: linkedRows.length > 0 ? {
        title: linkedDocument?.lineReviewPath || data.lineReviewPath || (data.labels.lineReviewLinked || "Line review"),
        rows: lanSyncLineRowsPayload(linkedRows),
        state: linkedState,
        pageSize,
        lineReviewPath: linkedDocument?.lineReviewPath || data.lineReviewPath
      } : undefined,
      proposalDocument: {
        title: document.title || "translation-workshop",
        proposals: data.proposals,
        state,
        pageSize,
        reportPath: data.reportPath,
        lineReviewPath: linkedDocument?.lineReviewPath || data.lineReviewPath
      }
    });
    lanSyncToken = result?.token || "";
    lanSyncStopping = false;
    renderLanSyncLinks(result);
    setProposalStatus((data.labels.lanSyncStarted || "LAN sync started") + ": " + (lanSyncPrimaryUrl || result?.localUrl || ""));
  } catch (error) {
    setProposalStatus((data.labels.lanSyncFailed || "LAN sync failed") + ": " + (error?.message || String(error)));
  } finally {
    lanSyncStarting = false;
  }
}
function reportProposalLanSyncFailure(error) {
  console.error("translation-workshop failed to persist LAN proposal state", error);
  setProposalStatus((data.labels.lanSyncFailed || "LAN sync failed") + ": " + (error?.message || String(error)));
}
async function dispatchPendingProposalLanSyncPatch(key) {
  const pending = lanSyncPendingPatches.get(key);
  if (!pending) return;
  lanSyncPendingPatches.delete(key);
  clearTimeout(pending.timer);
  try {
    const result = await pending.bridge.sendLanSyncPatch({
      token: pending.token,
      patch: { ...pending.patch, clientId: "desktop", timestamp: new Date().toISOString() }
    });
    if (!result?.ok) throw new Error("The Electron host rejected the LAN proposal decision.");
    for (const waiter of pending.waiters) waiter.resolve(result);
  } catch (error) {
    for (const waiter of pending.waiters) waiter.reject(error);
    throw error;
  }
}
function flushPendingProposalLanSyncPatches() {
  return Promise.all([...lanSyncPendingPatches.keys()].map(dispatchPendingProposalLanSyncPatch));
}
function queueLanSyncPatch(patch) {
  if (lanSyncStopping) return Promise.reject(new Error("LAN sync is stopping; wait for it to finish before changing a decision."));
  if (!lanSyncToken) return Promise.reject(new Error("LAN sync is not active."));
  const bridge = htmlBridge();
  if (!bridge?.sendLanSyncPatch) return Promise.reject(new Error("LAN sync is unavailable in this window."));
  const key = patch.type === "proposal-decision" ? "proposal:" + patch.proposalId : "line:" + patch.line;
  return new Promise((resolve, reject) => {
    const previous = lanSyncPendingPatches.get(key);
    if (previous) clearTimeout(previous.timer);
    const pending = {
      token: lanSyncToken,
      bridge,
      patch,
      waiters: [...(previous?.waiters || []), { resolve, reject }],
      timer: 0
    };
    pending.timer = setTimeout(() => {
      void dispatchPendingProposalLanSyncPatch(key).catch(reportProposalLanSyncFailure);
    }, patch.type === "proposal-decision" ? 200 : 0);
    lanSyncPendingPatches.set(key, pending);
  });
}
function persistOrSyncProposalDecision(patch) {
  if (!lanSyncToken) {
    save();
    return;
  }
  try {
    storeProposalStateLocally();
  } catch (error) {
    console.warn("translation-workshop could not store synchronized proposal state", error);
  }
  const request = queueLanSyncPatch(patch);
  void request.catch(reportProposalLanSyncFailure);
  return request;
}
function applyRemoteLanSyncPatch(payload) {
  if (!payload || payload.token !== lanSyncToken) return;
  const patch = payload.patch || {};
  if (patch.clientId === "desktop") return;
  if (patch.type === "proposal-decision") {
    const proposalId = String(patch.proposalId || "");
    if (!proposalId) return;
    state.decisions[proposalId] = {
      ...(state.decisions[proposalId] || {}),
      status: patch.status || "manual",
      manualText: patch.manualText || "",
      overrideConflict: patch.overrideConflict === true,
      conflictReason: patch.conflictReason || ""
    };
    try {
      storeProposalStateLocally();
    } catch (error) {
      console.warn("translation-workshop could not store synchronized proposal state", error);
    }
    render();
  }
}
function applyRemoteLanSyncCommand(payload) {
  if (!payload || payload.token !== lanSyncToken) return;
  if (payload.command?.type !== "open-agent-os") return;
  window.__ynAgentChatPiWebEmbedded?.open?.();
}
async function persistLineReviewState(target, lines) {
  localStorage.setItem(target.storageKey, JSON.stringify(target.lineState));
  const bridge = htmlBridge();
  if (!bridge?.applyLineReviewState || !target.lineReviewPath) {
    return false;
  }
  try {
    await bridge.applyLineReviewState({
      lineReviewPath: target.lineReviewPath,
      lineState: target.lineState,
      line: Array.isArray(lines) ? lines[0] : lines,
      lines: Array.isArray(lines) ? lines : (lines ? [lines] : undefined)
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
  if (isMechanicalScan(item)) {
    if (decision.status === "accepted" || decision.status === "rejected") {
      return { ...decision, manualText: "" };
    }
    return { ...decision, status: "unreviewed", manualText: "" };
  }
  const manualText = String(decision.manualText || "").trim();
  if (manualText) return { ...decision, status: "manual" };
  if (decision.status === "conflict") return { ...decision, status: "conflict", manualText: "" };
  if (decision.status === "rejected") return { ...decision, status: "rejected", manualText: "" };
  if (decision.status === "accepted" && proposalSuggestionText(item)) {
    return { ...decision, status: "accepted", manualText: "" };
  }
  return { ...decision, status: "unreviewed", manualText: "" };
}
function decisionFor(item) {
  return effectiveProposalDecision(item);
}
function decisionForProposalApply(item) {
  const decision = decisionFor(item);
  if (decision.status === "unreviewed" && proposalSuggestionText(item)) {
    return { ...decision, status: "accepted", manualText: "" };
  }
  return decision;
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
  const next = issues.filter(issue => issue.source !== source || issue.proposalId !== proposalId);
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
async function openLinkedLineReview(line, pathValue = data.lineReviewPath) {
  if (!pathValue) {
    setProposalStatus(data.labels.lineReviewMissing || "No linked line review HTML");
    return;
  }
  const bridge = htmlBridge();
  const target = line ? lineReviewTargetForLine(line, pathValue) : pathValue;
  try {
    if (bridge?.openPath) {
      await bridge.openPath(target);
    } else {
      window.open(lineReviewFileUrl(line, pathValue), "_blank");
    }
  } catch (error) {
    setProposalStatus((data.labels.proposalOpenFailed || "Failed to open line HTML") + ": " + (error?.message || String(error)));
  }
}
async function jumpToLineReviewLine(item) {
  const linkedDocument = await resolveProposalLineReviewDocument(item, { includeRows: false });
  const pathValue = linkedDocument?.lineReviewPath || data.lineReviewPath;
  await openLinkedLineReview(item.line, pathValue);
}
function removeMechanicalScanIssue(lineState, line, proposalId) {
  const issues = Array.isArray(lineState.auditIssues[line]) ? lineState.auditIssues[line] : [];
  const next = issues.filter(issue => !(
    issue.proposalId === proposalId && String(issue.code || "").toUpperCase() === "M0"
  ));
  if (next.length > 0) lineState.auditIssues[line] = next;
  else delete lineState.auditIssues[line];
}
async function resolveMechanicalScan(item, action) {
  const line = Number(item?.line || 0);
  if (!isMechanicalScan(item) || !Number.isInteger(line) || line <= 0) return;
  const linkedDocument = await readLinkedLineReviewDocument(item);
  const target = readLineReviewState(linkedDocument?.state, linkedDocument?.lineReviewPath || data.lineReviewPath);
  if (!target) return;
  const lineState = target.lineState;
  lineState.auditVisible = true;
  lineState.auditWhitelist ||= {};
  if (action === "false-positive") {
    lineState.auditWhitelist[line] = true;
    removeMechanicalScanIssue(lineState, line, item.id);
  } else {
    delete lineState.auditWhitelist[line];
    markProposalIssue(lineState, item);
  }
  const bridge = htmlBridge();
  let persisted = false;
  if (bridge?.writeAuditWhitelistFile && data.outputDir && target.lineReviewPath) {
    const whitelistLines = Object.entries(lineState.auditWhitelist)
      .filter(([, enabled]) => enabled === true)
      .map(([value]) => Number(value))
      .filter(value => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);
    const result = await bridge.writeAuditWhitelistFile({
      outputDir: data.outputDir,
      documentId: proposalDocumentKey(item),
      sourcePath: item.sourcePath || "",
      lines: whitelistLines,
      lineReviewPath: target.lineReviewPath,
      lineState,
      changedLines: [line]
    });
    if (result?.ok === false) throw new Error("Audit whitelist write failed.");
    if (result?.state && typeof result.state === "object") {
      Object.assign(lineState, result.state);
      localStorage.setItem(target.storageKey, JSON.stringify(lineState));
    }
    persisted = true;
  }
  if (!persisted) persisted = await persistLineReviewState(target, line);
  state.decisions[item.id] = {
    status: action === "false-positive" ? "rejected" : "accepted",
    manualText: ""
  };
  save();
  render();
  setProposalStatus(action === "false-positive"
    ? (data.labels.mechanicalSuppressed || "False positive saved and hidden from the main review")
    : (data.labels.mechanicalConfirmed || "Confirmed as an issue"));
  if (!persisted) await openLinkedLineReview(line, target.lineReviewPath);
}
async function persistProposalDocumentStates(commits) {
  if (commits.length === 0) return true;
  const bridge = htmlBridge();
  if (!bridge?.applyProposalLineReviewStates) {
    throw new Error("Atomic proposal apply requires the Electron Host transaction API.");
  }
  const result = await bridge.applyProposalLineReviewStates({
      documents: commits.map(commit => ({
        reportPath: data.reportPath || "",
        documentId: commit.document?.documentId || proposalDocumentKey(commit.item),
        sourcePath: commit.document?.sourcePath || commit.item?.sourcePath || "",
        translationPath: commit.document?.translationPath || commit.item?.translationPath || "",
        lineReviewPath: commit.target.lineReviewPath,
        lineState: commit.target.lineState,
        changedLines: [...commit.affectedLines],
        changedStateKeys: ["auditVisible"],
        expectedLineRevisions: commit.expectedLineRevisions
      }))
    });
    if (result?.ok === false) {
      throw new Error(result.error || "The Electron host rejected the cross-file proposal update.");
    }
    const savedDocuments = Array.isArray(result?.documents) ? result.documents : [];
    if (savedDocuments.length !== commits.length) {
      throw new Error("The Electron host returned an incomplete proposal commit result.");
    }
    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index];
      const saved = savedDocuments[index];
      const expectedPath = String(commit.target.lineReviewPath || "").replace(/\\/g, "/").toLowerCase();
      const savedPath = String(saved?.lineReviewPath || "").replace(/\\/g, "/").toLowerCase();
      if (!saved?.state || typeof saved.state !== "object" || savedPath !== expectedPath) {
        throw new Error("The Electron host returned a mismatched proposal commit result.");
      }
      const canonicalState = JSON.parse(JSON.stringify(saved.state));
      for (const key of Object.keys(commit.target.lineState)) delete commit.target.lineState[key];
      Object.assign(commit.target.lineState, canonicalState);
      if (commit.document) {
        commit.document.state ||= {};
        for (const key of Object.keys(commit.document.state)) delete commit.document.state[key];
        Object.assign(commit.document.state, canonicalState);
      }
    }
    for (const commit of commits) {
      try {
        localStorage.setItem(commit.target.storageKey, JSON.stringify(commit.target.lineState));
      } catch (error) {
        reportProposalStateSaveFailure(error);
      }
    }
  return true;
}
async function connectLineReview() {
  const commits = [];
  let marked = 0;
  for (const group of groupProposalsByDocument()) {
    const linkedDocument = await readLinkedLineReviewDocument(group.items[0]);
    const baseTarget = readLineReviewState(linkedDocument?.state, linkedDocument?.lineReviewPath || data.lineReviewPath);
    if (!baseTarget) continue;
    const target = cloneLineReviewTarget(baseTarget);
    const affectedLines = new Set(Object.entries(target.lineState.auditIssues || {})
      .filter(([, issues]) => Array.isArray(issues) && issues.some(issue => issue.source === reviewSourceKey()))
      .map(([line]) => Number(line))
      .filter(line => Number.isInteger(line) && line > 0));
    clearReviewIssues(target.lineState);
    target.lineState.auditVisible = true;
    for (const item of group.items) {
      const line = Number(item.line);
      const decision = decisionFor(item);
      if (!Number.isInteger(line) || line <= 0 || decision.status === "rejected") continue;
      if (markProposalIssue(target.lineState, item)) {
        marked += 1;
        affectedLines.add(line);
      }
    }
    const expectedLineRevisions = Object.fromEntries(
      [...affectedLines].map(line => [line, lineReviewRevision(baseTarget.lineState, line)])
    );
    commits.push({ target, affectedLines, expectedLineRevisions, document: linkedDocument, item: group.items[0] });
  }
  await persistProposalDocumentStates(commits);
  setProposalStatus((data.labels.lineReviewLinked || "Line review HTML marked") + ": " + marked);
}
function proposalReplacementText(item, decision) {
  if (isMechanicalScan(item)) return "";
  if (decision.status === "conflict") return "";
  if (decision.status === "rejected") return "";
  if (decision.status === "manual") return String(decision.manualText || "").trim();
  if (decision.status === "accepted") return proposalSuggestionText(item);
  return "";
}
function applyProposalChanges() {
  if (proposalApplyInFlight) return proposalApplyInFlight;
  proposalApplyInFlight = applyProposalChangesOnce().finally(() => {
    proposalApplyInFlight = undefined;
  });
  return proposalApplyInFlight;
}
async function applyProposalChangesOnce() {
  let applied = 0;
  let skipped = 0;
  let safetySkipped = 0;
  let conflictSkipped = 0;
  const commits = [];
  const decisionChanges = new Map();
  try {
    const bridge = htmlBridge();
    if (bridge?.prepareProposalLineReviewBatch) {
      const prepared = await bridge.prepareProposalLineReviewBatch({
        outputDir: data.outputDir || "",
        reportPath: data.reportPath || "",
        lineReviewPath: data.lineReviewPath || "",
        locale: data.locale === "en-US" ? "en-US" : "zh-CN",
        documents: groupProposalsByDocument().map(group => ({
          documentId: group.items[0]?.documentId || "",
          sourcePath: group.items[0]?.sourcePath || "",
          translationPath: group.items[0]?.translationPath || ""
        }))
      });
      if (prepared?.ok === false) {
        throw new Error(prepared.error || "The Electron host rejected batch proposal preparation.");
      }
      if (prepared?.batch === true) linkedLineReviewDocumentPromises.clear();
      traceProposalApply("batch-prepared", {
        batch: prepared?.batch === true,
        synchronized: Number(prepared?.synchronized || 0),
        migrated: Number(prepared?.migrated || 0)
      });
    }
    traceProposalApply("start", {
      proposals: data.proposals.length,
      documents: groupProposalsByDocument().length
    });
    for (const group of groupProposalsByDocument()) {
      const candidates = group.items.filter(item => {
        const line = Number(item.line);
        const decision = decisionForProposalApply(item);
        return Number.isInteger(line) && line > 0
          && !isMechanicalScan(item)
          && (decision.status === "accepted" || decision.status === "manual")
          && Boolean(String(decision.manualText || "").trim() || proposalSuggestionText(item));
      });
      skipped += group.items.length - candidates.length;
      if (candidates.length === 0) continue;
      const linkedDocument = await readLinkedLineReviewDocument(candidates[0]);
      const baseTarget = readLineReviewState(linkedDocument?.state, linkedDocument?.lineReviewPath || data.lineReviewPath);
      if (!baseTarget) {
        skipped += candidates.length;
        continue;
      }
      const target = cloneLineReviewTarget(baseTarget);
      const lineRows = linkedDocument?.rows || [];
      reconcileStoredProposalConflicts(target.lineState, lineRows, group.key, (id, next) => {
        setProposalDecisionForApply(decisionChanges, id, next);
      });
      target.lineState.auditVisible = true;
      target.lineState.revisions ||= {};
      const affectedLines = new Set();
      const expectedLineRevisions = {};
      for (const item of candidates) {
        const line = Number(item.line);
        const decision = decisionForProposalApply(item);
        const text = proposalReplacementText(item, decision);
        if (!text) {
          skipped += 1;
          continue;
        }
        const safety = proposalSafetyCheck(item, target.lineState, lineRows, {
          allowStaleTarget: decision.status === "manual" || decision.overrideConflict === true,
          intendedText: text
        });
        if (!safety.ok) {
          skipped += 1;
          safetySkipped += 1;
          if (safety.reason === "patch-conflict" || safety.reason === "base-revision-conflict") {
            conflictSkipped += 1;
            setProposalDecisionForApply(decisionChanges, item.id, {
              ...decision,
              status: "conflict",
              manualText: "",
              conflictReason: safety.reason,
              conflictCurrentText: currentProposalLineText(item, target.lineState, lineRows),
              conflictCurrentRevision: lineReviewRevision(target.lineState, line),
              conflictRevisionHistory: lineReviewRevisionHistory(target.lineState, line)
            });
          }
          continue;
        }
        if (safety.alreadyApplied === true) {
          expectedLineRevisions[line] ??= lineReviewRevision(baseTarget.lineState, line);
          removeReviewIssues(target.lineState, line, item.id);
          affectedLines.add(line);
          if (decision.status === "manual") {
            setProposalDecisionForApply(decisionChanges, item.id, {
              ...decision,
              status: "manual",
              manualText: decision.manualText || text
            });
          } else {
            setProposalDecisionForApply(decisionChanges, item.id, { ...decision, status: "accepted", manualText: "" });
          }
          applied += 1;
          continue;
        }
        expectedLineRevisions[line] ??= lineReviewRevision(baseTarget.lineState, line);
        target.lineState.edits[line] = text;
        target.lineState.status[line] = "manual";
        recordTargetLineRevision(target.lineState, line, text, "manual", "proposal-apply");
        removeReviewIssues(target.lineState, line, item.id);
        affectedLines.add(line);
        if (decision.status !== "manual") {
          setProposalDecisionForApply(decisionChanges, item.id, {
            ...decision,
            status: "accepted",
            manualText: decision.manualText || ""
          });
        }
        applied += 1;
      }
      if (affectedLines.size > 0) {
        commits.push({
          target,
          affectedLines,
          expectedLineRevisions,
          document: linkedDocument,
          item: candidates[0]
        });
      }
    }
    traceProposalApply("staged", {
      commits: commits.length,
      applied,
      skipped,
      safetySkipped,
      conflictSkipped
    });
    await persistProposalDocumentStates(commits);
    save();
    render();
    const safetyNote = safetySkipped > 0 ? " / " + (data.labels.proposalSafetySkipped || "failed safety check") + ": " + safetySkipped : "";
    const conflictNote = conflictSkipped > 0 ? " / " + (data.labels.proposalConflictSkipped || "conflicts") + ": " + conflictSkipped : "";
    setProposalStatus((data.labels.proposalChangesApplied || "Proposals applied") + ": " + applied + " / " + (data.labels.proposalApplySkipped || "skipped") + ": " + skipped + safetyNote + conflictNote);
    traceProposalApply("committed", { commits: commits.length, applied, skipped, safetySkipped, conflictSkipped });
  } catch (error) {
    rollbackProposalDecisionChanges(decisionChanges);
    render();
    traceProposalApply("failed", { error: error?.message || String(error) });
    throw error;
  }
}
async function applyProposalChangesFromButton() {
  const button = document.getElementById("applyProposalChanges");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  setProposalStatus(data.labels.proposalApplyRunning || "Applying proposals");
  try {
    await applyProposalChanges();
  } catch (error) {
    console.error("translation-workshop failed to apply proposals", error);
    setProposalStatus((data.labels.proposalApplyFailed || "Failed to apply proposals") + ": " + (error?.message || String(error)));
  } finally {
    if (button) button.disabled = false;
  }
}
cards.addEventListener("click", event => {
  const mechanicalButton = event.target.closest("button[data-mechanical-action]");
  if (mechanicalButton) {
    const item = proposalById(mechanicalButton.closest(".card")?.dataset.id);
    if (item) {
      void resolveMechanicalScan(item, mechanicalButton.dataset.mechanicalAction).catch(error => {
        setProposalStatus((data.labels.proposalOpenFailed || "Failed to update line review") + ": " + (error?.message || String(error)));
      });
    }
    return;
  }
  const jumpButton = event.target.closest("button[data-jump-line]");
  if (jumpButton) {
    const item = proposalById(jumpButton.closest(".card")?.dataset.id);
    if (item) void jumpToLineReviewLine(item);
    return;
  }
  const conflictButton = event.target.closest("button[data-conflict-action]");
  if (conflictButton) {
    if (lanSyncStopping) {
      reportProposalLanSyncFailure(new Error("LAN sync is stopping; wait before changing a decision."));
      return;
    }
    const card = conflictButton.closest(".card");
    const id = card?.dataset.id || "";
    const item = proposalById(id);
    if (!item) return;
    const textarea = card.querySelector("textarea");
    const action = conflictButton.dataset.conflictAction;
    const previous = state.decisions[id] || {};
    let rawDecision = previous;
    if (action === "keep-current") {
      rawDecision = { ...previous, status: "rejected", manualText: "" };
    } else if (action === "accept-agent") {
      rawDecision = { ...previous, status: "accepted", manualText: "", overrideConflict: true };
    } else if (action === "manual-merge") {
      if (textarea && !textarea.value.trim()) textarea.value = proposalSuggestionText(item);
      rawDecision = { ...previous, status: "manual", manualText: textarea?.value || proposalSuggestionText(item), overrideConflict: true };
      textarea?.focus();
    }
    state.decisions[id] = rawDecision;
    const decision = effectiveProposalDecision(item, rawDecision);
    applyDecisionVisual(card, decision);
    persistOrSyncProposalDecision({
      type: "proposal-decision",
      proposalId: id,
      status: decision.status,
      manualText: decision.manualText || rawDecision.manualText || "",
      overrideConflict: rawDecision.overrideConflict === true,
      conflictReason: rawDecision.conflictReason || ""
    });
    render();
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (lanSyncStopping) {
    reportProposalLanSyncFailure(new Error("LAN sync is stopping; wait before changing a decision."));
    return;
  }
  const card = button.closest(".card");
  const id = card.dataset.id;
  const item = proposalById(id);
  if (!item) return;
  const previous = state.decisions[id] || {};
  const rawDecision = { ...previous, status: button.dataset.action, manualText: card.querySelector("textarea").value };
  state.decisions[id] = rawDecision;
  const decision = effectiveProposalDecision(item, rawDecision);
  applyDecisionVisual(card, decision);
  persistOrSyncProposalDecision({
    type: "proposal-decision",
    proposalId: id,
    status: decision.status,
    manualText: decision.manualText || rawDecision.manualText || "",
    overrideConflict: rawDecision.overrideConflict === true,
    conflictReason: rawDecision.conflictReason || ""
  });
});
cards.addEventListener("input", event => {
  if (event.target.tagName !== "TEXTAREA") return;
  if (lanSyncStopping) {
    reportProposalLanSyncFailure(new Error("LAN sync is stopping; wait before changing a decision."));
    return;
  }
  const card = event.target.closest(".card");
  const item = proposalById(card.dataset.id);
  if (!item) return;
  const previous = state.decisions[card.dataset.id] || {};
  const rawDecision = { ...previous, status: "manual", manualText: event.target.value };
  state.decisions[card.dataset.id] = rawDecision;
  const decision = effectiveProposalDecision(item, rawDecision);
  applyDecisionVisual(card, decision);
  persistOrSyncProposalDecision({
    type: "proposal-decision",
    proposalId: card.dataset.id,
    status: decision.status,
    manualText: event.target.value,
    overrideConflict: rawDecision.overrideConflict === true,
    conflictReason: rawDecision.conflictReason || ""
  });
});
conflictSummary?.addEventListener("click", event => {
  const button = event.target.closest("button[data-conflict-jump]");
  if (!button) return;
  searchInput.value = button.dataset.conflictJump || "";
  page = 1;
  render();
  scrollTo(0, 0);
});
document.getElementById("prev").onclick = () => { page -= 1; render(); scrollTo(0, 0); };
document.getElementById("next").onclick = () => { page += 1; render(); scrollTo(0, 0); };
document.getElementById("jump").onclick = () => { page = Number(pageInput.value || 1); render(); scrollTo(0, 0); };
searchInput.oninput = () => { page = 1; render(); scrollTo(0, 0); };
documentFilter.onchange = () => { page = 1; state.documentFilter = activeDocumentFilter(); render(); scrollTo(0, 0); };
issueFilter.onchange = () => { page = 1; state.issueFilter = activeIssueFilter(); render(); scrollTo(0, 0); };
document.getElementById("connectLineReview")?.addEventListener("click", connectLineReview);
document.getElementById("applyProposalChanges")?.addEventListener("click", () => { void applyProposalChangesFromButton(); });
htmlBridge()?.onLanSyncPatch?.(applyRemoteLanSyncPatch);
htmlBridge()?.onLanSyncCommand?.(applyRemoteLanSyncCommand);
startLanSyncButton?.addEventListener("click", () => { void startLanSync(); });
copyLanSyncLinkButton?.addEventListener("click", () => {
  if (!lanSyncPrimaryUrl) return;
  navigator.clipboard?.writeText(lanSyncPrimaryUrl).then(() => setProposalStatus(data.labels.copied || "Copied")).catch(() => {});
});
stopLanSyncButton?.addEventListener("click", async () => {
  if (lanSyncStopping || lanSyncStarting) return;
  lanSyncStopping = true;
  const token = lanSyncToken;
  try {
    await flushPendingProposalLanSyncPatches();
    if (token) {
      const result = await htmlBridge()?.stopLanSync?.(token);
      if (result && result.ok === false) throw new Error("The Electron host could not stop LAN sync.");
    }
    lanSyncToken = "";
    lanSyncStopping = false;
    if (lanSyncPanel) lanSyncPanel.hidden = true;
    setProposalStatus(data.labels.lanSyncStopped || "LAN sync stopped");
  } catch (error) {
    lanSyncStopping = false;
    reportProposalLanSyncFailure(error);
  }
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
renderDocumentFilterOptions();
renderIssueFilterOptions();
render();
requestAnimationFrame(() => scrollTo(0, state.scrollY || 0));
const initialDocumentGroup = groupProposalsByDocument().find(group => !activeDocumentFilter() || group.key === activeDocumentFilter());
void (async () => {
  if (!initialDocumentGroup) return false;
  const hasStoredConflict = initialDocumentGroup.items.some(item => state.decisions[item.id]?.status === "conflict");
  if (!hasStoredConflict) return false;
  const linkedDocument = await readLinkedLineReviewDocument(initialDocumentGroup.items[0]);
  const target = readLineReviewState(linkedDocument?.state, linkedDocument?.lineReviewPath || data.lineReviewPath);
  return Boolean(target && reconcileStoredProposalConflicts(
    target.lineState,
    linkedDocument?.rows || [],
    initialDocumentGroup.key
  ));
})().then((changed) => {
  if (!changed) return;
  save();
  render();
}).catch((error) => {
  setProposalStatus((data.labels.proposalOpenFailed || "Failed to open line HTML") + ": " + (error?.message || String(error)));
});
${agentChatEmbedScript()}
`;
}
