#!/usr/bin/env node
/**
 * Headless verification for the three MVP cuts using toy-agent-artifacts fixtures.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { discoverCandidateArtifacts } from "../src/main/agent/artifactDiscovery.ts";
import { validateTranslationCandidate } from "../src/shared/validation/translationValidator.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = path.join(repoRoot, "examples", "toy-agent-artifacts");
const aiDir = path.join(exampleDir, "AI_translation");
const sourcePath = path.join(exampleDir, "source.txt");

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`ok  ${name}`);
}

function notOk(name, error) {
  failed += 1;
  console.log(`FAIL ${name}`);
  console.log(`  ${error instanceof Error ? error.message : error}`);
}

async function listDir(directory) {
  const names = await readdir(directory);
  const entries = [];
  for (const name of names) {
    const full = path.join(directory, name);
    const info = await stat(full);
    if (info.isFile()) {
      entries.push({
        name,
        isFile: true,
        size: info.size,
        modifiedAt: info.mtime.toISOString()
      });
    }
  }
  return entries;
}

async function main() {
  console.log("=== Cut 1: runtime protocol source ===");
  const sync = spawnSync(process.execPath, ["scripts/check-runtime-protocol.mjs"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (sync.status === 0) {
    ok("runtime protocols are complete");
  } else {
    notOk("runtime protocols are complete", sync.stderr || sync.stdout);
  }

  console.log("");
  console.log("=== Cut 2: line-aligned validator ===");
  const sourceText = await readFile(sourcePath, "utf8");
  const cases = [
    { file: "source_translated.txt", expectOk: true },
    { file: "source_mismatch_translated.txt", expectOk: false, expectCode: "line_count_mismatch" },
    { file: "source_tagbroken_translated.txt", expectOk: false, expectCode: "tag_mismatch" }
  ];
  for (const testCase of cases) {
    const candidateText = await readFile(path.join(aiDir, testCase.file), "utf8");
    const result = validateTranslationCandidate(sourceText, candidateText);
    const label = `${testCase.file} → ok=${testCase.expectOk}`;
    if (result.ok === testCase.expectOk) {
      if (!testCase.expectOk && testCase.expectCode) {
        const hasCode = result.blocking.some((f) => f.code === testCase.expectCode);
        if (hasCode) {
          ok(label);
        } else {
          notOk(label, `expected blocking code ${testCase.expectCode}, got ${result.blocking.map((f) => f.code).join(", ")}`);
        }
      } else {
        ok(label);
      }
    } else {
      notOk(label, result.summary);
    }
  }

  console.log("");
  console.log("=== Cut 3: artifact discovery ===");
  const entries = await listDir(aiDir);
  const discovered = discoverCandidateArtifacts(
    exampleDir,
    [{ directory: aiDir, entries }],
    [{ path: sourcePath, basename: "source" }]
  );
  const names = discovered.map((item) => path.basename(item.path)).sort();
  if (names.length >= 3 && names.every((name) => name.endsWith("_translated.txt"))) {
    ok(`discovered ${names.length} candidates in AI_translation (${names.join(", ")})`);
  } else {
    notOk("discover AI_translation candidates", names.join(", "));
  }
  const matched = discovered.find((item) => item.path.endsWith("source_translated.txt"));
  if (matched?.sourcePath === sourcePath) {
    ok("source_translated.txt matches source.txt by basename");
  } else {
    notOk("source_translated.txt matches source.txt by basename", matched?.sourcePath ?? "no match");
  }

  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
