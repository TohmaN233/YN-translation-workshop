import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPiTranslationSubagentTools } from "../../src/main/agent/piNative/subagentRunner.ts";

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

async function fixture(options = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-child-path-contract-"));
  const sourceDocumentId = options.sourceDocumentId ?? "source.txt";
  const sourcePath = path.join(outputDir, options.sourceRelativePath ?? sourceDocumentId);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "Hello\nWorld\n", "utf8");
  await mkdir(path.join(outputDir, ".translation-workshop"), { recursive: true });
  await writeFile(
    path.join(outputDir, ".translation-workshop", "style_guide.md"),
    "# Style Guide\nUse concise, natural Simplified Chinese.\n",
    "utf8"
  );
  const tools = createPiTranslationSubagentTools({
    request: {
      outputDir,
      sourcePath,
      sourceDocumentId,
      sourceSelection: { kind: "file", path: sourcePath },
      sessionId: "pi_child_path_contract",
      prompt: "Repair the assigned translation lines.",
      providerId: "test",
      modelId: "test",
      languagePair: "Eng->zh-CN"
    },
    task: {
      documentId: sourceDocumentId,
      fromLine: 1,
      toLine: 2,
      instruction: "Repair the current translation."
    },
    executionMode: "bounded_repair",
    publishCustomMessage: async () => {}
  });
  return {
    outputDir,
    sourcePath,
    tool(name) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `missing ${name} tool`);
      return tool;
    },
    async close() {
      await rm(outputDir, { recursive: true, force: true });
    }
  };
}

await test("child project list and search treat blank optional paths as the project root", async () => {
  const fx = await fixture();
  try {
    await writeFile(path.join(fx.outputDir, "project-marker.txt"), "root-path-contract-marker\n", "utf8");
    const listed = await fx.tool("listProjectDir").execute("list_root", { path: "", maxEntries: 50 });
    assert.equal(listed.details.relativePath, ".");
    assert.ok(listed.details.entries.some((entry) => entry.name === "project-marker.txt"));

    const searched = await fx.tool("searchProjectText").execute("search_root", {
      query: "root-path-contract-marker",
      path: "",
      maxResults: 20
    });
    assert.equal(searched.details.relativePath, ".");
    assert.deepEqual(searched.details.matches.map((entry) => entry.path), ["project-marker.txt"]);
  } finally {
    await fx.close();
  }
});

await test("child read-only tools resolve a logical document id and extracted basename", async () => {
  const fx = await fixture({
    sourceDocumentId: "book.epub",
    sourceRelativePath: ".translation-workshop/extracted-text/book/source/_.txt"
  });
  try {
    const searched = await fx.tool("searchProjectText").execute("search_bound_source", {
      query: "Hello",
      path: "book.epub",
      maxResults: 20
    });
    assert.equal(searched.details.path, fx.sourcePath);
    assert.equal(searched.details.matches.length, 1);

    const read = await fx.tool("readProjectFile").execute("read_bound_source", { path: "_.txt" });
    assert.equal(read.details.path, fx.sourcePath);
    assert.match(read.details.content, /Hello/);
  } finally {
    await fx.close();
  }
});

await test("child project search never feeds Pi session transcripts back into the model", async () => {
  const fx = await fixture();
  try {
    await writeFile(path.join(fx.outputDir, "visible.txt"), "search-runtime-history-marker\n", "utf8");
    const runtimeDir = path.join(
      fx.outputDir,
      ".translation-workshop",
      "agent",
      "pi-child-sessions",
      "workspace"
    );
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "history.jsonl"), "search-runtime-history-marker\n", "utf8");

    const searched = await fx.tool("searchProjectText").execute("search_without_history", {
      query: "search-runtime-history-marker",
      path: ".",
      maxResults: 20
    });
    assert.deepEqual(searched.details.matches.map((entry) => entry.path), ["visible.txt"]);

    const listed = await fx.tool("listProjectDir").execute("list_state", {
      path: ".translation-workshop",
      maxEntries: 20
    });
    assert.equal(listed.details.entries.some((entry) => entry.name === "agent"), false);
    await assert.rejects(
      fx.tool("listProjectDir").execute("list_history", {
        path: ".translation-workshop/agent",
        maxEntries: 20
      }),
      /Pi runtime session data is not readable through project tools/i
    );
    await assert.rejects(
      fx.tool("readProjectFile").execute("read_history", {
        path: ".translation-workshop/agent/pi-child-sessions/workspace/history.jsonl"
      }),
      /Pi runtime session data is not readable through project tools/i
    );
  } finally {
    await fx.close();
  }
});

await test("a failed first managed read does not consume canonical project references", async () => {
  const fx = await fixture();
  try {
    await rm(fx.sourcePath);
    await assert.rejects(
      fx.tool("readAssignedSource").execute("failed_read", {}),
      /ENOENT|no such file/i
    );
    await writeFile(fx.sourcePath, "Hello\nWorld\n", "utf8");
    const retried = await fx.tool("readAssignedSource").execute("retried_read", {});
    assert.equal(retried.details.projectReferences.styleGuide.available, true);
  } finally {
    await fx.close();
  }
});

await test("bounded repair receives canonical project reference paths from its first managed read", async () => {
  const fx = await fixture();
  try {
    const read = await fx.tool("readAssignedSource").execute("read_assigned", {});
    assert.deepEqual(read.details.projectReferences.styleGuide, {
      path: ".translation-workshop/style_guide.md",
      available: true
    });
    assert.equal(read.details.projectReferences.approvedGlossary.path, ".translation-workshop/glossary.json");
    assert.equal(read.details.projectReferences.characterBible.path, "AI_translation/_workspace/character_bible.md");
  } finally {
    await fx.close();
  }
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
