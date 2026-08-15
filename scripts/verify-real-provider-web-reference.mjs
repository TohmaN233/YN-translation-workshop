import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { piNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import {
  assistantVisibleText,
  copyProviderWorkspace,
  runNativePrompt,
  selectProvider,
  toolCallName,
  toolCalls
} from "./verify-real-provider-agent-smoke.mjs";

const url = "https://ja.wikipedia.org/wiki/%E3%82%BC%E3%83%8E%E3%83%B3%E3%82%B6%E3%83%BC%E3%83%89";
const providerId = String(process.env.TW_REAL_PROVIDER_ID || "openai-chatgpt").trim();
const modelId = String(process.env.TW_REAL_PROVIDER_MODEL || "gpt-5.4-mini").trim();
const configWorkspaceDir = String(process.env.TW_REAL_PROVIDER_CONFIG_WORKSPACE_DIR || "").trim();
const timeoutMs = Math.max(60_000, Number(process.env.TW_REAL_PROVIDER_TIMEOUT_MS || 180_000));
const keepTemp = /^(1|true|yes)$/iu.test(String(process.env.TW_REAL_PROVIDER_KEEP_TEMP || ""));
if (!configWorkspaceDir) {
  throw new Error("TW_REAL_PROVIDER_CONFIG_WORKSPACE_DIR is required.");
}

const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-web-reference-model-"));
const workspaceDir = path.join(outputDir, ".translation-workshop");
try {
  await copyProviderWorkspace(configWorkspaceDir, workspaceDir);
  const selection = await selectProvider(workspaceDir, providerId, modelId);
  const session = await piNativeSessionService.createSession(outputDir);
  const run = await runNativePrompt({
    outputDir,
    sessionId: session.id,
    prompt: [
      "必须调用 fetchWebReference 读取下面的网页，禁止依靠模型记忆猜测。",
      url,
      "只根据工具返回的网页正文，用简短中文回答：",
      "1. 智能手机应用服务何时开始？",
      "2. 服务何时结束？",
      "3. 谁负责世界观设定和原案？",
      "答案必须保留网页中的完整日期和日文人名。"
    ].join("\n"),
    providerId: selection.providerId,
    modelId: selection.modelId,
    thinkingLevel: "low"
  }, timeoutMs);
  const calls = toolCalls(run.messages);
  const fetchCall = calls.find((call) => toolCallName(call) === "fetchWebReference");
  if (!fetchCall) throw new Error("The real model did not call fetchWebReference.");
  const reply = assistantVisibleText(run.messages);
  for (const required of ["2019年9月10日", "2021年2月18日", "上遠野浩平"]) {
    if (!reply.includes(required)) {
      throw new Error(`The real model reply did not retain ${required}: ${reply}`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    nativePiHarness: true,
    providerId: selection.providerId,
    modelId: selection.modelId,
    tool: "fetchWebReference",
    acceptedMs: run.acceptedMs,
    firstEventMs: run.firstEventMs,
    firstAssistantDeltaMs: run.firstAssistantDeltaMs,
    totalMs: run.totalMs,
    updateEvents: run.updateEvents,
    reply,
    outputDir: keepTemp ? outputDir : undefined
  }, null, 2));
} finally {
  await piNativeSessionService.disposeWorkspace(outputDir).catch(() => {});
  if (!keepTemp) await rm(outputDir, { recursive: true, force: true });
}
