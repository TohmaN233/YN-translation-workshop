# YN Translation Agent Workbench — Handoff

**仓库：** `G:\YN-translation-workshop-agent`  
**分支：** `agent-workbench-evolution`（勿与 `G:\YN-translation-workshop` 主仓混用）  
**RFC：** [`docs/agent-workbench-rfc.md`](./agent-workbench-rfc.md)  
**启动：** `start-workshop.cmd`（会 `npm run build` 后启动 Electron）

**最新功能 commit：** `00d1543` — *Add autonomous agent loop, Pi-style subagents, and checkpoint resume.*

---

## 1. 对照 RFC Issue 完成情况

| Issue | RFC 要求 | 状态 | 实现要点 |
|-------|----------|------|----------|
| **1** 统一翻译协议 | `translation-protocol/` + skill 薄壳 | ✅ 已有 | Phase 0 在分支早期完成 |
| **5** Translation Validator | 确定性 blocking/warning | ✅ 已有 | `src/shared/validation/translationValidator.ts` |
| **§5.4** 产物发现/导入 | 候选 TXT → 校验 → 导入草稿 | ✅ 已有 | `artifactDiscovery`、行审 HTML 侧栏 |
| **2** AgentProvider | 多 provider、OAuth/API | 🟡 大部分 | Codex Responses OAuth、Anthropic、OpenAI-compatible |
| **3** Agent OS Chat | 可停靠/弹窗/持久会话 | 🟡 大部分 | `AgentChatPanel.tsx` + `agentChatEmbed.ts` |
| **4** AgentJob Runtime | job 持久化、事件流、重试 | 🟡 大部分 | 自主 loop、checkpoint 续跑；缺 cancel / 整 job retry UI |
| **6** JSON 审校 | schema + HTML 读 JSON | ⏳ 未接 | schema 在 `translation-protocol/` |
| **7** Subagent Orchestrator | runtime 级、并行、分片校验 | 🟡 大部分 | Pi 式真 subagent；缺 glossary merge、完整 subjob 卡片 |
| **8** API Agent Provider | 可持续 Agent loop | 🟡 部分 | 进程内 loop + host tools |
| **9** Workflow Templates | 模板化工作流 | ⏳ 未做 | — |
| **11** 资产化 glossary/bible | Agent 可读资产 | 🟡 部分 | host tools + skill |
| **12** revision patch conflict | 冲突处理 | ⏳ 未做 | — |
| **13** 拆分 main | 模块化 | 🟡 进行中 | `src/main/agent/` 已拆出 |
| **14** 回归测试 | parser/validator 等 | 🟡 | 17 个 test 文件 |

**Phase 1 MVP 整体：** 可 demo，未达 RFC 全文验收；核心路径「会话 → job → 自主 loop → 写 chunk → validator → 导入草稿」已通。

---

## 2. 本阶段实现摘要

### Provider / Codex（Issue 2、8）

- `src/main/agent/providers/codexResponsesProvider.ts` — Responses API、`store: false`、reasoning SSE
- ChatGPT OAuth（PKCE / import）、默认 `gpt-5.5`、thinking level
- `anthropicMessagesProvider.ts`、Claude OAuth 骨架
- 配置：`.translation-workshop/agent/providers.json`

### Agent Loop（Issue 4、8）

- `agentLoop.ts` — 自主多轮 loop（translate/proofread 最多 40 turns）
- Thinking / token / tool / `skill.loaded` 实时 UI
- `loopContextCompression.ts` — 旧 tool result 压缩
- `hostTools.ts` — 翻译、校对、项目文件、skill、subagent 工具
- `projectPathGuard.ts` — 路径限制在 `outputDir`

### Pi 式 Subagent（Issue 7）

| 能力 | 文件 |
|------|------|
| 隔离 spawn | `subagentSpawner.ts` |
| 并发池（默认 4） | `concurrencyPool.ts` |
| Context firewall（50KB） | `subagentOutputFirewall.ts` |
| single / parallel / chain | `subagentToolModes.ts` |
| 分片校验 + retry | `subagentShardValidation.ts` |
| Orchestrator / Parent 模式 | `subagentOrchestrator.ts` |

- **Orchestrator：** 勾选 subagent → 主机预切行号并行 spawn  
- **Parent：** `subagentMode: "parent"` → 父 agent 自行 `spawnSubagent`

### Checkpoint 续跑

- `jobCheckpointStore.ts` → `.translation-workshop/agent/checkpoints/`
- `sessionUiStore.ts` → `resumableJobId` + **Resume job / Start fresh** UI

### Agent Chat UI（Issue 3）

- Electron：`src/renderer/AgentChatPanel.tsx`
- 行审 HTML：`src/shared/core/agentChatEmbed.ts`（停靠 / `#agent-chat-popout`）

### Skill 混合加载

- `skillLoader.ts` — 摘要进 prompt，`readSkillReference` 按需读全文

### 持久化目录

```text
<outputDir>/.translation-workshop/agent/
  conversations/  jobs/  events/  checkpoints/
  session-ui.json  providers.json  prompt-cache/
```

---

## 3. 已修 Bug（接手前已知）

| 问题 | 修复 |
|------|------|
| 启动崩溃 `HOST_TOOL_NAMES.join` | 循环依赖 → `hostToolNames.ts` |
| HTML 空白无法操作 | `?.hidden = true` 非法 JS；legacy 升级检测 |
| Popout 隐藏正文 | 不再从 localStorage 恢复 popout |
| Codex 400 `Store must be false` | `store: false` |
| Toy tagbroken fixture | 第 4 行去掉 color 标签 |
| `open-toy-example.cmd` | 改 `npm run setup/verify:toy-agent-artifacts` |
| Node 版本 | `engines.node >= 22.6.0` |

---

## 4. 测试与验证

```bash
cd G:\YN-translation-workshop-agent
npm run typecheck
npm run test:unit              # 17 files
npm run verify:toy-agent-artifacts
```

**Toy 项目：** `examples/toy-agent-artifacts/` — 打开该文件夹 → 行审 HTML → Agent 产物侧栏。

---

## 5. 未完成 / 优先接手项

### P0

1. Issue 6：JSON findings → proposal-review 主路径  
2. RFC §4.1 结构化 Job / Validation Card（目前偏 timeline）  
3. Job cancel、整 job Retry  
4. E2E：translate → fail → resume → subagent → proofread append  

### P1

- 分片 glossary/terminology merge（Issue 7）  
- Proofread 并行 findings 全局 renumber  
- Subjob queued/running 状态条  

### P2

- Issue 9 / 11 / 12  
- 继续拆 `main.ts`  
- RFC Issue 6「全部分类按钮无效」  

---

## 6. 关键文件索引

```text
src/main/agent/
  agentLoop.ts              自主 loop
  runProviderJob.ts         job 编排
  subagentSpawner.ts        Pi 式 subagent
  subagentOrchestrator.ts
  hostTools.ts / hostToolNames.ts
  jobCheckpointStore.ts
  providers/codexResponsesProvider.ts

src/shared/core/
  agentChatEmbed.ts         HTML 内 Agent（注意嵌入 JS 语法）
  html.ts

src/renderer/AgentChatPanel.tsx
docs/agent-workbench-rfc.md
```

---

## 7. 设计决策

1. **不是 Pi 全克隆** — 进程内 isolated loop，无 subprocess spawn。  
2. **项目边界 = 整个 `outputDir`**。  
3. **初翻不写最终 TXT** — `writeTranslationChunk` → 人类导入草稿。  
4. **Subagent 是真 spawn**，不是 prompt 假 subagent。  
5. **Agent 功能只在 `-agent` 仓**，主仓无 Agent 面板。

---

## 8. 建议接手步骤

1. `git checkout agent-workbench-evolution && git pull`（若已 push）  
2. `npm run build && npm start` 或 `start-workshop.cmd`  
3. 打开 `examples/toy-agent-artifacts` 走 README Cut 1–3  
4. 配 ChatGPT OAuth → Ping → Run translate  
5. 试 subagent Orchestrator / Parent；故意中断 → **Resume job**
