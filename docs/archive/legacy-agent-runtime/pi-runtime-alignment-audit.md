# Pi Runtime Alignment Audit

Date: 2026-06-28

## Goal

把当前 Agent Workbench 重构为“以 Pi runtime 为基底的轻量翻译/校对任务 OS”：直接采用或 port Pi 的通用 Agent session/run/event/tool/queue/abort 设计，保留本项目的翻译、校对、导入、验证、translation memory 和 line review 领域层。

2026-07-01 更新：之前的“薄适配旧存储、不迁移 live runtime”路线在真实使用中失败。现象包括同一会话多个 running/queued job、关闭页面后旧 job 不可靠中止、thinking/tool/subagent 只能靠 reload 和 eventRef 拼装、长 run 静默。新的方向是反过来：Pi-style runtime 是 live source of truth；旧 job/conversation/event store 只能作为兼容、导入、历史浏览或 artifact 索引层。

## External References

- Pi sessions: https://pi.dev/docs/latest/sessions
- Pi compaction: https://pi.dev/docs/latest/compaction
- Pi skills: https://pi.dev/docs/latest/skills
- Pi SDK/runtime: https://pi.dev/docs/latest/sdk
- Pi providers: https://pi.dev/docs/latest/providers

如果后续 vendor 任何 Pi 代码，必须先记录 upstream commit、license/NOTICE、改动范围和本仓 package seam。

## P1: Architecture Map

当前 Agent runtime 的真实边界在 `src/main/agent` 与 `src/shared/agent`。

| Runtime area | Current modules | Persistent surface | User-visible surface | Pi alignment target |
| --- | --- | --- | --- | --- |
| Session/events | `conversationStore.ts`, `jobStore.ts`, `jobManager.ts`, `agentEventBroadcast.ts`, `sessionUiStore.ts` | `.translation-workshop/agent/*` conversations/jobs/session UI | sidebar conversation, popout page, job timeline | Pi-style session entries and event stream adapter |
| Compaction/memory | `loopContextCompression.ts`, `jobCheckpointStore.ts`, `translationMemory.ts` | checkpoints, translation memory, compressed request payload only | resume quality, cache hit rate, long-job coherence | session-aware summary + first kept entry + recent tail |
| Subagents | `subagentSpawner.ts`, `subagentOrchestrator.ts`, `subagentToolModes.ts`, `subagentShardValidation.ts`, `subagentOutputFirewall.ts` | job checkpoint and conversation events | parallel shard execution, retry, status | Pi-style child session isolation, await/retry contract, capped parent output |
| Prompt cache | `promptCacheStore.ts`, provider adapters | prompt-cache usage files | cache hit/miss telemetry | stable prefix, provider-specific cache points, session affinity |
| Skills | `skillRegistry.ts`, `skillLoader.ts`, `hostTools.ts` `readSkillReference` | bundled skills under `skills/translate-text` and `skills/proofread-translation` | agent can load translation/proofread rules | Pi-style progressive disclosure: summary first, full body on demand |
| Providers | `providerConfigStore.ts`, `oauthAuthResolver.ts`, `providerPresets.ts`, provider adapters | `provider-config.json`, OAuth profiles | model/provider selector and auth settings | provider registry with capabilities, auth modes, cache/reasoning support |

Explicit non-goals:

- 不复制 Pi 的完整 CLI/UI。
- 不替换翻译/校对 validator、artifact import、line review、translation memory。
- 不恢复 Codex CLI 或 Claude Code 作为 Agent runtime provider；它们最多保留为安装/技能生态相关概念。
- 不在没有 license/NOTICE 审计的情况下 vendor 第三方代码。

## P2: Concrete Trace

一条真实 translation/proofread agent path:

1. UI 发起 job，输入源是 selected document、job type、language pair、provider id。
2. `jobManager.ts` 创建 job/conversation，写入 job store，并通过 `agentEventBroadcast.ts` 更新 session snapshot。
3. `runProviderJob.ts` 读取 provider config，构造 skill hash 与 `promptCacheKey`。
4. 非 chat job 会通过 `skillLoader.ts` 预读 skill corpus，并把 `readSkillReference` 结果作为 tool message 放进对话上下文。
5. `agentLoop.ts` 每轮调用 `compactAgentLoopContext`，生成 compacted messages 与 compaction sidecar，再交给 provider adapter。
6. model 返回文本或 host tool call，`hostTools.ts` 执行读取文件、写 chunk、校验、spawn subagent 等工具。
7. subagent path 进入 `subagentSpawner.ts`，child 结果经 `subagentOutputFirewall.ts` 压缩后回到 parent。
8. 事件写入 conversation/job/checkpoint，最终副作用是译文草稿、校对 findings JSON、artifact import 或 job completed/failed。

当前最大压力点在第 5 步：`loopContextCompression.ts` 是基于消息窗口的 deterministic trim。它能避免 prompt 过长，但没有 Pi-style compaction 的 stable session entry、summary sidecar、firstKeptEntryId 和 cache-friendly invariant。因此长任务会同时影响：

- cache 命中率；
- 子任务返回后的父任务记忆稳定性；
- resume 后模型对“已经做过什么”的判断；
- skill/tool result 是否稳定留在 prefix。

## P3: Design Decision

选择“Pi runtime-first seam”，而不是继续补丁式自研。

核心 invariant:

- 翻译/校对领域层继续由本仓负责。
- runtime 层只暴露少数深接口：`prompt`, `steer`, `followUp`, `abort`, `subscribe`, `listEntries`, `getState`。
- UI 消费 runtime-owned session entries and live events；job/conversation/event JSON 不再共同决定 live busy state。
- 同一个 session/conversation 同时最多一个 active run。新输入必须进入 Pi-style steering/follow-up queue，或在无 run 时开始新 run。

10x scale 先失败的是 compaction/cache，而不是 provider 列表或 UI polish。原因是文档越长、subagent 越多、conversation 越久，消息裁剪会让稳定 prefix 和任务记忆一起漂移。先改 compaction seam，后续 session adapter、cache metrics、subagent API 都能沿着同一个结构收敛。

## Current State vs Pi Target

| Area | Current state | Gap | Decision |
| --- | --- | --- | --- |
| Sessions | 有 conversation/job/event store，并通过 `listPiSessionEntries` 投影为 Pi-like entries | 不是 Pi 原生 JSONL tree；live ownership 分散 | 新建 Pi-style runtime session 为 live owner；旧存储降级为 history/artifact compatibility |
| Compaction | `compactAgentLoopContext` 生成 `summary`, `firstKeptEntryId`, `keptRecentEntryIds`, `stablePrefixHash` | 没有 runtime-owned session entries/branch context | Port Pi session compaction shape; YN-specific checkpoint remains separate |
| Subagents | spawn/await/retry/parallel/shard validation/output cap 已有，事件 payload 带 `runtime.kind = "pi-subagent"` | 没有独立 child session store；UI 易把 child progress 当主聊天文本 | Child sessions become runtime child runs; parent observes child cards/results through structured blocks |
| Cache | provider request key 由 base key + compaction `stablePrefixHash` 派生；Anthropic cache_control 保留 | cache telemetry 仍是本仓格式 | 统一 cache policy helper；不换 provider adapters |
| Skills | `buildPiSkillManifest` 暴露 name/description/summary/reference loader；全文通过 `readSkillReference` | 不使用 Pi skill package format 作为落盘格式 | progressive disclosure adapter；保留本仓 skill 内容 |
| Providers | `getProviderDescriptor` 暴露 models/default/auth/cache/reasoning capabilities | UI 仍逐步迁到 descriptor 消费 | provider descriptor 是 runtime source of truth |

## Implementation Status Audit

The old completion audit below is retained as historical context only. It is not
the current acceptance state for the Agent OS, because real target use disproved
the live runtime/UI invariants.

This table is the completion audit for the requested alignment scope. Evidence is current worktree state, not git history.

| Requirement | Evidence | Verification | Status |
| --- | --- | --- | --- |
| Audit Pi sessions/compaction/subagent/cache/skills/provider mechanisms | This document maps all six runtime areas and references Pi docs. | `docs/pi-runtime-alignment-audit.md` | Done |
| Decide vendor/thin-adapt/no-migrate scope | Vendor policy says default no vendor; runtime uses thin adapters; translation/proofread domain is explicit non-goal for migration. | This document, `Vendor Policy`, `Explicit non-goals` | Done |
| Session alignment | `listPiSessionEntries` projects conversation messages and linked job events to stable Pi-like entries. | `tests/agent/jobRuntime.test.mjs` covers stable `msg_`/`evt_` ids feeding compaction. | Done |
| Compaction alignment | `compactAgentLoopContext` returns compacted messages plus sidecar with entry count, first kept entry id, recent ids, stable prefix hash, summary. | `tests/agent/hostToolsCapabilities.test.mjs` covers sidecar, stable hash, skill reference preservation. | Done |
| Provider cache alignment | `buildProviderPromptCacheKey` derives provider cache key from compaction `stablePrefixHash`; agent loop passes derived key to provider adapters. | `tests/agent/oauthPromptCache.test.mjs` covers derived key and agent-loop usage. | Done |
| Subagent runtime alignment | `subagentRuntimeContract` writes parent/child session ids and `PER_TASK_OUTPUT_CAP` into subagent events. | `tests/agent/subagentSpawner.test.mjs` covers skip-path persisted event contract; subagent output firewall tests cover 50KB cap. | Done |
| Skills progressive disclosure alignment | `buildPiSkillManifest` exposes name/description/summary/loader; `loadSkillSummary` uses it; full workflow still loads via `readSkillReference`. | `tests/agent/agentLoop.test.mjs` covers no workflow body in manifest and full corpus loading via reference. | Done |
| Provider capability alignment | `getProviderDescriptor` exposes auth modes, cache strategy, prompt-cache support, reasoning support, default model, model catalog. | `tests/agent/providerModels.test.mjs` covers ChatGPT OAuth, Claude OAuth, Custom API capabilities. | Done |
| Preserve translation/proofread domain layer | Translation chunk writer, proofread findings JSON, validator, artifact discovery/import, translation memory remain local domain modules. | Existing tests cover `writeTranslationChunk`, `writeProofreadFindings`, validation, artifact import, translation memory. | Done |
| Full regression gate | Full test suite passed at the time, but did not catch real duplicate active jobs or silent long runs. | Insufficient; keep as legacy evidence only. | Superseded |

## Pi Runtime-First Migration Matrix

| Pi module/pattern to port | Why YN needs it | YN adapter / kept domain logic | First acceptance check |
| --- | --- | --- | --- |
| `packages/agent/src/agent.ts` active run owner | Prevent duplicate active jobs; own abort, queues, streaming state | Wrap provider config and YN tools; old job ids become compatibility metadata | Starting prompt while active cannot create a second run |
| `packages/agent/src/agent-loop.ts` message/tool loop | Stop ad hoc autonomous continue and hidden tool retries; execute tool calls then continue like Pi | `shouldStopAfterTurn` enforces translate/proofread completion and validation gates | Tool call turn yields assistant toolCall block, toolResult block, then next assistant turn |
| `packages/agent/src/types.ts` block/event contract | UI can render growing text/thinking/tool blocks without raw protocol text | Add YN custom blocks for artifact/subagent summaries only where needed | `message_update` grows same assistant message; no shorter overwrite |
| `packages/coding-agent/src/core/agent-session.ts` queue semantics | `/btw`, steering, follow-up, abort should be runtime behavior, not session-ui patching | Extension system can be omitted; keep prompt/skill expansion and queue mode behavior | Steer during active tool run appears as user message and is consumed next turn |
| Pi JSONL session manager shape | Stable session entries, branch/compaction/cache identity | Store under `.translation-workshop/agent/pi-sessions`; old conversation store imports/exports | Reopen reads same session and does not infer stale running job from old job JSON |
| pi-web `useAgentSession` SSE reducer | Immediate visible feedback and stable expanded thinking/tool blocks | Electron embed can implement same reducer in vanilla JS or move to React page | Send shows streaming/thinking state immediately before first final assistant text |
| pi-web `MessageView` block renderer | One assistant message contains text/thinking/tool; tool results inline | Keep YN styling but render Pi block types directly | Tool/subagent details are expandable blocks inside transcript, not top tags |

## What To Remove Or Demote

| Current module/behavior | New role |
| --- | --- |
| `activeJobRuns.ts` keyed only by job id | Replace with session-owned active run registry keyed by runtime session id. |
| `agentEventBroadcast.ts` snapshot as live truth | Demote to compatibility telemetry derived from runtime state. |
| `runProviderJob.ts` as primary run orchestrator | Replace with thin adapter that creates/resumes a runtime session and registers YN host tools. |
| `agentLoop.ts` ad hoc loop | Replace with Pi-style loop; keep only YN-specific stop/validation hooks. |
| `agentChatEmbed.ts` eventRef transcript reconstruction | Replace transcript rendering with Pi message block reducer; old transcript adapter only for legacy history. |
| Persisted `running/queued` job JSON after renderer close | Not allowed as live truth. On startup, unresolved old jobs must be marked interrupted/stale or attached to a real runtime session. |

## Migration Slices

### 1. Pi-Compatible Compaction Sidecar

入口文件：

- `src/main/agent/loopContextCompression.ts`
- `src/main/agent/agentLoop.ts`
- `src/main/agent/runProviderJob.ts`
- `src/main/agent/jobCheckpointStore.ts`

实现目标：

- 为 conversation/job 生成 compaction state：`summary`, `firstKeptEntryId`, `keptRecentEntryIds`, `stablePrefixHash`。
- provider request 由 compaction state + recent tail 生成，而不是直接裁剪 messages。
- `readSkillReference`、system prompt、provider/model config、job objective 保持 stable prefix。
- checkpoints 仍用于 job resume，不混入 long-context memory summary。

验收：

- 单测覆盖 first kept entry、recent tail、tool result preservation、skill reference preservation。
- 长对话两次 provider request 的 stable prefix hash 不因最新 user turn 改变。
- `npm run test` 通过。

### 2. Pi Session Adapter

入口文件：

- `src/main/agent/conversationStore.ts`
- `src/main/agent/jobStore.ts`
- `src/main/agent/agentEventBroadcast.ts`
- `src/shared/agent/events.ts`

实现目标：

- 增加只读 adapter，把现有 conversation/job/event 投影为 Pi-like session entries。
- 保留现有落盘格式，避免一次性迁移历史数据。
- compaction sidecar 引用 adapter entry id，而不是内部 message index。

验收：

- 旧 `.translation-workshop/agent` 数据可读。
- 新旧 UI 都只通过同一 snapshot/event model 显示 agent 状态。

### 3. Subagent Runtime Contract

入口文件：

- `src/main/agent/subagentSpawner.ts`
- `src/main/agent/subagentOrchestrator.ts`
- `src/main/agent/subagentToolModes.ts`
- `src/main/agent/subagentOutputFirewall.ts`

实现目标：

- parent/child session 关系显式写入 event。
- `spawnSubagent`, `awaitSubagent`, retry, background mode 使用统一 payload。
- parent 只收到 capped summary/artifacts，不直接吃完整 child transcript。

验收：

- parallel shard retry 不丢 line-range ownership。
- parent prompt 中 child 输出有固定上限。
- failed child 可由 checkpoint resume。

### 4. Provider Cache Policy

入口文件：

- `src/main/agent/promptCacheStore.ts`
- `src/main/agent/providers/*.ts`
- `src/shared/agent/providerPresets.ts`
- `src/shared/agent/providerModels.ts`

实现目标：

- provider descriptor 声明 `supportsPromptCache`, `cacheStrategy`, `supportsReasoning`, `authModes`。
- OpenAI/Codex/Anthropic/OpenAI-compatible 的 cache control 在一个 policy 层决策。
- UI 显示 hit/miss/read/write tokens 时不依赖 provider-specific 字段名。

验收：

- 相同 skill + job type + language pair 的 stable prefix cache key 稳定。
- cache usage telemetry 能区分 unsupported、miss、hit、partial hit。

### 5. Skill Loader Compatibility

入口文件：

- `src/main/agent/skillRegistry.ts`
- `src/main/agent/skillLoader.ts`
- `skills/translate-text/*`
- `skills/proofread-translation/*`
- `docs/skill-integration.md`

实现目标：

- skill manifest/summary/full body 对齐 Pi progressive disclosure。
- agent prompt 中只放 summary 与加载规则；具体翻译/校对协议通过 `readSkillReference` 拉取。
- 翻译和校对 skill 仍是本仓领域规则，不从 Pi 覆盖。

验收：

- translation/proofread job 第一轮能读到对应 skill。
- chat job 不强制塞满 full skill corpus。
- compression 不会丢掉已加载 skill reference。

## Vendor Policy

默认不 vendor。只有当某个 Pi runtime module 满足以下条件时才考虑 vendor：

1. license/NOTICE 可合规保留；
2. module 边界小，能作为 adapter implementation 放进本仓；
3. 不拖入 Pi CLI/UI 或不需要的 deploy/runtime 假设；
4. 有本仓测试证明翻译/校对工作流不回退。

优先级是“复用设计和数据模型 > 薄适配接口 > vendor 小模块 > 手写 fallback”。

## Residual Risk

- This project does not vendor Pi runtime code. The alignment is by data model, event contract, cache key strategy, and progressive-disclosure skill/provider descriptors.
- Session storage remains the existing `.translation-workshop/agent` JSON files. `listPiSessionEntries` is the compatibility seam; migrate storage only if a future feature needs Pi-native JSONL branching.
- UI can gradually consume `getProviderDescriptor` and compaction/subagent event metadata, but the runtime source of truth now exists.
