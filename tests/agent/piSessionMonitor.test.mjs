import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv, branchTip, insertEntry, insertUsage, setValue, appendList, list }
  from "@earendil-works/pi-agent-core/node";

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function message(timestamp, body) {
  return { type: "message", timestamp, message: body };
}

async function nativeFixture(filePath, { parentSessionId, compaction = false } = {}) {
  const source = (await readFile(filePath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const header = source[0];
  let now = Date.parse(header.timestamp);
  const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: header.cwd }),
    sessionsRoot: path.join(header.cwd, `native-fixture-${header.id}`), now: () => now });
  const session = await repo.create({ cwd: header.cwd, id: header.id, parentSessionId }, BACKGROUND_CONTEXT);
  try {
    const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
    for (const entry of source.slice(1)) {
      now = Date.parse(entry.timestamp);
      if (entry.type === "message") await branch.appendMessage(entry.message, BACKGROUND_CONTEXT);
      else if (entry.type === "custom") await branch.appendCustomEntry(entry.customType, entry.data, BACKGROUND_CONTEXT);
      else throw new Error(`Unimplemented native test fixture type: ${entry.type}`);
    }
    if (compaction) {
      now += 1;
      const id = session.idGenerator.next(now);
      await session.mutate(async (mutation) => {
        const tip = await mutation.getValue(branchTip("main"), BACKGROUND_CONTEXT);
        await mutation.commit([
          insertEntry({ id, parentId: tip.value, type: "compaction", summary: "native fixture compaction",
            tokensBefore: 123, fromHook: false,
            retainedTail: source.filter((entry) => entry.message?.role === "assistant").map((entry) => entry.message) }),
          setValue(branchTip("main"), id)
        ], BACKGROUND_CONTEXT);
      }, BACKGROUND_CONTEXT);
    }
    // Native stores usage and lane/checkpoint values separately. These rows
    // must not become extra messages or duplicate the message's token totals.
    const diagnosticPayload = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "must not count", usage: { totalTokens: 9_999 } } };
    const separateUsage = { input: 9_999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9_999,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    await session.mutate(async (mutation) => mutation.commit([
      insertUsage({ id: session.idGenerator.next(), usage: separateUsage, adjustment: false }),
      setValue({ namespace: "pi.pending.entry", key: "ignored", kind: "value" }, diagnosticPayload),
      appendList(list("pi.pending.assistant_frame", "ignored"), diagnosticPayload)
    ], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
    await session.setName("single native value transaction", BACKGROUND_CONTEXT);
    await writeFile(filePath, await readFile(session.metadata.path), "utf8");
  } finally {
    await session.close(BACKGROUND_CONTEXT);
    await repo.close(BACKGROUND_CONTEXT);
  }
}

function runMonitor(parentPath, outputDir) {
  return spawnSync(process.execPath, [path.resolve("scripts/monitor-pi-live-session.mjs"), parentPath, outputDir, "1000", "1"],
    { cwd: path.resolve("."), encoding: "utf8" });
}

function runGrowth(parentPath, childDir) {
  return spawnSync(process.execPath, [path.resolve("scripts/analyze-pi-session-growth.mjs"), parentPath, childDir],
    { cwd: path.resolve("."), encoding: "utf8" });
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
    content: [{ type: "toolCall", id: "inspect-call", name: "inspectSubagents", arguments: { childSessionId: "owned-child" } }],
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

  const legacyGrowthRun = runGrowth(parentPath, childDir);
  assert.equal(legacyGrowthRun.status, 0, legacyGrowthRun.stderr);
  const legacyGrowth = JSON.parse(legacyGrowthRun.stdout);
  assert.equal(legacyGrowth.children.length, 1);
  await nativeFixture(parentPath, { compaction: true });
  await nativeFixture(ownedChildPath, { parentSessionId: "parent-monitor" });
  await nativeFixture(foreignChildPath, { parentSessionId: "foreign-parent" });
  const nativeBytes = await readFile(parentPath, "utf8");
  const nativeRun = runMonitor(parentPath, outputDir);
  assert.equal(nativeRun.status, 0, nativeRun.stderr);
  const nativeReport = JSON.parse(nativeRun.stdout.trim());
  assert.equal(nativeReport.sessions, 2);
  const { bytes: legacySize, ...legacyMetrics } = report.totals;
  const { bytes: nativeSize, ...nativeMetrics } = nativeReport.totals;
  assert.deepEqual(nativeMetrics, { ...legacyMetrics, compactions: 1 },
    "native messages must produce all the same token, error, tool and review metrics without retained-tail/usage/value duplication");
  const nativeGrowthRun = runGrowth(parentPath, childDir);
  assert.equal(nativeGrowthRun.status, 0, nativeGrowthRun.stderr);
  const nativeGrowth = JSON.parse(nativeGrowthRun.stdout);
  assert.equal(nativeGrowth.children.length, 1);
  assert.deepEqual(nativeGrowth.parent.roles, legacyGrowth.parent.roles);
  assert.deepEqual(nativeGrowth.parent.usage, legacyGrowth.parent.usage);
  assert.deepEqual(nativeGrowth.parent.toolCalls, legacyGrowth.parent.toolCalls);
  assert.equal(nativeGrowth.parent.toolCalls.inspectSubagents.count, 1);
  assert.ok(nativeGrowth.parent.toolCalls.inspectSubagents.argumentBytes > 0);
  assert.deepEqual(nativeGrowth.children[0].roles, legacyGrowth.children[0].roles);
  assert.deepEqual(nativeGrowth.children[0].usage, legacyGrowth.children[0].usage);
  assert.deepEqual(nativeGrowth.children[0].toolResults, legacyGrowth.children[0].toolResults);
  assert.equal(nativeGrowth.parent.compactions.length, 1);
  assert.equal(nativeGrowth.parent.compactions[0].tokensBefore, 123);
  assert.equal(nativeGrowth.parent.entries, legacyGrowth.parent.entries + 1);
  assert.equal(nativeGrowth.parent.entryTypes.usage, undefined);
  assert.equal(nativeGrowth.parent.entryTypes.value, undefined);
  assert.equal(nativeGrowth.parent.entryTypes.list, undefined);
  assert.equal(await readFile(parentPath, "utf8"), nativeBytes, "diagnostic reads must not rewrite native files");
  console.log("ok native v4 diagnostic transactions preserve metrics and child ownership without duplicate retained-tail or storage rows");

  // Legacy fallback metadata may coexist with a native header. A conflicting
  // explicit ID remains authoritative and cannot be bypassed by that path.
  const foreignLines = (await readFile(foreignChildPath, "utf8")).trimEnd().split("\n");
  const foreignHeader = JSON.parse(foreignLines[0]);
  foreignHeader.legacyParentSessionPath = parentPath;
  foreignLines[0] = JSON.stringify(foreignHeader);
  await writeFile(foreignChildPath, `${foreignLines.join("\n")}\n`);
  const conflictingRun = runMonitor(parentPath, outputDir);
  assert.equal(conflictingRun.status, 0, conflictingRun.stderr);
  assert.equal(JSON.parse(conflictingRun.stdout).sessions, 2);
  delete foreignHeader.parentSessionId;
  foreignLines[0] = JSON.stringify(foreignHeader);
  await writeFile(foreignChildPath, `${foreignLines.join("\n")}\n`);
  const fallbackRun = runMonitor(parentPath, outputDir);
  assert.equal(fallbackRun.status, 0, fallbackRun.stderr);
  assert.equal(JSON.parse(fallbackRun.stdout).sessions, 3);

  for (const malformed of [
    nativeBytes.replace('"v":4', '"v":5'),
    `${nativeBytes}${nativeBytes.trimEnd().split("\n")[1]}\n`,
    `${nativeBytes}${JSON.stringify({ type: "message", timestamp: "2026-08-12T00:00:15Z", message: { role: "assistant" } })}\n`,
    `${nativeBytes}${JSON.stringify({ kind: "entry", seq: 999, timestamp: 1, id: "bad-parent", parentId: "missing", type: "message", message: { role: "user", content: "bad" } })}\n`
  ]) {
    await writeFile(parentPath, malformed);
    const invalidMonitor = runMonitor(parentPath, outputDir);
    assert.notEqual(invalidMonitor.status, 0);
    assert.match(invalidMonitor.stderr, /Unsupported Pi session format|Invalid Pi JSONL/);
    const invalidGrowth = runGrowth(parentPath, childDir);
    assert.notEqual(invalidGrowth.status, 0);
    assert.match(invalidGrowth.stderr, /Unsupported Pi session format|Invalid Pi JSONL/);
  }
  await writeFile(parentPath, `${nativeBytes}{"kind":"entry"`);
  const inFlightRun = runMonitor(parentPath, outputDir);
  assert.equal(inFlightRun.status, 0, inFlightRun.stderr);
  assert.equal(JSON.parse(inFlightRun.stdout).totals.compactions, 1);
  assert.equal(await readFile(parentPath, "utf8"), `${nativeBytes}{"kind":"entry"`);
  console.log("ok diagnostics reject malformed formats/transactions and observe only complete live records without rewriting EOF");
} finally {
  await rm(root, { recursive: true, force: true });
}
