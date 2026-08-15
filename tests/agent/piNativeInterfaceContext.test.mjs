import { strict as assert } from "node:assert";

import { parsePiSessionPromptRequest } from "../../src/main/ipc/agentSessionRequest.ts";
import { YnInterfaceContextStore } from "../../src/main/agent/piNative/interfaceContextStore.ts";
import { buildYnSystemPrompt } from "../../src/main/agent/piNative/systemPrompt.ts";
import { createYnDomainTools } from "../../src/main/agent/piNative/ynDomainTools.ts";

const store = new YnInterfaceContextStore();
store.publish(1, {
  version: 1,
  outputDir: "G:/project",
  htmlPath: "G:/project/review.html",
  pageKind: "line-review",
  sourcePath: "G:/project/source.txt",
  translationPath: "G:/project/translated.txt",
  page: 3,
  pageSize: 1000,
  visibleLineStart: 2001,
  visibleLineEnd: 3000,
  activeLine: 2042,
  focusedLine: {
    line: 2042,
    source: "  source text  ",
    translation: "  translated text  ",
    selectedSourceText: "source"
  }
}, 1_000);

assert.equal(store.read("G:/other", 1_001).available, false);
const snapshot = store.read("G:/project", 1_001);
assert.equal(snapshot.available, true);
assert.equal(snapshot.context.focusedLine.source, "  source text  ");
assert.equal(snapshot.context.focusedLine.selectedSourceText, "source");
assert.equal(snapshot.context.visibleLineStart, 2001);
assert.deepEqual(store.read("G:/project", 9_001), { available: false, stale: true });

store.publish(2, {
  version: 1,
  outputDir: "G:/project",
  pageKind: "line-review",
  activeLine: 3001
}, 1_500, "g:/PROJECT");
assert.equal(store.read("G:/project", 1_501).context.activeLine, 3001);
assert.throws(() => store.publish(3, {
  version: 1,
  outputDir: "G:/other",
  pageKind: "line-review"
}, 1_500, "G:/project"), /workspace boundary/i);
store.removeSource(2);
assert.equal(store.read("G:/project", 1_501).context.activeLine, 2042);

const request = parsePiSessionPromptRequest({
  outputDir: "G:/project",
  sessionId: "session-1",
  prompt: "这个位置怎么翻译？",
  providerId: "provider",
  modelId: "model"
});
const tools = createYnDomainTools({
  request,
  publishCustomMessage: async () => {},
  subagents: {},
  readInterfaceContext: () => snapshot
});
const readTool = tools.find((tool) => tool.name === "readYnInterfaceContext");
assert.ok(readTool, "Pi Host toolset must expose the live YN interface context reader");
const result = await readTool.execute("call-1", {});
assert.deepEqual(result.details, snapshot);
assert.match(buildYnSystemPrompt(request), /refers to the visible page[\s\S]*call readYnInterfaceContext/i);

console.log("ok native Pi reads one validated, workspace-scoped live YN interface context contract");
