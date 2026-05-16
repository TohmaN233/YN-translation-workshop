# translate-text

translate-text 用于把源文按行批量翻译成目标语言，并维护术语表、角色设定和分块翻译状态。它适合游戏文本、小说、脚本、字幕、技术文本等需要保持行号、占位符和术语一致性的工作。

This skill translates source text line by line while preserving placeholders, glossary terms, character voice, and chunk order.

## 两种版本 / Two Versions

Codex skill 版本：

```text
skills/codex/translate-text/SKILL.md
skills/codex/translate-text/references/translation-workflow.md
```

Claude Code slash command 版本：

```text
skills/claude/commands/translate-text.md
```

## 安装命令

安装 Codex 版本：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent codex --global
```

安装 Claude Code 版本：

```bash
node /path/to/translation-workshop/scripts/install-skills.mjs --agent claude --global
```

安装脚本默认跳过已有目标。需要更新时加 `--replace`，旧目标会先备份到 `~/.translation-workshop/skill-backups/`。

## 输入参数

translation-workshop 会自动填入：

- `{source_path}`：当前源文文件路径
- `{translation_path}`：当前译文文件路径；没有译文时为空
- `{glossary_path}`：当前 glossary 路径；没有 glossary 时为空

用户可在提示词参数窗口编辑：

- `{output_dir}`：默认 `{project_dir}/AI_translation`
- `{language_pair}`：默认 `ja->zh-CN`
- `{style}`：默认 `game`
- `{split}`：默认 `True`
- `{split_size}`：默认 `2000`
- `{subagent}`：默认 `False`
- `{subagent_count}`：仅 `{subagent}=True` 时使用，默认 `3`
- `{work_desc}`：默认 `None`；可填写作品说明、链接或本地参考文件路径

## 输出约定

无 subagent 时，最终输出通常为：

```text
{output_dir}/{basename}_translated.txt
{output_dir}/glossary.json
{output_dir}/character_bible.md
{output_dir}/_workspace/
```

启用 subagent 时，各部分翻译必须按原始顺序合并为一个译文文件，术语表按 `src` 去重并标记冲突，角色设定按角色名合并。

## 核心规则

- 译文文件只写最终译文，不写解释、标签或“建议译文”等元信息。
- 行对行文本必须保持行号对应，空行仍为空行。
- 占位符、变量、标签、控制码、路径和资源 ID 必须原样保留。
- glossary 中已确认的术语优先级最高。
- 游戏 / 脚本文本应优先保证目标语言自然，但不能改变剧情事实、角色关系和命名实体。

## 与应用的关系

translation-workshop 负责生成提示词、启动交互式 Agent 控制台和同步译文。skill 本身负责告诉 Agent 如何翻译、如何拆分、如何维护术语和角色设定。
