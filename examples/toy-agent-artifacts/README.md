# toy-agent-artifacts

Minimal project folder for verifying the three MVP cuts on branch `agent-workbench-evolution`:

| Cut | What to verify |
|-----|----------------|
| **1 — Unified protocol** | `npm run test:protocol-sync` (or `npm run verify:toy-agent-artifacts`) |
| **2 — Line validator** | Three candidates under `AI_translation/` with pass / line-count fail / tag fail |
| **3 — Artifact import** | Line-review HTML sidebar → **Agent translation artifacts** → import draft / repair prompt |

## Layout

```
toy-agent-artifacts/
  source.txt                          ← 7-line JP source (tags + placeholder + empty line)
  glossary.json
  AI_translation/
    source_translated.txt             ← valid candidate (import should succeed)
    source_mismatch_translated.txt    ← 6 lines → blocking line_count_mismatch
    source_tagbroken_translated.txt   ← line 4 故意去掉标签（用于测试「改文件 → 刷新 → 报错消失」）
  .translation-workshop/              ← created by setup script
```

No `translation.txt` is bound on purpose — this simulates **translate-only** mode where the agent wrote candidates into `AI_translation/`.

## Quick start (recommended)

From the repository root:

```cmd
npm run setup:toy-agent-artifacts
npm run verify:toy-agent-artifacts
npm run dev
```

Or double-click `open-toy-example.cmd` in this folder (runs setup + starts dev).

In the app:

1. **Open project folder** → select this directory (`examples/toy-agent-artifacts`).
2. Confirm `source.txt` is loaded; translation path may stay empty.
打开旧版行审 HTML 时，应用会在 `loadHtmlViewerTab` 前自动调用 `upgradeLegacyLineReviewHtml`，无需手动重新生成。若 HTML 缺少 Agent 产物面板、旧版导入逻辑或 `lineReviewPath`，打开时会就地升级并写回磁盘。
4. In the workbench left sidebar, open **Agent translation artifacts** (智能体翻译产物).

## UI checks (Cut 3)

| Candidate | Expected badge | Action |
|-----------|----------------|--------|
| `source_translated.txt` | Pass / OK | **Import draft** → translation column fills; final TXT still not written |
| `source_mismatch_translated.txt` | 行数 blocking | **定位到问题行** 提示行数差异；**生成格式修复提示词** 填入 Agent 输入框 |
| `source_tagbroken_translated.txt` | 标签 blocking（第 4 行缺 `<color=#FF0000>` 与 `</color>`） | 用「打开产物文件」改好并保存 → 点 **刷新** → 应变为「通过」 |

### 修复后刷新应消失

校验读的是磁盘上的 `AI_translation/*.txt`，不是行审 HTML 里的草稿。

1. 打开 `source_tagbroken_translated.txt`，把第 4 行改成与 `source_translated.txt` 相同：  
   `<color=#FF0000>{player_name}你好</color>`
2. 保存文件
3. 行审页点 **刷新** → 该卡片应显示「通过」，阻断信息消失

`source_translated.txt` 本身应始终为「通过」，不应报标签错误。

### 写入 TXT

生成 HTML 时若未选译文文件，工具栏里 **写入 TXT** 会先隐藏（仅 EPUB 源永远没有此项）。

绑定 `.txt` 译文路径后按钮会出现，无需重新生成 HTML：

- **选择其他文件** → 选一个 `.txt` 译文
- **同步译文** → 从已绑定的译文路径读入
- **导入为译文草稿** → 自动绑定该候选 `.txt` 路径，随后可 **写入 TXT** 写回磁盘

## Headless only

```cmd
npm run verify:toy-agent-artifacts
```

Runs protocol sync + validator matrix + discovery without Electron.

## Cut 1 detail

The model-independent workflow contracts and JSON schemas live in
`translation-protocol/`. Run `npm run test:protocol` to verify the packaged
runtime references.
