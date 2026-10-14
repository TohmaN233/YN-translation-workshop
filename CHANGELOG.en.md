# Changelog

[中文](CHANGELOG.md) · [Project](README.en.md)

Recorded version changes. Public availability and downloads follow [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases).

## What's new in 2.2.0

- Fix oversized session loading, compact older sessions with verified backups, and reuse verified recovery state to avoid replaying history before chat; add loading progress and cancellation.
- Stabilize translation, review, and proofreading child prompt and tool prefixes for cache reuse across chunks. Context still resets after each chunk, with unchanged Host scope validation.
- Add a background Agent API: confirm the location and settings, then reuse lazy-mode preparation and execution; query status, stop, resume and answer questions.
- Support text-layer PDFs with extracted text, page/image references on demand for vision models, Host protection of identified code and mathematical formulas, and one-click translated PDF export. See the [PDF guide](docs/pdf.en.md).
- Fix mathematical PDF font detection and glyph binding; prefill and lock code/formulas in the Host so models submit only prose and cannot omit protected rows.
- Prescan source-evidenced package names, acronyms and structural labels; translation, review and residue checks share the retained identifiers to avoid false untranslated findings.
- Let the parent Agent confirm specific untranslated false positives in TXT, EPUB and PDF with a reason. Source or translation changes invalidate the confirmation; format, formula and code protection remain active.
- Prefill and protect PDF References/Bibliography in the Host, skip model translation of reference rows and retain their original glyphs on export. Cancellation waits for background resource cleanup and reports cleanup failures explicitly.
- Fix untranslated false positives from scattered English names, datasets and function names, and false project-change errors during later parent confirmations; retain copied-prose detection. Inline formulas may follow translated syntax within their paragraph, with native glyph export by marker identity; missing, repeated or cross-paragraph markers remain rejected.
- Reuse glossary longest-match coverage for character names, avoiding embedded short-name warnings while still checking independent occurrences.
- Save session recovery indexes on Stop and exit to avoid lengthy replay after restart; allow candidate discovery, validation and import with external read-only sources.
- Check and import large candidates in the background with progress and cancellation; commit drafts once without blocking the window on hundreds of thousands of lines.

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
