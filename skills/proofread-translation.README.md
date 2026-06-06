# proofread-translation

proofread-translation 是 translation-workshop 内置的校对 skill / command，用于对照源文和译文，输出人工可读 summary，以及可被 translation-workshop 解析成审阅 HTML 的 fix proposal。

It reviews a translation against its source text and produces structured findings with directly applicable replacement suggestions.

## 中文说明

### 适用场景

- 源文 / 译文逐行校对。
- 大文件分块校对。
- Monte Carlo 抽样压力测试，用于判断大型译文是否还存在高风险问题。
- 将校对报告转成可接受、拒绝、人工改写的审阅 HTML。

### 两种版本

Codex skill：

```text
skills/codex/proofread-translation/SKILL.md
skills/codex/proofread-translation/references/proofread-workflow.md
```

Claude Code slash command：

```text
skills/claude/commands/proofread-translation.md
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
| `{source_path}` | 当前 source 文件 | 必填。被校对的源语言文件路径。 |
| `{translation_path}` | 当前 translation 文件 | 必填。要校对的译文文件路径。 |
| `{glossary_path}` | 当前 glossary 文件 | 可选。术语表路径；没有时为空。 |

通用用户参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `{output_dir2}` | `{project_dir}/report` | 校对报告输出目录。summary 和 fix proposal 会写到这里。 |
| `{language_pair}` | `ja->zh-CN` | 校对语言方向，例如 `ja->zh-CN`、`en->zh-CN`。 |
| `{style}` | `game` | 文本类型或风格，用于判断语气、术语、标点、叙事习惯。 |
| `{proofread_mode}` | `split` | 校对模式。只能选择 `split` 或 `montecarlo`。 |
| `{candidate_ratio}` | `1.5` | H9 异常扩写/幻觉候选阈值。译文相对源文过长时更容易进入候选。 |

`split` 模式参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `{split_size}` | `2000` | 每个分块的大致行数。split 模式会逐块做较完整的逐行校对。 |
| `{subagent}` | `False` | 是否要求 Agent 使用子 Agent 并行校对。仅 split 模式可用。 |
| `{subagent_count}` | `3` | 子 Agent 数量，仅在 `{subagent}=True` 时显示/使用。 |

`montecarlo` 模式参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `{montecarlo_size}` | `3000` | 每轮抽样行数。越大越严格，也越耗时。 |
| `{montecarlo_round_min}` | `2` | 最少抽样轮数，避免第一轮碰巧没发现问题就过早收敛。 |
| `{montecarlo_round_max}` | `5` | 最多抽样轮数。达到上限仍未收敛时应询问用户下一步。 |

`montecarlo` 与 `subagent` 在 translation-workshop 的默认提示词中互斥。若要同时做多 Agent 压力测试，建议直接在 Codex / Claude Code 客户端中手动运行。

### 模式选择

| 模式 | 适合情况 | 输出倾向 |
| --- | --- | --- |
| `split` | 想做较完整的逐行校对；文件中等或需要精查。 | 覆盖更全面，适合生成正式修正建议。 |
| `montecarlo` | 大文件压力测试；想判断是否还存在严重问题。 | 抽样收敛，重点发现高风险问题区域。 |

### 输出约定

校对最终输出拆成两个 Markdown 文件：

```text
{output_dir2}/{basename}_proofread_summary.md
{output_dir2}/{basename}_fix_proposal.md
```

`summary` 给人阅读，包含校对范围、模式、统计、风险说明和处理摘要。

`fix_proposal` 给 translation-workshop 解析，必须包含稳定的行号、原文、当前译文、问题说明和完整建议译文。应用会把它转换成人工审阅 HTML，让用户逐条接受、拒绝或手动改写。

Codex 版 skill 内置格式验证 helper，安装后位于：

```text
~/.codex/skills/proofread-translation/scripts/validate-fix-proposal.mjs
```

可手动检查 AI 生成的 fix proposal：

```bash
node ~/.codex/skills/proofread-translation/scripts/validate-fix-proposal.mjs path/to/file_fix_proposal.md
```

Claude Code 版也会安装同一个 helper 到：

```text
~/.claude/translation-workshop/scripts/validate-fix-proposal.mjs
```

可手动检查：

```bash
node ~/.claude/translation-workshop/scripts/validate-fix-proposal.mjs path/to/file_fix_proposal.md
```

### 核心规则

- 不修改源文件。
- 不直接覆盖译文，除非用户明确批准并且有备份。
- 每条建议都必须能直接替换当前译文行。
- `Suggested fix` / `Suggested translation` 只写目标语言最终译文，不写解释或局部替换说明。
- 报告识别依赖结构、行号和字段特征，不依赖单一硬编码文件名。
- Monte Carlo 抽样必须避免重复抽同一行；达到最大轮数仍未收敛时应向用户说明状态并请求下一步决定。

## English Guide

### When To Use

- Line-by-line proofreading for source / translation file pairs.
- Chunked proofreading for large files.
- Monte Carlo stress testing to check whether a large translation still contains high-risk issues.
- Converting proofreading reports into review HTML where suggestions can be accepted, rejected, or manually rewritten.

### Versions

Codex skill:

```text
skills/codex/proofread-translation/SKILL.md
skills/codex/proofread-translation/references/proofread-workflow.md
```

Claude Code slash command:

```text
skills/claude/commands/proofread-translation.md
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
| `{source_path}` | Current source file | Required. Path to the source-language file being reviewed. |
| `{translation_path}` | Current translation file | Required. Path to the translation file to review. |
| `{glossary_path}` | Current glossary file | Optional. Glossary path; empty when unavailable. |

Common user-editable parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `{output_dir2}` | `{project_dir}/report` | Output folder for the proofreading summary and fix proposal. |
| `{language_pair}` | `ja->zh-CN` | Review language pair, such as `ja->zh-CN` or `en->zh-CN`. |
| `{style}` | `game` | Genre or text type; used for judging tone, terms, punctuation, and narrative conventions. |
| `{proofread_mode}` | `split` | Review mode. Choose either `split` or `montecarlo`. |
| `{candidate_ratio}` | `1.5` | H9 abnormal expansion / hallucination candidate threshold. Longer translations relative to source are more likely to be flagged. |

`split` mode parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `{split_size}` | `2000` | Approximate lines per chunk. Split mode reviews chunks line by line. |
| `{subagent}` | `False` | Whether to ask the Agent to use sub-agents for parallel proofreading. Available only in split mode. |
| `{subagent_count}` | `3` | Number of sub-agents. Shown and used only when `{subagent}=True`. |

`montecarlo` mode parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `{montecarlo_size}` | `3000` | Lines sampled per round. Larger values are stricter but slower. |
| `{montecarlo_round_min}` | `2` | Minimum number of sampling rounds, to avoid premature convergence after one lucky clean round. |
| `{montecarlo_round_max}` | `5` | Maximum number of sampling rounds. If not converged by then, the Agent should ask the user what to do next. |

In translation-workshop's default prompts, `montecarlo` and `subagent` are mutually exclusive. For multi-agent stress tests, run the prompt manually in Codex / Claude Code.

### Mode Choice

| Mode | Best for | Output tendency |
| --- | --- | --- |
| `split` | More complete line-by-line review; medium files or final review passes. | Broader coverage, suitable for formal fix proposals. |
| `montecarlo` | Large-file stress testing; checking whether serious issues remain. | Sampling convergence, focused on high-risk issue discovery. |

### Output Contract

Final proofreading output is split into two Markdown files:

```text
{output_dir2}/{basename}_proofread_summary.md
{output_dir2}/{basename}_fix_proposal.md
```

`summary` is for human reading: scope, mode, statistics, risk notes, and processing summary.

`fix_proposal` is for translation-workshop parsing. It must contain stable line numbers, source text, current translation, issue explanation, and a complete suggested replacement. The app converts it into review HTML where users accept, reject, or manually rewrite each item.

The Codex skill includes a format validation helper after installation:

```text
~/.codex/skills/proofread-translation/scripts/validate-fix-proposal.mjs
```

You can manually check an AI-generated fix proposal with:

```bash
node ~/.codex/skills/proofread-translation/scripts/validate-fix-proposal.mjs path/to/file_fix_proposal.md
```

The Claude Code command installs the same helper to:

```text
~/.claude/translation-workshop/scripts/validate-fix-proposal.mjs
```

Manual check:

```bash
node ~/.claude/translation-workshop/scripts/validate-fix-proposal.mjs path/to/file_fix_proposal.md
```

### Core Rules

- Never modify the source file.
- Never overwrite the translation directly unless the user explicitly approves and a backup exists.
- Every suggestion must be a direct replacement for the current translation line.
- `Suggested fix` / `Suggested translation` must contain only the final target-language line, not explanations or partial edit instructions.
- Report discovery should rely on structure, line numbers, and field features, not one hard-coded filename.
- Monte Carlo sampling must avoid drawing the same line repeatedly; if max rounds are reached without convergence, report the state and ask the user for the next step.
