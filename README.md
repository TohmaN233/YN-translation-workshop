<div align="left">
<img src="docs/yn-guide/assets/app-icon.png" alt="YN Translation Workshop 标志" width="72">
<h1>YN Translation Workshop</h1>
</div>

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**为译者与 AI 协作设计的开源翻译工作台，面向长篇小说与游戏本地化。**

YN 把译者的判断、人工编辑与 AI 辅助放在同一工作流。你可以自己翻译、让 AI 起草，也可以只请 AI 检查指定行；术语、角色口吻、修改取舍和最终成稿由你掌握。

TXT、EPUB 和文字层 PDF 都可进入原译文对照页面。逐行精修、译名与角色管理、格式保留、旧译复用和分块处理围绕同一个翻译项目展开，支撑专业翻译中的反复推敲、表达一致性与长期项目维护。

[English](README.en.md) · [下载 Windows 版本](https://github.com/TohmaN233/YN-translation-workshop/releases) · [使用手册](https://tohman233.github.io/YN-translation-workshop/) · [项目介绍](https://tgy233.top/tgypage/yn/) · [项目教程](docs/guide.md) · [GitHub 仓库](https://github.com/TohmaN233/YN-translation-workshop)

适合需要跨章节保持译名、保留游戏控制符、逐行人工检查并继续长任务的文件翻译项目。PDF 使用横排文字层文档。AI 任务将所需文本发送给你选择的模型供应商。

## 使用要求

- 当前发行面向 Windows x64。安装包自带运行环境，普通使用不需要 Node.js。
- AI 功能需要在 YN 配置供应商、模型和授权；关闭 Agent 后仍可人工编辑。
- 原文应为 TXT、EPUB 或有文字层的 PDF。校对需要与原文逐行对应的已有译文。

## 下载与安装

在 [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases) 下载安装版（Setup）或便携版（Portable）。本文介绍 2.2.0。

安装版支持应用内更新；便携版通过发布页下载替换。发布页同时提供 `SHA256SUMS.txt`。

## 配置

选择原文、项目保存位置、语言方向与翻译风格；使用 AI 相关功能时，在启动页顶部配置供应商和模型。AI 新任务默认每块 **500 行**、最多 **3 个子 Agent**；已有项目的显式设置会保留。

已有译名表、角色表或参考资料时，先使用“整理项目资料”，再开始翻译。游戏文本可设置正则保留规则，先查看匹配示例，避免把台词正文一起锁住。

## 按你的分工开始

1. 选择原文和项目位置；已有译文时一并绑定，保持原译文逐行对应。
2. 自己翻译或精修时，先生成对照 HTML，在页面中编辑并按需向 AI 提问。需要 AI 起草时，使用“准备并启动翻译”，确认参数后开始分块处理。
3. 在对照页面逐行修改、搜索和核对译文，也可以从选中行向 AI 提供上下文。需要校对时，对已有译文启动校对。
4. 接受、拒绝或修改校对建议。自动应用只更新 HTML；**最终写入 TXT 由你手动完成**。EPUB/PDF 使用对应导出入口。

[完整教程](https://tohman233.github.io/YN-translation-workshop/guides.html) · [PDF 说明](docs/pdf.md) · [外部 Agent 后台使用](docs/agent-api.md)

## 为翻译工作设计的协作

| 翻译工作 | 协作支持 |
| --- | --- |
| 逐行推敲与精修 | 原译文对照、搜索和直接编辑；选中行可向 AI 提问，校对建议可修改、接受或拒绝 |
| 译名与人物塑造 | 正式译名表、候选和角色资料可人工维护，记录称谓、代词、关系与口吻，AI 整理资料并提示冲突 |
| 文风与项目要求 | 翻译风格、参考资料和可编辑提示词承接译者的表达偏好与作品要求 |
| 游戏控制符与格式 | 先查看保留规则的匹配示例，再保护变量、标签和控制符；翻译与校对使用相同要求 |
| 接续已有译文 | 绑定逐行对应的旧译，保留可复用内容，继续修改、翻译或校对 |
| 长篇持续推进 | 按块处理、停止和续跑，原译文、资料及审阅状态集中在同一项目中 |
| PDF 审阅与导出 | 提取正文与公式／图表资产，在 HTML 中修改译文，再自动重排导出 PDF |

详细参数、旧译复用、抽样校对、局域网操作与产物位置见 [功能手册](docs/features.md)。

## YN 翻译项目例子

- **日语 → 中文：**[Megido72（梅基多72）游戏文本翻译演示](https://www.bilibili.com/video/BV12ypy68EEF/)。
- **日语 → 中文：**[美希命的游戏汉化展示](https://space.bilibili.com/1863789519)，包括其许多汉化游戏。
- **日语 → 中文：**[《命运石之门》圆环小说](https://tgy233.top/tgypage/%E7%A7%91%E5%AD%A6ADV%E5%B0%8F%E8%AF%B4%E6%B1%87%E6%80%BB_2026-0828.html)。
- **中文 → 英文：**[《Robotics;Notes》小说译文](https://drive.google.com/file/d/1pPVFPxdwOxNnT_8TO1wJGEY9D3FVFNeK/view)。

更多项目见 [案例说明](docs/examples.md)。

## 质量检查

YN 检查行对齐、占位符、保留内容、写入范围和恢复证据，并安排独立 AI 复审。发现的问题定位到具体行，便于修复和人工审阅。

[质量检查](docs/quality.md) 列出检查项目、测试来源和运行方法。

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
