# Translation, proofreading and reference preparation

[中文](workflows.md) · [First run](guide.en.md)

## Translation

Prepare settings/rules → resolve source manifest → claim line chunks → write staging → mechanical validation → independent review → exact repair → promote accepted candidate → final validation.

Chunks use working-text lines, defaulting to 500; PDF rows represent complete preprocessed logical units with mappings to original pages and assets. Worker counts are ceilings. Model context resets after each chunk while Host retains accepted proof. Only directly matched terminology/character references are injected; missing context is searched as needed. Identified PDF code/math is fixed by Host and excluded from writable prose.

Suspected untranslated text can be a false positive, such as an identifier. After inspecting the exact source/candidate, the parent can use `confirmTranslationResidueSafe` with per-row reasons and continue the existing write/repair flow. Project decisions apply only to the exact row/text pair and expire when either changes. Children cannot authorize them. This applies to TXT, EPUB and PDF; all other structural checks remain enforced.

## Proofreading

Bind existing translation → scan all aligned rows → split review or stratified sampling → submit absolute-row findings/evidence → review or apply to HTML → user writes the file.

Suggestions carry the same preservation rules as translation. Semantic/style risks require context, not automatic hard rejection of every warning. Monte Carlo reports sampled coverage separately from exhaustive review.

## References

Read references → edit glossary/character drafts → read back → check → commit. Preparation can create a project without a translation. Drafts remain editable until transactional promotion to formal assets.

## Stop and resume

Stop cancels Pi and the pools before persisting cleanup. Recovery verifies source/draft counts, hashes, ownership and review proof before model calls. Unchanged accepted proof remains; changed rows reopen. A write-ahead receipt protects the file-replacement/checkpoint window during PDF protection normalization.

Internal errors, required-file loss, no-progress repairs and exhausted bounded reconnects stop the workflow. User Stop cancels automatic recovery. Resume does not retransmit all completed prose for retranslation.

Implementation: [YN Host](../src/main/agent/piNative/ynDomainTools.ts), [Supervisor](../src/main/agent/piNative/subagentSupervisor.ts), [child agents](../src/main/agent/piNative/subagentRunner.ts).
