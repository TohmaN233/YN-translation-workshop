# Proofread Translation

Inputs come from the user request.

## Overview

This skill performs structured bilingual proofreading with **two distinct review modes**:

| Mode | 名称 | 适用场景 | 策略 |
|------|------|---------|------|
| `montecarlo` | 抽样收敛 | 大文件快速定位问题区域 | 区域分类 → 随机抽样 → 迭代直到连续干净 |
| `split N` | 分片逐行 | 精细逐行审查 | 按N行拆分 → 每片line-by-line → 修复写回主文件 |

**No edits are made to the translation unless in split-review mode where the user explicitly approves batch fixes.**

---

## Argument Parsing

Parse the user request for:

| Field | Example values | Default |
|-------|---------------|---------|
| Review mode | `montecarlo`, `split 500`, `split 1000` | asked if missing |
| Translation type | `game`, `novel`, `technical`, `subtitle`, `academic` | asked if missing |
| Source language | `Japanese`, `Chinese`, `English`, etc. | infer, ask if ambiguous |
| Target language | `Chinese`, `English`, etc. | infer, ask if ambiguous |
| Source file | `original_jp.txt`, `source.md` | asked if missing |
| Translation file | `translated_zh.txt`, `ch01_en.md` | asked if missing |
| Glossary file | `terms.json`, `glossary.md` | optional |

**Flexible input formats** (all equivalent):
```
"montecarlo; game; source.txt; translation.txt; glossary.json"
"split 500; game; source.txt; translation.txt"
"split 500; game"  → then ask for source and translation paths
```

If review mode is not provided, ask:
```
校对模式？
  1. montecarlo / 蒙特卡洛   （快速抽样收敛，适合大文件初筛）
  2. split N    / 分片逐行    （按N行拆分，逐片精审，适合精细校对）
     示例：split 500 = 每500行为一片
```

If translation type is not provided or unclear, ask:
```

### Language Pair Configuration

Before review, set a lightweight language profile:

- `source_language`: infer from user request, file names, content, or glossary.
- `target_language`: infer the same way; ask only if the replacement translation language is unclear.
- `report_language`: default to the user's language unless they request otherwise.
- `target_conventions`: punctuation, quotes, pronouns, register, capitalization, spacing, and sentence rhythm for the target language.

Use target-language conventions for LOW issues. Do not apply Chinese-specific rules to English targets. Examples:

| Target language | Apply |
|-----------------|-------|
| Chinese | Chinese punctuation, `他/她` checks when glossary gender is reliable, Chinese quote/spacing conventions |
| English | English punctuation, capitalization, articles, tense/aspect consistency, `he/him/his`, `she/her/hers`, and `they/them/their/theirs` pronoun checks |
| Other | Use that language's normal grammar, punctuation, pronoun, and register expectations; ask only if uncertain |

### Output Language Contract

All Markdown reports must obey this split:

| Part | Language |
|------|----------|
| Headings, summaries, issue explanations, confidence notes, handling options | `report_language` |
| Template labels such as position/source/current translation/problem | localize to `report_language` |
| Raw source text | unchanged source text |
| Current translation quote | unchanged target text from file |
| `Suggested translation` field label | keep this exact stable key unless the user asks for localized labels |
| `Suggested translation` field value | `target_language` only |
| Glossary terms | preserve glossary spelling unless explaining in `report_language` |

Default `report_language` is the language the user is using to talk to Codex in the current request or conversation. If the user asks in Chinese to proofread an English translation, write the report in Chinese and put English only in `Suggested translation`. If the user asks in English to proofread a Chinese translation, write the report in English and put Chinese only in `Suggested translation`.

Before finalizing a `.md` report, run a language consistency pass:

1. Confirm every explanation and summary follows `report_language`.
2. Confirm every `Suggested translation` is a complete replacement in `target_language`.
3. Confirm no stock phrases from another language leaked into headings, labels, or handling options unless quoted from the source/translation.
4. Confirm template labels are localized to `report_language`, except the stable `Suggested translation` key when parsability matters.
5. If either language is ambiguous, ask before producing the report.
Genre？
  1. game    / 游戏    （RPG/视觉小说）
  2. novel   / 小说    （文学/轻小说）
  3. technical / 技术  （技术文档/说明书）
  4. subtitle / 字幕  （影视字幕/配音脚本）
  5. academic / 学术  （论文/研究报告）
```

---

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

---

## Translation Type Profiles

不同类型的翻译对应不同的检查重点和风格预期。

### `game` — RPG/视觉小说/剧情游戏
```
重点检查：H2（对话说话人），H3（道具/技能/地名术语），H8（角色性别），M2（角色口吻一致性）
风格预期：对话生动自然，角色有各自口癖；UI文字简洁；技能/道具名需与官方一致或内部统一
特别关注：
  - 选项文本长度（过长可能超出UI框）
  - 角色语气标签（例：温柔、傲娇、中二）
  - 人称代词一致性（"我/本座/咱"等不混用）
```

### `novel` — 文学/轻小说/同人文
```
重点检查：H1（语义准确），M2（叙事腔调），M3（文化元素），L3（翻译腔）
风格预期：流畅自然的目标语表达；文学手法（比喻、排比）需对应处理而非直译
特别关注：
  - 内心独白语气（是否与叙事者声音一致）
  - 比喻/意象的跨文化适配
  - 章节/场景切换处的衔接感
```

### `technical` — 技术文档/说明书/API文档
```
重点检查：H1（精确性），H3（术语一致），H4（不遗漏），H5（完整性），L1（语法规范）
风格预期：准确、简洁、一致；术语需精确统一；无歧义
特别关注：
  - 数字、单位、格式是否保留
  - 代码/命令不应被翻译
  - 注意事项/警告标识的语气（必须/建议/可选）
```

### `subtitle` — 影视字幕/配音脚本
```
重点检查：H4（未译），M1（上下文连贯），M2（角色口吻），L3（口语化）
风格预期：口语化，符合目标语说话节奏；尽量保留情感强度
特别关注：
  - 字幕长度约束（每行建议<=20字）
  - 语气词、叹词的处理
  - 同一角色不同场合的语气变化是否合理
```

### `academic` — 学术论文/研究报告
```
重点检查：H3（术语一致），H5（完整性），H1（准确性），L1（正式语法）
风格预期：正式、客观、术语精确；引用格式保持原样
特别关注：
  - 专业术语的统一性（同一论文中不能有两种译法）
  - 脚注/引用不应消失
  - 被动句的处理（学术文体常用被动）
```

---

## Workflow — Common Preprocessing (Steps 1-3.5)

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
```
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

**在校对之前，先执行全量长度异常扫描。** AI翻译最常见的严重故障模式是"膨胀"——译文比原文长出一大截，原因包括：
- **AI加戏**：凭空补充原文没有的解释、背景、心理描写
- **串行/错位**：把其他行的译文混入当前行
- **幻觉/胡言乱语**：AI输出与原文完全无关的内容
- **元数据泄漏**：混入翻译说明、思考过程等非译文内容

#### 宽度计算

对于CJK语言对（如日->中），使用**显示宽度**而非字符数：
```python
import unicodedata

def display_width(s):
    """计算字符串的显示宽度（CJK字符算2，其他算1）。"""
    w = 0
    for ch in s:
        if unicodedata.east_asian_width(ch) in ('W', 'F'):
            w += 2
        else:
            w += 1
    return w
```

#### 两级筛选策略

为控制假阳性（短句天然波动大），采用分级阈值：

先按语言对选择阈值。中文目标语沿用日->中优化值；英文目标语默认允许更长的目标文本，宽筛比值放宽到 `1.8`。

```python
def normalize_language_name(name):
    aliases = {
        "zh": "Chinese", "zho": "Chinese", "中文": "Chinese", "汉语": "Chinese",
        "en": "English", "eng": "English", "英文": "English", "英语": "English",
        "ja": "Japanese", "jpn": "Japanese", "日文": "Japanese", "日语": "Japanese",
    }
    return aliases.get(str(name).strip(), str(name).strip())

target_lang = normalize_language_name(target_language)

LENGTH_PROFILES = {
    "Chinese": {
        "candidate_ratio": 1.5,
        "candidate_min_src_width": 20,
        "priority_min_src_width": 40,
        "priority_min_excess": 32,
    },
    "English": {
        "candidate_ratio": 1.8,
        "candidate_min_src_width": 24,
        "priority_min_src_width": 40,
        "priority_min_excess": 48,
    },
    "default": {
        "candidate_ratio": 1.7,
        "candidate_min_src_width": 24,
        "priority_min_src_width": 40,
        "priority_min_excess": 40,
    },
}

profile = LENGTH_PROFILES.get(target_lang, LENGTH_PROFILES["default"])
```

**第一级：宽筛（发现异常候选）**
```python
for i, (src, tgt) in enumerate(aligned_pairs):
    src_w = display_width(src)
    tgt_w = display_width(tgt)
    ratio = tgt_w / max(src_w, 1)
    if (
        ratio >= profile["candidate_ratio"]
        and src_w >= profile["candidate_min_src_width"]
    ):
        candidates.append((i, src, tgt, ratio))
```

**第二级：精筛（高置信度，直接标H9）**
```python
for i, src, tgt, ratio in candidates:
    src_w = display_width(src)
    tgt_w = display_width(tgt)
    excess = tgt_w - src_w
    if (
        src_w >= profile["priority_min_src_width"]
        and excess >= profile["priority_min_excess"]
    ):
        flag(H9, line=i+1, src=src, tgt=tgt,
             note=f"译文异常膨胀：原文宽度{src_w}，译文宽度{tgt_w}，"
                   f"膨胀比{ratio:.2f}，超出{excess}")
```

#### 阈值说明

| 语言配置 | 宽筛 `ratio` | 精筛超出宽度 | 说明 |
|----------|---------------|--------------|------|
| `target:Chinese` | 1.5 | 32 | 适合日/英等语言翻成中文的常见压缩或接近等长情况 |
| `target:English` | 1.8 | 48 | 英文译文通常比日文/中文源文更长，默认放宽 |
| `default` | 1.7 | 40 | 其他语言对的保守初始值，按实际文本调整 |

> **为什么不直接用比值？** 短句（如3字->8字）比值可达2.6但完全正常；长句（如50字->75字）比值仅1.5却可能已经加戏。绝对差值+最小源文长度的组合比纯比值更稳健。

#### 与 H6/H7 的区分

| 代码 | 检测方式 | 典型表现 |
|------|---------|---------|
| H6 增译 | 语义审查 | 译文多了一句解释但长度差距不大 |
| H7 AI污染 | 正则模式 | 开头有"好的，以下是翻译："等元语言 |
| H9 AI膨胀 | 长度异常 | 译文比原文长出一大截，内容可能完全无关 |

三者可能同时命中（如一行既有元语言前缀又异常膨胀），此时分别标注，不合并。

---

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
```
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

---

## Mode A: Monte Carlo (抽样收敛)

**适用场景**：大文件（万行级）快速定位问题热点区域，不需要逐行审查。
**核心思路**：先用自动化检查批量扫全文，再对剩余问题用随机抽样逐轮收敛。

### A-Step 1: 全文自动化预扫描

在 Step 3 / 3.5 完成后，对全文执行所有可自动化的检查：

```
全文自动化扫描（共 N 对）：
  H3 术语不符：扫完（基于过滤矛盾表）
  H4 未译句：扫完（正则匹配）
  H7 AI污染：扫完（正则匹配）
  H8 性别错误：扫完（术语表+代词）
  H9 长度异常：扫完（宽度比较）
```

这些检查是 O(N) 的，不需要抽样。将所有命中记录到 `auto_findings`。

### A-Step 2: 区域重要性分类

将全文划分为等长区域（每区域约 500-1000 行），按自动化检查的命中密度分级：

```python
REGION_SIZE = 500  # 每区域行数，可根据文件大小调整
regions = []
for start in range(0, total_pairs, REGION_SIZE):
    end = min(start + REGION_SIZE, total_pairs)
    hits = count_auto_findings_in_range(start, end)
    density = hits / (end - start)
    if density > 0.05:
        priority = 'HOT'     # 问题热点，重点抽样
    elif density > 0.01:
        priority = 'WARM'    # 有少量问题，正常抽样
    else:
        priority = 'COLD'    # 几乎无自动检查命中，轻抽样
    regions.append((start, end, priority, hits))
```

输出区域热力图：
```
区域热力图（每区域 500 行）：
  [    0 -   499] COLD   (0 hits)
  [  500 -   999] WARM   (3 hits)
  [ 1000 -  1499] HOT    (12 hits)  <-- 重点区域
  [ 1500 -  1999] COLD   (0 hits)
  ...
```

### A-Step 3: 分层随机抽样

按区域优先级分配抽样配额：

```
抽样配额：
  HOT  区域：抽取 30% 的行（语义审查 H1/H2/H5/H6/M*）
  WARM 区域：抽取 15% 的行
  COLD 区域：抽取  5% 的行
```

对抽中的每一行，执行完整的语义/语用层检查（H1/H2/H5/H6/M1-M5/L1-L4），这些是自动化检查无法覆盖的。

**每轮抽样流程**：
1. 从各区域按配额随机抽取行；每轮只能从尚未抽过的行中抽取
2. 对抽中行执行语义审查
3. 记录发现的问题到 `sample_findings`
4. 更新区域密度（合并 auto_findings + sample_findings）
5. 重新分类区域优先级

**Non-repeating sample pool (required)**:

- Maintain `sampled_set` as the cumulative set of all sampled line numbers across all Monte Carlo rounds.
- Each round must draw only from `available = all_lines - sampled_set`; never sample a line that has already been semantically reviewed in a previous round.
- This applies to both clean lines and lines with findings. A finding line is still removed from future sampling once reviewed.
- If a region has already sampled at least 80% of its lines, mark that region `FULLY_SAMPLED`, remove it from future sampling pools, and reallocate its quota to remaining non-exhausted regions.
- When merging `auto_findings` and `sample_findings`, deduplicate defensively by `(line_num, issue_code)` even though repeated sampling is forbidden.

### A-Step 4: 收敛迭代

```python
MIN_ROUNDS = 2
MAX_ROUNDS = 5
CLEAN_NEEDED = 2
FULLY_SAMPLED_THRESHOLD = 0.80

sampled_set = set()
finding_index = {(f.line_num, f.issue_code) for f in auto_findings}
consecutive_clean = 0
converged = False

for round_num in range(1, MAX_ROUNDS + 1):
    for region in regions:
        if region.sampled_count / region.line_count >= FULLY_SAMPLED_THRESHOLD:
            region.priority = "FULLY_SAMPLED"

    available_by_region = {
        region.id: [line for line in region.lines if line not in sampled_set]
        for region in regions
        if region.priority != "FULLY_SAMPLED"
    }
    drawn = stratified_sample(available_by_region, quotas)
    sampled_set.update(drawn)

    raw_findings = semantic_review(drawn)
    new_findings = []
    for finding in raw_findings:
        key = (finding.line_num, finding.issue_code)
        if key in finding_index:
            continue
        finding_index.add(key)
        new_findings.append(finding)

    sample_findings.extend(new_findings)
    new_issues = len(new_findings)

    if new_issues == 0:
        consecutive_clean += 1
        print(f"Round {round_num}: no new findings ({consecutive_clean}/{CLEAN_NEEDED} clean)")
    else:
        consecutive_clean = 0
        print(f"Round {round_num}: {new_issues} new findings; reclassify regions")
        reclassify_regions()

    if round_num >= MIN_ROUNDS and consecutive_clean >= CLEAN_NEEDED:
        converged = True
        break

if converged:
    print("Converged: minimum rounds satisfied and two consecutive clean rounds")
else:
    print(f"Reached MAX_ROUNDS={MAX_ROUNDS} without convergence")
```

**收敛条件**：连续 2 轮抽样未发现新问题 → 认为该文件在当前精度下已充分审查。

**Minimum round requirement**: Do not declare convergence before `MIN_ROUNDS` is reached, even if early rounds are clean.

**未收敛处理**：若达到最大轮数仍未收敛，不要直接硬停。先向用户报告当前状态并请求下一步决定：
```
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

**输出路径**：`[translation_file的目录]/[basename]_mc_review.md`

报告结构：

```markdown
# 翻译校对报告（Monte Carlo 模式）

**原文**：[SOURCE_FILE]
**译文**：[TRANSLATION_FILE]
**术语表**：[GLOSSARY_FILE 或 "未提供"]
**翻译类型**：[type]
**语言对**：[source_language] -> [target_language]
**报告语言**：[report_language]
**校对时间**：[timestamp]
**总行数**：[N]
**抽样轮数**：[R]
**收敛状态**：[已收敛 / 未收敛]

---

## 区域热力图

| 区域 | 行范围 | 优先级 | 自动命中 | 抽样命中 | 合计 |
|------|--------|--------|---------|---------|------|
| R01  | 0-499  | COLD   | 0       | 0       | 0    |
| R02  | 500-999| WARM   | 3       | 1       | 4    |
| R03  | 1000-1499| HOT  | 12      | 5       | 17   |

---

## 术语矛盾预扫描
（同通用格式）

---

## 发现汇总

| 严重度 | 数量 | 建议 |
|--------|------|------|
| HIGH   | [N]  | 必须审查 |
| MEDIUM | [N]  | 建议审查 |
| LOW    | [N]  | 酌情处理 |

---

## HIGH — 必须审查

### [H-001] H9 AI膨胀/幻觉
**位置**：行 [N]
**原文**：`...`
**译文**：`...`
**问题**：译文异常膨胀（原文宽度X，译文宽度Y）
**Suggested translation**：`[根据原文重新翻译后的完整目标语译文]`

**处理选项**：
- [x] 采纳 Suggested translation（默认）-> 将当前译文替换为该字段内容
- [ ] 自行修改 -> _______________
- [ ] 忽略 -> 理由：_______________

（...更多条目...）

---

## 抽样覆盖统计

| 轮次 | HOT抽样 | WARM抽样 | COLD抽样 | 新发现 |
|------|---------|---------|---------|--------|
| 1    | 150     | 75      | 25      | 12     |
| 2    | 150     | 75      | 25      | 3      |
| 3    | 150     | 75      | 25      | 0      |
| 4    | 150     | 75      | 25      | 0      |

收敛于第 4 轮。总抽样行数：1000 / 5000（20%覆盖）
```

### A-Step 6: 摘要输出

```
校对完成（Monte Carlo）：[TRANSLATION_FILE]

抽样轮数：[R]    收敛状态：[已收敛/未收敛]
覆盖率：[X]%    总抽样行：[N]

H: [N] 处  M: [N] 处  L: [N] 处

审查文件：[path]_mc_review.md

未修改原译文。请审阅报告后自行决定修改方案。
如有 HOT 区域未收敛，建议对该区域使用 split 模式精审。
```

---

## Mode B: Split-Review (分片逐行)

**适用场景**：对文件（或文件的某个区域）进行精细的逐行审查，每片审查完后即可修复。
**核心思路**：按用户指定的行数拆分 → 逐片 line-by-line → 发现问题 → 用户确认修复 → 修复写回主文件 → 下一片。

### B-Step 1: 拆分文件

```python
CHUNK_SIZE = N  # 用户指定，如 500

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

输出拆分概览：
```
文件拆分完成（每片 500 行）：
  片段 1/10：行 0-499    (500 对)
  片段 2/10：行 500-999  (500 对)
  ...
  片段 10/10：行 4500-4832 (333 对)

将从片段 1 开始逐行审查。
```

### B-Step 2: 逐片审查循环

对每个片段，执行完整的检查流程：

```
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

```
审查行 [i]：
  上下文：前2行摘要 + 后2行摘要
  当前行：源文 / 译文
  执行 H1/H2/H5/H6/M1-M5/L1-L4 检查
```

**批处理优化**：实际操作中不必真的逐行单独审查。将片段按 200-300 行为一批（默认），每批完整阅读后一次性标注。关键是**不跳过任何行**。

#### 2c. 片段审查报告

每片审查完成后，立即输出该片段的发现：

```markdown
## 片段 [K]/[N] 审查结果（行 [start]-[end]）

发现 [X] 个问题：HIGH [a], MEDIUM [b], LOW [c]

### [H-001] H1 错译
**位置**：行 [N]（全局行号）
**原文**：`...`
**译文**：`...`
**问题**：...
**Suggested translation**：`...`
```

> **输出语言规则**：除原文、当前译文和 `Suggested translation` 外，报告文字使用 `report_language`。`Suggested translation` 必须只写 `target_language` 的最终可替换译文，不得混入解释、标签、引号或局部替换说明。

### B-Step 3: 修复与写回

每片审查报告输出后，进入**修复确认环节**：

```
片段 [K] 审查完成，发现 [X] 个问题。

修复方式：
  1. 批量采纳所有 `Suggested translation`（仅对有明确完整替换译文的条目）
  2. 逐条确认（显示每条问题，你决定采纳/修改/忽略）
  3. 跳过修复，继续下一片
  4. 导出为 review 文件，稍后手动处理
```

#### 批量替换执行

当用户选择修复时，**修改在主文件上执行**（不是拆分文件）：

```python
# 批量替换示例
replacements = [
    (line_number, old_text, new_text),
    ...
]

# 读取主译文文件
lines = pathlib.Path(TRANSLATION_FILE).read_text(encoding="utf-8").splitlines()

# 执行替换
for line_num, old, new in replacements:
    if lines[line_num] == old:  # 安全检查：确保行内容未变
        lines[line_num] = new
    else:
        print(f"跳过行 {line_num}：文件内容已变化，无法安全替换")

# 写回
pathlib.Path(TRANSLATION_FILE).write_text(
    "\n".join(lines) + "\n", encoding="utf-8"
)
```

**安全机制**：
- 替换前验证目标行内容与预期一致（防止并发修改冲突）
- 每次写回后报告修改数量
- 保留修改日志

#### 片段推进

修复完成（或跳过）后，自动推进到下一片：

```
片段 [K] 修复完成：[M] 处已修改，[S] 处已跳过。
继续片段 [K+1]/[N]...
```

### B-Step 4: 全局摘要

所有片段处理完成后，输出全局统计：

```
分片逐行审查完成：[TRANSLATION_FILE]

总片段：[N]    每片：[CHUNK_SIZE] 行
总发现：[X] 处    已修复：[Y] 处    已跳过/忽略：[Z] 处

各类型统计：
  H: [N] 处（已修复 [a]）
  M: [N] 处（已修复 [b]）
  L: [N] 处（已修复 [c]）

未修复条目汇总：[path]_remaining_review.md
```

若有未修复的条目，将其汇总写入 `[basename]_remaining_review.md`。

### B-Step 5: 断点续查

若审查中途中断（上下文溢出、用户暂停等），记录进度：

```
进度保存：已完成 [K]/[N] 片段
恢复命令：proofread-translation split [CHUNK_SIZE]; [type]; [source]; [translation]; --resume=[K+1]
```

下次调用时，若检测到 `--resume` 参数，从指定片段继续，跳过已完成的片段。

---

## 标注格式（两种模式通用）

**每条标注必须包含以下结构**：

```markdown
### [X-NNN] Hx/Mx/Lx 类型名称
**位置**：行 [N]
**原文**：`[源文本]`
**译文**：`[当前译文]`
**问题**：[问题描述；若有不确定性加注"（待核查）"]
**Suggested translation**：`[修正后的完整目标语译文]`（所有严重级别都必须给整行可替换译文）

**处理选项**（请选一项后删除其余）：
- [x] 采纳 Suggested translation（默认）-> 将当前译文替换为该字段内容
- [ ] 自行修改 -> _______________
- [ ] 忽略 -> 理由：_______________
```

> **默认操作规则**：
> - 所有严重级别（HIGH/MEDIUM/LOW）都必须提供完整 `Suggested translation`
> - H9 膨胀/幻觉也必须根据原文重译一遍，给出完整目标语译文
> - 是否采纳由用户决定；不得因为默认忽略或等待人工判断而省略替换译文

---

## Key Rules

### 通用规则
- **报告语言固定**：整份 `.md` 报告的标题、摘要、问题解释、置信度说明和处理选项必须使用 `report_language`；不要因为目标语是英文就把中文用户的报告写成英文，反之亦然
- **模板标签要本地化**：示例模板中的 `位置/原文/译文/问题` 等标签只是中文示例；如果 `report_language` 是英文，应改成 `Location/Source/Current translation/Issue` 等对应标签
- **替换译文语言固定**：`Suggested translation` 字段必须使用 `target_language`，即使报告语言不同；这是写回文件的文本，不是说明文字
- **给出位置**：每条标注必须包含行号（全局行号，非片段内行号），方便人工定位
- **提供原文对照**：每条标注同时显示原文和译文，不要只描述问题
- **`Suggested translation` 只写译文本体**：该字段必须包含将要写回的完整目标行译文本身，不写"建议改为"、"译文为"、"可翻译成"、"应译作"等元说明，也不要把解释、理由、引号或"把X改为Y"这类局部替换指令混进该字段
- **所有级别都给完整修正译文**：发现 HIGH、MEDIUM 或 LOW 问题时，都必须直接重写整行译文，避免只描述问题、只给方向或只给局部替换；这能让后续批量写回无需再次定位和人工重译
- **区分确信度**：对于有一定不确定性的标注，在"问题"字段加注"（待核查）"
- **术语过滤优先**：H3 标注必须经过假阳性过滤，不能将短术语子串命中当作真实问题
- **性别/代词检查上下文**：H8 仅在该行有该角色名出现时触发；英文目标语默认检查 he/she/they 系列代词，多角色同行或 singular they 判断不明确时加注"（待核查）"
- **处理选项必须附默认**：每条标注的处理选项中必须有且仅有一项标记为 `[x]`（默认），其余为 `[ ]`
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
- **保留进度**：每完成一个片段就记录进度，支持断点续查
- **片段间保持上下文**：切换片段时，新片段的开头几行要读取前一片段的末尾几行作为上下文
