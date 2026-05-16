# toy-txt-audit

This tiny TXT example is for testing the HTML line review workflow.

Use these files in the app:

- Source file: `source.txt`
- Translation file: `translation.txt`
- Glossary file: `glossary.json`
- File type: `txt`

`glossary.tsv` is also included as a plain-text reference, but the current app picker exposes JSON for glossary selection, so use `glossary.json` for normal UI testing.

Suggested checks:

1. Generate line-review HTML.
2. Open the glossary drawer.
3. Click `术语审计 H3`.
4. Click `审计标记` to show row markers.
5. Expected H3 rows:
   - Line 4: source has `ラボメン` twice, translation has `实验室成员` once.
   - Line 6: source has `岡部倫太郎`, translation lacks `凤凰院凶真`.
6. Line 1 tests long-term priority: `岡部倫太郎` should match as `凤凰院凶真`, not as short `岡部`.
7. Click the marker on line 6 to add it to the audit whitelist.
8. Generate a proofread prompt and confirm it includes the whitelist instruction.
9. Try TXT export:
   - Mono: translation-only output.
   - Bilingual: `source<TAB>translation` output.

Glossary edit test:

Change `凤凰院凶真` to another term in the drawer, confirm replacement, and check that old translations are replaced while source text remains unchanged.
