import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeCustomPreserveRules } from "../shared/validation/customPreserveRules.ts";
import { writeTextFileAtomically } from "./atomicFile.ts";

export type ProjectState = Record<string, unknown>;
export type ProjectStateSubscriber = (
  outputDir: string,
  state: ProjectState,
  patch: ProjectState
) => void;

const writeQueues = new Map<string, Promise<void>>();
const subscribers = new Set<ProjectStateSubscriber>();
const LEGACY_SPLIT_SETTINGS = ["reviewMode", "translationSplitSize", "proofreadSplitSize"] as const;

function positiveSplitSize(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${key}: expected a positive integer split size.`);
  }
  return value;
}

function legacyReviewModeSplitSize(value: unknown): number {
  if (typeof value !== "string") {
    throw new Error("Invalid reviewMode: expected the legacy form 'split <positive integer>'.");
  }
  const match = /^split\s+([1-9]\d*)$/i.exec(value.trim());
  if (!match) {
    throw new Error("Invalid reviewMode: expected the legacy form 'split <positive integer>'.");
  }
  return Number(match[1]);
}

function canonicalProjectState(value: ProjectState): ProjectState {
  const state = { ...value };
  for (const key of ["subagentCount", "reviewSubagentCount"] as const) {
    if (state[key] === null) delete state[key];
  }
  if (state.customPreserveRules !== undefined) {
    state.customPreserveRules = normalizeCustomPreserveRules(state.customPreserveRules);
  }
  if (state.splitSize !== undefined) {
    state.splitSize = positiveSplitSize(state.splitSize, "splitSize");
  } else {
    const legacyValues = new Map<number, string[]>();
    const addLegacyValue = (key: string, splitSize: number): void => {
      const keys = legacyValues.get(splitSize) ?? [];
      keys.push(key);
      legacyValues.set(splitSize, keys);
    };
    if (Object.hasOwn(state, "reviewMode")) {
      addLegacyValue("reviewMode", legacyReviewModeSplitSize(state.reviewMode));
    }
    if (Object.hasOwn(state, "translationSplitSize")) {
      addLegacyValue(
        "translationSplitSize",
        positiveSplitSize(state.translationSplitSize, "translationSplitSize")
      );
    }
    if (Object.hasOwn(state, "proofreadSplitSize")) {
      addLegacyValue(
        "proofreadSplitSize",
        positiveSplitSize(state.proofreadSplitSize, "proofreadSplitSize")
      );
    }
    if (legacyValues.size > 1) {
      const detail = [...legacyValues.entries()]
        .map(([splitSize, keys]) => `${keys.join("/")}=${splitSize}`)
        .join(", ");
      throw new Error(
        `Conflicting legacy split settings (${detail}). Set the canonical splitSize explicitly.`
      );
    }
    const migrated = legacyValues.keys().next().value as number | undefined;
    if (migrated !== undefined) state.splitSize = migrated;
  }
  for (const key of LEGACY_SPLIT_SETTINGS) delete state[key];
  return state;
}

function projectRoot(outputDir: string): string {
  const resolved = path.resolve(outputDir);
  return path.basename(resolved).toLowerCase() === ".translation-workshop"
    ? path.dirname(resolved)
    : resolved;
}

function workspaceDir(outputDir: string): string {
  return path.join(projectRoot(outputDir), ".translation-workshop");
}

function projectStatePath(outputDir: string): string {
  return path.join(workspaceDir(outputDir), "project.json");
}

function objectState(value: unknown, filePath: string): ProjectState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid project state at ${filePath}: expected an object root.`);
  }
  return value as ProjectState;
}

export async function readProjectState(outputDir: string): Promise<ProjectState> {
  const filePath = projectStatePath(outputDir);
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return canonicalProjectState(objectState(JSON.parse(source), filePath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid project state at ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function enqueueProjectWrite<T>(outputDir: string, work: () => Promise<T>): Promise<T> {
  const key = projectStatePath(outputDir).toLocaleLowerCase();
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let result!: T;
  const current = previous.catch(() => undefined).then(async () => {
    result = await work();
  });
  writeQueues.set(key, current);
  try {
    await current;
    return result;
  } finally {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  }
}

export async function patchProjectState(outputDir: string, patch: ProjectState): Promise<ProjectState> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Project state patch must be an object.");
  }
  const root = projectRoot(outputDir);
  return enqueueProjectWrite(root, async () => {
    const current = await readProjectState(root);
    const state = canonicalProjectState({
      ...current,
      ...patch,
      outputDir: root,
      updatedAt: new Date().toISOString()
    });
    await mkdir(workspaceDir(root), { recursive: true });
    await writeTextFileAtomically(projectStatePath(root), JSON.stringify(state, null, 2));
    for (const subscriber of subscribers) subscriber(root, state, canonicalProjectState(patch));
    return state;
  });
}

// Full-form saves merge deliberately: HTML owns a few project settings that the
// startup React form does not render, and either surface must preserve the other.
export function saveProjectState(outputDir: string, state: ProjectState): Promise<ProjectState> {
  return patchProjectState(outputDir, state);
}

export function subscribeProjectState(subscriber: ProjectStateSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}
