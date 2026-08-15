---
name: translate-text
description: Batch translate source text files line by line with glossary and character-bible maintenance. Use for large game, novel, script, subtitle, or structured text translation where line count, placeholders, terminology, and voice consistency must stay stable.
---

# Translate Text

Use this skill for translation production, not proofreading.

Load `references/translation-workflow.md` before starting substantive translation work. That reference is the source of truth for chunking, workspace files, glossary handling, character-bible handling, subagent delegation, merge behavior, line alignment, and output validation.

Follow the host contract exactly: preserve one-to-one source/translation line alignment, placeholders, tags, variables, IDs, and empty lines; use the selected glossary as authority; keep character voice consistent; never put meta commentary inside translated output lines.
