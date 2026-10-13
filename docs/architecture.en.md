# Harness, Host and Pi

[中文](architecture.md) · [Workflows](workflows.en.md) · [Development](development.en.md)

## Responsibilities

| Layer | Responsibility |
| --- | --- |
| UI and official Agent API | Settings, plan/result presentation and Stop/Resume requests |
| Pi runtime | Model calls, messages, tool turns, sessions and context compaction |
| YN Host | Manifest, scope ownership, validation, shared-asset transactions, proof and completion gates |
| Supervisor and persistent workers | Chunk claims, child sessions, translation/review/proofread pools and cleanup |
| Artifacts | Staging, canonical candidates, findings JSON, HTML sidecars and native history |

Parent and Child share native Pi sessions and JSONL. Children cannot spawn children. Parent reads lightweight states and structured discoveries; full child transcripts are expanded on demand rather than injected into parent context.

## Settings and entrypoints

Homepage shortcuts, HTML parameters and the background Agent API share initialization, scanning, rule trials, prompts and Host. Style is one project parameter; there is no second translation engine.

## Terminology and characters

Formal terms take priority. Other discoveries keep established targets and surface conflicts. Reference preparation uses editable drafts, read-back, check and commit. Actual regex-preserved positions are excluded from terminology replacement/residue checks, as are correctly aligned formal terms. Character aliases do not directly trigger canonical-name warnings.

## Commit and recovery

Write staging, mechanically validate, independently review, then promote accepted output. Host binds proof to document, physical rows and content hashes. Recovery verifies all retained scopes before mutation or model startup; unchanged prose retains accepted proof.

Host owns PDF code/math outside model write scope. Verified write-ahead receipts precede normalization of old drafts, allowing cold recovery after file commit and before checkpoint persistence. Prose changes cannot masquerade as protection repair.

Shared assets, promotion, Host checkpoints and compensation use project-serialized transactions. Unconfirmed compensation retains verified output, backups and diagnostics and stops. Current [Host](../src/main/agent/piNative/ynDomainTools.ts), [Supervisor](../src/main/agent/piNative/subagentSupervisor.ts), [Runtime](../src/main/agent/piNative/sessionAgentRuntime.ts) and tests define the implementation.
