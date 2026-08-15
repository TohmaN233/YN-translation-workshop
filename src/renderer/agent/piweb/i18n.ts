export type AgentUiLocale = "zh-CN" | "en-US";

export interface AgentUiStrings {
  emptyHint: string;
  hideSidebar: string;
  showSidebar: string;
  openNewWindow: string;
  closeAgent: string;
  compactingContext: string;
  stopBackgroundSubagents: string;
  deleteSession: string;
  estimatedStreamingTokens: string;
  subagentClosed: string;
  subagentCollapsed: string;
  queuePlaceholder: string;
  steerTitle: string;
  followUpTitle: string;
  sendTitle: string;
  attachImages: string;
  removeImage: string;
  imageInputUnsupported: string;
  imageTooLarge: string;
  imagesTooLarge: string;
  imageOnlyMessage: string;
  thinkingLevelTitle: string;
  compactContext: string;
  stopAgent: string;
  newSession: string;
  sessions: string;
  noSessions: string;
  untitledSession: string;
  noProject: string;
  deleteSessionConfirm: string;
  thinking: string;
  copy: string;
  copied: string;
  prompt: string;
  reply: string;
  loadingChildSession: string;
  runningTools: string;
  thinkingActive: string;
  runningCommand: string;
  stopping: string;
  retrying: string;
  modelLabel: string;
  loadingModels: string;
  selectModel: string;
  showExtensionMessage: string;
  hiddenExtensionMessage: string;
  noMessage: string;
  noOutput: string;
  expand: string;
  collapse: string;
  showDetails: string;
  hideDetails: string;
  providerFailed: string;
  notSelected: string;
  loadingSession: string;
  subagentsRunning: string;
  commands: string;
  noMatchingCommand: string;
  compactedTokens: string;
  compactingPlaceholder: string;
  runningPlaceholder: string;
  messagePlaceholder: string;
  queuedSteer: string;
  queuedFollowUp: string;
  queuedNextTurn: string;
  promptUnavailable: string;
  replyUnavailable: string;
  itemCount: string;
  fieldCount: string;
  sessionInfo: string;
  sessionShort: string;
  stats: {
    currentRun: string;
    state: string;
    running: string;
    ready: string;
    phase: string;
    model: string;
    subagents: string;
    subagentSummary: string;
    messages: string;
    user: string;
    assistant: string;
    toolCalls: string;
    toolResults: string;
    tokens: string;
    input: string;
    output: string;
    cacheRead: string;
    cacheWrite: string;
    total: string;
    cost: string;
    context: string;
  };
  status: Record<string, string>;
  provider: {
    settings: string;
    close: string;
    loading: string;
    newCustom: string;
    customEnabled: string;
    customSaved: string;
    enabled: string;
    name: string;
    baseUrl: string;
    connectionStatus: string;
    noOAuthProfile: string;
    active: string;
    saved: string;
    modelIds: string;
    supportsImages: string;
    defaultModel: string;
    apiKey: string;
    keepSavedKey: string;
    pasteApiKey: string;
    test: string;
    disable: string;
    delete: string;
    enable: string;
    useProvider: string;
    save: string;
    addModel: string;
    saving: string;
    savedStatus: string;
    disabling: string;
    disabledStatus: string;
    deleting: string;
    deletedStatus: string;
    importingOAuth: string;
    openingOAuth: string;
    oauthConnected: string;
    oauthFailed: string;
    checking: string;
    ready: string;
    notReady: string;
    importCodex: string;
    importClaude: string;
    importOAuth: string;
    signInChatGpt: string;
    oauthLogin: string;
    notConnected: string;
    oauthConnectedShort: string;
    apiKeySet: string;
    savedDisabled: string;
    oauthProfiles: string;
    deleteConfirm: string;
    oauthDescription: string;
  };
  slash: {
    progress: string;
    session: string;
    copy: string;
    stopRun: string;
    steer: string;
    followUp: string;
    stopSubagents: string;
    compact: string;
    model: string;
    settings: string;
    newSession: string;
  };
  commandResult: {
    noReply: string;
    copiedReply: string;
    copyFailed: string;
    stopBeforeCompact: string;
    compactionRunning: string;
    stopBeforeModel: string;
    stopBeforeSettings: string;
    stopBeforeNew: string;
    sessionCreated: string;
    noActiveWork: string;
    stopping: string;
    steerUnavailable: string;
    steerNeedsMessage: string;
    steerSent: string;
    followUpUnavailable: string;
    followUpNeedsMessage: string;
    followUpQueued: string;
  };
}

export const agentUiStrings: Record<AgentUiLocale, AgentUiStrings> = {
  "zh-CN": {
    emptyHint: "把翻译、校对、术语或项目检查任务交给 Agent。",
    hideSidebar: "隐藏会话栏",
    showSidebar: "显示会话栏",
    openNewWindow: "在新窗口打开",
    closeAgent: "关闭 Agent",
    compactingContext: "正在压缩上下文",
    stopBackgroundSubagents: "停止后台 subagent",
    deleteSession: "删除会话",
    estimatedStreamingTokens: "预估 token 数（流式接收中）",
    subagentClosed: "该 subagent 已关闭",
    subagentCollapsed: "该 subagent 已折叠",
    queuePlaceholder: "Steer 立即注入 / Follow-up 排队…",
    steerTitle: "立即注入当前运行",
    followUpTitle: "在当前运行后排队",
    sendTitle: "发送",
    attachImages: "添加图片",
    removeImage: "移除图片",
    imageInputUnsupported: "当前模型不支持图片输入",
    imageTooLarge: "单张图片不能超过 10 MB",
    imagesTooLarge: "图片总大小不能超过 20 MB",
    imageOnlyMessage: "[{count} 张图片]",
    thinkingLevelTitle: "切换推理强度",
    compactContext: "压缩上下文",
    stopAgent: "停止 Agent",
    newSession: "新建",
    sessions: "会话",
    noSessions: "暂无会话",
    untitledSession: "未命名会话",
    noProject: "未打开项目",
    deleteSessionConfirm: "要从磁盘中永久删除这个 Agent 会话吗？",
    thinking: "思考",
    copy: "复制",
    copied: "已复制",
    prompt: "任务",
    reply: "回复",
    loadingChildSession: "正在加载子 Agent 会话…",
    runningTools: "正在使用工具",
    thinkingActive: "思考中",
    runningCommand: "正在执行命令",
    stopping: "正在停止",
    retrying: "连接中断，正在自动重试（{attempt}/{maxAttempts}）",
    modelLabel: "模型",
    loadingModels: "正在加载模型",
    selectModel: "选择模型",
    showExtensionMessage: "显示扩展消息",
    hiddenExtensionMessage: "隐藏的扩展消息",
    noMessage: "无消息内容",
    noOutput: "无输出",
    expand: "展开",
    collapse: "折叠",
    showDetails: "显示详情",
    hideDetails: "隐藏详情",
    providerFailed: "模型服务失败，但没有返回错误信息。",
    notSelected: "未选择",
    loadingSession: "正在加载会话…",
    subagentsRunning: "{count} 个子 Agent 运行中 · 主 Agent 可交互",
    commands: "命令",
    noMatchingCommand: "没有匹配的命令",
    compactedTokens: "已压缩 {before} → {after} token（节省 {saved}）",
    compactingPlaceholder: "正在压缩上下文…",
    runningPlaceholder: "Agent 正在运行…",
    messagePlaceholder: "输入消息，键入 / 查看命令",
    queuedSteer: "即时指令",
    queuedFollowUp: "后续指令",
    queuedNextTurn: "下一轮",
    promptUnavailable: "任务内容不可用",
    replyUnavailable: "回复内容不可用",
    itemCount: "{count} 项",
    fieldCount: "{count} 个字段",
    sessionInfo: "会话信息",
    sessionShort: "会话",
    stats: {
      currentRun: "当前运行", state: "状态", running: "运行中", ready: "就绪", phase: "阶段", model: "模型", subagents: "子 Agent",
      subagentSummary: "{running} 个运行中 · {closed} 个已关闭", messages: "消息", user: "用户", assistant: "Agent", toolCalls: "工具调用",
      toolResults: "工具结果", tokens: "Token", input: "输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入", total: "总计", cost: "费用", context: "上下文"
    },
    status: { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", skipped: "已跳过", ready: "就绪", closed: "已关闭" },
    provider: {
      settings: "模型服务设置", close: "关闭", loading: "正在加载模型服务设置…", newCustom: "新建自定义服务",
      customEnabled: "自定义 · 已启用", customSaved: "自定义 · 已保存", enabled: "已启用", name: "名称", baseUrl: "接口地址",
      connectionStatus: "连接状态", noOAuthProfile: "尚未关联本机 OAuth 账号。", active: "当前使用", saved: "已保存",
      modelIds: "模型 ID（每行一个）", supportsImages: "这些自定义模型支持图片输入", defaultModel: "默认模型", apiKey: "API 密钥", keepSavedKey: "留空则保留已保存的密钥",
      pasteApiKey: "粘贴 API 密钥", test: "测试连接", disable: "停用", delete: "删除", enable: "启用", useProvider: "使用此服务", save: "保存"
      , addModel: "请至少填写一个模型 ID。", saving: "正在保存模型服务设置…", savedStatus: "已保存。", disabling: "正在停用模型服务…",
      disabledStatus: "已停用；设置仍保留。", deleting: "正在删除已保存的服务…", deletedStatus: "已删除。", importingOAuth: "正在导入 OAuth 登录…",
      openingOAuth: "正在打开 OAuth 登录…", oauthConnected: "OAuth 已连接。", oauthFailed: "OAuth 连接失败。", checking: "正在检查模型服务…",
      ready: "模型服务可用。", notReady: "模型服务尚不可用。", importCodex: "导入本机 Pi / Codex 登录", importClaude: "导入本机 Pi / Claude 登录",
      importOAuth: "导入本机 OAuth 登录", signInChatGpt: "使用 ChatGPT 登录", oauthLogin: "OAuth 登录"
      , notConnected: "未连接", oauthConnectedShort: "OAuth 已连接", apiKeySet: "已设置 API 密钥", savedDisabled: "已保存 · 已停用", oauthProfiles: "{count} 个 OAuth 账号",
      deleteConfirm: "要删除已保存的模型服务“{name}”吗？", oauthDescription: "使用本机订阅账号的 OAuth 登录。"
    },
    slash: {
      progress: "查看当前 Pi 运行进度",
      session: "查看会话统计",
      copy: "复制上一条 Agent 回复",
      stopRun: "停止当前运行",
      steer: "立即注入当前运行",
      followUp: "在当前运行后排队",
      stopSubagents: "停止后台 subagent",
      compact: "压缩当前 Pi 会话上下文",
      model: "选择已配置模型",
      settings: "配置 Provider",
      newSession: "新建会话"
    },
    commandResult: {
      noReply: "没有可复制的 Agent 回复。", copiedReply: "已复制最新 Agent 回复。", copyFailed: "无法复制最新 Agent 回复。",
      stopBeforeCompact: "请先停止正在运行的 Agent 工作再压缩上下文。", compactionRunning: "上下文压缩已在进行中。",
      stopBeforeModel: "请先停止当前运行再切换模型。", stopBeforeSettings: "请先停止当前运行再修改模型服务设置。",
      stopBeforeNew: "请先停止正在运行的 Agent 工作再新建会话。", sessionCreated: "已新建会话。", noActiveWork: "当前没有运行中的 Agent 工作。",
      stopping: "正在停止 Agent…", steerUnavailable: "只有 Agent 运行时才能即时注入指令。", steerNeedsMessage: "请在 /steer 后输入消息。",
      steerSent: "即时指令已发送。", followUpUnavailable: "只有 Agent 运行时才能安排后续指令。", followUpNeedsMessage: "请在 /followup 后输入消息。",
      followUpQueued: "后续指令已排队。"
    }
  },
  "en-US": {
    emptyHint: "Ask the Agent to translate, proofread, manage terminology, or inspect the project.",
    hideSidebar: "Hide session sidebar",
    showSidebar: "Show session sidebar",
    openNewWindow: "Open in new window",
    closeAgent: "Close Agent",
    compactingContext: "Compacting context",
    stopBackgroundSubagents: "Stop background subagents",
    deleteSession: "Delete session",
    estimatedStreamingTokens: "Estimated tokens while streaming",
    subagentClosed: "Subagent closed",
    subagentCollapsed: "Subagent collapsed",
    queuePlaceholder: "Steer now / queue a follow-up…",
    steerTitle: "Steer the current run",
    followUpTitle: "Queue after the current run",
    sendTitle: "Send",
    attachImages: "Attach images",
    removeImage: "Remove image",
    imageInputUnsupported: "The current model does not support image input",
    imageTooLarge: "Each image must be 10 MB or smaller",
    imagesTooLarge: "Images must be 20 MB or smaller in total",
    imageOnlyMessage: "[{count} image(s)]",
    thinkingLevelTitle: "Change thinking level",
    compactContext: "Compact context",
    stopAgent: "Stop Agent",
    newSession: "New",
    sessions: "Sessions",
    noSessions: "No sessions yet",
    untitledSession: "Untitled session",
    noProject: "No project",
    deleteSessionConfirm: "Delete this Agent session permanently from disk?",
    thinking: "Thinking",
    copy: "Copy",
    copied: "Copied",
    prompt: "Prompt",
    reply: "Reply",
    loadingChildSession: "Loading child session…",
    runningTools: "Running tools",
    thinkingActive: "Thinking",
    runningCommand: "Running command",
    stopping: "Stopping",
    retrying: "Connection interrupted. Retrying ({attempt}/{maxAttempts})",
    modelLabel: "Model",
    loadingModels: "Loading models",
    selectModel: "Select model",
    showExtensionMessage: "Show extension message",
    hiddenExtensionMessage: "hidden extension message",
    noMessage: "no message",
    noOutput: "no output",
    expand: "Expand",
    collapse: "Collapse",
    showDetails: "Show details",
    hideDetails: "Hide details",
    providerFailed: "The model provider failed without an error message.",
    notSelected: "Not selected",
    loadingSession: "Loading session…",
    subagentsRunning: "{count} subagent(s) running · Main Agent available",
    commands: "Commands",
    noMatchingCommand: "No matching command",
    compactedTokens: "Compacted {before} → {after} tokens ({saved} saved)",
    compactingPlaceholder: "Compacting context…",
    runningPlaceholder: "Agent is running…",
    messagePlaceholder: "Message… Type / for commands",
    queuedSteer: "Steer",
    queuedFollowUp: "Follow-up",
    queuedNextTurn: "Next turn",
    promptUnavailable: "prompt unavailable",
    replyUnavailable: "reply unavailable",
    itemCount: "{count} items",
    fieldCount: "{count} fields",
    sessionInfo: "Session info",
    sessionShort: "session",
    stats: {
      currentRun: "Current Run", state: "State", running: "Running", ready: "Ready", phase: "Phase", model: "Model", subagents: "Subagents",
      subagentSummary: "{running} running · {closed} closed", messages: "Messages", user: "User", assistant: "Assistant", toolCalls: "Tool Calls",
      toolResults: "Tool Results", tokens: "Tokens", input: "Input", output: "Output", cacheRead: "Cache Read", cacheWrite: "Cache Write", total: "Total", cost: "Cost", context: "Context"
    },
    status: { running: "Running", completed: "Completed", failed: "Failed", stopped: "Stopped", skipped: "Skipped", ready: "Ready", closed: "Closed" },
    provider: {
      settings: "Provider settings", close: "Close", loading: "Loading provider settings…", newCustom: "new custom provider",
      customEnabled: "custom · enabled", customSaved: "custom · saved", enabled: "enabled", name: "Name", baseUrl: "Base URL",
      connectionStatus: "Status", noOAuthProfile: "No local OAuth profile linked yet.", active: "active", saved: "saved",
      modelIds: "Model IDs (one per line)", supportsImages: "These custom models accept image input", defaultModel: "Default model", apiKey: "API key", keepSavedKey: "Leave blank to keep saved key",
      pasteApiKey: "Paste API key", test: "Test", disable: "Disable", delete: "Delete", enable: "Enable", useProvider: "Use provider", save: "Save"
      , addModel: "Add at least one model ID.", saving: "Saving provider settings…", savedStatus: "Saved.", disabling: "Disabling provider…",
      disabledStatus: "Disabled. Saved settings are retained.", deleting: "Deleting saved provider…", deletedStatus: "Deleted.", importingOAuth: "Importing OAuth session…",
      openingOAuth: "Opening OAuth login…", oauthConnected: "OAuth connected.", oauthFailed: "OAuth failed.", checking: "Checking provider…",
      ready: "Provider ready.", notReady: "Provider is not ready.", importCodex: "Import Pi / Codex login", importClaude: "Import Pi / Claude login",
      importOAuth: "Import local OAuth login", signInChatGpt: "Sign in with ChatGPT", oauthLogin: "OAuth login"
      , notConnected: "not connected", oauthConnectedShort: "OAuth connected", apiKeySet: "API key set", savedDisabled: "saved · disabled", oauthProfiles: "{count} OAuth profiles",
      deleteConfirm: "Delete saved provider \"{name}\"?", oauthDescription: "Use a local subscription OAuth session for this provider."
    },
    slash: {
      progress: "View current Pi run progress",
      session: "View session statistics",
      copy: "Copy the latest Agent reply",
      stopRun: "Stop the current run",
      steer: "Steer the current run immediately",
      followUp: "Queue after the current run",
      stopSubagents: "Stop background subagents",
      compact: "Compact the current Pi session context",
      model: "Select a configured model",
      settings: "Configure providers",
      newSession: "Create a new session"
    },
    commandResult: {
      noReply: "No assistant reply to copy.", copiedReply: "Copied the latest Agent reply.", copyFailed: "Could not copy the latest Agent reply.",
      stopBeforeCompact: "Stop active Agent work before compacting.", compactionRunning: "Context compaction is already running.",
      stopBeforeModel: "Stop the current run before changing models.", stopBeforeSettings: "Stop the current run before changing provider settings.",
      stopBeforeNew: "Stop active Agent work before creating a session.", sessionCreated: "New session created.", noActiveWork: "No Agent work is active.",
      stopping: "Stopping Agent…", steerUnavailable: "Steer is available only while the Agent is running.", steerNeedsMessage: "Add a message after /steer.",
      steerSent: "Steer sent.", followUpUnavailable: "Follow-up is available only while the Agent is running.", followUpNeedsMessage: "Add a message after /followup.",
      followUpQueued: "Follow-up queued."
    }
  }
};

export function normalizeAgentUiLocale(value: unknown): AgentUiLocale {
  return value === "en-US" ? "en-US" : "zh-CN";
}
