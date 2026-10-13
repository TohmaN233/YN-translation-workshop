# Agent 技术术语

[English](terminology.en.md) · [工作流](workflows.md)

## Agent

能够接收消息、调用模型、选择工具并继续推进任务的执行主体。

YN 中的 Parent 和 Child 都是 Agent，并且都运行在 Pi runtime 上。

不等于模型本身；模型只是 Agent 每一步推理时调用的能力。

## Host

模型外面的可信程序层，真正执行工具、读写文件、保存状态并拒绝越权操作。

YN Host 是通用 Agent Host 里的翻译业务层，负责清单、队列、范围、校验、证据和提交。

不是远程服务器，不是主 Agent，也不是另一个模型。

## Harness

把模型、消息循环、工具、状态、错误处理和完成判断连接成可运行系统的整套外壳。

本项目的 Harness 由 Pi Agent loop、YN Host、工具、Supervisor、持久化与 UI 协议共同组成。

不是一条提示词，也不是某个单独的 workflow。

## Runtime

Agent 实际运行时使用的代码环境与生命周期实现。

Pi runtime 负责消息、模型调用、tool call、continue、队列消息、重试和 compaction。

不是所选模型；同一个 runtime 可以切换不同 provider 和 model。

## Pi

本项目采用的 Agent runtime 基础实现。

Parent 与 Child 共用 Pi 的 Agent、AgentMessage、Session 和 JSONL 语义。

不是 YN 自己另造的一套聊天协议。

## Parent Agent

直接与用户对话、规划工作并汇总结果的主 Agent。

它选择阶段、调用 Host 工具、处理冲突和剩余债务，最后向用户报告。

不会代替 Host 绕过范围和校验直接写入。

## Child Agent / Subagent

由 Parent 或 Host 为一项有边界任务启动的 Agent。

Child 拥有独立 Pi session，只看到当前 assignment 所需的工具和上下文。

不是一个只有函数体的后台线程，也不能再启动下一层 subagent。

## Worker

反复从共享队列领取 assignment 的持久 Child 角色。

翻译 Worker 负责写 staging；审阅 Worker 只读并提交失败 verdict；校对 Worker 写 findings。

Worker 数是并发上限，不等于任务块数量。

## Supervisor

管理 Child 生命周期、领取任务、重试、结算和补位的 Host 组件。

它连接 Host 队列与多个 Pi Child runtime，并保证失败 Worker 不偷偷领取下一项。

不负责生成译文内容。

## Provider / Model

Provider 是模型服务来源，Model 是该服务中实际调用的模型。

它们是用户级配置；Child 默认继承 Parent 当前选择。

更换模型不会更换 Host、Workflow contract 或项目资产。

## Prompt / System Prompt

Prompt 是交给 Agent 的本轮指令；System Prompt 是运行时注入的高优先级行为和工具说明。

页面生成的 Prompt 选择翻译或校对入口，内置 System Prompt 解释当前 typed workflow 与可用工具。

Prompt 文字本身不能授予 Host 没有给出的写权限。

## Tool / Function

Host 暴露给 Agent 的结构化调用接口。本文档里的 Function 指这些 tool surface。

每项都有 schema、读取边界、状态变化、返回值和拒绝条件。

不是让模型随意执行的内部 JavaScript 函数。

## Tool Call

Agent 请求 Host 执行某个 Tool 的结构化消息。

Host 校验参数和当前状态，执行后把 toolResult 放回同一 Pi turn。

调用成功不等于完整 workflow 已完成。

## Workflow

从入口、阶段推进到完成条件的一整套工作契约。

产品只暴露 initial_translation 与 proofread 两条完整 Workflow；术语、角色、复用和 QA 是内部阶段。

不是一个方便预填 Prompt 的按钮名称。

## Typed Contract

由程序结构明确记录、可以校验的约束，而不是只写在自然语言里。

文件身份、范围、worker 上限、workflow intent 和完成债务都会进入 typed state。

模型声称“我会只改这些行”不等于拥有 typed 权限。

## DomainRun

一次 YN 翻译或校对 workflow 的领域状态实例。

它记录 workflow 类型、owner、inspection、batch、发现、债务和 completion 进度。

不是模型进程，也不是 UI 里的任务卡片。

## Scope / Ownership

Scope 是允许操作的对象与范围；Ownership 表示当前谁合法持有该范围。

文档、连续行块或精确行都由 Host 授权，读取上下文不会扩大写入 ownership。

能读到一个文件不表示能修改它。

## Assignment

Host 交给一个 Worker 的单个有边界工作单元。

它绑定 document、行范围或精确行、输入 hash、角色和尝试状态。

不是整个文件，也不一定与 splitSize 一一相等。

## Batch

一组被同一次 Host 调度和结算管理的 assignment。

Host 在创建 Child 前原子预留 batch，并分别记录 taskCount 与实际 workerCount。

不等于一个 Child，也不等于一个文件。

## Manifest

本轮工作认可的文档清单及其身份信息。

文件顺序、原文、候选路径、行数和阶段屏障都来自 authoritative manifest。

不是每次让模型重新扫描目录得到的临时列表。

## Artifact

工作流产生并可被机器验证的持久文件或记录。

典型 artifact 包括行对齐候选译文、findings JSON、HTML sidecar 和项目资产。

Agent 在聊天里说“完成了”不是 artifact。

## Candidate

尚处在检查、选择或确认阶段的内容。具体含义取决于对象。

translation candidate 是正式写回前的候选译文；glossary candidate 是尚未进入正式术语表的译名。

两个 candidate 的审批和存储规则并不相同。

## Canonical

当前被系统视为权威、唯一结算依据的版本或位置。

可以指正式术语表、正式候选译文路径、canonical Pi messages 或唯一 findings JSON。

不表示内容永远不能再修改，只表示当前真相来源明确。

## Staging

尚未提升为正式结果的可恢复待检副本。

翻译 Worker 先把负责行写入 staging；机械校验和独立审阅通过后，Host 才提升到 canonical 译文。

不是 Git staging、内存缓存或已经正式提交的译文。

## Promote

把已经通过检查的 staging 范围写入 canonical artifact。

提升按精确范围并在候选文件锁内执行，不把同一 staging 的其他未审行一起带入。

不等于简单重命名整个临时文件。

## Validator / Validation

用确定规则判断输入或产物是否满足契约的代码与过程。

它检查行数、占位符、标签、保留规则、范围、schema、术语和完成债务。

不等于模型阅读后觉得“看起来不错”。

## Mechanical Validation

不需要模型理解语义即可重复执行的确定性检查。

例如行对齐、保护载荷、空行、明显占位文本、格式和部分术语一致性。

不能代替误译、语气和上下文含义的语义审阅。

## Semantic Review / Reviewer

结合原文、译文和上下文判断意义是否正确的审阅；Reviewer 是执行该审阅的只读 Worker。

翻译 Reviewer 只上报失败行，校对 Worker 则写入结构化 findings。

Reviewer 不直接修改翻译 staging。

## Finding / Verdict

Finding 是校对中可交付的问题记录；Verdict 是对某项检查的结构化结论。

findings 进入唯一 JSON 和审阅 HTML；review verdict 通常只记录失败或 reuse/retranslate。

不是聊天中的自由散文评论。

## Evidence

支持一个结论、并能在恢复后重新核对的结构化依据。

证据会绑定文档、行、代码、参考资产及 source/candidate hash。

只写一句理由但无法定位原译文，不算充分证据。

## Debt

工作流在允许完成前仍必须处理的明确事项。

可能是未翻译行、术语修复、warning 真阳性、未覆盖 scope 或待决资产。

不是技术债务的泛称，而是 completion gate 可计算的未结项。

## Hash / Hash-bound / Hash-current

Hash 是内容指纹；hash-bound 表示结论绑定某份具体输入；hash-current 表示指纹仍与当前文件一致。

输入变化时只让相关证据和授权失效，避免把旧结论套到新文本。

Hash 证明内容相同，不证明翻译质量正确。

## Completion Gate

决定 workflow 是否真的满足完成条件的程序门槛。

它核对 assignment 结算、coverage、验证、术语和资产债务，而不是相信模型的完成声明。

Agent 发出最终回复不代表 completion gate 已通过。

## Session / JSONL

Session 是一条可继续的 Agent 会话；JSONL 是按行追加保存会话事件的文件格式。

Parent 与每个 Child 都有自己的 Pi JSONL，用于恢复、审计和按需展开。

Parent 卡片里不会复制完整 Child transcript。

## Persistence / Durable State

把关键状态写到磁盘，使进程关闭后仍能恢复。Durable 表示不是只存在内存里。

Pi messages、Host state、staging、审阅证据和复用审计都有持久边界。

控制台日志不是唯一持久证据。

## Atomic / Transaction / Rollback

Atomic 表示相关变更要么全部成功，要么不留下半套结果；Transaction 是这组提交边界；Rollback 是失败后恢复旧状态。

术语状态、staging 提升、canonical 文件与 Host evidence 都使用明确事务边界。

不是先写一部分，失败后靠下次运行猜测修补。

## Queue

等待 Worker 领取的 assignment 集合。

共享队列按文件阶段开放；术语 priority wave 未结算时，普通任务不能越过它。

不是给每个 Worker 预先分一整份私有文件列表。

## Steer / Follow-up

Steer 是希望当前工具结束后尽快让同一 Agent 看到的补充；Follow-up 是排在当前工作之后的消息。

两者都保留原始 AgentMessage，并由同一 Pi harness 消费。

不是另建一套 YN 消息队列或等待状态机。

## Context / Context Window

模型在一次调用中实际看到的消息和资料；Context Window 是模型能容纳的 Token 容量。

Host 只注入负责行、短边界、命中资产和当前债务，完整状态留在磁盘。

项目里存在一个文件不表示它已被塞进模型上下文。

## Compaction

长会话接近上下文容量时，把较早内容压缩为可继续使用的摘要。

使用 Pi 0.99.1 原生 compaction entry、retainedTail 与 branch 上下文投影，不另造 YN 摘要文件。

不是删除完整 JSONL；原始历史仍可审计。

## Token / Cache

Token 是模型处理文本的计量单位；Cache 是服务商或运行时对重复输入的复用。

节省 Token 主要依靠有界上下文、直接命中资产、持久 Worker 和只上报失败行。

不能靠一个魔法 Token 上限强行阻断合法调查。

## IPC / Bridge

IPC 是进程间通信；Bridge 是把受限能力安全暴露给页面的接口层。

Renderer 通过 Electron bridge 请求 main process 保存项目、读资产、启动 Agent 或写入文件。

网页脚本不能因此直接获得任意磁盘权限。

## Main Process / Renderer

Main Process 是 Electron 中持有系统能力的后端进程；Renderer 是显示 React 或 HTML 界面的前端进程。

Agent runtime、文件和 Host 状态属于 main；页面负责输入与结构化展示。

Renderer 显示的状态不能取代 main 中的持久真相。

## Telemetry / Observability

Telemetry 是运行指标与事件；Observability 是利用这些证据判断系统内部发生了什么的能力。

关键证据包括 provider 错误链、assignment、staging、review debt、队列状态和 completion 原因。

不是在界面上堆满内部 ID 和裸协议文本。
