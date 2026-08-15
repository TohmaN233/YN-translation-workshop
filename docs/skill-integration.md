# Workflow Sources

The repository keeps the translation and proofreading workflow sources here:

```text
skills/translate-text
skills/proofread-translation
```

They are maintained as domain reference material and optional external exports.
The product Agent UI has no skill selector, marketplace, installer, or external
Agent mode.

## Optional Export Targets

Codex target:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global --replace
```

Installs to:

```text
~/.codex/skills/translate-text
~/.codex/skills/proofread-translation
```

Claude Code target:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global --replace
```

Generates command files from the same bundled skill content and installs them to:

```text
~/.claude/commands/translate-text.md
~/.claude/commands/proofread-translation.md
```

Use `--agent all` to export both targets. The installer backs up replaced targets under `~/.translation-workshop/skill-backups/`.

## Runtime

The workshop does not need a global skill install. Product turns run through the
source-adapted Pi core `Agent` runtime; the fixed YN system prompt, host tools, artifact
validators, and completion gate implement the translation/proofreading
contract. There is no `readSkillReference` tool and no runtime dispatch to
Codex or Claude skill folders.

The installer above is a repository utility only. It is not imported by the
Electron main process, renderer, preload, or native Pi session service.
