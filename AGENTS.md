# Agent 工作准则

本文件记录本项目 Agent/Workbench 路线中容易反复踩坑的高层约束。具体实现细节以代码和测试为准。

## 上下文

- 压缩记忆、切线程、side conversation 后，先读 active goal、`docs/agent-runtime-memory.md` 和当前 worktree；不要把压缩前最后一条可见消息重新解释成旧任务。只有用户当前明确改变目标时才重定向。
- 接手 Agent/Pi 对齐工作时，不要靠旧聊天摘要重启路线图。执行清单项时同步更新记忆文件，完成后把对应 TODO 标为 Done。
- 修改前先追真实路径：用户看到的页面可能来自 React 侧栏、弹出 HTML、或旧 line-review embed。不要只看其中一套。
- 已有 pi/pi-web 本地参考时，先对照它们的信息显示和 runtime 语义，再决定本项目最小改动。

## Agent UI

- UI 要像 pi-web 一样把 thinking/tool/subagent 作为对话流里的结构化 block 展示；不要显示 job id、顶部标签墙或普通聊天垃圾文本。
- 顶部只放用户能理解的总体状态和轻量 telemetry。内部 hook、tool name、turn counter、裸协议文本不得泄漏到顶部或聊天正文。
- 侧栏、弹出网页、旧 HTML embed 必须行为一致；修一个入口时要确认另外两个入口没有继续跑旧逻辑。

## HTML 自动升级

- 每次改 line-review HTML / Agent embed / 页面内脚本协议，都必须同步更新旧 HTML 自动升级逻辑。
- 不能只保证新生成 HTML 正确；app 打开旧 HTML 时也要自动重写到当前协议，否则用户实际看到的还是旧 UI。
- 升级判断必须使用明确 marker/version。不要靠“某几个字符串存在”来猜测已经是最新版。
- 自动升级要有 legacy 测试覆盖：缺少当前 marker/version 的旧 HTML 必须触发升级，升级后必须包含当前 embed 行为。

## Agent Runtime

- Agent loop 是“调用工具 -> 读结果 -> 决定下一步 -> 完成或在普通对话中澄清”，不是回复一句话就结束，也不是另建 `wait_for_human` 状态机。
- 产品运行时只能是以 Pi 源码为基底的 core `Agent` runtime + Pi JSONL + Pi `AgentMessage[]`；parent 与 child 都使用同一个 `PiSessionAgentRuntime`，旧 job/status/transcript/provider/CLI 口径只能作为一次性迁移输入，不能进入 IPC 或 renderer contract。
- Pi `queue_update` 必须以原始 `AgentMessage[]` 贯穿 main、IPC 和 renderer；不得压成计数。foreground tool/child 运行时，Steer/Follow-up 要立即在 composer 显示并可由同一 Pi harness 在工具返回后消费。
- 子 Agent 的 Steer 只有在对应 user message 已由 Pi core 消费并写入 child Pi Session 后才能报告 accepted；若已进入 idle/settling 必须明确拒绝。Pi 最后一次 queue poll 后到 `agent_end` 的竞态用原生 `Agent.continue()` 排空，不得另建 YN 队列状态机。
- 长会话记忆必须使用 Pi JSONL `compaction` entry、Pi `compact`/`prepareCompaction`、`Session.buildContext()` 和 Pi 的阈值判断；不得另建 YN 摘要文件、记忆状态机或 renderer 侧压缩。活动 child runtime 期间不得手动压缩，自动阈值压缩应延后而不能阻断 parent 交互。
- 持久 child 在 assignment 间显式 `resetContext()` 后，阈值判断和后续 Pi compaction 只能读取该 reset 之后仍在模型 active context 的 session branch；完整 child JSONL 仍保留用于审计，但不得因已丢弃的历史接近阈值而生成摘要或把旧 assignment 重新注入模型。
- subagent 是可监控、可合并、可校验的分片执行单元；主 Agent 必须负责汇总和最终报告。
- 子 Agent 默认继承 parent 当前 provider/model；仅可从 Pi 返回的已配置模型目录中显式换用轻量模型。产品不设置固定的全进程 child runtime 并发上限；child toolset 禁止再次启动 subagent。
- 项目设置的 child 数量永远是 `1..N` 上限；只有用户在当前指令中明确写出的数量才是 exact。该来源必须作为 typed contract 贯穿 session、system prompt、domain run 和 Host tool，禁止把配置上限、行数启发式或旧 turn 的数量升级为 exact 硬约束。Host contract 必须分别记录实际 `workerCount` 与队列 `taskCount`：exact 只约束 live worker 数，completion 只按已接受 assignment 的结果数结算。
- 显式用户委派与生成式完整工作流是两条不同的原生 Pi 路径：用户要求“先定位再叫 5 个分别调查/精确修复”时，parent 必须通过 prompt-defined `runSubagents` 保留每个具体任务及用户口头数量；不得替换成 `runTranslationSubagents`、不得重启整批翻译、不得回落到页面默认数量。Parent 与 child 的只读 list/search/read 工具可读取当前项目任意相关文件，也必须直接接受用户提供的项目外绝对路径；相对路径才以项目目录为根。读取不受项目边界、委派文件或行范围限制，不得另建 approval 状态。所有 artifact 写入仍受 host 工具的项目、文件、行所有权与 validator 限制，项目外文件和源文件永远不可写。
- Tool 可用性必须由 typed operation scope 决定，禁止按工具名维护 suspended-workflow 黑名单。只读检查不恢复工作流；精确局部修复只占用自己的 document/range；完整翻译或校对的变更才要求匹配且 active 的完整 workflow contract。Host 必须先原子预留并持久化 batch，再启动 supervisor；启动失败回滚同一预留，任何重复 active batch 都必须在 child runtime 创建前拒绝。
- parent Pi 消息中的 child 卡片只能保存最新的轻量状态与 child session 引用，绝不能嵌入 child transcript。完整 child 对话只属于 child Pi JSONL；用户展开 Reply 时经 parent ownership 校验按需读取，折叠后释放 renderer 中的 child transcript。
- 文件夹批处理由 host 按用户设置的 `splitSize` 把大文件切成不重叠行块，再动态派发给不超过用户配置上限的持久 Pi worker；worker 完成一块后领取当前已开放阶段的下一块，不能保留会制造长尾的整文件私有队列，也不能按文件数或行块数制造 child runtime。assignment 数可以超过 worker 上限；assignment 少于上限时不得为填满配置数制造空闲 worker，除非当前用户明确要求 exact 数量。用户文件顺序是 typed metadata：大括号内共享并行阶段，大括号前后按书写顺序形成严格屏障。并发写入必须经过候选文件锁，每块校验后仍需整文件最终校验。
- 每个 host-owned child prompt 必须产生该 prompt 之后的新 Pi assistant message；旧的 assistant 尾消息不能被当作当前 turn 的回复。可恢复的无新回复/transport stall 只能在同一 child session 中有界重试。
- canonical glossary、character bible 和 glossary-candidate 的 child 检索必须返回完整结构化记录，不能只返回 JSON/Markdown 命中行；assigned-source 直达匹配还要识别安全的日文专名短称。旧译文、备份译文及其他项目文件仍允许按需读取，不能用边界策略阻断本来能节省 token 的参考。
- 翻译 child 只能在强制校验工具中结构化上报新专名、译名候选和角色事实，并附自己负责行范围内的证据；child 不直接改共享资产。每个 assignment 通过机械校验和只读审阅后，Host 必须立即把术语发现按 source/candidate hash 记为 observed：正式 glossary 优先；同一原词同一译名合并证据并原子写入 provisional glossary candidate；同一原词不同译名不得覆盖或并存于 candidate，必须持久化为 conflict 并关闭整个 batch 的新 assignment 领取门。所有已运行 assignment 到达门后，Host 通过原生 Pi follow-up 唤醒 parent；parent 解决冲突后，Host 在同一 batch 中优先派发并结算精确受影响行修复，全部通过后才恢复原队列。完整 observed 证据继续留在 Host state，character facts 和不能自动决定的非冲突发现仍由 parent 在 completion 阶段统一研究与决策。
- glossary candidate、DomainRun 术语状态和 Host 持久化属于同一个按项目串行的可回滚提交边界，绝不能只锁 candidate 文件后在锁外修改其余状态。术语修复必须路由到当前实际拥有对应 document/range 的 active batch，不能信任 observation/conflict 中保存的旧 batchId；没有 active owner 时保留 durable debt，下一次无论走 folder、single-file explicit 还是 applied-reuse 计划，都必须先按当前 source/candidate 重扫并作为真实 priority wave 注入。冷恢复 conflict/range 只有 sourceHash 与 candidateHash 仍匹配当前切片时才能授予额外写权限；过期授权必须持久删除但保留 observed 审计证据。仅因术语修复而被当前 batch 拥有的文档允许 assignmentCount 为 0，但所有文档计数总和仍必须严格等于 reserved taskCount。
- 完整翻译使用两个彼此独立但同属一个 Host 调度器的持久 Pi worker pool：翻译池负责读取、翻译和受管候选写入；审阅池只读，负责复核 Host 机械扫描选出的全部高风险行、其邻近上下文和确定性抽样。正常行样本数按当前 chunk 行数的平方根向上取整，不设固定 32 行上限；同一 hash-bound chunk 的样本必须稳定。每个翻译 chunk 必须先通过机械校验，再由审阅 worker 只上报失败行；若上下文行明显延续同一缺陷，reviewer 可以把它升级为修复债务，下一轮复审窗口以该行重新居中，使问题范围逐步向邻近行扩展。失败原因回到写出该 chunk 的同一翻译 worker 修复并重新审阅，通过后该 worker 才能经过术语提交门领取下一 assignment。术语冲突修复属于同一 batch 的 priority wave：优先队列为空但仍有活动修复时，其余 worker 必须等待，禁止越过修复领取原队列。修复复审必须保留同一 scope 内此前已经接受的风险/抽样证据，不能只保留失败行后把完整证据误报为缺失。审阅通过行不得逐行生成理由或临时报告。主 Agent 不再串行逐片审阅，只在所有 assignment 结算后执行一次全文 Host 机械校验、处理剩余非术语共享资产发现并汇报。审阅 worker 数是项目级 `1..N` 上限，默认跟随翻译 worker 数；Stop 必须同时中止两个池和术语领取门等待者。
- 审阅拒绝必须只包含精确失败行、机器码和可直接执行的短修改说明；通过行不产生理由。相同候选 hash 被复审再次拒绝表示翻译 worker 没有取得进展，必须立即作为不可盲重试的 assignment failure 暴露；候选持续变化但仍未通过时也只允许有界修复，不得重启整块或完整翻译队列反复烧 token。
- host 报告的 `requiredBatchLines` 是权威修复债务，即使普通 validator 对短行或标点行只给 warning/通过也不能清空。每次成功但未接受的写入必须立即结束当前 Pi tool turn，把下一轮修复所有权交还 host。
- Stop 只终止活动 Pi runtime、worker pool 与 domain run；已经按 source/candidate hash 绑定的 proofread/alignment 证据必须持久保留。审阅期间的 hash-current staging candidate 也必须保留；冷启动只能信任 staging/canonical path、line count 与 range input hash 仍匹配当前文件的 scope。过期 scope 必须从 Host state 删除。已有候选文字绝不等于完成，只有 Host 接受的 scope 才能结清债务。中止发生在审阅阶段时应从同一 staging artifact 续跑只读 review turn，审阅拒绝后只修复并复审精确失败行，不能因为取消状态清空证据后退回整片重译或整片复审。staging 到 canonical 的提升、domain revision、alignment evidence 与 Host JSONL 持久化是一个可回滚提交边界；任一步失败都必须恢复 canonical/domain/alignment、保留 staging，并作为不可盲目重跑模型的 assignment failure 暴露。
- translation worker 每次成功写入 staging 后、进入下一次 provider 调用或 reviewer 交接前，必须先持久化 hash-current staging 路径及 pending review/精确修复债务；Stop 或提交失败不得删除该 staging，也不得让 supervisor 从 canonical 盲重跑同一 assignment。
- 文件 assignment 失败时，持久 worker 必须先在自己的 Pi session 中重试当前文件，成功或耗尽有界尝试后才领取共享队列的下一个文件；禁止把失败文件推到队尾并交给另一 worker 制造长尾。Provider 传输错误必须通过 Pi 原生 retry/`continue()` 在同一条 user assignment 后恢复；原始 fetch 异常的定长脱敏 cause 链必须在 provider 将其压成 `fetch failed` 前写入无模型上下文投影的 durable Pi custom entry。Codex 的 WS 异常可先使用 Pi SSE fallback，但 SSE fetch 失败后必须清除该 session 的 sticky fallback 再做最后一次 WS 尝试，并同样持久化 session/provider/model/error/WebSocket 计数，控制台日志不能作为唯一证据。有界重试耗尽时停止该 worker 且不得领取下一 assignment，parent completion 也不得自动启动新一批。只有用户显式继续后才可恢复 Host 保留的未完成债务。
- 分阶段持久 worker 必须先原子领取实际 assignment，再用该 assignment 的 request/provider/model/label 创建 child runtime；禁止用一个“种子任务”建 runtime 后再从共享队列领取另一个任务。worker 的 `documentId`、`documentIds` 与卡片 label 必须在每次 assignment 开始时同步更新。
- renderer 不得在 message render map 内重复扫描完整 transcript。并行 child 与长会话改动的 Electron 验收必须同时记录 UI 响应延迟、renderer/总 working set、parent JSONL 大小和最大 child 卡片大小。
- 失败路径要回到模型或 UI 中形成可恢复状态，不能静默吞掉，也不能假完成。
- 不要用固定小 turn cap 阻断主任务或子任务；限制只能是显式策略。
- 持久化 active-session 指针只允许显式 create/select/delete-fallback 修改；prompt、compaction、provider、child completion 和后台 state broadcast 都不拥有会话选择权。
- “最近项目”必须跟随用户实际激活的项目：成功 load/save 项目、打开项目所属 line-review/proposal HTML、或切换 HTML 项目标签时更新。文件夹选择器只读取该统一指针，不能只在选择器确认时写入，否则通过生成 HTML 或直接打开页面进入的新项目会回退到旧项目。
- Provider、显式模型目录、API key、OAuth profile、当前 provider/model 与默认 thinking level 是用户级全局配置，存放在 Electron `userData/agent` 并跨项目实时同步；Pi JSONL 会话/compaction、翻译记忆、术语表、角色圣经和产物仍按项目隔离。旧项目 provider/OAuth 文件只允许在全局配置首次建立时作为一次性迁移输入。
- LAN 远程 Agent 的 SSE 只负责低延迟增量显示，不能作为回复交付的唯一真相。每次远程 Prompt、Steer 或 Follow-up 被 Host 接受后，浏览器必须独立追踪同一 Pi session 的 durable run state 直到终态，并从 canonical Pi messages 强制收敛；即使事件流中断、被代理缓冲或漏掉终态，也不能一直停在“思考中”或缺失回复。SSE 必须关闭代理缓冲并有 heartbeat，断线恢复仍从 Pi JSONL 重建，不得另建远程 transcript 或调用模型补状态。

## 翻译/校对工作流

- 翻译/校对是固定 YN domain contract：系统提示、host tools、artifact validator 和 completion gate 由产品内置；当前没有 skill 选择器、外部 Agent 模式或 `readSkillReference` runtime。
- 产品可见 Workflow 只允许 `initial_translation` 与 `proofread`，并且必须分别对应完整 translate/proofread Host contract。术语一致性、角色口吻与最终 QA 是这两条 Workflow 内部的检查维度；不得把只有预填 Prompt、没有 typed DomainRun、调度器、产物 validator 与 completion gate 的 preset 再包装成独立 Workflow。
- 翻译/校对输出以机器可校验的 artifact 为契约：译文候选要行对齐，proofread findings 以 JSON 为主。
- 文件夹 line-review batch index 是每个源文件 HTML/sidecar 身份的唯一清单。proposal HTML 生成或旧页面打开时，只要其 `lineReviewPath` 指向 batch child，就必须归一到拥有它的 batch index；不能让首个 child 把文件夹工作流降级成单文件路径。汇总建议的一键应用必须先把索引内全部 canonical child 原子同步到当前译文并回写 matched 绑定，包括没有 finding 的文件，再把建议提交到这些 child 的 sidecar；禁止为 batch 已拥有的文件另建 `proposal-line-review` 平行产物。旧平行 child 只能在无冲突迁移其状态后删除。批量写 TXT 必须拒绝 index、child 与 sidecar 的分叉绑定、缺失基线或行数漂移，不能按优先级猜路径后假成功。
- 审阅 HTML 中可执行的语义修正建议默认状态必须是 `accepted`；只有用户明确拒绝、检测到冲突，或只读机械证据才不得默认应用。folder 与单文件 JSON/Markdown 解析、legacy HTML 升级和“一键应用建议”必须使用同一默认状态契约；不得把页面看起来已接受的建议在内嵌数据中写成 `unreviewed`。
- 项目分片大小只有一个 canonical 设置 `splitSize`，它必须在每次 parent turn、冷启动恢复和 Host 工具创建时同时映射为翻译与校对的 typed split metadata。`reviewMode`、`translationSplitSize`、`proofreadSplitSize` 只允许作为旧项目的一次性迁移输入：canonical 值优先，唯一旧值无损迁移，旧值互相冲突时显式失败，迁移后不得继续持久化。Host 的 source-document 切换必须是事务性的：阶段/所有权校验失败时，Pi request 与 domain run 都必须保持在原文档。文件夹 child 完成记录还必须持久化并恢复校验 `documentId` 与完成时的 `sourceLineCount`；无法证明归属的旧记录必须失效并通过 completion repair 明确暴露，不能把另一文件的分片记到账上。
- 当前可见 review HTML 的 typed route 拥有 Agent 实际读取的工作文本绑定；项目状态中的 `sourcePath` 只在页面未提供绑定时回退。EPUB 项目必须让 Pi/Host 使用提取后的 UTF-8 TXT，原始 `.epub` 只属于来源与导出/重打包元数据，绝不能在 prompt 入口覆盖页面的 `sourcePath`/`sourceSelection`。
- 完整校对必须先由 Host 对全部对齐行完成独立、可观察且按 source/candidate/glossary/character-bible/style hash 绑定的 H3/H4/H7/H8/H9 确定性扫描，再允许 parent 启动语义校对 child；任何输入变化都会使扫描与旧完成证据一起失效。确定性信号只是 child 结合原文、译文和邻近上下文确认或驳回的证据，不能直接当作最终 finding。Split child 必须语义检查自己范围内的每一行，`splitSize` 只是保存间隔；Monte Carlo child 必须使用 Host 规划的不重复 HOT/WARM/COLD 分层样本，区域达到 80% 覆盖后退出抽样池，只有最低轮数后连续两轮无新增才算收敛。达到轮数上限仍有新增时必须等用户选择继续三轮、只精审 HOT 区域或按当前结果停止，不能把上限伪装成收敛。
- Parent 负责读取扫描摘要、在配置的 `1..N` 上限内按工作量选择实际 worker 数、阶段推进、findings 合并去重、Monte Carlo 收敛、共享资产决策和最终报告。Proofread child 只负责 Host 分配行的 H1/H2/H5/H6/M1-M5/L1-L4 语义判断、确定性证据复核和带行号证据的缺失专名候选；它必须完整读取内置校对规范及必要项目参考，但不得修改原文、译文、术语表、角色圣经或文风资产。
- 文件夹完整校对必须在任何语义 child 启动前完成清单内所有文档的 hash-bound Host 预扫描，再按用户文件顺序把全部文档放进一个跨文件 staged assignment 队列。每个 assignment 必须绑定自己的原文文件和候选译文文件；项目级目录路径不能下沉成 child 的文件路径。逐文档结算覆盖、候选和失败状态后，以所有清单文档都完成为最终完成条件。单文件与文件夹校对都只能持久化一份 findings JSON；人类可视化由产品把 JSON 转成 HTML，禁止再生成 Markdown summary、在 JSON 写 `summaryPath`，或把已经是 `report` 的输出目录再次拼接 `report/`。持久 proofread worker 在 assignment 之间必须 `resetContext()`，项目术语表、角色圣经和候选术语只注入当前原文直接命中的完整结构化记录；缺失歧义只允许单词精确搜索，禁止每个 assignment 全文重读索引资产。reference manifest 的 `complete=true` 表示内容已经随 assignment 完整注入，child 不得再次调用读取工具；只有存在 `complete=false` 的条目时才向该 assignment 暴露 `readProofreadReference`，并严格从 0 与返回的 `nextOffset` 分页。
- `reuseExistingTranslation` 是项目级 typed 设置和前端可见开关，默认 `false`。关闭时，完整翻译在首个有效 parent 写入或 worker 批次启动前，由 Host 对旧候选做 SHA-256 备份并清空一次，然后干净重翻；不得把旧行带进 worker，也不得静默覆盖而不留备份。开启时才进入可恢复复用审计：先备份并按 source/candidate hash 绑定审计。Host 对全量行复用现有 validator/proofread prescan 做机械快筛；行数、占位符、标签、空行或明确占位文本错误直接列入重译；非目标语言、原文复制/高重合、异常长度、不同原文复用同一译文、AI 污染以及术语/角色/文风规则命中只作为高风险证据。没有风险的对齐目标语言行自动判为 `reuse`；高风险行由原生 Pi child 结合原文、译文和邻近上下文作最终二元语义判定 `reuse|retranslate`，风险信号本身不得强制重译，也不得生成任何人工复核交付物。用户只对整份候选作一次选择：保留 AI 判定可复用的行，或舍弃全部旧译文；应用时只清空 AI 判定为 `retranslate` 的行并让既有 Host 队列重译。当前 run 自己刚写出的 artifact 不得被误判为启动前旧译文而重新触发审计。文件夹顺序表达式是本轮 authoritative manifest：完整工作流必须原子替换旧 Host document 集合、待决复用 audit 和校验状态；被顺序移除的文件不得被扫描、恢复、派发或继续占用完成门槛。
- 复用快筛的语言/脚本判断必须先用 validator 同一套 placeholder、tag 与 custom-preserve 规则剥离受保护载荷；纯事件码、控制码、标点和数字行不得制造语义 child 债务。同一文档的稀疏风险行应按有界 selected-line assignment 合并，不能按每个连续小岛创建模型任务。child 的结构化 verdict 工具成功后必须终止该工具 turn，由 Host 直接统计，禁止再调用模型只为复述计数。
- 文件夹复用准备只允许一次 Host store 读取/提交，用户的一次决定必须事务性应用当前 owner 下全部 hash-current 待决文档；工具与 parent completion 只返回聚合计数，不得把每份 audit、完整行数组或持久 worker 的文档历史重新注入 parent 模型上下文。冷恢复从 owner/source/candidate hash 的 durable audit store 重建待决集合，不能因内存/Host 快照漏标而出现“children 已完成但待决状态未完成”。
- 关闭 `reuseExistingTranslation` 只决定 Host 是否把旧候选行直接保留为本轮 artifact，不禁止 translation child 按需只读历史备份来理解译名或减少生成成本。不要把复用授权和只读参考混成同一个权限边界。相反，正式 glossary、character bible 与 glossary candidates 是 Host 可索引的结构化资产：`readAssignedSource` 必须只注入当前 assignment 原文直接命中的有界条目，child 对缺失歧义只做单个原词的精确搜索，禁止每个 assignment 全文重读这些索引资产后再逐词搜索。
- 应用复用决策后，Host 队列只能包含被判定为 `retranslate` 且尚未获得 hash-current Host 接受证据的实际债务行；非空候选不能自行结清债务，也不得为了满足连续全文件覆盖而把保留行重新塞给 worker。冷启动按同一审计 owner、document、source hash 和 masked retained-baseline hash 恢复：`reuse` 行必须保持与应用决策时一致，`retranslate` 行则只由当前有效 scope 决定完成或续派。child 的写权限始终只覆盖自己的稀疏 assignment；需要理解对话、代词、术语或场景时，child 使用 Host 提供的有界、带绝对行号、只读上下文工具自行读取邻近原文和当前译文，不得由 parent 把整份文件注入提示词，也不得因读取上下文扩大写入所有权。
- 文件夹批次索引是每个源文件 review HTML/sidecar 的唯一身份。若旧版本曾为同一 translation TXT 生成多个 `proposal-line-review` HTML，Host 必须先按 translation path 聚合其行状态、以各重复 proposal artifact 的修改顺序合并到 canonical child（后写入覆盖先写入），再原子提交 canonical state 并删除全部重复 HTML/sidecar；不得把可自动归并的状态差异当作人工冲突门阀。
- 复用审计记录必须持久化所属 parent Pi `sessionId`；prepare/read/plan/record/apply、child 审计 runtime 与 cold-restart 恢复都必须校验同一 owner，绝不能把项目中另一会话的待决审计变成 ambient authorization。生成提示词前必须等待项目设置通过 Electron bridge 原子落盘；有项目路径时 bridge 缺失或写入失败必须在 HTML 中显式报错并停止生成，不能把未保存设置当成功。
- 用户确认复用的普通 follow-up 会先停放完整 workflow；`applyTranslationReuseDecision` 必须先恢复该 Host workflow，再解析或缓存 source manifest。禁止在 local/suspended DomainRun 上预载完整目录后把缓存带回恢复的完整 workflow。当前 run 已经取得 artifact 所有权后，`prepareTranslationReuseAudit` 必须拒绝再次把本轮产物当成启动前旧译文准备审计。
- 项目角色圣经只有一个产品路径：`AI_translation/_workspace/character_bible.md`。项目资产编辑器、File 菜单、parent/child Pi context 和 validator 必须读取同一个 Markdown；`.translation-workshop/character_bible.md` 与 `.json` 只能作为一次性迁移输入，不能再成为可打开或可写的第二份资产。
- 任何导入、合并、记忆写入都必须经过项目约束校验，避免错行、错文件、错目录。
- 模型提前声称完成时，host completion gate 必须通过原生 Pi follow-up 要求补齐；不能引入 `waiting_for_human`、`domainApproval` 或 job 状态机。
- `resumeYnWorkflow` 是幂等的 Host 恢复动作，不是新的授权门槛：暂停中的完整 workflow 要恢复原有 typed state；已经 active 或当前没有暂停 workflow 时必须成功 no-op，不能要求模型提供理由、不能报“没有可恢复 contract”，也不能凭 no-op 创建或重置 workflow。
- 完整 YN workflow 与 child 委派授权是两个独立契约：精确 `Workflow:` marker 启动完整资产/完成门槛，并在 renderer typed metadata 丢失时恢复对应 `workflowIntent`；marker 与 typed intent 冲突必须失败。没有 marker 的 typed intent 只可续接同一 Pi session 中未完成的同类 Host workflow，绝不能新建完整工作流。项目设置 `subagentEnabled=true` 本身即授权 parent 按工作量自主使用 `1..N` 个原生 Pi child 处理明确的有界任务，不得再要求当前用户消息重复出现“子 Agent”等魔法措辞。当前用户消息或运行中的 Steer/Follow-up 明确给出数量时，该数量才是 exact；项目关闭 child 时，当前用户的显式委派仍可临时授权。任何局部委派都不得被伪装成完整 workflow 或重启整批队列。
- 本地翻译修复与中断恢复的 alignment debt 只能由 Host 的机械风险行加有界确定性抽样构成；范围长度绝不能直接变成逐行语义债务。旧的 exhaustive `alignment-range-*` 持久状态必须在 Host 侧迁移为同一 canonical risk/sample contract，保留 hash-current 的失败结论，并落盘后再进入 Pi tool result。
- bounded/local repair 的 parent 与 child line-identity 校验都只能提交仍失败的绝对行号、机器码与短修改说明；空失败列表表示 Host 选中的风险/抽样行已经比较且未发现剩余错行。Host 静默接受其余选中行，禁止为通过行生成 `aligned` verdict 或 prose reason，也禁止要求重新读取旧的已接受证据。候选在校验后变化时必须要求重新提交轻量结果。
- 独立单文件工作流中，单行文件由 parent Agent 直接写入/校验；文件夹批处理启用 child 时，单行文件也进入同一 host-owned 顺序队列，避免绕过文件阶段。其余翻译和校对分片由提示词设置显式选择是否启用以及 child 数量；启用时最多按所选数量并行使用原生 Pi child runtime，禁用时由 parent Agent 直接完成。host 必须验证正确 workflow 类型及从首行到末行连续全覆盖，不能只靠提示词约定。产品不暴露旧的 parallel/concurrency 控件，也不设置全进程 child 并发上限。

## 验收

- UI 改动必须有实际 Electron/Browser 渲染验收；源码测试不能替代视觉和 DOM 检查。
- 所有自动 Electron/Windows 打包验收必须在 offscreen/headless 或移出可见桌面的模式渲染并截图，绝不能在用户桌面显示窗口。electron-builder 的 NSIS portable 外壳在本机退出时会触发 `0x80000003`，因此自动验收永远不得执行 portable EXE；应启动 `release/win-unpacked/translation-workshop.exe`，由产品内置隐藏 smoke lifecycle 写 readiness marker 后自行正常退出。验收脚本不得调用 `CloseMainWindow`、`kill` 或其他外部进程终止来收尾；portable 只做封装、版本、内容和 checksum 校验。
- 只要本轮修改会改变用户拿到的 Windows 产品行为，完成源码与 Electron 验收后必须主动重建 2.0.0 installer/portable、校验 release checksums 并实际启动便携版；除非用户明确说本轮不要打包，不得等用户再次提醒“打包”。纯文档或测试改动除外。
- 模型选择器必须直接读取固定版本 Pi 的 provider/model 目录；升级模型支持时更新 Pi 固定版本和目录测试，禁止在 renderer 硬编码新模型名。
- Windows portable 由 `PORTABLE_EXECUTABLE_FILE` 显式判定；portable 不得初始化或调用 `electron-updater`，手动检查更新只打开 releases 页面。安装版继续使用 updater。便携版启动验收必须跨过 startup update delay，并记录 launcher 退出码与进程时间线。验收脚本不得用 `Stop-Process -Force`、`launcher.kill()` 或等价手段清理 Electron；正常关窗超时必须显式失败并保留进程供诊断，不能用强杀制造或掩盖另一个 `0x80000003`。
- 自动验收要覆盖用户截图里的坏状态，而不是只证明“页面能打开”。
- legacy upgrade、Agent IPC/runtime、全量 `npm test` 是不同层面的检查；不要互相替代。
- 架构重构只有在同一独立审阅 agent 对最终 worktree 给出 PASS，且最终测试、Electron、打包和源码边界审计全部重跑后才可标记完成。
