# YN Quality and Reliability Report

[中文](quality.md) · [Project](../README.en.md) · [Project examples](examples.en.md)

This 2.2.0 report separates code-enforced structural constraints, AI semantic review and actual user projects. It is not a tool ranking, and passing tests does not establish semantic translation accuracy.

## Public evidence

| Failure | Reproducible source | Scope |
| --- | --- | --- |
| Damaged placeholders, tags, control codes or row counts | [Translation validator tests](../tests/validation/translationValidator.test.mjs) | Declared structure; not semantic judgment |
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
| Large-candidate validation, import and cancellation | [Responsiveness test](../tests/main/artifactResponsiveness.test.mjs) · [Cancellation test](../tests/main/artifactCancelSettlement.test.mjs) | Background work and transactional commits; not an unlimited-size latency promise |

## Current acceptance scope

On 2026-10-13, the full local Windows x64 `npm test` run passed 223 test files under Node.js 24.14.1. Hidden Electron 39.8.10 / Node.js 22.22.1 verified PDF prescanning, translation, repair and independent review. [package.json](../package.json) and the [lockfile](../package-lock.json) define versions.

This is local acceptance, not a public CI badge. Native Pi workflow regressions use controlled test Provider responses to verify scope, write and recovery contracts; they do not measure real-model translation quality. The test count is a dated snapshot.

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

See [development and validation](development.en.md) for real desktop/package checks and hidden Windows acceptance rules. Time, memory, retries and cache hits vary with model, material, machine and network. Stable prompts and 500-line chunks do not establish universal cost savings.

## Detected failures and limits

Code can reject missing rows, damaged control tokens, unauthorized writes and incompatible proof. Independent AI review examines risky rows and stable samples; split proofreading covers its owned rows, while Monte Carlo samples. Models can miss mistranslations, pronouns, voice or logic. No uniform public blind evaluation is reported here.

Failures must not masquerade as completion. Missing required bindings, unretryable internal errors and no-progress repairs stop with drafts and diagnostics retained. PDF protection depends on document metadata and paint structure. Unsafe separation is rejected explicitly; see [PDF limits](pdf.en.md).
