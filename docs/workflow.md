# Workflow

## Line Review

1. Select a source TXT file.
2. Optionally select a translation TXT file.
3. Select an output folder.
4. Generate line review HTML.
5. Edit translation cells in the generated HTML.
6. Any edited cell is marked as a manual edit.
7. Click `Save TXT` to overwrite the translation file that was selected when the HTML was generated.
8. Click `Export TXT` to download a separate TXT copy without overwriting the selected translation file.
9. The generated HTML remembers page and scroll position with browser local storage.

`Save TXT` requires the generated HTML to be opened from the Electron app so the app bridge can write to the bound path. If the HTML is opened directly in a normal browser, it shows a warning instead of silently downloading.

## Translation Prompt

1. Select Codex or Claude Code.
2. Select source, optional translation, output folder, and optional glossary.
3. Generate the translation prompt.
4. Copy the prompt to the selected agent.

If no translation file is provided, the prompt asks the agent to write a translated file into the current output folder.

If a translation file is provided, the prompt requires a timestamped backup before overwrite.

## Proofreading Prompt

1. Select source, translation, optional glossary, and agent.
2. Generate the proofreading prompt.
3. Copy the prompt to the selected agent.
4. The agent should produce a Markdown report with concrete replacement suggestions.

## Proposal Review HTML

1. Select the Markdown proofreading report.
2. Generate the proposal review HTML.
3. Review each proposal as accepted, rejected, or manual edit.
4. The generated HTML remembers page and scroll position.
