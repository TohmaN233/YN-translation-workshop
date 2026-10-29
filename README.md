<div align="left">
<img src="docs/yn-guide/assets/app-icon.png" alt="YN Translation Workshop 标志" width="72">
<h1>YN：开源 AI 小说翻译与游戏本地化工具</h1>
</div>

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**YN 是面向长篇小说与游戏文本的开源 AI 翻译与校对工具，支持全 AI、全人工和人与 AI 协作。**

YN 支持 TXT、EPUB 和文字层 PDF，将 AI 翻译、AI 校对、原译文对照编辑与项目资料管理放在同一工作区。你可以把整部作品的翻译与校对交给 AI，也可以完全自己翻译，或只在需要的环节调用 AI。

长文本分块并发、译名与角色资料复用、格式自动保护和中断续跑，服务于跨章节、跨文件的持续翻译项目。

[English](README.en.md) · [下载 Windows 版本](https://github.com/TohmaN233/YN-translation-workshop/releases) · [使用手册](https://tohman233.github.io/YN-translation-workshop/) · [项目介绍](https://tgy233.top/tgypage/yn/) · [项目教程](docs/guide.md) · [GitHub 仓库](https://github.com/TohmaN233/YN-translation-workshop)

适合需要跨章节保持译名、保护游戏控制符并持续推进长任务的文件翻译项目。PDF 使用横排文字层文档。AI 任务将所需文本发送给你选择的模型供应商。

## 主要功能

- **AI 翻译**：按语言方向、文风和项目资料翻译整篇原文。准备阶段核对参数与内容，随后按行分块，由多个 Agent 并发翻译。程序校验行数、占位符和保留内容，独立 AI 复审覆盖全部机械风险行与抽样普通行，发现问题后自动返回精确修复。旧译可审计后选择性复用，长任务可停止和续跑。
- **AI 校对**：对照原文检查已有译文的误译、漏译、术语、称谓和表达问题。逐片精审逐行检查；Monte Carlo 将全量程序扫描与分层抽样 AI 校对结合起来。结果包含具体行号、问题依据和完整替换建议，可自动应用到 HTML，也可逐条接受、拒绝或修改。
- **资料与一致性**：AI 可整理译名与角色资料、提取新候选；翻译与校对复用正式译名、角色称谓与口吻、风格要求及已有译文。资料也可自行维护。
- **格式自动保留**：翻译准备时，AI 结合任务要求与原文样例识别变量、标签和控制符等保留规则候选，程序试跑后在翻译与校对中执行校验；自定义规则可按需补充。
- **人工编辑与协作**：在原译文对照页面直接翻译、逐行修改、搜索和管理项目资料；可从选中行向 AI 提问，或只把部分工作交给 AI。
- **PDF 提取与重排**：提取正文及公式／图表资产，经机械结构整理、AI 修订与独立审计后生成 HTML；翻译后用译文和源资产重建结构化 HTML，自动重排导出 PDF。

详细参数、旧译复用、校对模式、局域网操作与产物位置见 [功能手册](docs/features.md)。

## 使用要求

- 当前发行面向 Windows x64。安装包自带运行环境，普通使用不需要 Node.js。
- 使用 AI 功能前，需要在 YN 配置供应商、模型和授权；关闭 Agent 后仍可人工编辑。
- 原文应为 TXT、EPUB 或有文字层的 PDF。校对需要与原文逐行对应的已有译文。

## 下载与安装

在 [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases) 下载安装版（Setup）或便携版（Portable）。本文介绍 2.2.5。

安装版支持应用内更新；便携版通过发布页下载替换。发布页同时提供 `SHA256SUMS.txt`。

## 配置

选择原文、项目保存位置、语言方向与翻译风格；使用 AI 相关功能时，在启动页顶部配置供应商和模型。AI 新任务默认每块 **500 行**、最多 **3 个子 Agent**；已有项目的显式设置会保留。

已有译名表、角色表或参考资料时，可先使用“整理项目资料”。有格式保留要求时，翻译准备会结合原文样例提出规则候选并试跑、校验；自定义正则和查看匹配示例可按需用于调整。

## 按你的工作方式开始

1. 选择原文、项目位置、语言方向和风格；校对时绑定与原文逐行对应的已有译文。
2. 选择 AI 翻译、AI 校对、人工编辑或混合方式。AI 翻译从“准备并启动翻译”开始；AI 校对需要已有译文。
3. 需要人工参与时，可在对照 HTML 中逐行编辑、搜索、向 AI 提问，或逐条接受、拒绝和修改校对建议。
4. AI 处理或人工编辑完成后，点击写入最终 TXT 或导出 EPUB/PDF。校对建议的自动应用更新 HTML，最终文件通过写出入口保存。

[完整教程](https://tohman233.github.io/YN-translation-workshop/guides.html) · [PDF 说明](docs/pdf.md) · [外部 Agent 后台使用](docs/agent-api.md)

## YN 翻译项目例子

- **日语 → 中文：**[Megido72（梅基多72）游戏文本翻译演示](https://www.bilibili.com/video/BV12ypy68EEF/)。
- **日语 → 中文：**[美希命的游戏汉化展示](https://space.bilibili.com/1863789519)，包括其许多汉化游戏。
- **日语 → 中文：**[《命运石之门》圆环小说](https://tgy233.top/tgypage/%E7%A7%91%E5%AD%A6ADV%E5%B0%8F%E8%AF%B4%E6%B1%87%E6%80%BB_2026-0828.html)。
- **中文 → 英文：**[《Robotics;Notes》小说译文](https://drive.google.com/file/d/1pPVFPxdwOxNnT_8TO1wJGEY9D3FVFNeK/view)。

更多项目见 [案例说明](docs/examples.md)。

## 质量检查

YN 检查行对齐、占位符、保留内容、写入范围和恢复证据，并安排独立 AI 复审。发现的问题定位到具体行，可用于自动精确修复或人工处理。

[质量检查](docs/quality.md) 列出检查项目、测试来源和运行方法。

## 2.2.5 更新摘要

- 修复新建 EPUB 项目中空白译文草稿行数不一致导致 HTML 无法打开的问题。

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
