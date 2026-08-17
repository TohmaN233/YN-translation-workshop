# YN Translation Workshop 2.0

一个把人工逐行编辑、项目资产、完整 AI 翻译、完整 AI 校对和远程操作放进同一工作台的本地翻译工具。

你可以完全关闭 Agent，只使用行对行网页前端手动翻译；也可以让内置 Harness 把整批初翻或校对拆给多个 Worker，并在机械校验、独立复审和完成门全部通过后，再由你逐条确认结果。

[English](README.en.md) · [完整教程与技术手册](https://tohman233.github.io/YN-translation-workshop/) · [下载 2.0.5](https://github.com/TohmaN233/YN-translation-workshop/releases/tag/v2.0.5)

## 2.0.1 – 2.0.5

- 校对/EPUB 以页面手选的译文为准；翻译结束后若 HTML 已绑定 `translated` 且前端未手选，则自动跟上，不再读临时快照。
- 新增 **Grok (OAuth)**，思考等级按模型适配，流空闲等待 3000 秒。OAuth 403 时母代理刷新后重试，工人换人续跑，不中断工作流。
- 翻译三次复审不过会立刻提升已接受 staging。校对 findings 由 Host 按绑定行回填；过校验的先收下；空写入视为通过且不能清空已有发现；关闭术语时不再查候选。
- 一键应用保留「人工修改」；后台术语同步不再刷掉「TXT 已写入」等状态。`resumeYnWorkflow` 必须指定翻译或校对。
- 术语长名覆盖短名，跨文件不一致改为警告；角色 `requiredTerms` 只查可归属台词。

## 2.0 是什么

2.0 的工作流不是一段预填提示词，而是一条由 Pi Agent runtime、YN Host、受限 Function、持久状态、产物校验和完成门共同执行的流程。产品只提供两条完整 Workflow：

1. **初翻**：生成严格行对齐的候选译文，逐片机械校验、独立复审、精确修复，再提升为正式候选。
2. **校对**：先扫描全部对齐行，再以逐片精审或分层抽样方式运行语义校对，输出一份 Findings JSON 和可视化审阅页。

术语一致性、角色口吻、旧译复用、最终 QA 都是这两条 Workflow 内部的能力，不会再伪装成只有提示词、没有 Host 契约的独立工作流。模型、Provider、Agent 会话和并发设置都直接在应用内完成。

## 下载

- Windows 安装版：`translation-workshop-Setup-2.0.5-x64.exe`
- Windows 便携版：`translation-workshop-Portable-2.0.5-x64.exe`
- 校验文件：`SHA256SUMS.txt`

安装版可检查新版本并在下载后重启安装；便携版检测到更新时会打开 Release 页面。

## 完整功能清单

### 1. 项目、输入与文件绑定

- 新建、载入、保存和切换独立项目；项目设置、工作流状态、资产和会话都保存在项目自己的 `.translation-workshop/` 中。
- 最近项目跟随实际打开或保存的项目，不会被文件选择器里的旧路径覆盖。
- 支持单个 TXT、TXT 文件夹、单个 EPUB 和相邻行双语 TXT / EPUB。
- EPUB 会提取成 UTF-8 工作文本；ruby 只保留基文，原始 EPUB 仍作为导出和重打包来源。
- 分离文件模式可分别绑定原文和译文；双语模式可指定奇偶位置分别作为原文与译文。
- 文件夹模式自动匹配源文与译文，并维护一个权威批次索引。
- 文件顺序支持阶段屏障。例如 `A, {B, C}, D` 会先完成 A，再并行处理 B/C，最后处理 D。
- 翻译输出和校对报告默认绑定当前项目的 `AI_translation/` 与 `report/`，切换项目时不会沿用上一个项目的路径。
- 一个统一的分片大小同时用于初翻与校对；并发 Worker 数和独立复审 Worker 数分别设置为上限，实际数量会随任务量缩减。
- 自定义保留规则可保护变量、事件码、标签、控制码和其他不可改载荷；无效正则会直接报错。
- 支持中英文界面、HTML 主题、项目级 Agent 代理开关和持久项目设置。

### 2. 行对行翻译与审阅前端

- 不启用 Agent 也能完成从读取、逐行编辑、搜索到写回的人工翻译流程。
- 单文件页和文件夹总览页；文件夹子页面、sidecar 与批次索引使用同一身份绑定。
- 原文与译文逐行对齐显示，支持直接编辑译文、保存人工编辑状态和刷新磁盘候选。
- 分页、页码跳转、全文搜索、滚动位置恢复、最近焦点行定位和文件标签切换。
- 按问题严重度标记行、显示高亮、清除问题、管理只读机械证据与可忽略项。
- 从选中行向 Agent 询问有界上下文，不需要把整份文件塞进对话。
- 校对建议默认可执行；可逐条接受、拒绝或手动改写完整替换文本。
- 一键应用已接受建议，并把批次内全部 canonical 子页面同步到当前译文。
- 可导出 TXT，也可写回已绑定译文；写回前检查路径绑定、基线、sidecar、行数和冲突。
- 写回和覆盖前创建时间戳备份；原文文件始终只读。
- 旧版 HTML 打开时按明确版本标记自动升级到当前协议，不要求重新生成全部页面。

### 3. 术语、角色、文风与翻译记忆

- **正式术语表**：项目内部的权威 canonical glossary。选择外部 glossary 后，工作流会同时保留 canonical 中不冲突的正式词；导入已接受候选时先合并现有 canonical、外部 glossary 与候选，冲突则整次拒绝，成功后再把项目绑定切到 canonical。
- **候选术语**：Worker 只能在自己负责的证据行中上报新专名、译名和别名，不直接修改共享资产。
- **角色表**：保存姓名、性别、代词、称呼、关系和口吻等可复用事实。
- **文风指南**：保存作品级语气、表达偏好和格式约束。
- **翻译记忆**：检索项目中已经接受的原译文对齐片段。
- 支持 JSON、Tab、`=>`、`->`、`=` 和逗号分隔术语输入。
- 行对行页面可编辑术语、搜索并替换译文中的命中项、导入候选条目。
- 每个 assignment 只注入当前原文直接命中的完整结构化记录；缺失歧义才做单词精确搜索。
- 关闭候选收集只禁止新增候选，已有候选仍可作为只读参考。
- 同一原词出现竞争译名时会关闭新任务领取门；Parent 决定后，Host 全量重扫当前清单并优先修复全部受影响行。
- glossary candidate、角色事实、DomainRun 状态和 Host 持久化在同一事务边界提交或回滚。

### 4. 模型、Provider 与 Agent 会话

- 支持 ChatGPT、Claude、Grok OAuth，以及 OpenAI-compatible API、API key 和显式模型目录。
- Provider、OAuth profile、当前模型和默认 thinking level 是用户级配置，可跨项目使用。
- Agent 网络代理默认关闭；只有当前项目明确启用时才会使用项目代理地址。
- 会话列表、创建与切换会话、独立弹出 Agent 窗口、流式输出和 Markdown 展示。
- thinking、Function 调用和 subagent 以结构化对话 block 展示，不把内部协议文本混进普通回复。
- 支持图片输入时，根据当前模型目录声明决定是否开放附件。
- 显示输入、输出、缓存 token 和估算成本；支持 `/compact`、复制、Provider 设置、新建会话等产品内命令。
- 工作进行中可发送 Steer，当前工作结束后可排队 Follow-up；Stop 会终止活动 runtime 和 Worker pool。
- Parent 与 Child 使用同一套 Pi Agent runtime、`AgentMessage[]` 和 Pi JSONL 会话。
- 长会话使用 Pi 原生 compaction；完整 Child 对话留在自己的 JSONL，Parent 只保存轻量状态和会话引用。

### 5. 完整初翻 Workflow

- Parent 读取当前界面绑定和 Host 状态，选择不超过项目上限的实际并发数，并负责最终汇总。
- Host 根据权威 manifest、文件阶段、统一分片大小、旧译复用掩码和现有证据规划真实债务；模型不能自创文件或行范围。
- 翻译池使用持久 Worker 动态领取互不重叠的 assignment，完成一块后再领下一块，避免每个文件私有队列造成长尾。
- assignment 只获得自己的写权限；理解对话、代词或场景时可读取短邻近上下文，但不会扩大写入范围。
- 译文先写入 Host 管理的 staging，成功写入后立刻持久化路径、hash 和待审状态。
- 强制检查行数、空行、placeholder、标签、控制码、自定义保留规则和精确行身份。
- 独立只读复审池检查全部机械风险行和稳定抽样的普通行；普通行样本随分块大小增长。
- 复审只返回具体失败行与短修改要求，通过行不会逐行生成理由或报告。
- 失败回到写出该块的同一翻译 Worker 做有界精确修复，不重启整块翻译。
- 无进展或修复耗尽时，把 hash-current staging 和精确失败行交给 Parent 接管，保留其他有效行和既有证据。
- 术语冲突进入同一批次的 priority repair wave；修复清零前不会越过优先队列继续普通任务。
- 全部 assignment 结束后运行一次全文机械校验；未被既有证据覆盖的 warning 再由 Parent 做配对语义检查。
- 只有真阳性 warning 会成为精确修复债务；假阳性保存为 hash-bound evidence，避免重复花费 token。
- Stop、崩溃或重启后可从持久 staging、ownership、evidence 和 Pi session 继续。

### 6. 旧译审计与选择性复用

- 默认关闭复用：完整初翻首次写入前对旧候选做 SHA-256 备份并清空一次，保证干净重翻。
- 开启后先对全部对齐行做机械快筛；行数、空行、placeholder、标签和明显占位文本错误直接进入重译。
- 非目标语言、原文复制、异常长度、重复译文、AI 污染和术语/角色/文风命中只是风险证据，不会自动判死刑。
- 无风险的目标语言对齐行自动复用；只有高风险稀疏行进入只读语义审计。
- 审计只返回 `reuse` 或 `retranslate`，成功提交后不再调用模型复述计数。
- 用户对整批只做一次选择；Host 事务性保留可复用行并清空重译行。
- 后续翻译队列只包含真实重译债务，不会为了连续覆盖把保留行再次交给模型。
- 冷启动按 owner、document、source hash 和保留基线恢复，不会把本轮刚写出的候选误当成启动前旧译。

### 7. 完整校对 Workflow

- 任何语义 Worker 启动前，Host 对清单内所有文档和全部对齐行运行 H3/H4/H7/H8/H9 等确定性扫描。
- 扫描结果绑定 source、candidate、glossary、character bible 和 style hash；输入变化会使旧证据失效。
- 确定性信号只是供 Worker 结合原文、译文和邻近上下文判断的证据，不会直接变成 finding。
- **逐片精审**：Worker 语义检查自己范围内的每一行；分片大小只决定派发和保存边界。
- **Monte Carlo**：Host 规划不重复的 HOT / WARM / COLD 分层样本，并记录真实覆盖。
- 达到最低轮数后，只有连续两轮无新增才算收敛；轮数上限仍有新增时由用户选择继续三轮、只精审 HOT 区域或按当前结果停止。
- 校对 Worker 只读原文、译文和项目资产，只能提交带证据的结构化 findings 与专名候选。
- 文件夹模式先预扫描全部文件，再把所有文档放进同一个跨文件 staged assignment 队列。
- findings 按 scope 原子替换和去重，必须包含全局行号、问题类型、证据和完整可替换建议。
- 无变化修正、越界行、普通目标语言标点差异和格式不合格的提交会被拒绝。
- 单文件和文件夹都只持久化一份 findings JSON；人类审阅 HTML 由产品从该 JSON 生成。

### 8. Harness、Host 与可靠性

- **Runtime** 负责模型调用、Function call、继续执行、Steer / Follow-up 队列、provider retry 和 compaction。
- **Harness** 把 runtime、系统提示、Function 集、持久状态和完成条件组装成可持续执行的 Agent 环境。
- **Host** 负责 manifest、assignment、阶段、写入 ownership、文件锁、hash、validator、事务与 completion gate。
- 通用调查、局部修复、完整初翻和完整校对分别拥有不同 typed operation scope。
- 完整批次在创建 Worker 前原子预留；重复活动批次会在模型 runtime 创建前被拒绝。
- Parent 和 Child 可以按需读取参考，但只有 Host 授予的 document / range / exact lines 能写产物。
- staging 提升、domain revision、alignment evidence 与 Host JSONL 持久化是一个可回滚提交边界。
- Function 失败会回到同一个 Pi turn，或形成明确的 Parent repair / resume 状态，不会静默吞错或伪装完成。
- 完成不是模型说“完成了”，而是 Host 确认所有任务、修复债务、证据、产物和最终校验都结清。
- 关键阶段、Worker、assignment、provider 错误、staging 与 hash 都有持久记录，便于停止、恢复和排查。

#### 为什么更稳定

- 模型只做语义工作，文件身份、范围、并发写入和完成判断由确定性 Host 管理。
- 候选先进入 staging，不会把半成品直接覆盖到 canonical artifact。
- 翻译 Worker 与独立复审 Worker 分离，失败精确回到原 Worker；无进展会停止盲重试。
- 所有恢复依据都绑定当前文件内容 hash；过期授权和过期证据不能继续生效。
- 关键共享资产更新和产物提升使用事务，任一步失败都会回滚到可恢复状态。

#### 为什么节约 token

- Host 自己规划分片和风险扫描，不让模型全文重读后再决定做什么。
- assignment 只注入直接命中的术语、角色和短邻近上下文；缺什么再精确搜索什么。
- 机械快筛、placeholder 检查、行数检查和确定性校对信号不占模型推理。
- 独立复审只返回失败行，通过行不生成逐行解释。
- Parent 不嵌入 Child 全对话，只读取轻量状态和结构化 discoveries。
- 旧译复用只把高风险稀疏行送入语义审计，保留行不会重新翻译。
- hash-bound 通过证据和 warning 假阳性证据可复用，修改一行不会让整份文件全部重审。

### 9. 网页与本地参考资料

- Agent 可读取用户明确提供的 HTTP(S) 页面并缓存可读正文。
- Wikipedia 通过 MediaWiki API 提取正文；普通网页提取主要可读内容。
- 缓存参考可供 Parent 与 Child 复用，不需要每个 assignment 重新下载。
- 可只读访问用户明确提供的项目外绝对路径、旧译文和备份译文。
- 所有产物写入仍受项目边界、文档身份和行 ownership 约束。

### 10. 局域网与远程操作

- 在桌面应用中打开工作 HTML 后启动 LAN 同步，并设置 6 位 PIN。
- 手机、平板或另一台电脑可打开文件夹总览和单文件页。
- 远程端可搜索、翻页、编辑译文、接受或拒绝建议、同步页面并使用 Agent 面板。
- 远程 Prompt、Steer 和 Follow-up 使用桌面端同一持久 Pi session，不会另建一份远程 transcript。
- SSE 只负责低延迟增量显示；断线或代理缓冲后，浏览器会从 canonical Pi messages 收敛到最终状态。
- 桌面应用必须保持运行；LAN 只共享当前工作会话，不开放任意目录浏览。
- 产品不内置公网隧道。需要外网访问时，可把 Cloudflare Tunnel、ngrok 等工具指向页面显示的本地地址。
- 公网地址等于暴露工作台入口。请使用不可猜测的 PIN，不要公开 URL，结束后关闭隧道和 LAN 同步。

### 11. 更新、恢复与兼容

- 安装版支持 GitHub Release 更新检查、下载和重启安装；便携版跳转到 Release 下载。
- 旧行对行 HTML、旧 proposal HTML 和旧项目字段有明确的升级与迁移路径。
- 旧分片设置只在迁移时读取一次，之后统一写入当前 canonical 设置。
- Stop 会终止活动 runtime，但保留 hash-current staging、校对证据和未完成债务。
- 显式继续会在同一个 Pi session 与 Host batch 中恢复，不另起一批假装重跑。
- Provider 传输错误保留脱敏 cause、provider、model、session 和重试记录，便于定位真实失败。

## Agent Function 索引

普通用户不需要手动调用这些 Function。它们是 Harness 交给 Parent 和 Child 的受限操作面；同名只读函数在两个角色中分别暴露，所以共有 **52 个唯一名称、55 个可调用面**。参数、读取内容、写入目标、拒绝条件和下一步见[技术手册 Function Registry](https://tohman233.github.io/YN-translation-workshop/functions.html)。

<details>
<summary><strong>Parent Functions（38）</strong></summary>

| 类别 | Functions |
| --- | --- |
| 工作流控制 | `resumeYnWorkflow` |
| 共享资产 | `readTranslationDiscoveries`, `resolveTranslationDiscoveries` |
| 当前界面 | `readYnInterfaceContext` |
| 局部校对 | `inspectProofreadRange`, `recordProofreadParentReview` |
| 网页参考 | `fetchWebReference` |
| 项目上下文 | `inspectTranslationContext`, `selectSourceDocument` |
| 旧译复用 | `prepareTranslationReuseAudit`, `readTranslationReuseAudit`, `recordTranslationReuseAudit`, `runTranslationReuseAudit`, `applyTranslationReuseDecision` |
| 模型与 Child | `listAvailableModels`, `inspectSubagents`, `steerSubagent` |
| 文件与检索 | `readSourceLines`, `readTranslationLines`, `readProjectFile`, `listProjectDir`, `searchProjectText`, `searchTranslationMemory` |
| warning 与对齐 | `readTranslationAlignmentRows`, `inspectTranslationWarnings`, `recordTranslationWarningChecks`, `inspectTranslationAlignment`, `recordTranslationAlignmentChecks` |
| 翻译产物 | `writeProjectFile`, `writeTranslationChunk`, `validateTranslationArtifact` |
| 校对产物 | `writeProofreadFindings`, `resolveProofreadGlossaryCandidates`, `finalizeProofreadReport`, `resolveProofreadMontecarloLimit` |
| 调度 | `runProofreadSubagents`, `runSubagents`, `runTranslationSubagents` |

</details>

<details>
<summary><strong>Child Functions（17）</strong></summary>

| 角色 | Functions |
| --- | --- |
| 通用只读 | `listProjectDir`, `searchProjectText`, `readProjectFile` |
| 翻译 Worker | `readTranslationContext`, `readAssignedSource`, `writeAssignedTranslation`, `repairAssignedTranslation`, `validateAssignedTranslation` |
| 校对 Worker | `readAssignedProofreadContext`, `readProofreadReference`, `writeAssignedFindings` |
| 局部委派 | `readBoundSourceLines`, `readBoundTranslationLines` |
| 独立翻译复审 | `readAssignedTranslationReview`, `submitTranslationReview` |
| 旧译语义审计 | `readAssignedTranslationAudit`, `submitTranslationAudit` |

</details>

## 一次完整使用流程

```mermaid
flowchart LR
  A[新建项目并绑定原文] --> B[生成行对行 HTML]
  B --> C[配置 Provider 和模型]
  C --> D[运行初翻 Workflow]
  D --> E[刷新并人工抽查候选]
  E --> F[运行校对 Workflow]
  F --> G[生成审阅 HTML]
  G --> H[接受 拒绝或手改建议]
  H --> I[安全写回或导出 TXT]
```

第一次使用建议先处理 50 到 200 行，确认编码、行对齐、语言方向、术语、控制码和写回路径，再运行完整项目。具体参数怎么填、每个按钮怎么用、如何远程访问，请直接阅读[普通用户教程](https://tohman233.github.io/YN-translation-workshop/guides.html)。

## 产物与数据位置

| 类型 | 内容 |
| --- | --- |
| 行对行工作页 | 单文件 HTML，或文件夹 index + canonical child HTML + sidecar |
| 候选译文 | 与原文严格行对齐的 TXT 和 Host staging artifact |
| 校对结果 | 唯一 Findings JSON，以及由它生成的逐条审阅 HTML |
| 项目资产 | 正式术语表、候选术语、角色表、文风指南、翻译记忆 |
| 运行状态 | Host batch、assignment、证据、恢复债务和 Pi JSONL sessions |
| 备份 | 写回、清空旧译或覆盖资产前生成的时间戳备份 |

源文件永远只读。候选译文、HTML 页面状态和真实译文文件分开保存；不满足绑定、基线、行数或校验契约时，写回会明确失败。

## 开发与验证

要求 Node.js `>=22.6.0`。

```bash
npm ci
npm run dev
```

```bash
npm run typecheck
npm test
npm run build
npm run verify:electron-agent-html
npm run verify:electron-lan-agent
```

Windows 发布包：

```bash
npm run package:win
npm run verify:release
```

运行时翻译协议和 JSON schema 位于 `translation-protocol/`；产品通过内置系统提示、Host Functions、validator 和 completion gate 执行它们。

## 隐私与安全

- Provider credential 保存在 Electron 用户数据目录，不进入项目仓库。
- 翻译资产、Agent 会话、Host 状态和备份按项目隔离。
- 项目代理默认关闭，进程环境中的代理变量不会静默开启 Agent 网络代理。
- LAN 访问者持有 PIN 后可以操作当前共享会话，请只在可信网络或受控隧道中使用。
- 仓库不跟踪本机 Agent 指令、运行记忆、私有测试路径、编辑导出稿或个人教程源文件。

## License

[MIT](LICENSE)

感谢 OpenAI Codex 以及所有参与测试、翻译和反馈的人。
