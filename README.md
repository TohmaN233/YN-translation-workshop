# translation-workshop

> 本地翻译 / 校对工作台。  
> 面向人工审阅优先的翻译流程，也可以配合 Codex / Claude Code Agent 提高效率。

[English README](README.en.md)

translation-workshop 用于把源文与译文按行配对，生成可人工改写的校对 HTML；也可以生成 Codex / Claude Code 的翻译与校对提示词，并把校对报告 Markdown 转换为逐条审阅用 HTML。

我做这个项目的动机很简单：很多 AI 翻译工具看起来很强，但对真正的翻译/汉化流程并不友好。AI 输出无论多漂亮，想达到稳定的商业质量，最终仍然需要人工审核。缺少一个舒服、清晰、可回溯的前端，本身就是翻译工作流里的大问题。

这个项目希望同时照顾三类使用者：

- 不使用 AI 的翻译者：也能获得舒服的行对行翻译与校对界面。
- 使用 AI 的翻译者：能借助 Agent 做翻译/校对，同时保留人工审阅的可控性。
- 不熟悉源语言的用户：也能通过 AI 翻译、AI 校对和可视化报告完成基本翻译流程。

## 下载

Windows 用户推荐下载：

**`translation-workshop.Setup.exe`**

不想安装时，可以下载便携版：

**`translation-workshop.exe`**

Release 页面：  
<https://github.com/TohmaN233/YN-translation-workshop/releases>

## 更新说明

### v1.10.0

- **提示词与 skill 更新**：Codex / Claude Code 校对 skill 强化报告契约，要求报告正文使用目标语言、`Source` / `Current translation` 使用完整原行、`Suggested fix` 给出完整替换译文。
- **审阅报告解析**：生成审阅 HTML 前会严格处理重复编号；若 AI 报告里出现重复的 `H1-001`、`M2-004`、`L1-003` 等 ID，会接在该分类当前最大编号后重新编号，避免查找、跳转和一键替换互相覆盖。
- **Agent 启动上下文**：软件内启动 Codex / Claude Code CLI 时，默认只开放 translation-workshop 的翻译 / 校对 skill，减少其他全局 skill 对当前任务的上下文污染；安装命令默认带 `--replace`，覆盖前会备份旧目标。
- **局域网与公网访问**：HTML 支持启动 6 位 PIN 保护的共享工作区，手机、平板或远程设备可以访问正在打开的软件，进行正文校对、审阅建议处理和 Agent 交互；局域网地址也可通过 Cloudflare Tunnel / ngrok 等外部工具穿透到公网。

### v1.0.5

- **Codex proofread skill**：精简校对报告提示词，报告正文统一使用目标语言，程序解析必需字段保持固定英文；强化 fix proposal 的行号与字段格式约束。
- **发送给 AI 的提示词**：翻译和校对提示词都强调输出内容使用目标语言；`Suggested fix` 等固定字段名必须保持原样。
- **术语表体验**：术语表面板显示区域扩大，支持按原文、译文、当前译文搜索；术语列表改为动态渲染。
- **兜底报告提示词**：当检测到 AI 生成了疑似 fix proposal，但格式不符合审阅 HTML 解析要求时，自动生成中英双语对应的格式修复提示词，并打开 Agent 窗口方便直接发送。

## 内置 Skills

项目内置 Codex 与 Claude Code 两套 skill / command。目前支持 Agent 翻译流程，不支持单独调用 API 做提示词工程翻译。

- [translate-text 说明](skills/translate-text.README.md)：批量翻译、术语表、角色设定。
- [proofread-translation 说明](skills/proofread-translation.README.md)：逐行校对、Monte Carlo 抽样校对和修正建议报告。

目录结构：

- Codex skill：`skills/codex/<skill-name>/SKILL.md`
- Claude Code command：`skills/claude/commands/<skill-name>.md`

## 界面预览

<p align="center">
  <img src="graph_for_intro/face_ch.png" alt="中文界面" width="340">
  <img src="graph_for_intro/face_en.png" alt="English UI" width="340">
</p>

UI 支持中文 / English 双语切换。主界面提供文件选择、输出目录、格式选项、输入模式、skill 安装提示和生成入口。

## 主要功能

### 行对行校对 HTML

选择源文件、译文文件和输出文件夹后，即可生成行对行 HTML。译文文件可为空，此时进入单纯翻译模式。

支持：

- TXT / EPUB
- 分离文件模式
- 双语 TXT / 双语 EPUB 的相邻行拆分
- 文件夹批量输入
- 分页、跳页、搜索、滚动位置记忆
- 人工改写状态标记
- 重新打开后定位到上次编辑位置，黄框表示上次离开/当前关注行

<p align="center">
  <img src="graph_for_intro/t1.png" alt="行对行校对 HTML" width="860">
</p>

TXT / EPUB 可以随时导出。TXT 还支持写回绑定的译文文件，覆盖前会自动创建时间戳备份。

### 局域网同步

HTML 在 Electron 内打开时，可以启动局域网同步。启动时设置一个固定 6 位 PIN，手机或平板访问应用生成的局域网地址后输入 PIN，即可进入共享工作区。

共享工作区支持正文校对和审阅建议两个标签页。若从审阅 HTML 启动同步，且已绑定正文 HTML，同一个链接会同时显示审阅建议与正文行；移动端改写会同步回电脑端 HTML 缓存。

外部穿透：translation-workshop 不内置公网穿透工具。如果你使用 Cloudflare Tunnel、ngrok 等工具，可将它们指向本地同步端口。

例如桌面端显示：

```text
http://127.0.0.1:54321/s/abcdef...
```

则 Cloudflare Tunnel 可以运行：

```powershell
cloudflared tunnel --url http://127.0.0.1:54321
```

ngrok 可以运行：

```powershell
ngrok http 54321
```

打开公网地址后输入软件里设置的 6 位 PIN。新版在只有一个同步会话时会从穿透根地址自动跳转到当前会话；如果没有跳转，请把本地链接里的 `/s/...` 路径接到公网域名后面。

### 术语表与替换

翻译过程中可以随时浏览术语表、修改译名，并对当前页或全文执行术语替换。

术语检查会自动标注源语言中出现、但译文侧缺失的术语；长名词优先覆盖短名词。缺失术语会以 H3 标记并高亮对应行。

<p align="center">
  <img src="graph_for_intro/t2.png" alt="术语表与术语替换" width="860">
</p>

### Agent 提示词与交互控制台

翻译和校对都提供参数窗口。你可以先设置语言方向、文本类型、输出目录、split / subagent 等参数，再生成提示词。

<p align="center">
  <img src="graph_for_intro/t3.png" alt="翻译提示词参数窗口" width="860">
</p>

应用内置真实终端控制台，可与 Codex / Claude Code 交互。使用前请先安装对应 CLI，并完成登录。

### 校对报告审阅 HTML

校对完成后，选择或自动查找 Markdown 报告，即可生成修正建议审阅 HTML。

<p align="center">
  <img src="graph_for_intro/t5.png" alt="校对报告审阅 HTML" width="860">
</p>

审阅 HTML 可以和正文绑定：

- 将报告发现的问题标记回正文对应行。
- 跳转到正文上下文。
- 一键接受 AI 建议译文。
- 手动改写并标记人工处理状态。

<p align="center">
  <img src="graph_for_intro/t6.png" alt="正文与校对报告联动" width="860">
</p>

项目状态会保存到输出目录下的 `.translation-workshop/`，之后可以通过打开同一输出文件夹继续工作。

## 像软件一样启动

Windows:

```bat
start-workshop.cmd
```

macOS / Linux / Git Bash:

```bash
./start-workshop.sh
```

启动脚本会在缺少 `node_modules` 时安装依赖，在缺少 `dist` 时构建，然后启动 Electron 应用。

## 基本流程

1. 首次使用时选择 Codex 或 Claude Code。
2. 查看内置 skill / command 路径和安装状态，按需复制安装命令。
3. 选择源文 TXT / EPUB 文件，或选择源文件夹。
4. 可选选择译文 TXT / EPUB 文件，或选择译文文件夹。
5. 选择输出文件夹。
6. 生成行对行 HTML。
7. 在 HTML 中人工翻译/修改、跳页、搜索、替换术语。
8. 需要 AI 翻译时生成翻译提示词，打开 Agent 控制台。
9. 翻译完成后导入或同步译文 TXT。
10. 生成校对提示词，复制或发送到交互式 Agent 控制台。
11. 校对完成后选择或自动查找 Markdown 报告，生成修正建议审阅 HTML。
12. 完成校对后使用 `写入 TXT` 覆盖绑定译文，或使用 `导出 TXT` 另存。

## Codex Skill 配置

内置路径：

- 翻译：`skills/codex/translate-text`
- 校对：`skills/codex/proofread-translation`

应用只复制安装命令，不会自动写入你的全局 Codex 配置。推荐使用 GitHub 安装命令，安装版、便携版、未 clone 源码时都可用。该命令需要 Node.js 18 或更新版本，并默认使用 `--replace` 更新已有 skill；旧目标会先备份到 `~/.translation-workshop/skill-backups/`：

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global --replace
```

如果已经 clone 仓库，也可以用本地路径安装：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global --replace
```

安装目标：

- `~/.codex/skills/translate-text/SKILL.md`
- `~/.codex/skills/proofread-translation/SKILL.md`

推荐命令会更新已有 skill，并在覆盖前备份旧目标。

## Claude Code Skill 配置

内置路径：

- 翻译：`skills/claude/commands/translate-text.md`
- 校对：`skills/claude/commands/proofread-translation.md`

应用只复制安装命令，不会自动写入你的全局 Claude Code 配置。推荐使用 GitHub 安装命令，安装版、便携版、未 clone 源码时都可用。该命令需要 Node.js 18 或更新版本，并默认使用 `--replace` 更新已有 command；旧目标会先备份到 `~/.translation-workshop/skill-backups/`：

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent claude --global --replace
```

如果已经 clone 仓库，也可以用本地路径安装：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global --replace
```

安装目标：

- `~/.claude/commands/translate-text.md`
- `~/.claude/commands/proofread-translation.md`

推荐命令会更新已有 command，并在覆盖前备份旧目标。

## 文件支持

| 格式 | 当前支持 |
| --- | --- |
| TXT | 行对行 HTML、写回、导出 |
| EPUB | 文本抽取并生成行对行 HTML |
| 双语 TXT | 按相邻两行的源文 / 译文位置拆分 |
| 双语 EPUB | 按相邻两行的源文 / 译文位置拆分 |
| Glossary | JSON、tab 分隔、`=>`、`->`、`=`、逗号分隔 |
| Markdown report | 校对报告识别与审阅 HTML |

## 安全说明

- 源文件永远只读，不会被修改。
- 应用不会自动安装全局 Codex / Claude Code skill，只做只读检测并复制安装命令。
- 推荐安装命令带 `--replace`，会先备份具体目标文件 / 目录，再更新。
- `写入 TXT` 只有在 HTML 从 Electron 应用打开时才会写入绑定译文路径。
- Agent 控制台是真实终端交互；应用不会隐藏后台调用，也不会假装判断 Agent 已完成。完成后请手动同步译文或查找报告。
- 局域网同步只暴露当前共享会话，不提供任意文件读取或目录浏览；访问需要 6 位 PIN，停止同步后会话链接失效。若你在共享页启用 Agent 控制台，PIN 访问者可以和当前 Agent 交互，因此不要把链接或 PIN 发给不可信的人。

## 致谢

特别感谢 OpenAI Codex 同学在工程和设计上提供了诸多帮助。某位伟人曾经说过，一个项目是由 99% 的 token 与 1% 的灵感组成的。
觉得本项目有启发性或者本工具好用的话麻烦给个⭐支持。

## 高级：Monte Carlo 压力测试提示词

<details>
<summary>展开提示词模板</summary>

```text
You are a Translation Project Manager. please ask 3 (or any number, larger is harder to pass the test) sub-agents to do the following job, start at different seeds.

Please use the proofread-translation skill to run a Monte Carlo translation-quality stress test on the following source/translation pair.

Goal:
- Check whether a large translation still contains serious translation-quality issues.
- Focus only on true actionable issues found in sampled lines; every candidate must be manually judged.
- Do not repeat global scans, old-report comparisons, or full terminology audits that have already been completed, unless I explicitly ask for them.

Inputs:
- Review mode: montecarlo
- Type: {game/novel/technical/subtitle/academic}
- Source language: {SOURCE_LANGUAGE}
- Target language: {TARGET_LANGUAGE}
- Source file: {SOURCE_FILE}
- Translation file: {TRANSLATION_FILE}
- Glossary file, optional: {GLOSSARY_FILE}
- Sample size per round: {SAMPLE_SIZE, default 5000}
- Confirmed-issue line exclusion set: {KNOWN_ISSUE_LINES, may be empty}

Scope for this stress test:
- Focus on HIGH translation-quality risks: mistranslation, misaligned line, omission, empty translation, severe over-translation/line bleed, AI/reviewer meta-language contamination, source-language residue, number/list-index errors, lost or translated code placeholders/tags, abnormal expansion, and hallucination.
- If an H9 expansion/hallucination issue is found in the sample, retranslate the full source line and provide that full replacement as the suggested translation.

Output requirements:
- Every issue must include: global line number, source text, current translation, issue explanation, severity, and a complete directly replaceable suggested translation.
- Every severity level (HIGH/MEDIUM/LOW) must include a complete suggested translation. Do not provide only a direction, a partial replacement, or meta wording such as "suggest changing to".
- The suggested translation field must contain only the final replacement text itself.
- If a candidate is a false positive, explain why and continue; it does not count as a failure.
- If a sampled line is in the confirmed-issue exclusion set, mark it as a known issue and exclude it; it does not count as a failure.

Convergence rule:
- Start counting from the translation state after the most recent applied fix.
- If a new true issue is found: report the full suggested translation and stop. The manager will apply the fix, then convergence counting must restart.
- If no new true issue is found, continue with a different seed.
- This lane converges after {CLEAN_ROUNDS, default 2} consecutive different seeds produce no new true issues.
- Multiple agents run in parallel, every lane must independently satisfy this convergence rule. O.W., all agent should do a totally new round after fixes of manager.

Environment note:
- On Windows PowerShell, force UTF-8 output before reading files or running scripts:
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
- If Python is used, set:
  $env:PYTHONUTF8='1'
  $env:PYTHONIOENCODING='utf-8'

Final response:
- List the seeds used.
- State whether convergence was reached.
- List any new true issues found.
- Summarize false-positive candidates.
- List excluded known-issue lines.
```

</details>
