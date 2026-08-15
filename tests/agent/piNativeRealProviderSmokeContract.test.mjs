import { strict as assert } from "node:assert";

import {
  assertParentResumedAfterFinalChildren,
  assertTwoShardDelegations,
  finalCompletedSubagentPair,
  hasParentReplyAfterFinalChildren,
  runNativePrompt
} from "../../scripts/verify-real-provider-agent-smoke.mjs";
import { compactSubagentCards } from "../../src/main/agent/piNative/sessionService.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function delegation(tasks) {
  return {
    type: "toolCall",
    toolName: "runTranslationSubagents",
    input: { tasks }
  };
}

const childTranscripts = new Map();

function childCard({ id, fromLine, toLine, status, closed, timestamp }) {
  const prompt = `${id} native prompt`;
  const reply = `${id} completed`;
  const toolNames = ["readAssignedSource", "writeAssignedTranslation", "repairAssignedTranslation", "validateAssignedTranslation"];
  const transcript = status === "completed" ? [
    {
      role: "user",
      content: [{ type: "text", text: prompt }]
    },
    ...toolNames.flatMap((toolName, index) => {
      const toolCallId = `${id}-${index}`;
      return [
        {
          role: "assistant",
          content: [{ type: "toolCall", toolCallId, toolName, input: {} }],
          stopReason: "toolUse"
        },
        {
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text: "validated" }],
          isError: false
        }
      ];
    }),
    {
      role: "assistant",
      content: [{ type: "text", text: reply }],
      stopReason: "stop"
    }
  ] : [];
  childTranscripts.set(id, transcript);
  return {
    role: "custom",
    customType: "subagent.translation",
    timestamp,
    details: {
      subagentId: id,
      label: id,
      fromLine,
      toLine,
      status,
      closed,
      prompt,
      reply
    }
  };
}

function childBatchCompletion(children, timestamp) {
  return {
    role: "custom",
    customType: "subagent-completion",
    content: "native Pi child completion",
    display: false,
    timestamp,
    details: {
      batchId: `batch-${timestamp}`,
      kind: "translation",
      status: children.every((child) => child.status === "completed") ? "completed" : "failed",
      subagents: children.map((child) => ({
        id: child.id,
        fromLine: child.fromLine,
        toLine: child.toLine,
        status: child.status
      })),
      deliverAs: "followUp",
      triggerTurn: true
    }
  };
}

await test("real-provider smoke accepts complete replacement batches after one child fails", () => {
  const calls = [
    delegation([
      { fromLine: 1, toLine: 2 },
      { fromLine: 3, toLine: 4 }
    ]),
    delegation([
      { fromLine: 1, toLine: 2 },
      { fromLine: 3, toLine: 4 }
    ])
  ];
  const delegations = assertTwoShardDelegations(
    calls,
    "runTranslationSubagents",
    [[1, 2], [3, 4]],
    "translation"
  );
  assert.equal(delegations.length, 2);

  const messages = [
    childCard({ id: "shard-1", fromLine: 1, toLine: 2, status: "completed", closed: true }),
    childCard({ id: "shard-2", fromLine: 3, toLine: 4, status: "failed", closed: true }),
    childBatchCompletion([
      { id: "shard-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "shard-2", fromLine: 3, toLine: 4, status: "failed" }
    ], 10),
    childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true }),
    childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "completed", closed: true }),
    childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 3, toLine: 4, status: "completed" }
    ], 20),
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "parent-validation",
        toolName: "validateTranslationArtifact",
        input: {}
      }],
      stopReason: "toolUse"
    },
    {
      role: "toolResult",
      toolCallId: "parent-validation",
      toolName: "validateTranslationArtifact",
      content: [{ type: "text", text: "passed" }],
      isError: false
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Translation completed." }],
      stopReason: "stop"
    }
  ];
  const result = finalCompletedSubagentPair(
    messages,
    "subagent.translation",
    [[1, 2], [3, 4]],
    "translation",
    childTranscripts
  );

  assert.equal(result.cards.length, 4);
  assert.deepEqual(
    result.finalPair.map((message) => message.details.subagentId),
    ["replacement-1", "replacement-2"]
  );
  assert.equal(hasParentReplyAfterFinalChildren(messages, "subagent.translation"), true);
  assert.equal(
    assertParentResumedAfterFinalChildren(
      messages,
      "subagent.translation",
      "translation",
      ["validateTranslationArtifact"]
    ).role,
    "assistant"
  );
});

await test("real-provider smoke rejects partial replacement delegation", () => {
  assert.throws(() => assertTwoShardDelegations([
    delegation([{ fromLine: 3, toLine: 4 }])
  ], "runTranslationSubagents", [[1, 2], [3, 4]], "translation"), /exactly two child tasks/);
});

await test("real-provider smoke rejects a terminal pair that does not restore full coverage", () => {
  assert.throws(() => finalCompletedSubagentPair([
    childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true }),
    childCard({ id: "replacement-2", fromLine: 2, toLine: 4, status: "completed", closed: true }),
    childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 2, toLine: 4, status: "completed" }
    ], 20)
  ], "subagent.translation", [[1, 2], [3, 4]], "translation", childTranscripts), /complete document/);
});

await test("real-provider smoke waits for the parent reply after the final child batch", () => {
  const messages = [
    childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true }),
    childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "completed", closed: true }),
    childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 3, toLine: 4, status: "completed" }
    ], 20)
  ];
  assert.equal(hasParentReplyAfterFinalChildren(messages, "subagent.translation"), false);
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Parent resumed." }],
    stopReason: "stop"
  });
  assert.equal(hasParentReplyAfterFinalChildren(messages, "subagent.translation"), true);
});

await test("native smoke polling cannot settle before the final child completion wakes the parent", async () => {
  const outputDir = process.cwd();
  const sessionId = "smoke-parent-wake";
  const listeners = new Set();
  const rawMessages = [
    childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "running", closed: false, timestamp: 10 }),
    childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "running", closed: false, timestamp: 10 }),
    {
      role: "assistant",
      content: [{ type: "text", text: "The replacement batch is running." }],
      stopReason: "stop",
      timestamp: 20
    },
    childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true, timestamp: 30 }),
    childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "completed", closed: true, timestamp: 31 }),
    childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 3, toLine: 4, status: "completed" }
    ], 40)
  ];
  let settled = 0;
  const emit = (event) => {
    for (const listener of listeners) listener({ workspaceDir: outputDir, sessionId, event });
  };
  const service = {
    subscribeEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      emit({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "live" }] }
      });
      settled += 1;
      emit({ type: "settled" });
      setTimeout(() => {
        rawMessages.push({
          role: "assistant",
          content: [{ type: "text", text: "Parent resumed after the final child batch." }],
          stopReason: "stop",
          timestamp: 50
        });
        settled += 1;
        emit({ type: "settled" });
      }, 150);
      return { accepted: true };
    },
    async getRunState() {
      return {
        sessionId,
        running: false,
        phase: "idle",
        subagentMessages: compactSubagentCards(rawMessages).filter((message) => (
          message.role === "custom" && message.details?.subagentId
        ))
      };
    },
    async loadMessages() {
      return structuredClone(compactSubagentCards(rawMessages));
    }
  };

  const startedAt = performance.now();
  const run = await runNativePrompt({ outputDir, sessionId, prompt: "test" }, 2000, {
    service,
    terminalTranscriptReady: (transcript) => (
      hasParentReplyAfterFinalChildren(transcript, "subagent.translation")
    )
  });
  assert.equal(settled, 2);
  assert.ok(performance.now() - startedAt >= 140, "smoke returned before the delayed parent wake");
  assert.match(run.messages.at(-1).content[0].text, /Parent resumed/);
});

await test("real-provider smoke rejects a truncated or incorrectly paired child transcript", () => {
  const first = childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true });
  const second = childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "completed", closed: true });
  childTranscripts.get("replacement-2").find((message) => message.role === "toolResult").toolCallId = "orphan-result";
  assert.throws(() => finalCompletedSubagentPair(
    [first, second, childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 3, toLine: 4, status: "completed" }
    ], 20)],
    "subagent.translation",
    [[1, 2], [3, 4]],
    "translation",
    childTranscripts
  ), /no paired result|orphan tool result|exactly one paired result/);
});

await test("real-provider smoke rejects failed mandatory child tool results", () => {
  const first = childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true });
  const second = childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "completed", closed: true });
  childTranscripts.get("replacement-2").find((message) => message.role === "toolResult").isError = true;
  assert.throws(() => finalCompletedSubagentPair(
    [first, second, childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 3, toLine: 4, status: "completed" }
    ], 20)],
    "subagent.translation",
    [[1, 2], [3, 4]],
    "translation",
    childTranscripts
  ), /failed tool result|successful result/);
});

await test("real-provider smoke rejects duplicate child tool results", () => {
  const first = childCard({ id: "replacement-1", fromLine: 1, toLine: 2, status: "completed", closed: true });
  const second = childCard({ id: "replacement-2", fromLine: 3, toLine: 4, status: "completed", closed: true });
  const transcript = childTranscripts.get("replacement-2");
  const resultIndex = transcript.findIndex((message) => message.role === "toolResult");
  transcript.splice(resultIndex + 1, 0, structuredClone(transcript[resultIndex]));
  assert.throws(() => finalCompletedSubagentPair(
    [first, second, childBatchCompletion([
      { id: "replacement-1", fromLine: 1, toLine: 2, status: "completed" },
      { id: "replacement-2", fromLine: 3, toLine: 4, status: "completed" }
    ], 20)],
    "subagent.translation",
    [[1, 2], [3, 4]],
    "translation",
    childTranscripts
  ), /duplicate tool result|exactly one paired result/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
