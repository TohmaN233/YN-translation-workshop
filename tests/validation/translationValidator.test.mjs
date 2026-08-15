import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateTranslationCandidate,
  splitTextLines,
  looksLikeCodePayload,
  parseSourceLanguageFromPair,
  proseCore,
  stripPreservedPayload,
  candidateContainsSourceLanguage
} from "../../src/shared/validation/translationValidator.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const examples = path.join(root, "examples", "toy-txt-audit");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log(`ok ${name}`);
  }).catch((error) => {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  });
}

const source = readFileSync(path.join(examples, "source.txt"), "utf8");
const translation = readFileSync(path.join(examples, "translation.txt"), "utf8");

await test("toy-txt-audit: 7 source lines align with 7 translation lines", () => {
  const result = validateTranslationCandidate(source, translation);
  assert.equal(result.ok, true, `expected ok, got: ${result.summary}\nblocking: ${JSON.stringify(result.blocking)}`);
  assert.equal(result.sourceLineCount, 7);
  assert.equal(result.candidateLineCount, 7);
  assert.equal(result.blocking.length, 0);
});

await test("line count mismatch is blocking", () => {
  const candidate = "line1\nline2\nline3"; // 3 lines vs 7
  const result = validateTranslationCandidate(source, candidate);
  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].code, "line_count_mismatch");
  assert.match(result.blocking[0].detail, /7.*3|3.*7/);
});

await test("extra line in candidate is blocking", () => {
  const candidate = translation + "\nextra line at end";
  const result = validateTranslationCandidate(source, candidate);
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].code, "line_count_mismatch");
});

await test("placeholder mismatch is blocking", () => {
  const src = "Hello {player_name}, you have %d coins.";
  const cand = "你好 {玩家名}，你有 100 金币。";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((f) => f.code === "placeholder_mismatch"), "expected placeholder_mismatch");
});

await test("placeholder preserved (reordered) passes", () => {
  const src = "{x} and {y}";
  const cand = "{y} 和 {x}";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, true, result.summary);
});

await test("project custom preservation rules block missing same-line source matches", () => {
  const result = validateTranslationCandidate(
    "@SPEAKER Alice says hello.",
    "爱丽丝打了招呼。",
    {
      languagePair: "en->zh-CN",
      customPreserveRules: [{ label: "speaker marker", pattern: "^@[A-Z_]+", flags: "u" }]
    }
  );
  assert.equal(result.ok, false);
  const finding = result.blocking.find((entry) => entry.code === "custom_preserve_mismatch");
  assert.ok(finding, "expected custom_preserve_mismatch");
  assert.match(finding.detail, /speaker marker|@SPEAKER/i);
});

await test("project custom preservation rules compare the complete match multiset", () => {
  const options = {
    languagePair: "en->zh-CN",
    customPreserveRules: [{ label: "speaker marker", pattern: "@[A-Z_]+", flags: "u" }]
  };
  const preserved = validateTranslationCandidate(
    "@ALICE greets @BOB.",
    "@ALICE 向 @BOB 打招呼。",
    options
  );
  assert.equal(preserved.ok, true, preserved.summary);

  const changed = validateTranslationCandidate(
    "@ALICE greets @BOB.",
    "@ALICE 向 @ALICE 打招呼。",
    options
  );
  assert.equal(changed.ok, false);
  assert.ok(changed.blocking.some((entry) => entry.code === "custom_preserve_mismatch"));
});

await test("custom-preserved identifiers are excluded from untranslated prose analysis", () => {
  const result = validateTranslationCandidate(
    "@NPC_ID enters the room.",
    "@NPC_ID 走进房间。",
    {
      languagePair: "en->zh-CN",
      customPreserveRules: [{ label: "speaker marker", pattern: "^@[A-Z_]+", flags: "u" }]
    }
  );
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.warnings.some((entry) => entry.code === "likely_untranslated"), false);
});

await test("generic model placeholder prose is a blocking artifact error", () => {
  const result = validateTranslationCandidate("本当の台詞です。", "（本段译文）", {
    languagePair: "ja->zh-CN"
  });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((finding) => finding.code === "generic_translation_placeholder"));
});

await test("explicit Chinese filler translation is a blocking artifact error", () => {
  const result = validateTranslationCandidate("Actual English source sentence.", "这是中文翻译。", {
    languagePair: "en->zh-CN"
  });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((finding) => finding.code === "generic_translation_placeholder"));
});

await test("bare target-language translation labels are blocking placeholder artifacts", () => {
  const result = validateTranslationCandidate(
    "He gripped the lower part of the lid and carefully lifted it.",
    "中文译文",
    { languagePair: "en->zh-CN" }
  );
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((finding) => finding.code === "generic_translation_placeholder"));
});

await test("bare completion labels are blocking placeholder artifacts for ordinary source prose", () => {
  const result = validateTranslationCandidate(
    "The cabinet contained a sealed letter addressed to Erina.",
    "已翻译",
    { languagePair: "en->zh-CN" }
  );
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((finding) => finding.code === "generic_translation_placeholder"));
});

await test("one short candidate repeated for distinct long sources is blocking even when it is not a known phrase", () => {
  const result = validateTranslationCandidate(
    [
      "He gripped the lower part of the lid and carefully lifted it.",
      "Mary closed the tall glass window before leaving the room.",
      "The teacher slowly read the important letter to the class."
    ].join("\n"),
    ["内容已处理", "内容已处理", "内容已处理"].join("\n"),
    { languagePair: "en->zh-CN" }
  );
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((finding) => finding.code === "repeated_short_candidate"));
});

await test("a consecutive identical sentence for distinct source lines is deterministic blocking evidence", () => {
  const result = validateTranslationCandidate(
    [
      "He gripped the lower part of the lid and carefully lifted it.",
      "Mary closed the tall glass window before leaving the room.",
      "The teacher slowly read the important letter to the class."
    ].join("\n"),
    [
      "这一段内容已经按照要求完整地完成了中文翻译。",
      "这一段内容已经按照要求完整地完成了中文翻译。",
      "这一段内容已经按照要求完整地完成了中文翻译。"
    ].join("\n"),
    { languagePair: "en->zh-CN" }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.blocking.filter((finding) => finding.code === "repeated_candidate_run").map((finding) => finding.line),
    [1, 2, 3]
  );
});

await test("an isolated severe length anomaly is review evidence rather than a deterministic blocker", () => {
  const result = validateTranslationCandidate(
    "He gripped the lower part of the lid with his right arm and carefully lifted it to reveal the hidden compartment.",
    "他打开了。",
    { languagePair: "en->zh-CN" }
  );
  assert.equal(result.ok, true, "length alone must not mechanically decide semantic failure");
  assert.deepEqual(
    result.warnings.filter((finding) => finding.code === "length_anomaly").map((finding) => finding.line),
    [1]
  );
});

await test("short legitimate UI translations do not trigger length anomaly review", () => {
  const result = validateTranslationCandidate(
    ["Save", "Load", "Quit game"].join("\n"),
    ["保存", "读取", "退出游戏"].join("\n"),
    { languagePair: "en->zh-CN" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((finding) => finding.code === "length_anomaly"), false);
});

await test("RPG control command and payload must be preserved together", () => {
  const changed = validateTranslationCandidate("\\C[1]Hello", "\\V[1]你好");
  assert.equal(changed.ok, false);
  assert.ok(changed.blocking.some((finding) => finding.code === "placeholder_mismatch"));

  const preserved = validateTranslationCandidate("\\C[1]Hello", "\\C[1]你好");
  assert.equal(preserved.ok, true, preserved.summary);
});

await test("explicit engine IDs must preserve their exact value", () => {
  const changed = validateTranslationCandidate("ID=42 Hello", "ID=43 你好");
  assert.equal(changed.ok, false);
  assert.ok(changed.blocking.some((finding) => finding.code === "placeholder_mismatch"));

  const preserved = validateTranslationCandidate("ID=42 Hello", "ID=42 你好");
  assert.equal(preserved.ok, true, preserved.summary);
});

await test("tag mismatch is blocking", () => {
  const src = "<color=#FF0000>こんにちは</color>";
  const cand = "你好";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((f) => f.code === "tag_mismatch"));
});

await test("tag preserved passes", () => {
  const src = "<color=#FF0000>こんにちは</color>";
  const cand = "<color=#FF0000>你好</color>";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, true, result.summary);
});

await test("tag extractor recognizes VN color tags without space before =", () => {
  const line = "<color=#FF0000>{player_name}你好</color>";
  const result = validateTranslationCandidate(
    `source line\n${line}`,
    `译文行\n${line.replace("你好", "hello")}`
  );
  assert.equal(result.ok, true, result.summary);
});

await test("tag mismatch lists missing opening and closing tags", () => {
  const src = "<color=#FF0000>{player_name}こんにちは</color>";
  const cand = "{player_name}你好";
  const result = validateTranslationCandidate(src, cand, { locale: "zh-CN" });
  const tagFinding = result.blocking.find((f) => f.code === "tag_mismatch");
  assert.ok(tagFinding);
  assert.match(tagFinding.detail, /<color=#FF0000>/);
  assert.match(tagFinding.detail, /<\/color>/);
  assert.match(tagFinding.detail, /候选缺少/);
});

await test("double-bracket code markup must be preserved", () => {
  const src = "Hello [[player_name]], welcome.";
  const cand = "你好 [[player_name]]，欢迎。";
  assert.equal(validateTranslationCandidate(src, cand).ok, true);
  const bad = "你好，欢迎。";
  assert.equal(validateTranslationCandidate(src, bad).ok, false);
});

await test("single-bracket ASCII markup must be preserved", () => {
  const src = "Wait [npc:001] then continue.";
  const cand = "等待 [npc:001] 然后继续。";
  assert.equal(validateTranslationCandidate(src, cand).ok, true);
});

await test("single-bracket CJK stage direction is not treated as code", () => {
  const src = "彼は言った。[待ち] そして去った。";
  const cand = "他说了。然后离开了。";
  assert.equal(validateTranslationCandidate(src, cand).ok, true);
});

await test("looksLikeCodePayload distinguishes ASCII code from CJK prose", () => {
  assert.equal(looksLikeCodePayload("player_name"), true);
  assert.equal(looksLikeCodePayload("npc:001"), true);
  assert.equal(looksLikeCodePayload("待ち"), false);
  assert.equal(looksLikeCodePayload(""), false);
});

await test("empty line displacement is a warning, not blocking", () => {
  const src = "line1\n\nline3";
  const cand = "第一行\n第二行\n第三行";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "empty_line_displaced"));
});

await test("likely untranslated kana residue is a warning for ja source", () => {
  const src = "牧瀬紅莉栖は岡部倫太郎にDメールの話をした。";
  const cand = "牧瀬紅莉栖は岡部倫太郎に話をした。"; // still kana
  const result = validateTranslationCandidate(src, cand, { languagePair: "ja->zh-CN" });
  assert.ok(result.warnings.some((f) => f.code === "likely_untranslated"), "expected likely_untranslated warning");
});

await test("a translated Chinese line may preserve one short Japanese proper noun", () => {
  const src = "タイカ帝国が子どもの思想教育用に作ったマスコット『ぴも太』を模した素体を作り出した。";
  const cand = "泰卡帝国制造了一个模仿儿童思想教育吉祥物『ぴも太』的素体。";
  const result = validateTranslationCandidate(src, cand, { languagePair: "ja->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated").length, 0);
});

await test("punctuation-only lines are not flagged as untranslated", () => {
  const src = "……\n!!!\nHello world";
  const cand = "……\n!!!\nHello world";
  const result = validateTranslationCandidate(src, cand, { languagePair: "en->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated" && f.line === 1).length, 0);
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated" && f.line === 2).length, 0);
  assert.ok(result.blocking.some((f) => f.code === "likely_untranslated" && f.line === 3));
});

await test("number-only lines are not flagged as untranslated", () => {
  const src = "100\n50%\nHello world";
  const cand = "100\n50%\nHello world";
  const result = validateTranslationCandidate(src, cand, { languagePair: "en->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated" && f.line === 1).length, 0);
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated" && f.line === 2).length, 0);
  assert.ok(result.blocking.some((f) => f.code === "likely_untranslated" && f.line === 3));
});

await test("prose core ignores punctuation and digits but still detects copied source text", () => {
  const src = "Hello, world! 123";
  const cand = "Hello world? 456";
  assert.equal(proseCore(stripPreservedPayload(src, (line) => line.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? [], () => [])), "Helloworld");
  const result = validateTranslationCandidate(src, cand, { languagePair: "en->zh-CN" });
  assert.ok(result.blocking.some((f) => f.code === "likely_untranslated"));
});

await test("translated line without source-language script does not warn", () => {
  const src = "世界線が変わった。";
  const cand = "世界线改变了。";
  const result = validateTranslationCandidate(src, cand, { languagePair: "ja->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated").length, 0);
});

await test("translated line with different punctuation does not false-positive on ja", () => {
  const src = "こんにちは。";
  const cand = "你好！";
  const result = validateTranslationCandidate(src, cand, { languagePair: "ja->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated").length, 0);
});

await test("english source copied into candidate blocks completion for en->zh-CN", () => {
  const src = "Press START to continue";
  const cand = "Press START to continue";
  const result = validateTranslationCandidate(src, cand, { languagePair: "en->zh-CN" });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((f) => f.code === "likely_untranslated"));
});

await test("english source translated to chinese does not warn", () => {
  const src = "Press START to continue";
  const cand = "按下按钮继续";
  const result = validateTranslationCandidate(src, cand, { languagePair: "en->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated").length, 0);
});

await test("deterministic validation does not guess target-language semantics", () => {
  const cases = [
    ["This is a translation.", "这是翻译。", "en->zh-CN"],
    ["This is the Chinese translation.", "这是中文译文。", "en->zh-CN"],
    ["これは翻訳です。", "这是翻译。", "ja->zh-CN"],
    ["これは最終版です。", "这是最终版本。", "ja->zh-CN"],
    ["以下が結果です。", "下面是结果。", "ja->zh-CN"],
    ["翻訳済みです。", "已经翻译完成。", "ja->zh-CN"],
    ["Here is the result.", "结果如下。", "en->zh-CN"],
    ["The result is below.", "结果在下面。", "en->zh-CN"],
    ["結果は以下の通りです。", "结果如下。", "ja->zh-CN"],
    ["以下は訳文です。", "以下是译文。", "ja->zh-CN"],
    ["결과는 다음과 같습니다.", "结果如下。", "ko->zh-CN"]
  ];
  for (const [source, candidate, languagePair] of cases) {
    const result = validateTranslationCandidate(source, candidate, { languagePair });
    assert.equal(result.ok, true, `${candidate} is a structurally valid candidate for ${source}`);
  }
});

await test("english source with only one preserved UI token does not warn", () => {
  const src = "Press START to continue";
  const cand = "按 START 继续";
  const result = validateTranslationCandidate(src, cand, { languagePair: "en->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated").length, 0);
});

await test("placeholder-only line is not flagged as untranslated", () => {
  const src = "{player_name}";
  const cand = "{player_name}";
  const result = validateTranslationCandidate(src, cand, { languagePair: "ja->zh-CN" });
  assert.equal(result.warnings.filter((f) => f.code === "likely_untranslated").length, 0);
});

await test("parseSourceLanguageFromPair accepts common aliases", () => {
  assert.equal(parseSourceLanguageFromPair("ja->zh-CN"), "ja");
  assert.equal(parseSourceLanguageFromPair("English => Chinese"), "en");
  assert.equal(parseSourceLanguageFromPair("ko->en"), "ko");
});

await test("splitTextLines normalizes CRLF and drops trailing newline", () => {
  assert.deepEqual(splitTextLines("a\r\nb\r\n"), ["a", "b"]);
  assert.deepEqual(splitTextLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitTextLines(undefined), []);
  assert.deepEqual(splitTextLines(""), []);
});

await test("mixed line with placeholder and tag validates both", () => {
  const src = "<color=#FF0000>{player_name} こんにちは</color>";
  const cand = "<color=#FF0000>{player_name} 你好</color>";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, true, result.summary);
});

await test("missing placeholder in mixed line is blocking", () => {
  const src = "<color=#FF0000>{player_name} こんにちは</color>";
  const cand = "<color=#FF0000>你好</color>";
  const result = validateTranslationCandidate(src, cand);
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((f) => f.code === "placeholder_mismatch"));
});

await test("glossary entries warn when the source term appears without the target term", () => {
  const result = validateTranslationCandidate("王都騎士団が来た。", "骑士来了。", {
    glossaryEntries: [{ source: "王都騎士団", target: "王都骑士团" }]
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "glossary_missing"));
});

await test("glossary aliases satisfy glossary warnings", () => {
  const result = validateTranslationCandidate("王都騎士団が来た。", "首都骑士团来了。", {
    glossaryEntries: [{ source: "王都騎士団", target: "王都骑士团", aliases: ["首都骑士团"] }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.filter((f) => f.code === "glossary_missing").length, 0);
});

await test("a shorter glossary term covered by a longer source match does not create an H3 false positive", () => {
  const result = validateTranslationCandidate("ハルマゲドン", "哈米吉多顿", {
    languagePair: "ja->zh-CN",
    glossaryEntries: [
      { source: "ハルマ", target: "哈尔玛" },
      { source: "ハルマゲドン", target: "哈米吉多顿" }
    ]
  });
  assert.equal(result.warnings.some((finding) => finding.code === "glossary_missing"), false);
});

await test("character bible entries warn when a character name is dropped", () => {
  const result = validateTranslationCandidate("遥娜は笑った。", "她笑了。", {
    characterEntries: [{ name: "遥娜" }]
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "character_name_missing"));
});

await test("character aliases satisfy character name warnings", () => {
  const result = validateTranslationCandidate("遥娜は笑った。", "小遥笑了。", {
    characterEntries: [{ name: "遥娜", aliases: ["小遥"] }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.filter((f) => f.code === "character_name_missing").length, 0);
});

await test("character voice required and forbidden terms warn when explicit rules are violated", () => {
  const result = validateTranslationCandidate("遥娜は笑った。", "遥娜露出了机器翻译腔的笑容。", {
    characterEntries: [{
      name: "遥娜",
      requiredTerms: ["咱家"],
      forbiddenTerms: ["机器翻译腔"]
    }]
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "character_voice_required_missing"));
  assert.ok(result.warnings.some((f) => f.code === "character_voice_forbidden_term"));
});

await test("style guide forbidden terms warn when candidate contains a forbidden term", () => {
  const result = validateTranslationCandidate("彼は笑った。", "他露出了机器翻译腔的笑容。", {
    styleForbiddenTerms: ["机器翻译腔"]
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "style_forbidden_term"));
});

await test("style and voice rule scores summarize explicit asset compliance", () => {
  const result = validateTranslationCandidate("遥娜は笑った。\n彼は去った。", "遥娜露出了机器翻译腔的笑容。\n他走了。", {
    characterEntries: [{
      name: "遥娜",
      requiredTerms: ["咱家"],
      forbiddenTerms: ["机器翻译腔"]
    }],
    styleForbiddenTerms: ["机器翻译腔"]
  });
  assert.equal(result.styleScore, 50);
  assert.equal(result.voiceScore, 0);
  assert.match(result.summary, /style 50\/100/i);
  assert.match(result.summary, /voice 0\/100/i);
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
