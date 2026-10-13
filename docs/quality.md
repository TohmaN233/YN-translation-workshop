# YN 质量与可靠性说明

[English](quality.en.md) · [首页](../README.md) · [使用实例](examples.md)

本页对应 2.2.0，区分程序可检查的结构约束、AI 语义审阅和用户实际翻译项目。它不是不同翻译工具的排名，也不把测试通过等同于译文语义正确。

## 公开证据

| 问题 | 检查与可复现来源 | 说明 |
| --- | --- | --- |
| 占位符、标签、控制符或行数损坏 | [翻译校验测试](../tests/validation/translationValidator.test.mjs) | 检查已声明的结构；不能替代语义判断 |
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
| 大候选校验、导入与取消 | [产物响应测试](../tests/main/artifactResponsiveness.test.mjs) · [取消收尾测试](../tests/main/artifactCancelSettlement.test.mjs) | 后台处理和事务提交；不承诺任意大小即时完成 |

## 当前验收范围

2026-10-13，本地 Windows x64、Node.js 24.14.1 的完整 `npm test` 通过 223 个测试文件；隐藏 Electron 39.8.10 / Node.js 22.22.1 下验证了 PDF 预扫描、翻译、修复与独立复核。版本和依赖以 [package.json](../package.json) 与 [锁文件](../package-lock.json) 为准。

这些是本地验收，不是公开 CI 状态。原生 Pi 流程回归中的模型响应使用可控测试 Provider，验证范围、写入和恢复契约；这不构成真实模型的翻译质量评测。测试总数是该次验收快照，不是长期徽章。

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

真实桌面与发布包的检查入口和隐藏 Windows 验收限制见 [开发与验证](development.md)。耗时、内存、Provider 重试与缓存命中会随模型、文本、机器和网络改变，不能从固定提示词或 500 行分块直接推导普遍费用优势。

## 能发现与仍会遗漏的问题

机械校验可拒绝缺行、损坏控制符、越权写入及不匹配证据。独立 AI 复审关注风险行和稳定样本；逐片精审校对覆盖负责范围，Monte Carlo 是抽样。模型可能漏掉误译、代词、口吻与逻辑问题；没有统一公开盲评，本页不提供语义准确率。

错误不应被当成成功。绑定的必需文件丢失、不可重试的内部故障或无进展修复会停止，保留草稿与诊断。代码、公式的识别受 PDF 信息和绘制结构限制；无法安全区分时明确拒绝，见 [PDF 限制](pdf.md)。
