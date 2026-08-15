# Proofreading Workflow

## Reviewer Priorities

Prioritize accurate source comprehension, target-language fluency, terminology
discipline, line-number accuracy, and directly applicable replacement text.

## Inputs

Required:

- review mode: `split N` or `montecarlo`;
- text type: `game`, `novel`, `technical`, `subtitle`, or `academic`;
- source file path;
- translation file path;
- language pair, such as `ja->zh-CN`.

Optional:

- glossary path;
- character bible path;
- style guide path;
- work description.

Ask only for missing required paths or an unclear target language.

If review mode is missing, ask for `montecarlo` or `split N`. If text type is
missing, ask for one of `game`, `novel`, `technical`, `subtitle`, or
`academic`. Infer source/target language from user wording, filenames, content,
or glossary when reliable; ask only when the target language for fixes remains
ambiguous.

## Output Language

Use the target language for human-facing summary prose, issue explanations,
rationales, and `suggestedFix` / `Suggested fix`. Keep parser-required field
names in English: `Source`, `Current translation`, `Issue`, `Suggested fix`,
`Accept suggestion`, and JSON keys.

Raw source text and current translation text must be quoted exactly from the
input files.

## Guardrails

- Decide target-language conventions before judging grammar, punctuation,
  capitalization, spacing, quotes, pronouns, register, and style. Do not apply
  Chinese-specific rules to English or other targets.
- Use global 1-based line numbers only. `L<N>` maps to `source_lines[N-1]` and
  `translation_lines[N-1]`. Do not write chunk-local, batch-local, sampled, raw,
  displayed, or approximate line numbers in final findings.
- Before writing each finding, re-read that exact source/translation line pair.
  If the exact line cannot be verified, put the note in the summary, not in
  structured findings JSON.
- Quote full exact `sourceText` and `currentTranslation` rows. Do not shorten,
  paraphrase, or quote only the suspicious fragment.
- For every HIGH, MEDIUM, and LOW finding, write a complete target-language
  `suggestedFix` that can replace the current translation line as-is.
- `suggestedFix` contains only the final replacement text. Do not include
  labels, quotes, markdown, explanations, "suggested translation", "change X to
  Y", alternatives, or partial edits.
- `suggestedFix` must differ from the exact current translation. Do not emit a
  finding whose replacement is identical to the existing line.
- Preserve the exact leading bracket control prefix from the bound source or
  current translation in every replacement. Do not change, remove, or invent a
  prefix. When neither aligned row has a prefix, do not diagnose one as missing.
- `readAssignedProofreadContext` already supplies all owned source/translation
  rows and exact boundary context. Do not list directories, reread those bound
  files, browse raw assets, or locate preceding files to reconstruct context the
  Host already provided.
- H3 requires longest-match terminology filtering first. Do not report a short
  glossary term that only appears as a substring of a longer matched term.
- H8 only triggers when the line contains the relevant character or reliable
  referent evidence. For multi-character lines or singular `they` ambiguity,
  mark uncertainty in the rationale or skip the automatic finding.
- H9 length/expansion prescan is mandatory. For H9, retranslate the full source
  line and put the corrected full line in `suggestedFix`.
- Respect intentional style. Do not mark archaic, literary, terse, or stylized
  choices as problems unless they conflict with context, glossary, character
  voice, or the requested style.
- Record stable proper nouns or world-specific terms that are missing from the
  glossary as structured candidates: source term, candidate translation,
  evidence/category, and first line. The parent deduplicates accepted candidates
  into the summary or shared-asset proposal. Avoid generic words, common nouns,
  kinship terms, and short ambiguous fragments unless the user confirms them.
- Do not edit the translation file unless the user explicitly approves fixes.
  When applying approved fixes, verify the target line still matches the
  expected old text before replacing it.
- Merge parallel or chunked findings before final output. Finding IDs such as
  `H1-001`, `M2-004`, and `L1-003` must be globally unique after merge.

## Severity Codes

### HIGH

| Code | Type | Use when |
| --- | --- | --- |
| `H1` | Mistranslation | Meaning is wrong, reversed, or materially distorted |
| `H2` | Wrong subject | Speaker, actor, addressee, or referent is wrong |
| `H3` | Terminology mismatch | Translation conflicts with confirmed glossary after false-positive filtering |
| `H4` | Untranslated source | Source-language sentence or key phrase remains untranslated |
| `H5` | Omission | Source information disappears from the translation |
| `H6` | Addition | Translation adds information not present in source |
| `H7` | AI contamination | Meta phrases, analysis, or assistant chatter appear in translation |
| `H8` | Gender/pronoun error | Conflict with reliable character or glossary metadata |
| `H9` | Abnormal expansion | Translation is much longer than source and likely hallucinated, bled, or padded |

### MEDIUM

| Code | Type | Use when |
| --- | --- | --- |
| `M1` | Context break | Line does not connect logically with nearby context |
| `M2` | Voice mismatch | Character, narrator, or scene register is off |
| `M3` | Cultural handling | Literal or over-localized wording causes misunderstanding |
| `M4` | Unnecessary ambiguity | Source is clear but translation becomes ambiguous |
| `M5` | Term drift | Unconfirmed term varies inconsistently across the file |

### LOW

| Code | Type | Use when |
| --- | --- | --- |
| `L1` | Grammar | Target-language grammar error |
| `L2` | Punctuation | Punctuation, spaces, quotes, or casing violate target-language norms |
| `L3` | Awkward wording | Meaning is right but phrasing sounds translated or unnatural |
| `L4` | Formatting | Line breaks, blank lines, or tag-adjacent formatting are wrong |

## Type Profiles

Use the text type to prioritize checks; do not turn style preference into a
false positive.

| Type | Priorities |
| --- | --- |
| `game` | H2 speaker/actor, H3 item/skill/place terms, H8 character metadata, M2 voice consistency, UI length risk |
| `novel` | H1 meaning, M2 narrative voice, M3 cultural handling, L3 natural prose |
| `technical` | H1 precision, H3 terminology, H4/H5 completeness, code/command preservation |
| `subtitle` | H4 residue, M1 continuity, M2 spoken voice, L3 oral rhythm, line length |
| `academic` | H1 accuracy, H3 terminology, H5 completeness, L1 formal grammar, citation preservation |

## Deterministic Prescan

Run or adapt these checks before deeper semantic review. They reduce missed
issues and false positives.

### Load Inputs

```python
import json
import pathlib
import re
import unicodedata

SOURCE_FILE = pathlib.Path(SOURCE_FILE)
TRANSLATION_FILE = pathlib.Path(TRANSLATION_FILE)
GLOSSARY_FILE = pathlib.Path(GLOSSARY_FILE) if GLOSSARY_FILE else None

source_lines = SOURCE_FILE.read_text(encoding="utf-8").splitlines()
translation_lines = TRANSLATION_FILE.read_text(encoding="utf-8").splitlines()

if len(source_lines) != len(translation_lines):
    # Keep reviewing, but treat the mismatch as high-risk evidence for H5/H6.
    line_count_warning = {
        "source_lines": len(source_lines),
        "translation_lines": len(translation_lines),
    }
else:
    line_count_warning = None

glossary = []
if GLOSSARY_FILE and GLOSSARY_FILE.exists():
    raw = json.loads(GLOSSARY_FILE.read_text(encoding="utf-8"))
    glossary = raw.get("entries", raw) if isinstance(raw, dict) else raw
```

### Language Helpers

```python
LANG_ALIASES = {
    "zh": "Chinese", "zho": "Chinese", "中文": "Chinese", "汉语": "Chinese",
    "en": "English", "eng": "English", "英文": "English", "英语": "English",
    "ja": "Japanese", "jpn": "Japanese", "日文": "Japanese", "日语": "Japanese",
}

def normalize_language_name(name):
    return LANG_ALIASES.get(str(name).strip(), str(name).strip() or "Unknown")

def display_width(text):
    width = 0
    for ch in text:
        if unicodedata.category(ch).startswith("C"):
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width
```

### Character / Pronoun Metadata

```python
def detect_gender(info):
    if not info:
        return None
    s = str(info).lower()
    # Check female before male because "female" contains "male".
    if "女性" in str(info) or "female" in s or "she/her" in s:
        return "female"
    if "男性" in str(info) or "male" in s or "he/him" in s:
        return "male"
    if "neutral" in s or "nonbinary" in s or "they/them" in s:
        return "neutral"
    if "未知" in str(info) or "unknown" in s:
        return "unknown"
    return None

def looks_like_character(info):
    if not info:
        return False
    s = str(info).lower()
    return any(k in str(info) for k in ("角色", "人名", "人物")) or any(
        k in s for k in ("character", "char", "person")
    )

gender_map = {}
missing_gender = []
for entry in glossary:
    src = entry.get("src") or entry.get("source")
    info = entry.get("info") or entry.get("note") or ""
    gender = detect_gender(info)
    if src and gender in ("male", "female", "neutral"):
        gender_map[src] = gender
    elif src and gender is None and looks_like_character(info):
        missing_gender.append(src)
```

### H3 Longest-Match Terminology Filter

Never flag a short glossary term when it only appears as a substring of a longer
matched term. This is the main H3 false-positive guard.

```python
def glossary_src(entry):
    return entry.get("src") or entry.get("source") or ""

def glossary_dst(entry):
    return entry.get("dst") or entry.get("target") or ""

def longest_matching_terms(src_text, glossary):
    hits = []
    for entry in glossary:
        src = glossary_src(entry)
        dst = glossary_dst(entry)
        if src and src in src_text:
            hits.append((src, dst, entry))
    hits.sort(key=lambda item: len(item[0]), reverse=True)

    accepted = []
    spans = []
    for src, dst, entry in hits:
        start = src_text.find(src)
        end = start + len(src)
        covered = any(start >= a and end <= b for a, b in spans)
        if not covered:
            accepted.append((src, dst, entry))
            spans.append((start, end))
    return accepted

def terminology_findings_for_line(line_no, src_text, tgt_text, glossary):
    findings = []
    for src, dst, entry in longest_matching_terms(src_text, glossary):
        if dst and dst not in tgt_text:
            findings.append({
                "code": "H3",
                "line": line_no,
                "src_term": src,
                "expected": dst,
                "actual": tgt_text,
            })
    return findings
```

### H4 Source-Language Residue

Enable only patterns for the actual source language. Do not flag preserved names,
code, UI keys, or quoted terms without semantic evidence.

```python
SOURCE_RESIDUE_PATTERNS = {
    "Japanese": [
        r"[\u3040-\u309f]+",
        r"[\u30a0-\u30ff]+",
        r"[\u4e00-\u9fff]{2,}(?=[\u3040-\u309f])",
    ],
    "Korean": [r"[\uac00-\ud7af]+"],
}

def residue_hits(text, source_language):
    patterns = SOURCE_RESIDUE_PATTERNS.get(normalize_language_name(source_language), [])
    hits = []
    for pattern in patterns:
        hits.extend(re.findall(pattern, text))
    return hits
```

### H7 AI Contamination

```python
AI_CONTAMINATION_PATTERNS = [
    r"^(Translation:|Here is|Sure[,，]|Of course)",
    r"(the source says|the translation should be|translated as follows)",
    r"(I will translate|I translated this as|as an AI)",
    r"(以下是|下面是|这是.*?翻译|译文如下|翻译如下)",
    r"(我来翻译|我将翻译|根据原文|综合.*?来看|综上所述)",
]

def ai_contamination_hits(text):
    return [
        pattern for pattern in AI_CONTAMINATION_PATTERNS
        if re.search(pattern, text, re.IGNORECASE)
    ]
```

### H8 Pronoun / Gender Checks

```python
PRONOUN_SETS = {
    "Chinese": {
        "male": ["他", "他的", "他们"],
        "female": ["她", "她的", "她们"],
        "neutral": ["TA", "ta"],
        "match": "substring",
    },
    "English": {
        "male": ["he", "him", "his"],
        "female": ["she", "her", "hers"],
        "neutral": ["they", "them", "their", "theirs"],
        "match": "word",
    },
}

def contains_pronoun(text, pronoun, mode):
    if mode == "word":
        return re.search(rf"(?<![A-Za-z]){re.escape(pronoun)}(?![A-Za-z])", text, re.I)
    return pronoun in text

def pronoun_findings_for_line(line_no, src_text, tgt_text, target_language, gender_map):
    pronouns = PRONOUN_SETS.get(normalize_language_name(target_language))
    if not pronouns:
        return []

    findings = []
    for char_src, gender in gender_map.items():
        if char_src not in src_text:
            continue
        wrong_sets = {
            "male": ["female"],
            "female": ["male"],
            "neutral": ["male", "female"],
        }.get(gender, [])
        for wrong_set in wrong_sets:
            for wrong in pronouns[wrong_set]:
                if contains_pronoun(tgt_text, wrong, pronouns["match"]):
                    findings.append({
                        "code": "H8",
                        "line": line_no,
                        "character": char_src,
                        "expected": gender,
                        "actual_pronoun": wrong,
                    })
    return findings
```

For English targets, do not automatically mark singular `they` wrong for a
male/female character unless the glossary explicitly forbids it. For lines with
multiple characters, mark uncertain results as needing verification.

### H9 Expansion / Hallucination Prescan

```python
EXPANSION_THRESHOLDS = {
    "Chinese": {"ratio": 1.5, "extra_width": 32},
    "English": {"ratio": 1.8, "extra_width": 48},
    "default": {"ratio": 1.7, "extra_width": 40},
}

def expansion_threshold(target_language):
    return EXPANSION_THRESHOLDS.get(
        normalize_language_name(target_language),
        EXPANSION_THRESHOLDS["default"],
    )

def expansion_suspect(src_text, tgt_text, target_language):
    src_w = max(display_width(src_text), 1)
    tgt_w = display_width(tgt_text)
    cfg = expansion_threshold(target_language)
    return (
        src_w >= 8
        and tgt_w / src_w >= cfg["ratio"]
        and (tgt_w - src_w) >= cfg["extra_width"]
    )
```

H9 may overlap with H6 or H7. Report each applicable issue separately when there
is evidence.

## Semantic Review Frame

Use this frame for H1/H2/H5/H6/M1-M5/L1-L4 after deterministic checks:

```text
Source: <full source line>
Translation: <full translation line>
Nearby context: <brief previous/next context>
Text type: <game|novel|technical|subtitle|academic>
Language pair: <source> -> <target>
Relevant glossary/character/style evidence: <compact evidence>

Check:
1. Is the meaning accurate? (H1)
2. Is speaker/actor/referent correct? (H2)
3. Is anything omitted? (H5)
4. Is anything added? (H6)
5. Does it connect with nearby context? (M1)
6. Does voice/register fit? (M2)
7. Is cultural handling appropriate? (M3)
8. Is ambiguity introduced? (M4)
9. Is target-language grammar/punctuation/naturalness acceptable? (L1-L4)
```

## Mode A: Monte Carlo

Use for large files where the goal is risk discovery rather than full line-by-line
review.

### A1. Full Deterministic Prescan

H3/H4/H7/H8/H9 are full-file scans, not samples. Save them as `auto_findings`.

```python
auto_findings = []
for idx, (src, tgt) in enumerate(zip(source_lines, translation_lines), start=1):
    auto_findings.extend(terminology_findings_for_line(idx, src, tgt, glossary))
    if residue_hits(tgt, source_language):
        auto_findings.append({"code": "H4", "line": idx})
    if ai_contamination_hits(tgt):
        auto_findings.append({"code": "H7", "line": idx})
    auto_findings.extend(pronoun_findings_for_line(idx, src, tgt, target_language, gender_map))
    if expansion_suspect(src, tgt, target_language):
        auto_findings.append({"code": "H9", "line": idx})
```

### A2. Region Heat Map

```python
REGION_SIZE = 500

def region_id(line_no):
    return (line_no - 1) // REGION_SIZE

region_counts = {}
for finding in auto_findings:
    rid = region_id(finding["line"])
    region_counts[rid] = region_counts.get(rid, 0) + 1

regions = []
total_lines = len(source_lines)
for rid in range((total_lines + REGION_SIZE - 1) // REGION_SIZE):
    start = rid * REGION_SIZE + 1
    end = min((rid + 1) * REGION_SIZE, total_lines)
    density = region_counts.get(rid, 0) / max(end - start + 1, 1)
    heat = "HOT" if density > 0.05 else "WARM" if density > 0.01 else "COLD"
    regions.append({"id": rid, "start": start, "end": end, "density": density, "heat": heat})
```

### A3. Stratified Sampling

```python
import random

SAMPLE_RATES = {"HOT": 0.30, "WARM": 0.15, "COLD": 0.05}
sampled_set = set()

def draw_samples(regions, total_lines, global_cap):
    selected = []
    for region in regions:
        lines = set(range(region["start"], region["end"] + 1))
        sampled_here = lines & sampled_set
        if len(sampled_here) / max(len(lines), 1) >= 0.80:
            continue
        available = sorted(lines - sampled_set)
        per_round_cap = max(1, int(len(lines) * SAMPLE_RATES[region["heat"]]))
        before_retirement = max(0, int(len(lines) * 0.80) - len(sampled_here))
        count = min(per_round_cap, before_retirement, len(available))
        selected.extend(random.sample(available, count))
    return selected[:global_cap]
```

Rules:

- Maintain `sampled_set` across all rounds.
- Once a line is sampled, remove it from future rounds whether clean or not.
- Deduplicate final findings by `(line, code)`.
- The 30%/15%/5% rates are absolute per-round region caps calculated from the
  region's full size, not weights used to fill a larger global target.
- Mark a region `FULLY_SAMPLED` after at least 80% cumulative coverage. Retire
  it permanently; it must not re-enter a later round or receive reallocated
  quota.

### A4. Convergence

Defaults: `MIN_ROUNDS = 2`, `MAX_ROUNDS = 5`, `CLEAN_NEEDED = 2`.

Do not converge before `MIN_ROUNDS`. Converge only after two consecutive rounds
with no new deduplicated semantic findings.

If `MAX_ROUNDS` is reached without convergence, ask the human whether to:

- continue sampling another 3 rounds;
- switch HOT regions to `split N`;
- stop and write the current report.

## Mode B: Split Review

Use for full review of a file or assigned range.

`split N` means the maximum Host-owned assignment size. It does not limit total
coverage: the Host queues all non-overlapping assignments and a persistent Pi
worker claims another block after completing its current one.

```python
CHUNK_SIZE = N
total_pairs = min(len(source_lines), len(translation_lines))
chunks = []
for start in range(1, total_pairs + 1, CHUNK_SIZE):
    end = min(start + CHUNK_SIZE - 1, total_pairs)
    chunks.append((start, end))
```

For each chunk:

1. Read the assigned source/translation lines.
2. Read nearby boundary context from the previous and next few lines.
3. Confirm or reject the Host's full-file deterministic H3/H4/H7/H8/H9 evidence
   for rows in the chunk. Do not turn an automated signal into a finding without
   checking the exact aligned row and context.
4. Review every line semantically; batching 200-300 lines at a time is fine, but
   do not skip lines.
5. Submit all findings for the complete Host-owned assignment through the
   available assigned-findings tool.
6. Report the completed assignment and let the Host provide the next queued block.

Do not edit the translation file unless the human explicitly approves fixes. If
writing fixes, modify the main translation file and verify the old target line
still matches before replacing it.

## Subagents

YN Translation Workshop runs the full deterministic prescan in the Host before
starting any semantic child. The parent Agent owns phase order, mode and useful
worker-count choice, Monte Carlo convergence and human decisions, merge/dedupe,
asset updates, final report validation, and final user-facing status.

Each Pi child reviews only the Host-selected aligned rows. It may read source,
translation, glossary, character bible, style guide, relevant project files,
and optional cached web evidence. It must not edit source, overwrite translation,
or write shared glossary/character assets.

Subagent requirements:

- Call `readAssignedProofreadContext` first and continue until
  `assignmentComplete=true`. In split mode, the current Host-owned block is at
  most `split N` rows; later blocks arrive in the same persistent Pi worker
  session with a fresh active model context.
- Use the complete structured glossary, character-bible, and candidate records
  returned as direct matches for the current source rows. For a missing
  ambiguous term, use one exact `searchProjectText` lookup against the indexed
  asset path; do not bulk-read those assets.
- Read every manifest entry marked `required` through its complete length with
  `readProofreadReference`. Read optional cached web references only when they
  help resolve an assigned ambiguity.
- Treat Host H3/H4/H7/H8/H9 signals as evidence to confirm or reject, not as
  automatic final findings.
- Semantically review every owned split row, or only the explicit non-repeating
  sample rows in a Monte Carlo assignment, for H1/H2/H5/H6/M1-M5/L1-L4.
- Use global 1-based line numbers.
- Call `writeAssignedFindings` exactly once with the complete assignment's
  structured findings. The Host supplies exact `sourceText`,
  `currentTranslation`, `translationLine`, severity, and `agentId` from the
  bound files.
- Include stable missing proper nouns and world-specific terms in the same
  call's `glossaryCandidates`; never add generic words or mutate the glossary.
- An empty findings array is valid only after the complete assigned semantic
  scope was reviewed.
- Finish with one concise reply after the Host accepts the findings artifact;
  no separate child-completion tool exists in the Pi child contract.

Parent merge:

- Await all subagents.
- Merge all JSON findings and candidate terms; dedupe candidates and reject
  generic/common words before proposing a shared asset update.
- Renumber duplicate IDs after the current max for that code.
- Finalize the validated findings JSON. Human visualization is generated from
  that JSON by the product HTML and is not a second model-authored artifact.

## Final Output Contract

Proofreading has exactly one persisted output for both single files and folders:
the structured findings JSON. Do not create a Markdown summary or include a
`summaryPath` field.

Structured findings JSON: `[basename].proofread.json`

JSON must be UTF-8 and follow this shape:

```json
{
  "schemaVersion": "1.0",
  "documentId": "<basename>",
  "findings": [
    {
      "id": "H3-001",
      "severity": "H3",
      "type": "terminology",
      "sourceLine": 123,
      "translationLine": 123,
      "sourceText": "<source text verbatim>",
      "currentTranslation": "<current translation verbatim>",
      "suggestedFix": "<complete replacement in target language>",
      "rationale": "<brief explanation in target language>",
      "agentId": "Subagent 1/2"
    }
  ]
}
```

Required fields: `id`, `severity`, `type`, `sourceLine`, `translationLine`,
`sourceText`, `currentTranslation`, `suggestedFix`, and `rationale`.

Rules:

- `sourceLine` and `translationLine` are global 1-based line numbers.
- Re-read the exact line pair before writing a finding. Do not infer line numbers
  from chunk-local, sampled, displayed, or approximate positions.
- `sourceText` and `currentTranslation` must be full exact row text, not a
  shortened quote.
- `suggestedFix` must be a complete replacement line in the target language.
  Do not include labels, quotes, explanations, or "change X to Y" instructions.
- HIGH, MEDIUM, and LOW findings all need a directly usable `suggestedFix`.
- H9 findings need a corrected full-line retranslation in `suggestedFix`.
- `rationale` is a short explanation in the target language.
- Final finding IDs must be globally unique after chunk/subagent merge.
- Do not mix summary prose into JSON.
- Do not write Markdown fix proposals; JSON findings are the machine contract.

## Non-Negotiable Fix Contract

Every finding must contain a complete, directly usable target-language
replacement in `suggestedFix`. This is a full replacement for the entire
translation line, not a fragment, diff, note, rationale, TODO, placeholder, or
"translate this as..." instruction.

Before writing or reporting completion, verify:

- each HIGH, MEDIUM, and LOW finding has `suggestedFix`;
- `suggestedFix` is in the target language;
- `suggestedFix` can replace `currentTranslation` as-is;
- no labels, quotes, explanations, or markdown are embedded in `suggestedFix`;
- H9 expansion/hallucination findings include a corrected full-line
  retranslation, not just a warning.
