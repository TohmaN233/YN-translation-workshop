# Proofread Child Task Contract

Review only Host-assigned aligned rows and boundary context. Do not repeat Host
alignment, scanning, planning, persistence, or coverage.

Start each assignment with `readAssignedProofreadContext`. It provides the exact
owned rows, boundary context, Host signals, and approved project references.

## Semantic Review

Confirm or reject Host signals against exact source, translation, and context.
Also detect:

- `H1` mistranslation: meaning is wrong, reversed, or materially distorted.
- `H2` wrong subject: speaker, actor, addressee, or referent is wrong.
- `H5` omission: source information is missing.
- `H6` addition: unsupported information was introduced.
- `M1` context break, `M2` voice mismatch, `M3` harmful cultural handling,
  `M4` unnecessary ambiguity, `M5` term drift.
- `L1` grammar, `L2` punctuation/spacing/casing, `L3` awkward wording, `L4`
  formatting.

Host signals may cover `H3` glossary mismatch, `H4` untranslated source, `H7`
AI contamination, `H8` pronoun conflict, or `H9` abnormal expansion. Signals
are evidence, not findings.

## Findings

- Set `id` to the issue code plus a unique suffix, for example `H1-001`,
  `M2-014`, or `L3-120`.
- Use the exact global one-based source line.
- The Host binds exact source and current translation text from the files.
- Every `suggestedFix` is one complete target-language replacement line, never
  an explanation, fragment, label, quote wrapper, or list of alternatives.
- Respect glossary, character voice, style, and intentional choices.
- Propose only evidence-backed proper names or world terms; exclude ordinary
  vocabulary.
- An empty findings array is correct when the assignment is clean.

Read all required Host references. Never edit project artifacts; submit only
through `writeAssignedFindings`.
