# Pi Native Host Constraint Audit

Date: 2026-07-30

The Host must distinguish a safety invariant from a planning preference. A safety invariant may reject a tool call. A planning preference belongs in the Pi system prompt and remains under parent Agent judgment.

## Child Count Contract

- `subagentCount` from project settings is an `up_to` limit. Any useful count in `1..N` is valid.
- A count is `exact` only when the user states that number in the current instruction, including an accepted Steer update such as `叫两个来修复`.
- A generated full translation/proofreading workflow also treats the configured value as an upper bound. Complete source coverage is mandatory; filling every worker slot is not.
- Host code must not derive a second exact count from line count, split size, file count, or an earlier turn.

## Corrected Over-Constraints

| Constraint | Previous behavior | Current behavior | Evidence |
| --- | --- | --- | --- |
| Configured count versus explicit count | A missing parsed count fell back to project `N` and was then enforced as exact. | Delegation carries `countMode: exact | up_to`; only a current user number is exact. | `piNativeExplicitSubagentDelegation`, `piNativeDomainRunContract`, `piNativeDomainTools`, and `piNativeSessionService` tests. |
| Autonomous repair lane formula | Host rejected task counts above `ceil(repairLines / splitSize)` even when tasks represented independent objectives. | Host enforces only `1..N`; the prompt gives a non-binding efficiency heuristic. | `bounded repair may use any independently useful count up to the configured maximum`. |
| Full workflow count | Single-file translation and proofreading still promoted configured `N` to an exact batch size after bounded repair had been corrected. | Full workflows accept any useful `1..N` batch while retaining complete range coverage and final validation. | `translation delegation accepts any useful 1..N range count` and `configured workflow child count is an upper bound`. |
| Monte Carlo tail rounds | The planner reduced a tail round below `N`, but completion still waited for configured `N`. | The Host records the actual accepted task count at batch start and requires exactly that many successful results; the final round may therefore use the remaining useful `1..N` workers. | `proofreadPlan.test.mjs` plus `a Monte Carlo tail round may use fewer workers than the configured upper bound`. |
| Folder workers versus assignments | The Host compared an exact user worker request against the number of queued file/chunk assignments, so five workers with eight assignments was rejected. | Batch start carries separate `workerCount` and `taskCount`. Exact requests constrain workers; completion requires one result per accepted assignment. | `five exact folder workers may drain more than five host-generated assignments` and the eight-assignment domain-contract regression. |
| Exact count inside a generated workflow | The session boundary discarded all explicit delegation metadata whenever a full workflow marker was present. | Canonical generated `up_to N` text remains typed project metadata, while an exact count stated in the current user prompt is preserved in the runtime and Host contract. | `a generated workflow preserves an exact subagent count stated in the current user prompt` and `a generated workflow ceiling remains ordinary up-to project metadata`. |

## Hard Safety Invariants To Keep

These constraints prevent corruption or false completion and should continue to reject invalid calls:

- Source identity, line count, and folder stage metadata cannot mutate during one active workflow contract.
- Source files are read-only. Candidate writes stay in host-resolved output paths.
- Translation repairs name an existing source document and an exact inclusive range.
- Concurrent translation write ranges cannot overlap.
- Line count, empty-line placement, placeholders, tags, variables, and control codes are validated before acceptance.
- Folder translation assignments and stage barriers are host-owned; model-authored assignments cannot bypass the queue.
- A child batch cannot be reported complete under a stale batch ID.
- A failed required child batch remains completion debt until it is retried, stopped, or replaced through the owning Pi run.
- Full workflows require their requested assets, complete source coverage, and final whole-artifact validation.
- Child runtimes cannot launch child runtimes.

## Coarse Constraints Requiring Redesign

These are stricter than the product ideally needs, but deleting them directly would introduce write races or mutable-selection bugs. They remain visible follow-up work rather than being disguised as permanent rules.

| Priority | Constraint | Why it is too coarse | Required redesign |
| --- | --- | --- | --- |
| P1 | One active child batch per parent session | An unrelated investigation cannot start while a translation batch is settling. | Track multiple Pi batches by ownership scope and expose aggregate parent notifications. |
| P1 | Source selection is blocked while any child batch runs | Selection is shared mutable state, so even read-only navigation is blocked. | Make source-reading and repair tools document-addressed instead of mutating one selected document. |
| P1 | Parent translation writes are blocked while any folder child runs | This prevents a parent from repairing an unrelated document or range. | Add document/range locks shared by parent and child writers, then reject only real overlaps. |
| P1 | Proofreading children must read every declared project reference completely | Large glossaries and character bibles can consume context even when most entries are irrelevant. | Provide indexed reference lookup plus an explicit required-core guide; validate evidence reads instead of byte-complete reads. |
| P1 | Non-persistent general assignments have one task-level attempt | A semantic/tool-contract failure settles the whole batch quickly even when the same child could repair it. | Continue the same child Pi session with structured Host feedback; do not create duplicate child sessions or silently retry from scratch. |

## Product-Scope Constraints

These are deliberate current product limits, not safety invariants:

- The folder-order editor supports one brace-delimited parallel group with ordered files before and after it.
- Folder proofreading currently supports split mode; Monte Carlo state is single-document only.
- Full generated workflows, local investigation, and repair all use `1..N`. Folder assignment count may exceed `N`, but only up to `N` persistent workers run concurrently.

Changing these limits requires a product/contract change and dedicated Electron acceptance, not removal of a throw statement in isolation.
