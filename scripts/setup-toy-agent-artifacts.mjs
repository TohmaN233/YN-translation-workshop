#!/usr/bin/env node
/**
 * Prepare examples/toy-agent-artifacts for UI verification:
 * - generate translate-only line-review HTML (no bound translation TXT)
 * - write .translation-workshop/project.json + state.json so the app can reopen
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderLineReviewHtml } from "../src/shared/core/html.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(repoRoot, "examples", "toy-agent-artifacts");
const sourcePath = path.join(exampleDir, "source.txt");
const glossaryPath = path.join(exampleDir, "glossary.json");
const translateOutputDir = path.join(exampleDir, "AI_translation");
const workspaceDir = path.join(exampleDir, ".translation-workshop");
const htmlDir = path.join(workspaceDir, "html");

function toPosix(p) {
  return p.split(path.sep).join("/");
}

async function main() {
  const sourceText = await readFile(sourcePath, "utf8");
  await mkdir(htmlDir, { recursive: true });

  const htmlName = "line-review-source.html";
  const htmlPath = path.join(htmlDir, htmlName);
  const html = renderLineReviewHtml({
    title: "toy-agent-artifacts / source.txt",
    sourceText,
    locale: "zh-CN",
    lineReviewPath: htmlPath,
    workflow: {
      outputDir: toPosix(exampleDir),
      sourcePath: toPosix(sourcePath),
      glossaryPath: toPosix(glossaryPath),
      fileType: "txt",
      inputMode: "separate",
      languagePair: "ja->zh-CN",
      style: "game"
    }
  });
  await writeFile(htmlPath, html, "utf8");

  const now = new Date().toISOString();
  const project = {
    locale: "zh-CN",
    inputMode: "separate",
    sourcePath: toPosix(sourcePath),
    translationPath: "",
    outputDir: toPosix(exampleDir),
    glossaryPath: toPosix(glossaryPath),
    fileType: "txt",
    pageSize: 1000,
    languagePair: "ja->zh-CN",
    style: "game",
    translateOutputDir: toPosix(translateOutputDir),
    proofreadOutputDir: toPosix(path.join(exampleDir, "report")),
    lastLineReviewHtml: toPosix(htmlPath),
    lineReviewPath: toPosix(htmlPath),
    lastHtml: toPosix(htmlPath),
    lastOutput: toPosix(htmlPath),
    updatedAt: now
  };
  const state = {
    lastHtml: toPosix(htmlPath),
    lastLineReviewHtml: toPosix(htmlPath),
    generatedAt: now
  };

  await writeFile(path.join(workspaceDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspaceDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  console.log("Toy example ready:");
  console.log(`  Project folder : ${exampleDir}`);
  console.log(`  Line review HTML: ${htmlPath}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. npm run dev   (from this repo root)");
  console.log("  2. Open project folder → select examples/toy-agent-artifacts");
  console.log("  3. Click generate line-review HTML (or reopen last HTML from project load)");
  console.log("  4. In the workbench sidebar, expand “Agent translation artifacts”");
  console.log("");
  console.log("Headless checks: npm run verify:toy-agent-artifacts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
