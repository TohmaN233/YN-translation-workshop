# YN 质量检查

[English](quality.en.md) · [首页](../README.md) · [使用实例](examples.md)

YN 结合结构校验、独立 AI 复审和逐行人工审阅检查译文。本页列出检查项目及运行方法。

## 检查项目

| 问题 | 检查与可复现来源 | 说明 |
| --- | --- | --- |
| 占位符、标签、控制符或行数损坏 | [翻译校验测试](../tests/validation/translationValidator.test.mjs) | 检查已声明的行与保留符号结构 |
| 校对建议破坏保留格式 | [校对建议校验](../src/shared/validation/proofreadReplacement.ts) | 提交时检查同一物理行、占位符与保留要求 |
| 正则保留内容与漏译/术语检查冲突 | [术语匹配一致性测试](../tests/validation/glossaryMatcherParity.test.mjs) | 按实际匹配位置排除，正文继续检查 |
| 未译误报阻碍有效候选 | [主 Agent 确认测试](../tests/agent/translationResidueApproval.test.mjs) · [原生复审测试](../tests/agent/piNativeTranslationResidueReview.test.mjs) | 逐行、确切文本与理由绑定，跨格式生效；其他结构要求仍检查 |
| 参考文献被误译 | [参考文献全流程测试](../tests/pdf-reference-workflow.test.mjs) | Host 预填只读行，旧 HTML 重绑，导出核对原始字形像素 |
| PDF 视觉换行拆散正文段落 | [段落边界](../tests/pdf-paragraph-layout.test.mjs)、[Host/HTML/导出回归](../tests/pdf-paragraph-workflow.test.mjs) | 首行和悬挂缩进、窄栏、原生段落/表格边界、行内公式保留及有序排版区域 |
| 学术 PDF 包名、缩写和编号被误判漏译 | [预扫描与原生 Pi 回归](../tests/pdf-academic-prescan.test.mjs) | 源文依据、按行豁免、真实正文修复和导入共用检查；不新增模型请求 |
| 中断后草稿、范围与复核证据不匹配 | [恢复 preflight 回归](../tests/agent/piNativeRecoveryBatchPreflight.test.mjs) | 核验旧证据；未变行保留，故障提交补偿 |
| PDF 代码/公式缺行或被改写 | [保护写入回归](../tests/pdf-child-write-rejection.test.mjs) · [PDF 保护测试](../tests/pdf-protection.test.mjs) | Host 预填、只提交正文；纯保护块零翻译请求 |
| 文件改写后、checkpoint 保存前中断 | [PDF 冷恢复测试](../tests/pdf-protected-recovery.test.mjs) | 隔离进程在提交窗口退出，新 Host 核验写前收据恢复 |
| 大历史重启与停止收尾 | [停止持久化回归](../tests/agent/piNativeStopStorageFlush.test.mjs) · [会话存储说明](session-storage.md) | 原生历史保留；派生索引不替代权威证据 |
| 大候选校验、导入与取消 | [产物响应测试](../tests/main/artifactResponsiveness.test.mjs) · [取消收尾测试](../tests/main/artifactCancelSettlement.test.mjs) | 后台校验、取消和事务提交 |

## 如何复现

开发环境使用 Node.js 22.19 或更新版，安装仓库锁定依赖后：

```bash
npm ci
npm test
```

复现单个 PDF 冷恢复测试：

```bash
node --experimental-strip-types tests/pdf-protected-recovery.test.mjs
```

桌面、LAN、API 和发布包的检查命令见 [开发与验证](development.md)。依赖版本由 [package.json](../package.json) 和[锁文件](../package-lock.json)定义。

## 复审与恢复

结构校验检查行数、控制符、写入范围和证据绑定。独立 AI 复审结合原文与上下文检查含义和术语；逐片精审校对覆盖负责范围，Monte Carlo 使用分层抽样。问题在审阅页面中展示，可修改、接受或拒绝。

必需文件缺失、内部错误或修复停滞时，任务停止并保留草稿和诊断。恢复先核验保存内容与证据，再继续工作。PDF 输入要求与资产处理见 [PDF 说明](pdf.md)。
