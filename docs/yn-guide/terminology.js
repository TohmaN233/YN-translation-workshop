window.YN_GUIDE_TERMINOLOGY = {
  categories: {
    roles: { zh: "角色与运行环境", en: "Roles and execution environment" },
    contracts: { zh: "调用与工作契约", en: "Calls and workflow contracts" },
    artifacts: { zh: "产物、校验与状态", en: "Artifacts, validation, and state" },
    persistence: { zh: "会话、持久化与控制", en: "Sessions, persistence, and control" }
  },
  entries: [
    {
      term: "Agent",
      category: "roles",
      zh: { plain: "能够接收消息、调用模型、选择工具并继续推进任务的执行主体。", yn: "YN 中的 Parent 和 Child 都是 Agent，并且都运行在 Pi runtime 上。", not: "不等于模型本身；模型只是 Agent 每一步推理时调用的能力。" },
      en: { plain: "An execution unit that receives messages, invokes a model, selects tools, and keeps a task moving.", yn: "Both Parent and Child are Agents running on the Pi runtime.", not: "It is not the model itself; the model is one capability used during an Agent turn." }
    },
    {
      term: "Host",
      category: "roles",
      zh: { plain: "模型外面的可信程序层，真正执行工具、读写文件、保存状态并拒绝越权操作。", yn: "YN Host 是通用 Agent Host 里的翻译业务层，负责清单、队列、范围、校验、证据和提交。", not: "不是远程服务器，不是主 Agent，也不是另一个模型。" },
      en: { plain: "The trusted program layer outside the model that executes tools, reads and writes files, persists state, and rejects invalid operations.", yn: "The YN Host is the translation-domain part of the broader Agent host. It owns manifests, queues, scopes, validation, evidence, and commits.", not: "It is not a remote server, the Parent Agent, or another model." }
    },
    {
      term: "Harness",
      category: "roles",
      zh: { plain: "把模型、消息循环、工具、状态、错误处理和完成判断连接成可运行系统的整套外壳。", yn: "本项目的 Harness 由 Pi Agent loop、YN Host、工具、Supervisor、持久化与 UI 协议共同组成。", not: "不是一条提示词，也不是某个单独的 workflow。" },
      en: { plain: "The surrounding system that connects models, message loops, tools, state, error handling, and completion checks into a working agent.", yn: "Here it includes the Pi Agent loop, YN Host, tools, Supervisor, persistence, and UI protocol.", not: "It is not a single prompt or one workflow." }
    },
    {
      term: "Runtime",
      category: "roles",
      zh: { plain: "Agent 实际运行时使用的代码环境与生命周期实现。", yn: "Pi runtime 负责消息、模型调用、tool call、continue、队列消息、重试和 compaction。", not: "不是所选模型；同一个 runtime 可以切换不同 provider 和 model。" },
      en: { plain: "The code environment and lifecycle implementation in which an Agent actually runs.", yn: "The Pi runtime handles messages, model calls, tool calls, continue, queued messages, retries, and compaction.", not: "It is not the selected model; one runtime can use different providers and models." }
    },
    {
      term: "Pi",
      category: "roles",
      zh: { plain: "本项目采用的 Agent runtime 基础实现。", yn: "Parent 与 Child 共用 Pi 的 Agent、AgentMessage、Session 和 JSONL 语义。", not: "不是 YN 自己另造的一套聊天协议。" },
      en: { plain: "The base Agent runtime used by this project.", yn: "Parent and Child share Pi Agent, AgentMessage, Session, and JSONL semantics.", not: "It is not a separate chat protocol invented by YN." }
    },
    {
      term: "Parent Agent",
      category: "roles",
      zh: { plain: "直接与用户对话、规划工作并汇总结果的主 Agent。", yn: "它选择阶段、调用 Host 工具、处理冲突和剩余债务，最后向用户报告。", not: "不会代替 Host 绕过范围和校验直接写入。" },
      en: { plain: "The primary Agent that talks to the user, plans the work, and consolidates results.", yn: "It advances stages, calls Host tools, resolves conflicts and remaining debt, and reports the outcome.", not: "It cannot bypass Host scope and validation rules." }
    },
    {
      term: "Child Agent / Subagent",
      category: "roles",
      zh: { plain: "由 Parent 或 Host 为一项有边界任务启动的 Agent。", yn: "Child 拥有独立 Pi session，只看到当前 assignment 所需的工具和上下文。", not: "不是一个只有函数体的后台线程，也不能再启动下一层 subagent。" },
      en: { plain: "An Agent started by the Parent or Host for a bounded task.", yn: "A Child has its own Pi session and sees only the tools and context required by its current assignment.", not: "It is not merely a background thread and cannot spawn another subagent layer." }
    },
    {
      term: "Worker",
      category: "roles",
      zh: { plain: "反复从共享队列领取 assignment 的持久 Child 角色。", yn: "翻译 Worker 负责写 staging；审阅 Worker 只读并提交失败 verdict；校对 Worker 写 findings。", not: "Worker 数是并发上限，不等于任务块数量。" },
      en: { plain: "A persistent Child role that repeatedly claims assignments from a shared queue.", yn: "Translation Workers write staging, review Workers submit only failed verdicts, and proofread Workers write findings.", not: "Worker count is a concurrency limit, not the number of task chunks." }
    },
    {
      term: "Supervisor",
      category: "roles",
      zh: { plain: "管理 Child 生命周期、领取任务、重试、结算和补位的 Host 组件。", yn: "它连接 Host 队列与多个 Pi Child runtime，并保证失败 Worker 不偷偷领取下一项。", not: "不负责生成译文内容。" },
      en: { plain: "The Host component that manages Child lifecycles, task claims, retries, settlement, and replacement workers.", yn: "It connects the Host queue to Pi Child runtimes and prevents a failed Worker from silently claiming more work.", not: "It does not generate translation content." }
    },
    {
      term: "Provider / Model",
      category: "roles",
      zh: { plain: "Provider 是模型服务来源，Model 是该服务中实际调用的模型。", yn: "它们是用户级配置；Child 默认继承 Parent 当前选择。", not: "更换模型不会更换 Host、Workflow contract 或项目资产。" },
      en: { plain: "A Provider supplies model access; a Model is the specific model invoked through that service.", yn: "They are user-level settings, and Children inherit the Parent selection by default.", not: "Changing the model does not replace the Host, workflow contract, or project assets." }
    },
    {
      term: "Prompt / System Prompt",
      category: "contracts",
      zh: { plain: "Prompt 是交给 Agent 的本轮指令；System Prompt 是运行时注入的高优先级行为和工具说明。", yn: "页面生成的 Prompt 选择翻译或校对入口，内置 System Prompt 解释当前 typed workflow 与可用工具。", not: "Prompt 文字本身不能授予 Host 没有给出的写权限。" },
      en: { plain: "A Prompt is the instruction for a turn; a System Prompt is higher-priority runtime guidance about behavior and tools.", yn: "The page prompt selects translation or proofreading, while the built-in System Prompt explains the active typed workflow and tools.", not: "Prompt wording cannot grant write authority that the Host did not provide." }
    },
    {
      term: "Tool / Function",
      category: "contracts",
      zh: { plain: "Host 暴露给 Agent 的结构化调用接口。本文档里的 Function 指这些 tool surface。", yn: "每项都有 schema、读取边界、状态变化、返回值和拒绝条件。", not: "不是让模型随意执行的内部 JavaScript 函数。" },
      en: { plain: "A structured call interface exposed by the Host to an Agent. This manual uses Function for these tool surfaces.", yn: "Each surface has a schema, read boundary, state transition, result, and rejection conditions.", not: "It is not an arbitrary internal JavaScript function available to the model." }
    },
    {
      term: "Tool Call",
      category: "contracts",
      zh: { plain: "Agent 请求 Host 执行某个 Tool 的结构化消息。", yn: "Host 校验参数和当前状态，执行后把 toolResult 放回同一 Pi turn。", not: "调用成功不等于完整 workflow 已完成。" },
      en: { plain: "A structured message in which an Agent asks the Host to execute a Tool.", yn: "The Host validates arguments and current state, executes the operation, and returns a toolResult to the same Pi turn.", not: "A successful call does not mean the whole workflow is complete." }
    },
    {
      term: "Workflow",
      category: "contracts",
      zh: { plain: "从入口、阶段推进到完成条件的一整套工作契约。", yn: "产品只暴露 initial_translation 与 proofread 两条完整 Workflow；术语、角色、复用和 QA 是内部阶段。", not: "不是一个方便预填 Prompt 的按钮名称。" },
      en: { plain: "A complete work contract from entry point through staged execution to completion conditions.", yn: "The product exposes only initial_translation and proofread as full workflows; terminology, character handling, reuse, and QA are internal stages.", not: "It is not merely a button that prefills a prompt." }
    },
    {
      term: "Typed Contract",
      category: "contracts",
      zh: { plain: "由程序结构明确记录、可以校验的约束，而不是只写在自然语言里。", yn: "文件身份、范围、worker 上限、workflow intent 和完成债务都会进入 typed state。", not: "模型声称“我会只改这些行”不等于拥有 typed 权限。" },
      en: { plain: "A machine-structured, enforceable constraint rather than a promise written only in natural language.", yn: "Document identity, scope, worker limit, workflow intent, and completion debt are stored as typed state.", not: "A model saying it will edit only certain lines is not typed authorization." }
    },
    {
      term: "DomainRun",
      category: "contracts",
      zh: { plain: "一次 YN 翻译或校对 workflow 的领域状态实例。", yn: "它记录 workflow 类型、owner、inspection、batch、发现、债务和 completion 进度。", not: "不是模型进程，也不是 UI 里的任务卡片。" },
      en: { plain: "The domain-state instance for one YN translation or proofreading workflow.", yn: "It records workflow kind, owner, inspection, batches, discoveries, debt, and completion progress.", not: "It is not a model process or a UI task card." }
    },
    {
      term: "Scope / Ownership",
      category: "contracts",
      zh: { plain: "Scope 是允许操作的对象与范围；Ownership 表示当前谁合法持有该范围。", yn: "文档、连续行块或精确行都由 Host 授权，读取上下文不会扩大写入 ownership。", not: "能读到一个文件不表示能修改它。" },
      en: { plain: "Scope defines what may be operated on; Ownership identifies who currently holds legal authority over that scope.", yn: "Documents, contiguous ranges, and exact lines are Host-authorized, and reading context never expands write ownership.", not: "Being able to read a file does not imply permission to modify it." }
    },
    {
      term: "Assignment",
      category: "contracts",
      zh: { plain: "Host 交给一个 Worker 的单个有边界工作单元。", yn: "它绑定 document、行范围或精确行、输入 hash、角色和尝试状态。", not: "不是整个文件，也不一定与 splitSize 一一相等。" },
      en: { plain: "One bounded unit of work assigned by the Host to a Worker.", yn: "It binds a document, range or exact lines, input hash, worker role, and attempt state.", not: "It is not necessarily a whole file or always equal to splitSize." }
    },
    {
      term: "Batch",
      category: "contracts",
      zh: { plain: "一组被同一次 Host 调度和结算管理的 assignment。", yn: "Host 在创建 Child 前原子预留 batch，并分别记录 taskCount 与实际 workerCount。", not: "不等于一个 Child，也不等于一个文件。" },
      en: { plain: "A set of assignments managed and settled by one Host scheduling operation.", yn: "The Host atomically reserves the batch before creating Children and records taskCount separately from workerCount.", not: "It is not one Child or one file." }
    },
    {
      term: "Manifest",
      category: "contracts",
      zh: { plain: "本轮工作认可的文档清单及其身份信息。", yn: "文件顺序、原文、候选路径、行数和阶段屏障都来自 authoritative manifest。", not: "不是每次让模型重新扫描目录得到的临时列表。" },
      en: { plain: "The authoritative document list and identities for the current run.", yn: "File order, source and candidate paths, line counts, and stage barriers come from this manifest.", not: "It is not a temporary directory listing reconstructed by the model every turn." }
    },
    {
      term: "Artifact",
      category: "artifacts",
      zh: { plain: "工作流产生并可被机器验证的持久文件或记录。", yn: "典型 artifact 包括行对齐候选译文、findings JSON、HTML sidecar 和项目资产。", not: "Agent 在聊天里说“完成了”不是 artifact。" },
      en: { plain: "A durable file or record produced by a workflow and subject to machine validation.", yn: "Typical artifacts include aligned translation candidates, findings JSON, HTML sidecars, and project assets.", not: "An Agent saying 'done' in chat is not an artifact." }
    },
    {
      term: "Candidate",
      category: "artifacts",
      zh: { plain: "尚处在检查、选择或确认阶段的内容。具体含义取决于对象。", yn: "translation candidate 是正式写回前的候选译文；glossary candidate 是尚未进入正式术语表的译名。", not: "两个 candidate 的审批和存储规则并不相同。" },
      en: { plain: "Content still awaiting inspection, selection, or confirmation; its exact meaning depends on the object.", yn: "A translation candidate is output awaiting final write-back, while a glossary candidate is a term not yet in the approved glossary.", not: "The two candidate types do not share the same approval or storage rules." }
    },
    {
      term: "Canonical",
      category: "artifacts",
      zh: { plain: "当前被系统视为权威、唯一结算依据的版本或位置。", yn: "可以指正式术语表、正式候选译文路径、canonical Pi messages 或唯一 findings JSON。", not: "不表示内容永远不能再修改，只表示当前真相来源明确。" },
      en: { plain: "The version or location currently treated as authoritative for settlement.", yn: "It may describe the approved glossary, canonical translation path, canonical Pi messages, or the single findings JSON.", not: "It does not mean immutable forever; it means the current source of truth is unambiguous." }
    },
    {
      term: "Staging",
      category: "artifacts",
      zh: { plain: "尚未提升为正式结果的可恢复待检副本。", yn: "翻译 Worker 先把负责行写入 staging；机械校验和独立审阅通过后，Host 才提升到 canonical 译文。", not: "不是 Git staging、内存缓存或已经正式提交的译文。" },
      en: { plain: "A recoverable, inspectable copy that has not yet been promoted to the official result.", yn: "Translation Workers write their lines to staging first; the Host promotes them only after mechanical validation and independent review.", not: "It is not Git staging, an in-memory cache, or already committed translation output." }
    },
    {
      term: "Promote",
      category: "artifacts",
      zh: { plain: "把已经通过检查的 staging 范围写入 canonical artifact。", yn: "提升按精确范围并在候选文件锁内执行，不把同一 staging 的其他未审行一起带入。", not: "不等于简单重命名整个临时文件。" },
      en: { plain: "To write an accepted staging range into the canonical artifact.", yn: "Promotion is range-scoped and candidate-locked, so unrelated unreviewed staging lines are not included.", not: "It is not simply renaming an entire temporary file." }
    },
    {
      term: "Validator / Validation",
      category: "artifacts",
      zh: { plain: "用确定规则判断输入或产物是否满足契约的代码与过程。", yn: "它检查行数、占位符、标签、保留规则、范围、schema、术语和完成债务。", not: "不等于模型阅读后觉得“看起来不错”。" },
      en: { plain: "Code and process that use deterministic rules to decide whether input or output satisfies a contract.", yn: "It checks line counts, placeholders, tags, preserve rules, scope, schema, terminology, and completion debt.", not: "It is not a model saying the result looks good." }
    },
    {
      term: "Mechanical Validation",
      category: "artifacts",
      zh: { plain: "不需要模型理解语义即可重复执行的确定性检查。", yn: "例如行对齐、保护载荷、空行、明显占位文本、格式和部分术语一致性。", not: "不能代替误译、语气和上下文含义的语义审阅。" },
      en: { plain: "Deterministic checks that can be repeated without asking a model to understand meaning.", yn: "Examples include alignment, protected payloads, blank lines, obvious placeholder text, formatting, and some terminology consistency.", not: "It cannot replace semantic review of meaning, tone, and context." }
    },
    {
      term: "Semantic Review / Reviewer",
      category: "artifacts",
      zh: { plain: "结合原文、译文和上下文判断意义是否正确的审阅；Reviewer 是执行该审阅的只读 Worker。", yn: "翻译 Reviewer 只上报失败行，校对 Worker 则写入结构化 findings。", not: "Reviewer 不直接修改翻译 staging。" },
      en: { plain: "Review that uses source, translation, and context to judge meaning; a Reviewer is the read-only Worker performing it.", yn: "Translation Reviewers report only failed lines, while proofread Workers write structured findings.", not: "A Reviewer does not directly edit translation staging." }
    },
    {
      term: "Finding / Verdict",
      category: "artifacts",
      zh: { plain: "Finding 是校对中可交付的问题记录；Verdict 是对某项检查的结构化结论。", yn: "findings 进入唯一 JSON 和审阅 HTML；review verdict 通常只记录失败或 reuse/retranslate。", not: "不是聊天中的自由散文评论。" },
      en: { plain: "A Finding is a deliverable proofreading issue; a Verdict is a structured decision for a check.", yn: "Findings enter the single JSON and review HTML, while review verdicts usually record only failures or reuse/retranslate.", not: "They are not free-form chat commentary." }
    },
    {
      term: "Evidence",
      category: "artifacts",
      zh: { plain: "支持一个结论、并能在恢复后重新核对的结构化依据。", yn: "证据会绑定文档、行、代码、参考资产及 source/candidate hash。", not: "只写一句理由但无法定位原译文，不算充分证据。" },
      en: { plain: "Structured support for a conclusion that can be checked again after recovery.", yn: "Evidence is bound to document, line, code, reference asset, and source/candidate hashes.", not: "A vague reason that cannot be traced to source and translation is insufficient." }
    },
    {
      term: "Debt",
      category: "artifacts",
      zh: { plain: "工作流在允许完成前仍必须处理的明确事项。", yn: "可能是未翻译行、术语修复、warning 真阳性、未覆盖 scope 或待决资产。", not: "不是技术债务的泛称，而是 completion gate 可计算的未结项。" },
      en: { plain: "A concrete item that must be settled before the workflow may complete.", yn: "It may be untranslated lines, terminology repair, true-positive warnings, uncovered scopes, or pending assets.", not: "Here it is not a vague synonym for technical debt; it is computable unfinished work." }
    },
    {
      term: "Hash / Hash-bound / Hash-current",
      category: "artifacts",
      zh: { plain: "Hash 是内容指纹；hash-bound 表示结论绑定某份具体输入；hash-current 表示指纹仍与当前文件一致。", yn: "输入变化时只让相关证据和授权失效，避免把旧结论套到新文本。", not: "Hash 证明内容相同，不证明翻译质量正确。" },
      en: { plain: "A hash is a content fingerprint; hash-bound means a conclusion is tied to specific input, and hash-current means it still matches the current files.", yn: "When input changes, only the relevant evidence and authority are invalidated instead of applying stale conclusions to new text.", not: "A matching hash proves identity, not translation quality." }
    },
    {
      term: "Completion Gate",
      category: "artifacts",
      zh: { plain: "决定 workflow 是否真的满足完成条件的程序门槛。", yn: "它核对 assignment 结算、coverage、验证、术语和资产债务，而不是相信模型的完成声明。", not: "Agent 发出最终回复不代表 completion gate 已通过。" },
      en: { plain: "The programmatic gate that decides whether a workflow has actually satisfied its completion contract.", yn: "It checks assignment settlement, coverage, validation, terminology, and asset debt instead of trusting a model's completion claim.", not: "An Agent final response does not mean the gate has passed." }
    },
    {
      term: "Session / JSONL",
      category: "persistence",
      zh: { plain: "Session 是一条可继续的 Agent 会话；JSONL 是按行追加保存会话事件的文件格式。", yn: "Parent 与每个 Child 都有自己的 Pi JSONL，用于恢复、审计和按需展开。", not: "Parent 卡片里不会复制完整 Child transcript。" },
      en: { plain: "A Session is a continuable Agent conversation; JSONL stores its events as append-only JSON lines.", yn: "The Parent and every Child have separate Pi JSONL files for recovery, audit, and on-demand expansion.", not: "The Parent card does not embed the full Child transcript." }
    },
    {
      term: "Persistence / Durable State",
      category: "persistence",
      zh: { plain: "把关键状态写到磁盘，使进程关闭后仍能恢复。Durable 表示不是只存在内存里。", yn: "Pi messages、Host state、staging、审阅证据和复用审计都有持久边界。", not: "控制台日志不是唯一持久证据。" },
      en: { plain: "Writing critical state to disk so it survives process shutdown; durable means it is not memory-only.", yn: "Pi messages, Host state, staging, review evidence, and reuse audits all have persistence boundaries.", not: "Console logs are not the sole durable evidence." }
    },
    {
      term: "Atomic / Transaction / Rollback",
      category: "persistence",
      zh: { plain: "Atomic 表示相关变更要么全部成功，要么不留下半套结果；Transaction 是这组提交边界；Rollback 是失败后恢复旧状态。", yn: "术语状态、staging 提升、canonical 文件与 Host evidence 都使用明确事务边界。", not: "不是先写一部分，失败后靠下次运行猜测修补。" },
      en: { plain: "Atomic means related changes all succeed or leave no partial result; a Transaction is that commit boundary, and Rollback restores prior state after failure.", yn: "Terminology state, staging promotion, canonical files, and Host evidence use explicit transaction boundaries.", not: "It is not partial writing followed by a later run guessing how to repair it." }
    },
    {
      term: "Queue",
      category: "persistence",
      zh: { plain: "等待 Worker 领取的 assignment 集合。", yn: "共享队列按文件阶段开放；术语 priority wave 未结算时，普通任务不能越过它。", not: "不是给每个 Worker 预先分一整份私有文件列表。" },
      en: { plain: "The set of assignments waiting to be claimed by Workers.", yn: "The shared queue opens by file stage, and ordinary work cannot pass an unsettled terminology priority wave.", not: "It is not a private whole-file list assigned to each Worker in advance." }
    },
    {
      term: "Steer / Follow-up",
      category: "persistence",
      zh: { plain: "Steer 是希望当前工具结束后尽快让同一 Agent 看到的补充；Follow-up 是排在当前工作之后的消息。", yn: "两者都保留原始 AgentMessage，并由同一 Pi harness 消费。", not: "不是另建一套 YN 消息队列或等待状态机。" },
      en: { plain: "A Steer is an update for the same Agent to consume soon after the current tool returns; a Follow-up waits until the current work finishes.", yn: "Both remain original AgentMessage objects and are consumed by the same Pi harness.", not: "They do not create a separate YN message queue or waiting state machine." }
    },
    {
      term: "Context / Context Window",
      category: "persistence",
      zh: { plain: "模型在一次调用中实际看到的消息和资料；Context Window 是模型能容纳的 Token 容量。", yn: "Host 只注入负责行、短边界、命中资产和当前债务，完整状态留在磁盘。", not: "项目里存在一个文件不表示它已被塞进模型上下文。" },
      en: { plain: "The messages and references visible to a model call; the Context Window is the model's token capacity.", yn: "The Host injects owned lines, short boundaries, direct asset matches, and current debt while keeping full state on disk.", not: "A file existing in the project does not mean it was loaded into model context." }
    },
    {
      term: "Compaction",
      category: "persistence",
      zh: { plain: "长会话接近上下文容量时，把较早内容压缩为可继续使用的摘要。", yn: "使用 Pi 原生 compaction entry 与 Session.buildContext，不另造 YN 摘要文件。", not: "不是删除完整 JSONL；原始历史仍可审计。" },
      en: { plain: "Compressing older conversation content into a usable summary when a long session approaches context limits.", yn: "YN uses native Pi compaction entries and Session.buildContext rather than a separate summary file.", not: "It does not delete the full JSONL history." }
    },
    {
      term: "Token / Cache",
      category: "persistence",
      zh: { plain: "Token 是模型处理文本的计量单位；Cache 是服务商或运行时对重复输入的复用。", yn: "节省 Token 主要依靠有界上下文、直接命中资产、持久 Worker 和只上报失败行。", not: "不能靠一个魔法 Token 上限强行阻断合法调查。" },
      en: { plain: "A Token is a unit of model text processing; Cache reuses repeated input at the provider or runtime layer.", yn: "YN saves tokens through bounded context, direct asset matches, persistent Workers, and failure-only review output.", not: "A magic token cap must not block legitimate investigation." }
    },
    {
      term: "IPC / Bridge",
      category: "persistence",
      zh: { plain: "IPC 是进程间通信；Bridge 是把受限能力安全暴露给页面的接口层。", yn: "Renderer 通过 Electron bridge 请求 main process 保存项目、读资产、启动 Agent 或写入文件。", not: "网页脚本不能因此直接获得任意磁盘权限。" },
      en: { plain: "IPC is inter-process communication; a Bridge exposes a controlled capability surface to a page.", yn: "The Renderer asks the Electron main process to save projects, read assets, start Agents, or write files through the bridge.", not: "This does not give page scripts unrestricted disk access." }
    },
    {
      term: "Main Process / Renderer",
      category: "persistence",
      zh: { plain: "Main Process 是 Electron 中持有系统能力的后端进程；Renderer 是显示 React 或 HTML 界面的前端进程。", yn: "Agent runtime、文件和 Host 状态属于 main；页面负责输入与结构化展示。", not: "Renderer 显示的状态不能取代 main 中的持久真相。" },
      en: { plain: "The Electron Main Process owns system capabilities; a Renderer displays the React or HTML interface.", yn: "Agent runtime, files, and Host state live in main, while pages collect input and render structured output.", not: "Renderer state cannot replace durable truth in main." }
    },
    {
      term: "Telemetry / Observability",
      category: "persistence",
      zh: { plain: "Telemetry 是运行指标与事件；Observability 是利用这些证据判断系统内部发生了什么的能力。", yn: "关键证据包括 provider 错误链、assignment、staging、review debt、队列状态和 completion 原因。", not: "不是在界面上堆满内部 ID 和裸协议文本。" },
      en: { plain: "Telemetry is runtime metrics and events; Observability is the ability to infer internal behavior from that evidence.", yn: "Key evidence includes provider error chains, assignments, staging, review debt, queue state, and completion reasons.", not: "It does not mean flooding the UI with internal IDs and raw protocol text." }
    }
  ]
};
