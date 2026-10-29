# Changelog

[中文](CHANGELOG.md) · [Project](README.en.md)

Recorded version changes. Public availability and downloads follow [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases).

## What's new in 2.2.8

- Improve EPUB extraction and export with shared paragraph mapping, ruby and vertical/Kobo markup cleanup, consistent language and reading direction, preserved navigation links, and separate copies for repeated exports.

## What's new in 2.2.7

- Fix TXT translation matching and importing in EPUB folder projects, including nested books with the same name and older review pages.

## What's new in 2.2.6

- Edit AI glossary candidate translations before importing them into the formal glossary.
- Keep the chosen warning-review action throughout a multi-file translation workflow, avoiding repeated prompts.
- Apply proofreading reports and jump to existing review pages in EPUB folder projects.

## What's new in 2.2.5

- Fix EPUB review page initialization and multi-file translation startup, including projects that keep source EPUBs and generated files in the same folder.

## What's new in 2.2.4

- Final translation review now offers a Continue/Skip prompt, so you can choose directly instead of describing the next step in natural language.
- Applying review suggestions in single-file mode automatically imports the complete translation into the review page and applies the changes, matching multi-file mode.

## What's new in 2.2.3

- Keep folder review pages usable after applying proofreading, preserving manual edits and the selected file.
- Show unresolved alignment failures and keep repair reads bound to the correct document.

## What's new in 2.2.2

- Fix proofreading navigation to reuse imported translations in the original HTML and preserve EPUB export when rebuilding a missing page.

## What's new in 2.2.1

- Improved project path resolution keeps proofreading changes, navigation and exports bound to the same document, including after moving a project.

## What's new in 2.2.0

- Add text-layer PDF translation: extract prose, formulas, code and figure assets, organize and audit the document structure, then generate review HTML and reflow translated prose with preserved assets into a new PDF. Support complete paragraphs, page continuations and paragraph-local formula reordering while preserving code, formulas and references. See the [PDF guide](docs/pdf.en.md).
- Add the official background Agent API, reusing project preparation, translation, proofreading and reference workflows, with status queries, Stop, resume and user replies.
- Improve large-project handling: load large histories and validate/import translation candidates in the background with progress and cancellation; optimize session recovery and cross-chunk cache reuse.
- Improve editing: activate generated HTML automatically and streamline page opening, translation imports, saving and closing while preserving manual edits.
- Reduce false untranslated and terminology findings from English identifiers and character names; let the parent Agent confirm specific untranslated false positives.

## What's new in 2.1.9

- Fix the single-file mode regression introduced in 2.1.4.

## What's new in 2.1.7–2.1.8

- Exclude actual regex-preserved matches and correctly aligned glossary pairs from untranslated checks. Record explicitly preserved words as formal source-to-identical-target terms; validate the remaining prose with the same rules for candidate imports and AI review. Glossary matching, terminology conflicts, and recovery rescans also exclude regex-preserved spans.

- Automatically reconcile stale review bindings in Host, retain unchanged accepted evidence, and resume work. Fix batch settlement after Stop.

## What's new in 2.1.6

- Stop when bound required files disappear, preserving drafts and reporting the missing path. Unbound glossary and character tables remain optional.
- Fix Stop and project shutdown deadlocks.
- Fix Electron HTML closing and task cancellation bindings; failed saves report the error and preserve edits.
- Use relative bindings for project settings, HTML and recovery artifacts. Copying a complete project retains parent/child Agent history, drafts and review evidence. External source/reference files must be transferred and selected again.

## What's new in 2.1.5

- Fix large-file translation freezes with range-scoped chunk checks and background final validation, preserving structural checks, review and recovery.
- Apply translation preservation rules and mechanical checks to proofreading suggestions to protect control codes, tags and placeholders.
- Fix concurrent recovery: Host verifies and reconciles translations, staging and review evidence before starting Workers. Failed commits preserve recoverable artifacts; unretryable internal errors stop the workflow.

## What's new in 2.1.4

- Create a project from reference preparation before translating. Clear homepage entries and restore task defaults in one click.
- Reference preparation uses editable drafts, checks them, then commits both formal assets together. Interrupted or failed tasks retain their drafts.
- One-click setup checks parameters against the source and trials control-token rules, then uses the shared HTML parameters and translation prompt. Generate line-by-line HTML first for hands-on control.
- Removed the unused chunking toggle. Folder HTML initializes the file order inside braces and preserves explicit selections.

- Configure providers and models at the top of the homepage before opening a project or HTML; settings are shared globally.

- Built-in task setup opens HTML and starts translation or proofreading after settings confirmation; reference materials can be organized directly. Defaults: 500 lines and up to 3 agents, with preservation-rule scanning before translation.
- Editable HTML character tables and optional proofreading auto-apply to HTML; TXT saving remains manual.
- Fixed canceled tasks and compaction starting after Stop.

## What's new in 2.1.3

- Fixed Grok 4.7 requests incorrectly sending `reasoning_effort=none`: Auto and legacy Off selections use the official `high` default; models without known effort controls omit the parameter.
- HTML glossary management separates approved terms and AI candidates. Preview, search and delete candidates before import, or delete approved entries individually. Deletion affects only the selected table; older HTML upgrades when opened.
- Upgrade the core to 0.99.1 with compatibility updates to prevent regressions.

## What's new in 2.1.2

- Standard Provider model catalogs can refresh automatically from upstream Pi, with local cache and bundled-catalog fallback when the network is unavailable.
- Fixed inconsistent state when resuming parked translation-reuse workflows, retrying proofreading glossary candidates, and restoring typed Workflow intent.
- Aligned structured repair capacity with the 500-line model page and merged duplicate length-risk signals for the same line.

## What's new from 2.0.5 to 2.1.0

- Very large review pages open now: the 80 MiB hard reject is gone, and jumping from a suggestion to the source dropped from about 4s to 1–2s in testing.
- Large-file translation and proofreading are steadier: memory no longer climbs without bound, and prescans no longer freeze the main window.
- The main window is responsive, and a character can have multiple dialogue lines.
- Opening Agent or sending a short prompt no longer yanks the review page to the top.
- Mobile remote is a full-screen workspace, with Agent in the tools drawer.

### 2.0.1 – 2.0.5: Workflow reliability and Providers

- Proofreading and EPUB jobs consistently follow the translation explicitly selected on the page. When no file was selected manually, completed translation output becomes the authoritative `translated` binding instead of a temporary snapshot.
- Added **Grok (OAuth)**, model-specific thinking levels, and long-reasoning waits. Expired authorization refreshes and resumes the current work instead of stopping the entire batch.
- Exhausted translation review hands exact failed lines back to the parent Agent. The Host refreshes proofreading findings from current bound rows, and accepted results cannot be erased by a later empty write or rejected item.
- Longer glossary names cover shorter names, cross-file terminology differences move to final warning review, and disabling glossary candidates also disables their construction, updates, and validation.
- Batch apply preserves human edits and TXT-written status. Workflow recovery explicitly distinguishes translation from proofreading to avoid resuming the wrong job.
