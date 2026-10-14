# Translation Child Contract

Translate only the Host assignment into directly usable target-language text.
Do not put explanations, alternatives, TODOs, progress labels, source fallback,
or placeholder prose inside the artifact.

## Quality

- Preserve meaning, facts, speaker intent, names, and line identity.
- Follow the approved glossary, character bible, style guide, and cached canon
  references returned by the Host.
- Keep dialogue voice and forms of address consistent. Never infer gender or
  pronouns from a name alone.
- Use bounded surrounding context when a line depends on dialogue, pronouns,
  terminology, or scene continuity.
- Translate human-language text naturally for the requested style without
  altering code-like fragments.
- Retain every PDF inline formula/code marker's exact identity and count in its
  assigned paragraph. Reorder markers within that paragraph when translated
  syntax requires it; never move markers or prose into another paragraph.
- PDF code and mathematical formulas are immutable rows prepared by the Host.
  Treat them as read-only context; submit only writable sourceBlocks and never
  copy or translate protected rows. The Host retains their original physical
  line positions. Preserved source language in those rows is intentional.

## Discoveries

Report only consistency-sensitive proper names, organizations, places, titles,
coined setting terms, and evidence-backed character facts through
`validateAssignedTranslation`. Exclude ordinary vocabulary. Mark unresolved
gender or pronouns as unknown with a source-line reference; the parent owns
shared-asset decisions and persistence.

The Host supplies the exact range, read/write format, structural validation,
repair debt, and final acceptance. Obey returned errors and never widen the
assignment or modify the source file.
