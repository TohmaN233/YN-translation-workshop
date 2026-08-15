# Proofreading Workflow

## Role

Adopt this role: professional translation reviewer for the requested language
pair. Prioritize accurate source comprehension, fluent target-language
judgment, terminology discipline, and directly applicable replacement
translations.

Use this protocol to proofread a translation against its source text with
explicit severity labels, line references, and repair options.

## Inputs

Parse the user's request for:

- Review mode: `montecarlo` or `split N`.
- Translation type: `game`, `novel`, `technical`, `subtitle`, or `academic`.
- Source language and target language, if stated or inferable.
- Source file path and translation file path.
- Optional glossary file path.

If a required input is missing, ask only for that item. If the language pair is
not explicit, infer it from file names, content, glossary entries, or the user's
wording; ask only when the target language remains ambiguous.

Flexible input formats (all equivalent):

```text
"montecarlo; game; source.txt; translation.txt; glossary.json"
"split 500; game; source.txt; translation.txt"
"split 500; game"  → then ask for source and translation paths
```

If review mode is not provided, ask:

```text
校对模式？
  1. montecarlo / 蒙特卡洛   （快速抽样收敛，适合大文件初筛）
  2. split N    / 分片逐行    （按N行拆分，逐片精审，适合精细校对）
     示例：split 500 = 每500行为一片
```

If translation type is not provided or unclear, ask:

```text
Genre？
  1. game    / 游戏    （RPG/视觉小说/剧情游戏）
  2. novel   / 小说    （文学/轻小说/同人文）
  3. technical / 技术  （技术文档/说明书）
  4. subtitle / 字幕  （影视字幕/配音脚本）
  5. academic / 学术  （论文/研究报告）
```

## Language Pair Configuration

Before review, set a lightweight language profile:

- `source_language`: infer from user request, file names, content, or glossary.
- `target_language`: infer the same way; ask only if the replacement translation
  language is unclear.
- `target_conventions`: punctuation, quotes, pronouns, register, capitalization,
  spacing, and sentence rhythm for the target language.

Use target-language conventions for LOW issues. Do not apply Chinese-specific
rules to English targets. Examples:

| Target language | Apply |
|-----------------|-------|
| Chinese | Chinese punctuation, `他/她` checks when glossary gender is reliable, Chinese quote/spacing conventions |
| English | English punctuation, capitalization, articles, tense/aspect consistency, `he/him/his`, `she/her/hers`, and `they/them/their/theirs` pronoun checks |
| Other | Use that language's normal grammar, punctuation, pronoun, and register expectations; ask only if uncertain |

### Output Language Contract

Write all Markdown report prose in `target_language`, including headings,
summaries, issue explanations, confidence notes, and handling options. Keep
parser-required fixed labels in English, especially `Source`, `Current
translation`, `Issue`, `Suggested fix`, and `Accept suggestion`.

Raw source text stays unchanged. Current translation quotes stay unchanged from
the translation file. Glossary terms keep their glossary spelling.

Before finalizing a `.md` report, run a language consistency pass:

1. Confirm explanations, summaries, and handling options use `target_language`.
2. Confirm every `Suggested fix` is a complete replacement in `target_language`.
3. Confirm fixed parser labels remain in English.
4. Confirm `Source` and `Current translation` quote the full exact row text, not
   fragments or explanations.
5. If `target_language` is ambiguous, ask before producing the report.

## Severity Levels

### HIGH — 可能造成误解或严重失准
必须审查，通常需要修改。

| 代码 | 类型 | 描述 |
|------|------|------|
| `H1` | 错译 | 语义理解错误，译文与原文意思相悖或严重偏离 |
| `H2` | 张冠李戴 | 说话人/动作主体搞错（尤其对话、代词指代） |
| `H3` | 术语不符 | 与译名表/术语表中已确定的译法不一致（经过假阳性过滤后确认） |
| `H4` | 未译句 | 整句或整段原文未翻译，直接保留源语言；检测规则按源语言配置 |
| `H5` | 漏译 | 原文某段内容在译文中完全消失（非有意删节） |
| `H6` | 增译 | 译文出现原文中没有的信息（非有意意译补充） |
| `H7` | AI污染 | AI思考过程/元语言混入译文（自我对话、确认语、翻译说明等） |
| `H8` | 性别/代词错误 | 术语表标注了角色性别或代词，但译文中使用了不匹配的目标语代词 |
| `H9` | AI膨胀/幻觉 | 译文相对原文异常膨胀：AI加戏、串行、胡言乱语。通过长度比异常检测触发 |

### MEDIUM — 质量问题，影响流畅性或准确性
建议审查，视上下文决定是否修改。

| 代码 | 类型 | 描述 |
|------|------|------|
| `M1` | 语境断裂 | 与前后段落/句子的逻辑或信息不连贯 |
| `M2` | 语气失配 | 角色/叙述者的语气/口吻与上下文不符（如正式→随意） |
| `M3` | 文化误处理 | 文化特定表达处理不当（直译造成歧义，或过度本土化） |
| `M4` | 模糊译法 | 译文可以被理解为多种意思，但原文只有一种意思 |
| `M5` | 术语摇摆 | 同一概念/名称在译文中译法不统一（但不在术语表中） |

### LOW — 目标语言表达问题，不影响理解
可选修改，视风格规范决定。

| 代码 | 类型 | 描述 |
|------|------|------|
| `L1` | 语法错误 | 目标语言语法不正确 |
| `L2` | 标点问题 | 标点符号不符合目标语言规范（如中文目标语混用英文标点） |
| `L3` | 表达不自然 | 语义正确但读来生硬，有"翻译腔" |
| `L4` | 格式问题 | 排版、换行、空格等格式与原文约定不符 |

## Translation Type Profiles

不同类型的翻译对应不同的检查重点和风格预期。

### `game` — RPG/视觉小说/剧情游戏

```text
重点检查：H2（对话说话人），H3（道具/技能/地名术语），H8（角色性别），M2（角色口吻一致性）
风格预期：对话生动自然，角色有各自口癖；UI文字简洁；技能/道具名需与官方一致或内部统一
特别关注：
  - 选项文本长度（过长可能超出UI框）
  - 角色语气标签（例：温柔、傲娇、中二）
  - 人称代词一致性（"我/本座/咱"等不混用）
```

### `novel` — 文学/轻小说/同人文

```text
重点检查：H1（语义准确），M2（叙事腔调），M3（文化元素），L3（翻译腔）
风格预期：流畅自然的目标语表达；文学手法（比喻、排比）需对应处理而非直译
特别关注：
  - 内心独白语气（是否与叙事者声音一致）
  - 比喻/意象的跨文化适配
  - 章节/场景切换处的衔接感
```

### `technical` — 技术文档/说明书/API文档

```text
重点检查：H1（精确性），H3（术语一致），H4（不遗漏），H5（完整性），L1（语法规范）
风格预期：准确、简洁、一致；术语需精确统一；无歧义
特别关注：
  - 数字、单位、格式是否保留
  - 代码/命令不应被翻译
  - 注意事项/警告标识的语气（必须/建议/可选）
```

### `subtitle` — 影视字幕/配音脚本

```text
重点检查：H4（未译），M1（上下文连贯），M2（角色口吻），L3（口语化）
风格预期：口语化，符合目标语说话节奏；尽量保留情感强度
特别关注：
  - 字幕长度约束（每行建议<=20字）
  - 语气词、叹词的处理
  - 同一角色不同场合的语气变化是否合理
```

### `academic` — 学术论文/研究报告

```text
重点检查：H3（术语一致），H5（完整性），H1（准确性），L1（正式语法）
风格预期：正式、客观、术语精确；引用格式保持原样
特别关注：
  - 专业术语的统一性（同一论文中不能有两种译法）
  - 脚注/引用不应消失
  - 被动句的处理（学术文体常用被动）
```

## Common Preprocessing (Steps 1-3.5)

以下步骤在两种模式下均需执行。

### Step 1: 加载资源

```python
import pathlib, json

source_lines      = pathlib.Path(SOURCE_FILE).read_text(encoding="utf-8").splitlines()
translation_lines = pathlib.Path(TRANSLATION_FILE).read_text(encoding="utf-8").splitlines()

def detect_gender(info):
    """Return 'female' / 'male' / 'unknown' / None."""
    if not info:
        return None
    s = info.lower()
    # 女先于男 —— "female" 含 "male"
    if "女性" in info or "female" in s:  return "female"
    if "男性" in info or "male"   in s:  return "male"
    if "未知" in info or "unknown" in s: return "unknown"
    return None

def looks_like_character(info):
    if not info: return False
    s = info.lower()
    return any(k in info for k in ("角色", "人名", "人物")) \
        or any(k in s    for k in ("character", "char"))

glossary, gender_map, missing_gender = [], {}, []
if GLOSSARY_FILE and pathlib.Path(GLOSSARY_FILE).exists():
    glossary = json.load(open(GLOSSARY_FILE, encoding="utf-8"))
    for e in glossary:
        info = e.get("info") or ""
        g = detect_gender(info)
        if g in ("male", "female"):
            gender_map[e["src"]] = g
        elif g is None and looks_like_character(info):
            missing_gender.append(e["src"])
```

### Step 2: 分段对齐

将源文本和译文按自然段落/句子对齐，形成平行段落对。

**对齐策略**（按优先级）：
1. **行号对齐**：若源文和译文行数相同，直接按行号一一对应（最常见于游戏文本）
2. **章节标题对齐**：`# Chapter N` <-> `# 第N章` 等
3. **段落计数对齐**：按段落编号对应（假设译者未合并/拆分段落）
4. **场景分隔符对齐**：`---` 分隔的场景

若行/段落数差异 > 10%：标注

```text
段落数不匹配（源：[N] 段，译：[M] 段）
可能存在漏译或合并段落。将按顺序对齐，差异处手动核查。
```

### Step 3: 术语假阳性过滤（H3 预处理）

**在标记任何 H3 问题之前，必须先执行此过滤步骤。**

术语表检查的最大误报来源：短术语命中了长术语的子串，或普通词汇恰好与专有名词重合。

#### 过滤规则

```python
def get_longest_matching_terms(src_text, glossary):
    """
    只保留在 src_text 中匹配到的、不被更长匹配术语覆盖的术语。
    即：若 "ハルマ" 和 "ハルマゲドン" 都命中，只保留 "ハルマゲドン"。
    """
    hits = [(e["src"], e["dst"]) for e in glossary if e["src"] in src_text]
    # 按长度降序，去掉被更长术语包含的短术语
    hits.sort(key=lambda x: len(x[0]), reverse=True)
    filtered = []
    covered = ""
    for src_term, dst_term in hits:
        if src_term not in covered:
            filtered.append((src_term, dst_term))
            covered += src_term
    return filtered
```

**过滤逻辑说明**：
- 若原文中出现 `ハルマゲドン`，术语表同时有 `ハルマ->哈尔玛` 和 `ハルマゲドン->哈米吉多顿`：
  - 只检查 `ハルマゲドン` 是否译成 `哈米吉多顿`
  - 不检查 `ハルマ` 是否出现（它是 `ハルマゲドン` 的子串，不独立触发）
- 若原文中 `ハルマ` 单独出现（非 `ハルマゲドン` 的一部分）：
  - 正常检查

#### 生成过滤矛盾表

对全文执行扫描后，**先输出一张过滤矛盾表**，再进入校对：

```markdown
## 术语矛盾预扫描

| 行号 | 原文术语 | 标准译名 | 实际译文片段 | 过滤状态 | 原因 |
|------|---------|---------|------------|---------|------|
| 67   | ハルマゲドン | 哈米吉多顿 | 哈尔玛吉多顿 | 确认问题 | 译名偏差 |
| 1169 | ハルマ | 哈尔玛 | （被ハルマゲドン覆盖） | 已过滤 | 子串命中 |
```

只有「确认问题」的行才进入 H3 标注。

### Step 3.5: 长度异常预扫描（H9 预处理）

Before semantic review, scan all aligned pairs for abnormal expansion: AI-added
content, line bleed, hallucination, or leaked meta-language. Use display width
for CJK text when possible.

| 语言配置 | 宽筛 `ratio` | 精筛超出宽度 | 说明 |
|----------|---------------|--------------|------|
| `target:Chinese` | 1.5 | 32 | 适合日/英等语言翻成中文的常见压缩或接近等长情况 |
| `target:English` | 1.8 | 48 | 英文译文通常比日文/中文源文更长，默认放宽 |
| `default` | 1.7 | 40 | 其他语言对的保守初始值，按实际文本调整 |

Flag H9 only when the source line is long enough and the target exceeds both the
ratio and absolute-width threshold. H9 may overlap with H6/H7; report each
applicable issue separately.

## 自动化检查模块（两种模式共用）

以下检查在两种模式中均按需调用。

### 检查 H4 — 源语言未翻译

```python
SOURCE_RESIDUE_PATTERNS = {
    "Japanese": [
        r'[぀-ゟ]+',   # 平假名
        r'[゠-ヿ]+',   # 片假名
        r'[一-鿿]{2,}(?=[ぁ-ん])',  # 汉字接假名（日语特征组合）
    ],
    # Add source-language residue patterns as needed. For English source text,
    # prefer semantic judgment over blindly flagging every ASCII word because
    # names, UI keys, code, and quoted phrases may be intentionally preserved.
}
patterns = SOURCE_RESIDUE_PATTERNS.get(source_language, [])
for i, (src, tgt) in enumerate(pairs):
    for pat in patterns:
        if re.search(pat, tgt):
            flag(H4, line=i+1, src=src, tgt=tgt,
                 note=f"target contains likely untranslated source-language text: {re.findall(pat, tgt)}")
```

注意：只启用与源语言相符的残留检测。若目标文本有意保留原文引用、专名、代码、UI key 或术语，标为待核查或不标。

### 检查 H7 — AI思考过程污染

```python
AI_CONTAMINATION_PATTERNS = [
    r'^(好的[，,]|当然[，,]|以下是|下面是|这是.*?翻译|根据原文|作为.*?翻译)',
    r'^(Translation:|Here is|Sure[,，]|Of course)',
    r'(我来翻译|我将翻译|请看以下翻译|翻译如下|译文如下)',
    r'(让我.*?思考|首先.*?分析|综合.*?来看|综上所述)',
    r'(原文是.*?[，,].*?译文是|对应的(中文|英文|目标语)是|应该译为)',
    r'(the source says|the translation should be|translated as follows)',
]
for i, (src, tgt) in enumerate(pairs):
    for pat in AI_CONTAMINATION_PATTERNS:
        if re.search(pat, tgt, re.IGNORECASE):
            flag(H7, line=i+1, src=src, tgt=tgt,
                 note=f"疑似AI元语言混入：匹配到模式")
```

### 检查 H8 — 性别/代词错误

```python
def normalize_language_name(name):
    aliases = {
        "zh": "Chinese", "zho": "Chinese", "中文": "Chinese", "汉语": "Chinese",
        "en": "English", "eng": "English", "英文": "English", "英语": "English",
        "ja": "Japanese", "jpn": "Japanese", "日文": "Japanese", "日语": "Japanese",
    }
    return aliases.get(str(name).strip(), str(name).strip())

PRONOUN_SETS = {
    "Chinese": {
        "male": ["他", "他的", "他们"],
        "female": ["她", "她的", "她们"],
        "neutral": ["TA", "ta"],
        "match": "substring",
    },
    "English": {
        "male": ["he", "him", "his"],
        "female": ["she", "her", "hers"],
        "neutral": ["they", "them", "their", "theirs"],
        "match": "word",
    },
}

target_lang = normalize_language_name(target_language)
pronouns = PRONOUN_SETS.get(target_lang)

def contains_pronoun(text, pronoun, match_mode):
    if match_mode == "word":
        return re.search(rf"(?<![A-Za-z]){re.escape(pronoun)}(?![A-Za-z])", text, re.IGNORECASE)
    return pronoun in text

if pronouns:
    for i, (src, tgt) in enumerate(pairs):
        for char_src, gender in gender_map.items():
            if char_src not in src:
                continue

            normalized_gender = {
                "男性": "male", "男": "male", "male": "male", "m": "male",
                "女性": "female", "女": "female", "female": "female", "f": "female",
                "中性": "neutral", "无性别": "neutral", "非二元": "neutral",
                "neutral": "neutral", "nonbinary": "neutral", "they/them": "neutral",
            }.get(str(gender).strip().lower(), str(gender).strip())

            wrong_sets = {
                "male": ["female"],
                "female": ["male"],
                "neutral": ["male", "female"],
            }.get(normalized_gender, [])

            for wrong_set in wrong_sets:
                for wrong in pronouns[wrong_set]:
                    if contains_pronoun(tgt, wrong, pronouns["match"]):
                        flag(H8, ...)
```

> **注意**：H8 只在目标语言存在可检测的性别/代词形式且该行确实出现相关角色时触发。英文默认检查 `he/him/his`、`she/her/hers`、`they/them/their/theirs`；但对 male/female 角色不要把 singular `they` 自动判错，除非术语表明确要求不用。多角色同行或代词省略语言加注"（待核查）"或跳过自动标注。

### 检查 H3 — 术语不符

只处理 Step 3 中标记为「确认问题」的行，不重复扫描。

### 检查 H1/H2/H5/H6/M1-M5/L1-L4（语义/语用层）

**分析提示框架**（内部使用）：

```text
源文：[源文本]
译文：[译文]
上下文（前段）：[前一段译文摘要]
翻译类型：[type]
语言对：[source_language] -> [target_language]
术语表：[相关术语对照]

检查项：
1. 语义是否准确？（H1）
2. 若含对话，说话人/动作主体是否正确？（H2）
3. 译文是否含原文没有的信息？（H6）
4. 与前段的衔接是否自然？（M1）
5. 语气/口吻是否符合[type]要求？（M2）
6. 是否有文化误处理？（M3）
7. 是否存在歧义？（M4）
8. 是否有语法/标点/自然度问题？（L1-L4）
```

## Mode A: Monte Carlo (抽样收敛)

**适用场景**：大文件（万行级）快速定位问题热点区域，不需要逐行审查。
**核心思路**：先用自动化检查批量扫全文，再对剩余问题用随机抽样逐轮收敛。

### A-Step 1: 全文自动化预扫描

在 Step 3 / 3.5 完成后，对全文执行所有可自动化的检查：

```text
全文自动化扫描（共 N 对）：
  H3 术语不符：扫完（基于过滤矛盾表）
  H4 未译句：扫完（正则匹配）
  H7 AI污染：扫完（正则匹配）
  H8 性别错误：扫完（术语表+代词）
  H9 长度异常：扫完（宽度比较）
```

这些检查是 O(N) 的，不需要抽样。将所有命中记录到 `auto_findings`。

### A-Step 2: 区域重要性分类

Split the full file into 500-1000 line regions and classify by automated finding density:

- `HOT`: density > 0.05
- `WARM`: density > 0.01
- `COLD`: otherwise

Keep a compact heat map in the summary, but do not mix heat-map prose into `[basename].proofread.json`.

### A-Step 3: 分层随机抽样

Sampling quotas: `HOT` 30%, `WARM` 15%, `COLD` 5%. Sample only lines that have not been semantically reviewed in previous Monte Carlo rounds.

Required bookkeeping:

- Maintain `sampled_set` across all rounds.
- Draw from `available = all_lines - sampled_set`.
- Remove both clean lines and finding lines from future sampling once reviewed.
- Mark a region `FULLY_SAMPLED` after at least 80% coverage and reallocate its quota.
- Deduplicate final findings by `(line_num, issue_code)`.

### A-Step 4: 收敛迭代

Default convergence: `MIN_ROUNDS=2`, `MAX_ROUNDS=5`, `CLEAN_NEEDED=2`. Do not declare convergence before `MIN_ROUNDS`; converge only after two consecutive clean rounds with no new deduplicated findings.

**未收敛处理**：若达到最大轮数仍未收敛，不要直接硬停。先向用户报告当前状态并请求下一步决定：

```text
Reached round 5 and still found new issues in the latest round.
Unsampled lines remaining: [N] / [TOTAL] ([PERCENT]%).
Hot regions:
  - R03 lines 1000-1499, density 0.08
  - R07 lines 3500-3999, density 0.06

Choose next step:
  [c] continue sampling another 3 rounds
  [s] switch HOT regions to split-review
  [q] stop and write the current findings report
```

### A-Step 5: 生成审查报告

Write the final two-file output required by the Final Output Contract: `[basename]_proofread_summary.md` for human status and `[basename].proofread.json` for structured findings. Do not edit the translation file in Monte Carlo mode.

## Mode B: Split-Review (checkpointed full review / 分段保存的逐行审查)

**适用场景**：对文件（或文件的某个区域）进行精细的逐行审查，并定期保存进度，防止长任务丢失。
**核心思路**：split N 表示 checkpoint/save interval，不是"只审 N 行"。完整审查 assigned range → 每 N 行保存/汇报一次 → 发现问题 → 用户确认修复 → 修复写回主文件 → 继续到范围结束。

### B-Step 1: 拆分文件

```python
CHUNK_SIZE = N  # checkpoint interval，用户指定，如 500

total_pairs = len(aligned_pairs)
num_chunks = (total_pairs + CHUNK_SIZE - 1) // CHUNK_SIZE

chunks = []
for i in range(num_chunks):
    start = i * CHUNK_SIZE
    end = min((i + 1) * CHUNK_SIZE, total_pairs)
    chunks.append((start, end))
    # 写出拆分文件以便追踪
    # chunk_src_{i}.txt, chunk_tgt_{i}.txt（可选，仅当需要外部工具时）
```

输出 checkpoint 概览：

```text
文件拆分完成（每片 500 行）：
  片段 1/10：行 0-499    (500 对)
  片段 2/10：行 500-999  (500 对)
  ...
  片段 10/10：行 4500-4832 (333 对)

将从片段 1 开始逐行审查；必须覆盖完整 assigned range。
```

### B-Step 2: 逐片审查循环

对每个 checkpoint 片段，执行完整的检查流程：

```text
处理片段 [K]/[N]：行 [start]-[end]
```

#### 2a. 自动化检查（该片段范围内）

对该片段执行所有可自动化的检查：
- H3 术语不符（基于预扫描过滤矛盾表，只取该片段范围内的命中）
- H4 未译句
- H7 AI污染
- H8 性别/代词错误
- H9 长度异常

#### 2b. 逐行语义审查

对该片段的每一行执行语义/语用层检查。为管理上下文窗口，采用滑动窗口：

```text
审查行 [i]：
  上下文：前2行摘要 + 后2行摘要
  当前行：源文 / 译文
  执行 H1/H2/H5/H6/M1-M5/L1-L4 检查
```

**批处理优化**：实际操作中不必真的逐行单独审查。将片段按 200-300 行为一批（默认），每批完整阅读后一次性标注。关键是**不跳过任何行**。

#### 2c. 片段审查报告

Record findings using the final block format in "标注格式（两种模式通用）". Use global line numbers only. Do not create a separate chunk-report format unless the user explicitly asks for one.

### B-Step 3: 修复与写回

Do not edit the translation file unless the user explicitly approves fixes. If writing fixes, modify the main translation file, not temporary chunk files, and verify the target line still matches the expected old translation before replacing it. Report applied/skipped counts.

### B-Step 4: 全局摘要

After all chunks are reviewed, write the final two-file output required by the Final Output Contract. The summary records chunk coverage and counts; the findings JSON contains only remaining structured findings.

## 标注格式（两种模式通用）

**每条标注必须包含以下结构**：

```markdown
### H1-001 | MC L123
**Source**: `[源文本，逐字复制完整原文行]`
**Current translation**: `[当前译文，逐字复制完整译文行]`
**Issue**: [使用 target_language 简述问题；若有不确定性加注"（待核查）"]
**Suggested fix**: `[修正后的完整目标语译文]`
- [ ] Accept suggestion
```

> **默认操作规则**：
> - 所有严重级别（HIGH/MEDIUM/LOW）都必须提供完整 `Suggested fix`
> - H9 膨胀/幻觉也必须根据原文重译一遍，给出完整目标语译文
> - 是否采纳由用户决定；不得因为默认忽略或等待人工判断而省略替换译文
> - split-review 使用 `Chunk 001 L123` 替代 `MC L123`
> - `L<N>` 是人类可读的全局 1-based 行号，映射到 `source_lines[N-1]` 和 `translation_lines[N-1]`

## Final Output Contract

This two-file contract overrides any older single-report examples.

Write final proofreading output as one human summary Markdown file plus one machine-readable JSON findings file with the same basename in the translation file directory:

- Human summary: `[basename]_proofread_summary.md`
- Structured findings JSON: `[basename].proofread.json`

The summary is for human reading and dashboards. The JSON findings file is for translation-workshop parsing, review HTML generation, and safe write-back review. Do not mix summary prose into the JSON findings file.

The JSON file must be valid UTF-8 JSON and should use this schema shape:

```json
{
  "schemaVersion": "1.0",
  "documentId": "<basename>",
  "findings": [
    {
      "id": "H3-001",
      "severity": "H3",
      "type": "terminology",
      "sourceLine": 123,
      "translationLine": 123,
      "sourceText": "<source text verbatim>",
      "currentTranslation": "<current translation verbatim>",
      "suggestedFix": "<complete replacement in target_language>",
      "rationale": "<brief explanation in target_language>",
      "agentId": "Chunk 001"
    }
  ]
}
```

Required fields per finding: `id`, `severity`, `type`, `sourceLine`, `translationLine`, `sourceText`, `currentTranslation`, `suggestedFix`, and `rationale`. `agentId` is required when output is produced by subagents or chunks.

`sourceLine` and `translationLine` are global 1-based line numbers. They map to `source_lines[N-1]` and `translation_lines[N-1]`. `suggestedFix` must be a complete replacement line in the target language, not an explanation or partial edit.

When output was produced in parallel, merge and renumber before finalizing: each finding ID such as `H1-001`, `M2-004`, or `L1-003` must appear only once in the final JSON findings file.

## Key Rules

### 通用规则
- **报告语言固定**：整份 `.md` 报告的标题、摘要、问题解释、置信度说明和处理选项必须使用 `target_language`
- **固定字段名保持英文**：结构化报告中用于程序解析的字段名保持英文，例如 `Source`、`Current translation`、`Issue`、`Suggested fix` 和 `Accept suggestion`
- **替换译文语言固定**：`Suggested fix` 字段必须使用 `target_language`；这是写回文件的文本，不是说明文字
- **给出位置**：每条标注必须包含全局 1-based 行号，如 `L1234`，后续程序处理需要；不要输出内部 batch/chunk 编号，例如 `B12 raw345`。如果中间过程产生了 `raw345`，最终报告只写全局行号 `L345`
- **提供完整原文对照**：每条标注同时显示该行完整原文和完整当前译文，不要只截取片段或只描述问题
- **`Suggested fix` 只写译文本体**：该字段必须包含将要写回的完整目标行译文本身，不写"建议改为"、"译文为"、"可翻译成"、"应译作"等元说明，也不要把解释、理由、引号或"把X改为Y"这类局部替换指令混进该字段
- **所有级别都给完整修正译文**：发现 HIGH、MEDIUM 或 LOW 问题时，都必须直接重写整行译文，避免只描述问题、只给方向或只给局部替换；这能让后续批量写回无需再次定位和人工重译
- **并行合并编号唯一**：如果使用 subagent、chunk 或其他并行流程，最终 findings JSON 里的 `H1-001` / `M2-004` / `L1-003` 等编号必须全局唯一；发现重复编号时，按对应 Hx/Mx/Lx 当前最大编号继续递增后再写入最终报告
- **区分确信度**：对于有一定不确定性的标注，在"问题"字段加注"（待核查）"
- **术语过滤优先**：H3 标注必须经过假阳性过滤，不能将短术语子串命中当作真实问题
- **性别/代词检查上下文**：H8 仅在该行有该角色名出现时触发；英文目标语默认检查 he/she/they 系列代词，多角色同行或 singular they 判断不明确时加注"（待核查）"
- **处理选项固定**：每条标注只保留一行未勾选的 `- [ ] Accept suggestion`；不要输出 `[x]` 默认项，也不要添加额外处理选项
- **术语表优先**：术语表中已确认的译名发现不符时，必须标为 H3，不降级
- **术语表候选更新**：遇到稳定专有名词或世界观术语且术语表未收录时，记录候选条目（src、候选译名、类别/依据、首见行），供最终合并译名表；避免加入泛用性高的词、亲属称谓、普通名词、短且歧义大的片段，除非用户明确确认
- **尊重风格选择**：若译者明显有意采用某种风格（如古文体），不将其标为问题；若确实偏离上下文，标为 M2
- **长度异常必扫**：H9 长度异常预扫描是必须步骤，不可跳过
- **H9 阈值按语言对选择**：中文目标语默认宽筛 `1.5`、精筛超出宽度 `32`；英文目标语默认宽筛 `1.8`、精筛超出宽度 `48`；其他语言对从 `default` 配置开始并按文本实际调整

### Monte Carlo 模式特有规则
- **自动化检查不抽样**：H3/H4/H7/H8/H9 是全量扫描，不走抽样流程
- **收敛判断保守**：必须连续 2 轮无新发现才算收敛，单轮为 0 不够
- **抽样行不重复**：维护全局 `sampled_set`；任何已抽样行（无论清白或有问题）不得进入下一轮抽样池
- **最低轮数下限**：默认 `MIN_ROUNDS = 2`；未达到最低轮数时不得宣布收敛
- **区域抽样耗尽处理**：区域累计抽样覆盖率达到 80% 时标记 `FULLY_SAMPLED`，后续不再消耗该区域抽样配额
- **发现项防御性去重**：合并 `auto_findings` 与 `sample_findings` 时按 `(line_num, issue_code)` 去重，避免重复报告同一行同一类问题
- **未收敛要询问用户**：若达到最大轮数未收敛，必须汇报最新新增数、剩余未抽样行数、HOT 区域，并询问用户继续抽样、切换 HOT 区域到 split 精审，或停止并输出当前报告
- **抽样比例按密度动态调整**：HOT 区域加大抽样，COLD 区域减少，不要均匀分配

### Split-Review 模式特有规则
- **不跳行**：逐行审查意味着片段内每一行都要过目，不允许只看"可疑行"
- **记录覆盖**：每完成一个片段就在 summary 中记录覆盖范围和统计
- **片段间保持上下文**：切换片段时，新片段的开头几行要读取前一片段的末尾几行作为上下文
- **split 是保存间隔**：split N 是 checkpoint/save interval；必须审完整 assigned range，不得只完成一个 split 就停止
- **subagent 分配规则**：使用 subagent 时，先按 subagent 数量把完整 aligned range 分成互不重叠的大范围；每个 subagent 在自己的范围内按 split N 定期保存/报告

## Workflow Procedure

1. Load source, translation, and optional glossary with UTF-8.
2. Determine the target language's conventions before judging grammar, punctuation, pronouns, quotes, register, and style.
3. Align source and translation by line when possible; otherwise use the fallback alignment rules above.
4. Always run the shared preprocessing before review:
   - H3 terminology false-positive filtering with longest-match handling.
   - H9 length-anomaly prescan with thresholds selected for the language pair; English targets allow larger expansion than Chinese targets.
   - Automated checks for untranslated source text, AI contamination, pronoun issues, and terminology mismatches where applicable to the language pair.
5. Apply the selected mode:
   - `montecarlo`: classify regions, sample by region priority from a non-repeating sampled-line pool, iterate until convergence, and write the two-file final report without editing the translation.
   - `split N`: treat `N` as a checkpoint/save interval, review the complete assigned range without skipping lines, report progress per checkpoint, edit the main translation file only after the user explicitly approves the proposed fixes, and consolidate remaining findings into the same two-file final report.
6. When stable proper nouns or world-specific terms are discovered outside the glossary, record them as candidate term-table entries for later merge. Prefer names, places, organizations, species, titles, and setting terms; avoid generic words, common nouns, and short ambiguous fragments unless the user confirms them.

## Reporting Rules

- Use `target_language`: the language of the translation being reviewed.
- Write report headings, summaries, explanations, issue descriptions, confidence notes, handling options, and every `Suggested fix` value in `target_language`.
- Keep parser-required fixed field labels in English, including `Source`, `Current translation`, `Issue`, `Suggested fix`, and `Accept suggestion`.
- Include global line numbers, source text, current translation, issue code, severity, explanation, and `Suggested fix` for every finding.
- Use human/global 1-based line numbers in headings: `L<N>` maps to `source_lines[N-1]` and `translation_lines[N-1]`.
- Before writing each finding, verify the global `L<N>` line number by re-reading that exact source/translation line pair from the input files. Do not infer line numbers from chunk-local, batch-local, sampled, displayed, or approximate positions.
- The `sourceLine` value must point to the source line whose text exactly matches the reported `sourceText` field. If uncertain, include the candidate in the summary only, not in `[basename].proofread.json`.
- `Source` and `Current translation` must contain the full exact line text from that row, not a shortened quote, fragment, or explanation.
- For every severity level (HIGH, MEDIUM, and LOW), provide a concrete `Suggested fix` that can directly replace the current target line.
- For H9 expansion/hallucination findings, retranslate the source line and put the full corrected target-language text in `Suggested fix`.
- The `Suggested fix` field must contain only the final target-language text to write back. Do not include meta phrases, explanations, labels, quotes, or search/replace instructions inside that field.
- When merging parallel or chunked findings, final finding IDs must be globally unique. Duplicate IDs are forbidden; renumber duplicates after the current max for that Hx/Mx/Lx code before writing the final findings JSON.
- Mark uncertain findings with a "needs verification" note instead of overstating confidence.
- Include exactly one unchecked `- [ ] Accept suggestion` line per finding.
- Treat confirmed glossary mismatches as H3.
- For split-review edits, verify the target line still matches the expected old text before replacing it.
