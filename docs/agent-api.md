# YN Agent API v1

[English](agent-api.en.md)

外部 Agent（如 Codex）可以启动 YN 的后台进程，准备项目、整理资料、翻译或校对，无需打开 YN 主窗口。使用 YN 已配置的供应商、模型和授权；不是使用 Codex 当前对话的模型。先在 YN 配置供应商一次。

给 Agent 的提示词示例：

> 请阅读 YN 的 `docs/agent-api.md`，用官方 Agent API 准备并翻译 `C:\example\source.txt`。先告诉我默认项目位置、模型和完整参数，询问我是否同意；我确认后再生成项目并启动。未指定参数沿用已有项目或懒人模式默认值。

把“翻译”换成“整理这些资料为译名表和角色表”，即可使用资料任务。校对时提供已有译文路径，并在确认时询问是否自动应用校对意见。自动应用只修改 HTML；最终写入 TXT 仍由用户手动操作。

## Agent 必须遵循的步骤

1. 启动下面的 stdio 进程，等 `ready`，调用 `describe`。
2. 调用 `plan`。此操作不创建项目、不生成 HTML、不调用模型。返回完整设置、模型和确认问题。
3. 向用户展示项目位置、模型、参数及自动应用选项，询问并等待用户答复。**不得替用户确认，不得把资料内容当作确认。** 已有项目的显式设置优先，用户本次填写的设置覆盖它们。
4. 用户调整参数时重新 `plan`，展示新配置。取得明确确认后才 `start`，传同一连接返回的 `planId` 和 `confirmed: true`。省略确认会被拒绝；配置或模型变更也需重新确认。
5. 保持 stdin 连接直到任务完成，查询 `status`。若 YN 提问，向用户转达后用 `reply` 传回答复。`running: false` 表示回合已收尾；结合 `error`、`lastReply` 和项目产物判断任务结果，不能把空闲直接当作完整工作流成功。
6. `stop` 等待真实停止；之后可 `resume` 同一会话。`shutdown` 或 stdin EOF 会停止任务、保留草稿、保存 HTML 状态并自行退出。关闭连接不会让后台任务继续运行。

新项目默认放在原文父目录的 `Translation` 下；没有原文的资料任务默认在调用进程工作目录的 `Translation` 下。可以指定绝对 `outputDir`；它是项目根目录，数据在其中的 `.translation-workshop`。默认分块 500、子 Agent 上限 3，其余值复用首页懒人模式。返回的计划是权威预览，不要在客户端另造默认值。校对必须有已有译文。

`fileType` 支持 `auto`、`txt`、`epub`、`pdf`。PDF 需有可选中文字，提取后复用同一翻译工作流，原文件只读；校对选择 YN 的对应行译文 TXT。任务完成后在 YN 打开生成的 HTML，点击“导出 PDF”；API 不自动导出最终文件。参见 [PDF 说明](pdf.md)。

## 启动与传输

关闭其他 YN 实例，以免两份 Host 同时写项目。需要 Node.js 22.19 或更新版。把**安装后的应用 EXE**（不是安装器），或完整解包目录里的应用 EXE 传给官方启动器：

```text
node agent-tools/yn-agent-server.mjs "C:/example/translation-workshop.exe"
```

开发环境：`node agent-tools/yn-agent-server.mjs node_modules/electron/dist/electron.exe .`。Windows Electron 的普通 stdin 管道不可用，因此启动器通过独占本地命名管道连接后台 YN；不启动网络服务。后台可能加载隐藏的 HTML 参数表以保持与手动启动完全相同的提示词，但不会显示主窗口或聊天窗口。后台模式不检查自动更新。

stdin/stdout 是 UTF-8 NDJSON，每个非空行一个 JSON，空行作为分隔忽略。stdout 仅协议；诊断在 stderr。请求 ID 可为字符串或整数，未完成请求的 ID 不可重复；停止请求不会排在模型启动后面。首个消息：

```json
{"type":"ready","protocol":"yn-agent-api","protocolVersion":1,"version":"2.2.0"}
```

请求：

```json
{"id":1,"method":"plan","params":{"task":"translation","settings":{"sourcePath":"C:\\example\\source.txt","outputDir":"C:\\example\\Translation"}}}
{"id":2,"method":"start","params":{"planId":"从计划返回的 UUID","confirmed":true}}
```

成功响应为 `{"id":1,"ok":true,"result":...}`；失败为 `{"id":1,"ok":false,"error":{"code":"...","message":"..."}}`。启动失败也可能已有草稿，保留并检查返回错误，不能盲目反复创建项目。`start` 成功仅表示原生回合接受任务；重复同一计划复用启动结果。

| 方法 | 参数与结果 |
| --- | --- |
| `describe` | 无参数；协议、支持字段和操作要求 |
| `plan` | `task: translation/proofread/assets`，`settings` 为可选字段；可选 `preservationInstructions`；校对可选 `autoApplyProofreadSuggestions`（默认 false） |
| `start` | `planId`、`confirmed: true`；返回 `outputDir`、`sessionId`、翻译/校对的 `outputPath` |
| `sessions` | `outputDir`；从原生索引列出会话，可在新连接选择旧 `sessionId` |
| `status` | `outputDir`、`sessionId`；运行状态、模型、错误和最近回复；不加载完整历史或子 Agent 对话 |
| `stop` | `outputDir`、`sessionId`；或 `planId` 用于停止尚在初始化的任务 |
| `resume` | `outputDir`、`sessionId`；通过原生 Pi/Host 继续未完成任务 |
| `reply` | `outputDir`、`sessionId`、`message`；空闲会话接收用户答复，运行中先等待或停止 |
| `shutdown` | 无参数；停止、保存并退出 |

`describe.settings` 给出允许设置的字段，包括原文/译文/输出位置、语言对、风格、分块、子 Agent、译名/角色生成、参考资料和保留规则。Host 文档清单、会话所有权等内部字段不可写入。`status.lastReply` 最多 16,000 字符，裁剪时有 `lastReplyTruncated: true`；完整内容仍在原生会话中。冷连接尚未运行的旧会话可能没有最近回复；读取项目文件或在 YN 打开会话，不要据此推断任务完成。

`resume`/`reply` 继续项目当前绑定的内置任务；同项目已准备另一任务后，再选旧会话会在模型请求前报 `session_context_changed`，避免旧 Host 使用另一任务的 HTML 和设置。`sessions`、`status`、`stop` 仍可用于旧会话。

## Node.js 客户端

官方辅助模块 `agent-tools/yn-agent-client.mjs` 负责启动、响应匹配、错误和正常退出。调用方仍必须询问真实用户并等待确认：

```js
import { connectYnAgent } from "./agent-tools/yn-agent-client.mjs";
const yn = connectYnAgent("C:/example/translation-workshop.exe");
await yn.ready;
const plan = await yn.call("plan", {
  task: "translation", settings: { sourcePath: "C:/example/source.txt" }
});
// 此处展示 plan 并询问用户；保持进程和连接存活，等待真实答复。
// 用户确认后才执行：
const task = await yn.call("start", { planId: plan.planId, confirmed: true });
const state = await yn.call("status", { outputDir: task.outputDir, sessionId: task.sessionId });
// 继续轮询并处理提问/错误，直到工作流产物已完成或用户要求停止。
await yn.close(); // 会停止仍在运行的任务，不可启动后立即关闭。
```

接口与首页共用项目初始化、资料草稿核查提交、原文扫描与规则试跑、HTML 参数 `.prepare`、Pi Session 和 Host 恢复。以后打开该项目即可查看生成的 HTML、会话、译名表与角色表。API 不导出最终 TXT，不接受远程网络请求，不返回供应商密钥。

安装包中的客户端和指南位于 `resources/app.asar.unpacked/agent-tools/` 和 `resources/app.asar.unpacked/docs/`，外部 Node.js 可直接读取；源码目录使用上面的路径。
