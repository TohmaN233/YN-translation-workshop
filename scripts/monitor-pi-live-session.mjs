#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

const sessionPath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const intervalMs = Number(process.argv[4] ?? 15_000);
const sampleCount = Number(process.argv[5] ?? 40);

if (!sessionPath || !outputDir) {
  throw new Error(
    "Usage: node scripts/monitor-pi-live-session.mjs <parent-session.jsonl> <translation-output-dir> [interval-ms] [sample-count]"
  );
}
if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
  throw new Error(`interval-ms must be an integer >= 1000, received ${intervalMs}.`);
}
if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  throw new Error(`sample-count must be a positive integer, received ${sampleCount}.`);
}

const sessionDir = path.dirname(sessionPath);
const childSessionDir = path.join(
  path.dirname(path.dirname(sessionDir)),
  "pi-child-sessions",
  path.basename(sessionDir)
);
const previous = new Map();
const TERMINAL_HOST_TOOLS = new Set(["validateAssignedTranslation", "submitTranslationReview"]);

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readFirstJsonEntry(filePath) {
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  try {
    for await (const line of lines) {
      if (line.trim()) return JSON.parse(line);
    }
  } finally {
    lines.close();
  }
  return undefined;
}

async function sessionFiles() {
  const files = [sessionPath];
  let entries = [];
  try {
    entries = await readdir(childSessionDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(childSessionDir, entry.name);
    const header = await readFirstJsonEntry(filePath);
    if (
      header?.type === "session"
      && typeof header.parentSession === "string"
      && normalizedPath(header.parentSession) === normalizedPath(sessionPath)
    ) {
      files.push(filePath);
    }
  }
  return files;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function errorFingerprint(value, maximum = 240) {
  return String(value ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function incrementCount(counts, key, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function reviewSelectedCount(details) {
  if (!Array.isArray(details?.windows)) return 0;
  return details.windows.reduce((count, window) => (
    count + (Array.isArray(window?.rows)
      ? window.rows.filter((row) => row?.selected === true).length
      : 0)
  ), 0);
}

function sessionAlerts(result) {
  const alerts = [];
  if (result.errors > 0) alerts.push(`assistant_errors:${result.errors}`);
  if (result.fetchErrors > 0) alerts.push(`fetch_errors:${result.fetchErrors}`);
  if (result.providerTransportDiagnostics > 0) {
    alerts.push(`provider_transport_diagnostics:${result.providerTransportDiagnostics}`);
  }
  if (result.toolErrors > 0) alerts.push(`tool_errors:${result.toolErrors}`);
  if (result.checkpointPersistenceFailures > 0) {
    alerts.push(`checkpoint_persistence_failures:${result.checkpointPersistenceFailures}`);
  }
  if (result.redundantTerminalContinuations > 0) {
    alerts.push(`redundant_terminal_continuations:${result.redundantTerminalContinuations}`);
  }
  if (result.validationAttempts > result.writeAttempts) {
    alerts.push(`validation_loop:${result.validationAttempts}/${result.writeAttempts}`);
  }
  if (result.maxSearchResultBytes > 16_384) {
    alerts.push(`large_search_result:${result.maxSearchResultBytes}`);
  }
  if (result.oversizedModelVisibleToolResults > 0) {
    alerts.push(`oversized_model_visible_tool_results:${result.oversizedModelVisibleToolResults}`);
  }
  if (result.hiddenRepairTurns > 0) alerts.push(`hidden_repair_turns:${result.hiddenRepairTurns}`);
  if (result.duplicateValidationResults > 0) {
    alerts.push(`duplicate_validation_results:${result.duplicateValidationResults}`);
  }
  if (result.syntheticZeroCountReconciliations > 0) {
    alerts.push(`synthetic_zero_count_reconciliations:${result.syntheticZeroCountReconciliations}`);
  }
  if (result.completionStateContradictions > 0) {
    alerts.push(`completion_state_contradictions:${result.completionStateContradictions}`);
  }
  return alerts;
}

async function analyzeSession(filePath) {
  const info = await stat(filePath);
  const result = {
    file: path.basename(filePath),
    bytes: info.size,
    latestTimestamp: undefined,
    compactions: 0,
    errors: 0,
    assistantErrorFingerprints: {},
    fetchErrors: 0,
    toolErrors: 0,
    toolErrorFingerprints: {},
    providerTransportDiagnostics: 0,
    providerTransportResets: 0,
    checkpointPersistenceFailures: 0,
    hiddenRepairTurns: 0,
    hiddenRepairTokens: 0,
    duplicateValidationResults: 0,
    syntheticZeroCountReconciliations: 0,
    completionStateContradictions: 0,
    redundantTerminalContinuations: 0,
    redundantTerminalTokens: 0,
    validationAttempts: 0,
    writeAttempts: 0,
    reviewSubmissions: 0,
    searchResultBytes: 0,
    durableSearchDetailsBytes: 0,
    maxSearchResultBytes: 0,
    toolCalls: {},
    oversizedToolResultsByName: {},
    oversizedModelVisibleToolResultsByName: {},
    reviewReads: [],
    reviewSubmits: [],
    usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
    oversizedToolResults: 0,
    oversizedModelVisibleToolResults: 0,
    maxToolResultBytes: 0,
    maxModelVisibleToolResultBytes: 0,
    maxDurableToolDetailsBytes: 0,
    modelVisibleToolResultBytes: 0,
    durableToolDetailsBytes: 0
  };
  const validationResultHashes = new Map();
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let pendingTerminalTool;
  let hiddenRepairActive = false;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    result.latestTimestamp = entry.timestamp ?? result.latestTimestamp;
    if (entry.type === "compaction") result.compactions += 1;
    if (entry.type === "custom") {
      if (entry.customType === "yn_provider_transport_error") result.providerTransportDiagnostics += 1;
      if (entry.customType === "yn_provider_transport_reset") result.providerTransportResets += 1;
      const serialized = JSON.stringify(entry.data ?? null);
      result.syntheticZeroCountReconciliations += (
        serialized.match(/"id":"host-reconciled-r1","count":0/g) ?? []
      ).length;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const usage = message.usage ?? {};
    result.usage.input += Number(usage.input ?? 0);
    result.usage.output += Number(usage.output ?? 0);
    result.usage.cacheRead += Number(usage.cacheRead ?? 0);
    result.usage.total += Number(usage.totalTokens ?? 0);
    if (message.role === "assistant") {
      const text = messageText(message);
      if (hiddenRepairActive) {
        result.hiddenRepairTurns += 1;
        result.hiddenRepairTokens += Number(usage.totalTokens ?? 0);
      }
      if (
        /(all|\d+).*(files?|documents?).*(passed|validated)|全部|均已通过|没有待处理/i.test(text)
        && /(not (marked|recorded|synchronized) complete|completion.*not.*sync|未满足.*完成|完成.*未同步|状态.*不一致)/i.test(text)
      ) {
        result.completionStateContradictions += 1;
      }
      if (Array.isArray(message.diagnostics)) {
        result.providerTransportDiagnostics += message.diagnostics.filter((diagnostic) => (
          diagnostic?.type === "provider_transport_failure"
        )).length;
      }
      if (pendingTerminalTool) {
        result.redundantTerminalContinuations += 1;
        result.redundantTerminalTokens += Number(usage.totalTokens ?? 0);
        pendingTerminalTool = undefined;
      }
      if (message.stopReason === "error") {
        result.errors += 1;
        incrementCount(
          result.assistantErrorFingerprints,
          errorFingerprint(message.errorMessage || messageText(message))
        );
        if (/fetch failed/i.test(`${message.errorMessage ?? ""}\n${messageText(message)}`)) {
          result.fetchErrors += 1;
        }
      }
    } else if (message.role === "user") {
      pendingTerminalTool = undefined;
      hiddenRepairActive = false;
    } else if (message.role === "custom" && message.customType === "yn-domain-repair") {
      hiddenRepairActive = true;
    }
    if (message.role === "toolResult") {
      const modelVisibleBytes = Buffer.byteLength(JSON.stringify(message.content ?? []));
      const durableDetailsBytes = Buffer.byteLength(JSON.stringify(message.details ?? null));
      const toolName = String(message.toolName ?? "unknown");
      result.toolCalls[toolName] = (result.toolCalls[toolName] ?? 0) + 1;
      result.modelVisibleToolResultBytes += modelVisibleBytes;
      result.durableToolDetailsBytes += durableDetailsBytes;
      result.maxModelVisibleToolResultBytes = Math.max(result.maxModelVisibleToolResultBytes, modelVisibleBytes);
      result.maxDurableToolDetailsBytes = Math.max(result.maxDurableToolDetailsBytes, durableDetailsBytes);
      result.maxToolResultBytes = result.maxModelVisibleToolResultBytes;
      if (modelVisibleBytes > 32_768) {
        result.oversizedModelVisibleToolResults += 1;
        result.oversizedToolResults += 1;
        result.oversizedModelVisibleToolResultsByName[toolName] = (
          result.oversizedModelVisibleToolResultsByName[toolName] ?? 0
        ) + 1;
        result.oversizedToolResultsByName[toolName] = result.oversizedModelVisibleToolResultsByName[toolName];
      }
      if (message.isError === true) {
        result.toolErrors += 1;
        incrementCount(
          result.toolErrorFingerprints,
          `${toolName}: ${errorFingerprint(messageText(message))}`
        );
        if (/staging checkpoint|persist.*staging|staging.*persist|persist.*host|host-state.*persist/i.test(messageText(message))) {
          result.checkpointPersistenceFailures += 1;
        }
      }
      if (toolName === "searchProjectText") {
        result.searchResultBytes += modelVisibleBytes;
        result.durableSearchDetailsBytes += durableDetailsBytes;
        result.maxSearchResultBytes = Math.max(result.maxSearchResultBytes, modelVisibleBytes);
      }
      if (toolName === "validateAssignedTranslation") result.validationAttempts += 1;
      if (toolName === "validateTranslationArtifact" && message.isError !== true) {
        const validationHash = typeof message.details?.validationHash === "string"
          ? message.details.validationHash
          : createHash("sha256").update(JSON.stringify(message.content ?? [])).digest("hex");
        validationResultHashes.set(validationHash, (validationResultHashes.get(validationHash) ?? 0) + 1);
      }
      if (toolName === "writeAssignedTranslation" || toolName === "repairAssignedTranslation") {
        result.writeAttempts += 1;
      }
      if (toolName === "submitTranslationReview") {
        result.reviewSubmissions += 1;
        result.reviewSubmits.push({
          timestamp: entry.timestamp,
          auditId: message.details?.auditId,
          accepted: message.details?.accepted,
          failureCount: Number(message.details?.failureCount ?? 0)
        });
      }
      if (toolName === "readAssignedTranslationReview") {
        result.reviewReads.push({
          timestamp: entry.timestamp,
          auditId: message.details?.auditId,
          documentId: message.details?.documentId,
          fromLine: message.details?.fromLine,
          toLine: message.details?.toLine,
          selectedCount: reviewSelectedCount(message.details)
        });
      }
      if (message.isError !== true && TERMINAL_HOST_TOOLS.has(toolName)) pendingTerminalTool = toolName;
    }
  }
  result.duplicateValidationResults = [...validationResultHashes.values()]
    .reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);
  result.alerts = sessionAlerts(result);
  return result;
}

function countReviewEvidenceRegressions(analyzed) {
  const reads = analyzed.flatMap((item) => item.reviewReads).sort((left, right) => (
    String(left.timestamp).localeCompare(String(right.timestamp))
  ));
  const readsByAudit = new Map(reads.map((read) => [read.auditId, read]));
  const submits = analyzed.flatMap((item) => item.reviewSubmits).sort((left, right) => (
    String(left.timestamp).localeCompare(String(right.timestamp))
  ));
  let count = 0;
  for (const submit of submits) {
    if (submit.accepted !== false || submit.failureCount < 1) continue;
    const rejectedRead = readsByAudit.get(submit.auditId);
    if (!rejectedRead) continue;
    const nextRead = reads.find((read) => (
      String(read.timestamp) > String(submit.timestamp)
      && read.documentId === rejectedRead.documentId
      && read.fromLine === rejectedRead.fromLine
      && read.toLine === rejectedRead.toLine
    ));
    if (nextRead && nextRead.selectedCount > submit.failureCount) count += 1;
  }
  return count;
}

async function countArtifacts(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "_workspace") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countArtifacts(fullPath);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function delta(current, prior) {
  if (!prior) return undefined;
  return {
    bytes: current.bytes - prior.bytes,
    errors: current.errors - prior.errors,
    input: current.usage.input - prior.usage.input,
    output: current.usage.output - prior.usage.output,
    cacheRead: current.usage.cacheRead - prior.usage.cacheRead,
    total: current.usage.total - prior.usage.total
  };
}

for (let sample = 1; sample <= sampleCount; sample += 1) {
  const analyzed = await Promise.all((await sessionFiles()).map(analyzeSession));
  analyzed.sort((left, right) => right.bytes - left.bytes);
  const totals = analyzed.reduce((sum, item) => ({
    bytes: sum.bytes + item.bytes,
    compactions: sum.compactions + item.compactions,
    errors: sum.errors + item.errors,
    assistantErrorFingerprints: Object.entries(item.assistantErrorFingerprints).reduce((counts, [name, count]) => {
      incrementCount(counts, name, count);
      return counts;
    }, sum.assistantErrorFingerprints),
    fetchErrors: sum.fetchErrors + item.fetchErrors,
    toolErrors: sum.toolErrors + item.toolErrors,
    toolErrorFingerprints: Object.entries(item.toolErrorFingerprints).reduce((counts, [name, count]) => {
      incrementCount(counts, name, count);
      return counts;
    }, sum.toolErrorFingerprints),
    providerTransportDiagnostics: sum.providerTransportDiagnostics + item.providerTransportDiagnostics,
    providerTransportResets: sum.providerTransportResets + item.providerTransportResets,
    checkpointPersistenceFailures: sum.checkpointPersistenceFailures + item.checkpointPersistenceFailures,
    hiddenRepairTurns: sum.hiddenRepairTurns + item.hiddenRepairTurns,
    hiddenRepairTokens: sum.hiddenRepairTokens + item.hiddenRepairTokens,
    duplicateValidationResults: sum.duplicateValidationResults + item.duplicateValidationResults,
    syntheticZeroCountReconciliations: sum.syntheticZeroCountReconciliations + item.syntheticZeroCountReconciliations,
    completionStateContradictions: sum.completionStateContradictions + item.completionStateContradictions,
    redundantTerminalContinuations: sum.redundantTerminalContinuations + item.redundantTerminalContinuations,
    redundantTerminalTokens: sum.redundantTerminalTokens + item.redundantTerminalTokens,
    validationAttempts: sum.validationAttempts + item.validationAttempts,
    writeAttempts: sum.writeAttempts + item.writeAttempts,
    reviewSubmissions: sum.reviewSubmissions + item.reviewSubmissions,
    searchResultBytes: sum.searchResultBytes + item.searchResultBytes,
    durableSearchDetailsBytes: sum.durableSearchDetailsBytes + item.durableSearchDetailsBytes,
    maxSearchResultBytes: Math.max(sum.maxSearchResultBytes, item.maxSearchResultBytes),
    oversizedToolResultsByName: Object.entries(item.oversizedToolResultsByName).reduce((counts, [name, count]) => ({
      ...counts,
      [name]: (counts[name] ?? 0) + count
    }), sum.oversizedToolResultsByName),
    oversizedModelVisibleToolResultsByName: Object.entries(item.oversizedModelVisibleToolResultsByName)
      .reduce((counts, [name, count]) => ({
        ...counts,
        [name]: (counts[name] ?? 0) + count
      }), sum.oversizedModelVisibleToolResultsByName),
    input: sum.input + item.usage.input,
    output: sum.output + item.usage.output,
    cacheRead: sum.cacheRead + item.usage.cacheRead,
    total: sum.total + item.usage.total,
    oversizedToolResults: sum.oversizedToolResults + item.oversizedToolResults,
    oversizedModelVisibleToolResults: sum.oversizedModelVisibleToolResults + item.oversizedModelVisibleToolResults,
    maxToolResultBytes: Math.max(sum.maxToolResultBytes, item.maxToolResultBytes),
    maxModelVisibleToolResultBytes: Math.max(
      sum.maxModelVisibleToolResultBytes,
      item.maxModelVisibleToolResultBytes
    ),
    maxDurableToolDetailsBytes: Math.max(sum.maxDurableToolDetailsBytes, item.maxDurableToolDetailsBytes),
    modelVisibleToolResultBytes: sum.modelVisibleToolResultBytes + item.modelVisibleToolResultBytes,
    durableToolDetailsBytes: sum.durableToolDetailsBytes + item.durableToolDetailsBytes
  }), {
    bytes: 0,
    compactions: 0,
    errors: 0,
    assistantErrorFingerprints: {},
    fetchErrors: 0,
    toolErrors: 0,
    toolErrorFingerprints: {},
    providerTransportDiagnostics: 0,
    providerTransportResets: 0,
    checkpointPersistenceFailures: 0,
    hiddenRepairTurns: 0,
    hiddenRepairTokens: 0,
    duplicateValidationResults: 0,
    syntheticZeroCountReconciliations: 0,
    completionStateContradictions: 0,
    redundantTerminalContinuations: 0,
    redundantTerminalTokens: 0,
    validationAttempts: 0,
    writeAttempts: 0,
    reviewSubmissions: 0,
    searchResultBytes: 0,
    durableSearchDetailsBytes: 0,
    maxSearchResultBytes: 0,
    oversizedToolResultsByName: {},
    oversizedModelVisibleToolResultsByName: {},
    input: 0,
    output: 0,
    cacheRead: 0,
    total: 0,
    oversizedToolResults: 0,
    oversizedModelVisibleToolResults: 0,
    maxToolResultBytes: 0,
    maxModelVisibleToolResultBytes: 0,
    maxDurableToolDetailsBytes: 0,
    modelVisibleToolResultBytes: 0,
    durableToolDetailsBytes: 0
  });
  totals.reviewEvidenceRegressions = countReviewEvidenceRegressions(analyzed);
  totals.alerts = sessionAlerts(totals);
  if (totals.reviewEvidenceRegressions > 0) {
    totals.alerts.push(`review_evidence_regressions:${totals.reviewEvidenceRegressions}`);
  }
  const priorTotals = previous.get("totals");
  const active = analyzed.filter((item) => {
    const prior = previous.get(item.file);
    return sample > 1 && (!prior || item.bytes > prior.bytes);
  });
  console.log(JSON.stringify({
    sampledAt: new Date().toISOString(),
    sample,
    artifacts: await countArtifacts(outputDir),
    sessions: analyzed.length,
    activeSessions: active.map((item) => item.file),
    totals,
    delta: delta({ bytes: totals.bytes, errors: totals.errors, usage: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      total: totals.total
    } }, priorTotals),
    largestSessions: analyzed.slice(0, 3).map((item) => ({
      file: item.file,
      bytes: item.bytes,
      errors: item.errors,
      compactions: item.compactions,
      totalTokens: item.usage.total,
      toolErrors: item.toolErrors,
      validationAttempts: item.validationAttempts,
      writeAttempts: item.writeAttempts,
      redundantTerminalContinuations: item.redundantTerminalContinuations,
      redundantTerminalTokens: item.redundantTerminalTokens,
      hiddenRepairTurns: item.hiddenRepairTurns,
      hiddenRepairTokens: item.hiddenRepairTokens,
      duplicateValidationResults: item.duplicateValidationResults,
      syntheticZeroCountReconciliations: item.syntheticZeroCountReconciliations,
      completionStateContradictions: item.completionStateContradictions,
      searchResultBytes: item.searchResultBytes,
      durableSearchDetailsBytes: item.durableSearchDetailsBytes,
      maxToolResultBytes: item.maxToolResultBytes,
      maxModelVisibleToolResultBytes: item.maxModelVisibleToolResultBytes,
      maxDurableToolDetailsBytes: item.maxDurableToolDetailsBytes,
      oversizedToolResultsByName: item.oversizedToolResultsByName,
      oversizedModelVisibleToolResultsByName: item.oversizedModelVisibleToolResultsByName,
      alerts: item.alerts
    }))
  }));
  for (const item of analyzed) previous.set(item.file, item);
  previous.set("totals", {
    bytes: totals.bytes,
    errors: totals.errors,
    usage: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, total: totals.total }
  });
  if (sample < sampleCount) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
