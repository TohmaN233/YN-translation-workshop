export type SkillInstallAgent = "codex" | "claude" | "all";

export const bundledSkillPaths = {
  codex: {
    translate: "skills/codex/translate-text",
    proofread: "skills/codex/proofread-translation",
    installTarget: "~/.codex/skills"
  },
  claude: {
    translate: "skills/claude/commands/translate-text.md",
    proofread: "skills/claude/commands/proofread-translation.md",
    installTarget: "~/.claude/commands"
  }
} as const;

export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, "\\\"")}"`;
}

function joinLocalPath(repoRoot: string, ...parts: string[]): string {
  const root = repoRoot.replace(/[\\/]+$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  return [root, ...parts].join(separator);
}

export function buildLocalSkillInstallArgs(repoRoot: string, agent: SkillInstallAgent): string[] {
  const scriptPath = joinLocalPath(repoRoot, "scripts", "install-skills.mjs");
  return [
    scriptPath,
    "--agent",
    agent,
    "--global"
  ];
}

export function buildLocalSkillInstallCommand(repoRoot: string, agent: SkillInstallAgent): string {
  return ["node", ...buildLocalSkillInstallArgs(repoRoot, agent)].map(quoteShellArg).join(" ");
}
