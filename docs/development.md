# 开发与验证

[English](development.en.md) · [首页](../README.md)

要求 Node.js >=22.19.0。项目提供 npm lock，普通桌面用户不需要这些开发命令。

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

`package:win` 使用仓库 electron-builder 配置；以上列出命令不授权公开发布。源码或文档改动后，包内版本、构建、README 与 checksum 需一致。Windows 验收运行隐藏的 win-unpacked 应用并正常退出，不使用已知退出异常的 portable 外壳，不强杀验收进程。

工作流代码地图见 [运行时地图](agent-runtime-codegraph.md)，协议见 [翻译 child](../translation-protocol/translation-child.md) 和 [校对 child](../translation-protocol/proofread-child.md)。内部排障记录不是产品质量排行。

文档站以中英文 Markdown 为正文来源。修改后运行 `node docs/yn-guide/build.mjs`，生成静态页面与搜索索引；无需额外安装构建工具。
