# translation-workshop

[English README](README.en.md)

translation-workshop 是一个本地翻译 / 校对工作台。它用于把源文与译文按行配对，生成可人工改写的校对 HTML，辅助生成 Codex / Claude Code 的翻译与校对提示词，并把校对报告 Markdown 转换为可逐条审阅的 HTML。

动机在于市面上大多AI翻译工具我个人作为曾经参与过一些汉化项目的人来说，觉得对于翻译其实并不友好。AI目前的成品无论吹得再怎么天花乱坠也必须经过人工审核才有可能达到商业级的水平。因此缺乏翻译工作舒适/易于审校的前端本就是很大的致命伤。

所以这个项目旨在打造
1：不用AI的翻译人员也能用得舒服的前端工具。
2：使用AI的翻译人员能用Agent的AI翻译/校对能力极大提高效率，同时保证审阅过程的舒适便捷。
3：对于不懂对应语言的只是想翻译的同学，也是能纯靠AI进行翻译/校对/可视化结果。

项目内置Codex与Claude Code版本的 skills; 目前只支持Agent翻译，不支持单独调用API通过提示词工程翻译。

- [translate-text 说明](skills/translate-text.README.md)：批量翻译、术语表、角色设定。
- [proofread-translation 说明](skills/proofread-translation.README.md)：逐行校对、Monte Carlo 抽样校对和修正建议报告。

- Codex skill 目录版：`skills/codex/<skill-name>/SKILL.md`
- Claude Code slash command 版：`skills/claude/commands/<skill-name>.md`

## 当前功能

- Electron + React + TypeScript 桌面应用
- 中文 / English 双语 UI

<p align="center">
  <img src="graph_for_intro/face_ch.png" alt="中文界面" width="420">
  <img src="graph_for_intro/face_en.png" alt="English UI" width="420">
</p>

- 行对行校对 HTML 生成
- 双语文件模式和分离文件模式

支持txt和epub
基本使用方式：
选择源文件，选择翻译文件，选择输出文件夹，然后点击生成行对行html
输入双语翻译文件时需要选择哪一行为源语言
可只输入源文件，译文为空白进行单纯翻译工作
-支持输入文件夹
- HTML 分页、跳页、滚动位置记忆、人工改写状态
人工改写过的行标记颜色，下次启动自动定位位置（黄框）

<p align="center">
  <img src="graph_for_intro/t1.png" alt="行对行校对 HTML" width="920">
</p>

- txt/epub文件支持随时导出，txt文件额外支持随时写入修改到读取的txt文件本身或同步外部修改。(TXT 覆盖前自动时间戳备份)
- 可在翻译中随时浏览术语表，支持修改译名当页/全文替换，且自动标注与源语言对应缺失术语翻译（长名词覆盖短名词原则）（H3错误|句子变红）

<p align="center">
  <img src="graph_for_intro/t2.png" alt="术语表与术语替换" width="920">
</p>

-------------------------------
Agent运用部分
- 翻译提示词参数窗口与提示词生成

<p align="center">
  <img src="graph_for_intro/t3.png" alt="翻译提示词参数窗口" width="920">
</p>

- 校对提示词参数窗口与提示词生成
- Codex / Claude Code 交互式终端控制台（确保已安装CLI且已登录）

<p align="center">
  <img src="graph_for_intro/t4.png" alt="交互式 Agent 控制台" width="920">
</p>

- 校对 Markdown 报告识别、解析并生成审阅 HTML

<p align="center">
  <img src="graph_for_intro/t5.png" alt="校对报告审阅 HTML" width="920">
</p>

  -可与正文绑定，给正文所有对应行的内容标记校对文件发现的错误。
  -可直接跳转正文方便观察上下文。
  -可直接将AI建议翻译或者人工修正一键应用到正文。

<p align="center">
  <img src="graph_for_intro/t6.png" alt="正文与校对报告联动" width="920">
</p>

- 项目状态保存到输出目录下的 `.translation-workshop/` 随时可通过打开文件夹再次开启。

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
2. 查看内置 skill / command 路径和本地安装状态。可在控制台如powershell复制指令安装skill。
3. 选择源文 TXT / EPUB 文件，或选择源文件夹。
4. 可选选择译文 TXT / EPUB 文件，或选择译文文件夹。
5. 选择输出文件夹。
6. 生成行对行 HTML。
7. 在 HTML 中人工翻译/修改译文、跳页、搜索、替换术语/无译文时生成翻译提示词，打开agent让AI翻译，结束后导入翻译的TXT。
8. 生成校对提示词，复制或发送到交互式 Agent 控制台。
9. 校对完成后选择或自动查找 Markdown 报告，生成修正建议审阅 HTML。
10. 完成校对时使用 `写入 TXT` 覆盖绑定的译文 TXT，或使用 `导出 TXT` 另存一份。

## Codex Skill 配置

内置路径：

- 翻译：`skills/codex/translate-text`
- 校对：`skills/codex/proofread-translation`

应用只复制安装命令，不会自动写入你的全局 Codex 配置。推荐使用 GitHub 安装命令，安装版、便携版、未 clone 源码时都可用：

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global
```

如果你已经 clone 了仓库，也可以用本地路径安装：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global
```

安装目标：

- `~/.codex/skills/translate-text/SKILL.md`
- `~/.codex/skills/proofread-translation/SKILL.md`

安装脚本默认不覆盖已有 skill。需要更新时可加 `--replace`，脚本会先把旧目标备份到 `~/.translation-workshop/skill-backups/`。

## Claude Code Skill 配置

内置路径：

- 翻译：`skills/claude/commands/translate-text.md`
- 校对：`skills/claude/commands/proofread-translation.md`

应用只复制安装命令，不会自动写入你的全局 Claude Code 配置。推荐使用 GitHub 安装命令，安装版、便携版、未 clone 源码时都可用：

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent claude --global
```

如果你已经 clone 了仓库，也可以用本地路径安装：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global
```

安装目标：

- `~/.claude/commands/translate-text.md`
- `~/.claude/commands/proofread-translation.md`

安装脚本默认不覆盖已有 command。需要更新时可加 `--replace`，脚本会先把旧目标备份到 `~/.translation-workshop/skill-backups/`。

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
- 安装脚本默认跳过已有全局目标。
- `--replace` 会先备份具体目标文件 / 目录，再更新。
- `写入 TXT` 只有在 HTML 从 Electron 应用打开时才会写入绑定译文路径。
- Agent 控制台是真实终端交互；应用不会隐藏后台调用，也不会假装判断 Agent 已完成。完成后请手动同步译文或查找报告。

## 其他

压力测试：最后阶段可以考虑在自己的客户端使用以下提示词进行以下校对模式

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
