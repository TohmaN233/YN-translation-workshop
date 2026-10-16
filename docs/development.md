# 开发与验证

[English](development.en.md) · [首页](../README.md)

要求 Node.js >=22.19.0，并使用项目现有的 npm lock。普通桌面用户不需要这些开发命令。

```bash
npm ci
npm run dev
```

```bash
npm run typecheck
npm test
npm run build
```

真实桌面、LAN、后台 API 与存储检查使用已有脚本：

```bash
npm run verify:electron-agent-html
npm run verify:electron-lan-agent
npm run verify:electron-agent-api
npm run verify:electron-storage
```

Windows 本地构建与校验：

```bash
npm run package:win
npm run verify:release
npm run verify:packaged-launch
```

`package:win` 使用仓库 electron-builder 配置。包内版本、构建、README 与 checksum 应保持一致。Windows 检查隐藏启动 `release/win-unpacked/translation-workshop.exe`，等待内置 smoke 正常退出。

工作流代码地图见 [运行时地图](agent-runtime-codegraph.md)，协议见 [翻译 child](../translation-protocol/translation-child.md) 和 [校对 child](../translation-protocol/proofread-child.md)。

## 文档站

中英文 Markdown 文件是静态站点的正文来源。修改后运行以下命令，重新生成页面、搜索索引、sitemap 和项目路径下的 robots 文件：

```bash
node docs/yn-guide/build.mjs
```

发布静态文件前，检查生成页面的标题、摘要、canonical 和语言切换链接，以及 sitemap 条目。

爬虫读取 `https://tohman233.github.io/robots.txt`；生成在 `/YN-translation-workshop/robots.txt` 的副本不控制抓取。将中英文文档共用的 [`robots-root-template.txt`](yn-guide/robots-root-template.txt) 部署到主机根目录，并与已有站点规则合并。模板允许 `OAI-SearchBot`，并列出项目 sitemap。`OAI-SearchBot` 用于 ChatGPT 搜索，`GPTBot` 的训练用途设置独立控制。相关说明见 [Google 的 robots.txt 指南](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt) 和 [OpenAI 的爬虫文档](https://developers.openai.com/api/docs/bots)。
