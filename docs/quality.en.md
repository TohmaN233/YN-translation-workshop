# YN quality checks

[中文](quality.md) · [Project](../README.en.md) · [Project examples](examples.en.md)

YN combines structural checks, independent AI review and editable line inspection. This page links the checks and their reproduction commands.

## Check coverage

| Failure | Reproducible source | Scope |
| --- | --- | --- |
| Damaged placeholders, tags, control codes or row counts | [Translation validator tests](../tests/validation/translationValidator.test.mjs) | Declared row and token structure |
| Proofreading suggestions breaking preservation | [Replacement validator](../src/shared/validation/proofreadReplacement.ts) | Physical-line, placeholder and preservation checks at submission |
| Preserved text colliding with residue/terminology checks | [Matcher parity tests](../tests/validation/glossaryMatcherParity.test.mjs) | Exclude actual preserved positions; still check prose |
| False untranslated findings blocking valid candidates | [Parent decisions](../tests/agent/translationResidueApproval.test.mjs) · [Native review](../tests/agent/piNativeTranslationResidueReview.test.mjs) | Exact row/text/reason decisions across formats; other structure remains enforced |
| Bibliography translated accidentally | [Reference workflow regression](../tests/pdf-reference-workflow.test.mjs) | Host-owned rows, existing HTML rebinding and original exported glyph pixels |
| PDF visual wraps fragmenting prose | [Paragraph boundaries](../tests/pdf-paragraph-layout.test.mjs), [Host/HTML/export regression](../tests/pdf-paragraph-workflow.test.mjs) | First/hanging indentation, narrow prose, native paragraph/table ownership, inline formulas and ordered flow areas |
| Academic PDF names, acronyms and numbering reported as untranslated | [Prescan and native Pi regression](../tests/pdf-academic-prescan.test.mjs) | Source-evidenced row scopes shared by translation, review and import; prose still checked, without extra model requests |
| Interrupted drafts and stale scope/review proof | [Recovery preflight tests](../tests/agent/piNativeRecoveryBatchPreflight.test.mjs) | Verify old proof, retain unchanged rows and compensate failed commits |
| Omitted or rewritten PDF code/math | [Child-write regression](../tests/pdf-child-write-rejection.test.mjs) · [PDF protection tests](../tests/pdf-protection.test.mjs) | Host skeleton, prose-only writes, no translation requests for all-protected chunks |
| Exit after file replacement but before checkpoint | [Cold PDF recovery](../tests/pdf-protected-recovery.test.mjs) | Isolated process exits at the commit window; a new Host verifies its write-ahead receipt |
| Long history and shutdown persistence | [Stop/storage test](../tests/agent/piNativeStopStorageFlush.test.mjs) · [Session storage](session-storage.md) | Native history retained; derived indexes do not replace proof |
| Large-candidate validation, import and cancellation | [Responsiveness test](../tests/main/artifactResponsiveness.test.mjs) · [Cancellation test](../tests/main/artifactCancelSettlement.test.mjs) | Background validation, cancellation and transactional commits |

## Reproduce

Use Node.js 22.19 or newer and the repository lock:

```bash
npm ci
npm test
```

Run the cold PDF recovery regression alone:

```bash
node --experimental-strip-types tests/pdf-protected-recovery.test.mjs
```

Desktop, LAN, API and package check commands are listed in [development and validation](development.en.md). Dependency versions are defined by [package.json](../package.json) and the [lockfile](../package-lock.json).

## Review and recovery

Structural checks inspect rows, control tokens, write scope and evidence bindings. Independent AI review checks meaning and terminology using source text and context. Split proofreading covers its assigned rows; Monte Carlo uses stratified samples. Findings are available in the review page for editing and acceptance.

Missing required files, internal errors and stalled repairs stop the task while retaining drafts and diagnostics. Recovery verifies the saved content and evidence before resuming. PDF input requirements and asset handling are described in the [PDF guide](pdf.en.md).
