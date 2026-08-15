# RFC：将 YN Translation Workshop 演进为人类-Agent 协作翻译工作台

## 1. 总体判断

YN Translation Workshop 的下一阶段不应该只是继续增加更多模型专用 skill，也不应该直接变成通用 Agent OS。更合适的方向是：

> 将现有的本地翻译/校对工作台，演进为一个 **人类主导、Agent 协作、可审阅、可验证、可回滚的翻译 Agent 工作台**。

这个方向和现有项目并不冲突。现有项目已经有：

- 行对行翻译 HTML 工作台；
- 原文、译文、审校报告之间的联动；
- Codex / Claude Code 的 Agent 辅助流程；
- HTML 工作台的多窗口 / 新窗口承载能力；
- 审校报告 HTML 化；
- 一键接受或手动改写 AI 建议；
- 本地项目状态目录；
- 局域网协作和跨设备编辑能力。

因此下一步的重点不是另起炉灶，而是把“生成 prompt / 临时终端式交互”升级为“可关闭、可分离、可恢复历史的 Agent OS 式会话入口 + 结构化 Agent job + 翻译专用工作流 + 人类审阅队列”。

---

## 2. 产品定位

### 2.1 不是通用 Agent OS

本项目不需要复刻 Apix 这类通用 Agent 平台的全部能力。通用 Agent OS 的核心对象通常是聊天、任务、工具、文件、浏览器、代码执行和知识库。

YN Translation Workshop 的核心对象应该始终是：

- 原文行；
- 译文行；
- 章节；
- 术语；
- 角色设定；
- 风格规范；
- 审校发现；
- AI 修改建议；
- 人类接受、拒绝和改写记录；
- 导出的最终译文。

Agent 是协作者，不是唯一产品中心。产品中心仍然是翻译工作台，但 Agent 可以拥有类似 Agent OS 的聊天入口：它可以停靠在主窗口右侧，也可以作为 HTML 新窗口 / 双窗口打开；用户可以随时关闭它，之后再打开时直接恢复项目会话历史，而不是重新开启一次临时终端会话。

### 2.2 不是单纯 API 翻译器

项目也不应该退化成一个“输入原文、调用 API、输出译文”的普通机器翻译工具。

理想形态是：

```text
人类译者 / 审校者
  ↕
翻译工作台 UI
  ↕
结构化翻译数据模型
  ↕
Agent Conversation Layer + Agent Job Runtime
  ↕
Codex / Claude Code / API Model / Local Model / MCP Tools
```

API 调用只是 provider 的一种。Codex、Claude Code、本地模型、远程 Agent 服务也都应该能作为 provider 接入；其中 CLI 型 provider 可以作为后台 adapter 存在，但不再作为用户主要交互界面。

### 2.3 核心原则

1. **人类主导**：Agent 提供候选译文、审校发现和 patch，人类决定是否接受。
2. **行对行优先**：所有 Agent 输出都必须尽量绑定到 lineId / lineRange。
3. **结构化优先**：机器读取 JSON schema，人类阅读 Markdown / HTML。
4. **可验证优先**：行数、空行、占位符、标签、术语等必须有确定性校验。
5. **可回滚优先**：Agent 不应默认直接覆盖最终译文，应先输出可审阅 patch。
6. **provider 无关**：翻译协议不属于 Codex 或 Claude，模型和工具只是执行后端。
7. **本地优先**：保持当前项目的轻量、本地、个人使用体验，不引入重型部署依赖作为默认路径。

---

## 3. 明确不做的事情

为了避免方向膨胀，以下内容不纳入当前路线：

- 不做企业级权限系统；
- 不做公司级审计、风控、合规能力；
- 不改变当前个人使用场景下的 PIN / 局域网共享基本模式；
- 不把项目默认改造成多服务部署架构；
- 不强依赖 Docker、Redis、MySQL、向量数据库等重型基础设施；
- 不用单一聊天流替代行对行翻译编辑器和 HTML 工作台；
- 不要求用户打开终端才能执行 Agent 任务；
- 不保留“每次重开终端、重新复制 prompt、重新读上下文”的交互模式；
- 不让 Agent 默认直接接管最终译文文件。

如果以后项目商业化或进入团队/公司级使用，再单独讨论企业安全和权限治理。当前开源阶段优先服务个人译者和小规模协作。

---

## 4. 目标形态

### 4.1 UI 形态

目标不是单独做一个通用聊天机器人，也不是继续把终端嵌在应用里。更合适的形态是：现有翻译 HTML 工作台继续作为主工作区，同时新增一个 **Agent OS 式聊天入口**。

这个入口应该满足：

- 可以停靠在主窗口右侧；
- 可以从 HTML 工作台中新建窗口打开；
- 可以和翻译 HTML 双窗口并排使用；
- 可以随时关闭，不影响当前翻译工作；
- 重新打开后读取项目会话历史、任务历史、产物历史；
- 不再要求用户每次重新打开终端、重新复制 prompt、重新让 Agent 读上下文。

```text
┌──────────────────────────────────────────────────────────────┐
│ Project / Chapter / Workflow / Provider / Model              │
├───────────────┬───────────────────────────────┬──────────────┤
│ 项目导航       │ 行对行翻译编辑器                │ Agent OS Chat │
│ - 章节         │ 原文 | 译文 | 状态 | 问题标记     │ - 会话历史     │
│ - 术语表       │ 可改写、可搜索、可跳转、可 diff   │ - 任务卡片     │
│ - 角色表       │                               │ - 子任务       │
│ - 审校报告     │                               │ - 工具调用记录  │
├───────────────┴───────────────────────────────┴──────────────┤
│ Patch / Review Queue：AI 建议、校验错误、术语问题、人工验收记录 │
└──────────────────────────────────────────────────────────────┘
```

Agent OS Chat 不是普通聊天框，也不是普通终端。它是一个持久化的项目会话入口，聊天流中可以嵌入结构化卡片：

```text
会话：chapter_03 翻译与校对
Scope：当前项目 / 当前章节 / 当前选中行
Provider：Codex / Claude Code / OpenAI-compatible API / Local Model

User：翻译 1200-1800 行，保持术语表一致。
Agent：已创建 Initial Translation Job。

[Job Card]
  任务：翻译 chapter_03.txt 1200-1800
  状态：running
  进度：320 / 600 lines
  子任务：
    - 1200-1399：completed
    - 1400-1599：running
    - 1600-1800：queued
  产物：
    - translation.patch.json
    - validation.json
  操作：取消 / 重试 / 打开产物 / 进入 Patch Review

[Validation Card]
  行数一致：OK
  空行一致：OK
  占位符保留：OK
  术语缺失：12 warnings
```

因此 UI 的核心不是“终端输出”，而是：

```text
持久会话历史
  + Agent job cards
  + tool call timeline
  + artifacts
  + validation cards
  + patch / report 跳转
```

用户在这个入口里可以像 Agent OS 一样发指令、追问、让 Agent 继续某个任务、查看历史任务和产物；同时也可以关闭该窗口，回到纯翻译编辑模式。

### 4.2 架构形态

```text
Translation UI
  ├─ 行对行编辑器
  ├─ 审校报告面板
  ├─ 术语 / 角色 / 风格面板
  ├─ Agent OS Chat Entry
  ├─ Agent Job Cards
  └─ Patch Review Queue

Agent Conversation Layer
  ├─ Conversation Store
  ├─ Message / ToolCall / Artifact Timeline
  ├─ Project / Chapter / Selection Scope
  ├─ Session Restore
  └─ Chat-to-Job Bridge

Translation Core
  ├─ Document Model
  ├─ Line Pair Model
  ├─ Glossary
  ├─ Character Bible
  ├─ Style Guide
  ├─ Review Finding Model
  ├─ Patch Engine
  └─ Validators

Agent Runtime
  ├─ Job Manager
  ├─ Event Stream
  ├─ Subagent Orchestrator
  ├─ Artifact Watcher
  ├─ Human Approval Gate
  └─ Job Store

Provider Adapters
  ├─ Codex Adapter
  ├─ Claude Code Adapter
  ├─ OpenAI / compatible API Adapter
  ├─ Anthropic API Adapter
  ├─ Local Model Adapter
  └─ MCP Tool Adapter

Workflow Templates
  ├─ Initial Translation
  ├─ Proofread
  ├─ Terminology Sweep
  ├─ Character Voice Check
  ├─ Apply Accepted Fixes
  └─ Final QA / Export
```

其中 Codex / Claude Code 即使继续作为 provider，也不应该再暴露成用户主要操作的终端窗口。它们可以是后台 adapter；前端统一通过持久 Agent 会话和 job cards 交互。

---


## 5. 核心设计变化

### 5.1 从模型专用 skill 变成统一翻译协议

当前 Codex 和 Claude Code 可以保留各自的接入方式，但不应该继续维护两套业务规则。

应该把 skill 拆成：

```text
translation-protocol/
  translate.md
  proofread.md
  report-schema.md
  patch-schema.md
  glossary-rules.md
  character-bible-rules.md

provider-adapters/
  codex/
    renderSkill.ts
    installTarget.ts
  claude/
    renderCommand.ts
    installTarget.ts
  api/
    renderPrompt.ts
```

其中 `translation-protocol` 描述模型无关的翻译规则：

- 输入文件格式；
- 行号对齐要求；
- 术语表使用规则；
- 角色设定使用规则；
- 输出 schema；
- patch schema；
- 审校报告 schema；
- validator 约束。

Codex / Claude / API provider 只负责把这套协议渲染成各自能执行的格式。

这样可以避免：

- Codex skill 和 Claude command 规则漂移；
- 新模型接入时复制第三套 skill；
- prompt 修复需要多处同步；
- 输出格式无法统一解析。

### 5.2 从终端会话变成持久 Agent 会话 + Job Runtime

新的交互核心不应该是“打开终端、复制 prompt、等待输出、下次重开丢上下文”。终端作为用户界面应被移除；如果为了兼容 Codex / Claude Code 仍需要调用 CLI，也只能作为后台 adapter，而不是用户交互入口。

应用侧应该同时拥有两个核心抽象：

```text
AgentConversation
  面向人类：聊天历史、上下文、任务卡片、工具调用、产物链接

AgentJob
  面向系统：可执行、可取消、可重试、可持久化、可校验的任务
```

Conversation 可以创建 job，job 的事件和产物会回写到 conversation timeline。这样用户重新打开 Agent 窗口时，看到的是连续的项目会话，而不是空白终端。

```ts
interface AgentConversation {
  id: string;
  projectId: string;
  scope: "project" | "chapter" | "selection" | "job";
  title: string;
  messages: AgentMessage[];
  linkedJobIds: string[];
  artifactRefs: AgentArtifactRef[];
  createdAt: string;
  updatedAt: string;
}

interface AgentMessage {
  id: string;
  conversationId: string;
  role: "user" | "agent" | "system" | "tool";
  content: string;
  jobRefs?: string[];
  artifactRefs?: string[];
  toolCalls?: AgentToolCall[];
  createdAt: string;
}

interface AgentJob {
  id: string;
  conversationId?: string;
  type: AgentJobType;
  documentId: string;
  providerId: string;
  input: AgentJobInput;
  status: AgentJobStatus;
  artifacts: AgentArtifact[];
  createdAt: string;
  updatedAt: string;
}
```

Provider 接口可以同时支持聊天和任务：

```ts
interface AgentProvider {
  id: string;
  name: string;

  validateConfig(): Promise<ProviderStatus>;

  sendMessage(
    conversation: AgentConversation,
    message: AgentMessage
  ): AsyncIterable<AgentEvent>;

  startJob(job: AgentJob): Promise<AgentJobHandle>;

  streamEvents(jobId: string): AsyncIterable<AgentEvent>;

  cancel(jobId: string): Promise<void>;

  listArtifacts(jobId: string): Promise<AgentArtifact[]>;
}
```

这样 Codex、Claude Code、OpenAI API、本地模型都只是 provider。UI 只关心持久会话、job 状态、事件、产物和错误。

### 5.3 从 Markdown 报告变成 JSON schema + Markdown

Markdown 适合人看，不适合作为唯一机器协议。

Agent 审校后应该输出：

```text
report/chapter03.proofread.json
```

其中 JSON 是主协议：

```json
{
  "schemaVersion": "1.0",
  "documentId": "chapter03",
  "findings": [
    {
      "id": "H9-0001",
      "severity": "H9",
      "type": "omission",
      "sourceLine": 123,
      "translationLine": 123,
      "sourceText": "...",
      "currentTranslation": "...",
      "suggestedFix": "...",
      "rationale": "...",
      "agentId": "proofreader-1"
    }
  ]
}
```

HTML 审校界面优先读取 JSON，如果 JSON 不存在，再 fallback 到旧 Markdown 解析逻辑，生成的html才是给人看的。（另外目前有全部分类这个按钮无效的bug）

下面这段可直接替换 5.4：

---

### 5.4 从手动寻找 Agent 产物变成产物发现与一键导入

Agent 初翻不应该被描述为“直接写最终汉化文件”。当前项目的真实流程是：Agent 生成一个独立的译文 TXT，用户再将这个 TXT 导入或同步到 HTML 工作台中，最终是否写回绑定译文文件仍由用户显式触发。

因此，本阶段的重点不是把初翻产物改成 patch review，而是强化 **Agent 产物发现、行对行强制校验、一键导入工作台**。

目标流程：

```text
Agent 生成候选译文 TXT
  ↓
Agent Runtime 自动发现产物
  ↓
Importer 读取译文 TXT
  ↓
Line-aligned Validator 强制校验
  ↓
Agent OS 聊天入口显示产物卡片
  ↓
用户点击“导入为译文草稿”
  ↓
写入当前 HTML 工作台 / project working state
  ↓
用户继续人工审阅、修改、导出或显式写入 TXT
```

聊天入口中的产物卡片可以显示：

```text
已生成译文：
AI_translation/chapter03.txt

校验结果：
- 行数一致：OK
- 空行结构：OK
- 占位符保留：OK
- HTML / XML 标签保留：OK
- 疑似未翻译行：12 warnings
- 术语缺失：8 warnings

操作：
[导入为译文草稿] [对比并导入] [打开产物] [重新生成]
```

导入动作只更新当前工作台中的译文草稿，不自动覆盖最终 TXT 文件。最终导出或写入绑定译文路径仍然沿用现有显式操作。

#### 行对行必须是代码级约束

行对行不应只依赖 prompt。无论 Agent 使用 Codex、Claude Code、API provider 还是本地模型，导入前都必须经过应用侧 hook / validator。

最低要求：

```text
beforeImportTranslation(candidateTxt)
  - 读取 Agent 输出 TXT
  - 统一换行格式
  - 按行切分
  - 与 source line model 对齐
  - sourceLines.length 必须等于 candidateTranslationLines.length
  - 行数不一致时禁止静默导入
  - 缺行、多行、合并行必须进入修复流程
```

当行数不一致时，UI 不应提供普通导入按钮，而应进入异常处理：

```text
[打开行数修复器]
[生成格式修复提示词]
[让 Agent 修复格式]
[手动查看产物]
```

这意味着“行对行”是工作台的数据不变量，而不是 Agent 自觉遵守的文本约定。

#### 内部数据结构建议

为了让行对行更稳定，工作台内部可以维护明确的 line model。实现上可以继续使用现有项目状态文件，也可以后续迁移到 SQLite 或类似结构化存储。

概念模型如下：

```sql
documents(
  id TEXT PRIMARY KEY,
  title TEXT,
  source_path TEXT,
  translation_path TEXT
);

lines(
  document_id TEXT,
  line_id INTEGER,
  source_text TEXT,
  translation_text TEXT,
  revision INTEGER,
  status TEXT,
  PRIMARY KEY(document_id, line_id)
);

agent_jobs(
  job_id TEXT PRIMARY KEY,
  document_id TEXT,
  type TEXT,
  provider TEXT,
  model TEXT,
  status TEXT,
  created_at TEXT,
  completed_at TEXT
);

translation_candidates(
  job_id TEXT,
  document_id TEXT,
  line_id INTEGER,
  candidate_text TEXT,
  validation_status TEXT,
  PRIMARY KEY(job_id, document_id, line_id)
);
```

Agent 产物导入时，不是直接把 TXT 当作最终译文覆盖，而是：

```text
候选译文 TXT
  ↓
parse into candidate lines
  ↓
按 line_id 写入 translation_candidates
  ↓
validator 检查完整性
  ↓
用户确认导入
  ↓
更新 lines.translation_text / 当前 HTML 工作台状态
```

这样可以保证：

```text
一个候选译文行必须对应一个已有 source line；
缺失 line_id 不能完成导入；
多出来的 line 不能写入；
同一个 job 的候选译文可以被追踪、比较和丢弃；
最终写回 TXT 仍由用户显式触发。
```

#### 初翻和校对需要分开处理

初翻模式的产物是完整译文 TXT：

```text
source.txt
  ↓
Agent 初翻
  ↓
AI_translation/chapter03.txt
  ↓
产物发现 + 行对行校验
  ↓
一键导入工作台
```

校对模式的产物才适合使用 finding / fix proposal / patch：

```text
source.txt + translation.txt
  ↓
Agent 校对
  ↓
proofread_report.md / findings.json
  ↓
审阅 HTML
  ↓
用户接受 AI 建议 / 手动改写
```

因此：

```text
初翻 = translation candidate artifact
校对 = finding / fix proposal / patch
最终输出 = 用户显式导出 / 写入 TXT
```

Patch review 不应作为初翻 TXT 的默认模型；它应保留给校对建议、术语统一建议、角色口吻修正建议、局部改写建议等场景。

#### 验收标准

* Agent 生成译文 TXT 后，UI 能自动显示“检测到译文产物”；
* 产物卡片能显示文件路径、provider / model、所属 job、校验结果；
* 用户可以点击“导入为译文草稿”将候选译文导入当前工作台；
* 导入前必须执行行对行 validator；
* 行数不一致时禁止静默导入；
* 行数不一致时提供格式修复入口；
* 导入只更新当前工作台状态，不自动覆盖最终 TXT；
* 最终导出 / 写入 TXT 仍由用户显式触发；
* 校对模式下的 AI 建议可以继续走 finding / fix proposal / patch review。

### 5.5 从 prompt 级 subagent 变成 runtime 级 subagent

现在可以在 prompt 里要求模型调用子 Agent，但这依赖模型自觉执行。长期更稳的做法是让应用自己管理子任务。

目标流程：

```text
AgentOrchestrator
  ├─ 按章节 / 行号 / 审校维度拆分任务
  ├─ 创建 subjobs
  ├─ 调用 provider 执行
  ├─ 监听 artifacts
  ├─ 校验每个 shard
  ├─ 合并译文
  ├─ 合并术语提案
  ├─ 合并角色设定提案
  └─ 生成最终 patch / report
```

子任务状态示例：

```json
{
  "taskId": "translate-ch03-0001",
  "range": [1, 1000],
  "status": "completed",
  "provider": "codex-cli",
  "artifacts": [
    "AI_translation/ch03.part-0001.txt",
    "glossary.part-0001.json"
  ],
  "validation": {
    "lineCount": "ok",
    "placeholders": "ok",
    "emptyLines": "ok"
  }
}
```

多 Agent 不是多个聊天机器人互相聊天，而是一个 UI 可见、可重试、可合并、可验证的任务图。

---

## 6. 翻译专用 Agent 角色

可以预设这些 Agent 角色，但它们本质上是工作流节点，不一定对应真实独立进程。

```text
Project Lead Agent
  负责拆分任务、安排顺序、汇总结果、向人类提问

Terminology Agent
  抽取术语，发现译名冲突，提出术语表更新

Translator Agent
  按章节或行号范围生成 line-aligned draft

Consistency Agent
  检查人名、称谓、组织、技能名、口癖、风格一致性

Proofreader Agent
  检查漏译、误译、过度意译、语病、标点、格式问题

Patch Agent
  把审校发现转成可审阅 patch

Validator
  执行确定性校验：行数、空行、变量、标签、占位符、术语等

Human Reviewer
  接受、拒绝、改写、锁定最终译文
```

典型章节工作流：

```text
Preflight
  ↓
Extract Terms + Build Context
  ↓
Split Chapter into Shards
  ↓
Translator[1] Translator[2] Translator[3] ...
  ↓
Merge by lineId
  ↓
Deterministic Validation
  ↓
Consistency Review
  ↓
Proofread Findings
  ↓
Patch Queue
  ↓
Human Accept / Reject / Rewrite
  ↓
Export TXT / EPUB
```

---

## 7. 翻译专用工具层

Agent 默认不需要通用 shell 能力。更应该优先提供翻译领域工具。

```ts
readSourceLines(range)
readTranslationLines(range)
searchGlossary(term)
proposeGlossaryUpdate(entry)
readCharacterBible(character)
proposeCharacterUpdate(character, note)
queryTranslationMemory(text)
proposeTranslationPatch(changes)
validateTranslationPatch(patch)
askHuman(question)
markFindingResolved(findingId)
```

这些工具的重点不是企业安全，而是让 Agent 操作和 UI 数据模型对齐。

例如，Agent 不直接说“我修改了第 123 行”，而是调用：

```ts
proposeTranslationPatch({
  documentId: "chapter03",
  changes: [
    {
      lineId: 123,
      oldText: "...",
      newText: "...",
      reason: "术语统一"
    }
  ]
})
```

这样前端才能稳定展示 diff、记录来源、执行校验、支持撤销。

---

## 8. 项目资产与记忆系统

不要把“记忆”做成纯聊天摘要。翻译项目里的记忆应该是可审阅、可编辑、可导出的项目资产。

建议扩展 `.translation-workshop/`：

```text
.translation-workshop/
  project.json
  agent-jobs/
  patches/
  reports/
  validation/
  glossary.json
  character_bible.json
  style_guide.md
  translation_memory.sqlite
  decisions.jsonl
```

其中：

```text
project.json
  保存项目元数据、章节列表、当前工作流状态

glossary.json
  保存术语、译名、别名、上下文、是否人工确认

character_bible.json
  保存角色名、称谓、关系、口吻、说话风格

style_guide.md
  保存人工制定的翻译风格规则

translation_memory.sqlite
  保存历史原文-译文对，供相似句查询

decisions.jsonl
  保存人工确认过的重要翻译决策

patches/
  保存 Agent 和人工生成的可回滚修改建议

agent-jobs/
  保存每次 Agent job 的输入、状态、事件和产物索引
```

翻译决策示例：

```json
{
  "time": "2026-06-20T12:00:00Z",
  "type": "terminology_decision",
  "source": "王都騎士団",
  "target": "王都骑士团",
  "reason": "与前文保持一致",
  "approvedBy": "human"
}
```

这样 Agent 每次执行时读的是结构化资产，而不是依赖长聊天上下文里的模糊记忆。

---

## 9. Issue 列表

下面的 issue 按优先级和依赖关系整理，已经去掉企业级安全、PIN 强化、公网权限治理等内容。

---

### Issue 1：合并 Codex / Claude 的业务 skill 为统一翻译协议

**Priority：P0**  
**Type：Refactor / Architecture**

#### 背景

当前 Codex 和 Claude Code 的接入方式可以不同，但翻译业务规则不应该维护两套。翻译、审校、术语、角色、报告、patch 的核心要求应该只有一份。

#### 目标

建立 provider-agnostic 的翻译协议层：

```text
translation-protocol/
  translate.md
  proofread.md
  patch-schema.md
  report-schema.md
  glossary-rules.md
  character-bible-rules.md
```

Codex / Claude / API 只作为 adapter。

#### 验收标准

- 翻译业务规则只维护一份；
- Codex 和 Claude 的 prompt / command 由同一协议渲染生成；
- 新增 provider 不需要复制整套 skill；
- 旧的 Codex / Claude 使用路径保持可用。

---

### Issue 2：新增 AgentProvider 抽象

**Priority：P0**  
**Type：Architecture**

#### 背景

当前 Agent 接入不应该继续以用户可见终端为中心。未来需要同时支持 Codex、Claude Code、OpenAI-compatible API、本地模型等，但前端统一通过持久会话和 job cards 交互。

#### 目标

新增统一 provider 接口，同时支持会话消息和结构化 job：

```ts
interface AgentProvider {
  id: string;
  name: string;

  validateConfig(): Promise<ProviderStatus>;

  sendMessage(
    conversation: AgentConversation,
    message: AgentMessage
  ): AsyncIterable<AgentEvent>;

  startJob(job: AgentJob): Promise<AgentJobHandle>;
  streamEvents(jobId: string): AsyncIterable<AgentEvent>;
  cancel(jobId: string): Promise<void>;
  listArtifacts(jobId: string): Promise<AgentArtifact[]>;
}
```

#### 验收标准

- Codex 可以作为后台 provider 接入，不暴露终端 UI；
- Claude Code 可以作为后台 provider 接入，不暴露终端 UI；
- API provider 可以走同一套 conversation / job / artifact 协议；
- UI 不直接依赖具体 CLI；
- provider 能返回会话消息、job 状态、日志、产物和错误。

---

### Issue 3：实现可关闭 / 可分离的 Agent OS 式聊天入口

**Priority：P0**  
**Type：UI / UX / Agent Conversation**

#### 背景

内置终端不应该继续作为主要交互，也不需要保留成所谓“高级视图”。翻译工作台需要的是类似 Agent OS 的聊天入口：用户可以在里面直接下达任务、查看会话历史、继续之前的任务、打开产物、进入 patch review；同时这个入口可以随时关闭，不干扰行对行翻译编辑。

由于项目本身已经以 HTML 工作台为核心，Agent 入口可以作为主窗口右侧面板，也可以作为独立 HTML 新窗口 / 双窗口打开。关键是会话历史和任务状态由项目持久化，而不是依赖一次性的终端进程。

#### 目标

新增 Agent OS Chat Entry：

- 可停靠在主窗口右侧；
- 可从 HTML 工作台打开为新窗口；
- 可与翻译 HTML 双窗口并排使用；
- 可随时关闭和重新打开；
- 重新打开后读取同一项目 / 章节 / job 的会话历史；
- 聊天流中可嵌入 job card、subjob card、tool call、artifact、validation、patch / report 入口；
- 用户可以在聊天入口里继续追问、要求重试、要求基于已有产物继续处理；
- 不再要求用户打开终端、复制 prompt 或重新让 Agent 读取上下文。

#### 数据结构建议

```ts
interface AgentConversation {
  id: string;
  projectId: string;
  scope: "project" | "chapter" | "selection" | "job";
  title: string;
  messages: AgentMessage[];
  linkedJobIds: string[];
  artifactRefs: AgentArtifactRef[];
  createdAt: string;
  updatedAt: string;
}
```

#### 验收标准

- 用户可以在不打开终端的情况下创建、继续、追问 Agent 任务；
- Agent 入口可以关闭后重开，并恢复同一项目的会话历史；
- Agent 入口可以作为主窗口面板，也可以作为独立 HTML 窗口打开；
- 会话中能展示 job events、工具调用、产物、校验结果和 patch / report 跳转；
- 旧的终端入口不再作为主要 UI，也不作为必要操作路径。

---

### Issue 4：引入 AgentJob Runtime

**Priority：P0**  
**Type：Core Feature**

#### 背景

Agent 任务不应该只是一次聊天回复，也不应该依赖用户复制 prompt 后等待某个终端输出。应用需要知道任务状态、进度、产物和失败原因；Agent 会话需要能把这些任务作为卡片和时间线事件展示出来。

#### 目标

新增 Agent job runtime：

```ts
interface AgentJob {
  id: string;
  conversationId?: string;
  type: "translate" | "proofread" | "terminology" | "character_voice" | "final_qa";
  documentId: string;
  providerId: string;
  status: "queued" | "running" | "waiting_for_human" | "completed" | "failed" | "cancelled";
  input: unknown;
  artifacts: AgentArtifact[];
  events: AgentEvent[];
}
```

#### 验收标准

- 可以从 Agent 聊天入口或翻译 UI 创建翻译 / 审校 job；
- job 状态可持久化；
- job events 能回写到对应 conversation timeline；
- job 产物可被 UI 识别；
- job 失败后能展示错误原因并允许重试；
- 同一 conversation 可以继续引用历史 job 和 artifacts。

---

### Issue 5：新增确定性 Translation Validator

**Priority：P0**  
**Type：Core Feature / QA**

#### 背景

Prompt 约束不可靠。行数、空行、占位符、标签、变量等必须由应用侧确定性检查。

#### 目标

实现 validator：

```text
Blocking errors:
  - 行数不一致
  - 必须保留的占位符缺失
  - HTML/XML-like tag 缺失或错位
  - lineId 不存在
  - patch oldText 与当前译文不匹配

Warnings:
  - 空行位置变化
  - 术语未使用
  - 疑似未翻译残留
  - 长度异常
  - 标点风格异常
```

#### 验收标准

- 导入 Agent 译文前自动校验；
- 应用 patch 前自动校验；
- 错误和 warning 能绑定到具体行；
- UI 能跳转到问题行；
- blocking error 阻止自动应用。

---

### Issue 6：审校报告改为 JSON schema 输出

**Priority：P1**  
**Type：Data Model / Compatibility**

#### 背景

Markdown 报告适合阅读，但不适合作为唯一机器协议。格式稍变就可能影响解析。

#### 目标

Agent 审校输出：

```text
chapter03.proofread.json
```

JSON 用于 UI 和 patch pipeline

#### 验收标准

- HTML 审校界面优先读取 JSON；
- JSON 不存在时 fallback 到 Markdown；
- finding 有稳定 id、severity、lineId、type、suggestedFix；
- finding 可以转成 patch；
- 旧报告格式仍尽量兼容。

---

### Issue 7：实现 runtime 级 Subagent Orchestrator

**Priority：P1**  
**Type：Agent Runtime**

#### 背景

多 Agent 能力不应该只写在 prompt 里。应用需要可见、可重试、可合并的子任务系统。

#### 目标

实现 subjob 调度：

- 按行号范围拆分；
- 按章节拆分；
- 按审校维度拆分；
- 并行执行；
- 单 shard 校验；
- 失败 shard 单独重试；
- 合并产物；
- 生成最终 patch / report。

#### 验收标准

- UI 能显示每个 subjob 的状态；
- subjob 有独立 artifacts；
- 单个 subjob 失败不导致整个任务不可恢复；
- 合并结果按 lineId 稳定排序；
- 合并后自动运行 validator。

---



### Issue 8：新增 API Agent Provider

**Priority：P1**
**Type：Provider / Agent Integration**

#### 背景

当前 Agent 辅助主要通过本地 CLI Agent，例如 Codex CLI、Claude Code 等。
但未来的方向不是简单增加“按次调用 LLM API”的 provider，而是让前端工作台可以接入 **API 形态的 Agent 工作流**。

也就是说，API provider 不应该只是：

```text
发送 prompt
  ↓
等待模型返回一段文本
```

而应该是：

```text
创建 / 恢复 Agent session
  ↓
提交 translation / proofread job
  ↓
Agent 进入多轮工作流
  ↓
Host 提供项目上下文、行数据、术语表、工具调用
  ↓
Agent 生成译文产物 / 审校报告 / 修正建议
  ↓
Host 发现产物、校验、导入或进入 review
```

它更接近 Codex、Claude Code、Pi、Agent OS 一类产品的工作方式：
用户不是在前端做一次普通 API completion，而是通过 API 进入一个可持续的 Agent loop。

#### 目标

新增 API Agent Provider，使 Translation Agent Host 可以通过 API 驱动远程或本地 Agent 工作流。

Provider settings 应围绕 Agent session / job loop 设计，而不是只围绕单次模型调用：

```text
Provider settings:
  - provider type
  - base URL
  - API key / auth token
  - agent profile / agent id
  - model / reasoning model（如果 provider 需要）
  - session mode：new session / resume session
  - max turns / max steps
  - max runtime / budget limit
  - stream events 开关
  - tool-call mode
  - artifact output mode
  - workspace binding mode
```

API Agent Provider 必须接入同一套 Host Runtime：

```text
HTML / Agent Chat UI
  ↓
Translation Agent Host
  ↓
API Agent Provider
  ↓
Remote Agent Session / Agent Runtime
```

API Agent Provider 不直接替代翻译工作台，也不直接绕过工作台的数据模型。
它只是另一种 Agent 执行后端。

#### Agent loop 基本流程

```text
用户在 Agent Chat 中发起任务
  ↓
Host 创建 AgentJob
  ↓
API Agent Provider 创建或恢复远程 Agent session
  ↓
Host 向 Agent 提供任务说明、项目上下文、行范围、术语表、角色表
  ↓
Agent 通过 API stream 返回事件
  ↓
Host 记录 conversation / job events
  ↓
Agent 请求工具调用时，由 Host 决定如何响应
  ↓
Agent 生成候选译文 TXT / 审校报告 / findings / fix proposals
  ↓
Host 索引产物
  ↓
Host 执行 validator
  ↓
UI 显示产物卡片、导入按钮或 review 入口
```

#### API Agent Provider 应支持的事件

API Agent Provider 不应该只返回最终文本，而应该尽量返回结构化事件：

```text
AgentEvent:
  - message.delta
  - message.completed
  - job.started
  - job.progress
  - tool.requested
  - tool.completed
  - artifact.created
  - validation.started
  - validation.completed
  - job.completed
  - job.failed
  - job.cancelled
```

前端 Agent Chat 可以把这些事件展示成：

```text
普通消息
任务卡片
进度卡片
工具调用卡片
产物卡片
校验结果卡片
导入 / review 操作按钮
```

#### Host Tool Interface

API Agent Provider 不应该让远程 Agent 随意理解本地项目结构。
Agent 需要项目数据时，应通过 Host 暴露的翻译专用工具接口获取。

例如：

```ts
readSourceLines(documentId, range)
readTranslationLines(documentId, range)
searchGlossary(term)
readCharacterBible(characterName)
readStyleGuide()
createTranslationCandidate(documentId, lines)
createProofreadFinding(finding)
createFixProposal(proposal)
listArtifacts(jobId)
requestHumanApproval(question)
```

这样可以保证 API Agent 和 CLI Agent 进入同一套工作流，而不是每种 provider 各自发明一套文件读写方式。

#### 初翻与校对的产物区别

API Agent Provider 必须遵守现有翻译工作台的产物语义。

初翻任务产物是候选译文：

```text
translation candidate artifact
  - candidate TXT
  - optional jsonl sidecar
  - validation result
```

初翻完成后，UI 显示：

```text
[导入为译文草稿]
[对比并导入]
[打开产物]
[重新生成]
```

导入前必须经过行对行 validator。
导入只更新当前工作台状态，不自动写回最终 TXT。

校对任务产物才是：

```text
proofread report
finding
fix proposal
patch-like suggestion
```

校对建议进入 review HTML / fix proposal review，由用户接受、拒绝或改写。

因此：

```text
初翻 = candidate translation artifact
校对 = finding / fix proposal / patch review
最终输出 = 用户显式导出 / 写入 TXT
```

#### 非目标

* 不把 API Provider 设计成普通的 prompt completion provider；
* 不以“发送一次 prompt、返回一次文本”为主要模型；
* 不要求用户每次重新开始一个无状态 API 调用；
* 不让 API Agent 绕过 Translation Agent Host；
* 不让 API Agent 直接覆盖最终译文 TXT；
* 不把初翻 TXT 强行包装成 patch review；
* 不要求第一版实现完整通用 Agent OS。

如果未来需要普通模型 API 翻译，可以另开低优先级 `Model API Provider`，但它不是本 Issue 的目标。

#### 验收标准

* 用户可以在前端选择 API Agent Provider 执行 translation / proofread job；
* API Agent Provider 可以创建或恢复 Agent session；
* API Agent Provider 可以通过 stream 返回 Agent 消息、任务状态、工具调用和产物事件；
* Host 能记录 API Agent 的 conversation history；
* 关闭并重新打开 Agent Chat 后，仍能看到 API Agent 的历史消息和 job 状态；
* API Agent 生成候选译文后，Host 能发现产物；
* 初翻候选译文必须经过行对行 validator 后才能导入；
* 行数不一致时禁止静默导入，并提供格式修复入口；
* 校对任务可以输出 findings / fix proposals，并进入 review 流程；
* API Agent Provider 和 CLI Agent Provider 使用同一套 AgentJob、AgentEvent、Artifact、ValidationResult 数据模型；
* API Agent Provider 不绕过 Host Runtime、validator、产物发现和导入流程。


---

### Issue 9：新增 Workflow Templates

**Priority：P1**  
**Type：Workflow / UX**

#### 背景

一开始不需要做通用图编辑器。翻译场景可以先提供固定工作流模板。

#### 目标

内置模板：

```text
Initial Translation
  读取原文 → 构建上下文 → 拆分 → 翻译 → 合并 → 校验 → patch

Proofread
  读取原文+译文 → 审校 → findings.json → report.html → patch queue

```

#### 验收标准

- 用户可以从 UI 选择模板创建 job；
- 模板可以复用 provider；
- 模板产物进入统一 artifacts / patch / report 系统；
- 模板参数可保存到项目状态。

---

### Issue 11：把术语表、角色表、风格指南升级为 Agent 可读资产

**Priority：P1**  
**Type：Translation Core / Memory**

#### 背景

Agent 需要稳定上下文，但不能依赖长聊天记忆。术语、角色和风格应成为结构化项目资产。

#### 目标

扩展 `.translation-workshop/`：

```text
glossary.json
character_bible.json
style_guide.md
decisions.jsonl
translation_memory.sqlite
```

#### 验收标准

- Agent job 可以读取这些资产；
- Agent 可以提出 glossary / character_bible 更新建议；
- 人类确认后才写入正式资产；
- 决策记录可追溯；
- 术语和角色信息可用于 validator warning。

---

### Issue 12：新增 revision-based patch conflict handling

**Priority：P1**  
**Type：Data Consistency**

#### 背景

Agent 运行期间，人类可能已经修改同一行。Patch 必须知道自己基于哪个版本生成。

#### 目标

每行维护 revision：

```json
{
  "lineId": 123,
  "text": "当前译文",
  "revision": 17,
  "updatedBy": "human",
  "updatedAt": "..."
}
```

Patch 带 baseRevision：

```json
{
  "lineId": 123,
  "baseRevision": 17,
  "oldText": "旧译文",
  "newText": "新译文"
}
```

#### 验收标准

- 当前 revision 与 patch baseRevision 不一致时提示冲突；
- 用户可以选择保留当前、接受 Agent、手动合并；
- 冲突处理后记录新的 revision；
- 批量接受 patch 时跳过或单独列出冲突项。

---

### Issue 13：拆分 Electron main process，为 Agent Runtime 铺路

**Priority：P2**  
**Type：Refactor**

#### 背景

随着 Agent job、provider、artifact watcher、workflow、patch engine 增加，main process 需要模块化，否则会越来越难维护。

#### 目标

建议拆分：

```text
src/main/
  main.ts
  windows/
    createMainWindow.ts
    createHtmlWindow.ts
  ipc/
    translationHandlers.ts
    agentHandlers.ts
    syncHandlers.ts
  agent/
    jobManager.ts
    jobStore.ts
    artifactWatcher.ts
    providers/
      codexCliProvider.ts
      claudeCliProvider.ts
      apiProvider.ts
  files/
    openers.ts
    backups.ts
    exports.ts
```

#### 验收标准

- main.ts 只保留应用启动和模块组装；
- Agent 相关 IPC 独立；
- provider 逻辑独立；
- 文件读写、导入导出、窗口管理职责清晰分离。

---

### Issue 14：补充 parser / schema / validator / prompt 回归测试

**Priority：P2**  
**Type：Testing**

#### 背景

翻译工作台里很多逻辑依赖格式稳定性。Agent 化之后，schema、patch、validator 更需要测试。

#### 目标

增加测试覆盖：

```text
fixtures/
  txt/
  epub/
  bilingual/
  reports/
  patches/
  prompts/
  validation/
```

重点测试：

- TXT / EPUB 行切分；
- bilingual pair 对齐；
- glossary 解析；
- report JSON；
- Markdown fallback；
- patch schema；
- patch conflict；
- validator；
- prompt / protocol rendering；
- HTML contract。

#### 验收标准

- `npm run test` 不再只是 typecheck；
- 关键 parser 有 fixture；
- patch 和 report schema 有正反例；
- validator 有 blocking error / warning 测试；
- prompt rendering 有 snapshot 或 fixture 测试。

---

## 10. 推荐实施路线

### Phase 0：协议统一

目标：先消除 Codex / Claude 双 skill 维护问题。

包含：

- Issue 1：统一翻译协议；
- 兼容现有 Codex / Claude 使用方式；
- 明确 translate / proofread / report / patch 的 schema 草案。

完成后效果：

```text
一套翻译业务规则
  ↓
Codex adapter / Claude adapter / API adapter
```

### Phase 1：Agent 会话入口 + Job + Patch + Validator

目标：去掉用户可见终端路径，让 Agent 输出进入可追踪、可审阅、可验证的工作流。

包含：

- Issue 2：AgentProvider；
- Issue 3：Agent OS 式聊天入口；
- Issue 4：AgentJob Runtime；
- Issue 5：Patch Review；
- Issue 6：Translation Validator。

完成后效果：

```text
在持久 Agent 会话里创建 job
  ↓
Agent 生成 patch
  ↓
Validator 检查
  ↓
UI 展示 diff
  ↓
人类接受 / 拒绝 / 改写
```

这是整个方向最关键的 MVP。



### Phase 2：API Provider + Workflow Templates

目标：让用户不必只依赖 CLI，也能直接从 UI 调用模型。

包含：

- Issue 8：API Provider；
- Issue 9：Workflow Templates。

完成后效果：

```text
选择 provider / model
  ↓
选择工作流模板
  ↓
运行翻译 / 审校 / 术语检查 / 最终 QA
```

### Phase 3：Subagent Orchestrator + 项目资产

目标：把多 Agent 从 prompt 能力升级为 runtime 能力。

包含：

- Issue 9：Subagent Orchestrator；
- Issue 10：术语表、角色表、风格指南、决策记录；
- Issue 11：revision-based conflict handling。

完成后效果：

```text
章节可以被稳定拆分、并行执行、单独重试、合并、校验。
术语和角色设定成为 Agent 可读、人工可审阅的长期资产。
```

### Phase 4：工程质量整理

目标：降低后续维护成本。

包含：

- Issue 12：拆分 main process；
- Issue 13：补测试。

完成后效果：

```text
Agent Runtime、Provider、Patch、Validator、Parser 都有清晰边界和回归测试。
```

---

## 12. 可能的目录结构

```text
src/shared/agent/
  conversationTypes.ts
  jobTypes.ts
  provider.ts
  events.ts
  artifacts.ts
  workflowTypes.ts

src/shared/protocol/
  translateProtocol.ts
  proofreadProtocol.ts
  patchSchema.ts
  reportSchema.ts
  glossarySchema.ts
  characterBibleSchema.ts

src/shared/validation/
  translationValidator.ts
  patchValidator.ts
  placeholderValidator.ts
  tagValidator.ts
  glossaryValidator.ts

src/main/agent/
  conversationStore.ts
  jobManager.ts
  jobStore.ts
  artifactWatcher.ts
  workflowRunner.ts
  subagentOrchestrator.ts
  providers/
    codexCliProvider.ts
    claudeCliProvider.ts
    apiProvider.ts

src/renderer/agent/
  AgentChatWorkspace.vue
  AgentConversationPanel.vue
  AgentJobCard.vue
  AgentTimelinePanel.vue
  AgentArtifactPanel.vue
  SubjobList.vue

src/renderer/review/
  PatchReviewPanel.vue
  FindingList.vue
  ValidationPanel.vue
```

协议文件可以独立于 provider：

```text
translation-protocol/
  translate.md
  proofread.md
  final-qa.md
  patch.schema.json
  findings.schema.json
  glossary.schema.json
  character-bible.schema.json
```

---

## 13. 数据流示例

### 13.1 初翻

```text
source.txt
  ↓
LinePairModel
  ↓
Initial Translation Job
  ↓
Provider Adapter
  ↓
Agent Output
  ↓
translation_patch.json
  ↓
Validator
  ↓
Patch Review UI
  ↓
Accepted Changes
  ↓
translation.html / output.txt
```

### 13.2 审校

```text
source lines + translation lines
  ↓
Proofread Job
  ↓
findings.json + proofread.md
  ↓
Review Report UI
  ↓
finding → patch
  ↓
Patch Review UI
  ↓
Accepted Fixes
```

### 13.3 术语一致性检查

```text
glossary.json + full translation
  ↓
Terminology Sweep Job
  ↓
terminology_findings.json
  ↓
patch proposals
  ↓
Human Review
  ↓
accepted changes + updated decisions.jsonl
```

---
## 14. 最终方向总结

可以用一句话概括：

> 把 YN Translation Workshop 从“带 Agent 提示词生成和终端交互的本地翻译工具”，升级为“由本地 Host 驱动、provider-agnostic 的人类-Agent 协作翻译工作台”。

关键变化是：

```text
临时 prompt / 终端式流程
  → 持久 Agent 会话 + Host-managed Agent job runtime

用户可见终端流程
  → 可关闭、可恢复历史的 Agent OS 聊天入口 + job / artifact / validation cards

单个 HTML 页面自管状态
  → Translation Agent Host 统一管理项目、会话、任务、产物、校验和导入

模型专用 skill
  → 统一翻译协议 + provider / agent adapter

普通 API 按次调用
  → API Agent Provider 接入可持续的 agent session / agent loop

Markdown-only report
  → schema-backed findings / fix proposals + Markdown report

AI 初翻产物
  → 候选译文 TXT / candidate artifact，由 Host 发现、校验并一键导入工作台

校对与修正建议
  → findings / fix proposals / patch review，由人类接受、拒绝或改写

prompt 级 subagent
  → Host / runtime 级 subagent orchestration

聊天记忆
  → 可恢复的 Agent conversation history + 术语表、角色表、风格指南、翻译决策等项目资产
```

这个方向不会否定现有项目，反而是沿着现有能力自然生长：

* 保留本地优先；
* 保留 HTML 翻译工作台；
* 支持 HTML 双窗口、新窗口或可关闭的 Agent OS 聊天入口；
* 保留 Codex / Claude Code 等作为 provider，但不再让用户必须面对终端式交互；
* 新增 API Agent Provider，使 API 也能进入 agent workflow，而不是只做普通模型 completion；
* 初翻仍然生成独立译文 TXT，不默认覆盖最终译文文件；
* 新增 Host 产物发现、行对行 validator 和一键导入；
* 校对模式继续保留人工审阅流程，并逐步 schema 化为 findings / fix proposals；
* 最终导出或写入绑定 TXT 仍由用户显式触发；
* 新增 Agent job、conversation store、artifact cards、validator、workflow 和 provider adapter。

最终目标不是让 Agent 替代译者，也不是把项目改造成通用 Agent OS，而是让译者拥有一个能调用多个 Agent、管理多个任务、恢复会话历史、校验候选译文、导入 Agent 产物、审阅所有建议，并稳定交付译文的翻译工作台。
