# Legacy Boundary Audit

Last audited: 2026-07-12

## Verdict

The old Agent runtime is not in the product path. It was deleted rather than
hidden behind a renderer filter. The only message contract entering Agent UI is
Pi `AgentMessage[]`, plus native Pi streaming state and native runtime events.

## Agent UI Data Sources

| Data source | Product path | Contract before renderer | UI pollution protection |
| --- | --- | --- | --- |
| Session bootstrap/list | `agent-session:bootstrap` -> `PiNativeSessionService.bootstrap` | Pi session summaries only | Contains no transcript blocks. |
| Persisted transcript | `PiNativeSessionService.loadMessages` -> `JsonlSessionRepo` | Native Pi `AgentMessage[]` | No legacy parser or event projection exists. |
| Live model/tool stream | Pi core `Agent.subscribe` -> `PiSessionAgentRuntime` -> sequenced IPC envelope | `PiSessionRuntimeEvent`, an alias of Pi's imported native event union, whose messages are Pi messages | Reducer consumes the imported Pi union directly; no shadow event interface or `unknown` cast exists, and raw envelopes are never rendered as text. |
| Run-state recovery | `getRunState` / state subscription | Native `streamingMessage: AgentMessage | null`, phase/queue metadata, and latest transient child cards | State carries no status transcript; terminal convergence reloads the same native JSONL and replaces child cards by `subagentId`. |
| Subagent visibility | child `PiSessionAgentRuntime` -> supervisor live/persistent callbacks | Pi custom `AgentMessage` with `customType: subagent.translation` or `subagent.proofread` | One structured card per child is updated in place. Reply renders the complete native child transcript; live snapshots are transient, while initial/terminal cards alone persist to parent JSONL. |
| User input | `ChatInput` -> `useAgentSession` -> native prompt/steer/follow-up | User `AgentMessage` inserted optimistically, then persisted by Pi | Session ownership/run sequence prevents another session reload from replacing it. |
| Product slash actions | `ChatInput` -> `ChatWindow` command router -> native Pi action or local panel | No transcript entry for `/btw`, session, copy, model, settings, new, stop, steer, or follow-up command text | Electron acceptance asserts `/btw` stays out of user messages and unsupported legacy commands are absent. |

## Removed Legacy Product Sources

These source families were deleted and have no imports, IPC registration, or
compiled symbol on the product path:

- `src/main/agent/piRuntime/*`;
- `agentLoop`, `runProviderJob`, provider bridges, XML host-tool protocol, and
  old provider implementations;
- conversation, job, checkpoint, prompt-cache, status, approval, queue, and
  subagent job stores;
- `agentRuntimeHandlers.ts` and flat legacy runtime IPC;
- shared conversation/event/job/session-status dialects;
- renderer `ynAgentAdapter` / quarantine transports / old transcript renderer;
- their source-level tests and obsolete Electron verifier scripts.

The old vocabulary `waiting_for_human`, `domainApproval`, `jobId`,
`startJobWithTimeline`, `runPiAgentLoop`, `YnPiRuntimeSession`, and
`conversationStore` must remain absent from product source and the main bundle.
Verifier assertions may contain these strings only as forbidden-pattern tests.
Native Pi event names such as `message_start`, `message_update`, and
`message_end` remain in the harness reducer; they carry native Pi messages and
are never rendered as protocol text.

The supervisor does not own a second transcript writer. Parent, child, hidden
completion, and external custom messages all enter the same serialized
`PiSessionAgentRuntime` session-operation chain. Messages arriving during an
active turn are committed at its boundary, preventing a concurrent Pi JSONL
fork without adding a YN event or persistence dialect.

Generated workflow intent is structured metadata, not a transcript dialect.
Free-form intent is activated by the model's typed native tool argument and then
locked to that workflow; there is no regex classifier, approval state, or
renderer migration layer.

## Compatibility Code That Still Exists

| Code | Why it exists | Product path? | Why it cannot reintroduce old runtime |
| --- | --- | --- | --- |
| `src/shared/core/legacyHtml.ts` | Upgrade old generated line-review files. | Host entry only | Rewrites an explicit versioned embed marker and mounts the current React Agent OS; it does not parse or render old transcript data. |
| `src/shared/core/agentChatEmbed.ts` | Supplies the HTML mount shell and Electron host bridge. | Yes, as a host shell | It owns no transcript state and calls only the current embed entry. |
| Electron verifier forbidden-string checks | Prove rejected protocols are absent. | Test only | Strings are assertions, never runtime branches. |
| `docs/archive/legacy-agent-runtime/*` | Preserve history without deleting user-authored rationale. | No | Archive README declares the documents rejected and non-authoritative. |

## Proof

- `tests/agent/piNativeArchitecture.test.mjs` checks dependency pins, native Pi
  imports, current IPC, and absence of legacy product modules/symbols.
- `tests/agent/piNativeSessionService.test.mjs` exercises native persistence,
  events, prompt controls, isolation, and real disk deletion.
- `tests/agent/piNativeDomainTools.test.mjs` exercises domain-safe tools,
  validation, child agents, structured subagent messages, cross-workflow
  rejection, inspect-only semantics, and the single-line parent policy.
- `tests/agent/piNativeDomainCompletionIntegration.test.mjs` proves child
  completion wakes the parent and translation cannot finish before successful
  whole-artifact host validation.
- `tests/agent/piNativeProofreadCompletionIntegration.test.mjs` proves child
  completion wakes the parent to inspect the merged host-validated findings.
- `tests/agent/piNativeSubagentControl.test.mjs` and
  `piNativeSubagentStop.test.mjs` prove live inspect/steer, full transcript,
  compaction exclusion, atomic batch Stop, no completion wake, and no late write.
- `tests/agent/piNativeSubagentParentInteraction.test.mjs` proves the parent
  remains conversational while both children run and that a fresh load from the
  parent Pi JSONL retains each terminal child's native tool calls and paired
  tool results instead of collapsing Reply to `Done.`.
- `tests/agent/piNativeSubagentFailureRecoveryIntegration.test.mjs` proves a
  completed child is not killed when its sibling fails, that the failed batch
  wakes the parent, and that a second full native Pi child batch must repair the
  artifact before whole-artifact validation and final completion.
- `tests/agent/piNativeSubagentLifecycle.test.mjs` and
  `piNativeProofreadSubagents.test.mjs` prove child repair follows monotonic host
  progress rather than a fixed small turn cap. `piNativeDomainRunContract.test.mjs`
  applies the same ownership rule to parent completion and latest-batch
  replacement.
- `tests/agent/piNativeSessionAgentRuntime.test.mjs` proves that Pi harness
  `convertToLlm` carries a hidden native custom completion message into the next
  provider request, that concurrent external writes remain on one reachable
  JSONL branch, and that a child message received mid-turn waits for the native
  boundary. `piNativeArchitecture.test.mjs` locks that direct Pi converter into
  the parent/child core Agent construction path.
- `tests/renderer/piNativeSubagentTranscript.test.mjs` requires the Reply view
  to render the initial child prompt, later steer/repair user messages, native
  tool calls and paired results, and final assistant content from the persisted
  Pi child transcript. It also requires an honest persisted host result summary
  when a provider ends after its tools without a final assistant text block.
- `tests/agent/piNativeDomainCompletion.test.mjs` binds successful translation
  validation to the current artifact revision. Validator and proofread-writer
  regressions cover engine control commands, explicit IDs, and empty bound
  translation lines.
- `scripts/verify-electron-agent-html.mjs` runs a real `PiNativeSessionService`
  with deterministic model streaming and rejects duplicate tools, raw JSON,
  raw protocol, leaked status text, hidden custom messages, session bleed,
  false deletion, active-transcript loss after inactive deletion, destructive
  error rendering, and the terminal event/state race. It also discards all
  in-memory runtime/card state before reloading and expanding both child Reply
  transcripts, then exercises the real host completion gate and exact
  product-IPC translation-path binding.
- `scripts/verify-real-provider-agent-smoke.mjs` is the required real GPT-5.4
  Mini chat, two-child translation/final-validation, and two-child
  proofreading/strict-findings gate. The final run completed all three through
  the YN project's saved Provider/OAuth/proxy configuration.
- `scripts/verify-electron-agent-real-html.mjs` proves the embedded HTML path
  with GPT-5.4 Mini, immediate optimistic feedback, live thinking/token
  speed, Stop, clean completion, and new-session isolation.

## Audit Command

```powershell
rg -n -i "waiting_for_human|domainApproval|runProviderJob|conversationStore|ynAgentAdapter|agentRuntimeHandlers|eventRef|host_tool|activeJob|jobId" src/main src/renderer src/shared
rg -n -i "waiting_for_human|domainApproval|runProviderJob|conversationStore|ynAgentAdapter|agentRuntimeHandlers|eventRef|host_tool|activeJob|jobId" dist/main dist/renderer
```

Both commands must have no matches. Native Pi lifecycle event identifiers are
intentionally excluded because they are typed Pi runtime events, not a legacy
status/transcript dialect.

The canonical parent/child validation worktree was scanned again after typed
language-pair transport and shared project-asset validation were added. Source
and built output both returned zero matches. Packaging passed; `app.asar`
contains 83 Pi core paths, 483 Pi AI paths, and the main bundle, with zero
node-pty/XTerm entries. The historical one-success/one-failure child recovery
integration and both real GPT-5.4 Mini translation/proofreading gates pass on
this same product boundary.

Final source and built-output scans both returned no matches. The packaged ASAR
contains the pinned Pi core and AI packages plus the main bundle, and excludes
the deleted PTY/XTerm surface.

## Post-Review Ownership Audit

The final product boundary also distinguishes three native Pi ownership axes:

| Axis | Sole owner | Enforced boundary |
| --- | --- | --- |
| Transcript persistence | `PiSessionAgentRuntime` plus Pi `Session` | Child/custom appends register under the session transition, then a running turn-boundary wait occurs outside that lock. No service or renderer writes JSONL directly. |
| Translation validity | `YnDomainRunContract` artifact revision | Every committed parent or child write advances the revision; whole-artifact validation records only the exact current revision. Batch failure cannot preserve stale authorization. |
| Visible session selection | Explicit create/select/delete-fallback IPC state | Background parent, child, provider, and compaction updates carry `selectionChange: false` and cannot replace another selected session. |
| Persisted session selection | `PiSessionRepository` calls owned by create/select/delete-fallback | Runtime preparation for prompt or compaction opens the requested Pi Session but never rewrites the active-session pointer. A stale window therefore cannot change the next bootstrap selection. |
| Child steering acceptance | Pi core queue plus child Pi Session `message_end` | `steerSubagent` returns accepted only after the exact user message is consumed and persisted. A final-poll race is continued with native `Agent.continue()`; idle/settling children reject explicitly. |

Proof is provided by the new session-lock regression in
`piNativeSessionService.test.mjs`, the failed-partial-batch revision regression
in `piNativeBackgroundSubagents.test.mjs`, the renderer state-envelope
regression in `piWebSessionState.test.mjs`, and the inactive background parent
integration in `piNativeSubagentParentInteraction.test.mjs`. These tests use
native Pi messages, sessions, child runtimes, and state; no legacy adapter or
event dialect was added.

The final P2 regressions add two more ownership proofs. Prompting or compacting
an inactive session leaves the explicitly selected session unchanged across
bootstrap. Child steering is exercised both while the provider is active and
after Pi's final queue poll: native `Agent.continue()` consumes and persists the
late message before acceptance, while the post-turn terminal-card window
rejects it. The proofread writer also writes, reloads, and revalidates a finding
whose exact bound `sourceText` is empty and whose translation line is
extraneous.

Fresh post-ownership gates passed all 42 test files, deterministic Electron,
real embedded GPT-5.4 Mini interaction, native real-provider chat/translation/
proofreading, and unpacked packaging. Both source and built-output scans above
returned zero matches. The packaged ASAR contains Pi core, Pi AI, and the main
bundle, with zero node-pty/XTerm paths.

The sibling-failure/progressive-recovery worktree passed all 44 test files,
deterministic Electron, real embedded GPT-5.4 Mini interaction, native
real-provider chat/translation/proofreading, and unpacked packaging. The exact
source and built-output scans again returned zero matches. ASAR inspection
found Pi core, Pi AI, and the main bundle, with zero node-pty/XTerm entries.

## Final Review Corrections

The post-gate reviewer found no renderer bridge to restore, but identified
seven remaining native ownership defects. The final product boundary now also
enforces:

| Boundary | Sole owner | Final proof |
| --- | --- | --- |
| Parent completion at Pi's final queue poll | `PiSessionAgentRuntime` strict Follow-up receipt plus core `Agent.continue()` | Runtime and service regressions prove the hidden completion reaches the provider and Pi JSONL exactly once. |
| Current child generation | `YnSubagentSupervisor.activeBatchId` plus `YnDomainRunContract` batch ID | Overlap and stale-completion tests reject a prior batch after replacement ownership. |
| Translation recovery progress | Host validation debt and artifact revision | Decreasing debt permits continued repair; writes and failed batches alone cannot reset no-progress detection. |
| Proofread report validity | Canonical findings writer, report revision, and latest batch ID | Replacement resets stale partial findings; later mutations invalidate prior success; generic report writes fail. |
| Child terminal prose | Native child `AgentMessage[]` only | Empty assistant output stays empty; a separate host result summary cannot masquerade as model Reply. |
| Final logical empty line | Atomic translation writer | A source ending in a logical blank line round-trips as two terminal newlines. |
| Production delegation instructions | Fixed YN system prompt | Named native tools permit settled full replacement and prohibit overlap; no legacy job/wait state returns. |

On the exact corrected worktree, all 44 test files passed. Deterministic
Electron was interactive in 523 ms with 15.7 ms optimistic feedback and a
206.0 ms parent response during two active children. Real embedded GPT-5.4
Mini was interactive in 512.5 ms with 45.4 ms optimistic feedback, live
thinking/token telemetry, two Reply views, parent interaction during children,
and a validated four-line artifact in 74.70 s. Native real-provider chat,
translation, and proofreading all completed. Packaging passed; ASAR inspection
found 83 Pi core paths, 483 Pi AI paths, the main bundle, and zero node-pty or
XTerm paths. Both exact legacy scans returned zero matches and
`git diff --check` passed.

## Stop/Completion Cancellation Boundary

An explicit Stop now owns a session-scoped child-completion cancellation
generation. The generation advances under the native session transition used
for parent/child abort, and every pending completion delivery checks the same
generation before it may queue Pi Follow-up or launch an idle Pi custom-message
turn. This closes the final-poll race without adding a YN job or event bridge.

The active child batch remains Stop-addressable through settlement and parent
notification. `abortAll()` marks that batch Stop-requested even after its child
records become terminal, suppressing an as-yet-unstarted parent notification;
the session generation cancels one already in delivery. Public regressions race
both boundaries and prove Stop cannot produce a second provider call, persist a
hidden completion, wake the parent, or write a post-Stop assistant reply.

Fresh full gates passed all 44 test files, deterministic Electron, real
embedded GPT-5.4 Mini interaction, native real-provider chat/translation/
proofreading, and unpacked packaging. ASAR inspection again found 83 Pi core
paths, 483 Pi AI paths, the main bundle, and zero node-pty/XTerm entries. Both
exact legacy scans returned zero matches.

## Native Child Translation Acceptance

The shared validator's warning severity is intentionally suitable for import
and human review, but Agent artifact completion is stricter. Parent and child
runtime paths now consume the same YN translation artifact policy. A child
cannot write an empty target for a nonempty assigned source line, cannot move a
source blank line, and cannot report completion while untranslated, glossary,
character, or style quality debt remains. Progressive non-structural repairs
remain writable only while the host debt objectively decreases.

A red-capable native child regression reproduces the previously missed
multi-line omission and proves no candidate bytes or completed result survive.
All 44 test files, both Electron gates, native real-provider chat/translation/
proofreading, and unpacked packaging pass on the corrected worktree. ASAR and
both exact legacy scans remain clean.
