# Design

translation-workshop is a local-first desktop app for translation and proofreading workflows.

## Architecture

- `src/main` owns trusted desktop capabilities: file dialogs, filesystem reads/writes, opening generated files, and project state persistence.
- `src/renderer` owns the React UI and prompt workflow.
- `src/shared/core` owns deterministic logic that can be tested without Electron: line pairing, pagination, prompt generation, proofreading report parsing, and HTML rendering.
- `src/shared/i18n` stores user-facing application text for Chinese and English.

## Data Model

Generated work is stored in the selected output folder:

```text
.translation-workshop/
  project.json
  state.json
  backups/
  reports/
  html/
```

Generated HTML stores in-browser review state with `localStorage`, keyed by the HTML path. Export buttons let users download review-state JSON or TXT snapshots.

## Current Boundaries

TXT and EPUB line-review inputs are implemented. TSV remains deferred unless the workflow needs it. Agent work is intentionally interactive: the app can start a local Codex / Claude Code console, but it does not run a hidden background job or guess completion.

## Safety

Source files are read-only. Generated line-review HTML can overwrite the bound translation TXT/TSV only when opened from the Electron app, using the `workshopHtml.writeTextFile` preload bridge. The standalone browser fallback is an explicit warning, not a download. Generated agent prompts still instruct the agent to create a timestamped backup before overwriting any provided translation file.
