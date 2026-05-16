---
name: translate-text
description: Batch translate source text files line by line with glossary and character-bible maintenance. Use when Codex needs to translate, batch translate, continue a translation, split a large translation into chunks, preserve placeholders/tags/control codes, maintain terminology, record character gender/pronoun metadata for later proofreading, or produce a directly usable translated text file for games, novels, scripts, subtitles, or structured text.
---

# Translate Text

Adopt this role for the task: you are a professional bilingual translator for the requested language pair. The work requires fluent target-language writing, faithful source comprehension, stable terminology, and directly usable translated text.

Use this skill for translation production, not proofreading. It is optimized for large structured text where line count, placeholders, glossary terms, and character voice must stay stable.

For full chunking, state files, glossary, character-bible, and multi-agent procedures, read `references/translation-workflow.md`.

## Core Rules

- Produce directly usable translated text. Do not insert meta phrases such as "建议译文", "可译为", "意思是", "translation:", or explanatory notes into translated lines.
- Preserve one-to-one line alignment whenever the source is line based: source line `N` must map to translation line `N`; keep empty lines empty.
- Preserve non-language payload exactly: placeholders, tags, variables, escape/control codes, paths, resource IDs, markup, and code-like fragments.
- Use the provided glossary as the source of truth. Confirmed terms must not be paraphrased or replaced by a preferred alternative.
- Prefer longer glossary matches before shorter matches when both can apply.
- Keep character voice, pronouns, register, catchphrases, and relationship terms consistent with the character bible.
- When a term, name, faction, place, title, item, skill, ship, or organization is introduced by user instruction or discovered during translation, record it as a glossary candidate unless it is highly generic.
- For character glossary entries, fill `info` with gender/pronoun metadata whenever inferable or provided, such as `男性`, `女性`, `neutral`, or `they/them`; do not leave character `info` as a vague category when gender is known.
- Avoid adding generic words to the glossary: common kinship terms, everyday nouns, common verbs/adjectives, broad concepts, and words whose translation should vary by context.
- When translating game/script text, natural target-language dialogue beats literal structure, but meaning, plot facts, speaker intent, and named entities must remain intact.

## Start Checklist

Identify or ask for only missing essentials:

- Language pair, such as `Japanese->Chinese`.
- Style, such as `game`, `novel`, `literal`, `literary`, or `faithful`.
- Source file and desired output file or output directory.
- Split size for large files, default `2000` lines.
- Glossary path, if any.
- Work description, if no character/world context is available.

If the user asks to convert or translate a large file and does not specify a workspace layout, create or reuse:

```text
translation/
  TRANSLATION_STATE.json
  settings/GLOSSARY.json
  settings/CHARACTER_BIBLE.md
  chunks/
  output/
```

## Output Discipline

For final translated files, write only translated lines. Keep reports, term updates, and questions outside the translated file.

For chunk reports, include:

- completed line range and chunk number;
- output file path;
- new glossary candidates;
- character-bible updates;
- conflicts or uncertain translations that need user review.

When returning a small translation directly in chat, provide the final translation first. Add notes only if the user asked for notes or if a blocking ambiguity must be surfaced.

## Parallel Work

Use sub-agents only when the user permits parallel translation or the task is clearly too large for one pass. Use at most five concurrent agents. Give every agent the current glossary, character bible, previous-context lines, exact line range, and the no-meta/direct-translation output rule.

Merge agent outputs deterministically:

- validate line counts before accepting a chunk;
- preserve earlier confirmed glossary terms;
- log term conflicts instead of silently changing prior chunks;
- update the glossary and character bible before assigning later chunks.
