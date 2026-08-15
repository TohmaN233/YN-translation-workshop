#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeSkills = ["translate-text", "proofread-translation"];
const githubRawBase = "https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main";
const codexSkillFiles = {
  "translate-text": [
    "SKILL.md",
    "references/translation-workflow.md",
    "references/subagent-task-template.md"
  ],
  "proofread-translation": [
    "SKILL.md",
    "references/proofread-workflow.md",
    "references/subagent-task-template.md"
  ]
};

const skillReferences = {
  "translate-text": "references/translation-workflow.md",
  "proofread-translation": "references/proofread-workflow.md"
};

function defaultRepoPath() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return process.cwd();
  }
}

export function parseArgs(argv) {
  const options = {
    agent: "all",
    global: false,
    replace: false,
    home: process.env.HOME || process.env.USERPROFILE || "",
    repo: "",
    source: "local",
    rawBase: githubRawBase
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
    } else if (arg === "--github") {
      options.source = "github";
    } else if (arg === "--raw-base") {
      options.rawBase = (argv[++index] || "").replace(/\/+$/, "");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.repo) {
    options.repo = defaultRepoPath();
  }
  return options;
}

function usage() {
  return [
    "translation-workshop-skills",
    "",
    "Export bundled translation-workshop skills into optional external Agent config folders.",
    "",
    "Usage:",
    "  node /path/to/translation-workshop/scripts/install-skills.mjs --agent all --global --replace",
    "  node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global --replace",
    "  node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global --replace",
    "  irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global --replace",
    "  curl -fsSL https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global --replace",
    "",
    "Options:",
    "  --agent codex|claude|all   External install target, not the runtime skill source.",
    "  --global, -g",
    "  --github       Download skill files from the GitHub repository instead of a local checkout.",
    "  --replace      Back up then update existing bundled skill targets.",
    "  --home <path>   Test/install into a custom home directory.",
    "  --repo <path>   Use a custom translation-workshop repository path.",
    "  --raw-base <url> Override the GitHub raw base URL used with --github."
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

function stripFrontmatter(text) {
  return text.replace(/^---[\s\S]*?---\s*/m, "").trim();
}

function renderClaudeCommand(skillName, skillText, referenceText, templateText) {
  const title = skillName === "translate-text" ? "Translate Text" : "Proofread Translation";
  return [
    `# ${title}`,
    "",
    "This command exports the same YN Translation Workshop bundled skill used by the app runtime.",
    "Use the workflow below as the task contract.",
    "",
    "## Skill",
    "",
    stripFrontmatter(skillText),
    "",
    "## Workflow Reference",
    "",
    referenceText.trim(),
    "",
    "## Subagent Task Template",
    "",
    templateText.trim(),
    ""
  ].join("\n");
}

async function writeGeneratedClaudeCommand(operation, destination, options) {
  const existing = await pathInfo(destination);
  if (existing && !options.replace) {
    return { status: "skipped", backupPath: "", reason: "target already exists" };
  }
  const skillText = await readFile(operation.skillSource, "utf8");
  const referenceText = await readFile(operation.referenceSource, "utf8");
  const templateText = await readFile(operation.templateSource, "utf8");
  const backupPath = existing ? await backupExistingTarget(options.home, destination, options.backupId) : "";
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, renderClaudeCommand(operation.skillName, skillText, referenceText, templateText), "utf8");
  return { status: existing ? "updated" : "installed", backupPath, reason: "" };
}

function rawUrl(rawBase, ...parts) {
  return `${rawBase.replace(/\/+$/, "")}/${parts.map((part) => encodeURIComponent(part).replace(/%2F/g, "/")).join("/")}`;
}

async function copyRemoteFile(source, destination, options) {
  const existing = await pathInfo(destination);
  if (existing && !options.replace) {
    return { status: "skipped", backupPath: "", reason: "target already exists" };
  }
  if (typeof fetch !== "function") {
    throw new Error("GitHub install requires Node.js 18 or newer.");
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to download ${source}: ${response.status} ${response.statusText}`);
  }
  const backupPath = existing ? await backupExistingTarget(options.home, destination, options.backupId) : "";
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return { status: existing ? "updated" : "installed", backupPath, reason: "" };
}

async function fetchText(source) {
  if (typeof fetch !== "function") {
    throw new Error("GitHub install requires Node.js 18 or newer.");
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to download ${source}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function writeRemoteGeneratedClaudeCommand(operation, destination, options) {
  const existing = await pathInfo(destination);
  if (existing && !options.replace) {
    return { status: "skipped", backupPath: "", reason: "target already exists" };
  }
  const [skillText, referenceText] = await Promise.all([
    fetchText(operation.skillSource),
    fetchText(operation.referenceSource)
  ]);
  const templateText = await fetchText(operation.templateSource);
  const backupPath = existing ? await backupExistingTarget(options.home, destination, options.backupId) : "";
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, renderClaudeCommand(operation.skillName, skillText, referenceText, templateText), "utf8");
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
    for (const name of runtimeSkills) {
      operations.push({
        kind: "directory",
        source: path.join(repo, "skills", name),
        destination: path.join(home, ".codex", "skills", name)
      });
    }
  }
  if (normalizedAgent === "claude" || normalizedAgent === "all") {
    for (const skillName of runtimeSkills) {
      operations.push({
        kind: "generated-claude-command",
        skillName,
        source: path.join(repo, "skills", skillName),
        skillSource: path.join(repo, "skills", skillName, "SKILL.md"),
        referenceSource: path.join(repo, "skills", skillName, skillReferences[skillName]),
        templateSource: path.join(repo, "skills", skillName, "references", "subagent-task-template.md"),
        destination: path.join(home, ".claude", "commands", `${skillName}.md`)
      });
    }
  }
  return operations;
}

export function githubInstallPlan({ rawBase, home, agent }) {
  const normalizedAgent = agent === "codex" || agent === "claude" || agent === "all" ? agent : "";
  if (!normalizedAgent) {
    throw new Error(`Invalid agent "${agent}". Expected codex, claude, or all.`);
  }
  if (!home) {
    throw new Error("A home directory is required. Set HOME/USERPROFILE or pass --home.");
  }
  const operations = [];
  if (normalizedAgent === "codex" || normalizedAgent === "all") {
    for (const [skillName, files] of Object.entries(codexSkillFiles)) {
      for (const file of files) {
        operations.push({
          kind: "remote-file",
          source: rawUrl(rawBase, "skills", skillName, file),
          destination: path.join(home, ".codex", "skills", skillName, ...file.split("/"))
        });
      }
    }
  }
  if (normalizedAgent === "claude" || normalizedAgent === "all") {
    for (const skillName of runtimeSkills) {
      operations.push({
        kind: "remote-generated-claude-command",
        skillName,
        source: rawUrl(rawBase, "skills", skillName),
        skillSource: rawUrl(rawBase, "skills", skillName, "SKILL.md"),
        referenceSource: rawUrl(rawBase, "skills", skillName, skillReferences[skillName]),
        templateSource: rawUrl(rawBase, "skills", skillName, "references", "subagent-task-template.md"),
        destination: path.join(home, ".claude", "commands", `${skillName}.md`)
      });
    }
  }
  return operations;
}

export async function installSkills(options) {
  const operations = options.source === "github" ? githubInstallPlan(options) : installPlan(options);
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
    } else if (operation.kind === "remote-file") {
      result = await copyRemoteFile(operation.source, operation.destination, copyOptions);
    } else if (operation.kind === "generated-claude-command") {
      result = await writeGeneratedClaudeCommand(operation, operation.destination, copyOptions);
    } else if (operation.kind === "remote-generated-claude-command") {
      result = await writeRemoteGeneratedClaudeCommand(operation, operation.destination, copyOptions);
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

if (process.argv[1] === "-" || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
