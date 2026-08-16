# Translation Workflow

## Scope

This workflow is for translation production, not proofreading. It is optimized
for large structured text where line count, placeholders, glossary terms, and
character voice must stay stable.

## Core Rules

- Produce directly usable translated text. Do not insert meta phrases such as
  "建议译文", "可译为", "意思是", "translation:", or explanatory notes into
  translated lines.
- Every non-empty translated line must be a complete target-language line that
  can replace the matching source line as-is. Do not output fragments, partial
  alternatives, TODOs, comments, labels, or explanations as translated text.
- Preserve one-to-one line alignment whenever the source is line based: source
  line `N` must map to translation line `N`; keep empty lines empty. Before
  finalizing, self-check that source line count equals output line count and
  every output line maps to the same source line number.
- Preserve non-language payload exactly: placeholders, tags, variables,
  escape/control codes, paths, resource IDs, markup, and code-like fragments.
- Use the provided glossary as the source of truth. Confirmed terms must not be
  paraphrased or replaced by a preferred alternative.
- Prefer longer glossary matches before shorter matches when both can apply.
- Keep character voice, pronouns, register, catchphrases, and relationship terms
  consistent with the character bible.
- When a term, name, faction, place, title, item, skill, ship, or organization
  is introduced by user instruction or discovered during translation, record it
  as a glossary candidate unless it is highly generic.
- For character glossary entries, fill `info` with gender/pronoun metadata
  whenever inferable or provided, such as `男性`, `女性`, `neutral`, or
  `they/them`; do not leave character `info` as a vague category when gender is
  known.
- Avoid adding generic words to the glossary: common kinship terms, everyday
  nouns, common verbs/adjectives, broad concepts, and words whose translation
  should vary by context.
- When translating game/script text, natural target-language dialogue beats
  literal structure, but meaning, plot facts, speaker intent, and named entities
  must remain intact.

## Start Checklist

Identify or ask for only missing essentials:

- Language pair, such as `Japanese->Chinese`.
- Style, such as `game`, `novel`, `literal`, `literary`, or `faithful`.
- Source file and desired output file or output directory.
- Split size for large files, default `2000` lines.
- Glossary path, if any.
- Work description, if no character/world context is available.

If the user asks to convert or translate a large file and does not specify a
workspace layout, create or reuse:

```text
translation/
  TRANSLATION_STATE.json
  settings/GLOSSARY.json
  settings/CHARACTER_BIBLE.md
  chunks/
  output/
```

`TRANSLATION_STATE.json` should record source path, output path, language pair,
style, checkpoint interval, total lines, total checkpoint chunks, completed
chunks, last completed chunk, status, glossary count, character count, and
timestamp. If an in-progress state exists, offer to resume from the next
incomplete chunk unless the user clearly requested a restart.

## Glossary Handling

Load an existing glossary if supplied. Supported minimum shape:

```json
[
  {"src": "ソロモン", "dst": "所罗门", "info": "男性", "status": "confirmed"}
]
```

Normalize entries to include:

- `src`: source term;
- `dst`: target term;
- `info`: category, note, or character gender/pronoun metadata;
- `status`: `confirmed`, `auto`, or `pending`;
- optional `variants`: known source/target variants.

For character entries, `info` should contain gender/pronoun metadata whenever
known. Use concise values that downstream review can parse:

```json
[
  {"src": "ソロモン", "dst": "所罗门", "info": "男性", "status": "confirmed"},
  {"src": "マリア", "dst": "Maria", "info": "female", "status": "confirmed"},
  {"src": "Alex", "dst": "亚历克斯", "info": "they/them", "status": "confirmed"}
]
```

If a character's gender/pronouns are unknown, write a useful placeholder such as
`角色；性别待确认` or `character; pronouns unknown` instead of pretending it is
known. Update it as soon as canon or user instruction confirms it.

Confirmed glossary terms are mandatory. Apply them before stylistic polishing.
Prefer longest source-term matches before shorter matches.

Add glossary candidates when they are likely proper nouns or fixed in-universe
terms:

- character names;
- places, factions, organizations, titles, ships, squads, families;
- named items, skills, spells, quests, bosses, species, systems;
- quoted or bracketed names that are not ordinary prose;
- repeated katakana names or fixed compounds.

When adding a character name candidate, include gender/pronouns in `info` if
inferable from the source, context, character bible, speaker labels, or user
instruction. Do not use only `角色`/`character` when a stronger value like
`男性`, `女性`, `male`, `female`, or `they/them` is available.

Do not add high-generic words unless the user explicitly asks:

- everyday kinship words like mother, father, grandfather;
- common nouns like world, battle, magic, power, person;
- broad verbs/adjectives/adverbs;
- particles, interjections, sentence endings;
- terms whose translation should naturally vary by context.

When the user provides extra terminology instructions during a translation
project, update the working glossary candidates and preserve the reason in
`info`. Avoid turning those instructions into visible text in the translation.

When terms conflict:

- keep `confirmed` over `auto` or `pending`;
- keep earlier user-approved decisions over later model guesses;
- log unresolved conflicts for user review;
- do not silently rewrite already completed chunks unless asked.

## Character Bible

Maintain `AI_translation/_workspace/character_bible.md` as a live file. Before
writing it, search each character name in project text and read nearby context
for pronouns, titles, relationships, or self-identification. Stop searching a
character once evidence establishes the fact. Use `unknown` only after project
context and available canon references remain insufficient.

Use this exact section shape:

```md
# Character Bible

## <source name> / <target name>
- Source/target name: <source> -> <target>
- Identity/role: <identity, role, faction>
- Gender/pronouns: <gender; pronouns> (confidence: confirmed|inferred|unknown)
- Voice/register: <voice and register>
- Relationships: <known relationships or unknown>
- Terms of address: <forms of address or unknown>
- Catchphrases: <recurring expressions or unknown>
- Evidence: <file and nearby source context supporting the facts>
```

Track:

- source name and translation;
- identity, role, faction, relationship;
- gender/pronouns, and whether they are confirmed or inferred;
- voice: formal/casual/archaic/cute/rough/etc.;
- pronoun choice;
- catchphrases and recurring expressions;
- facts discovered during translation.

Update the bible when a new character appears or when new facts affect
translation choices. Do not overwrite established voice rules without a reason;
append a dated or chunk-specific note when uncertain.

## Chunk Translation

`SPLIT_SIZE` is a checkpoint/save interval, not a cognitive scope limit. Process
the whole assigned range. Save chunk files every `SPLIT_SIZE` source lines so
progress can be resumed after interruption.

For each chunk:

1. Load the current glossary and character bible.
2. If needed, read brief boundary context from before the chunk, preferably a
   summary or only a few previous lines. This context is read-only: do not
   translate it, count it, or write it into the chunk output.
3. If available, read a brief previous translation tail for continuity; do not
   copy it into the current chunk output.
4. Translate only the assigned line range.
5. Preserve line count exactly.
6. Save the chunk to `translation/chunks/chunk_XXXX.txt`.
7. Update state, glossary candidates, and character bible before continuing.

Translation style guide:

- `game`: natural dialogue, clear speaker voice, concise UI phrasing, preserve
  gameplay terms.
- `novel`: fluent literary prose, natural narration, preserve imagery and
  emotional logic.
- `literal`: keep source structure where readable; minimize interpretation.
- `literary`: prioritize target-language naturalness while preserving facts.
- `faithful`: balance semantic precision with fluent target language.

For mixed lines, translate only human-language text and preserve markup exactly:

```text
<color=#FF0000>こんにちは</color> -> <color=#FF0000>你好</color>
```

## Parallel Work

Use sub-agents only when the user permits parallel translation or the task is
clearly too large for one pass. Use at most five concurrent agents. Give every
agent the current glossary, character bible, exact line range, optional
read-only boundary context, and the no-meta/direct-translation output rule.
Boundary context is never part of the assigned range or output.

Each agent must receive:

- source file path and exact line range;
- checkpoint interval for progress saves;
- language pair and style;
- current glossary in full;
- current character bible in full;
- optional read-only boundary context, preferably as a short summary or only a
  few previous lines;
- an explicit warning that boundary context is not part of the assigned range
  and must not appear in output;
- output format and file path;
- the rule that translated lines must contain direct translations only, with no
  meta wording.

Require each agent to return or write:

- translated lines for the assigned range only;
- line count;
- new glossary candidates, with `info` containing gender/pronouns for character
  entries whenever known or inferable;
- character-bible updates;
- uncertainties or conflicts.

Accept each agent chunk through a closed loop before that worker advances:

- mechanically scan every row for line identity, empty lines, placeholders,
  tags/control codes, likely untranslated text, generic placeholders, abnormal
  length/adjacency, and repeated candidates used for distinct source lines;
- semantically review every mechanically flagged row plus a deterministic sample
  of otherwise clean rows;
- if any reviewed row fails, return its exact absolute line and reason to the
  same child, require a repair in that same child session, and repeat the scan;
- accept the chunk before that worker may claim its next queued assignment;
- preserve earlier confirmed glossary terms;
- log term conflicts instead of silently changing prior chunks;
- update the glossary and character bible before assigning later chunks;
- merge glossary candidates by `src`;
- preserve or upgrade character gender/pronoun `info`; do not overwrite
  confirmed gender/pronouns with generic labels like `character` or `角色`;
- keep confirmed terms and earlier user decisions;
- record conflicts for review;
- distribute updated glossary/bible to later agents.

## Assembly And Validation

After all chunks have individually passed that closed loop:

1. Verify the Host has current hash-bound accepted review evidence covering every
   chunk without gaps or overlaps. Do not repeat a full-row semantic pass.
2. Concatenate chunks in numeric order.
3. Verify final translated line count equals source line count.
4. Check placeholder/tag/control-code preservation with a deterministic scan
   when feasible.
5. Spot-check glossary compliance for confirmed terms.
6. Check that character glossary entries have gender/pronoun `info` when known.
7. Write the final output with UTF-8.
8. Mark state as complete.

Final report should include:

- source file and line count;
- output file and line count;
- chunks completed;
- glossary candidate count;
- character glossary entries with confirmed gender/pronouns, plus any still
  marked unknown;
- character-bible updates;
- conflicts or review items.

## Output Discipline

For final translated files, write only translated lines. Keep reports, term
updates, and questions outside the translated file.

Before marking any chunk or final output complete, verify that every translated
line is a complete target-language replacement line. A line that only contains a
note, explanation, option list, placeholder, or partial phrase is incomplete and
must be rewritten before saving.

For chunk reports, include:

- completed line range and chunk number;
- output file path;
- new glossary candidates;
- character-bible updates;
- conflicts or uncertain translations that need user review.

When returning a small translation directly in chat, provide the final
translation first. Add notes only if the user asked for notes or if a blocking
ambiguity must be surfaced.

## Non-Translate Patterns

Preserve these exactly unless the user explicitly instructs otherwise:

- placeholders: `{player_name}`, `%s`, `$1`, `{0}`;
- tags and markup: `<color=#FF0000>`, `</size>`, `<br>`;
- escape/control codes: `\n`, `\t`, `\r`;
- pure numbers, punctuation-only lines, empty lines;
- paths and resource names: `assets/images/bg.png`;
- identifiers: `SCENE_01`, `BGM_battle`, `EVENT_FLAG_03`;
- code-like fragments and formulas.

If a code-like token appears beside prose, preserve the token and translate the
prose around it. If uncertain whether a token is code or text, preserve it and
surface the ambiguity outside the translated file.
