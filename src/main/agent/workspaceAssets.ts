import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  mergeProjectGlossaryEntries,
  readProjectAssets,
  type GlossaryValidationEntry,
  type ProjectAssets
} from "./projectAssets.ts";
import { writeTextFileAtomically } from "../atomicFile.ts";

export interface WorkspaceAssetPaths {
  glossaryCandidates: string;
  characterBible: string;
}

export interface YnWorkflowWorkspacePaths extends WorkspaceAssetPaths {
  projectMetadata: string;
  translationOutput: string;
  workspaceAssets: string;
  proofreadReports: string;
  styleGuide: string;
}

export interface WorkspaceAssetsStatus {
  paths: WorkspaceAssetPaths;
  counts: {
    glossaryCandidates: number;
    characterBibleLines: number;
  };
  available: {
    glossaryCandidates: boolean;
    characterBible: boolean;
  };
  pending: {
    glossaryCandidates: number;
  };
  actions: {
    importGlossaryCandidates: boolean;
  };
}

export interface WorkspaceAgentContext {
  paths: WorkspaceAssetPaths;
  glossaryCandidates?: GlossaryValidationEntry[];
  characterBible?: string;
}

export interface GeneratedGlossaryImportCounts {
  imported: number;
  added: number;
  deduplicated: number;
  aliasesAdded: number;
}

export interface GeneratedGlossaryImportResult {
  assets: ProjectAssets;
  counts: GeneratedGlossaryImportCounts;
}

type WorkspaceAssetsStatusListener = (outputDir: string, status: WorkspaceAssetsStatus) => void;
const statusListeners = new Set<WorkspaceAssetsStatusListener>();
const activeStatusListeners = new Set<WorkspaceAssetsStatusListener>();
const glossaryImportTransactions = new Map<string, Promise<void>>();
const glossaryCandidateWriteTransactions = new Map<string, Promise<void>>();

export interface WorkspaceGlossaryCandidateProposal {
  source: string;
  target: string;
  aliases?: string[];
  info?: string;
  status?: "confirmed" | "auto" | "pending";
  allowTargetReplacement?: boolean;
}

export interface WorkspaceGlossaryCandidateCommitOutcome {
  source: string;
  target: string;
  status: "inserted" | "merged" | "replaced" | "removed" | "conflict";
  existingTarget?: string;
}

export interface WorkspaceGlossaryCandidateCommit {
  outcomes: WorkspaceGlossaryCandidateCommitOutcome[];
  rollback(): Promise<void>;
}

export interface WorkspaceGlossaryCandidateTransaction {
  commit(
    proposals: WorkspaceGlossaryCandidateProposal[],
    options?: { removeSources?: string[] }
  ): Promise<WorkspaceGlossaryCandidateCommit>;
}

export function subscribeWorkspaceAssetsStatus(listener: WorkspaceAssetsStatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function subscribeActiveWorkspaceAssetsStatus(listener: WorkspaceAssetsStatusListener): () => void {
  activeStatusListeners.add(listener);
  return () => activeStatusListeners.delete(listener);
}

function publishStatus(outputDir: string, status: WorkspaceAssetsStatus): void {
  for (const listener of statusListeners) listener(projectDir(outputDir), status);
}

function projectDir(outputDir: string): string {
  return path.basename(outputDir).toLowerCase() === ".translation-workshop"
    ? path.dirname(outputDir)
    : outputDir;
}

export function workspaceAssetPaths(outputDir: string): WorkspaceAssetPaths {
  const workspace = path.join(projectDir(outputDir), "AI_translation", "_workspace");
  return {
    glossaryCandidates: path.join(workspace, "glossary_candidates.json"),
    characterBible: path.join(workspace, "character_bible.md")
  };
}

export async function ensureYnWorkflowWorkspace(outputDir: string): Promise<YnWorkflowWorkspacePaths> {
  const project = projectDir(outputDir);
  const projectMetadata = path.join(project, ".translation-workshop");
  const translationOutput = path.join(project, "AI_translation");
  const workspaceAssets = path.join(translationOutput, "_workspace");
  const proofreadReports = path.join(project, "report");
  await Promise.all([
    projectMetadata,
    translationOutput,
    workspaceAssets,
    proofreadReports
  ].map((directory) => mkdir(directory, { recursive: true })));
  return {
    projectMetadata,
    translationOutput,
    workspaceAssets,
    proofreadReports,
    styleGuide: path.join(projectMetadata, "style_guide.md"),
    glossaryCandidates: path.join(workspaceAssets, "glossary_candidates.json"),
    characterBible: path.join(workspaceAssets, "character_bible.md")
  };
}

function decodeUtf8(value: Buffer, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid UTF-8 workspace asset at ${filePath}: ${detail}`);
  }
}

async function readUtf8(filePath: string): Promise<string | undefined> {
  try {
    return decodeUtf8(await readFile(filePath), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function normalized(value: string): string {
  return value.trim().normalize("NFC");
}

function assertNonEmptyString(value: unknown, filePath: string, field: string, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Invalid generated glossary at ${filePath}: entries[${index}].${field} must be a non-empty string.`
    );
  }
  return normalized(value);
}

function assertAliases(value: unknown, filePath: string, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((alias) => typeof alias !== "string" || !alias.trim())) {
    throw new Error(
      `Invalid generated glossary at ${filePath}: entries[${index}].aliases must be an array of non-empty strings.`
    );
  }
  return [...new Set(value.map((alias) => normalized(alias)))];
}

function assertOptionalString(value: unknown, filePath: string, field: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid generated glossary at ${filePath}: entries[${index}].${field} must be a non-empty string.`);
  }
  return normalized(value);
}

function assertGlossaryStatus(value: unknown, filePath: string, index: number): "confirmed" | "auto" | "pending" | undefined {
  const status = assertOptionalString(value, filePath, "status", index);
  if (status === undefined) return undefined;
  if (status !== "confirmed" && status !== "auto" && status !== "pending") {
    throw new Error(`Invalid generated glossary at ${filePath}: entries[${index}].status must be confirmed, auto, or pending.`);
  }
  return status;
}

function parseGeneratedGlossary(value: string, filePath: string): GlossaryValidationEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid generated glossary JSON at ${filePath}: ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid generated glossary at ${filePath}: expected an object root.`);
  }
  const root = parsed as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  if (rootKeys.length !== 1 || rootKeys[0] !== "entries") {
    throw new Error(`Invalid generated glossary at ${filePath}: expected exactly the entries property.`);
  }
  if (!Array.isArray(root.entries)) {
    throw new Error(`Invalid generated glossary at ${filePath}: entries must be an array.`);
  }

  return root.entries.map((value, index): GlossaryValidationEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid generated glossary at ${filePath}: entries[${index}] must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (keys.some((key) => !["source", "target", "aliases", "info", "status"].includes(key))) {
      throw new Error(
        `Invalid generated glossary at ${filePath}: entries[${index}] contains an unsupported property.`
      );
    }
    const source = assertNonEmptyString(entry.source, filePath, "source", index);
    const target = assertNonEmptyString(entry.target, filePath, "target", index);
    const aliases = assertAliases(entry.aliases, filePath, index);
    const info = assertOptionalString(entry.info, filePath, "info", index);
    const status = assertGlossaryStatus(entry.status, filePath, index);
    return {
      source,
      target,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(info ? { info } : {}),
      ...(status ? { status } : {})
    };
  });
}

function characterBibleHasRequiredMetadata(content: string): boolean {
  const sections = content.split(/^##\s+/m).slice(1);
  return sections.length > 0 && sections.every((section) =>
    /^[-*]\s*(?:\*\*)?Gender\/pronouns\s*:(?:\*\*)?\s*.+\b(?:confirmed|inferred|unknown)\b/im.test(section)
    && /^[-*]\s*(?:\*\*)?Terms of address\s*:(?:\*\*)?\s*.+/im.test(section)
  );
}

export function validateGeneratedGlossaryContent(
  content: string,
  filePath = "AI_translation/_workspace/glossary_candidates.json"
): GlossaryValidationEntry[] {
  return parseGeneratedGlossary(content, filePath);
}

export function validateGeneratedCharacterBibleContent(
  content: string,
  filePath = "AI_translation/_workspace/character_bible.md"
): string {
  if (!content.trim()) throw new Error(`Invalid generated character bible at ${filePath}: content must not be empty.`);
  if (!/^#\s+Character Bible\s*$/im.test(content) || !characterBibleHasRequiredMetadata(content)) {
    throw new Error(
      `Invalid generated character bible at ${filePath}: every ## character section must include Gender/pronouns with confirmed, inferred, or unknown confidence, plus Terms of address.`
    );
  }
  return content;
}

function glossaryCandidateWriteKey(outputDir: string): string {
  const resolved = path.resolve(projectDir(outputDir));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function enqueueGlossaryCandidateWrite<T>(outputDir: string, work: () => Promise<T>): Promise<T> {
  const key = glossaryCandidateWriteKey(outputDir);
  const previous = glossaryCandidateWriteTransactions.get(key) ?? Promise.resolve();
  let value!: T;
  const current = previous.catch(() => undefined).then(async () => {
    value = await work();
  });
  const settled = current.then(() => undefined, () => undefined);
  glossaryCandidateWriteTransactions.set(key, settled);
  return current.then(() => value).finally(() => {
    if (glossaryCandidateWriteTransactions.get(key) === settled) {
      glossaryCandidateWriteTransactions.delete(key);
    }
  });
}

async function commitWorkspaceGlossaryCandidatesUnlocked(
  outputDir: string,
  proposals: WorkspaceGlossaryCandidateProposal[],
  options: { removeSources?: string[] } = {}
): Promise<WorkspaceGlossaryCandidateCommit> {
    const glossaryPath = workspaceAssetPaths(outputDir).glossaryCandidates;
    const previousContent = await readUtf8(glossaryPath);
    const entries = previousContent === undefined
      ? []
      : validateGeneratedGlossaryContent(previousContent, glossaryPath);
    const bySource = new Map(entries.map((entry) => [normalized(entry.source), entry]));
    const outcomes: WorkspaceGlossaryCandidateCommitOutcome[] = [];
    let changed = false;
    for (const sourceValue of options.removeSources ?? []) {
      const source = normalized(sourceValue);
      const existing = bySource.get(source);
      if (!existing) continue;
      entries.splice(entries.indexOf(existing), 1);
      bySource.delete(source);
      outcomes.push({ source, target: existing.target, status: "removed" });
      changed = true;
    }
    for (const proposal of proposals) {
      const source = normalized(proposal.source);
      const target = normalized(proposal.target);
      if (!source || !target) throw new Error("A workspace glossary candidate requires non-empty source and target text.");
      const existing = bySource.get(source);
      if (existing && normalized(existing.target) !== target && !proposal.allowTargetReplacement) {
        outcomes.push({
          source,
          target,
          status: "conflict",
          existingTarget: existing.target
        });
        continue;
      }
      const aliases = [...new Set((proposal.aliases ?? []).map(normalized).filter(Boolean))];
      if (existing) {
        const previousTarget = existing.target;
        const replacing = normalized(previousTarget) !== target;
        const nextAliases = [...new Set([...(existing.aliases ?? []), ...aliases])];
        const nextInfo = proposal.info?.trim() || existing.info;
        const nextStatus = existing.status === "confirmed"
          ? "confirmed"
          : proposal.status ?? existing.status ?? "pending";
        changed ||= replacing
          || JSON.stringify(nextAliases) !== JSON.stringify(existing.aliases ?? [])
          || nextInfo !== existing.info
          || nextStatus !== existing.status;
        existing.target = target;
        existing.aliases = nextAliases;
        if (nextInfo) existing.info = nextInfo;
        existing.status = nextStatus;
        outcomes.push({
          source,
          target,
          status: replacing ? "replaced" : "merged",
          ...(replacing ? { existingTarget: previousTarget } : {})
        });
        continue;
      }
      const entry: GlossaryValidationEntry = {
        source,
        target,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(proposal.info?.trim() ? { info: proposal.info.trim() } : {}),
        status: proposal.status ?? "pending"
      };
      entries.push(entry);
      bySource.set(source, entry);
      outcomes.push({ source, target, status: "inserted" });
      changed = true;
    }
    const committedContent = `${JSON.stringify({ entries }, null, 2)}\n`;
    validateGeneratedGlossaryContent(committedContent, glossaryPath);
    if (changed || previousContent === undefined) {
      await mkdir(path.dirname(glossaryPath), { recursive: true });
      await writeTextFileAtomically(glossaryPath, committedContent);
    }
    let rolledBack = false;
    return {
      outcomes,
      async rollback() {
        if (rolledBack || (!changed && previousContent !== undefined)) return;
        const current = await readUtf8(glossaryPath);
        if (current !== committedContent) {
          throw new Error(
            `Cannot roll back ${glossaryPath}: another glossary candidate commit changed it after this transaction.`
          );
        }
        if (previousContent === undefined) {
          await rm(glossaryPath, { force: true });
        } else {
          await writeTextFileAtomically(glossaryPath, previousContent);
        }
        rolledBack = true;
      }
    };
}

export function runWorkspaceGlossaryCandidateTransaction<T>(
  outputDir: string,
  work: (transaction: WorkspaceGlossaryCandidateTransaction) => Promise<T>
): Promise<T> {
  return enqueueGlossaryCandidateWrite(outputDir, () => work({
    commit: (proposals, options) => commitWorkspaceGlossaryCandidatesUnlocked(outputDir, proposals, options)
  }));
}

export function commitWorkspaceGlossaryCandidates(
  outputDir: string,
  proposals: WorkspaceGlossaryCandidateProposal[],
  options: { removeSources?: string[] } = {}
): Promise<WorkspaceGlossaryCandidateCommit> {
  return runWorkspaceGlossaryCandidateTransaction(outputDir, async (transaction) => {
    const commit = await transaction.commit(proposals, options);
    return {
      outcomes: commit.outcomes,
      rollback: () => enqueueGlossaryCandidateWrite(outputDir, () => commit.rollback())
    };
  });
}

async function readGeneratedGlossary(filePath: string): Promise<GlossaryValidationEntry[]> {
  const source = await readUtf8(filePath);
  if (source === undefined) {
    throw new Error(`Generated glossary candidates were not found at ${filePath}.`);
  }
  return parseGeneratedGlossary(source, filePath);
}

export async function readWorkspaceAssetsStatus(outputDir: string): Promise<WorkspaceAssetsStatus> {
  const paths = workspaceAssetPaths(outputDir);
  const [glossarySource, characterBibleSource, projectAssets] = await Promise.all([
    readUtf8(paths.glossaryCandidates),
    readUtf8(paths.characterBible),
    readProjectAssets({ outputDir: projectDir(outputDir) })
  ]);
  const glossaryEntries = glossarySource === undefined
    ? undefined
    : parseGeneratedGlossary(glossarySource, paths.glossaryCandidates);
  const characterBibleAvailable = characterBibleSource !== undefined
    && Boolean(characterBibleSource.trim())
    && characterBibleHasRequiredMetadata(characterBibleSource);
  const characterBibleLines = characterBibleAvailable
    ? characterBibleSource!.replace(/\r?\n$/, "").split(/\r?\n/).length
    : 0;
  const formalBySource = new Map(projectAssets.glossary.entries.map((entry) => [
    normalized(String(entry.source)),
    {
      target: normalized(String(entry.target)),
      aliases: new Set(aliasesOf(entry)),
      info: normalized(String(entry.info ?? "")),
      status: normalized(String(entry.status ?? ""))
    }
  ]));
  const pendingGlossaryCandidates = glossaryEntries?.filter((entry) => {
    const formal = formalBySource.get(normalized(entry.source));
    if (!formal || formal.target !== normalized(entry.target)) return true;
    if ((entry.aliases ?? []).some((alias) => !formal.aliases.has(normalized(alias)))) return true;
    if (entry.info && !formal.info) return true;
    if (entry.status && !formal.status) return true;
    return false;
  }).length ?? 0;
  const status = {
    paths,
    counts: {
      glossaryCandidates: glossaryEntries?.length ?? 0,
      characterBibleLines
    },
    available: {
      glossaryCandidates: glossaryEntries !== undefined,
      characterBible: characterBibleAvailable
    },
    pending: {
      glossaryCandidates: pendingGlossaryCandidates
    },
    actions: {
      importGlossaryCandidates: pendingGlossaryCandidates > 0
    }
  };
  publishStatus(outputDir, status);
  return status;
}

export async function readWorkspaceAgentContext(outputDir: string): Promise<WorkspaceAgentContext> {
  const paths = workspaceAssetPaths(outputDir);
  const [glossarySource, characterBibleSource] = await Promise.all([
    readUtf8(paths.glossaryCandidates),
    readUtf8(paths.characterBible)
  ]);
  return {
    paths,
    glossaryCandidates: glossarySource === undefined
      ? undefined
      : validateGeneratedGlossaryContent(glossarySource, paths.glossaryCandidates),
    characterBible: characterBibleSource === undefined
      ? undefined
      : validateGeneratedCharacterBibleContent(characterBibleSource, paths.characterBible)
  };
}

export const getWorkspaceAssetsStatus = readWorkspaceAssetsStatus;

export async function activateWorkspaceAssets(outputDir: string): Promise<WorkspaceAssetsStatus> {
  const root = projectDir(outputDir);
  const status = await readWorkspaceAssetsStatus(root);
  for (const listener of activeStatusListeners) listener(root, status);
  return status;
}

function aliasesOf(entry: Record<string, unknown>): string[] {
  const aliases = entry.aliases;
  return Array.isArray(aliases)
    ? aliases.filter((alias): alias is string => typeof alias === "string").map(normalized)
    : [];
}

async function importGeneratedGlossaryCandidatesUnlocked(
  outputDir: string
): Promise<GeneratedGlossaryImportResult> {
  const paths = workspaceAssetPaths(outputDir);
  const candidates = await readGeneratedGlossary(paths.glossaryCandidates);
  const result = await mergeProjectGlossaryEntries({
    outputDir,
    entries: candidates.map((candidate) => ({
      source: candidate.source,
      target: candidate.target,
      ...(candidate.aliases?.length ? { aliases: [...candidate.aliases] } : {}),
      ...(candidate.info ? { info: candidate.info } : {}),
      ...(candidate.status ? { status: candidate.status } : {})
    }))
  });
  await readWorkspaceAssetsStatus(outputDir);
  return result;
}

export function importGeneratedGlossaryCandidates(
  outputDir: string
): Promise<GeneratedGlossaryImportResult> {
  const resolvedProject = path.resolve(projectDir(outputDir));
  const key = process.platform === "win32" ? resolvedProject.toLowerCase() : resolvedProject;
  const previous = glossaryImportTransactions.get(key) ?? Promise.resolve();
  const result = previous.then(() => enqueueGlossaryCandidateWrite(
    resolvedProject,
    () => importGeneratedGlossaryCandidatesUnlocked(resolvedProject)
  ));
  const settled = result.then(() => undefined, () => undefined);
  glossaryImportTransactions.set(key, settled);
  return result.finally(() => {
    if (glossaryImportTransactions.get(key) === settled) glossaryImportTransactions.delete(key);
  });
}
