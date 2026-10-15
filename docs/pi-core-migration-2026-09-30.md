# Pi core 与会话格式迁移

[English](pi-core-migration-2026-09-30.en.md)

YN 使用 Pi 原生 Agent 和 Session。`@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` 成对固定为 `0.99.1`，项目要求 Node.js `>=22.19.0`。参见 [Pi v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1)。

## Agent 与 Session

- Host 继续管理任务、工具、验证和完成条件；模型调用与原生会话由 Pi core Agent 执行。
- 会话使用原生 v4 事务、分支及 compaction retained tail。系统提示和工具声明保存在 Pi 原生 system transcript 中。
- Worker 切换 assignment 后重置活动上下文，再发送当前任务的提示词和工具定义，避免把前一任务带入新上下文。完整历史仍保存在原生 JSONL 会话中。
- Stop 会把取消传到 Pi 的 compaction 请求。活动 owner 共享 Session 句柄，临时读取结束或 Worker 释放时关闭句柄；会话列表读取标题时按需读取，避免加载完整历史。

## v3 会话迁移与回退

- 旧 v3 会话可在修改前读取。执行旧格式瘦身或原生转换前，YN 以独占原子方式保存 `<session>.jsonl.v3.backup`。备份冲突、文件格式错误或转换失败会明确报错，原文件不会静默丢弃。
- 首次成功写入时使用 Pi 原生 v3→v4 转换。v4 按原生 session ID 管理会话；迁移时验证消息、Host 状态、既有 compaction、名称和用量数据。
- 回退前先停止应用，并完整保留 parent/child 会话目录及备份；将应用代码和 Pi 依赖一同恢复到兼容版本。旧版本需要 v3 时，只能从对应备份恢复。备份不包含转换后新增的 v4 对话；新建的 v4 会话也没有 v3 原件。不要原地降级或覆盖当前 v4 文件。
- 翻译输出、译名表和角色表不属于 Session 格式资产，按各自项目文件保留。
