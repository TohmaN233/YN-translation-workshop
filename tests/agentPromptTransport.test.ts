import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentPromptFileMessage, inlineAgentInputLimit, inlineAgentLineLimit, shouldSendAgentPromptViaFile } from "../src/shared/core/agentPromptTransport.ts";

test("short console messages stay inline", () => {
  assert.equal(shouldSendAgentPromptViaFile("hello"), false);
});

test("long prompts are sent through a prompt file", () => {
  assert.equal(shouldSendAgentPromptViaFile("x".repeat(inlineAgentInputLimit + 1)), true);
  assert.equal(shouldSendAgentPromptViaFile(Array.from({ length: inlineAgentLineLimit + 1 }, (_, index) => `line ${index}`).join("\n")), true);
});

test("prompt file wrapper points to both relative and absolute paths", () => {
  const message = buildAgentPromptFileMessage(".translation-workshop/agent-prompts/prompt.md", "D:\\work\\prompt.md");
  assert.match(message, /@\.translation-workshop\/agent-prompts\/prompt\.md/);
  assert.match(message, /D:\\work\\prompt\.md/);
  assert.match(message, /完整提示词/);
});
