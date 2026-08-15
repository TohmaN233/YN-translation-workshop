#!/usr/bin/env node

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { readOAuthProfiles, writeOAuthProfiles } from "../src/main/agent/oauthProfilesStore.ts";
import { piNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import {
  readProviderConfig,
  updateProviderConfig,
  writeProviderConfig
} from "../src/main/agent/providerConfigStore.ts";
import {
  resolveTranslationCandidatePath,
  writeTranslationChunk
} from "../src/main/agent/writeTranslationChunk.ts";
import { resolveProofreadReportPath } from "../src/main/agent/writeProofreadFindings.ts";
import { buildProofreadPrompt, buildTranslatePrompt } from "../src/shared/core/prompts.ts";
import {
  splitTextLines,
  validateTranslationCandidate
} from "../src/shared/validation/translationValidator.ts";

const modulePath = fileURLToPath(import.meta.url);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function parseFlag(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

function normalizeConfigWorkspace(value) {
  const resolved = path.resolve(String(value || "").trim());
  return path.basename(resolved).toLowerCase() === ".translation-workshop"
    ? resolved
    : path.join(resolved, ".translation-workshop");
}

export function buildRealProviderSmokePlan(env = process.env) {
  const requested = parseFlag(env.TW_REAL_PROVIDER_SMOKE);
  return {
    requested,
    providerId: String(env.TW_REAL_PROVIDER_ID || "openai-chatgpt").trim(),
    modelId: String(env.TW_REAL_PROVIDER_MODEL || "gpt-5.4-mini").trim(),
    configWorkspaceDir: String(env.TW_REAL_PROVIDER_CONFIG_WORKSPACE_DIR || "").trim(),
    keepTemp: parseFlag(env.TW_REAL_PROVIDER_KEEP_TEMP),
    timeoutMs: Math.max(60_000, Number(env.TW_REAL_PROVIDER_TIMEOUT_MS || 720_000)),
    skipReason: requested ? "" : "Set TW_REAL_PROVIDER_SMOKE=1 to run the native Pi real-provider acceptance."
  };
}

export async function copyProviderWorkspace(sourceValue, targetWorkspaceDir) {
  if (!sourceValue) {
    await readProviderConfig(targetWorkspaceDir);
    return;
  }
  const sourceWorkspaceDir = normalizeConfigWorkspace(sourceValue);
  await mkdir(targetWorkspaceDir, { recursive: true });
  await writeProviderConfig(targetWorkspaceDir, await readProviderConfig(sourceWorkspaceDir));
  await writeOAuthProfiles(targetWorkspaceDir, await readOAuthProfiles(sourceWorkspaceDir));
  try {
    const project = JSON.parse(await readFile(path.join(sourceWorkspaceDir, "project.json"), "utf8"));
    await writeFile(path.join(targetWorkspaceDir, "project.json"), JSON.stringify({
      agentProxyEnabled: project.agentProxyEnabled === true,
      agentProxyUrl: typeof project.agentProxyUrl === "string" ? project.agentProxyUrl : ""
    }, null, 2), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function selectProvider(workspaceDir, providerId, modelId) {
  const config = await readProviderConfig(workspaceDir);
  const provider = config.providers[providerId];
  assert(provider?.type === "openai_compatible", `Provider ${providerId} is not configured.`);
  await updateProviderConfig(workspaceDir, {
    activeProviderId: providerId,
    provider: { ...provider, model: modelId || provider.model }
  });
  return { providerId, modelId: modelId || provider.model };
}

function eventType(envelope) {
  return envelope?.event && typeof envelope.event === "object" ? envelope.event.type : "";
}

function assistantBlockText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text" || block.type === "thinking")
    .map((block) => block.text || block.thinking || "")
    .join("\n");
}

export function assistantVisibleText(messages) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

export function toolCalls(messages) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content || [])
    .filter((block) => block.type === "toolCall");
}

export function toolCallName(call) {
  return call.toolName || call.name || "";
}

function toolCallInput(call) {
  return call.input ?? call.arguments ?? {};
}

function toolCallId(call) {
  return call.toolCallId || call.id || "";
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

export function assertTwoShardDelegations(calls, toolName, expectedRanges, workflowLabel) {
  const delegations = calls.filter((call) => toolCallName(call) === toolName);
  assert(delegations.length >= 1, `${workflowLabel} never called ${toolName}.`);
  for (const delegation of delegations) {
    const tasks = toolCallInput(delegation).tasks;
    assert(Array.isArray(tasks) && tasks.length === 2,
      `${workflowLabel} ${toolName} must request exactly two child tasks per batch.`);
    const ranges = tasks
      .map((task) => [Number(task.fromLine), Number(task.toLine)])
      .sort((left, right) => left[0] - right[0]);
    assert(JSON.stringify(ranges) === JSON.stringify(expectedRanges),
      `${workflowLabel} ${toolName} requested invalid coverage: ${JSON.stringify(ranges)}.`);
  }
  return delegations;
}

function subagentKindForCustomType(customType, workflowLabel) {
  if (customType === "subagent.translation") return "translation";
  if (customType === "subagent.proofread") return "proofread";
  assert.fail(`${workflowLabel} has no native child-completion kind for ${customType}.`);
}

function finalChildCompletion(messages, customType, workflowLabel) {
  const kind = subagentKindForCustomType(customType, workflowLabel);
  const completionIndex = messages.reduce((lastIndex, message, index) => (
    message.role === "custom"
      && message.customType === "subagent-completion"
      && message.details?.kind === kind
      ? index
      : lastIndex
  ), -1);
  assert(completionIndex >= 0,
    `${workflowLabel} retained no native Pi completion wake for its final child batch.`);
  const completion = messages[completionIndex];
  assert(completion.details?.status === "completed",
    `${workflowLabel} final native Pi child-completion wake is ${completion.details?.status || "missing"}.`);
  const children = completion.details?.subagents;
  assert(Array.isArray(children) && children.length === 2,
    `${workflowLabel} final native Pi completion wake did not identify exactly two children.`);
  assert(children.every((child) => child?.id && child.status === "completed"),
    `${workflowLabel} final native Pi completion wake did not report two completed children.`);
  return { completion, completionIndex, children };
}

export function finalCompletedSubagentPair(
  messages,
  customType,
  expectedRanges,
  workflowLabel,
  childTranscripts
) {
  const cards = messages.filter((message) => (
    message.role === "custom"
    && message.customType === customType
    && message.details?.subagentId
    && message.details?.status !== "running"
  ));
  assert(cards.length >= 2, `${workflowLabel} retained fewer than two terminal child cards.`);
  const { completion, children } = finalChildCompletion(messages, customType, workflowLabel);
  const finalPair = children.map((child) => cards.find((message) => (
    message.details?.subagentId === child.id
  )));
  assert(finalPair.every(Boolean),
    `${workflowLabel} final native Pi completion wake references a missing terminal child card.`);
  assert(finalPair.every((message) => message.details?.status === "completed" && message.details?.closed === true),
    `${workflowLabel} final replacement/current pair did not close successfully.`);
  const ranges = finalPair
    .map((message) => [Number(message.details?.fromLine), Number(message.details?.toLine)])
    .sort((left, right) => left[0] - right[0]);
  assert(JSON.stringify(ranges) === JSON.stringify(expectedRanges),
    `${workflowLabel} final pair did not cover the complete document: ${JSON.stringify(ranges)}.`);
  const expectedToolSequence = customType === "subagent.translation"
    ? ["readAssignedSource", "writeAssignedTranslation", "validateAssignedTranslation"]
    : customType === "subagent.proofread"
      ? ["readAssignedSource", "readAssignedTranslation", "writeAssignedFindings"]
      : undefined;
  assert(expectedToolSequence, `${workflowLabel} has no strict child tool sequence for ${customType}.`);
  assert(childTranscripts instanceof Map,
    `${workflowLabel} verifier requires child Pi JSONL transcripts keyed by child session id.`);
  assert(finalPair.every((message) => !Object.hasOwn(message.details || {}, "transcript")),
    `${workflowLabel} parent cards still duplicate child Pi transcripts.`);
  const transcriptCards = finalPair.map((message) => ({
    ...message,
    details: {
      ...message.details,
      transcript: childTranscripts.get(message.details?.subagentId)
    }
  }));
  assertCompleteSubagentTranscripts(transcriptCards, workflowLabel, expectedToolSequence);
  return { cards, finalPair, completion };
}

async function loadChildTranscripts(service, outputDir, parentSessionId, messages, customType) {
  const ids = [...new Set(messages
    .filter((message) => message.role === "custom" && message.customType === customType)
    .map((message) => message.details?.subagentId)
    .filter(Boolean))];
  return new Map(await Promise.all(ids.map(async (childSessionId) => [
    childSessionId,
    await service.loadSubagentMessages(outputDir, parentSessionId, childSessionId)
  ])));
}

export function assertParentResumedAfterFinalChildren(
  messages,
  customType,
  workflowLabel,
  requiredToolNames = []
) {
  const { completionIndex } = finalChildCompletion(messages, customType, workflowLabel);
  const parentTail = messages.slice(completionIndex + 1);
  const tailCalls = toolCalls(parentTail);
  const tailCallNames = tailCalls.map(toolCallName);
  for (const requiredToolName of requiredToolNames) {
    assert(tailCallNames.includes(requiredToolName),
      `${workflowLabel} parent did not call ${requiredToolName} after the final child batch.`);
    const call = tailCalls.find((candidate) => toolCallName(candidate) === requiredToolName);
    const callId = toolCallId(call);
    assert(callId, `${workflowLabel} parent ${requiredToolName} call has no native Pi tool-call id.`);
    assert(parentTail.some((message) => (
      message.role === "toolResult"
      && message.toolCallId === callId
      && message.toolName === requiredToolName
      && message.isError !== true
    )), `${workflowLabel} parent ${requiredToolName} has no paired successful result after the final child batch.`);
  }
  const finalAssistantIndex = parentTail.findLastIndex((message) => (
    message.role === "assistant"
    && message.stopReason !== "error"
    && messageText(message)
  ));
  assert(finalAssistantIndex >= 0,
    `${workflowLabel} parent never produced a final reply after the final child batch.`);
  for (const requiredToolName of requiredToolNames) {
    const requiredCallIndex = parentTail.findIndex((message) => (
      message.role === "assistant"
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === "toolCall" && toolCallName(block) === requiredToolName)
    ));
    assert(requiredCallIndex >= 0 && finalAssistantIndex > requiredCallIndex,
      `${workflowLabel} final parent reply did not follow ${requiredToolName}.`);
  }
  return parentTail[finalAssistantIndex];
}

export function hasParentReplyAfterFinalChildren(messages, customType) {
  try {
    assertParentResumedAfterFinalChildren(messages, customType, customType);
    return true;
  } catch {
    return false;
  }
}

function assertCleanTranscript(messages) {
  const visible = assistantVisibleText(messages);
  for (const forbidden of [
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "to=host_tool",
    "eventRef",
    "tool_execution_start",
    "waiting_for_human"
  ]) {
    assert(!visible.includes(forbidden), `Raw runtime text leaked into assistant prose: ${forbidden}`);
  }
}

export function assertCompleteSubagentTranscripts(cards, workflowLabel, expectedToolSequence) {
  for (const card of cards) {
    const label = card.details?.label || "subagent";
    const transcript = card.details?.transcript;
    assert(Array.isArray(transcript) && transcript.length > 0,
      `${workflowLabel} ${label} retained only a summary reply.`);
    const firstMessage = transcript[0];
    assert(firstMessage?.role === "user" && messageText(firstMessage),
      `${workflowLabel} ${label} retained no initial native Pi user prompt.`);
    assert(messageText(firstMessage) === String(card.details?.prompt || "").trim(),
      `${workflowLabel} ${label} initial transcript prompt does not match its card prompt.`);

    const calls = [];
    const results = [];
    for (const [messageIndex, message] of transcript.entries()) {
      if (message.role === "assistant") {
        assert(message.stopReason !== "error" && !message.errorMessage,
          `${workflowLabel} ${label} retained an assistant error inside a completed child.`);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === "toolCall") calls.push({ block, messageIndex });
        }
      } else if (message.role === "toolResult") {
        results.push({ message, messageIndex });
      } else if (message.role === "user") {
        assert(messageText(message), `${workflowLabel} ${label} retained an empty user/Steer message.`);
      } else {
        assert.fail(`${workflowLabel} ${label} retained unsupported transcript role ${message.role}.`);
      }
    }
    assert(calls.length > 0, `${workflowLabel} ${label} retained no native Pi tool call.`);
    assert(results.length > 0, `${workflowLabel} ${label} retained no native Pi tool result.`);

    const callById = new Map();
    for (const call of calls) {
      const id = toolCallId(call.block);
      assert(id, `${workflowLabel} ${label} retained a tool call without an id.`);
      assert(!callById.has(id), `${workflowLabel} ${label} retained duplicate tool-call id ${id}.`);
      callById.set(id, call);
      const pairedResults = results.filter((result) => result.message.toolCallId === id);
      assert(pairedResults.length === 1,
        `${workflowLabel} ${label} tool ${toolCallName(call.block)} must have exactly one paired result; found ${pairedResults.length}.`);
      const [paired] = pairedResults;
      assert(paired.message.toolName === toolCallName(call.block),
        `${workflowLabel} ${label} tool/result names disagree for ${id}.`);
      assert(paired.messageIndex > call.messageIndex,
        `${workflowLabel} ${label} tool result precedes its call for ${id}.`);
      assert(paired.message.isError !== true,
        `${workflowLabel} ${label} retained a failed tool result for ${toolCallName(call.block)} (${id}).`);
    }
    const resultIds = new Set();
    for (const result of results) {
      const id = result.message.toolCallId;
      assert(id, `${workflowLabel} ${label} retained a tool result without a native Pi id.`);
      assert(!resultIds.has(id), `${workflowLabel} ${label} retained duplicate tool result ${id}.`);
      resultIds.add(id);
      assert(callById.has(id),
        `${workflowLabel} ${label} retained orphan tool result ${id}.`);
    }

    let sequenceIndex = -1;
    for (const expectedToolName of expectedToolSequence) {
      sequenceIndex = calls.findIndex((call, index) => (
        index > sequenceIndex && toolCallName(call.block) === expectedToolName
      ));
      assert(sequenceIndex >= 0,
        `${workflowLabel} ${label} did not retain required tool sequence ${expectedToolSequence.join(" -> ")}.`);
    }

    const finalMessage = transcript.at(-1);
    const finalReply = messageText(finalMessage);
    assert(finalMessage?.role === "assistant" && finalMessage.stopReason !== "error" && finalReply,
      `${workflowLabel} ${label} retained no final native Pi assistant reply.`);
    assert(finalReply === String(card.details?.reply || "").trim(),
      `${workflowLabel} ${label} card reply is not the final native Pi assistant reply.`);
  }
}

async function nativeFailureDiagnostics(request, state, events, service = piNativeSessionService) {
  let messages = [];
  let loadError;
  try {
    messages = await service.loadMessages(request.outputDir, request.sessionId);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  const cards = [
    ...(Array.isArray(state?.subagentMessages) ? state.subagentMessages : []),
    ...messages.filter((message) => message.role === "custom" && message.details?.subagentId)
  ];
  const cardsById = new Map();
  for (const card of cards) {
    const id = card.details?.subagentId;
    if (typeof id === "string" && id) cardsById.set(id, card);
  }
  return {
    sessionId: request.sessionId,
    runError: state?.error,
    running: state?.running,
    eventTypes: events.map(eventType),
    toolCalls: toolCalls(messages).map(toolCallName),
    assistantErrors: messages
      .filter((message) => message.role === "assistant" && (message.errorMessage || message.stopReason === "error"))
      .map((message) => ({ stopReason: message.stopReason, errorMessage: message.errorMessage })),
    subagents: [...cardsById.values()].map((card) => ({
      id: card.details?.subagentId,
      label: card.details?.label,
      status: card.details?.status,
      closed: card.details?.closed,
      providerId: card.details?.providerId,
      modelId: card.details?.modelId,
      error: card.details?.error,
      result: card.details?.result
    })),
    loadError
  };
}

export async function runNativePrompt(request, timeoutMs, options = {}) {
  const startedAt = performance.now();
  const service = options.service || piNativeSessionService;
  const events = [];
  let firstEventMs;
  let firstAssistantDeltaMs;
  let settledCount = 0;
  const minimumSettled = Math.max(1, Number(options.minimumSettled || 1));
  const terminalTranscriptReady = options.terminalTranscriptReady || (() => true);
  let checkedTerminalAtSettled = -1;
  let terminalMessages;
  const resolvedWorkspace = path.resolve(request.outputDir).toLowerCase();
  const unsubscribe = service.subscribeEvents((envelope) => {
    if (path.resolve(envelope.workspaceDir).toLowerCase() !== resolvedWorkspace) return;
    if (envelope.sessionId !== request.sessionId) return;
    events.push(envelope);
    firstEventMs ??= performance.now() - startedAt;
    if (eventType(envelope) === "message_update" && assistantBlockText(envelope.event.message).trim()) {
      firstAssistantDeltaMs ??= performance.now() - startedAt;
    }
    if (eventType(envelope) === "settled") settledCount += 1;
  });

  try {
    const acceptance = await service.prompt(request);
    const acceptedMs = performance.now() - startedAt;
    assert(acceptance.accepted, "Native Pi prompt was not accepted.");
    assert(acceptedMs < 3000, `Native Pi prompt acceptance took ${acceptedMs.toFixed(1)}ms.`);
    const deadline = Date.now() + timeoutMs;
    let terminalState;
    while (Date.now() < deadline) {
      const state = await service.getRunState(request.outputDir, request.sessionId);
      if (state.error && !state.running) {
        const diagnostics = await nativeFailureDiagnostics(request, state, events, service);
        throw new Error(`${state.error}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
      }
      const runningSubagents = state.subagentMessages.some((message) => message.details?.status === "running");
      if (
        !state.running
        && !runningSubagents
        && events.length > 0
        && settledCount >= minimumSettled
        && checkedTerminalAtSettled !== settledCount
      ) {
        checkedTerminalAtSettled = settledCount;
        const candidateMessages = await service.loadMessages(request.outputDir, request.sessionId);
        if (terminalTranscriptReady(candidateMessages, state)) {
          terminalState = state;
          terminalMessages = candidateMessages;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = terminalState ?? await service.getRunState(request.outputDir, request.sessionId);
    assert(
      !state.running
        && !state.subagentMessages.some((message) => message.details?.status === "running")
        && settledCount >= minimumSettled,
      `Native Pi session ${request.sessionId} did not complete ${minimumSettled} parent turn(s) within ${timeoutMs}ms.`
    );
    if (state.error) {
      const diagnostics = await nativeFailureDiagnostics(request, state, events, service);
      throw new Error(`${state.error}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
    }
    const messages = terminalMessages ?? await service.loadMessages(request.outputDir, request.sessionId);
    assert(terminalTranscriptReady(messages, state),
      `Native Pi session ${request.sessionId} reached idle without its required terminal parent transcript.`);
    assert(firstEventMs !== undefined && firstEventMs < 3000,
      `Native Pi emitted no immediate harness event; first event ${firstEventMs ?? "missing"}ms.`);
    assert(firstAssistantDeltaMs !== undefined,
      `Native Pi produced no live assistant delta for session ${request.sessionId}.`);
    assertCleanTranscript(messages);
    return {
      acceptedMs: Number(acceptedMs.toFixed(1)),
      firstEventMs: Number(firstEventMs.toFixed(1)),
      firstAssistantDeltaMs: Number(firstAssistantDeltaMs.toFixed(1)),
      totalMs: Number((performance.now() - startedAt).toFixed(1)),
      updateEvents: events.filter((entry) => eventType(entry) === "message_update").length,
      messages,
      events
    };
  } finally {
    unsubscribe();
  }
}

async function runChatAcceptance(outputDir, selection, timeoutMs) {
  const session = await piNativeSessionService.createSession(outputDir);
  const run = await runNativePrompt({
    outputDir,
    sessionId: session.id,
    prompt: "请用一句简短中文确认真实 Pi Agent 已连接并可以继续。",
    providerId: selection.providerId,
    modelId: selection.modelId,
    thinkingLevel: "medium"
  }, timeoutMs);
  assert(assistantVisibleText(run.messages), "Real provider ordinary chat returned no assistant text.");
  assert(run.updateEvents >= 2, `Expected incremental Pi message updates, received ${run.updateEvents}.`);
  return { session, run, reply: assistantVisibleText(run.messages) };
}

async function runTranslationAcceptance(outputDir, selection, sourcePath, timeoutMs) {
  const session = await piNativeSessionService.createSession(outputDir);
  const workflowPrompt = buildTranslatePrompt({
    sourcePath,
    outputDir,
    advanced: {
      languagePair: "ja->zh-CN",
      style: "game",
      split: true,
      splitSize: 2,
      glossaryCandidates: true,
      characterBible: true
    }
  });
  const run = await runNativePrompt({
    outputDir,
    sessionId: session.id,
    prompt: [workflowPrompt,
      "真实验收附加约束：",
      "必须调用 runTranslationSubagents，并且恰好并行启动两个原生 Pi subagent：第一个只负责第 1-2 行，第二个只负责第 3-4 行。",
      "所有译文必须由 subagent 通过受限写入工具保存。启动后结束当前 parent turn；隐藏 completion follow-up 到达后再调用 validateTranslationArtifact。",
      "保留空行、{player_name}、<color=#FF0000>、</color>、%s 与字面控制码 \\n。不要修改源文件。",
      "只有整份候选通过最终 host validation 后才报告完成。"
    ].join("\n"),
    providerId: selection.providerId,
    modelId: selection.modelId,
    thinkingLevel: "medium",
    workflowIntent: "translation",
    languagePair: "ja->zh-CN",
    sourcePath
  }, timeoutMs, {
    terminalTranscriptReady: (messages) => hasParentReplyAfterFinalChildren(messages, "subagent.translation")
  });

  const calls = toolCalls(run.messages);
  const callNames = calls.map(toolCallName);
  for (const required of ["inspectTranslationContext", "runTranslationSubagents", "validateTranslationArtifact"]) {
    assert(callNames.includes(required), `Real translation did not call ${required}. Calls: ${callNames.join(", ")}`);
  }
  const delegations = assertTwoShardDelegations(
    calls,
    "runTranslationSubagents",
    [[1, 2], [3, 4]],
    "Real translation"
  );
  assertParentResumedAfterFinalChildren(
    run.messages,
    "subagent.translation",
    "Real translation",
    ["validateTranslationArtifact"]
  );
  const { cards: subagentCards, finalPair: finalSubagentPair } = finalCompletedSubagentPair(
    run.messages,
    "subagent.translation",
    [[1, 2], [3, 4]],
    "Real translation",
    await loadChildTranscripts(piNativeSessionService, outputDir, session.id, run.messages, "subagent.translation")
  );

  const candidatePath = resolveTranslationCandidatePath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: path.basename(sourcePath)
  });
  const [sourceText, candidateText] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(candidatePath, "utf8")
  ]);
  const validation = validateTranslationCandidate(sourceText, candidateText, {
    locale: "zh-CN",
    languagePair: "ja->zh-CN",
    detectUntranslated: true
  });
  assert(validation.ok, `Real translation failed structural validation: ${validation.summary}`);
  assert(!validation.warnings.some((finding) => finding.code === "likely_untranslated"),
    `Real translation contains untranslated residue: ${validation.summary}`);
  for (const relativePath of [
    "AI_translation/_workspace/glossary_candidates.json",
    "AI_translation/_workspace/character_bible.md"
  ]) {
    const content = await readFile(path.join(outputDir, relativePath), "utf8");
    assert(content.trim(), `Real translation did not create ${relativePath}.`);
  }
  return {
    session,
    run,
    calls: callNames,
    delegationBatches: delegations.length,
    subagentCards,
    finalSubagentPair,
    candidatePath,
    candidateText,
    validation
  };
}

async function runProofreadAcceptance(outputDir, selection, timeoutMs) {
  const sourcePath = path.join(outputDir, "proofread-source.txt");
  const sourceLines = ["勇者は剣を抜いた。", "彼は「明日出発する」と言った。"];
  await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
  const seeded = await writeTranslationChunk({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: path.basename(sourcePath),
    fromLine: 1,
    toLine: 2,
    lines: ["勇者收起了剑。", "他说：“昨天已经出发了”。"]
  });
  assert(seeded.ok, seeded.error || "Could not seed proofread candidate.");
  assert(seeded.path, "Seeded proofread candidate has no path.");
  const session = await piNativeSessionService.createSession(outputDir);
  const workflowPrompt = buildProofreadPrompt({
    sourcePath,
    translationPath: seeded.path,
    outputDir,
    advanced: {
      languagePair: "ja->zh-CN",
      style: "game",
      proofreadMode: "split",
      splitSize: 1,
    }
  });
  const run = await runNativePrompt({
    outputDir,
    sessionId: session.id,
    prompt: [workflowPrompt,
      "真实验收附加约束：",
      "当前两行译文在语义上故意写反。必须调用 runProofreadSubagents，并且恰好并行启动两个原生 Pi subagent：第一个只校对第 1 行，第二个只校对第 2 行。",
      "每个子 Agent 至少写一条准确 finding。启动后结束当前 parent turn；隐藏 completion follow-up 到达后再汇总，不要直接覆盖译文。"
    ].join("\n"),
    providerId: selection.providerId,
    modelId: selection.modelId,
    thinkingLevel: "medium",
    workflowIntent: "proofread",
    languagePair: "ja->zh-CN",
    sourcePath,
    translationPath: seeded.path
  }, timeoutMs, {
    terminalTranscriptReady: (messages) => hasParentReplyAfterFinalChildren(messages, "subagent.proofread")
  });
  const callNames = toolCalls(run.messages).map(toolCallName);
  for (const required of ["inspectTranslationContext", "runProofreadSubagents"]) {
    assert(callNames.includes(required), `Real proofread did not call ${required}. Calls: ${callNames.join(", ")}`);
  }
  const delegations = assertTwoShardDelegations(
    toolCalls(run.messages),
    "runProofreadSubagents",
    [[1, 1], [2, 2]],
    "Real proofreading"
  );
  assertParentResumedAfterFinalChildren(
    run.messages,
    "subagent.proofread",
    "Real proofreading"
  );
  const { cards: subagentCards, finalPair: finalSubagentPair } = finalCompletedSubagentPair(
    run.messages,
    "subagent.proofread",
    [[1, 1], [2, 2]],
    "Real proofreading",
    await loadChildTranscripts(piNativeSessionService, outputDir, session.id, run.messages, "subagent.proofread")
  );
  const reportPath = resolveProofreadReportPath({
    outputDir,
    sourcePaths: [sourcePath],
    documentId: path.basename(sourcePath),
    kind: "findings_json"
  });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert(report.schemaVersion === "1.0", "Proofread report schema version is invalid.");
  assert(Array.isArray(report.findings) && report.findings.length >= 2,
    `Expected at least two proofread findings, received ${report.findings?.length ?? 0}.`);
  return {
    session,
    run,
    calls: callNames,
    delegationBatches: delegations.length,
    subagentCards,
    finalSubagentPair,
    reportPath,
    findingCount: report.findings.length
  };
}

async function main() {
  const plan = buildRealProviderSmokePlan();
  if (!plan.requested) {
    console.log(JSON.stringify({ skipped: true, reason: plan.skipReason }, null, 2));
    return;
  }
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-pi-native-real-provider-"));
  const workspaceDir = path.join(outputDir, ".translation-workshop");
  const sourcePath = path.join(outputDir, "real-provider-source.txt");
  const sourceLines = [
    "ゼートレートは「{player_name}」に頷いた。",
    "",
    "<color=#FF0000>アンナ</color>は端末に%sを入力した。",
    "レヴィルは「準備\\n完了」と答えた。"
  ];
  try {
    await copyProviderWorkspace(plan.configWorkspaceDir, workspaceDir);
    const selection = await selectProvider(workspaceDir, plan.providerId, plan.modelId);
    await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
    const chat = await runChatAcceptance(outputDir, selection, plan.timeoutMs);
    const translation = await runTranslationAcceptance(outputDir, selection, sourcePath, plan.timeoutMs);
    const proofread = await runProofreadAcceptance(outputDir, selection, plan.timeoutMs);
    await access(translation.candidatePath);
    await access(proofread.reportPath);
    console.log(JSON.stringify({
      ok: true,
      nativePiHarness: true,
      providerId: selection.providerId,
      modelId: selection.modelId,
      chat: {
        acceptedMs: chat.run.acceptedMs,
        firstEventMs: chat.run.firstEventMs,
        firstAssistantDeltaMs: chat.run.firstAssistantDeltaMs,
        totalMs: chat.run.totalMs,
        updateEvents: chat.run.updateEvents,
        reply: chat.reply
      },
      translation: {
        totalMs: translation.run.totalMs,
        calls: translation.calls,
        delegationBatches: translation.delegationBatches,
        terminalSubagents: translation.subagentCards.length,
        finalSubagents: translation.finalSubagentPair.length,
        candidatePath: translation.candidatePath,
        validation: translation.validation.summary,
        lineCount: splitTextLines(translation.candidateText).length
      },
      proofread: {
        totalMs: proofread.run.totalMs,
        calls: proofread.calls,
        delegationBatches: proofread.delegationBatches,
        terminalSubagents: proofread.subagentCards.length,
        finalSubagents: proofread.finalSubagentPair.length,
        reportPath: proofread.reportPath,
        findings: proofread.findingCount
      },
      outputDir: plan.keepTemp ? outputDir : undefined
    }, null, 2));
  } finally {
    await piNativeSessionService.disposeWorkspace(outputDir).catch(() => {});
    if (!plan.keepTemp) await rm(outputDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
