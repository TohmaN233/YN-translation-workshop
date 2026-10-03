import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { YnTaskPreparationContext } from "./agent/piNative/taskPreparation.ts";
import { importProjectFormalAssets } from "./agent/projectAssets.ts";
import { assertAssetProjectPaths } from "./automationAssets.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";

type RecordEntry = Record<string, unknown>;
export interface TaskAssetDraftInput {
  glossary?: RecordEntry[];
  characters?: RecordEntry[];
  expectedRevision?: string;
}
export interface TaskAssetDraftReadInput {
  kind: "glossary" | "characters";
  offset?: number;
  limit?: number;
}
interface Draft {
  schemaVersion: 1;
  sessionId: string;
  preparationId: string;
  generation: number;
  glossary?: RecordEntry[];
  characters?: RecordEntry[];
  checked?: { revision: string; formalRevision: string; reviewSummary: string };
  committed?: { revision: string; counts: unknown; paths: { glossary?: string; characterBible?: string } };
}

const queues = new Map<string, Promise<unknown>>();
async function withDraft<T>(context: YnTaskPreparationContext, operation: (filePath: string, draft: Draft) => Promise<T>): Promise<T> {
  if (!/^[\w-]+$/.test(context.preparationId) || !context.sessionId?.trim()) throw new Error("Invalid task asset draft ownership.");
  const projectRoot = path.basename(context.outputDir).toLowerCase() === ".translation-workshop" ? path.dirname(path.resolve(context.outputDir)) : path.resolve(context.outputDir);
  const filePath = path.join(projectRoot, ".translation-workshop", "agent", "asset-drafts", `${context.preparationId}.json`);
  const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  const previous = queues.get(key) ?? Promise.resolve();
  const operationPromise = previous.catch(() => undefined).then(async () => {
    await assertAssetProjectPaths(context.outputDir, [filePath]);
    let draft: Draft;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Task asset draft is not a regular file: ${filePath}`);
      draft = JSON.parse(await readFile(filePath, "utf8")) as Draft;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      draft = { schemaVersion: 1, sessionId: context.sessionId, preparationId: context.preparationId, generation: 0 };
    }
    assertDraft(draft, context);
    return operation(filePath, draft);
  });
  queues.set(key, operationPromise);
  try { return await operationPromise; }
  finally { if (queues.get(key) === operationPromise) queues.delete(key); }
}

function identity(entry: RecordEntry, kind: "glossary" | "characters"): string {
  const value = entry?.[kind === "glossary" ? "source" : "name"];
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) throw new Error(`Draft ${kind} requires a non-empty single-line ${kind === "glossary" ? "source" : "name"}.`);
  return value.trim().normalize("NFC").toLocaleLowerCase();
}
function assertCollection(value: unknown, kind: "glossary" | "characters"): asserts value is RecordEntry[] {
  if (!Array.isArray(value)) throw new Error(`Draft ${kind} must be an array.`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Draft ${kind} entry must be an object.`);
    const key = identity(entry, kind);
    if (seen.has(key)) throw new Error(`Duplicate draft ${kind} identity: ${key}`);
    seen.add(key);
  }
}
function assertDraft(draft: Draft, context: YnTaskPreparationContext) {
  if (!draft || draft.schemaVersion !== 1 || !Number.isSafeInteger(draft.generation) || draft.generation < 0) throw new Error("Invalid persisted task asset draft.");
  if (draft.sessionId !== context.sessionId || draft.preparationId !== context.preparationId) throw new Error("Task asset draft belongs to another preparation/session.");
  for (const kind of ["glossary", "characters"] as const) if (draft[kind] !== undefined) assertCollection(draft[kind], kind);
  if (draft.checked && (draft.checked.revision !== revision(draft) || typeof draft.checked.formalRevision !== "string" || typeof draft.checked.reviewSummary !== "string")) throw new Error("Invalid persisted draft validation.");
  if (draft.committed && (draft.committed.revision !== revision(draft) || !draft.checked || !draft.committed.paths || typeof draft.committed.paths !== "object")) throw new Error("Invalid persisted draft commit receipt.");
}
function revision(draft: Draft): string {
  return createHash("sha256").update(JSON.stringify({ generation: draft.generation, glossary: draft.glossary, characters: draft.characters })).digest("hex");
}
function requireRevision(draft: Draft, expected: string) {
  if (!expected || revision(draft) !== expected) throw new Error("Task asset draft changed. Read the current draft and review it again.");
}
function requireMutable(draft: Draft) {
  if (draft.committed) throw new Error("This reference preparation was already committed. Start a new preparation to make further changes.");
}
function describe(filePath: string, draft: Draft) {
  return { draftPath: filePath, revision: revision(draft), status: draft.committed ? "committed" : draft.checked ? "checked" : "draft",
    counts: { glossary: draft.glossary?.length ?? 0, characters: draft.characters?.length ?? 0 },
    ...(draft.committed ? { committed: draft.committed } : {}) };
}
async function save(filePath: string, draft: Draft, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeTextFileAtomically(filePath, JSON.stringify(draft, null, 2));
}

/** Preparation records are mutable and separate from first-established translation candidates. */
export async function upsertTaskAssetDraft(context: YnTaskPreparationContext, input: TaskAssetDraftInput, signal?: AbortSignal) {
  return withDraft(context, async (filePath, draft) => {
    requireMutable(draft);
    if (input.expectedRevision !== undefined) requireRevision(draft, input.expectedRevision);
    if (input.glossary === undefined && input.characters === undefined) throw new Error("Provide draft glossary or characters.");
    for (const kind of ["glossary", "characters"] as const) {
      const incoming = input[kind];
      if (incoming === undefined) continue;
      assertCollection(incoming, kind);
      const records = new Map((draft[kind] ?? []).map(entry => [identity(entry, kind), entry]));
      for (const entry of incoming) {
        const key = identity(entry, kind);
        const next = { ...records.get(key), ...structuredClone(entry) };
        for (const [field, value] of Object.entries(next)) if (value === null) delete next[field];
        records.set(key, next);
      }
      draft[kind] = [...records.values()];
    }
    draft.generation++;
    delete draft.checked;
    await save(filePath, draft, signal);
    return describe(filePath, draft);
  });
}

export async function readTaskAssetDraft(context: YnTaskPreparationContext, input: TaskAssetDraftReadInput) {
  return withDraft(context, async (filePath, draft) => {
    if (!["glossary", "characters"].includes(input.kind)) throw new Error("Unknown draft collection.");
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Draft pagination requires a non-negative offset and positive limit.");
    const entries = draft[input.kind] ?? [];
    return { ...describe(filePath, draft), kind: input.kind, entries: structuredClone(entries.slice(offset, offset + limit)),
      nextOffset: offset + limit < entries.length ? offset + limit : null };
  });
}

export async function deleteTaskAssetDraftEntries(context: YnTaskPreparationContext, input: { kind: "glossary" | "characters"; keys: string[]; expectedRevision: string }, signal?: AbortSignal) {
  return withDraft(context, async (filePath, draft) => {
    requireMutable(draft);
    requireRevision(draft, input.expectedRevision);
    if (!["glossary", "characters"].includes(input.kind) || !Array.isArray(input.keys) || !input.keys.length) throw new Error("Provide draft collection and keys to delete.");
    const kind = input.kind;
    const keys = input.keys.map(value => identity({ [kind === "glossary" ? "source" : "name"]: value }, kind));
    const entries = draft[kind] ?? [];
    for (const key of keys) if (!entries.some(entry => identity(entry, kind) === key)) throw new Error(`Draft entry not found: ${key}`);
    draft[kind] = entries.filter(entry => !keys.includes(identity(entry, kind)));
    draft.generation++;
    delete draft.checked;
    await save(filePath, draft, signal);
    return describe(filePath, draft);
  });
}

export async function checkTaskAssetDraft(context: YnTaskPreparationContext, input: { expectedRevision: string; reviewSummary: string }, signal?: AbortSignal) {
  return withDraft(context, async (filePath, draft) => {
    requireMutable(draft);
    requireRevision(draft, input.expectedRevision);
    if (typeof input.reviewSummary !== "string" || !input.reviewSummary.trim()) throw new Error("Review the reference evidence and draft before checking; include a concise review summary.");
    signal?.throwIfAborted();
    const preview = await importProjectFormalAssets({ outputDir: context.outputDir, glossary: draft.glossary, characters: draft.characters }, { dryRun: true });
    draft.checked = { revision: revision(draft), formalRevision: preview.revision, reviewSummary: input.reviewSummary.trim() };
    await save(filePath, draft, signal);
    return { ...describe(filePath, draft), mergeCounts: preview.counts, reviewSummary: draft.checked.reviewSummary };
  });
}

export async function commitTaskAssets(context: YnTaskPreparationContext, input: { expectedRevision: string }, signal?: AbortSignal) {
  return withDraft(context, async (filePath, draft) => {
    requireRevision(draft, input.expectedRevision);
    if (draft.committed) return describe(filePath, draft);
    if (!draft.checked || draft.checked.revision !== revision(draft)) throw new Error("Check the current reference draft before committing formal assets.");
    signal?.throwIfAborted();
    const args = { outputDir: context.outputDir, glossary: draft.glossary, characters: draft.characters };
    const preview = await importProjectFormalAssets(args, { dryRun: true, expectedRevision: draft.checked.formalRevision });
    draft.committed = { revision: revision(draft), counts: preview.counts, paths: {
      ...(draft.glossary !== undefined ? { glossary: preview.assets.paths.glossary } : {}),
      ...(draft.characters?.length ? { characterBible: preview.assets.paths.characterBible } : {})
    } };
    // The receipt is committed and rolled back together with both assets and the project binding.
    await importProjectFormalAssets(args, { expectedRevision: draft.checked.formalRevision, signal,
      receipt: { targetPath: filePath, text: JSON.stringify(draft, null, 2) } });
    return describe(filePath, draft);
  });
}

export async function assertTaskAssetDraftCommitted(context: YnTaskPreparationContext) {
  return withDraft(context, async (_filePath, draft) => {
    if ((draft.glossary !== undefined || draft.characters !== undefined) && !draft.committed) throw new Error("Reference draft is not committed. Review, check and commitTaskAssets before starting the workflow.");
  });
}
