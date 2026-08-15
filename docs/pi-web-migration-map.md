# Pi / Pi-web Migration Map

Last updated: 2026-08-09

This map distinguishes source reuse from YN specialization. The product is not
allowed to route an old YN runtime through a pi-web-shaped adapter.

## Pi Runtime

| Pi source / package | YN destination | Treatment | Reason |
| --- | --- | --- | --- |
| Pi core `Agent`, `AgentSession` lifecycle source, and native events | `src/main/agent/piNative/sessionAgentRuntime.ts` + `sessionService.ts` | Source-adapted runtime plus thin Electron lifecycle owner | Preserve Pi prompt/tool/queue/abort semantics while accepting native custom completion messages; do not recreate an agent loop or bridge the deleted YN runtime. |
| Pi `JsonlSessionRepo` and `NodeExecutionEnv` | `src/main/agent/piNative/sessionRepository.ts` | Direct dependency, path policy added | Persist and reload native Pi `AgentMessage[]`; support physical session deletion. |
| Pi `Models`, model/provider types, OAuth implementations | `src/main/agent/piNative/providerRegistry.ts` | Direct dependency, YN config discovery added | Use Pi provider behavior and list all configured models across providers. |
| Pi `JsonlSessionRepo` + the same core `Agent` runtime | `src/main/agent/piNative/subagentRunner.ts` + `sessionRepository.ts#createChild` | Direct dependency, child-session path policy and range-restricted YN tools added | Run real concurrent child Pi runtimes with independently reopenable Pi JSONL rather than simulated jobs or in-memory transcripts; child tools cannot delegate again. The Host creates line-balanced, non-overlapping assignments across files and dynamically feeds them to persistent workers. Validated chunks are Host-sequenced inside the same child session, and focused repair preserves already accepted candidate lines. |
| Pi assistant/tool result/custom message contract | `src/shared/agent/piSessionContract.ts` and native package types | Kept native | The renderer receives one message language only. |
| Pi `prepareCompaction`/`compact`, `Session.buildContext()`, and compaction thresholds | `sessionAgentRuntime.ts`, `sessionService.ts`, native session IPC, and `piSessionContract.ts` | Source-adapted, Electron lifecycle projection added | Keep long-session memory in Pi JSONL instead of adding a YN summary store or renderer-side compressor. Active child batches defer compaction rather than blocking parent conversation. |

## Pi-web Frontend

| pi-web module | YN destination | Treatment | Reason |
| --- | --- | --- | --- |
| `lib/types.ts` | `src/renderer/agent/piweb/types.ts` | Source-adapted and slimmed | Keep only user/assistant/tool-result/custom messages and their content blocks. Generic extension, branch, session-tree, and RPC types are deleted; native compaction state stays in the shared Pi session contract rather than the message language. |
| `lib/normalize.ts` | `src/renderer/agent/piweb/normalize.ts` | Source-adapted | Normalize native tool-call field variants only; no legacy transcript migration. |
| `components/MessageView.tsx` | `src/renderer/agent/piweb/MessageView.tsx` | Source-adapted | Keep text, collapsed thinking, paired tool results, usage, token speed, copy, timestamps, and custom blocks; specialize one stable collapsed card for each YN child runtime. Its Reply view renders the complete child Pi transcript, including paired tools, rather than a synthetic `Done.` summary. Unbacked fork/navigation/edit interfaces are removed. |
| `components/ChatInput.tsx` | `src/renderer/agent/piweb/ChatInput.tsx` | Source-adapted and slimmed | Keep Enter/Shift+Enter, Stop, steer, follow-up, model picker, thinking selector, host prompt insertion, Pi-web image paste/attachment behavior, and the Pi-web slash palette state machine. Images remain native Pi image content from composer through prompt/Steer/Follow-up and are shown only when the selected Pi catalog model advertises image input. The palette exposes only product-backed actions: Pi progress/session stats, native `/compact`, copy, model/provider settings, new session, abort, steer, and follow-up. Omit name/fork/tree, retry/sound controls, and skill/tool presets because this Electron product has no backing interface for them. |
| `components/ChatWindow.tsx` | `src/renderer/agent/piweb/ChatWindow.tsx` | Source-adapted for embedded HTML | Keep ordered transcript, streaming tail, scroll protection, sessions, physical deletion, close/popout, compact telemetry, and non-destructive inline errors that never replace the transcript. |
| `components/ChatMinimap.tsx` | `src/renderer/agent/piweb/ChatMinimap.tsx` | Source-adapted | Preserve long-transcript navigation without changing message ownership. |
| `hooks/useAgentSession.ts` | `src/renderer/agent/piweb/useAgentSession.ts` | State machine migrated to Electron IPC | Preserve optimistic messages, native streaming, queue controls, compaction lifecycle/context telemetry, reconnect/resume, scroll ownership, and terminal convergence. One synchronous store is the sole provider/model/session authority for both rendering and command reads. |
| pi-web provider/model settings concepts | `ProviderSettingsPanel.tsx`, `providerRegistry.ts`, provider IPC | Adapted | Electron settings replace Next routes; multiple configured providers coexist and all available models appear in the composer. |

## YN-only Additions

| Module | Classification | Responsibility |
| --- | --- | --- |
| `systemPrompt.ts` | YN specialization | Translation/proofreading intent and mandatory artifact workflow. |
| `ynDomainTools.ts` | YN host tools | Safe project access, chunk writes, validators, findings, translation memory, and subagent launch. |
| `subagentRunner.ts` restricted tools | YN specialization on Pi core runtime | Run the configured native Pi child count, enforce host-owned files/ranges, cancellation, live transcript inspection/steering, and artifact/findings validation. Child runtimes cannot launch children. |
| `subagentSupervisor.ts` | YN lifecycle specialization around Pi runtimes | Publish one replaceable live card per child, persist only initial/terminal cards, expose inspect/steer, stop the full batch atomically, and deliver a hidden native custom completion message that wakes the parent. Folder work uses line-count-weighted reservations across persistent workers with idle-worker stealing, not one runtime per file or an unbalanced global tail. |
| `domainRunContract.ts` | YN host completion gate | Bind generated prompts through typed intent, bind tool-driven free-form intent through a native tool enum, reject cross-workflow artifacts, account completion from accepted assignment coverage, and use parent-only handling when children are disabled or work is too small to benefit. Project counts are ceilings; only a current explicit user count is exact. |
| project asset and validator modules | Existing YN domain layer | Glossary, character bible, style, line alignment, placeholders, imports, and findings contracts. Formal JSON assets reject invalid collection, entry, and field schemas before either parent or child validation can read a reduced rule set. |
| `sourceManifest.ts` + per-document `domainRunContract.ts` state | YN specialization on the Pi workflow | Resolve a selected folder into one immutable host manifest, bind one source document at a time, preserve relative artifact paths, and require every document to finish through the same Pi-native child/parent validation contract. |
| `workspaceAssets.ts` + native File menu/asset IPC | Existing YN domain layer | Strictly validate generated glossary and character-bible artifacts, expose the character bible through the native Electron File menu, and atomically import generated glossary candidates when no external glossary is selected. |
| `embedded.tsx` and `PiWebAgentWindow.tsx` | Electron hosts | Mount the same Agent OS in the HTML dock or lightweight renderer popout. The normal popout is the dedicated `agent-chat-window` renderer and subscribes to the same main-process Pi service/JSONL session. If opening that renderer through IPC fails, the compatibility fallback opens the current host HTML at `#agent-chat-popout`; it mounts the same React host and still owns no independent runtime. |
| `reviewHtmlUpgrade.ts` + `batchReviewUpgradePaths.ts` + `atomicFile.ts` | Electron HTML compatibility boundary | Upgrade old folder indexes and their child line-review files before render. Child references must be relative, contain no `.`/`..` segments, resolve canonically to non-symlinked HTML files inside the batch directory, and pass full parse/transform preflight before any write. Multi-file changes stage and commit as one rollback-capable transaction. Migration versions are monotonic and named future/malformed markers are rejected before parsing the current schema. |
| `ynInterfaceContext.ts` + `interfaceContextStore.ts` + `readYnInterfaceContext` | YN adapter into Pi Host tools | Publish one validated, workspace-scoped, short-lived snapshot of the current line-review page, viewport, active row, source, and translation. The Agent reads it only through a native Pi Host tool; renderer state never becomes transcript text or a second runtime contract. Source-row right-click inserts a localized question into the same dock/popout composer. |
| `lineReviewStateSync.ts` + line-review state IPC | YN Host state boundary | Keep one revisioned canonical sidecar per line-review path. Folder iframe and standalone HTML views submit changed-line patches and receive the same broadcast state, preventing stale whole-document writes from rolling back another view before batch TXT export. |
| `lanSyncRuntime.ts` + line-review persistence bridge | YN Host state boundary | Stage remote line edits, persist them through the same canonical desktop HTML/sidecar path, then commit and broadcast. A failed disk/desktop write cannot leave mobile, desktop, and batch export with different translations. |

## Deliberately Omitted

- Next.js API routes and browser server infrastructure;
- generic skill marketplace/install UI and generic skill selector;
- full file explorer and branch/fork navigator;
- generic extension marketplace/demo surfaces;
- old YN jobs panel, approval state machine, status transcript, runtime protocol,
  and duplicate dock renderer.

Fixed translation/proofreading capabilities remain internal runtime resources.
They are exposed through semantic prompts and host tools, not through a visible
skill parameter wall.

`/btw` is a renderer command over the current native Pi session state. It opens
the same run/session panel used by the telemetry button and never creates a
message, legacy status entry, or job record. Slash commands that invoke Pi
operations call the existing native session actions; unsupported generic Pi
commands are not advertised.

## Compatibility Boundary

Compatibility exists only at the HTML host boundary: old generated HTML is
upgraded to the current embed protocol and mounts the current React Agent OS.
No old transcript, event, job, or status object crosses into the current session
IPC or renderer.

Folder-review children inherit the complete top-level preload host before the
same `embedded.tsx` entry mounts. Switching the folder iframe unmounts the React
root and its Pi IPC subscriptions on `pagehide`. The folder index opens a child
through the production `openPath` IPC, which adds a tab to the existing HTML
workbench; it does not call `window.open` or create another Agent runtime.

The HTML dock's open-as-page action normally loads the dedicated renderer
`agent-chat-window` route. It passes `outputDir`, language pair, source,
translation, and line-review context to the same Pi session service. If that
Electron IPC action rejects or is unavailable, the host-shell compatibility
fallback opens the already-current line-review HTML at `#agent-chat-popout`.
Both routes mount the same Agent OS and session; neither creates a second
runtime or transcript.

The current Agent embed protocol is `pi-web-react-embedded-v12`, the
line-review protocol marker is `translation-workshop-line-review-v28`, and the
prompt-settings protocol is v34. They keep the typed workflow,
language-pair, extracted-EPUB, folder prompt-scope, and locale contracts while
adding the main-owned live YN interface-context publisher, explicit source-selection question,
native Pi image input, and canonical same-file line-review state synchronization.
A child still edits one concrete file, while its Agent request sends the parent
folder as a typed folder selection. Older HTML is rewritten before mounting.
