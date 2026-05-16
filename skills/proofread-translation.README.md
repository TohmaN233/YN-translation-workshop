# proofread-translation

proofread-translation 用于把源文和译文进行结构化校对，输出人工可读 summary 和可被 translation-workshop 解析的 fix proposal。它适合逐行校对、分块校对、Monte Carlo 抽样校对，以及后续生成审阅 HTML。

This skill reviews a translation against its source text and produces structured findings with directly applicable replacement suggestions.

## 两种版本 / Two Versions

Codex skill 版本：

```text
skills/codex/proofread-translation/SKILL.md
skills/codex/proofread-translation/references/proofread-workflow.md
```

Claude Code slash command 版本：

```text
skills/claude/commands/proofread-translation.md
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
- `{translation_path}`：当前译文文件路径
- `{glossary_path}`：当前 glossary 路径；没有 glossary 时为空

用户可在提示词参数窗口编辑：

- `{output_dir2}`：默认 `{project_dir}/report`
- `{language_pair}`：默认 `ja->zh-CN`
- `{style}`：默认 `game`
- `{proofread_mode}`：`split` 或 `montecarlo`，默认 `split`
- `{candidate_ratio}`：默认 `1.5`

`split` 模式参数：

- `{split_size}`：默认 `2000`
- `{subagent}`：默认 `False`
- `{subagent_count}`：仅 `{subagent}=True` 时使用，默认 `3`

`montecarlo` 模式参数：

- `{montecarlo_size}`：默认 `3000`
- `{montecarlo_round_min}`：默认 `2`
- `{montecarlo_round_max}`：默认 `5`

`montecarlo` 与 `subagent` 互斥。需要同时压力测试时，建议直接在 Agent 客户端里手动运行，不由 translation-workshop 默认生成。

## 输出约定

校对最终输出拆成两个 Markdown 文件：

```text
{output_dir2}/{basename}_proofread_summary.md
{output_dir2}/{basename}_fix_proposal.md
```

`summary` 给人阅读，包含校对范围、模式、统计、风险说明和处理摘要。

`fix_proposal` 给 translation-workshop 解析，必须包含稳定的行号、原文、当前译文、问题说明和完整建议译文。应用会把它转换成人工审阅 HTML，让用户逐条接受、拒绝或手动改写。

## 核心规则

- 不修改源文件。
- 不直接覆盖译文，除非用户明确批准并且有备份。
- 每条建议都必须能直接替换当前译文行。
- `Suggested fix` 只写目标语言最终译文，不写解释或局部替换说明。
- 报告识别依赖结构、行号和字段特征，不依赖单一硬编码文件名。
- Monte Carlo 抽样必须避免重复抽同一行；达到最大轮数仍未收敛时应向用户说明状态并请求下一步决定。

## 与应用的关系

translation-workshop 负责生成校对提示词、查找 Markdown 报告、解析 fix proposal，并生成审阅 HTML。skill 本身负责告诉 Agent 如何审查、如何分类、如何输出可解析的两文件报告。
