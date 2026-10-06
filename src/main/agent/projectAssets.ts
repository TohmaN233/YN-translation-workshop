import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { parseGlossaryText } from "../../shared/core/glossary.ts";
import { normalizeHandwrittenCharacterRequiredTerms, parseCharacterVoiceRequiredTerm } from "../../shared/validation/translationValidator.ts";
import { writeTextFileAtomically, writeTextFilesAtomically, type TextFileTransactionUpdate } from "../atomicFile.ts";
import { patchProjectStateIfUnchanged, readProjectState, transactProjectState } from "../projectState.ts";
import { readTranslationMemoryStats, type TranslationMemoryStats, translationMemoryPath } from "./translationMemory.ts";
import { RequiredWorkflowFileError, readRequiredWorkflowText } from "./requiredWorkflowFile.ts";

export type AssetProposalKind = "glossary" | "character_bible";

export interface AssetProposal {
  id: string;
  kind: AssetProposalKind;
  status: "pending" | "approved" | "rejected";
  entry: Record<string, unknown>;
  reason?: string;
  createdAt: string;
  updatedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
}

export interface ProjectAssets {
  paths: {
    glossary: string;
    characterBible: string;
    styleGuide: string;
    translationMemory: string;
  };
  available: {
    glossary: boolean;
    characterBible: boolean;
    styleGuide: boolean;
    translationMemory: boolean;
  };
  glossary: { entries: Record<string, unknown>[] };
  characterBible: { characters: Record<string, unknown>[]; source: string; revisions: Record<string, string> };
  styleGuide: string;
  translationMemory: TranslationMemoryStats;
}

export interface GlossaryValidationEntry {
  source: string;
  target: string;
  aliases?: string[];
  info?: string;
  status?: "confirmed" | "auto" | "pending";
}

export interface CharacterValidationEntry {
  name: string;
  target?: string;
  aliases?: string[];
  gender?: string;
  pronouns?: string;
  genderConfidence?: string;
  requiredTerms?: string[];
  forbiddenTerms?: string[];
}

export interface ProjectTranslationValidationAssets {
  glossaryEntries: GlossaryValidationEntry[];
  characterEntries: CharacterValidationEntry[];
  styleForbiddenTerms: string[];
}

const STYLE_FORBIDDEN_LINE_RE = /^\s*(?:forbid|forbidden|ban|禁止|禁用)\s*[:：-]\s*(.+)$/i;
const projectAssetWriteQueues = new Map<string, Promise<void>>();

function projectDir(outputDir: string): string {
  return path.basename(outputDir).toLowerCase() === ".translation-workshop"
    ? path.dirname(outputDir)
    : outputDir;
}

function workspaceDir(outputDir: string): string {
  return path.join(projectDir(outputDir), ".translation-workshop");
}

function assetPaths(outputDir: string) {
  const project = projectDir(outputDir);
  const workspace = workspaceDir(outputDir);
  return {
    glossary: path.join(workspace, "glossary.json"),
    characterBible: path.join(project, "AI_translation", "_workspace", "character_bible.md"),
    legacyMarkdownCharacterBible: path.join(workspace, "character_bible.md"),
    legacyCharacterBible: path.join(workspace, "character_bible.json"),
    migratedLegacyCharacterBible: path.join(workspace, "legacy", "character_bible.json.migrated"),
    styleGuide: path.join(workspace, "style_guide.md"),
    translationMemory: translationMemoryPath(outputDir),
    proposalsDir: path.join(workspace, "asset-proposals")
  };
}

async function enqueueProjectAssetWrite<T>(outputDir: string, work: () => Promise<T>): Promise<T> {
  const key = workspaceDir(outputDir).toLocaleLowerCase();
  const previous = projectAssetWriteQueues.get(key) ?? Promise.resolve();
  let result!: T;
  const current = previous.catch(() => undefined).then(async () => {
    result = await work();
  });
  projectAssetWriteQueues.set(key, current);
  try {
    await current;
    return result;
  } finally {
    if (projectAssetWriteQueues.get(key) === current) projectAssetWriteQueues.delete(key);
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON project asset at ${filePath}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON project asset at ${filePath}: expected an object root.`);
  }
  return parsed as Record<string, unknown>;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureLegacyCharacterBibleMigratedUnlocked(outputDir: string): Promise<void> {
  const paths = assetPaths(outputDir);
  if (await readOptionalText(paths.characterBible) !== undefined) return;
  const legacyMarkdown = await readOptionalText(paths.legacyMarkdownCharacterBible);
  if (legacyMarkdown !== undefined) {
    const characterEntries = parseCharacterBibleMarkdown(legacyMarkdown, paths.legacyMarkdownCharacterBible);
    assertFormalAssetEntries("character_bible", characterEntries, paths.legacyMarkdownCharacterBible);
    await mkdir(path.dirname(paths.characterBible), { recursive: true });
    await rename(paths.legacyMarkdownCharacterBible, paths.characterBible);
    return;
  }
  if (await readOptionalText(paths.migratedLegacyCharacterBible) !== undefined) return;
  const legacyCharacterBible = await readJsonObject(paths.legacyCharacterBible);
  if (legacyCharacterBible === undefined) return;
  const characterEntries = entriesFrom(
    legacyCharacterBible,
    "characters",
    paths.legacyCharacterBible
  );
  assertFormalAssetEntries("character_bible", characterEntries, paths.legacyCharacterBible);
  await mkdir(path.dirname(paths.characterBible), { recursive: true });
  await writeTextFileAtomically(
    paths.characterBible,
    serializeCharacterBibleMarkdown(characterEntries)
  );
  await mkdir(path.dirname(paths.migratedLegacyCharacterBible), { recursive: true });
  await rename(paths.legacyCharacterBible, paths.migratedLegacyCharacterBible);
}

function entriesFrom(
  value: Record<string, unknown> | undefined,
  key: "entries" | "characters",
  filePath: string
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new Error(`Invalid JSON project asset at ${filePath}: ${key} must be present.`);
  }
  const collection = value[key];
  if (!Array.isArray(collection)) {
    throw new Error(`Invalid JSON project asset at ${filePath}: ${key} must be an array.`);
  }
  return collection.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid JSON project asset at ${filePath}: ${key}[${index}] must be an object.`);
    }
    return entry as Record<string, unknown>;
  });
}

function proposalId(kind: AssetProposalKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function proposalPath(outputDir: string, proposalIdValue: string): string {
  return path.join(assetPaths(outputDir).proposalsDir, `${proposalIdValue}.json`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function markdownValue(value: unknown, fallback = "unknown"): string {
  const text = String(value ?? "").trim().replace(/\r?\n/g, " ");
  return text || fallback;
}

function markdownList(value: unknown): string {
  return stringArray(value).join(", ");
}

export function serializeCharacterBibleMarkdown(characters: Record<string, unknown>[]): string {
  const sections = characters.map((entry) => {
    const name = markdownValue(entry.name, "Unnamed character");
    const confidence = markdownValue(entry.genderConfidence, "unknown");
    const requiredTerms = stringArray(entry.requiredTerms ?? entry.mustIncludeTerms ?? entry.voiceRequiredTerms);
    const lines = [
      `## ${name}`,
      `- Localized name: ${markdownValue(entry.target ?? entry.localizedName ?? entry.translation)}`,
      `- Aliases: ${markdownList(entry.aliases) || "none"}`,
      `- Gender/pronouns: ${markdownValue(entry.gender)}; ${markdownValue(entry.pronouns)}; ${confidence}`,
      `- Terms of address: ${markdownValue(entry.termsOfAddress)}`
    ];
    if (requiredTerms.length > 0) {
      lines.push("- Required dialogue mappings:");
      lines.push(...requiredTerms.map((term) => `  - ${markdownValue(term)}`));
    }
    const optionalFields: Array<[string, unknown]> = [
      ["Forbidden terms", entry.forbiddenTerms ?? entry.avoidTerms ?? entry.voiceForbiddenTerms],
      ["Voice", entry.voice],
      ["Identity", entry.identity],
      ["Role", entry.role],
      ["Relationships", entry.relationships],
      ["Catchphrases", entry.catchphrases],
      ["Evidence", entry.evidence]
    ];
    for (const [label, value] of optionalFields) {
      const text = Array.isArray(value) ? markdownList(value) : String(value ?? "").trim();
      if (text) lines.push(`- ${label}: ${text}`);
    }
    return lines.join("\n");
  });
  return `# Character Bible\n\n${sections.join("\n\n")}\n`;
}

function splitMarkdownList(value: string): string[] {
  if (!value || /^(?:none|unknown|n\/a)$/i.test(value.trim())) return [];
  return uniqueStrings(value.split(/[,，;；、]/));
}

export function parseCharacterBibleMarkdown(source: string, filePath: string): Record<string, unknown>[] {
  if (!source.trim()) return [];
  if (!/^#\s+Character Bible\s*$/im.test(source)) {
    throw new Error(`Invalid character bible at ${filePath}: expected a # Character Bible heading.`);
  }
  const sections = source.split(/^##\s+/m).slice(1);
  return sections.map((section, index) => {
    const [heading = "", ...bodyLines] = section.split(/\r?\n/);
    const name = heading.trim();
    if (!name) throw new Error(`Invalid character bible at ${filePath}: section ${index + 1} has no name.`);
    const entry: Record<string, unknown> = { name };
    const requiredTerms: string[] = [];
    let readingRequiredMappings = false;
    for (const line of bodyLines) {
      if (/^\s*[-*]\s*(?:\*\*)?Required dialogue mappings(?:\*\*)?\s*:\s*$/i.test(line)) {
        readingRequiredMappings = true;
        continue;
      }
      if (readingRequiredMappings) {
        const nestedMapping = line.match(/^\s{2,}[-*]\s+(.+?)\s*$/);
        if (nestedMapping) {
          requiredTerms.push(nestedMapping[1].trim());
          continue;
        }
        readingRequiredMappings = false;
      }
      const match = line.match(/^\s*[-*]\s*(?:\*\*)?([^:*]+)(?:\*\*)?\s*:\s*(?:\*\*)?(.+?)\s*$/);
      if (!match) continue;
      const label = match[1].trim().toLocaleLowerCase();
      const value = match[2].trim();
      if (label === "localized name" || label === "target") {
        if (!/^(?:unknown|none)$/i.test(value)) entry.target = value;
      } else if (label === "aliases") {
        const aliases = splitMarkdownList(value);
        if (aliases.length > 0) entry.aliases = aliases;
      } else if (label === "gender/pronouns") {
        const parts = value.split(/[;；]/).map((part) => part.trim()).filter(Boolean);
        const confidence = parts.find((part) => /^(?:confirmed|inferred|unknown)$/i.test(part));
        const descriptive = parts.filter((part) => part !== confidence);
        if (descriptive[0] && !/^unknown$/i.test(descriptive[0])) entry.gender = descriptive[0];
        if (descriptive[1] && !/^unknown$/i.test(descriptive[1])) entry.pronouns = descriptive[1];
        if (confidence) entry.genderConfidence = confidence.toLocaleLowerCase();
      } else if (label === "terms of address") {
        if (!/^(?:unknown|none)$/i.test(value)) entry.termsOfAddress = value;
      } else if (label === "required terms" || label === "required dialogue mappings") {
        const terms = splitMarkdownList(value);
        requiredTerms.push(...terms);
      } else if (label === "forbidden terms") {
        const terms = splitMarkdownList(value);
        if (terms.length > 0) entry.forbiddenTerms = terms;
      } else if (["voice", "identity", "role", "relationships", "catchphrases", "evidence"].includes(label)) {
        entry[label] = value;
      }
    }
    if (requiredTerms.length > 0) entry.requiredTerms = uniqueStrings(requiredTerms);
    return entry;
  });
}

function requiredAssetString(
  entry: Record<string, unknown>,
  key: string,
  filePath: string,
  collection: "entries" | "characters",
  index: number
): string {
  const value = entry[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Invalid JSON project asset at ${filePath}: ${collection}[${index}].${key} must be a non-empty string.`
    );
  }
  return value.trim();
}

function optionalAssetString(
  entry: Record<string, unknown>,
  key: string,
  filePath: string,
  collection: "entries" | "characters",
  index: number
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `Invalid JSON project asset at ${filePath}: ${collection}[${index}].${key} must be a string.`
    );
  }
  return value.trim() || undefined;
}

function optionalAssetStringArray(
  entry: Record<string, unknown>,
  key: string,
  filePath: string,
  collection: "entries" | "characters",
  index: number
): string[] {
  const value = entry[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(
      `Invalid JSON project asset at ${filePath}: ${collection}[${index}].${key} must be an array of non-empty strings.`
    );
  }
  return uniqueStrings(value);
}

function assertFormalAssetEntry(
  kind: AssetProposalKind,
  value: unknown,
  filePath: string,
  index = 0
): asserts value is Record<string, unknown> {
  const collection = kind === "glossary" ? "entries" : "characters";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid JSON project asset at ${filePath}: ${collection}[${index}] must be an object.`);
  }
  const entry = value as Record<string, unknown>;
  if (kind === "glossary") {
    requiredAssetString(entry, "source", filePath, collection, index);
    requiredAssetString(entry, "target", filePath, collection, index);
    optionalAssetStringArray(entry, "aliases", filePath, collection, index);
    optionalAssetStringArray(entry, "alternatives", filePath, collection, index);
    optionalAssetString(entry, "info", filePath, collection, index);
    optionalAssetString(entry, "status", filePath, collection, index);
    return;
  }

  requiredAssetString(entry, "name", filePath, collection, index);
  for (const key of ["target", "localizedName", "translation", "voice", "gender", "pronouns", "genderConfidence", "identity", "role", "relationships", "termsOfAddress", "catchphrases", "evidence"]) {
    optionalAssetString(entry, key, filePath, collection, index);
  }
  for (const key of [
    "aliases",
    "alternatives",
    "requiredTerms",
    "mustIncludeTerms",
    "voiceRequiredTerms",
    "forbiddenTerms",
    "avoidTerms",
    "voiceForbiddenTerms"
  ]) {
    optionalAssetStringArray(entry, key, filePath, collection, index);
  }
}

function assertFormalAssetEntries(
  kind: AssetProposalKind,
  entries: Record<string, unknown>[],
  filePath: string
): void {
  entries.forEach((entry, index) => assertFormalAssetEntry(kind, entry, filePath, index));
}

function entryKey(kind: AssetProposalKind, entry: Record<string, unknown>): string {
  const field = kind === "glossary" ? entry.source : entry.name ?? entry.source;
  return String(field ?? "").trim();
}

function firstText(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = String(entry[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function targetKeys(kind: AssetProposalKind): string[] {
  return kind === "glossary" ? ["target"] : ["target", "localizedName", "translation"];
}

function mergeAssetEntry(
  kind: AssetProposalKind,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...incoming, ...existing };
  const aliases = uniqueStrings([...stringArray(existing.aliases), ...stringArray(incoming.aliases)]);
  if (aliases.length > 0) {
    next.aliases = aliases;
  }

  if (kind === "character_bible") {
    for (const field of ["requiredTerms", "forbiddenTerms"] as const) {
      const values = uniqueStrings([...stringArray(existing[field]), ...stringArray(incoming[field])]);
      if (values.length > 0) next[field] = values;
    }
  }

  const keys = targetKeys(kind);
  const existingTarget = firstText(existing, keys);
  const incomingTarget = firstText(incoming, keys);
  if (!existingTarget && incomingTarget) {
    next[keys[0]] = incomingTarget;
  } else if (existingTarget && incomingTarget && existingTarget !== incomingTarget) {
    const alternatives = uniqueStrings([
      ...stringArray(existing.alternatives),
      ...stringArray(incoming.alternatives),
      incomingTarget
    ]).filter((value) => value !== existingTarget);
    if (alternatives.length > 0) {
      next.alternatives = alternatives;
    }
  }
  return next;
}

function mergeReason(existing: string | undefined, incoming: string | undefined): string | undefined {
  const parts = uniqueStrings([existing ?? "", incoming ?? ""]);
  return parts.length > 0 ? parts.join("\n---\n") : undefined;
}

function isAssetProposal(value: unknown): value is AssetProposal {
  const item = value as Partial<AssetProposal> | undefined;
  return Boolean(
    item
    && typeof item.id === "string"
    && typeof item.createdAt === "string"
    && item.entry
    && typeof item.entry === "object"
    && !Array.isArray(item.entry)
    && (item.kind === "glossary" || item.kind === "character_bible")
    && (item.status === "pending" || item.status === "approved" || item.status === "rejected")
  );
}

function assetProposalFrom(value: unknown, filePath: string): AssetProposal {
  if (!isAssetProposal(value)) {
    throw new Error(`Invalid asset proposal at ${filePath}: expected a complete proposal record.`);
  }
  return value;
}

async function readProjectAssetsUnlocked(args: { outputDir: string; includeLegacyCharacters?: boolean }): Promise<ProjectAssets> {
  const paths = assetPaths(args.outputDir);
  const glossary = await readJsonObject(paths.glossary);
  const glossaryEntries = entriesFrom(glossary, "entries", paths.glossary);
  let characterBibleSource = await readOptionalText(paths.characterBible);
  if (characterBibleSource === undefined && args.includeLegacyCharacters) {
    characterBibleSource = await readOptionalText(paths.legacyMarkdownCharacterBible);
    if (characterBibleSource === undefined && await readOptionalText(paths.migratedLegacyCharacterBible) === undefined) {
      const legacy = await readJsonObject(paths.legacyCharacterBible);
      if (legacy) {
        const entries = entriesFrom(legacy, "characters", paths.legacyCharacterBible);
        assertFormalAssetEntries("character_bible", entries, paths.legacyCharacterBible);
        characterBibleSource = serializeCharacterBibleMarkdown(entries);
      }
    }
  }
  const characterBibleAvailable = characterBibleSource !== undefined;
  let characterEntries: Record<string, unknown>[];
  if (characterBibleSource === undefined) {
    characterEntries = [];
    characterBibleSource = "";
  } else {
    characterEntries = parseCharacterBibleMarkdown(characterBibleSource, paths.characterBible);
  }
  assertFormalAssetEntries("glossary", glossaryEntries, paths.glossary);
  assertFormalAssetEntries("character_bible", characterEntries, paths.characterBible);
  const styleGuideSource = await readOptionalText(paths.styleGuide);
  const translationMemory = await readTranslationMemoryStats(args.outputDir);
  const characterSections = characterBibleSource.split(/^##\s+/m).slice(1);
  return {
    paths: {
      glossary: paths.glossary,
      characterBible: paths.characterBible,
      styleGuide: paths.styleGuide,
      translationMemory: paths.translationMemory
    },
    available: {
      glossary: glossary !== undefined,
      characterBible: characterBibleAvailable,
      styleGuide: styleGuideSource !== undefined,
      translationMemory: translationMemory.initialized
    },
    glossary: { entries: glossaryEntries },
    characterBible: { characters: characterEntries, source: characterBibleSource, revisions: Object.fromEntries(characterEntries.map((entry, index) => [String(entry.name), characterRecordRevision(characterSections[index] ?? "")])) },
    styleGuide: styleGuideSource ?? "",
    translationMemory
  };
}

export async function readProjectAssets(args: { outputDir: string }): Promise<ProjectAssets> {
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    return readProjectAssetsUnlocked(args);
  });
}

function sameAssetPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

interface GlossaryMergeCounts {
  imported: number;
  added: number;
  deduplicated: number;
  aliasesAdded: number;
}

function glossaryValue(value: unknown): string {
  return String(value ?? "").trim().normalize("NFC");
}

function glossaryKey(value: unknown): string {
  return glossaryValue(value).toLocaleLowerCase();
}

function glossaryAliases(entry: Record<string, unknown>): string[] {
  return Array.isArray(entry.aliases)
    ? entry.aliases.filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim()))
      .map((alias) => alias.trim())
    : [];
}

function mergeMatchingGlossaryEntry(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): { entry: Record<string, unknown>; aliasesAdded: number } {
  const aliases = glossaryAliases(existing);
  const aliasKeys = new Set(aliases.map(glossaryKey));
  let aliasesAdded = 0;
  for (const alias of glossaryAliases(incoming)) {
    if (aliasKeys.has(glossaryKey(alias))) continue;
    aliases.push(alias);
    aliasKeys.add(glossaryKey(alias));
    aliasesAdded += 1;
  }
  const entry = { ...existing };
  if (aliases.length > 0) entry.aliases = aliases;
  for (const field of ["info", "status"] as const) {
    if (!glossaryValue(entry[field]) && glossaryValue(incoming[field])) entry[field] = incoming[field];
  }
  return { entry, aliasesAdded };
}

function mergeGlossaryLayers(
  baseEntries: Record<string, unknown>[],
  incomingEntries: Record<string, unknown>[],
  options: { conflict: "reject" | "replace"; conflictPath: string }
): { entries: Record<string, unknown>[]; counts: GlossaryMergeCounts } {
  const entries: Record<string, unknown>[] = [];
  const indexBySource = new Map<string, number>();
  const addBase = (incoming: Record<string, unknown>): void => {
    const source = glossaryKey(incoming.source);
    const index = indexBySource.get(source);
    if (index === undefined) {
      indexBySource.set(source, entries.length);
      entries.push({ ...incoming, ...(glossaryAliases(incoming).length > 0 ? { aliases: glossaryAliases(incoming) } : {}) });
      return;
    }
    const existing = entries[index];
    if (glossaryKey(existing.target) !== glossaryKey(incoming.target)) {
      throw new Error(
        `Glossary conflict at ${options.conflictPath}: source ${JSON.stringify(String(incoming.source))} has different targets.`
      );
    }
    entries[index] = mergeMatchingGlossaryEntry(existing, incoming).entry;
  };
  for (const entry of baseEntries) addBase(entry);

  let added = 0;
  let deduplicated = 0;
  let aliasesAdded = 0;
  for (const incoming of incomingEntries) {
    const source = glossaryKey(incoming.source);
    const index = indexBySource.get(source);
    if (index === undefined) {
      indexBySource.set(source, entries.length);
      const aliases = glossaryAliases(incoming);
      entries.push({ ...incoming, ...(aliases.length > 0 ? { aliases } : {}) });
      added += 1;
      aliasesAdded += aliases.length;
      continue;
    }
    const existing = entries[index];
    if (glossaryKey(existing.target) !== glossaryKey(incoming.target)) {
      if (options.conflict === "reject") {
        throw new Error(
          `Glossary conflict at ${options.conflictPath}: source ${JSON.stringify(String(incoming.source))} has different targets.`
        );
      }
      const aliases = glossaryAliases(incoming);
      entries[index] = {
        ...existing,
        ...incoming,
        ...(aliases.length > 0 ? { aliases } : { aliases: undefined })
      };
      deduplicated += 1;
      aliasesAdded += aliases.length;
      continue;
    }
    const merged = mergeMatchingGlossaryEntry(existing, incoming);
    entries[index] = merged.entry;
    deduplicated += 1;
    aliasesAdded += merged.aliasesAdded;
  }
  return {
    entries: entries.map((entry) => {
      if (entry.aliases !== undefined) return entry;
      const { aliases: _aliases, ...rest } = entry;
      return rest;
    }),
    counts: { imported: incomingEntries.length, added, deduplicated, aliasesAdded }
  };
}

async function selectedGlossaryLayer(outputDir: string, canonicalPath: string): Promise<{
  inspectedBinding: unknown;
  path?: string;
  entries: Record<string, unknown>[];
}> {
  const state = await readProjectState(outputDir);
  const inspectedBinding = state.glossaryPath;
  const selectedValue = typeof inspectedBinding === "string" ? inspectedBinding.trim() : "";
  if (!selectedValue) return { inspectedBinding, entries: [] };
  if (!path.isAbsolute(selectedValue)) {
    throw new Error(`Selected glossary path must be absolute: ${selectedValue}`);
  }
  const selectedPath = path.resolve(selectedValue);
  if (sameAssetPath(selectedPath, canonicalPath)) {
    return { inspectedBinding, path: selectedPath, entries: [] };
  }
  let source: string;
  try {
    source = await readFile(selectedPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read selected glossary: ${selectedPath}`, { cause: error });
  }
  const entries = parseGlossaryText(source).map((entry) => ({ ...entry }));
  if (source.trim() && entries.length === 0) {
    throw new Error(`Selected glossary contains no parseable source/target entries: ${selectedPath}`);
  }
  assertFormalAssetEntries("glossary", entries, selectedPath);
  return { inspectedBinding, path: selectedPath, entries };
}

async function loadGlossaryEntriesFromAbsolutePath(selectedPath: string): Promise<Record<string, unknown>[]> {
  let source: string;
  try {
    source = await readFile(selectedPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read selected glossary: ${selectedPath}`, { cause: error });
  }
  const entries = parseGlossaryText(source).map((entry) => ({ ...entry }));
  if (source.trim() && entries.length === 0) {
    throw new Error(`Selected glossary contains no parseable source/target entries: ${selectedPath}`);
  }
  assertFormalAssetEntries("glossary", entries, selectedPath);
  return entries;
}

async function resolveMutableGlossaryBase(args: {
  outputDir: string;
  canonicalPath: string;
  currentEntries: Record<string, unknown>[];
  boundGlossaryPath?: string;
}): Promise<{
  entries: Record<string, unknown>[];
  inspectedBinding: unknown;
}> {
  const selected = await selectedGlossaryLayer(args.outputDir, args.canonicalPath);
  const explicit = args.boundGlossaryPath?.trim();
  let boundPath = selected.path;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error(`Selected glossary path must be absolute: ${explicit}`);
    }
    const resolved = path.resolve(explicit);
    if (
      selected.path
      && !sameAssetPath(selected.path, resolved)
      && !sameAssetPath(selected.path, args.canonicalPath)
      && !sameAssetPath(resolved, args.canonicalPath)
    ) {
      throw new Error(
        `Current glossary binding ${resolved} does not match the project binding ${selected.path}.`
      );
    }
    boundPath = resolved;
  }
  if (boundPath && !sameAssetPath(boundPath, args.canonicalPath)) {
    const entries = selected.path && sameAssetPath(selected.path, boundPath)
      ? selected.entries.map((entry) => ({ ...entry }))
      : await loadGlossaryEntriesFromAbsolutePath(boundPath);
    return { entries, inspectedBinding: selected.inspectedBinding };
  }
  return {
    entries: args.currentEntries.map((entry) => ({ ...entry })),
    inspectedBinding: selected.inspectedBinding
  };
}

function upsertGlossaryEntry(
  entries: Record<string, unknown>[],
  entry: Record<string, unknown>
): Record<string, unknown>[] {
  const source = String(entry.source).trim().toLocaleLowerCase();
  const next = entries.map((item) => ({ ...item }));
  const index = next.findIndex(
    (item) => String(item.source ?? "").trim().toLocaleLowerCase() === source
  );
  if (index >= 0) next[index] = { ...next[index], ...entry };
  else next.push({ ...entry });
  return next;
}

function assetsWithGlossary(
  assets: ProjectAssets,
  glossaryPath: string,
  entries: Record<string, unknown>[]
): ProjectAssets {
  return {
    ...assets,
    paths: { ...assets.paths, glossary: glossaryPath },
    available: { ...assets.available, glossary: true },
    glossary: { entries: entries.map((entry) => ({ ...entry })) }
  };
}

async function writeCanonicalGlossaryAndBindUnlocked(args: {
  outputDir: string;
  paths: ReturnType<typeof assetPaths>;
  currentAssets: ProjectAssets;
  entries: Record<string, unknown>[];
  inspectedBinding: unknown;
}): Promise<ProjectAssets> {
  assertFormalAssetEntries("glossary", args.entries, args.paths.glossary);
  const previousContent = await readOptionalText(args.paths.glossary);
  const content = JSON.stringify({ entries: args.entries }, null, 2);
  await mkdir(workspaceDir(args.outputDir), { recursive: true });
  await writeTextFileAtomically(args.paths.glossary, content);
  try {
    await patchProjectStateIfUnchanged(
      args.outputDir,
      { glossaryPath: args.inspectedBinding },
      { glossaryPath: args.paths.glossary }
    );
  } catch (error) {
    try {
      if (previousContent === undefined) await rm(args.paths.glossary, { force: true });
      else await writeTextFileAtomically(args.paths.glossary, previousContent);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Canonical glossary consolidation failed and could not be rolled back."
      );
    }
    throw error;
  }
  return assetsWithGlossary(args.currentAssets, args.paths.glossary, args.entries);
}

/** Read the canonical glossary plus any selected external authority without mutating either file. */
export function createWorkflowProjectAssetReader() {
  const loadedPaths = new Map<"glossary" | "characterBible" | "styleGuide", string>();
  return async (args: Parameters<typeof readWorkflowProjectAssets>[0]): Promise<ProjectAssets> => {
    const assets = await readWorkflowProjectAssets(args);
    for (const kind of ["glossary", "characterBible", "styleGuide"] as const) {
      const currentPath = assets.paths[kind];
      if (loadedPaths.get(kind) === currentPath && !assets.available[kind]) {
        throw new RequiredWorkflowFileError(currentPath);
      }
      if (assets.available[kind]) loadedPaths.set(kind, currentPath);
      else loadedPaths.delete(kind);
    }
    return assets;
  };
}

export async function readWorkflowProjectAssets(args: {
  outputDir: string;
  glossaryPath?: string;
}): Promise<ProjectAssets> {
  const assets = await readProjectAssets({ outputDir: args.outputDir });
  const state = await readProjectState(args.outputDir);
  const selectedPath = args.glossaryPath?.trim() || (typeof state.glossaryPath === "string" ? state.glossaryPath.trim() : "");
  if (!selectedPath) return assets;
  if (!path.isAbsolute(selectedPath)) {
    throw new Error(`Selected glossary path must be absolute: ${selectedPath}`);
  }
  const glossaryPath = path.resolve(selectedPath);
  if (sameAssetPath(glossaryPath, assets.paths.glossary)) {
    if (!assets.available.glossary) throw new RequiredWorkflowFileError(glossaryPath);
    return assets;
  }
  let source: string;
  try {
    source = await readRequiredWorkflowText(glossaryPath);
  } catch (error) {
    if (error instanceof RequiredWorkflowFileError) {
      throw new RequiredWorkflowFileError(glossaryPath, error.cause, "Failed to read selected glossary");
    }
    throw new Error(`Failed to read selected glossary: ${glossaryPath}`, { cause: error });
  }
  const selectedEntries = parseGlossaryText(source).map((entry) => ({ ...entry }));
  if (source.trim() && selectedEntries.length === 0) {
    throw new Error(`Selected glossary contains no parseable source/target entries: ${glossaryPath}`);
  }
  assertFormalAssetEntries("glossary", selectedEntries, glossaryPath);
  const { entries } = mergeGlossaryLayers(assets.glossary.entries, selectedEntries, {
    conflict: "replace",
    conflictPath: glossaryPath
  });
  return {
    ...assets,
    paths: { ...assets.paths, glossary: glossaryPath },
    available: { ...assets.available, glossary: true },
    glossary: { entries }
  };
}

function projectGlossaryEntries(assets: ProjectAssets): GlossaryValidationEntry[] {
  return assets.glossary.entries.map((entry, index) => {
    const source = requiredAssetString(entry, "source", assets.paths.glossary, "entries", index);
    const target = requiredAssetString(entry, "target", assets.paths.glossary, "entries", index);
    const aliases = optionalAssetStringArray(entry, "aliases", assets.paths.glossary, "entries", index);
    const info = optionalAssetString(entry, "info", assets.paths.glossary, "entries", index);
    const rawStatus = optionalAssetString(entry, "status", assets.paths.glossary, "entries", index);
    const status = rawStatus === "confirmed" || rawStatus === "auto" || rawStatus === "pending" ? rawStatus : undefined;
    return {
      source,
      target,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(info ? { info } : {}),
      ...(status ? { status } : {})
    };
  });
}

function projectCharacterEntries(assets: ProjectAssets): CharacterValidationEntry[] {
  return assets.characterBible.characters.map((entry, index) => {
    const filePath = assets.paths.characterBible;
    const name = requiredAssetString(entry, "name", filePath, "characters", index);
    let target: string | undefined;
    for (const key of ["target", "localizedName", "translation"]) {
      const candidate = optionalAssetString(entry, key, filePath, "characters", index);
      if (candidate) {
        target = candidate;
        break;
      }
    }
    const aliases = optionalAssetStringArray(entry, "aliases", filePath, "characters", index);
    const gender = optionalAssetString(entry, "gender", filePath, "characters", index);
    const pronouns = optionalAssetString(entry, "pronouns", filePath, "characters", index);
    const genderConfidence = optionalAssetString(entry, "genderConfidence", filePath, "characters", index);
    const requiredTerms = uniqueStrings([
      ...optionalAssetStringArray(entry, "requiredTerms", filePath, "characters", index),
      ...optionalAssetStringArray(entry, "mustIncludeTerms", filePath, "characters", index),
      ...optionalAssetStringArray(entry, "voiceRequiredTerms", filePath, "characters", index)
    ]);
    const forbiddenTerms = uniqueStrings([
      ...optionalAssetStringArray(entry, "forbiddenTerms", filePath, "characters", index),
      ...optionalAssetStringArray(entry, "avoidTerms", filePath, "characters", index),
      ...optionalAssetStringArray(entry, "voiceForbiddenTerms", filePath, "characters", index)
    ]);
    return {
      name,
      target,
      aliases: aliases.length > 0 ? aliases : undefined,
      ...(gender ? { gender } : {}),
      ...(pronouns ? { pronouns } : {}),
      ...(genderConfidence ? { genderConfidence } : {}),
      requiredTerms: requiredTerms.length > 0 ? requiredTerms : undefined,
      forbiddenTerms: forbiddenTerms.length > 0 ? forbiddenTerms : undefined
    };
  });
}

function parseStyleForbiddenTerms(styleGuide: string): string[] {
  const terms = new Set<string>();
  for (const line of styleGuide.split(/\r?\n/)) {
    const match = line.match(STYLE_FORBIDDEN_LINE_RE);
    if (!match) continue;
    for (const rawTerm of match[1].split(/[,，;；、]/)) {
      const term = rawTerm.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "").trim();
      if (term) {
        terms.add(term);
      }
    }
  }
  return [...terms];
}

export async function readProjectStyleForbiddenTerms(outputDir: string): Promise<string[]> {
  const assets = await readProjectAssets({ outputDir });
  return parseStyleForbiddenTerms(assets.styleGuide);
}

export async function readProjectTranslationValidationAssets(
  outputDir: string
): Promise<ProjectTranslationValidationAssets> {
  const assets = await readProjectAssets({ outputDir });
  return {
    glossaryEntries: projectGlossaryEntries(assets),
    characterEntries: projectCharacterEntries(assets),
    styleForbiddenTerms: parseStyleForbiddenTerms(assets.styleGuide)
  };
}

export async function readWorkflowTranslationValidationAssets(args: {
  outputDir: string;
  glossaryPath?: string;
}, readAssets = readWorkflowProjectAssets): Promise<ProjectTranslationValidationAssets> {
  const assets = await readAssets(args);
  return {
    glossaryEntries: projectGlossaryEntries(assets),
    characterEntries: projectCharacterEntries(assets),
    styleForbiddenTerms: parseStyleForbiddenTerms(assets.styleGuide)
  };
}

export async function readProjectGlossaryEntries(outputDir: string): Promise<GlossaryValidationEntry[]> {
  return (await readProjectTranslationValidationAssets(outputDir)).glossaryEntries;
}

export async function readProjectCharacterEntries(outputDir: string): Promise<CharacterValidationEntry[]> {
  return (await readProjectTranslationValidationAssets(outputDir)).characterEntries;
}

export async function replaceProjectGlossaryEntries(args: {
  outputDir: string;
  entries: Record<string, unknown>[];
}): Promise<ProjectAssets> {
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    const paths = assetPaths(args.outputDir);
    assertFormalAssetEntries("glossary", args.entries, paths.glossary);
    const currentAssets = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
    const selected = await selectedGlossaryLayer(args.outputDir, paths.glossary);
    const entries = selected.path && !sameAssetPath(selected.path, paths.glossary)
      ? mergeGlossaryLayers(
          mergeGlossaryLayers(currentAssets.glossary.entries, selected.entries, {
            conflict: "replace",
            conflictPath: selected.path
          }).entries,
          args.entries,
          { conflict: "replace", conflictPath: paths.glossary }
        ).entries
      : args.entries.map((entry) => ({ ...entry }));
    return writeCanonicalGlossaryAndBindUnlocked({
      outputDir: args.outputDir,
      paths,
      currentAssets,
      entries,
      inspectedBinding: selected.inspectedBinding
    });
  });
}

export async function updateProjectGlossaryEntry(args: {
  outputDir: string;
  entry: Record<string, unknown>;
  boundGlossaryPath?: string;
}): Promise<ProjectAssets> {
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    const paths = assetPaths(args.outputDir);
    assertFormalAssetEntry("glossary", args.entry, paths.glossary);
    const currentAssets = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
    const base = await resolveMutableGlossaryBase({
      outputDir: args.outputDir,
      canonicalPath: paths.glossary,
      currentEntries: currentAssets.glossary.entries,
      boundGlossaryPath: args.boundGlossaryPath
    });
    const entries = upsertGlossaryEntry(base.entries, args.entry);
    assertFormalAssetEntries("glossary", entries, paths.glossary);
    return writeCanonicalGlossaryAndBindUnlocked({
      outputDir: args.outputDir,
      paths,
      currentAssets,
      entries,
      inspectedBinding: base.inspectedBinding
    });
  });
}

/** Delete from the latest table, preserving unrelated concurrent edits and external source files. */
export async function deleteProjectGlossaryEntry(args: {
  outputDir: string;
  source: string;
  expectedTarget: string;
  boundGlossaryPath?: string;
}): Promise<ProjectAssets> {
  if (!args.source.trim() || !args.expectedTarget.trim()) {
    throw new Error("Glossary deletion requires a source and expected target.");
  }
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    const paths = assetPaths(args.outputDir);
    const currentAssets = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
    const state = await readProjectState(args.outputDir);
    const canonicalIsBound = typeof state.glossaryPath === "string"
      && sameAssetPath(state.glossaryPath, paths.glossary);
    const base = await resolveMutableGlossaryBase({
      outputDir: args.outputDir,
      canonicalPath: paths.glossary,
      currentEntries: currentAssets.glossary.entries,
      boundGlossaryPath: canonicalIsBound ? paths.glossary : args.boundGlossaryPath
    });
    const index = base.entries.findIndex((entry) => glossaryKey(entry.source) === glossaryKey(args.source));
    if (index < 0) throw new Error(`Glossary entry no longer exists: ${args.source}. Refresh the glossary.`);
    if (String(base.entries[index].target).trim() !== args.expectedTarget.trim()) {
      throw new Error(`Glossary entry changed: ${args.source}. Refresh before deleting.`);
    }
    const entries = base.entries.filter((_entry, entryIndex) => entryIndex !== index);
    return writeCanonicalGlossaryAndBindUnlocked({
      outputDir: args.outputDir, paths, currentAssets, entries, inspectedBinding: base.inspectedBinding
    });
  });
}

export async function mergeProjectGlossaryEntries(args: {
  outputDir: string;
  entries: Record<string, unknown>[];
  boundGlossaryPath?: string;
}): Promise<{
  assets: ProjectAssets;
  counts: { imported: number; added: number; deduplicated: number; aliasesAdded: number };
}> {
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    const paths = assetPaths(args.outputDir);
    assertFormalAssetEntries("glossary", args.entries, paths.glossary);
    const currentAssets = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
    const selected = await selectedGlossaryLayer(args.outputDir, paths.glossary);
    const bound = args.boundGlossaryPath ? await resolveMutableGlossaryBase({
      outputDir: args.outputDir, canonicalPath: paths.glossary,
      currentEntries: currentAssets.glossary.entries, boundGlossaryPath: args.boundGlossaryPath
    }) : undefined;
    const baseEntries = bound ? mergeGlossaryLayers(currentAssets.glossary.entries, bound.entries, {
      conflict: "replace", conflictPath: args.boundGlossaryPath!
    }).entries : selected.path
      ? mergeGlossaryLayers(currentAssets.glossary.entries, selected.entries, {
          conflict: "replace",
          conflictPath: selected.path
        }).entries
      : currentAssets.glossary.entries;
    const merged = mergeGlossaryLayers(baseEntries, args.entries, {
      conflict: "reject",
      conflictPath: paths.glossary
    });
    const assets = await writeCanonicalGlossaryAndBindUnlocked({
      outputDir: args.outputDir,
      paths,
      currentAssets,
      entries: merged.entries,
      inspectedBinding: bound?.inspectedBinding ?? selected.inspectedBinding
    });
    return {
      assets,
      counts: merged.counts
    };
  });
}

export async function importProjectGlossaryFile(args: {
  outputDir: string;
  filePath: string;
}): Promise<ProjectAssets> {
  const entries = parseGlossaryText(await readFile(args.filePath, "utf8"));
  if (entries.length === 0) {
    throw new Error(`No glossary entries parsed from ${args.filePath}.`);
  }
  return (await mergeProjectGlossaryEntries({
    outputDir: args.outputDir,
    entries: entries.map((entry) => ({ ...entry }))
  })).assets;
}

function mergeImportedCharacters(existing: Record<string, unknown>[], incoming: Record<string, unknown>[]) {
  const characters = existing.map((entry) => ({ ...entry }));
  const indexes = new Map(characters.map((entry, index) => [glossaryKey(entry.name), index]));
  let added = 0;
  for (const raw of incoming) {
    const entry = { ...raw };
    const supported = new Set(["name", "target", "localizedName", "translation", "aliases", "gender", "pronouns", "genderConfidence", "termsOfAddress", "requiredTerms", "mustIncludeTerms", "voiceRequiredTerms", "forbiddenTerms", "avoidTerms", "voiceForbiddenTerms", "voice", "identity", "role", "relationships", "catchphrases", "evidence"]);
    for (const key of Object.keys(entry)) {
      if (!supported.has(key)) throw new Error(`Unsupported character bible field: ${key}.`);
      if (typeof entry[key] === "string" && /[\r\n]/.test(String(entry[key]))) throw new Error(`Character bible field ${key} must fit one canonical Markdown line.`);
    }
    const targets = targetKeys("character_bible").map((key) => firstText(entry, [key])).filter(Boolean);
    if (new Set(targets).size > 1) throw new Error(`Character conflict: ${String(entry.name)} has different localized names.`);
    if (targets[0]) entry.target = targets[0];
    delete entry.localizedName;
    delete entry.translation;
    const required = uniqueStrings([ ...stringArray(entry.requiredTerms), ...stringArray(entry.mustIncludeTerms), ...stringArray(entry.voiceRequiredTerms) ]);
    if (required.length) entry.requiredTerms = normalizeHandwrittenCharacterRequiredTerms(required, {
      name: String(entry.name), target: typeof entry.target === "string" ? entry.target : undefined, aliases: stringArray(entry.aliases)
    });
    delete entry.mustIncludeTerms;
    delete entry.voiceRequiredTerms;
    const forbidden = uniqueStrings([ ...stringArray(entry.forbiddenTerms), ...stringArray(entry.avoidTerms), ...stringArray(entry.voiceForbiddenTerms) ]);
    if (forbidden.length) entry.forbiddenTerms = forbidden;
    delete entry.avoidTerms;
    delete entry.voiceForbiddenTerms;
    const roundTrip = parseCharacterBibleMarkdown(serializeCharacterBibleMarkdown([entry]), "import")[0];
    for (const [key, value] of Object.entries(entry)) {
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === "string" && (!value.trim() || value.trim() === "unknown")) continue;
      const normalized = Array.isArray(value) ? uniqueStrings(value as string[]) : typeof value === "string" ? value.trim() : value;
      if (JSON.stringify(roundTrip[key]) !== JSON.stringify(normalized)) throw new Error(`Character bible field ${key} cannot be preserved by the canonical serializer.`);
    }
    const index = indexes.get(glossaryKey(entry.name));
    if (index === undefined) {
      indexes.set(glossaryKey(entry.name), characters.length);
      characters.push(entry);
      added += 1;
      continue;
    }
    const current = characters[index];
    for (const [key, value] of Object.entries(entry)) {
      if (["name", "aliases", "requiredTerms", "forbiddenTerms"].includes(key)) continue;
      const before = firstText(current, [key]);
      const after = typeof value === "string" ? value.trim() : "";
      if (before && before !== "unknown" && after && after !== "unknown" && before !== after) throw new Error(`Character conflict: ${String(entry.name)} has different ${key} values.`);
    }
    const mappings = new Map<string, string>();
    for (const term of [...stringArray(current.requiredTerms), ...stringArray(entry.requiredTerms)]) {
      const mapping = parseCharacterVoiceRequiredTerm(term);
      if (!mapping) throw new Error(`Character required terms must use "source -> target". Invalid value: ${term}`);
      const { source, target } = mapping;
      const prior = mappings.get(glossaryKey(source));
      if (prior !== undefined && prior !== target) throw new Error(`Character conflict: ${String(entry.name)} has different dialogue mappings for ${source}.`);
      mappings.set(glossaryKey(source), target);
    }
    characters[index] = mergeAssetEntry("character_bible", current, entry);
    for (const [key, value] of Object.entries(entry)) if (current[key] === "unknown") characters[index][key] = value;
  }
  return { characters, counts: { imported: incoming.length, added, deduplicated: incoming.length - added } };
}

function characterRecordRevision(section: string): string {
  return createHash("sha256").update(section).digest("hex");
}

function characterSectionAnnotations(section: string): string[] {
  const known = new Set(["localized name", "target", "aliases", "gender/pronouns", "terms of address", "required terms", "required dialogue mappings", "forbidden terms", "voice", "identity", "role", "relationships", "catchphrases", "evidence"]);
  let readingMappings = false;
  return section.split(/\r?\n/).slice(1).filter((line) => {
    if (/^\s*[-*]\s*(?:\*\*)?Required dialogue mappings(?:\*\*)?\s*:\s*$/i.test(line)) {
      readingMappings = true;
      return false;
    }
    if (readingMappings && /^\s{2,}[-*]\s+(.+?)\s*$/.test(line)) return false;
    readingMappings = false;
    const field = line.match(/^\s*[-*]\s*(?:\*\*)?([^:*]+)(?:\*\*)?\s*:\s*(?:\*\*)?(.+?)\s*$/);
    return Boolean(line.trim()) && (!field || !known.has(field[1].trim().toLocaleLowerCase()));
  });
}

function importedCharacterBibleSource(source: string, existing: Record<string, unknown>[], merged: Record<string, unknown>[]): string {
  const sections = [...source.matchAll(/^##\s+[^\r\n]*$/gm)];
  if (sections.length !== existing.length) throw new Error("Character source sections do not match the parsed records.");
  const nextByName = new Map(merged.map((entry) => [glossaryKey(entry.name), entry]));
  if (nextByName.size !== merged.length) throw new Error("Character bible contains duplicate source names. Resolve them before importing.");
  let result = source.slice(0, sections[0]?.index ?? source.length);
  for (const [index, previous] of existing.entries()) {
    const key = glossaryKey(previous.name);
    const next = nextByName.get(key);
    if (!next) throw new Error("Character import cannot remove an existing record.");
    nextByName.delete(key);
    const original = source.slice(sections[index].index!, sections[index + 1]?.index ?? source.length);
    const serialized = serializeCharacterBibleMarkdown([next]);
    if (serialized === serializeCharacterBibleMarkdown([previous])) {
      result += original;
    } else {
      const annotations = characterSectionAnnotations(original);
      result += serialized.replace(/^# Character Bible\s*\n/, "").trimEnd()
        + (annotations.length ? "\n" + annotations.join("\n") : "") + "\n\n";
    }
  }
  if (nextByName.size) {
    result = result.trimEnd() + (result.trim() ? "\n\n" : "# Character Bible\n\n")
      + serializeCharacterBibleMarkdown([...nextByName.values()]).replace(/^# Character Bible\s*\n/, "");
  }
  return result;
}

/** Human table edits touch one canonical record, with a revision captured when editing began. */
export async function mutateProjectCharacterBibleEntry(args: {
  outputDir: string;
  operation: "add" | "update" | "delete";
  name?: string;
  expectedRevision?: string;
  entry?: Record<string, unknown>;
}): Promise<ProjectAssets> {
  if (!["add", "update", "delete"].includes(args.operation)) throw new Error("Invalid character operation.");
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    const current = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
    const characters = current.characterBible.characters;
    const keys = characters.map((entry) => glossaryKey(entry.name));
    if (new Set(keys).size !== keys.length) throw new Error("Character bible contains duplicate source names. Resolve them before editing.");
    const index = keys.indexOf(glossaryKey(args.name));
    if (args.operation !== "add") {
      if (!args.name?.trim() || index < 0) throw new Error("Character no longer exists. Refresh the character table.");
      const revision = current.characterBible.revisions[String(characters[index].name)];
      if (!args.expectedRevision || args.expectedRevision !== revision) throw new Error("Character changed since the table was read. Refresh and review the current record before saving.");
    }
    let replacement = "";
    if (args.operation !== "delete") {
      if (!args.entry || typeof args.entry !== "object" || Array.isArray(args.entry)) throw new Error("Character entry must be an object.");
      const merged = { ...(args.operation === "update" ? characters[index] : {}), ...args.entry };
      assertFormalAssetEntry("character_bible", merged, current.paths.characterBible);
      // Reuse strict import checks: unsupported fields, lossy Markdown and invalid dialogue mappings fail before writing.
      const normalized = mergeImportedCharacters([], [merged]).characters[0];
      const newKey = glossaryKey(normalized.name);
      if (keys.some((key, other) => key === newKey && (args.operation === "add" || other !== index))) throw new Error("A character with this source name already exists.");
      replacement = serializeCharacterBibleMarkdown([normalized]).replace(/^# Character Bible\s*\n/, "").trimEnd() + "\n\n";
      if (args.operation === "update") {
        const originalSection = current.characterBible.source.split(/^##\s+/m).slice(1)[index];
        const annotations = characterSectionAnnotations(originalSection);
        if (annotations.length) replacement = replacement.trimEnd() + "\n" + annotations.join("\n") + "\n\n";
      }
    }
    const source = current.characterBible.source;
    const sections = [...source.matchAll(/^##\s+[^\r\n]*$/gm)];
    let nextSource: string;
    if (args.operation === "add") {
      nextSource = source.trimEnd() + (source.trim() ? "\n\n" : "# Character Bible\n\n") + replacement;
    } else {
      const from = sections[index]?.index;
      if (from === undefined) throw new Error("Character source section is missing; no changes were written.");
      const to = sections[index + 1]?.index ?? source.length;
      nextSource = source.slice(0, from) + replacement + source.slice(to);
    }
    assertFormalAssetEntries("character_bible", parseCharacterBibleMarkdown(nextSource, current.paths.characterBible), current.paths.characterBible);
    await mkdir(path.dirname(current.paths.characterBible), { recursive: true });
    await writeTextFileAtomically(current.paths.characterBible, nextSource);
    return readProjectAssetsUnlocked({ outputDir: args.outputDir });
  });
}

/** Import both formal assets in the same serialized rollback boundary, retaining external glossary authority. */
export async function importProjectFormalAssets(args: {
  outputDir: string;
  glossary?: Record<string, unknown>[];
  characters?: Record<string, unknown>[];
}, options: {
  dryRun?: boolean;
  expectedRevision?: string;
  receipt?: TextFileTransactionUpdate;
  signal?: AbortSignal;
} = {}): Promise<{
  assets: ProjectAssets;
  revision: string;
  counts: { glossary: GlossaryMergeCounts; characters: { imported: number; added: number; deduplicated: number } };
}> {
  if (args.glossary === undefined && args.characters === undefined) throw new Error("At least one formal asset collection is required.");
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    const paths = assetPaths(args.outputDir);
    if (args.glossary !== undefined && !Array.isArray(args.glossary)) throw new Error("glossary must be an array.");
    if (args.characters !== undefined && !Array.isArray(args.characters)) throw new Error("characters must be an array.");
    assertFormalAssetEntries("glossary", args.glossary ?? [], paths.glossary);
    assertFormalAssetEntries("character_bible", args.characters ?? [], paths.characterBible);
    // Validate incoming canonical representation before any legacy migration or write.
    mergeImportedCharacters([], args.characters ?? []);
    // Read legacy input without migrating it before the rollback boundary.
    // A character update writes the canonical file in the same transaction;
    // legacy inputs remain intact rather than being renamed ahead of commit.
    const current = await readProjectAssetsUnlocked({ outputDir: args.outputDir, includeLegacyCharacters: true });
    const selected = await selectedGlossaryLayer(args.outputDir, paths.glossary);
    const revision = createHash("sha256").update(JSON.stringify({
      glossary: current.glossary.entries, characters: current.characterBible.source,
      glossaryAvailable: current.available.glossary, charactersAvailable: current.available.characterBible, selected
    })).digest("hex");
    if (options.expectedRevision && options.expectedRevision !== revision) {
      throw new Error("Formal assets changed after draft validation. Check the current draft again before committing.");
    }
    const base = selected.path ? mergeGlossaryLayers(current.glossary.entries, selected.entries, {
      conflict: "replace", conflictPath: selected.path
    }).entries : current.glossary.entries;
    const importReferences = new Map(base.map((entry) => [glossaryKey(entry.source), { ...entry }]));
    for (const incoming of args.glossary ?? []) {
      const key = glossaryKey(incoming.source);
      const existing = importReferences.get(key);
      if (existing) {
        for (const [field, value] of Object.entries(incoming)) {
          if (["source", "aliases", "alternatives"].includes(field)) continue;
          const before = existing[field];
          const present = before !== undefined && before !== "";
          const same = typeof before === "string" && typeof value === "string"
            ? glossaryValue(before) === glossaryValue(value)
            : JSON.stringify(before) === JSON.stringify(value);
          if (present && value !== undefined && value !== "" && !same) throw new Error(`Glossary conflict at ${paths.glossary}: source ${JSON.stringify(String(incoming.source))} has different ${field} values.`);
        }
      }
      importReferences.set(key, {
        ...(existing ? mergeMatchingGlossaryEntry(existing, incoming).entry : incoming),
        alternatives: uniqueStrings([...stringArray(existing?.alternatives), ...stringArray(incoming.alternatives)])
      });
    }
    const glossary = mergeGlossaryLayers(base, args.glossary ?? [], { conflict: "reject", conflictPath: paths.glossary });
    for (const entry of glossary.entries) {
      const alternatives = stringArray(importReferences.get(glossaryKey(entry.source))?.alternatives);
      if (alternatives.length) entry.alternatives = alternatives;
    }
    const characters = mergeImportedCharacters(current.characterBible.characters, args.characters ?? []);
    // The two formal assets cannot establish divergent names in one import.
    const glossaryTargets = new Map(glossary.entries.map((entry) => [glossaryKey(entry.source), glossaryValue(entry.target)]));
    for (const entry of characters.characters) {
      const target = firstText(entry, targetKeys("character_bible"));
      const term = glossaryTargets.get(glossaryKey(entry.name));
      if (term && target && term !== target) throw new Error(`Formal asset conflict: ${String(entry.name)} has different glossary and character targets.`);
    }
    const updates = [
      ...(args.glossary !== undefined ? [{ targetPath: paths.glossary, text: JSON.stringify({ entries: glossary.entries }, null, 2) }] : []),
      ...(args.characters?.length ? [{ targetPath: paths.characterBible,
        text: importedCharacterBibleSource(current.characterBible.source, current.characterBible.characters, characters.characters) }] : [])
    ];
    const counts = { glossary: glossary.counts, characters: characters.counts };
    if (options.dryRun) return { assets: current, revision, counts };
    if (options.receipt) updates.push(options.receipt);
    options.signal?.throwIfAborted();
    const snapshots = await Promise.all(updates.map(async (update) => {
      try {
        const info = await lstat(update.targetPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Formal asset import target is not a regular file: ${update.targetPath}.`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return { ...update, previous: await readOptionalText(update.targetPath) };
    }));
    await transactProjectState({
      outputDir: args.outputDir,
      expected: { glossaryPath: selected.inspectedBinding },
      patch: args.glossary !== undefined ? { glossaryPath: paths.glossary } : {},
      apply: async () => {
        options.signal?.throwIfAborted();
        for (const update of snapshots) {
          await mkdir(path.dirname(update.targetPath), { recursive: true });
          if (update.previous === undefined) await writeFile(update.targetPath, "", { encoding: "utf8", flag: "wx" });
        }
        await writeTextFilesAtomically(updates);
      },
      rollback: async () => {
        const failures: unknown[] = [];
        for (const update of snapshots) {
          try {
            if (update.previous === undefined) await rm(update.targetPath, { force: true });
            else await writeTextFileAtomically(update.targetPath, update.previous);
          } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Formal asset import rollback failed.");
      }
    });
    return { assets: await readProjectAssetsUnlocked({ outputDir: args.outputDir, includeLegacyCharacters: true }), revision, counts };
  });
}

export async function proposeAssetUpdate(args: {
  outputDir: string;
  kind: AssetProposalKind;
  entry: Record<string, unknown>;
  reason?: string;
}): Promise<AssetProposal> {
  const paths = assetPaths(args.outputDir);
  const formalPath = args.kind === "glossary" ? paths.glossary : paths.characterBible;
  assertFormalAssetEntry(args.kind, args.entry, formalPath);
  await mkdir(paths.proposalsDir, { recursive: true });
  const key = entryKey(args.kind, args.entry);
  if (key) {
    const existing = (await listAssetProposals({ outputDir: args.outputDir }))
      .find((proposal) => proposal.status === "pending"
        && proposal.kind === args.kind
        && entryKey(args.kind, proposal.entry) === key);
    if (existing) {
      const merged: AssetProposal = {
        ...existing,
        entry: mergeAssetEntry(args.kind, existing.entry, args.entry),
        reason: mergeReason(existing.reason, args.reason),
        updatedAt: new Date().toISOString()
      };
      await writeFile(proposalPath(args.outputDir, existing.id), JSON.stringify(merged, null, 2), "utf8");
      return merged;
    }
  }
  const proposal: AssetProposal = {
    id: proposalId(args.kind),
    kind: args.kind,
    status: "pending",
    entry: args.entry,
    reason: args.reason,
    createdAt: new Date().toISOString()
  };
  await writeFile(proposalPath(args.outputDir, proposal.id), JSON.stringify(proposal, null, 2), "utf8");
  return proposal;
}

export async function listAssetProposals(args: { outputDir: string }): Promise<AssetProposal[]> {
  const paths = assetPaths(args.outputDir);
  try {
    const names = await readdir(paths.proposalsDir);
    const proposals = await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(paths.proposalsDir, name);
        const proposal = assetProposalFrom(await readJsonObject(filePath), filePath);
        const formalPath = proposal.kind === "glossary" ? paths.glossary : paths.characterBible;
        assertFormalAssetEntry(proposal.kind, proposal.entry, formalPath);
        return proposal;
      }));
    return proposals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function mergeEntry(kind: AssetProposalKind, entries: Record<string, unknown>[], entry: Record<string, unknown>) {
  const source = entryKey(kind, entry);
  if (!source) return [...entries, entry];
  const index = entries.findIndex((existing) => entryKey(kind, existing) === source);
  if (index < 0) return [...entries, entry];
  const next = entries.slice();
  next[index] = mergeAssetEntry(kind, next[index], entry);
  return next;
}

async function approveAssetProposalUnlocked(args: {
  outputDir: string;
  proposalId: string;
  approvedBy?: string;
  entry?: Record<string, unknown>;
}): Promise<AssetProposal> {
  const filePath = proposalPath(args.outputDir, args.proposalId);
  const proposalValue = await readJsonObject(filePath);
  if (!isAssetProposal(proposalValue) || proposalValue.status !== "pending") {
    throw new Error(`Pending asset proposal not found: ${args.proposalId}`);
  }
  const proposal = proposalValue;
  const approvedEntry: unknown = args.entry === undefined ? proposal.entry : args.entry;
  const paths = assetPaths(args.outputDir);
  const formalPath = proposal.kind === "glossary" ? paths.glossary : paths.characterBible;
  assertFormalAssetEntry(proposal.kind, proposal.entry, formalPath);
  assertFormalAssetEntry(proposal.kind, approvedEntry, formalPath);
  const currentAssets = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
  await mkdir(path.dirname(formalPath), { recursive: true });
  await mkdir(workspaceDir(args.outputDir), { recursive: true });
  if (proposal.kind === "glossary") {
    const entries = mergeEntry("glossary", currentAssets.glossary.entries, approvedEntry);
    assertFormalAssetEntries("glossary", entries, paths.glossary);
    await writeTextFileAtomically(paths.glossary, JSON.stringify({ entries }, null, 2));
  } else {
    const characters = mergeEntry(
      "character_bible",
      currentAssets.characterBible.characters,
      approvedEntry
    );
    assertFormalAssetEntries("character_bible", characters, paths.characterBible);
    await writeTextFileAtomically(paths.characterBible, serializeCharacterBibleMarkdown(characters));
  }
  const approved: AssetProposal = {
    ...proposal,
    entry: approvedEntry,
    status: "approved",
    approvedAt: new Date().toISOString(),
    approvedBy: args.approvedBy ?? "human"
  };
  await writeFile(filePath, JSON.stringify(approved, null, 2), "utf8");
  return approved;
}

export async function approveAssetProposal(args: {
  outputDir: string;
  proposalId: string;
  approvedBy?: string;
  entry?: Record<string, unknown>;
}): Promise<AssetProposal> {
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    return approveAssetProposalUnlocked(args);
  });
}

async function saveProjectAssetsUnlocked(args: {
  outputDir: string;
  glossaryEntry?: Record<string, unknown>;
  characterEntry?: Record<string, unknown>;
  styleGuide?: string;
}): Promise<ProjectAssets> {
  const paths = assetPaths(args.outputDir);
  const currentAssets = await readProjectAssetsUnlocked({ outputDir: args.outputDir });
  const currentGlossary = currentAssets.glossary.entries;
  const currentCharacters = currentAssets.characterBible.characters;

  let nextGlossary: Record<string, unknown>[] | undefined;
  let glossaryBinding: unknown;
  if (args.glossaryEntry !== undefined) {
    assertFormalAssetEntry("glossary", args.glossaryEntry, paths.glossary);
    const base = await resolveMutableGlossaryBase({
      outputDir: args.outputDir,
      canonicalPath: paths.glossary,
      currentEntries: currentGlossary
    });
    glossaryBinding = base.inspectedBinding;
    nextGlossary = upsertGlossaryEntry(base.entries, args.glossaryEntry);
    assertFormalAssetEntries("glossary", nextGlossary, paths.glossary);
  }

  let nextCharacters: Record<string, unknown>[] | undefined;
  if (args.characterEntry !== undefined) {
    assertFormalAssetEntry("character_bible", args.characterEntry, paths.characterBible);
    const requiredTerms = Array.isArray(args.characterEntry.requiredTerms)
      ? args.characterEntry.requiredTerms.map((value) => String(value))
      : [];
    if (requiredTerms.length > 0) {
      args.characterEntry.requiredTerms = normalizeHandwrittenCharacterRequiredTerms(requiredTerms, {
        name: typeof args.characterEntry.name === "string" ? args.characterEntry.name : undefined,
        target: typeof args.characterEntry.target === "string" ? args.characterEntry.target : undefined,
        aliases: Array.isArray(args.characterEntry.aliases)
          ? args.characterEntry.aliases.map((value) => String(value))
          : undefined
      });
    }
    nextCharacters = mergeEntry("character_bible", currentCharacters, args.characterEntry);
    assertFormalAssetEntries("character_bible", nextCharacters, paths.characterBible);
  }
  if (args.styleGuide !== undefined && typeof args.styleGuide !== "string") {
    throw new Error(`Invalid project asset at ${paths.styleGuide}: styleGuide must be a string.`);
  }

  await mkdir(workspaceDir(args.outputDir), { recursive: true });
  if (nextCharacters) {
    await mkdir(path.dirname(paths.characterBible), { recursive: true });
  }
  if (nextGlossary) {
    await writeCanonicalGlossaryAndBindUnlocked({
      outputDir: args.outputDir,
      paths,
      currentAssets,
      entries: nextGlossary,
      inspectedBinding: glossaryBinding
    });
  }
  if (nextCharacters) {
    await writeTextFileAtomically(paths.characterBible, serializeCharacterBibleMarkdown(nextCharacters));
  }
  if (args.styleGuide !== undefined) {
    await writeTextFileAtomically(paths.styleGuide, args.styleGuide);
  }
  return readProjectAssetsUnlocked({ outputDir: args.outputDir });
}

export async function saveProjectAssets(args: {
  outputDir: string;
  glossaryEntry?: Record<string, unknown>;
  characterEntry?: Record<string, unknown>;
  styleGuide?: string;
}): Promise<ProjectAssets> {
  return enqueueProjectAssetWrite(args.outputDir, async () => {
    await ensureLegacyCharacterBibleMigratedUnlocked(args.outputDir);
    return saveProjectAssetsUnlocked(args);
  });
}
