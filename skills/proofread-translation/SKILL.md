---
name: proofread-translation
description: Structured multilingual translation proofreading for source/translation file pairs. Use to compare source and target files, classify translation issues, run sampled or split reviews, write JSON findings, and produce directly actionable fixes.
---

# Proofread Translation

Use this skill to proofread an existing translation against its source text.

Load `references/proofread-workflow.md` before starting substantive review work. That reference is the source of truth for severity levels, preprocessing, automated checks, Monte Carlo and split modes, and the sole JSON findings artifact. Human-readable HTML is derived from that JSON by the product.

Write machine-readable findings as JSON. Do not write Markdown fix proposals.
