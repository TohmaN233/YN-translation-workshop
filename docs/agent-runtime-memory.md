# Agent Runtime Memory

Last verified: 2026-08-14

## 2026-08-14 LAN remote Agent terminal-reply convergence

The remote Agent could POST a prompt into the local singleton Pi runtime and the local window could
receive the completed reply, while the remote browser remained in `running` with only a partial or
missing assistant message. The prompt request and reply delivery were two independent channels:
the authenticated POST only acknowledged acceptance, while every subsequent Pi event/state update
depended on one long-lived SSE response. If that response dropped or was buffered after acceptance,
the browser had no completion path until EventSource happened to reconnect. Pi JSONL and the local
run state were already correct; this was a downstream convergence defect, not a provider or model
failure.

Every accepted remote Prompt, Steer, or Follow-up now starts an independent, session-bound durable
state convergence loop. It reads the existing local `PiSessionRunState` without invoking a model,
publishes sequence advances to the existing Pi-web adapter, and on terminal state forces the normal
`loadSelectedSession()` path to rebuild messages from canonical Pi JSONL. SSE remains the low-latency
path but is no longer the delivery authority. Its response now disables proxy buffering, enables TCP
keepalive, emits a 15-second heartbeat, and owns cleanup on response close/error. Poll failures are
observable with bounded backoff, while no fixed retry cap can strand an otherwise active Agent run.

The Electron LAN regression first reproduced the fault by closing only the remote Agent EventSource
after the second prompt reached the local provider: the local durable session completed with the full
reply while the remote transcript timed out. It now proves the same dropped stream converges to the
full user/assistant turn and `ready`, remains stable, then also proves a desktop turn completed while
remote SSE is closed appears after reconnect. Exactly three prompts produce exactly three provider
requests, so state recovery adds no model calls or token consumption. Screenshot evidence is at
`artifacts/lan-agent-remote-event-drop-recovery.png`.

Verification: all 138 test files pass; the complete hidden Electron/HTML suite passes LAN recovery,
proposal/folder flows, translation reuse, native Pi children, retry, compaction, and cold restart.
Windows 2.0.0 was rebuilt once after acceptance. Installer size is 105,174,854 bytes and portable
size is 104,800,126 bytes; all four release checksums verify. Hidden packaged acceptance launched
only `release/win-unpacked/translation-workshop.exe`, rendered in 2,292 ms, stayed invisible, and
exited cleanly. The NSIS portable envelope was not executed.

## 2026-08-14 HTML prompt-parameter default reset

Line-review HTML now exposes one `Restore defaults` / `\u6062\u590d\u9ed8\u8ba4` action in the prompt
parameter header. It restores every prompt field to the product defaults from the canonical
`promptParameterDefaults` implementation, immediately persists that complete reset to project state,
keeps the settings panel open, and does not generate or replace the current prompt. Agent-count and
model overrides plus custom preservation rules are explicitly cleared; output paths are rebuilt from
the current project root. Folder pages rebuild the default sorted brace order from the source manifest
bound into that HTML, never from an unrelated or stale ambient project state.

The reset has its own immutable factory-default payload rather than reusing the HTML's possibly
customized startup values. A model-directory request that was already in flight now reads the latest
settings only after it returns, so it cannot put a stale model override back into the form after a
reset. Line-review protocol v30 and prompt-settings v37 force old HTML through the normal automatic
upgrade path.

Verification: the legacy/generated-HTML regression proves customized startup settings remain separate
from factory defaults; the hidden Electron acceptance changes every parameter class, restores them,
checks durable project state, confirms no prompt generation, and captures the visible button. All 138
unit test files and the complete hidden Electron suite pass. Windows 2.0.0 was rebuilt once after
acceptance; installer size is 105,174,364 bytes and portable size is 104,799,584 bytes, all four
release checksums verify, and hidden `win-unpacked` startup rendered in 2,221 ms and exited cleanly.

## 2026-08-13 BattleSpirits retained-file reuse follow-up scope regression

Parent session `pi_b24ed3f9-7717-4dd1-ba81-8cb1a1ee4ef8` initially resolved only
`basic_system_tutorial_for_translation_v2.txt` from the current folder order and correctly prepared
one 4,435-line reuse audit with 53 semantic-risk rows. After the user accepted the reuse decision,
the Host still had one document. The next `validateTranslationArtifact` nevertheless demanded all
172 source-folder files, and a later repeated prepare started three audit workers on the omitted
files. Before they stopped, those workers consumed 56,336 model-visible tokens across 26 unrelated
assignments.

The regression was an operation-order bug. A reuse-decision follow-up begins as a local turn while
the full translation DomainRun is parked. The generic `requiresSourceManifest` wrapper resolved and
cached the whole folder while `fullWorkflow=false`, before `applyTranslationReuseDecision` restored
the one-document workflow. Every later tool in that turn reused the poisoned 172-document manifest,
so the completion gate honestly exposed the wrong scope. The decision tool now has an explicit
restore-before-manifest contract; it resumes the parked Host workflow before any manifest resolution.
A real two-file session regression proves that the omitted file stays absent both before and after
the user's decision.

Two adjacent waste paths are also closed. `prepareTranslationReuseAudit` now rejects a second prepare
after the current workflow owns an artifact, so a freshly applied/repaired candidate cannot become
new startup-reuse work. With child workers enabled, the parent prompt calls
`runTranslationReuseAudit` directly and cannot justify inventing an audit ID; with workers disabled,
the Host returns bounded parent assignments containing their real audit IDs. The observed initial
`auditId="???"` plus 4,435-line read had cost one avoidable provider/tool-error turn.

The same artifact's `MANAGED basic_system_prompts` section was checked separately after the user
suspected a missing batch. Source and startup candidate both contain the same 331 lines at
L4105-L4435, the same 306 `[managed:id]` records, and no source-nonempty/candidate-empty row; the
startup backup and current candidate differ only outside that section. The reuse audit mechanically
accepted 319 Managed-range rows and sent 12 risk rows to semantic review. The visible large ID gaps
(`00230->00427`, `00533->00658`, `00925->01592`) already exist in the supplied source TXT. YN can
prove candidate alignment to that TXT but cannot prove upstream Managed extraction completeness
without an extractor-owned expected-ID/count/hash manifest. Do not add a continuity check: these IDs
may legitimately be sparse.

Final verification and release evidence:

- [x] the real retained/omitted two-file decision-follow-up regression failed `2 != 1` before the
  restore-order fix and passes after it; it also proves a repeated prepare is rejected;
- [x] focused reuse session/domain/prompt tests, typecheck, runtime-skill validation, and all 138 unit
  test files pass;
- [x] full hidden Electron Agent/HTML acceptance passes LAN convergence, folder manifest/tabs,
  translation reuse decision/restart, Host completion gating, Pi subagents, provider retry,
  compaction, and cold restart with no raw-protocol or duplicate-tool leak;
- [x] Windows 2.0.0 artifacts were rebuilt and all four release checksums verify. Installer:
  105,173,876 bytes; portable: 104,799,101 bytes. Hidden packaged acceptance launched only
  `release/win-unpacked/translation-workshop.exe`, rendered in 3,034 ms, and exited cleanly without
  showing a window. The NSIS portable envelope was not executed.

## 2026-08-12 BattleSpirits reuse run: glossary evidence, atomic resume, and review source binding

The completed reuse run used parent session `pi_8bb01459-4ed8-4e27-a15b-bd48098525e9`.
The Host inspected all 171 documents and 18,420 lines in one folder-wide pass. It automatically
accepted 18,387 low-risk rows, sent 33 risky rows across 27 documents to four persistent audit
workers, and obtained 27 `reuse` plus six `retranslate` verdicts. The audit workers used 46,409
tokens across exactly 27 read/submit assignments. After the user's one document-level decision,
the Host repaired and independently reviewed the six selected rows, then accepted all 171 documents.
The final seven `length_anomaly` warnings were inspected at the user's request and were all benign
continuation-line or elongated-shout compressions, so no extra writes were made.

The finished-session monitor reports 350,778 parent-plus-child tokens, zero provider/assistant
errors, zero fetch failures, zero transport diagnostics, zero hidden repair turns, zero redundant
terminal continuations, zero duplicated validations, zero checkpoint failures, and zero completion
state contradictions. It records six writes, six validations, and six review submissions. Much of
the 235,357-token parent total belongs to the user's subsequent seven-warning investigation rather
than the translation queue. No Pi compaction was expected: audit workers reset between small
assignments, and no active branch crossed the threshold.

The full replay nevertheless exposed three correctness/efficiency defects:

- One audit worker incorrectly marked `ev40301.txt:3` (`Card Garden` / `Card Ring`) for
  retranslation even though both spellings are approved in the canonical glossary. The audit read
  tool returned aligned rows but omitted the bounded project-reference bundle already used by
  translation workers. Audit reads now derive direct approved glossary/character/candidate matches
  from the assigned rows plus context and return that bounded structure. The prompt explicitly treats
  approved non-Chinese targets as authoritative, so an English official name is not mistaken for an
  untranslated line. This removes cross-worker guessing without injecting whole project assets.
- After `applyTranslationReuseDecision`, the parent first received a rejected
  `runTranslationSubagents` call, then spent a provider turn on `resumeYnWorkflow`, then retried.
  The user-decision turn had restored the parked domain in suspended/local form, while the mutating
  apply tool did not restore its complete-workflow ownership. Applying an explicit reuse decision now
  atomically resumes the suspended workflow before mutation and verifies that it is the same full
  translation contract. The queue is therefore immediately callable without a failed tool turn or
  model-authored recovery ceremony.
- A review worker for `ev21501.txt` received an assignment-specific review scope but retained the
  folder request's initial document binding. Its context lookup consequently resolved
  `ev21501.txt` at the project root instead of `txt/ev21501.txt` and produced `ENOENT`. Prepared
  reviews now carry the already resolved document-bound request into the persistent runtime on every
  assignment, and the child card label follows that same request. Relative read paths therefore
  resolve against the assigned document while artifact ownership remains unchanged.

The incorrect glossary verdict was harmless to output because the translation worker consulted the
glossary and reproduced the existing correct line, but it did waste one audit verdict plus one
unnecessary translation/review assignment. The other five retranslation verdicts were genuine
meaning omissions. Both recorded tool errors were recovered in the old run; the fixes remove their
causes in future runs rather than hiding them from monitoring.

Regression evidence:

- [x] focused red/green tests cover bounded glossary references in reuse audits, decision-time
  workflow restoration without an explicit resume call, and assignment-bound review context reads;
- [x] typecheck, runtime-skill validation, and all 136 unit-test files pass;
- [x] full Electron/HTML acceptance passes LAN convergence, legacy upgrade, folder tabs, reuse
  decisions, native Pi tools/subagents, provider retry/abort, compaction, and cold restart; it reports
  no raw-protocol or duplicate-tool leak;
- [x] Windows 2.0.0 installer (105,164,301 bytes) and portable executable (104,789,532 bytes) were
  rebuilt, release metadata and all four SHA-256 entries verify, and the portable renderer reached
  ready in 8,098 ms with five stable processes.

## 2026-08-12 BattleSpirits reuse-audit restart: folder scope, risk filtering, and settlement race

The failed opening used parent session `pi_979fbc96-6229-4a60-a0f8-373822e1606b`. The project
manifest contained 171 documents and 18,420 lines, but the parent first selected `ev00000.txt` and
called `prepareTranslationReuseAudit({ documentId: "ev00000.txt" })`. The Host accepted that illegal
narrowing and prepared only 18 lines. This was not a provider outage: the run and its four child
sessions recorded zero fetch errors, zero assistant/provider errors, zero transport diagnostics, and
zero tool errors. After the user challenged the scope, the same parent called the tool without a
document ID and correctly prepared all 171 documents before the product was exited.

The root cause was a contract defect, not merely a bad model choice. The model-facing schema exposed
an optional `documentId` even during a folder-wide reuse workflow, while the selected-document state
made the first file look authoritative. `prepareTranslationReuseAudit` now has an empty model-facing
parameter schema and always refreshes the complete Host manifest. Even a legacy direct call carrying
`documentId` is ignored for scope, so a cached prompt cannot recreate the one-file audit. The system
prompt also tells an active full workflow to begin directly instead of wasting a provider turn on
`resumeYnWorkflow`, and explicitly forbids selecting or narrowing to one document before folder audit.

Replaying the real BattleSpirits candidate exposed two deterministic false-positive classes in the
mechanical audit: 84 unchanged resource references such as 32-hex `.bundle` names, and 42 punctuation
or elongation rows whose only Japanese residue was an isolated small `っ`/`ッ`. These rows contain no
translatable lexical prose. The scanner now auto-reuses an identical opaque resource reference and
does not classify isolated促音 plus punctuation as source-language prose. Changed resource references
remain risky. The real manifest's semantic-review queue falls from 159 rows in 107 documents to 33
meaningful rows in 27 documents; the remaining rows include actual omissions, suspicious compression,
source copies, and target-language risks and therefore still go to Pi children.

Full-suite stress also exposed a narrow batch-settlement race. Child cards could already be terminal
while the old supervisor promise was still persisting Host settlement and releasing the active batch;
a fresh explicit user prompt could then collide with that stale batch. `sessionService` now waits for
that terminal-only settlement boundary before starting the new prompt. It does not wait while any
child is running, and empty lazy review pools are excluded so normal parent interaction cannot block.
The formerly intermittent failure-recovery integration passed ten consecutive runs after the fix.

Why this works: folder scope is enforced by the Host API rather than model obedience; deterministic
non-prose is removed before any semantic model call; and only the small asynchronous interval between
terminal cards and durable settlement is serialized. The durable reuse-audit store remains outside
model context, so its JSON size is not token usage. Session ownership is deliberately retained for
cold restart and cannot authorize a different parent session.

Regression evidence:

- [x] focused tests cover selected-document narrowing attempts, active-workflow prompt behavior,
  opaque-resource and isolated促音 filtering, terminal settlement, and uninterrupted parent interaction;
- [x] typecheck, runtime-skill validation, and all 135 unit-test files pass; the race-focused recovery
  test additionally passed ten consecutive executions;
- [x] full Electron/HTML acceptance passes LAN convergence, proposal transactions, folder migration,
  native Pi streaming/tools/subagents, reuse decisions, provider retry/abort, compaction, and cold
  restart. It reports no raw-protocol or duplicate-tool leak; interactive startup was 80 ms and parent
  interaction during child work was 9.7 ms;
- [x] Windows 2.0.0 installer (105,164,062 bytes) and portable executable (104,789,289 bytes) were
  rebuilt, release metadata and all four SHA-256 entries verify, and the portable renderer reached
  ready in 8,664 ms with five stable processes.

## 2026-08-12 BattleSpirits completed-run audit: settlement truth, explicit recovery, and discovery closure

The completed run used parent session `pi_10b9ba56-f169-4ca7-a3b7-99c5f0715432` and 15 owned
child sessions. It produced 171 candidate artifacts. Replaying the complete JSONL with the corrected
monitor reports 7,958,048 total tokens, three recovered `WebSocket closed 1006` errors, **zero fetch
failures**, 28 tool errors, six staging-checkpoint failures, eight hidden repair turns consuming
456,480 tokens, one duplicated final validation, 160 synthetic zero-count reconciliation records,
and one explicit completion-state contradiction. The prior monitor's durable `details` bytes are now
reported separately from model-visible `content`; only the latter can raise token-size alerts.

The final “171 files passed, but completion was not marked complete” state had one concrete cause:
folder settlement was all-or-nothing. One failed assignment cleared completion for every document in
the batch, including 170 accepted documents. A later recovery path fabricated `host-reconciled-r1`
records with `count: 0`; those records neither represented accepted assignments nor satisfied the
typed completion contract. The filesystem could therefore be valid while Host state honestly remained
incomplete. Settlement is now per document and uses each document's reserved assignment count.
Hash-current recovery requires a positive accepted-scope count; zero-result completion records are
rejected and no longer generated.

The same audit found and corrected the adjacent causes that could recreate the mismatch or waste:

- any exhausted assignment stops that persistent worker before it can claim another queue item;
  accepted sibling documents remain completed, while only the exact failed document retains debt;
- an exhausted batch creates a durable recovery pause. `sessionService` now parks the child completion
  notification without starting a hidden parent turn. Only tools created for a fresh user turn that
  observed the pause can resume it; supervisor-start rollback is a separate non-pausing transaction;
- staging candidate path/hash and exact assignment failures remain on the child card and completion
  event. Parent direct writes preflight ownership before touching canonical bytes and roll back the
  candidate, domain state, alignment state, and persisted Host state as one transaction on failure;
- explicit trailing blank source/candidate rows use an array-based versioned alignment hash. Joining
  arrays into text can no longer collapse the last logical row and repeatedly fail staging checkpoints;
- child glossary/character discoveries are persisted with document, range, source hash, candidate
  hash, and evidence. The parent pages and resolves this Host state into validated canonical workspace
  assets. Accepted conflicting glossary targets become a cross-file terminology rule; final validation
  reports exact document/line debt and sends only those lines through the existing repair/review path;
- folder final validation returns one aggregate hash/count summary plus capped warning documents,
  exact warning ranges, and small warning samples. It no longer injects the complete 171-document
  success payload into the model twice;
- the live monitor now alerts on hidden repair turns/tokens, duplicate validation hashes, synthetic
  zero-count reconciliation, and “all files passed but completion state is incomplete” contradictions.

Why this works: artifact validity and workflow completion now commit from the same per-document Host
evidence instead of being inferred from nonempty files or reconstructed with fake batch counts.
Failures become an explicit, persisted user-visible pause rather than authorization for another hidden
model turn. Discovery and final-validation debt are typed Host records, so the model cannot silently
drop them in a prose summary.

Regression evidence:

- [x] focused tests cover per-document partial settlement, no hidden restart, fresh-turn resume,
  worker stop-after-exhaustion, start-reservation rollback, transactional parent writes, trailing blank
  rows, durable discoveries, cross-file terminology debt, compact final validation, and monitor metrics;
- [x] typecheck, runtime-skill validation, and all 135 unit-test files pass;
- [x] full Electron/HTML acceptance passes LAN convergence, proposal transactions, folder migration
  and tabs, compact folder validation, native Pi streaming/tools/subagents, reuse decisions, provider
  retry/abort, compaction, and cold restart. The renderer reported no raw-protocol or duplicate-tool
  leak; interactive startup was 43 ms and parent interaction during child work was 11.9 ms;
- [x] Windows 2.0.0 installer (105,161,255 bytes) and portable executable (104,786,519 bytes) were
  rebuilt, release metadata and all four SHA-256 entries verify, and the portable renderer reached
  ready with four stable processes. The portable verifier now falls back to `Get-Process` when a
  managed Windows environment denies CIM process inspection, without skipping window/process checks.

## 2026-08-12 BattleSpirits full-lifecycle audit: terminal token waste and review-state repair

The comprehensive replay used parent session `pi_1bf481f6-ffc9-499c-992c-2d5e7f50c05e` and its
11 owned child sessions. The corrected monitor now reports 1,916,513 total parent-plus-child tokens,
zero assistant/provider errors, zero fetch failures, zero transport diagnostics, and zero compactions.
The transport-storm fix therefore held. This run still exposed four tool errors, 25 translation
validations for 22 writes, 83,887 bytes of search results, two review-evidence regressions, and 36
model calls made only after a terminal validation/review tool had already decided the turn. Those 36
redundant calls accounted for 657,332 request tokens, about one third of the run total.

Why the earlier audit missed this: it stopped after the first high-volume indexed-reference pattern
instead of reconstructing every child as a tool-state sequence. The live monitor also had an ownership
bug: given one parent JSONL, it read every parent and child JSONL in that workspace directory rather
than only children whose session header pointed to that parent. Aggregate totals could therefore mix
different historical runs. There was no alert for terminal continuations, repeated validation, review
evidence reopening, or checkpoint persistence failures. A green transport/error count was incorrectly
treated as a complete health verdict.

Corrected runtime boundaries:

- `readAssignedSource` now returns `absoluteLines` beside compact source-block IDs, so discovery
  `evidenceLine` values cannot confuse relative base-36 block positions with absolute file lines;
- glossary category, character gender, and confidence are strict model-facing enums. Invalid values
  are rejected by the Pi tool schema instead of consuming repeated Host validation turns;
- `repairAssignedTranslation` uses structured `{ line, translation }` objects. Legacy colon strings
  remain accepted only by the direct compatibility parser, not advertised to the model;
- a successful full write no longer pretends that mandatory discovery/semantic validation occurred.
  Only the actual `validateAssignedTranslation` tool can close that debt;
- every tool result in a Pi batch containing a managed write or validation now terminates the automatic
  Pi continuation and returns the complete batch to Host inspection. Successful translation validation,
  review submission, and exact review-repair writes no longer buy a second full-context request for
  empty or prose-only confirmation;
- a hash-current repair review preserves accepted risk/sample verdicts even when its audit ID changes
  to the synthetic repair identity. Re-registering the same candidate can no longer reset the whole
  review scope and send all accepted rows back through semantic review;
- staging checkpoint persistence is transactional: the affected in-memory alignment range and read
  markers roll back if Host persistence fails, while concurrent sibling ranges remain intact. The
  surfaced error now includes a bounded `Error.cause` chain, so a future recurrence retains its actual
  filesystem/runtime cause instead of only `Failed to persist the staging recovery checkpoint`.

Monitoring was hardened at the same boundary. `scripts/monitor-pi-live-session.mjs` now includes only
the selected parent plus child headers whose `parentSession` points to it. It reports fetch and assistant
errors, transport diagnostics/resets, tool errors, checkpoint failures, per-tool oversized results,
search bytes, validation/write counts, terminal-continuation count and tokens, and review evidence that
expands again after an exact rejection. Replaying the affected BattleSpirits session through the new
monitor detects all six observed anomaly classes in one report.

Reading old translations and clean-retranslation backups remains allowed. Broad search is observable
and bounded but is not hard-blocked, matching the user's decision that historical text can legitimately
save model tokens.

Pi context compaction remains threshold-driven and works in its dedicated regression suite. Zero
compactions in this run are expected: persistent workers reset active context between assignments, and
no single active assignment branch crossed the Pi threshold. Compaction would not have prevented the
observed waste because the extra requests occurred inside otherwise valid assignment turns before the
threshold; terminal Host handoff removes those requests at their cause.

Regression evidence:

- [x] focused tests cover absolute-line mapping, strict discovery schemas, structured repairs, mandatory
  native validation, mixed-batch Host handoff, terminal translation/review tools, exact repair re-review,
  review evidence preservation, checkpoint rollback, and bounded error causes;
- [x] the monitor fixture proves parent ownership isolation and detection of transport, token, tool,
  checkpoint, terminal-continuation, large-search, and review-evidence anomalies;
- [x] typecheck, runtime-skill validation, and all 135 unit-test files pass;
- [x] Windows 2.0.0 installer (105,154,641 bytes) and portable executable (104,779,863 bytes) were
  rebuilt; release metadata and all four SHA-256 checksums verify;
- [ ] Electron visual acceptance and portable launch remain intentionally unrun because the user
  explicitly asked that the current desktop not be controlled while they are doing other work.

## 2026-08-12 BattleSpirits restart: indexed-reference token repair

The first restart after the transport repair used parent session
`pi_7d293858-d107-4a15-a1e1-c36e3f560e74` with eight translation workers and four review
workers. It proved the transport changes were healthy: through the stop boundary there were zero
assistant/provider errors, zero compactions, and no `yn_provider_transport_error` or fallback-reset
diagnostics. The run was stopped deliberately at 14:11:28 with Host debt preserved after 12 accepted
artifacts, rather than being allowed to continue while a newly observed token issue was diagnosed.

The stopped run used 3,052,083 total tokens (797,726 input, 161,301 output, 2,093,056 cache read).
Across 20 started translation assignments, children made 20 whole-file reads of the approved glossary,
20 whole-file reads of the character bible, seven whole-file reads of glossary candidates, and 98
additional text searches. The 50 project-file reads returned 298,379 model-visible characters; the
searches added 118,401. This was not the Host attaching asset bodies twice: `readAssignedSource`
correctly returned only paths. The root cause was relying on a prompt-level "on demand" instruction
for indexed assets. Terra still chose a defensive full read at every reset assignment and then searched
many of the same names again. Because each full asset remained in all later write/repair/validate turns
for that assignment, its cost compounded primarily into cache-read tokens.

Corrected boundary:

- `readAssignedSource` now parses canonical project assets and returns only glossary, character, and
  non-duplicate glossary-candidate entries whose source/name/aliases occur verbatim in the assigned
  source. The combined direct-match bundle is capped at 64 entries and 16,000 serialized characters;
  unmatched bodies are absent;
- translation children cannot page-read the three indexed asset files. A missing ambiguity remains
  recoverable through one exact `searchProjectText` query against the canonical path. Other project
  files, external references, current translations, and translation-reuse backups remain readable;
- the child prompts and tool descriptions name the same Host policy, so ordinary turns use direct
  matches without first paying for a rejected bulk-read call;
- a real BattleSpirits `ev21201.txt` probe now returns nine approved glossary matches and four character
  records in a 1,850-character reference object. The complete `readAssignedSource` details are 11,880
  characters, while a whole glossary read fails visibly and the prior-translation backup remains
  readable. This replaces roughly 64K of glossary/character pages per assignment with the entries that
  actually occur in that assignment and should also remove most of the redundant name searches.

Why this works: the saving is enforced at the typed Host tool boundary rather than delegated to model
obedience, while exact lookup and historical translation reference stay available. `reuseExistingTranslation`
continues to govern whether old candidate lines are retained as artifacts; it is intentionally not used
as a read-authorization switch.

Regression evidence:

- [x] focused lifecycle coverage proves assigned-source direct matches arrive automatically, unmatched
  asset bodies stay absent, indexed whole-file reads fail visibly, exact indexed search still works, and
  historical translation backups remain readable;
- [x] typecheck and all 133 unit-test files pass;
- [x] full Electron/HTML acceptance passes LAN convergence, proposal transactions, folder tabs, native
  Pi streaming/tools/subagents, retry/abort, compaction, cold restart, and reports no raw-protocol or
  duplicate-tool leak. Interactive startup was 72 ms and parent interaction during child work was 15.4 ms;
- [x] Windows 2.0.0 installer (105,152,689 bytes) and portable executable (104,777,958 bytes) were rebuilt,
  all four SHA-256 checksums verified, and the portable renderer reached ready in 7,414 ms with five
  stable processes.

## 2026-08-12 BattleSpirits transport storm and token-boundary repair

Live evidence from `G:\Baiduyun\BattleSpirits\BattleSpirits\translation_extract\txt` exposed a
provider-outage feedback loop rather than slow translation. Two representative child sessions
recorded 823 and 618 assistant errors. Each assignment was written six times because three
prompt-layer transport attempts were nested inside two supervisor assignment attempts. After
exhaustion the same worker claimed the next task, draining more than one hundred queued assignments;
the hidden parent completion then called workflow resume and launched another batch. The stopped run
had 2,015 assistant errors, 33 child sessions, 35.24 MB of Pi JSONL, and about 20.64M total tokens
(5.57M input, 1.18M output, 13.89M cache read). Stop preserved 80 accepted candidate artifacts and
two consecutive post-stop samples showed zero growth.

The error distribution narrowed the initiating failure further. Of 2,015 errors, 2,011 belonged to
three persistent worker sessions while sibling workers kept completing model turns. Each affected
session first recorded `WebSocket closed 1006` or `terminated`; Pi then kept that session on its
sticky SSE fallback, where later requests failed before receiving an HTTP response and were reduced
to `fetch failed` with zero tokens. This rules out a project-wide OAuth, quota, internet, or service
failure, but the old packaged runtime discarded the nested fetch `Error.cause`, so the exact lower
layer (proxy, TLS, socket, or Undici) cannot be reconstructed honestly from that historical run.

Corrected runtime and token boundaries:

- provider transport recovery now uses Pi's native retry event and `Agent.continue()` after one
  user assignment message. Retry exhaustion raises a typed transport failure, stops only that
  persistent worker, and never lets it claim another queued assignment. Other healthy workers may
  continue. Hidden parent completion reports the recoverable pause and cannot auto-resume or launch
  a replacement batch; explicit user continuation resumes only Host-preserved debt;
- Codex child recovery now uses the bounded sequence `WebSocket -> SSE -> WebSocket`: the first
  WebSocket failure still receives Pi's intended SSE fallback, but an SSE `fetch failed` clears the
  sticky fallback and its cached socket before the final native retry. The reset logs the provider,
  model, child session, retry reason, and Pi WebSocket counters. It is restricted to a recorded
  `openai-codex-responses` fallback and cannot mutate other providers or ordinary fetch failures;
- the model catalog is no longer dumped before a typed workflow launch. It is an explicit-override,
  provider/query-filtered paginated tool with a 25-row default and 50-row hard maximum. This removes
  the observed 173,829-byte result that repeated 92,756 characters of catalog text;
- recursive project search skips generated `.translation-workshop/html` history unless the caller
  explicitly addresses that directory. Search defaults to 25 results, caps at 50, and returns a
  centered 240-character match snippet. Project-file reads are offset-paginated at 16K by default
  and 32K maximum. This blocks the observed 480,519-byte old-HTML read and bounds glossary/reference
  inspection without forbidding exact external read-only paths;
- child prompts define project references as on-demand inputs rather than mandatory per-assignment
  reads. Review children are told to use their assigned source/candidate context first and never
  recursively search generated review HTML;
- persistent children that intentionally reset active context between assignments now run threshold
  checks against that active context, not the complete audit JSONL. If one fresh assignment later
  needs Pi compaction, preparation is sliced from the first post-reset Pi entry, so discarded older
  assignments cannot be summarized or reintroduced. The BattleSpirits run had zero compaction
  entries, but its largest failed child had already accumulated about 308,857 estimated persisted
  tokens, close enough to expose this latent boundary error before another retry storm reached the
  355,616-token Luna threshold;
- every Codex child SSE fallback reset now persists its session/provider/model/error/WebSocket
  counters as a `yn_provider_transport_reset` Pi custom entry before clearing transport state. This
  keeps the evidence after Electron console logs disappear without projecting it into model context;
- the provider fetch boundary now captures a bounded, field-whitelisted `Error.cause` chain before
  Pi normalizes it to a short assistant error and persists it as `yn_provider_transport_error` in
  the same Pi JSONL. This preserves Undici codes such as connection timeout/refusal, syscall,
  address, port, and bounded stacks without recording request headers or projecting diagnostics into
  the model context. The historical BattleSpirits run cannot be reconstructed retroactively, but a
  recurrence will retain the missing lower-layer cause.

Why this closes the failure instead of hiding it: transport exhaustion remains visible as a typed
worker failure, accepted artifacts and Host debt remain durable, and no retry layer is allowed to
turn one failed network operation into new assignment ownership. Pagination and search exclusions
bound model-visible data at the Host boundary, so a model cannot accidentally pull an entire model
catalog or historical HTML corpus into one turn.

Regression evidence:

- [x] transport tests prove three provider attempts produce one Pi user assignment, one exhausted
  worker cannot claim task B after failing task A, and parent completion cannot auto-restart;
- [x] fallback tests prove only a Codex `fetch failed` with an active WebSocket fallback resets the
  transport; the first `1006`, other providers, and non-fallback fetch errors remain untouched;
- [x] model-catalog tests prove a 1,000-model catalog returns 25 rows under 10 KB with working
  provider/query pagination;
- [x] project-file tests prove recursive history exclusion, explicit centered HTML lookup, bounded
  result counts, and offset-based external-file pagination;
- [x] typecheck and all 133 unit-test files pass;
- [x] full Electron/HTML acceptance passes build, LAN convergence, line-review/proposal flows,
  native Pi streaming, paired tools, structured child replies, provider retry/abort, compaction,
  cold restart, and reports no raw-protocol or duplicate-tool leak. Measured interactive startup was
  63 ms and parent interaction during child work was 30.5 ms;
- [x] the final Windows 2.0.0 installer (105,150,542 bytes) and portable executable (104,775,812
  bytes) were rebuilt, all four SHA-256 checksums verified, and the portable renderer reached ready
  in 7,673 ms with a stable five-process Electron tree.

## 2026-08-11 Parent takeover and proposal transaction closure

Root causes found by the independent final reviewer:

- a persistent translation worker stored only one `parentTakeover` record, so a later rejected
  assignment replaced the earlier exact-line takeover even though both assignments still required
  parent repair;
- aggregate proposal review committed through the Electron Host, but the renderer could keep the
  pre-commit linked-document state in its promise cache. A second proposal for the same line could
  therefore be evaluated against an obsolete revision;
- proposal-apply failure restored a whole snapshot of `state.decisions`, which could erase an
  unrelated LAN or local decision made while the Host transaction was in flight.

Corrected boundaries:

- every worker snapshot now keeps an ordered `parentTakeovers` collection and parent completion
  flattens every exact assignment. An unchanged rejected candidate is handed to the parent
  immediately; changed-but-rejected candidates receive at most three bounded repair cycles before
  the same exact lines are handed to the parent. Neither path restarts a chunk, queue, or workflow;
- each proposal commit carries expected per-line revisions. The main process checks them while
  holding the canonical state-file lock and rejects stale writes before merge. A successful Host
  response must contain one matching canonical result for every request and replaces both the
  cloned target and the cached linked document before another proposal can run;
- proposal decisions are rolled back per changed proposal id and only when the live value still
  equals the failed transaction's value. Concurrent LAN/user decisions survive. Repeated Apply
  clicks share one in-flight Host transaction. The old per-document compatibility fallback was
  removed: aggregate proposal application now requires the atomic Electron Host transaction and
  fails visibly when that contract is unavailable.

Regression evidence:

- [x] persistent-worker coverage proves two assignments can independently enter parent takeover
  without either record being overwritten;
- [x] proposal runtime coverage proves sequential same-line proposals use the first committed
  revision, stale Host revisions are rejected, concurrent decisions survive rollback, and double
  Apply produces one Host call;
- [x] typecheck and all 130 unit-test files pass;
- [x] full Electron/HTML acceptance passes, including serialized cross-file proposal writes,
  canonical desktop/LAN convergence, 58 ms Agent interactivity, 4.4 ms optimistic feedback,
  structured child transcripts, and no raw-protocol or duplicate-tool leakage;
- [x] the same independent reviewer that found the three transaction/takeover defects and the
  non-atomic fallback rechecked the final worktree and returned `PASS` with no P0/P1/P2 finding.
- [x] Windows 2.0.0 installer and portable artifacts were rebuilt, SHA-256 verification passed,
  and the packaged portable executable reached its real renderer with five stable Electron
  processes and the expected `translation-workshop` main window.

## 2026-08-10 Lightweight alignment and bounded review repair

Root causes:

- bounded/local translation repair still required one model-authored `alignmentChecks` object and
  prose reason for every assigned row. That made line-identity validation consume more tokens than
  the repair itself even though the Host only needs the current candidate hash and concrete debt;
- translation review allowed a failure code without a correction note. The same translator could
  therefore receive a label rather than an executable fix, write an unchanged candidate, and enter
  an unbounded translate-review loop. A generic assignment retry could then restart still more work.

Corrected Host/Pi boundary:

- bounded repair now calls the same native `validateAssignedTranslation` tool with one compact
  `misalignedLines` array. An empty array binds success to the current source/candidate hash;
  nonempty entries become exact Host repair debt. There are no per-line pass objects or reasons,
  and a post-validation candidate mutation invalidates the hash as before;
- read-only review failures require an absolute line, canonical machine code, and a short actionable
  repair note. The Host merges same-line failures but never stores reasons for accepted rows;
- each rejected candidate hash is tracked inside the same persistent Pi translation worker. If a
  repair produces the identical candidate and review rejects it again, the assignment stops as
  non-retryable before a third translator/reviewer turn. Changed candidates may be repaired at most
  three times; exhaustion reports the exact latest lines and instructions instead of restarting the
  chunk or full queue;
- live preparation, ordinary folder cold recovery, and applied-reuse cold recovery share the same
  reviewer-evidence boundary. A legacy rejection without canonical `code: actionable note` is
  persisted as pending exact review and sent to the read-only review pool; it can never become a
  generic repair instruction for a translation worker.

Regression evidence:

- [x] red/green lifecycle coverage inspects the actual native Pi child prompt and proves bounded
  repair exposes `misalignedLines`, rejects omitted results, returns reported bad rows to exact debt,
  asks for no pass prose, and emits no `alignmentChecks` schema;
- [x] Host review coverage proves a code without an actionable note cannot create repair debt;
- [x] real supervisor tests prove an unchanged rejected candidate stops after two review submissions,
  a changed candidate gets at most three repair cycles, and neither failure restarts the assignment;
- [x] real ordinary-folder and applied-reuse cold planners prove malformed old reviewer evidence is
  durably reopened as `reviewOnly` with no generic feedback before any worker is dispatched;
- [x] focused translation lifecycle, domain, sparse repair, parent gate, and review-pool tests pass;
- [x] all 129 unit-test files, typecheck, runtime-skill boundary validation, and production build pass;
- [x] full Electron/HTML acceptance passes with 58 ms interactive startup, 4.5 ms optimistic
  feedback, 5.0 ms parent interaction during child work, 397.4 ms popout startup, structured child
  replies, paired tool results, cold recovery, and no raw-protocol or duplicate-tool leakage;
- [x] the same independent reviewer that found the cold-recovery bypass rechecked the final worktree,
  reran focused/full/Electron verification, found no P0/P1/P2 issue, and returned `PASS`.

## 2026-08-10 Aug 7+ runtime, child-memory, and BattleSpirits closure audit

The Aug 7 onward reports and the latest BattleSpirits Pi history were merged into
one deduplicated ledger before changing code. The older architectural repairs
remained present: Pi core owns parent and child turns, Pi JSONL owns transcripts
and compaction, the renderer consumes the Pi-web message contract, Host counts
are `1..N` ceilings unless the current user explicitly supplies an exact count,
and translation chunks pass mechanical validation plus independent review before
their translator can claim more work. The remaining failures were below those
boundaries rather than a return to the legacy runtime.

Observed evidence from the BattleSpirits run:

- 171 source files and 18,420 source lines produced 85 candidate artifacts, with
  14,481 lines still unfinished;
- the parent used about 6.285M input, 1.548M output, and 14.431M cached tokens;
- 183 reviewer submissions contained 85 rejections, while Host tools themselves
  usually completed in 5-25 ms, locating the delay in repeated model turns and
  oversized context rather than filesystem calls;
- six child Pi JSONLs had no compaction and the largest child context reached
  about 95,675 tokens;
- complete translation references were repeated 88 times (about 1.15M
  characters), glossary and character assets were repeatedly re-read, and 217
  validation turns exposed 5,260 line-level alignment explanations that full
  translation children did not need;
- one inspect result was about 36 KB, one run result about 45 KB, and the parent
  retained about 1.2 MB of Pi JSONL plus 450 redundant Host-state deltas.

Completed fixes, with the reason each one closes its issue:

- [x] Child Steer no longer waits synchronously for the child to consume the
  message. `queueSteer` returns an immediate queued acknowledgement, while a
  hidden `subagent.steer_delivery` message records the later consumed/rejected
  outcome. This preserves native Pi queue semantics and keeps the parent/UI
  interactive during a child tool turn.
- [x] Every parent and child runtime now runs Pi's own pre-prompt and post-turn
  threshold compaction using Pi usage calculation, `shouldCompact`, Pi
  `compaction` entries, and `Session.buildContext()`. There is no YN summary
  file or renderer memory path, so a long child cannot bypass the same memory
  contract as its parent. Parent threshold compaction is deferred while any
  child is active and resumes on the next parent turn; overflow compaction stays
  available. This prevents parent compaction from blocking live child work
  without disabling Pi's safety path.
- [x] Persisted Host state carries `YN_RUNTIME_CONTRACT_VERSION = 2`.
  Cold-open migration preserves hash-current failed/misaligned evidence, clears
  stale old aligned verdicts, writes one forced current checkpoint, rejects
  future/backward versions, rejects a later legacy v1 delta after a current v2
  checkpoint, and becomes idempotent after migration. A new app build therefore
  changes runtime behavior without trusting incompatible cold state merely
  because the HTML protocol is current.
- [x] Translation children receive the built-in contract once plus project
  reference paths/availability. Full glossary, character-bible, style, web,
  and prior-stage bodies are read on demand instead of being injected again on
  every assignment. Full workflow validation no longer exposes verbose
  `alignmentChecks`; bounded repair now reports only the exact remaining bad
  line numbers and binds the result to the current candidate hash. Repeated
  repair feedback already present in the Pi transcript is not injected again.
- [x] Invalid optional glossary/character discoveries are rejected item by item
  and returned as structured `rejectedDiscoveries`; a valid line-aligned
  translation is not discarded because one optional asset proposal has an
  invalid category, gender, confidence, or source evidence. The Pi-facing schema
  accepts bounded strings at this optional boundary and the Host normalizer owns
  the enum decision, so one malformed proposal cannot make tool argument parsing
  reject the entire translation artifact before item-level validation runs.
- [x] Prior translation discoveries remain complete in Host state but only a
  maximum of 12 relevant/recent hints are serialized into a later child turn.
  Terms found in that assignment's source range win over recency, and the child
  receives an explicit omitted count. This preserves useful continuity without
  repeatedly copying the full cumulative discovery history into every child.
- [x] A rejected write's structured Pi `toolResult` is the authoritative repair
  evidence. When it already contains `repairIssues` and `requiredBatchLines`,
  the next child prompt references that preceding result rather than serializing
  the same source/candidate counts and issue payload again. This removes the
  duplicate repair context while retaining the exact Host evidence in the Pi
  transcript.
- [x] `inspectTranslationContext`, translation-run, pending-review, and child
  batch results retain exact totals but cap model-visible sample collections at
  12 items with explicit omitted counts. This keeps protocol truth while
  preventing a large folder manifest or assignment queue from being copied
  wholesale into the next model turn.
- [x] Review issue-code spelling variants are canonicalized and same-line
  failures are merged into one bounded repair reason. The Host no longer throws
  because two reviewers describe the same defect differently or sends the same
  line through duplicate retry loops.
- [x] Host-state persistence skips a non-forced append when the serialized state
  hash is unchanged. Real state transitions remain checkpointed, while repeated
  broadcasts cannot inflate the parent JSONL with identical deltas.
- [x] Runtime disposal now aborts the native Pi `Agent` and clears its queues
  before listeners are detached. This closes the reproduced lifecycle leak in
  which a replacement prompt could retire an apparently settled runtime while
  its provider stream still owned a 60-second inactivity timer. The direct
  46-test session-service process now exits normally in about eight seconds
  instead of printing PASS and hanging indefinitely.

Executable evidence for this pass:

- [x] focused compaction, Host-state migration/delta, subagent lifecycle,
  translation repair-plan, domain-tool, and 46-case session-service suites pass;
- [x] all 128 unit-test files pass and the test process exits without an orphan
  provider/runtime;
- [x] typecheck and production build pass;
- [x] full Electron/HTML acceptance passes LAN remote Agent convergence, folder
  tabs and durable line edits, Pi streaming, paired tool results, immediate
  Steer, structured child replies, independent per-chunk review, compaction,
  cold restart, provider settings, and EPUB extracted-TXT binding. It measured
  62 ms interactive startup, 4.3 ms optimistic feedback, 8.1 ms parent
  interaction during child work, and reported no raw-protocol or duplicate-tool
  leak;
- [x] the same independent reviewer that found the five remaining edge cases
  rechecked the final worktree, ran 209 focused assertions plus direct runtime
  probes, found no P0/P1/P2 issue, and returned `PASS`;
- [x] after that PASS, Windows 2.0.0 installer/portable were rebuilt, all four
  release checksums verified, and the fresh portable renderer reached ready in
  7,136 ms with a stable five-process Electron tree and no startup JavaScript
  error.

## 2026-08-10 Host workflow preflight and prompt boundary cleanup

The latest real Pi session exposed two structural causes behind slow, wasteful
workflow starts. Before the first workspace-asset write, the parent made 87
tool calls, including repeated source selection/searches and probes for absent
`.translation-workshop/glossary.json` and `style_guide.md`. At the same time,
the parent system prompt and child references repeated Host scheduling,
coverage, persistence, and validation mechanics; proofread children were even
receiving the complete 24K workflow document instead of a child contract.

Corrected boundary:

- every typed translation/proofread prompt now calls one Host preflight before
  provider/model preparation. It idempotently creates only
  `.translation-workshop`, `AI_translation`, `AI_translation/_workspace`, and
  `report`;
- preflight never creates or overwrites glossary candidates, character bible,
  style guide, or any completed asset. Tests prove all three files remain absent
  on a fresh project and preserve exact user content across repeated preflight;
- `inspectTranslationContext` availability fields are authoritative. Parent and
  child prompts tell the model not to probe paths reported unavailable;
- the parent prompt now carries only model-owned routing, project context,
  semantic decisions, and tool/output boundaries. Host assignment, overlap,
  retry, coverage, persistence, review, and settlement remain executable Host
  contracts rather than prose;
- translation and proofread children read concise dedicated task contracts.
  The proofread contract still defines semantic categories, exact replacement
  requirements, and the real `CODE-unique-suffix` finding ID contract; the tool
  schema enforces the same shape and a non-empty finding regression proves the
  slim prompt can complete a real write;
- representative prompt sizes are now 4,257 characters for the parent, 1,298
  for the translation child template, and 1,657 for the proofread child
  template.

Acceptance evidence:

- [x] focused preflight, session-order, parent prompt, translation child,
  proofread child, domain-tool, and non-empty finding regressions pass;
- [x] `npm test` passes all 126 unit-test files, runtime-skill boundary checks,
  and typecheck;
- [x] final Electron Agent/HTML acceptance passes Pi streaming, paired tools,
  child interaction/replies, shared folder tabs, compaction, LAN convergence,
  and cold restart. It measured 72 ms interactive startup, 3.9 ms optimistic
  feedback, and 8.4 ms parent interaction during child work, with no raw
  protocol leak or duplicate tool card;
- [x] the independent architecture reviewer first found the hidden proofread ID
  contract and asset non-overwrite coverage gap, then returned final `PASS`
  after both were fixed and tested;
- [x] Windows 2.0.0 installer and portable were rebuilt in `release/`, all four
  release checksums verified, and the portable renderer reached ready state in
  6,979 ms with a stable five-process Electron tree.

Release rule: every user-visible Windows product change is finished only after
the 2.0.0 installer and portable executable are rebuilt, checksums are verified,
and the portable binary is launched successfully. Do this proactively unless
the user explicitly says not to package; never wait for another reminder.

## 2026-08-10 Do not materialize an unset HTML child count

- Generated line-review HTML no longer writes the product fallback child count
  into `promptDefaults` or the generated translation/proofreading prompt when
  the project has not explicitly configured `subagentCount` or
  `reviewSubagentCount`.
- The embedded prompt settings fields remain blank until a project setting or
  user input supplies a positive count. Explicit counts still flow through the
  same typed metadata path unchanged.
- The native runtime fallback remains an internal compatibility ceiling for
  legacy or otherwise unconfigured requests; it is not serialized into new
  HTML as if the user selected it.

## 2026-08-10 Typed Workflow Scheduling And Permission Cleanup

This pass addressed the recurring symptom where proofreading, full translation,
and an independent repair appeared to own the same Agent session and rejected
one another. The root causes were structural rather than model behavior:

- child supervisors could be started before the Host had durably reserved the
  matching batch, so a failed or duplicate launch could leave Host and runtime
  state disagreeing;
- one active domain contract was reused across translation and proofreading,
  while stopped workflows were guarded by a tool-name blacklist. That made the
  availability of a valid operation depend on which wrapper tool happened to be
  called instead of what document/range it was allowed to read or mutate;
- bounded repairs could enter the full translation queue, where project worker
  settings and whole-workflow debt replaced the user's exact local objective;
- workflow asset requirements could be inferred from prompt wording, allowing
  prose changes to alter Host completion rules;
- persistent proofread workers repeatedly re-injected unchanged glossary,
  character-bible, and style references into later assignments.
- an ordinary parent turn sent while background children were running was
  classified as a new local scope, which retired the live supervisor and made
  the parent appear to stop managing its workers;
- `resumeYnWorkflow` replaced the session's domain contract, but Host tools had
  captured a shallow copy of the pre-resume context and therefore kept reading
  stale suspended state;
- repeated HTML opens attached the same Electron `BrowserView` during both load
  and activation, accumulating owner-window listeners until Electron emitted a
  `MaxListenersExceededWarning`.

Corrected product boundary and completed TODO:

- [x] reserve every specialized or general child batch in the Host, persist it,
  then start the supervisor; launch failure rolls the exact reservation back;
- [x] reject duplicate active batches before creating child runtimes;
- [x] keep complete-workflow exact worker counts scoped to the specialized
  translation/proofread pool. A later investigation or bounded repair uses the
  useful task count for that operation and never inherits an old turn's exact
  lane count;
- [x] keep prompt-defined task count separate from live worker count:
  `runSubagents` preserves every concrete queued task while limiting concurrent
  children to the configured project `1..N` ceiling. A zero workflow ceiling
  remains a preference rather than a Host permission blacklist;
- [x] park incomplete translation/proofread contracts by typed workflow kind,
  restore the matching snapshot on a later switch, and retire stale child
  completion generations so an old child cannot wake the new workflow;
- [x] remove the suspended-workflow tool-name blacklist from the product path.
  Read-only inspection remains available, exact bounded repair is governed by
  document/range ownership, and complete-workflow mutation requires an active
  matching typed contract;
- [x] keep full translation on `runTranslationSubagents`, exact parallel repair
  on `runSubagents(mode=translation_repair)`, and trivial exact repair on the
  parent `writeTranslationChunk`; no local route can restart the complete queue;
- [x] give parent and child repair the same exact document/range ownership,
  including valid local files omitted from a complete folder manifest;
- [x] carry glossary-candidate and character-bible requirements as typed request
  metadata and snapshots; prompt regexes cannot grant or remove requirements;
- [x] require every translation assignment to pass Host mechanical validation
  and read-only review, return rejection to the same persistent translator for
  exact repair/re-review, and only then release its next assignment;
- [x] cache proofread reference context per persistent worker using path,
  metadata, and SHA content identity; changed references invalidate the cache;
- [x] keep failed scheduling attempts out of Host progress accounting so a loop
  that repeatedly fails the same batch is reported instead of appearing active.
- [x] keep the same typed domain run and child supervisor alive for ordinary
  parent interaction while background children run; the parent remains
  interactive without adopting a new turn's unrelated worker ceiling;
- [x] give all Host tools one shared mutable interface context, so a successful
  Resume immediately exposes the restored contract to every subsequent tool;
- [x] load HTML tabs detached and attach a `BrowserView` only when the active tab
  actually changes. Electron acceptance now fails on any
  `MaxListenersExceededWarning`.

Verification evidence before release packaging:

- [x] focused atomicity, suspension-scope, local-ownership, typed-requirement,
  workflow-transition, cold-restart lifecycle, translation-review-gate, and
  proofread-reference-cache regressions pass;
- [x] Pi JSONL reopen preserves a parked translation contract and its exact
  pending debt without putting Host state into the model transcript;
- [x] `npm run typecheck` passes;
- [x] all 126 unit-test files pass;
- [x] Electron Agent/HTML acceptance passes native Pi streaming, paired tool
  results, per-chunk review, parent interaction during child work, structured
  child replies, Stop/cold restart, shared popout state, and no raw protocol or
  duplicate tool leakage. Measured startup was 68 ms, optimistic feedback
  5.5 ms, and parent interaction during child work 8.4 ms. The final rerun
  after the final lifecycle fixes measured 59 ms startup, 3.8 ms optimistic
  feedback, and 9.2 ms parent interaction during child work. The full Electron
  suite also passes LAN desktop/mobile convergence, proposal replacement,
  folder rapid-edit synchronization, cold restart, and the listener-leak guard.
  The release-candidate rerun after independent review measured 70 ms startup,
  5.9 ms optimistic feedback, 8.0 ms parent interaction during child work, and
  again reported `rawProtocolLeak=false` and `duplicateToolBubble=false`;
- [x] the same independent architecture reviewer returned PASS after confirming
  task-count/worker-count separation, Pi-only runtime boundaries, typed
  switching, atomic batch reservation, translation review gating, proofread
  replacement, and the BrowserView listener fix;
- [x] rebuilt Windows 2.0.0 installer and portable, regenerated and verified
  `SHA256SUMS.txt`, then launched the packaged portable successfully. The
  packaged renderer became ready in 6,953 ms with a stable five-process
  Electron tree; in-app Agent initialization remained 70 ms in the production
  Electron acceptance run.

## 2026-08-09 P0/P1 Host, Worker, Artifact, And HTML Consistency Hardening

The accepted P0/P1 audit traced the repeated failed-project examples to several
competing authorities rather than to Pi or pi-web themselves: reusable output
was allowed to enter staging as if it were current work; configuration ceilings
were promoted to exact child counts; historical range length became semantic
review debt; parent JSONL and child cards retained oversized repeated payloads;
and generated HTML could fall back to an embedded prompt after durable project
prompt generation failed. LAN edits also mutated the shared in-memory document
before the canonical desktop HTML/sidecar write had succeeded.

Corrected product boundaries:

- formal output and worker staging are isolated. A blank staging candidate
  starts ordinary translation, while only meaningful hash-current partial work
  may enter sparse repair. Failed attempts cannot become the next run's input;
- project child counts remain `1..N` ceilings. Only a number explicitly stated
  by the user in the current instruction is exact. Translation assignment count
  is independent from live translation/review worker count;
- the Host owns one sparse repair debt contract. Translation chunks pass
  mechanical validation, focused read-only review, and same-worker exact-line
  repair before another assignment is claimed. Final completion performs one
  whole-artifact mechanical scan rather than serial parent re-review;
- placeholder, copied-source, repeated-candidate, abnormal-length, protected
  token, and local semantic-boundary signals feed compact risk rows and bounded
  deterministic samples. Range size alone never becomes exhaustive semantic
  debt;
- Host progress is persisted as checkpoint plus bounded deltas. Parent child
  cards keep only lightweight state and a child-session reference; full child
  Pi JSONL is loaded only while Reply is expanded and released on collapse;
- workflow resume/switch remains a native Pi conversation action, not a second
  authorization state machine. Provider inactivity and Host/tool failures are
  visible to the parent so the loop can retry or report a recoverable failure;
- project prompt settings, glossary, character bible, style guide, split/order,
  custom preservation regexes, and worker ceilings have one project state. A
  generated project prompt now requires the Electron `buildPrompt` bridge and a
  non-empty result. Missing/rejected generation fails visibly and never falls
  back to stale prompt text embedded in old HTML;
- prompt-settings protocol v34 forces v33 and older line-review HTML through the
  normal on-disk upgrader, so the fail-fast prompt contract reaches existing
  projects rather than only newly generated pages;
- LAN line edits are transactional: a staged state is written through the
  canonical desktop line-review/sidecar path first, then committed to the LAN
  session and broadcast. Persistence failure returns an error and leaves shared
  in-memory state unchanged.
- LAN session replacement is owner-serialized. Stop first closes the session,
  drains its active durable commit, rejects queued stale commits, and only then
  lets a replacement become visible. A WebContents owner gets one lifetime
  destruction handler before Start performs its first await; owner liveness is
  checked inside the registration lock before `sessions.set`, so a page closed
  during document loading or old-tail drain cannot leave an orphan session.
- Line-review Start/Stop transitions reject edits and Restore before touching
  DOM-backed state or revision history. Debounced patch rejection is observed
  and reported rather than becoming an unhandled Promise rejection.

Focused evidence completed before the final acceptance pass:

- [x] project asset/state, line-review synchronization, folder TXT writeback,
  legacy upgrade, embedded-route, native Pi architecture, runtime-skill
  boundary, prompt bridge failure, and LAN transaction regressions pass;
- [x] typecheck passes after the v34 HTML upgrade and LAN transaction changes;
- [x] all 115 unit-test files, runtime-skill boundary checks, typecheck, and the
  production build pass after the final LAN owner-destruction concurrency test;
- [x] the complete Electron suite passes native Pi streaming, paired tool
  results, subagent interaction/replies, folder and EPUB bindings, prompt
  settings, compaction, cold restart, LAN desktop/mobile convergence, durable
  proposal decisions, and legacy HTML upgrades. The final run reached the
  embedded Agent in 46 ms, optimistic feedback in 9.5 ms, and parent interaction
  during child work in 11.3 ms, with no raw protocol leak or duplicate tool card;
- [x] a real configured `openai-chatgpt` / `gpt-5.4-mini` Electron run through
  proxy port 3067 completed ordinary streaming, a two-child validated
  translation, visible child replies, parent interaction while children ran,
  and a bounded one-line child repair. The first UI response was optimistic in
  12 ms and the final artifact passed Host validation;
- [x] the same independent review Agent found the LAN tail/Stop/listener races,
  reviewed each repair and its executable concurrency regression, then returned
  final `PASS` with no P0/P1/P2 finding;
- [x] Windows 2.0.0 was rebuilt in `release-final/`. Release verification checked
  the 105,138,315-byte installer, 104,763,584-byte portable executable,
  updater/parser metadata, packaged runtime boundaries, and SHA-256 checksums.
  The fresh portable executable launched for real, reached its renderer in
  6,986 ms, and remained stable with five Electron processes;
- [!] repository Git metadata still points at the missing external worktree
  directory `G:/YN-translation-workshop/.git/worktrees/YN-translation-workshop-agent`,
  so `git status --short` and `git diff --check` cannot run in this checkout.
  This is an existing workspace-metadata failure, not a source diff failure; do
  not reconstruct or reset it implicitly.

## 2026-08-05 Pi read tools resolve logical source ids through the Host binding

The real EPUB-derived session exposed `searchProjectText({ path: "_.txt" })`
resolving against the project root and failing with `ENOENT`, even though the
current review page had already bound `_.txt` to extracted UTF-8 text under
`.translation-workshop/extracted-text/...`. The model-visible document id and
the readable filesystem path were being treated as the same value.

- Parent and child Pi read-only tools now share `resolvePiReadablePath` at the
  source-manifest boundary. An exact current `sourceDocumentId`, bound source
  basename, or `folderSourceDocuments` id resolves to its Host-bound real path.
- Unrelated relative paths still resolve from the project root. Absolute paths
  supplied for external references remain unchanged, and no write tool uses
  this resolver.
- The contract is structural rather than an `_.txt` special case: tests cover
  logical ids that differ from the extracted basename and secondary folder
  manifest entries, in addition to the exact reported ENOENT.

Acceptance evidence:

- [x] parent and child regressions reproduce the project-root `_.txt` failure
  before the fix and pass through the shared Host mapping afterward;
- [x] source-manifest tests cover logical id, basename, folder entry, unrelated
  relative path, and external absolute path behavior;
- [x] all 112 unit-test files, typecheck, production build and Electron
  Agent/HTML verification pass.
- [x] independent review returned `PASS`; the 2.0.0 installer and portable
  artifacts were rebuilt in `release-path-resolution`, checksums verified, and
  the portable renderer reached ready state in 6.599 seconds.

## 2026-07-31 Folder proofreading keeps one document and split contract

The real `The Sekimeiya Spun Glass` Pi JSONL exposed two coupled Host bugs.
`tips.txt` had only about 611 lines and therefore only two 500-line tasks, but
the parent reported 44 completed tasks. A rejected `tips.txt -> script.txt`
stage transition had already rebound the local tool request before the domain
run accepted the selection. The Host actually processed the 21,556-line
`script.txt` as 44 tasks while crediting those results to `tips.txt`. A later
turn then hydrated project `splitSize` only as the translation split, so
proofreading fell back to 1000 and planned 22 duplicate script assignments.

- Source selection is now transactional. The domain run validates the stage
  barrier and ownership first; only an accepted selection replaces the bound
  Pi request. A rejection leaves both identities on the previous document.
- Project `splitSize` is the only persisted split setting and hydrates both
  `translationSplitSize` and `proofreadSplitSize` on every Pi prompt. The shared
  default is one exported 1000-line constant used by prompt generation, Host
  planning, system guidance and the startup form.
- Obsolete `reviewMode`, `translationSplitSize` and `proofreadSplitSize`
  project keys are migration input only. When canonical `splitSize` is absent,
  one unique legacy value migrates without loss; conflicting legacy values fail
  visibly instead of silently selecting 1000. Canonical `splitSize` wins when
  already present, and aliases are removed on save.
- Folder child completion snapshots now bind each accepted batch to its
  `documentId` and source line count. Old folder snapshots that cannot prove
  that ownership are invalidated with a visible Host recovery reason; dependent
  proofreading findings/summary completion is invalidated too. This prevents
  the existing 44-result `script.txt` batch from remaining credited to
  `tips.txt` after restart while preserving current correctly bound snapshots.
- Re-sending the same generated workflow in the same Pi session, including
  after a cold process restart, resumes an incomplete matching Host contract
  and proofreading state. `New` remains the explicit clean task boundary.

Acceptance evidence:

- [x] red regressions reproduced both the rejected-selection identity split and
  `splitSize=750` becoming an undefined proofread split, then passed after the
  contract fix;
- [x] project-state regressions prove legacy 500/600 values migrate, canonical
  values win, conflicts fail, and aliases do not survive a save;
- [x] snapshot regressions prove an unbound legacy 44-result folder batch is
  discarded, a current document-bound batch survives restart, and a repeated
  generated workflow restores the same incomplete Pi Host state;
- [x] focused tests, all 99 unit-test files, typecheck, production build and
  `git diff --check` pass.
- [x] Electron Agent/HTML verification passes with 67 ms interactive startup,
  15.0 ms optimistic feedback, native Pi streaming, paired tools, child reply
  loading, compaction and cold-restart recovery; release checksums and the
  packaged 2.0.0 portable launch also pass.
- [x] the independent reviewer first rejected the delete-only alias cleanup and
  unverified legacy completion restore, then returned `PASS` after the migration,
  document-bound snapshot and generated-workflow resume regressions were added.

## 2026-07-31 Proofreading follows the skill's Host/parent/child phases

The latest real `The Sekimeiya Spun Glass` Pi session exposed a phase-order
bug: the parent called `runProofreadSubagents` immediately after a lightweight
context inspection while the Host hid H3/H4/H7/H8/H9 preprocessing inside
child launch. That made the first observable proofreading step look like child
delegation and left no typed proof that deterministic scanning preceded
semantic review.

- `inspectTranslationContext({ workflow: "proofread" })` now aligns the bound
  source/candidate and completes the full deterministic H3/H4/H7/H8/H9 scan
  before any child can start. It returns compact counts, affected lines,
  HOT/WARM/COLD regions and a useful worker recommendation.
- The prescan hash includes source, candidate, audit exclusions, glossary,
  character bible and style inputs. A change invalidates the scan, old semantic
  batch coverage, findings completion and summary completion together; stale
  evidence cannot satisfy the completion gate.
- H3 uses longest-match terminology filtering. H8 is emitted only for a real
  target-language pronoun mismatch; generic character warnings are not
  relabeled as gender errors. Deterministic signals remain evidence for a child
  to confirm or reject, never automatic final findings.
- Split mode partitions the complete aligned range into non-overlapping tasks of
  at most `splitSize` rows. Useful `1..N` persistent Pi workers dynamically
  claim those tasks until the queue is empty; task count and live worker count
  are separate. Every assigned row receives semantic review. Parent-only review
  must prove complete source and translation range reads before findings can be
  written.
- The configured child count is only a concurrency ceiling, so ordinary runs do
  not make smaller chunks merely to fill idle lanes. A count explicitly stated
  by the user in the current turn is exact: the Host may subdivide below
  `splitSize` to create useful assignments, and when indivisible rows are still
  fewer than that count the remaining native Pi worker sessions stay honestly
  queued with no fake line range. Custom worker labels remain identical in
  cards, supervisor inspection and the parent completion event.
- Each persistent worker retries its current failed assignment before claiming
  another one. The same child Pi JSONL session and lightweight card are reused
  across assignments; task results are merged by the Host and heavy per-task
  result arrays are released after parent notification.
- Monte Carlo mode uses Host-planned non-repeating HOT/WARM/COLD samples,
  retires regions after 80% semantic coverage, requires the minimum round count
  plus two consecutive clean rounds, and never treats the configured ceiling
  as convergence. At the ceiling the later user turn chooses three more rounds,
  HOT-only split review, or a current-results stop. HOT escalation preserves
  earlier findings and delegates only deterministic HOT-region rows.
- Each child receives the complete packaged proofreading workflow, exact
  assigned aligned rows, boundary context and a required project-reference
  manifest through the native tools `readAssignedProofreadContext`,
  `readProofreadReference` and `writeAssignedFindings`. Cached web references
  are optional. Children cannot modify source, candidate or shared assets; they
  return strict findings and evidence-bound missing proper-term candidates.
- The parent owns phase order, actual worker count, child monitoring, findings
  merge/dedupe, candidate-term decisions, Monte Carlo convergence and final
  report generation. The obsolete child instructions to call
  `writeProofreadFindings`/`completeTask` were removed from the packaged guide.

Acceptance evidence:

- [x] focused regressions cover pre-prescan rejection, asset/candidate
  invalidation, full parent/child semantic coverage, strict findings bindings,
  child candidate return, failed-batch rollback, non-repeating samples, 80%
  retirement, two-clean convergence, max-round user decisions and HOT-only
  escalation without report loss;
- [x] all 99 unit-test files, typecheck, production build and
  `git diff --check` pass;
- [x] Electron Agent/HTML verification passes with 79 ms interactive startup,
  19.6 ms optimistic feedback, native Pi streaming, paired tools, live child
  interaction/replies, compaction and restart recovery, with
  `rawProtocolLeak=false` and `duplicateToolBubble=false`.
- [x] independent final worktree review returned `PASS` after verifying exact
  worker counts above indivisible task counts, honest idle-worker ranges,
  custom-label propagation, retry ownership and completion accounting.

## 2026-07-31 Subagent model override can return to parent inheritance

The generated HTML model selector previously represented `Follow main Agent`
as an empty option, but converted that option to an empty patch object. Project
settings are deliberately merge-written, so the earlier explicit provider and
model keys survived and reappeared when the form was reopened.

- The prompt-settings contract now writes both `subagentProviderId` and
  `subagentModelId` as empty strings when parent inheritance is selected. This
  clears the persisted override without changing the merge semantics used by
  other project-owned settings.
- Prompt-settings protocol v31 upgrades older generated HTML to the corrected
  selector behavior.
- The generated-HTML regression first reproduced the stale-key bug. Electron
  verification now selects a configured child model, observes both keys through
  the project-state bridge, selects `Follow main Agent`, observes both keys
  cleared, reopens the panel, and confirms parent inheritance remains selected.

Acceptance evidence:

- [x] focused legacy/generated-HTML regression passes;
- [x] typecheck and production build pass;
- [x] the complete Electron Agent/HTML suite passes with
  `subagentFollowParentReset=true`, 44 ms interactive readiness, 31.1 ms
  optimistic paint, native Pi child cards/replies, and no raw protocol or
  duplicate tool bubble leak.

## 2026-07-31 Existing-translation audit is an explicit project choice

The resumable translation audit previously activated whenever a meaningful
candidate already existed. That protected work, but made an expensive semantic
audit the implicit default and gave the generated HTML no visible way to choose
a clean retranslation.

- `reuseExistingTranslation` is now one typed project setting from generated
  HTML through the embedded pi-web composer, native AgentSession IPC,
  `PiNativeSessionService`, the Pi system prompt, and YN Host tools. It defaults
  to `false` and is saved in `.translation-workshop/project.json`, so every file
  in one folder project shares the same choice.
- When disabled, a full translation validates the requested parent write or
  worker assignment first, then the Host SHA-256-backs up a meaningful old
  candidate under `.translation-workshop/translation-reuse-backups/`, removes
  it exactly once, and starts clean translation. Workers can never inherit
  stale unselected lines. Bounded repairs do not reset an unrelated candidate.
- When enabled, the existing hash-bound mechanical/semantic audit and one-time
  user reuse decision remain mandatory. Every persisted audit is owned by the
  parent Pi session that prepared it; parent tools, child audit runtimes, and
  cold-restart recovery validate that owner on every read or mutation. A new
  session cannot inherit project-level ambient authorization.
- Candidate cleanup, normal chunk writes, and decision application share the
  same candidate-file lock. Backups are hash-verified before mutation, and a
  corrupt existing backup fails without deleting or changing the candidate.
- Prompt generation waits for the project setting write to complete. A missing
  Electron persistence bridge or a rejected write stays visible in the HTML,
  leaves the settings panel open, and never generates a composer prompt.
- Prompt protocol v30 forces older line-review HTML through regeneration, while
  project-state hydration restores the choice after that upgrade.

Acceptance evidence:

- [x] focused regressions cover default-off prompt/IPC metadata, project-state
  precedence, parent writes, worker startup, enabled-audit protection, and
  restart decision recovery;
- [x] all 97 unit-test files, typecheck, production build, and
  `git diff --check` pass;
- [x] the complete Electron suite proves the switch is visible and initially
  off, submits `reuseExistingTranslation: false`, persists an enabled choice,
  and restores it after a prompt-only legacy HTML upgrade. The same run reached
  interactive state in 78 ms, painted the optimistic user turn in 14.7 ms, and
  retained native Pi streaming, child replies, compaction, cold restart, paired
  tools, `rawProtocolLeak=false`, and `duplicateToolBubble=false`.
- [x] cross-session regressions prove an unrelated ordinary chat cannot read,
  plan, record, discard, or apply another Pi session's audit; Electron also
  proves both missing-bridge and rejected-write paths fail visibly without
  generating a prompt.
- [x] the same independent reviewer that rejected the ambient project restore
  re-reviewed the final owner-bound worktree and returned PASS with no P0/P1/P2
  findings.
- [x] release `2.0.0` was rebuilt after the final PASS. Installer and portable
  artifacts pass dependency/manifest/checksum verification; the portable
  executable reached a stable five-process Electron window with renderer ready
  in 6,947 ms and no main-process startup error.

## 2026-07-30 Translation reuse audit replay and prompt-contract cleanup

The latest real multi-file Pi session failed after the first reuse decision:
applying one file hydrated every other audit's semantic verdict from its JSONL
journal and then serialized those hydrated verdicts back into the base audit
store. The next read replayed the same journal verdict over the copied base
verdict and raised `already has a semantic verdict` for each remaining file.

- The base audit store now owns only deterministic scan state until an audit is
  applied. Non-applied semantic verdicts live only in the append-only journal;
  store writes strip hydrated verdicts instead of creating a second authority.
- Old stores polluted by the former write path migrate exact duplicate
  base/journal verdicts idempotently. Conflicting or repeated final verdicts
  still fail fast, so corruption is not hidden.
- Semantic audit is now a final AI binary decision: `reuse` or `retranslate`.
  Legacy `review` records remain migration input and are pending until AI
  replaces them. No risky line is emitted as a manual-review deliverable.
- Generated translation/proofread prompts now contain typed project settings,
  not repeated Host queue, writer, validator, or completion instructions. The
  Pi system prompt and Host tools are the single owners of those invariants.
  Glossary path, glossary-candidate choice, character-bible choice, language,
  style, source selection, split size, file order, and child ceiling travel as
  typed workflow metadata from HTML through IPC to the Pi session service.
- Audit-whitelisted line IDs now travel through the same typed contract as
  `auditWhitelistLines`; generated prompts contain no whitelist instructions.
  The Host removes those lines from deterministic proofreading signals and
  from both parent and child findings persistence, including findings left by
  an earlier append. HTML protocol v29 auto-upgrades older generated pages.
- Agent message Markdown now uses the pi-web-style `react-markdown` renderer.
  Emphasis such as `**text**` renders structurally while thinking, tool calls,
  tool results, and child cards remain native Pi message blocks.

Acceptance evidence:

- [x] the exact multi-file replay regression proves applying one audit cannot
  duplicate another audit's semantic verdict;
- [x] legacy-review, polluted-store migration, tamper, conflict, restart, and
  binary AI verdict regressions pass;
- [x] all 96 unit-test files, typecheck, and production build pass;
- [x] Electron verification passes with 71 ms interactive startup and 16 ms
  optimistic feedback; typed folder prompts, Markdown emphasis, paired tools,
  two live child replies, popout convergence, compaction, and cold restart are
  verified with `rawProtocolLeak=false` and `duplicateToolBubble=false`.
- [x] the final focused Electron rerun passes with 70 ms interactive startup
  and 17.3 ms optimistic feedback. A real row marker click travels through the
  production HTML, preload, `registerAgentSessionIpc`, Pi session service, and
  the Host `createTools` boundary with the canonical glossary path, explicit
  glossary-candidate/character-bible settings, and `auditWhitelistLines: [1]`;
  the verifier reports `folderTypedMetadataThroughHost=true`.
- [x] the same independent reviewer that rejected the earlier request-capture
  test re-reviewed the final worktree and returned PASS. It confirmed the old
  prompt whitelist helper and legacy renderer/runtime contracts are absent
  from the product path, and that the audit base store and verdict journals no
  longer form competing semantic authorities.
- [x] release `2.0.0` was rebuilt after the final PASS. Installer and portable
  artifacts pass release manifest/dependency/checksum verification; the new
  portable executable launched a stable renderer and main window in the real
  Windows launch smoke test.

## 2026-07-30 Child path contract and runtime-search isolation

The latest real Pi child JSONL from `The Sekimeiya Spun Glass` showed three
avoidable tool failures before useful work began. The child passed an empty
optional `path` to `listProjectDir` and `searchProjectText`; their schemas said
the path was optional, but the Host forwarded the empty string into the strict
required-path guard. After retrying with `.`, project-wide search also scanned
`.translation-workshop/agent/pi-child-sessions`, feeding old Pi transcripts and
large translation payloads back into the active model context.

- Optional list/search paths now have one Host contract: omitted, blank, and
  `.` all mean the project root. Required file paths and external-path security
  remain strict.
- Project list/search/read tools exclude only `.translation-workshop/agent`, so
  Pi parent/child JSONL cannot be discovered or read back into the model while
  project state, glossary, character bible, and style assets remain readable.
- The first managed translation read now returns compact canonical paths and
  availability for the approved glossary, character bible, style guide, and
  workflow glossary candidates. Bounded repair explicitly starts with that
  read and reuses those paths instead of guessing or rediscovering them.
- A proposed requirement that bounded repair must already have a candidate was
  rejected by the full regression suite: a legitimate writable repair child
  may create the first managed candidate. The final fix does not add that
  over-strict Host constraint.

Acceptance evidence:

- [x] path-contract regressions cover blank roots, Pi transcript exclusion, and
  canonical project references, including first-read failure and retry;
- [x] all 91 unit-test files, typecheck, and production build pass;
- [x] Electron Agent/HTML verification passes with 69 ms interactive startup,
  9.7 ms optimistic feedback, paired tool results, two visible child replies,
  terminal convergence, `rawProtocolLeak=false`, and
  `duplicateToolBubble=false`.

## 2026-07-29 Prompt-defined repair children keep managed write ownership

The latest `The Sekimeiya Spun Glass/localization_workspace` parent and child
Pi JSONL proved that the failed `tips.txt` repair was not a read-only generic
child. Both `translation_repair` children received the exact source path,
candidate path, and owned line range, then called the host-confined
`repairAssignedTranslation` writer. The real rejection was the stale source
manifest error `Source document tips.txt is not in this workflow manifest`.
The parent's later claim that ordinary children could not write and required a
full host queue was therefore a false diagnosis of a host invariant failure.

- `translation_repair` is now explicit in both the parent system prompt and the
  `runSubagents` tool contract: it remains write-capable outside a generated
  full workflow and does not require `runTranslationSubagents`.
- A failed managed write remains in the same child Pi session. The host reads
  the latest failed native `toolResult`, sends its exact bounded error back to
  that child, and asks it to correct the same candidate range. It no longer
  fails after one no-progress correction turn; three contract-coaching turns
  and the existing four validation-repair turns remain bounded and observable.
- Terminal failures include the exact latest host rejection. The parent is
  instructed to distinguish tool/output errors from host invariant failures
  and may no longer invent a read-only-child or full-queue explanation.

Acceptance evidence:

- [x] regression proves an ordinary bounded repair writes without a generated
  workflow;
- [x] regression proves an invalid line argument is returned verbatim to the
  same writable child, which corrects and validates the candidate;
- [x] all 89 unit-test files, typecheck, and production build pass;
- [x] Electron verifier passes with 77 ms interactive startup, 12 ms
  optimistic feedback, paired tool results, live child interaction, visible
  child replies, terminal convergence, and no raw protocol leak.
- [x] independent final reviewer PASS after verifying unsuperseded Pi tool
  errors, same-child retry ownership, bounded retry counts, and the full
  `runSubagents` repair integration path;
- [x] 2.0.0 installer and portable artifacts rebuilt, checksums verified, and
  the portable renderer reached a real main window in 6.737 seconds.

## 2026-07-28 Project Parameters And Canonical Workflow Assets

The workbench previously had three competing project contracts: React saved
`.translation-workshop/project.json`, generated line-review HTML kept prompt
parameters in per-page local storage, and glossary/character controls could
point at external or legacy files that the Pi workflow did not necessarily
read. Folder sibling pages therefore diverged, a reopen could restore defaults,
and React autosave could overwrite a newer HTML edit with stale form state.

- `.translation-workshop/project.json` is now the only product path for project
  parameters. Main-process reads and atomic merge-writes are serialized by
  `projectState.ts`; successful patches broadcast the complete state to React,
  line-review HTML, folder children, and popouts. HTML local prompt storage is
  removed. React suppresses autosave for externally received revisions, so an
  older full-form timer cannot overwrite a newer sibling edit.
- Formal project assets are `.translation-workshop/glossary.json`,
  `.translation-workshop/character_bible.md`, and
  `.translation-workshop/style_guide.md`. Legacy `character_bible.json` is only
  a one-time migration input. Generated workspace candidates remain proposals,
  not a second formal asset contract.
- External glossary import copies and validates entries into the canonical
  project glossary. Whole-glossary replacement and single-entry edits use the
  same serialized main-process writer and publish a full asset broadcast, so
  every open file in a folder project updates immediately.
- Language pair, style, work description, split/order settings, and subagent
  configuration are restored from the shared project state and passed through
  the generated Pi workflow metadata. Parent and child Pi runtimes read the
  same formal glossary, Markdown character bible, and style guide enforced by
  host validation.

Acceptance evidence:

- [x] all 89 unit-test files pass;
- [x] typecheck and production build pass;
- [x] Electron project-open verifier proves reopen persistence, live
  cross-window parameter updates, canonical glossary import/edit broadcasts,
  Markdown character parsing, and style-guide loading;
- [x] the measured first interactive line-review surface is 782 ms;
- [x] screenshot: `artifacts/verification/project-state-assets.png`;
- [x] the complete Pi/HTML Electron verifier still reports native Pi events,
  paired tools, live subagents, shared popout state, compaction, and no raw
  protocol leak.

## 2026-07-27 Child-owned bounded source reads and placeholder completion gate

The latest `The Sekimeiya Spun Glass/localization_workspace` child JSONL exposed
two independent host-contract faults behind the `tips.txt` stall and premature
advance to `script.txt`.

- The folder worker used to read each assigned source range in the host and
  embed the complete `sourceBlocks` JSON into the child user prompt. The child
  then called `readAssignedSource({ referencesOnly: true })`. That duplicated
  source payloads in Pi context/JSONL and created a contradictory resume path:
  the repair prompt said not to read, while every write tool required a
  successful reference read. Three rejected repair attempts consumed about
  9 minutes 39 seconds before the child finally satisfied the hidden
  precondition.
- That mixed source-delivery path is removed. The host now sends only immutable
  document identity and line ownership. Every child calls the range-restricted
  native `readAssignedSource` tool itself; that one tool returns its bounded
  source blocks plus the complete built-in translation guide, glossary,
  character bible, style guide, and other project references. The obsolete
  `referencesOnly` schema and host prompt injection no longer exist.
- Resume repair uses the same child-owned read contract before correction. Large
  repair ownership is read in ordered bounded chunks instead of reintroducing a
  host-injected whole-file prompt. Repair follow-ups carry only absolute line
  IDs and validation findings; neither source text nor rejected candidate text
  nor source-derived retained-term hints are serialized into the user prompt.
  Proper-noun decisions are made by the child from the bounded source blocks it
  reads itself.
- Generic placeholder prose is prevented at generation time instead of guessed
  by a target-language keyword heuristic. Every canonical translation child
  task now states that each non-empty output line must be the actual translation
  of its matching source line and forbids progress narration, labels, summaries,
  and generic placeholder prose inside the artifact. The former
  `generic_translation_placeholder` validator was removed because semantic
  token matching produced both false positives and trivial false-negative
  variants. Host validation remains deterministic: line identity/alignment,
  empty lines, placeholders, tags/control codes, and explicit project
  glossary/character/style constraints. Source-language residue remains a
  visible `likely_untranslated` heuristic for proofreading, but it no longer
  blocks translation completion or creates mandatory repair debt. Semantic
  adequacy belongs to the translating model and proofreading workflow, not a
  brittle string list.
- Translation children and host repair turns now use the typed workflow
  `languagePair` directly. No child or repair prompt hard-codes Simplified
  Chinese, so non-Chinese targets such as `en->ja` remain valid product paths.
- Chinese Agent OS localization now covers the session sidebar, run/session
  statistics, thinking/copy/subagent controls, provider form labels, connection
  state, and provider actions through the existing single locale dictionary.
  English and Chinese remain isolated by the renderer locale regression.

Regression coverage includes child-owned source prompt assertions (including
repair prompts with a source-only sentinel and the no-placeholder generation
contract), resume repair ordering, host-bounded large repair, deferred sparse
repair, deterministic validator boundaries, TypeScript, all 85 unit-test files,
and focused Electron Agent UI verification. The final Electron rerun reached interactive state in 62 ms,
optimistic send in 23.3 ms, rendered paired tool results and two child replies,
and reported no
raw protocol leak or duplicate tool bubble.
The final independent architecture reviewer returned PASS after verifying the
dynamic non-Chinese `languagePair` path and the non-blocking
`likely_untranslated` boundary. All 85 unit-test files and TypeScript passed.
Release 2.0.0 was rebuilt; installer/portable checksums verified, and the final
portable smoke reached a stable renderer in 6,658 ms.

## 2026-07-27 Folder Translation Scheduling

The former folder scheduler assigned complete files to persistent workers and
only split a large file inside the worker that owned it. That design caused a
real long tail: workers assigned short files became idle while one worker kept
the large script. It is no longer the product path.

- Folder prompt settings now carry typed `translationSplitSize` and
  `folderTranslationOrder` metadata through the embedded pi-web composer, IPC,
  and native Pi request. The host validates the order against the immutable
  source manifest; the model cannot bypass it with invented tasks.
- The editable order grammar contains one brace group. Files inside braces are
  one parallel stage; filenames before and after it are strict sequential
  stages. New folder reviews list every recursively discovered filename in
  sorted order inside braces by default. Prompt protocol v22 forces old HTML
  through regeneration.
- The host creates non-overlapping work units bounded by the configured split
  size. A fixed pool of persistent Pi child runtimes dynamically claims ready
  units, including units from the same large file. Stage barriers keep later
  files closed until every unit in the current stage settles.
- Candidate writes remain serialized by the existing per-candidate atomic
  write lock. Child results validate their exact ranges; the parent completion
  contract still requires whole-file validation for every manifest document.
- Structured terminology and character discoveries from completed earlier
  units are injected as unapproved consistency hints into later units. The
  parent remains the only owner of final glossary/character-bible merge and
  approval.

Regression coverage includes order parsing/manifest rejection, 20,000-line
chunk planning, dynamic five-worker use of one large file, stage barriers,
folder domain dispatch, IPC metadata, prompt generation, and legacy HTML
upgrade.

## Resume Rule

After context compression, read this file, `AGENTS.md`, the active goal, and the
current worktree before continuing. Do not restart an older patch plan from a
single chat sentence or from an archived Agent Workbench document.

## Non-Negotiable Architecture

YN Agent OS is a slim specialization of Pi and pi-web. It is not a bridge from
the old YN job runtime into a lookalike chat UI.

- Pi is the agent runtime source. Parent and child turns both run through the
  source-adapted `PiSessionAgentRuntime` around the pinned Pi core `Agent`, Pi
  `Session`, and Pi model/provider APIs. There is no YN loop beneath it.
- Pi JSONL sessions are the only transcript persistence format on the product
  path.
- Pi `AgentMessage[]` is the only renderer message contract. Native assistant
  content blocks, thinking blocks, tool calls, paired tool results, and YN
  custom subagent cards are rendered directly.
- pi-web is the frontend source model. The local `piweb` components are
  source-adapted and slimmed for an Electron HTML embed; they are not a second
  legacy transcript renderer.
- YN owns only translation/proofreading system instructions, host tools,
  validators, project assets, and subagent specialization.
- Legacy event, transcript, status, job, approval, and raw JSON dialects are
  not accepted by the product session IPC or renderer.

The rejected architecture included `runProviderJob`, `conversationStore`,
`agentLoop`, `piRuntime`, `waiting_for_human`, `domainApproval`, job status
stores, XML-style host-tool protocols, and renderer adapters that normalized
those formats after the fact. Those modules have been removed from source and
must not be restored.

## Product Path

```text
Embedded line-review HTML or shared popout
  -> React ChatWindow / ChatInput
  -> native agent-session IPC
  -> PiNativeSessionService
  -> PiSessionAgentRuntime -> Pi core Agent prompt / steer / followUp / abort
  -> native Pi runtime event stream
  -> Pi AgentMessage[] and native streamingMessage
  -> pi-web MessageView
```

The embedded dock is the primary product surface. The popout uses the same
workspace session service and live event stream; it is not an independent chat.
Old generated HTML is upgraded by an explicit embed protocol marker and mounts
the same current React surface. Both line-review and proposal-review upgrade
checks read the shared `pi-web-react-embedded-v10` constant. V10 keeps the typed
workflow intent, language-pair, extracted-EPUB, and folder prompt-scope
contracts, and additionally carries the selected `zh-CN` / `en-US` UI locale
through the embedded Agent and shared popout route. It also replaces a preloaded
generated workflow prompt and its typed metadata atomically, so changing the
subagent count cannot leave the old default metadata attached to the composer.
Older HTML, including v9, is forced through regeneration.

## Product-backed Input Commands

The Pi-web slash palette is retained in the source-adapted `ChatInput`. It is
not an entry point for the deleted YN runtime. The idle palette exposes `/btw`,
`/session`, `/copy`, `/model`, `/settings`, and `/new`; `/compact` appears only
when the selected native Pi session has context to compact. An active Pi run
exposes `/stop`, `/steer <message>`, and `/followup <message>` in addition to
progress, session, and copy. Every visible command has a real renderer or
native Pi session action behind it.

`/btw` opens the current native Pi run/session panel with state, phase, selected
model, subagent progress, messages, tokens, cache use, and cost. It does not add
a user or assistant message, write a synthetic transcript entry, or query a
legacy job/status store. Commands are not exposed speculatively: compact now
calls the real native Pi backend, while name, fork, and tree remain omitted
until the product has their real backend semantics.

## Native Session Memory And Compaction

Pi JSONL is the product memory store. Every user, assistant, tool-result, and
displayable custom message is persisted by the same native Pi `Session`; there
is no parallel YN transcript or memory database. Reload and model context are
rebuilt through Pi `Session.buildContext()`.

Long-context compression also stays inside Pi:

- manual `/compact` and the composer compact control call the Pi
  `prepareCompaction`/`compact` implementation through `PiSessionAgentRuntime`;
- Pi writes one native JSONL `compaction` entry containing the summary,
  `firstKeptEntryId`, pre-compaction token estimate, and details;
- the next reload begins with Pi's `compactionSummary` plus the retained recent
  messages selected by `Session.buildContext()`;
- before each accepted prompt, Pi's `shouldCompact` and
  `DEFAULT_COMPACTION_SETTINGS` decide whether threshold compaction must run;
- context use and token savings are projected as session telemetry, not chat
  text or a YN status event.

Compaction uses the currently selected configured provider/model, supports
optional custom summary instructions, and is mutually exclusive with a model
turn or active child batch. Manual compaction rejects while children run;
threshold compaction is deferred so the parent remains conversational. Pi
0.80.6 compaction does not expose an abort signal, so the UI does not show a
fake Stop action while compaction owns the session.

Native memory follow-up evidence:

- native manual-compaction and threshold-before-next-prompt tests both pass;
- renderer reconnect preserves compaction state, result, and context usage;
- final post-review Electron was interactive in 517 ms, exposed controls in
  572 ms, and rendered the optimistic user message in 15.7 ms;
- the Electron UI executed `/compact` through product IPC, reduced the native
  context estimate from 67k to 21k tokens, restored input, displayed 46k saved,
  and persisted exactly one Pi JSONL `compaction` entry;
- `npm test` passed all 34 test files, `npm run package:dir` produced the unpacked
  app with both pinned Pi packages, and the product-source boundary scan returned
  `NO_LEGACY_PRODUCT_TOKENS`;
- evidence screenshot: `artifacts/electron-agent-native-compaction.png`.

## 2026-07-12 Native Memory Lifecycle Review

Native compaction exposed lifecycle races that were not presentation bugs. The
same independent review Agent rejected the first implementation, and every
finding received a deterministic failing regression before product code was
changed:

- each accepted prompt now owns an explicit generation. Stop cancels that
  generation before the Pi runtime abort, and the generation is checked after
  every context/compaction await and immediately before the Pi runtime prompt;
  a model turn cannot start after Stop has already completed;
- every active state transition increments the same sequence namespace as Pi
  runtime events. Prompt, abort, manual/threshold compaction, and terminal
  snapshots can no longer reuse an equal sequence during reconnect;
- renderer optimistic ownership ends as soon as native state reports running,
  compacting, provider error, or compaction error. A failed threshold
  compaction cannot leave a fake running/Stop state or block terminal reload;
- replacement runtime commit rebases from the live previous generation after
  all awaited preparation. This closes the reproduced `idle 18 -> running 18`
  race where previous final context accounting completed during preparation;
- the no-limit regression scans every Pi-native product source and starts three
  simultaneous YN workflows. All six real child runtimes must enter a provider
  barrier before release, directly proving that the removed process-wide limit
  did not return. Exactly two ranges remains a per-workflow translation and
  proofreading artifact rule, not a product concurrency ceiling.

The same independent review Agent returned exactly `PASS` after those fixes.
Fresh post-review gates then passed on the same worktree:

- `npm test`: all 34 test files passed, including 20 native session lifecycle
  cases, native manual/threshold compaction, renderer convergence, and the
  six-child concurrency barrier;
- Electron product-path verification: interactive in 517 ms, controls ready in
  572 ms, optimistic feedback in 15.7 ms, and queued Steer visible during two
  child runtimes in 92.9 ms;
- Electron verified native live events, paired tools, two child cards/models/
  replies, shared dock/popout state, session deletion, terminal convergence,
  dynamic GPT-5.6 catalog, and native Pi compaction from 67k to 21k context;
- `npm run package:dir` passed; the ASAR contains the pinned
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and main bundle;
- the product-source boundary scan returned `NO_LEGACY_PRODUCT_TOKENS`;
- `git diff --check` passed.

## Runtime Source Of Truth

- `src/main/agent/piNative/sessionAgentRuntime.ts`: source-adapted Pi core
  `Agent` runtime shared by parent and children; native custom messages,
  prompt/steer/follow-up/abort, Pi queue semantics, and Pi compaction.
- `src/main/agent/piNative/sessionService.ts`: Electron/session lifecycle owner;
  event sequence, terminal convergence, child completion wake, and reconnect state.
- `src/main/agent/piNative/sessionRepository.ts`: Pi `JsonlSessionRepo` and
  `NodeExecutionEnv`; direct `AgentMessage[]` loading and real disk deletion.
- `src/main/agent/piNative/providerRegistry.ts`: Pi `Models`, configured OAuth
  and API providers, every available configured model, and project proxy config.
- `src/main/ipc/agentSessionHandlers.ts`: the sole product session IPC surface.
- `src/shared/agent/piSessionContract.ts`: transport metadata around native Pi
  messages and events. `PiSessionRuntimeEvent` is an alias of Pi's imported
  event union; it does not define another transcript format.
- `src/renderer/agent/piweb/useAgentSession.ts`: native event/state reducer,
  optimistic user insertion, session ownership, terminal convergence, and live
  reconnect/resume.
- `src/renderer/agent/piweb/MessageView.tsx`: source-adapted pi-web rendering for
  text, collapsed thinking, tool call/result pairing, usage, token speed, copy,
  timestamps, and custom subagent cards.

Native `queue_update` is preserved exactly as three Pi message arrays: steer,
follow-up, and next-turn. Main state, reconnect snapshots, and renderer state do
not reduce them to counts. A foreground domain tool still has native Pi
foreground semantics, so the parent model resumes after the tool returns, but
the composer remains interactive: an accepted Steer/Follow-up is visible at
once, survives reconnect, and is inserted into the Pi transcript when the
Pi runtime consumes it. The UI also states how many parallel children the parent
is waiting for instead of appearing frozen.

The small `pi-session-ui.json` active-session pointer is written by serialized
temp-file replacement. Direct concurrent truncating writes caused a real
Electron bootstrap parse race (`Unexpected end of JSON input`) and are banned.
Bootstrap selects a valid fallback in memory and no longer performs a stale
write-back that can race session creation.

`settled` and the terminal state snapshot can arrive in either order. Both enter
the same idempotent terminal convergence path keyed by session and sequence,
then reload the same Pi JSONL messages. A transcript reload may never overwrite
another session or reorder the optimistic user message.

## YN Domain Layer

Native Pi tools are created in `ynDomainTools.ts`:

- inspect translation context and available project assets;
- list configured models across providers;
- read exact source/translation line ranges;
- list/read/search domain-safe project files and translation memory;
- write only allowed workflow files;
- strictly validate and atomically write translation chunks;
- validate the complete translation artifact;
- validate and write normalized proofreading findings;
- launch the request-scoped number of real child Pi runtimes for a single-file
  translation/proofreading shard batch, or the same number of stable logical
  Pi workers for a folder queue.

For a selected file with at least two lines, the host accepts the configured
request-scoped batch only when its type matches the active workflow and its
sorted ranges are contiguous from line 1 through the final source line, with no
gap or overlap. The default is two children. A one-line document has an explicit
parent-only policy:
the parent must write in the current run and then validate the translation, or
write the findings directly, instead of inventing two overlapping shards. Each
child has restricted range tools,
validates its artifact, retries invalid output, and publishes one structured
custom card whose state changes from running to closed. The card is collapsed
by default and can filter the parent prompt and child reply. The parent still
performs final whole-document translation validation. A host completion
contract prevents workflows from settling before their requested assets,
correct two-child batch (when shardable), findings artifact, or final
validation succeeds; incomplete work continues through bounded native Pi
follow-up rather than a legacy status/job state.

Every child defaults to the parent turn's provider and model when its task omits
an override. The parent may call `listAvailableModels` and choose a configured
lighter model for a bounded simple shard, but it may not invent a model ID.
Each card identifies its actual model and exposes the terminal child reply.
Child toolsets cannot delegate again. The product does not impose a fixed
process-wide child-runtime concurrency ceiling. Each YN translation/proofread
workflow still requires exactly two concurrent ranges as its domain contract;
that workflow shape is independent of product-wide resource scheduling.

`@gotgenes/pi-subagents` 18.0.1 was evaluated rather than blindly installed.
Its useful lifecycle/background ideas were reviewed, but its public package is
an extension for `@earendil-works/pi-coding-agent` and Pi TUI. Pulling those
generic TUI/extension surfaces into this direct Electron Pi core runtime would violate
the slim Pi-native boundary. YN therefore source-adapts only the relevant Pi
semantics above and keeps translation artifacts transactional.

Workflow intent is not guessed with natural-language regular expressions.
Generated workshop prompts carry typed `workflowIntent` metadata through the
embed, composer, preload IPC, and main request. For free-form conversation, the
model semantically chooses `translation`, `proofread`, or `inspect_only` in the
native `inspectTranslationContext` tool call. The host activates and locks the
contract to that type; a proofreading batch cannot satisfy a translation run,
or vice versa. Conceptual questions remain ordinary Pi conversation.

Generated prompts also contain `Workflow: yn-translation-v1` or
`Workflow: yn-proofread-v1`. These are human/model-visible versions of the YN
domain prompt contract, not model versions and not the runtime source of truth.
The typed `workflowIntent` carried through native session IPC is authoritative.
There is currently no v2; a v2 label is reserved for a future incompatible
domain prompt/artifact contract.

Existing proofreading reports are appendable only when their document ID and
resolved source/translation paths match the current request. A same-content
file at another path cannot inherit an unrelated report.

The model interprets user intent semantically through the system prompt and
native tool descriptions. There is no separate `domainApproval` or
`wait_for_human` state machine. If clarification is needed, the assistant asks
in normal conversation and the next user turn is ordinary Pi context.

## Provider And Packaging Rules

- Provider settings may configure multiple providers at once. The composer
  model picker lists every available model from every configured provider.
- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are exactly pinned
  together at `0.80.6`. The renderer has no GPT model table: provider discovery
  reads the installed Pi catalog. The controlled 0.80.6 upgrade adds selectable
  `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra` where the configured Pi
  provider exposes them, and adds Pi's `max` thinking level.
- ChatGPT/Codex OAuth uses Pi OAuth storage and local credentials; API providers
  use their configured keys/base URLs.
- Proxy configuration comes from project/user config or environment. Tests may
  use the user's `127.0.0.1:3067` proxy through environment variables; no product
  code hard-codes a proxy port.
- `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` must remain
  external in the main esbuild bundle. Pi OAuth loads provider modules with
  runtime dynamic imports, so the packaged application must retain those
  packages in `app.asar`.

## Acceptance Evidence

Deterministic native-runtime Electron verification:

- embedded interactive: 160 ms;
- optimistic user message: 10.0 ms;
- Pi-web slash palette, exact command execution, model picker, local `/btw`
  progress, system clipboard `/copy`, `/new`, and `/settings` all passed;
- live collapsed thinking, token speed, Stop, paired tools, two concurrent
  subagent cards, host completion repair, terminal convergence, session
  isolation, physical JSONL deletion, inactive-session deletion without active
  transcript loss, non-destructive provider errors, hidden internal custom
  messages, dock/popout controls, and raw-protocol absence all passed;
- the verifier deliberately delays `settled` so the state-before-event race is
  exercised, sends the generated translation prompt through product IPC with
  typed translation intent and the exact bound translation path, and invokes
  the real YN domain tool with two real child runtimes instead of injecting
  custom cards.

Real provider runtime verification with GPT-5.4 Mini:

- prompt accepted: 8.3 ms; first runtime event: 8.9 ms;
- first assistant delta: 14951.0 ms; chat completed in 17493.3 ms with 9 live
  message updates;
- translation used two real child runtimes, produced four aligned lines, and
  passed final validation in 137319.5 ms while creating the requested glossary
  and character bible;
- proofreading used two real child runtimes and produced four strict,
  host-validated JSON findings in 109816.8 ms.

Real embedded Electron verification with GPT-5.4 Mini:

- embedded interactive: 533.3 ms;
- optimistic user message: 45.0 ms and Stop visible immediately;
- first structured thinking: 14106.7 ms (provider first-token latency);
- token-speed badge followed 12009.3 ms later and the user's scroll position
  stayed protected during the live turn;
- normal completion: 32278.2 ms, input restored, Stop removed, one clean new
  session, no prior history, and no raw protocol.

One preceding unchanged final run received only Pi event sequence 1 through 7
and then the upstream OAuth/provider stream stopped after its first empty
thinking delta. The UI had already inserted the user message in 49.4 ms, shown
Stop, and displayed the structured thinking block. The exact same binary and
command then completed normally with the measurements above. No renderer or
runtime fallback was added to conceal this observable upstream stall.

Packaging verification:

- final `npm run package:dir` passed after the input and host-contract cleanup;
- `app.asar` contains `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`, and the main bundle;
- `node-pty` and XTerm assets are absent from `app.asar`.

Evidence screenshots:

- `artifacts/electron-agent-real-streaming.png`
- `artifacts/electron-agent-real-complete.png`
- `artifacts/electron-agent-native-commands.png`
- `artifacts/electron-agent-native-progress.png`
- `artifacts/electron-agent-native-streaming.png`
- `artifacts/electron-agent-native-subagents-queued.png`
- `artifacts/electron-agent-native-complete.png`

Native child/queue follow-up verification:

- embedded interactive: 529 ms; first optimistic user message: 7.6 ms;
- two real child runtime cards were simultaneously `running`;
- queued Steer text was visible in 49.7 ms while both children were active,
  remained outside the transcript until native Pi consumed it, then appeared in
  the correct transcript order;
- the parent waiting status, child model labels, collapsed terminal cards,
  default Reply filter, non-empty child replies, queue drain, parent validation,
  terminal completion, and dock/popout shared state all passed;
- the Electron model menu exposed all three GPT-5.6 variants from the Pi 0.80.6
  catalog; no renderer model name was added;
- a Windows automation-session clipboard probe returned empty even for
  `Set-Clipboard/Get-Clipboard`. Product copy IPC now verifies native read-back
  and reports failure rather than claiming success; the verifier separately
  proved that `/copy` sent the exact latest assistant text to native IPC.

Post-upgrade real-provider verification through the user's proxy environment
(`127.0.0.1:3067`, never hard-coded in product/test source):

- GPT-5.4 Mini Electron: interactive 477.6 ms, optimistic user message 44.9 ms,
  first structured thinking 14663.4 ms, token-speed badge 3131.9 ms later,
  normal completion 22414.1 ms, protected user scroll, no old history, and no
  raw protocol;
- native Pi chat: accepted 8.6 ms, first runtime event 9.2 ms, first assistant
  delta 13908.1 ms, completed in 14099.1 ms with 10 updates;
- native Pi translation: two real child runtimes, full host-tool workflow,
  four aligned lines, and final validation passed in 94071.2 ms;
- native Pi proofreading: two real child runtimes and two strict findings were
  written to the validated JSON report in 66503.6 ms.

## 2026-07-12 Native Interaction Convergence

The final child-interaction audit found that the remaining failures were not
renderer presentation bugs. They were ownership races between accepted Pi
input, session transitions, workspace suspension, and persisted active-session
state. The renderer still consumes only native Pi `AgentMessage[]`; no legacy
event, status, job, transcript, or raw JSON contract was reintroduced.

The same independent review Agent first returned FAIL with concrete races, and
each finding received a failing regression test before the implementation was
changed:

- an accepted Steer can no longer disappear when abort and a replacement prompt
  overlap;
- abort-carried `queuedNextTurn` input is visible in the Pi-web composer as
  Steer, Follow-up, or Next turn instead of silently waiting off-screen;
- deleting a session during an abort/replacement-prompt race cannot restore the
  deleted session as the persisted active pointer;
- aborting session A cannot block an accepted Steer for independent session B;
- workspace suspension cannot deadlock a concurrent prompt and later session
  creation;
- mixed Steer/Follow-up inputs with the same timestamp retain service acceptance
  order;
- terminal snapshots with equal or older sequence numbers cannot erase a newer
  optimistic turn.

`PiNativeSessionService` now owns those transitions through one atomic
multi-resource coordinator. Workspace and session resources are reserved in a
stable order before work begins; operations never recursively acquire another
transition lock. Prompt and delete reserve workspace plus the target session,
ordinary input and abort reserve only their target session, and workspace
suspend/dispose reserve the workspace plus the complete captured session set.
This keeps shared state consistent without serializing unrelated live sessions.

The Electron verifier now opens both child cards independently, selects each
Reply view, and requires a distinct non-empty validated child reply. It also
proves that queued Steer text is visible while both native child runtimes are
running. Dead renderer `agentChat*` locale keys were removed so the old dock
vocabulary cannot quietly return through an unused UI namespace.

The same independent review Agent then returned exactly `PASS`. Fresh
post-review gates all passed:

- `npm test`: all 33 test files passed;
- Electron product-path verification: interactive in 457 ms, controls ready in
  505 ms, optimistic user feedback in 8.6 ms, and running-child Steer visible in
  48.1 ms;
- Electron verified two simultaneous child cards, inherited model labels, both
  child replies, exactly-once ordered Steer consumption, parent waiting state,
  completion gate, dynamic GPT-5.6 Pi catalog, physical session deletion, and
  dock/popout shared live state;
- Electron reported no raw protocol leak, duplicate tool bubble, hidden custom
  leak, or terminal transcript corruption;
- `npm run package:dir` passed and produced `release/win-unpacked`;
- `git diff --check` passed;
- the final product-source boundary scan returned
  `NO_LEGACY_PRODUCT_TOKENS` for `wait_for_human`, `domainApproval`, old provider
  jobs/stores/handlers, `eventRef`, `host_tool`, `activeJob`, and `jobId`.

## 2026-07-12 Background Child Runtime Rebase

The current work supersedes the earlier foreground child implementation and
its old final-gate evidence. Parent and child now both use
`PiSessionAgentRuntime` over Pi core `Agent`; the translation/proofread tool
returns immediately after starting exactly two children, so the parent session
can accept an ordinary message while they run.

Child progress is not copied into the parent transcript on every update.
Instead, native child `message_end` events update one transient structured card
per child for live/reconnect state; initial and terminal cards alone are written
to parent Pi JSONL. The card's Reply view renders the complete child Pi
transcript with paired tool results. The parent can inspect or steer a running
child through native tools, and Stop cancels the whole fixed-range batch without
a completion wake or late artifact write.

The missing-Reply report was traced against the user's actual Pi JSONL rather
than treated as a presentation bug. The affected older terminal custom message
contained only `reply: "Done."`; `details.transcript` had never been persisted,
so no renderer could recover the child process honestly. Current terminal cards
persist the complete child-native `AgentMessage[]`. The product regression now
starts two child runtimes, waits for completion, loads the parent JSONL through
`PiNativeSessionService.loadMessages`, and requires both tool calls and paired
tool results in each terminal card. The Electron verifier then calls
`disposeWorkspace` to discard every in-memory card/runtime, reloads the embedded
page, and expands both Reply views from JSONL-only state. This prevents a live
run-state snapshot from making the persistence test pass accidentally.

Fresh deterministic Electron evidence on this path: embedded input was ready in
297 ms, the optimistic user message appeared in 9.2 ms, and the parent answered
in 217.3 ms while both children were still running. After the JSONL-only reload,
both Reply views contained `readAssignedSource`,
`writeAssignedTranslation`, `validateAssignedTranslation`, and the final child
reply. Evidence: `artifacts/electron-agent-native-subagent-replies.png`.

When both children settle, the supervisor first records their host result and
then delivers one hidden Pi custom message. That message starts or queues a
normal parent Pi turn. Deterministic integration tests now prove that translation
cannot report completion before whole-artifact validation, and proofreading
cannot report completion before the merged host-validated findings report is
inspected. Manual compaction rejects while children run; threshold compaction is
deferred so it cannot replace their live supervisor or block parent interaction.

## 2026-07-12 Pi Custom-Message Context Fix

The remaining parent-wake failure was below the UI and below the supervisor.
The hidden `subagent-completion` message was present in Pi JSONL and in the
renderer, but the real provider never received it. `PiSessionAgentRuntime` had
constructed Pi core `Agent` without Pi harness `convertToLlm`; core Agent's
default converter intentionally keeps only user, assistant, and tool-result
roles, so every custom completion message was dropped from model context.

The runtime now imports the pinned Pi harness `convertToLlm` directly from
`@earendil-works/pi-agent-core/node` and passes it to the same core `Agent`
constructor used by parent and child runtimes. No YN converter or renderer
bridge was added. The provider-context regression sends a custom completion
through an idle parent turn and fails unless the second provider request sees
the converted user message. The architecture test also requires the Pi
converter at the Agent construction boundary.

Fresh real evidence on this exact worktree:

- embedded Electron became interactive in 389.9 ms and inserted the optimistic
  user message in 41.2 ms; the first structured thinking block followed the
  provider's 12.85 s first-token latency and token speed updated 2.55 s later;
- two GPT-5.4 Mini child runtimes ran concurrently, the parent answered another
  user turn in 5.39 s while they were active, both terminal Reply views exposed
  their complete native Pi tool/transcript history, and the parent woke to run
  `validateTranslationArtifact`; the four-line workflow completed in 83.62 s;
- native real-provider acceptance completed chat in 14.02 s, two-child
  translation plus final validation in 77.78 s, and two-child proofreading plus
  four host-validated findings in 88.68 s;
- the first native smoke attempt correctly exposed a verifier lifecycle bug:
  it treated the parent's initial post-launch settle as workflow completion and
  then aborted the children during cleanup. The verifier now waits for both Pi
  parent phases and no running child card; product lifecycle code was not
  weakened to satisfy the test;
- all 42 test files passed, deterministic Electron was interactive in 249 ms
  with 9.1 ms optimistic feedback, packaging passed, both product-source and
  built-output legacy scans returned no matches, and `git diff --check` passed.

Independent final review is still required; these results do not close the
active goal by themselves.

## 2026-07-12 Final Native Contract Hardening

The independent pre-final audit found six remaining native-contract defects.
They were fixed below the renderer, with a failing regression for each defect:

- every Pi `Session` mutation now passes through one serialized operation
  chain in `PiSessionAgentRuntime`; external child/custom messages received
  during a model turn wait for its turn boundary, so concurrent appends cannot
  fork the reachable Pi JSONL branch;
- translation completion is bound to `artifactRevision` and
  `validatedArtifactRevision`, not a monotonic validation boolean. Any direct
  write or completed child batch invalidates an earlier whole-artifact check;
- the shared validator now preserves complete backslash engine commands and
  explicit IDs, including `\\C[1]` and `ID=42`, rather than validating only
  their bracket payloads;
- proofreading findings can represent a real omission with
  `currentTranslation: ""`, while a missing field remains invalid;
- Stop discards the cancelled domain contract before the next ordinary turn.
  Aborting an idle inactive runtime does not broadcast it as selected, which
  prevents physical deletion from switching the UI to the deleted session;
- a child card's Reply view now renders the complete child-native transcript,
  including the initial prompt and later steer/repair user messages, native
  assistant blocks, tool calls, paired tool results, and the final reply.

The final deterministic Electron run passed after discarding all in-memory
child state and reloading from Pi JSONL. It was interactive in 137 ms, exposed
controls in 184 ms, inserted the optimistic user message in 9.2 ms, and let the
parent answer in 3.3 ms while both deterministic children were running. Both
collapsed child cards then reopened with distinct complete Reply transcripts;
the run also passed ordered Steer consumption, paired tools, final validation,
new-session isolation, physical deletion, inactive-session deletion, shared
popout state, provider settings, dynamic GPT-5.6 catalog, and Pi compaction.

Fresh real-provider gates used the YN project's saved Provider/OAuth and proxy
configuration rather than a test-only network override:

- embedded Electron with GPT-5.4 Mini: interactive in 406.3 ms, optimistic
  feedback in 40.6 ms, first structured thinking in 13.83 s, token-speed update
  7.38 s later, normal chat completion in 45.67 s, parent reply in 3.58 s while
  two real children remained active, two complete child Reply views, and a
  validated four-line translation in 83.60 s;
- native Pi smoke: chat accepted in 12.3 ms and completed in 14.36 s;
  two-child translation plus final validation completed in 102.82 s; two-child
  proofreading wrote two host-validated findings in 100.78 s;
- `npm test` passed all 42 test files; `npm run package:dir` passed; the ASAR
  contains the pinned Pi core/AI packages and main bundle while excluding
  `node-pty` and XTerm; product-source and built-output legacy scans both found
  no matches; `git diff --check` passed.

The same independent reviewer must still re-audit this exact final worktree and
return exactly `PASS` before P2 or the active goal can be marked complete.

## Current P0 -> P1 -> P2 Checklist

- [x] P0: delete the old runtime/transcript/status/job/provider bridge from the
  compiled product graph and retain Pi JSONL plus Pi `AgentMessage[]` only.
- [x] P0: use the same source-adapted Pi core `Agent` runtime for parent and
  child turns; child toolsets cannot launch another child.
- [x] P0: make child batches background-supervised, keep the parent available,
  preserve full live/terminal child transcript, and support inspect/steer/Stop.
- [x] P0: add deterministic Stop, live transcript, reconnect, no-late-write,
  parent-wake, translation validation, and proofreading report integration tests.
- [x] P1: block manual compaction and defer threshold compaction while a child
  batch owns live state.
- [x] P1: rerun current full unit/type/build/package gates and the product source
  boundary scan on this exact worktree.
- [x] P1: open the actual embedded Electron UI with GPT-5.3 Spark or GPT-5.4
  Mini and capture new evidence for immediate feedback, live thinking/token
  speed, two child replies, parent interaction, completion wake, and terminal
  validation.
- [x] P2: run an independent review agent over the final worktree, fix every
  finding, then rerun all gates and Electron evidence before marking the goal
  complete.

Do not reuse the older PASS paragraph as evidence for this rebase. The active
goal remains open until every unchecked item above is completed on the current
worktree.

## 2026-07-12 Background Ownership Hardening

The next independent audit found three remaining ownership defects below the
renderer. Each defect was reproduced with a failing regression before product
code changed:

- a terminal child-card append could wait for the Pi turn boundary while still
  holding the session transition lock, preventing accepted Steer and Stop from
  reaching that same Pi runtime;
- one child could commit translated bytes and then lose its sibling, while the
  failed batch left a whole-artifact validation from the previous bytes marked
  current;
- a parent resumed by background child completion could broadcast its normal
  runtime state after the user selected another session, and the renderer
  mistook that update for an explicit selection.

Child persistence is now enqueued under the session transition but awaited
outside it whenever the parent is running. This preserves one serialized Pi
JSONL branch without lending the transition lock to a turn-boundary wait; Stop
can abort and flush that boundary, and Steer/Follow-up remain immediately
accepted by the same Pi runtime.

Every successful child `writeTranslationChunk` now advances the owning domain
contract's artifact revision immediately after the atomic write returns. The
revision changes even when the sibling later fails or the batch is aborted
after commit, so validation can authorize only the current bytes.

State broadcasts now carry an explicit `selectionChange` bit. Only native
create/select/delete-fallback operations set it; model, compaction, child, and
background parent lifecycle snapshots do not. Pi-web accepts a mismatched
session state only when that bit is true, while same-session live updates remain
unchanged. This is transport ownership metadata, not a second transcript or
legacy status contract.

The four new regressions pass independently. A first full-suite run also found
a test harness that reused the aborted turn's already-resolved `settled`
promise while asserting the replacement turn. The regression now waits for the
second native Pi `settled`, removing timing-dependent false results without
changing product behavior. Final full gates and the same review Agent's PASS
remain required.

Fresh gates on this ownership-hardened worktree now pass:

- `npm test`: all 42 test files;
- deterministic embedded Electron: interactive in 337 ms, controls in 441 ms,
  optimistic feedback in 9.6 ms, and a parent answer in 233.3 ms while both
  child runtimes remained active; both terminal Reply views passed after a
  JSONL-only reload;
- real embedded Electron with the project's saved GPT-5.4 Mini configuration:
  interactive in 341.4 ms, optimistic feedback in 101.2 ms, first structured
  thinking in 13.07 s, token speed 10.72 s later, parent interaction during two
  live children in 5.26 s, two full child Reply views, and a validated four-line
  translation in 75.23 s;
- native real-provider smoke: chat completed in 8.03 s, two-child translation
  plus whole-artifact validation in 86.03 s, and two-child proofreading with
  two host-validated findings in 87.12 s;
- `npm run package:dir` passed; the ASAR contains Pi core, Pi AI, and the main
  bundle while containing no node-pty/XTerm paths; source and built-output
  legacy scans both returned zero matches; `git diff --check` passed before the
  final review handoff.

The same independent review Agent must still return exactly `PASS` for this
exact worktree. These fresh gates do not close P2 on their own.

## 2026-07-12 Final P2 Review Corrections

The same independent reviewer found three remaining contract defects after the
background-ownership gates. Each was reproduced before changing product code:

- `prepareRuntime` rewrote the persisted active-session pointer for every
  prompt and compaction. A stale window could therefore run session A while the
  visible selection remained B, then make the next bootstrap reopen A.
- Pi core can receive Steer after its final queue poll but before `agent_end`
  settles. The child supervisor still said `running` during later artifact
  validation and terminal-card persistence, so guidance could be reported as
  accepted and then disappear with the child runtime.
- the proofread writer used truthiness for `sourceText`, making it impossible to
  record extraneous target text on a legitimately empty source line.

The active-session pointer is now written only by explicit native
create/select/delete-fallback operations. Prompt and both manual and threshold
compaction open their requested Pi Session without taking selection ownership.
Regressions cover an inactive prompt and an inactive manual compaction, then
bootstrap the workspace to prove the selected session is unchanged.

Supervised child Steer now has a consumption receipt tied to the exact Pi user
message object. The receipt resolves only after native `message_end` has written
that message to the child Pi Session. If guidance arrives after Pi's last poll
but before `agent_end`, the same core `Agent` resumes through its native
`continue()` API and consumes the queue; no YN queue or turn state machine was
introduced. Once the wrapper atomically enters `settling` or `idle`, guidance
is rejected explicitly and `steerSubagent` cannot return a false
`accepted: true`. Tests cover both the final-poll race and the terminal-card
persistence window.

Proofread bound-text validation now distinguishes field presence/type from
non-empty prose. An exact empty `sourceText` and an exact empty
`currentTranslation` are both valid, but a missing field remains invalid.
The regression writes an extraneous-translation finding on an empty source
line, reloads the JSON document, appends another finding, and revalidates both
against the bound files.

All focused regressions and TypeScript currently pass. Full unit, Electron,
real-provider, package, boundary-scan, and same-reviewer gates must be rerun on
this exact worktree before P2 can be checked.

## 2026-07-12 Independent Sibling Failure And Progressive Recovery

Historical Pi JSONL confirmed the user-reported split failure mode: one child
could complete while its sibling failed, and the old batch-level abort signal
then killed otherwise healthy sibling work. A separate fixed two-repair-turn
limit also terminated children that were making measurable validator progress.
Both behaviors were orchestration defects below the renderer, not display
problems.

The supervisor now follows Pi child-runtime ownership: each child settles
independently, while an explicit parent Stop remains the only operation that
aborts the whole batch. A completed sibling therefore remains completed when
the other child fails. The failed batch emits one hidden native Pi completion
message, wakes the parent, invalidates stale whole-artifact authorization, and
allows a new full two-child repair batch. A later successful batch replaces the
older batch as the completion owner; starting a replacement first clears any
older successful authorization so a failed replacement cannot reuse it.

Child repair is now progress-driven rather than turn-count-driven. Translation
continues only while host validation debt strictly decreases. Proofreading
continues only while the set of missing mandatory host steps shrinks. Both fail
fast on objective no-progress, but neither has a small fixed total turn cap.
The parent completion contract uses the same rule through host progress
revisions and rejects repeated identical no-progress completion attempts.

Terminal child cards persist the complete native Pi transcript plus a separate
host-owned `resultSummary`. Reply shows the prompt, thinking, native tool calls,
paired results, steer/repair messages, and final model reply. If a provider
legitimately returns no final assistant text after its tools, the card still
shows the honest host-validated range/result summary rather than the old
uninformative `Done.` placeholder.

New red-capable proof covers a first batch with one completed and one failed
child, parent wake, a second full two-child batch, delayed whole-artifact
validation, and final valid output. Additional regressions require three
progressive translation repairs, three progressive proofreading repairs,
replacement-batch invalidation, and renderer result-summary behavior.

Fresh gates on this exact worktree:

- `npm test`: all 44 test files passed;
- deterministic embedded Electron: interactive in 526 ms, controls in 578 ms,
  optimistic feedback in 10.7 ms, and parent interaction during two children in
  219.7 ms; both terminal Reply views survived a JSONL-only reload;
- real embedded Electron with saved GPT-5.4 Mini configuration: interactive in
  539.4 ms, optimistic feedback in 48.1 ms, first structured thinking after the
  provider's 13.70 s latency, parent interaction during children in 2.60 s,
  two complete child Reply views, and validated translation in 74.78 s;
- native real-provider smoke: chat completed in 13.15 s, two-child translation
  plus final validation in 78.57 s, and two-child proofreading with two
  host-validated findings in 107.06 s;
- `npm run package:dir` passed; ASAR inspection found Pi core, Pi AI, and the
  main bundle, with zero node-pty/XTerm entries;
- both required legacy source/build scans returned zero matches and
  `git diff --check` passed.

The same independent reviewer must still return exactly `PASS` for this exact
worktree before P2 and the active goal can be marked complete.

## 2026-07-12 P2 Contract Closure After Seven-Finding Review

The same independent reviewer then found seven remaining ownership and
artifact-contract defects. They were corrected below the renderer and each
boundary now has executable proof:

- hidden child completion uses a strict native Pi Follow-up consumption
  receipt. If it arrives after Pi's final queue poll, the same core `Agent`
  drains it through `continue()`; if the parent is already settling, the
  service waits for that exact prompt task and starts a native custom-message
  turn. A public `PiNativeSessionService` regression holds the parent at the
  final `agent_end` boundary and proves the provider receives and persists the
  completion exactly once;
- one session owns at most one current child batch, including settlement
  callbacks. A stale batch ID cannot fail or complete after a replacement has
  taken ownership, and replacement may start only after the prior batch fully
  settles;
- the production prompt now names `runTranslationSubagents` and
  `runProofreadSubagents`, permits a complete two-child replacement after a
  settled failure, and forbids overlapping batches. It no longer claims the
  workflow may delegate only once;
- parent recovery progress is objective: translation debt must be a finite,
  non-negative integer and must strictly decrease; repeated artifact writes or
  failed replacement starts do not reset the stall detector. Final validation
  is bound to the current artifact revision and does not depend on a method
  `this` binding;
- translation chunk serialization preserves a logical trailing empty source
  line by emitting the required second terminal newline;
- proofreading resets the canonical findings artifact before a replacement
  batch, tracks every child write as a report revision, and binds success to
  the latest batch and exact report revision. Generic project writes cannot
  bypass the canonical `writeProofreadFindings` path under `report/`;
- a child that legitimately ends after tools without final assistant prose no
  longer receives invented model text. Its native Reply remains honest while
  the separate host-owned result summary reports artifact validation.

The historical split failure is now a first-class integration gate: the first
batch deliberately produces one completed child and one failed child, retains
both terminal states, wakes the parent, launches a complete replacement pair,
and permits final validation only after that replacement succeeds.

Fresh final gates on this exact worktree:

- `npm test`: all 44 test files passed, including 25 native session-service
  races and the one-success/one-failure recovery integration;
- deterministic embedded Electron: interactive in 523 ms, controls in 583 ms,
  optimistic feedback in 15.7 ms, parent response in 206.0 ms while both child
  runtimes were active, two complete JSONL-reloaded Reply views, and no raw
  protocol, hidden custom, duplicate tool, session-history, or terminal-state
  leak;
- real embedded Electron with the saved GPT-5.4 Mini Provider/OAuth/proxy
  configuration: interactive in 512.5 ms, optimistic feedback in 45.4 ms,
  first structured thinking in 12.48 s, live token speed at 12.50 s, parent
  interaction during two real children in 5.36 s, two child Reply views, and a
  host-validated four-line translation in 74.70 s;
- native real-provider Pi smoke: chat in 13.34 s, two-child translation and
  final validation in 70.26 s, and two-child proofreading with two strict
  findings in 138.74 s;
- `npm run package:dir` passed. The ASAR has 83 Pi core paths, 483 Pi AI paths,
  and the main bundle, with zero node-pty or XTerm entries. Source and built
  legacy scans returned zero matches, and `git diff --check` passed.

The same independent reviewer must now inspect this exact post-correction
worktree and return exactly `PASS`; these gates do not replace that final review.

## 2026-07-12 Stop Ownership At Child-Completion Delivery

The final review exposed one native lifecycle race below the renderer. A child
batch could finish while its parent was at Pi's final queue boundary; if the
user pressed Stop after strict Follow-up delivery began but before the parent
turn settled, the rejected delivery retried against the now-idle session and
started a hidden provider turn. The supervisor also ignored Stop once every
child was terminal even though its parent notification was still pending.

The session now owns an explicit child-completion cancellation generation.
Every public Stop and workspace suspend/dispose advances it under the same
session transition that aborts the parent and children. A completion delivery
captures its generation and rechecks it atomically before either queueing a Pi
Follow-up or launching an idle native custom-message turn. A changed generation
ends delivery without persisting the hidden message or invoking the provider.
This is cancellation ownership metadata only; it does not introduce a job,
status, queue, or transcript dialect outside Pi.

`YnSubagentSupervisor.abortAll()` now also marks the session's active batch as
Stop-requested throughout its settlement callback, even when all child records
are already terminal. It reports only genuinely running children and suppresses
the pending parent wake. The service generation remains the authoritative guard
once notification delivery itself has started.

Two red-capable regressions prove both boundaries. The service test holds the
parent at `agent_end`, starts real strict Follow-up delivery, races Stop, and
asserts one provider call plus an unchanged `user -> assistant` Pi transcript.
The supervisor test holds `onSettled` after both native children finish, invokes
Stop, and proves no parent completion notification is emitted. The historical
one-success/one-failure integration was rerun and still preserves the healthy
child, wakes the parent, executes a full two-child replacement, and gates final
success on current whole-artifact validation.

Fresh gates on this exact Stop-hardened worktree:

- `npm test`: all 44 test files passed, including 26 native session-service
  races and 9 child lifecycle cases;
- deterministic embedded Electron: interactive in 584 ms, optimistic feedback
  in 7.3 ms, parent response in 237.0 ms while both children were active, two
  complete Reply views, and no raw protocol, duplicate tool, hidden custom, or
  session-history leak;
- real embedded Electron with the saved GPT-5.4 Mini configuration: interactive
  in 627.5 ms, optimistic feedback in 49.1 ms, structured thinking and live
  token speed, parent interaction during two children in 6.84 s, two Reply
  views, and a host-validated four-line translation in 82.56 s;
- native real-provider Pi smoke: chat in 13.16 s, two-child translation plus
  final validation in 86.08 s, and two-child proofreading with two strict
  findings in 105.19 s;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, the main bundle, and zero node-pty/XTerm entries. Both exact legacy
  scans returned zero matches.

The same independent reviewer must inspect this exact Stop-hardened worktree
and return exactly `PASS` before the active goal can be completed.

## 2026-07-12 Child Omission Is Not A Valid Translation

The same reviewer then found a translation-domain contract mismatch: the
general-purpose validator intentionally reports empty-line displacement as a
warning for import/review UX, while the child runtime treated every
`validation.ok` result as writable and counted only untranslated warnings at
completion. In a multi-line shard, a nonempty source line could therefore be
replaced by `""`, persisted, and reported as host-validated by that child even
though final whole-artifact validation would later block the parent.

Parent and child host paths now share one YN translation artifact policy in
`translationArtifactValidation.ts`. Structural write acceptance rejects
blocking findings and every empty-line displacement before bytes are written.
Completion acceptance additionally requires all YN quality debt to be zero:
untranslated text, glossary/character/style violations, and empty-line
displacement. The general validator remains unchanged for non-Agent import UX.
Progressive repair also remains valid: untranslated intermediate text may be
persisted while its objective quality debt decreases, but it cannot complete.

The native child regression uses a two-line assigned range, repeatedly emits
`["", "二"]` for two nonempty source lines, and proves the child fails without
creating the candidate artifact. This test was red on the reviewed worktree;
the previous one-line variant was correctly rejected by line-count validation
and was replaced with the minimal multi-line reproduction. The progressive
three-repair regression remains green, as does the historical one-success/
one-failure full replacement integration.

Fresh gates on this exact artifact-policy worktree:

- `npm test`: all 44 test files passed; child lifecycle now has 10 cases;
- deterministic embedded Electron: interactive in 410 ms, optimistic feedback
  in 7.2 ms, parent response during two children in 204.1 ms, two complete Reply
  views, and no raw/duplicate/hidden/session leak;
- real embedded Electron with saved GPT-5.4 Mini: interactive in 558.8 ms,
  optimistic feedback in 95.7 ms, live thinking/token speed, parent interaction
  during two children in 2.87 s, two Reply views, and a host-validated four-line
  translation in 64.19 s;
- native real-provider Pi smoke: chat in 5.79 s, two-child translation plus
  final validation in 66.22 s, and two-child proofreading with two findings in
  127.56 s;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, the main bundle, and zero node-pty/XTerm entries. Both exact legacy
  scans again returned zero matches.

The same independent reviewer must inspect this exact artifact-policy
worktree and return exactly `PASS` before the active goal can be completed.

## 2026-07-12 Canonical Parent And Child Validation Context

The independent review found that whole-artifact validation and child shard
validation did not yet read one canonical project rule set. Final validation
could miss source-language residue because the language pair existed only in
prompt prose, and child validation did not enforce the approved glossary,
character names, voice terms, or style forbidden terms. The child prompt also
read obsolete settings/workspace paths instead of the formal project assets.

Workflow metadata now carries typed `workflowIntent` and `languagePair` from
the generated HTML through the source-adapted Pi-web input, renderer session
hook, IPC, and `PiNativeSessionService`. The service rejects an incomplete
workflow request before provider selection or transcript mutation. Parent and
child host tools both build validation options through the same
`translationValidationContext`, which reads the canonical approved glossary,
character bible, voice rules, style rules, and language pair. The child prompt
receives those same formal assets; obsolete settings and proposal files are no
longer presented as authorities. Corrupt formal JSON assets now fail fast
instead of silently disappearing from validation.

Red-capable regressions prove typed language-pair source-residue detection,
the canonical plain `forbidden:` parser, glossary/character/voice/style
enforcement inside child shards, metadata transport through generated HTML,
and service-boundary rejection of missing language metadata. The historical
one-success/one-failure integration remains green: the healthy child survives,
the failed child is visible, the parent wakes, a complete replacement pair
runs, and only the replacement artifact can authorize final completion.

Fresh gates on this exact canonical-validation worktree:

- `npm test`: all 44 test files passed, including the historical
  one-success/one-failure replacement integration and 27 native session-service
  lifecycle cases;
- deterministic embedded Electron: interactive in 455 ms, optimistic feedback
  in 8.7 ms, parent response in 265.0 ms while both children were active, two
  complete JSONL-reloaded Reply views, and no raw protocol, duplicate tool,
  hidden custom, session-history, or terminal-convergence leak;
- real embedded Electron with saved GPT-5.4 Mini: interactive in 367.2 ms,
  optimistic feedback in 8.6 ms, structured thinking and live token speed,
  parent response while two real children were still running in 3.46 s, two
  complete child Reply views, and a host-validated four-line translation in
  90.24 s;
- native real-provider Pi smoke: chat completed in 13.77 s, two-child
  translation plus final validation in 77.67 s, and two-child proofreading with
  two strict findings in 118.69 s;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, the main bundle, and zero node-pty/XTerm entries. Both exact legacy
  source/build scans returned zero matches.

The Electron verifier also exposed two harness-only false negatives rather
than product defects: a failed native `/copy` correctly retained its Pi-web
command text, and Windows keyboard injection required the Electron window to
own foreground focus. The verifier now isolates the failed command before the
next scenario, explicitly focuses Electron before key injection, waits for the
source-adapted Pi-web composer state to commit, and records composer/run
diagnostics if optimistic rendering ever misses its one-second gate.

The same independent reviewer must inspect this exact worktree and return
exactly `PASS` before P2 or the active goal can be marked complete.

## 2026-07-12 Formal Asset Schema Fail-Fast Boundary

The same independent review found one remaining validation fail-open path.
Formal glossary and character-bible files with valid JSON syntax but an invalid
schema could silently lose rules: a non-array `entries`/`characters` value was
treated as empty, malformed items were filtered, and malformed fields could be
coerced or omitted. Parent and child runtimes would then share the same
canonical context, but that context could still be an undetected reduced rule
set.

The formal asset reader now rejects invalid collection shapes, non-object
items, missing or empty required glossary fields, non-string character names,
non-string optional localized names, and voice/alias fields that are not arrays
of non-empty strings. This is an owning persistence/domain boundary fix, not a
renderer filter: invalid formal rules cannot enter either the parent or child
validation context.

Red-capable regressions cover valid JSON with object-valued `entries`, scalar
character items, glossary entries without a target, and scalar character voice
terms. The project-asset suite, typecheck, native domain tools, child lifecycle,
whole-artifact completion, and the historical one-success/one-failure full
replacement integration all pass.

The exact Electron gate also exposed and removed one remaining duplicate host.
The HTML popout used to reload the complete line-review document and only then
load the Pi-web entry; a captured failure reached `dom-ready` after 4.404 s.
`openAgentChatWindow` now always loads the lightweight renderer
`agent-chat-window` route, passes all line-review context through route params,
and subscribes to the same main-process Pi service and JSONL session as the
HTML dock. It is not an independent runtime. Two full deterministic runs made
the dock interactive in 156/62 ms, the popout interactive in 168.4/146.5 ms,
the initial user bubble visible in 12.3/10.3 ms, and the parent user bubble
visible during active children in 247.3/245.7 ms. The popout remained attached
through the complete run, received the same messages live, and the dock kept
working after it closed. `electron-agent-native-popout.png` records the shared
window.

Fresh final gates on this exact worktree:

- `npm test`: all 44 test files passed, including the historical one-success/
  one-failure replacement integration and the popout architecture invariant;
- deterministic embedded Electron passed twice with collapsed thinking, live
  token speed, paired tools, two complete child Reply views, parent interaction
  while both children ran, physical session deletion, native compaction, and no
  raw/duplicate/hidden/history leak;
- real embedded Electron with saved GPT-5.4 Mini: 157.4 ms interactive,
  10.1 ms optimistic feedback, structured thinking after provider latency,
  live token speed, parent response while two real children were active in
  4.24 s, two complete Reply cards, and a host-validated four-line translation
  in 73.49 s;
- native real-provider Pi smoke: chat in 15.59 s, two-child translation plus
  final validation in 85.19 s, and two-child proofreading with four strict
  findings in 198.54 s. One prior proofreading attempt ended in a transient
  provider `fetch failed`; the rerun passed, and the smoke now retains precise
  parent/child model, error, event, tool, and transcript diagnostics instead of
  discarding the failing boundary;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, the main bundle, and zero node-pty/XTerm entries. Source and built
  legacy scans returned zero matches, and `git diff --check` passed.

The same independent reviewer must inspect this exact post-schema/post-popout
worktree and return exactly `PASS` before P2 or the active goal can be marked
complete.

## 2026-07-12 Recovery-Aware Real Provider Acceptance

The retained real-provider Pi JSONL reproduced the user's historical
two-child failure mode directly. In the first translation batch, `shard-1`
completed and host-validated lines 1-2, while `shard-2` wrote structurally
valid lines 3-4 and then terminated with the provider error `fetch failed`.
The failed child remained visible, the parent received the native child
completion wake, and the parent launched a complete replacement batch rather
than silently accepting the healthy half or retrying only the failed range.
Both replacement children completed their exact ranges, after which the parent
ran whole-artifact validation and reported success.

The real-provider smoke verifier previously required exactly one delegation
tool call. That assertion rejected the correct recovery above. Acceptance now
permits sequential replacement batches while keeping the product contract
strict: every batch must contain exactly two child tasks with exact full-range
coverage, and only the final two terminal cards may authorize completion when
both are `completed`, closed, cover the whole document, and retain complete
native Pi transcripts with tool calls and paired results. Deterministic tests
prove a complete replacement is accepted while a one-child retry or incomplete
final coverage is rejected. The historical native failure-recovery integration
also remains green.

Fresh gates on this exact recovery-aware worktree:

- `npm test`: all 45 test files passed, including the real-provider smoke
  contract and the one-success/one-failure full replacement integration;
- deterministic embedded Electron: interactive in 113 ms, optimistic feedback
  in 12.4 ms, parent response in 292.7 ms while two children were active, two
  complete Reply views, shared popout state, native compaction, and no raw,
  duplicate, hidden, or session-history leak;
- real embedded Electron with saved GPT-5.4 Mini: interactive in 204.3 ms,
  optimistic feedback in 23.4 ms, structured thinking and live token speed,
  parent response while two real children were active in 3.405 s, two complete
  child Reply cards, and a host-validated four-line translation in 70.78 s;
- native real-provider Pi smoke: chat in 13.30 s, two-child translation plus
  final validation in 77.16 s, and two-child proofreading with four strict
  findings in 114.51 s;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, the main bundle, and zero node-pty/XTerm entries. Source and built
  legacy scans returned zero matches, and `git diff --check` passed before this
  documentation update.

The same independent reviewer is re-auditing this exact worktree. P2 remains
open until it returns exactly `PASS` and the final whitespace check is rerun.

## 2026-07-13 Final Parent-Wake And Child-Reply Proof

The independent reviewer found two weaknesses in the recovery-aware real
provider verifier. A fixed two-settlement threshold could return after a
replacement batch became terminal but before its final native completion wake
reached the parent. Child Reply validation also accepted any tool call plus any
tool result without proving Pi IDs were paired, the mandatory YN child tool
sequence was retained, or the transcript ended with the child's own assistant
reply.

The smoke now waits on transcript semantics instead of a fixed turn count. A
workflow is terminal only after the last terminal child card is followed by a
new parent assistant reply. Translation additionally requires a successful
`validateTranslationArtifact` call/result pair after that final child batch.
The verifier rejects one-child replacement, incomplete final coverage,
premature idle settlement, mismatched or orphan tool results, missing initial
child prompts, missing mandatory tool sequences, child assistant errors, and
missing final child replies. A delayed-wake deterministic regression proves
the smoke cannot return during the gap between terminal children and the next
parent turn.

The stricter gate exposed one real product defect: a child could finish its
artifact contract with an empty final assistant block. The host correctly did
not invent Reply prose, but the resulting card had no model response. Parent
and child still use the same native Pi runtime; after successful translation
or proofreading artifact completion, an empty child response now triggers one
ordinary native Pi user turn requesting the child's own concise final report.
If that Pi turn is also empty, the child fails visibly instead of publishing a
host-authored substitute. Translation and proofreading regressions prove the
extra user/assistant messages are present in the retained native transcript.

Fresh gates on this exact child-reply worktree:

- `npm test`: all 45 test files passed, including six strict real-smoke
  contract cases and both empty-final-reply native child regressions;
- deterministic Electron: interactive in 333 ms, optimistic feedback in 9.1
  ms, parent response in 226.2 ms while both children were active, two complete
  Reply views, paired tools, shared popout, native compaction, and no raw,
  duplicate, hidden, or history leak;
- real Electron with saved GPT-5.4 Mini: interactive in 199.3 ms, optimistic
  feedback in 11.8 ms, structured thinking and live token speed, parent reply
  during two real children in 4.532 s, two complete Reply cards, and a
  host-validated four-line translation in 72.83 s;
- strict native real-provider smoke: chat in 13.22 s, two-child translation
  plus post-child parent validation in 71.97 s, and two-child proofreading with
  four findings and a post-child parent reply in 146.23 s;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, the main bundle, and zero node-pty/XTerm entries. Source and built
  legacy scans returned zero matches, and `git diff --check` passed before this
  documentation update.

The same independent reviewer must inspect this exact worktree and return
exactly `PASS` before P2 and the active goal can be closed.

## 2026-07-13 Causal Child Wake And Final Artifact Ownership

The final independent audit found that the real-provider verifier still used
the visible child-card array position as completion chronology. Product
session loading intentionally compacts each terminal card into the position of
its earlier running card, so an old parent message from batch launch could
appear after those cards and falsely look like the post-child parent wake. The
verifier now treats the hidden native Pi `subagent-completion` custom message
as the causal boundary. Its exact two child IDs select the final pair, and
parent validation/final prose must occur after that persisted wake. A
red-capable test runs the raw running/terminal messages through the product
`compactSubagentCards` path and proves the old launch reply cannot terminate
polling.

The same audit also found two artifact-completion gaps. Child transcript
acceptance now requires every native Pi tool-call ID to have exactly one
same-name, later, non-error result and rejects missing IDs, duplicates,
orphans, and failed results. More importantly, translation child completion
now owns a host-observed read -> write -> validate progress record. A child
cannot accept a valid shard left by an earlier failed batch without executing
its own mandatory tool sequence. If an empty-Reply completion turn uses its
still-native Pi toolset to mutate the artifact, completion re-reads the current
assigned range and requires that child to have rerun
`validateAssignedTranslation`; stale pre-Reply validation can no longer close
the card or wake the parent as completed.

Fresh gates on this exact worktree:

- `npm test`: all 45 test files passed, including the historical one-success/
  one-failure full-replacement integration, compacted child-wake chronology,
  failed/duplicate tool-result rejection, pre-existing-shard ownership, and
  final-Reply mutation regressions;
- deterministic embedded Electron: 454 ms interactive, 10.8 ms optimistic
  feedback, parent reply in 261.5 ms while both children were active, two
  complete Reply views, paired tools, shared popout, native compaction, and no
  raw, duplicate, hidden, or history leak;
- strict native real-provider GPT-5.4 Mini: chat in 13.50 s, two-child
  translation plus post-child validation in 73.01 s, and two-child
  proofreading with four findings in 184.67 s;
- real embedded Electron: 204.4 ms interactive, 114.8 ms optimistic feedback,
  real thinking and token-speed telemetry, parent reply while two real children
  ran in 5.37 s, two complete Reply cards, and a host-validated four-line
  translation in 44.35 s. One preceding run retained a Pi JSONL showing an
  external provider turn stalled after two successful workspace writes and
  before child delegation; no code or verifier condition was weakened, and the
  unchanged diagnostic rerun passed;
- unpacked packaging passed. ASAR inspection found 83 Pi core paths, 483 Pi AI
  paths, one main bundle, and zero node-pty/XTerm entries. Exact source and
  built legacy scans both returned zero matches.

The same independent reviewer inspected the final exact worktree after every
finding and gate above and returned exactly `PASS`. P2 is complete; the final
whitespace check is the remaining closeout command before the active goal is
marked complete.

## 2026-07-13 Folder Batch And Generated Workspace Assets

Source selection now crosses the renderer, HTML embed, preload IPC, native
session service, and Pi domain tools as the typed `PiSourceSelection` contract.
A folder is no longer presented to Pi as one pseudo-file. The host resolves an
immutable, stable, recursive manifest of supported text-like files, rejects
empty folders, path escapes, symlinks, output/workspace recursion, and output
name collisions, and gives Pi the explicit `selectSourceDocument` tool. Each
document then runs through the same native Pi workflow completion contract:
multi-line documents require exactly two concurrent child runtimes with full
continuous coverage, single-line documents stay with the parent, relative
subdirectories are preserved, and the parent cannot complete the folder run
until every manifest document has a validated artifact.

Generated translation assets are also host-validated rather than inferred by
the renderer. `AI_translation/_workspace/glossary_candidates.json` must be
fatal UTF-8 and match the strict `{ entries: [...] }` schema;
`character_bible.md` must be fatal UTF-8 and non-empty. Valid assets publish one
workspace status through main IPC. The native Electron File menu conditionally
exposes `Open Character Bible`, while the existing glossary field shows a
one-click import only when no external glossary is selected. Import performs a
conflict-checked, deduplicated, atomic merge into the formal
`.translation-workshop/glossary.json`; it is not a visual-only import.

Deterministic coverage includes stable folder manifests, ignored generated
directories, candidate collisions, per-document completion, relative artifact
paths, malformed generated assets, conflict-safe glossary import, and live
workspace status. The actual Electron product accepted a selected source
folder and generated a folder-batch prompt, exposed the native File menu entry,
and performed the real one-click glossary import. Visual evidence is retained
at `artifacts/electron-folder-assets-menu.png`. Final full gates and independent
review are recorded only after they run on this exact worktree.

## 2026-07-13 Folder/Asset Final Audit And EPUB Boundary

The same independent reviewer rejected three successive closeout candidates.
The findings were all owning-boundary defects rather than renderer symptoms:

- a partial legacy review payload could fall back from a missing extracted text
  path to the original binary EPUB path;
- generated v6 HTML would not automatically receive the hardened route because
  its protocol marker still appeared current;
- an explicit `promptSourcePath` or `promptTranslationPath` ending in `.epub`
  could bypass fallback filtering, and direct session IPC could still receive a
  binary source or translation path.

Every finding first received a failing regression. The shared review route now
accepts only non-EPUB prompt/fallback text paths, direct file manifests reject
unsupported file extensions, and the native session IPC rejects binary EPUB
source/translation paths before the Pi service can mutate a session. The shared
HTML protocol introduced that hardening as `pi-web-react-embedded-v7`; the
current v9 protocol retains it and additionally upgrades stale v7/v8 folder-child
routes.

The user's retained Pi JSONL also confirmed the historical child failure mode:
one batch contained a completed shard and a failed sibling, with failures from
both provider `fetch failed` errors and host artifact-quality rejection. The
current native integration preserves the healthy terminal card, publishes the
failed child, wakes the parent through the persisted Pi completion message,
requires a complete two-child replacement batch, and authorizes completion only
after whole-artifact validation. The focused one-success/one-failure integration
passed on the final worktree.

Fresh final deterministic gates on the exact reviewed worktree:

- `npm test`: all 49 test files passed;
- Electron: 137 ms interactive, 16.0 ms optimistic user feedback, live collapsed
  thinking and token speed, parent reply in 246.9 ms while two native Pi child
  runtimes were active, paired tool results, two child models/replies, shared
  popout state, physical session deletion, and native compaction; raw protocol,
  duplicate tool, hidden custom, and history leaks were all false;
- unpacked packaging passed; ASAR retained 83 Pi core paths, 483 Pi AI paths,
  one main bundle, and zero node-pty/XTerm paths;
- the same independent reviewer returned exactly `PASS`.

The current-worktree real GPT-5.4 Mini Electron rerun was requested after these
gates. The user explicitly approved sending the synthetic four-line fixture and
YN system prompt, but the execution policy still denied disclosure of the
private YN product instructions to an external service that is not established
as a trusted internal destination. This is not recorded as a product pass. The
active goal remains blocked until the user runs `npm run verify:electron-agent-real`
locally and provides its complete output, or a policy-approved trusted provider
becomes available.

## 2026-07-13 Folder Child Agent Host And Workbench Tabs

The folder review index embeds each generated line-review document in a local
iframe. The top-level HTML viewer had the Electron preload bridge, but the
child frame did not. The generated entry loader could reach the parent's bridge
well enough to load the Pi-web bundle, while `embedded.tsx` silently skipped its
workshop adapter because the child had no direct `window.workshopHtml`.
`ChatWindow` then failed at the native Pi `AgentSession` boundary and left the
right pane blank. The Electron red test captured the exact state: current v7
dock open, `childWorkshopHtml=false`, `childWorkshop=false`, empty React root,
and `Pi AgentSession bridge is unavailable` in the child console.

The fix remains at the Electron/Pi-web host boundary. A nested embedded host
inherits the complete top-level `window.workshop` contract, not a legacy
runtime or transcript adapter; the old HTML-only mapper remains only as the
direct compatibility fallback. Missing bridges now fail before React render
with an explicit error. The host unmounts its React root on `pagehide`, so
switching folder children executes the normal Pi hook cleanup instead of
leaving parent-preload IPC subscriptions behind.

The folder index no longer calls `window.open`. It resolves the selected child
against the index URL and calls the existing preload `openPath` contract. HTML
targets route through the production `shell:openPath` handler and
`openHtmlWindow` -> `loadHtmlViewerTab`, so the selected review becomes another
tab in the same workbench window. The button says `Open in new tab` /
`\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00`.

The first independent audit rejected the initial closeout for three owning-
boundary gaps. Recursive child migration trusted absolute, parent-traversal,
and symlinked paths; exact marker matching would downgrade a future v2 index;
and the verifier stubbed `shell:openPath` instead of proving the product tab
manager, on-disk migration, and subscription cleanup. Those were not hidden in
the renderer:

- `reviewHtmlUpgrade.ts` is now the single main-side tree migration owner. It
  parses one validated `batchData` contract, resolves every child before any
  write, requires a relative HTML file inside the batch directory, rejects
  missing/non-file/symlinked nodes, and checks canonical containment before
  upgrading the index or any child. Dot and parent path segments are rejected
  even when normalization would remain inside the directory.
- Batch protocol migration is monotonic. Missing/v0 indexes upgrade to v1, v1
  stays unchanged, malformed named markers fail visibly, and v2+ is rejected
  without modifying either the index or referenced children. Named markers are
  classified before `batchData`, so a future schema cannot be mistaken for a
  non-batch page or parsed as v1.
- Every child is read and transformed before the write phase. Changed files
  are staged and committed through one rollback-capable text-file transaction;
  malformed children fail before mutation, a later install failure restores
  every original, and staging is deterministic so no late async write can
  recreate a temporary file after cleanup.
- The Electron gate starts the real production `main.ts`, invokes the real
  preload `openReviewHtml` and `openPath` IPC, opens a markerless index from
  disk, mounts the Pi-web Agent in its first iframe child, switches to the
  second child, and opens that child through the production workbench tab
  manager. The top-level BrowserWindow count remains unchanged while the tab
  count becomes two. Instrumented delegation to the real preload bridge proves
  one `agent-session:event` and one state subscription are each removed exactly
  once during the natural iframe `pagehide`.

Fresh deterministic evidence on the current worktree:

- `npm test`: all 51 test files passed, including path escape, junction,
  no-partial-write, rollback, late-stage cleanup, future-version preservation,
  malformed batch data, and product tree migration cases;
- real production folder Electron: markerless disk migration passed, both
  iframe Agent hosts mounted, pagehide subscription counts were `1/1` and
  `1/1`, and the selected second file opened as a same-window workbench tab;
- deterministic Pi Electron: 116 ms interactive, 9.6 ms optimistic feedback,
  333.6 ms shared popout, paired tools, two child replies, live parent
  interaction, physical session deletion, compaction, and no raw/duplicate/
  hidden/history leak;
- unpacked Windows packaging passed;
- evidence: `artifacts/electron-folder-native-tabs.png`,
  `artifacts/electron-folder-native-tab-agent.png`, and
  `artifacts/electron-agent-native-folder-iframe.png`.

The final GUI gate also exposed an evidence-harness bug rather than a product
blank state. The active production BrowserView had a complete DOM, 616 visible
text characters, a `685x693` Agent root, and a `234x45` composer, but Electron
`capturePage()` returned an empty image or `Current display surface not
available` because Chromium reported the BrowserView document hidden. The
verifier now asserts those live DOM geometry facts and captures the real
Chromium renderer through `Page.captureScreenshot` with `fromSurface: false`.
This removes dependence on Windows desktop-surface allocation without mocking
the product view or its events; both resulting PNGs were visually inspected.

This change adds no YN runtime, transcript, job, status, or provider bridge to
the renderer. The same independent reviewer rejected partial-write, future-
schema, dot-segment, and fail-fast staging defects during successive audits.
After each received a red regression and owning-boundary fix, that reviewer
returned exactly `PASS` on the final implementation. The complete final gates
listed above were rerun on this exact documented worktree.

## 2026-07-14 folder batch translation entry

The folder import regression was not in the Pi runtime. The generated folder
review index carried only per-file child pages, so the user had no visible
folder-level action even though the shared `buildTranslatePrompt` already knew
how to describe a manifest batch. A second migration-specific defect then
removed that prompt again: legacy batch HTML was re-rendered without carrying
its workflow metadata through the main-side migration boundary.

The current boundary is explicit: `renderBatchLineReviewIndexHtml` receives the
typed folder workflow and embeds enough typed route metadata for legacy
migration to reconstruct the same prompt. The visible prompt is generated by
the normal AI-tools controls inside the selected child page, not by a second
large batch-index sidebar.
`upgradeLegacyBatchLineReviewHtmlContent` is the only compatibility conversion;
it parses the existing `batchData.folderAgentRoute`, reconstructs the typed
folder workflow, and never exposes legacy batch JSON as UI state. The child
page keeps file-scoped editing and sync paths while its prompt source is the
folder manifest; no second Agent runtime or transcript path was added.

Red coverage now includes the folder index and legacy migration preserving the
folder prompt, input mode, and advanced split settings. Final verification on
this worktree:

- `npm test`: passed, all 51 test files;
- `npm run typecheck`: passed;
- `git diff --check`: passed (only existing Git ignore warnings);
- `npm run verify:electron-agent-html`: passed in real Electron;
- Electron evidence includes `artifacts/electron-folder-batch-prompt.png` and
  verified folder Agent composer injection, same-window child tab opening,
  Pi native streaming, paired tool blocks, live subagents, shared popout state,
  compaction, session deletion, and no raw protocol leak.

## 2026-07-14 subagent model selector and enable/count restoration

The line-review prompt settings panel had lost the user-facing subagent
controls during the Pi-web migration. The migration rewrite removed the old
`promptSubagent` and `promptSubagentCount` controls while replacing the model
surface, even though the product still needs the user to choose whether child
agents run and how many are requested. The fix restores only those two controls
inside the existing embedded Pi-web prompt settings surface and keeps the
native `Subagent model` selector adjacent to them. Old `parallel`/
`concurrency` knobs are not restored.

The typed native contract now carries `subagentEnabled` and `subagentCount`
from prompt settings through the embedded host and IPC request into the Pi
domain contract. The defaults are enabled with two children for multi-line
files, while disabling them sends the parent Agent through the direct
read/write/validate path. A single-line file remains parent-owned regardless
of the setting. The host validates the selected count and full line coverage;
no old runtime or job state machine was reintroduced.

The selector is populated by the native Pi configured-model registry through
`listAgentConfiguredModels`, so Pi `auth.json`, OAuth, and configured API
credentials use the same source as the runtime. The selected provider/model is
carried as typed workflow metadata through the Pi session request and becomes
the default for native YN child runtimes. A task-level provider-only choice
uses that provider's configured default model, never the parent's model;
model-only task overrides fail visibly because they are ambiguous.

Legacy line-review HTML now upgrades through prompt-settings marker v18. Red
coverage includes metadata propagation, authenticated Pi model discovery,
child model inheritance/overrides, and the real Electron selector screenshot.
Final verification on this worktree: `npm test` passed all 51 test files,
`npm run build` passed, and `npm run verify:electron-agent-html` passed with
`subagentModelsVisible: true`, `subagentRepliesVisible: true`, native Pi
streaming, live parent interaction, and no raw/duplicate tool leaks.

## 2026-07-14 automatic folder-index upgrade

The reported missing folder batch prompt had a precise migration cause: the
folder Agent route was added while the batch HTML protocol marker remained at
v1. Existing v1 indexes were therefore considered current and opened with only
the selected child-file view, so the Agent prompt was incorrectly file-scoped.

Batch review protocol v3 is now the current marker. Opening an older index
through the Electron HTML tab host automatically upgrades it on disk before
rendering. v2 indexes that still contain the obsolete outer prompt sidebar are
also regenerated into the clean one-column index. If a v1 index has no `folderAgentRoute`, the migration reconstructs
the folder source from the validated child file manifest and the output folder
from its `.translation-workshop/html` location. It never substitutes the
selected child file as the batch source and never exposes the legacy manifest
as UI state. New indexes continue to carry the typed folder route directly.

Red coverage includes route-less v1 migration, v2 sidebar removal, folder prompt
reconstruction, future protocol rejection, and the existing folder prompt preservation test.
`node --experimental-strip-types tests/legacy/legacyHtml.test.mjs` (20/20),
the product-tree auto-upgrade test (13/13), `npm run typecheck`, and
`git diff --check` pass on this worktree. Real Electron verification also
passed with folder prompt rendering, folder iframe Agent mounting, and
same-window child tab behavior.

## 2026-07-14 folder AI-tools prompt scope

The folder prompt does not belong in a large outer batch-index sidebar. The
folder index now only owns file selection and same-window child tabs. In folder
mode, each child line-review page keeps its file-scoped editing and validation
paths, while its existing AI-tools prompt actions use the folder as the prompt
source (`promptSourceKind: "folder"`). Translation generation therefore
produces one manifest-wide batch prompt from the normal AI-tools area.

Existing folder children are upgraded through the batch tree migration:
prompt-settings marker v18 and the parent folder route rewrite their prompt
metadata while retaining file-scoped editing paths. Red coverage verifies that
the outer index has no batch prompt sidebar, that a folder child translation
prompt says `Source folder` rather than the child file, and that old children
receive the same scope during automatic upgrade. The Electron screenshot is
`artifacts/electron-folder-batch-prompt.png`.

## 2026-07-14 folder file-level worker queue

The recent folder run exposed a contract mismatch: the generated prompt still
asked the model to call `selectSourceDocument` and create two line shards for
each file, while the host already had the complete source manifest. That left
the parent trying to treat the selected folder as one source and produced the
"cannot select a concrete source file" response before translation began.

The corrected Pi-native boundary is host-owned. In folder mode,
`runTranslationSubagents` may be called without tasks; the host resolves the
manifest first and creates one complete-file assignment per supported document.
Multi-line assignments enter a shared pull queue consumed by exactly the
configured number of persistent Pi workers (or fewer when the manifest is
smaller). A worker owns one real `PiSessionAgentRuntime` and one Pi JSONL
session for the whole batch; the host does not construct a child runtime per
file. For example, 16 multi-line files with a selected count of 5 create 5
actual child runtimes, 5 worker cards, and 16 queued assignments. Each available
worker claims the next file, so one slow file does not strand unrelated work
behind a static partition. Folder documents with a single logical line remain
parent-owned and do not create a child runtime.

Every file assignment is bound to its own source path and candidate path. The
worker processes large files through host-bounded, contiguous ranges of at most
200 lines, using `readAssignedSource`, `writeAssignedTranslation`, and final
coverage validation. It may not read an unbounded large source or write an
empty/partial artifact as completion. Before a persistent worker begins its
next file, it uses Pi core `Agent.reset()` to clear the previous file from the
model context while keeping the same runtime, Pi session, worker identity, and
inspectable JSONL history. Assignment failures, including model resolution and
preflight failures, append the document id to `failedDocumentIds`; a later
successful assignment cannot clear that failure or turn the worker card into a
successful terminal state. Sibling workers continue, but the parent completion
gate remains unsatisfied until every manifest document has a validated
candidate and no worker failed.

Parent and child persistence now both use Pi JSONL. Child sessions live under
the separate `pi-child-sessions` repository so they remain reopenable after a
runtime restart without appearing in the user's parent-session sidebar. When
the parent metadata exists, Pi's `parentSessionPath` links the child JSONL to
its parent. `InMemorySessionRepo` is absent from the product child runner, and
the persistence test reconstructs a new repository instance, reopens the child,
and reads its message context from disk. Deleting a parent session follows Pi's
`parentSessionPath` links and deletes the linked child JSONL files as well, so
hidden child history cannot survive a user-requested real session deletion.

Prompt-settings marker v20 forces existing HTML to regenerate the stale folder
dispatch instructions. Red coverage includes automatic no-task folder
assignment, exact runtime-construction count, shared-queue pull behavior after
a sibling failure, terminal failure retention after later success, native Pi
context reset between assignments, single-line parent ownership, per-file
request binding, bounded large-file chunks, and full-manifest validation.
The Electron upgrade verifier also creates an isolated fixture where the
line-review, embed, and folder protocols are current and only the prompt marker
is v19. It opens that file through the normal product tab path, proves the file
was rewritten to v20, then opens the prompt settings and inserts a five-worker
folder prompt. This prevents another stale marker from making the assertion a
false positive.

The same Electron pass exposed a provider readiness race: the model label could
already be rendered while `handleSend` still read an older empty provider/model
ref. Provider catalog loading now commits React state and the imperative send
ref in one update, so immediate Send cannot falsely report that no model is
configured.

Verification for this change: `node --experimental-strip-types
tests/agent/prompts.test.mjs`, `node --experimental-strip-types
tests/agent/piNativeDomainTools.test.mjs`, `npm run typecheck`, `npm test`
(51/51 files), `npm run build`, `git diff --check`, and the real Electron
`npm run verify:electron-agent-html` all passed. The Electron verifier now
also rejects a folder prompt that asks the model to call
`selectSourceDocument` or imposes the single-file two-child count.

The Electron verifier also directly executes the native folder
`inspectTranslationContext` through the production Pi domain tool factory. It
confirms that a folder manifest is enumerated as `a.txt,b.txt` while the
current request is bound to a concrete first file, so the previous
"bound source path is not a file" failure cannot pass the verifier.

## 2026-07-14 real folder history replay and v8 route upgrade

The retained Pi JSONL was read before changing the product path. It showed the
same failure repeatedly: `inspectTranslationContext` received a folder path as
a file selection, and the following `runTranslationSubagents {tasks: []}` had no
folder manifest to expand. The actual child HTML was then parsed. Its review
data already contained both scopes correctly: `sourceKind: "file"` for line
editing and `promptSourceKind: "folder"` for the Agent. However, its inlined v7
route function still reduced the latter to `sourceKind: "file"`.

The current TypeScript route implementation had already been corrected, but
the embed protocol marker had not changed. Auto-upgrade therefore treated the
stale generated script as current. The root fix is protocol v8: opening the
current batch tree rewrites every v7 child through the current route generator.
No renderer filter, host fallback, or error-string special case was added.

The host folder manifest also exposed one domain-classification issue during
the real replay: the root `character_bible.md` was being treated as a source
document. `sourceManifest.ts` now excludes that YN reference artifact at the
manifest owner. The real folder resolves to the same 16 translation documents
listed by the batch index.

The permanent real-history Electron verifier reads the retained failing JSONL
and reconstructs its exact v7 child-route defect from the actual 16-child batch
tree. Inside Electron, the reconstructed child first resolves the folder as a
file. The verifier then runs the same production `upgradeLegacyReviewHtmlTree`
boundary used by the HTML tab host, reloads the tree, and proves that every
child is v8 and folder-bound. It separately opens the retained on-disk batch and
asserts that its mounted child is already v8 with
`sourceSelection: { kind: "folder", path: <actual folder> }`.

The replay then reuses all 16 actual source files with a temporary output
directory, sends the folder prompt through the embedded Pi-web composer, calls
`runTranslationSubagents {tasks: []}` with a configured count of 5, observes 5
stable native Pi worker cards processing 16 queued file assignments, waits for
all workers to close, and runs whole-manifest host validation. All 16 real
source documents are SHA-256 hashed before and after the run. Success is emitted
only after those hashes match and the temporary output workspace has been
removed and verified absent. The wrapper removes the separate Electron runtime
directory after the Electron process exits.

Measured acceptance on the real retained project:

- actual batch HTML interactive in 320.5 ms;
- optimistic user message in 82.3 ms;
- manifest kind `folder`, 16 documents, no character-bible contamination;
- empty task list expanded by the host to 16 file-bound assignments consumed by
  exactly 5 persistent Pi child runtimes/Pi sessions;
- 5/5 worker cards completed and 16/16 temporary candidates passed final
  validation;
- 16/16 source document hashes remained identical and temporary output cleanup
  was verified before success;
- evidence: `artifacts/electron-agent-real-folder-route.png`,
  `artifacts/electron-agent-real-folder-batch.png`, and
  `artifacts/electron-agent-real-folder-complete.png`.

Final gates on the same worktree:

- [x] the same independent review Agent returned a fresh `PASS` after
  rechecking the actual five-runtime construction boundary, failure retention,
  parent-owned single-line path, child Pi JSONL persistence and deletion, the
  isolated v19-to-v20 normal-UI upgrade, and immediate provider readiness;
- [x] `npm test` passed all 52 test files, including the Pi-native architecture,
  child JSONL persistence, and persistent-worker lifecycle cases;
- [x] `npm run verify:electron-agent-html` passed with 186 ms interactive load,
  10.2 ms optimistic feedback, native Pi events, paired tools, visible child
  replies, parent interaction during children, shared popout state, compaction,
  isolated v19-to-v20 normal-UI upgrade, immediate provider readiness, and no
  raw protocol or duplicate tool leak;
- [x] the real retained-project Electron replay reported
  `nativePiWorkerRuntimes: 5`, `queuedAssignments: 16`, and
  `validatedCandidates: 16`, with all source hashes unchanged and temporary
  output removed;
- [x] `npm run package:dir` produced `release/win-unpacked` with the pinned Pi
  packages;
- [x] the product-source legacy-boundary scan returned no matches and the
  16-case architecture test passed;
- [x] `git diff --check` passed.

## 2026-07-14 Pi child memory and reliability closeout

The retained real-folder incident was read before changing the product path.
The parent Pi JSONL had grown to 6,482,330 bytes because every live and terminal
subagent custom message duplicated the child's complete transcript. The same
child history was therefore retained in its own Pi JSONL, copied repeatedly into
the parent Pi JSONL, loaded into the parent Agent state, transferred to the
renderer, and rendered again inside every card. `ChatWindow` also recomputed
message metadata by rescanning the complete transcript inside its render map.
Those multipliers, rather than Pi core or the five-worker scheduler itself, were
the memory/CPU failure.

The product boundary is now:

- the parent Pi session stores one latest lightweight status card per child;
- child prompts, native Pi messages, tool calls, and paired tool results live
  only in the child's Pi JSONL;
- expanding Reply performs an authorized parent/child ownership check and loads
  that one child JSONL through `agent-session:childMessages`;
- collapsing a card releases its loaded child transcript from renderer state;
- old parent cards containing `details.transcript` are migration input only and
  are compacted out before entering parent Agent state or renderer IPC;
- renderer message metadata is computed once per message-array revision rather
  than by an O(n-squared) scan during rendering.

The retained child Pi JSONL also explained the apparent high failure rate. A
child correctly received a blocking host result after returning 198 or 208
lines for an exact 200-line chunk, then the provider returned `fetch failed`.
The line-count gate was correct and was not weakened. Reliability now comes from
the Pi-native path instead:

- the host, not the model, divides a large file into ordered chunks of at most
  200 lines while preserving one persistent Pi worker/session for the file;
- every chunk must pass its exact line/placeholder/tag gate, followed by final
  whole-file validation;
- only errors classified retryable by Pi AI's
  `isRetryableAssistantError` are retried in the same child session, with bounded
  abortable delays; validation and contract errors remain visible to the model
  for correction and are never disguised as transport success;
- a worker failure remains terminal evidence even if that worker later consumes
  another queued file, and the parent completion gate cannot report success
  until the failed coverage is repaired;
- child queue and parent notification drains now throw an explicit no-progress
  error instead of entering an unbounded hot loop.

Final verification on this boundary:

- [x] all 55 unit-test files passed, including transport retry, host-owned large
  file chunking, sibling failure isolation, replacement coverage, parent
  interaction during child work, Stop, child JSONL persistence, and lightweight
  parent-card projection;
- [x] the standard Electron verifier passed with 121 ms interactive startup,
  15.6 ms optimistic send feedback, 7.5 ms parent interaction during children,
  and two complete child transcripts loaded from Pi JSONL in 5-7 ms after a full
  service/renderer reload;
- [x] the retained 16-file folder replay expanded an empty task request into 16
  file assignments consumed by exactly five persistent Pi workers, completed
  5/5 workers, validated 16/16 candidates, and preserved all 16 source hashes;
- [x] 43 resource samples during that five-worker Electron run measured a 71.3
  ms worst renderer ping, 454.9 MB peak renderer working set, and 1,049.1 MB
  peak total Electron working set;
- [x] the completed controlled parent Pi JSONL was 512,377 bytes and its largest
  child card was 2,045 bytes, with no child transcript embedded in any parent
  card;
- [x] the first Electron resource verifier failed above 1,000 ms renderer
  response, 512 MB absolute renderer working set, 1.5 GB total working set,
  2 MB parent JSONL, or 16 KB per parent child card. The absolute renderer
  working-set gate was later proven invalid by repeated visible-window idle
  controls and was replaced by the attributable private-memory and
  idle-baseline-growth gates documented in the retained-folder closeout below.

### Independent-review corrections on the same closeout

The first review of this closeout returned `FAIL` and exposed three remaining
resource/state defects plus one test gap. They were fixed before final sign-off:

- native Pi compaction now applies `compactSubagentCards()` to the rebuilt
  `Session.buildContext()` just as initialization does, so duplicate legacy
  cards and `details.transcript` cannot re-enter the live parent Agent state;
- assistant tool-duration rendering now looks up only the tool call IDs in that
  assistant message instead of rescanning every tool result for every assistant
  message;
- child transcript component identity includes the selected parent session and
  child session, and a changed child ID invalidates in-flight data, clears the
  transcript, and collapses the card before another ownership-bound load;
- retry tests now prove the complete policy: transient recovery in the same Pi
  child session, exactly two retries maximum, immediate failure for
  non-retryable errors, and AbortSignal interruption during retry backoff.

The post-correction rerun passed all 55 test files, packaging, and both Electron
verifiers. Standard Electron measured 120 ms interactive load, 11.2 ms
optimistic feedback, and 4.1 ms parent interaction during children. The retained
16-file/five-worker replay measured 82.4 ms worst renderer ping, 485.8 MB peak
renderer working set, 1,046.5 MB peak total Electron working set, a 512,377-byte
parent Pi JSONL, and a 2,045-byte largest parent child card; all 16 candidates
validated and all 16 source hashes remained unchanged.

The same independent reviewer then rechecked the corrected compaction, render
complexity, child transcript identity/reset, and retry boundaries and returned
`PASS` with no blocking or high findings.

Completed children now release one further layer of memory: the supervisor
drops the live control closure after worker disposal and clears accumulated
per-assignment result arrays after the parent settlement callback. A later
`inspectSubagent` or UI Reply request reopens the ownership-checked child Pi
JSONL on demand instead of retaining the disposed runtime object graph. The
child JSONL is intentionally not deleted at child completion because it is the
source of the user-visible Reply, host-tool audit trail, and failure diagnosis;
deleting the parent session deletes all linked child JSONLs together.

## 2026-07-15 cold-restart child recovery

The retained project reproduced a process-lifetime bug that the normal Stop
tests did not cover. Five child status cards ended with `status: "running"` in
the parent Pi JSONL, while no Electron process and no `PiSessionAgentRuntime`
still existed. A later cold load treated those persisted cards as live runtime
authority, so the renderer truthfully rendered five running cards and a Stop
button, but Stop had no runtime to abort. This was not a renderer problem and
is not hidden in the UI.

The product boundary is now explicit:

- only child IDs owned by the current in-memory Pi subagent supervisor count as
  live child execution; a prompt/compaction reservation never owns historical
  child cards;
- Pi JSONL child cards are durable transcript evidence, not proof that a
  process survived an application exit;
- on session load, main serializes the transition, excludes child IDs owned by
  that live supervisor, derives one terminal `stopped` card for every remaining
  orphaned running child, and appends it through the same Pi
  `Session.appendMessage` API;
- repeated loads are idempotent because the latest card for that child is
  already terminal;
- renderer and IPC continue to consume only the resulting Pi
  `AgentMessage[]`; there is no renderer filter, fake run state, or legacy
  recovery protocol.

Verification for this failure mode:

- [x] `piNativeRestartRecovery.test.mjs` first failed with a persisted running
  child after a fresh service instance, then passed after native recovery and
  proves exactly one terminal JSONL append across concurrent/repeated
  dock-popout loads plus both `load -> prompt reservation` and
  `prompt reservation -> load` races;
- [x] all 56 unit-test files passed;
- [x] the real Electron verifier now asserts two distinct Electron main process
  IDs: the first seeds the running card and exits, while the second reopens the
  same Pi JSONL and proves the card becomes `stopped`/closed, Stop is absent,
  the composer is immediately enabled, and exactly one terminal entry exists;
- [x] the Electron cold-restart evidence is
  `artifacts/electron-agent-native-restart-recovery.png`;
- [x] `npm run typecheck`, `npm run package:dir`, and the complete Electron
  verifier passed.

The first independent review returned `FAIL`: it reproduced a prompt-reservation
race that could still leave an old child card running, and it rejected the
single-process service reset as insufficient cold-restart evidence. Both
findings were fixed before closeout. The same reviewer reran the original race
and obtained `stopped/stopped`, confirmed the two distinct Electron main
processes over one Pi JSONL, found no remaining P0/P1/P2 issue, and returned
`PASS`.

## 2026-07-15 retained-folder event amplification closeout

The earlier memory closeout removed embedded child transcripts, but it did not
eliminate a second amplification path. A retained 16-file/five-worker Electron
replay still produced 2,249 runtime events, including 2,199 `message_end`
events, and reached 683.9 MB renderer working set. The parent Pi JSONL and the
five collapsed cards were already small, so this was not evidence that five Pi
runtimes were inherently too expensive. The remaining defect was ownership:
every child chunk's internal Pi assistant/tool turn was also projected as a
parent live subagent event. The resource verifier additionally distorted its
own measurements by repeatedly calling `executeJavaScript` from main while the
renderer was under load.

The Pi-native ownership boundary is now stricter:

- each child runtime persists its complete assistant, thinking, tool-call, tool
  result, chunk, validation, and reply history only in that child's Pi JSONL;
- the parent Pi session persists one initial `running` child card and one
  terminal card per worker, with no child transcript embedded;
- the parent receives only bounded live file-assignment status: one
  `translating <documentId>` update and one `validated N/N chunks` update, plus
  exceptional retry/failure evidence;
- closing a child card therefore does not leave chunk transcripts or per-turn
  event arrays resident in the parent renderer; Reply still loads the owned
  child Pi JSONL on demand;
- worker count was not reduced and no product-wide child concurrency ceiling
  was introduced.

The regression test first proved the old product behavior was red: a single
worker persisted four parent cards (`running,running,running,completed`) and
forwarded every chunk start/completion. It now asserts exactly the initial and
terminal persisted cards, no embedded transcript, cards below 16 KB, and only
the two bounded file-level live statuses.

The first independent review of this closeout returned `FAIL` for two remaining
P1 defects. The ordinary single-file translation/proofread child path still
forwarded every internal `message_end` as parent live IPC even though the
persistent folder-worker path no longer did. A new red test reproduced seven
live parent cards from one four-response translation child. Translation and
proofread now share the same owner boundary: internal Pi turns stay in child
JSONL, parent persistence contains only initial/terminal cards, and exceptional
retry/failure status is the only live update.

The review also proved that the resource loop still called the old `waitFor`
helper every 40 ms while sampling. After replacing that with a one-shot
renderer `MutationObserver`, a hidden verifier window still measured a
repeatable 968.8 ms timer delay. That was acceptance-harness throttling, not a
pass: the measured BrowserWindow had `show: false`. The verifier now makes and
asserts the real Agent surface foreground-visible before sampling. It installs
one renderer-local event-loop-lag timer, uses one event-driven terminal signal,
and samples process memory from main with `app.getAppMetrics()`. DOM, heap, and
card state are read once at the end, IPC count/bytes/max-payload are measured at
the broadcast boundary, and the lag gate is 250 ms rather than 1,000 ms.

The same reviewer then returned a second `FAIL` because the original absolute
512 MB renderer working-set gate was unstable. Its own repeated visible-window
runs crossed that line at 516.6, 526.4, and 516.2 MB even though the idle
renderer baselines had also shifted to 378.7, 389.0, and 385.4 MB. Private
growth remained 133.4-135.1 MB and working-set growth remained 130.8-137.9 MB.
Additional local repeats showed the same bounded behavior across lower idle
baselines. This was not accepted by raising the absolute limit. The verifier
now records idle peak private bytes as well as working set, and gates the
attributable task cost:

- renderer private peak below 384 MB;
- renderer working-set growth from the measured idle peak below 192 MB;
- renderer private growth from the measured idle peak below 192 MB;
- total Electron working set below 1.5 GB;
- visible renderer event-loop lag below 250 ms;
- parent Pi JSONL below 2 MB and each parent child card below 16 KB.

Final retained-project measurements after that correction:

- [x] five persistent Pi workers over 16 real files: 102 runtime events, 42
  child custom events, 35.6 ms peak event-loop lag, 329.3 MB renderer private
  peak, 137.7 MB renderer working-set growth, 134.1 MB renderer private growth,
  9.5 MB JS heap, 973.3 MB peak total working set, 65,575-byte parent Pi JSONL,
  2,045-byte largest child card, 39.7 ms optimistic UI feedback, and 16/16
  validated candidates;
- [x] sixteen concurrent Pi workers over the same 16 files: 124 runtime events,
  64 child custom events, 29.0 ms peak event-loop lag, 331.8 MB renderer private
  peak, 139.7 MB renderer working-set growth, 135.3 MB renderer private growth,
  9.5 MB JS heap, 964.5 MB peak total working set, 114,906-byte parent Pi JSONL,
  1,824-byte largest child card, 46.8 ms optimistic UI feedback, and 16/16
  validated candidates;
- [x] both runs preserved every source hash and deleted their temporary output;
- [x] focused ordinary-child, persistent-worker, and event-driven verifier
  regression tests passed;
- [x] `npm test` passed all 58 test files, including the two new owner-boundary
  and event-driven verifier contracts;
- [x] the complete Electron Agent verifier passed with 92 ms interactive load,
  9.6 ms optimistic feedback, 5.8 ms parent interaction during children,
  paired tools, on-demand child JSONL replies, compaction, popout shared state,
  folder tabs, and cold-restart recovery;
- [x] `npm run package:dir` rebuilt `release/win-unpacked`, and
  `git diff --check` passed;
- [x] the same independent reviewer rechecked both corrected P1 ownership
  boundaries, the event-driven verifier, the idle/private memory gates, and
  real five/sixteen-worker runs, then returned `PASS`.

## 2026-07-16 Luna translation long-tail diagnosis

The retained real GPT-5.6 Luna run was measured before changing the product
path. Across five child Pi JSONLs it contained 146 assistant calls and 103
translation writes. Serialized translation arguments were 371,374 characters:
225,319 translation-text characters (60.672%), 28,610 explicit line-identity
characters (7.704%), and 117,445 JSON/envelope characters (31.624%). At the
observed 56.2 output tokens/second, removing all line identity would improve
the five-worker theoretical floor by only about 1.2 seconds. Explicit line
identity therefore remains part of the safe protocol; protocol shaving was
rejected as a solution to the 20-minute long tail.

The retained timestamps instead proved three ownership defects:

- a host repair prompt could complete without appending a fresh assistant
  message, after which `latestAssistantMessage()` reused the previous bulk
  write as if it answered the repair turn;
- after a partial repair, the ordinary validator could accept short Japanese
  or punctuation-only lines while `requiredBatchLines` still contained exact
  unresolved line identities; the outer loop ignored that host debt, cleared
  it, and asked the model to validate too early;
- a failed file assignment was pushed to the shared queue tail, so the first
  file failed near minute one, moved to another worker around minute sixteen,
  and was still translating its final chunk at the 20-minute timeout.

The Pi-native boundary now requires a fresh post-prompt assistant message,
keeps host-required line identities in every repair-plan fingerprint, ends
every successful nonaccepted write turn so the host owns the next repair, and
retries a failed file immediately in its persistent owning worker before that
worker claims another queued file. Three deterministic red tests cover those
exact failures: `piNativeFreshSubagentResponse.test.mjs`,
`piNativePendingRepairOwnership.test.mjs`, and
`piNativeSubagentRetryOwnership.test.mjs`. Existing deferred sparse repair,
bounded host repair, lifecycle, assignment retry, and sibling recovery tests
also remain green.

The final real-provider cycle exposed two additional product-path defects before
closeout. First, structural validity and translation quality had been treated
as one rejection class. A candidate with correct line identity but a small
amount of Japanese residue could therefore lose otherwise valid Chinese work.
The host now rejects only structural corruption. Quality warnings retain the
candidate and return exact absolute line, source text, current candidate text,
validation detail, retained source term, and glossary-candidate action. That
evidence is complete, so the repair turn explicitly forbids rereading the
source and edits only the listed lines; intentional proper nouns are proposed
for the glossary rather than rolled back to Japanese.

Second, sorting files longest-first was insufficient while all workers pulled
from one global tail. The first 22-minute real run assigned 13,530 lines to one
worker while peers settled around 10,000 lines, leaving that worker on the last
file after the others closed. Persistent Pi workers now receive
line-count-weighted LPT reservations and may steal only after exhausting their
own reservation. This retains exactly the configured worker count and whole
file ownership while removing the dynamic long-tail imbalance; it does not
create one child per file or split files across children.

The renderer also had two mutable state authorities: React state showed the
selected provider/model while send read a manually maintained ref. Concurrent
bootstrap and session updates could make the visible model differ from the
model sent to main. `useAgentSession` now uses one synchronous state store for
both rendering and command reads, covered by the provider/bootstrap race test.

Final verification on the completed code:

- [x] all 70 `npm test` files passed;
- [x] `npm run typecheck` and `npm run build` passed;
- [x] the 16-file/five-worker deterministic Electron replay completed 16/16
  host validations with 42.8 ms optimistic feedback, 46.2 ms peak renderer
  response, 375.0 MB peak renderer private memory, 180.2 MB private growth over
  idle, 998.1 MB total Electron working set, 76,387-byte parent Pi JSONL, and
  unchanged source hashes;
- [x] the standard Electron verifier passed on final rerun with 112 ms
  interactive load, 12.5 ms optimistic feedback, 10.0 ms parent interaction during child
  work, paired tools, on-demand child replies, compaction, shared popout state,
  folder tabs, and two-process cold-restart recovery;
- [x] `npm run package:dir` rebuilt `release/win-unpacked`, the product legacy
  token/file boundary scans were clean, and `git diff --check` passed;
- [x] the final 16-file/five-worker real GPT-5.6 Luna Electron run completed
  16/16 host validations in 1,237,778 ms (20m 37.8s), inside the user-approved
  20-minute target plus two-minute hard allowance; the verifier reports the
  37,778 ms target overrun instead of hiding it;
- [x] all five persistent Pi workers completed, all 16 source hashes remained
  unchanged, renderer feedback peaked at 114.9 ms, renderer working set peaked
  at 448.4 MB, total Electron working set peaked at 870.8 MB, the parent Pi
  JSONL was 83,610 bytes, and the largest parent child card was 3,108 bytes;
- [x] the real gate preserved its output and evidence under
  `C:\Users\tgy23\AppData\Local\Temp\yn-real-folder-history-5CGAfk` and wrote
  the route, running-batch, and completed-batch screenshots under `artifacts/`.

## 2026-07-16 version 2.0.0 release packaging and updates

The desktop release version is now `2.0.0`. Windows packaging emits one NSIS
installer, one portable executable, the installer blockmap, `latest.yml`, and
`SHA256SUMS.txt`. `scripts/verify-release-artifacts.mjs` is the release artifact
gate: it verifies the package/ASAR version, GitHub updater metadata, installer
size and SHA-512, all published SHA-256 hashes, packaged updater dependency,
the patched production `js-yaml`, and the absence of development-only verifier
scripts from the ASAR. Only the optional external skill installer remains under
the packaged `scripts/` path.

The packaged app now uses `electron-updater` against GitHub Releases. Installed
NSIS builds can download an update and install it after restart. Portable builds
open the release page for a manual replacement. Startup checks are scheduled
after first paint and never block the workbench; Help exposes a manual update
check and the running version. Update failures are logged under Electron's log
directory. One independent review found that an updater `error` event and the
same rejected promise could produce two dialogs; the controller now assigns one
operation identity to each check/download and reports that failure once. Red
tests cover duplicate download/check errors, silent startup failures, manual
failure notification, portable behavior, and progress clamping.

Final release verification:

- [x] all 71 `npm test` files passed;
- [x] production dependency audit passed with zero known vulnerabilities after
  updating the compatible `js-yaml` transitive dependency to `4.3.0`;
- [x] the final Electron verifier passed with 161 ms interactive load, 8.8 ms
  optimistic feedback, native Pi streaming/tool/subagent behavior, shared
  popout state, compaction, folder batching, and cold-restart recovery;
- [x] the final packaged executable remained alive in a launch smoke test as
  product version `2.0.0`, used about 110.6 MB working set in the hidden smoke,
  and left zero lingering processes after shutdown;
- [x] Windows metadata identifies `TohmaN233` instead of the inherited Electron
  company metadata;
- [ ] public Authenticode signing is not configured, so Windows SmartScreen may
  warn until a trusted code-signing certificate is supplied;
- [ ] the dirty Pi migration worktree has not been committed or tagged; create a
  reproducible release commit and `v2.0.0` tag before publishing the artifacts.

## 2026-07-16 Pi-native web references

The product previously connected to model providers but exposed no web-reading
tool. URLs in workflow descriptions were therefore plain prompt text and the
model could only rely on prior knowledge. The Pi parent toolset now includes
`fetchWebReference`, backed by `webReference.ts` rather than renderer parsing or
provider-specific browsing.

The host accepts only public HTTP(S) targets, rejects embedded credentials,
localhost, private/link-local/reserved addresses, validates every redirect,
enforces a 15-second request timeout and 2 MiB response cap, and uses the same
project proxy setting as model providers. Wikipedia pages use the MediaWiki
plain-text API. Other text/HTML pages are parsed with lazily loaded Cheerio so
the parser does not increase normal startup work. Extracted references are
cached under `.translation-workshop/agent/web-references`; child prompts receive
only cached references whose URLs occur in the original parent prompt, avoiding
repeated child downloads and unrelated cross-task context.

Fetched content is explicitly marked as untrusted reference data in both parent
and child prompts. Page text cannot override system instructions, workflow
contracts, host validation, path boundaries, or user intent. Tool arguments and
page text remain inside the ordinary paired Pi tool block instead of becoming
raw assistant prose.

Verification:

- [x] the previous real workflow URL was recovered from Pi JSONL:
  `https://ja.wikipedia.org/wiki/%E3%82%BC%E3%83%8E%E3%83%B3%E3%82%B6%E3%83%BC%E3%83%89`;
- [x] the host reader fetched the MediaWiki article through the saved project
  proxy, title `ゼノンザード`, with 3,867 readable characters;
- [x] real `openai-chatgpt` / `gpt-5.4-mini` called
  `fetchWebReference` and answered from the tool result: application service
  began `2019年9月10日`, ended `2021年2月18日`, and world setting/original
  concept was by `上遠野浩平`;
- [x] the real Pi prompt was accepted in 9.7 ms and completed in 14.8 seconds
  with 116 incremental update events;
- [x] all 72 test files, `npm run build`, production dependency audit, final
  Electron verification, and the rebuilt 2.0.0 release artifact verifier passed.

## 2026-07-16 English / Chinese UI isolation

The workbench dictionaries were already complete and the English dictionary
contained no Han text. The remaining leak was architectural: the HTML Agent
route did not carry the selected locale, while the source-adapted pi-web
components still contained unconditional Chinese labels for queue controls,
slash descriptions, window actions, token estimates, and subagent card state.

The current route contract carries `locale` from generated line/proposal/folder
HTML through the embedded React host and `ui:openAgentChatWindow` into the
shared popout. Agent UI strings now live in one locale table, date/time
formatting uses the selected locale instead of the Windows process locale, and
the standalone Agent route updates the document language. Prompt text,
transcript content, project paths, model/tool names, and familiar Pi terms are
content rather than UI chrome and are not rewritten.

Regression coverage rejects Han text in the English workbench and Agent
dictionaries, rejects Chinese literals outside the Agent locale table, checks
English locale propagation for line/proposal/folder HTML, and forces v8 HTML
through the v9 automatic upgrade.

Final verification on the locale-aware build:

- [x] all 73 `npm test` files passed;
- [x] deterministic Electron rendered a Chinese folder-child Agent and an
  English line-review Agent plus shared popout from the same product build;
- [x] English Agent chrome, button titles, ARIA labels, empty state, slash
  palette, subagent card state, and locale-formatted session dates contained no
  Han text; transcript/project content was intentionally excluded;
- [x] Electron became interactive in 96 ms, model controls were ready in
  203 ms, optimistic feedback appeared in 10.4 ms, and the shared English
  popout was interactive in 146.5 ms;
- [x] evidence screenshots:
  `artifacts/electron-agent-native-folder-iframe.png`,
  `artifacts/electron-agent-native-commands.png`, and
  `artifacts/electron-agent-native-subagent-replies.png`;
- [x] Windows 2.0.0 installer/portable artifacts were rebuilt, release
  checksums verified, and the packaged executable stayed alive in a hidden
  smoke test at 116.0 MB before leaving zero processes after shutdown.

## 2026-07-16 Portable updater module interop

The first 2.0.0 portable artifact did not open. The packaged ESM main process
externalized `electron-updater` but imported its CommonJS entry with the named
ESM form `import { autoUpdater } from "electron-updater"`. Electron therefore
failed while linking `dist/main/main.js`, before the renderer or workbench
could start. The earlier release smoke launched only `release/win-unpacked`;
it did not exercise the portable self-extractor and was not a valid substitute
for launching the published executable.

`updateService.ts` now imports the CommonJS package through its ESM default
namespace and reads `autoUpdater` from that namespace. A build-level regression
test bundles the service with the same external package boundary and rejects
the unsupported named import. The release artifact verifier independently
extracts the packaged main from ASAR and applies the same boundary check.

Windows release packaging regenerates `SHA256SUMS.txt` after every
`package:win` run. The historical `verify:portable-launch` path was removed
after proving that the electron-builder NSIS portable envelope itself reaches
`0x80000003` when its Electron child exits. Automated runtime acceptance now
launches only `release/win-unpacked/translation-workshop.exe` through the
application-owned hidden smoke lifecycle; the portable artifact is checked
structurally and by checksum and is never executed automatically.

Final verification:

- [x] the new packaging interop test failed against the original import and
  passed after the module-boundary correction;
- [x] all 74 `npm test` files passed;
- [x] `git diff --check` passed;
- [x] the rebuilt release artifact verifier passed with current installer,
  portable, update metadata, ASAR dependency, and SHA-256 checksums;
- [x] the rebuilt `translation-workshop-Portable-2.0.0-x64.exe` created its
  renderer and visible `translation-workshop` window in 7.1 seconds, remained
  stable with five Electron processes, and left no test processes behind.

## 2026-07-17 Configured provider catalog and explicit model IDs

Provider presets remain visible in Settings so a user can configure them, but
the chat model selector now contains only providers with explicitly linked
credentials. Merely discovering `~/.claude/.credentials.json`, Pi `auth.json`,
Codex auth, or an ambient provider preset no longer activates that provider.
The local-login import buttons remain the explicit boundary: importing a local
login persists it into the configured provider profile, after which all
models from that provider enter the shared Pi model catalog.

The explicit `Model IDs` editor previously normalized its controlled value on
every keystroke. A trailing newline was treated as an empty model and removed,
so Enter appeared not to work. The editor now retains the raw textarea draft
while deriving normalized model IDs separately for the default-model selector
and save operation. Newlines and comma-separated IDs are both supported, while
saved IDs remain trimmed, deduplicated, and nonempty.

Verification:

- [x] a red provider-registry test proved an unlinked local Claude Code login
  incorrectly activated Claude models, then passed after project-auth ownership
  was enforced;
- [x] a red renderer test and real Electron input event proved Enter was
  discarded in `Model IDs`, then passed with the raw draft boundary;
- [x] the real `E:\novel\5656` catalog now reports only its linked
  `openai-chatgpt` models; `anthropic-claude` is absent despite a local Claude
  Code credential file;
- [x] final Electron verification reported 82 ms interactive load, 16.4 ms
  optimistic feedback, multiline provider model IDs, paired tools, live
  subagents, shared popout state, compaction, and cold-restart recovery.

## 2026-07-17 Named Custom API profiles and provider activation

The old Provider Settings schema had one mutable `custom-api` slot. Renaming it
to OpenCode Go replaced the slot itself, so configuring another endpoint meant
overwriting the saved URL, key, and model IDs. Custom API is now a clean
template that creates named, project-scoped profiles. Each profile preserves
its endpoint, redacted IPC credential boundary, default model, and full
explicit model list; users can switch among profiles without re-entering them
and can permanently delete profiles they no longer need.

Provider configuration and Provider activation are now separate state. The
Disable action keeps the complete provider profile but removes every model from
Pi's authenticated model catalog and therefore from the chat selector. Enable
restores the saved models without asking for the key again. Existing projects
whose renamed endpoint still occupies the legacy `custom-api` slot are migrated
on read into a named `presetId: custom-api` profile while a clean template is
restored, so this change does not strand the user's existing OpenCode setup.

Verification:

- [x] red store tests cover legacy migration, two independent named profiles,
  switching, credential-preserving Disable/Enable, and physical deletion;
- [x] Pi registry tests prove disabled providers cannot enter model selection
  while their settings remain persisted;
- [x] real Electron saved a two-model OpenCode profile, switched to ChatGPT and
  back, restored both IDs, removed them from the Pi catalog on Disable, restored
  them on Enable, and deleted the profile while retaining the clean template;
- [x] Electron remained interactive in 174 ms with 14.8 ms optimistic prompt
  feedback, and all 75 test files plus `git diff --check` passed.

## 2026-07-17 Wikipedia language-variant web references

A real `deepseek-v4-pro` run against `E:\\novel\\5656` proved that
`fetchWebReference` failed before the model could use the requested reference.
The Pi JSONL contained an error tool result with only `fetch failed`; an isolated
replay exposed the suppressed cause as `UND_ERR_CONNECT_TIMEOUT` while the
project's saved `127.0.0.1:3067` Agent proxy was disabled. The requested Chinese
Wikipedia URL also used `/zh-hans/<title>`, while the shared reader recognized
only `/wiki/<title>` and therefore bypassed the stable MediaWiki API path.

The shared host reader now recognizes Wikipedia Chinese language-variant routes
and converts them to the same MediaWiki plain-text API contract as `/wiki/`.
Connection failures preserve their nested Undici error code and cause instead
of collapsing to `fetch failed`. The project proxy was explicitly enabled for
the affected workspace, retaining its existing URL.

Verification:

- [x] the exact `/zh-hans/` URL regression test failed on the generic HTML path
  before the fix and now passes through `/w/api.php`;
- [x] a nested network-error regression test exposes
  `UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error`;
- [x] the exact user URL succeeded against the real `E:\\novel\\5656`
  workspace in 2.1 seconds and returned 2,561 characters titled
  `越佐大橋系列`;
- [x] all 75 unit-test files, `npm run typecheck`, and `git diff --check`
  passed.

## 2026-07-17 Host-extracted source ownership

The same real `E:\\novel\\5656` Pi JSONL exposed a second host-boundary bug.
EPUB/text extraction correctly bound the Agent to
`.translation-workshop/extracted-text/<id>/source/<file>`, but the source
manifest rejected every path whose first project-relative component was
`.translation-workshop`. That broad generated-directory rule therefore denied
the host's own immutable extracted input and made `inspectTranslationContext`,
`selectSourceDocument`, and `readSourceLines` fail together.

The source manifest now treats only the host-owned `extracted-text` subtree as
a legal read-only source boundary while continuing to reject every other
`.translation-workshop`, `AI_translation`, and report selection. Generic
`writeProjectFile` restrictions were deliberately not weakened: translation
artifacts still belong to `writeTranslationChunk`, while direct writes remain
limited to `_workspace` assets and settings.

Verification:

- [x] a regression test failed on the exact extracted-text directory shape and
  passed after the ownership boundary was corrected;
- [x] the real extracted `_.txt` now resolves as one source document with 2,592
  lines;
- [x] source-manifest tests and `npm run typecheck` pass.

## 2026-07-17 Child Prompt And Provider Stream Boundaries

Translation children remain intentionally host-restricted: they read only
their assigned source through `readAssignedSource` and write only through the
assigned translation tools. They do not receive a general `readProjectFile`
capability.

A real child JSONL exposed a contract violation: a parent-supplied free-form
`taskPrompt` replaced the host-owned Pi child prompt and named removed tools
such as `readProjectFile`, `readSourceLines`, and `writeTranslationChunk`.
Free-form child task prompts have now been removed from the product tool schema
and cannot replace either direct-child or persistent-worker execution prompts.
The prompt shown on the child card is the canonical prompt actually sent to the
Pi child runtime.

Translation children use one read boundary rather than a family of reference
functions. The first `readAssignedSource` result includes a complete packaged
child translation workflow plus validated formal/project glossary, current
workflow glossary candidates, character bible, style guide, and cached web
references. Persistent folder workers call the same tool with
`referencesOnly: true` before translating host-supplied source blocks.

The packaged child workflow keeps every translation-facing part of the skill:
output/alignment rules, terminology handling, character and voice consistency,
translation quality/style, host tool sequence, self-check, and non-translate
patterns. It deliberately excludes only parent-owned glossary/character-bible
generation, workspace setup, delegation, and final multi-worker assembly.
Project references are no longer passively injected into the translation child
system prompt. The child must actively read them, and every translation write
or repair fails until that read has succeeded. Malformed generated assets fail
fast; no general filesystem tool is added to work around missing context.

Provider streaming no longer has a fixed five-minute total wall-clock timeout.
Only inactivity is timed out and every native stream event resets that timer,
so a long but active translation turn is not aborted merely because its total
duration exceeds 300 seconds. Explicit Stop still aborts immediately and a
truly silent provider still enters the existing bounded retry path.

Regression evidence:

- [x] canonical child prompt ignores injected obsolete tool names;
- [x] project references are absent from the initial translation system prompt
  and appear in the paired result of the child's own read call;
- [x] direct children, persistent folder workers, chunk turns, and resume-repair
  turns all enforce the same read-before-write gate;
- [x] an active request outlives the former total deadline;
- [x] inactivity timeout, Stop, and transient child retry tests still pass;
- [x] `npm run typecheck` and all 75 `npm test` files pass;
- [x] the rebuilt 2.0.0 unpacked resources contain the complete child workflow,
  release artifact/checksum verification passes, and the actual portable EXE
  created a renderer in 6.6 seconds and remained stable with five processes.

## 2026-07-17 Provider Settings View Ownership

Provider Settings was incorrectly inserted as an extra fixed-height block above
the live transcript and composer. In constrained embedded docks this made the
settings header compete with the chat surface and could clip its own Close
action. The Electron verifier missed the defect because it located the button
in the DOM and invoked it programmatically without proving a user could see or
hit it.

Provider Settings is now an exclusive Agent-main view: while it is open, the
transcript and composer are not mounted, the settings panel owns all remaining
height below the native Pi topbar, and its fields/list scroll inside that
boundary. Electron acceptance now checks that the Close button is fully inside
the panel, begins below the topbar, is the topmost element at its hit point, and
that no chat composer competes with the settings view. A rendered settings
screenshot is retained at
`artifacts/electron-agent-native-provider-settings.png`.

## 2026-07-17 EPUB Artifact Source Contract

EPUB line reviews previously carried the host-extracted TXT only as the Agent
prompt source. The artifact panel independently reused the original display
source path, so candidate discovery tried to match and validate a UTF-8 TXT
against the binary EPUB. This produced the false "unmatched source" state even
though the extracted source already existed.

Line-review workflow data now has one explicit `validationSourcePath`: the
canonical UTF-8 line source used by artifact discovery, validation, repair, and
draft import. The original `sourcePath` remains the display/export template,
while `sourcePromptPath` remains the Agent prompt scope. Single EPUB reviews,
bilingual EPUB reviews, and folder child pages bind the extracted TXT as the
validation source without changing their prompt scope. Protocol v16 forces old
HTML through migration; a legacy single-EPUB page recovers the extracted TXT
from its existing prompt path instead of falling back to the binary EPUB.

Regression evidence:

- [x] the focused test failed on an absent canonical artifact source before the
  contract change and now passes;
- [x] old v15 EPUB HTML upgrades to v16 with the extracted TXT preserved;
- [x] all 75 test files pass;
- [x] Electron Agent/HTML acceptance passes with 183 ms interactive startup,
  24.1 ms optimistic feedback, and no raw protocol leak.

## 2026-07-17 Native Pi Proofreading Workflow

Proofreading now uses the same native Pi parent/child runtime boundary as
translation instead of delegating a thin findings-only prompt. A proofread
child must call one host-owned `readAssignedProofreadContext` tool before it
can write findings. That result contains the exact aligned rows it owns,
two-line boundary context, host deterministic signals, the complete packaged
`proofread-workflow.md`, and a validated project-reference manifest. Small
references are delivered inline; larger glossary, character-bible, style,
workflow, and cached-web references are read completely in bounded chunks
through `readProofreadReference`. The findings writer remains locked until
every manifest entry has been consumed. The child still has no general write
capability and cannot start nested subagents.

The parent host owns planning. The original implementation derived one balanced
range per child; that historical behavior was replaced on 2026-07-31. Split
mode now derives contiguous tasks of at most `proofreadSplitSize` rows while the
typed child count controls only persistent-worker concurrency. The model cannot
submit line ranges, and full coverage remains Host-owned.
Monte Carlo mode ignores model-authored ranges and deterministically creates
non-overlapping worker samples from 500-line heat blocks, always including
H3/H4/H7/H8/H9 prescan evidence in the first round and excluding previously
sampled lines in later rounds. A failed Monte Carlo batch atomically restores
the pre-batch findings snapshot and does not commit its round or sampled-line
set, so retrying plans the same work rather than silently skipping it. The
native completion contract cannot settle
until aligned reads, the required child batch, a validated normalized findings
artifact, Monte Carlo convergence when selected, and an atomically replaced
human-readable summary have all completed. Failed split replacement batches
reset stale partial findings before the replacement run.

The proofread settings are typed from generated HTML through the embedded
route, renderer, IPC parser, Pi session request, and domain contract. Line
review protocol v17 forces v16 pages through automatic regeneration so old
HTML cannot silently drop proofread mode, split/sample size, or round limits.

Regression evidence:

- [x] complete child workflow/context and read-before-write tests pass;
- [x] deterministic H3/H4/H7/H8/H9 prescan and Monte Carlo planner tests pass;
- [x] split failure replacement, empty findings, exact line ownership, and
  native child JSONL ownership tests pass;
- [x] summary/finalization and Monte Carlo completion-gate tests pass;
- [x] all 77 `npm test` files pass;
- [x] Electron Agent/HTML acceptance passes with 122 ms interactive startup,
  30.7 ms optimistic feedback, paired tools, two structured child cards,
  visible child replies, shared popout state, and no raw protocol leak.
- [x] independent review findings are covered by red tests for failed Monte
  Carlo rollback/retry, summary-before-write gating, full references beyond
  the inline limit, strict same-line finding bindings, effective child count,
  host-owned split planning, complete deterministic signals, and v16 advanced
  metadata migration;
- [x] final Electron Agent/HTML acceptance passes with 152 ms interactive
  startup, 19.5 ms optimistic feedback, paired tools, two structured child
  cards, visible replies, shared popout state, cold-restart recovery, and no
  raw protocol leak;
- [x] the same independent reviewer rechecked checkpoint ownership, progressive
  large-reference reads, all nine earlier P1 corrections, and the pure Pi
  product boundary, found no remaining P0/P1 issue, and returned `PASS`.

## 2026-07-17 Proposal Review HTML Open Contract

Newly generated proposal-review HTML could be written successfully but fail to
open. The root cause was not the report itself: the legacy upgrader identified
page types by loose source-text substring checks. Proposal pages contain the
literal `reviewData` lookup inside their Agent embed script, so a current
proposal page was misclassified as a legacy line-review page and rejected with
`Legacy line-review data cannot be migrated`. Both generation surfaces then
used the generic `openPath` bridge, whose returned error string was ignored,
making the failure appear as a dead button.

Review-page identity now comes from actual top-level embedded JSON script
elements while skipping script bodies, preserving fail-fast handling for
malformed real line-review children without mistaking JavaScript source text
for page data. Main-workbench and embedded line-review generation both use the
review-specific `openReviewHtml` IPC. The HTML preload exposes that same
contract, and generation persists `lastProposalReviewHtml` plus main-side
`state.json` before opening so reopen/project recovery does not point back to
the previous line-review page.

Regression evidence:

- [x] a red renderer contract test proved both generation surfaces bypassed
  the review-specific bridge;
- [x] a red legacy test proved current proposal HTML entered the line-review
  migrator;
- [x] Electron reproduced the exact migration exception before the fix;
- [x] Electron now generates a findings report, automatically opens it as a
  second native tab, filters and restores cards interactively, persists the
  proposal path, and captures
  `artifacts/electron-proposal-review-auto-open.png`;
- [x] all 77 test files and the full Electron Agent/HTML acceptance pass.

## 2026-07-17 Host-owned Proofread Finding Rows

The real `P4-校对` child history under `E:\\novel\\5656` exposed a costly
proofreading wire-contract error. `readAssignedProofreadContext` supplied the
correct aligned rows, but `writeAssignedFindings` required the model to echo
every complete `sourceText`, `currentTranslation`, and `translationLine` back
byte-for-byte. P4 changed Chinese curly dialogue quotes into Japanese corner
brackets. The strict findings writer correctly rejected the mismatch, but the
child then spent roughly sixteen minutes and more than 120k context tokens
guessing quote variants. The tool also allowed several successful partial
writes even though one assignment is one findings artifact.

The child findings input now contains only the model-owned judgment: coded
`id`, `type`, one-based `sourceLine`, complete `suggestedFix`, `rationale`, and
optional `needsVerification`. The host derives the normalized H1-H9/M1-M5/L1-L4
severity from the ID, binds `translationLine` to the same aligned row, and
copies exact source/current text directly from the bound files immediately
before the atomic findings write. A child assignment accepts only one
successful findings write; failed calls remain retryable, but successful
partial append sequences cannot fragment or duplicate the batch.

Regression evidence:

- [x] the focused red test reproduced rejection when the child omitted the
  formerly model-owned exact-row fields;
- [x] the tool schema no longer exposes `sourceText`, `currentTranslation`,
  `translationLine`, or free-form `severity` as child inputs;
- [x] the host-written report contains exact bound rows and normalized severity;
- [x] a second successful findings write for one assignment is rejected;
- [x] native proofread completion integration, all 77 test files, typecheck,
  and full Electron Agent/HTML acceptance pass.

## 2026-07-17 Generated Glossary Import And EPUB Editable TXT

The real `E:\\novel\\5656` workspace contained 92 generated glossary
candidates but no formal `.translation-workshop/glossary.json`. The previous
workspace status only reported that a candidate file existed, so neither the
React workbench nor generated line-review HTML had a reliable pending-import
contract. Workspace asset status now compares candidates with the formal
glossary, reports the exact pending count, and exposes one host-owned import
action. Both product surfaces use that contract; import writes the formal
project glossary, binds it when none was selected, and the action disappears
only after the on-disk comparison is satisfied.

Future glossary generation now excludes ordinary dictionary vocabulary,
generic occupations, clothing, objects, directions, floors, verbs,
adjectives, and context-local phrases. Candidates are limited to proper names,
fictional coined terms, named organizations/places/titles, and setting-specific
abilities or items whose translation must remain consistent. This rule is in
both the visible generated prompt and the native Pi system workflow.

EPUB remains an immutable source package, but line-review now has a separate
host-owned `editableTranslationPath`. For EPUB workflows this points to the
canonical UTF-8 extracted translation TXT. Save TXT and Export EPUB coexist:
row edits overwrite the canonical TXT for another proofreading pass, while
EPUB export remains a separate explicit operation. Agent draft imports retain
that canonical binding instead of silently rebinding future saves to a
temporary candidate. Legacy HTML migration preserves or recovers this path;
line-review protocol v18 forces older pages through regeneration.

Regression evidence:

- [x] real 5656 status reports 92 pending candidates and the import action;
- [x] focused tests cover partial glossary/alias pending detection, import
  convergence, glossary quality instructions, EPUB dual actions, canonical TXT
  binding, and generated-HTML glossary import;
- [x] all 77 test files pass;
- [x] Electron imports a generated candidate into the formal glossary on disk
  and verifies the EPUB line review binds its canonical extracted TXT;
- [x] Electron acceptance reports 51 ms interactive startup, 32.7 ms
  optimistic feedback, paired tools, structured subagents, and no raw protocol
  leak.
- [x] Windows 2.0.0 installer and portable artifacts were rebuilt, checksums
  verified, and the packaged portable renderer reached ready state without a
  main-process exception.

## 2026-07-17 Proposal Category Reset

The proposal-review category selector used the persisted category as a
fallback whenever the DOM value was falsy. Because the legitimate "all
categories" option is represented by an empty string, selecting it restored
the previous category instead of clearing the filter. The live selector value
is now authoritative whenever the selector exists; persisted state is used
only before the DOM control exists. Proposal-review protocol v2 makes older
generated HTML regenerate automatically rather than retaining the stale inline
script.

Regression evidence:

- [x] the generated-HTML runtime test selects H3, observes only H3, selects the
  empty all-categories option, and observes both H3 and M1 again;
- [x] the legacy upgrader test proves proposal HTML without the v2 marker is
  upgraded;
- [x] the Electron proposal-review DOM completed the same category reset and
  logged `[proposal-review] category-filter-reset`; screenshot capture could
  not run in the current desktop session because Electron reported
  `Current display surface not available for capture`.

## 2026-07-17 Authenticated Remote Desktop Agent Open

The removed Codex/Claude Code product path remains removed: neither CLI is an
Agent runtime, provider bridge, transcript source, or renderer mode. References
that remain are deliberately limited to importing local ChatGPT/Claude OAuth
credentials for Pi providers. They authenticate the native Pi runtime and do
not execute Codex or Claude Code as a second Agent architecture.

The existing PIN-authenticated LAN review workspace now has one strict remote
command, `open-agent-os`. After authentication, the mobile workspace can ask
the owning Electron review tab to restore and focus its desktop window and open
the same embedded YN Agent OS. Unknown commands are rejected, unauthenticated
requests receive 401, and no Agent transcript/runtime protocol is proxied
through the LAN server. Line-review protocol v19 and proposal-review protocol
v3 force older generated HTML through regeneration so the preload command
subscription is present instead of leaving stale pages behind.

Regression evidence:

- [x] architecture tests prove the former CLI Agent runtimes and provider paths
  are deleted and unreachable from Electron product entries;
- [x] focused LAN tests cover strict command parsing, authentication, localized
  mobile controls, preload delivery, and both generated HTML entry points;
- [x] real Electron verification authenticates over the LAN HTTP endpoint,
  proves an unauthenticated command is rejected, sends `open-agent-os`, and
  observes `agent-chat-docked` plus the real React Agent root in the owning
  desktop tab;
- [x] all 77 test files and typecheck pass.
- [x] Windows 2.0.0 installer and portable artifacts were rebuilt, checksums
  verified, and the packaged portable renderer reached ready state without a
  main-process exception.

## 2026-07-17 Smooth Project Reopen

The generic folder picker could not remember which directory was last opened
as a project, and `project:load` treated the globally newest HTML as the sole
resume target. A newly generated proposal-review page therefore displaced the
line-review workbench even when both artifacts existed.

Project selection now has its own persisted recent-folder contract under
Electron `userData`; source and output folder pickers cannot overwrite it. On
load, the main process scans the project HTML directory by canonical artifact
name and modification time, resolving the newest line/batch review and newest
proposal review independently without reading large HTML bodies. The renderer
opens both when present. The later first-paint optimization below opens line
review immediately and restores proposal review in the background without
activating it, so the line-by-line workbench remains the active/default tab.

Regression evidence:

- [x] focused tests cover recent-project persistence and independent newest
  line/proposal discovery;
- [x] renderer contract tests prove project selection uses the dedicated picker
  and restores both review targets while keeping line review active;
- [x] real Electron verification opens two current project tabs, leaves the
  newest line review active, and confirms the second project picker starts in
  the previously selected project folder;
- [x] all 78 test files and typecheck pass.

## 2026-07-17 EPUB Title Navigation Preservation

The EPUB writer replaced each translated block by rebuilding the outer
`p`/heading/list element with escaped plain text. When a title or contents row
wrapped its visible label in `<a href="...">`, this removed the anchor while
leaving only the translated label. The real 5656 vertical-book export proved
the failure: `text/part0006.html` fell from 19 links in the source to 7 links
in the exported EPUB.

EPUB replacement now changes only visible text nodes inside the existing
inline markup. Anchor elements, `href` fragments, target `id` attributes,
spans, classes, and surrounding vertical-layout structure stay intact. When a
block contains a link, the translated label is deliberately placed inside the
link so the complete translated title remains clickable.

Regression evidence:

- [x] the red core test reproduced an anchor being stripped from a translated
  title row;
- [x] a complete synthetic EPUB export/re-extract test preserves the title
  link and its chapter fragment target;
- [x] the real 5656 extracted EPUB plus its 2,592 translated lines retains all
  140 original `href` values with zero link-loss files;
- [x] all 80 test files and typecheck pass.

## 2026-07-17 Project Open First-Paint Path

Project reopen had accumulated three synchronous costs before the user saw a
usable review page: recursive traversal of every nested batch child HTML,
workspace glossary/character-asset discovery, and full proposal-review restore
before the line-review workbench. These were ordering and ownership problems,
not a reason to add a longer loading screen.

The project-open hot path now inspects only canonical top-level line/proposal
artifacts, reads project/state metadata in parallel, opens the newest line
review first, and restores the proposal tab without activating it. Workspace
asset discovery runs after the first page is visible and uses a request id so a
late result from another project cannot replace the current project state.
HTML tab loads are shared per tab, and canonical line-state reads wait for the
existing tab instead of starting a competing navigation.

Regression evidence:

- [x] focused red tests cover top-level batch-index ownership, line-first tab
  restore, non-activating proposal restore, and background asset discovery;
- [x] real Electron opens the latest line review in 423 ms, restores the
  proposal as a second tab, keeps line review active, and reports no concurrent
  navigation error;
- [x] all 80 test files, typecheck, and `git diff --check` pass.

## 2026-07-18 Remote Pi Agent Surface

The authenticated LAN workspace now mounts the existing Vite
`agent-embedded` bundle and its source-adapted Pi-web `ChatWindow`; it does not
contain a second transcript renderer. Its authenticated RPC adapter exposes
the same `window.workshop.agentSession` contract as Electron and delegates
session creation, transcript loading, prompt, Steer, Follow-up, compaction,
and Stop to the singleton `PiNativeSessionService`. Native Pi event/state
envelopes are forwarded over the existing LAN SSE channel without translating
them into a remote-only message format. The Agent tab can be collapsed back
to line/proposal review.

Provider configuration and model discovery reuse the existing provider IPC
service functions. The Pi-web session hook now reuses its provider reload
operation before first send when initial model discovery is still in flight;
this removes the startup race that previously accepted a prompt and then
reported that no model was selected.

The remote route is an opaque `lan:<token>` identifier until PIN
authentication succeeds, so the bootstrap page does not expose the local
workspace path. Provider updates are forwarded through the existing Pi
broadcast subscription. On SSE reconnect, the adapter requests native
bootstrap/run/provider state and marks the existing session as reselected;
the source-adapted Pi-web hook then uses its normal `loadSelectedSession()`
path to rebuild the transcript from Pi JSONL, including turns completed while
the browser was disconnected.

Regression evidence:

- [x] focused tests prove the LAN gateway allowlists only native Pi operations,
  forces the server-owned workspace, and mounts the existing Pi-web bundle;
- [x] the authenticated API rejects unauthenticated Agent calls and resolves
  only configured provider models;
- [x] real Electron sends a prompt from the remote page, streams the reply,
  settles the native Pi run, retains the transcript, and collapses the panel;
- [x] the desktop preload reads the same user and assistant messages from the
  same native Pi JSONL session;
- [x] real Electron disconnects the remote event stream, completes another
  turn from the desktop, reconnects, and reloads the missed turn from the same
  Pi JSONL session;
- [x] all 81 unit-test files, typecheck, build, and `git diff --check` pass;
- [x] an independent review agent returned PASS after the reconnect,
  provider-update, provider-race, and pre-auth path-disclosure findings were
  resolved;
- [x] screenshot evidence is stored at `artifacts/lan-agent-remote.png`.

## 2026-07-18 Character Gender And Pronoun Assets

The bundled translate-text workflow already required character gender and
pronoun metadata, but the product prompt and generated-glossary parser had
drifted to a narrower `{source,target,aliases}` contract. The parser rejected
`info`/`status`, the importer discarded that metadata, and any non-empty
character-bible Markdown was treated as ready. This made the skill requirement
impossible to preserve through the actual host path.

The generated glossary contract now accepts and imports `info` plus
`confirmed`/`auto`/`pending` status. Metadata added to an already-imported term
remains pending and is merged without overwriting an existing human value. A
generated character bible is ready only when each `##` character section has
explicit Gender/pronouns with confirmed, inferred, or unknown confidence and
Terms of address. The prompt also requires identity, voice, relationships,
catchphrases, and evidence. The existing asset editor exposes gender,
pronouns, and confidence instead of forcing manual JSON edits.

Regression evidence:

- [x] prompt tests require gender/pronoun and terms-of-address instructions;
- [x] workspace tests prove character metadata survives glossary import and
  incomplete character bibles are not considered ready;
- [x] native host-tool tests reject incomplete generated character bibles;
- [x] translation and proofreading children still receive the complete
  validated workflow assets;
- [x] all 81 unit-test files, typecheck, build, and `git diff --check` pass.

## 2026-07-18 Child Terminology And Character Discovery

Translation children now return terminology candidates and character facts as
structured fields of the mandatory `validateAssignedTranslation` tool result.
Every proposal must cite an exact source line inside that child's owned range;
free-form child prose is not treated as shared glossary state. Exact duplicate
proposals are removed while conflicting targets remain visible for the parent
to resolve rather than being silently overwritten.

The existing native Pi child-completion follow-up carries the merged report
back to the parent Agent. The parent owns semantic review: it rejects ordinary
dictionary words and everyday phrases, checks approved project assets for
conflicts, searches project text and configured web references for unknown
gender/pronoun or character facts, and leaves facts unknown when evidence is
inconclusive. Only accepted updates may be written to the validated workspace
glossary and character bible. Children never write those shared assets and no
parallel YN queue, memory store, or completion state machine was introduced.

Regression evidence:

- [x] child-tool tests reject discoveries outside the owned range or without
  exact source evidence;
- [x] merge tests remove exact duplicates but retain conflicting translations
  for parent review;
- [x] the native completion integration test proves the structured report is
  delivered in the hidden Pi follow-up before final artifact validation;
- [x] prompt and domain-tool tests require filtering common words, researching
  unknown facts, deduplication, and validated persistence;
- [x] all 81 unit-test files, typecheck, build, and `git diff --check` pass.

## 2026-07-18 Global Provider And Model Configuration

Provider identity is user-level state, not translation-project state. The
desktop product now configures the existing provider and OAuth stores against
Electron `userData/agent` before Agent IPC is registered. API keys, Codex and
other OAuth profiles, saved Custom API profiles, explicit model IDs, active
provider/model, and provider thinking defaults therefore follow the user
across every project. Provider update broadcasts carry global scope so another
open project and the authenticated LAN Agent surface refresh the same model
catalog immediately.

Pi JSONL sessions and compaction remain project-owned, as do translation
memory, glossary, character bible, workflow artifacts, and review state. This
change does not create cross-project conversation memory. When the global
store does not yet exist, the first opened project's legacy
`.translation-workshop/agent/provider-config.json` and `oauth-profiles.json`
are validated and copied once into the global location; malformed legacy data
still fails visibly with its original path.

Regression evidence:

- [x] a red test proved two projects could not share DeepSeek API and Codex
  OAuth configuration before the global store was configured;
- [x] the test now proves legacy migration, cross-project provider/custom
  model visibility, cross-project OAuth visibility, and global on-disk paths;
- [x] source-boundary assertions prove `userData` is configured before Agent
  IPC and global provider updates are accepted by every Pi-web session route.
- [x] all 82 unit-test files, typecheck, build, and `git diff --check` pass;
- [x] the rebuilt 2.0.0 installer/portable checksums pass and the packaged
  portable renderer reaches a stable visible window.
## 2026-07-26 nested folder line-review discovery

Folder-mode Agent manifests already discovered supported source files recursively,
but line-review HTML generation still scanned only the selected folder's first
level. The two product paths now share `collectSourceTreeFiles`: nested TXT/EPUB
files are discovered in stable relative-path order, generated/output directories
are excluded, and translation matching uses the relative path rather than only
the basename so equal filenames in different subfolders cannot collide.

Regression coverage includes nested discovery, duplicate basenames in separate
subfolders, the Pi manifest, and a real Electron IPC run that generates both
child line-review pages from a folder whose root contains no direct TXT files.

## 2026-07-27 editable language-pair restoration

The Pi request, generated prompt, Agent route, artifact validation, and stored
prompt settings still carried `languagePair`, but the line-review prompt form
had accidentally dropped its `promptLanguagePair` input while slimming other
settings. The field and its original form read/write path are restored, and
prompt-settings protocol v21 forces older generated HTML through automatic
regeneration. Electron verification changes the field to `en->zh-CN` and
requires the generated Agent prompt to contain that exact direction.

## 2026-07-27 character-bible contract and transient window UI

The latest real translation history showed repeated character-bible writes
because the generated prompt named required metadata while the host validator
expected a more exact section grammar. The generated workflow prompt and the
native Pi parent system prompt now consume one shared character-bible contract.
It gives the exact Markdown section template and requires unresolved character
gender/pronouns to be researched with `searchProjectText` plus nearby context.
Research stops once evidence establishes the fact; `unknown` is reserved for
cases where project and configured canon references remain insufficient. The
host accepts the canonical labels and their ordinary bold-Markdown equivalent.

The separate TXT-format child failure observed in that history is an input
format issue and was explicitly left outside this change. No translation,
repair, or artifact-validation policy was relaxed to conceal it.

Popout Agent pages now bind body/root height to the viewport and keep scrolling
inside the transcript, so the session sidebar does not travel with conversation
scrolling. Native Pi compaction remains unchanged; only its success notice is
held in transient renderer state and removed after two seconds.

## 2026-07-27 Web-reference browser-session fallback

The host web-reference service keeps its bounded, SSRF-checked Node fetch as the
normal path. Some public sites, including TVTropes, reject that automated client
with HTTP 403 even though Chromium can read the page. A 403 now retries the same
validated URL through Electron's default Chromium session with session
credentials enabled; redirects remain manual and every redirect target is
revalidated before fetching. The existing 2 MiB response cap and text extraction
remain the single downstream contract.

The real Electron verifier fetched the supplied The Sekimeiya: Spun Glass
TVTropes page as HTML and extracted 9,903 readable characters. The Node-only
fallback regression test proves that a 403 becomes one browser-session retry and
that the resulting HTML still enters the same parser/cache path.

The same investigation found a misleading terminal error: after a provider
failure had activated a translation contract, the end-of-prompt completion check
could replace the provider error with missing workflow stages. Completion errors
now populate terminal state only when that turn has no existing provider/runtime
error, so transport failures remain observable and workflow requirements are not
falsely presented as the initiating fault.

Regression evidence:

- [x] character-bible prompt, native system-prompt, host-schema, and renderer
  lifecycle tests pass;
- [x] all 84 unit-test files, typecheck, build, and `git diff --check` pass;
- [x] the focused real Electron Agent verifier passes with 62 ms interactive
  readiness and 12.9 ms optimistic feedback;
- [x] Electron DOM assertions prove the popout outer document cannot scroll,
  the sidebar remains fixed while the transcript scrolls, and the compaction
  notice disappears within four seconds of its two-second timer;
- [x] screenshot evidence was refreshed at
  `artifacts/electron-agent-native-popout.png` and
  `artifacts/electron-agent-native-compaction.png`.

## 2026-07-27 Ordered, line-balanced folder translation

Folder translation no longer assigns one whole file to each child. The HTML
prompt settings carry a typed exact source-document manifest, split size, and
editable file-order expression into the native Pi request. The expression has
one brace group: files before it are strict early stages, files inside it share
one parallel stage, and files after it are strict later stages. New folder
reviews default every recursively discovered source ID into the brace group in
filename order. Prompt protocol v23 forces older HTML through regeneration.

The host validates that expression against the immutable TXT/extracted-EPUB
manifest and creates non-overlapping assignments bounded by `splitSize`.
Exactly the configured number of persistent Pi child runtimes consume a shared
dynamic queue. Idle workers claim the next ready assignment, while stage
barriers prevent later files from opening early. Every folder file, including
single-line files, enters this queue; the parent cannot bypass ordering with a
direct candidate write while the child pool owns the batch. Stop wakes workers
waiting behind a barrier.

Structured glossary and character discoveries from completed earlier stages
are merged as unapproved consistency hints and supplied by the host reference
read to later-stage assignments. The parent remains the only owner of final
deduplication, research, approval, and shared-asset persistence.

A permanent assignment failure closes the stage frontier: workers may finish
or claim remaining work from that same stage, but no later stage can open. This
keeps independent work in the failing stage productive without letting a
failed priority file silently release dependent files.

Independent review caught three product-path gaps before release. The embedded
HTML metadata whitelist and stored-default bridge now preserve the typed split,
order, and exact manifest all the way into the top-level Pi session request.
Legacy folder upgrades use the batch index as the authority for TXT documents
and the child `validationSourcePath` only for EPUB extraction, so neither a
folder path nor an EPUB binary can masquerade as a source document. Earlier
stage discoveries are serialized as complete compact JSON rather than a
silently truncated fragment.

Re-upgrade never trusts an already persisted folder manifest. It reconstructs
the manifest from the batch index and current child HTML, replacing stale EPUB
binary paths with the extracted UTF-8 text path.

Regression evidence:

- [x] parser and planner tests cover before/parallel/after stages, manifest
  rejection, single-line files, and a 20,000-line file split into bounded work;
- [x] lifecycle tests cover exact worker count, dynamic claiming, both stage
  barriers, Stop wake-up, permanent priority-stage failure, and actual
  earlier-stage discovery delivery;
- [x] explicit TXT and extracted-EPUB source-document binding is validated at
  IPC and source-manifest boundaries;
- [x] all 85 unit-test files and `git diff --check` pass;
- [x] the folder Electron verifier sends the generated prompt by pressing Enter
  in the real Pi-web composer and captures the resulting `PiSessionPromptRequest`;
  it contains split size 2000, the edited five-worker setting, the brace-stage
  order, exact `a.txt`/`b.txt` source paths, and `book.epub` bound to its
  extracted `source.txt` rather than the EPUB binary;
- [x] full Electron verification passes with 44 ms interactive readiness,
  7.2 ms optimistic feedback, folder prompt/order upgrade, native child cards,
  paired tool results, and cold-restart recovery.
- [x] a fresh independent reviewer re-read the final worktree, reran the focused
  planner/lifecycle/upgrade/architecture/IPC checks, found no P0/P1/P2 issue,
  and returned PASS with no legacy or mixed YN runtime reachable in product.
- [x] release 2.0.0 was rebuilt; installer and portable checksums verify, and
  the packaged portable executable reached its renderer with five stable
  Electron processes in the launch smoke test.
## 2026-07-27 Folder-order brace semantics and parent planning stall

- The latest affected project was `The Sekimeiya Spun Glass/localization_workspace`, not the older 5656 fixture. Its parent Pi JSONL showed the exact sequence: source/context reads completed at `01:21:32Z`, the next assistant message contained only `Planning parallel file writes`, and the provider emitted no tool call or further delta before the observable 60-second inactivity timeout. `runTranslationSubagents` was never entered, so this was a parent prompt/semantic stall rather than a worker-pool stall.
- Folder-order braces mean only that the enclosed files have no ordering constraint relative to each other. They remain ordinary line-balanced work units in the same host-owned dynamic persistent-worker queue; they are not required to start or finish simultaneously. Only files moved outside braces create strict earlier/later barriers.
- Product prompts, the fixed Pi system prompt, the `runTranslationSubagents` tool description, and the zh/en HTML help now state that contract explicitly and forbid model-side planning of simultaneous file writes. The parent must call `runTranslationSubagents` once as soon as required workspace assets are ready; host scheduling, split size, and worker claims remain unchanged.
- Line-review protocol is v20 so existing HTML is regenerated through the normal legacy-upgrade path instead of retaining the old misleading brace help.
- Regression coverage: `tests/agent/prompts.test.mjs` rejects the old `parallel stage` wording and requires the no-order/no-simultaneous/dynamic-queue contract. Full `npm run test:unit` passed all 85 test files; `npm run typecheck`, `git diff --check`, and `npm run verify:electron-agent-html` passed. Electron prompt capture contained the corrected contract, with 43 ms interactive readiness and 15 ms optimistic send feedback.

## 2026-07-27 Provider inactivity timeout visibility

- Pi already persists a provider inactivity timeout as a native assistant message with
  `stopReason: "error"` and `errorMessage`. The renderer projection previously appended
  that message without terminating its optimistic running state, while the generic run
  error was rendered above the transcript. A user reading the bottom of a long session
  could therefore see a live Stop button and no nearby failure even though Pi had ended.
- The native Pi event reducer now treats an assistant `message_end` with
  `stopReason: "error"` as terminal immediately: streaming state, phase, and Stop are
  cleared while the exact provider error remains part of the Pi transcript. MessageView
  renders that error inside the failed assistant turn. If a provider fails before Pi can
  create an assistant message, the run-state error is rendered once at the transcript
  tail instead of replacing or hiding prior messages.
- No YN status event or synthetic assistant message was introduced. The renderer still
  consumes only native Pi `AgentMessage[]`, native Pi events, and terminal run state.
- Regression evidence: provider-stream timeout, native session service, pi-web reducer,
  and renderer lifecycle tests pass; all 85 unit-test files and typecheck pass. The
  focused Electron Agent verifier passes with 65 ms interactive readiness and 11.3 ms
  optimistic feedback, proves the provider error is visible, prior transcript survives,
  and the main Agent Stop control is gone after failure.

## 2026-07-28 Pi turn recovery, local repair ownership, and retained folder files

- A real Pi JSONL showed a 1,233,898-character final-validation tool result followed by
  a context-window error. The old path compacted only before a later accepted user turn,
  so the current turn could terminate instead of continuing. `PiSessionAgentRuntime` now
  follows Pi's own post-turn recovery shape: an error/length overflow persists a native
  Pi compaction entry, rebuilds context through `Session.buildContext()`, removes the
  failed assistant tail from the rebuilt in-memory context, and calls native
  `Agent.continue()` once. A successful assistant stop that crosses the threshold is
  compacted for the next turn without replaying the completed answer. No YN retry/job
  state machine was added.
- Final translation validation still writes the complete report to disk, but its tool
  result returns only bounded counts and exact repair debt. A 20,000-line regression no
  longer injects the full warning array into the parent context.
- Page `workflowIntent` metadata is not sufficient to start a complete YN workflow.
  Only the exact generated `Workflow: yn-translation-v1.` or
  `Workflow: yn-proofread-v1.` marker activates the full host contract. Ordinary chat
  and bounded local corrections remain parent-owned; local translation writes require
  inspection, a validated write, and final validation, but do not require assets or
  child batches. Child-batch tools perform a preflight before any source read, planning,
  or supervisor start and reject a local turn; a model tool call cannot upgrade it into
  a full workflow.
- Folder worker ownership now lasts only while a native Pi child batch is running or
  settling. After settlement the parent can select a retained document, read exact rows,
  write sparse corrections, and revalidate without restarting the whole workflow.
- Pi's second overflow shape, `stopReason: "length"` with zero output and a filled
  context window, follows the same compact-and-retry path as an explicit provider error.
  Every retrying overflow removes the failed assistant tail both before compaction and
  after the JSONL context rebuild. The one-retry guard remains set until a successful
  `stop`, so a second length overflow cannot loop indefinitely.
- Generic translation placeholders such as `（本段译文）`, `本行译文`, `译文待补`,
  and their documented English equivalents are blocking validator errors. Because child
  writes use the same validator, placeholder output is rejected at the child write turn
  with exact line debt rather than surviving until final validation.
- The fixed Pi system prompt now directs ordinary Agent chat to investigate concrete
  project complaints with `inspect_only` and project read/search tools before answering.
  It forbids a one-line apology when the project can be inspected and forbids spawning
  children or regenerating assets for a bounded local correction.
- The folder-order expression is parsed once against the immutable host manifest. Known
  files omitted from the expression are filtered out before inspection, planning,
  completion requirements, translation validation, or proofreading. Unknown, duplicate,
  malformed, and empty retained sets still fail fast. Folder proofreading shares the same
  retained set; cross-document Monte Carlo mode is rejected explicitly instead of sharing
  one document's sample state with another. Prompt-settings protocol v24 upgrades existing
  line-review HTML so zh/en help explains that deleting a filename skips it in both flows.
- The parsed folder-order stage is also part of the host inspection/document contract.
  `selectSourceDocument` rejects any document whose earlier stage remains incomplete,
  while files inside the same brace stage remain freely selectable. Translation and
  proofreading order is therefore a host rule rather than prompt advice.
- Child-batch preflight executes before source-manifest resolution. A local repair that
  calls a child tool is rejected before folder traversal, file stats, source reads, task
  planning, or supervisor allocation.

Regression evidence:

- [x] all 85 unit-test files pass, including native Pi compaction, local-correction service
  routing, parent write ownership, large-result bounding, placeholder validation, retained
  folder planning, and translation/proofreading inspection;
- [x] `npm run typecheck`, `npm run build`, and `git diff --check` pass;
- [x] Electron LAN Agent, proposal-review synchronization, folder tab/prompt upgrade, live
  Pi streaming, paired tool results, child interaction/replies, and provider settings pass;
- [x] folder proofreading is split-only in the HTML controls, generated prompt, and
  runtime guard; the same retained-file expression is used by translation and proofreading;
- [x] Electron interactive readiness is 45 ms, optimistic feedback is 8.2 ms, parent
  interaction during children is 5.0 ms, and the dedicated cold-restart recovery run passes;
- [x] after the final fixes, the same independent reviewer re-read the Pi-native paths,
  found no P0/P1/P2 issue, and returned PASS. It also confirmed that no legacy YN
  job/wait/status/transcript runtime is reachable from the product graph.
- [x] release 2.0.0 was rebuilt after the final review. Installer, portable artifact,
  updater metadata, and SHA-256 checksums verify; the packaged portable executable
  reached its renderer with five stable Electron processes and exited cleanly.

## 2026-07-28 Explicit user subagent delegation

- The former local-repair guard incorrectly used `fullWorkflow` for two unrelated
  decisions: enabling the complete generated YN completion contract and authorizing
  native Pi child delegation. That made an explicit user request for subagents fail
  with `Shard subagents are available only to an explicit generated YN workflow prompt`.
- These decisions are now separate. Only the exact generated `Workflow:` marker enables
  the complete glossary/character-bible/workflow completion contract. A typed
  `explicit_user` delegation derived in main from the current user message authorizes
  the same native Pi child runtime without manufacturing a full workflow.
- Explicit delegation honors a numeric count in the user message. Without a count it
  reuses the configured child count, falling back to the existing product default.
  The effective count is read by translation range validation, proofread planning, and
  the folder persistent-worker pool. Renderer input cannot inject this main-only field.
- Native Pi Steer and Follow-up text can authorize delegation during an active turn.
  A model tool call alone cannot authorize itself. A user-delegated bounded translation
  repair may assign partial, non-overlapping ranges; child restricted writers and final
  whole-artifact validation remain mandatory, while unrelated workspace assets do not.
- Delegation authorization is committed only after Pi accepts the user input. A rejected
  Steer/Follow-up cannot leave hidden authorization behind. While a native child batch is
  active, changing its configured worker count is rejected before mutation so the batch's
  completion contract remains stable.
- Count parsing accepts explicit Chinese/English count grammar such as `八个子 Agent`,
  `3 subagents`, and `subagents count: 6`, but does not treat unrelated numbers such as
  the `18` in `请用 subagents 修复第 18 行` as a worker count.
- Regression coverage includes positive Chinese/English requests, explicit count
  override, configured-count reuse, negative/conceptual text, tool-name text, initial
  prompt propagation, rejected-input rollback, active-batch count stability, active-turn
  Steer, unauthorized preflight, and partial-range host planning. All 86 unit-test files,
  focused tests, and typecheck pass. The dedicated Electron Agent verifier passes with
  68 ms interactive readiness, 11.0 ms optimistic feedback, paired tool results, two child
  cards/replies, and 7.3 ms parent interaction during children; cold-restart recovery also
  passes. The independent reviewer rechecked its three previous P1 findings against the
  final worktree and returned PASS.
- [x] Release 2.0.0 was rebuilt after the final review. Installer, portable executable,
  updater metadata, and SHA-256 checksums verify; the actual portable executable reached
  a ready renderer in 5,705 ms with five stable Electron processes.

## 2026-07-28 Prompt-defined Pi children and read/write boundary

- The remaining defect was architectural, not a prompt typo. Explicit user delegation
  still entered the specialized `runTranslationSubagents` host queue, whose job is a
  complete generated translation workflow. It therefore discarded distinct investigation
  or local-repair prompts, reused page defaults, and could restart a whole folder batch.
- Explicit delegation now owns a separate `runSubagents` tool backed by the same native
  `PiSessionAgentRuntime`, child Pi JSONL repository, completion wake-up, and lightweight
  `AgentMessage` card path as every other child. It starts exactly the user-authorized
  count, preserves every distinct prompt, supports read-only investigation and validated
  translation repair, and never activates generated-workflow completion debt.
- Count-only follow-ups such as `叫五个并行` may update an already explicit delegation,
  but cannot authorize children from nothing. A new explicit local task does not inherit
  an incomplete previous generated workflow contract.
- Source discovery now has two consumers. A complete generated folder workflow applies
  the typed file-order/skip expression. A local explicit task reads the immutable complete
  source manifest, so a valid `tips.txt` omitted from the full-workflow order remains
  selectable for investigation or repair. Path containment and source immutability remain
  unchanged.
- Read access is no longer treated as child ownership. General, translation, and proofread
  children receive the same project-level read-only list/search/read tools and may inspect
  source context, existing candidates, glossary, and character bible outside the delegated
  line range. The delegated file/range is only a write boundary: translation candidates and
  findings still pass their host-owned tools and validators, no child gets a generic write
  tool, and the source file remains immutable.
- A related proofread defect was exposed by the full suite: when a range task omitted an
  explicit `documentId`, the child system prompt omitted its actual L1-L2 target. The target
  is now derived from the bound Pi source request, while read access remains unrestricted;
  this prevents one parallel reviewer from submitting another reviewer's line.
- Independent review found one final objective-loss path: when an existing candidate was
  structurally complete but needed a glossary/quality repair, the host resume plan replaced
  the parent's exact child instruction. Resume repair now prefixes that exact instruction to
  the host's line-specific repair evidence. A regression creates a pre-existing glossary-
  invalid candidate and verifies the actual first Pi child user message, not merely the card,
  before completing the validated repair.

Regression evidence before packaging:

- [x] five prompt-defined tasks preserve five distinct prompts and do not call the full
  translation queue;
- [x] local repair selects a valid source omitted from full-workflow order;
- [x] translation and proofread children read project context outside their write range,
  expose no generic write tool, cannot spawn descendants, and leave source bytes unchanged;
- [x] all 86 unit-test files, typecheck, build, and Electron Pi-web verification pass;
- [x] final Electron interactive readiness is 44 ms, optimistic feedback is 9.1 ms, parent
  interaction during children is 5.5 ms, raw-protocol leak is false, tool results pair,
  child replies load from Pi JSONL, and cold-restart recovery passes.
- [x] after the resumed-repair fix, all 86 test files pass again and the same independent
  reviewer re-read the final worktree and returned PASS with no P0/P1/P2 finding.
- [x] release 2.0.0 was rebuilt after the PASS. Installer, portable executable, updater
  metadata, and four SHA-256 entries verify; the final portable reached renderer-ready in
  6,363 ms with five stable Electron processes and exited cleanly.

## 2026-07-28 Bounded local repair prompt boundary

- The reported payload was not a renderer problem. An ordinary parent-owned repair and an
  explicitly delegated bounded repair still reused three complete generated-workflow
  contracts: the global YN system prompt, the full translation-worker prompt/reference
  bundle, and strict whole-artifact quality debt. In the captured 16,664-byte validation
  result, 16,312 bytes (97.9%) were 93 unrelated `glossary_missing` warning entries.
- Generated workflows and local repairs are now distinct typed execution modes. Only an
  exact generated `Workflow: yn-translation-v1` or `Workflow: yn-proofread-v1` prompt gets
  the full host scheduler, asset-building, whole-folder completion, and strict quality
  contract. Ordinary conversation and local repair get a concise objective/range contract;
  they do not receive glossary generation, character-bible construction, the full worker
  queue, or the complete proofread workflow.
- Prompt-defined local repair children still use the same native Pi `Agent`, Pi JSONL,
  provider stream, child ownership, and card path. Their execution mode is
  `bounded_repair`; no legacy runtime, adapter loop, or separate queue was introduced.
  Children may use project read-only tools on demand, while host-owned writers continue to
  enforce the delegated candidate file/range and immutable source boundary.
- Bounded repair acceptance is structural: line identity/count, placeholders, protected
  syntax, and explicit host-required lines remain blocking. Whole-file glossary,
  character/style, and other quality warnings outside the requested repair are compact
  telemetry, not mandatory debt. Full generated workflows retain strict quality acceptance.
- Validation failures and repair plans are bounded: line ranges are compacted, issue samples
  are capped at 32, and omitted counts are reported. Raw whole-artifact findings are not
  returned to either the parent prompt or a bounded child prompt.

Regression evidence before final packaging:

- [x] red tests first proved that the local system prompt contained both complete workflows,
  bounded repair inherited glossary debt, and the child read result injected the complete
  translation reference bundle;
- [x] focused native-Pi domain, repair-plan, child-lifecycle, explicit-delegation,
  host-bounded-turn, completion-integration, session-service, and resume-repair tests pass;
- [x] all 86 test files, typecheck, build, and `git diff --check` pass;
- [x] Electron Pi-web verification passes with 45 ms interactive readiness, 8.9 ms
  optimistic feedback, 7.7 ms parent interaction during children, paired tool results,
  two child cards/replies, no raw-protocol leak, terminal convergence, LAN synchronization,
  compaction, and cold-restart recovery.
- [x] the first independent review rejected the initial green tests because a local write
  could still activate the generated completion gate and compact validation still labeled
  quality warnings as rejected debt. New red tests now execute the parent post-write gate
  and child `validateAssignedTranslation` path. Local completion bypasses generated-workflow
  debt, compact validation has explicit `artifact` versus `chunk` acceptance, all 86 test
  files pass again, and the same independent reviewer returned PASS on the corrected tree.
- [x] release 2.0.0 was rebuilt after the final PASS. Installer (104,825,134 bytes),
  portable executable (104,450,402 bytes), updater metadata, and four SHA-256 entries
  verify. The packaged portable reached a ready renderer in 7,949 ms with five stable
  Electron processes and exited cleanly.

## 2026-07-28 Project settings and canonical workflow assets

- Project-owned prompt settings are persisted in `.translation-workshop/project.json` and
  are shared by every source file and generated HTML page whose project root is the same.
  HTML, React, sibling HTML tabs, and folder views receive the same live project-state
  broadcast, including language pair, style, work description, split size, child enablement,
  child count/model, output paths, glossary options, and proofreading parameters.
- Formal project assets have one main-process authority and one format each: glossary JSON,
  `character_bible.md`, and `style_guide.md`. The old character-bible JSON is migration input
  only; it is converted once under the same serialized asset-write queue and then archived.
  Renderer and HTML code no longer have a direct formal-glossary file writer.
- Glossary edits, complete replacement, generated-candidate import, character edits, and
  style edits all return the canonical saved assets and update every open project surface.
  Empty glossary replacement is also authoritative, so clearing the glossary cannot leave
  stale rows in another HTML tab. Failed writes restore the visible editor instead of
  pretending that a local-only change succeeded.
- `style` and `workDescription` are preserved by the embedded Pi-web workflow metadata and
  cross Electron IPC as typed request data. Parent and child Pi prompts consume the language
  pair, style, work description, approved glossary, Markdown character bible, and style guide;
  the startup asset editors are therefore part of the real translation/proofreading path.
- Regression evidence: all 89 unit-test files, typecheck, build, `git diff --check`, the full
  Electron suite, and the dedicated project-state/assets Electron verifier pass. Project UI
  became interactive in 430 ms; Pi Agent interactive readiness was 66 ms, optimistic user
  feedback 11 ms, and parent interaction during child work 4.6 ms. The final independent
  architecture/product-path review returned PASS with no P0/P1 finding.
- Release 2.0.0 was rebuilt after that PASS. The installer is 104,828,827 bytes, the portable
  executable is 104,454,094 bytes, updater metadata and all four SHA-256 entries verify, and
  the packaged portable reached renderer-ready in 6,684 ms with five stable Electron
  processes.

## 2026-07-28 Character-bible path convergence

- The startup project-assets panel exposed `.translation-workshop/character_bible.md` even
  when that file did not exist, while the Pi workflow generated and consumed
  `AI_translation/_workspace/character_bible.md`. This duplicate path contract caused the
  Windows "cannot find" error despite a completed character bible being present.
- `AI_translation/_workspace/character_bible.md` is now the sole project character-bible
  path for the editor, File menu, parent/child Pi context, and validation. The temporary
  hidden Markdown path and the older JSON shape are migration inputs only. Existing hidden
  Markdown is moved into the canonical Pi workspace on first project read.
- Project assets now publish explicit availability. The React asset list does not create
  open buttons for files that do not exist, and translation-memory display uses the real
  `segmentCount` field rather than the obsolete `totalPairs` name.
- Focused project-asset and workspace-asset tests pass, including the exact reported path,
  hidden-Markdown migration, and unavailable-file UI boundary. The Electron project verifier
  passes with the workflow character-bible path asserted and 353 ms interactive readiness.
## 2026-07-28 Decision-ledger removal

- Removed `.translation-workshop/decisions.jsonl` from the active project-assets contract and UI. The current workflow writes approved glossary and character assets directly, so the separate ledger was unused and misleading.
- Asset proposal approval still updates the canonical glossary or character bible and marks the proposal itself approved. It no longer creates a second decision record.
- Existing `decisions.jsonl` files are left untouched as inert legacy data; product code no longer reads, writes, exposes, or renders them.

## 2026-07-28 Project-enabled delegation and canonical repair tasks

- Latest Pi JSONL showed two product-boundary defects rather than a renderer problem. The
  saved project enabled child Agents, but `runSubagents` still required a magic phrase in
  the current user message. Separately, bounded translation-repair children received a
  vague objective without the canonical source path, candidate path, current target text,
  encoding, or exact line identity, so they wasted turns attempting forbidden source writes.
- The current `.translation-workshop/project.json` is now re-read at the main Pi prompt
  boundary. Its language pair, style, work description, child enable/count/model, folder
  order, split sizes, and proofreading settings override stale metadata embedded in an old
  HTML page before tools or the Pi system prompt are constructed. Invalid typed values fail
  visibly instead of entering the runtime.
- A project-enabled child count is an upper bound for ordinary prompt-defined delegation:
  `runSubagents` accepts one through that configured maximum according to the useful lanes
  the parent has actually located. A user who explicitly requests N children still gets an
  exact-N contract. Generated translation/proofreading workflows continue to use their
  separate host-planned worker tools and exact workflow count.
- Every `translation_repair` child task is normalized by the host into a canonical contract:
  immutable absolute source path, absolute current candidate path, UTF-8, exact inclusive
  1-based range, aligned current translation entries, and the restricted validated candidate
  writer. Children retain project read access, but have no generic writer, no source writer,
  and no nested-child tool.
- The saved `style_guide.md` is loaded through the production Pi system-prompt composition
  path for the parent and through the same project asset authority for general children. The
  injected guide is bounded to 24,000 characters so a malformed project asset cannot consume
  the whole model context.
- Proposal application exposed a separate Electron ordering race: the linked line-review
  BrowserView became visible before its accepted edit state was applied, producing one stale
  frame and letting callers observe the old translation. State is now applied while the view
  is detached, then the completed line-review tab is activated.

Regression evidence:

- [x] 89 unit-test files pass, including project-state override, project-enabled 1..N child
  delegation, explicit exact-N delegation, real product style-guide composition, canonical
  translation-repair context, source immutability, and no nested children;
- [x] typecheck/build and `git diff --check` pass;
- [x] the full Electron suite passes: Agent interactive readiness 46 ms, optimistic feedback
  8 ms, parent interaction during children 8 ms, paired tool results, visible child replies,
  no raw-protocol leak, terminal convergence, LAN Agent synchronization, proposal apply,
  compaction, and cold-restart recovery.
- [x] after the final evidence rerun, the same independent reviewer cleared its only
  proposal-verifier evidence concern and returned PASS with no remaining P0/P1/P2 finding.
- [x] release 2.0.0 was rebuilt after PASS. The installer is 104,829,310 bytes, the
  portable executable is 104,454,581 bytes, updater metadata and four SHA-256 entries
  verify, and the packaged portable reached renderer-ready in 8,546 ms with five stable
  Electron processes.

## 2026-07-29 Folder repair source authority and child quality gate

- The latest parent and child Pi JSONL disproved the visible diagnosis that a repair child
  had not received its output path. Its canonical child prompt contained the immutable
  absolute source path, absolute `AI_translation/[name]_translated.txt` candidate path,
  UTF-8 encoding, and exact line range. The real failure was a stale single-file HTML
  manifest: the project had already become a folder project, but the runtime still rejected
  `tips.txt` because the old route remained bound to `script.txt`.
- `.translation-workshop/project.json` is now authoritative for `sourcePath`, `sourceKind`,
  `sourceSelection`, and split size at every Pi prompt boundary. Current folder metadata
  replaces stale HTML route metadata before the parent runtime, source manifest, domain
  tools, or child contract is constructed. Legacy HTML metadata remains navigation input,
  not product runtime authority.
- A child write no longer manufactures copied-source filler for rejected or omitted lines.
  Valid keyed translations are retained, unresolved physical lines remain explicitly empty,
  and the same child Pi session receives bounded absolute-line repair debt. Exact source
  copies, source-language residue, and generic filler such as `这是中文翻译` or `（本段译文）`
  cannot satisfy chunk or final artifact acceptance.
- Project child count is an upper bound for autonomous bounded repairs, not a target. The
  parent must first locate concrete files and lines, then use at most
  `ceil(repairLines / splitSize)` useful lanes up to the configured maximum. An explicit
  user exact-N request remains authoritative. A confirmed actionable project complaint must
  continue through correction and validation in the same parent turn instead of ending at
  an apology or diagnosis.

Regression evidence:

- [x] red tests reproduced the stale folder/file manifest, mechanical five-child repair,
  copied-source acceptance, and generic Chinese filler acceptance before the fixes;
- [x] all 89 unit-test files, typecheck, build, and `git diff --check` pass;
- [x] Electron Pi-web verification passes with 66 ms interactive readiness, 8.6 ms
  optimistic feedback, 6.9 ms parent interaction during children, paired tool results,
  visible child replies, no raw-protocol leak, terminal convergence, LAN synchronization,
  compaction, folder manifests, and cold-restart recovery.
- [x] the independent final reviewer returned PASS after verifying that live folder scanning is
  authoritative, stale folder-document metadata is discarded on source-identity changes, and
  extracted mappings can override a document id only for a still-existing EPUB source.
- [x] release 2.0.0 was rebuilt after the final PASS. The installer is 104,830,150 bytes,
  the portable executable is 104,455,423 bytes, updater metadata and four SHA-256 entries
  verify, and the packaged portable reached renderer-ready in 6,906 ms with five stable
  Electron processes.

## 2026-07-30 Managed child write registration and parent continuation

- The remaining `not in this workflow manifest` failure was inside host accounting, not
  translation quality and not the Pi child prompt. `runSubagents` resolved the correct
  source manifest, but only `inspectTranslationContext` registered those documents in the
  domain completion contract. A prompt-defined repair child could therefore write the
  correct candidate bytes and then fail in the post-mutation callback when the domain
  contract tried to account for a document it had never been told about.
- The host source manifest is now registered with the domain contract as soon as
  `ensureManifest` resolves it, before any child runtime or candidate write can start.
  `recordInspection` reuses that same registration operation instead of owning a second
  document list. The source manifest, child write boundary, and artifact-completion ledger
  therefore share one document identity.
- Prompt-defined/general child batches now create explicit host completion debt. Start,
  failure, and terminal settlement are recorded by batch id and expected count. A failed
  explicitly requested child cannot be bypassed by a parent direct write or final-validation
  call; the parent Pi Agent receives a native hidden follow-up and must launch a replacement
  bounded task or otherwise satisfy the same delegated objective.
- The old two-status-turn termination cap was removed. Repeated parent replies that merely
  say they are waiting, diagnose the failure, or promise later work do not complete the YN
  contract. Pi native continuation keeps returning the concrete unresolved child/validation
  debt until host-observed progress occurs, while Stop remains the explicit cancellation
  path.
- Subagent settlement-accounting errors no longer suppress the parent wake-up. They convert
  the batch to a visible failed terminal state and send that failure back through the same
  Pi completion-follow-up path.
- The earlier green test was insufficient: it asserted that candidate bytes changed, but a
  child write physically publishes atomically before its domain accounting callback runs.
  Tests now require one terminal `completed` child card, the child's managed write and
  `validateAssignedTranslation`, and the parent's later `validateTranslationArtifact`.
  A second integration test forces a failed child plus three consecutive status-only parent
  replies, then proves replacement-child repair and final validation in the same Pi session.

Regression evidence:

- [x] all 90 unit-test files pass, including the new real Pi parent/child integration tests;
- [x] typecheck, build, `git diff --check`, and the complete Electron Agent/HTML suite pass;
- [x] real Electron with the configured GPT-5.6 Terra and project proxy became interactive
  in 153.9 ms and showed the user message in 10.9 ms;
- [x] one real child replaced `（本段译文）` with `你好 {player_name}`, preserved the
  placeholder, completed its managed validation, and closed cleanly;
- [x] after that child completed, the parent Pi Agent automatically resumed, called
  `validateTranslationArtifact`, passed the complete four-line candidate, reported the
  result, and returned to idle in 64.8 seconds;
- [x] screenshot evidence is stored at
  `artifacts/electron-agent-real-bounded-repair-complete.png`.

Final acceptance refinement:

- A successful bounded child mutation now leaves mandatory parent-owned whole-artifact
  validation debt. Direct parent writes cannot erase that debt, so a status-only parent
  reply or a child `completed` card cannot end the Pi loop before host validation.
- Bounded folder validation reads only document ids with a newer artifact revision; it does
  not demand candidates for unrelated manifest documents. A generated full workflow still
  validates every retained manifest document.
- Bounded repair final validation uses the same `chunk` acceptance boundary as its managed
  write: line alignment, placeholders, generic filler, copied source, and likely-untranslated
  residue remain blocking. Existing glossary, character, voice, and style warnings remain
  compact telemetry instead of becoming permanent completion debt. Full generated workflows
  retain strict `artifact` acceptance for those quality rules.
- The independent reviewer rejected the work twice before PASS: first because a successful
  child did not force parent final validation, then because bounded folder validation scanned
  unrelated files. Its final review also found the quality-warning deadlock; after the
  acceptance split above it returned PASS with no remaining blocker.
- The final real Electron rerun used the configured GPT-5.6 Terra through the production Pi
  provider path. The user turn painted in 8.0 ms, one real child repaired and validated the
  managed placeholder sentence, the parent automatically resumed and ran final validation,
  and the session returned to idle in 35.9 seconds. Interactive readiness was 664.8 ms. The
  final screenshot and renderer console contained no missing verifier IPC handler error.
- The complete Electron suite reports 46 ms interactive readiness, 8.3 ms optimistic paint,
  and 11.7 ms parent interaction while children run; raw-protocol leak and duplicate tool
  bubbles remain false. All 90 unit-test files, typecheck, build, and the final reviewer pass.
- [x] Release 2.0.0 was rebuilt only after the final reviewer PASS. The installer is
  104,831,797 bytes, the portable executable is 104,457,070 bytes, updater metadata and all
  four SHA-256 entries verify, and the packaged portable reached renderer-ready in 7,679 ms
  with five stable Electron processes.

## 2026-07-30: Child Count Provenance And Host Constraint Audit

Root cause:

- The project child setting and an explicit current-turn count were represented by the same
  unqualified `count`. When the parser missed the trailing phrase `还是叫两个来修复`, it
  fell back to the configured value `5`; downstream Host code then treated that fallback as
  the user's exact request and rejected a valid two-task repair batch.
- A separate Host formula also promoted `ceil(repairLines / splitSize)` from planning advice
  into a rejection rule. That prevented the parent Pi Agent from using several independent
  repair objectives inside the configured `1..N` range.
- Monte Carlo proofreading similarly required a complete configured worker round even when
  fewer useful unsampled lines remained.

Corrected contract:

- `PiExplicitSubagentDelegation` now carries `countMode: "exact" | "up_to"` across the
  session request, system prompt, domain run, and Host tools. Only a number stated in the
  current user instruction is exact. Project configuration and an unnumbered child request
  are upper bounds.
- The current-turn parser covers the real trailing-count wording and retains the existing
  protection that count-only wording cannot create hidden delegation authorization.
- `runSubagents` now enforces the actual Host boundary `1..N`, exact ranges, non-overlap,
  immutable source ownership, and validation. Line-count efficiency remains a parent-Agent
  heuristic rather than a second Host count.
- Monte Carlo tail rounds use the remaining useful `1..N` workers instead of failing because
  a complete configured pool cannot be filled.
- The full classification of retained safety invariants and coarse follow-up constraints is
  recorded in `docs/pi-native-host-constraint-audit.md`. In particular, one global active
  batch, global source-selection/write locks, byte-complete proofreading-reference reads,
  and one-attempt non-persistent assignments remain visible P1 redesign work; they were not
  silently declared permanent or removed without ownership replacements.

Regression evidence:

- [x] focused exact/up-to, domain-run, Host-tool, session-service, and proofread-plan tests pass;
- [x] typecheck passes;
- [x] all 90 unit-test files pass;
- [x] full Electron Agent/HTML verification passes with 69 ms interactive readiness,
  12.6 ms optimistic user paint, 13 ms parent interaction during child execution, paired
  tool results, visible child replies, shared popout state, and no raw protocol or duplicate
  tool bubble leak;
- [ ] independent review pending before release rebuild.

Independent-review correction:

- The first review correctly rejected this change because the original fix covered only
  prompt-defined `runSubagents`. Full single-file translation still required exactly the
  configured count, and Monte Carlo planning could choose two workers while completion
  continued waiting for five.
- `requiredWorkflowSubagents` / `requestedSubagents` were removed from the contract and
  renamed to maximum-count terminology. Project configuration is now an upper bound in
  every workflow path.
- A specialized child batch records its actual accepted task count when it starts. A
  successful settlement must return exactly that many results. Completion therefore
  accepts any useful `1..N` batch without weakening failure detection, whole-source
  coverage, source immutability, range non-overlap, artifact validation, or Monte Carlo
  convergence.
- Folder translation remains a work queue: it may contain more than `N` assignments while
  running no more than `N` persistent workers. `N` is concurrency, never an assignment
  quota.
- The specialized batch-start contract now stores `workerCount` and `taskCount` separately.
  Exact current-user counts compare only with live workers; completion compares returned
  results with accepted assignments. An ordinary project maximum also shrinks to the useful
  assignment count instead of creating idle workers just to fill `N`.
- Full generated workflows no longer discard current-user count provenance. Canonical
  generated `up to N` wording remains the project ceiling, while a number explicitly stated
  in the current work description reaches the typed runtime and Host contract as `exact`.
- [x] red regressions reproduced both remaining review findings;
- [x] focused Host-tool, domain completion, domain contract, prompt, and Monte Carlo tests pass;
- [x] typecheck passes;
- [x] all 90 unit-test files pass on the corrected worktree;
- [x] the same independent reviewer returned PASS after verifying exact five workers with
  six/eight assignments, full-workflow exact provenance, ordinary `1..N`, and retained
  integrity gates;
- [x] the final Electron Agent/HTML suite passed on the corrected worktree: 44 ms interactive
  readiness, 27.3 ms optimistic user paint, 12.1 ms parent interaction while two child
  runtimes were active, paired tool results, visible child replies, shared popout state,
  cold-restart convergence, `rawProtocolLeak=false`, and `duplicateToolBubble=false`;
- [x] the 2.0.0 Windows installer and portable package were rebuilt, release checksums passed,
  and the packaged portable executable reached its real renderer with five stable processes.

## 2026-07-30: Existing Translation Reuse Audit And Resume

Root cause:

- Restarting a translation treated every pre-existing candidate as either trusted work or a
  disposable artifact. Trusting it preserved generic filler, copied source, and missed
  translations; discarding it destroyed valid user and Agent work after an interruption.
- Placeholder prose is often much shorter than its source, but a length/regex-only gate also
  rejects legitimate short translations such as a one-word answer or UI label. Repeated target
  text is similarly suspicious only when several distinct source lines collapse to the same
  candidate; repeated dialogue for the same source is valid.
- A current workflow's own retry could previously rediscover its just-written candidate and
  confuse it with work that existed before the run.

Corrected contract:

- `translationReuseAudit.ts` owns one persisted, source/candidate-hash-bound audit per document
  and writes a backup under `.translation-workshop/translation-reuse-backups/` before applying
  any decision. Changed inputs restart the audit instead of reusing stale verdicts.
- Deterministic line-count/placeholder/empty-line violations force `retranslate`. A fast sieve
  adds `very_short_relative_to_source`, `severe_length_compression`, and
  `repeated_candidate_for_distinct_sources` signals. These signals prioritize review; they are
  never final semantic proof and cannot be recorded as direct `reuse`.
- Every other non-empty candidate line is audited by a read-only native Pi child with source,
  candidate, and nearby context. The child records `reuse`, `review`, or `retranslate`; it cannot
  write translation artifacts. The parent then asks once through the ordinary Pi conversation
  whether to retain accepted lines, retain them with review, or discard the old candidate.
- Applying the choice preserves accepted lines, blanks only rejected lines, and returns the
  existing host-owned translation queue to those missing ranges. Applied audits resume after a
  restart, including the fully-reused case. `domainRun.ownsCurrentTranslationArtifact()` keeps
  artifacts written by the current run out of the pre-existing-work path.

Regression evidence:

- [x] focused reuse-audit, semantic-child, domain-tool, session, and resume-mask tests pass;
- [x] all 96 unit-test files pass;
- [x] typecheck and build pass;
- [x] the complete Electron Agent/HTML suite passes with 45 ms interactive readiness, 19.3 ms
  optimistic user paint, and 17.5 ms parent interaction while children run;
- [x] the same Electron run created and validated both files in the two-worker folder UI path,
  preserved paired tool results and child replies, recovered a stopped child card after cold
  restart, and reported `rawProtocolLeak=false` and `duplicateToolBubble=false`;
- [x] the real Electron bad-sample rerun used the configured GPT-5.6 Terra and the saved project
  proxy: the UI became interactive in 238.1 ms, the user turn painted in 18 ms, one native Pi
  child replaced `（本段译文）` through the managed candidate tools, child validation passed, the
  parent automatically continued to whole-artifact validation, and the run returned idle in
  51.9 seconds. Evidence is `artifacts/electron-agent-real-bounded-repair-complete.png`;
- [x] independent final review returned PASS after the duplicate-verdict and physical-path
  hardening below; the subsequent 2.0.0 release rebuild remains pending.

Post-review hardening:

- Persisted audit source/candidate/backup paths are revalidated on every read, verdict write,
  and apply. Candidate writes are restricted to the project's `AI_translation` tree, so edited
  audit metadata cannot redirect a write outside the managed artifact boundary.
- A direct user answer after `PiNativeSessionService` restart rehydrates the persisted
  awaiting-decision audit, preflights domain ownership, then applies and records the decision.
  The candidate is never changed before ownership preflight succeeds.
- Semantic verdict batches append to a per-audit JSONL journal until apply instead of rewriting
  the complete line audit after every batch. Apply compacts the hydrated audit and removes the
  journal; a 400-line regression test proves the main audit store stays byte-size stable.
- Reuse-audit workers now keep one native Pi child session/runtime across queued assignments;
  the child JSONL regression proves both turns remain in the same session.
- The Electron product-path verifier now creates one mixed valid/placeholder candidate, runs
  the generated folder prompt through the embedded Pi UI, waits for the native audit child,
  captures the ordinary user-decision prompt, disposes the workspace runtime, then submits the
  user's choice through the real composer. The restarted service persists a paired
  `applyTranslationReuseDecision` result, keeps the accepted line, and blanks only the rejected
  placeholder line for sparse Host-owned continuation.
- After these changes all 96 unit files and the complete Electron verifier passed again.
  The final rerun measured 76 ms to interactive and 15.7 ms optimistic paint; native streaming,
  child cards/replies, compaction, folder workflow, shared popout, and cold restart remained
  healthy.
- One verdict is now durable for exactly one semantic line: journal replay shares one line-id
  set across the entire JSONL file, and a later batch cannot overwrite an already hydrated
  verdict. Both the normal write API and a manually duplicated journal row have red regressions.
- Lexical canonical-path checks are no longer the write boundary. Source and candidate files are
  revalidated through `realpath`; the physical `AI_translation` root must remain inside the real
  project root, and the candidate must remain inside that real translation root. A regression
  swaps the audited candidate directory for a Windows junction before apply and proves the
  external file remains byte-identical. Backup writes receive the same physical project-root
  check.
- [x] the same independent reviewer re-examined the final worktree and returned PASS with no
  P0/P1 findings;
- [x] focused reuse/session tests, typecheck, all 96 unit files, full Electron Agent/HTML and
  `git diff --check` pass on that reviewed worktree;
- [x] rebuilt and verified the Windows 2.0.0 installer and portable artifacts from this exact
  PASS worktree. `verify:release` validated checksums for the 104,839,962-byte installer and
  104,465,235-byte portable executable. The real portable launch reached its renderer in
  8,413 ms with five stable Electron processes and the expected `translation-workshop` window.

## 2026-07-30: Host Quick Scan Before Existing-Work Semantic Review

Root cause:

- The first resumable existing-work audit correctly stopped regex/length heuristics from
  discarding valid short translations, but overcorrected by sending every non-empty aligned
  line to Pi children in fixed 80-line tasks. Large mostly-valid candidates therefore paid a
  full semantic proofreading cost before translation could resume.
- The product already had deterministic source-residue, placeholder/tag/alignment, glossary,
  character, style, AI-contamination, and excessive-expansion checks. The reuse path used some
  of them only as child priority hints instead of using their negative result to keep ordinary
  lines out of model context.

Corrected contract:

- `translationReuseAudit.ts` now has three explicit dispositions. Structural/blocking failures
  are `must_retranslate`; non-target-language text, copied/high-overlap source residue, abnormal
  compression or expansion, distinct-source repetition, AI contamination, and project-asset
  rule hits are `semantic_review_required`; aligned target-language lines with no such signal
  are `automatic_reuse`.
- The quick scan reuses `validateTranslationCandidate`, `looksLikeSourceResidue` through that
  validator, and `buildProofreadDeterministicSignals`. It adds only target-script evidence for
  the configured language pair and the reuse-specific compression/repetition comparisons.
- `planTranslationReuseAuditTasks` now receives only unresolved high-risk line numbers and
  groups only contiguous risk ranges. Ordinary reusable lines are neither serialized into
  child prompts nor charged as model review work. The 80-line tool boundary is now a cap on a
  high-risk range, not a full-document semantic scan.
- Automatic reuse is still not final proofreading. The user retains the same one-time
  reuse/review/discard decision, hash-bound restart recovery, immutable source boundary,
  candidate backup, and sparse Host-owned continuation for rejected lines.

Regression evidence:

- [x] red tests cover ordinary target-language auto reuse, non-target-language text, exact and
  high-overlap source residue, severe compression, excessive repetition, punctuation-only
  output for lexical source text, preservation-only punctuation, and risk-only task ranges;
- [x] a persistent native Pi audit child processes two separated high-risk ranges while the
  clean line between them remains automatic and absent from child ownership;
- [x] focused reuse-audit tests, typecheck, and all 96 unit-test files pass;
- [x] independent review found and verified fixes for three boundary bugs: `discard_existing`
  now removes automatic lines too; copied-source blocking findings remain semantic risk rather
  than deterministic rejection; and lexical source text paired with punctuation-only output
  cannot auto-reuse;
- [x] the same independent reviewer re-examined the exact final worktree and returned PASS;
- [x] complete Electron product-path verification passes with 58 ms interactive readiness,
  18.7 ms optimistic user paint, 10.1 ms parent interaction while children run, one risk-only
  reuse child, durable restart choice, paired tool results, visible child replies,
  `rawProtocolLeak=false`, and `duplicateToolBubble=false`;
- [x] rebuilt and verified the Windows 2.0.0 installer and portable artifacts from this reviewed
  worktree. `verify:release` validated checksums for the 104,841,126-byte installer and
  104,466,359-byte portable executable; the real portable launch reached its renderer in
  8,441 ms with five stable Electron processes and the expected `translation-workshop` window.

## 2026-07-31: Pi-Native Proofreading Prescan And Durable Host State

Root cause:

- Proofreading phase state originally lived in one `createYnDomainTools` closure. A later
  parent turn or a cold Electron restart could therefore lose the hash-bound deterministic
  prescan, sampled-line history, semantic coverage, and pending glossary candidates even
  though the Pi conversation itself remained durable.
- Monte Carlo planning treated HOT/WARM/COLD rates as relative weights, allowed a region to
  re-enter after reaching the 80% coverage threshold, and did not make `(line, issue code)`
  the authoritative merge identity. Repeated child results could inflate convergence counts.
- Parent read receipts were accepted as semantic review evidence, and child glossary
  candidates had no typed parent decision gate. That let the workflow reach finalization
  without proving semantic review or resolving shared-asset proposals.

Corrected contract:

- The Host always completes the full aligned H3/H4/H7/H8/H9 deterministic prescan before it
  may start any Pi semantic child. Split children review every owned row in Host-queued blocks
  of at most `splitSize`; persistent workers claim later blocks dynamically. Monte Carlo
  children review only the Host's explicit, non-repeating sampled rows.
- Compact proofreading state is persisted as the invisible Pi JSONL custom entry
  `yn.host-state.v1`. It is owner-scoped, hash-bound, restored on cold restart, serialized with
  parent tool transitions, and excluded by Pi `Session.buildContext()` from model messages.
  There is no parallel YN session or workflow state machine.
- HOT/WARM/COLD use absolute per-round region caps of 30%/15%/5%. Sampling never repeats a
  line, and a region at 80% cumulative coverage is permanently retired. Findings merge by
  `(sourceLine, issueCode)`; exact duplicates are no-ops and conflicting duplicates fail
  visibly for parent resolution.
- Parent-owned proofreading must explicitly call the typed semantic-review recorder after
  reading the exact aligned rows; reads alone cannot satisfy coverage. Child proper-term
  candidates are stored structurally, deduplicated, and require typed parent accept/reject
  decisions. Any pending candidate blocks final report finalization; accepted entries alone
  enter the validated generated glossary candidate artifact.
- Packaged child guidance now names only the actual Pi child tools:
  `readProofreadReference`, `readAssignedProofreadContext`, and `writeAssignedFindings`.
  Obsolete `completeTask` and direct shared-asset mutation protocols are absent.
- Parent findings use a two-phase Host transition. A read-only semantic-coverage preflight
  runs before report reset or disk mutation; only a successful atomic findings write commits
  `findingsWritten` and its artifact revision. An idempotent duplicate can recover a previously
  present report without manufacturing another revision, while a failed write cannot forge
  completion state. The product-path regression proves a rejected preflight leaves the report
  byte-identical and a later typed-review retry can finalize cleanly.

Regression evidence:

- [x] focused proofreading state, completion, prescan, planner, child-runtime, skill-contract,
  findings-writer, two-phase parent-write, and completion-integration tests pass;
- [x] `npm run typecheck`, all 99 unit-test files, `npm run build`, and
  `git diff --check` pass;
- [x] the complete Electron Agent/HTML verifier passes with 45 ms interactive readiness,
  12.9 ms optimistic user paint, 7.2 ms parent interaction while children run, visible child
  replies, paired tool results, Pi compaction, shared popout state, and cold-restart recovery;
  it reports `rawProtocolLeak=false` and `duplicateToolBubble=false`.
- [x] the same independent reviewer first rejected the parent findings side-effect ordering,
  then re-read the corrected two-phase product path and returned PASS with no P0/P1/P2
  findings after the full unit and Electron suites were rerun.

## 2026-08-01: Pi-Native Retry, Translation Line Identity, And Bounded Re-Proofread

Root causes:

- Parent provider transport errors were persisted as terminal Pi assistant errors. Child
  assignments already had a bounded same-session retry wrapper, but the foreground parent did
  not use Pi coding-agent's native retry lifecycle. A transient `fetch failed` therefore ended
  the visible turn and left the user to send another message.
- Equal source/candidate line counts proved only the shape of an artifact, not semantic line
  identity. A translation could merge one source line into its neighbor, split another line,
  repeat text, or compensate adjacent lengths while still passing the original validator.
- The full-proofread completion contract was also applied to a later bounded re-proofread.
  This incorrectly required the whole deterministic prescan before a small changed range could
  be checked again.
- Proposal apply treated any mismatch from the proposal's old snapshot as a conflict, even when
  the canonical current line already equaled the accepted suggestion. Reopening the review HTML
  could therefore show a false `patch-conflict` for an already-applied change.

Corrected contract:

- The foreground `PiSessionAgentRuntime` now uses the source behavior of Pi coding-agent's
  `_prepareRetry`: `isRetryableAssistantError`, visible `auto_retry_start/end` events, abortable
  exponential backoff, removal of only the failed in-memory assistant tail, and native
  `Agent.continue()` in the same Pi turn. The failed attempt remains in Pi JSONL for diagnosis.
  Non-retryable quota/auth errors remain terminal. Child runtime retry is disabled so the
  existing assignment-level retry remains the single owner and attempts are not multiplied.
- Every completed multi-line translation candidate now needs a hash-bound Host semantic
  alignment audit covering every row, not a statistical sample. The Host pages pending rows in
  bounded groups of 100 so the Pi context never receives a full-document line-number array at
  once. Mechanical signals highlight adjacent length compensation, repeated candidates for
  distinct sources, and severe compression/expansion, but never decide semantics by themselves.
  The parent must read exact source/candidate rows and record an evidence-backed
  `aligned|misaligned` verdict for all rows. A stale candidate hash invalidates the audit and
  final validation cannot bypass it.
- `inspectProofreadRange` creates a hash-bound local scope and `writeProofreadFindings(scopeId)`
  accepts only findings in that range. This path deliberately does not activate or satisfy the
  full-proofread prescan/completion contract; full proofreading keeps all existing gates.
- Proposal apply checks source identity first, then treats a current canonical line already
  matching the suggestion as idempotently applied. It resolves the issue without adding a fake
  revision or conflict card.

Regression and product evidence:

- [x] red tests cover transient parent recovery, non-retryable errors, an actual Stop during
  retry backoff, child retry ownership, equal-count shifted/merged/padded translations including
  a 240-row swap outside the first bounded page, stale/read-bound alignment evidence, bounded
  local re-proofread that cannot satisfy full completion, and idempotent proposal reopen;
- [x] `npm test` passes all 99 test files and `npm run verify:electron-agent-html` passes the
  complete LAN, proposal, folder, embedded Agent, popout, compaction, and cold-restart suite;
- [x] the final Electron rerun measured 56 ms to interactive, 10.8 ms optimistic user paint,
  and 9.8 ms parent interaction while children run. The real retry UI showed retry `1/3`,
  recovered in the same user turn, then a second run clicked the actual Stop button during
  backoff and proved no second provider request/reply occurred. Evidence is
  `artifacts/electron-agent-native-provider-retry.png`;
- [x] the same run reported `providerAutoRetry=true`, `rawProtocolLeak=false`,
  `providerAutoRetryAbortable=true`, `duplicateToolBubble=false`, paired tool results, visible
  child replies, stable session deletion, and cold-restart terminal convergence;
- [x] independent review initially rejected the 2% alignment sample and two missing acceptance
  assertions. After full-row paged alignment, the retry-start AbortController race fix, real
  Electron Stop coverage, and full-domain non-completion assertions, the same reviewer reran
  focused tests and returned PASS with no P0/P1/P2 findings;
- [x] rebuilt and verified Windows 2.0.0 from this exact PASS worktree. `verify:release`
  validated checksums for the 105,098,057-byte installer and 104,723,282-byte portable
  executable. The real portable launch reached its renderer in 6,724 ms with five stable
  Electron processes and the expected `translation-workshop` window.

## 2026-08-01: Bounded Finding Replacement And Folder Batch TXT Writeback

Root causes:

- A bounded re-proofread still merged into the project-wide findings report. An old finding
  retained its pre-fix `currentTranslation`, so a correct second review could neither replace
  nor remove it without tripping the global conflict rule.
- Folder line-review pages saved edits per visible child, but there was no Host-owned operation
  that materialized every child's current state into its corresponding TXT. Legacy batch HTML
  can also live at the project root, so treating only paths already beneath
  `.translation-workshop/html` as state-owning documents rejected valid upgraded children.

Corrected contract:

- `inspectProofreadRange` now yields the only range accepted by bounded
  `writeProofreadFindings`. The writer atomically removes every stale finding touching that
  exact range before validating and merging the new result. An empty result is a valid checked
  outcome that clears the old range; findings outside the scope are untouched. Full
  proofreading continues to use the project-wide report and completion gates.
- The folder viewer exposes one compact `Write all TXT` / `批量写入 TXT` command. Its renderer
  sends no file paths or text payloads. Main resolves the open batch index from the Electron
  sender, validates every child through the existing batch membership/symlink boundary, reads
  the child `reviewData` plus its persisted sidecar, overlays edits on the latest bound target,
  and preflights every destination before writing.
- Existing translation targets keep their current disk content outside edited rows. Missing
  targets use the canonical `AI_translation/<relative source>_translated.txt` resolver.
  Source-file destinations and duplicate destinations fail visibly. Actual writes reuse the
  same candidate lock, backup, and atomic writer as the single-file `Write TXT` path.
- Each batch child now persists to its own project sidecar. A legacy root-level batch may save
  a child only when that child is an explicit member of the batch index; its state is still
  stored under the project's `.translation-workshop/state`, never beside the HTML.
- Sidecar writes are serialized per state path and use the shared atomic file writer. The
  active child snapshots and sends each save immediately, exposes an awaited flush to the
  parent batch page, and the Host drains all accepted sidecar queues before TXT preflight.
  Therefore an edit followed immediately by `Write all TXT` cannot read an older sidecar.

Regression and product evidence:

- [x] focused tests cover scoped replacement/clear, out-of-scope preservation, paired Host
  scope propagation, sidecar overlays, canonical nested target creation, source protection,
  path traversal rejection, legacy batch ownership, and protocol-v4 upgrade;
- [x] `npm test` passes all 100 test files and `git diff --check` reports no whitespace error;
- [x] the complete Electron Agent/HTML verifier passes with `batchTxtWrite=true` and
  `boundedReproofreadReplacement=true`. It edits a real folder child, waits for that child's
  real batch command immediately without waiting for the sidecar, verifies all three writes
  complete, and proves the flushed sidecar contains the edit while the
  source file stayed byte-identical. The same run reports 45 ms interactive readiness,
  25.5 ms optimistic paint, `rawProtocolLeak=false`, and `duplicateToolBubble=false`.
- [x] independent review first found the immediate-click sidecar race. After per-path atomic
  serialization, child flush, Host drain, and the stricter Electron scenario were added, the
  same reviewer returned PASS with no P0/P1/P2 findings and no fake acceptance concern.
- [x] rebuilt Windows 2.0.0 from this exact reviewed worktree. Release verification checked the
  105,100,762-byte installer and 104,726,029-byte portable executable against
  `release/SHA256SUMS.txt`. The portable executable then launched for real, reached the
  `translation-workshop` renderer in 9,473 ms, and remained stable with five Electron
  processes.

## 2026-08-01: Per-Chunk Mechanical Scan And Focused Parent Review

Root cause:

- The previous line-identity fix moved semantic review to one whole-document pass after every
  child had finished. That proved more than equal line counts, but it made feedback arrive too
  late, required the parent to inspect an impractical number of clean rows, and made a failed
  chunk harder to return to its original persistent worker after later chunks had already been
  merged.
- A parent-notification race could enqueue a duplicate reminder while the next hidden Pi review
  message was still being delivered. The duplicate turn could consume the model response meant
  for the real child-completion notification.
- The first implementation kept the paused-child review resolver inside one transient Host-tool
  instance. Pi legitimately rebuilds tools on a later parent turn, so the parent could record an
  accepted audit without waking the exact child promise that owned it.
- Concurrent folder reviews initially reused `selectSourceDocument` to read another worker's
  chunk. That mutates parent session state and is forbidden while the batch is active. A chunk
  ending in an empty row also lost that final owned row because `splitTextLines` intentionally
  drops a terminal newline; the shortened scope changed its hash and could replace the notified
  audit id, leaving the original child paused forever.

Corrected contract:

- Every Host-sized translation chunk now closes before its worker advances. The Host
  mechanically scans every row for structural debt and high-probability semantic-risk signals,
  then creates one hash-bound audit containing every flagged row plus a deterministic clean-row
  sample bounded by `min(32, ceil(sqrt(chunkLength)))`.
- The parent receives that audit through the native Pi follow-up path, reads both sides of every
  selected row, and records explicit `aligned|misaligned` verdicts. Rejection carries exact line
  numbers and reasons back to the same child session; the same worker repairs and re-enters the
  gate before it may claim another assignment.
- Final whole-artifact validation no longer asks for a second full-row semantic pass. It checks
  the ordinary whole-file mechanical/structural contract plus gap-free, non-overlapping, current
  accepted chunk-review evidence. Any candidate-slice hash change invalidates that chunk's prior
  acceptance.
- Parent notification state distinguishes `deliveryPending` from delivered-but-unresolved. A
  reminder is available only for the latter, so the next review cannot be queued twice while its
  original native Pi message is in flight.
- The resolver for a pending chunk review now belongs to the session-scoped subagent supervisor,
  not a particular parent tool construction. Exact concurrent reviews bind a private
  `activeTranslationChunkReview` read context, so `readSourceLines` and
  `readTranslationLines` inspect the requested document without changing the parent's selected
  source. Range audits carry an explicit owned `toLine`; semantically empty trailing rows remain
  covered by the chunk evidence even though they need no model sample.

Regression and product evidence:

- [x] focused tests prove every mechanical risk plus bounded deterministic clean sampling, exact
  same-child rejection and repair, queue advance only after acceptance, stale candidate-hash
  rejection, coverage-gap rejection, duplicate-notification suppression, concurrent worker
  lifecycle, and final validation after two native parent review turns;
- [x] the translation child guide and product system prompt now describe the same immediate
  per-chunk closed loop and explicitly reject a deferred whole-document semantic pass;
- [x] `npm test` passes all 102 test files, `git diff --check` reports no whitespace error, and
  the complete Electron suite passes LAN, legacy upgrade, embedded/popout Agent, compaction, and
  cold restart. The Agent verifier measured 67 ms interactive readiness, 12.2 ms optimistic
  paint, and 7.8 ms parent response while two children ran. It reports
  `perChunkReviewWorker=true`, `reviewedChunkCount=2`, and
  `folderConcurrentReviewWithoutSourceSwitch=true`; screenshots are
  `artifacts/electron-agent-native-subagents-live-interaction.png` and
  `artifacts/electron-agent-native-subagent-replies.png`;
- [x] an independent read-only review found no P0/P1/P2 issue and returned PASS. It confirmed
  the single Pi core/JSONL/`AgentMessage[]` product path, session-scoped same-child resolver,
  all-risk-plus-bounded-sample policy, concurrent folder review without source mutation,
  hash-bound final gate, and non-fake Electron event path;
- [x] rebuilt Windows 2.0.0 from the reviewed implementation. `verify:release` validated
  checksums for the 105,109,038-byte installer and 104,734,260-byte portable executable. The
  portable executable then launched for real, reached the `translation-workshop` renderer in
  6,887 ms, and remained stable with five Electron processes.

## 2026-08-01: Live YN Page Context And Native Pi Image Input

Root cause and boundary:

- The Agent previously knew project paths but not the user's current line-review viewport or
  focused row. Injecting that state as synthetic chat text would have created another renderer
  protocol and polluted Pi JSONL, so it is not used.
- Pi-web image attachment behavior had been removed when the composer was slimmed, even though
  Pi messages and capable provider models already support native image content. The configured
  model IPC also dropped Pi's `supportsImages` field, which made a correctly capable model look
  text-only in the composer.

Corrected contract:

- Line-review HTML publishes one validated, bounded, workspace-scoped snapshot containing the
  page kind, current page, visible line range, scroll position, active line, and focused
  source/translation row. A deliberate source-text selection is recorded separately on that
  focused row. Main derives the owning project from the actual Electron HTML tab, rejects
  cross-project publication, keeps only the newest live snapshot per renderer, and expires it
  after eight seconds. It is neither session memory nor transcript data.
- The parent Agent reads that snapshot through the native Pi Host tool
  `readYnInterfaceContext`. The system prompt tells it to use the tool for references such as
  "this line", "the current page", or "what I am viewing". No legacy event, raw HTML, or status
  message enters `AgentMessage[]`.
- Right-clicking a source row offers a localized Agent question. With no browser selection it
  inserts only a context-reading intent. When the user deliberately selects part of the source
  cell, the exact selected excerpt is inserted into the editable composer and also published as
  `focusedLine.selectedSourceText`; the rest of the row and its translation are not copied into
  the transcript. The compatibility fallback opens the shared Agent surface with the same
  initial prompt. Dock and popout still consume one Pi session service and one Pi JSONL transcript.
- Image paste/attachment is restored from the pi-web composer pattern. PNG, JPEG, GIF, and WebP
  attachments are bounded to five images, 10 MiB each, and 20 MiB total. Prompt, Steer, and
  Follow-up pass native Pi `ImageContent` to the same runtime. The control is enabled only when
  the selected model's pinned Pi catalog advertises image input; the provider IPC preserves
  that capability instead of guessing model names. A Custom API profile can explicitly declare
  image support. Main checks both the declared MIME type and PNG/JPEG/GIF/WebP file signatures.
- HTML upgrade markers advanced to Agent embed v12 and line-review protocol v25 so old generated
  pages receive the current publisher and row menu automatically.

Regression and product evidence:

- [x] focused tests cover image-only parsing, MIME/base64/size rejection, native Pi persistence,
  text-only model rejection, optimistic/native message convergence, workspace/staleness
  isolation, source whitespace, Host-tool exposure, and legacy HTML upgrade;
- [x] the complete Electron verifier exercises a real source-row context menu, reads the focused
  row and an explicit source excerpt through the Pi tool, pastes and sends an image through the
  Pi composer, and confirms the image-backed user message and assistant response. It reports
  45 ms interactive readiness, 4.7 ms optimistic paint, `liveYnInterfaceContext=true`, `sourceRowAgentQuestion=true`,
  `nativePiImageInput=true`, and no raw protocol or duplicate tool bubble. Evidence is
  `artifacts/electron-agent-native-interface-image.png`.
- [x] `npm run test:unit` passes all 103 test files, `npm run typecheck` passes, and
  `git diff --check` reports no whitespace errors.
- [x] an independent read-only reviewer returned PASS with no P0/P1/P2 blocker. It confirmed
  that live interface context stays behind a native Pi Host tool, image input remains native Pi
  content, dock and popout share one session, and neither feature restores a legacy transcript
  or runtime path;
- [x] rebuilt Windows 2.0.0 after the final selection behavior and review. `verify:release`
  validated the 105,114,242-byte installer, 104,739,518-byte portable executable, and refreshed
  SHA-256 checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 6,773 ms, and remained stable with five Electron processes.

## 2026-08-02: Canonical Same-file Line-review State

Root cause and corrected boundary:

- A folder batch page and an independently opened child HTML previously owned separate in-memory
  copies of the same line-review state. Each persisted the whole sidecar document, so a stale
  iframe flush could overwrite a newer standalone edit before batch TXT write.
- Electron main now owns one canonical, revisioned state per line-review path. Views send explicit
  changed-line patches; the Host serializes read/merge/atomic-write, broadcasts the canonical
  result to every matching HTML tab, and preserves unrelated lines. A no-change lifecycle flush
  cannot replace canonical line maps or document metadata. Path/sync metadata changes require an
  explicit `changedStateKeys` patch, so a stale iframe cannot roll back a newer translation binding.
- The folder iframe and standalone tab subscribe to the same Host event and apply newer revisions
  without re-persist loops. Batch TXT write continues to read canonical sidecars, so it cannot
  roll back a newer edit from another view.
- Bound-file synchronization is part of the same contract: a `syncedFile`/`syncedAt` broadcast
  makes every other open view reload that exact translation file into its local baseline cache.
  The async read is guarded by file identity and sync identity rather than global revision, so an
  unrelated line edit cannot cancel it while a genuinely newer file sync supersedes it.
- Line-review protocol v26 upgrades old generated HTML to this contract. The Electron verifier now
  fails on uncaught renderer Reference/Type/Syntax errors instead of accepting a visually usable
  page with a hidden JavaScript failure.

Regression and product evidence:

- [x] focused tests prove stale-flush protection for line maps and document paths, explicit metadata
  updates, independent-line merging, line restore, folder
  source contract, batch TXT overlay, and legacy v26 upgrade;
- [x] the real folder Electron flow first synchronizes a changed bound translation file and observes
  its new baseline in the already-open folder iframe, then edits child B in its standalone tab,
  observes the same text live in the iframe, performs batch TXT write, and verifies both the bound
  TXT and sidecar retained the standalone edit (`sameFileImportedTranslationSync=true`,
  `sameFileLiveSync=true`, `batchTxtWrite=true`);
- [x] `npm run test:unit` passes all 104 test files, `npm run typecheck` passes, and the complete
  Electron suite passes with no uncaught renderer JavaScript error.
- [x] the independent reviewer found and forced correction of stale document metadata, private
  synchronized baselines, and the async revision race, then returned final PASS.
- [x] rebuilt Windows 2.0.0 after the final PASS. `verify:release` validated the
  105,115,668-byte installer, 104,740,891-byte portable executable, and refreshed SHA-256
  checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 6,653 ms, and remained stable with five Electron processes.

## 2026-08-02: Incremental Editing And Source-only Agent Selection

Root cause and corrected boundary:

- Main already owned the canonical same-file state and merged `changedLines` / `changedStateKeys`,
  but the generated HTML still treated every Host broadcast as a replacement snapshot. It replaced
  all line maps and could rebuild the page while a translation cell was focused, so an intermediate
  canonical revision could erase a newer local keystroke. That renderer behavior violated the same
  incremental contract used by desktop/LAN synchronization.
- Line-review protocol v27 now hydrates the full canonical state once, then applies only the Host's
  changed lines and state keys. Each local line mutation carries a client mutation id; the renderer
  overlays newer unacknowledged mutations until the matching canonical acknowledgement arrives.
  Active editors are never replaced, and focus-out refreshes only that row. Main remains the single
  canonical owner; this is not a second state store or a renderer-side full-snapshot bridge.
- Composition input remains local while the IME owns the editor and is committed once on
  `compositionend`; intermediate composition text is not sent through Host/LAN persistence.
- Electron IPC can complete rapid invokes out of order even when input events were emitted in order.
  The Host therefore keeps a per-document, per-client mutation sequence for the life of the process
  and rejects an older completed invoke before merge. Legacy/no-id lifecycle writes remain compatible;
  they carry no changed lines and cannot roll back line maps.
- Sync tracing is bounded to the newest 80 records in `window.__ynLineReviewSyncTrace`, exposing
  mutation capture, acknowledgement, rejection, and canonical application without persisting user
  text into a separate log.
- Source-row Agent selection now intersects the browser `Range` with the source cell. A selection
  dragged from source into translation content sends only the source intersection; target text is
  excluded rather than falling back to the whole line.

Regression and product evidence:

- [x] legacy tests cover the v27 upgrade and source-range clipping contract;
- [x] the real folder Electron flow performs six rapid focused edits, proves the active editor node
  survives canonical broadcasts, and verifies the final DOM value, canonical state, folder iframe,
  sidecar, and batch TXT all converge (`rapidManualEditPreserved=true`). The final verifier uses
  native `webContents.sendInputEvent` keyboard input, exercises composition events and focus-out,
  and requires the pending mutation map to be empty;
- [x] the same Electron flow drags a selection across source and target cells and verifies that the
  Agent composer receives only the selected source fragment (`selectedSourceClipped=true`);
- [x] a stress run first reproduced mutation 8 completing before mutation 7 and rolling the canonical
  value back. A Host sequence regression test now covers that exact order; after the correction the
  focused real Electron flow passed three consecutive runs and `npm run typecheck` passes.
  The current full unit suite still has an unrelated pre-existing background-subagent notification
  count failure, and the aggregate Electron wrapper reports an unrelated post-success deleted-session
  cleanup race; neither failure is on this line-review state path and neither is being hidden here.
- [x] after the native-keyboard/IME and pending-mutation coverage was added, the independent reviewer
  returned final PASS with no P0/P1/P2 finding;
- [x] rebuilt Windows 2.0.0 from the reviewed implementation. `verify:release` validated the
  105,117,100-byte installer, 104,742,321-byte portable executable, updater metadata, and SHA-256
  checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 8,882 ms, and remained stable with five Electron processes.

## 2026-08-02: Host-owned Mechanical Scan Verification

Root cause and corrected boundary:

- Equal line counts, placeholders, tags, and empty-line structure cannot prove semantic alignment.
  A candidate can still merge one source sentence into a neighboring line, omit a sentence boundary,
  repeat one short placeholder translation for different source lines, or exhibit severe local length
  compensation while passing the older structural validator.
- The Host deterministic prescan now emits M0 evidence for sentence-boundary mismatch, adjacent
  boundary compensation, severe length/repetition risk, and distinct adjacent sources sharing the
  same candidate. These signals are review candidates, not automatic semantic verdicts.
- Host-owned M0 records are consolidated into the normalized findings artifact only when the same
  line has no semantic proofread finding. Model-authored or legacy M0 variants cannot enter the
  normal patch path. JSON and Markdown reports both normalize M0 into a verification-only
  `mechanical_scan` proposal.
- The proposal report renders these records in a separate Mechanical Scan section with only
  Confirm Issue / False Positive actions. False Positive adds the line to the project audit
  whitelist and removes only the matching Host M0 record; unrelated H/M/L semantic findings on
  the same line remain.
- Both the proposal action and the line-review homepage audit marker use one main-process atomic
  transaction for the line-review sidecar and `audit-whitelist.json`. Externally located line-review
  HTML remains valid when its resolved sidecar belongs to the selected project workspace.

Regression and product evidence:

- [x] focused prescan, findings-writer, domain-tool, report-parser, proposal-source, typecheck, and
  whitespace checks pass. Tests cover overlap suppression, stale-range replacement, whitelist
  exclusion, malformed/model-authored M0 ownership, bounded inspection, Markdown M0, and the
  non-patchable contract;
- [x] the real Electron proposal verifier clicks the homepage `.audit-marker`, cold reloads, then
  exercises the proposal False Positive action and cold reloads again. In both paths M0 disappears,
  the same-line H3 survives, and the whitelist persists;
- [x] the folder Electron verifier passes with an externally located line-review HTML and retains
  the typed audit whitelist in the generated Pi workflow request;
- [x] the independent reviewer returned PASS after two review rounds, specifically confirming the
  atomic homepage path, exact M0 ownership, Markdown normalization, overlap suppression, and
  whitelist behavior;
- [x] the final aggregate unit run passed all 104 test files, and the final typecheck and
  `git diff --check` passed;
- [x] rebuilt Windows 2.0.0 from this reviewed tree. `verify:release` validated the
  105,120,771-byte installer, 104,746,035-byte portable executable, updater metadata, parser
  metadata, and SHA-256 checksums. The packaged portable executable launched for real, reached
  the `translation-workshop` renderer in 8,682 ms, and remained stable with five Electron
  processes.

## 2026-08-03: Glossary Reference And Canonical Asset Boundary

Root cause and corrected boundary:

- The main-page glossary file picker had been coupled to the project-asset import command. Picking
  a file therefore replaced the canonical project glossary immediately and then rewrote the
  user-visible `glossaryPath` to `.translation-workshop/glossary.json`. Project-asset reads,
  broadcasts, and glossary entry saves repeated the same overwrite. This confused two different
  contracts: a user-selected reference file and the Host-owned canonical project asset.
- The picker now only binds and persists the absolute file selected by Electron. Importing or
  editing the canonical project glossary remains an explicit project-asset action. Asset reads,
  broadcasts, and entry saves update the project asset view without owning the selected reference
  setting.
- Line-review glossary synchronization may use the canonical Host asset internally, but it no
  longer publishes that internal path back into project settings. Existing line-review HTML is
  upgraded to protocol v28 so the corrected ownership boundary reaches already-generated pages.

Regression and product evidence:

- [x] a focused red test first proved the picker called `importProjectGlossaryFile` and replaced the
  selected path; it now proves that neither React nor generated HTML can publish a canonical asset
  path over the selected reference;
- [x] the Electron project verifier selects an actual absolute glossary path through the native
  file dialog, confirms that exact path remains visible and persists in `project.json`, proves the
  canonical project glossary is untouched by selection, then performs a separate explicit HTML
  import and proves its asset broadcast still does not replace the selected reference;
- [x] the final Electron flow completed with `projectGlossaryReferenceSelected=true`, first
  interactive content in 440 ms, and screenshot evidence at
  `artifacts/verification/project-glossary-reference.png`;
- [x] all 104 unit test files, typecheck, `git diff --check`, and the focused Electron project-open
  verifier pass;
- [x] the independent reviewer found no P0/P1/P2 issue and returned PASS for the selected-reference
  versus canonical-project-asset ownership boundary and protocol-v28 legacy upgrade;
- [x] rebuilt Windows 2.0.0 from this reviewed tree. `verify:release` validated the
  105,120,706-byte installer, 104,745,930-byte portable executable, updater/parser metadata, and
  SHA-256 checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 6,374 ms, and remained stable with five Electron processes.

## 2026-08-03: EPUB Agent Working-Text Ownership

Root cause and corrected boundary:

- EPUB line review correctly generated and routed an extracted UTF-8 source TXT, but
  `resolveCurrentProjectPromptRequest` later replaced that explicit page binding with
  `project.json.sourcePath`. For EPUB projects that field intentionally names the original binary,
  so every Host tool subsequently resolved the `.epub` and rejected it.
- The visible review page now owns the concrete Agent `sourcePath`/`sourceSelection` whenever it
  supplies one. Project state remains the source of current language, style, split, glossary, and
  subagent settings, and its original EPUB path is only a fallback when no page source is bound.
  The original EPUB remains available to export/repack code; it can no longer replace the text
  document consumed by Pi tools.

Regression and product evidence:

- [x] a service-level red test reproduced the real contract: project source `.epub`, renderer source
  extracted `_.txt`; before the fix the captured Host request used the EPUB, and after the fix the
  Pi source manifest reads the extracted TXT as a one-line file. A companion test proves requests
  without a page binding still fall back to the project source;
- [x] the existing live-project-settings test now proves project parameters refresh without
  replacing the page-bound source or its folder document manifest;
- [x] the focused native Pi session, IPC request, source-manifest, legacy EPUB route, typecheck, and
  build checks pass;
- [x] the Agent-only Electron verifier opens an EPUB review whose persisted project source is the
  original `.epub`, sends a real message through the embedded Pi-web bridge and native IPC, executes
  the real `inspectTranslationContext` Host tool, and verifies its paired result resolved the
  extracted source TXT. It completed with `epubHostExtractedSourceBinding=true` and `ok=true`
  (73 ms interactive, 8.5 ms optimistic feedback).
- [x] the final aggregate unit run passed all 104 test files, typecheck and `git diff --check`
  passed, and the independent reviewer returned PASS with no P0/P1/P2 finding after verifying the
  page-source ownership boundary, project-source fallback, and real Host-tool Electron path;
- [x] rebuilt Windows 2.0.0 from the reviewed tree. `verify:release` validated the
  105,120,557-byte installer, 104,745,823-byte portable executable, updater/parser metadata, and
  SHA-256 checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 7,239 ms, and remained stable with five Electron processes;
- [ ] the aggregate Electron wrapper is currently blocked before the Agent lane by the unrelated
  proposal-review screenshot environment error `Current display surface not available for capture`;
  the directly relevant Agent verifier passes in full.

## 2026-08-03: Active Project Owns The Recent-project Pointer

Root cause and corrected boundary:

- `recent-project.json` was written only after confirming the Open Project folder picker. A project
  entered by generating/saving a review page, opening an existing review HTML, or switching an HTML
  tab could therefore be the visible active project while the global pointer still named an older
  project such as Sekimeiya.
- Main now updates the one recent-project pointer after successful project load/save and whenever a
  line-review/proposal HTML becomes the active tab. Background-loaded tabs do not own the pointer;
  activating a tab or falling back to another tab after close does. The picker remains a consumer of
  that pointer rather than maintaining a second notion of the current project.

Regression and product evidence:

- [x] the Electron project verifier first opens project A, then directly activates a line-review HTML
  owned by project B, and finally clicks Open Project. The native folder dialog now starts at project
  B (`projectPickerTracksActiveHtml=true`) instead of the previously selected project A;
- [x] the focused project-state tests, typecheck, and all 104 unit test files pass;
- [x] rebuilt Windows 2.0.0 from the corrected tree. `verify:release` validated the
  105,120,681-byte installer, 104,745,911-byte portable executable, updater/parser metadata, and
  SHA-256 checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 5,803 ms, and remained stable with five Electron processes.

## 2026-08-04: External Reference Read Boundary

Root cause and corrected boundary:

- The shared read resolver still treated every absolute path outside `outputDir` as a permission
  request. It returned `externalPathApproved`/`permissionRequired`, but neither the parent nor child
  native Pi tool contract had such an approval state. User-provided reference files therefore
  failed even though the tools were read-only.
- The obsolete approval branch has been removed from the common main-process read boundary.
  Relative paths still resolve from the current project; absolute paths are read directly by the
  same `readProjectFile`, `listProjectDir`, and `searchProjectText` implementations used by parent
  and child Pi runtimes. Missing absolute paths fail at their exact location and are never silently
  remapped to a same-named project artifact. Renderer code has no path exception or approval bridge.
- The write boundary was not relaxed. `writeProjectFile` still uses strict `resolveProjectPath`,
  parent domain writers still enforce canonical project artifact paths, child writers still enforce
  assignment ownership, and source/project-external files remain immutable.

Regression and product evidence:

- [x] the helper-level red test first reproduced the false permission failure and now proves
  project-external read/list/search success together with project-external write rejection;
- [x] parent `createYnDomainTools` and translation/proofread child native Pi toolset tests each read,
  list, and search an actual absolute sibling directory outside the project;
- [x] the Agent-only Electron verifier sends a visible user message, executes the real native Pi
  `readProjectFile` Host tool against an external absolute file, receives the paired tool result,
  and reports `externalReferenceRead=true`. The final run became interactive in 58 ms and optimistic
  user feedback appeared in 6.5 ms;
- [x] all 105 unit test files, typecheck, and `git diff --check` pass;
- [x] an independent reviewer first caught and rejected the obsolete missing-path artifact fallback;
  after its removal and the explicit child execution evidence, the same reviewer returned PASS with
  no P0/P1/P2 finding;
- [x] rebuilt Windows 2.0.0. `verify:release` validated the 105,120,479-byte installer,
  104,745,747-byte portable executable, updater/parser metadata, and SHA-256 checksums. The packaged
  portable executable launched for real, reached the `translation-workshop` renderer in 6,941 ms,
  and remained stable with five Electron processes.

## 2026-08-04: Translation And Review Pi Worker Pools

Root cause and corrected boundary:

- Translation workers previously stopped after every accepted chunk and asked the parent Agent to
  inspect and record line-by-line alignment conclusions. That serialized the critical path through
  one growing parent context, spent tokens explaining every passing line, and delayed repair until
  the parent had reviewed the chunk. It also made the parent less responsive while child work was
  active.
- Full translation now owns two native Pi pools under one Host supervisor. Persistent translation
  workers read and write only their Host-owned assignments. Persistent read-only review workers
  receive all deterministic risk rows, merged two-line context on both sides, and a bounded stable
  clean sample. They submit failures only; an empty failure list accepts the chunk without writing
  passing-line prose or a temporary report.
- A rejected chunk is returned with exact lines and reasons to the same translation worker. That
  worker repairs and re-enters mechanical plus semantic review before it can claim another queued
  assignment. The parent remains interactive during both pools and performs only the final
  whole-artifact Host validation and shared-asset merge.
- `reviewSubagentCount` is a project-level typed setting from generated HTML through project state,
  Pi prompt IPC and the Host tool. An unset override follows the translation worker count at runtime
  without persisting that fallback as a user value; an explicit override remains a `1..N` ceiling.
  It does not create a second legacy queue or renderer contract. Stop aborts active review workers
  and translation workers together; review cards retain only lightweight status while full
  transcripts stay in child Pi JSONL.

Regression and product evidence:

- [x] focused tests prove two review assignments overlap, passing rows require no reasons, and risk
  windows contain the selected rows plus nearby context;
- [x] a rejected review returns exact feedback to the same persistent translation worker, which
  repairs and passes re-review before receiving its next assignment;
- [x] Stop aborts a blocked review pool and its waiting translation worker without deadlock;
- [x] a failed translation sibling preserves healthy work, wakes the native parent, retries through
  a replacement batch, passes review, and completes final whole-artifact validation;
- [x] architecture tests prove the old serial parent review reminder/notification bridge is absent;
- [x] the independent reviewer first found that the parent alignment tools could still bypass the
  review pool and that terminal review cards lost their latest assignment and real duration. Full
  multi-line workflows now reject parent chunk-verdict tools, while single-line and bounded local
  repair retain their parent-owned path. Review cards preserve the worker start time, latest
  assignment, and actual finish time. The same reviewer returned PASS after both fixes;
- [x] all 106 unit test files, typecheck, build, and `git diff --check` pass after the review fixes;
- [x] the Agent-only Electron verifier completed with `ok=true`, four structured Pi child cards,
  `perChunkReviewWorker=true`, two reviewed chunks, paired tool results, final Host completion,
  no raw protocol leak, 46 ms interactive startup, 5.4 ms optimistic feedback, and 7.3 ms parent
  interaction while both pools were active;
- [x] rebuilt Windows 2.0.0 from the reviewed tree. `verify:release` validated the
  105,122,464-byte installer, 104,747,682-byte portable executable, updater/parser metadata, and
  SHA-256 checksums. The packaged portable executable launched for real, reached the
  `translation-workshop` renderer in 8,602 ms, and remained stable with five Electron processes.

## 2026-08-04: Review Agent Count HTML Upgrade

Root cause and corrected boundary:

- The generated prompt form already contained the typed `reviewSubagentCount` control and project
  state wiring, but adding that control did not advance the prompt-settings protocol marker. Existing
  v31 line-review HTML therefore falsely looked current and skipped automatic regeneration, leaving
  the review worker count absent from the product UI even though the current source template had it.
- `PROMPT_SETTINGS_VERSION` is now 32. Any v31 line-review page automatically regenerates through
  the established legacy HTML upgrade path; users do not need to recreate their project HTML.

Regression and product evidence:

- [x] a red legacy test reproduces a v31 page without `promptReviewSubagentCount`, proves it requires
  upgrade, and verifies the upgraded Chinese prompt form contains `审阅 Agent 数量`;
- [x] the Electron verifier now requires the review count control to exist, be visible, carry the
  expected label, keep an inherited value blank, and preserve only explicit user overrides;
- [x] the Agent-only Electron run passed and captured
  `artifacts/electron-agent-native-prompt-settings.png`, visibly showing independent translation and
  review Agent counts;
- [x] all 106 unit test files, typecheck, build, and `git diff --check` pass;
- [x] rebuilt Windows 2.0.0. `verify:release` validated the 105,122,429-byte installer and
  104,747,655-byte portable executable with matching checksums. The packaged portable executable
  launched for real, reached the renderer in 6,061 ms, and remained stable with five Electron
  processes.

## 2026-08-04: Sparse Reuse Debt And Parent Context Ownership

Root cause and corrected boundary:

- The latest `5656下` parent Pi session was 17.46 MB. Its first post-audit dispatch correctly
  identified only 409 rejected rows, but the Host still required child ranges to cover the complete
  4,286-line source. The parent therefore retried with three full-file ranges instead of translating
  only L2422-L2424, L2454-L2858, and L3250. This made a small repair run as a full retranslation.
- `inspectSubagents` also copied complete child transcripts into parent tool results. Those results
  accounted for about 8.09 MB of the parent JSONL, with individual results approaching 1.9 MB. The
  parent additionally reread large source and candidate ranges, so Pi compacted at roughly 358k,
  364k, 267k, and 171k tokens after only a few visible exchanges.
- Applied reuse decisions now produce a Host-owned sparse assignment plan containing only rejected
  rows that are still blank. Retained rows can never be repartitioned by a model-supplied whole-file
  task list. Cold restart recomputes the same hash-bound debt and resumes only rows not already
  accepted.
- A translation child receives only its writable assignment. It may call
  `readTranslationContext` for at most 200 numbered source/current-translation rows anywhere in the
  bound document when dialogue, pronouns, terminology, or scene continuity requires context. That
  tool is read-only and cannot expand artifact ownership; the exact assignment remains the only
  writable range.
- Parent inspection now returns lightweight state and a bounded result summary only. Full child
  conversation remains exclusively in child Pi JSONL and is loaded on demand for the Reply panel.
  A one-time parent-session migration strips historical `inspectSubagents` transcript/reply payloads
  before Pi opens the session, while leaving every child JSONL unchanged.

Regression and product evidence:

- [x] a 4,286-line scale test proves the exact 409 rejected rows become three sparse assignments and
  that cold restart resumes only the two still-empty ranges after the first is written;
- [x] a child-tool test proves L6-L7 is the only writable assignment while an independent bounded
  context read returns numbered L3-L10 source and current-translation rows with
  `writeAllowed: false`;
- [x] a migration test proves the polluted parent shrinks by more than 20x, child JSONL remains
  byte-identical, and the child session is still reopenable;
- [x] all 108 unit test files, typecheck, build, and `git diff --check` pass;
- [x] the Agent-only Electron verifier passes with 45 ms interactive startup, 5.3 ms optimistic
  feedback, live parent interaction during child work, on-demand child transcript loading, native
  Pi compaction, and no raw protocol leak;
- [x] the separate cold-restart Electron verifier restores the prior run as terminal, hides Stop,
  and leaves the composer ready in a distinct Electron main process;
- [x] the independent reviewer returned PASS with no P0/P1/P2 finding after checking sparse debt
  ownership, bounded context reads, lightweight parent inspection, legacy migration, and the native
  Pi-only product path;
- [x] rebuilt Windows 2.0.0 from the reviewed tree. `verify:release` validated the
  105,124,603-byte installer and 104,749,827-byte portable executable, updater/parser metadata, and
  SHA-256 checksums. The packaged portable executable launched for real, reached the renderer in
  7,200 ms, and remained stable with five Electron processes.

## 2026-08-04: Persisted Review Debt And Exact Cold-Restart Repair

Root cause from the latest `5656下` Pi history:

- The applied reuse audit had already accepted 3,877 of 4,286 rows and rejected only 409, but its
  applied state was kept only in the current Host-tool closure. After a cold restart the no-argument
  translation dispatch could not recover that sparse plan, so the parent first received a red Host
  rejection and then retried three full-file ranges.
- The final translation worker owned L2859-L3882. Its first review inspected 180 deterministic-risk
  rows plus 32 samples and returned seven exact failures. Those review failures existed only as
  prompt feedback, not as durable Host repair debt. The worker therefore fell back into whole-chunk
  write and review turns; the first review took about 5m19s and the repeated review about 6m39s.
- Stop persisted an empty Host-state tombstone. That erased the exact hash-bound alignment evidence,
  so reopening the session could show no recoverable repair scope even though the earlier JSONL
  contained eight rejected lines.
- Canonical project asset reads in this run were successful. The red-then-green startup was the
  invalid empty translation dispatch followed by a full-range retry, not missing glossary or
  character-bible paths. Optional assets marked `available:false` are no longer probed by children.

Corrected Pi/Host boundary:

- Applied reuse audits are enumerated and validated from their durable owner-session store on cold
  start. `runTranslationSubagents` can therefore reconstruct the sparse Host assignment without a
  model-supplied full-file range list.
- Review failures are durable typed alignment evidence. Restarted tasks carry exact
  `requiredBatchLines` and review feedback into the same persistent Pi worker; the worker repairs
  those entries directly and the review pool rechecks only the previously rejected rows, with no
  clean sample or full risk sweep on that repair turn.
- Stop cancels the live Pi/domain execution but retains hash-bound proofread/alignment evidence. The
  loader recognizes the former empty Stop tombstone and recovers only prior evidence, never the
  cancelled domain runtime or running-job state.

Regression and replay evidence:

- [x] red tests reproduced the cold-restart loss and the restarted worker ignoring review feedback;
- [x] focused tests cover applied-audit hydration, exact sparse repair, exact re-review, Stop
  persistence, legacy tombstone recovery, path/reference behavior, and Pi child lifecycle;
- [x] replaying the user's interrupted JSONL recovers exactly L3250, L3254-L3257, L3260, L3324 and
  L3854 inside the existing L2859-L3882 assignment; no full-source fallback is planned;
- [x] the next review selects exactly those eight rows, reports zero deterministic samples, and does
  not re-read the prior 1,024-line chunk;
- [x] all 111 unit test files, typecheck, build, and `git diff --check` pass.

Final review hardening:

- Candidate text is never treated as completion evidence. Every `retranslate` row remains debt until
  a hash-current Host alignment scope explicitly accepts it.
- Applied reuse evidence now carries a typed retained/retranslation mask. Retained rows are protected
  by a masked baseline hash, while rejected rows may change only through their owned repair scopes.
  Standard `prepareTranslationReuseAudit` uses the same baseline and restores the existing applied
  audit after a cold start instead of silently creating a replacement audit.
- Persisted review scopes are checked against the current source/candidate paths, line count, and
  exact range input hash before planning. Stale scopes are removed durably. An interrupted scope with
  no verdict resumes as a review-only Pi turn; it does not call the translation model again merely
  because Stop occurred during review.
- Sparse final validation requires accepted review coverage only for the audit's retranslation rows.
  The 3,877 retained rows are covered by the applied audit baseline and are not expanded into a
  synthetic full-file review requirement.

Final acceptance evidence:

- [x] the independent review Agent returned PASS with no P0/P1/P2 finding after verifying prepare,
  planning, audit enumeration, final validation, interrupted review-only resume, and retained-row
  mutation rejection;
- [x] the Agent Electron verifier passed in 45.3 seconds with 58 ms interactive startup, 4.8 ms
  optimistic feedback, 7.6 ms parent interaction during child work, paired tool results, visible
  child replies, per-chunk review workers, native Pi compaction, and no raw protocol leak;
- [x] the distinct-process cold-restart verifier restored the interrupted session as terminal, hid
  Stop, retained the stopped card, and left the composer ready.
- [x] rebuilt Windows 2.0.0 in `release-final/` after an earlier orphaned builder process kept the
  old `release/` portable executable locked. The independent output avoids treating that stale file
  as a successful rebuild. `verify:release` validated the 105,126,572-byte installer and
  104,751,845-byte portable executable, updater/parser metadata, and SHA-256 checksums. The fresh
  portable executable launched for real, reached the renderer in 8,246 ms, and remained stable with
  five Electron processes.
- [x] final typecheck, all 111 unit test files, build, `git diff --check`, and a second independent
  review of the release-tool changes pass. The final reviewer reported no P0/P1/P2 finding.

## 2026-08-04: Same-Session Workflow Suspension And Native Review Resume

Root cause confirmed from the latest `5656下` Pi JSONL:

- Stop had persisted an empty Host-runtime tombstone. Later turns still belonged to the same Pi
  session, but Host state had fallen back to `fullWorkflowActive:false` because mode was rebuilt
  from only the latest user message instead of the session-owned unfinished workflow contract.
- The parent consequently launched three generic `Replacement Review Worker` children over the old
  1,024-line assignment. That bypassed the translation workflow's dedicated mechanical-risk and
  deterministic-sample review pool, then misreported the entire range as `pending 1024`. This was
  orchestration debt, not 1,024 newly discovered translation defects.
- The failure was therefore not a renderer refresh problem and not a Pi Agent-loop limitation. YN
  had discarded the Host task contract while retaining the Pi conversation, producing two
  contradictory notions of what the same session was doing.

Corrected Pi/Host boundary:

- Stop now terminates live parent/child execution but persists the incomplete typed Host workflow as
  `workflowSuspended`. Closing the workspace uses the same suspension path. A same-session request
  to continue receives the restored full-workflow system contract and specialized Host tools without
  needing a newly generated `Workflow:` prompt.
- Suspension is not ambient auto-run authorization: an ordinary greeting may use the same Pi
  conversation without triggering stale completion repair. The model must call the product
  `resumeYnWorkflow` tool only when the current user instruction asks to continue or finish the
  retained workflow. Mutating Host tools reject before changing state while suspended; read-only
  inspection and unrelated conversation remain available.
- A legacy migration recognizes only the adjacent old empty Stop tombstone plus the immediately
  preceding incomplete full workflow. It never scans arbitrarily far back or resurrects an
  unrelated older workflow/running job.
- Current-user worker counts configure the specialized Host pool without creating a second generic
  child-batch completion debt. Model-invented generic replacements are rejected. A concrete explicit
  user delegation may still run native Pi investigation or bounded repair children inside the same
  conversation, but those children cannot satisfy or replace the full workflow's Host-owned
  translation/review coverage.
- Closing an HTML tab or its containing window awaits workspace suspension before destroying the
  page, so no live parent/child execution can survive as a falsely running restored card.
- Interrupted translation review resumes through the dedicated review pool. Only exact rejected
  rows and the workflow's risk/sample evidence count; a historical 1,024-line assignment is never
  converted into synthetic per-line review debt.

Regression evidence:

- [x] Stop preserves the incomplete full workflow and same-session continuation consumes it through
  `resumeYnWorkflow` and specialized Host tools, including a current exact worker count;
- [x] ordinary chat and rejected Host mutations after Stop do not resume stale work or alter state;
- [x] only an adjacent old tombstone/full-workflow JSONL pair migrates; a later independent local run
  remains local;
- [x] model-invented generic replacement reviewers are rejected, while explicit read-only child
  investigation remains legal and adds no workflow completion debt;
- [x] a fully accepted existing-translation audit completes correctly even when parent-only mode has
  zero subagents;
- [x] interrupted and restarted translation review tests resume only dedicated rejected-row debt;
- [x] typecheck, build, `git diff --check`, and all 111 unit test files pass.

### Cold-restart ownership hardening

- A final cold-start review found that a stopped workflow could still lose its suspended marker when
  Host state was appended while the Pi model turn owned a different JSONL branch. Stop and workspace
  disposal now perform a forced Host-state append after the native runtime has aborted, so the
  suspended contract is committed to the current Pi branch and survives a real process restart.
- The forced Stop append remains inside the per-session transition. Once that lock is released, the
  old Session owner may wait for slow children but may never write JSONL again; a continuation from
  another window can safely establish the next Session owner without either branch becoming orphaned.
- Restoring a suspended full workflow now derives worker-count mode only from its persisted Host
  snapshot. A count stated in the continuation turn is applied by `resumeYnWorkflow`, never during
  preflight; before resume the prior configured ceiling and count mode remain byte-for-byte owned by
  the stopped contract.
- Disk-discovered translation-reuse audits are not inserted into a suspended contract during
  preflight. Their IDs are deferred until `resumeYnWorkflow` reactivates the contract, after which
  the same current user turn may authorize the pending decision. The mutator itself asserts active
  workflow state before touching any Set, eliminating partial mutation on failure.
- The Electron compaction verifier now respects Pi's single Session writer: it disposes the active
  service runtime before reopening the JSONL to append test-only context. This prevents the verifier
  from manufacturing an orphan sibling branch that product code correctly ignores.
- [x] cold-start tests prove Stop survives service disposal, resume-before-count ordering, and an
  awaiting reuse audit absent from the suspended snapshot. A writer-race test also holds child
  shutdown open, submits a same-session continuation from another window, and proves the accepted
  continuation remains on the cold-opened current branch;
- [x] all 111 unit test files, typecheck, build, Agent Electron acceptance, and distinct-process cold
  restart acceptance pass. Agent acceptance measured 79 ms interactive startup, 5.3 ms optimistic
  feedback, and 9.2 ms parent interaction while children were running, with no raw protocol leak;
- [x] the independent reviewer returned PASS after verifying the restored contract, deferred reuse
  audit, Stop writer ordering, concurrency regression, and the Pi-only compaction verifier path.
- [x] rebuilt Windows 2.0.0 in `release-final/`. Release verification confirmed the
  105,128,343-byte installer and 104,753,566-byte portable executable, updater/parser metadata, and
  SHA-256 checksums. The fresh portable executable launched for real, reached the renderer in
  6,364 ms, and remained stable with five Electron processes.

## 2026-08-05: Project-Level Pi Delegation And Canonical Alignment Debt

Root cause confirmed from the latest `5656下` Pi JSONL and Host state:

- the project had `subagentEnabled:true`, `subagentCount:3`, and `reviewSubagentCount:3`, but
  specialized `runTranslationSubagents`/`runProofreadSubagents` still ignored project capability and
  required either a generated workflow marker or magic subagent wording in the current user turn;
- generic `runSubagents` already honored project capability, so the two native Pi child paths exposed
  contradictory authorization rules inside the same Agent session;
- `inspectTranslationAlignment` reported `pendingCount:1024` for L2859-L3882 because the legacy
  bounded alignment builder inserted every row in the range as an unresolved semantic check. The
  number was the range length, not 1,024 detected defects;
- translation review workers read the current project `reviewSubagentCount`, but the Host result did
  not expose the resolved count and lacked a direct regression proving that this distinct user ceiling
  wins over the translation-worker default.

Corrected Host boundary:

- project-enabled native Pi delegation is now an ordinary `1..N` capability for bounded specialized
  and prompt-defined tasks. Only a current explicit user count becomes exact; disabling the project
  capability still requires an explicit user delegation;
- local specialized translation tasks may cover concrete partial ranges without being upgraded into
  a full workflow or being forced to cover the entire source;
- bounded alignment now reuses the same canonical `createTranslationChunkReviewAudit` contract as the
  translation review pool: every mechanical-risk row plus a deterministic clean sample sized from the
  square root of the current chunk length.
  Direct small parent writes additionally mark their exact changed rows, while large historical range
  length never becomes semantic debt;
- legacy exhaustive `alignment-range-*` scopes are rebuilt in main/Host before being returned, preserve
  hash-current prior verdicts (including explicit misalignment evidence), persist the migrated scope,
  and never rely on renderer filtering;
- the review pool resolves its actual size as
  `min(project reviewSubagentCount, live translation workers, assignments)`, so it is always within
  `1..user configured maximum` and never silently substitutes a hard-coded worker default.

Regression evidence:

- [x] focused domain-contract and domain-tool red tests reproduce and fix all three product paths;
- [x] a 1,024-line fresh local audit and a persisted legacy exhaustive audit both return bounded
  risk/sample debt instead of 1,024 semantic checks;
- [x] migration preserves a hash-current `misaligned` verdict and reason, persists the canonical
  `alignment-chunk-*` scope before returning, and refuses to reuse stale all-aligned verdicts after
  candidate content changes;
- [x] a distinct translation ceiling of five and review ceiling of two resolves three useful
  translation workers and two review workers. A real-supervisor integration test then drives two
  concurrent chunks through two actual Pi review runtimes and proves each completes one assignment;
- [x] all 112 unit test files, typecheck, build, and `git diff --check` pass;
- [x] Electron Agent acceptance passes with 62 ms interactive startup, 6.5 ms optimistic feedback,
  10.1 ms parent interaction while children run, paired tool results, visible child replies, no raw
  protocol leak, and cold-restart convergence;
- [x] the independent final reviewer returned PASS after the migration and real-review-worker tests
  were strengthened.
- [x] rebuilt Windows 2.0.0 in `release-final/`; release verification confirmed the
  105,128,743-byte installer and 104,753,967-byte portable executable, updater/parser metadata,
  packaged runtime boundaries, and SHA-256 checksums. The fresh portable executable launched for
  real, reached the renderer in 7,151 ms, and remained stable with five Electron processes.

## 2026-08-05: Idempotent Pi Workflow Resume

Root cause:

- `resumeYnWorkflow` had become a second authorization state machine around the Pi session. The
  product tool rejected both a freshly active full workflow and a session without a suspended full
  workflow, while the session callback repeated the same checks. A model that correctly called the
  tool after a generated workflow prompt could therefore receive `There is no full YN workflow
  contract to resume in this Pi session` instead of continuing its current Host task.
- The tool additionally required a model-authored `reason`, even though resume is a deterministic
  Host transition. That unnecessary schema field created another way for a valid continuation to
  fail before any workflow tool could run.

Corrected boundary:

- `resumeYnWorkflow` is now an idempotent Pi/Host operation. A suspended workflow resumes its exact
  persisted typed Host state; an already-active workflow returns `already_active`; a session with no
  suspended workflow returns `not_suspended`. Both latter states are successful no-ops.
- The optional callback at the session boundary is itself idempotent. Repeating resume after the
  first successful transition neither reconfigures worker counts nor resets progress. Suspended
  bounded/local Host contracts resume their exact typed state without being upgraded to a full
  workflow; only a truly orphaned suspension marker with no domain contract is cleared as
  non-actionable state.
- Resume no longer requires a `reason`. A supplied reason remains telemetry only. A no-op never
  creates a workflow or grants completion evidence. Mutating Host tools remain blocked while any
  real stopped Host contract is suspended, so ordinary chat still cannot ambiently continue old
  work. The suspension guard runs before manifest preparation and covers bounded alignment and
  proofread inspection tools as well as artifact writers.
- Resume is transactional across Host suspension, the typed domain contract, worker configuration,
  reuse-audit restoration, and JSONL persistence. A failure after reactivation restores both the
  Host marker and `domainRun.suspend()` before returning the error, preventing split-brain state.
- Host-state persistence updates its dedupe marker only after a successful Pi JSONL append and
  recovers the serialized write queue from a rejected predecessor. A transient resume append
  failure therefore rolls back to suspended state and a repeated resume can persist normally,
  instead of inheriting a permanently rejected promise.

Regression evidence:

- [x] red tests reproduce the active-workflow and no-suspended-workflow failures through the real
  `resumeYnWorkflow` tool, then prove `already_active` and `not_suspended` no-op results;
- [x] suspended full and bounded/local workflow recovery restores the existing typed contract,
  while a repeated session callback preserves an identical Host snapshot;
- [x] the existing cold translation-reuse session resumes and applies its decision successfully;
- [x] all 112 unit test files, typecheck, runtime-skill boundary checks, and build pass;
- [x] a forced transient Host-state append failure rolls the first resume back, then a second
  no-reason resume completes and persists the active contract;
- [x] real Electron Agent acceptance calls resume twice across cold restoration, proves the second
  no-argument call succeeds as `already_active`, and completes the reuse decision. The final rerun
  measured 45 ms interactive startup, 4.3 ms optimistic feedback, and 14.7 ms parent interaction
  during child work;
- [x] distinct-process cold-restart acceptance preserves the stopped card, hides Stop, and leaves the
  composer ready. The unrelated proposal-review screenshot verifier remains blocked on this machine
  by Windows `Current display surface not available for capture`; its LAN Agent predecessor passed;
- [x] the same independent reviewer found and then verified fixes for transactional rollback,
  bounded-contract recovery, early mutation guards, and retryable Host-state persistence, returning
  final `PASS`;
- [x] rebuilt Windows 2.0.0 in `release-final/`; release verification confirmed the
  105,128,999-byte installer and 104,754,233-byte portable executable, updater/parser metadata,
  packaged runtime boundaries, and SHA-256 checksums. The fresh portable executable launched for
  real, reached the renderer in 8,039 ms, and remained stable with five Electron processes.

## 2026-08-09: Scoped Review Evidence And Independent Repair

Root causes:

- Parallel review workers committed replacements from captured array snapshots. A later sibling
  could therefore overwrite evidence written by an earlier sibling even though both children had
  completed successfully. The apparent "review invalidation" was evidence loss, not a translation
  quality decision.
- Child ownership was process-global. Read-only proofreading, bounded translation repair, and full
  workflow writers all competed for one batch/session lock, so unrelated local repair was rejected
  merely because a reviewer was active.
- Proofread freshness was represented only by one whole-candidate hash. Any exact candidate repair
  dirtied the entire proofread run and switched the active workflow kind, discarding unrelated
  deterministic scan and report evidence.
- An empty folder resume was interpreted as permission to plan every source range again, and
  candidate cleanup ran before outstanding debt was established. That could silently turn a no-op
  continuation into a complete translation restart.
- Creating the translation review pool before write-scope validation exposed a resource leak: when
  overlap validation rejected the translation batch, the new review pool was aborted but not
  closed, leaving a permanent active-review owner.
- A proofread batch captured the candidate artifact revision only when it settled. If a bounded
  repair committed after that batch started but before it returned, the older review could clear
  the newer repair's dirty range as if it had reviewed the repaired text.
- Hash-current interrupted scopes were still sent through the translation-writer resume path.
  That needlessly selected a model, reacquired write ownership, and could retranslate text that
  only needed its already-written candidate reviewed.
- The configured translation worker ceiling leaked into resumed review scheduling. Projects with
  two translation workers and five review workers could therefore run only two pending reviews,
  despite the review setting being an independent `1..N` ceiling.

Corrected boundary:

- Evidence replacement is now an atomic current-state range operation. Concurrent sibling commits
  merge against the latest evidence instead of replacing another child's accepted scopes.
- Child ownership is scoped by document and exact write ranges. Read-only proofread/review pools do
  not occupy translation writes; disjoint writers may coexist; only overlapping writes conflict.
- A bounded candidate mutation during proofreading keeps the proofread workflow active, preserves
  unrelated prescan/report/sample evidence, and records only the exact dirty range. Revalidation of
  that range clears only its own debt.
- Prompt-defined bounded repair remains a local Pi operation during active or suspended complete
  workflows. It neither changes the complete workflow kind nor grants or restarts its queue.
- Folder resume computes hash-current outstanding assignments before any candidate cleanup. An
  empty result returns `no_outstanding_assignments`; it cannot synthesize a plan-all fallback.
- A stopped complete workflow remains stopped unless the current user instruction explicitly asks
  to continue or finish it. Inspection, ordinary chat, and independent bounded repair never call
  or emulate complete-workflow resume.
- A review pool created before a rejected writer is now aborted and closed, releasing every runtime
  and ownership record on the failure path.
- Every batch records whether it is read-only and the candidate artifact revision observed at
  start. An older proofread result cannot clear dirtiness created by a later candidate revision,
  and a read-only batch does not block selecting or repairing another document.
- Hash-current interrupted review scopes resume through `startTranslationReviewBatch`; this path
  never creates a translation worker or model-selection turn. Only rejected or genuinely missing
  ranges return to the writer queue.
- Empty-resume reconciliation records Host completion only for hash-current accepted assignments;
  it still requires the separate whole-artifact validation and cannot manufacture new work.
- Resumed translation review uses its own typed `workerCountCeiling`, sourced from
  `reviewSubagentCount`. Full translation/proofread workflow exact-count semantics remain intact,
  while a review tail may use any useful count up to the independent review ceiling.
- Project-enabled bounded Pi delegation no longer requires magic wording in the current turn.
  User wording only makes a requested child count exact; delegation never impersonates or restarts
  a complete YN workflow.

Regression evidence:

- [x] concurrent alignment/review commits retain all sibling scopes;
- [x] read-only proofread and bounded translation repair run together, while overlapping exact
  writers are rejected;
- [x] exact proofreading dirtiness and exact-range revalidation preserve unrelated evidence;
- [x] hash-current folder resume is a no-op and cannot clear or restart accepted translation;
- [x] suspended complete workflows permit independent scoped repair without resuming the full run;
- [x] focused domain, ownership, background-child, and lifecycle suites pass, including the
  rejected-overlap resource-leak regression;
- [x] all 117 unit test files, typecheck, build, and Electron Agent HTML acceptance pass;
- [x] Electron acceptance reports 47 ms interactive startup, 10.8 ms optimistic user feedback,
  7.3 ms parent interaction during child work, paired tool results, visible child replies, cold
  recovery, and no raw-protocol or duplicate-tool leakage.
- [x] the same independent reviewer rejected three incomplete revisions (stale proofread revision,
  translation-path review resume, and translation-count leakage into review scheduling), then
  re-reviewed the final typed Host contract and returned `PASS`.
- [x] rebuilt Windows 2.0.0 after the final review in `release/`; release verification confirmed
  the 105,142,285-byte installer, 104,767,568-byte portable executable, updater/parser metadata,
  and SHA-256 checksums. The fresh portable build reached the renderer in 6,517 ms and remained
  stable with five Electron processes.

## 2026-08-10: Scaled Translation Review Sampling And Neighbor Propagation

Root causes:

- translation safety review used `min(32, ceil(sqrt(chunkLength)))`, so clean-row coverage stopped
  growing once a chunk exceeded 1,024 lines even though the user-selected split could be larger;
- Host already accepted a concrete failure found on a neighboring context row, but the reviewer
  contract told the model to inspect selected rows only and persisted the promoted row without
  updating risk/sample telemetry. The supported propagation path therefore existed but was hidden
  and observably inconsistent.

Corrected Host boundary:

- deterministic clean sampling is now `ceil(sqrt(chunkLength))` with no unrelated fixed ceiling.
  All mechanical-risk rows remain mandatory, and the hash-bound ranking remains stable;
- selected rows remain mandatory review targets. A context row that clearly shares or continues a
  discovered defect may also be rejected. Host promotes it to `review_context_failure`, sends that
  exact row back to the same translation worker, and the next repair review centers a fresh context
  window on the newly promoted line;
- promoted context failures immediately update persisted `riskLineCount` and `sampledLineCount`, so
  cards, cold recovery, and completion logic describe the same review scope.
- repair-only review keeps every previously accepted risk/sample verdict in the same hash-current
  scope while making only rejected lines pending again. The repair worker still receives only exact
  failed lines, but the final canonical commit retains the complete evidence required by the Host;
- a review verdict remains bound to the staging candidate until canonical promotion and Host state
  persistence both succeed. Stop while review is pending preserves that staging file; cold restart
  validates its project staging path, line count, and range input hash before resuming the exact
  pending/rejected review debt;
- canonical promotion, domain-run artifact revision, alignment evidence, and Host JSONL persistence
  now form a rollback-capable commit boundary. A persistence failure restores canonical text,
  domain-run state, and prior alignment state while retaining the accepted staging artifact. That
  failure is non-retryable at the translation-worker layer, preventing a generic assignment retry
  from reinitializing and overwriting the recoverable staging file;
- reviewer cards are republished immediately after submission with `review accepted` or
  `repair requested` plus the updated risk/sample counts. The UI no longer waits for a later state
  broadcast to describe the review decision.

Regression evidence:

- [x] a 1,600-line clean chunk selects 40 deterministic samples, proving coverage grows beyond the
  former 32-row ceiling;
- [x] a reviewer-discovered context failure becomes Host repair debt, returns its exact line and
  reason, and the repaired candidate is reviewed again in a newly centered neighboring window;
- [x] repair-only review retains prior accepted evidence while exposing only exact failed lines as
  pending repair work;
- [x] interrupted review preserves and cold-resumes the same staging candidate; a simulated Host
  persistence failure rolls canonical/domain/alignment state back and keeps staging for recovery;
- [x] focused alignment/domain/review/rollback tests and all 128 unit test files pass with typecheck
  and runtime-skill boundary validation;
- [x] Electron Agent acceptance passes after the final transaction change. It preserves structured
  review workers, paired tool results, cold restart, no raw-protocol or duplicate-tool leakage, and
  immediate parent interaction while children run.
- [x] an independent review agent re-read the final worktree and returned PASS after its original
  transaction, cold-recovery, and stale-card findings were fixed. Its eight focused regression tests
  also pass;
- [x] fresh 2.0.0 installer and portable artifacts were built in `release-final`, release metadata and
  SHA-256 checksums verify, and the packaged portable created a stable Electron renderer/window in
  7,074 ms. Packaging and launch used a G-drive temp directory because the system C-drive temp was
  full and an older portable instance was still holding stale NSIS temp files.

## 2026-08-11: Folder Proofread Aggregate Report

Root cause:

- folder proofreading reused the single-document report identity, so every source document owned a
  separate findings JSON and proposal page. A large project therefore exposed hundreds of reports
  that could not be searched, navigated, or applied as one project operation;
- proposal findings did not carry authoritative document routing. The renderer could only depend on
  one ambient line-review path, which made cross-file jump and writeback unsafe;
- repeatedly switching Electron `BrowserView` tabs detached and reattached the same view. Electron
  accumulated a `closed` listener on every reattachment, producing a real listener warning on a
  sufficiently active review session. Closing a tab also removed it from the map without explicitly
  closing its `webContents`;
- the first full split-proofread batch cleared the selected document before any child produced a
  valid replacement. A worker failure before its first accepted write could therefore destroy the
  previous document findings while leaving sibling documents intact;
- schema-2 routing could fill a missing report `translationPath` from renderer IPC. That made the
  aggregate report, rather than its caller, cease to be the authoritative document identity.

Corrected boundary:

- folder mode owns exactly one `report/folder.proofread.json` schema-2 artifact. Each finding carries
  `documentId`, absolute `sourcePath`, and absolute `translationPath`; single-file schema 1 remains a
  supported compatibility contract;
- document reset, replacement, snapshot, and rollback operate on one document slice while preserving
  all sibling findings. Report discovery ranks the aggregate artifact above stale per-file reports;
- split proofreading never clears a report at worker startup. Each accepted child write validates
  first and replaces only its assigned range inside the shared findings-file lock; an early worker
  failure leaves the previous aggregate report and summary byte-identical. A clean completed batch
  still records report initialization even when no finding was emitted;
- one proposal-review HTML renders the aggregate report, searches it globally, and filters by source
  document. Jump asks the Host to resolve that finding's document; an existing batch child is reused,
  otherwise the line-review HTML is generated lazily for that document only;
- one apply action groups accepted decisions by document, validates every route against the aggregate
  report, and atomically persists every affected line-review sidecar. It never opens every child page;
- schema-2 jump and apply routes require every finding's absolute source and translation identity
  from the report itself. Missing or mismatched translation metadata is rejected and can never be
  repaired from ambient renderer state;
- audit-whitelist state is document-scoped and canonicalizes absolute-path/document-id aliases so the
  same source cannot acquire duplicate whitelist records;
- legacy proposal migration preserves aggregate routing, project ownership, baseline revisions, and
  conflict/mechanical metadata. Old HTML can enter the current aggregate contract without losing the
  fields needed for safe cross-file application;
- HTML tabs are attached to their owner window once and switched by z-order plus visible bounds.
  Closing a tab removes the view and closes its `webContents`, eliminating repeated owner listeners
  and releasing the tab runtime.

Regression evidence:

- [x] folder report tests cover append, document-local reset, concurrent sibling preservation, and
  report ranking/routing;
- [x] proposal source and legacy migration tests cover per-file filtering, Host-routed jump/apply,
  document metadata retention, and schema-1 compatibility;
- [x] Electron proposal acceptance proves one aggregate report, two independently routed documents,
  lazy generation for a missing child, reuse of an existing child, and one cross-file apply without
  opening all children. The run emits no `MaxListenersExceededWarning`;
- [x] regression tests prove invalid first writes and pre-write split-worker failures preserve the
  prior document slice and shared summary, while valid range replacements preserve sibling findings;
- [x] all 130 unit test files, typecheck, runtime-skill boundary checks, build, and full Electron
  acceptance pass. Electron measured 52 ms interactive startup, 4.1 ms optimistic feedback, and
  7.6 ms parent interaction while children ran; schema-2 missing/wrong translation routes were
  rejected and the aggregate proposal screenshot was captured;
- [x] the same independent reviewer first found the split pre-clear data-loss path, then re-read the
  corrected worktree and returned `PASS` after independently rerunning the focused suites;
- [x] rebuilt Windows 2.0.0 in `release/`; release verification confirmed the 105,146,679-byte
  installer and 104,771,902-byte portable executable, updater/parser metadata, packaged runtime
  boundaries, and SHA-256 checksums. The portable executable reached a stable renderer/window in
  5,952 ms with five Electron processes. Its first launch attempt correctly exposed that the system
  C-drive temp had zero free bytes; rerunning the same artifact with the project G-drive temp proved
  the package itself starts normally.

## 2026-08-11: Exhausted Child Repair Returns To Parent

Root cause:

- translation workers already stopped immediately when a reviewer rejected an unchanged candidate,
  and stopped after three changed-but-still-rejected repair cycles. The resulting hidden Pi
  completion event only told the parent to "repair or retry", however, so the parent could delegate
  the same assignment again even though the child repair path had proven non-retryable.
- the first revision attached `parent_takeover_required` to every generic non-retryable assignment
  error. Malformed reviewer output and Host evidence-commit failures do not prove that exact rejected
  translation lines are ready for parent repair, so that broad classification was unsafe.
- aggregate proposal apply resolved every report document before checking whether the user accepted
  any action in it, and published renderer storage before the Host cross-file transaction committed.
  Untouched projects could therefore generate needless child HTML, while a rejected Host commit
  could leave the UI looking applied.
- line-review `beforeunload` started an asynchronous Host IPC write that the browser lifecycle cannot
  await. Electron acceptance caught the late request after its temporary project had been removed.

Corrected contract:

- review no-progress and exhausted changed-candidate repair use a dedicated
  `ParentTakeoverAssignmentError`. Only this error carries `parent_takeover_required` through the
  supervisor snapshot and hidden Pi completion event;
- the parent is explicitly assigned the exact rejected lines and must use parent-owned bounded
  write tools, then rerun Host mechanical validation and review. It may not delegate that assignment
  again or restart its chunk, queue, or full workflow;
- malformed reviewer responses, Host evidence-commit failures, transport failures, and other generic
  assignment failures keep their own recovery path and are never mislabeled as translation takeover;
- aggregate proposal apply resolves only documents with an accepted/manual action, mutates cloned
  line state, publishes local state only after the Host transaction succeeds, and restores decisions
  on rejection. Schema-2 reports reject one `documentId` mapped to multiple source/translation routes;
- the HTML viewer flushes line-review state before closing a tab or window. `beforeunload` performs
  only synchronous local persistence and cannot start a late unawaitable IPC. The line-review protocol
  was advanced so old HTML auto-upgrades to this lifecycle.

Regression evidence:

- [x] unchanged-candidate rejection stops after the first no-progress repair and publishes one
  structured parent-takeover event with exact document/range/rejected-line metadata;
- [x] changed candidates stop after the three-cycle repair budget and publish the same typed
  takeover without restarting the assignment;
- [x] malformed reviewer output remains a generic non-retryable failure and does not authorize parent
  translation takeover;
- [x] Electron aggregate proposal acceptance proves actionable-only lazy resolution, failed-transaction
  rollback, ambiguous-document rejection, and atomic cross-file apply;
- [x] all 130 unit test files, typecheck, build, and full Electron acceptance pass after the final
  contract and lifecycle changes. Electron measured 68 ms interactive startup, 4.6 ms optimistic
  feedback, and 9.0 ms parent interaction during child work, with no late IPC handler error.

## 2026-08-12: BattleSpirits Restart Audit And Stop-Safe Staging

Observed evidence:

- the stopped eight-worker BattleSpirits run had no provider transport/fetch failure, no reset, and
  no child compaction. Its eight translation children nevertheless used about 524,974 total tokens;
- the children issued 121 project searches and received 75,857 model-visible search-result
  characters. Canonical glossary JSON searches returned only the matching `source` line rather than
  the adjacent `target`, and exact full-name direct matching missed source short forms such as
  `虹宮` for `虹宮トーヤ`;
- three staging writes had been accepted before Stop, but all eight worker staging directories were
  empty afterward and Host alignment ranges were empty. The accepted text therefore could not be
  recovered and a restart would pay to generate it again;
- staged worker records were seeded from one task and then asynchronously claimed another task.
  Labels/document history became contradictory, and per-task provider/model overrides could bind a
  runtime to the wrong assignment.

Corrected contract:

- canonical glossary, character-bible, and glossary-candidate searches return complete bounded
  structured entries. Direct assignment references recognize safe Japanese script-run short forms,
  while old translations and translation-reuse backups remain readable on demand;
- every successful staging write checkpoints its hash-current path and pending review or exact repair
  debt before another provider turn or reviewer handoff. Stop retains that file. Checkpoint/reviewer
  infrastructure failures are non-retryable assignment failures, so the supervisor cannot overwrite
  the staged text from canonical and blindly regenerate it;
- cold planning prioritizes exact rejected-line repair over still-pending review evidence in the same
  scope, then resumes only the remaining read-only review;
- staged persistent workers claim the actual task before child runtime/model creation. Snapshot and
  card label, current document, and document history are refreshed from every claimed assignment;
- translation-start results report the lazy review pool as `activeReviewWorkerCount: 0` plus a
  `reviewWorkerMaximum`, rather than claiming the configured ceiling is already active.

Regression evidence:

- [x] new red/green tests cover full structured glossary lookup plus Japanese short-name matching,
  Stop before reviewer handoff, durable staging checkpoint, mixed repair/pending cold recovery, and
  deliberately reordered staged worker creation with different provider/model identities;
- [x] typecheck, runtime-skill checks, and all 134 unit test files pass;
- [x] full Electron acceptance passes: 45 ms interactive startup, 12.3 ms optimistic feedback, and
  18.8 ms parent interaction during child work; native compaction, per-chunk review, cold restart,
  folder routing, and child transcript loading also pass;
- [x] rebuilt Windows 2.0.0 installer and portable, verified checksums and release metadata, and
  launched the portable successfully in 9,175 ms with five stable Electron processes. The installer
  is 105,154,312 bytes and the portable is 104,779,536 bytes.

## 2026-08-12: BattleSpirits Existing-Translation Reuse Audit

Observed evidence:

- the completed BattleSpirits reuse run covered 171 files and 18,420 source lines. The Host flagged
  781 lines and created 667 assignments for four persistent children: 559 one-line, 102 two-line,
  and six three-line assignments;
- 754 of the 781 signals were `target_language_not_observed`. After removing event/control payload,
  622 flagged rows contained no lexical prose at all; 510 complete assignments existed only because
  of those false positives;
- child usage was 1,758,737 tokens and parent usage was 868,309 tokens. False-positive-only
  assignments consumed 1,323,310 child tokens, 75.2% of child cost. Every assignment also made a
  third provider call after its structured verdict merely to restate counts; those calls consumed
  740,629 tokens;
- preparation rewrote the 6.23 MB audit store once per document and returned about 75 KB of audit
  summaries into the parent context. Completion then made the parent call preparation again just to
  recover totals. The final apply contract accepted one audit id even though the UI asked for one
  decision covering all 171 documents;
- the run did not have a high fetch-error rate: it contained zero raw fetch failures. It had one
  WebSocket close 1006 and one stream inactivity timeout, both recovered. Neither was persisted as a
  `yn_provider_transport_error`, so older logs could not distinguish transport classes reliably;
- child cards were lightweight, but the hidden parent completion event rebuilt each persistent
  worker's complete `documentIds` history, creating another assignment-history-sized parent payload;
- durable verdicts could be complete while a cold in-memory/Host snapshot omitted their pending ids,
  producing the observed mismatch between completed children and an unadvanced reuse-decision state.

Corrected contract:

- the reuse quick scan now strips placeholders, tags, event/control payload, and project custom
  preserve spans with the validator's canonical preservation rules before language/script checks.
  Preservation-only rows no longer create semantic debt;
- pending risk lines are grouped into bounded sparse selected-line assignments per document. The
  child reads those exact lines plus bounded neighboring context and must submit exactly that set;
- a successful `submitTranslationAudit` result terminates the Pi tool turn. The Host derives the
  reuse/retranslate count summary directly, eliminating the third provider call without bypassing
  Pi core or losing the structured tool result;
- folder preparation reads and writes the audit store once. Tool results and parent completion carry
  only aggregate totals; parent completion contains current worker status/progress, not full document
  history. The parent never has to call preparation again to obtain final totals;
- one no-audit-id `applyTranslationReuseDecision` applies every hash-current pending audit owned by
  the parent session in one candidate/store transaction. Any candidate or store failure rolls every
  candidate back. Cold apply reconstructs the pending set from owner, document, source hash, and
  candidate hash, while an unrelated session cannot inherit or recreate that authorization;
- applied legacy documents no longer prevent the remaining ready documents from marking the Host
  decision state ready. This closes the children-completed/Host-not-completed status split;
- raw fetch exceptions, provider stream transport diagnostics, WebSocket close metadata/count, and
  inactivity timeout phase are persisted as bounded `yn_provider_transport_error` custom entries
  before retry settlement. Diagnostics remain out of model context.

Regression and release evidence:

- [x] red/green tests cover preservation-only event rows, sparse risk batching, exact selected-line
  reads, no post-submit provider call, one folder decision transaction, bounded prepare/completion
  payloads, cold owner recovery, WebSocket diagnostics, and inactivity diagnostics;
- [x] final typecheck, runtime-skill boundary checks, and all 135 unit test files pass;
- [x] full Electron Agent/HTML acceptance passes, including visible reuse decision and cold restart.
  The product measured 79 ms interactive startup, 7 ms optimistic feedback, and 12.3 ms parent
  interaction while children were active;
- [x] fresh Windows 2.0.0 artifacts were built in `release-fixed` because an existing process held the
  old `release` portable. Release metadata and SHA-256 checksums verify. The installer is 105,163,791
  bytes, the portable is 104,789,019 bytes, and the portable produced a stable renderer/window in
  8,350 ms with four processes. No pre-existing user process was terminated.

## 2026-08-13: BattleSpirits Full Folder Proofreading Queue

Observed evidence and root causes:

- the failed BattleSpirits proofreading run had a 171-document, 18,420-line manifest but inspected
  and assigned only `ev00000.txt` (18 lines). The earlier aggregate-report change unified the output
  file without replacing the historical current-document proofread scheduler, leaving a hybrid
  contract: folder output with single-document execution;
- the project request carried the folder itself as `translationPath`. Parent inspection happened to
  bypass it, but the child context tool preferred that explicit request field and called `readFile`
  on the directory. This caused six `EISDIR` errors, four resulting context-before-write failures,
  and one invalid-id error;
- the proofread no-progress path threw a generic retryable error, so the supervisor repeated the
  complete assignment after a deterministic Host/tool failure. The one child consumed about 381,145
  tokens even though it never completed the first file;
- persistent proofread workers retained previous assignment conversation in active model context,
  and indexed glossary/character assets were mandatory whole-file references. A successful
  multi-file run would therefore have amplified tokens with every assignment;
- finalization and completion state were recorded only on the current document. Child-card
  completion could disagree with Host folder completion even after an otherwise successful run;
- this run contained zero fetch/provider/transport errors. The visible failures were local Host file
  binding and retry-classification errors, not network failures.

Corrected contract:

- full folder proofreading now completes a hash-bound deterministic prescan for every retained
  manifest document before any semantic child starts, then creates one staged cross-document queue.
  Single-line folder documents remain in that queue, and file-order stages are preserved;
- every task receives its exact source and candidate file through `requestForTask`. A proofread-only
  preflight stats both paths and rejects directories or missing files as non-retryable before the
  first provider call;
- successful empty findings still record Host semantic coverage. No-progress is non-retryable, and
  per-document settlement preserves completed documents while pausing only actual failures;
- persistent proofread workers reset active Pi context between assignments. Built-in workflow and
  style references remain required, while glossary, character-bible, and glossary-candidate indexes
  contribute only complete structured records directly matched by the assigned source. A missing
  ambiguous term uses one exact indexed search instead of whole-file injection;
- glossary-candidate resolution and final readiness cover every folder document. Finalization emits
  only the aggregate `folder.proofread.json` and marks JSON finalization for every document. Child,
  Host, and final report state now share the same scope;
- the translation worker queue, translation review gate, reuse audit, clean-retranslation behavior,
  and translation artifact protocol were not changed. Translation paths were exercised only by
  regression tests.

Regression and release evidence:

- [x] end-to-end folder tests use two files while the base request intentionally points
  `translationPath` at a directory; both assignments complete once, with exact candidate bindings,
  no retry, aggregate JSON finalization, and no incomplete document state;
- [x] tests cover the complete-manifest prescan/queue, single-line documents, stage order,
  zero-provider invalid-path rejection, non-retryable no-progress, assignment context reset,
  direct structured project references, and one folder final settlement;
- [x] typecheck, runtime-skill checks, translation regressions, and all 136 unit test files pass;
- [x] full Electron Agent/HTML acceptance passes, including folder aggregate proofreading,
  cross-file apply, wrong/missing/ambiguous translation rejection, transaction rollback, Host file
  binding, and terminal-state convergence. It measured 42 ms interactive startup, 12.2 ms
  optimistic feedback, and 17.8 ms parent interaction during child work;
- [x] Windows 2.0.0 installer and portable were rebuilt in `release`, metadata and SHA-256 checksums
  verify, and the portable launched with a stable renderer/window in 9,172 ms with four processes.
  The installer is 105,165,813 bytes and the portable is 104,791,088 bytes.

## 2026-08-13: Proofreading Single-Artifact Contract And Report Path

Observed evidence and root causes:

- both single-file and folder prompts still advertised a Markdown proofreading summary beside the
  findings JSON. The Host writer implemented that second output, JSON embedded a `summaryPath`, and
  completion depended on a misleading `proofreadSummaryWritten` bit. This contradicted the product
  flow where the findings JSON is already rendered as human-readable HTML and would spend an extra
  model turn/output on redundant prose;
- `proofreadOutputDir` was already normalized to the project's `report` directory, but the folder
  prompt appended another literal `report/`. The displayed destination therefore became
  `report/report/folder_proofread_summary.md` (and the JSON path was doubled in the same prompt);
- the restarted BattleSpirits run itself correctly prescanned all 171 documents and planned 171
  assignments. Its four child sessions recorded zero `EISDIR`, zero fetch failure, and zero tool
  error before the parent session stopped them about 5.9 seconds after launch. This restart did not
  reproduce the earlier first-file scheduler or candidate-directory bug.

Corrected contract:

- single-file and folder proofreading each persist exactly one output: `*.proofread.json`. The
  prompt, Host writer, finalizer, bundled workflow, README, and completion gate no longer request,
  accept, or generate a Markdown summary;
- finalization validates the existing findings JSON, removes a legacy `summaryPath` field and
  retired companion Markdown when present, and returns compact severity counts as a Host tool result
  without asking the model to author another artifact;
- folder prompt paths are joined once against the already-canonical proofread output directory, so
  the destination is `report/folder.proofread.json`, never `report/report/...`;
- durable Host state now uses `proofreadReportFinalized`. Snapshot schema 5 migrates the former
  `proofreadSummaryWritten` value without persisting the obsolete field, while preserving all
  translation recovery/discovery state carried by schema 4.

Regression and release evidence:

- [x] prompt, Host-writer, domain-state, domain-tool, completion-integration, and proofreading
  subagent tests cover the sole-JSON contract, legacy Markdown removal, schema migration, and the
  exact `report/folder.proofread.json` path without a duplicated `report` segment;
- [x] translation reuse, staged review, sparse repair, and worker-identity regressions pass without
  changing the translation workflow implementation;
- [x] typecheck, runtime-skill checks, and all 136 unit test files pass;
- [x] final Electron Agent/HTML acceptance passes, including `folderProofreadAggregate`, cross-file
  proposal apply, rollback, Host file binding, terminal-state convergence, and a real rendered
  folder-proofreading prompt containing the canonical JSON path and no Markdown path.

## 2026-08-13: Windows Portable Breakpoint At Startup

Observed evidence and root cause:

- repeated portable launches exited with unsigned code `2147483651` (`0x80000003`) after first
  creating the main window and renderer. The process timeline placed the exit at the product's
  eight-second startup-update delay; this was a real product exit, not merely verifier cleanup;
- the portable build correctly disabled automatic installation, but still initialized
  `electron-updater` and called `checkForUpdates()` after eight seconds. On this Windows portable
  target, entering that updater path triggered the breakpoint exception shown by the user;
- the first cleanup hypothesis was falsified by capturing launcher exit code, stdout/stderr, and a
  process timeline before cleanup. The portable verifier now retains that evidence and requests a
  graceful window close before force-cleaning any residual test processes.

Corrected contract:

- update capability is now typed explicitly. Windows portable builds detected through
  `PORTABLE_EXECUTABLE_FILE` neither initialize updater listeners nor schedule/runtime-call
  `electron-updater`; installed builds keep the existing updater path;
- a manual update request from the portable build offers to open the releases page instead of
  invoking the unsupported updater runtime. This fails visibly on user action rather than silently
  swallowing an updater error;
- update-controller and packaging tests prove that the portable capability is wired into the built
  main process and that installed-build behavior remains enabled.

Final release evidence:

- [x] the final Windows 2.0.0 installer and portable were rebuilt in `release`; metadata and SHA-256
  checksums verify. The installer is 105,165,199 bytes and the portable is 104,790,468 bytes;
- [x] the rebuilt portable stayed alive beyond the former eight-second crash point, with a ready
  renderer at 9,025 ms, four stable processes, and the expected `translation-workshop` window;
- [x] the verifier removed its test processes after the stability assertion; no
  `translation-workshop` process remained afterward.

## 2026-08-13: Proofread Inline Reference Double-Read

Observed evidence and root cause:

- BattleSpirits batch `batch_c35e477d-2d15-44e0-a0d6-dab488c80f0b` correctly prescanned all
  171 documents / 18,420 lines and built 171 assignments for four persistent workers. In this
  dataset one file equalled one assignment; larger files still split at the canonical split size
  and workers claim only the next shared assignment after Host settlement;
- `readAssignedProofreadContext` returned the four-character project style and sixteen-character
  work description inline with `complete=true`, correctly advancing their per-assignment Host
  offsets to 4 and 16. The task prompt nevertheless told every child to call
  `readProofreadReference` for every project reference, and the unusable tool remained exposed;
- children therefore called both references again from offset zero. Host correctly rejected those
  calls with required offsets 4/16, but each assignment spent another provider turn on two
  deterministic tool errors. This was prompt/tool-capability contradiction, not cursor leakage or
  failed Pi context reset;
- the observed old-binary run settled 10 documents before the parent session was externally
  stopped. It recorded 30 reference-read errors, zero other tool errors, zero `EISDIR`, zero fetch
  failures, and zero provider transport diagnostics. Host retained the ten settled documents and
  suspended the remaining workflow debt.

Corrected contract:

- assignment guidance explicitly treats `complete=true` manifest entries as already fully read and
  permits `readProofreadReference` only for `complete=false`, beginning at zero and continuing from
  the returned `nextOffset`;
- when an assignment has no paged reference, its Pi toolset omits `readProofreadReference` entirely.
  An oversized required reference still exposes the tool and retains bounded pagination;
- a red/green persistent-worker regression proves both sides of the capability boundary. The full
  25-case proofreading child suite, typecheck, runtime-skill checks, and all 136 unit test files pass;
- final Electron Agent/HTML acceptance passes. Windows 2.0.0 artifacts were rebuilt and checksums
  verified: installer 105,165,337 bytes, portable 104,790,603 bytes. The portable launched with a
  ready renderer in 6,899 ms and four stable processes.

## 2026-08-13: Portable Verifier Must Never Force-Clean Electron

- after the rebuilt portable passed its stability assertion, the verifier's normal window-close
  request timed out and its `finally` block force-killed all four test processes. That cleanup itself
  produced a new user-visible `0x80000003` breakpoint dialog. This was separate from the earlier
  pre-cleanup eight-second updater exit, but presented the same Windows exception code;
- treating `forced residual cleanup` as a successful verification result was incorrect. The verifier
  now only requests `CloseMainWindow`; if processes remain after ten seconds, it detaches from their
  stdio, fails with their exact PIDs, and leaves them untouched for diagnosis. It never calls
  `Stop-Process -Force` or `launcher.kill()`;
- the verifier now also refuses to launch while any Translation Workshop process already exists, so
  release acceptance cannot run beside or interfere with a user's active translation/proofreading
  session;
- a focused source-contract test was first observed red against both destructive cleanup paths and
  now passes. This is a verifier-only change, so the already-built product artifacts did not require
  another slow rebuild or launch.

## 2026-08-13: Proofreading Safety, Resume, And Token Audit

Observed evidence and root causes:

- BattleSpirits split proofreading accepted model-authored `suggestedFix` values whose leading
  `[ev...]` control prefix differed from the exact aligned source/current prefix. Source and current
  translation binding were validated, but the proposed replacement itself had no structural guard;
  16 observed suggestions changed, removed, or invented an `ev` prefix;
- a stopped folder batch persisted whole-document completion only when the entire batch settled.
  Accepted assignments before Stop had no durable range checkpoint, and the next batch planned all
  171 documents again. Ten already settled documents were re-reviewed, spending about 190k child
  context tokens and replacing prior stochastic conclusions;
- each assignment asked the model for a prose summary after `writeAssignedFindings`. The tool result
  did not terminate the Pi loop, so this created one full extra provider call with the assignment
  context. In the audited run, these post-write turns consumed about 1.015m of 2.543m child context
  tokens, roughly 39.9%;
- deterministic H3/H4/H7/H8/H9/M0 signals were correctly described as evidence to children, but the
  report writer converted every unconfirmed signal into a public M0 `mechanical_scan` finding. This
  bypassed the semantic confirmation contract and produced no-op fixes;
- proofreading glossary candidates exposed a free-form category string while the Host accepted only
  six typed values. Unsupported Chinese/English labels were returned as rejected telemetry after a
  successful report write, so discoveries were silently lost instead of being corrected;
- a fresh typed prompt for a Stop-suspended workflow inherited `workflowSuspended`, while the parent
  completion gate suppressed all incomplete reasons whenever that flag was set. The model could
  therefore say the workflow was still running without starting or resuming any child;
- persistent proofread workers already call Pi `resetContext()` between assignments. Their active
  context therefore stays assignment-local and normal Pi threshold compaction remains available but
  is not expected on these short branches. Project searches were not the dominant cost: 28 searches
  returned about 86k characters in the observed run, far below the redundant final-turn waste.

Corrected contract and why it works:

- every incoming finding now compares `suggestedFix` with the exact leading bracket control prefix
  bound from source/current text. A changed, removed, or invented prefix rejects the entire atomic
  range write. Finalization repeats the guard so unsafe findings produced by an older binary cannot
  be delivered;
- split assignments now checkpoint merged, hash-current `{document, translationPath, fromLine,
  toLine}` scopes immediately after Host acceptance and before another assignment is claimed. Queue
  planning subtracts only those current scopes; input changes invalidate them. Whole-document legacy
  completion evidence is migrated only when its report slice passes the current prefix safety check;
- `writeAssignedFindings` is a terminating Pi tool result. The Host synthesizes the lightweight card
  summary, preserving a fresh assistant tool-call message without a third provider request;
- deterministic scan data remains child evidence only. The writer no longer manufactures M0 public
  findings, and finalization removes legacy M0/mechanical entries from the sole JSON artifact;
- the proofreading tool schema now exposes the exact six glossary categories. Any discovery still
  rejected by Host evidence/category validation fails before artifact mutation, so the same child
  must correct it instead of losing it behind a successful tool result;
- a fresh typed same-kind workflow prompt transactionally resumes an ordinary Stop suspension before
  model execution and restores the current project worker ceiling. Persistence failure rolls back to
  a durable suspended state. Exhausted-assignment recovery pauses remain explicitly tool-gated, and
  ordinary chat still receives a fresh bounded contract.

Final verification and release evidence:

- [x] targeted prefix, mechanical-evidence, glossary-schema, terminal-write, partial/full resume,
  cold-state, suspended-session, folder, Monte Carlo, and completion-integration regressions pass;
- [x] the complete test suite passes: all 137 test files, including translation reuse, staged review,
  sparse repair, promotion rollback, folder translation, and translation artifact validation;
- [x] Electron Agent/HTML acceptance passes, including folder aggregate proofreading, cross-file
  apply/rollback, native Pi completion gating, provider retry, compaction, and cold restart;
- [x] Windows 2.0.0 artifacts were rebuilt and checksums verified. Installer: 105,167,142 bytes;
  portable: 104,792,371 bytes. The rebuilt portable rendered in 7,616 ms, stayed stable with five
  processes beyond the old breakpoint window, closed cleanly, and left no product process running.

## 2026-08-13: Full BattleSpirits Proofread Restart Residual Audit

Completed-run evidence:

- parent session `pi_26e60d68-0f90-4172-8fbf-207517d10cef` completed batch
  `batch_df15a5af-3923-47ea-a7ca-0e75cecf5546`: all 171 documents / 18,420 aligned lines were
  accepted, validated, and finalized; no active batch, recovery pause, pending glossary decision,
  provider error, fetch error, transport stall, or completion-contract error remained;
- all 171 accepted writes immediately checkpointed their hash-current split scope. A successful
  `writeAssignedFindings` remained terminal, with zero post-write assistant turns. Persistent child
  context reset kept assignments local, so zero Pi compactions was expected rather than a failure;
- `report/folder.proofread.json` was the only report artifact. Its 381 findings all matched their
  current bound source/translation lines; there were zero unsafe control-prefix changes, zero M0 or
  `mechanical_scan` entries, zero duplicate IDs, and zero duplicate semantic findings. All 171
  `proofreadReportFinalized` markers were true and the parent ended with native Pi `stop`. Persisted
  `fullWorkflowActive: true` names the full-workflow contract scope, not the live runtime phase.

Residual defects and causes:

- prefix generation still wastes a correction turn. The Host correctly rejected 29 writes across
  28 documents. Those batches contained 66 unsafe and 40 safe findings; correction preserved every
  safe finding, corrected 17 unsafe fixes, dropped 46, and converted three into no-op findings. The
  29 correction provider calls consumed 420,217 context tokens. The cause is that the child prompt
  asks for replacement-ready fixes but never says that `suggestedFix` must preserve the exact bound
  leading control prefix and must not diagnose a missing prefix when both aligned rows have none.
  Add that rule to the task prompt and tool description while retaining the Host validator as the
  non-bypassable safety boundary;
- no-op findings pass both write and finalization. Four final findings had identical trimmed
  `currentTranslation` and `suggestedFix` values: `ev40201.txt:L54` and `ev73202.txt:L6,L13,L15`.
  `parseFindingsContent` checks only that the fix is non-empty, while `finalizeProofreadReport`
  filters legacy mechanical findings and checks prefixes but never checks that a fix changes text.
  Reject no-op incoming findings atomically and remove/reject legacy no-ops during finalization;
- exact project lookup is still a major avoidable cost. Children issued 84 searches returning
  274,312 characters. Only 38 query/path pairs were unique; 46 repeated search calls alone consumed
  543,617 context tokens (about $2.53), before counting their results in the following write turn.
  `界放` was searched 27 times at project root and eight more times in the canonical glossary.
  Persistent workers reset correctly, but newly Host-validated proofread candidates remain only in
  per-document Host state until parent resolution, so later assignments cannot receive those
  already-seen direct matches and repeat broad searches. Expose deduplicated, clearly non-canonical
  pending candidate matches in later assigned contexts, and enforce a small proofread-scope result
  cap/compact structured response for the one permitted ambiguity lookup;
- two assignments used unnecessary general browsing: four `listProjectDir` and three
  `readProjectFile` calls consumed 44,069 provider context tokens. One reread its own already-bound
  source and listed `raw`; one looked for the preceding file as cross-file context. Keep the general
  read tools required by the product contract, but state that assigned context already contains the
  complete owned rows and expose exact neighbor/manifest bindings so discovery does not require
  directory walks;
- parent completion used 332,376 context tokens across 12 calls. Its second
  `inspectTranslationContext` returned 115 per-document pending candidate occurrences although only
  45 source/target pairs existed, after which the parent also read the glossary, the first 32k of the
  already Host-validated report, and the candidate file. Group pending candidates by stable ID with
  occurrence count and bounded evidence samples, and let the finalizer's typed result replace manual
  report reads. This preserves the parent's actual terminology decisions while removing redundant
  payload and inspection turns.

## 2026-08-13: Proofread Residual Fixes And Rebuilt 2.0.0 Release

Implemented root-cause corrections:

- the proofread assignment prompt, built-in workflow, and `writeAssignedFindings` description now
  state the same replacement invariant enforced by Host: every fix changes the current row and
  preserves the exact leading bracket control prefix; a prefix cannot be invented or diagnosed when
  both aligned rows have none. The existing structural validator remains authoritative;
- `writeProofreadFindings` rejects an exact no-op only after binding incoming source/current rows,
  preserving legitimate whitespace-only formatting corrections while preventing identical fixes.
  Finalization removes legacy no-op findings and reports the removal count, so reports written by an
  older binary cannot leak them into the sole JSON deliverable;
- one proofread batch now owns a concurrency-safe exact-search cache shared by persistent workers.
  General proofread searches are capped at eight matches; repeated exact lookups return at most three
  cached evidence rows. Later assignments receive matching prior-search evidence after Pi
  `resetContext()` rather than issuing the same broad query again;
- accepted assignment glossary discoveries are registered and persisted immediately. Later assigned
  contexts receive matching deduplicated entries explicitly marked non-canonical/pending, so they can
  reuse evidence without treating unresolved terminology as approved glossary data;
- proofread prompts and tool descriptions explicitly treat assigned and boundary rows as complete,
  retaining general read tools for genuine references while preventing directory walks, raw-asset
  browsing, or rereads of the bound source/current translation;
- parent inspection groups glossary candidates by stable ID, returns occurrence/document counts and
  at most three evidence samples, and resolves/finalizes unique decisions rather than per-document
  copies. The parent system prompt treats inspector/finalizer typed results as authoritative and no
  longer asks the model to reread Host-owned report/glossary files for recounting.

Verification and release evidence:

- [x] prefix/no-op, legacy finalization, shared search evidence, pending-candidate injection, folder
  aggregation, parent guidance, and persistent-worker regressions pass;
- [x] the complete test suite passes: all 137 test files, including translation reuse, folder
  translation, staged review, sparse repair, interrupted review recovery, and promotion rollback;
- [x] full Electron Agent/HTML acceptance passes, including aggregate proofreading, cross-file
  apply/rollback, native Pi completion gating, provider retry, compaction, translation reuse, and cold
  restart recovery;
- [x] an already-running old portable locked the canonical output. It was not terminated. Both Windows
  targets were rebuilt in an independent release directory; stale `latest.yml` from the interrupted
  first build was detected by release verification, then installer, portable, blockmap, metadata, and
  checksums were regenerated as one coherent set and copied to canonical `release` after the user
  closed the old app;
- [x] `release` checksums and packaged ASAR contents verify. Installer: 105,168,896 bytes; portable:
  94,271,104 bytes. The rebuilt portable created a ready renderer in 10,483 ms, stayed stable with five
  processes and the expected window, then closed gracefully without forced process termination.

## 2026-08-13: Folder Proposal One-Click Apply Default-State Repair

Observed evidence and root cause:

- the real BattleSpirits aggregate proposal HTML contained 381 actionable suggestions across 133
  documents, but every embedded proposal was `unreviewed` and its durable decision map was empty;
- the folder JSON `findingToProposal` conversion and legacy migration supplied `unreviewed`, while an
  earlier aggregate optimization resolved only accepted/manual documents. Their composition made the
  one-click button select zero documents. Existing Electron coverage manually inserted accepted
  decisions before clicking, so it bypassed the real default state and stayed green;
- the page visually presented the normal Accept action while its embedded contract disagreed, which
  also explains why the established single-file interaction and the new folder JSON path behaved
  differently.

Corrected contract and why it works:

- actionable semantic findings parsed from JSON or Markdown now default to `accepted`; mechanical
  evidence remains `unreviewed`, and explicit rejected/manual/conflict decisions remain authoritative;
- proposal protocol v7 upgrades old aggregate HTML and normalizes legacy actionable `unreviewed`
  proposals to `accepted`. The button also treats legacy unreviewed suggestions as accepted during
  apply, so stale data cannot recreate the no-op;
- bulk apply stays one Host transaction, preserves source/current/revision safety checks, rolls back
  staged decisions on rejection, disables the button while running, shows failures in-page, and keeps
  a bounded `__ynProposalApplyTrace` for diagnosis.

Verification and release evidence:

- [x] the old runtime failed the new exact one-click regression with zero resolved documents; the
  corrected runtime applies every default suggestion while skipping conflicts and mechanical evidence;
- [x] the real BattleSpirits v6 HTML upgrades read-only to v7 with exactly 381 accepted proposals over
  the same 133 document routes;
- [x] all 137 test files pass, including parser defaults, legacy migration, atomic rollback, conflict
  handling, and cross-file routing;
- [x] full Electron Agent/HTML acceptance passes, including a folder proposal click with no manually
  seeded accepted decisions and durable edits in all three fixture documents;
- [x] canonical 2.0.0 artifacts were rebuilt and release checksums verify. Installer: 105,169,369
  bytes; portable: 104,794,591 bytes. Portable startup rendered in 6,928 ms with a stable application
  window, but the verifier's graceful-close request left three headless processes and correctly did
  not force-terminate them; close-path acceptance therefore remains explicitly unresolved rather than
  being reported as a pass.

## 2026-08-13: Folder Proposal/Batch TXT Artifact Identity Repair

Observed evidence and root cause:

- the real BattleSpirits batch index owned 171 child HTML files, all created before translation and
  recorded as `missing-translation`; the original `ev00000` child had 18 rows and zero non-empty
  translations;
- aggregate proposal apply resolved 133 finding documents to a second
  `.translation-workshop/html/proposal-line-review` tree because the original children lacked a
  translation binding. Their sidecars therefore received the accepted edits while folder batch TXT
  continued to enumerate only the original 171 index children;
- batch TXT already used the current candidate file as its baseline, but it could not see edits stored
  under the second child identity. It also silently chose the first of sidecar/HTML/index translation
  paths and could create a partial blank artifact when no baseline existed.

Corrected contract and why it works:

- the folder batch index is now the sole canonical document-to-child identity. Before aggregate apply,
  Host validates the report's embedded routes, resolves every indexed document's current translation,
  requires exact source/translation line alignment, regenerates all canonical child HTML files with
  current translation text and binding, and updates the batch index metadata in one rollback-capable
  text transaction;
- resolving a single jump before bulk apply synchronizes that exact canonical child rather than
  creating a parallel proposal child. Preparation clears renderer document caches and reloads an open
  folder tab, so later safety checks and the visible folder page read the synchronized artifacts;
- deterministic legacy `proposal-line-review` state is migrated only when it does not conflict with
  existing canonical per-line state. After the canonical transaction commits, the exact duplicate HTML
  and sidecar are removed; conflicting state fails visibly instead of choosing a winner;
- batch TXT now rejects divergent index/child/sidecar target paths, missing current baselines, and line
  count drift. A fully edited sidecar remains a valid standalone baseline, but a partial edit map can no
  longer manufacture the untouched lines of a missing translation;
- proposal protocol v8 calls the typed batch-preparation IPC before staging any suggestion and binds
  the report route to the proposal page's embedded route, preventing a changed report from mutating
  canonical children before the existing transaction safety check.

Verification and release evidence:

- [x] the new Electron regression failed on the previous runtime while waiting for the canonical
  chapter-B child; the corrected runtime synchronizes three initially empty batch children, migrates a
  seeded legacy child/state, leaves no parallel proposal child, applies all three suggestions, and the
  folder button writes three complete TXT files with the accepted edits;
- [x] focused batch tests cover metadata rebinding, divergent binding rejection, partial missing-baseline
  rejection, line-count drift, current-file overlay and traversal safety;
- [x] all 137 test files pass, and the complete LAN/proposal/folder/Agent/cold-restart Electron suite
  passes with the new legacy migration and end-to-end batch TXT assertions;
- [x] packaged ASAR contains the new preparation IPC and divergent-binding guard. Canonical 2.0.0
  checksums verify. Installer: 105,172,102 bytes; portable: 104,797,375 bytes;
- [ ] portable startup rendered in 7,335 ms with a stable four-process app and the expected main window,
  but its graceful-close request timed out and left three responsive headless verifier processes. They
  were not force-terminated; close-path acceptance remains unresolved.
## 2026-08-13: Duplicate Proposal Artifact Consolidation And Headless Acceptance

- Folder proposal apply no longer treats differing canonical/legacy line state as an authorization conflict. The batch index child is the sole identity for each translation TXT; every legacy `proposal-line-review` artifact bound to that TXT is merged in modification order, then deleted after the canonical atomic commit.
- Real BattleSpirits evidence: canonical `ev00000.txt` line 10 contained machine-imported `细致规则`; its legacy proposal sidecar contained the later accepted manual `详细规则`. The migration now keeps the accepted proposal and removes the duplicate instead of throwing.
- Electron acceptance is product-wide headless/offscreen or rendered outside the visible desktop. Do not execute electron-builder's NSIS portable envelope during automated acceptance: on this host the envelope reaches `0x80000003` after the Electron child exits even when the child uses an application-owned hidden smoke lifecycle. Runtime acceptance launches `release/win-unpacked/translation-workshop.exe`, which loads the real packaged renderer invisibly, writes a readiness marker, and quits itself. The portable artifact is verified structurally and by checksum only.

## 2026-08-13: BattleSpirits Retained-Manifest And Parent Review Contract Repair

Observed evidence and root causes:

- parent session `pi_e2f86dc1-dac4-4000-bff5-c4a222fdd651` contained the exact generated
  translation marker and a project file order retaining only
  `basic_system_tutorial_for_translation_v2.txt`, but its first Host checkpoint was
  `fullWorkflowActive=false`. `inspectTranslationContext` therefore exposed all 172 source files and
  reuse preparation audited 171 old candidates / 18,420 lines before touching the one new file;
- the runtime treated missing renderer `workflowIntent` metadata as an ordinary local task even though
  the generated marker was intact. Folder-order filtering was conditional on the full Host contract,
  so this silent downgrade bypassed the authoritative retained manifest and the specialized translation
  worker/reviewer scheduler;
- the specialized read-only review pool already used failure-only `submitTranslationReview`, but the
  parent/local `recordTranslationAlignmentChecks` schema still required an `aligned|misaligned` verdict
  and prose reason for every selected row. Generic/direct writes also registered every changed row as
  semantic debt. Five parent alignment submissions alone consumed about 298,330 tokens in the observed
  run and persisted a roughly 2 MB parent JSONL;
- filtering only the newly resolved source manifest was insufficient on cold continuation: restored
  DomainRun documents, pending reuse audit IDs, proofread state, and alignment state were additive, so
  removed files could remain invisible to tools while still blocking completion.

Implemented contract:

- an exact generated workflow marker restores missing typed intent; a marker/typed mismatch fails.
  Typed intent without a marker can only continue the same incomplete Host workflow and cannot start a
  fresh complete workflow;
- full folder workflows now atomically replace the restored DomainRun manifest with the current ordered
  file set, prune omitted proofread/alignment state, scope durable reuse-audit hydration to retained
  document IDs before reading their files, and replace stale pending reuse-audit authorization;
- parent alignment review now accepts only `failures: [{line, code, note}]`; `failures: []` silently
  accepts all currently pending Host-selected rows. Already accepted rows require no reread, acquire no
  pass reason, and remain hash-bound;
- direct and generic bounded repairs now create only mechanical-risk plus deterministic square-root
  sample debt. A parent-owned local mutation retains accepted evidence outside its exact write range
  without turning the mutation length into one verdict per row.

Final verification and release evidence:

- [x] focused session, DomainRun, workflow-transition, parent-tool, alignment-state, reuse-policy,
  reuse-session, and durable reuse-audit regressions pass;
- [x] the complete test suite passes: all 137 test files, including translation reuse, folder order,
  cold workflow restore, bounded repair, translation review, proofreading, and lifecycle transitions;
- [x] full hidden Electron Agent/HTML acceptance passes, including folder manifest inspection,
  translation reuse decision/restart, independent translation reviewers, native completion gating,
  provider retry, compaction, and cold restart;
- [x] Windows 2.0.0 artifacts were rebuilt and checksums verified. Installer: 105,173,727 bytes;
  portable: 104,798,954 bytes. Runtime acceptance launched only the hidden
  `release/win-unpacked/translation-workshop.exe`, rendered in 3,570 ms, and exited cleanly. The NSIS
  portable envelope was not executed.

## 2026-08-14: Folder Proposal Route And Child Synchronization Consistency

Observed evidence and root cause:

- the real BattleSpirits batch index contained 171 canonical children after proposal apply: 133 were
  rebound to current translations while 38 still said `missing-translation`. `ev10001` already had a
  current 21-line candidate TXT, but its child HTML still contained zero translated rows;
- the aggregate proposal HTML embedded the first child `001-ev00000.html` as `lineReviewPath`, not the
  owning batch index. `prepareProposalLineReviewBatch` therefore correctly classified the route as a
  single line-review document and skipped all-child synchronization. Per-finding resolution later
  synchronized only the 133 documents present in the report; zero-finding documents stayed empty;
- batch TXT planning independently used each current candidate TXT as its baseline. That prevented
  data loss but made the UI and write path disagree: the TXT could be complete while an unopened child
  HTML still looked blank.

Implemented contract and why it works:

- a generated batch child now resolves through its deterministic sibling batch index, with full index
  parsing and ownership validation. Proposal generation, project discovery, and old proposal-page
  repair all receive that canonical index instead of the child route;
- proposal synchronization and batch TXT planning now share the same current-translation binding
  resolver. Explicit sidecar/HTML/index bindings, including a user-imported translation outside the
  default candidate path, remain authoritative and divergent explicit bindings fail; only an actually
  unbound child may accept the report route or canonical candidate default;
- opening an existing proposal HTML that embeds a batch child rewrites its route to the owning index.
  One-click apply consequently runs the existing atomic all-indexed-child synchronization before any
  suggestion state is committed, including documents with no findings;
- folder match state remains machine metadata for binding and validation, but protocol v6 removes the
  stale same-name match badge and suffix from the file selector. Existing folder indexes upgrade to v6
  on open.

Verification evidence:

- [x] the exact UI regression failed before the change and now hides both the status badge and selector
  suffix;
- [x] a child-to-index ownership regression resolves both nested children and the index itself;
- [x] an imported child translation regression proves proposal synchronization and batch TXT select
  the same explicit target instead of silently falling back to different paths;
- [x] the Electron proposal fixture starts from a child route, includes a fourth complete document with
  zero findings, repairs an intentionally stale proposal route, synchronizes all four child HTML files,
  and writes all four TXT files without changing the zero-finding translation;
- [x] all 138 unit test files and the complete hidden Electron LAN/proposal/folder/Agent/cold-restart
  suite pass.

## 2026-08-14: Per-Assignment Terminology Commit Gate

Observed evidence and root cause:

- accepted translation assignments only persisted raw discoveries in DomainRun; the candidate file was
  written after the entire child batch settled, so later workers could not read newly established names;
- `resolveTranslationDiscoveries` blindly replaced an existing candidate target for the same source,
  allowing the last parent decision or discovery to hide an earlier conflicting translation;
- `onTaskCompleted` ran before only that worker's next claim. There was no batch-global claim gate,
  durable conflict state, or same-batch priority repair wave;
- parent completion embedded raw child discoveries only at terminal settlement, while active workers
  received a bounded list of unapproved hints that could itself contain incompatible targets.

Implemented contract and why it works:

- DomainRun schema v6 preserves all hash-bound observations separately from pending decisions and stores
  typed terminology conflicts with targets, documents, affected ranges, and owning batch;
- every mechanically and semantically accepted assignment now atomically commits non-conflicting terms
  to `AI_translation/_workspace/glossary_candidates.json`. Same-target evidence merges; formal glossary
  entries win and remove stale same-source candidate entries; different targets never overwrite;
- a durable conflict closes a batch-global asynchronous claim gate. After already-running assignments
  reach quiescence, the existing Pi native parent-notification path delivers one bounded conflict event;
- parent resolution writes the selected candidate only when backed by the recorded conflict, derives
  exact affected-line debt from retained observations, injects those repairs into the live batch's
  priority wave, and releases the gate only after Host state persistence and repair enqueueing;
- idle workers cannot skip an active priority wave. Successful repairs mechanically clear exact debt;
  failed repairs stop later queue progress instead of letting inconsistent terminology spread;
- batch completion counts only original assignments, not injected repair work, and terminal parent
  context reports only unresolved Host records rather than replaying already committed child payloads.

Verification evidence:

- [x] DomainRun conflict state survives snapshot/restore, keeps observed evidence after resolution, and
  blocks claim waiters until an explicit committed release;
- [x] a domain-tool regression proves the first split writes the provisional candidate immediately, a
  conflicting second split cannot overwrite it, the live gate blocks, resolution enqueues only L2, and
  the repaired line clears terminology debt;
- [x] a scheduler regression proves two workers both stop at the shared gate and that no original task
  can pass an active priority-repair barrier.

Final transaction, restore, and scheduling audit:

- candidate mutation, DomainRun observation/conflict/debt mutation, and Host persistence now run inside
  one per-project serialized transaction. A failed persist rolls back only its own uncommitted state and
  cannot erase a later assignment's successful candidate or observation commit;
- repair routing is based on current supervisor ownership, not a conflict's historical batch id. Debt
  without a live owner remains durable and is rescanned against current source/candidate bytes before the
  next translation batch;
- cold conflict authorization is hash-current. Stale source/candidate ranges are removed from pending
  conflict state before dispatch while full observed evidence remains available for audit;
- persisted debt is a common post-processing stage for folder outstanding work, single-file explicit
  tasks, and applied-reuse sparse tasks. Exact ordinary ranges are split around terminology repair lines;
  a retained staging/review scope is upgraded intact rather than being split into an invalid artifact;
- repair-only documents may be reserved with zero ordinary assignments, while batch task totals and
  settlement counts remain exact. Dynamic repairs never inflate original assignment completion.

Final verification evidence:

- [x] fourth-round independent review returned PASS with no remaining P1/P2;
- [x] folder, single-file cold debt with two workers, applied-reuse cold debt, stale-hash restore,
  cross-document repair ownership, transaction rollback, and real two-worker priority barriers pass;
- [x] `npm test` passes all 138 test files after the final common planner change.
- [x] the complete hidden Electron Agent/HTML acceptance passes after the final change, including LAN
  terminal convergence, proposal/folder synchronization, reuse decision/restart, reviewer gating,
  provider retry, compaction, and cold restart;
- [x] Windows 2.0.0 artifacts were rebuilt and checksums verified. Installer: 105,180,831 bytes;
  portable: 104,806,049 bytes. Packaged runtime acceptance launched only hidden
  `release/win-unpacked/translation-workshop.exe`, rendered in 1,922 ms, and exited cleanly. The NSIS
  portable envelope was not executed.

## 2026-08-14: Remove Prompt-Only Pseudo Workflows

Observed evidence and root cause:

- the product registry exposed five peers, but only `initial_translation` and `proofread` create typed
  Host contracts with DomainRun state, schedulers, validators, durable artifacts, and completion gates;
- `terminology_sweep`, `character_voice_check`, and `final_qa` only populated the desktop Prompt box.
  They were never called by translation or proofreading and still referenced removed Function names,
  so the UI and guide overstated the reliable product surface and created dead maintenance paths;
- terminology, character voice, and final QA are already enforced inside the canonical translation and
  proofreading workflows through indexed assets, deterministic scans, semantic workers, review gates,
  and final validation.

Implemented contract and why it works:

- the visible registry now contains only the two Harness-backed workflows, and the renderer has no
  generic preset prompt branches or preset-only parameter panels;
- old persisted template ids canonicalize through the existing `getWorkflowTemplate` fallback to
  `initial_translation`, so removing the UI entries does not strand legacy projects;
- product copy and the full guide now describe two workflows and keep terminology, voice, and final QA
  as internal checks rather than advertising unsupported standalone artifacts;
- `AGENTS.md` records that a new visible Workflow requires a typed DomainRun, scheduler, validator,
  durable artifact, and completion gate rather than only a prefilled Prompt.

Verification evidence:

- [x] focused registry tests prove the only visible ids are `initial_translation` and `proofread`, old
  persisted ids canonicalize safely, and retired prompt/function copy is absent from product and guide;
- [x] `npm test` passes all 138 test files;
- [x] the guide rendered with two registry rows, two jump links, and two deep dives at desktop and
  390x844 viewports, with no retired ids, console errors, or horizontal overflow;
- [x] the complete hidden Electron Agent/HTML acceptance passed, including LAN convergence, folder and
  proposal synchronization, native Pi UI, provider retry, compaction, and cold restart;
- [x] Windows 2.0.0 artifacts were rebuilt and checksums verified. Installer: 105,180,361 bytes;
  portable: 104,805,582 bytes. Packaged runtime acceptance launched only hidden
  `release/win-unpacked/translation-workshop.exe`, rendered in 1,276 ms, and exited cleanly. The NSIS
  portable envelope was not executed.

Resolved verifier debt:

- `verify:electron-project-open` now targets the multi-`BrowserView` tab host through
  `getBrowserViews()`, supplies a current proofread JSON routing fixture, and runs hidden views with real
  offscreen rendering. Without offscreen rendering, the hidden line-review renderer stopped servicing
  DOM evaluation even though its URL/title had loaded, causing the old harness to hang;
- the Node launcher no longer calls `child.kill()` on timeout. A bounded watchdog now runs inside the
  Electron verifier process, which records its current phase, cleans up its own windows/temp projects,
  and exits with an observable failure;
- the restored acceptance keeps four real review tabs, validates the active-tab project pointer, live
  project settings/assets, nested folder generation, and screenshots. The verifier passes end to end
  with `multiBrowserViewTabs=true` and a 315 ms first interactive review in the final run.

## 2026-08-14: Glossary-Candidate Toggle Boundary

Observed evidence and root cause:

- the project checkbox reached the typed request and completion requirements, but the new per-assignment
  terminology commit path treated every translation run as candidate-enabled. Child validation still
  requested discoveries, Host committed them, restored candidate-derived debt, installed the batch claim
  gate, and rebuilt terminology debt during final validation even when `glossaryCandidates=false`;
- disabling candidate generation must not hide the existing candidate file. It remains useful as a
  read-only consistency reference and can reduce translation token use; only new discovery construction,
  reporting, mutation, gating, and repair scheduling are disabled.

Implemented contract and why it works:

- the child still receives bounded direct matches and exact-search access to the existing
  `glossary_candidates.json`, while its submission schema and prompt omit new candidate discoveries when
  the switch is off;
- Host filters accidental glossary reports before DomainRun mutation, does not write the candidate file,
  does not install a terminology claim gate, and does not restore or rebuild candidate-derived repair
  debt. Stale pending candidate-only Host state is removed without deleting the existing reference file;
- the formal project glossary remains authoritative and continues through ordinary mechanical
  validation. Character-fact collection follows its own independent switch.

Verification evidence:

- [x] focused Domain-tool tests prove no candidate file, gate, priority repair, discovery hint, or final
  validation debt is created while disabled, including a cold state containing old candidate debt;
- [x] focused child-lifecycle tests prove the existing candidate and formal glossary remain readable but
  the child validation schema cannot submit new candidate discoveries;
- [x] all 138 unit test files pass. One first-pass failure in the pre-existing deterministic review-context
  sampling assertion passed both focused runs and the complete clean rerun;
- [x] the complete hidden Electron Agent/HTML acceptance passes, including LAN terminal convergence,
  proposal/folder synchronization, native child UI, reuse, reviewer gates, retries, compaction, and restart;
- [x] Windows 2.0.0 artifacts were rebuilt and checksums verified. Installer: 105,181,060 bytes;
  portable: 104,806,332 bytes. Packaged runtime acceptance launched only hidden
  `release/win-unpacked/translation-workshop.exe`, rendered in 3,010 ms, and exited cleanly. The NSIS
  portable envelope was not executed.
