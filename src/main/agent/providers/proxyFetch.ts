import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";

type ProxyDispatcher = unknown;
type ProxyAgentConstructor = new (proxyUrl: string) => ProxyDispatcher;

const cachedDispatchers = new Map<string, ProxyDispatcher>();
let proxyAgentConstructor: ProxyAgentConstructor | undefined;
const proxyScope = new AsyncLocalStorage<ProxyDispatcher>();
const fetchDiagnosticScope = new AsyncLocalStorage<(error: unknown) => Promise<void>>();
const baseFetch = globalThis.fetch.bind(globalThis);
let proxyAwareFetchInstalled = false;

export interface ProviderProxyOptions {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}

export async function resolveProviderProxyUrl(options: ProviderProxyOptions = {}): Promise<string> {
  const projectUrl = await readProjectProxyUrl(options.workspaceDir);
  if (projectUrl !== undefined) {
    return projectUrl;
  }
  return "";
}

async function readProjectProxyUrl(workspaceDir?: string): Promise<string | undefined> {
  if (!workspaceDir) {
    return undefined;
  }
  const resolved = path.resolve(workspaceDir);
  const candidates = path.basename(resolved).toLowerCase() === ".translation-workshop"
    ? [path.join(resolved, "project.json")]
    : [
      path.join(resolved, ".translation-workshop", "project.json"),
      path.join(resolved, "project.json")
    ];
  for (const filePath of candidates) {
    try {
      const project = JSON.parse(await readFile(filePath, "utf8")) as {
        agentProxyEnabled?: unknown;
        agentProxyUrl?: unknown;
      };
      if (project.agentProxyEnabled === false) {
        return "";
      }
      if (project.agentProxyEnabled === true) {
        return typeof project.agentProxyUrl === "string" ? project.agentProxyUrl.trim() : "";
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Failed to read project proxy settings ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

function loadProxyAgent(): ProxyAgentConstructor {
  if (proxyAgentConstructor) {
    return proxyAgentConstructor;
  }
  const require = createRequire(import.meta.url);
  const undici = require("undici") as { ProxyAgent: ProxyAgentConstructor };
  proxyAgentConstructor = undici.ProxyAgent;
  return proxyAgentConstructor;
}

function proxyDispatcher(proxyUrl: string): ProxyDispatcher {
  const cached = cachedDispatchers.get(proxyUrl);
  if (cached) return cached;
  const dispatcher = new (loadProxyAgent())(proxyUrl);
  cachedDispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

function installProxyAwareFetch(): void {
  if (proxyAwareFetchInstalled) return;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const dispatcher = proxyScope.getStore();
    try {
      return await baseFetch(input, dispatcher ? {
        ...init,
        dispatcher
      } as RequestInit & { dispatcher: ProxyDispatcher } : init);
    } catch (error) {
      await fetchDiagnosticScope.getStore()?.(error);
      throw error;
    }
  }) as typeof fetch;
  proxyAwareFetchInstalled = true;
}

export function runWithProviderProxy<T>(proxyUrl: string, action: () => T): T {
  if (!proxyUrl) return action();
  installProxyAwareFetch();
  return proxyScope.run(proxyDispatcher(proxyUrl), action);
}

export function runWithProviderFetchDiagnostics<T>(
  onError: (error: unknown) => Promise<void>,
  action: () => T
): T {
  installProxyAwareFetch();
  return fetchDiagnosticScope.run(onError, action);
}

export async function fetchWithProxy(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  options: ProviderProxyOptions = {}
): Promise<Response> {
  const proxyUrl = await resolveProviderProxyUrl(options);
  if (!proxyUrl) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init,
    dispatcher: proxyDispatcher(proxyUrl)
  } as RequestInit & { dispatcher: ProxyDispatcher });
}
