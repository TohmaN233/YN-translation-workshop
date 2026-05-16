---
name: proofread-translation
description: Structured multilingual translation proofreading for source/translation file pairs. Use when Codex needs to review translations for any source and target language pair, including Chinese or English targets; compare source and target files; classify translation issues; run Monte Carlo sampling; split a translation into line-by-line chunks; apply approved fixes; use a glossary; or adapt proofreading for game, novel, technical, subtitle, or academic text.
---

# Proofread Translation

Adopt this role: professional translation reviewer for the requested language pair. Prioritize accurate source comprehension, fluent target-language judgment, terminology discipline, and directly applicable replacement translations.

Use this skill to proofread a translation against its source text with explicit severity labels, line references, and repair options. The full procedure lives in `references/proofread-workflow.md`; load it before starting any substantive review.

## Inputs

Parse the user's request for:

- Review mode: `montecarlo` or `split N`.
- Translation type: `game`, `novel`, `technical`, `subtitle`, or `academic`.
- Source language and target language, if stated or inferable.
- Source file path and translation file path.
- Optional glossary file path.

If a required input is missing, ask only for that item. If the language pair is not explicit, infer it from file names, content, glossary entries, or the user's wording; ask only when the target language remains ambiguous.

## Workflow

1. Read `references/proofread-workflow.md` before substantive review.
2. Load source, translation, and optional glossary with UTF-8.
3. Determine the target language's conventions before judging grammar, punctuation, pronouns, quotes, register, and style. For example, English targets use English punctuation and pronoun rules; Chinese targets use Chinese punctuation and Chinese pronoun/style rules.
4. Align source and translation by line when possible; otherwise use the fallback alignment rules in the reference.
5. Always run the shared preprocessing before review:
   - H3 terminology false-positive filtering with longest-match handling.
   - H9 length-anomaly prescan with thresholds selected for the language pair; English targets allow larger expansion than Chinese targets.
   - Automated checks for untranslated source text, AI contamination, pronoun issues, and terminology mismatches where applicable to the language pair.
6. Apply the selected mode:
   - `montecarlo`: classify regions, sample by region priority from a non-repeating sampled-line pool, iterate until convergence, and write the two-file final report without editing the translation.
   - `split N`: review every line in each chunk, report findings per chunk, edit the main translation file only after the user explicitly approves the proposed fixes, and consolidate remaining findings into the same two-file final report.
7. When stable proper nouns or world-specific terms are discovered outside the glossary, record them as candidate term-table entries for later merge. Prefer names, places, organizations, species, titles, and setting terms; avoid generic words, common nouns, and short ambiguous fragments unless the user confirms them.

## Reporting Rules

- Use two separate output-language settings:
  - `report_language`: the language the user is using to communicate in this request or conversation, unless they explicitly request another report language.
  - `target_language`: the language of the translation being reviewed.
- Write report headings, explanations, issue descriptions, confidence notes, summaries, and handling options in `report_language`.
- Write every `Suggested translation` value only in `target_language`; never translate that field into `report_language` unless the two are the same.
- Include global line numbers, source text, current translation, issue code, severity, explanation, and `Suggested translation` for every finding.
- For every severity level (HIGH, MEDIUM, and LOW), provide a concrete `Suggested translation` that can directly replace the current target line.
- For H9 expansion/hallucination findings, retranslate the source line and put the full corrected target-language text in `Suggested translation`.
- The `Suggested translation` field must contain only the final target-language text to write back. Do not include meta phrases, explanations, labels, quotes, or search/replace instructions inside that field.
- Mark uncertain findings with a "needs verification" note instead of overstating confidence.
- Include exactly one default handling option per finding.
- Treat confirmed glossary mismatches as H3.
- For split-review edits, verify the target line still matches the expected old text before replacing it.

## Final Output Contract

This two-file contract overrides any older single-report examples in the reference workflow.

Write final proofreading output as two Markdown files with the same basename in the translation file directory:

- Human summary: `[basename]_proofread_summary.md`
- Structured findings: `[basename]_fix_proposal.md`

The summary is for human reading and dashboards. The fix proposal file is for translation-workshop parsing and review HTML generation. Do not mix summary prose into the fix proposal file.

The fix proposal file must start with this line-based header shape:

```markdown
# Fix Proposals - <basename>

Source:        <source path>
Translation:   <translation path>
Generated:     <ISO timestamp>
Mode:          <montecarlo | split N>
Summary:       ./<basename>_proofread_summary.md
```

Every finding in `[basename]_fix_proposal.md` must use this block shape:

```markdown
### H1-001 | MC L123
**Source**: `<source text verbatim>`
**Current translation**: `<current translation verbatim>`
**Issue**: <brief explanation in report_language>
**Suggested fix**: `<complete replacement in target_language>`
- [ ] Accept suggestion
```

Use `Chunk 001 L123` instead of `MC L123` for split-review findings. `Suggested fix` must be a complete replacement line in the target language, not an explanation or partial edit.
