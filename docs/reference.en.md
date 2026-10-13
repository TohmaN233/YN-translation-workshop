# Agent function reference

[中文](reference.md) · [Architecture](workflows.en.md) · [External Agent API](agent-api.en.md)

Names and descriptions below are taken from current source declarations. Availability depends on task type, project settings and assignment. This is not a fixed count of tools exposed to every model.

## ynDomainTools.ts

### recordTranslationPreservedTerms

Record words the user or supplied reference explicitly requires untranslated as confirmed source=target formal glossary entries. Include the exact requirement as rationale; never infer blanket exemptions. Existing targets cannot be overwritten. The Host merges and binds the canonical glossary transactionally; then inspectTranslationContext again before starting workers. This is independent of new AI candidate generation.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### resumeYnWorkflow

Idempotently resume one Host-owned workflow in this Pi session. Pass workflow=translation or workflow=proofread when a parked sibling exists. A bare call never switches from an active proofread/translation run to a parked sibling.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readTranslationDiscoveries

Page the current run's Host-persisted terminology and character discoveries, grouped by source identity with document and line evidence. Use this instead of re-reading child transcripts or requesting the entire batch payload.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readYnInterfaceContext

Read the currently visible generated YN page, its visible line range, and the focused source/translation row. Use this when the user refers to the current page, visible area, selected row, or 'this line'.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### inspectProofreadRange

Create a hash-bound bounded re-proofread scope for an exact aligned range. This is for later local review after edits and does not claim or require the complete proofread workflow prescan.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### fetchWebReference

Fetch and extract a public HTTP(S) reference URL. Use this before relying on a URL supplied by the user. The host validates redirects and network targets, uses the project proxy, and caches readable text for the parent and its subagents.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### inspectTranslationContext

Inspect the bound source, candidate artifact, glossary, character bible, style guide, and translation memory. Returned exists/available fields are authoritative; do not probe paths reported unavailable. The Host-provided typed operation decides whether this is translation, proofreading, or read-only inspection; tool arguments cannot switch workflows.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### selectSourceDocument

Select one file from the immutable host-resolved source-folder manifest before reading, delegating, writing, or validating that file.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### prepareTranslationReuseAudit

Before restarting or resuming translation, discover meaningful existing candidate work and run the hash-bound Host quick scan across the complete host-resolved manifest. In a folder workflow this always covers every retained document, regardless of the currently selected document. Aligned target-language lines without structural, source-residue, language, length, repetition, or contamination risk are retained automatically; only flagged lines require semantic review. This never changes the candidate.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readTranslationReuseAudit

Read at most 80 aligned source/current-translation pairs from a prepared reuse audit. Only Host-flagged high-risk lines require a semantic verdict; mechanically accepted lines are included only as nearby context.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### recordTranslationReuseAudit

Record the AI's final binary verdict for every Host-flagged high-risk line in an existing candidate. reuse means complete and faithful; retranslate means placeholder, untranslated, partial, wrong, or otherwise unusable. Host risk signals are evidence to investigate, not a forced verdict.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### runTranslationReuseAudit

Send only Host-flagged high-risk ranges from the prepared reuse audit to persistent read-only native Pi workers. Ordinary lines stay out of model context. Workers classify existing risky lines only; they never write translations.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### applyTranslationReuseDecision

Apply the user's one explicit whole-candidate-set reuse choice after every prepared document finishes AI semantic audit. The Host transactionally backs up all candidates, retains only AI-approved lines, and blanks the rest for validated Pi translation workers. Never call before the user answers.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### listAvailableModels

Query a bounded page of configured models only when the user explicitly requests a child-model override. Complete workflows already use their typed configured child model and must not call this tool before launching. Filter by providerId/query instead of requesting the complete catalog.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### inspectSubagents

Inspect lightweight child status and assignment progress. Full child Pi transcripts stay in child JSONL and are loaded only by the user's Reply panel. Use only when the user asks for status or a child appears stalled; completion wakes the parent automatically, so do not poll.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### steerSubagent

Send concise parent guidance into one currently running native Pi child. The child consumes it through Pi's steering queue.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readSourceLines

Read a one-based range from the bound read-only source document. Results are paged at 512 lines. Before translation starts, use bounded representative windows only when user-supplied references are insufficient to initialize requested glossary and character assets; do not turn starter initialization into an exhaustive full-source read.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readTranslationLines

Read a one-based range from the current canonical translation candidate only. Empty lines mean that chunk is still unpromoted staging or rejected, not that the range must be retranslated. For rejected rows after a child batch, call inspectTranslationAlignment then readTranslationAlignmentRows. Results are paged at 512 lines; continue from nextFromLine when hasMore is true.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readTranslationAlignmentRows

Required reader for parent alignment and takeover. Returns the current Host-selected rejected or audit rows with at most two neighboring source/translation lines from the hash-current candidate. Call inspectTranslationAlignment first. Never browse translation-staging with readProjectFile or searchProjectText.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### recordProofreadParentReview

Record an exact aligned range that the parent Agent has semantically reviewed after reading both source and translation. This is explicit semantic coverage, not a read receipt.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### readProjectFile

Read one bounded UTF-8 page only when that exact project or user-supplied reference file is needed. Do not use this for .translation-workshop/agent, translation-staging, or to reconstruct a rejected translation chunk. Use readSourceLines for the bound source and inspectTranslationAlignment/readTranslationAlignmentRows for rejected translation rows. A bound source document id or source filename resolves to the actual Host-bound file, including extracted EPUB text. Continue a genuinely needed long file with offsetChars. This tool never writes.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### initializeTranslationStarterAssets

Create every currently missing requested translation starter asset in one structured Host transaction after inspectTranslationContext. Supply glossary and character records, never JSON or Markdown. The Host owns canonical serialization, validation, rollback, and workflow readiness. Existing formal glossary, glossary candidates, or character bible are reused rather than overwritten.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### writeProjectFile

Write only noncanonical AI_translation/_workspace notes or settings files. Parent directories are created automatically: never create .gitkeep or initialize AI_translation. Translation starter glossary/character assets use initializeTranslationStarterAssets; later shared-asset updates use their typed Host discovery tools. Translation candidates must use writeTranslationChunk and proofreading reports must use writeProofreadFindings.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### listProjectDir

List a directory. Relative paths use the current project; absolute paths may point to user-provided external reference folders. This tool never writes.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### searchProjectText

Search UTF-8 project or user-supplied reference files for bounded terminology evidence. Parent may search Pi session JSONL under pi-sessions and pi-child-sessions to recover child artifacts. translation-staging and oauth-secrets stay blocked. For rejected translation rows use inspectTranslationAlignment and readTranslationAlignmentRows. Recursive project search excludes generated historical review HTML. This tool never writes.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### searchTranslationMemory

Search prior aligned source/target segments in the current project translation memory.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### decideTranslationWarningReview

After blocking validation passes, record whether the user wants the remaining non-blocking warnings judged as true/false positives. review authorizes inspectTranslationWarnings; skip completes the workflow and leaves the warnings as telemetry.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### inspectTranslationWarnings

Open the final non-blocking warning-review page after the user authorizes it. It returns exact canonical source/translation pairs and bounded neighboring context; warnings already accepted by hash-current chunk review are not repeated.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### recordTranslationWarningChecks

Submit only warning signals confirmed to be true translation defects for the active final-warning page. An empty failures array records every selected warning as a hash-current false positive. True positives become exact parent repair debt.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### inspectTranslationAlignment

Open a Host-owned parent takeover or mutation alignment page. Do not use this to poll live workers or to open a whole-document audit while children still write. After a listed parentTakeover, call this, then readTranslationAlignmentRows. Ordinary chunk review stays in the read-only review pool.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### recordTranslationAlignmentChecks

Submit only concrete failures for the current parent alignment page after readTranslationAlignmentRows (legacy exact paired reads remain accepted). An empty failures array accepts every Host-selected row on that page. Correct rows produce no verdict payload or reason. Full multi-line workflows normally accept review results from the read-only translation-review Pi pool.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### writeTranslationChunk

Strictly validate and atomically write one exact line range into the named translation candidate without changing the active workflow document. PDF tasks submit only translatableLines as entries; the Host merges immutable code/math. Legacy full-line arrays remain supported with exact protection checks.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### validateTranslationArtifact

Run blocking artifact validation for the bound file, every file in a generated folder workflow, or only mutated documents in a bounded repair. Warnings remain non-blocking telemetry but unreviewed warning signals become the final post-translation review step; use inspectTranslationWarnings rather than treating them as validation failures.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### writeProofreadFindings

Write extra proofread findings or drop false positives. Host fills sourceText and currentTranslation from the bound aligned line; send only line numbers, suggestedFix, and rationale. suggestedFix must preserve source placeholders, tags/control codes, and configured custom-preservation matches on one physical row. Invalid replacements are returned with exact reasons; follow nextAction to retry. After Host-planned children finish, do not resubmit or clear their artifact — call finalizeProofreadReport. An empty findings list cannot replace existing child findings.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### resolveProofreadGlossaryCandidates

Accept or reject evidence-bound proper-term candidates returned by proofreading children. Accepted candidates are merged into the validated workspace glossary candidate JSON; ordinary vocabulary must be rejected. Finalization is blocked while any candidate remains pending.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### finalizeProofreadReport

Validate the sole merged findings JSON artifact and close the proofreading completion gate. Call only after all split children, or after the host reports Monte Carlo convergence.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### resolveProofreadMontecarloLimit

Apply the user's explicit choice after Monte Carlo reaches its round ceiling without convergence: continue for three rounds, switch only HOT regions to split review, or stop and finalize current findings.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### runProofreadSubagents

Start host-planned native Pi proofreading workers in the background. In split mode, splitSize defines queued assignment blocks while workerCount only limits persistent Pi worker concurrency. The host owns every line assignment; optional worker records only select labels or configured models.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### runSubagents

Delegate concrete investigation or bounded translation-repair tasks to native Pi children. Project worker settings are concurrency preferences, never an authorization gate. A translation_repair task must list every writable row in lines; fromLine/toLine are only its read-only envelope. The Host rejects unlisted writes. First locate the concrete target and evidence. Preserve each task's distinct objective; never substitute the full translation/proofreading workflow queue.

[Source](../src/main/agent/piNative/ynDomainTools.ts)

### runTranslationSubagents

Start the complete native Pi translation worker queue in the background. Optional workerCount selects a concurrency ceiling within the configured project maximum; the Host still caps live workers to real assignments. The Host alone plans single-file and folder assignments from canonical split size, file order, accepted evidence, terminology priority debt, and any persisted reuse mask. Never pass tasks or ranges. Retained reuse lines are never repartitioned. Return immediately so the parent remains interactive; inspect structured cards only when needed.

[Source](../src/main/agent/piNative/ynDomainTools.ts)


## subagentRunner.ts

### searchProjectText

Search UTF-8 files and return bounded, match-centered file/line evidence. For the canonical glossary, character bible, and glossary-candidate paths, one source/name lookup returns complete matching structured records, including their target forms and aliases; do not repeat the query against parent folders or translated spellings. A bound source document id or source filename resolves to the actual Host-bound file, including extracted EPUB text. Other relative paths use the current project; absolute paths may point to user-provided external references. Omit path, pass a blank path, or use '.' for the project root. Recursive project search excludes Pi transcripts and generated historical review HTML; pass the exact HTML path only when it is genuinely required. This tool never writes.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### repairAssignedTranslation

After reading the host-reported required lines yourself with readAssignedSource, submit structured { line, translation } repairs. Never echo source text unchanged; every other translated line is already retained.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### validateAssignedTranslation

Validate the assigned range and submit evidence-backed discoveries exactly once after writing. A successful call is terminal for this artifact turn.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### readAssignedProofreadContext

Read the aligned source and translation for the Host-owned assignment, boundary context, deterministic host signals, and approved project references. Follow the built-in proofreading workflow in the system instructions.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### readProofreadReference

Read the next bounded chunk of a project proofreading reference whose manifest entry has complete=false. Entries returned with complete=true are already fully read and must not be requested again. Start at offset 0 and continue only from the returned nextOffset.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### readBoundSourceLines

Read exact one-based lines from the source document delegated by the parent.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### readBoundTranslationLines

Read exact one-based lines from the current translation candidate delegated by the parent.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### readAssignedTranslationReview

Read every Host-selected mechanical-risk row and deterministic clean sample with short neighboring context. Selected rows are mandatory review targets; a context row may also be rejected when it clearly shares or continues the discovered defect.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### submitTranslationReview

Accept the selected review scope with no failures, or reject concrete bad lines with an actionable repair note. A clearly bad context row may be included; Host promotes it to repair debt and centers the next review window on it. Never emit per-line pass verdicts.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### readAssignedTranslationAudit

Read the exact aligned source/current-translation pairs assigned for semantic reuse review.

[Source](../src/main/agent/piNative/subagentRunner.ts)

### submitTranslationAudit

Submit one semantic verdict for every assigned line that requires semantic review.

[Source](../src/main/agent/piNative/subagentRunner.ts)


## pdfReferenceTools.ts

### inspectPdfReferences

Read only the lightweight PDF page/figure index for source lines that mention figures, tables or other visual evidence. Specify documentId from the native manifest for a folder. No image bytes enter context. Use viewPdfReference only when that passage needs the visual; never view every page by default. TXT/EPUB documents return available=false.

[Source](../src/main/agent/piNative/pdfReferenceTools.ts)

### viewPdfReference

View one read-only PDF image or page referenced by a source passage. First inspectPdfReferences; cite the relevant sourceLine and explain the visual ambiguity. Requires the configured model to accept images. The tool returns a native Pi image block, never an automatic attachment to every assignment.

[Source](../src/main/agent/piNative/pdfReferenceTools.ts)
