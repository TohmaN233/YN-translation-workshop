// Deterministic translation validator — the host-side line-alignment invariant.
//
// Per RFC 5.4, "行对行" must be a data invariant enforced by the host, not a
// prompt convention the agent is trusted to honor. Before any candidate
// translation is imported into the workbench, this validator runs and blocks
// import on structural mismatch. Warnings do not block, but surface in the
// artifact card so the user can decide.
//
// This module is pure (no fs, no Electron) so it can be unit-tested with
// fixtures and reused from the renderer.

import {
  compileCustomPreserveRule,
  normalizeCustomPreserveRules,
  type CustomPreserveRule
} from "./customPreserveRules.ts";

export type ValidationSeverity = "blocking" | "warning";

export type ValidationCode =
  | "line_count_mismatch"
  | "placeholder_mismatch"
  | "custom_preserve_mismatch"
  | "tag_mismatch"
  | "generic_translation_placeholder"
  | "repeated_short_candidate"
  | "repeated_candidate_run"
  | "empty_line_displaced"
  | "likely_untranslated"
  | "glossary_missing"
  | "terminology_inconsistency"
  | "character_name_missing"
  | "character_pronoun_mismatch"
  | "character_voice_required_missing"
  | "character_voice_forbidden_term"
  | "style_forbidden_term"
  | "length_anomaly";

export interface ValidationFinding {
  code: ValidationCode;
  severity: ValidationSeverity;
  line?: number;
  detail: string;
}

export interface TranslationValidationResult {
  ok: boolean;
  sourceLineCount: number;
  candidateLineCount: number;
  blocking: ValidationFinding[];
  warnings: ValidationFinding[];
  styleScore?: number;
  voiceScore?: number;
  summary: string;
}

export type SourceLanguageKey = "ja" | "ko" | "en" | "zh";

export interface ValidationOptions {
  /** UI locale for human-readable finding details. Defaults to zh-CN. */
  locale?: "zh-CN" | "en-US";
  /**
   * Project language pair, e.g. `ja->zh-CN`. Used to pick source-language residue
   * heuristics for likely_untranslated warnings.
   */
  languagePair?: string;
  /** Override parsed source language from languagePair when needed. */
  sourceLanguage?: SourceLanguageKey;
  /**
   * Extract placeholders from a line. Defaults to a conservative regex covering
   * {name}, %s, %d, $1, ${expr}, \\n / \\t escapes, engine control commands
   * such as \C[1], and explicit IDs such as ID=42.
   * Override when a project has additional placeholder conventions.
   */
  extractPlaceholders?: (line: string) => string[];
  /**
   * Extract code/markup spans that must be preserved verbatim (angle brackets,
   * square brackets, etc.). Defaults to a heuristic: bracketed segments whose
   * inner payload is ASCII letters/digits/punctuation only — no CJK — are
   * treated as engine code, not translatable prose.
   */
  extractTags?: (line: string) => string[];
  /** Project-defined source spans that must survive verbatim on the same candidate line. */
  customPreserveRules?: CustomPreserveRule[];
  /**
   * When true, emit likely_untranslated warnings using language-pair-aware rules.
   * Defaults to true.
   */
  detectUntranslated?: boolean;
  /** Glossary entries whose target term should appear when the source term appears. */
  glossaryEntries?: Array<{ source?: string; target?: string; aliases?: string[] }>;
  /** Character bible entries whose names/aliases should survive line translation. */
  characterEntries?: Array<{
    name?: string;
    target?: string;
    aliases?: string[];
    gender?: string;
    pronouns?: string;
    genderConfidence?: string;
    requiredTerms?: string[];
    forbiddenTerms?: string[];
  }>;
  /** Style-guide terms that should not appear in candidate text. */
  styleForbiddenTerms?: string[];
}

const DEFAULT_PLACEHOLDER_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}|%[sd]|%[0-9]+\$[sd]|\$\{[^}]+\}|\$[0-9]+|\\[A-Za-z]+(?:\[[^\]\r\n]*\])?|\\[{}.!|><^\\]|\bID\s*[:=]\s*[A-Za-z0-9_.-]+/gi;

/** CJK / kana / hangul — if present inside brackets, treat as prose/stage direction, not code. */
const NON_CODE_SCRIPT_RE = /[\u3000-\u9fff\uac00-\ud7af\u3040-\u30ff\uff00-\uffef]/;

/**
 * Bracket inner payload looks like engine/code text: printable ASCII with at
 * least one letter or digit (avoids matching `[]` or `**` noise).
 */
export function looksLikeCodePayload(inner: string): boolean {
  const payload = inner.trim();
  if (!payload) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(payload)) {
    return false;
  }
  if (NON_CODE_SCRIPT_RE.test(payload)) {
    return false;
  }
  return /^[\x20-\x7E]+$/.test(payload);
}

/**
 * Extract code/markup spans that must survive translation unchanged.
 *
 * 1. `[[ ... ]]` when inner payload passes looksLikeCodePayload
 * 2. `< ... >` angle markup (VN/HTML control codes)
 * 3. `[ ... ]` single brackets when inner passes looksLikeCodePayload (not `[[`)
 *
 * Examples treated as code: `<color=#FF0000>`, `[[name]]`, `[npc:id]`, `[/wait]`
 * Examples ignored (prose): `[待ち]`, `[こんにちは]`
 */
export function extractCodeMarkup(line: string): string[] {
  const spans: string[] = [];

  for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (looksLikeCodePayload(match[1])) {
      spans.push(match[0]);
    }
  }

  for (const match of line.matchAll(/<[^>]+>/g)) {
    spans.push(match[0]);
  }

  for (const match of line.matchAll(/(?<!\[)\[(?!\[)([^\]]+)\](?!\])/g)) {
    if (looksLikeCodePayload(match[1])) {
      spans.push(match[0]);
    }
  }

  return spans;
}

function defaultExtractTags(line: string): string[] {
  return extractCodeMarkup(line);
}

function isProbablyEmpty(line: string): boolean {
  return line.trim() === "";
}

const SOURCE_LANGUAGE_ALIASES: Record<string, SourceLanguageKey> = {
  ja: "ja",
  jp: "ja",
  japanese: "ja",
  ko: "ko",
  kr: "ko",
  korean: "ko",
  en: "en",
  english: "en",
  zh: "zh",
  cn: "zh",
  chinese: "zh",
  "zh-cn": "zh",
  "zh-tw": "zh",
  "zh-hans": "zh",
  "zh-hant": "zh"
};

/** Parse the source side of a language pair string (`ja->zh-CN`, `en => zh-CN`). */
export function parseSourceLanguageFromPair(languagePair: string | undefined): SourceLanguageKey | undefined {
  if (!languagePair?.trim()) {
    return undefined;
  }
  const left = languagePair.trim().split(/\s*(?:->|→|=>|>|—)\s*/i)[0]?.trim().toLowerCase() ?? "";
  if (!left) {
    return undefined;
  }
  const compact = left.replace(/[^a-z0-9-]/g, "");
  return SOURCE_LANGUAGE_ALIASES[left] ?? SOURCE_LANGUAGE_ALIASES[compact];
}

/** Parse the target side of a language pair string (`ja->zh-CN`, `en => zh-CN`). */
export function parseTargetLanguageFromPair(languagePair: string | undefined): SourceLanguageKey | undefined {
  if (!languagePair?.trim()) {
    return undefined;
  }
  const parts = languagePair.trim().split(/\s*(?:->|→|=>|>|—)\s*/i);
  const right = parts.length > 1 ? parts.at(-1)?.trim().toLowerCase() ?? "" : "";
  if (!right) {
    return undefined;
  }
  const compact = right.replace(/[^a-z0-9-]/g, "");
  return SOURCE_LANGUAGE_ALIASES[right] ?? SOURCE_LANGUAGE_ALIASES[compact];
}

/** Strip placeholders and code/markup spans before prose comparison. */
export function stripPreservedPayload(
  line: string,
  extractPlaceholders: (line: string) => string[],
  extractTags: (line: string) => string[]
): string {
  let text = line;
  const spans = [...extractPlaceholders(line), ...extractTags(line)].sort((left, right) => right.length - left.length);
  for (const span of spans) {
    if (!span) {
      continue;
    }
    text = text.split(span).join("");
  }
  return text;
}

/** Translatable prose core: drop whitespace, punctuation/symbols, and digits. */
export function proseCore(text: string): string {
  return text.replace(/[\p{P}\p{S}\p{Z}\p{N}]/gu, "");
}

/** Whether stripped candidate text still contains script typical of the source language. */
export function candidateContainsSourceLanguage(
  payload: string,
  sourceLanguage: SourceLanguageKey
): boolean {
  switch (sourceLanguage) {
    case "ja":
      return /[\u3040-\u309f\u30a0-\u30ff]/.test(payload);
    case "ko":
      return /[\uac00-\ud7af]/.test(payload);
    case "en":
      return /[A-Za-z]/.test(payload);
    case "zh":
      return /[\u4e00-\u9fff]/.test(payload);
    default:
      return true;
  }
}

function hasTranslatableProse(
  line: string,
  extractPlaceholders: (line: string) => string[],
  extractTags: (line: string) => string[]
): boolean {
  return proseCore(stripPreservedPayload(line, extractPlaceholders, extractTags)).length > 0;
}

function sharedKanaRuns(sourcePayload: string, candidatePayload: string, minLength: number): boolean {
  const kana = /[\u3040-\u309f\u30a0-\u30ff]+/g;
  const srcRuns: string[] = sourcePayload.match(kana) ?? [];
  const sharedChars = srcRuns
    .filter((run) => run.length >= minLength && candidatePayload.includes(run))
    .reduce((sum, run) => sum + run.length, 0);
  if (sharedChars === 0) return false;
  return sharedChars / Math.max(1, proseCore(candidatePayload).length) >= 0.1;
}

function sharedHangulRuns(sourcePayload: string, candidatePayload: string, minLength: number): boolean {
  const hangul = /[\uac00-\ud7af]+/g;
  const srcRuns: string[] = sourcePayload.match(hangul) ?? [];
  return srcRuns.some((run) => run.length >= minLength && candidatePayload.includes(run));
}

function sharedHanRuns(sourcePayload: string, candidatePayload: string, minLength: number): boolean {
  const han = /[\u4e00-\u9fff]+/g;
  const srcRuns: string[] = sourcePayload.match(han) ?? [];
  return srcRuns.some((run) => run.length >= minLength && candidatePayload.includes(run));
}

function sharedHanSequenceResidue(sourcePayload: string, candidatePayload: string): boolean {
  const sourceHan = (sourcePayload.match(/[\u4e00-\u9fff]/g) ?? []).join("");
  const candidateHan = (candidatePayload.match(/[\u4e00-\u9fff]/g) ?? []).join("");
  if (sourceHan.length < 4 || candidateHan.length < 4) return false;

  const lengthRatio = Math.min(sourceHan.length, candidateHan.length)
    / Math.max(sourceHan.length, candidateHan.length);
  if (lengthRatio < 0.75) return false;

  const ngramCounts = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const ngram = value.slice(index, index + 2);
      counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
    }
    return counts;
  };
  const sourceNgrams = ngramCounts(sourceHan);
  const candidateNgrams = ngramCounts(candidateHan);
  let shared = 0;
  for (const [ngram, count] of sourceNgrams) {
    shared += Math.min(count, candidateNgrams.get(ngram) ?? 0);
  }
  return shared / Math.max(1, sourceHan.length - 1) >= 0.8
    && shared / Math.max(1, candidateHan.length - 1) >= 0.8;
}

function sharedLatinWords(sourcePayload: string, candidatePayload: string, minLength: number): boolean {
  const words: string[] = sourcePayload.match(/[A-Za-z]+/g) ?? [];
  const hits = words.filter((word) => word.length >= minLength && candidatePayload.includes(word));
  if (hits.length === 0) {
    return false;
  }
  const hitChars = hits.reduce((sum, word) => sum + word.length, 0);
  const sourceChars = words.reduce((sum, word) => sum + word.length, 0);
  return hits.length >= 2 || (sourceChars > 0 && hitChars / sourceChars >= 0.6);
}

function languageSpecificResidue(
  sourcePayload: string,
  candidatePayload: string,
  sourceLanguage: SourceLanguageKey
): boolean {
  switch (sourceLanguage) {
    case "ja":
      return sharedKanaRuns(sourcePayload, candidatePayload, 3);
    case "ko":
      return sharedHangulRuns(sourcePayload, candidatePayload, 2);
    case "zh":
      return sharedHanRuns(sourcePayload, candidatePayload, 2);
    case "en":
      return sharedLatinWords(sourcePayload, candidatePayload, 4);
    default:
      return false;
  }
}

/**
 * Language-pair-aware "likely untranslated" detection.
 *
 * 1. Strip placeholders + code/markup, then compare prose cores with punctuation,
 *    digits, and whitespace ignored. Lines with no translatable prose never trigger.
 * 2. If the candidate no longer contains source-language script, assume translated.
 * 3. When sourceLanguage is known, apply conservative script-specific residue rules.
 *    Chinese-to-Japanese needs pair-aware high-overlap detection because ordinary
 *    Japanese naturally shares Han characters with the Chinese source.
 */
export function looksLikeSourceResidue(
  source: string,
  candidate: string,
  options: {
    extractPlaceholders: (line: string) => string[];
    extractTags: (line: string) => string[];
    sourceLanguage?: SourceLanguageKey;
    targetLanguage?: SourceLanguageKey;
  }
): boolean {
  if (!source || !candidate) {
    return false;
  }

  const { extractPlaceholders, extractTags, sourceLanguage, targetLanguage } = options;
  const srcPayload = stripPreservedPayload(source, extractPlaceholders, extractTags);
  const candPayload = stripPreservedPayload(candidate, extractPlaceholders, extractTags);
  const srcCore = proseCore(srcPayload);
  const candCore = proseCore(candPayload);

  if (!srcCore) {
    return false;
  }

  if (sourceLanguage && !candidateContainsSourceLanguage(candPayload, sourceLanguage)) {
    return false;
  }

  if (srcCore === candCore) {
    return true;
  }

  if (!sourceLanguage) {
    return false;
  }

  if (sourceLanguage === "zh" && targetLanguage === "ja") {
    return sharedHanSequenceResidue(srcPayload, candPayload);
  }

  return languageSpecificResidue(srcPayload, candPayload, sourceLanguage);
}

type ValidatorLocale = "zh-CN" | "en-US";

function validatorLocale(options: ValidationOptions): ValidatorLocale {
  return options.locale === "en-US" ? "en-US" : "zh-CN";
}

function lineCountMismatchDetail(sourceCount: number, candidateCount: number, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `原文 ${sourceCount} 行，候选译文 ${candidateCount} 行。行数不一致，无法按行导入；请重新生成或修复候选译文。`;
  }
  return `Source has ${sourceCount} lines but candidate has ${candidateCount} lines. Line-aligned import is impossible until the candidate is regenerated or repaired.`;
}

function placeholderMismatchDetail(lineNo: number, srcPh: string[], candPh: string[], locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行占位符不一致：原文 [${srcPh.join(", ")}]，候选 [${candPh.join(", ")}]。`;
  }
  return `Placeholder mismatch on line ${lineNo}: source has [${srcPh.join(", ")}] but candidate has [${candPh.join(", ")}].`;
}

function customPreserveMismatchDetail(
  lineNo: number,
  label: string,
  sourceMatches: string[],
  candidateMatches: string[],
  locale: ValidatorLocale
): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行未按自定义保留规则「${label}」原样保留；原文匹配 ${JSON.stringify(sourceMatches)}，译文匹配 ${JSON.stringify(candidateMatches)}。`;
  }
  return `Line ${lineNo} violates custom preservation rule "${label}": source matches ${JSON.stringify(sourceMatches)}, candidate matches ${JSON.stringify(candidateMatches)}.`;
}

function regexMatches(line: string, regex: RegExp): string[] {
  regex.lastIndex = 0;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) matches.push(match[0]);
  regex.lastIndex = 0;
  return matches;
}

function tagMultisetDiff(expected: string[], actual: string[]): string[] {
  const counts = new Map<string, number>();
  for (const tag of expected) {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  for (const tag of actual) {
    counts.set(tag, (counts.get(tag) ?? 0) - 1);
  }
  const missing: string[] = [];
  for (const [tag, count] of counts) {
    for (let i = 0; i < count; i += 1) {
      missing.push(tag);
    }
  }
  return missing.sort();
}

function tagMismatchDetail(lineNo: number, srcTags: string[], candTags: string[], locale: ValidatorLocale): string {
  const missingInCandidate = tagMultisetDiff(srcTags, candTags);
  const extraInCandidate = tagMultisetDiff(candTags, srcTags);
  if (locale === "zh-CN") {
    const parts = [`第 ${lineNo} 行代码/标记不一致：原文 [${srcTags.join(", ")}]，候选 [${candTags.join(", ")}]`];
    if (missingInCandidate.length > 0) {
      parts.push(`候选缺少 [${missingInCandidate.join(", ")}]`);
    }
    if (extraInCandidate.length > 0) {
      parts.push(`候选多出 [${extraInCandidate.join(", ")}]`);
    }
    return `${parts.join("；")}。`;
  }
  const parts = [`Tag mismatch on line ${lineNo}: source [${srcTags.join(", ")}], candidate [${candTags.join(", ")}]`];
  if (missingInCandidate.length > 0) {
    parts.push(`candidate missing [${missingInCandidate.join(", ")}]`);
  }
  if (extraInCandidate.length > 0) {
    parts.push(`candidate extra [${extraInCandidate.join(", ")}]`);
  }
  return `${parts.join("; ")}.`;
}

export function splitTextLines(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").replace(/\r$/, "").replace(/\n$/, "").split("\n");
}

function defaultExtractPlaceholders(line: string): string[] {
  return line.match(DEFAULT_PLACEHOLDER_RE) ?? [];
}

export function createTranslationPreservedPayloadStripper(
  options: Pick<ValidationOptions, "extractPlaceholders" | "extractTags" | "customPreserveRules"> = {}
): (line: string) => string {
  const extractPlaceholders = options.extractPlaceholders ?? defaultExtractPlaceholders;
  const extractTags = options.extractTags ?? defaultExtractTags;
  const customRules = normalizeCustomPreserveRules(options.customPreserveRules)
    .map((rule) => compileCustomPreserveRule(rule));
  return (line) => stripPreservedPayload(
    line,
    (value) => [
      ...extractPlaceholders(value),
      ...customRules.flatMap((regex) => regexMatches(value, regex))
    ],
    extractTags
  );
}

function emptyLineDetail(lineNo: number, srcEmpty: boolean, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行空行结构变化：原文${srcEmpty ? "为空" : "非空"}，候选${srcEmpty ? "非空" : "为空"}。`;
  }
  return `Line ${lineNo} empty-line structure changed: source is ${srcEmpty ? "empty" : "non-empty"}, candidate is ${srcEmpty ? "empty" : "non-empty"}.`;
}

function untranslatedDetail(lineNo: number, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行疑似未翻译：候选仍保留源语言可译正文（已忽略标点与数字，并排除占位符/代码标记）。`;
  }
  return `Line ${lineNo} looks untranslated: candidate still carries source-language prose (punctuation and digits ignored; placeholders/tags excluded).`;
}

function lengthAnomalyDetail(
  lineNo: number,
  sourceLength: number,
  candidateLength: number,
  locale: ValidatorLocale
): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行原文与候选的正文长度比例异常（原文 ${sourceLength}，候选 ${candidateLength}）；这只是错行/漏译风险证据，需结合相邻行语义复核。`;
  }
  return `Line ${lineNo} has an unusual source/candidate prose-length ratio (${sourceLength} vs ${candidateLength}); this is review evidence for possible omission or shifted alignment, not a semantic verdict.`;
}

const GENERIC_TRANSLATION_PLACEHOLDERS = new Set([
  "本段译文",
  "本行译文",
  "本节译文",
  "此处译文",
  "中文译文",
  "译文待补",
  "待翻译",
  "已翻译",
  "翻译完成",
  "已翻译完成",
  "这是中文翻译",
  "translation goes here",
  "translated text",
  "translation pending"
]);

function isGenericTranslationPlaceholder(line: string): boolean {
  const normalized = line.normalize("NFKC").trim()
    .replace(/^[\s([{<「『【《*_`'"~-]+|[\s)\]}>」』】》*_`'"~.!。！?？:：;-]+$/gu, "")
    .trim()
    .toLocaleLowerCase();
  return GENERIC_TRANSLATION_PLACEHOLDERS.has(normalized)
    || /^(?:(?:这|此)(?:是|为)?|以下是)?(?:简体)?中文(?:的)?(?:译文|翻译(?:文本|内容)?)(?:如下|完成|已完成|待补)?$/u.test(normalized)
    || /^(?:this is |the following is )?(?:translated text|translation(?: text| content)?)(?: goes here| pending| complete| completed)?$/u.test(normalized);
}

function sourceDescribesTranslationMeta(line: string): boolean {
  const normalized = line.normalize("NFKC").toLocaleLowerCase();
  return /\btranslat(?:e|ed|es|ing|ion|ions)\b/u.test(normalized)
    || /翻译|譯文|译文|翻訳|訳文|번역/u.test(normalized);
}

function genericTranslationPlaceholderDetail(lineNo: number, locale: ValidatorLocale): string {
  return locale === "zh-CN"
    ? `第 ${lineNo} 行是占位译文，不是源文对应的实际译文。`
    : `Line ${lineNo} is generic placeholder prose rather than the actual translation.`;
}

function repeatedShortCandidateDetail(lineNo: number, locale: ValidatorLocale): string {
  return locale === "zh-CN"
    ? `第 ${lineNo} 行与多个不同长原文复用了同一条过短候选，疑似批量占位译文。`
    : `Line ${lineNo} reuses the same very short candidate for several distinct long source lines, indicating batch placeholder text.`;
}

function repeatedCandidateRunDetail(lineNo: number, locale: ValidatorLocale): string {
  return locale === "zh-CN"
    ? `第 ${lineNo} 行属于连续重复候选：多个不同原文复用了完全相同的译文，疑似批量占位或错位写入。`
    : `Line ${lineNo} belongs to a consecutive repeated candidate run: distinct source lines reuse exactly the same translation, indicating placeholder or shifted output.`;
}

function comparableTerm(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function textContainsTerm(text: string, term: string): boolean {
  const normalizedText = comparableTerm(text);
  const normalizedTerm = comparableTerm(term);
  return Boolean(normalizedTerm && normalizedText.includes(normalizedTerm));
}

function uniqueComparableTerms(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    const term = value?.trim() ?? "";
    const key = comparableTerm(term);
    if (!term || !key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function glossaryCatalogTerms(
  entries: Array<{ source?: string; target?: string; aliases?: string[] }>
): string[] {
  return uniqueComparableTerms(entries.flatMap((entry) => [
    entry.source,
    entry.target,
    ...(entry.aliases ?? [])
  ]));
}

function shorterRegisteredNameForms(longTarget: string, catalog: string[]): string[] {
  const normalizedLong = comparableTerm(longTarget);
  if (!normalizedLong) return [];
  return catalog.filter((term) => {
    const normalized = comparableTerm(term);
    return Boolean(normalized && normalized !== normalizedLong && normalizedLong.includes(normalized));
  });
}

function glossaryAcceptableTargets(
  entry: { source?: string; target?: string; aliases?: string[] },
  catalog: string[]
): string[] {
  const target = entry.target?.trim() ?? "";
  return uniqueComparableTerms([
    target,
    ...(entry.aliases ?? []),
    ...shorterRegisteredNameForms(target, catalog),
    ...(entry.source && target && comparableTerm(target).includes(comparableTerm(entry.source))
      ? [entry.source]
      : [])
  ]);
}

function characterNameVariants(entry: {
  name?: string;
  target?: string;
  aliases?: string[];
}): string[] {
  return uniqueComparableTerms([entry.target, entry.name, ...(entry.aliases ?? [])]);
}

export function parseCharacterVoiceRequiredTerm(term: string): { source: string; target: string } | undefined {
  const match = term.trim().match(/^(.+?)\s*(?:->|=>|→)\s*(.+)$/);
  if (!match) return undefined;
  const source = match[1].trim();
  const target = match[2].trim();
  if (!source || !target) return undefined;
  return { source, target };
}

export function normalizeHandwrittenCharacterRequiredTerms(
  terms: string[],
  character: { name?: string; target?: string; aliases?: string[] }
): string[] {
  return terms.map((term) => {
    const mapping = parseCharacterVoiceRequiredTerm(term);
    if (!mapping) {
      throw new Error(`Character required terms must use "source -> target". Invalid value: ${term}`);
    }
    if (
      isExactCharacterNameVariant(character, mapping.source)
      || isExactCharacterNameVariant(character, mapping.target)
    ) {
      throw new Error(
        `Character required terms cannot use a character name as the source or target: ${mapping.source} -> ${mapping.target}`
      );
    }
    return `${mapping.source} -> ${mapping.target}`;
  });
}

function isExactCharacterNameVariant(
  entry: { name?: string; target?: string; aliases?: string[] },
  term: string
): boolean {
  const normalized = comparableTerm(term);
  if (!normalized) return false;
  return characterNameVariants(entry).some((variant) => comparableTerm(variant) === normalized);
}

function quotedDialogueSpans(text: string): string[] {
  const spans: string[] = [];
  const pattern = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"/g;
  for (const match of text.matchAll(pattern)) {
    spans.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  }
  return spans;
}

function textOutsideQuotedDialogue(text: string): string {
  return text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, " ");
}

function characterSpeaksOnLine(
  line: string,
  entry: { name?: string; aliases?: string[] }
): boolean {
  const outside = textOutsideQuotedDialogue(line);
  return [entry.name, ...(entry.aliases ?? [])]
    .filter((term): term is string => Boolean(term?.trim()))
    .some((term) => textContainsTerm(outside, term));
}

function longestUncoveredGlossaryEntries(
  sourceText: string,
  entries: Array<{ source?: string; target?: string; aliases?: string[] }>
): Array<{ source?: string; target?: string; aliases?: string[] }> {
  const normalizedSource = comparableTerm(sourceText);
  const covered: Array<{ from: number; to: number }> = [];
  return [...entries]
    .sort((left, right) => comparableTerm(right.source ?? "").length - comparableTerm(left.source ?? "").length)
    .filter((entry) => {
      const term = comparableTerm(entry.source ?? "");
      if (!term) return false;
      const occurrences: Array<{ from: number; to: number }> = [];
      let from = 0;
      while (from <= normalizedSource.length - term.length) {
        const index = normalizedSource.indexOf(term, from);
        if (index < 0) break;
        occurrences.push({ from: index, to: index + term.length });
        from = index + 1;
      }
      const hasIndependentOccurrence = occurrences.some((occurrence) => !covered.some(
        (span) => span.from <= occurrence.from && span.to >= occurrence.to
      ));
      if (!hasIndependentOccurrence) return false;
      covered.push(...occurrences);
      return true;
    });
}

export function sourceHasIndependentTermOccurrence(
  sourceText: string,
  term: string,
  catalogSources: Array<string | undefined>
): boolean {
  const normalizedTerm = comparableTerm(term);
  if (!normalizedTerm) return false;
  const catalog = uniqueComparableTerms([term, ...catalogSources]);
  return longestUncoveredGlossaryEntries(
    sourceText,
    catalog.map((source) => ({ source }))
  ).some((entry) => comparableTerm(entry.source ?? "") === normalizedTerm);
}

export interface ResolvedTerminologyConflict {
  line: number;
  source: string;
  expectedTarget: string;
  observedTargets: string[];
}

export function scanResolvedTerminologyConflicts(args: {
  sourceLines: string[];
  candidateLines: string[];
  terms: Array<{ source: string; target: string; observedTargets: string[] }>;
  coveringEntries?: Array<{ source?: string; target?: string; aliases?: string[] }>;
}): ResolvedTerminologyConflict[] {
  const coveringEntries = [
    ...args.terms.map((term) => ({ source: term.source, target: term.target })),
    ...(args.coveringEntries ?? [])
  ].filter((entry) => comparableTerm(entry.source ?? ""));
  const conflicts: ResolvedTerminologyConflict[] = [];
  for (const term of args.terms) {
    const variants = [...new Set(term.observedTargets.map((value) => value.trim()).filter(Boolean))];
    if (variants.length < 2) continue;
    const competing = variants.filter((target) => target !== term.target);
    if (competing.length === 0) continue;
    for (const [index, sourceLine] of args.sourceLines.entries()) {
      if (!sourceHasIndependentTermOccurrence(
        sourceLine,
        term.source,
        coveringEntries.map((entry) => entry.source)
      )) continue;
      const candidateLine = args.candidateLines[index] ?? "";
      if (textContainsTerm(candidateLine, term.target)) continue;
      const independentEntries = longestUncoveredGlossaryEntries(sourceLine, coveringEntries);
      const explainedTargets = new Set(
        independentEntries
          .filter((entry) => comparableTerm(entry.source ?? "") !== comparableTerm(term.source))
          .flatMap((entry) => uniqueComparableTerms([entry.target, ...(entry.aliases ?? [])]))
          .map(comparableTerm)
      );
      const observedTargets = competing.filter((target) => (
        textContainsTerm(candidateLine, target)
        && !explainedTargets.has(comparableTerm(target))
      ));
      if (observedTargets.length === 0) continue;
      conflicts.push({
        line: index + 1,
        source: term.source,
        expectedTarget: term.target,
        observedTargets
      });
    }
  }
  return conflicts;
}

export function terminologyInconsistencyFinding(
  conflict: ResolvedTerminologyConflict,
  locale: ValidatorLocale = "zh-CN"
): ValidationFinding {
  return {
    code: "terminology_inconsistency",
    severity: "warning",
    line: conflict.line,
    detail: locale === "zh-CN"
      ? `第 ${conflict.line} 行术语不一致：原文独立出现「${conflict.source}」，候选使用了「${conflict.observedTargets.join("、")}」，规范译名是「${conflict.expectedTarget}」。`
      : `Line ${conflict.line} terminology inconsistency: source independently has "${conflict.source}", candidate uses ${conflict.observedTargets.join(", ")}, expected "${conflict.expectedTarget}".`
  };
}

export function withAdditionalTranslationWarnings(
  validation: TranslationValidationResult,
  extra: ValidationFinding[],
  locale: ValidatorLocale = "zh-CN"
): TranslationValidationResult {
  if (extra.length === 0) return validation;
  const warnings = [...validation.warnings, ...extra];
  return {
    ...validation,
    warnings,
    summary: validationSummary(
      validation.ok,
      validation.sourceLineCount,
      validation.blocking.length,
      warnings.length,
      locale,
      { styleScore: validation.styleScore, voiceScore: validation.voiceScore }
    )
  };
}

function glossaryMissingDetail(lineNo: number, source: string, target: string, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行术语疑似缺失：原文出现「${source}」，候选未出现译名「${target}」。`;
  }
  return `Line ${lineNo} may be missing glossary term: source has "${source}" but candidate lacks "${target}".`;
}

function characterNameMissingDetail(lineNo: number, name: string, target: string, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行角色名疑似缺失：原文出现「${name}」，候选未出现角色名「${target}」。`;
  }
  return `Line ${lineNo} may be missing character name: source has "${name}" but candidate lacks "${target}".`;
}

type CharacterPronounGender = "male" | "female" | "neutral";

const CONFIRMED_GENDER_CONFIDENCE = new Set([
  "confirmed",
  "certain",
  "verified",
  "high",
  "人工确认",
  "已确认"
]);

function normalizedCharacterGender(entry: {
  gender?: string;
  pronouns?: string;
  genderConfidence?: string;
}): CharacterPronounGender | undefined {
  const confidence = comparableTerm(entry.genderConfidence ?? "");
  const explicitPronouns = comparableTerm(entry.pronouns ?? "");
  if (!CONFIRMED_GENDER_CONFIDENCE.has(confidence) && !explicitPronouns) {
    return undefined;
  }
  const value = comparableTerm(entry.gender ?? "");
  if (["male", "m", "man", "男性", "男"].includes(value)) return "male";
  if (["female", "f", "woman", "女性", "女"].includes(value)) return "female";
  if (["neutral", "nonbinary", "non-binary", "they/them", "中性", "无性别", "非二元"].includes(value)) {
    return "neutral";
  }
  if (/\b(?:she|her|hers)\b/i.test(explicitPronouns)) return "female";
  if (/\b(?:he|him|his)\b/i.test(explicitPronouns)) return "male";
  if (/\b(?:they|them|their|theirs)\b/i.test(explicitPronouns)) return "neutral";
  return undefined;
}

function textContainsEnglishPronoun(text: string, pronoun: string): boolean {
  return new RegExp(`(?<![A-Za-z])${pronoun}(?![A-Za-z])`, "i").test(text);
}

function mismatchedCharacterPronoun(
  candidate: string,
  gender: CharacterPronounGender,
  targetLanguage: SourceLanguageKey | undefined
): string | undefined {
  if (targetLanguage === "zh") {
    const wrong = gender === "male" ? ["她", "她们"]
      : gender === "female" ? ["他", "他们"]
      : ["他", "他们", "她", "她们"];
    return wrong.find((pronoun) => candidate.includes(pronoun));
  }
  if (targetLanguage === "en") {
    const wrong = gender === "male" ? ["she", "her", "hers"]
      : gender === "female" ? ["he", "him", "his"]
      : ["he", "him", "his", "she", "her", "hers"];
    return wrong.find((pronoun) => textContainsEnglishPronoun(candidate, pronoun));
  }
  return undefined;
}

function characterPronounMismatchDetail(
  lineNo: number,
  name: string,
  gender: CharacterPronounGender,
  pronoun: string,
  locale: ValidatorLocale
): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行角色「${name}」的代词「${pronoun}」与已确认性别/代词资料（${gender}）不一致。`;
  }
  return `Line ${lineNo} uses pronoun "${pronoun}" for character "${name}", conflicting with confirmed ${gender} gender/pronoun metadata.`;
}

function characterVoiceRequiredMissingDetail(
  lineNo: number,
  name: string,
  sourceTerm: string,
  targetTerm: string,
  locale: ValidatorLocale
): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行角色语气疑似不一致：角色「${name}」的台词使用了「${sourceTerm}」，候选未按角色圣经译为「${targetTerm}」。`;
  }
  return `Line ${lineNo} may violate character voice: "${name}" speaks "${sourceTerm}" but the candidate lacks required rendering "${targetTerm}".`;
}

function characterVoiceForbiddenTermDetail(lineNo: number, name: string, term: string, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行角色语气疑似不一致：角色「${name}」出场时，候选包含禁用用语「${term}」。`;
  }
  return `Line ${lineNo} may violate character voice: "${name}" appears and candidate contains forbidden voice term "${term}".`;
}

function styleForbiddenTermDetail(lineNo: number, term: string, locale: ValidatorLocale): string {
  if (locale === "zh-CN") {
    return `第 ${lineNo} 行疑似违反 style guide：候选包含禁用词「${term}」。`;
  }
  return `Line ${lineNo} may violate style guide: candidate contains forbidden term "${term}".`;
}

function validationSummary(
  ok: boolean,
  sourceCount: number,
  blockingCount: number,
  warningCount: number,
  locale: ValidatorLocale,
  scores: { styleScore?: number; voiceScore?: number } = {}
): string {
  const scoreText = [
    scores.styleScore === undefined ? "" : `style ${scores.styleScore}/100`,
    scores.voiceScore === undefined ? "" : `voice ${scores.voiceScore}/100`
  ].filter(Boolean).join("；");
  if (locale === "zh-CN") {
    const summary = ok
      ? `通过：${sourceCount} 行已校验${warningCount > 0 ? `，${warningCount} 条警告` : ""}。`
      : `阻断：${sourceCount} 行原文中有 ${blockingCount} 条阻断错误。`;
    return scoreText ? `${summary} ${scoreText}` : summary;
  }
  const summary = ok
    ? `OK: ${sourceCount} lines validated${warningCount > 0 ? ` with ${warningCount} warning(s)` : ""}.`
    : `BLOCKED: ${blockingCount} blocking error(s) on ${sourceCount} source lines.`;
  return scoreText ? `${summary} ${scoreText}` : summary;
}

function complianceScore(total: number, violated: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((total - violated) / total) * 100)));
}

export function validateTranslationCandidate(
  sourceText: string,
  candidateText: string,
  options: ValidationOptions = {}
): TranslationValidationResult {
  const locale = validatorLocale(options);
  const comparePlaceholders = options.extractPlaceholders ?? defaultExtractPlaceholders;
  const extractTags = options.extractTags ?? defaultExtractTags;
  const customPreserveRules = normalizeCustomPreserveRules(options.customPreserveRules);
  const compiledCustomPreserveRules = customPreserveRules.map((rule, index) => ({
    rule,
    label: rule.label || `Rule ${index + 1}`,
    regex: compileCustomPreserveRule(rule)
  }));
  const extractCustomPreserved = (line: string) => compiledCustomPreserveRules.flatMap(({ regex }) =>
    regexMatches(line, regex)
  );
  const extractPlaceholders = (line: string) => [
    ...comparePlaceholders(line),
    ...extractCustomPreserved(line)
  ];
  const detectUntranslated = options.detectUntranslated ?? true;
  const sourceLanguage = options.sourceLanguage ?? parseSourceLanguageFromPair(options.languagePair);
  const targetLanguage = parseTargetLanguageFromPair(options.languagePair);
  const glossaryEntries = (options.glossaryEntries ?? []).filter((entry) =>
    Boolean(entry.source?.trim() && entry.target?.trim())
  );
  const characterEntries = (options.characterEntries ?? []).filter((entry) =>
    Boolean(entry.name?.trim())
  );
  const styleForbiddenTerms = (options.styleForbiddenTerms ?? [])
    .map((term) => term.trim())
    .filter(Boolean);

  const sourceLines = splitTextLines(sourceText);
  const candidateLines = splitTextLines(candidateText);
  const repeatedShortCandidateLines = new Set<number>();
  const repeatedCandidateRunLines = new Set<number>();
  const repeatedCandidateGroups = new Map<string, { sources: Set<string>; lines: number[] }>();
  for (let index = 0; index < Math.min(sourceLines.length, candidateLines.length); index += 1) {
    const sourceCore = proseCore(stripPreservedPayload(sourceLines[index], extractPlaceholders, extractTags));
    const candidateCore = proseCore(stripPreservedPayload(candidateLines[index], extractPlaceholders, extractTags));
    if (sourceCore.length < 24 || candidateCore.length === 0 || candidateCore.length > 12) continue;
    if (candidateCore.length / sourceCore.length > 0.35) continue;
    const key = candidateCore.normalize("NFKC").toLocaleLowerCase();
    const group = repeatedCandidateGroups.get(key) ?? { sources: new Set<string>(), lines: [] };
    group.sources.add(sourceCore.normalize("NFKC").toLocaleLowerCase());
    group.lines.push(index + 1);
    repeatedCandidateGroups.set(key, group);
  }
  for (const group of repeatedCandidateGroups.values()) {
    if (group.sources.size < 3 || group.lines.length < 3) continue;
    for (const line of group.lines) repeatedShortCandidateLines.add(line);
  }
  for (let start = 0; start < Math.min(sourceLines.length, candidateLines.length);) {
    const candidateCore = proseCore(stripPreservedPayload(candidateLines[start], extractPlaceholders, extractTags));
    const key = candidateCore.normalize("NFKC").toLocaleLowerCase();
    let end = start + 1;
    while (key && end < Math.min(sourceLines.length, candidateLines.length)) {
      const next = proseCore(stripPreservedPayload(candidateLines[end], extractPlaceholders, extractTags))
        .normalize("NFKC")
        .toLocaleLowerCase();
      if (next !== key) break;
      end += 1;
    }
    if (sourceLines.length === candidateLines.length && key && end - start >= 3) {
      const sourceCores = sourceLines.slice(start, end).map((line) =>
        proseCore(stripPreservedPayload(line, extractPlaceholders, extractTags)).normalize("NFKC").toLocaleLowerCase()
      );
      const distinctSources = new Set(sourceCores.filter(Boolean));
      const clearlyCompressed = sourceCores.every((sourceCore) =>
        sourceCore.length >= 8 && candidateCore.length / sourceCore.length <= 0.8
      );
      if (distinctSources.size >= 3 && clearlyCompressed) {
        for (let index = start; index < end; index += 1) repeatedCandidateRunLines.add(index + 1);
      }
    }
    start = end;
  }
  const blocking: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const styleViolationLines = new Set<number>();
  const voiceCheckedLines = new Set<number>();
  const voiceViolationLines = new Set<number>();

  if (sourceLines.length !== candidateLines.length) {
    blocking.push({
      code: "line_count_mismatch",
      severity: "blocking",
      detail: lineCountMismatchDetail(sourceLines.length, candidateLines.length, locale)
    });
  }

  const lineCount = Math.min(sourceLines.length, candidateLines.length);

  for (let i = 0; i < lineCount; i += 1) {
    const lineNo = i + 1;
    const src = sourceLines[i];
    const cand = candidateLines[i];
    const sourceCharacters = characterEntries.filter((entry) => {
      const names = [entry.name, ...(entry.aliases ?? [])]
        .map((name) => name?.trim() ?? "")
        .filter(Boolean);
      return names.some((name) => textContainsTerm(src, name));
    });

    const srcPh = comparePlaceholders(src).slice().sort();
    const candPh = comparePlaceholders(cand).slice().sort();
    if (!shallowEqual(srcPh, candPh)) {
      blocking.push({
        code: "placeholder_mismatch",
        severity: "blocking",
        line: lineNo,
        detail: placeholderMismatchDetail(lineNo, srcPh, candPh, locale)
      });
    }

    for (const { label, regex } of compiledCustomPreserveRules) {
      const sourceMatches = regexMatches(src, regex).sort();
      const candidateMatches = regexMatches(cand, regex).sort();
      if (shallowEqual(sourceMatches, candidateMatches)) continue;
      blocking.push({
        code: "custom_preserve_mismatch",
        severity: "blocking",
        line: lineNo,
        detail: customPreserveMismatchDetail(lineNo, label, sourceMatches, candidateMatches, locale)
      });
    }

    const srcTags = extractTags(src).slice().sort();
    const candTags = extractTags(cand).slice().sort();
    if (!shallowEqual(srcTags, candTags)) {
      blocking.push({
        code: "tag_mismatch",
        severity: "blocking",
        line: lineNo,
        detail: tagMismatchDetail(lineNo, srcTags, candTags, locale)
      });
    }

    if (isProbablyEmpty(src) !== isProbablyEmpty(cand)) {
      warnings.push({
        code: "empty_line_displaced",
        severity: "warning",
        line: lineNo,
        detail: emptyLineDetail(lineNo, isProbablyEmpty(src), locale)
      });
    }

    const sourceCoreLength = proseCore(stripPreservedPayload(src, extractPlaceholders, extractTags)).length;
    const candidateCoreLength = proseCore(stripPreservedPayload(cand, extractPlaceholders, extractTags)).length;
    const lengthRatio = candidateCoreLength / Math.max(1, sourceCoreLength);
    if (
      sourceCoreLength >= 12
      && candidateCoreLength > 0
      && (
        lengthRatio <= 0.18
        || (sourceCoreLength >= 8 && candidateCoreLength >= 12 && lengthRatio >= 2.5)
      )
    ) {
      warnings.push({
        code: "length_anomaly",
        severity: "warning",
        line: lineNo,
        detail: lengthAnomalyDetail(lineNo, sourceCoreLength, candidateCoreLength, locale)
      });
    }

    if (
      !isProbablyEmpty(src)
      && isGenericTranslationPlaceholder(cand)
      && !sourceDescribesTranslationMeta(src)
    ) {
      blocking.push({
        code: "generic_translation_placeholder",
        severity: "blocking",
        line: lineNo,
        detail: genericTranslationPlaceholderDetail(lineNo, locale)
      });
    }

    if (
      !isProbablyEmpty(src)
      && !isGenericTranslationPlaceholder(cand)
      && repeatedShortCandidateLines.has(lineNo)
    ) {
      blocking.push({
        code: "repeated_short_candidate",
        severity: "blocking",
        line: lineNo,
        detail: repeatedShortCandidateDetail(lineNo, locale)
      });
    }

    if (
      !isProbablyEmpty(src)
      && !isGenericTranslationPlaceholder(cand)
      && !repeatedShortCandidateLines.has(lineNo)
      && repeatedCandidateRunLines.has(lineNo)
    ) {
      blocking.push({
        code: "repeated_candidate_run",
        severity: "blocking",
        line: lineNo,
        detail: repeatedCandidateRunDetail(lineNo, locale)
      });
    }

    if (
      detectUntranslated
      && !isProbablyEmpty(src)
      && hasTranslatableProse(src, extractPlaceholders, extractTags)
      && looksLikeSourceResidue(src, cand, {
        extractPlaceholders,
        extractTags,
        sourceLanguage,
        targetLanguage
      })
    ) {
      const sourcePayload = stripPreservedPayload(src, extractPlaceholders, extractTags);
      const candidatePayload = stripPreservedPayload(cand, extractPlaceholders, extractTags);
      const copiedSource = proseCore(sourcePayload).normalize("NFKC").toLocaleLowerCase()
        === proseCore(candidatePayload).normalize("NFKC").toLocaleLowerCase();
      const finding: ValidationFinding = {
        code: "likely_untranslated",
        severity: copiedSource ? "blocking" : "warning",
        line: lineNo,
        detail: untranslatedDetail(lineNo, locale)
      };
      (copiedSource ? blocking : warnings).push(finding);
    }

    const glossaryCatalog = glossaryCatalogTerms(glossaryEntries);
    for (const entry of longestUncoveredGlossaryEntries(src, glossaryEntries)) {
      const sourceTerm = entry.source?.trim() ?? "";
      const targetTerm = entry.target?.trim() ?? "";
      const targetCandidates = glossaryAcceptableTargets(entry, glossaryCatalog);
      if (
        sourceTerm
        && targetTerm
        && textContainsTerm(src, sourceTerm)
        && !targetCandidates.some((term) => textContainsTerm(cand, term))
      ) {
        warnings.push({
          code: "glossary_missing",
          severity: "warning",
          line: lineNo,
          detail: glossaryMissingDetail(lineNo, sourceTerm, targetTerm, locale)
        });
      }
    }

    for (const entry of characterEntries) {
      const sourceName = entry.name?.trim() ?? "";
      const targetName = entry.target?.trim() || sourceName;
      const targetCandidates = [targetName, sourceName, ...(entry.aliases ?? [])].filter((term) => term.trim());
      const characterAppears = sourceName
        && [sourceName, ...(entry.aliases ?? [])].some((term) => textContainsTerm(src, term));
      if (
        characterAppears
        && !targetCandidates.some((term) => textContainsTerm(cand, term))
      ) {
        warnings.push({
          code: "character_name_missing",
          severity: "warning",
          line: lineNo,
          detail: characterNameMissingDetail(lineNo, sourceName, targetName, locale)
        });
      }
      if (characterAppears) {
        const gender = normalizedCharacterGender(entry);
        if (gender && sourceCharacters.length === 1 && sourceCharacters[0] === entry) {
          const wrongPronoun = mismatchedCharacterPronoun(cand, gender, targetLanguage);
          if (wrongPronoun) {
            warnings.push({
              code: "character_pronoun_mismatch",
              severity: "warning",
              line: lineNo,
              detail: characterPronounMismatchDetail(lineNo, sourceName, gender, wrongPronoun, locale)
            });
          }
        }
        const voiceRequiredMappings = (entry.requiredTerms ?? []).flatMap((term) => {
          const mapping = parseCharacterVoiceRequiredTerm(term);
          if (!mapping) return [];
          if (isExactCharacterNameVariant(entry, mapping.source) || isExactCharacterNameVariant(entry, mapping.target)) {
            return [];
          }
          return [mapping];
        });
        const spokenDialogue = characterSpeaksOnLine(src, entry) ? quotedDialogueSpans(src).join("\n") : "";
        const triggeredVoiceMappings = voiceRequiredMappings.filter((mapping) => (
          spokenDialogue.length > 0 && textContainsTerm(spokenDialogue, mapping.source)
        ));
        const hasVoiceRules = triggeredVoiceMappings.length > 0
          || (entry.forbiddenTerms?.some((term) => term.trim()) ?? false);
        if (hasVoiceRules) {
          voiceCheckedLines.add(lineNo);
        }
        for (const mapping of triggeredVoiceMappings) {
          if (!textContainsTerm(cand, mapping.target)) {
            warnings.push({
              code: "character_voice_required_missing",
              severity: "warning",
              line: lineNo,
              detail: characterVoiceRequiredMissingDetail(lineNo, sourceName, mapping.source, mapping.target, locale)
            });
            voiceViolationLines.add(lineNo);
          }
        }
        for (const term of entry.forbiddenTerms ?? []) {
          if (term.trim() && textContainsTerm(cand, term)) {
            warnings.push({
              code: "character_voice_forbidden_term",
              severity: "warning",
              line: lineNo,
              detail: characterVoiceForbiddenTermDetail(lineNo, sourceName, term, locale)
            });
            voiceViolationLines.add(lineNo);
          }
        }
      }
    }

    for (const term of styleForbiddenTerms) {
      if (textContainsTerm(cand, term)) {
        warnings.push({
          code: "style_forbidden_term",
          severity: "warning",
          line: lineNo,
          detail: styleForbiddenTermDetail(lineNo, term, locale)
        });
        styleViolationLines.add(lineNo);
      }
    }
  }

  const ok = blocking.length === 0;
  const styleScore = styleForbiddenTerms.length > 0 ? complianceScore(lineCount, styleViolationLines.size) : undefined;
  const voiceScore = voiceCheckedLines.size > 0 ? complianceScore(voiceCheckedLines.size, voiceViolationLines.size) : undefined;
  const summary = validationSummary(ok, sourceLines.length, blocking.length, warnings.length, locale, {
    styleScore,
    voiceScore
  });

  return {
    ok,
    sourceLineCount: sourceLines.length,
    candidateLineCount: candidateLines.length,
    blocking,
    warnings,
    styleScore,
    voiceScore,
    summary
  };
}

function shallowEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
