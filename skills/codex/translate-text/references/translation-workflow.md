# Translation Workflow Reference

## Table Of Contents

1. Inputs and project state
2. Initialization
3. Glossary handling
4. Character bible
5. Chunk translation
6. Multi-agent translation
7. Assembly and validation
8. Non-translate patterns

## Inputs And Project State

Parse the user request for:

- language pair: `Japanese->Chinese`, `ja->zh`, `English->Chinese`, etc.;
- style: `game`, `novel`, `literal`, `literary`, or `faithful`;
- source file;
- split size, default `2000` lines;
- optional glossary file;
- optional work description or setting notes;
- output file or output directory.

Use UTF-8 for all reads and writes. If running PowerShell commands, set UTF-8 output first:

```powershell
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();
```

Create or reuse:

```text
translation/
  TRANSLATION_STATE.json
  settings/GLOSSARY.json
  settings/CHARACTER_BIBLE.md
  chunks/chunk_0000.txt
  output/
```

`TRANSLATION_STATE.json` should record source path, output path, language pair, style, split size, total lines, total chunks, completed chunks, last completed chunk, status, glossary count, character count, and timestamp. If an in-progress state exists, offer to resume from the next incomplete chunk unless the user clearly requested a restart.

## Initialization

Read the source with UTF-8 and `splitlines()` so line count is explicit. Report source file, total lines, split size, and total chunks.

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

For character entries, `info` should contain gender/pronoun metadata whenever known.  Use concise values that downstream review can parse:

```json
[
  {"src": "ソロモン", "dst": "所罗门", "info": "男性", "status": "confirmed"},
  {"src": "マリア", "dst": "Maria", "info": "female", "status": "confirmed"},
  {"src": "Alex", "dst": "亚历克斯", "info": "they/them", "status": "confirmed"}
]
```

If a character's gender/pronouns are unknown, write a useful placeholder such as `角色；性别待确认` or `character; pronouns unknown` instead of pretending it is known. Update it as soon as canon or user instruction confirms it.

## Glossary Handling

Confirmed glossary terms are mandatory. Apply them before stylistic polishing. Prefer longest source-term matches before shorter matches.

Add glossary candidates when they are likely proper nouns or fixed in-universe terms:

- character names;
- places, factions, organizations, titles, ships, squads, families;
- named items, skills, spells, quests, bosses, species, systems;
- quoted or bracketed names that are not ordinary prose;
- repeated katakana names or fixed compounds.

When adding a character name candidate, include gender/pronouns in `info` if inferable from the source, context, character bible, speaker labels, or user instruction. Do not use only `角色`/`character` when a stronger value like `男性`, `女性`, `male`, `female`, or `they/them` is available.

Do not add high-generic words unless the user explicitly asks:

- everyday kinship words like mother, father, grandfather;
- common nouns like world, battle, magic, power, person;
- broad verbs/adjectives/adverbs;
- particles, interjections, sentence endings;
- terms whose translation should naturally vary by context.

When the user provides extra terminology instructions during a translation project, update the working glossary candidates and preserve the reason in `info`. Avoid turning those instructions into visible text in the translation.

When terms conflict:

- keep `confirmed` over `auto` or `pending`;
- keep earlier user-approved decisions over later model guesses;
- log unresolved conflicts for user review;
- do not silently rewrite already completed chunks unless asked.

## Character Bible

Maintain `translation/settings/CHARACTER_BIBLE.md` as a live file. Track:

- source name and translation;
- identity, role, faction, relationship;
- gender/pronouns, and whether they are confirmed or inferred;
- voice: formal/casual/archaic/cute/rough/etc.;
- pronoun choice;
- catchphrases and recurring expressions;
- facts discovered during translation.

Update the bible when a new character appears or when new facts affect translation choices. Do not overwrite established voice rules without a reason; append a dated or chunk-specific note when uncertain.

## Chunk Translation

For each chunk:

1. Load the current glossary and character bible.
2. Load up to 10 previous source lines as context; do not translate those context lines again.
3. If available, load the last 10 translated lines from the previous chunk for continuity.
4. Translate only the assigned line range.
5. Preserve line count exactly.
6. Save the chunk to `translation/chunks/chunk_XXXX.txt`.
7. Update state, glossary candidates, and character bible before continuing.

Translation style guide:

- `game`: natural dialogue, clear speaker voice, concise UI phrasing, preserve gameplay terms.
- `novel`: fluent literary prose, natural narration, preserve imagery and emotional logic.
- `literal`: keep source structure where readable; minimize interpretation.
- `literary`: prioritize target-language naturalness while preserving facts.
- `faithful`: balance semantic precision with fluent target language.

For mixed lines, translate only human-language text and preserve markup exactly:

```text
<color=#FF0000>こんにちは</color> -> <color=#FF0000>你好</color>
```

## Multi-Agent Translation

Use no more than five concurrent agents. Assign disjoint line ranges and make each agent responsible for its own chunk files or returned chunk text.

Each agent must receive:

- source file path and exact line range;
- language pair and style;
- current glossary in full;
- current character bible in full;
- up to 10 previous context lines, marked as context only;
- output format and file path;
- the rule that translated lines must contain direct translations only, with no meta wording.

Require each agent to return or write:

- translated lines for the assigned range only;
- line count;
- new glossary candidates, with `info` containing gender/pronouns for character entries whenever known or inferable;
- character-bible updates;
- uncertainties or conflicts.

On merge:

- validate line count before accepting output;
- merge glossary candidates by `src`;
- preserve or upgrade character gender/pronoun `info`; do not overwrite confirmed gender/pronouns with generic labels like `character` or `角色`;
- keep confirmed terms and earlier user decisions;
- record conflicts for review;
- distribute updated glossary/bible to later agents.

## Assembly And Validation

After all chunks are complete:

1. Concatenate chunks in numeric order.
2. Verify final translated line count equals source line count.
3. Check placeholder/tag/control-code preservation with a deterministic scan when feasible.
4. Spot-check glossary compliance for confirmed terms.
5. Check that character glossary entries have gender/pronoun `info` when known.
6. Write the final output with UTF-8.
7. Mark state as complete.

Final report should include:

- source file and line count;
- output file and line count;
- chunks completed;
- glossary candidate count;
- character glossary entries with confirmed gender/pronouns, plus any still marked unknown;
- character-bible updates;
- conflicts or review items.

## Non-Translate Patterns

Preserve these exactly unless the user explicitly instructs otherwise:

- placeholders: `{player_name}`, `%s`, `$1`, `{0}`;
- tags and markup: `<color=#FF0000>`, `</size>`, `<br>`;
- escape/control codes: `\n`, `\t`, `\r`;
- pure numbers, punctuation-only lines, empty lines;
- paths and resource names: `assets/images/bg.png`;
- identifiers: `SCENE_01`, `BGM_battle`, `EVENT_FLAG_03`;
- code-like fragments and formulas.

If a code-like token appears beside prose, preserve the token and translate the prose around it. If uncertain whether a token is code or text, preserve it and surface the ambiguity outside the translated file.
