# translation-workshop

[中文 README](README.md)

translation-workshop is a local translation / proofreading workbench. It pairs source text and translated text line by line, generates editable review HTML for human revision, helps generate Codex / Claude Code translation and proofreading prompts, and converts proofreading Markdown reports into reviewable HTML.

The motivation is simple: as someone who has participated in fan translation work, I find most AI translation tools unfriendly to actual translation workflows. No matter how impressive AI output looks, it still needs human review before it can reach commercial quality. A comfortable frontend for translation and proofreading is therefore not optional; it is a major missing piece.

This project aims to build:

1. A frontend tool that is comfortable even for translators who do not use AI.
2. A workflow where translators who do use AI can lean on Agent translation / proofreading while keeping the review process convenient and visible.
3. A path for users who do not know the source language to still use AI for translation, proofreading, and visual result review.

The project bundles Codex and Claude Code versions of the skills. It currently supports Agent-based translation, not direct API-only translation through prompt engineering.

- [translate-text guide](skills/translate-text.README.md): batch translation, glossary handling, and character notes.
- [proofread-translation guide](skills/proofread-translation.README.md): line-by-line proofreading, Monte Carlo sampling, and fix proposal reports.

- Codex directory skill: `skills/codex/<skill-name>/SKILL.md`
- Claude Code slash command: `skills/claude/commands/<skill-name>.md`

## Current Features

- Electron + React + TypeScript desktop app
- Chinese / English bilingual UI

<p align="center">
  <img src="graph_for_intro/face_ch.png" alt="Chinese UI" width="420">
  <img src="graph_for_intro/face_en.png" alt="English UI" width="420">
</p>

- Line-by-line review HTML generation
- Separate-file and bilingual-file modes

TXT and EPUB are supported.

Basic usage:

Select the source file, select the translation file, select the output folder, then generate the line-review HTML.

For bilingual files, choose which adjacent line position is the source text.

You can also provide only a source file and leave translation blank for translation-only work.

- Folder input is supported.
- HTML pagination, page jumping, scroll position memory, and manual-edit state.

Manually edited rows are highlighted, and reopening the HTML can return to the last active row with a yellow outline.

<p align="center">
  <img src="graph_for_intro/t1.png" alt="Line-by-line review HTML" width="920">
</p>

- TXT / EPUB files can be exported at any time. TXT files can also be written back to the bound TXT file or synced from external edits. A timestamped backup is created before TXT overwrite.
- The glossary can be browsed while translating. Term translations can be edited and applied to the current page or the whole text. Missing glossary terms in the target side are also highlighted, with longer terms taking priority over shorter contained terms.

<p align="center">
  <img src="graph_for_intro/t2.png" alt="Glossary tools and term replacement" width="920">
</p>

---

Agent workflow:

- Translation prompt parameter window and prompt generation.

<p align="center">
  <img src="graph_for_intro/t3.png" alt="Translation prompt parameter window" width="920">
</p>

- Proofreading prompt parameter window and prompt generation.
- Interactive Codex / Claude Code terminal console. Make sure the CLI is installed and logged in.

<p align="center">
  <img src="graph_for_intro/t4.png" alt="Interactive Agent Console" width="920">
</p>

- Proofreading Markdown report discovery, parsing, and review HTML generation.

<p align="center">
  <img src="graph_for_intro/t5.png" alt="Proofreading report review HTML" width="920">
</p>

  - Can bind to the line-review HTML and mark corresponding lines with issues found in the proofreading report.
  - Can jump back to the source review page to inspect context.
  - Can apply AI-suggested translations or manual rewrites back to the main text.

<p align="center">
  <img src="graph_for_intro/t6.png" alt="Line review and proofreading report linkage" width="920">
</p>

- Project state is saved under `.translation-workshop/` in the selected output folder, so the project folder can be reopened later.

## Launch Like An App

Windows:

```bat
start-workshop.cmd
```

macOS / Linux / Git Bash:

```bash
./start-workshop.sh
```

The launch scripts install dependencies when `node_modules` is missing, build when `dist` is missing, and then open the Electron app.

## Basic Workflow

1. Choose Codex or Claude Code on first launch.
2. Check the bundled skill / command path and local install status. You can copy the install command and run it in a console such as PowerShell.
3. Select a source TXT / EPUB file or a source folder.
4. Optionally select a translation TXT / EPUB file or a translation folder.
5. Select an output folder.
6. Generate line-review HTML.
7. In the HTML, translate or revise target text manually, jump pages, search, replace glossary terms, or generate a translation prompt when there is no translation yet. Open the Agent Console for AI translation, then import the translated TXT when finished.
8. Generate a proofreading prompt, then copy it or send it to the interactive Agent Console.
9. After proofreading finishes, select or auto-discover the Markdown report and generate the fix-proposal review HTML.
10. After review, use `Save TXT` to overwrite the bound translation TXT, or `Export TXT` to save a separate copy.

## Codex Skill Setup

Bundled paths:

- Translate: `skills/codex/translate-text`
- Proofread: `skills/codex/proofread-translation`

The app only copies the install command. It does not automatically write to your global Codex configuration. The GitHub command is recommended and works for installed, portable, and no-clone setups. It requires Node.js 18 or newer:

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global
```

If you have cloned the repository, you can also install from the local path:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global
```

Install targets:

- `~/.codex/skills/translate-text/SKILL.md`
- `~/.codex/skills/proofread-translation/SKILL.md`

The installer skips existing skills by default. Add `--replace` only when you intentionally want to update an existing target; the old target is backed up under `~/.translation-workshop/skill-backups/` first.

## Claude Code Skill Setup

Bundled paths:

- Translate: `skills/claude/commands/translate-text.md`
- Proofread: `skills/claude/commands/proofread-translation.md`

The app only copies the install command. It does not automatically write to your global Claude Code configuration. The GitHub command is recommended and works for installed, portable, and no-clone setups. It requires Node.js 18 or newer:

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent claude --global
```

If you have cloned the repository, you can also install from the local path:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global
```

Install targets:

- `~/.claude/commands/translate-text.md`
- `~/.claude/commands/proofread-translation.md`

The installer skips existing commands by default. Add `--replace` only when you intentionally want to update an existing target; the old target is backed up under `~/.translation-workshop/skill-backups/` first.

## File Support

| Format | Current support |
| --- | --- |
| TXT | Line-review HTML, write back, export |
| EPUB | Text extraction into line-review HTML |
| Bilingual TXT | Adjacent-line source / translation position splitting |
| Bilingual EPUB | Adjacent-line source / translation position splitting |
| Glossary | JSON, tab-delimited, `=>`, `->`, `=`, and comma-separated pairs |
| Markdown report | Report discovery and review HTML |

## Safety Notes

- Source files are read-only and never modified.
- The app does not automatically install global Codex / Claude Code skills. It only performs read-only detection and copies install commands.
- The installer skips existing global targets by default.
- `--replace` backs up the exact target before updating it.
- `Save TXT` writes to the bound translation path only when the HTML is opened from the Electron app.
- The Agent Console is a real interactive terminal. The app does not run hidden background jobs or pretend to know completion. Sync translations or discover reports manually after the agent finishes.

## Extra

For stress testing near the final stage, you can run the following proofreading mode in your own client.

```text
You are a Translation Project Manager. please ask 3 (or any number, larger is harder to pass the test) sub-agents to do the following job, start at different seeds.

Please use the proofread-translation skill to run a Monte Carlo translation-quality stress test on the following source/translation pair.

Goal:
- Check whether a large translation still contains serious translation-quality issues.
- Focus only on true actionable issues found in sampled lines; every candidate must be manually judged.
- Do not repeat global scans, old-report comparisons, or full terminology audits that have already been completed, unless I explicitly ask for them.

Inputs:
- Review mode: montecarlo
- Type: {game/novel/technical/subtitle/academic}
- Source language: {SOURCE_LANGUAGE}
- Target language: {TARGET_LANGUAGE}
- Source file: {SOURCE_FILE}
- Translation file: {TRANSLATION_FILE}
- Glossary file, optional: {GLOSSARY_FILE}
- Sample size per round: {SAMPLE_SIZE, default 5000}
- Confirmed-issue line exclusion set: {KNOWN_ISSUE_LINES, may be empty}

Scope for this stress test:
- Focus on HIGH translation-quality risks: mistranslation, misaligned line, omission, empty translation, severe over-translation/line bleed, AI/reviewer meta-language contamination, source-language residue, number/list-index errors, lost or translated code placeholders/tags, abnormal expansion, and hallucination.
- If an H9 expansion/hallucination issue is found in the sample, retranslate the full source line and provide that full replacement as the suggested translation.

Output requirements:
- Every issue must include: global line number, source text, current translation, issue explanation, severity, and a complete directly replaceable suggested translation.
- Every severity level (HIGH/MEDIUM/LOW) must include a complete suggested translation. Do not provide only a direction, a partial replacement, or meta wording such as "suggest changing to".
- The suggested translation field must contain only the final replacement text itself.
- If a candidate is a false positive, explain why and continue; it does not count as a failure.
- If a sampled line is in the confirmed-issue exclusion set, mark it as a known issue and exclude it; it does not count as a failure.

Convergence rule:
- Start counting from the translation state after the most recent applied fix.
- If a new true issue is found: report the full suggested translation and stop. The manager will apply the fix, then convergence counting must restart.
- If no new true issue is found, continue with a different seed.
- This lane converges after {CLEAN_ROUNDS, default 2} consecutive different seeds produce no new true issues.
- Multiple agents run in parallel, every lane must independently satisfy this convergence rule. O.W., all agent should do a totally new round after fixes of manager.

Environment note:
- On Windows PowerShell, force UTF-8 output before reading files or running scripts:
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
- If Python is used, set:
  $env:PYTHONUTF8='1'
  $env:PYTHONIOENCODING='utf-8'

Final response:
- List the seeds used.
- State whether convergence was reached.
- List any new true issues found.
- Summarize false-positive candidates.
- List excluded known-issue lines.
```
