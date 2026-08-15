#!/usr/bin/env node
// Minimal test runner: executes every *.test.mjs under tests/ in a child node
// process with --experimental-strip-types so TS sources can be imported. No
// third-party runner dependency. Exits non-zero if any test file fails.

import { readdir, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(full);
    }
  }
  return files.sort();
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", file], {
      stdio: "inherit",
      cwd: root
    });
    child.on("close", (code) => resolve({ file, code }));
    child.on("error", (error) => {
      console.error(error);
      resolve({ file, code: 1 });
    });
  });
}

async function main() {
  await mkdir(path.join(root, ".translation-workshop"), { recursive: true }).catch(() => {});
  const files = await collectTestFiles(testsDir);
  if (files.length === 0) {
    console.log("No *.test.mjs files found under tests/.");
    return;
  }
  let failed = 0;
  for (const file of files) {
    console.log("");
    console.log(`# ${path.relative(root, file)}`);
    const result = await runFile(file);
    if (result.code !== 0) {
      failed += 1;
      console.log(`FAIL  ${path.relative(root, file)} (exit ${result.code})`);
    } else {
      console.log(`OK    ${path.relative(root, file)}`);
    }
  }
  console.log("");
  if (failed > 0) {
    console.log(`${failed} test file(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${files.length} test file(s) passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
