# Skill Integration

## Codex

Bundled translate skill:

```text
skills/codex/translate-text
```

Bundled proofread skill:

```text
skills/codex/proofread-translation
```

The app only copies this command; it does not execute global skill installation:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global
```

Targets:

```text
~/.codex/skills/translate-text/SKILL.md
~/.codex/skills/proofread-translation/SKILL.md
```

The installer skips existing targets by default. Use `--replace` only when you intentionally want to update an existing bundled target; it first backs up the exact target under `~/.translation-workshop/skill-backups/`. You only need one agent configured, so a Codex-only or Claude-only setup is valid.

## Claude Code

Bundled translate command:

```text
skills/claude/commands/translate-text.md
```

Bundled proofread command:

```text
skills/claude/commands/proofread-translation.md
```

The app only copies this command; it does not execute global skill installation:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global
```

Targets:

```text
~/.claude/commands/translate-text.md
~/.claude/commands/proofread-translation.md
```

The installer skips existing targets by default. Use `--replace` only when you intentionally want to update an existing bundled target; it first backs up the exact target under `~/.translation-workshop/skill-backups/`. You only need one agent configured, so a Codex-only or Claude-only setup is valid.

## Interactive Agent Console

The app keeps agent work interactive. It can start Codex or Claude Code in a terminal console when the selected CLI is available on PATH, then the user sends the generated prompt or any follow-up messages directly.

The console is a real terminal emulator backed by the selected CLI. The app shows a small status hint: stopped, running, waiting, streaming, or quiet. Quiet only means output has stopped for a short interval; the app does not claim the agent has completed until the user verifies the result and runs manual sync/report detection.
