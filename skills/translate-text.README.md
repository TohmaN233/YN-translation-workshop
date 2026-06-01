# translate-text

translate-text 是 translation-workshop 内置的翻译 skill / command，用于把源文按行批量翻译成目标语言，并维护术语表、角色设定和分块翻译状态。

It translates source text line by line while preserving placeholders, glossary terms, character voice, and chunk order.

## 中文说明

### 适用场景

- 游戏文本、小说、脚本、字幕、技术文本等需要保持行号对应的翻译。
- 需要保留占位符、变量、控制码、标签、资源 ID 的文本。
- 需要维护术语表、角色设定、称呼关系或世界观名词的项目。
- 需要把大文件拆分翻译，再合并成一个最终译文文件的项目。

### 两种版本

Codex skill：

```text
skills/codex/translate-text/SKILL.md
skills/codex/translate-text/references/translation-workflow.md
```

Claude Code slash command：

```text
skills/claude/commands/translate-text.md
```

### 安装命令

推荐 GitHub 安装命令，安装版、便携版、未 clone 源码时都可用。需要 Node.js 18 或更新版本。推荐命令默认带 `--replace`，更新前会备份旧目标。

Codex：

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global --replace
```

Claude Code：

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent claude --global --replace
```

如果已经 clone 仓库，也可以用本地路径安装：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global --replace
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global --replace
```

推荐命令会更新已有目标，旧目标会先备份到 `~/.translation-workshop/skill-backups/`。

### 参数速查

自动填入参数：

| 参数 | 默认来源 | 说明 |
| --- | --- | --- |
| `{source_path}` | 当前 source 文件 | 必填。要翻译的源语言文件路径。 |
| `{translation_path}` | 当前 translation 文件 | 可选。已有译文或参考译文路径；没有时为空。 |
| `{glossary_path}` | 当前 glossary 文件 | 可选。术语表路径；没有时为空。 |

用户可编辑参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `{output_dir}` | `{project_dir}/AI_translation` | 翻译输出目录。最终译文、术语表、角色设定和工作区会写到这里。 |
| `{language_pair}` | `ja->zh-CN` | 翻译方向，例如 `ja->zh-CN`、`en->zh-CN`、`zh-CN->en`。 |
| `{style}` | `game` | 文本类型或风格。常见值：`game`、`novel`、`subtitle`、`technical`、`academic`。 |
| `{split}` | `True` | 是否按块处理大文件。开启后更适合长文本，也更容易恢复中断。 |
| `{split_size}` | `2000` | 每个分块的大致行数，仅在 `{split}=True` 时使用。 |
| `{subagent}` | `False` | 是否要求 Agent 调用子 Agent 并行翻译。短文本建议关闭。 |
| `{subagent_count}` | `3` | 子 Agent 数量，仅在 `{subagent}=True` 时显示/使用。 |
| `{work_desc}` | `None` | 作品说明、参考链接、本地设定文件路径，或手写背景说明。 |

### 生成提示词形态

Codex 使用 skill 调用：

```text
Use $translate-text ...
```

Claude Code 使用 slash command：

```text
/translate-text ...
```

未启用 subagent 时，提示词会要求单 Agent 完成翻译并输出：

```text
{output_dir}/{basename}_translated.txt
{output_dir}/glossary.json
{output_dir}/character_bible.md
{output_dir}/_workspace/
```

启用 subagent 时，提示词会额外要求：

- 各分块按原始顺序合并，不能丢行、重排。
- 术语表按 `src` 去重，冲突标记为 `inconsistent`。
- 角色设定按角色名合并，冲突时保留更详细的记录。

### 核心规则

- 译文文件只写最终译文，不写解释、标签或“建议译文”等元信息。
- 行对行文本必须保持行号对应，空行仍为空行。
- 占位符、变量、标签、控制码、路径和资源 ID 必须原样保留。
- glossary 中已确认的术语优先级最高。
- 游戏 / 脚本文本应优先保证目标语言自然，但不能改变剧情事实、角色关系和命名实体。

## English Guide

### When To Use

- Games, novels, scripts, subtitles, technical text, or any translation that must preserve line alignment.
- Text with placeholders, variables, control codes, tags, resource IDs, or file paths.
- Projects that need glossary maintenance, character notes, honorifics, relationship notes, or world-specific terms.
- Large files that should be split, translated, and merged into one final translation file.

### Versions

Codex skill:

```text
skills/codex/translate-text/SKILL.md
skills/codex/translate-text/references/translation-workflow.md
```

Claude Code slash command:

```text
skills/claude/commands/translate-text.md
```

### Install Commands

The GitHub install command is recommended. It works for installed builds, portable builds, and users who have not cloned the repository. Node.js 18 or newer is required. The recommended command includes `--replace` and backs up old targets before updating them.

Codex:

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent codex --global --replace
```

Claude Code:

```powershell
irm https://raw.githubusercontent.com/TohmaN233/YN-translation-workshop/main/scripts/install-skills.mjs | node - --github --agent claude --global --replace
```

Local checkout alternative:

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global --replace
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global --replace
```

The recommended command updates existing targets and backs up the old target under `~/.translation-workshop/skill-backups/`.

### Parameter Quick Reference

Auto-filled parameters:

| Parameter | Filled from | Meaning |
| --- | --- | --- |
| `{source_path}` | Current source file | Required. Path to the source-language file. |
| `{translation_path}` | Current translation file | Optional. Existing translation or reference translation path; empty when unavailable. |
| `{glossary_path}` | Current glossary file | Optional. Glossary path; empty when unavailable. |

User-editable parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `{output_dir}` | `{project_dir}/AI_translation` | Output folder for final translation, glossary, character bible, and workspace. |
| `{language_pair}` | `ja->zh-CN` | Translation direction, such as `ja->zh-CN`, `en->zh-CN`, or `zh-CN->en`. |
| `{style}` | `game` | Genre or text type. Common values: `game`, `novel`, `subtitle`, `technical`, `academic`. |
| `{split}` | `True` | Whether to process large files in chunks. Useful for long files and interruption recovery. |
| `{split_size}` | `2000` | Approximate lines per chunk. Used only when `{split}=True`. |
| `{subagent}` | `False` | Whether to ask the Agent to use sub-agents for parallel translation. Usually off for short files. |
| `{subagent_count}` | `3` | Number of sub-agents. Shown and used only when `{subagent}=True`. |
| `{work_desc}` | `None` | Work description, reference URL, local lore file path, or handwritten background notes. |

### Prompt Shape

Codex invokes the skill as:

```text
Use $translate-text ...
```

Claude Code invokes the command as:

```text
/translate-text ...
```

Without sub-agents, the prompt asks one Agent to produce:

```text
{output_dir}/{basename}_translated.txt
{output_dir}/glossary.json
{output_dir}/character_bible.md
{output_dir}/_workspace/
```

With sub-agents enabled, the prompt also requires:

- Merge translated parts in original order with no dropped or reordered lines.
- Dedupe glossary entries by `src`; mark conflicts as `inconsistent`.
- Merge character notes by character name; keep the more detailed record on conflicts.

### Core Rules

- The translation file must contain only final translated lines, not explanations or labels.
- Preserve one-to-one line alignment; empty lines stay empty.
- Preserve placeholders, variables, tags, control codes, paths, and resource IDs exactly.
- Confirmed glossary entries have the highest priority.
- For game / script text, keep the target language natural without changing plot facts, relationships, or named entities.
