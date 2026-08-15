# Agent Workbench 真人验收清单

## 当前结论

除真实外部 provider smoke 外，Agent Workbench 路线图的代码实现和本机自动验收已经基本完成。

已通过的自动检查：

```powershell
npm run test
npm run build
npm run verify:toy-agent-artifacts
npm run verify:electron-agent-ipc
npm run verify:electron-agent-ui
```

剩下需要真人验的是：真实账号、真实网络、真实 provider 响应。

## 最后一关验收目标

证明真实 provider 能跑通：

```text
provider validate
  -> translate job
  -> 2 个 subagent
  -> 候选 TXT
  -> validator
  -> 导入为译文草稿
  -> proofread findings_json
  -> retry
```

最低通过标准：任意一个真实 provider 跑通即可。

更严格标准：ChatGPT OAuth、OpenAI API、Anthropic API 都各跑一遍。

## 启动

用提权 PowerShell：

```powershell
cd G:\YN-translation-workshop-agent
npm run build
npm start
```

也可以直接运行：

```powershell
.\start-workshop.cmd
```

打开 toy 项目：

```text
G:\YN-translation-workshop-agent\examples\toy-agent-artifacts
```

## Provider 配置验收

任选一个：

| Provider | 操作 |
|---|---|
| ChatGPT OAuth | 点 OAuth 登录或导入 |
| OpenAI API | 填 OpenAI API key |
| Anthropic API | 填 Anthropic API key |

点击 provider validate / ping。

通过标准：

```text
provider status = ok
没有 401 / 403 / invalid auth
没有 Set an API key or connect OAuth
```

## 翻译验收

选择：

```text
workflow: Initial Translation
subagent: on
subagent count: 2
provider: 刚配置的真实 provider
```

Prompt：

```text
Translate this toy source with subagents. Keep line alignment. Generate a candidate TXT only.
```

通过标准：

```text
job status 是 completed 或 waiting_for_human
至少 2 个 subjob card 完成
artifact card 出现 translation candidate
validation ok
没有 blocking error
可以点击 Import / 导入为译文草稿
不会直接覆盖最终 TXT
```

## 校对验收

选择：

```text
workflow: Proofread 或 Final QA
provider: 同一个真实 provider
```

Prompt：

```text
Proofread the imported toy translation and write findings_json.
```

通过标准：

```text
artifact card 出现 findings_json
Review 按钮可打开 proposal-review
如果有 finding，能看到 proposal card
JSON findings 不需要手工改格式
```

## Retry 验收

最简单做法：

1. 跑 proofread 时取消、断网，或临时填错 key。
2. 让 job 进入 failed。
3. 恢复 key / 网络。
4. 点击 Retry。

通过标准：

```text
failed job card 显示错误原因
Retry 后 job 重新进入 running/completed
conversation/job/artifact 历史不丢
```

## 验收记录模板

```text
真实 provider smoke（YYYY-MM-DD）：
Provider: <ChatGPT OAuth / OpenAI API / Anthropic API>
Model: <model>
结果：通过 / 未通过
已跑通：provider validate -> translate -> 2 subagents -> candidate validation/import -> proofread findings_json -> retry
备注：<如有 429、限流、模型替换、OAuth 刷新问题>
```

## 不需要重复验

下面这些自动验收已经覆盖：

| 功能 | 自动检查 |
|---|---|
| Runtime skill 结构 | `npm run test:skills` |
| Validator / JSON findings / proposal conflict / assets / TM / subagent | `npm run test` |
| Toy artifact discovery/import | `npm run verify:toy-agent-artifacts` |
| Electron IPC 长链路 mock provider | `npm run verify:electron-agent-ipc` |
| Agent UI 输入、dock、artifact/review/subjob | `npm run verify:electron-agent-ui` |
