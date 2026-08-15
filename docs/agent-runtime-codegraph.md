# Agent Runtime Topology

Last verified: 2026-07-16

This document records the current product call graph. Historical graphs for the
deleted job/runtime bridge are archived and are not implementation guidance.

## Entry And Host Paths

```text
line-review / proposal HTML
  -> versioned Agent embed marker
  -> src/renderer/agent/embedded.tsx
  -> ChatWindow

shared-session popout
  -> primary: dedicated agent-chat-window renderer through Electron IPC
  -> IPC-failure compatibility fallback: current line-review HTML
     #agent-chat-popout route
  -> ChatWindow
```

All hosts use the same workspace identity, native session IPC, persisted Pi
JSONL, and live event broadcasts. The fallback mounts the same current React
host; it does not own another runtime or transcript.

## Renderer Path

```text
ChatInput
  -> product-backed slash actions (progress/copy/model/settings/new/abort/queue)
  -> useAgentSession
  -> electronPiSessionClient
  -> window.workshop.agentSession
  -> preload agent-session IPC

native AgentMessage[] / statically typed PiSessionRuntimeEvent
  -> useAgentSession reducer
  -> ChatWindow ordered transcript + streaming tail
  -> MessageView
       assistant text/thinking/toolCall
       paired toolResult
       custom subagent.translation / subagent.proofread card
```

There is no renderer-side legacy transcript normalizer. `normalize.ts` handles
only Pi tool-call field compatibility.

## Main Runtime Path

```text
registerAgentSessionIpc
  -> PiNativeSessionService
       -> sessionRepository (JsonlSessionRepo / NodeExecutionEnv)
       -> providerRegistry (Pi Models / OAuth / configured APIs)
       -> PiSessionAgentRuntime (source-adapted from Pi AgentSession)
            -> Pi core Agent
            -> Pi harness convertToLlm for custom completion/compaction context
            -> native Pi model stream
            -> native tool execution loop
            -> native queue / abort / retry semantics
       -> sequenced event and state broadcasts
```

Session prompt methods are native Pi controls:

- ordinary send -> `PiSessionAgentRuntime.prompt` -> Pi `Agent.prompt`;
- running steer -> `PiSessionAgentRuntime.steer` -> Pi `Agent.steer`;
- queued follow-up -> `PiSessionAgentRuntime.followUp` -> Pi `Agent.followUp`;
- Stop -> `PiSessionAgentRuntime.abort` -> Pi `Agent.abort`.

All writes to the shared Pi `Session` are serialized by
`PiSessionAgentRuntime`. A child/custom message that arrives during a model turn
is queued until the turn boundary, then appended to the same reachable JSONL
branch before it can start or queue the next native parent turn. No supervisor
or service callback writes around that owner.

## Translation And Proofreading Path

```text
Pi core parent Agent
  -> createYnDomainTools
       -> context/assets/search tools
       -> strict writeTranslationChunk validator
       -> validateTranslationArtifact
       -> writeProofreadFindings
       -> runTranslationSubagents
       -> runProofreadSubagents
            -> one host-validated, workflow-bound batch with the configured
               child count and complete file/range coverage
            -> folder mode reserves whole files across persistent workers;
               single-file mode uses contiguous non-overlapping ranges
            -> supervisor starts the configured PiSessionAgentRuntime children
               and returns to the parent immediately
            -> range-restricted tools
            -> child artifact validation + repair
            -> transient live structured card update
            -> terminal structured card persisted to parent Pi JSONL
            -> hidden native custom completion message wakes parent Agent
  -> host completion gate
       -> typed generated intent or model-selected native tool intent
       -> required assets / correct-workflow configured-child full coverage /
          findings contract
       -> parent-only write and validation for a single-line document
       -> parent final translation validation
       -> bounded native Pi follow-up repair when incomplete
  -> final assistant report
```

## Persistence And Completion

Pi JSONL is the transcript source of truth. Live events are an acceleration
path, not an alternate transcript. A terminal `settled` event and a terminal
state snapshot both invoke one idempotent convergence operation. The operation
checks session ownership and sequence, reloads native Pi messages, clears the
streaming tail, and restores the composer.

Background child completion is a native Pi custom message. It is persisted by
Pi Session and converted for provider context by Pi harness `convertToLlm` at
the core Agent boundary; renderer projection is not involved in waking the
parent.

Parent terminal child cards persist only bounded status plus the owned child
session reference. Complete child `AgentMessage[]` live solely in the child's
Pi JSONL. Expanding Reply asks main to verify parent ownership and reopen that
child JSONL on demand; the renderer then shows the child user prompt,
steer/repair input, assistant blocks, tool calls, paired results, and final
reply. Collapsing releases the loaded child transcript. No transcript is
embedded in a parent card or summarized as `Done.`.

Translation completion is revision-bound: artifact writes and completed child
batches advance `artifactRevision`, whole-artifact validation records
`validatedArtifactRevision`, and completion requires equality. An early
validation therefore cannot authorize a later mutation.

## Verification Layers

1. Architecture/source tests reject old module imports and protocols.
2. Native service tests exercise Pi core runtime controls and JSONL behavior.
3. Domain tests exercise validators and background child runtime orchestration.
4. Deterministic Electron verifies UI ordering, live blocks, controls, races,
   session isolation, and real file deletion.
5. Real provider runtime verifies translation/proofreading artifacts.
6. Real embedded Electron verifies provider latency, immediate local feedback,
   live thinking/token speed, and normal completion.

The final gate also reloads child cards from JSONL-only state, exercises
inactive-session deletion, and scans both source and built bundles for the
removed legacy runtime vocabulary.

## Background Ownership Boundaries

```text
child PiSessionAgentRuntime
  -> publishExternalMessage
       -> reserve parent session transition
       -> enqueue PiSessionAgentRuntime.appendMessage
       -> release transition while an active parent turn reaches its boundary
       -> Pi Session serialized append completes
       -> reacquire transition and emit the native message_end event

atomic child translation write
  -> domainRun.recordTranslationArtifactMutation
  -> artifactRevision++
  -> any prior validatedArtifactRevision is no longer current

explicit create/select/delete fallback
  -> PiSessionStateEnvelope.selectionChange = true
background model/child/compaction lifecycle
  -> PiSessionStateEnvelope.selectionChange = false
  -> renderer applies only when envelope.sessionId is already selected
```

The transition protects ownership only while the append is registered. It is
never held while waiting for a running Pi turn to flush the append. Persistence
still stays inside `PiSessionAgentRuntime` and Pi `Session`; no direct JSONL
writer or renderer reconciliation path was introduced.

Artifact revision changes at the commit boundary rather than batch success.
`recordSubagentBatch` still records the workflow topology, but it cannot make a
failed partial write reuse an earlier validation.

Session selection is now an explicit transport fact instead of being inferred
from whichever native runtime most recently emitted state. The envelope carries
no messages beyond the existing `PiSessionRunState`, and the renderer continues
to consume only Pi `AgentMessage[]` for transcript content.

## Final P2 Ownership And Queue Boundaries

```text
explicit create/select/delete fallback
  -> PiSessionRepository.writeActiveSessionId

prompt / manual compaction / threshold compaction on session A
  -> prepare/open session A only
  -> never mutate the persisted selection pointer for session B

supervisor.steer(child)
  -> PiSessionAgentRuntime.steerAndWaitForConsumption
  -> Pi core Agent.steer
  -> ordinary in-turn poll, or native Agent.continue after the final poll
  -> child user message appended to Pi Session
  -> only then return accepted

idle/settling child
  -> reject Steer explicitly
  -> no queue entry and no false accepted tool result
```

The consumption receipt is not a second queue. Pi core still owns queue order,
draining, interruption, and continuation. The receipt observes the native
`message_end` for the exact queued object after `Session.appendMessage`; it only
closes the gap between Pi's final steering poll and `agent_end`. Any guidance
arriving after the runtime atomically enters `settling` is rejected rather than
being accepted into a child that is already validating or persisting its
terminal card.

Proofreading findings use presence/type checks for bound text fields. Both
`sourceText: ""` and `currentTranslation: ""` are valid when they exactly match
their bound line; omission of either field remains invalid, and every reload
revalidates existing findings against the current source and translation files.
