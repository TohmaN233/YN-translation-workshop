# YN 升级 Pi 的改动与收益评估

> 历史评估，记录 2026 年 9 月 29 日迁移前的状态，不是当前待办。迁移已在 `fbf65fb` 完成，Pi 两包现固定为 0.99.1，随后纳入本地 2.1.3 打包。实现、验证和回滚限制见[迁移报告](pi-core-migration-2026-09-30.md)。

核对日期：2026 年 9 月 29 日。当时 YN 源码与 GitHub 最新发布均为 **2.1.2**，两个 Pi 依赖精确固定在 **0.80.6**。当时 Pi 官方 GitHub 与 npm 均为 **0.99.1**。本次历史评估未更换生产依赖。

建议在独立分支成对迁移两个包。最值得取得的是 Provider 协议修复、流处理性能和会话持久化能力；升级本身不保证翻译质量、速度或费用改善。YN 已经定期刷新官方模型目录，所以“新增模型名称”不是必须升级整个运行时的充分理由。

## 已验证的兼容性证据

下载官方 npm 0.99.1 包到 `artifacts/pi-upgrade-audit/0.99.1/`，通过独立 tsconfig 的 `paths` 将 YN 的 Pi imports 指向新版声明。工作区 `node_modules`、生产依赖及 lockfile 保持原样。

这次检查产生 **63 条诊断，涉及 8 个源码文件**。其中有旧接口消失引起的连带类型错误；这不是 63 个独立缺陷，也不是完整迁移工作量。检查沿用项目的 `skipLibCheck`，没有安装新版新增的全部传递依赖，也没有运行新版模型或会话。运行时与 JSONL 兼容性仍需后续迁移验收。

| 文件 | 诊断数 | 已确认的主要变化 |
| --- | ---: | --- |
| `sessionAgentRuntime.ts` | 23 | 旧 Session 写入、上下文构建和压缩 API 消失；systemPrompt 只读 |
| `sessionRepository.ts` | 15 | Repo 参数、Context、父子身份及时间字段变化 |
| `subagentRunner.ts` | 14 | 多处使用旧的 `session.buildContext()` |
| `sessionService.ts` | 6 | metadata 和上下文读写接口变化 |
| `proofreadSessionState.ts` | 2 | 旧 branch 和 custom entry 写入接口变化 |
| `providerRegistry.ts` | 1 | `refreshModels()` 现在需要参数 |
| `subagentSupervisor.ts` | 1 | 旧上下文构建接口变化 |
| `piSessionContract.ts` | 1 | `AgentHarnessEvent` 改为新版事件契约 |

完整诊断保存在 `artifacts/pi-upgrade-audit/0.99.1/typecheck.log`，可用 `node_modules/.bin/tsc -p artifacts/pi-upgrade-audit/0.99.1/tsconfig.json --pretty false` 重现。

## 必须修改的路径

### 会话存储与恢复

0.84 起 core 使用 format 4 的 Session。最新 `JsonlSessionRepo` 构造参数为 `fileSystem`，操作需要显式 `Context`；Session 的读写改经 branch 和 mutation。YN 的父子归属检查目前比较 `parentSessionPath`，需要适配 `parentSessionId`；会话时间需要转换到 YN 的 UI contract。[官方 Session 类型](https://github.com/earendil-works/pi/blob/v0.99.1/packages/agent/src/harness/session/jsonl/types.ts)

新版提供 legacy v3 转换路径，应验证并使用官方转换，保留原文件备份，不另造 YN 会话格式。除了类型报错处，YN 的 `firstUserMessage()`、旧 child 消息瘦身迁移、`monitor-pi-live-session.mjs` 和 `analyze-pi-session-growth.mjs` 都直接按旧 JSONL 行形状解析，需要改为官方会话查询或经过验证的格式读取。

验收必须覆盖旧父子会话、父级 ownership、会话标题、删除关联子会话、active-session 指针、Stop 后恢复以及重复冷启动。新 lane 能力不意味着应把子会话全文塞进父会话或放宽 child 读取权限。

### 上下文与压缩

YN 现在直接调用 `Session.buildContext()`、`appendMessage()`、`appendCustomEntry()`、`appendCompaction()`。新版将上下文构建与 branch 查询分开，压缩结果改为保存 `retainedTail`，`compact()` 返回 Result 并需要 retry、callbacks、Context。必须迁移成功与失败分支，不能用类型断言掩盖差异。[官方 core 变更记录](https://github.com/earendil-works/pi/blob/v0.99.1/packages/agent/CHANGELOG.md)

尤其要保留持久 child 的 assignment reset 边界：完整历史继续用于审计，但压缩只能看到当前 active context。现有内存引用生命周期修复必须继续通过连续多分块和 GC 后留存测试；新版 Session 不会自动替 YN 修复数据对象引用问题。

### 系统消息与调度

0.86 的 Provider 输入使用 `TranscriptContext`，系统提示和工具声明进入 transcript 的 system messages。`reconfigure()` 不能再赋值 `agent.state.systemPrompt`，应使用官方 transcript 机制。审核 `convertToLlm`、custom-entry 投影、token 估算及 renderer，确保系统消息正确传给 Provider，同时不把内部提示显示给用户。[官方 0.86 发布说明](https://github.com/earendil-works/pi/releases/tag/v0.86.0)

0.87 添加 `prepareRequest`、`finishTurn` 和队列预览。YN 当前没有使用被删除的 `shouldStopAfterTurn`，因此不存在简单重命名任务；接入新 hook 时仍要验证 Steer/Follow-up 顺序、错误硬退出、工具成功 terminate、settling 竞态和 child 完成后的 parent 报告。不要同时引入另一套排队状态机。[官方 0.87 发布说明](https://github.com/earendil-works/pi/releases/tag/v0.87.0)

### Provider 与登录

需要更新 `refreshModels` 调用，检查 Provider 的代理、认证刷新和模型列表包装。官方 xAI 新版本改用 Responses API；YN 的 Grok OAuth 与 API key 入口都要验证 URL、加密推理回放及当前模型的 effort 档位。

0.99 增加新的 OpenAI ChatGPT 登录，旧 Codex Provider 仍存在，但已标为 legacy。YN 目前走 `openai-codex` 和独立 OAuth profile；可以先保留并验收旧入口，再单独迁移新的登录流程、持久 deviceId 和凭证配置，不能直接把现有 token 改成新 Provider 使用。[官方 AI 变更记录](https://github.com/earendil-works/pi/blob/v0.99.1/packages/ai/CHANGELOG.md)

### 打包与模型目录

两个 npm 包声明 Node 最低版本为 22.19.0，YN 的 engines 目前是 22.6.0，应同步最低要求并核对 Electron 内置 Node。新增 Chord 和 telemetry 依赖需要进入 lockfile 和打包验收；无需仅因上游构建使用 TypeScript 7 就升级 YN 的编译器。

0.99 模型目录加入 chat、image、classifier 类型。YN 的远端刷新和模型选择器要继续只接受可运行的 chat 模型及已安装 adapter，不能把图片或分类模型当成翻译模型。既有 chat-only 目录仍有兼容入口，先保持这个读取范围最小。[官方 AI 变更记录](https://github.com/earendil-works/pi/blob/v0.99.1/packages/ai/CHANGELOG.md)

## 对 YN 的收益

下表的上游能力来自官方版本记录；对 YN 的影响是结合本地路径的推断，需通过实际迁移验收确认。

| 能力 | 对 YN 的预期价值 | 是否自动取得 |
| --- | --- | --- |
| Provider 工具调用、推理回放及错误分类修复 | 降低工具错配、回放失败和错误重试的概率 | 完成适配后可继承；真实 Provider 需验收 |
| EventStream 移除缓冲事件排空的二次复杂度 | 对长回答和密集工具事件有性能价值 | 可继承；没有 YN 实测加速数字 |
| v4 Session 原子提交及结构化操作记录 | 为崩溃恢复与诊断提供更清晰的事实依据 | 必须迁移 YN 的读写及恢复逻辑 |
| `onProviderStreamEvent` | 可记录标准化之前的原始事件，帮助定位“fetch failed”或未完成工具流 | 需要接入脱敏的 durable 诊断，避免进入模型上下文 |
| assistant 的 thinkingLevel 及更新的计费元数据 | 更准确地追溯实际请求档位、缓存和费用 | 需要同步 YN telemetry；不等于自动降低花费 |
| 新登录、新模型与更新的 effort 元数据 | 改善 Provider 支持；模型名称一部分已经能远端刷新 | 登录需要产品接入；不能只靠目录替换 adapter |
| 图片生成、分类器、虚拟模型 | 将来可用于图文资料或专门分类任务 | 可选产品开发；本次升级没有必要一并启用 |

Provider、性能与诊断能力见[官方 AI 变更记录](https://github.com/earendil-works/pi/blob/v0.99.1/packages/ai/CHANGELOG.md)；新会话及事件能力见[官方 core 变更记录](https://github.com/earendil-works/pi/blob/v0.99.1/packages/agent/CHANGELOG.md)。Pi CLI 的主题、终端交互、扩展管理和内置 MCP 不会自动成为 YN 功能；YN 的翻译/校对 Host contract 和双 worker pool 仍由本项目负责。

## 建议实施顺序

1. 建独立升级分支，以当前两个包成对固定为基线；备份真实 v3 父子 Session，准备可回滚迁移样本。
2. 迁移 Repo、branch、Context、压缩及系统消息，把上述类型诊断清零；更新 JSONL 直读脚本与原生事件 contract。
3. 验证翻译和审阅双池、精确修复、Stop/Resume、持久 child reset、术语事务及冷恢复；旧会话首次迁移与重复打开都必须通过。
4. 验证 ChatGPT、Grok 和实际使用的其他 Provider，以及 LAN 终态收敛；检查流事件、窗口响应、GC 后内存与 JSONL/child 卡片大小。
5. 成对精确固定通过验证的 Pi 版本，更新 AGENTS 和 runtime memory，再做 Windows 打包验收。新登录及图片/分类能力作为独立后续工作。

不建议将 0.99.1 直接换进现有 2.1.2，也不建议长期只升级 pi-ai 而保留旧 core。中间版本能分阶段验证迁移，但不应发布未经完整回归的过渡状态。
