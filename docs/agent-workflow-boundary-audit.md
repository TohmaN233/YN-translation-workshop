# YN Agent Workflow Boundary Audit

Last audited: 2026-08-10

## Product runtime

The product Agent path is the pinned Pi `Agent` runtime, Pi JSONL sessions, and
Pi `AgentMessage[]`. Renderer code does not consume legacy jobs, status events,
provider transcripts, or a second YN Agent loop. Legacy authorization fields
are accepted only by `YnDomainRunRestoreSnapshot` while opening old Host state;
schema-3 snapshots cannot write them again.

## Typed operation scopes

The Host recognizes five operation scopes. Tool availability is not selected by
a tool-name blacklist.

| Scope | Behavior |
| --- | --- |
| Conversation / inspection | May read project, external reference, interface, source, and candidate data. It never resumes or completes parked workflow debt. |
| Bounded local repair | Owns one document and exact line range. It may run parent writes or prompt-defined Pi children without starting a complete translation queue. |
| Full translation | Owns the Host-planned translation queue, mechanical validation, independent review, same-worker repair, final artifact validation, and requested shared assets. |
| Full proofreading | Owns deterministic prescan, semantic proofread assignments, the sole normalized findings JSON, glossary decisions, and convergence. Human HTML is derived from JSON. |
| Resume | Reactivates the newest parked typed full workflow transactionally. It is an idempotent no-op when no workflow is parked. |

An ordinary local turn parks an incomplete full workflow. Switching from full
translation to full proofreading parks the first typed snapshot and restores or
creates the second. Calling `resumeYnWorkflow` replaces the temporary local
contract with the parked contract in the same mutable tool context. Failed
persistence restores the old suspended snapshot, worker ceiling, deferred reuse
audits, and parked entry before a retry can proceed.

An ordinary parent message while background children are still running is not a
scope switch: it keeps that supervisor and typed operation alive, preserves the
operation's worker ceiling, and lets the same Pi parent answer or steer while the
children continue. Only a new typed workflow/local-repair request parks or
replaces the active operation.

## Agent tool surface

Control and UI context:

- `resumeYnWorkflow`
- `readYnInterfaceContext`
- `listAvailableModels`
- `inspectSubagents`
- `steerSubagent`

Read-only project and reference access:

- `fetchWebReference`
- `inspectTranslationContext`
- `inspectProofreadRange`
- `selectSourceDocument`
- `readSourceLines`
- `readTranslationLines`
- `readProjectFile`
- `listProjectDir`
- `searchProjectText`
- `searchTranslationMemory`

Translation reuse audit:

- `prepareTranslationReuseAudit`
- `readTranslationReuseAudit`
- `recordTranslationReuseAudit`
- `runTranslationReuseAudit`
- `applyTranslationReuseDecision`

Translation artifact and alignment:

- `inspectTranslationAlignment`
- `recordTranslationAlignmentChecks`
- `writeTranslationChunk`
- `validateTranslationArtifact`

Proofreading artifact lifecycle:

- `recordProofreadParentReview`
- `writeProofreadFindings`
- `resolveProofreadGlossaryCandidates`
- `finalizeProofreadReport`
- `resolveProofreadMontecarloLimit`

Project assets:

- `writeProjectFile`, limited to validated `AI_translation/_workspace` and
  project settings assets. Translation candidates and proofread findings use
  their typed writers.

Native Pi child execution:

- `runSubagents` for concrete investigation, translation audit, or exact
  bounded repair.
- `runTranslationSubagents` only for the complete Host translation queue.
- `runProofreadSubagents` only for the complete Host proofreading plan.

The three child tools are deliberately distinct because they have different
write ownership and completion evidence. They share the same Pi child runtime
and supervisor; none is a second Agent implementation.

## Removed gates

The product path contains none of the following:

- suspended-workflow tool-name blacklists or whitelists;
- prompt regex or magic wording that grants workflow/tool permission;
- `wait_for_human`, `domainApproval`, legacy job status, or ambient approval;
- project worker settings promoted into an exact task count;
- a generated full-workflow marker required for a bounded local repair;
- one process-global child lock that makes read-only review and disjoint repair
  reject one another.

## Retained consistency checks

These checks are data integrity boundaries, not permission gates:

- source bindings and external reads resolve before execution;
- source files and files outside the project are never writable;
- translation writes own an exact document/range and cannot overlap another
  live writer;
- a specialized batch is reserved and persisted before child runtimes start;
- stale batch IDs, stale hashes, and stale artifact revisions cannot settle new
  work;
- full translation assignments pass mechanical validation and independent
  review before the same worker can claim another assignment;
- proofread reports replace the current exact range and cannot preserve stale
  findings for changed text.

These checks do not depend on tool names or model prose. They are derived from
typed operation, document, range, owner, revision, and hash data.

General delegation also distinguishes queued work from live concurrency. The
model may submit more independent tasks than the current project ceiling; the
supervisor retains every task but runs at most `min(configured N, taskCount)`
children concurrently. Disabling the complete-workflow pool does not become a
tool authorization blacklist for useful bounded Pi delegation.

## Executable boundaries

The architecture and lifecycle suites prove:

- schema-3 Host state cannot persist old authorization fields;
- prompt text cannot authorize children or alter worker counts;
- source setup is a typed per-tool capability, not a name set;
- local translation/proofread scopes switch without a full-workflow conflict;
- full workflow types cannot mutate one another without a session-level park;
- a parked full workflow is genuinely restored into the live tool context;
- failed resume persistence rolls back before a retry;
- ordinary parent interaction cannot retire a live background supervisor or
  rewrite its worker ceiling;
- no translation worker receives another assignment before review acceptance;
- the product dependency graph contains no tool-name permission list;
- Electron IPC and renderer paths use only the native Pi service and Pi message
  contract.

The same independent reviewer audited the final worktree and returned PASS,
including the general-delegation queue/worker distinction.
