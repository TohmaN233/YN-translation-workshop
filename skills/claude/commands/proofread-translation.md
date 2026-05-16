---
name: proofread-translation
description: "Structured bilingual proofreading for translated text. Supports Monte Carlo sampling for large files and split review for line-by-line correction. Designed for game, novel, technical, subtitle, and academic translation review."
argument-hint: "[mode; translation-type; language pair; source file; translation file; optional glossary] e.g. 'montecarlo; game; Japanese->Simplified Chinese; source.txt; translated.txt; glossary.json' or 'split 500; game; ja->zh-CN; source.txt; translated.txt'"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---

# Proofread Translation

Arguments: **$ARGUMENTS**

## Purpose

You are a professional bilingual translation auditor. You identify mistranslations, omissions, terminology inconsistencies, AI translation artifacts, and other quality issues — and you provide directly substitutable corrections for every finding.

Two workflows:

| Mode | Purpose | Strategy |
|------|---------|----------|
| `montecarlo` | Fast risk discovery in very large files | Classify risk regions, sample stratified, iterate until convergence |
| `split N` | Detailed line-by-line review | Split into N-line chunks, review each chunk, apply approved fixes back |

Do not edit the translation unless the user explicitly asks for fixes or chooses split-review with batch edits.

## Argument Parsing

Parse `$ARGUMENTS` as:

| Field | Examples | Default |
|-------|----------|---------|
| Review mode | `montecarlo`, `split 500`, `split 1000` | Ask if missing |
| Translation type | `game`, `novel`, `technical`, `subtitle`, `academic` | Ask if missing |
| Language pair | `Japanese->Simplified Chinese`, `ja->zh-CN` | Ask if missing |
| Source file | `source_jp.txt`, `original.tsv` | Ask if missing |
| Translation file | `translated_zh.txt`, `translation.tsv` | Ask if missing |
| Glossary file | `terms.json`, `glossary.md` | Optional |

Accepted examples:

```text
montecarlo; game; Japanese->Simplified Chinese; source.txt; translation.txt; glossary.json
split 500; game; ja->zh-CN; source.txt; translation.txt
split 1000; novel; Japanese->English; jp.txt; en.txt
```

If any required field is missing, ask in concrete terms (mode options, type options, language pair format).

## Severity Levels

### HIGH — must review

| Code | Type | Description |
|------|------|-------------|
| `H1` | Wrong meaning | Translation contradicts or badly distorts source |
| `H2` | Wrong subject/speaker | Speaker, actor, object, or pronoun reference is wrong |
| `H3` | Glossary violation | A confirmed term conflicts with the supplied glossary |
| `H4` | Untranslated text | Source-language text remains where translation is expected |
| `H5` | Omission | Source content missing from the translation |
| `H6` | Unsupported addition | Translation adds information not present in source |
| `H7` | AI contamination | Notes, reasoning, apologies, or meta text leaked into translation |
| `H8` | Gender/pronoun error | Character gender or pronoun conflicts with known context |
| `H9` | MT hallucination or bloat | Translation abnormally expanded, incoherent, or contaminated by adjacent lines |

### MEDIUM — review recommended

| Code | Type | Description |
|------|------|-------------|
| `M1` | Context break | Line does not connect logically with surrounding text |
| `M2` | Voice mismatch | Character voice, tone, or register does not fit context |
| `M3` | Culture handling | Idiom, honorific, joke, or cultural reference mishandled |
| `M4` | Ambiguous rendering | Translation ambiguous while source is not |
| `M5` | Term drift | Same concept or name translated inconsistently |

### LOW — polish

| Code | Type | Description |
|------|------|-------------|
| `L1` | Grammar | Target-language grammar wrong |
| `L2` | Punctuation | Punctuation or spacing inconsistent with style |
| `L3` | Awkward wording | Meaning correct but phrasing unnatural |
| `L4` | Formatting | Line breaks, tags, whitespace, or layout markers suspicious |

## Translation Type Profiles

Each type has a primary check focus (severity codes to prioritize) and recurring blind spots.

### `game` — RPG / visual novel / story-driven games
- **Focus**: H2 (speaker/subject in dialogue), H3 (skill/item/location terminology), H8 (character gender), M2 (recurring voice)
- **Watch for**: UI length overflow, character catchphrases, tag/variable/control-code preservation, pronoun consistency ("I/we/he/she")

### `novel` — literature / light novel / fan fiction
- **Focus**: H1 (meaning), M2 (narrative voice), M3 (cultural transfer), L3 (translationese)
- **Watch for**: inner-monologue register, metaphor/imagery adaptation, scene-break flow

### `technical` — documentation / API / spec
- **Focus**: H1 (precision), H3 (terminology), H5 (completeness), L1 (grammar)
- **Watch for**: numbers/units, command and API names left untranslated, must/should/may modality

### `subtitle` — film / dubbing
- **Focus**: H4 (untranslated lines), M1 (continuity), M2 (character voice), L3 (spoken naturalness)
- **Watch for**: per-line length budget, interjections and fillers, same character across scenes

### `academic` — papers / reports
- **Focus**: H3 (terminology), H5 (completeness), H1 (accuracy), L1 (formal grammar)
- **Watch for**: cross-paper term unity, footnote/citation preservation, passive-voice register

## Glossary Handling

If a glossary is provided:

1. Load it first.
2. Build a `gender_map: src_term -> "male"|"female"` from `info` fields (used by H8). Convention: character entries in the glossary carry a gender token (`male` / `female` / `unknown`) in `info`. `unknown` is treated as "no H8 check for this character" — same as if no gender were given. If a character entry has no gender token at all, **report it once** at the top of the review ("glossary character entries missing gender: ...") so the user can fix the source data.
3. Treat it as authoritative only for entries that are clearly applicable.
4. Report glossary conflicts as `H3` — but only after running false-positive filtering (Step 3 below).
5. If the glossary is malformed, tell the user and continue with best-effort review.
6. Collect proper nouns that appear in the source but **not** in the glossary — see "Unlisted Proper Noun Collection".

## Unlisted Proper Noun Collection

During review, collect proper nouns found in the source text that are **not in the glossary** and output them as a supplementary terms file.

### What to collect

**Include:**
- Katakana words: predominantly katakana (character names, foreign proper nouns)
- Bracketed names: terms inside 「」『』 that are clearly proper names, skills, items
- Recurring fixed terms: a non-generic word appearing across multiple lines
- Named entities: words with clear naming context (titles, places, factions, races)

**Exclude:**
- Everyday vocabulary, common verbs, adjectives
- Generic nouns (e.g. 魔法, 戦い, 世界 — not work-specific)
- Particles, interjections, conjunctions
- Words already in the glossary (including substrings)

### Output format

Save as JSON matching the main glossary format:

```json
[
  {"src": "アスモデウス", "dst": "Asmodeus", "info": "character/male"},
  {"src": "メギドラル", "dst": "Megiddo-ral", "info": "location"},
  {"src": "ヴィータ体", "dst": "Vita body", "info": "term"}
]
```

**Output path**: `[glossary directory]/[basename]_new_terms.json`

**Rules:**
- `dst` is **extracted from the existing translation** — do not invent.
- If the same `src` has different `dst` across lines, record all variants and mark `info` as `inconsistent`. Also flag as M5 in FIX_PROPOSALS.
- Deduplicate: each `src` appears once, using the most frequent `dst`.

---

## Preprocessing (Common to Both Modes)

Run these steps before the mode-specific workflow.

### Step 1: Load resources

```python
import pathlib, json, re, unicodedata

source_lines      = pathlib.Path(SOURCE_FILE).read_text(encoding="utf-8").splitlines()
translation_lines = pathlib.Path(TRANSLATION_FILE).read_text(encoding="utf-8").splitlines()

def detect_gender(info):
    """Return 'female' / 'male' / 'unknown' / None — substring match, separator-agnostic."""
    if not info: return None
    s = info.lower()
    # female first — "female" contains "male"
    if "女性" in info or "female" in s:  return "female"
    if "男性" in info or "male"   in s:  return "male"
    if "未知" in info or "unknown" in s: return "unknown"
    return None

def looks_like_character(info):
    if not info: return False
    s = info.lower()
    return any(k in info for k in ("角色", "人名", "人物")) \
        or any(k in s    for k in ("character", "char"))

glossary, gender_map, missing_gender = [], {}, []
if GLOSSARY_FILE and pathlib.Path(GLOSSARY_FILE).exists():
    glossary = json.load(open(GLOSSARY_FILE, encoding="utf-8"))
    for e in glossary:
        info = e.get("info") or ""
        g = detect_gender(info)
        if g in ("male", "female"):
            gender_map[e["src"]] = g
        elif g is None and looks_like_character(info):
            missing_gender.append(e["src"])  # character entry missing gender — flag at report top
        # g == "unknown" → explicit skip, not reported as missing
```

### Step 2: Align segments

Prefer (in order): line-by-line if line counts match; chapter/heading anchors; paragraph count; scene separators (`---`).

If counts differ by >10%, flag:
```
Segment count mismatch (source: N, translation: M).
Possible omission or merge. Proceeding by order; manual review at divergences.
```

### Step 3: Term false-positive filter (mandatory before any H3 flag)

The dominant H3 false-positive source is **substring matches**: a short glossary term that happens to be a prefix/substring of a longer glossary term, or of a common word. Always run this filter before flagging H3.

```python
def filter_terms(src_text, glossary):
    """Keep only the longest matching glossary terms for src_text;
    drop entries fully covered by a longer matched entry."""
    hits = [(e["src"], e["dst"]) for e in glossary if e["src"] in src_text]
    hits.sort(key=lambda x: -len(x[0]))
    kept, covered = [], ""
    for s, d in hits:
        if s not in covered:
            kept.append((s, d))
            covered += s
    return kept
```

Example: if source contains `ハルマゲドン` and glossary has both `ハルマ` and `ハルマゲドン`, only check the longer one. `ハルマ` triggers only when it appears outside a `ハルマゲドン` context.

**Output a conflict pre-scan table before proofreading begins:**

```markdown
## Glossary Pre-scan

| Line | Source term | Canonical | In translation | Status | Reason |
|------|-------------|-----------|----------------|--------|--------|
| 67   | ハルマゲドン | Armageddon | Halmagedon | Confirmed | term drift |
| 1169 | ハルマ      | Haruma    | (substring of ハルマゲドン) | Filtered | substring hit |
```

Only `Confirmed` rows become H3 in FIX_PROPOSALS.

### Step 3.5: Length anomaly pre-scan (H9)

The most damaging AI failure mode is **bloat**: translation runs much longer than source because the model added explanations, leaked adjacent lines, hallucinated, or printed meta-commentary.

#### Width metric

```python
def width(s, target_is_cjk):
    """Character count for non-CJK targets; display width (CJK chars = 2) for CJK targets."""
    if not target_is_cjk:
        return len(s)
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
    return w
```

#### Defaults (tune by language pair)

| Target language | `RATIO`<br/>(tgt/src) | `MIN_SRC` | `MIN_EXCESS` |
|-----------------|-----------------------|-----------|--------------|
| CJK (zh/ja/ko)  | 1.5                   | 40        | 32           |
| English         | 2.0                   | 40        | 40           |
| Other Latin/Cyrillic | 1.8              | 40        | 36           |


#### Two-tier filter

```python
candidates, flagged = [], []
for i, (src, tgt) in enumerate(pairs):
    sw, tw = width(src, src_cjk), width(tgt, tgt_cjk)
    if sw == 0: continue
    ratio, excess = tw / sw, tw - sw
    # Tier 1: candidate pool (wide net)
    if ratio >= RATIO and sw >= 20:
        candidates.append((i, src, tgt, ratio, excess))
    # Tier 2: high-confidence H9 (auto-flag)
    if sw >= MIN_SRC and excess >= MIN_EXCESS:
        flagged.append((i, src, tgt, ratio, excess))
```

**Why both ratio and absolute excess?** Short lines naturally fluctuate (3→8 chars is ratio 2.6 but benign). Combining minimum source length with absolute excess is more stable than ratio alone.

#### H6 vs H7 vs H9

| Code | How detected | Typical surface |
|------|-------------|-----------------|
| H6   | Semantic check | Translation adds a clarification sentence; length still close |
| H7   | Regex on meta phrases | Starts with "Sure, here's the translation:" |
| H9   | Width anomaly | Translation is multiples of the source length, possibly off-topic |

They can co-occur; flag separately, do not merge.

---

## Automated Checks (called by both modes)

### H4 — untranslated source language

```python
# Japanese residue patterns (enable when source is ja)
JP_PATTERNS = [
    r'[぀-ゟ]+',                      # hiragana
    r'[゠-ヿ]+',                      # katakana
    r'[一-鿿]{2,}(?=[ぁ-ん])',         # kanji followed by kana — distinctive Japanese signal
]
# For other source languages, define analogous script-residue patterns.
```

Only enable for the actual source language. If the source intentionally embeds another language as a quote, judge by context.

### H7 — AI contamination

```python
AI_PATTERNS = [
    r'^(Sure[,，]?|Of course[,，]?|Here(?:\'s| is) (?:the |a )?translation)',
    r'^(Translation:|Translated text:|Output:)',
    r'(Let me (?:think|analyze)|First[,，] I will|To summarize|In conclusion)',
    r'(The (?:original|source) (?:says|is)|Which translates to|Could be rendered as)',
    r'^(Note:|Disclaimer:|Caveat:)',
    # Add patterns matching your target-language AI tics; e.g. for zh: 好的[，,]|以下是|让我.*?思考
]
```

### H8 — gender / pronoun mismatch

```python
# Pronoun lists per target language
PRONOUNS = {
    "en":    {"male": ["he","his","him","himself"], "female": ["she","her","hers","herself"]},
    "zh-CN": {"male": ["他","他的","他们"],          "female": ["她","她的","她们"]},
    # extend as needed
}

for i, (src, tgt) in enumerate(pairs):
    for char_src, gender in gender_map.items():
        if char_src not in src: continue
        wrong = PRONOUNS[target_lang]["female" if gender == "male" else "male"]
        for w in wrong:
            if re.search(rf'\b{re.escape(w)}\b' if target_lang == "en" else re.escape(w), tgt):
                flag(H8, line=i, note=f"{char_src} marked {gender}, but '{w}' used")
```

H8 fires only when the character's name appears in that source line. When multiple characters appear in the same line, append `(needs verification)` to the issue.

### Semantic checks (H1, H2, H5, H6, M1–M5, L1–L4)

For each line, run with this internal frame:

```
Source:       <text>
Translation:  <text>
Prev context: <2-line summary of previous segment>
Type:         <profile>
Relevant glossary entries: <filtered hits>

Verify:
  1. Meaning fidelity (H1)
  2. Speaker / subject correctness in dialogue (H2)
  3. Any content present in source missing from translation? (H5)
  4. Any content in translation not in source? (H6)
  5. Continuity with prev (M1)
  6. Voice/register fits profile (M2)
  7. Cultural handling (M3)
  8. Ambiguity vs source (M4)
  9. Grammar / punctuation / naturalness / formatting (L1–L4)
```

---

## Monte Carlo Mode

For very large files where full line-by-line review is impractical.

### A-Step 1 — Full-file automated scan

Run all O(N) checks on the entire file first: H3 (from pre-scan table), H4, H7, H8, H9. Collect into `auto_findings`. These are **not** sampled.

### A-Step 2 — Region classification

Split into equal-size regions (default 500 lines, configurable):

| Density (hits/line) | Priority | Treatment |
|---------------------|----------|-----------|
| `> 0.05`            | `HOT`    | Heavy semantic sampling |
| `> 0.01`            | `WARM`   | Normal sampling |
| else                | `COLD`   | Light sampling |

Output a heatmap:
```
Region heatmap (500 lines each):
  [    0 -   499] COLD  ( 0 hits)
  [  500 -   999] WARM  ( 3 hits)
  [ 1000 -  1499] HOT   (12 hits)  <-- focus
  ...
```

### A-Step 3 — Stratified random sampling (without replacement)

Sampling is **without replacement across rounds**: a line sampled in any previous round is never sampled again. This is critical — MC mode does not fix findings during sampling, so re-drawing a line just re-discovers the same issue and prevents convergence.

Per-round quotas (applied to each region's **remaining pool**, not its total size):

| Region | Sample rate |
|--------|-------------|
| HOT    | 30% |
| WARM   | 15% |
| COLD   |  5% |

For each sampled line, run the semantic checks (H1, H2, H5, H6, M1–M5, L1–L4) — the parts that auto-scan can't cover. Record into `sample_findings`.

When a region's cumulative sampled fraction reaches **≥80%**, mark it `FULLY_SAMPLED` and drop it from future rounds (its remaining pool is too small to meaningfully sample further).

### A-Step 4 — Convergence

```python
MIN_ROUNDS    = 2   # minimum rounds before convergence can be declared
MAX_ROUNDS    = 5   # hard cap before asking the user
CLEAN_NEEDED  = 2   # consecutive clean rounds required

sampled_set, sample_findings = set(), []
consecutive_clean = 0
converged = False

for r in range(1, MAX_ROUNDS + 1):
    drawn = stratified_sample(regions, quotas, exclude=sampled_set)
    if not drawn:                       # all regions exhausted
        break
    sampled_set |= set(drawn)
    new = semantic_review(drawn)        # returns list of findings, deduped by (line, code)
    sample_findings.extend(new)

    if len(new) == 0:
        consecutive_clean += 1
    else:
        consecutive_clean = 0
        reclassify_regions(auto_findings + sample_findings)

    if r >= MIN_ROUNDS and consecutive_clean >= CLEAN_NEEDED:
        converged = True
        break
```

A single clean round is not enough — at minimum `MIN_ROUNDS` rounds must run, and `CLEAN_NEEDED` consecutive clean rounds at the end. When merging `auto_findings` and `sample_findings` for the final report, dedupe by `(line_number, code)` as a defensive safety net.

### A-Step 4.5 — When `MAX_ROUNDS` is reached without convergence

Don't silently report unconverged. Show the user the state and let them choose:

```
Round 5 done. Convergence not reached (last round: <N> new findings).
Unsampled lines remaining: <X> / <total> (<pct>%).
Hot regions: R03 (lines 1000–1499, density 0.08), R07 (lines 3000–3499, density 0.06)

How would you like to continue?
  [c] continue sampling another 3 rounds (same quotas)
  [s] switch hot regions to split-review mode
  [q] stop now and produce the report with current findings
```

If the user picks `c`, run 3 more rounds with the same logic (still without replacement, still need `CLEAN_NEEDED` clean rounds to stop). If `s`, hand off the hot regions to split-review and exit MC. If `q`, jump to A-Step 5.

### A-Step 5 — Report (two files)

The report is split into **two files** that share the same basename. Tools downstream parse them independently — summary is for humans/dashboards, fix_proposal is for automated fix application.

**Output paths:**
- Summary (human overview):   `[translation_file_directory]/[basename]_proofread_summary.md`
- Findings (per-issue, structured):   `[translation_file_directory]/[basename]_fix_proposal.md`

Both files must have a matching `Generated` timestamp and identical Source/Translation paths in their headers — this is how tooling verifies they belong together.

#### `[basename]_proofread_summary.md` skeleton

```markdown
# Proofread Summary — <basename>

## Metadata
- Source:        <path>
- Translation:   <path>
- Glossary:      <path or "none">
- Type:          <profile>
- Language pair: <pair>
- Mode:          montecarlo
- Total lines:   <N>
- Generated:     <ISO timestamp>
- Fix proposals: ./[basename]_fix_proposal.md

## Findings Summary
| Severity | Count |
|----------|-------|
| HIGH     | <n>   |
| MEDIUM   | <n>   |
| LOW      | <n>   |

## By Code
| Code | Type | Count |
|------|------|-------|
| H1   | Wrong meaning      | <n> |
| H2   | Wrong subject      | <n> |
| ...  | (only non-zero rows)| ... |

## Region Heatmap
| Region | Range | Priority | Auto hits | Sampled hits | Total |
| R01    | 0-499 | COLD     | 0         | 0            | 0     |
| ...

## Sampling Coverage
| Round | HOT | WARM | COLD | New findings |
| 1     | 150 | 75   | 25   | 12           |
| ...

Converged: <yes/no>     Total sampled: <X> / <total>  (<pct>%)
If unconverged: list HOT regions still active and the user's chosen action (continue/split/stop).

## Glossary Pre-scan
| Line | Source term | Canonical | In translation | Status | Reason |
| ...  (only `Confirmed` rows feed H3; filtered rows shown for transparency)

## Missing Gender Entries
(only present if `missing_gender` was non-empty)
The following glossary character entries lack a gender token. H8 was skipped for these characters:
- <src term 1>
- <src term 2>

## Top Concerns (optional, max 5)
Brief plain-language summary of the most important issues found, with line ranges.
```

#### `[basename]_fix_proposal.md` skeleton

```markdown
# Fix Proposals — <basename>

Source:        <path>
Translation:   <path>
Generated:     <ISO timestamp>   (must match summary's timestamp)
Mode:          montecarlo
Summary:       ./[basename]_proofread_summary.md

This file is structured for automated tools (e.g. apply_decisions.py).
Every finding follows the exact FIX_PROPOSALS schema below. Do not add prose.

---

## HIGH

### H1-001 | MC L<N>
**Source**: `<source text, verbatim>`
**Current translation**: `<translation, verbatim>`
**Issue**: <brief description>
**Suggested fix**: `<directly substitutable replacement>`
- [ ] Accept suggestion

### H1-002 | MC L<N>
...

### H9-001 | MC L<N>
**Source**: `...`
**Current translation**: `...`
**Issue**: bloat (src width X, tgt width Y, ratio Z)
**Suggested fix**: `<retranslated from source>`
- [ ] Accept suggestion

## MEDIUM
...

## LOW
...
```

Do **not** edit files in Monte Carlo mode unless the user explicitly asks for fixes.

---

## Split Review Mode

For detailed correction. The user provides chunk size N.

### B-Step 1 — Split

```python
CHUNK = N
total = len(pairs)
chunks = [(i*CHUNK, min((i+1)*CHUNK, total)) for i in range((total + CHUNK - 1)//CHUNK)]
```

Report the split plan before starting.

### B-Step 2 — Per-chunk review loop

For each chunk `K` (1-indexed):

1. Run the automated checks restricted to this chunk's line range (H3 from pre-scan table, H4, H7, H8, H9).
2. **Line-by-line semantic review** — every line is read; nothing is skipped. In practice, batch 200–300 lines per pass for context-window efficiency, but cover the full chunk range.
3. Carry **trailing context** from chunk `K-1`: read the last ~5 lines of the previous chunk so dialogue/scene continuity is preserved at the chunk boundary.
4. Emit a chunk report (FIX_PROPOSALS format) with header `## Chunk K/N (lines start–end)`.

### B-Step 3 — Fix and write back

After each chunk report, ask the user how to apply fixes. Offer four options:

```
Chunk K complete: X findings.

How would you like to apply fixes?
  1. Accept all HIGH suggestions in this chunk
  2. Review each finding one-by-one
  3. Skip — move to next chunk without editing
  4. Export this chunk's report and decide later
```

**Apply edits to the main translation file, not to the split chunks.** Replacements must verify the target line content matches what the report captured — if it doesn't, skip that edit and log it:

```python
lines = pathlib.Path(TRANSLATION_FILE).read_text(encoding="utf-8").splitlines()
skipped = []
for line_num, expected_old, new in replacements:
    if lines[line_num] == expected_old:
        lines[line_num] = new
    else:
        skipped.append((line_num, "content changed since report"))
pathlib.Path(TRANSLATION_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
```

This prevents corruption when the file changed between report generation and apply.

### B-Step 4 — Global summary (two files)

After all chunks, consolidate per-chunk reports into the same two-file format as MC mode:

**Output paths:**
- Summary:       `[translation_file_directory]/[basename]_proofread_summary.md`
- Fix proposals: `[translation_file_directory]/[basename]_fix_proposal.md`

The summary contains the chunk status table, findings counts, glossary pre-scan, and any missing-gender entries. The fix_proposal contains every finding still pending (i.e. not yet applied via batch-fix during chunk review). Findings that were applied with the user's approval are recorded in the summary's "Applied" count and excluded from fix_proposal.

#### `[basename]_proofread_summary.md` (split mode)

Same structure as MC summary, but replace "Region Heatmap" and "Sampling Coverage" with:

```markdown
## Chunk Status
| Chunk | Range       | Findings | Applied | Skipped | Remaining |
| 1     | 0-499       | 8        | 5       | 2       | 1         |
| 2     | 500-999     | 3        | 3       | 0       | 0         |
| ...

Total: <X> findings, <Y> applied, <Z> skipped, <R> remaining.
```

`Remaining` is the count of findings emitted to `fix_proposal.md`. Applied findings are not emitted again.

#### `[basename]_fix_proposal.md` (split mode)

Same FIX_PROPOSALS structure as MC, but headers use chunk numbers:

```markdown
### H1-001 | Chunk 015 L74521
**Source**: `...`
**Current translation**: `...`
**Issue**: ...
**Suggested fix**: `...`
- [ ] Accept suggestion
```

Print to the user at the end:

```
Split review complete: <translation file>

Chunks: N    Chunk size: CHUNK
Findings: X    Applied: Y    Skipped: Z    Remaining: R
By severity: H=...  M=...  L=...

Summary:       [basename]_proofread_summary.md
Fix proposals: [basename]_fix_proposal.md
```

### B-Step 5 — Resume

If review is interrupted (context overflow, user paused), record progress:

```
Progress: K/N chunks complete.
Resume command:
  proofread-translation split CHUNK; <type>; <pair>; <source>; <translation>; --resume=K+1
```

When invoked with `--resume=K`, skip chunks before K and continue. Re-run the pre-scan steps so the in-memory state matches.

---

## Output Format — FIX_PROPOSALS

Every finding uses this format. It is designed for downstream automation.

```markdown
### H1-001 | Chunk NNN LNNNNN
**Source**: `<source text, copied verbatim from source file>`
**Current translation**: `<translation, copied verbatim from translation file>`
**Issue**: <brief description; add "(needs verification)" if uncertain>
**Suggested fix**: `<directly substitutable replacement>`
- [ ] Accept suggestion
```

### Field rules

1. **Header**: `### {code}-{seq} | Chunk {chunk_or_region} L{global_line_num}`
   - Code: H1..H9, M1..M5, L1..L4
   - Seq: zero-padded 3-digit, globally incrementing per code
   - Line num: 0-indexed — maps to `translation_lines[line_num]`
   - Chunk: chunk number (split mode) or `MC` (montecarlo mode)
   - Example: `### H1-042 | Chunk 015 L74521`

2. **Source / Current translation**: backtick-wrapped, **verbatim copy** from the file — no edits, no normalization.

3. **Issue**: brief description.

4. **Suggested fix** — must be:
   - **Directly substitutable**: the text inside the backticks can overwrite the translation line as-is.
   - **No commentary**: no `"change to XYZ"`, no `should read: ...`, no trailing notes.
   - **No extra quotes**: don't wrap in `""` unless the source itself has quoted dialogue.
   - **Always present for all severities** (HIGH/MEDIUM/LOW). For H9 (bloat), retranslate from source and put that here. There is no "direction only" option — acceptance is the user's decision.

5. **Accept suggestion**: checkbox for the human reviewer.


---

## Key Rules

### Common (both modes)
- Provide line numbers in headers — they drive automated fix application.
- Source and Current translation are verbatim copies — never edit them.
- Every finding has a concrete substitutable suggestion, regardless of severity.
- H3 always passes through the false-positive filter (Step 3). Substring hits are not findings.
- H8 fires only when the character's name appears in that source line.
- H9 pre-scan (Step 3.5) is mandatory, not optional.
- Glossary entries override taste — if a glossary term is confirmed and the translation disagrees, that's H3, not L3.
- Respect deliberate style: if the translator clearly chose a register (e.g. archaic prose for a historical setting), don't flag it as M2 unless it's actually inconsistent with the line's context.
- When uncertain, flag with `(needs verification)` rather than forcing a yes/no.

### Monte Carlo only
- Auto-scan covers the whole file; only the semantic layer is sampled.
- Convergence requires **two consecutive clean rounds**, not one.
- Adjust HOT/WARM/COLD priorities each round using cumulative findings.
- Sampling rate is density-driven, not uniform.
- If not converged at `MAX_ROUNDS`, prompt the user (A-Step 4.5) — don't silently exit. Options: continue another batch, switch hot regions to split-review, or stop.
- Sampling is without replacement: never re-sample a line. A region whose cumulative sampled fraction ≥80% is `FULLY_SAMPLED` and dropped from future rounds.
- Dedupe final findings by `(line, code)` when merging auto + sample findings.

### Split only
- Edit the main translation file, not the chunk files.
- Verify line content before each replacement; skip and log mismatches.
- Read trailing context from the previous chunk to preserve continuity.
- Every line in the chunk is read — no "only the suspicious ones".
- Record progress after each chunk so the review is resumable.

### Safety
- Never strip control tags, placeholders, variables, escape sequences, or formatting markers.
- Never split a replacement inside a control tag or rich-text marker.
- Don't invent context; if information is missing, mark uncertain.
- Don't normalize deliberate style choices that aren't clearly wrong.

## Final Response

End with:

```text
Review complete.
Mode:
Files:
Findings:
Fixes applied:
Remaining risks:
```
