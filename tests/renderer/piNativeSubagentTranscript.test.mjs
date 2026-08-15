import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const scratchRoot = path.resolve(".translation-workshop");
await mkdir(scratchRoot, { recursive: true });
const tempDir = await mkdtemp(path.join(scratchRoot, "yn-subagent-transcript-view-"));
try {
  const outfile = path.join(tempDir, "MessageView.mjs");
  await build({
    entryPoints: [path.resolve("src/renderer/agent/piweb/MessageView.tsx")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom/server"]
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  assert.equal(
    typeof module.SubagentTranscriptView,
    "function",
    "subagent Reply must render the child Pi transcript, not only details.reply"
  );

  const cardHtml = renderToStaticMarkup(React.createElement(module.MessageView, {
    message: {
      role: "custom",
      customType: "subagent.translation",
      content: "host-validated",
      details: {
        status: "completed",
        label: "L1-L2",
        subagentId: "child-translation-1",
        resultSummary: "host-validated"
      },
      timestamp: 1
    }
  }));
  assert.match(cardHtml, /data-agent-subagent-kind="subagent\.translation"/);
  assert.match(cardHtml, /data-agent-subagent-id="child-translation-1"/);
  const realVerifierSource = await readFile("scripts/verify-electron-agent-real-html-main.ts", "utf8");
  assert.match(
    realVerifierSource,
    /data-agent-subagent-kind=\"subagent\.translation\"/,
    "real Electron proof must select translation cards by structured Pi customType"
  );
  assert.doesNotMatch(
    realVerifierSource,
    /filter\(\(candidate\) => \['L1-L2', 'L3-L4'\]/,
    "real Electron proof must not infer child kind from translated range labels"
  );

  const transcript = [
    {
      role: "user",
      content: [{ type: "text", text: "Translate L1." }],
      timestamp: 1
    },
    {
      role: "assistant",
      provider: "child-provider",
      model: "child-model",
      content: [{
        type: "toolCall",
        id: "child-read",
        name: "readAssignedSource",
        arguments: { fromLine: 1, toLine: 1 }
      }],
      timestamp: 2
    },
    {
      role: "toolResult",
      toolCallId: "child-read",
      toolName: "readAssignedSource",
      content: [{ type: "text", text: "one" }],
      timestamp: 3
    },
    {
      role: "user",
      content: [{ type: "text", text: "Use the corrected glossary now." }],
      timestamp: 3.5
    },
    {
      role: "assistant",
      provider: "child-provider",
      model: "child-model",
      content: [{ type: "text", text: "Done." }],
      timestamp: 4
    }
  ];
  const html = renderToStaticMarkup(React.createElement(module.SubagentTranscriptView, {
    transcript,
    resultSummary: "Done."
  }));
  assert.match(html, /data-agent-subagent-transcript="true"/);
  assert.match(html, /Translate L1\./);
  assert.match(html, /Use the corrected glossary now\./);
  assert.match(html, /readAssignedSource/);
  assert.match(html, /Done\./);
  assert.equal((html.match(/Done\./g) || []).length, 1, "an existing final reply must not be duplicated");
  assert.doesNotMatch(html, /\[object Object\]/);

  const emptyFinalTranscript = [
    ...transcript.slice(0, -1),
    {
      role: "assistant",
      provider: "child-provider",
      model: "child-model",
      content: [],
      timestamp: 4
    }
  ];
  const emptyFinalHtml = renderToStaticMarkup(React.createElement(module.SubagentTranscriptView, {
    transcript: emptyFinalTranscript,
    resultSummary: "Validated L1-L1 with the host artifact contract."
  }));
  assert.match(emptyFinalHtml, /data-agent-subagent-result="true"/);
  assert.match(emptyFinalHtml, /Validated L1-L1 with the host artifact contract\./);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("ok subagent Reply renders the native Pi transcript with paired message blocks");
