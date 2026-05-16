#!/usr/bin/env node
import { cp, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const codexSkills = ["translate-text", "proofread-translation"];
const claudeCommands = ["translate-text.md", "proofread-translation.md"];

export function parseArgs(argv) {
  const options = {
    agent: "all",
    global: false,
    replace: false,
    home: process.env.HOME || process.env.USERPROFILE || "",
    repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent") {
      options.agent = argv[++index] || "";
    } else if (arg === "--global" || arg === "-g") {
      options.global = true;
    } else if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--home") {
      options.home = argv[++index] || "";
    } else if (arg === "--repo") {
      options.repo = path.resolve(argv[++index] || "");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "translation-workshop-skills",
    "",
    "Install bundled translation-workshop skills into global Agent config folders.",
    "",
    "Usage:",
    "  node /path/to/translation-workshop/scripts/install-skills.mjs --agent all --global",
    "  node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global",
    "  node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global",
    "",
    "Options:",
    "  --agent codex|claude|all",
    "  --global, -g",
    "  --replace      Back up then update existing bundled skill targets. Default: skip existing targets.",
    "  --home <path>   Test/install into a custom home directory.",
    "  --repo <path>   Use a custom translation-workshop repository path."
  ].join("\n");
}

async function pathInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function ensureExists(target) {
  const info = await pathInfo(target);
  if (!info) {
    throw new Error(`Missing source: ${target}`);
  }
  return info;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupPathFor(home, destination, backupId) {
  const relativeTarget = path.relative(home, destination);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`Refusing to back up a target outside home: ${destination}`);
  }
  return path.join(home, ".translation-workshop", "skill-backups", backupId, relativeTarget);
}

async function backupExistingTarget(home, destination, backupId) {
  const info = await pathInfo(destination);
  if (!info) {
    return "";
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic link target: ${destination}`);
  }
  const backupPath = backupPathFor(home, destination, backupId);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await cp(destination, backupPath, { recursive: info.isDirectory(), force: false });
  return backupPath;
}

async function copyDirectory(source, destination, options) {
  await ensureExists(source);
  const existing = await pathInfo(destination);
  if (existing && !options.replace) {
    return { status: "skipped", backupPath: "", reason: "target already exists" };
  }
  const backupPath = existing ? await backupExistingTarget(options.home, destination, options.backupId) : "";
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: Boolean(existing && options.replace) });
  return { status: existing ? "updated" : "installed", backupPath, reason: "" };
}

async function copyFile(source, destination, options) {
  await ensureExists(source);
  const existing = await pathInfo(destination);
  if (existing && !options.replace) {
    return { status: "skipped", backupPath: "", reason: "target already exists" };
  }
  const backupPath = existing ? await backupExistingTarget(options.home, destination, options.backupId) : "";
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { force: Boolean(existing && options.replace) });
  return { status: existing ? "updated" : "installed", backupPath, reason: "" };
}

export function installPlan({ repo, home, agent }) {
  const normalizedAgent = agent === "codex" || agent === "claude" || agent === "all" ? agent : "";
  if (!normalizedAgent) {
    throw new Error(`Invalid agent "${agent}". Expected codex, claude, or all.`);
  }
  if (!home) {
    throw new Error("A home directory is required. Set HOME/USERPROFILE or pass --home.");
  }
  const operations = [];
  if (normalizedAgent === "codex" || normalizedAgent === "all") {
    for (const name of codexSkills) {
      operations.push({
        kind: "directory",
        source: path.join(repo, "skills", "codex", name),
        destination: path.join(home, ".codex", "skills", name)
      });
    }
  }
  if (normalizedAgent === "claude" || normalizedAgent === "all") {
    for (const name of claudeCommands) {
      operations.push({
        kind: "file",
        source: path.join(repo, "skills", "claude", "commands", name),
        destination: path.join(home, ".claude", "commands", name)
      });
    }
  }
  return operations;
}

export async function installSkills(options) {
  const operations = installPlan(options);
  const copyOptions = {
    home: options.home,
    replace: Boolean(options.replace),
    backupId: timestamp()
  };
  const results = [];
  for (const operation of operations) {
    let result;
    if (operation.kind === "directory") {
      result = await copyDirectory(operation.source, operation.destination, copyOptions);
    } else {
      result = await copyFile(operation.source, operation.destination, copyOptions);
    }
    results.push({ ...operation, ...result });
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.global) {
    throw new Error("Pass --global or -g to confirm installation into global Agent config folders.");
  }
  const operations = await installSkills(options);
  for (const operation of operations) {
    const label = operation.status === "skipped" ? "Skipped" : operation.status === "updated" ? "Updated" : "Installed";
    const backup = operation.backupPath ? ` Backup: ${operation.backupPath}` : "";
    const reason = operation.reason ? ` (${operation.reason})` : "";
    console.log(`${label} ${operation.source} -> ${operation.destination}${reason}${backup}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
