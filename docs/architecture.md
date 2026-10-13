# Harness、Host 与 Pi

[English](architecture.en.md) · [流程](workflows.md) · [开发](development.md)

## 职责划分

| 层 | 负责什么 |
| --- | --- |
| 用户界面与官方 Agent API | 读取/编辑参数，展示计划与结果，接收停止或继续请求 |
| Pi runtime | 模型调用、消息、工具回合、Session 和上下文压缩 |
| YN Host | 文档清单、范围所有权、校验、共享资产事务、证据与完成条件 |
| Supervisor 与持久 Worker | 领取分块、管理子会话、翻译/复审/校对池与收尾 |
| 产物 | staging 草稿、正式候选、校对 JSON、HTML sidecar 和原生历史 |

Parent 与 Child 共用原生 Pi Session 和 JSONL；Child 不能再派生 Child。主 Agent 读取轻量子任务状态与结构化发现，按需展开子会话，不把完整子会话注入主上下文。

## 参数和入口

首页简便启动、HTML 参数表与后台 Agent API 共用项目初始化、扫描、保留规则试跑、提示词和 Host。翻译风格只有一个项目参数，不增加第二套翻译引擎。

## 术语与角色

正式术语优先。其余发现沿用已经建立的译名，冲突显式呈现。资料准备通过可修改草稿、读取核查、check、commit 后提交正式表。正则保留按实际匹配位置排除术语替换与漏译检测；正确对应的正式表也可排除漏译。角色别名不直接触发 canonical 名称缺失 warning。

## 提交与恢复

先写 staging，再机械校验与独立复审，通过后提升为正式候选。Host 按文档、实际行数和内容 hash 绑定证据。异常恢复先核验全部保留范围，再改写或启动模型，未变正文保留已接受证据。

PDF 代码/公式归 Host 所有，从模型可写范围排除。旧草稿规范化前保存可核验的写前收据，文件已提交、checkpoint 尚未保存时也能冷恢复；正文变化不能借保护修复绕过证据核验。

共享资产提交、提升、Host checkpoint 与失败补偿沿用项目串行事务。补偿无法确认时保留校验产物、备份和诊断并停止。具体实现以 [Host](../src/main/agent/piNative/ynDomainTools.ts)、[Supervisor](../src/main/agent/piNative/subagentSupervisor.ts)、[Runtime](../src/main/agent/piNative/sessionAgentRuntime.ts) 和测试为准。
