import type { ServerResponse } from "node:http";

import type { UiLocale } from "../shared/core/html.ts";
import type { LanSyncSession } from "./lanSyncState.ts";

export function lanSyncLabels(locale: UiLocale): Record<string, string> {
  if (locale === "en-US") {
    return {
      title: "translation-workshop shared workspace",
      loading: "Loading...",
      previous: "Previous",
      next: "Next",
      go: "Go",
      page: "Page",
      total: "Total",
      search: "Search",
      searchPlaceholder: "Search source, translation, issue, or suggestion",
      searchNoMatches: "No matches.",
      controlsOpen: "Show tools",
      controlsClose: "Hide tools",
      agentTab: "Agent",
      openDesktopAgent: "Open desktop Agent",
      openingDesktopAgent: "Opening desktop Agent...",
      openedDesktopAgent: "Desktop Agent opened",
      openDesktopAgentFailed: "Could not open desktop Agent",
      saved: "Synced",
      offline: "Disconnected",
      line: "Line",
      source: "Source",
      translation: "Translation",
      current: "Current translation",
      issueType: "Issue type",
      issue: "Issue",
      suggestion: "Suggested fix",
      accept: "Accept",
      reject: "Reject",
      manual: "Manual edit",
      unreviewed: "Unreviewed",
      lineTab: "Line review",
      proposalTab: "Proposal review",
      empty: "No document in this shared session.",
      pinTitle: "Enter PIN",
      pinHelp: "Use the fixed 6-digit PIN shown in the desktop app.",
      pinPlaceholder: "6-digit PIN",
      unlock: "Unlock",
      pinInvalid: "PIN must be 6 digits.",
      pinFailed: "PIN verification failed."
    };
  }
  return {
    title: "translation-workshop 共享工作区",
    loading: "加载中...",
    previous: "上一页",
    next: "下一页",
    go: "跳转",
    page: "页码",
    total: "总数",
    search: "搜索",
    searchPlaceholder: "搜索原文、译文、问题或建议",
    searchNoMatches: "没有匹配结果。",
    controlsOpen: "展开工具",
      controlsClose: "收起工具",
      agentTab: "Agent",
    openDesktopAgent: "打开桌面 Agent",
    openingDesktopAgent: "正在打开桌面 Agent...",
    openedDesktopAgent: "桌面 Agent 已打开",
    openDesktopAgentFailed: "无法打开桌面 Agent",
    saved: "已同步",
    offline: "连接已断开",
    line: "行",
    source: "源文",
    translation: "译文",
    current: "当前译文",
    issueType: "问题类型",
    issue: "问题说明",
    suggestion: "建议译文",
    accept: "接受",
    reject: "拒绝",
    manual: "人工改写",
    unreviewed: "未审阅",
    lineTab: "正文校对",
    proposalTab: "审阅建议",
    empty: "当前共享会话没有文档。",
    pinTitle: "输入 PIN",
    pinHelp: "请输入桌面端设置的固定 6 位 PIN。",
    pinPlaceholder: "6 位 PIN",
    unlock: "解锁",
    pinInvalid: "PIN 必须是 6 位数字。",
    pinFailed: "PIN 验证失败。"
  };
}

export function lanSyncJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function lanSyncResponse(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

export function lanSyncEscapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  }[character] ?? character));
}

export function lanSyncLandingHtml(sessions: Iterable<LanSyncSession>): string {
  const items = [...sessions];
  const links = items
    .map((session) => `<li><a href="/s/${encodeURIComponent(session.token)}">${lanSyncEscapeHtml(session.title || "translation-workshop")}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>translation-workshop</title>
  <style>
    body { margin:0; padding:28px; font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#263452; background:#f5fbff; }
    main { max-width:680px; margin:auto; padding:24px; border:1px solid #d8e7f8; border-radius:12px; background:#fff; box-shadow:0 16px 38px rgba(78,105,150,.12); }
    h1 { margin:0 0 12px; font-size:24px; }
    p { margin:8px 0; color:#66708b; }
    a { color:#1f6fb2; font-weight:700; }
  </style>
</head>
<body>
  <main>
    <h1>translation-workshop</h1>
    ${items.length > 0
      ? `<p>请选择当前同步会话。外部穿透工具只给根地址时，也可以从这里进入。</p><ul>${links}</ul>`
      : `<p>没有正在运行的同步会话。请先在桌面端 HTML 中启动局域网同步。</p>`}
    <p>如果你使用 Cloudflare Tunnel/ngrok，请把穿透目标指向桌面端显示的本地同步端口。</p>
  </main>
</body>
</html>`;
}

export function lanSyncSessionNotFoundHtml(requestedPath: string, sessions: Iterable<LanSyncSession>): string {
  const items = [...sessions];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Session not found</title>
  <style>
    body { margin:0; padding:28px; font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#263452; background:#fff7f7; }
    main { max-width:720px; margin:auto; padding:24px; border:1px solid #f2c4c4; border-radius:12px; background:#fff; box-shadow:0 16px 38px rgba(150,78,78,.12); }
    code { padding:2px 5px; border-radius:5px; background:#f7eef0; }
    a { color:#1f6fb2; font-weight:700; }
  </style>
</head>
<body>
  <main>
    <h1>Session not found</h1>
    <p>找不到这个同步会话：<code>${lanSyncEscapeHtml(requestedPath)}</code></p>
    <p>如果你正在使用 Cloudflare Tunnel/ngrok，请确认公网地址后面保留了桌面端链接中的 <code>/s/...</code> 路径。</p>
    <p>当前正在运行的会话数：${items.length}。${items.length === 1 ? `可以尝试打开 <a href="/s/${encodeURIComponent(items[0].token)}">当前会话</a>。` : `可以返回 <a href="/">同步入口</a>。`}</p>
  </main>
</body>
</html>`;
}
