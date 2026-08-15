import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function message(timestamp, body) {
  return { type: "message", timestamp, message: body };
}

const root = await mkdtemp(path.join(os.tmpdir(), "yn-pi-session-monitor-"));
const workspaceKey = "--monitor-workspace--";
const parentDir = path.join(root, ".translation-workshop", "agent", "pi-sessions", workspaceKey);
const childDir = path.join(root, ".translation-workshop", "agent", "pi-child-sessions", workspaceKey);
const outputDir = path.join(root, "AI_translation");
const parentPath = path.join(parentDir, "parent.jsonl");
const ownedChildPath = path.join(childDir, "owned-child.jsonl");
const foreignChildPath = path.join(childDir, "foreign-child.jsonl");

try {
  await mkdir(parentDir, { recursive: true });
  await mkdir(childDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "artifact.txt"), "candidate\n", "utf8");
  await writeFile(parentPath, jsonl([{
    type: "session",
    version: 3,
    id: "parent-monitor",
    timestamp: "2026-08-12T00:00:00.000Z",
    cwd: root
  },
  message("2026-08-12T00:00:00.100Z", {
    role: "custom",
    customType: "yn-domain-repair",
    content: "Continue without waiting for the user.",
    display: false
  }),
  message("2026-08-12T00:00:00.200Z", {
    role: "assistant",
    stopReason: "toolUse",
    content: [],
    usage: { input: 4, output: 1, cacheRead: 0, totalTokens: 5 }
  }),
  message("2026-08-12T00:00:00.300Z", {
    role: "toolResult",
    toolName: "validateTranslationArtifact",
    isError: false,
    details: { validationHash: "same-validation" },
    content: [{ type: "text", text: "all valid" }]
  }),
  message("2026-08-12T00:00:00.400Z", {
    role: "toolResult",
    toolName: "validateTranslationArtifact",
    isError: false,
    details: { validationHash: "same-validation" },
    content: [{ type: "text", text: "all valid" }]
  }),
  {
    type: "custom",
    timestamp: "2026-08-12T00:00:00.500Z",
    customType: "yn.host-state.v2",
    data: { completed: { id: "host-reconciled-r1", count: 0 } }
  },
  message("2026-08-12T00:00:00.600Z", {
    role: "user",
    content: [{ type: "text", text: "What is the final state?" }]
  }),
  message("2026-08-12T00:00:00.700Z", {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "171 files all passed, but completion state is not synchronized." }],
    usage: { input: 5, output: 2, cacheRead: 0, totalTokens: 7 }
  })]), "utf8");
  await writeFile(ownedChildPath, jsonl([
    {
      type: "session",
      version: 3,
      id: "owned-child",
      timestamp: "2026-08-12T00:00:01.000Z",
      cwd: root,
      parentSession: parentPath
    },
    message("2026-08-12T00:00:02.000Z", {
      role: "assistant",
      stopReason: "error",
      errorMessage: "fetch failed",
      diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket closed 1006" } }],
      content: [],
      usage: { input: 10, output: 0, cacheRead: 0, totalTokens: 10 }
    }),
    { type: "custom", timestamp: "2026-08-12T00:00:03.000Z", customType: "yn_provider_transport_error" },
    message("2026-08-12T00:00:04.000Z", {
      role: "toolResult",
      toolName: "repairAssignedTranslation",
      isError: true,
      content: [{ type: "text", text: "Staging checkpoint failed to persist Host state." }]
    }),
    message("2026-08-12T00:00:05.000Z", {
      role: "toolResult",
      toolName: "searchProjectText",
      isError: false,
      content: [{ type: "text", text: "x".repeat(17_000) }]
    }),
    message("2026-08-12T00:00:05.500Z", {
      role: "toolResult",
      toolName: "readAssignedSource",
      isError: false,
      content: [{ type: "text", text: "small model payload" }],
      details: { durableOnly: "x".repeat(40_000) }
    }),
    message("2026-08-12T00:00:06.000Z", {
      role: "toolResult",
      toolName: "validateAssignedTranslation",
      isError: false,
      content: [{ type: "text", text: "accepted" }]
    }),
    message("2026-08-12T00:00:07.000Z", {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Done." }],
      usage: { input: 20, output: 1, cacheRead: 0, totalTokens: 21 }
    }),
    message("2026-08-12T00:00:08.000Z", {
      role: "toolResult",
      toolName: "readAssignedTranslationReview",
      isError: false,
      details: {
        auditId: "audit-1",
        documentId: "source.txt",
        fromLine: 1,
        toLine: 20,
        windows: [{ rows: [{ line: 1, selected: true }, { line: 10, selected: true }] }]
      },
      content: [{ type: "text", text: "review" }]
    }),
    message("2026-08-12T00:00:09.000Z", {
      role: "toolResult",
      toolName: "submitTranslationReview",
      isError: false,
      details: { auditId: "audit-1", accepted: false, failureCount: 1 },
      content: [{ type: "text", text: "repair line 10" }]
    }),
    message("2026-08-12T00:00:10.000Z", {
      role: "user",
      content: [{ type: "text", text: "Repair the rejected line." }]
    }),
    message("2026-08-12T00:00:11.000Z", {
      role: "toolResult",
      toolName: "readAssignedTranslationReview",
      isError: false,
      details: {
        auditId: "audit-2",
        documentId: "source.txt",
        fromLine: 1,
        toLine: 20,
        windows: [{ rows: [{ line: 2, selected: true }, { line: 10, selected: true }] }]
      },
      content: [{ type: "text", text: "review reset" }]
    })
  ]), "utf8");
  await writeFile(foreignChildPath, jsonl([
    {
      type: "session",
      version: 3,
      id: "foreign-child",
      timestamp: "2026-08-12T00:00:01.000Z",
      cwd: root,
      parentSession: path.join(parentDir, "another-parent.jsonl")
    },
    message("2026-08-12T00:00:02.000Z", {
      role: "assistant",
      stopReason: "error",
      errorMessage: "fetch failed",
      content: [],
      usage: { input: 999, output: 0, cacheRead: 0, totalTokens: 999 }
    })
  ]), "utf8");

  const run = spawnSync(process.execPath, [
    path.resolve("scripts/monitor-pi-live-session.mjs"),
    parentPath,
    outputDir,
    "1000",
    "1"
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout.trim());
  assert.equal(report.sessions, 2, "the monitor must include only the selected parent and its owned children");
  assert.equal(report.totals.total, 43, "foreign historical child usage must not contaminate the selected run");
  assert.equal(report.totals.errors, 1);
  assert.equal(report.totals.assistantErrorFingerprints["fetch failed"], 1);
  assert.equal(report.totals.fetchErrors, 1);
  assert.equal(report.totals.providerTransportDiagnostics, 2);
  assert.equal(report.totals.toolErrors, 1);
  assert.equal(
    report.totals.toolErrorFingerprints[
      "repairAssignedTranslation: Staging checkpoint failed to persist Host state."
    ],
    1
  );
  assert.equal(report.totals.checkpointPersistenceFailures, 1);
  assert.equal(report.totals.redundantTerminalContinuations, 1);
  assert.equal(report.totals.redundantTerminalTokens, 21);
  assert.equal(report.totals.hiddenRepairTurns, 1);
  assert.equal(report.totals.hiddenRepairTokens, 5);
  assert.equal(report.totals.duplicateValidationResults, 1);
  assert.equal(report.totals.syntheticZeroCountReconciliations, 1);
  assert.equal(report.totals.completionStateContradictions, 1);
  assert.equal(report.totals.reviewEvidenceRegressions, 1);
  assert.ok(report.totals.maxSearchResultBytes > 16_384);
  assert.ok(report.totals.maxDurableToolDetailsBytes > 32_768);
  assert.ok(report.totals.maxModelVisibleToolResultBytes < report.totals.maxDurableToolDetailsBytes);
  assert.equal(
    report.totals.oversizedModelVisibleToolResultsByName.readAssignedSource,
    undefined,
    "durable details that Pi never sends to the model must not raise a model-token alert"
  );
  assert.ok(report.totals.alerts.includes("review_evidence_regressions:1"));
  assert.ok(report.totals.alerts.includes("hidden_repair_turns:1"));
  assert.ok(report.totals.alerts.includes("duplicate_validation_results:1"));
  assert.ok(report.totals.alerts.includes("synthetic_zero_count_reconciliations:1"));
  assert.ok(report.totals.alerts.includes("completion_state_contradictions:1"));
  console.log("ok live Pi monitoring isolates one parent run and reports transport, token, tool, terminal, and review-evidence anomalies");
} finally {
  await rm(root, { recursive: true, force: true });
}
