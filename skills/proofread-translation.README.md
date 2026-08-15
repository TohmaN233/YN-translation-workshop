# proofread-translation

`proofread-translation` is the bundled runtime skill for structured translation review.

Runtime source:

```text
skills/proofread-translation/SKILL.md
skills/proofread-translation/references/proofread-workflow.md
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

- Compare source and translation line by line.
- Write exactly one machine-readable `[basename].proofread.json`; the product renders human-readable HTML from it.
- Use stable `id`, `severity`, `type`, `sourceLine`, `translationLine`, `sourceText`, `currentTranslation`, `suggestedFix`, and `rationale` fields.
- Do not overwrite source or translation files unless the user explicitly approves the edit workflow.
