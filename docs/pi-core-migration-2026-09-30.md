# Isolated Pi core migration

Implemented on `codex/pi-core-migration`, separately from HTML glossary management.
YN's application version remains 2.1.2. No installer release, publication or push
was performed. Verification packaging is under the ignored audit directory.

## Scope and benefits

Both `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are pinned exactly
to **0.99.1**, upgraded together from 0.80.6. Node's minimum is now 22.19.0;
packaged Electron's bundled Node meets it. The official reference is
[Pi v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1).

YN continues to use the native core `Agent`, rather than replacing its Host
scheduler with a different harness. UI, translation/proofread tools, validators,
worker counts, completion gates, login choices and project assets retain their
existing contracts. No upstream image-generation or other new product workflow
was added.

The migration adopts native transactional Session v4, native branches and the
new compaction retained-tail representation. It also adopts the native system
transcript for prompt and tool declarations. A compatibility defect uncovered
by the persistent-worker tests is fixed: reset followed by reconfiguration now
sends the current assignment's prompt/tools, without retaining the preceding
assignment in active context. Full audit history is preserved.

Compaction cancellation now reaches the official compaction request. Session
handles are shared with the active owner and closed after temporary reads or
worker disposal; sidebar titles remain streaming reads, avoiding an extra full
history load per listed session. Diagnostic scripts understand both native
committed transaction arrays and single writes, without counting retained tails
twice. These are concrete integration improvements; no general reduction in
network failures or memory usage is claimed from this upgrade alone.

Failed runtime preparation also closes a newly opened session while preserving
an existing active owner; the service's 52-case regression covers both paths.
One pre-existing nondeterministic test assumed merged review context could never
exceed 23 rows. Its assertion now checks the actual existing contract: bounded
±2 context, complete selected-line coverage, no duplicates and stable repeated
reads. The review algorithm itself was not changed.

## Compatibility and rollback

- Legacy v3 is readable before mutation. Before any legacy slimming or native
  conversion, the original file is saved as `<session>.jsonl.v3.backup` using
  exclusive atomic publication. A conflicting backup, malformed file or failed
  conversion is surfaced. The source is not silently discarded.
- First successful write uses Pi's native v3-to-v4 conversion. Message, Host
  state, prior compaction, name and usage preservation are covered by migration
  and cold-reopen tests. Parent ownership uses native session IDs; old paths are
  a validated migration fallback only. Session selection remains explicit.
- v4 context reconstruction follows the official retained-tail projection via
  `sessionAccess.ts`. Pi's internal helper is not publicly exported. Model
  hydration filters failed assistant turns as upstream does; display/audit
  still retains them. System declarations do not become UI chat bubbles.
- The existing IPC telemetry field `firstKeptEntryId` now references the native
  compaction entry owning `retainedTail`; no obsolete v3 cut is synthesized.
- Existing explicitly configured retired model IDs use frozen official 0.80.6
  metadata with an installed compatible adapter. Current model discovery still
  comes from Pi and the validated remote catalog. Unknown APIs remain rejected.
  Grok effort controls preserve YN's explicit 4.5/4.6 contracts.
- Upstream xAI's chat adapter is now Responses. API-key and Grok OAuth entrances
  retain their existing separation and Bearer credentials. A live xAI network
  call was not performed; its catalog/auth/effort integration is covered by
  local regression tests.

For rollback, stop the application first and retain a complete copy of current
parent/child session directories and backups. Return both packages and code to
the previous commit, then restore the corresponding v3 files from their backups
if older core must read them. A v3 backup predates subsequent v4 conversation;
restoring it cannot preserve those later turns. Newly created v4 sessions have
no v3 original. Do not overwrite or downgrade current v4 files in place.
Translation outputs, glossary and character bible are not session-format assets.

## Verification

- `npm test`: typecheck, protocol checks and **all 158 test files passed**.
  Includes migration/backup/failure recovery, worker context reset, queued
  steering, native compaction, tool-result retention, retry, translation,
  proofreading, review repair, shared assets and glossary tests.
- `npm run build`: passed.
- Complete hidden Electron acceptance: LAN edits/session convergence after SSE
  loss, proposal apply/rollback, folder tabs, main Agent and popout, parallel
  children, Stop/retry, compaction, reuse, EPUB bindings and separate-process
  cold-start recovery all passed.
- `npm run verify:electron-glossary`: candidate preview, selective deletion and
  import, legacy HTML upgrade, cross-window synchronization and reload passed.
- Real ChatGPT acceptance with a temporary copy of user configuration: selected
  `gpt-5.6-sol` completed one native tool call and the final reply, saved in v4.
  Original configuration files were not modified. This is a bounded core/auth
  acceptance, not an exhaustive real-provider translation benchmark.
- Local `electron-builder --dir --publish never` and packaged launch passed;
  packaged prescan worker heartbeat and clean exit were verified.

Final synthetic Electron measurements: initial interaction 68 ms, optimistic composer
5.6 ms, parent interaction during children 22.9 ms, renderer working set
333,968 KiB and combined working set 1,079,024 KiB at the final sample. Folder
parent JSONL was 68,562 bytes; maximum retained child card was 683 bytes.
These measurements describe this acceptance run, not a comparison with 0.80.6.

Audit evidence: `artifacts/pi-upgrade-audit/migrated-final-test.log`,
`build-final.log`, `electron-final.log`, `electron-agent-final.log`, `glossary-final.log`,
`real-core-smoke.log`, `package-final.log`, `packaged-launch-final.log`. The old isolated
baseline and official package declarations are also preserved there.
