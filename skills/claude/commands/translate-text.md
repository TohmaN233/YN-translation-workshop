---
name: translate-text
description: "Batch translate a source text file line-by-line with live glossary and character bible maintenance. Splits into chunks, translates while preserving non-target-language content (code, tags, variables), and maintains a glossary + character bible throughout. Supports multi-agent parallel translation. Use when user says \"translate\", \"batch translate\", \"翻译\", or wants to translate a text file."
argument-hint: "[language-pair; style; source-file; split-size; optional glossary; optional work-description] — e.g. 'Japanese->Chinese; game; source.txt; 2000; glossary.json; RPG game script'"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, Agent
---

# Translate Text: Batch Line-by-Line Translation

Translate: **$ARGUMENTS**

## Overview

You are a professional bilingual translator fluent in both the source and target languages, specializing in large-scale translation of game scripts, novels, and other structured text. Throughout the translation process you maintain a **live glossary** and **character bible** to ensure consistent terminology and character voice across the entire work.

Core workflow:
```
Work description → Initial glossary + Character bible → Translate full assigned range → Save every N lines → Update glossary/bible after each checkpoint → Output
```

**Key principles**:
- Glossary and character bible are living documents, updated continuously during translation
- Content not in the target language (code, tags, variables, control characters) is preserved verbatim
- In multi-agent mode, glossary and character bible are merged after each agent returns
- Boundary context is read-only and never part of the assigned range or output

## Argument Parsing

Parse `$ARGUMENTS` for:

| Field | Examples | Default |
|-------|----------|---------|
| Language pair | `Japanese->Chinese`, `ja->zh`, `en->zh` | Ask if missing |
| Translation style | `game`, `novel`, `literal`, `literary`, `faithful` | Ask if missing |
| Source file | `source.txt`, `japanese_text.txt` | Ask if missing |
| Split/checkpoint interval | `2000`, `5000` | `2000` |
| Glossary file | `terms.json`, `glossary.md` | Optional |
| Work description | Free text describing the work | Ask if missing |

If language pair is missing, ask:
```
What is the language pair?
  Examples: Japanese->Chinese, English->Chinese, ja->zh
```

If style is missing, ask:
```
What translation style?
  1. game     — RPG/visual novel/story game (natural dialogue, character voices)
  2. novel    — literary translation (fluency first, idiomatic)
  3. literal  — preserve source structure as much as possible
  4. literary — prioritize target-language naturalness
  5. faithful — balance precise meaning with natural phrasing
```

If work description is missing, ask:
```
Please briefly describe this work (genre, world setting, main characters, special terminology).
This is used to generate the initial glossary and character bible for translation consistency.

You can paste text or provide a file path.
```

## Phase 0: Project Initialization

### 0.1 Create Project Directory

```bash
mkdir -p translation/settings
mkdir -p translation/output
mkdir -p translation/chunks
```

### 0.2 Generate State File

Create `translation/TRANSLATION_STATE.json`:

```json
{
  "source_file": "[path]",
  "output_file": "[path]",
  "language_pair": "Japanese->Chinese",
  "style": "game",
  "split_size": 2000,
  "total_lines": 0,
  "total_chunks": 0,
  "chunks_completed": 0,
  "last_chunk": null,
  "status": "initializing",
  "glossary_entries": 0,
  "character_count": 0,
  "timestamp": "[ISO timestamp]"
}
```

On invocation, check this file:
- If absent → fresh start
- If present and `status: "in_progress"` → resume from `last_chunk + 1`
- Ask: "Found an in-progress translation project ([N]/[M] chunks completed). Resume or start fresh?"

## Phase 1: Pre-Translation Setup

### 1.1 Load and Analyze Source

```python
source_lines = Path(SOURCE_FILE).read_text(encoding="utf-8").splitlines()
total_lines = len(source_lines)
total_chunks = (total_lines + SPLIT_SIZE - 1) // SPLIT_SIZE
```

Report:
```
Source file: [SOURCE_FILE]
Total lines: [N]
Checkpoint interval: [SPLIT_SIZE] lines
Total checkpoint chunks: [M]
```

### 1.2 Load Existing Glossary (if provided)

If a glossary file is provided, load it as the initial confirmed terms:
```python
# Expected format: [{"src": "...", "dst": "...", "info": "..."}]
glossary = json.load(open(GLOSSARY_FILE, encoding="utf-8"))
```

Copy to `translation/settings/GLOSSARY.json` as the working glossary.

### 1.3 Generate Character Bible from Work Description

From the user's work description, create `translation/settings/CHARACTER_BIBLE.md`:

```markdown
# Character Bible

> Source: user-provided work description
> Created: [timestamp]
> Last updated: [timestamp] (translated through chunk [N])

---

## Major Characters

### [Character Name]
- **Source name**: [source language name]
- **Translated name**: [target language name — must match glossary]
- **Gender**: [male/female/unknown]
- **Role/occupation**: [description]
- **Personality traits**: [key traits]
- **Speech style**: [formal/casual/archaic/theatrical etc.]
- **Verbal tics/catchphrases**: [character-specific expressions]
- **Self-reference pronoun**: [how they refer to themselves — must be consistent]
- **Relationships**: [relationships with other characters]

---

## Supporting Characters

| Source name | Translated name | Role | Speech style | Notes |
|-------------|----------------|------|--------------|-------|
| ... | ... | ... | ... | ... |

---

## World Notes

[Setting, factions, magic systems, technology concepts, and other background that affects translation choices]
```

### 1.4 Pre-Scan for Initial Glossary Terms

Scan the first 5000 lines (or full text for smaller files) of the source for high-frequency proper nouns:

**Collection criteria** (same as proofread-translation proper noun collection rules):

**Include**:
- Katakana words (character names, foreign proper nouns)
- Bracketed names (terms inside 「」『』 that are clearly proper names)
- Recurring fixed terms (non-generic words appearing across multiple lines)
- Obvious named entities

**Exclude**:
- Everyday vocabulary, generic nouns
- High-frequency common words (not work-specific)
- Particles, interjections, conjunctions

Append discovered terms to `translation/settings/GLOSSARY.json` with `"status": "pending"`.

### 1.5 User Review Gate

```
Initialization complete.

Character bible: translation/settings/CHARACTER_BIBLE.md
  - Major characters: [N]
  - Supporting characters: [N]

Glossary: translation/settings/GLOSSARY.json
  - Confirmed entries: [N] (loaded from provided glossary)
  - Pending entries: [N] (discovered by pre-scan)

Please review the glossary and character bible. Options:
  1. Start translating (pending terms will be auto-inferred during translation, marked with ※)
  2. Edit glossary/bible first, then continue
```

Wait for user confirmation before proceeding to Phase 2.

## Phase 2: Chunk Translation

`SPLIT_SIZE` is a checkpoint/save interval, not the translation scope. Translate the whole assigned line range. Save checkpoint chunks every `SPLIT_SIZE` lines so work can resume if interrupted.

### 2.1 Split and Assign

```python
chunks = []
for i in range(total_chunks):
    start = i * SPLIT_SIZE
    end = min((i + 1) * SPLIT_SIZE, total_lines)
    chunks.append((start, end))
```

### 2.2 Per-Chunk Translation Workflow

For each chunk `[start, end)`:

#### a. Load Context

1. **Boundary context**: if needed, read a short summary or a few lines before `start` as read-only reference. Do not translate, count, or write this context into the chunk output.
2. **Glossary**: load current `translation/settings/GLOSSARY.json`
3. **Character bible**: load current `translation/settings/CHARACTER_BIBLE.md`
4. **Previous chunk tail**: if needed, read a brief translated tail from the previous chunk for voice/narrative continuity. Do not copy it into the current chunk output.

#### b. Translate Line by Line

For each line in the chunk:

**Translation rules**:

1. **Glossary is law**: confirmed terms must use the glossary translation verbatim — no variation allowed
2. **Character voice consistency**: translate dialogue according to the character bible's speech style settings
3. **Pronoun consistency**: self-reference pronouns specified in the character bible must be uniform throughout
4. **Do-not-translate content** is preserved verbatim:
   - Code, tags, variables (e.g. `{player_name}`, `<color=#FF0000>`, `\n`)
   - Control characters, placeholders
   - Empty lines remain empty
   - Pure punctuation/number lines stay as-is
5. **Line-for-line alignment**: source line N maps to translation line N. Line count must be identical. Before finalizing, self-check that every output line maps to the same assigned source line number.
6. **Style**: apply the user-specified translation style (game/novel/literal/literary/faithful)

**Dialogue translation notes** (game/novel style):
- Each character's dialogue must be recognizably distinct, matching their character bible voice
- Different characters should not sound the same
- Interjections and exclamations should be adapted to the target language, not transliterated

#### c. Discover and Record New Terms

During translation, when new proper nouns are found:

1. If not in the glossary → infer a translation, add to `new_terms` list
2. If the same word gets different translations within this chunk → unify to the first occurrence
3. After the chunk is complete, merge `new_terms` into `GLOSSARY.json` (marked `"status": "auto"`)

#### d. Update Character Bible

During translation, when new information is discovered:

1. **New characters appear**: add to the character bible (minimum: name, translated name, gender, basic role)
2. **New info about existing characters**: update the relevant entry (new relationships, traits, speech pattern changes)
3. **Voice adjustments**: if a character's actual speech style differs from the bible description, update the bible

#### e. Save Chunk Output

```python
Path(f"translation/chunks/chunk_{i:04d}.txt").write_text(
    "\n".join(translated_lines) + "\n", encoding="utf-8"
)
```

#### f. Progress Report

After each chunk:
```
Chunk [K]/[N] complete (lines [start]-[end])

New terms: [M]
Bible updates: [description]
Glossary total: [N] entries

Progress: [K]/[N] chunks ([X]%)
```

Update `TRANSLATION_STATE.json`.

### 2.3 Multi-Agent Parallel Translation

When using multiple agents, divide the full source line range into roughly equal, non-overlapping agent ranges by agent count. Inside each agent range, `SPLIT_SIZE` is still the checkpoint/save interval.

#### Agent Assignment

```python
# Example: 4 agents, full source range divided into 4 agent ranges
agent_assignments = {
    "agent_1": (0, total_lines // 4),
    "agent_2": (total_lines // 4, total_lines // 2),
    "agent_3": (total_lines // 2, total_lines * 3 // 4),
    "agent_4": (total_lines * 3 // 4, total_lines),
}
```

#### Context Provision for Each Agent

Each agent receives on startup:

1. **Full glossary**: complete current `GLOSSARY.json`
2. **Full character bible**: complete current `CHARACTER_BIBLE.md`
3. **Read-only boundary context**: a short summary or a few source lines before the assigned range, only if needed for continuity
4. **Translation rules**: language pair, style, do-not-translate rules, and strict assigned-range-only output

Agent prompt template:
```
You are a translation agent responsible for translating the following segment:
- Source file: [SOURCE_FILE]
- Line range: [start]-[end] ([N] lines)
- Checkpoint interval: [SPLIT_SIZE] lines
- Language pair: [LANGUAGE_PAIR]
- Style: [STYLE]

Read-only boundary context (NOT part of the line range; do NOT translate, count, or output):
[brief summary or a few previous lines, only if needed]

Glossary (must follow — confirmed terms are non-negotiable):
[GLOSSARY content]

Character bible (reference for voice/tone):
[CHARACTER_BIBLE content]

Translation rules:
1. Translate line-by-line; output line count must exactly match the assigned source range
2. Glossary terms cannot be varied
3. Code/tags/variables/control characters preserved verbatim
4. Record any new proper nouns discovered in new_terms
5. Record any new character information in bible_updates

Output format:
1. Translation result for the assigned range only (one output line per assigned source line)
2. new_terms: [{"src": "...", "dst": "...", "info": "..."}]
3. bible_updates: [description of newly discovered character information]
```

#### Merge on Return

After each agent returns, the main process merges:

```python
def merge_agent_results(agent_result, main_glossary, main_bible):
    # 1. Merge glossary
    for term in agent_result["new_terms"]:
        if term["src"] not in existing_src_set:
            main_glossary.append(term)
        else:
            # Conflict: same src, different dst
            existing = find_by_src(main_glossary, term["src"])
            if existing["dst"] != term["dst"]:
                log_conflict(term)
                # Keep the earlier agent's version, flag for user review

    # 2. Merge character bible updates
    for update in agent_result["bible_updates"]:
        apply_bible_update(main_bible, update)

    # 3. Report conflicts
    if conflicts:
        print(f"Term conflicts: {len(conflicts)}")
```

**Conflict resolution**:
- Glossary conflicts: keep the earlier agent's version (lower chunk number wins), flag for user review
- Character bible conflicts: merge all new information additively, never overwrite existing entries
- After merging, distribute updated glossary and bible to subsequent agents

## Phase 3: Assembly and Output

### 3.1 Merge All Chunks

```python
output_lines = []
for i in range(total_chunks):
    chunk_file = Path(f"translation/chunks/chunk_{i:04d}.txt")
    chunk_lines = chunk_file.read_text(encoding="utf-8").splitlines()
    output_lines.extend(chunk_lines)

# Verify line count
assert len(output_lines) == total_lines, \
    f"Line count mismatch: source {total_lines}, translation {len(output_lines)}"

Path(OUTPUT_FILE).write_text(
    "\n".join(output_lines) + "\n", encoding="utf-8"
)
```

### 3.2 Final Report

```
Translation complete!

Source: [SOURCE_FILE] ([N] lines)
Output: [OUTPUT_FILE] ([N] lines)
Language pair: [LANGUAGE_PAIR]
Style: [STYLE]

Chunks: [M] chunks of [SPLIT_SIZE] lines each

Glossary: translation/settings/GLOSSARY.json
  - Confirmed: [N] entries
  - Auto-inferred: [N] entries (review recommended)

Character bible: translation/settings/CHARACTER_BIBLE.md
  - Major characters: [N]
  - Supporting characters: [N]
  - Added during translation: [N]

Recommended next steps:
  1. Review auto-inferred terms (status="auto" in GLOSSARY.json)
  2. Run /proofread-translation to audit translation quality
  3. Merge confirmed terms into your main glossary
```

## Do-Not-Translate Rules

The following content must be preserved verbatim — never translate:

| Type | Examples | Notes |
|------|----------|-------|
| Variables/placeholders | `{player_name}`, `%s`, `$1` | Program variables |
| Rich text tags | `<color=#FF0000>`, `<b>`, `</size>` | UI markup |
| Control characters | `\n`, `\t`, `\r` | Newline/tab |
| Empty lines | (empty) | Keep empty |
| Pure punctuation/numbers | `...`, `123`, `---` | No translation needed |
| HTML/XML tags | `<br>`, `<div class="x">` | Markup language |
| Code snippets | `if (flag) { }` | Program code |
| File paths | `assets/images/bg.png` | Resource paths |
| Identifiers | `SCENE_01`, `BGM_battle` | Program identifiers |

**Mixed-content lines**: if a line contains both translatable text and non-translatable content (e.g. `<color=#FF0000>こんにちは</color>`), translate only the text portion and preserve tags verbatim (→ `<color=#FF0000>你好</color>`).

## Glossary Format

The glossary uses JSON format, fully compatible with the proofread-translation glossary:

```json
[
  {
    "src": "ハルマゲドン",
    "dst": "哈米吉多顿",
    "info": "term/event name",
    "status": "confirmed"
  },
  {
    "src": "ソロモン",
    "dst": "所罗门",
    "info": "character/male/protagonist",
    "status": "confirmed"
  },
  {
    "src": "メギドラル",
    "dst": "Megiddo-ral",
    "info": "location",
    "status": "auto"
  }
]
```

**Status field**:
- `confirmed`: user-verified translation — must be used during translation, no deviation allowed
- `auto`: auto-inferred during translation — needs user review
- `pending`: discovered by pre-scan but not yet translated

**Info field — mandatory rules for character entries**:

Any entry that refers to a character **must** include a gender token: `male`, `female`, or `unknown`. The proofread-translation skill relies on this for its H8 pronoun-mismatch check; missing gender info silently disables that check for that character.

Format: include the gender as one of the slash-separated tokens in `info`. Examples:
- `"character/male/protagonist"` ✓
- `"character/female"` ✓
- `"character/unknown"` ✓ (use when the source genuinely doesn't disclose gender)
- `"character/protagonist"` ✗ (gender missing — H8 cannot fire)

`unknown` is the explicit "we checked and it's not determinable" value — don't omit the token to mean unknown. Omitting is treated as a glossary-entry bug.

Non-character entries (locations, items, skills, organizations, terms, events) do not require gender.

## Resume Support

Translation can be resumed after interruption:

```
Found an in-progress translation project:
  Source: [SOURCE_FILE]
  Completed: [K]/[M] chunks
  Last completed chunk: [K] (lines [start]-[end])

Resume translation? (starting from chunk [K+1])
```

On resume:
1. Reload the latest glossary and character bible
2. Continue from `last_chunk + 1`
3. Use only brief read-only boundary context from the previous chunk if continuity needs it

## Key Rules

- **Line count must match exactly**: source file has N lines, translation must have N lines — no more, no less. Self-check line count and line-number mapping before final output.
- **Glossary is non-negotiable**: confirmed terms are used verbatim every time — no synonyms, no variation, no creative alternatives
- **Character voice consistency**: same character must use the same speech style and self-reference pronoun throughout, per the character bible
- **Do not touch what shouldn't be touched**: code/tags/variables/control characters are preserved byte-for-byte
- **Boundary context is read-only**: if provided, it is only for continuity and must never be translated, counted, or written into output
- **Glossary updates are immediate**: after each chunk, the glossary is updated before the next chunk begins
- **Conflicts are resolved on merge**: multi-agent term conflicts must be resolved during the merge phase, never deferred
- **Large file handling**: if Write fails, retry with Bash heredoc. Do not ask for permission.
