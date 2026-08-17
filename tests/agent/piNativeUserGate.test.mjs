import assert from "node:assert/strict";
import {
  isHostUserAskGateText,
  isHostUserGateText,
  isHostUserGateToolResult,
  isHostUserWaitGateText,
  isHostUserWaitGateToolResult,
  sessionHasOpenHostUserGate
} from "../../src/main/agent/piNative/userGate.ts";

assert.equal(isHostUserWaitGateText("Wait for an explicit user continuation before starting or mutating the workflow."), true);
assert.equal(isHostUserWaitGateText("YN child batch batch_x is paused after an exhausted assignment."), true);
assert.equal(isHostUserWaitGateText("Wait for those children to settle. Do not call inspectTranslationAlignment again unless the Host listed a parentTakeover auditId."), true);
assert.equal(isHostUserWaitGateText("Ask the user for the reuse decision."), false);
assert.equal(isHostUserAskGateText("Ask the user for the reuse decision."), true);
assert.equal(isHostUserGateText("Ask the user whether to reuse accepted lines before changing any candidate."), true);
assert.equal(
  isHostUserGateText("Chunk alignment review is owned by the read-only translation-review Pi pool"),
  false
);
assert.equal(isHostUserGateText("The current workflow already owns translation artifact Vivy_prototype_2_.txt"), false);
assert.equal(isHostUserGateText("There is no pending translation reuse audit owned by this Pi session."), false);
assert.equal(isHostUserGateText("Call runTranslationSubagents now for remaining rejected lines."), false);
assert.equal(isHostUserGateToolResult({
  details: { nextAction: "Ask the user whether to reuse accepted lines before changing any candidate." }
}), true);
assert.equal(isHostUserWaitGateToolResult({
  details: { nextAction: "Ask the user whether to reuse accepted lines before changing any candidate." }
}), false);
assert.equal(isHostUserWaitGateToolResult({
  isError: true,
  content: [{ type: "text", text: "YN child batch batch_x is paused after an exhausted assignment." }]
}), true);
assert.equal(isHostUserGateToolResult({
  details: { nextAction: "Call validateTranslationArtifact for the current artifact revision." }
}), false);

const waitingTranscript = [
  { role: "user", content: "continue" },
  { role: "assistant", content: [{ type: "toolCall", name: "resumeYnWorkflow" }] },
  {
    role: "toolResult",
    isError: true,
    content: [{ type: "text", text: "Wait for an explicit user continuation before starting or mutating the workflow." }]
  },
  { role: "assistant", content: [{ type: "text", text: "主机要你先说继续。" }] }
];
assert.equal(sessionHasOpenHostUserGate(waitingTranscript), true);
assert.equal(sessionHasOpenHostUserGate([
  ...waitingTranscript,
  { role: "user", content: "继续" }
]), false);
assert.equal(sessionHasOpenHostUserGate([
  { role: "user", content: "fix it" },
  {
    role: "toolResult",
    content: [{ type: "text", text: "Chunk alignment review is owned by the read-only translation-review Pi pool" }]
  },
  { role: "assistant", content: [{ type: "text", text: "I will try another tool." }] }
]), false);

console.log("ok host user-gate detection stops wait-for-user loops");
