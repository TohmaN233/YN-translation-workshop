# translate-text

`translate-text` is the bundled runtime skill for line-aligned translation.

Runtime source:

```text
skills/translate-text/SKILL.md
skills/translate-text/references/translation-workflow.md
```

The app reads this directory directly. Optional install/export commands only copy or render this same source for external tools.

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global --replace
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent claude --global --replace
```

Local checkout:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global --replace
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global --replace
```

Core contract:

- Preserve one source line to one translation line.
- Preserve placeholders, variables, control codes, tags, resource IDs, paths, and empty lines.
- Treat the selected glossary as authority.
- Maintain character voice and relationship consistency.
- Write only final translated lines to translation output files.
