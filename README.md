<div align="left">
<img src="docs/yn-guide/assets/app-icon.png" alt="YN Translation Workshop 标志" width="72">
<h1>YN Translation Workshop</h1>
</div>

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**面向长篇小说与游戏文本本地化的开源 AI 翻译、校对与逐行审阅工作台。**

YN 把 TXT、EPUB 和文字层 PDF 变成可编辑的原译文对照页面。它把术语表、角色资料、格式保留、分块翻译和校对放在同一项目中；你可以让 AI 处理整批文本，也可以只让它检查指定行，自己决定最终写入。

[English](README.en.md) · [下载 Windows 版本](https://github.com/TohmaN233/YN-translation-workshop/releases) · [使用手册](https://tohman233.github.io/YN-translation-workshop/) · [项目介绍](https://tgy233.top/tgypage/yn/)

适合需要跨章节保持译名、保留游戏控制符、逐行人工检查并继续长任务的项目。不面向实时屏幕翻译；PDF 当前以可选中文字为主，不提供 OCR。云端模型会收到任务所需文本，翻译质量仍取决于模型、项目资料和人工审阅。

## 使用要求

- 当前发行面向 Windows x64。安装包自带运行环境，普通使用不需要 Node.js。
- AI 功能需要在 YN 配置供应商、模型和授权；关闭 Agent 后仍可人工编辑。
- 原文应为 TXT、EPUB 或有文字层的 PDF。校对需要与原文逐行对应的已有译文。

## 下载与安装

在 [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases) 选择安装版 `translation-workshop-Setup-2.2.0-x64.exe` 或便携版 `translation-workshop-Portable-2.2.0-x64.exe`。公开下载以实际发布版本为准；本说明对应 2.2.0。

安装版支持应用内更新；便携版通过发布页下载替换。发布页同时提供 `SHA256SUMS.txt`。

## 配置

先在启动页顶部配置供应商和模型，再填写原文、项目保存位置、语言方向与翻译风格。新任务默认每块 **500 行**、最多 **3 个子 Agent**；已有项目的显式设置会保留。

已有译名表、角色表或参考资料时，先使用“整理项目资料”，再开始翻译。游戏文本可设置正则保留规则，先查看匹配示例，避免把台词正文一起锁住。

## 第一次翻译

1. 选择原文并确认项目位置；建议先用一小段文本验证设置。
2. 使用“准备并启动翻译”，确认默认参数。YN 核对内容、试跑保留规则，自动打开行对行 HTML 并启动同一翻译流程。希望更多人工介入时，可先生成 HTML 再按需调用 AI。
3. 完成后刷新候选译文，逐行修改或抽查；需要校对时，绑定已有译文并启动校对。
4. 接受、拒绝或修改校对建议。自动应用只更新 HTML；**最终写入 TXT 由你手动完成**。EPUB/PDF 使用对应导出入口。

![行对行审阅页面，可对照原文编辑译文与校对意见](docs/yn-guide/assets/screens/line-review.png)

[完整教程](https://tohman233.github.io/YN-translation-workshop/guides.html) · [PDF 说明](docs/pdf.md) · [外部 Agent 后台使用](docs/agent-api.md)

## 能解决哪些问题

| 需求 | YN 的处理方式 |
| --- | --- |
| 长篇译名与角色称谓变化 | 正式译名表、候选、角色表及直接命中参考；冲突显式呈现 |
| 游戏控制符、标签或变量被改坏 | 保留规则与机械校验；校对建议也携带相同要求 |
| 大量文本需要人工逐行检查 | 原译文对照、搜索、编辑、候选刷新、建议接受与拒绝 |
| 翻译中断后继续工作 | 核验已有草稿和审阅证据后续跑；不盲目重试内部故障 |
| PDF 含代码、公式或图表 | 提取正文与字形／图表资产，整理结构后重建 HTML，翻译正文并自动重排生成新 PDF |
| 不打开主窗口也能使用 | 外部 Agent 通过官方接口先展示计划，确认后在后台启动 |

详细参数、旧译复用、抽样校对、局域网操作与产物位置见 [功能手册](docs/features.md)。

## YN 翻译项目例子

- **日语 → 中文：**[Megido72（梅基多72）千万字级游戏翻译演示](https://www.bilibili.com/video/BV12ypy68EEF/)。[首章简介](https://www.bilibili.com/video/BV15spk6iEVR/)介绍了用 YN 重译约一千万字后的译名一致性与准确度改善。
- **日语 → 中文：**[美希命的游戏汉化展示](https://space.bilibili.com/1863789519)，包括其许多汉化游戏。
- **日语 → 中文：**[《命运石之门》圆环小说](https://tgy233.top/tgypage/%E7%A7%91%E5%AD%A6ADV%E5%B0%8F%E8%AF%B4%E6%B1%87%E6%80%BB_2026-0828.html)。
- **中文 → 英文：**[《Robotics;Notes》小说译文](https://drive.google.com/file/d/1pPVFPxdwOxNnT_8TO1wJGEY9D3FVFNeK/view)。

更多项目见 [案例说明](docs/examples.md)。

## 质量与可靠性的依据

YN 用程序检查行对齐、占位符、保留内容、写入范围与恢复证据，再安排独立 AI 复审；模型说“完成”不能代替产物检查。这能暴露结构和流程问题，不能证明所有语义都正确。

[质量与可靠性说明](docs/quality.md) 列出公开测试、复现命令、验证边界与失败处理；语义准确率、跨工具排名和普遍成本优势尚未给出可对照的评测，不作此类承诺。

## 2.2.0 更新摘要

- 文字层 PDF 在生成 HTML 前必经完整机械草稿、原生 Pi 增量结构提案、Host 校验及独立审计；接受后翻译完整逻辑单元，保护代码、公式及参考文献，按需看图，并由当前 HTML 译文自动重排 PDF，无原正文文本框长度上限。学术标识预扫描与主 Agent 对具体未译误报的确认继续可用。
- 新增官方后台 Agent API，复用现有准备、翻译、校对与资料流程。
- 改善大历史会话和大候选响应，完善停止、断连恢复与角色名匹配。

完整版本记录见 [Changelog](CHANGELOG.md)。

## 文档与开发

[使用教程](docs/guide.md) · [功能与参数](docs/features.md) · [工作流](docs/workflows.md) · [技术术语](docs/terminology.md) · [运行时代码地图](docs/agent-runtime-codegraph.md)

开发需要 Node.js `>=22.19.0`，使用已有 npm lock：

```bash
npm ci
npm run dev
```

```bash
npm test
npm run build
```

桌面、LAN 与发布包验证入口见 [开发与验证](docs/development.md)。

## 隐私与许可

项目状态、资产、会话与备份保存在项目目录；供应商授权保存在 Electron 用户数据中。复制项目时，也需一并带走位于项目外的原文或资料并重新绑定。LAN 的 PIN 持有者可操作共享工作台，请只在可信网络或受控隧道中使用。

[MIT](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

感谢 OpenAI Codex 以及参与测试、翻译和反馈的人。
