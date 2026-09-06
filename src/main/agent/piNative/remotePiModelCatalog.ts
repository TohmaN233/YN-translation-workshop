import type { Api, Model } from "@earendil-works/pi-ai";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { agentDataDir } from "../agentDataDir.ts";
import { writeTextFileAtomically } from "../../atomicFile.ts";

const CACHE_VERSION = 1;
const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

interface RemoteCatalogCache {
  version: typeof CACHE_VERSION;
  providerId: string;
  checkedAt: number;
  etag?: string;
  lastModified?: string;
  models: Model<Api>[];
}

export interface PiRemoteCatalogResult {
  models: Model<Api>[];
  refreshed: boolean;
  unsupportedModels?: Array<{ id: string; api: string }>;
  error?: Error;
}

interface LoadPiRemoteCatalogOptions {
  workspaceDir: string;
  providerId: string;
  supportedApis: ReadonlySet<string>;
  refresh: boolean;
  fetcher?: typeof fetch;
  catalogBaseUrl?: string;
  now?: () => number;
}

const refreshes = new Map<string, Promise<PiRemoteCatalogResult>>();

function cachePath(workspaceDir: string, providerId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/iu.test(providerId)) {
    throw new Error(`Invalid Pi provider id for model catalog cache: ${providerId}`);
  }
  return path.join(agentDataDir(workspaceDir), "pi-model-catalog", `${providerId}.json`);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseCost(value: unknown, label: string): Model<Api>["cost"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}.cost must be an object.`);
  }
  const cost = value as Record<string, unknown>;
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!isFiniteNonnegative(cost[field])) throw new Error(`${label}.cost.${field} must be a nonnegative number.`);
  }
  return value as Model<Api>["cost"];
}

function parseModel(value: unknown, providerId: string, supportedApis: ReadonlySet<string>, label: string): Model<Api> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const model = value as Record<string, unknown>;
  for (const field of ["id", "name", "api", "baseUrl"] as const) {
    if (typeof model[field] !== "string" || !model[field].trim()) {
      throw new Error(`${label}.${field} must be a nonempty string.`);
    }
  }
  if (!supportedApis.has(model.api as string)) {
    throw new Error(`${label}.api ${String(model.api)} is unsupported by the installed Pi provider runtime.`);
  }
  if (typeof model.reasoning !== "boolean") throw new Error(`${label}.reasoning must be boolean.`);
  if (
    !Array.isArray(model.input)
    || model.input.length === 0
    || model.input.some((item) => item !== "text" && item !== "image")
  ) {
    throw new Error(`${label}.input must contain only text/image capabilities.`);
  }
  if (!isFiniteNonnegative(model.contextWindow) || model.contextWindow === 0) {
    throw new Error(`${label}.contextWindow must be a positive number.`);
  }
  if (!isFiniteNonnegative(model.maxTokens) || model.maxTokens === 0) {
    throw new Error(`${label}.maxTokens must be a positive number.`);
  }
  parseCost(model.cost, label);
  return { ...model, provider: providerId } as Model<Api>;
}

function parseCatalog(value: unknown, providerId: string, supportedApis: ReadonlySet<string>): {
  models: Model<Api>[];
  unsupportedModels: Array<{ id: string; api: string }>;
} {
  const container = value && typeof value === "object" && !Array.isArray(value) && "models" in value
    ? (value as { models?: unknown }).models
    : value;
  const entries = Array.isArray(container)
    ? container
    : container && typeof container === "object"
      ? Object.values(container)
      : undefined;
  if (!entries) throw new Error(`Invalid Pi model catalog for ${providerId}: expected an array or keyed object.`);
  const models: Model<Api>[] = [];
  const unsupportedModels: Array<{ id: string; api: string }> = [];
  for (const [index, entry] of entries.entries()) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.id === "string"
        && candidate.id.trim()
        && typeof candidate.api === "string"
        && candidate.api.trim()
        && !supportedApis.has(candidate.api)
      ) {
        unsupportedModels.push({ id: candidate.id, api: candidate.api });
        continue;
      }
    }
    models.push(parseModel(entry, providerId, supportedApis, `models[${index}]`));
  }
  return { models, unsupportedModels };
}

async function readCache(
  filePath: string,
  providerId: string,
  supportedApis: ReadonlySet<string>
): Promise<RemoteCatalogCache | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error(`Failed to read Pi model catalog cache ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid Pi model catalog cache ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Pi model catalog cache ${filePath}: expected an object.`);
  }
  const cache = parsed as Partial<RemoteCatalogCache>;
  if (
    cache.version !== CACHE_VERSION
    || cache.providerId !== providerId
    || !isFiniteNonnegative(cache.checkedAt)
    || !Array.isArray(cache.models)
  ) {
    throw new Error(`Invalid Pi model catalog cache ${filePath}: unsupported metadata.`);
  }
  return {
    version: CACHE_VERSION,
    providerId,
    checkedAt: cache.checkedAt,
    etag: typeof cache.etag === "string" ? cache.etag : undefined,
    lastModified: typeof cache.lastModified === "string" ? cache.lastModified : undefined,
    models: cache.models.map((entry, index) => parseModel(entry, providerId, supportedApis, `cache.models[${index}]`))
  };
}

async function writeCache(filePath: string, cache: RemoteCatalogCache): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeTextFileAtomically(filePath, JSON.stringify(cache, null, 2));
}

async function refreshCatalog(
  filePath: string,
  cached: RemoteCatalogCache | undefined,
  options: LoadPiRemoteCatalogOptions
): Promise<PiRemoteCatalogResult> {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Pi model catalog request timed out.")), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(
      `/api/models/providers/${encodeURIComponent(options.providerId)}`,
      options.catalogBaseUrl ?? DEFAULT_CATALOG_BASE_URL
    );
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        "user-agent": "pi/0.80.6 YN-translation-workshop",
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
        ...(cached?.lastModified ? { "if-modified-since": cached.lastModified } : {})
      },
      signal: controller.signal
    });
    const checkedAt = now();
    if (response.status === 304 && cached) {
      const next = { ...cached, checkedAt };
      await writeCache(filePath, next);
      return { models: next.models, refreshed: true };
    }
    if (response.status === 404 || response.status === 501) {
      const next: RemoteCatalogCache = {
        version: CACHE_VERSION,
        providerId: options.providerId,
        checkedAt,
        models: cached?.models ?? []
      };
      await writeCache(filePath, next);
      return { models: next.models, refreshed: true };
    }
    if (!response.ok) throw new Error(`Pi model catalog request failed for ${options.providerId}: HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > MAX_CATALOG_BYTES) {
      throw new Error(`Pi model catalog for ${options.providerId} exceeds ${MAX_CATALOG_BYTES} bytes.`);
    }
    const parsed = parseCatalog(JSON.parse(text) as unknown, options.providerId, options.supportedApis);
    const next: RemoteCatalogCache = {
      version: CACHE_VERSION,
      providerId: options.providerId,
      checkedAt,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      models: parsed.models
    };
    await writeCache(filePath, next);
    return {
      models: parsed.models,
      refreshed: true,
      unsupportedModels: parsed.unsupportedModels.length > 0 ? parsed.unsupportedModels : undefined
    };
  } catch (error) {
    return {
      models: cached?.models ?? [],
      refreshed: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadPiRemoteModelCatalog(options: LoadPiRemoteCatalogOptions): Promise<PiRemoteCatalogResult> {
  const filePath = cachePath(options.workspaceDir, options.providerId);
  const cached = await readCache(filePath, options.providerId, options.supportedApis);
  const now = options.now ?? Date.now;
  if (!options.refresh || (cached && now() - cached.checkedAt < REFRESH_INTERVAL_MS)) {
    return { models: cached?.models ?? [], refreshed: false };
  }
  const existing = refreshes.get(filePath);
  if (existing) return existing;
  const pending = refreshCatalog(filePath, cached, options).finally(() => {
    if (refreshes.get(filePath) === pending) refreshes.delete(filePath);
  });
  refreshes.set(filePath, pending);
  return pending;
}
